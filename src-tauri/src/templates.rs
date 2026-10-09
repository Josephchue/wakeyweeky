//! round64（C10）：模板 ——「某一周的骨架」（层 / 时长 / 时段 / **任务名 + 分类**）—— **唯一实现**。
//!
//! 口径与调研（为什么默认 7 天 / ≥5 次、建议为什么问一句而不是自动建）：
//! `docs/plans/round64-c10-c11.md` §1.4 / §2.1。三条硬约束：
//!
//! - **payload**：`{"blocks":[{"start_min":540,"duration_min":180,"layer":"required","title":"数学","category":"学习","label":null}]}`
//!   `start_min` = 相对**周一 00:00** 的分钟偏移（0..10079）；`title` = 要挂的任务名（老 payload 没有，回退老行为）。
//! - **预览**：排除 `missed`（残影不是计划）；起点落在这一周；尾巴超出周界就**夹到周末**（T3）。
//! - **套用**（round64.1 / 验收 #2 改）：有 `title` 的行**按名复用未归档任务**、没有才新建（块记 `create`，
//!   统计进）；没名字的行仍是临时安排块；调用方用 `record` 包一层 → 一步撤销。

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db;
use crate::sanity::{local_day_add, local_day_start, week_start_of};
use crate::i18n;
use crate::tf;

/// 一周的分钟数（模板里的坐标系）
pub const WEEK_MINUTES: i64 = 7 * 24 * 60;
/// 一行的时长（分钟）：与块的最小/最大时长同口径（15 分钟 ~ 3 天）
pub const MIN_DURATION_MIN: i64 = 15;
pub const MAX_DURATION_MIN: i64 = 4_320;
/// 一个模板最多多少行（防呆；正常一周不会有这么多块）
pub const MAX_ROWS: usize = 200;
/// 模板名字上限
pub const MAX_NAME_CHARS: usize = 40;
/// 临时块名字上限（与 `blocks.label` 的界面口径一致）
pub const MAX_LABEL_CHARS: usize = 60;
/// round64.1（验收 #2）：模板行里的**任务名**上限。
/// 与 `db.rs` 的任务标题上限（200）**保持一致** —— 否则一个 101–200 字的正经任务名
/// 会让「保存这一周为模板」整条失败（6b 只读复核抓到的：不该把保存掐在名字长度上）。
/// 改一处必须改另一处。
pub const MAX_TITLE_CHARS: usize = 200;
/// round64.1：套用时新建任务的**分类名**上限
pub const MAX_CATEGORY_CHARS: usize = 40;
/// 建议那一周至少要有的块数（少于这个数就不值得建议 —— T9）
pub const SUGGEST_MIN_BLOCKS: i64 = 3;

/// 内部键：建议水位线（同一周只提一次）
pub const KEY_NUDGED_WEEK: &str = "template_nudged_week";
/// 内部键：首次使用卡片看过没
pub const KEY_FIRST_RUN_SEEN: &str = "first_run_seen";

/// 模板的一行（相对这一周的坐标）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkeletonRow {
    pub start_min: i64,
    pub duration_min: i64,
    pub layer: String,
    /// round64.1（验收 #2）：这一行要挂的**任务名**（临时块自己的名字也折在这里）——
    /// 铺出来会按名复用/新建真任务；老的 payload 没这一项 → `None` → 老行为（无名临时块）。
    #[serde(default)]
    pub title: Option<String>,
    /// round64.1：任务的**分类**（只在套用时要**新建**任务时使用；复用已有任务时不改它的分类）。
    #[serde(default)]
    pub category: Option<String>,
    /// **老 payload 的临时块名字**（新保存不再写它 —— 名字都进 `title`；读老模板时仍认）。
    #[serde(default)]
    pub label: Option<String>,
}

/// 名单里的一条（不带 payload —— 前端列表只要这些）
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TemplateInfo {
    pub id: String,
    pub name: String,
    pub block_count: usize,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Payload {
    blocks: Vec<SkeletonRow>,
}

/// `layer` 只认两层（遗留的 `suggested` 当弹性）
fn normalize_layer(layer: &str) -> String {
    if layer == "required" { "required" } else { "elastic" }.to_string()
}

/// 读一条模板的 payload（坏 JSON → Err，供套用报「模板已损坏」）
fn load_payload(conn: &Connection, id: &str) -> Result<Payload, String> {
    let raw: String = conn
        .query_row("SELECT payload FROM templates WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => i18n::t(i18n::msg::ERR_TEMPLATES_01).to_string(),
            other => tf!(i18n::msg::ERR_TEMPLATES_02, other = other),
        })?;
    serde_json::from_str(&raw).map_err(|e| tf!(i18n::msg::ERR_TEMPLATES_03, e = e))
}

