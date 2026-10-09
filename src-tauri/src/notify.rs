//! 到点提醒：后台线程定期扫描「已到期但还没提醒过」的任务块并发提醒。
//!
//! 两条通道（用户拍板 R11 后的现状）：
//! - **必填层**：`toast` 模块发「带 ✓/✗ 按钮的常驻通知」，用户可直接作答（见 `notify/toast.rs`）；
//! - **建议/弹性层**：走 `tauri-plugin-notification`（不带按钮，只能指路）+ 应用内提示。
//!
//! 三条硬约束（v5 + 本次裁决 I2/I3/I4）：
//! 1. 线程闭包返回 `()`，不能用 `?`；`MutexGuard` 不得跨 `sleep`（扫描完立即释放锁，再睡）。
//! 2. 只有通知**发送成功**才写 `last_notified_at`，失败则下次扫描重试。
//! 3. 只补发「最近 2 小时内结束」的块：覆盖午休/开会/短暂关机，挡住隔夜与长期未开机的一堆历史提醒。

use std::sync::atomic::{AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

use rusqlite::{params, Connection};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::db;

pub mod priority;
mod toast;

use self::priority::Priority;
use crate::i18n;
use crate::tf;

/// 叫醒提醒线程的通道（见 `wake_notifier`）
static WAKE_TX: OnceLock<Sender<()>> = OnceLock::new();

/// 立即唤醒提醒线程，不必等它睡完。
/// **为什么需要**：提醒线程在没事干时会一眠最多 60 秒；用户刚把一个「已经结束」的块拖上去时，
/// 若不叫醒它，就最多要等一整轮才被看到（实测发现）。命令层在每次块变更后调一下即可。
/// 未启动线程时调用是安全的（无操作）。
pub fn wake_notifier() {
    if let Some(tx) = WAKE_TX.get() {
        let _ = tx.send(());
    }
}

/// 迟到提醒的宽限期（秒）：2 小时（I4）
pub const GRACE_SECONDS: i64 = 2 * 60 * 60;
/// 轮询上限（秒）：没有待办块时最多睡这么久（v5 的 60 秒兜底）
pub const MAX_SLEEP_SECONDS: u64 = 60;
/// 轮询下限（秒）：避免时钟跳动造成忙等
pub const MIN_SLEEP_SECONDS: u64 = 5;

/// 启动后台提醒线程（每轮：短锁扫描 → 释放锁 → 可被打断的睡眠）。
pub fn start_notifier(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    let _ = WAKE_TX.set(tx);

    thread::spawn(move || loop {
        let sleep_secs = scan_once(&app);
        // 用 recv_timeout 取代 thread::sleep：任何块变更都能通过 wake_notifier() 立刻叫醒它，
        // 把「新拖入的已结束块」从「最多等 60 秒」降到「几乎立即」（超时仍然作为兜底）。
        let _ = rx.recv_timeout(Duration::from_secs(sleep_secs));
    });
}

/// 本轮（一个「到点波次」）还没处理完的条数
static PENDING: AtomicUsize = AtomicUsize::new(0);
/// 本轮编号：给「持续 N 秒后停止闪烁」的定时器判断自己是不是已经过期
static ROUND: AtomicU64 = AtomicU64::new(0);
/// 到点后托盘闪烁持续多少秒（N4：通知会常驻在通知中心，但闪烁不能无限）
const BLINK_SECONDS: u64 = 60;

/// 上一轮开始的时间戳（秒）。用来判断「上一轮是不是已经太久没人处理」——
/// 通知是常驻的，用户可能一直不理；那种情况下 PENDING 永远不会归零，
/// 若不纠正，**后面的提醒就会永远不出声、也不点亮托盘**（纯逻辑推导出来的坑）。
static ROUND_STARTED_AT: AtomicI64 = AtomicI64::new(0);

/// 纯函数（可单测）：上一轮是不是已经过期（没人处理且超过 BLINK_SECONDS）
fn pending_is_stale(pending: usize, now: i64, last_started: i64) -> bool {
    pending > 0 && last_started > 0 && now - last_started >= BLINK_SECONDS as i64
}

/// 开始处理本轮的一条：返回「是不是本轮第一条」。
/// 第一条负责出声 + 点亮托盘提醒态，并起一个**只在 60 秒内有效**的定时器（N4）。
fn begin_round(app: &AppHandle, now: i64) -> bool {
    // 上一轮超过 60 秒还没人处理 → 当作过期，重置计数（否则后续提醒永久静音）
    if pending_is_stale(
        PENDING.load(Ordering::SeqCst),
        now,
        ROUND_STARTED_AT.load(Ordering::SeqCst),
    ) {
        eprintln!(
            "[notify] 上一轮提醒已超过 {BLINK_SECONDS} 秒未处理 → 重置本轮计数（避免后续提醒永久静音）"
        );
        PENDING.store(0, Ordering::SeqCst);
        ROUND.fetch_add(1, Ordering::SeqCst); // 让旧轮次的定时器失效，别提前关掉新一轮的提醒态
    }

    let pending = PENDING.fetch_add(1, Ordering::SeqCst) + 1;
    if pending > 1 {
        return false; // 本轮已经有别的条了：不出声、不重复点亮
    }

    let round = ROUND.fetch_add(1, Ordering::SeqCst) + 1;
    ROUND_STARTED_AT.store(now, Ordering::SeqCst);
    crate::tray::set_reminder_active(app, true);

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(BLINK_SECONDS));
        // 只有「还是自己这一轮」才收回：否则会把新的一次提醒提前关掉
        if ROUND.load(Ordering::SeqCst) == round {
            eprintln!("[notify] 提醒已过 {BLINK_SECONDS} 秒，托盘停止闪烁（通知仍在通知中心）");
            crate::tray::set_reminder_active(&app, false);
        }
    });
    true
}

/// 本轮一条处理完毕（作答或被关闭）
fn end_round_item(app: &AppHandle) {
    if PENDING.fetch_sub(1, Ordering::SeqCst) <= 1 {
        PENDING.store(0, Ordering::SeqCst); // 防止计数下溢（多调一次也不会算错）
        crate::tray::set_reminder_active(app, false);
    }
}

/// 提醒计划（任务计划程序兜底 C13）的开关存入 settings 表；
/// ⚠️ **round63（C18）已改默认：关**（用户 2026-10-04：「不想没有用户自己确认就在人家的电脑偷偷运行后台」）——
/// 只有**显式存过 `1`** 才算开；读不到 / 读失败都按关处理（看见 `scheduler_enabled` 的读法）。
const SCHEDULER_ENABLED_KEY: &str = "scheduler_enabled";
/// 设置项：「你不在时有 N 个块到点了」上次给出的时间（水位线，避免每次启动重复提示）
const MISSED_SUMMARY_KEY: &str = "missed_summary_at";

/// round63（C18 / R41）免打扰：静音到的时刻（Unix 秒；`0` = 没静音）
pub const QUIET_UNTIL_KEY: &str = "quiet_until";
/// round63：「到明早」的那个时刻（`"HH:MM"`，用户可在设置里改；默认 08:00）
pub const QUIET_MORNING_KEY: &str = "quiet_morning_at";
/// 默认的「明早」时刻（与 `commands::settings` 的默认值同一个口径）
pub const DEFAULT_QUIET_MORNING: &str = "08:00";

/// 前端启动时调一次：返回「你不在的时候错过了几个块」，并把水位线推到此刻。
/// **完全不动那些块**（用户明确要求「不要标记」）—— 它们照旧留在时间轴上等你自己处理。
pub fn take_missed_summary(app: &AppHandle) -> i64 {
    let now = crate::db::now();
    let state = app.state::<crate::AppState>();
    let guard = match state.db.lock() {
        Ok(guard) => guard,
        Err(e) => {
            eprintln!("[notify] 数据库锁失效：{e}（跳过启动汇总）");
            return 0;
        }
    };

    let since = match crate::db::get_setting(&guard, MISSED_SUMMARY_KEY) {
        Ok(Some(value)) => value.parse::<i64>().unwrap_or(0),
        Ok(None) => 0,
        Err(e) => {
            eprintln!("[notify] 读取汇总水位线失败：{e}（按 0 处理）");
            0
        }
    };

    let count = match count_missed_since(&guard, now, since) {
        Ok(count) => count,
        Err(e) => {
            eprintln!("[notify] {e}（跳过启动汇总）");
            return 0;
        }
    };

    // 无论有没有命中，都把水位线推到此刻：下次启动只统计这之后错过的
    if let Err(e) = crate::db::set_setting(&guard, MISSED_SUMMARY_KEY, &now.to_string()) {
        eprintln!("[notify] 保存汇总水位线失败：{e}");
    }
    if count > 0 {
        eprintln!("[notify] 启动汇总：你不在时有 {count} 个块到点了（只提示，不动这些块）");
    }
    count
}

