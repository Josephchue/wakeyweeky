import { call } from "./call";

/**
 * round64（C10）：模板（v2 ④ 的 `list_templates / create_template / apply_template / delete_template`
 * + `should_show_first_run` + 建议）。
 *
 * 这里只是壳：骨架预览 / 校验 / 建议规则全在 Rust `src-tauri/src/templates.rs`（唯一实现）。
 */

export interface TemplateInfo {
  id: string;
  name: string;
  block_count: number;
  created_at: number;
}

/** 模板的一行：相对**周一 00:00** 的分钟偏移。
 *  round64.1（验收 #2）：`title` = 要挂的任务名（临时块的块名也折在这里）、`category` = 任务分类；
 *  都没有 = 无任务行（铺出来是临时安排）。`label` 只为读老模板保留。 */
export interface SkeletonRow {
  start_min: number;
  duration_min: number;
  layer: string;
  title?: string | null;
  category?: string | null;
  label?: string | null;
}

export interface ApplyOutcome {
  created: number;
}

export function listTemplates(): Promise<TemplateInfo[]> {
  return call<TemplateInfo[]>("list_templates");
}

/** 某一周的骨架预览（只读；存之前可以删行） */
export function previewWeekSkeleton(weekStart: number): Promise<SkeletonRow[]> {
  return call<SkeletonRow[]>("preview_week_skeleton", { weekStart });
}

export function createTemplate(name: string, rows: SkeletonRow[]): Promise<TemplateInfo> {
  return call<TemplateInfo>("create_template", { name, rows });
}

/** 把模板铺到某一周（`weekStart` = 那一周的周一 00:00）；`Ctrl+Z` 一步撤 */
export function applyTemplate(id: string, weekStart: number): Promise<ApplyOutcome> {
  return call<ApplyOutcome>("apply_template", { id, weekStart });
}

export function deleteTemplate(id: string): Promise<void> {
  return call<void>("delete_template", { id });
}

/** 空库第一次打开 → 是否显示「先只安排今天就好」 */
export function shouldShowFirstRun(): Promise<boolean> {
  return call<boolean>("should_show_first_run");
}

export function markFirstRunSeen(): Promise<void> {
  return call<void>("mark_first_run_seen");
}

/** 到点该不该问一句「要不要把上周存成模板？」—— 返回要建议的那一周（周一 00:00） */
export function takeTemplateSuggestion(): Promise<number | null> {
  return call<number | null>("take_template_suggestion");
}
