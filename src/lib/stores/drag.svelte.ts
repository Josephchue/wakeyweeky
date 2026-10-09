import { tn } from "../i18n/i18n.svelte";
import { autoScrollTo, stopAutoScroll } from "../utils/autoscroll";
import { dwellStop, dwellTick } from "../utils/edge-dwell";
import {
  clearDragDuration,
  createBlock,
  groupPreview,
  moveBlock,
  setDragDuration,
  setGroupPreviewShift,
} from "./blocks.svelte";

/**
 * 手势引擎（round25）：**拖动 = pointer 手势**，不再用原生 HTML5 拖放。
 *
 * 为什么换：用户实测「块拖不到隔壁列，只会留在原来那一列」—— 病根在 Windows/WebView2 宿主上原生
 * DnD 的**拖拽目标不更新**（Tauri issue #2014 维护者原话：「HTML5 drag&drop API is broken (at least on
 * Windows)… the only workaround … is using a library that doesn't rely on this API」；wry #904 / Tauri
 * #14373：Windows 上 wry 自己注册了 `IDropTarget`，`dragDropEnabled` 的真实含义是「**禁用 DOM 拖放**」）。
 * 而同一台机器上 pointer 手势（拉伸）**实测拖到窗口外都跟手** → 拖拽也走它：坐标自己算、落点自己定。
 *
 * 三条铁律（都在 `docs/plans/round25-fixes-and-temp-block.md` §二-A）：
 * ① 落点**只看指针坐标**（`clientX` 就近取列、`clientY` 算时刻），不看事件落在哪个元素；
 * ② 拖动中**不移动 DOM**（只画指示线与辅助线），落库只在松手那一下；
 * ③ 收尾（松手 / Esc / pointercancel / 窗口失焦）一律清状态，不留半个手势。
 */

/** 落点：哪一列 + 吸附后的起点时刻 */
export type DropTarget = { dayStart: number; start: number };

/** 拉伸的二维落点：哪一列（列起点）+ 那一列的哪个时刻（已吸附、已夹在该列之内） */
export type ResizeTarget = { dayStart: number; time: number };

/** 板子（`Timeline`）注册进来的能力：怎么把指针换算成落点、哪个容器要自动滚 */
type DragHost = {
  resolve: (clientX: number, clientY: number) => DropTarget | null;
  resolveResize: (clientX: number, edgeClientY: number) => ResizeTarget | null;
  /**
   * round27 #8：指针是不是甩出了板子的最右/最左边缘（-1 = 左边，1 = 右边，0 = 在板子里）。
   * 停住一小会儿就翻到下一/上一周 —— 用户实测「我没法把块拉到下一周」。
   */
  edgeDwell: (clientX: number) => -1 | 0 | 1;
  flipWeek: (dir: -1 | 1) => void;
  scrollEl: HTMLElement;
};

let host: DragHost | null = null;

/** 时间轴挂载时调用；卸载传 null。落点换算与列宽都在它那边（它才是列的主人） */
export function attachDragHost(next: DragHost | null): void {
  host = next;
}

/** 拉伸用（round26 #4）：把（指针 x，视觉上那条边的 y）换成「哪一列 + 那一列的时刻」 */
export function resolveResizePoint(clientX: number, edgeClientY: number): ResizeTarget | null {
  return host ? host.resolveResize(clientX, edgeClientY) : null;
}


/**
 * round28 #8（用户实测「拉伸还是没法跨周」）：拉伸期间也接上「甩出边缘停住翻周」——
 * TaskBlock 每次 pointermove（与自动滚动的每帧）调它；收尾（cancelResize）调 `dwellStop()`。
 */
export function dwellAtEdge(clientX: number): void {
  dwellTick(clientX, host);
}

/** 拖任务进来时的**兜底**时长（round27 起：有「预估」就用预估，见 Backlog 的 dragMinutes） */
const DEFAULT_DURATION_SECONDS = 30 * 60;
/** 越过这个位移才算「真在拖」（否则点一下、双击都会被当成拖动） */
const THRESHOLD_PX = 4;
/* round28 #8：拖动与拉伸共用同一套「甩出边缘停住 → 翻周」，实现在 `utils/edge-dwell.ts` ——
   以前只在这里写死一份，拉伸用不了（用户实测「拉伸还是没法跨周」）。 */

