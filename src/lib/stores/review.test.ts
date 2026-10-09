/**
 * C7（round52）：复盘 store 的回归防线。
 *
 * 验四样：
 * ① **不变式**（§5.4）：每块恰好出现一次；按状态与按类别的块数守恒；分类按名字序、未分类最后；
 * ② 窗口防竞态（翻周时旧响应不许覆盖；更早发起、更晚返回的也不许顶掉新的）；
 * ③ 「对比：上周」真的去拉上一周（日期加法，不是减 604800 秒）——**方块与曲线都要**（round54：同一把尺）；
 * ④ `⊘` 的分流（普通块 → 任务级；临时块 → 它自己的块级）与失败不假装成功。
 *
 * 假后端**按真语义**做：`get_week_mosaic` / `get_sanity_curve` 都跟着请求的那一周生成数据
 *（少做规则 = 假绿温床）；round54 起 store 还会多拉一条上一周的曲线。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MosaicBlock, MosaicState } from "../ipc/types";
import { getWeekDays, shiftWeek } from "../utils/week";

/** 假后端：按周现造；`lastWeekMissed` 用来验「比上周」真的换了数据 */
const backend = {
  taskExemptCalls: [] as [string, boolean][],
  blockExemptCalls: [] as [string, boolean][],
};

/** 一周的造块配方：[天下标, 分类, 结局, 临时块?, 同任务同组?] —— 名字里带 id 好定位 */
const SPEC: [number, string | null, MosaicState, boolean?][] = [
  [0, "工作", "done"],
  [0, "工作", "missed"],
  [1, "学习", "done_overtime"],
  [1, "学习", "unused"],
  [1, null, "planned"],
  [2, "工作", "done_short"],
  [2, null, "missed"],
  [4, "工作", "done"],
  [5, null, "planned"],
  [6, null, "missed", true], // 临时块（分类为 null）
  [6, "工作", "planned"],
];

function mkBlock(from: number, index: number, dayOffset: number, category: string | null, state: MosaicState, isTemp = false): MosaicBlock {
  const days = getWeekDays(from).map((d) => Math.floor(d.getTime() / 1000));
  const dayStart = days[dayOffset] ?? from + dayOffset * 86400;
  return {
    id: `b${index}`,
    task_id: isTemp ? "ww-temp-hidden-task" : `t${index % 3}`,
    title: isTemp ? "临时安排" : `任务${index % 3}`,
    label: null,
    category,
    is_temp: isTemp,
    start_at: dayStart + 9 * 3600,
    end_at: dayStart + 10 * 3600,
    layer: "elastic",
    mosaic_state: state,
    day_start: dayStart,
    exempt: false,
    rearranged: 0,
    skipped: state === "missed",
  };
}

const weekBlocks = (from: number): MosaicBlock[] =>
  SPEC.map(([day, category, state, isTemp], i) => mkBlock(from, i, day, category, state, isTemp));

vi.mock("../ipc/review", () => ({
  getWeekMosaic: vi.fn(async (weekStart: number) => weekBlocks(weekStart)),
  // 到点提醒（默认不到点；需要时用 mockResolvedValueOnce 给）
  takeReviewNudge: vi.fn(async () => null),
  markReviewSeen: vi.fn(async () => {}),
}));
/** 假曲线（round54）：**跟着请求的那一周**走 —— 写死本周就是假绿（fixture 那边踩过同一个坑） */
function sanityWeek(weekStart: number) {
  const days = getWeekDays(weekStart).map((d, i) => {
    const minutes = 30 * (i + 1);
    return {
      day_start: Math.floor(d.getTime() / 1000),
      minutes,
      budget: 360,
      energy_pct: Math.round((minutes / 360) * 100),
      state: "calm" as const,
      blocks: 1,
      rearranged: i % 3,
      skipped: i % 5,
    };
  });
  return {
    week_start: weekStart,
    week_end: weekStart + 7 * 86400,
    today_index: -1,
    worst_state: "calm" as const,
    budget: 360,
    enabled: true,
    days,
  };
}
vi.mock("../ipc/sanity", () => ({
  getSanityCurve: vi.fn(async (weekStart: number) => sanityWeek(weekStart)),
}));
vi.mock("./blocks.svelte", () => ({
  setExempt: vi.fn(async (id: string, exempt: boolean) => {
    backend.blockExemptCalls.push([id, exempt]);
  }),
}));
vi.mock("./tasks.svelte", () => ({
  setTaskExempt: vi.fn(async (id: string, exempt: boolean) => {
    backend.taskExemptCalls.push([id, exempt]);
  }),
}));

