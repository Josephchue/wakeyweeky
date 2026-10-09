import type { BlockLayer } from "../ipc/types";

/**
 * 两层结构（C1.4）的两个纯规则 —— 抽出来是为了**能单测**（界面里靠肉眼看不出对错）。
 */

/**
 * 实际生效的层：**遗留值 `suggested` 一律当弹性层**。
 *
 * - 004 迁移会把老数据转成 `elastic`，但**迁移只跑一次**：如果用户用旧版本（如 0.6.6）又写回来一行，
 *   库里就会重新出现 `suggested`。界面不能因此掉到「未知层」的样子（没有斜纹、层级标签说不清）。
 * - 其它值（含真正未知的垃圾值）原样返回：不假装认识它，界面也不会崩。
 */
export function effectiveLayer(layer: string): string {
  return layer === "suggested" ? "elastic" : layer;
}

/** 层切换环（两档）：弹性 ⇄ 必填 */
export const LAYER_CYCLE: BlockLayer[] = ["elastic", "required"];

/**
 * 点一下左色条之后应该切到哪一层。
 *
 * 遗留值/未知值（`LAYER_CYCLE` 里找不到）→ 从「必填」起步：
 * 与「当作弹性」的既有语义一致（弹性点一下 = 必填），而且不会让点击变成空操作。
 */
export function nextLayer(current: string): BlockLayer {
  const i = LAYER_CYCLE.indexOf(current as BlockLayer);
  return i < 0 ? "required" : LAYER_CYCLE[(i + 1) % LAYER_CYCLE.length];
}
