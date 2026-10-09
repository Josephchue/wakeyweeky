/**
 * C18（round63 / R41）免打扰的**纯函数**（不碰 store、不碰 IPC —— 便于单测）。
 *
 * 口径与 Rust 侧**同一套**（`notify::parse_hhmm` / `notify::next_daily_moment`）：
 * - 「明早」是用户可改的一个**本地时刻**（默认 08:00）；
 * - 「到明早」= **下一个**该时刻（严格晚于 now：02:00 点 = 当天 08:00，09:00 点 = 次日 08:00）。
 */
import { formatClock, formatDateFragment } from "./datetime.svelte";

/** 解析 `"8:00"` / `"08:00"` / `"9:5"` → `{hour, minute}`；不合法 → `null`。
 * 宽容度与 Rust `notify::parse_hhmm` **同一套**（round82 · 6b：以前前端故意更严 → 同一份外改的库会有两种解释） */
export function parseHHMM(raw: string): { hour: number; minute: number } | null {
  const m = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(raw);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** 规范写法 `"HH:MM"`（解析失败 → null） */
export function normalizeHHMM(raw: string): string | null {
  const parsed = parseHHMM(raw);
  if (!parsed) return null;
  return `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
}

/** 「到明早」的截止时刻：下一个本地 HH:MM（非法 / 缺省回退 08:00） */
export function nextDailyMoment(now: Date, hhmm: string): Date {
  const { hour, minute } = parseHHMM(hhmm) ?? { hour: 8, minute: 0 };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (today.getTime() > now.getTime()) return today;
  // 用「日期 + 1」构造（不用 +86400 秒：夏令时那天不会错位）
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, minute, 0, 0);
}

/** 显示用：`10-05 08:00`（本地时间；「暂停提醒」的状态行）—— round81 起跟着 `date_format` / `time_format` */
export function formatQuietUntil(ms: number): string {
  const d = new Date(ms);
  return `${formatDateFragment(d)} ${formatClock(Math.floor(ms / 1000))}`;
}
