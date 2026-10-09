// round82（3.1c₂ · `盘-*`）：托盘样张的**共用底座** —— SVG path → 真像素 + PNG + 对比度。
//
// 为什么要有它：托盘是**栅格问题**（16px 糊不糊、亮任务栏看不看得见），只有把真形状按系统的方式
// 栅格化、再降采样，数字才可信。两个样张工具（`round82-tray-sample.mjs` = 自绘几何候选、
// `round82-tray-v2.mjs` = 借开源图标候选）共用这一份，免得两份实现漂掉。
//
// 形状来源：`src/lib/icons/sets/*.ts`（五套开源图标；许可见 `src-tauri/resources/ICONS-LICENSE.md`）——
// viewBox 24×24、`fill: none` + `stroke: currentColor` + `stroke-width: 2`（与前端 `Icon.svelte` 同一口径）。
import { deflateSync as zlibDeflate } from "node:zlib";

// ---------------------------------------------------------------- PNG
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
/** RGBA8 缓冲 → PNG 字节 */
export function png(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size * 4; x++) raw[y * (size * 4 + 1) + 1 + x] = rgba[y * size * 4 + x];
  }
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
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibDeflate(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 遮罩（alpha）
/** 一张 `ss×ss` 的浮点 alpha 画布（8× 超采样用） */
export const newMask = (ss) => new Float32Array(ss * ss);

/** 往遮罩里盖一枚圆（alpha=1，边缘按距离做 1px 软过渡 —— 抗锯齿就靠它） */
export function stampDisc(mask, ss, cx, cy, r, value = 1, mode = "set") {
  const x0 = Math.max(0, Math.floor(cx - r - 2));
  const x1 = Math.min(ss - 1, Math.ceil(cx + r + 2));
  const y0 = Math.max(0, Math.floor(cy - r - 2));
  const y1 = Math.min(ss - 1, Math.ceil(cy + r + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const a = Math.min(1, Math.max(0, r - d + 0.5));
      if (a <= 0) continue;
      const i = y * ss + x;
      mask[i] = mode === "set" ? Math.max(mask[i], a * value) : Math.min(mask[i], 1 - a * value);
    }
  }
}

/** 超采样遮罩 → `size×size` 的 0–255 alpha */
export function resolveAlpha(mask, ss, size) {
  const k = ss / size;
  const out = new Uint8ClampedArray(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let sy = 0; sy < k; sy++) {
        for (let sx = 0; sx < k; sx++) sum += mask[(Math.floor(y * k) + sy) * ss + Math.floor(x * k) + sx];
      }
      out[y * size + x] = (sum / (k * k)) * 255;
    }
  }
  return out;
}

/** 面积平均降采样（≈ 系统把 32px 位图缩到 20/16px 的那一步） */
export function downscaleAlpha(alpha, inSize, outSize) {
  const k = inSize / outSize;
  const out = new Uint8ClampedArray(outSize * outSize);
  for (let y = 0; y < outSize; y++) {
    for (let x = 0; x < outSize; x++) {
      let sum = 0;
      for (let sy = 0; sy < k; sy++) {
        for (let sx = 0; sx < k; sx++) sum += alpha[(Math.floor(y * k) + sy) * inSize + Math.floor(x * k) + sx];
      }
      out[y * outSize + x] = sum / (k * k);
    }
  }
  return out;
}

/** alpha 遮罩 + 颜色 → 贴到底色上的 RGBA 缓冲 */
export function tintOn(alpha, size, color, bg) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = alpha[i] / 255;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = color[c] * a + bg[c] * (1 - a);
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------- SVG path
/**
 * 极简 path 解析 → 折线（只支持图标里会出现的命令：M m L l H h V v C c S s Q q T t A a Z z）。
 * 弧按 SVG 规范转成中心参数化再采样（图标里的圆环就是它）。
 */
