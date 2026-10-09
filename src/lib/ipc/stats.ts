import { call } from "./call";
import type { Stats } from "./types";

/**
 * 10.1 统计页（round60 / 0.14.0）：全时段累计 + 近 12 周。
 * 汇总与口径的唯一实现在 Rust `stats.rs`；这里只是个壳。
 */
export function getStats(): Promise<Stats> {
  return call<Stats>("get_stats");
}

/**
 * round79（78-10）：「重置统计」—— **非破坏**：后端只写一个时间界（`stats_reset_at`），
 * 一条 `events` 都不删；返回线之后重新算出来的数字。
 */
export function resetStats(): Promise<Stats> {
  return call<Stats>("reset_stats");
}
