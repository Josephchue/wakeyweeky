//! v2 ④ 的设置命令（`get_settings` / `set_setting`）—— 一直到 round44 才做（C6 的预算要能改）。
//!
//! 纪律（照 v2 ④ 的「键值对，**只存已知键**」）：
//! - **白名单**以 `KNOWN_KEYS` 为准（共 **53** 键：理智值两个 + 提醒七个（开始 / 结束 / 开始提前 / 复盘到点动作 / 提醒时刻 / 免打扰截止 + 明早时刻）+ C13 计划开关 + Backlog 栏宽 + 视图记忆三个 + **round64 的 15 个功能开关 + round66 的全局快捷键** + **round67 的外观 / 布局三个**（面板形态 / 隐藏周末 / 键位提示栏；16 布尔 + 模板建议 JSON，默认全开，见 `crate::features`）+ **round68 的成就两键**（默认开）+ **round69 的每周重复开关** + **round74 的语言键**（`ui_locale`，默认中文）+ **round76 的外观五件**（密度 / 深浅色 / 配色 / 层条上色 / 分类底边条，见 `crate::appearance`）+ **round77 的两键**（图标集 `icon_set` / 块内第二行 `block_second_line`）+ **round78 的现在线**（`now_line`）+ **round80 的模板预览**（`template_preview`，默认开）+ **round81 的时间 / 日期两键**（`time_format` / `date_format`，默认 system，见 `crate::datetime`）+ **时间刻度**（`slot_height`，默认 auto = 跟密度）+ **round82 的夜间三键**（`night_dim` / `night_start` / `night_end`，第四档主题与淡化带共用）+ **round82 的键位覆盖**（`key_bindings`，用户改的快捷键；逐条回落在前端）。
//!   别把 `settings` 表当通用键值库用 —— 那样谁都能往里塞垃圾（而且写错键名不会报错）。
//! - 值按键校验（开关只认 `0`/`1`、预算 60–1440 的整数、JSON 键过结构）—— 非法值返回中文错误、**不落库**。
//! - 读的时候把**默认值**填好（前端不必知道默认是多少）。。

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{Manager, State};

use crate::db;
use crate::datetime;
use crate::features;
use crate::appearance;
use crate::review::{self, KEY_ACTION, KEY_REMIND_AT};
use crate::sanity::{self, KEY_BUDGET, KEY_ENABLED};
use crate::AppState;
use crate::i18n;
use crate::tf;

/// C13 的「提醒计划」开关（托盘菜单在写它，`notify.rs` 在读它）
pub const KEY_SCHEDULER: &str = "scheduler_enabled";
/// round45（0.8.1）：Backlog 栏宽（像素；拖分隔条写它）
pub const KEY_BACKLOG_WIDTH: &str = "backlog_width";
/// round49：**开始提醒**开关（用户 2026-10-03：「开始提醒与结束提醒我都想在设置页设个开关」）
pub const KEY_REMIND_START: &str = "remind_start";
/// round49：**结束提醒**开关（原来那条「到点了」；默认开）。
/// round63（C18）修正：它以前**从来没人读过**（只有本文件提到）—— 勾掉也照样响；现在 `notify::due_ends` 在读。
pub const KEY_REMIND_END: &str = "remind_end";
/// round63（C18 / R41）：免打扰截止时刻（Unix 秒；`0` = 没静音）
pub const KEY_QUIET_UNTIL: &str = crate::notify::QUIET_UNTIL_KEY;
/// round63（C18 / R41）：「到明早」的时刻（`"HH:MM"`，默认 08:00）
pub const KEY_QUIET_MORNING: &str = crate::notify::QUIET_MORNING_KEY;
/// round63（C18 / R49）：开始提醒提前 N 分钟（`0` / `5` / `10` / `15` / `30`）
pub const KEY_REMIND_LEAD: &str = "remind_lead_minutes";
/// round63（C18 / R48）：Backlog 筛选（JSON：`{"kind":"all"|"uncat"|"cat","name"?}`）
pub const KEY_BACKLOG_FILTER: &str = "backlog_filter";
/// round63（C18 / R48）：Backlog 分组开关
pub const KEY_BACKLOG_GROUPED: &str = "backlog_grouped";
/// round63（C18 / R48）：Backlog 收起的分类（JSON 字符串数组）
pub const KEY_BACKLOG_COLLAPSED: &str = "backlog_collapsed";
/// round67：Backlog 面板形态（`"open"` / `"rail"`）—— 当前是展开还是收起成细轨（round67.2：「整栏隐藏」档已删）
pub const KEY_BACKLOG_PANE: &str = "backlog_pane";
/// round67：隐藏周六、周日两列（`"1"` = 只看工作日 5 列）
pub const KEY_WEEKEND_HIDDEN: &str = "weekend_hidden";
/// round67：键位提示栏显示策略（`"always"` / `"hidden"`；round67.1 按用户实测删掉了「按需」档）
pub const KEY_HINT_BAR_MODE: &str = "hint_bar_mode";
/// round80（79-02）：模板面板旁的**迷你周视图**（`"1"` 默认开 = 画；关掉 = 旧行为只列列表）
pub const KEY_TEMPLATE_PREVIEW: &str = "template_preview";
/// round81（3.1c₁ · 宽-04）：时间刻度档位（格高 px）—— `"auto"` 跟密度；手动档 26 / 28 / 30 / 32 / 34
pub const KEY_SLOT_HEIGHT: &str = "slot_height";
/// round82（3.1c₂ · 绑-08）：用户键位覆盖（JSON：动作 id → 组合串）—— 命令表在前端，这里只保证「是对象、值是短串」
pub const KEY_BINDINGS: &str = "key_bindings";

/// round68（19.1）：成就（暗章）—— 默认开（round85 起唯一版本恒可用，以前那个「不靠默认关隐藏」的 Lite 分支已删）
pub const KEY_ACHIEVEMENTS: &str = crate::achievements::SETTING_KEY;
/// round68（19.1）：点亮时弹一条短提示（默认开）
pub const KEY_ACHIEVEMENT_TOAST: &str = crate::achievements::TOAST_KEY;
/// 栏宽范围（与前端 `ui.svelte.ts` 的夹子同一个值；两边都挡一道）
pub const MIN_BACKLOG_WIDTH: i64 = 180;
pub const MAX_BACKLOG_WIDTH: i64 = 520;

/// 允许前端读写的键（白名单；`get_settings` 只会返回这里的键）
/// round57（0.13.0）：`review_remind`（旧开关）退役，换成三选一 `review_action` —— 键数不变（8）。
/// round63（C18）：+6 键（免打扰两个 / 开始提醒提前 / 视图记忆三个）→ **14**。
/// round64（C10）：+15 键（二期功能开关，默认全开）→ **29**。
/// round66（C12）：+1 键（全局快捷键，默认开）→ **30**。
/// round67：+4 键（外观 / 布局）→ **34**；round67.2（你 2026-10-05）：删「整栏隐藏」→ **33**。
/// round68（19.1）：+2 键（成就 / 成就提示）→ **35**。
/// round69（B3）：+1 键（每周重复开关，默认开）→ **36**。
/// round74（3.0b₂）：+1 键（语言 `ui_locale`，默认中文）→ **37**。
/// round76（3.1a）：+5 键（外观五件：密度 / 深浅色 / 配色 / 层条上色 / 分类底边条）→ **42**。
/// round77（3.1b）：+2 键（图标集 `icon_set` / 块内第二行 `block_second_line`）→ **44**。
/// round78（3.1b₂）：+1 键（现在线 `now_line`，默认开）→ **45**。
/// round80（79-02）：+1 键（模板预览 `template_preview`，默认开）→ **46**。
/// round82（3.1c₂）：+3 键（夜间淡化 `night_dim` 默认开 · 夜间时段 `night_start` / `night_end`，默认 22:00 / 06:00）+1 键（键位覆盖 `key_bindings`）→ **53**。
/// round87（3.3 字体方案）：+1 键（界面字体族 `ui_font`，默认档 = 旧观感）→ **54**。
pub const KNOWN_KEYS: [&str; 54] = [
    KEY_BUDGET,
    KEY_ENABLED,
    KEY_SCHEDULER,
    KEY_BACKLOG_WIDTH,
    KEY_REMIND_START,
    KEY_REMIND_END,
    KEY_ACTION,
    KEY_REMIND_AT,
    KEY_QUIET_UNTIL,
    KEY_QUIET_MORNING,
    KEY_REMIND_LEAD,
    KEY_BACKLOG_FILTER,
    KEY_BACKLOG_GROUPED,
    KEY_BACKLOG_COLLAPSED,
    // round67：外观 / 布局三个（默认：展开 / 显示周末 / 常显）
    KEY_BACKLOG_PANE,
    KEY_WEEKEND_HIDDEN,
    KEY_HINT_BAR_MODE,
    // round64（C10）：15 个功能开关（默认全开；键名唯一实现在 `crate::features`）
    features::HINTS,
    features::KEYBOARD,
    features::MULTI_SELECT,
    features::SEQUENCES,
    features::DRIFT,
    features::REMNANTS,
    features::MERGE,
    features::RESIZE,
    features::TEMP_BLOCK,
    features::TEMPLATES,
    features::TEMPLATE_SUGGEST,
    features::REVIEW,
    features::STATS,
    features::TRAY_STATE,
    features::CURRENT_HINT,
    features::HOTKEYS,
    // round69（B3）：每周重复（默认开；关掉 = 不生成，已有规则/块保留）
    features::REPEAT,
    // round68（19.1）：成就两键（默认开）
    KEY_ACHIEVEMENTS,
    KEY_ACHIEVEMENT_TOAST,
    // round74（3.0b₂）：语言（默认中文；只认 zh / en）
    i18n::KEY,
    // round76（3.1a）：外观五件（密度 / 深浅色 / 配色 / 层条上色 / 分类底边条）
    appearance::KEY_DENSITY,
    appearance::KEY_THEME,
    appearance::KEY_PALETTE,
    appearance::KEY_LAYER_BAR_COLOR,
    appearance::KEY_CATEGORY_BAR,
    // round77（3.1b）：图标集（五套，默认 Lucide）+ 块内第二行（默认时间 = 旧行为）
    appearance::KEY_ICON_SET,
    appearance::KEY_BLOCK_SECOND_LINE,
    // round87（3.3 字体方案）：界面字体族（五档系统字体，默认档 = 旧观感）
    appearance::KEY_FONT,
    // round78（3.1b₂）：现在线（默认开 = 旧行为）
    appearance::KEY_NOW_LINE,
    // round80（79-02）：模板预览（默认开 = 旧行为）
    KEY_TEMPLATE_PREVIEW,
    // round81（3.1c₁）：时间 / 日期格式（默认 system = 跟随系统；纯展示项）+ 时间刻度
    datetime::KEY_TIME_FORMAT,
    datetime::KEY_DATE_FORMAT,
    KEY_SLOT_HEIGHT,
    // round82（3.1c₂ · 淡-*）：夜间淡化开关 + 夜间时段（第四档主题与淡化带共用）
    appearance::KEY_NIGHT_DIM,
    appearance::KEY_NIGHT_START,
    appearance::KEY_NIGHT_END,
    // round82（3.1c₂ · 绑-08）：用户键位覆盖（JSON）
    KEY_BINDINGS,
];

