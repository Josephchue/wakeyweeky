import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLOT_HEIGHT_PX,
  MIN_BLOCK_MINUTES,
  boxWithRange,
  dayHeightPx,
  dayIndexAtX,
  layoutDay,
  nearestDayIndex,
  occupiedSlots,
  overlayAnchor,
  OVERLAY_SHORT_PX,
  pxToSeconds,
  resizeRange,
  secondsToPx,
  segmentCount,
  segmentIndexOf,
  setSlotHeightProvider,
  slotHeightPx,
  snapTime,
  timeAtClientY,
  timeInColumn,
  type Span,
} from "./timeline";
import { DENSITIES, DENSITY_SCALE } from "./appearance";

/** 2026-10-12（周一）的本地时刻 → 秒级时间戳 */
const at = (hour: number, minute = 0, day = 12) =>
  Math.floor(new Date(2026, 9, day, hour, minute, 0).getTime() / 1000);

/** 当天列的窗口（**函数参数**，与时间轴起点无关）——这些用例拿 06:00–24:00 这一段当样本；
 *  真实窗口从 round24 起是整天 00:00–24:00 */
const DAY_START = at(6);
const DAY_END = at(24);

const span = (id: string, start: number, end: number): Span => ({
  id,
  start_at: start,
  end_at: end,
});

describe("像素换算", () => {
  it("默认（舒适）= 30px 一格，一天列 = 48 格（round24：时间轴改成整天 00:00–24:00）", () => {
    expect(slotHeightPx()).toBe(DEFAULT_SLOT_HEIGHT_PX);
    expect(secondsToPx(1800)).toBe(DEFAULT_SLOT_HEIGHT_PX);
    expect(dayHeightPx()).toBe(48 * DEFAULT_SLOT_HEIGHT_PX);
  });

  it("反算也一致", () => {
    expect(pxToSeconds(DEFAULT_SLOT_HEIGHT_PX)).toBe(1800);
  });

  /** round76（3.1a）：格高改成**运行时可设**（三档密度共用同一套手势数学）——
   *  这三段就是「密度改了，拖动/拉伸的落点跟着改」的机器证据。 */
  it("格高跟着密度走：三档各自的换算都对", () => {
    for (const density of DENSITIES) {
      const px = DENSITY_SCALE[density].slotHeight;
      setSlotHeightProvider(() => px);
      expect(slotHeightPx()).toBe(px);
      expect(secondsToPx(1800)).toBe(px); // 一格 30 分钟 = 一个格高
      expect(secondsToPx(3600)).toBe(px * 2);
      expect(pxToSeconds(px)).toBe(1800);
      expect(dayHeightPx()).toBe(48 * px);
      expect(timeAtClientY(500 + px, 500, DAY_START)).toBe(DAY_START + 1800);
      expect(timeInColumn(500 + px, 500, DAY_START)).toBe(DAY_START + 1800);
    }
    setSlotHeightProvider(() => DEFAULT_SLOT_HEIGHT_PX); // 收尾：别把默认档留给后面的用例
  });
});

describe("snapTime", () => {
  it("按 15 分钟取整到最近", () => {
    expect(snapTime(at(10, 7), DAY_START, 15, DAY_START, DAY_END)).toBe(at(10));
    expect(snapTime(at(10, 8), DAY_START, 15, DAY_START, DAY_END)).toBe(at(10, 15));
  });

  it("夹在给定区间内（不产生越界时间）", () => {
    expect(snapTime(at(5), DAY_START, 15, DAY_START, DAY_END)).toBe(DAY_START);
    expect(snapTime(at(23, 59), DAY_START, 15, DAY_START, DAY_END)).toBe(DAY_END);
  });

  it("以基准取整，而不是按 epoch 取整", () => {
    const anchor = at(6, 7);
    const snapped = snapTime(at(6, 20), anchor, 15, 0, DAY_END);
    // 按基准取整 → 06:22（相对 anchor 正好是 15 分钟的整数倍）
    expect(snapped).toBe(at(6, 22));
    expect((snapped - anchor) % 900).toBe(0);
  });
});