export function flattenPath(d, steps = 18) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0;
  let cur = [0, 0];
  let start = [0, 0];
  let prevCubic = null;
  let prevQuad = null;
  const lines = [];
  let line = [];
  const num = () => Number(tokens[i++]);
  const push = (p) => {
    line.push(p);
    cur = p;
  };
  const flush = () => {
    if (line.length > 1) lines.push(line);
    line = [];
  };
  let cmd = "";
  while (i < tokens.length) {
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const base = rel ? cur : [0, 0];
    switch (cmd.toUpperCase()) {
      case "M": {
        const p = [num() + base[0], num() + base[1]];
        flush();
        line = [p];
        cur = p;
        start = p;
        cmd = rel ? "l" : "L"; // 后续隐式 lineto
        break;
      }
      case "L": {
        push([num() + base[0], num() + base[1]]);
        break;
      }
      case "H": {
        push([num() + base[0], cur[1]]);
        break;
      }
      case "V": {
        push([cur[0], num() + base[1]]);
        break;
      }
      case "C": {
        const c1 = [num() + base[0], num() + base[1]];
        const c2 = [num() + base[0], num() + base[1]];
        const p = [num() + base[0], num() + base[1]];
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const mt = 1 - t;
          push([
            mt ** 3 * cur[0] + 3 * mt ** 2 * t * c1[0] + 3 * mt * t ** 2 * c2[0] + t ** 3 * p[0],
            mt ** 3 * cur[1] + 3 * mt ** 2 * t * c1[1] + 3 * mt * t ** 2 * c2[1] + t ** 3 * p[1],
          ]);
        }
        prevCubic = c2;
        prevQuad = null;
        break;
      }
      case "S": {
        const c1 = prevCubic ? [2 * cur[0] - prevCubic[0], 2 * cur[1] - prevCubic[1]] : cur;
        const c2 = [num() + base[0], num() + base[1]];
        const p = [num() + base[0], num() + base[1]];
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const mt = 1 - t;
          push([
            mt ** 3 * cur[0] + 3 * mt ** 2 * t * c1[0] + 3 * mt * t ** 2 * c2[0] + t ** 3 * p[0],
            mt ** 3 * cur[1] + 3 * mt ** 2 * t * c1[1] + 3 * mt * t ** 2 * c2[1] + t ** 3 * p[1],
          ]);
        }
        prevCubic = c2;
        break;
      }
      case "Q": {
        const c = [num() + base[0], num() + base[1]];
        const p = [num() + base[0], num() + base[1]];
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const mt = 1 - t;
          push([mt ** 2 * cur[0] + 2 * mt * t * c[0] + t ** 2 * p[0], mt ** 2 * cur[1] + 2 * mt * t * c[1] + t ** 2 * p[1]]);
        }
        prevQuad = c;
        break;
      }
      case "T": {
        const c = prevQuad ? [2 * cur[0] - prevQuad[0], 2 * cur[1] - prevQuad[1]] : cur;
        const p = [num() + base[0], num() + base[1]];
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const mt = 1 - t;
          push([mt ** 2 * cur[0] + 2 * mt * t * c[0] + t ** 2 * p[0], mt ** 2 * cur[1] + 2 * mt * t * c[1] + t ** 2 * p[1]]);
        }
        prevQuad = c;
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = num();
        const sweep = num();
        const p = [num() + base[0], num() + base[1]];
        for (const q of arcPoints(cur, rx, ry, rot, large, sweep, p, steps * 2)) push(q);
        break;
      }
      case "Z": {
        if (line.length > 0) push([start[0], start[1]]);
        flush();
        cur = start;
        break;
      }
      default:
        i++; // 不认识的命令：跳过，别死循环
    }
    prevQuad = cmd.toUpperCase() === "Q" || cmd.toUpperCase() === "T" ? prevQuad : null;
  }
  flush();
  return lines;
}

/** SVG 弧 → 折线（W3C 实现说明 F.6） */
function arcPoints(p0, rx, ry, rotDeg, largeArc, sweep, p1, steps) {
  const out = [];
  if (rx === 0 || ry === 0) return [p1];
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2;
  const dy = (p0[1] - p1[1]) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lam = x1p ** 2 / rx ** 2 + y1p ** 2 / ry ** 2;
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s;
    ry *= s;
  }
  const num = Math.max(0, rx ** 2 * ry ** 2 - rx ** 2 * y1p ** 2 - ry ** 2 * x1p ** 2);
  const den = rx ** 2 * y1p ** 2 + ry ** 2 * x1p ** 2;
  let coef = Math.sqrt(num / den);
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (p0[0] + p1[0]) / 2;
  const cy = sin * cxp + cos * cyp + (p0[1] + p1[1]) / 2;
  const ang = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  for (let s = 1; s <= steps; s++) {
    const t = t1 + dt * (s / steps);
    out.push([cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos]);
  }
  return out;
}

