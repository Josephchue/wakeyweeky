<script lang="ts">
  import type { SkeletonRow } from "../ipc/templates";
  import { layerLabel, skeletonRowName } from "../utils/templates";
  import { formatDayLabel, weekdayLabel } from "../utils/week";
  import { formatClock, is12Hour } from "../utils/datetime.svelte";
  import { appearance } from "../stores/appearance.svelte";
  import { prefs } from "../stores/settings.svelte";
  import { DENSITY_SCALE, nightSegments } from "../utils/appearance";
  import { assignColumns } from "../utils/timeline";

  /**
   * round80（79-02）：**迷你周视图** —— 主界面时间轴的缩略版（你 2026-10-06 拍板的口径）。
   *
   * - 形态：日头 / 左轴刻度 / 小时网格 / 块（浅底 + 左层条 4px，实心=必填、虚线=弹性），与 `Timeline.svelte`
   *   同一套 token，但**只读、不吃手势**（不复用那个大组件）；
   * - 竖向固定 **0:00–24:00**（你拍板）——绝对位置可读；尺寸随窗口自适应由外层浮窗给；
   * - 联动（双向）：外层把 `hot`（行号）传进来 → 对应块加 `.hot`；鼠标进某块 → `onHover(row)`。
   * 键盘路径由**列表行**的 focus 驱动；预览本身是**装饰**（`aria-hidden`，读屏信息由列表承载 —— round80 6b P2 定的口径）。
   * - 跨天块拆成每天一段（第二段起带延续记号）。
   */
  let {
    rows,
    weekStart,
    hot = null,
    onHover,
  }: {
    rows: SkeletonRow[];
    weekStart: number;
    hot?: number | null;
    onHover: (i: number | null) => void;
  } = $props();

  const DAY_MIN = 1440;
  /** 周内分钟 → 时刻串（跨天段取当天时刻）；12 小时制下 `8:00 PM` —— 走收口模块（round81） */
  const at = (m: number) => formatClock(Math.floor(new Date(2026, 0, 1, 0, m, 0).getTime() / 1000));

  type Seg = { row: number; day: number; start: number; dur: number; cont: boolean; layer: string };
  const segs = $derived.by(() => {
    const out: Seg[] = [];
    rows.forEach((r, i) => {
      let day = Math.min(6, Math.max(0, Math.floor(r.start_min / DAY_MIN)));
      let start = r.start_min - day * DAY_MIN;
      let left = Math.max(0, r.duration_min);
      let cont = false;
      while (left > 0 && day <= 6) {
        const dur = Math.min(left, DAY_MIN - start);
        out.push({ row: i, day, start, dur, cont, layer: r.layer });
        left -= dur;
        day += 1;
        start = 0;
        cont = true;
      }
    });
    return out;
  });

  // 尺寸是运行时才知道的（浮窗随窗口自适应）→ 量一次，用它决定刻度步长与「要不要画名字」
  let host = $state<HTMLElement | null>(null);
  let size = $state({ w: 0, h: 0 });
  $effect(() => {
    if (!host) return;
    const el = host;
    const ro = new ResizeObserver(() => (size = { w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    size = { w: el.clientWidth, h: el.clientHeight };
    return () => ro.disconnect();
  });

  const gridH = $derived(Math.max(0, size.h - 20));
  const hourPx = $derived(gridH / 24);
  const labelStep = $derived(hourPx >= 16 ? 60 : hourPx >= 9 ? 120 : 180);
  /** 左侧刻度栏宽 —— 12 小时制标签（`12:00 PM`）更宽，按 `data-time12` 的同一口径加宽 */
  const axisW = $derived(is12Hour() ? 72 : 38);
  const colW = $derived(Math.max(0, size.w - axisW) / 7);
  /** 名字一行的阈值按**行高**算（跟密度：`--text-meta` 12/12/13px）—— 写死值在「宽松」档会截字。
   *  `.blk span`：`line-height: 1.2` + 上外边距 1px；块上下边框各 1px。 */
  const lineH = $derived(DENSITY_SCALE[appearance.density].textMeta * 1.2);
  const needName = $derived(3 + lineH); // 边框 2 + 外边距 1 + 一行
  /**
   * round82（11.1 · 案 B）：重叠块**并排**（与主时间轴共用 `assignColumns`），名字**宽度够才画**。
   * 阈值 30px = 两个汉字 + 内缩；窄档（N=2 → 23.3px、N=3 → 14.2px）自然退成「只画层条」——
   * 名字与时段还在 tooltip（`blkTitle`）与右侧列表行里，信息不丢。
   */
  const NEED_NAME_PX = 30;
  const showFullDay = $derived(colW >= 72);
  const labels = $derived(
    Array.from({ length: Math.floor(1440 / labelStep) }, (_, i) => (i + 1) * labelStep),
  );
  const hourLines = $derived(Array.from({ length: 23 }, (_, i) => (i + 1) * 60));
  /** round82（淡-10）：迷你周视图**一起淡化**（它是同一份视觉的缩略）；同一对起止 + 同一 token */
  const dimSegs = $derived(prefs.nightDim ? nightSegments(prefs.nightStart, prefs.nightEnd) : []);
  const days = $derived([0, 1, 2, 3, 4, 5, 6].map((d) => new Date((weekStart + d * 86400) * 1000)));

  /**
   * round82（11.1）：同一块跨天拆出来的**段**按天分组，再用主时间轴那套贪心分列算出横向位置。
   * 为什么按天分组：跨天块的两段分别落在不同天，它们之间不该互相「重叠」。
   */
  const placed = $derived.by(() => {
    const byDay = new Map<number, Seg[]>();
    for (const s of segs) {
      const list = byDay.get(s.day);
      if (list) list.push(s);
      else byDay.set(s.day, [s]);
    }
    const out: { s: Seg; col: number; cols: number }[] = [];
    for (const list of byDay.values()) {
      const sorted = [...list].sort((a, b) => a.start - b.start);
      const cols = assignColumns(
        sorted.map((x) => ({ start_at: x.start, end_at: x.start + x.dur })),
      );
      sorted.forEach((x, i) => out.push({ s: x, col: cols[i].colIndex, cols: cols[i].colCount }));
    }
    return out.sort((a, b) => a.s.day - b.s.day || a.s.start - b.s.start);
  });

  /** 并排后每个块的实际宽度（px）—— 名字画不画看它 */
  const blockW = (cols: number) => colW / cols - 4;

  const blkTitle = (s: Seg): string => {
    const r = rows[s.row];
    return [skeletonRowName(r), `${at(s.start)}–${at(s.start + s.dur)}`, layerLabel(r.layer)]
      .filter(Boolean)
      .join(" · ");
  };
</script>

<div class="mini" bind:this={host} aria-hidden="true" data-tpl-mini style="--mini-axis:{axisW}px">
  <div class="axis" aria-hidden="true">
    {#each labels as m (m)}
      <b style="top:{(m / DAY_MIN) * 100}%">{at(m)}</b>
    {/each}
  </div>
  <div class="heads" aria-hidden="true">
    {#each days as d, i (i)}<i>{showFullDay ? formatDayLabel(d) : weekdayLabel(d)}</i>{/each}
  </div>
  <div class="grid">
    {#each hourLines as m (m)}
      <span class="hl" style="top:{(m / DAY_MIN) * 100}%"></span>
    {/each}
    {#each [1, 2, 3, 4, 5, 6] as d (d)}
      <span class="vl" style="left:{(d / 7) * 100}%"></span>
    {/each}
    {#if dimSegs.length > 0}
      <!-- round82（淡-10）：淡化带在网格线**之上**、块**之下**（DOM 顺序：线 → 带 → 块） -->
      <span class="dim-band" aria-hidden="true">
        {#each dimSegs as seg (`${seg.from}-${seg.to}`)}
          <i style="top:{(seg.from / DAY_MIN) * 100}%; height:{((seg.to - seg.from) / DAY_MIN) * 100}%"></i>
        {/each}
      </span>
    {/if}
    {#each placed as { s, col, cols } (`${s.row}-${s.day}-${s.start}`)}
      {@const hpx = (s.dur / DAY_MIN) * gridH}
      <div
        class="blk {s.layer === "required" ? "required" : "elastic"}"
        class:hot={hot === s.row}
        class:cont={s.cont}
        role="presentation"
        data-row={s.row}
        data-day={s.day}
        data-cols={cols}
        style="left:calc({(s.day / 7) * 100}% + {(col / cols) * (100 / 7)}% + 2px); width:calc({100 / 7 / cols}% - 4px); top:{(s.start / DAY_MIN) * 100}%; height:max(3px, {(s.dur / DAY_MIN) * 100}%)"
        title={blkTitle(s)}
        onmouseenter={() => onHover(s.row)}
        onmouseleave={() => onHover(null)}
      >
        <!-- round81（「挤」红→绿）：迷你预览**只画名字**—— 6b 复核实测：即使最宽的浮窗（600px）
             文字可用宽也才 ≈62px，而 `10:00–10:30` 需 ≈68px → 时段行必然被省略号截。
             时段交给块 tooltip（`blkTitle`）与右侧列表行；两行的“挤”从根上不再出现。
             round82（11.1 · 案 B）：并排后块宽 ≥ 30px 才画名字（窄档只剩层条，名字看 tooltip）。 -->
        {#if hpx >= needName && blockW(cols) >= NEED_NAME_PX}
          <span class="nm">{skeletonRowName(rows[s.row]) || layerLabel(rows[s.row].layer)}</span>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .mini {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: var(--card);
    border: 1px solid var(--grid-line);
    border-radius: var(--radius);
  }

  .axis {
    position: absolute;
    left: 0;
    top: 20px;
    bottom: 0;
    width: var(--mini-axis, 38px);
  }

  .axis b {
    position: absolute;
    left: 3px;
    font-size: var(--text-meta);
    font-weight: 400;
    color: var(--text-tertiary);
    transform: translateY(-50%);
    white-space: nowrap;
  }

  .heads {
    position: absolute;
    top: 0;
    left: var(--mini-axis, 38px);
    right: 0;
    height: 20px;
    display: flex;
    border-bottom: 1px solid var(--grid-line);
  }

  .heads i {
    flex: 1;
    font-style: normal;
    font-size: var(--text-meta);
    color: var(--text-secondary);
    text-align: center;
    line-height: 20px;
    overflow: hidden;
    white-space: nowrap;
  }

  .heads i + i {
    border-left: 1px solid var(--grid-line);
  }

  .grid {
    position: absolute;
    top: 20px;
    left: var(--mini-axis, 38px);
    right: 0;
    bottom: 0;
    border-left: 1px solid var(--grid-line);
  }

  .hl {
    position: absolute;
    left: 0;
    right: 0;
    border-top: 1px solid var(--grid-line);
  }

  .vl {
    position: absolute;
    top: 0;
    bottom: 0;
    border-left: 1px solid var(--grid-line);
  }

  /* round82（淡-10）：夜间淡化带（与主时间轴同一个 `--dim-band` token；百分比跟着浮窗高度走） */
  .dim-band {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .dim-band i {
    position: absolute;
    right: 0;
    left: 0;
    background: var(--dim-band);
  }

  .blk {
    position: absolute;
    overflow: hidden;
    border-radius: 2px;
    background: var(--block-fill-planned);
    border: 1px solid var(--block-line-planned);
    cursor: default;
  }

  /* 左层条 4px：必填实心 / 弹性虚线（与主界面同一套「形状 = 层」口径） */
  .blk::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    background: var(--layer-elastic-bar);
  }

  .blk.required::before {
    background: var(--layer-required-bar);
  }

  .blk.elastic::before {
    background: repeating-linear-gradient(180deg, var(--layer-elastic-bar) 0 4px, transparent 4px 8px);
  }

  /* 跨天块的后续段：延续记号 */
  .blk.cont::after {
    content: "↳";
    position: absolute;
    right: 1px;
    top: -1px;
    font-size: var(--text-meta);
    color: var(--block-ink-planned);
  }

  .blk.hot {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
    z-index: 3;
  }

  .blk span {
    display: block;
    margin: 1px var(--space-1) 0 var(--space-2);
    font-size: var(--text-meta);
    line-height: 1.2;
    color: var(--block-ink-planned);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

</style>
