<script lang="ts">
  import { t } from "../i18n/i18n.svelte";
  /**
   * round64（C10）：首次使用免规划 —— 空库第一次打开时的一张卡片（v2 ⑪ 行 12 / 加手批第 80 行）。
   *
   * 只做一件事：把「先只安排今天就好」说清楚（三步），不要求规划整周、不遮界面、不挡操作；
   * 「知道了」写一次设置（内部键 `first_run_seen`）→ 之后不再出现。**用真数据测不到**（你的库非空）
   * → 预览的空库模式 + 单测验（见验收文档）。
   */
  import { onMount } from "svelte";
  import { markFirstRunSeen, shouldShowFirstRun } from "../ipc/templates";
  import { dismissFirstRunAgain, guide } from "../stores/guide.svelte";
  import { requestNewTask } from "../stores/ui.svelte";

  let show = $state(false);

  onMount(() => {
    void (async () => {
      try {
        show = await shouldShowFirstRun();
      } catch {
        /* 读失败就当没有（不挡启动） */
      }
    })();
  });

  async function dismiss() {
    show = false;
    dismissFirstRunAgain(); // round64.1：设置里「重看」的那次也收起来
    // round80（Step 7 复核 教-05）：**卡片的直接动作 = 去写下第一件事** ——
    // 收起后把焦点送进 Backlog 的「添加任务…」输入框（折叠时先展开，由信号实现）。
    // （round78 的 Pass B 以为这是 round64 做过的 —— 实测历史上从来没有，本批补上。）
    requestNewTask();
    try {
      await markFirstRunSeen();
    } catch {
      /* ipc 层已弹 Toast；卡片已经收起，下次启动还会再出现一次 */
    }
  }
</script>

{#if show || guide.firstRunAgain}
  <aside class="first-run" role="note" aria-label={t("ui.first_run.01")}>
    <h3>{t("ui.first_run.02")}</h3>
    <ol>
      <li>{t("ui.first_run.03")}</li>
      <li>{t("ui.first_run.04")}</li>
      <li>{t("ui.first_run.05")}</li>
    </ol>
    <p>{t("ui.first_run.06")}</p>
    <button type="button" class="ok" onclick={() => void dismiss()}>{t("ui.first_run.07")}</button>
  </aside>
{/if}

<style>
  /* 非模态：固定在左下角（不遮中部的时间轴），只占它自己那一块 */
  .first-run {
    position: fixed;
    left: var(--space-4);
    bottom: var(--space-4);
    z-index: 30;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    width: 300px;
    padding: var(--space-3);
    background: var(--card);
    border: 1px solid var(--accent);
    border-radius: var(--radius-lg); /* round77：面板/浮层走圆角阶梯的 lg（Fluent：浮层 8px） */
    box-shadow: var(--shadow-pop);
  }

  h3 {
    margin: 0;
    font-size: var(--text-title);
  }

  ol {
    margin: 0;
    padding-left: var(--space-4);
    font-size: var(--text-body);
    line-height: var(--line-body);
  }

  p {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-body);
  }

  .ok {
    align-self: flex-end;
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

  .ok:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