/// round49：读一个提醒开关（与 `scheduler_enabled` 同一个口径：读不到或值异常 → 当作开启）。
/// `key` 用 `commands::settings::KEY_REMIND_START` / `KEY_REMIND_END`。
pub fn reminder_enabled(conn: &Connection, key: &str) -> bool {
    match crate::db::get_setting(conn, key) {
        Ok(Some(value)) => value.trim() != "0",
        Ok(None) => true,
        Err(e) => {
            eprintln!("[notify] 读取设置 {key} 失败：{e}（按开启处理）");
            true
        }
    }
}

/// 读开关（纯读库，便于单测与托盘菜单复用）。
///
/// round63（C18）默认值翻面：**只有显式存过 `1` 才算开** —— 计划任务会在系统里注册任务，
/// 属于「后台行为」，要用户自己确认（用户 2026-10-04 批注；`AGENTS.md` §三「默认值要礼貌」）。
pub fn scheduler_enabled(conn: &Connection) -> bool {
    match crate::db::get_setting(conn, SCHEDULER_ENABLED_KEY) {
        Ok(Some(value)) => value.trim() == "1",
        Ok(None) => false,
        Err(e) => {
            eprintln!("[scheduler] 读取开关失败：{e}（按关闭处理）");
            false
        }
    }
}

// ---------------------------------------------------------------- 免打扰（round63 / C18 / R41）

/// 静音到的时刻（读不到 / 非法 → `0` = 没静音）
pub fn quiet_until(conn: &Connection) -> i64 {
    match crate::db::get_setting(conn, QUIET_UNTIL_KEY) {
        Ok(Some(value)) => value.trim().parse::<i64>().unwrap_or(0).max(0),
        Ok(None) => 0,
        Err(e) => {
            eprintln!("[notify] 读免打扰截止时刻失败：{e}（按不静音处理）");
            0
        }
    }
}

/// 现在在不在免打扰里（静音期间提醒**不发送**；托盘 / 一行提示 / 计划任务同步照常）
pub fn is_quiet(conn: &Connection, now: i64) -> bool {
    quiet_until(conn) > now
}

/// 生效的「开始提醒提前」分钟数（`0` = 到点；缺省 / 非法 → `0`）
pub fn remind_lead_minutes(conn: &Connection) -> i64 {
    match crate::db::get_setting(conn, crate::commands::settings::KEY_REMIND_LEAD) {
        Ok(Some(value)) => value
            .trim()
            .parse::<i64>()
            .ok()
            .filter(|v| (0..=24 * 60).contains(v))
            .unwrap_or(0),
        Ok(None) => 0,
        Err(e) => {
            eprintln!("[notify] 读开始提醒提前档位失败：{e}（按到点处理）");
            0
        }
    }
}

/// 解析 `"8:00"` / `"08:00"` → `(8, 0)`；不合法 → `None`（设置层校验与这里同一套口径）
pub fn parse_hhmm(value: &str) -> Option<(u32, u32)> {
    let (h, m) = value.trim().split_once(':')?;
    let hour: u32 = h.trim().parse().ok()?;
    let minute: u32 = m.trim().parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some((hour, minute))
}

/// 生效的「明早」时刻（非法 / 缺省回退 08:00）
pub fn quiet_morning(conn: &Connection) -> (u32, u32) {
    crate::db::get_setting(conn, QUIET_MORNING_KEY)
        .ok()
        .flatten()
        .and_then(|v| parse_hhmm(&v))
        .or_else(|| parse_hhmm(DEFAULT_QUIET_MORNING))
        .unwrap_or((8, 0))
}

/// 「到明早」对应的静音截止时刻：**下一个**本地 `hour:minute`（严格晚于 now）。
/// 例：02:00 点「到明早 08:00」= 当天 08:00；09:00 点 = 次日 08:00。
pub fn next_daily_moment(now: i64, hour: u32, minute: u32) -> i64 {
    use chrono::{Duration, Local, TimeZone};
    let Some(dt) = Local.timestamp_opt(now, 0).single() else {
        return now;
    };
    let today = dt.date_naive().and_hms_opt(hour, minute, 0);
    if let Some(naive) = today {
        if let Some(moment) = Local.from_local_datetime(&naive).single() {
            if moment.timestamp() > now {
                return moment.timestamp();
            }
        }
    }
    let tomorrow = dt.date_naive() + Duration::days(1);
    if let Some(naive) = tomorrow.and_hms_opt(hour, minute, 0) {
        if let Some(moment) = Local.from_local_datetime(&naive).single() {
            return moment.timestamp();
        }
    }
    now + 24 * 3600 // 夏令时跳变等极端情况：兜底往后退一天（不 panic）
}

/// 「到明早」的截止时刻（读用户设定的「明早」时刻）—— 托盘菜单与设置面板共用同一套口径
pub fn quiet_until_morning(conn: &Connection, now: i64) -> i64 {
    let (h, m) = quiet_morning(conn);
    next_daily_moment(now, h, m)
}

/// 供托盘菜单与启动时使用：拿应用句柄读开关
pub fn scheduler_enabled_from_app(app: &AppHandle) -> bool {
    let state = app.state::<crate::AppState>();
    // 注意：必须先把 guard 绑定出来，不能让 `match state.db.lock()` 当尾表达式
    // （临时值会活过 `state`，报 E0597 —— 本项目已踩过这个坑）
    let guard = match state.db.lock() {
        Ok(guard) => guard,
        Err(e) => {
            eprintln!("[scheduler] 数据库锁失效：{e}（**按关闭处理** —— 与默认值礼貌一致）");
            return false;
        }
    };
    scheduler_enabled(&guard)
}

/// 托盘菜单切换开关：写库 + **立刻**把计划任务对齐到新状态 + 留日志
/// 把开关写进 settings 表；返回是否写入成功（拿不到锁/写失败都只记日志）
fn persist_scheduler_enabled(app: &AppHandle, enabled: bool) -> bool {
    let state = app.state::<crate::AppState>();
    // 同样：先绑定 guard，不让 `match state.db.lock()` 当尾表达式（否则 E0597）
    let guard = match state.db.lock() {
        Ok(guard) => guard,
        Err(e) => {
            eprintln!("[scheduler] 数据库锁失效：{e}");
            return false;
        }
    };
    match crate::db::set_setting(&guard, SCHEDULER_ENABLED_KEY, if enabled { "1" } else { "0" }) {
        Ok(_) => true,
        Err(e) => {
            eprintln!("[scheduler] 保存开关失败：{e}");
            false
        }
    }
}

/// 托盘菜单切换开关：写库 + **立刻**把计划任务对齐到新状态 + 留日志
pub fn set_scheduler_enabled(app: &AppHandle, enabled: bool) {
    if !persist_scheduler_enabled(app, enabled) {
        eprintln!("[scheduler] 开关没能存下来（本次仍然生效，重启后会恢复）");
    }
    eprintln!(
        "[scheduler] 提醒计划已{}",
        if enabled { "开启（应用退出后仍会按时唤醒）" } else { "关闭（已删除计划任务）" }
    );
    // 立即对齐：关掉 → 删任务；开启 → 按当前待办重新注册
    sync_scheduler(app, crate::db::now());
}

/// 把计划任务对齐到当前状态（C13）：开关关掉或没有待办块 → 删除；否则注册到最早的到期时刻。
fn sync_scheduler(app: &AppHandle, now: i64) {
    // round66（C12）：便携模式不碰系统计划任务 —— 不注册；也**不删**系统里已有的
    //（那可能是另一份安装版注册的，替它做决定不合适）。托盘与设置里这项显示为不可用。
    if app.state::<crate::portable::DataPaths>().portable {
        eprintln!("[scheduler] 便携模式：不注册计划任务");
        return;
    }
    let exe = match std::env::current_exe() {
        Ok(path) => path.display().to_string(),
        Err(e) => {
            eprintln!("[scheduler] 拿不到自身可执行文件路径：{e}（跳过同步）");
            return;
        }
    };

    // 一次锁搞定「读开关 + 算下一个到期时刻」，锁内不做任何慢操作
    let at = {
        let state = app.state::<crate::AppState>();
        let guard = match state.db.lock() {
            Ok(guard) => guard,
            Err(e) => {
                eprintln!("[scheduler] 数据库锁失效：{e}（跳过同步）");
                return;
            }
        };
        if !scheduler_enabled(&guard) {
            eprintln!("[scheduler] 提醒计划已关闭 → 清理计划任务");
            None
        } else {
            match next_end_at(&guard, now) {
                Ok(value) => value,
                Err(e) => {
                    eprintln!("[scheduler] {e}（跳过同步）");
                    return;
                }
            }
        }
    };

    crate::scheduler::sync(&exe, at);
}

