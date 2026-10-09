import { describe, expect, it } from "vitest";
import { WHEEL_STEP_PX, createWheelAccumulator } from "./wheel-zoom";

describe("Ctrl+滚轮累积器（宽-02/宽-04/宽-08）", () => {
  it("鼠标一格（100 / 120）走 1 档", () => {
    const a = createWheelAccumulator();
    expect(a.push(-100)).toBe(-1);
    expect(a.push(120)).toBe(1);
  });

  it("触控板：连发小 delta，累积到一档（100）才走", () => {
    const a = createWheelAccumulator();
    let steps = 0;
    for (let i = 0; i < 49; i++) steps += Math.abs(a.push(-2)); // 98 → 还不够一档
    expect(steps).toBe(0);
    steps += Math.abs(a.push(-2)); // 100 → 一档
    expect(steps).toBe(1);
    expect(WHEEL_STEP_PX).toBe(100);
  });

  it("单次最多 2 档，余量封顶一档（500 → 2 档；下一次 1 步就再走 1 档，不连续补跳）", () => {
    const a = createWheelAccumulator();
    expect(a.push(500)).toBe(2);
    expect(a.push(0)).toBe(0);
    expect(a.push(1)).toBe(1);
    expect(a.push(1)).toBe(0);
  });

  it("反向累积不串台（+40 → -70 → -20 → -60：净 -110 = 1 档）", () => {
    const a = createWheelAccumulator();
    expect(a.push(40)).toBe(0);
    expect(a.push(-70)).toBe(0);
    expect(a.push(-20)).toBe(0);
    expect(a.push(-60)).toBe(-1);
  });

  it("reset / 坏值 / 0 都不产生步骤", () => {
    const a = createWheelAccumulator();
    expect(a.push(Number.NaN)).toBe(0);
    expect(a.push(Infinity)).toBe(0);
    expect(a.push(0)).toBe(0);
    a.push(95);
    a.reset();
    expect(a.push(95)).toBe(0); // 之前那 95 被清掉
    expect(a.push(5)).toBe(1);
  });
});
