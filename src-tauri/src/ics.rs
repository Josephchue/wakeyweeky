//! round64（C11）：把排程导出成 `.ics`（RFC 5545）—— **唯一实现**（命令层只加锁与写文件）。
//!
//! ## 三条口径（证据在 `docs/plans/round64-c10-c11.md` §1.4 / §2.2）
//!
//! - **时间一律 UTC（带 `Z`）**：浮动本地时间在 Google 日历会被**当成 UTC**（国内差 8 小时）、
//!   Outlook 对定时事件「只支持全天浮动」；`TZID` 要配 `VTIMEZONE` 且经典 Outlook 对 IANA 名不稳。
//!   UTC 是三家都认的写法，且本仓本来就以 UTC 存时刻 → 无损。
//! - **手写、不引 `ical` 的 generator**：它强制 `TZID`、不发 `VTIMEZONE`、连 `DTSTAMP` 都带 `TZID`
//!   （违反 RFC 5545 §3.8.7.2「DTSTAMP 必须是 UTC」）。`ical` 只作 **dev-dependency** 在测试里解析
//!   我们写出的串做 round-trip 校验（那个 crate 本来就是给**导入**半场准备的）。
//! - **折行 75 字节且不许截半个 UTF-8 字符**：中文任务名是常态（见 `push_line` 的单测）。
//!
//! 状态映射：`planned` → `TENTATIVE` · `done`（含提前/超时）→ `CONFIRMED` · `missed` → `CANCELLED`。

use chrono::{TimeZone, Utc};
use rusqlite::Connection;

use crate::db;
use crate::i18n;
use crate::tf;

/// 一条待导出的事件（与数据库解耦，好单测）
#[derive(Debug, Clone, PartialEq)]
pub struct IcsEvent {
    /// 块 id（渲染时补 `@wakeyweeky`；重复导入不会在日历里炸出第二条）
    pub uid: String,
    pub summary: String,
    pub description: Option<String>,
    pub start_at: i64,
    pub end_at: i64,
    /// `TENTATIVE` / `CONFIRMED` / `CANCELLED`（由 `status_for` 算，不在这层判断）
    pub status: &'static str,
}

/// 块状态 → VEVENT STATUS（终态细分不影响这条：提前/超时都还是「完成了」）
pub fn status_for(status: &str, _final_status: Option<&str>) -> &'static str {
    match status {
        "done" => "CONFIRMED",
        "missed" => "CANCELLED",
        _ => "TENTATIVE", // planned（或将来出现的未知值：保守当「暂定」）
    }
}

/// RFC 5545 §3.3.11 的文本转义：`\` `;` `,` 转义，换行统一写 `\n`（裸 `\r` 丢掉）
fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            _ => out.push(ch),
        }
    }
    out
}

/// 写一行（CRLF 结尾）；超过 75 字节就折行 —— 续行以**一个空格**开头，且按 UTF-8 字符边界切
/// （RFC 5545 §3.1；中文按字节算很容易超 75，必须走这里，不许 `format!` 直拼）。
fn push_line(out: &mut String, line: &str) {
    const MAX_OCTETS: usize = 75;
    if line.len() <= MAX_OCTETS {
        out.push_str(line);
        out.push_str("\r\n");
        return;
    }
    let mut rest = line;
    let mut first = true;
    while !rest.is_empty() {
        // 续行开头要占一个空格 → 正文最多 74 字节
        let cap = if first { MAX_OCTETS } else { MAX_OCTETS - 1 };
        let mut end = rest.len().min(cap);
        while end > 0 && !rest.is_char_boundary(end) {
            end -= 1;
        }
        if !first {
            out.push(' ');
        }
        out.push_str(&rest[..end]);
        out.push_str("\r\n");
        rest = &rest[end..];
        first = false;
    }
}

/// Unix 秒 → `YYYYMMDDTHHMMSSZ`（导出统一 UTC）
fn utc_stamp(ts: i64) -> String {
    Utc.timestamp_opt(ts, 0)
        .single()
        .map(|t| t.format("%Y%m%dT%H%M%SZ").to_string())
        .unwrap_or_else(|| "19700101T000000Z".to_string())
}

