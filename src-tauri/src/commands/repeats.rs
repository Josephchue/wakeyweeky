//! round69（B3）：每周重复的命令层 —— 参数转换 + 锁管理 + `record`（业务逻辑在 `repeats.rs` / `db.rs`）。
//!
//! 两条纪律：
//! - **每条写命令 = 一次 `record`**（Ctrl+Z 一步撤销）；生成也是 —— 它的块与水位线在同一份快照里，
//!   撤销后下次打开那一周会重新生成（幂等，玩家能预期）。
//! - 生成挂在**打开某一周**上（前端 `reloadWeek`）；功能开关关掉 → 静默跳过（不报错，不拦显示）。

use tauri::State;

use crate::commands::history::record;
use crate::features;
use crate::repeats as logic;
use crate::AppState;
use crate::i18n;

/// 规则名单（`taskId` 给了就只列那个任务的；只读，不进历史）
#[tauri::command]
pub fn list_repeats(
    state: State<'_, AppState>,
    task_id: Option<String>,
) -> Result<Vec<logic::Repeat>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    logic::list_repeats(&conn, task_id.as_deref())
}

/// 给一个任务加一条重复规则（校验 + 上限在 `repeats.rs`）
#[tauri::command]
pub fn create_repeat(
    state: State<'_, AppState>,
    task_id: String,
    weekday: i64,
    start_min: i64,
    layer: String,
) -> Result<logic::Repeat, String> {
    create_repeat_impl(&state, task_id, weekday, start_min, layer)
}

/// 命令本体（同 `blocks::create_block_impl`：好让集成测试直接调命令层）
pub(crate) fn create_repeat_impl(
    state: &AppState,
    task_id: String,
    weekday: i64,
    start_min: i64,
    layer: String,
) -> Result<logic::Repeat, String> {
    record(state, i18n::t(i18n::msg::ERR_CMD_REPEATS_01), |conn| {
        logic::create_repeat(conn, &task_id, weekday, start_min, &layer)
    })
}

/// 暂停 / 启用一条规则
#[tauri::command]
pub fn set_repeat_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<logic::Repeat, String> {
    set_repeat_enabled_impl(&state, id, enabled)
}

/// 命令本体
pub(crate) fn set_repeat_enabled_impl(
    state: &AppState,
    id: String,
    enabled: bool,
) -> Result<logic::Repeat, String> {
    let what = if enabled { i18n::t(i18n::msg::ERR_CMD_REPEATS_02) } else { i18n::t(i18n::msg::ERR_CMD_REPEATS_03) };
    record(state, what, |conn| logic::set_repeat_enabled(conn, &id, enabled))
}

/// 删一条规则（occurrences 跟着 CASCADE）
#[tauri::command]
pub fn delete_repeat(state: State<'_, AppState>, id: String) -> Result<(), String> {
    delete_repeat_impl(&state, id)
}

/// 命令本体
pub(crate) fn delete_repeat_impl(state: &AppState, id: String) -> Result<(), String> {
    record(state, i18n::t(i18n::msg::ERR_CMD_REPEATS_04), |conn| logic::delete_repeat(conn, &id))
}

/// 打开某一周时补这一周的重复块；返回新建的块数（0 = 无事可做，包括开关关掉）
#[tauri::command]
pub fn generate_repeats(state: State<'_, AppState>, week_start: i64) -> Result<usize, String> {
    generate_repeats_impl(&state, week_start)
}