describe("occupiedSlots", () => {
  it("30 分钟的块只占自己那一格", () => {
    expect([...occupiedSlots([span("a", at(10), at(10, 30))])]).toEqual([at(10)]);
  });

  it("90 分钟的块占满它覆盖的 3 格", () => {
    const slots = [...occupiedSlots([span("a", at(10), at(11, 30))])].sort(
      (x, y) => x - y,
    );
    expect(slots).toEqual([at(10), at(10, 30), at(11)]);
  });

  it("错开 15 分钟的块占 2 格（碰到就算占用）", () => {
    const slots = [...occupiedSlots([span("a", at(10, 15), at(10, 45))])].sort(
      (x, y) => x - y,
    );
    expect(slots).toEqual([at(10), at(10, 30)]);
  });

  it("相邻不重叠的块互不覆盖", () => {
    const slots = occupiedSlots([
      span("a", at(10), at(10, 30)),
      span("b", at(10, 30), at(11)),
    ]);
    expect(slots.size).toBe(2);
  });

  it("空列表 → 空集合", () => {
    expect(occupiedSlots([]).size).toBe(0);
  });
});

describe("layoutDay", () => {
  it("30 分钟的块：上下各内缩 1px（与 MVP 格子视觉一致）", () => {
    const [box] = layoutDay([span("a", at(10), at(10, 30))], DAY_START, DAY_END);
    // 10:00 = 从 06:00 起第 8 格（round76：舒适档 = 30px/格，8 × 30 = 240）
    expect(box.top).toBe(8 * DEFAULT_SLOT_HEIGHT_PX + 1);
    expect(box.height).toBe(DEFAULT_SLOT_HEIGHT_PX - 2);
  });

  it("90 分钟的块高度 = 3 格（减去内缩）", () => {
    const [box] = layoutDay([span("a", at(10), at(11, 30))], DAY_START, DAY_END);
    expect(box.top).toBe(8 * DEFAULT_SLOT_HEIGHT_PX + 1);
    expect(box.height).toBe(3 * DEFAULT_SLOT_HEIGHT_PX - 2);
  });

  it("同一时段两块 → 并排两列", () => {
    const boxes = layoutDay(
      [span("a", at(10), at(10, 30)), span("b", at(10), at(10, 30))],
      DAY_START,
      DAY_END,
    );
    expect(boxes.map((b) => [b.id, b.colIndex, b.colCount])).toEqual([
      ["a", 0, 2],
      ["b", 1, 2],
    ]);
  });

  it("部分重叠 → 只在重叠的那一段并排", () => {
    const boxes = layoutDay(
      [span("a", at(10), at(11)), span("b", at(10, 30), at(11, 30))],
      DAY_START,
      DAY_END,
    );
    expect(boxes.map((b) => b.colCount)).toEqual([2, 2]);
  });

  it("三块互相重叠 → 三列", () => {
    const boxes = layoutDay(
      [
        span("a", at(10), at(12)),
        span("b", at(10, 30), at(11, 30)),
        span("c", at(11), at(11, 30)),
      ],
      DAY_START,
      DAY_END,
    );
    expect(boxes.map((b) => b.colCount)).toEqual([3, 3, 3]);
  });

  it("相邻（首尾相接）不重叠 → 不并排，各自整宽", () => {
    const boxes = layoutDay(
      [span("a", at(10), at(10, 30)), span("b", at(10, 30), at(11))],
      DAY_START,
      DAY_END,
    );
    expect(boxes.map((b) => [b.colCount, b.colIndex])).toEqual([
      [1, 0],
      [1, 0],
    ]);
  });

  it("越出可视窗的块被裁到列内", () => {
    // 05:00–07:00 落在窗内的部分只有 06:00–07:00 = 2 格
    const [box] = layoutDay([span("a", at(5), at(7))], DAY_START, DAY_END);
    expect(box.top).toBe(1);
    expect(box.height).toBe(2 * DEFAULT_SLOT_HEIGHT_PX - 2);
  });

  it("完全在窗外的块不返回", () => {
    expect(layoutDay([span("a", at(1), at(2))], DAY_START, DAY_END)).toEqual([]);
  });

  it("按开始时间排序", () => {
    const boxes = layoutDay(
      [
        span("c", at(11), at(11, 30)),
        span("a", at(9), at(9, 30)),
        span("b", at(10), at(10, 30)),
      ],
      DAY_START,
      DAY_END,
    );
    expect(boxes.map((b) => b.id)).toEqual(["a", "b", "c"]);
  });
});

