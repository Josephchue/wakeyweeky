// round82（3.1c₂ · `盘-*`）：**托盘图标候选 v2 —— 借开源图标素材**（你 2026-10-07：「太抽象太丑……
// 找无版权争议的素材/开源仓库借用。脑子活一点」）。
//
// 取形来源 = **本仓已经在用的五套开源图标**（src/lib/icons/sets/*.ts，tools/icons/vendor.mjs 生成）：
// Lucide(ISC) / Tabler(MIT) / Phosphor(MIT) / Bootstrap(MIT) / Material(Apache-2.0) ——
// 许可全文已随 src-tauri/resources/ICONS-LICENSE.md 打进 MSI（tauri.conf.json 的 bundle.resources），
// 所以**借它们的形状不需要任何新增许可工作**，也不用往仓库塞二进制素材。
//
// 做法：解析 d 字符串 → 采样折线 → 圆笔刷描边（8× 超采样，≈ stroke-linecap="round" 的质量）
// → 状态徽标（实心点 / 警示三角 / 红环，都留一圈「底色分离环」）→ 降采样到 20 / 16px
// → 贴亮/暗任务栏底色 → PNG（内联 base64）+ WCAG 对比度。
//
// 用法：node tools/visual/round82-tray-v2.mjs
// 产物：docs/visual/round82-托盘候选v2.html · docs/visual/round82-托盘候选v2-接触印样.png（方形总览图）
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  contrast,
  downscaleAlpha,
  fillPolygon,
  hex,
  newMask,
  png,
  resolveAlpha,
  stampDisc,
  strokePaths,
  tintOn,
  TASKBAR,
} from "./lib/tray-raster.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const P = (...p) => path.join(repoRoot, ...p);

const SIZE = 32;
const SS = 8;
const CANVAS = SIZE * SS;
const INSET = 2; // 形状四周留 2px（32px 画布里占 28px）
const K = CANVAS / SIZE; // 画布边长 / 逻辑边长 = 超采样倍率（256/32 = 8）
// ⚠️ 别拿 SS 当画布尺寸：本文件里 SS = **倍率**(8)、CANVAS = 画布边长(256)。今天真踩过这个坑。
const UNIT = ((SIZE - INSET * 2) / 24) * K; // 一个图标单位（viewBox 0–24）= 多少超采样像素
const PAD = INSET * K; // 四周内缩（超采样像素）

/** 从 vendored 图标表里取一个语义名的 d 字符串 */
const SET_SRC = readFileSync(P("src/lib/icons/sets/lucide.ts"), "utf8");
function pathsOf(name) {
  const m = SET_SRC.match(new RegExp(`"${name}":\\s*\\[([\\s\\S]*?)\\],`));
  if (!m) throw new Error(`图标表里没有 ${name}`);
  return [...m[1].matchAll(/\bd:\s*"([^"]+)"/g)].map((x) => x[1]);
}

const CANDIDATES = [
  {
    id: "cal",
    glyph: "calendar-days",
    label: "日历 · calendar-days（Lucide）",
    why: "一周计划的本体；轮廓在 16px 仍认得出来（里面的点阵会糊成小格）",
  },
  { id: "clock", glyph: "clock", label: "时钟 · clock（Lucide）", why: "「时刻 / 提醒」语义；圆形在 16px 最稳" },
  {
    id: "checks",
    glyph: "list-checks",
    label: "清单打勾 · list-checks（Lucide）",
    why: "「任务 + 完成」语义；线条多、16px 略糊（看样张右下角那两枚）",
  },
  { id: "bell", glyph: "bell", label: "铃 · bell（Lucide）", why: "「提醒」语义；轮廓最简单、小尺寸最清楚" },
];

const STATES = [
  ["default", "默认（无进行中）"],
  ["current", "有进行中的任务"],
  ["warn", "高优先级提醒"],
  ["overload", "理智值超载"],
];

/** 深墨画亮任务栏、浅墨画暗任务栏（round82 调研 盘-05；四态色都 ≥3:1，见页面上的数字） */
const INK = {
  light: { base: hex("#4a453d"), accent: hex("#0b6047"), warn: hex("#b33a09"), ring: hex("#b32a1e"), sep: TASKBAR.light },
  dark: { base: hex("#c3bdb2"), accent: hex("#5cd6ac"), warn: hex("#ffa57a"), ring: hex("#ff7a6b"), sep: TASKBAR.dark },
};

