//! round64（C11）：`.ics` 导出的命令层 —— 只做三件事：拿库锁、调 `crate::ics`、写文件。
//! 渲染与读取全在 `src-tauri/src/ics.rs`（唯一实现、可单测；口径与证据见其文件头）。

use std::path::PathBuf;

use rusqlite::Connection;
use tauri::State;

use crate::{db, ics, AppState};
use crate::i18n;
use crate::tf;

/// 导出结果（前端 Toast 要把路径与条数摆出来）
#[derive(Debug, serde::Serialize)]
pub struct IcsExportInfo {
    pub path: String,
    pub bytes: u64,
    pub events: usize,
}

/// 导出全部排程为 `.ics`（系统的「另存为」已经问过覆盖）
#[tauri::command]
pub fn export_ics(state: State<'_, AppState>, path: String) -> Result<IcsExportInfo, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    export_ics_impl(&conn, &path)
}

/// 命令本体（拆出来好单测：临时目录 + 真库即可）
pub(crate) fn export_ics_impl(conn: &Connection, path: &str) -> Result<IcsExportInfo, String> {
    if path.trim().is_empty() {
        return Err(i18n::t(i18n::msg::ERR_CMD_CALENDAR_01).to_string());
    }
    let events = ics::collect_events(conn)?;
    let text = ics::render_ics(&events, db::now());
    let target = PathBuf::from(path);
    std::fs::write(&target, text.as_bytes()).map_err(|e| tf!(i18n::msg::ERR_CMD_CALENDAR_02, e = e))?;
    let bytes = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(text.len() as u64);
    eprintln!("[ics] 已导出 {} 条到 {}", events.len(), target.display());
    // round68（19.1）：暗章信号（导出过一次）
    if let Err(e) = crate::achievements::note(conn, "export_ics") {
        eprintln!("[achievements] 信号 export_ics 失败（忽略）：{e}");
    }
    Ok(IcsExportInfo {
        path: target.display().to_string(),
        bytes,
        events: events.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_block, create_task, test_conn};
    use chrono::{TimeZone, Utc};

    #[test]
    fn test_export_writes_file_with_events() {
        let conn = test_conn();
        let task = create_task(&conn, "写周报", None).unwrap();
        let start = Utc.with_ymd_and_hms(2026, 10, 5, 1, 0, 0).unwrap().timestamp();
        create_block(&conn, &task.id, start, start + 3600).unwrap();

        let dir = std::env::temp_dir().join("wakeyweeky-ics-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("export.ics");
        let info = export_ics_impl(&conn, path.to_str().unwrap()).unwrap();
        assert_eq!(info.events, 1);
        assert!(info.bytes > 0);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("SUMMARY:写周报"), "text={text}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_export_rejects_empty_path() {
        let conn = test_conn();
        assert!(export_ics_impl(&conn, "  ").is_err());
    }

    #[test]
    fn test_export_bad_directory_reports_error() {
        let conn = test_conn();
        let bad = std::env::temp_dir().join("wakeyweeky-ics-不存在").join("x.ics");
        let err = export_ics_impl(&conn, bad.to_str().unwrap()).unwrap_err();
        assert!(err.contains("写入失败"), "err={err}");
    }
}
