/**
 * round31（C1.9 / R42）：键盘操作的纯逻辑 —— 先红后绿的第一半。
 *
 * 为什么值得单测：这些是「一步挪多少 / 一天怎么算 / 哪个键在什么模式下做什么」的**唯一判定**，
 * 组件里的键盘分支 vitest 看不到（round26 教训）—— 边界（跨月/跨年、最短 15 分、最长 72 小时、
 * 抓起前后的语义不同）全靠这里钉住。
 */
import { describe, expect, it } from "vitest";
import {
  COARSE_MINUTES,
  STEP_MINUTES,
  addLocalDays,
  moveStartBy,
  resolveKey,
  stretchRange,
} from "./keyboard";

/** 本地时刻 → epoch 秒（测试都按本地日历算，跟时间轴的列口径一致） */
const at = (y: number, m: number, d: number, h: number, min = 0) =>
  Math.floor(new Date(y, m - 1, d, h, min, 0, 0).getTime() / 1000);

const clock = (ts: number) => {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};

describe("addLocalDays：按本地日历日平移（跨月/跨年不错位）", () => {
  it("跨月：1 月 31 日 +1 天 = 2 月 1 日，时刻不变", () => {
    expect(clock(addLocalDays(at(2026, 1, 31, 9, 15), 1))).toBe("2026-2-1 9:15");
  });

  it("跨年：12 月 31 日 +1 天 = 次年 1 月 1 日", () => {
    expect(clock(addLocalDays(at(2026, 12, 31, 23, 0), 1))).toBe("2027-1-1 23:00");
  });

  it("往回跨月：3 月 1 日 -1 天 = 2 月 28 日（2026 不是闰年）", () => {
    expect(clock(addLocalDays(at(2026, 3, 1, 0, 30), -1))).toBe("2026-2-28 0:30");
  });

  it("一周 = 7 个本地日历日（同星期几、时刻不变）", () => {
    expect(clock(addLocalDays(at(2026, 10, 5, 9, 0), 7))).toBe("2026-10-12 9:00");
    expect(clock(addLocalDays(at(2026, 10, 5, 9, 0), -7))).toBe("2026-9-28 9:00");
  });
});

describe("moveStartBy：一次按键把整块平移多少", () => {
  const start = at(2026, 10, 7, 9, 0);

  it("精调 15 分钟 / 粗调 1 小时", () => {
    expect(moveStartBy(start, "step", 1) - start).toBe(STEP_MINUTES * 60);
    expect(start - moveStartBy(start, "step", -1)).toBe(STEP_MINUTES * 60);
    expect(moveStartBy(start, "coarse", 1) - start).toBe(COARSE_MINUTES * 60);
    expect(moveStartBy(start, "coarse", -1) - start).toBe(-COARSE_MINUTES * 60);
  });

  it("一天 / 一周按本地日历走（时刻不变）", () => {
    expect(clock(moveStartBy(start, "day", 1))).toBe("2026-10-8 9:00");
    expect(clock(moveStartBy(start, "day", -1))).toBe("2026-10-6 9:00");
    expect(clock(moveStartBy(start, "week", 1))).toBe("2026-10-14 9:00");
    expect(clock(moveStartBy(start, "week", -1))).toBe("2026-9-30 9:00");
  });
});

