//! C7（round52 / 0.12.0）：周复盘的数据命令。
//!
//! `get_week_mosaic(week_start)` —— 一周的方块（结局马赛克 + R46 明细的**同一份**数据源）。
//! 算法全在 `crate::review`；这里只加锁取连接（与 `commands/sanity.rs` 同一套）。
//!
//! round58（0.13.1）：周报卡片并进总览后，结语的两条命令（`set_review_note` / `list_review_notes`）已销 ——
//! `reviews` 表回到「建了但没人写」（表本身仍进快照/撤销，等维护轮决定去留）。

use tauri::State;

use crate::{db, review, AppState};

/// 读某一周的方块（结局 / 分类 / 层 / 事实 / 计不计入）。
#[tauri::command]
pub fn get_week_mosaic(
    state: State<'_, AppState>,
    week_start: i64,
) -> Result<Vec<review::MosaicBlock>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    review::week_mosaic(&conn, week_start, db::now())
}

/// 周复盘提醒（C7 · 评审反馈 #1）：到点且这一周未提过 → 返回它**并推进水位线**（一周一次）。
#[tauri::command]
pub fn take_review_nudge(state: State<'_, AppState>) -> Result<Option<review::Nudge>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    review::take_nudge(&conn, db::now())
}

/// 「这一周我看过了」：把水位线推过去（免得提一个刚看过的周）
#[tauri::command]
pub fn mark_review_seen(state: State<'_, AppState>, week_start: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    review::mark_seen(&conn, week_start)
}
