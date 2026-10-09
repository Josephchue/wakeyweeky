//! round62（C14）：数据备份的**文件层** —— 换库、校验、`VACUUM INTO`。
//!
//! 设计（七段 + 技术细节）：`docs/plans/round62-backup-and-current-hint.md`。分工：
//! - 本模块只碰文件与 SQLite，**不认识 Tauri**（纯函数可单测）；
//! - `commands/backup.rs` 是命令层（取目录、拿库锁、重启）；
//! - 导出用 `VACUUM INTO`（SQLite 官方给 live 库拍**一致副本**的办法），不裸拷文件 ——
//!   WAL 模式下裸拷会漏 `-wal` 里还没合并的内容（出处：`sqlite.org/lang_vacuum.html`）。

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use crate::i18n;
use crate::tf;

/// 主库文件名（`lib.rs` 与命令层共用；**只有这一处定义**）
pub const DB_FILE_NAME: &str = "wakeyweeky.sqlite";
/// 待恢复的备份（staging；启动时由 `apply_pending_restore` 换上）
pub const INCOMING_FILE_NAME: &str = "wakeyweeky.sqlite.incoming";
/// 「恢复前副本」（每次恢复前自动拍一份，兜底用）
pub const BEFORE_RESTORE_FILE_NAME: &str = "wakeyweeky.sqlite.before-restore";
/// 换库过程中旧库的临时名（成功即删；失败时用它回滚）
const REPLACE_OLD_FILE_NAME: &str = "wakeyweeky.sqlite.replace-old";

/// 换库重试次数（5 秒 = 25 × 200ms；测试用 `apply_pending_restore_with` 传小值）
const RESTORE_RETRY_ATTEMPTS: usize = 25;

/// 启动时应用「待恢复」的备份。**必须在 `db::init` 之前调用**（`lib.rs` setup）。
///
/// 流程（**顺序是安全的一部分**）：
/// ① 先收拾上次失败的现场：db 不在而 `.replace-old` 在 → 把它放回来（那是唯一一份旧数据）；
/// ② 旧库改名 `.replace-old` 让位（只改名不删）；
/// ③ `.incoming` 改名成库；失败就回滚（把 `.replace-old` 改回来，改不动就**拷贝**回来）；
/// ④ 成功之后才清旧 `-wal`/`-shm`、删 `.replace-old`。
///
/// 为什么 sidecar 清在 ③ 之后：回滚时旧库要原样可用，`-wal` 里可能还有没 checkpoint 的提交；
/// 先删了它，回滚出来的旧库就少了最后几次写（`restart` 走 `exit(0)`，不是干净关闭）。
///
/// 失败一律返回 `Err` 但**不动新库**：`lib.rs` 只记日志、继续用旧库启动；
/// `.incoming` 留着，下次启动再试（这一点由 `lib.rs` 的调用点注释守住）。
pub fn apply_pending_restore(dir: &Path) -> Result<Option<PathBuf>, String> {
    apply_pending_restore_with(dir, RESTORE_RETRY_ATTEMPTS)
}

fn apply_pending_restore_with(dir: &Path, attempts: usize) -> Result<Option<PathBuf>, String> {
    let db = dir.join(DB_FILE_NAME);
    let incoming = dir.join(INCOMING_FILE_NAME);
    let replace_old = dir.join(REPLACE_OLD_FILE_NAME);

    // ① 上次失败的现场：db 不在、`.replace-old` 在 → 先把它放回来（这是唯一一份旧数据）
    if !db.is_file() && replace_old.is_file() {
        retry(attempts, || std::fs::rename(&replace_old, &db), i18n::t(i18n::msg::ERR_BACKUP_01)).map_err(|e| {
            tf!(i18n::msg::ERR_BACKUP_20, e = e, p1 = replace_old.display(), p2 = db.display())
        })?;
        eprintln!("[backup] 上次未回滚的旧库已放回原位");
    }
    if !incoming.is_file() {
        return Ok(None);
    }
    eprintln!("[backup] 发现待恢复的备份，开始换库");

    // ② 旧库让位（db 在、`.replace-old` 也在 = 上一次「让位」没做成留下的垃圾 → 先清掉）
    let had_db = db.is_file();
    if had_db {
        if replace_old.is_file() {
            let _ = std::fs::remove_file(&replace_old);
        }
        retry(attempts, || std::fs::rename(&db, &replace_old), i18n::t(i18n::msg::ERR_BACKUP_02))?;
    }

    // ③ 新库就位；失败 → 回滚（改名不成再试拷贝：宁可慢，也不能让应用对着空库启动）
    if let Err(e) = retry(attempts, || std::fs::rename(&incoming, &db), i18n::t(i18n::msg::ERR_BACKUP_03)) {
        if had_db {
            let back = retry(attempts, || std::fs::rename(&replace_old, &db), i18n::t(i18n::msg::ERR_BACKUP_04)).or_else(|_| {
                std::fs::copy(&replace_old, &db)
                    .map(|_| ())
                    .map_err(|e| tf!(i18n::msg::ERR_BACKUP_05, e = e))
            });
            if let Err(back_err) = back {
                return Err(tf!(i18n::msg::ERR_BACKUP_21, e = e, back_err = back_err, p1 = replace_old.display()));
            }
        }
        return Err(tf!(i18n::msg::ERR_BACKUP_22, e = e));
    }

    // ④ 新库已在位：旧 WAL/SHM 跟着库名走、跟新库对不上 → 清掉；再删 `.replace-old`
    for suffix in ["-wal", "-shm"] {
        let sidecar = dir.join(format!("{DB_FILE_NAME}{suffix}"));
        if sidecar.is_file() {
            if let Err(e) = std::fs::remove_file(&sidecar) {
                eprintln!("[backup] 删除 {} 失败（继续换库）：{e}", sidecar.display());
            }
        }
    }
    if had_db {
        if let Err(e) = std::fs::remove_file(&replace_old) {
            eprintln!("[backup] 删除旧库临时件失败（无害）：{e}");
        }
    }
    eprintln!("[backup] 换库完成：{}", db.display());
    Ok(Some(db))
}

