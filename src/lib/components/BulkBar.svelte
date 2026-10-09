<script lang="ts">
  import { t, tn } from "../i18n/i18n.svelte";
  import Icon from "../icons/Icon.svelte";
  /**
   * round61（10.2 多选）：多选**动作条**（顶部一条）。
   *
   * 形态与位置照调研：GNOME / Material 的 contextual action bar、Todoist 的多选工具条都在顶部；
   * 按钮是**真按钮**（可 Tab），数量从 `selection` / `blocks` 现算，不落自己的状态。
   * 口径：**删除不弹确认**（有 Ctrl+Z；Nubisco：「有撤销就别再确认」）；**标 ✗ 不弹漂流卡**。
   */
  import { blocks, groupPreview } from "../stores/blocks.svelte";
  import {
    clearSelection,
    deleteSelectedMany,
    markSelectedMany,
    moveSelectedMany,
    selection,
    setSelectedLayerMany,
  } from "../stores/selection.svelte";

  const count = $derived(selection.ids.length);
  /**
   * round61.2（你报图4）：拿起的组被挪到别的周时，它的数据**不在本周 `blocks` 里**（还没落地，
   * 只在组预览快照里）—— 状态/层数要优先读快照，否则会把「计划中」谎报成「已标记」（0 块计划中）。
   */
  const statusOf = (id: string) =>
    selection.grabbed && groupPreview.blocks[id]
      ? groupPreview.blocks[id].status
      : blocks.find((b) => b.id === id)?.status;
  const layerOf = (id: string) =>
    selection.grabbed && groupPreview.blocks[id]
      ? groupPreview.blocks[id].layer
      : blocks.find((b) => b.id === id)?.layer;
  const plannedCount = $derived(selection.ids.filter((id) => statusOf(id) === "planned").length);
  /** round61.1（你验收实测）：选中里混了**已标记**的块时，把「会跳过几块」写在明面上 ——
   *  否则「已选 3 块」却只动了 2 块，看起来像坏了。*/
  const skipped = $derived(count - plannedCount);
  const canRequired = $derived(selection.ids.some((id) => layerOf(id) !== "required"));
  const canElastic = $derived(selection.ids.some((id) => layerOf(id) === "required"));
  /**
   * round61.2：拿起的组被挪出本窗口 → 按钮先禁用（否则按下 = 先放弃拿起，动作落到看不见的块上）。
   * 想在别的周继续操作：先 Enter 落地（或 Esc 放弃拿起）就好。
   */
  const outOfView = $derived(
    selection.grabbed &&
      selection.ids.some((id) => !!groupPreview.blocks[id] && !blocks.some((b) => b.id === id)),
  );
  const hint = $derived(
    outOfView ? t("ui.bulk_bar.01") : undefined,
  );
</script>

<div class="bulk-bar" role="toolbar" aria-label={t("ui.bulk_bar.02")}>
  <span class="count"
    >{tn("ui.bulk_bar.03", count, { count: count })}{#if skipped > 0}<span class="muted">{t("ui.bulk_bar.04", { plannedCount: plannedCount })}</span>{/if}</span
  >
  <button
    type="button"
    disabled={plannedCount === 0 || outOfView}
    title={outOfView ? hint : t("ui.bulk_bar.05")}
    onclick={() => void markSelectedMany("done")}><Icon name="check" size={14} />{t("ui.bulk_bar.17")}</button
  >
  <button
    type="button"
    disabled={plannedCount === 0 || outOfView}
    title={outOfView ? hint : t("ui.bulk_bar.06")}
    onclick={() => void markSelectedMany("missed")}><Icon name="x" size={14} />{t("ui.bulk_bar.18")}</button
  >
  <button
    type="button"
    disabled={!canRequired || outOfView}
    title={outOfView ? hint : t("ui.bulk_bar.07")}
    onclick={() => void setSelectedLayerMany("required")}>{t("ui.bulk_bar.19")}</button
  >
  <button
    type="button"
    disabled={!canElastic || outOfView}
    title={outOfView ? hint : t("ui.bulk_bar.08")}
    onclick={() => void setSelectedLayerMany("elastic")}>{t("ui.bulk_bar.20")}</button
  >
  <button
    type="button"
    disabled={plannedCount === 0 || outOfView}
    title={outOfView
      ? hint
      : skipped > 0
        ? tn("ui.bulk_bar.09", skipped, { skipped: skipped })
        : t("ui.bulk_bar.10")}
    onclick={() => void moveSelectedMany(-1)}>{t("ui.bulk_bar.21")}</button
  >
  <button
    type="button"
    disabled={plannedCount === 0 || outOfView}
    title={outOfView
      ? hint
      : skipped > 0
        ? tn("ui.bulk_bar.11", skipped, { skipped: skipped })
        : t("ui.bulk_bar.12")}
    onclick={() => void moveSelectedMany(1)}>{t("ui.bulk_bar.22")}</button
  >
  <button type="button" class="danger" title={t("ui.bulk_bar.13")} onclick={() => void deleteSelectedMany()}
    ><Icon name="trash-2" size={14} />{t("ui.bulk_bar.14")}</button
  >
  <button type="button" class="bar-close" title={t("ui.bulk_bar.15")} aria-label={t("ui.bulk_bar.16")} onclick={() => clearSelection()}
    ><Icon name="close" size={16} /></button
  >
</div>

<style>
  /* round77 收尾：不再自己占一行 —— 现在住在 `Timeline` 的**固定槽**（`.hint-slot`）里，
     出现/消失不再改变头部高度（多选起拖时它一走，头部就矮一截 → 落点偏一格）。
     纵向内边距归 0、按钮压到刚好装进 26px 槽（窄窗装不下时仍允许换行，只是那个宽度下槽会长高）。 */
  .bulk-bar {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    padding: 0 var(--space-2);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }

  .count {
    font-weight: 600;
  }

  .count .muted {
    font-weight: 400;
    color: var(--text-secondary);
  }

  .bulk-bar button {
    padding: 2px var(--space-2);
    border: 1px solid var(--muted);
    border-radius: var(--radius);
    background: var(--card);
    color: var(--text-primary);
    font: inherit;
    cursor: pointer;
  }

  .bulk-bar button:hover:not(:disabled) {
    border-color: var(--accent);
  }

  .bulk-bar button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .bulk-bar .danger {
    color: var(--warn);
    border-color: var(--warn);
  }

  .bar-close {
    margin-left: auto;
    border-color: transparent !important;
    background: transparent !important;
    color: var(--text-secondary);
  }
</style>
