//! 撤销 / 重做（C1.5，用户点名要 Ctrl+Z）。
//!
//! 机制：**每个会改数据的命令执行前，把用户数据表拍一份快照压进内存栈**；
//! 撤销 = 整表回滚，重做 = 整表前进。
//!
//! 为什么用快照而不是「逆操作」：级联顺延、漂流的级联删除、删任务连带删块 ——
//! 这些「一条命令改多行」的情况用逆操作很难写对；整表恢复天然覆盖它们。
//!
//! 拍板（2026-09-30）：包含 ✓/✗ 标记；要重做；**会话内 20 步，重启清空**（栈只在内存里）。

use serde::Serialize;
use tauri::State;

use crate::db;
use crate::AppState;
use crate::i18n;

/// 最多记多少步（拍板：会话内 20 步）
const HISTORY_LIMIT: usize = 20;

/// 一步：一个标签（撤销提示里那句话）+ 操作**之前**的整表快照
#[derive(Clone)]
pub struct Snapshot {
    pub label: String,
    pub data: String,
}

#[derive(Default)]
pub struct History {
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
}

impl History {
    fn push_undo(&mut self, label: &str, data: String) {
        self.undo.push(Snapshot {
            label: label.to_string(),
            data,
        });
        if self.undo.len() > HISTORY_LIMIT {
            self.undo.remove(0);
        }
        // 有了新操作 → 原来的「重做」分支作废
        self.redo.clear();
    }
}

/// 撤销/重做的结果：撤了什么 + **视角该开在哪**（round64.1 / 验收 #3）。
#[derive(Serialize)]
pub struct HistoryOutcome {
    pub label: String,
    pub focus: Option<HistoryFocus>,
}

/// 本次变动涉及的块 + 视角要落到的时刻（Unix 秒）。
/// 只在 `undo` / `redo` 里算（不进 `record` 热路径）：两份整表快照的 `blocks` 表按 `id` 配对，
/// 被增 / 删 / 改过的块就是变动集合；位置优先取**目标态**（撤销后它去哪了），
/// 目标态里没有它（重做一次删除）就退回当前态的位置。
#[derive(Serialize, Debug, PartialEq)]
pub struct HistoryFocus {
    pub start_at: i64,
    pub ids: Vec<String>,
}

/// 从一份 `dump_tables` 快照里抽出 `blocks` 表：`id → (start_at, 整行 JSON)`
fn block_positions(dump: &str) -> Option<std::collections::HashMap<String, (i64, String)>> {
    let value: serde_json::Value = serde_json::from_str(dump).ok()?;
    let blocks = value.get("blocks")?;
    let cols = blocks.get("cols")?.as_array()?;
    let id_at = cols.iter().position(|c| c.as_str() == Some("id"))?;
    let start_at = cols.iter().position(|c| c.as_str() == Some("start_at"))?;
    let mut map = std::collections::HashMap::new();
    for row in blocks.get("rows")?.as_array()? {
        let arr = row.as_array()?;
        let id = arr.get(id_at)?.as_str()?.to_string();
        let at = arr.get(start_at)?.as_i64()?;
        map.insert(id, (at, row.to_string()));
    }
    Some(map)
}

/// 两份快照之间被改动的块（增 / 删 / 改字段）+ 视角落点（目标态优先）。
pub(crate) fn focus_between(current: &str, target: &str) -> Option<HistoryFocus> {
    let cur = block_positions(current)?;
    let tgt = block_positions(target)?;
    let mut ids: Vec<String> = Vec::new();
    for (id, (_, row)) in &tgt {
        if cur.get(id).map(|(_, r)| r) != Some(row) {
            ids.push(id.clone());
        }
    }
    for id in cur.keys() {
        if !tgt.contains_key(id) {
            ids.push(id.clone());
        }
    }
    if ids.is_empty() {
        return None;
    }
    let start_at = ids
        .iter()
        .filter_map(|id| tgt.get(id).map(|(at, _)| *at))
        .min()
        .or_else(|| {
            ids.iter()
                .filter_map(|id| cur.get(id).map(|(at, _)| *at))
                .min()
        })?;
    ids.sort(); // 稳定顺序：测试好写，前端也不依赖顺序
    Some(HistoryFocus { start_at, ids })
}

