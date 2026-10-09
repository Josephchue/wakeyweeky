<script lang="ts">
  /**
   * round77（3.1b）：**一个图标**（五套里当前选中的那一套的画法）。
   *
   * 用法：`<Icon name="check" size={14} />` —— 颜色跟 `currentColor`（父级文字色），
   * 尺寸给数字（块上 14 / 列表与面板 16 / 空态 24–32）。
   *
   * 无障碍：**图标本身 `aria-hidden`** —— 语义由外层按钮的 `title` / `aria-label` 承担（C13）。
   * 断言锚：`data-icon="<语义名>"`（这样换画法不用改断言，改语义才改）。
   */
  import { iconData, type IconName } from "./index";
  import { appearance } from "../stores/appearance.svelte";

  let {
    name,
    size = 16,
    class: cls = "",
  }: { name: IconName; size?: number; class?: string } = $props();

  const data = $derived(iconData(appearance.iconSet, name));
</script>

<svg
  class="icon {cls}"
  width={size}
  height={size}
  viewBox={data.viewBox}
  fill={data.fill}
  stroke={data.stroke}
  stroke-width={data.strokeWidth > 0 ? data.strokeWidth : undefined}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
  data-icon={name}
  data-icon-set={data.set}
  data-icon-source={data.source}
>
  {#each data.paths as p (p.d)}
    <path
      d={p.d}
      fill={p.fill ?? data.fill}
      stroke={p.stroke ?? data.stroke}
      stroke-width={p.strokeWidth ?? (data.strokeWidth > 0 ? data.strokeWidth : undefined)}
    />
  {/each}
</svg>

<style>
  /* 行内对齐：图标与相邻文字的中线对齐（`vertical-align: -0.125em` 是 Font Awesome 的常规口径） */
  .icon {
    display: inline-block;
    flex: none;
    vertical-align: -0.125em;
  }
</style>
