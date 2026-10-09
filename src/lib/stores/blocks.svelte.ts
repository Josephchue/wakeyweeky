import { t, tn } from "../i18n/i18n.svelte";
import {
  createTempBlock as ipcCreateTempBlock,
  createBlocks as ipcCreateBlocks,
  mergePendingBlocks,
  createBlock as ipcCreateBlock,
  deleteBlock,
  deleteBlocks as ipcDeleteBlocks,
  listBlocks,
  markBlockDone,
  markBlockMissed,
  markBlocks as ipcMarkBlocks,
  moveBlocks as ipcMoveBlocks,
  postponeBlock as ipcPostponeBlock,
  setBlockExempt,
  setBlocksLayer as ipcSetBlocksLayer,
  updateBlock,
} from "../ipc/blocks";
import type { BatchOutcome, Block, BlockLayer, CopyOutcome, CopySpec, MoveOutcome } from "../ipc/types";
import { generateRepeats as ipcGenerateRepeats } from "../ipc/repeats";
import { week } from "./week.svelte";
import { selection, startEditing, stopEditing, toast, toastUndo } from "./ui.svelte";
import { loadSanity } from "./sanity.svelte";

export const blocks = $state<Block[]>([]);

/**
 * round31（C1.9）：**当前已加载的是哪一周**（`loadBlocks` 真的写进 store 时才更新）。
 * 用途：翻周那一刻 `week` 已经变了、`blocks` 还是上一周的数据 —— 这时不能判定「选中的块没了」（会把选中误清 ✗）。
 */
export const loadedWindow = $state<{ from: number; to: number }>({ from: 0, to: 0 });

/**
 * 防竞态（round29 #6）：每个请求一个单调递增的号。
 *
 * 为什么不能只看窗口：同一个窗口会发两次加载（翻周时一次、落库后的 reloadWeek 一次）——
 * 先发的那份是**写入之前**的快照，它偏偏晚回来时，旧代码只看「窗口对不对」→ 照写 ✗，
 * 屏幕上的块当场消失（用户原话：「需要我重新翻过去再翻回来才会渲染回来」）。
 *
 * 为什么不改成「谁最后发起谁赢」（0.6.37 实测踩过 ✗）：更晚发起的那次可能**失败**，
 * 那时它根本没写进来，先前那份正确的数据必须留住 ✓ —— 所以只有「真的写进 store 过」才占位。
 */
let loadSeq = 0;
let lastWrittenSeq = 0;
export async function loadBlocks(from: number, to: number) {
  const seq = ++loadSeq;
  const data = await listBlocks(from, to);
  // 防竞态：只写入**与当前正在看的那一周一致**的响应。
  // 依据必须是**窗口**，不能是"谁最后发起"✗ —— 用请求顺序判断时，只要有一个更晚发起的加载
  // 失败/挂着不走，先前那份**正确**的数据就被作废了：用户实测「跳到第二周看不到块，
  // 拖一个块进去突然就闪出来」（拖动触发的重拉才让数据落进列表）。
  if (from !== week.from || to !== week.to) {
    return; // 这一份不是当前视图要的 → 丢弃
  }
  // 窗口对，但还是旧的（更晚发起的那次已经写进去了）→ 丢（round29 #6，见上面的注释）
  if (seq < lastWrittenSeq) return;
  blocks.length = 0;
  blocks.push(...data);
  lastWrittenSeq = seq;
  loadedWindow.from = from;
  loadedWindow.to = to;
  // 数据整批换掉了（跳周/重拉）→ 任何残留的拉伸预览都该作废（否则它会去覆盖一个已不存在的块）
  // round31（C1.9）：键盘**抓起**的预览例外 —— 抓起就是「一边预览一边挪到别的周」，
  // 翻周重拉正是它要的（块不在新一周数据里时，靠预览快照照样画得出来，round29 #5）。
  if (!blockPreview.grabbed) clearBlockPreview();
  // round28 #8：这里**不再**清 `dragDuration` —— 翻周会走这条路，而拖动还在继续，
  // 清了它辅助线的终点线就回落成 30 分钟（用户会盯着那条线看）。真正的收尾在 finish() 里清。
}

