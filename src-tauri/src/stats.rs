//! 10.1 统计页（R36 / round60 / 0.14.0）：把 `events` 汇成「只摆事实」的累计数字 —— **唯一实现**。
//!
//! ## 口径（审计表与设计说明见 `docs/plans/round60-stats-page.md` §二）
//!
//! ```text
//! 完成     标为完成 / 标为未完成 / 完成率（✓ ÷ (✓+✗)，分母 0 → 无）
//! 排程     新建块（含临时）/ 移动位置 / 调整时长 / 漂移 / 自动顺延 / 删除块 / 融合
//! 序列     接进序列 / 从序列取出
//! 时间     完成时长（payload.minutes；老事件用仍留在库里的块兜底）
//! 记录     起始时间 / 用过的天数 / 事件总数
//! 近 12 周 每周 ✓/✗/漂移（一条事件都没有的周不出现）
//! ```
//!
//! 三条易错点（都在单测里钉住）：
//! - **自动顺延** = 任意事件 `payload.cascade == true` → 不重复计入「移动位置 / 漂移 / 接进序列」；
//! - 漂流内部建的块**不产生 `create` 事件**（`db::create_block_inner` 的 `log_create=false` 分支）；
//! - 本地日 / 本地周一律复用 `sanity.rs` 的日期加法（夏令时），不 ±86400。

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde::Serialize;

use crate::db;
use crate::sanity::{local_day_start, week_start_of};
use crate::i18n;
use crate::tf;

/// 近 12 周（含本周）—— 与总览「往期」同一段窗口
pub const RECENT_WEEKS: usize = 12;

/// round79（78-10）：「重置统计」的时间界 —— **内部键**（不进 `KNOWN_KEYS`，照 `review_nudged_week` 口径）。
///
/// 为什么用时间界而不是删 `events`：`events` 同时喂 ①成就引擎（`achievements::collect_metrics`）
/// ②复盘的理智曲线（`sanity::events_in_window`）③重复任务水位线 —— `DELETE` 会把历史一起改掉
/// （见 `docs/plans/round79-fixes-and-resets.md` §3.5）。写这个键以后统计页只数它之后的事件；
/// **一条数据都没删**，清掉这个键就回到全史（回退见验收「回退」一节）。
pub const KEY_RESET_AT: &str = "stats_reset_at";

/// 读时间界（缺省 / 坏值 = `0` = 全史 —— 与旧行为逐字节一致）
pub fn reset_at(conn: &Connection) -> i64 {
    db::get_setting(conn, KEY_RESET_AT)
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(0)
}

/// 写时间界（`reset_stats` 用）
pub fn set_reset_at(conn: &Connection, at: i64) -> Result<(), String> {
    db::set_setting(conn, KEY_RESET_AT, &at.to_string())
}

/// 近 12 周的一行（只含有事件的周；数值可以是 0 —— 那周确实干过别的）
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StatsWeekRow {
    pub week_start: i64,
    pub done: u32,
    pub missed: u32,
    pub postponed: u32,
}

/// round82（统-03）：每日完成趋势的一行（近 14 天；**旧 → 新**；没完成的日子照摆 `0`）
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StatsDayRow {
    /// 本地日 00:00
    pub day: i64,
    pub done: u32,
}

/// round82（统-07）：分类分布的一行；`category` 空串 = 「早期数据（无分类）」（永远排最后）
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StatsCategoryRow {
    pub category: String,
    pub done: u32,
    /// 计划时长（分钟；没记录的那几条不进这里）
    pub minutes: i64,
}

/// round82（统-03）：每日完成趋势的窗口（含今天）
pub const TREND_DAYS: i64 = 14;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Stats {
    /// 最早一条事件的时刻（一条都没有 → None）
    pub first_event_at: Option<i64>,
    /// 有事件的**本地日**数
    pub active_days: u32,
    /// 事件总数（含未知类型 —— 「都存着」这句话得是真的）
    pub total_events: u32,
    pub complete: u32,
    pub skip: u32,
    /// 完成率百分比（四舍五入）；分母 0 → None（界面显示「—」）
    pub rate_pct: Option<i64>,
    pub created: u32,
    /// 其中「临时安排块」（双击空白格建的）
    pub created_temp: u32,
    /// 拖动 / 键盘 / 从 Backlog 放入后调整，**起点变了**
    pub moved: u32,
    /// 拉伸 / `Shift+↑↓`，**起点没变、终点变了**
    pub stretched: u32,
    /// 用户自己点的「漂」（非顺延）
    pub postponed: u32,
    /// 序列/漂移把后面的环连带挪走（任意事件 payload.cascade）
    pub cascaded: u32,
    /// 删掉的**块数**（一次删多个算在一起，含漂移后续）
    pub deleted: u32,
    /// 相邻同任务块自动合并（每次吃掉 1 块）
    pub merged: u32,
    /// 接进序列（非顺延）
    pub linked: u32,
    /// 从序列取出
    pub unlinked: u32,
    /// 完成时长（分钟；payload.minutes + 老事件用库里残块兜底）
    pub done_minutes: i64,
    /// 其中**有时长记录**的完成条数（< complete 时界面说明口径）
    pub done_timed: u32,
    /// round82（统-03）：近 14 天每日完成数（**旧 → 新**，0 值照摆）
    pub trend: Vec<StatsDayRow>,
    /// round82（统-04）：按时完成条数（`delay_minutes <= minutes + 15`，与块上的「超时」同一条线）
    pub on_time: u32,
    /// 按时率的分母：**同时有** minutes 与 delay_minutes 的完成（老账缺字段 → 不进分母）
    pub rated: u32,
    /// 按时率百分比（四舍五入）；分母 0 → None（界面「—」）
    pub on_time_pct: Option<i64>,
    /// round82（统-05）：平均单块（计划）分钟；没有时长记录 → None
    pub avg_minutes: Option<i64>,
    /// round82（统-06）：当前连续（到昨天为止；今天还没完成不算断）
    pub streak_now: u32,
    /// 历史最长连续（自然日）
    pub streak_best: u32,
    /// round82（统-07）：分类分布（时长降序；无分类永远最后一栏）
    pub categories: Vec<StatsCategoryRow>,
    /// 近 12 周（**新 → 旧**；只列有事件的周）
    pub weeks: Vec<StatsWeekRow>,
}

