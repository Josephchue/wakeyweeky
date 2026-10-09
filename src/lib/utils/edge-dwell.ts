/**
 * 「甩出板子边缘并停住 → 翻到上/下一周」。
 *
 * round27 #8 加给**拖动**；round28 #8（用户实测「拉伸还是没法跨周」）提到这里，**拉伸**也走同一套 ——
 * 两条手势各写一份的话，行为迟早不一样（这个仓库踩过：融合规则抄两份）。
 *
 * 用法：手势循环里每次移动（或自动滚动的每帧）调 `dwellTick(x, host)`；收尾（松手/取消）调 `dwellStop()`。
 * 停住判定的状态（哪条边、定时器）只此一份。
 */

/** 停住多久翻**第一页**（首次延迟） */
export const EDGE_DWELL_MS = 600;
/**
 * 第一页之后，每页之间隔多久（重复间隔）。
 *
 * round29 #4（用户 2026-10-01：“连续翻页稍稍稍稍微快了一点点”）：以前是等间隔 600ms 一路翻，
 * 改成**两段式**（跟 X11 `RepeatKeys` 的初始延迟 / 重复间隔同一个模型，也是翻转类界面常见的做法）：
 * 停住 600ms 翻第一页，抓住节奏后就 900ms 一页 —— 想停就把指针从边上报开。
 */
export const PAGE_INTERVAL_MS = 900;

export type DwellHost = {
  /** -1 = 甩出左边，1 = 甩出右边，0 = 在板子里 */
  edgeDwell: (clientX: number) => -1 | 0 | 1;
  flipWeek: (dir: -1 | 1) => void;
};

let zone: -1 | 0 | 1 = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let currentHost: DwellHost | null = null;

function clearTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

/**
 * 停着不动就**一页一页翻**（round28 #7：用户实测「不是每过一会翻一页，要重新回来再出去，不方便」→
 * 改成继续停在边上就继续翻；要停就在指针上离开那条边）。
 * round29 #4：首次 `EDGE_DWELL_MS`，之后每 `PAGE_INTERVAL_MS`（两段式）。
 */
function schedule(delayMs: number): void {
  timer = setTimeout(() => {
    timer = null;
    if (!currentHost || zone === 0) return;
    currentHost.flipWeek(zone);
    schedule(PAGE_INTERVAL_MS);
  }, delayMs);
}

/** 指针移动时调。换边（或回到板子里）都会重新起计时 —— 「停住 0.6 秒」才算数 */
export function dwellTick(clientX: number, host: DwellHost | null): void {
  const next = host ? host.edgeDwell(clientX) : 0;
  if (next === zone) return;
  clearTimer();
  zone = next;
  currentHost = host;
  if (next !== 0) schedule(EDGE_DWELL_MS);
}

/** 手势收尾（松手 / Esc / cancel）必调 */
export function dwellStop(): void {
  clearTimer();
  zone = 0;
  currentHost = null;
}
