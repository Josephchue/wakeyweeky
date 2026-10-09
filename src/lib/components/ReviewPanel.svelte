<script lang="ts">
  import { t } from "../i18n/i18n.svelte";
  import { focusTrap, scrollableRegion } from "../utils/modal";
  import Icon from "../icons/Icon.svelte";
  /**
   * C7（round52）：复盘面板 —— 结局马赛克 + 理智曲线 + 事实计数 + 当天明细 + 本周未完成。
   *
   * 形态（Q1 拍板）：**覆盖式面板 + 按钮触发**；`Esc` / `✕` / 点空白关闭；
   * 打开在**正在看的那一周**（面板里换周时自己去拉那一周）。
   *
   * 这里不重算任何规则：结局在 Rust `review.rs`、曲线在 Rust `sanity.rs`；
   * 本组件只把 store 里的数字画出来。
   */
  import { startOfDay } from "date-fns";
  import { untrack } from "svelte";

  import { openStats } from "../stores/stats.svelte";
  import type { MosaicBlock, SanityDay } from "../ipc/types";

  /** 事实图的两种计数（与 `SanityDay` 的字段名一一对应） */
  type FactKind = "rearranged" | "skipped";
  import { openDrift } from "../stores/drift.svelte";
  import { featureOn } from "../stores/settings.svelte";
  import {
    blocksOfDay,
    closeReview,
    defaultDay,
    ensureMosaic,
    loadMosaic,
    missedBlocks,
    mosaicCategories,
    mosaicDays,
    mosaicText,
    openReviewAt,
    pastWeekList,
    review,
    setBaseline,
    baselineLabel,
    stepBaseline,
    statesPresent,
    toggleExempt,
  } from "../stores/review.svelte";
  import { sanity } from "../stores/sanity.svelte";
  import { follow, selectBlock } from "../stores/selection.svelte";
  import { sequences } from "../stores/sequences.svelte";
  import { goToWeekOf, week } from "../stores/week.svelte";
  import { categoryLabel } from "../utils/category";
  import { formatClockRange, formatDayHead, formatDuration, formatShortDate, formatWeekRange, getWeekDays, shiftWeek, weekdayShort, weekOf } from "../utils/week";
  import {
    completionRate,
    countStates,
    formatRate,
    formatSequence,
    formatWeekShort,
    sequenceProgress,
    type WeekCounts,
  } from "../utils/weekcard";
  import Mosaic from "./Mosaic.svelte";

  const dayLabel = (dayStart: number) => formatDayHead(new Date(dayStart * 1000));

  /** 状态视图的行；类别视图把行头换成分类（顺序 = `utils/category.ts` 的口径）
   *  round69（B3）：类别视图用**两周并集**分组 —— 只在基线周出现的类别也有自己的一行
   *  round69.1（#5）：`catOrder` 只取并集的**类别名顺序**；**两侧的方块各用各的一周数据** ——
   *  跨周块（周日 23:00 → 周一 05:00）在两周的返回里各出现一次，并集后同一 id 出现两次
   *  → `{#each (b.id)}` 抛 `each_key_duplicate`、整个更新流产（切换看着像失灵）。 */
  const catOrder = $derived(
    mosaicCategories([...(review.week ?? []), ...(review.lastWeek ?? [])]).map((g) => g.name),
  );
  const curCatBlocks = $derived(
    new Map(mosaicCategories(review.week).map((g) => [g.name, g.blocks])),
  );
  const prevCatBlocks = $derived(
    new Map(mosaicCategories(review.lastWeek).map((g) => [g.name, g.blocks])),
  );
  const rows = $derived.by(() =>
    review.mode === "state"
      ? mosaicDays().map((r) => ({
          key: `d${r.day_start}`,
          label: dayLabel(r.day_start),
          day_start: r.day_start,
          blocks: r.blocks,
        }))
      : catOrder.map((name) => ({
          key: `c${name ?? "__uncat__"}`,
          label: `${categoryLabel(name)} (${(curCatBlocks.get(name) ?? []).length})`,
          day_start: null,
          blocks: curCatBlocks.get(name) ?? [],
        })),
  );

  /** 上周那一排（只画方块行，不带明细）—— **按上周自己的天分组**（不是本周的）
   *  round54（9.2）：`day_start` 不再抹成 null —— 并排对比要拿它和本周的那一行**对齐**（同一把尺） */
  const lastRows = $derived.by(() =>
    mosaicDays(review.lastWeek ?? [], shiftWeek(week.from, -1)).map((r) => ({
      key: `l${r.day_start}`,
      label: dayLabel(r.day_start),
      day_start: r.day_start,
      blocks: r.blocks,
    })),
  );

  /** round69（B3）：类别视图的基线行 —— 配对靠**类别 key**（两周的类别次序本来就可能不同），
   *  round69.1（#5）：基线侧用**基线那一周自己的**分组（跨周块两边各算各的那一段）。 */
  const prevCatRows = $derived.by(() =>
    catOrder.map((name) => ({
      key: `c${name ?? "__uncat__"}`,
      label: categoryLabel(name),
      day_start: null,
      blocks: prevCatBlocks.get(name) ?? [],
    })),
  );

  /**
   * round69（B3）：**类别投入**（旧「v1.5」项，调研 §7.2 指标 4 转正）。
   * 口径：只算**已完成**（含超时 / 提前）的时长；两侧取并集、本周时长降序、「未分类」永远最后。
   */
  const DONE_STATES = new Set(["done", "done_overtime", "done_short"]);
  const categoryInvest = $derived.by(() => {
    // 6b P2：跨周块按**本周那一段**计（与同屏「占用」的切分口径一致；不然一块会被两周各算一遍）
    const sum = (list: MosaicBlock[], weekStart: number) => {
      const weekEnd = shiftWeek(weekStart, 1);
      const map = new Map<string | null, number>();
      for (const b of list) {
        if (!DONE_STATES.has(b.mosaic_state)) continue;
        const start = Math.max(b.start_at, weekStart);
        const end = Math.min(b.end_at, weekEnd);
        if (end <= start) continue;
        map.set(b.category, (map.get(b.category) ?? 0) + Math.round((end - start) / 60));
      }
      return map;
    };
    const cur = sum(review.week ?? [], week.from);
    const prev = sum(review.lastWeek ?? [], shiftWeek(week.from, -review.baselineWeeks));
    return [...new Set([...cur.keys(), ...prev.keys()])]
      .map((name) => {
        const c = cur.get(name) ?? 0;
        const p = prev.get(name) ?? 0;
        const d = delta(c - p);
        return { name, cur: c, prev: p, deltaText: d.text, deltaDir: d.dir };
      })
      .sort((a, b) => {
        if (a.name === null && b.name !== null) return 1; // 未分类最后（全仓口径）
        if (b.name === null && a.name !== null) return -1;
        return (
          b.cur - a.cur ||
          b.prev - a.prev ||
          (a.name ?? "").localeCompare(b.name ?? "", "zh")
        );
      });
  });

  const today = $derived(review.day ?? defaultDay());
  /** 今天的本地零点（给状态视图的那一行加「今天」标；与本周的七天对比） */
  const todayStart = $derived(Math.floor(startOfDay(new Date()).getTime() / 1000));
  const isToday = $derived(review.day === todayStart);
  const detail = $derived(blocksOfDay(today));
  const missed = $derived(missedBlocks());
  const days = $derived(sanity.week?.days ?? []);
  const budget = $derived(sanity.budgetMinutes || 360);

  /* ——— round54（9.2）「同一把尺」需要的那几份派生数据 ——— */

  /** 上周的曲线（「对比：上周」开着才有）—— 占用与事实两项都要两周各一份 */
  const prevDays = $derived(review.lastEnergy?.days ?? []);
  /** 上周某一天的量：**按行序**取（周一…周日同序）—— 并排对齐的是「周一」这个位置，
   *  两周的日期本来就不同（按 `day_start` 查实测全落空 → 上周柱全是 0） */
  const prevMinutesAt = (i: number) => prevDays[i]?.minutes ?? 0;
  /** 对比真的成立吗（选了基线 **且** 那一周的数据到齐了） */
  const comparing = $derived(review.baselineWeeks > 0 && review.lastEnergy !== null);
  /** 基线的说法：1/2 → 上周 / 上上周；再往前 → 「MM-dd 那周」（相对词到那儿就不好读了）—— 面板文案都用它 */
  const base = $derived.by(() => {
    const weeks = review.baselineWeeks;
    if (weeks <= 2) return baselineLabel(weeks);
    const days = getWeekDays(shiftWeek(week.from, -weeks));
    return t("ui.review_panel.08", { dd: formatShortDate(days[0]) });
  });
  /** 两周**共用**的事实刻度（各画各的比例 = 那两张独立小图的老毛病 —— 必须同刻度） */
  const maxFact = $derived(
    Math.max(1, ...[...days, ...prevDays].map((d) => Math.max(d.rearranged, d.skipped))),
  );
  /**
   * round69.1（#11）：占用柱的刻度 = max(预算, 两周里最高的那一天)。
   * 旧写法把柱子钉死在「预算 = 100%」上（`Math.min(100, …)`）→ 两边都超预算时**双双顶格**，
   * 差 6 小时也看不出区别（你验收实测）。预算虚线跟着刻度画（不再是固定贴顶）。
   */
  const barScale = $derived(
    Math.max(1, budget, ...[...days, ...prevDays].map((d) => d.minutes)),
  );
  /** 占用总量（分钟；摘要行用） */
  const totals = $derived.by(() => ({
    cur: days.reduce((s, d) => s + d.minutes, 0),
    prev: prevDays.reduce((s, d) => s + d.minutes, 0),
  }));

  /** 结局计数（**事实**，不做百分比、不打分）—— 口径在 `utils/weekcard.ts`（纯函数 + 单测），这里只负责摆出来 */
  const counts = $derived.by(() => ({
    cur: countStates(review.week ?? []),
    prev: countStates(review.lastWeek ?? []),
  }));
  const countsText = (c: WeekCounts) =>
    t("ui.review_panel.09", { done: c.done, missed: c.missed, unused: c.unused, planned: c.planned });
  /** 完成率（分母 = **已到点**的块；还没有到点的周 → 「—」，不编 0%/100%） */
  const rate = $derived(completionRate(counts.cur));
  /** 序列完成情况：只看**这一周里有成员**的序列（跨周成员不算 —— 与卡片同一口径） */
  const seqRows = $derived(sequenceProgress(review.week ?? [], sequences));
  /** 往期：最近 12 周（锚点是今天那一周）—— 点一下跳过去 */
  const history = $derived(pastWeekList());

  /** 差值徽标里的紧凑数字：`1h30` / `30m` */
  const num = (minutes: number) => {
    const h = Math.floor(Math.abs(minutes) / 60);
    const m = Math.abs(minutes) % 60;
    return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
  };
  /** 事实图的差值徽标：**单位是「次」，不是分钟** —— 直接复用 `delta()` 会印出 `▲1m`（那是我 round54 的错），
   *  round55 你验收时一眼抓到（「m/ 是什么？」） */
  function deltaCount(n: number) {
    if (n > 0) return { text: `▲${n}`, dir: "up" };
    if (n < 0) return { text: `▼${Math.abs(n)}`, dir: "down" };
    return { text: t("ui.review_panel.10"), dir: "same" };
  }

  /** 差值徽标：**箭头 + 颜色 + 文字**三重冗余（microcharts《Delta》；不能只靠颜色） */
  function delta(minutes: number) {
    if (minutes > 0) return { text: `▲${num(minutes)}`, dir: "up" };
    if (minutes < 0) return { text: `▼${num(minutes)}`, dir: "down" };
    return { text: t("ui.review_panel.11"), dir: "same" };
  }
  /** 占用总量的差值（摘要行用） */
  const totalDelta = $derived(delta(totals.cur - totals.prev));
  /** 周几的一个字（柱下刻度；日头那边本来就有完整写法） */
  const tickOf = (dayStart: number) => weekdayShort(new Date(dayStart * 1000));
  /** 事实计数：某一天某个 kind 的值 / 一整周的和 / 换算成条高% */
  const factName = (kind: FactKind) => (kind === "rearranged" ? t("ui.review_panel.12") : t("ui.review_panel.13"));
  /** 上周同一天的事实计数（按行序取） */
  const prevFactOf = (i: number, kind: FactKind) => {
    const p = prevDays[i];
    return p ? (kind === "rearranged" ? p.rearranged : p.skipped) : 0;
  };
  const factOf = (d: SanityDay, kind: FactKind) => (kind === "rearranged" ? d.rearranged : d.skipped);
  const factTotal = (kind: FactKind, list: SanityDay[]) =>
    list.reduce((s, d) => s + factOf(d, kind), 0);
  const pct = (v: number, max: number) => Math.round((v / max) * 100);

  /* 悬停文字：**两个值都写进 title**（两个值 + 差值同时摆出来的文字版；
     注意 Svelte 不允许在属性值里写 `{#if}` → 这些必须提前算成字符串） */
  const budgetText = $derived(formatDuration(budget * 60));
  const barTitle = (d: SanityDay, i: number) =>
    t("ui.review_panel.14", { minutes: formatDuration(d.minutes * 60), budgetText: budgetText, blocks: d.blocks }) +
    (comparing ? t("ui.review_panel.15", { base: base, i: formatDuration(prevMinutesAt(i) * 60) }) : "");
  const pbarTitle = (i: number) =>
    t("ui.review_panel.16", { base: base, i: formatDuration(prevMinutesAt(i) * 60), budgetText: budgetText });
  const factTitle = (d: SanityDay, i: number, kind: FactKind) =>
    t("ui.review_panel.17", { kind: factName(kind), count: factOf(d, kind) }) +
    (comparing ? t("ui.review_panel.18", { base: base, kind: prevFactOf(i, kind) }) : "");
  const pfactTitle = (i: number, kind: FactKind) => t("ui.review_panel.19", { base: base, kind: factName(kind), count: prevFactOf(i, kind) });

  /** 打开面板后（或换周后）保证数据是这一周的 */
  $effect(() => {
    const open = review.open;
    const from = week.from;
    if (!open) return;
    // ⚠️ 必须 `untrack`：`ensureMosaic()` 既读又写 store（`review.day` / 拉那一周），
    // 直接在 effect 里调会让 Svelte 报 `state_unsafe_mutation` 并**中断整个更新**（面板看着像卡死 —— 实测抓到）
    untrack(() => {
      void from;
      ensureMosaic();
    });
  });

  /**
   * round53（验收回修）：**数据变了就重拉**这一份。
   * 任何写操作最后都会走 `reloadWeek()` → 重新拉曲线 → `sanity.week` 换一个新对象；
   * 拿它当「有东西变了」的信号（不用在两边互相 import —— 会成环）。
   * 打开那一下由 `openReview()` 自己拉，这里只负责**开着面板的时候**的变化。
   */
  let lastSanity: unknown = null;
  $effect(() => {
    const wk = sanity.week;
    const open = review.open;
    if (!open) {
      lastSanity = null;
      return;
    }
    if (lastSanity === null) {
      lastSanity = wk;
      return;
    }
    if (wk === lastSanity) return;
    lastSanity = wk;
    untrack(() => void loadMosaic());
  });

  // round78（栈-01/栈-02）：`Esc` 与「关自己」统一收进面板栈（`Timeline` 的全局处理器 → `closeTopPanel()`），
  // 这里不再各自监听 —— 以前 7 处各听各的，一次 Esc 会把叠着的面板**全关**（round72 L2）。

  /** 明细点一条：关面板 → 翻到那一周（如果不在）→ 选中它 → 滚进视野 */
  function jumpTo(b: MosaicBlock) {
    closeReview();
    if (weekOf(b.start_at).from !== week.from) goToWeekOf(b.start_at);
    selectBlock(b.id); // round61：走统一入口（锚点与 ids 一起维护，多选态也收口成单选）
    follow.at = b.start_at;
    follow.seq += 1;
  }

  /** 「未完成」里点 ↻：关面板 + 就地弹那块的漂流卡（与块上的 ↻ 同一条路） */
  function reschedule(b: MosaicBlock) {
    closeReview();
    openDrift(b.id);
  }

  async function toggle(b: MosaicBlock, e: MouseEvent) {
    e.stopPropagation();
    await toggleExempt(b);
  }

  const nameOf = (b: MosaicBlock) => b.label ?? b.title;
