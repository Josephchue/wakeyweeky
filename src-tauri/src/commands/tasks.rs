//! 任务相关命令：只做参数转换与锁管理，业务逻辑在 db.rs 的纯函数里。

use tauri::{AppHandle, State};

use crate::db::{self, Task};
use crate::commands::history::record;
use crate::AppState;
use crate::i18n;

#[tauri::command]
pub fn list_tasks(state: State<'_, AppState>) -> Result<Vec<Task>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_tasks(&conn)
}

#[tauri::command]
pub fn create_task(
    state: State<'_, AppState>,
    title: String,
    category: Option<String>,
) -> Result<Task, String> {
    create_task_impl(&state, title, category)
}

/// 命令本体：拆出 `&AppState` 一层，好让集成测试**直接调**（为什么需要，见 `commands/history.rs` 测试里的说明）。
pub(crate) fn create_task_impl(
    state: &AppState,
    title: String,
    category: Option<String>,
) -> Result<Task, String> {
    record(state, i18n::t(i18n::msg::ERR_CMD_TASKS_01), |conn| db::create_task(conn, &title, category.as_deref()))
}

/// 改任务名。名字存在 tasks 表里；块只存 task_id，时间轴上的名字由前端从任务 store 里取 ——
/// 所以改完**不需要**动 blocks、也不需要广播刷新，前端更新 store 即可（R9）。
#[tauri::command]
pub fn rename_task(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> Result<Task, String> {
    record(&state, i18n::t(i18n::msg::ERR_CMD_TASKS_02), |conn| db::rename_task(conn, &id, &title))
}

/// 改任务属性（v2 ④ 的 `update_task(id, patch)`：title / category / estimated_minutes / is_elastic）。
/// 补它的原因：在此之前 `is_elastic` 没有任何地方能设 —— 规范 ⑧B7 的
/// 「弹性任务 → 块默认进弹性层」永远走不到，README 的承诺是空的。
#[tauri::command]
pub fn update_task(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    title: Option<String>,
    category: Option<String>,
    estimated_minutes: Option<i64>,
    is_elastic: Option<bool>,
) -> Result<Task, String> {
    let task = record(&state, i18n::t(i18n::msg::ERR_CMD_TASKS_03), |conn| {
        db::update_task(conn, &id, title, category, estimated_minutes, is_elastic)
    })?;
    // 任务名会影响块上显示的名字（时间轴按 task_id 取），弹性属性影响后续建块默认层 → 广播刷新
    crate::broadcast_block_updated(&app);
    Ok(task)
}

/// round48：任务级「不计入理智值」（用户 2026-10-03 拍板：由任务决定，不由时间块决定）。
/// 为什么单独一条命令（不塞进 `update_task`）：① 撤销提示能说清「不计入理智 / 计入理智」
/// ② 要叫醒提醒线程让**托盘超载态**立刻跟着变（与当时块级那条同一个理由）。
#[tauri::command]
pub fn set_task_exempt(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    exempt: bool,
) -> Result<Task, String> {
    let task = record(
        &state,
        if exempt { i18n::t(i18n::msg::ERR_CMD_TASKS_04) } else { i18n::t(i18n::msg::ERR_CMD_TASKS_05) },
        |conn| db::set_task_exempt(conn, &id, exempt),
    )?;
    crate::broadcast_block_updated(&app);
    crate::notify::wake_notifier();
    Ok(task)
}

/// round48：Backlog 的**手动顺序**（用户 2026-10-03 提的需求；抓手拖动/`↑↓` 走这里）。
/// 按给定顺序把 `sort_order` 写成 0..N-1；走 `record` → `Ctrl+Z` 可撤。
/// **不广播**：顺序只在 Backlog 里读（时间轴上的块不按它排）。
#[tauri::command]
pub fn reorder_tasks(state: State<'_, AppState>, ids: Vec<String>) -> Result<usize, String> {
    reorder_tasks_impl(&state, ids)
}

/// 命令本体：拆出 `&AppState` 一层，好让集成测试**直接调**（与 `create_task_impl` 同一个理由）。
pub(crate) fn reorder_tasks_impl(state: &AppState, ids: Vec<String>) -> Result<usize, String> {
    record(state, i18n::t(i18n::msg::ERR_CMD_TASKS_06), |conn| db::reorder_tasks(conn, &ids))
}

/// 归档任务（v2 ④ 的 `archive_task`；⑧B8：归档与删除都要有）——写 `archived_at`，不删数据
#[tauri::command]
pub fn archive_task(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    record(&state, i18n::t(i18n::msg::ERR_CMD_TASKS_07), |conn| db::archive_task(conn, &id))?;
    // 归档后不再出现在 Backlog，但它在时间轴上的块仍在 → 广播让各视图刷新
    crate::broadcast_block_updated(&app);
    Ok(())
}

/// 取消归档（round38 / 任务面板的「恢复」）——与 `archive_task` 对称：
/// 同样走 `record`（**Ctrl+Z 可撤**），同样广播（它重新回到 Backlog）。
#[tauri::command]
pub fn unarchive_task(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    record(&state, i18n::t(i18n::msg::ERR_CMD_TASKS_08), |conn| db::unarchive_task(conn, &id))?;
    crate::broadcast_block_updated(&app);
    Ok(())
}

/// 分类改名 / 合并 / 清空（8.1 分类管理）—— 一次改掉整个分类下的所有任务（含已归档）。
/// **合并就是改成一个已有分类名**（不需要单独的 merge 命令）；`to` 传空串 = 这些任务回到「未分类」。
/// 走 `record` → `Ctrl+Z` 可撤；分类不参与块渲染，所以**不广播**（前端改完就地把 store 同步一遍）。
#[tauri::command]
pub fn rename_category(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<usize, String> {
    rename_category_impl(&state, from, to)
}

/// 命令本体：拆出 `&AppState` 一层，好让集成测试**直接调**（与 `create_task_impl` 同一个理由）。
pub(crate) fn rename_category_impl(
    state: &AppState,
    from: String,
    to: String,
) -> Result<usize, String> {
    record(state, i18n::t(i18n::msg::ERR_CMD_TASKS_09), |conn| db::rename_category(conn, &from, &to))
}

#[tauri::command]
pub fn delete_task(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<i64, String> {
    // round40：回报「连带删了几个块」—— 界面上的撤销条要说清楚毁掉了什么
    let deleted = record(&state, i18n::t(i18n::msg::ERR_CMD_TASKS_10), |conn| db::delete_task(conn, &id))?;
    // 删任务会级联删掉它的块 → 同样要广播（浮窗据此收起被删的条目）+ 叫醒提醒线程
    crate::broadcast_block_updated(&app);
    crate::notify::wake_notifier();
    Ok(deleted)
}