/// 命令本体：开关、时间都由这里定（`logic::generate_week` 只认参数，好测）
pub(crate) fn generate_repeats_impl(state: &AppState, week_start: i64) -> Result<usize, String> {
    // 先探一眼：开关关着 / 一条规则都没有 → 直接返回（**不拍快照**）。
    // 6b P2：`record` 前后各拍一份全表（含 `events`），而多数用户根本没有重复规则 ——
    // 每次跳周白跑两份快照不划算。探针是两条 LIMIT 1 的小查询。
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        if !features::enabled(&conn, features::REPEAT) || !logic::any_enabled(&conn)? {
            return Ok(0);
        }
    }
    let created = record(state, i18n::t(i18n::msg::ERR_CMD_REPEATS_05), |conn| {
        logic::generate_week(conn, week_start, crate::db::now())
    })?;
    if created > 0 {
        // 新块可能是「本轮还没到点」的，但托盘/曲线会跟着变 → 叫醒提醒线程重算基线
        crate::notify::wake_notifier();
    }
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::history::History;
    use crate::db;
    use std::sync::Mutex;

    /// 命令层集成测试的假状态（同 `commands/history.rs` 的 `test_state`：
    /// `tauri::State` 在测试里 new 不出来 —— 原因见那边的长注释；这里直接调 `*_impl`）
    fn test_state() -> AppState {
        AppState {
            db: Mutex::new(db::test_conn()),
            history: Mutex::new(History::default()),
        }
    }

    fn ts(y: i32, m: u32, d: u32) -> i64 {
        use chrono::{Local, TimeZone};
        Local
            .from_local_datetime(
                &chrono::NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(0, 0, 0).unwrap(),
            )
            .earliest()
            .unwrap()
            .timestamp()
    }

    /// 基准周：2031-01-13（周一）—— 与 `repeats.rs` 的测试同一套坐标
    fn week() -> i64 {
        ts(2031, 1, 13)
    }

    /// 生成 = **一步撤销**：撤销后块与水位线一起回退，再生成一次又回来（幂等）
    #[test]
    fn test_generate_repeats_is_one_undo_step() {
        let state = test_state();
        let task = {
            let conn = state.db.lock().unwrap();
            db::create_task(&conn, "健身", None).unwrap()
        };
        create_repeat_impl(&state, task.id.clone(), 2, 19 * 60, "required".into()).unwrap();

        // 生成 + 撤销 + 再生成 —— 全程只有一步历史
        assert_eq!(generate_repeats_impl(&state, week()).unwrap(), 1);
        {
            let conn = state.db.lock().unwrap();
            assert_eq!(db::count_blocks(&conn).unwrap(), 1);
        }
        crate::commands::history::undo_impl(&state).unwrap();
        {
            let conn = state.db.lock().unwrap();
            assert_eq!(db::count_blocks(&conn).unwrap(), 0, "撤销把块带走了");
            let occ: i64 = conn
                .query_row("SELECT COUNT(*) FROM repeat_occurrences", [], |r| r.get(0))
                .unwrap();
            assert_eq!(occ, 0, "水位线也一起回退（同一份快照）");
        }
        assert_eq!(generate_repeats_impl(&state, week()).unwrap(), 1, "再生成又回来");
    }

    /// 建规则 / 暂停 / 删除各自 = 一步撤销
    #[test]
    fn test_rule_writes_are_undoable() {
        let state = test_state();
        let task = {
            let conn = state.db.lock().unwrap();
            db::create_task(&conn, "健身", None).unwrap()
        };
        create_repeat_impl(&state, task.id.clone(), 2, 19 * 60, "elastic".into()).unwrap();
        assert_eq!(logic::list_repeats(&state.db.lock().unwrap(), None).unwrap().len(), 1);

        crate::commands::history::undo_impl(&state).unwrap();
        assert_eq!(
            logic::list_repeats(&state.db.lock().unwrap(), None).unwrap().len(),
            0,
            "撤销掉刚建的规则"
        );

        // 再来一遍：暂停 → 撤销 → 又是启用
        let rule = create_repeat_impl(&state, task.id.clone(), 2, 19 * 60, "elastic".into()).unwrap();
        set_repeat_enabled_impl(&state, rule.id.clone(), false).unwrap();
        assert!(!logic::list_repeats(&state.db.lock().unwrap(), None).unwrap()[0].enabled);
        crate::commands::history::undo_impl(&state).unwrap();
        assert!(logic::list_repeats(&state.db.lock().unwrap(), None).unwrap()[0].enabled);

        delete_repeat_impl(&state, rule.id.clone()).unwrap();
        assert_eq!(logic::list_repeats(&state.db.lock().unwrap(), None).unwrap().len(), 0);
        crate::commands::history::undo_impl(&state).unwrap();
        assert_eq!(logic::list_repeats(&state.db.lock().unwrap(), None).unwrap().len(), 1);
    }

    /// round69.1（#4 / D2）：暂停是**一步撤销** —— 被撤下的块与水位线一起回来
    #[test]
    fn test_pause_undo_restores_removed_blocks() {
        let state = test_state();
        let task = {
            let conn = state.db.lock().unwrap();
            db::create_task(&conn, "健身", None).unwrap()
        };
        let rule = create_repeat_impl(&state, task.id.clone(), 2, 19 * 60, "elastic".into()).unwrap();
        assert_eq!(generate_repeats_impl(&state, week()).unwrap(), 1);
        set_repeat_enabled_impl(&state, rule.id.clone(), false).unwrap();
        {
            let conn = state.db.lock().unwrap();
            assert_eq!(db::count_blocks(&conn).unwrap(), 0, "未开始的块被撤下");
        }
        crate::commands::history::undo_impl(&state).unwrap();
        {
            let conn = state.db.lock().unwrap();
            assert_eq!(db::count_blocks(&conn).unwrap(), 1, "撤销把块带回来");
            let occ: i64 = conn
                .query_row("SELECT COUNT(*) FROM repeat_occurrences", [], |r| r.get(0))
                .unwrap();
            assert_eq!(occ, 1, "水位线一起回来");
            assert!(logic::list_repeats(&conn, None).unwrap()[0].enabled, "规则恢复启用");
        }
    }

    /// 功能开关关掉 → 不生成（静默），开关开回来照生成；已经有规则/块都留着
    #[test]
    fn test_generate_respects_feature_switch() {
        let state = test_state();
        let task = {
            let conn = state.db.lock().unwrap();
            db::create_task(&conn, "健身", None).unwrap()
        };
        create_repeat_impl(&state, task.id.clone(), 2, 19 * 60, "elastic".into()).unwrap();
        {
            let conn = state.db.lock().unwrap();
            db::set_setting(&conn, features::REPEAT, "0").unwrap();
        }
        assert_eq!(generate_repeats_impl(&state, week()).unwrap(), 0, "关掉 = 不生成");
        {
            let conn = state.db.lock().unwrap();
            db::set_setting(&conn, features::REPEAT, "1").unwrap();
        }
        assert_eq!(generate_repeats_impl(&state, week()).unwrap(), 1, "开回来照生成");
    }
}
