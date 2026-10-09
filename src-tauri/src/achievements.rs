//! round68（19.1）成就（暗章）—— **唯一实现**：定义 / 求值 / 信号 / 进度。
//!
//! ## 口径（与 `docs/plans/round68-achievements.md` §二 一一对应）
//!
//! - **单一版本**（round85 / 0.31.0）：成就进唯一版本 —— 「风格版 / Lite 档」的分叉已取消
//!   （以前用 `--features lite` 编出无成就的 Lite 包；你 2026-10-08 澄清：风格化版暂不做，只留一版）。
//! - **默认开**（`achievements_enabled` 缺省 / 非 `"0"` 都当开）；用户可显式关掉。
//! - **一次性全量回溯**：首次求值静默（不弹提示）、置 `achievements_initialized`；
//!   之后每次块写操作（`record()` 末尾）与每个信号即时求值。
//! - **不设撤销**：`achievements` 表**不进** `SNAPSHOT_TABLES` —— Ctrl+Z 不回退徽章；
//!   连续型断了也不清零（已点亮永久保留）。
//! - **列表照 MAA**：未点亮（非隐藏）= `???` 名字 + 条件 + `x/target` 进度；隐藏档点亮前不返回。
//! - 计数口径与 `stats.rs` **一致**（有对账测试）：手动 `postpone` 只认 `payload.cascade != true`；
//!   `create` 分 `temp`（且 `!template`）/ `template`；`move` 分「起点变」与「只终点变（拉伸）」；
//!   自动顺延（`cascade`）不计入移动/漂移/接链。
//! - **不往 `events` 加新事件类型**（保护统计页「事件总数 / 用过的天数」口径）；
//!   信号类没有历史数据可回溯，只在动作发生时解锁 / 计数（progress 存表）。

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use chrono::{Datelike, Local, Months, NaiveDate, TimeZone, Timelike};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::db;
use crate::sanity::{local_day_add, local_day_start, week_start_of};
use crate::i18n;
use crate::tf;

/// 功能开关（`settings.rs` 白名单成员；默认开 —— 只有显式 `"0"` 才算关）
pub const SETTING_KEY: &str = "achievements_enabled";
/// 解锁短提示开关（默认开）
pub const TOAST_KEY: &str = "achievement_toast";
/// 内部键：首次全量回溯是否已跑过（不进白名单 —— 不是用户设置）
const INITIALIZED_KEY: &str = "achievements_initialized";

/// round79（78-11）：「重置成就」的时间界 —— **内部键**（不进白名单，照 `review_nudged_week` 口径）。
///
/// 语义：**从此刻起重新挣** —— 四个采集器（事件 / 块 / 任务 / 序列）只收这条线之后的行；
/// 之前的历史仍留在库里（**一条不删**），但不再计入成就。为什么不能只清表：本引擎是全史重算，
/// 只清「已点亮」下次求值就按历史全部复活（Steam 社区实测的假重置），详见
/// `docs/素材库/重置与恢复调研.md` §3。
pub const KEY_RESET_AT: &str = "achievements_reset_at";

