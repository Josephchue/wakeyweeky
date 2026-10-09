//! round64（C10）：**二期功能开关**（「高度定制化」那一批）—— 键名与读取的**唯一实现**。
//!
//! 用户 2026-10-04 拍板：**除了 MVP，二期新增的功能面全部可以自己开关；默认全开**。
//! 关掉只收 **UI 与行为**，**不删数据**（已合并的块、已接的序列、已存的模板、已标的 ✗ 都保持原样）。
//!
//! - 16 个布尔开关（`KEYS`）：值为 `"0"` 才算关，其余（含缺省）都当开 —— 与 `remind_start` 同一套口径；
//! - 1 个 JSON 设置 `template_suggest`（模板建议：开关 + 门限），规范化在 `commands::settings`。
//!
//! 谁在读它：前端 `settings.svelte.ts`（界面加锁）；Rust 侧三处 —— `db.rs`（融合）、
//! `tray/mod.rs`（托盘状态）、`hint.rs`（当前任务提示）。

use rusqlite::Connection;

use crate::db;

/// 渐进提示（首次用到某功能才提示一次；C10）
pub const HINTS: &str = "hints_enabled";
/// 键盘操作 + 键位栏（C1.9；`Esc` / `Ctrl+Z` 不受它管）
pub const KEYBOARD: &str = "keyboard_enabled";
/// 多选与批量操作（R52）
pub const MULTI_SELECT: &str = "multi_select_enabled";
/// 序列（⛓ + 细线；C3）
pub const SEQUENCES: &str = "sequences_enabled";
/// 漂流（卡与建议；C2）
pub const DRIFT: &str = "drift_enabled";
/// 残影显示（C2）
pub const REMNANTS: &str = "remnants_enabled";
/// 相邻同任务自动融合（C1.2）
pub const MERGE: &str = "merge_enabled";
/// 拉伸（拖边缘改时间；C1.1）
pub const RESIZE: &str = "resize_enabled";
/// 临时安排块（双击空白格；C1.8）
pub const TEMP_BLOCK: &str = "temp_block_enabled";
/// 模板（`▥ 模板`；C10）
pub const TEMPLATES: &str = "templates_enabled";
/// 模板建议（JSON：`{"enabled":bool,"days":N,"done":M}`；C10）
pub const TEMPLATE_SUGGEST: &str = "template_suggest";
/// 一周总览 + 复盘提醒（C7）
pub const REVIEW: &str = "review_enabled";
/// 数据统计（R36）
pub const STATS: &str = "stats_enabled";
/// 托盘状态（当前任务 / 闪烁 / 超载环；C5）
pub const TRAY_STATE: &str = "tray_state_enabled";
/// 当前任务提示（托盘悬停 + 窗口标题；round62 的「一行提示」）
pub const CURRENT_HINT: &str = "current_hint_enabled";
/// 全局快捷键（`Win+Shift+W` 打开主窗口；round66 / C12）
pub const HOTKEYS: &str = "hotkeys_enabled";
/// 每周重复（任务级规则；round69 / B3）
pub const REPEAT: &str = "repeat_enabled";

/// **16 个**布尔开关（默认全开）。`settings.rs` 的 `KNOWN_KEYS` 必须覆盖这里的每一项
/// （有单测看守 `test_feature_keys_are_known_settings`，防两份清单漂移）。
pub const KEYS: [&str; 16] = [
    HINTS,
    KEYBOARD,
    MULTI_SELECT,
    SEQUENCES,
    DRIFT,
    REMNANTS,
    MERGE,
    RESIZE,
    TEMP_BLOCK,
    TEMPLATES,
    REVIEW,
    STATS,
    TRAY_STATE,
    CURRENT_HINT,
    HOTKEYS,
    REPEAT,
];

/// 这个开关开着吗？**默认开**（缺省 / 读失败 / 任何非 `"0"` 的值都当开）。
///
/// 读失败当开是有意的：设置读不出来时，宁可功能还在，也不要静默消失（「默认值要礼貌」里，
/// 开关的礼貌方向是**不减功能**）。
pub fn enabled(conn: &Connection, key: &str) -> bool {
    match db::get_setting(conn, key) {
        Ok(Some(v)) => v.trim() != "0",
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{set_setting, test_conn};

    #[test]
    fn test_default_is_on() {
        let conn = test_conn();
        for key in KEYS {
            assert!(enabled(&conn, key), "{key} 缺省应为开");
        }
    }

    #[test]
    fn test_only_zero_turns_off() {
        let conn = test_conn();
        set_setting(&conn, HINTS, "1").unwrap();
        assert!(enabled(&conn, HINTS));
        set_setting(&conn, HINTS, "0").unwrap();
        assert!(!enabled(&conn, HINTS));
        set_setting(&conn, HINTS, "whatever").unwrap();
        assert!(enabled(&conn, HINTS), "非 0 的值一律当开（只认显式 0）");
    }
}
