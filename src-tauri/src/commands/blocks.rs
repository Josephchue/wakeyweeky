//! 任务块相关命令：只做参数转换与锁管理，业务逻辑在 db.rs 的纯函数里。

use tauri::{AppHandle, State};

use crate::db::{self, Block};
use crate::commands::history::record;
use crate::AppState;
use crate::i18n;
use crate::tf;

/// C1.5.1（用户实测：「切换层级」的撤销却提示「调整块」，不知道改了什么）：
/// `update_block` 一个命令被三种手势共用，撤销/重做的提示得按 patch 分清改的是什么。
/// 纯函数、配单测 —— 这几个字很容易被人顺手改坏。
/// C1.2/C3：加载一周时先扫一遍 —— 合并现存的重复块 + 摘掉非法的序列成员。
/// 返回**给用户看的一句话**（空串 = 什么都没做）；走 record → **可撤销** ✓
#[tauri::command]
pub fn merge_pending_blocks(state: State<'_, AppState>) -> Result<String, String> {
    let (merged, unlinked) = record(&state, i18n::t(i18n::msg::ERR_CMD_BLOCKS_01), db::merge_all_pending)?;
    Ok(merge_summary(merged, unlinked).unwrap_or_default())
}

/// 把「整理」的结果拼成给用户看的一句话（纯函数，配单测）。
///
/// round41 的口径（用户 2026-10-03 又抓了一次）：**只报「做了什么」**，别缀
/// 「（Ctrl+Z 可撤销）」这类括号解释 —— 界面上本来就有撤销按钮，用户自己看得见。
pub fn merge_summary(merged: usize, unlinked: usize) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if merged > 0 {
        parts.push(tf!(i18n::msg::ERR_CMD_BLOCKS_02, merged = merged));
    }
    if unlinked > 0 {
        parts.push(tf!(i18n::msg::ERR_CMD_BLOCKS_03, unlinked = unlinked));
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join(i18n::t(i18n::msg::ERR_CMD_BLOCKS_04)))
}

/// round49：**临时安排块**自己的「不计入理智值」开关 —— 它没有可挂的任务（挂在那块全局隐藏任务上、
/// Backlog 里看不见），所以只能看它自己。普通块**不显示**这个键（它们看任务那一行）。
/// 走 `record` → `Ctrl+Z` 可撤；叫醒提醒线程让**托盘超载态**立刻跟着变。
#[tauri::command]
pub fn set_block_exempt(
    state: State<'_, AppState>,
    id: String,
    exempt: bool,
) -> Result<Block, String> {
    let block = record(&state, if exempt { i18n::t(i18n::msg::ERR_CMD_BLOCKS_05) } else { i18n::t(i18n::msg::ERR_CMD_BLOCKS_06) }, |conn| {
        db::set_block_exempt(conn, &id, exempt)
    })?;
    crate::notify::wake_notifier();
    Ok(block)
}

pub fn update_block_label(
    has_layer: bool,
    has_start: bool,
    has_end: bool,
    has_label: bool,
) -> &'static str {
    match (has_layer, has_start, has_end, has_label) {
        (true, false, false, false) => i18n::t(i18n::msg::ERR_CMD_BLOCKS_07),
        (false, true, true, false) => i18n::t(i18n::msg::ERR_CMD_BLOCKS_08),
        (false, true, false, false) => i18n::t(i18n::msg::ERR_CMD_BLOCKS_09),
        (false, false, false, true) => i18n::t(i18n::msg::ERR_CMD_BLOCKS_10),
        _ => i18n::t(i18n::msg::ERR_CMD_BLOCKS_11),
    }
}

#[tauri::command]
pub fn list_blocks(state: State<'_, AppState>, from: i64, to: i64) -> Result<Vec<Block>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_blocks(&conn, from, to)
}

#[tauri::command]
pub fn create_block(
    state: State<'_, AppState>,
    task_id: String,
    start_at: i64,
    end_at: i64,
) -> Result<db::CreateOutcome, String> {
    create_block_impl(&state, task_id, start_at, end_at)
}

