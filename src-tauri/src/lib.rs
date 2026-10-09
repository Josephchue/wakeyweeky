// WakeyWeeky 后端入口（Tauri 2 的 lib 结构：main.rs 只调这里）
// 通知线程在任务 9 接入。

mod backup;
mod commands;
mod db;
mod datetime;
mod features;
mod appearance;
mod hint;
mod hints;
mod hotkeys;
mod i18n;
mod ics;
mod notify;
mod portable;
mod review;
mod repeats;
mod sanity;
mod scheduler;
mod stats;
mod templates;
mod tray;
mod achievements;

#[cfg(test)]
mod testutil;

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{Emitter, Manager};

/// 全局状态：单个 SQLite 连接 + Mutex（命令层与后台通知线程共用）。
/// 约定：锁的持有时间必须尽量短；MutexGuard 不得跨 sleep（见任务 9 的 notify.rs）。
pub struct AppState {
    pub db: Mutex<Connection>,
    /// C1.5：撤销/重做栈（**只在内存里**，重启即清空 —— 用户拍板）
    pub history: Mutex<commands::history::History>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例必须**最先**注册（官方惯例）：计划任务到点时应用可能已在运行，
        // 由它拦住新实例，并在**已在跑的那个实例**里执行回调。
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == scheduler::SCHEDULED_FLAG) {
                // 计划任务唤醒：只叫醒提醒线程（不弹窗口，免得打断你正在做的事）
                eprintln!("[scheduler] 已有实例在跑，按 --scheduled 只唤醒提醒线程");
                notify::wake_notifier();
            } else {
                // 用户又点了一次图标：把已有窗口带到前面（替掉以前会开出第二个窗口的行为）
                tray::show_main(app);
            }
        }))
        .plugin(tauri_plugin_notification::init())
        // round62（C14）：系统文件对话框（另存为 / 打开 / 确认）
        .plugin(tauri_plugin_dialog::init())
        // round77（3.1b）：**窗口大小与位置记忆**（你 2026-10-05 批准新增依赖）——
        // 官方插件：关窗/退出时把 SIZE|POSITION|MAXIMIZED 写到 `app_config_dir()/.window-state.json`；
        // 启动时恢复，**位置恢复自带「保存的那台显示器还在不在」判断**（多显示器安全）。
        // 便携模式下这份状态不跟 `data\` 走（已知口径，说明页写了一句）。
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        // round66（C12）：全局快捷键插件（你 2026-10-05 批准新增依赖）——只在 Rust 侧注册；
        // 具体注册 / 注销 / 冲突退化在 `hotkeys` 模块，插件这里只挂「按下就打开主窗口」的处理器。
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        tray::show_main(app);
                        // round68（19.1）：暗章信号（用全局快捷键唤回窗口）
                        if let Some(state) = app.try_state::<AppState>() {
                            commands::achievements::note_signal(&state, "hotkey");
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            let default_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| crate::tf!(i18n::msg::SYS_LIB_01, e = e))?;
            std::fs::create_dir_all(&default_dir)
                .map_err(|e| crate::tf!(i18n::msg::SYS_LIB_02, e = e))?;

            // round66（C12）：先定这次用哪份数据 —— exe 旁的 `portable.flag` 决定便携模式；
            // 便携目录建不出来 / 写不进去就回落默认位置（`note` 会在设置与说明页显示）。
            let exe = portable::exe_dir();
            let resolved = portable::resolve(exe.as_deref(), &default_dir);
            if let Some(note) = &resolved.note {
                eprintln!("[portable] {note}");
            }
            let mut paths = portable::DataPaths {
                dir: resolved.dir,
                default_dir,
                exe_dir: exe,
                portable: resolved.portable,
                fallback: resolved.fallback,
                note: resolved.note,
                flag: resolved.flag,
                adopted: false,
            };

            // round62（C14）：上次「从备份恢复」若已把待恢复文件放好 → 先换库（必须在 db::init 之前）。
            // 换库失败**不拦启动**：函数内部已经回滚（继续用旧库），`.incoming` 留着下次再试；
            // 这里只留日志、绝不把错误往上扔 —— Tauri 会把 setup 的 Err 变成启动 panic（release 无控制台，静默消失）。
            if let Err(e) = backup::apply_pending_restore(&paths.dir) {
                eprintln!("[backup] {e}（本次继续用旧库启动）");
            }

            // round66（C12 / P3）：便携目录头一回启用、还没有库 → 把默认位置的数据带一份过来
            // （原库不动）。失败就回落默认位置：宁可这次不用便携，也不能对着一个空库启动。
            if let Err(e) = portable::adopt_if_needed(&mut paths) {
                eprintln!("[portable] 带数据失败：{e}（这次先用默认位置）");
                portable::fall_back_after_adopt_failure(&mut paths, &e);
            }

            let conn = db::init(&portable::db_path(&paths.dir))?;
            // round74（3.0b₂）：语言必须在建托盘之前定 —— 菜单 / 通知 / 标题都按当前语言渲染
            match db::get_setting(&conn, crate::i18n::KEY) {
                Ok(Some(v)) => crate::i18n::set_locale(&v),
                Ok(None) => {}
                Err(e) => eprintln!("[i18n] 读语言设置失败：{e}（按默认中文）"),
            }
            eprintln!("[i18n] 语言 = {}（设置键 {}）", crate::i18n::locale(), crate::i18n::KEY);
            // round76（3.1a）：深浅色 —— 窗口主题在**首帧之前**定好（否则启动会闪一下亮色）
            // round82（3.1c₂ · 淡-04）：夜间档也在这里按**当前时刻**解析（否则首帧会先亮一下）
            match db::get_setting(&conn, appearance::KEY_THEME) {
                Ok(Some(_)) => appearance::sync_window_theme(app.handle(), &conn),
                Ok(None) => {}
                Err(e) => eprintln!("[appearance] 读深浅色设置失败：{e}（按跟随系统）"),
            }
            // round81（3.1c₁）：时间 / 日期格式 —— 托盘菜单的钟点先于前端渲染，这里先定好（缺省 = system）
            match db::get_setting(&conn, datetime::KEY_TIME_FORMAT) {
                Ok(Some(v)) => datetime::set_time_format(&v),
                Ok(None) => {}
                Err(e) => eprintln!("[datetime] 读时间格式失败：{e}（按跟随系统）"),
            }
            match db::get_setting(&conn, datetime::KEY_DATE_FORMAT) {
                Ok(Some(v)) => datetime::set_date_format(&v),
                Ok(None) => {}
                Err(e) => eprintln!("[datetime] 读日期格式失败：{e}（按跟随系统）"),
            }
            eprintln!(
                "[datetime] 时间格式 = {} / 日期格式 = {}",
                datetime::time_format(),
                datetime::date_format()
            );
            // round68（19.1）：成就默认开 —— 首次启动静默全量回溯（不弹提示，只写表）
            achievements::ensure_initialized(&conn);
            app.manage(paths);
            app.manage(AppState {
                db: Mutex::new(conn),
                history: Mutex::new(commands::history::History::default()),
            });
            // round68（19.1）：解锁提示要能广播到前端（没有窗口也能求值，只是不弹）
            achievements::attach_app(app.handle());

            // round66（C12）：注册全局快捷键（读功能开关；失败会退化 / 把原因记下来给前端提示）
            hotkeys::sync(app.handle());

            // 托盘：先建托盘再起提醒线程（提醒线程会刷新托盘基线）。
            // 失败只记日志、返回 false —— 应用照常运行，且关窗不会被拦截（见 on_window_event）。
            tray::init(app.handle());

            // 后台提醒线程：与命令层共用同一个连接，锁只在扫描期间短暂持有
            notify::start_notifier(app.handle().clone());

            // 计划任务唤醒（--scheduled）：隐藏启动，只留托盘 ——
            // 提醒照发（带 ✓/✗ 按钮的通知需要进程活着），但不往你眼前弹窗口。
            if std::env::args().any(|a| a == scheduler::SCHEDULED_FLAG) {
                match app.get_webview_window("main") {
                    Some(window) => match window.hide() {
                        Ok(_) => eprintln!("[scheduler] 被计划任务唤醒：主窗口保持隐藏，只留托盘"),
                        Err(e) => eprintln!("[scheduler] 隐藏主窗口失败：{e}"),
                    },
                    None => eprintln!("[scheduler] 找不到主窗口，无法隐藏"),
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // round82（3.1c₂ · `盘-03`）：系统模式（任务栏底色）变了 → 托盘图标换色重画
            if let tauri::WindowEvent::ThemeChanged(_) = event {
                tray::refresh_taskbar_theme(window.app_handle());
            }
            // 关闭主窗口 = 隐藏到托盘（用户拍板 R9）。
            // 仅当托盘**可用**时才拦截：托盘没建起来就拦截的话，用户会既关不掉也退不出。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && tray::is_ready() {
                    api.prevent_close();
                    if let Err(e) = window.hide() {
                        eprintln!("[tray] 隐藏主窗口失败：{e}");
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::tasks::list_tasks,
            commands::tasks::create_task,
            commands::tasks::rename_task,
            commands::tasks::update_task,
            commands::tasks::archive_task,
            commands::tasks::unarchive_task,
            commands::tasks::reorder_tasks,
            commands::tasks::set_task_exempt,
            commands::tasks::rename_category,
            commands::tasks::delete_task,
            commands::backup::export_backup,
            commands::backup::import_backup,
            commands::calendar::export_ics,
            commands::portable::get_data_info,
            commands::portable::apply_data_choice,
            commands::hotkeys::hotkey_status,
            commands::blocks::list_blocks,
            commands::blocks::create_block,
            commands::blocks::create_temp_block,
            commands::blocks::set_block_exempt,
            commands::blocks::delete_block,
            commands::blocks::mark_block_done,
            commands::blocks::mark_block_missed,
            commands::blocks::delete_blocks,
            commands::blocks::mark_blocks,
            commands::blocks::move_blocks,
            commands::blocks::set_blocks_layer,
            commands::blocks::update_block,
            commands::blocks::merge_pending_blocks,
            commands::blocks::postpone_block,
            // round69（B3）：复制手势 / 每周重复
            commands::blocks::create_blocks,
            commands::repeats::list_repeats,
            commands::repeats::create_repeat,
            commands::repeats::set_repeat_enabled,
            commands::repeats::delete_repeat,
            commands::repeats::generate_repeats,
            commands::tray::set_tray_state,
            commands::notify::missed_summary,
            commands::history::undo,
            commands::history::redo,
            commands::hints::take_hint,
            commands::sanity::get_sanity_curve,
            commands::review::get_week_mosaic,
            commands::review::take_review_nudge,
            commands::review::mark_review_seen,
            commands::stats::get_stats,
            commands::stats::reset_stats,
            commands::templates::list_templates,
            commands::templates::preview_week_skeleton,
            commands::templates::create_template,
            commands::templates::apply_template,
            commands::templates::delete_template,
            commands::templates::should_show_first_run,
            commands::templates::mark_first_run_seen,
            commands::templates::take_template_suggestion,
            commands::settings::get_settings,
            commands::settings::set_setting,
            commands::settings::reset_settings,
            // round81（3.1c₁ · 深-03）：`ui_locale=system` 时前端问它实际解析成哪种语言
            commands::settings::system_locale,
            // round82（3.1c₂ · 淡-05）：夜间档跨界 —— 前端 60 秒节拍调它重刷窗口主题（不写设置）
            commands::settings::refresh_window_theme,
            commands::sequences::create_sequence,
            commands::sequences::link_after,
            commands::sequences::remove_sequence_member,
            commands::sequences::delete_sequence,
            commands::sequences::list_sequences,
            // round68（19.1）：成就（暗章）
            commands::achievements::list_achievements,
            commands::achievements::reset_achievements,
            commands::achievements::note_achievement,
            commands::achievements::achievements_debug_unlock_all,
            commands::achievements::achievements_debug_lock_all,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 广播「块有变化」：任何窗口都能据此刷新。
/// 场景：在顶部浮窗里点了 ✓/✗，主窗口需要立刻同步（边界表 B4-1）。
pub fn broadcast_block_updated(app: &tauri::AppHandle) {
    if let Err(e) = app.emit("block-updated", ()) {
        eprintln!("[ipc] 广播块变更失败：{e}");
    }
}
