/**
 * round31（C1.9 / R42）：选中/抓起/键盘移动与拉伸的 store 层测试（假后端，绝不碰用户库）。
 *
 * 覆盖计划 `docs/plans/round31-keyboard.md` §六 边界表 B1–B28 的 store 侧；
 * DOM 侧（辅助线、提示条、滚动跟随、按钮焦点）由 `tools/preview/checks.js` 的断言盖。
 *
 * 先红后绿：本文件先写（`stores/selection.svelte.ts` 还不存在 → 红），再实现到全绿。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { weekOf } from "../utils/week";

type Blk = {
  id: string;
  task_id: string;
  start_at: number;
  end_at: number;
  status: string;
  layer: string;
  last_notified_at: number | null;
  created_at: number;
  external_source: string | null;
  final_status: string | null;
  postponed_from: string | null;
  priority: string;
  label: string | null;
  is_temp: boolean;
};

const state: {
  blocks: Blk[];
  n: number;
  /** 这些 id 的 update 一律失败（模拟「排到链上前一环保之前」被拒） */
  reject: Set<string>;
  /** 下一次 move 返回 cascaded = 1（模拟级联顺延） */
  cascadeOnce: boolean;
  /** round61：这些 id 批量挪动的结果里会被「融合吃掉」（模拟融合 → 幽灵 id 收口用） */
  mergeOnMove: Set<string>;
} = { blocks: [], n: 0, reject: new Set(), cascadeOnce: false, mergeOnMove: new Set() };

const clone = (b: Blk) => ({ ...b });

vi.mock("../ipc/blocks", () => ({
  listBlocks: vi.fn(async (from: number, to: number) =>
    state.blocks.filter((b) => b.end_at > from && b.start_at < to).map(clone),
  ),
  createBlock: vi.fn(),
  // round69（B3）：复制手势的落地命令（一次调用 = 一批）
  // round69.1（D1）：返回 `{blocks, created, merged}` —— 同格复制会**就地融合**（已有块当幸存者）
  createBlocks: vi.fn(async (specs: Array<{ task_id: string; start_at: number; end_at: number; layer: string; label?: string | null; sanity_exempt?: boolean }>) => {
    let created = 0;
    let merged = 0;
    const blocks: ReturnType<typeof clone>[] = [];
    for (const s of specs) {
      const b: Blk = {
        id: "cp" + ++state.n,
        task_id: s.task_id,
        start_at: s.start_at,
        end_at: s.end_at,
        status: "planned",
        layer: s.layer,
        last_notified_at: null,
        created_at: 0,
        external_source: null,
        final_status: null,
        postponed_from: null,
        priority: "low",
        label: s.label ?? null,
        is_temp: false,
      };
      // 同格/相接的同任务同层块 → 就地融合（以**已有**那一块为基石）
      const other = state.blocks.find(
        (x) =>
          x.id !== b.id &&
          x.task_id === b.task_id &&
          x.layer === b.layer &&
          x.status === "planned" &&
          x.start_at <= b.end_at &&
          x.end_at >= b.start_at,
      );
      if (other) {
        const keep = other.start_at <= b.start_at ? other : b;
        const eaten = keep === other ? b : other;
        keep.start_at = Math.min(b.start_at, other.start_at);
        keep.end_at = Math.max(b.end_at, other.end_at);
        const i = state.blocks.indexOf(eaten); // 被吃掉的可能是**还没进库的副本** → 那儿没得删
        if (i >= 0) state.blocks.splice(i, 1);
        merged += 1;
        if (!blocks.some((x) => x.id === keep.id)) blocks.push(clone(keep));
      } else {
        state.blocks.push(b);
        created += 1;
        blocks.push(clone(b));
      }
    }
    return { blocks, created, merged };
  }),
  createTempBlock: vi.fn(),
  renameBlock: vi.fn(),
  markBlockDone: vi.fn(async (id: string) => {
    const b = state.blocks.find((x) => x.id === id);
    if (!b) throw new Error("任务块不存在");
    b.status = "done";
    return clone(b);
  }),
  markBlockMissed: vi.fn(async (id: string) => {
    const b = state.blocks.find((x) => x.id === id);
    if (!b) throw new Error("任务块不存在");
    b.status = "missed";
    return clone(b);
  }),
  postponeBlock: vi.fn(),
  mergePendingBlocks: vi.fn(async () => ""),
  deleteBlock: vi.fn(async (id: string) => {
    const i = state.blocks.findIndex((x) => x.id === id);
    if (i >= 0) state.blocks.splice(i, 1);
    return 1;
  }),
  // round61（10.2 多选）：批量假后端 —— 语义照真后端（只动 planned、幂等、失败计数）
  deleteBlocks: vi.fn(async (ids: string[]) => {
    let n = 0;
    for (const id of ids) {
      const i = state.blocks.findIndex((x) => x.id === id);
      if (i >= 0) {
        state.blocks.splice(i, 1);
        n++;
      }
    }
    return n;
  }),
  markBlocks: vi.fn(async (ids: string[], status: "done" | "missed") => {
    let n = 0;
    for (const id of ids) {
      const b = state.blocks.find((x) => x.id === id);
      if (b && b.status === "planned") {
        b.status = status;
        n++;
      }
    }
    return n;
  }),
  moveBlocks: vi.fn(async (moves: Array<[string, number]>) => {
    let changed = 0;
    let failed = 0;
    let merged = 0;
    for (const [id, start] of moves) {
      const b = state.blocks.find((x) => x.id === id);
      if (!b || b.status !== "planned") {
        failed++;
        continue;
      }
      const len = b.end_at - b.start_at;
      b.start_at = start;
      b.end_at = start + len;
      if (state.mergeOnMove.has(id)) {
        // 模拟「挪完被融合吃掉」：这块从库里消失（真后端会整周重拉）
        state.blocks.splice(state.blocks.indexOf(b), 1);
        merged++;
      }
      changed++;
    }
    return { changed, cascaded: 0, history_moved: 0, merged, failed };
  }),
  setBlocksLayer: vi.fn(async (ids: string[], layer: string) => {
    let changed = 0;
    let failed = 0;
    for (const id of ids) {
      const b = state.blocks.find((x) => x.id === id);
      if (!b) {
        failed++;
        continue;
      }
      if (b.layer !== layer) {
        b.layer = layer;
        changed++;
      }
    }
    return { changed, cascaded: 0, history_moved: 0, merged: 0, failed };
  }),
  updateBlock: vi.fn(
    async (id: string, patch: { startAt?: number; endAt?: number; layer?: string; label?: string }) => {
      if (state.reject.has(id)) throw new Error("排到链上前一环保之前（模拟）");
      const b = state.blocks.find((x) => x.id === id);
      if (!b) throw new Error("任务块不存在");
      // 真后端语义：只给 startAt → 时长不变、整块平移；给了 endAt → 改终点
      if (patch.startAt != null) {
        const len = b.end_at - b.start_at;
        b.start_at = patch.startAt;
        if (patch.endAt == null) b.end_at = patch.startAt + len;
      }
      if (patch.endAt != null) b.end_at = patch.endAt;
      if (patch.layer != null) b.layer = patch.layer;
      if (patch.label != null) b.label = patch.label;

      // 融合规则（与真后端/round30 假后端一致）：同任务 + 同层 + 两边 planned + 不是临时块 +
      // 相接或重叠 → 保留起点更早的那个，吃掉另一个；并集超 3 天则跳过
      const other = state.blocks.find(
        (x) =>
          x.id !== id &&
          x.task_id === b.task_id &&
          !b.is_temp &&
          !x.is_temp &&
          x.layer === b.layer &&
          x.status === "planned" &&
          b.status === "planned" &&
          x.start_at <= b.end_at &&
          x.end_at >= b.start_at,
      );
      if (other) {
        const union = {
          start_at: Math.min(b.start_at, other.start_at),
          end_at: Math.max(b.end_at, other.end_at),
        };
        if (union.end_at - union.start_at <= 72 * 3600) {
          const keep = b.start_at <= other.start_at ? b : other;
          const eaten = keep === b ? other : b;
          keep.start_at = union.start_at;
          keep.end_at = union.end_at;
          state.blocks.splice(state.blocks.indexOf(eaten), 1);
          return { block: clone(keep), cascaded: 0, history_moved: 0, merge_hint: null, merged: true };
        }
      }
      const cascaded = state.cascadeOnce ? 1 : 0;
      state.cascadeOnce = false;
      return { block: clone(b), cascaded, history_moved: 0, merge_hint: null, merged: false };
    },
  ),
}));

