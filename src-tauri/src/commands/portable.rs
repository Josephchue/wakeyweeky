//! round66（C12）：便携模式的两条命令 —— 面板读两侧信息 / 应用选择（跨位置切换 + 重启）。
//!
//! 核心逻辑（解析、摘要、复制）全在 `crate::portable`（纯函数、可单测）；这里只做 Tauri 的壳：
//! 取 `DataPaths`、拿库锁、失败说人话、重启。设计见 `docs/plans/round66-c12-portable-and-hotkeys.md`。
//!
//! 复制方向永远只有一条：**正在用的 → 重启后会读的那一侧**。被覆盖的一侧先留
//! `wakeyweeky.sqlite.before-switch`（不删）；正在使用的那份库文件永远不被改写。

use std::path::PathBuf;

use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};

use crate::portable::{self, DataPaths};
use crate::AppState;
use crate::i18n;
use crate::tf;

/// 一侧的展示信息（切换面板的一张卡）
#[derive(Debug, serde::Serialize)]
pub struct SideInfo {
    /// 「默认位置」/「便携（exe\data\）」
    pub label: String,
    pub dir: String,
    /// 库文件完整路径
    pub db: String,
    /// 当前正在用的那一侧
    pub current: bool,
    #[serde(flatten)]
    pub stats: portable::DbStats,
}

/// 面板要的全部信息
#[derive(Debug, serde::Serialize)]
pub struct DataInfo {
    pub portable: bool,
    pub fallback: bool,
    /// 回落原因（有就显示）
    pub note: Option<String>,
    /// `portable.flag` 路径（排错用）
    pub flag: String,
    /// 本次启动是否把默认位置的数据自动带了过来（P3；前端启动时提示一次）
    pub adopted: bool,
    pub current: SideInfo,
    pub other: SideInfo,
}

fn side(label: &str, dir: PathBuf, current: bool) -> SideInfo {
    let db = portable::db_path(&dir);
    SideInfo {
        label: label.to_string(),
        dir: dir.display().to_string(),
        db: db.display().to_string(),
        current,
        stats: portable::stats(&db),
    }
}

pub(crate) fn data_info_impl(paths: &DataPaths) -> DataInfo {
    let (cur_label, other_label) = if paths.portable {
        (i18n::t(i18n::msg::ERR_CMD_PORTABLE_01), i18n::t(i18n::msg::ERR_CMD_PORTABLE_02))
    } else {
        (i18n::t(i18n::msg::ERR_CMD_PORTABLE_03), i18n::t(i18n::msg::ERR_CMD_PORTABLE_04))
    };
    DataInfo {
        portable: paths.portable,
        fallback: paths.fallback,
        note: paths.note.clone(),
        flag: paths.flag.display().to_string(),
        adopted: paths.adopted,
        current: side(cur_label, paths.dir.clone(), true),
        other: side(other_label, paths.other_dir(), false),
    }
}

/// 应用选择（面板上「使用这份」）。`pick`：`"current"` = 正在用的这份 / `"other"` = 另一边。
///
/// 只有当选中的那份**不是**重启后会读的那一侧时才需要复制；另一边有库时它自己就是
/// 落选方的完整备份（原地保留，不删也不动）。
pub(crate) fn apply_choice_impl(
    conn: &Connection,
    paths: &DataPaths,
    pick: &str,
) -> Result<(), String> {
    if paths.fallback {
        return Err(i18n::t(i18n::msg::ERR_CMD_PORTABLE_05).to_string());
    }
    // 开启便携时先探一下 exe 目录能不能写：装 `Program Files` 的版本会在这一步得到人话报错，
    // 而不是复制到一半失败
    if !paths.portable && !portable::flag_writable(&paths.flag) {
        return Err(
            i18n::t(i18n::msg::ERR_CMD_PORTABLE_06)
                .to_string(),
        );
    }
    if pick != "current" && pick != "other" {
        return Err(i18n::t(i18n::msg::ERR_CMD_PORTABLE_07).to_string());
    }
    let other_db = paths.other_db();

    // **开便携：先写开关、后复制**（关便携：先复制、后删开关）—— 顺序是安全的一部分：
    // 复制失败就把开关拨回去，不会留下「开关开着但数据还没到」那种下次启动才发作的半成品。
    if !paths.portable {
        portable::set_flag(&paths.flag, true)?;
    }
    let done = match pick {
        "current" => {
            // 重启后会读另一边 → 让另一边拿到「正在用的这份」
            portable::replace_target_with_live(conn, &other_db)
        }
        _ => {
            let stats = portable::stats(&other_db);
            if !stats.exists {
                Err(i18n::t(i18n::msg::ERR_CMD_PORTABLE_08).to_string())
            } else if !stats.usable {
                Err(tf!(i18n::msg::ERR_CMD_PORTABLE_10, p1 = stats.reason.unwrap_or_else(|| i18n::t(i18n::msg::ERR_CMD_PORTABLE_11).to_string())))
            } else {
                // 重启后读的就是另一边，它已经拿着选中的数据 → 不用复制
                Ok(())
            }
        }
    };
    match done {
        Ok(()) => {
            if paths.portable {
                portable::set_flag(&paths.flag, false)?;
            }
            Ok(())
        }
        Err(e) => {
            if !paths.portable {
                if let Err(back) = portable::set_flag(&paths.flag, false) {
                    return Err(tf!(i18n::msg::ERR_CMD_PORTABLE_09, e = e, back = back));
                }
            }
            Err(e)
        }
    }
}

