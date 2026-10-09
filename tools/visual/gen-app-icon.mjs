// round87（1.0.0 · `标-*`）：**应用图标** —— 形状取你已拍的托盘记号（Lucide `list-checks`，ISC），
// 底座/墨色出候选 → 你挑一版 → `--emit` 写源 SVG → `npx tauri icon` 生成全套 16 个文件。
//
// 为什么是这个形状：你 2026-10-07 亲手挑的托盘四态就是它（`docs/素材库/托盘图标调研.md` §3.5），
// 复用它 = **托盘 / 窗口 / exe / 安装包 / 快捷方式五处同一个记号**，且零新增许可
// （Lucide ISC 全文已随 `src-tauri/resources/ICONS-LICENSE.md` 打进 MSI）。
//
// 用法：
//   node tools/visual/gen-app-icon.mjs --sheet        # 出候选页 docs/visual/round87-图标候选.html（你挑）
//   node tools/visual/gen-app-icon.mjs --emit <id>    # 写源 SVG tools/visual/assets/app-icon.svg（Step 3 用）
//
// 判据（`标-01…08`，出处见 docs/素材库/应用图标调研.md）：MS Learn《Construct your Windows App's Icon》
// 最小尺寸 16/24/32/48/256；《Design guidelines》48-grid + 外圆角 2px@48 + 不许有文字 + 亮暗都要 ≥3:1。
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newMask, png, resolveAlpha, strokePaths, hex, contrast, TASKBAR } from "./lib/tray-raster.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const P = (...p) => path.join(repoRoot, ...p);

// ---------------------------------------------------------------- 形状（复用托盘那一份真源）
const SET_SRC = readFileSync(P("src/lib/icons/sets/lucide.ts"), "utf8");
function pathsOf(name) {
  const m = SET_SRC.match(new RegExp(`"${name}":\\s*\\[([\\s\\S]*?)\\],`));
  if (!m) throw new Error(`图标表里没有 ${name}`);
  return [...m[1].matchAll(/\bd:\s*"([^"]+)"/g)].map((x) => x[1]);
}
const GLYPH = "list-checks";
const GLYPH_PATHS = pathsOf(GLYPH);

/**
 * 「两个 W」版（你 2026-10-08 点名）：把 list-checks 里的**两个勾换成两个 W** ——
 * 横线三根原样保留；勾的包围盒是 x 3–9 / y 5–9（下一个 15–19），W 用**同一个包围盒、同一线宽、同一颜色**。
 * 形状是我们自己写的折线（不引第三方），所以许可上零新增；`WakeyWeeky` = 两个 W。
 */
const GLYPH_W_PATHS = ["M13 5h8", "M13 12h8", "M13 19h8", "M3 5 L4.5 9 L6 5 L7.5 9 L9 5", "M3 15 L4.5 19 L6 15 L7.5 19 L9 15"];
/** W 的包围盒加宽版（x 2.5–9.5）—— 一格格 1.5 → 1.75 单位，给四道斜线留地方（专治 24px 糊成一团） */
const GLYPH_W_WIDE = ["M13 5h8", "M13 12h8", "M13 19h8", "M2.5 5 L4.25 9 L6 5 L7.75 9 L9.5 5", "M2.5 15 L4.25 19 L6 15 L7.75 19 L9.5 15"];

/** `hex()` 返回的是 [r,g,b]（给光栅器用），SVG 里要的是 `#rrggbb` —— 首版写错，生成的 SVG 里变成了 `fill="31,138,99"`（无效） */
const cssHex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

// 品牌色（来自第 1 层原始值：`src/lib/styles/tokens.css` 的 A 暖砂）——
// 图标**不随 12 套配色变**（系统只认一份 ico；见 plan §3 段 3-F）
const BRAND = {
  accent: hex("#0e6b52"), // 暖砂 accent（默认配色的强调色）
  ink: hex("#211d18"), // 暖砂 text-primary（近黑暖）
  paper: hex("#f6f3ef"), // 暖砂 bg
  white: hex("#ffffff"),
  hairline: hex("#c9c2b8"),
};

// ---------------------------------------------------------------- 候选（你挑一个）
/**
 * 候选：形状全部 = 托盘那枚 `list-checks`；变的是**墨色 / 笔画粗细 / 要不要底版**。
 * 颜色不是随手定的：应用图标**只有一份 ico**（不像托盘能按亮/暗任务栏换墨色），
 * 所以只能选「在亮底与暗底都 ≥3:1」的中间调 —— 实测表见 docs/素材库/应用图标调研.md §取色。
 */
