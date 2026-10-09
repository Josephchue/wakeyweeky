//! round76（3.1a 底座视觉）：**外观三选的唯一后端实现**。
//!
//! 管三件事：
//! - 三个枚举键的**规范值域**（密度 / 深浅色 / 配色）—— 设置白名单的校验用它们，前端 `utils/appearance.ts`
//!   有同一份 TS 表；两边的**对齐**由 `tools/visual/spacing-audit.mjs --check` 的「跨语言清单对齐」
//!   逐项盯着（round85 · 6b P2 补的 **真护栏**：以前这里只写着「由预览断言盯着」，而全仓并没有那条断言）。
//! - 窗口主题：`set_theme(None | Light | Dark)` —— 这会把 **WebView2 的偏好一起改掉**
//!   （wry 用的就是 `SetPreferredColorScheme`），所以 CSS 那边一条 `prefers-color-scheme` 就吃满三档，
//!   前端不需要自己解析系统主题。官方支持、**不引新依赖**（round75 `深-04`）。
//! - 两个「只管颜色」的开关键（层条上色 / 分类底边条）—— 它们的语义写在 `docs/visual/类别上色与纹理调研.md` §8.1：
//!   **只改颜色、不改任何功能**。
//!
//! round82（3.1c₂ · `淡-*`）：**夜间档**（`ui_theme = "night"`）—— 值与「夜间时段」共用一对
//! `night_start` / `night_end`（你 2026-10-06 拍）；Rust 只在**启动**与**设置改动后**按当前时刻解析
//! （否则首帧会闪一下亮色），运行中跨界由前端 60 秒节拍调 `refresh_window_theme` 回来重解析（`淡-05`）。

use rusqlite::Connection;
use tauri::Manager;

/// 字号密度：紧凑 / 舒适（默认）/ 宽松
pub const KEY_DENSITY: &str = "ui_density";
/// 深浅色：跟随系统（默认）/ 亮 / 暗
pub const KEY_THEME: &str = "ui_theme";
/// 配色：暖砂 A（默认）/ 冷白 B / 素灰绿 C
pub const KEY_PALETTE: &str = "ui_palette";
/// 层条上色（默认开；关掉 = 中性色，**条仍在**、功能不动）
pub const KEY_LAYER_BAR_COLOR: &str = "layer_bar_color";
/// 分类底边条（默认关；关掉 = 不画）
pub const KEY_CATEGORY_BAR: &str = "category_bar";
/// round77（3.1b）：图标集（五套；默认 Lucide）—— 只换画法，不改行为与 i18n 键
pub const KEY_ICON_SET: &str = "icon_set";
/// round77（3.1b）：块内第二行（`time` 默认 = 旧行为 / `remaining`）
pub const KEY_BLOCK_SECOND_LINE: &str = "block_second_line";
/// round87（3.3 字体方案）：界面字体族（五档系统字体；默认档 = 旧观感）
pub const KEY_FONT: &str = "ui_font";
/// round78（3.1b₂ · 设-01）：时间轴的「现在线」（**默认开** = 旧行为）
pub const KEY_NOW_LINE: &str = "now_line";
/// round82（3.1c₂ · `淡-07`）：非工作时段淡化开关（**默认开** —— 纯展示、可一眼关掉，按「默认值要礼貌」论证）
pub const KEY_NIGHT_DIM: &str = "night_dim";
/// round82（3.1c₂ · `淡-11`）：夜间时段起点（`"HH:MM"`，默认 22:00；与第四档主题共用）
pub const KEY_NIGHT_START: &str = "night_start";
/// round82（3.1c₂ · `淡-11`）：夜间时段终点（`"HH:MM"`，默认 06:00；起 > 止 = 跨天）
pub const KEY_NIGHT_END: &str = "night_end";