/// move 事件的三种去向（顺延优先 —— 顺延带着 from/to，别被起点-终点的判断抢走）
#[derive(Debug, Clone, Copy, PartialEq)]
enum MoveKind {
    Cascade,
    Stretch,
    Moved,
}

fn payload_value(payload: Option<&str>) -> Option<serde_json::Value> {
    serde_json::from_str(payload?).ok()
}

fn is_cascade(payload: Option<&str>) -> bool {
    payload_value(payload)
        .and_then(|v| v.get("cascade").and_then(|c| c.as_bool()))
        .unwrap_or(false)
}

fn classify_move(payload: Option<&str>) -> MoveKind {
    if is_cascade(payload) {
        return MoveKind::Cascade;
    }
    let Some(v) = payload_value(payload) else {
        return MoveKind::Moved; // 没 payload 的老数据：只能算移动
    };
    let from = v.get("from").and_then(|x| x.as_i64());
    let to = v.get("to").and_then(|x| x.as_i64());
    let end_from = v.get("end_from").and_then(|x| x.as_i64());
    let end_to = v.get("end_to").and_then(|x| x.as_i64());
    if let (Some(f), Some(t), Some(ef), Some(et)) = (from, to, end_from, end_to) {
        if f == t && ef != et {
            return MoveKind::Stretch;
        }
    }
    MoveKind::Moved
}

fn payload_minutes(payload: Option<&str>) -> Option<i64> {
    payload_value(payload)?.get("minutes").and_then(|m| m.as_i64())
}

/// `delete` 事件删了几块；坏 payload **保守算 1**（宁可少算也不丢动作 —— 事件确实发生过）
fn payload_count(payload: Option<&str>) -> u32 {
    payload_value(payload)
        .and_then(|v| v.get("count").and_then(|c| c.as_u64()))
        .map(|n| n.min(u32::MAX as u64) as u32)
        .unwrap_or(1)
}

/// 完成率：`✓ ÷ (✓ + ✗)`；分母 0 → None（界面「—」，不编 0%/100%）
fn rate_pct(complete: u32, skip: u32) -> Option<i64> {
    let total = complete as u64 + skip as u64;
    if total == 0 {
        None
    } else {
        Some(((complete as f64 / total as f64) * 100.0).round() as i64)
    }
}