// ------------------------------------------------------------------ C3：序列聚合

/// 序号（①②③…；超出 20 就用普通数字，免得到处找不到字符）
fn circled(index: usize) -> String {
    const CIRCLED: [&str; 20] = [
        "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭",
        "⑮", "⑯", "⑰", "⑱", "⑲", "⑳",
    ];
    if index >= 1 && index <= CIRCLED.len() {
        CIRCLED[index - 1].to_string()
    } else {
        format!("({index})")
    }
}

/// 「序列内取最高」（v2 ⑧ 表）：合并提醒的优先级取组内最高的那个
pub fn max_priority(items: &[DueBlock]) -> Priority {
    items
        .iter()
        .map(|item| item.priority)
        .max_by_key(|priority| priority.rank())
        .unwrap_or(Priority::Low)
}

/// 给一整组块记账（语义与单个 `mark_notified` 相同，只是不重复写循环）
fn mark_group_notified(app: &AppHandle, group: &[DueBlock], now: i64) {
    for item in group {
        mark_notified(app, &item.id, now);
    }
}

/// C3：把到点的块按序列分组。未链接的各成一队；**同一条序列的合成一队**（队内按到点先后）。
/// 队与队之间保持原来「谁先到点谁在前」的顺序。
/// 纯函数（映射表由调用方备好）—— 这样能单测，也避免每块加一次锁。
pub fn group_due(
    due: Vec<DueBlock>,
    sequence_of: &std::collections::HashMap<String, String>,
) -> Vec<Vec<DueBlock>> {
    let mut groups: Vec<(Option<String>, Vec<DueBlock>)> = Vec::new();
    for item in due {
        match sequence_of.get(&item.id) {
            Some(sequence_id) => {
                match groups
                    .iter_mut()
                    .find(|(id, _)| id.as_deref() == Some(sequence_id.as_str()))
                {
                    Some((_, items)) => items.push(item),
                    None => groups.push((Some(sequence_id.clone()), vec![item])),
                }
            }
            None => groups.push((None, vec![item])),
        }
    }
    groups.into_iter().map(|(_, items)| items).collect()
}

/// 查「块 → 序列」的映射（一次锁内查完；失败则返回空表 → 退化为逐块提醒）
fn sequence_map(app: &AppHandle, due: &[DueBlock]) -> std::collections::HashMap<String, String> {
    let state = app.state::<crate::AppState>();
    let guard = match state.db.lock() {
        Ok(guard) => guard,
        Err(e) => {
            eprintln!("[notify] 获取数据库锁失败：{e}（退化为逐块提醒）");
            return std::collections::HashMap::new();
        }
    };
    let mut map = std::collections::HashMap::new();
    for item in due {
        match crate::db::sequence_of_block(&guard, &item.id) {
            Ok(Some(sequence)) => {
                map.insert(item.id.clone(), sequence.id);
            }
            Ok(None) => {}
            Err(e) => eprintln!("[notify] {e}（这一批退化为逐块提醒）"),
        }
    }
    map
}

