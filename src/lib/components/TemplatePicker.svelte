<script lang="ts">
  import { t, tn } from "../i18n/i18n.svelte";
  import Icon from "../icons/Icon.svelte";
  /**
   * round64（C10）：模板面板（`▥ 模板`）—— 两件事：**套用**已存的模板 / 把某一周**存**成模板。
   *
   * 口径（`docs/plans/round64-c10-c11.md` §2.1）：
   * - 保存 = 那一周的骨架（层 / 时段 / 时长），**不含任务名**；预览行可以删（「生成后可改」）；
   * - 套用 = 铺到**正在看的那一周**（步进只影响保存区）；一次 `record` → `Ctrl+Z` 一步撤；
   * - 老规矩：能撤销的动作不加确认弹窗（round40）。
   */
  import {
    applyTemplate,
    closePicker,
    loadList,
    loadPreview,
    openPicker,
    removeRow,
    removeTemplate,
    saveTemplate,
    stepPreviewWeek,
    templates,
  } from "../stores/templates.svelte";
  import { layerLabel, skeletonRowLabel, skeletonRowName } from "../utils/templates";
  import { formatWeekRange } from "../utils/week";
  import { prefs } from "../stores/settings.svelte";
  import TemplatePreview from "./TemplatePreview.svelte";

  /** round80（79-02）：列表行 ↔ 预览块的**双向**联动靠这一个「当前悬停/聚焦的行号」 */
  let hotRow = $state<number | null>(null);

  // round80（6b P1）：关面板时把联动状态清掉 —— 行元素被移除时浏览器不会补发 mouseleave / focusout，
  // 残留的 `hotRow` 会让重开后的那一行**常亮**（看起来像还悬停着）。
  // （灵敏度对照：摘掉它跑 `--only "round80 ②"` → `重开无残留亮行=false` 必红，已实测。）
  $effect(() => {
    if (!templates.open) hotRow = null;
  });

  /** 点外面 / `Esc` / 窗口尺寸变了 → 收起（与 `SanitySettings` 同一套口径） */
  $effect(() => {
    if (!templates.open) return;
    const onDoc = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest(".tpl-wrap")) closePicker();
    };
    const onResize = () => closePicker();
    document.addEventListener("pointerdown", onDoc);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      window.removeEventListener("resize", onResize);
    };
  });

  async function openPop() {
    if (templates.open) {
      closePicker();
      return;
    }
    await openPicker();
  }
</script>

