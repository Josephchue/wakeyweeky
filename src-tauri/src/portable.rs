//! round66（C12）：便携模式的**唯一实现** —— `portable.flag` 探测、数据目录解析（可写回落）、
//! 两侧数据摘要、跨位置搬迁。
//!
//! 设计（七段 + 边界表 P1–P11）：`docs/plans/round66-c12-portable-and-hotkeys.md`。
//! 分工：本模块**不碰 Tauri**（纯函数可单测）；命令层 `commands/portable.rs` 只管
//! 「读面板 / 应用选择 / 重启」。
//!
//! 两条硬规矩（数据安全）：
//! - **只复制、从不删**：被覆盖的那一侧先把原库改名成 `wakeyweeky.sqlite.before-switch`；
//! - **不碰正在使用的那份库文件**：复制方向永远是「正在用的 → 重启后会读的那一侧」，
//!   这样目标侧没有进程持有句柄（Windows 下改一个正被 SQLite 打开的库文件不安全）。

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{Connection, OpenFlags};

use crate::backup;
use crate::i18n;
use crate::tf;

/// exe 同级的开关文件：**在**就是便携模式（绿色软件惯例；v2 ⑧D1）
pub const FLAG_FILE: &str = "portable.flag";
/// 便携模式的数据目录名（exe 同级）
pub const DATA_DIR: &str = "data";
/// 切换时被覆盖的那一侧，先把原库改名成这个（**不删**；照 round62「恢复前副本」的思路）
pub const BEFORE_SWITCH_FILE: &str = "wakeyweeky.sqlite.before-switch";
/// 探测目录可写性的临时文件名（写完就删）—— 便携目录要能落 `-wal`，光存在不算数
const WRITE_PROBE: &str = ".write-probe";

/// 启动时的解析结果（存进 [`DataPaths`] 给命令层用）
#[derive(Debug, Clone)]
pub struct Resolved {
    /// 正在使用的那份数据目录
    pub dir: PathBuf,
    /// 便携模式（正在从 `exe\data\` 读）
    pub portable: bool,
    /// flag 在、但便携目录建不出来 / 写不进去 → 回落默认位置（P4）
    pub fallback: bool,
    /// 回落的原因（设置行与说明页要显示）
    pub note: Option<String>,
    /// `portable.flag` 的完整路径（便携关闭时要删的那个文件）
    pub flag: PathBuf,
}

/// 运行中的两组位置（`lib.rs` 启动时算好、`app.manage`；命令层读）
#[derive(Debug, Clone)]
pub struct DataPaths {
    /// 正在使用的那一份
    pub dir: PathBuf,
    /// 默认位置（`%APPDATA%\com.wakeyweeky.app`）
    pub default_dir: PathBuf,
    /// exe 所在目录（`None` = 拿不到 exe 路径，此时不认 flag）
    pub exe_dir: Option<PathBuf>,
    pub portable: bool,
    pub fallback: bool,
    /// 回落原因
    pub note: Option<String>,
    /// `portable.flag` 路径
    pub flag: PathBuf,
    /// 本次启动是否把默认位置的数据自动带了过来（P3）—— 前端启动时提示一次
    pub adopted: bool,
}

impl DataPaths {
    /// 另一侧（切换面板的「另一边」）：便携时是默认位置，否则是 `exe\data\`
    pub fn other_dir(&self) -> PathBuf {
        if self.portable {
            self.default_dir.clone()
        } else {
            match &self.exe_dir {
                Some(exe) => exe.join(DATA_DIR),
                None => self.default_dir.join(DATA_DIR),
            }
        }
    }

    /// 另一侧的库文件
    pub fn other_db(&self) -> PathBuf {
        db_path(&self.other_dir())
    }

    /// 正在使用的那份的库文件
    pub fn current_db(&self) -> PathBuf {
        db_path(&self.dir)
    }
}