export async function reloadWeek(opts: { maintenance?: boolean } = {}) {
  // 关键：**先把块拉到**，再去整理（整理失败绝不能连累"这一周看不到东西" ✗）。
  // 每一步各自 try/catch 并把错误**打到控制台**，任何失败都要看得见，不许静默空白。
  try {
    // C1.3：拉**正在看的那一周**（跳周后不一定是「现在」）
    await loadBlocks(week.from, week.to);
  } catch (err) {
    console.error("[blocks] 拉取这一周的块失败", err);
    throw err;
  }
  // round69.1（#2）：`maintenance: false` = **不跑开周维护**（补每周重复 + 扫融合）。
  // 谁用：撤销 / 重做（`history.svelte.ts::sync`）—— 撤销 = 回到当时的样子；
  // 维护是「打开这一周」时的动作，跟着撤销跑就会把撤销结果当场改回去（用户实测：
  // Ctrl+Z 永远只剩「已撤销：整理重复块与序列」与「已合并 N 处」交替）。
  if (opts.maintenance !== false) {
    // round69（B3）：把这一周该有的重复块补上（后端记水位线，幂等；开关关着时后端直接返回 0）。
    // 它可能新建块 → 有新建就再拉一次；失败只记日志（与下面的整理同一条口径，不连累显示）。
    try {
      const created = await ipcGenerateRepeats(week.from);
      if (created > 0) await loadBlocks(week.from, week.to);
    } catch (err) {
      console.error("[blocks] 每周重复生成失败（不影响这一周显示）", err);
    }
    // C1.2 补漏：把库里**早就存在**的重复块合掉 + C3 修序列环位。
    // 它走的是写命令，可能慢/可能失败 —— 放最后，且失败只记日志（下次加载还会再试）。
    try {
      const msg = await mergePendingBlocks();
      if (msg) toast(msg);
    } catch (err) {
      console.error("[blocks] 加载时整理失败（不影响这一周显示）", err);
    }
  }
  // C6（round44）：顺手拉一次这一周的耗能（放在整理**之后** —— 融合会改块）。
  // `loadSanity` 自己兑错（只记日志），不会把「看不到块」这种大事连坐进来。
  await loadSanity();
}

/**
 * round31（C1.9，用户 2026-10-02 拍板）：**这次操作融合吃掉了别的块** → 弹一句。
 *
 * 「合没合」由**后端**给（`MoveOutcome.merged` / `CreateOutcome.merged`）——
 * 不在前端靠「写前写后 id 差集」猜：键盘把块挪到下周、级联顺延把块推出本周时，
 * 本周窗口里的 id 本来就会少，差集会把「挪走了」误报成「融合了」（实现时实测到这条 ✗）。
 */
function toastIfMerged(merged: boolean) {
  // round48（用户 2026-10-03 截图：「括号里面的东西很多余啊」）：**只报做了什么**，
  // 不再缀「（Ctrl+Z 可撤销）」——那是 round41 就定过的口径（界面上本来就有撤销按钮）。
  if (merged) toast(t("msg.blocks.04"));
}

/**
 * round33 #1（用户实测「合并会导致取消选中」）：写完 + 整周重拉之后，如果**当前选中的块**在库里没了
 * （它就是这次融合被吃掉的那块），把选中转到这次的幸存块 —— 不然拖/拉/键盘做完就「没选中了」。
 *
 * 为什么放这一层：鼠标拖动、鼠标拉伸、键盘移动/拉伸、切层、漂流确认都会经过这几个写函数 ——
 * 一处管住，就别再在每个调用点各写一遍（round32 就是漏在「键盘拉伸」那一条上）。
 */
