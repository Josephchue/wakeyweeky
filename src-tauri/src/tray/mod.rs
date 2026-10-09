//! 托盘状态指示器（v2 ⑪ C5）。
//!
//! 四态：默认 / 有当前任务 / 高优先级提醒（闪烁）/ 理智值超载。
//! **理智值超载（C6 / round44 已接）**：`refresh_baseline` 每轮会问一次
//! `sanity::today_overloaded` —— 今天的**占用**（并集，重叠只算一次）≥ 预算就切到这个状态，不超了自动交还基线；
//! 提醒态进行中不抢（优先级：提醒态 > 超载态 > 基线）。用户关掉理智值开关就不会进这个状态。
//!
//! 设计要点（三条都是踩过的坑换来的）：
//! - **托盘只在主线程动**：`set_icon`/`set_tooltip` 一律经 `run_on_main_thread` 排队。
//!   在通知线程/闪烁线程里直接调，会把 WebView2 的 UI 线程卡住 —— 实测症状是
//!   「卡片窗口弹出来了、但页面 JS 一直不加载」（界面就绪握手永远不来）。
//! - **渲染只有一个出口**（`paint_current`）：它按「当前状态 + 闪烁相位」决定画哪一帧，
//!   因此任何排到主线程的重画都是幂等正确的，不需要锁、也不会互相覆盖。
//!   （历史：当初从后台线程直接写托盘，导致界面不渲染；改成排主线程后问题消失 —— ⽽那个界面是后来的卡片，现已删除，但「托盘只在主线程动」这条规矩保留）
//! - 每次状态变化打一行 `[tray] 状态 → …`：托盘我肉眼看不到，日志就是自动化验证的证据通道。

pub mod icons;

use crate::db;
use crate::AppState;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use crate::i18n;
use crate::tf;

/// 闪烁间隔（B2-1）
const BLINK_INTERVAL: Duration = Duration::from_millis(700);

/// 状态的数值初值：用一个**非法下标**，保证「第一次设置一定会画图标」
/// （哪怕第一次设的就是 Default —— 否则启动后图标会是空白）
const UNKNOWN: u8 = 0xFF;

static TRAY: OnceLock<TrayIcon> = OnceLock::new();
/// 托盘菜单里的「提醒计划」勾选项（切换后需要把真实状态写回设置）
/// round74（3.0b₂）：语言切换会**重建菜单** → 三个句柄从 `OnceLock` 改成 `Mutex<Option<_>>`（可换新句柄）
static SCHEDULER_ITEM: Mutex<Option<CheckMenuItem<tauri::Wry>>> = Mutex::new(None);
/// round63（C18 / R41）：「暂停提醒」子菜单里需要动态改文案 / 可用性的两行
static QUIET_MORNING_ITEM: Mutex<Option<MenuItem<tauri::Wry>>> = Mutex::new(None);
static QUIET_RESUME_ITEM: Mutex<Option<MenuItem<tauri::Wry>>> = Mutex::new(None);
/// 上次渲染的（免打扰截止时刻, 明早时刻）—— `sync_quiet` 每轮扫描都会调，**只在真的变了才改菜单**
static QUIET_RENDERED: Mutex<(i64, String, bool)> = Mutex::new((i64::MIN, String::new(), false));
static CURRENT: AtomicU8 = AtomicU8::new(UNKNOWN);
/// 是否正在闪烁（同一时刻最多一个闪烁线程，B2-3）
static BLINKING: AtomicBool = AtomicBool::new(false);
/// 闪烁「世代」：每次进入/离开闪烁都 +1，线程只在自己世代仍有效时继续跑。
/// 为什么需要：光靠 BLINKING 会把旧线程「唤醒」—— 提醒 → 收起 → 又提醒 若在 700ms 内交替，
/// 旧线程还在睡，醒来看到 BLINKING 又是 true 就会继续闪，而新一轮又起了一个线程（频率翻倍）。
static BLINK_EPOCH: AtomicU64 = AtomicU64::new(0);
/// 闪烁的亮/灭相位（由闪烁线程翻转，渲染时读取）
static BLINK_LIT: AtomicBool = AtomicBool::new(true);
/// 托盘是否创建成功 → 关窗拦截的依据（B4-3）
static READY: AtomicBool = AtomicBool::new(false);
/// round62（11 一行提示）：tooltip 的**覆写文本**（空串 = 不覆写，按状态取文案）。
/// 只在 `HasCurrentTask` 基线态生效（见 `paint_current`）—— 提醒态 / 超载态仍然显示自己的文案。
static TOOLTIP_HINT: Mutex<String> = Mutex::new(String::new());

// round82（`盘-03` / `盘-15`）：**任务栏底色**决定用哪套墨色（亮任务栏 → 深墨，反之亦然）。
// 旧固定色在亮任务栏上四态全部 < WCAG 3:1（实测 1.65–2.99）—— 现在两套色都 ≥5:1。
// 值缓存在这里：读注册表要起一次子进程（便宜但不该每次重画都起），
// 启动问一次 + 系统主题变化（`ThemeChanged`）时再问。读不到就回落到窗口主题。
static TASKBAR_LIGHT: AtomicBool = AtomicBool::new(false);

