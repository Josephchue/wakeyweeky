/**
 * round64（C10）：模板的界面状态 —— 打开 / 名单 / 预览行 / 周步进。
 *
 * 逻辑（校验 / 建议规则 / 套用）全在 Rust `templates.rs`（唯一实现）；这里只做「拉、改、发」，
 * 写失败由 `ipc/call.ts` 弹 Toast、界面状态不动（不做假成功）。
 */
import { t } from "../i18n/i18n.svelte";
import { prepareOpen, registerPanel } from "./panels.svelte";
import {
  applyTemplate as ipcApplyTemplate,
  createTemplate,
  deleteTemplate,
  listTemplates,
  previewWeekSkeleton,
  type SkeletonRow,
  type TemplateInfo,
} from "../ipc/templates";
import { shiftWeek } from "../utils/week";
import { reloadWeek } from "./blocks.svelte";
import { toastUndo } from "./ui.svelte";
import { week } from "./week.svelte";

export const templates = $state<{
  /** 面板开着吗 */
  open: boolean;
  /** 已存的模板（新的在前；每次打开重拉） */
  list: TemplateInfo[];
  /** 保存区的坐标：哪一周的骨架（可 ‹ › 步进） */
  weekStart: number;
  /** 保存区的预览行（可删行 —— 「生成后可改」） */
  rows: SkeletonRow[];
  /** 保存区的名字 */
  name: string;
}>({
  open: false,
  list: [],
  weekStart: 0,
  rows: [],
  name: "",
});

/** 打开面板；不传周就用正在看的那一周（从建议条进来时传建议的那一周） */
export async function openPicker(weekStart?: number): Promise<void> {
  prepareOpen("templates"); // round78（栈-01）：同级开口 → 先把别的同级/子层关掉
  templates.open = true;
  templates.name = "";
  templates.weekStart = weekStart ?? week.from;
  await Promise.all([loadList(), loadPreview(templates.weekStart)]);
}

export function closePicker(): void {
  templates.open = false;
}

// round78（栈-01）：注册给面板栈（同级 —— 顶栏入口）
registerPanel({ id: "templates", kind: "sibling", isOpen: () => templates.open, close: () => (closePicker(), true) });

/** 重拉名单（打开时、保存/删除后、以及 Ctrl+Z 之后由 history 统一调） */
export async function loadList(): Promise<void> {
  try {
    templates.list = await listTemplates();
  } catch {
    /* ipc 层已弹 Toast */
  }
}

/** 读某一周的骨架预览 */
export async function loadPreview(weekStart: number): Promise<void> {
  templates.weekStart = weekStart;
  try {
    templates.rows = await previewWeekSkeleton(weekStart);
  } catch {
    templates.rows = [];
  }
}

/** 保存区的周步进（‹ ›，与对比基线同一套交互） */
export async function stepPreviewWeek(delta: number): Promise<void> {
  await loadPreview(shiftWeek(templates.weekStart, delta));
}

/** 从骨架里去掉一行（只在内存里改；存下去的就是删完的样子） */
export function removeRow(index: number): void {
  templates.rows = templates.rows.filter((_, i) => i !== index);
}

/** 存模板（名字空 / 没有行就什么都不做 —— 按钮也是灰的） */
export async function saveTemplate(): Promise<void> {
  const name = templates.name.trim();
  if (!name || templates.rows.length === 0) return;
  try {
    const info = await createTemplate(name, templates.rows);
    templates.name = "";
    toastUndo(t("msg.templates.01", { name: info.name, block_count: info.block_count }));
    await loadList();
  } catch {
    /* ipc 层已弹 Toast */
  }
}

/** 把模板铺到**正在看的那一周**（步进只影响保存区；铺是铺眼前的这一周） */
export async function applyTemplate(id: string): Promise<void> {
  try {
    const out = await ipcApplyTemplate(id, week.from);
    toastUndo(t("msg.templates.02", { created: out.created }));
    await reloadWeek();
  } catch {
    /* ipc 层已弹 Toast */
  }
}

/** 删模板（可撤销：history 的 sync 会把名单一起重拉） */
export async function removeTemplate(id: string): Promise<void> {
  try {
    await deleteTemplate(id);
    toastUndo(t("msg.templates.03"));
    await loadList();
  } catch {
    /* ipc 层已弹 Toast */
  }
}