function adoptSurvivorAfterWrite(survivor: Block | null | undefined): void {
  const id = selection.blockId;
  if (!id || !survivor || survivor.id === id) return;
  if (blocks.some((b) => b.id === id)) return; // 它还在（不是这次被吃掉的）→ 不动
  selection.blockId = survivor.id;
  // round61：选中列表（多选）也要跟着 —— 旧 id 换成幸存者，不留幽灵
  selection.ids = [...new Set(selection.ids.map((x) => (x === id ? survivor.id : x)))];
}

export async function createBlock(taskId: string, startAt: number, endAt: number) {
  // C1.2（用户实测第三次才修全）：后端可能把**刚建的这一块**融合进旁边那块 ——
  // 此时返回的是**幸存块**，而被吃掉的那一行还在 store 里 ✗。只 upsert 幸存块不够（界面上照样两块，
  // 用户「我只放了两个块，放完就截图」看到的就是这个）。
  // 结论：会动数据的落库路径**一律整周重拉**，不要相信"我只新建了一块"。
  const out = await ipcCreateBlock(taskId, startAt, endAt);
  await reloadWeek();
  toastIfMerged(out.merged);
  adoptSurvivorAfterWrite(out.block);
  return out.block;
}

/**
 * C1.8（R33）：双击空白格 → 建一个临时安排块（不登记在 Backlog）。
 * 与 createBlock 同一条铁律（规矩 23）：会动数据的落库调用一律**整周重拉**，别按 id upsert 猜。
 */
export async function createTempBlock(startAt: number, endAt: number) {
  const out = await ipcCreateTempBlock(startAt, endAt);
  // round80（79-03）：**改名态先于重拉置上** —— reloadWeek 里多条 await（补重复 / 扫融合 / 理智值）
  // 会把「块已进 store、还没 startEditing」的缝隙撑到几十~几百 ms；鼠标正停在格子上时，
  // 块的第一帧会按「非改名态」渲染 → 动作浮层闪一下（round79 §10.3 的那一帧）。
  // 在 reloadWeek **之前**置上 → 块第一次进 store 时 `editingName` 就是真 → 从不渲染动作区。
  startEditing(out.block.id);
  try {
    await reloadWeek();
  } catch (err) {
    stopEditing(); // 重拉失败：别留一个指向不存在块的「改名态」
    throw err;
  }
  toastIfMerged(out.merged);
  adoptSurvivorAfterWrite(out.block);
  return out.block;
}

/** C1.8（R33）：给临时块改名（空串 = 清回默认名「临时安排」） */
export async function renameBlock(id: string, label: string) {
  const out = await updateBlock(id, { label });
  await reloadWeek();
  toastIfMerged(out.merged);
  adoptSurvivorAfterWrite(out.block);
}

/**
 * round49：**临时安排块**自己的「不计入理智值」开关（普通块没有这个键，它们看任务那一行）。
 * 只改一列，但按规矩 23 仍然**整周重拉** —— 顺带让日头小条跟着变（`reloadWeek()` 尾巴上会拉一次曲线）。
 */
export async function setExempt(id: string, exempt: boolean) {
  await setBlockExempt(id, exempt);
  await reloadWeek();
}

/**
 * 标记完成 / 未完成（用户实测 #11）：后端可能改别的行 → 一律整周重拉。
 * 旧写法 `replaceBlock(id, 返回的那块)` 会把被融合掉的邻居留成**幻影行**（`docs/对账.md` §5-U）。
 * （real 后端这条路径不融合 —— `set_block_status` 只改 status —— 所以没有融合提示可弹）
 */
export async function markDone(id: string) {
  await markBlockDone(id);
  await reloadWeek();
}

export async function markMissed(id: string) {
  await markBlockMissed(id);
  await reloadWeek();
}

/** C1：把块切到另一层（界面上的左侧色条点击即调用） */
export async function setLayer(id: string, layer: BlockLayer) {
  // C1.2：切层同样可能触发融合（后端会删掉一块）→ 一律整周重拉，别再按 id 写回
  const out = await updateBlock(id, { layer });
  await reloadWeek();
  toastIfMerged(out.merged);
  adoptSurvivorAfterWrite(out.block);
}

