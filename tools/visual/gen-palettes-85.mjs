#!/usr/bin/env node
/**
 * round85（0.31.0）· **9 套内置配色 + 圆角档 + 底纹层 + 两套展示字的唯一生成器**。
 *
 * 为什么要生成器：9 套 × 亮/暗 × 33 个颜色 token = 594 个值，手抄必错；而且「改了种子忘了改 CSS」
 * 这类漂移没有任何一面能抓到。这里把它变成可复现的产物：
 *   种子（`tools/visual/candidates/round84.json`）→ `deriveTokens()`（复用 round84 的派生 + 自动调参）
 *   → **再跑一遍 52 对 + 淡化带 4 条预检**（不达标**拒绝写文件**、打印失败项）
 *   → `src/lib/styles/palettes.css` + `src/lib/utils/palette-preview.gen.ts`
 *
 * 用法：
 *   node tools/visual/gen-palettes-85.mjs           # 写文件
 *   node tools/visual/gen-palettes-85.mjs --check   # 只比对（不一致 exit 1）—— 进闸门，防手改 / 防漂移
 *
 * 口径（你 2026-10-08 已拍）：配色 + 圆角档 + 底纹层；**不搬**样张里的装饰串（斜切角 / 金线 /
 * 光晕 / 毛玻璃 / 动画）。老 3 套配色仍在 `tokens.css`（逐字节未动），这里只加新 9 套。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COL_SURFACE_KINDS,
  PAGE_ONLY_SURFACE_KINDS,
  checkTokens,
  deriveTokens,
  surfaceBgSize,
  surfaceCss,
  surfaceForCols,
  textureOverBg,
} from "./lib/theme-tokens.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const checkOnly = process.argv.includes("--check");

/** 第 1 层 28 个 + 第 2 层里「跟着配色走」的 5 个 = 33（顺序照 tokens.css 的读法） */
const COLOR_TOKENS = [
  "--bg",
  "--card",
  "--text-primary",
  "--text-secondary",
  "--text-tertiary",
  "--accent",
  "--warn",
  "--warn-solid",
  "--block-fill-planned",
  "--block-ink-planned",
  "--block-line-planned",
  "--block-fill-done",
  "--block-ink-done",
  "--block-line-done",
  "--block-fill-missed",
  "--block-ink-missed",
  "--block-line-missed",
  "--block-line-ghost",
  "--layer-required-bar",
  "--layer-elastic-bar",
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `--cat-${i}`),
  // 第 2 层：`tokens.css` 给的是老 3 套的默认值；新 9 套按自己的色板适配（round84 已算过）
  "--on-warn",
  "--on-accent",
  "--medal",
  "--now-line",
  "--dim-band",
];

/**
 * 展示字（round86：从 `decor-86.json` 的 `display` 段读，形状见那份表的注释）。
 * 字体族是**枚举** —— 生成器翻译成真字体栈：
 * · `samigirian`：Samigirian 的 README —— **大写 = 萨米文字、小写 = 阿戈尔文字**（北境极夜 = 萨米·大写 /
 *   深海冷光 = 阿戈尔·小写）；字体文件在 `src/lib/assets/`（OFL 1.1，许可随包）。
 * · `mono` / `serif`：系统自带（不打包）。
 * `--display-transform-title` 是 Backlog 标题专用（它的默认值本来就是 uppercase，见 `tokens.css`）。
 */
const DISPLAY_FONT_STACK = {
  samigirian: '"Samigirian", var(--font-ui)',
  mono: "var(--font-mono)",
  serif: 'Georgia, "Times New Roman", "Songti SC", SimSun, serif',
  // round87（3.3）：四款自带展示字（OFL 1.1 官方 latin 子集，文件在 `src/lib/assets/`）——
  // 各归一套（你 2026-10-08 拍）：Poiret One → 装饰艺术 · Jost → 包豪斯 ·
  // Archivo Black → 野兽派 · Marcellus → 白瓷；均无 CJK → 中文回落 `var(--font-ui)`。
  poiret: '"Poiret One", var(--font-ui)',
  jost: '"Jost", var(--font-ui)',
  archivo: '"Archivo Black", var(--font-ui)',
  marcellus: '"Marcellus", var(--font-ui)',
};
/** 展示字的**量**（只覆盖写了的键；没写 = 各组件自己的现值，见 `tokens.css` 第 3 层的注释） */
const DISPLAY_TOKEN_OF = {
  scale: "--display-scale",
  tracking: "--display-tracking",
  weight: "--display-weight",
  variant: "--display-variant",
};

