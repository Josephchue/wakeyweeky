//! round64（C10）：模板的命令层 —— 只加锁、包 `record`（一步撤销）；逻辑全在 `crate::templates`。
//!
//! 「命令本体」都拆出 `&AppState` 一层（本仓惯例）：集成测试要直接调，`State` 在测试里 new 不出来。

use tauri::State;

use crate::commands::history::record;
use crate::{templates, AppState};
use crate::i18n;

#[tauri::command]
pub fn list_templates(state: State<'_, AppState>) -> Result<Vec<templates::TemplateInfo>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    templates::list_templates(&conn)
}

/// 这一周（`week_start` = 那一周的周一 00:00）的骨架预览 —— 只读；改完再存
#[tauri::command]
pub fn preview_week_skeleton(
    state: State<'_, AppState>,
    week_start: i64,
) -> Result<Vec<templates::SkeletonRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    templates::preview_week_skeleton(&conn, week_start)
}

#[tauri::command]
pub fn create_template(
    state: State<'_, AppState>,
    name: String,
    rows: Vec<templates::SkeletonRow>,
) -> Result<templates::TemplateInfo, String> {
    create_template_impl(&state, name, rows)
}

#[tauri::command]
pub fn delete_template(state: State<'_, AppState>, id: String) -> Result<(), String> {
    delete_template_impl(&state, id)
}

/// 套用结果（前端 Toast：「已铺 N 块（Ctrl+Z 可撤）」）
#[derive(Debug, serde::Serialize)]
pub struct ApplyOutcome {
    pub created: usize,
}

#[tauri::command]
pub fn apply_template(
    state: State<'_, AppState>,
    id: String,
    week_start: i64,
) -> Result<ApplyOutcome, String> {
    apply_template_impl(&state, id, week_start)
}

#[tauri::command]
pub fn should_show_first_run(state: State<'_, AppState>) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    templates::should_show_first_run(&conn)
}

#[tauri::command]
pub fn mark_first_run_seen(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    templates::mark_first_run_seen(&conn)
}

/// 到点该不该问「要不要把上周存成模板？」—— `Some(那一周的周一)` / `None`
#[tauri::command]
pub fn take_template_suggestion(state: State<'_, AppState>) -> Result<Option<i64>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    templates::take_template_suggestion(&conn, crate::db::now())
}

// ---------------------------------------------------------------- 命令本体（好测）

pub(crate) fn create_template_impl(
    state: &AppState,
    name: String,
    rows: Vec<templates::SkeletonRow>,
) -> Result<templates::TemplateInfo, String> {
    record(state, i18n::t(i18n::msg::ERR_CMD_TEMPLATES_01), |conn| templates::create_template(conn, &name, &rows))
}

pub(crate) fn delete_template_impl(state: &AppState, id: String) -> Result<(), String> {
    record(state, i18n::t(i18n::msg::ERR_CMD_TEMPLATES_02), |conn| templates::delete_template(conn, &id))
}

pub(crate) fn apply_template_impl(
    state: &AppState,
    id: String,
    week_start: i64,
) -> Result<ApplyOutcome, String> {
    let created = record(state, i18n::t(i18n::msg::ERR_CMD_TEMPLATES_03), |conn| {
        templates::apply_template(conn, &id, week_start)
    })?;
    crate::notify::wake_notifier(); // 新块可能马上要到点 —— 叫醒提醒线程
    Ok(ApplyOutcome { created })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::history::{undo_impl, History};
    use crate::db::{list_blocks, test_conn};
    use crate::sanity::{local_day_add, local_day_start, week_start_of};
    use chrono::{Local, TimeZone};
    use std::sync::Mutex;

    fn test_state() -> AppState {
        AppState {
            db: Mutex::new(test_conn()),
            history: Mutex::new(History::default()),
        }
    }

    fn week() -> i64 {
        let naive = chrono::NaiveDate::from_ymd_opt(2026, 10, 7)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let ts = Local.from_local_datetime(&naive).earliest().unwrap().timestamp();
        week_start_of(local_day_start(ts))
    }

    fn rows() -> Vec<templates::SkeletonRow> {
        vec![
            templates::SkeletonRow { start_min: 540, duration_min: 180, layer: "required".into(), title: None, category: None, label: None },
            templates::SkeletonRow { start_min: 1200, duration_min: 60, layer: "elastic".into(), title: None, category: None, label: Some("夜读".into()) },
        ]
    }

    /// 套用 = 一步撤销：Ctrl+Z 一次把整铺撤掉，而「保存模板」那一步还留在栈里
    #[test]
    fn test_apply_is_one_undo_step() {
        let state = test_state();
        let target = week();
        let info = create_template_impl(&state, "工作日".into(), rows()).unwrap();
        let out = apply_template_impl(&state, info.id.clone(), target).unwrap();
        assert_eq!(out.created, 2);
        {
            let conn = state.db.lock().unwrap();
            assert_eq!(list_blocks(&conn, target, local_day_add(target, 7)).unwrap().len(), 2);
        }
        let undone = undo_impl(&state).unwrap();
        assert_eq!(undone.label, "套用模板");
        {
            let conn = state.db.lock().unwrap();
            assert!(
                list_blocks(&conn, target, local_day_add(target, 7)).unwrap().is_empty(),
                "一次撤销应把整铺撤干净"
            );
            assert_eq!(templates::list_templates(&conn).unwrap().len(), 1, "模板本身还在");
        }
        // 再撤一步才是「保存模板」
        assert_eq!(undo_impl(&state).unwrap().label, "保存模板");
    }

    /// 删模板也走 record → 能撤回来
    #[test]
    fn test_delete_template_is_undoable() {
        let state = test_state();
        let info = create_template_impl(&state, "工作日".into(), rows()).unwrap();
        delete_template_impl(&state, info.id.clone()).unwrap();
        {
            let conn = state.db.lock().unwrap();
            assert!(templates::list_templates(&conn).unwrap().is_empty());
        }
        assert_eq!(undo_impl(&state).unwrap().label, "删除模板");
        {
            let conn = state.db.lock().unwrap();
            assert_eq!(templates::list_templates(&conn).unwrap().len(), 1, "撤销后模板回来了");
        }
    }
}