/// 重新问一次任务栏底色，并重画当前帧（启动一次 + 系统主题变化时）。
pub fn refresh_taskbar_theme(app: &AppHandle) {
    let light = read_system_uses_light_theme().unwrap_or_else(|| {
        // 回落到窗口主题（`ui_theme = system` 时它就跟系统）；再不行按暗任务栏
        app.get_webview_window("main")
            .and_then(|w| w.theme().ok())
            .map(|t| t == tauri::Theme::Light)
            .unwrap_or(false)
    });
    TASKBAR_LIGHT.store(light, Ordering::SeqCst);
    // 换色要把当前帧重画一遍（TRAY 还没建时 paint_current 会静默返回）
    request_repaint(app);
}

/// 缓存的「任务栏是亮的吗」
fn taskbar_light() -> bool {
    TASKBAR_LIGHT.load(Ordering::SeqCst)
}

/// 系统「浅色」开关（Windows 任务栏底色跟它）—— `HKCU\...\Themes\Personalize\SystemUsesLightTheme`。
/// 零新依赖：问一次 `reg query`（不加 `CREATE_NO_WINDOW` 会闪黑框 —— 与 `scheduler::run` 同一套）。
fn read_system_uses_light_theme() -> Option<bool> {
    let mut command = std::process::Command::new("reg");
    command.args([
        "query",
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
        "/v",
        "SystemUsesLightTheme",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let out = command.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // 形如：`    SystemUsesLightTheme    REG_DWORD    0x1`
    let line = text.lines().find(|l| l.contains("SystemUsesLightTheme"))?;
    if line.contains("0x1") {
        Some(true)
    } else if line.contains("0x0") {
        Some(false)
    } else {
        None
    }
}

/// 托盘状态。改动请同时更新 `index`/`from_index`（有测试守着）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayState {
    /// 没有进行中的任务、也没有待处理提醒
    Default,
    /// 有 `planned` 块正在进行（start_at ≤ now ≤ end_at）
    HasCurrentTask,
    /// 高优先级提醒进行中（图标闪烁）
    HighPriorityReminder,
    /// 理智值超载（C6 / round44 起由 `sanity::today_overloaded` 自动判定）
    SanityOverload,
}

impl TrayState {
    /// 数值形式（存进 atomic，避免为读状态加锁）
    fn index(self) -> u8 {
        match self {
            TrayState::Default => 0,
            TrayState::HasCurrentTask => 1,
            TrayState::HighPriorityReminder => 2,
            TrayState::SanityOverload => 3,
        }
    }

    /// 与 `index` 成对；未知数值返回 None（不 panic）
    fn from_index(value: u8) -> Option<Self> {
        match value {
            0 => Some(TrayState::Default),
            1 => Some(TrayState::HasCurrentTask),
            2 => Some(TrayState::HighPriorityReminder),
            3 => Some(TrayState::SanityOverload),
            _ => None,
        }
    }

    /// 稳定标识：给 `set_tray_state` 命令入参 + 日志用（前端/C6 传这个字符串）
    pub fn as_label(self) -> &'static str {
        match self {
            TrayState::Default => "default",
            TrayState::HasCurrentTask => "has_current_task",
            TrayState::HighPriorityReminder => "high_priority_reminder",
            TrayState::SanityOverload => "sanity_overload",
        }
    }

    /// 解析命令入参；不认识的字符串返回 None（**不 panic**，由调用方决定兜底）
    pub fn from_label(label: &str) -> Option<Self> {
        match label {
            "default" => Some(TrayState::Default),
            "has_current_task" => Some(TrayState::HasCurrentTask),
            "high_priority_reminder" => Some(TrayState::HighPriorityReminder),
            "sanity_overload" => Some(TrayState::SanityOverload),
            _ => None,
        }
    }

    /// 托盘提示文字（鼠标悬停时显示）
    pub fn tooltip(self) -> &'static str {
        match self {
            TrayState::Default => "WakeyWeeky",
            TrayState::HasCurrentTask => i18n::t(i18n::msg::SYS_TRAY_MOD_01),
            TrayState::HighPriorityReminder => i18n::t(i18n::msg::SYS_TRAY_MOD_02),
            TrayState::SanityOverload => i18n::t(i18n::msg::SYS_TRAY_MOD_03),
        }
    }

    /// 是否属于「基线态」（可以被基线刷新覆盖）。
    /// 提醒态与超载态都**不是**基线态 —— 不需要额外标志位，查当前值即可（少一个状态变量少一类 bug）。
    pub fn is_baseline(self) -> bool {
        matches!(self, TrayState::Default | TrayState::HasCurrentTask)
    }

    /// 是否处于「需要闪烁」的状态（目前只有高优先级提醒）
    pub fn should_blink(self) -> bool {
        matches!(self, TrayState::HighPriorityReminder)
    }
}

// ------------------------------------------------------------------ 对外接口

/// 创建托盘（setup 里调用一次）。失败只记日志并返回 false：
/// 应用照常运行，且**关窗不会被拦截** —— 否则用户就没办法退出了（B4-3/B4-4）。
pub fn init(app: &AppHandle) -> bool {
    // round82（盘-03）：先把「任务栏底色」问出来（首帧就得是正确的那套墨色）
    refresh_taskbar_theme(app);
    let tray = match build(app) {
        Ok(tray) => tray,
        Err(e) => {
            eprintln!("[tray] 创建托盘失败：{e}（托盘不可用；关窗将直接退出）");
            return false;
        }
    };
    if TRAY.set(tray).is_err() {
        eprintln!("[tray] 托盘已存在，忽略重复初始化");
    }
    READY.store(true, Ordering::SeqCst);
    // init 本身就在主线程（setup），直接画首帧，不必自己给自己排队
    CURRENT.store(TrayState::Default.index(), Ordering::SeqCst);
    eprintln!("[tray] 状态 → {}", TrayState::Default.as_label());
    paint_current();
    // round63（C18 / R41）：若启动时就处于免打扰（上次关应用前静的音还没到期），菜单要跟着显示
    sync_quiet_at_startup(app);
    true
}

