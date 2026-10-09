<script lang="ts">
  import { t } from "../i18n/i18n.svelte";
  import Icon from "../icons/Icon.svelte";
  import type { Block, BlockLayer } from "../ipc/types";
import {
  blockPreview,
  blocks,
  clearBlockPreview,
  groupPreview,
  markDone,
  markMissed,
  removeBlock,
  renameBlock,
  setBlockPreview,
  setExempt,
  setLayer,
  stretchBlock,
} from "../stores/blocks.svelte";
  import { editing, startEditing, stopEditing, toast } from "../stores/ui.svelte";
  import {
    focusSelect,
    isSelected,
    selectBlock,
    selectRangeTo,
    selection,
    toggleSelected,
  } from "../stores/selection.svelte";
  import { openDrift } from "../stores/drift.svelte";
  import { featureOn } from "../stores/settings.svelte";
  import { appearance } from "../stores/appearance.svelte";
  import { categoryOrderList, taskCategoryById } from "../stores/tasks.svelte";
  import { categoryColorIndex, categoryColorVar } from "../utils/category-color";
  import { sanity } from "../stores/sanity.svelte";
  import { link, linkBlock, sequenceIndex, unlinkBlock } from "../stores/sequences.svelte";
  import { beginPointerDrag, dwellAtEdge, resolveResizePoint } from "../stores/drag.svelte";
  import { autoScrollTo, stopAutoScroll } from "../utils/autoscroll";
  import { dwellStop } from "../utils/edge-dwell";
  import {
    BLOCK_INSET_PX,
    OVERLAY_FACE_PX,
    OVERLAY_MARGIN_PX,
    resizeRange,
    type ResizeEdge,
  } from "../utils/timeline";
  import { effectiveLayer, nextLayer } from "../utils/layer";
  import { formatClockRange } from "../utils/week";
  import { formatRemaining } from "../utils/remaining";
  import { clock } from "../stores/clock.svelte";

  let { block, taskTitle, taskExempt, segStart, segEnd, segIndex, segCount, narrow, cols = 1, labelLines = 1, tall, continues, overflows, flashing = false, overlay = "inline" }: {
    block: Block;
    taskTitle: string | undefined;
    /** round48：这块**所属任务**有没有标「不计入理智值」（任务级开关在 Backlog 那一行，这里只显示记号） */
    taskExempt: boolean;
    /**
     * 这**一段**自己的区间（round28 #1）：跨天块在每一天各画一段，
     * 以前两段都写整块的区间（周日那段 00:00–01:00 却写着「20:00–01:00」）→ 用户看了一脸问号。
     * 传进来的已经夹在本列窗口内了（Timeline 算），这里只管显示。
     */
    segStart: number;
    segEnd: number;
    /** round29 #8：这是整块的第几段（1 起）；`segCount < 2` 时不画角标 */
    segIndex: number;
    segCount: number;
    /** 并排（重叠分列）的块只有半宽 → 按钮改成悬停才出现，把宽度留给任务名 */
    narrow: boolean;
    /** round82（11.2）：并排数（= 块宽档位）—— 只给断言与调试看的 `data-cols`；浮层排布已改成**自适应** */
    cols?: number;
    /**
     * round82（11.3）：名字能占**几行**（`Timeline` 按块高 / 行高 / 第二行算出来）。
     * 1 = 老行为（单行省略号）；>1 时切多行省略（行数随块高，不封顶）。
     */
    labelLines?: number;
    /** 块够高（约 ≥1 小时）→ 名字下再显示一行起止时间（C1.3） */
    tall: boolean;
    /** round24：这一截的上边缘**不是**块的起点（跨天块的次日那一段）→ 不给上把手 */
    continues: boolean;
    /** round24：这一截的下边缘**不是**块的终点（跨天块的前一天那一段）→ 不给下把手 */
    overflows: boolean;
    /** round64.1（验收 #3）：撤销 / 重做后闪一下（纯视觉，不动选中/不写库） */
    flashing?: boolean;
    /**
     * round85（0.31.0 · §5-DU）：动作浮层的落点 —— 块在视图里不够高时另找地方放浮层，**别盖住块身**。
     * 判据在 `Timeline` 手里（它知道这一截的像素高 `box.height` 与列内位置 `box.top`）：
     * `inline` = 藏在块中央（老行为）；`above` / `below` = 贴到块外沿（无缝，hover 不断链）。
     */
    overlay?: "inline" | "above" | "below";
  } = $props();

  // 层级环（C1.4 两层：弹性 ⇄ 必填）与「遗留值当弹性」两条规则都在 utils/layer.ts（可单测）
  // round74（3.0b₂）：`$derived` —— 否则切语言后悬停 tooltip / 切层 toast 还是旧语言
  const LAYER_LABEL = $derived<Record<BlockLayer, string>>({
    required: t("ui.task_block.01"),
    elastic: t("ui.task_block.02"),
  });

  /** 实际生效的层：遗留的 `suggested` 当弹性，其它原样 —— 决定了视觉与切换起点 */
  const shownLayer = $derived(effectiveLayer(block.layer));

  /**
   * round76（3.1a）：这一块所属任务的分类（临时块 / 查不到 = null）。
   * 类别底边条与块 tooltip 的「分类：X」都读它 —— 颜色只是附加通道，文字永远在。
   */
  const category = $derived(
    block.is_temp ? null : (taskCategoryById(block.task_id) ?? null),
  );
  /** 分类色号（1…8；0 = 不画） —— 顺序按「该分类最早任务」的时间（改名不变色） */
  const catColor = $derived(categoryColorIndex(category, categoryOrderList()));

  /** C1.8（R33）：是不是临时安排块（后端算好的 `is_temp` —— 前端不猜任务 id） */
  const isTempBlock = $derived(block.is_temp);

  /** round87.2（你 2026-10-09）：块上要不要画 ⊘ 角标（任务级排除 / 临时块自己排除） */
  const showExemptMark = $derived(sanity.enabled && (taskExempt || (isTempBlock && block.sanity_exempt)));

  /** 起止时间（C1.3）：这块正在被拉伸时显示**预览值**（跟着手指走，方便判断对齐） */
  const shownStart = $derived(
    blockPreview.id === block.id ? blockPreview.start : block.start_at,
  );
  const shownEnd = $derived(
    blockPreview.id === block.id ? blockPreview.end : block.end_at,
  );

  /** round76（3.1a）：块上的 tooltip —— 跨天/超高块先说区间，**再无条件补一行「分类：X」**
      （颜色不是唯一通道：色觉障碍 / 关掉底边条时，悬停仍然看得到分类） */
  const blockTitle = $derived(
    [
      continues || overflows
        ? t("ui.task_block.05", { shownEnd: formatClockRange(shownStart, shownEnd) })
        : "",
      category ? t("ui.task_block.23", { category }) : "",
    ]
      .filter((s) => s !== "")
      .join("\n") || undefined,
  );

  const currentLayerLabel = () =>
    LAYER_LABEL[shownLayer as BlockLayer] ?? shownLayer;

  /**
   * round77（3.1b）：块内第二行的文案。
   * - `time`（默认）= 旧行为：本段起止时间。
   * - `remaining`：**已开始且未结束的计划块** → 「还剩 X」（吃 `clock` 的 60 秒节拍；
   *   不写库、不吃手势）；其余（未开始 / 已结束 / 已完成 / 未完成 / 残影）→ 还是时间。
   *   跨天/跨周块按**本段**算（与段内时间同口径）。
   */
  const secondLine = $derived.by(() => {    const range = formatClockRange(segStart, segEnd);
    if (appearance.blockSecondLine !== "remaining") return range;
    // round77 收尾：漂流的**残影**（`postponed_from` 非空）不接「还剩」—— 边界表 #12 明确
    // 「未开始 / 已完成 / 未完成 / 残影 → 时间」（之前只判了 status，跑着的残影会漏出一条「还剩」）
    if (block.status !== "planned" || block.postponed_from) return range;
    const now = clock.now;
    if (now < segStart || now >= segEnd) return range;
    return formatRemaining(segEnd - now);
  });

  /**
   * round87.1（1.0.1 · 验收回修）：**浮层落点要用「真实浮层高」再判一次** ——
   * `overlayAnchor` 是纯函数，只知道块高 / 列数，**不知道并排窄块的浮层会换行**
   * （24px 按钮 + `flex-wrap`：2 列时 4–5 枚 → 58–86px；4 列时 5 行 ≈ 142px）。
   * 它按整宽一排的 38px 给的 `inline`，在窄块上就是「浮层盖满块身 → 拖不动」
   * （你 2026-10-08 验收图：`data-overlay=inline` 的并排块，相交 58px、按下落在浮层上）。
   * 这里在**渲染后量一次**：浮层比块身还高（留不出 4px 把守 + 4px 拖拽面）就改挂块外沿；
   * 方向沿用同一条规矩：列顶留得下浮层 + 26px 走 `above`，否则 `below`。
   */
  let rootEl = $state<HTMLDivElement | null>(null);
  let actionsEl = $state<HTMLSpanElement | null>(null);
  let overlayGeom = $state({ h: 0, top: 0, actH: 0, roomBelow: 0 });
  $effect(() => {
    const el = rootEl;
    const acts = actionsEl;
    if (!el || !acts) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const day = el.closest(".day-body")?.getBoundingClientRect();
      overlayGeom = {
        h: r.height,
        top: day ? r.top - day.top : 0,
        actH: acts.getBoundingClientRect().height,
        roomBelow: day ? day.bottom - r.bottom : 0,
      };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(acts);
    return () => ro.disconnect();
  });
  /** 实际落点：**以实测为准重算**（prop 只当首帧/未量到时的占位）——
   *  · 实测浮层在块里装得下 → `inline`（中央悬浮）
   *  · 装不下 → 外沿：**优先下面**（你说的），下面放不下才上面
   *  round87.2：之前只在 prop=inline 时才重算，导致「纯函数按最坏浮层高（窄块 142px）判了 above，
   *  实测其实只有 114px、下面有 151px 位置」的块仍旧挂上面（新断言当场抓到）。 */
  const overlayReal = $derived.by(() => {
    const { h, top, actH, roomBelow } = overlayGeom;
    if (!(h > 0) || !(actH > 0)) return overlay; // 还没量到（首帧）→ 先用 prop
    if (h >= actH + OVERLAY_FACE_PX) return "inline";
    if (roomBelow >= actH + OVERLAY_MARGIN_PX) return "below";
    if (top >= actH + OVERLAY_MARGIN_PX) return "above";
    return "below";
  });

  async function onCycleLayer() {
    const next = nextLayer(shownLayer);    try {
      await setLayer(block.id, next);
      // 循环需要记顺序，所以每次切换都明确回一句现在在哪层
      toast(t("ui.task_block.03", { next: LAYER_LABEL[next] }));
    } catch {
      // ipc 层已弹 Toast
    }
  }

  async function onDone() {
    try {
      await markDone(block.id);
    } catch {
      // ipc 层已弹 Toast
    }
  }

  async function onMissed() {
    try {
      await markMissed(block.id);
      // 未完成 → 弹漂流卡，问你要不要换个时段（C2）；round64：漂流开关关掉就不自动弹（残影上的 ↻ 手动入口仍在）
      if (featureOn("drift_enabled")) openDrift(block.id);
    } catch {
      // ipc 层已弹 Toast
    }
  }

  /** C3.2：把块拖到别的格子 = 移动（保留链节与漂流关系）。
   *  与「从 Backlog 拖任务过来」区分：用不同的 MIME 类型。 */
  /** 0.6.21（用户要求加回）：双击块 = 直接标记完成 —— 最常用的动作一眼就完。
   *  落在按钮（✓ ✗ ⛓ 🗑 与左侧色条）、上下边缘的拉伸把手、**动作浮层本身**（按钮缝 / 内边距）上时不算。
   *  round85（§5-DU）：浮层第三项是补的真 bug —— 以前按在按钮缝上会被当成「双击块」标完成。
   *
   *  round48（用户 2026-10-03 验收实测）：**取消 round25 那个「临时块双击名字 = 改名」的例外** ——
   *  它和「双击 = 标记完成」抢同一个手势，一次误操作就把块标成完成（而完成**不可回退**）。
   *  改名改成资源管理器式：**先选中，再单击名字**（见 `onNameClick`）。 */
  async function onDoubleClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (target?.closest("button") || target?.closest(".resize") || target?.closest(".actions")) return;
    if (block.status !== "planned") return;
    try {
      await markDone(block.id);
    } catch {
      // ipc 层已弹 Toast
    }
  }

  /**
   * round48（用户 2026-10-03 拍板的手势）：**先选中这块，再单击名字 = 改名**（跟文件资源管理器一样）。
   *
   * 为什么读 `selectedBeforePress` 而不是「现在选中了吗」：点名字本身会先把它选中
   * （`onPointerDown` 里的 `selectBlock`），只看「现在」的话**第一次单击就会进改名** ✗。
   */
  function onNameClick() {
    if (!isTempBlock || !selectedBeforePress || selection.grabbed) return;
    startEditing(block.id);
  }

  /**
   * round49：**临时安排块**自己的「不计入理智值」开关（用户 2026-10-03 验收：「临时块没给不计入理智的方法」）。
   * 它没有可挂的任务（挂在那块全局隐藏任务上、Backlog 里看不见）→ 只能看它自己；
   * 普通块的开关在 Backlog 那一行（任务级），块上**不显示**这个键。
   */
  async function onToggleExempt() {
    try {
      await setExempt(block.id, !block.sanity_exempt);
    } catch {
      // ipc 层已弹 Toast
    }
  }

  /** C1.8（R33）：临时块显示自己的名字（`label`），没命名就叫「临时安排」；普通块照旧显示任务名。 */  const shownName = $derived(
    block.label ?? (isTempBlock ? t("ui.task_block.04") : (taskTitle ?? "?")),
  );

  /** C1.8：正在改名的就是本块 */
  const editingName = $derived(editing.blockId === block.id);

  let nameInput = $state<HTMLInputElement | null>(null);
  /** round48：按下那一刻它是不是**已经**选中了（改名手势靠它区分「选中后单击」与「第一次单击」） */
  let selectedBeforePress = false;

  // 一进入改名就聚焦并全选（与 Backlog 改名同一个手感：直接打字即整体替换）
  $effect(() => {
    if (!editingName) return;
    nameInput?.focus();
    nameInput?.select();
  });

  /** 提交改名：回车 / 失焦都走这里（回车提交后输入框被移除又会触发 blur → 用 editing 认领，避免重复提交） */
  async function commitName(value: string) {
    if (editing.blockId !== block.id) return;
    stopEditing();
    const next = value.trim();
    if (next === (block.label ?? "")) return; // 没变就不写库
    try {
      await renameBlock(block.id, next);
    } catch {
      // ipc 层已弹 Toast（过长 / 块已被删都在这里兜住）
    }
  }

  /** round25：拖动改 pointer 手势（引擎在 `stores/drag.svelte.ts`）。
   *  —— 原来这里是 HTML5 的 `dragstart`/`setDragImage`；真机上那条路走不通（详见引擎文件顶部）。
   *  这里只负责「把鼠标按在块身上」这个起手势，以及把尺寸交给引擎画拖影；
   *  阈值、落点、自动滚动、收尾全在引擎里。
   *  落在按钮（✓ ✗ ⛓ 🗑 / 色条）、上下拉伸把手、**动作浮层本身**（按钮缝 / 内边距）上时不起拖 ——
   *  最后一条是 round85（§5-DU）补的真 bug：以前从浮层的缝里按下会被冒泡到块上、当场起拖。 */
  function onPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement | null;
    if (target?.closest("button") || target?.closest(".resize") || target?.closest(".actions")) return;
    if (e.button !== 0) return;
    const mod = e.ctrlKey || e.metaKey;
    // round61（10.2 多选）：Ctrl+左键 = 加/减一块；Shift+左键 = 从锚点起算的一段区间。
    // 两者都不起拖动（想搬整组就直接按住组内某一块拖 —— round61.1 按你验收意见加上了）。
    if (mod) {
      selectedBeforePress = false;
      e.preventDefault(); // 别让浏览器把 Ctrl+点 当别的默认手势（不碰块内的按钮：上面已经放过）
      toggleSelected(block.id);
      return;
    }
    if (e.shiftKey) {
      selectedBeforePress = false;
      selectRangeTo(block.id);
      return;
    }
    // round48：改名手势要区分「这次点击**之前**它选没选中」——不然第一次点名字就会直接进改名
    selectedBeforePress = selection.ids.includes(block.id) && !selection.grabbed;
    // round61.1（你拍板「移动统一收进拿起」）：按下行为分三种 ——
    // ① 拿起的组内成员 → 拖 = 只动**组预览**（Enter 落地一次写）；
    // ② 未拿起的组内成员 → 收回单选（之后拖动就是普通单块拖动）；
    // ③ 其它 → 普通单选 + 拖动。未拿起的多选**不会被整体拖走**（那正是「拿起」要防的误触）。
    const inGroup = selection.ids.length > 1 && selection.ids.includes(block.id);
    const grabbedGroup = inGroup && selection.grabbed;
    if (!grabbedGroup) {
      // round31（C1.9）：按在块身上 = 选中它（已标记的块也能选——Delete 还能删，只是不能移动/拉伸）
      selectBlock(block.id);
    }
    if (block.status !== "planned" || resizing) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    beginPointerDrag({
      blockId: block.id,
      durationSeconds: block.end_at - block.start_at,
      width: rect.width,
      height: rect.height,
      event: e,
      // 拿起的组：拖的是预览（`group` 现在只给拖影角标数数用；位移基准在引擎里取**快照**起点）
      group: grabbedGroup
        ? selection.ids
            .map((id) => blocks.find((b) => b.id === id))
            .filter((b): b is Block => !!b && b.status === "planned")
            .map((b) => ({ id: b.id, start_at: groupPreview.ranges[b.id]?.start ?? b.start_at }))
        : [],
      previewMove: grabbedGroup,
    });
  }

  async function onDelete() {
    try {
      await removeBlock(block.id);
    } catch {
      // ipc 层已弹 Toast
    }
  }

  /** C3：序号徐章（①②③…）；超过 20 就用普通数字，免得字符集里没有 */
  const CIRCLED = [
    "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩",
    "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳",
  ];

  function seqBadge(blockId: string): string | null {
    const index = sequenceIndex(blockId);
    if (index === null) return null;
    return index <= CIRCLED.length ? CIRCLED[index - 1] : `(${index})`;
  }

  /** C3.3：链式接链（两次左键：拿起 → 放下）与右键解除链接 */
  async function onLink() {
    await linkBlock(block.id);
  }

  async function onUnlink() {
    await unlinkBlock(block.id);
  }

  /** C1.4：所有计划中的块都能拉伸（旧版「建议层固定 30 分钟」的约束已随两层结构取消） */
  const canResize = $derived(block.status === "planned");

  /**
   * 拉伸现场（round26 #4 改造）：落点现在是**二维**的 ——
   * 每帧拿指针坐标问时间轴：「你在哪一列、那一列的哪个时刻」（`resolveResizePoint`），
   * 再减去按下那一刻的 `grabOffset`（指针与真边的屏幕距离，整个手势不变）。
   * 滚轮、自动滚动、横向滚动都不会让边脱离鼠标（绝对换算）。
   *
   * 显示中的时间仍来自 `blockPreview`（不动 store），重排留到松手之后。
   */
  let resizing = $state<{
    edge: ResizeEdge;
    pointerId: number;
    grabOffset: number;
    origStart: number;
    origEnd: number;
    /** 自动滚动用的滚动容器（纵、横都靠它） */
    scroller: HTMLElement | null;
    /** 摘掉 window 上的拉伸监听（round28 #8） */
    detach: () => void;
  } | null>(null);

  /** 指针最后位置（自动滚动每一帧都要拿它重量 —— 不能用 `$state`，否则 rAF 里会跟到 null） */
  let resizePointer = { x: 0, y: 0 };
  /**
   * round28 #8：拉伸期间**每帧**把预览贴回指针。
   * 为什么需要：翻周会 `reloadWeek()` → `loadBlocks` 会「整批换掉数据 → 清掉预览」（那条本来是对的），
   * 于是「甩出边缘停住翻周」之后拉伸看着就死了（用户实测：翻了，但块没跟着动）✗。
   * 每帧重算顺带也盖住「级联/融合把预览弄没」这类外部原因。
   */
  let resizeRaf = 0;

  function onResizeDown(e: PointerEvent, edge: ResizeEdge) {
    if (!canResize) return;
    e.preventDefault(); // 别让浏览器顺带发起拖块
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    const rect = handle.getBoundingClientRect();
    // 块盒子上下各内缩 1px（与 `boxWithRange` 的 INSET 一致）→ 把「视觉边」还原成「真实时刻线」
    const edgeY = edge === "top" ? rect.top - BLOCK_INSET_PX : rect.bottom + BLOCK_INSET_PX;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* 合成手势 / 无活跃指针 */
    }
    resizePointer = { x: e.clientX, y: e.clientY };
    const scroller = handle.closest(".scroll") as HTMLElement | null;
    const st = {
      edge,
      pointerId: e.pointerId,
      grabOffset: e.clientY - edgeY,
      origStart: block.start_at,
      origEnd: block.end_at,
      scroller,
      detach: () => {},
    };
    resizing = st; // 用局部变量往下写：`$state` 的那份在闭包里窄化不成立
    // round26 #6（用户实测「滚轮一回退，又跟不住」）：预览以前只在 `pointermove` 时重算 ✗
    // → 拉伸期间盯着滚动容器的 scroll（capture：scroll 不冒泡），一滚就按指针位置重量一次。
    scroller?.addEventListener("scroll", onResizeScroll, { capture: true, passive: true });
    startResizeLoop();
    // round28 #8（用户实测「拉伸还是没法跨周」）：监听改挂 **window** —— 拖动手势一直都是这么做的。
    // 为什么必须：翻周会 reloadWeek → 时间轴重建 DOM，把手元素被换掉；
    // 监听到时候挂在旧元素上 → 手势成僵尸（看着还在「正在调整」，但指针已经没人听了）。
    // 副作用是顺带免疫「融合/级联把这块删了」这类 DOM 变动。
    const onMove = (ev: PointerEvent) => onResizeMove(ev);
    const onUp = (ev: PointerEvent) => void onResizeUp(ev);
    const onCancel = () => cancelResize();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") cancelResize();
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("keydown", onKey, true);
    st.detach = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }

  /** round26 #6：滚动（滚轮 / 自动滚动 / 横向）后内容动了 → 预览跟着指针重量 */
  function onResizeScroll() {
    applyResize();
  }

  /** round28 #8：拉伸期间每帧重算（理由见 `resizeRaf` 的注释） */
  function startResizeLoop() {
    cancelAnimationFrame(resizeRaf);
    const tick = () => {
      if (!resizing) return;
      applyResize();
      resizeRaf = requestAnimationFrame(tick);
    };
    resizeRaf = requestAnimationFrame(tick);
  }

  /** 按「指针最后位置」重算预览（移动时调；自动滚动 / 滚轮滚动每一帧都调） */
  function applyResize() {
    const r = resizing;
    if (!r) return;
    // round26 #4：二维落点 —— x 定列、y 定时刻；列内夹 [00:00, 24:00]，想跨天就把指针拖到下一列
    const target = resolveResizePoint(resizePointer.x, resizePointer.y - r.grabOffset);
    if (!target) return;
    const edgeTs = r.edge === "top" ? r.origStart : r.origEnd;
    const next = resizeRange(
      { start_at: r.origStart, end_at: r.origEnd },
      r.edge,
      target.time - edgeTs,
      target.dayStart,
    );
    // 锚列 = **指针所在那一列**（胶囊跟着指针走，不跑回块起点那一列）
    // round29 #5：顺手把这一块自己的快照报出去（翻周后 store 里没它了，时间轴要靠快照才画得出绿条）
    setBlockPreview(block.id, next.start_at, next.end_at, target.dayStart, block);
  }

  function onResizeMove(e: PointerEvent) {
    if (!resizing || e.pointerId !== resizing.pointerId) return;
    resizePointer = { x: e.clientX, y: e.clientY };
    applyResize();
    // round25③：指针贴边就自动滚（纵向够到看不见的钟点、横向够到看不见的列）；
    // 滚动时内容在动 → 同一帧里按新位置重量一次，下边缘一直贴着鼠标
    const scroller = resizing.scroller;
    if (scroller) autoScrollTo(scroller, () => resizePointer, applyResize);
    // round28 #8（用户实测「拉伸还是没法跨周」）：拉伸也能「甩出边缘停住翻周」
    dwellAtEdge(resizePointer.x);
  }

  /** 取消/收尾：清掉预览（store 没被改过，无需恢复）+ 停自动滚动 + 摘掉滚动监听 + 停「停住翻周」 */
  function cancelResize() {
    if (!resizing) return;
    stopAutoScroll();
    dwellStop();
    cancelAnimationFrame(resizeRaf);
    resizing.detach();
    resizing.scroller?.removeEventListener("scroll", onResizeScroll, { capture: true });
    clearBlockPreview();
    resizing = null;
  }

  async function onResizeUp(e: PointerEvent) {
    if (!resizing || e.pointerId !== resizing.pointerId) return;
    const { origStart, origEnd } = resizing;
    // 收尾会清掉预览 → 先把它抄下来
    const { start: start_at, end: end_at } = blockPreview;
    cancelResize();

    if (start_at === origStart && end_at === origEnd) return; // 没变就不写库
    try {
      await stretchBlock(block.id, start_at, end_at);
      // round69.1（#12）：原来这里会弹一次「改完时间了：15 分钟一步…」的教学提示 —— 按你的
      // 验收意见删掉（拉伸的基本操作在键位栏与说明页里）。
    } catch {
      // ipc 层已弹 Toast；store 从没被改过，清掉预览即可（不需要回滚）
    }
  }