/// 名单（新的在前；坏 payload 只影响它的 block_count，不影响名单本身）
pub fn list_templates(conn: &Connection) -> Result<Vec<TemplateInfo>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, payload, created_at FROM templates ORDER BY created_at DESC, rowid DESC")
        .map_err(|e| tf!(i18n::msg::ERR_TEMPLATES_04, e = e))?;
    let rows = stmt
        .query_map([], |row| {
            let payload: String = row.get(2)?;
            let block_count = serde_json::from_str::<Payload>(&payload)
                .map(|p| p.blocks.len())
                .unwrap_or(0);
            Ok(TemplateInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                block_count,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| tf!(i18n::msg::ERR_TEMPLATES_05, e = e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| tf!(i18n::msg::ERR_TEMPLATES_06, e = e))?);
    }
    Ok(out)
}

/// 把某一周（起点落在该周、非残影）读成骨架行 —— 只读，改完再存（「生成后可改」的那一半）。
pub fn preview_week_skeleton(conn: &Connection, week_start: i64) -> Result<Vec<SkeletonRow>, String> {
    let base = local_day_start(week_start);
    let end = local_day_add(base, 7);
    // round64.1：关掉漂流时，隐藏的漂流子块也不该被存进骨架
    let filter = db::drift_filter(conn, "b.")?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT b.start_at, b.end_at, b.layer, b.label, b.task_id, t.title, t.category
             FROM blocks b LEFT JOIN tasks t ON t.id = b.task_id
             WHERE b.start_at >= ?1 AND b.start_at < ?2 AND b.status != 'missed'{filter}
             ORDER BY b.start_at, b.rowid"
        ))
        .map_err(|e| tf!(i18n::msg::ERR_TEMPLATES_07, e = e))?;
    let rows = stmt
        .query_map(rusqlite::params![base, end], |row| {
            let start_at: i64 = row.get(0)?;
            let end_at: i64 = row.get(1)?;
            let layer: String = row.get(2)?;
            let label: Option<String> = row.get(3)?;
            let task_id: String = row.get(4)?;
            let task_title: Option<String> = row.get(5)?;
            let task_category: Option<String> = row.get(6)?;
            Ok((start_at, end_at, layer, label, task_id, task_title, task_category))
        })
        .map_err(|e| tf!(i18n::msg::ERR_TEMPLATES_08, e = e))?;

    let mut out = Vec::new();
    for row in rows {
        let (start_at, end_at, layer, label, task_id, task_title, task_category) =
            row.map_err(|e| tf!(i18n::msg::ERR_TEMPLATES_09, e = e))?;
        let start_min = (start_at - base).div_euclid(60);
        if !(0..WEEK_MINUTES).contains(&start_min) {
            continue; // 理论上到不了；真到了就跳过（不把一个跨周起点硬算成负偏移）
        }
        // 尾巴超出周界 → 夹到周末；时长不足 15 分钟的行不建（不值得当骨架）
        let mut duration_min = (end_at - start_at).div_euclid(60);
        duration_min = duration_min.min(WEEK_MINUTES - start_min);
        if duration_min < MIN_DURATION_MIN {
            continue;
        }
        // round64.1（验收 #2）：这一行带「任务名 + 分类」——
        // 块自己改过名就先用它，否则用任务标题；临时块自己的 label 也算名字；都没有的行仍是「无任务」。
        let block_name = label
            .as_deref()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string());
        let (title, category) = if task_id == db::TEMP_TASK_ID {
            (block_name, None)
        } else {
            let title = block_name.or_else(|| {
                task_title
                    .as_deref()
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(|t| t.to_string())
            });
            let category = task_category
                .map(|c| c.trim().to_string())
                .filter(|c| !c.is_empty());
            (title, category)
        };
        out.push(SkeletonRow {
            start_min,
            duration_min,
            layer: normalize_layer(&layer),
            title,
            category,
            label: None,
        });
    }
    Ok(out)
}