const OUT_CSS = "src/lib/styles/palettes.css";
const OUT_TS = "src/lib/utils/palette-preview.gen.ts";

// ---------------------------------------------------------------- 0 读长相参数表（display / deco）
const decor = (() => {
  try {
    return JSON.parse(read("tools/visual/candidates/decor-86.json"));
  } catch (e) {
    console.error(`✗ 读不了长相参数表（tools/visual/candidates/decor-86.json）：${e.message}`);
    process.exit(1);
  }
})();
/** 这一套的展示字声明（没写 = 今天的长相） */
const displayOf = (id) => decor.display?.[id] ?? null;
/** 展示字声明 → 要写进配色块的令牌行（数组；空数组 = 什么都不写） */
function displayChrome(d) {
  if (!d) return [];
  const out = [];
  const stack = d.font ? DISPLAY_FONT_STACK[d.font] : null;
  if (d.font) {
    if (!stack) {
      console.error(`✗ decor-86.json：${JSON.stringify(d.font)} 不是已知字体族（只有 ${Object.keys(DISPLAY_FONT_STACK).join(" / ")}）`);
      process.exit(1);
    }
    out.push(`--font-display: ${stack};`);
  }
  if (d.transform) out.push(`--display-transform: ${d.transform};`);
  if (d.titleTransform) out.push(`--display-transform-title: ${d.titleTransform};`);
  for (const [k, token] of Object.entries(DISPLAY_TOKEN_OF)) {
    if (d[k] != null) out.push(`${token}: ${d[k]};`);
  }
  return out;
}

/**
 * 装饰（decor-86.json 的 `deco` 段）：键 → 令牌名。**只列要有令牌的那些**；
 * `tokens` 是「直接覆盖既有令牌」的逃生口（白瓷的 `--layer-bar-width`）。
 * 规则（怎么画）在 `src/lib/styles/decor.css` 与四个组件里 —— 这里只写值。
 */
const DECO_TOKEN_OF = {
  blockRadius: "--deco-block-radius",
  blockBorderWidth: "--deco-block-border-width",
  blockShadow: "--deco-block-shadow",
  blockClip: "--deco-block-clip",
  cornerMark: "--deco-corner-mark",
  cornerSize: "--deco-corner-size",
  cornerInset: "--deco-corner-inset",
  hudSize: "--deco-hud-size",
  hudEdge: "--deco-hud-edge",
  hudColor: "--deco-hud-color",
  timelineHeadShadow: "--deco-timeline-head-shadow",
  backlogHeadShadow: "--deco-backlog-head-shadow",
  headRule: "--deco-head-rule",
  dayHeadRule: "--deco-day-head-rule",
  itemLine: "--deco-item-line",
  panelBorder: "--deco-panel-border",
  panelShadow: "--deco-panel-shadow",
  pageOverlay: "--deco-page-overlay",
};
const decoOf = (id) => decor.deco?.[id] ?? null;
/** 装饰声明 → 要写进配色块的令牌行（数组；空数组 = 这套不画装饰） */
function decoChrome(d) {
  if (!d) return [];
  const out = [];
  for (const [k, token] of Object.entries(DECO_TOKEN_OF)) {
    if (d[k] != null) out.push(`${token}: ${d[k]};`);
  }
  for (const [token, v] of Object.entries(d.tokens ?? {})) out.push(`${token}: ${v};`);
  return out;
}

