//! round66（C12）：全局快捷键的**唯一实现** —— 候选键位（`Win+Shift+W` → `Ctrl+Alt+W`）、
//! 注册 / 注销 / 冲突退化与状态记录。
//!
//! 设计（七段 + 边界表 H1–H6）：`docs/plans/round66-c12-portable-and-hotkeys.md`。
//! 为什么用官方 `tauri-plugin-global-shortcut`（你 2026-10-05 批准）：Windows 上走系统热键
//! （`RegisterHotKey`），冲突时 `register` 返回 `Err`，能捕获、能退化；**只在 Rust 侧注册**，
//! 前端不加包、capabilities 不动。
//!
//! 单测策略：注册动作抽成 [`Registrar`]，测试注入假实现 —— **绝不在测试机上抢真热键**。

use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

use crate::features;
use crate::i18n;
use crate::tf;

/// 主键位（v2 ⑧D3 的默认；Windows 文档说 Win 组合键「保留给系统」→ 必须实机试）
pub const PRIMARY_LABEL: &str = "Win+Shift+W";
/// 备键位（D3：冲突就退化）
pub const FALLBACK_LABEL: &str = "Ctrl+Alt+W";
/// 第三档（2026-10-05 验收实机：W 家族在用户机上被多处占用 —— Ctrl+Alt+W / Win+Shift+W / Win+Alt+W 全占；加一档把功能救回来）
pub const FALLBACK2_LABEL: &str = "Ctrl+Alt+Shift+W";

/// 主键位
pub fn primary() -> Shortcut {
    Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyW)
}

/// 备键位
pub fn fallback() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyW)
}

/// 第三档键位
pub fn fallback2() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT), Code::KeyW)
}

/// 候选键位（主 → 备 → 三档，依次试）
pub fn candidates() -> Vec<(&'static str, Shortcut)> {
    vec![
        (PRIMARY_LABEL, primary()),
        (FALLBACK_LABEL, fallback()),
        (FALLBACK2_LABEL, fallback2()),
    ]
}

/// 当前状态（`hotkey_status` 命令给前端：注册上了哪个 / 为什么没注册上）
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct HotkeyStatus {
    /// 真正注册上的键位（`None` = 没注册：关掉了 / 两个都被占用）
    pub active: Option<String>,
    /// 两个键位都注册不上时的原因（前端一次性提示用）
    pub error: Option<String>,
}

static STATUS: Mutex<HotkeyStatus> = Mutex::new(HotkeyStatus {
    active: None,
    error: None,
});

/// 读当前状态（命令层用）
pub fn status() -> HotkeyStatus {
    match STATUS.lock() {
        Ok(guard) => guard.clone(),
        Err(e) => {
            eprintln!("[hotkeys] 状态锁失效：{e}");
            HotkeyStatus::default()
        }
    }
}

fn set_status(active: Option<String>, error: Option<String>) {
    match STATUS.lock() {
        Ok(mut guard) => {
            guard.active = active;
            guard.error = error;
        }
        Err(e) => eprintln!("[hotkeys] 写状态失败：{e}"),
    }
}

/// 注册 / 注销的抽象 —— 真实现走插件；单测注入假注册器
pub trait Registrar {
    fn register(&self, shortcut: Shortcut) -> Result<(), String>;
    fn unregister(&self, shortcut: Shortcut) -> Result<(), String>;
}

/// 挑一套能用的键位：主键冲突就试备用；都失败返回**两个**原因（H2 / H3）
pub fn pick(reg: &dyn Registrar) -> Result<(Shortcut, String), String> {
    let mut reasons = Vec::new();
    for (label, shortcut) in candidates() {
        match reg.register(shortcut) {
            Ok(()) => return Ok((shortcut, label.to_string())),
            Err(e) => reasons.push(tf!(i18n::msg::SYS_HOTKEYS_01, label = label, e = e)),
        }
    }
    Err(reasons.join(i18n::t(i18n::msg::SYS_HOTKEYS_02)))
}

/// `sync` 该做什么（纯判定；H4 / H5 的决策表）
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Register,
    Unregister,
    Nothing,
}

pub fn plan_action(enabled: bool, active: Option<&str>) -> Action {
    match (enabled, active) {
        (true, None) => Action::Register,
        (false, Some(_)) => Action::Unregister,
        _ => Action::Nothing,
    }
}

/// 与设置同步（**幂等**）：开 → 没注册就注册；关 → 注册着就注销（不用重启，H4 / H5）
pub fn sync(app: &AppHandle) {
    let enabled = enabled_from_db(app);
    let active = status().active;
    match plan_action(enabled, active.as_deref()) {
        Action::Nothing => {}
        Action::Register => match pick(&PluginRegistrar::new(app)) {
            Ok((_, label)) => {
                eprintln!("[hotkeys] 已注册 {label}");
                set_status(Some(label), None);
            }
            Err(e) => {
                eprintln!("[hotkeys] 注册失败（两个键位都被占用？）：{e}");
                set_status(None, Some(e));
            }
        },
        Action::Unregister => {
            let wanted = active.clone();
            let shortcut = candidates()
                .into_iter()
                .find(|(label, _)| *label == wanted.as_deref().unwrap_or_default())
                .map(|(_, shortcut)| shortcut);
            match shortcut {
                Some(shortcut) => match PluginRegistrar::new(app).unregister(shortcut) {
                    Ok(()) => {
                        eprintln!(
                            "[hotkeys] 已注销 {}",
                            wanted.as_deref().unwrap_or_default()
                        );
                        set_status(None, None);
                    }
                    // 注销失败：状态**保持原样**（下次再试），不假装关掉了
                    Err(e) => eprintln!("[hotkeys] 注销失败：{e}（保持原状）"),
                },
                None => set_status(None, None),
            }
        }
    }
}