/// 包一层：**先拍快照，再执行**；执行失败就不记账（快照直接丢弃）。
///
/// **无变化的命令也不记账**（T 债，round25 用户实测「Ctrl+Z 有提示但界面上什么都没变」）：
/// 典型是加载一周时跑的幂等整理（`merge_all_pending`）—— 它多半无事可做，却被无条件压进栈，
/// 于是 Ctrl+Z 先把一串**空步**撤掉（用户截图里四条「已撤销：整理重复块与序列」就是它），
/// 真正的操作被埋在下面，看起来像「撤销没生效」；而且 `push_undo` 会 `redo.clear()`
/// → 空步还会**把重做分支作废**（同一个根因）。所以操作后再拍一份比对，一样就当没发生。
///
/// 锁顺序统一为「先 db 后 history」（`undo` / `redo` 也一样），避免两个锁互等。
pub fn record<T>(
    state: &AppState,
    label: &str,
    op: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let before = db::dump_tables(&conn)?;
    let out = op(&conn)?;
    // round68（19.1）：块写操作后求值暗章（成就表不在快照里，不影响下面的 before/after 比对）
    crate::achievements::after_write(&conn);
    let after = db::dump_tables(&conn)?;
    if before == after {
        return Ok(out); // 什么都没改：不入栈，也不动重做分支
    }
    let mut history = state.history.lock().map_err(|e| e.to_string())?;
    history.push_undo(label, before);
    Ok(out)
}

#[tauri::command]
pub fn undo(state: State<'_, AppState>) -> Result<HistoryOutcome, String> {
    undo_impl(&state)
}

/// 命令本体：拆出 `&AppState` 一层，好让集成测试**直接调**（原因写在下面测试模块的注释里）。
pub(crate) fn undo_impl(state: &AppState) -> Result<HistoryOutcome, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut history = state.history.lock().map_err(|e| e.to_string())?;

    let Some(snapshot) = history.undo.pop() else {
        return Err(i18n::t(i18n::msg::ERR_CMD_HISTORY_01).to_string());
    };
    // 先把「当前位置」留下来当重做点；恢复失败就把撤销点放回去
    let current = match db::dump_tables(&conn) {
        Ok(data) => data,
        Err(e) => {
            history.undo.push(snapshot);
            return Err(e);
        }
    };
    // round64.1（验收 #3）：回滚之前先算「视角该开在哪」（两份快照的 diff）
    let focus = focus_between(&current, &snapshot.data);
    if let Err(e) = db::restore_tables(&conn, &snapshot.data) {
        history.undo.push(snapshot);
        return Err(e);
    }

    history.redo.push(Snapshot {
        label: snapshot.label.clone(),
        data: current,
    });
    if history.redo.len() > HISTORY_LIMIT {
        history.redo.remove(0);
    }

    // round68（19.1）：撤销本身也是暗章信号（第三次参数不参与判定）
    if let Err(e) = crate::achievements::note(&conn, "undo") {
        eprintln!("[achievements] 信号 undo 失败（忽略）：{e}");
    }
    // 6b 复核（P2）：只认「删除块」（任务 / 序列 / 模板的删除不算 —— 描述写的是块）
    if snapshot.label == i18n::t(i18n::msg::ERR_CMD_HISTORY_02) {
        if let Err(e) = crate::achievements::note(&conn, "undo_delete") {
            eprintln!("[achievements] 信号 undo_delete 失败（忽略）：{e}");
        }
    }

    Ok(HistoryOutcome {
        label: snapshot.label,
        focus,
    })
}

#[tauri::command]
pub fn redo(state: State<'_, AppState>) -> Result<HistoryOutcome, String> {
    redo_impl(&state)
}