/** 画一枚图标 → 若干「层」（每层 = alpha 遮罩 + 颜色；后画的在上） */
function iconLayers(glyph, state, ink) {
  const layers = [];
  const g = newMask(CANVAS);
  const ds = pathsOf(glyph);
  strokePaths(g, CANVAS, ds, { unit: UNIT, pad: PAD, strokeWidth: 2, value: 1 });
  if (process.env.WW_TRAY_DEBUG) {
    const al = resolveAlpha(g, CANVAS, SIZE);
    let n = 0; let mx = 0; for (const v of al) { if (v > 128) n += 1; if (v > mx) mx = v; }
    console.log(`[debug] ${glyph}/${state}: paths=${ds.length} unit=${UNIT} pad=${PAD} 遮罩>128=${n} max=${mx}`);
  }
  layers.push({ alpha: resolveAlpha(g, CANVAS, SIZE), color: state === "current" ? ink.accent : ink.base });

  if (state === "current") {
    const sep = newMask(CANVAS);
    stampDisc(sep, CANVAS, 23.5 * SS, 23.5 * SS, (6.5 + 1.6) * SS, 1);
    const dot = newMask(CANVAS);
    stampDisc(dot, CANVAS, 23.5 * SS, 23.5 * SS, 6.5 * SS, 1);
    layers.push({ alpha: resolveAlpha(sep, CANVAS, SIZE), color: ink.sep });
    layers.push({ alpha: resolveAlpha(dot, CANVAS, SIZE), color: ink.accent });
  } else if (state === "warn") {
    const cx = 23.5 * SS;
    const cy = 23 * SS;
    const r = 8.5 * SS;
    const tri = newMask(CANVAS);
    fillPolygon(tri, CANVAS, [
      [cx, cy - 0.92 * r],
      [cx + 0.86 * r, cy + 0.62 * r],
      [cx - 0.86 * r, cy + 0.62 * r],
    ]);
    const halo = newMask(CANVAS);
    stampDisc(halo, CANVAS, cx, cy, r + 1.6 * SS, 1);
    layers.push({ alpha: resolveAlpha(halo, CANVAS, SIZE), color: ink.sep });
    layers.push({ alpha: resolveAlpha(tri, CANVAS, SIZE), color: ink.warn });
  } else if (state === "overload") {
    // 2026-10-07 你的口径：**别套住整个图标**（很丑）——跟其它徽标一样放右下角，只是**空心**红环
    const cx = 23.5 * SS;
    const cy = 23.5 * SS;
    const rOuter = 8.4 * SS;
    const rInner = 6.2 * SS;
    const halo = newMask(CANVAS);
    stampDisc(halo, CANVAS, cx, cy, rOuter + 1.6 * SS, 1);
    layers.push({ alpha: resolveAlpha(halo, CANVAS, SIZE), color: ink.sep });
    const ringMask = newMask(CANVAS);
    stampDisc(ringMask, CANVAS, cx, cy, rOuter, 1);
    stampDisc(ringMask, CANVAS, cx, cy, rInner, 1, "clear");
    layers.push({ alpha: resolveAlpha(ringMask, CANVAS, SIZE), color: ink.ring });
  }
  return layers;
}

/** 把若干层贴到底色上 → RGBA */
function compose(layers, bg) {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) for (let c = 0; c < 3; c++) out[i * 4 + c] = bg[c];
  for (const l of layers) {
    for (let i = 0; i < SIZE * SIZE; i++) {
      const a = l.alpha[i] / 255;
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) out[i * 4 + c] = l.color[c] * a + out[i * 4 + c] * (1 - a);
    }
  }
  for (let i = 0; i < SIZE * SIZE; i++) out[i * 4 + 3] = 255;
  return out;
}

const uri = (rgba, size) => `data:image/png;base64,${png(rgba, size).toString("base64")}`;

