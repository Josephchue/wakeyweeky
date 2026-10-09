/**
 * round31（C1.9 / R42）：**键盘操作的最后一块** —— 选中谁、抓起没有、按键落到哪。
 *
 * 设计（用户 2026-10-02 拍板，详见 `docs/plans/round31-keyboard.md`）：
 * - 未抓起：`↑↓` 修上边缘（起点）、`Shift+↑↓` 修下边缘（时长）；`←→` 挪一天、`Shift+←→` 挪一周
 * - 抓起（`Enter`）：方向键只改**预览**（不写库），`Enter` 落地才落库（这时才可能融合/级联）
 * - 块被融合/删除 → 选中自动作废，不留幽灵 id
 * - 连按会**累积**成一步落库（不排队爆炸、不丢按键）
 *
 * 为什么逻辑放这里：组件里的键盘分支 vitest 看不到（round26 教训）—— 组件只负责「拦截按键 + 画」。
 */
import { t, tn } from "../i18n/i18n.svelte";
import type { Block, BlockLayer, CopySpec } from "../ipc/types";
import { getSlotStartSec } from "../utils/week";
import { addLocalDays, clampRange, moveStartBy, type KeyAction } from "../utils/keyboard";
import { featureOn } from "./settings.svelte";
import { maybeHint } from "./guide.svelte";
import { note } from "./achievements.svelte";
import {
  beginGroupPreview,
  blockPreview,
  blocks,
  clearBlockPreview,
  clearGroupPreview,
  copyBlocksMany,
  groupPreview,
  groupPreviewMoves,
  loadedWindow,
  markBlocksMany,
  markDone,
  markMissed,
  moveBlock,
  moveBlocksMany,
  reloadWeek,
  removeBlock,
  removeBlocksMany,
  setBlockPreview,
  setBlocksLayerMany,
  shiftGroupPreview,
  stretchBlock,
} from "./blocks.svelte";
import { armPlacement, drag } from "./drag.svelte";
import { openDrift } from "./drift.svelte";
import { link } from "./sequences.svelte";
import { selection, toast } from "./ui.svelte";
import { goToWeekOf, week } from "./week.svelte";

// round33：`selection` 的状态挪到 `ui.svelte.ts`（写路径也要读它，避免 blocks ↔ selection 循环依赖）；
// 这里原样转出去，外部照旧 `import { selection } from "./stores/selection.svelte"` ✓
export { selection };

/**
 * 视觉跟随（Timeline 用）：每次操作把「正在动的那条边」的时刻报出来，
 * 组件负责把它滚进视野 / 翻到那一周（DOM 的事留在组件里，见 `docs/plans/round31-keyboard.md` §四）。
 */
export const follow = $state<{ at: number; seq: number }>({ at: 0, seq: 0 });

/**
 * round64.1（验收 #3）：撤销 / 重做之后闪一下**被改的块**（纯视觉，不动选中）。
 * 1.5 秒后自己清 —— 类名跟着摘掉，CSS 动画才会在下一次重新触发。
 */
export const flash = $state<{ ids: string[]; seq: number }>({ ids: [], seq: 0 });
const FLASH_MS = 1500;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

function flashBlocks(ids: string[]): void {
  if (flashTimer !== null) clearTimeout(flashTimer);
  flash.ids = [...ids];
  flash.seq += 1;
  flashTimer = setTimeout(() => {
    flash.ids = [];
    flashTimer = null;
  }, FLASH_MS);
}

/** 撤销 / 重做后：把视角带到 `at`（翻周 + 列 + 时刻，与总览「跳回块」同一条路），并闪这些块 */
export function revealBlocks(at: number, ids: string[]): void {
  requestFollow(at, "start");
  flashBlocks(ids);
}

/** 选中的块（**只查不改**：渲染里调它不会改状态；多选时它是**锚点**） */
export function findSelected(): Block | null {
  const id = selection.blockId;
  if (!id) return null;
  return blocks.find((b) => b.id === id) ?? null;
}

/** 块已经不在（被融合/删掉）→ 把失效的 id 移出选中、清预览。
 *  谁调它：写路径（单块删除/落地融合）与键盘入口在「块可能失效」时调它；
 *  round61（6b 复核校正）：**没有** Timeline 的 effect 在轮询（旧注释写错）—— 批量动作的收口
 *  由 `deleteSelectedMany` / `moveSelectedMany` / `setSelectedLayerMany` 自己调。
 *  round61（10.2 多选）：从「一块」扩成「一批」—— 全失效才退出选中态，剩一块就退回单选。 */