// round69（B3）：`blocks.svelte.ts::reloadWeek` 现在会调它（打开一周补重复块）—— 测试里当 0 处理
vi.mock("../ipc/repeats", () => ({ generateRepeats: vi.fn(async () => 0) }));

const { blockPreview, groupPreview, reloadWeek, shiftGroupPreview } = await import("./blocks.svelte");
const { createBlocks } = await import("../ipc/blocks");
const { week } = await import("./week.svelte");
const {
  cancelGrab,
  clearSelection,
  collapseToAnchor,
  deleteSelected,
  deleteSelectedMany,
  findSelected,
  follow,
  handleKeyAction,
  markSelectedMany,
  moveSelectedMany,
  reconcileSelection,
  selectAllWeek,
  selectBlock,
  selectMany,
  selectRangeTo,
  selection,
  setSelectedLayerMany,
  startFollowGesture,
  toggleSelected,
} = await import("./selection.svelte");
const { drift } = await import("./drift.svelte");
const { toasts } = await import("./ui.svelte");

const HOUR = 3600;
const MIN = 60;

/** 本周内的时刻（week.from 是本地周一 00:00，测试不跨“现在”翻周，写在本地日历上） */
const at = (dayOffset: number, h: number, m = 0) => week.from + dayOffset * 24 * HOUR + h * HOUR + m * MIN;

function seed(part: Partial<Blk> & { id: string; start_at: number; end_at: number }): Blk {
  const b: Blk = {
    task_id: "t1",
    status: "planned",
    layer: "elastic",
    last_notified_at: null,
    created_at: 0,
    external_source: null,
    final_status: null,
    postponed_from: null,
    priority: "low",
    label: null,
    is_temp: false,
    ...part,
  };
  state.blocks.push(b);
  return b;
}

beforeEach(async () => {
  state.blocks = [];
  state.n = 0;
  state.reject = new Set();
  state.cascadeOnce = false;
  state.mergeOnMove = new Set();
  selection.blockId = null;
  selection.ids = [];
  selection.grabbed = false;
  cancelGrab();
  toasts.length = 0;
  const cur = weekOf(Math.floor(Date.now() / 1000));
  week.from = cur.from;
  week.to = cur.to;
  week.following = true;
  await reloadWeek();
});

describe("抓起跨周（round32 #1/#6）", () => {
  // 周日 22:00 的块 +7 天 = **下周日** 22:00（不是「下周一 22:00」—— 星期几要跟着走）
  const nextWeekSunday22 = (before: number) => before + 13 * 24 * HOUR + 22 * HOUR;

  it("抓起后挪到下周（并模拟翻周重拉）→ 立刻 Enter 还能落地", async () => {
    seed({ id: "b1", start_at: at(6, 22), end_at: at(6, 23) }); // 周日 22:00–23:00
    await reloadWeek();
    selectBlock("b1");
    const before = week.from;

    await handleKeyAction({ type: "grab" });
    await handleKeyAction({ type: "move", kind: "week", dir: 1 });
    expect(week.from).toBe(before + 7 * 24 * HOUR);
    expect(blockPreview.start).toBe(nextWeekSunday22(before));
    await reloadWeek(); // 模拟 Timeline 的翻周 effect：新一周数据里**没有**这块（它还在库里旧址）

    await handleKeyAction({ type: "drop" });
    expect(state.blocks[0].start_at).toBe(nextWeekSunday22(before));
    expect(blockPreview.id).toBeNull();
  });

  it("抓起后挪到下周 → 还能继续一步一步挪，再落地", async () => {
    seed({ id: "b1", start_at: at(6, 22), end_at: at(6, 23) });
    await reloadWeek();
    selectBlock("b1");
    const before = week.from;

    await handleKeyAction({ type: "grab" });
    await handleKeyAction({ type: "move", kind: "week", dir: 1 });
    await reloadWeek();

    await handleKeyAction({ type: "move", kind: "step", dir: 1 });
    expect(blockPreview.start).toBe(nextWeekSunday22(before) + 15 * MIN);

    await handleKeyAction({ type: "drop" });
    expect(state.blocks[0].start_at).toBe(nextWeekSunday22(before) + 15 * MIN);
  });
});