// ---------------------------------------------------------------- 生成数据
const rows = [];
/** 接触印样用：把 32px 的真 RGBA 存一份（不经过 PNG 往返） */
const sheetCells = [];
for (const cand of CANDIDATES) {
  for (const [state, stateLabel] of STATES) {
    const variants = [];
    for (const tb of ["light", "dark"]) {
      const ink = INK[tb];
      const layers = iconLayers(cand.glyph, state, ink);
      const rgba32 = compose(layers, TASKBAR[tb]);
      const core = layers[0].color;
      const a20 = downscaleAlpha(layers[0].alpha, SIZE, 20);
      const a16 = downscaleAlpha(layers[0].alpha, SIZE, 16);
      variants.push({
        tb,
        r32: uri(rgba32, SIZE),
        r20: uri(tintOn(a20, 20, core, TASKBAR[tb]), 20),
        r16: uri(tintOn(a16, 16, core, TASKBAR[tb]), 16),
        contrast: contrast(core, TASKBAR[tb]),
      });
      sheetCells.push({ cand: cand.id, state, tb, rgba32, bg: TASKBAR[tb] });
    }
    rows.push({ cand: cand.id, state, stateLabel, variants });
  }
}

const cell = (v) => {
  const bad = v.contrast < 3;
  return `<figure class="cell">
    <img class="tb ${v.tb}" src="${v.r32}" width="32" height="32" alt="">
    <div class="sizes"><img class="tb ${v.tb}" src="${v.r20}" width="20" height="20" alt=""><img class="tb ${v.tb}" src="${v.r16}" width="16" height="16" alt=""></div>
    <figcaption>${v.tb === "light" ? "亮任务栏" : "暗任务栏"} <span class="cr ${bad ? "bad" : "ok"}">${v.contrast.toFixed(2)}:1</span><br><span class="dim">32 / 20 / 16</span></figcaption>
  </figure>`;
};