export function reconcileSelection(): void {
  if (selection.ids.length === 0) return;
  // 翻周进行中（week 已变、数据还是上一周的）→ 先别判：不然会把还在新一周里的选中误清（round31 实测）
  if (loadedWindow.from !== week.from || loadedWindow.to !== week.to) return;
  const kept = selection.ids.filter((id) => {
    // round32：抓起中块的**真相在预览快照里** —— 它可能正被挪到别的周，那一周的数据里当然没有它
    if (selection.grabbed && blockPreview.id === id && blockPreview.block) return true;
    return blocks.some((b) => b.id === id);
  });
  if (kept.length === selection.ids.length) {
    if (selection.blockId && !kept.includes(selection.blockId)) {
      selection.blockId = kept[0] ?? null;
    }
    return;
  }
  selection.ids = kept;
  if (kept.length === 0) {
    // round69（B3 / 6b P1）：全失效时要把**跟鼠标手势**也收干净 ——
    // 否则 `followMode` 留着脏值、监听器还在，下一次左键会用旧预览落一次（Enter 落地可达后尤其要守）
    endFollow();
    selection.blockId = null;
    selection.grabbed = false;
    clearBlockPreview();
    return;
  }
  if (!selection.blockId || !kept.includes(selection.blockId)) {
    selection.blockId = kept[0];
  }
}

/**
 * 抓起中「手上那块」的真相（round32 #1/#6）：**以预览 + 快照为准**，不去本周 `blocks` 里找。
 * 为什么：抓起能把块预览到别的周（`←→`/`Shift+←→`/跨周日），而库里它还在旧址 ——
 * 翻周重拉后本周数据里当然没有它 → `findSelected()` 返回空 → 动不了、也放不下（用户实测）。
 */
function grabbedTarget(): { block: Block; start: number; end: number } | null {
  if (!selection.grabbed || !selection.blockId) return null;
  if (blockPreview.id !== selection.blockId) return null;
  const block = blockPreview.block ?? blocks.find((x) => x.id === selection.blockId) ?? null;
  if (!block) return null;
  return { block, start: blockPreview.start, end: blockPreview.end };
}

export function selectBlock(id: string | null): void {
  if (id === null) {
    clearSelection();
    return;
  }
  // 已经是「只选中它」→ 保持原样（别清抓起态）
  if (id === selection.blockId && selection.ids.length === 1) return;
  cancelGrab(); // 换选一个块时，旧预览不该留着
  selection.blockId = id;
  selection.ids = [id];
}

/** 焦点进入块时用（round61）：已经在选中里就别缩成单选 ——
 *  Shift 区间选完，焦点落到目标块上时不能把整段区间毁掉。 */
export function focusSelect(id: string): void {
  if (isSelected(id)) return;
  selectBlock(id);
}

/* ------------------------------------------------------------------ *
 * round61（10.2 多选）：选择模型从「一块」扩成「一批」
 * - `selection.ids` 含锚点 `blockId`；不变式：ids 空 ⟺ blockId 空，且 blockId ∈ ids
 * - 单块动作（拉伸/抓起/改名）仍读 blockId；批量动作（标记/删除/挪/改层）读 ids
 * ------------------------------------------------------------------ */

/** 它在不在当前选中里（TaskBlock 的 `.selected` 与焦点守卫用） */
export function isSelected(id: string): boolean {
  return selection.ids.includes(id);
}

/** 本周块按时间排序（Shift 区间 / Ctrl+A 用）：起点 → 终点 → id，保证稳定 */
function orderedBlocks(): Block[] {
  return [...blocks].sort(
    (a, b) => a.start_at - b.start_at || a.end_at - b.end_at || a.id.localeCompare(b.id),
  );
}

/** `Ctrl+左键`：加选 / 减选一块 */
export function toggleSelected(id: string): void {
  if (!blocks.some((b) => b.id === id)) return;
  // round64（C10）：多选开关关掉 → 退化成「点一下就只选它」
  if (!featureOn("multi_select_enabled")) {
    selectBlock(id);
    return;
  }
  cancelGrab();
  if (!selection.ids.includes(id)) {
    selection.ids = [...selection.ids, id];
    selection.blockId = id; // 新加的成为锚点（Shift 区间从最近一次点击算起）
    void maybeHint("multi"); // round64：第一次真的多选起来 → 教学提示
    return;
  }
  const ids = selection.ids.filter((x) => x !== id);
  selection.ids = ids;
  if (ids.length === 0) {
    selection.blockId = null;
    clearBlockPreview();
    return;
  }
  if (selection.blockId === id) selection.blockId = ids[ids.length - 1];
}

