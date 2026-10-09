// round82（3.1c₂ · `盘-*`）：**托盘图标候选 × 真像素样张**（可重跑）。
//
// 为什么是脚本而不是手写 HTML（照 `build-3.1-pages.mjs` 的规矩）：
//   托盘的画质问题是**栅格问题**——16px 下糊不糊、亮任务栏看不看得见，只有把候选按
//   与 `src-tauri/src/tray/icons.rs` 同一套「代码绘制」画出来、再按系统的方式缩放，数字才可信。
//   手写 SVG 会「怎么放都清晰」，正好绕过我们要考的那件事。
//
// 做法：
//   ① 4× 超采样画 32×32（与 Rust 侧同一套几何 + 抗锯齿）；
//   ② 按系统缩放路径降采样到 20px（125% DPI）/ 16px（100% DPI）；
//   ③ 贴 Windows 默认亮 / 暗任务栏底色（#F3F3F3 / #202020）出 PNG（内联 base64，不落二进制文件）；
//   ④ 每个候选 × 每态算 WCAG 1.4.11（≥3:1）与 1.4.3 的对比度，不合格的当场标红。
//
// 用法：node tools/visual/round82-tray-sample.mjs
// 产物：docs/visual/round82-托盘候选.html（单文件、离线、可重跑）
import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const P = (...p) => path.join(repoRoot, ...p);

const SIZE = 32; // 与 icons.rs 一致
const SS = 4; // 超采样
const CANVAS = SIZE * SS;

// ---------------------------------------------------------------- 画布（RGBA 0–255）
const blank = () => new Uint8ClampedArray(CANVAS * CANVAS * 4);
const put = (buf, x, y, rgb, a = 1) => {
  if (x < 0 || y < 0 || x >= CANVAS || y >= CANVAS) return;
  const i = (y * CANVAS + x) * 4;
  const src = a < 0 ? 0 : a;
  if (src <= 0) return;
  const dstA = buf[i + 3] / 255;
  const outA = src + dstA * (1 - src);
  for (let c = 0; c < 3; c++) buf[i + c] = (rgb[c] * src + buf[i + c] * dstA * (1 - src)) / (outA || 1);
  buf[i + 3] = outA * 255;
};

/** 圆角矩形的覆盖率（0/1）—— 距离场，供超采样点判定 */
const inRoundRect = (x, y, cx, cy, w, h, r) => {
  const dx = Math.abs(x - cx) - (w / 2 - r);
  const dy = Math.abs(y - cy) - (h / 2 - r);
  if (dx <= 0 && dy <= 0) return true;
  const qx = Math.max(dx, 0);
  const qy = Math.max(dy, 0);
  return qx * qx + qy * qy <= r * r;
};
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const inRing = (x, y, cx, cy, rIn, rOut) => {
  const d2 = (x - cx) ** 2 + (y - cy) ** 2;
  return d2 >= rIn * rIn && d2 <= rOut * rOut;
};
const inTriangle = (x, y, top, bottom, halfW) => {
  const t = (y - top) / (bottom - top);
  if (t < 0 || t > 1) return false;
  return Math.abs(x - (SIZE / 2)) <= halfW * t;
};

// ---------------------------------------------------------------- 候选几何（都在 32 单位坐标系里）
/**
 * 三候选 + 「现状」= 四份**绘制函数**。返回 `[rgb, alpha] | null`（32 单位空间，未超采样）。
 * 颜色按「一套色」传入 —— 亮/暗任务栏各一套（推荐案）或固定一套（现状）。
 */
