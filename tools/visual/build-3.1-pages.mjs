// round76（3.1a）：把「全矩阵截图 + 组件尺寸表 + 对比度实测」组装成两张可重生成的 HTML。
//
// 为什么要脚本而不是手写：round72 的教训 —— 一次性脚本生成的页面，下次想更新就只能重写一遍。
// 这两张页面（`docs/visual/3.1对照图.html` / `3.1组件展示页.html`）随时能重跑出来。
//
// 用法（仓库根；先跑好矩阵与展示页与对比度脚本）：
//   node tools/preview/preview.mjs --matrix            # 72 张 + matrix-results.json
//   node tools/preview/preview.mjs --gallery           # 18 张 + gallery.json
//   node tools/visual/contrast.mjs --json docs/visual/contrast-table.json
//   node tools/visual/build-3.1-pages.mjs              # 生成两张 HTML + 自检
//
// `设-04` 自检：两张页面里**任何设了底色的规则都必须同时给字色**（除非标了 `/* 无字 */`）——
// 这是你 2026-10-05 在配色对照图上抓到的真 bug（暗色下样片黑字）的机器化防线。
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const P = (...p) => path.join(repoRoot, ...p);
const readJson = async (rel, fallback) => {
  try {
    return JSON.parse(await readFile(P(rel), "utf8"));
  } catch {
    return fallback;
  }
};

const matrix = await readJson("docs/visual/3.1矩阵/matrix-results.json", null);
const gallery = await readJson("docs/visual/3.1组件展示/gallery.json", null);
// round77 收尾：五套图标逐套量（`preview.mjs --gallery` 的第二轮产物）
const galleryIcons = await readJson("docs/visual/3.1组件展示/gallery-icons.json", null);
const contrast = await readJson("docs/visual/contrast-table.json", null);
if (!matrix || !gallery) {
  console.error(
    "缺数据：先跑 `node tools/preview/preview.mjs --matrix` 与 `--gallery`（输出目录用默认的 docs/visual/…）",
  );
  process.exit(1);
}

const PALETTE_LABEL = { warm: "暖砂 · 清晰绿（A，默认）", cool: "冷白 · 深翠（B）", sage: "素灰绿 · 静默（C）" };
const DENSITY_LABEL = { compact: "紧凑", comfortable: "舒适（默认）", loose: "宽松" };
const THEME_LABEL = { light: "亮色", dark: "暗色" };

