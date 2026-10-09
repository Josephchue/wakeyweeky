//! round69（B3）：每周重复 —— 规则的校验/增删 + 「打开哪一周补哪一周」的生成扫描（唯一实现）。
//!
//! 边界表（plan `docs/plans/round69-b3-features.md` §二 B2）：
//! - 生成只发生在**打开某一周**时（`reloadWeek` → 命令 `generate_repeats`），一周围只处理一次（occurrences 水位线）；
//! - **已结束的时刻不补**（`end <= now`：不生成、不记水位线 —— 不制造「未执行」）；
//! - 目标时段与**任何现有块**相交 → 跳过并记水位线（这一周就此定案，不搞惊喜）；
//! - 时长 = 那条任务的「预估」（`est<=0 → 30`，否则向上取 15 分钟；与前端 `Backlog.dragMinutes` 同一口径）；
//! - 归档任务不生成（规则保留，取消归档即恢复）；任务删了规则跟着级联删。
//!
//! 谁在读它：`commands/repeats.rs`（规则 CRUD + 生成命令）；前端 `reloadWeek` 每次打开一周调一次生成。

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use uuid::Uuid;

use crate::db;
use crate::sanity::{local_day_add, local_day_start, week_start_of};
use crate::i18n;
use crate::tf;

/// 一个任务最多几条规则（防呆）
pub const MAX_RULES_PER_TASK: i64 = 20;
/// 生成块的最长时长（分钟）——与块的后端护栏同口径（72 小时）
pub const MAX_DURATION_MIN: i64 = 72 * 60;

/// 一条每周重复的规则（任务级）
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Repeat {
    pub id: String,
    pub task_id: String,
    /// 0 = 周一 … 6 = 周日
    pub weekday: i64,
    /// 相对当天 00:00 的分钟（0..1439）
    pub start_min: i64,
    pub layer: String,
    pub enabled: bool,
    pub created_at: i64,
}

fn row_to_repeat(row: &rusqlite::Row<'_>) -> rusqlite::Result<Repeat> {
    Ok(Repeat {
        id: row.get(0)?,
        task_id: row.get(1)?,
        weekday: row.get(2)?,
        start_min: row.get(3)?,
        layer: row.get(4)?,
        enabled: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
    })
}

/// 有没有可能生成的规则 —— 给命令层做「无规则就别拍快照」的快速探针（6b P2）
pub fn any_enabled(conn: &Connection) -> Result<bool, String> {
    conn.query_row("SELECT 1 FROM repeats WHERE enabled = 1 LIMIT 1", [], |_| Ok(true))
        .optional()
        .map(|hit| hit.unwrap_or(false))
        .map_err(|e| tf!(i18n::msg::ERR_REPEATS_01, e = e))
}

/// 「来自每周重复」的展示文字（时间轴的 `🔁` tooltip；也是 `Block.repeat_note` 的值）。
/// 周几的文字表只此一份 —— 前端不再自己拼。
pub fn note_text(weekday: i64, start_min: i64) -> String {
    const DAYS: [&str; 7] = [i18n::msg::ERR_REPEATS_02, i18n::msg::ERR_REPEATS_03, i18n::msg::ERR_REPEATS_04, i18n::msg::ERR_REPEATS_05, i18n::msg::ERR_REPEATS_06, i18n::msg::ERR_REPEATS_07, i18n::msg::ERR_REPEATS_08];
    let day = i18n::t(DAYS.get(weekday.rem_euclid(7) as usize).copied().unwrap_or(i18n::msg::ERR_REPEATS_09));
    tf!(i18n::msg::ERR_REPEATS_10, day = day, p1 = format!("{:02}", start_min / 60), p2 = format!("{:02}", start_min % 60))
}