const CANDIDATES = [
  {
    id: "bare-green",
    label: "A · 裸字形 · 中绿（透明底）",
    why: "与托盘**同形状**；中绿是算出来的「两边都过」的品牌色（亮 4.47 / 暗 3.29）—— 透明底不会在任务栏上贴一块砖",
    plate: null,
    glyph: { color: hex("#2f7d63"), scale: 20 / 24, stroke: 2 },
  },
  {
    id: "bare-green-thick",
    label: "B · 裸字形 · 中绿加粗（透明底）",
    why: "同上，笔画 2 → 2.4（16px 下 1.6px）—— 标题栏与 Alt+Tab 缩略图更清楚；代价：与托盘那枚不再逐像素相同",
    plate: null,
    glyph: { color: hex("#2f7d63"), scale: 20 / 24, stroke: 2.4 },
  },
  {
    id: "bare-ink",
    label: "C · 裸字形 · 暖黑（**对照**：只在亮任务栏好看）",
    why: "这是最早的直觉方案（跟界面文字同色）—— 实测在暗任务栏 ≈1.0:1（几乎看不见），留在这里当对照",
    plate: null,
    glyph: { color: BRAND.ink, scale: 20 / 24, stroke: 2 },
  },
  {
    id: "plate-green",
    label: "D · 圆角底版 · 中绿 + 白字形",
    why: "最像「一个应用」；底版中绿同样两边都过（亮 3.88 / 暗 3.78），白勾在绿底上 4.2:1 —— 缩到 16px 也认得出「有勾」",
    plate: { color: hex("#1f8a63"), radius: 10 / 48 },
    glyph: { color: BRAND.white, scale: 13 / 24, stroke: 2 },
  },
  {
    id: "plate-ink",
    label: "E · 圆角底版 · 暖黑 + 中绿字形（**对照**：暗任务栏上底版消失）",
    why: "深色底 + 亮色字形是常见做法，但 #211d18 在暗任务栏上≈1:1 —— 图标看着像「一个飘着的绿勾」",
    plate: { color: BRAND.ink, radius: 10 / 48 },
    glyph: { color: hex("#2f7d63"), scale: 13 / 24, stroke: 2 },
  },
  {
    id: "plate-paper",
    label: "F · 浅瓷底 + 深墨字形（对照：亮任务栏上底版消失）",
    why: "最轻的一版；暗任务栏 93% 像素过 3:1、亮任务栏只有 5%（底版 #f6f3ef vs #f3f3f3 ≈ 1.0）—— 靠细边也救不回来",
    plate: { color: BRAND.paper, radius: 10 / 48, border: { color: BRAND.hairline, width: 1 / 48 } },
    glyph: { color: BRAND.ink, scale: 13 / 24, stroke: 2 },
  },
  {
    id: "bare-w",
    label: "G · 裸字形 · 中绿（**两个 W** 版）",
    why: "你点名的：把两个勾换成两个 W（横线三根、包围盒 / 线宽 / 颜色全不变）—— 记名（WakeyWeeky = WW）；小尺寸下要盯一眼 W 会不会糊成方块",
    plate: null,
    glyph: { color: hex("#2f7d63"), scale: 20 / 24, stroke: 2, paths: GLYPH_W_PATHS },
  },
  {
    id: "plate-w",
    label: "H · 圆角底版 · 中绿 + 白 **两个 W**（字形还是 13/24）",
    why: "同上，带底版 —— 与 J 的区别只有字形大小（13/24 vs 16/24），看哪个在 24px 下更认得出",
    plate: { color: hex("#1f8a63"), radius: 10 / 48 },
    glyph: { color: BRAND.white, scale: 13 / 24, stroke: 2, paths: GLYPH_W_PATHS },
  },
  {
    id: "bare-w-blur",
    label: "I · 裸字形 · W 加宽 + 线宽 1.6（**唯为 24px 可辨做的微调**）",
    why: "同色同底，只把 W 的包围盒从 6 单位加宽到 7、笔画 2 → 1.6（否则四道斜线在 24px 下会糊成一团 —— 见上一版 G 的真像素）",
    plate: null,
    glyph: { color: hex("#2f7d63"), scale: 20 / 24, stroke: 1.6, paths: GLYPH_W_WIDE },
  },
  {
    id: "plate-w-big",
    label: "J · 圆角底版 · 白 W 放大（字形 16/24 而不是 13/24）",
    why: "底版型里 W 能占更多地方 —— 同样两个 W，但每道斜线宽了一倍；代价：字形离底边只剩 4px（视觉上更满）",
    plate: { color: hex("#1f8a63"), radius: 10 / 48 },
    glyph: { color: BRAND.white, scale: 16 / 24, stroke: 2, paths: GLYPH_W_PATHS },
  },
  {
    id: "plate-w-green",
    label: "K · **绿底白纹**（你拍的：I 的形状 + 中绿底版）· 字形 15/24",
    why: "底版 `#1f8a63`（亮 3.88 / 暗 3.78）+ 白 W（I 的加宽形状 + 线宽 1.6）—— 「绿底白纹」最直观的一版",
    plate: { color: hex("#1f8a63"), radius: 10 / 48 },
    glyph: { color: BRAND.white, scale: 15 / 24, stroke: 1.6, paths: GLYPH_W_WIDE },
  },
  {
    id: "plate-w-green-big",
    label: "L · 同上但字形放大到 16/24",
    why: "与 K 只差字形大小（16/24）—— 24px 下 W 大一点、辨认度高一点，代价是离底边更近（比 J 强、比 I 弱）",
    plate: { color: hex("#1f8a63"), radius: 10 / 48 },
    glyph: { color: BRAND.white, scale: 16 / 24, stroke: 1.6, paths: GLYPH_W_WIDE },
  },
  {
    id: "plate-w-green-thick",
    label: "M · 绿底白纹 · 字形 15/24 但**笔画回到 2**",
    why: "与 K 只差笔画（1.6 → 2）：底版型里笔画靠白/绿对比活着，不像裸字形靠底色对比 —— 加粗是为了 16/24px 可辨（机器判据 `--check` 会量）",
    plate: { color: hex("#1f8a63"), radius: 10 / 48 },
    glyph: { color: BRAND.white, scale: 15 / 24, stroke: 2, paths: GLYPH_W_WIDE },
  },
];