</script>

{#if review.open}
  <!-- round77 收尾：遮罩**不进 Tab 顺序**（它只是「点一下关面板」的鼠标快捷键；键盘用面板的 ✕ / Esc） -->
  <button
    class="overlay-backdrop"
    type="button"
    tabindex="-1"
    aria-label={t("ui.review_panel.20")}
    onclick={closeReview}
  ></button>
  <!-- round78（栈-03/栈-04）：统一覆盖层外壳（固定左缘 + 宽档 780）+ 模态契约（焦点陷阱 / aria-modal） -->
<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role（`section role="dialog"` 是 ARIA 认可写法，Svelte 的检查器偏严） -->
  <section
    class="overlay-panel wide review-panel"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    aria-label={t("ui.review_panel.21")}
    use:focusTrap={{ active: review.open }}
    use:scrollableRegion={{ label: t("ui.review_panel.20") }}
  >
    <header class="panel-head">
      <h2 class="range">{formatWeekRange(week.from)}</h2>
      <div class="mode" role="group" aria-label={t("ui.review_panel.22")}>
        <button
          type="button"
          data-mode="state"
          aria-pressed={review.mode === "state"}
          onclick={() => (review.mode = "state")}>{t("ui.review_panel.71")}</button>
        <button
          type="button"
          data-mode="category"
          aria-pressed={review.mode === "category"}
          onclick={() => (review.mode = "category")}>{t("ui.review_panel.72")}</button>
      </div>
      <!-- round54（9.2）：对比得是**显式的 A vs B**（PostHog #69677 那套）；
           round63（C18）：裸开关 → 基线选择器；**round63.1（你拍板）**：预设下拉 → ‹ › 逐周步进，
           可以一直点到任意早的一周（最小「上周」；关掉走「关闭」） -->
      <div
        class="compare-label"
        title={t("ui.review_panel.23")}
      >
        {#if review.baselineWeeks > 0}
          <span class="sub">{t("ui.review_panel.24")}</span>
          <button
            type="button"
            class="mini compare-prev"
            title={t("ui.review_panel.25")}
            onclick={() => stepBaseline(1)}><Icon name="chevron-left" size={16} /></button
          >
          <span
            class="baseline-name"
            data-baseline={review.baselineWeeks}
            title={formatWeekRange(shiftWeek(week.from, -review.baselineWeeks))}>{base}</span
          >
          <button
            type="button"
            class="mini compare-next"
            title={t("ui.review_panel.26")}
            disabled={review.baselineWeeks <= 1}
            onclick={() => stepBaseline(-1)}><Icon name="chevron-right" size={16} /></button
          >
          <button
            type="button"
            class="mini compare-off"
            title={t("ui.review_panel.27")}
            onclick={() => setBaseline(0)}>{t("ui.review_panel.73")}</button
          >
        {:else}
          <button
            type="button"
            class="mini compare-on"
            title={t("ui.review_panel.28")}
            onclick={() => setBaseline(1)}>{t("ui.review_panel.74")}</button
          >
        {/if}
      </div>
      {#if featureOn("stats_enabled")}
        <!-- round82（11.5 · 案 1）：统计入口 —— 只在**总览开着且统计开关也开**时出现（四象限表）；
             开了就是总览的**子层**（`asChild: true`）。总览没开时的独立入口在时间轴顶栏。 -->
        <button
          class="stats-open"
          type="button"
          title={t("ui.timeline.42")}
          onclick={() => void openStats({ asChild: true })}><Icon name="chart-column" size={16} />{t(
            "ui.timeline.52",
          )}</button
        >
      {/if}
      <button class="close" type="button" title={t("ui.review_panel.29")} onclick={closeReview}><Icon name="close" size={16} /></button>
    </header>

    <div class="body">
      <!-- round58（0.13.1）：摘要块**常驻** —— 结局 + 完成率永远看得到；
           选了基线再添一行占用（round54 的「同一把尺」口径一字不动）。
           round54（9.2）的理由照旧：两个值 + 差值同时摆出来（Perceptual Edge《Displaying Change
           Between Two Points in Time》）；结局只报计数，完成率分母 = **已到点的块**（`utils/weekcard.ts` 有单测）。 -->
      <section class="summary" aria-label={t("ui.review_panel.30")}>
        {#if comparing}
          <p class="line">
            <span class="k">{t("ui.review_panel.31")}</span>
            <span class="v">
              {t("ui.review_panel.32", { cur: formatDuration(totals.cur * 60) })}<span class="muted">{t("ui.review_panel.33", { budget: formatDuration(
                  budget * 60,
                ) })}</span>
            </span>
            <span class="v prev">{base} {formatDuration(totals.prev * 60)}</span>
            <span
              class="delta {totalDelta.dir}"
              data-delta-minutes={totals.cur - totals.prev}
              title={t("ui.review_panel.34", { base: base, text: totalDelta.text })}>{totalDelta.text}</span
            >
          </p>
        {/if}
        <p class="line">
          <span class="k">{t("ui.review_panel.35")}</span>
          <span class="v" data-counts>{countsText(counts.cur)}</span>
          <span class="rate" title={t("ui.review_panel.36")} data-rate
            >{t("ui.review_panel.37", { rate: formatRate(rate) })}</span
          >
          {#if comparing}<span class="v prev">{base} {countsText(counts.prev)}</span>{/if}
        </p>
        <p class="line seq" data-sequences>
          <span class="k">{t("ui.review_panel.38")}</span>
          {#if seqRows.length === 0}
            <span class="muted">{t("ui.review_panel.39")}</span>
          {:else}
            {#each seqRows as s (s.id)}<span class="chip-seq">{formatSequence(s)}</span>{/each}
          {/if}
        </p>
      </section>

      {#if review.week === null}
        {#if review.failed}
          <!-- round78（3.1b₂ · 栈-10）：失败态要有「重试」（不再永远卡在「正在读…」） -->
          <p class="empty">
            {t("ui.review_panel.80")}
            <button type="button" class="retry" onclick={() => void loadMosaic()}>{t("ui.common.01")}</button>
          </p>
        {:else}
          <p class="empty">{t("ui.review_panel.40")}</p>
        {/if}
      {:else if review.week.length === 0}
        <p class="empty">{t("ui.review_panel.41")}</p>
      {:else}
        <Mosaic
          rows={rows}
          prevRows={comparing ? (review.mode === "state" ? lastRows : prevCatRows) : null}
          pairing={review.mode === "category" ? "key" : "index"}
          activeDay={review.day}
          onPickDay={(d) => (review.day = d)}
          states={statesPresent()}
        />
      {/if}

      {#if days.length > 0}
        <!-- round55（验收回修）：两张图共用**同一条天列网格** —— 给它们一个共同的左侧栏（`--row-gutter`），
             否则事实图的柱子比占用图整体偏一个标签宽（实测偏 146px），「哪个条是哪天」只能猜 -->
        <div class="charts" class:comparing>
        <!-- round54（9.2）：两周**共用同一刻度与预算线**（ONS《Small multiple charts》：
             「Make sure that each panel … uses the same scale」）—— 上面那根虚线 = 预算，
             两组柱都从同一基线长出来，矮的那个一眼就是少 -->
        <section class="curve" aria-label={t("ui.review_panel.42")}>
          <h3 class="head">
            {t("ui.review_panel.43")}{#if comparing}<span class="sub">{t("ui.review_panel.44", { base: base })}</span>{/if}
          </h3>
          <div class="plot">
            {#each days as d, i (d.day_start)}
              <div class="col">
                <span class="pair">
                  {#if comparing}
                    <span
                      class="pbar"
                      data-prev-minutes={prevMinutesAt(i)}
                      style="--pct: {pct(prevMinutesAt(i), barScale)}%"
                      title={pbarTitle(i)}
                    ></span>
                  {/if}
                  <span
                    class="bar {d.state}"
                    data-minutes={d.minutes}
                    style="--pct: {pct(d.minutes, barScale)}%"
                    title={t("ui.review_panel.45", { day_start: dayLabel(d.day_start), i: barTitle(d, i) })}
                  ></span>
                </span>
              </div>
            {/each}
            <span
              class="budget-line"
              aria-hidden="true"
              style="bottom: {pct(budget, barScale)}%"
              title={t("ui.review_panel.46", { budgetText: budgetText })}
            ></span>
          </div>
          <!-- 柱下的标签单独一行：这样预算线才能画在**柱区的顶端**（= 100%）-->
          <div class="under">
            {#each days as d, i (d.day_start)}
              <div class="cell">
                {#if comparing}
                  {@const dl = delta(d.minutes - prevMinutesAt(i))}
                  <span
                    class="delta {dl.dir}"
                    data-day-delta={d.minutes - prevMinutesAt(i)}
                    title={t("ui.review_panel.47", { base: base, text: dl.text })}>{dl.text}</span
                  >
                {/if}
                <span class="tick">{tickOf(d.day_start)}</span>
              </div>
            {/each}
          </div>
        </section>

        <section class="facts" aria-label={t("ui.review_panel.48")}>
          {#each (["rearranged", "skipped"] as FactKind[]) as kind (kind)}
            {@const label = factName(kind)}
            {@const cur = factTotal(kind, days)}
            {@const prev = factTotal(kind, prevDays)}
            {@const dl = deltaCount(cur - prev)}
            <div class="fact">
              <!-- round56（你 2026-10-04 验收）：标签**挪到行的上方当小标题** —— 三张图都占满全宽、
                   谁也不给谁让位（旧写法给这两行留左栏 → 占用图被挤窄，你说「左边空着表变小」） -->
              <p class="cap">
                {label} {cur}{#if comparing}{' '}<span class="delta {dl.dir}" data-total-delta={cur - prev}
                    >{dl.text}</span
                  >{' '}<span class="muted">/ {base} {prev}</span>{/if}
              </p>
              <div class="row" data-kind={kind}>
                {#each days as d, i (d.day_start)}
                  <span class="cell">
                    <span class="pair">
                      {#if comparing}
                        <span
                          class="pbar"
                          data-prev-count={prevFactOf(i, kind)}
                          style="--pct: {pct(prevFactOf(i, kind), maxFact)}%"
                          title={t("ui.review_panel.49", { day_start: dayLabel(d.day_start), kind: pfactTitle(i, kind) })}
                        ></span>
                      {/if}
                      <span
                        class="bar"
                        data-count={factOf(d, kind)}
                        style="--pct: {pct(factOf(d, kind), maxFact)}%"
                        title={t("ui.review_panel.50", { day_start: dayLabel(d.day_start), kind: factTitle(d, i, kind) })}
                      ></span>
                    </span>
                  </span>
                {/each}
              </div>
            </div>
          {/each}
        </section>
        </div>
      {/if}

      {#if comparing && categoryInvest.length > 0}
        <!-- round69（B3）：类别投入（只算已完成；两侧并集、本周降序、未分类最后）
             —— 差值徽标沿用「箭头 + 颜色 + 文字」三重冗余 -->
        <section class="cats" aria-label={t("ui.review_panel.51")}>
          <h3 class="head">{t("ui.review_panel.52")}<span class="sub">{t("ui.review_panel.53", { base: base })}</span></h3>
          <div class="cat-rows">
            {#each categoryInvest as row (row.name ?? "__uncat__")}
              <div class="cat-row" data-category={row.name ?? ""}>
                <span class="cat-name">{categoryLabel(row.name)}</span>
                <span class="cat-val" data-cur-minutes={row.cur} title={t("ui.review_panel.54", { cur: formatDuration(row.cur * 60) })}
                  >{formatDuration(row.cur * 60)}</span
                >
                <span
                  class="cat-val prev"
                  data-prev-minutes={row.prev}
                  title={t("ui.review_panel.55", { base: base, prev: formatDuration(row.prev * 60) })}
                  >{formatDuration(row.prev * 60)}</span
                >
                <span
                  class="delta {row.deltaDir}"
                  data-delta-minutes={row.cur - row.prev}
                  title={t("ui.review_panel.56", { base: base, deltaText: row.deltaText })}>{row.deltaText}</span
                >
              </div>
            {/each}
          </div>
        </section>
      {/if}

      {#if review.mode === "state"}
        <!-- round69.1（#10）：天明细是**周视图的配套**（点某一天看那天的块）——
             按类别里没有「选中的那一天」这回事，不再显示（你验收截图里就是它多余） -->
        <section class="detail" aria-label={t("ui.review_panel.57")}>
        <h3 class="head">
          {t("ui.review_panel.58", { today: dayLabel(today) })}{#if isToday}<span class="today-note">{t("ui.review_panel.59")}</span>{/if}
        </h3>
        {#if detail.length === 0}
          <p class="empty">{t("ui.review_panel.60")}</p>
        {:else}
          {#each detail as b (b.id)}
            <div
              class="detail-row"
              data-block-id={b.id}
              role="button"
              tabindex="0"
              onclick={() => jumpTo(b)}
              onkeydown={(e) => (e.key === "Enter" || e.key === " ") && jumpTo(b)}
            >
              <span class="time">{formatClockRange(b.start_at, b.end_at)}</span>
              <span class="name" class:temp={b.is_temp}>{nameOf(b)}</span>
              <span class="state" data-state={b.mosaic_state}>{mosaicText(b.mosaic_state)}</span>
              {#if b.rearranged > 0}<span class="fact">{t("ui.review_panel.61", { rearranged: b.rearranged })}</span>{/if}
              {#if b.skipped}<span class="fact">{t("ui.review_panel.62")}</span>{/if}
              <button
                class="exempt-toggle"
                class:off={b.exempt}
                type="button"
                title={b.exempt ? t("ui.review_panel.63") : t("ui.review_panel.64")}
                onclick={(e) => void toggle(b, e)}><Icon name="ban" size={16} /></button>
            </div>
          {/each}
        {/if}
        </section>
      {/if}

      {#if missed.length > 0}
        <section class="missed" aria-label={t("ui.review_panel.65")}>
          <h3 class="head">{t("ui.review_panel.66", { length: missed.length })}</h3>
          <ul>
            {#each missed as b (b.id)}
              <li data-block-id={b.id}>
                <span class="when">{dayLabel(b.day_start)}</span>
                <span class="name">{nameOf(b)}</span>
                {#if featureOn("drift_enabled")}
                  <!-- round64.1（验收 #1）：漂流开关关掉 → 总览里的 ↻ 也一并收掉 -->
                  <button
                    class="reschedule"
                    type="button"
                    data-block-id={b.id}
                    title={t("ui.review_panel.67")}
                    onclick={() => reschedule(b)}><Icon name="rotate-cw" size={16} /></button
                  >
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      <!-- round58（0.13.1）：往期 —— 一排周 chip（最近 12 周，锚点是今天那一周），点一下跳过去 -->
      <section class="history" aria-label={t("ui.review_panel.68")}>
        <span class="k">{t("ui.review_panel.69")}</span>
        {#each history as w (w)}
          <button
            class="chip"
            class:active={w === week.from}
            type="button"
            data-week={w}
            title={t("ui.review_panel.70")}
            onclick={() => openReviewAt(w)}
          >
            {formatWeekShort(w)}
          </button>
        {/each}
      </section>
    </div>
  </section>
{/if}

<style>
  .review-panel {
    /* round52（初稿）：居中卡片 —— 不拉满整窗，内容多宽就多宽（视觉细节归观感环节） */
    display: flex;
    flex-direction: column;
    overflow: auto;
    background: var(--card);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius-lg); /* round77：面板/浮层走圆角阶梯的 lg（Fluent：浮层 8px） */
    box-shadow: var(--shadow-menu);
  }

  .panel-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--grid-line);
  }

  .range {
    margin: 0;
    font-size: var(--text-title);
  }

  .mode {
    display: flex;
    gap: 2px;
    margin-left: auto;
  }

  .mode button {
    padding: 2px var(--space-2);
    border: 1px solid var(--grid-line);
    background: none;
    color: var(--text-secondary);
    font-size: var(--text-body);
    cursor: pointer;
  }

  .mode button[aria-pressed="true"] {
    border-color: var(--accent);
    color: var(--text-primary);
    font-weight: 600;
  }

  .compare-label {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--text-secondary);
    font-size: var(--text-body);
  }

  /* round63.1：‹ › 逐周步进（任意周）+ 基线名 + 关闭 */
  .compare-label .mini {
    padding: 0 var(--space-1);
    background: none;
    border: 1px solid var(--grid-line);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-meta);
    line-height: var(--line-body);
    cursor: pointer;
  }

  .compare-label .mini:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }

  .compare-label .mini:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .compare-label .baseline-name {
    color: var(--text-primary);
    white-space: nowrap;
  }

  .close {
    padding: 2px var(--space-2);
    border: 1px solid var(--grid-line);
    background: none;
    color: var(--text-secondary);
    font-size: var(--text-body);
    cursor: pointer;
  }

  /*
   * round82（11.5 · 案 1）：**统计入口搬进总览顶栏**（你 2026-10-06：「统计可以放进总览里面，我觉得放顶栏」）。
   * 位置 = 标题行最右、关闭按钮旁（读作「面板级动作」，不与「本周 / 对比」混读）；
   * 它把统计当成**总览的子层**开（`openStats({ asChild: true })`：不关总览、`Esc` 只关统计、
   * 总览关掉时统计跟着关）。总览关着时的独立入口在时间轴顶栏（`Timeline.svelte` 的 `.stats-open`）。
   */
  .stats-open {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    margin-left: auto;
    padding: 2px var(--space-2);
    border: 1px solid var(--grid-line);
    border-radius: var(--radius);
    background: none;
    color: var(--text-secondary);
    font-size: var(--text-body);
    cursor: pointer;
  }

  .stats-open:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4);
  }

  .body .head {
    margin: 0 0 var(--space-2);
    color: var(--text-secondary);
    font-size: var(--text-label);
    font-weight: 400;
  }

  /* 明细标题里那个「今天」——round56：不再用徽标（你说“标去掉吧，挡东西了”），改成文字注明 */
  .body .head .today-note {
    margin-left: var(--space-1);
    color: var(--text-secondary);
    font-size: var(--text-meta);
  }

  /* round78（3.1b₂ · 栈-10）：失败态的「重试」小按钮 */
  .retry {
    padding: 0 var(--space-2);
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-body);
    line-height: var(--control-height);
    cursor: pointer;
  }

  .retry:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .empty {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-body);
  }

  /* —— round54（9.2）对比摘要：两个值 + 差值摆在同一行（Perceptual Edge）—— */
  .summary {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2) var(--space-3);
    background: var(--block-fill-missed);
    border-radius: var(--radius);
  }

  .summary .line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-body);
  }

  .summary .k {
    flex: none;
    width: 30px;
    color: var(--text-secondary);
  }

  .summary .v {
    color: var(--text-primary);
  }

  .summary .v.prev {
    color: var(--text-secondary);
  }

  /* round58：完成率常驻（事实比值，不上色、不评价 —— 与「只摆事实、不打分」同一口径） */
  .summary .rate {
    margin-left: auto;
    font-weight: 600;
    white-space: nowrap;
  }

  /* round58：序列完成情况 —— 一行小 chip（与卡片同一套） */
  .chip-seq {
    padding: 1px var(--space-1);
    background: var(--block-fill-missed);
    border-radius: var(--radius);
    font-size: var(--text-body);
  }

  /* round58：往期 = 最近 12 周的一排 chip（点一下跳到那一周） */
  .history {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1);
    padding-top: var(--space-2);
    border-top: 1px solid var(--grid-line);
  }

  .history .k {
    margin-right: var(--space-1);
  }

  .chip {
    padding: 1px var(--space-1);
    border: 1px solid transparent;
    background: none;
    color: var(--text-secondary);
    font-size: var(--text-meta);
    cursor: pointer;
  }

  .chip:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .chip.active {
    border-color: var(--accent);
    color: var(--accent);
  }

  .muted {
    color: var(--text-secondary);
  }

  /* 差值徽标：箭头 + 颜色 + 文字（三重冗余 —— 颜色不是唯一通道；microcharts《Delta》） */
  .delta {
    font-size: var(--text-meta);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .delta.up {
    color: var(--warn);
  }

  .delta.down {
    color: var(--block-fill-done);
  }

  .delta.same {
    color: var(--text-secondary);
  }

  .body .head .sub {
    margin-left: var(--space-1);
    font-size: var(--text-meta);
  }

  /* —— round56（你 2026-10-04 验收）：**三张图同一条网格、个个占满全宽** ——
     不再给哪一张留“空着的左栏”（那样只会把占用图挤窄）；事实两行的标签改成**行上方的小标题**。 */
  .charts {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  /* —— round69（B3）：类别投入（只算已完成）—— 一行一类：名字 / 本周 / 基线 / 差值 —— */
  .cats .cat-rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: var(--space-1);
  }

  .cat-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 64px 64px 64px;
    align-items: center;
    gap: var(--space-1);
    flex: none;
    min-height: var(--row-height);
    font-size: var(--text-body);
  }

  .cat-row .cat-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cat-row .cat-val {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .cat-row .cat-val.prev {
    color: var(--text-secondary);
  }

  .cat-row .delta {
    justify-self: end;
  }

  /* —— 曲线：7 根柱 + 预算线（预算线画在 100% 处）—— */
  /* round54（9.2）：柱区（`.plot`）与标签行（`.under`）拆开 —— 只有柱区有高度，
     预算线才能画在柱区顶端（= 100%）；两组柱（上周/本周）共用同一个 `--pct` 基准。 */
  .curve .plot {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
    height: 64px;
    /* 基线：柱子从哪儿长出来一眼看得见（与事实行同一套） */
    border-bottom: 1px solid var(--grid-line);
  }

  .curve .plot .col {
    display: flex;
    flex: 1;
    align-items: flex-end;
    height: 100%;
    min-width: 0;
  }

  .curve .pair {
    display: flex;
    flex: 1;
    align-items: flex-end;
    justify-content: center;
    gap: 2px;
    width: 100%;
    height: 100%;
  }

  .curve .bar,
  .curve .pbar {
    width: 40%;
    max-width: 18px;
    height: var(--pct);
    min-height: 1px;
    border-radius: var(--radius) var(--radius) 0 0;
  }

  .curve .bar {
    background: var(--block-fill-done);
  }

  /* 上周那一根：降一档对比度（位置/高度照旧可读 —— 淡化不是「隐藏」） */
  .curve .pbar {
    background: var(--muted);
    opacity: 0.55;
  }

  .curve .bar.over {
    background: var(--warn);
  }

  .curve .bar.near {
    background: var(--accent);
  }

  .curve .under {
    display: flex;
    gap: var(--space-2);
    margin-top: 2px;
  }

  .curve .under .cell {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    min-width: 0;
  }

  .curve .tick {
    color: var(--text-secondary);
    font-size: var(--text-meta);
  }

  .budget-line {
    position: absolute;
    left: 0;
    right: 0;
    /* round69.1（#11）：跟着刻度走（`bottom: 预算/刻度`）——旧写法固定 `top: 0`，
       两周都超预算时两根柱子都顶格、看不出差 */
    border-top: 1px dashed var(--warn);
  }

  /* —— 事实：两行小柱（与曲线共用天轴；不叠在分钟轴上 —— 双轴会误导）——
     round56：标签是**行上方的小标题**（不再占横向格子 → 与占用图同宽） */
  .facts {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .facts .cap {
    margin: 0 0 2px;
    color: var(--text-secondary);
    font-size: var(--text-label);
    white-space: nowrap;
  }

  .facts .row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
    height: 26px;
    /* 基线：全 0 的那几天也能看出这是一排柱（不然只剩一排空气） */
    border-bottom: 1px solid var(--grid-line);
  }

  .facts .cell {
    display: flex;
    flex: 1;
    align-items: flex-end;
    justify-content: center;
    height: 100%;
    min-width: 0;
  }

  .facts .cell .pair {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 2px;
    width: 100%;
    height: 100%;
  }

  .facts .bar,
  .facts .pbar {
    width: 40%;
    max-width: 18px;
    height: var(--pct);
    min-height: 0;
    border-radius: var(--radius) var(--radius) 0 0;
  }

  .facts .bar {
    background: var(--muted);
  }

  .facts .pbar {
    background: var(--muted);
    opacity: 0.45;
  }

  /* —— 明细 —— */
  .detail .detail-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: none;
    min-height: var(--row-height);
    padding: 2px var(--space-1);
    border-radius: var(--radius);
    font-size: var(--text-body);
    cursor: pointer;
  }

  .detail .detail-row:hover {
    background: var(--block-fill-missed);
  }

  .detail .time {
    flex: none;
    width: 96px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .detail .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .detail .name.temp {
    font-style: italic;
  }

  .detail .state,
  .detail .fact {
    flex: none;
    color: var(--text-secondary);
  }

  .exempt-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    /* round77（3.1b）：命中区 ≥32（旧值 ≈20×20）—— 图标本体 16px 由 <Icon> 给 */
    min-width: 32px;
    min-height: 32px;
    padding: 0 var(--space-1);
    border: 1px solid var(--grid-line);
    border-radius: var(--radius);
    background: none;
    color: var(--text-primary);
    font-size: var(--text-body);
    cursor: pointer;
  }

  .exempt-toggle.off {
    color: var(--warn);
    border-color: var(--warn);
  }

  /* —— 未完成列表 —— */
  .missed ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .missed li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-body);
  }

  .missed .when {
    flex: none;
    width: 96px;
    color: var(--text-secondary);
  }

  .missed .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .reschedule {
    flex: none;
    padding: 0 var(--space-1);
    border: 1px solid var(--grid-line);
    background: none;
    color: var(--text-primary);
    cursor: pointer;
  }
</style>