/// 读时间界（缺省 / 坏值 = `0` = 全史 = 旧行为）
pub fn reset_at(conn: &Connection) -> i64 {
    db::get_setting(conn, KEY_RESET_AT)
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- 定义

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum CountKey {
    Create,
    Complete,
    Skip,
    Merge,
    Link,
    Postpone,
    CreateTemp,
    CreateTemplate,
    Stretch,
    Move,
}

/// 求值规则（目标值在 `Def.target`；参数只放规则特有的东西）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Rule {
    /// 数事件条数（target = 需要几条；0 = 只问「有没有」）
    Count(CountKey),
    /// 完成时长求和（target = 分钟）
    Minutes,
    /// 有排程动作的自然日累计（target = 天数）
    ActiveDays,
    /// 连续自然日有动作（target = 连续天数）
    DayStreak,
    /// 连续自然月有动作（target = 连续月数）
    MonthStreak,
    /// 连续 N 天每天至少 `per_day` 条完成；`hours` 限定完成的时段（含端点）
    CompleteDayStreak { per_day: u32, hours: Option<(u8, u8)> },
    /// 任一事件落在 hours 内（含端点；布尔）
    HourAny { from: u8, to: u8 },
    /// 任一完成落在 hours 内（含端点；布尔）
    CompleteHours { from: u8, to: u8 },
    /// 事件落在周六/周日（布尔）
    WeekendEvent,
    /// 事件落在 12 月 31 日（布尔）
    CrossYear,
    /// 连续 N 天、每天都有块落在同一个「时刻」（时:分）
    SameTimeStreak,
    /// 周日创建的块、开始时间在下一周（布尔）
    SundayNextWeek,
    /// 某个月「到点 ≥ target 且一条没落下」
    MonthDoneNoMiss,
    /// 存在一块时长正好 `seconds` 秒（布尔）
    BlockSpanEq { seconds: i64 },
    /// 存在一块处于 `layer`（布尔）
    BlockLayerAny { layer: &'static str },
    /// 存在一条任务标了「不计入理智值」（布尔）
    TaskSanityExempt,
    /// 同一天把同一块挪 ≥ target 次
    FlipFlopDaily,
    /// 活动日之间出现过 ≥ `min_days` 天的空窗、且之后又回来（布尔）
    GapAfter { min_days: u32 },
    /// 有一周 7 天都有块（target = 7）
    FullWeek,
    /// 同一天同一任务 ≥ target 块
    SameTaskDay,
    /// 存在 `final_status == value` 的块（布尔）
    FinalStatus { value: &'static str },
    /// 有一次移动跨过 ≥ `min_weeks` 周（`forward_only` = 只认往后；布尔）
    MoveSpanWeeks { min_weeks: i64, forward_only: bool },
    /// 有完整一周 ≥ `min_blocks` 块、且**全部**排在白天 6:00–18:00（布尔）
    DaylightWeek { min_blocks: u32 },
    /// 有完整周末两天都没有块（布尔）
    FreeWeekend,
    /// 有完整一周没有块（布尔）
    BlankWeek,
    /// 某天里必填与弹性各有 ≥ target 块完成（布尔）
    BalancedDay,
    /// 有一块在开始后 ≤ `max_minutes` 分钟内被完成（布尔）
    FastComplete { max_minutes: u32 },
    /// 某周里有 ≥ target 个不同任务被完成
    WeekDistinctTasks,
    /// 某个工作日（周一–周五）9–18 点开始的块 ≥ target（布尔）
    WeekdayWorkBlocks,
    /// 某个周五排了 ≥ target 块（布尔）
    FridayBlocks,
    /// 每个用过的分类里都排过 ≥ `min_blocks` 块，且分类数 ≥ `min_cats`（布尔）
    AllCategoriesWithBlocks { min_cats: u32, min_blocks: u32 },
    /// 有一周里六样东西全齐：必填 / 弹性 / 完成 / 未完成 / 漂移 / 临时（布尔）
    WeekSixElements,
    /// 分钟窗口内连建 ≥ target 块
    CreateBurst { window: i64 },
    /// 单日建块 ≥ target
    CreatePerDay,
    /// 某条序列 ≥ `min_len` 环（布尔）
    SequenceMaxLen { min_len: u32 },
    /// 任务名 ≥ target 字
    /// 存在一条**任务名长度 ≥ `min_chars`** 的任务（布尔）
    TaskTitleMinLen { min_chars: u32 },
    /// 用过的分类数 ≥ target
    CategoryCount,
    /// 用满 `days` 天、且最近 `active_within` 天里还有动作（布尔）
    Birthday { days: u32, active_within: u32 },
    /// 有某一周「到点 ≥ `min_done` 且一条没落下」（布尔；target 0）
    WeekDoneNoMiss { min_done: u32 },
    /// 连续 target 周「每周到点 ≥ `min_done` 且一条没落下」
    ConsecutivePerfectWeeks { min_done: u32 },
    /// 一条漂流链连漂 ≥ `min_depth` 次（布尔）
    DriftDepth { min_depth: u32 },
    /// 漂走的块又排回父块原来的时段（布尔）
    Boomerang,
    /// 集章：点亮 `target` 枚
    Meta,
    /// 走信号（无历史可回溯）
    Signal,
}

pub struct Def {
    pub id: &'static str,
    pub name: &'static str,
    pub desc: &'static str,
    pub cond: &'static str,
    pub target: u32,
    /// 0 = 普通；1 = ★ 稀有；2 = ★★ 传说
    pub tier: u8,
    pub hidden: bool,
    pub group: &'static str,
    rule: Rule,
}

/// 定义构造函数（98 条用；短名只为让下面的表好读）
#[allow(clippy::too_many_arguments)] // 数据表的行；拆成结构体只会让 98 行更难对照
const fn d(
    id: &'static str,
    name: &'static str,
    desc: &'static str,
    cond: &'static str,
    target: u32,
    tier: u8,
    hidden: bool,
    group: &'static str,
    rule: Rule,
) -> Def {
    Def {
        id,
        name,
        desc,
        cond,
        target,
        tier,
        hidden,
        group,
        rule,
    }
}

/// 全部暗章（顺序 = 列表顺序；分组按内容排好）
pub const DEFS: &[Def] = &[
    // ---------------- 入门（8）
    d("first_block", i18n::msg::ACH_FIRST_BLOCK_NAME, i18n::msg::ACH_FIRST_BLOCK_DESC, i18n::msg::ACH_FIRST_BLOCK_COND, 0, 0, false, i18n::msg::ACH_GROUP_INTRO, Rule::Count(CountKey::Create)),
    d("first_done", i18n::msg::ACH_FIRST_DONE_NAME, i18n::msg::ACH_FIRST_DONE_DESC, i18n::msg::ACH_FIRST_DONE_COND, 0, 0, false, i18n::msg::ACH_GROUP_INTRO, Rule::Count(CountKey::Complete)),
    d("first_temp", i18n::msg::ACH_FIRST_TEMP_NAME, i18n::msg::ACH_FIRST_TEMP_DESC, i18n::msg::ACH_FIRST_TEMP_COND, 0, 0, false, i18n::msg::ACH_GROUP_INTRO, Rule::Count(CountKey::CreateTemp)),
    d("first_template", i18n::msg::ACH_FIRST_TEMPLATE_NAME, i18n::msg::ACH_FIRST_TEMPLATE_DESC, i18n::msg::ACH_FIRST_TEMPLATE_COND, 0, 0, false, i18n::msg::ACH_GROUP_INTRO, Rule::Count(CountKey::CreateTemplate)),
    d("first_sequence", i18n::msg::ACH_FIRST_SEQUENCE_NAME, i18n::msg::ACH_FIRST_SEQUENCE_DESC, i18n::msg::ACH_FIRST_SEQUENCE_COND, 0, 0, false, i18n::msg::ACH_GROUP_INTRO, Rule::Count(CountKey::Link)),
    d("first_drift", i18n::msg::ACH_FIRST_DRIFT_NAME, i18n::msg::ACH_FIRST_DRIFT_DESC, i18n::msg::ACH_FIRST_DRIFT_COND, 0, 0, false, i18n::msg::ACH_GROUP_INTRO, Rule::Count(CountKey::Postpone)),
    d("first_merge", i18n::msg::ACH_FIRST_MERGE_NAME, i18n::msg::ACH_FIRST_MERGE_DESC, i18n::msg::ACH_FIRST_MERGE_COND, 0, 0, false, i18n::msg::ACH_GROUP_INTRO, Rule::Count(CountKey::Merge)),
    d("resize_first", i18n::msg::ACH_RESIZE_FIRST_NAME, i18n::msg::ACH_RESIZE_FIRST_DESC, i18n::msg::ACH_RESIZE_FIRST_COND, 0, 0, false, i18n::msg::ACH_GROUP_INTRO, Rule::Count(CountKey::Stretch)),
    // ---------------- 一点点来（8）
    d("done_10", i18n::msg::ACH_DONE_10_NAME, i18n::msg::ACH_DONE_10_DESC, i18n::msg::ACH_DONE_10_COND, 10, 0, false, i18n::msg::ACH_GROUP_STEADY, Rule::Count(CountKey::Complete)),
    d("done_100", i18n::msg::ACH_DONE_100_NAME, i18n::msg::ACH_DONE_100_DESC, i18n::msg::ACH_DONE_100_COND, 100, 1, false, i18n::msg::ACH_GROUP_STEADY, Rule::Count(CountKey::Complete)),
    d("hours_100", i18n::msg::ACH_HOURS_100_NAME, i18n::msg::ACH_HOURS_100_DESC, i18n::msg::ACH_HOURS_100_COND, 6000, 0, false, i18n::msg::ACH_GROUP_STEADY, Rule::Minutes),
    d("created_100", i18n::msg::ACH_CREATED_100_NAME, i18n::msg::ACH_CREATED_100_DESC, i18n::msg::ACH_CREATED_100_COND, 100, 0, false, i18n::msg::ACH_GROUP_STEADY, Rule::Count(CountKey::Create)),
    d("postpone_10", i18n::msg::ACH_POSTPONE_10_NAME, i18n::msg::ACH_POSTPONE_10_DESC, i18n::msg::ACH_POSTPONE_10_COND, 10, 0, false, i18n::msg::ACH_GROUP_STEADY, Rule::Count(CountKey::Postpone)),
    d("merge_10", i18n::msg::ACH_MERGE_10_NAME, i18n::msg::ACH_MERGE_10_DESC, i18n::msg::ACH_MERGE_10_COND, 10, 0, false, i18n::msg::ACH_GROUP_STEADY, Rule::Count(CountKey::Merge)),
    d("rearrange_100", i18n::msg::ACH_REARRANGE_100_NAME, i18n::msg::ACH_REARRANGE_100_DESC, i18n::msg::ACH_REARRANGE_100_COND, 100, 0, false, i18n::msg::ACH_GROUP_STEADY, Rule::Count(CountKey::Move)),
    d("days_100", i18n::msg::ACH_DAYS_100_NAME, i18n::msg::ACH_DAYS_100_DESC, i18n::msg::ACH_DAYS_100_COND, 100, 1, false, i18n::msg::ACH_GROUP_STEADY, Rule::ActiveDays),
    // ---------------- 功能探索（11）
    d("batch_first", i18n::msg::ACH_BATCH_FIRST_NAME, i18n::msg::ACH_BATCH_FIRST_DESC, i18n::msg::ACH_BATCH_FIRST_COND, 0, 0, false, i18n::msg::ACH_GROUP_EXPLORE, Rule::Signal),
    d("stats_first", i18n::msg::ACH_STATS_FIRST_NAME, i18n::msg::ACH_STATS_FIRST_DESC, i18n::msg::ACH_STATS_FIRST_COND, 0, 0, false, i18n::msg::ACH_GROUP_EXPLORE, Rule::Signal),
    d("review_first", i18n::msg::ACH_REVIEW_FIRST_NAME, i18n::msg::ACH_REVIEW_FIRST_DESC, i18n::msg::ACH_REVIEW_FIRST_COND, 0, 0, false, i18n::msg::ACH_GROUP_EXPLORE, Rule::Signal),
    d("export_ics", i18n::msg::ACH_EXPORT_ICS_NAME, i18n::msg::ACH_EXPORT_ICS_DESC, i18n::msg::ACH_EXPORT_ICS_COND, 0, 0, false, i18n::msg::ACH_GROUP_EXPLORE, Rule::Signal),
    d("backup_first", i18n::msg::ACH_BACKUP_FIRST_NAME, i18n::msg::ACH_BACKUP_FIRST_DESC, i18n::msg::ACH_BACKUP_FIRST_COND, 0, 0, false, i18n::msg::ACH_GROUP_EXPLORE, Rule::Signal),
    d("hotkey_first", i18n::msg::ACH_HOTKEY_FIRST_NAME, i18n::msg::ACH_HOTKEY_FIRST_DESC, i18n::msg::ACH_HOTKEY_FIRST_COND, 0, 0, false, i18n::msg::ACH_GROUP_EXPLORE, Rule::Signal),
    d("portable_first", i18n::msg::ACH_PORTABLE_FIRST_NAME, i18n::msg::ACH_PORTABLE_FIRST_DESC, i18n::msg::ACH_PORTABLE_FIRST_COND, 0, 0, false, i18n::msg::ACH_GROUP_EXPLORE, Rule::Signal),
    d("help_first", i18n::msg::ACH_HELP_FIRST_NAME, i18n::msg::ACH_HELP_FIRST_DESC, i18n::msg::ACH_HELP_FIRST_COND, 0, 0, false, i18n::msg::ACH_GROUP_EXPLORE, Rule::Signal),
    d("quiet_first", i18n::msg::ACH_QUIET_FIRST_NAME, i18n::msg::ACH_QUIET_FIRST_DESC, i18n::msg::ACH_QUIET_FIRST_COND, 0, 0, false, i18n::msg::ACH_GROUP_EXPLORE, Rule::Signal),
    d("category_first", i18n::msg::ACH_CATEGORY_FIRST_NAME, i18n::msg::ACH_CATEGORY_FIRST_DESC, i18n::msg::ACH_CATEGORY_FIRST_COND, 0, 0, false, i18n::msg::ACH_GROUP_EXPLORE, Rule::CategoryCount),
    d("panel_first", i18n::msg::ACH_PANEL_FIRST_NAME, i18n::msg::ACH_PANEL_FIRST_DESC, i18n::msg::ACH_PANEL_FIRST_COND, 0, 0, true, i18n::msg::ACH_GROUP_EXPLORE, Rule::Signal),
    // ---------------- 日子（12）
    d("night_owl", i18n::msg::ACH_NIGHT_OWL_NAME, i18n::msg::ACH_NIGHT_OWL_DESC, i18n::msg::ACH_NIGHT_OWL_COND, 0, 0, false, i18n::msg::ACH_GROUP_DAYS, Rule::HourAny { from: 0, to: 3 }),
    d("early_bird", "WakeyWakey~", i18n::msg::ACH_EARLY_BIRD_DESC, i18n::msg::ACH_EARLY_BIRD_COND, 0, 0, false, i18n::msg::ACH_GROUP_DAYS, Rule::CompleteHours { from: 7, to: 8 }),
    d("before_midnight", i18n::msg::ACH_BEFORE_MIDNIGHT_NAME, i18n::msg::ACH_BEFORE_MIDNIGHT_DESC, i18n::msg::ACH_BEFORE_MIDNIGHT_COND, 0, 0, false, i18n::msg::ACH_GROUP_DAYS, Rule::CompleteHours { from: 23, to: 23 }),
    d("night_done", i18n::msg::ACH_NIGHT_DONE_NAME, i18n::msg::ACH_NIGHT_DONE_DESC, i18n::msg::ACH_NIGHT_DONE_COND, 0, 0, true, i18n::msg::ACH_GROUP_DAYS, Rule::CompleteHours { from: 0, to: 3 }),
    d("weekend_warrior", i18n::msg::ACH_WEEKEND_WARRIOR_NAME, i18n::msg::ACH_WEEKEND_WARRIOR_DESC, i18n::msg::ACH_WEEKEND_WARRIOR_COND, 0, 0, false, i18n::msg::ACH_GROUP_DAYS, Rule::WeekendEvent),
    d("sunday_planner", i18n::msg::ACH_SUNDAY_PLANNER_NAME, i18n::msg::ACH_SUNDAY_PLANNER_DESC, i18n::msg::ACH_SUNDAY_PLANNER_COND, 0, 0, false, i18n::msg::ACH_GROUP_DAYS, Rule::SundayNextWeek),
    d("daily_7", i18n::msg::ACH_DAILY_7_NAME, i18n::msg::ACH_DAILY_7_DESC, i18n::msg::ACH_DAILY_7_COND, 7, 0, false, i18n::msg::ACH_GROUP_DAYS, Rule::DayStreak),
    d("daily_30", i18n::msg::ACH_DAILY_30_NAME, i18n::msg::ACH_DAILY_30_DESC, i18n::msg::ACH_DAILY_30_COND, 30, 1, false, i18n::msg::ACH_GROUP_DAYS, Rule::DayStreak),
    d("cross_year", i18n::msg::ACH_CROSS_YEAR_NAME, i18n::msg::ACH_CROSS_YEAR_DESC, i18n::msg::ACH_CROSS_YEAR_COND, 0, 0, true, i18n::msg::ACH_GROUP_DAYS, Rule::CrossYear),
    d("same_time_5", i18n::msg::ACH_SAME_TIME_5_NAME, i18n::msg::ACH_SAME_TIME_5_DESC, i18n::msg::ACH_SAME_TIME_5_COND, 5, 1, false, i18n::msg::ACH_GROUP_DAYS, Rule::SameTimeStreak),
    d("early_3", i18n::msg::ACH_EARLY_3_NAME, i18n::msg::ACH_EARLY_3_DESC, i18n::msg::ACH_EARLY_3_COND, 3, 1, false, i18n::msg::ACH_GROUP_DAYS, Rule::CompleteDayStreak { per_day: 1, hours: Some((7, 8)) }),
    d("owl_3", i18n::msg::ACH_OWL_3_NAME, i18n::msg::ACH_OWL_3_DESC, i18n::msg::ACH_OWL_3_COND, 3, 1, false, i18n::msg::ACH_GROUP_DAYS, Rule::CompleteDayStreak { per_day: 1, hours: Some((0, 3)) }),
    // ---------------- 彩蛋（40）
    d("undo_first", i18n::msg::ACH_UNDO_FIRST_NAME, i18n::msg::ACH_UNDO_FIRST_DESC, i18n::msg::ACH_UNDO_FIRST_COND, 0, 0, true, i18n::msg::ACH_GROUP_EASTER, Rule::Signal),
    d("undo_after_delete", i18n::msg::ACH_UNDO_AFTER_DELETE_NAME, i18n::msg::ACH_UNDO_AFTER_DELETE_DESC, i18n::msg::ACH_UNDO_AFTER_DELETE_COND, 0, 0, true, i18n::msg::ACH_GROUP_EASTER, Rule::Signal),
    d("drift_depth_3", i18n::msg::ACH_DRIFT_DEPTH_3_NAME, i18n::msg::ACH_DRIFT_DEPTH_3_DESC, i18n::msg::ACH_DRIFT_DEPTH_3_COND, 0, 0, true, i18n::msg::ACH_GROUP_EASTER, Rule::DriftDepth { min_depth: 3 }),
    d("past_week", i18n::msg::ACH_PAST_WEEK_NAME, i18n::msg::ACH_PAST_WEEK_DESC, i18n::msg::ACH_PAST_WEEK_COND, 0, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::Signal),
    d("next_week_first", i18n::msg::ACH_NEXT_WEEK_FIRST_NAME, i18n::msg::ACH_NEXT_WEEK_FIRST_DESC, i18n::msg::ACH_NEXT_WEEK_FIRST_COND, 0, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::Signal),
    d("jump_weeks", i18n::msg::ACH_JUMP_WEEKS_NAME, i18n::msg::ACH_JUMP_WEEKS_DESC, i18n::msg::ACH_JUMP_WEEKS_COND, 0, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::Signal),
    d("weekend_back", i18n::msg::ACH_WEEKEND_BACK_NAME, i18n::msg::ACH_WEEKEND_BACK_DESC, i18n::msg::ACH_WEEKEND_BACK_COND, 0, 0, true, i18n::msg::ACH_GROUP_EASTER, Rule::Signal),
    d("min_block", i18n::msg::ACH_MIN_BLOCK_NAME, i18n::msg::ACH_MIN_BLOCK_DESC, i18n::msg::ACH_MIN_BLOCK_COND, 0, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::BlockSpanEq { seconds: 15 * 60 }),
    d("diamond_layer", i18n::msg::ACH_DIAMOND_LAYER_NAME, i18n::msg::ACH_DIAMOND_LAYER_DESC, i18n::msg::ACH_DIAMOND_LAYER_COND, 0, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::BlockLayerAny { layer: "required" }),
    d("sanity_exempt", i18n::msg::ACH_SANITY_EXEMPT_NAME, i18n::msg::ACH_SANITY_EXEMPT_DESC, i18n::msg::ACH_SANITY_EXEMPT_COND, 0, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::TaskSanityExempt),
    d("overload_first", i18n::msg::ACH_OVERLOAD_FIRST_NAME, i18n::msg::ACH_OVERLOAD_FIRST_DESC, i18n::msg::ACH_OVERLOAD_FIRST_COND, 0, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::Signal),
    d("flip_flop", i18n::msg::ACH_FLIP_FLOP_NAME, i18n::msg::ACH_FLIP_FLOP_DESC, i18n::msg::ACH_FLIP_FLOP_COND, 5, 0, true, i18n::msg::ACH_GROUP_EASTER, Rule::FlipFlopDaily),
    d("back_after_gap", i18n::msg::ACH_BACK_AFTER_GAP_NAME, i18n::msg::ACH_BACK_AFTER_GAP_DESC, i18n::msg::ACH_BACK_AFTER_GAP_COND, 0, 0, true, i18n::msg::ACH_GROUP_EASTER, Rule::GapAfter { min_days: 30 }),
    d("full_week", i18n::msg::ACH_FULL_WEEK_NAME, i18n::msg::ACH_FULL_WEEK_DESC, i18n::msg::ACH_FULL_WEEK_COND, 7, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::FullWeek),
    d("all_done_week", i18n::msg::ACH_ALL_DONE_WEEK_NAME, i18n::msg::ACH_ALL_DONE_WEEK_DESC, i18n::msg::ACH_ALL_DONE_WEEK_COND, 0, 1, false, i18n::msg::ACH_GROUP_EASTER, Rule::WeekDoneNoMiss { min_done: 5 }),
    d("five_same", i18n::msg::ACH_FIVE_SAME_NAME, i18n::msg::ACH_FIVE_SAME_DESC, i18n::msg::ACH_FIVE_SAME_COND, 5, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::SameTaskDay),
    d("sorry_today", i18n::msg::ACH_SORRY_TODAY_NAME, i18n::msg::ACH_SORRY_TODAY_DESC, i18n::msg::ACH_SORRY_TODAY_COND, 0, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::Count(CountKey::Skip)),
    d("ma_hou_pao", i18n::msg::ACH_MA_HOU_PAO_NAME, i18n::msg::ACH_MA_HOU_PAO_DESC, i18n::msg::ACH_MA_HOU_PAO_COND, 0, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::FinalStatus { value: "done_overtime" }),
    d("next_week_move", i18n::msg::ACH_NEXT_WEEK_MOVE_NAME, i18n::msg::ACH_NEXT_WEEK_MOVE_DESC, i18n::msg::ACH_NEXT_WEEK_MOVE_COND, 0, 1, false, i18n::msg::ACH_GROUP_EASTER, Rule::MoveSpanWeeks { min_weeks: 1, forward_only: true }),
    d("warp_bubble", i18n::msg::ACH_WARP_BUBBLE_NAME, i18n::msg::ACH_WARP_BUBBLE_DESC, i18n::msg::ACH_WARP_BUBBLE_COND, 0, 1, false, i18n::msg::ACH_GROUP_EASTER, Rule::MoveSpanWeeks { min_weeks: 4, forward_only: false }),
    d("boomerang", i18n::msg::ACH_BOOMERANG_NAME, i18n::msg::ACH_BOOMERANG_DESC, i18n::msg::ACH_BOOMERANG_COND, 0, 1, false, i18n::msg::ACH_GROUP_EASTER, Rule::Boomerang),
    d("quantum_speed", i18n::msg::ACH_QUANTUM_SPEED_NAME, i18n::msg::ACH_QUANTUM_SPEED_DESC, i18n::msg::ACH_QUANTUM_SPEED_COND, 5, 1, false, i18n::msg::ACH_GROUP_EASTER, Rule::CreateBurst { window: 60 }),
    d("overwork_day", i18n::msg::ACH_OVERWORK_DAY_NAME, i18n::msg::ACH_OVERWORK_DAY_DESC, i18n::msg::ACH_OVERWORK_DAY_COND, 20, 1, false, i18n::msg::ACH_GROUP_EASTER, Rule::CreatePerDay),
    d("one_key_three", i18n::msg::ACH_ONE_KEY_THREE_NAME, i18n::msg::ACH_ONE_KEY_THREE_DESC, i18n::msg::ACH_ONE_KEY_THREE_COND, 0, 1, false, i18n::msg::ACH_GROUP_EASTER, Rule::SequenceMaxLen { min_len: 3 }),
    d("archaeologist", i18n::msg::ACH_ARCHAEOLOGIST_NAME, i18n::msg::ACH_ARCHAEOLOGIST_DESC, i18n::msg::ACH_ARCHAEOLOGIST_COND, 0, 1, false, i18n::msg::ACH_GROUP_EASTER, Rule::Signal),
    d("long_name", i18n::msg::ACH_LONG_NAME_NAME, i18n::msg::ACH_LONG_NAME_DESC, i18n::msg::ACH_LONG_NAME_COND, 0, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::TaskTitleMinLen { min_chars: 20 }),
    d("category_boss", i18n::msg::ACH_CATEGORY_BOSS_NAME, i18n::msg::ACH_CATEGORY_BOSS_DESC, i18n::msg::ACH_CATEGORY_BOSS_COND, 10, 1, false, i18n::msg::ACH_GROUP_EASTER, Rule::CategoryCount),
    d("blank_week", i18n::msg::ACH_BLANK_WEEK_NAME, i18n::msg::ACH_BLANK_WEEK_DESC, i18n::msg::ACH_BLANK_WEEK_COND, 0, 1, false, i18n::msg::ACH_GROUP_EASTER, Rule::BlankWeek),
    d("free_weekend", i18n::msg::ACH_FREE_WEEKEND_NAME, i18n::msg::ACH_FREE_WEEKEND_DESC, i18n::msg::ACH_FREE_WEEKEND_COND, 0, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::FreeWeekend),
    d("balanced", i18n::msg::ACH_BALANCED_NAME, i18n::msg::ACH_BALANCED_DESC, i18n::msg::ACH_BALANCED_COND, 2, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::BalancedDay),
    d("hom_dont_move", i18n::msg::ACH_HOM_DONT_MOVE_NAME, i18n::msg::ACH_HOM_DONT_MOVE_DESC, i18n::msg::ACH_HOM_DONT_MOVE_COND, 0, 0, true, i18n::msg::ACH_GROUP_EASTER, Rule::Signal),
    d("hom_my_all", i18n::msg::ACH_HOM_MY_ALL_NAME, i18n::msg::ACH_HOM_MY_ALL_DESC, i18n::msg::ACH_HOM_MY_ALL_COND, 0, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::Signal),
    d("hom_way_ahead", i18n::msg::ACH_HOM_WAY_AHEAD_NAME, i18n::msg::ACH_HOM_WAY_AHEAD_DESC, i18n::msg::ACH_HOM_WAY_AHEAD_COND, 0, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::FinalStatus { value: "done_short" }),
    d("hom_faster", i18n::msg::ACH_HOM_FASTER_NAME, i18n::msg::ACH_HOM_FASTER_DESC, i18n::msg::ACH_HOM_FASTER_COND, 0, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::FastComplete { max_minutes: 15 }),
    d("hom_praise_sun", i18n::msg::ACH_HOM_PRAISE_SUN_NAME, i18n::msg::ACH_HOM_PRAISE_SUN_DESC, i18n::msg::ACH_HOM_PRAISE_SUN_COND, 0, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::DaylightWeek { min_blocks: 10 }),
    d("hom_undo5", i18n::msg::ACH_HOM_UNDO5_NAME, i18n::msg::ACH_HOM_UNDO5_DESC, i18n::msg::ACH_HOM_UNDO5_COND, 5, 0, false, i18n::msg::ACH_GROUP_EASTER, Rule::Signal),
    d("hom_quest_clear", "QUEST CLEAR", i18n::msg::ACH_HOM_QUEST_CLEAR_DESC, i18n::msg::ACH_HOM_QUEST_CLEAR_COND, 3, 1, false, i18n::msg::ACH_GROUP_EASTER, Rule::CompleteDayStreak { per_day: 1, hours: None }),
    d("rain_dew", i18n::msg::ACH_RAIN_DEW_NAME, i18n::msg::ACH_RAIN_DEW_DESC, i18n::msg::ACH_RAIN_DEW_COND, 5, 1, false, i18n::msg::ACH_GROUP_EASTER, Rule::WeekDistinctTasks),
    d("friday_hell", i18n::msg::ACH_FRIDAY_HELL_NAME, i18n::msg::ACH_FRIDAY_HELL_DESC, i18n::msg::ACH_FRIDAY_HELL_COND, 8, 1, false, i18n::msg::ACH_GROUP_EASTER, Rule::FridayBlocks),
    d("worker", i18n::msg::ACH_WORKER_NAME, i18n::msg::ACH_WORKER_DESC, i18n::msg::ACH_WORKER_COND, 8, 1, false, i18n::msg::ACH_GROUP_EASTER, Rule::WeekdayWorkBlocks),
    // ---------------- 传说（16）
    d("days_365", i18n::msg::ACH_DAYS_365_NAME, i18n::msg::ACH_DAYS_365_DESC, i18n::msg::ACH_DAYS_365_COND, 365, 2, false, i18n::msg::ACH_GROUP_LEGEND, Rule::ActiveDays),
    d("thousand", i18n::msg::ACH_THOUSAND_NAME, i18n::msg::ACH_THOUSAND_DESC, i18n::msg::ACH_THOUSAND_COND, 1000, 2, false, i18n::msg::ACH_GROUP_LEGEND, Rule::Count(CountKey::Complete)),
    d("hours_1000", i18n::msg::ACH_HOURS_1000_NAME, i18n::msg::ACH_HOURS_1000_DESC, i18n::msg::ACH_HOURS_1000_COND, 60000, 2, false, i18n::msg::ACH_GROUP_LEGEND, Rule::Minutes),
    d("streak_100", i18n::msg::ACH_STREAK_100_NAME, i18n::msg::ACH_STREAK_100_DESC, i18n::msg::ACH_STREAK_100_COND, 100, 2, false, i18n::msg::ACH_GROUP_LEGEND, Rule::DayStreak),
    d("time_master", i18n::msg::ACH_TIME_MASTER_NAME, i18n::msg::ACH_TIME_MASTER_DESC, i18n::msg::ACH_TIME_MASTER_COND, 4, 2, false, i18n::msg::ACH_GROUP_LEGEND, Rule::ConsecutivePerfectWeeks { min_done: 5 }),
    d("pack_rat", i18n::msg::ACH_PACK_RAT_NAME, i18n::msg::ACH_PACK_RAT_DESC, i18n::msg::ACH_PACK_RAT_COND, 1000, 2, false, i18n::msg::ACH_GROUP_LEGEND, Rule::Count(CountKey::Create)),
    d("all_categories", i18n::msg::ACH_ALL_CATEGORIES_NAME, i18n::msg::ACH_ALL_CATEGORIES_DESC, i18n::msg::ACH_ALL_CATEGORIES_COND, 0, 2, false, i18n::msg::ACH_GROUP_LEGEND, Rule::AllCategoriesWithBlocks { min_cats: 5, min_blocks: 3 }),
    d("how_did_we_get_here", i18n::msg::ACH_HOW_DID_WE_GET_HERE_NAME, i18n::msg::ACH_HOW_DID_WE_GET_HERE_DESC, i18n::msg::ACH_HOW_DID_WE_GET_HERE_COND, 0, 2, false, i18n::msg::ACH_GROUP_LEGEND, Rule::WeekSixElements),
    d("month_streak_12", i18n::msg::ACH_MONTH_STREAK_12_NAME, i18n::msg::ACH_MONTH_STREAK_12_DESC, i18n::msg::ACH_MONTH_STREAK_12_COND, 12, 2, false, i18n::msg::ACH_GROUP_LEGEND, Rule::MonthStreak),
    d("perfect_month", i18n::msg::ACH_PERFECT_MONTH_NAME, i18n::msg::ACH_PERFECT_MONTH_DESC, i18n::msg::ACH_PERFECT_MONTH_COND, 20, 2, false, i18n::msg::ACH_GROUP_LEGEND, Rule::MonthDoneNoMiss),
    d("undo_100", i18n::msg::ACH_UNDO_100_NAME, i18n::msg::ACH_UNDO_100_DESC, i18n::msg::ACH_UNDO_100_COND, 100, 2, false, i18n::msg::ACH_GROUP_LEGEND, Rule::Signal),
    d("seq_50", i18n::msg::ACH_SEQ_50_NAME, i18n::msg::ACH_SEQ_50_DESC, i18n::msg::ACH_SEQ_50_COND, 50, 2, false, i18n::msg::ACH_GROUP_LEGEND, Rule::Count(CountKey::Link)),
    d("template_100", i18n::msg::ACH_TEMPLATE_100_NAME, i18n::msg::ACH_TEMPLATE_100_DESC, i18n::msg::ACH_TEMPLATE_100_COND, 100, 2, false, i18n::msg::ACH_GROUP_LEGEND, Rule::Count(CountKey::CreateTemplate)),
    d("birthday", i18n::msg::ACH_BIRTHDAY_NAME, i18n::msg::ACH_BIRTHDAY_DESC, i18n::msg::ACH_BIRTHDAY_COND, 0, 2, false, i18n::msg::ACH_GROUP_LEGEND, Rule::Birthday { days: 365, active_within: 30 }),
    d("schedule_30", i18n::msg::ACH_SCHEDULE_30_NAME, i18n::msg::ACH_SCHEDULE_30_DESC, i18n::msg::ACH_SCHEDULE_30_COND, 30, 2, false, i18n::msg::ACH_GROUP_LEGEND, Rule::CreatePerDay),
    // ---------------- 集章（4）
    d("collect_10", i18n::msg::ACH_COLLECT_10_NAME, i18n::msg::ACH_COLLECT_10_DESC, i18n::msg::ACH_COLLECT_10_COND, 10, 0, false, i18n::msg::ACH_GROUP_STAMPS, Rule::Meta),
    d("collect_30", i18n::msg::ACH_COLLECT_30_NAME, i18n::msg::ACH_COLLECT_30_DESC, i18n::msg::ACH_COLLECT_30_COND, 30, 0, false, i18n::msg::ACH_GROUP_STAMPS, Rule::Meta),
    d("collect_50", i18n::msg::ACH_COLLECT_50_NAME, i18n::msg::ACH_COLLECT_50_DESC, i18n::msg::ACH_COLLECT_50_COND, 50, 1, false, i18n::msg::ACH_GROUP_STAMPS, Rule::Meta),
    d("collect_80", i18n::msg::ACH_COLLECT_80_NAME, i18n::msg::ACH_COLLECT_80_DESC, i18n::msg::ACH_COLLECT_80_COND, 80, 2, false, i18n::msg::ACH_GROUP_STAMPS, Rule::Meta),
];

/// 信号白名单：信号名 → 收听的成就 id（顺序即解锁顺序）
const SIGNALS: &[(&str, &[&str])] = &[
    ("batch", &["batch_first"]),
    ("stats", &["stats_first"]),
    ("review", &["review_first"]),
    ("export_ics", &["export_ics"]),
    ("backup", &["backup_first"]),
    ("hotkey", &["hotkey_first"]),
    ("portable", &["portable_first"]),
    ("help", &["help_first"]),
    ("quiet", &["quiet_first"]),
    ("panel", &["panel_first"]),
    ("undo", &["undo_first", "hom_undo5", "undo_100"]),
    ("undo_delete", &["undo_after_delete"]),
    ("past_week", &["past_week"]),
    ("next_week", &["next_week_first"]),
    ("jump_weeks", &["jump_weeks"]),
    ("weekend_back", &["weekend_back"]),
    ("overload", &["overload_first"]),
    ("kbd_grab", &["hom_dont_move"]),
    ("select_all", &["hom_my_all"]),
    ("archaeologist", &["archaeologist"]),
];

// ---------------------------------------------------------------- 对外结构

#[derive(Serialize, Clone)]
pub struct Newly {
    pub id: &'static str,
    pub name: &'static str,
    pub unlocked_at: i64,
}

#[derive(Serialize)]
pub struct Row {
    pub id: &'static str,
    pub name: String,
    pub desc: String,
    pub cond: &'static str,
    pub progress: u32,
    pub target: u32,
    pub unlocked: bool,
    pub unlocked_at: Option<i64>,
    pub tier: u8,
    pub group: &'static str,
    pub hidden: bool,
}

#[derive(Serialize)]
pub struct ListPayload {
    pub unlocked: u32,
    pub total: u32,
    pub rows: Vec<Row>,
}

// ---------------------------------------------------------------- 开 / 关 / 句柄

/// 开关：**默认开**（只有显式存 `"0"` 才算关）
pub fn enabled(conn: &Connection) -> bool {
    match db::get_setting(conn, SETTING_KEY) {
        Ok(Some(v)) => v.trim() != "0",
        _ => true,
    }
}

fn initialized(conn: &Connection) -> bool {
    matches!(db::get_setting(conn, INITIALIZED_KEY), Ok(Some(v)) if v.trim() == "1")
}

fn set_initialized(conn: &Connection) -> Result<(), String> {
    db::set_setting(conn, INITIALIZED_KEY, "1")
}

/// 启动时调一次：默认开 → 首次全量回溯（静默）；失败只记日志，不拦启动
pub fn ensure_initialized(conn: &Connection) {
    if !enabled(conn) {
        return;
    }
    if let Err(e) = evaluate(conn, db::now()) {
        eprintln!("[achievements] 初始化回溯失败（忽略）：{e}");
    }
}

static APP: OnceLock<AppHandle> = OnceLock::new();

/// 记下 AppHandle（setup 里调一次）；没有它也能求值，只是不弹提示
pub fn attach_app(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

fn emit(newly: &[Newly]) {
    if newly.is_empty() {
        return;
    }
    if let Some(app) = APP.get() {
        if let Err(e) = app.emit("achievement-unlocked", newly) {
            eprintln!("[achievements] 广播解锁失败：{e}");
        }
    }
}

/// 块写操作后的统一挂点（`record()` 末尾）：求值 + 发事件；失败绝不影响写操作
pub fn after_write(conn: &Connection) {
    if !enabled(conn) {
        return;
    }
    match evaluate(conn, db::now()) {
        Ok(newly) => emit(&newly),
        Err(e) => eprintln!("[achievements] 写后求值失败（忽略）：{e}"),
    }
}

// ---------------------------------------------------------------- 状态表

type StateMap = HashMap<String, (Option<i64>, u32)>;

fn load_state(conn: &Connection) -> Result<StateMap, String> {
    let mut stmt = conn
        .prepare("SELECT id, unlocked_at, progress FROM achievements")
        .map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_01, e = e))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_02, e = e))?;
    let mut map = StateMap::new();
    for row in rows {
        let (id, unlocked_at, progress) = row.map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_03, e = e))?;
        map.insert(id, (unlocked_at, progress.max(0) as u32));
    }
    Ok(map)
}