/// 开始提醒提前的可选档位（分钟；0 = 到点提醒 —— 界面上写「到点」）
pub const REMIND_LEAD_CHOICES: [i64; 5] = [0, 5, 10, 15, 30];

/// `backlog_filter` 的规范形态（非法 → `None`）—— 三种：全部 / 未分类 / 某个分类
fn normalize_backlog_filter(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    match value.get("kind")?.as_str()? {
        "all" => Some("{\"kind\":\"all\"}".to_string()),
        "uncat" => Some("{\"kind\":\"uncat\"}".to_string()),
        "cat" => {
            let name = value.get("name")?.as_str()?.trim();
            if name.is_empty() || name.chars().count() > 60 {
                return None;
            }
            serde_json::to_string(&serde_json::json!({"kind": "cat", "name": name})).ok()
        }
        _ => None,
    }
}

/// 模板建议（`features::TEMPLATE_SUGGEST`）的默认值：开 · 满 7 天 · 完成 ≥5 次
/// （门限的理由与调研见 `docs/plans/round64-c10-c11.md` §1.4 / T9）
pub const TEMPLATE_SUGGEST_DEFAULT: &str = "{\"enabled\":true,\"days\":7,\"done\":5}";

/// `template_suggest` 的规范形态：`{enabled:bool, days:1..365, done:0..1000}`（非法 → `None`）
fn normalize_template_suggest(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let enabled = value.get("enabled")?.as_bool()?;
    let days = value.get("days")?.as_i64()?;
    let done = value.get("done")?.as_i64()?;
    if !(1..=365).contains(&days) || !(0..=1000).contains(&done) {
        return None;
    }
    serde_json::to_string(&serde_json::json!({ "enabled": enabled, "days": days, "done": done })).ok()
}

/// round82（3.1c₂ · 绑-08）：键位覆盖的**结构校验** —— 对象、值全是短字符串、条目有限。
/// 「未知 id / 坏串逐条回落」在前端（命令表是前端唯一一份）；这里只挡垃圾。
fn normalize_key_bindings(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = value.as_object()?;
    if obj.len() > 32 {
        return None;
    }
    let mut out = serde_json::Map::new();
    for (id, combo) in obj {
        let combo = combo.as_str()?;
        if id.is_empty() || id.chars().count() > 40 || combo.chars().count() > 40 {
            return None;
        }
        out.insert(id.clone(), serde_json::Value::String(combo.to_string()));
    }
    serde_json::to_string(&serde_json::Value::Object(out)).ok()
}

/// round81（3.1c₁ · 宽-04）：时间刻度档位（`auto` 或 18–64 的偶数）—— **读与写共用这一条**：
/// round82 的 11.6 把范围扩到 18–64 时读取端已放宽、写入端忘了跟 → 真机把缩放调到 18–24 / 36–64 会被拒写；
/// 现在两边都读这里（同一条实现，不会再漂）。
fn normalize_slot_height(raw: &str) -> Option<String> {
    let t = raw.trim();
    let px: Option<i64> = t.parse().ok();
    if t == "auto" || px.is_some_and(|p| (18..=64).contains(&p) && p % 2 == 0) {
        Some(t.to_string())
    } else {
        None
    }
}

/// `backlog_collapsed` 的规范形态：字符串数组（去重、每项非空且 ≤60 字、最多 100 项）
fn normalize_backlog_collapsed(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let items = value.as_array()?;
    if items.len() > 100 {
        return None;
    }
    let mut names: Vec<String> = Vec::new();
    for item in items {
        let name = item.as_str()?.trim();
        if name.is_empty() || name.chars().count() > 60 {
            return None;
        }
        if !names.iter().any(|n| n == name) {
            names.push(name.to_string());
        }
    }
    serde_json::to_string(&names).ok()
}

/// 设置项：键 → **生效值**（缺省时给默认值）
#[derive(Debug, Clone, Serialize)]
pub struct Settings {
    pub values: BTreeMap<String, String>,
}

