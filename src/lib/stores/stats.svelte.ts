/**
 * 10.1 统计页（round60 / 0.14.0）：面板要的数据 + 会话内开关。
 *
 * 只干三件事：**打开时拉一次**（每次重拉 —— 它就是「打开那一下的最新数字」）/ 防竞态（序号守旧）/
 * 失败不假装成功。不重算任何规则：数字全在 Rust `stats.rs` 算好（完成率百分比也是）。
 *
 * 与 `review.svelte.ts` 的差别：统计是**全时段只读**，没有「正在看哪一周」这种身份 ——
 * 所以防竞态只按「谁最后发起」的序号守旧即可（同一次会话里没有窗口语义可认）。
 */
import { getStats, resetStats as resetStatsIpc } from "../ipc/stats";
import type { Stats } from "../ipc/types";
import { featureOn } from "./settings.svelte";
import { note } from "./achievements.svelte";
import { prepareOpen, registerPanel } from "./panels.svelte";

export const stats = $state<{
  /** 面板开着吗 */
  open: boolean;
  /**
   * round82（11.5 · 案 C）：这次是**作为总览的子层**开的吗。
   * 决定了三件事：① 开的时候不关总览（`prepareOpen` 的分支）② `Esc` / 关闭只关它这一层
   * ③ 总览自己关掉时把它一起带走（子层不能比父层活得久）。
   */
  asChild: boolean;
  /** 拉回来的数字（null = 还没拿到：加载中 / 失败 / 空库由组件按 loading/failed 区分） */
  data: Stats | null;
  loading: boolean;
  /** 最近一次拉取失败过（显示「读不到统计」，**不假装 0**） */
  failed: boolean;
}>({
  open: false,
  asChild: false,
  data: null,
  loading: false,
  failed: false,
});

let loadSeq = 0;
let lastWrittenSeq = 0;

/**
 * 打开面板 → 重拉一次。
 *
 * round82（11.5）：`asChild` = 「从总览顶栏那个 `▤ 统计` 进来的」——当成总览的**子层**
 * （不关总览、`Esc` 只关自己）；不传 = 顶栏独立入口的旧语义（同级面板）。
 */
export async function openStats(opts: { asChild?: boolean } = {}): Promise<void> {
  // round64（C10）：统计开关关掉 → 入口不出现，这是第二道
  if (!featureOn("stats_enabled")) return;
  stats.asChild = opts.asChild === true;
  prepareOpen("stats"); // round78（栈-01）：先把该关的关掉（子层只关别的子层，不动父面板）
  stats.open = true;
  void note("stats"); // round68（19.1）：暗章信号
  await loadStats();
}

export function closeStats(): void {
  stats.open = false;
  stats.asChild = false;
}

/**
 * round79（78-10）：「重置统计」—— **非破坏**（后端写一个时间界，一条事件不删）。
 * 成功就把后端算好的新数字直接放进 store（不用二拉）；失败返回 false（ipc 层已弹 Toast）。
 */
export async function resetStats(): Promise<boolean> {
  try {
    const data = await resetStatsIpc();
    // round79（6b 二轮 P2）：**认领序号** —— 若此刻还有一次更早发起的 `loadStats()` 在飞，
    // 它回来时 `seq < lastWrittenSeq` 会被丢弃（否则会把重置前的数字盖回来）。
    lastWrittenSeq = ++loadSeq;
    stats.data = data;
    stats.loading = false;
    stats.failed = false;
    return true;
  } catch (err) {
    console.error("[stats] 重置失败", err);
    return false;
  }
}

// round78（栈-01）：注册给面板栈
// round82（11.5）：**kind 是动态的** —— 从总览进来时是子层（不关总览），从顶栏进来时是同级。
registerPanel({
  id: "stats",
  kind: () => (stats.asChild ? "child" : "sibling"),
  isOpen: () => stats.open,
  close: () => (closeStats(), true),
});

/** 拉最新数字。旧的先清掉 + `loading` —— 面板不会拿上一份旧数字冒充最新的 */
export async function loadStats(): Promise<void> {
  const seq = ++loadSeq;
  stats.data = null;
  stats.loading = true;
  stats.failed = false;
  try {
    const data = await getStats();
    // 更晚发起的那次已经写进去了 → 这份过期，丢
    if (seq < lastWrittenSeq) return;
    stats.data = data;
    stats.failed = false;
    lastWrittenSeq = seq;
  } catch (err) {
    // `call()` 已经统一弹过 Toast；这里把面板切到失败态（绝不显示 0 骗人）
    console.error("[stats] 拉统计失败（面板照常，只是没数字）", err);
    if (seq >= lastWrittenSeq) {
      stats.data = null;
      stats.failed = true;
    }
  } finally {
    if (seq >= lastWrittenSeq) stats.loading = false;
  }
}
