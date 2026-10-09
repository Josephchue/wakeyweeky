//! round64（C10）：渐进式提示的命令层（`take_hint`）—— 逻辑全在 `crate::hints`。

use tauri::State;

use crate::{hints, AppState};

/// 这条提示现在该不该出现？（该 → 后端顺手记「已看过」；每条一生一次）
#[tauri::command]
pub fn take_hint(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    hints::take_hint(&conn, &id)
}