/// 由 `exe` 目录 + 默认位置解析出这次要用的位置（P1–P4）。
///
/// `exe_dir == None`（拿不到自身路径）时不认 flag，直接用默认位置 —— 便携是
/// 「顺手能做才做」的增强，不能因为它拿不到 exe 路径就起不来。
pub fn resolve(exe_dir: Option<&Path>, default_dir: &Path) -> Resolved {
    let Some(exe) = exe_dir else {
        return Resolved {
            dir: default_dir.to_path_buf(),
            portable: false,
            fallback: false,
            note: None,
            flag: PathBuf::new(),
        };
    };
    let flag = exe.join(FLAG_FILE);
    if !flag.is_file() {
        return Resolved {
            dir: default_dir.to_path_buf(),
            portable: false,
            fallback: false,
            note: None,
            flag,
        };
    }
    let dir = exe.join(DATA_DIR);
    match std::fs::create_dir_all(&dir) {
        Ok(()) if dir_writable(&dir) => Resolved {
            dir,
            portable: true,
            fallback: false,
            note: None,
            flag,
        },
        Ok(()) => Resolved {
            dir: default_dir.to_path_buf(),
            portable: false,
            fallback: true,
            note: Some(i18n::t(i18n::msg::ERR_PORTABLE_01).to_string()),
            flag,
        },
        Err(e) => Resolved {
            dir: default_dir.to_path_buf(),
            portable: false,
            fallback: true,
            note: Some(tf!(i18n::msg::ERR_PORTABLE_02, e = e)),
            flag,
        },
    }
}

/// 拿 exe 所在目录（`current_exe` 的父目录）
pub fn exe_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.parent().map(Path::to_path_buf)
}

/// 某个数据目录里的主库文件
pub fn db_path(dir: &Path) -> PathBuf {
    dir.join(backup::DB_FILE_NAME)
}

/// 目录能不能真的写（不只是存在）—— 便携目录要能落 `-wal`/`-shm`
fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(WRITE_PROBE);
    if std::fs::write(&probe, b"").is_err() {
        return false;
    }
    let _ = std::fs::remove_file(&probe);
    true
}

/// 开 / 关便携：写一个空的 `portable.flag` / 删掉它（不在 → 也算成功）
pub fn set_flag(flag: &Path, on: bool) -> Result<(), String> {
    if on {
        std::fs::write(flag, b"").map_err(|e| {
            tf!(i18n::msg::ERR_PORTABLE_03, e = e)
        })
    } else {
        match std::fs::remove_file(flag) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(tf!(i18n::msg::ERR_PORTABLE_04, e = e)),
        }
    }
}

/// exe 所在目录能不能写 flag（= 能不能开便携）—— 装 `Program Files` 这种只读位置时会失败
pub fn flag_writable(flag: &Path) -> bool {
    match std::fs::write(flag, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(flag);
            true
        }
        Err(_) => false,
    }
}

/// 一份库的摘要（切换面板要摆的东西：哪份新、哪份大、有没有内容、能不能用）
#[derive(Debug, Clone, serde::Serialize)]
pub struct DbStats {
    pub exists: bool,
    /// 最后修改（Unix 秒；拿不到就是 None）
    pub modified: Option<i64>,
    pub bytes: Option<u64>,
    /// 任务数 / 块数（读得到才有，给「哪份有东西」一个直观依据）
    pub tasks: Option<i64>,
    pub blocks: Option<i64>,
    /// 能不能拿来当数据用（`backup::validate_backup`：完整性 + 表齐 + 迁移版本不超前）
    pub usable: bool,
    /// 不能用的原因（给面板显示）
    pub reason: Option<String>,
}