<div class="tpl-wrap">
  <button
    type="button"
    class="templates-open"
    class:on={templates.open}
    aria-expanded={templates.open}
    title={t("ui.template_picker.01")}
    onclick={() => void openPop()}><Icon name="file-text" size={16} />{t("ui.template_picker.16")}</button
  >

  {#if templates.open}
    <div class="tpl-pop" role="dialog" aria-label={t("ui.template_picker.02")}>
      <h3 class="sec">{t("ui.template_picker.03")}</h3>
      {#if templates.list.length === 0}
        <p class="empty">{t("ui.template_picker.04")}</p>
      {:else}
        {#each templates.list as tpl (tpl.id)}
          <div class="tpl-row">
            <span class="tpl-name" title={tpl.name}>{tpl.name}</span>
            <span class="tpl-count">{tn("ui.template_picker.05", tpl.block_count, { block_count: tpl.block_count })}</span>
            <button
              type="button"
              class="apply"
              title={t("ui.template_picker.06")}
              onclick={() => void applyTemplate(tpl.id)}>{t("ui.template_picker.17")}</button
            >
            <button
              type="button"
              class="del"
              title={t("ui.template_picker.07")}
              aria-label={t("ui.template_picker.08")}
              onclick={() => void removeTemplate(tpl.id)}><Icon name="trash-2" size={16} /></button
            >
          </div>
        {/each}
      {/if}

      <div class="divider"></div>
      <h3 class="sec">{t("ui.template_picker.09")}</h3>
      <div class="week-pick">
        <button type="button" class="prev" title={t("ui.template_picker.10")} onclick={() => void stepPreviewWeek(-1)}><Icon name="chevron-left" size={16} /></button>
        <span class="week-label" title={formatWeekRange(templates.weekStart)}
          >{formatWeekRange(templates.weekStart)}</span
        >
        <button type="button" class="next" title={t("ui.template_picker.11")} onclick={() => void stepPreviewWeek(1)}><Icon name="chevron-right" size={16} /></button>
      </div>

      {#if templates.rows.length === 0}
        <p class="empty">{t("ui.template_picker.12")}</p>
      {:else}
        {#each templates.rows as r, i (i)}
          <!-- svelte-ignore a11y_no_static_element_interactions（hover 是给鼠标用户的联动提示；键盘路径由行内删按钮的 focusin 驱动，行本身不可操作） -->
          <div
            class="sk-row"
            class:hot={hotRow === i}
            data-row={i}
            title={skeletonRowName(r)}
            onmouseenter={() => (hotRow = i)}
            onmouseleave={() => (hotRow = null)}
            onfocusin={() => (hotRow = i)}
            onfocusout={() => (hotRow = null)}
          >
            <span class="sk-time">{skeletonRowLabel(r)}</span>
            {#if skeletonRowName(r)}
              <span class="sk-name">{skeletonRowName(r)}</span>
            {/if}
            <span class="sk-layer">{layerLabel(r.layer)}</span>
            <button
              type="button"
              class="rm"
              title={t("ui.template_picker.13")}
              aria-label={t("ui.template_picker.14")}
              onclick={() => removeRow(i)}><Icon name="close" size={16} /></button
            >
          </div>
        {/each}
        <div class="save-row">
          <input
            class="tpl-input"
            type="text"
            maxlength="40"
            placeholder={t("ui.template_picker.15")}
            bind:value={templates.name}
            onkeydown={(e) => {
              if (e.key === "Enter") void saveTemplate();
              // round79（78-03 顺带）：打字框统一吃 `Esc` = 清空 + 失焦（同 `NewTaskInput`）
              else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                templates.name = "";
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
          />
          <button
            type="button"
            class="save"
            disabled={!templates.name.trim() || templates.rows.length === 0}
            onclick={() => void saveTemplate()}>{t("ui.template_picker.18")}</button
          >
        </div>
      {/if}

      <button
        type="button"
        class="close"
        onclick={() => {
          closePicker();
          void loadList();
          void loadPreview(templates.weekStart);
        }}>{t("ui.template_picker.19")}</button
      >
    </div>

    <!-- round80（79-02）：迷你周视图浮窗 —— 面板在右、它在左；随窗口自适应；太窄不显示
         （它跟着面板开而显，不是悬停触发 → WCAG 1.4.13 的三条不适用；`Esc`/`✕` 一起关） -->
    {#if prefs.templatePreview}
      <!-- round80（6b P2）：读屏口径 = **装饰**（信息由左侧列表承载）——`aria-hidden` + `title`（鼠标 tooltip）；
           键盘路径走列表行的 focus，不把浮窗做成可 Tab 到的区域 -->
      <aside
        class="tpl-preview"
        data-tpl-preview
        aria-hidden="true"
        title={t("ui.template_picker.20")}
      >
        {#if templates.rows.length === 0}
          <p class="pv-empty">{t("ui.template_picker.12")}</p>
        {:else}
          <TemplatePreview
            rows={templates.rows}
            weekStart={templates.weekStart}
            hot={hotRow}
            onHover={(i) => (hotRow = i)}
          />
        {/if}
      </aside>
    {/if}
  {/if}
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

  .tpl-pop {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 25;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    width: 360px;
    max-height: 70vh;
    overflow-y: auto;
    padding: var(--space-2);
    background: var(--card);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius-lg); /* round77：面板/浮层走圆角阶梯的 lg（Fluent：浮层 8px） */
    box-shadow: var(--shadow-pop);
  }

  .sec {
    margin: 0;
    font-size: var(--text-label);
    font-weight: 600;
    color: var(--text-secondary);
    letter-spacing: var(--label-tracking);
  }

  .empty {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-body);
  }

  .divider {
    height: 1px;
    margin: var(--space-1) 0;
    background: var(--grid-line);
  }

  .tpl-row,
  .sk-row,
  .week-pick,
  .save-row {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .tpl-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-body);
  }

  .tpl-count,
  .sk-layer {
    flex: none;
    color: var(--text-secondary);
    font-size: var(--text-label);
  }

  .sk-time {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--text-meta);
    white-space: nowrap;
  }

  /* round64.1（验收 #2）：预览行也看得见要铺的任务名 */
  .sk-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-body);
  }

  .apply,
  .save,
  .del,
  .rm,
  .prev,
  .next,
  .close {
    padding: 0 var(--space-1);
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

  .apply:hover,
  .save:hover,
  .prev:hover,
  .next:hover,
  .close:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .save:disabled {
    border-color: var(--grid-line);
    color: var(--text-secondary);
    cursor: default;
  }

  .del,
  .rm {
    border-color: transparent;
    color: var(--text-secondary);
  }

  .del:hover,
  .rm:hover {
    border-color: var(--danger);
    color: var(--danger);
  }

  .week-pick {
    justify-content: center;
  }

  .week-label {
    flex: 1;
    text-align: center;
    font-size: var(--text-body);
  }

  .tpl-input {
    flex: 1;
    min-width: 0;
    padding: 0 var(--space-1);
    background: var(--bg);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-body);
    line-height: var(--line-body);
  }

  .close {
    margin-top: var(--space-1);
    align-self: center;
  }

  /* round80（79-02）：迷你周视图浮窗 —— 面板在右（360px）、它在左；宽高随窗口自适应（你拍板）；
     窄窗（< 860px）放不下就不显示（开关仍开着）。 */
  .tpl-preview {
    position: absolute;
    top: calc(100% + 4px);
    right: calc(360px + var(--space-3));
    z-index: 25;
    display: flex;
    flex-direction: column;
    width: clamp(440px, 40vw, 600px);
    height: clamp(320px, 30vw, 450px);
    padding: var(--space-2);
    background: var(--card);
    border: 1px solid var(--text-secondary);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-pop);
  }

  .pv-empty {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-body);
  }

  /* 列表行的联动高亮（键鼠同一套：hover 与 focus 都走 `hotRow`） */
  .sk-row.hot {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border-radius: var(--radius);
  }

  @media (max-width: 860px) {
    .tpl-preview {
      display: none;
    }
  }
</style>
