/**
 * 复现用户报的「翻页看不到东西」：
 *   在下一周放一块 → 跳回上一周 → 上一周原本有数据的块**不该消失**。
 * 用假后端（会记事 + 按周过滤，与真后端同一套语义）跑**真的 store 流程**，不碰用户数据。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
};

const state: {
  blocks: Blk[];
  n: number;
  slowFrom?: number;
  /** round29 #6 探针：**只**把同窗口的**第一个**请求拖慢（后面的快）—— 造出「先发的晚返回」这种时序 */
  slowOnceFor?: number;
  failNextFor?: number;
} = { blocks: [], n: 0 };

vi.mock("../ipc/blocks", () => ({
  listBlocks: vi.fn(async (from: number, to: number) => {
    // round26 修：必须返回**副本** —— 真 IPC 会序列化，返回同一批对象引用的话
    // 假后端改库会顺手改掉 store 里那一份 → 「前端有没有重拉」就验不出来了（红绿对照时抓过 ✗）
    // round29 #6：快照要**在延时时先取** —— 真后端也一样：查询先跑完（那时库里是什么就是什么），
    // 变慢的是「结果回来的路上」（IPC 排队 / 主线程忙）。不先取快照，就造不出「旧快照晚到」。
    const snapshot = state.blocks.filter((b) => b.start_at >= from && b.start_at < to).map((b) => ({ ...b }));
    // 让"慢请求"故意晚点返回：用来复现竞态（过期的返回不该覆盖列表）
    if (state.slowFrom === from) {
      await new Promise((r) => setTimeout(r, 60));
    }
    // round29 #6 探针：**只**慢第一个（同窗口的后续请求很快就回）→ 先发的那份会**晚于**后发的落地
    if (state.slowOnceFor === from) {
      state.slowOnceFor = undefined;
      await new Promise((r) => setTimeout(r, 60));
    }
    if (state.failNextFor === from) {
      state.failNextFor = undefined;
      throw new Error("ipc 失败（模拟：更晚发起的那次加载失败）");
    }
    return snapshot;
  }),
  createBlock: vi.fn(async (taskId: string, startAt: number, endAt: number) => {
    const b: Blk = {
      id: "b" + ++state.n,
      task_id: taskId,
      start_at: startAt,
      end_at: endAt,
      status: "planned",
      layer: "elastic",
      last_notified_at: null,
      created_at: 0,
      external_source: null,
      final_status: null,
      postponed_from: null,
      priority: "low",
      label: null,
    };
    state.blocks.push(b);
    return { block: { ...b }, merged: false }; // round31：建块命令返回 { block, merged }
  }),
  updateBlock: vi.fn(
    async (id: string, patch: { startAt?: number; endAt?: number; layer?: string; label?: string }) => {
      const b = state.blocks.find((x) => x.id === id);
      if (!b) throw new Error("任务块不存在");
      // 真后端语义：只给 startAt → 时长不变、整块平移；给了 endAt → 改终点
      if (patch.startAt != null) {
        const len = b.end_at - b.start_at;
        b.start_at = patch.startAt;
        b.end_at = patch.startAt + len;
      }
      if (patch.endAt != null) b.end_at = patch.endAt;
      if (patch.layer != null) b.layer = patch.layer;
      if (patch.label != null) {
        const trimmed = String(patch.label).trim();
        b.label = trimmed === "" ? null : trimmed;
      }
      /**
       * round30（用户实测「拖上去永远不融合」）：真后端 `update_block` 落库后会跟着**融合**
       * （`merge_adjacent`：同任务 + 同层 + 都 planned + 相接或重叠 → 合并成一块，
       * 保留起点更早的那个、吃掉另一个；并集超 3 天则跳过）。
       * 假后端少做这条 —— 「后端合了、界面却还是两块」这类 bug 在这里就永远复现不出来 ✗
       * （用户的真库里 `merge` 事件分明写着合了，界面上却一直两块）。
       */
      const other = state.blocks.find(
        (x) =>
          x.id !== id &&
          x.task_id === b.task_id &&
          x.task_id !== "ww-temp-hidden-task" &&
          x.layer === b.layer &&
          x.status === "planned" &&
          b.status === "planned" &&
          x.start_at <= b.end_at &&
          x.end_at >= b.start_at,
      );
      if (other) {
        const keep = b.start_at <= other.start_at ? b : other;
        const eaten = keep === b ? other : b;
        const union = {
          start_at: Math.min(b.start_at, other.start_at),
          end_at: Math.max(b.end_at, other.end_at),
        };
        if (union.end_at - union.start_at <= 72 * 3600) {
          keep.start_at = union.start_at;
          keep.end_at = union.end_at;
          state.blocks.splice(state.blocks.indexOf(eaten), 1);
          return { block: { ...keep }, cascaded: 0, history_moved: 0, merge_hint: null, merged: true };
        }
      }
      return { block: { ...b }, cascaded: 0, history_moved: 0, merge_hint: null, merged: false };
    },
  ),
  deleteBlock: vi.fn(),
  /**
   * round26 B 组（对账 §5-U）：真后端这两条命令**可能动别的行**（`create_block` 的自动融合
   * 会把同任务的邻居吃掉、漂流会新建一块），返回给前端的只是**幸存者**。
   * 假后端必须照这个语义改库 —— 否则「前端有没有整周重拉」验不出来（红绿对照会假绿）。
   */
  markBlockDone: vi.fn(async (id: string) => {
    const b = state.blocks.find((x) => x.id === id);
    if (!b) throw new Error("任务块不存在");
    b.status = "done";
    // 模拟融合：顺手把同一任务的另一个计划块吃掉（这一行**不在返回值里**）
    const i = state.blocks.findIndex(
      (x) => x.id !== id && x.task_id === b.task_id && x.status === "planned",
    );
    if (i >= 0) state.blocks.splice(i, 1);
    return { ...b };
  }),
  markBlockMissed: vi.fn(async (id: string) => {
    const b = state.blocks.find((x) => x.id === id);
    if (!b) throw new Error("任务块不存在");
    b.status = "missed";
    return { ...b };
  }),
  /** 漂流：残影留下 + 新建「漂出去」的那一块；返回值只是幸存者（真后端语义） */
  postponeBlock: vi.fn(async (id: string, newStartAt: number) => {
    const src = state.blocks.find((b) => b.id === id);
    if (!src) throw new Error("任务块不存在");
    src.status = "missed";
    const drift: Blk = {
      ...src,
      id: "drift" + ++state.n,
      start_at: newStartAt,
      end_at: newStartAt + (src.end_at - src.start_at),
      status: "planned",
      postponed_from: id,
    };
    state.blocks.push(drift);
    return { block: drift, cascaded: 0, history_moved: 0, merge_hint: null, merged: false };
  }),
  mergePendingBlocks: vi.fn(async () => ""),
}));