/**
 * C2：漂流——确认一个推荐时段。
 *
 * 用户实测 #12（对账 §5-U）：「该合并的两块没合，别的操作之后又合了」—— 后端 `postpone_block`
 * 内部走 `create_block`（**它会自动融合**）或 `move_block`，返回的那一块只是幸存者；
 * 旧写法只 `upsertBlock(result.block)` ✗ → 被吃掉的那块留在界面上（幻影行），下次任何重拉才消失。
 * 所以（规矩 23）一样整周重拉，别猜「只改了一行」。
 */
export async function postpone(id: string, newStartAt: number): Promise<MoveOutcome> {
  const out = await ipcPostponeBlock(id, newStartAt);
  await reloadWeek();
  toastIfMerged(out.merged);
  adoptSurvivorAfterWrite(out.block);
  return out;
}

export async function removeBlock(id: string) {
  // round40：**不再二次确认** —— 删除能整批撤销（`Ctrl+Z` / 提示条上的「撤销」），
  // 给能撤销的动作再加一层模态确认，只会训练用户闭眼点掉（调研结论 + 你 2026-10-02 拍板 A 案）。
  const deleted = await deleteBlock(id);
  // 后端把「它 + 全部后代」一起删了，直接按数据库现状刷新最稳
  // （删除不是融合：它自己有「已删除 N 个块」那句，别弹「已合并」✗）
  await reloadWeek();
  // round41：提示只报「做了什么」—— 连带删了几个块在界面上看得见（括号里的解释一律去掉）
  toastUndo(deleted > 1 ? t("msg.blocks.05", { deleted: deleted }) : t("msg.blocks.06"));
}

/* ------------------------------------------------------------------ *
 * round61（10.2 多选）：批量写路径 —— 每条一次 IPC（后端一次 `record` = **一步撤销**）。
 * 与单块同源：整周重拉 + 融合提示；选中收口交给 `selection.svelte.ts` 的 reconcile。
 * ------------------------------------------------------------------ */

/** 批量标记（只动 `planned`；标 ✗ **不弹漂流卡** —— 由调用方保证） */
export async function markBlocksMany(ids: string[], status: "done" | "missed"): Promise<number> {
  const n = await ipcMarkBlocks(ids, status);
  await reloadWeek();
  return n;
}

/** 批量删除（返回删掉的块数，含级联子树；与单块一样带「撤销」提示） */
export async function removeBlocksMany(ids: string[]): Promise<number> {
  const deleted = await ipcDeleteBlocks(ids);
  await reloadWeek();
  toastUndo(deleted > 1 ? t("msg.blocks.07", { deleted: deleted }) : t("msg.blocks.08"));
  return deleted;
}

/** 批量平移（`moves` = [id, 新起点]；级联/融合与单块同一条路）。
 *  `skipped` = 选中里因**已标记**而没参与移动的块数（round61.1：提示里写明白，
 *  否则用户看到「已选 3 块」却只动了 2 块会以为坏了）。 */
export async function moveBlocksMany(
  moves: Array<[string, number]>,
  skipped = 0,
): Promise<BatchOutcome> {
  const out = await ipcMoveBlocks(moves);
  await reloadWeek();
  const parts = [tn("msg.blocks.09", out.changed, { changed: out.changed })];
  if (out.cascaded > 0) parts.push(tn("msg.blocks.10", out.cascaded, { cascaded: out.cascaded }));
  if (out.merged > 0) parts.push(t("msg.blocks.11"));
  if (out.failed > 0) parts.push(tn("msg.blocks.12", out.failed, { failed: out.failed }));
  if (skipped > 0) parts.push(tn("msg.blocks.13", skipped, { skipped: skipped }));
  toast(parts.join(t("msg.blocks.14")));
  return out;
}

