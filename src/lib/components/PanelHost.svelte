<script lang="ts">
  import { tick } from "svelte";

  import { t } from "../i18n/i18n.svelte";
  import { closeTopPanel, panelChange, stack, stackDepth, stackRejections } from "../stores/panels.svelte";
  import { focusTrap } from "../utils/modal";


  import AchievementsPanel from "./AchievementsPanel.svelte";
  import ConfirmPanel from "./ConfirmPanel.svelte";
  import DataSwitch from "./DataSwitch.svelte";
  import HelpPanel from "./HelpPanel.svelte";
  import KeymapPanel from "./KeymapPanel.svelte";
  import ReviewPanel from "./ReviewPanel.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";
  import StatsPanel from "./StatsPanel.svelte";
  import TemplatePanel from "./TemplatePanel.svelte";

  /**
   * round96：**面板栈的唯一宿主**（App 根；在 `main.shell` 之外）。
   *
   * 三件事：
   * 1. 按 `stack` 的顺序画层：每层一个 `[data-layer-id]` 包装，`--layer-index` 给 z，非栈顶层 `inert`；
   * 2. **一个共享遮罩**（`z = 栈顶 − 1`）：点它 = `closeTopPanel()`（这一下被吃掉，不穿透）；
   * 3. **还焦点**：栈变化后按 `panelChange` 把焦点还给该层的 `openedBy`（没了就栈顶第一个可聚焦项）。
   *
   * `focusTrap` 只在栈顶层 active；它不再自己还焦点（round96 · R16）。
   */
  let lastSeq = 0;

  function focusTopLayer(): void {
    const layers = document.querySelectorAll<HTMLElement>("[data-layer-id]");
    const top = layers[layers.length - 1];
    // 兜底落点：栈顶第一个可聚焦项（focusTrap 已经先试过一次；这里管「重入只送焦点」）
    top
      ?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      ?.focus({ preventScroll: true });
  }

  $effect(() => {
    const seq = panelChange.seq;
    if (seq === lastSeq) return;
    lastSeq = seq;
    if (panelChange.kind === "close") {
      const anchor = panelChange.anchor as HTMLElement | null;
      // 等 Svelte flush：父层刚摘掉 inert，立刻 focus 会被浏览器忽略
      void tick().then(() => {
        if (anchor?.isConnected) {
          anchor.focus?.({ preventScroll: true });
          if (document.activeElement === anchor) return;
        }
        focusTopLayer();
      });
    } else if (panelChange.kind === "focus") {
      void tick().then(focusTopLayer);
    }
  });
</script>

<div class="panel-host" data-stack-depth={stackDepth()} data-stack-rejections={stackRejections()}>
  {#if stackDepth() > 0}
    <!-- round96（R3）：**一个共享遮罩**，z = 栈顶 − 1（37 + 2×深度）；点一下 = 退一层（这一下被它吃掉）。
         键盘用户走 `Esc` / 面板 ✕；它不进 Tab 顺序（tabindex=-1，与 round77 口径一致）。 -->
    <button
      type="button"
      class="overlay-backdrop"
      tabindex="-1"
      aria-label={t("ui.review_panel.73")}
      style="z-index: calc(37 + 2 * {stackDepth()})"
      onclick={() => closeTopPanel()}
    ></button>
  {/if}

  {#each stack as layer, i (layer.id)}
    <!-- 一层 = 一个包装：非栈顶层 inert（点不到 / Tab 到不了 / 读屏不念）；z 由索引算 -->
    <div
      class="panel-layer"
      data-layer-id={layer.id}
      data-layer-index={i}
      style="--layer-index:{i}"
      inert={i < stack.length - 1}
      use:focusTrap={{ active: i === stack.length - 1 }}
    >
      {#if layer.id === "review"}
        <ReviewPanel />
      {:else if layer.id === "stats"}
        <StatsPanel />
      {:else if layer.id === "achievements"}
        <AchievementsPanel />
      {:else if layer.id === "keymap"}
        <KeymapPanel />
      {:else if layer.id === "help"}
        <HelpPanel />
      {:else if layer.id === "data"}
        <DataSwitch />
      {:else if layer.id === "confirm"}
        <ConfirmPanel />
      {:else if layer.id === "settings"}
        <SettingsPanel />
      {:else if layer.id === "templates"}
        <TemplatePanel />
      {/if}
    </div>
  {/each}
</div>

<style>
  /* `inert` 原生就不吃指针；这行是兜底（老 WebView 也不至于穿透） */
  .panel-layer[inert] {
    pointer-events: none;
  }
</style>
