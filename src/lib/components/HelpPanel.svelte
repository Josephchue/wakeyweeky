<script lang="ts">
  import { getLocale, t } from "../i18n/i18n.svelte";
  import { focusTrap, scrollableRegion } from "../utils/modal";
  import Icon from "../icons/Icon.svelte";
  import RichText from "../i18n/RichText.svelte";
  /**
   * round64（C10）：**说明页** —— 全部解释的唯一出口（用户 2026-10-04 反馈 #7）。
   *
   * 为什么单独一页：① 解释集中一处才改得动（散在各处的 ⓘ 与长旁批必然漂移 —— 反馈 #5
   * 的活例子：`ⓘ 怎么算的` 是 round44 写的、round45 口径就重写了）；② 设置面板保持一屏能扫完。
   *
   * **唯二例外**：键位表留在设置面板（用户点名「键位除外」，这里只指路）；危险动作旁的安全提示
   * （恢复会重启、计划任务默认关）留一个在旁边 —— 出事了才去翻帮助就晚了。
   *
   * 数字防漂移（plan §1.4 / H7）：这里的选项/默认值都**引用代码常量**（提前档位 / 建议门限 /
   * 默认预算），不手抄；改常量这里跟着变。
   */
  import { REMIND_LEAD_CHOICES, QUIET_PRESET_MINUTES, prefs } from "../stores/settings.svelte";
  import { closeHelp, guide } from "../stores/guide.svelte";
  import { remindSettings } from "../stores/review.svelte";
  import { featuresOnSummary } from "../utils/help";
  import { FEATURES, TEMPLATE_SUGGEST_DEFAULT } from "../utils/features";
  import { sanity } from "../stores/sanity.svelte";

  /** 「每日预算」写**当前值**（不手抄默认值 —— 口径与设置里的那行永远一致） */
  const budgetHours = $derived((sanity.budgetMinutes / 60).toLocaleString(getLocale() === "en" ? "en-US" : "zh-CN"));
  /** 复盘当前设定（"现在是 周日 20:00"，不手抄默认值） */
  const reviewAt = $derived(`${remindSettings.day === "mon" ? t("msg.week.04") : t("msg.week.10")} ${remindSettings.time}`);
  /** round69.1（6b P2-6）：动作也**按当前设置**说 —— 旧写法写死「只提醒我」，换默认后就成了假话 */
  const reviewActionLabel = $derived(
    remindSettings.action === "open"
      ? t("help.help_panel.01")
      : remindSettings.action === "hint"
        ? t("help.help_panel.02")
        : t("help.help_panel.03"),
  );

  $effect(() => {
    // 打开时（或带锚点打开时）滚到那个分区
    if (!guide.helpOpen || !guide.helpAnchor) return;
    document.getElementById(`help-${guide.helpAnchor}`)?.scrollIntoView({ block: "start" });
  });

  // round78（栈-01/栈-02）：`Esc` 与「关自己」统一收进面板栈（`Timeline` 的全局处理器 → `closeTopPanel()`），
  // 这里不再各自监听 —— 以前 7 处各听各的，一次 Esc 会把叠着的面板**全关**（round72 L2）。

  function jump(anchor: string) {
    guide.helpAnchor = anchor;
    document.getElementById(`help-${anchor}`)?.scrollIntoView({ block: "start" });
  }
</script>