/// 读一份库的摘要 —— **只读、不改任何东西**
pub fn stats(path: &Path) -> DbStats {
    let meta = std::fs::metadata(path).ok();
    let mut out = DbStats {
        exists: meta.is_some(),
        modified: meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64),
        bytes: meta.as_ref().map(|m| m.len()),
        tasks: None,
        blocks: None,
        usable: false,
        reason: None,
    };
    if !out.exists {
        return out;
    }
    if let Err(e) = backup::validate_backup(path) {
        out.reason = Some(e);
        return out;
    }
    out.usable = true;
    if let Ok(conn) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        out.tasks = conn.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).ok();
        out.blocks = conn.query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0)).ok();
    }
    out
}

/// P3：手放 `portable.flag` 而便携目录还没有库 → 把默认位置的库**复制**一份过去
/// （原库不动；你 2026-10-05 拍板）。返回是否真的复制了。
///
/// 失败**不拦启动**：调用方会把位置回落到默认位置并记一条 note。
pub fn adopt_from(source_db: &Path, target_db: &Path) -> Result<bool, String> {
    if target_db.is_file() || !source_db.is_file() {
        return Ok(false);
    }
    let conn = Connection::open(source_db).map_err(|e| tf!(i18n::msg::ERR_PORTABLE_05, e = e))?;
    backup::vacuum_into(&conn, target_db)?;
    Ok(true)
}

/// P3（调用点）：便携目录还没有库 → 把默认位置的数据带过来（原库不动）。
/// **必须在 `backup::apply_pending_restore` 之后调**：待恢复的备份是用户显式动作，优先于「自动带数据」。
pub fn adopt_if_needed(paths: &mut DataPaths) -> Result<(), String> {
    if !paths.portable || paths.current_db().is_file() {
        return Ok(());
    }
    let source = db_path(&paths.default_dir);
    let adopted = adopt_from(&source, &paths.current_db())?;
    paths.adopted = adopted;
    Ok(())
}

/// P3 失败的收尾（抽出来可单测）：回落到默认位置 —— `lib.rs` 里 adopt 失败时用。
/// 「宁可这次不用便携，也不能对着一个空库启动」。
pub fn fall_back_after_adopt_failure(paths: &mut DataPaths, err: &str) {
    paths.dir = paths.default_dir.clone();
    paths.portable = false;
    paths.fallback = true;
    paths.note = Some(tf!(i18n::msg::ERR_PORTABLE_06, err = err));
    paths.adopted = false;
}

/// P5/P6：把**正在用的这份**复制到目标位置（面板上「使用当前这份」）。
///
/// 目标已有的库先改名成 `wakeyweeky.sqlite.before-switch`（不删）；复制失败就把原库放回去；
/// 复制成功后清掉目标侧的 `-wal`/`-shm`（旧 sidecar 跟新库对不上）。
pub fn replace_target_with_live(conn: &Connection, target_db: &Path) -> Result<(), String> {
    if let Some(parent) = target_db.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| tf!(i18n::msg::ERR_PORTABLE_07, p1 = parent.display(), e = e))?;
    }
    let backup_path = target_db.with_file_name(BEFORE_SWITCH_FILE);
    let had_target = target_db.is_file();
    if had_target {
        if backup_path.is_file() {
            let _ = std::fs::remove_file(&backup_path);
        }
        std::fs::rename(target_db, &backup_path).map_err(|e| {
            tf!(i18n::msg::ERR_PORTABLE_08, p1 = target_db.display(), e = e)
        })?;
    }
    if let Err(e) = backup::vacuum_into(conn, target_db) {
        if had_target {
            // 原库放回去：宁可这次失败，也不能让另一边空着
            if let Err(back) = std::fs::rename(&backup_path, target_db) {
                return Err(tf!(i18n::msg::ERR_PORTABLE_09, e = e, p1 = backup_path.display(), back = back));
            }
        }
        return Err(e);
    }
    clean_sidecars(target_db);
    Ok(())
}

