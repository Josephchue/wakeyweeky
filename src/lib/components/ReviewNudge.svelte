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
   * C7（round52）：周复盘提醒 —— **应用内**轻提示（台账 #8：低优先级只给应用内轻提示）。
   *
   * 口径（用户 2026-10-02 评审反馈 #1；`docs/plans/round52-c7-review-mosaic.md` §2.5）：
   * 默认周日 20:00（可在 `⚙` 里改成周日/周一的任意时刻）；时刻起 24 小时内有效；
   * 一周只提一次（后端水位线）；点「打开复盘」或 `✕` 都算看过这一条。
   */
  import { dismissNudge, nudge, openReviewAt } from "../stores/review.svelte";
</script>

{#if nudge.show}
  <div class="nudge" class:hidden>
    <button
      class="open"
      type="button"
      title={t("ui.review_nudge.01")}
      onclick={() => openReviewAt(nudge.weekStart)}
    >
      {t("ui.review_nudge.02")}
    </button>
    <button class="close" type="button" title={t("ui.review_nudge.03")} onclick={dismissNudge}><Icon name="close" size={16} /></button>
  </div>
{/if}

<style>
  /* 与 `SanityBar` 同一套：`flex: 1 0 100%` → 在 `.head` 里独占一行 */
  .nudge {
    display: flex;
    flex: 1 0 100%;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    padding: 1px var(--space-2);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    font-size: var(--text-body);
    line-height: var(--line-body);
  }

  .open {
    flex: 1;
    min-width: 0;
    padding: 0;
    border: none;
    background: none;
    color: var(--text-primary);
    font: inherit;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }

  .close {
    flex: none;
    padding: 0 var(--space-1);
    border: none;
    background: none;
    color: var(--text-secondary);
    font-size: var(--text-body);
    cursor: pointer;
  }
  /* round77（3.1b）：让位（同 SanityBar） */
  .hidden {
    display: none;
  }
</style>
