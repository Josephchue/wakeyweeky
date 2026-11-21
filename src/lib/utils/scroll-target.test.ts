/**
 * round94（#2）：`initialScrollTop` 的回归防线。
 *
 * 为什么值得单测：这段是「现在线落在视口上 1/3」的**唯一实现** —— 错了就是「打开/回到本周后
 * 看不见现在」或「滚过头」，而这在预览里只有一条断言覆盖（还有 clamp 那几档在 1500px 窗口里碰不到）。
 */
import { describe, expect, it } from "vitest";
import { initialScrollTop, NOW_ANCHOR_RATIO } from "./scroll-target";

const base = { dayHead: 28, viewport: 600, max: 2000, fallback: 28 + 12 * 30 };

describe("initialScrollTop（round94 #2）", () => {
  it("看得到今天：现在线落在视口上 1/3（dayHead + nowY − viewport/3）", () => {
    expect(NOW_ANCHOR_RATIO).toBeCloseTo(1 / 3, 10);
    // 15:00 = 第 30 格 × 30px = 900
    expect(initialScrollTop({ ...base, nowY: 900 })).toBe(28 + 900 - 200);
  });

  it("凌晨（算出负数）→ 夹到 0（不许滚到负值）", () => {
    expect(initialScrollTop({ ...base, nowY: 60 })).toBe(0);
  });

  it("深夜（算出超过可滚上限）→ 夹到 max", () => {
    expect(initialScrollTop({ ...base, nowY: 1430, max: 800 })).toBe(800);
  });

  it("看不到今天（nowY = null）→ 回落 6:00，且同样夹取", () => {
    expect(initialScrollTop({ ...base, nowY: null })).toBe(base.fallback);
    expect(initialScrollTop({ ...base, nowY: null, max: 100 })).toBe(100);
  });

  it("视口比内容高（max = 0）→ 恒为 0；坏 max 也当 0", () => {
    expect(initialScrollTop({ ...base, nowY: 900, max: 0 })).toBe(0);
    expect(initialScrollTop({ ...base, nowY: 900, max: Number.NaN })).toBe(0);
  });

  it("坏输入不抛：NaN → 0；+Infinity → 夹到 max", () => {
    expect(initialScrollTop({ ...base, nowY: Number.NaN })).toBe(0);
    expect(initialScrollTop({ ...base, nowY: Number.POSITIVE_INFINITY })).toBe(base.max);
  });
});