/// 发一组提醒并等作答（**不阻塞**：等作答交给独立线程）。
/// 单块 = 原来的逐块提醒；多块 = 合并提醒：正文按 ①②③ 列出、按钮只答「当前」那一条，
/// 答完自动把下一条当作「当前」继续发（同一轮里不再重复出声）。
/// 返回「第一条是否成功发出」——调用方据此决定记账还是退回应用内提示（N7）。
fn send_group(app: &AppHandle, group: Vec<DueBlock>, audible: bool, is_rotation: bool) -> bool {
    let Some(current) = group.first().cloned() else {
        return false;
    };
    let rest = group[1..].to_vec();

    let (summary, body) = if rest.is_empty() {
        (
            tf!(i18n::msg::SYS_NOTIFY_01, p1 = current.title),
            i18n::t(i18n::msg::SYS_NOTIFY_02).to_string(),
        )
    } else {
        let list = group
            .iter()
            .enumerate()
            .map(|(index, item)| {
                format!(
                    "{}{}{}",
                    circled(index + 1),
                    item.title,
                    if index == 0 { i18n::t(i18n::msg::SYS_NOTIFY_21) } else { "" }
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        (
            tf!(i18n::msg::SYS_NOTIFY_03, p1 = current.title, p2 = group.len()),
            list,
        )
    };

    match toast::send(&app.config().identifier, &summary, &body, audible) {
        Ok(waiter) => {
            let app = app.clone();
            let current_id = current.id.clone();
            std::thread::spawn(move || {
                match waiter() {
                    toast::ToastOutcome::Answered(answer) => {
                        eprintln!("[notify] 收到按钮回答 {answer:?}（块 {current_id}）");
                        let applied = (|| -> Result<(), String> {
                            let state = app.state::<crate::AppState>();
                            let conn = state.db.lock().map_err(|e| e.to_string())?;
                            toast::apply_answer(&conn, &current_id, answer)
                        })();
                        if let Err(e) = applied {
                            eprintln!("[notify] 应用按钮回答失败（块 {current_id}）：{e}");
                        }
                        crate::broadcast_block_updated(&app);
                        wake_notifier();
                        // C3：合并提醒答完「当前」→ 自动把下一条当当前继续发（不再出声）
                        if !rest.is_empty() {
                            eprintln!("[notify] 合并提醒还剩 {} 条 → 继续发下一条", rest.len());
                            send_group(&app, rest, false, true);
                        }
                    }
                    toast::ToastOutcome::BodyClicked => {
                        // R12：点通知主体 → 把应用窗口带到前面（事件直接回到我们进程，无需注册 AUMID）
                        eprintln!("[notify] 点了通知主体 → 打开主窗口（块 {current_id}）");
                        crate::tray::show_main(&app);
                    }
                    toast::ToastOutcome::Dismissed => {
                        eprintln!("[notify] 通知被关闭/忽略（块 {current_id}），未作答");
                    }
                }
                // 只有「本轮的第一条」才结束本轮计数；轮换出来的那些不重复计数
                if !is_rotation {
                    end_round_item(&app);
                }
            });
            true
        }
        Err(e) => {
            eprintln!("[notify] {e}（块 {} → 退回应用内提示）", current.id);
            false
        }
    }
}

/// round49：扫一趟「该开始了」的块并提醒（开关关掉就整趟跳过）。
/// 失败只记日志、**不无限重试**（否则每 5 秒一轮会空转）；窗口内那条 `block-reminded` 是兜底。
fn notify_starts(app: &AppHandle, now: i64) {
    let (starts, lead) = {
        let state = app.state::<crate::AppState>();
        let guard = match state.db.lock() {
            Ok(guard) => guard,
            Err(e) => {
                eprintln!("[notify] 获取数据库锁失败（开始提醒）：{e}");
                return;
            }
        };
        if !reminder_enabled(&guard, crate::commands::settings::KEY_REMIND_START) {
            return;
        }
        let lead = remind_lead_minutes(&guard);
        match due_starts(&guard, now) {
            Ok(list) => (list, lead),
            Err(e) => {
                eprintln!("[notify] 扫开始提醒失败：{e}");
                return;
            }
        }
    };
    for item in starts {
        // round63（C18 / R49）：提前档位开着时不说「该开始了」（那时还没到）
        let body = if lead > 0 {
            tf!(i18n::msg::SYS_NOTIFY_04, p1 = item.title)
        } else {
            tf!(i18n::msg::SYS_NOTIFY_05, p1 = item.title)
        };
        let sent = app
            .notification()
            .builder()
            .title("WakeyWeeky")
            .body(body)
            .show();
        if let Err(e) = sent {
            eprintln!("[notify] 开始提醒发不出去（{}「{}」）：{e}", item.id, item.title);
        }
        // 窗口内也看得见（系统通知被挡时这就是兜底）
        if let Err(e) = app.emit(
            "block-reminded",
            serde_json::json!({
                "block_id": item.id,
                "task_title": item.title,
                "priority": item.priority.as_str(),
                "kind": "start",
            }),
        ) {
            eprintln!("[notify] 广播开始提醒失败：{e}");
        }
        // 发不发得出都记账（开始提醒没有「等用户作答」这件事，重试只会变成骚扰）
        mark_notified(app, &item.id, now);
    }
}

/// 一轮扫描：**锁只用于读写数据库，发通知时不持锁**，返回下一轮该睡多久（秒）。
/// 为什么这么拆：系统通知的 `show()` 可能很慢（甚至偶发挂住），
/// 若在持锁状态下调用，会把界面的所有命令一起阻塞住 —— 这正是 v5「命令不卡顿」要求的底线。
fn scan_once(app: &AppHandle) -> u64 {
    let now = chrono::Utc::now().timestamp();

    // round63（C18 / R41）：**免打扰** —— 静音期间不发任何提醒，只把本该提醒的块**静默记账**
    // （解静音后不补发；2 小时宽限里攒的一串不会一次爆出来）。
    // 注意：托盘状态 / 当前任务一行提示 / 计划任务同步**照跑**（静音只管「打扰你」这件事）。
    let muted = {
        let state = app.state::<crate::AppState>();
        let quiet = match state.db.lock() {
            Ok(guard) => is_quiet(&guard, now),
            Err(e) => {
                eprintln!("[notify] 读免打扰状态失败：{e}（按不静音处理）");
                false
            }
        };
        quiet
    };

    let gates = round_gates(muted);

    if gates.consume_silently {
        let counted = consume_muted_round_locked(app, now);
        match counted {
            Ok((starts, ends)) if starts + ends > 0 => {
                eprintln!("[notify] 免打扰中：静默记账（开始 {starts} / 结束 {ends}，不发送）");
            }
            Ok(_) => {}
            Err(e) => eprintln!("[notify] 免打扰静默记账失败：{e}"),
        }
    }
    if gates.starts {
        // round49：先跑一趟**开始提醒**（用户 2026-10-03：「任务开始时有提醒吗？我觉得应该有」）。
        // 它与结束提醒那套分开：没有要作答的东西 → 只发一条系统通知 + 广播给窗口，不进「等用户处理」计数。
        notify_starts(app, now);
    }

    let due = if gates.due { due_now(app, now) } else { Vec::new() };
    // C3：按序列把到点的块分组（同一条序列的多条合并成一条提醒）——
    // 合并只是体验优化，绝不能因此丢提醒：映射表查不到就退化为逐块。
    let map = sequence_map(app, &due);
    let groups = group_due(due, &map);

    for group in groups {
        let current = group[0].clone();
        let merged = group.len() > 1;
        // 「序列内取最高」（v2 ⑧ 表）
        let priority = max_priority(&group);
        let first_attempt = group.iter().any(|item| item.first_attempt);
        let (want_system, want_toast, mut want_in_app) = delivery(priority, first_attempt);

        // 1) 必填层：发「带 ✓/✗ 按钮的常驻通知」，把「等用户作答」交给独立线程（不阻塞提醒线程）。
        // 为什么不用插件：它在桌面端忽略 action 字段，拿不到按钮也拿不到回调（见 notify/toast.rs）。
        if want_toast {
            let audible = begin_round(app, now); // 同一轮只有第一条出声 + 才点亮托盘提醒态
            let sound = if audible { i18n::t(i18n::msg::SYS_NOTIFY_06) } else { i18n::t(i18n::msg::SYS_NOTIFY_07) };
            eprintln!(
                "[notify] 发必填层通知（块 {}「{}」{}{}）",
                current.id,
                current.title,
                if merged {
                    format!("合并 {} 块，", group.len())
                } else {
                    String::new()
                },
                sound
            );
            if !send_group(app, group.clone(), audible, false) {
                // N7：通知发不出去（比如系统里关了通知）→ 退回应用内提示，这是最后一道防线
                want_in_app = true;
            }
        }

        // 2) 系统通知（必填层的兜底 / 建议层的主通道）。失败时不记账，下一轮重试
        if want_system {
            // 文字要说清「发生了什么 + 该去哪操作」。
            // 注意：**这里发的是插件的通知，它不带按钮** —— 插件在桌面端忽略了 action 字段
            // （源码原话「action related options are ignored」），所以只能「指路」。
            // 必填层走的是带 ✓/✗ 按钮的通知，那条才真的能直接作答。
            let body = if merged {
                let list = group
                    .iter()
                    .enumerate()
                    .map(|(index, item)| format!("{}{}", circled(index + 1), item.title))
                    .collect::<Vec<_>>()
                    .join(" / ");
                tf!(i18n::msg::SYS_NOTIFY_20, p1 = current.title, p2 = group.len(), list = list)
            } else {
                tf!(i18n::msg::SYS_NOTIFY_08, p1 = current.title)
            };
            let sent = app
                .notification()
                .builder()
                .title("WakeyWeeky")
                .body(body)
                .show();
            match sent {
                Ok(_) => mark_group_notified(app, &group, now),
                Err(e) => {
                    eprintln!(
                        "[notify] 发送通知失败（{} 个块）：{e}（下一轮重试）",
                        group.len()
                    );
                    // 必填层的主通道是带按钮的通知（见 notify/toast.rs），插件通知只是它失败时的兜底：
                    // 兜底也失败就不再无限重试（否则每 5 秒一轮，一直空转）
                    if priority == Priority::High {
                        mark_group_notified(app, &group, now);
                    }
                }
            }
        } else {
            // 不发插件通知的情况（弹性层 / 必填层的按钮通知通道）：同样要记账，
            // 否则它每轮扫描都算「该提醒」→ 每 5 秒烦你一次（B2-4）
            mark_group_notified(app, &group, now);
        }

        // 3) 应用内提示（合并时用合并后的标题，前端不用改）
        if want_in_app {
            let title = if merged {
                tf!(i18n::msg::SYS_NOTIFY_09, p1 = current.title, p2 = group.len())
            } else {
                current.title.clone()
            };
            if let Err(e) = app.emit(
                "block-reminded",
                serde_json::json!({
                    "block_id": current.id,
                    "task_title": title,
                    "priority": priority.as_str(),
                    "kind": "end",
                }),
            ) {
                eprintln!("[notify] 广播提醒事件失败（块 {}）：{e}", current.id);
            }
        }
    }

    // 4) 刷新托盘基线（有任务 / 默认）。
    // 放这里的原因：① 本轮若有提醒弹出，当前已经是「提醒态」，刷新会自动跳过（不是基线态）；
    // ② 任何块变更都会通过 wake_notifier() 唤醒本线程 → 托盘状态跟着即时更新，无需额外轮询。
    crate::tray::refresh_baseline(app);

    // 4c) round63（C18 / R41）：免打扰自然过期时把托盘子菜单的「恢复提醒」拨回不可用
    //     （只在真的变了才动菜单，每轮调是便宜的）
    crate::tray::sync_quiet(app, now);

    // 4a) round62（11）：刷新「当前任务一行提示」（托盘悬停 + 窗口标题）。
    //     节拍复用本线程（每轮 ≤60 秒）：任何块变更都会 wake_notifier → 提示几乎即时跟着变。
    crate::hint::refresh(app);

    // 4b) 同步「任务计划程序兜底」（C13）：应用退出后到点仍能被唤醒 ——
    //     有待办块就注册到最早的那个到期时刻；开关关掉或没有待办则删除任务（不留残留）。
    sync_scheduler(app, now);

    sleep_seconds_now(app, now)
}

/// 短锁：取出这一轮该通知谁。
/// 注意这里的写法：先把 `Result<MutexGuard>` 绑成局部变量，再 match ——
/// 直接把 `match state.db.lock()` 当作尾表达式会让临时值活得比 `state` 长（E0597）。
/// 一轮扫描的闸门（**纯函数，接线由单测钉住**）：静音时「不发提醒 + 静默记账」，否则照常。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoundGates {
    /// 要不要跑开始提醒那一趟
    pub starts: bool,
    /// 要不要把本该提醒的块静默记账
    pub consume_silently: bool,
    /// 要不要取结束提醒的候选
    pub due: bool,
}

/// 静音 = **不发 + 静默记账**（解静音不补发）；不静音 = 两趟照常。
pub fn round_gates(muted: bool) -> RoundGates {
    RoundGates {
        starts: !muted,
        consume_silently: muted,
        due: !muted,
    }
}

/// 静音一轮的短锁包装（`scan_once` 用；锁只在这一小段里，不跨 sleep / 不跨发送）。
/// 注意写法：`match state.db.lock()` 不能当尾表达式（临时值会活过 `state` → E0597）。
fn consume_muted_round_locked(app: &AppHandle, now: i64) -> Result<(usize, usize), String> {
    let state = app.state::<crate::AppState>();
    let guard = match state.db.lock() {
        Ok(guard) => guard,
        Err(e) => return Err(tf!(i18n::msg::SYS_NOTIFY_10, e = e)),
    };
    consume_muted_round(&guard, now)
}

fn due_now(app: &AppHandle, now: i64) -> Vec<DueBlock> {
    let state = app.state::<crate::AppState>();
    let guard = match state.db.lock() {
        Ok(guard) => guard,
        Err(e) => {
            eprintln!("[notify] 获取数据库锁失败：{e}");
            return Vec::new();
        }
    };
    match due_ends(&guard, now) {
        Ok(list) => list,
        Err(e) => {
            eprintln!("[notify] 扫描失败：{e}");
            Vec::new()
        }
    }
}

/// 短锁：记录「已通知」
fn mark_notified(app: &AppHandle, id: &str, now: i64) {
    let state = app.state::<crate::AppState>();
    let guard = match state.db.lock() {
        Ok(guard) => guard,
        Err(e) => {
            eprintln!("[notify] 获取数据库锁失败：{e}");
            return;
        }
    };
    // round63：写库抽到 `db::mark_block_notified`（静音静默记账与单测共用同一实现）
    if let Err(e) = crate::db::mark_block_notified(&guard, id, now) {
        eprintln!("[notify] {e}（块 {id}）");
    }
}

/// 短锁：算下次唤醒间隔
fn sleep_seconds_now(app: &AppHandle, now: i64) -> u64 {
    let state = app.state::<crate::AppState>();
    let guard = match state.db.lock() {
        Ok(guard) => guard,
        Err(e) => {
            eprintln!("[notify] 获取数据库锁失败：{e}");
            return MAX_SLEEP_SECONDS;
        }
    };
    match next_wake_seconds(&guard, now) {
        Ok(secs) => secs,
        Err(e) => {
            eprintln!("[notify] 计算下次唤醒时间失败：{e}");
            MAX_SLEEP_SECONDS
        }
    }
}

/// 一条待提醒的块（纯数据结构，便于单测）
#[derive(Debug, Clone, PartialEq)]
pub struct DueBlock {
    pub id: String,
    pub title: String,
    pub priority: Priority,
    /// 是否「第一次尝试提醒」（此前从未提醒过）。
    /// 应用内提示与浮窗只在第一次发：否则系统通知持续失败时，会因为「没记账 → 5 秒后重试」
    /// 而每 5 秒弹一次浮窗/提示（B2-5 的边界）。
    pub first_attempt: bool,
}

/// 送达方式决策（纯函数，B2 表）：(要不要发插件通知, 要不要发带按钮的通知, 要不要发应用内提示)
/// 送达方式决策（纯函数）。三个布尔值依次是：**要不要发插件通知 / 要不要发带按钮的通知 / 要不要发应用内提示**。
///
/// - 必填（High）：**只用「带 ✓/✗ 按钮的常驻通知」**。
///   历史：这里曾经是「只用右下角卡片」，理由是我以为「系统通知只能看不能答」——**那个判断是错的**
///   （Windows 通知能带按钮、还能常驻到处理；只是 Tauri 的插件忽略了 action 字段）。
///   实测后改用通知（见 `notify/toast.rs` 的 spike 记录），卡片随之退役。
///   发不出去时由 `scan_once` 退回应用内提示（N7）。
/// - 弹性（Low）：仅应用内提示（静默；用户拍板 R8）。
///   （C1.4 两层结构后，「中」这一档随建议层一起退役）
///
/// `first_attempt`：只有第一次才弹通知/提示，重试不再重复打扰（但失败会重试通知本身）。
pub fn delivery(priority: Priority, first_attempt: bool) -> (bool, bool, bool) {
    match priority {
        Priority::High => (false, first_attempt, false),
        Priority::Low => (false, false, first_attempt),
    }
}

/// round49：**开始提醒**的候选 —— 与结束提醒（`due_blocks`）对称，但**排除已经结束的块**
/// （那种块该由结束提醒说话，否则同一个块会挨两条通知）。
/// 去重同样用 `last_notified_at`，条件换成 `< start_at` → 两个提醒互不打扰。
pub fn due_starts(conn: &Connection, now: i64) -> Result<Vec<DueBlock>, String> {
    // round63（C18 / R49）：提前档位 —— `lead` 分钟前就该报；去重也要按「提前那一刻」算，
    // 否则到点那一下会再响一次（`last_notified_at` 是第一次发的时间，晚于 start-lead）。
    let lead = remind_lead_minutes(conn) * 60;
    let filter = db::drift_filter(conn, "b.")?;
    query_due(
        conn,
        &format!(
            "SELECT b.id, t.title, b.layer, b.external_source, b.last_notified_at
         FROM blocks b JOIN tasks t ON t.id = b.task_id
         WHERE b.status = 'planned'
           AND b.start_at <= ?1 + ?3
           AND b.start_at > ?1 - ?2
           AND b.end_at > ?1
           AND (b.last_notified_at IS NULL OR b.last_notified_at < b.start_at - ?3){filter}
         ORDER BY b.start_at, b.rowid"
        ),
        now,
        lead,
    )
}

/// 跑一条「到点候选」查询并把行收成 `DueBlock`（`due_blocks` / `due_starts` 共用同一套映射）
fn query_due(conn: &Connection, sql: &str, now: i64, lead_seconds: i64) -> Result<Vec<DueBlock>, String> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| tf!(i18n::msg::SYS_NOTIFY_11, e = e))?;
    let rows = stmt
        .query_map(params![now, GRACE_SECONDS, lead_seconds], |r| {
            let layer: String = r.get(2)?;
            let external_source: Option<String> = r.get(3)?;
            let last_notified_at: Option<i64> = r.get(4)?;
            Ok(DueBlock {
                id: r.get(0)?,
                title: r.get(1)?,
                priority: priority::of(&layer, external_source.as_deref()),
                first_attempt: last_notified_at.is_none(),
            })
        })
        .map_err(|e| tf!(i18n::msg::SYS_NOTIFY_12, e = e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| tf!(i18n::msg::SYS_NOTIFY_13, e = e))?);
    }
    Ok(out)
}