describe("boxWithRange（拉伸预览用）", () => {
  it("与 layoutDay 对同一个块算出的几何完全一致", () => {
    const s = span("a", at(10), at(11, 30));
    const [fromLayout] = layoutDay([s], DAY_START, DAY_END);
    expect(boxWithRange(s, 0, 1, DAY_START, DAY_END)).toEqual(fromLayout);
  });

  it("列号列数由调用方给 —— 预览时不重算，所以块不会横向跳", () => {
    const box = boxWithRange(span("a", at(10), at(11)), 1, 2, DAY_START, DAY_END);
    expect(box.colIndex).toBe(1);
    expect(box.colCount).toBe(2);
    expect(box.top).toBe(8 * DEFAULT_SLOT_HEIGHT_PX + 1);
    expect(box.height).toBe(2 * DEFAULT_SLOT_HEIGHT_PX - 2);
  });

  it("越出可视窗时同样裁切", () => {
    const box = boxWithRange(span("a", at(5), at(7)), 0, 1, DAY_START, DAY_END);
    expect(box.top).toBe(1);
    expect(box.height).toBe(2 * DEFAULT_SLOT_HEIGHT_PX - 2);
  });
});

describe("resizeRange", () => {
  /** 10:00–10:30 的块（常见情形） */
  const orig = { start_at: at(10), end_at: at(10, 30) };
  const bottom = (deltaMinutes: number) =>
    resizeRange(orig, "bottom", deltaMinutes * 60, DAY_START);
  const top = (deltaMinutes: number) => resizeRange(orig, "top", deltaMinutes * 60, DAY_START);

  it("下边缘拖到 20 分钟的位置 → 落到最近的 15 分钟", () => {
    const r = bottom(20);
    expect(r.end_at).toBe(at(10, 45));
    expect(r.start_at).toBe(at(10)); // 起点不能动
  });

  it("下边缘往回拖 10 分钟 → 正好 15 分钟", () => {
    expect(bottom(-10)).toEqual({ start_at: at(10), end_at: at(10, 15) });
  });

  it("下边缘往回拖过头 → 夹在 15 分钟，不会拉成负时长", () => {
    expect(bottom(-40)).toEqual({ start_at: at(10), end_at: at(10, 15) });
  });

  it("下边缘拖过 24:00 → 能跨进次日；上限 = 起点 + **72 小时**（round25 用户拍板：最多跨 3 天）", () => {
    expect(bottom(60).end_at).toBe(at(11, 30)); // 普通情形不变：10:30 再拖 1 小时 = 11:30
    expect(bottom(24 * 60).end_at).toBe(at(10, 30, 13)); // 从现终点（10:30）再拖一整天 → 次日 10:30
    expect(bottom(50 * 60).end_at).toBe(at(12, 30, 14)); // 拖 50 小时 → 第 3 天 12:30
    expect(bottom(7 * 24 * 60).end_at).toBe(at(10, 0, 15)); // 再远也夹在「起点 + 72 小时」
  });

  it("跨 3 天的块（跨 3 个 0 点）也是合法的（后端上限同为 72 小时）", () => {
    const threeDays = resizeRange(orig, "bottom", 72 * 3600, DAY_START);
    expect(threeDays.end_at - threeDays.start_at).toBe(72 * 3600);
  });

  it("跨天的块（终点已过 24:00）不会被「一碰就截短」", () => {
    const across = { start_at: at(21), end_at: at(14, 30, 13) }; // 21:00 → 次日 14:30
    const barely = resizeRange(across, "bottom", -24, DAY_START);
    expect(barely.end_at).toBe(across.end_at); // 该夹回它自己，而不是 24:00
    const longer = resizeRange(across, "bottom", 60 * 60, DAY_START);
    expect(longer.end_at).toBe(at(15, 30, 13)); // 还能继续往次日拖
  });

  it("上边缘往早上拖 → 只改起点，终点不动", () => {
    const r = top(-20);
    expect(r.start_at).toBe(at(9, 45));
    expect(r.end_at).toBe(at(10, 30)); // 终点不能动
  });

  it("上边缘往下拖过头 → 夹在「终点前 15 分钟」", () => {
    expect(top(60)).toEqual({ start_at: at(10, 15), end_at: at(10, 30) });
  });

  it("上边缘能往回跨天（round25 用户拍板「想往前拖几天就拖几天」）", () => {
    expect(top(-20 * 60).start_at).toBe(at(14, 0, 11)); // 10:00 往前 20 小时 → 前一天 14:00
    expect(top(-30 * 60).start_at).toBe(at(4, 0, 11)); // 再往前 → 前一天 04:00
  });

  it("上边缘也受 72 小时总长管：夹在「终点 - 72 小时」", () => {
    expect(top(-7 * 24 * 60).start_at).toBe(at(10, 30, 9)); // 10:30 - 72h = 3 天前 10:30
  });

  it("起点不在 15 分钟格上时，也不会短于 15 分钟", () => {
    const odd = { start_at: at(10, 7), end_at: at(10, 30) };
    const r = resizeRange(odd, "bottom", -60 * 60, DAY_START);
    expect(r.end_at - r.start_at).toBe(MIN_BLOCK_MINUTES * 60);
  });
});

