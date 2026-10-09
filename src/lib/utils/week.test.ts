import { describe, expect, it } from "vitest";
import {
  formatDuration,
  getCurrentWeek,
  shiftWeek,
  weekendWindow,
  weekOf,
} from "./week";
import { formatClockRangeAt } from "./datetime.svelte";

/** 2026-09-30 是周三（本周一 = 09-28） */
const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  Math.floor(new Date(y, m - 1, d, h, min, 0).getTime() / 1000);

describe("weekOf（某个时刻属于哪一周）", () => {
  it("周三 → 本周一 00:00 起", () => {
    const w = weekOf(at(2026, 9, 30, 14, 30));
    expect(w.from).toBe(at(2026, 9, 28));
    expect(w.to).toBe(at(2026, 10, 5));
  });

  it("周一 00:00 整点 → 就是它自己那一周（左闭）", () => {
    expect(weekOf(at(2026, 9, 28, 0, 0)).from).toBe(at(2026, 9, 28));
  });

  it("周日 23:59 → 仍属于同一周（右开）", () => {
    expect(weekOf(at(2026, 10, 4, 23, 59)).from).toBe(at(2026, 9, 28));
  });

  it("跨月/跨年也算对（12-31 周四 → 12-28 周一）", () => {
    expect(weekOf(at(2026, 12, 31, 9)).from).toBe(at(2026, 12, 28));
  });
});

describe("shiftWeek（跳周）", () => {
  it("往后/往前各一周", () => {
    const from = at(2026, 9, 28);
    expect(shiftWeek(from, 1)).toBe(at(2026, 10, 5));
    expect(shiftWeek(from, -1)).toBe(at(2026, 9, 21));
  });

  it("挪完再取周归属，结果一致（不会跳到半周上）", () => {
    const from = at(2026, 9, 28);
    expect(weekOf(shiftWeek(from, 3)).from).toBe(shiftWeek(from, 3));
    expect(weekOf(shiftWeek(from, -5)).from).toBe(shiftWeek(from, -5));
  });
});

describe("formatClockRange（块上的起止时间）", () => {
  // CI 抓到的「假绿」（2026-10-09）：以前调隐式版的 `formatClockRange` —— 它读**活设置**
  // （`time_format` 默认 system）与**系统时间标签** → 开发机 zh-CN/24h 绿、GitHub runner（en-US/12h）
  // 算出 「9:15–9:45 AM」就红。改成显式给格式（与 `datetime.test.ts` 同口径：核心纯函数自报参数，不受机器影响）。
  it("整点与半点", () => {
    expect(
      formatClockRangeAt(at(2026, 9, 30, 9), at(2026, 9, 30, 10, 30), "h24", "zh-CN", "zh"),
    ).toBe("09:00–10:30");
  });

  it("15 分钟颗粒度也对（拉伸后的 :15/:45）", () => {
    expect(
      formatClockRangeAt(at(2026, 9, 30, 9, 15), at(2026, 9, 30, 9, 45), "h24", "zh-CN", "zh"),
    ).toBe("09:15–09:45");
    expect(
      formatClockRangeAt(at(2026, 9, 30, 23, 45), at(2026, 10, 1, 0, 0), "h24", "zh-CN", "zh"),
    ).toBe("23:45–00:00");
  });
});

describe("formatDuration（手势中那行提示用）", () => {
  it("分钟 / 整小时 / 小时加分钟", () => {
    expect(formatDuration(900)).toBe("15 分");
    expect(formatDuration(3600)).toBe("1 小时");
    expect(formatDuration(5400)).toBe("1 小时 30 分");
    expect(formatDuration(4500)).toBe("1 小时 15 分");
    expect(formatDuration(600)).toBe("10 分");
  });
});

describe("getCurrentWeek（行为不变：仍然是「现在这一周」）", () => {
  it("等于用「现在」去算的周", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(getCurrentWeek()).toEqual(weekOf(now));
  });
});

describe("weekendWindow（round67：隐藏周末时数块用）", () => {
  const overlaps = (w: { start: number; end: number }, s: number, e: number) =>
    s < w.end && e > w.start;

  it("周六 00:00 → 下周一 00:00", () => {
    const w = weekendWindow(at(2026, 9, 28));
    expect(w.start).toBe(at(2026, 10, 3)); // 周六
    expect(w.end).toBe(at(2026, 10, 5)); // 下周一
  });

  it("重叠判定：贴边不算、跨过周五夜算、跨到周一不算", () => {
    const w = weekendWindow(at(2026, 9, 28));
    expect(overlaps(w, w.start, w.start + 1800)).toBe(true); // 周六有块
    expect(overlaps(w, w.end - 1800, w.end)).toBe(true); // 周日夜尾
    expect(overlaps(w, w.start - 3600, w.start)).toBe(false); // 正好周六 00:00 结束
    expect(overlaps(w, w.end, w.end + 1800)).toBe(false); // 正好周一 00:00 开始
    expect(overlaps(w, w.start - 3600, w.start + 1800)).toBe(true); // 跨过周五夜的块
  });
});