describe("round33：融合后选中要跟着幸存者 + 跨周拉伸要跟视角", () => {
  it("键盘拉伸把它自己融合掉了 → 选中转到幸存块（round33 #1）", async () => {
    // 选中的是「后一块」（起点更晚）；把它上边缘/下边缘拉到与 b2 重叠 → 幸存者是 b2
    seed({ id: "b1", start_at: at(0, 10), end_at: at(0, 10, 30) });
    seed({ id: "b2", start_at: at(0, 9), end_at: at(0, 9, 30) });
    await reloadWeek();
    selectBlock("b1");

    // 按上边缘往回拉 3 次（10:00 → 09:15）→ 与 b2 重叠 → 后端融合（保留 b2）
    for (let i = 0; i < 3; i++) await handleKeyAction({ type: "stretch", edge: "start", dir: -1 });

    expect(state.blocks.length).toBe(1);
    expect(selection.blockId, "融合后选中要转到幸存块，不能变成幽灵 id").toBe("b2");
  });

  it("跨天块把终点缩到次日 00:00 → 跟随点该是「上一瞬」（前一日 23:59:59，round34）", async () => {
    // 周一 20:00 → 周二 00:45（同周内跨天）
    seed({ id: "b1", start_at: at(0, 20), end_at: at(1, 0, 45) });
    await reloadWeek();
    selectBlock("b1");

    for (let i = 0; i < 3; i++) await handleKeyAction({ type: "stretch", edge: "end", dir: -1 }); // 00:30 → 00:15 → 00:00
    expect(state.blocks[0].end_at).toBe(at(1, 0, 0));
    expect(follow.at, "终点贴着日界 → 相机该在上一列的底（23:59:59）").toBe(at(1, 0, 0) - 1);
    expect(week.from, "同周内跨天：不翻周").toBe(at(0, 0, 0));
  });

  it("跨周块缩短下边缘越过周界 → 视角跟到上一周（round33 #4）", async () => {
    // 起点在上周日 23:30、终点本周一 00:30（本周只看得见 00:00–00:30 那截）
    seed({ id: "b1", start_at: week.from - 1800, end_at: week.from + 1800 });
    await reloadWeek();
    selectBlock("b1");
    const before = week.from;

    // 每按一下模拟一次「Timeline 的翻周 → 重拉」（vitest 里没有组件 effect）
    for (let i = 0; i < 3; i++) {
      await handleKeyAction({ type: "stretch", edge: "end", dir: -1 }); // 00:15 → 00:00 → 23:45（上周日）
      await reloadWeek();
    }
    expect(state.blocks[0].end_at).toBe(before - 900);
    expect(week.from, "块整段回到上一周 → 视角要跟过去").toBe(before - 7 * 24 * HOUR);
  });
});

describe("选中的块没了 → 自动作废（B16/B26）", () => {
  it("块被外部吞掉后：findSelected 返回空、按方向键不报错、选中清空", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectBlock("b1");
    state.blocks = []; // 外部（浮窗/加载扫描）把它吞了
    await reloadWeek();

    expect(findSelected()).toBeNull();
    await handleKeyAction({ type: "move", kind: "step", dir: 1 }); // 不抛
    expect(selection.blockId).toBeNull();

    reconcileSelection();
    expect(selection.grabbed).toBe(false);
    expect(blockPreview.id).toBeNull();
  });
});

describe("未抓起：↑↓ 修边缘（B9/B10/B17）", () => {
  it("↑ 提前起点（终点不动）", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectBlock("b1");

    await handleKeyAction({ type: "stretch", edge: "start", dir: -1 });
    const b = state.blocks[0];
    expect(b.start_at).toBe(at(0, 9) - 15 * MIN);
    expect(b.end_at).toBe(at(0, 10));
    // 跟随「正在动的那条边」
    expect(follow.at).toBe(b.start_at);
  });

  it("Shift+↓ 延长终点（起点不动）", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectBlock("b1");

    await handleKeyAction({ type: "stretch", edge: "end", dir: 1 });
    expect(state.blocks[0].start_at).toBe(at(0, 9));
    expect(state.blocks[0].end_at).toBe(at(0, 10) + 15 * MIN);
    // round34：跟随点用**开区间的上一瞬**（终点那一刻不属于这块）—— 贴着日界时相机才不会跑到下一列
    expect(follow.at).toBe(state.blocks[0].end_at - 1);
  });

  it("最短 15 分钟：再缩就停住（不写坏数据）", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 9, 15) });
    await reloadWeek();
    selectBlock("b1");

    await handleKeyAction({ type: "stretch", edge: "start", dir: 1 });
    expect(state.blocks[0].start_at).toBe(at(0, 9));
    expect(state.blocks[0].end_at).toBe(at(0, 9, 15));
  });

  it("最长 72 小时：再拉就停住", async () => {
    const start = at(0, 9);
    seed({ id: "b1", start_at: start, end_at: start + 72 * HOUR });
    await reloadWeek();
    selectBlock("b1");

    await handleKeyAction({ type: "stretch", edge: "end", dir: 1 });
    expect(state.blocks[0].end_at).toBe(start + 72 * HOUR);
  });
});

