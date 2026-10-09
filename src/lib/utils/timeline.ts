import { getSlotStartSec, SLOT_COUNT, SLOT_MINUTES } from "./week";

/** 一格的高度（px）的**默认值**（舒适档）—— 实际值在运行时由密度决定，见下面的 provider */
export const DEFAULT_SLOT_HEIGHT_PX = 30;
/**
 * round76（3.1a）：格高的**运行时来源**。
 *
 * 为什么用 provider 而不是常量：三档密度（`--slot-height` 26/30/34）要同时驱动 CSS 与这套手势数学。
 * 由 `stores/appearance.svelte.ts` 注入一个读 `$state` 的 getter —— 于是**在 `$derived` 里调用
 * `secondsToPx` 就会自动建立依赖**，密度一改几何全部重算（不需要在组件里手写任何依赖）。
 * 单测里可以直接 `setSlotHeightProvider(() => 26)` 跑三档。
 */
let slotHeightProvider: () => number = () => DEFAULT_SLOT_HEIGHT_PX;

/** 注入格高来源（app 启动时由 appearance store 调一次；测试里也用它跑三档） */
export function setSlotHeightProvider(fn: () => number): void {
  slotHeightProvider = fn;
}

/** 当前格高（px）—— **必须与 `tokens.css` 的 `--slot-height` 一致**（预览断言逐档核对） */
export function slotHeightPx(): number {
  return slotHeightProvider();
}

/** 一天列的高度 = 48 格 × 当前格高（00:00–24:00） */
export function dayHeightPx(): number {
  return SLOT_COUNT * slotHeightPx();
}

/** 天列列头的高度（px）。`Timeline.svelte` 的 `.day-head` 与 `.gutter` 的 `padding-top` 必须与它一致
    （CSS 侧对应 `--day-head-height`：round77 日头 24→28，这里同步改，否则辅助线/胶囊恒定偏 4px） */
export const DAY_HEAD_PX = 28;

/** 块在列内上下各内缩 1px —— 这样 30 分钟的块与 MVP 格子视觉完全一致 */
const INSET_PX = 1;
/** 上面那个内缩值对外只读一份：手势换算要用它把「块盒子边缘」还原成「真实时刻线」 */
export const BLOCK_INSET_PX = INSET_PX;
/**
 * round85（0.31.0 · §5-DU）：**动作浮层的落点** —— 块在视图里不够高时，把浮层移到块**外沿**，
 * 别盖住块身（你 2026-10-08 澄清：判据只看「视图里够不够大」，不看时长 —— 同一个 60 分钟的块
 * 在最小刻度 18 下也只有 36px）。
 *
 * · `inline`：块够高（≥ `OVERLAY_SHORT_PX`）→ 浮层照旧悬浮在块中央
 * · `below`：块矮、且块下面留得下浮层（含 26px 余量）→ 贴块**下**沿外侧
 * · `above`：块矮、贴列底（下面放不下）→ 贴块**上**沿外侧
 *
 * round87.2（你 2026-10-09 拍）：**优先放块下面** —— 旧顺序是先上后下（你看到的浮层冒出块顶），
 * 现在反过来：只有块贴着列底、下面确实放不下，才挂到块上面。
 *
 * 浮层高按**最坏情况**算：整宽块 38px（一排 32px 按钮）；并排窄块 142px（24px 按钮 + flex-wrap，
 * 最多 5 枚 → 5 行）—— 宁可多落几块到另一边（观感等价），也不让浮层被裁。
 */
const OVERLAY_WIDE_PX = 38;
const OVERLAY_NARROW_PX = 142;
/** 「浮层外沿要留多少余量」（贴列顶判定用）—— `overlayAnchor` 与 `TaskBlock` 的实测路径共用 */
export const OVERLAY_MARGIN_PX = 26;
/** 「块身最低要留多少可拖空间」= 上下各 4px 把手 + 4px 拖拽面（`overlayAnchor` 与实测路径共用） */
export const OVERLAY_FACE_PX = 16;
/** 块矮到「浮层压不住块身」的阈值（整宽口径）：38 浮层 + 上下把手与拖拽面 */
export const OVERLAY_SHORT_PX = OVERLAY_WIDE_PX + OVERLAY_FACE_PX;
/** 贴列顶时要留的列内空间（宽块口径 = 38 + 26；别动：宽块已按它验过） */
export const OVERLAY_TOP_ROOM_PX = OVERLAY_WIDE_PX + OVERLAY_MARGIN_PX;

