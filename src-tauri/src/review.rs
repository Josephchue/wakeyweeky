//! C7 复盘（round52 / 0.12.0）：把一周的块翻成「结局」马赛克（R38），并给 R46 明细面板供数。
//!
//! ## 口径（设计说明与边界表见 `docs/plans/round52-c7-review-mosaic.md`）
//!
//! ```text
//! 每块一个方块，结局只有六种（前端 Mosaic.svelte 按它画；颜色 + 纹理双通道）：
//!   done           按时完成       （status=done，final_status 空）
//!   done_overtime  完成但超时     （final_status=done_overtime）
//!   done_short     完成但提前结束 （final_status=done_short）
//!   missed         未完成 / 残影  （status=missed）
//!   unused         没发生         （planned 且 end_at <= now；必填=空心虚线、弹性=极淡）
//!   planned        还没到         （planned 且 end_at > now）
//! ```
//!
//! 本文件是**唯一实现**：`mosaic_state` 只在这里定义，前端只负责画（不重算规则）。
//! 「不计入理智值」的判定**不在这里** —— 它归 `sanity.rs`（曲线与明细共用那一份）。
//!
//! 两个终态（`done_overtime` / `done_short`）的**写入方在 `db::mark_block_done_at`**（round57 / 0.13.0 定口径）：
//! 标 ✓ 的时刻早于计划开始 = 提前；时段内或结束后 15 分钟宽限内 = 按时；再晚 = 超时。本模块只负责**读**。

use std::collections::HashMap;

use chrono::{Datelike, Local, TimeZone};
use rusqlite::Connection;
use serde::Serialize;

use crate::db;
use crate::sanity::{self, local_day_add, local_day_start, week_start_of};

/// 六种结局（前端按字符串分支；写错字在 Rust 单测里就能看见）
pub const STATE_DONE: &str = "done";
pub const STATE_DONE_OVERTIME: &str = "done_overtime";
pub const STATE_DONE_SHORT: &str = "done_short";
pub const STATE_MISSED: &str = "missed";
pub const STATE_UNUSED: &str = "unused";
pub const STATE_PLANNED: &str = "planned";

/// 这一块的结局。
///
/// **「时间已过」的判据 = `end_at <= now`**（跨天/跨周块按结束时刻算）——
/// 已过且仍是 `planned`，就是「没发生」（愿景稿的「空白：弹性块未使用」；
/// 必填块同样口径，只是前端换一种画法）。`now` 传进来（好测）。
pub fn mosaic_state(block: &db::Block, now: i64) -> &'static str {
    match block.status.as_str() {
        "done" => match block.final_status.as_deref() {
            Some(s) if s == STATE_DONE_OVERTIME => STATE_DONE_OVERTIME,
            Some(s) if s == STATE_DONE_SHORT => STATE_DONE_SHORT,
            _ => STATE_DONE,
        },
        "missed" => STATE_MISSED,
        _ => {
            if block.end_at <= now {
                STATE_UNUSED
            } else {
                STATE_PLANNED
            }
        }
    }
}

/// 马赛克里的一个方块 —— 同时也是 R46 明细面板的一行（同一份数据、两处 UI）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MosaicBlock {
    pub id: String,
    pub task_id: String,
    /// 任务名（临时块是隐藏任务的名字「临时安排」）
    pub title: String,
    /// 临时块自己的名字（普通块为 None）→ 显示名 = `label ?? title`
    pub label: Option<String>,
    pub category: Option<String>,
    pub is_temp: bool,
    pub start_at: i64,
    pub end_at: i64,
    pub layer: String,
    pub mosaic_state: String,
    /// 画在**哪一天**（本地零点）：跨周块伸进来的第一段所在那天
    pub day_start: i64,
    /// 计入理智值吗（任务级 / 临时块自己的；curve 用同一套判定）
    pub exempt: bool,
    /// 挪过几次（**事实**，不进算术；>=2 才是曲线上那条「挪过」）
    pub rearranged: u32,
    /// 标过没做完（**事实**）
    pub skipped: bool,
}