fn write_state(conn: &Connection, state: &StateMap) -> Result<(), String> {
    for def in DEFS {
        if let Some((unlocked_at, progress)) = state.get(def.id) {
            conn.execute(
                "INSERT INTO achievements (id, unlocked_at, progress) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET unlocked_at = excluded.unlocked_at, progress = excluded.progress",
                rusqlite::params![def.id, unlocked_at, *progress as i64],
            )
            .map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_04, e = e))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- 求值

/// 全量求值：派生类重算进度（已点亮不退回）；首个非集章新解锁写表；集章随后再算一轮。
/// 首次（未 initialized）静默：写表但不返回新解锁、不弹提示。
fn evaluate(conn: &Connection, now: i64) -> Result<Vec<Newly>, String> {
    if !enabled(conn) {
        return Ok(Vec::new());
    }
    let silent = !initialized(conn);
    let since = reset_at(conn);
    let mut state = load_state(conn)?;
    let metrics = collect_metrics(conn, since)?;
    let blocks = collect_blocks(conn, since)?;
    let tasks = collect_tasks(conn, since)?;
    let seq = collect_sequences(conn, since)?;

    let mut newly: Vec<Newly> = Vec::new();
    for def in DEFS {
        if matches!(def.rule, Rule::Meta | Rule::Signal) {
            continue;
        }
        let (progress, hit) = value_of(def, &metrics, &blocks, &tasks, &seq, now);
        let entry = state.entry(def.id.to_string()).or_insert((None, 0));
        entry.1 = progress;
        if entry.0.is_none() {
            if let Some(at) = hit {
                entry.0 = Some(at);
                newly.push(Newly {
                    id: def.id,
                    name: i18n::t(def.name),
                    unlocked_at: at,
                });
            }
        }
    }

    // 集章：数已点亮（不含集章自己），够线才点亮
    let unlocked_others = state
        .iter()
        .filter(|(id, (u, _))| {
            u.is_some()
                && DEFS
                    .iter()
                    .any(|d| d.id == id.as_str() && !matches!(d.rule, Rule::Meta))
        })
        .count() as u32;
    for def in DEFS.iter().filter(|d| matches!(d.rule, Rule::Meta)) {
        let entry = state.entry(def.id.to_string()).or_insert((None, 0));
        entry.1 = unlocked_others;
        if entry.0.is_none() && def.target > 0 && unlocked_others >= def.target {
            entry.0 = Some(now);
            newly.push(Newly {
                id: def.id,
                name: i18n::t(def.name),
                unlocked_at: now,
            });
        }
    }

    write_state(conn, &state)?;
    if silent {
        set_initialized(conn)?;
        return Ok(Vec::new());
    }
    Ok(newly)
}

/// 信号落一条：布尔类直接点亮；计数类 progress+1（存表，不参与派生重算）
fn apply_signal(conn: &Connection, def: &Def, now: i64) -> Result<bool, String> {
    let existing = conn
        .query_row(
            "SELECT unlocked_at, progress FROM achievements WHERE id = ?1",
            [def.id],
            |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_05, e = e))?;
    let (unlocked_at, progress) = existing.unwrap_or((None, 0));
    if unlocked_at.is_some() {
        return Ok(false);
    }
    let (new_at, new_progress) = if def.target == 0 {
        (Some(now), progress.max(0))
    } else {
        let p = progress.max(0) as u32 + 1;
        (
            if p >= def.target { Some(now) } else { None },
            p as i64,
        )
    };
    conn.execute(
        "INSERT INTO achievements (id, unlocked_at, progress) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET
           unlocked_at = COALESCE(excluded.unlocked_at, achievements.unlocked_at),
           progress = excluded.progress",
        rusqlite::params![def.id, new_at, new_progress],
    )
    .map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_06, e = e))?;
    Ok(new_at.is_some())
}