/// 密度档位（顺序 = 从紧到松）—— 与前端 `src/lib/utils/appearance.ts` 的 `DENSITIES` 必须逐字一致
pub const DENSITIES: [&str; 3] = ["compact", "comfortable", "loose"];
/// 深浅色档位 —— 与前端 `THEMES` 一致（round82：「按时间」第四档）
pub const THEMES: [&str; 4] = ["system", "light", "dark", "night"];
/// 配色档位（顺序 = 设置面板里的顺序）—— 与前端 `PALETTES` 一致
/// round85（0.31.0）：round84 的 9 套候选转内置（老 3 套 + 新 9 套 = 12）
pub const PALETTES: [&str; 12] = [
    "warm",
    "cool",
    "sage",
    "endfield",
    "terminal",
    "deepsea",
    "bauhaus",
    "artdeco",
    "cassette",
    "north",
    "brutal",
    "porcelain",
];
/// 图标集五套（顺序 = 设置面板里的顺序）—— 与前端 `ICON_SETS` 逐字一致
pub const ICON_SETS: [&str; 5] = ["lucide", "tabler", "phosphor", "bootstrap", "material"];
/// 块内第二行两档 —— 与前端 `SECOND_LINES` 逐字一致
pub const SECOND_LINES: [&str; 2] = ["time", "remaining"];
/// 界面字体族五档（round87）—— 与前端 `FONT_FAMILIES` 逐字一致（五档都是系统自带；拉丁先走 Segoe）
pub const FONT_FAMILIES: [&str; 5] = ["default", "song", "kai", "deng", "mono"];

/// 密度的默认档（= `comfortable`，你 2026-10-05 拍板）
pub const DEFAULT_DENSITY: &str = "comfortable";
/// 深浅色默认（= 跟随系统）
pub const DEFAULT_THEME: &str = "system";
/// 配色默认（= 暖砂 A）
pub const DEFAULT_PALETTE: &str = "warm";
/// 图标集默认（= Lucide，你 2026-10-05 拍板；其余四套也进产品）
pub const DEFAULT_ICON_SET: &str = "lucide";
/// 块内第二行默认（= 时间，即旧行为）
pub const DEFAULT_BLOCK_SECOND_LINE: &str = "time";
/// 界面字体族默认（= 默认档，即旧观感）
pub const DEFAULT_FONT_FAMILY: &str = "default";
/// 夜间时段默认（你 2026-10-07 拍：`淡-07`）—— 与前端 `NIGHT_START_DEFAULT` / `NIGHT_END_DEFAULT` 逐字一致
pub const NIGHT_START_DEFAULT: &str = "22:00";
pub const NIGHT_END_DEFAULT: &str = "06:00";

/// 枚举键规范化：合法值原样返回，缺省 / 坏值回默认（**不报错** —— 旧库读得回来）
pub fn normalize(choices: &[&str], default: &str, raw: &str) -> String {
    let v = raw.trim();
    if choices.contains(&v) {
        v.to_string()
    } else {
        default.to_string()
    }
}

// ---------------------------------------------------------------- round82：「夜间时段」（淡-*）

/// 夜间时段归一：`9:5` → `09:05`；坏值 → 该端的默认值（与 `notify::parse_hhmm` 同口径）
pub fn normalize_hhmm(raw: &str, default: &str) -> String {
    let (h, m) = crate::notify::parse_hhmm(raw)
        .or_else(|| crate::notify::parse_hhmm(default))
        .unwrap_or((22, 0));
    format!("{h:02}:{m:02}")
}

/// `"HH:MM"` → 一天内的分钟数（坏值 → 默认值那一端）
fn minutes_of(hhmm: &str, default: &str) -> i64 {
    let (h, m) = crate::notify::parse_hhmm(hhmm)
        .or_else(|| crate::notify::parse_hhmm(default))
        .unwrap_or((22, 0));
    i64::from(h) * 60 + i64::from(m)
}

/// 当前本地时刻的分钟数（0–1439）
pub fn now_minutes() -> i64 {
    use chrono::{Local, Timelike};
    let now = Local::now();
    i64::from(now.hour()) * 60 + i64::from(now.minute())
}

/// 夜里吗（`淡-06` 四条边界）：`[start, end)` —— `start == end` = 退化（不淡）；`start > end` = 跨天
pub fn in_night_window(now_minutes: i64, start: &str, end: &str) -> bool {
    let s = minutes_of(start, NIGHT_START_DEFAULT);
    let e = minutes_of(end, NIGHT_END_DEFAULT);
    if s == e {
        return false;
    }
    if s < e {
        now_minutes >= s && now_minutes < e
    } else {
        now_minutes >= s || now_minutes < e
    }
}

/// `ui_theme` 的存储值 → 窗口主题（`None` = 跟随系统）；`night` 档由调用方按当前时刻解析（`淡-04`）
pub fn resolve_window_theme(value: &str, night_now: bool) -> Option<tauri::Theme> {
    match value.trim() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        "night" => Some(if night_now {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }),
        _ => None,
    }
}