/**
 * round69（B3）：复制手势落地 —— 批量建（一次 IPC = 后端一次 `record` = **一步撤销**）。
 * 与其它写路径同一条铁律：整周重拉。
 * round69.1（#2 / D1）：落点与原块/同类块重合时后端**就地融合**（`merged` > 0）——
 * 提示必须说真话（旧写法照样报「已复制」，用户以为多出一份、其实没有）。
 */
export async function copyBlocksMany(specs: CopySpec[]): Promise<CopyOutcome> {
  const out = await ipcCreateBlocks(specs);
  await reloadWeek();
  if (out.created === 0 && out.merged > 0) {
    toast(t("msg.blocks.15"));
  } else if (out.merged > 0) {
    toast(tn("msg.blocks.16", out.created, { created: out.created, merged: out.merged }));
  } else {
    toast(out.created > 1 ? t("msg.blocks.17", { created: out.created }) : t("msg.blocks.18"));
  }
  return out;
}

/** 批量改层（可能触发融合 → 整周重拉） */
export async function setBlocksLayerMany(ids: string[], layer: BlockLayer): Promise<BatchOutcome> {
  const out = await ipcSetBlocksLayer(ids, layer);
  await reloadWeek();
  const label = layer === "required" ? t("msg.blocks.19") : t("msg.blocks.20");
  if (out.changed > 0) {
    const parts = [tn("msg.blocks.21", out.changed, { changed: out.changed, label: label })];
    if (out.merged > 0) parts.push(t("msg.blocks.22"));
    toast(parts.join(t("msg.blocks.23")));
  }
  return out;
}

/**
 * 拉伸**预览**（C1.4 实测反馈后改）：不再去改 store 里的时间，只在这里挂一个预览值。
 *
 * 好处：① 拖动中布局不会重排（块不横向跳走）；② 不写库，`events` 不会有噪音；
 * ③ 松手失败也不用回滚 —— store 从头到尾没被改过。
 */
export const blockPreview = $state<{ id: string | null; start: number; end: number; anchor: number | null; block: Block | null; grabbed: boolean }>({
  id: null,
  start: 0,
  end: 0,
  /** 手势发生在**哪一列**（列起点）—— 跨天/多天块时，辅助线胶囊按它定位，
   *  否则会跑到「块起点那一列」去（用户拖的是第 3 天那截，胶囊却在第 1 天） */
  anchor: null,
  /**
   * round29 #5：被拉伸的那一块的**快照**（起手势时从组件传进来）。
   * 为什么需要：翻周会把 `blocks` 整批换成新一周的数据 —— 跨周拉伸时这块**不在新一周的数据里**，
   * 光靠 `blockPreview.id` 找不到块对象，时间轴就画不出那个绿条（用户实测「没跟上来」✗）。
   * 有快照之后，渲染不再依赖「store 里还在不在它」。
   */
  block: null,
  /**
   * round31（C1.9）：这个预览是**键盘抓起**（Enter 拿起后方向键移动）驱动的。
   * 与指针手势的区别：翻周重拉**不许**把它清掉（抓起的块常常正处于「挪到别的周」的路上）；
   * 指针手势那边每帧都会自己把预览贴回去（round28 #8），所以不需要这个标记。
   */
  grabbed: false,
});

/** 设置预览值（拖动中每一帧调，只改内存） */
export function setBlockPreview(
  id: string,
  startAt: number,
  endAt: number,
  anchor = 0,
  snapshot: Block | null = null,
  grabbed = false,
) {
  blockPreview.id = id;
  blockPreview.start = startAt;
  blockPreview.end = endAt;
  blockPreview.anchor = anchor;
  blockPreview.block = snapshot;
  blockPreview.grabbed = grabbed;
}

/** 清掉预览（松手、取消、失败都调它） */
export function clearBlockPreview() {
  blockPreview.id = null;
  blockPreview.block = null;
  blockPreview.grabbed = false;
}

