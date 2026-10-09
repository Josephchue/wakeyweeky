// round84（3.2 主题包）· **真尺寸样张生成器**（Step 2）
//
//   node tools/visual/theme-sample-84.mjs                 # 全部候选（八个）
//   node tools/visual/theme-sample-84.mjs --only endfield # pilot：谷地黄一个
//
// 产物：
//   docs/视觉/round84-主题候选样张.html   （自包含、真尺寸 100%、双击可开）
//   docs/visual/round84-contrast.json     （机器报告：每个候选 × 亮暗的 52 对 + 淡化带 4 条）
//
// 口径：**不达标不进样张** —— 用与 `tools/visual/contrast.mjs` 同一套公式（`tools/visual/lib/theme-tokens.mjs`），
// 纹理先合成到底再量背景类对子。种子表：`tools/visual/candidates/round84.json`。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PAIRS,
  checkTokens,
  deriveTokens,
  surfaceBgSize,
  surfaceCss,
  textureOverBg,
} from "./lib/theme-tokens.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const OUT_HTML = "docs/视觉/round84-主题候选样张.html";
const OUT_JSON = "docs/visual/round84-contrast.json";

// ---------------------------------------------------------------- 0 自检：对表与 contrast.mjs 同源
{
  const src = read("tools/visual/contrast.mjs");
  const rows = [...src.matchAll(/\["([^"]+)",\s*"(--[a-z0-9-]+)",\s*"(--[a-z0-9-]+)",\s*([\d.]+)\]/g)].map(
    (m) => [m[1], m[2], m[3], Number(m[4])],
  );
  const mine = PAIRS.filter((p) => !p[0].startsWith("类别色"));
  const same =
    rows.length === mine.length &&
    rows.every((r, i) => r[0] === mine[i][0] && r[1] === mine[i][1] && r[2] === mine[i][2] && r[3] === mine[i][3]);
  const catRows = PAIRS.filter((p) => p[0].startsWith("类别色")).length;
  if (!same || catRows !== 24 || PAIRS.length !== 51) {
    console.error(`✗ 对表与 contrast.mjs 不同源：字面 ${rows.length} vs 本地 ${mine.length}；类别 ${catRows}；合计 ${PAIRS.length}`);
    process.exit(1);
  }
  console.log(`对表自检 ✓：字面 ${rows.length} 行 + 类别 ${catRows} 行 = ${PAIRS.length} 对（与 contrast.mjs 一致）`);
}