/** `Shift+左键`：把「**从锚点到目标那一整段**」里的块全部选中。
 *
 * round61.1（你验收实测）：旧口径按「开始时间排序取下标区间」—— 一块**早于**锚点、
 * 但和锚点数段**交叠**的块会落选（现场：锚点是那条长块 09:15–19:00，目标是最下面那块，
 * 左上角 09:00–10:30 的块没选上）。改成**交叠带**：
 * 带 = [min(锚点.起点, 目标.起点), max(锚点.终点, 目标.终点)]，凡与这条带相交的块都选中。
 * 一句人话：「从你上次点的那块到这次点的这块之间、时间上搭得上那条带的，全选」。
 * 锚点保持不动（连续 Shift+点 = 始终从它量起）。 */
export function selectRangeTo(id: string): void {
  // round64（C10）：多选开关关掉 → Shift+点 退化成单选
  if (!featureOn("multi_select_enabled")) {
    selectBlock(id);
    return;
  }
  const anchorId = selection.blockId;
  if (!anchorId || anchorId === id) {
    selectBlock(id);
    return;
  }
  const anchor = blocks.find((b) => b.id === anchorId);
  const target = blocks.find((b) => b.id === id);
  if (!anchor || !target) {
    selectBlock(id);
    return;
  }
  const lo = Math.min(anchor.start_at, target.start_at);
  const hi = Math.max(anchor.end_at, target.end_at);
  const ids = orderedBlocks()
    .filter((b) => b.end_at > lo && b.start_at < hi)
    .map((b) => b.id);
  // 锚点 / 目标自己的时段必然与带相交；仍保底去重
  const set = new Set(ids);
  set.add(anchor.id);
  set.add(target.id);
  cancelGrab();
  selection.ids = [...set];
  void maybeHint("multi");
}

/** `Ctrl+A`：全选本周所有块（去重：存储里理论上 id 唯一，但**选中列表永远不带重复**） */
export function selectAllWeek(): void {
  // round64（C10）：多选开关关掉 → Ctrl+A 不生效
  if (!featureOn("multi_select_enabled")) return;
  const ordered = orderedBlocks();
  if (ordered.length === 0) return;
  void note("select_all"); // round68（19.1）：暗章信号
  cancelGrab();
  selection.ids = [...new Set(ordered.map((b) => b.id))];
  if (!selection.blockId || !selection.ids.includes(selection.blockId)) {
    selection.blockId = selection.ids[0];
  }
}

/** 框选落定（Timeline 调）：一次给出一批（调用方已按时间排好）；第一块当锚点 */
export function selectMany(ids: string[]): void {
  const known = ids.filter((id) => blocks.some((b) => b.id === id));
  if (known.length === 0) {
    clearSelection();
    return;
  }
  cancelGrab();
  selection.ids = known;
  selection.blockId = known[0];
  void maybeHint("multi");
}

/** 多选 → 只留锚点（`Esc` 的第一层）；只有一块就直接清空 */
export function collapseToAnchor(): void {
  const anchor = selection.blockId;
  if (!anchor || selection.ids.length <= 1) {
    clearSelection();
    return;
  }
  cancelGrab();
  selection.ids = [anchor];
}

export function clearSelection(): void {
  endFollow();
  selection.blockId = null;
  selection.ids = [];
  selection.grabbed = false;
  clearBlockPreview();
  clearGroupPreview();
}

/** 放弃抓起（保持选中）：预览回原位，库里从没动过。
 *  round61.1：组预览也在这里一起清（多选拿起走同一套入口）。
 *  round69（B3）：跟鼠标手势的监听器也要在这里收（否则 Esc 后鼠标还拖着幽灵）。 */
export function cancelGrab(): void {
  endFollow();
  selection.grabbed = false;
  clearBlockPreview();
  clearGroupPreview();
}

/** 时刻 → 它所在那一列的列起点（辅助线胶囊按它定位） */
const anchorOf = (ts: number) => getSlotStartSec(new Date(ts * 1000), 0);

/** 报一次「跟随这条边」；出界就翻到它那一周。
 *
 * `mode` 决定「周界算不算出界」（边界语义不同）：
 * - 起点 / 移动：起点 **>= 周末** 就属于下一周（与判周口径一致）→ 翻；
 * - 终点（拉下边缘）：**正好拉到周末（00:00）不算翻** —— 那一瞬间它还在本周（`end > from` 才在下一周显示），
 *   翻了反而会「块看不见」（round31 实测：拉到 00:00 就翻周 → 块整个留在上一周 ✗）。
 */