/// 读功能开关（默认开；读失败按开处理 —— 与 `features::enabled` 同一口径）
fn enabled_from_db(app: &AppHandle) -> bool {
    let state = app.state::<crate::AppState>();
    // 先把值取出来再返回 —— 直接 ``match`` 当尾表达式会让锁临时值活得比 ``state`` 久（E0597）
    let enabled = match state.db.lock() {
        Ok(guard) => features::enabled(&guard, features::HOTKEYS),
        Err(e) => {
            eprintln!("[hotkeys] 数据库锁失效：{e}（按开处理）");
            true
        }
    };
    enabled
}

/// 真实现：走插件的 `global_shortcut()`
struct PluginRegistrar {
    app: AppHandle,
}

impl PluginRegistrar {
    fn new(app: &AppHandle) -> Self {
        Self { app: app.clone() }
    }
}

impl Registrar for PluginRegistrar {
    fn register(&self, shortcut: Shortcut) -> Result<(), String> {
        self.app
            .global_shortcut()
            .register(shortcut)
            .map_err(|e| e.to_string())
    }

    fn unregister(&self, shortcut: Shortcut) -> Result<(), String> {
        self.app
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// 假注册器：按脚本返回结果、记录被问过几次（**不碰真键盘**）
    struct Fake {
        results: RefCell<Vec<Result<(), String>>>,
        calls: RefCell<Vec<&'static str>>,
    }

    impl Fake {
        fn new(results: Vec<Result<(), String>>) -> Self {
            Self {
                results: RefCell::new(results),
                calls: RefCell::new(Vec::new()),
            }
        }
    }

    impl Registrar for Fake {
        fn register(&self, _shortcut: Shortcut) -> Result<(), String> {
            self.calls.borrow_mut().push("register");
            self.results.borrow_mut().remove(0)
        }

        fn unregister(&self, _shortcut: Shortcut) -> Result<(), String> {
            self.calls.borrow_mut().push("unregister");
            Ok(())
        }
    }

    /// H1：首选键位没冲突 → 用它
    #[test]
    fn test_pick_prefers_primary() {
        let fake = Fake::new(vec![Ok(())]);
        let (_, label) = pick(&fake).expect("应当注册成功");
        assert_eq!(label, PRIMARY_LABEL);
        assert_eq!(fake.calls.borrow().len(), 1);
    }

    /// H2：首选被占用 → 自动退化到备用
    #[test]
    fn test_pick_falls_back_on_conflict() {
        let fake = Fake::new(vec![Err("已经被别的程序注册了".to_string()), Ok(())]);
        let (_, label) = pick(&fake).expect("备用应当可用");
        assert_eq!(label, FALLBACK_LABEL);
        assert_eq!(fake.calls.borrow().len(), 2, "两个候选都要试");
    }

    /// 主 / 备都被占用 → 退到第三档（round66.1 实机：W 家族在用户机被多处占用）
    #[test]
    fn test_pick_falls_back_to_third() {
        let fake = Fake::new(vec![
            Err("主占".to_string()),
            Err("备占".to_string()),
            Ok(()),
        ]);
        let (_, label) = pick(&fake).expect("三档应当可用");
        assert_eq!(label, FALLBACK2_LABEL);
        assert_eq!(fake.calls.borrow().len(), 3, "三个候选都要试");
    }

    /// H3：三档都被占用 → 报错里带着**三个**原因（前端提示要有信息量）
    #[test]
    fn test_pick_reports_all_reasons() {
        let fake = Fake::new(vec![
            Err("主键冲突".to_string()),
            Err("备键也冲突".to_string()),
            Err("三档也冲突".to_string()),
        ]);
        let err = pick(&fake).expect_err("三个都冲突应当失败");
        assert!(
            err.contains("主键冲突") && err.contains("备键也冲突") && err.contains("三档也冲突"),
            "{err}"
        );
        assert_eq!(fake.calls.borrow().len(), 3);
    }

    /// H4 / H5：开/关 × 当前状态 → 该注册 / 该注销 / 什么都不做
    #[test]
    fn test_plan_action_table() {
        assert_eq!(plan_action(true, None), Action::Register);
        assert_eq!(plan_action(true, Some(PRIMARY_LABEL)), Action::Nothing);
        assert_eq!(plan_action(false, Some(PRIMARY_LABEL)), Action::Unregister);
        assert_eq!(plan_action(false, None), Action::Nothing);
    }

    /// 候选键位的标签唯一（注销时靠标签找回 Shortcut，不许重名）
    #[test]
    fn test_candidate_labels_are_unique() {
        let list = candidates();
        assert_eq!(list.len(), 3, "主 / 备 / 三档");
        assert_ne!(list[0].0, list[1].0);
        assert_ne!(list[1].0, list[2].0);
        assert_ne!(list[0].0, list[2].0);
    }
}
