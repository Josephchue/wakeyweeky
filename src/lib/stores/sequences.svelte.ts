import { t } from "../i18n/i18n.svelte";
import {
  linkAfter,
  listSequences,
  removeSequenceMember,
} from "../ipc/sequences";
import type { Sequence } from "../ipc/types";
import { week } from "./week.svelte";
import { blocks, reloadWeek } from "./blocks.svelte";
import { tasks } from "./tasks.svelte";
import { toast, toastUndo } from "./ui.svelte";
import { featureOn } from "./settings.svelte";

/** 本周窗口内的序列（供时间轴画细线与序号） */
export const sequences = $state<Sequence[]>([]);

/**
 * 接链状态（C3.3，用户拍板的交互：**两次左键** —— 第一次「拿起线头」，第二次「放下」）。
 * 拿起后线头跟着鼠标走（`linkCursor`），点另一个块 = 接在它后面，点空白 = 取消
 * （若拿起的那个块本来就在链上，则等于**从序列里取出**）。
 */
export const link = $state<{ pendingId: string | null; originWeekFrom: number | null }>({
  pendingId: null,
  originWeekFrom: null,
});
export const linkCursor = $state<{ x: number; y: number }>({ x: 0, y: 0 });

/** 块的展示标题（自动命名与提示用） */
function titleOf(blockId: string): string {
  const block = blocks.find((b) => b.id === blockId);
  const title = block ? tasks.find((t) => t.id === block.task_id)?.title : undefined;
  return title ?? t("msg.sequences.01");
}

export async function reloadSequences() {
  // C1.3：按**正在看的那一周**拉（跳周后线/序号要跟着换，否则下周的序列画不出来）
  const data = await listSequences(week.from, week.to);
  sequences.length = 0;
  sequences.push(...data);
}

/** 这个块所属的序列（没有则 null） */
async function sequenceOf(blockId: string): Promise<Sequence | null> {
  return sequences.find((s) => s.members.some((m) => m.block_id === blockId)) ?? null;
}

export function cancelLink() {
  link.pendingId = null;
  link.originWeekFrom = null;
}

/** 点块上的 ⛓：第一次拿起，第二次（点另一个块）接上 */
export async function linkBlock(blockId: string) {
  // round64（C10）：序列开关关掉 → 接链动作不可用（⛓ 本来就不出现，这是第二道）
  if (!featureOn("sequences_enabled")) return;
  const pending = link.pendingId;

  if (!pending) {
    link.pendingId = blockId;
    // round26 #5（用户实测「链接翻页时手上没线头」）：记下「拿起线头时在看哪一周」——
    // 翻页之后起点块不在 DOM 里，靠它判断线头该从板子的哪一边探出来。
    link.originWeekFrom = week.from;
    // round33 #3（用户实测「线头拿起时左上角与右下角信息重了」）：
    // 这条提示不弹了 —— 顶栏已经有一条常驻的接链提示（`Timeline` 的 `.link-hint`），
    // 右下角再来一条是重复（用户点名「隐藏右下角那个」）。
    return;
  }
  if (pending === blockId) {
    cancelLink();
    toast(t("msg.sequences.02"));
    return;
  }

  try {
    const outcome = await linkAfter(
      pending,
      blockId,
      `${titleOf(pending)} → ${titleOf(blockId)}`,
    );
    if (outcome.history_moved > 0) {
      toast(
        t("msg.sequences.03", { cascaded: outcome.cascaded, history_moved: outcome.history_moved }),
      );
    } else if (outcome.cascaded > 0) {
      toast(t("msg.sequences.04", { cascaded: outcome.cascaded }));
    } else {
      toast(t("msg.sequences.05"));
    }
    await reloadSequences();
    await reloadWeek(); // 时间可能被自动顺延过 → 整周重拉
  } catch {
    // ipc 层已弹 Toast（例如「这个块已经属于另一条序列了」）
  } finally {
    cancelLink();
  }
}

/** 待链状态下点了空白处：在链上的块 → 解除链接；否则仅取消 */
export async function linkOnEmptySpace() {
  const pending = link.pendingId;
  if (!pending) return;

  const sequence = await sequenceOf(pending);
  if (!sequence) {
    cancelLink();
    return;
  }
  try {
    await removeSequenceMember(sequence.id, pending);
    // round40：不再用模态确认（能撤销就不打扰）—— 提示条上直接给「撤销」
    toastUndo(t("msg.sequences.06", { pending: titleOf(pending) }));
    await reloadSequences();
  } catch {
    // ipc 层已弹 Toast
  } finally {
    cancelLink();
  }
}

/** 显式入口（块的 ⛓ 上右键）：把这个块从序列里拿出来 */
export async function unlinkBlock(blockId: string) {
  const sequence = await sequenceOf(blockId);
  if (!sequence) {
    toast(t("msg.sequences.07"));
    return;
  }
  try {
    await removeSequenceMember(sequence.id, blockId);
    // round40：同上 —— 直接做 + 一条能撤销的提示（原来的 `window.confirm` 拿掉了）
    toastUndo(t("msg.sequences.08", { blockId: titleOf(blockId) }));
    await reloadSequences();
  } catch {
    // ipc 层已弹 Toast
  } finally {
    cancelLink();
  }
}

/** 该块在它所属序列里是**第几环**（1 起；不属于任何序列则 null）。
 *  用「环号的名次」而不是数组下标：**残影与漂出去的新块共享同一环** → 应显示同一个序号。 */
export function sequenceIndex(blockId: string): number | null {
  for (const sequence of sequences) {
    const member = sequence.members.find((m) => m.block_id === blockId);
    if (!member) continue;
    const positions = [...new Set(sequence.members.map((m) => m.order_index))].sort(
      (a, b) => a - b,
    );
    return positions.indexOf(member.order_index) + 1;
  }
  return null;
}