function requestFollow(at: number, mode: "start" | "end" = "start"): void {
  // round34（用户实测「跨天块把终点缩到次日 00:00，相机还停在下一列的 00:00」）：
  // 终点是**开区间**的 —— 贴着日界/周界时，它的“位置”是**上一瞬**（前一日 23:59:59）。
  // 相机跟随与目标周都用这个值算：① 同一周内跨天 → 相机落在**前一列的底**（不是下一列的顶）；
  // ② 跨周（含「跨周又跨天」）→ 翻到上一瞬所在的那一周。
  const where = mode === "end" ? at - 1 : at;
  follow.at = where;
  follow.seq++;
  const outside =
    mode === "end"
      ? at <= week.from || at > week.to
      : at < week.from || at >= week.to;
  if (outside) goToWeekOf(where);
}

function previewRangeTo(b: Block, start: number, end: number): void {
  setBlockPreview(b.id, start, end, anchorOf(start), b, true);
}

/* ------------------------------------------------------------------ *
 * 连按累积（B28）：同一批里多个按键合成**一次**落库；正在落库时来了新的，
 * 排到它后面再落一次 —— 既不丢按键，也不把 IPC 打爆。
 * ------------------------------------------------------------------ */
type Delta = { startMinutes: number; endMinutes: number };

let pending: Delta | null = null;
let chain: Promise<void> = Promise.resolve();

function mergeDelta(patch: Partial<Delta>): void {
  pending ??= { startMinutes: 0, endMinutes: 0 };
  pending.startMinutes += patch.startMinutes ?? 0;
  pending.endMinutes += patch.endMinutes ?? 0;
}

function enqueue(patch: Partial<Delta>): Promise<void> {
  mergeDelta(patch);
  chain = chain.then(async () => {
    const d = pending;
    pending = null;
    if (!d) return;
    try {
      await applyDelta(d);
    } catch {
      // ipc 层已经弹过 Toast（序列拒绝 / 越界 / 块没了）
    }
  });
  return chain;
}

async function applyDelta(d: Delta): Promise<void> {
  const b = findSelected();
  if (!b) return;
  // B19：已标记的块与拖动一致 —— 不能移动、不能拉伸（Delete 仍可，走 deleteSelected）
  if (b.status !== "planned") return;

  // —— 拉伸（动一条边）——
  // round61.1：**移动不再走这里**了 —— 左/右位移统一收进拿起模式（预览 → 落地一次写），
  // 未拿起时 resolveKey 已经不会产出 move 动作。
  const edge: "start" | "end" = d.endMinutes !== 0 ? "end" : "start";
  const { startAt, endAt } = clampRange(
    b.start_at + d.startMinutes * 60,
    b.end_at + d.endMinutes * 60,
    edge,
  );
  if (startAt === b.start_at && endAt === b.end_at) return;
  await stretchBlock(b.id, startAt, endAt);
  requestFollow(edge === "start" ? startAt : endAt, edge);
}

/**
 * 键盘动作的总入口（组件只负责拦截按键、`preventDefault`、把动作交进来）。
 *
 * 抓起中只认方向键 / Enter / Esc（B27）：Delete、Space、X、拉伸键一律忽略 ——
 * 抓起的同一时刻只做一件事，且提示条会写清楚。
 */
