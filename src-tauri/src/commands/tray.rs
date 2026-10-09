//! 托盘状态命令（v2 ⑪ C5）。
//!
//! 本轮**没有前端调用**：它服务于文档要求的「预留 set_tray_state 的入参枚举」——
//! 留给 C6（理智值超载态）与手工调试使用。
//! 例：`invoke("set_tray_state", { state: "sanity_overload" })`

use crate::tray::{self, TrayState};
use tauri::AppHandle;
use crate::i18n;
use crate::tf;

#[tauri::command]
pub fn set_tray_state(app: AppHandle, state: String) -> Result<(), String> {
    match TrayState::from_label(&state) {
        Some(state) => {
            tray::set_state(&app, state);
            Ok(())
        }
        None => Err(tf!(i18n::msg::ERR_CMD_TRAY_01, state = state)),
    }
}
