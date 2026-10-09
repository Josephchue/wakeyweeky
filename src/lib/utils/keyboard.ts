/**
 * round31（C1.9 / R42）：键盘操作的**纯逻辑** —— 挪多少、往哪挪、哪个键在什么模式下做什么。
 *
 * 为什么抽出来：组件里的键盘分支 vitest 看不到（round26 教训）；这里只做「算」，不碰 store、不碰 DOM，
 * 所以边界（跨月/跨年、最短 15 分钟、最长 72 小时、抓起前后语义不同）都能用单测钉死。
 *
 * 键位口径（round31 / 2026-10-02 拍板；**round61.1 按你验收意见改了两处**）：
 * - **未拿起**：`↑↓` 修上边缘（起点）、`Shift+↑↓` 修下边缘（时长）；**`←→` 不再搬块**
 *   —— 「移动统一收进拿起」（`Enter` 拿起 → 方向键移动预览 → `Enter` 落地一次写）
 * - **拿起中**：`↑↓` 挪 15 分钟、`Shift+↑↓` 挪 1 小时；`←→` / `Shift+←→` 同上（只改预览；多选同口径）
 * - `W/A/S/D` 是方向键的平行键位；`Enter` 拿起/放下；`Space` 完成；`X` 未完成；`Delete` 删除；`Esc` 取消
 */
import { MAX_BLOCK_HOURS, MIN_BLOCK_MINUTES } from "./timeline";

/** 精调步长（分钟）——与拉伸/后端最小时长一致 */
export const STEP_MINUTES = 15;
/** 抓起模式下的粗调步长（分钟）——用户拍板「1 小时更好」（15 分 / 1 时 / 1 天 / 1 周 的阶梯） */
export const COARSE_MINUTES = 60;

const MIN_SECONDS = MIN_BLOCK_MINUTES * 60;
const MAX_SECONDS = MAX_BLOCK_HOURS * 3600;

/**
 * 按**本地日历日**平移（不用 `ts + n*86400`）：时间轴的列就是按本地 00:00 切的，
 * 跨月 / 跨年 / 夏令时（别埋雷）都不会错位。与 `utils/timeline.ts::segmentIndexOf` 同一套口径。
 */
export function addLocalDays(ts: number, days: number): number {
  const d = new Date(ts * 1000);
  return Math.floor(
    new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate() + days,
      d.getHours(),
      d.getMinutes(),
      d.getSeconds(),
    ).getTime() / 1000,
  );
}

/** 一次「移动」按键 → 新起点（时长不变由后端保持） */
export function moveStartBy(
  startAt: number,
  kind: "step" | "coarse" | "day" | "week",
  dir: 1 | -1,
): number {
  switch (kind) {
    case "step":
      return startAt + dir * STEP_MINUTES * 60;
    case "coarse":
      return startAt + dir * COARSE_MINUTES * 60;
    case "day":
      return addLocalDays(startAt, dir);
    case "week":
      return addLocalDays(startAt, 7 * dir);
  }
}

/**
 * 一次「拉伸」按键 → 新的起止（动一条边，另一条不动）。
 *
 * 越界直接返回 `null`（不写坏数据）：最短 15 分钟、最长 72 小时 ——
 * 与后端 `MIN_BLOCK_SECONDS` / `MAX_BLOCK_SECONDS` 同一套护栏；后端那份仍是最后防线
 * （Rust 侧已有测试），键盘这边不让它有机会报错。
 */
export function stretchRange(
  startAt: number,
  endAt: number,
  edge: "start" | "end",
  dir: 1 | -1,
): { startAt: number; endAt: number } | null {
  return stretchRangeBy(startAt, endAt, edge, dir * STEP_MINUTES);
}

/** 同上，但 delta 直接给分钟（累积连按用；正 = 往后、负 = 往前）
 *  round38：去掉 `export` —— 只在本文件用（knip 报的旧账） */
function stretchRangeBy(
  startAt: number,
  endAt: number,
  edge: "start" | "end",
  minutes: number,
): { startAt: number; endAt: number } | null {
  const delta = minutes * 60;
  const next =
    edge === "start" ? { startAt: startAt + delta, endAt } : { startAt, endAt: endAt + delta };
  const clamped = clampRange(next.startAt, next.endAt, edge);
  if (clamped.startAt === startAt && clamped.endAt === endAt) return null;
  return clamped;
}

/**
 * 把一段时长夹进 [最短 15 分钟, 最长 72 小时]：动哪条边就夹哪条边。
 * 连按累积一大步时用（等价于后端不报错、在边界上停住）。
 */
export function clampRange(
  startAt: number,
  endAt: number,
  edge: "start" | "end",
): { startAt: number; endAt: number } {
  let start = startAt;
  let end = endAt;
  const span = end - start;
  if (span < MIN_SECONDS) {
    if (edge === "end") end = start + MIN_SECONDS;
    else start = end - MIN_SECONDS;
  } else if (span > MAX_SECONDS) {
    if (edge === "end") end = start + MAX_SECONDS;
    else start = end - MAX_SECONDS;
  }
  return { startAt: start, endAt: end };
}

/** 键盘动作（`resolveKey` 的产物；store 按类型执行） */
export type KeyAction =
  | { type: "move"; kind: "step" | "coarse" | "day" | "week"; dir: 1 | -1 }
  | { type: "stretch"; edge: "start" | "end"; dir: 1 | -1 }
  | { type: "grab" }
  | { type: "drop" }
  | { type: "cancel" }
  | { type: "delete" }
  | { type: "done" }
  | { type: "missed" };

/**
 * 按键 → 动作（唯一判定处）。返回 `null` = 不归我们管（调用方不要 `preventDefault`）。
 *
 * 只认**单个键**的语义；`Ctrl` 组合由调用方先处理（撤销/重做），不进这里。
 */
export function resolveKey(
  key: string,
  opts: { shift: boolean; grabbed: boolean },
): KeyAction | null {
  const k = key.toLowerCase();
  const vertical = { arrowup: -1, w: -1, arrowdown: 1, s: 1 }[k] as 1 | -1 | undefined;
  const horizontal = { arrowleft: -1, a: -1, arrowright: 1, d: 1 }[k] as 1 | -1 | undefined;

  if (opts.grabbed) {
    if (vertical) return { type: "move", kind: opts.shift ? "coarse" : "step", dir: vertical };
    if (horizontal) return { type: "move", kind: opts.shift ? "week" : "day", dir: horizontal };
  } else {
    if (vertical) return { type: "stretch", edge: opts.shift ? "end" : "start", dir: vertical };
    // round61.1（你验收意见）：**未拿起不再 ←→ 搬块** —— 移动统一收进拿起（Enter → 预览 → Enter 落地）。
    // 返回 null → 调用方不 preventDefault；选中块时调用方也不会落到「跳周」那一条（见 Timeline 的 `if (!action) return`）。
  }

  switch (k) {
    case "enter":
      return { type: opts.grabbed ? "drop" : "grab" };
    case "escape":
      return { type: "cancel" };
    case "delete":
      return { type: "delete" };
    case " ":
    case "space": // 真实浏览器给 " "；合成事件/旧代码可能给 "Space"，两个都认
      return { type: "done" };
    case "x":
      return { type: "missed" };
    default:
      return null;
  }
}
