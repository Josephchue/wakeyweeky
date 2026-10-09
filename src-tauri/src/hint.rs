//! round62（11 当前任务一行提示）：把「现在在干什么、还剩多久」写到两个地方 ——
//! 托盘悬停提示与窗口标题（任务栏）。
//!
//! - 刷新节拍**复用提醒线程**（`notify::scan_once` 每轮 ≤60 秒调一次），不新开线程：
//!   任何块变更都会 `wake_notifier()` 叫醒它 → 提示几乎即时跟着变。
//! - 托盘 tooltip 的覆写**只在 `HasCurrentTask` 基线态**生效（提醒态 / 超载态保持自己的文案，
//!   优先级不破）—— 由 `tray::paint_current` 裁决。
//! - 文案纯函数 `format_line` 单独可测：托盘文案肉眼看不见，靠单测钉住。

use tauri::{AppHandle, Manager};

use crate::db::CurrentHint;
use crate::i18n;
use crate::tf;

/// 无进行中块时的标题（与 `tauri.conf.json` 的初始标题一致）
pub const DEFAULT_TITLE: &str = "WakeyWeeky";

/// 一行提示的**正文**（不带应用名）：`写周报 · 还剩 23 分`。
///
/// 规则（round62 定稿）：剩 ≤ 60 秒 → `即将结束`；< 1 小时 → `还剩 N 分`（**向上取整**）；
/// < 24 小时 → `还剩 H 小时[ M 分]`；≥ 24 小时 → `还剩 D 天[ H 小时]`。
pub fn format_body(hint: &CurrentHint, now: i64) -> String {
    let secs = hint.end_at.saturating_sub(now);
    let body = if secs <= 60 {
        i18n::t(i18n::msg::SYS_HINT_01).to_string()
    } else {
        let minutes = (secs + 59) / 60;
        if minutes < 60 {
            tf!(i18n::msg::SYS_HINT_02, minutes = minutes)
        } else if minutes < 24 * 60 {
            let (h, m) = (minutes / 60, minutes % 60);
            if m == 0 {
                tf!(i18n::msg::SYS_HINT_03, h = h)
            } else {
                tf!(i18n::msg::SYS_HINT_04, h = h, m = m)
            }
        } else {
            let (d, h) = (minutes / (24 * 60), minutes % (24 * 60) / 60);
            if h == 0 {
                tf!(i18n::msg::SYS_HINT_05, d = d)
            } else {
                tf!(i18n::msg::SYS_HINT_06, d = d, h = h)
            }
        }
    };
    format!("{} · {body}", hint.title)
}

/// 窗口标题：`<正文> — WakeyWeeky`（Windows「document name – program name」惯例）；
/// 没有进行中的块 → `WakeyWeeky`。托盘悬停自己组装（见 `tray::tooltip_text`）。
pub fn format_title(hint: Option<&CurrentHint>, now: i64) -> String {
    match hint {
        Some(h) => format!("{} — {DEFAULT_TITLE}", format_body(h, now)),
        None => DEFAULT_TITLE.to_string(),
    }
}

/// 算一行并写进两个落点。`notify::scan_once` 每轮调一次；文本没变就什么都不做
/// （避免每 60 秒白设一次窗口标题）。
pub fn refresh(app: &AppHandle) {
    let now = crate::db::now();
    // round64（C10）：当前任务提示开关（默认开）—— 关掉则两个落点都回默认
    let (hint, on) = {
        let state = app.state::<crate::AppState>();
        let guard = match state.db.lock() {
            Ok(guard) => guard,
            Err(e) => {
                eprintln!("[hint] 数据库锁失效：{e}");
                return;
            }
        };
        let on = crate::features::enabled(&guard, crate::features::CURRENT_HINT);
        let hint = if on {
            match crate::db::current_block_hint(&guard, now) {
                Ok(hint) => hint,
                Err(e) => {
                    eprintln!("[hint] 查询当前块失败：{e}");
                    return;
                }
            }
        } else {
            None
        };
        (hint, on)
    };
    let title = gated_title(hint.as_ref(), now, on);
    if !on {
        // 关掉：清掉悬停正文（回状态自己的文案）+ 标题回默认
        if crate::tray::set_tooltip_hint(app, String::new()) {
            eprintln!("[hint] 已关闭（开关）→ {title}");
        }
        set_window_title(app, &title);
        return;
    }
    let body = hint
        .as_ref()
        .map(|h| format_body(h, now))
        .unwrap_or_default();
    // 先更新托盘正文（它会自己判重并排队重画）；没变就说明标题也不用动
    if !crate::tray::set_tooltip_hint(app, body) {
        return;
    }
    eprintln!("[hint] 一行提示 → {title}");
    set_window_title(app, &title);
}

