import { getLocale, t, type MsgKey } from "../i18n/i18n.svelte";
import { addDays, startOfWeek } from "date-fns";
import {
  formatClock,
  formatClockRange,
  formatDateFragment,
  formatDateFull,
} from "./datetime.svelte";

// round81（3.1c₁）：时钟 / 日期渲染全部收口到 `utils/datetime.svelte.ts`（`时-08`）——
// 这里只留「周规则 / 标签骨架 / 时长」这些与格式档位无关的东西。
export { formatClock, formatClockRange };

/**
 * 时间轴起点：**每天 00:00**（一天 48 格）。
 *
 * 2026-10-01 用户拍板改掉 v5 的「06:00 到 24:00，共 36 格」—— 块本来就跨得到凌晨
 * （拖动一个长块就会跨过 24:00），06:00 起头会让 00:00–06:00 那段**根本没地方显示**。
 * 默认视野仍停在 06:00（`Timeline.svelte` 挂载时滚到那儿），所以日常观感不变。
 */
export const GRID_START_HOUR = 0;
/** 每格分钟数 */
export const SLOT_MINUTES = 30;
/** 每天格数：(24 - 6) * 60 / 30 = 36 */
export const SLOT_COUNT = ((24 - GRID_START_HOUR) * 60) / SLOT_MINUTES;
/** 一周的起始日：周一（v5 技术决策记录）。只在本文件内部使用，不需要导出 */
const WEEK_STARTS_ON = 1 as const;

/** 某个时刻所在的周（周一 00:00 起，左闭右开）—— `getCurrentWeek` 也走它，周规则只有一份 */
export function weekOf(ts: number): { from: number; to: number } {
  const start = startOfWeek(new Date(ts * 1000), { weekStartsOn: WEEK_STARTS_ON });
  return {
    from: Math.floor(start.getTime() / 1000),
    to: Math.floor(addDays(start, 7).getTime() / 1000),
  };
}

/** 周起点往前/往后挪 N 周（跳周用）。纯函数，配单测 */
export function shiftWeek(from: number, deltaWeeks: number): number {
  return Math.floor(addDays(new Date(from * 1000), deltaWeeks * 7).getTime() / 1000);
}

/** 当前周的时间区间（秒级时间戳，左闭右开：from 含，to 不含） */
export function getCurrentWeek(): { from: number; to: number } {
  return weekOf(Math.floor(Date.now() / 1000));
}

/** 时长说人话：`45 分钟` / `1 小时` / `1 小时 15 分`（手势中那行提示用） */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds / 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return t("msg.week.01", { minutes: minutes });
  if (minutes === 0) return t("msg.week.02", { hours: hours });
  return t("msg.week.03", { hours: hours, minutes: minutes });
}

/** 一周的 7 天（周一 ~ 周日） */
export function getWeekDays(weekStartSec: number): Date[] {
  const start = new Date(weekStartSec * 1000);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** 某一格（第 slotIndex 格）的起始时间戳（秒）。month 为 0-indexed，与 Date.getMonth() 一致。 */
export function getSlotStartSec(day: Date, slotIndex: number): number {
  const dayStart =
    new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      GRID_START_HOUR,
      0,
      0,
    ).getTime() / 1000;
  return Math.floor(dayStart) + slotIndex * SLOT_MINUTES * 60;
}

/**
 * round67：某一周的**周末窗口**（周六 00:00 → 下周一 00:00，Unix 秒）—— 隐藏周末时数块用。
 * 半开区间 `[start, end)`：正好在周六 00:00 结束的块不算、正好在周一 00:00 开始的块不算。
 */
export function weekendWindow(weekStartSec: number): { start: number; end: number } {
  const days = getWeekDays(weekStartSec);
  const start = getSlotStartSec(days[5], 0);
  return { start, end: getSlotStartSec(days[6], 0) + SLOT_COUNT * SLOT_MINUTES * 60 };
}

/** 顶部显示的周范围（骨架跟语言：zh `~`、en `–`）；里面的日期片段跟 `date_format` */
export function formatWeekRange(weekStartSec: number): string {
  const start = new Date(weekStartSec * 1000);
  const end = addDays(start, 6);
  const full = (d: Date) => formatDateFull(Math.floor(d.getTime() / 1000));
  return getLocale() === "en" ? `${full(start)} – ${full(end)}` : `${full(start)} ~ ${full(end)}`;
}

/** round74（3.0b₂）：短日期（列表 / 小牌）—— 片段口径，跟 `date_format`（round81 收口） */
export function formatShortDate(day: Date): string {
  return formatDateFragment(day);
}

/** round74（3.0b₂）：完整日期（秒级时间戳）—— 跟 `date_format`（round81 收口） */
export function formatDate(sec: number): string {
  return formatDateFull(sec);
}

/** 列头的周几（B5：以前用 date-fns 的 `EEE`，界面里会冒出英文 `Mon`；现在统一走消息层） */
const DAY_LABEL_KEYS: MsgKey[] = [
  "msg.week.04",
  "msg.week.05",
  "msg.week.06",
  "msg.week.07",
  "msg.week.08",
  "msg.week.09",
  "msg.week.10",
];

/** 周几的紧凑写法：zh = 一，en = Mon（柱下刻度用） */
export function weekdayShort(day: Date): string {
  const full = t(DAY_LABEL_KEYS[(day.getDay() + 6) % 7]);
  return getLocale() === "en" ? full : full.slice(1);
}

/** round81（「挤」）：周几的完整短名 —— zh = 周一，en = Mon（迷你预览窄档日头用；
 *  比 `weekdayShort` 长一点但不会被读成数字；整日期标签放不下的档位就用它） */
export function weekdayLabel(day: Date): string {
  return t(DAY_LABEL_KEYS[(day.getDay() + 6) % 7]);
}

/** 图表的行头（周几在前，如 周一 09-14 / Mon Sep 14）—— ReviewPanel 马赛克用 */
export function formatDayHead(day: Date): string {
  return `${t(DAY_LABEL_KEYS[(day.getDay() + 6) % 7])} ${formatShortDate(day)}`;
}

/** 某一天的列头，如 09-14 周一（zh）/ Mon, Sep 14（en） */
export function formatDayLabel(day: Date): string {
  return t("msg.week.11", { date: formatShortDate(day), weekday: t(DAY_LABEL_KEYS[(day.getDay() + 6) % 7]) });
}

/** 某一格的时刻文案，如 10:00 或 10:30（12 小时制下 `8:00 AM`） */
export function formatSlotLabel(slotIndex: number): string {
  const minutes = GRID_START_HOUR * 60 + slotIndex * SLOT_MINUTES;
  const sec = Math.floor(new Date(2026, 0, 1, 0, minutes, 0).getTime() / 1000);
  return formatClock(sec);
}
