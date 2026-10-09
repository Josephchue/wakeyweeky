import { call } from "./call";
import type { MosaicBlock, ReviewNudge } from "./types";

/**
 * C7（round52）：读某一周的方块（结局马赛克 + R46 明细的**同一份**数据）。
 * 结局规则唯一实现在 Rust `src-tauri/src/review.rs`；这里只是个壳。
 */
export function getWeekMosaic(weekStart: number): Promise<MosaicBlock[]> {
  return call<MosaicBlock[]>("get_week_mosaic", { weekStart });
}

/** 周复盘提醒：到点且这一周未提过 → 返回它（后端顺手推进水位线，**一周只会返回一次**） */
export function takeReviewNudge(): Promise<ReviewNudge | null> {
  return call<ReviewNudge | null>("take_review_nudge");
}

/** 「这一周我看过了」——把水位线推过去（免得提一个刚看过的周） */
export function markReviewSeen(weekStart: number): Promise<void> {
  return call<void>("mark_review_seen", { weekStart });
}
