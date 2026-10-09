//! round62（C14）：数据导出 / 导入备份 —— v2 ④ 的命令 `export_backup` / `import_backup`
//! （界面文案叫「导出备份…」「从备份恢复…」）。
//!
//! 文件名与流程的出处：`docs/plans/round62-backup-and-current-hint.md` §二·补。
//! 命令层只做三件事：取目录、拿库锁、失败说人话；文件操作与校验全在 `crate::backup`（可单测）。

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};

use crate::backup;
use crate::AppState;
use crate::i18n;
use crate::tf;

/// 导出结果（前端 Toast 要把路径与大小摆出来 —— 借鉴 super-productivity 的备份路径展示）
#[derive(Debug, serde::Serialize)]
pub struct ExportInfo {
    pub path: String,
    pub bytes: u64,
}

/// 导出整库备份。目标已存在则先删（系统的「另存为」已经问过覆盖）。
#[tauri::command]
pub fn export_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<ExportInfo, String> {
    let dir = app.state::<crate::portable::DataPaths>().dir.clone();
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    export_backup_impl(&conn, &dir, &path)
}

/// 从备份恢复：校验 → 留「恢复前副本」→ staging → **重启应用**换上
/// （换库本身在 `backup::apply_pending_restore`，启动时、`db::init` 之前跑）。
#[tauri::command]
pub fn import_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let dir = app.state::<crate::portable::DataPaths>().dir.clone();
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        import_backup_impl(&conn, &dir, &path)?;
    }
    eprintln!("[backup] 待恢复备份已就位（{path}），重启应用完成恢复");
    app.restart(); // -> ! 不会返回：新进程启动时由 apply_pending_restore 换库
}

/// 命令本体（拆出来好单测：临时目录 + 真库即可）
pub(crate) fn export_backup_impl(
    conn: &Connection,
    dir: &Path,
    path: &str,
) -> Result<ExportInfo, String> {
    let target = PathBuf::from(path);
    if is_same_file(&target, &dir.join(backup::DB_FILE_NAME)) {
        return Err(i18n::t(i18n::msg::ERR_CMD_BACKUP_01).to_string());
    }
    if target.exists() {
        std::fs::remove_file(&target).map_err(|e| tf!(i18n::msg::ERR_CMD_BACKUP_02, e = e))?;
    }
    backup::vacuum_into(conn, &target)?;
    let bytes = backup::inspect(&target)?; // 产物自检：让「导出成功」是真的
    // round68（19.1）：暗章信号（导出过一次备份）
    if let Err(e) = crate::achievements::note(conn, "backup") {
        eprintln!("[achievements] 信号 backup 失败（忽略）：{e}");
    }
    Ok(ExportInfo {
        path: target.display().to_string(),
        bytes,
    })
}

/// 命令本体（同上，好单测）
pub(crate) fn import_backup_impl(
    conn: &Connection,
    dir: &Path,
    path: &str,
) -> Result<(), String> {
    let source = PathBuf::from(path);
    if is_same_file(&source, &dir.join(backup::DB_FILE_NAME)) {
        return Err(i18n::t(i18n::msg::ERR_CMD_BACKUP_03).to_string());
    }
    backup::validate_backup(&source)?;

    // 1) 「恢复前副本」：用 VACUUM INTO 拍当前库（一致副本；万一恢复不理想还能换回来）
    let before = dir.join(backup::BEFORE_RESTORE_FILE_NAME);
    if before.exists() {
        std::fs::remove_file(&before).map_err(|e| tf!(i18n::msg::ERR_CMD_BACKUP_04, e = e))?;
    }
    backup::vacuum_into(conn, &before)?;

    // 2) staging：源库拷成 incoming（新进程启动时换上）
    let incoming = dir.join(backup::INCOMING_FILE_NAME);
    if incoming.exists() {
        std::fs::remove_file(&incoming).map_err(|e| tf!(i18n::msg::ERR_CMD_BACKUP_05, e = e))?;
    }
    std::fs::copy(&source, &incoming).map_err(|e| tf!(i18n::msg::ERR_CMD_BACKUP_06, e = e))?;
    Ok(())
}