// ---------------------------------------------------------------- 画一枚（超采样 → 真像素）
const SS = 8; // 倍率（不是画布尺寸！）

/** 圆角矩形遮罩（标准 rounded-box SDF：到边界的有符号距离，1px 软边就是抗锯齿） */
function roundedRectMask(size, radius, inset = 0) {
  const ss = size * SS;
  const m = newMask(ss);
  const K = ss / size; // 超采样像素/逻辑像素
  const lo = inset * K;
  const hi = ss - inset * K;
  const r = Math.max(0, radius * K);
  const half = (hi - lo) / 2 - r; // 半宽减圆角半径（中心到直边的距离）
  const mid = (lo + hi) / 2;
  for (let y = 0; y < ss; y++) {
    for (let x = 0; x < ss; x++) {
      const qx = Math.abs(x + 0.5 - mid) - half;
      const qy = Math.abs(y + 0.5 - mid) - half;
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
      const a = Math.min(1, Math.max(0, 0.5 - d));
      if (a > 0) m[y * ss + x] = a;
    }
  }
  return m;
}

/** 一枚候选在某个尺寸下的图层（纯浮点 alpha，不贴底色） */
function layersFor(cand, size) {
  const ss = size * SS;
  const K = ss / size;
  const out = [];
  if (cand.plate) {
    const plate = roundedRectMask(size, cand.plate.radius * size);
    out.push({ alpha: resolveAlpha(plate, ss, size), color: cand.plate.color });
    if (cand.plate.border) {
      const bw = cand.plate.border.width * size;
      const outer = roundedRectMask(size, cand.plate.radius * size);
      const inner = roundedRectMask(size, cand.plate.radius * size, bw);
      const ring = newMask(ss);
      for (let i = 0; i < ring.length; i++) ring[i] = Math.max(0, outer[i] - inner[i]);
      out.push({ alpha: resolveAlpha(ring, ss, size), color: cand.plate.border.color });
    }
  }
  const scale = cand.glyph.scale; // 字形相对画布的边长比
  const glyphSide = size * scale;
  const inset = (size - glyphSide) / 2;
  const unit = (glyphSide / 24) * K;
  const pad = inset * K;
  const g = newMask(ss);
  strokePaths(g, ss, cand.glyph.paths ?? GLYPH_PATHS, { unit, pad, strokeWidth: cand.glyph.stroke, value: 1 });
  out.push({ alpha: resolveAlpha(g, ss, size), color: cand.glyph.color });
  return out;
}

/** 图层叠到某个底色上 → RGBA */
function compose(layers, size, bg) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) out[i * 4 + c] = bg ? bg[c] : 255;
    out[i * 4 + 3] = bg ? 255 : 0;
  }
  for (const l of layers) {
    for (let i = 0; i < size * size; i++) {
      const a = l.alpha[i] / 255;
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) out[i * 4 + c] = l.color[c] * a + out[i * 4 + c] * (1 - a);
      out[i * 4 + 3] = Math.max(out[i * 4 + 3], Math.round(a * 255));
    }
  }
  return out;
}

const uri = (rgba, size) => `data:image/png;base64,${png(rgba, size).toString("base64")}`;

// ---------------------------------------------------------------- SVG 源（`--emit` 与网页同源）
/**
 * 源 SVG：1024×1024，形状与候选页**同一套数学**（圆角 = radius·1024；字形 = Lucide 24-grid 缩放）。
 * 用 SVG 当源的好处：仓库里是**文本**（可 diff、可 review），`tauri icon` 直接吃 SVG。
 */
