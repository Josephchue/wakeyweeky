//! C6 理智值（round44 建立 → **round45 口径重写**）—— 从行为事件反推「每天被占掉多少时间」。
//!
//! ## 口径（2026-10-03 用户验收 round44 后拍板，长对照见 `docs/plans/round45-plain-sanity.md`）
//!
//! ```text
//! 每天的占用分钟 = 当天各「计入」块区间的**并集**长度（重叠/并排只算一次；按本地日切分）
//! 占比 = 占用 / 预算（默认 360 分钟 = 6 小时，设置里可改）→ <80% 平静 / 80–99% 接近 / ≥100% 超载
//! ```
//!
//! **为什么把「加乘」整段删掉**：round44 第一版按「时长 × 系数」（长块 ×1.2 / 重排 ×1.3 / 跳过 ×1.3）算，
//! 用户验收时拿它跟眼睛对账：时间轴上 7 小时 30 分的那天显示「11 小时 42 分」（= 450 分 × 1.2 × 1.3），
//! 并排两块各 30 分钟被算成 60 分钟 —— 两个数字他都对不上，结论是「像黑话一样，非常迷惑」。
//! 现在的原则：**数字必须是用户能在时间轴上核对的东西**；`events` 只提供**事实**
//! （「这块挪过 / 没做完」），**不参与算术**（那些事实留给 C7 复盘去讲）。
//!
//! 本文件是**唯一实现**：命令层 `get_sanity_curve` 与托盘超载判定都走它；
//! 前端 `stores/sanity.svelte.ts` 只负责把数字画出来（假后端给的数字用来验渲染，不抄规则）。

use std::collections::{HashMap, HashSet};

use chrono::{Datelike, Duration, Local, TimeZone};
use rusqlite::Connection;
use serde::Serialize;

use crate::db;
use crate::i18n;
use crate::tf;

// ---------------------------------------------------------------- 常量（一处定义，注释写清依据）

/// 「挪过」要几次才算一条**事实**（不计入算术，只出现在提示语里）
pub const REARRANGE_TIMES: u32 = 2;
/// 「接近预算」的线（只在日头小条上体现；顶部那句话只在超载时出现）
pub const NEAR_RATIO: f64 = 0.8;
/// 每日预算默认值 = 6 小时（用户 2026-10-02 拍板：要能在设置里改，键见 `KEY_BUDGET`）
pub const DEFAULT_BUDGET_MINUTES: i64 = 360;
/// 预算的可设范围（设置层与这里都挡一道，非法值一律回退默认）
pub const MIN_BUDGET_MINUTES: i64 = 60;
pub const MAX_BUDGET_MINUTES: i64 = 1440;
/// `settings` 表里的两个键（白名单在 `commands/settings.rs`，这里定义是为了「只有一处写字面量」）
pub const KEY_BUDGET: &str = "sanity_budget_minutes";
pub const KEY_ENABLED: &str = "sanity_enabled";

// ---------------------------------------------------------------- 数据结构（前端只读，字段名与 TS 对齐）

/// 某一天的占用。`minutes` 是**并集**分钟（重叠只算一次），`energy_pct` 是占预算的百分比。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DayEnergy {
    /// 本地零点（秒）
    pub day_start: i64,
    /// 占用分钟（并集；不含「不计入」的块）
    pub minutes: i64,
    pub budget: i64,
    /// 0..=999（超预算照实给，>100 让界面自己截）
    pub energy_pct: i64,
    /// `calm` | `near` | `over`
    pub state: String,
    /// 这天计入的块数
    pub blocks: u32,
    /// 其中「挪过 ≥2 次」的块数（**事实**，不参与算术）
    pub rearranged: u32,
    /// 其中「没做完（标过 ✗）」的块数（**事实**，不参与算术）
    pub skipped: u32,
}

/// 一周的曲线（命令 `get_sanity_curve` 的返回；C7 复盘会把它存进 `reviews.sanity_curve`）
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SanityWeek {
    pub week_start: i64,
    pub week_end: i64,
    /// 今天在这一周里的下标；不在这一周 → -1
    pub today_index: i64,
    /// `calm` | `near` | `over`（取最重的那天）
    pub worst_state: String,
    pub budget: i64,
    /// 用户在设置里关掉了吗（关掉后界面不画、托盘不进超载，但数据照算）
    pub enabled: bool,
    pub days: Vec<DayEnergy>,
}

/// 事件表里的一行（本模块只关心这四列）
#[derive(Debug, Clone)]
pub(crate) struct EventRow {
    block_id: String,
    event_type: String,
    created_at: i64,
    payload: Option<String>,
}