/// 命令层：打一个信号（白名单；未知信号直接报错）。内部先求值再落信号，最后补算集章。
pub fn note(conn: &Connection, signal: &str) -> Result<(), String> {
    if !enabled(conn) {
        return Ok(());
    }
    let Some((_, ids)) = SIGNALS.iter().find(|(name, _)| *name == signal) else {
        return Err(tf!(i18n::msg::ACH_ACHIEVEMENTS_07, signal = signal));
    };
    let now = db::now();
    let mut newly = evaluate(conn, now)?;
    for id in *ids {
        if let Some(def) = DEFS.iter().find(|d| d.id == *id) {
            if apply_signal(conn, def, now)? {
                newly.push(Newly {
                    id: def.id,
                    name: i18n::t(def.name),
                    unlocked_at: now,
                });
            }
        }
    }
    // 信号点亮可能把集章推过线
    newly.extend(evaluate(conn, now)?);
    emit(&newly);
    Ok(())
}

/// 面板数据：未隐藏或已点亮的都返回（未点亮 = `???` + 条件 + x/target）
pub fn list(conn: &Connection) -> Result<ListPayload, String> {
    let now = db::now();
    evaluate(conn, now)?; // 打开面板顺手补一次（含首启静默回溯）
    let state = load_state(conn)?;
    let mut unlocked = 0u32;
    let mut rows: Vec<Row> = Vec::new();
    for def in DEFS {
        let (unlocked_at, progress) = state.get(def.id).copied().unwrap_or((None, 0));
        let is_unlocked = unlocked_at.is_some();
        if is_unlocked {
            unlocked += 1;
        }
        if def.hidden && !is_unlocked {
            continue;
        }
        rows.push(Row {
            id: def.id,
            name: if is_unlocked {
                i18n::t(def.name).to_string()
            } else {
                "???".to_string()
            },
            desc: if is_unlocked {
                i18n::t(def.desc).to_string()
            } else {
                "???".to_string()
            },
            cond: i18n::t(def.cond),
            progress,
            target: def.target,
            unlocked: is_unlocked,
            unlocked_at,
            tier: def.tier,
            group: i18n::t(def.group),
            hidden: def.hidden,
        });
    }
    // 已点亮优先（最近点亮的靠前）；未点亮保持定义顺序（稳定排序）
    rows.sort_by(|a, b| {
        b.unlocked
            .cmp(&a.unlocked)
            .then_with(|| b.unlocked_at.unwrap_or(0).cmp(&a.unlocked_at.unwrap_or(0)))
    });
    Ok(ListPayload {
        unlocked,
        total: DEFS.len() as u32,
        rows,
    })
}

/// round79（78-11）：**重置成就** —— 清空点亮记录 + 把**计分起点**挪到此刻（之后只数新活动）。
///
/// 三件事一起做才叫「重置」（少一件就是假重置）：
/// ① `DELETE FROM achievements`（点亮与进度都归零）；
/// ② 写 `KEY_RESET_AT`（四个采集器只收线之后的行）；
/// ③ `set_initialized`（否则「首启静默」会把重置后的第一批解锁吞成无声）。
pub fn reset(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM achievements", [])
        .map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_09, e = e))?;
    db::set_setting(conn, KEY_RESET_AT, &db::now().to_string())?;
    set_initialized(conn)
}

/// debug 构建自证用：全解锁 / 清空（release 下由命令层拒绝，这里不做构建判断）
pub fn debug_unlock_all(conn: &Connection) -> Result<(), String> {
    let now = db::now();
    for def in DEFS {
        conn.execute(
            "INSERT INTO achievements (id, unlocked_at, progress) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET unlocked_at = COALESCE(achievements.unlocked_at, excluded.unlocked_at),
               progress = MAX(achievements.progress, excluded.progress)",
            rusqlite::params![def.id, now, def.target.min(1) as i64],
        )
        .map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_08, e = e))?;
    }
    Ok(())
}

pub fn debug_lock_all(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM achievements", [])
        .map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_09, e = e))?;
    Ok(())
}

// ---------------------------------------------------------------- 指标（一次事件扫描）

struct MoveEv {
    at: i64,
    block: String,
    from: Option<i64>,
    to: Option<i64>,
}

#[derive(Default)]
struct Metrics {
    times: HashMap<CountKey, Vec<i64>>,
    creates: Vec<i64>,
    creates_per_day: HashMap<i64, Vec<i64>>,
    event_hours: HashMap<u32, i64>,
    complete_hours: HashMap<u32, i64>,
    complete_hour_days: HashMap<u32, HashSet<i64>>,
    active_days: HashSet<i64>,
    complete_per_day: HashMap<i64, u32>,
    complete_minutes: Vec<(i64, i64)>,
    /// round69.1（#9）：每次完成的**延迟分钟**（标 ✓ 时刻 − 计划开始；提前完成记 0）——
    /// 「快不过光速」看的是它（旧写法把 `complete_minutes`= **块多长**当成了「多快完成」）
    complete_delays: Vec<(i64, i64)>,
    minutes_total: i64,
    moves: Vec<MoveEv>,
    weekly: HashMap<i64, (u32, u32)>,
    monthly: HashMap<i64, (u32, u32)>,
    week_flags: HashMap<i64, u8>,
    completed_blocks: Vec<(i64, String)>,
    first_event: Option<i64>,
    last_event: Option<i64>,
    weekend_event: Option<i64>,
    cross_year: Option<i64>,
}

impl Metrics {
    fn push_time(&mut self, key: CountKey, at: i64) {
        self.times.entry(key).or_default().push(at);
    }
}

const F_TEMP: u8 = 1;
const F_POSTPONE: u8 = 2;
const F_COMPLETE: u8 = 4;
const F_SKIP: u8 = 8;
const F_LAYER_REQUIRED: u8 = 16;
const F_LAYER_ELASTIC: u8 = 32;
const F_ALL_SIX: u8 = F_TEMP | F_POSTPONE | F_COMPLETE | F_SKIP | F_LAYER_REQUIRED | F_LAYER_ELASTIC;

fn is_cascade(v: Option<&serde_json::Value>) -> bool {
    v.and_then(|x| x.get("cascade"))
        .and_then(|x| x.as_bool())
        .unwrap_or(false)
}

fn collect_metrics(conn: &Connection, since: i64) -> Result<Metrics, String> {
    let mut m = Metrics::default();
    let mut stmt = conn
        .prepare(
            "SELECT event_type, payload, created_at, block_id FROM events
             WHERE created_at >= ?1
             ORDER BY created_at, rowid",
        )
        .map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_10, e = e))?;
    let rows = stmt
        .query_map([since], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_11, e = e))?;
    for row in rows {
        let (ty, payload, at, block_id) = row.map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_12, e = e))?;
        let v: Option<serde_json::Value> = payload.as_deref().and_then(|p| serde_json::from_str(p).ok());
        m.first_event = Some(m.first_event.map_or(at, |f: i64| f.min(at)));
        m.last_event = Some(m.last_event.map_or(at, |f: i64| f.max(at)));
        let day = local_day_start(at);
        m.active_days.insert(day);
        let hour = local_hour(at);
        m.event_hours.entry(hour).or_insert(at);
        if local_weekday(at) >= 5 {
            m.weekend_event.get_or_insert(at);
        }
        if local_md(at) == (12, 31) {
            m.cross_year.get_or_insert(at);
        }
        let wk = week_start_of(day);
        let mut bits = 0u8;
        match ty.as_str() {
            "create" => {
                m.push_time(CountKey::Create, at);
                m.creates.push(at);
                m.creates_per_day.entry(day).or_default().push(at);
                let temp = v
                    .as_ref()
                    .and_then(|x| x.get("temp"))
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false);
                let template = v
                    .as_ref()
                    .and_then(|x| x.get("template"))
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false);
                if temp {
                    if !template {
                        m.push_time(CountKey::CreateTemp, at);
                    }
                    bits |= F_TEMP;
                }
                if template {
                    m.push_time(CountKey::CreateTemplate, at);
                }
            }
            "complete" => {
                m.push_time(CountKey::Complete, at);
                *m.complete_per_day.entry(day).or_insert(0) += 1;
                m.complete_hours.entry(hour).or_insert(at);
                m.complete_hour_days.entry(hour).or_default().insert(day);
                bits |= F_COMPLETE;
                m.completed_blocks.push((at, block_id));
                if let Some(mm) = v
                    .as_ref()
                    .and_then(|x| x.get("minutes"))
                    .and_then(|x| x.as_i64())
                {
                    m.minutes_total += mm;
                    m.complete_minutes.push((at, mm));
                }
                // round69.1（#9）：完成延迟（标 ✓ 时刻 − 计划开始；提前完成记 0）——
                // 「快不过光速」靠它判定；老事件没这个字段 → 不算（不拿块长充数）
                if let Some(d) = v
                    .as_ref()
                    .and_then(|x| x.get("delay_minutes"))
                    .and_then(|x| x.as_i64())
                {
                    m.complete_delays.push((at, d.max(0)));
                }
            }
            "skip" => {
                m.push_time(CountKey::Skip, at);
                bits |= F_SKIP;
            }
            "merge" => m.push_time(CountKey::Merge, at),
            "link" if !is_cascade(v.as_ref()) => m.push_time(CountKey::Link, at),
            "postpone" if !is_cascade(v.as_ref()) => {
                m.push_time(CountKey::Postpone, at);
                bits |= F_POSTPONE;
            }
            "move" if !is_cascade(v.as_ref()) => {
                let from = v.as_ref().and_then(|x| x.get("from")).and_then(|x| x.as_i64());
                let to = v.as_ref().and_then(|x| x.get("to")).and_then(|x| x.as_i64());
                let ef = v.as_ref().and_then(|x| x.get("end_from")).and_then(|x| x.as_i64());
                let et = v.as_ref().and_then(|x| x.get("end_to")).and_then(|x| x.as_i64());
                let stretch = matches!((from, to, ef, et), (Some(f), Some(t), Some(a), Some(b)) if f == t && a != b);
                if stretch {
                    m.push_time(CountKey::Stretch, at);
                } else {
                    m.push_time(CountKey::Move, at);
                    // 6b 复核（P2）：拉伸（只终点变）不算「挪」—— 骰子类规则只看真移动
                    m.moves.push(MoveEv {
                        at,
                        block: block_id,
                        from,
                        to,
                    });
                }
            }
            _ => {}
        }
        if bits != 0 {
            *m.week_flags.entry(wk).or_insert(0) |= bits;
        }
        match ty.as_str() {
            "complete" => m.weekly.entry(wk).or_insert((0, 0)).0 += 1,
            "skip" => m.weekly.entry(wk).or_insert((0, 0)).1 += 1,
            _ => {}
        }
        match ty.as_str() {
            "complete" => m.monthly.entry(local_month_start(at)).or_insert((0, 0)).0 += 1,
            "skip" => m.monthly.entry(local_month_start(at)).or_insert((0, 0)).1 += 1,
            _ => {}
        }
    }
    Ok(m)
}

// ---------------------------------------------------------------- 表状态

struct BlockFact {
    task_id: String,
    start_at: i64,
    end_at: i64,
    layer: String,
    final_status: Option<String>,
    postponed_from: Option<String>,
    created_at: i64,
}

#[derive(Default)]
struct BlockFacts {
    by_id: HashMap<String, BlockFact>,
    /// 周 → 该周有块的自然日
    week_days: HashMap<i64, HashSet<i64>>,
    /// 周 → 块数
    week_count: HashMap<i64, u32>,
    /// 周 → 是否全部白天（6:00–18:00）
    week_daylight: HashMap<i64, bool>,
    /// 自然日 → 块开始时刻
    day_starts: HashMap<i64, Vec<i64>>,
    /// 时刻（时*60+分）→ 有块的自然日
    hhmm_days: HashMap<u32, HashSet<i64>>,
    /// (任务, 自然日) → 块创建时刻
    task_day: HashMap<(String, i64), Vec<i64>>,
    /// 周 → 层位（必填 / 弹性）
    week_layer_bits: HashMap<i64, u8>,
}

fn collect_blocks(conn: &Connection, since: i64) -> Result<BlockFacts, String> {
    let mut b = BlockFacts::default();
    let mut stmt = conn
        .prepare(
            "SELECT id, task_id, start_at, end_at, layer, final_status, postponed_from, created_at
             FROM blocks WHERE created_at >= ?1",
        )
        .map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_13, e = e))?;
    let rows = stmt
        .query_map([since], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, i64>(7)?,
            ))
        })
        .map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_14, e = e))?;
    for row in rows {
        let (id, task_id, start_at, end_at, layer, final_status, postponed_from, created_at) =
            row.map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_15, e = e))?;
        let day = local_day_start(start_at);
        let wk = week_start_of(day);
        b.by_id.insert(
            id,
            BlockFact {
                task_id: task_id.clone(),
                start_at,
                end_at,
                layer: layer.clone(),
                final_status,
                postponed_from,
                created_at,
            },
        );
        b.week_days.entry(wk).or_default().insert(day);
        *b.week_count.entry(wk).or_insert(0) += 1;
        let daylight = (6..18).contains(&local_hour(start_at));
        b.week_daylight
            .entry(wk)
            .and_modify(|v| *v = *v && daylight)
            .or_insert(daylight);
        b.day_starts.entry(day).or_default().push(start_at);
        let mins = local_hour(start_at) * 60 + local_minute(start_at);
        b.hhmm_days.entry(mins).or_default().insert(day);
        b.task_day.entry((task_id, day)).or_default().push(created_at);
        let bit = if layer == "required" {
            F_LAYER_REQUIRED
        } else {
            F_LAYER_ELASTIC
        };
        *b.week_layer_bits.entry(wk).or_insert(0) |= bit;
    }
    Ok(b)
}

struct TaskFact {
    id: String,
    title: String,
    category: Option<String>,
    sanity_exempt: bool,
    created_at: i64,
}

