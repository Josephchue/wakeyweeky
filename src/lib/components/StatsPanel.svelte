<script lang="ts">
  import { t, tn } from "../i18n/i18n.svelte";
  import { confirmDanger, focusTrap, scrollableRegion } from "../utils/modal";
  import Icon from "../icons/Icon.svelte";
  /**
   * 10.1 统计页（R36 / round60 / 0.14.0）：全时段累计 + 近 12 周。
   *
   * 形态：覆盖式面板 + 顶部 `▤ 统计` 触发；`Esc` / `✕` / 点外面关闭；**每次打开重拉**
   * （只读快照 —— 打开那一下的数字就是最新的）。
   *
   * 这里不重算任何规则：数字与口径全在 Rust `stats.rs`（唯一实现）；本组件只把它们画成
   * 「名称 …… 右对齐数字」的行 —— 外形照 Minecraft 的统计屏（看了实物截图：一列行、
   * 数字右对齐、0 值照摆；见 `docs/plans/round60-stats-page.md` §四）。
   */

  import type { Stats } from "../ipc/types";
  import { closeStats, openStats, resetStats, stats } from "../stores/stats.svelte";
  import { closeReview } from "../stores/review.svelte";
  import { goNow } from "../stores/week.svelte";
  import { formatDate, formatDuration } from "../utils/week";
  import { categoryColorIndex, categoryColorVar } from "../utils/category-color";
  import { categoryOrderList } from "../stores/tasks.svelte";
  import { formatWeekShort } from "../utils/weekcard";
  import { toast } from "../stores/ui.svelte";

  /**
   * round79（78-10）：「重置统计」—— 二次确认（应用内确认面板，round80 · 79-01）→ 后端写一个
   * **时间界**（非破坏：一条事件不删，成就 / 理智曲线 / 重复水位线都不影响）→ 提示。
   * 不做撤销（你 2026-10-06 拍板：有二次确认就不叠撤销）。
   */
  async function confirmResetStats() {
    const ok = await confirmDanger({
      body: t("ui.stats_panel.67"),
      title: t("ui.stats_panel.68"),
      ok: t("ui.stats_panel.69"),
      cancel: t("ui.stats_panel.70"),
    });
    if (!ok) return;
    if (await resetStats()) toast(t("ui.stats_panel.71"));
  }

  /** round78（3.1b₂ · 教-01/教-02）：空态的直接动作 —— 关掉统计 + 翻回本周（去时间轴排一块）
   *  round83（验收回修 · 你图 1）：统计可能是**总览的子层**开的 —— 「去时间轴」得把**父层一起收掉**，
   *  否则总览还盖着，点了像没反应（`closeReview()` 会顺手把作为子层的统计带走）。 */
  function goStatsToWeek(): void {
    closeReview();
    closeStats(); // 总览功能关着时的**独立**统计面板：没有父层，得自己收
    goNow();
  }

  /** 分母不存在 / 没有记录时的写法：**不编一个 0 出来** */
  const DASH = "—";

  /** 完成率：`6/8 · 75%`（分母看得见）；分母 0 → `—` */
  const rateText = (s: Stats) =>
    s.rate_pct === null ? DASH : `${s.complete}/${s.complete + s.skip} · ${s.rate_pct}%`;

  /** 完成时长：`18 小时 15 分`；一次记录都没有 → `—` */
  const minutesText = (s: Stats) =>
    s.done_timed === 0 ? DASH : formatDuration(s.done_minutes * 60);

  /** 记录始于：`2026-09-27`；没有事件 → `—` */
  const firstText = (s: Stats) =>
    s.first_event_at === null ? DASH : formatDate(s.first_event_at);

  type Row = {
    label: string;
    value: string;
    /** 值后面的小字补充（`含临时 1` / `3/11 次有记录`） */
    detail?: string;
    /** 悬停说明（口径） */
    title?: string;
    /** round82（统-10）：小条宽度（0…100）—— **没有有意义的比例就不画**（不上装饰性假条） */
    measure?: number;
    /** 分类分布的小色点（与块底边条同一套 `cat-1…8`） */
    dot?: string;
  };
  type Group = {
    name: string;
    rows: Row[];
    /** round82（统-03）：这一组先画 14 天趋势条 */
    trend?: boolean;
    /** 组尾的一句说明（分类分布的口径） */
    note?: string;
  };

  /** 面板的骨架：**照抄 `stats.rs` 的口径**，不在这边做任何算术（完成率与时长格式化除外） */
  const groups = $derived.by((): Group[] => {
    const s = stats.data;
    if (!s) return [];
    // round82（统-10）：小条的「满格」分母 —— 分类按本组最大时长；比例本身就是答案的不再换算
    const catMax = Math.max(0, ...s.categories.map((c) => c.minutes));
    const catOrder = categoryOrderList();
    return [
      {
        name: t("ui.stats_panel.01"),
        rows: [
          { label: t("ui.stats_panel.02"), value: t("ui.stats_panel.03", { complete: s.complete }) },
          { label: t("ui.stats_panel.04"), value: t("ui.stats_panel.05", { skip: s.skip }) },
          {
            label: t("ui.stats_panel.06"),
            value: rateText(s),
            title: t("ui.stats_panel.07"),
            measure: s.rate_pct ?? undefined,
          },
          {
            label: t("ui.stats_panel.74"),
            value: s.on_time_pct === null ? DASH : `${s.on_time}/${s.rated} · ${s.on_time_pct}%`,
            detail: t("ui.stats_panel.76", { rated: s.rated, complete: s.complete }),
            title: t("ui.stats_panel.75"),
            measure: s.on_time_pct ?? undefined,
          },
        ],
      },
      {
        name: t("ui.stats_panel.08"),
        rows: [
          {
            label: t("ui.stats_panel.09"),
            value: t("ui.stats_panel.10", { created: s.created }),
            detail: s.created_temp > 0 ? t("ui.stats_panel.11", { created_temp: s.created_temp }) : undefined,
            title: t("ui.stats_panel.12"),
          },
          {
            label: t("ui.stats_panel.13"),
            value: t("ui.stats_panel.14", { moved: s.moved }),
            title: t("ui.stats_panel.15"),
          },
          { label: t("ui.stats_panel.16"), value: t("ui.stats_panel.17", { stretched: s.stretched }), title: t("ui.stats_panel.18") },
          { label: t("ui.stats_panel.19"), value: t("ui.stats_panel.20", { postponed: s.postponed }), title: t("ui.stats_panel.21") },
          {
            label: t("ui.stats_panel.22"),
            value: t("ui.stats_panel.23", { cascaded: s.cascaded }),
            title: t("ui.stats_panel.24"),
          },
          {
            label: t("ui.stats_panel.25"),
            value: tn("ui.stats_panel.26", s.deleted, { deleted: s.deleted }),
            title: t("ui.stats_panel.27"),
          },
          { label: t("ui.stats_panel.28"), value: tn("ui.stats_panel.29", s.merged, { merged: s.merged }), title: t("ui.stats_panel.30") },
        ],
      },
      {
        name: t("ui.stats_panel.31"),
        rows: [
          { label: t("ui.stats_panel.32"), value: t("ui.stats_panel.33", { linked: s.linked }) },
          { label: t("ui.stats_panel.34"), value: t("ui.stats_panel.35", { unlinked: s.unlinked }) },
        ],
      },
      {
        name: t("ui.stats_panel.36"),
        rows: [
          {
            label: t("ui.stats_panel.37"),
            value: minutesText(s),
            detail:
              s.done_timed === 0
                ? t("ui.stats_panel.38", { complete: s.complete })
                : t("ui.stats_panel.39", { done_timed: s.done_timed, complete: s.complete }),
            title: t("ui.stats_panel.40"),
          },
          {
            label: t("ui.stats_panel.77"),
            value: s.avg_minutes === null ? DASH : formatDuration(s.avg_minutes * 60),
            title: t("ui.stats_panel.78"),
          },
        ],
      },
      {
        name: t("ui.stats_panel.72"),
        trend: true,
        rows: [
          {
            label: t("ui.stats_panel.79"),
            value: tn("ui.stats_panel.90", s.streak_now, { days: s.streak_now }),
            title: t("ui.stats_panel.81"),
            measure: s.streak_best === 0 ? undefined : Math.round((s.streak_now / s.streak_best) * 100),
          },
          {
            label: t("ui.stats_panel.80"),
            value: tn("ui.stats_panel.90", s.streak_best, { days: s.streak_best }),
            title: t("ui.stats_panel.81"),
            measure: s.streak_best === 0 ? undefined : 100,
          },
        ],
      },
      {
        name: t("ui.stats_panel.73"),
        note: t("ui.stats_panel.89"),
        rows: s.categories.map((c) => {
          const untagged = c.category === "";
          return {
            label: untagged ? t("ui.stats_panel.86") : c.category,
            value: formatDuration(c.minutes * 60),
            detail: tn("ui.stats_panel.88", c.done, { count: c.done }),
            title: untagged ? t("ui.stats_panel.87") : undefined,
            dot: untagged ? undefined : categoryColorVar(categoryColorIndex(c.category, catOrder)),
            measure: catMax === 0 ? 0 : Math.round((c.minutes / catMax) * 100),
          };
        }),
      },
      {
        name: t("ui.stats_panel.41"),
        rows: [
          { label: t("ui.stats_panel.42"), value: firstText(s) },
          { label: t("ui.stats_panel.43"), value: tn("ui.stats_panel.44", s.active_days, { active_days: s.active_days }) },
          {
            label: t("ui.stats_panel.45"),
            value: tn("ui.stats_panel.46", s.total_events, { total_events: s.total_events }),
            title: t("ui.stats_panel.47"),
          },
        ],
      },
    ];
  });

  // round78（栈-01/栈-02）：`Esc` 与「关自己」统一收进面板栈（`Timeline` 的全局处理器 → `closeTopPanel()`），
  // 这里不再各自监听 —— 以前 7 处各听各的，一次 Esc 会把叠着的面板**全关**（round72 L2）。