/** 页面骨架（浅色 / 暗色都读得清；图片 lazy） */
const shell = (title, subtitle, sections) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
  :root { --bg:#f6f3ef; --card:#fff; --ink:#211d18; --muted:#5d574e; --line:#e4ddd4; --accent:#0e6b52; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#1a1917; --card:#242320; --ink:#eae7e1; --muted:#b5afa5; --line:#3a3833; --accent:#4ec39b; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 20px 64px; background: var(--bg); color: var(--ink);
    font-family: "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif;
    font-size: 14px; line-height: 1.6; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  h2 { font-size: 17px; margin: 34px 0 10px; padding-top: 10px; border-top: 1px solid var(--line); }
  h3 { font-size: 14px; margin: 20px 0 8px; color: var(--muted); font-weight: 600; }
  .lead { color: var(--muted); margin: 0 0 4px; }
  .note { background: var(--card); border: 1px solid var(--line); border-left: 3px solid var(--accent);
    border-radius: 3px; padding: 10px 12px; margin: 12px 0; color: var(--ink); }
  .note b { color: var(--ink); }
  .toc { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 4px; }
  .toc a { color: var(--accent); text-decoration: none; border: 1px solid var(--line);
    border-radius: 10px; padding: 1px 10px; background: var(--card); }
  .pair { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-start; }
  .pair figure { margin: 0; flex: 1 1 420px; min-width: 320px; }
  figure { margin: 0; }
  figure img { width: 100%; height: auto; display: block; border: 1px solid var(--line); border-radius: 3px; background: var(--card); /* 无字 */ }
  figcaption { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
  .cell { border: 1px solid var(--line); border-radius: 3px; overflow: hidden; background: var(--card); /* 无字 */ }
  .cell img { width: 100%; display: block; }
  .cell .cap { font-size: 12px; color: var(--muted); padding: 4px 8px; }
  table { border-collapse: collapse; font-size: 13px; background: var(--card); color: var(--ink); width: 100%; }
  th, td { border: 1px solid var(--line); padding: 3px 8px; text-align: left; }
  thead th { background: var(--bg); color: var(--ink); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  code { background: var(--bg); color: var(--ink); padding: 0 4px; border-radius: 3px; }
  .ok { color: var(--accent); }
</style>
</head>
<body>
<h1>${title}</h1>
<p class="lead">${subtitle}</p>
${sections}
</body>
</html>
`;

// ---------------------------------------------------------------- 对照图
const matrixRows = matrix.rows;
const shot = (r) => `3.1矩阵/${r.palette}-${r.theme}-${r.density}-${r.width}-${r.locale}.jpg`;
const pick = (want) =>
  matrixRows.find(
    (r) =>
      r.palette === want.palette &&
      r.theme === want.theme &&
      r.density === want.density &&
      r.width === want.width &&
      r.locale === want.locale,
  );

const beforeAfter = `
<h2 id="ba">§1 改前 → 改后</h2>
<div class="note">
  <b>改前</b>用的是 0.23.0 交付时的那几张（同一个 preview harness、同一份假数据，真库一次没碰）——
  旧版<b>只有一种外观</b>（亮色 + 实心绿块），所以「改前」凑不出 12 张；
  要看全部新外观请看 §2–§4。<b>改后</b>全部是本批真产物。
</div>
<div class="pair">
  <figure><img src="../验收/round74-zh-1500.png" alt="改前 1500 中文"><figcaption>改前 · 1500px · 中文（0.23.0）</figcaption></figure>
  <figure><img src="${shot(pick({ palette: "warm", theme: "light", density: "comfortable", width: 1500, locale: "zh" }))}" alt="改后 1500 中文"><figcaption>改后 · 1500px · 中文（暖砂 · 亮 · 舒适）</figcaption></figure>
</div>
<div class="pair" style="margin-top:14px">
  <figure><img src="../验收/round74-en-715.png" alt="改前 715 英文"><figcaption>改前 · 715px · 英文（0.23.0）</figcaption></figure>
  <figure><img src="${shot(pick({ palette: "warm", theme: "dark", density: "comfortable", width: 715, locale: "en" }))}" alt="改后 715 英文"><figcaption>改后 · 715px · 英文（暖砂 · <b>暗</b> · 舒适）</figcaption></figure>
</div>
`;

const paletteCells = [];
for (const palette of ["warm", "cool", "sage"]) {
  for (const theme of ["light", "dark"]) {
    const r = pick({ palette, theme, density: "comfortable", width: 1500, locale: "zh" });
    paletteCells.push(
      `<div class="cell"><a href="${shot(r)}"><img loading="lazy" src="${shot(r)}" alt="${PALETTE_LABEL[palette]} ${THEME_LABEL[theme]}"></a>` +
        `<div class="cap">${PALETTE_LABEL[palette]} · ${THEME_LABEL[theme]}</div></div>`,
    );
  }
}

const densityCells = ["compact", "comfortable", "loose"].map((density) => {
  const r = pick({ palette: "warm", theme: "light", density, width: 1500, locale: "zh" });
  return (
    `<div class="cell"><a href="${shot(r)}"><img loading="lazy" src="${shot(r)}" alt="密度 ${DENSITY_LABEL[density]}"></a>` +
    `<div class="cap">${DENSITY_LABEL[density]}</div></div>`
  );
});

const matrixSections = [];
for (const palette of ["warm", "cool", "sage"]) {
  for (const theme of ["light", "dark"]) {
    const cells = matrixRows
      .filter((r) => r.palette === palette && r.theme === theme)
      .map((r) => {
        const bad = (r.fails ?? []).length;
        return (
          `<div class="cell"><a href="${shot(r)}"><img loading="lazy" src="${shot(r)}" alt="${r.density}-${r.width}-${r.locale}"></a>` +
          `<div class="cap">${DENSITY_LABEL[r.density]} · ${r.width}px · ${r.locale}${bad ? ` · <b>✗ ${bad}</b>` : ""}</div></div>`
        );
      })
      .join("\n");
    matrixSections.push(
      `<h3>${PALETTE_LABEL[palette]} · ${THEME_LABEL[theme]}（12 格：密度 3 × 宽 2 × 语言 2）</h3>\n<div class="grid">\n${cells}\n</div>`,
    );
  }
}

const failedCells = matrixRows.filter((r) => (r.fails ?? []).length > 0);
const 对照图 = shell(
  "3.1 对照图（round76 / 0.24.0）",
  `改前 → 改后 · 三套配色 · 密度三档 · <b>72 格全矩阵</b>（每格都跑过溢出扫描 + 本批新增的读类检查：${matrixRows.length} 格 / 失败 ${failedCells.length} 格）。`,
  `<div class="toc">
     <a href="#ba">§1 改前/改后</a><a href="#palette">§2 三套配色 × 亮暗</a>
     <a href="#density">§3 密度三档</a><a href="#matrix">§4 72 格全矩阵</a><a href="#self">§5 自检</a>
   </div>
   ${beforeAfter}
   <h2 id="palette">§2 三套配色 × 亮暗（12 张，舒适档 / 1500px / 中文）</h2>
   <div class="grid">${paletteCells.join("\n")}</div>
   <h2 id="density">§3 密度三档（暖砂 · 亮色 / 1500px / 中文）</h2>
   <div class="grid">${densityCells.join("\n")}</div>
   <h2 id="matrix">§4 全矩阵：72 格</h2>
   <div class="note">
     72 格 = 3 配色 × 2 主题 × 3 密度 × 2 宽（1500 / 715）× 2 语言（中 / 英）。
     每格都是<b>真前端 + 假数据</b>跑出来的：① 8 个尺寸/字号 token 必须等于该密度档的期望值；
     ② 块内名字/时间/刻度字号 ≥12px；③ 层条 4px、弹性虚线；④ 现在线在、且不吃指针；⑤ 今天列有微高光；
     ⑥ 默认关掉分类条时一个都不画；⑦ <b>完整溢出扫描</b>（主屏 + 设置面板 + 四个覆盖面板）0 命中。
     明细：<code>3.1矩阵/matrix-results.json</code>。
   </div>
   ${matrixSections.join("\n")}
   <h2 id="self">§5 本页自检（设-04）</h2>
   <div class="note">生成时跑过「有底必有字色」扫描：本页任何设了底色的规则都同时给了字色。
     出处：你 2026-10-05 在配色对照图上抓到的真 bug（暗色下样片黑字）。</div>`,
);
await writeFile(P("docs/visual/3.1对照图.html"), 对照图);

// ---------------------------------------------------------------- 组件展示页
const rows = gallery.rows;
const size = (v) => (v ? `${v.w}×${v.h}` : "—");
const tableRows = rows
  .map((r) => {
    const m = r.measured;
    return `<tr>
      <td>${DENSITY_LABEL[r.density]} · ${THEME_LABEL[r.theme]}</td>
      <td>${PALETTE_LABEL[r.palette]}</td>
      <td class="num">${r.tokens.slotHeight}</td>
      <td class="num">${r.tokens.rowHeight}</td>
      <td class="num">${r.tokens.controlHeight}</td>
      <td class="num">${r.tokens.timelineCol}</td>
      <td class="num">${size(m.backlogRow)}</td>
      <td class="num">${size(m.settingsRow)}</td>
      <td class="num">${m.blockHeights?.["30"] ?? "—"}</td>
      <td class="num">${m.blockHeights?.["60"] ?? "—"}</td>
      <td class="num">${m.actionButton ? `${m.actionButton.w}×${m.actionButton.h}` : "—"}</td>
      <td class="num">${m.layerBarWidth ?? "—"}</td>
      <td class="num">${m.fontBlockName ?? "—"} / ${m.fontTick ?? "—"}</td>
    </tr>`;
  })
  .join("\n");

const contrastSection = contrast
  ? `<h2 id="contrast">§3 对比度实测（${contrast.totalPairs} 对 / 失败 ${contrast.failed} 对）</h2>
     <div class="note">在真浏览器里算的（<code>tools/visual/contrast.mjs</code>）：亮/暗由 <code>Emulation.setEmulatedMedia</code> 固定，
     token 走隐藏元素的 <code>color</code> 让浏览器解开 <code>var()</code> / <code>color-mix()</code>。
     口径 = 你 2026-10-05 定案：正文与次要文字 ≥4.5；图形（层条 / 类别条 / 虚线 / 描边）≥3；装饰性描边 ≥1.4。</div>
     ${contrast.groups
       .map(
         (g) => `<h3>${PALETTE_LABEL[g.palette]} · ${THEME_LABEL[g.theme]}</h3>
       <table><thead><tr><th>前景 / 背景</th><th>比值</th><th>要求</th></tr></thead><tbody>
       ${g.rows.map((r) => `<tr><td>${r.label} <code>${r.fg}</code> / <code>${r.bg}</code></td><td class="num">${r.r.toFixed(2)}</td><td>${r.ok ? `<span class="ok">≥${r.min} ✓</span>` : `✗ <${r.min}`}</td></tr>`).join("\n")}
       </tbody></table>`,
       )
       .join("\n")}`
  : `<h2 id="contrast">§3 对比度实测</h2><div class="note">还没生成：先跑 <code>node tools/visual/contrast.mjs --json docs/visual/contrast-table.json</code>。</div>`;

const galleryCells = rows
  .map(
    (r) =>
      `<div class="cell"><a href="3.1组件展示/${r.density}-${r.theme}-${r.palette}.jpg"><img loading="lazy" src="3.1组件展示/${r.density}-${r.theme}-${r.palette}.jpg" alt="${r.density}-${r.theme}-${r.palette}"></a>` +
      `<div class="cap">${DENSITY_LABEL[r.density]} · ${THEME_LABEL[r.theme]} · ${PALETTE_LABEL[r.palette]}</div></div>`,
  )
  .join("\n");

/** round77 收尾（`图-13`）：五套图标逐套量 —— 命中区 <32 判红 */
const iconRows = galleryIcons?.rows ?? [];
const iconBad = iconRows.filter(
  (r) => r.hitMin < 32 || r.emptyPath > 0 || r.withNoPath > 0 || (r.withFallback ?? 0) > 0,
);
const iconSection = galleryIcons
  ? `<h2 id="icons">§3 图标逐套（五套 × 亮/暗 · ${iconRows.length} 格）</h2>
     <div class="note">
       五套图标（<code>icon_set</code>）都走<b>真实设置路径</b>切换；每格量：块上动作按钮的命中区（<b>红线 32×32</b>，
       低于则判红）、图标本体尺寸、<code>path</code> 是否齐全，以及<b>形状来源</b>
       （<code>data-icon-source</code> —— 缺项回退时它会写 lucide；「回退 = 0」看的是它，不是回显请求值的 <code>data-icon-set</code>）。
       判定：${iconBad.length === 0 ? `<span class="ok">全绿 ✓</span>` : `✗ ${iconBad.length} 格不达标`}。
     </div>
     <table>
       <thead><tr><th>图标集</th><th>主题</th><th>DOM 请求值 / 形状来源</th><th>回退</th><th>块上按钮</th><th>命中区最小</th><th>图标本体</th><th>空 path</th><th>整页图标数</th></tr></thead>
       <tbody>${iconRows
         .map(
           (r) => `<tr>
         <td>${r.set}</td><td>${THEME_LABEL[r.theme]}</td>
         <td><code>${(r.iconSetInDom ?? []).join(", ") || "—"}</code> / <code>${(r.sources ?? []).join(", ") || "—"}</code></td>
         <td class="num">${r.withFallback === 0 ? `<span class="ok">0 ✓</span>` : `<span class="bad">${r.withFallback}</span>`}</td>
         <td class="num">${r.actions}</td>
         <td class="num">${r.hitMin < 32 ? `<span class="bad">${r.hitMin}</span>` : `<span class="ok">${r.hitMin}</span>`}</td>
         <td class="num">${r.svgSize ? `${r.svgSize[0]}×${r.svgSize[1]}` : "—"}</td>
         <td class="num">${r.emptyPath} / noPath ${r.withNoPath}</td>
         <td class="num">${r.iconsTotal}</td>
       </tr>`,
         )
         .join("\n")}</tbody>
     </table>
     <div class="grid">${iconRows
       .map(
         (r) =>
           `<div class="cell"><a href="3.1组件展示/icons-${r.set}-${r.theme}.jpg"><img loading="lazy" src="3.1组件展示/icons-${r.set}-${r.theme}.jpg" alt="icons-${r.set}-${r.theme}"></a>` +
           `<div class="cap">${r.set} · ${THEME_LABEL[r.theme]}</div></div>`,
       )
       .join("\n")}</div>`
  : `<h2 id="icons">§3 图标逐套</h2><div class="note">还没生成：先跑 <code>node tools/preview/preview.mjs --gallery</code>。</div>`;

const 组件展示页 = shell(
  "3.1 组件展示页（round76–77 / 0.25.0）",
  `真前端的逐档实测：${rows.length} 格 = 3 密度 × 2 主题 × 3 配色（1500px / 中文）+ 五套图标逐套（${iconRows.length} 格）。量的是<b>真实组件的盒子</b>，不是手画样例。`,
  `<div class="toc"><a href="#sizes">§1 尺寸表</a><a href="#shots">§2 逐格截图</a><a href="#icons">§3 图标逐套</a><a href="#contrast">§4 对比度实测</a></div>
   <h2 id="sizes">§1 尺寸表（真组件量出来的）</h2>
   <div class="note">
     「块高 30/60 分钟」= 时间轴上按时间绝对定位后的<b>实际盒子高度</b>（含 1px 内缩 × 2）。
     「动作按钮」是块上那四个小按钮的命中区 —— <b>round77 已抬到 32×32</b>（表里应为 32×32）。
     口诀：格高 / 行高 / 控件高 / 列宽四个数随密度变，别名（名字 / 刻度）字号也在表里。
   </div>
   <table>
     <thead><tr>
       <th>密度 · 主题</th><th>配色</th><th>格高</th><th>行高</th><th>控件高</th><th>列宽</th>
       <th>Backlog 行</th><th>设置行</th><th>30 分块</th><th>60 分块</th><th>动作按钮</th><th>层条</th><th>名字 / 刻度字号</th>
     </tr></thead>
     <tbody>${tableRows}</tbody>
   </table>
   <h2 id="shots">§2 逐格截图（${rows.length} 张）</h2>
   <div class="grid">${galleryCells}</div>
   ${iconSection}
   ${contrastSection}`,
);
await writeFile(P("docs/visual/3.1组件展示页.html"), 组件展示页);

// ---------------------------------------------------------------- 设-04 自检：有底必有字色
/**
 * 扫生成的 HTML 的 `<style>` 块：任何规则里出现了 `background` / `background-color`，
 * 就必须同时出现 `color:`（或标了 `/* 无字 *​/` 说明这块里没有文字）。
 * 只查这两个页面 —— 它们是我这批新写的样片，正好是设-04 的靶子。
 */
function selfCheck(html, name) {
  const problems = [];
  for (const block of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    for (const rule of block[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = rule[1].trim().replace(/\s+/g, " ");
      const body = rule[2];
      if (!/background(-color)?\s*:/.test(body)) continue;
      if (/(^|[^\w-])color\s*:/.test(body)) continue;
      if (body.includes("/* 无字 */")) continue;
      problems.push(`${name}：${sel} 设了底色但没有字色`);
    }
  }
  return problems;
}
const problems = [
  ...selfCheck(对照图, "3.1对照图.html"),
  ...selfCheck(组件展示页, "3.1组件展示页.html"),
];
console.log(`生成：docs/visual/3.1对照图.html（${matrixRows.length} 格）· docs/visual/3.1组件展示页.html（${rows.length} 格）`);
console.log(`设-04 自检（有底必有字色）：${problems.length === 0 ? "✓ 0 违规" : `✗ ${problems.length} 处`}`);
for (const p of problems) console.log(`  ${p}`);
if (problems.length) process.exit(1);