/// 托盘是否可用 —— 主窗口的关闭拦截以它为准（B4-3）
pub fn is_ready() -> bool {
    READY.load(Ordering::SeqCst)
}

/// 设置状态：只在**变化**时动图标与提示文字；需要闪烁时自动起/停闪烁线程。
/// 托盘未就绪时直接返回：连状态也不记 —— 否则启动早期的一次调用会把「首次绘制」吃掉，图标空白。
///
/// round64（C10）：`tray_state_enabled` 关掉时，状态一律按 `Default` 处理
/// （图标不再变色/闪烁/红环；通知、悬停文案、菜单都不受影响）。
pub fn set_state(app: &AppHandle, state: TrayState) {
    if !READY.load(Ordering::SeqCst) {
        return;
    }
    let state = gated_state(state, tray_state_enabled(app));
    if CURRENT.swap(state.index(), Ordering::SeqCst) == state.index() {
        return; // 没变化 → 不动图标
    }
    eprintln!("[tray] 状态 → {}", state.as_label());
    if state.should_blink() {
        BLINK_LIT.store(true, Ordering::SeqCst); // 每次进入闪烁都从「亮」开始
        BLINKING.store(true, Ordering::SeqCst);
        // 开一个新世代：万一还有旧线程在睡，它会因世代不符自行退出（不会两个线程并排闪）
        let epoch = BLINK_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
        start_blink(app, epoch);
    } else {
        BLINKING.store(false, Ordering::SeqCst); // B2-2：换状态立即停闪
        BLINK_EPOCH.fetch_add(1, Ordering::SeqCst); // 让在跑的线程立刻认出自己已过期
    }
    request_repaint(app);
}

/// round64（C10）：托盘状态开关的纯判定（肉眼看不见的东西靠单测钉 —— CHECK 规矩 5）
fn gated_state(state: TrayState, on: bool) -> TrayState {
    if on { state } else { TrayState::Default }
}

/// 读 `tray_state_enabled`（默认开；读不到按开处理 —— 宁可图标还在）
fn tray_state_enabled(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let guard = match state.db.lock() {
        Ok(guard) => guard,
        Err(e) => {
            eprintln!("[tray] 数据库锁失效（状态开关判定按开处理）：{e}");
            return true;
        }
    };
    crate::features::enabled(&guard, crate::features::TRAY_STATE)
}

/// 刷新基线（有任务 / 默认）+ C6 的「今天理智值超载」。
/// 优先级：**提醒态 > 超载态 > 基线**（B1-4 + round44）：提醒态谁都别抢；
/// 不再超载时把状态交还基线（否则红环会卡到下次提醒才消失）。
pub fn refresh_baseline(app: &AppHandle) {
    let current = TrayState::from_index(CURRENT.load(Ordering::SeqCst));
    let want = baseline(app);
    let overload = overloaded_now(app);
    match resolve_state(current, want, overload) {
        Some(next) => set_state(app, next),
        None => {
            if let Some(cur) = current {
                if cur != want && cur != TrayState::SanityOverload {
                    // 提醒态期间基线变了：按 B1-4 不覆盖，但留一行日志（这种情况少见，值得留痕）
                    eprintln!(
                        "[tray] 基线已变为 {}，但当前是提醒态，暂不覆盖",
                        want.as_label()
                    );
                }
            }
        }
    }
}

/// 这一帧该用哪条悬停文案（round62 / 11；round62.1 按你验收实测放宽）。
///
/// 规则：**只要算出了当前任务（hint 非空），悬停就必须看得见它** ——
/// - 正常态：`写周报 · 还剩 23 分 — WakeyWeeky`（你拍板的格式）；
/// - 超载 / 提醒等特别态：`<状态文案> · <任务 · 还剩 X 分>` 并排
///   （第一版把任务顶掉了 —— 你验收实测「悬停没有当前任务说明」→ 改成并排）。
///   没有当前块时回到状态自己的文案（四态原样）。
pub fn tooltip_text(state: TrayState, hint: &str) -> String {
    if hint.is_empty() {
        return state.tooltip().to_string();
    }
    match state {
        TrayState::HasCurrentTask => format!("{hint} — {}", crate::hint::DEFAULT_TITLE),
        _ => format!("{} · {hint}", state.tooltip()),
    }
}

/// round62（11 一行提示）：覆写悬停提示的文本；返回是否**变了**
/// （调用方 `hint::refresh` 据此决定要不要再动窗口标题 —— 两个落点同步更新）。
pub(crate) fn set_tooltip_hint(app: &AppHandle, text: String) -> bool {
    let changed = {
        let mut current = match TOOLTIP_HINT.lock() {
            Ok(guard) => guard,
            Err(e) => {
                eprintln!("[tray] 提示文案锁失效：{e}");
                return false;
            }
        };
        if *current == text {
            false
        } else {
            *current = text;
            true
        }
    };
    if changed {
        request_repaint(app); // 同一状态下的文案变化也得重画（set_state 只在状态变化时画）
    }
    changed
}

