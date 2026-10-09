/**
 * round81（3.1c₁ · `宽-02` / `宽-04` / `宽-08`）：Ctrl+滚轮的**累积器**（纯函数，可单测）。
 *
 * 为什么需要它：触控板捏合会连发很多**小 delta**（`wheel` + `ctrlKey`），
 * 一个 delta 走一档会让刻度乱跳；鼠标滚轮一格却是 ~100–120。所以按「累积到阈值才走一档」。
 *
 * 约定：`push(deltaY)` 返回**这次该走几档**，正数 = 往下滚（delta 为正的方向），调用方决定
 * 正方向是「放大 / 加宽」还是反过来（两边各自一份累积器，指针在两个区域间移动不会串台）。
 * 单次最多走 2 档（防一格 1000 的大 delta 直接跳到底），余量留在累积器里。
 */
export const WHEEL_STEP_PX = 100;

export interface WheelAccumulator {
  /** 推一次 `deltaY` → 该走几档（-2…2；0 = 还没到阈值） */
  push(deltaY: number): number;
  reset(): void;
}

export function createWheelAccumulator(step = WHEEL_STEP_PX): WheelAccumulator {
  let acc = 0;
  return {
    push(deltaY: number): number {
      if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
      acc += deltaY;
      const raw = Math.trunc(acc / step);
      if (raw === 0) return 0;
      const applied = Math.max(-2, Math.min(2, raw));
      acc -= applied * step;
      // 余量封顶一档：大 delta（快速滚轮 / 长按）不在后面几步里“补跳”
      if (Math.abs(acc) > step) acc = Math.sign(acc) * step;
      return applied;
    },
    reset() {
      acc = 0;
    },
  };
}