/// 读全部已知键的生效值
pub fn get_settings_impl(conn: &Connection) -> Result<Settings, String> {
    let mut values = BTreeMap::new();
    for key in KNOWN_KEYS {
        let stored = db::get_setting(conn, key)?.unwrap_or_default();
        let effective = match key {
            KEY_BUDGET => {
                let minutes = sanity::budget_minutes(conn);
                minutes.to_string() // 非法/缺省都已经在 budget_minutes 里回退并夹好范围
            }
            KEY_ENABLED => {
                if sanity::enabled(conn) { "1" } else { "0" }.to_string()
            }
            KEY_SCHEDULER => {
                // round63（C18）默认值翻面：只有显式存过 1 才算开（读法唯一实现在 `notify::scheduler_enabled`）
                if crate::notify::scheduler_enabled(conn) { "1" } else { "0" }.to_string()
            }
            KEY_REMIND_START | KEY_REMIND_END => {
                if stored.trim() == "0" { "0" } else { "1" }.to_string() // 默认开（与 notify.rs 一致）
            }
            KEY_ACTION => review::action_setting(conn).to_string(), // 默认 hint；旧 review_remind 兼容读
            KEY_REMIND_AT => {
                // 默认 `sun 20:00`；非法值回退默认（解析规则在 review.rs，只有一份）
                review::parse_remind_at(&stored)
                    .map(|at| at.text())
                    .unwrap_or_else(|| review::DEFAULT_REMIND_AT.to_string())
            }
            KEY_BACKLOG_WIDTH => {
                // 默认 260 = `tokens.css` 里的 `--backlog-width`；非法值由前端夹一次
                stored
                    .trim()
                    .parse::<i64>()
                    .ok()
                    .filter(|v| (MIN_BACKLOG_WIDTH..=MAX_BACKLOG_WIDTH).contains(v))
                    .unwrap_or(260)
                    .to_string()
            }
            // round63（C18）免打扰：截止时刻读后端口径（0 = 没静音）；「明早」回规范写法
            KEY_QUIET_UNTIL => crate::notify::quiet_until(conn).to_string(),
            KEY_QUIET_MORNING => {
                let (h, m) = crate::notify::quiet_morning(conn);
                format!("{h:02}:{m:02}")
            }
            KEY_REMIND_LEAD => stored
                .trim()
                .parse::<i64>()
                .ok()
                .filter(|v| REMIND_LEAD_CHOICES.contains(v))
                .unwrap_or(0)
                .to_string(),
            KEY_BACKLOG_FILTER => {
                normalize_backlog_filter(&stored).unwrap_or_else(|| "{\"kind\":\"all\"}".to_string())
            }
            KEY_BACKLOG_GROUPED => {
                if stored.trim() == "1" { "1" } else { "0" }.to_string()
            }
            KEY_BACKLOG_COLLAPSED => normalize_backlog_collapsed(&stored).unwrap_or_else(|| "[]".to_string()),
            // round67：外观 / 布局三键 —— 坏值 / 缺省一律回默认（读法唯一实现就在这）
            // round67.2（你 2026-10-05）：「整栏隐藏」档删了 —— 旧库存过 hidden 读回 rail
            KEY_BACKLOG_PANE => {
                if matches!(stored.trim(), "rail" | "hidden") { "rail" } else { "open" }.to_string()
            }
            KEY_WEEKEND_HIDDEN => {
                if stored.trim() == "1" { "1" } else { "0" }.to_string()
            }
            // round67.1：「按需」档删了 —— 旧库存过 on-demand 也读回 always
            KEY_HINT_BAR_MODE => {
                if stored.trim() == "hidden" { "hidden" } else { "always" }.to_string()
            },
            // round68（19.1）：成就两键 —— 默认开（只有显式 "0" 才关）
            KEY_ACHIEVEMENTS | KEY_ACHIEVEMENT_TOAST => {
                if stored.trim() != "0" { "1" } else { "0" }.to_string()
            }
            // round74（3.0b₂）：语言 —— 只认 zh / en；旧库缺省 / 非法值都读回 zh（= 旧行为）
            // round81（3.1c₁ · 深-03）：值域扩成 system / zh / en（读回的是**档位**，不是解析结果）
            i18n::KEY => i18n::normalize_choice(&stored).to_string(),
            // round76（3.1a）：外观五件 —— 枚举三键缺省 / 坏值回默认；层条上色默认开（只有显式 "0" 才关）；
            // 分类底边条默认关（只有显式 "1" 才开）—— 两个都是「只管颜色不管功能」（类别调研 §8.1）
            appearance::KEY_DENSITY => {
                appearance::normalize(&appearance::DENSITIES, appearance::DEFAULT_DENSITY, &stored)
            }
            appearance::KEY_THEME => {
                appearance::normalize(&appearance::THEMES, appearance::DEFAULT_THEME, &stored)
            }
            appearance::KEY_PALETTE => {
                appearance::normalize(&appearance::PALETTES, appearance::DEFAULT_PALETTE, &stored)
            }
            appearance::KEY_LAYER_BAR_COLOR => {
                if stored.trim() == "0" { "0" } else { "1" }.to_string()
            }
            appearance::KEY_CATEGORY_BAR => {
                if stored.trim() == "1" { "1" } else { "0" }.to_string()
            }
            // round78（3.1b₂）：现在线 —— 默认开（只有显式存的 `"0"` 才算关）
            appearance::KEY_NOW_LINE => {
                if stored.trim() == "0" { "0" } else { "1" }.to_string()
            }
            // round80（79-02）：模板预览开关 —— 只有显式 "0" 才算关（缺省/非法都当开，与现在线同口径）
            KEY_TEMPLATE_PREVIEW => {
                if stored.trim() == "0" { "0" } else { "1" }.to_string()
            }
            // round81（3.1c₁）：时间 / 日期格式 —— 缺省 / 坏值回默认 system（纯展示项，不报错）
            datetime::KEY_TIME_FORMAT => {
                datetime::normalize(&datetime::TIME_FORMATS, datetime::DEFAULT_TIME_FORMAT, &stored)
            }
            datetime::KEY_DATE_FORMAT => {
                datetime::normalize(&datetime::DATE_FORMATS, datetime::DEFAULT_DATE_FORMAT, &stored)
            }
            // round81（3.1c₁ · 宽-04）：时间刻度 —— auto / 18–64 的偶数；坏值回 auto
            KEY_SLOT_HEIGHT => normalize_slot_height(&stored).unwrap_or_else(|| "auto".to_string()),
            // round82（3.1c₂ · 淡-*）：夜间三键 —— 开关同布尔口径；时段归一成零填充 HH:MM
            appearance::KEY_NIGHT_DIM => {
                if stored.trim() == "0" { "0" } else { "1" }.to_string()
            }
            appearance::KEY_NIGHT_START => {
                appearance::normalize_hhmm(&stored, appearance::NIGHT_START_DEFAULT)
            }
            appearance::KEY_NIGHT_END => {
                appearance::normalize_hhmm(&stored, appearance::NIGHT_END_DEFAULT)
            }
            // round82（3.1c₂ · 绑-08）：键位覆盖 —— 缺键 / 坏 JSON / 结构不对 → 读回 `{}`（= 全默认）
            KEY_BINDINGS => normalize_key_bindings(&stored).unwrap_or_else(|| "{}".to_string()),
            // round77（3.1b）：图标集 / 块内第二行 —— 缺省 / 坏值回默认（与 i18n 那个键同口径：
            // 纯展示项，写坏值没必要报错，读回默认就行）
            appearance::KEY_ICON_SET => {
                appearance::normalize(&appearance::ICON_SETS, appearance::DEFAULT_ICON_SET, &stored)
            }
            appearance::KEY_BLOCK_SECOND_LINE => appearance::normalize(
                &appearance::SECOND_LINES,
                appearance::DEFAULT_BLOCK_SECOND_LINE,
                &stored,
            ),
            // round87（3.3）：界面字体族 —— 缺省 / 坏值回默认档（纯展示项，与上面同口径）
            appearance::KEY_FONT => appearance::normalize(
                &appearance::FONT_FAMILIES,
                appearance::DEFAULT_FONT_FAMILY,
                &stored,
            ),
            // round64（C10）：功能开关 —— **只有显式存的 `"0"` 才算关**（缺省/非法值都当开，与 `features::enabled` 同口径）
            k if features::KEYS.contains(&k) => {
                if stored.trim() == "0" { "0" } else { "1" }.to_string()
            }
            // round64（C10）：模板建议（JSON）—— 非法/缺省回默认
            features::TEMPLATE_SUGGEST => normalize_template_suggest(&stored)
                .unwrap_or_else(|| TEMPLATE_SUGGEST_DEFAULT.to_string()),
            _ => stored,
        };
        values.insert(key.to_string(), effective);
    }
    Ok(Settings { values })
}

