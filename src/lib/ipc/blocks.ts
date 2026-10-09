import { call } from "./call";
import type { BatchOutcome, Block, BlockLayer, CopyOutcome, CopySpec, CreateOutcome, MoveOutcome } from "./types";

export function listBlocks(from: number, to: number): Promise<Block[]> {
  return call<Block[]>("list_blocks", { from, to });
}

export function createBlock(
  taskId: string,
  startAt: number,
  endAt: number,
): Promise<CreateOutcome> {
  return call<CreateOutcome>("create_block", {
    taskId,
    startAt,
    endAt,
  });
}

/** 删除块：后端会**连同它漂出来的后续块**一起删，返回实际删除数量。 */
/** round49：**临时安排块**自己的「不计入理智值」开关（普通块没有这个键，它们看任务那一行） */
export function setBlockExempt(id: string, exempt: boolean): Promise<Block> {
  return call<Block>("set_block_exempt", { id, exempt });
}

export function deleteBlock(id: string): Promise<number> {
  return call<number>("delete_block", { id });
}

// ------------------------------------------------ round61（10.2 多选）批量
// 每条一次 IPC = 后端一次 `record` = **一步撤销**；写路径与单块共用，语义零分叉。

/** 批量删除（返回实际删掉的块数，含级联子树） */
export function deleteBlocks(ids: string[]): Promise<number> {
  return call<number>("delete_blocks", { ids });
}

/** 批量标记（后端只动 `planned` 的块，幂等） */
export function markBlocks(ids: string[], status: "done" | "missed"): Promise<number> {
  return call<number>("mark_blocks", { ids, status });
}

/** 批量平移（`moves` = [块 id, 新起点]；起点由调用方按本地日历算好） */
export function moveBlocks(moves: Array<[string, number]>): Promise<BatchOutcome> {
  return call<BatchOutcome>("move_blocks", { moves });
}

/** 批量改层（可能引发融合 → 调用方整周重拉） */
export function setBlocksLayer(ids: string[], layer: BlockLayer): Promise<BatchOutcome> {
  return call<BatchOutcome>("set_blocks_layer", { ids, layer });
}

/**
 * round69（B3）：复制手势落地 —— 批量建（后端一次 `record` = 一步撤销）。
 * round69.1（D1）：落点与原块/同类块相接/重叠时后端会**就地融合**（`merged` > 0）——
 * `blocks` 是去重后的存活块（就地融合时是**原来那一块**，id 不换）。
 */
export function createBlocks(blocks: CopySpec[]): Promise<CopyOutcome> {
  return call<CopyOutcome>("create_blocks", { blocks });
}

export function markBlockDone(id: string): Promise<Block> {
  return call<Block>("mark_block_done", { id });
}

export function markBlockMissed(id: string): Promise<Block> {
  return call<Block>("mark_block_missed", { id });
}

/** C1：改层。后端会校验三态，非法值返回中文错误（由 call() 弹 Toast）。 */
/** 改块（v2 ①51：layer / start_at / end_at 三个 patch，拖拽移动也走这里；
 *  round25 追加 label —— C1.8 临时块的「就地命名」） */
export function updateBlock(
  id: string,
  patch: { layer?: BlockLayer; startAt?: number; endAt?: number; label?: string | null },
): Promise<MoveOutcome> {
  return call<MoveOutcome>("update_block", {
    id,
    layer: patch.layer ?? null,
    startAt: patch.startAt ?? null,
    endAt: patch.endAt ?? null,
    label: patch.label ?? null,
  });
}

/** C1.8（R33）：双击时间轴空白格 → 建一个**临时安排块**（不登记在 Backlog）。
 *  后端会保证那块全局隐藏任务存在（幂等），名字默认空（界面显示「临时安排」）。 */
export function createTempBlock(startAt: number, endAt: number): Promise<CreateOutcome> {
  return call<CreateOutcome>("create_temp_block", { startAt, endAt });
}

/** C2：漂流——按用户确认的时段新建一个块（原残影留在原位），返回新块。 */
export function postponeBlock(id: string, newStartAt: number): Promise<MoveOutcome> {
  return call<MoveOutcome>("postpone_block", { id, newStartAt });
}

/** C1.2/C3：加载一周时先整理一次（合并留存重复块 + 摘掉非法序列成员）。返回给用户的一句话（空串=没做事） */
export function mergePendingBlocks(): Promise<string> {
  return call<string>("merge_pending_blocks");
}