</script>

{#if stats.open}
  <!-- round77 收尾：遮罩**不进 Tab 顺序**（它只是「点一下关面板」的鼠标快捷键；键盘用面板的 ✕ / Esc） -->
  <button
    class="overlay-backdrop"
    type="button"
    tabindex="-1"
    aria-label={t("ui.stats_panel.48")}
    onclick={closeStats}
  ></button>
  <!-- round78（栈-03/栈-04）：窄档（560）+ 模态契约（焦点陷阱 / aria-modal） -->
<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role（`section role="dialog"` 是 ARIA 认可写法，Svelte 的检查器偏严） -->
  <section
    class="overlay-panel narrow stats-panel"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    aria-label={t("ui.stats_panel.49")}
    use:focusTrap={{ active: stats.open }}
    use:scrollableRegion={{ label: t("ui.stats_panel.49") }}
  >
    <header class="panel-head">
      <h2 class="title">{t("ui.stats_panel.50")}</h2>
      <span class="scope">{t("ui.stats_panel.51")}</span>
      <button class="close" type="button" title={t("ui.stats_panel.52")} onclick={closeStats}><Icon name="close" size={16} /></button>
    </header>

    <div class="body">
      {#if stats.failed}
        <!-- round78（3.1b₂ · 栈-10）：失败态要有「重试」 -->
        <p class="state">
          {t("ui.stats_panel.53")}
          <button type="button" class="empty-action" onclick={() => void openStats()}>{t("ui.common.01")}</button>
        </p>
      {:else if stats.data === null}
        <p class="state">{t("ui.stats_panel.54")}</p>
      {:else}
        {@const s = stats.data}
        {#if s.total_events === 0}
          <p class="state">{t("ui.stats_panel.55")}</p>
          <!-- round78（3.1b₂ · 教-01/教-02）：空态必须有**一个直接动作**（以前只有一句话） -->
          <p class="state">
            <button type="button" class="empty-action" onclick={goStatsToWeek}>{t("ui.stats_panel.65")}</button>
          </p>
        {/if}
        {#each groups as group (group.name)}
          <section class="group" aria-label={group.name}>
            <h3>{group.name}</h3>
            {#if group.trend}
              {@const maxDone = Math.max(0, ...s.trend.map((d) => d.done))}
              {@const peak = Math.max(1, maxDone)}
              <div class="trend" role="img" aria-label={t("ui.stats_panel.82")}>
                {#each s.trend as d (d.day)}
                  <span class="tbar" title={t("ui.stats_panel.84", { date: formatDate(d.day), count: d.done })}>
                    {#if d.done > 0}<i style="height: {Math.max(8, Math.round((d.done / peak) * 100))}%"></i>{/if}
                  </span>
                {/each}
              </div>
              <p class="trend-cap">{t("ui.stats_panel.83", { max: maxDone })}</p>
            {/if}
            <dl class="rows">
              {#each group.rows as row (row.label)}
                <div class="row">
                  <dt title={row.title}>
                    {#if row.dot}<span class="dot" style="background: {row.dot}" aria-hidden="true"></span>{/if}{row.label}
                  </dt>
                  <dd>
                    <span class="num">{row.value}</span>{#if row.detail}<span class="muted">{t("ui.stats_panel.56", { detail: row.detail })}</span>{/if}
                    {#if row.measure !== undefined}<span class="measure" aria-hidden="true"><i style="width: {row.measure}%"></i></span>{/if}
                  </dd>
                </div>
              {/each}
            </dl>
            {#if group.rows.length === 0}
              <p class="empty">{t("ui.stats_panel.85")}</p>
            {/if}
            {#if group.note}<p class="empty">{group.note}</p>{/if}
          </section>
        {/each}

        <section class="group" aria-label={t("ui.stats_panel.57")}>
          <h3>{t("ui.stats_panel.58")}</h3>
          {#if s.weeks.length === 0}
            <p class="empty">{t("ui.stats_panel.59")}</p>
            <p class="state">
              <button type="button" class="empty-action" onclick={goStatsToWeek}>{t("ui.stats_panel.65")}</button>
            </p>
          {:else}
            <table class="weeks">
              <thead>
                <tr><th scope="col">{t("ui.stats_panel.60")}</th><th scope="col">{t("ui.stats_panel.61")}</th><th scope="col">{t("ui.stats_panel.62")}</th><th scope="col">{t("ui.stats_panel.63")}</th></tr>
              </thead>
              <tbody>
                {#each s.weeks as w (w.week_start)}
                  <tr>
                    <td>{formatWeekShort(w.week_start)}</td>
                    <td>{w.done}</td>
                    <td>{w.missed}</td>
                    <td>{w.postponed}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </section>

        <footer class="foot">
          <p>{t("ui.stats_panel.64")}</p>
          <!-- round79（78-10）：「重置统计」—— 非破坏（只挪计分起点），二次确认后生效 -->
          <p class="reset-row">
            <button type="button" class="danger-action reset-stats" onclick={() => void confirmResetStats()}
              >{t("ui.stats_panel.66")}</button
            >
          </p>
        </footer>
      {/if}
    </div>
  </section>
{/if}

<style>

  .stats-panel {
    /* round78（栈-04）：定位/宽度/最大高交给 `.overlay-panel.narrow`（固定左缘 + 560 档） */
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
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--grid-line);
  }

  .title {
    margin: 0;
    font-size: var(--text-title);
  }

  .scope {
    color: var(--text-secondary);
    font-size: var(--text-meta);
  }

  .close {
    margin-left: auto;
    padding: 2px var(--space-2);
    border: 1px solid var(--grid-line);
    background: none;
    color: var(--text-secondary);
    font-size: var(--text-body);
    cursor: pointer;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4);
  }

  .state {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-body);
  }

  /* round78（3.1b₂ · 教-01/教-02）：空态的直接动作（一行小按钮，不抢正文） */
  .empty-action {
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

  .empty-action:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .group h3 {
    margin: 0 0 var(--space-2);
    color: var(--text-secondary);
    font-size: var(--text-label);
    font-weight: 600;
  }

  .rows {
    margin: 0;
    display: flex;
    flex-direction: column;
  }

  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-4);
    padding: 3px 0;
    border-bottom: 1px solid var(--grid-line);
  }

  .row:last-child {
    border-bottom: none;
  }

  dt {
    font-size: var(--text-body);
  }

  dd {
    margin: 0;
    text-align: right;
    font-size: var(--text-body);
  }

  /* 数字右对齐 + 等宽数字 —— 一列数字要能竖着对齐读（MC 统计屏的关键外形） */
  .num {
    font-variant-numeric: tabular-nums;
  }

  .muted {
    color: var(--text-secondary);
    font-size: var(--text-meta);
  }

  /* round82（统-03）：近 14 天完成趋势 —— 14 根竖条（0 值留一条底轨，"0 照摆"） */
  .trend {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 32px;
    margin-bottom: var(--space-1);
  }

  .tbar {
    flex: 1;
    height: 100%;
    display: flex;
    align-items: flex-end;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border-radius: 2px;
  }

  .tbar i {
    display: block;
    width: 100%;
    background: var(--accent);
    border-radius: 2px;
  }

  .trend-cap {
    margin: 0 0 var(--space-1);
    color: var(--text-secondary);
    font-size: var(--text-meta);
  }

  /* round82（统-10）：名称-数字行下面的比例小条（零依赖；无有意义的比例就不画） */
  .measure {
    display: block;
    margin: 3px 0 0 auto;
    width: 96px;
    height: 3px;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    border-radius: 2px;
    overflow: hidden;
  }

  .measure i {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
  }

  /* 分类分布的小色点（图例；与块底边条同一套 `cat-1…8`） */
  .dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: var(--space-1);
    border-radius: 2px;
  }

  .weeks {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-meta);
  }

  .weeks th,
  .weeks td {
    padding: 3px var(--space-1);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .weeks th:first-child,
  .weeks td:first-child {
    text-align: left;
    font-variant-numeric: normal;
  }

  .weeks th {
    color: var(--text-secondary);
    font-weight: 600;
  }

  .weeks tbody tr {
    border-top: 1px solid var(--grid-line);
  }

  .empty {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-body);
  }

  .foot {
    color: var(--text-secondary);
    font-size: var(--text-meta);
    line-height: var(--line-body);
  }

  .foot p {
    margin: 0;
  }

  /* round79（78-10）：重置统计 —— 危险动作用的那个色（`--danger`），但仍然是个次要按钮 */
  .foot p.reset-row {
    margin-top: var(--space-2);
  }

  /* 视觉走 `src/lib/styles/actions.css` 的 `.danger-action`（三处危险操作共用一套） */
</style>
