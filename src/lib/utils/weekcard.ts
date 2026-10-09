/**
 * 一周口径的**纯函数** —— 结局计数 / 完成率 / 序列完成情况 / 往期窗口。
 *
 * 为什么单独一个文件：口径要能单测（组件里的分支 vitest 看不见 —— round26 的教训）。
 * 这里只做「算」：不碰 store、不碰 DOM、不偷看真挂钟（「现在」一律由调用方给）。
 *
 * 口径（`docs/plans/round57-c8-weekly-card.md` §三，用户 2026-10-04 拍板；
 * round58 把卡片并进总览后，这套口径原样保留）：
 * - 完成 = `done` / `done_overtime` / `done_short` 三档；未完成 = `missed`；未执行 = `unused`；计划中 = `planned`
 * - **完成率** = 完成 ÷ (完成 + 未完成 + 未执行)（`planned` 不算；`⊘` 的块照算）→ **分母 0 显示「—」**
 * - **序列完成情况** = 只看这一周里有成员的序列（跨周成员不算这一周）
 * - **往期** = 最近 12 周（含本周），锚点是今天那一周
 */
import type { MosaicBlock, MosaicState, Sequence } from "../ipc/types";
import { shiftWeek } from "./week";
import { formatDateFull, formatDateFragment } from "./datetime.svelte";

/** 算「完成」的三档（`done` = 按时，另两档是终态细分） */
const DONE_STATES: MosaicState[] = ["done", "done_overtime", "done_short"];

/** 一周的结局计数（总览顶部那一行） */
export type WeekCounts = {
  /** 完成（含超时/提前） */
  done: number;
  missed: number;
  unused: number;
  /** 还没到 —— **不进完成率分母** */
  planned: number;
  /** 完成里「超时完成」的条数（悬停/说明用） */
  overtime: number;
  /** 完成里「提前完成」的条数 */
  short: number;
  /** 已到点的块数 = 完成 + 未完成 + 未执行（完成率的分母） */
  due: number;
};

export function countStates(blocks: MosaicBlock[]): WeekCounts {
  const c: WeekCounts = { done: 0, missed: 0, unused: 0, planned: 0, overtime: 0, short: 0, due: 0 };
  for (const b of blocks) {
    switch (b.mosaic_state) {
      case "done":
        c.done += 1;
        break;
      case "done_overtime":
        c.done += 1;
        c.overtime += 1;
        break;
      case "done_short":
        c.done += 1;
        c.short += 1;
        break;
      case "missed":
        c.missed += 1;
        break;
      case "unused":
        c.unused += 1;
        break;
      case "planned":
        c.planned += 1;
        break;
      default:
        // 六种结局已全覆盖；将来新增状态时先在这里报一声，免得静静漏计
        break;
    }
  }
  c.due = c.done + c.missed + c.unused;
  return c;
}

export type Rate = { done: number; total: number; pct: number | null };

/** 完成率；**分母为 0 → `pct = null`**（界面显示「—」，不编一个 0% / 100% 出来） */
export function completionRate(counts: WeekCounts): Rate {
  const total = counts.due;
  return { done: counts.done, total, pct: total === 0 ? null : Math.round((counts.done / total) * 100) };
}

/** `9/14 · 64%`；没有到点的块 → `—` */
export function formatRate(rate: Rate): string {
  return rate.pct === null ? "—" : `${rate.done}/${rate.total} · ${rate.pct}%`;
}

export type SequenceProgress = { id: string; name: string; done: number; total: number };

/**
 * 序列完成情况：**这一周里有成员的**序列各一行（跨周成员不算这一周）；
 * 这一周没成员的序列整条不出现（免得列一堆「0/0」）。
 */
export function sequenceProgress(blocks: MosaicBlock[], sequences: Sequence[]): SequenceProgress[] {
  const stateOf = new Map(blocks.map((b) => [b.id, b.mosaic_state]));
  const out: SequenceProgress[] = [];
  for (const seq of sequences) {
    const members = seq.members.map((m) => m.block_id).filter((id) => stateOf.has(id));
    if (members.length === 0) continue;
    let done = 0;
    for (const id of members) {
      const state = stateOf.get(id);
      if (state && DONE_STATES.includes(state)) done += 1;
    }
    out.push({ id: seq.id, name: seq.name, done, total: members.length });
  }
  return out;
}

/** 一行的展示文字：`晨间流程 3/4` */
export function formatSequence(row: SequenceProgress): string {
  return `${row.name} ${row.done}/${row.total}`;
}

/**
 * 往期列表：**最近 `recent` 周（含本周）**，新 → 旧。
 * 锚点是**今天那一周**（不是你正在看的那一周）—— 这样往前翻过的周也能走回来。
 * 用 `shiftWeek`（本地日期加法，不是减 604800 秒 —— 夏令时会错位）。
 *
 * round58：结语销掉后这里不再有「写过结语的周」这一层（它随结语一起删）。
 */
export function pastWeeks(todayWeekStart: number, recent = 12): number[] {
  const out: number[] = [];
  for (let i = 0; i < recent; i++) out.push(shiftWeek(todayWeekStart, -i));
  return out;
}

/** 往期 chip 上的短标签：`09-28~10-04`（片段跟 `date_format`；跨年写全日期） */
export function formatWeekShort(weekStart: number): string {
  const from = new Date(weekStart * 1000);
  const to = new Date(shiftWeek(weekStart, 1) * 1000 - 1000);
  const sameYear = from.getFullYear() === to.getFullYear();
  const full = (d: Date) => formatDateFull(Math.floor(d.getTime() / 1000));
  return sameYear ? `${formatDateFragment(from)}~${formatDateFragment(to)}` : `${full(from)}~${full(to)}`;
}