/// 从库里读「深浅色 + 夜间时段」并按**当前时刻**解析后落窗口主题。
/// 一个入口服务三处：启动（lib.rs 已有 conn）· 设置副作用（改档位 / 改时段）· 前端节拍刷新（`淡-05`）。
pub fn sync_window_theme(app: &tauri::AppHandle, conn: &Connection) {
    let value = crate::db::get_setting(conn, KEY_THEME)
        .ok()
        .flatten()
        .unwrap_or_default();
    let start = crate::db::get_setting(conn, KEY_NIGHT_START)
        .ok()
        .flatten()
        .unwrap_or_default();
    let end = crate::db::get_setting(conn, KEY_NIGHT_END)
        .ok()
        .flatten()
        .unwrap_or_default();
    apply_window_theme(app, &value, in_night_window(now_minutes(), &start, &end));
}

/// 把设置里的深浅色搬到窗口上（`system` → `None` = 跟随系统；`night` 由 `night_now` 解析）
pub fn apply_window_theme(app: &tauri::AppHandle, value: &str, night_now: bool) {
    let theme = resolve_window_theme(value, night_now);
    if let Some(win) = app.get_webview_window("main") {
        if let Err(e) = win.set_theme(theme) {
            // 不拦启动 / 不拦写入：CSS 那边本来就已经切了，最多是窗口边框慢半拍
            eprintln!("[appearance] set_theme({:?}) 失败（忽略）：{e}", value.trim());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 值域表逐条 —— 键名与前端 TS 表对齐由预览断言盯（这里只钉后端自己的语义）
    #[test]
    fn test_choices_and_defaults() {
        assert_eq!(DENSITIES, ["compact", "comfortable", "loose"]);
        assert_eq!(THEMES, ["system", "light", "dark", "night"]);
        assert_eq!(PALETTES.len(), 12, "老 3 套 + round85 的 9 套内置主题");
        assert_eq!(PALETTES[0], "warm");
        assert_eq!(PALETTES[2], "sage");
        assert_eq!(PALETTES[3], "endfield");
        assert_eq!(PALETTES[11], "porcelain");
        assert!(DENSITIES.contains(&DEFAULT_DENSITY));
        assert!(THEMES.contains(&DEFAULT_THEME));
        assert!(PALETTES.contains(&DEFAULT_PALETTE));
        // round77（3.1b）：图标集 / 块内第二行
        assert_eq!(ICON_SETS, ["lucide", "tabler", "phosphor", "bootstrap", "material"]);
        assert_eq!(SECOND_LINES, ["time", "remaining"]);
        assert!(ICON_SETS.contains(&DEFAULT_ICON_SET));
        assert!(SECOND_LINES.contains(&DEFAULT_BLOCK_SECOND_LINE));
    }

    /// 规范化：合法原样 / 带空白也认 / 坏值回默认
    #[test]
    fn test_normalize_falls_back() {
        assert_eq!(normalize(&DENSITIES, DEFAULT_DENSITY, " loose "), "loose");
        assert_eq!(normalize(&DENSITIES, DEFAULT_DENSITY, "宽松"), DEFAULT_DENSITY);
        assert_eq!(normalize(&DENSITIES, DEFAULT_DENSITY, ""), DEFAULT_DENSITY);
        assert_eq!(normalize(&THEMES, DEFAULT_THEME, "dark"), "dark");
        assert_eq!(normalize(&THEMES, DEFAULT_THEME, "DARK"), DEFAULT_THEME, "大小写敏感");
        assert_eq!(normalize(&PALETTES, DEFAULT_PALETTE, "sage"), "sage");
        assert_eq!(normalize(&PALETTES, DEFAULT_PALETTE, "warm2"), DEFAULT_PALETTE);
        // round85：新 9 套逐个合法（大小写敏感照旧）
        for p in PALETTES.iter().skip(3) {
            assert_eq!(normalize(&PALETTES, DEFAULT_PALETTE, p), *p);
        }
        assert_eq!(normalize(&PALETTES, DEFAULT_PALETTE, "North"), DEFAULT_PALETTE);
        // round77：图标集与第二行同口径
        assert_eq!(normalize(&ICON_SETS, DEFAULT_ICON_SET, " tabler "), "tabler");
        assert_eq!(normalize(&ICON_SETS, DEFAULT_ICON_SET, "lucide2"), DEFAULT_ICON_SET);
        assert_eq!(normalize(&SECOND_LINES, DEFAULT_BLOCK_SECOND_LINE, "remaining"), "remaining");
        assert_eq!(normalize(&SECOND_LINES, DEFAULT_BLOCK_SECOND_LINE, ""), DEFAULT_BLOCK_SECOND_LINE);
        // round82：第四档也是合法值（不是“坏值回默认”）
        assert_eq!(normalize(&THEMES, DEFAULT_THEME, "night"), "night");
        assert_eq!(DEFAULT_THEME, "system", "默认仍是跟随系统（旧行为逐字节一致）");
    }

    /// round82（淡-06）：夜间时段的**四条边界**（普通 / 跨天 / 起=止 / 坏值回落）—— 与前端 `appearance.test.ts` 同一套用例
    #[test]
    fn test_night_window_boundaries() {
        // ① 普通区间（09:00–17:00）：左闭右开
        assert!(!in_night_window(8 * 60 + 59, "09:00", "17:00"));
        assert!(in_night_window(9 * 60, "09:00", "17:00"));
        assert!(in_night_window(16 * 60 + 59, "09:00", "17:00"));
        assert!(!in_night_window(17 * 60, "09:00", "17:00"));
        // ② 跨天（默认 22:00–06:00）：22:00 进 / 06:00 出 / 中午不在
        assert!(in_night_window(22 * 60, NIGHT_START_DEFAULT, NIGHT_END_DEFAULT));
        assert!(in_night_window(23 * 60 + 59, NIGHT_START_DEFAULT, NIGHT_END_DEFAULT));
        assert!(in_night_window(0, NIGHT_START_DEFAULT, NIGHT_END_DEFAULT));
        assert!(in_night_window(5 * 60 + 59, NIGHT_START_DEFAULT, NIGHT_END_DEFAULT));
        assert!(!in_night_window(6 * 60, NIGHT_START_DEFAULT, NIGHT_END_DEFAULT));
        assert!(!in_night_window(21 * 60 + 59, NIGHT_START_DEFAULT, NIGHT_END_DEFAULT));
        // ③ 起 = 止 = 退化（全天不淡）
        for m in [0, 8 * 60, 12 * 60, 23 * 60 + 59] {
            assert!(!in_night_window(m, "08:00", "08:00"));
        }
        // ④ 坏值 → 回落默认（默认 22:00–06:00）：空串 / 垃圾串都当默认档
        assert!(in_night_window(23 * 60, "", ""));
        assert!(!in_night_window(12 * 60, "25:00", "06:00"));
        assert!(in_night_window(23 * 60, "25:00", "06:00"));
    }

    /// round82（淡-04）：存储值 → 窗口主题的映射（`night` 按当前时刻两态）
    #[test]
    fn test_resolve_window_theme() {
        assert!(resolve_window_theme("system", true).is_none());
        assert!(resolve_window_theme("system", false).is_none());
        assert!(resolve_window_theme("", false).is_none());
        assert!(resolve_window_theme("bogus", false).is_none());
        assert_eq!(resolve_window_theme("light", true), Some(tauri::Theme::Light));
        assert_eq!(resolve_window_theme("dark", false), Some(tauri::Theme::Dark));
        assert_eq!(resolve_window_theme("night", true), Some(tauri::Theme::Dark));
        assert_eq!(resolve_window_theme("night", false), Some(tauri::Theme::Light));
    }

    /// round82（淡-11）：时段归一（宽容解析 + 零填充；坏值回默认）
    #[test]
    fn test_normalize_hhmm() {
        assert_eq!(normalize_hhmm("9:5", NIGHT_START_DEFAULT), "09:05");
        assert_eq!(normalize_hhmm(" 22:00 ", NIGHT_START_DEFAULT), "22:00");
        assert_eq!(normalize_hhmm("", NIGHT_START_DEFAULT), NIGHT_START_DEFAULT);
        assert_eq!(normalize_hhmm("25:00", NIGHT_END_DEFAULT), NIGHT_END_DEFAULT);
        assert_eq!(normalize_hhmm("垃圾", NIGHT_START_DEFAULT), NIGHT_START_DEFAULT);
    }
}