/// C1.8（R33）：双击时间轴空白格 → 建一个**临时安排块**（不登记在 Backlog）。
/// 它挂全局隐藏任务、名字默认空（界面显示「临时安排」）、不参与融合。
#[tauri::command]
pub fn create_temp_block(
    state: State<'_, AppState>,
    start_at: i64,
    end_at: i64,
) -> Result<db::CreateOutcome, String> {
    create_temp_block_impl(&state, start_at, end_at)
}

/// 命令本体（同 `create_block_impl`：好让集成测试直接调命令层）
pub(crate) fn create_temp_block_impl(
    state: &AppState,
    start_at: i64,
    end_at: i64,
) -> Result<db::CreateOutcome, String> {
    let out = record(state, i18n::t(i18n::msg::ERR_CMD_BLOCKS_12), |conn| {
        let before = db::count_blocks(conn)?;
        let block = db::create_temp_block(conn, start_at, end_at)?;
        // 临时块不参与融合，但口径与 create_block 保持一致（可预见的将来也不会有人读到 merged=true）
        let merged = db::count_blocks(conn)? <= before;
        Ok(db::CreateOutcome { block, merged })
    })?;
    crate::notify::wake_notifier();
    Ok(out)
}

/// 命令本体（D 债 round23）：拆出 `&AppState` 一层，好让集成测试**直接调**命令这一层
/// —— 测试里 new 不出 `State`（字段私有），而 tauri 的 `MockRuntime` 在本机**用不了**
/// （它让测试 exe 静态链上 muda 的 comctl32 v6 代码，而测试 exe 没有 v6 manifest
/// → 加载时报 `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`；详见 `commands/history.rs` 的测试说明）。
pub(crate) fn create_block_impl(
    state: &AppState,
    task_id: String,
    start_at: i64,
    end_at: i64,
) -> Result<db::CreateOutcome, String> {
    let out = record(state, i18n::t(i18n::msg::ERR_CMD_BLOCKS_13), |conn| {
        // round31（C1.9）：`create_block` 落库后可能融合 → 它会返回**幸存者**，
        // 靠块数变化（期望 +1）判定「这次有没有吃掉别人」——前端据此弹融合提示。
        let count_before = db::count_blocks(conn)?;
        let block = db::create_block(conn, &task_id, start_at, end_at)?;
        let merged = db::count_blocks(conn)? <= count_before;
        Ok(db::CreateOutcome { block, merged })
    })?;
    // 新块可能本来就是「已经结束」的（用户拖到过去的格子）→ 立刻叫醒提醒线程，别等它睡完
    crate::notify::wake_notifier();
    Ok(out)
}