/// 算某一周的方块（按天、按开始时间排 —— `list_blocks` 已经是这个序，跨周块归到周一）。
pub fn week_mosaic(
    conn: &Connection,
    week_start: i64,
    now: i64,
) -> Result<Vec<MosaicBlock>, String> {
    let from = sanity::local_day_start(week_start);
    let to = sanity::local_day_add(from, 7);

    // 区间相交语义（与时间轴、曲线一致）：上周伸进来的块也算这一周
    let blocks = db::list_blocks(conn, from, to)?;
    let tasks = db::list_tasks(conn)?;
    let exempt_tasks = sanity::exempt_task_ids(&tasks);
    let facts = sanity::block_facts(conn, from, to)?;

    let info_of: HashMap<&str, (&str, Option<&str>)> = tasks
        .iter()
        .map(|t| (t.id.as_str(), (t.title.as_str(), t.category.as_deref())))
        .collect();

    let mut out = Vec::with_capacity(blocks.len());
    for block in &blocks {
        let (title, category) = match info_of.get(block.task_id.as_str()) {
            Some((title, category)) => (*title, category.map(str::to_string)),
            // 理论上到不了（外键 CASCADE 会连块一起删）：真到不了就给个可见的占位，别 panic
            None => ("?", None),
        };
        let (rearranged, skipped) = facts.get(block.id.as_str()).copied().unwrap_or((0, false));
        out.push(MosaicBlock {
            id: block.id.clone(),
            task_id: block.task_id.clone(),
            title: title.to_string(),
            label: block.label.clone(),
            category,
            is_temp: block.is_temp,
            start_at: block.start_at,
            end_at: block.end_at,
            layer: block.layer.clone(),
            mosaic_state: mosaic_state(block, now).to_string(),
            // 跨周块（上周伸进来）：画在**本周第一段**所在那天，周内其他天不重复画
            day_start: sanity::local_day_start(block.start_at.max(from)),
            exempt: sanity::is_block_exempt(block, &exempt_tasks),
            rearranged,
            skipped,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------- 周复盘提醒（C7 · 评审反馈 #1）
//
// 口径（用户 2026-10-02 评审：「周日晚上或者周一早上是不是应该提醒一下？…是不是可以被用户开关和调时间的？」）：
// - 默认 **周日 20:00**，可改成周日 / 周一的任意时刻（
// - 提醒对象 = 提醒时刻**所在的那一周**，但**周一**设的时刻指上一周（刚过完的那一周）：
//   周日 20:00 → 本周（周日是它最后一天）；周一 09:00 → 上周；
// - 有效窗口 = 提醒时刻起 **24 小时**（周日 20:00 → 周一 20:00 前都有效：周日晚上没看到、周一早上开应用照样补上）；
// - **一周只提一次**：水位线 `review_nudged_week`（后端自管、不进设置白名单 —— 与 C13 的 `missed_summary_at` 同一套）。

/// 设置键：到点时怎么办（`open` = 直接打开总览 / `hint` = 只提醒 / `off` = 什么都不做）
/// —— round57（0.13.0）把旧的「提醒开关」收成一个三选一（两个开关会打架，你 2026-10-04 指出过）。
pub const KEY_ACTION: &str = "review_action";
/// 默认动作：**什么都不做**（round69.1 你拍板：旧默认「只提醒」每周来一次骚扰；
/// 旧键盘显式开着 `review_remind=1` 的照旧算 `hint`，不静默翻面）
pub const DEFAULT_ACTION: &str = "off";
/// 已退役的旧键（round52 的提醒开关）：**只为兼容读旧库**保留 —— 不再进设置白名单。
/// 旧库里是 `0` 且没有 `review_action` → 当作 `off`（不能升级后突然又开始弹）。
pub const KEY_REMIND: &str = "review_remind";
/// 设置键：提醒时刻（`"sun 20:00"` / `"mon 09:00"`）
pub const KEY_REMIND_AT: &str = "review_remind_at";
/// 水位线：最近一次「提过 / 看过复盘」的那一周（后端自管，**不进白名单**）
pub const KEY_NUDGED_WEEK: &str = "review_nudged_week";
/// 默认时刻（周日 20:00）—— 字面量只此一处（解析它得到 `RemindAt`）
pub const DEFAULT_REMIND_AT: &str = "sun 20:00";

/// 默认时刻的结构体形式（解析失败时也用那个字面量的兑底值，不 panic）
fn default_remind() -> RemindAt {
    parse_remind_at(DEFAULT_REMIND_AT).unwrap_or(RemindAt { weekday: 6, hour: 20, minute: 0 })
}
/// 提醒时刻起 24 小时内有效（覆盖「周日晚上没看到、周一早上开应用」）
pub const NUDGE_WINDOW_SECONDS: i64 = 24 * 3600;

/// 提醒时刻（星期 + 时 + 分）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemindAt {
    /// 0 = 周一 … 6 = 周日
    pub weekday: i64,
    pub hour: u32,
    pub minute: u32,
}

impl RemindAt {
    /// 存库/显示用的规范写法（`"sun 20:00"`）
    pub fn text(&self) -> String {
        format!(
            "{} {:02}:{:02}",
            if self.weekday == 6 { "sun" } else { "mon" },
            self.hour,
            self.minute
        )
    }
}

/// 解析 `"sun 20:00"` / `"mon 9:00"`（大小写不敏感，中问一个空格）；非法 → None。
/// 只认周日 / 周一 —— 用户原话就是这两个（别的日子会让「提醒对象是哪一周」变得说不清）。
pub fn parse_remind_at(value: &str) -> Option<RemindAt> {
    let v = value.trim().to_lowercase();
    let (day, time) = v.split_once(' ')?;
    let weekday = match day {
        "mon" => 0,
        "sun" => 6,
        _ => return None,
    };
    let (h, m) = time.split_once(':')?;
    let hour: u32 = h.trim().parse().ok()?;
    let minute: u32 = m.trim().parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some(RemindAt { weekday, hour, minute })
}

/// 生效的「到点时」（`open` / `hint` / `off`）。
/// 新键在 → 用它（非法值当没存）；不在 → 看退役的旧开关；再没有 → 新默认 `off`。
/// round69.1（#12 / 你拍板）：新装/没设过 → **什么都不做**（旧默认 `hint` 每周一次性骚扰你）。
/// 旧键盘显式开着（`review_remind = 1`）的照旧算 `hint` —— 那是用户的显式选择，不静默翻面。
pub fn action_setting(conn: &Connection) -> &'static str {
    let stored = db::get_setting(conn, KEY_ACTION).ok().flatten();
    if let Some(v) = stored.as_deref().map(str::trim) {
        if matches!(v, "open" | "hint" | "off") {
            return match v {
                "open" => "open",
                "off" => "off",
                _ => "hint",
            };
        }
    }
    match db::get_setting(conn, KEY_REMIND).ok().flatten() {
        Some(v) if v.trim() == "0" => "off",
        Some(v) if v.trim() == "1" => "hint",
        _ => DEFAULT_ACTION,
    }
}

/// 生效的提醒时刻；非法回退 `"sun 20:00"`
pub fn remind_setting(conn: &Connection) -> RemindAt {
    db::get_setting(conn, KEY_REMIND_AT)
        .ok()
        .flatten()
        .and_then(|v| parse_remind_at(&v))
        .unwrap_or_else(default_remind)
}

/// 某一周星期几（0 = 周一 … 6 = 周日）
fn weekday_index(day_start: i64) -> i64 {
    Local
        .timestamp_opt(day_start, 0)
        .single()
        .map(|d| d.weekday().num_days_from_monday() as i64)
        .unwrap_or(0)
}

/// 某一天的本地 `hh:mm`（夏令时不存在 / 歧义时取最早一次；整段都取不到 → None）
fn moment_on(day_start: i64, hour: u32, minute: u32) -> Option<i64> {
    let dt = Local.timestamp_opt(day_start, 0).single()?;
    let naive = dt.date_naive().and_hms_opt(hour, minute, 0)?;
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|d| d.timestamp())
}

/// 该不该提醒：是 → 返回要复盘的那一周（本地周一零点）；不在窗口 / `action = "off"` / 已提过 → None。
/// `now` 传进来（好测）；`nudged_week` = 水位线（最近提过 / 看过的那一周）。
pub fn nudge_week(now: i64, action: &str, at: RemindAt, nudged_week: Option<i64>) -> Option<i64> {
    if action == "off" {
        return None;
    }
    let today = local_day_start(now);
    // 往回找最近的「提醒时刻」（设定的星期一周只出现一次，最多找 7 天）
    let mut hit = None;
    for back in 0..=7 {
        let day = local_day_add(today, -back);
        if weekday_index(day) != at.weekday {
            continue;
        }
        let Some(moment) = moment_on(day, at.hour, at.minute) else {
            continue;
        };
        if moment <= now {
            hit = Some((day, moment));
            break;
        }
    }
    let (day, moment) = hit?;
    if now - moment >= NUDGE_WINDOW_SECONDS {
        return None; // 出窗口作废（周二才开就不追旧账）
    }
    // 提醒对象：周日设的时刻 → **本周**（周日是它最后一天）；周一 → **上一周**（刚过完的那一周）
    let target = if at.weekday == 6 {
        week_start_of(day)
    } else {
        local_day_add(week_start_of(day), -7)
    };
    if nudged_week == Some(target) {
        return None; // 一周只提一次
    }
    Some(target)
}

/// 提醒的返回（`take_review_nudge`）
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Nudge {
    /// 要复盘的那一周（本地周一零点）
    pub week_start: i64,
    /// 生效的提醒时刻（规范写法，给界面显示）
    pub at: String,
}

/// 到点了吗：是 → **把水位线推过去**并返回它（与 C13 的启动汇总同一套：给出即推进，一周一次）。
pub fn take_nudge(conn: &Connection, now: i64) -> Result<Option<Nudge>, String> {
    // round63（C18 / R41）：免打扰期间不弹复盘提醒 —— **也不推进水位线**（解静音后仍在 24 小时窗口里
    // 就还会提：「静音 = 不打扰」不是「当作没发生」）。
    if crate::notify::is_quiet(conn, now) {
        return Ok(None);
    }
    let action = action_setting(conn);
    let at = remind_setting(conn);
    let nudged = db::get_setting(conn, KEY_NUDGED_WEEK)?
        .and_then(|v| v.trim().parse::<i64>().ok());
    let Some(week_start) = nudge_week(now, action, at, nudged) else {
        return Ok(None);
    };
    // round78（3.1b₂ · 教-11）：目标周**一块都没有** → 不发，**也不推水位线** ——
    // 与免打扰同一口径（没东西可复盘就不打扰；真排了块而那周又到了提醒点，那时才算「有内容」）。
    // 用 `list_blocks` 而不是自己写 SQL：漂流子块「不在场」那条规则只有一份（`drift_filter`）。
    if db::list_blocks(conn, week_start, local_day_add(week_start, 7))?.is_empty() {
        return Ok(None);
    }
    db::set_setting(conn, KEY_NUDGED_WEEK, &week_start.to_string())?;
    Ok(Some(Nudge { week_start, at: at.text() }))
}

/// 「这一周我看过了」——把水位线推过去（盖住「提前看过了、到点又提一次」）
pub fn mark_seen(conn: &Connection, week_start: i64) -> Result<(), String> {
    db::set_setting(conn, KEY_NUDGED_WEEK, &local_day_start(week_start).to_string())
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{
        create_block, create_task, create_temp_block, mark_block_done_at, mark_block_missed,
        set_block_exempt, set_task_exempt, test_conn, update_block_layer, Block, TEMP_TASK_ID,
    };

    fn ts(y: i32, m: u32, d: u32, h: u32) -> i64 {
        use chrono::{Local, TimeZone};
        let naive = chrono::NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, 0, 0)
            .unwrap();
        Local.from_local_datetime(&naive).earliest().unwrap().timestamp()
    }

    /// 测试用的固定「现在」：2031-01-15 12:00（周三正午）；这一周从 2031-01-13（周一）起
    fn fixed_now() -> i64 {
        ts(2031, 1, 15, 12)
    }
    fn week_from() -> i64 {
        ts(2031, 1, 13, 0)
    }

    /// 造一个**不入库**的块（只测结局规则本身）
    fn fake_block(
        status: &str,
        final_status: Option<&str>,
        layer: &str,
        start: i64,
        end: i64,
    ) -> Block {
        Block {
            id: "b".to_string(),
            task_id: "t".to_string(),
            start_at: start,
            end_at: end,
            status: status.to_string(),
            last_notified_at: None,
            created_at: 0,
            layer: layer.to_string(),
            external_source: None,
            final_status: final_status.map(str::to_string),
            postponed_from: None,
            label: None,
            sanity_exempt: false,
            is_temp: false,
            priority: "low".to_string(),
            repeat_note: None,
        }
    }

    /// 直接往 events 表塞一行（与 `sanity.rs` 的测试同一手法）
    fn push_event(conn: &Connection, block_id: &str, ty: &str, at: i64, payload: Option<&str>) {
        conn.execute(
            "INSERT INTO events (id, block_id, event_type, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![uuid::Uuid::new_v4().to_string(), block_id, ty, payload, at],
        )
        .expect("塞事件失败");
    }

    /// 结局矩阵：status(3) × final_status(3) × 时间(两侧) × layer(2) —— 逐格断言。
    #[test]
    fn test_mosaic_state_matrix() {
        let now = fixed_now();
        let cases_done: [(Option<&str>, &str); 3] = [
            (None, STATE_DONE),
            (Some("done_overtime"), STATE_DONE_OVERTIME),
            (Some("done_short"), STATE_DONE_SHORT),
        ];
        for (final_status, expect) in cases_done {
            for end in [now - 60, now + 60] {
                for layer in ["required", "elastic"] {
                    let b = fake_block("done", final_status, layer, now - 3600, end);
                    assert_eq!(
                        mosaic_state(&b, now),
                        expect,
                        "done/{final_status:?}/end={end}/layer={layer}"
                    );
                }
            }
        }

        // missed 与时间无关
        for end in [now - 60, now + 60] {
            for layer in ["required", "elastic"] {
                let b = fake_block("missed", None, layer, now - 3600, end);
                assert_eq!(mosaic_state(&b, now), STATE_MISSED);
            }
        }

        // planned：只看 end_at（<= now = 没发生；> now = 还没到）—— 层与时长都不影响
        for (end, expect) in [
            (now - 86_400, STATE_UNUSED),
            (now - 1, STATE_UNUSED),
            (now, STATE_UNUSED), // 边界：正好结束在这一刻 = 已过
            (now + 1, STATE_PLANNED),
            (now + 86_400, STATE_PLANNED),
        ] {
            for layer in ["required", "elastic"] {
                let b = fake_block("planned", None, layer, now - 3600, end);
                assert_eq!(mosaic_state(&b, now), expect, "planned/end={end}");
            }
        }
    }

    /// 一整周的库：六种结局都出现，字段（名字 / 分类 / 层 / 临时块）一起核对。
    #[test]
    fn test_week_mosaic_states_and_fields() {
        let conn = test_conn();
        let t = create_task(&conn, "写周报", Some("工作")).unwrap();
        let plain = create_task(&conn, "没分类的事", None).unwrap();

        // done（按时）：时段内标 ✓
        let b1 = create_block(&conn, &t.id, ts(2031, 1, 13, 9), ts(2031, 1, 13, 10)).unwrap();
        mark_block_done_at(&conn, &b1.id, ts(2031, 1, 13, 9) + 30 * 60).unwrap();
        // done_overtime：结束 + 宽限之后才标（round57 起由写入方自己算 —— 不再手工改库）
        let b2 = create_block(&conn, &t.id, ts(2031, 1, 14, 9), ts(2031, 1, 14, 10)).unwrap();
        mark_block_done_at(
            &conn,
            &b2.id,
            ts(2031, 1, 14, 10) + crate::db::OVERTIME_GRACE_SECONDS + 1,
        )
        .unwrap();
        // done_short：开始之前就标
        let b3 = create_block(&conn, &plain.id, ts(2031, 1, 14, 11), ts(2031, 1, 14, 12)).unwrap();
        mark_block_done_at(&conn, &b3.id, ts(2031, 1, 14, 11) - 1).unwrap();
        // missed
        let b4 = create_block(&conn, &plain.id, ts(2031, 1, 15, 9), ts(2031, 1, 15, 10)).unwrap();
        mark_block_missed(&conn, &b4.id).unwrap();
        // unused（已过还是 planned）+ required（前端画法不同，但结局同一个）
        let b5 = create_block(&conn, &plain.id, ts(2031, 1, 15, 8), ts(2031, 1, 15, 9)).unwrap();
        update_block_layer(&conn, &b5.id, "required").unwrap();
        // planned（还没到）
        let b6 = create_block(&conn, &t.id, ts(2031, 1, 16, 9), ts(2031, 1, 16, 10)).unwrap();

        let rows = week_mosaic(&conn, week_from(), fixed_now()).unwrap();
        let states: Vec<&str> = rows.iter().map(|r| r.mosaic_state.as_str()).collect();
        assert_eq!(
            states,
            vec![
                STATE_DONE,
                STATE_DONE_OVERTIME,
                STATE_DONE_SHORT,
                STATE_UNUSED, // 周三 08:00–09:00（已过还是 planned）
                STATE_MISSED, // 周三 09:00–10:00
                STATE_PLANNED,
            ],
            "按时间序的六种结局（造块顺序就是时间序）"
        );

        let by_id = |id: &str| rows.iter().find(|r| r.id == id).unwrap();
        assert_eq!(by_id(&b1.id).title, "写周报");
        assert_eq!(by_id(&b1.id).category.as_deref(), Some("工作"));
        assert_eq!(by_id(&b1.id).layer, "elastic", "create_block 默认弹性");
        assert_eq!(by_id(&b5.id).layer, "required");
        assert_eq!(by_id(&b3.id).category, None);
        assert!(!by_id(&b1.id).is_temp);
        assert_eq!(by_id(&b6.id).mosaic_state, STATE_PLANNED);
    }

    /// 跨天块只画一天；跨周块归到本周第一天，**只出现一次**。
    #[test]
    fn test_week_mosaic_cross_day_and_cross_week_day_start() {
        let conn = test_conn();
        let t = create_task(&conn, "跨天", None).unwrap();
        // 周一 23:00 → 周二 01:00（跨天，但都在这周）
        let in_week = create_block(&conn, &t.id, ts(2031, 1, 13, 23), ts(2031, 1, 14, 1)).unwrap();
        // 上周日 22:00 → 周一 01:00（跨周伸进来）
        let cross = create_block(&conn, &t.id, ts(2031, 1, 12, 22), ts(2031, 1, 13, 1)).unwrap();

        let rows = week_mosaic(&conn, week_from(), fixed_now()).unwrap();
        assert_eq!(rows.len(), 2, "每块只出现一次（不按天重复画）");
        let by_id = |id: &str| rows.iter().find(|r| r.id == id).unwrap();
        assert_eq!(by_id(&in_week.id).day_start, week_from(), "跨天块画在它开始那天");
        assert_eq!(by_id(&cross.id).day_start, week_from(), "跨周块归到周一");
    }

    /// 「没发生」的边界：`end_at == now` 算已过；`end_at == now + 1` 算还没到。
    #[test]
    fn test_week_mosaic_unused_boundary() {
        let conn = test_conn();
        let t = create_task(&conn, "边界", None).unwrap();
        let now = fixed_now();
        // 现在（周三 12:00）之前结束的 → unused；12:00 之后结束的 → planned
        let past = create_block(&conn, &t.id, ts(2031, 1, 15, 10), ts(2031, 1, 15, 11)).unwrap();
        let future = create_block(&conn, &t.id, ts(2031, 1, 15, 13), ts(2031, 1, 15, 14)).unwrap();

        let rows = week_mosaic(&conn, week_from(), now).unwrap();
        let state = |id: &str| {
            rows.iter().find(|r| r.id == id).unwrap().mosaic_state.clone()
        };
        assert_eq!(state(&past.id), STATE_UNUSED);
        assert_eq!(state(&future.id), STATE_PLANNED);

        // 用「正好结束在这一刻」的块直接验边界（不用库里造 15 分钟以外的块）
        let exact = fake_block("planned", None, "elastic", now - 60, now);
        assert_eq!(mosaic_state(&exact, now), STATE_UNUSED);
        let one_second_later = fake_block("planned", None, "elastic", now - 60, now + 1);
        assert_eq!(mosaic_state(&one_second_later, now), STATE_PLANNED);
    }

    /// 每块的事实（挪过几次 / 没做完）—— 两个块互相不串。
    #[test]
    fn test_week_mosaic_block_facts() {
        let conn = test_conn();
        let t = create_task(&conn, "事实", None).unwrap();
        let a = create_block(&conn, &t.id, ts(2031, 1, 13, 9), ts(2031, 1, 13, 10)).unwrap();
        let b = create_block(&conn, &t.id, ts(2031, 1, 13, 11), ts(2031, 1, 13, 12)).unwrap();

        // a：两次漂流（postpone）+ 一次跳过（skip）+ 一条不算的 merge 事件
        push_event(&conn, &a.id, "postpone", ts(2031, 1, 13, 8), None);
        push_event(&conn, &a.id, "postpone", ts(2031, 1, 13, 8), None);
        push_event(&conn, &a.id, "merge", ts(2031, 1, 13, 8), None);
        push_event(&conn, &a.id, "skip", ts(2031, 1, 13, 12), None);
        // b：一条 move 事件（原定起点还没到 → 不算「挪过」）
        push_event(
            &conn,
            &b.id,
            "move",
            ts(2031, 1, 13, 8),
            Some(r#"{"from":1735689600,"to":1735693200}"#),
        );

        let rows = week_mosaic(&conn, week_from(), fixed_now()).unwrap();
        let by_id = |id: &str| rows.iter().find(|r| r.id == id).unwrap();
        assert_eq!(by_id(&a.id).rearranged, 2);
        assert!(by_id(&a.id).skipped);
        assert_eq!(
            by_id(&b.id).rearranged,
            1,
            "原定起点（0 = 1970 年）早就过了 → 这条 move 算「挪过」"
        );
        assert!(!by_id(&b.id).skipped);
    }

    /// 「不计入理智值」：任务级豁免 / 临时块自己的标记 / 隐藏任务上的标记**不得**豁免全部临时块。
    #[test]
    fn test_week_mosaic_exempt_rules() {
        let conn = test_conn();
        let t = create_task(&conn, "豁免", None).unwrap();
        let normal = create_block(&conn, &t.id, ts(2031, 1, 13, 9), ts(2031, 1, 13, 10)).unwrap();
        let temp = create_temp_block(&conn, ts(2031, 1, 14, 9), ts(2031, 1, 14, 10)).unwrap();
        let temp2 = create_temp_block(&conn, ts(2031, 1, 14, 11), ts(2031, 1, 14, 12)).unwrap();

        // 一开始都不豁免
        let rows = week_mosaic(&conn, week_from(), fixed_now()).unwrap();
        let exempt_of = |id: &str| rows.iter().find(|r| r.id == id).unwrap().exempt;
        assert!(!exempt_of(&normal.id));
        assert!(!exempt_of(&temp.id));

        // ① 任务级豁免 → 它的块豁免
        set_task_exempt(&conn, &t.id, true).unwrap();
        let rows = week_mosaic(&conn, week_from(), fixed_now()).unwrap();
        let exempt_of = |id: &str| rows.iter().find(|r| r.id == id).unwrap().exempt;
        assert!(exempt_of(&normal.id));

        // ② 临时块自己的块级标记 → 只豁免它自己
        set_block_exempt(&conn, &temp.id, true).unwrap();
        let rows = week_mosaic(&conn, week_from(), fixed_now()).unwrap();
        let exempt_of = |id: &str| rows.iter().find(|r| r.id == id).unwrap().exempt;
        assert!(exempt_of(&temp.id));
        assert!(!exempt_of(&temp2.id), "另一个临时块不受影响");

        // ③ 隐藏任务被标了 → **不得**把全部临时块一起豁免（round49 的坑）
        set_task_exempt(&conn, TEMP_TASK_ID, true).unwrap();
        let rows = week_mosaic(&conn, week_from(), fixed_now()).unwrap();
        let exempt_of = |id: &str| rows.iter().find(|r| r.id == id).unwrap().exempt;
        assert!(!exempt_of(&temp2.id), "隐藏任务的标记不算数");
        assert!(exempt_of(&temp.id), "自己标过的仍算");
    }

    /// 临时块的名字走 `label`；普通块 `label` 为 None（前端取 `label ?? title`）。
    #[test]
    fn test_week_mosaic_temp_label() {
        use crate::db::update_block;
        let conn = test_conn();
        let temp = create_temp_block(&conn, ts(2031, 1, 14, 9), ts(2031, 1, 14, 10)).unwrap();
        update_block(&conn, &temp.id, None, None, None, None).unwrap(); // 触发一次加载（不改）
        let rows = week_mosaic(&conn, week_from(), fixed_now()).unwrap();
        let row = rows.iter().find(|r| r.id == temp.id).unwrap();
        assert!(row.is_temp);
        assert_eq!(row.label, None);
        assert_eq!(row.title, "临时安排", "临时块的任务名 = 隐藏任务的名字");

        // 命名后：label 有值
        let named = update_block(&conn, &temp.id, None, None, None, None);
        assert!(named.is_ok());
        conn.execute("UPDATE blocks SET label = '修水管' WHERE id = ?1", [&temp.id])
            .unwrap();
        let rows = week_mosaic(&conn, week_from(), fixed_now()).unwrap();
        let row = rows.iter().find(|r| r.id == temp.id).unwrap();
        assert_eq!(row.label.as_deref(), Some("修水管"));
    }

    /// 空周 → 空列表（前端画空态）；周外的块不混进来。
    #[test]
    fn test_week_mosaic_empty_and_out_of_week() {
        let conn = test_conn();
        let t = create_task(&conn, "周外", None).unwrap();
        let empty = week_mosaic(&conn, week_from(), fixed_now()).unwrap();
        assert!(empty.is_empty(), "空周是空列表，不是报错");

        // 下一周的块
        create_block(&conn, &t.id, ts(2031, 1, 20, 9), ts(2031, 1, 20, 10)).unwrap();
        // 上一周、且不伸进本周的块
        create_block(&conn, &t.id, ts(2031, 1, 7, 9), ts(2031, 1, 7, 10)).unwrap();
        let rows = week_mosaic(&conn, week_from(), fixed_now()).unwrap();
        assert!(rows.is_empty(), "周外的块不进来");
    }

    // ---- 周复盘提醒（C7 · 评审反馈 #1）----

    #[test]
    fn test_parse_remind_at() {
        let sun = parse_remind_at("sun 20:00").unwrap();
        assert_eq!(sun, RemindAt { weekday: 6, hour: 20, minute: 0 });
        assert_eq!(sun.text(), DEFAULT_REMIND_AT);
        assert_eq!(
            parse_remind_at("MON 9:00").unwrap(),
            RemindAt { weekday: 0, hour: 9, minute: 0 }
        );
        for bad in ["", "sun", "sun 25:00", "sun 20:99", "tue 09:00", "20:00", "sun 2000", "mon 9-00"] {
            assert!(parse_remind_at(bad).is_none(), "非法值该被拒：{bad}");
        }
    }

    /// 默认（周日 20:00）：窗口 = 周日 20:00 → 周一 20:00 之前；对象 = **周日所在的那一周**
    #[test]
    fn test_nudge_window_sunday() {
        let at = parse_remind_at("sun 20:00").unwrap();
        let week = week_from(); // 2031-01-13 周一
        let sunday = ts(2031, 1, 19, 20); // 2031-01-19 是周日：这一周的最后一天
        assert_eq!(week_start_of(sunday), week);

        assert_eq!(nudge_week(ts(2031, 1, 19, 19), "hint", at, None), None, "还没到点");
        for (label, now) in [
            ("周日 20:00 整", sunday),
            ("周日 23:00", ts(2031, 1, 19, 23)),
            ("周一 09:00", ts(2031, 1, 20, 9)),
            ("周一 19:00", ts(2031, 1, 20, 19)),
        ] {
            assert_eq!(nudge_week(now, "hint", at, None), Some(week), "{label} 应在窗口内");
        }
        assert_eq!(nudge_week(ts(2031, 1, 20, 20), "hint", at, None), None, "满 24 小时出窗口");
        assert_eq!(nudge_week(ts(2031, 1, 21, 9), "hint", at, None), None, "周二不再追旧账");
    }

    /// 周一设的时刻：对象是**上一周**（刚过完的那一周）
    #[test]
    fn test_nudge_monday_targets_last_week() {
        let at = parse_remind_at("mon 09:00").unwrap();
        let last_week = week_from(); // 2031-01-13 周一 = 上一个已结束的周
        assert_eq!(week_start_of(ts(2031, 1, 20, 9)), ts(2031, 1, 20, 0), "2031-01-20 是新的一周");
        assert_eq!(nudge_week(ts(2031, 1, 20, 8), "hint", at, None), None, "还没到点");
        assert_eq!(nudge_week(ts(2031, 1, 20, 9), "hint", at, None), Some(last_week));
        assert_eq!(nudge_week(ts(2031, 1, 20, 23), "hint", at, None), Some(last_week));
        assert_eq!(
            nudge_week(ts(2031, 1, 21, 8), "hint", at, None),
            Some(last_week),
            "周二早上仍在 24h 窗口内"
        );
        assert_eq!(nudge_week(ts(2031, 1, 21, 9), "hint", at, None), None, "满 24h 出窗口");
    }

    #[test]
    fn test_nudge_respects_switch_and_watermark() {
        let at = parse_remind_at("sun 20:00").unwrap();
        let week = week_from();
        let now = ts(2031, 1, 19, 21);
        assert_eq!(nudge_week(now, "off", at, None), None, "选「什么都不做」就不提");
        assert_eq!(nudge_week(now, "hint", at, Some(week)), None, "这一周提过就不再提");
        assert_eq!(
            nudge_week(now, "hint", at, Some(week - 7 * 86400)),
            Some(week),
            "水位线是别的周 → 照提"
        );
    }

    /// round57（0.13.0）+ round69.1（#12）：新的三选一设置 —— **新默认 `off`**；旧键只做兼容读
    #[test]
    fn test_action_setting_tristate_and_legacy() {
        let conn = test_conn();
        assert_eq!(action_setting(&conn), "off", "新默认：什么都不做（不再每周骚扰）");

        // 旧库（只有 review_remind）—— 关过的人升级后不该突然被弹
        db::set_setting(&conn, KEY_REMIND, "0").unwrap();
        assert_eq!(action_setting(&conn), "off", "旧的「关掉提醒」= 什么都不做");
        db::set_setting(&conn, KEY_REMIND, "1").unwrap();
        assert_eq!(action_setting(&conn), "hint", "旧的「开着」= 只提醒");

        // 新键优先于旧键（哪怕是旧键关着）
        db::set_setting(&conn, KEY_ACTION, "open").unwrap();
        db::set_setting(&conn, KEY_REMIND, "0").unwrap();
        assert_eq!(action_setting(&conn), "open");

        // 直接被写脏（绕过命令层校验）→ 当没存，回退默认
        db::set_setting(&conn, KEY_ACTION, "乱写的").unwrap();
        db::set_setting(&conn, KEY_REMIND, "1").unwrap();
        assert_eq!(action_setting(&conn), "hint", "非法值当没存，不崩也不静默乱认");
    }

    /// round78（3.1b₂ · 教-11）：**目标周一块都没有 → 不发，也不推水位线**
    /// （不是「当成提过了」—— 与免打扰同一条：没内容就不打扰，下周真排了块再说）
    #[test]
    fn test_nudge_skips_empty_week_without_watermark() {
        let conn = test_conn();
        db::set_setting(&conn, KEY_ACTION, "hint").unwrap();
        let now = ts(2031, 1, 19, 21); // 周日 21:00（窗口内）
        assert!(take_nudge(&conn, now).unwrap().is_none(), "空周不该提");
        assert_eq!(
            db::get_setting(&conn, KEY_NUDGED_WEEK).unwrap(),
            None,
            "空周也不该推水位线（否则下周真排了块就永远不提醒了）"
        );

        // 这一周排一块（周一 10:00）→ 这次该提，而且提完才推水位线
        let t = create_task(&conn, "写周报", None).unwrap();
        create_block(&conn, &t.id, ts(2031, 1, 13, 10), ts(2031, 1, 13, 11)).unwrap();
        let n = take_nudge(&conn, now).unwrap().expect("有块就该提");
        assert_eq!(n.week_start, week_from());
        assert_eq!(
            db::get_setting(&conn, KEY_NUDGED_WEEK).unwrap().as_deref(),
            Some(week_from().to_string().as_str()),
            "提过之后才推水位线"
        );

        // 另一周仍然是空的 → 目标换成它时依旧不提（水位线不动）
        db::set_setting(&conn, KEY_NUDGED_WEEK, "0").unwrap();
        db::set_setting(&conn, KEY_REMIND_AT, "mon 09:00").unwrap();
        assert!(
            take_nudge(&conn, ts(2031, 1, 27, 10)).unwrap().is_none(),
            "下一周也是空的：不提"
        );
        assert_eq!(db::get_setting(&conn, KEY_NUDGED_WEEK).unwrap().as_deref(), Some("0"));
    }

    /// 水位线：`take_nudge` 给出即推进（一周只返回一次）；`mark_seen` 也能推进
    #[test]
    fn test_nudge_watermark_roundtrip() {
        let conn = test_conn();
        // round69.1（#12）：默认已改成「什么都不做」→ 这条用例只为验证链路，先显式打开提醒
        db::set_setting(&conn, KEY_ACTION, "hint").unwrap();
        // round78（3.1b₂ · 教-11）：空周不提 —— 先给目标周种一块（以前这条用例靠"空库也能提"）
        let t = create_task(&conn, "复盘靶子", None).unwrap();
        create_block(&conn, &t.id, ts(2031, 1, 13, 10), ts(2031, 1, 13, 11)).unwrap();
        let now = ts(2031, 1, 19, 21);
        let first = take_nudge(&conn, now).unwrap().expect("第一次该有");
        assert_eq!(first.week_start, week_from());
        assert_eq!(first.at, "sun 20:00");
        assert!(take_nudge(&conn, now).unwrap().is_none(), "同一周不再重复");

        // 改成周一 09:00 → 新的一周目标，能再提一次（注意：得先把水位线拉回旧周）
        db::set_setting(&conn, KEY_REMIND_AT, "mon 09:00").unwrap();
        db::set_setting(&conn, KEY_NUDGED_WEEK, "0").unwrap();
        let again = take_nudge(&conn, ts(2031, 1, 20, 10)).unwrap().expect("该有");
        assert_eq!(again.week_start, week_from(), "周一 10:00 提醒的是刚过完的那一周");
        assert_eq!(again.at, "mon 09:00");

        // mark_seen：提前看过就不再提
        db::set_setting(&conn, KEY_NUDGED_WEEK, "0").unwrap();
        mark_seen(&conn, week_from()).unwrap();
        assert!(take_nudge(&conn, now).unwrap().is_none(), "看过的那一周不再提");
    }

    /// round63（C18 / R41）：免打扰期间 `take_nudge` 返回 `None`，且**不推进水位线** ——
    /// 解静音后只要还在 24 小时窗口里，照提。
    #[test]
    fn test_nudge_is_paused_while_quiet() {
        let conn = test_conn();
        // round69.1（#12）：提醒默认关了 → 这条用例验的是「静音期间不提」，先显式打开
        db::set_setting(&conn, KEY_ACTION, "hint").unwrap();
        // round78（3.1b₂ · 教-11）：空周不提 —— 先给目标周种一块（不然后半段验的是「空周」而非「解静音」）
        let t = create_task(&conn, "静音靶子", None).unwrap();
        create_block(&conn, &t.id, ts(2031, 1, 13, 10), ts(2031, 1, 13, 11)).unwrap();
        let now = ts(2031, 1, 19, 21);
        db::set_setting(&conn, crate::notify::QUIET_UNTIL_KEY, &(now + 3600).to_string()).unwrap();
        assert!(take_nudge(&conn, now).unwrap().is_none(), "静音中不提");
        // 水位线没被推过 → 解静音后同一个窗口里照提
        db::set_setting(&conn, crate::notify::QUIET_UNTIL_KEY, "0").unwrap();
        let after = take_nudge(&conn, now + 120).unwrap().expect("解静音后该提");
        assert_eq!(after.week_start, week_from());
    }

    #[test]
    fn test_remind_setting_defaults_and_fallback() {
        let conn = test_conn();
        assert_eq!(remind_setting(&conn).text(), DEFAULT_REMIND_AT, "默认周日 20:00");
        assert_eq!(
            action_setting(&conn),
            "off",
            "round69.1（#12）：新默认什么都不做（旧默认每周一次提醒，用户说骚扰）"
        );

        // 直接写库绕过白名单校验 → 读的时候必须回退默认（与预算同一个口径）
        db::set_setting(&conn, KEY_REMIND_AT, "垃圾值").unwrap();
        assert_eq!(remind_setting(&conn).text(), DEFAULT_REMIND_AT);
    }
}