/// 写一个已知键（校验键与值；不合法直接报错，绝不静默忽略）
pub fn set_setting_impl(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    if !KNOWN_KEYS.contains(&key) {
        return Err(tf!(i18n::msg::ERR_CMD_SETTINGS_01, key = key));
    }
    let v = value.trim();
    // round64（C10）：功能开关（16 个布尔）—— 值只认 0 / 1
    if features::KEYS.contains(&key) {
        if v != "0" && v != "1" {
            return Err(i18n::t(i18n::msg::ERR_CMD_SETTINGS_02).to_string());
        }
        return db::set_setting(conn, key, v);
    }
    match key {
        KEY_BUDGET => {
            let minutes: i64 = v
                .parse()
                .map_err(|_| i18n::t(i18n::msg::ERR_CMD_SETTINGS_03).to_string())?;
            if !(sanity::MIN_BUDGET_MINUTES..=sanity::MAX_BUDGET_MINUTES).contains(&minutes) {
                return Err(tf!(i18n::msg::ERR_CMD_SETTINGS_21, p1 = sanity::MIN_BUDGET_MINUTES, p2 = sanity::MAX_BUDGET_MINUTES));
            }
            db::set_setting(conn, key, &minutes.to_string())
        }
        KEY_ENABLED | KEY_SCHEDULER | KEY_REMIND_START | KEY_REMIND_END | KEY_WEEKEND_HIDDEN => {
            if v != "0" && v != "1" {
                return Err(i18n::t(i18n::msg::ERR_CMD_SETTINGS_04).to_string());
            }
            db::set_setting(conn, key, v)
        }
        // round68（19.1）：成就两键 —— 布尔
        KEY_ACHIEVEMENTS | KEY_ACHIEVEMENT_TOAST => {
            if v != "0" && v != "1" {
                return Err(i18n::t(i18n::msg::ERR_CMD_SETTINGS_06).to_string());
            }
            db::set_setting(conn, key, v)
        }
        KEY_ACTION => {
            if !matches!(v, "open" | "hint" | "off") {
                return Err(i18n::t(i18n::msg::ERR_CMD_SETTINGS_07).to_string());
            }
            db::set_setting(conn, key, v)
        }
        KEY_REMIND_AT => {
            let at = review::parse_remind_at(v)
                .ok_or_else(|| i18n::t(i18n::msg::ERR_CMD_SETTINGS_08).to_string())?;
            db::set_setting(conn, key, &at.text())
        }
        KEY_BACKLOG_WIDTH => {
            let px: i64 = v.parse().map_err(|_| i18n::t(i18n::msg::ERR_CMD_SETTINGS_09).to_string())?;
            if !(MIN_BACKLOG_WIDTH..=MAX_BACKLOG_WIDTH).contains(&px) {
                return Err(tf!(i18n::msg::ERR_CMD_SETTINGS_22, p1 = MIN_BACKLOG_WIDTH, p2 = MAX_BACKLOG_WIDTH));
            }
            db::set_setting(conn, key, &px.to_string())
        }
        // round63（C18 / R41）：免打扰截止（Unix 秒；0 = 取消静音）
        KEY_QUIET_UNTIL => {
            let ts: i64 = v
                .parse()
                .map_err(|_| i18n::t(i18n::msg::ERR_CMD_SETTINGS_10).to_string())?;
            if ts < 0 {
                return Err(i18n::t(i18n::msg::ERR_CMD_SETTINGS_11).to_string());
            }
            db::set_setting(conn, key, &ts.to_string())?;
            // round68（19.1）：暗章信号（面板里开过一次免打扰）
            if ts > 0 {
                if let Err(e) = crate::achievements::note(conn, "quiet") {
                    eprintln!("[achievements] 信号 quiet 失败（忽略）：{e}");
                }
            }
            Ok(())
        }
        // round63（C18 / R41）：「到明早」的时刻
        KEY_QUIET_MORNING => {
            let (h, m) = crate::notify::parse_hhmm(v)
                .ok_or_else(|| i18n::t(i18n::msg::ERR_CMD_SETTINGS_12).to_string())?;
            db::set_setting(conn, key, &format!("{h:02}:{m:02}"))
        }
        // round82（3.1c₂ · 淡-11）：夜间时段 —— 与「明早」同一套宽容解析（`9:5` 也收）并规范成 HH:MM
        appearance::KEY_NIGHT_START | appearance::KEY_NIGHT_END => {
            let (h, m) = crate::notify::parse_hhmm(v)
                .ok_or_else(|| i18n::t(i18n::msg::ERR_CMD_SETTINGS_27).to_string())?;
            db::set_setting(conn, key, &format!("{h:02}:{m:02}"))
        }
        // round82（3.1c₂ · 淡-07）：夜间淡化开关（同其它布尔键）
        appearance::KEY_NIGHT_DIM => {
            if v != "0" && v != "1" {
                return Err(i18n::t(i18n::msg::ERR_CMD_SETTINGS_04).to_string());
            }
            db::set_setting(conn, key, v)
        }
        // round82（3.1c₂ · 绑-08）：键位覆盖（JSON）—— 结构不对拒写（逐条回落在前端）
        KEY_BINDINGS => normalize_key_bindings(v)
            .ok_or_else(|| i18n::t(i18n::msg::ERR_CMD_SETTINGS_28).to_string())
            .and_then(|canonical| db::set_setting(conn, key, &canonical)),
        // round63（C18 / R49）：开始提醒提前的档位
        KEY_REMIND_LEAD => {
            let minutes: i64 = v
                .parse()
                .map_err(|_| i18n::t(i18n::msg::ERR_CMD_SETTINGS_13).to_string())?;
            if !REMIND_LEAD_CHOICES.contains(&minutes) {
                return Err(tf!(i18n::msg::ERR_CMD_SETTINGS_23, p1 = REMIND_LEAD_CHOICES
                        .iter()
                        .map(|m| m.to_string())
                        .collect::<Vec<_>>()
                        .join(" / ")));
            }
            db::set_setting(conn, key, &minutes.to_string())
        }
        // round63（C18 / R48）：Backlog 视图记忆三个键
        KEY_BACKLOG_FILTER => normalize_backlog_filter(v)
            .ok_or_else(|| i18n::t(i18n::msg::ERR_CMD_SETTINGS_14).to_string())
            .and_then(|canonical| db::set_setting(conn, key, &canonical)),
        KEY_BACKLOG_GROUPED => {
            if v != "0" && v != "1" {
                return Err(i18n::t(i18n::msg::ERR_CMD_SETTINGS_15).to_string());
            }
            db::set_setting(conn, key, v)
        }
        KEY_BACKLOG_COLLAPSED => normalize_backlog_collapsed(v)
            .ok_or_else(|| i18n::t(i18n::msg::ERR_CMD_SETTINGS_16).to_string())
            .and_then(|canonical| db::set_setting(conn, key, &canonical)),
        // round67：外观 / 布局 —— 枚举只认白名单值
        KEY_BACKLOG_PANE => {
            if !matches!(v, "open" | "rail") {
                return Err(i18n::t(i18n::msg::ERR_CMD_SETTINGS_17).to_string());
            }
            db::set_setting(conn, key, v)
        }
        KEY_HINT_BAR_MODE => {
            if !matches!(v, "always" | "hidden") {
                return Err(i18n::t(i18n::msg::ERR_CMD_SETTINGS_18).to_string());
            }
            db::set_setting(conn, key, v)
        }
        // round64（C10）：模板建议（JSON）—— 键要写全（enabled / days / done），门限在范围内
        features::TEMPLATE_SUGGEST => normalize_template_suggest(v)
            .ok_or_else(|| i18n::t(i18n::msg::ERR_CMD_SETTINGS_19).to_string())
            .and_then(|canonical| db::set_setting(conn, key, &canonical)),
        // round74（3.0b₂）：语言 —— 非法值规范成默认档，不报错（旧库 / 坏值都读得回来）
        // round81（3.1c₁ · 深-03）：默认档 = `system`（跟随系统）；`set_locale` 负责解析成实际语言
        i18n::KEY => db::set_setting(conn, key, i18n::normalize_choice(v)),
        // round76（3.1a）：外观五件 —— 枚举三键非法值拒评（前端控件只会送合法值）；两个开关只认 0/1
        appearance::KEY_DENSITY | appearance::KEY_THEME | appearance::KEY_PALETTE => {
            let choices: &[&str] = match key {
                appearance::KEY_DENSITY => &appearance::DENSITIES,
                appearance::KEY_THEME => &appearance::THEMES,
                _ => &appearance::PALETTES,
            };
            if !choices.contains(&v) {
                // 前端控件只会送合法值；到这里 = 坏值直写 —— 用户文案不带内部枚举名（那些是给日志的）
                eprintln!("[appearance] 拒绝非法值：{key}={v}（只认 {}）", choices.join(" / "));
                return Err(i18n::t(i18n::msg::ERR_CMD_SETTINGS_24).to_string());
            }
            db::set_setting(conn, key, v)
        }
        appearance::KEY_LAYER_BAR_COLOR | appearance::KEY_CATEGORY_BAR | appearance::KEY_NOW_LINE | KEY_TEMPLATE_PREVIEW => {
            if v != "0" && v != "1" {
                return Err(i18n::t(i18n::msg::ERR_CMD_SETTINGS_04).to_string());
            }
            db::set_setting(conn, key, v)
        }
        // round77（3.1b）：图标集 / 块内第二行 —— 非法值规范成默认（= 不动），不报错（照 i18n 那个键）
        appearance::KEY_ICON_SET => db::set_setting(
            conn,
            key,
            &appearance::normalize(&appearance::ICON_SETS, appearance::DEFAULT_ICON_SET, v),
        ),
        appearance::KEY_BLOCK_SECOND_LINE => db::set_setting(
            conn,
            key,
            &appearance::normalize(
                &appearance::SECOND_LINES,
                appearance::DEFAULT_BLOCK_SECOND_LINE,
                v,
            ),
        ),
        // round87（3.3）：界面字体族 —— 与上两条同口径：非法值规范成默认档，不报错
        // （⚠️ Step 5 真包冒烟抓到的漏：当时只加了**读侧** match 臂，写侧落到 `_` 报「设置项不存在」）
        appearance::KEY_FONT => db::set_setting(
            conn,
            key,
            &appearance::normalize(&appearance::FONT_FAMILIES, appearance::DEFAULT_FONT_FAMILY, v),
        ),
        // round81（3.1c₁）：时间 / 日期格式 —— 枚举只认白名单值（前端只送合法值；坏值直写拒掉）
        datetime::KEY_TIME_FORMAT | datetime::KEY_DATE_FORMAT => {
            let choices: &[&str] = if key == datetime::KEY_TIME_FORMAT {
                &datetime::TIME_FORMATS
            } else {
                &datetime::DATE_FORMATS
            };
            if !choices.contains(&v) {
                eprintln!("[datetime] 拒绝非法值：{key}={v}（只认 {}）", choices.join(" / "));
                return Err(i18n::t(i18n::msg::ERR_CMD_SETTINGS_26).to_string());
            }
            db::set_setting(conn, key, v)
        }
        // round81（3.1c₁ · 宽-04）：时间刻度档位 —— auto / 18–64 的偶数（读与写**同一条** `normalize_slot_height`）
        KEY_SLOT_HEIGHT => {
            let canonical = normalize_slot_height(v).ok_or_else(|| {
                eprintln!("[layout] 拒绝非法值：{key}={v}（只认 auto / 18–64 的偶数）");
                i18n::t(i18n::msg::ERR_CMD_SETTINGS_24).to_string()
            })?;
            db::set_setting(conn, key, &canonical)
        }
        _ => Err(tf!(i18n::msg::ERR_CMD_SETTINGS_20, key = key)),
    }
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    get_settings_impl(&conn)
}

///
/// round79（78-01）：**恢复默认设置** —— 只删白名单里的键（**保留界面语言**，你 2026-10-06 拍板），
/// 删掉就等于「下次读取落回默认」（默认值全在 `get_settings_impl` 里，不另写一份）。
/// **不碰数据**：任务 / 块 / 模板 / 统计 / 成就一行不删；内部键（`achievements_initialized` /
/// `review_nudged_week` / 两个 `*_reset_at`）也不动。
pub fn reset_settings_impl(conn: &Connection) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| tf!(i18n::msg::ERR_CMD_SETTINGS_25, e = e))?;
    for key in KNOWN_KEYS {
        if key == i18n::KEY {
            continue; // 语言保留（英文界面点「恢复默认」不该整屏变中文）
        }
        tx.execute("DELETE FROM settings WHERE key = ?1", [key])
            .map_err(|e| tf!(i18n::msg::ERR_CMD_SETTINGS_25, e = e))?;
    }
    tx.commit()
        .map_err(|e| tf!(i18n::msg::ERR_CMD_SETTINGS_25, e = e))?;
    Ok(())
}

/// round81（3.1c₁ · 深-03）：**系统语言标签**（BCP-47，如 `zh-CN` / `en-GB`）——
/// 前端在 `ui_locale=system` 时问它，保证「界面语言」与「时间格式的跟随系统」都用**同一个来源**
/// （Rust `sys-locale`）；拿去当 `Intl` 的 locale 也直接用得上。
#[tauri::command]
pub fn system_locale() -> String {
    i18n::system_tag()
}

/// round82（3.1c₂ · 淡-05）：**前端 60 秒节拍跨界时的刷新口** —— 按库里的档位 + 时段 + 当前时刻
/// 重解析窗口主题（**不写任何设置**）；`ui_theme != night` 时等于把当前档重放一遍（幂等）。
#[tauri::command]
pub fn refresh_window_theme(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    appearance::sync_window_theme(&app, &conn);
    Ok(())
}

#[tauri::command]
pub fn set_setting(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    // 锁只在这一小段里 —— `sync_quiet` 自己会再拿锁（std Mutex 不可重入）
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        set_setting_impl(&conn, &key, &value)?;
    }
    apply_side_effects(&app, &key, value.trim());
    Ok(())
}