const CANDS = {
  /** 现状：菱形描边 / 菱形实心 / 三角 / 菱形+红环（icons.rs 的几何，硬边界无锯齿） */
  now: {
    label: "现状（icons.rs 原样）",
    hardEdges: true,
    draw(state, col) {
      const cx = SIZE / 2, cy = SIZE / 2;
      const dia = (x, y, rIn, rOut) => {
        const d = Math.abs(x - cx + 0.5) + Math.abs(y - cy + 0.5);
        return d <= rOut && d > rIn;
      };
      return (x, y) => {
        if (state === "overload") {
          const d = Math.abs(x - cx) + Math.abs(y - cy);
          if (d <= 13.5) return [col.accent, 1];
          if (d > 14.2 && d <= 15.4) return [col.ring, 1];
          return null;
        }
        if (state === "warn") return inTriangle(x, y, 6, 26, 12) ? [col.warn, 1] : null;
        if (state === "current") return Math.abs(x - cx) + Math.abs(y - cy) <= 13.5 ? [col.accent, 1] : null;
        return dia(x, y, 10.5, 13.5) ? [col.muted, 1] : null;
      };
    },
  },
  /** 候选 A：几何抽象改良 —— 圆角方块 + 抗锯齿 + 四态靠「描边 / 实心 / 警示角标 / 红环」 */
  A: {
    label: "A · 几何抽象改良（圆角方块 + 抗锯齿）",
    draw(state, col) {
      return (x, y) => {
        const r = 6;
        const w = state === "warn" ? 22 : 24;
        const h = state === "warn" ? 17 : 24;
        const cy = state === "warn" ? 15 : 16;
        if (state === "overload") {
          if (inRing(x, y, 16, 16, 13.4, 15.4)) return [col.ring, 1];
          return inRoundRect(x, y, 16, 16, 22, 22, 5) ? [col.accent, 1] : null;
        }
        if (state === "warn") return inRoundRect(x, y, 16, cy, w, h, 3) ? [col.warn, 1] : null;
        if (state === "current") return inRoundRect(x, y, 16, 16, 24, 24, r) ? [col.accent, 1] : null;
        // 默认：描边（外 24、内 19 → 2.5px 边）
        if (!inRoundRect(x, y, 16, 16, 24, 24, r)) return null;
        return inRoundRect(x, y, 16, 16, 19, 19, r - 2.5) ? null : [col.muted, 1];
      };
    },
  },
  /** 候选 B：日历轮廓（顶栏 + 两行日期点）+ 状态徽标 */
  B: {
    label: "B · 日历轮廓 + 状态徽标",
    draw(state, col) {
      return (x, y) => {
        const body = (x, y) => inRoundRect(x, y, 16, 17, 24, 22, 4);
        const inner = (x, y) => inRoundRect(x, y, 16, 17, 21, 19, 3);
        const topBand = (x, y) => y >= 6 && y <= 10 && inRoundRect(x, y, 16, 17, 24, 22, 4);
        // 两枚日期点（16px 下会糊成一格 —— 这正是要看的）
        const dots = (x, y) => inCircle(x, y, 11.5, 17.5, 2.2) || inCircle(x, y, 20.5, 17.5, 2.2);
        if (state === "overload") {
          if (inRing(x, y, 16, 16, 13.6, 15.6)) return [col.ring, 1];
          if (body(x, y) && !inner(x, y)) return [col.muted, 1];
          if (topBand(x, y)) return [col.accent, 1];
          if (dots(x, y)) return [col.muted, 1];
          return null;
        }
        if (state === "warn") {
          if (topBand(x, y)) return [col.muted, 1];
          if (body(x, y) && !inner(x, y)) return [col.muted, 1];
          if (dots(x, y)) return [col.muted, 1];
          if (inCircle(x, y, 23, 24, 6.5)) return [col.warn, 1];
          if (inCircle(x, y, 23, 24, 4.6)) return [col.bg, 1]; // 角标留一圈底色做分离
          return null;
        }
        if (state === "current") {
          if (topBand(x, y)) return [col.accent, 1];
          if (body(x, y) && !inner(x, y)) return [col.muted, 1];
          if (inCircle(x, y, 16, 18.5, 5.5)) return [col.accent, 1];
          return null;
        }
        if (body(x, y) && !inner(x, y)) return [col.muted, 1];
        if (topBand(x, y)) return [col.muted, 1];
        if (dots(x, y)) return [col.muted, 1];
        return null;
      };
    },
  },
  /** 候选 C：中性方块 + 状态色点（色点扛全部状态语义） */
  C: {
    label: "C · 方块 + 状态色点",
    draw(state, col) {
      return (x, y) => {
        const sq = (x, y) => inRoundRect(x, y, 15, 15, 22, 22, 5);
        if (state === "overload") {
          if (inRing(x, y, 16, 16, 13.6, 15.5)) return [col.ring, 1];
          if (sq(x, y)) return [col.ink, 1];
          if (inCircle(x, y, 22.5, 22.5, 6.5)) return [col.ring, 1];
          return null;
        }
        if (state === "warn") {
          if (sq(x, y)) return [col.ink, 1];
          if (inCircle(x, y, 22.5, 22.5, 6.5)) return [col.warn, 1];
          return null;
        }
        if (state === "current") {
          if (sq(x, y)) return [col.ink, 1];
          if (inCircle(x, y, 22.5, 22.5, 6.5)) return [col.accent, 1];
          return null;
        }
        if (!inRoundRect(x, y, 15, 15, 22, 22, 5)) return null;
        return inRoundRect(x, y, 15, 15, 17, 17, 3.5) ? null : [col.muted, 1];
      };
    },
  },
};

const STATES = [
  ["default", "默认（无进行中）"],
  ["current", "有进行中的任务"],
  ["warn", "高优先级提醒"],
  ["overload", "理智值超载"],
];

