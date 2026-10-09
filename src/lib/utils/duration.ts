/**
 * round69（B3）：**块时长 = 任务的「预估」** —— 这条口径的唯一前端实现。
 *
 * 为什么抽出来：它以前在 `Backlog.svelte` 里写了两遍（拖出来建块 / 每周重复表单的说明），
 * Rust 侧还有一份（`repeats::duration_minutes`，生成重复块用）—— 三处漂移过一次（round27/28：
 * 四舍五入 vs 向上取整）。**改这里必须同时改 `src-tauri/src/repeats.rs` 的那一份**。
 *
 * 规则（用户 2026-10-03 拍板的方向）：向上取整到 15 分钟 —— 宁可多给，也别给少于预估的时间；
 * 没填（0 / null）就是 30 分钟。
 */
export function estimateMinutes(estimated: number | null | undefined): number {
  const est = estimated ?? 0;
  if (est <= 0) return 30;
  return Math.max(15, Math.ceil(est / 15) * 15);
}