/// round79（78-01）：**改一个键之后要跟着做的事** —— 收在一处，`set_setting` 与 `reset_settings` 共用
/// （以前这段长在 `set_setting` 里；恢复默认要「回放」同一套，拆出来才不会两处漂移）。
fn apply_side_effects(app: &tauri::AppHandle, key: &str, value: &str) {
    if key == KEY_QUIET_UNTIL {
        crate::tray::sync_quiet(app, crate::db::now());
    } else if key == KEY_SCHEDULER {
        crate::tray::sync_scheduler_item(app, value == "1");
    } else if key == features::TRAY_STATE || key == features::CURRENT_HINT {
        // round64（C10）：这两把锁直接管托盘状态 / 窗口标题 —— 改完立刻重画一次，不等下一轮 60 秒节拍
        crate::hint::refresh(app);
        crate::tray::refresh_baseline(app);
    } else if key == features::HOTKEYS {
        // round66（C12）：全局快捷键 —— 改完立刻注册 / 注销（不用重启）
        crate::hotkeys::sync(app);
    } else if key == i18n::KEY {
        // round74（3.0b₂）：语言键 —— 切全局 locale + 重建托盘菜单 + 刷新窗口标题；
        // 界面由前端响应式状态自己更新
        crate::i18n::set_locale(value);
        crate::tray::refresh_menu(app);
        crate::hint::refresh(app);
    } else if key == datetime::KEY_TIME_FORMAT || key == datetime::KEY_DATE_FORMAT {
        // round81（3.1c₁）：时间 / 日期格式 —— 更新 Rust 侧全局 + 重建托盘菜单（「静音至 …」那行要跟着换）
        if key == datetime::KEY_TIME_FORMAT {
            datetime::set_time_format(value);
        } else {
            datetime::set_date_format(value);
        }
        crate::tray::refresh_menu(app);
    } else if key == appearance::KEY_THEME
        || key == appearance::KEY_NIGHT_START
        || key == appearance::KEY_NIGHT_END
    {
        // round76（3.1a）：深浅色 —— 窗口主题（WebView2 的 prefers-color-scheme 随之变）
        // round82（淡-04）：夜间档 / 时段改动 —— 按**当前时刻**重解析（三者走同一个入口）
        if let Some(state) = app.try_state::<crate::AppState>() {
            match state.db.lock() {
                Ok(conn) => appearance::sync_window_theme(app, &conn),
                Err(e) => eprintln!("[appearance] 窗口主题刷新失败（忽略）：{e}"),
            }
        }
    }
}