export const drag = $state<{
  /** 拖的是时间轴上哪个块；没有就是 null */
  blockId: string | null;
  /** 拖的是 Backlog 里哪个任务（新建块）；没有就是 null */
  taskId: string | null;
  /** 指针最后位置（屏幕坐标） */
  pointer: { x: number; y: number };
  /** 当前落点（null = 指针不在板子里 → 松手不移动） */
  drop: DropTarget | null;
  /** 是否已越过起拖阈值 */
  moved: boolean;
  /** round61.1（你验收意见）：拖的是**整个多选组**时，这里是组内**计划中**块的（id, 起点）。
   *  落库时按「锚点位移」给每一块同一 delta —— 批量位置变化终于也能用鼠标拖了。 */
  group: Array<{ id: string; start_at: number }>;
}>({ blockId: null, taskId: null, pointer: { x: 0, y: 0 }, drop: null, moved: false, group: [] });

let pointerId = -1;
let startX = 0;
let startY = 0;
let sourceEl: HTMLElement | null = null;
let ghost: HTMLElement | null = null;
let ghostSize = { w: 0, h: 0 };
let previewMoveMode = false;
/** round61.2：拿起组拖动时，锚点在**按下那一刻**的起点 —— 必须取**组预览快照**（`groupPreview.blocks`），
 *  不是当前预览值：`setGroupPreviewShift` 就是按快照算绝对位移的；用当前预览当基准会把
 *  「键盘先挪过一截」或「同一组再拖一次」的位移吞掉（6b 复核 P1）。 */
let previewBaseAnchorStart = 0;
let durationSeconds = DEFAULT_DURATION_SECONDS;
let detachListeners: (() => void) | null = null;
export function beginPointerDrag(opts: {
  blockId?: string;
  taskId?: string;
  durationSeconds: number;
  width: number;
  height: number;
  event: PointerEvent;
  /** round61.1：多选里按住一块拖 = 搬**整组**；这里是组内计划中的块（含被按的那块） */
  group?: Array<{ id: string; start_at: number }>;
  /** round61.1：拿起的组拖动 = **只改组预览**（不写库；落地交给 Enter） */
  previewMove?: boolean;
}): void {
  if (drag.blockId || drag.taskId) {
    // 自愈（用户实测 #2：手势一旦卡住，「之后所有拖动都失败」）：旧手势没收尾就再来一个 →
    // 把旧的**默默丢掉**（不改数据），新的照常起 —— 绝不因为旧状态残留而拒给新手势。
    finish(false);
  }
  const e = opts.event;
  drag.blockId = opts.blockId ?? null;
  drag.taskId = opts.taskId ?? null;
  drag.group = opts.group ?? [];
  previewMoveMode = opts.previewMove ?? false;
  // 基准 = 快照起点（与 `setGroupPreviewShift` 同一把尺；见 previewBaseAnchorStart 注释）
  previewBaseAnchorStart =
    groupPreview.blocks[opts.blockId ?? ""]?.start_at ?? opts.group?.find((g) => g.id === opts.blockId)?.start_at ?? 0;
  drag.pointer = { x: e.clientX, y: e.clientY };
  drag.drop = null;
  drag.moved = false;
  startX = e.clientX;
  startY = e.clientY;
  pointerId = e.pointerId;
  durationSeconds = opts.durationSeconds;
  ghostSize = { w: opts.width, h: opts.height };
  // C1.7：把「这块多长」报给时间轴 —— 辅助线的终点线靠它（新块按 30 分钟）
  setDragDuration(opts.durationSeconds);

  sourceEl = e.currentTarget as HTMLElement | null;
  // round48（用户实测「BACKLOG 里的任务没法改任务名」的**根因**）：
  // **别在 pointerdown 就捕获指针** —— 捕获期间浏览器把 `click/dblclick` 也发给**捕获元素**，
  // 于是挂在子元素（任务名那个 span）上的双击处理函数永远收不到 ✗。
  // 改成**真的开始拖了才捕获**（见下面 onMove 里跨过阈值那一刻）：拖出窗口照样收得到 pointermove。

  // 用户实测 #2（截图里卡片/× 被选中、拖拽直接失败）：按下时浏览器可能开始「选文本」→
  // 顺手发起**原生拖拽**，而原生拖拽一来 pointerup 就收不到了 → 手势卡死，之后所有拖动都失败。
  // 两条防线：① 起手势前清掉已有选区（卡片自己还有 `user-select: none`）；
  // ② 手势中真看到 `dragstart` → 当场取消手势（不落库），别留着半截状态。
  window.getSelection()?.removeAllRanges();

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    drag.pointer = { x: ev.clientX, y: ev.clientY };
    if (!drag.moved) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD_PX) return;
      drag.moved = true;
      // 到这一刻才捕获（拖动已经成立，不再需要保留点击语义）；合成事件会抛，吞掉即可
      try {
        sourceEl?.setPointerCapture(pointerId);
      } catch {
        /* 合成手势 / 无活跃指针 */
      }
      makeGhost();
    }
    moveGhost();
    updateDrop();
    // round61.2（你报图6）：拿起的组拖动 = 预览**逐帧**跟手（位移相对按下那一刻的锚点，来回拖也不攒假值）
    if (previewMoveMode && drag.drop) {
      setGroupPreviewShift(drag.drop.start - previewBaseAnchorStart);
    }
    dwellTick(ev.clientX, host); // round27 #8 / round28 #8：甩出边缘停一下就翻周（拖动与拉伸同一套）
    if (host) autoScrollTo(host.scrollEl, () => drag.pointer, updateDrop);
  };
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) finish(true, ev.clientX, ev.clientY);
  };
  const onCancel = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) finish(false);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") finish(false);
  };
  const onBlur = () => finish(false);
  const onNativeDrag = (ev: DragEvent) => {
    ev.preventDefault();
    finish(false);
  };

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onBlur);
  window.addEventListener("dragstart", onNativeDrag, true);

  detachListeners = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("dragstart", onNativeDrag, true);
  };
}