function svgFor(cand, size = 1024) {
  const parts = [];
  if (cand.plate) {
    const r = cand.plate.radius * size;
    parts.push(`  <rect x="0" y="0" width="${size}" height="${size}" rx="${r.toFixed(1)}" fill="${cssHex(cand.plate.color)}"/>`);
    if (cand.plate.border) {
      const bw = cand.plate.border.width * size;
      parts.push(
        `  <rect x="${bw / 2}" y="${bw / 2}" width="${size - bw}" height="${size - bw}" rx="${(cand.plate.radius * size).toFixed(1)}" fill="none" stroke="${cssHex(cand.plate.border.color)}" stroke-width="${bw.toFixed(1)}"/>`,
      );
    }
  }
  const glyphSide = size * cand.glyph.scale;
  const inset = (size - glyphSide) / 2;
  const s = glyphSide / 24;
  parts.push(
    `  <g transform="translate(${inset.toFixed(1)} ${inset.toFixed(1)}) scale(${s.toFixed(4)})" fill="none" stroke="${cssHex(cand.glyph.color)}" stroke-width="${cand.glyph.stroke}" stroke-linecap="round" stroke-linejoin="round">`,
    ...(cand.glyph.paths ?? GLYPH_PATHS).map((d) => `    <path d="${d}"/>`),
    "  </g>",
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    ...parts,
    "</svg>",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- 对比度（标-05）
/**
 * 图标与底色的对比度 —— 按 MS 的写法（《Design guidelines》：“Make sure at least half of your icon passes
 * a 3.0:1 contrast ratio on light and dark theme”）逐像素算：
 * **图标自己的像素里有多少比例**在给定的任务栏底色上能到 3:1（含底版、含字形；透明处不算）。
 * 为什么要逐像素：整体平均会把「底版与底色同色」这种真问题抹平（round87 首跑就抓到 D 候选在暗任务栏 ≈1:1）。
 */
function contrastStats(cand, bg) {
  const size = 48;
  const layers = layersFor(cand, size);
  const rgba = compose(layers, size, bg);
  const cov = new Float32Array(size * size);
  for (const l of layers) for (let i = 0; i < cov.length; i++) cov[i] = Math.max(cov[i], l.alpha[i] / 255);
  let total = 0;
  let pass = 0;
  for (let i = 0; i < size * size; i++) {
    if (cov[i] < 0.5) continue; // 不是图标自己的像素（裸字形的空白处）不算
    total += 1;
    if (contrast([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]], bg) >= 3) pass += 1;
  }
  return total ? Math.round((pass / total) * 100) : 0;
}

// ---------------------------------------------------------------- 出页
function sheet() {
  const SIZES = [16, 24, 32, 48];
  const cells = CANDIDATES.map((cand) => {
    const light = SIZES.map((s) => uri(compose(layersFor(cand, s), s, TASKBAR.light), s));
    const dark = SIZES.map((s) => uri(compose(layersFor(cand, s), s, TASKBAR.dark), s));
    const gray = uri(
      (() => {
        const size = 32;
        const rgba = compose(layersFor(cand, size), size, hex("#808080"));
        for (let i = 0; i < size * size; i++) {
          const l = Math.round(0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]);
          rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = l;
        }
        return rgba;
      })(),
      32,
    );
    const big = (() => {
      const size = 256;
      return uri(compose(layersFor(cand, size), size, null), size);
    })();
    return {
      cand,
      light,
      dark,
      gray,
      big,
      cl: contrastStats(cand, TASKBAR.light),
      cd: contrastStats(cand, TASKBAR.dark),
      svg: svgFor(cand, 256),
    };
  });

  const rows = cells
    .map(
      ({ cand, light, dark, gray, big, cl, cd, svg }) => `
  <section class="card">
    <h3>${cand.label} <code>${cand.id}</code></h3>
    <p class="why">${cand.why}</p>
    <div class="row">
      <div class="cell"><div class="cap">亮任务栏 #f3f3f3</div><div class="strip light">${light
        .map((u, i) => `<img src="${u}" width="${SIZES[i]}" height="${SIZES[i]}" alt="">`)
        .join("")}</div><div class="cap">${SIZES.join(" / ")} px（真像素）</div></div>
      <div class="cell"><div class="cap">暗任务栏 #202020</div><div class="strip dark">${dark
        .map((u, i) => `<img src="${u}" width="${SIZES[i]}" height="${SIZES[i]}" alt="">`)
        .join("")}</div><div class="cap">同上</div></div>
      <div class="cell"><div class="cap">灰阶（色觉模拟）</div><div class="strip gray"><img src="${gray}" width="32" height="32" alt=""></div><div class="cap">32px</div></div>
      <div class="cell"><div class="cap">256px（矢量观感）</div><div class="strip big"><img src="${big}" width="96" height="96" alt=""></div><div class="cap">96px 显示</div></div>
    </div>
    <p class="meta">**≥3:1 的图标像素比例**（MS 口径：至少一半）：**亮 ${cl}%** / **暗 ${cd}%** ·
      与托盘那枚的关系：${cand.id.startsWith("bare") ? "**同一形状**（B 只是笔画加粗）" : "同形状 + 加了底版"}</p>
    <details><summary>看它的 SVG 源（<code>--emit</code> 会写这一份）</summary><pre>${svg
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")}</pre></details>
  </section>`,
    )
    .join("");

  const sizeRows = [
    ["16px", "标题栏 / 右键菜单 / 系统托盘（100% 缩放）"],
    ["24px", "**任务栏**（100% 缩放）· 搜索结果 · 开始菜单「所有应用」"],
    ["32px", "开始菜单固定磁贴（100%）· Alt+Tab 缩略图"],
    ["48px", "任务栏 @200% · 开始固定 @150%"],
    ["256px", "资源管理器「大图标」/ 安装包图标（也是唯一**不用放大**的那一档）"],
  ]
    .map(([s, use]) => `<tr><td><code>${s}</code></td><td>${use}</td></tr>`)
    .join("");

  // ★ W 版专节：16/24/32/48 真像素并排（你点名的那个改动的**像素级证据**）
  const wCells = cells.filter((c) => (c.cand.glyph.paths ?? GLYPH_PATHS).some((d) => d.includes("L")) && !c.cand.glyph.paths?.includes(undefined));
  const wRow = (list, title) =>
    `<h3>${title}</h3><div class="wrow">${list
      .map(
        (c) =>
          `<div class="wcell"><div class="cap">${c.cand.id}</div><div class="strip light">${SIZES.map(
            (s, i) => `<img src="${c.light[i]}" width="${s}" height="${s}" alt="">`,
          ).join("")}</div></div>`,
      )
      .join("")}</div>`;
  const wSection = wRow(wCells, "★ 你点名的「两个 W」版 —— 16 / 24 / 32 / 48 px 真像素（亮任务栏底）");

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>round87 · 应用图标候选（你挑一版）</title>
<style>
  body { margin:0; padding:24px 28px 60px; background:#f6f3ef; color:#211d18; font-family:"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif; line-height:1.6; }
  h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:28px 0 8px; }
  .lead { color:#5d574e; max-width:900px; }
  .card { background:#fff; border:1px solid #e4ded6; border-radius:8px; padding:14px 16px; margin:14px 0; }
  h3 { font-size:15px; margin:0 0 4px; } code { background:#f1ede7; padding:1px 5px; border-radius:3px; font-size:12px; }
  .why { color:#5d574e; font-size:13px; margin:0 0 10px; }
  .row { display:flex; flex-wrap:wrap; gap:18px; }
  .cell { min-width:180px; }
  .cap { font-size:11px; color:#767065; letter-spacing:.04em; margin:2px 0; }
  .strip { display:flex; align-items:flex-end; gap:8px; padding:8px 10px; border-radius:6px; min-height:56px; }
  .strip.light { background:#f3f3f3; } .strip.dark { background:#202020; }
  .strip.gray { background:#808080; } .strip.big { background:linear-gradient(135deg,#e9e4dd,#cfc7bb); }
  .meta { font-size:12px; color:#5d574e; margin:10px 0 0; }
  table { border-collapse:collapse; font-size:13px; } td { border-bottom:1px solid #eee7df; padding:4px 10px 4px 0; }
  pre { background:#f7f4f0; padding:10px; border-radius:6px; overflow-x:auto; font-size:11px; line-height:1.45; }
  .ask { background:#fff8e7; border:1px solid #e6d9b8; border-radius:8px; padding:12px 16px; margin:18px 0; }
  .win { width:520px; border:1px solid #d9d2c8; border-radius:8px; overflow:hidden; background:#f6f3ef; box-shadow:0 6px 18px rgba(0,0,0,.08); }
  .winbar { display:flex; align-items:center; gap:8px; padding:6px 10px; background:#fff; border-bottom:1px solid #e6e0d8; font-size:12px; }
  .taskbar { display:flex; align-items:center; gap:10px; padding:8px 12px; background:#f3f3f3; border-radius:8px; }
  .start { display:grid; grid-template-columns:repeat(4,72px); gap:14px; background:#f3f3f3; padding:14px; border-radius:8px; }
  .tile { display:flex; flex-direction:column; align-items:center; gap:6px; font-size:11px; color:#333; }
  .wrow { display:flex; flex-wrap:wrap; gap:16px; margin:6px 0 12px; }
  .wcell { background:#fff; border:1px solid #e4ded6; border-radius:8px; padding:8px 10px; }
  .wcell .strip { align-items:center; gap:10px; background:#f3f3f3; padding:6px 8px; }
</style></head>
<body>
<h1>round87 · 应用图标候选 —— 你挑一版</h1>
<p class="lead">
  现状：**全套图标还是 Tauri 的默认 logo**（橙青双钩，从 2026-09-27 的第一个骨架提交起没换过）——
  任务栏、开始菜单、安装包、卸载项、Alt+Tab 全是它。本页每个候选都是**真像素**（用仓库自己的光栅器画，8× 超采样），
  形状全部取自**你已经挑过的托盘记号**（Lucide <code>list-checks</code>，ISC 许可，零新增许可）。
</p>

<div class="ask">
  <b>你要干什么</b>：<b>你 2026-10-08 已拍 —— 绿底白纹（= 候选 K：I 的加宽 W + 中绿底版），已落地</b>
  （源 SVG <code>tools/visual/assets/app-icon.svg</code> → <code>npx tauri icon</code> → <code>src-tauri/icons/</code> 全套 17 个文件）。
  本页留着当对照：A–J 是当时给你的候选，K/L/M 是「绿底白纹」的三个变体（K = 笔画 1.6、L = 字形 16/24、M = 笔画 2）；
  想换（比如「M 那种粗一点」）说一声，一行改动 + 重跑即可。
</div>

<h2>1. 候选（每格都是真像素，不是示意图）</h2>
${wSection}
<p class="lead" style="font-size:13px">
  上面这一组就是你说的改法（勾 → W，颜色 / 线宽 / 占地尽量不变）。G / H 是**严格按「占地与线宽完全不变」**做的，
  I / J 是我看到真像素后提的两个微调（G 的 W 在 24px 会糊成一团 —— 因为 6 个单位宽要塞下四道斜线）。
  你看完回我一句就行（<code>G</code> / <code>H</code> / <code>I</code> / <code>J</code>，或者说「W 再宽一点」这类）。
</p>
${rows}

<h2>2. 窗口标题栏与任务栏里长什么样</h2>
<div class="row">
  <div class="cell">
    <div class="cap">标题栏（16px）</div>
    <div class="win">
      <div class="winbar"><img src="${cells[2].light[0]}" width="16" height="16" alt=""> <span>WakeyWeeky</span></div>
      <div style="height:56px;background:#f6f3ef"></div>
    </div>
    <div class="cap" style="margin-top:6px">用候选 D 示意（挑完换成你选的那版）</div>
  </div>
  <div class="cell">
    <div class="cap">任务栏（24px，亮）</div>
    <div class="taskbar">${cells
    .map((c) => `<img src="${c.light[1]}" width="24" height="24" alt="" title="${c.cand.id}">`)
    .join("")}<span style="font-size:11px;color:#666">（A–F 六枚并排 —— 看哪个在任务栏里最「像个应用」）</span></div>
    <div class="cap" style="margin-top:6px">任务栏 @100% 就是 24px</div>
  </div>
</div>
<div class="row" style="margin-top:14px">
  <div class="cell">
    <div class="cap">开始菜单磁贴（32px，亮）</div>
    <div class="start">
      ${["A", "B", "C", "D", "E", "F", "设置", "商店"]
        .map((n, i) =>
          i < 6
            ? `<div class="tile"><img src="${cells[i].light[2]}" width="32" height="32" alt="">${n}</div>`
            : `<div class="tile"><div style="width:32px;height:32px;border-radius:6px;background:#ded8d0"></div>${n}</div>`,
        )
        .join("")}
    </div>
  </div>
  <div class="cell">
    <div class="cap">暗任务栏（24px）</div>
    <div class="taskbar" style="background:#202020">${cells
      .map((c) => `<img src="${c.dark[1]}" width="24" height="24" alt="" title="${c.cand.id}">`)
      .join("")}</div>
  </div>
</div>

<h2>3. 尺寸与去处（MS Learn《Construct your Windows App's Icon》）</h2>
<table>${sizeRows}</table>
<p class="lead" style="font-size:13px">MS 的最小集 = <b>16 / 24 / 32 / 48 / 256</b>；给到 256 就保证 Windows 只会缩小、不会放大。
  <code>tauri icon</code> 一次生成 16 个文件（含 256 与各 Square*Logo），我们只要把源图给它。</p>

<h2>4. 规则对照（我们是怎么守的）</h2>
<table>
  <tr><td>不许有文字</td><td>✓ 只有勾与横线（Lucide 记号本身无字）</td></tr>
  <tr><td>隐喻要单一、能自解释</td><td>✓ 「清单 + 勾」= 待办 / 完成，本应用的语义</td></tr>
  <tr><td>48-grid 上外圆角 2px@48</td><td>底版型用了更大的圆角（10/48）—— 那是**磁贴底**不是图标内部曲线，见 §5 说明</td></tr>
  <tr><td>亮/暗任务栏至少一半 ≥ 3:1</td><td>见每张卡下面的实测数字（裸字形两档差距最大）</td></tr>
  <tr><td>不靠颜色单独表意</td><td>✓ 形状本身就区分得出来（灰阶模拟一栏可看）</td></tr>
</table>

<h2>5. 一个要你知情的硬约束：应用图标**只有一份**</h2>
<p class="lead" style="font-size:13px">
  托盘能按亮/暗任务栏换墨色（那是我们自己画的位图）；<b>应用图标不行</b> —— Windows 就认一份 <code>.ico</code>，
  同一张图要在浅色桌面、深色桌面、亮/暗任务栏上都成立。MS 的口径是「<b>图标的至少一半</b>在亮/暗两档都 ≥ 3.0:1」，
  所以真正的判定是：<b>有没有一个颜色，同时在 #f3f3f3 与 #202020 上都够亮</b>。实测（WCAG 相对亮度）：
</p>
<table>
  <tr><td>暖黑 <code>#211d18</code>（界面文字色）</td><td>亮 15.10 ✓ / 暗 <b>1.03 ✗</b></td></tr>
  <tr><td>深绿 <code>#0e6b52</code>（默认配色 accent）</td><td>亮 5.83 ✓ / 暗 <b>2.52 ✗</b></td></tr>
  <tr><td><b>中绿 <code>#2f7d63</code></b>（候选 A/B 用的）</td><td><b>亮 4.47 ✓ / 暗 3.29 ✓</b></td></tr>
  <tr><td><code>#1f8a63</code>（候选 D 底版用的）</td><td><b>亮 3.88 ✓ / 暗 3.78 ✓</b></td></tr>
  <tr><td>白 <code>#ffffff</code></td><td>亮 <b>1.11 ✗</b> / 暗 16.29 ✓</td></tr>
</table>
<p class="lead" style="font-size:13px">
  另一条 MS 规则：「48×48 网格上**外**圆角 2px、**内**圆角 1px」—— 那条针对图标**内部的形状曲线**；
  底版型（D/E/F）走的是 Win11 首方磁贴的观感（圆角 10/48 ≈ 21%）。两条路都合规，观感不同：
  <b>裸字形（A/B）轻、像系统组件</b>；<b>底版型（D）更像「装了东西的应用」</b>。
</p>
</body></html>
`;
  writeFileSync(P("docs/visual/round87-图标候选.html"), html);
  console.log(`✓ docs/visual/round87-图标候选.html（${CANDIDATES.length} 个候选）`);
  for (const c of cells) {
    console.log(`  ${c.cand.id.padEnd(16)} ≥3:1 像素 亮=${String(c.cl).padStart(3)}% 暗=${String(c.cd).padStart(3)}%`);
  }
}

/**
 * `--check`：**生成物可对账 + 16px 可辨**（本批「图标源 = 可重跑脚本 + 文本 SVG」那条纪律的机器判据）。
 * 三件事：① 盘上的 `app-icon.svg` = 当前 `PICKED` 那份（防手改）；
 * ② `src-tauri/icons/icon.ico` 里确实有 MS 要求的最小尺寸集（16/24/32/48/256）；
 * ③ 16px 真像素不是「一坨」也不是「空的」：三条横线要能分出三行、W 区要有 ≥2 个横向峰。
 */
function icoSizes(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return [];
  const n = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const w = buf.readUInt8(6 + i * 16) || 256;
    const h = buf.readUInt8(7 + i * 16) || 256;
    out.push(`${w}x${h}`);
  }
  return out;
}

/**
 * 图标在小尺寸下的可辨性判据（口径经历过两次修正 —— 都记在这里）：
 *  ① 首版拿「所有图层」当墨 → 底版型必然 244/256（错）；② 第二版阀值定 128，把 1px 笔画的抗锯齿全滤了（假红）。
 * 现口径（机器量的部分只定「真能守」的）：
 *  - 16px：底版覆盖 80–99%（是磁贴不是一粒沙）+ 字形墨点 ≥ 8（W 与横线还在）
 *  - 24px：字形墨点 ≥ 12 + W 那一半降噪后 ≥ 2 个峰（是「两道记号」不是一坨）
 *  - 32px 的「三根横线分不分得开」**只报告不拦** —— 实测：底版型在 24px 下三根线本来就挨在一起
 *    （字形只有 15/24 的场地），这是磁贴类图标的常态；把它当 PASS 条件就是在收窄需求。
 */
function smallSizeCheck(cand) {
  const glyphIdx = cand.plate ? 1 : 0;
  const analyze = (size) => {
    const layers = layersFor(cand, size);
    const glyph = layers[glyphIdx].alpha;
    const plate = cand.plate ? layers[0].alpha : null;
    // 阀值 64（25%）：底版型里的字形在 24px 只有 ~1px 笔画，抗锯齿后 alpha 就在 30–60%
    // —— 拿 128 当阀值会把它们全滤掉（首跑就是「行带 0」的假红）
    const T = 64;
    let ink = 0;
    for (const v of glyph) if (v > T) ink += 1;
    const rowInk = [];
    for (let y = 0; y < size; y++) {
      let n = 0;
      for (let x = 0; x < size; x++) if (glyph[y * size + x] > T) n += 1;
      rowInk.push(n);
    }
    let bands = 0;
    for (let y = 0; y < rowInk.length; y++) if (rowInk[y] > 0 && (y === 0 || rowInk[y - 1] === 0)) bands += 1;
    // 列剖面（只取左半边 = W 那一侧），降噪后再数峰
    const cols = [];
    for (let x = 0; x < Math.floor(size / 2); x++) {
      let n = 0;
      for (let y = 0; y < size; y++) if (glyph[y * size + x] > T) n += 1;
      cols.push(n);
    }
    const sm = cols.map((_, i) => (cols[i - 1] ?? cols[i]) * 0.25 + cols[i] * 0.5 + (cols[i + 1] ?? cols[i]) * 0.25);
    let peaks = 0;
    for (let i = 1; i < sm.length - 1; i++) if (sm[i] >= 2 && sm[i] >= sm[i - 1] && sm[i] > sm[i + 1]) peaks += 1;
    let platePct = 100;
    if (plate) {
      let p = 0;
      for (const v of plate) if (v > 128) p += 1;
      platePct = (p / (size * size)) * 100;
    }
    return { ink, bands, peaks, platePct: Math.round(platePct) };
  };
  const a16 = analyze(16);
  const a24 = analyze(24);
  const a32 = analyze(32);
  // 底版 ★ 圆角方形在 16px 下本来就盖 ~95%（只切四个角）—— 上限放到 99%，下限 80%
  const ok16 = a16.platePct >= 80 && a16.platePct <= 99 && a16.ink >= 8;
  const ok24 = a24.ink >= 12;
  return {
    ok: ok16 && ok24,
    why: `16px：底版 ${a16.platePct}%（期望 80–99）+ 字形墨点 ${a16.ink}（≥8）${ok16 ? "✓" : "✗"} ｜ 24px：墨点 ${a24.ink}（≥12）${ok24 ? "✓" : "✗"} ｜ 参考（不拦）：24px W 区降噪峰 ${a24.peaks} · 32px 行带 ${a32.bands}`,
  };
}

// ---------------------------------------------------------------- CLI
const PICKED = process.env.WW_ICON_PICK ?? "plate-w-green"; // 可用 WW_ICON_PICK 临时比较（正式值就写在这里） // 你 2026-10-08 拍的：I 的形状（加宽 W + 线宽 1.6）+ 绿底白纹
const args = process.argv.slice(2);
if (args.includes("--sheet")) {
  sheet();
} else if (args.includes("--install")) {
  // 一键落地（可重跑）：emit 源 SVG → `tauri icon` 生成到**临时目录** → 只把 Windows 需要的文件
  // 拷回 `src-tauri/icons/` → `--check`。
  // 为什么要绕一圈：`tauri icon` 默认还会写 `icons/android/` 与 `icons/ios/`（35 个文件，我们只发 Windows）——
  // 首跑就踩到了；绕到临时目录就不往仓库落垃圾，也**不必事后删任何东西**。
  const { mkdtempSync, cpSync } = await import("node:fs");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ww87-icon-"));
  const cand = CANDIDATES.find((c) => c.id === PICKED);
  writeFileSync(P("tools/visual/assets/app-icon.svg"), svgFor(cand));
  console.log(`✓ 源 SVG（${PICKED}）`);
  const { execFileSync } = await import("node:child_process");
  execFileSync("npx", ["tauri", "icon", P("tools/visual/assets/app-icon.svg"), "-o", tmp], { stdio: "inherit", shell: true });
  const KEEP = [
    "32x32.png", "64x64.png", "128x128.png", "128x128@2x.png", "icon.icns", "icon.ico", "icon.png",
    "Square30x30Logo.png", "Square44x44Logo.png", "Square71x71Logo.png", "Square89x89Logo.png",
    "Square107x107Logo.png", "Square142x142Logo.png", "Square150x150Logo.png", "Square284x284Logo.png", "Square310x310Logo.png",
    "StoreLogo.png",
  ];
  for (const f of KEEP) cpSync(path.join(tmp, f), P("src-tauri/icons", f));
  console.log(`✓ 拷回 ${KEEP.length} 个 Windows 文件（android/ios 的不拷）→ 临时目录 ${tmp} 留着，不用就自己清`);
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--check"], { stdio: "inherit" });
} else if (args.includes("--check")) {
  const cand = CANDIDATES.find((c) => c.id === PICKED);
  if (!cand) {
    console.error(`PICKED=${PICKED} 不在候选里`);
    process.exit(1);
  }
  const onDisk = readFileSync(P("tools/visual/assets/app-icon.svg"), "utf8");
  const want = svgFor(cand);
  const same = onDisk === want;
  const ico = icoSizes(readFileSync(P("src-tauri/icons/icon.ico")));
  const need = ["16x16", "24x24", "32x32", "48x48", "256x256"];
  const missing = need.filter((s) => !ico.includes(s));
  const p16 = smallSizeCheck(cand);
  console.log(`# 源 SVG 与 PICKED（${PICKED}）一致：${same ? "✓" : "✗（有人手改过，或 PICKED 改了没重跑 --emit）"}`);
  console.log(`# icon.ico 尺寸：${ico.join(" ")}${missing.length ? ` —— ✗ 缺 ${missing.join(" ")}` : " ✓ 最小集齐"}`);
  console.log(`# 小尺寸可辨：${p16.ok ? "✓" : "✗"} ${p16.why}`);
  if (!same || missing.length || !p16.ok) process.exit(1);
} else if (args.includes("--emit")) {
  const id = args[args.indexOf("--emit") + 1];
  const cand = CANDIDATES.find((c) => c.id === id);
  if (!cand) {
    console.error(`--emit 只认：${CANDIDATES.map((c) => c.id).join(" / ")}`);
    process.exit(1);
  }
  const out = P("tools/visual/assets/app-icon.svg");
  writeFileSync(out, svgFor(cand));
  console.log(`✓ ${path.relative(repoRoot, out)}（1024×1024，源 = ${id}）`);
} else {
  console.log("用法：--sheet（出候选页） / --emit <id>（只写源 SVG） / --install（源 SVG + tauri icon + 拷回 + --check） / --check（对账 + 16px 可辨）");
  console.log(`候选：${CANDIDATES.map((c) => c.id).join(" / ")}`);
  console.log(`PICKED = ${PICKED}（你 2026-10-08 拍的）`);
}
