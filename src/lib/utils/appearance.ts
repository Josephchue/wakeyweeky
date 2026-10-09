import { normalizeHHMM, parseHHMM } from "./quiet";
import { NEW_PALETTE_PREVIEW } from "./palette-preview.gen";

/**
 * round76（3.1a）：**外观三选的前端唯一实现** —— 值域表 + 密度刻度 + 写入 `<html data-*>`。
 *
 * 三件事：
 * 1. 值域：`ui_density` / `ui_palette` / `ui_theme` 三键的合法值与默认值 —— 与 Rust
 *    `src-tauri/src/appearance.rs` 的常量必须逐字一致（跨语言对齐由预览断言盯着）。
 * 2. 密度刻度：**数字只在这里和 `tokens.css` 里各写一份**，预览断言逐档核对两边一致
 *    （CSS 读不出来的数字放这里给 JS 用；两侧不一致 = 红）。
 * 3. `<html>` 落点：`data-density` / `data-palette` / `data-layer-color`（深浅色不走属性 ——
 *    窗口主题由 Rust `set_theme` 设，CSS 只用 `prefers-color-scheme` 一条路径）。
 *
 * ⚠️ **跨语言对齐的真护栏**：`tools/visual/spacing-audit.mjs --check` 的「跨语言清单对齐」逐项比对
 * 这里的 `DENSITIES` / `THEMES` / `PALETTES` / `ICON_SETS` / `SECOND_LINES` 与
 * `src-tauri/src/appearance.rs` 的五个同名常量（round85 · 6b P2 补 —— 以前两边注释都声称「有断言盯着」，实际没有）。
 */

export const DENSITIES = ["compact", "comfortable", "loose"] as const;
export type Density = (typeof DENSITIES)[number];

export const THEMES = ["system", "light", "dark", "night"] as const;
export type Theme = (typeof THEMES)[number];

export const PALETTES = [
  "warm",
  "cool",
  "sage",
  // round85（0.31.0）：round84 的 9 套候选转内置（顺序 = 样张顺序）
  "endfield",
  "terminal",
  "deepsea",
  "bauhaus",
  "artdeco",
  "cassette",
  "north",
  "brutal",
  "porcelain",
] as const;
export type Palette = (typeof PALETTES)[number];

/** 图标集五套（round77）—— 与 Rust `appearance::ICON_SETS` 逐字一致 */
export const ICON_SETS = ["lucide", "tabler", "phosphor", "bootstrap", "material"] as const;
export type IconSet = (typeof ICON_SETS)[number];

/** 块内第二行两档（round77）—— 与 Rust `appearance::SECOND_LINES` 逐字一致 */
export const SECOND_LINES = ["time", "remaining"] as const;
export type SecondLine = (typeof SECOND_LINES)[number];

/**
 * 界面字体族五档（round87 · 3.3 字体方案）—— 与 Rust `appearance::FONT_FAMILIES` 逐字一致。
 * 拉丁永远先走 Segoe，只把 CJK 交给所选族（`体-02`）；五档全是系统自带（不打包中文）。
 */
export const FONT_FAMILIES = ["default", "song", "kai", "deng", "mono"] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

/** 默认档（你 2026-10-05 拍板：舒适 / 跟随系统 / 暖砂） */
export const DENSITY_DEFAULT: Density = "comfortable";
export const THEME_DEFAULT: Theme = "system";
export const PALETTE_DEFAULT: Palette = "warm";
/** 默认图标集 = Lucide（你 2026-10-05 拍板；其余四套也进产品） */
export const ICON_SET_DEFAULT: IconSet = "lucide";
/** 块内第二行默认 = 时间（= 旧行为） */
export const SECOND_LINE_DEFAULT: SecondLine = "time";
/** 界面字体族默认 = 默认档（= 今天的观感，逐字节不变） */
export const FONT_FAMILY_DEFAULT: FontFamily = "default";

/**
 * round78（3.1b₂ · 设-02）：**配色选择器的预览色** —— 现在是「一套配色的界面缩略」用的六个颜色
 * （背景 / 卡片 / 主色 / 块底 / 块描边 / 块字），**每套 × 亮/暗** 各一组。
 *
 * 为什么要在这里再写一份：预览要求**同时**显示三套配色的颜色，而页面只能有一个
 * `data-palette` —— 从 `getComputedStyle` 只能读到当前那一套。
 * 与 `DENSITY_SCALE` 同一套规矩：**值在这里与 `tokens.css` 各写一份，尺子逐值核对**
 *（`tools/visual/spacing-audit.mjs` 的「配色预览三方对齐」：3 套 × 2 主题 × 6 键 = **36 个值**）。
 * 改 tokens.css 的配色一定要同步改这里。
 *
 * round80（79-02）：从「三色格」改成「迷你界面小样」——依据（你 2026-10-06 拍板 + Pass B）：
 * 三套的卡片本来就同值、页底色差 < JND 2.3，而 warm↔cool 的主色只差 ΔE 3.75 —— 必须**并排看小样**才分得出来。
 *
 * round85（0.31.0）：9 套新配色的值由 `tools/visual/gen-palettes-85.mjs` **生成**
 *（`palette-preview.gen.ts`）—— 12 套 × 亮/暗 × 6 键 = **144 个值**（尺子：`spacing-audit.mjs --check`）。
 */
