//! round64（C10）：渐进式提示 —— 「首次用到某功能才提示一次」（一次一条、可一键全关）。
//!
//! 口径（`docs/plans/round64-c10-c11.md` §2.3）：
//! - 已看过的 id 存在内部键 `hints_seen`（JSON 数组）；`take_hint` 返回 true 即记「已看过」；
//! - 总开关 `hints_enabled` 关掉时一律 false 且**不记**（重新打开还能看到）；
//! - id 必须在白名单里（前端注册表与这里一一对应），未知 id 直接报错 —— 防垃圾键值。

use rusqlite::Connection;

use crate::db;
use crate::i18n;
use crate::tf;

/// 内部键：已看过的提示 id 列表（JSON）
pub const KEY_SEEN: &str = "hints_seen";

/// 提示 id 白名单（与前端 `src/lib/utils/hints.ts` 的注册表一一对应）
/// round69.1（#12）：`stretch` 那条教学提示按你的验收意见删掉了（拉伸的操作在键位栏/说明页里）。
/// round81（3.1c₁ · 宽-09）：+`zoom`（第一次用 Ctrl+滚轮时说明两个区域的语义）。
pub const HINTS: [&str; 4] = ["multi", "review", "temp", "zoom"];

/// 这一条提示现在该不该冒出来？该 → 返回 true **并记下已看过**（每条一生一次）。
pub fn take_hint(conn: &Connection, id: &str) -> Result<bool, String> {
    if !HINTS.contains(&id) {
        return Err(tf!(i18n::msg::SYS_HINTS_01, id = id));
    }
    if !crate::features::enabled(conn, crate::features::HINTS) {
        return Ok(false); // 关掉时不记 —— 打开后还能看到
    }
    let mut seen: Vec<String> = db::get_setting(conn, KEY_SEEN)?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if seen.iter().any(|s| s == id) {
        return Ok(false);
    }
    seen.push(id.to_string());
    let value = serde_json::to_string(&seen).map_err(|e| tf!(i18n::msg::SYS_HINTS_02, e = e))?;
    db::set_setting(conn, KEY_SEEN, &value)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{set_setting, test_conn};

    #[test]
    fn test_hint_once_per_life() {
        let conn = test_conn();
        assert!(take_hint(&conn, "multi").unwrap(), "第一次该冒头");
        assert!(!take_hint(&conn, "multi").unwrap(), "同一条只冒一次");
        assert!(take_hint(&conn, "temp").unwrap(), "别的 id 互不影响");
        assert!(take_hint(&conn, "zoom").unwrap(), "round81 的新提示 id 在白名单里");
        assert!(take_hint(&conn, "nope").is_err(), "未知 id 要报错");
        assert!(take_hint(&conn, "stretch").is_err(), "已删掉的 id 要报错（白名单已收）");
    }

    #[test]
    fn test_switch_off_does_not_record() {
        let conn = test_conn();
        set_setting(&conn, crate::features::HINTS, "0").unwrap();
        assert!(!take_hint(&conn, "multi").unwrap(), "关掉时不给");
        assert_eq!(db::get_setting(&conn, KEY_SEEN).unwrap(), None, "也不记");
        set_setting(&conn, crate::features::HINTS, "1").unwrap();
        assert!(take_hint(&conn, "multi").unwrap(), "再打开还能看到");
    }
}