describe("抓起：预览不写库，落地才写（B11/B21）", () => {
  it("抓起 → 移动 15 分钟：库里不动、预览动；Enter 才落库", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectBlock("b1");

    await handleKeyAction({ type: "grab" });
    expect(selection.grabbed).toBe(true);
    expect(blockPreview.id).toBe("b1");

    await handleKeyAction({ type: "move", kind: "step", dir: 1 });
    expect(blockPreview.start).toBe(at(0, 9) + 15 * MIN);
    expect(state.blocks[0].start_at, "预览期间库里必须没动").toBe(at(0, 9));

    await handleKeyAction({ type: "drop" });
    expect(selection.grabbed).toBe(false);
    expect(state.blocks[0].start_at).toBe(at(0, 9) + 15 * MIN);
    expect(state.blocks[0].end_at).toBe(at(0, 10) + 15 * MIN); // 时长不变
  });

  it("抓起 → Shift+↓ 移动 1 小时", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectBlock("b1");
    await handleKeyAction({ type: "grab" });
    await handleKeyAction({ type: "move", kind: "coarse", dir: 1 });
    expect(blockPreview.start).toBe(at(0, 9) + HOUR);
    await handleKeyAction({ type: "drop" });
    expect(state.blocks[0].start_at).toBe(at(0, 9) + HOUR);
  });

  it("抓起 → Esc：预览清掉、库里从头到尾没动", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectBlock("b1");
    await handleKeyAction({ type: "grab" });
    await handleKeyAction({ type: "move", kind: "step", dir: 1 });
    await handleKeyAction({ type: "cancel" });

    expect(selection.grabbed).toBe(false);
    expect(selection.blockId, "Esc 放弃抓起后仍保持选中").toBe("b1");
    expect(blockPreview.id).toBeNull();
    expect(state.blocks[0].start_at).toBe(at(0, 9));
  });

  it("抓起中 Delete / Space / X / 拉伸键都被忽略（B27）", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectBlock("b1");
    await handleKeyAction({ type: "grab" });

    await handleKeyAction({ type: "delete" });
    await handleKeyAction({ type: "done" });
    await handleKeyAction({ type: "missed" });
    await handleKeyAction({ type: "stretch", edge: "start", dir: -1 });

    expect(state.blocks.length).toBe(1);
    expect(state.blocks[0].start_at).toBe(at(0, 9));
    expect(state.blocks[0].status).toBe("planned");
    expect(blockPreview.start).toBe(at(0, 9)); // 拉起时就在原位
  });
});

describe("周界跟随（B1/B2/B3/B4/B5/B7/B8）", () => {
  it("周日的块往后挪一天 → 落进下一周：视图跟着翻，块还是选中（following=false）", async () => {
    seed({ id: "b1", start_at: at(6, 23), end_at: at(6, 23, 30) });
    await reloadWeek();
    selectBlock("b1");
    const before = week.from;

    await handleKeyAction({ type: "grab" });
    await handleKeyAction({ type: "move", kind: "day", dir: 1 });
    expect(blockPreview.start).toBe(before + 7 * 24 * HOUR + 23 * HOUR);
    expect(week.from).toBe(before + 7 * 24 * HOUR);
    expect(week.following).toBe(false);
    expect(state.blocks[0].start_at, "预览期间不落库").toBe(before + 6 * 24 * HOUR + 23 * HOUR);

    await handleKeyAction({ type: "drop" });
    await reloadWeek();
    expect(state.blocks[0].start_at).toBe(before + 7 * 24 * HOUR + 23 * HOUR);
    expect(selection.blockId).toBe("b1");
  });

  it("周一的块往前挪一天 → 回到上一周（对称）", async () => {
    seed({ id: "b1", start_at: at(0, 0, 30), end_at: at(0, 1) });
    await reloadWeek();
    selectBlock("b1");
    const before = week.from;

    await handleKeyAction({ type: "grab" });
    await handleKeyAction({ type: "move", kind: "day", dir: -1 });
    expect(week.from).toBe(before - 7 * 24 * HOUR);
    // 周一的 00:30 往前一天 = **上周日** 00:30
    expect(blockPreview.start).toBe(before - 24 * HOUR + 30 * MIN);
  });

  it("周内挪动不翻周", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectBlock("b1");
    const before = week.from;

    await handleKeyAction({ type: "grab" });
    await handleKeyAction({ type: "move", kind: "day", dir: 1 });
    expect(week.from).toBe(before);
    expect(week.following, "没翻周就不动 following").toBe(true);
  });

  it("跨周块（起点上周日 23:00、终点本周一 05:00）以**起点**判周", async () => {
    seed({
      id: "b1",
      start_at: week.from - 1 * HOUR,
      end_at: week.from + 5 * HOUR,
    });
    await reloadWeek();
    selectBlock("b1");
    const before = week.from;

    await handleKeyAction({ type: "grab" });
    await handleKeyAction({ type: "move", kind: "day", dir: 1 });
    // 起点从「上周日 23:00」→「本周一 23:00」：属于本周 → 不翻周
    expect(week.from).toBe(before);
    expect(blockPreview.start).toBe(before + 23 * HOUR);
  });

  it("Shift+←/→ 挪一周：同星期几 ±7 天，必翻周（拿起后落地）", async () => {
    seed({ id: "b1", start_at: at(2, 9), end_at: at(2, 10) });
    await reloadWeek();
    selectBlock("b1");
    const before = week.from;

    await handleKeyAction({ type: "grab" });
    await handleKeyAction({ type: "move", kind: "week", dir: 1 });
    await handleKeyAction({ type: "drop" });
    expect(state.blocks[0].start_at).toBe(before + 7 * 24 * HOUR + 2 * 24 * HOUR + 9 * HOUR);
    expect(week.from).toBe(before + 7 * 24 * HOUR);
  });

  it("下边缘**正好**拉到周末（00:00）不算出界 → 不翻周；再拉一下就翻", async () => {
    seed({ id: "b1", start_at: at(6, 22), end_at: at(6, 23) });
    await reloadWeek();
    selectBlock("b1");
    const before = week.from;

    for (let i = 0; i < 4; i++) await handleKeyAction({ type: "stretch", edge: "end", dir: 1 });
    expect(state.blocks[0].end_at).toBe(before + 7 * 24 * HOUR);
    expect(week.from, "正好拉到 00:00：块还整段在本周 → 不翻").toBe(before);

    await handleKeyAction({ type: "stretch", edge: "end", dir: 1 });
    expect(week.from, "尾巴真的伸进下一周了 → 才翻").toBe(before + 7 * 24 * HOUR);
  });
});

