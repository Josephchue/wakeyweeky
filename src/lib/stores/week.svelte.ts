import { getCurrentWeek, shiftWeek, weekOf } from "../utils/week";
import { note } from "./achievements.svelte";

/**
 * 「当前显示的是哪一周」。
 *
 * 为什么要单独做成 store：MVP 的时间轴只显示一周，但如果应用一直开着跨过周日 24:00，
 * 组件里 `const week = getCurrentWeek()` 会永远停在旧的一周，而 store 里的块却会被
 * `reloadWeek()` 刷成新一周 —— 结果就是「块加载了但格子里看不见」。
 * 现在由 App 每分钟调用 `refreshWeek()`，跨周时时间轴与数据一起翻页。
 *
 * C1.3：支持跳周。`following` = 是否「跟随现在」—— 一旦手动跳周就置 false，
 * 跨周自检不再把用户拽走；点「回到本周」恢复。
 */
export const week = $state({
  from: getCurrentWeek().from,
  to: getCurrentWeek().to,
  following: true,
});

/**
 * round68（19.1）：翻到远处也是暗章信号（跨度按「目标周 vs 本周」算）。
 * ≥4 周后 = 在空中翻周程度的能力；≤-4 周 = 昨日重现；≤-12 周 = 考古学家。
 */
function noteWeekDistance(targetFrom: number): void {
  // 周时间戳是**秒**（`utils/week.ts` 的约定）—— 不要拿毫秒的 7*86400000 去除
  const diff = Math.round((targetFrom - getCurrentWeek().from) / (7 * 86_400));
  if (diff >= 4) void note("jump_weeks");
  else if (diff >= 1) void note("next_week");
  if (diff <= -12) void note("archaeologist");
  else if (diff <= -4) void note("past_week");
}

/** 跳 N 周（正数往后）。手动跳周后不再跟随现在 */
export function goWeek(deltaWeeks: number) {
  const from = shiftWeek(week.from, deltaWeeks);
  week.from = from;
  week.to = weekOf(from).to;
  week.following = false;
  noteWeekDistance(from);
}

/** 回到「现在所在的周」，并恢复跟随 */
export function goNow() {
  const current = getCurrentWeek();
  week.from = current.from;
  week.to = current.to;
  week.following = true;
}

/**
 * round31（C1.9）：跳到**某个时刻所在的那一周** —— 键盘把块挪出本周/拉出本周时，
 * 视图跟着块（或跟着「正在动的那条边」）走。口径与 `goWeek` 一致：手动换周 = 不再跟随现在。
 */
export function goToWeekOf(ts: number) {
  const target = weekOf(ts);
  week.from = target.from;
  week.to = target.to;
  week.following = false;
  noteWeekDistance(target.from);
}

/** 检查是否跨周；返回 true 表示这一周变了（调用方据此刷新数据）。**手动跳周后不再生效** */
export function refreshWeek(): boolean {
  if (!week.following) return false;
  const current = getCurrentWeek();
  if (current.from === week.from && current.to === week.to) return false;
  week.from = current.from;
  week.to = current.to;
  return true;
}
