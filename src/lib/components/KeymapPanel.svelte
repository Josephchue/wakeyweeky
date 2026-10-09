<script lang="ts">
  /**
   * round82（3.1c₂ · `绑-01…20` / 案 A）：**改键位面板** —— 设置里的子层（`栈-01`：叠在设置上，`Esc` 只关它）。
   *
   * 形态照 Minecraft「选项 → 控制」：**一行一个动作 + 一枚键帽**；点键帽 → 进入录制 → 按新键落定。
   * 比 MC 多的三样（你拍的 Q21 + 调研 §9）：① 冲突**拒绝保存并指路** ② 行尾「已改 / 恢复默认」
   * ③ `aria-live` 播报（键盘全流程可完成）。「锁定键不能改」这类解释**只进说明页**（面板里只留一句操作提示）。
   *
   * 录制状态机（C1 边界表）在本组件内：window **capture** 拦 `keydown`/`keyup` + `preventDefault`/`stopPropagation`
   * （先在全局处理器之前吃掉 —— 录制时 `T` 不该跳回本周、`Esc` 不该关面板）；修饰键单独按下只更新实时预览。
   */
  import Icon from "../icons/Icon.svelte";
  import KeyTable from "./KeyTable.svelte";
  import { t } from "../i18n/i18n.svelte";
  import { closeKeymapPanel, keymapPanel } from "../stores/ui.svelte";
  import {
    allBindings,
    bindingFor,
    displayFor,
    isModified,
    resetAllBindings,
    resetBinding,
    saveBinding,
  } from "../stores/keymap.svelte";
  import {
    COMMANDS,
    findConflict,
    formatCombo,
    heldModifiers,
    lockedReason,
    normalizeEvent,
    type CommandId,
    type CommandScope,
    type LockedReason,
  } from "../utils/keybindings";
  import { focusTrap, scrollableRegion } from "../utils/modal";

  const open = $derived(keymapPanel.open);

  let recordingId = $state<CommandId | null>(null);
  /** 只按了修饰键时的实时预览（`Ctrl+Shift`） */
  let live = $state("");
  /** 成功后的软提示（跨层撞键） */
  let note = $state("");
  let error = $state("");
  let busy = $state(false);

  const scopeLabel = (s: CommandScope): string =>
    s === "global" ? t("ui.keymap_panel.02") : t("ui.keymap_panel.03");

  const lockedMsg = (r: LockedReason): string =>
    r === "system"
      ? t("ui.keymap_panel.10")
      : r === "window"
        ? t("ui.keymap_panel.11")
        : t("ui.keymap_panel.12");

  function startRecording(id: CommandId): void {
    if (busy) return;
    recordingId = id;
    live = "";
    note = "";
    error = "";
  }

  function stopRecording(): void {
    recordingId = null;
    live = "";
  }

  async function doReset(id: CommandId): Promise<void> {
    if (busy) return;
    error = "";
    note = "";
    busy = true;
    const ok = await resetBinding(id);
    busy = false;
    if (!ok) error = t("ui.keymap_panel.20");
  }

  async function doResetAll(): Promise<void> {
    if (busy) return;
    error = "";
    note = "";
    busy = true;
    const ok = await resetAllBindings();
    busy = false;
    if (!ok) error = t("ui.keymap_panel.20");
  }

  // C1：录制期间在 window capture 阶段吃掉键盘（先于所有全局处理器；面板关闭 / 录制结束自动摘掉）
  $effect(() => {
    if (!open || recordingId === null) return;
    const id = recordingId;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return; // 长按不刷屏
      if (e.key === "Escape") {
        stopRecording(); // 只取消录制 —— 面板不关（C1 边界表）
        return;
      }
      const combo = normalizeEvent(e);
      if (combo === null) {
        live = heldModifiers(e); // 只按了修饰键 / 死键 / IME —— 还在录
        return;
      }
      live = "";
      const locked = lockedReason(combo);
      if (locked && combo !== bindingFor(id)) {
        // 自己当前的值可以「录回」（双角色默认：如 `s` = 块内往下 + 未选中时统计）
        error = lockedMsg(locked);
        return;
      }
      const def = COMMANDS.find((c) => c.id === id);
      if (!def) return;
      const conflict = findConflict(combo, def.scope, allBindings(), id);
      if (conflict && conflict.kind === "hard") {
        const other = COMMANDS.find((c) => c.id === conflict.id);
        error = t("ui.keymap_panel.13", {
          combo: formatCombo(combo),
          label: other ? t(other.label) : String(conflict.id),
        });
        return;
      }
      const soft = conflict ? COMMANDS.find((c) => c.id === conflict.id) : null;
      busy = true;
      void saveBinding(id, combo).then((ok) => {
        busy = false;
        if (!ok) {
          error = t("ui.keymap_panel.20");
        } else {
          error = "";
          note = soft
            ? t("ui.keymap_panel.14", {
                combo: formatCombo(combo),
                label: t(soft.label),
                scope: scopeLabel(soft.scope),
              })
            : "";
        }
        stopRecording();
      });
    };
    const onKeyUp = () => {
      live = ""; // 松开修饰键：把「已按住…」清掉（主键落定才算数）
    };
    const onBlur = () => {
      live = ""; // Alt+Tab 走了：防「卡住的 Ctrl」
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  });
</script>