/// 存一个模板（名字 / 行都校验；非法值返回中文错误、**不落库**）
pub fn create_template(
    conn: &Connection,
    name: &str,
    rows: &[SkeletonRow],
) -> Result<TemplateInfo, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(i18n::t(i18n::msg::ERR_TEMPLATES_10).to_string());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(tf!(i18n::msg::ERR_TEMPLATES_11, MAX_NAME_CHARS = MAX_NAME_CHARS));
    }
    if rows.is_empty() {
        return Err(i18n::t(i18n::msg::ERR_TEMPLATES_12).to_string());
    }
    if rows.len() > MAX_ROWS {
        return Err(tf!(i18n::msg::ERR_TEMPLATES_13, MAX_ROWS = MAX_ROWS));
    }
    let mut canonical = Vec::with_capacity(rows.len());
    for (i, row) in rows.iter().enumerate() {
        if !(0..WEEK_MINUTES).contains(&row.start_min) {
            return Err(tf!(i18n::msg::ERR_TEMPLATES_14, p1 = i + 1));
        }
        if !(MIN_DURATION_MIN..=MAX_DURATION_MIN).contains(&row.duration_min) {
            return Err(tf!(i18n::msg::ERR_TEMPLATES_15, p1 = i + 1));
        }
        if row.start_min + row.duration_min > WEEK_MINUTES {
            return Err(tf!(i18n::msg::ERR_TEMPLATES_16, p1 = i + 1));
        }
        // round64.1（验收 #2）：行带「任务名 + 分类」——名字交给套用去找/建真任务；
        // 有名字的行不再保留老 `label`（名字只有一个出口，不让两种叫法打架）。
        let title = row
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| t.to_string());
        if title.as_deref().map(|t| t.chars().count()).unwrap_or(0) > MAX_TITLE_CHARS {
            return Err(tf!(i18n::msg::ERR_TEMPLATES_17, p1 = i + 1, MAX_TITLE_CHARS = MAX_TITLE_CHARS));
        }
        let category = row
            .category
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(|c| c.to_string());
        if category.as_deref().map(|c| c.chars().count()).unwrap_or(0) > MAX_CATEGORY_CHARS {
            return Err(tf!(i18n::msg::ERR_TEMPLATES_18, p1 = i + 1, MAX_CATEGORY_CHARS = MAX_CATEGORY_CHARS));
        }
        let label = row
            .label
            .as_deref()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string());
        if label.as_deref().map(|l| l.chars().count()).unwrap_or(0) > MAX_LABEL_CHARS {
            return Err(tf!(i18n::msg::ERR_TEMPLATES_19, p1 = i + 1, MAX_LABEL_CHARS = MAX_LABEL_CHARS));
        }
        canonical.push(SkeletonRow {
            start_min: row.start_min,
            duration_min: row.duration_min,
            layer: normalize_layer(&row.layer),
            title: title.clone(),
            category: if title.is_some() { category } else { None },
            label: if title.is_some() { None } else { label },
        });
    }
    let payload = serde_json::to_string(&Payload { blocks: canonical })
        .map_err(|e| tf!(i18n::msg::ERR_TEMPLATES_20, e = e))?;
    let id = Uuid::new_v4().to_string();
    let created_at = db::now();
    conn.execute(
        "INSERT INTO templates (id, name, payload, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, name, payload, created_at],
    )
    .map_err(|e| tf!(i18n::msg::ERR_TEMPLATES_21, e = e))?;
    Ok(TemplateInfo {
        id,
        name: name.to_string(),
        block_count: rows.len(),
        created_at,
    })
}

/// 按名字找**未归档**的普通任务（排除隐藏任务）——
/// 同名多个就取 Backlog 最上面的那个（sort_order 最小）。
fn find_task_id_by_title(conn: &Connection, title: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT id FROM tasks WHERE title = ?1 AND id <> ?2 AND archived_at IS NULL \
         ORDER BY sort_order, rowid LIMIT 1",
        rusqlite::params![title, db::TEMP_TASK_ID],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| tf!(i18n::msg::ERR_TEMPLATES_22, e = e))
}

/// 把模板铺到某一周（round64.1 / 验收 #2）：
/// - 行有 `title` → 按名**复用**未归档任务（找不到才新建，带上分类），块挂真任务、层照存、记 `create`；
/// - 行没名字 → 老行为：建临时安排块（`label` 照存）。
///
/// 返回建了几块。
pub fn apply_template(conn: &Connection, id: &str, week_start: i64) -> Result<usize, String> {
    let payload = load_payload(conn, id)?;
    let base = local_day_start(week_start);
    let mut created = 0;
    // 同一个模板里同名的多行共用一个任务（新建过就不再查库）
    let mut made: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for row in &payload.blocks {
        let start = base + row.start_min * 60;
        let end = start + row.duration_min * 60;
        let title = row.title.as_deref().map(str::trim).filter(|t| !t.is_empty());
        match title {
            Some(title) => {
                let task_id = match made.get(title) {
                    Some(id) => id.clone(),
                    None => {
                        let id = match find_task_id_by_title(conn, title)? {
                            Some(id) => id,
                            None => db::create_task(conn, title, row.category.as_deref())?.id,
                        };
                        made.insert(title.to_string(), id.clone());
                        id
                    }
                };
                db::create_block_with_layer(conn, &task_id, start, end, &row.layer, true)?;
            }
            None => {
                db::create_skeleton_block(conn, start, end, &row.layer, row.label.as_deref())?;
            }
        }
        created += 1;
    }
    Ok(created)
}

