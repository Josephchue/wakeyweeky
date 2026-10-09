<script lang="ts">
  import { t } from "../i18n/i18n.svelte";
  /**
   * C7（round52）：马赛克 —— **一块 = 一个方块**，颜色 + 纹理（双通道）表结局。
   *
   * 两种读法共用这一个组件：`mode="state"` 一行一天；`mode="category"` 一行一类
   * （顺序口径读 `utils/category.ts` —— 名字序、未分类最后）。
   * 决策台账 #19：颜色只表状态；类别靠**排布**表达，不上色。
   *
   * round53（验收回修）：① 状态视图里**整行可点**（以前只有行头那个小按钮能点 —— 用户实测点不动）
   * ② `unused`（未执行）改成**空心虚线**（以前弹性层是 8% 透明度的发丝线，等于看不见 —— 用户实测
   *    「上周塞了数据却没看见马赛克」）③ 今天的行带一个「今天」小标（默认聚焦那天要说得清为什么）。
   *
   * round54（9.2）：把「上周」与「本周」放成可比的一对（旧写法是上下两排独立马赛克，连格数都不同）。
   * **round55（你 2026-10-04 验收）**：那个 `｜` 字符撤掉了 —— 改成**一天两行**（上 = 上周淡、下 = 本周），
   * 两组**起点相同**（实测两行首块 x 完全一致）、按天对齐；空的那组写「—」占位。
   */
  import type { MosaicBlock, MosaicState } from "../ipc/types";
  import { mosaicText } from "../stores/review.svelte";
  import { formatClockRange } from "../utils/week";

  let {
    rows,
    prevRows = null,
    pairing = "index",
    activeDay = null,
    onPickDay = null,
    states = [],
  }: {
    /** 行（状态视图 = 周一…周日；类别视图 = 一行一类）—— `day_start` 非空的行可点 */
    rows: { key: string; label: string; day_start: number | null; blocks: MosaicBlock[] }[];
    /** round54：上周的行（按**上周自己的**天分组）—— 给了就把每组方块画在同一行的前半段（淡） */
    prevRows?: { key: string; label: string; day_start: number | null; blocks: MosaicBlock[] }[] | null;
    /**
     * round69（B3）：两周的配对方式 ——
     * `index`（状态视图）：按**行序**（周一…周日同序；两周日期本来就不同，不能按 `day_start` 查）；
     * `key`（类别视图）：按**类别 key**（两周的类别次序本来就可能不同）。
     */
    pairing?: "index" | "key";
    /** 状态视图里高亮的那一天（本地零点） */
    activeDay?: number | null;
    onPickDay?: ((day: number) => void) | null;
    /** 图例：只列**真出现过**的结局（空数组 = 不画图例，比如「上周」那一排） */
    states?: MosaicState[];
  } = $props();

  /** 按 key 配对时用（类别视图）：key → 基线行方块 */
  const prevByKey = $derived(new Map((prevRows ?? []).map((r) => [r.key, r.blocks])));
  /** 某一行的「基线那组方块」—— `index` 按行序、`key` 按类别（round69） */
  const prevOf = (row: { key: string }, i: number): MosaicBlock[] =>
    pairing === "key" ? prevByKey.get(row.key) ?? [] : prevRows?.[i]?.blocks ?? [];
  /** 并排对比只在基线行存在时成立 */
  const paired = $derived(!!prevRows && prevRows.length > 0);

  /** 显示名：临时块用 label ?? 任务名（后端把隐藏任务的标题写成「临时安排」） */
  const nameOf = (b: MosaicBlock) => b.label ?? b.title;

  /** 悬停文字：名字 · 时间 · 结局（+ 事实）。**颜色不是唯一通道** —— 悬停/读屏都能拿到 */
  function titleOf(b: MosaicBlock): string {
    const parts = [nameOf(b), formatClockRange(b.start_at, b.end_at), mosaicText(b.mosaic_state)];
    if (b.mosaic_state === "unused") parts.push(t("ui.mosaic.01"));
    if (b.mosaic_state === "planned") parts.push(t("ui.mosaic.02"));
    if (b.exempt) parts.push(t("ui.mosaic.03"));
    if (b.rearranged > 0) parts.push(t("ui.mosaic.04", { rearranged: b.rearranged }));
    if (b.skipped) parts.push(t("ui.mosaic.05"));
    if (b.layer === "required") parts.push(t("ui.mosaic.06"));
    return parts.join(" · ");
  }
</script>

