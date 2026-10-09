import { describe, expect, it } from "vitest";
import { AUTOSCROLL_MAX_STEP_PX, scrollStep } from "./autoscroll";

/** 视口 1000×800 */
const VIEW = { left: 0, top: 0, right: 1000, bottom: 800 };

describe("scrollStep（round25③：手势贴边自动滚动）", () => {
  it("指针在中间 → 不滚", () => {
    expect(scrollStep({ x: 500, y: 400 }, VIEW)).toEqual({ dx: 0, dy: 0 });
  });

  it("贴下缘 → 往下滚（dy > 0），越贴越快", () => {
    const near = scrollStep({ x: 500, y: 780 }, VIEW).dy;
    const closer = scrollStep({ x: 500, y: 795 }, VIEW).dy;
    expect(near).toBeGreaterThan(0);
    expect(closer).toBeGreaterThan(near);
    expect(closer).toBeLessThanOrEqual(AUTOSCROLL_MAX_STEP_PX);
  });

  it("贴上缘 → 往上滚（dy < 0）", () => {
    expect(scrollStep({ x: 500, y: 20 }, VIEW).dy).toBeLessThan(0);
  });

  it("贴右缘 / 左缘 → 横向滚动，方向相反", () => {
    expect(scrollStep({ x: 990, y: 400 }, VIEW).dx).toBeGreaterThan(0);
    expect(scrollStep({ x: 10, y: 400 }, VIEW).dx).toBeLessThan(0);
  });

  it("指针已经跑到视口外（拖到窗口外）→ 保持全速，不归零", () => {
    expect(scrollStep({ x: 500, y: 1200 }, VIEW).dy).toBe(AUTOSCROLL_MAX_STEP_PX);
    expect(scrollStep({ x: 500, y: -50 }, VIEW).dy).toBe(-AUTOSCROLL_MAX_STEP_PX);
  });

  it("贴边那段至少滚 1px/帧（否则几乎看不出在动）", () => {
    expect(Math.abs(scrollStep({ x: 500, y: 761 }, VIEW).dy)).toBeGreaterThanOrEqual(1);
  });
});
