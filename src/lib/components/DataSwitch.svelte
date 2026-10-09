<script lang="ts">
  import { t } from "../i18n/i18n.svelte";
  import Icon from "../icons/Icon.svelte";
  import { confirmDanger, focusTrap, scrollableRegion } from "../utils/modal";
  /**
   * round66（C12）：**数据位置切换**面板（便携模式）。
   *
   * 为什么是覆盖层而不是设置弹层里的小控件：切换要「两份数据对照 + 二次确认」，
   * 380px 的设置弹层摆不下两张卡；挂在 App 根部也不会被弹层裁掉。
   *
   * 界面对照 Phigros 的「存档冲突」（两栏存档指标 + 各自「使用」+ 二次确认；调研与截图出处见
   * `docs/plans/round66-c12-portable-and-hotkeys.md` §二·4）—— 两点不同：
   * ① 每份多摆 大小 + 任务·块数（比「上次同步」更能说明哪份有东西）；
   * ② **需要被覆盖的那一侧**先留副本、不删（后端只复制，`wakeyweeky.sqlite.before-switch`）；
   *    选「另一边」时两边都原地不动（没有覆盖就没有副本）。
   */
  import { applyDataChoice, getDataInfo, type DataInfo, type SideInfo } from "../ipc/portable";
  import { formatBytes } from "../utils/backup";
  import { closeDataSwitch, dataSwitch } from "../stores/ui.svelte";

  let info = $state<DataInfo | null>(null);
  /** round78（3.1b₂ · 栈-10）：读数据位置信息失败了吗（失败要给「重试」，不能只弹一条 Toast 就完） */
  let failed = $state(false);
  /** round78（栈-01）：`busy` 上提到 store —— 面板栈的关闭函数要能**拒绝**（切换中不许被 Esc 关掉） */
  const busy = $derived(dataSwitch.busy);

  $effect(() => {
    if (!dataSwitch.open) return;
    info = null;
    failed = false;
    void loadInfo();
  });

  /** 读一次两侧数据位置（失败 → `failed`，界面给「重试」） */
  async function loadInfo(): Promise<void> {
    try {
      info = await getDataInfo();
      failed = false;
    } catch {
      failed = true; // ipc 层已弹 Toast；面板里再给一个显式的重试出口
    }
  }

  // round78（栈-01/栈-02）：`Esc` 与「关自己」统一收进面板栈（`Timeline` 的全局处理器 → `closeTopPanel()`），
  // 这里不再各自监听 —— 以前 7 处各听各的，一次 Esc 会把叠着的面板**全关**（round72 L2）。

  /** 哪一份的「最后修改」更新（只做徽标；**不替你自动选** —— 时间会被复制 / 恢复弄乱） */
  const newer = $derived.by((): "current" | "other" | null => {
    if (!info || info.current.modified == null || info.other.modified == null) return null;
    if (info.current.modified === info.other.modified) return null;
    return info.current.modified > info.other.modified ? "current" : "other";
  });

  function formatTime(sec: number): string {
    const d = new Date(sec * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function meta(s: SideInfo): string {
    if (!s.exists) return t("ui.data_switch.01");
    const parts: string[] = [];
    if (s.modified != null) parts.push(t("ui.data_switch.02", { modified: formatTime(s.modified) }));
    if (s.bytes != null) parts.push(formatBytes(s.bytes));
    if (s.tasks != null && s.blocks != null) parts.push(t("ui.data_switch.03", { tasks: s.tasks, blocks: s.blocks }));
    return parts.join(" · ");
  }

  /** 选一份 → 二次确认（应用内面板，round80 · 79-01；它删掉落选那份，我们留副本）→ 重启 */
  async function pick(which: "current" | "other") {
    if (!info || busy) return;
    const chosen = which === "current" ? info.current : info.other;
    const msg =
      which === "current"
        ? t("ui.data_switch.04", { label: chosen.label })
        : t("ui.data_switch.05", { label: chosen.label });
    const ok = await confirmDanger({
      body: msg,
      title: t("ui.data_switch.06"),
      ok: t("ui.data_switch.07"),
      cancel: t("ui.data_switch.08"),
    });
    if (!ok) return;
    dataSwitch.busy = true;
    try {
      await applyDataChoice(which); // 成功的话进程会重启，等不到 resolve
    } catch {
      dataSwitch.busy = false; // 失败原因 ipc 层已弹 Toast
    }
  }
</script>

{#if dataSwitch.open}
  <!-- round77 收尾：遮罩**不进 Tab 顺序**（它只是「点一下关面板」的鼠标快捷键；键盘用面板的 ✕ / Esc） -->
  <button
    type="button"
    class="overlay-backdrop"
    tabindex="-1"
    aria-label={t("ui.data_switch.09")}
    onclick={() => !busy && closeDataSwitch()}
  ></button>
<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role（`section role="dialog"` 是 ARIA 认可写法，Svelte 的检查器偏严） -->
  <section
    class="overlay-panel narrow switch-panel"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    aria-label={t("ui.data_switch.10")}
    use:focusTrap={{ active: dataSwitch.open }}
    use:scrollableRegion={{ label: t("ui.data_switch.11") }}
    data-data-switch
    data-portable={info?.portable ?? false}
  >
    <header class="panel-head">
      <h2 class="title">{t("ui.data_switch.11")}</h2>
      <span class="scope">{info?.portable ? t("ui.data_switch.22") : t("ui.data_switch.23")}</span>
      <button type="button" class="close" onclick={closeDataSwitch} disabled={busy} aria-label={t("ui.data_switch.27")}><Icon name="close" size={16} /></button>
    </header>

    {#if info == null && failed}
      <!-- round78（3.1b₂ · 栈-10）：读失败给「重试」（不再只弹一条 Toast） -->
      <p class="warn">
        {t("ui.data_switch.28")}
        <button type="button" class="retry" onclick={() => void loadInfo()}>{t("ui.common.01")}</button>
      </p>
    {:else if info == null}
      <p class="loading">{t("ui.data_switch.12")}</p>
    {:else}
      {#if info.fallback && info.note}
        <p class="warn">{info.note}</p>
      {/if}
      <p class="lead">
        {t("ui.data_switch.13")}
        <b>{t("ui.data_switch.14")}</b>{t("ui.data_switch.15")}
      </p>

      <div class="cards">
        <article class="card" class:here={true} data-side="current">
          <header class="card-head">
            <span class="who">{info.current.label}</span>
            <span class="chip now">{t("ui.data_switch.16")}</span>
            {#if newer === "current"}<span class="chip newer">{t("ui.data_switch.17")}</span>{/if}
          </header>
          <p class="path" title={info.current.db}>{info.current.db}</p>
          <p class="meta">{meta(info.current)}</p>
          <button
            type="button"
            class="use"
            disabled={busy || info.fallback}
            onclick={() => void pick("current")}
            >{t("ui.data_switch.18")}</button
          >
        </article>

        <article class="card" class:bad={info.other.exists && !info.other.usable} data-side="other">
          <header class="card-head">
            <span class="who">{info.other.label}</span>
            {#if newer === "other"}<span class="chip newer">{t("ui.data_switch.19")}</span>{/if}
          </header>
          <p class="path" title={info.other.db}>{info.other.db}</p>
          <p class="meta">{meta(info.other)}</p>
          {#if info.other.exists && !info.other.usable}
            <p class="bad-reason">{t("ui.data_switch.20", { reason: info.other.reason ?? t("ui.data_switch.24") })}</p>
          {/if}
          <button
            type="button"
            class="use"
            disabled={busy || info.fallback || !info.other.exists || !info.other.usable}
            onclick={() => void pick("other")}
            >{info.other.exists && info.other.usable ? t("ui.data_switch.25") : t("ui.data_switch.26")}</button
          >
        </article>
      </div>

      <footer class="actions">
        <span class="foot-note">{t("ui.data_switch.21")}</span>
        <button type="button" class="cancel" onclick={closeDataSwitch} disabled={busy}>{t("ui.data_switch.27")}</button>
      </footer>
    {/if}
  </section>
{/if}

<style>
  .switch-panel {
    /* round78（栈-04）：定位/宽度交给 `.overlay-panel.narrow`（固定左缘 + 560 档） */
    overflow: auto;
    padding: var(--space-4);
    background: var(--card);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius-lg); /* round77：面板/浮层走圆角阶梯的 lg（Fluent：浮层 8px） */
    box-shadow: var(--shadow-menu);
  }

  .panel-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .title {
    margin: 0;
    font-size: var(--text-title);
    color: var(--text-primary);
  }

  .scope {
    flex: 1;
    font-size: var(--text-meta);
    color: var(--text-secondary);
  }

  .close {
    border: none;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: var(--text-title);
  }

  .loading,
  .lead {
    margin: 0 0 var(--space-3);
    font-size: var(--text-body);
    line-height: var(--line-body);
    color: var(--text-secondary);
  }

  .lead b {
    color: var(--text-primary);
  }

  .warn,
  .bad-reason {
    margin: 0 0 var(--space-3);
    font-size: var(--text-body);
    line-height: var(--line-body);
    color: var(--warn);
  }

  .cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }

  @media (max-width: 560px) {
    .cards {
      grid-template-columns: 1fr;
    }
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--grid-line);
    border-radius: var(--radius);
    background: var(--bg);
  }

  .card.here {
    border-color: var(--accent);
  }

  .card.bad {
    border-color: var(--warn);
  }

  .card-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .who {
    font-size: var(--text-body);
    color: var(--text-primary);
  }

  .chip {
    padding: 0 var(--space-1);
    font-size: var(--text-meta);
    /* px 行高：单行小胶囊（高度稳定，不许被密度推高） */
    line-height: 18px;
    border-radius: var(--radius);
  }

  .chip.now {
    color: var(--text-secondary);
    background: var(--block-fill-missed);
  }

  .chip.newer {
    color: var(--text-primary);
    border: 1px solid var(--accent);
  }

  .path {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-meta);
    line-height: var(--line-body);
    color: var(--text-secondary);
    word-break: break-all;
  }

  .meta {
    margin: 0;
    font-size: var(--text-meta);
    color: var(--text-primary);
  }

  .use {
    margin-top: auto;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    background: var(--card);
    color: var(--text-primary);
    font-size: var(--text-body);
    cursor: pointer;
  }

  .use:hover:not(:disabled) {
    background: var(--accent);
  }

  .use:disabled {
    border-color: var(--muted);
    color: var(--muted);
    cursor: not-allowed;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-3);
  }

  .foot-note {
    flex: 1;
    font-size: var(--text-meta);
    color: var(--text-secondary);
  }

  .cancel {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    background: var(--card);
    color: var(--text-primary);
    font-size: var(--text-body);
    cursor: pointer;
  }
</style>