const reviewIpc = await import("../ipc/review");
const sanityIpc = await import("../ipc/sanity");
const blocksStore = await import("./blocks.svelte");
const tasksStore = await import("./tasks.svelte");
const {
  MOSAIC_STATES,
  blocksOfDay,
  checkNudge,
  closeReview,
  defaultDay,
  dismissNudge,
  dayStarts,
  ensureMosaic,
  loadMosaic,
  missedBlocks,
  mosaicCategories,
  mosaicDays,
  nudge,
  openReview,
  openReviewAt,
  pastWeekList,
  remindSettings,
  review,
  setBaseline,
  stepBaseline,
  MAX_BASELINE_WEEKS,
  statesPresent,
  toggleExempt,
} = await import("./review.svelte");
const { week } = await import("./week.svelte");

const DAY = 86400;
/** 测试里改过 week → 每例前后都还原（store 是全局的） */
let saved: { from: number; to: number };

// round57：**两段 describe 共用**同一套重置（旧写法把 beforeEach 放在第一段里，
// C8 那一段就成了漏网之地 —— 上一例的结语/假库遗到下一例，测试自己先红了）
beforeEach(() => {
  saved = { from: week.from, to: week.to };
  review.week = null;
  review.loadedFrom = 0;
  review.lastWeek = null;
  review.day = null;
  review.mode = "state";
  review.baselineWeeks = 0;
  review.open = false;  backend.taskExemptCalls = [];
  backend.blockExemptCalls = [];
  nudge.show = false;
  remindSettings.action = "hint";
  vi.mocked(reviewIpc.getWeekMosaic).mockClear();
  vi.mocked(reviewIpc.takeReviewNudge).mockClear();
  vi.mocked(blocksStore.setExempt).mockClear();
  vi.mocked(tasksStore.setTaskExempt).mockClear();
});

/** 改过 week 的例子挂掉也要还回去（否则后面的例子全在错的周上跑） */
afterEach(() => {
  week.from = saved.from;
  week.to = saved.to;
});