/**
 * 把若干条 path（`d` 字符串）+ 笔宽画进遮罩。
 * 坐标口径：`unit` = **一个图标单位（viewBox 0–24）对应多少超采样像素**（已含 ss），
 * `pad` = 画布内缩（超采样像素）。笔宽按图标单位给（Lucide 默认 2）。
 * ⚠️ 别再乘一次 `ss` —— 早期版本把 `scale` 当成无单位系数又乘了 `ss`，坐标跑到画布外 → 画布全空。
 */
export function strokePaths(mask, ss, paths, opts) {
  const { unit, pad = 0, strokeWidth = 2, dx = 0, dy = 0, value = 1, mode = "set" } = opts;
  if (!(unit > 0)) throw new Error(`strokePaths: unit 得是正数（拿到 ${unit}）—— 它 = (画布边长 − 内缩) / 24 × 超采样倍率`);
  const r = (strokeWidth / 2) * unit;
  let painted = 0;
  const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const d of paths) {
    for (const line of flattenPath(d)) {
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i];
        const b = line[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) * unit;
        const n = Math.max(1, Math.ceil(len / (r * 0.5)));
        for (let s = 0; s <= n; s++) {
          const t = s / n;
          const x = (a[0] + (b[0] - a[0]) * t) * unit + pad + dx;
          const y = (a[1] + (b[1] - a[1]) * t) * unit + pad + dy;
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          if (x >= 0 && y >= 0 && x < ss && y < ss) {
            painted += 1;
            if (x < bbox.minX) bbox.minX = x;
            if (y < bbox.minY) bbox.minY = y;
            if (x > bbox.maxX) bbox.maxX = x;
            if (y > bbox.maxY) bbox.maxY = y;
          }
          stampDisc(mask, ss, x, y, r, value, mode);
        }
      }
    }
  }
  // 画空 / 只占一角 = 坐标算错（今天真踩过两次：多乘一层 ss / 少乘一层倍率）→ 宁可抛，别静默产出空样张
  // 判据：落点包围盒至少得占到画布的 30%（图标形状铺满 viewBox，正常会接近 100%）
  if (paths.length > 0 && painted === 0) {
    throw new Error("strokePaths 一枚像素都没落在画布上 —— 检查 unit / pad 与超采样倍率");
  }
  if (paths.length > 0) {
    const spanX = bbox.maxX - bbox.minX;
    const spanY = bbox.maxY - bbox.minY;
    if (Math.max(spanX, spanY) < ss * 0.3) {
      throw new Error(
        `strokePaths 画的形状只占了画布的 ${(Math.max(spanX, spanY) / ss * 100).toFixed(1)}%（<30%）—— unit/pad 八成算错了`,
      );
    }
  }
}

/** 填充一个多边形（简单情形：凸多边形，用重心法判断）—— 徽标三角用它 */
export function fillPolygon(mask, ss, pts) {
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0]))));
  const x1 = Math.min(ss - 1, Math.ceil(Math.max(...pts.map((p) => p[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1]))));
  const y1 = Math.min(ss - 1, Math.ceil(Math.max(...pts.map((p) => p[1]))));
  const sign = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = [x + 0.5, y + 0.5];
      const d1 = sign(pts[0], pts[1], p);
      const d2 = sign(pts[1], pts[2], p);
      const d3 = sign(pts[2], pts[0], p);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(hasNeg && hasPos)) mask[y * ss + x] = 1;
    }
  }
}

// ---------------------------------------------------------------- 颜色 / 对比度
export const TASKBAR = { light: [0xf3, 0xf3, 0xf3], dark: [0x20, 0x20, 0x20] };
const lin = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
/** WCAG 对比度 */
export const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
export const hex = (h) => {
  const s = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