fn collect_tasks(conn: &Connection, since: i64) -> Result<Vec<TaskFact>, String> {
    let mut stmt = conn
        .prepare("SELECT id, title, category, sanity_exempt, created_at FROM tasks WHERE created_at >= ?1")
        .map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_16, e = e))?;
    let rows = stmt
        .query_map([since], |r| {
            Ok(TaskFact {
                id: r.get(0)?,
                title: r.get(1)?,
                category: r.get(2)?,
                sanity_exempt: r.get::<_, i64>(3)? != 0,
                created_at: r.get(4)?,
            })
        })
        .map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_17, e = e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_18, e = e))
}

struct SeqFacts {
    max_len: u32,
    max_len_at: Option<i64>,
}

fn collect_sequences(conn: &Connection, since: i64) -> Result<SeqFacts, String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.created_at, COUNT(m.block_id) FROM sequences s
             LEFT JOIN sequence_members m ON m.sequence_id = s.id
             WHERE s.created_at >= ?1
             GROUP BY s.id",
        )
        .map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_19, e = e))?;
    let rows = stmt
        .query_map([since], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_20, e = e))?;
    let mut facts = SeqFacts {
        max_len: 0,
        max_len_at: None,
    };
    for row in rows {
        let (created_at, len) = row.map_err(|e| tf!(i18n::msg::ACH_ACHIEVEMENTS_21, e = e))?;
        let len = len.max(0) as u32;
        if len > facts.max_len {
            facts.max_len = len;
            facts.max_len_at = Some(created_at);
        }
    }
    Ok(facts)
}

// ---------------------------------------------------------------- 本地时间小工具

fn local_hour(ts: i64) -> u32 {
    Local.timestamp_opt(ts, 0)
        .single()
        .map(|d| d.hour())
        .unwrap_or(0)
}

fn local_minute(ts: i64) -> u32 {
    Local.timestamp_opt(ts, 0)
        .single()
        .map(|d| d.minute())
        .unwrap_or(0)
}

/// 周一 = 0 … 周日 = 6
fn local_weekday(ts: i64) -> u32 {
    Local.timestamp_opt(ts, 0)
        .single()
        .map(|d| d.weekday().num_days_from_monday())
        .unwrap_or(0)
}

fn local_md(ts: i64) -> (u32, u32) {
    Local
        .timestamp_opt(ts, 0)
        .single()
        .map(|d| (d.month(), d.day()))
        .unwrap_or((0, 0))
}

fn local_month_start(ts: i64) -> i64 {
    let Some(dt) = Local.timestamp_opt(ts, 0).single() else {
        return ts;
    };
    let Some(naive) = NaiveDate::from_ymd_opt(dt.year(), dt.month(), 1).and_then(|d| d.and_hms_opt(0, 0, 0)) else {
        return ts;
    };
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|d| d.timestamp())
        .unwrap_or(ts)
}

fn local_month_add(month_start: i64, months: i64) -> i64 {
    let Some(dt) = Local.timestamp_opt(month_start, 0).single() else {
        return month_start;
    };
    let Some(next) = NaiveDate::from_ymd_opt(dt.year(), dt.month(), 1)
        .and_then(|d| d.checked_add_months(Months::new(months as u32)))
    else {
        return month_start;
    };
    let Some(naive) = next.and_hms_opt(0, 0, 0) else {
        return month_start;
    };
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|d| d.timestamp())
        .unwrap_or(month_start)
}

// ---------------------------------------------------------------- 取数小工具

fn times(m: &Metrics, key: CountKey) -> &[i64] {
    m.times.get(&key).map(|v| v.as_slice()).unwrap_or(&[])
}

fn count_vec(v: &[i64], target: u32) -> (u32, Option<i64>) {
    let n = v.len() as u32;
    let hit = if n == 0 {
        None
    } else if target > 0 {
        v.get((target - 1) as usize).copied()
    } else {
        Some(v[0])
    };
    let progress = if target > 0 {
        n.min(target)
    } else if n > 0 {
        1
    } else {
        0
    };
    (progress, hit)
}

/// 移动与拉伸合数（反复横跳）；其余按类型单数
fn count_value(m: &Metrics, key: CountKey, target: u32) -> (u32, Option<i64>) {
    if key == CountKey::Move {
        let mut v: Vec<i64> = times(m, CountKey::Move).to_vec();
        v.extend_from_slice(times(m, CountKey::Stretch));
        v.sort_unstable();
        count_vec(&v, target)
    } else {
        count_vec(times(m, key), target)
    }
}

fn sorted_days(m: &Metrics) -> Vec<i64> {
    let mut v: Vec<i64> = m.active_days.iter().copied().collect();
    v.sort_unstable();
    v
}

fn day_streak(days: &[i64], target: u32) -> (u32, Option<i64>) {
    let mut best = 0u32;
    let mut cur = 0u32;
    let mut prev: Option<i64> = None;
    let mut hit: Option<i64> = None;
    for &day in days {
        cur = match prev {
            Some(p) if local_day_add(p, 1) == day => cur + 1,
            _ => 1,
        };
        if hit.is_none() && target > 0 && cur >= target {
            hit = Some(day);
        }
        best = best.max(cur);
        prev = Some(day);
    }
    (best, hit)
}

fn month_streak(months: &[i64], target: u32) -> (u32, Option<i64>) {
    let mut best = 0u32;
    let mut cur = 0u32;
    let mut prev: Option<i64> = None;
    let mut hit: Option<i64> = None;
    for &mon in months {
        cur = match prev {
            Some(p) if local_month_add(p, 1) == mon => cur + 1,
            _ => 1,
        };
        if hit.is_none() && target > 0 && cur >= target {
            hit = Some(mon);
        }
        best = best.max(cur);
        prev = Some(mon);
    }
    (best, hit)
}

fn hour_any(map: &HashMap<u32, i64>, from: u8, to: u8) -> (u32, Option<i64>) {
    let hit = (from..=to).filter_map(|h| map.get(&(h as u32)).copied()).min();
    (if hit.is_some() { 1 } else { 0 }, hit)
}

fn bool_hit(v: Option<i64>) -> (u32, Option<i64>) {
    (if v.is_some() { 1 } else { 0 }, v)
}

fn complete_day_streak(m: &Metrics, per_day: u32, hours: Option<(u8, u8)>, target: u32) -> (u32, Option<i64>) {
    let mut days: HashSet<i64> = HashSet::new();
    match hours {
        Some((from, to)) => {
            for h in from..=to {
                if let Some(set) = m.complete_hour_days.get(&(h as u32)) {
                    days.extend(set.iter().copied());
                }
            }
        }
        None => {
            for (&d, &c) in &m.complete_per_day {
                if c >= per_day {
                    days.insert(d);
                }
            }
        }
    }
    let mut v: Vec<i64> = days.into_iter().collect();
    v.sort_unstable();
    day_streak(&v, target)
}

fn same_time_streak(b: &BlockFacts, target: u32) -> (u32, Option<i64>) {
    let mut best = 0u32;
    let mut hit: Option<i64> = None;
    for days in b.hhmm_days.values() {
        let mut v: Vec<i64> = days.iter().copied().collect();
        v.sort_unstable();
        let (n, h) = day_streak(&v, target);
        if n > best {
            best = n;
        }
        if hit.is_none() {
            hit = h;
        }
    }
    (best, hit)
}

fn sunday_next_week(b: &BlockFacts) -> (u32, Option<i64>) {
    for f in b.by_id.values() {
        if local_weekday(f.created_at) == 6
            && week_start_of(local_day_start(f.start_at)) > week_start_of(local_day_start(f.created_at))
        {
            return (1, Some(f.created_at));
        }
    }
    (0, None)
}

fn week_done_no_miss(m: &Metrics, min_done: u32) -> (u32, Option<i64>) {
    let mut weeks: Vec<(i64, (u32, u32))> = m.weekly.iter().map(|(&k, &v)| (k, v)).collect();
    weeks.sort_by_key(|(k, _)| *k);
    for (wk, (done, missed)) in weeks {
        if done >= min_done && missed == 0 {
            return (1, Some(local_day_add(wk, 3)));
        }
    }
    (0, None)
}

fn consecutive_perfect_weeks(m: &Metrics, min_done: u32, target: u32) -> (u32, Option<i64>) {
    let mut weeks: Vec<i64> = m
        .weekly
        .iter()
        .filter(|(_, &(d, miss))| d >= min_done && miss == 0)
        .map(|(&k, _)| k)
        .collect();
    weeks.sort_unstable();
    let mut best = 0u32;
    let mut cur = 0u32;
    let mut prev: Option<i64> = None;
    let mut hit: Option<i64> = None;
    for wk in weeks {
        cur = match prev {
            Some(p) if local_day_add(p, 7) == wk => cur + 1,
            _ => 1,
        };
        if hit.is_none() && target > 0 && cur >= target {
            hit = Some(wk);
        }
        best = best.max(cur);
        prev = Some(wk);
    }
    (best, hit)
}

fn month_done_no_miss(m: &Metrics, min_done: u32) -> (u32, Option<i64>) {
    let mut months: Vec<(i64, (u32, u32))> = m.monthly.iter().map(|(&k, &v)| (k, v)).collect();
    months.sort_by_key(|(k, _)| *k);
    let mut best = 0u32;
    let mut hit: Option<i64> = None;
    for (mon, (done, missed)) in months {
        if missed == 0 && done >= min_done {
            if hit.is_none() {
                hit = Some(mon);
            }
            best = best.max(done);
        }
    }
    (best, hit)
}

fn flip_flop(m: &Metrics, target: u32) -> (u32, Option<i64>) {
    let mut counts: HashMap<(String, i64), u32> = HashMap::new();
    let mut best = 0u32;
    let mut hit: Option<i64> = None;
    for ev in &m.moves {
        let day = local_day_start(ev.at);
        let e = counts.entry((ev.block.clone(), day)).or_insert(0);
        *e += 1;
        best = best.max(*e);
        if hit.is_none() && target > 0 && *e >= target {
            hit = Some(ev.at);
        }
    }
    (best, hit)
}

fn gap_after(m: &Metrics, min_days: u32) -> (u32, Option<i64>) {
    let days = sorted_days(m);
    for w in days.windows(2) {
        let gap = ((w[1] - w[0]) as f64 / 86400.0).round() as i64;
        if gap >= min_days as i64 {
            return (1, Some(w[1]));
        }
    }
    (0, None)
}

fn full_week(b: &BlockFacts, target: u32) -> (u32, Option<i64>) {
    let mut weeks: Vec<(i64, usize)> = b.week_days.iter().map(|(&k, v)| (k, v.len())).collect();
    weeks.sort_by_key(|(k, _)| *k);
    let mut best = 0u32;
    let mut hit: Option<i64> = None;
    for (wk, days) in weeks {
        let n = days as u32;
        best = best.max(n);
        if hit.is_none() && target > 0 && n >= target {
            hit = Some(wk);
        }
    }
    (best, hit)
}

fn same_task_day(b: &BlockFacts, target: u32) -> (u32, Option<i64>) {
    let mut best = 0u32;
    let mut hit: Option<i64> = None;
    for v in b.task_day.values() {
        let n = v.len() as u32;
        best = best.max(n);
        if hit.is_none() && target > 0 && n >= target {
            let mut s = v.clone();
            s.sort_unstable();
            hit = Some(s[(target - 1) as usize]);
        }
    }
    (best, hit)
}

fn move_span(m: &Metrics, min_weeks: i64, forward_only: bool) -> (u32, Option<i64>) {
    for ev in &m.moves {
        if let (Some(from), Some(to)) = (ev.from, ev.to) {
            let wf = week_start_of(local_day_start(from));
            let wt = week_start_of(local_day_start(to));
            let diff = ((wt - wf) as f64 / 604800.0).round() as i64;
            let hit = if forward_only { diff >= min_weeks } else { diff.abs() >= min_weeks };
            if hit {
                return (1, Some(ev.at));
            }
        }
    }
    (0, None)
}

fn daylight_week(b: &BlockFacts, min_blocks: u32) -> (u32, Option<i64>) {
    let mut best = 0u32;
    let mut hit: Option<i64> = None;
    for (&wk, &count) in &b.week_count {
        if count < min_blocks {
            continue;
        }
        if b.week_daylight.get(&wk).copied().unwrap_or(false) {
            if hit.is_none() {
                hit = Some(local_day_add(wk, 3));
            }
            best = best.max(count);
        }
    }
    (best, hit)
}

fn blank_week(b: &BlockFacts, m: &Metrics, now: i64) -> (u32, Option<i64>) {
    let Some(first) = m.first_event else {
        return (0, None);
    };
    let first_week = week_start_of(local_day_start(first));
    let current_week = week_start_of(local_day_start(now));
    let mut wk = local_day_add(first_week, 7);
    while wk < current_week {
        if b.week_count.get(&wk).copied().unwrap_or(0) == 0 {
            return (1, Some(wk));
        }
        wk = local_day_add(wk, 7);
    }
    (0, None)
}

fn free_weekend(b: &BlockFacts, m: &Metrics, now: i64) -> (u32, Option<i64>) {
    let Some(first) = m.first_event else {
        return (0, None);
    };
    let first_week = week_start_of(local_day_start(first));
    let current_week = week_start_of(local_day_start(now));
    let empty = HashSet::new();
    let mut wk = local_day_add(first_week, 7);
    while wk < current_week {
        let days = b.week_days.get(&wk).unwrap_or(&empty);
        let sat = local_day_add(wk, 5);
        let sun = local_day_add(wk, 6);
        if !days.contains(&sat) && !days.contains(&sun) {
            return (1, Some(sat));
        }
        wk = local_day_add(wk, 7);
    }
    (0, None)
}

fn balanced_day(m: &Metrics, b: &BlockFacts, per_layer: u32) -> (u32, Option<i64>) {
    let mut per_day: HashMap<i64, (u32, u32)> = HashMap::new();
    let mut best = 0u32;
    let mut hit: Option<i64> = None;
    for (at, block_id) in &m.completed_blocks {
        let Some(f) = b.by_id.get(block_id) else {
            continue;
        };
        let day = local_day_start(*at);
        let e = per_day.entry(day).or_insert((0, 0));
        if f.layer == "required" {
            e.0 += 1;
        } else {
            e.1 += 1;
        }
        if e.0 >= per_layer && e.1 >= per_layer && hit.is_none() {
            hit = Some(*at);
        }
        best = best.max(e.0.min(e.1));
    }
    (best, hit)
}

fn week_distinct_tasks(m: &Metrics, b: &BlockFacts, target: u32) -> (u32, Option<i64>) {
    let mut per_week: HashMap<i64, HashSet<String>> = HashMap::new();
    let mut best = 0u32;
    let mut hit: Option<i64> = None;
    for (at, block_id) in &m.completed_blocks {
        let Some(f) = b.by_id.get(block_id) else {
            continue;
        };
        let set = per_week.entry(week_start_of(local_day_start(*at))).or_default();
        set.insert(f.task_id.clone());
        best = best.max(set.len() as u32);
        if hit.is_none() && target > 0 && set.len() as u32 >= target {
            hit = Some(*at);
        }
    }
    (best, hit)
}