/// round64（C10）：开关关掉时标题必须回默认（开关的纯判定，好测）
pub(crate) fn gated_title(hint: Option<&CurrentHint>, now: i64, on: bool) -> String {
    if on {
        format_title(hint, now)
    } else {
        DEFAULT_TITLE.to_string()
    }
}

/// 窗口标题：统一走「main」窗口；窗口不在（单测 / 无窗口环境）就静默。
fn set_window_title(app: &AppHandle, title: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(e) = window.set_title(title) {
        eprintln!("[hint] 设置窗口标题失败：{e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hint(title: &str, end_at: i64) -> CurrentHint {
        CurrentHint {
            title: title.to_string(),
            end_at,
        }
    }

    #[test]
    fn test_no_current_block_falls_back_to_title() {
        assert_eq!(format_title(None, 1_700_000_000), "WakeyWeeky");
    }

    /// round64（C10）：开关关掉后标题也回默认（托盘正文由 refresh 清空）
    #[test]
    fn test_gated_title_respects_switch() {
        let h = hint("写周报", 1_700_000_000 + 1800);
        assert_eq!(
            gated_title(Some(&h), 1_700_000_000, false),
            "WakeyWeeky",
            "关掉 → 不管有没有当前块，标题都是默认"
        );
        assert_eq!(
            gated_title(Some(&h), 1_700_000_000, true),
            format_title(Some(&h), 1_700_000_000),
            "开着 → 与原来完全一致"
        );
    }

    #[test]
    fn test_minutes_and_last_minute() {
        let now = 1_700_000_000;
        assert_eq!(
            format_body(&hint("写周报", now + 23 * 60), now),
            "写周报 · 还剩 23 分"
        );
        // 窗口标题 = 正文 + 应用名（round62 你拍板的格式）
        assert_eq!(
            format_title(Some(&hint("写周报", now + 23 * 60)), now),
            "写周报 · 还剩 23 分 — WakeyWeeky"
        );
        // 向上取整：61 秒 → 2 分（宁可多说一分钟，不显示 0 分）
        assert_eq!(
            format_body(&hint("写周报", now + 61), now),
            "写周报 · 还剩 2 分"
        );
        // 最后一分钟：即将结束（0 秒与 60 秒都算）
        assert_eq!(
            format_body(&hint("写周报", now + 60), now),
            "写周报 · 即将结束"
        );
        assert_eq!(format_body(&hint("写周报", now), now), "写周报 · 即将结束");
        // 已过 end：saturating_sub 到 0，同样说即将结束（下一轮判定就会把它摘掉）
        assert_eq!(
            format_body(&hint("写周报", now - 10), now),
            "写周报 · 即将结束"
        );
    }

    #[test]
    fn test_hours_and_days() {
        let now = 1_700_000_000;
        assert_eq!(
            format_body(&hint("读书", now + 3600), now),
            "读书 · 还剩 1 小时"
        );
        assert_eq!(
            format_body(&hint("读书", now + 3660), now),
            "读书 · 还剩 1 小时 1 分"
        );
        assert_eq!(
            format_body(&hint("读书", now + 86_400), now),
            "读书 · 还剩 1 天"
        );
        assert_eq!(
            format_body(&hint("读书", now + 90_000), now),
            "读书 · 还剩 1 天 1 小时"
        );
        // 23 小时 59 分仍是小时档
        assert_eq!(
            format_body(&hint("读书", now + 86_340), now),
            "读书 · 还剩 23 小时 59 分"
        );
    }
}