/// 生成时用的时长（分钟）—— **与前端 `utils/duration.ts::estimateMinutes` 同一口径**（改一处必须改两处）：
/// 没填预估 = 30；填了就向上取整到 15 分钟（宁可多给，也别少于预估）。
pub fn duration_minutes(estimated_minutes: Option<i64>) -> i64 {
    match estimated_minutes {
        Some(e) if e > 0 => ((e + 14) / 15 * 15).clamp(15, MAX_DURATION_MIN),
        _ => 30,
    }
}

fn load_repeat(conn: &Connection, id: &str) -> Result<Repeat, String> {
    conn.query_row(
        "SELECT id, task_id, weekday, start_min, layer, enabled, created_at FROM repeats WHERE id = ?1",
        [id],
        row_to_repeat,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => i18n::t(i18n::msg::ERR_REPEATS_11).to_string(),
        other => tf!(i18n::msg::ERR_REPEATS_12, other = other),
    })
}

fn validate_layer(layer: &str) -> Result<String, String> {
    match layer {
        "required" | "elastic" => Ok(layer.to_string()),
        _ => Err(i18n::t(i18n::msg::ERR_REPEATS_13).to_string()),
    }
}

/// 规则名单（`task_id = Some` 只列那个任务的；新的在后）
pub fn list_repeats(conn: &Connection, task_id: Option<&str>) -> Result<Vec<Repeat>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, task_id, weekday, start_min, layer, enabled, created_at
             FROM repeats WHERE (?1 IS NULL OR task_id = ?1)
             ORDER BY created_at, rowid",
        )
        .map_err(|e| tf!(i18n::msg::ERR_REPEATS_14, e = e))?;
    let rows = stmt
        .query_map([task_id], row_to_repeat)
        .map_err(|e| tf!(i18n::msg::ERR_REPEATS_15, e = e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| tf!(i18n::msg::ERR_REPEATS_16, e = e))?);
    }
    Ok(out)
}

/// 建一条规则（校验 + 上限；非法值返回中文错误、**不落库**）
pub fn create_repeat(
    conn: &Connection,
    task_id: &str,
    weekday: i64,
    start_min: i64,
    layer: &str,
) -> Result<Repeat, String> {
    if !(0..=6).contains(&weekday) {
        return Err(i18n::t(i18n::msg::ERR_REPEATS_17).to_string());
    }
    if !(0..=1439).contains(&start_min) {
        return Err(i18n::t(i18n::msg::ERR_REPEATS_18).to_string());
    }
    let layer = validate_layer(layer)?;

    let archived: Option<Option<i64>> = conn
        .query_row("SELECT archived_at FROM tasks WHERE id = ?1", [task_id], |r| r.get(0))
        .optional()
        .map_err(|e| tf!(i18n::msg::ERR_REPEATS_19, e = e))?;
    let Some(archived_at) = archived else {
        return Err(i18n::t(i18n::msg::ERR_REPEATS_20).to_string());
    };
    if archived_at.is_some() {
        return Err(i18n::t(i18n::msg::ERR_REPEATS_21).to_string());
    }

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM repeats WHERE task_id = ?1", [task_id], |r| r.get(0))
        .map_err(|e| tf!(i18n::msg::ERR_REPEATS_22, e = e))?;
    if count >= MAX_RULES_PER_TASK {
        return Err(tf!(i18n::msg::ERR_REPEATS_23, MAX_RULES_PER_TASK = MAX_RULES_PER_TASK));
    }
    let dup: bool = conn
        .query_row(
            "SELECT 1 FROM repeats WHERE task_id = ?1 AND weekday = ?2 AND start_min = ?3",
            rusqlite::params![task_id, weekday, start_min],
            |_| Ok(true),
        )
        .optional()
        .map_err(|e| tf!(i18n::msg::ERR_REPEATS_24, e = e))?
        .unwrap_or(false);
    if dup {
        return Err(i18n::t(i18n::msg::ERR_REPEATS_25).to_string());
    }

    let repeat = Repeat {
        id: Uuid::new_v4().to_string(),
        task_id: task_id.to_string(),
        weekday,
        start_min,
        layer,
        enabled: true,
        created_at: db::now(),
    };
    conn.execute(
        "INSERT INTO repeats (id, task_id, weekday, start_min, layer, enabled, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            repeat.id,
            repeat.task_id,
            repeat.weekday,
            repeat.start_min,
            repeat.layer,
            i64::from(repeat.enabled),
            repeat.created_at,
        ],
    )
    .map_err(|e| tf!(i18n::msg::ERR_REPEATS_26, e = e))?;
    Ok(repeat)
}