/// round79（78-01）：**恢复默认设置**（命令层）—— 删键 + **回放副作用**（把生效值 = 默认值
/// 逐个交给 `apply_side_effects`：语言 / 深浅色 / 快捷键 / 托盘状态 / 计划任务 / 免打扰全跟着回默认）。
#[tauri::command]
pub fn reset_settings(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let effective = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        reset_settings_impl(&conn)?;
        get_settings_impl(&conn)? // 删完再读一次 = 拿**默认值**（不另写一份默认表）
    };
    for (key, value) in &effective.values {
        apply_side_effects(&app, key, value);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// round87（3.3 · 边界表 F2）：界面字体族的**值校验** —— 非法值规范成默认档、**不报错**（旧库 / 坏值读得回来）。
    #[test]
    fn test_font_family_write_normalizes_bad_value() {
        let conn = db::test_conn();
        for good in appearance::FONT_FAMILIES {
            assert!(set_setting_impl(&conn, appearance::KEY_FONT, good).is_ok(), "{good} 该能写");
            let s = get_settings_impl(&conn).expect("读得回来");
            assert_eq!(s.values.get(appearance::KEY_FONT).map(String::as_str), Some(good));
        }
        assert!(set_setting_impl(&conn, appearance::KEY_FONT, "垃圾值").is_ok(), "坏值不该报错");
        let s = get_settings_impl(&conn).expect("读得回来");
        assert_eq!(
            s.values.get(appearance::KEY_FONT).map(String::as_str),
            Some(appearance::DEFAULT_FONT_FAMILY),
            "坏值该落成默认档"
        );
    }

    /// round87（Step 5 真包冒烟抓到的漏）：**白名单里每个键都必须能写回它自己读出来的值** ——
    /// 读侧（`get_settings_impl`）与写侧（`set_setting_impl`）是**两张 match 表**，漏加一边就会
    /// 「能读不能写」（`ui_font` 实机报「设置项不存在」，而 `get_settings` 照常回默认值）。
    /// 这条测试逐个键把读到的规范值写回去 —— 以后任何新键漏加写侧都会在这里红。
    #[test]
    fn test_every_known_key_is_writable() {
        let conn = db::test_conn();
        let settings = get_settings_impl(&conn).expect("读设置失败");
        for key in KNOWN_KEYS {
            let value = settings
                .values
                .get(key)
                .unwrap_or_else(|| panic!("{key} 在 get_settings 里没有值"));
            assert!(
                set_setting_impl(&conn, key, value).is_ok(),
                "{key} 能读不能写（读侧/写侧 match 表漂移）：value={value:?}"
            );
        }
    }

    #[test]
    fn test_defaults_are_filled_in() {
        let conn = db::test_conn();
        let s = get_settings_impl(&conn).expect("读设置失败");
        assert_eq!(s.values.get(KEY_BUDGET).map(String::as_str), Some("360"), "默认 6 小时");
        assert_eq!(s.values.get(KEY_ENABLED).map(String::as_str), Some("1"), "默认开");
        assert!(s.values.contains_key(KEY_SCHEDULER));
        assert_eq!(s.values.len(), KNOWN_KEYS.len(), "只返回白名单里的键");
        assert_eq!(
            s.values.get(KEY_BACKLOG_WIDTH).map(String::as_str),
            Some("260"),
            "round45：栏宽默认 260"
        );
        // C7（round52）：复盘提醒（round57 起「开关」换成三选一的 `review_action`；round58 起「直接打开」开的是总览）
        // round69.1（#12）：新默认 = 什么都不做（旧默认「只提醒」每周来一次，用户说骚扰）
        assert_eq!(
            s.values.get(KEY_ACTION).map(String::as_str),
            Some("off"),
            "默认：到点什么都不做（想要提醒的人自己去设置开）"
        );
        assert_eq!(
            s.values.get(KEY_REMIND_AT).map(String::as_str),
            Some("sun 20:00"),
            "提醒默认周日 20:00"
        );
    }

    /// round57（0.13.0）：`review_action` 只认三档；非法值不落库
    #[test]
    fn test_review_action_validation() {
        let conn = db::test_conn();
        for good in ["open", "hint", "off"] {
            set_setting_impl(&conn, KEY_ACTION, good).expect("合法档该能写");
            assert_eq!(
                get_settings_impl(&conn)
                    .expect("读失败")
                    .values
                    .get(KEY_ACTION)
                    .map(String::as_str),
                Some(good)
            );
        }
        for bad in ["0", "1", "OPEN", "", "direct"] {
            assert!(
                set_setting_impl(&conn, KEY_ACTION, bad).is_err(),
                "非法档 {bad:?} 必须被拒"
            );
        }
        assert_eq!(
            get_settings_impl(&conn)
                .expect("读失败")
                .values
                .get(KEY_ACTION)
                .map(String::as_str),
            Some("off"),
            "非法值不该污染已存的值"
        );
    }

    /// round57：旧库只写过 `review_remind = 0`（关掉提醒）→ 升级后不能突然开始弹
    #[test]
    fn test_legacy_review_remind_reads_as_off() {
        let conn = db::test_conn();
        db::set_setting(&conn, review::KEY_REMIND, "0").unwrap();
        assert_eq!(
            get_settings_impl(&conn)
                .expect("读失败")
                .values
                .get(KEY_ACTION)
                .map(String::as_str),
            Some("off")
        );
    }

    #[test]
    fn test_remind_at_validation_and_canonical_form() {
        let conn = db::test_conn();
        set_setting_impl(&conn, KEY_REMIND_AT, "MON 9:00").expect("写周一失败");
        assert_eq!(
            get_settings_impl(&conn)
                .expect("读失败")
                .values
                .get(KEY_REMIND_AT)
                .map(String::as_str),
            Some("mon 09:00"),
            "存的是规范写法（两位分钟）"
        );
        for bad in ["", "tue 09:00", "sun 25:00", "sun", "20:00", "sun 20:99"] {
            assert!(
                set_setting_impl(&conn, KEY_REMIND_AT, bad).is_err(),
                "非法提醒时刻 {bad:?} 必须被拒"
            );
        }
        assert_eq!(
            get_settings_impl(&conn)
                .expect("读失败")
                .values
                .get(KEY_REMIND_AT)
                .map(String::as_str),
            Some("mon 09:00"),
            "非法值不该污染已存的值"
        );
    }

    #[test]
    fn test_backlog_width_validation() {
        let conn = db::test_conn();
        set_setting_impl(&conn, KEY_BACKLOG_WIDTH, "300").expect("写 300 失败");
        assert_eq!(
            get_settings_impl(&conn)
                .expect("读失败")
                .values
                .get(KEY_BACKLOG_WIDTH)
                .map(String::as_str),
            Some("300")
        );
        for bad in ["0", "-1", "900", "wide", ""] {
            assert!(
                set_setting_impl(&conn, KEY_BACKLOG_WIDTH, bad).is_err(),
                "非法栏宽 {bad:?} 必须被拒"
            );
        }
        assert_eq!(
            get_settings_impl(&conn)
                .expect("读失败")
                .values
                .get(KEY_BACKLOG_WIDTH)
                .map(String::as_str),
            Some("300"),
            "非法值不该污染已存的值"
        );
    }

    #[test]
    fn test_unknown_key_is_rejected() {
        let conn = db::test_conn();
        let err = set_setting_impl(&conn, "whatever", "1").expect_err("未知键必须被拒");
        assert!(err.contains("设置项不存在"), "错误要说清：{err}");
        assert_eq!(
            db::get_setting(&conn, "whatever").expect("读失败"),
            None,
            "不许落库"
        );
    }

    #[test]
    fn test_budget_validation_and_round_trip() {
        let conn = db::test_conn();
        set_setting_impl(&conn, KEY_BUDGET, "600").expect("写 600 失败");
        assert_eq!(
            get_settings_impl(&conn).expect("读失败").values.get(KEY_BUDGET).map(String::as_str),
            Some("600")
        );
        for bad in ["0", "-5", "2000", "abc", ""] {
            assert!(
                set_setting_impl(&conn, KEY_BUDGET, bad).is_err(),
                "非法预算 {bad:?} 必须被拒"
            );
        }
        assert_eq!(sanity::budget_minutes(&conn), 600, "非法值不该污染已存的值");
    }

    #[test]
    fn test_switches_only_accept_0_1() {
        let conn = db::test_conn();
        set_setting_impl(&conn, KEY_ENABLED, "0").expect("关掉失败");
        assert!(!sanity::enabled(&conn));
        assert!(set_setting_impl(&conn, KEY_ENABLED, "yes").is_err());
        assert!(set_setting_impl(&conn, KEY_SCHEDULER, "2").is_err());
        assert_eq!(
            db::get_setting(&conn, KEY_ENABLED).expect("读失败").as_deref(),
            Some("0"),
            "非法值不该覆盖已存的 0"
        );
    }

    /// round63（C18）：计划任务默认翻面 —— 没存过 = 关；显式开过 = 开
    #[test]
    fn test_scheduler_defaults_off_until_explicitly_enabled() {
        let conn = db::test_conn();
        assert!(!crate::notify::scheduler_enabled(&conn), "没存过 → 关（默认值礼貌）");
        assert_eq!(
            get_settings_impl(&conn).expect("读失败").values.get(KEY_SCHEDULER).map(String::as_str),
            Some("0"),
            "生效值也得是关"
        );
        set_setting_impl(&conn, KEY_SCHEDULER, "1").expect("显式开启失败");
        assert!(crate::notify::scheduler_enabled(&conn), "显式开过 → 开");
    }

    /// round63（C18）：新六键的默认值 + 校验（非法不落库）
    #[test]
    fn test_c18_keys_defaults_and_validation() {
        let conn = db::test_conn();
        let s = get_settings_impl(&conn).expect("读设置失败");
        let val = |key: &str| s.values.get(key).map(String::as_str);
        assert_eq!(val(KEY_QUIET_UNTIL), Some("0"));
        assert_eq!(val(KEY_QUIET_MORNING), Some("08:00"));
        assert_eq!(val(KEY_REMIND_LEAD), Some("0"));
        assert_eq!(val(KEY_BACKLOG_FILTER), Some("{\"kind\":\"all\"}"));
        assert_eq!(val(KEY_BACKLOG_GROUPED), Some("0"));
        assert_eq!(val(KEY_BACKLOG_COLLAPSED), Some("[]"));

        // 免打扰：合法值规范化 / 非法拒绝
        set_setting_impl(&conn, KEY_QUIET_UNTIL, " 1700000000 ").expect("合法值该过");
        assert_eq!(
            get_settings_impl(&conn).unwrap().values.get(KEY_QUIET_UNTIL).map(String::as_str),
            Some("1700000000")
        );
        assert!(set_setting_impl(&conn, KEY_QUIET_UNTIL, "-1").is_err(), "负数要拒");
        assert!(set_setting_impl(&conn, KEY_QUIET_UNTIL, "明天").is_err());
        set_setting_impl(&conn, KEY_QUIET_MORNING, "9:30").expect("合法值该过");
        assert_eq!(
            get_settings_impl(&conn).unwrap().values.get(KEY_QUIET_MORNING).map(String::as_str),
            Some("09:30"),
            "规范化成 HH:MM"
        );
        assert!(set_setting_impl(&conn, KEY_QUIET_MORNING, "25:00").is_err());

        // 提前档位：只认白名单档位
        set_setting_impl(&conn, KEY_REMIND_LEAD, "15").expect("合法档位该过");
        assert!(set_setting_impl(&conn, KEY_REMIND_LEAD, "7").is_err(), "非档位要拒");
        assert!(set_setting_impl(&conn, KEY_REMIND_LEAD, "abc").is_err());

        // 视图记忆：JSON 结构校验 + 规范化
        set_setting_impl(&conn, KEY_BACKLOG_FILTER, "{\"kind\":\"cat\",\"name\":\" 学习 \"}")
            .expect("该过");
        assert_eq!(
            get_settings_impl(&conn).unwrap().values.get(KEY_BACKLOG_FILTER).map(String::as_str),
            Some("{\"kind\":\"cat\",\"name\":\"学习\"}")
        );
        assert!(set_setting_impl(&conn, KEY_BACKLOG_FILTER, "{\"kind\":\"nope\"}").is_err());
        assert!(set_setting_impl(&conn, KEY_BACKLOG_FILTER, "学习").is_err(), "不是 JSON 要拒");
        set_setting_impl(&conn, KEY_BACKLOG_GROUPED, "1").expect("该过");
        assert!(set_setting_impl(&conn, KEY_BACKLOG_GROUPED, "true").is_err());
        set_setting_impl(&conn, KEY_BACKLOG_COLLAPSED, "[\"A\",\"A\",\"B\"]").expect("该过");
        assert_eq!(
            get_settings_impl(&conn).unwrap().values.get(KEY_BACKLOG_COLLAPSED).map(String::as_str),
            Some("[\"A\",\"B\"]"),
            "去重后规范化"
        );
        assert!(set_setting_impl(&conn, KEY_BACKLOG_COLLAPSED, "{\"a\":1}").is_err());
        assert!(set_setting_impl(&conn, KEY_BACKLOG_COLLAPSED, "[\"\"]").is_err(), "空名要拒");
    }

    /// round64（C10）：`features` 的键名清单与设置白名单**不许漂移**（两份清单怕各改一边）
    #[test]
    fn test_feature_keys_are_known_settings() {
        let conn = db::test_conn();
        for key in features::KEYS {
            assert!(KNOWN_KEYS.contains(&key), "{key} 必须在白名单里");
            assert!(set_setting_impl(&conn, key, "1").is_ok(), "{key} 该能写");
        }
        assert!(KNOWN_KEYS.contains(&features::TEMPLATE_SUGGEST));
        assert_eq!(KNOWN_KEYS.len(), 54, "round87（3.3）后一共 54 键（round82 的 53 + 界面字体族 ui_font）");
    }

    /// round82（3.1c₂ · 绑-08…10）：键位覆盖（JSON）—— 缺键 / 坏 JSON / 结构不对三态；未知 id 由前端逐条回落
    #[test]
    fn test_key_bindings_normalization() {
        let conn = db::test_conn();
        let read = |conn: &Connection| {
            get_settings_impl(conn).unwrap().values.get(KEY_BINDINGS).map(String::as_str).map(str::to_string)
        };
        // 缺键 → 读回 `{}`（= 全默认，前端逐条回落）
        assert_eq!(read(&conn).as_deref(), Some("{}"));
        // 合法 JSON：按结构规范化后落库 / 读回
        set_setting_impl(&conn, KEY_BINDINGS, "{\"goNow\":\"k\",\"stats\":\"Ctrl+Alt+S\"}")
            .expect("合法键位该能写");
        assert_eq!(read(&conn).as_deref(), Some("{\"goNow\":\"k\",\"stats\":\"Ctrl+Alt+S\"}"));
        // 坏值直写：拒（不覆盖已存的好值）
        assert!(set_setting_impl(&conn, KEY_BINDINGS, "不是JSON").is_err());
        assert!(set_setting_impl(&conn, KEY_BINDINGS, "[\"goNow\"]").is_err(), "数组要拒");
        assert!(set_setting_impl(&conn, KEY_BINDINGS, "{\"goNow\":1}").is_err(), "值不是字符串要拒");
        assert_eq!(read(&conn).as_deref(), Some("{\"goNow\":\"k\",\"stats\":\"Ctrl+Alt+S\"}"), "非法值不污染已存");
        // 库里手放坏 JSON → 读回 `{}`（不报错、不崩）
        db::set_setting(&conn, KEY_BINDINGS, "{断").unwrap();
        assert_eq!(read(&conn).as_deref(), Some("{}"));
    }

    /// round81（3.1c₁ · 宽-04）+ round82（11.6）：时间刻度**读写同一条**（18–64 偶数；防「读放宽、写没收」再发）
    #[test]
    fn test_slot_height_range_is_18_to_64_even() {
        let conn = db::test_conn();
        let read = |conn: &Connection| {
            get_settings_impl(conn).unwrap().values.get(KEY_SLOT_HEIGHT).map(String::as_str).map(str::to_string)
        };
        for v in ["18", "20", "48", "64", "auto"] {
            set_setting_impl(&conn, KEY_SLOT_HEIGHT, v).unwrap_or_else(|e| panic!("{v} 该能写：{e}"));
        }
        for bad in ["17", "19", "65", "34.5", "big"] {
            assert!(set_setting_impl(&conn, KEY_SLOT_HEIGHT, bad).is_err(), "{bad} 该拒写");
        }
        assert_eq!(read(&conn).as_deref(), Some("auto"), "非法值不污染已存的合法值");
        // 库里手放坏值 → 读回 auto
        db::set_setting(&conn, KEY_SLOT_HEIGHT, "19").unwrap();
        assert_eq!(read(&conn).as_deref(), Some("auto"), "奇数值读回 auto");
    }

    /// round81（3.1c₁ · 深-03）：语言**档位** —— system / zh / en 都能读写；坏值归一成 `system`（新默认）
    #[test]
    fn test_round81_locale_choice() {
        let conn = db::test_conn();
        for v in ["system", "zh", "en"] {
            set_setting_impl(&conn, i18n::KEY, v).expect("写语言档位");
            assert_eq!(get_settings_impl(&conn).unwrap().values[i18n::KEY], v, "读回同一个档位");
        }
        set_setting_impl(&conn, i18n::KEY, "垃圾").expect("坏值不报错");
        assert_eq!(
            get_settings_impl(&conn).unwrap().values[i18n::KEY],
            "system",
            "坏值 → system（跟随系统）"
        );
    }

    /// round76（3.1a）：外观五键 —— 默认值（舒适 / 跟随系统 / 暖砂 / 层条上色开 / 分类条关）+ 值域 + 坏值不落库
    /// round77（3.1b）：图标集 / 块内第二行 —— 默认值、合法值写读、**非法值归一成默认不报错**
    #[test]
    fn test_round77_icon_set_and_second_line() {
        let conn = db::test_conn();
        let read = |key: &str| {
            get_settings_impl(&conn)
                .expect("读设置失败")
                .values
                .get(key)
                .cloned()
                .unwrap_or_default()
        };
        // 默认值（旧库没有任何新键 = 旧行为 + 推荐值）
        assert_eq!(read(appearance::KEY_ICON_SET), "lucide");
        assert_eq!(read(appearance::KEY_BLOCK_SECOND_LINE), "time");
        // round78（3.1b₂ · 设-01）：现在线 —— 默认开（旧库没这个键 → "1" = 旧行为）
        assert_eq!(read(appearance::KEY_NOW_LINE), "1");
        // 关掉能写能读；非法值当开（与 `layer_bar_color` 同一套「只有显式 0 才算关」）
        assert!(set_setting_impl(&conn, appearance::KEY_NOW_LINE, "0").is_ok());
        assert_eq!(read(appearance::KEY_NOW_LINE), "0");
        assert!(set_setting_impl(&conn, appearance::KEY_NOW_LINE, "x").is_err());
        assert!(set_setting_impl(&conn, appearance::KEY_NOW_LINE, "1").is_ok());
        assert_eq!(read(appearance::KEY_NOW_LINE), "1");

        // 合法值：写进去读得回来（重启记得）；五套都过一遍
        for v in appearance::ICON_SETS {
            set_setting_impl(&conn, appearance::KEY_ICON_SET, v)
                .unwrap_or_else(|e| panic!("icon_set={v} 该过：{e}"));
            assert_eq!(read(appearance::KEY_ICON_SET), v);
        }
        for v in appearance::SECOND_LINES {
            set_setting_impl(&conn, appearance::KEY_BLOCK_SECOND_LINE, v)
                .unwrap_or_else(|e| panic!("block_second_line={v} 该过：{e}"));
            assert_eq!(read(appearance::KEY_BLOCK_SECOND_LINE), v);
        }

        // 非法值：**归一成默认、不报错**（与 `ui_locale` 同口径 —— 它们都是纯展示项）
        set_setting_impl(&conn, appearance::KEY_ICON_SET, "lucide2").expect("非法值不报错");
        assert_eq!(read(appearance::KEY_ICON_SET), "lucide", "非法值落到默认");
        set_setting_impl(&conn, appearance::KEY_BLOCK_SECOND_LINE, "还剩").expect("非法值不报错");
        assert_eq!(read(appearance::KEY_BLOCK_SECOND_LINE), "time", "非法值落到默认");

        // 旧库坏值（绕过校验直写）→ 读也归一
        db::set_setting(&conn, appearance::KEY_ICON_SET, "Lucide").expect("直写库");
        db::set_setting(&conn, appearance::KEY_BLOCK_SECOND_LINE, "TIME").expect("直写库");
        assert_eq!(read(appearance::KEY_ICON_SET), "lucide");
        assert_eq!(read(appearance::KEY_BLOCK_SECOND_LINE), "time");
    }

    #[test]
    fn test_round76_appearance_keys() {
        let conn = db::test_conn();
        let read = |key: &str| {
            get_settings_impl(&conn)
                .expect("读设置失败")
                .values
                .get(key)
                .cloned()
                .unwrap_or_default()
        };
        // 默认值（旧库没有任何新键 = 旧行为 + 推荐值）
        assert_eq!(read(appearance::KEY_DENSITY), "comfortable");
        assert_eq!(read(appearance::KEY_THEME), "system");
        assert_eq!(read(appearance::KEY_PALETTE), "warm");
        assert_eq!(read(appearance::KEY_LAYER_BAR_COLOR), "1", "层条上色默认开");
        assert_eq!(read(appearance::KEY_CATEGORY_BAR), "0", "分类底边条默认关");

        // 枚举三键：档位照收、非法拒（不落库）—— 数组标注成 `&[&str]`：round82 起 THEMES 是 4 档（混合长度）
        let cases: [(&str, &[&str]); 3] = [
            (appearance::KEY_DENSITY, &appearance::DENSITIES),
            (appearance::KEY_THEME, &appearance::THEMES),
            (appearance::KEY_PALETTE, &appearance::PALETTES),
        ];
        for (key, choices) in cases {
            for &v in choices {
                set_setting_impl(&conn, key, v).unwrap_or_else(|e| panic!("{key}={v} 该过：{e}"));
                assert_eq!(read(key), v, "写进去要读得回来（重启记得）");
            }
            assert!(set_setting_impl(&conn, key, "nope").is_err(), "{key} 非法值要拒");
            assert_eq!(read(key), choices[choices.len() - 1], "拒掉之后库里还是上一次的合法值");
        }

        // 两个开关键：只认 0/1
        for key in [appearance::KEY_LAYER_BAR_COLOR, appearance::KEY_CATEGORY_BAR] {
            set_setting_impl(&conn, key, "0").expect("该能关");
            assert_eq!(read(key), "0");
            set_setting_impl(&conn, key, "1").expect("该能开");
            assert_eq!(read(key), "1");
            assert!(set_setting_impl(&conn, key, "true").is_err(), "只认 0/1");
            assert!(set_setting_impl(&conn, key, "").is_err(), "空值要拒");
        }

        // 旧库坏值 → 读回默认（不报错、不炸读）
        db::set_setting(&conn, appearance::KEY_DENSITY, "宽松").expect("直接写库（绕过校验）");
        db::set_setting(&conn, appearance::KEY_THEME, "Dark").expect("直接写库");
        db::set_setting(&conn, appearance::KEY_PALETTE, "WARM").expect("直接写库");
        assert_eq!(read(appearance::KEY_DENSITY), "comfortable");
        assert_eq!(read(appearance::KEY_THEME), "system");
        assert_eq!(read(appearance::KEY_PALETTE), "warm");
    }

    /// round82（3.1c₂ · 淡-*）：夜间三键 —— 默认值 / 开关只认 0-1 / 时段宽容解析并零填充 / 坏值拒写 & 读回回落
    #[test]
    fn test_round82_night_keys() {
        let conn = db::test_conn();
        let read = |key: &str| {
            get_settings_impl(&conn)
                .expect("读设置失败")
                .values
                .get(key)
                .cloned()
                .unwrap_or_default()
        };
        // 默认值（旧库没有新键）：淡化开 + 22:00–06:00（你 2026-10-07 拍）
        assert_eq!(read(appearance::KEY_NIGHT_DIM), "1", "淡化默认开");
        assert_eq!(read(appearance::KEY_NIGHT_START), appearance::NIGHT_START_DEFAULT);
        assert_eq!(read(appearance::KEY_NIGHT_END), appearance::NIGHT_END_DEFAULT);
        // 开关：只认 0/1
        set_setting_impl(&conn, appearance::KEY_NIGHT_DIM, "0").expect("该能关");
        assert_eq!(read(appearance::KEY_NIGHT_DIM), "0");
        assert!(set_setting_impl(&conn, appearance::KEY_NIGHT_DIM, "true").is_err(), "只认 0/1");
        // 时段：宽容解析（9:5）并规范成零填充
        set_setting_impl(&conn, appearance::KEY_NIGHT_START, "9:5").expect("宽容解析该过");
        assert_eq!(read(appearance::KEY_NIGHT_START), "09:05", "写进去要读得回规范写法");
        set_setting_impl(&conn, appearance::KEY_NIGHT_END, " 06:30 ").expect("带空白也认");
        assert_eq!(read(appearance::KEY_NIGHT_END), "06:30");
        // 非法值拒写（不落库，库里还是上一次的合法值）
        assert!(set_setting_impl(&conn, appearance::KEY_NIGHT_END, "25:00").is_err());
        assert_eq!(read(appearance::KEY_NIGHT_END), "06:30");
        // 旧库坏值 / 缺键 → 读回默认（不报错、不炸读）
        db::set_setting(&conn, appearance::KEY_NIGHT_START, "垃圾").expect("直接写库（绕过校验）");
        db::set_setting(&conn, appearance::KEY_NIGHT_END, "").expect("直接写库");
        assert_eq!(read(appearance::KEY_NIGHT_START), appearance::NIGHT_START_DEFAULT);
        assert_eq!(read(appearance::KEY_NIGHT_END), appearance::NIGHT_END_DEFAULT);
    }

    /// round68（19.1）：成就两键默认开 / 只认 0-1
    /// （round85：单一版本 —— 以前的 Lite 分支（读回 0 / 拒写）随 `compiled()` 一起删了）
    #[test]
    fn test_achievement_keys_defaults_and_validation() {
        let conn = db::test_conn();
        let s = get_settings_impl(&conn).expect("读设置失败");
        let val = |key: &str| s.values.get(key).map(String::as_str);
        assert_eq!(val(KEY_ACHIEVEMENTS), Some("1"), "默认开");
        assert_eq!(val(KEY_ACHIEVEMENT_TOAST), Some("1"), "提示默认开");
        set_setting_impl(&conn, KEY_ACHIEVEMENTS, "0").expect("该能关");
        assert_eq!(
            get_settings_impl(&conn).unwrap().values.get(KEY_ACHIEVEMENTS).map(String::as_str),
            Some("0")
        );
        assert!(set_setting_impl(&conn, KEY_ACHIEVEMENTS, "yes").is_err(), "只认 0/1");
    }

    /// round64（C10）：功能开关默认全开、只认 0/1；模板建议 JSON 规范化 + 门限校验
    #[test]
    fn test_feature_switches_default_on_and_template_suggest() {
        let conn = db::test_conn();
        let s = get_settings_impl(&conn).expect("读设置失败");
        for key in features::KEYS {
            assert_eq!(s.values.get(key).map(String::as_str), Some("1"), "{key} 默认全开");
            assert!(features::enabled(&conn, key), "{key} 运行时也该是开");
        }
        // 只有显式 0 才算关
        set_setting_impl(&conn, features::HINTS, "0").expect("关掉失败");
        assert!(!features::enabled(&conn, features::HINTS));
        assert_eq!(
            get_settings_impl(&conn).unwrap().values.get(features::HINTS).map(String::as_str),
            Some("0")
        );
        assert!(set_setting_impl(&conn, features::HINTS, "2").is_err(), "只认 0/1");
        // 模板建议：默认 JSON；合法值规范化；缺键 / 越界 / 非 JSON 都拒
        assert_eq!(
            s.values.get(features::TEMPLATE_SUGGEST).map(String::as_str),
            Some(TEMPLATE_SUGGEST_DEFAULT),
            "默认：开 · 7 天 · 5 次"
        );
        set_setting_impl(
            &conn,
            features::TEMPLATE_SUGGEST,
            "{\"done\":9,\"days\":14,\"enabled\":false}",
        )
        .expect("合法 JSON 该过");
        assert_eq!(
            get_settings_impl(&conn)
                .unwrap()
                .values
                .get(features::TEMPLATE_SUGGEST)
                .map(String::as_str),
            Some("{\"days\":14,\"done\":9,\"enabled\":false}")
        );
        for bad in ["{}", "{\"enabled\":true,\"days\":0,\"done\":5}", "{\"enabled\":true,\"days\":7,\"done\":-1}", "yes"] {
            assert!(
                set_setting_impl(&conn, features::TEMPLATE_SUGGEST, bad).is_err(),
                "非法模板建议 {bad:?} 必须被拒"
            );
        }
        assert_eq!(
            get_settings_impl(&conn)
                .unwrap()
                .values
                .get(features::TEMPLATE_SUGGEST)
                .map(String::as_str),
            Some("{\"days\":14,\"done\":9,\"enabled\":false}"),
            "非法值不该污染已存的值"
        );
    }

    /// round67：四个「外观 / 布局」键 —— 默认值、校验、round-trip、坏库存值回落
    #[test]
    fn test_round67_layout_keys_defaults_and_validation() {
        let conn = db::test_conn();
        let s = get_settings_impl(&conn).expect("读设置失败");
        let val = |key: &str| s.values.get(key).map(String::as_str);
        assert_eq!(val("backlog_pane"), Some("open"), "默认展开");
        assert_eq!(val("weekend_hidden"), Some("0"), "默认显示周末");
        assert_eq!(val("hint_bar_mode"), Some("always"), "默认常显");
        assert!(!KNOWN_KEYS.contains(&"backlog_collapse_style"), "整栏隐藏档已删（round67.2）");

        // 合法值 round-trip
        set_setting_impl(&conn, "backlog_pane", "rail").expect("合法值该过");
        set_setting_impl(&conn, "weekend_hidden", "1").expect("合法值该过");
        set_setting_impl(&conn, "hint_bar_mode", "hidden").expect("合法值该过");
        let got = get_settings_impl(&conn).expect("读设置失败");
        assert_eq!(got.values.get("backlog_pane").map(String::as_str), Some("rail"));
        assert_eq!(got.values.get("weekend_hidden").map(String::as_str), Some("1"));
        assert_eq!(got.values.get("hint_bar_mode").map(String::as_str), Some("hidden"));

        // 非法值：拒收、且不污染已存值
        // round67.2（你 2026-10-05）：「整栏隐藏」档已删 —— hidden 现在是非法值
        assert!(
            set_setting_impl(&conn, "backlog_pane", "hidden").is_err(),
            "整栏隐藏档已删，应拒收"
        );
        assert!(set_setting_impl(&conn, "backlog_pane", "collapsed").is_err());
        assert!(set_setting_impl(&conn, "backlog_pane", "").is_err());
        assert!(set_setting_impl(&conn, "weekend_hidden", "true").is_err());
        assert!(set_setting_impl(&conn, "hint_bar_mode", "sometimes").is_err());
        // round67.1：「按需」档已删 —— on-demand 现在是非法值
        assert!(
            set_setting_impl(&conn, "hint_bar_mode", "on-demand").is_err(),
            "按需档已删，应拒收"
        );
        let after = get_settings_impl(&conn).expect("读设置失败");
        assert_eq!(
            after.values.get("backlog_pane").map(String::as_str),
            Some("rail"),
            "非法值不改已存的"
        );
        assert_eq!(after.values.get("hint_bar_mode").map(String::as_str), Some("hidden"));

        // 坏库存值（绕过 set 直接塞）→ 读回落在默认；旧的 hidden / on-demand 各自回 rail / always
        db::set_setting(&conn, "backlog_pane", "nonsense").expect("塞坏值失败");
        db::set_setting(&conn, "hint_bar_mode", "nonsense").expect("塞坏值失败");
        db::set_setting(&conn, "hint_bar_mode", "on-demand").expect("塞坏值失败");
        let s2 = get_settings_impl(&conn).expect("读设置失败");
        assert_eq!(s2.values.get("backlog_pane").map(String::as_str), Some("open"));
        assert_eq!(s2.values.get("hint_bar_mode").map(String::as_str), Some("always"));
        db::set_setting(&conn, "backlog_pane", "hidden").expect("塞旧值失败");
        assert_eq!(
            get_settings_impl(&conn)
                .expect("读设置失败")
                .values
                .get("backlog_pane")
                .map(String::as_str),
            Some("rail"),
            "旧库存过 hidden 读回 rail"
        );
    }

    /// round79（78-01）：**恢复默认设置** —— 白名单键回默认、**语言保留**、**数据一行不动**。
    /// 默认值不另写一份：拿一份全新的库（`fresh`）当**比值口径**。
    #[test]
    fn test_reset_settings_keeps_locale_and_data() {
        let conn = db::test_conn();
        let fresh = db::test_conn();
        let task = db::create_task(&conn, "任务", None).expect("建任务");
        db::create_block(&conn, &task.id, 1_000, 4_000).expect("建块");
        let blocks_before = db::count_blocks(&conn).expect("数块");
        let tasks_before = db::list_tasks(&conn).expect("任务表").len();

        // 改几项：预算 / 密度 / 一个功能开关 / 提醒档位 / 语言
        set_setting_impl(&conn, KEY_BUDGET, "180").expect("改预算");
        set_setting_impl(&conn, appearance::KEY_DENSITY, "loose").expect("改密度");
        set_setting_impl(&conn, features::STATS, "0").expect("关统计");
        set_setting_impl(&conn, KEY_REMIND_LEAD, "30").expect("改提醒档");
        set_setting_impl(&conn, i18n::KEY, "en").expect("切英文");
        let defaults = get_settings_impl(&fresh).expect("读新库默认");
        assert_ne!(
            get_settings_impl(&conn).expect("读改后").values[KEY_BUDGET],
            defaults.values[KEY_BUDGET],
            "先确认真的改动了（不然下面的比对什么都没验）"
        );

        reset_settings_impl(&conn).expect("恢复默认");

        let after = get_settings_impl(&conn).expect("读重置后");
        for (key, value) in &defaults.values {
            if key == i18n::KEY {
                continue; // 语言单独验
            }
            assert_eq!(after.values[key], *value, "键 {key} 应该回默认");
        }
        assert_eq!(after.values[i18n::KEY], "en", "语言保留（你 2026-10-06 拍板）");
        assert_eq!(db::count_blocks(&conn).expect("数块"), blocks_before, "块一行不删");
        assert_eq!(
            db::list_tasks(&conn).expect("任务表").len(),
            tasks_before,
            "任务一行不删"
        );
        // 内部键不在白名单里 → 不该被动过（拿一个真实存在的内部键验一下）
        db::set_setting(&conn, "review_nudged_week", "12345").expect("塞内部键");
        reset_settings_impl(&conn).expect("再恢复一次");
        assert_eq!(
            db::get_setting(&conn, "review_nudged_week").expect("读内部键"),
            Some("12345".to_string()),
            "内部键（水位线之类）不该被恢复默认删掉"
        );
    }
}