/// 校验一个备份文件能不能拿来恢复（**只读**，不动源文件）：
/// 能打开 → `quick_check` 通过 → 必需表齐 → 迁移版本没有本版不认识的（新的拒）。
pub fn validate_backup(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(i18n::t(i18n::msg::ERR_BACKUP_06).to_string());
    }
    let conn = open_read_only(path)?;
    let ok: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| tf!(i18n::msg::ERR_BACKUP_07, e = e))?;
    if ok != "ok" {
        return Err(tf!(i18n::msg::ERR_BACKUP_08, ok = ok));
    }
    let mut missing = Vec::new();
    for table in ["tasks", "blocks", "settings", "schema_migrations"] {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                [table],
                |r| r.get(0),
            )
            .map_err(|e| tf!(i18n::msg::ERR_BACKUP_09, e = e))?;
        if !exists {
            missing.push(table);
        }
    }
    if !missing.is_empty() {
        return Err(tf!(i18n::msg::ERR_BACKUP_23, p1 = missing.join(" / ")));
    }
    let ours = crate::db::migration_versions();
    let mut stmt = conn
        .prepare("SELECT version FROM schema_migrations")
        .map_err(|e| tf!(i18n::msg::ERR_BACKUP_10, e = e))?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| tf!(i18n::msg::ERR_BACKUP_11, e = e))?;
    for row in rows {
        let version = row.map_err(|e| tf!(i18n::msg::ERR_BACKUP_12, e = e))?;
        if !ours.contains(&version.as_str()) {
            return Err(tf!(i18n::msg::ERR_BACKUP_24, version = version));
        }
    }
    Ok(())
}

/// `VACUUM INTO`：生成**一致**副本（目标必须不存在；调用方决定先删还是报错）。
pub fn vacuum_into(conn: &Connection, target: &Path) -> Result<(), String> {
    let path = target
        .to_str()
        .ok_or_else(|| i18n::t(i18n::msg::ERR_BACKUP_13).to_string())?;
    conn.execute("VACUUM INTO ?1", rusqlite::params![path])
        .map_err(|e| tf!(i18n::msg::ERR_BACKUP_14, e = e))?;
    Ok(())
}

/// 只读打开 + `quick_check`，返回文件字节数（导出后的**产物自检**用：让「导出成功」是真的）。
pub fn inspect(path: &Path) -> Result<u64, String> {
    let conn = open_read_only(path)?;
    let ok: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| tf!(i18n::msg::ERR_BACKUP_15, e = e))?;
    if ok != "ok" {
        return Err(tf!(i18n::msg::ERR_BACKUP_16, ok = ok));
    }
    std::fs::metadata(path)
        .map(|m| m.len())
        .map_err(|e| tf!(i18n::msg::ERR_BACKUP_17, e = e))
}

fn open_read_only(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| tf!(i18n::msg::ERR_BACKUP_18, e = e))
}

