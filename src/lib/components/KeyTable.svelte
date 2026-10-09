<script lang="ts">
  /**
   * round78（3.1b₂ · 设-08 / `键-03`）：**键位表的唯一渲染件** ——
   * 设置里那节与 `?` 快捷键总表面板共用它（内容只有一份：`utils/keyboard-help.ts` 的 `KEY_HELP`）。
   *
   * 为什么单独抽出来：以前表写死在设置组件里 → 「换个地方再放一张表」就会变成抄一份、以后必然漂。
   * `KEY_HELP` 的 `rows[0]` 有的是字面键位（`Ctrl+Z`），有的本身是文案键（`msg.keyboard_help.03` =
   * 「点块」）—— 两种都在这里过 `t()`/直出，别再让 `msg.*` 原样上屏。
   */
  import { t, type MsgKey } from "../i18n/i18n.svelte";
  import { displayFor } from "../stores/keymap.svelte";
  import { KEY_HELP, type KeyRef } from "../utils/keyboard-help";

  /** 一项的显示串：字面串直出（文案键过 `t()`）；命令引用取**用户当前生效的键**（C5 同源） */
  const keysText = (keys: string | KeyRef): string => {
    if (typeof keys === "string") return keys.startsWith("msg.") ? t(keys as MsgKey) : keys;
    if ("cmd" in keys) return displayFor(keys.cmd);
    return keys.cmds.map((id) => displayFor(id)).join(" / ");
  };
</script>

<table class="keys">
  <tbody>
    {#each KEY_HELP as section (section.group)}
      <tr class="grp">
        <td colspan="2">{t(section.group)}</td>
      </tr>
      {#each section.rows as [keys, label], i (section.group + i)}
        <tr>
          <td class="kk"><span class="kbd">{keysText(keys)}</span></td>
          <td>{t(label)}</td>
        </tr>
      {/each}
    {/each}
  </tbody>
</table>

<style>
  /* 与设置里那张表同一套口径（字号 meta / 行高 body / 分组行加粗） */
  .keys {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-meta);
    line-height: var(--line-body);
  }

  .keys .grp td {
    padding-top: var(--space-1);
    color: var(--text-secondary);
    font-weight: 600;
  }

  .keys td {
    vertical-align: top;
  }

  .keys .kk {
    padding-right: var(--space-2);
    white-space: nowrap;
  }

  .keys td:last-child {
    color: var(--text-secondary);
  }

  .kbd {
    padding: 0 var(--space-1);
    background: var(--bg);
    border: 1px solid var(--text-secondary);
    border-radius: 3px;
    color: var(--text-primary);
  }
</style>