/// 今天超载吗（C6）。算不出来就当作**不**超载 —— 宁可少一次红环，也不能卡在红环上。
fn overloaded_now(app: &AppHandle) -> bool {
    let now = db::now();
    let state = app.state::<AppState>();
    let guard = match state.db.lock() {
        Ok(guard) => guard,
        Err(e) => {
            eprintln!("[tray] 数据库锁失效（理智值判定跳过）：{e}");
            return false;
        }
    };
    crate::sanity::today_overloaded(&guard, now)
}

/// 这一轮该把托盘切成什么？`None` = 不动。
/// **纯函数**：托盘图标肉眼看不见，靠单测钉住优先级（`docs/CHECK.md` 规矩 5）
pub fn resolve_state(
    current: Option<TrayState>,
    want_baseline: TrayState,
    overload: bool,
) -> Option<TrayState> {
    if matches!(current, Some(TrayState::HighPriorityReminder)) {
        return None; // B1-4：提醒进行中，基线/超载都不抢
    }
    if overload {
        return if current == Some(TrayState::SanityOverload) {
            None
        } else {
            Some(TrayState::SanityOverload)
        };
    }
    if current == Some(TrayState::SanityOverload) {
        return Some(want_baseline); // 不超了 → 交还基线
    }
    if matches!(current, Some(state) if state.is_baseline()) && current != Some(want_baseline) {
        return Some(want_baseline);
    }
    None
}

/// 提醒态开关：必填层发通知时 / 提醒结束（作答或超时）时调用（B1-4/B1-5）。
/// 收起时顺带把状态交还给基线 —— 避免「提醒结束了托盘还在闪」。
pub fn set_reminder_active(app: &AppHandle, active: bool) {
    if active {
        set_state(app, TrayState::HighPriorityReminder);
    } else {
        set_state(app, baseline(app));
    }
}

// ------------------------------------------------------------------ 内部实现

/// 构建托盘菜单（round74 / 3.0b₂：从 `build` 抽出来 —— 切语言时用同一份代码重建，句柄写回 statics）
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, "open", i18n::t(i18n::msg::SYS_TRAY_MOD_04), true, None::<&str>)?;
    // round63（C18 / R41）：暂停提醒 —— 干活中不用开窗就能静音（设置面板里也有同一份）
    let quiet30 = MenuItem::with_id(app, "quiet30", i18n::t(i18n::msg::SYS_TRAY_MOD_05), true, None::<&str>)?;
    let quiet60 = MenuItem::with_id(app, "quiet60", i18n::t(i18n::msg::SYS_TRAY_MOD_06), true, None::<&str>)?;
    let quiet_morning =
        MenuItem::with_id(app, "quiet_morning", i18n::t(i18n::msg::SYS_TRAY_MOD_07), true, None::<&str>)?;
    let quiet_resume = MenuItem::with_id(app, "quiet_resume", i18n::t(i18n::msg::SYS_TRAY_MOD_08), true, None::<&str>)?;
    if let Ok(mut slot) = QUIET_MORNING_ITEM.lock() {
        *slot = Some(quiet_morning.clone());
    }
    if let Ok(mut slot) = QUIET_RESUME_ITEM.lock() {
        *slot = Some(quiet_resume.clone());
    }
    let quiet_sep = PredefinedMenuItem::separator(app)?;
    let quiet = Submenu::with_items(
        app,
        i18n::t(i18n::msg::SYS_TRAY_MOD_09),
        true,
        &[&quiet30, &quiet60, &quiet_morning, &quiet_sep, &quiet_resume],
    )?;
    // 提醒计划（C13）：关掉即删除计划任务 —— 应用退出后就不再被唤醒
    // round66（C12）：便携模式不碰系统计划任务 → 这一项置灰、文案写明
    let (sched_enabled, sched_checked, sched_label) = scheduler_item_state(
        app.state::<crate::portable::DataPaths>().portable,
        crate::notify::scheduler_enabled_from_app(app),
    );
    let scheduler = CheckMenuItem::with_id(
        app,
        "scheduler",
        sched_label,
        sched_enabled,
        sched_checked,
        None::<&str>,
    )?;
    if let Ok(mut slot) = SCHEDULER_ITEM.lock() {
        *slot = Some(scheduler.clone());
    }
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", i18n::t(i18n::msg::SYS_TRAY_MOD_10), true, None::<&str>)?;
    Menu::with_items(app, &[&open, &quiet, &scheduler, &separator, &quit])
}

fn build(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let menu = build_menu(app)?;

    TrayIconBuilder::with_id("main")
        .icon(Image::new_owned(
            icons::for_state(TrayState::Default, taskbar_light()),
            icons::SIZE,
            icons::SIZE,
        ))
        .tooltip(TrayState::Default.tooltip())
        .menu(&menu)
        .show_menu_on_left_click(false) // 左键 = 打开窗口，不是弹菜单
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            // round63（C18 / R41）：免打扰三档 + 恢复（写同一把 `settings`）
            "quiet30" => apply_quiet(app, crate::db::now() + 30 * 60),
            "quiet60" => apply_quiet(app, crate::db::now() + 60 * 60),
            "quiet_morning" => {
                let now = crate::db::now();
                let until = {
                    let state = app.state::<AppState>();
                    let guard = match state.db.lock() {
                        Ok(guard) => guard,
                        Err(e) => {
                            eprintln!("[tray] 数据库锁失效：{e}（免打扰未生效）");
                            return;
                        }
                    };
                    crate::notify::quiet_until_morning(&guard, now)
                };
                apply_quiet(app, until);
            }
            "quiet_resume" => apply_quiet(app, 0),
            "scheduler" => {
                if app.state::<crate::portable::DataPaths>().portable {
                    eprintln!("[tray] 便携模式：提醒计划不可用");
                    return;
                }
                // 以 **settings 里的值**为准取反（而不是读菜单自己的勾选状态）——
                // Windows 的勾选菜单项**不会自动翻转**，若依赖 `is_checked()` 写回，
                // 点下去会“看起来毫无反应”（写回同一个值）。写成确定性逻辑后，
                // 不管系统是否自动翻转，结果都对。
                let next = !crate::notify::scheduler_enabled_from_app(app);
                crate::notify::set_scheduler_enabled(app, next);
                paint_scheduler_checked(app);
            }
            "quit" => {
                eprintln!("[tray] 菜单选择退出");
                app.exit(0);
            }
            other => eprintln!("[tray] 未知菜单项：{other}"),
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)
}