/// 文件被占用时重试（旧进程正在退出，句柄还没释放）。
fn retry<T>(
    attempts: usize,
    mut op: impl FnMut() -> std::io::Result<T>,
    what: &str,
) -> Result<T, String> {
    let mut last = String::new();
    for _ in 0..attempts {
        match op() {
            Ok(value) => return Ok(value),
            Err(e) => {
                last = e.to_string();
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
    Err(tf!(i18n::msg::ERR_BACKUP_19, what = what, attempts = attempts, last = last))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用临时目录（round62：与 `db.rs` 测试共用 `crate::testutil` 那一份）
    use crate::testutil::TempDir;

    /// 建一个「真库」文件（跑过全部迁移），返回它的路径
    fn make_real_db(path: &Path) {
        let conn = crate::db::init(path).expect("建库失败");
        drop(conn);
    }

    #[test]
    fn test_apply_pending_restore_no_incoming_is_noop() {
        let tmp = TempDir::new("wakeyweeky-backup");
        std::fs::write(tmp.join(DB_FILE_NAME), b"old").expect("写文件失败");
        assert_eq!(
            apply_pending_restore(tmp.path()).expect("不该失败"),
            None
        );
        assert_eq!(
            std::fs::read(tmp.join(DB_FILE_NAME)).expect("读失败"),
            b"old",
            "没有待恢复文件时不许动库"
        );
    }

    /// round62：换进去的 `.incoming` 是真库时，换完必须能当库打开、读到新数据（
    /// 旧版只用假内容比对字节 → 换进去一份坏文件也绿）
    #[test]
    fn test_apply_pending_restore_swaps_in_real_database_and_cleans_sidecars() {
        let tmp = TempDir::new("wakeyweeky-backup");
        let src = TempDir::new("wakeyweeky-backup-src");
        // 旧库：真库 + 一条旧数据；旁边摆两份假 sidecar（清没清能看出来）
        let db_path = tmp.join(DB_FILE_NAME);
        let old = crate::db::init(&db_path).expect("建旧库失败");
        old.execute(
            "INSERT INTO tasks (id,title,category,created_at) VALUES ('old','旧数据',NULL,1)",
            [],
        )
        .expect("插入失败");
        drop(old);
        std::fs::write(tmp.join(format!("{DB_FILE_NAME}-wal")), b"wal").expect("写失败");
        std::fs::write(tmp.join(format!("{DB_FILE_NAME}-shm")), b"shm").expect("写失败");

        // incoming：另一个真库（用 VACUUM INTO 出一份一致的副本）
        let new_path = src.join("new.db");
        let new = crate::db::init(&new_path).expect("建新库失败");
        new.execute(
            "INSERT INTO tasks (id,title,category,created_at) VALUES ('new','新数据',NULL,1)",
            [],
        )
        .expect("插入失败");
        vacuum_into(&new, &tmp.join(INCOMING_FILE_NAME)).expect("导出 incoming 失败");
        drop(new);

        assert!(apply_pending_restore(tmp.path()).expect("换库失败").is_some());

        // 先查 sidecar / 临时件（在下一次 db::init 之前 —— init 自己会重建 -wal，别把自家脚印当残留）
        assert!(!tmp.join(INCOMING_FILE_NAME).exists(), "incoming 换走后不应残留");
        assert!(
            !tmp.join(format!("{DB_FILE_NAME}-wal")).exists()
                && !tmp.join(format!("{DB_FILE_NAME}-shm")).exists(),
            "旧 WAL/SHM 必须清掉（否则跟新库对不上）"
        );
        assert!(!tmp.join(REPLACE_OLD_FILE_NAME).exists(), "成功换库后临时件应当删掉");

        let conn = crate::db::init(&db_path).expect("换完的库应当能打开");
        let mut stmt = conn.prepare("SELECT title FROM tasks ORDER BY id").expect("查询失败");
        let titles: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .expect("查询失败")
            .map(|r| r.expect("读行失败"))
            .collect();
        assert_eq!(titles, vec!["新数据"], "换完应当是新库的数据（旧数据不该在）");
    }

    /// round62：上次失败留下的 `.replace-old`（db 不在）→ 先把它放回来（那是唯一一份旧数据）
    #[test]
    fn test_apply_pending_restore_recovers_leftover_old_db() {
        let tmp = TempDir::new("wakeyweeky-backup");
        std::fs::write(tmp.join(REPLACE_OLD_FILE_NAME), b"old").expect("写文件失败");
        assert_eq!(apply_pending_restore(tmp.path()).expect("不该失败"), None);
        assert_eq!(
            std::fs::read(tmp.join(DB_FILE_NAME)).expect("读失败"),
            b"old",
            "没回滚成的旧库要被放回来"
        );
        assert!(!tmp.join(REPLACE_OLD_FILE_NAME).exists());
    }

    /// round62：新库就位失败 → 回滚成旧库，且**旧库的 sidecar 与 `.incoming` 都不能被动**
    ///（6b 指出的真缺口：旧版先删 `-wal` → 回滚出来的旧库少最后几次写）
    #[cfg(windows)] // 靠 Windows 独占句柄造「文件被占」；跨平台行为不同，只在本平台钉
    #[test]
    fn test_apply_pending_restore_rolls_back_and_keeps_wal() {
        use std::os::windows::fs::OpenOptionsExt;

        let tmp = TempDir::new("wakeyweeky-backup");
        std::fs::write(tmp.join(DB_FILE_NAME), b"old").expect("写失败");
        std::fs::write(tmp.join(format!("{DB_FILE_NAME}-wal")), b"wal").expect("写失败");
        std::fs::write(tmp.join(INCOMING_FILE_NAME), b"new").expect("写失败");
        // 独占句柄（share_mode=0）拿住 incoming：改名/删除都会被系统拒 → 真造出「旧进程还占着」的现场
        let hold = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(tmp.join(INCOMING_FILE_NAME))
            .expect("拿住 incoming 失败");
        let err = apply_pending_restore_with(tmp.path(), 2).expect_err("占用时应当失败");
        drop(hold);
        assert!(err.contains("继续用旧库"), "错误要说人话：{err}");
        assert_eq!(
            std::fs::read(tmp.join(DB_FILE_NAME)).expect("读失败"),
            b"old",
            "旧库要回位"
        );
        assert!(
            tmp.join(format!("{DB_FILE_NAME}-wal")).is_file(),
            "回滚路径不许删掉旧库的 -wal"
        );
        assert!(tmp.join(INCOMING_FILE_NAME).is_file(), "待恢复文件要留着下次再试");
        assert!(!tmp.join(REPLACE_OLD_FILE_NAME).exists(), "回滚成功后临时件不该留下");
    }

    #[test]
    fn test_apply_pending_restore_without_existing_db() {
        let tmp = TempDir::new("wakeyweeky-backup");
        std::fs::write(tmp.join(INCOMING_FILE_NAME), b"fresh").expect("写文件失败");
        assert!(apply_pending_restore(tmp.path()).expect("换库失败").is_some());
        assert_eq!(
            std::fs::read(tmp.join(DB_FILE_NAME)).expect("读失败"),
            b"fresh"
        );
    }

    #[test]
    fn test_validate_rejects_non_sqlite() {
        let tmp = TempDir::new("wakeyweeky-backup");
        let file = tmp.join("notes.db");
        std::fs::write(&file, "这不是数据库").expect("写文件失败");
        let err = validate_backup(&file).expect_err("应当拒绝");
        assert!(err.contains("打不开"), "错误要能看懂：{err}");
    }

    #[test]
    fn test_validate_rejects_missing_tables() {
        let tmp = TempDir::new("wakeyweeky-backup");
        let file = tmp.join("half.db");
        let conn = Connection::open(&file).expect("打开失败");
        conn.execute("CREATE TABLE tasks (id TEXT)", [])
            .expect("建表失败");
        drop(conn);
        let err = validate_backup(&file).expect_err("应当拒绝");
        assert!(err.contains("缺少表"), "错误要能看懂：{err}");
    }

    #[test]
    fn test_validate_accepts_real_db_and_rejects_future_migration() {
        let tmp = TempDir::new("wakeyweeky-backup");
        let file = tmp.join("real.db");
        make_real_db(&file);
        validate_backup(&file).expect("真库应当通过校验");

        // 伪造一条「本版不认识的迁移」→ 必须拒绝
        let conn = Connection::open(&file).expect("打开失败");
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES ('999', 0)",
            [],
        )
        .expect("插入迁移记录失败");
        drop(conn);
        let err = validate_backup(&file).expect_err("未来版本应当拒绝");
        assert!(err.contains("更新的版本"), "错误要能看懂：{err}");
    }

    #[test]
    fn test_vacuum_into_makes_usable_copy() {
        let tmp = TempDir::new("wakeyweeky-backup");
        let live = crate::db::test_conn();
        live.execute(
            "INSERT INTO tasks (id, title, category, created_at) VALUES ('t1','备份里的任务',NULL,1)",
            [],
        )
        .expect("插入任务失败");
        let target = tmp.join("out.db");
        vacuum_into(&live, &target).expect("导出失败");

        let bytes = inspect(&target).expect("产物自检失败");
        assert!(bytes > 0, "产物不该是空文件");

        let copy = Connection::open(&target).expect("打开产物失败");
        let title: String = copy
            .query_row("SELECT title FROM tasks WHERE id='t1'", [], |r| r.get(0))
            .expect("产物里应当有导出的任务");
        assert_eq!(title, "备份里的任务");
    }
}