// ---------------------------------------------------------------- 配色
const TASKBAR = { light: [0xf3, 0xf3, 0xf3], dark: [0x20, 0x20, 0x20] };
/** 现状那套固定色（icons.rs 的字面量） */
const FIXED = { accent: [0x00, 0xd9, 0xa3], warn: [0xff, 0x6b, 0x4a], muted: [0x9c, 0xa3, 0xaf], ring: [0xff, 0x4a, 0x4a], ink: [0x9c, 0xa3, 0xaf], bg: [0x20, 0x20, 0x20] };
/** 推荐：按任务栏（系统）主题两套 —— 深色墨色画在亮任务栏、浅色墨色画在暗任务栏 */
const BY_THEME = {
  light: { accent: [0x0b, 0x60, 0x47], warn: [0xb3, 0x3a, 0x09], muted: [0x4a, 0x45, 0x3d], ring: [0xb3, 0x2a, 0x1e], ink: [0x3d, 0x3a, 0x33], bg: [0xf3, 0xf3, 0xf3] },
  dark: { accent: [0x5c, 0xd6, 0xac], warn: [0xff, 0xa5, 0x7a], muted: [0xc3, 0xbd, 0xb2], ring: [0xff, 0x7a, 0x6b], ink: [0xb8, 0xb2, 0xa7], bg: [0x20, 0x20, 0x20] },
};

// ---------------------------------------------------------------- WCAG
const lin = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// ---------------------------------------------------------------- 渲染 + 降采样 + PNG
function render(cand, state, col) {
  const buf = blank();
  const fn = cand.draw(state, col);
  for (let y = 0; y < CANVAS; y++) {
    for (let x = 0; x < CANVAS; x++) {
      // 硬边界的老图标：不超采样取中点；新候选：4×4 超采样求平均 alpha
      if (cand.hardEdges) {
        const hit = fn(Math.floor(x / SS) + 0.5, Math.floor(y / SS) + 0.5);
        if (hit) put(buf, x, y, hit[0], hit[1]);
      } else {
        let hits = 0;
        let rgb = [0, 0, 0];
        for (let sy = 0; sy < SS; sy++)
          for (let sx = 0; sx < SS; sx++) {
            const hit = fn((x + (sx + 0.5) / SS) / SS, (y + (sy + 0.5) / SS) / SS);
            if (hit) {
              hits++;
              rgb = [rgb[0] + hit[0][0], rgb[1] + hit[0][1], rgb[2] + hit[0][2]];
            }
          }
        if (hits) put(buf, x, y, rgb.map((v) => v / hits), hits / (SS * SS));
      }
    }
  }
  return buf;
}
/** 面积平均降采样（把超采样的 128 收成 32；以及 ≈ 系统把 32px 图缩到 16/20px 的那一步） */
function downscale(buf, inSize, out) {
  const k = inSize / out;
  const dst = new Uint8ClampedArray(out * out * 4);
  for (let y = 0; y < out; y++)
    for (let x = 0; x < out; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = 0; sy < k; sy++)
        for (let sx = 0; sx < k; sx++) {
          const i = ((Math.floor(y * k) + sy) * inSize + Math.floor(x * k) + sx) * 4;
          const al = buf[i + 3] / 255;
          r += buf[i] * al; g += buf[i + 1] * al; b += buf[i + 2] * al; a += al; n++;
        }
      const o = (y * out + x) * 4;
      if (a > 0) {
        dst[o] = r / a; dst[o + 1] = g / a; dst[o + 2] = b / a;
      }
      dst[o + 3] = (a / n) * 255;
    }
  return dst;
}
/** 贴底色（模拟任务栏上未透明的呈现） */
function onBg(buf, bg) {
  const out = new Uint8ClampedArray(buf.length);
  for (let i = 0; i < buf.length; i += 4) {
    const a = buf[i + 3] / 255;
    for (let c = 0; c < 3; c++) out[i + c] = buf[i + c] * a + bg[c] * (1 - a);
    out[i + 3] = 255;
  }
  return out;
}
function png(buf, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    for (let x = 0; x < size * 4; x++) raw[y * (size * 4 + 1) + 1 + x] = buf[y * size * 4 + x];
  }
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const uri = (buf, size, bg) => `data:image/png;base64,${png(onBg(buf, bg), size).toString("base64")}`;

// ---------------------------------------------------------------- 组装页面
const CORE = {
  default: (col) => col.muted,
  current: (col) => col.accent,
  warn: (col) => col.warn,
  overload: (col) => col.ring,
};

