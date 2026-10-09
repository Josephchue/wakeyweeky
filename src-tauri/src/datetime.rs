//! round81（3.1c₁ · `时-01…11`）：时间与日期显示的 **Rust 侧同一口径**（托盘 / 菜单）。
//!
//! - 前端唯一实现在 `src/lib/utils/datetime.svelte.ts`；这里是**同一套规则的 Rust 版**，
//!   只服务 Rust 侧需要渲染钟点的地方（目前 = 托盘的「静音至 …」菜单与 tooltip）。
//! - `system` 档的「12 小时还是 24 小时」在浏览器里由 `Intl` 的 CLDR 数据决定，Rust 没有 CLDR
//!   → 用一张**常见 h12 地区的近似表**（`H12_TAGS`）；表外一律 24 小时。差距只影响托盘那一行，
//!   且 `time_format` 选固定档时完全精确（见验收文档「诚实清单」）。
//! - 系统语言标签用 `sys-locale`（与 `i18n` 的「跟随系统」同一个来源，round81 加）。
//! - `.ics` / 文件名 / 时间戳**不经过这里**（`时-07`）。

use std::sync::atomic::{AtomicU8, Ordering};

use chrono::{Local, TimeZone};

pub const KEY_TIME_FORMAT: &str = "time_format";
pub const KEY_DATE_FORMAT: &str = "date_format";
pub const TIME_FORMATS: [&str; 3] = ["system", "h24", "h12"];
pub const DATE_FORMATS: [&str; 4] = ["system", "dash", "slash", "long"];
pub const DEFAULT_TIME_FORMAT: &str = "system";
pub const DEFAULT_DATE_FORMAT: &str = "system";

/// CLDR 里默认 12 小时制的常见地区（近似表；来源：本机 `Intl` 逐标签实测，见 `datetime` 单测注释）。
/// 匹配规则：精确相等 / `地区-*` 前缀；`zh-Hant`（繁体中文）整族按 12 小时。
const H12_TAGS: [&str; 26] = [
    "en", "en-US", "en-CA", "en-AU", "en-NZ", "en-IN", "en-SG", "en-PH", "es-MX", "es-US", "es-AR",
    "ar-SA", "ko-KR", "zh-TW", "zh-HK", "zh-SG", "hi-IN", "bn-IN", "ta-IN", "te-IN", "ms-MY",
    "fil-PH", "el-GR", "sq-AL", "km-KH", "am-ET",
];

static TIME: AtomicU8 = AtomicU8::new(0); // 0 = system, 1 = h24, 2 = h12
static DATE: AtomicU8 = AtomicU8::new(0); // 0 = system, 1 = dash, 2 = slash, 3 = long

/// 枚举键规范化：合法值原样返回，缺省 / 坏值回默认（**不报错** —— 旧库读得回来；与 `appearance::normalize` 同口径）
pub fn normalize(choices: &[&str], default: &str, raw: &str) -> String {
    let v = raw.trim();
    if choices.contains(&v) {
        v.to_string()
    } else {
        default.to_string()
    }
}

fn index_of(choices: &[&str], value: &str) -> u8 {
    let v = value.trim();
    choices.iter().position(|c| *c == v).unwrap_or(0) as u8
}

/// 读设置值 → 存进全局（启动读一次 / 改设置时再读一次）
pub fn set_time_format(value: &str) {
    TIME.store(index_of(&TIME_FORMATS, value), Ordering::SeqCst);
}
pub fn set_date_format(value: &str) {
    DATE.store(index_of(&DATE_FORMATS, value), Ordering::SeqCst);
}

pub fn time_format() -> &'static str {
    TIME_FORMATS[TIME.load(Ordering::SeqCst) as usize]
}
pub fn date_format() -> &'static str {
    DATE_FORMATS[DATE.load(Ordering::SeqCst) as usize]
}

fn system_tag() -> String {
    sys_locale::get_locale()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if crate::i18n::locale() == crate::i18n::EN {
                "en-US".to_string()
            } else {
                "zh-CN".to_string()
            }
        })
}

/// `system` 档是不是 12 小时制（近似表；`zh-Hant*` 整族按 12 小时）
fn system_is_12h(tag: &str) -> bool {
    let lower = tag.to_ascii_lowercase();
    // 整族按 12 小时：繁体中文（zh-Hant*）与阿拉伯语（ar*，CLDR 全族 h12）
    if lower.starts_with("zh-hant") || lower.starts_with("ar") {
        return true;
    }
    H12_TAGS.iter().any(|cand| {
        let c = cand.to_ascii_lowercase();
        lower == c || (c.contains('-') && lower.starts_with(&format!("{c}-")))
    })
}

