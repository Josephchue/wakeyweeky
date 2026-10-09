/**
 * round78（3.1b₂ · Step 3-b / 9.0）：生成**设计样张**对照图。
 *
 * 产物：`docs/visual/round78-设置IA对照图.html`（自包含、直接双击打开）。
 * 内容 = 两处结构改动的「先看版」（你 2026-10-06 批注：出设计样张给我看，批了再做）：
 *   A. 设置页 IA（现结构 vs 5 组 + 更多 · 三处预览选择器 · 行结构 ↔ 间距）
 *   B. `?` 快捷键总表面板（真实尺寸 · 560/640/780 三档 · 与设置并排 · 窄窗）
 *
 * 为什么用生成器：样张里的**配色 / 图标 / 键表 / 行高 / 文案**都从源码读（`tokens.css` /
 * `src/lib/icons/sets/*.ts` / `keyboard-help.ts` / `messages/zh.json`）—— 源码一改，重跑即同步，
 * 不手抄死值（approve 前最后一次跑 = 与仓库一致）。
 *
 * 用法：`node tools/visual/design-sample-78.mjs`（无依赖、只读源文件）
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = process.cwd();
const read = (p) => readFileSync(`${root}/${p}`, "utf8");

// ---------------------------------------------------------------- 1. token（配色 + 密度）

const tokens = read("src/lib/styles/tokens.css");

/** 抓一个 `:root[data-palette="x"]` 块里的 `--k: v;` */
function paletteBlock(name) {
  const start = tokens.indexOf(`:root[data-palette="${name}"]`);
  if (start < 0) throw new Error(`没有 data-palette="${name}"`);
  const end = tokens.indexOf("\n}", start);
  return Object.fromEntries(
    [...tokens.slice(start, end).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
}

const WANTED = ["bg", "card", "text-primary", "text-secondary", "text-tertiary", "accent", "warn"];
const PALETTES = {
  warm: { label: "暖砂", tip: "默认", light: paletteBlock("warm"), dark: paletteBlock("warm", true) },
  cool: { label: "冷白", light: paletteBlock("cool"), dark: paletteBlock("cool") },
  sage: { label: "素灰绿", light: paletteBlock("sage"), dark: paletteBlock("sage") },
};
// 暗色块在 `@media (prefers-color-scheme: dark)` 里，第一个匹配到的是别家 —— 逐块抠
for (const name of Object.keys(PALETTES)) {
  const marker = `:root[data-palette="${name}"]`;
  const darkStart = tokens.indexOf(marker, tokens.indexOf("@media (prefers-color-scheme: dark)"));
  const darkEnd = tokens.indexOf("\n  }", darkStart);
  const dark = Object.fromEntries(
    [...tokens.slice(darkStart, darkEnd).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
  PALETTES[name].dark = dark;
  for (const k of WANTED) if (!PALETTES[name].light[k] || !PALETTES[name].dark[k]) {
    throw new Error(`${name} 缺 --${k}`);
  }
}

/** 密度三档：基块（无 data-density = 舒适，含 `--text-*` / `--row-height` 的那段）+ compact + loose */
function densityBlock(attr) {
  const start = attr
    ? tokens.indexOf(`:root[data-density="${attr}"]`)
    : tokens.indexOf("--text-meta: 12px; /* 刻度");
  const end = tokens.indexOf("\n}", start);
  if (start < 0 || end < 0) throw new Error(`密度块读不到：${attr ?? "base"}`);
  return Object.fromEntries(
    [...tokens.slice(start, end).matchAll(/--(text-[a-z]+|row-height|control-height|space-\d):\s*([^;]+);/g)].map((m) => [
      m[1],
      m[2].trim(),
    ]),
  );
}
const DENSITY = {
  compact: { label: "紧凑", v: densityBlock("compact") },
  comfortable: { label: "舒适", v: densityBlock(null), tip: "默认" },
  loose: { label: "宽松", v: densityBlock("loose") },
};

const SPACE = { 1: "4px", 2: "8px", 3: "12px", 4: "16px", 5: "24px", 6: "32px" };
void SPACE;

// ---------------------------------------------------------------- 2. 图标五套（真 SVG，与 Icon.svelte 同一套属性）

function iconSet(name) {
  const src = read(`src/lib/icons/sets/${name}.ts`);
  const viewBox = (src.match(/export const VIEW_BOX = "([^"]+)"/) ?? [])[1];
  const fill = (src.match(/export const DEFAULT_FILL = "([^"]*)"/) ?? [])[1];
  const stroke = (src.match(/export const DEFAULT_STROKE = "([^"]*)"/) ?? [])[1];
  const strokeWidth = (src.match(/export const STROKE_WIDTH = (\d+)/) ?? [])[1];
  // PATHS 对象体：从 `export const PATHS = {` 到文件末尾的 `};`（后面还有 keyHelpRows 之类的东西 → 逐项正则）
  const paths = {};
  const rect = src.slice(src.indexOf("export const PATHS"));
  for (const m of rect.matchAll(/^  "([a-z0-9-]+)":\s*\[([\s\S]*?)\n  \],/gm)) {
    const name = m[1];
    const body = m[2];
    const items = [...body.matchAll(/\{\s*d:\s*"((?:[^"\\]|\\.)*)"([^}]*)\}/g)].map((k) => ({
      d: k[1],
      extra: k[2],
    }));
    paths[name] = items;
  }
  return { name, viewBox, fill, stroke, strokeWidth, paths };
}

const SETS = ["lucide", "tabler", "phosphor", "bootstrap", "material"].map(iconSet);
const SET_LABEL = { lucide: "Lucide", tabler: "Tabler", phosphor: "Phosphor", bootstrap: "Bootstrap", material: "Material" };

function svg(set, name, size = 16) {
  const d = set.paths[name];
  if (!d) throw new Error(`${set.name}: 没有 ${name}`);
  const path = [];
  for (const p of d) {
    const extra = p.extra ?? "";
    const fill = (extra.match(/"fill":\s*"([^"]+)"/) ?? [])[1] ?? set.fill;
    const stroke = (extra.match(/"stroke":\s*"([^"]+)"/) ?? [])[1] ?? set.stroke;
    const sw = (extra.match(/"strokeWidth":\s*([\d.]+)/) ?? [])[1] ?? set.strokeWidth;
    const paint = stroke === "none" ? "" : ` stroke="${stroke}" stroke-width="${sw}"`;
    path.push(`<path d="${p.d}" fill="${fill}"${paint}/>`);
  }
  const paths = path.join("");
  return `<svg class="ic" width="${size}" height="${size}" viewBox="${set.viewBox}" fill="${set.fill}"${
    set.stroke === "none" ? "" : ` stroke="${set.stroke}" stroke-width="${set.strokeWidth}"`
  } stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const ICON_NAMES = Object.keys(SETS[0].paths);
if (ICON_NAMES.length !== 40) throw new Error(`语义名不是 40 个：${ICON_NAMES.length}`);

// ---------------------------------------------------------------- 3. 键表（KEY_HELP 同一份数据）

function parseKeyHelp() {
  const src = read("src/lib/utils/keyboard-help.ts");
  const sections = [];
  for (const m of src.matchAll(/group:\s*"([^"]+)",\s*rows:\s*\[([\s\S]*?)\n    \],/g)) {
    const rows = [...m[2].matchAll(/\[([^\]]+)\]/g)].map((r) =>
      r[1]
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .filter(Boolean),
    );
    sections.push({ group: m[1], rows });
  }
  if (sections.length !== 7) throw new Error(`键表不是 7 组：${sections.length}`);
  return sections;
}
const zh = (() => {
  try {
    return JSON.parse(read("messages/zh.json"));
  } catch (err) {
    throw new Error(`messages/zh.json 读不了 / 不是合法 JSON：${err.message}`);
  }
})();
const msg = (k) => zh[k] ?? `⟪缺 ${k}⟫`;
const KEY_HELP = parseKeyHelp();

// ---------------------------------------------------------------- 4. 设置面板内容（现状 vs 新 IA）

/** 设置行：`kind` 决定控件画法（check / select / seg / time / number / button / preview / hint / nav） */
const CURRENT_SECTIONS = [
  {
    title: msg("ui.sanity_settings.111"),
    rows: [{ kind: "select", label: msg("ui.sanity_settings.112"), value: "简体中文", options: ["简体中文", "English"] }],
  },
  {
    title: msg("ui.sanity_settings.24"),
    rows: [{ kind: "buttons", label: "打开说明页 · 重看新手卡片 · 重新打开渐进提示", buttons: ["打开说明页", "重看新手卡片", "重新打开渐进提示"] }],
  },
  {
    title: msg("ui.sanity_settings.30"),
    rows: [
      { kind: "check", label: msg("ui.sanity_settings.31"), on: true, tail: "提前 10 分钟" },
      { kind: "check", label: msg("ui.sanity_settings.33"), on: false },
      { kind: "select", label: "复盘提醒", value: "周日 20:00 · 先提示", options: ["先提示", "直接打开", "关"] },
      { kind: "buttons", label: "免打扰", buttons: ["30 分钟", "1 小时", "到明早", "自定义…"] },
      { kind: "time", label: "「到明早」的时刻", value: "08:00" },
      { kind: "check", label: msg("ui.sanity_settings.48"), on: false, sub: true },
      { kind: "hint", text: msg("ui.sanity_settings.51") },
    ],
  },
  {
    title: msg("ui.sanity_settings.53"),
    rows: [
      { kind: "number", label: msg("ui.sanity_settings.54"), value: "8", unit: "小时" },
      { kind: "check", label: msg("ui.sanity_settings.56"), on: true },
      { kind: "hint", text: msg("ui.sanity_settings.57") },
    ],
  },
  {
    title: msg("ui.sanity_settings.58"),
    rows: [
      { kind: "check", label: msg("ui.sanity_settings.60"), on: true },
      { kind: "hint", text: msg("ui.sanity_settings.61") },
      { kind: "select", label: msg("ui.sanity_settings.62"), value: "常显", options: ["常显", "不显示"] },
      { kind: "select", label: msg("ui.sanity_settings.115"), value: "舒适", options: ["紧凑", "舒适", "宽松"] },
      { kind: "select", label: msg("ui.sanity_settings.120"), value: "跟随系统", options: ["跟随系统", "亮", "暗"] },
      { kind: "select", label: msg("ui.sanity_settings.125"), value: "暖砂", options: ["暖砂", "冷白", "素灰绿"] },
      { kind: "check", label: "层条上色", on: true },
      { kind: "check", label: "分类底边条", on: false },
      { kind: "select", label: msg("ui.sanity_settings.134"), value: "Lucide", options: ["Lucide", "Tabler", "Phosphor", "Bootstrap", "Material"] },
      { kind: "select", label: msg("ui.sanity_settings.136"), value: "时间", options: ["时间", "剩余分钟"] },
    ],
  },
  {
    title: msg("ui.sanity_settings.66"),
    rows: [
      { kind: "check", label: "成就会解锁并在角落提示", on: true },
      { kind: "button", label: "已点亮 12 / 98", buttons: ["查看成就"] },
      { kind: "check", label: "解锁时弹提示", on: true },
    ],
  },
  {
    title: msg("ui.sanity_settings.72"),
    rows: [{ kind: "buttons", label: "备份 / 导出 / 便携", buttons: ["导出备份…", "从备份恢复…", "导出 .ics…", "数据位置切换…"] }],
  },
  {
    title: msg("ui.sanity_settings.85"),
    rows: [{ kind: "collapse", label: "▸ 展开 15 行功能开关", buttons: ["键盘快捷键 ✓", "剪贴板手势 ✓", "每周重复 ✓", "全局快捷键 ✓", "计划任务 ✓", "漂移 ✓", "模板 ✓", "复盘 ✓", "统计 ✓", "成就 ✓", "提示 ✓", "多选 ✓", "序列 ✓", "理智值 ✓", "成就提示 ✓"] }],
  },
  {
    title: msg("ui.sanity_settings.93"),
    rows: [{ kind: "collapse", label: "▸ 显示键位表（七组）", buttons: [] }],
  },
];

/** 新 IA：5 组 + 更多折叠（成稿见样张 §A2） */
const NEW_GROUPS = [
  {
    id: "theme",
    title: "主题与颜色",
    rows: [
      { kind: "preview-palette", label: msg("ui.sanity_settings.125") },
      { kind: "seg", label: msg("ui.sanity_settings.120"), value: "跟随系统", options: ["跟随系统", "亮", "暗"] },
      { kind: "preview-icon", label: msg("ui.sanity_settings.134") },
      { kind: "check", label: "层条上色", on: true, hint: msg("ui.sanity_settings.131") },
      { kind: "check", label: "分类底边条", on: false, hint: msg("ui.sanity_settings.133") },
      { kind: "select", label: msg("ui.sanity_settings.112"), value: "简体中文", options: ["简体中文", "English"], hint: "（放在本组末行：切语言是设置自己的事，不塞进「更多」）" },
    ],
  },
  {
    id: "density",
    title: "字号与密度",
    rows: [
      { kind: "preview-density", label: msg("ui.sanity_settings.115") },
      { kind: "hint", text: msg("ui.sanity_settings.119") },
    ],
  },
  {
    id: "timeline",
    title: "时间轴",
    rows: [
      { kind: "select", label: msg("ui.sanity_settings.136"), value: "时间", options: ["时间", "剩余分钟"] },
      { kind: "check", label: msg("ui.sanity_settings.60"), on: true },
      { kind: "check", label: "现在线", on: true, hint: "今天那一列画一条细线，告诉你此刻在哪。" },
    ],
  },
  {
    id: "alert",
    title: "提醒与控制",
    rows: [
      { kind: "check", label: msg("ui.sanity_settings.31"), on: true, tail: "提前 10 分钟" },
      { kind: "check", label: msg("ui.sanity_settings.33"), on: false },
      { kind: "select", label: "复盘提醒", value: "周日 20:00 · 先提示", options: ["先提示", "直接打开", "关"] },
      { kind: "buttons", label: "免打扰", buttons: ["30 分钟", "1 小时", "到明早", "自定义…"] },
      { kind: "select", label: msg("ui.sanity_settings.62"), value: "常显", options: ["常显", "不显示"] },
    ],
  },
  {
    id: "more",
    title: "更多",
    collapsed: true,
    rows: [
      { kind: "accordion", label: "功能开关（15 行）" },
      { kind: "accordion", label: "成就（暗章）" },
      { kind: "accordion", label: "数据（备份 / 导出 / 便携）" },
      { kind: "accordion", label: "引导与教程" },
      { kind: "accordion", label: "键位说明" },
      { kind: "accordion", label: "理智值 / 提醒细节" },
    ],
  },
];

// ---------------------------------------------------------------- 5. 静态部分

const CSS = `
:root {
  --bg: #f6f3ef; --card: #ffffff; --ink: #211d18; --ink2: #5d574e; --ink3: #767065;
  --accent: #0e6b52; --line: #d8d2c8; --line-strong: #b3aca1; --scrim: rgba(33,29,24,.35);
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px;
  --radius: 4px; --radius-lg: 8px;
  --row: 32px; --ctrl: 28px; --text-body: 13px; --text-title: 14px; --text-small: 12px;
  --panel-w: 640px; --page: 1160px;
  font-size: 15px;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: #efece7; color: var(--ink);
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; font-size: 14px; line-height: 1.55; }
.page { width: min(var(--page), calc(100vw - 48px)); margin: 0 auto; padding: var(--s6) 0 96px; }
h1 { font-size: 24px; margin: 0 0 var(--s2); }
h2 { font-size: 19px; margin: var(--s6) 0 var(--s3); padding-bottom: var(--s2); border-bottom: 2px solid var(--line-strong); }
h3 { font-size: 15px; margin: var(--s5) 0 var(--s2); }
p.lead { color: var(--ink2); margin: 0 0 var(--s4); }
p.note { color: var(--ink3); font-size: 13px; margin: var(--s2) 0 var(--s4); }
.grid { display: grid; gap: var(--s4); }
.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: var(--s4); }
.card > h4 { margin: 0 0 var(--s2); font-size: 14px; }
.tag { display: inline-block; padding: 1px 6px; border-radius: 999px; background: #e7e2da; color: var(--ink2);
  font-size: 11px; margin-left: var(--s2); vertical-align: 1px; }
.tag.ok { background: #d9efe6; color: #0b6047; }
.tag.warn { background: #fbe6d8; color: #a5440c; }
.tag.todo { background: #e5e9f0; color: #3d5164; }
.rule { border: none; border-top: 1px dashed var(--line-strong); margin: var(--s4) 0; }
.mono { font-family: "Cascadia Mono", Consolas, monospace; font-size: 12px; }
.kbd { display: inline-block; min-width: 1.6em; padding: 0 5px; border: 1px solid var(--line-strong);
  border-bottom-width: 2px; border-radius: 4px; background: #fbfaf8; font-size: 11px; line-height: 18px;
  font-family: "Cascadia Mono", Consolas, monospace; white-space: nowrap; }

/* —— 真面板复刻（设置 / ?）：尺寸与间距一律走 token 值 —— */
.panel { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-lg);
  box-shadow: 0 12px 32px rgba(33,29,24,.14); overflow: hidden; }
.panel + .panel { margin-top: var(--s4); }
.panel-head { display: flex; align-items: center; gap: var(--s2); padding: var(--s3) var(--s4);
  border-bottom: 1px solid var(--line); }
.panel-head h4 { margin: 0; font-size: var(--text-title); font-weight: 600; }
.panel-head .x { margin-left: auto; width: 28px; height: 28px; display: grid; place-items: center;
  border: 1px solid var(--line); border-radius: var(--radius); background: none; color: var(--ink2); }
.panel-nav { display: flex; flex-wrap: wrap; gap: var(--s1); padding: var(--s2) var(--s4);
  border-bottom: 1px solid var(--line); background: #fbfaf8; }
.panel-nav span { padding: 2px 8px; border: 1px solid transparent; border-radius: 999px; font-size: 12px; color: var(--ink2); }
.panel-nav span.on { border-color: var(--line-strong); background: var(--card); color: var(--ink); font-weight: 600; }
.panel-body { max-height: 520px; overflow: auto; padding: var(--s3) var(--s4) var(--s4); }
.sec { margin: var(--s4) 0 var(--s2); font-size: var(--text-title); font-weight: 600; color: var(--ink); }
.sec:first-child { margin-top: var(--s1); }
.sec .tag { font-weight: 400; }

/* 行结构（设-03）：两段式 = 标签行 + 控件行；开关 = 单行 */
.row { display: flex; flex-direction: column; gap: var(--s1); padding: var(--s2) 0; border-bottom: 1px solid #f0ede8; }
.row:last-child { border-bottom: none; }
.row .label { color: var(--ink); font-size: var(--text-body); }
.row .hint { color: var(--ink3); font-size: var(--text-small); }
.row .ctrl { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); }
.row.switch { flex-direction: row; flex-wrap: wrap; align-items: center; gap: var(--s2) var(--s3); }
.row.switch .label { flex: 1 1 220px; }
.row.sub { margin-left: var(--s3); padding-left: var(--s3); border-left: 2px solid #e7e2da; }
.seg { display: inline-flex; border: 1px solid var(--line-strong); border-radius: var(--radius); overflow: hidden; }
.seg button { border: none; background: none; padding: 0 var(--s3); height: var(--ctrl); font: inherit;
  font-size: var(--text-body); color: var(--ink2); cursor: pointer; }
.seg button.on { background: var(--accent); color: #fff; font-weight: 600; }
select, input.num { height: var(--ctrl); border: 1px solid var(--line-strong); border-radius: var(--radius);
  background: #fbfaf8; color: var(--ink); font: inherit; font-size: var(--text-body); padding: 0 var(--s2); }
.btn { height: var(--ctrl); padding: 0 var(--s3); border: 1px solid var(--line-strong); border-radius: var(--radius);
  background: none; color: var(--ink); font: inherit; font-size: var(--text-body); }
.bar { height: var(--row); display: flex; align-items: center; gap: var(--s2); padding: 0 var(--s3);
  background: #fbfaf8; border: 1px dashed var(--line-strong); border-radius: var(--radius);
  color: var(--ink3); font-size: var(--text-small); width: 100%; }

/* —— 预览选择器（设-02）—— */
.palettes { display: flex; flex-wrap: wrap; gap: var(--s2); }
.palette { display: flex; flex-direction: column; gap: var(--s1); align-items: center; padding: var(--s2);
  border: 1px solid var(--line-strong); border-radius: var(--radius); background: #fbfaf8; cursor: pointer; }
.palette.on { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(14,107,82,.18); }
.palette .chips { display: flex; border-radius: 3px; overflow: hidden; border: 1px solid var(--line); }
.palette .chip { width: 22px; height: 22px; }
.palette .name { font-size: 11px; color: var(--ink2); }
.icon-sets { display: flex; flex-wrap: wrap; gap: var(--s2); }
.icon-set { display: flex; flex-direction: column; gap: var(--s1); align-items: center; padding: var(--s2);
  border: 1px solid var(--line-strong); border-radius: var(--radius); background: #fbfaf8; cursor: pointer; }
.icon-set.on { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(14,107,82,.18); }
.icon-set .mini { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; color: var(--ink); }
.icon-set .name { font-size: 11px; color: var(--ink2); }
.densities { display: flex; flex-wrap: wrap; gap: var(--s2); }
.density { display: flex; flex-direction: column; gap: var(--s1); padding: var(--s2); min-width: 120px;
  border: 1px solid var(--line-strong); border-radius: var(--radius); background: #fbfaf8; cursor: pointer; }
.density.on { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(14,107,82,.18); }
.density .sample { display: flex; align-items: center; padding: 0 var(--s2); border-radius: 3px;
  background: #dff2ea; color: #173a30; white-space: nowrap; overflow: hidden; }
.density .name { font-size: 11px; color: var(--ink2); }
.density .meta { font-size: 10px; color: var(--ink3); font-family: "Cascadia Mono", Consolas, monospace; }

/* —— 键表（与设置里那张同一套口径）—— */
table.keys { border-collapse: collapse; width: 100%; font-size: var(--text-small); line-height: 1.5; }
table.keys th, table.keys td { text-align: left; padding: 2px var(--s2) 2px 0; vertical-align: top; }
table.keys tr.grp td { padding-top: var(--s3); color: var(--ink3); font-weight: 600; }
table.keys td.kk { white-space: nowrap; }
table.keys td:last-child { color: var(--ink2); padding-right: 0; }

/* —— 覆盖面板演示（真尺寸）—— */
.stage { position: relative; background: #e9e5df; border: 1px solid var(--line); border-radius: var(--radius-lg);
  overflow: hidden; }
.stage .app { padding: var(--s3); opacity: .55; }
.stage .app .bar2 { height: 44px; background: var(--card); border-radius: var(--radius); margin-bottom: var(--s2); }
.stage .app .body2 { height: 180px; background: repeating-linear-gradient(0deg, transparent 0 27px, #d8d2c8 27px 28px); }
.overlay-live { position: absolute; top: 24px; left: 48px; }
.overlay-live .backdrop { position: absolute; inset: -24px -48px; background: var(--scrim); }
.panel.live { position: relative; box-shadow: 0 18px 48px rgba(33,29,24,.3); }
.width-label { margin-top: var(--s1); color: var(--ink3); font-size: 12px; }

/* —— 窄窗演示（715）—— */
.narrow-stage { width: 715px; max-width: 100%; }
.narrow-stage .panel.live { width: 683px; }
.narrow-stage .wrap { padding: var(--s3); background: #e9e5df; border: 1px solid var(--line); border-radius: var(--radius-lg); }

/* —— 层级 / 间距标注 —— */
.spec { display: flex; align-items: baseline; gap: var(--s2); font-size: 12px; color: var(--ink3); }
.spec b { color: var(--ink); }
.legend { display: flex; gap: var(--s4); flex-wrap: wrap; font-size: 12px; color: var(--ink2); margin: var(--s2) 0 0; }
.legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 2px;
  margin-right: 4px; vertical-align: -1px; background: var(--accent); }
.legend .l2::before { background: #a67200; }
.legend .l3::before { background: #5d574e; }
`;

// ---------------------------------------------------------------- 6. 渲染小件

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

function renderRow(row) {
  const L = `<div class="label">${rich(row.label ?? "")}</div>`;
  switch (row.kind) {
    case "check": {
      const box = `<span class="kbd" style="border-radius:3px">${row.on ? "✓" : ""}</span>`;
      return `<div class="row switch${row.sub ? " sub" : ""}">
        <span style="display:flex;align-items:center;gap:8px">${box}<span class="label" style="flex:none">${rich(row.label)}</span></span>
        <span style="flex:1 1 120px"></span>
        ${row.tail ? `<span class="hint">${esc(row.tail)}</span>` : ""}
      </div>`;
    }
    case "select":
      return `<div class="row">${L}<div class="ctrl"><select><option>${esc(row.value)}</option>${(row.options ?? [])
        .filter((o) => o !== row.value)
        .map((o) => `<option>${esc(o)}</option>`)
        .join("")}</select></div></div>`;
    case "seg":
      return `<div class="row">${L}<div class="ctrl"><span class="seg">${(row.options ?? [])
        .map((o) => `<button${o === row.value ? ' class="on"' : ""}>${esc(o)}</button>`)
        .join("")}</span></div></div>`;
    case "number":
      return `<div class="row">${L}<div class="ctrl"><input class="num" value="${esc(row.value)}" size="4"/>${
        row.unit ? `<span class="hint">${esc(row.unit)}</span>` : ""
      }</div></div>`;
    case "time":
      return `<div class="row">${L}<div class="ctrl"><input class="num" value="${esc(row.value)}" size="6"/></div></div>`;
    case "buttons":
      return `<div class="row">${L}<div class="ctrl">${(row.buttons ?? []).map((b) => `<button class="btn">${esc(b)}</button>`).join("")}</div></div>`;
    case "button":
      return `<div class="row">${L}<div class="ctrl">${(row.buttons ?? []).map((b) => `<button class="btn">${esc(b)}</button>`).join("")}</div></div>`;
    case "collapse":
      return `<div class="row">${L}<div class="ctrl">${
        (row.buttons ?? []).length
          ? (row.buttons ?? []).map((b) => `<span class="kbd" style="font-family:inherit">${esc(b)}</span>`).join("")
          : '<span class="bar">（点开显示七组键位表）</span>'
      }</div></div>`;
    case "accordion":
      return `<div class="row"><div class="bar" style="justify-content:space-between"><span>▸ ${esc(row.label)}</span><span class="hint">展开</span></div></div>`;
    case "hint":
      return `<p class="hint" style="padding:4px 0">${rich(row.text)}</p>`;
    case "preview-palette":
      return `<div class="row">${L}<div class="ctrl"><div class="palettes">${Object.entries(PALETTES)
        .map(
          ([key, p]) =>
            `<span class="palette${key === "warm" ? " on" : ""}"><span class="chips">${["bg", "card", "accent"]
              .map((c) => `<span class="chip" style="background:${p.light[c]}"></span>`)
              .join("")}</span><span class="name">${esc(p.label)}${p.tip ? "（默认）" : ""}</span></span>`,
        )
        .join("")}</div></div></div>`;
    case "preview-icon":
      return `<div class="row">${L}<div class="ctrl"><div class="icon-sets">${SETS.map(
        (s) =>
          `<span class="icon-set${s.name === "lucide" ? " on" : ""}"><span class="mini">${["settings", "check", "calendar-days", "bell", "sun", "database"]
            .map((n) => svg(s, n, 16))
            .join("")}</span><span class="name">${esc(SET_LABEL[s.name])}${s.name === "lucide" ? "（默认）" : ""}</span></span>`,
      ).join("")}</div></div></div>`;
    case "preview-density":
      return `<div class="row">${L}<div class="ctrl"><div class="densities">${Object.entries(DENSITY)
        .map(
          ([key, d]) =>
            `<span class="density${key === "comfortable" ? " on" : ""}">
              <span class="sample" style="height:${d.v["row-height"]}; font-size:${d.v["text-body"]}">任务名称 · 还剩 25 分</span>
              <span class="name">${d.label}${d.tip ? "（默认）" : ""}</span>
              <span class="meta">行高 ${d.v["row-height"]}</span></span>`,
        )
        .join("")}</div></div></div>`;
    default:
      return `<div class="row">${L}</div>`;
  }
}

function renderPanelCurrent() {
  return `<div class="panel">
    <div class="panel-head"><h4>设置</h4><span class="tag warn">现状：滚 9 个分区</span><span class="x">✕</span></div>
    <div class="panel-body">
      ${CURRENT_SECTIONS.map(
        (s) => `<h5 class="sec">${esc(s.title)}</h5>${s.rows.map(renderRow).join("")}`,
      ).join("")}
      <div style="margin-top:16px"><button class="btn" style="width:100%">关闭</button></div>
    </div>
  </div>`;
}

function renderPanelNew() {
  const more = NEW_GROUPS.find((g) => g.id === "more");
  return `<div class="panel">
    <div class="panel-head"><h4>设置</h4><span class="tag ok">新 IA：5 组 + 更多</span><span class="x">✕</span></div>
    <div class="panel-nav">${NEW_GROUPS.map((g, i) => `<span${i === 0 ? ' class="on"' : ""}>${esc(g.title)}</span>`).join("")}</div>
    <div class="panel-body">
      ${NEW_GROUPS.filter((g) => g.id !== "more")
        .map((g) => `<h5 class="sec">${esc(g.title)}</h5>${g.rows.map(renderRow).join("")}`)
        .join("")}
      <h5 class="sec">${esc(more.title)} <span class="tag todo">默认收起</span></h5>
      ${more.rows.map(renderRow).join("")}
    </div>
  </div>`;
}

function renderKeysPanel({ width, showWidth } = {}) {
  const rows = KEY_HELP.map(
    (s) =>
      `<tr class="grp"><td colspan="2">${esc(msg(s.group))}</td></tr>` +
      s.rows
        .map(
          ([keys, label]) =>
            `<tr><td class="kk"><span class="kbd">${esc(keys.startsWith("msg.") ? msg(keys) : keys)}</span></td><td>${esc(
              msg(label),
            )}</td></tr>`,
        )
        .join(""),
  ).join("");
  return `<div class="panel${showWidth ? " live" : ""}" style="${width ? `width:${width}px;` : ""}">
    <div class="panel-head"><h4>快捷键</h4><span class="tag">? 打开 · Esc 关一层</span><span class="x">✕</span></div>
    <div class="panel-body"><table class="keys"><tbody>${rows}</tbody></table></div>
  </div>`;
}

function renderPaletteCards() {
  return `<div class="grid three">${Object.entries(PALETTES)
    .map(
      ([, p]) => `<div class="card">
      <h4>${esc(p.label)}${p.tip ? ' <span class="tag ok">默认</span>' : ""}</h4>
      <div style="border-radius:var(--radius); overflow:hidden; border:1px solid var(--line)">
        <div style="background:${p.light.bg}; padding:12px">
          <div style="background:${p.light.card}; border:1px solid ${p.light["text-tertiary"]}33; border-radius:6px; padding:10px">
            <div style="color:${p.light["text-primary"]}; font-weight:600">任务名称</div>
            <div style="color:${p.light["text-secondary"]}; font-size:12px">09:00 – 10:30 · 还剩 25 分</div>
            <div style="margin-top:8px; display:flex; gap:6px">
              <span style="background:${p.light.accent}; color:#fff; border-radius:4px; padding:2px 8px; font-size:12px">完成</span>
              <span style="border:1px solid ${p.light.accent}; color:${p.light.accent}; border-radius:4px; padding:2px 8px; font-size:12px">拿起</span>
            </div>
          </div>
        </div>
        <div style="background:${p.dark.bg}; padding:12px; border-top:1px solid ${p.dark["text-tertiary"]}33">
          <div style="background:${p.dark.card}; border-radius:6px; padding:10px">
            <div style="color:${p.dark["text-primary"]}; font-weight:600">任务名称（暗）</div>
            <div style="color:${p.dark["text-secondary"]}; font-size:12px">09:00 – 10:30 · 还剩 25 分</div>
          </div>
        </div>
      </div>
      <p class="mono" style="color:var(--ink3); margin:8px 0 0">亮 bg ${p.light.bg} · accent ${p.light.accent} ／ 暗 bg ${p.dark.bg} · accent ${p.dark.accent}</p>
    </div>`,
    )
    .join("")}</div>`;
}

function renderIconGrid() {
  return `<div class="grid" style="grid-template-columns: repeat(5, minmax(0, 1fr))">${SETS.map(
    (s) => `<div class="card">
      <h4>${esc(SET_LABEL[s.name])}${s.name === "lucide" ? ' <span class="tag ok">默认</span>' : ""}</h4>
      <div style="display:grid; grid-template-columns: repeat(8, 1fr); gap:6px; color:var(--ink)">${ICON_NAMES.map(
        (n) => `<span title="${n}">${svg(s, n, 16)}</span>`,
      ).join("")}</div>
    </div>`,
  ).join("")}</div>`;
}

function renderDensityCards() {
  return `<div class="grid three">${Object.values(DENSITY)
    .map(
      (d) => `<div class="card">
      <h4>${d.label}${d.tip ? ' <span class="tag ok">默认</span>' : ""}</h4>
      <div style="display:flex; flex-direction:column; gap:6px; font-size:${d.v["text-body"]}">
        <span class="bar" style="height:${d.v["row-height"]}; border-style:solid; color:var(--ink)">Backlog 行 / 设置行</span>
        <span class="bar" style="height:${d.v["control-height"]}; border-style:solid; color:var(--ink)">输入框 / 按钮（--control-height）</span>
        <span class="hint">字号 ${d.v["text-body"]} · 标题 ${d.v["text-title"]} · 行高 ${d.v["row-height"]}</span>
      </div>
    </div>`,
    )
    .join("")}</div>`;
}

// ---------------------------------------------------------------- 7. 页面

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>round78 设计样张 · 设置页 IA + ? 快捷键总表（3.1b₂）</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">

<h1>round78（3.1b₂）· 设计样张 <span class="tag todo">先看版 · 批了才动代码</span></h1>
<p class="lead">
你说「这两项出设计样张给我看，批了再做」—— 这一页就是那两份：<b>① 设置页 IA 重排</b> · <b>② <code>?</code> 快捷键总表面板</b>。
配色 / 图标 / 键表 / 行高 / 文案全部<b>从源码读</b>（<span class="mono">tokens.css · icons/sets/*.ts · keyboard-help.ts · messages/zh.json</span>），
所以这一页与真实观感同源；重新生成：<span class="mono">node tools/visual/design-sample-78.mjs</span>。
</p>

<h2>① 设置页 IA（设-01/02/03/04/05/09/10）</h2>

<h3>A1 · 现状 vs 新结构</h3>
<div class="grid two">
  <div>
    ${renderPanelCurrent()}
    <p class="note">现状：<b>9 个分区 · 23 行 · 纯下拉</b>；380px 弹层里 70vh 只看得到约 1/3（滚动条实测：整表 ≈ 2.6 屏）。</p>
  </div>
  <div>
    ${renderPanelNew()}
    <p class="note">新结构：<b>5 组 + 「更多」折叠</b> + 顶部分区导航（点组名跳转）；高频项默认展开（默认值 = 旧行为）。</p>
  </div>
</div>

<h3>A1.1 · 分组归位表（逐项：现在在哪 → 去哪个组）</h3>
<div class="card">
<table class="keys" style="font-size:13px">
<thead><tr><th>项</th><th>现在（9 分区）</th><th>新位置</th><th>备注</th></tr></thead>
<tbody>
<tr><td>语言</td><td>通用</td><td>主题与颜色 <span class="tag ok">你已拍</span></td><td>放本组末行（不塞进「更多」）—— 切语言是设置自己的事</td></tr>
<tr><td>配色 / 深浅色</td><td>外观 / 布局</td><td>① 主题与颜色</td><td>换真预览控件（A2）</td></tr>
<tr><td>层条上色 / 分类底边条</td><td>外观 / 布局</td><td>① 主题与颜色</td><td>「只管颜色」的两项跟颜色放一起</td></tr>
<tr><td>字号密度</td><td>外观 / 布局</td><td>② 字号与密度</td><td>换真预览控件（A2）</td></tr>
<tr><td>块内第二行</td><td>外观 / 布局</td><td>③ 时间轴</td><td>它描述的是块上的字，跟时间轴一组</td></tr>
<tr><td>图标集</td><td>外观 / 布局</td><td>① 主题与颜色 <span class="tag ok">你已拍</span></td><td>与色板同组（两个预览选择器挨着）；图标是全局的，不只服务时间轴</td></tr>
<tr><td>隐藏周末 / 现在线</td><td>外观 / 布局 · 无</td><td>③ 时间轴</td><td>「现在线」此前没有开关（本批补）</td></tr>
<tr><td>块开始 / 结束提醒 · 提前量</td><td>提醒</td><td>④ 提醒与控制</td><td></td></tr>
<tr><td>复盘提醒 · 免打扰 · 到明早时刻</td><td>提醒</td><td>④ 提醒与控制</td><td></td></tr>
<tr><td>键位提示（常显 / 不显示）</td><td>外观 / 布局</td><td>④ 提醒与控制</td><td>与键盘开关、键表入口同组</td></tr>
<tr><td>计划任务</td><td>提醒</td><td>更多 <span class="tag todo">低频</span></td><td>默认关 + 有解释行</td></tr>
<tr><td>理智值（预算 / 预警）</td><td>理智值</td><td>更多</td><td>低频，进折叠区</td></tr>
<tr><td>成就（暗章）三行</td><td>成就（暗章）</td><td>更多</td><td>低频，进折叠区</td></tr>
<tr><td>备份 / 导出 / 数据位置切换</td><td>数据</td><td>更多</td><td>低频 + 危险操作</td></tr>
<tr><td>功能开关 15 行</td><td>功能开关（默认全开）</td><td>更多</td><td>默认收起（现在是手动折叠，仍是 15 行）</td></tr>
<tr><td>引导与教程 3 按钮</td><td>引导与教程</td><td>更多</td><td><b>设-05</b>：顶部「ⓘ 说明」按钮删掉，入口只留这一处</td></tr>
<tr><td>键位说明表</td><td>键位说明</td><td>更多</td><td><b>设-08</b>：不再内嵌表，改成「打开快捷键总表」一行（点开 §B 那个面板）+ 键盘开关一行</td></tr>
<tr><td>12/24 制 · 日期格式 · 一周起点</td><td>—</td><td>（本批不做）</td><td><b>3.1c</b> 的项，本批不占位（免得给你一个点不动的组）</td></tr>
</tbody>
</table>
</div>

<h3>A2 · 三处预览选择器（设-02 · 真组件口径）</h3>
<div class="card">
  <h4>配色 = 3 个色板按钮</h4>
  <div class="palettes">${Object.entries(PALETTES)
    .map(
      ([key, p]) =>
        `<span class="palette${key === "warm" ? " on" : ""}"><span class="chips">${["bg", "card", "accent"]
          .map((c) => `<span class="chip" style="background:${p.light[c]}"></span>`)
          .join("")}</span><span class="name">${esc(p.label)}${p.tip ? "（默认）" : ""}</span></span>`,
    )
    .join("")}</div>
  <p class="note">三格 = 背景 / 卡片 / 主色；下排是三套配色的真观感（亮 + 暗）。</p>
  ${renderPaletteCards()}
  <hr class="rule">
  <h4>图标 = 5 个迷你预览（同一枚图标 × 五套）</h4>
  <div class="icon-sets">${SETS.map(
    (s) =>
      `<span class="icon-set${s.name === "lucide" ? " on" : ""}"><span class="mini">${["settings", "check", "calendar-days", "bell", "sun", "database"]
        .map((n) => svg(s, n, 16))
        .join("")}</span><span class="name">${esc(SET_LABEL[s.name])}</span></span>`,
  ).join("")}</div>
  <p class="note">预览里的六枚 = 设置 / 完成 / 日历 / 提醒 / 亮暗 / 数据 —— 都是设置面板里真的用得到的语义名。</p>
  <hr class="rule">
  <h4>密度 = 3 张带样本的小卡</h4>
  ${renderDensityCards()}
</div>

<h3>A3 · 行的两种形态（设-03/04）</h3>
<div class="grid two">
  <div class="card">
    <h4>两段式（下拉 / 输入 / 按钮类）</h4>
    ${renderRow({ kind: "select", label: msg("ui.sanity_settings.62"), value: "常显", options: ["常显", "不显示"] })}
    ${renderRow({ kind: "number", label: msg("ui.sanity_settings.54"), value: "8", unit: "小时" })}
    <p class="note">标签在上、控件在下（左对齐）—— 放得下时控件可与标签并排；<b>任何新选项都不许把行变 nowrap</b>（L19 的根因）。</p>
  </div>
  <div class="card">
    <h4>开关 = 单行（你已拍）</h4>
    ${renderRow({ kind: "check", label: msg("ui.sanity_settings.31"), on: true, tail: "提前 10 分钟" })}
    ${renderRow({ kind: "check", label: msg("ui.sanity_settings.60"), on: true })}
    <p class="note">标签左 / 开关右；标签长时整行自动换行（旧写法是 nowrap 顶满，提字号就溢出）。</p>
    <div class="row sub"><div class="label">子项缩进 + 左侧细线（举例：功能开关的子项）</div><div class="ctrl"><span class="bar">子项示例</span></div></div>
    <p class="note">子项层级 = 缩进 1 级 + 2px 左细线；组标题用 <span class="mono">--text-title</span> + 600 字重（≥ 正文）。</p>
  </div>
</div>

<h3>A4 · 层与间距（层级三档）</h3>
<div class="card">
  <div class="grid three">
    <div><div class="sec">组标题</div><span class="spec">字号 <b>14px</b> · 字重 <b>600</b> · 上距 <b>16px</b></span></div>
    <div><div class="label" style="font-size:13px">行标签</div><span class="spec">字号 <b>13px</b> · 字重 <b>400</b> · 行内距 <b>8px</b></span></div>
    <div><div class="hint">说明 / 子项</div><span class="spec">字号 <b>12px</b> · 颜色 <b>tertiary</b> · 缩进 <b>12px</b></span></div>
  </div>
  <p class="note">间距只取 4 / 8 / 12 / 16 / 24 / 32 六档；组间距 24、行内 8、子项缩进 12（与《排版与布局调研》的间距契约一致，spacing-audit --check 0 违规）。</p>
</div>

<h3>A5 · 面板外壳（覆盖面板 · 栈-04 口径）</h3>
<div class="stage" style="height:420px">
  <div class="app"><div class="bar2"></div><div class="body2"></div></div>
      <div class="overlay-live" style="width:640px">
        <div class="backdrop"></div>
        <div class="panel live" style="width:640px">
          <div class="panel-head"><h4>设置</h4><span class="tag ok">640 中间档（新）</span><span class="x">✕</span></div>
          <div class="panel-nav">${NEW_GROUPS.map((g, i) => `<span${i === 0 ? ' class="on"' : ""}>${esc(g.title)}</span>`).join("")}</div>
          <div class="panel-body" style="max-height:230px">
            ${NEW_GROUPS[0].rows.map(renderRow).join("")}
          </div>
        </div>
        <p class="width-label">宽 640（min(640px, 100vw − 2×左缘)）· 顶 4vh · 最高 88vh · 遮罩共用</p>
      </div>
    </div>
    <p class="note">从「贴齿轮的 380px 弹层」升级成覆盖面板（你已拍）：固定左缘 + 遮罩 + 焦点陷阱 + Esc 只关一层。</p>

<h3>A5.1 · 窄窗 715（整屏化）</h3>
<div class="narrow-stage">
      <div class="wrap">
        <div class="panel live panel-narrow" style="width:683px">
          <div class="panel-head"><h4>设置</h4><span class="tag ok">715 窄窗：整屏化</span><span class="x">✕</span></div>
          <div class="panel-nav">${NEW_GROUPS.map((g, i) => `<span${i === 0 ? ' class="on"' : ""}>${esc(g.title)}</span>`).join("")}</div>
          <div class="panel-body" style="max-height:200px">
            ${NEW_GROUPS[0].rows.map(renderRow).join("")}
          </div>
        </div>
      </div>
    </div>
    <p class="note">≤760px：宽 = 100vw − 32px、分区导航横排可滚、行按两段式换行；<b>不横向溢出</b>（进闸门扫描）。</p>

<h2>② <code>?</code> 快捷键总表面板（键-02/键-03）</h2>

<h3>B1 · 真尺寸（780 宽档）</h3>
${renderKeysPanel({})}
<p class="note">内容 = <span class="mono">keyboard-help.ts</span> 的同一份 <span class="mono">KEY_HELP</span>（七组）—— 与设置里那份<b>只有一处真源</b>；
面板里 <span class="mono">? 打开</span> 由面板栈的 Esc 一层关掉；设置里改成「打开快捷键总表」入口（A1.1 末两行）。</p>

<h3>B2 · 三档宽度（挑一个当它的宽度档）</h3>
${[560, 640, 780]
  .map(
    (w) => {
      let tip = "窄档：表会折行更多，七组要滚";
      if (w === 780) tip = '<span class="tag ok">推荐</span>（与总览同档，键位与动作并排最舒服）';
      else if (w === 640) tip = "中间档（设置用这一档）";
      return `<div style="margin-top: var(--s4)">
  <p class="spec"><b>${w}px</b> ${tip}</p>
  <div class="panel" style="width:${w}px; max-width:100%">
    <div class="panel-head"><h4>快捷键</h4><span class="tag">? 打开 · Esc 关一层</span><span class="x">✕</span></div>
    <div class="panel-body" style="max-height:${w === 560 ? 180 : 250}px"><table class="keys"><tbody>${KEY_HELP.slice(0, 4)
      .map(
        (s) =>
          `<tr class="grp"><td colspan="2">${esc(msg(s.group))}</td></tr>` +
          s.rows
            .map(
              ([keys, label]) =>
                `<tr><td class="kk"><span class="kbd">${esc(keys.startsWith("msg.") ? msg(keys) : keys)}</span></td><td>${esc(
                  msg(label),
                )}</td></tr>`,
            )
            .join(""),
      )
      .join("")}</tbody></table></div>
  </div>
</div>`;
    },
  )
  .join("")}

<h3>B3 · 与设置并排（子层叠父层：关掉 <code>?</code> 回到设置）</h3>
<div class="stage" style="height:460px">
  <div class="app"><div class="bar2"></div><div class="body2"></div></div>
  <div class="overlay-live" style="width:640px">
    <div class="backdrop"></div>
    <div class="panel live" style="width:640px; opacity:.45">
      <div class="panel-head"><h4>设置（父层 · 还在）</h4><span class="tag">被压在下面</span><span class="x">✕</span></div>
      <div class="panel-body" style="max-height:360px">
        ${NEW_GROUPS[0].rows.map(renderRow).join("")}
      </div>
    </div>
  </div>
  <div style="position:absolute; top:56px; left:48px; width:780px; max-width:calc(100% - 72px)">
    <div class="panel live">
      <div class="panel-head"><h4>快捷键（子层 · 叠在上面）</h4><span class="tag ok">左缘对齐 · 宽一档</span><span class="x">✕</span></div>
      <div class="panel-body" style="max-height:300px"><table class="keys"><tbody>${KEY_HELP.slice(0, 4)
        .map(
          (s) =>
            `<tr class="grp"><td colspan="2">${esc(msg(s.group))}</td></tr>` +
            s.rows
              .map(
                ([keys, label]) =>
                  `<tr><td class="kk"><span class="kbd">${esc(keys.startsWith("msg.") ? msg(keys) : keys)}</span></td><td>${esc(
                    msg(label),
                  )}</td></tr>`,
              )
              .join(""),
        )
        .join("")}</tbody></table></div>
    </div>
    <p class="width-label">两层的左下角对齐（固定左缘），宽度 640 → 780；关掉子层回到设置，不丢位置。</p>
  </div>
</div>

<h3>B4 · 窄窗 715（整屏化）</h3>
<div class="narrow-stage">
  <div class="wrap">
    <div class="panel live" style="width:683px">
      <div class="panel-head"><h4>快捷键</h4><span class="tag ok">715：整屏化</span><span class="x">✕</span></div>
      <div class="panel-body" style="max-height:320px"><table class="keys"><tbody>${KEY_HELP.map(
        (s) =>
          `<tr class="grp"><td colspan="2">${esc(msg(s.group))}</td></tr>` +
          s.rows
            .map(
              ([keys, label]) =>
                `<tr><td class="kk"><span class="kbd">${esc(keys.startsWith("msg.") ? msg(keys) : keys)}</span></td><td>${esc(
                  msg(label),
                )}</td></tr>`,
            )
            .join(""),
      ).join("")}</tbody></table></div>
      </div>
  </div>
</div>
<p class="note">窄窗下表仍两列（键位 / 动作），键位列 38%；不横向溢出。</p>

<h2>③ 图标五套全量（40 语义名 × 5 套 · 备查）</h2>
${renderIconGrid()}
<p class="note">这一张与 docs/visual/3.1组件展示页.html §3 同一份数据，放在这里方便对照「换一套图标之后设置面板长什么样」。</p>

<h2>④ 你已拍（2026-10-06 · 四项照推荐）</h2>
<div class="card">
<ol style="margin:0; padding-left:20px">
  <li><b>样张整体照这个做</b> —— 设置 5 组 + 「更多」 + 三处预览选择器 + 问号键面板。</li>
  <li><b>语言</b> → 「主题与颜色」末行。</li>
  <li><b>图标集</b> → 「主题与颜色」（与色板同组）。</li>
  <li><b>问号键面板宽度</b> → <b>780</b>（与总览同档）。</li>
</ol>
</div>

</div>
</body>
</html>
`;

writeFileSync(`${root}/docs/visual/round78-设置IA对照图.html`, html, "utf8");
console.log("已写出 docs/visual/round78-设置IA对照图.html");
console.log(`  配色 ${Object.keys(PALETTES).length} 套 · 图标 ${ICON_NAMES.length}×${SETS.length} · 键表 ${KEY_HELP.length} 组 ${KEY_HELP.reduce((n, s) => n + s.rows.length, 0)} 行`);
