/**
 * round76（3.1a）：**外观三选 → `<html data-*>` 的唯一落点**。
 *
 * 为什么单开一个 store：密度 / 配色 / 两个着色开关都是**全局属性**（一个属性改，整棵树的
 * token 全重算），而且时间轴的**手势数学**也要跟着格高走 —— 集中在一处比散在组件里可靠。
 *
 * 与设置的关系：`stores/settings.svelte.ts` 是 DB 的读写方（`get_settings` / `set_setting`），
 * 它读回来 / 改完都调 `applyAppearance`；这里只管「把当前值写到 DOM 上」+「把格高喂给
 * `utils/timeline.ts`」。**深浅色不在这里** —— 它由 Rust `set_theme` 设窗口主题，
 * CSS 只用 `prefers-color-scheme` 一条路径（round75 `深-04`）。
 */
import {
  DENSITY_SCALE,
  normalizeDensity,
  normalizeFontFamily,
  normalizeIconSet,
  normalizePalette,
  normalizeSecondLine,
  type Density,
  type FontFamily,
  type IconSet,
  type Palette,
  type SecondLine,
} from "../utils/appearance";
import { setSlotHeightProvider } from "../utils/timeline";

export const appearance = $state<{
  /** 字号密度（紧凑 / 舒适 / 宽松）—— 默认舒适 */
  density: Density;
  /** 配色（暖砂 A / 冷白 B / 素灰绿 C）—— 默认暖砂 */
  palette: Palette;
  /** 图标集（Lucide / Tabler / Phosphor / Bootstrap / Material）—— 默认 Lucide */
  iconSet: IconSet;
  /** 块内第二行（时间 / 剩余分钟）—— 默认时间（= 旧行为） */
  blockSecondLine: SecondLine;
  /** 界面字体族（round87）—— 默认档（= 今天的观感，逐字节不变） */
  font: FontFamily;
  /** 层条上色（关掉 = 中性色，条仍在、功能不动）—— 默认开 */
  layerBarColor: boolean;
  /** 分类底边条（默认关） */
  categoryBar: boolean;
}>({
  density: "comfortable",
  palette: "warm",
  iconSet: "lucide",
  blockSecondLine: "time",
  font: "default",
  layerBarColor: true,
  categoryBar: false,
});

/** 当前格高（px）—— 时间轴的手势数学与 CSS 都用它（预览断言逐档核对两边一致） */
export function slotHeightPx(): number {
  return DENSITY_SCALE[appearance.density].slotHeight;
}

/** 把当前外观写到 `<html data-*>`（属性驱动 CSS；重启后由设置读回来再落一次） */
function paint(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.density = appearance.density;
  root.dataset.palette = appearance.palette;
  root.dataset.layerColor = appearance.layerBarColor ? "on" : "off";
  root.dataset.categoryBar = appearance.categoryBar ? "on" : "off";
  root.dataset.font = appearance.font;
}

/**
 * 落一次外观（设置读回来 / 用户改完 / 写失败拨回都用它）。
 * 传 `undefined` 的字段保持当前值 —— 调用点不必每次给全。
 */
export function applyAppearance(next: {
  density?: unknown;
  palette?: unknown;
  iconSet?: unknown;
  blockSecondLine?: unknown;
  font?: unknown;
  layerBarColor?: unknown;
  categoryBar?: unknown;
}): void {
  if (next.density !== undefined) appearance.density = normalizeDensity(next.density);
  if (next.palette !== undefined) appearance.palette = normalizePalette(next.palette);
  if (next.iconSet !== undefined) appearance.iconSet = normalizeIconSet(next.iconSet);
  if (next.blockSecondLine !== undefined)
    appearance.blockSecondLine = normalizeSecondLine(next.blockSecondLine);
  if (next.font !== undefined) appearance.font = normalizeFontFamily(next.font);
  if (next.layerBarColor !== undefined) appearance.layerBarColor = next.layerBarColor === true;
  if (next.categoryBar !== undefined) appearance.categoryBar = next.categoryBar === true;
  paint();
}

// 时间轴格高：给纯函数模块注入一个**读 `$state` 的 getter** ——
// 于是「在 `$derived` 里调 secondsToPx」会自动建立依赖，密度一改几何全部重算。
setSlotHeightProvider(slotHeightPx);
