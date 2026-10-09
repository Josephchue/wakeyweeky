<script lang="ts">
  import Icon from "../icons/Icon.svelte";
  import { t, tn } from "../i18n/i18n.svelte";
import {
    blockPreview,
    blocks,
    createTempBlock,
    dragDuration,
    groupPreview,
    reloadWeek,
} from "../stores/blocks.svelte";
import {
  closeKeymapPanel,
  closeTaskPanel,
  keymapPanel,
  openKeymapPanel,
  openSettingsPanel,
  requestNewTask,
  startEditing,
  toast,
} from "../stores/ui.svelte";
import {
  cancelGrab,
  clearSelection,
  collapseToAnchor,
  flash,
  follow,
  handleKeyAction,
  selectAllWeek,
  selectMany,
  selection,
  startFollowGesture,
} from "../stores/selection.svelte";
import { resolveKey } from "../utils/keyboard";
import { isSingleKey, matches } from "../stores/keymap.svelte";
import { closeDrift } from "../stores/drift.svelte";
import { note } from "../stores/achievements.svelte";
import { attachDragHost, drag, refreshDragDrop } from "../stores/drag.svelte";
import { autoScrollTo, stopAutoScroll } from "../utils/autoscroll";
import { clock } from "../stores/clock.svelte";
  import { cancelLink, link, reloadSequences } from "../stores/sequences.svelte";
  import { tasks } from "../stores/tasks.svelte";
  import { featureOn, prefs } from "../stores/settings.svelte";
  import { layout, saveSlotHeight, saveWeekendHidden } from "../stores/layout.svelte";
  import { maybeHint } from "../stores/guide.svelte";
  import { week } from "../stores/week.svelte";
  import {
    SLOT_COUNT,
    SLOT_MINUTES,
    formatDayLabel,
    formatSlotLabel,
    formatWeekRange,
    getSlotStartSec,
    getWeekDays,
    weekendWindow,
  } from "../utils/week";
import {
    boxWithRange,
    DAY_HEAD_PX,
    dayHeightPx,
    dayIndexAtX,
    layoutDay,
    MIN_BLOCK_MINUTES,
    nearestDayIndex,
    // round85（0.31.0 · §5-DU）：动作浮层落点（纯像素判据，单测在 `utils/timeline.test.ts`）
    overlayAnchor,
    secondsToPx,
    segmentCount,
    segmentIndexOf,
    slotHeightPx,
    snapTime,
    timeAtClientY,
    timeInColumn,
    type BlockBox,
} from "../utils/timeline";
  import { formatClock, formatClockRange, formatDuration, getCurrentWeek } from "../utils/week";
  import { goNow, goWeek } from "../stores/week.svelte";
