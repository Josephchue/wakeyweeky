//! 提醒相关命令（C13 的启动汇总）。
//!
//! 目前只有一个：`missed_summary` —— 前端启动时问一次「我不在的时候错过了几个块」。
//! 为什么是「前端来问」而不是后端发事件：应用冷启动时页面还没开始监听，
//! 事件会丢（C4 的浮窗就踩过这个坑）——让前端主动问最稳。

use tauri::AppHandle;

/// 返回「你不在的时候错过了几个块」，并推进水位线（同一批块只提示一次）。
/// **不改任何块的状态**（用户拍板：给提示，但不标记）。
#[tauri::command]
pub fn missed_summary(app: AppHandle) -> Result<i64, String> {
    Ok(crate::notify::take_missed_summary(&app))
}