/// round69.1（#4 / D2）：把这条规则**还没开始**的生成块连同它们的水位线一起撤下。
///
/// - 已开始 / 已完成的（`start_at <= at` 或已标记）一律留着 —— 那是历史；
/// - 水位线行一起删 → 重新启用且时刻还没到时，打开这一周会再排上（`generate_week` 幂等）；
/// - 块先删水位线（否则删块会把 `block_id` 置空、行留着 → 会挡住重新生成）；
/// - 返回撤下几块。调用方（暂停 / 删除）保证它在同一个 `record` 里（一步撤销）。
fn drop_unstarted_generated(conn: &Connection, repeat_id: &str, at: i64) -> Result<usize, String> {
    let picks: Vec<(i64, String)> = conn
        .prepare(
            "SELECT o.week_start, o.block_id FROM repeat_occurrences o JOIN blocks b ON b.id = o.block_id \
             WHERE o.repeat_id = ?1 AND b.status = 'planned' AND b.start_at > ?2",
        )
        .and_then(|mut st| {
            st.query_map(rusqlite::params![repeat_id, at], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|e| tf!(i18n::msg::ERR_REPEATS_27, e = e))?;
    if picks.is_empty() {
        return Ok(0);
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| tf!(i18n::msg::ERR_REPEATS_28, e = e))?;
    for (week_start, block_id) in &picks {
        tx.execute(
            "DELETE FROM repeat_occurrences WHERE repeat_id = ?1 AND week_start = ?2",
            rusqlite::params![repeat_id, week_start],
        )
        .map_err(|e| tf!(i18n::msg::ERR_REPEATS_29, e = e))?;
        tx.execute("DELETE FROM blocks WHERE id = ?1", [block_id])
            .map_err(|e| tf!(i18n::msg::ERR_REPEATS_30, e = e))?;
        // 与删块同一口径：统计页要能看到「删了几块」（一次命令一条）
        tx.execute(
            "INSERT INTO events (id, block_id, event_type, payload, created_at) \
             VALUES (?1, ?2, 'delete', ?3, ?4)",
            rusqlite::params![
                Uuid::new_v4().to_string(),
                block_id,
                serde_json::json!({ "count": 1, "repeat_pause": true }).to_string(),
                at
            ],
        )
        .map_err(|e| tf!(i18n::msg::ERR_REPEATS_31, e = e))?;
    }
    tx.commit().map_err(|e| tf!(i18n::msg::ERR_REPEATS_32, e = e))?;
    Ok(picks.len())
}

/// 暂停 / 启用（不存在 → 报错）。
///
/// round69.1（#4 / D2）：**暂停**顺手把还没开始的生成块也撤下（“取消”要真的取消掉）；
/// 已开始/已完成的块不追删（那是历史），启用时不动任何块。
pub fn set_repeat_enabled(conn: &Connection, id: &str, enabled: bool) -> Result<Repeat, String> {
    load_repeat(conn, id)?; // 不存在直接报错（与旧口径一致）
    if !enabled {
        let removed = drop_unstarted_generated(conn, id, db::now())?;
        if removed > 0 {
            eprintln!("[repeats] 暂停规则 {id}：撤下 {removed} 条未开始的生成块");
        }
    }
    conn.execute(
        "UPDATE repeats SET enabled = ?1 WHERE id = ?2",
        rusqlite::params![i64::from(enabled), id],
    )
    .map_err(|e| tf!(i18n::msg::ERR_REPEATS_33, e = e))?;
    load_repeat(conn, id)
}

/// 删一条规则（不存在 → 报错；occurrences 跟着 CASCADE）。
///
/// round69.1（#4 / D2）：同暂停 —— 还没开始的生成块先撤下（已开始/已完成的留着）。
pub fn delete_repeat(conn: &Connection, id: &str) -> Result<(), String> {
    let removed = drop_unstarted_generated(conn, id, db::now())?;
    if removed > 0 {
        eprintln!("[repeats] 删除规则 {id}：撤下 {removed} 条未开始的生成块");
    }
    let affected = conn
        .execute("DELETE FROM repeats WHERE id = ?1", [id])
        .map_err(|e| tf!(i18n::msg::ERR_REPEATS_34, e = e))?;
    if affected == 0 {
        return Err(i18n::t(i18n::msg::ERR_REPEATS_35).to_string());
    }
    Ok(())
}

/// 「打开哪一周补哪一周」：把这一周该有的重复块补齐，返回**新建的块数**。
///
/// 幂等：处理过的 occurrence 记水位线（生成 / 跳过都记）；已结束的时刻不生成也不记。
pub fn generate_week(conn: &Connection, week_start: i64, now: i64) -> Result<usize, String> {
    let base = week_start_of(local_day_start(week_start));
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| tf!(i18n::msg::ERR_REPEATS_36, e = e))?;

    // 先拉规则（启用的 + 任务未归档的）—— 语句借用 tx，先把数据收进口袋再写
    let rules: Vec<(String, String, i64, i64, String, Option<i64>)> = {
        let mut stmt = tx
            .prepare(
                "SELECT r.id, r.task_id, r.weekday, r.start_min, r.layer, t.estimated_minutes
                 FROM repeats r JOIN tasks t ON t.id = r.task_id
                 WHERE r.enabled = 1 AND t.archived_at IS NULL
                 ORDER BY r.created_at, r.rowid",
            )
            .map_err(|e| tf!(i18n::msg::ERR_REPEATS_37, e = e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .map_err(|e| tf!(i18n::msg::ERR_REPEATS_38, e = e))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| tf!(i18n::msg::ERR_REPEATS_39, e = e))?);
        }
        out
    };

    let mut created = 0usize;
    for (id, task_id, weekday, start_min, layer, estimate) in rules {
        let day = local_day_add(base, weekday);
        let start = day + start_min * 60;
        let end = start + duration_minutes(estimate) * 60;
        // ① 已经结束的 occurrence 不补也不记 —— 不制造「未执行」的今天
        if end <= now {
            continue;
        }
        // ② 这一周处理过就跳过（生成 / 跳过 / 用户删掉 都算处理过）
        let handled: bool = tx
            .query_row(
                "SELECT 1 FROM repeat_occurrences WHERE repeat_id = ?1 AND week_start = ?2",
                rusqlite::params![id, base],
                |_| Ok(true),
            )
            .optional()
            .map_err(|e| tf!(i18n::msg::ERR_REPEATS_40, e = e))?
            .unwrap_or(false);
        if handled {
            continue;
        }
        // ③ 与任何现有块相交 → 跳过并定案（以后空出来也不补 —— 不搞惊喜）
        let conflict: bool = tx
            .query_row(
                "SELECT 1 FROM blocks WHERE start_at < ?2 AND end_at > ?1 LIMIT 1",
                rusqlite::params![start, end],
                |_| Ok(true),
            )
            .optional()
            .map_err(|e| tf!(i18n::msg::ERR_REPEATS_41, e = e))?
            .unwrap_or(false);
        if conflict {
            tx.execute(
                "INSERT INTO repeat_occurrences (repeat_id, week_start, block_id, status, created_at)
                 VALUES (?1, ?2, NULL, 'skipped', ?3)",
                rusqlite::params![id, base, now],
            )
            .map_err(|e| tf!(i18n::msg::ERR_REPEATS_42, e = e))?;
            continue;
        }
        let block = db::create_repeat_block(&tx, &task_id, start, end, &layer)?;
        tx.execute(
            "INSERT INTO repeat_occurrences (repeat_id, week_start, block_id, status, created_at)
             VALUES (?1, ?2, ?3, 'created', ?4)",
            rusqlite::params![id, base, block.id, now],
        )
        .map_err(|e| tf!(i18n::msg::ERR_REPEATS_43, e = e))?;
        created += 1;
    }

    tx.commit().map_err(|e| tf!(i18n::msg::ERR_REPEATS_44, e = e))?;
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{archive_task, create_block, create_task, delete_task, list_blocks, test_conn};

    fn ts(y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        use chrono::{Local, TimeZone};
        let naive = chrono::NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, min, 0)
            .unwrap();
        Local
            .from_local_datetime(&naive)
            .earliest()
            .unwrap()
            .timestamp()
    }

    /// 测试用的固定「现在」：2031-01-15（周三）12:00；这一周从 2031-01-13（周一）零点起
    fn fixed_now() -> i64 {
        ts(2031, 1, 15, 12, 0)
    }
    fn week_from() -> i64 {
        ts(2031, 1, 13, 0, 0)
    }

    fn occurrence_status(conn: &Connection, repeat_id: &str, week: i64) -> Option<String> {
        conn.query_row(
            "SELECT status FROM repeat_occurrences WHERE repeat_id = ?1 AND week_start = ?2",
            rusqlite::params![repeat_id, week],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
    }

    /// 时长口径 = 拖任务出来那条（回归：口径漂了这条红）
    #[test]
    fn test_duration_minutes_matches_drag_rule() {
        assert_eq!(duration_minutes(None), 30, "没填预估 = 30");
        assert_eq!(duration_minutes(Some(0)), 30, "0 当没填");
        assert_eq!(duration_minutes(Some(1)), 15, "向上取整到 15");
        assert_eq!(duration_minutes(Some(15)), 15);
        assert_eq!(duration_minutes(Some(16)), 30);
        assert_eq!(duration_minutes(Some(75)), 75, "预估 75 → 75（不是 90）");
        assert_eq!(duration_minutes(Some(50)), 60, "预估 50 → 60（宁可多给）");
    }

    /// 规则校验：非法值不落库；上限 20 条；归档任务不许新建规则
    #[test]
    fn test_create_validates_rule() {
        let conn = test_conn();
        let t = create_task(&conn, "健身", None).unwrap();
        assert!(create_repeat(&conn, &t.id, 7, 0, "elastic").is_err(), "weekday 7 非法");
        assert!(create_repeat(&conn, &t.id, -1, 0, "elastic").is_err(), "weekday -1 非法");
        assert!(create_repeat(&conn, &t.id, 0, 1440, "elastic").is_err(), "start_min 1440 非法");
        assert!(create_repeat(&conn, &t.id, 0, -1, "elastic").is_err(), "start_min -1 非法");
        assert!(create_repeat(&conn, &t.id, 0, 0, "suggested").is_err(), "层只认两层");
        assert!(create_repeat(&conn, "no-such-task", 0, 0, "elastic").is_err(), "任务不存在");
        assert_eq!(list_repeats(&conn, Some(&t.id)).unwrap().len(), 0, "失败的不落库");

        let r = create_repeat(&conn, &t.id, 2, 19 * 60, "required").unwrap();
        assert_eq!((r.weekday, r.start_min, r.layer.as_str(), r.enabled), (2, 19 * 60, "required", true));
        assert_eq!(list_repeats(&conn, Some(&t.id)).unwrap().len(), 1);

        for i in 0..19 {
            create_repeat(&conn, &t.id, 0, i as i64, "elastic").unwrap();
        }
        assert!(create_repeat(&conn, &t.id, 0, 0, "elastic").is_err(), "第 21 条应被拒");

        let archived = create_task(&conn, "已归档", None).unwrap();
        archive_task(&conn, &archived.id).unwrap();
        assert!(create_repeat(&conn, &archived.id, 0, 0, "elastic").is_err(), "归档任务不建新规则");
    }

    /// round69（B3）：展示文字（时间轴 🔁 的 tooltip）—— 周几 / 时刻都得对，越界不 panic
    #[test]
    fn test_note_text_formats_day_and_time() {
        assert_eq!(note_text(0, 0), "每周一 00:00");
        assert_eq!(note_text(2, 19 * 60), "每周三 19:00");
        assert_eq!(note_text(6, 23 * 60 + 59), "每周日 23:59");
        assert_eq!(note_text(8, 5), "每周二 00:05", "越界周几回退（rem_euclid）");
    }

    /// round69（B3）：`list_blocks` 给生成块补 `repeat_note`（时间轴 🔁），普通块不带
    #[test]
    fn test_list_blocks_marks_repeat_generated_blocks() {
        let conn = test_conn();
        let t = create_task(&conn, "健身", None).unwrap();
        create_repeat(&conn, &t.id, 2, 19 * 60, "required").unwrap();
        assert_eq!(generate_week(&conn, week_from(), fixed_now()).unwrap(), 1);
        let rows = db::list_blocks(&conn, week_from(), week_from() + 7 * 86_400).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].repeat_note.as_deref(), Some("每周三 19:00"));

        let other = create_task(&conn, "别的事", None).unwrap();
        db::create_block(&conn, &other.id, ts(2031, 1, 14, 9, 0), ts(2031, 1, 14, 10, 0)).unwrap();
        let all = db::list_blocks(&conn, week_from(), week_from() + 7 * 86_400).unwrap();
        let plain = all.iter().find(|b| b.task_id == other.id).unwrap();
        assert_eq!(plain.repeat_note, None, "普通块没有这个标");
    }

    /// 生成：未来时刻照排 —— 时段对、时长按预估、层照传、occurrence 记 created、事件带 repeat 标记
    #[test]
    fn test_generate_creates_future_occurrence() {
        let conn = test_conn();
        let t = create_task(&conn, "健身", None).unwrap();
        conn.execute("UPDATE tasks SET estimated_minutes = 75 WHERE id = ?1", [&t.id])
            .unwrap();
        let r = create_repeat(&conn, &t.id, 2, 19 * 60, "required").unwrap();

        let created = generate_week(&conn, week_from(), fixed_now()).unwrap();
        assert_eq!(created, 1, "周三 19:00 还没到 → 排一块");

        let blocks = list_blocks(&conn, week_from(), week_from() + 7 * 86_400).unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].start_at, ts(2031, 1, 15, 19, 0));
        assert_eq!(blocks[0].end_at, ts(2031, 1, 15, 20, 15), "时长 = 预估 75 分钟");
        assert_eq!(blocks[0].layer, "required");
        assert_eq!(occurrence_status(&conn, &r.id, week_from()).as_deref(), Some("created"));

        let payload: String = conn
            .query_row(
                "SELECT payload FROM events WHERE event_type = 'create' ORDER BY rowid DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(payload.contains("\"repeat\":true"), "create 事件带 repeat 标记：{payload}");
    }

    /// 已结束的时刻不补：周一 09:00 的规则、「现在」已是周三正午 → 不生成、也不记水位线
    #[test]
    fn test_generate_skips_ended_occurrence() {
        let conn = test_conn();
        let t = create_task(&conn, "早课", None).unwrap();
        let r = create_repeat(&conn, &t.id, 0, 9 * 60, "elastic").unwrap();
        assert_eq!(generate_week(&conn, week_from(), fixed_now()).unwrap(), 0);
        assert!(list_blocks(&conn, week_from(), week_from() + 7 * 86_400).unwrap().is_empty());
        assert_eq!(occurrence_status(&conn, &r.id, week_from()), None, "过去的不记水位线");
    }

    /// 冲突：目标时段与现有块相交 → 跳过并定案（第二次也不会补）
    #[test]
    fn test_generate_skips_conflict_once() {
        let conn = test_conn();
        let t = create_task(&conn, "健身", None).unwrap();
        let other = create_task(&conn, "别的事", None).unwrap();
        create_block(&conn, &other.id, ts(2031, 1, 15, 19, 0), ts(2031, 1, 15, 20, 0)).unwrap();
        let r = create_repeat(&conn, &t.id, 2, 19 * 60, "elastic").unwrap();

        assert_eq!(generate_week(&conn, week_from(), fixed_now()).unwrap(), 0);
        assert_eq!(occurrence_status(&conn, &r.id, week_from()).as_deref(), Some("skipped"));
        assert_eq!(generate_week(&conn, week_from(), fixed_now()).unwrap(), 0, "第二次也不补");
        assert_eq!(list_blocks(&conn, week_from(), week_from() + 7 * 86_400).unwrap().len(), 1);
    }

    /// 幂等 + 「删掉 = 这周不再生成」：水位线会记住
    #[test]
    fn test_generate_idempotent_and_deleted_stays_deleted() {
        let conn = test_conn();
        let t = create_task(&conn, "健身", None).unwrap();
        let r = create_repeat(&conn, &t.id, 2, 19 * 60, "elastic").unwrap();

        assert_eq!(generate_week(&conn, week_from(), fixed_now()).unwrap(), 1);
        assert_eq!(generate_week(&conn, week_from(), fixed_now()).unwrap(), 0, "幂等");
        let blocks = list_blocks(&conn, week_from(), week_from() + 7 * 86_400).unwrap();
        assert_eq!(blocks.len(), 1);

        db::delete_block(&conn, &blocks[0].id).unwrap();
        assert_eq!(generate_week(&conn, week_from(), fixed_now()).unwrap(), 0, "删过的不再补");
        assert!(list_blocks(&conn, week_from(), week_from() + 7 * 86_400).unwrap().is_empty());
        assert_eq!(occurrence_status(&conn, &r.id, week_from()).as_deref(), Some("created"), "水位线还在");
    }

    /// 归档任务停生成；取消归档就恢复
    #[test]
    fn test_archived_task_pauses_generation() {
        let conn = test_conn();
        let t = create_task(&conn, "健身", None).unwrap();
        create_repeat(&conn, &t.id, 2, 19 * 60, "elastic").unwrap();
        archive_task(&conn, &t.id).unwrap();
        assert_eq!(generate_week(&conn, week_from(), fixed_now()).unwrap(), 0, "归档 → 不生成");
        db::unarchive_task(&conn, &t.id).unwrap();
        assert_eq!(generate_week(&conn, week_from(), fixed_now()).unwrap(), 1, "取消归档 → 恢复");
    }

    /// 暂停 / 启用 / 删除规则
    #[test]
    fn test_toggle_and_delete_rule() {
        let conn = test_conn();
        let t = create_task(&conn, "健身", None).unwrap();
        let r = create_repeat(&conn, &t.id, 2, 19 * 60, "elastic").unwrap();
        let off = set_repeat_enabled(&conn, &r.id, false).unwrap();
        assert!(!off.enabled);
        assert_eq!(generate_week(&conn, week_from(), fixed_now()).unwrap(), 0, "暂停 → 不生成");
        set_repeat_enabled(&conn, &r.id, true).unwrap();
        assert_eq!(generate_week(&conn, week_from(), fixed_now()).unwrap(), 1);

        assert!(set_repeat_enabled(&conn, "nope", true).is_err());
        assert!(delete_repeat(&conn, "nope").is_err());
        delete_repeat(&conn, &r.id).unwrap();
        assert_eq!(list_repeats(&conn, None).unwrap().len(), 0);
        let occ: i64 = conn
            .query_row("SELECT COUNT(*) FROM repeat_occurrences", [], |r| r.get(0))
            .unwrap();
        assert_eq!(occ, 0, "occurrences 跟着 CASCADE");
    }

    /// round69.1（#4 / D2）：暂停规则 → **未开始**的生成块与其水位线一起撤下；已开始的留着
    #[test]
    fn test_pause_removes_unstarted_generated_blocks() {
        let conn = test_conn();
        let t = create_task(&conn, "健身", None).unwrap();
        let rule = create_repeat(&conn, &t.id, 2, 19 * 60, "elastic").unwrap();
        // 2031 那一周的生成块（相对**真现在** 2026 还没开始）
        assert_eq!(generate_week(&conn, week_from(), fixed_now()).unwrap(), 1);
        // 再造一块「已经开始了」的生成块（时间取真 now 附近）+ 它的水位线
        let now = db::now();
        let started = db::create_repeat_block(&conn, &t.id, now - 600, now + 600, "elastic").unwrap();
        conn.execute(
            "INSERT INTO repeat_occurrences (repeat_id, week_start, block_id, status, created_at) \
             VALUES (?1, ?2, ?3, 'created', ?4)",
            rusqlite::params![&rule.id, 999_999i64, &started.id, now],
        )
        .unwrap();

        set_repeat_enabled(&conn, &rule.id, false).unwrap();
        let week_blocks = list_blocks(&conn, week_from(), week_from() + 7 * 86_400).unwrap();
        assert!(week_blocks.is_empty(), "未开始的那块被撤下");
        assert_eq!(
            occurrence_status(&conn, &rule.id, week_from()),
            None,
            "水位线一起清掉（重新启用才排得回来）"
        );
        let kept = list_blocks(&conn, 0, week_from()).unwrap();
        assert_eq!(kept.len(), 1, "已开始的那块留着");
        assert_eq!(kept[0].id, started.id);
        let kept_occ: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM repeat_occurrences WHERE block_id = ?1",
                [&started.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept_occ, 1, "已开始的块水位线留着（不再重复生成）");

        // 重新启用 → 打开这一周又排上（水位线已清）
        set_repeat_enabled(&conn, &rule.id, true).unwrap();
        assert_eq!(generate_week(&conn, week_from(), fixed_now()).unwrap(), 1);
    }

    /// round69.1（#4 / D2）：删除规则同样把**未开始**的生成块撤下（规则与水位线级联删）
    #[test]
    fn test_delete_removes_unstarted_generated_blocks() {
        let conn = test_conn();
        let t = create_task(&conn, "健身", None).unwrap();
        let rule = create_repeat(&conn, &t.id, 2, 19 * 60, "elastic").unwrap();
        assert_eq!(generate_week(&conn, week_from(), fixed_now()).unwrap(), 1);
        delete_repeat(&conn, &rule.id).unwrap();
        assert!(list_blocks(&conn, week_from(), week_from() + 7 * 86_400).unwrap().is_empty());
        let occ: i64 = conn
            .query_row("SELECT COUNT(*) FROM repeat_occurrences", [], |r| r.get(0))
            .unwrap();
        assert_eq!(occ, 0, "水位线跟着规则走");
    }

    /// 任务删了 → 规则跟着删（CASCADE）
    #[test]
    fn test_delete_task_cascades_rules() {
        let conn = test_conn();
        let t = create_task(&conn, "健身", None).unwrap();
        let r = create_repeat(&conn, &t.id, 2, 19 * 60, "elastic").unwrap();
        generate_week(&conn, week_from(), fixed_now()).unwrap();
        delete_task(&conn, &t.id).unwrap();
        assert!(list_repeats(&conn, None).unwrap().is_empty());
        assert_eq!(occurrence_status(&conn, &r.id, week_from()), None);
    }
}