{#if guide.helpOpen}
  <!-- round77 收尾：遮罩**不进 Tab 顺序**（它只是「点一下关面板」的鼠标快捷键；键盘用面板的 ✕ / Esc） -->
  <button
    type="button"
    class="backdrop"
    tabindex="-1"
    aria-label={t("help.help_panel.04")}
    onclick={closeHelp}
  ></button>
<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role（`section role="dialog"` 是 ARIA 认可写法，Svelte 的检查器偏严） -->
  <section
    class="overlay-panel wide help-panel"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    aria-label={t("help.help_panel.05")}
    use:focusTrap={{ active: guide.helpOpen }}
  >
    <header class="panel-head">
      <h2 class="title">{t("help.help_panel.06")}</h2>
      <span class="scope">{t("help.help_panel.07")}</span>
      <button type="button" class="close" onclick={closeHelp} aria-label={t("ui.review_panel.73")}><Icon name="close" size={16} /></button>
    </header>

    <nav class="toc" aria-label={t("help.help_panel.08")}>
      <button type="button" onclick={() => jump("reminders")}>{t("help.help_panel.91")}</button>
      <button type="button" onclick={() => jump("sanity")}>{t("help.help_panel.92")}</button>
      <button type="button" onclick={() => jump("data")}>{t("help.help_panel.93")}</button>
      <button type="button" onclick={() => jump("templates")}>{t("help.help_panel.94")}</button>
      <button type="button" onclick={() => jump("hints")}>{t("help.help_panel.95")}</button>
      <button type="button" onclick={() => jump("features")}>{t("help.help_panel.96")}</button>
      <button type="button" onclick={() => jump("display")}>{t("help.help_panel.99")}</button>
    </nav>

    <div class="body" use:scrollableRegion={{ label: t("help.help_panel.06") }}>
      <section id="help-reminders">
        <h3>{t("help.help_panel.09")}</h3>
        <ul>
          <li><RichText k="help.help_panel.10" p={{ join: REMIND_LEAD_CHOICES.filter((m) => m > 0).join(" / ") }} /></li>
          <li><RichText k="help.help_panel.12" /></li>
          <li><RichText k="help.help_panel.14" p={{ reviewAt: reviewAt, reviewActionLabel: reviewActionLabel }} /></li>
          <li><RichText k="help.help_panel.16" p={{ QUIET_PRESET_MINUTES: QUIET_PRESET_MINUTES[0], QUIET_PRESET_MINUTES2: QUIET_PRESET_MINUTES[1] / 60 }} /></li>
          <li><RichText k="help.help_panel.20" /></li>
        </ul>
      </section>

      <section id="help-sanity">
        <h3>{t("help.help_panel.22")}</h3>
        <ul>
          <li><RichText k="help.help_panel.23" /></li>
          <li><RichText k="help.help_panel.28" p={{ budgetHours: budgetHours }} /></li>
          <li><RichText k="help.help_panel.31" /></li>
          <li>{t("help.help_panel.34")}</li>
        </ul>
      </section>

      <section id="help-data">
        <h3>{t("help.help_panel.35")}</h3>
        <ul>
          <li><RichText k="help.help_panel.36" /></li>
          <li><RichText k="help.help_panel.38" /></li>
          <li><RichText k="help.help_panel.42" /></li>
          <li><RichText k="help.help_panel.46" /></li>
          <!-- round80（壳-06）：窗口状态文件不跟 data\ 走（在 %APPDATA%） -->
          <li><RichText k="help.help_panel.97" /></li>
        </ul>
      </section>

      <section id="help-templates">
        <h3>{t("help.help_panel.54")}</h3>
        <ul>
          <li><RichText k="help.help_panel.55" /></li>
          <li><RichText k="help.help_panel.59" /></li>
          <li><RichText k="help.help_panel.62" p={{ days: TEMPLATE_SUGGEST_DEFAULT.days, done: TEMPLATE_SUGGEST_DEFAULT.done }} /></li>
          <li><RichText k="help.help_panel.66" /></li>
          <li>{t("help.help_panel.71")}</li>
        </ul>
      </section>

      <section id="help-hints">
        <h3>{t("help.help_panel.72")}</h3>
        <ul>
          <li><RichText k="help.help_panel.73" /></li>
          <li><RichText k="help.help_panel.75" /></li>
          <li>{t("help.help_panel.78")}</li>
          <li><RichText k="help.help_panel.79" /></li>
          <li><RichText k="help.help_panel.81" /></li>
          <li><RichText k="help.help_panel.83" /></li>
        </ul>
      </section>

      <section id="help-display">
        <h3>{t("help.help_panel.99")}</h3>
        <ul>
          <!-- round81（3.1c₁ · 时-10）：时间 / 日期档位与平台限制一句 -->
          <li><RichText k="help.help_panel.98" /></li>
          <!-- round82（3.1c₂ · 淡-*）：夜间时段（第四档主题 + 淡化带共用）与「只影响观感」一句 -->
          <li><RichText k="help.help_panel.100" /></li>
          <!-- round82（3.1c₂ · 绑-*）：键位可改 + 哪些不能改（Q21：解释只进说明页） -->
          <li><RichText k="help.help_panel.101" /></li>
          <!-- round87（3.3 字体方案）：界面字体族（五档系统字体；拉丁不变、只换中文） -->
          <li><RichText k="help.help_panel.102" /></li>
        </ul>
      </section>

      <section id="help-features">
        <h3>{t("help.help_panel.85")}</h3>
        <p class="note">
          <RichText k="help.help_panel.86" />
        </p>
        <table class="features">
          <tbody>
            {#each featuresOnSummary(FEATURES, prefs) as row (row.key)}
              <tr>
                <td class="name">{row.label}</td>
                <td class="state">{row.on ? t("help.help_panel.89") : t("help.help_panel.90")}</td>
                <td class="off">{row.off}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    </div>
  </section>
{/if}

<style>
  .help-panel {
    position: fixed;
    z-index: 41;
    top: 4vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(640px, 94vw);
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    background: var(--card);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius-lg); /* round77：面板/浮层走圆角阶梯的 lg（Fluent：浮层 8px） */
    box-shadow: var(--shadow-menu);
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

  .scope {
    color: var(--text-secondary);
    font-size: var(--text-meta);
  }

  .close {
    margin-left: auto;
    padding: 2px var(--space-2);
    border: 1px solid var(--grid-line);
    background: none;
    color: var(--text-secondary);
    font-size: var(--text-body);
    cursor: pointer;
  }

  .toc {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--grid-line);
  }

  .toc button {
    padding: 0 var(--space-2);
    background: none;
    border: 1px solid var(--grid-line);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-body);
    line-height: var(--line-body);
    cursor: pointer;
  }

  .toc button:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .body {
    overflow-y: auto;
    padding: var(--space-3) var(--space-4) var(--space-4);
  }

  section {
    margin-bottom: var(--space-4);
  }

  h3 {
    margin: 0 0 var(--space-1);
    font-size: var(--text-title);
  }

  ul {
    margin: 0;
    padding-left: var(--space-4);
    font-size: var(--text-body);
    line-height: var(--line-body);
  }

  .note {
    margin: 0 0 var(--space-2);
    color: var(--text-secondary);
    font-size: var(--text-body);
  }

  .features {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-body);
  }

  .features td {
    padding: 2px var(--space-1);
    border-top: 1px solid var(--grid-line);
    vertical-align: top;
  }

  .features .name {
    white-space: nowrap;
  }

  .features .state {
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .features .off {
    color: var(--text-secondary);
  }
</style>