export type PalettePreview = {
  bg: string;
  card: string;
  accent: string;
  fill: string;
  line: string;
  ink: string;
};

const LEGACY_PALETTE_PREVIEW = {
  "warm-light": { bg: "#f6f3ef", card: "#ffffff", accent: "#0e6b52", fill: "#dff2ea", line: "#9dd0bc", ink: "#173a30" },
  "warm-dark": { bg: "#1a1917", card: "#242320", accent: "#4ec39b", fill: "#1e3b32", line: "#2f5c4c", ink: "#d9efe6" },
  "cool-light": { bg: "#f4f6f6", card: "#ffffff", accent: "#0b6b58", fill: "#dcefeb", line: "#9bcfc4", ink: "#123330" },
  "cool-dark": { bg: "#15191a", card: "#1f2425", accent: "#4fd0b4", fill: "#173732", line: "#2b5a51", ink: "#d3efea" },
  "sage-light": { bg: "#f5f5f1", card: "#ffffff", accent: "#4a6b5f", fill: "#e4ece7", line: "#b3c8bf", ink: "#22332c" },
  "sage-dark": { bg: "#191a18", card: "#222420", accent: "#8fbfae", fill: "#21302a", line: "#3b524a", ink: "#dcebe4" },
};

/** 12 套的完整小样表 = 老 3 套（手写，上面）+ 新 9 套（生成物）—— 任一套缺键 / 形状不对都是编译错 */
export const PALETTE_PREVIEW = {
  ...LEGACY_PALETTE_PREVIEW,
  ...NEW_PALETTE_PREVIEW,
} satisfies Record<`${Palette}-light` | `${Palette}-dark`, PalettePreview>;

/** 密度 → 尺寸刻度（px）。**必须与 `tokens.css` 第 3 层的三档字面量一致** */
export type DensityScale = {
  textMeta: number;
  textBody: number;
  textTitle: number;
  textLabel: number;
  rowHeight: number;
  slotHeight: number;
  controlHeight: number;
  timelineCol: number;
};

export const DENSITY_SCALE: Record<Density, DensityScale> = {
  compact: {
    textMeta: 12,
    textBody: 12,
    textTitle: 13,
    textLabel: 12,
    rowHeight: 28,
    slotHeight: 26,
    controlHeight: 24,
    timelineCol: 128,
  },
  comfortable: {
    textMeta: 12,
    textBody: 13,
    textTitle: 14,
    textLabel: 12,
    rowHeight: 32,
    slotHeight: 30,
    controlHeight: 28,
    timelineCol: 136,
  },
  loose: {
    textMeta: 13,
    textBody: 14,
    textTitle: 15,
    textLabel: 13,
    rowHeight: 36,
    slotHeight: 34,
    controlHeight: 32,
    timelineCol: 148,
  },
};

/** 刻度字段 ↔ CSS 变量名（预览断言按它逐档读 `getComputedStyle`） */
export const DENSITY_TOKEN: Record<keyof DensityScale, string> = {
  textMeta: "--text-meta",
  textBody: "--text-body",
  textTitle: "--text-title",
  textLabel: "--text-label",
  rowHeight: "--row-height",
  slotHeight: "--slot-height",
  controlHeight: "--control-height",
  timelineCol: "--timeline-col-width",
};

/** 只认合法值；缺省 / 坏值回默认（与 Rust `appearance::normalize` 同口径） */
export function normalizeChoice<T extends string>(
  choices: readonly T[],
  fallback: T,
  raw: unknown,
): T {
  const v = typeof raw === "string" ? raw.trim() : "";
  return (choices as readonly string[]).includes(v) ? (v as T) : fallback;
}

export const normalizeDensity = (raw: unknown): Density =>
  normalizeChoice(DENSITIES, DENSITY_DEFAULT, raw);
export const normalizeTheme = (raw: unknown): Theme => normalizeChoice(THEMES, THEME_DEFAULT, raw);
export const normalizePalette = (raw: unknown): Palette =>
  normalizeChoice(PALETTES, PALETTE_DEFAULT, raw);