#[tauri::command]
pub fn delete_block(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<usize, String> {
    let deleted = record(&state, i18n::t(i18n::msg::ERR_CMD_BLOCKS_14), |conn| db::delete_block(conn, &id))?;
    // 删除也要广播：否则浮窗里正在显示的这条被删掉后不会自动收起（B3-4）
    crate::broadcast_block_updated(&app);
    crate::notify::wake_notifier();
    Ok(deleted)
}

#[tauri::command]
pub fn mark_block_done(    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Block, String> {
    let block = record(&state, i18n::t(i18n::msg::ERR_CMD_BLOCKS_15), |conn| db::mark_block_done(conn, &id))?;
    // 标记后广播：主窗口/浮窗都据此同步（浮窗里点 ✓ 时主窗口会立刻刷新）
    crate::broadcast_block_updated(&app);
    crate::notify::wake_notifier();
    Ok(block)
}

#[tauri::command]
pub fn mark_block_missed(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Block, String> {
    let block = record(&state, i18n::t(i18n::msg::ERR_CMD_BLOCKS_16), |conn| db::mark_block_missed(conn, &id))?;
    crate::broadcast_block_updated(&app);
    crate::notify::wake_notifier();
    Ok(block)
}

// ------------------------------------------------ round61（10.2）批量命令
// 每条命令 = **一次 `record`**（整批一步撤销）；写路径全部复用单块的 db 函数，语义零分叉。

/// round61（10.2 多选）：批量删除（返回实际删掉的块数，含级联子树；整批只记一条事件）。
#[tauri::command]
pub fn delete_blocks(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<usize, String> {
    let deleted = delete_blocks_impl(&state, ids)?;
    crate::broadcast_block_updated(&app);
    crate::notify::wake_notifier();
    Ok(deleted)
}

/// 命令本体（同 `create_block_impl`：好让集成测试直接调命令层）
pub(crate) fn delete_blocks_impl(state: &AppState, ids: Vec<String>) -> Result<usize, String> {
    let out = record(state, i18n::t(i18n::msg::ERR_CMD_BLOCKS_17), |conn| db::delete_blocks(conn, &ids))?;
    if ids.len() > 1 {
        crate::commands::achievements::note_signal(state, "batch");
    }
    Ok(out)
}

/// round61（10.2 多选）：批量标记（`status` = done / missed；标 ✗ 不弹漂流卡由前端保证）。
#[tauri::command]
pub fn mark_blocks(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    status: String,
) -> Result<usize, String> {
    let changed = mark_blocks_impl(&state, ids, status)?;
    crate::broadcast_block_updated(&app);
    crate::notify::wake_notifier();
    Ok(changed)
}

/// 命令本体（同 `create_block_impl`）
pub(crate) fn mark_blocks_impl(
    state: &AppState,
    ids: Vec<String>,
    status: String,
) -> Result<usize, String> {
    let what = if status == "done" { i18n::t(i18n::msg::ERR_CMD_BLOCKS_18) } else { i18n::t(i18n::msg::ERR_CMD_BLOCKS_19) };
    let out = record(state, what, |conn| db::mark_blocks(conn, &ids, &status))?;
    if ids.len() > 1 {
        crate::commands::achievements::note_signal(state, "batch");
    }
    Ok(out)
}

/// round61（10.2 多选）：批量平移（`moves` = 每块的新起点，前端按本地日历算好）。
#[tauri::command]
pub fn move_blocks(
    app: AppHandle,
    state: State<'_, AppState>,
    moves: Vec<(String, i64)>,
) -> Result<db::BatchOutcome, String> {
    let out = move_blocks_impl(&state, moves)?;
    crate::broadcast_block_updated(&app);
    crate::notify::wake_notifier();
    Ok(out)
}

/// 命令本体（同 `create_block_impl`）
pub(crate) fn move_blocks_impl(
    state: &AppState,
    moves: Vec<(String, i64)>,
) -> Result<db::BatchOutcome, String> {
    let out = record(state, i18n::t(i18n::msg::ERR_CMD_BLOCKS_20), |conn| db::move_blocks(conn, &moves))?;
    if moves.len() > 1 {
        crate::commands::achievements::note_signal(state, "batch");
    }
    Ok(out)
}

/// round61（10.2 多选）：批量改层（可撤销；改层可能引发融合，前端整周重拉）。
#[tauri::command]
pub fn set_blocks_layer(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    layer: String,
) -> Result<db::BatchOutcome, String> {
    let out = set_blocks_layer_impl(&state, ids, layer)?;
    crate::broadcast_block_updated(&app);
    crate::notify::wake_notifier();
    Ok(out)
}

/// 命令本体（同 `create_block_impl`）
pub(crate) fn set_blocks_layer_impl(
    state: &AppState,
    ids: Vec<String>,
    layer: String,
) -> Result<db::BatchOutcome, String> {
    let out = record(state, i18n::t(i18n::msg::ERR_CMD_BLOCKS_21), |conn| db::set_blocks_layer(conn, &ids, &layer))?;
    if ids.len() > 1 {
        crate::commands::achievements::note_signal(state, "batch");
    }
    Ok(out)
}

/// round69（B3）：**复制手势**落地用的输入 —— 前端只给这几个字段；
/// 状态 / 历史 / 序列 / 行为事实一律不复制（新块从 `planned` 开始）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct CopySpec {
    pub task_id: String,
    pub start_at: i64,
    pub end_at: i64,
    pub layer: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub sanity_exempt: bool,
}

/// round69.1（#2 / D1）：复制落地结果 —— 给前端的提示说真话（复制了几块 / 几块就地融合）。
#[derive(Debug, serde::Serialize)]
pub struct CopyOutcome {
    /// 落地后**存活**的块（按 spec 顺序去重；就地融合时是原来那一块）
    pub blocks: Vec<db::Block>,
    /// 这一批**新建成**的块数
    pub created: usize,
    /// 就地融合掉几处（副本没多出来）
    pub merged: usize,
}

/// round69（B3）：复制手势 —— 批量建（**一次 `record` = 一步撤销**），每块记一条 `create`（`copy` 标记）。
#[tauri::command]
pub fn create_blocks(
    app: AppHandle,
    state: State<'_, AppState>,
    blocks: Vec<CopySpec>,
) -> Result<CopyOutcome, String> {
    let out = create_blocks_impl(&state, blocks)?;
    crate::broadcast_block_updated(&app);
    crate::notify::wake_notifier();
    Ok(out)
}

/// 命令本体（同 `create_block_impl`：好让集成测试直接调命令层）
pub(crate) fn create_blocks_impl(
    state: &AppState,
    specs: Vec<CopySpec>,
) -> Result<CopyOutcome, String> {
    if specs.is_empty() {
        return Err(i18n::t(i18n::msg::ERR_CMD_BLOCKS_22).to_string());
    }
    let out = record(state, i18n::t(i18n::msg::ERR_CMD_BLOCKS_23), |conn| {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| tf!(i18n::msg::ERR_CMD_BLOCKS_24, e = e))?;
        let mut blocks: Vec<db::Block> = Vec::with_capacity(specs.len());
        let mut created = 0usize;
        let mut merged = 0usize;
        for spec in &specs {
            let res = db::create_copy_block(
                &tx,
                &spec.task_id,
                spec.start_at,
                spec.end_at,
                &spec.layer,
                spec.label.as_deref(),
                spec.sanity_exempt,
            )?;
            if res.merged {
                merged += 1;
            } else {
                created += 1;
            }
            // 命中的是已有块 / 本批早先的块时去重（同一 id 只回一次）
            if !blocks.iter().any(|b| b.id == res.block.id) {
                blocks.push(res.block);
            }
        }
        tx.commit().map_err(|e| tf!(i18n::msg::ERR_CMD_BLOCKS_25, e = e))?;
        Ok(CopyOutcome {
            blocks,
            created,
            merged,
        })
    })?;
    if specs.len() > 1 {
        crate::commands::achievements::note_signal(state, "batch");
    }
    Ok(out)
}

/// 更新任务块（C1 本轮只支持改层；后续批次的 start_at/end_at 以追加 Option 参数的方式扩展）。
#[tauri::command]
pub fn update_block(
    state: State<'_, AppState>,
    id: String,
    layer: Option<String>,
    start_at: Option<i64>,
    end_at: Option<i64>,
    label: Option<String>,
) -> Result<db::MoveOutcome, String> {
    update_block_impl(&state, id, layer, start_at, end_at, label)
}

/// 命令本体（同 `create_block_impl`）
pub(crate) fn update_block_impl(
    state: &AppState,
    id: String,
    layer: Option<String>,
    start_at: Option<i64>,
    end_at: Option<i64>,
    label: Option<String>,
) -> Result<db::MoveOutcome, String> {
    let what = update_block_label(
        layer.is_some(),
        start_at.is_some(),
        end_at.is_some(),
        label.is_some(),
    );
    let outcome = record(state, what, |conn| {
        db::update_block(conn, &id, layer.as_deref(), start_at, end_at, label.as_deref())
    })?;
    crate::notify::wake_notifier();
    Ok(outcome)
}

/// 漂流（C2）：按用户确认的时段另排一个块，原残影留在原位。
/// 返回新建的块（同任务、同时长、继承原层，状态回到 `planned`）。
#[tauri::command]
pub fn postpone_block(
    state: State<'_, AppState>,
    id: String,
    new_start_at: i64,
) -> Result<db::MoveOutcome, String> {
    postpone_block_impl(&state, id, new_start_at)
}

/// 命令本体（同 `create_block_impl`）
pub(crate) fn postpone_block_impl(
    state: &AppState,
    id: String,
    new_start_at: i64,
) -> Result<db::MoveOutcome, String> {
    let result = record(state, i18n::t(i18n::msg::ERR_CMD_BLOCKS_26), |conn| db::postpone_block(conn, &id, new_start_at))?;
    crate::notify::wake_notifier();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{merge_summary, update_block_label};
    use crate::commands::history::History;
    use crate::db;
    use std::sync::Mutex;

    /// 命令层集成测试的假状态（原因见 `commands/history.rs` 测试模块的长注释）
    fn test_state() -> crate::AppState {
        crate::AppState {
            db: Mutex::new(db::test_conn()),
            history: Mutex::new(History::default()),
        }
    }

    /// round69（B3）：复制 = 一次 `record` 一步撤销；属性（层 / 名字 / ⊘）照带，状态回 `planned`
    #[test]
    fn test_create_blocks_is_one_undo_step_and_keeps_attrs() {
        let state = test_state();
        let task = {
            let conn = state.db.lock().unwrap();
            db::create_task(&conn, "健身", None).unwrap()
        };
        let specs = vec![
            super::CopySpec {
                task_id: task.id.clone(),
                start_at: 1_000,
                end_at: 2_000,
                layer: "required".to_string(),
                label: Some("早操".to_string()),
                sanity_exempt: false,
            },
            super::CopySpec {
                task_id: task.id.clone(),
                start_at: 3_000,
                end_at: 4_000,
                layer: "elastic".to_string(),
                label: None,
                sanity_exempt: true,
            },
        ];
        let out = super::create_blocks_impl(&state, specs).unwrap();
        assert_eq!(out.blocks.len(), 2);
        assert_eq!((out.created, out.merged), (2, 0), "两块都在空档 → 都算新建");
        assert_eq!(out.blocks[0].layer, "required");
        assert_eq!(out.blocks[0].label.as_deref(), Some("早操"), "块名跟着复制");
        assert!(out.blocks[1].sanity_exempt, "⊘ 跟着复制（临时块用）");
        assert_eq!(out.blocks[0].status, "planned", "副本一律从 planned 开始");

        // 一步撤销：两块一起走
        crate::commands::history::undo_impl(&state).unwrap();
        let conn = state.db.lock().unwrap();
        assert_eq!(db::count_blocks(&conn).unwrap(), 0, "一次撤销带走整批");
    }

    /// round69（B3）：空清单是调用方的 bug —— 明确报错，不静默成功
    #[test]
    fn test_create_blocks_rejects_empty() {
        let state = test_state();
        assert!(super::create_blocks_impl(&state, Vec::new()).is_err());
    }

    /// round69.1（#2 / D1）：复制落在原位 / 重叠格上 → **就地融合成一块**，而且**原有块当幸存者**
    /// （id 不换 —— 历史 / 提醒挂在那一条上）。
    /// （round69 的 6b P1 曾按旧边界表 B1#11 判为「要留两份」；用户 2026-10-05 验收拍板改成
    /// 「就地合成一块，等于复制没生效」→ 本用例随之反向。）
    #[test]
    fn test_copy_onto_same_slot_merges_into_origin() {
        let state = test_state();
        let task = {
            let conn = state.db.lock().unwrap();
            db::create_task(&conn, "健身", None).unwrap()
        };
        let origin = {
            let conn = state.db.lock().unwrap();
            db::create_block(&conn, &task.id, 1_000, 2_000).unwrap()
        };
        let out = super::create_blocks_impl(
            &state,
            vec![super::CopySpec {
                task_id: task.id.clone(),
                start_at: 1_000,
                end_at: 2_000,
                layer: "elastic".to_string(),
                label: None,
                sanity_exempt: false,
            }],
        )
        .unwrap();
        assert_eq!(out.blocks.len(), 1);
        assert_eq!((out.created, out.merged), (0, 1), "就地融合：不算新建、算 1 处融合");
        let conn = state.db.lock().unwrap();
        assert_eq!(db::count_blocks(&conn).unwrap(), 1, "就地融合成一块（不再多一份）");
        assert_eq!(out.blocks[0].id, origin.id, "原有块当幸存者（id 没被换掉）");
        let rows = db::list_blocks(&conn, 0, 10_000).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].start_at, rows[0].end_at), (1_000, 2_000), "同格融合区间不变");
    }

    /// round69.1（6b P1-2）：副本落在**原块左边**（起点更早的重叠）时**原块仍是幸存者** ——
    /// `merge_adjacent` 的先后规则是「传进来的那一块优先」，所以复制路径必须显式偏好原有块。
    #[test]
    fn test_copy_left_overlap_keeps_origin_as_survivor() {
        let state = test_state();
        let task = {
            let conn = state.db.lock().unwrap();
            db::create_task(&conn, "健身", None).unwrap()
        };
        let origin = {
            let conn = state.db.lock().unwrap();
            db::create_block(&conn, &task.id, 2_000, 3_000).unwrap()
        };
        let out = super::create_blocks_impl(
            &state,
            vec![super::CopySpec {
                task_id: task.id.clone(),
                start_at: 1_000,
                end_at: 2_500,
                layer: "elastic".to_string(),
                label: None,
                sanity_exempt: false,
            }],
        )
        .unwrap();
        assert_eq!((out.created, out.merged), (0, 1), "重叠 → 就地融合");
        let conn = state.db.lock().unwrap();
        assert_eq!(db::count_blocks(&conn).unwrap(), 1);
        let rows = db::list_blocks(&conn, 0, 10_000).unwrap();
        assert_eq!(rows[0].id, origin.id, "原块当幸存者（起点更早的副本也不行）");
        assert_eq!((rows[0].start_at, rows[0].end_at), (1_000, 3_000), "区间取并集");
    }

    /// round48（用户 2026-10-03 截图：「括号里面的东西很多余啊」）：整理提示**只报做了什么**，
    /// 不缀「（Ctrl+Z 可撤销）」——这是 round41 的口径，界面上本来就有撤销按钮。
    #[test]
    fn test_merge_summary_reports_what_it_did_without_parentheses() {
        assert_eq!(merge_summary(0, 0), None, "什么都没做 → 不吭声");
        assert_eq!(merge_summary(2, 0).as_deref(), Some("已合并 2 处重复的同一任务的块"));
        assert_eq!(
            merge_summary(0, 3).as_deref(),
            Some("摘掉 3 条不该在同一序列里的漂流链成员")
        );
        let both = merge_summary(2, 3).expect("两件事都做了");
        assert!(both.contains('；') && both.contains('2') && both.contains('3'));
        for text in [merge_summary(1, 0), merge_summary(0, 1), merge_summary(1, 1)] {
            let text = text.expect("有话说");
            assert!(
                !text.contains('（') && !text.contains('('),
                "提示里不该有括号解释：{text}"
            );
        }
    }

    /// C1.5.1：撤销/重做的提示必须分清每种手势改了什么（round25 加了「改块名」）
    #[test]
    fn test_update_block_label_tells_the_gestures_apart() {
        assert_eq!(update_block_label(true, false, false, false), "切换层级");
        assert_eq!(update_block_label(false, true, true, false), "拉伸块");
        assert_eq!(update_block_label(false, true, false, false), "移动块");
        assert_eq!(update_block_label(false, false, false, true), "改块名");
        assert_eq!(update_block_label(false, false, true, false), "调整块");
    }
}
