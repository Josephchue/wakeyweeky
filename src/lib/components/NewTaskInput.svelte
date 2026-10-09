<script lang="ts">
  import Icon from "../icons/Icon.svelte";
  import { t } from "../i18n/i18n.svelte";
  import type { Task } from "../ipc/types";
  import { addTask } from "../stores/tasks.svelte";

  let {
    category = null,
    onAdded,
  }: {
    /** round47：当前视图的分类 —— 在「只看学习」里新建 = 直接归到学习；`null` = 不设分类 */
    category?: string | null;
    /** 建好了通知一声（Backlog 拿它决定要不要说「已加入未分类」） */
    onAdded?: (task: Task) => void;
  } = $props();

  let title = $state("");

  async function submit() {
    const value = title.trim();
    if (!value) return;
    try {
      const task = await addTask(value, category);
      title = "";
      onAdded?.(task);
    } catch {
      // ipc 层已弹 Toast，这里不重复提示，也不清空输入框
    }
  }

  /**
   * round79（78-03）：**打字框要吃 `Esc`** —— 清空草稿 + 交出焦点（= 退出输入状态）。
   * 为什么归这里管：round78 把 `Timeline` 的 `inField` 收窄成「打字类输入」后，`Esc` 在输入框里
   * 交给输入框自己（这是设计）—— 而本输入框没有行为，于是「按 Esc 什么都不发生」（你 2026-10-06 报的）。
   * 口径照仓库两条先例（`Backlog` 改名 / `TaskBlock` 改名都是「Esc = 退出编辑」）；新建没有原值 → 清空。
   */
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation(); // 别让面板栈/全局 Esc 把它当成「关面板」
    title = "";
    (e.currentTarget as HTMLInputElement).blur();
  }
</script>

<form
  class="new-task"
  onsubmit={(e) => {
    e.preventDefault();
    void submit();
  }}
>
  <input
    class="field"
    bind:value={title}
    placeholder={t("ui.new_task_input.01")}
    aria-label={t("ui.new_task_input.02")}
    maxlength="200"
    onkeydown={onKeydown}
  />
  <button class="add" type="submit" title={t("ui.new_task_input.03")}><Icon name="plus" size={16} /></button>
</form>

<style>
  .new-task {
    display: flex;
    gap: var(--space-2);
  }

  .field {
    flex: 1;
    min-width: 0;
    padding: var(--space-1) var(--space-2);
    background: var(--card);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-family: var(--font-ui);
    font-size: var(--text-title);
  }

  .field:focus {
    outline: 1px solid var(--accent);
    outline-offset: 0;
  }

  .add {
    width: 28px;
    background: var(--card);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    color: var(--accent);
    font-size: var(--text-title);
    line-height: 1;
    cursor: pointer;
  }
</style>
