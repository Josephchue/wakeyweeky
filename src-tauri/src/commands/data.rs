//! round94（#15）：**外部改库的检测器** —— `PRAGMA data_version`。
//!
//! 为什么需要它：学业OS / 脚本会**直接开 SQLite 写**（见 `docs/plans/round93-…` §2）。App 的所有写路径
//! 都是「写完整周重拉」，但**别的连接**提交时 App 无从得知 —— 界面停旧数据，直到你翻周/重启。
//!
//! 语义（SQLite 文档 + 本机实测）：`PRAGMA data_version` 在**同一连接**上读，只有当**别的连接**提交过
//! 数据后才变；App 自己写库（同一个连接）不涨。所以前端轮询它就能区分「自己写」与「别人写」——
//! 只在真的变了的时候整周重拉，不会自激。
//!
//! 它**只读**、不写库、不记历史（不进 `record`）。

use rusqlite::Connection;
use tauri::State;

use crate::AppState;

/// 读当前连接的 `data_version`（纯函数，单测直接喂两条连接）
pub fn read_data_version(conn: &Connection) -> Result<i64, String> {
    conn.query_row("PRAGMA data_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// IPC：给前端的轮询用（2.5 秒一次；值变了 = 外部改过库）
#[tauri::command]
pub fn data_version(state: State<'_, AppState>) -> Result<i64, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    read_data_version(&conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;
    use rusqlite::Connection;
    use std::path::Path;

    /// 文件库（`data_version` 只在**多连接**下才有意义 —— 内存库各连各的）
    fn file_conn(path: &Path) -> Connection {
        let c = Connection::open(path).expect("开库失败");
        let _ = c.pragma_update(None, "journal_mode", "WAL");
        let _ = c.pragma_update(None, "busy_timeout", 5_000);
        c.execute("CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, v TEXT)", [])
            .expect("建表失败");
        c
    }

    /// 三条语义：① 自己写不涨 ② 别人提交才涨 ③ 涨过之后自己再写也不涨
    #[test]
    fn test_data_version_tracks_only_other_connections() {
        let dir = TempDir::new("ww94-dv");
        let path = dir.join("probe.sqlite");
        let a = file_conn(&path);
        let v0 = read_data_version(&a).expect("读 data_version 失败");

        a.execute("INSERT INTO probe (v) VALUES ('a')", []).expect("A 写失败");
        assert_eq!(
            read_data_version(&a).expect("读失败"),
            v0,
            "同一连接写库不该涨 data_version（否则前端会自己触发重载）"
        );

        let b = Connection::open(&path).expect("开第二个库失败");
        b.execute("INSERT INTO probe (v) VALUES ('b')", []).expect("B 写失败");
        let v1 = read_data_version(&a).expect("读失败");
        assert!(v1 > v0, "外部连接提交后要涨：{v0} → {v1}");

        a.execute("INSERT INTO probe (v) VALUES ('a2')", []).expect("A 再写失败");
        assert_eq!(
            read_data_version(&a).expect("读失败"),
            v1,
            "外部改动之后、自己写也不该再涨（基线跟着上一次外部提交走）"
        );

        b.execute("INSERT INTO probe (v) VALUES ('b2')", []).expect("B 再写失败");
        assert!(
            read_data_version(&a).expect("读失败") > v1,
            "外部再提交一次要再涨"
        );
    }

    /// 空库也要能读（返回 ≥0；不 panic）
    #[test]
    fn test_data_version_reads_on_empty_db() {
        let dir = TempDir::new("ww94-dv-empty");
        let path = dir.join("empty.sqlite");
        let a = Connection::open(&path).expect("开库失败");
        assert!(read_data_version(&a).expect("读失败") >= 0);
    }
}