describe("timeAtClientY（round25④：绝对值换算，不受滚动影响）", () => {
  it("列体顶部 = 当天 00:00；往下一格 = 半小时（round76：舒适档 30px）", () => {
    expect(timeAtClientY(500, 500, DAY_START)).toBe(DAY_START);
    expect(timeAtClientY(500 + slotHeightPx(), 500, DAY_START)).toBe(DAY_START + 1800);
  });

  it("指针跑到列体上方（往上拉过 0 点）→ 算出来的时刻是前一天（不夹取）", () => {
    expect(timeAtClientY(500 - slotHeightPx(), 500, DAY_START)).toBe(DAY_START - 1800);
  });

  it("列体因为滚动而上移时（bodyTop 变小），同一屏幕位置算出的时刻跟着变大（跟手）", () => {
    const before = timeAtClientY(800, 500, DAY_START);
    const after = timeAtClientY(800, 500 - 2 * DEFAULT_SLOT_HEIGHT_PX, DAY_START); // 内容上移一小时 = 2 格
    expect(after - before).toBe(3600);
  });
});

describe("timeInColumn（round26 #4：拉伸落点二维 —— 列内夹 [00:00, 24:00]）", () => {
  /** 真正的一整天窗口：00:00 → 次日 00:00（round24 起时间轴就是整天） */
  const DAY0 = at(0);
  const TOP = 500;

  it("列体顶部 = 这一列的 00:00；往下一格 = 00:30（round76：舒适档 30px）", () => {
    expect(timeInColumn(TOP, TOP, DAY0)).toBe(DAY0);
    expect(timeInColumn(TOP + slotHeightPx(), TOP, DAY0)).toBe(DAY0 + 1800);
  });

  it("吸附 15 分钟", () => {
    expect(timeInColumn(TOP + 32, TOP, DAY0)).toBe(DAY0 + 1800); // 16 分钟 → 15 分钟
  });

  it("同一列里往下拖到底 → 最多到 24:00（再往下也不越过当天）", () => {
    expect(timeInColumn(TOP + dayHeightPx(), TOP, DAY0)).toBe(at(24));
    expect(timeInColumn(TOP + dayHeightPx() + 400, TOP, DAY0)).toBe(at(24));
  });

  it("同一列里往上拖到头 → 00:00（再往上也不跑到前一天）", () => {
    expect(timeInColumn(TOP - 400, TOP, DAY0)).toBe(DAY0);
  });

  it("同样的屏幕位置，**下一列**算出来就是次日（跨天靠换列，不靠往下拖）", () => {
    const y = TOP + slotHeightPx() * 4; // 某一列自己的 02:00
    expect(timeInColumn(y, TOP, DAY0)).toBe(at(2));
    expect(timeInColumn(y, TOP, at(0, 0, 13))).toBe(at(2, 0, 13));
  });
});