describe("C7 复盘 store", () => {
  it("拉回来：按天分堆，一周七行都在，**每块恰好出现一次**", async () => {
    await loadMosaic();
    expect(review.week).toHaveLength(SPEC.length);
    expect(review.loadedFrom).toBe(week.from);

    const rows = mosaicDays();
    expect(rows.map((r) => r.blocks.length), "周一两块、周二三块、周三两块、周四空、…").toEqual([
      2, 3, 2, 0, 1, 1, 2,
    ]);
    const flat = rows.flatMap((r) => r.blocks.map((b) => b.id));
    expect(new Set(flat).size, "跨行不重复").toBe(SPEC.length);
    expect(flat.sort()).toEqual(review.week!.map((b) => b.id).sort());

    // 明细按天取，与马赛克同一份
    const monday = dayStarts()[0];
    expect(blocksOfDay(monday).map((b) => b.id)).toEqual(["b0", "b1"]);
  });

  it("按类别：并集 == 输入、块数守恒、名字序、**未分类最后**（§5.4 不变式）", async () => {
    await loadMosaic();
    const groups = mosaicCategories();
    const flat = groups.flatMap((g) => g.blocks.map((b) => b.id));
    expect(flat.length, "块数守恒（两种读法同一份数据）").toBe(review.week!.length);
    expect(new Set(flat).size).toBe(review.week!.length);
    expect(groups.map((g) => g.name), "按名字序，未分类最后").toEqual(["工作", "学习", null]);
    expect(groups.at(-1)!.blocks.map((b) => b.id), "临时块进未分类").toContain("b9");
  });

  it("翻周途中回来的**旧**响应不覆盖（语义窗口）", async () => {
    let resolveIt: (v: MosaicBlock[]) => void = () => {};
    vi.mocked(reviewIpc.getWeekMosaic).mockImplementationOnce(
      () => new Promise((r) => (resolveIt = r)) as never,
    );
    const pending = loadMosaic(); // 请求出发（窗口 A）
    const oldFrom = week.from;
    week.from = oldFrom + 7 * DAY; // 用户翻到了下一周
    week.to = week.to + 7 * DAY;
    resolveIt(weekBlocks(oldFrom)); // 旧那一周的结果现在才回来
    await pending;
    expect(review.week).toBeNull(); // 不许写进 store
    week.from = saved.from;
    week.to = saved.to;
  });

  it("晚发起的那份写进去之后，更早发起、更晚返回的那份不许顶掉它", async () => {
    vi.mocked(reviewIpc.getWeekMosaic)
      .mockImplementationOnce(async (from: number) => {
        await new Promise((r) => setTimeout(r, 30)); // 先发的那次慢（旧快照晚到）
        return weekBlocks(from).slice(0, 2);
      })
      .mockImplementationOnce(async (from: number) => weekBlocks(from));
    const first = loadMosaic();
    const second = loadMosaic();
    await second;
    await first;
    expect(review.week, "旧的（晚到的）不许顶掉新的").toHaveLength(SPEC.length);
  });

  it("对比基线：去拉**选定那一周**（日期加法）的方块 + 曲线，并把它的结局并进图例", async () => {
    setBaseline(1);
    await loadMosaic();
    const calls = vi.mocked(reviewIpc.getWeekMosaic).mock.calls.map((c) => c[0]);
    expect(calls).toContain(shiftWeek(week.from, -1));
    expect(review.lastWeek).toHaveLength(SPEC.length);
    // round54（9.2）：对比要「同一把尺」→ 基线周**也要它的曲线**（占用/事实两边各一份）
    const curveCalls = vi.mocked(sanityIpc.getSanityCurve).mock.calls.map((c) => c[0]);
    expect(curveCalls).toContain(shiftWeek(week.from, -1));
    expect(review.lastEnergy?.week_start).toBe(shiftWeek(week.from, -1));
    expect(review.lastEnergy?.days).toHaveLength(7);
    expect(statesPresent()).toEqual(["done", "done_overtime", "done_short", "missed", "unused", "planned"]);

    setBaseline(0);
    expect(review.lastWeek).toBeNull();
    expect(review.lastEnergy, "关掉对比时基线周的曲线也要清掉").toBeNull();
  });

  it("round63（C18）+ 63.1：基线可以是任意一周（‹ › 逐周步进），非法/越界才当关闭", async () => {
    setBaseline(2);
    await loadMosaic();
    expect(review.baselineWeeks).toBe(2);
    const mosaic = vi.mocked(reviewIpc.getWeekMosaic).mock.calls.map((c) => c[0]);
    const curves = vi.mocked(sanityIpc.getSanityCurve).mock.calls.map((c) => c[0]);
    expect(mosaic).toContain(shiftWeek(week.from, -2));
    expect(mosaic, "不许拉上一周充数").not.toContain(shiftWeek(week.from, -1));
    expect(curves).toContain(shiftWeek(week.from, -2));
    expect(review.lastEnergy?.week_start).toBe(shiftWeek(week.from, -2));

    // round63.1（你拍板）：预设下拉 → ‹ › 逐周步进 —— 能一直点到任意早的一周
    setBaseline(9);
    await loadMosaic();
    expect(review.baselineWeeks).toBe(9);
    expect(review.lastEnergy?.week_start).toBe(shiftWeek(week.from, -9));
    stepBaseline(1);
    expect(review.baselineWeeks).toBe(10);
    stepBaseline(-3);
    expect(review.baselineWeeks).toBe(7);
    await loadMosaic();
    expect(review.lastEnergy?.week_start).toBe(shiftWeek(week.from, -7));
    // 最小停在「上周」：再往近步进不会变成 0/负
    setBaseline(1);
    stepBaseline(-1);
    expect(review.baselineWeeks).toBe(1);
    // 上限与非法值（0 是「关闭」，不能靠 setBaseline 误开）
    setBaseline(MAX_BASELINE_WEEKS + 1);
    expect(review.baselineWeeks).toBe(0);
    expect(review.lastWeek).toBeNull();
    setBaseline(0);
    setBaseline(-5);
    expect(review.baselineWeeks).toBe(0);
  });

  it("图例只列**真出现过**的结局；未完成列表只收 missed；图例**不得改动** store（回归）", async () => {
    await loadMosaic();
    expect(statesPresent()).toEqual(["done", "done_overtime", "done_short", "missed", "unused", "planned"]);
    expect(missedBlocks().map((b) => b.id)).toEqual(["b1", "b6", "b9"]);

    // 回归：曾经在 statesPresent 里往 `review.week` push 基线周的块 → 既改库又报 state_unsafe_mutation
    setBaseline(1);
    await loadMosaic();
    const before = review.week!.length;
    statesPresent();
    expect(review.week, "本周那一份不许被基线周的块污染").toHaveLength(before);
    setBaseline(0);

    // 只有 done 的一周
    vi.mocked(reviewIpc.getWeekMosaic).mockResolvedValueOnce([mkBlock(week.from, 99, 0, "工作", "done")]);
    await loadMosaic();
    expect(statesPresent()).toEqual(["done"]);
    expect(missedBlocks()).toEqual([]);
  });

  it("失败路径：曲线拉不到 → 不抛、store 保持空（时间轴照常）", async () => {
    vi.mocked(reviewIpc.getWeekMosaic).mockRejectedValueOnce(new Error("ipc 炸了"));
    await expect(loadMosaic()).resolves.toBeUndefined();
    expect(review.week).toBeNull();
  });

  it("⊘ 分流：普通块 → 任务级；临时块 → 块级；失败不假装成功", async () => {
    await loadMosaic();
    const normal = review.week!.find((b) => !b.is_temp)!;
    expect(await toggleExempt(normal)).toBe(true);
    expect(backend.taskExemptCalls).toEqual([[normal.task_id, true]]);
    expect(backend.blockExemptCalls).toEqual([]);

    const temp = review.week!.find((b) => b.is_temp)!;
    expect(await toggleExempt(temp)).toBe(true);
    expect(backend.blockExemptCalls).toEqual([[temp.id, true]]);

    vi.mocked(tasksStore.setTaskExempt).mockRejectedValueOnce(new Error("ipc 炸了"));
    expect(await toggleExempt(normal)).toBe(false);
  });

  it("打开面板：默认聚焦今天（在本周时）；翻周后把选中那天拉回本周", async () => {
    openReview();
    expect(review.open).toBe(true);
    expect(review.day).toBe(defaultDay());
    closeReview();
    expect(review.open).toBe(false);

    // 手动把 day 设成别的周 → ensureMosaic 拉回本周
    review.day = week.from + 70 * DAY;
    review.loadedFrom = week.from;
    review.week = weekBlocks(week.from);
    ensureMosaic();
    expect(dayStarts()).toContain(review.day);
    expect(MOSAIC_STATES).toHaveLength(6);
  });
});