/// 单个时刻（纯核心；`sys_tag` / `ui_zh` 显式传入，测试能钉死）
pub fn format_clock_at(sec: i64, time: &str, sys_tag: &str, ui_zh: bool) -> String {
    let dt = match Local.timestamp_opt(sec, 0).single() {
        Some(dt) => dt,
        None => return "-".to_string(),
    };
    let twelve = match time {
        "h12" => true,
        "h24" => false,
        _ => system_is_12h(sys_tag),
    };
    if !twelve {
        return dt.format("%H:%M").to_string();
    }
    if ui_zh {
        let hour = dt.format("%H").to_string().parse::<u32>().unwrap_or(0);
        let period = if hour < 12 {
            crate::i18n::t(crate::i18n::msg::MSG_DATETIME_03)
        } else {
            crate::i18n::t(crate::i18n::msg::MSG_DATETIME_04)
        };
        format!("{period}{}", dt.format("%-I:%M"))
    } else {
        dt.format("%-I:%M %p").to_string()
    }
}

/// 日期**片段**（月日；`静音至 …` 用）：dash `10-05` · slash `10/05` · long `10月5日` / `Oct 5` · system `10/5`（近似）
pub fn format_date_fragment_at(sec: i64, date: &str, ui_zh: bool) -> String {
    let dt = match Local.timestamp_opt(sec, 0).single() {
        Some(dt) => dt,
        None => return "-".to_string(),
    };
    match date {
        "dash" => dt.format("%m-%d").to_string(),
        "slash" => dt.format("%m/%d").to_string(),
        "long" => {
            if ui_zh {
                crate::tf!(
                    crate::i18n::msg::MSG_DATETIME_01,
                    m = dt.format("%-m").to_string(),
                    d = dt.format("%-d").to_string()
                )
            } else {
                dt.format("%b %-d").to_string()
            }
        }
        // system：近似（zh / en-US 的月份在前、不补零；表外地区的顺序差异只影响托盘这一行）
        _ => dt.format("%-m/%-d").to_string(),
    }
}