/* ------------------------------------------------------------------ *
 * round61.1：多选「拿起」的**组预览** —— `Enter` 拿起整组后，
 * 鼠标拖拽与方向键都只改这里的预览（不写库），`Enter` 落地才一次批量写。
 * 为什么需要它：未拿起边走边写会让中间状态真的落库（假融合/意外），
 * 预览式把「搬动」变成预览→落地一次写→一步撤销。
 * ------------------------------------------------------------------ */
export const groupPreview = $state<{
  /** 组预览的锚点（主选块）；null = 没有组预览 */
  anchorId: string | null;
  /** 每块的预览时段（含锚点） */
  ranges: Record<string, { start: number; end: number }>;
  /** 每块的快照（跨周渲染要用 —— 它们可能不在当前窗口的数据里） */
  blocks: Record<string, Block>;
}>({ anchorId: null, ranges: {}, blocks: {} });

/** 开始组预览（拿起整组）：快照每块的当前时段 */
export function beginGroupPreview(ids: string[], anchorId: string | null): void {
  const ranges: Record<string, { start: number; end: number }> = {};
  const snaps: Record<string, Block> = {};
  for (const id of ids) {
    const b = blocks.find((x) => x.id === id);
    if (!b) continue;
    ranges[id] = { start: b.start_at, end: b.end_at };
    snaps[id] = { ...b };
  }
  groupPreview.anchorId = anchorId;
  groupPreview.ranges = ranges;
  groupPreview.blocks = snaps;
  // 锚点走单块预览（辅助线胶囊 / 提示行 / 跟随都用它）
  const anchor = anchorId ? ranges[anchorId] : undefined;
  const snap = anchorId ? snaps[anchorId] : undefined;
  if (anchorId && anchor && snap) {
    setBlockPreview(anchorId, anchor.start, anchor.end, anchor.start, snap, true);
  }
}

/** 整组平移 `deltaSeconds`（可累积调用；只改预览） */
export function shiftGroupPreview(deltaSeconds: number): void {
  if (!groupPreview.anchorId) return;
  const next: Record<string, { start: number; end: number }> = {};
  for (const [id, r] of Object.entries(groupPreview.ranges)) {
    next[id] = { start: r.start + deltaSeconds, end: r.end + deltaSeconds };
  }
  groupPreview.ranges = next;
  const a = next[groupPreview.anchorId];
  if (a) setBlockPreview(groupPreview.anchorId, a.start, a.end, a.start, groupPreview.blocks[groupPreview.anchorId] ?? null, true);
}

/** 清掉组预览 */
export function clearGroupPreview(): void {
  groupPreview.anchorId = null;
  groupPreview.ranges = {};
  groupPreview.blocks = {};
}

/**
 * round61.2（你报图6）：把整组放到「相对快照的**绝对**位移」上（幂等）。
 * 鼠标拖动每一帧都调它（落点可能往回拉）—— 与 `shiftGroupPreview` 的**累积**语义分开，
 * 免得来回拖把位移攒成假值。
 */
export function setGroupPreviewShift(deltaSeconds: number): void {
  if (!groupPreview.anchorId) return;
  const next: Record<string, { start: number; end: number }> = {};
  for (const [id, snap] of Object.entries(groupPreview.blocks)) {
    next[id] = { start: snap.start_at + deltaSeconds, end: snap.end_at + deltaSeconds };
  }
  groupPreview.ranges = next;
  const a = next[groupPreview.anchorId];
  if (a) {
    setBlockPreview(
      groupPreview.anchorId,
      a.start,
      a.end,
      a.start,
      groupPreview.blocks[groupPreview.anchorId] ?? null,
      true,
    );
  }
}

/** 组预览里**真动过**的块（与快照相比起点变了）→ 给 `move_blocks` 的 (id, 新起点) 列表 */
export function groupPreviewMoves(): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const [id, r] of Object.entries(groupPreview.ranges)) {
    const snap = groupPreview.blocks[id];
    if (!snap || snap.start_at !== r.start) out.push([id, r.start]);
  }
  return out;
}