/// 命令本体（同 `undo_impl`）
pub(crate) fn redo_impl(state: &AppState) -> Result<HistoryOutcome, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut history = state.history.lock().map_err(|e| e.to_string())?;

    let Some(snapshot) = history.redo.pop() else {
        return Err(i18n::t(i18n::msg::ERR_CMD_HISTORY_03).to_string());
    };
    let current = match db::dump_tables(&conn) {
        Ok(data) => data,
        Err(e) => {
            history.redo.push(snapshot);
            return Err(e);
        }
    };
    // round64.1（验收 #3）：同 `undo_impl` —— 目标态 = 重做快照
    let focus = focus_between(&current, &snapshot.data);
    if let Err(e) = db::restore_tables(&conn, &snapshot.data) {
        history.redo.push(snapshot);
        return Err(e);
    }

    history.undo.push(Snapshot {
        label: snapshot.label.clone(),
        data: current,
    });
    if history.undo.len() > HISTORY_LIMIT {
        history.undo.remove(0);
    }

    Ok(HistoryOutcome {
        label: snapshot.label,
        focus,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{blocks, tasks};
    use crate::db;
    use std::sync::Mutex;

    /// D 债（`docs/对账.md` §5）：**命令层** `record → undo/redo` 的集成测试。
    ///
    /// 为什么不直接调 `#[tauri::command]` 那些函数：它们的参数是 `tauri::State`，而 `State`
    /// 的字段私有、**测试里 new 不出来**。本来有一条更漂亮的路 —— 用 tauri 自带的 `MockRuntime`
    /// 起个假应用、`app.state::<AppState>()` 拿真 `State` —— 但**本机用不了**（2026-10-01 实测）：
    /// 它让 lib 测试 exe 静态链上 muda 的 **comctl32 v6** 代码（`TaskDialogIndirect` 等），
    /// 而测试 exe **没有 v6 manifest**（真应用的 manifest 由 tauri-build 嵌进主 exe），
    /// `System32\comctl32.dll` 又是 **v5.82**（不导出那些函数）→ 进程还没跑就
    /// `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`。
    /// → 所以命令拆了一层 `*_impl(&AppState, …)`（签名与命令一致，只把 `State` 换成 `&AppState`），
    /// 集成测试直接调这一层；`#[tauri::command]` 的宏胶水由真机交互路径覆盖。
    ///
    /// **盖不到的**：签名里带 `AppHandle` 的命令（标记完成 / 删除块 / 删任务）—— 还得多一个真 `AppHandle`。
    /// **盖不到的**：`list_*` 只读命令（不写库、本来就不该记步）。
    fn test_state() -> AppState {
        AppState {
            db: Mutex::new(db::test_conn()),
            history: Mutex::new(History::default()),
        }
    }

    /// 直接读库做断言。注意：命令本体自己会锁 db —— 所以**别在持锁的时候调命令**（会死锁）。
    fn block_start(state: &AppState, id: &str) -> Option<i64> {
        let conn = state.db.lock().expect("锁库失败");
        db::list_blocks(&conn, 0, 1_000_000)
            .expect("查块失败")
            .into_iter()
            .find(|b| b.id == id)
            .map(|b| b.start_at)
    }

    fn block_count(state: &AppState) -> usize {
        let conn = state.db.lock().expect("锁库失败");
        db::list_blocks(&conn, 0, 1_000_000).expect("查块失败").len()
    }

    fn task_count(state: &AppState) -> usize {
        let conn = state.db.lock().expect("锁库失败");
        db::list_tasks(&conn).expect("查任务失败").len()
    }

    /// 主链路：**建任务 → 建块 → 移动 → 撤销 → 重做 → 一路撤到底**，每一步都看数据真的回放。
    #[test]
    fn test_undo_redo_through_real_commands() {
        let state = test_state();
        let task = tasks::create_task_impl(&state, "写周报".into(), None).expect("新建任务");
        let block =
            blocks::create_block_impl(&state, task.id.clone(), 1_000, 2_800)
                .expect("新建块")
                .block;
        assert_eq!(block_start(&state, &block.id), Some(1_000));

        blocks::update_block_impl(&state, block.id.clone(), None, Some(9_000), None, None)
            .expect("移动块");
        assert_eq!(block_start(&state, &block.id), Some(9_000));

        // **失败的命令不进撤销栈**：块不存在 → 报错；撤销时该撤的是上一条**成功**的命令
        assert!(
            blocks::update_block_impl(&state, "不存在的块".into(), None, Some(1), None, None).is_err()
        );
        assert_eq!(undo_impl(&state).expect("撤销失败").label, "移动块");
        assert_eq!(block_start(&state, &block.id), Some(1_000), "撤销把时间放回原位");

        assert_eq!(redo_impl(&state).expect("重做失败").label, "移动块");
        assert_eq!(block_start(&state, &block.id), Some(9_000), "重做又走回新位置");

        // 一路撤到底：移动块 → 新建块 → 新建任务，每步都看数据
        assert_eq!(undo_impl(&state).expect("撤销失败").label, "移动块");
        assert_eq!(undo_impl(&state).expect("撤销失败").label, "新建块");
        assert_eq!(block_count(&state), 0, "撤到建块前 → 块不该还在");
        assert_eq!(undo_impl(&state).expect("撤销失败").label, "新建任务");
        assert_eq!(task_count(&state), 0, "撤到建任务前 → 任务不该还在");

        assert!(undo_impl(&state).is_err(), "撤到底了必须报「没有可撤销的操作」");
    }

    /// 撤销之后**又做了新操作** → 原来的「重做」分支必须作废（否则重做会把数据改成两不像）。
    #[test]
    fn test_new_command_clears_the_redo_branch() {
        let state = test_state();
        let task = tasks::create_task_impl(&state, "写周报".into(), None).expect("新建任务");
        let block =
            blocks::create_block_impl(&state, task.id.clone(), 1_000, 2_800)
                .expect("新建块")
                .block;
        blocks::update_block_impl(&state, block.id.clone(), None, Some(9_000), None, None)
            .expect("移动块");
        assert_eq!(undo_impl(&state).expect("撤销失败").label, "移动块");

        blocks::update_block_impl(&state, block.id.clone(), Some("required".into()), None, None, None)
            .expect("切换层级");
        assert!(
            redo_impl(&state).is_err(),
            "有新操作之后，「重做」必须报「没有可重做的操作」"
        );
        assert_eq!(undo_impl(&state).expect("撤销失败").label, "切换层级");
    }

    /// T 债（round25 用户实测「undo 有消息但看不出变化」）：**不改数据的命令不进撤销栈**。
    /// 真实场景：跳周/重拉时跑的幂等整理，库里本来就没有重复块。
    #[test]
    fn test_no_op_command_does_not_grow_the_undo_stack() {
        let state = test_state();
        record(&state, "整理重复块与序列", db::merge_all_pending).expect("整理");
        assert!(
            undo_impl(&state).is_err(),
            "什么都没做的命令不许入栈 —— 否则 Ctrl+Z 先撤一串空步"
        );
    }

    /// T 债的另一半：空步**不许清掉重做分支**（`push_undo` 会 `redo.clear()`）。
    #[test]
    fn test_no_op_command_keeps_the_redo_branch() {
        let state = test_state();
        let task = tasks::create_task_impl(&state, "写周报".into(), None).expect("新建任务");
        let block =
            blocks::create_block_impl(&state, task.id.clone(), 1_000, 2_800)
                .expect("新建块")
                .block;
        blocks::update_block_impl(&state, block.id.clone(), None, Some(9_000), None, None)
            .expect("移动块");
        assert_eq!(undo_impl(&state).expect("撤销失败").label, "移动块");

        record(&state, "整理重复块与序列", db::merge_all_pending).expect("整理");

        assert_eq!(
            redo_impl(&state).expect("重做失败").label,
            "移动块",
            "空步把重做分支清掉了（用户报的另一个症状）"
        );
        assert_eq!(block_start(&state, &block.id), Some(9_000));
    }

    /// 反向护栏：**真的改了数据**的整理照旧入栈、照旧可撤销
    /// —— 「无变化不入栈」不能把真操作也吞掉。
    #[test]
    fn test_real_merge_is_still_recorded_and_undoable() {
        let state = test_state();
        let title = "写作";
        let task = tasks::create_task_impl(&state, title.into(), None).expect("新建任务");
        // 绕过 create_block（它建第二块时自己就会合）直接造一对相邻的同任务块
        {
            let conn = state.db.lock().expect("锁库失败");
            for (id, s, e) in [("dupe-a", 10_000, 11_800), ("dupe-b", 11_800, 13_600)] {
                conn.execute(
                    "INSERT INTO blocks (id, task_id, start_at, end_at, status, created_at, layer)\n                     VALUES (?1, ?2, ?3, ?4, 'planned', 1, 'elastic')",
                    rusqlite::params![id, &task.id, s, e],
                )
                .expect("插入失败");
            }
        }
        assert_eq!(block_count(&state), 2, "先造出重复");

        record(&state, "整理重复块与序列", db::merge_all_pending).expect("整理");
        assert_eq!(block_count(&state), 1, "真合掉了");
        assert_eq!(undo_impl(&state).expect("撤销失败").label, "整理重复块与序列");
        assert_eq!(block_count(&state), 2, "撤销把被合掉的那块还回来");
    }

    /// 会话内只记 20 步（用户拍板）：第 21 次撤销必须报错，且数据停在**最早那步被挤掉**的位置。
    #[test]
    fn test_history_keeps_only_the_last_twenty_steps() {
        let state = test_state();
        let task = tasks::create_task_impl(&state, "写周报".into(), None).expect("新建任务");
        for i in 0..21 {
            let start = 1_000 + i * 10_000;
            blocks::create_block_impl(&state, task.id.clone(), start, start + 1_800)
                .expect("新建块");
        }
        // 一共 22 步（1 建任务 + 21 建块）→ 栈里只剩最近 20 步
        for n in 0..20 {
            assert!(undo_impl(&state).is_ok(), "前 20 次撤销都该成功（第 {} 次）", n + 1);
        }
        assert!(
            undo_impl(&state).is_err(),
            "第 21 次撤销必须报「没有可撤销的操作」"
        );
        assert_eq!(block_count(&state), 1, "撤到上限为止 → 只剩第 1 块（它的快照早被挤掉了）");
        assert_eq!(task_count(&state), 1, "任务也是最早那步建的 → 还在");
    }

    /// 漂流（C2）一次命令改**多行**（在链尾新建后续块 + 写 `postponed_from`）——
    /// 快照式撤销必须**一次全收回**，这正是当初选快照而不是逆操作的理由。
    ///
    /// 注：把源块置成「未完成」用的是 db 层（`mark_block_missed` 那条命令要 `AppHandle`，这里拿不到）。
    #[test]
    fn test_undo_covers_the_postpone_command() {
        let state = test_state();
        let task = tasks::create_task_impl(&state, "写周报".into(), None).expect("新建任务");
        let block =
            blocks::create_block_impl(&state, task.id.clone(), 1_000, 2_800)
                .expect("新建块")
                .block;
        {
            let conn = state.db.lock().expect("锁库失败");
            db::mark_block_missed(&conn, &block.id).expect("标记未完成");
        }

        blocks::postpone_block_impl(&state, block.id.clone(), 9_000).expect("漂流换时段");
        assert_eq!(block_count(&state), 2, "漂流会新建一个块（原来的残影还在）");

        assert_eq!(undo_impl(&state).expect("撤销失败").label, "漂流换时段");
        assert_eq!(block_count(&state), 1, "撤销必须一次把这步新建的块收回去");
    }

    /// round64.1（验收 #3）：撤销/重做要回「视角该开在哪」—— 被改的块 + 它在新状态里的位置
    #[test]
    fn test_undo_redo_reports_focus() {
        let state = test_state();
        let task = tasks::create_task_impl(&state, "写周报".into(), None).expect("新建任务");
        let block =
            blocks::create_block_impl(&state, task.id.clone(), 1_000, 2_800)
                .expect("新建块")
                .block;
        blocks::update_block_impl(&state, block.id.clone(), None, Some(9_000), Some(10_800), None)
            .expect("挪块");

        let undone = undo_impl(&state).expect("撤销失败");
        let f = undone.focus.expect("挪块撤销必须给 focus");
        assert_eq!(f.start_at, 1_000, "撤销后视角回到原来的位置");
        assert_eq!(f.ids, vec![block.id.clone()]);

        let redone = redo_impl(&state).expect("重做失败");
        let f = redone.focus.expect("重做也必须给 focus");
        assert_eq!(f.start_at, 9_000, "重做后视角跟到新位置");
        assert_eq!(f.ids, vec![block.id.clone()]);
    }

    /// round64.1：纯任务改动（改名 / 分类）没有时间轴落点 → focus = 空（前端不动视角）
    #[test]
    fn test_undo_of_task_only_change_has_no_focus() {
        let state = test_state();
        tasks::create_task_impl(&state, "写周报".into(), Some("工作".into())).expect("新建任务");
        tasks::rename_category_impl(&state, "工作".into(), "学习".into()).expect("改分类");
        let undone = undo_impl(&state).expect("撤销失败");
        assert!(undone.focus.is_none(), "只改分类不该让视角乱跳");
    }

    /// round64.1（6b 复核补）：**目标态没有这个块**的分支 —— 撤销「新建块」后块没了，
    /// 视角要退回到它**当前**（被删前）的位置（`focus_between` 的 `or_else` 兜底）。
    #[test]
    fn test_undo_removing_a_block_falls_back_to_current_position() {
        let state = test_state();
        let task = tasks::create_task_impl(&state, "写周报".into(), None).expect("新建任务");
        let block =
            blocks::create_block_impl(&state, task.id.clone(), 7_000, 8_800)
                .expect("新建块")
                .block;
        let undone = undo_impl(&state).expect("撤销失败");
        let f = undone.focus.expect("撤销「新建块」也要给 focus（块在哪被拿走的）");
        assert_eq!(f.start_at, 7_000, "目标态没这块 → 退回当前态的位置");
        assert_eq!(f.ids, vec![block.id]);
        assert_eq!(block_count(&state), 0, "块确实被撤没了");
    }

    /// round30：**拉伸把两块合成一块**（后端融合）也要能一步撤销。
    /// 验收文档 `docs/验收/round30-stretch-merge-phantom.md` 第 1.4 条就是让你按 Ctrl+Z 看它变回两块 ——
    /// 本条把它钉成机器证据（不然那句就是“只在代码层看过”✗）。
    #[test]
    fn test_undo_covers_a_stretch_that_merged() {
        let state = test_state();
        let task = tasks::create_task_impl(&state, "1".into(), None).expect("新建任务");
        let top =
            blocks::create_block_impl(&state, task.id.clone(), 9_000, 10_800)
                .expect("建上面那块")
                .block;
        let bottom =
            blocks::create_block_impl(&state, task.id.clone(), 12_000, 13_800)
                .expect("建下面那块")
                .block;
        assert_eq!(block_count(&state), 2);

        // 把下面那块的上边缘拉到上面那块起点之前 → 后端融合（保留起点更早的那块）
        let outcome =
            blocks::update_block_impl(&state, bottom.id.clone(), None, Some(8_000), Some(13_800), None)
                .expect("拉伸失败");
        assert_eq!(block_count(&state), 1, "拉伸之后应当融为一体");
        assert_eq!(outcome.block.start_at, 8_000);
        assert!(outcome.merged, "round31：融合要回报给前端（融合提示）");

        assert_eq!(undo_impl(&state).expect("撤销失败").label, "拉伸块");
        assert_eq!(block_count(&state), 2, "撤销必须把被吃掉的那块还回来");
        assert_eq!(block_start(&state, &top.id), Some(9_000), "上面那块回到原位");
        assert_eq!(block_start(&state, &bottom.id), Some(12_000), "下面那块回到原位");
    }

    /// 8.1（round47）：**分类改名 / 合并走的是命令层 `record`** —— 一次 Ctrl+Z 要把所有任务一起收回去
    /// （这是「不改确认框、靠撤销兜底」那个拍板的前提条件，所以得是机器证据）。
    #[test]
    fn test_undo_covers_a_category_rename() {
        let state = test_state();
        let a = tasks::create_task_impl(&state, "写周报".into(), Some("工作".into())).expect("新建任务");
        let b = tasks::create_task_impl(&state, "开周会".into(), Some("工作".into())).expect("新建任务");
        let c = tasks::create_task_impl(&state, "读书".into(), Some("学习".into())).expect("新建任务");

        // 合并：把「工作」并进「学习」（新名恰好是已有分类）
        let changed = tasks::rename_category_impl(&state, "工作".into(), "学习".into()).expect("改分类");
        assert_eq!(changed, 2, "两条「工作」都该并过去");
        {
            let conn = state.db.lock().expect("锁库失败");
            for id in [&a.id, &b.id, &c.id] {
                assert_eq!(
                    db::load_task(&conn, id).unwrap().unwrap().category.as_deref(),
                    Some("学习"),
                    "并完之后三条都在「学习」里"
                );
            }
        }

        assert_eq!(undo_impl(&state).expect("撤销失败").label, "改分类");
        {
            let conn = state.db.lock().expect("锁库失败");
            assert_eq!(db::load_task(&conn, &a.id).unwrap().unwrap().category.as_deref(), Some("工作"));
            assert_eq!(db::load_task(&conn, &b.id).unwrap().unwrap().category.as_deref(), Some("工作"));
            assert_eq!(db::load_task(&conn, &c.id).unwrap().unwrap().category.as_deref(), Some("学习"));
        }

        // 清空也好撤（同一个命令、不同参数）：撤销之后只有 c 还在「学习」里
        let cleared = tasks::rename_category_impl(&state, "学习".into(), String::new()).expect("清空分类");
        assert_eq!(cleared, 1, "撤销之后只有 c 还在「学习」里");
        assert_eq!(undo_impl(&state).expect("撤销失败").label, "改分类");
        {
            let conn = state.db.lock().expect("锁库失败");
            assert_eq!(db::load_task(&conn, &c.id).unwrap().unwrap().category.as_deref(), Some("学习"), "撤销把分类还回来");
        }
    }

    /// round61（10.2 多选，6b 复核补）：批量命令也必须「**一条命令 = 一步撤销**」——
    /// 两块一起删，按**一次** Ctrl+Z 要整批回来（若命令层按每块 record，这里只会回来一块 → 红）。
    #[test]
    fn test_batch_command_is_one_undo_step() {
        let state = test_state();
        let task = tasks::create_task_impl(&state, "多选靶子".into(), None).expect("新建任务");
        let a = blocks::create_block_impl(&state, task.id.clone(), 1_000, 2_800)
            .expect("新建块")
            .block;
        let b = blocks::create_block_impl(&state, task.id.clone(), 4_000, 5_800)
            .expect("新建块")
            .block;

        let deleted = blocks::delete_blocks_impl(&state, vec![a.id.clone(), b.id.clone()])
            .expect("批量删除");
        assert_eq!(deleted, 2);
        assert_eq!(block_count(&state), 0);

        // 一次撤销：两块都要回来（不是一块一步）
        assert_eq!(undo_impl(&state).expect("撤销失败").label, "删除块");
        assert_eq!(block_count(&state), 2, "一次撤销要把整批一起还回来");
        assert!(block_start(&state, &a.id).is_some() && block_start(&state, &b.id).is_some());
    }

    /// round68（19.1）：命令层两个挂钩 —— ① `record` 后自动求值（建块 → 破土点亮）
    /// ② `undo` / `undo_delete` 信号（删块后撤销 → 亡羊补牢）
    /// （round85：唯一版本一定带成就 —— 以前这条测试用 `cfg(not(feature = "lite"))` 排除 Lite 档，已取消）
    #[test]
    fn test_achievement_hooks_on_record_and_undo() {
        let state = test_state();
        let task = tasks::create_task_impl(&state, "写周报".into(), None).expect("新建任务");
        let block = blocks::create_block_impl(&state, task.id.clone(), 1_000, 2_800)
            .expect("新建块")
            .block;

        let unlocked = |id: &str| -> bool {
            let conn = state.db.lock().expect("锁库失败");
            crate::achievements::list(&conn)
                .expect("列表")
                .rows
                .iter()
                .any(|r| r.id == id && r.unlocked)
        };

        // ① record 挂钩：建块后「破土」已点亮
        assert!(unlocked("first_block"), "record 末尾要自动求值");

        // ② 删块 → 撤销：「计划有变」「亡羊补牢」
        blocks::delete_blocks_impl(&state, vec![block.id.clone()]).expect("删块");
        assert!(!unlocked("batch_first"), "单块删除不算批量");
        undo_impl(&state).expect("撤销");
        assert!(unlocked("undo_first"), "撤销要点亮「计划有变」");
        assert!(unlocked("undo_after_delete"), "撤销删除要点亮「亡羊补牢」");
    }
}