/// 托盘用的日期 + 时刻：`10/5 20:30` / `Oct 5 8:30 PM`（跟当前全局设置）
pub fn format_stamp(sec: i64) -> String {
    let ui_zh = crate::i18n::locale() == crate::i18n::ZH;
    let tag = system_tag();
    format!(
        "{} {}",
        format_date_fragment_at(sec, date_format(), ui_zh),
        format_clock_at(sec, time_format(), &tag, ui_zh),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// round83（Step 0 基线发现）：`TIME` / `DATE` 是**全局** atomics，而 `cargo test` 默认多线程 ——
    /// 三个动这两档的用例互相踩（实测：只跑本模块 8 次红 4 次，
    /// `test_format_stamp_follows_global_formats` 拿到别人还原的 `system` 档 → 「10/5」≠「10-05」）。
    /// 凡是读写这两档的用例先拿这把锁（串行化；结尾仍各自还原默认）。
    static FORMAT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 拿锁（若前面有用例 panic 过，毒化不传染）
    fn lock_formats() -> std::sync::MutexGuard<'static, ()> {
        FORMAT_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 本地时间戳（月从 1 数）
    fn ts(y: i32, m: u32, d: u32, h: u32, mi: u32) -> i64 {
        Local
            .with_ymd_and_hms(y, m, d, h, mi, 0)
            .single()
            .unwrap()
            .timestamp()
    }

    #[test]
    fn test_clock_fixed_formats() {
        // 24 小时：零填充（= 旧行为）
        assert_eq!(format_clock_at(ts(2026, 10, 5, 20, 30), "h24", "zh-CN", true), "20:30");
        assert_eq!(format_clock_at(ts(2026, 10, 5, 8, 0), "h24", "zh-CN", true), "08:00");
        // 12 小时：整点不省 `:00`（时-11）；zh = 上午/下午前缀、en = AM/PM 后缀
        assert_eq!(format_clock_at(ts(2026, 10, 5, 8, 0), "h12", "zh-CN", true), "上午8:00");
        assert_eq!(format_clock_at(ts(2026, 10, 5, 20, 30), "h12", "zh-CN", true), "下午8:30");
        assert_eq!(format_clock_at(ts(2026, 10, 5, 20, 30), "h12", "en-US", false), "8:30 PM");
        assert_eq!(format_clock_at(ts(2026, 10, 5, 0, 5), "h12", "en-US", false), "12:05 AM");
    }

    #[test]
    fn test_clock_system_follows_tag_table() {
        assert_eq!(format_clock_at(ts(2026, 10, 5, 20, 30), "system", "zh-CN", true), "20:30");
        assert_eq!(format_clock_at(ts(2026, 10, 5, 20, 30), "system", "en-US", false), "8:30 PM");
        assert_eq!(format_clock_at(ts(2026, 10, 5, 20, 30), "system", "en-GB", false), "20:30");
        assert_eq!(format_clock_at(ts(2026, 10, 5, 20, 30), "system", "de-DE", false), "20:30");
        // zh-Hant 整族（繁体中文）按 12 小时
        assert_eq!(format_clock_at(ts(2026, 10, 5, 20, 30), "system", "zh-Hant-TW", true), "下午8:30");
        // ar 家族（CLDR 全族 h12；以前不在表里 → 算 24 小时 —— 6b 复核指出）
        assert_eq!(format_clock_at(ts(2026, 10, 5, 20, 30), "system", "ar-EG", true), "下午8:30");
    }

    #[test]
    fn test_date_fragment_formats() {
        assert_eq!(format_date_fragment_at(ts(2026, 10, 5, 8, 0), "dash", true), "10-05");
        assert_eq!(format_date_fragment_at(ts(2026, 10, 5, 8, 0), "slash", true), "10/05");
        assert_eq!(format_date_fragment_at(ts(2026, 10, 5, 8, 0), "long", true), "10月5日");
        assert_eq!(format_date_fragment_at(ts(2026, 10, 5, 8, 0), "long", false), "Oct 5");
        // system 近似：zh / en-US 都是月在前不补零（与前端 Intl 输出一致）
        assert_eq!(format_date_fragment_at(ts(2026, 10, 5, 8, 0), "system", true), "10/5");
        assert_eq!(format_date_fragment_at(ts(2026, 10, 5, 8, 0), "system", false), "10/5");
    }

    #[test]
    fn test_set_get_roundtrip_and_normalize() {
        let _g = lock_formats();
        // 坏值 / 缺省 → system（不 panic，旧库读得回来）
        set_time_format("垃圾");
        assert_eq!(time_format(), "system");
        set_date_format("");
        assert_eq!(date_format(), "system");
        set_time_format("h12");
        assert_eq!(time_format(), "h12");
        set_date_format("long");
        assert_eq!(date_format(), "long");
        // 读路径规范化：合法值原样，缺省 / 坏值回默认
        assert_eq!(normalize(&TIME_FORMATS, DEFAULT_TIME_FORMAT, "h24"), "h24");
        assert_eq!(normalize(&DATE_FORMATS, DEFAULT_DATE_FORMAT, "斜线"), "system");
        // 还原默认，别把全局状态留给后面的用例
        set_time_format(DEFAULT_TIME_FORMAT);
        set_date_format(DEFAULT_DATE_FORMAT);
    }

    /// round82（§5-DP）：托盘戳 `format_stamp` —— 拼的是**当前全局**的日期 / 时刻两档
    #[test]
    fn test_format_stamp_follows_global_formats() {
        let _g = lock_formats();
        let sec = ts(2026, 10, 5, 20, 30);
        // 固定档：完全确定的一行（不受系统标签影响）
        set_time_format("h24");
        set_date_format("dash");
        assert_eq!(format_stamp(sec), "10-05 20:30");
        // 12 小时 + 长式：日期与时刻各自跟着档位变（语言不同只是 AM/PM ↔ 上午/下午）
        set_time_format("h12");
        set_date_format("long");
        let stamp = format_stamp(sec);
        assert!(stamp.ends_with("8:30 PM") || stamp.ends_with("下午8:30"), "{stamp}");
        assert!(stamp.contains("5"), "{stamp}");
        // 还原默认，别把全局状态留给后面的用例
        set_time_format(DEFAULT_TIME_FORMAT);
        set_date_format(DEFAULT_DATE_FORMAT);
    }

    /// round82（§5-DP）：`system_tag` 的回落 —— 不管 `sys-locale` 拿到什么，都得是个非空、能用的标签
    #[test]
    fn test_system_tag_is_non_empty_and_usable() {
        let _g = lock_formats();
        let tag = system_tag();
        assert!(!tag.trim().is_empty(), "拿不到系统语言时也要有回落标签");
        // 不崩且能拼出一行托盘戳（日期片段用 `system` 近似：zh / en 都是 `10/5`）
        set_time_format("system");
        set_date_format("system");
        let stamp = format_stamp(ts(2026, 10, 5, 8, 5));
        assert!(stamp.contains("10/5"), "托盘戳要带日期片段：{stamp}");
        assert!(stamp.contains(':'), "托盘戳要带时刻：{stamp}");
        set_time_format(DEFAULT_TIME_FORMAT);
        set_date_format(DEFAULT_DATE_FORMAT);
    }
}
