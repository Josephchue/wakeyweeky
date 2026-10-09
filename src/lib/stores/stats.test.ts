/**
 * 10.1 统计页（round60）：store 的回归防线。
 *
 * 验三样：
 * ① 打开即拉一次，数字进 `data`（loading/failed 收干净）；
 * ② **序号守旧**：更早发起、更晚返回的旧响应不许顶掉新的；
 * ③ 失败不假装成功：`data` 清空 + `failed` 置位（界面显示「读不到统计」，不是 0）。
 *
 * 假后端不抄规则：`get_stats` 的全部口径在 Rust `stats.rs` 单测里（这里只验 store 的搬运与防竞态）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Stats } from "../ipc/types";

function mkStats(over: Partial<Stats> = {}): Stats {
  return {
    first_event_at: 1_790_000_000,
    active_days: 3,
    total_events: 10,
    complete: 6,
    skip: 2,
    rate_pct: 75,
    created: 4,
    created_temp: 1,
    moved: 5,
    stretched: 2,
    postponed: 3,
    cascaded: 1,
    deleted: 1,
    merged: 2,
    linked: 1,
    unlinked: 1,
    done_minutes: 60,
    done_timed: 3,
    // round82（统-03…07）：这几个字段 store 只是搬运，形状给最小可编译值即可
    trend: [{ day: 1_790_000_064, done: 2 }],
    on_time: 4,
    rated: 5,
    on_time_pct: 80,
    avg_minutes: 30,
    streak_now: 2,
    streak_best: 4,
    categories: [{ category: "工作", done: 3, minutes: 45 }],
    weeks: [{ week_start: 1_790_006_400, done: 2, missed: 1, postponed: 1 }],
    ...over,
  };
}

vi.mock("../ipc/stats", () => ({
  getStats: vi.fn(),
}));

const statsIpc = await import("../ipc/stats");
const { stats, openStats, closeStats, loadStats } = await import("./stats.svelte");

describe("stats store（round60 / 10.1）", () => {
  beforeEach(() => {
    vi.mocked(statsIpc.getStats).mockReset();
    closeStats();
    // 模块级 state 在用例之间不自动清 —— 手动归零
    stats.data = null;
    stats.loading = false;
    stats.failed = false;
  });

  it("打开即拉一次，数字进 data", async () => {
    vi.mocked(statsIpc.getStats).mockResolvedValueOnce(mkStats());
    await openStats();
    expect(stats.open).toBe(true);
    expect(stats.data?.complete).toBe(6);
    expect(stats.data?.rate_pct).toBe(75);
    expect(stats.loading).toBe(false);
    expect(stats.failed).toBe(false);
    expect(statsIpc.getStats).toHaveBeenCalledTimes(1);
  });

  it("晚发起的那份写进去之后，更早发起、更晚返回的那份不许顶掉它", async () => {
    let resolveSlow: (v: Stats) => void = () => {};
    vi.mocked(statsIpc.getStats)
      .mockImplementationOnce(() => new Promise<Stats>((r) => (resolveSlow = r)))
      .mockResolvedValueOnce(mkStats({ complete: 2 }));

    const first = loadStats();
    const second = loadStats();
    await second;
    expect(stats.data?.complete).toBe(2);

    resolveSlow(mkStats({ complete: 1 }));
    await first;
    expect(stats.data?.complete, "旧的（晚到的）不许顶掉新的").toBe(2);
  });

  it("拉取失败：data 清空、failed 置位、loading 收掉（不假装 0）", async () => {
    vi.mocked(statsIpc.getStats).mockRejectedValueOnce(new Error("假后端：炸一次"));
    await openStats();
    expect(stats.failed).toBe(true);
    expect(stats.data).toBeNull();
    expect(stats.loading).toBe(false);
  });
});
