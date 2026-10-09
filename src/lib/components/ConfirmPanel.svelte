<script lang="ts">
  import { focusTrap } from "../utils/modal";
  import { confirmState, settleConfirm } from "../stores/confirm.svelte";

  /**
   * round80（79-01）：**危险确认面板**（应用内 alertdialog）—— `confirmDanger()` 的画布。
   *
   * 口径（`docs/visual/round80-PassA-子题地图.md` §1）：
   * - 初始焦点落在**取消**上（DOM 顺序：取消在前 → `focusTrap` 聚焦第一个可聚焦项；APG：
   *   不可逆流程聚焦「最不破坏」的动作）→ `Enter` 就是取消，**不会**误触发破坏动作；
   * - `Esc` / 点遮罩 / 「取消」都取消 —— `Esc` 走面板栈（`Timeline` 的全局处理 → `closeTopPanel()` → 本面板关闭）；
   * - 危险按钮走 `.danger-action`（与本仓三处重置/恢复同一套视觉）；
   * - `role="alertdialog"` + `aria-modal` + labelledby/describedby（APG《Alert and Message Dialogs》）。
   */
</script>

{#if confirmState.open && confirmState.opts}
  <!-- 遮罩：点一下 = 取消（与前两个面板同一套；不进 Tab 顺序 —— 键盘走 Esc / 取消按钮） -->
  <button
    type="button"
    class="overlay-backdrop confirm-backdrop"
    tabindex="-1"
    aria-label={confirmState.opts.cancel}
    onclick={() => settleConfirm(false)}
  ></button>
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role（`section role="alertdialog"` 是 ARIA 认可写法，Svelte 的检查器偏严 —— 与 SanitySettings 同一套口径） -->
  <section
    class="overlay-panel narrow confirm-panel"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="confirm-title"
    aria-describedby="confirm-body"
    use:focusTrap={{ active: true }}
    data-confirm-panel
  >
    <h3 id="confirm-title">{confirmState.opts.title}</h3>
    <p id="confirm-body">{confirmState.opts.body}</p>
    <div class="confirm-btns">
      <!-- 取消在左（GNOME HIG：cancel before affirmative）、且是初始焦点 -->
      <button type="button" class="confirm-cancel" onclick={() => settleConfirm(false)}
        >{confirmState.opts.cancel}</button
      >
      <button
        type="button"
        class="danger-action confirm-danger"
        onclick={() => settleConfirm(true)}>{confirmState.opts.ok}</button
      >
    </div>
  </section>
{/if}

<style>
  /* modal 层盖在所有覆盖面板之上（overlay.css 里给 `.modal` 的 z-index 比同级/子层高） */
  .confirm-backdrop {
    z-index: 48;
  }

  .overlay-panel.confirm-panel {
    --overlay-w: min(420px, calc(100vw - 32px));
    z-index: 49;
    padding: var(--space-3);
    background: var(--card);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-pop);
  }

  .confirm-panel h3 {
    margin: 0 0 var(--space-1);
    font-size: var(--text-title);
    font-weight: 600;
    color: var(--text-primary);
  }

  .confirm-panel p {
    margin: 0 0 var(--space-3);
    font-size: var(--text-body);
    line-height: var(--line-body);
    color: var(--text-secondary);
  }

  .confirm-btns {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .confirm-cancel {
    flex: none;
    padding: 0 var(--space-2);
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-meta);
    line-height: var(--line-body);
    white-space: nowrap;
    cursor: pointer;
  }

  .confirm-cancel:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