describe("stretchRange：一次按键把一条边挪 15 分钟（含最短/最长护栏）", () => {
  it("上边缘：提前 = 变长；推后 = 变短", () => {
    const r = stretchRange(at(2026, 10, 7, 9, 0), at(2026, 10, 7, 10, 0), "start", -1);
    expect(r && clock(r.startAt)).toBe("2026-10-7 8:45");
    expect(r?.endAt).toBe(at(2026, 10, 7, 10, 0));
  });

  it("下边缘：推后 = 变长；提前 = 变短", () => {
    const r = stretchRange(at(2026, 10, 7, 9, 0), at(2026, 10, 7, 10, 0), "end", 1);
    expect(r && clock(r.endAt)).toBe("2026-10-7 10:15");
    expect(r?.startAt).toBe(at(2026, 10, 7, 9, 0));
  });

  it("最短 15 分钟：再缩就停住（返回 null，不写坏数据）", () => {
    expect(stretchRange(at(2026, 10, 7, 9, 0), at(2026, 10, 7, 9, 15), "start", 1)).toBeNull();
    expect(stretchRange(at(2026, 10, 7, 9, 0), at(2026, 10, 7, 9, 15), "end", -1)).toBeNull();
  });

  it("正好缩到 15 分钟：允许", () => {
    const r = stretchRange(at(2026, 10, 7, 9, 0), at(2026, 10, 7, 9, 30), "start", 1);
    expect(r && clock(r.startAt)).toBe("2026-10-7 9:15");
  });

  it("最长 72 小时：再拉就停住（返回 null）", () => {
    const start = at(2026, 10, 5, 9, 0);
    const end = start + 72 * 3600;
    expect(stretchRange(start, end, "end", 1)).toBeNull();
    expect(stretchRange(start, end, "start", -1)).toBeNull();
  });
});

describe("resolveKey：哪个键在什么模式下做什么", () => {
  const opts = (shift: boolean, grabbed: boolean) => ({ shift, grabbed });

  it("未抓起：↑↓ 修边缘（默认上边缘、Shift 下边缘）", () => {
    expect(resolveKey("ArrowUp", opts(false, false))).toEqual({
      type: "stretch",
      edge: "start",
      dir: -1,
    });
    expect(resolveKey("ArrowDown", opts(true, false))).toEqual({
      type: "stretch",
      edge: "end",
      dir: 1,
    });
  });

  it("抓起：↑↓ 移动（默认 15 分钟、Shift 1 小时）", () => {
    expect(resolveKey("ArrowUp", opts(false, true))).toEqual({
      type: "move",
      kind: "step",
      dir: -1,
    });
    expect(resolveKey("ArrowDown", opts(true, true))).toEqual({
      type: "move",
      kind: "coarse",
      dir: 1,
    });
  });

  it("←→ 拿起中才是「一天 / Shift 一周」；**未拿起 → null**（移动统一收进拿起，round61.1）", () => {
    expect(resolveKey("ArrowLeft", opts(false, false)), "未拿起不搬块").toBeNull();
    expect(resolveKey("ArrowRight", opts(true, false)), "未拿起不搬块").toBeNull();
    expect(resolveKey("ArrowLeft", opts(false, true))).toEqual({
      type: "move",
      kind: "day",
      dir: -1,
    });
    expect(resolveKey("ArrowRight", opts(true, true))).toEqual({
      type: "move",
      kind: "week",
      dir: 1,
    });
  });

  it("WASD 是方向键的平行键位（含 Shift）", () => {
    expect(resolveKey("w", opts(false, true))).toEqual({ type: "move", kind: "step", dir: -1 });
    expect(resolveKey("S", opts(true, false))).toEqual({ type: "stretch", edge: "end", dir: 1 });
    expect(resolveKey("a", opts(false, false)), "未拿起不搬块").toBeNull();
    expect(resolveKey("a", opts(false, true))).toEqual({ type: "move", kind: "day", dir: -1 });
    expect(resolveKey("D", opts(true, true))).toEqual({ type: "move", kind: "week", dir: 1 });
  });

  it("Enter 抓起 / 放下；Esc 取消；Space/X/Delete 各自的动作", () => {
    expect(resolveKey("Enter", opts(false, false))).toEqual({ type: "grab" });
    expect(resolveKey("Enter", opts(false, true))).toEqual({ type: "drop" });
    expect(resolveKey("Escape", opts(false, true))).toEqual({ type: "cancel" });
    expect(resolveKey("Space", opts(false, false))).toEqual({ type: "done" });
    expect(resolveKey(" ", opts(false, false))).toEqual({ type: "done" });
    expect(resolveKey("x", opts(false, false))).toEqual({ type: "missed" });
    expect(resolveKey("Delete", opts(false, false))).toEqual({ type: "delete" });
  });

  it("不认识的键 → null（不劫持）", () => {
    expect(resolveKey("q", opts(false, false))).toBeNull();
    expect(resolveKey("F5", opts(false, false))).toBeNull();
  });
});
