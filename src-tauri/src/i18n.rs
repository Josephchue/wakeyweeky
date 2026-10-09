// round73（3.0b₁）：文案资源层的 Rust 侧（唯一实现）。
//
// - 数据源 = 仓库根 `messages/{zh,en}.json` —— 与前端**同一份**（`src/lib/i18n/i18n.svelte.ts` 也 import 它们）。
// - `build.rs` 在编译期解析两份 JSON，生成 `$OUT_DIR/i18n_generated.rs`：
//     · `msg::<KEY>` 常量（打字错 = **编译错**，B5/B7；常量名以**中文表**的键集为准）
//     · `TABLE_ZH` / `TABLE_EN`（key → 文本）：查不到 key = 构建期就该发现（表是生成的），运行期兜底返回 key 本身
// - round74（3.0b₂）：加**语言维度** —— 全局 `LOCALE`（启动时读设置、切换时由命令层更新）；
//   英文缺键回落中文（本批判据要求 en 0 缺；回落只是兜底）。
// - `fill()` 与前端 `fill()` 同一套口径：`{name}` 占位、`{{`/`}}` 转义、未提供的占位原样保留（B1/B2）。

use std::sync::atomic::{AtomicU8, Ordering};

include!(concat!(env!("OUT_DIR"), "/i18n_generated.rs"));

/// 当前语言（0 = zh，1 = en）。默认中文 = 旧行为（旧库没有这个键也读到这儿）。
static LOCALE: AtomicU8 = AtomicU8::new(0);

/// 语言设置键（白名单里用它；与前端 `stores/settings.svelte.ts` 同一字符串）
pub const KEY: &str = "ui_locale";
pub const ZH: &str = "zh";
pub const EN: &str = "en";
/// round81（3.1c₁ · 深-03）：**跟随系统**（设置里的第四档；默认值）
pub const SYSTEM: &str = "system";

/// 设置值（choice）规范化：只认 `system` / `zh` / `en`；其余（旧库 / 非法值 / 空串）→ `system`（新默认）
pub fn normalize_choice(value: &str) -> &'static str {
    match value.trim() {
        EN => EN,
        ZH => ZH,
        SYSTEM => SYSTEM,
        _ => SYSTEM,
    }
}

/// 系统语言标签 → zh / en（纯函数，单测直接跑）。
/// `None` / 空串 = 取不到 → **zh**（回落旧行为）；`zh*` → zh；其余 → en。
pub fn resolve_tag(tag: Option<&str>) -> &'static str {
    match tag {
        None => ZH,
        Some(t) if t.trim().is_empty() => ZH,
        Some(t) if t.trim().to_ascii_lowercase().starts_with("zh") => ZH,
        _ => EN,
    }
}

/// choice → **实际语言**（`system` 用 `sys-locale` 取系统语言；单源在这里）
pub fn resolve(choice: &str) -> &'static str {
    match normalize_choice(choice) {
        EN => EN,
        ZH => ZH,
        _ => resolve_tag(sys_locale::get_locale().as_deref()),
    }
}

/// `system` 档当前的**系统语言标签**（BCP-47；前端 `system_locale` 命令读它）。
/// 为什么给原始标签而不是 `zh`/`en`：时间格式的「跟随系统」也要**同一个来源** ——
/// `en-GB`（24 小时）与 `en-US`（12 小时）压成一个 `en` 就分不出来了。
pub fn system_tag() -> String {
    sys_locale::get_locale()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| if LOCALE.load(Ordering::SeqCst) == 1 { "en-US".into() } else { "zh-CN".into() })
}


/// 设置全局语言（启动读设置 / 切换命令都走这儿）—— `system` 会被解析成实际语言
pub fn set_locale(value: &str) {
    LOCALE.store(if resolve(value) == EN { 1 } else { 0 }, Ordering::SeqCst);
}

