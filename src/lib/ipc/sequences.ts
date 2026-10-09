import { call } from "./call";
import type { MoveOutcome, Sequence } from "./types";

/** 窗口内有成员的序列（成员给全，前端只画窗口内的线） */
export function listSequences(from: number, to: number): Promise<Sequence[]> {
  return call<Sequence[]>("list_sequences", { from, to });
}

/**
 * C3.3：把 B 接在 A 后面（用户拍板的「两次左键：拿起 → 放下」）。
 * A 不在链里 → 用 `name` 新建一条 A→B；A 已在链里 → **插在 A 后面**（不是链尾）；
 * B 的时间若不在 A 之后，后端会**自动顺延**并级联后面的环。
 */
export function linkAfter(
  afterBlockId: string,
  blockId: string,
  name: string | null,
): Promise<MoveOutcome> {
  return call<MoveOutcome>("link_after", { afterBlockId, blockId, name });
}

/** 移出块；返回序列是否因成员不足 2 个而被自动删除 */
export function removeSequenceMember(sequenceId: string, blockId: string): Promise<boolean> {
  return call<boolean>("remove_sequence_member", { sequenceId, blockId });
}


