import { t, tn } from "../i18n/i18n.svelte";
import type { Block, MoveOutcome } from "../ipc/types";
import { blocks, postpone, reloadWeek } from "./blocks.svelte";
import { tasks } from "./tasks.svelte";
import { reloadSequences } from "./sequences.svelte";
import { toast } from "./ui.svelte";
import { formatSuggestion, suggestSlots } from "../utils/drift";
import { armPlacement } from "./drag.svelte";
import { occupiedSlots } from "../utils/timeline";
import { SLOT_MINUTES, weekOf } from "../utils/week";
import { featureOn } from "./settings.svelte";

/**
 * 漂流任务卡的状态（C2）。
 * 依赖方向：drift → blocks/tasks/utils。blocks 不反向依赖 drift，所以没有循环导入。
 */
export type DriftState = {
  blockId: string;
  taskTitle: string;
  /** 若该残影已经有「计划中」的后续块，这里是它的开始时间（界面据此说「已排到 X，要换吗」） */
  existingStartAt: number | null;
  /** 推荐时段（秒级时间戳），最多 3 个 */
  suggestions: number[];
};

export const drift = $state<{ value: DriftState | null }>({ value: null });

const SLOT_SECONDS = SLOT_MINUTES * 60;

/**
 * 沿 `postponed_from` 一路走到**链尾**（与后端 `chain_tail` 同规则）。
 * 前端只用于卡片文案；真正「改哪一块」由后端决定。
 * 带环保护：链上出现重复节点就返回 null，而不是死循环。
 */
function chainTail(blockId: string): Block | null {
  const seen = new Set<string>();
  let current = blocks.find((b) => b.id === blockId) ?? null;
  while (current) {
    const node: Block = current;
    if (seen.has(node.id)) return null;
    seen.add(node.id);
    const child = blocks.find((b) => b.postponed_from === node.id);
    if (!child) return node;
    current = child;
  }
  return null;
}

/** 打开漂流卡：根据当前周已占用的格子算出 3 个可用时段 */
export function openDrift(blockId: string) {
  // round64.1（验收 #1）：漂流开关关掉 → 所有入口一网打尽（按钮已隐藏，这里兜键盘/旧状态）
  if (!featureOn("drift_enabled")) return;
  const block = blocks.find((b) => b.id === blockId);
  if (!block) return;

  // 已占用时段必须把每个块**覆盖到的每一格**都算上 —— 旧写法 `new Set(blocks.map(b => b.start_at))`
  // 只记起始那一格，块一旦变长就会推荐一段其实会重叠的时间（C1.1 修）
  const occupied = occupiedSlots(blocks);
  const durationSlots = Math.max(
    1,
    Math.ceil((block.end_at - block.start_at) / SLOT_SECONDS),
  );

  // 链尾：再次漂移改的是链尾那块（与后端 chain_tail 同规则：一条链只有一个活跃块）
  const tail = chainTail(blockId);

  drift.value = {
    blockId,
    taskTitle: tasks.find((t) => t.id === block.task_id)?.title ?? t("msg.drift.01"),
    existingStartAt: tail && tail.status === "planned" ? tail.start_at : null,
    // 只推荐本周内的空档：MVP 时间轴只显示本周，排到下一周会「建了却看不见」
    suggestions: suggestSlots(
      occupied,
      Math.floor(Date.now() / 1000),
      durationSlots,
      // round48：搜索起点取 max(现在, 这块的起点) —— 漂移只能往后，不能把它提到自己前面
      // （第 5 个参数就是「不许早于」；见 `utils/drift.ts` 的注释与 `drift.test.ts`）
      // C1.3：按**这一块自己所在的周**推荐（跳周后漂流到别的周也能用；
      // 若按「现在那一周」算，块会被排到你看不见的那一周去）
      weekOf(block.start_at),
      block.start_at,
    ),
  };
}

/**
 * round49：漂流卡里的「**自己安排**」（用户 2026-10-03）—— 把预览块挂到鼠标上，左键点一下放下。
 * 放下走的是同一条落库路径（`confirmDrift` → `postpone`），所以顺延/融合提示这些行为一致。
 * 时长与尺寸取自它自己在时间轴上的样子（拖影看起来就是"那块"）。
 */
export function armOwnPlacement(): void {
  const current = drift.value;
  if (!current) return;
  const block = blocks.find((b) => b.id === current.blockId);
  const node = document.querySelector<HTMLElement>(`[data-block-id="${current.blockId}"]`);
  const rect = node?.getBoundingClientRect();
  const durationSeconds = block ? block.end_at - block.start_at : 30 * 60;
  drift.value = null; // 先把卡片收起来（让出视线、也不会挡住落点）
  armPlacement({
    blockId: current.blockId,
    durationSeconds,
    width: rect?.width ?? 120,
    height: rect?.height ?? 28,
    onPlace: (startAt) => {
      const label = labelFor(startAt);
      // 注意：这里**不能**走 `confirmDrift`（它读 `drift.value`，而上面已经清空了）
      void placeBlock(current.blockId, startAt)
        .then(() => toast(t("msg.drift.02", { label: label })))
        .catch(() => {
          // ipc 层已弹 Toast
        });
    },
  });
}

export function closeDrift() {
  drift.value = null;
}

  /** 用户点了某个建议时段 → 新建一个块（原残影留在原位）”。
   *  C3.1：漂流的块会**接替它在链上的位置**；若落在了后续链节之后，后端会**级联顺延**它们 ——
   *  所以这里要把块与序列都重新拉一遍（被顺延的块时间变了，连线也要重画）。 */
  /**
   * round49：真正落库那一步（把这块排到 `startSec`）—— 卡片按钮与「自己安排」**共用**。
   * 抽出来的原因：`armOwnPlacement` 会先把 `drift.value` 清掉（卡片要收起来让出视线），
   * 落库时**不能再依赖 `drift.value`**（我第一版就是这样早退的：预览块跟得好好的，点下去什么都没发生 ✗，
   * 被 `round49 ⑤` 那条断言当场抓住）。
   */
  async function placeBlock(blockId: string, startSec: number): Promise<MoveOutcome> {
    const result: MoveOutcome = await postpone(blockId, startSec);
    if (result.history_moved > 0) {
      toast(
        tn("msg.drift.03", result.cascaded, { cascaded: result.cascaded, history_moved: result.history_moved }),
      );
    } else if (result.cascaded > 0) {
      toast(tn("msg.drift.04", result.cascaded, { cascaded: result.cascaded }));
    }
    await reloadWeek();
    return result;
  }

  export async function confirmDrift(startSec: number) {
    const current = drift.value;
    if (!current) return null;
    const result = await placeBlock(current.blockId, startSec);
    drift.value = null;
    await reloadSequences();
    return result.block;
  }

/** 供界面显示：把建议时段转成「今天 20:00」这样的文案 */
export function labelFor(startSec: number): string {
  return formatSuggestion(startSec, Math.floor(Date.now() / 1000));
}
