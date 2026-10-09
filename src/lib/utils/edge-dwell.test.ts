/**
 * round29 #4（你回的那句「连续翻页稍稍稍稍微快了一点点」）：翻页节奏改**两段式** ——
 * 首屏停 `EDGE_DWELL_MS`，之后每 `PAGE_INTERVAL_MS` 一页（X11 `RepeatKeys` 的 timeout/interval 模型）。
 *
 * 用假时钟跑：这三条全是「什么时候该翻」的边界，真等着跑会慢且抖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dwellStop,
  dwellTick,
  EDGE_DWELL_MS,
  PAGE_INTERVAL_MS,
  type DwellHost,
} from "./edge-dwell";

/** 假板子：x > 10 = 甩到右边，x < -10 = 甩到左边，其余在板子里 */
function makeHost(flips: number[]): DwellHost {
  return {
    edgeDwell: (clientX: number) => (clientX > 10 ? 1 : clientX < -10 ? -1 : 0),
    flipWeek: (dir: -1 | 1) => flips.push(dir),
  };
}

describe("停住翻页的节奏（round29 #4：两段式）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    dwellStop(); // 模块级状态：每条用完必须收尾，不然会串到下一跳
    vi.useRealTimers();
  });

  it("首屏 600ms 翻第一页，之后是 900ms 一页（不再是一路 600）", () => {
    const flips: number[] = [];
    const host = makeHost(flips);

    dwellTick(50, host);
    vi.advanceTimersByTime(EDGE_DWELL_MS - 1);
    expect(flips).toEqual([]); // 还没到

    vi.advanceTimersByTime(1);
    expect(flips).toEqual([1]); // 第一页

    // 旧的等间隔（600ms）在这时候**已经翻第二页了**（600 → 1200）；两段式要等到 600+900
    vi.advanceTimersByTime(PAGE_INTERVAL_MS - 1);
    expect(flips).toEqual([1]);

    vi.advanceTimersByTime(1);
    expect(flips).toEqual([1, 1]); // 第二页
  });

  it("停住不动就一直翻下去（每页 900ms）", () => {
    const flips: number[] = [];
    dwellTick(50, makeHost(flips));
    vi.advanceTimersByTime(EDGE_DWELL_MS + PAGE_INTERVAL_MS * 3);
    expect(flips).toEqual([1, 1, 1, 1]);
  });

  it("回到板子里 / 再甩出去 → 重新从 600ms 起算；换边也算新的一轮", () => {
    const flips: number[] = [];
    const host = makeHost(flips);

    dwellTick(50, host);
    vi.advanceTimersByTime(EDGE_DWELL_MS - 100);
    dwellTick(0, host); // 回板子里 → 取消
    vi.advanceTimersByTime(5000);
    expect(flips).toEqual([]);

    dwellTick(50, host); // 再出去 → 重新起算（不是接着上次的 100ms）
    vi.advanceTimersByTime(EDGE_DWELL_MS);
    expect(flips).toEqual([1]);

    dwellTick(-50, host); // 换到左边 → 也是新的一轮
    vi.advanceTimersByTime(EDGE_DWELL_MS);
    expect(flips).toEqual([1, -1]);
  });

  it("dwellStop（松手 / Esc / 取消）之后不再翻", () => {
    const flips: number[] = [];
    dwellTick(50, makeHost(flips));
    vi.advanceTimersByTime(EDGE_DWELL_MS - 100);
    dwellStop();
    vi.advanceTimersByTime(5000);
    expect(flips).toEqual([]);
  });
});
