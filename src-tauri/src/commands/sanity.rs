//! C6：理智值曲线命令（round44 / 0.8.0）。
//!
//! 只有一条命令 `get_sanity_curve(week_start)`（v2 ④ 的签名），算法全在 `crate::sanity`。
//! 前端在 `reloadWeek()` 之后拉它（见 `stores/sanity.svelte.ts`）。

use tauri::State;

use crate::db;
use crate::sanity::{self, SanityWeek};
use crate::AppState;

/// 读某一周的占用曲线（每天的**并集**分钟 / 档位 / 「挪过 / 没做完」计数）。
#[tauri::command]
pub fn get_sanity_curve(state: State<'_, AppState>, week_start: i64) -> Result<SanityWeek, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    sanity::week_curve(&conn, week_start, db::now())
}