/**
 * round58（0.13.1）：把周报并进总览 —— 到点三档 + 往期。
 *
 * 钉死的是用户 2026-10-04 拍板的两件事（round57 的卡片与结语已销）：
 * ① 「直接打开」只在**回到应用**时弹（分钟轮询不抢屏），落点是**总览**；
 * ② 「往期」= 最近 12 周（含本周），点一下切到那一周（`openReviewAt`）；
 * ③ 面板上的数字是实时的（无快照）—— 这一条在 `weekcard.test.ts` 与预览断言里各验一面。
 */
describe("C8 总览（到点三档 + 往期）", () => {
  const nudgeOnce = () =>
    vi.mocked(reviewIpc.takeReviewNudge).mockResolvedValue({ week_start: week.from, at: "sun 20:00" });
  /** 把挂起的微任务冲干净（假 IPC 都走微任务；这里不用真时钟） */
  const flushMicrotasks = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  it("「直接打开」：分钟轮询**不**抢屏，回到应用（focus/启动）才开**总览**，且不再另给轻提示", async () => {
    remindSettings.action = "open";
    nudgeOnce();
    await checkNudge("tick");
    expect(review.open, "干活中途不许抢屏").toBe(false);
    expect(nudge.show).toBe(false);

    await checkNudge("return");
    expect(review.open).toBe(true);
    expect(nudge.show, "总览自己开了，就别再给一条提示").toBe(false);
    closeReview();
  });

  it("「只提醒我」：到点给轻提示（不开总览）；「什么都不做」：连后端都不问", async () => {
    remindSettings.action = "hint";
    nudgeOnce();
    await checkNudge("tick");
    expect(nudge.show).toBe(true);
    expect(review.open).toBe(false);
    dismissNudge();

    remindSettings.action = "off";
    vi.mocked(reviewIpc.takeReviewNudge).mockClear();
    await checkNudge("return");
    expect(reviewIpc.takeReviewNudge, "关掉了就不该动水位线").not.toHaveBeenCalled();
    expect(review.open).toBe(false);
    expect(nudge.show).toBe(false);
  });

  it("`openReviewAt`（往期 chip / 到点「直接打开」都走它）：切到那一周并打开总览", async () => {
    const target = shiftWeek(week.from, -3);
    openReviewAt(target);
    await flushMicrotasks();
    expect(review.open).toBe(true);
    expect(week.from).toBe(target);
    const calls = vi.mocked(reviewIpc.getWeekMosaic).mock.calls.map((c) => c[0]);
    expect(calls).toContain(target);
    closeReview();
  });

  it("往期列表：最近 12 周（含本周）、新 → 旧、不重复", () => {
    const list = pastWeekList();
    expect(list.length).toBe(12);
    expect(list[0]).toBe(week.from);
    for (let i = 1; i < list.length; i++) expect(list[i]).toBeLessThan(list[i - 1]);
    expect(new Set(list).size).toBe(list.length);
  });
});