#[tauri::command]
pub fn get_data_info(app: AppHandle) -> DataInfo {
    data_info_impl(&app.state::<DataPaths>())
}

/// round68（19.1）：暗章「说走就走」要落在**重启后真正使用的那份库**里 ——
/// `apply_choice_impl` 之后正在用的这份马上会被抛弃（重启读另一边），
/// 所以往**目标库**单独开一次连接补写（`db::init` 顺手把迁移跑上；失败只记日志，绝不拦切换）。
fn note_portable_on_target(target: &std::path::Path) {
    match crate::db::init(target) {
        Ok(target_conn) => {
            if let Err(e) = crate::achievements::note(&target_conn, "portable") {
                eprintln!("[achievements] 信号 portable 失败（忽略）：{e}");
            }
        }
        Err(e) => eprintln!("[achievements] 目标库打不开，信号 portable 跳过（忽略）：{e}"),
    }
}

/// 切换数据位置：成功后应用会**自动重启**，这个 Promise 可能永远不会 resolve。
#[tauri::command]
pub fn apply_data_choice(
    app: AppHandle,
    state: State<'_, AppState>,
    pick: String,
) -> Result<(), String> {
    {
        // 只有「用当前这份」需要读正在使用的库；锁也只在这一小段里
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let paths = app.state::<DataPaths>();
        apply_choice_impl(&conn, &paths, &pick)?;
        // round68（19.1）：暗章信号（切换过一次数据位置）—— 往**目标库**写（重启后用的就是它）
        note_portable_on_target(&paths.other_db());
    }
    eprintln!("[portable] 数据位置已切换，重启后生效");
    app.restart(); // -> ! 不会返回（与「从备份恢复」同款）
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn make_db(path: &std::path::Path, title: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let conn = crate::db::init(path).expect("建库失败");
        conn.execute(
            "INSERT INTO tasks (id,title,category,created_at) VALUES (?1,?1,NULL,1)",
            rusqlite::params![title],
        )
        .expect("插任务失败");
    }

    fn titles(path: &std::path::Path) -> Vec<String> {
        let conn = Connection::open(path).expect("打开失败");
        let mut stmt = conn.prepare("SELECT title FROM tasks ORDER BY id").expect("查询失败");
        stmt.query_map([], |r| r.get::<_, String>(0))
            .expect("查询失败")
            .map(|r| r.expect("读行失败"))
            .collect()
    }

    /// 造一组位置（`portable=false` 时 dir=默认位置；`true` 时 dir=exe\data\）
    fn paths_for(tmp: &TempDir, portable: bool) -> DataPaths {
        let exe = tmp.join("exe");
        std::fs::create_dir_all(&exe).unwrap();
        let default_dir = tmp.join("appdata");
        let dir = if portable {
            exe.join(portable::DATA_DIR)
        } else {
            default_dir.clone()
        };
        std::fs::create_dir_all(&dir).unwrap();
        DataPaths {
            dir,
            default_dir,
            exe_dir: Some(exe.clone()),
            portable,
            fallback: false,
            note: None,
            flag: exe.join(portable::FLAG_FILE),
            adopted: false,
        }
    }

    /// 面板信息：两侧都能摆出来（包含「另一边还没数据」的情形）
    #[test]
    fn test_data_info_lists_both_sides() {
        let tmp = TempDir::new("wakeyweeky-portable-cmd");
        let paths = paths_for(&tmp, false);
        make_db(&paths.current_db(), "现在这份");
        let info = data_info_impl(&paths);
        assert!(!info.portable && !info.fallback);
        assert!(info.current.current && info.current.stats.usable);
        assert_eq!(info.current.stats.tasks, Some(1));
        assert!(!info.other.current && !info.other.stats.exists);
        assert!(!info.other.stats.usable);
    }

    /// 开启便携 + 选「当前这份」：另一边被换成当前数据；旧的那份留 before-switch；flag 写出来
    #[test]
    fn test_apply_choice_current_copies_and_writes_flag() {
        let tmp = TempDir::new("wakeyweeky-portable-cmd");
        let paths = paths_for(&tmp, false);
        let live = crate::db::init(&paths.current_db()).expect("建 live 失败");
        live.execute(
            "INSERT INTO tasks (id,title,category,created_at) VALUES ('live','正在用的',NULL,1)",
            [],
        )
        .unwrap();
        make_db(&paths.other_db(), "便携旧数据");

        apply_choice_impl(&live, &paths, "current").expect("切换失败");

        assert_eq!(titles(&paths.other_db()), vec!["正在用的"]);
        let before = paths.other_db().with_file_name(portable::BEFORE_SWITCH_FILE);
        assert_eq!(titles(&before), vec!["便携旧数据"], "落选的那份要留副本");
        assert!(paths.flag.is_file(), "开启便携应当写出 flag");
    }

    /// round68（19.1）+ 6b 复核（P1-3）：暗章「说走就走」要落在**目标库**（重启后用的那份），
    /// 不是马上被抛弃的当前库 —— 旧写法在 `apply_choice_impl` 之后往 `conn` 写，结果写在了废库上。
    /// （round85：唯一版本一定带成就 —— 以前这条测试挂 `cfg(not(feature = "lite"))`，已取消）
    #[test]
    fn test_portable_signal_lands_in_target_db() {
        let tmp = TempDir::new("wakeyweeky-portable-cmd");
        let paths = paths_for(&tmp, false);
        let live = crate::db::init(&paths.current_db()).expect("建 live 失败");

        apply_choice_impl(&live, &paths, "current").expect("切换失败");
        note_portable_on_target(&paths.other_db());

        let target = crate::db::init(&paths.other_db()).expect("打开目标库失败");
        let n: i64 = target
            .query_row(
                "SELECT COUNT(*) FROM achievements WHERE id = 'portable_first'",
                [],
                |r| r.get(0),
            )
            .expect("查成就失败");
        assert_eq!(n, 1, "说走就要落在重启后真正使用的那份库");
    }

    /// 开启便携 + 选「另一边」：两边的数据都不动，只写 flag
    #[test]
    fn test_apply_choice_other_keeps_both_untouched() {
        let tmp = TempDir::new("wakeyweeky-portable-cmd");
        let paths = paths_for(&tmp, false);
        let live = crate::db::init(&paths.current_db()).expect("建 live 失败");
        live.execute(
            "INSERT INTO tasks (id,title,category,created_at) VALUES ('live','正在用的',NULL,1)",
            [],
        )
        .unwrap();
        make_db(&paths.other_db(), "便携那份");

        apply_choice_impl(&live, &paths, "other").expect("切换失败");

        assert_eq!(titles(&paths.other_db()), vec!["便携那份"], "选中的那份原样");
        assert_eq!(titles(&paths.current_db()), vec!["正在用的"], "另一边不动");
        assert!(
            !paths.other_db().with_file_name(portable::BEFORE_SWITCH_FILE).exists(),
            "没有覆盖就没有副本"
        );
        assert!(paths.flag.is_file());
    }

    /// 关闭便携 + 选「当前这份」（便携）：默认位置被换成便携数据；flag 删掉
    #[test]
    fn test_apply_choice_disable_pick_current() {
        let tmp = TempDir::new("wakeyweeky-portable-cmd");
        let paths = paths_for(&tmp, true);
        let live = crate::db::init(&paths.current_db()).expect("建 live 失败");
        live.execute(
            "INSERT INTO tasks (id,title,category,created_at) VALUES ('p','便携新数据',NULL,1)",
            [],
        )
        .unwrap();
        make_db(&paths.default_dir.join(crate::backup::DB_FILE_NAME), "默认旧数据");
        std::fs::write(&paths.flag, b"").unwrap();

        apply_choice_impl(&live, &paths, "current").expect("切换失败");

        assert_eq!(titles(&paths.current_db()), vec!["便携新数据"]);
        let before = paths.default_dir.join(portable::BEFORE_SWITCH_FILE);
        assert_eq!(titles(&before), vec!["默认旧数据"]);
        assert!(!paths.flag.exists(), "关闭便携应当删掉 flag");
    }

    /// 另一边不存在 / 不能用 / 选择非法 → 报错且**什么都不改**（flag 也不许动）
    #[test]
    fn test_apply_choice_rejects_bad_other() {
        let tmp = TempDir::new("wakeyweeky-portable-cmd");
        let paths = paths_for(&tmp, false);
        let live = crate::db::init(&paths.current_db()).expect("建 live 失败");

        let err = apply_choice_impl(&live, &paths, "other").unwrap_err();
        assert!(err.contains("还没有数据"), "{err}");

        std::fs::create_dir_all(paths.other_dir()).unwrap();
        std::fs::write(paths.other_db(), b"not sqlite").unwrap();
        let err = apply_choice_impl(&live, &paths, "other").unwrap_err();
        assert!(err.contains("打不开"), "{err}");

        let err = apply_choice_impl(&live, &paths, "nonsense").unwrap_err();
        assert!(err.contains("不认识"), "{err}");
        assert!(!paths.flag.exists(), "失败的尝试不许写出 flag");
    }

    /// 开便携时复制失败 → 开关要拨回（不留下「开关开着但数据没到位」的半成品）
    #[test]
    fn test_enable_rolls_back_flag_when_copy_fails() {
        let tmp = TempDir::new("wakeyweeky-portable-cmd");
        let paths = paths_for(&tmp, false);
        let live = crate::db::init(&paths.current_db()).expect("建 live 失败");
        live.execute(
            "INSERT INTO tasks (id,title,category,created_at) VALUES ('t','不动',NULL,1)",
            [],
        )
        .unwrap();
        // 把另一边的目录位置占成文件 → `create_dir_all` 必失败（复制走不下去）
        std::fs::write(paths.other_dir(), b"not a dir").unwrap();

        let err = apply_choice_impl(&live, &paths, "current").unwrap_err();
        assert!(err.contains("建目录失败") || err.contains("目标位置不可写"), "{err}");
        assert!(!paths.flag.exists(), "复制失败要把开关拨回去");
        assert_eq!(titles(&paths.current_db()), vec!["不动"], "正在用的库不动");
    }

    /// 回落态（便携目录写不进去）→ 面板与切换都被挡住
    #[test]
    fn test_fallback_blocks_choice() {
        let tmp = TempDir::new("wakeyweeky-portable-cmd");
        let mut paths = paths_for(&tmp, false);
        paths.fallback = true;
        paths.note = Some("便携目录写不进去".into());
        let live = crate::db::init(&paths.current_db()).expect("建 live 失败");
        let err = apply_choice_impl(&live, &paths, "current").unwrap_err();
        assert!(err.contains("不可用"), "{err}");
        assert!(!paths.flag.exists());
    }

    /// exe 目录不可写（装 Program Files）→ 开便携时给人话报错，且**什么都没改**
    #[test]
    fn test_enable_requires_writable_exe_dir() {
        let tmp = TempDir::new("wakeyweeky-portable-cmd");
        // exe 路径做成一个文件 → 它下面写不了 flag
        let bogus_exe = tmp.join("exe-is-a-file");
        std::fs::write(&bogus_exe, b"x").unwrap();
        let default_dir = tmp.join("appdata");
        std::fs::create_dir_all(&default_dir).unwrap();
        let mut paths = paths_for(&tmp, false);
        paths.exe_dir = Some(bogus_exe.clone());
        paths.flag = bogus_exe.join(portable::FLAG_FILE);
        paths.dir = default_dir.clone();
        let live = crate::db::init(&paths.current_db()).expect("建 live 失败");
        live.execute(
            "INSERT INTO tasks (id,title,category,created_at) VALUES ('t','不动',NULL,1)",
            [],
        )
        .unwrap();

        let err = apply_choice_impl(&live, &paths, "current").unwrap_err();
        assert!(err.contains("不能开便携"), "{err}");
        assert!(!paths.flag.exists(), "失败的尝试不许写出 flag");
        assert_eq!(titles(&paths.current_db()), vec!["不动"], "数据不许被动过");
        assert!(!paths.other_dir().exists(), "数据目录也不该被建出来");
    }
}
