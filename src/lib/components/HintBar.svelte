<script lang="ts">
  /**
   * round77（3.1b）：提示条**同屏最多一条**（橙 > 绿 > 渐进）—— 优先级由 `Timeline` 算，
   * 这里只负责「让位」：`hidden` 时用 `display: none` **藏起来但保留 DOM 节点**
   * （不用 `{#if}` 包：包起来会让节点被销毁重建，测试里「先拿住节点再点」的写法就断了）。
   */
  let { hidden = false }: { hidden?: boolean } = $props();

  import { t } from "../i18n/i18n.svelte";
  /**
   * round64（C10）：引导条 —— 渐进提示与模板建议共用**一个槽**（一次一条）。
   *
   * 样式照 `ReviewNudge`（`flex: 1 0 100%` → 在 `.head` 里独占一行）。
   * 两个「关掉」都写设置（提示总开关 / 建议开关），设置面板里能再开 —— 不是只藏这一条。
   */
  import {
    disableHints,
    dismissHint,
    guide,
    openSuggestedTemplate,
    stopSuggestions,
  } from "../stores/guide.svelte";
</script>

{#if guide.hint}
  <div class="guide-bar" class:hidden data-guide="hint">
    <span class="text">{guide.hint.text}</span>
    <button type="button" class="ok dismiss" title={t("ui.hint_bar.01")} onclick={dismissHint}>{t("ui.hint_bar.06")}</button>
    <button
      type="button"
      class="off"
      title={t("ui.hint_bar.02")}
      onclick={() => void disableHints()}>{t("ui.hint_bar.07")}</button
    >
  </div>
{:else if guide.suggestion !== null}
  <div class="guide-bar suggest" class:hidden data-guide="suggest">
    <span class="text">{t("ui.hint_bar.03")}</span>
    <button
      type="button"
      class="ok suggest-open"
      title={t("ui.hint_bar.04")}
      onclick={() => void openSuggestedTemplate()}>{t("ui.hint_bar.08")}</button
    >
    <button
      type="button"
      class="off"
      title={t("ui.hint_bar.05")}
      onclick={() => void stopSuggestions()}>{t("ui.hint_bar.09")}</button
    >
  </div>
{/if}

<style>
  /* 与 `SanityBar` / `ReviewNudge` 同一套：在 `.head` 里独占一行 */
  .guide-bar {
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

  .text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ok,
  .off {
    flex: none;
    padding: 0 var(--space-1);
    border: none;
    background: none;
    font: inherit;
    font-size: var(--text-body);
    white-space: nowrap;
    cursor: pointer;
  }

  .ok {
    color: var(--text-primary);
  }

  .ok:hover {
    color: var(--accent);
  }

  .off {
    color: var(--text-secondary);
  }

  .off:hover {
    color: var(--text-primary);
  }
  /* round77（3.1b）：让位（同 SanityBar） */
  .hidden {
    display: none;
  }
</style>