/// 汇总（`now` 传参 —— 不偷看真挂钟；`weeks` = 近多少周）
pub fn summary(conn: &Connection, now: i64, weeks: usize, since: i64) -> Result<Stats, String> {
    // ① 全表只取「类型 + 时刻」：总数 / 起始 / 活跃天 / 周骨架 / 不需要 payload 的计数
    let mut total_events: u32 = 0;
    let mut complete: u32 = 0;
    let mut skip: u32 = 0;
    let mut created: u32 = 0;
    let mut merged: u32 = 0;
    // `unlink` 不需要 payload（没有要读的字段）→ 在计数那一趟就数掉
    let mut unlinked: u32 = 0;
    let mut first_event_at: Option<i64> = None;
    let mut days: HashSet<i64> = HashSet::new();
    let mut week_has_event: HashSet<i64> = HashSet::new();
    let mut week_done: HashMap<i64, (u32, u32, u32)> = HashMap::new();
    // round82（统-03）：每日完成数（趋势 / 连续天数共用同一个账本）
    let mut day_done: HashMap<i64, u32> = HashMap::new();

    {
        let mut stmt = conn
            .prepare("SELECT event_type, created_at FROM events WHERE created_at >= ?1")
            .map_err(|e| tf!(i18n::msg::ERR_STATS_01, e = e))?;
        let rows = stmt
            .query_map([since], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| tf!(i18n::msg::ERR_STATS_02, e = e))?;
        for row in rows {
            let (ty, at) = row.map_err(|e| tf!(i18n::msg::ERR_STATS_03, e = e))?;
            total_events += 1;
            first_event_at = Some(first_event_at.map_or(at, |f| f.min(at)));
            let day = local_day_start(at);
            days.insert(day);
            let wk = week_start_of(day);
            week_has_event.insert(wk);
            let bucket = week_done.entry(wk).or_insert((0, 0, 0));
            match ty.as_str() {
                "complete" => {
                    complete += 1;
                    bucket.0 += 1;
                    *day_done.entry(day).or_insert(0) += 1;
                }
                "skip" => {
                    skip += 1;
                    bucket.1 += 1;
                }
                "create" => created += 1,
                "merge" => merged += 1,
                "unlink" => unlinked += 1,
                _ => {}
            }
        }
    }

    // ② 只在需要 payload 的类型上取 payload（规模：十年 10 万条也只是多跑几毫秒）
    let mut created_temp: u32 = 0;
    let mut moved: u32 = 0;
    let mut stretched: u32 = 0;
    let mut postponed: u32 = 0;
    let mut cascaded: u32 = 0;
    let mut deleted: u32 = 0;
    let mut linked: u32 = 0;
    let mut done_minutes: i64 = 0;
    let mut done_timed: u32 = 0;
    // round82（统-04）：按时率（分母 = 同时有 minutes + delay_minutes 的完成）
    let mut on_time: u32 = 0;
    let mut rated: u32 = 0;
    // round82（统-07）：分类分布（空串 = 无分类 / 早期数据）
    let mut cat_count: HashMap<String, (u32, i64)> = HashMap::new();

    // 完成时长兜底：仍留在库里的 done 块（0.14.0 之前的 complete 事件没有 minutes）
    let mut living_done: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, end_at - start_at FROM blocks WHERE status = 'done'")
            .map_err(|e| tf!(i18n::msg::ERR_STATS_04, e = e))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| tf!(i18n::msg::ERR_STATS_05, e = e))?;
        for row in rows {
            let (id, seconds) = row.map_err(|e| tf!(i18n::msg::ERR_STATS_06, e = e))?;
            living_done.insert(id, seconds / 60);
        }
    }

    {
        let mut stmt = conn
            .prepare(
                "SELECT event_type, payload, created_at, block_id FROM events
                 WHERE event_type IN ('create','move','postpone','complete','delete','link') AND created_at >= ?1",
            )
            .map_err(|e| tf!(i18n::msg::ERR_STATS_07, e = e))?;
        let rows = stmt
            .query_map([since], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| tf!(i18n::msg::ERR_STATS_08, e = e))?;
        for row in rows {
            let (ty, payload, at, block_id) = row.map_err(|e| tf!(i18n::msg::ERR_STATS_09, e = e))?;
            let payload = payload.as_deref();
            let bucket = week_done.entry(week_start_of(local_day_start(at))).or_insert((0, 0, 0));
            match ty.as_str() {
                "create" => {
                    if payload_value(payload)
                        .and_then(|v| v.get("temp").and_then(|t| t.as_bool()))
                        .unwrap_or(false)
                    {
                        created_temp += 1;
                    }
                }
                "move" => match classify_move(payload) {
                    MoveKind::Cascade => cascaded += 1,
                    MoveKind::Stretch => stretched += 1,
                    MoveKind::Moved => moved += 1,
                },
                "postpone" => {
                    if is_cascade(payload) {
                        cascaded += 1;
                    } else {
                        postponed += 1;
                        bucket.2 += 1;
                    }
                }
                "complete" => {
                    let minutes =
                        payload_minutes(payload).or_else(|| living_done.get(&block_id).copied());
                    if let Some(m) = minutes {
                        done_minutes += m;
                        done_timed += 1;
                    }
                    // round82（统-04）：按时率 —— 只认 payload 里**同时**有 minutes + delay_minutes
                    // 的完成（老账缺字段不进分母）；宽限与块上的「超时」判定同源。
                    if let (Some(m), Some(delay)) = (
                        payload_minutes(payload),
                        payload_value(payload)
                            .and_then(|v| v.get("delay_minutes").and_then(|x| x.as_i64())),
                    ) {
                        rated += 1;
                        if delay <= m + db::OVERTIME_GRACE_SECONDS / 60 {
                            on_time += 1;
                        }
                    }
                    // round82（统-07 · 用户拍的 ①）：分类快照（缺字段 = 空 = 旧账 / 无分类）。
                    // 注意：**不**用任务现况反推（② 只覆盖 23%，已否）。
                    let cat = payload_value(payload)
                        .and_then(|v| {
                            v.get("category")
                                .and_then(|c| c.as_str())
                                .map(|s| s.trim().to_string())
                        })
                        .filter(|c| !c.is_empty())
                        .unwrap_or_default();
                    let entry = cat_count.entry(cat).or_insert((0, 0));
                    entry.0 += 1;
                    entry.1 += minutes.unwrap_or(0);
                }
                "delete" => deleted += payload_count(payload),
                "link" => {
                    if is_cascade(payload) {
                        cascaded += 1;
                    } else {
                        linked += 1;
                    }
                }
                _ => {}
            }
        }
    }

    // ③ 近 N 周（新 → 旧；**只列有事件的周** —— 那周干过别的，数值可以是 0）
    let mut out_weeks = Vec::new();
    let mut wk = week_start_of(local_day_start(now));
    for _ in 0..weeks {
        if week_has_event.contains(&wk) {
            let (d, m, p) = week_done.get(&wk).copied().unwrap_or((0, 0, 0));
            out_weeks.push(StatsWeekRow {
                week_start: wk,
                done: d,
                missed: m,
                postponed: p,
            });
        }
        wk = crate::sanity::local_day_add(wk, -7);
    }

    // ④ round82（统-03…07）：趋势 / 连续 / 平均 / 按时率 / 分类分布 —— 全部只用上面两趟的账本
    let today = local_day_start(now);
    let mut trend = Vec::with_capacity(TREND_DAYS as usize);
    let mut cursor = crate::sanity::local_day_add(today, -(TREND_DAYS - 1));
    for _ in 0..TREND_DAYS {
        trend.push(StatsDayRow {
            day: cursor,
            done: day_done.get(&cursor).copied().unwrap_or(0),
        });
        cursor = crate::sanity::local_day_add(cursor, 1);
    }

    // 历史最长连续：把有完成的日子排序后数「逐日 +1」的连段
    let mut done_days: Vec<i64> = day_done.keys().copied().collect();
    done_days.sort_unstable();
    let mut streak_best: u32 = 0;
    let mut run: u32 = 0;
    let mut prev: Option<i64> = None;
    for d in &done_days {
        run = match prev {
            Some(p) if crate::sanity::local_day_add(p, 1) == *d => run + 1,
            _ => 1,
        };
        streak_best = streak_best.max(run);
        prev = Some(*d);
    }
    // 当前连续：从今天往回数；**今天还没完成不算断**（从昨天接着数 —— 今天还没过完）
    let mut cursor = if day_done.contains_key(&today) {
        today
    } else {
        crate::sanity::local_day_add(today, -1)
    };
    let mut streak_now: u32 = 0;
    while day_done.contains_key(&cursor) {
        streak_now += 1;
        cursor = crate::sanity::local_day_add(cursor, -1);
    }

    // 分类分布：时长降序（并列比条数、再比名字）；无分类永远排最后一栏
    let untagged = cat_count.remove("");
    let mut categories: Vec<StatsCategoryRow> = cat_count
        .into_iter()
        .map(|(category, (done, minutes))| StatsCategoryRow {
            category,
            done,
            minutes,
        })
        .collect();
    categories.sort_by(|a, b| {
        b.minutes
            .cmp(&a.minutes)
            .then(b.done.cmp(&a.done))
            .then_with(|| a.category.cmp(&b.category))
    });
    if let Some((done, minutes)) = untagged {
        categories.push(StatsCategoryRow {
            category: String::new(),
            done,
            minutes,
        });
    }

    Ok(Stats {
        first_event_at,
        active_days: days.len() as u32,
        total_events,
        complete,
        skip,
        rate_pct: rate_pct(complete, skip),
        created,
        created_temp,
        moved,
        stretched,
        postponed,
        cascaded,
        deleted,
        merged,
        linked,
        unlinked,
        done_minutes,
        done_timed,
        // round82（统-03…07）：新指标
        trend,
        on_time,
        rated,
        on_time_pct: if rated == 0 {
            None
        } else {
            Some(((on_time as f64 / rated as f64) * 100.0).round() as i64)
        },
        avg_minutes: if done_timed == 0 {
            None
        } else {
            Some((done_minutes + done_timed as i64 / 2) / done_timed as i64)
        },
        streak_now,
        streak_best,
        categories,
        weeks: out_weeks,
    })
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_block, create_task, test_conn};
    use chrono::{Local, TimeZone};

    /// 固定「现在」：2031-01-15 12:00 本地（周三）—— 与下面造的时间戳同一条时间线
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

    /// 直接往 events 表塞一行（写接口在 db.rs 内部；统计只读它，测试里造数据更直接）
    fn push_event(conn: &Connection, block_id: &str, ty: &str, at: i64, payload: Option<&str>) {
        conn.execute(
            "INSERT INTO events (id, block_id, event_type, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![uuid::Uuid::new_v4().to_string(), block_id, ty, payload, at],
        )
        .expect("塞事件失败");
    }

    fn sum(conn: &Connection) -> Stats {
        summary(conn, fixed_now(), RECENT_WEEKS, 0).expect("统计失败")
    }

    /** round79（78-10）：带时间界的那一份（= 「重置统计」之后看到的数字） */
    fn sum_since(conn: &Connection, since: i64) -> Stats {
        summary(conn, fixed_now(), RECENT_WEEKS, since).expect("统计失败")
    }

    #[test]
    fn test_reset_at_default_and_roundtrip() {
        let conn = test_conn();
        assert_eq!(reset_at(&conn), 0, "没重置过 → 0（全史，与旧行为一致）");
        set_reset_at(&conn, ts(2031, 1, 15, 11)).expect("写时间界失败");
        assert_eq!(reset_at(&conn), ts(2031, 1, 15, 11));
        // 坏值 / 负数都读回 0（不报错、不卡死）
        db::set_setting(&conn, KEY_RESET_AT, "abc").unwrap();
        assert_eq!(reset_at(&conn), 0);
        db::set_setting(&conn, KEY_RESET_AT, "-5").unwrap();
        assert_eq!(reset_at(&conn), 0);
    }

    #[test]
    fn test_summary_since_only_counts_after_the_line() {
        let conn = test_conn();
        // 重置线之前（**上一周**，顺带验周表也会被过滤）：2 完成 + 1 未完成 + 1 建块
        push_event(&conn, "b1", "complete", ts(2031, 1, 8, 9), None);
        push_event(&conn, "b2", "complete", ts(2031, 1, 8, 10), None);
        push_event(&conn, "b3", "skip", ts(2031, 1, 8, 11), None);
        push_event(&conn, "b4", "create", ts(2031, 1, 8, 12), Some(r#"{"temp":true}"#));
        let line = ts(2031, 1, 15, 0);
        // 线之后：1 完成（带 minutes）+ 1 未完成
        push_event(&conn, "b5", "complete", ts(2031, 1, 15, 9), Some(r#"{"minutes":30}"#));
        push_event(&conn, "b6", "skip", ts(2031, 1, 15, 10), None);

        let all = sum(&conn);
        assert_eq!(all.total_events, 6, "不传时间界 = 全史（旧行为）");
        assert_eq!(all.complete, 3);
        assert_eq!(all.created, 1);
        assert_eq!(all.created_temp, 1);
        assert_eq!(all.first_event_at, Some(ts(2031, 1, 8, 9)));
        assert_eq!(all.weeks.len(), 2, "两周都有事件");

        let after = sum_since(&conn, line);
        assert_eq!(after.total_events, 2);
        assert_eq!(after.complete, 1);
        assert_eq!(after.skip, 1);
        assert_eq!(after.created, 0, "重置线之前的建块不算");
        assert_eq!(after.created_temp, 0);
        assert_eq!(after.first_event_at, Some(ts(2031, 1, 15, 9)), "「记录始于」变成本周那条");
        assert_eq!((after.done_minutes, after.done_timed), (30, 1));
        assert_eq!(after.rate_pct, Some(50));
        assert_eq!(after.active_days, 1);
        assert_eq!(after.weeks.len(), 1, "周表只剩线之后那一周");
        assert_eq!(
            after.weeks[0].week_start,
            week_start_of(local_day_start(ts(2031, 1, 15, 9)))
        );
        assert_eq!((after.weeks[0].done, after.weeks[0].missed), (1, 1));
    }

    #[test]
    fn test_empty_db() {
        let conn = test_conn();
        let s = sum(&conn);
        assert_eq!(s.total_events, 0);
        assert_eq!(s.first_event_at, None);
        assert_eq!(s.rate_pct, None, "没有标记史 → 完成率是「—」，不是 0%");
        assert!(s.weeks.is_empty());
        assert_eq!(s.done_minutes, 0);
        assert_eq!(s.done_timed, 0);
    }

    #[test]
    fn test_mark_counts_and_rate() {
        let conn = test_conn();
        push_event(&conn, "b1", "complete", ts(2031, 1, 14, 10), None);
        push_event(&conn, "b2", "complete", ts(2031, 1, 14, 11), None);
        push_event(&conn, "b3", "skip", ts(2031, 1, 14, 12), None);
        let s = sum(&conn);
        assert_eq!((s.complete, s.skip), (2, 1));
        assert_eq!(s.rate_pct, Some(67), "2/3 → 67%");
        // 只有 ✗ 时是 0% 而不是「—」（分母存在）
        let conn2 = test_conn();
        push_event(&conn2, "b1", "skip", ts(2031, 1, 14, 10), None);
        assert_eq!(sum(&conn2).rate_pct, Some(0));
    }

    #[test]
    fn test_move_vs_stretch_vs_cascade() {
        let conn = test_conn();
        // 拖动：起点终点都变了
        push_event(
            &conn,
            "b1",
            "move",
            ts(2031, 1, 14, 10),
            Some(r#"{"from":100,"to":200,"end_from":300,"end_to":400}"#),
        );
        // 拉伸：起点没变、终点变了
        push_event(
            &conn,
            "b1",
            "move",
            ts(2031, 1, 14, 11),
            Some(r#"{"from":100,"to":100,"end_from":300,"end_to":500}"#),
        );
        // 老形状（只有 from/to）→ 只能算移动
        push_event(&conn, "b1", "move", ts(2031, 1, 14, 12), Some(r#"{"from":1,"to":2}"#));
        // 顺延：即使形状像拉伸也只进「自动顺延」
        push_event(
            &conn,
            "b2",
            "move",
            ts(2031, 1, 14, 13),
            Some(r#"{"from":100,"to":100,"end_from":300,"end_to":500,"cascade":true}"#),
        );
        let s = sum(&conn);
        assert_eq!(s.moved, 2, "拖动 1 + 老形状 1");
        assert_eq!(s.stretched, 1);
        assert_eq!(s.cascaded, 1);
    }

    #[test]
    fn test_cascade_not_double_counted_on_link_and_postpone() {
        let conn = test_conn();
        push_event(&conn, "a", "link", ts(2031, 1, 14, 10), Some(r#"{"after":"x","moved_self":true}"#));
        push_event(&conn, "b", "link", ts(2031, 1, 14, 11), Some(r#"{"from":1,"to":2,"cascade":true}"#));
        push_event(&conn, "a", "postpone", ts(2031, 1, 14, 12), Some(r#"{"from":1,"to":2}"#));
        push_event(&conn, "b", "postpone", ts(2031, 1, 14, 13), Some(r#"{"from":1,"to":2,"cascade":true}"#));
        let s = sum(&conn);
        assert_eq!(s.linked, 1);
        assert_eq!(s.postponed, 1);
        assert_eq!(s.cascaded, 2);
        // 周表里也只算用户那一次漂移
        let cur = week_start_of(local_day_start(fixed_now()));
        let row = s.weeks.iter().find(|w| w.week_start == cur).expect("这一周在");
        assert_eq!(row.postponed, 1);
    }

    #[test]
    fn test_create_delete_unlink_counts() {
        let conn = test_conn();
        push_event(&conn, "b1", "create", ts(2031, 1, 14, 10), Some(r#"{"temp":false}"#));
        push_event(&conn, "b2", "create", ts(2031, 1, 14, 11), Some(r#"{"temp":true}"#));
        push_event(&conn, "b3", "delete", ts(2031, 1, 14, 12), Some(r#"{"count":3}"#));
        push_event(&conn, "b4", "delete", ts(2031, 1, 14, 13), None); // 坏/缺 payload → 保守算 1
        push_event(&conn, "b5", "unlink", ts(2031, 1, 14, 14), None);
        push_event(&conn, "b6", "unlink_drift", ts(2031, 1, 14, 15), None); // 自动修复 → 不进统计行
        let s = sum(&conn);
        assert_eq!((s.created, s.created_temp), (2, 1));
        assert_eq!(s.deleted, 4, "3 + 保守算的 1");
        assert_eq!(s.unlinked, 1);
        assert_eq!(s.total_events, 6, "总数含 unlink_drift；但行里不摆它");
    }

    #[test]
    fn test_done_minutes_payload_then_living_fallback() {
        let conn = test_conn();
        // 老事件：没有 minutes → 用仍留在库里的 done 块兜底
        let task = create_task(&conn, "写周报", None).expect("建任务");
        let alive = create_block(&conn, &task.id, ts(2031, 1, 14, 9), ts(2031, 1, 14, 10)).expect("建块");
        conn.execute("UPDATE blocks SET status = 'done' WHERE id = ?1", [&alive.id])
            .expect("改状态");
        push_event(&conn, &alive.id, "complete", ts(2031, 1, 14, 10), None);
        // 新事件：带 minutes
        push_event(
            &conn,
            "gone-block",
            "complete",
            ts(2031, 1, 14, 11),
            Some(r#"{"minutes":45}"#),
        );
        // 块已删且无 minutes → 没得算（不计入分钟，也不计入「有时长记录」）
        push_event(&conn, "ghost", "complete", ts(2031, 1, 14, 12), None);
        let s = sum(&conn);
        assert_eq!(s.complete, 3);
        assert_eq!(s.done_minutes, 60 + 45, "库里残块 60 分 + payload 45 分");
        assert_eq!(s.done_timed, 2, "3 次完成里只有 2 次有时长记录");
    }

    #[test]
    fn test_weeks_only_with_events_and_last_12() {
        let conn = test_conn();
        let this_week = week_start_of(local_day_start(fixed_now()));
        let three_ago = crate::sanity::local_day_add(this_week, -21);
        let thirteen_ago = crate::sanity::local_day_add(this_week, -12 * 7);
        push_event(&conn, "a", "complete", this_week + 3600, None);
        push_event(&conn, "b", "skip", three_ago + 3600, None);
        push_event(&conn, "c", "move", thirteen_ago + 3600, Some(r#"{"from":1,"to":2}"#));
        let s = sum(&conn);
        let starts: Vec<i64> = s.weeks.iter().map(|w| w.week_start).collect();
        assert_eq!(starts, vec![this_week, three_ago], "新 → 旧；13 周前不进表");
        assert_eq!(s.weeks[0].done, 1);
        assert_eq!(s.weeks[1].missed, 1);
        // 有事件的周哪怕没有 ✓/✗/漂移也会出现（数值是 0）
        assert_eq!(s.weeks[0].postponed, 0);
    }

    #[test]
    fn test_unknown_type_and_active_days() {
        let conn = test_conn();
        push_event(&conn, "a", "complete", ts(2031, 1, 14, 1), None);
        push_event(&conn, "b", "未来新类型", ts(2031, 1, 14, 23), Some(r#"{不是JSON"#));
        push_event(&conn, "c", "merge", ts(2031, 1, 15, 2), None);
        let s = sum(&conn);
        assert_eq!(s.total_events, 3, "未知类型也进总数");
        assert_eq!(s.active_days, 2, "1/14 与 1/15 两个本地日");
        assert_eq!(s.first_event_at, Some(ts(2031, 1, 14, 1)));
        assert_eq!(s.merged, 1);
    }

    #[test]
    fn test_bad_payload_is_conservative_not_panic() {
        let conn = test_conn();
        // 手改库 / 历史怪数据：坏 JSON 不能让整页崩，也不能丢动作 —— 按最保守口径归
        push_event(&conn, "b1", "move", ts(2031, 1, 14, 10), Some("{不是JSON"));
        push_event(&conn, "b2", "delete", ts(2031, 1, 14, 11), Some("{不是JSON"));
        push_event(&conn, "b3", "complete", ts(2031, 1, 14, 12), Some("{不是JSON"));
        push_event(&conn, "b4", "create", ts(2031, 1, 14, 13), Some("{不是JSON"));
        let s = sum(&conn);
        assert_eq!(s.moved, 1, "坏 payload 的 move 算移动（不丢动作）");
        assert_eq!(s.deleted, 1, "坏 payload 的 delete 保守算 1 块");
        assert_eq!(s.complete, 1, "坏 payload 的 complete 照样计数");
        assert_eq!(s.done_timed, 0, "没 minutes、块也不在库里 → 不计时长");
        assert_eq!(s.created, 1, "坏 payload 的 create 照样计数");
        assert_eq!(s.created_temp, 0, "读不出 temp 就不算子计数（宁少不多）");
    }

    // ===== round82（统-03…08）：新指标的五条口径（正常 + 边界）=====

    #[test]
    fn test_trend_14_days_zero_filled() {
        let conn = test_conn();
        let today = local_day_start(fixed_now());
        let day = |back: i64| crate::sanity::local_day_add(today, -back);
        push_event(&conn, "t1", "complete", day(0) + 9 * 3600, Some(r#"{"minutes":20}"#));
        push_event(&conn, "t2", "complete", day(0) + 10 * 3600, Some(r#"{"minutes":20}"#));
        push_event(&conn, "t3", "complete", day(1) + 9 * 3600, Some(r#"{"minutes":20}"#));
        push_event(&conn, "t4", "complete", day(5) + 9 * 3600, Some(r#"{"minutes":20}"#));
        push_event(&conn, "t5", "complete", day(20) + 9 * 3600, Some(r#"{"minutes":20}"#));
        push_event(&conn, "t6", "skip", day(0) + 11 * 3600, None);
        let s = sum(&conn);
        assert_eq!(s.trend.len(), 14, "14 天窗口（含今天）");
        assert_eq!(s.trend[13].day, today, "新在最后");
        assert_eq!(s.trend[0].day, day(13), "旧在最前");
        assert_eq!(s.trend[13].done, 2, "今天两条（skip 不算）");
        assert_eq!(s.trend[12].done, 1);
        assert_eq!(s.trend[8].done, 1, "5 天前那条");
        assert_eq!(s.trend.iter().map(|d| d.done).sum::<u32>(), 4, "20 天前的不进窗口");
        assert_eq!(s.complete, 5, "总数仍算全史");
    }

    #[test]
    fn test_on_time_rate_uses_15_minute_grace() {
        let conn = test_conn();
        let d = ts(2031, 1, 14, 9);
        // 分钟 30：延迟 45 = 边界内 → 按时；延迟 46 = 超时；提前完成（0）→ 按时
        push_event(&conn, "a", "complete", d, Some(r#"{"minutes":30,"delay_minutes":45}"#));
        push_event(&conn, "b", "complete", d + 60, Some(r#"{"minutes":30,"delay_minutes":46}"#));
        push_event(&conn, "c", "complete", d + 120, Some(r#"{"minutes":30,"delay_minutes":0}"#));
        // 缺 delay（老账）/ 坏 payload → 不进分母
        push_event(&conn, "e", "complete", d + 180, Some(r#"{"minutes":30}"#));
        push_event(&conn, "f", "complete", d + 240, Some("{不是JSON"));
        let s = sum(&conn);
        assert_eq!(s.complete, 5);
        assert_eq!(s.rated, 3, "只有同时有 minutes + delay 的进分母");
        assert_eq!(s.on_time, 2, "边界 45 算按时、46 不算；提前完成算按时");
        assert_eq!(s.on_time_pct, Some(67), "2/3 → 四舍五入 67%");
        // 只有一条也照算；一条都没记录 → None（界面「—」，不编 0%）
        let conn2 = test_conn();
        push_event(&conn2, "x", "complete", d, Some(r#"{"minutes":10,"delay_minutes":10}"#));
        let s2 = sum(&conn2);
        assert_eq!((s2.on_time, s2.rated, s2.on_time_pct), (1, 1, Some(100)));
        let s3 = sum(&test_conn());
        assert_eq!((s3.on_time, s3.rated, s3.on_time_pct), (0, 0, None));
    }

    #[test]
    fn test_avg_minutes_rounds_and_counts_only_timed() {
        let conn = test_conn();
        let d = ts(2031, 1, 14, 9);
        push_event(&conn, "a", "complete", d, Some(r#"{"minutes":30}"#));
        push_event(&conn, "b", "complete", d + 60, Some(r#"{"minutes":45}"#));
        push_event(&conn, "c", "complete", d + 120, None); // 无时长 → 不进分母
        let s = sum(&conn);
        assert_eq!(s.avg_minutes, Some(38), "75/2 = 37.5 → 四舍五入 38");
        assert_eq!(sum(&test_conn()).avg_minutes, None, "一条记录都没有 → None（界面「—」）");
    }

    #[test]
    fn test_streak_current_and_best() {
        let conn = test_conn();
        let today = local_day_start(fixed_now());
        let day = |back: i64| crate::sanity::local_day_add(today, -back);
        // 今天没完成：昨天 / 前天 / 大前天 三天连续 → 当前连续不因「今天还没干」归零
        push_event(&conn, "a", "complete", day(1) + 3600, None);
        push_event(&conn, "b", "complete", day(2) + 3600, None);
        push_event(&conn, "c", "complete", day(3) + 3600, None);
        // 再往前断一天，然后 5 天连续（历史最长）
        for (i, back) in [5i64, 6, 7, 8, 9].into_iter().enumerate() {
            push_event(&conn, &format!("old{i}"), "complete", day(back) + 3600, None);
        }
        let s = sum(&conn);
        assert_eq!(s.streak_now, 3, "今天还没完成不打断昨天为止的连续");
        assert_eq!(s.streak_best, 5, "历史最长 = 那 5 天");
        // 今天补一条 → 当前连续 4（历史最长不变）
        push_event(&conn, "now", "complete", today + 3600, None);
        let s2 = sum(&conn);
        assert_eq!((s2.streak_now, s2.streak_best), (4, 5));
        // 今天与昨天都空 → 0（今天之前断了两天）
        let conn2 = test_conn();
        push_event(&conn2, "x", "complete", day(3) + 3600, None);
        let s3 = sum(&conn2);
        assert_eq!((s3.streak_now, s3.streak_best), (0, 1));
        // 一条都没有 → 双 0
        let s4 = sum(&test_conn());
        assert_eq!((s4.streak_now, s4.streak_best), (0, 0));
    }

    #[test]
    fn test_categories_group_untagged_last() {
        let conn = test_conn();
        let d = ts(2031, 1, 14, 9);
        push_event(&conn, "a", "complete", d, Some(r#"{"minutes":20,"category":"工作"}"#));
        push_event(&conn, "b", "complete", d + 60, Some(r#"{"minutes":45,"category":"工作"}"#));
        push_event(&conn, "c", "complete", d + 120, Some(r#"{"minutes":30,"category":"学习"}"#));
        push_event(&conn, "d", "complete", d + 180, Some(r#"{"minutes":60}"#)); // 老账 / 无分类
        push_event(&conn, "e", "complete", d + 240, None); // 无 payload
        push_event(&conn, "f", "complete", d + 300, Some(r#"{"category":"  工作  "}"#)); // 空白 trim
        let s = sum(&conn);
        assert_eq!(s.categories.len(), 3, "工作 / 学习 / 早期数据（无分类）");
        assert_eq!(s.categories[0].category, "工作");
        assert_eq!((s.categories[0].done, s.categories[0].minutes), (3, 65), "两条带时长 + 一条只有分类");
        assert_eq!(s.categories[1].category, "学习");
        assert_eq!((s.categories[1].done, s.categories[1].minutes), (1, 30));
        assert_eq!(s.categories[2].category, "", "无分类永远排最后");
        assert_eq!((s.categories[2].done, s.categories[2].minutes), (2, 60));
        assert_eq!(
            s.categories.iter().map(|c| c.done).sum::<u32>(),
            s.complete,
            "分类栏总和 = 全部完成"
        );
    }

    #[test]
    fn test_category_respects_stats_reset_line() {
        let conn = test_conn();
        // 线之前：带分类的完成 → 重置统计后连分类栏一起被切掉
        push_event(&conn, "old", "complete", ts(2031, 1, 8, 9), Some(r#"{"minutes":20,"category":"工作"}"#));
        let line = ts(2031, 1, 15, 0);
        // 线之后：一条带分类 + 一条无分类
        push_event(&conn, "new1", "complete", ts(2031, 1, 15, 9), Some(r#"{"minutes":30,"category":"学习"}"#));
        push_event(&conn, "new2", "complete", ts(2031, 1, 15, 10), Some(r#"{"minutes":10}"#));
        let after = sum_since(&conn, line);
        assert_eq!(after.complete, 2);
        assert_eq!(after.categories.len(), 2, "线后的学习 + 无分类；线前的「工作」不出现");
        assert_eq!(after.categories[0].category, "学习");
        assert_eq!(after.categories[1].category, "");
        assert!(after.categories.iter().all(|c| c.category != "工作"));
        assert_eq!(after.trend.iter().map(|d| d.done).sum::<u32>(), 2, "趋势也只看线后");
        assert_eq!((after.streak_now, after.streak_best), (1, 1));
    }

    /// round82（统-08 · 用户问的兼容性）：重置**成就**不碰统计一个数字（两个时间界互相独立）
    #[test]
    fn test_achievements_reset_does_not_touch_stats() {
        let conn = test_conn();
        push_event(
            &conn,
            "a",
            "complete",
            ts(2031, 1, 14, 9),
            Some(r#"{"minutes":20,"delay_minutes":5,"category":"工作"}"#),
        );
        push_event(&conn, "b", "skip", ts(2031, 1, 14, 10), None);
        let before = sum(&conn);
        crate::achievements::reset(&conn).expect("重置成就失败");
        let after = sum(&conn);
        assert_eq!(after, before, "成就的时间界与统计完全无关");
    }

    /// round82（统-11）：十年量级（10 万条）聚合时延 —— **`#[ignore]`**（不占日常闸门时间）。
    /// 手动跑：`cargo test --release stats::tests::perf_100k_events -- --ignored --nocapture`
    #[test]
    #[ignore = "性能取证：手动跑（见注释）"]
    fn perf_100k_events() {
        let conn = test_conn();
        let base = fixed_now() - 100_000 * 60;
        conn.execute_batch("BEGIN").expect("开事务");
        for i in 0..100_000i64 {
            let (ty, payload) = match i % 10 {
                0 => ("complete", Some(format!(r#"{{"minutes":30,"delay_minutes":{},"category":"工作"}}"#, i % 60))),
                1 => ("skip", None),
                2 => ("create", None),
                3 => ("merge", None),
                4 => ("move", Some(r#"{"from":1,"to":2}"#.to_string())),
                5 => ("postpone", Some(r#"{"from":1,"to":2}"#.to_string())),
                6 => ("delete", Some(r#"{"count":1}"#.to_string())),
                7 => ("link", None),
                8 => ("unlink", None),
                _ => ("move", Some(r#"{"from":1,"to":2}"#.to_string())),
            };
            push_event(&conn, &format!("b{i}"), ty, base + i * 60, payload.as_deref());
        }
        conn.execute_batch("COMMIT").expect("提交事务");
        let t0 = std::time::Instant::now();
        let s = summary(&conn, fixed_now(), RECENT_WEEKS, 0).expect("统计失败");
        let ms = t0.elapsed().as_millis();
        println!(
            "10 万条 events 聚合：{ms} ms（complete={} · trend 合计={} · streak_best={} · 分类栏={}）",
            s.complete,
            s.trend.iter().map(|d| d.done).sum::<u32>(),
            s.streak_best,
            s.categories.len()
        );
    }
}