// ---------------------------------------------------------------- 本地日边界（用日期加法，别用 +86400）

/// 某个时刻所在**本地日**的零点（秒）。
pub fn local_day_start(ts: i64) -> i64 {
    let Some(dt) = Local.timestamp_opt(ts, 0).single() else {
        return ts; // 理论上到不了这儿；真到不了就退回原值，绝不 panic
    };
    let naive = match dt.date_naive().and_hms_opt(0, 0, 0) {
        Some(n) => n,
        None => return ts,
    };
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|d| d.timestamp())
        .unwrap_or(ts)
}

/// 本地日零点往前/后挪 N 天（**用日期加法**：夏令时切换那天不是 24 小时）
pub fn local_day_add(day_start: i64, days: i64) -> i64 {
    let Some(dt) = Local.timestamp_opt(day_start, 0).single() else {
        return day_start + days * 86_400;
    };
    let date = dt.date_naive() + Duration::days(days);
    let naive = match date.and_hms_opt(0, 0, 0) {
        Some(n) => n,
        None => return day_start + days * 86_400,
    };
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|d| d.timestamp())
        .unwrap_or(day_start + days * 86_400)
}

/// 这一天的**周一**零点（与前端 `utils/week.ts` 的 `weekOf` 同一口径：周一是一周之始）
pub fn week_start_of(day_start: i64) -> i64 {
    let weekday = Local
        .timestamp_opt(day_start, 0)
        .single()
        .map(|d| d.weekday().num_days_from_monday() as i64)
        .unwrap_or(0);
    local_day_add(day_start, -weekday)
}

/// 把一个时间区间按**本地日**切成若干段，只保留与 `[from, to)` 相交的部分。
/// 返回 `(那天的零点, 该段起, 该段止)`；块最长 72 小时 → 段数 ≤ 4。
pub fn segments_by_day(start: i64, end: i64, from: i64, to: i64) -> Vec<(i64, i64, i64)> {
    let mut out = Vec::new();
    let s = start.max(from);
    let e = end.min(to);
    if e <= s {
        return out;
    }
    let mut day = local_day_start(s);
    // 上限防呆：正常块 ≤ 4 段；数据异常（手工改库）时也不会转圈
    for _ in 0..(90 + 32) {
        if day >= e {
            break;
        }
        let next = local_day_add(day, 1);
        let seg_start = s.max(day);
        let seg_end = e.min(next);
        if seg_end > seg_start {
            out.push((day, seg_start, seg_end));
        }
        if next <= day {
            break; // 时钟回拨之类的怪数据：立刻停，别死循环
        }
        day = next;
    }
    out
}

/// 若干区间的**并集**长度（秒）。重叠/包含/相接都只算一次 —— 这就是「并排两块 30 分钟 = 30 分钟」。
pub fn union_seconds(spans: &mut [(i64, i64)]) -> i64 {
    if spans.is_empty() {
        return 0;
    }
    spans.sort_unstable();
    let mut total = 0;
    let (mut cur_start, mut cur_end) = spans[0];
    for &(s, e) in spans.iter().skip(1) {
        if s > cur_end {
            total += cur_end - cur_start;
            cur_start = s;
            cur_end = e;
        } else if e > cur_end {
            cur_end = e; // 有重叠：尾巴往前接
        }
    }
    total + (cur_end - cur_start)
}

// ---------------------------------------------------------------- 信号 → 事实（不参与算术）

/// `move` 事件算不算一次「挪过」：**原定开始时间已过才挪**才算（计划期随手拖不算）。
/// 级联顺延（payload.cascade）也算 —— 它确实把你的安排打乱了；`link`（接序列对齐）不算（那是主动整理）。
fn counts_as_rearrange(ev: &EventRow) -> bool {
    if ev.event_type == "postpone" {
        return true; // 漂流（没做 → 重新安排）
    }
    if ev.event_type != "move" {
        return false; // merge / link / unlink_drift / complete / skip … 都不是
    }
    let Some(payload) = ev.payload.as_deref() else {
        return true; // 老数据/极少见：没有 payload 的 move 就当它算（宁可严一点）
    };
    match serde_json::from_str::<serde_json::Value>(payload)
        .ok()
        .and_then(|v| v.get("from").and_then(|x| x.as_i64()))
    {
        Some(from) => ev.created_at >= from,
        None => true,
    }
}

