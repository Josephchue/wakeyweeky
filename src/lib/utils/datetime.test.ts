import { describe, expect, it } from "vitest";
import {
  DATE_FORMATS,
  TIME_FORMATS,
  formatClockAt,
  formatClockRangeAt,
  formatDateFragmentAt,
  formatDateFullAt,
  normalizeDateFormat,
  normalizeTimeFormat,
  sampleClock,
  sampleDate,
} from "./datetime.svelte";

/** 本地时间戳（月从 0 数）；纯核心都显式给格式 / 系统标签 / 界面语言，测试不受机器影响 */
const at = (y: number, m: number, d: number, h = 0, mi = 0) =>
  Math.floor(new Date(y, m - 1, d, h, mi, 0).getTime() / 1000);
const day = new Date(2026, 9, 5, 20, 30, 0);

describe("formatClockAt（单个时刻）", () => {
  it("24 小时：零填充（= 旧行为）", () => {
    expect(formatClockAt(at(2026, 10, 5, 8, 0), "h24", "zh-CN", "zh")).toBe("08:00");
    expect(formatClockAt(at(2026, 10, 5, 20, 30), "h24", "en-US", "en")).toBe("20:30");
  });
  it("12 小时：整点不省 `:00`（时-11）；zh 上午/下午前缀、en AM/PM 后缀", () => {
    expect(formatClockAt(at(2026, 10, 5, 8, 0), "h12", "zh-CN", "zh")).toBe("上午8:00");
    expect(formatClockAt(at(2026, 10, 5, 20, 30), "h12", "zh-CN", "zh")).toBe("下午8:30");
    expect(formatClockAt(at(2026, 10, 5, 20, 30), "h12", "en-US", "en")).toBe("8:30 PM");
    expect(formatClockAt(at(2026, 10, 5, 0, 5), "h12", "en-US", "en")).toBe("12:05 AM");
  });
  it("system：看系统标签的 CLDR（zh/en-US = 12h 下表；en-GB / de-DE = 24 小时）", () => {
    expect(formatClockAt(at(2026, 10, 5, 20, 30), "system", "zh-CN", "zh")).toBe("20:30");
    expect(formatClockAt(at(2026, 10, 5, 20, 30), "system", "en-US", "en")).toBe("8:30 PM");
    expect(formatClockAt(at(2026, 10, 5, 20, 30), "system", "en-GB", "en")).toBe("20:30");
    expect(formatClockAt(at(2026, 10, 5, 20, 30), "system", "de-DE", "en")).toBe("20:30");
  });
});

describe("formatClockRangeAt（时段）", () => {
  it("24 小时：与旧实现逐字一致", () => {
    expect(formatClockRangeAt(at(2026, 10, 5, 9), at(2026, 10, 5, 10, 30), "h24", "zh-CN", "zh")).toBe(
      "09:00–10:30",
    );
    expect(formatClockRangeAt(at(2026, 10, 5, 23, 45), at(2026, 10, 6, 0, 0), "h24", "zh-CN", "zh")).toBe(
      "23:45–00:00",
    );
  });
  it("12 小时：同时段后缀只写一次；跨上下午写两次", () => {
    expect(formatClockRangeAt(at(2026, 10, 5, 8), at(2026, 10, 5, 9), "h12", "en-US", "en")).toBe(
      "8:00–9:00 AM",
    );
    expect(formatClockRangeAt(at(2026, 10, 5, 11), at(2026, 10, 5, 13), "h12", "en-US", "en")).toBe(
      "11:00 AM–1:00 PM",
    );
    expect(formatClockRangeAt(at(2026, 10, 5, 8), at(2026, 10, 5, 9), "h12", "zh-CN", "zh")).toBe(
      "上午8:00–9:00",
    );
    expect(formatClockRangeAt(at(2026, 10, 5, 11), at(2026, 10, 5, 13), "h12", "zh-CN", "zh")).toBe(
      "上午11:00–下午1:00",
    );
  });
});

describe("formatDateFragmentAt / formatDateFullAt（日期）", () => {
  it("固定档：dash / slash / long（zh 中长式、en 英语长式）", () => {
    expect(formatDateFragmentAt(day, "dash", "zh-CN", "zh")).toBe("10-05");
    expect(formatDateFragmentAt(day, "slash", "zh-CN", "zh")).toBe("10/05");
    expect(formatDateFragmentAt(day, "long", "zh-CN", "zh")).toBe("10月5日");
    expect(formatDateFragmentAt(day, "long", "en-US", "en")).toBe("Oct 5");
    expect(formatDateFullAt(at(2026, 10, 5), "dash", "zh-CN", "zh")).toBe("2026-10-05");
    expect(formatDateFullAt(at(2026, 10, 5), "slash", "zh-CN", "zh")).toBe("2026/10/05");
    expect(formatDateFullAt(at(2026, 10, 5), "long", "zh-CN", "zh")).toBe("2026年10月5日");
    expect(formatDateFullAt(at(2026, 10, 5), "long", "en-US", "en")).toBe("Oct 5, 2026");
  });
  it("system：跟系统 locale 的 CLDR 短日期（时-01 实测 zh-CN = 2026/10/5）", () => {
    expect(formatDateFullAt(at(2026, 10, 5), "system", "zh-CN", "zh")).toBe("2026/10/5");
    expect(formatDateFullAt(at(2026, 10, 5), "system", "en-US", "en")).toBe("10/5/2026");
    expect(formatDateFragmentAt(day, "system", "zh-CN", "zh")).toBe("10/5");
    expect(formatDateFragmentAt(day, "system", "en-GB", "en")).toBe("05/10");
  });
});

describe("归一与样例（设置面板用）", () => {
  it("坏值 / 缺省 → system", () => {
    expect(normalizeTimeFormat("h24")).toBe("h24");
    expect(normalizeTimeFormat("垃圾")).toBe("system");
    expect(normalizeTimeFormat(undefined)).toBe("system");
    expect(normalizeDateFormat("long")).toBe("long");
    expect(normalizeDateFormat("斜线")).toBe("system");
    expect(TIME_FORMATS).toEqual(["system", "h24", "h12"]);
    expect(DATE_FORMATS).toEqual(["system", "dash", "slash", "long"]);
  });
  it("样例：每个档位都不是空串、且 h24 与 h12 不同（不让用户对着文字猜）", () => {
    for (const f of TIME_FORMATS) expect(sampleClock(f).length).toBeGreaterThan(0);
    for (const f of DATE_FORMATS) expect(sampleDate(f).length).toBeGreaterThan(0);
    expect(sampleClock("h24")).not.toBe(sampleClock("h12"));
    expect(sampleDate("dash")).not.toBe(sampleDate("long"));
  });
});