describe("round61.2：组拿起的跟随按「移动方向的领先边」", () => {
  /** 组：锚点 = b2（10:00–11:00）；b1 早于它（8:00–9:00）—— 锚点不是组的极端边 */
  async function grabPair() {
    seed({ id: "b1", start_at: at(0, 8), end_at: at(0, 9) });
    seed({ id: "b2", start_at: at(0, 10), end_at: at(0, 11) });
    await reloadWeek();
    selectBlock("b1");
    toggleSelected("b2"); // 锚点变 b2（后点的那块）
    await handleKeyAction({ type: "grab" });
  }

  it("↓ 时跟的是组的**最晚终点**（不是锚点起点）", async () => {
    await grabPair();
    await handleKeyAction({ type: "move", kind: "step", dir: 1 });
    expect(follow.at, "b2 终点 11:00 + 15 分 = 11:15，取开区间的上一瞬").toBe(at(0, 11, 15) - 1);
  });

  it("↑ 时跟的是组的**最早起点**", async () => {
    await grabPair();
    await handleKeyAction({ type: "move", kind: "step", dir: -1 });
    expect(follow.at).toBe(at(0, 7, 45));
  });

  it("非锚点那块越过周界 → 也翻周（周日块 + 周一块同组）", async () => {
    seed({ id: "b1", start_at: at(6, 22), end_at: at(6, 23) }); // 周日（比锚点晚 → 是组的领先边）
    seed({ id: "b2", start_at: at(0, 9), end_at: at(0, 10) }); // 周一（锚点，自己挪一天还在本周）
    await reloadWeek();
    selectBlock("b1");
    toggleSelected("b2"); // 锚点 = 周一块
    const before = week.from;
    await handleKeyAction({ type: "grab" });
    await handleKeyAction({ type: "move", kind: "day", dir: 1 });
    expect(week.from, "周日那块挪到了下周一 → 必须翻页").toBe(before + 7 * 24 * HOUR);
  });

  it("单块拿起 ↓ 时也跟**终点**（与多选同一套领先边）", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectBlock("b1");
    await handleKeyAction({ type: "grab" });
    await handleKeyAction({ type: "move", kind: "step", dir: 1 });
    expect(follow.at).toBe(at(0, 10, 15) - 1);
  });
});

describe("落地融合 / 序列拒绝 / 级联（B22/B23/B24）", () => {
  it("落地融合：库里只剩一块，选中**转到幸存块**（不能让选中块变幽灵）", async () => {
    // 选中的是「后一块」；落到更早的同任务块上 → 幸存者是更早那块（b2），选中的 b1 被吃掉
    seed({ id: "b1", start_at: at(0, 10), end_at: at(0, 10, 30) });
    seed({ id: "b2", start_at: at(0, 9), end_at: at(0, 9, 30) });
    await reloadWeek();
    selectBlock("b1");

    await handleKeyAction({ type: "grab" });
    await handleKeyAction({ type: "move", kind: "step", dir: -1 });
    await handleKeyAction({ type: "move", kind: "step", dir: -1 });
    await handleKeyAction({ type: "move", kind: "step", dir: -1 }); // 09:15 → 与 b2 重叠
    await handleKeyAction({ type: "drop" });

    expect(state.blocks.length, "融合后库里只剩一块").toBe(1);
    expect(state.blocks[0].id).toBe("b2");
    expect(selection.blockId).toBe("b2");
    expect(blockPreview.id).toBeNull();
  });

  it("序列拒绝：不落库、不翻周、保持选中；不弹假成功", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectBlock("b1");
    state.reject.add("b1");
    const before = week.from;

    await handleKeyAction({ type: "grab" });
    await handleKeyAction({ type: "move", kind: "coarse", dir: 1 });
    await handleKeyAction({ type: "drop" });
    expect(state.blocks[0].start_at).toBe(at(0, 9));
    expect(week.from).toBe(before);
    expect(selection.blockId).toBe("b1");
  });

  it("级联顺延：沿用 moveBlock 的提示（不丢话）", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectBlock("b1");
    state.cascadeOnce = true;

    await handleKeyAction({ type: "grab" });
    await handleKeyAction({ type: "move", kind: "step", dir: 1 });
    await handleKeyAction({ type: "drop" });
    expect(toasts.some((t) => t.msg.includes("跟着挪了"))).toBe(true);
  });
});

describe("连按与节流（B28）", () => {
  it("两次很快的按键合并成一次落库，位置按两次算（拉伸口径；移动已改为拿起预览）", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectBlock("b1");
    const { updateBlock } = await import("../ipc/blocks");
    vi.mocked(updateBlock).mockClear();

    const p1 = handleKeyAction({ type: "stretch", edge: "start", dir: 1 });
    const p2 = handleKeyAction({ type: "stretch", edge: "start", dir: 1 });
    await Promise.all([p1, p2]);

    expect(state.blocks[0].start_at).toBe(at(0, 9) + 30 * MIN);
    expect(vi.mocked(updateBlock)).toHaveBeenCalledTimes(1);
  });
});