export async function handleKeyAction(action: KeyAction): Promise<void> {
  // round69（B3）：跟鼠标手势（Ctrl+X / Ctrl+C）的 Enter / Esc —— 收尾走**统一的那一处**
  // （方向键照旧落到下面的「拿起中」分支，只改预览）。
  if (selection.followMode && (action.type === "drop" || action.type === "cancel")) {
    if (action.type === "drop") await finishFollowPlacement();
    else cancelGrab(); // 放弃：不动库、保持选中
    return;
  }
  // round61.1（你拍板）：**移动统一收进拿起** —— 多选态分两层：
  // ① 拿起中（Enter 后）：方向键/鼠标拖都只改**组预览**，Enter 落地才一次批量写；
  // ② 未拿起：只能做动作（完成/删除）与选择，**不能移动**（移动请先按 Enter 拿起）。
  const multi = selection.ids.length > 1;
  // round69（B3）：跟鼠标手势即使只选一块也走「组预览」那条 —— 单块那条路只更新
  // `blockPreview`，落地读的是 `groupPreview`，会读到旧位置 ✗
  if ((multi || selection.followMode) && selection.grabbed) {
    switch (action.type) {
      case "drop":
        await dropGroupGrab();
        return;
      case "cancel":
        cancelGrab(); // 放弃拿起（保持选中，与单块同一口径）
        return;
      case "move":
        shiftGroupBy(action.kind, action.dir);
        return;
      default:
        return; // 拿起中不做别的（B27 同口径）
    }
  }
  if (multi) {
    switch (action.type) {
      case "grab":
        void note("kbd_grab"); // round68（19.1）：第一次用 Enter 拿起
        beginGroupGrab();
        return;
      case "delete":
        await deleteSelectedMany();
        return;
      case "done":
        await markSelectedMany("done");
        return;
      case "missed":
        await markSelectedMany("missed");
        return;
      default:
        return; // 未拿起不能移动；拉伸/落下在多选无意义
    }
  }

  const grabbed = grabbedTarget();
  const b = grabbed?.block ?? findSelected();
  if (!b && action.type !== "cancel") {
    reconcileSelection();
    return;
  }

  switch (action.type) {
    case "cancel":
      if (selection.grabbed) cancelGrab();
      else clearSelection();
      return;

    case "grab": {
      void note("kbd_grab"); // round68（19.1）：第一次用 Enter 拿起
      if (!b || selection.grabbed || b.status !== "planned") return;
      selection.grabbed = true;
      previewRangeTo(b, b.start_at, b.end_at); // 原地预览：辅助线立刻出来
      requestFollow(b.start_at);
      return;
    }

    case "drop": {
      // round32：以**预览/快照**为准（块可能已被预览到别的周，不在本周数据里）
      if (!grabbed) return;
      const { block, start } = grabbed;
      const id = block.id;
      selection.grabbed = false;
      clearBlockPreview();
      if (start === block.start_at) return; // 没挪 → 什么都不写
      try {
        const outcome = await moveBlock(id, start);
        requestFollow(outcome?.block?.start_at ?? start);
      } catch {
        // ipc 层已弹 Toast（序列顺序拒绝 / 越界 / 块没了）—— 不假成功、不留半个状态
      }
      reconcileSelection();
      return;
    }

    case "move": {
      // round61.1：**未拿起不能搬动**（移动统一收进拿起：Enter → 方向键移动预览 → Enter 落地）。
      // resolveKey 已经不会在未拿起时产出 move；这里再挡一道（store 层是规则的最终住所）。
      if (!selection.grabbed) return;
      if (!grabbed) return;
      const next = moveStartBy(grabbed.start, action.kind, action.dir);
      const span = grabbed.end - grabbed.start;
      previewRangeTo(grabbed.block, next, next + span);
      // round61.2（你验收）：与多选同一套 —— 往下/往右跟**终点**（看得见下边缘）、往上/往左跟**起点**
      if (action.dir > 0) requestFollow(next + span, "end");
      else requestFollow(next, "start");
      return;
    }

    case "stretch": {
      if (selection.grabbed) return; // 抓起中只移动（B27）
      const minutes = 15 * action.dir;
      await enqueue(action.edge === "start" ? { startMinutes: minutes } : { endMinutes: minutes });
      return;
    }

    case "delete":
      if (selection.grabbed) return;
      await deleteSelected();
      return;

    case "done":
      if (selection.grabbed || !b || b.status !== "planned") return;
      await markDone(b.id).catch(() => {});
      return;

    case "missed":
      if (selection.grabbed || !b || b.status !== "planned") return;
      await markMissed(b.id).catch(() => {});
      // 与点 ✗ 一样：弹漂流卡问要不要换个时段（round64：漂流开关关掉就不自动弹）
      if (featureOn("drift_enabled")) openDrift(b.id);
      return;
  }
}

/** `Delete`：复用 removeBlock（二次确认 + 级联删除 + Ctrl+Z 可撤） */
export async function deleteSelected(): Promise<void> {
  const b = findSelected();
  if (!b) {
    reconcileSelection();
    return;
  }
  const id = b.id;
  try {
    await removeBlock(id);
  } catch {
    // ipc 层已弹 Toast
  }
  // 确认框取消 = 块还在 → 选中不动（别把「点了取消」当成删了）；
  // round61：真删了就把选中收口（blockId 与 ids 一起走同一套清理）
  reconcileSelection();
}

