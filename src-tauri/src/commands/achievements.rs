//! round68（19.1）：成就（暗章）命令层 —— 薄壳；规则 / 定义 / 数据全在 `crate::achievements`。
//!
//! - `list_achievements`：面板数据（未点亮也返回：`???` + 条件 + 进度；隐藏档点亮前不返回）
//! - `note_achievement`：前端信号（白名单在 `achievements::SIGNALS`；未知信号报错）
//! - `achievements_debug_*`：debug 构建自证用（release 拒绝）

use tauri::State;

use crate::achievements::{self, ListPayload};
use crate::AppState;
use crate::i18n;

#[tauri::command]
pub fn list_achievements(state: State<'_, AppState>) -> Result<ListPayload, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    achievements::list(&conn)
}

/// round79（78-11）：**重置成就** —— 清空点亮记录 + 把计分起点挪到此刻（从此刻起重新挣）。
/// **一条数据不删**（任务/块/统计都不动，只删成就自己那张表）。
#[tauri::command]
pub fn reset_achievements(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    achievements::reset(&conn)
}

#[tauri::command]
pub fn note_achievement(state: State<'_, AppState>, signal: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    achievements::note(&conn, &signal)
}

#[tauri::command]
pub fn achievements_debug_unlock_all(state: State<'_, AppState>) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err(i18n::t(i18n::msg::ERR_CMD_ACHIEVEMENTS_01).to_string());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    achievements::debug_unlock_all(&conn)
}

#[tauri::command]
pub fn achievements_debug_lock_all(state: State<'_, AppState>) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err(i18n::t(i18n::msg::ERR_CMD_ACHIEVEMENTS_02).to_string());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    achievements::debug_lock_all(&conn)
}

/// 命令层内部用：打一个信号；**失败只记日志**，绝不影响主操作（成就坏不能拖累排程）
pub(crate) fn note_signal(state: &AppState, signal: &str) {
    let Ok(conn) = state.db.lock() else {
        return;
    };
    if let Err(e) = achievements::note(&conn, signal) {
        eprintln!("[achievements] 信号 {signal} 失败（忽略）：{e}");
    }
}