/// 一块的行为事实：挪过几次、有没有没做完（数事件；**不进算术**）
pub(crate) fn count_rearrange_and_skip(events: &[EventRow]) -> (u32, bool) {
    let mut rearranged = 0;
    let mut skipped = false;
    for ev in events {
        if counts_as_rearrange(ev) {
            rearranged += 1;
        }
        if ev.event_type == "skip" {
            skipped = true;
        }
    }
    (rearranged, skipped)
}

/// 窗口内**每块**的行为事实（C7 明细用）：`block_id` →（挪过几次、有没标过未完成）。
///
/// 为什么做成一个函数：曲线（`week_curve`）与 C7 的明细面板读的是**同一套规则** ——
/// 分组循环只该有一份，否则两边早晚会算出两个数（round47 的「一处规则、两处实现」教训）。
pub(crate) fn block_facts(
    conn: &Connection,
    from: i64,
    to: i64,
) -> Result<HashMap<String, (u32, bool)>, String> {
    let events = events_in_window(conn, from, to)?;
    let mut out: HashMap<String, (u32, bool)> = HashMap::new();
    for ev in &events {
        let (rearranged, skipped) = count_rearrange_and_skip(std::slice::from_ref(ev));
        let entry = out.entry(ev.block_id.clone()).or_insert((0, false));
        entry.0 += rearranged;
        entry.1 |= skipped;
    }
    Ok(out)
}

/// 「不计入理智值」的任务 id 集合（**唯一判定**；曲线与 C7 明细共用）。
///
/// round48：**任务级** —— 一条任务标了它，它的**所有**块（含漂出去的那些）都不进并集、也不计块数/事实。
/// round49：**临时安排块**没有可挂的任务（挂在那块全局隐藏任务上）→ 它看自己的块级标记；
/// 那块隐藏任务上的标记是 007 迁移折进来的，这里**故意排除它**
/// （否则「有过一个临时块被标过」就会把**所有**临时块一起豁免 ✗）。
pub(crate) fn exempt_task_ids(tasks: &[db::Task]) -> HashSet<&str> {
    tasks
        .iter()
        .filter(|t| t.sanity_exempt && t.id != db::TEMP_TASK_ID)
        .map(|t| t.id.as_str())
        .collect()
}

/// 这一块计不计入理智值：任务级豁免，或（**仅限临时块**）它自己的块级标记。
/// 旧的 `blocks.sanity_exempt` 列对普通块**没有读者**（round48 起）；别人块的旧标记一律不参与。
pub(crate) fn is_block_exempt(block: &db::Block, exempt_tasks: &HashSet<&str>) -> bool {
    exempt_tasks.contains(block.task_id.as_str()) || (block.is_temp && block.sanity_exempt)
}

/// 一天的档位：`calm` / `near` / `over`
pub fn state_of(minutes: f64, budget: i64) -> &'static str {
    if budget <= 0 {
        return "calm";
    }
    let pct = minutes / budget as f64 * 100.0;
    if pct >= 100.0 {
        "over"
    } else if pct >= NEAR_RATIO * 100.0 {
        "near"
    } else {
        "calm"
    }
}

fn pct_of(minutes: f64, budget: i64) -> i64 {
    if budget <= 0 {
        return 0;
    }
    (minutes / budget as f64 * 100.0).round() as i64
}

// ---------------------------------------------------------------- 设置（预算 / 开关）

/// 每日预算（分钟）：读 `settings`，非法值回退默认、并按范围夹一次
pub fn budget_minutes(conn: &Connection) -> i64 {
    db::get_setting(conn, KEY_BUDGET)
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(DEFAULT_BUDGET_MINUTES)
        .clamp(MIN_BUDGET_MINUTES, MAX_BUDGET_MINUTES)
}

/// 理智值功能开着吗（默认开；`0` 才关）
pub fn enabled(conn: &Connection) -> bool {
    match db::get_setting(conn, KEY_ENABLED) {
        Ok(Some(v)) => v.trim() != "0",
        _ => true,
    }
}

// ---------------------------------------------------------------- 读库（一次取齐，再纯算）

fn events_in_window(conn: &Connection, from: i64, to: i64) -> Result<Vec<EventRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT e.block_id, e.event_type, e.created_at, e.payload FROM events e
             WHERE e.block_id IN (SELECT id FROM blocks WHERE start_at < ?2 AND end_at > ?1)",
        )
        .map_err(|e| tf!(i18n::msg::ERR_SANITY_01, e = e))?;
    let rows = stmt
        .query_map(rusqlite::params![from, to], |r| {
            Ok(EventRow {
                block_id: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                event_type: r.get(1)?,
                created_at: r.get(2)?,
                payload: r.get(3)?,
            })
        })
        .map_err(|e| tf!(i18n::msg::ERR_SANITY_02, e = e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| tf!(i18n::msg::ERR_SANITY_03, e = e))?);
    }
    Ok(out)
}