/// 渲染整本日历（`now` 只用于 `DTSTAMP`，由调用方给 → 好测）
pub fn render_ics(events: &[IcsEvent], now: i64) -> String {
    let dtstamp = utc_stamp(now);
    let mut out = String::new();
    push_line(&mut out, "BEGIN:VCALENDAR");
    push_line(&mut out, "VERSION:2.0");
    push_line(&mut out, "PRODID:-//WakeyWeeky//WakeyWeeky//EN");
    push_line(&mut out, "CALSCALE:GREGORIAN");
    push_line(&mut out, "X-WR-CALNAME:WakeyWeeky");
    for e in events {
        push_line(&mut out, "BEGIN:VEVENT");
        push_line(&mut out, &format!("UID:{}@wakeyweeky", escape_text(&e.uid)));
        push_line(&mut out, &format!("DTSTAMP:{dtstamp}"));
        push_line(&mut out, &format!("DTSTART:{}", utc_stamp(e.start_at)));
        push_line(&mut out, &format!("DTEND:{}", utc_stamp(e.end_at)));
        push_line(&mut out, &format!("SUMMARY:{}", escape_text(&e.summary)));
        push_line(&mut out, &format!("STATUS:{}", e.status));
        if let Some(desc) = &e.description {
            if !desc.is_empty() {
                push_line(&mut out, &format!("DESCRIPTION:{}", escape_text(desc)));
            }
        }
        push_line(&mut out, "END:VEVENT");
    }
    push_line(&mut out, "END:VCALENDAR");
    out
}