describe("dayIndexAtX（round25②：落点只看指针坐标）", () => {
  /** 7 列 × 128px，列缝 8px：与真界面同构 */
  const columns = Array.from({ length: 7 }, (_, i) => {
    const left = 44 + i * (128 + 8);
    return { left, right: left + 128 };
  });
  const limits = { left: 0, right: columns[6].right };

  it("落在列里 → 就是那一列", () => {
    expect(dayIndexAtX(columns[2].left + 10, columns, limits)).toBe(2);
  });

  it("落在两列中间那条缝里 → 取近的那一列", () => {
    const gapLeft = columns[1].right;
    expect(dayIndexAtX(gapLeft + 1, columns, limits)).toBe(1);
    expect(dayIndexAtX(gapLeft + 7, columns, limits)).toBe(2);
  });

  it("落在左边刻度栏那一条（在板子内、第 0 列左侧）→ 第 0 列", () => {
    expect(dayIndexAtX(20, columns, limits)).toBe(0);
  });

  it("落在板子外（Backlog / 面板空白）→ -1（松手不移动）", () => {
    expect(dayIndexAtX(-5, columns, limits)).toBe(-1);
    expect(dayIndexAtX(limits.right + 1, columns, limits)).toBe(-1);
  });

  it("没有列 → -1（不崩）", () => {
    expect(dayIndexAtX(100, [], limits)).toBe(-1);
  });
});

describe("nearestDayIndex（round26 #4：拉伸时指针跑到板子外也不丢手势）", () => {
  const columns = Array.from({ length: 7 }, (_, i) => {
    const left = 44 + i * (128 + 8);
    return { left, right: left + 128 };
  });

  it("指针拖到板子左面（Backlog 上）→ 夹到第 0 列", () => {
    expect(nearestDayIndex(-500, columns)).toBe(0);
  });

  it("指针拖到板子右面（面板空白 / 窗口外）→ 夹到最后一列", () => {
    expect(nearestDayIndex(columns[6].right + 500, columns)).toBe(6);
  });

  it("落在列里 → 就是那一列", () => {
    expect(nearestDayIndex(columns[3].left + 20, columns)).toBe(3);
  });

  it("没有列 → -1（不崩）", () => {
    expect(nearestDayIndex(100, [])).toBe(-1);
  });
});