/// round63（C18 / R41）：写免打扰截止时刻并同步菜单（子菜单三档 + 恢复共用）
fn apply_quiet(app: &AppHandle, until: i64) {
    {
        let state = app.state::<AppState>();
        let guard = match state.db.lock() {
            Ok(guard) => guard,
            Err(e) => {
                eprintln!("[tray] 数据库锁失效：{e}（免打扰未生效）");
                return;
            }
        };
        if let Err(e) =
            crate::db::set_setting(&guard, crate::notify::QUIET_UNTIL_KEY, &until.to_string())
        {
            eprintln!("[tray] 保存免打扰失败：{e}");
        }
        // round68（19.1）：暗章信号（开过一次免打扰）—— 恢复提醒（until=0）不算
        if until > 0 {
            if let Err(e) = crate::achievements::note(&guard, "quiet") {
                eprintln!("[achievements] 信号 quiet 失败（忽略）：{e}");
            }
        }
    }
    eprintln!(
        "[tray] 免打扰 → {}",
        if until == 0 {
            "恢复提醒".to_string()
        } else {
            format!("静音至 {}", format_local(until))
        }
    );
    sync_quiet(app, crate::db::now());
}

/// 菜单里「暂停到明早 HH:MM」与「恢复提醒」两行的同步 ——
/// 设置面板 / 托盘子菜单 / **自然过期**都走它（提醒线程每轮都会调；只在真的变了才动菜单）。
/// 任意线程可调：菜单改动排队到主线程 —— 与 `set_icon`/`set_tooltip` 同一条纪律（见文件头）。
pub fn sync_quiet(app: &AppHandle, now: i64) {
    let Some((until, morning, changed)) = quiet_snapshot(app, now) else {
        return;
    };
    if !changed {
        return;
    }
    let app = app.clone();
    if let Err(e) = app.run_on_main_thread(move || paint_quiet_menu(until, morning, now)) {
        eprintln!("[tray] 排队更新「暂停提醒」菜单失败：{e}");
    }
}

/// `init` 专用（本身已在主线程）：直接渲染，不给自己排队
fn sync_quiet_at_startup(app: &AppHandle) {
    let now = crate::db::now();
    if let Some((until, morning, changed)) = quiet_snapshot(app, now) {
        if changed {
            paint_quiet_menu(until, morning, now);
        }
    }
}

/// 读免打扰快照 + 「跟上一次渲染相比变了吗」（锁不到库 → `None`，静默跳过）
fn quiet_snapshot(app: &AppHandle, now: i64) -> Option<(i64, String, bool)> {
    let (until, morning) = {
        let state = app.state::<AppState>();
        let guard = state.db.lock().ok()?;
        let (h, m) = crate::notify::quiet_morning(&guard);
        (crate::notify::quiet_until(&guard), format!("{h:02}:{m:02}"))
    };
    let state_now = quiet_menu_state(until, &morning, now);
    let changed = {
        let mut rendered = match QUIET_RENDERED.lock() {
            Ok(guard) => guard,
            Err(e) => e.into_inner(), // 渲染状态不吃毒锁：拿回数据继续用
        };
        if *rendered == state_now {
            false
        } else {
            *rendered = state_now;
            true
        }
    };
    Some((until, morning, changed))
}

/// 菜单渲染状态（**纯函数**）：（截止时刻, 明早, **此刻是否静音**）—— 三样任一变化都要重画。
///
/// 「此刻是否静音」必须进状态：静音**自然过期**时截止时刻没变 ——
/// 只看前两项会漏掉这一次重画，菜单会一直留着「已暂停至 …」直到下次改静音或重启
/// （round63 交付前 6b 抓到，P2）。
fn quiet_menu_state(until: i64, morning: &str, now: i64) -> (i64, String, bool) {
    (until, morning.to_string(), until > now)
}

/// `sync_quiet` 的主线程渲染部分（不得在其他线程直接调）
fn paint_quiet_menu(until: i64, morning: String, now: i64) {
    let morning_item = QUIET_MORNING_ITEM.lock().ok().and_then(|g| g.clone());
    if let Some(item) = morning_item {
        if let Err(e) = item.set_text(tf!(i18n::msg::SYS_TRAY_MOD_11, morning = morning)) {
            eprintln!("[tray] 更新「暂停到明早」文案失败：{e}");
        }
    }
    let resume_item = QUIET_RESUME_ITEM.lock().ok().and_then(|g| g.clone());
    if let Some(item) = resume_item {
        let muted = until > now;
        let text = if muted {
            tf!(i18n::msg::SYS_TRAY_MOD_12, p1 = format_local(until))
        } else {
            i18n::t(i18n::msg::SYS_TRAY_MOD_13).to_string()
        };
        if let Err(e) = item.set_text(text) {
            eprintln!("[tray] 更新「恢复提醒」文案失败：{e}");
        }
        if let Err(e) = item.set_enabled(muted) {
            eprintln!("[tray] 更新「恢复提醒」可用性失败：{e}");
        }
    }
}