/// 清掉库旁的 `-wal`/`-shm`（只在**已经换过库**之后调用）
fn clean_sidecars(db: &Path) {
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", db.display()));
        if sidecar.is_file() {
            if let Err(e) = std::fs::remove_file(&sidecar) {
                eprintln!("[portable] 删除 {} 失败（继续）：{e}", sidecar.display());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    /// 建一个真库并插一条任务（`titles` 用它区分两份数据）
    fn make_db(path: &Path, title: &str) {
        let conn = crate::db::init(path).expect("建库失败");
        conn.execute(
            "INSERT INTO tasks (id,title,category,created_at) VALUES (?1,?1,NULL,1)",
            rusqlite::params![title],
        )
        .expect("插任务失败");
    }

    /// 读出库里所有任务的标题（按 id 排序）
    fn titles(path: &Path) -> Vec<String> {
        let conn = Connection::open(path).expect("打开失败");
        let mut stmt = conn.prepare("SELECT title FROM tasks ORDER BY id").expect("查询失败");
        stmt.query_map([], |r| r.get::<_, String>(0))
            .expect("查询失败")
            .map(|r| r.expect("读行失败"))
            .collect()
    }

    #[test]
    fn test_resolve_without_flag_uses_default() {
        let tmp = TempDir::new("wakeyweeky-portable");
        let exe = tmp.join("exe");
        std::fs::create_dir_all(&exe).unwrap();
        let def = tmp.join("appdata");
        let r = resolve(Some(&exe), &def);
        assert!(!r.portable && !r.fallback, "没有 flag 就是默认位置");
        assert_eq!(r.dir, def);
        assert_eq!(r.flag, exe.join(FLAG_FILE));
    }

    #[test]
    fn test_resolve_no_exe_dir_uses_default() {
        let tmp = TempDir::new("wakeyweeky-portable");
        let def = tmp.join("appdata");
        let r = resolve(None, &def);
        assert!(!r.portable && !r.fallback && r.note.is_none());
        assert_eq!(r.dir, def);
    }

    #[test]
    fn test_resolve_with_flag_and_writable_dir_is_portable() {
        let tmp = TempDir::new("wakeyweeky-portable");
        let exe = tmp.join("exe");
        std::fs::create_dir_all(&exe).unwrap();
        std::fs::write(exe.join(FLAG_FILE), b"").unwrap();
        let r = resolve(Some(&exe), &tmp.join("appdata"));
        assert!(r.portable, "flag 在且目录可写 → 便携");
        assert_eq!(r.dir, exe.join(DATA_DIR));
        assert!(r.dir.is_dir(), "便携目录会被建出来");
        assert!(r.note.is_none());
    }

    /// P4（一）：`data` 的位置被一个**文件**占着 → `create_dir_all` 失败 → 回落
    #[test]
    fn test_resolve_data_path_blocked_falls_back() {
        let tmp = TempDir::new("wakeyweeky-portable");
        let exe = tmp.join("exe");
        std::fs::create_dir_all(&exe).unwrap();
        std::fs::write(exe.join(FLAG_FILE), b"").unwrap();
        std::fs::write(exe.join(DATA_DIR), b"not a dir").unwrap();
        let def = tmp.join("appdata");
        let r = resolve(Some(&exe), &def);
        assert!(!r.portable && r.fallback, "便携目录建不出来 → 回落");
        assert_eq!(r.dir, def);
        assert!(r.note.is_some(), "回落要留下原因");
    }

    /// P4（二）：目录在、但写不进去（探测文件位置被目录占着）→ 同样回落
    #[test]
    fn test_resolve_unwritable_dir_falls_back() {
        let tmp = TempDir::new("wakeyweeky-portable");
        let exe = tmp.join("exe");
        let data = exe.join(DATA_DIR);
        std::fs::create_dir_all(data.join(WRITE_PROBE)).unwrap(); // .write-probe 是个目录 → 写文件必失败
        std::fs::write(exe.join(FLAG_FILE), b"").unwrap();
        let def = tmp.join("appdata");
        let r = resolve(Some(&exe), &def);
        assert!(!r.portable && r.fallback, "写不进去 → 回落");
        assert_eq!(r.dir, def);
    }

    #[test]
    fn test_set_flag_roundtrip() {
        let tmp = TempDir::new("wakeyweeky-portable");
        let flag = tmp.join(FLAG_FILE);
        set_flag(&flag, true).unwrap();
        assert!(flag.is_file());
        set_flag(&flag, false).unwrap();
        assert!(!flag.exists());
        set_flag(&flag, false).expect("删一个不存在的 flag 不算失败");
    }

    #[test]
    fn test_flag_writable_probe() {
        let tmp = TempDir::new("wakeyweeky-portable");
        assert!(flag_writable(&tmp.join(FLAG_FILE)), "可写目录应当通过");
        assert!(!tmp.join(FLAG_FILE).exists(), "探测不应留下文件");

        // 父路径是个文件 → 写不进去
        let blocked_parent = tmp.join("not-a-dir");
        std::fs::write(&blocked_parent, b"x").unwrap();
        assert!(!flag_writable(&blocked_parent.join(FLAG_FILE)));
    }

    /// P3：便携目录空 → 把来源库复制过去（来源不动、能读出数据）
    #[test]
    fn test_adopt_from_copies_when_target_missing() {
        let tmp = TempDir::new("wakeyweeky-portable");
        let src = tmp.join("default").join(backup::DB_FILE_NAME);
        std::fs::create_dir_all(tmp.join("default")).unwrap();
        make_db(&src, "老数据");
        let target = tmp.join("portable").join(backup::DB_FILE_NAME);
        std::fs::create_dir_all(tmp.join("portable")).unwrap();

        assert!(adopt_from(&src, &target).unwrap(), "应当复制了一份");
        assert_eq!(titles(&target), vec!["老数据"]);
        assert_eq!(titles(&src), vec!["老数据"], "来源库保持原样");
        assert!(!adopt_from(&src, &target).unwrap(), "目标已有库就不再复制");
    }

    /// P5/P6：覆盖目标前先留 `before-switch`；复制成功后清 `-wal`/`-shm`
    #[test]
    fn test_replace_target_with_live_backs_up_and_cleans_sidecars() {
        let tmp = TempDir::new("wakeyweeky-portable");
        let live_path = tmp.join("live").join(backup::DB_FILE_NAME);
        std::fs::create_dir_all(tmp.join("live")).unwrap();
        let live = crate::db::init(&live_path).expect("建 live 失败");
        live.execute(
            "INSERT INTO tasks (id,title,category,created_at) VALUES ('live','正在用的',NULL,1)",
            [],
        )
        .unwrap();

        let target = tmp.join("other").join(backup::DB_FILE_NAME);
        std::fs::create_dir_all(tmp.join("other")).unwrap();
        make_db(&target, "另一边旧的");
        std::fs::write(tmp.join("other").join(format!("{}-wal", backup::DB_FILE_NAME)), b"wal").unwrap();
        std::fs::write(tmp.join("other").join(format!("{}-shm", backup::DB_FILE_NAME)), b"shm").unwrap();

        replace_target_with_live(&live, &target).expect("复制失败");

        assert_eq!(titles(&target), vec!["正在用的"]);
        let backup_path = target.with_file_name(BEFORE_SWITCH_FILE);
        assert_eq!(titles(&backup_path), vec!["另一边旧的"], "旧库要以 before-switch 留下来");
        assert!(
            !tmp.join("other").join(format!("{}-wal", backup::DB_FILE_NAME)).exists()
                && !tmp.join("other").join(format!("{}-shm", backup::DB_FILE_NAME)).exists(),
            "目标侧旧 sidecar 要清掉（跟新库对不上）"
        );
    }

    /// 目标还没有库：直接复制，不产生 before-switch
    #[test]
    fn test_replace_target_without_existing_target() {
        let tmp = TempDir::new("wakeyweeky-portable");
        let live_path = tmp.join("live").join(backup::DB_FILE_NAME);
        std::fs::create_dir_all(tmp.join("live")).unwrap();
        let live = crate::db::init(&live_path).expect("建 live 失败");
        let target = tmp.join("other").join(backup::DB_FILE_NAME);
        replace_target_with_live(&live, &target).expect("复制失败");
        assert!(target.is_file());
        assert!(!target.with_file_name(BEFORE_SWITCH_FILE).exists());
    }

    /// P3：`adopt_if_needed` —— 便携目录空就带数据；有库 / 非便携不动作（guard 直接钉住）
    #[test]
    fn test_adopt_if_needed_guard_and_copy() {
        let tmp = TempDir::new("wakeyweeky-portable");
        let exe = tmp.join("exe");
        std::fs::create_dir_all(&exe).unwrap();
        let default_dir = tmp.join("appdata");
        std::fs::create_dir_all(&default_dir).unwrap();
        make_db(&db_path(&default_dir), "老数据");
        let data = exe.join(DATA_DIR);
        std::fs::create_dir_all(&data).unwrap(); // 启动路径里由 `resolve` 建出来

        let mut paths = DataPaths {
            dir: data.clone(),
            default_dir: default_dir.clone(),
            exe_dir: Some(exe.clone()),
            portable: true,
            fallback: false,
            note: None,
            flag: exe.join(FLAG_FILE),
            adopted: false,
        };
        adopt_if_needed(&mut paths).expect("应当带上数据");
        assert!(paths.adopted, "带上了要记一笔");
        assert_eq!(titles(&db_path(&data)), vec!["老数据"]);
        assert_eq!(titles(&db_path(&default_dir)), vec!["老数据"], "原库不动");

        // 已有库 → 不再动（adopted 保持 false）
        std::fs::remove_file(db_path(&data)).unwrap();
        make_db(&db_path(&data), "便携自己的");
        paths.adopted = false;
        adopt_if_needed(&mut paths).expect("有库时应当直接过");
        assert!(!paths.adopted);
        assert_eq!(titles(&db_path(&data)), vec!["便携自己的"]);

        // 非便携 → 根本不看
        paths.portable = false;
        paths.adopted = false;
        adopt_if_needed(&mut paths).expect("非便携应当直接过");
        assert!(!paths.adopted);
    }

    /// P3 失败的回退：位置回默认、便携关、fallback 与 note 都记上（`lib.rs` 那块接线只剩一行）
    #[test]
    fn test_fall_back_after_adopt_failure() {
        let tmp = TempDir::new("wakeyweeky-portable");
        let mut paths = DataPaths {
            dir: tmp.join("exe").join(DATA_DIR),
            default_dir: tmp.join("appdata"),
            exe_dir: Some(tmp.join("exe")),
            portable: true,
            fallback: false,
            note: None,
            flag: tmp.join("exe").join(FLAG_FILE),
            adopted: true,
        };
        fall_back_after_adopt_failure(&mut paths, "磁盘满了");
        assert_eq!(paths.dir, paths.default_dir);
        assert!(!paths.portable && paths.fallback && !paths.adopted);
        assert!(paths.note.as_deref().unwrap_or("").contains("磁盘满了"));
    }

    #[test]
    fn test_stats_reports_usable_and_broken() {
        let tmp = TempDir::new("wakeyweeky-portable");
        let good = tmp.join("good.sqlite");
        make_db(&good, "有数据");
        let s = stats(&good);
        assert!(s.exists && s.usable, "真库应当可用");
        assert_eq!(s.tasks, Some(1));
        assert_eq!(s.blocks, Some(0));
        assert!(s.modified.is_some() && s.bytes.unwrap() > 0);

        let missing = stats(&tmp.join("nope.sqlite"));
        assert!(!missing.exists && !missing.usable);

        let broken = tmp.join("broken.sqlite");
        std::fs::write(&broken, b"not sqlite").unwrap();
        let b = stats(&broken);
        assert!(b.exists && !b.usable, "不是库的文件不可用");
        assert!(b.reason.is_some());
    }
}