fn max_day_blocks<F: Fn(i64, &[i64]) -> u32>(b: &BlockFacts, target: u32, count: F) -> (u32, Option<i64>) {
    let mut best = 0u32;
    let mut hit: Option<i64> = None;
    for (&day, starts) in &b.day_starts {
        let n = count(day, starts);
        best = best.max(n);
        if hit.is_none() && target > 0 && n >= target {
            hit = Some(day);
        }
    }
    (best, hit)
}

fn week_six_elements(m: &Metrics, b: &BlockFacts) -> (u32, Option<i64>) {
    let mut weeks: HashSet<i64> = m.week_flags.keys().copied().collect();
    weeks.extend(b.week_layer_bits.keys().copied());
    for wk in weeks {
        let bits = m.week_flags.get(&wk).copied().unwrap_or(0) | b.week_layer_bits.get(&wk).copied().unwrap_or(0);
        if bits & F_ALL_SIX == F_ALL_SIX {
            return (1, Some(local_day_add(wk, 3)));
        }
    }
    (0, None)
}

fn create_burst(m: &Metrics, window: i64, target: u32) -> (u32, Option<i64>) {
    let c = &m.creates;
    let mut best = 0u32;
    let mut hit: Option<i64> = None;
    let mut j = 0usize;
    for i in 0..c.len() {
        if j < i {
            j = i;
        }
        while j < c.len() && c[j] - c[i] <= window {
            j += 1;
        }
        let n = (j - i) as u32;
        best = best.max(n);
        if hit.is_none() && target > 0 && n >= target {
            hit = Some(c[i + target as usize - 1]);
        }
    }
    (best, hit)
}

fn create_per_day(m: &Metrics, target: u32) -> (u32, Option<i64>) {
    let mut best = 0u32;
    let mut hit: Option<i64> = None;
    for v in m.creates_per_day.values() {
        let n = v.len() as u32;
        best = best.max(n);
        if hit.is_none() && target > 0 && n >= target {
            let mut s = v.clone();
            s.sort_unstable();
            hit = Some(s[(target - 1) as usize]);
        }
    }
    (best, hit)
}

fn category_count(tasks: &[TaskFact], target: u32) -> (u32, Option<i64>) {
    let mut entries: Vec<(String, i64)> = tasks
        .iter()
        .filter_map(|t| {
            t.category
                .as_ref()
                .filter(|c| !c.trim().is_empty())
                .map(|c| (c.clone(), t.created_at))
        })
        .collect();
    entries.sort_by_key(|(_, at)| *at);
    let mut seen: Vec<String> = Vec::new();
    let mut hit: Option<i64> = None;
    for (c, at) in entries {
        if !seen.iter().any(|s| s == &c) {
            seen.push(c);
            if hit.is_none() && seen.len() as u32 >= target.max(1) {
                hit = Some(at);
            }
        }
    }
    let n = seen.len() as u32;
    let progress = if target > 0 { n.min(target) } else if n > 0 { 1 } else { 0 };
    (progress, hit)
}

fn all_categories(tasks: &[TaskFact], b: &BlockFacts, min_cats: u32, min_blocks: u32, now: i64) -> (u32, Option<i64>) {
    let mut cats: Vec<String> = tasks
        .iter()
        .filter_map(|t| t.category.clone().filter(|c| !c.trim().is_empty()))
        .collect();
    cats.sort();
    cats.dedup();
    if (cats.len() as u32) < min_cats {
        return (cats.len() as u32, None);
    }
    let task_by_id: HashMap<&str, &TaskFact> = tasks.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut counts: HashMap<String, u32> = HashMap::new();
    for f in b.by_id.values() {
        let Some(t) = task_by_id.get(f.task_id.as_str()) else {
            continue;
        };
        if let Some(c) = t.category.as_ref().filter(|c| !c.trim().is_empty()) {
            *counts.entry(c.clone()).or_insert(0) += 1;
        }
    }
    let ok = cats
        .iter()
        .filter(|c| counts.get(*c).copied().unwrap_or(0) >= min_blocks)
        .count() as u32;
    if ok == cats.len() as u32 {
        (ok, Some(now))
    } else {
        (ok, None)
    }
}

fn boomerang(b: &BlockFacts) -> (u32, Option<i64>) {
    for f in b.by_id.values() {
        if let Some(pid) = &f.postponed_from {
            if let Some(parent) = b.by_id.get(pid) {
                if parent.start_at == f.start_at {
                    return (1, Some(f.created_at));
                }
            }
        }
    }
    (0, None)
}

fn drift_depth(b: &BlockFacts, min_depth: u32) -> (u32, Option<i64>) {
    let mut best = 0u32;
    let mut hit: Option<i64> = None;
    for f in b.by_id.values() {
        let mut depth = 0u32;
        let mut cur = f;
        let mut last = f;
        let mut guard = 0u32;
        while let Some(pid) = &cur.postponed_from {
            guard += 1;
            if guard > 64 {
                break;
            }
            let Some(parent) = b.by_id.get(pid) else {
                break;
            };
            depth += 1;
            last = parent;
            cur = parent;
        }
        best = best.max(depth);
        if hit.is_none() && min_depth > 0 && depth >= min_depth {
            hit = Some(last.created_at);
        }
    }
    (best, hit)
}

fn birthday(m: &Metrics, days: u32, active_within: u32, now: i64) -> (u32, Option<i64>) {
    let (Some(first), Some(last)) = (m.first_event, m.last_event) else {
        return (0, None);
    };
    let used_enough = now - first >= (days as i64) * 86400;
    let still_active = now - last <= (active_within as i64) * 86400;
    if used_enough && still_active {
        (1, Some(now))
    } else {
        (0, None)
    }
}

// ---------------------------------------------------------------- 一条定义的值