/// 当前语言（`"zh"` / `"en"`）—— 断言与托盘菜单重建用
pub fn locale() -> &'static str {
    if LOCALE.load(Ordering::SeqCst) == 1 { EN } else { ZH }
}

fn table() -> &'static [(&'static str, &'static str)] {
    if LOCALE.load(Ordering::SeqCst) == 1 { TABLE_EN } else { TABLE_ZH }
}

/// 在指定的表里找 key（单测直接用它，不碰全局状态）
fn pick(table: &'static [(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// 取一条文案。key 一律来自生成的 `msg::*` 常量（`&'static str`，所以兜底能原样返回它）。
/// 英文缺键 → 回落中文（兜底；本批判据要求 en 0 缺）。
pub fn t(key: &'static str) -> &'static str {
    pick(table(), key).or_else(|| pick(TABLE_ZH, key)).unwrap_or(key)
}

/// 填占位：与前端 `fill()` 同一个算法（**不做 format! 的运行时解析**，避免格式串注入）。
pub fn fill(key: &'static str, args: &[(&str, String)]) -> String {
    render(t(key), args)
}

/// 模板渲染本体（单独拆出来，单测能直接跑 `{{`/`}}` 与未知占位）
fn render(template: &str, args: &[(&str, String)]) -> String {
    let mut out = String::with_capacity(template.len() + 16);
    let mut rest = template;
    loop {
        let Some(idx) = rest.find(['{', '}']) else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..idx]);
        let after = &rest[idx..];
        if let Some(r) = after.strip_prefix("{{") {
            out.push('{');
            rest = r;
            continue;
        }
        if let Some(r) = after.strip_prefix("}}") {
            out.push('}');
            rest = r;
            continue;
        }
        // round74（6b P2-10）：必须是**占位体**才找闭合 —— 单个 '}' 后面再有 '}' 不算占位
        // （否则 `}y}` 会把 y 当参数名；前端 fill() 一直没这个分支，两边口径对不上）
        if let Some(body) = after.strip_prefix('{') {
            if let Some(close) = body.find('}') {
                let name = &body[..close];
                if let Some((_, value)) = args.iter().find(|(n, _)| *n == name) {
                    out.push_str(value);
                } else {
                    out.push('{');
                    out.push_str(&body[..close + 1]);
                }
                rest = &body[close + 1..];
                continue;
            }
        }
        // 半截占位 / 单个 '}' → 原样吐出来
        out.push_str(&after[..1]);
        rest = &after[1..];
    }
    out
}

/// `format!` 的替代：`tf!(msg::X)` / `tf!(msg::X, e = e, p1 = format!("{:02}", n))`。
/// 冒号格式（`{:?}` / `{:02}`）由调用点自己 `format!` 好再传进来（见迁移工具）。
#[macro_export]
macro_rules! tf {
    ($key:expr) => {
        $crate::i18n::t($key).to_string()
    };
    ($key:expr, $($name:ident = $val:expr),+ $(,)?) => {
        $crate::i18n::fill($key, &[$((stringify!($name), ($val).to_string())),+])
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fill_leaves_unknown_placeholder() {
        // B1：没给的占位原样保留（抽一条带占位的真消息）
        assert_eq!(fill("ui.timeline.11", &[]), "落点 {span} · {duration}");
        // 多给的参数忽略
        assert_eq!(fill("ui.hint_bar.03", &[("nope", "x".into())]), "要不要把上周存成模板？");
    }

    #[test]
    fn test_escape_double_braces() {
        // B2：{{ }} 是字面花括号；{name} 是占位；未知占位原样保留
        assert_eq!(render("a{{b}}c{x}d{nope}", &[("x", "X".into())]), "a{b}cXd{nope}");
    }

    #[test]
    fn test_lone_closing_brace_is_not_placeholder() {
        // round74（6b P2-10）：单个 '}' 后面还有 '}' —— 不能把中间的词当参数名
        // （与前端 fill() 同一口径；`braces` 扫描器挡着这类模板，属于双保险）
        assert_eq!(render("}y}", &[("y", "Y".into())]), "}y}");
        assert_eq!(render("} {y}", &[("y", "Y".into())]), "} Y");
        assert_eq!(render("}y{x}", &[("y", "Y".into()), ("x", "X".into())]), "}yX");
    }

    #[test]
    fn test_locale_normalize_and_tables() {
        // round74（3.0b₂）：只认字面 en；其余一律中文（旧库 / 非法值 = 旧行为）
        // round81（3.1c₁ · 深-03）：值域扩成 system / zh / en，坏值回 `system`；解析规则单测：
        assert_eq!(normalize_choice("en"), EN);
        assert_eq!(normalize_choice(" en "), EN);
        assert_eq!(normalize_choice("zh"), ZH);
        assert_eq!(normalize_choice("system"), SYSTEM);
        assert_eq!(normalize_choice("EN"), SYSTEM, "大小写不算（旧库坏值 → 新默认 system）");
        assert_eq!(normalize_choice(""), SYSTEM);
        // `system` 的解析：zh* → zh；其余 → en；取不到 → zh（回落旧行为）
        assert_eq!(resolve_tag(Some("zh-CN")), ZH);
        assert_eq!(resolve_tag(Some("zh-Hant-TW")), ZH);
        assert_eq!(resolve_tag(Some("en-US")), EN);
        assert_eq!(resolve_tag(Some("de-DE")), EN);
        assert_eq!(resolve_tag(None), ZH);
        assert_eq!(resolve_tag(Some("  ")), ZH);
        // 固定档不查系统
        assert_eq!(resolve("zh"), ZH);
        assert_eq!(resolve("en"), EN);
        // system_tag 非空，且能被同一套 `resolve_tag` 吃下去（语言 / 时间格式同源的前提）
        let tag = system_tag();
        assert!(!tag.trim().is_empty(), "系统标签不能为空");
        assert!(matches!(resolve_tag(Some(&tag)), ZH | EN));
        // 两张表都能查到同一个 key（本批要求 en 0 缺）；不碰全局 LOCALE，避免并行测试互相影响
        for key in [msg::SYS_TRAY_MOD_04, msg::ERR_CMD_SETTINGS_01] {
            assert!(pick(TABLE_ZH, key).is_some(), "中文表缺 {key}");
            assert!(pick(TABLE_EN, key).is_some(), "英文表缺 {key}");
        }
        // 缺键回落：构造一个两张表都没有的 key（t() 会原样返回 key）
        assert_eq!(pick(TABLE_EN, "no.such.key"), None);
    }

    #[test]
    fn test_en_table_covers_every_zh_key() {
        // round74（3.0b₂ / 6b 二轮）：英文表必须覆盖中文表的每个键 ——
        // 复数键（`x.one` / `x.other`）算覆盖（`tn()` 用；中文侧保留 base）。
        // 这条等价于 check.mjs 第 6 组的「键齐 + 无中文」，但在编译产物上再兜一道。
        let is_cjk = |c: char| {
            matches!(c as u32, 0x3000..=0x303F | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF)
        };
        let mut missing = Vec::new();
        for (key, _) in TABLE_ZH {
            let covered = pick(TABLE_EN, key).is_some()
                || (pick(TABLE_EN, &format!("{key}.one")).is_some()
                    && pick(TABLE_EN, &format!("{key}.other")).is_some());
            if !covered {
                missing.push(*key);
            }
        }
        let head: Vec<_> = missing.iter().take(5).collect();
        assert!(missing.is_empty(), "英文表缺 {} 个键（前 5：{head:?}）", missing.len());
        for (key, value) in TABLE_EN {
            assert!(!value.trim().is_empty(), "{key} 英文值为空");
            assert!(!value.chars().any(is_cjk), "{key} 英文里还有汉字：{value}");
        }
    }
}