/** 这一截块该把动作浮层放哪（`box` = `layoutDay` 的盒子：像素高 / 列内顶部偏移 / 并排数） */
export function overlayAnchor(box: { top: number; height: number; colCount?: number }):
  | "inline"
  | "above"
  | "below" {
  if (box.height >= OVERLAY_SHORT_PX) return "inline";
  const narrow = (box.colCount ?? 1) > 1;
  const need = narrow ? OVERLAY_NARROW_PX + OVERLAY_MARGIN_PX : OVERLAY_TOP_ROOM_PX;
  // round87.2：**优先下面**（你 2026-10-09 拍）；下面放不下才上面；两边都不够（列很短/块贴底）也落下面
  const roomBelow = dayHeightPx() - (box.top + box.height);
  if (roomBelow >= need) return "below";
  if (box.top >= need) return "above";
  return "below";
}

/** 一格的秒数 */
const SLOT_SECONDS = SLOT_MINUTES * 60;
/** 块的最小时长（分钟）——与后端 `MIN_BLOCK_SECONDS` 一致（v2 ⑧B「最小 15 分钟步进」） */
export const MIN_BLOCK_MINUTES = 15;
/**
 * 单个块的最长时长：**72 小时（3 天）** —— 与后端 `MAX_BLOCK_SECONDS` 一致。
 * round25（用户 2026-10-01 拍板：「放宽到好几天，比如最多 3 天」）：原来 24 小时 → 72 小时。
 * 不设上限会让一个块吃掉整周，并排布局与顺延都看不下去。
 */
export const MAX_BLOCK_HOURS = 72;
const MAX_BLOCK_SECONDS = MAX_BLOCK_HOURS * 3600;
/** 每秒多少像素（跟着当前格高走） */
const pxPerSecond = () => slotHeightPx() / SLOT_SECONDS;

/** 布局只关心「一个时间段」，不依赖 Block 的其它字段 */
export type Span = { id: string; start_at: number; end_at: number };

/** 渲染一个块所需的几何：相对天列顶部的位置 + 横向第几列 / 共几列 */
export type BlockBox = {
  id: string;
  top: number;
  height: number;
  colIndex: number;
  colCount: number;
  /**
   * round69.1（#1）：**复制**手势里原地留着的「原块那一份」（同 id 的预览盒同时在）。
   * 渲染 key 要带后缀（否则 `{#each (box.id)}` 抛 `each_key_duplicate`）；注意**预览盒仍用裸 id**——
   * 这样手势期间 DOM 元素会被复用（不被销毁重建），指针捕获 / 把手引用才不会断。
   */
  sourceCopy?: boolean;
};

export function secondsToPx(seconds: number): number {
  return seconds * pxPerSecond();
}

export function pxToSeconds(px: number): number {
  return px / pxPerSecond();
}

/**
 * 屏幕坐标 → 这一列的时刻（**不夹取**：可以算出前一天/后一天的时刻）。
 *
 * round25④（用户实测：拉伸中用滚轮之后下边缘就不跟鼠标了）：旧实现算的是「指针相对起点的位移」，
 * 滚轮一动内容上移，位移就对不上；**绝对换算**（指针屏幕位置 - 列体屏幕位置）天然跟着滚动走，
 * 自动滚动也会一直贴在指针下。
 */
export function timeAtClientY(clientY: number, bodyTop: number, dayStartSec: number): number {
  return dayStartSec + pxToSeconds(clientY - bodyTop);
}

/**
 * 拉伸落点的「列内时刻」（round26 #4）：把指针（视觉上那条边）的 y 换算成**这一列**的时刻。
 *
 * **夹在这一列之内**：向下最多到 24:00（再往下拖也不越过当天），向上最多到 00:00 ——
 * 想让终点/起点跨天，得**把指针拖到下一列/前一列**（用户点名的手感：指针在哪一列就落在哪一列）。
 * 吸附 **15 分钟**，以这一列的 00:00 为基准。
 */
export function timeInColumn(clientY: number, bodyTop: number, dayStartSec: number): number {
  return snapTime(
    timeAtClientY(clientY, bodyTop, dayStartSec),
    dayStartSec,
    MIN_BLOCK_MINUTES,
    dayStartSec,
    dayStartSec + SLOT_COUNT * SLOT_MINUTES * 60,
  );
}

/**
 * 指针横坐标落在哪一列：`limits` 之内（含刻度栏那一条）→ **取中心最近的那一列**；之外 → -1。
 *
 * round25②（用户实测：块拖不到隔壁列）：旧实现用「事件落在哪个 `.day-body`」= 浏览器给的拖拽目标；
 * 真机上那个目标横向不更新 → 落点永远留在原列。现在**只看指针坐标**：列缝、列边框、
 * 吸顶日头、刻度栏都算数，落点不再依赖浏览器怎么派发事件。
 */
