// round76（3.1a）：**视觉底座的两把尺子之一 —— 间距契约 / 字号 / 行高 / 字距**。
//
// 来历：round72（《排版与布局调研》§5）一次性脚本 `ww72-spacing-audit.mjs` 的升格版 ——
// 那次是「看一眼就扔」，这次落进仓库、进闸门（`--check` 退出码 1 = 有人违规）。
//
// 用法（仓库根跑；只读，不写任何文件）：
//   node tools/visual/spacing-audit.mjs            # 统计报告
//   node tools/visual/spacing-audit.mjs --check    # 只列违规；有违规 → 退出码 1
//
// 口径（`docs/visual/排版与布局调研.md` §2.5 / §3.4 的「间距契约」）：
//   1) 间距（padding / margin / gap 族）：只认 `0` / `auto` / `var(--space-1…6)` / ±1–3px 光学微调。
//   2) 字号（font-size）：只认四个语义变量（`--text-meta|body|title|label`）—— 字面 px 一律违规
//      （三档密度的取值都在 tokens.css 第 3 层，且都 ≥12px：Windows 官方下限）。
//      round86（0.32.0 · ⑤）：**展示字**允许 `calc(var(--text-title) * var(--display-scale, 1))`
//      —— 它仍然是 token（倍率也是 token），只是多一层「按配色缩放」（只作用于三处展示字）。
//   3) 行高：`1`（纯字形行）/ `var(--line-body)` / `var(--line-compact)`；px 行高只允许出现在
//      固定高度控件里 —— 这里**只报告不拦**（要人看一眼注释）。
//   4) 字距：只认 `var(--label-tracking)`（一个口径，别再散 0.06/0.08/0.12em）。
//      round86：展示字允许 `var(--display-tracking, normal)` / `var(--display-tracking, var(--label-tracking))`
//      —— 回退值就是那两个旧口径，不引入新的魔法数字。
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const check = process.argv.includes("--check");

const files = [];
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else if (e.name.endsWith(".svelte")) files.push(p);
  }
}
await walk(path.join(repoRoot, "src"));

const SP = "padding|margin|gap";
const PROP = new RegExp(
  `(?:^|[;{\\s])((?:${SP})(?:-(?:top|right|bottom|left|block|inline))?|font-size|line-height|letter-spacing)\\s*:\\s*([^;}]+)`,
  "g",
);

const rows = [];
for (const f of files) {
  const text = await readFile(f, "utf8");
  const lines = text.split(/\r?\n/);
  for (const m of text.matchAll(PROP)) {
    const line = text.slice(0, m.index).split("\n").length;
    rows.push({
      file: path.relative(repoRoot, f).split(path.sep).join("/"),
      line,
      prop: m[1],
      value: m[2].trim().replace(/\s+/g, " "),
      src: lines[line - 1].trim(),
    });
  }
}

const isSp = (p) => new RegExp(`^(${SP})(-(top|right|bottom|left|block|inline))?$`).test(p);
/**
 * 允许作为间距取值的 token：六档间距 + 少数**组件级尺寸 token**
 * （列头高——它同时钉着 JS 的 `DAY_HEAD_PX`，比 `--space-5` 语义清楚：`Timeline.svelte` 的
 * `.gutter` 与 `.day-head` 必须同高）。其它 `var(--…)` 一律算违规 —— 免得随手造局部变量蒙混。
 */
const SPACING_TOKEN = /^var\(--(space-\d+|day-head-height)\)$/;
/** 单个值（多值写法拆开看）：ok / optical（±1–3px 光学微调）/ off */
const partClass = (part) => {
  if (part === "0" || part === "auto" || SPACING_TOKEN.test(part)) return "ok";
  const px = Number.parseFloat(part);
  if (/^-?\d+(\.\d+)?px$/.test(part) && Math.abs(px) <= 3) return "optical";
  return "off";
};
const valueClass = (v) => {
  const cs = v.split(" ").map(partClass);
  return cs.includes("off") ? "off" : cs.includes("optical") ? "optical" : "ok";
};

const spacing = rows.filter((r) => isSp(r.prop));
const fonts = rows.filter((r) => r.prop === "font-size");
const lh = rows.filter((r) => r.prop === "line-height");
const ls = rows.filter((r) => r.prop === "letter-spacing");