/// 删一个模板（不存在 → 报错；调用方用 `record` 包一层 → Ctrl+Z 可恢复）
pub fn delete_template(conn: &Connection, id: &str) -> Result<(), String> {
    let affected = conn
        .execute("DELETE FROM templates WHERE id = ?1", [id])
        .map_err(|e| tf!(i18n::msg::ERR_TEMPLATES_23, e = e))?;
    if affected == 0 {
        return Err(i18n::t(i18n::msg::ERR_TEMPLATES_24).to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------- 首次使用 / 建议

fn table_count(conn: &Connection, table: &str) -> Result<i64, String> {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .map_err(|e| tf!(i18n::msg::ERR_TEMPLATES_25, table = table, e = e))
}

/// 要不要给新用户看「先只安排今天就好」：三表皆空（v2 原文）且没看过
pub fn should_show_first_run(conn: &Connection) -> Result<bool, String> {
    if db::get_setting(conn, KEY_FIRST_RUN_SEEN)?.as_deref() == Some("1") {
        return Ok(false);
    }
    for table in ["blocks", "reviews", "events"] {
        if table_count(conn, table)? > 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

/// 「知道了」——之后不再出现（真的开始用以后三表也不再为空，双保险）
pub fn mark_first_run_seen(conn: &Connection) -> Result<(), String> {
    db::set_setting(conn, KEY_FIRST_RUN_SEEN, "1")
}

/// `template_suggest` 的生效规则（非法/缺省 → 默认开 · 7 天 · 5 次）
#[derive(Debug, Clone, PartialEq)]
struct SuggestRule {
    enabled: bool,
    days: i64,
    done: i64,
}

fn suggest_rule(conn: &Connection) -> SuggestRule {
    let defaults = SuggestRule { enabled: true, days: 7, done: 5 };
    let Ok(Some(raw)) = db::get_setting(conn, crate::features::TEMPLATE_SUGGEST) else {
        return defaults;
    };
    let parsed = serde_json::from_str::<serde_json::Value>(&raw).ok().and_then(|value| {
        Some(SuggestRule {
            enabled: value.get("enabled")?.as_bool()?,
            days: value.get("days")?.as_i64()?,
            done: value.get("done")?.as_i64()?,
        })
    });
    parsed
        .filter(|r| (1..=365).contains(&r.days) && (0..=1000).contains(&r.done))
        .unwrap_or(defaults)
}

/// 首次使用的时刻 = tasks / blocks / events 三表最早的一条 `created_at`（空库 → None）
fn first_use_at(conn: &Connection) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT MIN(t) FROM (
             SELECT MIN(created_at) AS t FROM tasks
             UNION ALL SELECT MIN(created_at) FROM blocks
             UNION ALL SELECT MIN(created_at) FROM events
         )",
        [],
        |r| r.get(0),
    )
    .map_err(|e| tf!(i18n::msg::ERR_TEMPLATES_26, e = e))
}

/// 到点该不该问一句「要不要把上周存成模板？」
///
/// 条件（T9/T10）：开关开 · 满 N 天 · 完成 ≥M 次 · 被建议周（**刚过去的那一周**）≥3 块 ·
/// 同一周只提一次 · **免打扰期间不提也不推水位线**。
pub fn take_template_suggestion(conn: &Connection, now: i64) -> Result<Option<i64>, String> {
    if crate::notify::is_quiet(conn, now) {
        return Ok(None); // 静音 = 不打扰；不推水位线（解静音后还在窗口里就还会提）
    }
    let rule = suggest_rule(conn);
    if !rule.enabled {
        return Ok(None);
    }
    let Some(first) = first_use_at(conn)? else {
        return Ok(None);
    };
    if now.saturating_sub(first) < rule.days * 86_400 {
        return Ok(None);
    }
    let completed: i64 = conn
        .query_row("SELECT COUNT(*) FROM events WHERE event_type = 'complete'", [], |r| r.get(0))
        .map_err(|e| tf!(i18n::msg::ERR_TEMPLATES_27, e = e))?;
    if completed < rule.done {
        return Ok(None);
    }
    let this_week = week_start_of(local_day_start(now));
    let last_week = local_day_add(this_week, -7);
    if db::get_setting(conn, KEY_NUDGED_WEEK)?
        .and_then(|v| v.trim().parse::<i64>().ok())
        == Some(last_week)
    {
        return Ok(None); // 这一周已经问过
    }
    // 被建议周得真有内容（空周存出来的骨架没意义）—— 不足就这一轮不提、水位线也不动
    let week_end = local_day_add(last_week, 7);
    let blocks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM blocks WHERE start_at >= ?1 AND start_at < ?2",
            rusqlite::params![last_week, week_end],
            |r| r.get(0),
        )
        .map_err(|e| tf!(i18n::msg::ERR_TEMPLATES_28, e = e))?;
    if blocks < SUGGEST_MIN_BLOCKS {
        return Ok(None);
    }
    db::set_setting(conn, KEY_NUDGED_WEEK, &last_week.to_string())?;
    Ok(Some(last_week))
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_block, create_task, create_temp_block, mark_block_missed, set_setting, test_conn};
    use chrono::{Local, TimeZone};

    /// 本地时刻 → Unix 秒（测试里造「某天几点」的块）
    fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        let naive = chrono::NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, min, 0)
            .unwrap();
        Local.from_local_datetime(&naive).earliest().unwrap().timestamp()
    }

    /// 这一周的周一 00:00（2026-10-05 是周一）
    fn week() -> i64 {
        week_start_of(local_day_start(at(2026, 10, 7, 12, 0)))
    }

    fn row(start_min: i64, duration_min: i64) -> SkeletonRow {
        SkeletonRow {
            start_min,
            duration_min,
            layer: "elastic".to_string(),
            title: None,
            category: None,
            label: None,
        }
    }

    #[test]
    fn test_preview_offsets_filters_and_temp_label() {
        let conn = test_conn();
        let base = week();
        let task = create_task(&conn, "写周报", None).unwrap();
        // 周一 09:00–12:00（偏移 540）
        let b1 = create_block(&conn, &task.id, base + 9 * 60 * 60, base + 12 * 60 * 60).unwrap();
        // 周二 14:00（偏移 1440+840=2280），标 ✗ → 不进骨架
        let b2 = create_block(&conn, &task.id, base + 38 * 60 * 60, base + 40 * 60 * 60).unwrap();
        mark_block_missed(&conn, &b2.id).unwrap();
        // 临时块带名字；周三 20:00（偏移 2880+1200=4080）
        let temp = create_temp_block(&conn, base + 68 * 60 * 60, base + 69 * 60 * 60).unwrap();
        conn.execute("UPDATE blocks SET label = '夜读' WHERE id = ?1", [&temp.id]).unwrap();
        let _ = b1;

        let rows = preview_week_skeleton(&conn, base).unwrap();
        assert_eq!(rows.len(), 2, "残影不进骨架：{rows:?}");
        assert_eq!(rows[0].start_min, 540);
        assert_eq!(rows[0].duration_min, 180);
        assert_eq!(rows[0].title.as_deref(), Some("写周报"), "round64.1：普通块带上任务名");
        assert_eq!(rows[0].label, None);
        assert_eq!(rows[1].start_min, 4080);
        assert_eq!(
            rows[1].title.as_deref(),
            Some("夜读"),
            "round64.1：临时块自己的名字也进 title（铺出来是真任务）"
        );
        assert_eq!(rows[1].label, None);
    }

    #[test]
    fn test_preview_clamps_cross_week_tail() {
        let conn = test_conn();
        let base = week();
        let task = create_task(&conn, "长块", None).unwrap();
        // 周日 23:00 起、3 小时（跨到下周）→ 夹到周末只剩 60 分钟
        create_block(&conn, &task.id, base + 167 * 60 * 60, base + 170 * 60 * 60).unwrap();
        let rows = preview_week_skeleton(&conn, base).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].start_min, 7 * 24 * 60 - 60);
        assert_eq!(rows[0].duration_min, 60, "尾巴夹到周日 24:00");
    }

    /// round64.1（验收 #2）：预览带出任务名 + 分类
    #[test]
    fn test_preview_carries_task_title_and_category() {
        let conn = test_conn();
        let base = week();
        let task = create_task(&conn, "数学", Some("学习")).unwrap();
        create_block(&conn, &task.id, base + 9 * 3600, base + 10 * 3600).unwrap();
        let rows = preview_week_skeleton(&conn, base).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title.as_deref(), Some("数学"));
        assert_eq!(rows[0].category.as_deref(), Some("学习"));
    }

    /// round64.1（验收 #2）：套用**按名复用**未归档任务（不新建）；同一个模板里同名多行共用一个任务
    #[test]
    fn test_apply_reuses_existing_task_by_name() {
        let conn = test_conn();
        let task = create_task(&conn, "数学", Some("学习")).unwrap();
        let info = create_template(
            &conn,
            "工作日",
            &[
                SkeletonRow { title: Some("数学".into()), ..row(540, 60) },
                SkeletonRow { title: Some("数学".into()), ..row(660, 60) },
            ],
        )
        .unwrap();
        let target = week();
        assert_eq!(apply_template(&conn, &info.id, target).unwrap(), 2);
        let blocks = db::list_blocks(&conn, target, local_day_add(target, 7)).unwrap();
        assert_eq!(blocks.len(), 2);
        assert!(blocks.iter().all(|b| !b.is_temp), "有名字的行挂真任务");
        assert!(
            blocks.iter().all(|b| b.task_id == task.id),
            "同名复用同一个任务（不新建）"
        );
        assert_eq!(db::list_tasks(&conn).unwrap().len(), 1, "任务数没变");
    }

    /// round64.1（验收 #2）：没有同名任务才新建（带上分类）
    #[test]
    fn test_apply_creates_missing_task_with_category() {
        let conn = test_conn();
        let info = create_template(
            &conn,
            "工作日",
            &[SkeletonRow {
                title: Some("英语".into()),
                category: Some("学习".into()),
                ..row(540, 60)
            }],
        )
        .unwrap();
        apply_template(&conn, &info.id, week()).unwrap();
        let tasks = db::list_tasks(&conn).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "英语");
        assert_eq!(tasks[0].category.as_deref(), Some("学习"));
    }

    /// round64.1：临时块的块名在预览里变成任务名 —— 铺出来是真任务（进统计）
    #[test]
    fn test_preview_temp_label_becomes_title() {
        let conn = test_conn();
        let base = week();
        let temp = create_temp_block(&conn, base + 20 * 3600, base + 21 * 3600).unwrap();
        conn.execute("UPDATE blocks SET label = '夜读' WHERE id = ?1", [&temp.id])
            .unwrap();
        let rows = preview_week_skeleton(&conn, base).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title.as_deref(), Some("夜读"));
        assert_eq!(rows[0].label, None);
        let info = create_template(&conn, "夜读模板", &rows).unwrap();
        let next = local_day_add(base, 7);
        apply_template(&conn, &info.id, next).unwrap();
        let blocks = db::list_blocks(&conn, next, local_day_add(next, 7)).unwrap();
        assert!(blocks.iter().all(|b| !b.is_temp), "带名字的行铺成真任务");
        assert!(db::list_tasks(&conn)
            .unwrap()
            .iter()
            .any(|t| t.title == "夜读"));
    }

    /// round64.1：老 payload（只有 label、没有 title）仍照老行为铺成临时块
    #[test]
    fn test_apply_old_payload_still_makes_temp_blocks() {
        let conn = test_conn();
        conn.execute(
            "INSERT INTO templates (id, name, payload, created_at)
             VALUES ('t-old', '老模板', '{\"blocks\":[{\"start_min\":540,\"duration_min\":60,\"layer\":\"elastic\",\"label\":\"旧名\"}]}', 1)",
            [],
        )
        .unwrap();
        let target = week();
        apply_template(&conn, "t-old", target).unwrap();
        let blocks = db::list_blocks(&conn, target, local_day_add(target, 7)).unwrap();
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].is_temp, "老 payload：临时块（行为不变）");
        assert_eq!(blocks[0].label.as_deref(), Some("旧名"));
    }

    /// round64.1（6b 复核补）：模板行 `title` 上限与任务标题上限**对齐**（200）——
    /// 一个 101–200 字的正经任务名不该让「保存这一周为模板」整条失败。
    #[test]
    fn test_template_title_limit_matches_task_limit() {
        let conn = test_conn();
        let base = week();
        let long = "字".repeat(150);
        let task = create_task(&conn, &long, None).unwrap();
        create_block(&conn, &task.id, base + 9 * 3600, base + 10 * 3600).unwrap();
        let rows = preview_week_skeleton(&conn, base).unwrap();
        assert_eq!(
            rows[0].title.as_deref(),
            Some(long.as_str()),
            "150 字的名字要原样带出来（不截断）"
        );
        create_template(&conn, "长名字", &rows).expect("150 字不该把保存整条拒掉");
        // 超过上限（200）才拒
        let too_long = SkeletonRow { title: Some("字".repeat(201)), ..row(0, 60) };
        assert!(create_template(&conn, "太长", &[too_long]).is_err());
    }

    #[test]
    fn test_create_validates_rows_and_name() {
        let conn = test_conn();
        assert!(create_template(&conn, "  ", &[row(0, 60)]).is_err(), "空名字要拒");
        assert!(create_template(&conn, &"长".repeat(41), &[row(0, 60)]).is_err(), "名字太长要拒");
        assert!(create_template(&conn, "工作日", &[]).is_err(), "空骨架要拒");
        assert!(create_template(&conn, "工作日", &vec![row(0, 60); MAX_ROWS + 1]).is_err());
        assert!(create_template(&conn, "工作日", &[row(-1, 60)]).is_err(), "负偏移要拒");
        assert!(create_template(&conn, "工作日", &[row(0, 14)]).is_err(), "太短要拒");
        assert!(create_template(&conn, "工作日", &[row(0, MAX_DURATION_MIN + 1)]).is_err());
        assert!(create_template(&conn, "工作日", &[row(WEEK_MINUTES - 30, 60)]).is_err(), "越过周界要拒");
        let bad_label = SkeletonRow { label: Some("名".repeat(61)), ..row(0, 60) };
        assert!(create_template(&conn, "工作日", &[bad_label]).is_err());
        assert!(list_templates(&conn).unwrap().is_empty(), "被拒的都没落库");
    }

    /// round64.1（验收 #1 复核）：关掉漂流 → 漂流子块不进骨架（保存模板不该把隐藏的块收进去）
    #[test]
    fn test_preview_hides_drift_children_when_drift_off() {
        let conn = test_conn();
        let base = week();
        let task = create_task(&conn, "数学", Some("学习")).unwrap();
        let first =
            create_block(&conn, &task.id, base + 9 * 60 * 60, base + 10 * 60 * 60).unwrap();
        mark_block_missed(&conn, &first.id).unwrap();
        let _child = crate::db::postpone_block(&conn, &first.id, base + 11 * 60 * 60)
            .unwrap()
            .block;
        // 开着：残影被排除、子块进骨架
        let rows = preview_week_skeleton(&conn, base).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].start_min, 11 * 60);
        // 关掉：子块也不进骨架
        set_setting(&conn, crate::features::DRIFT, "0").unwrap();
        assert!(
            preview_week_skeleton(&conn, base).unwrap().is_empty(),
            "隐藏的子块不该被存进模板"
        );
    }

    #[test]
    fn test_create_list_delete_round_trip() {
        let conn = test_conn();
        let info = create_template(
            &conn,
            "  常规工作日  ",
            &[row(540, 180), SkeletonRow { layer: "required".into(), ..row(840, 240) }],
        )
        .unwrap();
        assert_eq!(info.name, "常规工作日", "名字去空白");
        assert_eq!(info.block_count, 2);
        let list = list_templates(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, info.id);
        assert_eq!(list[0].block_count, 2);
        delete_template(&conn, &info.id).unwrap();
        assert!(list_templates(&conn).unwrap().is_empty());
        assert!(delete_template(&conn, &info.id).is_err(), "删不存在要报错");
    }

    #[test]
    fn test_apply_creates_skeleton_blocks_with_layer_and_label() {
        let conn = test_conn();
        let info = create_template(
            &conn,
            "工作日",
            &[
                SkeletonRow { layer: "required".into(), ..row(540, 180) },
                SkeletonRow { layer: "elastic".into(), label: Some("夜读".into()), ..row(1200, 60) },
            ],
        )
        .unwrap();
        let target = week();
        let created = apply_template(&conn, &info.id, target).unwrap();
        assert_eq!(created, 2);
        let blocks = db::list_blocks(&conn, target, local_day_add(target, 7)).unwrap();
        assert_eq!(blocks.len(), 2);
        let first = blocks.iter().find(|b| b.start_at == target + 540 * 60).unwrap();
        assert_eq!(first.layer, "required", "层照存");
        assert_eq!(first.status, "planned");
        assert!(first.is_temp, "模板块是临时安排块（挂隐藏任务）");
        let second = blocks.iter().find(|b| b.start_at == target + 1200 * 60).unwrap();
        assert_eq!(second.label.as_deref(), Some("夜读"));
    }

    #[test]
    fn test_apply_bad_payload_reports_corrupt() {
        let conn = test_conn();
        conn.execute(
            "INSERT INTO templates (id, name, payload, created_at) VALUES ('t-bad', '坏模板', 'not json', 1)",
            [],
        )
        .unwrap();
        assert!(list_templates(&conn).unwrap()[0].block_count == 0, "名单不炸");
        let err = apply_template(&conn, "t-bad", week()).unwrap_err();
        assert!(err.contains("模板已损坏"), "err={err}");
        assert!(apply_template(&conn, "t-missing", week()).is_err(), "不存在要报错");
    }

    #[test]
    fn test_first_run_lifecycle() {
        let conn = test_conn();
        assert!(should_show_first_run(&conn).unwrap(), "空库 → 该出现");
        mark_first_run_seen(&conn).unwrap();
        assert!(!should_show_first_run(&conn).unwrap(), "看过 → 不再出现");
    }

    #[test]
    fn test_first_run_hidden_once_used() {
        let conn = test_conn();
        let task = create_task(&conn, "写周报", None).unwrap();
        create_block(&conn, &task.id, 1_000, 2_800).unwrap();
        assert!(!should_show_first_run(&conn).unwrap(), "有块就不是新库了");
    }

    /// 把这一周造出 ≥3 块 + 5 条完成事件 + 首次使用在很久以前 → 建议应当出现，且只出现一次
    #[test]
    fn test_suggestion_rules_and_waterline() {
        let conn = test_conn();
        let task = create_task(&conn, "写周报", None).unwrap();
        let base = week();
        let last_week = local_day_add(base, -7);
        for i in 0..3 {
            create_block(&conn, &task.id, last_week + i * 86_400 + 9 * 3600, last_week + i * 86_400 + 10 * 3600)
                .unwrap();
        }
        for _ in 0..5 {
            conn.execute(
                "INSERT INTO events (id, block_id, event_type, payload, created_at) VALUES (lower(hex(randomblob(8))), NULL, 'complete', NULL, ?1)",
                [last_week],
            )
            .unwrap();
        }
        // 首次使用：把 tasks 的 created_at 改为很久以前
        conn.execute("UPDATE tasks SET created_at = ?1", [last_week - 30 * 86_400]).unwrap();

        let now = base + 3 * 86_400;
        let got = take_template_suggestion(&conn, now).unwrap();
        assert_eq!(got, Some(last_week), "应当建议刚过去的那一周");
        assert_eq!(take_template_suggestion(&conn, now).unwrap(), None, "同一周只提一次");
        // 这一周也排了 ≥3 块 → 下一周看时，建议的该是这一周
        for i in 0..3 {
            create_block(&conn, &task.id, base + i * 86_400 + 9 * 3600, base + i * 86_400 + 10 * 3600)
                .unwrap();
        }
        let next = take_template_suggestion(&conn, now + 7 * 86_400).unwrap();
        assert_eq!(next, Some(base), "下周建议的是刚过去的这一周");
    }

    #[test]
    fn test_suggestion_skips_thin_week_and_quiet() {
        let conn = test_conn();
        let task = create_task(&conn, "写周报", None).unwrap();
        let base = week();
        let last_week = local_day_add(base, -7);
        // 上周只有 2 块（< 3）→ 不提、水位线不动
        for i in 0..2 {
            create_block(&conn, &task.id, last_week + i * 86_400 + 9 * 3600, last_week + i * 86_400 + 10 * 3600)
                .unwrap();
        }
        for _ in 0..5 {
            conn.execute(
                "INSERT INTO events (id, block_id, event_type, payload, created_at) VALUES (lower(hex(randomblob(8))), NULL, 'complete', NULL, ?1)",
                [last_week],
            )
            .unwrap();
        }
        conn.execute("UPDATE tasks SET created_at = ?1", [last_week - 30 * 86_400]).unwrap();
        let now = base + 3 * 86_400;
        assert_eq!(take_template_suggestion(&conn, now).unwrap(), None, "块太少不提");
        assert!(db::get_setting(&conn, KEY_NUDGED_WEEK).unwrap().is_none(), "水位线不动");
        // 免打扰：不提也不推水位线
        db::set_setting(&conn, crate::notify::QUIET_UNTIL_KEY, &(now + 3600).to_string()).unwrap();
        assert_eq!(take_template_suggestion(&conn, now).unwrap(), None, "静音期不提");
        // 解静音后（补一块让上周够 3 块）→ 还能提
        db::set_setting(&conn, crate::notify::QUIET_UNTIL_KEY, "0").unwrap();
        create_block(&conn, &task.id, last_week + 2 * 86_400 + 9 * 3600, last_week + 2 * 86_400 + 10 * 3600)
            .unwrap();
        assert_eq!(take_template_suggestion(&conn, now).unwrap(), Some(last_week), "补够块后能提");
    }

    #[test]
    fn test_suggestion_respects_switch_and_thresholds() {
        let conn = test_conn();
        let task = create_task(&conn, "写周报", None).unwrap();
        let base = week();
        let last_week = local_day_add(base, -7);
        for i in 0..3 {
            create_block(&conn, &task.id, last_week + i * 86_400 + 9 * 3600, last_week + i * 86_400 + 10 * 3600)
                .unwrap();
        }
        for _ in 0..5 {
            conn.execute(
                "INSERT INTO events (id, block_id, event_type, payload, created_at) VALUES (lower(hex(randomblob(8))), NULL, 'complete', NULL, ?1)",
                [last_week],
            )
            .unwrap();
        }
        conn.execute("UPDATE tasks SET created_at = ?1", [last_week - 30 * 86_400]).unwrap();
        let now = base + 3 * 86_400;
        // 关掉建议 → 不提
        set_setting(&conn, crate::features::TEMPLATE_SUGGEST, "{\"days\":7,\"done\":5,\"enabled\":false}").unwrap();
        assert_eq!(take_template_suggestion(&conn, now).unwrap(), None, "关掉就不提");
        // 把门限抬到 6 次完成 → 不提（现只有 5 条）
        set_setting(&conn, crate::features::TEMPLATE_SUGGEST, "{\"days\":7,\"done\":6,\"enabled\":true}").unwrap();
        assert_eq!(take_template_suggestion(&conn, now).unwrap(), None, "门限没到不提");
        // 把「满 N 天」抬到 60 天 → 不提
        set_setting(&conn, crate::features::TEMPLATE_SUGGEST, "{\"days\":60,\"done\":5,\"enabled\":true}").unwrap();
        assert_eq!(take_template_suggestion(&conn, now).unwrap(), None, "天数没到不提");
        // 回到默认 → 提
        set_setting(&conn, crate::features::TEMPLATE_SUGGEST, "{\"days\":7,\"done\":5,\"enabled\":true}").unwrap();
        assert_eq!(take_template_suggestion(&conn, now).unwrap(), Some(last_week));
    }

    #[test]
    fn test_009_migration_creates_templates_table() {
        let conn = test_conn();
        assert!(list_templates(&conn).unwrap().is_empty(), "009 建出了 templates 表（空表可查）");
    }
}
