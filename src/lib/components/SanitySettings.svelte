<script lang="ts">
  import { t } from "../i18n/i18n.svelte";
  import Icon from "../icons/Icon.svelte";
  import { closeSettingsPanel, openSettingsPanel, settingsPanel } from "../stores/ui.svelte";

  /**
   * round96：**顶栏齿轮 = 触发器**（面板本体搬到 `SettingsPanel.svelte`，挂在 App 根的 `PanelHost`）。
   *
   * 为什么拆：以前整个组件（齿轮 + 覆盖面板）挂在 `main.shell` 里的 Timeline 顶栏 →
   * 面板开着时给 `main.shell` 加 `inert` 会把**栈顶自己**冻住（round95 复核 A-1）。
   * 触发器留在原位；面板与层外壳由 App 根统一管理。
   */
</script>

<div class="wrap">
  <button
    type="button"
    class="sanity-gear"
    class:on={settingsPanel.open}
    title={t("ui.sanity_settings.21")}
    aria-expanded={settingsPanel.open}
    onclick={(e) =>
      settingsPanel.open ? closeSettingsPanel() : openSettingsPanel({ from: e.currentTarget })}
    ><Icon name="settings" size={16} /></button
  >
</div>

<style>
  .wrap {
    position: relative;
    display: flex;
    flex: none;
    margin-left: var(--space-2);
  }

  /* 与跳周按钮同一套外观 */
  .sanity-gear {
    padding: 0 var(--space-2);
    background: none;
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-body);
    line-height: var(--line-body);
    cursor: pointer;
  }

  .sanity-gear:hover,
  .sanity-gear.on {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