/* ------------------------------------------------------------------ *
 * round61（10.2 多选）：批量动作的**总入口**（动作条 / 键盘共用）——
 * 每条只做「凑参数 → 调 blocks 的批量写路径 → 说一句话」，写库语义全在那一层。
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * round61.1（你拍板）：多选「拿起」—— `Enter` 拿起整组 → 鼠标拖拽与方向键
 * 都只改**组预览**（不写库）→ `Enter` 落地才一次批量写（一步撤销）。
 * 辅助线**只跟锚点**（成员只画移动后的绿框）—— 不画 N 条线。
 * ------------------------------------------------------------------ */

/** 拿起整组（Enter）：把**计划中**的成员拉进组预览；已标记的不参与（与批量挪动同口径） */
function beginGroupGrab(): void {
  const planned = selection.ids.filter(
    (id) => blocks.find((b) => b.id === id)?.status === "planned",
  );
  if (planned.length === 0) {
    toast(t("msg.selection.01"));
    return;
  }
  beginGroupPreview(planned, selection.blockId);
  selection.grabbed = true;
  const a = groupPreview.anchorId ? groupPreview.ranges[groupPreview.anchorId] : null;
  if (a) requestFollow(a.start); // 原地：辅助线立刻出来（与单块拿起一致）
}

/** 组预览的边界：最早起点 / 最晚终点 —— 跟随按**移动方向的领先边**取（round61.2 你验收） */
function groupLeadingEdge(): { lo: number; hi: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of Object.values(groupPreview.ranges)) {
    if (r.start < lo) lo = r.start;
    if (r.end > hi) hi = r.end;
  }
  return Number.isFinite(lo) ? { lo, hi } : null;
}

/**
 * 报一次「组跟随」：`dir > 0` 跟组的**最晚终点**（end 口径）、`dir < 0` 跟**最早起点**。
 *
 * round61.2（你报图2）：旧版永远跟**锚点起点** —— 组里比锚点更早/更晚的块越过视口边、
 * 日界、周界时，跟着锚点根本看不见它（上下跟错边、跨日/跨周不翻）。
 */
function followGroupLeading(dir: 1 | -1): void {
  const edge = groupLeadingEdge();
  if (!edge) return;
  if (dir > 0) requestFollow(edge.hi, "end");
  else requestFollow(edge.lo, "start");
}

/** 拿起中：方向键 → 整组平移（step 15 分 / coarse 1 小时 / day 1 天 / week 1 周，只改预览） */
function shiftGroupBy(kind: "step" | "coarse" | "day" | "week", dir: 1 | -1): void {
  const anchorId = groupPreview.anchorId;
  const a = anchorId ? groupPreview.ranges[anchorId] : null;
  if (!a) return;
  // 天/周用**本地日历**算法（与单块键盘同一套）；整组按锚点的位移一起走，保持相对位置
  const next = moveStartBy(a.start, kind, dir);
  shiftGroupPreview(next - a.start);
  followGroupLeading(dir);
}

/** 落地（Enter）：把组预览里真动过的块一次批量写下去（一条命令 = 一步撤销） */
async function dropGroupGrab(): Promise<void> {
  const moves = groupPreviewMoves();
  // 选中里没进组预览的（= 已标记的块）在提示里写明
  const skipped = selection.ids.filter((id) => !groupPreview.ranges[id]).length;
  selection.grabbed = false;
  clearBlockPreview();
  clearGroupPreview();
  if (moves.length === 0) return;
  try {
    await moveBlocksMany(moves, skipped);
  } catch {
    // ipc 层已弹 Toast
  }
  reconcileSelection();
}

/* ------------------------------------------------------------------ *
 * round69（B3）：`Ctrl+X` / `Ctrl+C` —— 「拿起」的**跟鼠标版**
 *
 * 与 Enter 拿起共用同一套预览（组预览）与落地写路径，只差两点：
 * ① 不用按住、也不用 Enter —— 预览跟住鼠标，**左键放下**（与漂流卡「✎ 自己安排」同一种手感）；
 * ② 落地分两种：`move` = 搬走（`move_blocks`，保留块本身）；`copy` = 复制（`create_blocks`，原块留着）。
 * ------------------------------------------------------------------ */

/** 跟鼠标手势的收尾句柄（键盘落地 / 取消 / 任何清选中都要把它摘掉） */
let followCleanup: (() => void) | null = null;

/** 摘掉跟鼠标手势的监听器（幂等；不动选中与预览 —— 那是 cancelGrab / 落地自己的事） */
function endFollow(): void {
  const cleanup = followCleanup;
  followCleanup = null;
  selection.followMode = null;
  cleanup?.();
}