/**
 * C1.7：手势辅助线的**终点线** = 拖动落点 + 这个时长。
 *
 * 只有**拖动已排好的块**时才会被填上（`TaskBlock.onDragStart` 报出）；从 Backlog 拖任务
 * （新建块）时不报 —— 由 `Timeline` 按「新块固定 30 分钟」兜底（用户 2026-10-01 拍板：两种拖法都画）。
 */
export const dragDuration = $state<{ seconds: number }>({ seconds: 0 });

export function setDragDuration(seconds: number) {
  dragDuration.seconds = seconds;
}

/** 松手 / 取消 / 拖出窗口 / 数据整批换掉 —— 都要清（否则会留一条算错时长的终点线） */
export function clearDragDuration() {
  dragDuration.seconds = 0;
}

/** C1.1：拉伸落库（松手时调一次）。预览在 `blockPreview` 里，store 没被改过 → 失败无需回滚。 */
export async function stretchBlock(id: string, startAt: number, endAt: number) {
  try {
    const outcome = await updateBlock(id, { startAt, endAt });
    // 规矩 23（round30 补全 —— 用户报了几十个版本的「拖上去不融合」）：
    // `update_block` 落库后会**融合**（`merge_adjacent`：同任务同层、相接或重叠就合，吃掉一块）。
    // 而幸存者可能**恰好就是被拉伸的这一块**（它起点更早）→ 只看 id 就以为“什么都没变”✗，
    // 被吃掉的那块会以**幻影行**留在 store 里 —— 用户眼里就是「明明重叠了却不合并」。
    // （只读副本铁证：他的库里 `merge` 事件写着合了、库里只剩 1 块，界面却一直两块。）
    // 所以：拉伸一律整周重拉，不再按 id 猜；融合没融合由后端的 merged 说了算。
    await reloadWeek();
    toastIfMerged(outcome.merged);
    adoptSurvivorAfterWrite(outcome.block);
    return outcome;
  } finally {
    // 失败（时长越界等）也必须清预览，否则拖拽状态卡住、整屏都动不了
    clearBlockPreview();
  }
}

/** round27（用户 round26 验收 #3）：后端回报的「没融合原因」→ 一句人话。
 *  只解释「明明同一任务、时间也叠着，却没合」的那几条规则 —— 其它原因（层不同/已标记/中间空着）
 *  一眼看得出来，不该拖哪都弹。
 *  round74（3.0b₂）：改成函数（常量表切语言后不会变） */
function mergeHintText(kind: string): string {
  if (kind === "drift") return t("msg.blocks.24");
  if (kind === "sequence") return t("msg.blocks.25");
  if (kind === "cap") return t("msg.blocks.26");
  return t("msg.blocks.29");
}

/**
 * C3.2：把块拖到别的格子 = **只改时间**（链节与漂流关系全部保留）。
 * 链感知在后端：排到链上「前一环」之前会被拒（提示你）；排到后面那些环之后则**级联顺延**它们。
 */
export async function moveBlock(id: string, startAt: number): Promise<MoveOutcome> {
  const outcome = await updateBlock(id, { startAt });
  await reloadWeek(); // 被顺延的块时间也变了 → 整周重拉
  toastIfMerged(outcome.merged);
  adoptSurvivorAfterWrite(outcome.block);
  if (outcome.history_moved > 0) {
    toast(
      tn("msg.blocks.27", outcome.cascaded, { cascaded: outcome.cascaded, history_moved: outcome.history_moved }),
    );
  } else if (outcome.cascaded > 0) {
    toast(tn("msg.blocks.28", outcome.cascaded, { cascaded: outcome.cascaded }));
  } else if (outcome.merge_hint) {
    // round27：没融合时把原因说清楚（用户实测「两块明明是同一个任务却没合」）
    toast(mergeHintText(outcome.merge_hint));
  }
  return outcome;
}