/// 从库里读**全部**块（按开始时间升序）→ 事件列表。
/// 临时安排块用 `label`（空则「临时安排」）；普通块用任务名；`DESCRIPTION` 写层与分类。
pub fn collect_events(conn: &Connection) -> Result<Vec<IcsEvent>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT b.id, b.start_at, b.end_at, b.status, b.final_status, b.label, b.layer,
                    b.task_id, t.title, t.category
             FROM blocks b JOIN tasks t ON t.id = b.task_id
             ORDER BY b.start_at, b.rowid",
        )
        .map_err(|e| tf!(i18n::msg::ERR_ICS_01, e = e))?;
    let rows = stmt
        .query_map([], |row| {
            let task_id: String = row.get(7)?;
            let is_temp = task_id == db::TEMP_TASK_ID;
            let label: Option<String> = row.get(5)?;
            let title: String = row.get(8)?;
            let category: Option<String> = row.get(9)?;
            let layer: String = row.get(6)?;
            let summary = if is_temp {
                label.filter(|l| !l.trim().is_empty()).unwrap_or_else(|| i18n::t(i18n::msg::ERR_ICS_02).to_string())
            } else {
                title
            };
            let layer_text = if layer == "required" { i18n::t(i18n::msg::ERR_ICS_03) } else { i18n::t(i18n::msg::ERR_ICS_04) };
            let description = match category.filter(|c| !c.trim().is_empty()) {
                Some(cat) => tf!(i18n::msg::ERR_ICS_05, layer_text = layer_text, cat = cat),
                None => layer_text.to_string(),
            };
            Ok(IcsEvent {
                uid: row.get(0)?,
                summary,
                description: Some(description),
                start_at: row.get(1)?,
                end_at: row.get(2)?,
                status: status_for(&row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?.as_deref()),
            })
        })
        .map_err(|e| tf!(i18n::msg::ERR_ICS_06, e = e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| tf!(i18n::msg::ERR_ICS_07, e = e))?);
    }
    Ok(out)
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_block, create_task, create_temp_block, mark_block_done_at, mark_block_missed, test_conn};

    fn utc(y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        Utc.with_ymd_and_hms(y, m, d, h, min, 0).unwrap().timestamp()
    }

    fn sample(uid: &str, start: i64, end: i64, status: &'static str) -> IcsEvent {
        IcsEvent {
            uid: uid.to_string(),
            summary: "写周报".to_string(),
            description: Some("弹性层".to_string()),
            start_at: start,
            end_at: end,
            status,
        }
    }

    /// 基本骨架 + CRLF + 无 TZID / 无浮动时间
    #[test]
    fn test_basic_shape_utc_and_no_tzid() {
        let text = render_ics(&[sample("b1", utc(2026, 10, 5, 1, 0), utc(2026, 10, 5, 2, 30), "TENTATIVE")], utc(2026, 10, 4, 12, 0));
        assert!(text.starts_with("BEGIN:VCALENDAR\r\n"));
        assert!(text.ends_with("END:VCALENDAR\r\n"));
        assert!(text.contains("VERSION:2.0\r\n"));
        assert!(text.contains("PRODID:-//WakeyWeeky//WakeyWeeky//EN\r\n"));
        assert!(text.contains("UID:b1@wakeyweeky\r\n"));
        assert!(text.contains("DTSTAMP:20261004T120000Z\r\n"));
        // 国内 09:00 = 01:00Z（库里存的就是瞬时；导出不带 TZID）
        assert!(text.contains("DTSTART:20261005T010000Z\r\n"), "text={text}");
        assert!(text.contains("DTEND:20261005T023000Z\r\n"));
        assert!(!text.contains("TZID"), "导出统一 UTC，不许出现 TZID");
        // 每一行都以 \r\n 结尾（不许有裸 \n）
        for line in text.split("\r\n") {
            assert!(!line.contains('\n'), "裸 \\n 出现在：{line}");
        }
    }

    /// 状态映射：planned / done（含终态细分）/ missed
    #[test]
    fn test_status_mapping() {
        assert_eq!(status_for("planned", None), "TENTATIVE");
        assert_eq!(status_for("done", None), "CONFIRMED");
        assert_eq!(status_for("done", Some("done_overtime")), "CONFIRMED");
        assert_eq!(status_for("done", Some("done_short")), "CONFIRMED");
        assert_eq!(status_for("missed", None), "CANCELLED");
        assert_eq!(status_for("未来未知", None), "TENTATIVE");
    }

    /// 转义：反斜杠 / 分号 / 逗号 / 换行
    #[test]
    fn test_escape_text() {
        let text = render_ics(
            &[IcsEvent {
                uid: "b1".into(),
                summary: "写,周;报\\总结\n第二行".into(),
                description: None,
                start_at: utc(2026, 10, 5, 1, 0),
                end_at: utc(2026, 10, 5, 2, 0),
                status: "TENTATIVE",
            }],
            utc(2026, 10, 4, 0, 0),
        );
        assert!(text.contains("SUMMARY:写\\,周\\;报\\\\总结\\n第二行\r\n"), "text={text}");
    }

    /// 折行：每行 ≤75 字节、续行以空格开头、展开后还原（含中文，不许截半）
    #[test]
    fn test_folding_is_utf8_safe_and_reversible() {
        let long = "很长很长的任务名字".repeat(12); // 9 字 ×3 字节 ×12 = 324 字节
        let text = render_ics(
            &[IcsEvent {
                uid: "b1".into(),
                summary: long.clone(),
                description: None,
                start_at: utc(2026, 10, 5, 1, 0),
                end_at: utc(2026, 10, 5, 2, 0),
                status: "TENTATIVE",
            }],
            utc(2026, 10, 4, 0, 0),
        );
        let mut unfolded = String::new();
        for line in text.split("\r\n") {
            if let Some(stripped) = line.strip_prefix(' ') {
                unfolded.push_str(stripped);
            } else if !unfolded.is_empty() {
                unfolded.push('\n');
                unfolded.push_str(line);
            } else {
                unfolded.push_str(line);
            }
            // 每一行（含 CRLF 前）不超过 75 字节
            assert!(line.len() <= 75, "行超 75 字节（{}）：{line}", line.len());
        }
        assert!(unfolded.contains(&format!("SUMMARY:{long}")), "展开后应还原长标题");
        // UTF-8 边界：拆开是按字符切的，不会出现 replacement char
        assert!(!text.contains('\u{FFFD}'));
    }

    /// 空库也要是合法日历
    #[test]
    fn test_empty_calendar() {
        let text = render_ics(&[], utc(2026, 10, 4, 0, 0));
        assert!(text.contains("BEGIN:VCALENDAR"));
        assert!(text.contains("END:VCALENDAR"));
        assert!(!text.contains("BEGIN:VEVENT"));
    }

    /// 跨天块：DTEND 是次日（UTC）
    #[test]
    fn test_cross_day_end() {
        let text = render_ics(&[sample("b1", utc(2026, 10, 5, 23, 0), utc(2026, 10, 6, 1, 0), "CONFIRMED")], utc(2026, 10, 4, 0, 0));
        assert!(text.contains("DTSTART:20261005T230000Z\r\n"));
        assert!(text.contains("DTEND:20261006T010000Z\r\n"));
    }

    /// 两次渲染同一输入完全一致（没有隐藏的「现在」参与）
    #[test]
    fn test_render_is_deterministic() {
        let ev = vec![sample("b1", utc(2026, 10, 5, 1, 0), utc(2026, 10, 5, 2, 0), "TENTATIVE")];
        let now = utc(2026, 10, 4, 12, 0);
        assert_eq!(render_ics(&ev, now), render_ics(&ev, now));
    }

    /// 从库里读：临时块用 label（空 → 临时安排）、普通块用任务名、排序按开始时间
    #[test]
    fn test_collect_events_from_db() {
        let conn = test_conn();
        let task = create_task(&conn, "写周报", Some("工作")).unwrap();
        let b1 = create_block(&conn, &task.id, utc(2026, 10, 5, 1, 0), utc(2026, 10, 5, 2, 0)).unwrap();
        let temp = create_temp_block(&conn, utc(2026, 10, 5, 0, 0), utc(2026, 10, 5, 0, 30)).unwrap();
        // 临时块给个名字
        conn.execute("UPDATE blocks SET label = '晨会' WHERE id = ?1", [&temp.id]).unwrap();
        let b3 = create_block(&conn, &task.id, utc(2026, 10, 6, 1, 0), utc(2026, 10, 6, 2, 0)).unwrap();
        mark_block_done_at(&conn, &b3.id, utc(2026, 10, 6, 2, 10)).unwrap();
        mark_block_missed(&conn, &b1.id).unwrap();

        let events = collect_events(&conn).unwrap();
        assert_eq!(events.len(), 3);
        // 排序：10-05 00:00 临时块 → 10-05 01:00 块 → 10-06 块
        assert_eq!(events[0].summary, "晨会");
        assert_eq!(events[1].summary, "写周报");
        assert_eq!(events[1].status, "CANCELLED");
        assert_eq!(events[2].status, "CONFIRMED");
        assert_eq!(events[1].description.as_deref(), Some("弹性层 · 分类：工作"));
    }

    /// 独立解析器（`ical` crate，dev-dependency）能解析我们写出的串 —— round-trip 校验
    #[test]
    fn test_round_trip_with_ical_crate() {
        let events = vec![
            sample("b1", utc(2026, 10, 5, 1, 0), utc(2026, 10, 5, 2, 0), "TENTATIVE"),
            sample("b2", utc(2026, 10, 6, 1, 0), utc(2026, 10, 6, 2, 0), "CONFIRMED"),
        ];
        let text = render_ics(&events, utc(2026, 10, 4, 12, 0));
        let mut parsed = ical::IcalParser::new(text.as_bytes());
        let cal = parsed.next().expect("应能解析出日历").expect("解析不应报错");
        assert_eq!(cal.events.len(), 2);
        for (i, ev) in cal.events.iter().enumerate() {
            let prop = |name: &str| {
                ev.properties
                    .iter()
                    .find(|p| p.name == name)
                    .and_then(|p| p.value.clone())
            };
            assert_eq!(prop("UID").unwrap(), format!("b{}@wakeyweeky", i + 1));
            for key in ["DTSTAMP", "DTSTART", "DTEND"] {
                let value = prop(key).unwrap_or_else(|| panic!("缺 {key}"));
                assert!(value.ends_with('Z'), "{key} 应带 UTC 标记：{value}");
                assert!(
                    chrono::NaiveDateTime::parse_from_str(&value, "%Y%m%dT%H%M%SZ").is_ok(),
                    "{key} 应是 UTC 基本格式：{value}"
                );
            }
        }
    }
}
