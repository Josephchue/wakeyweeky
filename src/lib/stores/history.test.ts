/**
 * round27（用户 round26 验收 #1/#2）：
 *   「删任务 → Ctrl+Z」之后任务没回来、块名查不到任务只能显示「?」；
 *   「撤销新建任务」之后左栏还留着它，一拖/一改名就报「任务不存在」。
 *
 * 根因：撤销/重做是**后端整表回滚**（快照 7 张表里就有 `tasks`），
 * 但前端 `sync()` 只重拉了块与序列、**没重拉任务列表** → Backlog 停在旧状态。
 *
 * 这条钉住「撤销/重做必须重拉任务」—— 不重拉就红（红绿对照跑过）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type T = {
  id: string;
  title: string;
  category: string | null;
  estimated_minutes: number | null;
  is_elastic: number;
  archived_at: number | null;
  created_at: number;
  // round48：任务级「不计入理智」+ 手动顺序
  sanity_exempt: boolean;
  sort_order: number;
};

const state: { tasks: T[]; listCalls: number } = { tasks: [], listCalls: 0 };

const mkTask = (id: string, title: string): T => ({
  id,
  title,
  category: null,
  estimated_minutes: null,
  is_elastic: 0,
  archived_at: null,
  created_at: 0,
  // round48：任务级「不计入理智」+ 手动顺序（这条测试不关心顺序，给个 0 就够）
  sanity_exempt: false,
  sort_order: 0,
});

vi.mock("../ipc/blocks", () => ({
  listBlocks: vi.fn(async () => []),
  createBlock: vi.fn(),
  deleteBlock: vi.fn(),
  markBlockDone: vi.fn(),
  markBlockMissed: vi.fn(),
  updateBlock: vi.fn(),
  createTempBlock: vi.fn(),
  postponeBlock: vi.fn(),
  mergePendingBlocks: vi.fn(async () => ""),
}));

// C6（round44）：`reloadWeek()` 会顺带拉一次理智值曲线 —— 这里挡住真 IPC（同 history.test.ts）
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

vi.mock("../ipc/sequences", () => ({
  listSequences: vi.fn(async () => []),
  linkAfter: vi.fn(),
  removeSequenceMember: vi.fn(),
}));

vi.mock("../ipc/tasks", () => ({
  listTasks: vi.fn(async () => {
    state.listCalls++;
    return state.tasks.map((t) => ({ ...t }));
  }),
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  updateTask: vi.fn(),
  archiveTask: vi.fn(),
  renameTask: vi.fn(),
}));

vi.mock("../ipc/repeats", () => ({
  listRepeats: vi.fn(async () => []),
  createRepeat: vi.fn(),
  setRepeatEnabled: vi.fn(),
  deleteRepeat: vi.fn(),
  generateRepeats: vi.fn(async () => 0),
}));

vi.mock("../ipc/history", () => ({
  undo: vi.fn(async () => ({ label: "删除任务" })),
  redo: vi.fn(async () => ({ label: "新建任务" })),
}));

const { tasks } = await import("./tasks.svelte");
const { undo, redo } = await import("./history.svelte");
const ipcBlocks = await import("../ipc/blocks");
const ipcRepeats = await import("../ipc/repeats");
const { reloadWeek } = await import("./blocks.svelte");

describe("撤销/重做之后必须重拉任务列表（round27 #1/#2）", () => {
  beforeEach(() => {
    state.tasks = [];
    state.listCalls = 0;
    tasks.length = 0;
  });

  it("撤销「删除任务」：后端把任务滚回来了 → 左栏就得看得见它（块名也才不会是「?」）", async () => {
    // 后端此刻的真实状态：整表快照把任务也滚回来了
    state.tasks = [mkTask("t1", "写作")];
    await undo();
    expect(state.listCalls).toBeGreaterThan(0);
    expect(tasks.map((t) => t.id)).toEqual(["t1"]);
  });

  it("撤销「新建任务」：库里已经没有它了 → 左栏不许再留着（否则一用就报「任务不存在」）", async () => {
    tasks.push(mkTask("ghost", "幽灵任务")); // 左栏里还留着旧的（用户看到的那一幕）
    state.tasks = []; // 库里已经没了
    await redo();
    expect(tasks.length).toBe(0);
  });
});

/**
 * round69.1（#2）：撤销 / 重做的重拉**不许再跑「开周维护」**（补每周重复 + 扫融合）。
 *
 * 用户实测（图2）：`Ctrl+Z` 反复只剩「已撤销：整理重复块与序列」与「已合并 1 处重复的同任务块」
 * 交替 —— 撤销把融合前的两块恢复出来，同一趟 `reloadWeek()` 又把它合掉、又压一条历史 → 永远撤不出去。
 * 维护本身没错，错在「撤销的 reload 也跑它」→ 本用例钉住这一点（普通跳周照跑，幂等性不变）。
 */
describe("撤销 / 重做不跑开周维护（round69.1 #2）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("undo / redo → 不调 generate_repeats、也不调 merge_pending_blocks", async () => {
    await undo();
    await redo();
    expect(ipcRepeats.generateRepeats).not.toHaveBeenCalled();
    expect(ipcBlocks.mergePendingBlocks).not.toHaveBeenCalled();
  });

  it("普通 reloadWeek（跳周 / 落库后重拉）→ 维护照旧跑", async () => {
    await reloadWeek();
    expect(ipcRepeats.generateRepeats).toHaveBeenCalledTimes(1);
    expect(ipcBlocks.mergePendingBlocks).toHaveBeenCalledTimes(1);
  });
});