// C6（round44）：`reloadWeek()` 尾巴上会顺手拉一次理智值曲线 —— 测试里把它挡掉
// （不挡就会去调真 IPC：`window.__TAURI_INTERNALS__` 不存在 → 进 catch 打日志，测试不干净）
vi.mock("../ipc/sanity", () => ({
  getSanityCurve: vi.fn(async () => ({
    week_start: 0,
    week_end: 0,
    today_index: -1,
    worst_state: "calm",
    budget: 360,
    enabled: true,
    days: [],
  })),
}));

const { blocks, createBlock, loadBlocks, markDone, moveBlock, postpone, reloadWeek, stretchBlock } =
  await import("./blocks.svelte");
const { toasts } = await import("./ui.svelte");
const { goWeek, week } = await import("./week.svelte");

const HOUR = 3600;
describe("跳周之后不该整周空白", () => {
  beforeEach(() => {
    state.blocks = [];
    state.n = 0;
  });

  it("在下一周放块 → 跳回上一周，上一周的块还在", async () => {
    // 本周上午放一块
    await createBlock("t1", week.from + 9 * HOUR, week.from + 9 * HOUR + 1800);
    await reloadWeek();
    const thisWeek = blocks.length;
    expect(thisWeek).toBeGreaterThan(0);

    // 跳到下一周，再放一块
    goWeek(1);
    await reloadWeek();
    await createBlock("t1", week.from + 9 * HOUR, week.from + 9 * HOUR + 1800);
    await reloadWeek();
    expect(blocks.length).toBeGreaterThan(0);

    // 跳回上一周：这里就是用户看到"什么都看不到"的地方
    goWeek(-1);
    await reloadWeek();
    expect(blocks.length, "跳回上一周之后不该空白").toBe(thisWeek);
  });

  it("竞态：过期的那次加载回来时，不许覆盖当前这一周（用户报的「整周空白」）", async () => {
    const thisWeek = week.from;
    await createBlock("t1", thisWeek + 9 * HOUR, thisWeek + 9 * HOUR + 1800);
    const nextWeek = thisWeek + 7 * 86400;
    await createBlock("t1", nextWeek + 9 * HOUR, nextWeek + 9 * HOUR + 1800);

    // 视图已经在下一周了：先发一次「本周」的慢加载，再发「下一周」的加载
    goWeek(1);
    state.slowFrom = thisWeek;
    const slow = loadBlocks(thisWeek, thisWeek + 7 * 86400);
    const fast = loadBlocks(nextWeek, nextWeek + 7 * 86400);
    await Promise.all([slow, fast]);

    expect(blocks.length, "列表应当停在最后请求的那一周（下一周）").toBe(1);
    expect(blocks[0].start_at).toBeGreaterThanOrEqual(nextWeek);
  });

  it("切周时：更晚发起、但失败的那次加载，不许把已经拿到的这一周数据作废（用户报的「拖一下才闪出来」）", async () => {
    const thisWeek = week.from;
    const nextWeek = thisWeek + 7 * 86400;
    await createBlock("t1", nextWeek + 9 * HOUR, nextWeek + 9 * HOUR + 1800);
    await reloadWeek(); // 先站稳在本周
    blocks.length = 0;

    // 跳到下一周：第一次加载**能成功**（慢），紧接着有个更晚发起的加载**会失败**
    goWeek(1);
    state.slowFrom = undefined;
    const good = loadBlocks(week.from, week.to);
    state.failNextFor = week.from;
    const bad = loadBlocks(week.from, week.to).catch(() => {});
    await Promise.all([good, bad]);

    expect(blocks.length, "已经拿到的那一周数据不该被作废").toBe(1);
  });

  it("探针（round29 #6）：先发的那份**晚于**后发的成功加载返回时，不许把新数据顶掉", async () => {
    const nextWeek = week.from + 7 * 86400;
    const first = await createBlock("t1", nextWeek + 9 * HOUR, nextWeek + 9 * HOUR + 1800);
    goWeek(1);
    await reloadWeek();
    blocks.length = 0; // 清空：谁写进来就算谁的

    state.slowOnceFor = week.from; // A：先发、慢（快照 = 只有 first 那一块）
    const slow = loadBlocks(week.from, week.to);
    // 库跟着变了（相当于「落库那一步」把另一块也放进了这一周）
    state.blocks.push({
      ...first,
      id: "late-one",
      start_at: nextWeek + 11 * HOUR,
      end_at: nextWeek + 11 * HOUR + 1800,
    });
    const fast = loadBlocks(week.from, week.to); // B：后发、快（快照 = 2 块）
    await Promise.all([slow, fast]);

    expect(blocks.length, "最终留在列表里的必须是**后发那次**的数据（2 块）").toBe(2);
  });

  // ===== round26 B 组（对账 §5-U）：落库之后**必须整周重拉** =====
  // 规矩 23：会动数据的落库调用一律整周重拉 —— 因为后端可能多删/多改别的行，
  // 而返回值只告诉你「哪一块幸存」。旧写法（按 id upsert 返回的那一块）会留下幻影行。

  it("标记完成：后端顺手融合掉邻居 → store 必须与库一致（不能只按 id 写回）", async () => {
    const start = week.from + 9 * HOUR;
    const a = await createBlock("t1", start, start + 1800);
    await createBlock("t1", start + 3600, start + 5400); // 同任务的邻居（会被吃掉）
    await reloadWeek();
    expect(blocks.length).toBe(2);

    await markDone(a.id);

    // 库里只剩 1 块（邻居被融合吃掉）；store 里那行幻影必须消失
    expect(blocks.map((b) => b.id)).toEqual([a.id]);
    expect(blocks[0].status).toBe("done");
  });

  it("漂流：后端留下残影 + 新建一块，返回的只是幸存者 → store 必须与库一致", async () => {
    const start = week.from + 9 * HOUR;
    const a = await createBlock("t1", start, start + 1800);
    await reloadWeek();

    const outcome = await postpone(a.id, start + 7200);
    expect(outcome.block.id).not.toBe(a.id);

    // store 里必须同时看到「残影（missed）」与「漂出去的新块（planned）」——
    // 旧写法只 upsert 返回的那一块 → 原块还停在 planned（用户实测：没合上 / 看不出变化）
    expect(blocks.map((b) => b.id + ":" + b.status).sort()).toEqual(
      [a.id + ":missed", outcome.block.id + ":planned"].sort(),
    );
  });

  // ===== round30（用户 2026-10-02 的长账：「拖上去永远不融合」）=====
  it("拉伸把下面那块拉到上面那块上 → 后端融合了，界面必须也只剩一块（不能留幻影行）", async () => {
    // 用户的原步骤：同一个任务上下放两块 → 把下面那块的上边缘往上拖到上面那块的上面。
    // 真库（只读副本）里 `merge` 事件明明写着已经合了，而界面一直是两块 —— 因为
    // `stretchBlock` 只看「幸存者还是不是这一块」：起点更早的幸存者**就是**被拉伸的那块，
    // 于是走了「按 id 写回 store」的快捷路 ✗，被吃掉的那块就变成幻影行留在界面上。
    const start = week.from + 9 * HOUR;
    const top = await createBlock("t1", start, start + 1800);
    const bottom = await createBlock("t1", start + 3 * HOUR, start + 3 * HOUR + 1800);
    await reloadWeek();
    expect(blocks.length).toBe(2);

    // 上边缘一路拉过上面那块的起点（8:30），终点不动
    const outcome = await stretchBlock(bottom.id, start - 1800, start + 3 * HOUR + 1800);
    expect(outcome.block.id, "幸存者就是被拉伸的那块（它起点更早）").toBe(bottom.id);

    // 库里只剩一块（融合：吃掉 top）
    expect(state.blocks.filter((b) => b.task_id === "t1").map((b) => b.id)).toEqual([bottom.id]);
    expect(state.blocks.some((b) => b.id === top.id), "top 被吃掉了").toBe(false);
    // 界面上也必须只剩一块 —— 旧代码这里会看到 [bottom, top] ✗（top 是幻影）
    expect(blocks.map((b) => b.id), "被融合吃掉的那块不许留在 store 里").toEqual([bottom.id]);
    expect(blocks[0].start_at).toBe(start - 1800);
    expect(blocks[0].end_at).toBe(start + 3 * HOUR + 1800);
  });
});

