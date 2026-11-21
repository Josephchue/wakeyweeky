/**
 * round94（#2）：**打开 / 回到本周时「现在」滚到哪** —— 纯几何，唯一实现。
 *
 * 为什么抽出来：这段换算同时被三处用到（挂载那一次、`goNow()` 的 tick、断言里的期望值），
 * 抄第二份就是假绿温床（本仓的老规矩：算法只留一处）。
 *
 * 口径（你 2026-11-21 拍板）：
 * - 看得到今天 → 让「现在线」落在视口**上 1/3**（日历惯例：上面留一点上下文，下面留大部分给接下来）；
 * - 看不到今天（跳到了别的周 / 周末被藏起来）→ 回落到 6:00（round24 的老口径，不动）；
 * - 两种情况都要夹在 `[0, max]`（一天的列很高，但周视图在矮窗口里能滚；视口比内容高时 max = 0）。
 */

export type ScrollTargetInput = {
  /** 日期头高度（`.scroll` 内容里 day-body 从这开始；`utils/timeline.ts::DAY_HEAD_PX`） */
  dayHead: number;
  /** 「现在线」在 day-body 里的纵向位置（px）；`null` = 今天不在视野 */
  nowY: number | null;
  /** `.scroll` 的**可视高度**（`clientHeight`） */
  viewport: number;
  /** 可滚动的上限（`scrollHeight - clientHeight`，不小于 0） */
  max: number;
  /** 看不到今天时停在哪（= `dayHead + 6:00 的像素`） */
  fallback: number;
};

/** 「现在」落在视口上 1/3 处 */
export const NOW_ANCHOR_RATIO = 1 / 3;

/** 夹到 `[0, max]`（`max` 非法时按 0 处理）；NaN 回 0，±Infinity 交给夹取（→ max / 0） */
function clamp(v: number, max: number): number {
  const top = Number.isFinite(max) && max > 0 ? max : 0;
  if (Number.isNaN(v)) return 0;
  return Math.min(Math.max(v, 0), top);
}

export function initialScrollTop({ dayHead, nowY, viewport, max, fallback }: ScrollTargetInput): number {
  if (nowY === null) return clamp(fallback, max);
  return clamp(dayHead + nowY - viewport * NOW_ANCHOR_RATIO, max);
}