export function dayIndexAtX(
  clientX: number,
  columns: { left: number; right: number }[],
  limits: { left: number; right: number },
): number {
  if (columns.length === 0) return -1;
  if (clientX < limits.left || clientX > limits.right) return -1;
  return nearestDayIndex(clientX, columns);
}

/**
 * 离得最近的那一列（**永不返回 -1**）。
 *
 * 拉伸落点用它（round26 #4）：指针拖到 Backlog 上、拖到窗口外也不能丢手势 ——
 * 横向夹到最近的一列，而不是像拖动落点那样变成「没落在板子里」。
 */
export function nearestDayIndex(
  clientX: number,
  columns: { left: number; right: number }[],
): number {
  if (columns.length === 0) return -1;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < columns.length; i++) {
    const center = (columns[i].left + columns[i].right) / 2;
    const distance = Math.abs(clientX - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * 把时刻取整到 `stepMinutes` 的整数倍，再夹进 `[minTs, maxTs]`。
 *
 * 取整**以 `anchor` 为基准**而不是 epoch：时间轴是按「当天 06:00」起算的，
 * 而且按 epoch 取整在半小时/三刻钟偏移的时区里会跟本地时刻错位。
 */
export function snapTime(
  ts: number,
  anchor: number,
  stepMinutes: number,
  minTs: number,
  maxTs: number,
): number {
  const step = stepMinutes * 60;
  const snapped = anchor + Math.round((ts - anchor) / step) * step;
  return Math.min(Math.max(snapped, minTs), maxTs);
}

/**
 * 已占用时段：**块覆盖到的每一格**都算占用（旧实现只记起始那一格 ✗）。
 *
 * 判定用「碰到就算占用」：10:15–10:45 会同时占住 10:00 与 10:30 两格 ——
 * 否则漂洗建议会推荐一段其实会重叠的时间。
 */
export function occupiedSlots(
  spans: Span[],
  stepSeconds: number = SLOT_SECONDS,
): Set<number> {
  const occupied = new Set<number>();
  for (const s of spans) {
    let slot = slotFloor(s.start_at, stepSeconds);
    while (slot < s.end_at) {
      occupied.add(slot);
      slot += stepSeconds;
    }
  }
  return occupied;
}

/** 把时刻向下对齐到**本地**网格（时间轴按本地时刻画，按 epoch 对齐会在半小时时区里错位） */
function slotFloor(ts: number, stepSeconds: number): number {
  const d = new Date(ts * 1000);
  const midnight = Math.floor(
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000,
  );
  return midnight + Math.floor((ts - midnight) / stepSeconds) * stepSeconds;
}

/**
 * round29 #8（你问「每段只写本段区间，分不清是一段还是两段」）：段号标注要的两个纯函数。
 *
 * 「段」= 这个块碰到的**日历天**（时间轴一天一列，跨天块在每一列画一截）。
 * 按**块自己的跨度**数，不按「本周看得见几截」数 —— 否则跨周的块在两周边各显示 1/1，角标就没意义了。
 * 终点正好落在 00:00 时不算新的一天（用 `end - 1` 秒定最后一段）。
 */
export function segmentIndexOf(dayStart: number, startAt: number): number {
  // 用「本地天的差」而不是整除 86400：夏令时那两天一天 23/25 小时（中国没有，但别埋雷）
  const first = getSlotStartSec(new Date(startAt * 1000), 0);
  return Math.round((dayStart - first) / 86400) + 1;
}

/** 这个块一共分成几段（几段 = 最后一个日历天的序号） */
export function segmentCount(startAt: number, endAt: number): number {
  return segmentIndexOf(getSlotStartSec(new Date((endAt - 1) * 1000), 0), startAt);
}

/**
 * 一天的布局：重叠的块横向分列（各分等宽），不重叠的块整宽。
 *
 * - 只处理落在 `[dayStartSec, dayEndSec)` 里的部分，越界的部分裁掉
 * - 「重叠」是严格判定：首尾相接（10:00–10:30 与 10:30–11:00）**不算重叠**，两块都整宽
 * - 分列用「按开始时间贪心选第一条已经空出来的列」——区间图下这样得到的列数就是最优值
 */
export function layoutDay(
  spans: Span[],
  dayStartSec: number,
  dayEndSec: number,
): BlockBox[] {
  // filter 已经返回新数组，直接原地排序，不会动调用方的数组
  const visible = spans
    .filter((s) => s.end_at > dayStartSec && s.start_at < dayEndSec)
    .sort((a, b) => a.start_at - b.start_at || (a.id < b.id ? -1 : 1));

  const cols = assignColumns(visible);
  return visible.map((s, i) =>
    boxWithRange(s, cols[i].colIndex, cols[i].colCount, dayStartSec, dayEndSec),
  );
}

/** 一个区间的横向位置：第几列 / 一共几列 */
type ColumnAssign = { colIndex: number; colCount: number };

/**
 * round82（11.1）：**按开始时间贪心分列**的纯函数 —— 主时间轴的 `layoutDay` 与迷你周视图**共用这一份**
 * （以前只有主时间轴会并排，迷你视图是叠着画的 → 两个视图行为不一致，你 2026-10-06 指出的正是它）。
 *
 * - 入参**必须已按 `start_at` 升序**（`layoutDay` 里排过；迷你视图按当天分段排）；
 * - 返回与入参**平行的数组**（同一下标 = 同一个区间）；
 * - 「重叠」是严格判定：首尾相接不算重叠；
 * - 分簇（簇之间的区间互不重叠）各自从 0 开始数 —— 与区间图的最优列数一致。
 */
export function assignColumns(spans: { start_at: number; end_at: number }[]): ColumnAssign[] {
  const out: ColumnAssign[] = new Array(spans.length);
  let cluster: number[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;
  let colEnds: number[] = [];

  const flush = () => {
    for (const i of cluster) {
      const s = spans[i];
      let col = colEnds.findIndex((end) => end <= s.start_at);
      if (col === -1) {
        colEnds.push(s.end_at);
        col = colEnds.length - 1;
      } else {
        colEnds[col] = s.end_at;
      }
      out[i] = { colIndex: col, colCount: 1 };
    }
    for (const i of cluster) out[i].colCount = colEnds.length;
    cluster = [];
    colEnds = [];
    clusterEnd = Number.NEGATIVE_INFINITY;
  };

  spans.forEach((s, i) => {
    if (cluster.length > 0 && s.start_at >= clusterEnd) flush();
    cluster.push(i);
    clusterEnd = Math.max(clusterEnd, s.end_at);
  });
  if (cluster.length > 0) flush();
  return out;
}

/**
 * 按给定范围算一个块的几何（顶距与高度）；横向列号由调用方给。
 *
 * 拉伸预览靠它：手势中**列号列数一律不动**，只把 top/height 换成预览时间的值
 * —— 否则拉高后与旁边的块并成一簇、列数变化，块会在拖动中横向跳走（用户实测反馈）。
 */
export function boxWithRange(
  s: Span,
  colIndex: number,
  colCount: number,
  dayStartSec: number,
  dayEndSec: number,
): BlockBox {
  const start = Math.max(s.start_at, dayStartSec);
  const end = Math.min(s.end_at, dayEndSec);
  return {
    id: s.id,
    top: secondsToPx(start - dayStartSec) + INSET_PX,
    height: Math.max(secondsToPx(end - start) - INSET_PX * 2, 1),
    colIndex,
    colCount,
  };
}

/** 拉伸的哪一条边：下边缘改 `end_at`，上边缘改 `start_at` */
export type ResizeEdge = "top" | "bottom";

/**
 * 拉伸：把「拖动位移」换算成新的 `[start, end)`。
 *
 * - **15 分钟步进**（与 30 分钟格解耦），以**这一列**的起点为基准
 * - 最少 15 分钟：下边缘不能拉过 `start + 15min`，上边缘不能拉过 `end - 15min`
 * - 整块时长封顶 **72 小时（3 天）**：下边缘不能拉过 `起点 + 72h`，上边缘不能拉过 `终点 - 72h`
 *   （round25：不再夹在「当天 24:00」∓1 天；用户要能表达跨好几天）
 * - 上边缘**能往回跨天**（round25 用户拍板「想往前拖几天就拖几天」，同样受 72 小时管）
 * - 两边的下/上限都**永不低于现终点 / 不高于现起点** —— 免得碰一下就把跨天块截短
 * - 纯函数：拖动中每一帧都调它，但**不写库**（松手才落库）
 */
export function resizeRange(
  orig: { start_at: number; end_at: number },
  edge: ResizeEdge,
  deltaSeconds: number,
  dayStartSec: number,
): { start_at: number; end_at: number } {
  const minSeconds = MIN_BLOCK_MINUTES * 60;

  if (edge === "bottom") {
    const maxEnd = Math.max(orig.start_at + MAX_BLOCK_SECONDS, orig.end_at);
    const end = snapTime(
      orig.end_at + deltaSeconds,
      dayStartSec,
      MIN_BLOCK_MINUTES,
      orig.start_at + minSeconds,
      maxEnd,
    );
    return { start_at: orig.start_at, end_at: end };
  }

  const minStart = Math.min(orig.end_at - MAX_BLOCK_SECONDS, orig.start_at);
  const start = snapTime(
    orig.start_at + deltaSeconds,
    dayStartSec,
    MIN_BLOCK_MINUTES,
    minStart,
    orig.end_at - minSeconds,
  );
  return { start_at: start, end_at: orig.end_at };
}