/// 本地日期 + 时刻（菜单文案用）—— round81（3.1c₁）起跟 `time_format` / `date_format`，
/// 与本仓前端**同一套口径**（实现在 `crate::datetime`）
fn format_local(ts: i64) -> String {
    crate::datetime::format_stamp(ts)
}

/// round66（C12）：计划任务菜单项该长什么样 —— 便携模式下不可用（你 2026-10-05 选的 1）。
/// 纯函数：返回（能不能点、勾选显示、菜单文案）。
pub(crate) fn scheduler_item_state(portable: bool, enabled: bool) -> (bool, bool, &'static str) {
    if portable {
        (false, false, i18n::t(i18n::msg::SYS_TRAY_MOD_14))
    } else {
        (true, enabled, i18n::t(i18n::msg::SYS_TRAY_MOD_15))
    }
}

/// round63（C18）：从设置面板改「提醒计划」时，把托盘菜单的勾选状态也拨过去
/// （托盘菜单里改的那条路径自己会拨；两条路径共用一个值 = `settings` 表）
pub fn sync_scheduler_item(app: &AppHandle, enabled: bool) {
    // 便携模式下置灰（永远不勾）—— 这个值只用来画勾，用不上的分支不必传下去
    let (_, checked, _) =
        scheduler_item_state(app.state::<crate::portable::DataPaths>().portable, enabled);
    let app = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        let item = SCHEDULER_ITEM.lock().ok().and_then(|g| g.clone());
        if let Some(item) = item {
            if let Err(e) = item.set_checked(checked) {
                eprintln!("[tray] 更新「提醒计划」勾选状态失败：{e}");
            }
        }
    }) {
        eprintln!("[tray] 排队更新「提醒计划」勾选失败：{e}");
    }
}

/// 把当前设置里的「提醒计划」勾选状态画进菜单（**必须在主线程调**）
fn paint_scheduler_checked(app: &AppHandle) {
    let item = SCHEDULER_ITEM.lock().ok().and_then(|g| g.clone());
    if let Some(item) = item {
        if let Err(e) = item.set_checked(crate::notify::scheduler_enabled_from_app(app)) {
            eprintln!("[tray] 更新「提醒计划」勾选状态失败：{e}");
        }
    }
}

/// round74（3.0b₂）：语言切换后**重建托盘菜单** —— 文案 / 勾选 / 免打扰两行都按新语言重画。
/// 只换菜单不重建图标（位置与左键行为不变）；排队到主线程，遵守「托盘只在主线程动」。
pub fn refresh_menu(app: &AppHandle) {
    let app = app.clone();
    if let Err(e) = app.clone().run_on_main_thread(move || {
        let Some(tray) = app.tray_by_id("main") else {
            return;
        };
        match build_menu(&app) {
            Ok(menu) => {
                if let Err(e) = tray.set_menu(Some(menu)) {
                    eprintln!("[tray] 重建菜单失败：{e}");
                    return;
                }
            }
            Err(e) => {
                eprintln!("[tray] 重建菜单失败：{e}");
                return;
            }
        }
        paint_scheduler_checked(&app);
        let now = crate::db::now();
        if let Some((until, morning, _)) = quiet_snapshot(&app, now) {
            paint_quiet_menu(until, morning, now);
        }
        // tooltip（当前任务一行提示）也按新语言重画一次
        paint_current();
    }) {
        eprintln!("[tray] 排队重建菜单失败：{e}");
    }
}

/// 显示并聚焦主窗口。托盘左键/菜单用，也用于「点通知主体」（见 notify.rs 的 BodyClicked）。
pub(crate) fn show_main(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(window) => {
            let _ = window.show();
            let _ = window.unminimize();
            if let Err(e) = window.set_focus() {
                eprintln!("[tray] 聚焦主窗口失败：{e}");
            }
        }
        None => eprintln!("[tray] 找不到主窗口（检查 tauri.conf.json 的 windows 配置）"),
    }
}

/// 从库里算基线：有进行中的块 → HasCurrentTask；否则 Default（B1-1/B1-2）
fn baseline(app: &AppHandle) -> TrayState {
    let now = db::now();
    let state = app.state::<AppState>();
    let guard = match state.db.lock() {
        Ok(guard) => guard,
        Err(e) => {
            eprintln!("[tray] 数据库锁失效：{e}");
            return TrayState::Default;
        }
    };
    match db::has_current_block(&guard, now) {
        Ok(true) => TrayState::HasCurrentTask,
        Ok(false) => TrayState::Default,
        Err(e) => {
            eprintln!("[tray] 查询当前块失败：{e}");
            TrayState::Default
        }
    }
}

/// 请求「按当前状态重画一帧」。**托盘必须在主线程操作** —— 见文件头说明。
fn request_repaint(app: &AppHandle) {
    let app = app.clone();
    if let Err(e) = app.run_on_main_thread(paint_current) {
        eprintln!("[tray] 排队重画失败：{e}");
    }
}

/// 这一帧该画什么：闪烁中且处于「灭」相位 → 全透明；否则按状态画。
/// 抽成纯函数是为了可测 —— 尤其是「闪烁停了但相位还停在灭」这种会留下空白图标的坑（B2-2）。
fn frame(state: TrayState, blinking: bool, lit: bool, light_taskbar: bool) -> Vec<u8> {
    if state.should_blink() && blinking && !lit {
        icons::blank()
    } else {
        icons::for_state(state, light_taskbar)
    }
}