describe("删除（键盘 Delete → 复用 removeBlock）", () => {
  it("直接删：块没了、选中清空、预览清空（round40 起**不再弹确认** —— 靠提示条/ Ctrl+Z 撤销）", async () => {
    // 把 confirm 换成「一被调用就抛」—— 真回到模态确认的话这条会当场爆
    vi.stubGlobal("window", {
      confirm: () => {
        throw new Error("round40 起删除不该再弹 window.confirm");
      },
    });
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectBlock("b1");

    await deleteSelected();
    expect(state.blocks.length).toBe(0);
    expect(selection.blockId).toBeNull();
    expect(blockPreview.id).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("状态与类型护栏（B19/B20）", () => {
  it("已标记的块不能移动/拉伸/抓起；但 Delete 还能删", async () => {
    vi.stubGlobal("window", { confirm: () => true });
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10), status: "done" });
    await reloadWeek();
    selectBlock("b1");

    await handleKeyAction({ type: "grab" });
    expect(selection.grabbed).toBe(false);
    await handleKeyAction({ type: "move", kind: "step", dir: 1 });
    await handleKeyAction({ type: "stretch", edge: "start", dir: -1 });
    expect(state.blocks[0].start_at).toBe(at(0, 9));
    expect(state.blocks[0].end_at).toBe(at(0, 10));

    await deleteSelected();
    expect(state.blocks.length).toBe(0);
    vi.unstubAllGlobals();
  });

  it("临时安排块可以移动/拉伸（它不参与融合）", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10), is_temp: true, task_id: "ww-temp-hidden-task" });
    await reloadWeek();
    selectBlock("b1");

    await handleKeyAction({ type: "stretch", edge: "end", dir: 1 }); // 10:00 → 10:15（拉伸仍然直接）
    await handleKeyAction({ type: "grab" });
    await handleKeyAction({ type: "move", kind: "step", dir: 1 }); // 拿起 → 预览 +15 分
    await handleKeyAction({ type: "drop" }); // 落地 → 09:15–10:30
    expect(state.blocks[0].start_at).toBe(at(0, 9) + 15 * MIN);
    expect(state.blocks[0].end_at).toBe(at(0, 10) + 30 * MIN);
  });

  it("Space / X 只标记、不动时间（计划中的块）", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectBlock("b1");

    await handleKeyAction({ type: "done" });
    expect(state.blocks[0].status).toBe("done");
    expect(state.blocks[0].start_at).toBe(at(0, 9));
  });
});