import { closeReview, nudge, openReview, review } from "../stores/review.svelte";
import { closeStats, openStats, stats } from "../stores/stats.svelte";
import { anyPanelOpen, closeTopPanel } from "../stores/panels.svelte";
  import { untrack } from "svelte";
  import { redo, undo } from "../stores/history.svelte";
  import { dayOf, overloadedDays, sanity, sanityBar } from "../stores/sanity.svelte";
  import type { Block, SanityDay } from "../ipc/types";
  import BulkBar from "./BulkBar.svelte";
  import Sequence from "./Sequence.svelte";
  import SanityBar from "./SanityBar.svelte";
  import ReviewNudge from "./ReviewNudge.svelte";
  import HintBar from "./HintBar.svelte";
  import SanitySettings from "./SanitySettings.svelte";
  import TemplatePicker from "./TemplatePicker.svelte";
  import TaskBlock from "./TaskBlock.svelte";
  import { DENSITY_SCALE, nightSegments } from "../utils/appearance";
  import { appearance } from "../stores/appearance.svelte";

  // 换周 → **必须重拉这一周的块**。用户实测（0.6.37）：「左上角时间戳知道我在看哪一周，
  // 表却调不出那一周的数据」—— 就是因为这里原先只重拉了序列 ✗，块要等到别的动作
  // （拖动/放置触发 reloadWeek）才进来，表现为「拖一个块进去突然闪出来」。
  // 注意：这条 effect **不许读 blocks**（reloadWeek 会写 blocks → 读了就死循环），只依赖 week.from。
  $effect(() => {
    void week.from;
    // round29 #5：翻周之后指针**没动**，拖动那次算好的落点还指在上一周（列号对不上 → 指示线消失 ✗）。
    // 这里按「当前指针 + 新的一周」重量一次。为什么不靠自动滚动：它的 rAF 只在真的滚了之后才 tick，
    // 内容装得下时（没有横向溢出）它根本不会 tick（用户就是这个现场）。
    // `untrack`：不把 `drag` 变成这条 effect 的依赖 —— 否则每次起手势都会连带 reloadWeek 一次。
    untrack(() => refreshDragDrop());
    void reloadWeek().catch(() => {});
  });

  // C3：序列窗口随「周」与「块」一起刷新。
  // 只读 week.from / blocks.length 作为依赖，不读 sequences（否则自己改自己 → 死循环）。
  $effect(() => {
    void week.from;
    void blocks.length;
    void reloadSequences().catch(() => {});
  });

  // 显示哪一周由 week store 决定（跨周时 App 会刷新它，时间轴自动跟着翻页）
  // round67：`weekendHidden` 时只画周一…周五 5 列（整周数据不动 —— 总览/统计/理智值照旧看 7 天）
  const allDays = $derived(getWeekDays(week.from));
  const days = $derived(layout.weekendHidden ? allDays.slice(0, 5) : allDays);
  const range = $derived(formatWeekRange(week.from));

  /**
   * C6（round44）：日头下那根耗能小条的悬停/读屏文本（标题与 aria 用同一句，别在模板里拼字符串）。
   * round45：口径改成**真实占用**（并集），事实（挪过/没做完）分开说 —— 不再有「重活」这类黑话。
   */
  function loadTitle(dayLabel: string, load: SanityDay): string {
    const bits: string[] = [];
    if (load.rearranged > 0) bits.push(tn("ui.timeline.01", load.rearranged, { rearranged: load.rearranged }));
    if (load.skipped > 0) bits.push(tn("ui.timeline.02", load.skipped, { skipped: load.skipped }));
    const facts = bits.length > 0 ? t("ui.timeline.03", { join: bits.join(t("ui.timeline.53")) }) : "";
    return t("ui.timeline.04", { dayLabel: dayLabel, minutes: formatDuration(load.minutes * 60), budget: formatDuration(
      load.budget * 60,
    ), blocks: load.blocks, facts: facts });
  }
  const slotIndexes = Array.from({ length: SLOT_COUNT }, (_, i) => i);

  const SLOT_SECONDS = SLOT_MINUTES * 60;

  /** 每天一列的时间范围：00:00 → 次日 00:00（共 48 格） */
  const dayWindows = $derived(
    days.map((day) => {
      const start = getSlotStartSec(day, 0);
      return { day, start, end: start + SLOT_COUNT * SLOT_SECONDS };
    }),
  );

  /**
   * round76（3.1a）：**今天那一列的起点**（本地 00:00）—— 「现在线」与「今天列微高光」都用它。
   * 看的是别的周（或今天被隐藏周末藏掉）时，`dayWindows` 里找不到它 → 不画（边界表 #12）。
   */
  const todayStart = $derived(getSlotStartSec(new Date(clock.now * 1000), 0));
  /** 「现在」在今天那一列里的位置（px）；不在视野内的今天 → null */
  const nowY = $derived.by(() => {
    const win = dayWindows.find((w) => w.start === todayStart);
    if (!win) return null;
    const y = secondsToPx(clock.now - win.start);
    return y >= 0 && y <= dayHeightPx() ? y : null;
  });

  /**
   * round82（3.1c₂ · 淡-12）：夜间淡化段（分钟区间；跨天 = 两段）。
   * 开关关掉时是空数组（**不渲染这一层** —— 不是 `display:none` 的第三种状态）；
   * 两件功能（淡化带 + 第四档主题）读同一对起止（你 2026-10-06 拍）。
   */
  const dimSegs = $derived(prefs.nightDim ? nightSegments(prefs.nightStart, prefs.nightEnd) : []);

  /**
   * round67：隐藏周末时被藏起来的那两天（周六 00:00 → 下周一 00:00）—— 数「周末还有几块」用。
   * 只数**真实块**（预览不算）：这条提示是给「你以为块没了」的边界用的。
   */
  const hiddenWeekendWindow = $derived(weekendWindow(week.from));
  const weekendBlockCount = $derived.by(() => {
    if (!layout.weekendHidden) return 0;
    // 6b（P2-5）：与时间轴同一可见口径 —— 残影开关关掉时不把 missed 数进「还有 N 块」
    const visible = featureOn("remnants_enabled")
      ? blocks
      : blocks.filter((b) => b.status !== "missed");
    return visible.filter(
      (b) => b.start_at < hiddenWeekendWindow.end && b.end_at > hiddenWeekendWindow.start,
    ).length;
  });

  /**
   * round61.1：当前所有**预览时段**（单块预览 + 多选拿起的组预览）。
   * 渲染、布局与模板都读它 —— 组预览的成员因此能像单块预览一样“先看到再落地”。
   */
  const previewRanges = $derived.by(() => {
    const m = new Map<string, { start: number; end: number }>();
    if (blockPreview.id) m.set(blockPreview.id, { start: blockPreview.start, end: blockPreview.end });
    for (const [id, r] of Object.entries(groupPreview.ranges)) {
      m.set(id, { start: r.start, end: r.end });
    }
    return m;
  });

  /** 某块此刻的预览时段（没有 → null） */
  function previewOf(id: string): { start: number; end: number } | null {
    return previewRanges.get(id) ?? null;
  }

  /** 预览块的快照（跨周预览时它可能不在本周数据里 —— 用它渲染） */
  function previewSnapshot(id: string): Block | null {
    if (blockPreview.id === id && blockPreview.block) return blockPreview.block;
    return groupPreview.blocks[id] ?? null;
  }

  /** round67.1（你的第 6 条）：周末提示**只在有内容时说** —— 有块说块数、预览落在周末说预览；都没有就不出现 */
  const weekendNoteText = $derived.by(() => {
    if (!layout.weekendHidden) return "";
    const bits: string[] = [];
    if (weekendBlockCount > 0) bits.push(t("ui.timeline.05", { weekendBlockCount: weekendBlockCount }));
    if (hiddenPreviewCount > 0) bits.push(t("ui.timeline.06"));
    return bits.join(" · ");
  });
  const hiddenPreviewCount = $derived.by(() => {
    if (!layout.weekendHidden) return 0;
    let n = 0;
    for (const r of previewRanges.values()) {
      if (r.start >= hiddenWeekendWindow.start && r.end <= hiddenWeekendWindow.end) n += 1;
    }
    return n;
  });

  /**
   * round61.1：预览布局 —— 支持**一块或多块**同时预览（组拿起）。
   * 每块预览都按「它在自己那一列的横向位置」补盒子；找不到位置的（跨周预览）列号列数写死 0/1。
   * 预览期间**原位那块一律不画**（含预览没伸到的列）—— 与单块预览同一口径。
   */
  const layouts = $derived.by(() => {
    // round64（C10）：残影开关关掉 → 时间轴不画 missed 块（数据保留；说明页里写了）
    const visible = featureOn("remnants_enabled")
      ? blocks
      : blocks.filter((b) => b.status !== "missed");
    const perDay = dayWindows.map(({ start, end }) =>
      layoutDay(
        visible.filter((b) => b.start_at < end && b.end_at > start),
        start,
        end,
      ),
    );
    const previews = previewRanges;
    if (previews.size === 0) return perDay;
    // 每块在「自己那一列」的横向位置（找不到 = 它本来就不在本周，或已被预览移出）
    const place = new Map<string, { colIndex: number; colCount: number }>();
    for (const boxes of perDay) {
      for (const box of boxes) {
        if (!place.has(box.id)) place.set(box.id, { colIndex: box.colIndex, colCount: box.colCount });
      }
    }
    const previewIds = new Set(previews.keys());
    // round69.1（#1）：**复制**手势里原块要留在原位（预览只是新的一份）——
    // 搬移 / 拿起才藏原块（那种情况下块是「跟着走」的，画两份会看着像已经放好了）
    const keepOriginals = selection.followMode === "copy";
    return dayWindows.map(({ start, end }, i) => {
      const base = keepOriginals
        ? perDay[i].map((box) => (previewIds.has(box.id) ? { ...box, sourceCopy: true } : box))
        : perDay[i].filter((box) => !previewIds.has(box.id));
      const extra: typeof base = [];
      for (const [id, r] of previews) {
        if (!(r.end > start && r.start < end)) continue; // 预览没伸到这一列
        const at = place.get(id) ?? { colIndex: 0, colCount: 1 };
        // 预览盒**用裸 id**（与手势前同一个 key → Svelte 复用那个 DOM 元素；
        // 原块那一份才带 `:source` 后缀，见 `BlockBox.sourceCopy`）
        extra.push(
          boxWithRange({ id, start_at: r.start, end_at: r.end }, at.colIndex, at.colCount, start, end),
        );
      }
      return extra.length ? [...base, ...extra] : base;
    });
  });
  /**
   * round82（11.3）：块里的名字能占**几行** —— 只要块够高就要几行（不封顶，写不下才省略号）。
   *
   * 口径（与 CSS 同源，断言里核）：行高 = `--text-meta × 1.2`；块上下边框各 1px；
   * 有第二行（「起止时间」—— `tall && !narrow`）时按 `× 1.4` 给它留一行（浏览器 `line-height: normal` 的量级）。
   * 15 分钟的小块：算出来就是 1 行（与旧行为一致）。
   */
  function labelLinesFor(box: BlockBox): number {
    const meta = DENSITY_SCALE[appearance.density].textMeta;
    const line = meta * 1.2;
    const second = box.height >= 40 && box.colCount === 1 ? meta * 1.4 : 0;
    return Math.max(1, Math.floor((box.height - 2 - second) / line));
  }

  /** 落点指示线（C1.5）：拖动中就把「吸附后的真实落点」画出来，错位感从根上消失。
   *  round25：落点由手势引擎（`stores/drag.svelte.ts`）按**指针坐标**算好放在 `drag.drop`，
   *  这里只负责把它画成一条线 —— 不再依赖「事件落在哪个元素」。 */
  const indicator = $derived.by(() => {
    const drop = drag.drop;
    if (!drop) return null;
    return {
      dayStart: drop.dayStart,
      start: drop.start,
      y: secondsToPx(drop.start - drop.dayStart),
    };
  });

  /**
   * round48：给「现在」一个**会走**的依赖。
   * 之前 `onNowWeek` 直接读 `getCurrentWeek()`（内部是 `Date.now()`）——它不是响应式的，
   * 于是这个派生只在 `week.from` 变化时才算一次：app 开过夜/跨周之后，**看着本周却还挂着
   * 「回到本周」按钮**（用户 2026-10-03 实测）。每分钟滴答一次就够（跨周最多晚一分钟）。
   */
  let nowTick = $state(0);
  $effect(() => {
    const timer = setInterval(() => (nowTick += 1), 60_000);
    return () => clearInterval(timer);
  });

  /** 是否就在「现在」那一周（决定要不要显示「回到本周」） */
  const onNowWeek = $derived.by(() => {
    void nowTick; // 读一下：让这个派生跟着上面那口钟重算（`void` 明确表达「只为依赖」）
    return week.from === getCurrentWeek().from;
  });

  /**
   * 手势中那行实时信息（C1.3）：用户实测「15 分钟颗粒度下没法判断对齐」——
   * 拉伸时显示完整区间 + 时长，拖动时显示落点起点（与指示线一致）。
   */
  const gestureHint = $derived.by(() => {
    const p = blockPreview;
    if (p.id) {
      const range = t("ui.timeline.07", { end: formatClockRange(p.start, p.end), start: formatDuration(p.end - p.start) });
      // round31（C1.9）：键盘**抓起**时 preview 也是这个
      // round54（BU）：拿起中只留「拿起中：…」这半句 —— **键位那几条交给键位栏**。
      // 旧写法把「Enter 放下 · Esc 放弃拿起」写在这里，而渲染又正好把它当条件把键位栏顶掉
      // → 拿起来反而看不见「↑↓ 移动 / Shift 快移」（别人 2026-10-03 实测投诉）。
      // round69（B3）：跟鼠标手势写清「怎么放下」（它不用 Enter，但 Enter 也可落地）
      return selection.grabbed
        ? selection.followMode === "copy"
          ? t("ui.timeline.08", { range: range })
          : selection.followMode === "move"
            ? t("ui.timeline.09", { range: range })
            : t("ui.timeline.10", { range: range })
        : range;
    }
    if (indicator) {
      // round27 #5：这里原来写死 30 分钟 —— 现在拖出来的块时长看**任务预估**（可长达数小时），
      // 提示得说真话（跟辅助线用同一个 `dragDuration`）
      const span = dragDuration.seconds || SLOT_SECONDS;
      return t("ui.timeline.11", { span: formatClockRange(indicator.start, indicator.start + span), duration: formatDuration(span) });
    }
    return null;
  });

  /**
   * round31（C1.9）：键盘提示条 —— 有选中块时常驻，写清**当前模式**该按什么。
   * round42（用户 2026-10-02：「这里文案也不清楚」）：
   * round54（BU，别人 2026-10-03 实测）：
   * ① **拿起中也看得见**：旧渲染是 `{#if gestureHint}…{:else if keyHintItems}` —— 拿起中 `gestureHint` 恒有值，
   *    键位栏整个被顶掉（「拿起中只写拿起那几条」是 round31 的取舍，现在看是错的）；
   * ② `Enter` 标「**拿起/放下**」（它本来就是那个开关 —— 你 2026-10-03 点名的）；
   * ③ round54 曾补过 `Ctrl+Z 撤销` —— **round55 按你验收意见去掉了**：「不用补，把鼠标悬停在回退键上就能显示」
   *    （`↶` 的 title 本来就是「撤销（Ctrl+Z）」；抓起中它又走「放弃拿起」，条里多一项只是噪声）。另两处改 —
   * ① **换成人话**：「修上边缘 / 修时长」说的是几何边，用户脑子里是「开始 / 结束时间」✗（NN/g：命令文案要短、动词化、不用黑话）
   * ② **只列键盘专有的键**：✓/✗/🗑 对应的完成/未完成/删除，块上本来就有按钮看得见（不算把动作藏起来）→
   *    腾出的位置正好解决「被 nowrap+ellipsis 截断成只剩前两项」（用户截图里就是那样）。
   * 渲染成「键帽 + 动作词」的紧凑样式（Primer 的 KeybindingHint 那套：键用小方块、动作用普通字体）。
   */
  const keyHintItems = $derived.by(() => {
    if (!featureOn("keyboard_enabled")) return null; // round64（C10）：键盘开关关掉 → 键位栏不画
    if (!selection.blockId) return null;
    // round61.1（你拍板）：多选态分「拿起中 / 未拿起」两套键位 —— 未拿起不能移动
    if (selection.ids.length > 1) {
      if (selection.grabbed) {
        return [
          { keys: "↑↓", label: t("ui.timeline.12") },
          { keys: "Shift+↑↓", label: t("ui.timeline.13") },
          { keys: "←→", label: t("ui.timeline.14") },
          { keys: "Shift+←→", label: t("ui.timeline.15") },
          { keys: "Enter", label: t("ui.timeline.16") },
          { keys: "Esc", label: t("ui.timeline.17") },
        ];
      }
      return [
        { keys: "Enter", label: t("ui.timeline.18") },
        { keys: "Space/X", label: t("ui.timeline.19") },
        { keys: "Del", label: t("ui.timeline.20") },
        { keys: "Esc", label: t("ui.timeline.21") },
      ];
    }
    if (selection.grabbed) {
      return [
        { keys: "↑↓←→", label: t("ui.timeline.22") },
        { keys: t("ui.timeline.23"), label: t("ui.timeline.24") },
        { keys: "Enter", label: t("ui.timeline.25") },
        { keys: "Esc", label: t("ui.timeline.26") },
      ];
    }
    return [
      { keys: "↑↓", label: t("ui.timeline.27") },
      { keys: "Shift+↑↓", label: t("ui.timeline.28") },
      // round61.1：未拿起不再 ←→ 搬块（移动统一收进拿起）—— 把「怎么移动」写在 Enter 这一项里
      { keys: "Enter", label: t("ui.timeline.29") },
      { keys: "Esc", label: t("ui.timeline.30") },
    ];
  });

  /**
   * round83（§8.3）：全局快捷键处理完，把**鼠标点出来的**焦点放掉 ——
   * 不然浏览器在随后的键盘交互里给那颗仍聚焦的按钮套 `:focus-visible`（看着像被选中，你图 3）。
   *
   * 判定**不能**用「此刻的 `:focus-visible`」：真鼠标 + 真按键实测 —— 按键传到**捕捉阶段**时
   * 浏览器已经把焦点环翻成 `true` 了（`ringAtCapture=true`）→ 那一刻再判就永远为真、守卫失效。
   * 所以改成记「这颗元素是不是**指针点出来**的」：
   * · `pointerdown` 后**一个宏任务**（`setTimeout 0`）记下当时的 `activeElement` ——
   *   为什么不能是微任务：焦点是 `pointerdown` 的**默认动作**，微任务在它之前就跑完了
   *   （首跑实测：记到的是上一个元素 → 守卫永远不匹配）；
   * · `Tab`（键盘换焦点）在捕捉阶段把它清掉。
   * 只有「指针焦点 + 还是它」才放掉；Tab 来的键盘焦点不满足，位置保住（a11y）。
   */
  let pointerFocusedEl: HTMLElement | null = null;
  function markPointerFocus(): void {
    setTimeout(() => {
      pointerFocusedEl = document.activeElement as HTMLElement | null;
    }, 0);
  }
  function clearPointerFocusOnTab(event: KeyboardEvent): void {
    if (event.key === "Tab") pointerFocusedEl = null;
  }
  function releasePointerFocus(): void {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return;
    if (el !== pointerFocusedEl) return; // 键盘（Tab）来的焦点：不动
    pointerFocusedEl = null;
    el.blur?.();
  }

  // 键盘跳周（← →）+ round31（C1.9）的块操作（选中后）。焦点在输入框里时不劫持
  $effect(() => {
    // round83（§8.3）：焦点归属的记 / 清（见 releasePointerFocus 上的注释）—— 用**捕捉阶段**，
    // 早于下面那个 bubble 处理器，才能在本帧拿到「这颗焦点是不是刚被指针点出来的」。
    window.addEventListener("pointerdown", markPointerFocus, true);
    window.addEventListener("keydown", clearPointerFocusOnTab, true);
    const onKey = (event: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const evTarget = event.target as HTMLElement | null;
      /** round78（3.1b₂ · 6b P2）：「打字类」控件才算「在输入框里」——
       *  勾选框 / 单选 / 按钮 / 滑块拿到焦点时按 `Esc` 应该照常走（关面板 / 清选中）；
       *  否则同一个面板里会出现「焦点在开关上 `Esc` 没反应、焦点在下拉上 `Esc` 管用」两种行为。 */
      const TEXT_LIKE_INPUT = new Set([
        "text",
        "number",
        "search",
        "email",
        "url",
        "tel",
        "password",
        "time",
        "date",
        "datetime-local",
        "month",
        "week",
      ]);
      const inField = (node: HTMLElement | null | undefined) =>
        !!node &&
        ((node.tagName === "INPUT" && TEXT_LIKE_INPUT.has((node as HTMLInputElement).type)) ||
          node.tagName === "TEXTAREA" ||
          node.isContentEditable);
      // round49（用户 2026-10-03 实测「临时块改名 enter 会触发拿起」）：
      // **判「在不在输入框里」不能只看 `activeElement`** —— 「改名」那类输入框按回车会
      // **先把自己卸载**（提交完就没了），事件冒泡到这里时 activeElement 已经回到 `body`
      // → 旧写法当成「不在输入框」→ Enter 被当成「拿起」✗。
      // `event.target` 即使元素已经卸载也还是那个输入框，所以两个都看（任一是输入框就放行）。
      const inInput = inField(el) || inField(evTarget);
      // round38：`⚙` 属性面板里的输入框**不自己处理 `Esc`** → 放给下面那条统一分支（要能收起面板）；
      // 其余输入框（改块名 / 改任务名 / 新建任务）的 `Esc` 归它们自己 —— 一律不劫持
      const inProps = (node: HTMLElement | null | undefined) => !!node?.closest?.(".props");
      // 注意：`.props` 的例外要**两个都看** —— 键盘事件可能是在 window 上派发的（那时 target 是 window，
      // 只有 activeElement 认得出「这在属性面板里」）；反过来输入框卸载后只有 target 可靠。
      if (inInput && !(event.key === "Escape" && (inProps(evTarget) || inProps(el)))) {
        return;
      }
      // round48：F2 = 给**选中的临时块**改名（与 Backlog 的 F2 同一个键）。只有临时块的名字可编辑
      // （普通块的名字属于任务，去 Backlog 改）—— 这也是「先选中、再单击名字」那个鼠标手势的键盘等价物。
      // round82（绑-*）：键位走注册表（`rename`，Backlog 任务行共用同一条）
      if (matches(event, "rename") && featureOn("keyboard_enabled")) {
        const found = blocks.find((b) => b.id === selection.blockId);
        if (found?.is_temp) {
          event.preventDefault();
          releasePointerFocus();
          startEditing(found.id);
          return;
        }
      }
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === "z") {
        event.preventDefault();
        releasePointerFocus();
        // round31：抓起中先放弃抓起 —— 预览本来就没写历史，不该撒销上一个操作
        if (selection.grabbed) {
          void handleKeyAction({ type: "cancel" });
          return;
        }
        if (event.shiftKey) void redo();
        else void undo();
        return;
      }
      if (mod && key === "y") {
        event.preventDefault();
        releasePointerFocus();
        void redo();
        return;
      }
      // round82（3.1c₂ · `绑-15`）：**裸字符键**的命令（含用户把带修饰命令改成裸字符后）受「键盘操作」开关管；
      // 带修饰的组合不属「字符键」，不受它管（`键-04`）。
      const singleKeyOn = featureOn("keyboard_enabled");
      // round78（3.1b₂ · `键-02`）：`Ctrl+,` 打开设置（Windows / macOS / 浏览器的平台惯例）。
      // 输入框里不劫持（上面的 inInput 守卫已放行）；面板栈是同级 —— 开设置会关掉其它同级面板。
      // round82（绑-*）：键位走注册表
      if (matches(event, "settings") && (singleKeyOn || !isSingleKey("settings"))) {
        event.preventDefault();
        releasePointerFocus();
        openSettingsPanel();
        return;
      }
      if (matches(event, "selectAll") && (singleKeyOn || !isSingleKey("selectAll"))) {
        // round61（10.2 多选）：全选本周（在输入框里不劫持 —— 上面的 inInput 守卫已经放行）
        event.preventDefault();
        releasePointerFocus();
        selectAllWeek();
        return;
      }
      // round69（B3）：`Ctrl+X` / `Ctrl+C` —— 拿起模式的**跟鼠标版**（预览跟住鼠标，左键放下）。
      // 与 Ctrl+Z 同一层：拦下来就不让 WebView 去做原生剪切/复制。
      // round82（绑-*）：两条命令都走注册表
      {  
        const followMove = matches(event, "followMove");
        const followCopy = matches(event, "followCopy");
        if (followMove || followCopy) {
          // 绑-15：裸字符键受开关管（改到带修饰的组合不受）
          const followId = followMove ? "followMove" : "followCopy";
          if (!singleKeyOn && isSingleKey(followId)) return;
          // round69（B3）：浮层（总览/统计/说明…）开着不接 —— 与 C 键同一口径（B1#1；6b P2）
          // round78（栈-07）：判据从「有没有遮罩」改成**面板栈深 > 0**（模板/设置两个弹层没有遮罩，以前它们开着会被抢）
          if (anyPanelOpen()) return;
          event.preventDefault();
          releasePointerFocus();
          startFollowGesture(followMove ? "move" : "copy");
          return;
        }
      }
      // round78（3.1b₂ · `键-03`）：`?` 打开/关掉键位面板（子层：叠在设置上也行 —— 不受 anyPanelOpen 拦）
      // round83（§8.2）：与设置里那个入口**合并成同一个面板** —— `?` 打开时总表在最上（不退化）
      if (matches(event, "keyHelp")) {
        if (!singleKeyOn) return;
        event.preventDefault();
        releasePointerFocus();
        if (keymapPanel.open) closeKeymapPanel();
        else openKeymapPanel();
        return;
      }

      // round78（3.1b₂ · `键-02`）：`T` 回到本周（Google Calendar 的 `t`）。
      // 有选中块 / 手势中不抢（与 `O`/`S` 同一条让位规则）；浮层开着不接。
      if (matches(event, "goNow")) {
        if (!singleKeyOn || anyPanelOpen()) return;
        const busy = !!selection.blockId || selection.grabbed || drag.blockId !== null || link.pendingId !== null;
        if (busy) return;
        event.preventDefault();
        releasePointerFocus();
        goNow();
        return;
      }

      // round69（B3）：局内键 `C` = 快速加任务（你 2026-10-05 拍板「不要全局键，要局内键」）——
      // Backlog 自动展开 + 光标进「添加任务…」；浮层（总览/统计/说明…）开着时不抢
      if (matches(event, "newTask") && !anyPanelOpen() && singleKeyOn) {
        event.preventDefault();
        releasePointerFocus();
        requestNewTask();
        return;
      }

      // round77（3.1b）：局内快捷键 `O` / `S` —— 总览 / 统计（你 2026-10-05 拍板「带上」）。
      // round78（验收带回 #4，你 2026-10-06 拍）：**同键开合**（开着再按一下 = 关），
      //   并让位给块操作 —— `W/A/S/D` 是方向键的平行键位（`S` = 往下），
      //   旧写法排在块分支之前 → 选中块按 `S` 去开统计、**劫持了「往下」**（实测抓到）。
      //   口径：面板开着 → 只认「关自己那层」；面板没开 → 只在没有选中块/手势时开。
      //   跨面板的开/关/叠层留给面板栈那一块统一（本步只做「自己那层」）。
      const wantReview = matches(event, "review");
      const wantStats = matches(event, "stats");
      if (wantReview || wantStats) {
        if (!singleKeyOn) return; // round78（键-04）：单键受「键盘快捷键」开关管
        // round78（栈-07）：面板栈深 → 决定「只关自己那层」还是「可以开」
        const panelOpen = anyPanelOpen();
        // round82（11.5）/ round78 ④：选中块 / 拿起 / 拖动 / 待链 —— 单键要让位给块操作（`S` = 往下）
        const blockBusy =
          !!selection.blockId || selection.grabbed || drag.blockId !== null || link.pendingId !== null;
        if (panelOpen) {
          if (wantReview && featureOn("review_enabled") && review.open) {
            event.preventDefault();
            releasePointerFocus();
            closeReview();
            return;
          }
          if (wantStats && featureOn("stats_enabled") && stats.open) {
            event.preventDefault();
            releasePointerFocus();
            closeStats();
            return;
          }
          // round82（12/11.5）：总览开着（统计没开）→ `S` 把统计当**总览子层**打开
          // （面板栈里它是 child，`Esc` 只关它这一层，关掉回总览）；块忙着时不出手
          if (wantStats && featureOn("stats_enabled") && review.open && !blockBusy) {
            event.preventDefault();
            releasePointerFocus();
            void openStats({ asChild: true });
            return;
          }
        } else if (!blockBusy) {
          if (wantReview && featureOn("review_enabled")) {
            event.preventDefault();
            releasePointerFocus();
            openReview();
            return;
          }
          if (wantStats && featureOn("stats_enabled")) {
            event.preventDefault();
            releasePointerFocus();
            // round83（§8.1 顺带拍 · Q4）：入口口径 = **功能开关** —— 总览功能开着时，
            // `S` 与顶栏那条一致：先开总览 + 统计子层（键盘仍能直达统计）；
            // 总览功能关着时才开**独立**统计面板。
            if (featureOn("review_enabled")) {
              openReview();
              void openStats({ asChild: true });
            } else {
              openStats();
            }
            return;
          }
        }
      }

      if (mod || event.altKey) return; // 其余 Ctrl/Alt 组合不碰（留给系统/浏览器）

      // round69（B3）：跟鼠标手势期间按 `Enter` = 左键落地（同一套收尾）。
      // 为什么单独放一条：`gestureBusy` 包含 `drag.blockId`——`armPlacement` 会占着它，
      // 下面那条块键盘分支整个被跳过（6b 复核 P1：旧写法让 Enter/方向键永远到不了）。
      if (selection.followMode && event.key === "Enter") {
        event.preventDefault();
        void handleKeyAction({ type: "drop" });
        return;
      }

      // round38（用户 2026-10-02：0.6.52 的 `Esc` 只修了一半）：
      // `Esc` = 「点一下别处」的键盘版 —— **面板 / 接链 / 选中 / 焦点一起放掉**。
      // （round31 键位表里 `Esc` 的「等价手势」本来就写着「点空白」，这里只是让实现追上它。）
      // 唯一的例外：**抓起中**只放弃抓起（保持选中、不动焦点 —— 你还要接着按方向键；0.6.52 已验收）。
      // 改名 / 新建任务的输入框是另一个例外，但那段在上面那条守卫里就返回了。
      if (event.key === "Escape") {
        event.preventDefault();
        // rounds78（栈-02）：**面板栈顶优先** —— 只关一层（以前 7 处各自监听 → 一次 Esc 全关）
        if (closeTopPanel()) return;
        if (selection.grabbed) {
          void handleKeyAction({ type: "cancel" });
          return;
        }
        if (marquee) {
          cancelMarquee(); // round61：框选中先撤框（选中不动）
          return;
        }
        closeDrift(); // 漂流卡（没开 = 空操作）
        closeTaskPanel(); // `⚙` 属性面板 + 「已归档」列表（没开 = 空操作）
        cancelLink(); // 线头（纯前端；**不写库** —— 与「点空白」的唯一差别，round36 定的口径）
        // round61：多选 → 先退回单选（锚点），再按一次才清空
        if (selection.ids.length > 1) collapseToAnchor();
        else clearSelection(); // 块选中 + 抓起预览（含辅助线）
        (document.activeElement as HTMLElement | null)?.blur?.(); // 不留 `:focus-visible` 的圈
        return;
      }

      // 指针手势 / 接链进行中：不接手块操作（防竞态），但 ← → 仍然跳周（现有手感）
      const gestureBusy = drag.blockId !== null || drag.taskId !== null || link.pendingId !== null;
      // round64（C10）：键盘开关关掉 → 块操作键不生效（Esc 已在上面处理；←/→ 跳周保留）
      if (selection.blockId && !gestureBusy && featureOn("keyboard_enabled")) {
        const action = resolveKey(event.key, {
          shift: event.shiftKey,
          grabbed: selection.grabbed,
        });
        if (!action) return;
        // B14：焦点在按钮上（✓/✗/⛓/🗑/色条）时，Enter/Space/X/Delete 让给按钮自己的键盘行为。
        // 方向键仍可用（按钮对方向键本来就没行为）。
        // 用 `document.activeElement` 而不是 `event.target`：键盘事件可能从 window/document 派发
        // （target 上不一定有 closest ✗ —— 预览自证就是这么发键盘事件的，实测抓到过）。
        const active = document.activeElement as HTMLElement | null;
        const onButton = !!(active?.closest && active.closest("button"));
        // round32 #7（用户提议）：焦点在**序列键（⛓）**上时，方向键不许搬块 ——
        // 那是「序列操作」的地盘，直接给一句提示（别让用户以为自己在操作序列却把块挪走了）。
        const onLinkButton = !!(active?.closest && active.closest("button.link"));
        if (onLinkButton && action.type !== "cancel") {
          event.preventDefault();
          releasePointerFocus();
          toast(t("ui.timeline.31"));
          return;
        }
        if (onButton && action.type !== "move" && action.type !== "stretch") return;
        event.preventDefault();
        releasePointerFocus();
        // round37 的那段 `blur()` 已由上面的统一 `Esc` 分支接管（`Esc` 在那里就 return 了，这里够不到）。
        void handleKeyAction(action);
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        releasePointerFocus();
        goWeek(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        releasePointerFocus();
        goWeek(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", markPointerFocus, true);
      window.removeEventListener("keydown", clearPointerFocusOnTab, true);
    };
  });

  // round32 #5（用户实测「拿起时点了块的 🗑，块删了、手上还挂着一个操作不了的幻影」）：
  // 抓起是**键盘模式** —— 任何地方按一下鼠标（块上的按钮 / Backlog / 顶部导航…）都先放弃抓起。
  // 挂 window 捕获阶段：抢在块自己的 pointerdown 之前收尾，绝不给「删掉了预览还挂着」留窗口。
  $effect(() => {
    const onAnyPointerDown = (ev: PointerEvent) => {
      if (!selection.grabbed) return;
      // round69（B3）：跟鼠标手势（Ctrl+X / Ctrl+C）的按下**归它自己管** —— 它用 pointerdown
      // 落地（左键放下）；点在板外那么关就继续跟，不许在这里被当成「放弃拿起」。
      // （armPlacement 的捕获监听器在后；这里先放行，它才有机会拦下这一下。）
      if (selection.followMode) return;
      // round61.1：按在**拿起的组内成员块身**上 → 交给拖动走「预览位移」，**别把拿起状态清掉**；
      // 但按到按钮/拉伸把手 = 用户要干别的事 → 照旧放弃拿起（否则会静默写库 / 半截状态）。
      const target = ev.target as HTMLElement | null;
      const host = target?.closest?.("[data-block-id]") as HTMLElement | null;
      const bid = host?.dataset?.blockId;
      const onHandle = !!target?.closest?.("button") || !!target?.closest?.(".resize");
      // round69.1（#7）：拿起中在时间轴上**点一下 = 落地**（落在预览当前的位置）——
      // 整块/组都算。只在「抬起来没挪过」时算点击：挪过 = 拖动/框选，交给原有手势。
      // 板外点击仍照旧（放弃拿起）；Ctrl+X/C 那条路（followMode）不碰。
      const armClickDrop = () => {
        const x0 = ev.clientX;
        const y0 = ev.clientY;
        const onUp = (up: PointerEvent) => {
          window.removeEventListener("pointerup", onUp, true);
          window.removeEventListener("pointercancel", onUp, true);
          if (!selection.grabbed || selection.followMode) return; // 已被别的路径收掉 → 不重复落地
          if (Math.hypot(up.clientX - x0, up.clientY - y0) > 4) return; // 拖过 → 交给拖动/框选
          void handleKeyAction({ type: "drop" });
        };
        window.addEventListener("pointerup", onUp, true);
        window.addEventListener("pointercancel", onUp, true);
      };
      if (selection.ids.length > 1 && bid && selection.ids.includes(bid)) {
        if (!onHandle) {
          armClickDrop(); // 成员**块身**：拖动照旧（只动预览）；点一下 = 落地
          return;
        }
        // 按钮/把手：先放弃拿起；其中**拉伸把手**这一下还要吞掉 ——
        // 否则放弃拿起会让键位栏换行、板子重排，松手时拉伸引擎会按旧几何算出一个**意外的微拉伸并真写库**（round61.1 / 6b P1）。
        // 语义：「拿起中 = 移动模式」；想拉边就先放下（Esc/Enter），再拉一次。
        cancelGrab();
        if (!target?.closest?.("button")) {
          ev.preventDefault();
          ev.stopPropagation();
        }
        return;
      }
      // 板内（含空白处 / 别的块）：点一下 = 落地；板外（顶部导航、Backlog、面板…）仍放弃拿起
      if (target?.closest?.(".scroll") && !onHandle) {
        // 只有**空白处**才截断事件（否则 `.scroll` 的「点空白 = 清选中」会把拿起顺手取消掉）；
        // 按在**块身上**时照旧放行给块自己的拖动/选中引擎 —— 拖了就是拖动（本来的手感），
        // 没挪过的「点一下」再由 armClickDrop 落地（6b P1-2：旧写法把拖动整条路截死了）。
        if (!bid) ev.stopPropagation();
        armClickDrop();
        return;
      }
      cancelGrab();
    };
    window.addEventListener("pointerdown", onAnyPointerDown, true);
    return () => window.removeEventListener("pointerdown", onAnyPointerDown, true);
  });

  // round32 #4（用户实测「Tab 走到非块的地方，选中还在」）：
  // 焦点落到**块外面** → 取消选中。
  // 为什么用 window 的 `focusin` 而不是块上的 `focusout`：实测（预览自证）块上挂 focusout
  // 收不到子元素（✓ 按钮）产生的 focusout —— 而 focusin 直接告诉你「新焦点是谁」，一个判断就完事。
  // 抓起中不丢手（抓起的收尾交给 Enter / Esc / 鼠标）；焦点还在**同一个块**里面（块体 → ✓/✗）也不动。
  $effect(() => {
    const onFocusIn = (event: FocusEvent) => {
      if (selection.ids.length === 0 || selection.grabbed) return;
      const target = event.target as HTMLElement | null;
      // round61：动作条（BulkBar）上的焦点别把多选清掉
      if (target?.closest?.(".bulk-bar")) return;
      const host = target?.closest?.("[data-block-id]") as HTMLElement | null;
      const bid = host?.dataset?.blockId;
      // round61：焦点落在**选中里任何一块**（不只锚点）都算「还在选中里」
      if (bid && selection.ids.includes(bid)) return;
      clearSelection();
    };
    window.addEventListener("focusin", onFocusIn, true);
    return () => window.removeEventListener("focusin", onFocusIn, true);
  });

  // round31：键盘操作后的「视觉跟随」—— 把正在动的那条边带进视野（跨周由 store 那边翻）
  $effect(() => {
    const seq = follow.seq; // 读它 = 每次操作重跑一次
    if (!seq) return;
    untrack(() => ensureTimeVisible(follow.at));
    // round64.1（验收 #3）：窄窗口下数据/布局可能这一帧才就位（撤销跨周后尤其）
    // → 下一帧用真实尺寸再校正一次（幂等；滚动条不会“差一点”）
    const raf = requestAnimationFrame(() => untrack(() => ensureTimeVisible(follow.at)));
    return () => cancelAnimationFrame(raf);
  });

  /** 手势收尾：落点线与拖动时长一起清（松手 / Esc / 拖出窗口 都会走到）
   *  round25：手势本身改由 `stores/drag.svelte.ts` 的引擎收尾（它才是监听指针的那个人）——
   *  这里只需要把「落点线」跟着它的状态显示出来（见下面的 `indicator`）。 */

  const blocksById = $derived(new Map(blocks.map((b) => [b.id, b])));

  /**
   * round78（3.1b₂ · 教-03）：**整周没有可看的块**时在内容区居中指路（一句话，不放插画/动效）。
   * 在场判据与板子一致：漂流子块（`postponed_from`）不在场；残影开关关掉时 missed 也不画。
   * 只在**整周空**时出现（某天单独空 → 不显示，避免噪声）。
   */
  const weekEmpty = $derived(
    blocks.every((b) => !!b.postponed_from || (!featureOn("remnants_enabled") && b.status === "missed")),
  );

  const getTitle = (taskId: string) => tasks.find((t) => t.id === taskId)?.title;
  /** round48：`⊘`（不计入理智）是**任务级**的 —— 块上只显示记号，开关在 Backlog 那一行 */
  const getExempt = (taskId: string) => tasks.find((t) => t.id === taskId)?.sanity_exempt ?? false;

  /** 一条辅助线：真实时刻 + 它落在哪一列 + 在那列里的像素位置 */
  type GuideLine = { key: string; at: number; dayIndex: number; y: number };
  /** 甩出日列区边缘多少像素才算「拖出去了」（round27 #8 的翻周手势） */
  const EDGE_DWELL_MARGIN_PX = 8;
  /** 
   * 辅助线行首那个小牌（跨天时写「次日 01:00」这种）：自己带文字，就画在自己那条线的行上。
   * round27：从「一条 nextDay」改成数组 —— 现在往回拉也要标（前一日 / 前 N 天）。
   */
  type GuideChip = { key: string; dayIndex: number; y: number; text: string };

  const clampY = (y: number) => Math.min(Math.max(y, 0), dayHeightPx());
  /** 某个时刻落在哪一列（不在本周任何一列里 → -1） */
  const dayIndexOf = (ts: number) => dayWindows.findIndex((w) => ts >= w.start && ts < w.end);
  /** round61.2：某时刻所在**本地日**的 0 点 —— 辅助线包络用它算「不计日期」的偏移（跨周/跨天也对） */
  const localDayStartOf = (ts: number) => getSlotStartSec(new Date(ts * 1000), 0);
  /** 某时刻在某一列里的像素位置（夹进可见窗） */
  const yIn = (dayIndex: number, ts: number) =>
    clampY(secondsToPx(ts - dayWindows[dayIndex].start));
  /** 「续到次日 14:30」那句：正常就是次日；跨 2 天以上（老数据/极端拉伸）才多说一句 */
  const overflowHint = (endAt: number, dayEnd: number) => {
    const over = endAt - dayEnd;
    return over <= 24 * 3600
      ? t("ui.timeline.32", { endAt: formatClock(endAt) })
      : tn("ui.timeline.33", Math.ceil(over / 86400), { over: Math.ceil(over / 86400), endAt: formatClock(endAt) });
  };

  /**
   * 手势辅助线的小牌：跨天了就把「哪天几点」写出来（`次日 01:00` / `+2 天 20:00` / `前一日 07:00`）。
   * 纯函数放外面（不在 `$derived` 里飘着），没跨天就返回空数组。
   */
  function buildDayChips(startIndex: number, endIndex: number, start: number, end: number) {
    if (startIndex < 0 || endIndex < 0 || endIndex === startIndex) return [];
    const days = endIndex - startIndex;
    const chips: GuideChip[] = [];
    if (days >= 1) {
      chips.push({
        key: "end-day",
        dayIndex: endIndex,
        y: yIn(endIndex, end),
        text: `${days === 1 ? t("ui.timeline.44") : t("ui.timeline.54", { days: days })} ${formatClock(end)}`,
      });
    }
    chips.push({
      key: "start-day",
      dayIndex: startIndex,
      y: yIn(startIndex, start),
      text: `${days === 1 ? t("ui.timeline.55") : t("ui.timeline.56", { days: days })} ${formatClock(start)}`,
    });
    return chips;
  }

  /**
   * C1.7（用户原话「我在周六排任务，就不知道对不对得齐，因为离得太远」）+ round24（用户第二轮实测反馈）：
   * 手势中画**起止两条**水平辅助线 + 刻度处**两个**时间胶囊。
   *
   * 与第一版的差别（都是用户自己用出来的）：
   * ① 拉伸时**两个胶囊都显示**（第一版只标「正在动的那一边」）；
   * ② 终点跨到次日时，终点线**画在次日那一列**（此前只有「夹在本列列底」那一条）。
   *
   * `anchorIndex` = 手势发生在哪一列：胶囊的纵向位置按它算 —— 跨天的时刻夹到列底，
   * 用户实测「底线那里的胶囊确实能帮我道结束时间」。
   */
  const guides = $derived.by(() => {
    const p = blockPreview;
    let start: number;
    let end: number;
    let anchorIndex: number;
    if (groupPreview.anchorId) {
      // round61.2（你验收图1）：多选拿起 —— 辅助线画**组的包络**：组内**最早起点** + **最晚终点**，
      // 都按「各自当天 0 点起的偏移」算（= 不计日期），再映射到锚点预览所在那一列，
      // 后面跟单块预览同一套渲染（线 + 胶囊 + 跨天小牌）。
      const anchor = groupPreview.ranges[groupPreview.anchorId];
      if (!anchor) return null;
      const idx = dayIndexOf(anchor.start);
      if (idx < 0) return null; // 锚点被预览到本周之外：与单块同口径，不画
      let loOff = Infinity;
      let hiOff = -Infinity;
      for (const r of Object.values(groupPreview.ranges)) {
        const day0 = localDayStartOf(r.start);
        if (r.start - day0 < loOff) loOff = r.start - day0;
        if (r.end - day0 > hiOff) hiOff = r.end - day0;
      }
      const base = dayWindows[idx].start;
      start = base + loOff;
      end = base + hiOff;
      anchorIndex = idx;
    } else if (p.id) {
      // 拉伸：跟着 `blockPreview` 走（15 分钟颗粒度）。
      // round25：锚列 = **被拖那一截所在的列**（`p.anchor`，TaskBlock 起手势时报的）
      // —— 多天块拖第 3 天那截时，胶囊应该在第 3 天，而不是块起点那一列。
      const i = dayWindows.findIndex((w) => w.start === p.anchor);
      const fallback = i >= 0 ? i : dayIndexOf(p.start);
      if (fallback < 0) return null;
      start = p.start;
      end = p.end;
      anchorIndex = fallback;
    } else {
      // 拖动：起点 = 吸附后的落点；时长来自被拖的块（从 Backlog 拖任务 = 新块固定 30 分钟）
      const drop = indicator;
      if (!drop) return null;
      const i = dayWindows.findIndex((w) => w.start === drop.dayStart);
      if (i < 0) return null;
      start = drop.start;
      end = drop.start + (dragDuration.seconds || SLOT_SECONDS);
      anchorIndex = i;
    }

    const win = dayWindows[anchorIndex];
    const lines: GuideLine[] = [];
    const startIndex = dayIndexOf(start);
    if (startIndex >= 0) {
      lines.push({ key: "start", at: start, dayIndex: startIndex, y: yIn(startIndex, start) });
    }
    // 终点线：① 落在哪一列就画在哪一列（跨天 → 次日那一列）② 越过本列窗口时，本列**列底**再补一条
    //（第一版就有的那条，用户点名说有用）—— 周日晚上跨到周一（不在本周）时只剩后者
    // round34（用户实测）：终点是**开区间**的 —— 正好落在 00:00/日界时，它的“位置”是**上一列的底**
    // （与块自己的最后一段、与相机跟随同一口径）；否则线会画到下一列顶上，相机却在上一列底。
    const endIndex = dayIndexOf(end - 1);
    if (endIndex >= 0) {
      lines.push({ key: "end", at: end, dayIndex: endIndex, y: yIn(endIndex, end) });
    }
    if (end > win.end) {
      lines.push({ key: "end-anchor", at: end, dayIndex: anchorIndex, y: dayHeightPx() });
    }

    // 胶囊：两个都显示，且拉到 15 分钟（只差 14px）时上下撑开一点，免得叠在一起
    let y0 = clampY(secondsToPx(start - win.start));
    let y1 = clampY(secondsToPx(end - win.start));
    const minGap = 16;
    if (y1 - y0 < minGap) {
      const push = (minGap - (y1 - y0)) / 2;
      y0 -= push;
      y1 += push;
    }
    return {
      lines,
      labels: [
        { key: "start", at: start, y: y0, nextDay: start > win.end },
        { key: "end", at: end, y: y1, nextDay: end > win.end },
      ],
      /**
       * 「这个时刻在哪一天」小牌（写在对应那条线的行首）：
       * - 终点比起点晚：`次日 HH:MM` / `+N 天 HH:MM`
       * - 起点比终点早（往回拉、或多天块）：`前一日 HH:MM` / `前 N 天 HH:MM`
       *
       * 判据史：round24 是「终点比**锚列**晚」→ round26（A 案）改「**正好**晚一天」→
       * round27 用户实测「拉到第二列还知道写次日，再往后就消失了」→ 改成**只要跨天就标**，
       * 天数写清楚；往回拉**同理**（以前根本没有往回那个牌）。措辞跟块上的标记一致。
       *
       * round61.2：多选拿起的**组包络**不用上面「起点可能在更早那一天」的语义
       * （包络起点映射在锚点当天或之后）—— 只标「终点去了次日」，不写误导的「前一日」。
       */
      chips:
        groupPreview.anchorId && endIndex > startIndex
          ? [
              {
                key: "end-day",
                dayIndex: endIndex,
                y: yIn(endIndex, end),
                text: `${endIndex - startIndex === 1 ? t("ui.timeline.44") : t("ui.timeline.54", { days: endIndex - startIndex })} ${formatClock(end)}`,
              },
            ]
          : buildDayChips(startIndex, endIndex, start, end),
    };
  });

  /** 覆盖层要用到的横向坐标（`.board` 坐标系）：刻度区右边缘 + 每条线**自己那一列**的右边缘 */
  let guideX = $state<{ from: number; to: Record<number, number> } | null>(null);
  let boardEl = $state<HTMLElement | null>(null);
  let scrollEl = $state<HTMLElement | null>(null);

  /** 只依赖**列号的组合**（不是整个 guides）：拖动中每帧都会重算 guides，量列宽不必跟着每帧跑 */
  const guideColumns = $derived([...new Set((guides?.lines ?? []).map((l) => l.dayIndex))].sort());

  function measureGuideX() {
    const columns = guideColumns;
    if (columns.length === 0 || !boardEl) {
      guideX = null;
      return;
    }
    const board = boardEl.getBoundingClientRect();
    const gutter = boardEl.querySelector(".gutter");
    if (!gutter) {
      guideX = null;
      return;
    }
    const bodies = boardEl.querySelectorAll(".day-body");
    const to: Record<number, number> = {};
    for (const i of columns) {
      const body = bodies[i];
      if (body) to[i] = body.getBoundingClientRect().right - board.left;
    }
    guideX = { from: gutter.getBoundingClientRect().right - board.left, to };
  }

  $effect(() => {
    void guideColumns.join(",");
    measureGuideX();
  });

  /** 刻度栏吸左（round24）后横向滚动会改变这些坐标（手势中滚动 → 重量一次） */
  /** round81（3.1c₁ · 宽-09）：双击刻度栏 = **时间刻度**的局部复位（回「跟随密度」；
   *  只作用于刻度栏，不碰网格的双击建块） */
  function resetScale() {
    if (layout.slotHeight !== "auto") void saveSlotHeight("auto");
  }

  function onScroll() {
    if (guideColumns.length > 0) measureGuideX();
    // round25：滚轮/自动滚动之后，指针下面的时刻变了 → 落点要跟着重量
    refreshDragDrop();
    // round61.2：框选起手后滚屏（自动/滚轮）→ 终点按最后指针的位置重算
    syncMarqueeEnd();
  }

  /**
   * round31（C1.9）：键盘操作后的**视觉跟随** —— 把「正在动的那条边」带进视野。
   * 鼠标那边不用它（贴边自动滚动 + 甩出边缘翻周已经有了）。
   * 只做**最小滚动**（nearest 语义）：要滚才滚，不居中、不乱跳（调研见 `docs/素材库/键盘操作.md` §五）。
   */
  function ensureTimeVisible(at: number) {
    const scroll = scrollEl;
    if (!scroll) return;
    const dayIndex = dayIndexOf(at);
    if (dayIndex < 0) return; // 不在本周的那条边：store 已经负责翻周了
    const win = dayWindows[dayIndex];
    const margin = 40;
    const y = DAY_HEAD_PX + secondsToPx(at - win.start);
    if (y < scroll.scrollTop + margin) {
      scroll.scrollTop = Math.max(0, y - margin);
    } else if (y > scroll.scrollTop + scroll.clientHeight - margin) {
      scroll.scrollTop = y - scroll.clientHeight + margin;
    }
    // 横向：把那一列带进可见区（列可能被横向滚动挡住）
    const column = scroll.querySelectorAll<HTMLElement>(".day")[dayIndex];
    if (!column) return;
    const c = column.getBoundingClientRect();
    const s = scroll.getBoundingClientRect();
    if (c.left < s.left) scroll.scrollLeft -= s.left - c.left;
    else if (c.right > s.right) scroll.scrollLeft += c.right - s.right;
  }

  /* ------------------------------------------------------------------ *
   * round61（10.2 多选）：框选（marquee）—— 空白处按住拖出一个矩形，碰到的块全选。
   * 与拖动引擎同一条分界：**块上拖 = 移动**（既有手势），空白处拖 = 框选（调研：Excalidraw 同处境）。
   * v1 只框**当前可见区域**（拖到边缘自动滚再继续框，留给下一批）。
   * ------------------------------------------------------------------ */
  /** 越过 4px 才算框选（与拖动引擎同阈值）；没越过 = 原来的「点空白清选中」 */
  const MARQUEE_THRESHOLD_PX = 4;

  let marquee = $state<{ x0: number; y0: number; x1: number; y1: number; moved: boolean } | null>(
    null,
  );
  let marqueePointer: number | null = null;
  /** 最后指针的**屏幕**坐标（round61.2）：内容滚了，按它把终点重算到新的内容坐标 */
  let marqueePointerAt = { x: 0, y: 0 };
  /** 起手时指针的**屏幕**坐标 —— 4px 阈值按指针位移量（与拖动引擎同一量纲；内容坐标会被滚屏影响） */
  let marqueeAnchorAt = { x: 0, y: 0 };

  /**
   * round61.2（你实测）：屏幕坐标 → `.board` **内容坐标**。
   * 起手点存内容坐标后，滚屏时它钉在它下面的内容上 —— 框跟着内容长，不再跟着窗口跑。
   */
  function boardPoint(clientX: number, clientY: number): { x: number; y: number } {
    const b = boardEl?.getBoundingClientRect();
    return { x: clientX - (b?.left ?? 0), y: clientY - (b?.top ?? 0) };
  }

  /** 指针没动、内容滚了（自动滚屏 / 滚轮）→ 按最后指针位置重算终点 */
  function syncMarqueeEnd(): void {
    if (!marquee) return;
    const p = boardPoint(marqueePointerAt.x, marqueePointerAt.y);
    marquee.x1 = p.x;
    marquee.y1 = p.y;
  }

  /** 框选矩形与每个块段（`[data-block-id]`）相交 → 命中（碰到就算）—— 两边都换算到内容坐标系 */
  function blocksInMarquee(): string[] {
    if (!marquee || !boardEl) return [];
    const board = boardEl.getBoundingClientRect();
    const left = Math.min(marquee.x0, marquee.x1);
    const right = Math.max(marquee.x0, marquee.x1);
    const top = Math.min(marquee.y0, marquee.y1);
    const bottom = Math.max(marquee.y0, marquee.y1);
    const hits: string[] = [];
    for (const el of boardEl.querySelectorAll<HTMLElement>("[data-block-id]")) {
      const id = el.dataset.blockId;
      if (!id || hits.includes(id)) continue;
      const r = el.getBoundingClientRect();
      const l = r.left - board.left;
      const t = r.top - board.top;
      if (l < right && l + r.width > left && t < bottom && t + r.height > top) hits.push(id);
    }
    return hits;
  }

  function onMarqueeMove(ev: PointerEvent) {
    if (!marquee || ev.pointerId !== marqueePointer) return;
    marqueePointerAt = { x: ev.clientX, y: ev.clientY };
    const p = boardPoint(ev.clientX, ev.clientY);
    marquee.x1 = p.x;
    marquee.y1 = p.y;
    if (
      !marquee.moved &&
      Math.hypot(ev.clientX - marqueeAnchorAt.x, ev.clientY - marqueeAnchorAt.y) >=
        MARQUEE_THRESHOLD_PX
    ) {
      marquee.moved = true;
    }
    // 拖过文字时浏览器会顺手选字 —— 框选期间把它清掉（不清就很难看出框到了谁）
    if (marquee.moved) window.getSelection()?.removeAllRanges();
    // round61.1（你验收实测）：指针贴到滚动区边缘就**自动滚屏** —— 否则选不到窗口外的东西
    // round61.2：滚屏每一帧都把终点按指针重量（内容动了，指针下面就是别的内容）
    if (marquee.moved && scrollEl) {
      autoScrollTo(scrollEl, () => marqueePointerAt, syncMarqueeEnd);
    }
  }

  function onMarqueeUp(ev: PointerEvent) {
    if (!marquee || ev.pointerId !== marqueePointer) return;
    const moved = marquee.moved;
    const hits = moved ? blocksInMarquee() : [];
    removeMarqueeListeners();
    marquee = null;
    if (!moved) return; // 没越过阈值：选中已经在 pointerdown 那一刻清掉了（旧行为）
    if (hits.length === 0) {
      clearSelection();
      return;
    }
    // 按时间排序后交给 store（第一块当锚点）
    const ordered = hits
      .map((id) => blocks.find((b) => b.id === id))
      .filter((b): b is Block => !!b)
      .sort((a, b) => a.start_at - b.start_at || a.end_at - b.end_at || a.id.localeCompare(b.id));
    selectMany(ordered.map((b) => b.id));
  }

  function removeMarqueeListeners() {
    window.removeEventListener("pointermove", onMarqueeMove);
    window.removeEventListener("pointerup", onMarqueeUp);
    window.removeEventListener("pointercancel", onMarqueeUp);
    stopAutoScroll(); // 框选收尾也要停掉边缘滚屏
    marqueePointer = null;
  }

  /** `Esc` / 手势中断：撤框（回到按下之前 —— 选中不动） */
  function cancelMarquee() {
    removeMarqueeListeners();
    marquee = null;
  }

  /** round31：点空白 = 取消选中（点在块上交给块自己；导航按钮在 `.head` 里，不走这里）
   *  round61：按下那一刻照旧清选中，同时跟踪「可能起框选」——越过 4px 才算框选，
   *  松手时按框选结果重新选中（框选**替换**旧选中；没越过就什么都没发生）。 */
  function onBoardPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement | null;
    if (target?.closest("[data-block-id]")) return;
    if (e.button !== 0) return;
    clearSelection();
    // round64（C10）：多选开关关掉 → 只保留「点空白清选中」，不拉框选
    if (!featureOn("multi_select_enabled")) return;
    cancelMarquee();
    const p = boardPoint(e.clientX, e.clientY);
    marqueePointerAt = { x: e.clientX, y: e.clientY };
    marqueeAnchorAt = { x: e.clientX, y: e.clientY };
    marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, moved: false };
    marqueePointer = e.pointerId;
    window.addEventListener("pointermove", onMarqueeMove);
    window.addEventListener("pointerup", onMarqueeUp);
    window.addEventListener("pointercancel", onMarqueeUp);
  }

  // round24：时间轴改成整天 00:00–24:00（用户要 0 点后那段能看见），但**打开时仍停在 06:00**（用户拍板）
  // —— 06:00 = 第 12 格；只在挂载时滚一次，之后你滚到哪就是哪（换周也不动）
  $effect(() => {
    if (!scrollEl) return;
    scrollEl.scrollTop = DAY_HEAD_PX + 12 * slotHeightPx();
  });

  /**
   * round25：把指针换成落点（手势引擎调用）。**只看坐标**：
   * `clientX` 就近取列（板子内，含刻度栏那一条）、`clientY` 换算成该列的时刻（吸附 30 分钟）。
   * 旧实现用 `e.currentTarget`（浏览器给的拖拽目标）—— 真机上那个目标横向不更新，这就是
   * 用户实测「块拖不到隔壁列」的根。
   */
  function resolveDrop(clientX: number, clientY: number): { dayStart: number; start: number } | null {
    if (!boardEl) return null;
    const board = boardEl.getBoundingClientRect();
    const bodies = [...boardEl.querySelectorAll<HTMLElement>(".day-body")];
    if (bodies.length !== dayWindows.length) return null;
    const rects = bodies.map((el) => el.getBoundingClientRect());
    const dayIndex = dayIndexAtX(clientX, rects, { left: board.left, right: board.right });
    if (dayIndex < 0) return null; // 落回 Backlog / 面板空白 → 不移动
    const win = dayWindows[dayIndex];
    // round48（用户实测「英语作业拖不到游戏旁边」—— 游戏到 13:15 结束，而落点以前按
    // **30 分钟**吸附，13:15 根本落不到）：拖动落点改用**15 分钟**颗粒，与拉伸同一个脉冲
    // （`MIN_BLOCK_MINUTES`）—— 抓手能对齐到 :00/:15/:30/:45，接得上任何一块。
    const start = snapTime(
      timeAtClientY(clientY, rects[dayIndex].top, win.start),
      win.start,
      MIN_BLOCK_MINUTES,
      win.start,
      win.start + SLOT_COUNT * SLOT_SECONDS - SLOT_SECONDS,
    );
    return { dayStart: win.start, start };
  }

  /**
   * round26 #4（用户实测「拖到次日的方式反直觉」）：拉伸落点也改**二维** ——
   * `x` 定列（指针在哪一列就落哪一列）、`y` 定那一刻（夹在这一列的 [00:00, 24:00] 里）。
   * 想跨天就把指针拖到下一列，而不是「在同一列里一路往下拖」。
   * 指针跑到板子外（Backlog / 窗口外）→ 横向夹到**最近的一列**，不丢手势。
   */
  function resolveResize(clientX: number, edgeClientY: number) {
    if (!boardEl) return null;
    const bodies = [...boardEl.querySelectorAll<HTMLElement>(".day-body")];
    if (bodies.length !== dayWindows.length) return null;
    const rects = bodies.map((el) => el.getBoundingClientRect());
    const index = nearestDayIndex(clientX, rects);
    if (index < 0) return null;
    const win = dayWindows[index];
    // 夹在这一列之内：同列内最多 24:00（再往下拖也不越过当天），向上同理到 00:00
    const time = timeInColumn(edgeClientY, rects[index].top, win.start);
    return { dayStart: win.start, time };
  }

  /**
   * round27 #8（用户实测「我没法把块拖到下一周」）：指针甩出**日列区**的最右/最左边缘 → 手势引擎
   * 会在它停住 ~0.6 秒后调 `flipWeek` 翻周。用日列区的边界（而不是面板边界）定这条线：
   * 板子比面板宽时，贴面板边缘先触发的是**横向自动滚动**，滚到最后那一列露出来之后才碰得到它。
   */
  function edgeDwell(clientX: number): -1 | 0 | 1 {
    if (!boardEl) return 0;
    const bodies = boardEl.querySelectorAll<HTMLElement>(".day-body");
    if (bodies.length === 0) return 0;
    const first = bodies[0].getBoundingClientRect();
    const last = bodies[bodies.length - 1].getBoundingClientRect();
    if (clientX > last.right + EDGE_DWELL_MARGIN_PX) return 1;
    // round48（用户实测「任务块拖在 BACKLOG 这列也会触发向前翻页」）：
    // 左边这条边**只认时间轴面板内部** —— 以前只要在第一天列左边 8px 外就算（连整条 Backlog
    // 和分隔条都算）→ 从 Backlog 拖一条任务时指针本来就在左边，停 0.6 秒就把周往前翻 ✗。
    const panelLeft = boardEl.closest(".timeline")?.getBoundingClientRect().left;
    if (panelLeft == null || clientX >= panelLeft) {
      if (clientX < first.left - EDGE_DWELL_MARGIN_PX) return -1;
    }
    return 0;
  }

  /**
   * C1.8（R33）：双击**空白格** → 建一个 30 分钟的临时安排块，并立刻就地去命名。
   * 「空白格」= 没点在块上（块上的双击各有其主：临时块 = 改名，普通块 = 标记完成）；
   * 刻度栏 / 日头都不带这个处理，自然不会误建。
   */
  async function onDayDoubleClick(e: MouseEvent, dayStartSec: number, bodyEl: HTMLElement) {
    if (!featureOn("temp_block_enabled")) return; // round64（C10）：临时块开关
    const target = e.target as HTMLElement | null;
    if (target?.closest(".box")) return;
    const rect = bodyEl.getBoundingClientRect();
    const start = snapTime(
      timeAtClientY(e.clientY, rect.top, dayStartSec),
      dayStartSec,
      SLOT_MINUTES,
      dayStartSec,
      dayStartSec + SLOT_COUNT * SLOT_SECONDS - SLOT_SECONDS,
    );
    try {
      // round80（79-03）：改名态在 store 内部就置上了（在 reloadWeek 之前）—— 这里不再重复，
      // 以免那一帧缝隙里块先按「非改名态」渲染、动作浮层闪一下。
      await createTempBlock(start, start + SLOT_SECONDS);
      void maybeHint("temp"); // round64：第一次建临时块 → 教学提示
    } catch {
      // ipc 层已弹 Toast
    }
  }

  /** round77（3.1b）：提示条的优先级（橙 > 绿 > 渐进）—— 只在这里算一次 */
  const showOverloadBar = $derived(
    sanity.enabled && overloadedDays().length > 0 && sanityBar.dismissedWeek !== week.from,
  );
  const showNudgeBar = $derived(featureOn("review_enabled") && nudge.show);
  /** round77 收尾：**固定槽**的占用优先级也在这里算一次 —— 多选动作条 > 键位提示 > 橙 > 绿 > 渐进。
   *  为什么键位提示也进来：它以前在 `.head-actions` 里，出现/消失会让那一组**整组换行状态翻转**
   *  → 头部高度在手势中途变一次 → 落点偏一格（round26#4 的红 / 三条不变量断言实测 -26px）。 */
  const showBulkBar = $derived(selection.ids.length > 1 && featureOn("multi_select_enabled"));
  const showKeyHint = $derived(
    !!keyHintItems && !link.pendingId && layout.hintBarMode !== "hidden",
  );

  // 板子挂载后把自己的能力交给手势引擎：落点怎么算 + 哪个容器要自动滚
  $effect(() => {
    if (!boardEl || !scrollEl) return;
    const scroll = scrollEl;
    attachDragHost({
      scrollEl: scroll,
      resolve: resolveDrop,
      resolveResize,
      edgeDwell,
      flipWeek: (dir) => goWeek(dir),
    });
    return () => attachDragHost(null);
  });

