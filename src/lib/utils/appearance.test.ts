import { describe, expect, it } from "vitest";
import {
  FONT_FAMILIES,
  FONT_FAMILY_DEFAULT,
  NIGHT_END_DEFAULT,
  NIGHT_START_DEFAULT,
  inNightWindow,
  isNightNow,
  minutesOfDay,
  nightSegments,
  normalizeFontFamily,
  normalizeNightEnd,
  normalizeNightStart,
  themeForNow,
} from "./appearance";

/**
 * round87（1.0.0 · 3.3 字体方案）：界面字体族归——缺省 / 坏值回默认档（边界表 F1）。
 * 预览断言盯着「切档即时生效 + 重启记得」；这里只盯纯函数这层。
 */
describe("normalizeFontFamily（界面字体族归一）", () => {
  it("五档合法值原样；缺省 / 坏值 / 非字符串回默认档", () => {
    for (const v of FONT_FAMILIES) expect(normalizeFontFamily(v)).toBe(v);
    expect(normalizeFontFamily(undefined)).toBe(FONT_FAMILY_DEFAULT);
    expect(normalizeFontFamily("")).toBe(FONT_FAMILY_DEFAULT);
    expect(normalizeFontFamily("宋体")).toBe(FONT_FAMILY_DEFAULT);
    expect(normalizeFontFamily(42)).toBe(FONT_FAMILY_DEFAULT);
  });
});

/**
 * round82（3.1c₂ · `淡-*`）：夜间窗口 —— **纯函数单测**（与 Rust `appearance.rs` 的四条边界同一套用例，
 * 那侧只用于启动 / 设置改动后的窗口主题解析）。
 */

describe("normalizeNightStart / normalizeNightEnd（夜间时段归一）", () => {
  it("合法 HH:MM 原样；缺省 / 坏值回默认（22:00 / 06:00）", () => {
    expect(normalizeNightStart("09:30")).toBe("09:30");
    expect(normalizeNightStart("09:05")).toBe("09:05");
    expect(normalizeNightStart("")).toBe(NIGHT_START_DEFAULT);
    expect(normalizeNightStart("25:00")).toBe(NIGHT_START_DEFAULT);
    expect(normalizeNightStart(undefined)).toBe(NIGHT_START_DEFAULT);
    expect(normalizeNightStart(42)).toBe(NIGHT_START_DEFAULT);
    expect(normalizeNightEnd("")).toBe(NIGHT_END_DEFAULT);
    expect(normalizeNightEnd("垃圾")).toBe(NIGHT_END_DEFAULT);
  });
});

describe("inNightWindow（淡-06 四条边界）", () => {
  it("普通区间（09:00–17:00）：左闭右开", () => {
    expect(inNightWindow(8 * 60 + 59, "09:00", "17:00")).toBe(false);
    expect(inNightWindow(9 * 60, "09:00", "17:00")).toBe(true);
    expect(inNightWindow(16 * 60 + 59, "09:00", "17:00")).toBe(true);
    expect(inNightWindow(17 * 60, "09:00", "17:00")).toBe(false);
  });
  it("跨天（22:00–06:00）：22:00 进 / 06:00 出 / 白天不在", () => {
    expect(inNightWindow(22 * 60, NIGHT_START_DEFAULT, NIGHT_END_DEFAULT)).toBe(true);
    expect(inNightWindow(23 * 60 + 59, NIGHT_START_DEFAULT, NIGHT_END_DEFAULT)).toBe(true);
    expect(inNightWindow(0, NIGHT_START_DEFAULT, NIGHT_END_DEFAULT)).toBe(true);
    expect(inNightWindow(5 * 60 + 59, NIGHT_START_DEFAULT, NIGHT_END_DEFAULT)).toBe(true);
    expect(inNightWindow(6 * 60, NIGHT_START_DEFAULT, NIGHT_END_DEFAULT)).toBe(false);
    expect(inNightWindow(12 * 60, NIGHT_START_DEFAULT, NIGHT_END_DEFAULT)).toBe(false);
  });
  it("起 = 止 = 退化：全天不淡（任何时刻都是 false）", () => {
    for (const m of [0, 8 * 60, 12 * 60, 23 * 60 + 59]) {
      expect(inNightWindow(m, "08:00", "08:00")).toBe(false);
    }
  });
  it("坏值回落默认（空串 → 22:00–06:00）", () => {
    expect(inNightWindow(23 * 60, "", "")).toBe(true);
    expect(inNightWindow(12 * 60, "", "")).toBe(false);
  });
});

describe("minutesOfDay / isNightNow / themeForNow", () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 7, h, m, 0, 0);
  it("分钟数取本地时刻；跨天窗口判定两个边界", () => {
    expect(minutesOfDay(at(0, 0))).toBe(0);
    expect(minutesOfDay(at(23, 59))).toBe(1439);
    expect(isNightNow(at(23, 30), "22:00", "06:00")).toBe(true);
    expect(isNightNow(at(5, 59), "22:00", "06:00")).toBe(true);
    expect(isNightNow(at(6, 0), "22:00", "06:00")).toBe(false);
    expect(isNightNow(at(12, 0), "22:00", "06:00")).toBe(false);
  });
  it("第四档目标主题：夜里 dark / 白天 light（淡-04）", () => {
    expect(themeForNow(at(23, 0), "22:00", "06:00")).toBe("dark");
    expect(themeForNow(at(8, 0), "22:00", "06:00")).toBe("light");
    expect(themeForNow(at(8, 0), "08:00", "08:00")).toBe("light"); // 退化 = 全程白天
  });
});

describe("nightSegments（渲染层直接吃）", () => {
  it("普通区间：1 段 [from, to)", () => {
    expect(nightSegments("09:00", "17:00")).toEqual([{ from: 540, to: 1020 }]);
  });
  it("跨天：2 段（[start, 1440) + [0, end)）", () => {
    expect(nightSegments("22:00", "06:00")).toEqual([
      { from: 1320, to: 1440 },
      { from: 0, to: 360 },
    ]);
  });
  it("退化：0 段（不画带）", () => {
    expect(nightSegments("08:00", "08:00")).toEqual([]);
  });
  it("坏值走默认（22:00–06:00 两段）", () => {
    expect(nightSegments("", "")).toEqual([
      { from: 1320, to: 1440 },
      { from: 0, to: 360 },
    ]);
  });
});