/**
 * `Ctrl+X`（搬移）/ `Ctrl+C`（复制）：把选中的块送进拿起模式，然后让它们跟住鼠标。
 *
 * 口径（边界表 B1）：
 * - **只带当前窗口里的块** —— 跨周保留的选中里，不在本周数据里的块跟不上（提示里写明）；
 * - `Ctrl+X` 只搬 `planned`（已标记的不参与，与批量挪动同口径）；
 * - `Ctrl+C` 什么状态都能复制，副本一律从 `planned` 开始（不带的属性见 `CopySpec`）。
 */
export function startFollowGesture(mode: "move" | "copy"): void {
  if (link.pendingId) return; // 线头进行中：先收线头（Esc / 点空白）
  if (drag.blockId || drag.taskId) return; // 指针手势进行中：不接
  if (selection.ids.length === 0 && !selection.blockId) return;
  if (selection.grabbed) cancelGrab(); // 已经拿起（含跟鼠标中）→ 换模式重来

  const one = selection.blockId;
  const ids = selection.ids.length > 0 ? selection.ids : one ? [one] : [];
  const inWindow = ids.filter((id) => blocks.some((b) => b.id === id));
  const missing = ids.length - inWindow.length;
  let participants: string[];
  if (mode === "move") {
    participants = inWindow.filter((id) => blocks.find((b) => b.id === id)?.status === "planned");
    const marked = inWindow.length - participants.length;
    if (participants.length === 0) {
      toast(inWindow.length > 0 ? t("msg.selection.02") : t("msg.selection.03"));
      return;
    }
    if (marked > 0) toast(tn("msg.selection.04", marked, { marked: marked }));
  } else {
    participants = inWindow;
    if (participants.length === 0) {
      toast(t("msg.selection.05"));
      return;
    }
  }
  if (missing > 0) toast(tn("msg.selection.06", missing, { missing: missing }));

  const anchor =
    selection.blockId && participants.includes(selection.blockId) ? selection.blockId : participants[0];
  beginGroupPreview(participants, anchor);
  selection.grabbed = true;
  selection.followMode = mode;

  const base = groupPreview.ranges[anchor]?.start ?? 0;
  const anchorSnap = groupPreview.blocks[anchor];
  // round69（B3）/ 6b P2：单块时拖影要**真的看得见** —— 取该块在页面上的尺寸（与漂流卡「自己安排」同一套）。
  // `typeof document`：store 也会在 vitest（Node 环境）里被 import —— 那边没有 DOM，拿 null 走兜底尺寸
  const anchorRect =
    typeof document === "undefined"
      ? null
      : document.querySelector<HTMLElement>(`[data-block-id="${anchor}"]`)?.getBoundingClientRect();
  followCleanup = armPlacement({
    blockId: anchor,
    durationSeconds: anchorSnap ? anchorSnap.end_at - anchorSnap.start_at : 0,
    width: anchorRect?.width ?? 120,
    height: anchorRect?.height ?? 28,
    group: { ids: participants, anchorId: anchor, baseAnchorStart: base },
    onPlace: () => void finishFollowPlacement(),
    onCancel: () => cancelGrab(),
  });
}

/** 复制用的规格：按组预览的顺序给；锚点下标一起报出来（落地后选回对应那一块） */
function copySpecsFromPreview(): { specs: CopySpec[]; anchorIndex: number } {
  const specs: CopySpec[] = [];
  let anchorIndex = 0;
  for (const [id, r] of Object.entries(groupPreview.ranges)) {
    const snap = groupPreview.blocks[id];
    if (!snap) continue;
    if (id === groupPreview.anchorId) anchorIndex = specs.length;
    specs.push({
      task_id: snap.task_id,
      start_at: r.start,
      end_at: r.end,
      layer: snap.layer,
      label: snap.label,
      sanity_exempt: snap.sanity_exempt,
    });
  }
  return { specs, anchorIndex };
}

