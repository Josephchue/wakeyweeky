//! 10.1 统计页（R36 / round60 / 0.14.0）：数据统计的命令。
//!
//! `get_stats()` —— 把 `events` 汇成「只摆事实」的累计数字；算法全在 `crate::stats`（唯一实现），
//! 这里只加锁取连接（与 `commands/review.rs` 同一套）。

use tauri::State;

use crate::{db, stats, AppState};

/// 全时段累计 + 近 12 周（面板每次打开拉一次；只读，不改任何数据）
#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> Result<stats::Stats, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let now = db::now();
    // round79（78-10）：统计有「重置线」时只看线之后的（`0` = 全史 = 旧行为）
    stats::summary(&conn, now, stats::RECENT_WEEKS, stats::reset_at(&conn))
}

/// round79（78-10）：「重置统计」—— **非破坏**：只写一个时间界（`stats_reset_at`），
/// 统计页从此只数线之后的事件；**一条 `events` 都不删**（成就引擎 / 复盘理智曲线 / 重复水位线零影响）。
/// 返回线之后重新算出来的数字（前端一次到位，不用二拉）。
#[tauri::command]
pub fn reset_stats(state: State<'_, AppState>) -> Result<stats::Stats, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let now = db::now();
    stats::set_reset_at(&conn, now)?;
    stats::summary(&conn, now, stats::RECENT_WEEKS, now)
}
