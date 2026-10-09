<script lang="ts">
  /**
   * round77（3.1b）：提示条**同屏最多一条**（橙 > 绿 > 渐进）—— 优先级由 `Timeline` 算，
   * 这里只负责「让位」：`hidden` 时用 `display: none` **藏起来但保留 DOM 节点**
   * （不用 `{#if}` 包：包起来会让节点被销毁重建，测试里「先拿住节点再点」的写法就断了）。
   */
  let { hidden = false }: { hidden?: boolean } = $props();

  import { t } from "../i18n/i18n.svelte";
  import Icon from "../icons/Icon.svelte";
  /**
   * C6（round44）：顶部那一句「偏重」预警。
   *
   * 只在**正在看的那一周里有超载日**时出现（不是每天都占一行 —— NN/g 的指示器/警报之分：
   * 常驻信息交给日头下那根小条，警报要稀有才有人看）。
   * 位置由外层 `.head`（`flex-wrap`）决定：这里 `flex: 1 0 100%` → 独占一行。
   *
   * C7（round52）：整条可点 → 开复盘并聚焦**第一个超载天**（R46 的入口之一）。
   */
  import { openReview } from "../stores/review.svelte";
  import { overloadedDays, sanity } from "../stores/sanity.svelte";
  import { sanityBar } from "../stores/sanity.svelte";
  import { week } from "../stores/week.svelte";
  import { formatDuration } from "../utils/week";
  import { note } from "../stores/achievements.svelte";

  /** 周几（周一 = 0）→ 两个字；日头那边是 `09-28 Mon`，这里说人话
   *  round74（3.0b₂）：`$derived` —— 切语言后跟着变 */
  const WEEK_CN = $derived([t("ui.sanity_bar.01"), t("ui.sanity_bar.02"), t("ui.sanity_bar.03"), t("ui.sanity_bar.04"), t("ui.sanity_bar.05"), t("ui.sanity_bar.06"), t("ui.sanity_bar.07")]);
  const label = (dayStart: number) => WEEK_CN[(new Date(dayStart * 1000).getDay() + 6) % 7];

  const bad = $derived(overloadedDays());

  const text = $derived.by(() => {
    if (!sanity.enabled || bad.length === 0) return "";
    const budget = formatDuration(sanity.budgetMinutes * 60);
    if (bad.length === 1) {
      const d = bad[0];
      return t("ui.sanity_bar.08", { day_start: label(d.day_start), minutes: formatDuration(d.minutes * 60), budget: budget, blocks: d.blocks });
    }
    const parts = bad.map((d) => t("ui.sanity_bar.09", { day_start: label(d.day_start), minutes: formatDuration(d.minutes * 60) }));
    return t("ui.sanity_bar.10", { join: parts.join(" · "), budget: budget });
  });

  // round68（19.1）：第一次看到超载 → 暗章信号（一次会话只报一次；后端本身幂等）
  let overloadNoted = false;
  $effect(() => {
    if (text && !overloadNoted) {
      overloadNoted = true;
      void note("overload");
    }
  });
</script>

{#if text && sanityBar.dismissedWeek !== week.from}
  <!-- round77（3.1b）：橙条这一档**补上了关闭**（以前只有绿条能关，两套不一致 —— 布局重审 L03）。
       语义（你 2026-10-05 拍）：**会话内关闭** —— 不写库；换周或重开应用时按需再出现。
       关掉**不影响真实超载状态**：日头下的耗能小条、总览、理智值口径照旧。 -->
  <div class="sanity" class:hidden role="status">
    <button
      class="sanity-main"
      type="button"
      title={t("ui.sanity_bar.11", { text: text })}
      onclick={() => openReview(bad[0]?.day_start)}><Icon name="triangle-alert" size={16} />{text}</button
    >
    <button
      class="sanity-dismiss"
      type="button"
      title={t("ui.sanity_bar.12")}
      aria-label={t("ui.sanity_bar.12")}
      onclick={() => (sanityBar.dismissedWeek = week.from)}
      ><Icon name="close" size={16} /></button
    >
  </div>
{/if}

<style>
  /* flex: 1 0 100% → 在 `.head` 里独占一行（与 round44 的换行修复同一套机制） */
  .sanity .sanity-main {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    flex: 1;
    min-width: 0;
    padding: 0;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .sanity .sanity-dismiss {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 24px;
    height: 24px;
    padding: 0;
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .sanity .sanity-dismiss:hover {
    color: var(--text-primary);
  }

  .sanity {
    display: flex;
    flex: 1 0 100%;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    padding: 1px var(--space-2);
    background: color-mix(in srgb, var(--warn) 10%, transparent);
    border: 1px solid var(--warn);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-body);
    line-height: var(--line-body);
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis; /* 窄窗口省略；悬停看全文（title） */
    cursor: pointer;
  }
  /* round77（3.1b）：让位给优先级更高的条 —— 藏起来但不动 DOM 节点 */
  .hidden {
    display: none;
  }
</style>