describe("round61（10.2 多选）：选择模型与批量动作", () => {
  it("单选 / Ctrl+加选 / Ctrl+减选：ids 与锚点跟着走，减到空就退出多选态", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    seed({ id: "b2", start_at: at(0, 11), end_at: at(0, 12) });
    await reloadWeek();

    selectBlock("b1");
    expect(selection.ids).toEqual(["b1"]);

    toggleSelected("b2");
    expect(selection.ids).toEqual(["b1", "b2"]);
    expect(selection.blockId, "新加的那块成为锚点").toBe("b2");

    toggleSelected("b1");
    expect(selection.ids).toEqual(["b2"]);
    expect(selection.blockId).toBe("b2");

    toggleSelected("b2");
    expect(selection.ids).toEqual([]);
    expect(selection.blockId).toBeNull();
  });

  it("Shift 区间：按开始时间取「锚点→目标」之间；乱序点击也稳定", async () => {
    seed({ id: "c", start_at: at(0, 15), end_at: at(0, 16) });
    seed({ id: "a", start_at: at(0, 9), end_at: at(0, 10) });
    seed({ id: "b", start_at: at(0, 11), end_at: at(0, 12) });
    await reloadWeek();

    selectBlock("a");
    selectRangeTo("c");
    expect(selection.ids).toEqual(["a", "b", "c"]);
    expect(selection.blockId, "锚点保持不动（连续 Shift 从它量起）").toBe("a");

    selectRangeTo("b");
    expect(selection.ids).toEqual(["a", "b"]);
  });

  it("Ctrl+A 全选本周；Esc 那层（collapseToAnchor）先退回锚点", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    seed({ id: "b2", start_at: at(0, 11), end_at: at(0, 12) });
    await reloadWeek();

    selectAllWeek();
    expect(selection.ids).toEqual(["b1", "b2"]);

    collapseToAnchor();
    expect(selection.ids).toEqual(["b1"]);
    expect(selection.blockId).toBe("b1");
  });

  it("块被外部吞掉 → 失效 id 自动移出选中；全没了才退出", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    seed({ id: "b2", start_at: at(0, 11), end_at: at(0, 12) });
    await reloadWeek();
    selectMany(["b1", "b2"]);

    state.blocks = state.blocks.filter((b) => b.id !== "b1");
    await reloadWeek();
    reconcileSelection();
    expect(selection.ids).toEqual(["b2"]);
    expect(selection.blockId).toBe("b2");

    state.blocks = [];
    await reloadWeek();
    reconcileSelection();
    expect(selection.ids).toEqual([]);
    expect(selection.blockId).toBeNull();
  });

  it("批量标记：只动 planned；标 ✗ **不弹漂流卡**", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    seed({ id: "b2", start_at: at(0, 11), end_at: at(0, 12) });
    seed({ id: "b3", start_at: at(0, 13), end_at: at(0, 14), status: "done" });
    await reloadWeek();
    selectMany(["b1", "b2", "b3"]);

    await markSelectedMany("missed");
    expect(state.blocks.map((b) => b.status)).toEqual(["missed", "missed", "done"]);
    expect(drift.value, "批量标 ✗ 不弹漂流卡").toBeNull();
    expect(toasts.some((t) => t.msg === "已标记 2 块未完成")).toBe(true);
  });

  it("批量删除：一次删多块、选中收口、提示带数量", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    seed({ id: "b2", start_at: at(0, 11), end_at: at(0, 12) });
    await reloadWeek();
    selectMany(["b1", "b2"]);

    await deleteSelectedMany();
    expect(state.blocks.length).toBe(0);
    expect(selection.ids).toEqual([]);
    expect(selection.blockId).toBeNull();
    expect(toasts.some((t) => t.msg === "已删除 2 个块")).toBe(true);
  });

  it("批量挪一天 / 挪一周：只挪 planned，按本地日历 ±N 天", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    seed({ id: "b2", start_at: at(0, 11), end_at: at(0, 12), status: "done" });
    await reloadWeek();
    selectMany(["b1", "b2"]);

    await moveSelectedMany(1);
    expect(state.blocks[0].start_at).toBe(at(1, 9));
    expect(state.blocks[1].start_at, "已标记的不动").toBe(at(0, 11));

    const tuesday9 = at(1, 9); // 先算好**绝对时间**：`at()` 依赖 `week.from`，翻了周再算会漂
    await moveSelectedMany(7);
    expect(state.blocks[0].start_at).toBe(tuesday9 + 7 * 24 * HOUR);
  });

  it("批量改层：整批切到必填", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    seed({ id: "b2", start_at: at(0, 11), end_at: at(0, 12) });
    await reloadWeek();
    selectMany(["b1", "b2"]);

    await setSelectedLayerMany("required");
    expect(state.blocks.every((b) => b.layer === "required")).toBe(true);
  });

  it("selectMany([]) 清空选中（框在空地上）；selectMany 不认名单外的 id", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectMany(["b1"]);
    expect(selection.ids).toEqual(["b1"]);

    selectMany([]);
    expect(selection.ids).toEqual([]);
    expect(selection.blockId).toBeNull();

    selectMany(["b1", "不存在"]);
    expect(selection.ids).toEqual(["b1"]);
  });

  it("批量挪动时块被融合吃掉 → 幽灵选中被收口（6b 补）", async () => {
    seed({ id: "m1", start_at: at(0, 9), end_at: at(0, 9, 30) });
    seed({ id: "m2", start_at: at(0, 10), end_at: at(0, 10, 30) });
    await reloadWeek();
    selectMany(["m1", "m2"]);
    state.mergeOnMove.add("m1"); // 模拟 m1 挪完被融合吃掉

    await moveSelectedMany(1);

    expect(state.blocks.map((b) => b.id)).toEqual(["m2"]);
    expect(selection.ids, "被吃掉的块不能留在选中里").toEqual(["m2"]);
    expect(selection.blockId).toBe("m2");
  });

  it("键盘：多选拿起 → 方向键移动预览 → 落地一次写；未拿起不能移动", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    seed({ id: "b2", start_at: at(0, 11), end_at: at(0, 12) });
    await reloadWeek();
    selectMany(["b1", "b2"]);

    // 未拿起：方向键/拉伸都不搬块（round61.1：移动统一收进拿起）
    await handleKeyAction({ type: "move", kind: "day", dir: 1 });
    await handleKeyAction({ type: "stretch", edge: "start", dir: 1 });
    expect(state.blocks[0].start_at, "未拿起不搬块").toBe(at(0, 9));
    expect(state.blocks[1].start_at).toBe(at(0, 11));

    // Enter 拿起整组 → 方向键只改**组预览**（库里不动）
    await handleKeyAction({ type: "grab" });
    expect(selection.grabbed).toBe(true);
    await handleKeyAction({ type: "move", kind: "step", dir: 1 });
    expect(state.blocks[0].start_at, "拿起中只动预览").toBe(at(0, 9));
    expect(groupPreview.ranges["b1"]?.start).toBe(at(0, 9) + 15 * MIN);
    expect(groupPreview.ranges["b2"]?.start).toBe(at(0, 11) + 15 * MIN);

    // 落地：一次批量写（两块同时到位）
    await handleKeyAction({ type: "drop" });
    expect(state.blocks[0].start_at).toBe(at(0, 9) + 15 * MIN);
    expect(state.blocks[1].start_at).toBe(at(0, 11) + 15 * MIN);
    expect(selection.grabbed).toBe(false);

    // Delete 仍走批量
    await handleKeyAction({ type: "delete" });
    expect(state.blocks.length).toBe(0);

    // 再种两块：拿起 → +7 天跨周 → 落地 → 视角跟过去、选中留住
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 9, 30) });
    seed({ id: "b2", start_at: at(0, 10), end_at: at(0, 10, 30) });
    await reloadWeek();
    selectMany(["b1", "b2"]);
    const beforeFrom = week.from;
    const b1At = at(0, 9);
    await handleKeyAction({ type: "grab" });
    await handleKeyAction({ type: "move", kind: "week", dir: 1 });
    await handleKeyAction({ type: "drop" });
    expect(state.blocks[0].start_at).toBe(b1At + 7 * 24 * HOUR);
    expect(week.from, "视角跟着翻到下一周").toBe(beforeFrom + 7 * 24 * HOUR);
    expect(selection.ids, "跟过去以后选中留住").toEqual(["b1", "b2"]);
  });

  it("Shift 区间 = 交叠带：搭到「锚点→目标」那条带上的块都选中（round61.1 你实测）", async () => {
    seed({ id: "long", start_at: at(0, 9, 15), end_at: at(0, 19, 0) });
    seed({ id: "above", start_at: at(0, 9, 0), end_at: at(0, 10, 30) }); // 早于锚点，但与它交叠
    seed({ id: "way", start_at: at(0, 8, 0), end_at: at(0, 8, 30) }); // 完全在带之前 → 不选
    seed({ id: "bottom", start_at: at(0, 16, 0), end_at: at(0, 17, 0) }); // 目标
    await reloadWeek();

    selectBlock("long");
    selectRangeTo("bottom");
    expect(selection.ids.slice().sort()).toEqual(["above", "bottom", "long"]);
    expect(selection.blockId, "锚点保持不动").toBe("long");
  });

  it("批量挪时间：拿起后 ↑↓ = 15 分钟、Shift+↑↓ = 1 小时（round61.1 你要求）", async () => {
    seed({ id: "m1", start_at: at(0, 9), end_at: at(0, 10) });
    seed({ id: "m2", start_at: at(0, 11), end_at: at(0, 12) });
    await reloadWeek();
    selectMany(["m1", "m2"]);

    await handleKeyAction({ type: "grab" });
    await handleKeyAction({ type: "move", kind: "step", dir: 1 }); // +15 分
    expect(groupPreview.ranges["m1"]?.start).toBe(at(0, 9) + 15 * MIN);
    expect(groupPreview.ranges["m2"]?.start).toBe(at(0, 11) + 15 * MIN);

    await handleKeyAction({ type: "move", kind: "coarse", dir: -1 }); // -1 小时（累积）
    expect(groupPreview.ranges["m1"]?.start).toBe(at(0, 9) + 15 * MIN - 60 * MIN);
    expect(groupPreview.ranges["m2"]?.start).toBe(at(0, 11) + 15 * MIN - 60 * MIN);

    await handleKeyAction({ type: "drop" });
    expect(state.blocks[0].start_at).toBe(at(0, 9) + 15 * MIN - 60 * MIN);
    expect(state.blocks[1].start_at).toBe(at(0, 11) + 15 * MIN - 60 * MIN);
  });

  it("多选拿起中：Delete / Space / X / 拉伸被吞；Esc 放弃拿起且选中留住（6b 补）", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    seed({ id: "b2", start_at: at(0, 11), end_at: at(0, 12) });
    await reloadWeek();
    selectMany(["b1", "b2"]);
    await handleKeyAction({ type: "grab" });
    expect(selection.grabbed).toBe(true);

    // 拿起中只认 drop / cancel / move（B27 同口径）：其余一律吞掉
    await handleKeyAction({ type: "delete" });
    await handleKeyAction({ type: "done" });
    await handleKeyAction({ type: "missed" });
    await handleKeyAction({ type: "stretch", edge: "start", dir: 1 });
    expect(state.blocks.length, "拿起中不删块").toBe(2);
    expect(state.blocks.every((b) => b.status === "planned"), "拿起中不标记").toBe(true);
    expect(groupPreview.ranges["b1"]?.start, "拿起中不拉伸").toBe(at(0, 9));

    // Esc：放弃拿起（选中留住、组预览清掉、库里从头到尾没动）
    await handleKeyAction({ type: "cancel" });
    expect(selection.grabbed).toBe(false);
    expect(selection.ids).toEqual(["b1", "b2"]);
    expect(groupPreview.anchorId, "组预览清掉").toBeNull();
    expect(state.blocks[0].start_at).toBe(at(0, 9));
  });

  it("混合选中：已标记的块不参与移动，提示里写明跳过了几块（round61.1 你实测）", async () => {
    seed({ id: "p1", start_at: at(0, 9), end_at: at(0, 10) });
    seed({ id: "d1", start_at: at(0, 11), end_at: at(0, 12), status: "done" });
    await reloadWeek();
    selectMany(["p1", "d1"]);

    await moveSelectedMany(1);
    expect(state.blocks.find((b) => b.id === "p1")?.start_at).toBe(at(1, 9));
    expect(state.blocks.find((b) => b.id === "d1")?.start_at, "已标记的不动").toBe(at(0, 11));
    expect(toasts.some((t) => t.msg.includes("1 块已标记"))).toBe(true);
  });
});