// ---------------------------------------------------------------- 主入口（唯一实现）

/// 算某一周的占用曲线。`now` 传进来（好测）：只用于 `today_index`。
pub fn week_curve(conn: &Connection, week_start: i64, now: i64) -> Result<SanityWeek, String> {
    let budget = budget_minutes(conn);
    let enabled = enabled(conn);
    let from = local_day_start(week_start);
    let to = local_day_add(from, 7);

    let mut days: Vec<DayEnergy> = (0..7)
        .map(|i| DayEnergy {
            day_start: local_day_add(from, i as i64),
            minutes: 0,
            budget,
            energy_pct: 0,
            state: "calm".to_string(),
            blocks: 0,
            rearranged: 0,
            skipped: 0,
        })
        .collect();

    // 窗口外（跨周/跨天伸进来）的块也算它伸进来的那几天 —— 与 `list_blocks` 的区间相交语义一致
    let blocks = db::list_blocks(conn, from, to)?;

    // 每天的区间集合：并集（重叠只算一次）
    let mut spans: Vec<Vec<(i64, i64)>> = vec![Vec::new(); 7];

    // 事件按块聚成事实（快照式：`block_facts` 与 C7 明细共用同一套判定）
    let facts = block_facts(conn, from, to)?;

    // round48：「不计入理智」是**任务级**的（用户 2026-10-03 拍板：由任务决定，不由时间块决定）——
    // 判定抽在 `exempt_task_ids` / `is_block_exempt`（与 C7 明细共用，见文件头）。
    let all_tasks = db::list_tasks(conn)?;
    let exempt_tasks = exempt_task_ids(&all_tasks);

    for block in &blocks {
        if is_block_exempt(block, &exempt_tasks) {
            continue;
        }
        let (rearranged, skipped) = facts.get(block.id.as_str()).copied().unwrap_or((0, false));
        for (day, seg_start, seg_end) in segments_by_day(block.start_at, block.end_at, from, to) {
            let Some(idx) = days.iter().position(|d| d.day_start == day) else {
                continue; // 落在窗口外的段（理论上 segments_by_day 已经裁过）
            };
            spans[idx].push((seg_start, seg_end));
            days[idx].blocks += 1;
            if rearranged >= REARRANGE_TIMES {
                days[idx].rearranged += 1;
            }
            if skipped {
                days[idx].skipped += 1;
            }
        }
    }

    for (i, day) in days.iter_mut().enumerate() {
        let minutes = union_seconds(&mut spans[i]) as f64 / 60.0;
        day.minutes = minutes.round() as i64;
        day.energy_pct = pct_of(minutes, budget);
        day.state = state_of(minutes, budget).to_string();
    }

    let today_index = days
        .iter()
        .position(|d| d.day_start <= now && now < local_day_add(d.day_start, 1))
        .map(|i| i as i64)
        .unwrap_or(-1);
    let worst_state = if days.iter().any(|d| d.state == "over") {
        "over"
    } else if days.iter().any(|d| d.state == "near") {
        "near"
    } else {
        "calm"
    }
    .to_string();

    Ok(SanityWeek {
        week_start: from,
        week_end: to,
        today_index,
        worst_state,
        budget,
        enabled,
        days,
    })
}