// ---------------------------------------------------------------- 1 读 tokens.css 的结构值（不手抄）
const css = read("src/lib/styles/tokens.css");
const one = (re) => (css.match(re)?.[1] ?? "").replace(/\s+/g, " ").trim();
const num = (name, fallback) => Number(one(new RegExp(`--${name}:\\s*(-?[\\d.]+)px`)) || fallback);
const STRUCT = {
  fontUi: one(/--font-ui:\s*([^;]+);/s),
  fontMono: one(/--font-mono:\s*([^;]+);/s),
  space1: num("space-1", 4),
  space2: num("space-2", 8),
  space3: num("space-3", 12),
  space4: num("space-4", 16),
  textMeta: num("text-meta", 12),
  textBody: num("text-body", 13),
  textTitle: num("text-title", 14),
  slot: num("slot-height", 30),
  row: num("row-height", 32),
  radiusSm: num("radius-sm", 2),
  radius: num("radius", 4),
  radiusLg: num("radius-lg", 8),
  catsLight: [...css.matchAll(/--cat-(\d):\s*(#[0-9a-f]{6})/g)].slice(0, 8).map((m) => m[2]),
  catsDark: [...css.matchAll(/--cat-(\d):\s*(#[0-9a-f]{6})/g)].slice(8, 16).map((m) => m[2]),
};
if (STRUCT.fontUi.includes("--") || STRUCT.catsLight.length !== 8 || STRUCT.catsDark.length !== 8) {
  console.error("✗ tokens.css 结构值读取失败（字体栈 / 类目色）");
  process.exit(1);
}

// ---------------------------------------------------------------- 2 派生 + 预检（不达标不进样张）
const data = (() => {
  try {
    return JSON.parse(read("tools/visual/candidates/round84.json"));
  } catch (e) {
    console.error(`✗ 读不了候选种子表（tools/visual/candidates/round84.json）：${e.message}`);
    process.exit(1);
  }
})();
const cands = data.candidates.filter((c) => !only || c.id === only);
if (!cands.length) {
  console.error(`没有候选：--only ${only}`);
  process.exit(1);
}
const report = [];
const prepared = [];
for (const c of cands) {
  const modes = {};
  for (const mode of ["light", "dark"]) {
    const seed = { ...c[mode], cats: mode === "dark" ? STRUCT.catsDark : STRUCT.catsLight };
    const tokens = deriveTokens(seed, mode);
    const bgComposite = textureOverBg(tokens, seed.surface);
    const check = checkTokens(tokens, bgComposite);
    modes[mode] = { seed, tokens, surface: seed.surface, bgComposite, check };
    report.push({
      id: c.id, name: c.name, mode,
      pairs: `${check.pairs.filter((p) => p.ok).length}/${check.pairs.length}`,
      dim: `${check.dim.filter((d) => d.ok).length}/${check.dim.length}`,
      textureBg: bgComposite,
      failures: check.failures,
    });
  }
  prepared.push({ ...c, modes });
}

const bad = report.filter((r) => r.failures.length);
if (bad.length) {
  console.error("✗ 预检未过（不达标不进样张）：");
  for (const r of bad) console.error(`  ${r.name} · ${r.mode}：${r.failures.join("；")}`);
  process.exit(1);
}
console.log(`预检 ✓：${cands.length} 候选 × 亮暗 = ${report.length} 组，52 对 + 淡化带 4 条全过`);

// ---------------------------------------------------------------- 3 纹理 → CSS
// round85：`rgba` / `surfaceCss` / `surfaceBgSize` 已挪进 `lib/theme-tokens.mjs`（与本批生成器共用）

// ---------------------------------------------------------------- 4 HTML
const varsText = (tokens) => Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`).join("\n");
const TOKEN_ORDER = [
  "--bg", "--card", "--text-primary", "--text-secondary", "--text-tertiary", "--accent", "--accent-deco", "--accent-fill", "--warn", "--warn-solid",
  "--block-fill-planned", "--block-ink-planned", "--block-line-planned", "--block-fill-done", "--block-ink-done",
  "--block-line-done", "--block-fill-missed", "--block-ink-missed", "--block-line-missed", "--block-line-ghost",
  "--layer-required-bar", "--layer-elastic-bar", "--on-warn", "--on-accent", "--medal", "--now-line",
  "--cat-1", "--cat-2", "--cat-3", "--cat-4", "--cat-5", "--cat-6", "--cat-7", "--cat-8", "--dim-band",
];

function swatches(tokens) {
  return TOKEN_ORDER.map(
    (k) =>
      `<span class="sw"><i style="background:${tokens[k]}"></i><b>${k.replace("--", "")}</b><em>${tokens[k]}</em></span>`,
  ).join("");
}

function dayCol(i) {
  const H = STRUCT.slot;
  const blocks = [
    { top: H, h: H * 2, cls: "planned", cat: i % 8 + 1, name: "写周报", time: "09:00–10:00", layer: true },
    { top: H * 3, h: H * 1.5, cls: "done", cat: (i + 2) % 8 + 1, name: "健身", time: "10:30–11:00", layer: false },
    { top: H * 5, h: H * 2, cls: "missed", cat: (i + 4) % 8 + 1, name: "读书", time: "12:00–13:00", layer: true },
  ];
  if (i === 1) blocks.push({ top: H * 7, h: H, cls: "ghost", cat: 0, name: "漂流残影", time: "", layer: false });
  return `<div class="tl-col">
    <div class="tl-head">10/${8 + i} 周${"四五六"[i]}</div>
    <div class="tl-body">
      ${blocks
        .map((b) => {
          const catBar = b.cat ? `<i class="cat-bar c${b.cat}"></i>` : "";
          const layer = b.layer ? `<i class="layer-bar req"></i>` : `<i class="layer-bar ela"></i>`;
          return `<div class="blk ${b.cls}" style="top:${b.top}px;height:${b.h - 2}px">${catBar}${layer}<b>${b.name}</b>${
            b.time ? `<em>${b.time}</em>` : ""
          }</div>`;
        })
        .join("")}
      <div class="dim" style="height:${H * 1 - 2}px"></div>
    </div>
  </div>`;
}

function panel(c, mode, m) {
  const { tokens, check } = m;
  const surface = m.surface;
  const radius = c.radius === 0 ? 0 : STRUCT.radius;
  const surfaceLabel = surface ? `${surface.kind}（${surface.opacity}）` : "无（纯色）";
  return `<section class="cand" data-mode="${mode}">
  <header class="cand-h">
    <b>${c.name}</b><span class="brief">${c.brief}</span>
    <span class="tags">${mode === "light" ? "亮色" : "暗色"} · 圆角 ${radius === 0 ? "直角 0" : `${radius}px`} · 图标集 ${c.iconSet} · 质感 ${surfaceLabel}</span>
  </header>
  <div class="app" style="background-image:${surfaceCss(tokens, surface)};background-size:${surfaceBgSize(surface)}">
    <div class="topbar"><b class="app-title">WakeyWeeky</b><span class="pill">本周</span><span class="grow"></span>
      <button class="btn primary">安排</button><button class="btn">▦ 总览</button><button class="btn ghost">⚙</button></div>
    <div class="main">
      <div class="tl">
        <div class="tl-gutter">${["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"]
          .map((t) => `<span>${t}</span>`)
          .join("")}</div>
        ${[0, 1, 2].map((i) => dayCol(i)).join("")}
        <div class="nowline" style="top:${28 + Math.round(STRUCT.slot * 2.5)}px"></div>
      </div>
      <div class="side">
        <div class="panel-title">Backlog <em>12</em></div>
        ${[
          ["写周报", 1, "planned"],
          ["修 bug", 5, "done"],
          ["读书", 2, "missed"],
          ["健身", 3, "planned"],
          ["键盘靶子", 7, "done"],
          ["复制靶子", 6, "planned"],
        ]
          .map(
            ([n, cat, st]) =>
              `<div class="bl-row"><i class="dot c${cat}"></i><span class="nm ${st}">${n}</span><span class="grow"></span><button class="mini">⊘</button></div>`,
          )
          .join("")}
        <div class="panel-title">设置 · 主题与颜色</div>
        <div class="set-row"><span>配色</span><span class="chips"><i style="background:${tokens["--accent"]}"></i><i style="background:${tokens["--cat-2"]}"></i><i style="background:${tokens["--cat-3"]}"></i></span></div>
        <div class="set-row"><span>主题包…</span><span class="grow"></span><button class="btn small">打开</button></div>
        <div class="set-row"><span>提前</span><select class="sel"><option>0 分钟</option><option>5 分钟</option></select></div>
        <div class="fake-menu"><div class="opt on">0 分钟</div><div class="opt">5 分钟</div><div class="opt">10 分钟</div></div>
        <div class="row-controls">
          <button class="btn primary">主要</button><button class="btn">次要</button>
          <input class="inp" placeholder="任务名" />
          <span class="badge">★</span><span class="toast">已保存</span>
        </div>
      </div>
    </div>
  </div>
  <div class="swatches">${swatches(tokens)}</div>
  <div class="report">对比度：<b>${check.pairs.filter((p) => p.ok).length}/${check.pairs.length}</b> 对 · 淡化带 <b>${
    check.dim.filter((d) => d.ok).length
  }/4</b>${m.bgComposite ? ` · 纹理合成底 <code>${m.bgComposite}</code>` : ""}</div>
</section>`;
}

const cssBlocks = prepared
  .flatMap((c) =>
    ["light", "dark"].map((mode) => {
      const m = c.modes[mode];
      const radius = c.radius === 0 ? 0 : STRUCT.radius;
      return `[data-cand="${c.id}"][data-mode="${mode}"] {\n${varsText(m.tokens)}\n  --radius-x: ${radius}px;\n  --radius-sm-x: ${c.radius === 0 ? 0 : STRUCT.radiusSm}px;\n}`;
    }),
  )
  .join("\n");

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>round84 · 主题候选真尺寸样张</title>
<style>
  :root { --font-ui: ${STRUCT.fontUi}; --font-mono: ${STRUCT.fontMono}; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; background: #d9d9d9; font-family: var(--font-ui); font-size: ${STRUCT.textBody}px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #444; font-size: ${STRUCT.textMeta}px; margin-bottom: 16px; }
  .cand { background: var(--bg); border: 1px solid #bbb; margin: 0 0 22px; }
  .cand-h { display: flex; align-items: baseline; gap: 10px; padding: 8px 12px; border-bottom: 1px solid #ddd; font-size: ${STRUCT.textMeta}px; }
  .cand-h b { font-size: ${STRUCT.textTitle}px; }
  .brief { color: #555; }
  .tags { margin-left: auto; color: #666; }
  [data-cand][data-mode] { background: var(--bg); color: var(--text-primary); }
  .app { position: relative; padding: 10px 12px 14px; }
  .topbar { display: flex; align-items: center; gap: ${STRUCT.space2}px; padding: 6px 8px; background: var(--card); border-radius: var(--radius-x); }
  .app-title { font-size: ${STRUCT.textTitle}px; }
  .pill { font-size: ${STRUCT.textMeta}px; color: var(--text-secondary); border: 1px solid var(--block-line-missed); border-radius: 999px; padding: 1px 8px; }
  .grow { flex: 1; }
  .btn { font: inherit; font-size: ${STRUCT.textMeta}px; color: var(--text-primary); background: var(--card); border: 1px solid var(--block-line-missed); border-radius: var(--radius-x); padding: 4px 10px; cursor: default; }
  .btn.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
  .btn.ghost { color: var(--text-secondary); }
  .btn.small { padding: 2px 8px; }
  .main { display: flex; gap: 14px; margin-top: 12px; }
  .tl { position: relative; display: flex; background: var(--bg); border: 1px solid var(--block-line-missed); border-radius: var(--radius-x); }
  .tl-gutter { width: 44px; background: var(--bg); font-family: var(--font-mono); font-size: ${STRUCT.textMeta}px; color: var(--text-tertiary); display: flex; flex-direction: column; }
  .tl-gutter span { height: ${STRUCT.slot * 2}px; text-align: right; padding-right: 6px; transform: translateY(-6px); }
  .tl-col { width: 136px; border-left: 1px solid var(--grid-line); }
  .tl-col + .tl-col { border-left-color: var(--grid-line); }
  .tl-head { height: 28px; line-height: 28px; text-align: center; font-size: ${STRUCT.textMeta}px; color: var(--text-secondary); border-bottom: 1px solid var(--grid-line); }
  .tl-body { position: relative; height: ${STRUCT.slot * 8}px;
    background-image: repeating-linear-gradient(0deg, var(--grid-line) 0 1px, transparent 1px ${STRUCT.slot}px); }
  .blk { position: absolute; left: 3px; right: 3px; background: var(--block-fill-planned); border: 1px solid var(--block-line-planned);
    border-radius: var(--radius-sm-x); padding: 2px 4px 2px 9px; overflow: hidden; color: var(--block-ink-planned); }
  .blk b { display: block; font-size: ${STRUCT.textMeta}px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .blk em { font-size: 10px; font-style: normal; color: var(--block-ink-planned); opacity: .8; }
  .blk.done { background: var(--block-fill-done); border-color: var(--block-line-done); color: var(--block-ink-done); }
  .blk.missed { background: var(--block-fill-missed); border-color: var(--block-line-missed); color: var(--block-ink-missed); }
  .blk.missed { border-style: dashed; }
  .blk.ghost { background: transparent; border-style: dashed; border-color: var(--block-line-ghost); color: var(--text-tertiary); }
  .cat-bar { position: absolute; left: 0; bottom: 0; right: 0; height: 2px; }
  .layer-bar { position: absolute; left: 0; top: 0; bottom: 0; width: 4px; }
  .layer-bar.req { background: var(--layer-required-bar); }
  .layer-bar.ela { background: var(--layer-elastic-bar); }
  .c1 { background: var(--cat-1); } .c2 { background: var(--cat-2); } .c3 { background: var(--cat-3); } .c4 { background: var(--cat-4); }
  .c5 { background: var(--cat-5); } .c6 { background: var(--cat-6); } .c7 { background: var(--cat-7); } .c8 { background: var(--cat-8); }
  .dim { position: absolute; left: 0; right: 0; top: 0; background: var(--dim-band); }
  .nowline { position: absolute; left: 40px; right: 0; height: 0; border-top: 2px solid var(--now-line); z-index: 3; }
  .nowline::before { content: ""; position: absolute; left: -4px; top: -4px; width: 6px; height: 6px; border-radius: 50%; background: var(--now-line); }
  .side { flex: 1; min-width: 210px; background: var(--card); border: 1px solid var(--block-line-missed); border-radius: var(--radius-x); padding: 8px 10px; }
  .panel-title { font-size: ${STRUCT.textMeta}px; color: var(--text-secondary); letter-spacing: .06em; margin: 4px 0 6px; }
  .panel-title em { color: var(--text-tertiary); font-style: normal; }
  .bl-row, .set-row { display: flex; align-items: center; gap: 8px; height: ${STRUCT.row}px; border-bottom: 1px solid var(--grid-line); font-size: ${STRUCT.textBody}px; }
  .dot { width: 8px; height: 8px; border-radius: 2px; }
  .nm.done { text-decoration: line-through; color: var(--text-secondary); }
  .nm.missed { color: var(--text-tertiary); }
  .mini { font: inherit; font-size: ${STRUCT.textMeta}px; background: none; border: 1px solid var(--block-line-missed); color: var(--text-secondary); border-radius: var(--radius-x); }
  .chips i { display: inline-block; width: 18px; height: 12px; margin-right: 4px; border: 1px solid var(--grid-line); }
  .sel { font: inherit; font-size: ${STRUCT.textMeta}px; background: var(--card); color: var(--text-primary); border: 1px solid var(--block-line-missed); border-radius: var(--radius-x); padding: 2px 6px; }
  .sel option { background: var(--card); color: var(--text-primary); }
  .fake-menu { width: 120px; border: 1px solid var(--block-line-missed); background: var(--card); margin: 6px 0 0 auto; border-radius: var(--radius-x); }
  .opt { padding: 3px 8px; font-size: ${STRUCT.textMeta}px; color: var(--text-primary); }
  .opt.on { background: var(--accent); color: var(--on-accent); }
  .row-controls { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .inp { font: inherit; font-size: ${STRUCT.textMeta}px; background: var(--card); color: var(--text-primary); border: 1px solid var(--block-line-missed); border-radius: var(--radius-x); padding: 3px 6px; width: 90px; }
  .badge { color: var(--medal); font-size: ${STRUCT.textTitle}px; }
  .toast { background: var(--card); border: 1px solid var(--accent); color: var(--text-primary); font-size: ${STRUCT.textMeta}px; border-radius: var(--radius-x); padding: 2px 8px; }
  .swatches { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--grid-line); background: var(--bg); font-size: 10px; }
  .sw { display: inline-flex; align-items: center; gap: 4px; }
  .sw i { display: inline-block; width: 14px; height: 14px; border: 1px solid #999; border-radius: 3px; }
  .sw em { color: #888; font-style: normal; font-family: var(--font-mono); }
  .report { padding: 6px 12px 10px; font-size: ${STRUCT.textMeta}px; color: #444; }
  .report code { font-family: var(--font-mono); }
  [data-mode="dark"] .cand-h { background: #222; color: #eee; }
</style></head>
<body>
<h1>round84 · 主题候选真尺寸样张（Step 2${only ? "a · pilot" : ""}）</h1>
<div class="meta">真尺寸 100%（不缩放）· 每个候选 = 亮 / 暗两块 · 数据来自 <code>tools/visual/candidates/round84.json</code> + 派生 + 52 对预检（全过才进页）· 生成：<code>node tools/visual/theme-sample-84.mjs</code></div>
${prepared
  .map((c) =>
    ["light", "dark"]
      .map((mode) => `<div data-cand="${c.id}" data-mode="${mode}">${panel(c, mode, c.modes[mode])}</div>`)
      .join(""),
  )
  .join("")}
<style>${cssBlocks}</style>
</body></html>`;

mkdirSync(path.join(root, path.dirname(OUT_HTML)), { recursive: true });
writeFileSync(path.join(root, OUT_HTML), html);
writeFileSync(path.join(root, OUT_JSON), JSON.stringify({ note: "round84 主题候选 52 对 + 淡化带预检", generated: new Date().toISOString(), candidates: report }, null, 1));
console.log(`已写：${OUT_HTML}（${(html.length / 1024).toFixed(0)}KB）· ${OUT_JSON}`);

// ---------------------------------------------------------------- 5 实机场景（真前端 + 假数据）
// 为什么：令牌色卡看不出「真应用长什么样」——把候选令牌**注入真前端**再截图（预览 harness 的家法）。
// 生成的场景文件：tools/preview/scenes/round84-candidates.js（由本工具生成，勿手改）。
const payload = {
  tokens: Object.fromEntries(prepared.map((c) => [c.id, { light: c.modes.light.tokens, dark: c.modes.dark.tokens }])),
  surfaces: Object.fromEntries(
    prepared.map((c) => [
      c.id,
      {
        light: surfaceCss(c.modes.light.tokens, c.modes.light.surface),
        dark: surfaceCss(c.modes.dark.tokens, c.modes.dark.surface),
      },
    ]),
  ),
  sizes: Object.fromEntries(
    prepared.map((c) => [
      c.id,
      {
        light: surfaceBgSize(c.modes.light.surface),
        dark: surfaceBgSize(c.modes.dark.surface),
      },
    ]),
  ),
  radii: Object.fromEntries(prepared.map((c) => [c.id, c.radius === 0 ? 0 : 4])),
  decor: (() => {
    try {
      const raw = JSON.parse(read("tools/visual/candidates/round84-decor.json")).decor ?? {};
      if (!Object.values(raw).some((v) => String(v).includes("__FONT_SAMIGIRIAN__"))) return raw;
      // round85：字体已挪进 `src/lib/assets/`（应用要打包它；样张生成器从那里读同一份）
      const fontB64 = readFileSync(path.join(root, "src/lib/assets/SamigirianSerif-Regular.woff2")).toString("base64");
      const fontUri = `data:font/woff2;base64,${fontB64}`;
      return Object.fromEntries(
        Object.entries(raw).map(([id, css]) => [id, String(css).split("__FONT_SAMIGIRIAN__").join(fontUri)]),
      );
    } catch (e) {
      console.error(`decor 读取失败（装饰不进样张）：${e.message}`);
      return {};
    }
  })(),
};

const scene = `// round84（3.2 主题包）· **实机候选场景** —— 由 \`tools/visual/theme-sample-84.mjs\` 生成，勿手改。
//
// 干什么：把候选主题的令牌（+ 质感背景）注入**真前端**（预览 harness 的假数据），逐个截图。
// 用法：
//   node tools/preview/preview.mjs --width 1500 --shots docs/visual/round84/实机 --shots-file scenes/round84-candidates.js
//   node tools/preview/preview.mjs --width 1500 --theme dark --shots docs/visual/round84/实机/暗色 --shots-file scenes/round84-candidates.js
document.documentElement.dataset.checks = "shots";

const PAYLOAD = ${JSON.stringify(payload)};
const MODE = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
const ALL_KEYS = [
  ...new Set(Object.values(PAYLOAD.tokens).flatMap((m) => [...Object.keys(m.light), ...Object.keys(m.dark)])),
];

const flush = () => new Promise((r) => queueMicrotask(() => queueMicrotask(r)));
const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i++) await flush();
};
const key = (k) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const closeAll = async () => {
  for (let i = 0; i < 3; i++) key("Escape");
  document.querySelectorAll(".overlay-backdrop").forEach((b) => b.click());
  await settle(30);
  document.activeElement?.blur?.();
};

let surfaceTag = null;
let decorTag = null;
function applyTokens(id) {
  const root = document.documentElement;
  for (const k of ALL_KEYS) root.style.removeProperty(k);
  const tokens = PAYLOAD.tokens[id][MODE];
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
  const sharp = PAYLOAD.radii[id] === 0;
  for (const n of ["--radius-sm", "--radius", "--radius-lg"]) {
    if (sharp) root.style.setProperty(n, "0px");
    else root.style.removeProperty(n);
  }
  if (!surfaceTag) {
    surfaceTag = document.createElement("style");
    surfaceTag.id = "r84-surface";
    document.head.append(surfaceTag);
  }
  surfaceTag.textContent = \`body { background-image: \${PAYLOAD.surfaces[id][MODE]}; background-size: \${PAYLOAD.sizes[id][MODE]}; }\`;
  if (!decorTag) {
    decorTag = document.createElement("style");
    decorTag.id = "r84-decor";
    document.head.append(decorTag);
  }
  decorTag.textContent = PAYLOAD.decor[id] ?? "";
  window.__DIAG.push(\`r84实机 \${id}/\${MODE} 令牌=\${Object.keys(tokens).length} 圆角=\${sharp ? "直角" : "默认"} 装饰=\${PAYLOAD.decor[id] ? "有" : "无"}\`);
}

window.__SHOTS = Object.keys(PAYLOAD.tokens).flatMap((id) => [
  {
    name: \`01-\${id}-主界面\`,
    run: async () => {
      await closeAll();
      applyTokens(id);
      await settle(40);
    },
  },
  {
    name: \`02-\${id}-设置面板\`,
    run: async () => {
      await closeAll();
      applyTokens(id);
      const gear = document.querySelector(".sanity-gear");
      if (gear) gear.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle(80);
    },
  },
]);
`;
const SCENE_PATH = "tools/preview/scenes/round84-candidates.js";
mkdirSync(path.join(root, path.dirname(SCENE_PATH)), { recursive: true });
writeFileSync(path.join(root, SCENE_PATH), scene);
console.log(`已写：${SCENE_PATH}（${prepared.length} 候选 × 2 幕）`);

// ---------------------------------------------------------------- 6 实机对照页（截图按「候选 × 亮/暗」排）
const shots = [];
prepared.forEach((c, i) => {
  const idx = String(i * 2 + 1).padStart(2, "0");
  const idx2 = String(i * 2 + 2).padStart(2, "0");
  shots.push({
    id: c.id,
    name: c.name,
    brief: c.brief,
    radii: c.radius === 0 ? "直角 0" : "默认圆角",
    light: [`${idx}-01-${c.id}-主界面.png`, `${idx2}-02-${c.id}-设置面板.png`],
    dark: [`${idx}-01-${c.id}-主界面.png`, `${idx2}-02-${c.id}-设置面板.png`],
    pairs: `${report.find((r) => r.id === c.id && r.mode === "light").pairs} / ${report.find((r) => r.id === c.id && r.mode === "dark").pairs}`,
  });
});
const cell = (which, c) =>
  c[which]
    .map(
      (f) => `<img loading="lazy" src="../visual/round84/实机/${which === "dark" ? "暗色/" : ""}${f}" alt="${c.name} ${which}" />`,
    )
    .join("");
const sheet = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>round84 · 主题候选实机对照</title>
<style>
  body { margin: 0; padding: 20px; background: #d9d9d9; font-family: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif; font-size: 13px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #444; margin-bottom: 16px; }
  .cand { background: #fff; border: 1px solid #bbb; margin-bottom: 20px; }
  .cand-h { display: flex; align-items: baseline; gap: 10px; padding: 8px 12px; border-bottom: 1px solid #ddd; }
  .cand-h b { font-size: 14px; }
  .cand-h em { margin-left: auto; font-style: normal; color: #666; }
  .row { display: flex; gap: 10px; padding: 10px 12px; overflow-x: auto; }
  .row img { width: 100%; max-width: 740px; border: 1px solid #ccc; }
  .tag { writing-mode: vertical-rl; color: #666; font-size: 12px; }
</style></head>
<body>
<h1>round84 · 主题候选实机对照（真前端 + 假数据）</h1>
<div class="meta">令牌 + 质感注入真前端后截图（预览 harness）· 亮/暗各两幕（主界面 / 设置面板）· 52 对预检：亮 / 暗</div>
${prepared
  .map((c) => {
    const s = shots.find((x) => x.id === c.id);
    return `<section class="cand"><header class="cand-h"><b>${c.name}</b><span>${c.brief}</span><em>${s.radii} · 预检 ${s.pairs}</em></header>
  <div class="row"><span class="tag">亮色</span>${cell("light", s)}</div>
  <div class="row"><span class="tag">暗色</span>${cell("dark", s)}</div>
</section>`;
  })
  .join("\n")}
</body></html>`;
const OUT_SHEET = "docs/视觉/round84-主题候选-实机.html";
writeFileSync(path.join(root, OUT_SHEET), sheet);
console.log(`已写：${OUT_SHEET}（先跑实机截图，再刷新此页）`);