/** 滚动（自动滚动 / 滚轮）之后重量落点 —— 内容动了，指针下面的时刻就变了 */
export function refreshDragDrop(): void {
  if (drag.blockId || drag.taskId) updateDrop();
}

function updateDrop(): void {
  drag.drop = host ? host.resolve(drag.pointer.x, drag.pointer.y) : null;
}

function finish(commit: boolean, releaseX?: number, releaseY?: number): void {
  if (!drag.blockId && !drag.taskId) return;
  // 落点以**松手那一刻的指针**为准（不是最后一次 pointermove）——
  // 拖到一半又把指针移出板子再松手时，旧值会把块扔到一个用户已经放弃的位置上。
  if (commit && releaseX != null && releaseY != null) {
    drag.pointer = { x: releaseX, y: releaseY };
    updateDrop();
  }
  const { blockId, taskId, drop, moved } = drag;
  const seconds = durationSeconds;

  detachListeners?.();
  detachListeners = null;
  stopAutoScroll();
  dwellStop();
  releaseGhost();
  try {
    if (sourceEl) sourceEl.releasePointerCapture(pointerId);
  } catch {
    /* 已经不在捕获状态 */
  }
  sourceEl = null;
  clearDragDuration();
  drag.blockId = null;
  drag.taskId = null;
  drag.drop = null;
  drag.moved = false;
  drag.group = [];
  const previewMove = previewMoveMode;
  previewMoveMode = false;

  // 没动过（只是点了一下）或落点在板子外 → 什么都不做，块原地不动
  if (!commit || !moved || !drop) return;
  if (blockId) {
    if (previewMove) {
      // round61.1：拿起的组拖动 = 只改**组预览**（不写库）
      // round61.2：拖动中已经逐帧跟手（见 onMove），这里按**松手那一刻的落点**再对齐一次（幂等）
      setGroupPreviewShift(drop.start - previewBaseAnchorStart);
    } else {
      void moveBlock(blockId, drop.start).catch(() => {});
    }
  } else if (taskId) {
    void createBlock(taskId, drop.start, drop.start + seconds).catch(() => {});
  }
}

/**
 * round49：漂流卡的「**自己安排**」——预览块（拖影）挂在鼠标上跟着走，**左键点一下**放下
 * （用户 2026-10-03 原话：「按住拖着变成左键放下那种」）。落点换算、辅助线、提示条**全复用**拖动那套。
 *
 * 与拖动只差一点：**不用按住**。所以这里自己装一套 window 监听，并且**先动一下**才认「放下」那次按下 ——
 * 否则弹出漂流卡的那一次点击会立刻把块放下。
 * 点在没有落点的地方（Backlog / 面板空白）= 什么都不做，**继续跟着**（不退出这个模式）。
 *
 * round69（B3）：同一个手势扩展成**组**（四处复制 / 剪切）：
 * - 传 `group` → 逐帧改组预览（`setGroupPreviewShift`）、多块时带「N 块」角标；
 * - `onCancel`：Esc / 失焦除了收手势，还要通知调用方（清预览 / 放弃拿起）；有它时 Esc 会
 *   `stopPropagation`（不让 Timeline 的 Esc 顺手把选中也清了 —— 那是单块拿起的老口径）；
 * - 返回一个**收尾函数**：键盘落地（Enter）走的是 store 那条路，调用方要自己把它调掉，
 *   否则监听器与拖影会留在页面上。
 */