/**
 * round69（B3）：`Ctrl+X` / `Ctrl+C` 的**跟鼠标**手势（store 层）。
 *
 * DOM 侧（拖影跟手 / 左键放下 / 边缘翻周）由预览断言盖；这里只守状态机：
 * 落地走哪条写路径、选中怎么收口、取消与「全失效」时 followMode 有没有真的复位。
 */
describe("round69（B3）：跟鼠标手势", () => {
  // `armPlacement` 要往 `window` 上挂监听器（浏览器里就是真的）——
  // vitest 跑在 Node 环境，给一个最小的 window（不真挂；手势的 DOM 侧由预览断言盖）
  beforeEach(() => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("复制落地（空档）：一次 createBlocks（一步撤销的同源路径）；新块成为选中、followMode 复位", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectMany(["b1"]);
    vi.mocked(createBlocks).mockClear();

    startFollowGesture("copy");
    expect(selection.followMode).toBe("copy");
    expect(selection.grabbed).toBe(true);
    expect(groupPreview.anchorId).toBe("b1");

    // round69.1（D1）：落在**空档**才是「多一份」——先把预览挪到 11:00
    shiftGroupPreview(at(0, 11) - groupPreview.ranges["b1"].start);
    await handleKeyAction({ type: "drop" });
    expect(vi.mocked(createBlocks)).toHaveBeenCalledTimes(1);
    const specs = vi.mocked(createBlocks).mock.calls[0][0];
    expect(specs).toHaveLength(1);
    expect(specs[0].task_id).toBe("t1");
    expect(specs[0].start_at).toBe(at(0, 11));
    expect(specs[0].end_at).toBe(at(0, 12));
    expect(selection.followMode).toBeNull();
    expect(selection.grabbed).toBe(false);
    expect(selection.ids).toHaveLength(1);
    expect(selection.blockId).toBe(selection.ids[0]);
    const copy = state.blocks.find((b) => b.id !== "b1");
    expect(copy, "空档能多出一份").toBeTruthy();
    expect(selection.blockId, "新块成为选中").toBe(copy?.id);
    expect(state.blocks).toHaveLength(2);
  });

  it("复制落地（同一格，D1）：就地融合成一块 —— 原块当幸存者（id 不换）、选中回到它", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectMany(["b1"]);
    vi.mocked(createBlocks).mockClear();

    startFollowGesture("copy");
    // 不动预览 → 落在原格
    await handleKeyAction({ type: "drop" });
    expect(vi.mocked(createBlocks)).toHaveBeenCalledTimes(1);
    expect(state.blocks, "就地融合：不增块").toHaveLength(1);
    expect(state.blocks[0].id, "原块当幸存者").toBe("b1");
    expect(state.blocks[0].start_at).toBe(at(0, 9));
    expect(selection.ids, "选中回到幸存块").toEqual(["b1"]);
    expect(selection.followMode).toBeNull();
  });

  it("取消（Esc）：一行不写、followMode 复位、选中留住", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectMany(["b1"]);
    vi.mocked(createBlocks).mockClear();

    startFollowGesture("move");
    expect(selection.followMode).toBe("move");
    await handleKeyAction({ type: "cancel" });

    expect(selection.followMode).toBeNull();
    expect(selection.grabbed).toBe(false);
    expect(selection.ids).toEqual(["b1"]);
    expect(state.blocks[0].start_at).toBe(at(0, 9));
    expect(vi.mocked(createBlocks)).not.toHaveBeenCalled();
  });

  it("清选中（点空白 / 面板关闭那条路）→ 跟鼠标手势一起收干净（6b P1：别留幽灵监听器）", async () => {
    seed({ id: "b1", start_at: at(0, 9), end_at: at(0, 10) });
    await reloadWeek();
    selectMany(["b1"]);
    startFollowGesture("move");
    expect(selection.followMode).toBe("move");

    clearSelection(); // 与「点空白 / Esc 清选中」同一条路

    expect(selection.followMode).toBeNull();
    expect(selection.grabbed).toBe(false);
    expect(selection.ids).toEqual([]);
    expect(groupPreview.anchorId).toBeNull();
  });
});
