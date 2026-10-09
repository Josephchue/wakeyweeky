/**
 * C6 理智值（round44 / 0.8.0）。
 *
 * 这里只做三件事：把后端算好的曲线拿回来 / 供组件读某一天的量 / 改两个设置项（预算、开关）。
 * **不重算任何规则** —— 算法唯一实现在 Rust `src-tauri/src/sanity.rs`（前端抄一份就是假绿温床）。
 *
 * 为什么要这一层（而不是让组件自己调 ipc）：
 * - 防竞态（照 `blocks.svelte.ts` 的 0.6.37 口径）：翻周时可能有两个请求在飞，
 *   只认「**还是我在看的那一周**」的响应，并且只让**真的写进 store 过**的那份占位。
 * - `reloadWeek()` 之后顺手拉一次（每次写操作、翻周都会走到那儿）。
 */
import { getSanityCurve } from "../ipc/sanity";
import { getSettings, setSetting } from "../ipc/settings";
import type { SanityDay, SanityWeek } from "../ipc/types";
import { week } from "./week.svelte";

/** 默认预算（分钟）——与 Rust `sanity::DEFAULT_BUDGET_MINUTES` 一致；真值永远以后端为准 */
const DEFAULT_BUDGET_MINUTES = 360;

export const sanity = $state<{
  /** 正在看的那一周的曲线（还没拉到 → null） */
  week: SanityWeek | null;
  /** 生效的每日预算（分钟；设置里可改） */
  budgetMinutes: number;
  /** 功能开着吗（关掉后：日头小条 / 顶部一句话 / 托盘红环三处都不出现） */
  enabled: boolean;
}>({ week: null, budgetMinutes: DEFAULT_BUDGET_MINUTES, enabled: true });

/**
 * round77（3.1b）：橙条（预算超载）**被关掉的那一周** —— 放在 store 里而不是组件里：
 * `Timeline` 算「提示条同屏最多一条」的优先级时也要看得到（否则组件说「关了」、
 * Timeline 还以为它在展示，于是把绿条/渐进提示一起憋掉 —— 我实测踩过）。
 * 语义（你 2026-10-05 拍）：**会话内关闭**，不写库；换周或重开应用按需再出现。
 */
export const sanityBar = $state<{ dismissedWeek: number | null }>({ dismissedWeek: null });

/**
 * round49（用户 2026-10-03：「开始提醒与结束提醒我都想在设置页设个开关」）：
 * 两个提醒开关。**暂时跟理智值设置放在同一个 ⚙ 弹层里**（都用 `get_settings` 那套白名单）——
 * C18 做完整设置页时，把它们连同预算/栏宽一起搬进一个真正的 settings store。
 */
export const reminders = $state<{ start: boolean; end: boolean }>({ start: true, end: true });

let loadSeq = 0;
let lastWrittenSeq = 0;

/** 拉**正在看的那一周**的曲线。失败只记日志（绝不能连累时间轴本身）。 */
export async function loadSanity(): Promise<void> {
  const from = week.from;
  const seq = ++loadSeq;
  try {
    const data = await getSanityCurve(from);
    // 这一份不是当前视图要的 → 丢（翻周时会同时有几个请求在飞）
    if (from !== week.from) return;
    // 窗口对，但还是旧的（更晚发起的那次已经写进去了）→ 丢
    if (seq < lastWrittenSeq) return;
    sanity.week = data;
    sanity.budgetMinutes = data.budget;
    sanity.enabled = data.enabled;
    lastWrittenSeq = seq;
  } catch (err) {
    console.error("[sanity] 拉这一周的耗能失败（界面照常）", err);
  }
}

/** 某一天的量（没有数据 → null） */
export function dayOf(dayStart: number): SanityDay | null {
  return sanity.week?.days.find((d) => d.day_start === dayStart) ?? null;
}

/** 这一周**超载**的那几天（顶部那句话用；按天序） */
export function overloadedDays(): SanityDay[] {
  return (sanity.week?.days ?? []).filter((d) => d.state === "over");
}

/** 启动时读一次设置（开关关着时曲线也照样返回，但这儿的默认值要跟后端对齐） */
export async function loadSanitySettings(): Promise<void> {
  try {
    const s = await getSettings();
    const minutes = Number(s.values["sanity_budget_minutes"]);
    if (Number.isFinite(minutes) && minutes > 0) sanity.budgetMinutes = minutes;
    sanity.enabled = (s.values["sanity_enabled"] ?? "1") !== "0";
    reminders.start = (s.values["remind_start"] ?? "1") !== "0";
    reminders.end = (s.values["remind_end"] ?? "1") !== "0";
  } catch (err) {
    console.error("[sanity] 读设置失败（用默认值）", err);
  }
}

/** 改预算（小时；界面用小时，后端存分钟）。失败返回 false（ipc 层已弹 Toast） */
export async function saveBudgetHours(hours: number): Promise<boolean> {
  const minutes = Math.round(hours * 60);
  try {
    await setSetting("sanity_budget_minutes", String(minutes));
  } catch {
    return false;
  }
  sanity.budgetMinutes = minutes;
  await loadSanity(); // 立即重算：小条长度与顶部那句话跟着变
  return true;
}

/** round49：开/关某个提醒（失败返回 false；调用方把开关拨回去） */
export async function setReminder(kind: "start" | "end", on: boolean): Promise<boolean> {
  try {
    await setSetting(kind === "start" ? "remind_start" : "remind_end", on ? "1" : "0");
  } catch {
    return false;
  }
  if (kind === "start") reminders.start = on;
  else reminders.end = on;
  return true;
}

/** 开/关理智值。失败返回 false（调用方把开关拨回去） */
export async function setSanityEnabled(on: boolean): Promise<boolean> {
  try {
    await setSetting("sanity_enabled", on ? "1" : "0");
  } catch {
    return false;
  }
  sanity.enabled = on;
  return true;
}