</script>

<!-- 块本身可拖（C3.2：拖到别的格子 = 只改时间）；round25 起走 **pointer 手势**
     （原生 HTML5 拖放在 Windows/WebView2 宿主上不可靠 —— 详见 stores/drag.svelte.ts 顶部） -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={rootEl}
  class="block {block.status} layer-{shownLayer}"
  class:narrow
  class:selected={isSelected(block.id)}
  class:flash={flashing}
  class:overlay-above={overlayReal === "above"}
  class:overlay-below={overlayReal === "below"}
  data-block-id={block.id}
  data-overlay={overlayReal}
  data-cols={cols}
  data-label-lines={labelLines}
  tabindex="0"
  title={blockTitle}
  onpointerdown={onPointerDown}
  onfocus={() => focusSelect(block.id)}
  ondblclick={onDoubleClick}
>
  {#if canResize && featureOn("resize_enabled")}
    <!-- C1.1：上下边缘的拉伸抓手（只给计划中的块）。
         round24：**把手只画在真边上** —— 跨天块在两天各画一段，次日那一段的上边缘不是块的起点
         （拖它会直接把起点拽到次日 00:00）、前一天那一段的下边缘不是终点（一碰就把终点夹到
         24:00 = 把块截短）；这两处不给把手。 -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    {#if !continues}
      <div
        class="resize edge-top"
        title={t("ui.task_block.06")}
        onpointerdown={(e) => onResizeDown(e, "top")}
      ></div>
    {/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    {#if !overflows}
      <div
        class="resize edge-bottom"
        title={t("ui.task_block.07")}
        onpointerdown={(e) => onResizeDown(e, "bottom")}
      ></div>
    {/if}
  {/if}

  <!-- 左侧色条就是层级切换按钮（命中区 10px，视觉 3px；14px 高的块也点得中） -->
  <button
    type="button"
    class="layer-bar"
    title={t("ui.task_block.08", { currentLayerLabel: currentLayerLabel() })}
    onclick={onCycleLayer}
  ></button>

  {#if appearance.categoryBar && catColor > 0}
    <!-- round76（B2）：分类底边条（2 像素，不占高度、不吃宽度；只承载颜色） -->
    <span class="cat-bar" style="background: {categoryColorVar(catColor)}"></span>
  {/if}

  {#if block.status !== "planned"}
    <!-- 状态记号：不靠颜色单独表意（上一轮实测反馈：颜色会被系统/显示器弱化） -->
    <span class="mark" title={block.status === "done" ? t("ui.task_block.24") : t("ui.task_block.25")}
    ><Icon name={block.status === "done" ? "check" : "x"} size={14} /></span
  >
  {/if}

  {#if seqBadge(block.id)}
    <!-- C3：序列序号徐章（跨周时细线画不出来，序号还在） -->
    <span class="seq-index" title={t("ui.task_block.09", { id: sequenceIndex(block.id) ?? "" })}
      >{seqBadge(block.id)}</span
    >
  {/if}

  {#if segCount > 1}
    <!-- round29 #8（你问「每段只写本段区间，分不清是一段还是两段」）：右上角段号角标。
         段内时间仍只写本段（round28 #1），整段区间在块体 tooltip 上。 -->
    <span class="seg-index" title={t("ui.task_block.10", { segIndex: segIndex, segCount: segCount })}
      >{segIndex}/{segCount}</span
    >
  {/if}

  {#if showExemptMark || block.repeat_note}
    <!-- round87.2（你 2026-10-09 拍）：两个角标收进**右下角**一个小簇（⊘ 在左、🔁 在右）——
         ⊘ 以前跟在任务名左边，跟名字抢宽度；现在跟「固定轮换」的记号同侧同排。不占布局、不吃指针。 -->
    <span class="corner-marks">
      {#if showExemptMark}
        <span class="exempt-mark" title={t("ui.task_block.15")}><Icon name="ban" size={14} /></span>
      {/if}
      {#if block.repeat_note}
        <span
          class="repeat-mark"
          data-repeat-note={block.repeat_note}
          title={t("ui.task_block.11", { repeat_note: block.repeat_note })}
          ><Icon name="repeat" size={14} /></span
        >
      {/if}
    </span>
  {/if}

  <span class="text">
    {#if editingName}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="name name-input"
        bind:this={nameInput}
        value={block.label ?? ""}
        placeholder={t("ui.task_block.12")}
        maxlength="200"
        aria-label={t("ui.task_block.13")}
        onpointerdown={(e) => e.stopPropagation()}
        ondblclick={(e) => e.stopPropagation()}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commitName((e.currentTarget as HTMLInputElement).value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            stopEditing(); // 放弃改动：块上的名字还是原来那个
          }
        }}
        onblur={(e) => void commitName((e.currentTarget as HTMLInputElement).value)}
      />
    {:else}
      <!-- 名字上的单击 = 改名手势（**先选中再点**）。不做成 <button>：按钮会被块体手势跳过，
           那样名字就不能用来拖动/选中块了。键盘走 F2（Timeline 里那条），所以这里只 ignore 无障碍提示 -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <span
        class="name label"
        class:wrap={labelLines > 1}
        class:temp-name={isTempBlock}
        style="--label-lines:{labelLines}"
        title={isTempBlock ? t("ui.task_block.14") : undefined}
        onclick={onNameClick}
        >{shownName}</span
      >
    {/if}
    {#if tall && !narrow}
      <!-- 窄块里放不下（会被截成「13:00–14:」），宁可只留任务名；
           要看对齐有顶部那行手势提示。
           round77（3.1b）：文案 = `secondLine`（默认跟以前一模一样；`remaining` 档见上面那段注释） -->
      <span class="time">{secondLine}</span>
    {/if}
  </span>

  <!-- round77（3.1b）：动作区 —— **悬停 / 聚焦才出现**（常规块与窄块同一行为），命中区 32×32。
       DOM 上是块的子元素 ⇒ 鼠标移到浮出的按钮上时块仍是 `:hover`（不会一闪就没）；
       浮层可以超出块边界（你 2026-10-05 拍），所以 15 分钟的小块也点得中。 -->
  <!-- round79（78-09）：**就地改名期间不渲染动作区** —— 否则鼠标停在块上时（`.block:hover .actions`）
       浮层正好压在名字输入框上、抢点击（你 2026-10-06 的图 5）。用不渲染而不是 CSS 隐藏：
       不会 Tab 到看不见的按钮。 -->
  {#if !editingName}
  <span class="actions" bind:this={actionsEl}>
    {#if block.status === "planned"}
      <!-- 已标记的块不显示 ✓/✗：后端不允许回退，留着按钮只会产生「点了没反应」的困惑 -->
      <button type="button" title={t("ui.task_block.16")} aria-label={t("ui.task_block.16")} onclick={onDone}
        ><Icon name="check" size={14} /></button
      >
      <button type="button" title={t("ui.task_block.17")} aria-label={t("ui.task_block.17")} onclick={onMissed}
        ><Icon name="x" size={14} /></button
      >
    {:else if block.status === "missed"}
      <!-- 残影上点 ↻ 可随时重新安排（与刚点完 ✗ 弹出的漂流卡是同一张）。
           round64.1（验收 #1）：漂流开关关掉 → 这个入口也收掉（用户 2026-10-04：「按钮也还在」）。 -->
      {#if featureOn("drift_enabled")}
        <button
          type="button"
          title={t("ui.task_block.18")}
          aria-label={t("ui.task_block.18")}
          onclick={() => openDrift(block.id)}><Icon name="rotate-cw" size={14} /></button
        >
      {/if}
    {/if}
    {#if featureOn("sequences_enabled")}
      <!-- C3.3：左键 = 拿起线头 / 接上；右键 = 把这个块从序列里取出 -->
      <button
        type="button"
        class="link"
        class:linking={link.pendingId === block.id}
        title={t("ui.task_block.19")}
        aria-label={t("ui.task_block.19")}
        onclick={(e) => {
          e.stopPropagation(); // 别让「点空白处」的全局处理把它当成取消
          void onLink();
        }}
        oncontextmenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void onUnlink();
        }}><Icon name="link" size={14} /></button
      >
    {/if}
    {#if sanity.enabled && isTempBlock}
      <!-- round49：**只有临时块**有这个键（普通块的「不计入」是任务级的，在 Backlog 那一行） -->
      <button
        type="button"
        class="exempt"
        class:off={block.sanity_exempt}
        title={block.sanity_exempt
          ? t("ui.task_block.20")
          : t("ui.task_block.21")}
        aria-label={t("ui.task_block.21")}
        onclick={(e) => {
          e.stopPropagation();
          void onToggleExempt();
        }}><Icon name="ban" size={14} /></button
      >
    {/if}
    <button type="button" title={t("ui.task_block.22")} aria-label={t("ui.task_block.22")} onclick={onDelete}
      ><Icon name="trash-2" size={14} /></button
    >
  </span>
  {/if}
</div>

<style>
  .block {
    position: relative; /* 拉伸抓手的定位祖先 */
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-1);
    height: 100%;
    padding: 0 2px 0 0;
    border: 1px solid transparent;
    /* round86（0.32.0 · ③）：块外表的三个量（值在 palettes.css 的 `--deco-*`；没声明 = 今天的样子）
       —— 描边**颜色**仍由三态给，这里只管宽度；阴影是新增的（今天没有）。 */
    border-width: var(--deco-block-border-width, 1px);
    /* round77（3.1b）：块 = 小件 → 圆角阶梯的 `sm`（Fluent：<32px 的件用 2px；块高 15–66px），
       round86：展示/装饰参数可覆盖（深海 10px / 卡带 6px / 北境 8px） */
    border-radius: var(--deco-block-radius, var(--radius-sm));
    box-shadow: var(--deco-block-shadow, none);
    /* round77（3.1b）：**不再 `overflow: hidden`** —— 悬停浮出的动作条要能超出块边界
       （15 分钟的小块 / 并排的半宽块上，32×32 的四个按钮排不进去）。
       「内容比块高」的裁剪改到 `.text` 上（同一个效果，只是换了裁剪盒）。 */
    /* round25：拖动改 pointer 手势后，按住块体拖不再被浏览器拦下 → 不让它顺手选中文字 */
    user-select: none;
  }

  /* C1.1：拉伸抓手（命中带；光标提示可上下拖）。
     round85（§5-DU）：高度改成 `min(4px, (100% − 3px) / 2)` —— 块高足够时就是原来的 4px，
     极短块（最小刻度下 15 分钟 = 7px）则按比例收窄，保证**块身永远留得下 ≥3px 的可拖拽面**。 */
  .resize {
    position: absolute;
    right: 0;
    left: 0;
    z-index: 1;
    height: min(4px, calc((100% - 3px) / 2));
    cursor: ns-resize;
  }

  .edge-top {
    top: 0;
  }

  .edge-bottom {
    bottom: 0;
  }

  /* ---------- 状态（round76：柔和浅底 + 深字 + 淡描边；实心强调色已退役）---------- */
  .planned {
    background: var(--block-fill-planned);
    border-color: var(--block-line-planned);
    color: var(--block-ink-planned);
  }

  /* round31（C1.9）：键盘选中的块 —— 深色内圈（跨天块每一段都会亮）+ 提一层；
     与聚焦圈同一套（Tab 走到哪块就选中哪块） */
  .block.selected,
  .block:focus-visible {
    outline: 2px solid var(--text-primary);
    outline-offset: -2px;
    z-index: 2;
  }

  /* round64.1（验收 #3）：撤销 / 重做后闪一下被改的块（描边渐隐，不动布局） */
  .block.flash {
    animation: r641-flash 1.5s ease-out;
  }

  @keyframes r641-flash {
    0% {
      box-shadow: 0 0 0 3px var(--accent);
    }
    100% {
      box-shadow: 0 0 0 3px transparent;
    }
  }

  .done {
    background: var(--block-fill-done);
    border-color: var(--block-line-done);
    color: var(--block-ink-done);
  }

  .missed {
    background: var(--block-fill-missed);
    /* 残影：45° 斜线填充（v2 ⑥）+ 灰虚线边框 —— 与「未完成」状态同色系 */
    background-image: repeating-linear-gradient(
      45deg,
      color-mix(in srgb, var(--block-ink-missed) 14%, transparent) 0 3px,
      transparent 3px 6px
    );
    border: var(--deco-block-border-width, 1px) dashed var(--block-line-missed);
    color: var(--block-ink-missed);
  }

  /* round76（配-06）：层的第二遍信号（必填内描边 / 弹性斜纹与虚线框）已删 ——
     层条本身「4px + 实心/虚线」就能分辨，块底的第二道信号反而和「未完成虚线」打架。 */

  /* 层条（左边缘那个按钮）：形状看层级，颜色只在 tokens.css 里定 */

  .layer-bar {
    position: relative;
    flex: none;
    align-self: stretch;
    width: var(--layer-bar-hit);
    padding: 0;
    background: none;
    border: none;
    cursor: pointer;
  }

  .layer-bar::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: var(--layer-bar-width);
    /* round77：基线不画颜色 —— 颜色只由 `--layer-*-bar` 给（关掉时那两个 token = `transparent`，
       于是实心与虚线都看不见）。以前这里用中性色兜底，那条 token 已删。 */
    background: none;
  }

  .layer-required .layer-bar::before {
    background: var(--layer-required-bar);
  }

  .layer-elastic .layer-bar::before {
    /* 弹性层：**竖向虚线**（与必填的实心拉开一个形状通道；颜色只管色相） */
    background: repeating-linear-gradient(
      180deg,
      var(--layer-elastic-bar) 0 3px,
      transparent 3px 6px
    );
  }

  /* round76（B2）：分类底边条 —— 2 像素、贴底、不占高度也不吃宽度（纯颜色通道） */
  .cat-bar {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: var(--cat-bar-width);
    pointer-events: none;
  }

  /* ---------- 内容 ---------- */
  .mark {
    display: inline-flex;
    align-items: center;
    flex: none;
    font-size: var(--text-meta);
    line-height: 1;
  }

  .seq-index {
    flex: none;
    font-size: var(--text-meta);
    line-height: 1;
    opacity: 0.9;
  }

  /* round87.2（你 2026-10-09 拍）：右下角的角标簇（⊘ 不计入 + 🔁 每周重复）——
     不占布局、不挡名字、不吃指针；两个都在时 ⊘ 在左、🔁 在右（单个 🔁 的块看起来与以前一模一样） */
  .corner-marks {
    position: absolute;
    bottom: 0;
    right: 2px;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    pointer-events: none;
  }

  .repeat-mark {
    display: inline-flex;
    align-items: center;
    font-size: var(--text-meta);
    line-height: 1;
    opacity: 0.75;
  }

  /* round29 #8：跨天块的段号角标（躺在右上角、不占布局宽度、不挡底下的按钮） */
  .seg-index {
    position: absolute;
    top: 0;
    right: 2px;
    font-size: var(--text-meta);
    line-height: 1;
    opacity: 0.8;
    pointer-events: none;
  }

  /* C3.3：手里拿着线头的那一块高亮 */
  .link.linking {
    color: var(--accent);
    text-shadow: 0 0 5px var(--accent);
  }

  /* C1.3：名字 +（够高时）起止时间，竖排两行；外层占满剩余宽度 */
  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    /* round77：块自身不再裁剪（动作浮层要能溢出）→ 内容超出块高时在这里裁 */
    overflow: hidden;
  }

  .time {
    font-family: var(--font-mono);
    font-size: var(--text-meta);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: var(--text-meta);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* round82（11.3）：**多行省略** —— 行数由 `Timeline` 按「块高 − 边框 − 第二行」÷ 行高算出来
     （`--label-lines`，**不封顶**：块有多高就写几行，写不下才省略号）。
     只在真要换行时才换渲染方式（单行仍走上面那条老路径，一个字不动）。 */
  .label.wrap {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    white-space: normal;
    line-height: calc(var(--text-meta) * 1.2);
    /* 两条都写（老牌 `-webkit-box` recipe + 标准属性）：Chromium 认哪条用哪条，
       实测**并存时行数钳位照常生效**（`r82③` 用长名字探针量的：clamped=true、行数 = 预算）。 */
    -webkit-line-clamp: var(--label-lines, 1);
    line-clamp: var(--label-lines, 1);
  }

  /* C1.8：临时安排块的名字（可双击改名；改的时候变成一个不输样式的小输入框） */
  .name {
    display: block;
  }

  .temp-name {
    font-style: italic;
  }

  .name-input {
    width: 100%;
    min-width: 0;
    padding: 0 2px;
    background: var(--card);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-meta);
    line-height: var(--line-compact);
  }

  /*
   * round77（3.1b）：动作区 = **悬停 / 聚焦才出现的浮层**（常规块与并排块**同一行为**）。
   *
   * 为什么这么改（手批 U4 / U23 + `布局重审` L02 / `图-07`）：
   * - 旧命中区是 `padding: 0 1px` + `font-size: 10px` ≈ **8×12px**（round41 你原话「经常点不到」）；
   * - 现在 **32×32**（图标本体 14px）—— `--block-action-size` 一个值管。
   * - 名字不再被四个常显按钮吃掉（曾把 4 个字的任务名挤成「临时…」）。
   * - 浮层**允许超出块边界**（你 2026-10-05 拍）：并排块只有 ~64px 宽，塞不下四个 32px 按钮；
   *   它是块的**子元素** ⇒ 鼠标移到浮出的按钮上时块仍是 `:hover`（不会一闪就没）；`z-index` 抬一档压过邻居。
   * - 卡片底 + 细边框让它看起来就是一条「浮出来的工具条」（不是块的一部分）。
   */
  .actions {
    position: absolute;
    top: 50%;
    right: 2px;
    z-index: 3;
    display: flex;
    gap: var(--space-1);
    padding: 2px;
    transform: translateY(-50%);
    background: color-mix(in srgb, var(--card) 94%, transparent);
    border: 1px solid var(--grid-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-pop);
    opacity: 0;
    pointer-events: none;
    transition: opacity 150ms;
  }

  /* round78（验收带回 #1 / #2b）：浮层只在**鼠标悬停**或**动作按钮自己拿到键盘焦点**时出现。
     旧写法是 `.block:focus-within` —— 鼠标点完 ⛓ 后按钮留着焦点（真鼠标会聚焦按钮）→ 浮层常亮；
     Tab 到块上（块自己聚焦）也会把浮层招出来、正好盖住块名（你 2026-10-06 的图 1/图 2）。
     `:focus-visible` 只认键盘焦点：鼠标点击后按钮只有 `:focus`（不匹配）→ 鼠标一走开就收；
     键盘 Tab 进按钮时浮层照旧出现（可访问性不丢）。 */
  .block:hover .actions,
  .actions:has(:focus-visible) {
    pointer-events: auto;
    opacity: 1;
  }

  /* round85（0.31.0 · §5-DU）：块在视图里**不够高**时，动作浮层贴到块**外沿**（无缝 —— 坐标相接，
     hover 不会断链）。块身整条留作拖拽面，上下拉伸把手也不再被 z-index 3 的浮层盖住。
     判据在 `Timeline`（`box.height < 54px` → above；贴列顶 `box.top < 64px` → below，免得被
     `.day-body` 的 `overflow: hidden` 裁掉）。
     `+ 1px` = 抵消 `.block` 那圈 1px 边框：`bottom: 100%` 是相对**内边距盒**算的，不加这 1px
     浮层会压住块的最上一条边（断言里量出来「相交 = 1px」）。 */
  .overlay-above .actions {
    top: auto;
    bottom: calc(100% + 1px);
    transform: none;
  }

  .overlay-below .actions {
    top: calc(100% + 1px);
    transform: none;
  }

  /* round86（0.32.0 · ③）：斜切角（谷地黄）—— **只挂浮层本来就待在块里、且不会冒出块身的块**：
     裁切会连后代一起裁（浮层挂在块外 → 浮层没了），且会新建层叠上下文（改块内 `.actions` 的 z 序）。
     · 矮块（`above`/`below`）：浮层挂在块外 → 不裁；
     · **并排窄块（`.narrow`）：浮层会换行（每行 1–2 枚 24px，最多 5 行 ≈ 130px）→ 可能比块高**
       （6b 复核抓到的组合：4 列时块高 88 / 浮层 114，纵向冒出 26px）→ 也不裁。
     其余情况：`clip-path: none`（= 今天的样子）。 */
  .block[data-overlay="inline"]:not(.narrow) {
    clip-path: var(--deco-block-clip, none);
  }

  /* round82（11.2）：窄块浮层**自适应**（你 2026-10-06 二轮：「只要浮层宽度/行数会随着块的宽度调整就好」）——
     24px 按钮 + `flex-wrap`，宽度封在块内（`max-width: calc(100% - 4px)`）：
       · 块宽 68px → 一行放得下两个（2×2）；块宽 45px → 一行一个（浮层窄高）
     —— 不再写死宽度、也没有「…」展开按钮（按钮集合就是真实的那几个，一个不多）。
     旧写法的真因：`.block.narrow .actions{width:72px}` 在 border-box 下内容宽 66 < 32+4+32=68
     → 每行只放一枚 → 竖排 72×146（比块还高，2026-10-06 你图 2 那个）。
     24×24 = WCAG 2.5.8 允许的最小命中区（`图-06` 的 32 是常规档；窄块是**有据的例外**，已写进验收）。
     常规块（cols=1）保持现状（一排四个 32px，跟随内容宽度）。 */
  .block.narrow .actions {
    /* 4px → 2px：块宽 63px 时 4px 内缩会把内容压到 51px，差 1px 放不下「两枚 24px + 4px 间距」
       → 又竖排了（实测拓到）。2px = 每侧 1px，浮层本身还有 `right: 2px`，不会碰边。 */
    max-width: calc(100% - 2px);
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .block.narrow .actions button {
    width: var(--block-action-size-narrow);
    height: var(--block-action-size-narrow);
  }

  .actions button {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: var(--block-action-size);
    height: var(--block-action-size);
    padding: 0;
    background: none;
    border: none;
    border-radius: var(--radius);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .actions button:hover {
    color: var(--text-primary);
    background: var(--bg);
  }

  /* round49：临时块的「不计入理智」（⊘）—— 计入时是普通灰按钮；排除后沉下去变成实心深色 */
  .actions button.exempt.off {
    color: var(--text-primary);
    font-weight: 700;
  }

  /* round87.2：⊘（不计入）角标 —— 跟 🔁 同排站在右下角（以前贴在任务名左边） */
  .exempt-mark {
    display: inline-flex;
    align-items: center;
    color: var(--text-secondary);
    font-size: var(--text-meta);
    line-height: 1;
  }
</style>