const groups = CANDIDATES.map((c) => {
  const set = rows.filter((r) => r.cand === c.id);
  return `<section class="cand">
  <h2>候选 ${c.id} —— ${c.label}</h2>
  <p class="why">${c.why}</p>
  <table class="grid">
    <thead><tr><th>状态</th><th>呈现（真像素 · 贴任务栏底色）</th></tr></thead>
    <tbody>
${set
  .map((r) => `      <tr><th class="st">${r.stateLabel}</th><td class="cells">${r.variants.map(cell).join("")}</td></tr>`)
  .join("\n")}
    </tbody>
  </table>
</section>`;
}).join("");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>round82 · 托盘候选 v2（借开源图标素材 · 真像素）</title>
<style>
  :root { color-scheme: light dark; --fg:#211d18; --bg:#f6f3ef; --card:#fff; --line:#d8d3ca; --dim:#6b6559; --ok:#0e6b52; --bad:#b3261e; }
  @media (prefers-color-scheme: dark) { :root { --fg:#eae7e1; --bg:#1a1917; --card:#242320; --line:#3a3833; --dim:#b5afa5; --ok:#4ec39b; --bad:#ff8a7a; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:22px 26px 70px; background:var(--bg); color:var(--fg); font:13px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif; }
  h1 { font-size:19px; margin:0 0 4px; }
  h2 { font-size:14px; margin:24px 0 2px; }
  .why { margin:0 0 6px; color:var(--dim); font-size:12px; }
  .note { border-left:3px solid var(--ok); background:color-mix(in srgb, var(--ok) 8%, transparent); padding:8px 10px; margin:10px 0; color:var(--dim); font-size:12px; }
  .note b { color:var(--fg); }
  table.grid { width:100%; border-collapse:collapse; }
  table.grid th { text-align:left; font-weight:600; color:var(--dim); font-size:12px; padding:4px 6px; border-bottom:1px solid var(--line); }
  table.grid td { padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:middle; }
  th.st { width:150px; font-weight:400; }
  .cells { display:flex; gap:22px; flex-wrap:wrap; }
  .cell { margin:0; text-align:center; }
  .cell img.tb { display:block; margin:0 auto; border-radius:3px; }
  .cell .sizes { display:flex; gap:6px; align-items:flex-end; justify-content:center; margin-top:4px; }
  .cell figcaption { font-size:11px; color:var(--dim); margin-top:6px; line-height:1.35; }
  .cr { font-variant-numeric:tabular-nums; }
  .cr.ok { color:var(--ok); } .cr.bad { color:var(--bad); font-weight:600; }
  .dim { color:var(--dim); font-size:10px; }
  code { background:color-mix(in srgb, var(--fg) 8%, transparent); padding:0 3px; border-radius:3px; }
</style>
</head>
<body>
<h1>托盘候选 v2 —— 借开源图标素材（真像素 · 16/20/32px · 贴亮暗任务栏）</h1>
<p class="note" style="border-left-color:#b3261e">
  <b>2026-10-07 你已选：候选 C · <code>list-checks</code>（清单打勾）</b>，并要求超载徽标改成<b>右下空心红环</b>（本页已按此重出）。
  本页保留为对照记录；Step 5 按「候选 C + 四态（右下徽标）」落地 Rust 侧。
</p>
<p class="note">
  <b>你的话（2026-10-07）</b>：「全都好抽象好丑……找无版权争议的素材/开源仓库借用。脑子活一点。」
  <b>这次的做法</b>：形状不再自造几何，而是取 <b>本仓已经在用的五套开源图标</b>（<code>src/lib/icons/sets/*.ts</code>；
  Lucide ISC / Tabler MIT / Phosphor MIT / Bootstrap MIT / Material Apache-2.0）里的现成字形 ——
  许可全文已随 <code>src-tauri/resources/ICONS-LICENSE.md</code> 打进 MSI，<b>零新增许可工作，仓库不落二进制素材</b>。
</p>
<p class="note">
  <b>四态怎么表达</b>：默认 = 基形描边（灰）· 有任务 = 基形换成强调色 + 右下实心点 · 提醒 = 右下实心警示三角（带底色分离环）·
  超载 = <b>右下空心红环</b>（2026-10-07 你的口径：原来那种「套住整个图标」的红圈很难看，改成跟其它徽标一样占右下角、只是空心）。
  徽标都留 1.6px「底色分离环」，不然两个形状在 16px 会糊成一团。
</p>
<p class="note">
  <b>怎么读</b>：每格三个尺寸 —— <b>32px</b>（交给系统的位图）· <b>20px</b>（125% DPI）· <b>16px</b>（100% DPI）；
  后两个是 32px 位图按面积降采样（≈ 系统那一步）。数字 = 基形对任务栏底色的 <b>WCAG 对比度</b>（1.4.11 要 ≥3:1）。
  方形总览图（一眼看全套）：<code>docs/visual/round82-托盘候选v2-接触印样.png</code>。
</p>
<p class="note">
  重跑：<code>node tools/visual/round82-tray-v2.mjs</code>。上一版（自造几何，你已否）仍在 <code>round82-托盘候选.html</code>。
</p>
${groups}
</body>
</html>
`;

writeFileSync(P("docs/visual/round82-托盘候选v2.html"), html);
console.log("写出 docs/visual/round82-托盘候选v2.html");

// ---------------------------------------------------------------- 接触印样（512×512 方形总览，png() 只吃方形）
{
  const SHEET = 512;
  const buf = new Uint8ClampedArray(SHEET * SHEET * 4);
  for (let i = 0; i < SHEET * SHEET; i++) {
    buf[i * 4] = 250;
    buf[i * 4 + 1] = 249;
    buf[i * 4 + 2] = 247;
    buf[i * 4 + 3] = 255;
  }
  // 布局：4 候选（列）× 4 态（行）× 2 主题（同格内左右并排）
  const cellW = 120;
  const cellH = 52;
  const x0 = 12;
  const y0 = 12;
  sheetCells.forEach((c) => {
    const col = CANDIDATES.findIndex((x) => x.id === c.cand);
    const row = STATES.findIndex((s) => s[0] === c.state);
    const bx = x0 + col * cellW + (c.tb === "light" ? 0 : 36);
    const by = y0 + row * cellH;
    // 底色块（贴任务栏色）+ 32px 图标
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const px = bx + 2 + x;
        const py = by + 2 + y;
        if (px < 0 || py < 0 || px >= SHEET || py >= SHEET) continue;
        const src = (y * SIZE + x) * 4;
        const i = (py * SHEET + px) * 4;
        buf[i] = c.rgba32[src];
        buf[i + 1] = c.rgba32[src + 1];
        buf[i + 2] = c.rgba32[src + 2];
        buf[i + 3] = 255;
      }
    }
  });
  writeFileSync(P("docs/visual/round82-托盘候选v2-接触印样.png"), png(buf, SHEET));
  console.log("写出 docs/visual/round82-托盘候选v2-接触印样.png（512×512）");
}