// ===== round31（C1.9）：融合提示 —— 「每个操作造成的合并都弹」（用户 2026-10-02 拍板）=====
describe("操作造成的融合要弹「已合并两块」", () => {
  // 本 describe 是独立的（不在上面那个 describe 里）→ 自己重置，别吃上一组的状态
  beforeEach(() => {
    state.blocks = [];
    state.n = 0;
    toasts.length = 0;
  });

  it("挪到同任务块上 → 弹一次；普通移动不弹", async () => {
    const start = week.from + 9 * HOUR;
    const a = await createBlock("t9", start, start + 1800);
    await createBlock("t9", start + 2 * HOUR, start + 2 * HOUR + 1800);
    await reloadWeek();
    toasts.length = 0;

    // 不相邻的移动：不弹（B30）
    await moveBlock(a.id, start + 15 * 60);
    expect(toasts.some((t) => t.msg.includes("已合并")), "没融合就不该弹").toBe(false);

    // 挪到 b 上（重叠 → 融合）：弹一次（B29）
    toasts.length = 0;
    await moveBlock(a.id, start + 2 * HOUR);
    expect(state.blocks.length).toBe(1);
    expect(toasts.filter((t) => t.msg.includes("已合并")).length, "只弹一次").toBe(1);
  });

  it("加载时扫描合并的汇总提示，不与操作融合提示重复（B31）", async () => {
    const start = week.from + 9 * HOUR;
    const a = await createBlock("t9", start, start + 1800);
    await createBlock("t9", start + 2 * HOUR, start + 2 * HOUR + 1800);
    await reloadWeek();
    toasts.length = 0;

    // 让**加载时扫描**（reloadWeek 里的 mergePendingBlocks）吞掉一块并回报它的汇总文案：
    // 写路径的快照在 reloadWeek **之前**取 —— 所以差集上看不到这一块，不会多弹一条 ✗
    const ipc = await import("../ipc/blocks");
    vi.mocked(ipc.mergePendingBlocks).mockImplementationOnce(async () => {
      state.blocks.pop();
      return "已合并 1 处重复的同任务块（可 Ctrl+Z 撤销）";
    });

    await moveBlock(a.id, start + 15 * 60); // 普通移动，不会融合
    expect(toasts.filter((t) => t.msg.includes("已合并")).length, "只留扫描那一句").toBe(1);
    expect(toasts.some((t) => t.msg.includes("处重复"))).toBe(true);
  });
});