export const normalizeIconSet = (raw: unknown): IconSet =>
  normalizeChoice(ICON_SETS, ICON_SET_DEFAULT, raw);
export const normalizeSecondLine = (raw: unknown): SecondLine =>
  normalizeChoice(SECOND_LINES, SECOND_LINE_DEFAULT, raw);
export const normalizeFontFamily = (raw: unknown): FontFamily =>
  normalizeChoice(FONT_FAMILIES, FONT_FAMILY_DEFAULT, raw);

/** `"1"` / `"0"` 口径的开关（层条上色默认开、分类底边条默认关） */
export const switchOn = (raw: unknown, fallback: boolean): boolean => {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (v === "1") return true;
  if (v === "0") return false;
  return fallback;
};

// ---------------------------------------------------------------------------
// round82（3.1c₂ · `淡-01…12`）：**夜间窗口的唯一实现**（纯函数）
//
// 两个功能读同一份数据（你 2026-10-06 拍「共用一个时段」）：
//   ① 时间轴的「非工作时段淡化带」（`night_dim` + 渲染层 `nightSegments`）
//   ② `ui_theme` 第四档 `night`（按时间切明暗：`themeForNow`）
// 断言与单测：`appearance.test.ts`；Rust 那侧只用于启动时解析（`appearance::sync_window_theme`），
// 两边同一套区间口径（`淡-06` 四条边界）。
// ---------------------------------------------------------------------------

/** 夜间时段默认（你 2026-10-07 拍：淡-07）—— 与 Rust `appearance::NIGHT_START_DEFAULT` 逐字一致 */
export const NIGHT_START_DEFAULT = "22:00";
export const NIGHT_END_DEFAULT = "06:00";

/** 夜间时段归一：合法 `HH:MM` 规范成零填充，坏值 / 缺省回默认（写库前与读库后都过这一道） */
export function normalizeNightStart(raw: unknown): string {
  const v = typeof raw === "string" ? normalizeHHMM(raw) : null;
  return v ?? NIGHT_START_DEFAULT;
}
export function normalizeNightEnd(raw: unknown): string {
  const v = typeof raw === "string" ? normalizeHHMM(raw) : null;
  return v ?? NIGHT_END_DEFAULT;
}

const MINUTES_A_DAY = 1440;

/** `HH:MM` → 一天内的分钟数；坏值回落到该端的默认值 */
function minutesOf(hhmm: string, fallback: string): number {
  const parsed = parseHHMM(hhmm) ?? parseHHMM(fallback);
  return parsed ? parsed.hour * 60 + parsed.minute : 0;
}

/** 本地时刻的分钟数（0–1439）—— 判定的唯一入口（测试可直接给分钟数） */
export function minutesOfDay(now: Date | number): number {
  const d = now instanceof Date ? now : new Date(now);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * `[start, end)` 分钟区间（`淡-06` 四条边界）：
 * - 普通（`start < end`）：区间内为夜；
 * - **跨天**（`start > end`）：`m >= start || m < end`（默认 `22:00–06:00` 就是这种）；
 * - **退化**（`start === end`）：视为全天关闭（不淡、也不切深色）。
 */
export function inNightWindow(minutes: number, start: string, end: string): boolean {
  const s = minutesOf(start, NIGHT_START_DEFAULT);
  const e = minutesOf(end, NIGHT_END_DEFAULT);
  if (s === e) return false;
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

/** 这个时刻在夜里吗（`淡-04`：第四档主题与淡化带共用同一判定） */
export function isNightNow(now: Date | number, start: string, end: string): boolean {
  return inNightWindow(minutesOfDay(now), start, end);
}

/** 第四档「按时间」的目标主题：夜里深色 / 白天亮色（`淡-04`） */
export function themeForNow(now: Date | number, start: string, end: string): "light" | "dark" {
  return isNightNow(now, start, end) ? "dark" : "light";
}

/**
 * 一天的淡化段（分钟，`[from, to)`）：普通 1 段 · 跨天 2 段 · 退化 0 段。
 * 渲染层拿它除以 `MINUTES_A_DAY` 算位置（`淡-12`：纯 CSS，百分比定位跟着缩放走）。
 */
export function nightSegments(start: string, end: string): { from: number; to: number }[] {
  const s = minutesOf(start, NIGHT_START_DEFAULT);
  const e = minutesOf(end, NIGHT_END_DEFAULT);
  if (s === e) return [];
  if (s < e) return [{ from: s, to: e }];
  return [
    { from: s, to: MINUTES_A_DAY },
    { from: 0, to: e },
  ];
}
