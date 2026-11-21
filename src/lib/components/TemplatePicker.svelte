<script lang="ts">
  import { t } from "../i18n/i18n.svelte";
  import Icon from "../icons/Icon.svelte";
  import { closePicker, openPicker, templates } from "../stores/templates.svelte";

  /**
   * round96：**顶栏「模板」= 触发器**（面板本体搬到 `TemplatePanel.svelte`，挂在 App 根的 `PanelHost`）。
   *
   * 为什么拆：以前整个组件（按钮 + 贴按钮的弹层）挂在 `main.shell` 里的 Timeline 顶栏 →
   * 面板开着时给 `main.shell` 加 `inert` 会把**栈顶自己**冻住（round95 复核 A-1）。
   */
</script>

<div class="tpl-wrap">
  <button
    type="button"
    class="templates-open"
    class:on={templates.open}
    aria-expanded={templates.open}
    title={t("ui.template_picker.01")}
    onclick={(e) =>
      templates.open ? closePicker() : void openPicker(undefined, { from: e.currentTarget })}
    ><Icon name="file-text" size={16} />{t("ui.template_picker.16")}</button
  >
</div>

<style>
  .tpl-wrap {
    position: relative;
    display: flex;
    flex: none;
  }

  /* 与跳周按钮 / ⚙ 同一套外观 */
  .templates-open {
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

  .templates-open:hover,
  .templates-open.on {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
