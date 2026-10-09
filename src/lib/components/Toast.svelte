<script lang="ts">
  import { dismissToast, toasts } from "../stores/ui.svelte";
</script>

<div class="toast-layer">
  {#each toasts as t (t.id)}
    <div class="toast">
      <span>{t.msg}</span>
      {#if t.action}
        <!-- round40：能撤销的动作（删除 / 解链 / 归档取出）—— 按钮自己接指针，整条提示不挡底下（你之前投诉过挡住右下角） -->
        <button
          type="button"
          class="act"
          onclick={() => {
            t.action?.run();
            dismissToast(t.id);
          }}>{t.action.label}</button
        >
      {/if}
    </div>
  {/each}
</div>

<style>
  .toast-layer {
    position: fixed;
    pointer-events: none; /* 用户实测：提示挡住右下角的操作 ✗ */
    right: var(--space-4);
    bottom: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    z-index: 100;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    max-width: 360px;
    padding: var(--space-2) var(--space-3);
    background: var(--card);
    border: 1px solid var(--warn);
    border-left-width: 3px;
    border-radius: var(--radius-lg); /* round77：面板/浮层走圆角阶梯的 lg（Fluent：浮层 8px） */
    color: var(--text-primary);
    box-shadow: var(--shadow-pop);
    overflow-wrap: anywhere;
  }

  /* 只有按钮接指针：提示本体仍不挡下面（见上） */
  /* round77（3.1b）：命中区抬到 ≥32 高（旧值 ≈20px）；左右内边距不变，看起来还是一个文字按钮 */
  .act {
    display: inline-flex;
    align-items: center;
    flex: none;
    min-height: 32px;
    padding: 0 var(--space-2);
    font: inherit;
    font-weight: 600;
    color: var(--accent);
    background: none;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    pointer-events: auto;
    cursor: pointer;
  }

  .act:hover {
    color: var(--card);
    background: var(--accent);
  }
</style>