/// 纯函数：算出「现在该通知哪些块」。
/// 注意 `first_attempt`：`last_notified_at IS NULL` 即为第一次（与下面的去重条件一致）。
pub fn due_blocks(conn: &Connection, now: i64) -> Result<Vec<DueBlock>, String> {
    let filter = db::drift_filter(conn, "b.")?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT b.id, t.title, b.layer, b.external_source, b.last_notified_at
             FROM blocks b JOIN tasks t ON t.id = b.task_id
             WHERE b.status = 'planned'
               AND b.end_at <= ?1
               AND b.end_at > ?1 - ?2
               AND (b.last_notified_at IS NULL OR b.last_notified_at < b.end_at){filter}
             ORDER BY b.end_at, b.rowid"
        ))
        .map_err(|e| tf!(i18n::msg::SYS_NOTIFY_14, e = e))?;

    let rows = stmt
        .query_map(params![now, GRACE_SECONDS], |r| {
            let layer: String = r.get(2)?;
            let external_source: Option<String> = r.get(3)?;
            let last_notified_at: Option<i64> = r.get(4)?;
            Ok(DueBlock {
                id: r.get(0)?,
                title: r.get(1)?,
                priority: priority::of(&layer, external_source.as_deref()),
                first_attempt: last_notified_at.is_none(),
            })
        })
        .map_err(|e| tf!(i18n::msg::SYS_NOTIFY_15, e = e))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| tf!(i18n::msg::SYS_NOTIFY_16, e = e))?);
    }
    Ok(out)
    // stmt 与 rows 在此作用域结束时 drop，不会和后续 UPDATE 抢借用
}

/// round63（C18）：结束提醒的候选 —— **尊重 `remind_end` 开关**（纯函数，便于单测）。
///
/// 修正一个**预先存在的 bug**（round63 发现）：`remind_end` 这个开关以前**从来没人读过**
/// （全仓只有 `settings.rs` 提到它）→ 勾掉「块结束时提醒」也照样响。
pub fn due_ends(conn: &Connection, now: i64) -> Result<Vec<DueBlock>, String> {
    if !reminder_enabled(conn, crate::commands::settings::KEY_REMIND_END) {
        return Ok(Vec::new());
    }
    due_blocks(conn, now)
}