export function armPlacement(opts: {
  blockId: string;
  durationSeconds: number;
  width: number;
  height: number;
  onPlace: (startAt: number) => void;
  /** round69（B3）：组跟鼠标（复制 / 剪切）*/
  group?: { ids: string[]; anchorId: string; baseAnchorStart: number };
  /** round69（B3）：Esc / 失焦的收尾通知（清预览、取消拿起）*/
  onCancel?: () => void;
}): () => void {
  finish(false); // 清掉别的半截手势（人可能正好在拖东西）
  drag.blockId = opts.blockId;
  drag.taskId = null;
  drag.pointer = { x: -1, y: -1 };
  drag.drop = null;
  drag.moved = true; // 让「拖动中」那套视觉（提示条 / 辅助线）出来
  durationSeconds = opts.durationSeconds;
  ghostSize = { w: opts.width, h: opts.height };
  setDragDuration(opts.durationSeconds);
  const group = opts.group ?? null;
  if (group) {
    // `drag.group` 只用来数「N 块」角标 —— 从组预览快照里取（与拖动那条路同一个结构）
    drag.group = Object.entries(groupPreview.blocks).map(([id, b]) => ({
      id,
      start_at: b.start_at,
    }));
    // 单块用普通拖影；多块才用「N 块」角标（与拖动那条路同一个视觉约定）
    previewMoveMode = group.ids.length > 1;
  }

  let movedOnce = false;

  /** 落点变了就按**绝对位移**重算组预览（幂等；与拖动那条路的 `setGroupPreviewShift` 同一口径）*/
  const applyPreview = () => {
    if (group && drag.drop) setGroupPreviewShift(drag.drop.start - group.baseAnchorStart);
  };

  const onMove = (ev: PointerEvent) => {
    movedOnce = true;
    drag.pointer = { x: ev.clientX, y: ev.clientY };
    makeGhost();
    moveGhost();
    updateDrop();
    applyPreview();
    dwellTick(ev.clientX, host); // round51（BP）：「自己安排」与拖动/拉伸同一套 —— 停在边缘 0.6s 就翻周
    if (host) {
      autoScrollTo(host.scrollEl, () => drag.pointer, () => {
        updateDrop();
        applyPreview(); // 自动滚屏时内容在动，预览也要跟着重算（别等下一次 pointermove）
      });
    }
  };
  const onDown = (ev: PointerEvent) => {
    if (ev.button !== 0 || !movedOnce) return;
    const start = drag.drop && drag.drop.start;
    if (start == null) return; // 没落在板子上：忽略这次点击，继续跟着鼠标
    ev.preventDefault();
    ev.stopPropagation();
    detach();
    finish(false);
    opts.onPlace(start);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      if (opts.onCancel) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      detach();
      finish(false);
      opts.onCancel?.();
    }
  };
  const onBlur = () => {
    detach();
    finish(false);
    opts.onCancel?.();
  };
  const detach = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
  };
  // 让 `finish()` 的常规收尾也能把它收掉（Esc / 失焦走上面，别的路径走这条）
  detachListeners = () => {
    detach();
    detachListeners = null;
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onBlur);

  // round69（B3）：键盘落地（Enter）走的是 store 那条路 —— 调用方用这个句柄把监听器与拖影收掉
  return () => {
    detach();
    finish(false);
  };
}

function makeGhost(): void {
  if (ghost) return;
  if (previewMoveMode) {
    // round61.2（你验收图6）：拿起的组拖动不画「按住那块」的单块拖影 —— 预览本身就逐帧跟手；
    // 只在鼠标旁挂一个「N 块」小角标（深色字；照 Atlassian 多选拖拽指南的数量角标，白字不用）。
    ghost = document.createElement("div");
    ghost.className = "drag-count";
    ghost.textContent = tn("msg.drag.01", drag.group.length, { length: drag.group.length });
    ghost.style.cssText =
      "position:fixed;left:0;top:0;padding:2px 8px;border-radius:999px;" +
      "background:var(--card,#fff);border:1px solid var(--accent,#00695c);" +
      "color:var(--text-primary,#16191d);font:700 12px/1.5 inherit;" +
      "pointer-events:none;z-index:9999;box-shadow:0 1px 4px rgb(0 0 0 / 18%)";
    document.body.appendChild(ghost);
    return;
  }
  // 拖影左上角贴着鼠标尖端 → 「看到哪就落哪」（落点换算也是「把块起点放在指针上」）
  ghost = document.createElement("div");
  ghost.style.cssText =
    `position:fixed;left:0;top:0;width:${ghostSize.w}px;height:${ghostSize.h}px;` +
    "border-radius:4px;background:var(--accent);opacity:.85;pointer-events:none;z-index:9999";
  document.body.appendChild(ghost);
}

function moveGhost(): void {
  if (!ghost) return;
  // 角标挨着指针右下角（别盖住落点）；单块拖影仍贴着指针尖端
  const off = ghost.classList.contains("drag-count") ? 12 : 0;
  ghost.style.left = `${drag.pointer.x + off}px`;
  ghost.style.top = `${drag.pointer.y + off}px`;
}

function releaseGhost(): void {
  ghost?.remove();
  ghost = null;
}
