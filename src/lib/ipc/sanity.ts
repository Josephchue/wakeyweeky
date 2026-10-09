import { call } from "./call";
import type { SanityWeek } from "./types";

/**
 * C6：读某一周的理智值曲线（占用分钟 = 各块区间**并集** / 档位 / 「挪过 / 没做完」计数）。
 * 算法**唯一实现**在 Rust `src-tauri/src/sanity.rs`；这里只是个壳。
 */
export function getSanityCurve(weekStart: number): Promise<SanityWeek> {
  return call<SanityWeek>("get_sanity_curve", { weekStart });
}
