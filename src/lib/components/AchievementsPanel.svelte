<script lang="ts">
  import { t } from "../i18n/i18n.svelte";
  import { confirmDanger, scrollableRegion } from "../utils/modal";
  import Icon from "../icons/Icon.svelte";
  /**
   * round68（19.1）成就（暗章）面板 —— **照 MAA 的列表形态**：
   * 未点亮的（非隐藏）也列出：`???` 名字 + 条件 + `x/y` 进度条；隐藏档点亮前完全不出现。
   * 已点亮显示名字 + 一句话 + 点亮于；未点亮才显示条件与进度条（round80 复核：这样就不会「描述与条件重复」）。本次会话刚挂的带 `NEW`。
   *
   * 形态照 `StatsPanel`：覆盖式面板、`Esc` / `✕` / 点外面关闭、每次打开重拉（在 store 里）。
   */
  import { formatDate } from "../utils/week";

  import type { AchievementRow } from "../ipc/types";
  import {
    achievements,
    closeAchievements,
    loadAchievements,
    resetAchievements,
  } from "../stores/achievements.svelte";
  import { toast } from "../stores/ui.svelte";

  /**
   * round79（78-11）：「重置成就」—— 二次确认（应用内确认面板，round80 · 79-01）→ 后端清空
   * 已点亮 + 把**计分起点**挪到此刻（从此刻起重新挣）→ 重拉面板 + 提示。
   * 不做撤销（你 2026-10-06 拍板：有二次确认就不叠撤销）。
   */
  async function confirmResetAchievements() {
    const ok = await confirmDanger({
      body: t("ui.achievements_panel.13"),
      title: t("ui.achievements_panel.14"),
      ok: t("ui.achievements_panel.15"),
      cancel: t("ui.achievements_panel.16"),
    });
    if (!ok) return;
    if (await resetAchievements()) toast(t("ui.achievements_panel.17"));
  }

  /** 行序来自后端（已点亮优先 → 时间倒序）：**同名分组可能不相邻** —— 按名字收进 Map
   *  （保持首次出现顺序）。6b 复核（P0）：按相邻切段会让同分类出现两段同名 key，
   *  Svelte 5 keyed each 直接抛 `each_key_duplicate`（真库「同分类一明一暗」必中）。 */
  const groups = $derived.by((): { name: string; rows: AchievementRow[] }[] => {
    const data = achievements.data;
    if (!data) return [];
    const byName = new Map<string, { name: string; rows: AchievementRow[] }>();
    for (const row of data.rows) {
      const group = byName.get(row.group) ?? { name: row.group, rows: [] };
      group.rows.push(row);
      byName.set(row.group, group);
    }
    return [...byName.values()];
  });

  const dateText = (ts: number) => formatDate(ts);
  const pct = (row: AchievementRow) =>
    row.target > 0 ? Math.min(100, Math.round((Math.min(row.progress, row.target) / row.target) * 100)) : 0;

</script>