/// round63（C18 / R41）：静音的一轮 —— 把「本该提醒」的开始 / 结束候选**静默记账**。
///
/// 只写 `last_notified_at`、不发任何东西；返回（开始条数, 结束条数）。
/// 语义：静音期间不打扰，**也不补发** —— 错过的块照旧留在时间轴上（复盘 / 统计看得见）。
pub fn consume_muted_round(conn: &Connection, now: i64) -> Result<(usize, usize), String> {
    let starts = if reminder_enabled(conn, crate::commands::settings::KEY_REMIND_START) {
        due_starts(conn, now)?
    } else {
        Vec::new()
    };
    let ends = due_ends(conn, now)?;
    for item in starts.iter().chain(ends.iter()) {
        crate::db::mark_block_notified(conn, &item.id, now)?;
    }
    Ok((starts.len(), ends.len()))
}

/// 纯函数：本轮扫描后应该睡多久。
/// - 有「已到期但还没通知成功」的块 → 尽快重试（MIN_SLEEP_SECONDS）
/// - 否则睡到下一个到期时刻，并夹在 [MIN, MAX] 之间（自适应轮询 I3）
pub fn next_wake_seconds(conn: &Connection, now: i64) -> Result<u64, String> {
    // round63（C18）：结束提醒关掉时，「等提醒的块」不算待办 —— 否则它们会一直挂在宽限里，
    // 让线程每 5 秒空转一轮（以前开关是死的，没暴露这个问题）。
    let pending: i64 = if reminder_enabled(conn, crate::commands::settings::KEY_REMIND_END) {
        let filter = db::drift_filter(conn, "")?;
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM blocks
             WHERE status = 'planned'
               AND end_at <= ?1
               AND end_at > ?1 - ?2
               AND (last_notified_at IS NULL OR last_notified_at < end_at){filter}"
            ),
            params![now, GRACE_SECONDS],
            |r| r.get(0),
        )
        .map_err(|e| tf!(i18n::msg::SYS_NOTIFY_17, e = e))?
    } else {
        0
    };

    if pending > 0 {
        return Ok(MIN_SLEEP_SECONDS);
    }

    let delta = match next_end_at(conn, now)? {
        Some(end_at) => (end_at - now).max(0) as u64,
        None => return Ok(MAX_SLEEP_SECONDS),
    };

    Ok(delta.clamp(MIN_SLEEP_SECONDS, MAX_SLEEP_SECONDS))
}

/// 下一个「未来」的块结束时刻（UTC 时间戳；没有待办块则 None）。
/// 提醒线程用它算睡眠时长；计划任务兜底（C13）用它算「什么时候唤醒应用」。
pub fn next_end_at(conn: &Connection, now: i64) -> Result<Option<i64>, String> {
    let filter = db::drift_filter(conn, "")?;
    conn.query_row(
        &format!(
            "SELECT MIN(end_at) FROM blocks WHERE status = 'planned' AND end_at > ?1{filter}"
        ),
        params![now],
        |r| r.get(0),
    )
    .map_err(|e| tf!(i18n::msg::SYS_NOTIFY_18, e = e))
}