fn value_of(
    def: &Def,
    m: &Metrics,
    b: &BlockFacts,
    tasks: &[TaskFact],
    seq: &SeqFacts,
    now: i64,
) -> (u32, Option<i64>) {
    let target = def.target;
    let (progress, hit) = match def.rule {
        Rule::Count(key) => count_value(m, key, target),
        Rule::Minutes => {
            let mut cum = 0i64;
            let mut hit = None;
            for (at, minutes) in &m.complete_minutes {
                cum += minutes;
                if hit.is_none() && target > 0 && cum >= target as i64 {
                    hit = Some(*at);
                }
            }
            (m.minutes_total.min(target as i64) as u32, hit)
        }
        Rule::ActiveDays => {
            let days = sorted_days(m);
            let n = days.len() as u32;
            let hit = if target > 0 && n >= target {
                days.get((target - 1) as usize).copied()
            } else {
                None
            };
            (n.min(target), hit)
        }
        Rule::DayStreak => day_streak(&sorted_days(m), target),
        Rule::MonthStreak => {
            let mut months: Vec<i64> = m.active_days.iter().map(|d| local_month_start(*d)).collect();
            months.sort_unstable();
            months.dedup();
            month_streak(&months, target)
        }
        Rule::CompleteDayStreak { per_day, hours } => complete_day_streak(m, per_day, hours, target),
        Rule::HourAny { from, to } => hour_any(&m.event_hours, from, to),
        Rule::CompleteHours { from, to } => hour_any(&m.complete_hours, from, to),
        Rule::WeekendEvent => bool_hit(m.weekend_event),
        Rule::CrossYear => bool_hit(m.cross_year),
        Rule::SameTimeStreak => same_time_streak(b, target),
        Rule::SundayNextWeek => sunday_next_week(b),
        Rule::WeekDoneNoMiss { min_done } => week_done_no_miss(m, min_done),
        Rule::ConsecutivePerfectWeeks { min_done } => consecutive_perfect_weeks(m, min_done, target),
        Rule::MonthDoneNoMiss => month_done_no_miss(m, target),
        Rule::BlockSpanEq { seconds } => b
            .by_id
            .values()
            .find(|f| f.end_at - f.start_at == seconds)
            .map(|f| (1, Some(f.created_at)))
            .unwrap_or((0, None)),
        Rule::BlockLayerAny { layer } => b
            .by_id
            .values()
            .find(|f| f.layer == layer)
            .map(|f| (1, Some(f.created_at)))
            .unwrap_or((0, None)),
        Rule::TaskSanityExempt => tasks
            .iter()
            .find(|t| t.sanity_exempt)
            .map(|t| (1, Some(t.created_at)))
            .unwrap_or((0, None)),
        Rule::FlipFlopDaily => flip_flop(m, target),
        Rule::DriftDepth { min_depth } => drift_depth(b, min_depth),
        Rule::Boomerang => boomerang(b),
        Rule::GapAfter { min_days } => gap_after(m, min_days),
        Rule::FullWeek => full_week(b, target),
        Rule::SameTaskDay => same_task_day(b, target),
        Rule::FinalStatus { value } => b
            .by_id
            .values()
            .find(|f| f.final_status.as_deref() == Some(value))
            .map(|f| (1, Some(f.created_at)))
            .unwrap_or((0, None)),
        Rule::MoveSpanWeeks { min_weeks, forward_only } => move_span(m, min_weeks, forward_only),
        Rule::DaylightWeek { min_blocks } => daylight_week(b, min_blocks),
        Rule::FreeWeekend => free_weekend(b, m, now),
        Rule::BlankWeek => blank_week(b, m, now),
        Rule::BalancedDay => balanced_day(m, b, target.max(1)),
        Rule::FastComplete { max_minutes } => {
            let hit = m
                .complete_delays
                .iter()
                .find(|(_, d)| *d <= max_minutes as i64)
                .map(|(at, _)| *at);
            bool_hit(hit)
        }
        Rule::WeekDistinctTasks => week_distinct_tasks(m, b, target),
        Rule::WeekdayWorkBlocks => max_day_blocks(b, target, |day, starts| {
            if local_weekday(day) > 4 {
                0
            } else {
                starts.iter().filter(|&&s| (9..18).contains(&local_hour(s))).count() as u32
            }
        }),
        Rule::FridayBlocks => max_day_blocks(b, target, |day, starts| {
            if local_weekday(day) == 4 {
                starts.len() as u32
            } else {
                0
            }
        }),
        Rule::AllCategoriesWithBlocks { min_cats, min_blocks } => all_categories(tasks, b, min_cats, min_blocks, now),
        Rule::WeekSixElements => week_six_elements(m, b),
        Rule::CreateBurst { window } => create_burst(m, window, target),
        Rule::CreatePerDay => create_per_day(m, target),
        Rule::SequenceMaxLen { min_len } => {
            if seq.max_len >= min_len {
                (seq.max_len, seq.max_len_at)
            } else {
                (seq.max_len, None)
            }
        }
        Rule::TaskTitleMinLen { min_chars } => tasks
            .iter()
            .find(|t| t.title.chars().count() >= min_chars as usize)
            .map(|t| (1, Some(t.created_at)))
            .unwrap_or((0, None)),
        Rule::CategoryCount => category_count(tasks, target),
        Rule::Birthday { days, active_within } => birthday(m, days, active_within, now),
        Rule::Meta | Rule::Signal => (0, None),
    };
    if def.target == 0 {
        (if hit.is_some() { 1 } else { 0 }, hit)
    } else {
        (progress.min(def.target), hit)
    }
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, test_conn};
    use chrono::TimeZone;

    fn ts(y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        chrono::Local
            .with_ymd_and_hms(y, m, d, h, min, 0)
            .single()
            .expect("本地时间")
            .timestamp()
    }

    fn put_event(conn: &Connection, ty: &str, payload: Option<&str>, at: i64, block_id: &str) {
        conn.execute(
            "INSERT INTO events (id, block_id, event_type, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![uuid::Uuid::new_v4().to_string(), block_id, ty, payload, at],
        )
        .expect("插事件");
    }

    fn unlocked(conn: &Connection, id: &str) -> bool {
        load_state(conn)
            .expect("读状态")
            .get(id)
            .map(|(u, _)| u.is_some())
            .unwrap_or(false)
    }

    fn progress_of(conn: &Connection, id: &str) -> u32 {
        load_state(conn)
            .expect("读状态")
            .get(id)
            .map(|(_, p)| *p)
            .unwrap_or(0)
    }

    #[test]
    fn test_list_has_rows_for_default_build() {
        // round85：唯一版本 —— 列表恒可用（以前这里用 `compiled()` 区分 Lite 档，已取消）
        let conn = test_conn();
        let payload = list(&conn).expect("列表");
        assert!(!payload.rows.is_empty(), "默认构建（唯一版本）要有成就条目");
    }

    #[test]
    fn test_default_on_and_first_backfill_is_silent() {
        let conn = test_conn();
        let task = db::create_task(&conn, "任务", None).expect("建任务");
        let block = db::create_block(&conn, &task.id, ts(2026, 1, 5, 9, 0), ts(2026, 1, 5, 10, 0))
            .expect("建块");
        for i in 0..10 {
            put_event(
                &conn,
                "complete",
                Some(r#"{"minutes":30}"#),
                ts(2026, 1, 5, 10, i),
                &block.id,
            );
        }
        assert!(enabled(&conn), "缺省应默认开");

        let newly = evaluate(&conn, ts(2026, 1, 5, 12, 0)).expect("求值");
        assert!(newly.is_empty(), "首次全量回溯必须静默（不弹任何提示）");
        assert!(initialized(&conn), "回溯后置 initialized");
        assert!(unlocked(&conn, "first_block"), "过去的块要静默补点亮");
        assert!(unlocked(&conn, "done_10"), "过去的 10 次完成也要补上");

        // 之后的新达成才返回 newly
        put_event(&conn, "skip", None, ts(2026, 1, 5, 13, 0), &block.id);
        let newly2 = evaluate(&conn, ts(2026, 1, 5, 13, 1)).expect("求值");
        assert!(
            newly2.iter().any(|n| n.id == "sorry_today"),
            "首次之后的解锁要返回 newly（供前端弹提示）"
        );
    }

    /// round79（78-11）：重置成就 —— ①清空 + ②挪计分起点 + ③不能再按历史复活。
    /// 「不复活」是这条的核心：只清表的假重置在这里就会红（下次求值按全史又全亮）。
    #[test]
    fn test_reset_clears_and_never_resurrects_from_history() {
        let conn = test_conn();
        let task = db::create_task(&conn, "任务", None).expect("建任务");
        let block = db::create_block(&conn, &task.id, ts(2026, 1, 5, 9, 0), ts(2026, 1, 5, 10, 0))
            .expect("建块");
        put_event(&conn, "complete", Some(r#"{"minutes":30}"#), ts(2026, 1, 5, 10, 0), &block.id);
        // 把「历史」的时间全拨到过去（块 / 任务 / 事件）——
        // 不然它们和重置线同秒 → `>=` 会把它们算进来（演示的是真实里「历史比线早」的形态）
        let old = ts(2026, 1, 5, 9, 0);
        conn.execute("UPDATE blocks SET created_at = ?1", [old]).expect("拨旧块");
        conn.execute("UPDATE tasks SET created_at = ?1", [old]).expect("拨旧任务");
        conn.execute("UPDATE events SET created_at = ?1", [old]).expect("拨旧事件");
        evaluate(&conn, ts(2026, 1, 5, 12, 0)).expect("求值");
        assert!(unlocked(&conn, "first_block"), "历史上有块 → 点亮");
        assert!(unlocked(&conn, "first_done"), "历史上完成过 → 点亮");
        assert_eq!(reset_at(&conn), 0, "没重置过 → 0（全史 = 旧行为）");

        reset(&conn).expect("重置");
        assert!(reset_at(&conn) > 0, "重置要写下时间界");
        assert!(initialized(&conn), "重置后仍是已初始化（不走首启静默）");
        assert!(
            load_state(&conn).expect("读状态").is_empty(),
            "重置后成就表应该是空的"
        );
        // 关键：再求值不能按历史复活
        let newly = evaluate(&conn, db::now()).expect("求值");
        assert!(
            newly.is_empty(),
            "重置后不该冒出一堆解锁：{:?}",
            newly.iter().map(|n| n.id).collect::<Vec<_>>()
        );
        assert!(!unlocked(&conn, "first_block"), "历史块不再计入（这就是「重新挣」）");
        assert!(!unlocked(&conn, "first_done"));

        // 重置之后的新活动照常点亮（成就没被关掉）
        let fresh = db::create_block(&conn, &task.id, ts(2026, 1, 6, 9, 0), ts(2026, 1, 6, 10, 0))
            .expect("建新块");
        assert!(fresh.created_at >= reset_at(&conn), "新块的 created_at 在线之后");
        evaluate(&conn, db::now()).expect("求值");
        assert!(unlocked(&conn, "first_block"), "线之后新建的块要重新点亮");
        assert!(!unlocked(&conn, "first_done"), "没做过的事不该连带点亮");
        assert_eq!(progress_of(&conn, "done_10"), 0, "进度也从头开始");
    }

    #[test]
    fn test_disabled_does_nothing() {
        let conn = test_conn();
        let task = db::create_task(&conn, "任务", None).expect("建任务");
        db::create_block(&conn, &task.id, ts(2026, 1, 5, 9, 0), ts(2026, 1, 5, 10, 0)).expect("建块");
        db::set_setting(&conn, SETTING_KEY, "0").expect("关开关");
        assert!(!enabled(&conn));

        let newly = evaluate(&conn, ts(2026, 1, 5, 12, 0)).expect("求值");
        assert!(newly.is_empty());
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM achievements", [], |r| r.get(0))
            .expect("计数");
        assert_eq!(count, 0, "关掉时一颗也不能落库");
        // 信号也是空操作
        note(&conn, "undo").expect("信号");
        let count2: i64 = conn
            .query_row("SELECT COUNT(*) FROM achievements", [], |r| r.get(0))
            .expect("计数");
        assert_eq!(count2, 0);
    }

    /// 与 `stats::summary` 对账：同一 fixture、计数必须一致（防止两份口径漂移）。
    /// 例外：`created_temp` —— stats 把 template 也算 temp；我们把「临时安排块」单独算，
    /// 所以对账的是 `CreateTemp + CreateTemplate == stats.created_temp`。
    #[test]
    fn test_counters_mirror_stats() {
        let conn = test_conn();
        let task = db::create_task(&conn, "任务", None).expect("建任务");
        let b1 = db::create_block(&conn, &task.id, ts(2026, 1, 5, 9, 0), ts(2026, 1, 5, 10, 0))
            .expect("建块")
            .id;
        let b2 = db::create_block(&conn, &task.id, ts(2026, 1, 6, 9, 0), ts(2026, 1, 6, 10, 0))
            .expect("建块")
            .id;
        let t = ts(2026, 1, 5, 12, 0);
        put_event(&conn, "create", Some(r#"{"temp":true}"#), t, &b1);
        put_event(&conn, "create", Some(r#"{"temp":true,"template":true}"#), t + 1, &b1);
        put_event(&conn, "create", Some(r#"{"temp":false}"#), t + 2, &b1);
        put_event(
            &conn,
            "move",
            Some(r#"{"from":1,"to":2,"end_from":3,"end_to":3}"#),
            t + 3,
            &b1,
        );
        put_event(
            &conn,
            "move",
            Some(r#"{"from":1,"to":1,"end_from":3,"end_to":5}"#),
            t + 4,
            &b1,
        );
        put_event(
            &conn,
            "move",
            Some(r#"{"from":1,"to":2,"end_from":3,"end_to":4,"cascade":true}"#),
            t + 5,
            &b1,
        );
        put_event(&conn, "postpone", Some(r#"{"from":1,"to":2}"#), t + 6, &b1);
        put_event(
            &conn,
            "postpone",
            Some(r#"{"from":1,"to":2,"cascade":true}"#),
            t + 7,
            &b1,
        );
        put_event(&conn, "link", Some(r#"{"after":"x"}"#), t + 8, &b1);
        put_event(
            &conn,
            "link",
            Some(r#"{"cascade":true}"#),
            t + 9,
            &b1,
        );
        put_event(&conn, "complete", Some(r#"{"minutes":30}"#), t + 10, &b1);
        put_event(&conn, "complete", Some(r#"{"minutes":45}"#), t + 11, &b2);
        put_event(&conn, "skip", None, t + 12, &b1);
        put_event(&conn, "merge", Some(r#"{"eaten":"z"}"#), t + 13, &b1);
        put_event(&conn, "delete", Some(r#"{"count":2}"#), t + 14, &b2);

        let s = crate::stats::summary(&conn, ts(2026, 1, 7, 0, 0), 12, 0).expect("统计");
        let m = collect_metrics(&conn, 0).expect("指标");
        let n = |k: CountKey| times(&m, k).len() as u32;
        assert_eq!(n(CountKey::Create), s.created);
        assert_eq!(n(CountKey::CreateTemp) + n(CountKey::CreateTemplate), s.created_temp);
        assert_eq!(n(CountKey::Complete), s.complete);
        assert_eq!(n(CountKey::Skip), s.skip);
        assert_eq!(n(CountKey::Merge), s.merged);
        assert_eq!(n(CountKey::Link), s.linked);
        assert_eq!(n(CountKey::Postpone), s.postponed);
        assert_eq!(n(CountKey::Move) + n(CountKey::Stretch), s.moved + s.stretched);
        assert_eq!(m.minutes_total, s.done_minutes);
        assert_eq!(n(CountKey::Create), 5, "3 条手插 + 2 条真建块");
    }

    #[test]
    fn test_progress_and_question_marks() {
        let conn = test_conn();
        let task = db::create_task(&conn, "任务", None).expect("建任务");
        let block = db::create_block(&conn, &task.id, ts(2026, 1, 5, 9, 0), ts(2026, 1, 5, 10, 0))
            .expect("建块")
            .id;
        for i in 0..5 {
            put_event(&conn, "complete", None, ts(2026, 1, 5, 10, i), &block);
        }
        evaluate(&conn, ts(2026, 1, 5, 12, 0)).expect("首启回溯");
        let payload = list(&conn).expect("列表");
        let row = payload.rows.iter().find(|r| r.id == "done_10").expect("done_10 行");
        assert!(!row.unlocked);
        assert_eq!(row.progress, 5, "进度要真实（5/10）");
        assert_eq!(row.target, 10);
        assert_eq!(row.name, "???", "未点亮不给名字");
        assert_eq!(row.desc, "???");
        assert_eq!(row.cond, "完成 10 次", "条件要可见");
        assert!(!payload.rows.iter().any(|r| r.id == "panel_first"), "隐藏档点亮前不出现");
    }

    #[test]
    fn test_hidden_appears_after_unlock() {
        let conn = test_conn();
        note(&conn, "panel").expect("信号");
        assert!(unlocked(&conn, "panel_first"));
        let payload = list(&conn).expect("列表");
        let row = payload.rows.iter().find(|r| r.id == "panel_first").expect("点亮后出现");
        assert_eq!(row.name, "对暗号的人");
        assert!(row.hidden);
    }

    #[test]
    fn test_undo_signal_counts_and_caps() {
        let conn = test_conn();
        for _ in 0..5 {
            note(&conn, "undo").expect("信号");
        }
        assert!(unlocked(&conn, "undo_first"));
        assert!(unlocked(&conn, "hom_undo5"), "撤销 5 次");
        assert!(!unlocked(&conn, "undo_100"));
        assert_eq!(progress_of(&conn, "undo_100"), 5, "计数存表");
        assert!(note(&conn, "nope").is_err(), "未知信号要报错");
    }

    #[test]
    fn test_streak_survives_gap() {
        let conn = test_conn();
        let task = db::create_task(&conn, "任务", None).expect("建任务");
        let block = db::create_block(&conn, &task.id, ts(2026, 1, 5, 9, 0), ts(2026, 1, 5, 10, 0))
            .expect("建块")
            .id;
        for d in 5..=11 {
            put_event(&conn, "complete", None, ts(2026, 1, d, 10, 0), &block);
        }
        evaluate(&conn, ts(2026, 1, 12, 0, 0)).expect("首启回溯");
        assert!(unlocked(&conn, "daily_7"));
        // 断一段再回来：已点亮的不清零，进度取历史最长
        for d in 20..=22 {
            put_event(&conn, "complete", None, ts(2026, 1, d, 10, 0), &block);
        }
        evaluate(&conn, ts(2026, 1, 23, 0, 0)).expect("求值");
        assert!(unlocked(&conn, "daily_7"), "断了不惩罚：已点亮不撤回");
        assert_eq!(progress_of(&conn, "daily_7"), 7, "进度取历史最长连续段");
    }

    #[test]
    fn test_unlock_survives_snapshot_restore() {
        let conn = test_conn();
        let task = db::create_task(&conn, "任务", None).expect("建任务");
        let before = db::dump_tables(&conn).expect("快照");
        db::create_block(&conn, &task.id, ts(2026, 1, 5, 9, 0), ts(2026, 1, 5, 10, 0)).expect("建块");
        evaluate(&conn, ts(2026, 1, 5, 12, 0)).expect("回溯");
        assert!(unlocked(&conn, "first_block"));
        db::restore_tables(&conn, &before).expect("回滚");
        assert!(unlocked(&conn, "first_block"), "Ctrl+Z 不回退徽章（不在快照表）");
    }

    #[test]
    fn test_meta_unlocks_at_threshold() {
        let conn = test_conn();
        let t = ts(2026, 1, 5, 12, 0);
        let mut n = 0;
        for def in DEFS {
            if matches!(def.rule, Rule::Meta | Rule::Signal) {
                continue;
            }
            if n == 10 {
                break;
            }
            conn.execute(
                "INSERT INTO achievements (id, unlocked_at, progress) VALUES (?1, ?2, 0)",
                rusqlite::params![def.id, t],
            )
            .expect("插行");
            n += 1;
        }
        evaluate(&conn, t).expect("求值");
        assert!(unlocked(&conn, "collect_10"), "点亮 10 枚要问门");
        assert!(!unlocked(&conn, "collect_30"));
    }

    /// 6b 复核（P1-2）：`final_status` 的真实值域是 `done_short` / `done_overtime`（NULL = 按时）——
    /// 这两个值必须真能点亮「马后炮」「遥遥领先」（旧写法用了库里不存在的 `late`/`early` → 永不可达）
    #[test]
    fn test_final_status_rules_reach_their_values() {
        let conn = test_conn();
        let task = db::create_task(&conn, "任务", None).expect("建任务");
        let a = db::create_block(&conn, &task.id, ts(2026, 1, 5, 9, 0), ts(2026, 1, 5, 10, 0))
            .expect("建块");
        conn.execute(
            "UPDATE blocks SET final_status = 'done_overtime' WHERE id = ?1",
            [&a.id],
        )
        .expect("改终态");
        evaluate(&conn, ts(2026, 1, 5, 12, 0)).expect("首启回溯");
        assert!(unlocked(&conn, "ma_hou_pao"), "done_overtime 该点亮马后炮");
        assert!(!unlocked(&conn, "hom_way_ahead"));

        let b = db::create_block(&conn, &task.id, ts(2026, 1, 6, 9, 0), ts(2026, 1, 6, 10, 0))
            .expect("建块");
        conn.execute("UPDATE blocks SET final_status = 'done_short' WHERE id = ?1", [&b.id])
            .expect("改终态");
        evaluate(&conn, ts(2026, 1, 6, 12, 0)).expect("求值");
        assert!(unlocked(&conn, "hom_way_ahead"), "done_short 该点亮遥遥领先");
    }

    /// B2 #9 / B1 #11：定义表全覆盖 —— 98 条、id 唯一、四串非空、条件串不含内部术语、三档都有。
    #[test]
    fn test_definition_table_integrity() {
        assert_eq!(DEFS.len(), 98, "首批 98 条");
        let mut ids = HashSet::new();
        let mut tiers = [0u32; 3];
        for def in DEFS {
            assert!(ids.insert(def.id), "id 重复：{}", def.id);
            let name = i18n::t(def.name);
            let desc = i18n::t(def.desc);
            let cond = i18n::t(def.cond);
            let group = i18n::t(def.group);
            assert!(!name.trim().is_empty(), "{} 名字空", def.id);
            assert!(!desc.trim().is_empty(), "{} 描述空", def.id);
            assert!(!cond.trim().is_empty(), "{} 条件空", def.id);
            assert!(!group.trim().is_empty(), "{} 分组空", def.id);
            assert!(def.tier <= 2, "{} tier 越界", def.id);
            assert!(
                !cond.contains("Rule::") && !cond.contains('_'),
                "{} 条件串像内部术语：{}",
                def.id,
                cond
            );
            tiers[def.tier as usize] += 1;
        }
        assert!(
            tiers[0] > 0 && tiers[1] > 0 && tiers[2] > 0,
            "三档都要有：{tiers:?}"
        );
    }

    /// 6b 复核（P1-6）：规则类总检 —— 一块 fixture 尽量把「库状态 / 时段 / 连续 / 串行」类都踩到。
    /// 每条只验「应点亮」；这是 `final_status` 那类「值域 / 标志写错但没人发现」的守门员。
    #[test]
    fn test_rule_kinds_reach_thresholds() {
        let conn = test_conn();
        let task = db::create_task(&conn, "任务", None).expect("建任务");
        db::create_task(&conn, "这是一个超过二十个字的任务名称需要来回数一数", None).expect("长名");
        conn.execute(
            "UPDATE tasks SET sanity_exempt = 1, category = '学习' WHERE id = ?1",
            [&task.id],
        )
        .expect("任务标记");
        // 分类大亨：10 个不同分类（含上面那个）
        for i in 0..9 {
            let t = db::create_task(&conn, &format!("分类任务{i}"), None).expect("建任务");
            conn.execute(
                "UPDATE tasks SET category = ?1 WHERE id = ?2",
                rusqlite::params![format!("类{i}"), t.id],
            )
            .expect("归类");
        }
        let ev = |ty: &str, at: i64, payload: Option<&str>, block: &str| {
            put_event(&conn, ty, payload, at, block);
        };

        // —— 块 fixture（2026-01-05 那周，全部白天 6–18）——
        let tiny = db::create_block(&conn, &task.id, ts(2026, 1, 5, 9, 0), ts(2026, 1, 5, 9, 15))
            .expect("块")
            .id;
        let req = db::create_block_with_layer(
            &conn,
            &task.id,
            ts(2026, 1, 5, 10, 0),
            ts(2026, 1, 5, 11, 0),
            "required",
            true,
        )
        .expect("块")
        .id;
        // 真爱：同一天同任务 5 块（45 分钟间隔、30 分钟长 → 不融合，避免假数据改测试）
        for i in 0..5 {
            let start = ts(2026, 1, 6, 9, 0) + i * 45 * 60;
            db::create_block(&conn, &task.id, start, start + 1800).expect("块");
        }
        // 满格 + 守株待兔：Mon..Sun 连续 7 天都是 13:00
        let week_task = db::create_task(&conn, "满格", None).expect("建任务");
        for d in 0..7 {
            db::create_block(
                &conn,
                &week_task.id,
                ts(2026, 1, 5 + d, 13, 0),
                ts(2026, 1, 5 + d, 13, 30),
            )
            .expect("块");
        }
        // 周五 8 块 9–18（不邻接 → 不融合）→ 星期五 + 打工人 + 赞美太阳（该周全白天 ≥10）
        let fri_task = db::create_task(&conn, "周五", None).expect("建任务");
        for h in [9, 10, 11, 12, 13, 14, 15, 16] {
            db::create_block(&conn, &fri_task.id, ts(2026, 1, 9, h, 0), ts(2026, 1, 9, h, 30))
                .expect("块");
        }
        // 未雨绸缪：周日建的块、start 在下周
        let sun = db::create_block(&conn, &task.id, ts(2026, 1, 12, 9, 0), ts(2026, 1, 12, 10, 0))
            .expect("块")
            .id;
        conn.execute(
            "UPDATE blocks SET created_at = ?1 WHERE id = ?2",
            rusqlite::params![ts(2026, 1, 11, 20, 0), sun],
        )
        .expect("改创建时间");
        // 回旋镖 + 漂流链 3 层（子块用 required 层，避开同层自动融合）
        let parent = db::create_block(&conn, &task.id, ts(2026, 1, 7, 14, 0), ts(2026, 1, 7, 15, 0))
            .expect("块")
            .id;
        let c1 = db::create_block_with_layer(
            &conn,
            &task.id,
            ts(2026, 1, 7, 14, 0),
            ts(2026, 1, 7, 15, 0),
            "required",
            true,
        )
        .expect("块")
        .id;
        conn.execute(
            "UPDATE blocks SET postponed_from = ?1 WHERE id = ?2",
            rusqlite::params![parent, c1],
        )
        .expect("接链");
        let c2 = db::create_block_with_layer(
            &conn,
            &task.id,
            ts(2026, 1, 8, 14, 0),
            ts(2026, 1, 8, 15, 0),
            "required",
            true,
        )
        .expect("块")
        .id;
        conn.execute(
            "UPDATE blocks SET postponed_from = ?1 WHERE id = ?2",
            rusqlite::params![c1, c2],
        )
        .expect("接链");
        let c3 = db::create_block_with_layer(
            &conn,
            &task.id,
            ts(2026, 1, 9, 14, 0),
            ts(2026, 1, 9, 15, 0),
            "required",
            true,
        )
        .expect("块")
        .id;
        conn.execute(
            "UPDATE blocks SET postponed_from = ?1 WHERE id = ?2",
            rusqlite::params![c2, c3],
        )
        .expect("接链");
        // 一键三连：一条 3 环的序列
        conn.execute(
            "INSERT INTO sequences (id,name,created_at) VALUES ('seq1','链',1)",
            [],
        )
        .expect("建序列");
        for (i, b) in [&tiny, &req, &parent].iter().enumerate() {
            conn.execute(
                "INSERT INTO sequence_members (sequence_id,block_id,order_index) VALUES ('seq1',?1,?2)",
                rusqlite::params![b, i as i64],
            )
            .expect("加成员");
        }
        // 荤素搭配：同一天必填 2 + 弹性 2 完成
        let r1 = db::create_block_with_layer(
            &conn,
            &task.id,
            ts(2026, 1, 13, 9, 0),
            ts(2026, 1, 13, 9, 30),
            "required",
            true,
        )
        .expect("块")
        .id;
        let r2 = db::create_block_with_layer(
            &conn,
            &task.id,
            ts(2026, 1, 13, 10, 0),
            ts(2026, 1, 13, 10, 30),
            "required",
            true,
        )
        .expect("块")
        .id;
        let e1 = db::create_block(&conn, &task.id, ts(2026, 1, 13, 11, 0), ts(2026, 1, 13, 11, 30))
            .expect("块")
            .id;
        let e2 = db::create_block(&conn, &task.id, ts(2026, 1, 13, 12, 0), ts(2026, 1, 13, 12, 30))
            .expect("块")
            .id;
        for b in [&r1, &r2, &e1, &e2] {
            ev("complete", ts(2026, 1, 13, 18, 0), None, b);
        }
        // 我们怎么排到这的？：2027-01-04 那周六要素齐全
        let w6req = db::create_block_with_layer(
            &conn,
            &task.id,
            ts(2027, 1, 4, 9, 0),
            ts(2027, 1, 4, 10, 0),
            "required",
            true,
        )
        .expect("块")
        .id;
        let w6ela = db::create_block(&conn, &task.id, ts(2027, 1, 4, 11, 0), ts(2027, 1, 4, 12, 0))
            .expect("块")
            .id;
        ev("create", ts(2027, 1, 4, 8, 0), Some(r#"{"temp":true}"#), "tmp6");
        ev("complete", ts(2027, 1, 4, 18, 0), None, &w6req);
        ev("skip", ts(2027, 1, 4, 18, 5), None, &w6ela);
        ev(
            "postpone",
            ts(2027, 1, 4, 18, 10),
            Some(r#"{"from":1,"to":2}"#),
            &w6ela,
        );
        // 下周再说 / 曲速泡：跨 1 周与跨 5 周的移动
        let f1 = ts(2026, 1, 5, 9, 0);
        let t1 = ts(2026, 1, 12, 9, 0);
        ev(
            "move",
            ts(2026, 1, 8, 9, 0),
            Some(&format!(
                r#"{{"from":{f1},"to":{t1},"end_from":{},"end_to":{}}}"#,
                f1 + 3600,
                t1 + 3600
            )),
            &tiny,
        );
        let t2 = ts(2026, 2, 9, 9, 0);
        ev(
            "move",
            ts(2026, 1, 8, 9, 5),
            Some(&format!(
                r#"{{"from":{f1},"to":{t2},"end_from":{},"end_to":{}}}"#,
                f1 + 3600,
                t2 + 3600
            )),
            &tiny,
        );
        // 朝三暮四：同一天把同一块挪 5 次
        for i in 0..5 {
            ev(
                "move",
                ts(2026, 1, 8, 10 + i, 0),
                Some(r#"{"from":1,"to":2,"end_from":3,"end_to":4}"#),
                &req,
            );
        }
        // 排班狂魔 / 搁这儿排班呢 / 量子波动速排：一天 30 条 create（前 5 条在 40 秒内）
        for i in 0..30 {
            let at = ts(2026, 5, 1, 8, 0) + if i < 5 { i * 10 } else { 3600 + i * 300 };
            ev("create", at, Some(r#"{"temp":false}"#), &format!("c{i}"));
        }
        // 100 个连续自然日（一天一条完成 70 分钟）→ 百日 / 传火 / 一周不断 / 一百小时
        for d in 0..100 {
            ev(
                "complete",
                ts(2026, 1, 1, 10, 0) + d * 86400,
                Some(r#"{"minutes":70}"#),
                &format!("d{d}"),
            );
        }
        // 月月不断 + 仍然活着：4 月 10 日之后隔 35 天到 5 月，5–12 月每月一条
        for m in 5..=12 {
            ev("complete", ts(2026, m, 15, 10, 0), None, &format!("m{m}"));
        }
        // 时段类：夜猫子 / 深夜的哲学 / WakeyWakey / 早八人 / 熬夜冠军 / 赶在午夜前 / 跨年 / 周末 / 快不过光速
        ev("create", ts(2026, 1, 1, 0, 30), None, "night_create");
        // 快不过光速：开始 3 分钟后就标完成（round69.1 起看 delay_minutes：不小于「块多长」了）
        ev(
            "complete",
            ts(2026, 1, 1, 0, 33),
            Some(r#"{"minutes":30,"delay_minutes":3}"#),
            "night_create",
        );
        for d in 1..=3 {
            ev(
                "complete",
                ts(2026, 1, d, 7, 30),
                Some(if d == 3 {
                    r#"{"minutes":15}"#
                } else {
                    r#"{"minutes":30}"#
                }),
                &format!("early{d}"),
            );
            ev("complete", ts(2026, 1, d, 1, 0), None, &format!("owl{d}"));
        }
        ev("complete", ts(2026, 1, 3, 23, 10), None, "midnight");
        ev("complete", ts(2026, 1, 10, 11, 0), None, "saturday");
        ev("complete", ts(2025, 12, 31, 23, 30), None, "nye");
        ev("complete", ts(2027, 2, 10, 10, 0), None, "last");
        // 雨露均沾：一周里 5 个不同任务被完成
        for i in 0..5 {
            let t = db::create_task(&conn, &format!("雨露{i}"), None).expect("建任务");
            let b = db::create_block(
                &conn,
                &t.id,
                ts(2026, 1, 27, 9 + i as u32, 0),
                ts(2026, 1, 27, 9 + i as u32, 30),
            )
            .expect("块")
            .id;
            ev("complete", ts(2026, 1, 27, 20, 0), None, &b);
        }

        // 首启静默（回溯），now = 2027-02-15（生日：用满 365 天且近 30 天有动作）
        evaluate(&conn, ts(2027, 2, 15, 12, 0)).expect("回溯");

        let want = [
            "min_block",
            "diamond_layer",
            "sanity_exempt",
            "long_name",
            "category_first",
            "category_boss",
            "five_same",
            "full_week",
            "same_time_5",
            "friday_hell",
            "worker",
            "hom_praise_sun",
            "sunday_planner",
            "boomerang",
            "drift_depth_3",
            "one_key_three",
            "balanced",
            "how_did_we_get_here",
            "flip_flop",
            "next_week_move",
            "warp_bubble",
            "schedule_30",
            "overwork_day",
            "quantum_speed",
            "days_100",
            "streak_100",
            "daily_7",
            "daily_30",
            "hours_100",
            "done_100",
            "night_owl",
            "night_done",
            "early_bird",
            "before_midnight",
            "cross_year",
            "weekend_warrior",
            "early_3",
            "owl_3",
            "hom_faster",
            "rain_dew",
            "perfect_month",
            "time_master",
            "all_done_week",
            "back_after_gap",
            "blank_week",
            "free_weekend",
            "month_streak_12",
            "birthday",
        ];
        let missing: Vec<&str> = want.iter().copied().filter(|id| !unlocked(&conn, id)).collect();
        assert!(missing.is_empty(), "规则类总检失败 —— 未点亮：{missing:?}");
    }

    /// round69.1（#9）：长篇大论 = **任务名 ≥20 字** —— 名字短的时候必须不亮
    /// （旧写法把 20 放在 `target` 里，而 `d()` 传的是 0 且规则写 `>= target` → **任何名字都过**）
    #[test]
    fn test_long_name_requires_twenty_chars() {
        let conn = test_conn();
        db::create_task(&conn, "短名字", None).expect("建任务");
        evaluate(&conn, ts(2026, 1, 5, 12, 0)).expect("求值");
        assert!(!unlocked(&conn, "long_name"), "短名字不该点亮长篇大论");

        let conn2 = test_conn();
        db::create_task(&conn2, "这是一个超过二十个字的任务名称需要来回数一数", None).expect("建任务");
        evaluate(&conn2, ts(2026, 1, 5, 12, 0)).expect("求值");
        assert!(unlocked(&conn2, "long_name"), "≥20 字要点亮");
    }

    /// round69.1（#9）：「快不过光速」= **开始后 15 分钟内被完成**，
    /// 不是「完成了一个 ≤15 分钟的块」（旧口径看 `minutes`= 块长）。
    /// 新口径看 `complete` 事件的 `delay_minutes`（标 ✓ 时刻 − 计划开始；提前完成记 0）。
    #[test]
    fn test_fast_complete_uses_completion_delay() {
        let conn = test_conn();
        let t = db::create_task(&conn, "任务", None).expect("建任务");
        let b1 = db::create_block(&conn, &t.id, ts(2026, 1, 5, 9, 0), ts(2026, 1, 5, 10, 0))
            .expect("块");
        put_event(
            &conn,
            "complete",
            Some(r#"{"minutes":60,"delay_minutes":5}"#),
            ts(2026, 1, 5, 9, 5),
            &b1.id,
        );
        evaluate(&conn, ts(2026, 1, 5, 12, 0)).expect("求值");
        assert!(unlocked(&conn, "hom_faster"), "一小时的块、开始 5 分钟就完成 → 要亮");

        let conn2 = test_conn();
        let t2 = db::create_task(&conn2, "任务", None).expect("建任务");
        let b2 = db::create_block(&conn2, &t2.id, ts(2026, 1, 5, 9, 0), ts(2026, 1, 5, 9, 15))
            .expect("块");
        put_event(
            &conn2,
            "complete",
            Some(r#"{"minutes":15,"delay_minutes":120}"#),
            ts(2026, 1, 5, 11, 0),
            &b2.id,
        );
        evaluate(&conn2, ts(2026, 1, 5, 12, 0)).expect("求值");
        assert!(!unlocked(&conn2, "hom_faster"), "15 分钟的块拖 2 小时才补不算快");
    }

    /// round69.1（#9）：「马后炮」只认**超时完成** —— 勾一个未来的块必须是 done_short（遥遥领先）
    #[test]
    fn test_marking_future_block_is_early_not_late() {
        let conn = test_conn();
        let task = db::create_task(&conn, "任务", None).expect("建任务");
        let now = db::now();
        let b = db::create_block(&conn, &task.id, now + 3600, now + 7200).expect("块");
        let done = db::mark_block_done(&conn, &b.id).expect("标完成");
        assert_eq!(done.final_status.as_deref(), Some("done_short"), "未来块 = 提前完成");
        evaluate(&conn, db::now()).expect("求值");
        assert!(!unlocked(&conn, "ma_hou_pao"), "未来块不许点亮马后炮");
        assert!(unlocked(&conn, "hom_way_ahead"), "它该点亮遥遥领先");
    }

    /// B1 #9：性能冒烟 —— 5 万条事件下 evaluate 一次别慢到离谱（debug 宽限 2s；
    /// 只防 O(n²) 级别退化，不是精确基准）。
    #[test]
    fn test_evaluate_is_not_pathologically_slow() {
        let conn = test_conn();
        conn.execute_batch("BEGIN").expect("开事务");
        for i in 0..50_000 {
            conn.execute(
                "INSERT INTO events (id, block_id, event_type, payload, created_at) VALUES (?1,'x','complete',NULL,?2)",
                rusqlite::params![format!("e{i}"), 1_700_000_000 + i],
            )
            .expect("插事件");
        }
        conn.execute_batch("COMMIT").expect("提交");
        let t0 = std::time::Instant::now();
        evaluate(&conn, 1_900_000_000).expect("求值");
        let ms = t0.elapsed().as_millis();
        eprintln!("[achievements] 5 万事件 evaluate = {ms} ms");
        assert!(ms < 2000, "求值太慢：{ms} ms（5 万事件，debug 宽限 2s）");
    }
}