// ---------------------------------------------------------------- 1 读种子 + tokens.css 的类目色
const cands = (() => {
  try {
    return JSON.parse(read("tools/visual/candidates/round84.json")).candidates;
  } catch (e) {
    console.error(`✗ 读不了候选种子表（tools/visual/candidates/round84.json）：${e.message}`);
    process.exit(1);
  }
})();
if (cands.length !== 9) {
  console.error(`✗ 种子表里是 ${cands.length} 套，本批要求 9 套`);
  process.exit(1);
}
/** 类目色的底 = **tokens.css 里的老 3 套同源值**（改了那边这边跟着变，不再各写一份） */
const cssText = read("src/lib/styles/tokens.css");
const cats = [...cssText.matchAll(/--cat-(\d):\s*(#[0-9a-f]{6})/g)].map((m) => m[2]);
// 老 3 套 ×（亮 8 + 暗 8）= 48 处；三套的类目色**同值**（第 1 层的设计如此）——
// 取第一套（暖砂）的亮 8 / 暗 8 当新 9 套的底；顺带核「三套确实同值」（哪天不同值了 → 这里红，提醒作决定）。
if (cats.length !== 48) {
  console.error(`✗ tokens.css 里读到 ${cats.length} 个类目色（期望 48 = 3 套 × 16）`);
  process.exit(1);
}
for (let p = 1; p < 3; p++) {
  for (let i = 0; i < 16; i++) {
    if (cats[p * 16 + i] !== cats[i]) {
      console.error(`✗ 第 ${p + 1} 套配色的类目色与暖砂不一致（第 ${i + 1} 个：${cats[p * 16 + i]} ≠ ${cats[i]}）`);
      process.exit(1);
    }
  }
}
const CATS_LIGHT = cats.slice(0, 8);
const CATS_DARK = cats.slice(8, 16);

// ---------------------------------------------------------------- 2 派生 + 预检（不达标拒绝写）
const failures = [];
const sets = [];
for (const c of cands) {
  const modes = {};
  for (const mode of ["light", "dark"]) {
    const seed = { ...c[mode], cats: mode === "dark" ? CATS_DARK : CATS_LIGHT };
    // `plainBand`：块底同时对「带 + 底纹」与「带 + 纯底」达 1.05 —— 后者是 `contrast.mjs` 的尺子
    // （它只看 `--bg`，不知道底纹那一层）；两条尺子都绿才算过。
    const tokens = deriveTokens(seed, mode, { plainBand: true });
    const bgComposite = textureOverBg(tokens, seed.surface);
    // 预检跑两遍：① 底纹合成后的底（真机上的实际背景）② 纯底（`contrast.mjs` 的保守尺子）
    for (const [label, bg] of [["底纹合成底", bgComposite], ["纯底", null]]) {
      const check = checkTokens(tokens, bg);
      if (check.failures.length) {
        failures.push(...check.failures.map((f) => `${c.name}/${c.id} · ${mode}（${label}）：${f}`));
      }
    }
    modes[mode] = { tokens, surface: seed.surface };
  }
  sets.push({ c, modes });
}
if (failures.length) {
  console.error("✗ 预检未过（拒绝写文件）—— 先调种子再重跑：");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
/** 顶层逗号切分（尊重括号）→ 有几层 */
function countLayers(value) {
  let depth = 0;
  let n = 1;
  for (const ch of value) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) n += 1;
  }
  return n;
}
// 6b P2（潜在雷）：`--surface-size` 只给非 auto 的层写值，浏览器按「短的重复」补齐 ——
// 若某个种子混了不同尺寸需求的 kind（例：grid + dots），dots 那层会拿到 auto → 铺成一个大圆斑。
// 这里拦住：尺寸项数要么与层数相等，要么全是 auto（当前 9 套全是全 auto，安全）。
for (const { c, modes } of sets) {
  for (const mode of ["light", "dark"]) {
    const { tokens, surface } = modes[mode];
    if (!surface) continue;
    const layers = countLayers(surfaceCss(tokens, surface));
    const sizes = surfaceBgSize(surface).split(/,(?![^(]*\))/).map((s) => s.trim());
    if (sizes.length !== layers && sizes.some((s) => s !== "auto")) {
      failures.push(
        `${c.name}/${c.id} · ${mode}：--surface-size 有 ${sizes.length} 项、背景图有 ${layers} 层，且不全是 auto` +
          `（浏览器按短的补齐会让某层拿到别人的尺寸）—— 要么给每层写尺寸，要么全留 auto`,
      );
    }
  }
}
// ---------------------------------------------------------------- 装饰自检（round86 · 0.32.0 · ③）
for (const [id, d] of Object.entries(decor.deco ?? {})) {
  for (const k of Object.keys(d)) {
    if (!(k in DECO_TOKEN_OF) && k !== "tokens") {
      failures.push(`${id}：装饰参数里有未知键 ${k}（拼错会静默不生效 —— 加进 DECO_TOKEN_OF 或写进 tokens）`);
    }
  }
  if (d.blockClip && d.blockShadow) {
    failures.push(`${id}：同时声明了 blockClip 与 blockShadow —— 裁切会把外发光 / 硬投影一起裁掉`);
  }
  if (d.cornerMark && !d.cornerSize) failures.push(`${id}：cornerMark 缺 cornerSize（画不出来）`);
  if (d.hudSize && (!d.hudEdge || !d.hudColor)) failures.push(`${id}：hudSize 缺 hudEdge / hudColor`);
}
{
  const known = new Set(cands.map((c) => c.id));
  for (const id of Object.keys(decor.deco ?? {})) {
    if (!known.has(id)) failures.push(`装饰参数表里有未知配色 ${id}（种子表里没有这套）`);
  }
}
// ---------------------------------------------------------------- 展示字自检（round86 · ⑤；6b 复核补）
/** `display` 段允许的键（拼错会静默失效 —— 必须报出来） */
const DISPLAY_KEYS = new Set(["font", "transform", "titleTransform", "scale", "tracking", "weight", "variant"]);
for (const [id, d] of Object.entries(decor.display ?? {})) {
  for (const k of Object.keys(d)) {
    if (!DISPLAY_KEYS.has(k)) failures.push(`${id}：display 段有未知键 ${k}（拼错会静默不生效）`);
  }
  if (d.font && !DISPLAY_FONT_STACK[d.font]) failures.push(`${id}：display.font=${d.font} 不是已知字体族`);
  const pct = (v) => (typeof v === "string" && /^[0-9.]+$/.test(v) ? Number(v) : null);
  if (d.scale != null && !(pct(d.scale) !== null && pct(d.scale) > 0.5 && pct(d.scale) < 1.6)) {
    failures.push(`${id}：display.scale=${d.scale} 超出合理范围 0.5–1.6`);
  }
}
{
  const known = new Set(cands.map((c) => c.id));
  for (const id of Object.keys(decor.display ?? {})) {
    if (!known.has(id)) failures.push(`展示字参数表里有未知配色 ${id}（种子表里没有这套）`);
  }
}

// ---------------------------------------------------------------- 底纹 kind 必须被显式分类（round86 · ②）
for (const c of cands) {
  for (const mode of ["light", "dark"]) {
    const s = c[mode]?.surface;
    if (!s) continue;
    for (const layer of Array.isArray(s) ? s : [s]) {
      if (!COL_SURFACE_KINDS.has(layer.kind) && !PAGE_ONLY_SURFACE_KINDS.has(layer.kind)) {
        failures.push(
          `${c.id}/${mode}：底纹 kind "${layer.kind}" 没被显式分类 —— ` +
            `要么加进 COL_SURFACE_KINDS（铺页面 + 列底），要么加进 PAGE_ONLY_SURFACE_KINDS（只铺页面）`,
        );
      }
    }
  }
}

if (failures.length) {
  console.error("✗ 装饰自检未过（拒绝写文件）：");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

if (failures.length) {
  console.error("✗ 底纹尺寸自检未过（拒绝写文件）：");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

// ---------------------------------------------------------------- 3 渲染 CSS
/** 顶部逗号切分（尊重括号，别把渐变参数切开） */
function wrapLayers(value, indent) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur.trim());
  return parts.join(`,\n${indent}`);
}

/** `extra` = 不在 `COLOR_TOKENS` 里、只给某些配色写的颜色（round86：`--accent-deco`）。
 *  只有种子给了 `accentDeco` 的配色才写它 —— 老 8 套逐字节不变（它们走 `tokens.css` 的
 *  `--accent-deco: var(--accent)` 默认值）。 */
function renderBlock({ tokens, surface }, { indent = "", emitChrome = true, extra = [] } = {}) {
  const lines = [];
  const pad = `${indent}  `;
  for (const k of COLOR_TOKENS) {
    lines.push(`${pad}${k}: ${tokens[k]};`);
  }
  for (const k of extra) {
    if (tokens[k] != null) lines.push(`${pad}${k}: ${tokens[k]};`);
  }
  if (emitChrome) {
    const style = [];
    if (surface) {
      const img = wrapLayers(surfaceCss(tokens, surface), `${pad}  `);
      style.push(`${pad}--surface-image: ${img};`);
      style.push(`${pad}--surface-size: ${surfaceBgSize(surface)};`);
      // round86（0.32.0 · ②）：**列底那层只放细密纹理** —— 大尺度（rays / glow）只铺页面；
      // 一套都不剩 → 不写这两个令牌（`Timeline` 的 `.day-body` 回落 `none`）。
      const cols = surfaceForCols(surface);
      if (cols) {
        const colsImg = wrapLayers(surfaceCss(tokens, cols), `${pad}  `);
        style.push(`${pad}--surface-image-cols: ${colsImg};`);
        style.push(`${pad}--surface-size-cols: ${surfaceBgSize(cols)};`);
      }
    }
    if (style.length) lines.push("", ...style);
  }
  return lines.join("\n");
}

const cssParts = [
   `/* 第 1 层扩展 · **9 套内置配色**（round85 起；round86 加 ① 的装饰色）—— 生成物，勿手改
   ─────────────────────────────────────────────────────────────
   来源：\`tools/visual/candidates/round84.json\` 的 9 个种子 → \`tools/visual/lib/theme-tokens.mjs\` 的
   派生 + 自动调参 → **52 对** + 淡化带 4 条预检（不达标拒绝写文件）。
   重跑：\`node tools/visual/gen-palettes-85.mjs\`；比对：\`node tools/visual/gen-palettes-85.mjs --check\`。

   每套写什么：
   · 33 个颜色 token（第 1 层 28 个 + 第 2 层里跟着配色走的 5 个：on-warn / on-accent / medal /
     now-line / dim-band）；
   · 装饰色 \`--accent-deco\`（round86 · ①；**只有种子给了 \`accentDeco\` 的配色写** —— 它染
     非交互的底色/装饰：块三态 / 层条 / 今天列 / 头部细线；其余配色走 tokens.css 的
     \`--accent-deco: var(--accent)\` 默认值）；
   · 圆角档（只有直角候选写：--radius-sm / --radius / --radius-lg = 0px）；
   · 底纹层（--surface-image / --surface-size；铺在 body 与 .day-body，整点格线仍在最上层）；
   · 展示字（round86 · ⑤；round87 加四款自带字）：值在 \`decor-86.json\` 的 \`display\` 段）：--font-display（samigirian / mono /
     serif / poiret / jost / archivo / marcellus 七枚举）/ --display-transform(-title) / --display-scale / --display-tracking /
     --display-weight / --display-variant —— 只写这一套装了的键，没装的走 \`tokens.css\` 的现值。

   老 3 套（暖砂 / 冷白 / 素灰绿）仍在 \`tokens.css\` 里逐字节未动 —— 这里只加新 9 套。
   小样数据（设置面板）在同一次生成里产出：\`src/lib/utils/palette-preview.gen.ts\`。 */
`,
];
for (const { c, modes } of sets) {
  const sharp = c.radius === 0;
  const display = displayOf(c.id);
  const deco = decoOf(c.id);
  // round86（0.32.0 · ①）：北境极夜给了 accentDeco（木色）→ 写进配色块（亮/暗各一份）。
  // 注：它是**每个模式的种子字段**（亮/暗各给一个），不是候选级别的开关。
  const extra = c.light?.accentDeco || c.dark?.accentDeco ? ["--accent-deco"] : [];
  cssParts.push(
    `\n/* ${c.name}（${c.id}）· ${c.brief}${sharp ? " · 直角" : ""}${display ? " · 展示字" : ""}${deco ? " · 装饰" : ""} */\n:root[data-palette="${c.id}"] {\n${renderBlock(modes.light, { extra })}\n`,
  );
  const chrome = [];
  if (sharp) {
    chrome.push(`  --radius-sm: 0px;`, `  --radius: 0px;`, `  --radius-lg: 0px;`);
  }
  // round86（0.32.0 · ⑤）：展示字（字体族 + 两个 transform + 四个量）—— 值在 `decor-86.json` 的 display 段
  for (const line of displayChrome(display)) chrome.push(`  ${line}`);
  // round86（0.32.0 · ③）：装饰（形状 / 线 / 层）—— 值在同一份表的 deco 段；规则在 decor.css
  for (const line of decoChrome(deco)) chrome.push(`  ${line}`);
  if (chrome.length) cssParts.push(`\n${chrome.join("\n")}\n`);
  cssParts.push(`}\n`);
  cssParts.push(
    `\n@media (prefers-color-scheme: dark) {\n  :root[data-palette="${c.id}"] {\n${renderBlock(modes.dark, { indent: "  ", extra })}\n  }\n}\n`,
  );
}
const cssOut = cssParts.join("");

// ---------------------------------------------------------------- 4 渲染小样 TS
const tsEntries = [];
for (const { c, modes } of sets) {
  for (const mode of ["light", "dark"]) {
    const t = modes[mode].tokens;
    tsEntries.push(
      `  "${c.id}-${mode}": { bg: "${t["--bg"]}", card: "${t["--card"]}", accent: "${t["--accent"]}", ` +
        `fill: "${t["--block-fill-planned"]}", line: "${t["--block-line-planned"]}", ink: "${t["--block-ink-planned"]}" },`,
    );
  }
}
const tsOut = `/**
 * round85（0.31.0）· **9 套内置配色的小样数据**（设置面板的迷你界面小样）—— 生成物，勿手改。
 *
 * 由 \`tools/visual/gen-palettes-85.mjs\` 与 \`palettes.css\` **同一次生成**：值 = 同一套派生令牌里的 6 个颜色。
 * 必须与 \`palettes.css\` 逐值一致（\`tools/visual/spacing-audit.mjs --check\` 核 12 套 × 亮暗 × 6 = 144 个值）。
 * 老 3 套的值仍在 \`appearance.ts\`（手写，那里是它们的唯一来源）；本文件只放新 9 套。
 */
export const NEW_PALETTE_PREVIEW = {
${tsEntries.join("\n")}
} as const;
`;

// ---------------------------------------------------------------- 5 写 / 比对
const targets = [
  { file: OUT_CSS, content: cssOut },
  { file: OUT_TS, content: tsOut },
];
if (checkOnly) {
  let stale = 0;
  for (const { file, content } of targets) {
    let onDisk = null;
    try {
      onDisk = read(file);
    } catch {
      /* 缺文件 → 也算漂移 */
    }
    if (onDisk === content) {
      console.log(`✓ ${file}`);
      continue;
    }
    stale += 1;
    const a = (onDisk ?? "").split("\n");
    const b = content.split("\n");
    const i = a.findIndex((line, n) => line !== b[n]);
    console.error(`✗ ${file} 与生成结果不一致（第 ${i < 0 ? a.length + 1 : i + 1} 行起）`);
    if (i >= 0) {
      console.error(`    磁盘：${a[i]}`);
      console.error(`    生成：${b[i] ?? "（没有这一行）"}`);
    }
  }
  if (stale) {
    console.error(`✗ ${stale} 个文件漂移 —— 重跑 \`node tools/visual/gen-palettes-85.mjs\``);
    process.exit(1);
  }
  process.exit(0);
}
for (const { file, content } of targets) {
  writeFileSync(path.join(root, file), content);
  console.log(`已写：${file}（${content.split("\n").length} 行 / ${Buffer.byteLength(content)} 字节）`);
}
console.log(
  `预检 ✓：${sets.length} 套 × 亮暗 = ${sets.length * 2} 组，52 对 + 淡化带 4 条全过` +
    `（直角 ${sets.filter((s) => s.c.radius === 0).length} 套 / 底纹 ${sets.filter((s) => s.modes.light.surface).length} 套 /` +
    ` 展示字 ${Object.keys(decor.display ?? {}).length} 套）`,
);