{#if open}
  <button
    class="overlay-backdrop"
    type="button"
    tabindex="-1"
    aria-label={t("ui.keymap_panel.01")}
    onclick={closeKeymapPanel}
  ></button>
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role（`section role="dialog"` 是 ARIA 认可写法，Svelte 的检查器偏严） -->
  <section
    class="overlay-panel wide keymap-panel"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    aria-label={t("ui.keymap_panel.01")}
    use:focusTrap={{ active: open }}
    use:scrollableRegion={{ label: t("ui.keymap_panel.01") }}
  >
    <header class="panel-head">
      <h2 class="title">{t("ui.keymap_panel.01")}</h2>
      <button class="close" type="button" title={t("ui.keys_panel.01")} onclick={closeKeymapPanel}
        ><Icon name="close" size={16} /></button
      >
    </header>

    <div class="body">
      <!-- round83（§8.2）：合并后的第一段 = **全部键位（只读总表）** ——
           `?` 是「查键位」的入口，验收的收口判据要求它**直达总表不退化**，所以表在最上；
           下面才是可改键位（你 2026-10-08 拍的案 A：一个入口 + 面板内附总表）。
           为什么不在表里剔掉命令行：表要能看到**用户改过的键**（`round82 ⑤` 的「表同源」就是断这个）。 -->
      <h3 class="sec">{t("ui.keymap_panel.30")}</h3>
      <KeyTable />
      <p class="hint">{t("ui.keys_panel.03")}</p>

      <hr class="sep" />

      <!-- 播报 + 软提示共用一行：录制中优先显示「请按新键 / 已按住…」 -->
      <p class="live" role="status" aria-live="polite">
        {#if recordingId}
          {live ? t("ui.keymap_panel.09", { mods: live }) : t("ui.keymap_panel.08")}
        {:else}{note}{/if}
      </p>
      {#if error}
        <p class="err" role="alert">{error}</p>
      {/if}

      <table class="rows">
        <tbody>
          {#each COMMANDS as cmd (cmd.id)}
            <tr class:recording={recordingId === cmd.id} class:modified={isModified(cmd.id)}>
              <td class="nm">
                {t(cmd.label)}
                <span class="sc">{scopeLabel(cmd.scope)}</span>
              </td>
              <td class="acts">
                {#if isModified(cmd.id)}
                  <span class="done">{t("ui.keymap_panel.04")}</span>
                  <button
                    type="button"
                    class="reset"
                    disabled={busy}
                    title={t("ui.keymap_panel.17", { label: t(cmd.label) })}
                    onclick={() => void doReset(cmd.id)}>{t("ui.keymap_panel.05")}</button
                  >
                {/if}
              </td>
              <td class="kb">
                <button
                  type="button"
                  class="kbd"
                  class:on={recordingId === cmd.id}
                  disabled={busy}
                  title={t("ui.keymap_panel.19")}
                  aria-label={t("ui.keymap_panel.16", { label: t(cmd.label) })}
                  onclick={() => startRecording(cmd.id)}>{displayFor(cmd.id)}</button
                >
              </td>
            </tr>
          {/each}
        </tbody>
      </table>

      <p class="hint">{t("ui.keymap_panel.07")}</p>
      <p class="foot">
        <button type="button" class="reset-all" disabled={busy} onclick={() => void doResetAll()}
          >{t("ui.keymap_panel.06")}</button
        >
      </p>
    </div>
  </section>
{/if}

<style>
  .keymap-panel {
    display: flex;
    flex-direction: column;
    overflow: auto;
    background: var(--card);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-pop);
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

  .close {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    margin-left: auto;
    padding: 0;
    background: none;
    border: 1px solid var(--grid-line);
    border-radius: var(--radius);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .close:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
  }

  /* 录制播报 / 软提示：固定一行高，避免下面的表跳动 */
  .live {
    margin: 0;
    min-height: var(--line-body);
    color: var(--text-secondary);
    font-size: var(--text-meta);
  }

  .err {
    margin: 0;
    color: var(--danger, #b3261e);
    font-size: var(--text-meta);
  }

  .rows {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-body);
  }

  .rows tr {
    border-bottom: 1px solid var(--grid-line);
  }

  .rows tr:last-child {
    border-bottom: none;
  }

  .rows td {
    padding: 3px 0;
    vertical-align: middle;
  }

  .rows tr.recording {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }

  .nm {
    color: var(--text-primary);
  }

  .sc {
    margin-left: var(--space-2);
    color: var(--text-secondary);
    font-size: var(--text-meta);
  }

  .acts {
    text-align: right;
    white-space: nowrap;
  }

  .done {
    margin-right: var(--space-2);
    color: var(--accent);
    font-size: var(--text-meta);
  }

  .reset,
  .reset-all {
    padding: 0 var(--space-2);
    background: none;
    border: 1px solid var(--grid-line);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--text-meta);
    line-height: var(--control-height);
    cursor: pointer;
  }

  .reset:hover,
  .reset-all:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* 键帽：与 `KeyTable` 的 `.kbd` 同一套观感；统一靠最右（Q21） */
  .kb {
    width: 1%;
    text-align: right;
    white-space: nowrap;
    padding-left: var(--space-3);
  }

  .kbd {
    min-width: 52px;
    padding: 0 var(--space-2);
    background: var(--bg);
    border: 1px solid var(--text-secondary);
    border-radius: 3px;
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-meta);
    line-height: var(--control-height);
    cursor: pointer;
  }

  .kbd:hover {
    border-color: var(--accent);
  }

  .kbd.on {
    border-color: var(--accent);
    color: var(--accent);
  }

  .hint {
    margin: var(--space-1) 0 0;
    color: var(--text-secondary);
    font-size: var(--text-meta);
  }

  .foot {
    margin: 0;
  }

  /* round83（§8.2）：合并后的两个分区标题 / 分隔线（颜色 / 间距都走 token） */
  .sec {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-meta);
    font-weight: 600;
    letter-spacing: var(--label-tracking);
  }

  .sep {
    width: 100%;
    margin: 0;
    border: 0;
    border-top: 1px solid var(--grid-line);
  }
</style>
