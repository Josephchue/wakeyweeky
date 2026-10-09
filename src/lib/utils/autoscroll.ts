/**
 * 手势中的**自动滚动**（round25③，用户实测：想把块顺着往下拖，界面不跟着滚）。
 *
 * 浏览器只给 **HTML5 拖拽**做自动滚动，pointer 手势（拉伸、拖动）它不管 —— 所以自己来：
 * 指针贴到 `.scroll` 视口边缘以内 `AUTOSCROLL_EDGE_PX` 就开始滚，越贴边越快。
 *
 * 设计：纯函数 `scrollStep` 只回答「往哪个方向滚多少像素」（可单测），
 * `autoScrollTo` 起一条 rAF 循环 —— 指针**停着不动**时也继续滚（这才是「拖到边上等它滚」的手感）。
 */

/** 距边缘多少像素内开始滚 */
const AUTOSCROLL_EDGE_PX = 40;
/** 每帧最大滚动量（约 12px × 60fps = 720px/秒） */
export const AUTOSCROLL_MAX_STEP_PX = 12;

/**
 * 一帧该滚多少：`dx` 正 = 往右滚（内容左移），负 = 往左滚；`dy` 同理（正 = 往下滚）。
 * 指针已经出了容器（拖到窗口外）→ 保持全速，而不是停住。
 */
export function scrollStep(
  pos: { x: number; y: number },
  view: { left: number; top: number; right: number; bottom: number },
): { dx: number; dy: number } {
  return { dx: axisStep(pos.x, view.left, view.right), dy: axisStep(pos.y, view.top, view.bottom) };
}

function axisStep(p: number, lo: number, hi: number): number {
  if (p <= lo) return -AUTOSCROLL_MAX_STEP_PX;
  if (p >= hi) return AUTOSCROLL_MAX_STEP_PX;
  if (p < lo + AUTOSCROLL_EDGE_PX) {
    return -ramp(lo + AUTOSCROLL_EDGE_PX - p);
  }
  if (p > hi - AUTOSCROLL_EDGE_PX) {
    return ramp(p - (hi - AUTOSCROLL_EDGE_PX));
  }
  return 0;
}

/** 距离 → 速度（至少 1px/帧，否则贴边那段几乎不动） */
function ramp(distance: number): number {
  return Math.max(1, Math.round((distance / AUTOSCROLL_EDGE_PX) * AUTOSCROLL_MAX_STEP_PX));
}

let running = false;
let el: HTMLElement | null = null;
let getPos: (() => { x: number; y: number }) | null = null;
let onTick: (() => void) | null = null;

/**
 * 让 `target` 在指针贴边时自动滚。每次指针移动都调它（重复调只是更新指针来源，不会叠加循环）。
 * `tick` 在每一次真的滚了之后调 —— 手势的落点要跟着重量（内容动了，落点也变了）。
 */
export function autoScrollTo(
  target: HTMLElement,
  pos: () => { x: number; y: number },
  tick?: () => void,
): void {
  el = target;
  getPos = pos;
  onTick = tick ?? null;
  if (running) return;
  running = true;
  requestAnimationFrame(frame);
}

/** 停止并忘掉（手势收尾：松手 / Esc / 取消都调） */
export function stopAutoScroll(): void {
  running = false;
  el = null;
  getPos = null;
  onTick = null;
}

function frame(): void {
  if (!running) return;
  const p = getPos?.() ?? null;
  const box = el;
  if (p && box) {
    const r = box.getBoundingClientRect();
    const { dx, dy } = scrollStep(p, { left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    if (dx !== 0 || dy !== 0) {
      box.scrollLeft += dx;
      box.scrollTop += dy;
      onTick?.();
    }
  }
  requestAnimationFrame(frame);
}