/// 今天是不是超载（**托盘用**；关掉功能就是 false）
pub fn today_overloaded(conn: &Connection, now: i64) -> bool {
    if !enabled(conn) {
        return false;
    }
    let day = local_day_start(now);
    match week_curve(conn, week_start_of(day), now) {
        Ok(w) => w
            .days
            .iter()
            .any(|d| d.day_start == day && d.energy_pct >= 100),
        Err(e) => {
            eprintln!("[sanity] 算今天的占用失败（托盘按不超载处理）：{e}");
            false
        }
    }
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{
        create_block, create_task, mark_block_done, mark_block_missed, set_task_exempt, test_conn,
    };

    /// 测试用的固定「现在」：2031-01-15 12:00 本地（周三）—— 与下面造的时间戳同一条时间线
    fn fixed_now() -> i64 {
        let naive = chrono::NaiveDate::from_ymd_opt(2031, 1, 15)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        Local.from_local_datetime(&naive).earliest().unwrap().timestamp()
    }

    fn ts(y: i32, m: u32, d: u32, h: u32) -> i64 {
        let naive = chrono::NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, 0, 0)
            .unwrap();
        Local.from_local_datetime(&naive).earliest().unwrap().timestamp()
    }

    /// 直接往 events 表塞一行（本模块只读它；写接口在 db.rs 内部，测试里用 SQL 造更直接）
    fn push_event(conn: &Connection, block_id: &str, ty: &str, at: i64, payload: Option<&str>) {
        conn.execute(
            "INSERT INTO events (id, block_id, event_type, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![uuid::Uuid::new_v4().to_string(), block_id, ty, payload, at],
        )
        .expect("塞事件失败");
    }

    fn day_of(week: &SanityWeek, day: i64) -> &DayEnergy {
        week.days.iter().find(|d| d.day_start == day).expect("这一天在")
    }

    #[test]
    fn test_local_day_boundaries() {
        let day = local_day_start(ts(2031, 1, 15, 23));
        assert_eq!(day, ts(2031, 1, 15, 0), "23 点仍属于 1/15 这一天");
        assert_eq!(local_day_add(day, 1), ts(2031, 1, 16, 0));
        // 周一是一周之始：2031-01-13 是周一
        assert_eq!(week_start_of(ts(2031, 1, 15, 9)), ts(2031, 1, 13, 0));
    }

    #[test]
    fn test_segments_split_by_local_day() {
        // 20:00 → 次日 01:00：切两段（4 小时 + 1 小时）
        let segs = segments_by_day(
            ts(2031, 1, 15, 20),
            ts(2031, 1, 16, 1),
            ts(2031, 1, 13, 0),
            ts(2031, 1, 20, 0),
        );
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0], (ts(2031, 1, 15, 0), ts(2031, 1, 15, 20), ts(2031, 1, 16, 0)));
        assert_eq!(segs[1], (ts(2031, 1, 16, 0), ts(2031, 1, 16, 0), ts(2031, 1, 16, 1)));
    }

    #[test]
    fn test_union_seconds_merges_overlaps() {
        // 完全重叠
        assert_eq!(union_seconds(&mut [(0, 1800), (0, 1800)]), 1800);
        // 部分重叠：10:00-11:00 与 10:30-11:30 → 90 分钟
        assert_eq!(union_seconds(&mut [(0, 3600), (1800, 5400)]), 5400);
        // 相接不算重叠：两段各 1 小时 → 2 小时
        assert_eq!(union_seconds(&mut [(0, 3600), (3600, 7200)]), 7200);
        // 包含
        assert_eq!(union_seconds(&mut [(0, 7200), (1800, 3600)]), 7200);
        // 空
        assert_eq!(union_seconds(&mut []), 0);
    }

    /// **用户 2026-10-03 的现场**（图2）：并排两块各 30 分钟 → 那天只占 30 分钟，不是 60
    /// 注意：两块用**不同任务**（同任务同层的重叠块会被 `create_block` 就地融合 —— 那就不是「并排」了）
    #[test]
    fn test_side_by_side_blocks_count_once() {
        let conn = test_conn();
        let t1 = create_task(&conn, "并排甲", None).expect("建任务失败");
        let t2 = create_task(&conn, "并排乙", None).expect("建任务失败");
        create_block(&conn, &t1.id, ts(2031, 1, 15, 10), ts(2031, 1, 15, 10) + 1800)
            .expect("建块失败");
        create_block(&conn, &t2.id, ts(2031, 1, 15, 10), ts(2031, 1, 15, 10) + 1800)
            .expect("建块失败");
        let week = week_curve(&conn, week_start_of(ts(2031, 1, 15, 0)), fixed_now()).expect("算失败");
        let wed = day_of(&week, ts(2031, 1, 15, 0));
        assert_eq!(wed.minutes, 30, "并排两块 30 分钟 = 占 30 分钟（不是 60）");
        assert_eq!(wed.blocks, 2, "块数还是 2（只是时间只算一次）");
        assert_eq!(wed.energy_pct, 8, "30 / 360");
    }

    /// **用户 2026-10-03 的第 1 条**：挪过/没做完**不再**让分钟变大
    #[test]
    fn test_rearranged_or_skipped_does_not_inflate_minutes() {
        let conn = test_conn();
        let task = create_task(&conn, "老漂的活", None).expect("建任务失败");
        let b = create_block(&conn, &task.id, ts(2031, 1, 15, 10), ts(2031, 1, 15, 11))
            .expect("建块失败");
        push_event(&conn, &b.id, "postpone", ts(2031, 1, 15, 10), Some(r#"{"from":1,"to":2}"#));
        push_event(&conn, &b.id, "postpone", ts(2031, 1, 15, 11), Some(r#"{"from":2,"to":3}"#));
        mark_block_missed(&conn, &b.id).expect("标未完成失败");

        let week = week_curve(&conn, week_start_of(ts(2031, 1, 15, 0)), fixed_now()).expect("算失败");
        let wed = day_of(&week, ts(2031, 1, 15, 0));
        assert_eq!(wed.minutes, 60, "1 小时的块就是 1 小时 —— 数字要能跟眼睛对上");
        assert_eq!(wed.rearranged, 1, "「挪过」是一条事实（提示语用）");
        assert_eq!(wed.skipped, 1, "「没做完」也是事实（提示语用）");
        assert_eq!(wed.energy_pct, 17);
    }

    #[test]
    fn test_rearrange_counts_only_after_start() {
        let row = |ty: &str, at: i64, payload: Option<&str>| EventRow {
            block_id: "b".into(),
            event_type: ty.into(),
            created_at: at,
            payload: payload.map(|s| s.to_string()),
        };
        let start = ts(2031, 1, 15, 10);
        // 计划期内随手拖两次：事件**早于**原定起点（payload.from 比 created_at 晚）→ 不算
        let planning = vec![
            row("move", start - 7200, Some(&format!(r#"{{"from":{},"to":1}}"#, start + 1800))),
            row("move", start - 3600, Some(&format!(r#"{{"from":{},"to":2}}"#, start + 1800))),
        ];
        assert_eq!(count_rearrange_and_skip(&planning).0, 0, "计划期内的拖动不算「挪过」");
        // 过了点才挪两次 → 算
        let late = vec![
            row("move", start + 600, Some(&format!(r#"{{"from":{},"to":3}}"#, start - 60))),
            row("move", start + 1200, Some(&format!(r#"{{"from":{},"to":4}}"#, start - 60))),
        ];
        assert_eq!(count_rearrange_and_skip(&late).0, 2);
        // postpone 一律算；link 不算；skip 认出来
        let mixed = vec![
            row("postpone", start + 60, Some(r#"{"from":1,"to":2}"#)),
            row("postpone", start + 120, Some(r#"{"from":1,"to":3}"#)),
            row("link", start + 200, None),
            row("skip", start + 300, None),
        ];
        let (n, skipped) = count_rearrange_and_skip(&mixed);
        assert_eq!(n, 2);
        assert!(skipped, "skip 要认出来");
    }

    #[test]
    fn test_state_thresholds() {
        assert_eq!(state_of(287.0, 360), "calm"); // 79.7%
        assert_eq!(state_of(288.0, 360), "near"); // 80%
        assert_eq!(state_of(359.0, 360), "near");
        assert_eq!(state_of(360.0, 360), "over"); // 100%
        assert_eq!(state_of(3600.0, 360), "over");
    }

    /// 一天 12 个一小时的块（互相不挨着）= 12 小时 → 200%
    #[test]
    fn test_busy_day_of_small_blocks_is_overloaded() {
        let conn = test_conn();
        let task = create_task(&conn, "小活", None).expect("建任务失败");
        for i in 0..12 {
            // 每 90 分钟起一块、每块 60 分钟（缝 30 分钟）→ 不会被融合、也不重叠
            let start = ts(2031, 1, 15, 0) + i * 5400;
            create_block(&conn, &task.id, start, start + 3600).expect("建块失败");
        }
        let week = week_curve(&conn, week_start_of(ts(2031, 1, 15, 0)), fixed_now()).expect("算失败");
        let wed = day_of(&week, ts(2031, 1, 15, 0));
        assert_eq!(wed.minutes, 720, "12 小时都要算进去");
        assert_eq!(wed.energy_pct, 200);
        assert_eq!(wed.state, "over");
        assert_eq!(wed.blocks, 12);
    }

    /// 跨天块按天切分（各段进各天的并集）
    #[test]
    fn test_cross_day_block_splits_between_days() {
        let conn = test_conn();
        let task = create_task(&conn, "夜班", None).expect("建任务失败");
        // 20:00 → 次日 02:00（6 小时，跨天）
        create_block(&conn, &task.id, ts(2031, 1, 15, 20), ts(2031, 1, 16, 2)).expect("建块失败");
        let week = week_curve(&conn, week_start_of(ts(2031, 1, 15, 0)), fixed_now()).expect("算失败");
        let wed = day_of(&week, ts(2031, 1, 15, 0));
        let thu = day_of(&week, ts(2031, 1, 16, 0));
        assert_eq!(wed.minutes, 240, "周三 20:00–24:00 = 4 小时");
        assert_eq!(thu.minutes, 120, "周四 00:00–02:00 = 2 小时");
        assert_eq!(wed.blocks, 1);
        assert_eq!(thu.blocks, 1, "这块两边各算一块（各自那天）");
    }

    /// round48：**任务级**「不计入」—— 这条任务的**所有**块都不进并集、不计块数（用户 2026-10-03 拍板改口径）
    #[test]
    fn test_exempt_task_ignores_all_its_blocks() {
        let conn = test_conn();
        let task = create_task(&conn, "通勤", None).expect("建任务失败");
        let other = create_task(&conn, "写周报", None).expect("建任务失败");
        let a = create_block(&conn, &task.id, ts(2031, 1, 15, 9), ts(2031, 1, 15, 10)).expect("建块失败");
        let b = create_block(&conn, &task.id, ts(2031, 1, 15, 14), ts(2031, 1, 15, 16)).expect("建块失败");
        let c = create_block(&conn, &other.id, ts(2031, 1, 15, 17), ts(2031, 1, 15, 18)).expect("建块失败");

        let before = week_curve(&conn, week_start_of(ts(2031, 1, 15, 0)), fixed_now()).expect("算失败");
        assert_eq!(day_of(&before, ts(2031, 1, 15, 0)).minutes, 240, "三块都计入 = 4 小时");

        let updated = set_task_exempt(&conn, &task.id, true).expect("标不计入失败");
        assert!(updated.sanity_exempt);

        let after = week_curve(&conn, week_start_of(ts(2031, 1, 15, 0)), fixed_now()).expect("算失败");
        let wed = day_of(&after, ts(2031, 1, 15, 0));
        assert_eq!(wed.minutes, 60, "这条任务的两块都不算了，只剩别人的 1 小时");
        assert_eq!(wed.blocks, 1, "块数也不算它们");

        // 取消 → 回来（别的任务全程不受影响）
        set_task_exempt(&conn, &task.id, false).expect("取消排除失败");
        let back = week_curve(&conn, week_start_of(ts(2031, 1, 15, 0)), fixed_now()).expect("算失败");
        assert_eq!(day_of(&back, ts(2031, 1, 15, 0)).minutes, 240);
        let _ = (a, b, c);
    }

    /// round48：**旧的块级标记不再有任何影响**（列还在，但没有读者）——
    /// 直接往 `blocks.sanity_exempt` 写 1 → 占用照算（口径已经搬到任务上）
    #[test]
    fn test_legacy_block_flag_has_no_effect() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("建任务失败");
        let b = create_block(&conn, &task.id, ts(2031, 1, 15, 9), ts(2031, 1, 15, 10)).expect("建块失败");
        conn.execute("UPDATE blocks SET sanity_exempt = 1 WHERE id = ?1", [&b.id])
            .expect("写旧列失败");
        let week = week_curve(&conn, week_start_of(ts(2031, 1, 15, 0)), fixed_now()).expect("算失败");
        assert_eq!(day_of(&week, ts(2031, 1, 15, 0)).minutes, 60, "旧块级标记不该再影响结果");
    }

    /// 任务级标记要被撤销快照带着走（`Ctrl+Z` 能撤）
    #[test]
    fn test_exempt_flag_is_in_snapshots() {
        let conn = test_conn();
        let task = create_task(&conn, "家务", None).expect("建任务失败");
        let snap = db::dump_tables(&conn).expect("拍快照失败");
        set_task_exempt(&conn, &task.id, true).expect("标不计入失败");
        db::restore_tables(&conn, &snap).expect("恢复失败");
        let back = db::load_task(&conn, &task.id).expect("查失败").expect("任务不在");
        assert!(!back.sanity_exempt, "撤销后回到「计入」");
    }

    #[test]
    fn test_empty_week_is_calm() {
        let conn = test_conn();
        let week = week_curve(&conn, week_start_of(ts(2031, 1, 15, 0)), fixed_now()).expect("算失败");
        assert_eq!(week.days.len(), 7);
        assert!(week.days.iter().all(|d| d.minutes == 0 && d.energy_pct == 0 && d.state == "calm"));
        assert_eq!(week.worst_state, "calm");
        assert_eq!(week.today_index, 2, "2031-01-15 是那一周的周三（下标 2）");
        assert_eq!(week.days[2].day_start, ts(2031, 1, 15, 0));
    }

    #[test]
    fn test_budget_and_switch_come_from_settings() {
        let conn = test_conn();
        assert_eq!(budget_minutes(&conn), DEFAULT_BUDGET_MINUTES, "默认 6 小时");
        assert!(enabled(&conn), "默认开");
        db::set_setting(&conn, KEY_BUDGET, "120").expect("写预算失败");
        assert_eq!(budget_minutes(&conn), 120);
        db::set_setting(&conn, KEY_BUDGET, "0").expect("写预算失败");
        assert_eq!(budget_minutes(&conn), MIN_BUDGET_MINUTES, "非法值（0）回退并夹到下限");
        db::set_setting(&conn, KEY_BUDGET, "abc").expect("写预算失败");
        assert_eq!(budget_minutes(&conn), DEFAULT_BUDGET_MINUTES, "非数字回退默认");
        db::set_setting(&conn, KEY_ENABLED, "0").expect("写开关失败");
        assert!(!enabled(&conn));
    }

    #[test]
    fn test_today_overloaded_and_switch_off() {
        let conn = test_conn();
        let task = create_task(&conn, "堆满", None).expect("建任务失败");
        // 今天（1/15）排 7 小时 → 超过 6 小时预算
        create_block(&conn, &task.id, ts(2031, 1, 15, 8), ts(2031, 1, 15, 15)).expect("建块失败");
        assert!(today_overloaded(&conn, fixed_now()), "今天超载");
        db::set_setting(&conn, KEY_ENABLED, "0").expect("写开关失败");
        assert!(!today_overloaded(&conn, fixed_now()), "关掉功能就不进超载");
    }

    /// 已完成的块也照算 —— 顺带确认 `mark_block_done` 写的 complete 事件不会把它算成「没做完」
    #[test]
    fn test_done_block_counts_normally() {
        let conn = test_conn();
        let task = create_task(&conn, "写周报", None).expect("建任务失败");
        let b = create_block(&conn, &task.id, ts(2031, 1, 15, 9), ts(2031, 1, 15, 10)).expect("建块失败");
        mark_block_done(&conn, &b.id).expect("标完成失败");
        let week = week_curve(&conn, week_start_of(ts(2031, 1, 15, 0)), fixed_now()).expect("算失败");
        let wed = day_of(&week, ts(2031, 1, 15, 0));
        assert_eq!(wed.minutes, 60);
        assert_eq!(wed.skipped, 0, "完成不是没做完");
    }

    /// 过了原起点才挪 → 记一条「挪过」事实；分钟数不变（round45 口径）
    /// ⚠️ 时间必须**围绕真实的现在**：`update_block` 写的事件时间是 `db::now()`
    #[test]
    fn test_late_move_is_a_fact_not_a_multiplier() {
        let conn = test_conn();
        let task = create_task(&conn, "开会", None).expect("建任务失败");
        let now = db::now();
        // 2026-10-03（round52）：块一律锚在**昨天中午** —— 以前拿 `now` 做起点，跨午夜跑
        // （00:08 时 `now-60 分` 会跨到昨天）时「今天」只剩 8 分钟 → 测试自己红 ✗（时钟依赖）。
        // 事件的时间戳仍是真实 now，所以「过了原起点才挪」的判定照样测得到。
        let base = local_day_add(local_day_start(now), -1) + 12 * 3600;
        let b = create_block(&conn, &task.id, base, base + 3600).expect("建块失败");
        db::update_block(&conn, &b.id, None, Some(base + 2 * 3600), Some(base + 3 * 3600), None)
            .expect("移动失败");
        db::update_block(&conn, &b.id, None, Some(base + 4 * 3600), Some(base + 5 * 3600), None)
            .expect("移动失败");

        let events = events_in_window(&conn, 0, i64::MAX).expect("读事件失败");
        let (rearranged, skipped) = count_rearrange_and_skip(&events);
        assert_eq!(rearranged, 2, "过了原起点才挪的两次都要算");
        assert!(!skipped);

        let day = local_day_start(base);
        let week = week_curve(&conn, week_start_of(day), now).expect("算失败");
        let d = day_of(&week, day);
        assert_eq!(d.minutes, 60, "这块就占 1 小时 —— 事实不参与算术");
        assert_eq!(d.rearranged, 1, "但要标出一条「挪过」事实");
    }
}