</script>

<section class="timeline">
  <header class="head">
    <h2 class="range">{range}</h2>
    <!-- C1.3：跳周（键盘 ← → 同效）；round31：鼠标跳周时顺手取消选中（免得选中的块留在看不到的那一周） -->
    <nav class="week-nav">
      <button type="button" title={t("ui.timeline.34")} onclick={() => { clearSelection(); goWeek(-1); }}><Icon name="chevron-left" size={16} /></button>
      <button type="button" title={t("ui.timeline.35")} onclick={() => { clearSelection(); goWeek(1); }}><Icon name="chevron-right" size={16} /></button>
      {#if !onNowWeek}
        <button type="button" class="now" title={t("ui.timeline.36")} onclick={() => { clearSelection(); goNow(); }}>{t("ui.timeline.50")}</button>
      {/if}
      <!-- C1.5：撤销 / 重做（栈空时点一下会提示「没有可撤销的操作」） -->
      <button type="button" title={t("ui.timeline.37")} onclick={() => void undo()}><Icon name="undo-2" size={16} /></button>
      <button type="button" title={t("ui.timeline.38")} onclick={() => void redo()}><Icon name="redo-2" size={16} /></button>
    </nav>
    {#if weekendNoteText}
      <!-- round67.1（你的第 6 条）：没内容就不出现 —— 有块/有预览才说，点一下恢复显示 -->
      <button
        type="button"
        class="weekend-note"
        title={t("ui.timeline.39")}
        onclick={() => {
          void note("weekend_back"); // round68（19.1）：把隐藏的周末找回来
          void saveWeekendHidden(false);
        }}
      >{t("ui.timeline.40", { weekendNoteText: weekendNoteText })}</button
      >
    {/if}
    <!-- round77（3.1b）：**动作组**（视图类入口 + 设置）—— 与左边的跳周/周范围分组，
         并右对齐（布局重审 L01：以前跟在跳周按钮后面，1500px 下右边空 ~90px）。 -->
    {#if gestureHint}
      <!-- C1.3：手势中实时显示时间 —— 15 分钟颗粒度下判断对齐就靠它。
           round77（3.1b）：改成**绝对定位的浮层**（见 `.gesture-hint`）—— 它绝不能占头部高度：
           拖动中途头部变高 = 落点跟着偏（实测偏了一格 = 30 分钟）。 -->
      <span class="gesture-hint">{gestureHint}</span>
    {/if}
    <div class="head-actions">
    <!-- C7（round52）：一周总览入口（▦）—— 覆盖式面板，不占常驻空间；到点没看时带一个小点
         round53：从「复盘」改叫「总览」（用户 2026-10-03：它什么时候都能看，不只周日复盘） -->
    {#if featureOn("review_enabled")}
      <button
        type="button"
        class="review-open"
        class:dot={nudge.show}
        title={t("ui.timeline.41")}
        onclick={() => openReview()}><Icon name="layout-grid" size={16} />{t("ui.timeline.51")}</button
      >
    {/if}
    <!-- 10.1（round60）：数据统计入口（全时段累计；只读面板）
         round82（11.5）：**总览开着时这个按钮收起来**
         round83（§8.1）：口径是**功能开关**（`review_enabled` 关 = 总览关）——
         旧写法拿 `review.open`（面板开着）当「总览关」→ 总览没开时顶栏还多一个独立按钮（你图 1） -->
    {#if featureOn("stats_enabled") && !featureOn("review_enabled")}
      <button
        type="button"
        class="stats-open"
        title={t("ui.timeline.42")}
        onclick={() => openStats()}><Icon name="chart-column" size={16} />{t("ui.timeline.52")}</button
      >
    {/if}
    {#if featureOn("templates_enabled")}
      <TemplatePicker />
    {/if}
    <!-- C6（round44）：理智值的两个旋钮（每天预算 / 显示开关） -->
    <SanitySettings />
    </div>
    {#if link.pendingId}
      <!-- C3 / R18：待链提示条（常驻，直到接上或点空白）
           round32 #2：文案缩短 + 去掉「取消」按钮（点空白本来就是取消 —— 用户点名） -->
      <div class="link-hint">
        <span>{t("ui.timeline.43")}</span>
      </div>
    {/if}
    <!-- C6（round44）：本周哪天超载就写一句话；round77（3.1b）：提示条**同屏最多一条**，
         优先级 **多选动作条 > 键位提示 > 橙 > 绿 > 渐进**（布局重审 L03 —— 以前会叠三层，
         715px 下把时间轴顶到 y≈255）。优先级只在这一处算，别让每个条自己判。
         round77 收尾：槽高走 `--strip-height`（舒适档 28px，随密度）—— 条与键位提示的出现/消失都不会改变头部高度。
         为什么较真：条一出现，下面的时间轴就整体下移；手势正进行时这一下会让落点偏一格
         （实测偏 26~30px = 一格，`round26#4` 的红）。键位提示以前在 `.head-actions` 里，
         它一走会让那一组**整组换行状态翻转**（实测 -26px）→ 也收进这条固定槽。 -->
    <div class="hint-slot">
      <!-- round61（10.2 多选）：选中多块时的动作条（现在与提示条/键位提示共用固定槽，不再自己占一行） -->
      {#if showBulkBar}
        <BulkBar />
      {/if}
      {#if keyHintItems && showKeyHint}
        <!-- （`keyHintItems` 在这里再判一次只是为了给 TS 收窄；条件与 `showKeyHint` 同真同假） -->        <!-- round31（C1.9）：选中块之后写清当前模式的键位（拿进固定槽 —— 见上面那段注释）。
             round32 #2：接链提示在的时候别再挤一条（用户实测「挤起来了」）；
             round42：键帽 + 动作词（紧凑、人话，见 keyHintItems 的注释）；
             round54（BU）：**拿起中也要显示**（旧写法把它顶掉）+ `Enter` 标「拿起/放下」；
             round55：补的 `Ctrl+Z 撤销` 已删（用户：「悬停回退键就能显示」）；
             round67.1：只有两档 —— 常显 / 不显示（「按需」你实测否掉，`?` 键帽随之下线）；
             round77 收尾：手势中只切**可见性**（保留占位）—— 卸载会让槽内内容突变，与槽高无关但避免闪。
             多选时与动作条并排（两个都是当前选中态的说明/入口，以前也是同屏）。 -->
        <span
          class="key-hint"
          class:dimmed={!!gestureHint && !selection.grabbed}
          title={keyHintItems.map((it) => `${it.keys} ${it.label}`).join(" · ")}
        >
          {#each keyHintItems as it, i (it.keys + it.label)}
            {#if i > 0}<span class="kh-sep">·</span>{/if}
            <kbd class="kh-key">{it.keys}</kbd><span class="kh-act">{it.label}</span>
          {/each}
        </span>
      {/if}
      <SanityBar hidden={showBulkBar || showKeyHint} />
      <!-- C7（round52）：周复盘提醒（应用内轻提示，一周一次；没到点/已看过就不渲染）
           round64（C10）：总览开关关掉时整条不出现（也不取水位线） -->
      {#if featureOn("review_enabled")}
        <ReviewNudge hidden={showBulkBar || showKeyHint || showOverloadBar} />
      {/if}
      <!-- round64（C10）：一次性教学 / 模板建议（一次一条；两个开关都在设置里） -->
      <HintBar hidden={showBulkBar || showKeyHint || showOverloadBar || showNudgeBar} />
    </div>
  </header>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scroll" bind:this={scrollEl} onscroll={onScroll} onpointerdown={onBoardPointerDown}>
    <div class="board" bind:this={boardEl}>
      {#if marquee?.moved}
        <!-- round61.2：框选矩形画在 `.board` 里、坐标是**内容坐标** —— 滚屏时跟着内容走，不跟着窗口跑 -->
        <div
          class="marquee-rect"
          aria-hidden="true"
          style="left: {Math.min(marquee.x0, marquee.x1)}px; top: {Math.min(
            marquee.y0,
            marquee.y1,
          )}px; width: {Math.abs(marquee.x1 - marquee.x0)}px; height: {Math.abs(marquee.y1 - marquee.y0)}px"
        ></div>
      {/if}
      {#if featureOn("sequences_enabled")}
        <Sequence />
      {/if}
      {#if guides && guideX}
        <!-- C1.7 / round24：手势对齐辅助线（每条线画在**它自己那一列**；跨天时终点线落在次日） -->
        <div class="guides" aria-hidden="true">
          {#each guides.lines as line (line.key)}
            <div
              class="align-line"
              style="top: {line.y + DAY_HEAD_PX}px; left: {guideX.from}px; width: {Math.max(
                (guideX.to[line.dayIndex] ?? guideX.from) - guideX.from,
                0,
              )}px"
            ></div>
          {/each}
          {#each guides.chips as chip (chip.key)}
            <span
              class="align-label day-chip"
              style="top: {chip.y + DAY_HEAD_PX}px; left: {guideX.from + 4}px"
              >{chip.text}</span
            >
          {/each}
        </div>
      {/if}
      <div class="gutter" ondblclick={resetScale} title={t("ui.timeline.59")}>
        {#each slotIndexes as i (i)}
          <div class="tick">{i % 2 === 0 ? formatSlotLabel(i) : ""}</div>
        {/each}
        <!-- C1.7：刻度胶囊放在**刻度栏里面** —— 刻度栏吸左（round24）之后，它才能跟着一起不被滚走 -->
        {#if guides}
          {#each guides.labels as label (label.key)}
            <span class="align-label" style="top: {label.y + DAY_HEAD_PX}px">
              {#if label.nextDay}<b>{t("ui.timeline.44")}</b>{/if}{formatClock(label.at)}
            </span>
          {/each}
        {/if}
      </div>

      {#each dayWindows as { day, start, end }, dayIndex (day.toISOString())}
        {@const load = dayOf(start)}
        <div class="day" class:today={start === todayStart}>
          <!-- C7（round52）：点日头（含那根小条）= 开复盘并聚焦这天 —— R46 的入口之一。
               用真的 <button>（不是给 div 挂 onclick）：键盘也能到，svelte-check 的 a11y 两条规则都满足 -->
          <div class="day-head">
            <button
              type="button"
              class="day-pick"
              title={t("ui.timeline.45")}
              onclick={() => openReview(start)}
            >
              {formatDayLabel(day)}
            {#if sanity.enabled && load && load.minutes > 0}
              <!-- C6：耗能小条（常驻指示器）。长度 = 占预算多少；≥100% 变红。
                   未来那些天是「预计」（还没发生）→ 淡一点；但**超载不淡**（那是要你看见的） -->
              <span
                class="load {load.state}"
                class:future={!!sanity.week &&
                  sanity.week.today_index >= 0 &&
                  dayIndex > sanity.week.today_index}
                style="--pct: {Math.min(load.energy_pct, 100)}%"
                role="meter"
                aria-label={t("ui.timeline.46")}
                aria-valuenow={Math.min(load.energy_pct, 100)}
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuetext={loadTitle(formatDayLabel(day), load)}
                title={loadTitle(formatDayLabel(day), load)}
              ><i></i></span>
            {/if}
            </button>
          </div>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="day-body"
            ondblclick={(e) => void onDayDoubleClick(e, start, e.currentTarget as HTMLElement)}
          >
            {#if dimSegs.length > 0}
              <!-- round82（3.1c₂ · 淡-12）：夜间淡化带 —— **必须是本列第一个子元素**：网格是背景（永远最底），
                   之后的落点线 / 块 / 现在线按 DOM 顺序天然压在上面（不加 z-index，`淡-09` 有断言）。
                   跨天时段（如 22:00–06:00）由 `nightSegments` 拆成两段。 -->
              <div class="dim-band" aria-hidden="true">
                {#each dimSegs as seg (`${seg.from}-${seg.to}`)}
                  <span
                    style="top:{(seg.from / 1440) * 100}%; height:{((seg.to - seg.from) / 1440) * 100}%"
                  ></span>
                {/each}
              </div>
            {/if}
            {#if indicator?.dayStart === start}
              <div class="drop-line" style="top: {indicator.y}px"></div>
            {/if}
            {#each layouts[dayIndex] as box (box.sourceCopy ? box.id + ":source" : box.id)}
              <!-- round29 #5：跨周拉伸时这块不在本周数据里（`blocksById` 里没有它）→ 用预览自带的快照画，
                   否则布局算出盒子、渲染却因为取不到 block 而整个跳过（用户实测「绿条没跟上来」✗） -->
              {@const block = blocksById.get(box.id) ?? previewSnapshot(box.id)}
              {#if block}
                <!-- round24：标记用**预览值**（拉伸时立刻能看到「续到下一天」），
                     把手却用**落库值**（不然拖到一半把手会消失 → 指针捕获丢、手势断掉） -->
                {@const shown = previewOf(block.id)}
                {@const shownStart = shown ? shown.start : block.start_at}
                {@const shownEnd = shown ? shown.end : block.end_at}
                <div
                  class="box"
                  style="top: {box.top}px; height: {box.height}px; left: {(box.colIndex * 100) /
                    box.colCount}%; width: {100 / box.colCount}%"
                >
                  <!-- round24：跨天块的两段各带一个标记（用户拍板要的）——
                       标在盒子**外面**，免得跟任务名/时间抢那点宽度 -->
                  {#if shownStart < start}
                    <span class="cont-mark top" title={t("ui.timeline.47")}>{t("ui.timeline.48")}</span>
                  {/if}
                  {#if shownEnd > end}
                    <span class="cont-mark bottom">{t("ui.timeline.49", { end: overflowHint(shownEnd, end) })}</span>
                  {/if}
                  <TaskBlock
                    {block}
                    taskTitle={getTitle(block.task_id)}
                    taskExempt={getExempt(block.task_id)}
                    segStart={Math.max(shownStart, start)}
                    segEnd={Math.min(shownEnd, end)}
                    segIndex={segmentIndexOf(start, shownStart)}
                    segCount={segmentCount(shownStart, shownEnd)}
                    narrow={box.colCount > 1}
                    cols={box.colCount}
                    labelLines={labelLinesFor(box)}
                    tall={box.height >= 40}
                    continues={block.start_at < start}
                    overflows={block.end_at > end}
                    flashing={flash.ids.includes(block.id)}
                    overlay={overlayAnchor(box)}
                  />
                </div>
              {/if}
            {/each}
            {#if start === todayStart && nowY !== null && prefs.nowLine}
              <!-- round76（3.1a）：现在线 —— 警示色 2px + 「现在」小牌。
                   压在线上的块之上（Google / Outlook 惯例），但 pointer-events: none（不吃任何手势）--> 
              <span class="now-line" style="top: {nowY}px" aria-hidden="true">
                <b>{t("ui.timeline.57")}</b>
              </span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </div>
  <!-- round78（3.1b₂ · 教-03）：整周空 → 格子中央一句话指路（你已批文案）。
       `pointer-events: none`：它只是指路牌，不能挡双击建块 / 拖任务进来。 -->
  {#if weekEmpty}
    <p class="week-empty" role="note">{t("ui.timeline.58")}</p>
  {/if}
</section>

<style>
  .timeline {
    position: relative; /* round77：手势提示浮层的定位祖先 */
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    flex: 1;
    min-width: 0;
    padding: var(--space-3);
    background: var(--card);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
  }

  .head {
    display: flex;
    align-items: baseline;
    /* round44（用户验收 0.7.4 的截图）：窄窗口里周范围被跳周按钮 + 键位提示条挤到只剩几十像素，
       文本按连字符断成 5 行竖排（2026- / 09-28 / ~ / 2026- / 10-04）。
       修法：装不下就**整体换行**（第二行放提示条），而不是把周范围压变形。 */
    flex-wrap: wrap;
    row-gap: var(--space-1);
    /* round86（0.32.0 · ③）：头部装饰两项（值在 palettes.css；没声明 = 今天的样子）
       · inset 线（谷地黄的左侧条 / 包豪斯的底线 / 野兽派的黑线…）
       · 底部 1px **渐隐线**（装饰艺术的金线）—— 用背景画，不吃布局、不挤头部那一行 */
    box-shadow: var(--deco-timeline-head-shadow, none);
    background-image: var(--deco-head-rule, none);
    background-size: 100% 1px;
    background-position: bottom left;
    background-repeat: no-repeat;
  }

  /* round77（3.1b）：提示/状态条 + 键位提示的槽——**头部高度不变量**只保证「手势中途不变」（round26#4 的落点偏一格）。
     round78（验收带回 #3）：**没内容就收起** —— 旧写法 `min-height: var(--strip-height)` 常驻 28px，
     你验收时看到的就是那条空槽（关掉提示条之后）。占用判据看下面那条 `:has()`：
     有真内容（提示条 / 键位提示 / 多选条）才撑开；各条自己用 `.hidden` 关掉时不占位。 */
  .hint-slot {
    display: flex;
    flex: 1 0 100%;
    align-items: stretch;
    min-width: 0; /* round77 收尾：不加它，槽会按条的最小内容宽撑宽头部（715 实测 403>343 横向溢出） */
    min-height: 0;
  }

  /* 有内容》撑到固定槽高（它是**下限**：任何条都不许把它顶高一截 —— 6b P2 的契约）；
     没内容（只剩 `.hidden` 那些）》槽高 0，头部回到一行。 */
  .hint-slot:has(> *:not(.hidden)) {
    min-height: var(--strip-height);
  }

  /* round77（3.1b）：动作组右对齐（`margin-left: auto`）—— 1500 与 715 都贴内容右缘；
     窄窗装不下时整组换行（`round44` 那套「装不下就整体换行」不破）。 */
  .head-actions {
    display: flex;
    align-items: baseline;
    /* round77（3.1b）：**组内不换行** —— 它是头部的一个整块：要么整块在第一行、要么整块换行。
       round77 收尾：键位提示已经**移出本组**（进 `.hint-slot`）—— 它以前在这里会让整组的换行
       状态在手势中途翻转（实测 -26px，落点偏一格）；现在组内只剩按钮，与选中态无关。 */
    flex-wrap: nowrap;
    gap: var(--space-1) var(--space-2);
    margin-left: auto;
    min-width: 0;
    max-width: 100%;
  }

  .range {
    margin: 0;
    /* round44：周范围**永远一行**（该被省略的是键位提示条 —— 它本来就有 ellipsis） */
    flex: none;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--text-title);
    font-weight: 400;
    color: var(--text-secondary);
    letter-spacing: var(--label-tracking);
  }

  /* C1.3：跳周按钮 */
  .week-nav {
    display: flex;
    gap: 2px;
    margin-left: var(--space-2);
    flex: none; /* round44：按钮组不参与压缩（免得按钮自己被挤到内部折行） */
  }

  .week-nav button {
    padding: 0 var(--space-2);
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-body);
    line-height: var(--line-body);
    cursor: pointer;
  }

  .week-nav button:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .week-nav .now {
    font-size: var(--text-meta);
  }

  /* C7（round52）：复盘入口 —— 与跳周按钮同一套壳子 */
  .review-open,
  .stats-open,
  .weekend-note {
    margin-left: var(--space-2);
    padding: 0 var(--space-2);
    flex: none;
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-body);
    line-height: var(--line-body);
    cursor: pointer;
  }

  .review-open:hover,
  .stats-open:hover,
  .weekend-note:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* C7：到点且还没看 → 按钮上一个小点（轻提醒，不闪不弹） */
  .review-open.dot {
    position: relative;
    border-color: var(--accent);
  }

  .review-open.dot::after {
    content: "";
    position: absolute;
    top: -3px;
    right: -3px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }

  /* C7（round52）：日头那个「看这天明细」的按钮 —— 壳子就是原来的日头，视觉不变 */
  .day-head .day-pick {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    width: 100%;
    height: 100%;
    padding: 0;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    /* round85：按钮自己不继承 text-transform（UA 可能会清掉）—— 日头文字就在这颗按钮里，显式跟上展示字 */
    font-family: var(--font-display);
    text-transform: var(--display-transform);
    text-align: left;
    cursor: pointer;
  }

  .day-head .day-pick:hover {
    color: var(--accent);
  }

  /* C1.3：手势中的实时区间（拉伸/拖动时出现） */
  /* round77（3.1b）：手势提示 = **浮层**（原来它占头部一行：拖动中途出现会让头部变高、
     落点跟着偏一格 —— 实测偏了 30 分钟）。现在绝对定位在时间轴右上角，**不动任何布局**。 */
  .gesture-hint {
    position: absolute;
    top: var(--space-3);
    right: var(--space-3);
    z-index: 6;
    padding: 1px var(--space-2);
    background: var(--accent);
    border-radius: var(--radius);
    box-shadow: var(--shadow-pop);
    color: var(--on-accent);
    font-family: var(--font-mono);
    font-size: var(--text-meta);
    white-space: nowrap;
    pointer-events: none;
  }

  /* round31（C1.9）：键盘提示条（常驻到取消选中）
     round42：改成「键帽 + 动作词」的紧凑排版 —— 键贴小方块、动作用普通字体，整条短一大截
     round54（BU）：**窄窗口不再截断**：装不下就**换行**（round44 那套「让位给周范围」的口径不变，
     周范围仍然一行、任何一项都不许被吃掉 —— 实测 689px 下 7 项会溢出 332px，
     正是「拿起中看不见键位」被报上来的同一类问题（看不见＝等于没有） */
  .key-hint {
    display: inline-flex;
    flex: 0 1 auto;
    /* round78（验收带回 #2a）：窄窗**允许换行** —— 1500 一行放得下（实测内容 539px），
       715/737 的可用宽只有 ~355px，旧写法 `nowrap + overflow: hidden` 是硬裁（实测裁 184/162px，
       看不到的两项连提示都没）→ 换成换行：4 项都在、都不被裁（round54 BU③ 的规矩：
       不许用「少放几项」换「不溢出」）。代价是窄窗下键位提示占两行、槽跟着高一点 ——
       与 #3 同一个口径（那次高度变化发生在选中之后，不在手势中途）。 */
    flex-wrap: wrap;
    align-items: center;
    gap: 3px;
    row-gap: 2px;
    min-width: 0;
    padding: 1px var(--space-2);
    border: 1px solid var(--grid-line);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: var(--text-meta);
  }

  /* round77 收尾：手势中键位提示只隐**内容**（保留占位）—— 卸载/display:none 都会让布局变一次 */
  .key-hint.dimmed {
    visibility: hidden;
  }

  .kh-key {
    padding: 0 3px;
    font-family: var(--font-mono);
    font-size: var(--text-meta);
    color: var(--text-primary);
    background: var(--bg);
    border: 1px solid var(--grid-line);
    border-radius: 3px;
    white-space: nowrap;
  }

  .kh-act {
    margin-left: 1px;
    white-space: nowrap; /* 换行只发生在项与项之间，动作词自己不许断开 */
  }

  .kh-sep {
    margin: 0 2px;
    opacity: 0.45;
  }

  /* C3 / R18：待链提示条（常驻，直到接上或点空白） */
  .link-hint {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-left: auto;
    padding: 2px var(--space-2);
    background: var(--accent);
    border-radius: var(--radius);
    font-size: var(--text-meta);
    color: var(--text-primary);
  }

  .scroll {
    flex: 1;
    overflow: auto;
  }

  /* round78（3.1b₂ · 教-03）：空周指路 —— 盖在滚动区中央（不占布局、不吃手势） */
  .week-empty {
    position: absolute;
    inset: var(--space-3);
    display: grid;
    place-items: center;
    margin: 0;
    padding: 0 var(--space-4);
    text-align: center;
    color: var(--text-secondary);
    font-size: var(--text-body);
    line-height: var(--line-body);
    pointer-events: none;
  }

  /* round61（10.2 多选）/ round61.2：框选矩形 —— 覆盖物，不接事件；画在 `.board` 里（内容坐标系） */
  .marquee-rect {
    position: absolute;
    z-index: 70;
    pointer-events: none;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }

  .board {
    display: flex;
    gap: var(--space-2);
    /* round81（3.1c₁ · 宽-03）：列可伸缩 —— 富余时由 `min-width: 100%` 分掉；
       装不下时 `width: max-content` 让板子自己变宽（滚动发生在 `.scroll`，板内不溢出） */
    width: max-content;
    min-width: 100%;
    /* C3：细线覆盖层（Sequence.svelte）按这个容器定位 → 它必须是定位祖先 */
    position: relative;
  }

  /* round24：刻度栏**吸左** —— 用户实测「窗口缩到半屏时它被横向滚走了」；
     最左的时间刻度本来就不该跟着天列一起跑。`::before` 把右那 8px 缝也盖上（不然列会从缝里露一条）。
     round25①（用户第三轮实测：半屏横滚时周一那里「穿模」）：z-index 2 → **5** —— 必须在吸顶日头
     （`.day-head` 的 4）**之上**，否则列从它下面滑过时，日头连背景会画到刻度栏上面。 */
  .gutter {
    position: sticky;
    left: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    flex: none;
    width: var(--gutter-width);
    padding-top: var(--day-head-height);
    background: var(--card);
  }

  .gutter::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: calc(-1 * var(--space-2));
    background: var(--card);
    /* 必须在刻度文字**下面**：它是定位元素，而 `.tick` 是普通流元素 → 不给负 z-index 就会
       把整列刻度数字盖掉（截图里抓到过一次） */
    z-index: -1;
  }

  /* round25① 补的那条表头线（`.gutter::after`）已在 round26 删掉：
     用户实测「00:00 头上一条横线很突兀」（#1）—— 那是为了「表头线别在刻度栏处断」自己加的，
     不是用户要的；日头自己的上/下边线（⑥ 的修复）不靠它，删了不影响。
     以后要补这道缝，先问用户。 */

  .tick {
    /* round24：数字**顶边贴着格线**（以前是在 28px 那格里居中）——
       块改成按时间绝对定位（C1.1）之后，块的**上边缘**才是时间点，画在格中间会差半格
       （14px = 15 分钟）；用户实测：「14:00 的块看起来像 13:45 开始」。 */
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    height: var(--slot-height);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-meta);
    line-height: var(--line-compact);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .day {
    display: flex;
    flex-direction: column;
    /* round81（3.1c₁ · 宽-03）：基准 = 密度档（--timeline-col-width，128/136/148）；有富余就均分，
       装不下不压窄（横向滚动由 `.scroll` 负责）；`min-width: 112px` 是“降到底也看得见时间”的保险 */
    flex: 1 0 auto;
    width: var(--timeline-col-width);
    min-width: 112px;
    background: var(--bg);
    border: 1px solid var(--text-secondary);
    /* round25⑥（用户第三轮实测：日头顶栏「滚一点点」、表头上边线被盖掉）：
       上边线**交给吸顶的日头自己带** —— 否则纵向滚 ≥1px 那条线就被滚出视口，
       日头也会相对上移 1px（它的自然位置原来在日头线下面 1px）。 */
    border-top: 0;
    border-radius: var(--radius);
    /* round24：裁剪从 `.day` 挪到 `.day-body` —— `.day` 一旦是滚动容器（overflow:hidden），
       里面的吸顶日头就只能相对它粘，粘不到 `.scroll` ✗ */
  }

  .day-head {
    /* round24：日头**吸顶** —— 默认滚到 06:00（用户拍板）之后，不吸顶就看不到「09-28 Mon」 */
    position: sticky;
    top: 0;
    z-index: 4;
    height: var(--day-head-height);
    /* round25⑥：上边线长在自己身上（`.day` 的 top 边线已去掉）。
       round77（3.1b）：总高 24 → 28px（`--day-head-height`）；line-height 26 = 28 - 上下各 1px 线。 */
    border-top: 1px solid var(--text-secondary);
    border-bottom: 1px solid var(--text-secondary);
    background: var(--card);
    border-radius: var(--radius) var(--radius) 0 0;
    color: var(--text-primary);
    /* 字-05：日头 = 标题层（主色 + 加粗）；刻度才是次要色。
       round85（0.31.0）：展示字（默认 = 界面字体；北境极夜/深海冷光在 `palettes.css` 里覆盖）
       round86（0.32.0 · ⑤）：四个量（字阶倍率 / 字重 / 小大写 / 字距）—— **行高不变**（26px 固定），
       所以把字号放大也不会改动日头行高与块的位置。 */
    font-family: var(--font-display);
    text-transform: var(--display-transform);
    font-size: calc(var(--text-title) * var(--display-scale, 1));
    font-weight: var(--display-weight, 600);
    font-variant: var(--display-variant, normal);
    letter-spacing: var(--display-tracking, normal);
    line-height: 26px;
    /* round86（0.32.0 · ③）：日头下细线（白瓷）—— 用背景画：贴在底边往上 4px（文字下方、底边线之上） */
    background-image: var(--deco-day-head-rule, none);
    background-size: 100% 1px;
    background-position: bottom 4px left;
    background-repeat: no-repeat;
    text-align: center;
  }

  /* C6（round44）：日头下沿的耗能小条 —— 常驻指示器（round44 plan §3.5）
     它是绝对定位的（日头是 sticky = 定位祖先），所以跟着日头一起吸顶。 */
  .load {
    position: absolute;
    right: 0;
    bottom: -1px;
    left: 0;
    height: 3px;
    background: var(--grid-line);
    overflow: hidden;
  }

  .load i {
    display: block;
    width: var(--pct, 0%);
    height: 100%;
    background: var(--accent);
  }

  /* 接近预算（80–99%）：半透明警示色 */
  .load.near i {
    background: var(--warn);
    opacity: 0.5;
  }

  /* 超载（≥100%）：实心警示色 */
  .load.over i {
    background: var(--warn);
    opacity: 1;
  }

  /* 未来的日子是「预计」（还没发生）→ 淡一点，与「实绩」分开；超载不淡 */
  .load.future i {
    opacity: 0.6;
  }

  .load.over.future i {
    opacity: 1;
  }

  /* C1.1：块按时间范围绝对定位 —— 这个容器就是定位祖先 + 拖放目标（高度 = 48 格） */
  .day-body {
    position: relative;
    /* round76：一天列高度 = 48 格 × 当前格高（原来由内联 style 写死 JS 常量） */
    height: calc(var(--slot-height) * 48);
    overflow: hidden; /* 原来在 `.day` 上（块不越出列的边界/圆角） */
    border-radius: 0 0 var(--radius) var(--radius);
    background: var(--bg);
    /* round24：整点淡格线（每 2 格 = 1 小时）—— 用背景画，零 DOM、天然在块下面。
       round85（0.31.0）：主题**底纹层**在列底，**格线列在第一层（永远在上面）**。
       round86（0.32.0 · ②）：列底读的是 `--surface-image-cols` —— **只有细密纹理**（网格 / 等高线 /
       扫描线 / 点阵 / 斜条纹）；大尺度背景型（放射线 / 冷光晕）只铺页面（`--surface-image`），
       因为在 1440px 高的日列里它们会被拉成满列竖条 / 大色块。一套都没声明时回落 `none`。 */
    background-image: var(--surface-image-cols, none),
      repeating-linear-gradient(
        to bottom,
        var(--grid-line) 0 1px,
        transparent 1px calc(var(--slot-height) * 2)
      );
    background-size: var(--surface-size-cols, auto), auto;
  }

  /* round76（3.1a）：今天那一列微高光（≈6% 强调色混进页底，不抢内容） */
  .day.today .day-body {
    background-color: var(--today-tint);
  }

  /* round82（3.1c₂ · 淡-12）：夜间淡化带（非工作时段）。
     纯 CSS 一层：百分比定位（跟着 `--slot-height` 缩放走）、`pointer-events: none`（绝不吃手势）；
     **不加 z-index**：它是 `.day-body` 的第一个子元素 → 网格线（background）在最底，
     落点线 / 块（含动作浮层与选中环）/ 现在线都在它上面。
     颜色 = `--dim-band` 一个语义 token（亮 8% / 暗 20% 黑；3.2 主题包可覆盖）。 */
  .dim-band {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .dim-band span {
    position: absolute;
    right: 0;
    left: 0;
    background: var(--dim-band);
  }

  /* round76（3.1a）：现在线（你要的「现在线」：一条警示色横线 + 右端小牌） */
  .now-line {
    position: absolute;
    right: 0;
    left: 0;
    z-index: 3; /* 压在块上、但在吸顶日头（z-index 4）下面 */
    height: 2px;
    background: var(--now-line);
    pointer-events: none;
  }

  .now-line b {
    position: absolute;
    right: 0;
    bottom: 2px;
    padding: 0 var(--space-1);
    /* 小牌用**实心**警示底 + 白字（6b：这一对已验 ≥4.5）；线本身用文字档警示色（≥3） */
    color: var(--on-warn);
    background: var(--warn-solid);
    border-radius: var(--radius);
    font-size: var(--text-meta);
    font-weight: 400;
    line-height: var(--line-compact);
  }

  .box {
    position: absolute;
    padding: 0 2px;
  }

  /* round24：跨天块那两段的标记（「上接」/「续到次日 HH:MM」）—— 标在盒子外面 */
  .cont-mark {
    position: absolute;
    right: 2px;
    padding: 0 2px;
    background: var(--bg);
    border: 1px solid var(--muted);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-meta);
    line-height: var(--line-compact);
    white-space: nowrap;
    pointer-events: none;
  }

  .cont-mark.top {
    top: -11px;
  }

  .cont-mark.bottom {
    bottom: -11px;
  }

  /* C1.5：落点指示线（拖动中显示「会落在哪」） */
  .drop-line {
    position: absolute;
    right: 0;
    left: 0;
    height: 2px;
    margin-top: -1px;
    background: var(--accent);
    box-shadow: 0 0 4px var(--accent);
    pointer-events: none;
  }

  /* C1.7：手势对齐辅助线 —— 两条横线盖在列与块之上（与序列细线同一套：绝对定位 + 不挡鼠标） */
  .guides {
    position: absolute;
    inset: 0;
    z-index: 3;
    pointer-events: none;
  }

  .align-line {
    position: absolute;
    height: 1px;
    border-top: 1px dashed var(--text-primary);
    opacity: 0.7;
  }

  /* 刻度处的时间胶囊（在**刻度栏里面**，跟着吸左一起不跑）：宽度 = 刻度区宽度，右边缘正好接上线 */
  .align-label {
    position: absolute;
    left: 0;
    width: 100%;
    padding: 1px 0;
    transform: translateY(-50%);
    background: var(--accent);
    border-radius: var(--radius);
    color: var(--on-accent);
    font-family: var(--font-mono);
    font-size: var(--text-meta);
    line-height: var(--line-compact);
    text-align: center;
    pointer-events: none;
  }

  /* 「次日」单独一行 —— 44px 宽的胶囊里塞不下「次日 03:00」一行 */
  .align-label b {
    display: block;
    font-size: var(--text-meta);
    font-weight: 400;
    opacity: 0.85;
  }

  /* round24：终点线跨到次日时，那条线在**次日那一列**，旁边补一句「次日 HH:MM」
     round27：小牌改成 `.day-chip`（今天也会说「前一日 / +N 天」，不只次日） */
  .align-label.day-chip {
    left: auto;
    width: auto;
    padding: 0 var(--space-1);
    white-space: nowrap;
  }

  /* round77 收尾：窄窗（≤760px）把头部内容行压回两行（布局重审 L35 的尾巴）——
     周范围用 meta 字号、跳周组去掉左边距；1500 不受影响（媒体查询只在窄窗生效）。
     ⚠️ 放在样式块**末尾**：媒体查询不提高优先级，放前面会被后面的基础规则盖回去（实测踩过）。 */
  @media (max-width: 900px) {
    /* round78（3.1b₂ · 栈-06 顺手修）：窄窗（含伪语言 / 英文这种 +30% 文本）下，
       动作组**允许组内换行** —— 此前的「组内不换行」在伪语言 715 实测把头部顶出 73px
       （`r74①` / `r73p②` 红）。安全性同 round77：组内只有固定几个按钮、与选中态无关，
       换行状态不会在手势中途翻转（那才是当初要钉住的东西）。 */
    .head-actions {
      flex-wrap: wrap;
      justify-content: flex-end;
      row-gap: var(--space-1);
    }
  }

  @media (max-width: 760px) {
    .range {
      font-size: var(--text-meta);
    }

    .week-nav {
      margin-left: 0;
    }
  }

</style>
