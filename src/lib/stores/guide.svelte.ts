/**
 * round64（C10）：引导条（渐进式提示 + 模板建议）的共享状态。
 *
 * 两条规则（`docs/plans/round64-c10-c11.md` §2.3 / §2.4）：
 * - **一次一条**：提示条只有一个槽；槽被占就不取新的（不推水位线，下次还有机会）；
 * - **可关且尊重「已关」**：提示的「全部关掉」写 `hints_enabled=0`；建议的「不再提」写
 *   `template_suggest.enabled=false`；两把锁都在设置面板里能再开。
 *
 * 与 `templates.svelte.ts` 的耦合用**动态 import**（`ui.svelte.ts` 对 history 也是这么做的）——
 * 静态引会形成 store 环（guide → templates → blocks → guide）。
 */
import { takeHint as ipcTakeHint } from "../ipc/hints";
import { takeTemplateSuggestion } from "../ipc/templates";
import { HINTS, type HintId } from "../utils/hints";
import { featureOn, prefs, saveFeature, saveTemplateSuggest } from "./settings.svelte";
import { note } from "./achievements.svelte";
import { prepareOpen, registerPanel } from "./panels.svelte";

export const guide = $state<{
  /** 正在显示的渐进提示（null = 没有） */
  hint: { id: HintId; text: string } | null;
  /** 要建议「存成模板」的那一周（周一 00:00；null = 没有） */
  suggestion: number | null;
  /** 说明页（round64：所有解释的唯一出口；`anchor` = 要跳到的分区） */
  helpOpen: boolean;
  helpAnchor: string | null;
  /** round64.1（验收 #4 复核）：设置里点「重看新手卡片」→ 强制再显示一次 */
  firstRunAgain: boolean;
}>({ hint: null, suggestion: null, helpOpen: false, helpAnchor: null, firstRunAgain: false });

/** 重看新手卡片（设置 → 引导与教程）—— 不改 `first_run_seen` 的原有语义 */
export function showFirstRunAgain(): void {
  guide.firstRunAgain = true;
}

export function dismissFirstRunAgain(): void {
  guide.firstRunAgain = false;
}

/** 打开说明页（可选跳到某个分区：`reminders` / `sanity` / `data` / `templates` / `hints` / `features`）
 *  round78（栈-01）：它是**子层**（从设置里打开）—— 关掉它回到设置面板 */
export function openHelp(anchor?: string): void {
  prepareOpen("help");
  guide.helpOpen = true;
  guide.helpAnchor = anchor ?? null;
  void note("help"); // round68（19.1）：暗章信号
}

export function closeHelp(): void {
  guide.helpOpen = false;
  guide.helpAnchor = null;
}

// round78（栈-01）：注册给面板栈（子层）
registerPanel({ id: "help", kind: "child", isOpen: () => guide.helpOpen, close: () => (closeHelp(), true) });

/** 某功能**第一次被用到**时调：后端说该提示才提示（一次一条；已关的槽不抢） */
export async function maybeHint(id: HintId): Promise<void> {
  if (!featureOn("hints_enabled")) return;
  if (guide.hint || guide.suggestion !== null) return; // 一次一条
  try {
    if (await ipcTakeHint(id)) {
      const meta = HINTS.find((h) => h.id === id);
      if (meta) guide.hint = { id, text: meta.text };
    }
  } catch {
    /* ipc 层已弹 Toast */
  }
}

export function dismissHint(): void {
  guide.hint = null;
}

/** 「全部关掉」：不只是收这一条，把渐进提示总开关关了（设置里可再开） */
export async function disableHints(): Promise<void> {
  guide.hint = null;
  await saveFeature("hints_enabled", false);
}

/** 启动 / 回到窗口 / 分钟轮询调：到条件就摆出「要不要把上周存成模板？」 */
export async function checkTemplateSuggestion(): Promise<void> {
  if (guide.suggestion !== null || guide.hint) return; // 一次一条
  if (!featureOn("templates_enabled")) return; // 模板关掉 → 建议也不提
  if (!prefs.templateSuggest.enabled) return;
  try {
    const week = await takeTemplateSuggestion();
    if (week !== null) guide.suggestion = week;
  } catch {
    /* ipc 层已弹 Toast */
  }
}

/** 「不再提」= 关掉模板建议（不是只藏这一条；设置里可再开） */
export async function stopSuggestions(): Promise<void> {
  guide.suggestion = null;
  await saveTemplateSuggest({ ...prefs.templateSuggest, enabled: false });
}

/** 点「存为模板…」：打开模板面板，并停在建议的那一周（生成对象可选） */
export async function openSuggestedTemplate(): Promise<void> {
  const week = guide.suggestion;
  guide.suggestion = null;
  if (week === null) return;
  const { openPicker } = await import("./templates.svelte");
  await openPicker(week);
}