/// 「错过的提醒」：已经出了 2 小时补发窗口、且从未提醒过、且在 `since` 之后结束的块数。
/// 用途：应用启动时给你一行交代（用户拍板：**给提示，但不改这些块的任何状态**）。
/// 注：已提醒过的块不算（它们当时是正常提醒的）；还没结束的块也不算。
pub fn count_missed_since(conn: &Connection, now: i64, since: i64) -> Result<i64, String> {
    let filter = db::drift_filter(conn, "")?;
    conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM blocks
         WHERE status = 'planned'
           AND end_at <= ?1 - ?2
           AND end_at > ?3
           AND last_notified_at IS NULL{filter}"
        ),
        params![now, GRACE_SECONDS, since],
        |r| r.get(0),
    )
    .map_err(|e| tf!(i18n::msg::SYS_NOTIFY_19, e = e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notify::due_blocks;
    use crate::notify::priority::Priority;
    use crate::db::{create_block, create_task, test_conn};

    /// round49：开始提醒的候选 —— 「刚开始的」算，「早就该开始而且已经结束的」不算
    /// （那种块由结束提醒说话，否则同一个块会挨两条通知）。
    #[test]
    fn test_due_starts_only_covers_not_yet_ended_blocks() {
        let conn = test_conn();
        let task = create_task(&conn, "出门", None).expect("创建任务失败");
        let now = 1_000_000;
        // 三块**互不接触**（同任务的相邻/重叠块会被自动融合 —— 那样就量不到"三个不同的块"了）
        let fresh = create_block(&conn, &task.id, now - 60, now + 1800).expect("建块失败");
        let old = create_block(&conn, &task.id, now - 7200, now - 5400).expect("建块失败");
        let future = create_block(&conn, &task.id, now + 3600, now + 5400).expect("建块失败");

        let due = due_starts(&conn, now).expect("扫开始提醒失败");
        let ids: Vec<&str> = due.iter().map(|item| item.id.as_str()).collect();
        assert!(ids.contains(&fresh.id.as_str()), "刚开始的块该提醒");
        assert!(!ids.contains(&old.id.as_str()), "早就开始、也已经结束的块不该再提醒开始");
        assert!(!ids.contains(&future.id.as_str()), "还没到开始时刻的块不提醒");

        // 记账（last_notified_at）之后不再重复；但把块挪走（清掉标记）会重新提醒
        conn.execute(
            "UPDATE blocks SET last_notified_at = ?1 WHERE id = ?2",
            params![now, fresh.id],
        )
        .expect("更新 last_notified_at 失败");
        let again = due_starts(&conn, now).expect("再扫失败了");
        assert!(again.is_empty(), "同一块只提醒一次");
    }

    #[test]
    fn test_due_blocks_respects_status_grace_and_notified_mark() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let now = 1_000_000;

        // 应当通知：10 分钟前结束、planned、还没通知过
        let due = create_block(&conn, &task.id, now - 3600, now - 600).expect("创建失败");
        // 超出 2 小时宽限期（3 小时前结束）→ 不通知
        let expired = create_block(&conn, &task.id, now - 12_000, now - 10_800).expect("创建失败");
        // 还没到点 → 不通知
        let future = create_block(&conn, &task.id, now + 600, now + 1800).expect("创建失败");
        // 已标记完成 → 不通知（C1.2 起同任务等时长会融合，所以这两块用别的任务）
        let task2 = create_task(&conn, "写作", None).expect("创建任务失败");
        let task3 = create_task(&conn, "健身", None).expect("创建任务失败");
        let done = create_block(&conn, &task2.id, now - 3600, now - 600).expect("创建失败");
        // 已通知过（last_notified_at 已达 end_at）→ 不重复通知
        let notified = create_block(&conn, &task3.id, now - 3600, now - 600).expect("创建失败");

        conn.execute("UPDATE blocks SET status = 'done' WHERE id = ?1", [&done.id])
            .expect("更新状态失败");
        conn.execute(
            "UPDATE blocks SET last_notified_at = ?1 WHERE id = ?2",
            params![now - 600, notified.id],
        )
        .expect("更新 last_notified_at 失败");

        let got = due_blocks(&conn, now).expect("查询失败");
        let ids: Vec<&str> = got.iter().map(|d| d.id.as_str()).collect();

        assert_eq!(got.len(), 1, "只应通知 1 个块，实际：{ids:?}");
        assert_eq!(got[0].id, due.id);
        assert_eq!(got[0].title, "读书");
        assert_eq!(got[0].priority, Priority::Low, "C1.4：新块默认弹性层 → 低");
        assert!(got[0].first_attempt, "从未提醒过应为首次");
        assert!(!ids.contains(&expired.id.as_str()));
        assert!(!ids.contains(&future.id.as_str()));
        assert!(!ids.contains(&done.id.as_str()));
        assert!(!ids.contains(&notified.id.as_str()));
    }

    /// 边界：提醒线程未启动时调用 wake_notifier() 必须安全（无操作，不 panic）
    #[test]
    fn test_wake_notifier_is_safe_before_start() {
        // 注意：本测试可能与其他测试并行运行，而在真实应用里线程是启动过的 ——
        // 因此只断言「不 panic」，不断言内部状态。
        wake_notifier();
    }

    /// B2 表：分流矩阵（高/低 × 首次/重试）
    #[test]
    fn test_delivery_matrix_follows_priority_table() {
        // 首次：必填 = **带按钮的通知**（用户拍板 R11，替换掉旧的「右下角卡片」）；低 = 仅应用内提示
        // 中间那个布尔值现在的含义是「发带按钮的通知」，不再是「发卡片」
        assert_eq!(delivery(Priority::High, true), (false, true, false));
        assert_eq!(delivery(Priority::Low, true), (false, false, true));

        // 重试（上次发送失败）：只重试通知本身，不再重复弹应用内提示
        assert_eq!(delivery(Priority::High, false), (false, false, false));
        assert_eq!(delivery(Priority::Low, false), (false, false, false));
    }

    /// 轮次过期的判定（纯函数）：常驻通知一直没人处理时，不能让后续提醒永久静音
    #[test]
    fn test_pending_staleness() {
        // 没有待处理项 → 永远不算过期
        assert!(!pending_is_stale(0, 1_000, 1_000));
        assert!(!pending_is_stale(0, 1_000_000, 0));
        // 从没开始过（last=0）→ 不算过期（避免启动时误判）
        assert!(!pending_is_stale(3, 1_000_000, 0));
        // 刚开的一轮（1 项待处理）→ 不算过期
        assert!(!pending_is_stale(1, 1_000, 1_000));
        assert!(!pending_is_stale(1, 1_059, 1_000));
        // 超过 60 秒还没处理 → 过期（后续提醒要能重新出声）
        assert!(pending_is_stale(1, 1_060, 1_000));
        assert!(pending_is_stale(3, 1_800, 1_000));
    }

    /// 启动汇总的统计口径（C13 补充）：只统计「已出 2 小时窗口 + 从未提醒 + 在水位线之后」的块
    #[test]
    fn test_count_missed_since() {
        let conn = test_conn();
        let now = 1_800_000_000i64;
        let task = create_task(&conn, "读书", None).expect("建任务失败");

        // 1) 早就错过（超出 2 小时窗口）、从未提醒 → 算
        create_block(&conn, &task.id, now - 20_000, now - 15_000).expect("建块失败");
        // 2) 还在 2 小时窗口内 → 不算（它会被正常提醒）
        create_block(&conn, &task.id, now - 3_000, now - 1_800).expect("建块失败");
        // 3) 还没结束 → 不算
        create_block(&conn, &task.id, now + 600, now + 1_800).expect("建块失败");
        // 4) 已提醒过（哪怕很久）→ 不算
        let notified = create_block(&conn, &task.id, now - 30_000, now - 25_000).expect("建块失败");
        conn.execute(
            "UPDATE blocks SET last_notified_at = ?1 WHERE id = ?2",
            params![now - 25_000, notified.id],
        )
        .expect("标记提醒失败");
        // 5) 已标记完成 → 不算
        let done = create_block(&conn, &task.id, now - 40_000, now - 35_000).expect("建块失败");
        conn.execute("UPDATE blocks SET status = 'done' WHERE id = ?1", [&done.id])
            .expect("标记失败");

        assert_eq!(count_missed_since(&conn, now, 0).expect("统计失败"), 1, "只有第 1 个符合");
        // 水位线在它之后 → 不再统计（同一批块只提示一次）
        assert_eq!(count_missed_since(&conn, now, now - 10_000).expect("统计失败"), 0);
        // 水位线在它之前 → 仍然统计
        assert_eq!(count_missed_since(&conn, now, now - 30_000).expect("统计失败"), 1);
    }

    /// C3：合并提醒的优先级取组内最高（v2 ⑧ 表）
    #[test]
    fn test_max_priority_takes_highest() {
        let item = |priority| DueBlock {
            id: "x".into(),
            title: "t".into(),
            priority,
            first_attempt: true,
        };
        assert_eq!(max_priority(&[item(Priority::Low)]), Priority::Low);
        assert_eq!(
            max_priority(&[item(Priority::Low), item(Priority::High)]),
            Priority::High
        );
        assert_eq!(max_priority(&[]), Priority::Low, "空组不应当 panic");
    }

    /// C3：序号（①②③…；超出 20 用普通数字）
    #[test]
    fn test_circled_index() {
        assert_eq!(circled(1), "①");
        assert_eq!(circled(3), "③");
        assert_eq!(circled(20), "⑳");
        assert_eq!(circled(21), "(21)");
    }

    /// C3：按序列分组（同序列合并、未链接各成一队、队间保持到点顺序）
    #[test]
    fn test_group_due_by_sequence() {
        let item = |id: &str| DueBlock {
            id: id.into(),
            title: format!("块{id}"),
            priority: Priority::Low,
            first_attempt: true,
        };
        let mut map = std::collections::HashMap::new();
        map.insert("b".to_string(), "seq1".to_string());
        map.insert("c".to_string(), "seq1".to_string());

        // 到点顺序：a（未链接）、b、c（同一条序列）、d（未链接）
        let groups = group_due(vec![item("a"), item("b"), item("c"), item("d")], &map);
        assert_eq!(groups.len(), 3, "应为 a / (b,c) / d 三队");
        assert_eq!(groups[0].len(), 1);
        assert_eq!(groups[1].len(), 2, "同一条序列的合成一队");
        assert_eq!(groups[1][0].id, "b", "队内按到点先后");
        assert_eq!(groups[1][1].id, "c");
        assert_eq!(groups[2][0].id, "d", "队间保持原顺序");

        assert!(group_due(Vec::new(), &map).is_empty(), "空输入不应 panic");
    }

    /// B2-4：低优先级（弹性层）同样要记账 —— 记了之后就不再出现，否则每 5 秒烦你一次
    #[test]
    fn test_low_priority_block_is_marked_and_then_silent() {
        let conn = test_conn();
        let task = create_task(&conn, "阅读", None).expect("创建任务失败");
        conn.execute(
            "UPDATE tasks SET is_elastic = 1 WHERE id = ?1",
            [&task.id],
        )
        .expect("设置弹性失败");
        let block = create_block(&conn, &task.id, 1_000, 2_800).expect("创建任务块失败");
        assert_eq!(block.layer, "elastic");
        assert_eq!(block.priority, "low", "弹性块应为低优先级");

        // 注意取值的边界：宽限期是「end_at > now - 7200」的左开区间。
        // 若取 now = 10_000（= 2_800 + 7_200）就正好落在边界外 —— 本次写测试时就撞上了这个边界。
        let now = 3_000;
        let due = due_blocks(&conn, now).expect("查询失败");
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].priority, Priority::Low);
        assert!(due[0].first_attempt, "第一次提醒");

        // 模拟「已记账」（低优先级也写 last_notified_at）
        conn.execute(
            "UPDATE blocks SET last_notified_at = ?1 WHERE id = ?2",
            params![block.end_at, block.id],
        )
        .expect("写通知标记失败");
        assert!(
            due_blocks(&conn, now).expect("查询失败").is_empty(),
            "记账之后不应再出现（这就是「不刷屏」的关键）"
        );
    }

    #[test]
    fn test_due_blocks_retries_when_notification_not_sent() {
        let conn = test_conn();
        let task = create_task(&conn, "健身", None).expect("创建任务失败");
        let now = 1_000_000;
        create_block(&conn, &task.id, now - 3600, now - 600).expect("创建失败");

        // 从未通知过 → 每次都算「待通知」，直到成功发通知并写入 last_notified_at 为止
        assert_eq!(due_blocks(&conn, now).expect("查询失败").len(), 1);
        assert_eq!(due_blocks(&conn, now + 30).expect("查询失败").len(), 1);
    }

    #[test]
    fn test_next_wake_seconds_adaptive_and_clamped() {
        let conn = test_conn();
        let task = create_task(&conn, "读书", None).expect("创建任务失败");
        let now = 1_000_000;

        // 没有待办块 → 上限兜底
        assert_eq!(
            next_wake_seconds(&conn, now).expect("计算失败"),
            MAX_SLEEP_SECONDS
        );

        // 下一个到期时刻在 1 秒后 → 夹到下限
        // （块最小时长是 15 分钟，所以先正常建块、再直接改库把它挪到 1 秒后：
        //   本用例测的是 `next_wake_seconds` 的夹取，不是创建校验）
        let soon = create_block(&conn, &task.id, now, now + 1_800).expect("创建失败");
        conn.execute(
            "UPDATE blocks SET end_at = ?1 WHERE id = ?2",
            params![now + 1, soon.id],
        )
        .expect("更新失败");
        assert_eq!(
            next_wake_seconds(&conn, now).expect("计算失败"),
            MIN_SLEEP_SECONDS
        );

        // 下一个到期时刻在 10 秒后 → 就在 10 秒后唤醒
        conn.execute("UPDATE blocks SET end_at = ?1 WHERE id = ?2", params![now + 10, soon.id])
            .expect("更新失败");
        assert_eq!(next_wake_seconds(&conn, now).expect("计算失败"), 10);

        // 下一个到期时刻在 1 小时后 → 夹到上限
        conn.execute(
            "UPDATE blocks SET end_at = ?1 WHERE id = ?2",
            params![now + 3600, soon.id],
        )
        .expect("更新失败");
        assert_eq!(
            next_wake_seconds(&conn, now).expect("计算失败"),
            MAX_SLEEP_SECONDS
        );

        // 已到期但还没通知成功 → 尽快重试
        conn.execute(
            "UPDATE blocks SET end_at = ?1 WHERE id = ?2",
            params![now - 60, soon.id],
        )
        .expect("更新失败");
        assert_eq!(
            next_wake_seconds(&conn, now).expect("计算失败"),
            MIN_SLEEP_SECONDS
        );
    }

    /// round63：静音分支的**接线**（纯函数钉住：静音 = 不发 + 静默记账；不静音 = 照常）
    #[test]
    fn test_round_gates_mute_wiring() {
        let normal = round_gates(false);
        assert!(normal.starts, "不静音：跑开始提醒");
        assert!(normal.due, "不静音：取结束候选");
        assert!(!normal.consume_silently);
        let muted = round_gates(true);
        assert!(!muted.starts, "静音：不跑开始提醒");
        assert!(!muted.due, "静音：不取结束候选（不发）");
        assert!(muted.consume_silently, "静音：只静默记账");
    }

    /// round63（C18 / R41）：免打扰窗口 —— 没存过不静音；到点那一刻就恢复；非法值回 0
    #[test]
    fn test_quiet_window_gate() {
        let conn = test_conn();
        assert!(!is_quiet(&conn, 1_000_000), "没存过 → 不静音");
        crate::db::set_setting(&conn, QUIET_UNTIL_KEY, "1000600").expect("写设置失败");
        assert!(is_quiet(&conn, 1_000_000));
        assert!(!is_quiet(&conn, 1_000_600), "正好到点 = 不再静音");
        crate::db::set_setting(&conn, QUIET_UNTIL_KEY, "垃圾").expect("写设置失败");
        assert!(!is_quiet(&conn, 1_000_000), "非法 → 按不静音");
        crate::db::set_setting(&conn, QUIET_UNTIL_KEY, "0").expect("写设置失败");
        assert!(!is_quiet(&conn, 1_000_000));
    }

    /// round63：「明早」的时刻解析与默认（08:00；非法回默认）
    #[test]
    fn test_quiet_morning_parse_and_default() {
        let conn = test_conn();
        assert_eq!(quiet_morning(&conn), (8, 0), "缺省 → 08:00");
        crate::db::set_setting(&conn, QUIET_MORNING_KEY, "9:30").expect("写设置失败");
        assert_eq!(quiet_morning(&conn), (9, 30));
        crate::db::set_setting(&conn, QUIET_MORNING_KEY, "25:00").expect("写设置失败");
        assert_eq!(quiet_morning(&conn), (8, 0), "非法 → 回默认");
        assert_eq!(parse_hhmm("08:00"), Some((8, 0)));
        assert_eq!(parse_hhmm("8:05"), Some((8, 5)));
        assert_eq!(parse_hhmm("08:60"), None);
        assert_eq!(parse_hhmm("晚上八点"), None);
    }

    /// round63：「到明早」= 下一个本地 HH:MM（**严格**晚于 now）—— 用固定日期算，不偷看真挂钟
    #[test]
    fn test_next_daily_moment_today_or_tomorrow() {
        use chrono::{Local, TimeZone};
        let at = |d: u32, h: u32, m: u32| {
            Local
                .with_ymd_and_hms(2026, 10, d, h, m, 0)
                .single()
                .unwrap()
                .timestamp()
        };
        assert_eq!(next_daily_moment(at(5, 7, 0), 8, 0), at(5, 8, 0), "7 点 → 当天 8 点");
        assert_eq!(next_daily_moment(at(5, 9, 0), 8, 0), at(6, 8, 0), "9 点 → 次日 8 点");
        assert_eq!(
            next_daily_moment(at(5, 8, 0), 8, 0),
            at(6, 8, 0),
            "正好 8 点 → 次日（严格晚于）"
        );
    }

    /// round63（C18 / R49）：开始提醒的提前档位 —— 提前 N 分钟就报、且**只报一次**（到点不重复）
    #[test]
    fn test_remind_lead_fires_early_and_only_once() {
        let conn = test_conn();
        let task = create_task(&conn, "开会", None).expect("创建任务失败");
        let now = 1_000_000;
        // 块在 10 分钟后开始（还没到开始时刻）
        let block = create_block(&conn, &task.id, now + 600, now + 600 + 1800).expect("建块失败");

        assert!(
            due_starts(&conn, now).expect("查询失败").is_empty(),
            "默认到点：还没到开始，不该候选"
        );
        crate::db::set_setting(&conn, crate::commands::settings::KEY_REMIND_LEAD, "10")
            .expect("写设置失败");
        assert_eq!(remind_lead_minutes(&conn), 10);
        assert_eq!(
            due_starts(&conn, now).expect("查询失败").len(),
            1,
            "提前 10 分钟：该候选（旧代码这里空 = 红）"
        );

        // 记上账（模拟发过）→ 同一块不再候选；到点那一刻也不重复
        crate::db::mark_block_notified(&conn, &block.id, now).expect("记账失败");
        assert!(
            due_starts(&conn, now).expect("查询失败").is_empty(),
            "同一块只响一次"
        );
        assert!(
            due_starts(&conn, now + 600).expect("查询失败").is_empty(),
            "到点那一下不重复响"
        );

        // 档位关掉 / 垃圾值 → 回到「到点才报」
        crate::db::set_setting(&conn, crate::commands::settings::KEY_REMIND_LEAD, "0")
            .expect("写设置失败");
        assert!(
            due_starts(&conn, now).expect("查询失败").is_empty(),
            "档位 0 = 到点，现在不该候选"
        );
        assert_eq!(
            due_starts(&conn, now + 600).expect("查询失败").len(),
            1,
            "到点那一刻该候选"
        );
        crate::db::set_setting(&conn, crate::commands::settings::KEY_REMIND_LEAD, "垃圾")
            .expect("写设置失败");
        assert_eq!(remind_lead_minutes(&conn), 0, "非法值 → 按到点");
    }

    /// round63（C18 / R41）：静音一轮 → 静默记账，解静音后不补发；
    /// 同时钉住「结束提醒开关」这个**预先存在的 bug**（以前 `remind_end` 没人读 → 关掉也响）
    #[test]
    fn test_muted_round_consumes_and_remind_end_switch() {
        let conn = test_conn();
        let task = create_task(&conn, "写文档", None).expect("创建任务失败");
        let other = create_task(&conn, "读书", None).expect("创建任务失败");
        let now = 1_000_000;
        // 同一任务的块互不接触（相接会被自动融合）；每块都要 ≥ 15 分钟（后端最小时长）
        let _starting = create_block(&conn, &task.id, now - 60, now + 1800).expect("建块失败");
        let _ended = create_block(&conn, &task.id, now - 1200, now - 300).expect("建块失败");
        let _older = create_block(&conn, &task.id, now - 2400, now - 1400).expect("建块失败");

        assert_eq!(due_starts(&conn, now).expect("查询失败").len(), 1, "一个开始候选");
        assert_eq!(due_ends(&conn, now).expect("查询失败").len(), 2, "两个结束候选");

        let (starts, ends) = consume_muted_round(&conn, now).expect("静默记账失败");
        assert_eq!((starts, ends), (1, 2));
        assert!(
            due_starts(&conn, now).expect("查询失败").is_empty(),
            "解静音不补发（开始）"
        );
        assert!(
            due_ends(&conn, now).expect("查询失败").is_empty(),
            "解静音不补发（结束）"
        );

        // 结束提醒开关（修好的那条）：开着能找到、关掉不候选、开回来又找到
        let _fresh = create_block(&conn, &other.id, now - 1800, now - 600).expect("建块失败");
        assert_eq!(due_ends(&conn, now).expect("查询失败").len(), 1, "开着时找得到");
        crate::db::set_setting(&conn, crate::commands::settings::KEY_REMIND_END, "0")
            .expect("写设置失败");
        assert!(
            due_ends(&conn, now).expect("查询失败").is_empty(),
            "关掉结束提醒 → 不再候选（旧代码这里非空 = 开关是死的）"
        );
        // 关掉时别让线程每 5 秒空转（宽限里的块不算待办）
        assert_eq!(next_wake_seconds(&conn, now).expect("计算失败"), MAX_SLEEP_SECONDS);
        crate::db::set_setting(&conn, crate::commands::settings::KEY_REMIND_END, "1")
            .expect("写设置失败");
        assert_eq!(due_ends(&conn, now).expect("查询失败").len(), 1, "开回来又找得到");
    }
}