/// 两个路径是不是同一个文件（比较 canonicalize 后的结果；任一不存在 = false）
fn is_same_file(a: &Path, b: &Path) -> bool {
    matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn export_path(dir: &Path) -> String {
        dir.join("导出-测试.db").display().to_string()
    }

    #[test]
    fn test_export_refuses_current_db_path_and_overwrites_existing() {
        let tmp = TempDir::new("wakeyweeky-backup-cmd");
        let dir = tmp.path();
        let live_path = dir.join(backup::DB_FILE_NAME);
        let live = crate::db::init(&live_path).expect("建库失败");
        live.execute(
            "INSERT INTO tasks (id, title, category, created_at) VALUES ('t1','导出靶子',NULL,1)",
            [],
        )
        .expect("插入任务失败");

        // 目标是当前库 → 拒绝
        let err = export_backup_impl(&live, dir, &live_path.display().to_string())
            .expect_err("应当拒绝导出到当前库");
        assert!(err.contains("当前数据库"), "错误要能看懂：{err}");

        // 目标已存在（系统的「另存为」问过覆盖）→ 先删再写
        let target = export_path(dir);
        std::fs::write(&target, b"junk").expect("写占位文件失败");
        let info = export_backup_impl(&live, dir, &target).expect("导出失败");
        assert!(info.bytes > 0, "产物不该是空文件");
        backup::validate_backup(Path::new(&info.path)).expect("产物必须能通过校验");

        // 目标目录不存在 → 人话报错（plan §7 承诺的那半条：移动盘 / 网盘请换个位置）
        let missing = dir.join("no-such-dir").join("out.db");
        let err = export_backup_impl(&live, dir, &missing.display().to_string())
            .expect_err("不可写的位置应当失败");
        assert!(err.contains("生成备份失败"), "错误要能看懂：{err}");

        // 产物里真的有那条任务
        let copy = Connection::open(&target).expect("打开产物失败");
        let title: String = copy
            .query_row("SELECT title FROM tasks WHERE id='t1'", [], |r| r.get(0))
            .expect("产物里应当有导出的任务");
        assert_eq!(title, "导出靶子");
    }

    #[test]
    fn test_import_stages_and_keeps_before_restore_copy() {
        let tmp = TempDir::new("wakeyweeky-backup-cmd");
        let dir = tmp.path();
        let live_path = dir.join(backup::DB_FILE_NAME);
        let live = crate::db::init(&live_path).expect("建库失败");
        live.execute(
            "INSERT INTO tasks (id, title, category, created_at) VALUES ('live','当前库',NULL,1)",
            [],
        )
        .expect("插入任务失败");

        // 源备份：另一个真库（带一条可辨认的任务）
        let src_dir = TempDir::new("wakeyweeky-backup-src");
        let src_path = src_dir.join("src.db");
        let src = crate::db::init(&src_path).expect("建源库失败");
        src.execute(
            "INSERT INTO tasks (id, title, category, created_at) VALUES ('t1','来自备份',NULL,1)",
            [],
        )
        .expect("插入任务失败");
        drop(src); // 关连接（WAL 收尾），再去拷它

        import_backup_impl(&live, dir, &src_path.display().to_string()).expect("staging 失败");
        assert!(
            dir.join(backup::INCOMING_FILE_NAME).is_file(),
            "incoming 应当就位"
        );
        assert!(
            dir.join(backup::BEFORE_RESTORE_FILE_NAME).is_file(),
            "恢复前副本应当留下"
        );
        // 「恢复前副本」必须是**当前库**的一致副本（6b：以前只断言文件存在 → 副本里是空的也绿）
        let before = Connection::open(dir.join(backup::BEFORE_RESTORE_FILE_NAME))
            .expect("打开恢复前副本失败");
        let before_title: String = before
            .query_row("SELECT title FROM tasks WHERE id='live'", [], |r| r.get(0))
            .expect("恢复前副本里应当有当前库的数据");
        assert_eq!(before_title, "当前库");
        drop(before);

        let copy = Connection::open(dir.join(backup::INCOMING_FILE_NAME)).expect("打开 incoming 失败");
        let title: String = copy
            .query_row("SELECT title FROM tasks WHERE id='t1'", [], |r| r.get(0))
            .expect("incoming 里应当有源库的数据");
        assert_eq!(title, "来自备份");
        drop(copy);

        // 非法源 → 拒绝（先校验，不动已有的 incoming / 副本）
        let bad = dir.join("bad.db");
        std::fs::write(&bad, b"not a db").expect("写坏文件失败");
        let incoming_before = std::fs::read(dir.join(backup::INCOMING_FILE_NAME)).expect("读 incoming 失败");
        let snapshot_before =
            std::fs::read(dir.join(backup::BEFORE_RESTORE_FILE_NAME)).expect("读副本失败");
        let err = import_backup_impl(&live, dir, &bad.display().to_string())
            .expect_err("坏文件应当被拒绝");
        assert!(err.contains("打不开"), "错误要能看懂：{err}");
        assert_eq!(
            std::fs::read(dir.join(backup::INCOMING_FILE_NAME)).expect("读 incoming 失败"),
            incoming_before,
            "被拒时必须不动已经就位的 incoming"
        );
        assert_eq!(
            std::fs::read(dir.join(backup::BEFORE_RESTORE_FILE_NAME)).expect("读副本失败"),
            snapshot_before,
            "被拒时必须不动恢复前副本"
        );

        // 选中的就是当前库 → 拒绝
        let err = import_backup_impl(&live, dir, &live_path.display().to_string())
            .expect_err("选当前库应当拒绝");
        assert!(err.contains("当前数据库"), "错误要能看懂：{err}");
    }
}
