//! 任务序列命令（C3）：只做参数转换与锁管理，业务逻辑在 `db.rs` 的纯函数里。
//!
//! 链接流程（前端 `⛓` 按钮的链式交互）只用到两个动作：
//! 1. `sequence_of_block` 看第一个块是否已在序列里 → 决定「新建」还是「延长」；
//! 2. 新建走 `create_sequence`，延长走 `add_sequence_member`。
//!
//! 每个写操作之后都广播「块有变化」：界面据此重画细线与序号（与浮窗/时间轴的刷新同一套机制）。

use tauri::{AppHandle, State};

use crate::commands::history::record;
use crate::db::{self, MoveOutcome, Sequence};
use crate::AppState;
use crate::i18n;

/// 新建序列（至少 2 个块；块不能已属于别的序列）
#[tauri::command]
pub fn create_sequence(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    block_ids: Vec<String>,
) -> Result<Sequence, String> {
    let sequence = record(&state, i18n::t(i18n::msg::ERR_CMD_SEQUENCES_01), |conn| {
        db::create_sequence(conn, &name, &block_ids)
    })?;
    crate::broadcast_block_updated(&app);
    Ok(sequence)
}

/// 把 B 接在 A 后面（C3.3）：A 不在链里就新建一条 A→B，已经在链里就**插在 A 后面**；
/// 若 B 的时间不在 A 之后，后端会**自动顺延**它并把后面的环一起级联。
#[tauri::command]
pub fn link_after(
    app: AppHandle,
    state: State<'_, AppState>,
    after_block_id: String,
    block_id: String,
    name: Option<String>,
) -> Result<MoveOutcome, String> {
    let outcome = record(&state, i18n::t(i18n::msg::ERR_CMD_SEQUENCES_02), |conn| {
        db::link_after(conn, &after_block_id, &block_id, name.as_deref())
    })?;
    crate::broadcast_block_updated(&app);
    Ok(outcome)
}

/// 把块移出序列；成员不足 2 个时序列自动删除（返回值 = 是否被删）
#[tauri::command]
pub fn remove_sequence_member(
    app: AppHandle,
    state: State<'_, AppState>,
    sequence_id: String,
    block_id: String,
) -> Result<bool, String> {
    let pruned = record(&state, i18n::t(i18n::msg::ERR_CMD_SEQUENCES_03), |conn| {
        db::remove_member(conn, &sequence_id, &block_id)
    })?;
    crate::broadcast_block_updated(&app);
    Ok(pruned)
}

/// 删除序列：**只解链，块一个都不动**（返回删除的行数，0 = 本来就不存在）
#[tauri::command]
pub fn delete_sequence(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<usize, String> {
    let deleted = record(&state, i18n::t(i18n::msg::ERR_CMD_SEQUENCES_04), |conn| db::delete_sequence(conn, &id))?;
    crate::broadcast_block_updated(&app);
    Ok(deleted)
}

/// 列出「在本周窗口内有成员块」的序列（供前端画细线与序号）
#[tauri::command]
pub fn list_sequences(
    state: State<'_, AppState>,
    from: i64,
    to: i64,
) -> Result<Vec<Sequence>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_sequences(&conn, from, to)
}