/// 唯一的渲染出口。调用者必须保证它在主线程执行（`request_repaint` 或 `init`）。
fn paint_current() {
    let Some(tray) = TRAY.get() else {
        return; // 托盘不可用：静默（init 已经记过日志）
    };
    let state = TrayState::from_index(CURRENT.load(Ordering::SeqCst)).unwrap_or(TrayState::Default);
    let pixels = frame(
        state,
        BLINKING.load(Ordering::SeqCst),
        BLINK_LIT.load(Ordering::SeqCst),
        taskbar_light(),
    );
    if let Err(e) = tray.set_icon(Some(Image::new_owned(pixels, icons::SIZE, icons::SIZE))) {
        eprintln!("[tray] 设置图标失败：{e}");
    }
    let hint = TOOLTIP_HINT.lock().map(|g| g.clone()).unwrap_or_default();
    let tooltip = tooltip_text(state, &hint);
    if let Err(e) = tray.set_tooltip(Some(&tooltip)) {
        eprintln!("[tray] 设置提示文字失败：{e}");
    }
}

/// 开始闪烁：起一个**只在闪烁期间存在**的线程（B2-1/B2-3/B2-4）。
/// 线程只做两件事：翻相位、请主线程重画 —— 绝不自己碰托盘（否则会卡住 UI，见文件头）。
/// 结束时**不恢复**图标：恢复由 `set_state` 重画完成，这样不会留下过期的三角。
/// 开始闪烁：起一个**只在本世代内存在**的线程（B2-1/B2-3/B2-4）。
/// 线程只做两件事：翻相位、请主线程重画 —— 绝不自己碰托盘（否则会卡住 UI，见文件头）。
/// 退出条件看的是 `epoch`（不是 BLINKING）：这样新世代一起，旧线程就不再装"复活"。
/// 结束时**不恢复**图标：恢复由 `set_state` 重画完成，这样不会留下过期的三角。
fn start_blink(app: &AppHandle, epoch: u64) {
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(BLINK_INTERVAL);
            if BLINK_EPOCH.load(Ordering::SeqCst) != epoch {
                break; // 状态已变（或已进入下一轮）：交给 set_state 重画
            }
            BLINK_LIT.fetch_xor(true, Ordering::SeqCst);
            request_repaint(&app);
        }
        eprintln!("[tray] 闪烁结束");
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [TrayState; 4] = [
        TrayState::Default,
        TrayState::HasCurrentTask,
        TrayState::HighPriorityReminder,
        TrayState::SanityOverload,
    ];

    /// round64（C10）：托盘状态开关关掉 → 一律按 Default；开着时原样
    /// （图标肉眼看不见的东西靠单测钉 —— CHECK 规矩 5）
    #[test]
    fn test_gated_state_switch_off_forces_default() {
        for state in ALL {
            assert_eq!(gated_state(state, false), TrayState::Default, "{state:?} 关掉后都该是默认");
            assert_eq!(gated_state(state, true), state, "{state:?} 开着时原样");
        }
    }

    /// 标签双向一致：前端/C6 传字符串 → 状态；状态 → 日志文字
    #[test]
    fn test_label_round_trip() {
        for state in ALL {
            assert_eq!(
                TrayState::from_label(state.as_label()),
                Some(state),
                "标签解析必须能还原状态"
            );
        }
    }

    /// 下标双向一致，且非法下标返回 None（atomic 里的初值就是非法的 UNKNOWN）
    #[test]
    fn test_index_round_trip() {
        for state in ALL {
            assert_eq!(TrayState::from_index(state.index()), Some(state));
        }
        assert_eq!(TrayState::from_index(UNKNOWN), None, "UNKNOWN 不该是合法状态");
        assert_eq!(TrayState::from_index(4), None);
    }

    /// 未知字符串 → None（调用方兜底，不能 panic）
    #[test]
    fn test_unknown_label_is_none() {
        assert_eq!(TrayState::from_label(""), None);
        assert_eq!(TrayState::from_label("done"), None);
        assert_eq!(TrayState::from_label("High_Priority"), None, "大小写不匹配也算未知");
    }

    /// 只有高优先级提醒需要闪烁；其余状态都必须停（B2-2）
    /// round62.1（你验收实测）：悬停**永远**看得见当前任务 —— 只有空提示才回退状态文案
    #[test]
    fn test_tooltip_shows_current_task_even_in_special_states() {
        let body = "写周报 · 还剩 23 分";
        // 正常态：你拍板的格式（任务 · 还剩 X 分 — WakeyWeeky）
        assert_eq!(
            tooltip_text(TrayState::HasCurrentTask, body),
            "写周报 · 还剩 23 分 — WakeyWeeky"
        );
        // 超载 / 提醒态：状态文案在前，当前任务并排在后（悬停永远能看见在干什么）
        assert_eq!(
            tooltip_text(TrayState::SanityOverload, body),
            "WakeyWeeky · 今天排得偏重 · 写周报 · 还剩 23 分"
        );
        assert_eq!(
            tooltip_text(TrayState::HighPriorityReminder, body),
            "WakeyWeeky · 有提醒待处理 · 写周报 · 还剩 23 分"
        );
        assert_eq!(
            tooltip_text(TrayState::Default, body),
            "WakeyWeeky · 写周报 · 还剩 23 分"
        );
        // 空提示 → 状态自己的文案（四态不变）
        for state in [
            TrayState::Default,
            TrayState::HasCurrentTask,
            TrayState::HighPriorityReminder,
            TrayState::SanityOverload,
        ] {
            assert_eq!(
                tooltip_text(state, ""),
                state.tooltip(),
                "{state:?} 无提示时用状态文案"
            );
        }
    }

    #[test]
    fn test_only_reminder_blinks() {
        assert!(TrayState::HighPriorityReminder.should_blink());
        for state in ALL {
            if state != TrayState::HighPriorityReminder {
                assert!(!state.should_blink(), "{state:?} 不应闪烁");
            }
        }
    }

    /// 每个状态都有非空提示文字
    #[test]
    fn test_tooltip_not_empty() {
        for state in ALL {
            assert!(state.tooltip().contains("WakeyWeeky"), "{state:?} 缺少提示文字");
        }
    }

    /// 只有基线态会被基线刷新覆盖
    #[test]
    fn test_only_baseline_states_are_overwritable() {
        assert!(TrayState::Default.is_baseline());
        assert!(TrayState::HasCurrentTask.is_baseline());
        assert!(!TrayState::HighPriorityReminder.is_baseline(), "提醒态不能被基线刷掉");
        assert!(!TrayState::SanityOverload.is_baseline(), "超载态不能被基线刷掉");
        assert!(!READY.load(Ordering::SeqCst), "测试里没建过托盘，不应是就绪状态");
    }

    /// C6（round44）：托盘状态机 —— 提醒态优先 / 超载进出 / 基线刷新（纯函数，规矩 5）
    #[test]
    fn test_resolve_state_priorities() {
        use TrayState::{Default, HasCurrentTask, HighPriorityReminder, SanityOverload};
        // 提醒进行中：基线、超载都不抢（B1-4）
        assert_eq!(resolve_state(Some(HighPriorityReminder), Default, true), None);
        // 超载：从基线与默认都切过去
        assert_eq!(resolve_state(Some(Default), Default, true), Some(SanityOverload));
        assert_eq!(resolve_state(Some(HasCurrentTask), HasCurrentTask, true), Some(SanityOverload));
        // 已在超载 + 仍超载：不动（免得反复重画）
        assert_eq!(resolve_state(Some(SanityOverload), Default, true), None);
        // 不再超载：交还基线（不卡红环）
        assert_eq!(
            resolve_state(Some(SanityOverload), HasCurrentTask, false),
            Some(HasCurrentTask)
        );
        // 基线态之间的正常刷新；没变化就不动
        assert_eq!(resolve_state(Some(Default), HasCurrentTask, false), Some(HasCurrentTask));
        assert_eq!(resolve_state(Some(HasCurrentTask), HasCurrentTask, false), None);
        // 状态还没初始化：不在这儿画（`tray::init` 会画首帧）
        assert_eq!(resolve_state(None, Default, false), None);
    }

    /// 帧内容：只有「提醒态 + 正在闪 + 灭相位」才是全透明（B2-1）
    #[test]
    fn test_frame_is_blank_only_on_dark_blink_phase() {
        let reminder = TrayState::HighPriorityReminder;
        assert_eq!(frame(reminder, true, false, true), icons::blank(), "灭相位该是全透明");
        assert_ne!(frame(reminder, true, true, true), icons::blank(), "亮相位要有图标");
        assert_ne!(
            frame(reminder, false, false, true),
            icons::blank(),
            "闪烁已停时**绝不能**因为相位还在「灭」就画空白图标（B2-2 的坑）"
        );
    }

    /// 其他状态永远不透明（闪烁是提醒态专属）
    #[test]
    fn test_frame_never_blank_for_other_states() {
        for state in [TrayState::Default, TrayState::HasCurrentTask, TrayState::SanityOverload] {
            for lit in [true, false] {
                for light in [true, false] {
                    assert_ne!(
                        frame(state, true, lit, light),
                        icons::blank(),
                        "{state:?} 不该画成空图标"
                    );
                }
            }
        }
    }

    /// round63（6b 修正）：免打扰**自然过期**时渲染状态要变 —— 菜单才会把「恢复提醒」拨回不可用
    #[test]
    fn test_quiet_menu_state_repaints_on_expiry() {
        let now = 1_000_000;
        let before = quiet_menu_state(now + 600, "08:00", now);
        assert!(before.2, "静音中");
        let after = quiet_menu_state(now + 600, "08:00", now + 601);
        assert!(!after.2, "过期后不再静音");
        assert_ne!(before, after, "自然过期 → 状态要变（菜单才会重画）");
        assert_eq!(
            quiet_menu_state(now + 600, "08:00", now + 500),
            before,
            "还没到期 → 状态不变（不要每轮都改菜单）"
        );
        assert_ne!(
            quiet_menu_state(now + 600, "09:00", now),
            before,
            "「明早」时刻改了也要重画"
        );
    }

    /// round66（C12 / P7）：便携模式下「提醒计划」置灰 + 文案写明
    #[test]
    fn test_scheduler_item_state_in_portable() {
        let (enabled, checked, label) = scheduler_item_state(true, true);
        assert!(!enabled && !checked, "便携模式不许点、也不显示勾");
        assert!(label.contains("便携"), "文案要说明为什么不能点：{label}");
        let (enabled, checked, label) = scheduler_item_state(false, true);
        assert!(enabled && checked);
        assert!(label.contains("关闭应用后"));
        let (_, checked, _) = scheduler_item_state(false, false);
        assert!(!checked);
    }
}
