import { t } from "../i18n/i18n.svelte";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { call } from "./call";
import type { BlockPriority } from "./types";
import { toast } from "../stores/ui.svelte";
/** 后端在每条提醒发出后广播的事件载荷 */
type RemindedPayload = {
  block_id: string;
  task_title: string;
  priority: BlockPriority;
  /** round49：`start` = 该开始了（块开始时报一次）；`end` = 到点了（块结束时那条，原来就有） */
  kind: "start" | "end";
};

/** 应用内提示按优先级加前缀，让你一眼看出这是哪一层的提醒（C1.4 起两档）。
 *  round74（3.0b₂）：从常量表改成函数 —— 不然切语言后前缀不会变。 */
function priorityMark(p: BlockPriority): string {
  if (p === "high") return t("msg.notify.01");
  if (p === "low") return t("msg.notify.02");
  return "";
}

/** 补一句「该去哪标记」。必填层走的是带按钮的通知，所以直接指路「在通知上点 ✓/✗」 */
function priorityHint(p: BlockPriority): string {
  if (p === "high") return t("msg.notify.03");
  if (p === "low") return t("msg.notify.04");
  return "";
}

/**
 * 订阅「提醒已发出」事件：让提醒在应用内也看得见。
 * 系统通知被专注助手/通知设置挡住时，这条应用内提示就是兜底。
 * 返回取消订阅函数（组件卸载时调用）。
 */
export function onReminded(): Promise<UnlistenFn> {
  return listen<RemindedPayload>("block-reminded", (event) => {
    const p = event.payload.priority;
    const mark = priorityMark(p);
    const hint = priorityHint(p);
    // round49：开始提醒说「该开始了」；结束提醒那句「到点了」一个字不动
    const what = event.payload.kind === "start" ? t("msg.notify.05") : t("msg.notify.06");
    toast(t("msg.notify.07", { mark: mark, task_title: event.payload.task_title, what: what, hint: hint }));
  });
}

/**
 * 启动时问后端：我不在的时候有几个块到点了？
 * 后端只提示、但**不会改那些块**（用户拍板：不要标记）；同一批块只会提示一次。
 */
export function missedSummary(): Promise<number> {
  return call<number>("missed_summary");
}