{#if achievements.open}
  <!-- round96：层外壳（遮罩 / inert / 焦点 / z）由 `PanelHost` 统一给；这里只画面板本体 -->
  <div
    class="overlay-panel narrow ach-panel"
    role="dialog"
    aria-modal="true"
    aria-label={t("ui.achievements_panel.02")}
  >
    <header class="panel-head">
      <h2 class="title">{t("ui.achievements_panel.03")}</h2>
      <span class="scope">{t("ui.achievements_panel.04", { unlocked: achievements.data?.unlocked ?? 0, total: achievements.data?.total ?? 0 })}</span>
      <button class="close" type="button" onclick={closeAchievements} title={t("ui.achievements_panel.05")}><Icon name="close" size={16} /></button>
    </header>

    <div class="body" use:scrollableRegion={{ label: t("ui.achievements_panel.01") }}>
      {#if achievements.loading && !achievements.data}
        <p class="state">{t("ui.achievements_panel.06")}</p>
      {:else if achievements.failed}
        <!-- round78（3.1b₂ · 栈-10）：失败态要有「重试」 -->
        <p class="state">
          {t("ui.achievements_panel.07")}
          <button type="button" class="retry" onclick={() => void loadAchievements()}>{t("ui.common.01")}</button>
        </p>
      {:else if achievements.data && achievements.data.unlocked === 0}
        <p class="state">{t("ui.achievements_panel.08")}</p>
      {/if}

      {#each groups as group (group.name)}
        <section class="group">
          <h3>{group.name}</h3>
          {#each group.rows as row (row.id)}
            <article class="ach {row.unlocked ? '' : 'locked'}">
              <span class="medal" aria-hidden="true">{#if row.unlocked}<Icon name="medal" size={16} />{:else}<Icon name="lock" size={16} />{/if}</span>
              <div class="text">
                <div class="line">
                  <strong class="name">{row.name}</strong>
                  {#if row.tier > 0}
                    <span class="tier" title={row.tier === 2 ? t("ui.achievements_panel.09") : t("ui.achievements_panel.10")}>
                      {row.tier === 2 ? "★★" : "★"}
                    </span>
                  {/if}
                  {#if achievements.newIds.includes(row.id)}
                    <span class="new">NEW</span>
                  {/if}
                </div>
                <p class="desc">{row.desc}</p>
                {#if !row.unlocked}
                  <p class="cond">{row.cond}</p>
                {/if}
                {#if !row.unlocked && row.target > 0}
                  <div class="progress-row">
                    <div
                      class="progress"
                      role="progressbar"
                      aria-valuemin="0"
                      aria-valuemax={row.target}
                      aria-valuenow={Math.min(row.progress, row.target)}
                    >
                      <div class="bar" style="width: {pct(row)}%"></div>
                    </div>
                    <span class="count">{Math.min(row.progress, row.target)}/{row.target}</span>
                  </div>
                {:else if row.unlocked && row.unlocked_at}
                  <p class="when">{t("ui.achievements_panel.11", { unlocked_at: dateText(row.unlocked_at) })}</p>
                {/if}
              </div>
            </article>
          {/each}
        </section>
      {/each}

      <!-- round79（78-11）：「重置成就」—— 清空已点亮 + 计分起点挪到此刻（二次确认后生效）。
           round85（0.31.0）：唯一版本恒可用 → 不再用 `available` 包一层 -->
      <footer class="foot">
        <button
          type="button"
          class="danger-action reset-ach"
          onclick={() => void confirmResetAchievements()}>{t("ui.achievements_panel.12")}</button
        >
      </footer>
    </div>
  </div>
{/if}

<style>
  .ach-panel {
    /* round78（栈-04）：定位/宽度/最大高交给 `.overlay-panel.narrow`（固定左缘 + 560 档） */
    display: flex;
    flex-direction: column;
    /* round94（验收带回）：「暗章界面最上面一层没有固定」—— 以前这里是 `overflow: auto`，把
       `.overlay-panel` 的 `overflow: hidden` 顶掉了，滚动容器成了**整个面板** → 列表一长，
       标题行（暗章 / 已点亮 N / ✕）跟着滚走，鼠标就没地方关它了。
       现在跟设置 / 统计 / 总览同一个结构：**面板不滚，内容区滚**。 */
    overflow: hidden;
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
    font-variant-numeric: tabular-nums;
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
    /* flex 子项要能缩，否则不会出滚动条（`min-height: 0` 是这条的开关） */
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
  }

  .state {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-body);
  }

  .group h3 {
    margin: 0 0 var(--space-2);
    color: var(--text-secondary);
    font-size: var(--text-label);
    font-weight: 600;
  }

  .ach {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--grid-line);
  }

  .ach:last-child {
    border-bottom: none;
  }

  .ach.locked .name,
  .ach.locked .desc {
    color: var(--text-secondary);
  }

  .medal {
    flex: none;
    width: 22px;
    text-align: center;
    font-size: var(--text-title);
    /* px 行高：固定 22×22 的金章位（排版调研 §3.4 #5 允许固定尺寸控件用 px） */
    line-height: 22px;
  }

  .text {
    min-width: 0;
  }

  .line {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .name {
    font-size: var(--text-body);
  }

  .tier {
    color: var(--medal);
    font-size: var(--text-meta);
  }

  .new {
    padding: 0 var(--space-1);
    border: 1px solid var(--grid-line);
    border-radius: 6px;
    color: var(--text-secondary);
    font-size: var(--text-meta);
  }

  .desc {
    margin: 2px 0 0;
    font-size: var(--text-body);
    line-height: var(--line-body);
  }

  .cond {
    margin: 2px 0 0;
    color: var(--text-secondary);
    font-size: var(--text-meta);
  }

  .progress-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-1);
  }

  .progress {
    width: 180px;
    height: 6px;
    overflow: hidden;
    background: var(--grid-line);
    border-radius: 3px;
  }

  .bar {
    height: 100%;
    background: var(--text-secondary);
  }

  .count {
    color: var(--text-secondary);
    font-size: var(--text-meta);
    font-variant-numeric: tabular-nums;
  }

  .when {
    margin: 2px 0 0;
    color: var(--text-secondary);
    font-size: var(--text-meta);
  }

  /* round79（78-11）：重置成就 —— 面板底部一条分隔线 + 危险色的次要按钮 */
  .foot {
    margin-top: var(--space-2);
    padding-top: var(--space-3);
    border-top: 1px solid var(--grid-line);
  }

  /* 视觉走 `src/lib/styles/actions.css` 的 `.danger-action`（三处危险操作共用一套） */
</style>
