<script lang="ts">
  import { t } from "../i18n/i18n.svelte";
  import { blocks } from "../stores/blocks.svelte";
  import {
    armOwnPlacement,
    closeDrift,
    confirmDrift,
    drift,
    labelFor,
  } from "../stores/drift.svelte";
  import { toast } from "../stores/ui.svelte";
  import { featureOn } from "../stores/settings.svelte";

  // 边界：卡片开着的时候那个块可能被删掉（或被刷新后不复存在）→ 自动收起，避免指向幽灵
  $effect(() => {
    const id = drift.value?.blockId;
    if (id && !blocks.some((b) => b.id === id)) closeDrift();
  });

  async function onPick(startSec: number) {
    const label = labelFor(startSec);
    try {
      await confirmDrift(startSec);
      toast(t("ui.drift_card.01", { label: label }));
    } catch {
      // ipc 层已弹 Toast
    }
  }
</script>

{#if drift.value && featureOn("drift_enabled")}
  <section class="drift">
    <header class="head">
      <span class="tag">{t("ui.drift_card.02")}</span>
      {#if drift.value.existingStartAt !== null}
        <span class="who">
          {t("ui.drift_card.03", { taskTitle: drift.value.taskTitle, existingStartAt: labelFor(drift.value.existingStartAt) })}
        </span>
      {:else}
        <span class="who">{t("ui.drift_card.04", { taskTitle: drift.value.taskTitle })}</span>
      {/if}
    </header>

    <div class="slots">
      {#each drift.value.suggestions as startSec (startSec)}
        <button type="button" class="slot" onclick={() => onPick(startSec)}>
          {labelFor(startSec)}
        </button>
      {/each}
      {#if drift.value.suggestions.length === 0}
        <span class="empty">{t("ui.drift_card.05")}</span>
      {/if}
    </div>

    <div class="foot">
      <!-- round49（用户 2026-10-03）：都不合适时自己挪 —— 预览块跟着鼠标走，左键放下、Esc 取消 -->
      <button
        type="button"
        class="own"
        title={t("ui.drift_card.06")}
        onclick={() => armOwnPlacement()}>{t("ui.drift_card.07")}</button
      >
      <button type="button" class="dismiss" onclick={closeDrift}>{t("ui.drift_card.08")}</button>
    </div>
  </section>
{/if}

<style>
  .drift {
    position: fixed;
    /* round77（3.1b）：浮层位置口径 —— **漂流卡左下、Toast 右下**（布局重审 L31/L8：不许同角互压）。
       以前是「水平居中贴底」，窄窗（715）时会压住 Backlog 的下半部分。 */
    left: var(--space-4);
    bottom: var(--space-4);
    right: auto;
    z-index: 90; /* 低于 Toast(100)，保证提示不被盖住 */
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-width: min(420px, calc(100vw - 2 * var(--space-4)));
    padding: var(--space-3);
    background: var(--card);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    box-shadow: var(--shadow-drop);
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .tag {
    flex: none;
    padding: 0 var(--space-1);
    background: var(--accent);
    border-radius: var(--radius);
    color: var(--on-accent);
    font-size: var(--text-meta);
    letter-spacing: var(--label-tracking);
  }

  .who {
    font-size: var(--text-body);
    color: var(--text-primary);
  }

  .slots {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .slot {
    padding: var(--space-1) var(--space-3);
    background: var(--bg);
    border: 1px dashed var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--text-meta);
    cursor: pointer;
  }

  .slot:hover {
    border-color: var(--accent);
    border-style: solid;
  }

  .empty {
    font-size: var(--text-body);
    color: var(--text-secondary);
  }

  /* round49：「自己安排」与「不用了」并排（前者是主动作，后者是退出） */
  .foot {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .own {
    padding: 2px var(--space-2);
    font: inherit;
    color: var(--accent);
    background: none;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .dismiss {
    align-self: flex-end;
    padding: 0;
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: var(--text-meta);
    cursor: pointer;
  }

  .dismiss:hover {
    color: var(--text-primary);
  }
</style>