{#snippet head(row: { label: string; day_start: number | null })}
  <span class="head">{row.label}</span>
{/snippet}

{#snippet tiles(list: MosaicBlock[], dim = false)}
  <span class="tiles" class:dim>
    {#if list.length === 0 && paired}
      <!-- round55：**只在对比态**用「—」占位（单周视图里空天就是空的）
           —— 交付前复核抓到：旧写法没跟 `paired` 绑，未对比时每个空天也印「—」 -->
      <span class="none" aria-hidden="true">—</span>
    {/if}
    {#each list as b (b.id)}
      <span
        class="tile"
        class:required={b.layer === "required"}
        data-state={b.mosaic_state}
        data-block-id={b.id}
        data-day={b.day_start}
        title={titleOf(b)}
      >
        {#if b.exempt}<span class="mark" aria-hidden="true">⊘</span>{/if}
      </span>
    {/each}
  </span>
{/snippet}

<!-- round55（你 2026-10-04 验收：「|」照样蠢，用换行对齐替换掉它）
     并排对比改成**两行一天**：图例也跟着做成两行（与行的结构一致 —— 看哪行是哪周不用再猜） -->
{#if paired}
  <div class="pair-legend">
    <span class="tile" data-dim="1"></span><span>{t("ui.mosaic.07")}</span>
    <span class="tile"></span><span>{t("ui.mosaic.08")}</span>
  </div>
{/if}

<div class="mosaic" class:paired>
  {#each rows as row, i (row.key)}
    {#if row.day_start !== null && onPickDay}
      <!-- round53：整行是一个真按钮（键盘可达 + 点哪儿都能换天） -->
      <button
        type="button"
        class="row pickable"
        class:active={row.day_start === activeDay}
        title={t("ui.mosaic.09")}
        onclick={() => onPickDay?.(row.day_start!)}
      >
        {@render head(row)}
        <span class="stacks">
          {#if paired}
            <span class="sub prev">{@render tiles(prevOf(row, i), true)}</span>
          {/if}
          <span class="sub cur">{@render tiles(row.blocks)}</span>
        </span>
      </button>
    {:else}
      <div class="row">
        {@render head(row)}
        <span class="stacks">
          {#if paired}
            <span class="sub prev">{@render tiles(prevOf(row, i), true)}</span>
          {/if}
          <span class="sub cur">{@render tiles(row.blocks)}</span>
        </span>
      </div>
    {/if}
  {/each}
</div>

{#if states.length > 0}
  <div class="legend">
    {#each states as s (s)}
      <span class="legend-item"><span class="tile" data-state={s}></span>{mosaicText(s)}</span>
    {/each}
  </div>
{/if}

<style>
  /* 尺寸在这里一次定死（21st.dev：格子类可视化里“色阶/尺寸”是组件本身，不是皮肤） */
  .mosaic {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    min-width: 0;
  }

  /* 可点的行：壳子还是原来那个样子（只加 hover/active 反馈） */
  .row.pickable {
    width: 100%;
    padding: 1px var(--space-1);
    background: none;
    border: none;
    border-radius: var(--radius);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row.pickable:hover {
    background: var(--block-fill-missed);
  }

  .head {
    flex: none;
    width: 74px;
    color: var(--text-secondary);
    font-size: var(--text-label);
    /* px 行高：固定 74px 宽的图例列，单行不换行（固定尺寸控件） */
    line-height: 16px;
    white-space: nowrap;
  }

  .row.active .head {
    color: var(--text-primary);
    font-weight: 600;
  }

  .tiles {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    min-width: 0;
  }

  /* round54：上周那一组降一档对比度（是背景/参照，本周才是主角）；
     纹理与形状照旧可见 —— 淡化不是唯一通道的替代品 */
  .tiles.dim {
    opacity: 0.45;
  }

  /* 两组之间的分隔（并排对比时的「同一把尺」标记） */
  /* round55：一天两行 —— 天名那一列跨两行（`align-items: flex-start` 已在 `.row` 上） */
  .stacks {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .sub {
    display: flex;
    align-items: center;
    min-height: 14px;
  }

  .none {
    color: var(--text-secondary);
    opacity: 0.6;
    font-size: var(--text-meta);
    line-height: var(--line-compact);
  }

  /* 图例也做成两行（与行的结构一致 —— 「哪行是哪周」不用猜） */
  .pair-legend {
    display: grid;
    grid-template-columns: 14px auto;
    align-items: center;
    gap: 3px var(--space-1);
    margin-bottom: var(--space-2);
    color: var(--text-secondary);
    font-size: var(--text-label);
  }

  .pair-legend .tile[data-dim="1"] {
    opacity: 0.45;
  }

  .tile {
    position: relative;
    box-sizing: border-box;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    background: var(--block-fill-missed);
  }

  /* —— 结局：颜色 + 纹理/描边双通道（WCAG G111）—— */
  .tile[data-state="done"] {
    background: var(--accent);
  }

  .tile[data-state="done_overtime"] {
    background: var(--block-fill-done);
  }

  .tile[data-state="done_short"] {
    background: color-mix(in srgb, var(--accent) 28%, transparent);
    border: 1px solid var(--block-fill-done);
  }

  /* 未完成：斜纹 + 虚线（与时间轴上的残影同一套读法） */
  .tile[data-state="missed"] {
    background: repeating-linear-gradient(
      45deg,
      var(--block-fill-missed) 0 2px,
      transparent 2px 4px
    );
    border: 1px dashed var(--muted);
  }

  /* 未执行（时间已过、既没做也没标记）：空心 + 虚线 —— 必填层用警示色说「本该做」
     round53：弹性层以前是 8% 透明度的发丝线（看不见）→ 现在两层都是**看得见**的虚线空心 */
  .tile[data-state="unused"] {
    background: transparent;
    border: 1px dashed var(--muted);
  }

  .tile[data-state="unused"].required {
    background: color-mix(in srgb, var(--warn) 12%, transparent);
    border: 1px dashed var(--warn);
  }

  /* 计划中（还没到）：细实线空心 */
  .tile[data-state="planned"] {
    background: transparent;
    border: 1px solid var(--muted);
  }

  .mark {
    position: absolute;
    top: -4px;
    right: -3px;
    color: var(--text-secondary);
    font-size: var(--text-meta);
    line-height: 1;
  }

  /* 图例：方块与文字并列（颜色 + 文字双通道） */
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    margin-top: var(--space-2);
    color: var(--text-secondary);
    font-size: var(--text-label);
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }
</style>