const rows = [];
for (const [key, cand] of Object.entries(CANDS)) {
  for (const [state, stateLabel] of STATES) {
    const variants = [];
    for (const tb of ["light", "dark"]) {
      const col = key === "now" ? FIXED : BY_THEME[tb];
      // ① 4× 超采样画 128×128 → ② 收成 32（真交付给系统的位图）→ ③ 再降到 20 / 16（系统缩放）
      const ss = render(cand, state, col);
      const icon = downscale(ss, CANVAS, SIZE);
      const c = CORE[state](col);
      variants.push({
        tb,
        r32: uri(icon, 32, TASKBAR[tb]),
        r20: uri(downscale(icon, SIZE, 20), 20, TASKBAR[tb]),
        r16: uri(downscale(icon, SIZE, 16), 16, TASKBAR[tb]),
        contrast: ratio(c, TASKBAR[tb]),
      });
    }
    rows.push({ key: key === "now" ? "now" : key, cand: cand.label, state, stateLabel, variants });
  }
}

const cell = (v) => {
  const bad = v.contrast < 3;
  return `<figure class="cell">
    <img class="tb ${v.tb}" src="${v.r32}" width="32" height="32" alt="">
    <div class="sizes">
      <img class="tb ${v.tb}" src="${v.r20}" width="20" height="20" alt=""><img class="tb ${v.tb}" src="${v.r16}" width="16" height="16" alt="">
    </div>
    <figcaption>${v.tb === "light" ? "亮任务栏" : "暗任务栏"} <span class="cr ${bad ? "bad" : "ok"}">${v.contrast.toFixed(2)}:1</span><br><span class="dim">32px / 20 / 16</span></figcaption>
  </figure>`;
};

const groups = ["now", "A", "B", "C"].map((k) => {
  const set = rows.filter((r) => r.key === k);
  return `<section class="cand">
  <h2>${k === "now" ? "现状" : "候选 " + k} —— ${set[0].cand}</h2>
  <table class="grid">
    <thead><tr><th>状态</th><th>呈现（真尺寸像素 · 贴任务栏底色）</th></tr></thead>
    <tbody>
      ${set
        .map(
          (r) => `<tr><th class="st">${r.stateLabel}</th><td class="cells">${r.variants.map(cell).join("")}</td></tr>`,
        )
        .join("")}
    </tbody>
  </table>
</section>`;
}).join("");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>round82 样张 · 托盘图标候选（真像素）</title>
<style>
  :root { color-scheme: light dark; --fg:#211d18; --bg:#f6f3ef; --card:#fff; --line:#d8d3ca; --dim:#6b6559; --ok:#0e6b52; --bad:#b3261e; }
  @media (prefers-color-scheme: dark) { :root { --fg:#eae7e1; --bg:#1a1917; --card:#242320; --line:#3a3833; --dim:#b5afa5; --ok:#4ec39b; --bad:#ff8a7a; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:22px 26px 70px; background:var(--bg); color:var(--fg);
    font:13px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif; }
  h1 { font-size:19px; margin:0 0 4px; }
  h2 { font-size:14px; margin:26px 0 8px; }
  .note { border-left:3px solid var(--ok); background:color-mix(in srgb, var(--ok) 8%, transparent);
    padding:8px 10px; margin:10px 0; color:var(--dim); font-size:12px; }
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
<h1>托盘图标候选 —— 真像素样张（16 / 20 / 32px 贴任务栏底色）</h1>
<p class="note">
  <b>怎么读：</b>每格三个尺寸 —— 大图 <b>32px</b>（我们交给系统的位图）、中间 <b>20px</b>（125% DPI 任务栏）、小图 <b>16px</b>（100% DPI 任务栏）。
  后两者是 32px 位图**按面积的降采样**（≈ 系统缩放那一步），所以「糊不糊」在这里是可信的。
  左下角的数字 = 该状态的主色对任务栏底色的 <b>WCAG 对比度</b>（1.4.11 要求 ≥3:1，红的=不达标）。
</p>
<p class="note">
  <b>底色</b>：亮任务栏 <code>#f3f3f3</code> / 暗任务栏 <code>#202020</code>（Windows 11 默认；本机当前 = 暗）。
  <b>现状</b>那组用的是 <code>icons.rs</code> 里的固定色；候选 A/B/C 用「<b>按任务栏主题换一套色</b>」的推荐做法（亮任务栏用深墨、暗任务栏用浅墨）。
</p>
<p class="note">
  产物由 <code>node tools/visual/round82-tray-sample.mjs</code> 生成（可重跑）；PNG 内联在页面里，仓库不落二进制文件。
</p>
${groups}
</body>
</html>
`;

await writeFile(P("docs/visual/round82-托盘候选.html"), html);
console.log("写出 docs/visual/round82-托盘候选.html");
const bad = rows.flatMap((r) => r.variants.map((v) => ({ id: `${r.key}/${r.state}/${v.tb}`, c: v.contrast }))).filter((x) => x.c < 3);
console.log(`对比度 <3:1 的格子：${bad.length ? bad.map((b) => `${b.id} ${b.c.toFixed(2)}`).join(" · ") : "无"}`);
