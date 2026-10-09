import { t } from "../i18n/i18n.svelte";
import { addDays, isSameDay } from "date-fns";
import { GRID_START_HOUR, SLOT_COUNT, SLOT_MINUTES, getSlotStartSec, weekdayLabel } from "./week";
import { formatClock, formatDateFragment } from "./datetime.svelte";

const SLOT_SECONDS = SLOT_MINUTES * 60;

/** 第 slotIndex 格对应的「小时」→ 格号（例如 09:00 → 6，因为时间轴从 06:00 开始） */
function hourToSlot(hour: number): number {
  return Math.floor(((hour - GRID_START_HOUR) * 60) / SLOT_MINUTES);
}

/** [start, start + durationSlots 格) 是否完全空闲 */
function isFree(occupied: Set<number>, start: number, durationSlots: number): boolean {
  for (let k = 0; k < durationSlots; k++) {
    if (occupied.has(start + k * SLOT_SECONDS)) return false;
  }
  return true;
}

/** 在某天从 fromSlot 起找第一段连续空闲；越出本周上限（weekEndSec）就放弃这一天 */
function firstFreeOfDay(
  occupied: Set<number>,
  day: Date,
  fromSlot: number,
  durationSlots: number,
  weekEndSec: number,
): number | null {
  for (let i = Math.max(0, fromSlot); i + durationSlots <= SLOT_COUNT; i++) {
    const start = getSlotStartSec(day, i);
    if (start >= weekEndSec) return null;
    if (isFree(occupied, start, durationSlots)) return start;
  }
  return null;
}

/**
 * 漂流建议：给一个「没做成」的块推荐最多 3 个可用时段（纯函数，便于人肉推演）。
 *   ① 今天：从下一个整格开始的第一段连续空闲
 *   ② 明天：从 09:00 起
 *   ③ 本周末（周六）：从 10:00 起
 *   ④ 兜底：本周剩余天数里从 09:00 起逐天找，补满 3 个
 *
 * 关键约束：
 * - **只推荐本周之内的时间**。MVP 的时间轴只显示本周，把块排到下一周会「建了却看不见」。
 *   因此周日晚上（本周只剩今天）通常只给出 1 个建议 —— 这是正确行为，不是缺功能。
 * - **不早于这块现在的位置**（`notBefore`）。用户 2026-10-03 实测：「一块排在周六凌晨 01:00 的活，
 *   它给我建议今晚 21:30」—— 从「今天、从现在起」找空档就会**把它提到自己前面**，看着很怪。
 *   漂移只能往后，所以搜索起点取 `max(现在, 这块的起点)`（对已经过去的残影，两者一样）。
 */
export function suggestSlots(
  occupied: Set<number>,
  now: number,
  durationSlots: number,
  week: { from: number; to: number },
  /** 不许早于这个时刻（传这块自己的 `start_at`） */
  notBefore: number = now,
): number[] {
  const from = Math.max(now, notBefore);
  const today = new Date(from * 1000);
  const out: number[] = [];

  const push = (start: number | null) => {
    if (start === null || out.length >= 3) return;
    if (start >= week.from && start < week.to && !out.includes(start)) out.push(start);
  };

  const freeOf = (day: Date, hour: number) =>
    firstFreeOfDay(occupied, day, hourToSlot(hour), durationSlots, week.to);

  const dayStartToday = getSlotStartSec(today, 0);
  const nextSlotToday = Math.ceil((from - dayStartToday) / SLOT_SECONDS);
  push(firstFreeOfDay(occupied, today, nextSlotToday, durationSlots, week.to));
  push(freeOf(addDays(today, 1), 9));
  push(freeOf(addDays(today, (6 - today.getDay() + 7) % 7 || 7), 10));

  for (let d = 1; out.length < 3 && d <= 7; d++) {
    const day = addDays(today, d);
    if (getSlotStartSec(day, 0) >= week.to) break;
    push(freeOf(day, 9));
  }

  return out;
}

/** 把建议时段写成给人看的话：今天 20:00 / 明天 09:00 / 周六 10:00 / 10-05 周一 09:00 */
export function formatSuggestion(startSec: number, now: number): string {
  const d = new Date(startSec * 1000);
  const asToday = new Date(now * 1000);
  const time = formatClock(startSec);
  if (isSameDay(d, asToday)) return t("msg.drift.05", { time: time });
  // 2026-10-03（round52 顺手修）：「明天」必须按**传进来的 now** 算 ——
  // 以前用 date-fns 的 `isTomorrow(d)`（它比的是**真实今天**），函数白拿一个 now 参数却在
  // 这里偷看墙上时钟：跨过午夜就跑歪（单测直接红：10-02 写的用例在 10-03 失效）✗
  if (isSameDay(d, addDays(asToday, 1))) return t("msg.drift.06", { time: time });
  // round81（3.1c₁）：日期片段 / 周几 / 时刻全部走收口模块 —— 顺手把以前的
  // `format(d, "EEE")`（date-fns 英文周几，界面里会冒出 `Mon`）换成语言化的 `weekdayLabel`
  return `${formatDateFragment(d)} ${weekdayLabel(d)} ${time}`;
}
