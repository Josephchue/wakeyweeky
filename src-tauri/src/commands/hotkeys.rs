//! round66（C12）：全局快捷键的状态查询（注册上了哪个 / 为什么没注册上）。
//!
//! 前端启动时读一次：两个键位都被别的程序占用 → 轻提示一条（设计 H3；
//! 免得你按了没反应还以为坏了）。实现全在 `crate::hotkeys`。

use crate::hotkeys::{self, HotkeyStatus};

#[tauri::command]
pub fn hotkey_status() -> HotkeyStatus {
    hotkeys::status()
}
