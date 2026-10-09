/**
 * C6（round44）：理智值 store 的回归防线。
 *
 * 假后端做**真语义**的两件事（AM 教训：假后端少做规则 = 假绿温床）：
 * ① `get_sanity_curve` 跟着当前预算回来（改完预算必须返回新值）；
 * ② `set_setting` 会真的改内存里的预算/开关。
 *
 * 验三样：窗口防竞态（翻周时旧响应不许覆盖）、改预算/开关的联动、失败路径。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SanityWeek } from "../ipc/types";

/** 假后端状态：预算（分钟）+ 开关 */
const backend = { budget: 360, enabled: true };

const mkWeek = (from: number, overDays: number[] = []): SanityWeek => ({
  week_start: from,
  week_end: from + 7 * 86400,
  today_index: 0,
  worst_state: overDays.length ? "over" : "calm",
  budget: backend.budget,
  enabled: backend.enabled,
  days: Array.from({ length: 7 }, (_, i) => ({
    day_start: from + i * 86400,
    minutes: overDays.includes(i) ? 600 : 60,
    budget: backend.budget,
    energy_pct: overDays.includes(i) ? 167 : 17,
    state: (overDays.includes(i) ? "over" : "calm") as "calm" | "over",    blocks: 1,
    rearranged: 0,
    skipped: 0,
  })),
});

vi.mock("../ipc/sanity", () => ({
  getSanityCurve: vi.fn(async (weekStart: number) => mkWeek(weekStart)),
}));
vi.mock("../ipc/settings", () => ({
  getSettings: vi.fn(async () => ({
    values: {
      sanity_budget_minutes: String(backend.budget),
      sanity_enabled: backend.enabled ? "1" : "0",
    },
  })),
  setSetting: vi.fn(async (key: string, value: string) => {
    if (key === "sanity_budget_minutes") backend.budget = Number(value);
    if (key === "sanity_enabled") backend.enabled = value !== "0";
  }),
}));

const sanityIpc = await import("../ipc/sanity");
const settingsIpc = await import("../ipc/settings");
const { sanity, loadSanity, loadSanitySettings, overloadedDays, saveBudgetHours, setSanityEnabled } =
  await import("./sanity.svelte");
const { week } = await import("./week.svelte");

const DAY = 86400;
/** 测试里改过 week → 每例前后都还原（store 是全局的） */
let saved: { from: number; to: number };

describe("C6 理智值 store", () => {
  beforeEach(() => {
    backend.budget = 360;
    backend.enabled = true;
    saved = { from: week.from, to: week.to };
    sanity.week = null;
    sanity.budgetMinutes = 360;
    sanity.enabled = true;
    vi.mocked(sanityIpc.getSanityCurve).mockClear();
    vi.mocked(settingsIpc.setSetting).mockClear();
  });

  it("拉到当前这一周的曲线；超载的那几天挑得出来", async () => {
    vi.mocked(sanityIpc.getSanityCurve).mockResolvedValueOnce(mkWeek(week.from, [2]));
    await loadSanity();
    expect(sanity.week?.week_start).toBe(week.from);
    expect(overloadedDays().map((d) => d.day_start)).toEqual([week.from + 2 * DAY]);
  });

  it("翻周途中回来的**旧**响应不覆盖（语义窗口 —— 与 blocks 的 0.6.37 口径一致）", async () => {
    let resolveIt: (v: unknown) => void = () => {};
    vi.mocked(sanityIpc.getSanityCurve).mockImplementationOnce(
      () => new Promise((r) => (resolveIt = r)) as never,
    );
    const pending = loadSanity(); // 请求出发（窗口 A）
    const oldFrom = week.from;
    week.from = oldFrom + 7 * DAY; // 用户翻到了下一周
    week.to = week.to + 7 * DAY;
    resolveIt(mkWeek(oldFrom)); // 旧那一周的结果现在才回来
    await pending;
    expect(sanity.week).toBeNull(); // 不许写进 store
    week.from = saved.from;
    week.to = saved.to;
  });

  it("晚发起的那份写进去之后，更早发起、更晚返回的那份不许顶掉它", async () => {
    vi.mocked(sanityIpc.getSanityCurve)
      .mockImplementationOnce(async (from: number) => {
        await new Promise((r) => setTimeout(r, 30)); // 先发的那次慢（旧快照晚到）
        return { ...mkWeek(from), budget: 360 };
      })
      .mockImplementationOnce(async (from: number) => ({ ...mkWeek(from), budget: 480 }));
    const first = loadSanity();
    const second = loadSanity();
    await second;
    await first;
    expect(sanity.week?.budget, "旧的（晚到的）不许顶掉新的").toBe(480);
  });

  it("改预算：写 set_setting（分钟）+ 立刻重算（小条跟着变）", async () => {
    const ok = await saveBudgetHours(3);
    expect(ok).toBe(true);
    expect(settingsIpc.setSetting).toHaveBeenCalledWith("sanity_budget_minutes", "180");
    expect(backend.budget).toBe(180);
    expect(sanity.budgetMinutes, "以后端返回的为准").toBe(180);
  });

  it("改预算失败：返回 false、不假装改成功", async () => {
    vi.mocked(settingsIpc.setSetting).mockRejectedValueOnce(new Error("ipc 炸了"));
    const ok = await saveBudgetHours(3);
    expect(ok).toBe(false);
    expect(backend.budget, "后端没变").toBe(360);
    expect(sanity.budgetMinutes, "界面也不许变").toBe(360);
  });

  it("关掉理智值：写 0 + store 跟着关（界面三处都不画由组件读它）", async () => {
    const ok = await setSanityEnabled(false);
    expect(ok).toBe(true);
    expect(settingsIpc.setSetting).toHaveBeenCalledWith("sanity_enabled", "0");
    expect(sanity.enabled).toBe(false);
    expect(backend.enabled).toBe(false);
  });

  it("启动时读设置：把后端生效值填进 store（不用等曲线）", async () => {
    backend.budget = 480;
    backend.enabled = false;
    await loadSanitySettings();
    expect(sanity.budgetMinutes).toBe(480);
    expect(sanity.enabled).toBe(false);
  });

  it("失败路径：曲线拉不到 → 不抛、store 保持空（时间轴照常）", async () => {
    vi.mocked(sanityIpc.getSanityCurve).mockRejectedValueOnce(new Error("ipc 炸了"));
    await expect(loadSanity()).resolves.toBeUndefined();
    expect(sanity.week).toBeNull();
  });

  it("失败路径：开关写不进去 → 返回 false（调用方把开关拨回去）", async () => {
    vi.mocked(settingsIpc.setSetting).mockRejectedValueOnce(new Error("ipc 炸了"));
    await expect(setSanityEnabled(false)).resolves.toBe(false);
    expect(backend.enabled, "后端没变").toBe(true);
  });
});