describe("段号（round29 #8：跨天块要标「第几段/共几段」）", () => {
  // 用本地时刻构造，跟时间轴一天一列的规则一致
  const at = (day: number, hour: number, minute = 0) =>
    Math.floor(new Date(2026, 9, 12 + day, hour, minute, 0).getTime() / 1000);

  it("不跨天 → 只有一段（这时候不画角标）", () => {
    expect(segmentCount(at(0, 9), at(0, 10))).toBe(1);
  });

  it("跨到次日凌晨 → 两段（就是这个功能要标的情形）", () => {
    const start = at(0, 22);
    const end = at(1, 2, 45);
    expect(segmentCount(start, end)).toBe(2);
    expect(segmentIndexOf(at(0, 0), start)).toBe(1);
    expect(segmentIndexOf(at(1, 0), start)).toBe(2);
  });

  it("终点正好落在 00:00 → 不算新的一天（还是 1 段）", () => {
    expect(segmentCount(at(0, 22), at(1, 0))).toBe(1);
  });

  it("从 00:00 起满 3 天 → 3 段，逐段序号对得上", () => {
    const start = at(0, 0);
    const end = at(3, 0);
    expect(segmentCount(start, end)).toBe(3);
    expect([0, 1, 2].map((d) => segmentIndexOf(at(d, 0), start))).toEqual([1, 2, 3]);
  });

  it("日上 18:00 拉满 72 小时 → 碰到 4 个日历天 = 4 段（不是 3）", () => {
    // 这条是当初我自己写错的：段数看「碰到几天」，不看「72÷24」
    const start = at(0, 18);
    expect(segmentCount(start, at(3, 18))).toBe(4);
    expect(segmentIndexOf(at(3, 0), start)).toBe(4);
  });
});

/**
 * round85（0.31.0 · §5-DU）：**动作浮层落点**（`overlayAnchor`）—— 用户报的
 * 「视图里不够高的块，浮层盖满 → 拖不动 / 拉不动」就是这一条的边界表。
 * 纯像素判据（不看时长）：刻度 18–64 / 密度三档 / 并排窄块都靠这里兜住。
 */
describe("overlayAnchor：矮块的动作浮层落点", () => {
  it("块够高（≥54px）→ inline（照旧悬浮在块中央）", () => {
    expect(overlayAnchor({ top: 10, height: 54 })).toBe("inline");
    expect(overlayAnchor({ top: 10, height: 200 })).toBe("inline");
  });

  it("块矮：**优先下面**（round87.2 · 你 2026-10-09 拍）；块贴列底、下面放不下才上面", () => {
    // 列高 = 48 × 30 = 1440。宽块 need = 38 + 26 = 64
    expect(overlayAnchor({ top: 100, height: 53 })).toBe("below");
    // 块底 = 1440 - 40 → 下面只剩 40 < 64 → 走上面（列顶 1440-40-53 = 1347 ≥ 64 ✓）
    expect(overlayAnchor({ top: 1347, height: 53 })).toBe("above");
    expect(overlayAnchor({ top: 0, height: 7 })).toBe("below"); // 最小刻度下 15 分钟块
  });

  it("并排窄块按**最坏浮层高**要地方（5 枚按钮 = 5 行 24px）→ 下面要留 168", () => {
    expect(overlayAnchor({ top: 100, height: 28, colCount: 2 })).toBe("below");
    // 块底 = 1440 - 100 → 下面 100 < 168 → 上面（列顶 1312 ≥ 168 ✓）
    expect(overlayAnchor({ top: 1312, height: 28, colCount: 2 })).toBe("above");
    // 同样贴底的位置在整宽档（colCount 1，need = 64）下 100 ≥ 64 → 仍然优先下面
    expect(overlayAnchor({ top: 1312, height: 28, colCount: 1 })).toBe("below");
  });

  it("块贴列底（下面放不下）→ above；两边都放不下的 last-resort 分支实际上不可达（短块两边总和 ≥ 1386px）", () => {
    const day = dayHeightPx();
    expect(overlayAnchor({ top: day - 30, height: 30, colCount: 1 })).toBe("above");
    // 短块（≤54px）两边空间合计 = 列高 - 块高 ≥ 1386 > 2 × need（最坏窄块 168）→ 至少一边放得下
    expect(day - OVERLAY_SHORT_PX).toBeGreaterThan(2 * (142 + 26));
  });
});
