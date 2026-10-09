/**
 * round64（C10）：模板界面的纯函数（骨架行列标签）—— vitest 覆盖。
 * 坐标是与 Rust 共享的口径：`start_min` = 相对周一 00:00 的分钟。
 */
import { t } from "../i18n/i18n.svelte";
import type { SkeletonRow } from "../ipc/templates";

/** 周几的名字（周一 = 0）—— round74：从常量数组改成函数，切语言后跟着变 */
function dayNames(): readonly string[] {
  return [t("msg.templates.04"), t("msg.templates.05"), t("msg.templates.06"), t("msg.templates.07"), t("msg.templates.08"), t("msg.templates.09"), t("msg.templates.10")];
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 把「这一周里的分钟偏移」写成 `HH:MM`（跨天时取当天时刻 —— 一周内不会超过 24:00） */
export function clockOfWeekMinute(startMin: number): string {
  const minute = ((startMin % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`;
}

/** 一行骨架的人话：`周一 09:00–12:00`（超过 24 小时的行也不会写成怪时刻） */
export function skeletonRowLabel(row: SkeletonRow): string {
  const day = dayNames()[Math.min(6, Math.max(0, Math.floor(row.start_min / 1440)))];
  const start = clockOfWeekMinute(row.start_min);
  const end = clockOfWeekMinute(row.start_min + row.duration_min);
  return `${day} ${start}–${end}`;
}

/** 层的中文（只认两层；遗留值当弹性） */
export function layerLabel(layer: string): string {
  return layer === "required" ? t("msg.templates.11") : t("msg.templates.12");
}

/**
 * round64.1（验收 #2）：保存预览行的**名字** —— 有任务名就写「名字 · 分类」，
 * 没有就空串（无任务行：铺出来是临时安排）。
 */
export function skeletonRowName(row: SkeletonRow): string {
  const title = row.title?.trim();
  if (!title) return "";
  const category = row.category?.trim();
  return category ? `${title} · ${category}` : title;
}