/** 落地：跟鼠标手势的收尾（鼠标左键与 `Enter` 共用）—— 搬走 或 复制一份 */
async function finishFollowPlacement(): Promise<void> {
  const mode = selection.followMode;
  if (!mode) return;
  const moves = mode === "move" ? groupPreviewMoves() : [];
  const copy = mode === "copy" ? copySpecsFromPreview() : { specs: [], anchorIndex: 0 };

  endFollow();
  selection.grabbed = false;
  clearBlockPreview();
  clearGroupPreview();

  if (mode === "move") {
    if (moves.length === 0) return; // 没挪 → 一行不写（与拿起落地同口径）
    try {
      await moveBlocksMany(moves);
    } catch {
      // ipc 层已弹 Toast
    }
    reconcileSelection();
    return;
  }

  if (copy.specs.length === 0) return;
  try {
    const out = await copyBlocksMany(copy.specs);
    if (out.blocks.length === 0) return;
    // 新块成为选中（锚点对新锚点）——可以马上接着挪 / 再复制。
    // round69.1（D1）：就地融合时返回的是**原来那一块**（id 不换）——照旧选它，能接着操作。
    const idx = Math.min(copy.anchorIndex, out.blocks.length - 1);
    selection.ids = out.blocks.map((b) => b.id);
    selection.blockId = out.blocks[idx]?.id ?? out.blocks[0].id;
  } catch {
    // ipc 层已弹 Toast
    reconcileSelection();
  }
}

/** 多选态下的删除（动作条 / `Delete`）—— 一条命令 = 一步撤销 */export async function deleteSelectedMany(): Promise<void> {
  const ids = [...selection.ids];
  if (ids.length === 0) return;
  try {
    await removeBlocksMany(ids);
  } catch {
    // ipc 层已弹 Toast
  }
  reconcileSelection(); // 删掉的块不在库里了 → 选中收口
}

/** 批量标记（只对 `planned` 的块生效；标 ✗ **不弹漂流卡**） */
export async function markSelectedMany(status: "done" | "missed"): Promise<void> {
  const ids = selection.ids.filter((id) => blocks.find((b) => b.id === id)?.status === "planned");
  if (ids.length === 0) {
    toast(t("msg.selection.07"));
    return;
  }
  try {
    const n = await markBlocksMany(ids, status);
    toast(status === "done" ? t("msg.selection.08", { n: n }) : t("msg.selection.09", { n: n }));
  } catch {
    // ipc 层已弹 Toast
  }
}

/** 批量挪天/挪周（每块各自 ±days）/ 挪时间（`minutes`，↑↓ = 15 分、Shift+↑↓ = 1 小时）
 *  —— 键盘语义，不走拖动；跨周时**视角跟过去**并把选中留住，好让你接着按。 */
export async function moveSelectedMany(days: number, minutes = 0): Promise<void> {
  const picked = selection.ids
    .map((id) => blocks.find((b) => b.id === id))
    .filter((b): b is Block => !!b);
  const planned = picked.filter((b) => b.status === "planned");
  if (planned.length === 0) {
    toast(t("msg.selection.10"));
    return;
  }
  const skipped = picked.length - planned.length;
  const moves = planned.map(
    (b) => [b.id, addLocalDays(b.start_at, days) + minutes * 60] as [string, number],
  );
  try {
    await moveBlocksMany(moves, skipped);
  } catch {
    // ipc 层已弹 Toast
  }
  // round61.1（你验收实测）：挪出本周时**视角跟过去**（与单块键盘移动同一套的 `requestFollow`）——
  // 否则跨周以后块看不见、选中被整周重拉清掉 → 「立即停下来、没法继续操作」。
  // round61.2（你报图2）：与键盘同一套 —— 按挪动方向跟**组的领先边**（往前跟最晚终点、往后跟最早起点）。
  const dir: 1 | -1 = days > 0 || (days === 0 && minutes > 0) ? 1 : -1;
  const shiftStart = (b: Block) => addLocalDays(b.start_at, days) + minutes * 60;
  const shiftEnd = (b: Block) => addLocalDays(b.end_at, days) + minutes * 60;
  if (dir > 0) requestFollow(Math.max(...planned.map(shiftEnd)), "end");
  else requestFollow(Math.min(...planned.map(shiftStart)), "start");
  // 跟着翻周后把新一周拉进来（选中在新窗口里才立得住）
  await reloadWeek();
  // 可能触发融合（吃掉选中的某块）→ 幽灵 id 收口
  reconcileSelection();
}

/** 批量改层（`required` / `elastic`；整批设到同一层） */
export async function setSelectedLayerMany(layer: BlockLayer): Promise<void> {
  const ids = [...selection.ids];
  if (ids.length === 0) return;
  try {
    await setBlocksLayerMany(ids, layer);
  } catch {
    // ipc 层已弹 Toast
  }
  // round61（6b 复核）：改层也会触发融合 → 与挪动同一套收口（幽灵 id 收口）
  reconcileSelection();
}