const badSpacing = spacing.filter((r) => valueClass(r.value) === "off");
const opticalSpacing = spacing.filter((r) => valueClass(r.value) === "optical");
/** 展示字（round86）：倍率也是 token —— 只认这一种 calc 形式，别的 calc 仍算违规 */
const DISPLAY_FONT_SIZE = "calc(var(--text-title) * var(--display-scale, 1))";
const badFont = fonts.filter(
  (r) => !/^var\(--text-(meta|body|title|label)\)$/.test(r.value) && r.value !== DISPLAY_FONT_SIZE,
);
const badLineHeight = lh.filter(
  (r) => r.value !== "1" && r.value !== "var(--line-body)" && r.value !== "var(--line-compact)",
);
/** 展示字（round86）：两处展示字的字距写法（回退值 = 旧口径） */
const TRACKING_OK = new Set([
  "var(--label-tracking)",
  "var(--display-tracking, normal)",
  "var(--display-tracking, var(--label-tracking))",
]);
const badTracking = ls.filter((r) => !TRACKING_OK.has(r.value));

const tally = (arr) => {
  const m = new Map();
  for (const r of arr) m.set(r.value, (m.get(r.value) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const uniq = (arr) => [...new Set(arr)];

// 判据清单（两种模式共用：`--check` 要拿它算退出码）
const checkLines = [];
if (check) {
  const lines = checkLines;
  if (badSpacing.length) {
    lines.push(`间距契约：违规 ${badSpacing.length} 处（${uniq(badSpacing.map((r) => r.value)).length} 种）`);
    for (const r of badSpacing) lines.push(`  ${r.file}:${r.line}  ${r.prop}: ${r.value}`);
  }
  if (badFont.length) {
    lines.push(`字号：不是语义 token ${badFont.length} 处`);
    for (const r of badFont) lines.push(`  ${r.file}:${r.line}  ${r.prop}: ${r.value}`);
  }
  if (badTracking.length) {
    lines.push(`字距：不是 --label-tracking ${badTracking.length} 处`);
    for (const r of badTracking) lines.push(`  ${r.file}:${r.line}  ${r.value}`);
  }
}

if (!check) {
  console.log(`# 文件数：${files.length} 个 .svelte`);
  console.log(
    `# 间距：${spacing.length} 处（token ${spacing.filter((r) => r.value.includes("var(--")).length}）；` +
      `违规 ${badSpacing.length}（${uniq(badSpacing.map((r) => r.value)).length} 种）；光学微调 ${opticalSpacing.length}；不同取值 ${uniq(spacing.map((r) => r.value)).length} 种`,
  );
  console.log(`# 字号：${fonts.length} 处 / ${uniq(fonts.map((r) => r.value)).length} 种（token 之外 ${badFont.length}）`);
  console.log(`# 行高：${lh.length} 处 / ${uniq(lh.map((r) => r.value)).length} 种（px 行高 ${badLineHeight.length} 处，见注释）`);
  console.log(`# 字距：${ls.length} 处 / ${uniq(ls.map((r) => r.value)).length} 种`);
}

// ---------------------------------------------------------------- 密度刻度三方对齐
// tokens.css 的三档字面量 ↔ src/lib/utils/appearance.ts 的 DENSITY_SCALE。
// 为什么要有：一套数字写在两处（CSS 给浏览器、TS 给手势数学）—— 两边不一致就是静默坏布局。
const DENSITY_TOKENS = {
  "--text-meta": "textMeta",
  "--text-body": "textBody",
  "--text-title": "textTitle",
  "--text-label": "textLabel",
  "--row-height": "rowHeight",
  "--slot-height": "slotHeight",
  "--control-height": "controlHeight",
  "--timeline-col-width": "timelineCol",
};
const cssText = await readFile(path.join(repoRoot, "src/lib/styles/tokens.css"), "utf8");
const tsText = await readFile(path.join(repoRoot, "src/lib/utils/appearance.ts"), "utf8");
// 默认（`:root` 第 3 层那一段）= 舒适档 —— 三档里只有它不挂 `[data-density]`（默认值就是舒适）。
// 注意：文件里有多个 `:root {…}`（第 2 层也有一个）—— 取含 `--text-meta` 的那一个（第 3 层）。
const rootBlock =
  [...cssText.matchAll(/\n:root \{([\s\S]*?)\n\}/g)]
    .map((m) => m[1])
    .find((b) => b.includes("--text-meta")) ?? "";
/** 某一档在 tokens.css 里的取值块：显式块优先；舒适档回默认块 */
const blockFor = (d) =>
  cssText.match(new RegExp(`:root\\[data-density="${d}"\\]\\s*\\{([^}]*)\\}`))?.[1] ??
  (d === "comfortable" ? rootBlock : "");
const cssScale = {};
for (const d of ["compact", "comfortable", "loose"]) {
  const block = blockFor(d);
  cssScale[d] = Object.fromEntries(
    Object.keys(DENSITY_TOKENS).map((n) => [n, Number(block.match(new RegExp(`${n}\\s*:\\s*(\\d+)px`))?.[1] ?? NaN)]),
  );
}
const tsScaleBlock = tsText.match(/export const DENSITY_SCALE[^{]*\{([\s\S]*?)\n\};/)?.[1] ?? "";
const tsScale = {};
for (const d of ["compact", "comfortable", "loose"]) {
  const block = tsScaleBlock.match(new RegExp(`${d}:\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  tsScale[d] = Object.fromEntries(
    Object.entries(DENSITY_TOKENS).map(([, key]) => [key, Number(block.match(new RegExp(`${key}:\\s*(\\d+)`))?.[1] ?? NaN)]),
  );
}
// round78（3.1b₂ · 6b P1）：**设置里那些色板预览的颜色**也要核 ——
// `appearance.ts` 的 `PALETTE_PREVIEW`（预览用，页面只能有一个 data-palette，读不到别套的值）
// 与 CSS 里的对应 token 必须逐值一致；不一致 = 小样静默显示错的颜色。
// round80（79-02）：从「三色格」扩到「迷你界面小样的六色 × 亮/暗」。
// round85（0.31.0）：3 套 → **12 套**（3 套老的在 `tokens.css`、9 套新的在 `palettes.css`；
// TS 侧 = `appearance.ts` 的手写 3 套 + `palette-preview.gen.ts` 的 9 套）= **12 × 2 × 6 = 144 个值**。
const palettesText = await readFile(path.join(repoRoot, "src/lib/styles/palettes.css"), "utf8");
const genTsText = await readFile(path.join(repoRoot, "src/lib/utils/palette-preview.gen.ts"), "utf8");
const paletteIds = [...(tsText.match(/export const PALETTES = \[([\s\S]*?)\] as const;/)?.[1] ?? "").matchAll(/"([a-z0-9]+)"/g)].map(
  (m) => m[1],
);
const paletteMismatches = [];
if (paletteIds.length !== 12) {
  paletteMismatches.push(`appearance.ts 的 PALETTES 读到 ${paletteIds.length} 个（期望 12）`);
}
{
  const KEYS = [
    ["--bg", "bg"],
    ["--card", "card"],
    ["--accent", "accent"],
    ["--block-fill-planned", "fill"],
    ["--block-line-planned", "line"],
    ["--block-ink-planned", "ink"],
  ];
  /** 亮色块：老 3 套在 tokens.css（warm 还带 `:root,` 前缀）、新 9 套在 palettes.css */
  const lightBlock = (id) => {
    const pat = new RegExp(`:root\\[data-palette="${id}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`);
    return (cssText.match(pat)?.[1] ?? palettesText.match(pat)?.[1]) ?? "";
  };
  /** 暗色块：`@media (prefers-color-scheme: dark)` 里的同名块（warm 带 `:root,` 前缀） */
  const darkBlock = (id) => {
    const pat = new RegExp(
      `@media \\(prefers-color-scheme: dark\\)\\s*\\{\\s*(?:\\:root,\\s*\\n\\s*)?:root\\[data-palette="${id}"\\]\\s*\\{([\\s\\S]*?)\\n\\s*\\}`,
    );
    return (cssText.match(pat)?.[1] ?? palettesText.match(pat)?.[1]) ?? "";
  };
  const bothTs = `${tsText}\n${genTsText}`;
  for (const id of paletteIds) {
    for (const mode of ["light", "dark"]) {
      const name = `${id}-${mode}`;
      const cssBlock = mode === "light" ? lightBlock(id) : darkBlock(id);
      const tsBlock = bothTs.match(new RegExp(`"${name}":\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      for (const [cssName, tsKey] of KEYS) {
        const cssVal = (cssBlock.match(new RegExp(`${cssName}\\s*:\\s*(#[0-9a-fA-F]{3,8})`))?.[1] ?? "").toLowerCase();
        const tsVal = (tsBlock.match(new RegExp(`${tsKey}\\s*:\\s*"([^"]+)"`))?.[1] ?? "").toLowerCase();
        if (!cssVal || !tsVal) {
          paletteMismatches.push(`${name} ${cssName}/${tsKey}：读不到（css=${cssVal || "空"} ts=${tsVal || "空"}）`);
        } else if (cssVal !== tsVal) {
          paletteMismatches.push(`${name} ${cssName}=${cssVal} ≠ PALETTE_PREVIEW.${tsKey}=${tsVal}`);
        }
      }
    }
  }
}
const mismatches = [];
for (const d of ["compact", "comfortable", "loose"]) {
  for (const [cssName, tsKey] of Object.entries(DENSITY_TOKENS)) {
    const a = cssScale[d][cssName];
    const b = tsScale[d][tsKey];
    if (!Number.isFinite(a) || !Number.isFinite(b)) mismatches.push(`${d} ${cssName}/${tsKey}：读不到（css=${a} ts=${b}）`);
    else if (a !== b) mismatches.push(`${d} ${cssName}=${a}px ≠ appearance.ts ${tsKey}=${b}`);
    if (d === "comfortable") {
      const def = Number(rootBlock.match(new RegExp(`${cssName}\\s*:\\s*(\\d+)px`))?.[1] ?? NaN);
      if (Number.isFinite(def) && def !== a) mismatches.push(`默认档 ${cssName}=${def}px ≠ 舒适档 ${a}px`);
    }
  }
}
console.log(
  `# 配色预览三方对齐（tokens.css + palettes.css ↔ PALETTE_PREVIEW）：${paletteMismatches.length === 0 ? "✓ 144 个值全对（12 套 × 亮/暗 × 6 色）" : `✗ ${paletteMismatches.length} 处不对`}`,
);
// round85（0.31.0 · 6b P2）：「**跨语言清单**」以前只有注释声称有断言，实际全仓没有一条 —— 这里补上真护栏。
// 五个枚举键（密度 / 深浅色 / 配色 / 图标集 / 块内第二行）在 `appearance.ts`（TS）与 `appearance.rs`（Rust）
// 各写一份；对不上会出现「前端选得上、后端白名单拒写 → 重启回默认」这种**预览全绿的活 bug**。
const XLANG_LISTS = ["DENSITIES", "THEMES", "PALETTES", "ICON_SETS", "SECOND_LINES", "FONT_FAMILIES"];
const rustText = await readFile(path.join(repoRoot, "src-tauri/src/appearance.rs"), "utf8");
const xlangMismatches = [];
for (const name of XLANG_LISTS) {
  const ts = [
    ...(tsText.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`))?.[1] ?? "").matchAll(
      /"([a-z0-9_]+)"/g,
    ),
  ].map((m) => m[1]);
  const rs = [
    ...(rustText.match(new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([\\s\\S]*?)\\];`))?.[1] ?? "").matchAll(
      /"([a-z0-9_]+)"/g,
    ),
  ].map((m) => m[1]);
  if (ts.length === 0 || rs.length === 0) {
    xlangMismatches.push(`${name}：读不到（ts=${ts.length} 项 / rust=${rs.length} 项）`);
  } else if (ts.length !== rs.length || ts.some((v, i) => v !== rs[i])) {
    xlangMismatches.push(`${name}：ts=[${ts.join(",")}] ≠ rust=[${rs.join(",")}]`);
  }
}
console.log(
  `# 跨语言清单对齐（appearance.ts ↔ appearance.rs）：${xlangMismatches.length === 0 ? `✓ ${XLANG_LISTS.length} 个枚举键逐项一致` : `✗ ${xlangMismatches.length} 处不对`}`,
);
for (const m of xlangMismatches) console.log(`    [跨语言] ${m}`);
console.log(
  `# 密度刻度三方对齐（tokens.css ↔ appearance.ts）：${mismatches.length === 0 ? "✓ 三档 24 个数全对" : `✗ ${mismatches.length} 处不对`}`,
);
for (const m of mismatches) console.log(`    ${m}`);
for (const m of paletteMismatches) console.log(`    [配色] ${m}`);

// round76 6b（P1）：`--check` 以前在 `process.exit(0)` 就结束了 —— **密度刻度比它排得更晚**，
// 所以那条判据永远红不了（验收却声称它在跑）。现在两种模式都跑到这里，退出码统一算。
if (check) {
  if (checkLines.length) console.log(checkLines.join("\n"));
  console.log(
    `间距契约检查：${spacing.length} 处声明，违规 ${badSpacing.length + badFont.length + badTracking.length}` +
      `（字号 ${fonts.length} 处全走 token；字距 ${ls.length} 处全走 --label-tracking / --display-tracking）；` +
      `密度刻度 CSS↔TS 三方对齐：${mismatches.length === 0 ? "✓ 三档 24 个数全对" : `✗ ${mismatches.length} 处不对`}；` +
      `跨语言清单：${xlangMismatches.length === 0 ? `✓ ${XLANG_LISTS.length} 键逐项一致` : `✗ ${xlangMismatches.length} 处不对`}`,
  );
}
if (checkLines.length || mismatches.length || paletteMismatches.length || xlangMismatches.length) process.exitCode = 1;
if (badSpacing.length) {
  console.log("# 违规取值：");
  for (const [v, n] of tally(badSpacing)) console.log(`  ${n}\t${v}`);
}
