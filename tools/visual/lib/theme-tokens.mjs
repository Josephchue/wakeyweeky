// round84（3.2 主题包）· **样张与预检的共用底座** —— 颜色数学 + 52 对表 + 淡化带 4 条 + 令牌派生。
//
// 为什么要有它：样张生成器（`theme-sample-84.mjs`）要「不达标不进样张」，判据必须与
// `tools/visual/contrast.mjs`（330 项 0 败的那个闸门）**同一套公式、同一张对表**。
// 本文件是那份口径的唯一来源；`contrast.mjs` 的扩展（round84 Step 4）会改为 import 这里。
//
// 自检（生成器启动时跑）：把 `contrast.mjs` 源码里的字面对表抠出来逐行比对 —— 表一变，这边就红。

// ---------------------------------------------------------------- WCAG 2.x（与 contrast.mjs 同公式）
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** 入参 = 0–255 的 RGB 数组（与 contrast.mjs 的 `lum` 同口径） */
export const lum = (rgb) => {
  const [r, g, b] = rgb.map((c) => lin(c / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratioRgb = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
/** `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()` → [r,g,b]（0–255） */
export function parseColor(value) {
  const v = String(value).trim();
  if (v.startsWith("#")) {
    const s = v.slice(1);
    return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
  }
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  return m[1]
    .split(/[,\s/]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map(Number);
}
/** 带 alpha 的解析（淡化带这类半透明值要合成后再量） */
export function parseColorA(value) {
  const v = String(value).trim();
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const nums = m[1]
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map((x) => (x.endsWith("%") ? parseFloat(x) / 100 : Number(x)));
    return { rgb: nums.slice(0, 3), a: nums.length >= 4 ? nums[3] : 1 };
  }
  if (v.startsWith("#")) {
    const s = v.slice(1);
    const rgb = [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
    const a = s.length >= 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1;
    return { rgb, a };
  }
  const c = parseColor(v);
  return c ? { rgb: c, a: 1 } : null;
}
/** fg 叠在 bg 上的合成色 */
export const over = (fg, bg) =>
  !fg || !bg ? null : { rgb: fg.rgb.map((c, i) => Math.round(c * fg.a + bg.rgb[i] * (1 - fg.a))), a: 1 };
/** CIE L*（淡化带用 ΔL*） */
export const lStar = (rgb) => {
  const [r, g, b] = rgb.map((c) => lin(c / 255));
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t) / 116 + 16 / 116);
  return 116 * f(y) - 16;
};

// ---------------------------------------------------------------- 颜色工具（派生用）
export const toRgbArr = (hexOrRgb) => (Array.isArray(hexOrRgb) ? hexOrRgb.slice(0, 3) : parseColor(hexOrRgb));
export const toHex = (rgb) =>
  `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;
/** t=0 → a，t=1 → b（sRGB 线性插值，够用且可复现） */
export const mix = (a, b, t) => {
  const A = toRgbArr(a);
  const B = toRgbArr(b);
  return toHex(A.map((c, i) => c + (B[i] - c) * t));
};

// ---------------------------------------------------------------- 52 对（与 contrast.mjs 逐行同表）
// ⚠️ 本注释声称的「启动自检」实际不存在（round86 发现）—— 两份表目前靠人盯；改表时两处一起改。
/** [说明, 前景 token, 背景 token, 达标线] */
export const PAIRS = [
  ["正文 / 底", "--text-primary", "--bg", 7],
  ["次要文字 / 底", "--text-secondary", "--bg", 4.5],
  ["次要文字 / 卡", "--text-secondary", "--card", 4.5],
  ["三级文字 / 卡", "--text-tertiary", "--card", 4.5],
  ["强调色（图标）/ 卡", "--accent", "--card", 3],
  ["强调色（图标）/ 底", "--accent", "--bg", 3],
  // round86（0.32.0 · ①）：装饰/底色色 —— 只染「非交互」的东西（块三态 / 层条 / 头部细线 / 今天列）。
  // 默认 = `var(--accent)`（老 11 套零变化）；北境极夜 = 木色（而 `--accent` = 极夜蓝）。
  ["装饰强调色 / 卡", "--accent-deco", "--card", 3],
  ["块内文字 / 计划中底", "--block-ink-planned", "--block-fill-planned", 4.5],
  ["块内文字 / 完成底", "--block-ink-done", "--block-fill-done", 4.5],
  ["块内文字 / 未完成底", "--block-ink-missed", "--block-fill-missed", 4.5],
  ["必填层条 / 计划中底", "--layer-required-bar", "--block-fill-planned", 3],
  ["必填层条 / 完成底", "--layer-required-bar", "--block-fill-done", 3],
  ["必填层条 / 未完成底", "--layer-required-bar", "--block-fill-missed", 3],
  ["弹性层条 / 计划中底", "--layer-elastic-bar", "--block-fill-planned", 3],
  ["弹性层条 / 完成底", "--layer-elastic-bar", "--block-fill-done", 3],
  ["弹性层条 / 未完成底", "--layer-elastic-bar", "--block-fill-missed", 3],
  ["残影虚线 / 底", "--block-line-ghost", "--bg", 3],
  ["未完成虚线 / 底", "--block-line-missed", "--bg", 3],
  ["警示文字 / 卡", "--warn", "--card", 4.5],
  ["警示底（白字）", "--on-warn", "--warn-solid", 4.5],
  ["完成描边 / 卡", "--block-line-done", "--card", 3],
  ["计划中描边 / 卡（装饰边界）", "--block-line-planned", "--card", 1.4],
  ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((i) => [
    [`类别色 #${i} / 卡`, `--cat-${i}`, "--card", 3],
    [`类别色 #${i} / 计划中底`, `--cat-${i}`, "--block-fill-planned", 3],
    [`类别色 #${i} / 完成底`, `--cat-${i}`, "--block-fill-done", 3],
  ]),
  ["强调底上的字 / 强调色", "--on-accent", "--accent", 4.5],
  ["金章 / 卡", "--medal", "--card", 3],
  ["现在线 / 底", "--now-line", "--bg", 3],
  ["现在线 / 计划中底", "--now-line", "--block-fill-planned", 3],
  ["现在线 / 完成底", "--now-line", "--block-fill-done", 3],
  ["现在线 / 未完成底", "--now-line", "--block-fill-missed", 3],
];

/** dim 场景：带叠在底上之后合成色，再量 4 条不变量（与 contrast.mjs 的 round82 场景同口径） */
export function checkDim(tokens) {
  const base = parseColorA(tokens["--bg"]);
  const band = over(parseColorA(tokens["--dim-band"]), base);
  const rows = [
    { label: "淡化带 / 底（ΔL*）", value: Math.abs(lStar(band.rgb) - lStar(base.rgb)), min: 2, isDelta: true },
    {
      label: "块底 / 淡化带",
      value: ratioRgb(parseColor(tokens["--block-fill-planned"]), band.rgb),
      min: 1.05,
    },
    {
      label: "网格线 / 淡化带",
      value: ratioRgb(over(parseColorA(tokens["--grid-line"]), band).rgb, band.rgb),
      min: 1.1,
    },
    { label: "次要文字 / 淡化带", value: ratioRgb(parseColor(tokens["--text-secondary"]), band.rgb), min: 4.5 },
  ];
  return rows.map((r) => ({ ...r, ok: Number.isFinite(r.value) && r.value >= r.min }));
}

/** 跑 52 对 + 淡化带 4 条；`bgOverride` = 纹理合成后的底（背景类对子用它） */
export function checkTokens(tokens, bgOverride) {
  const bgKey = "--bg";
  const effective = bgOverride ? { ...tokens, [bgKey]: bgOverride } : tokens;
  const pairs = PAIRS.map(([label, fgName, bgName, min]) => {
    const fg = parseColor(effective[fgName]);
    const bg = parseColor(effective[bgName]);
    const r = fg && bg ? ratioRgb(fg, bg) : NaN;
    return { label, fg: fgName, bg: bgName, r: Math.round(r * 100) / 100, min, ok: r >= min };
  });
  const dim = checkDim(effective);
  const failures = [
    ...pairs.filter((p) => !p.ok).map((p) => `${p.label}：${p.r} < ${p.min}`),
    ...dim.filter((d) => !d.ok).map((d) => `${d.label}：${d.value.toFixed(2)} < ${d.min}`),
  ];
  return { pairs, dim, failures };
}

/** 把纹理线色以 opacity 合到底上；返回合成色（hex）——预检用它替 `--bg` */
export function textureOverBg(tokens, surface) {
  if (!surface) return null;
  const s = Array.isArray(surface) ? surface[0] : surface;
  const line = parseColor(tokens[s.color] ?? s.color);
  if (!line) return null;
  const a = s.opacity ?? 0.05;
  const bg = parseColor(tokens["--bg"]);
  return toHex(line.map((c, i) => Math.round(c * a + bg[i] * (1 - a))));
}

// ---------------------------------------------------------------- 自动调参（把派生值移到刚好达标的边上）
const minRatio = (color, bgs) => Math.min(...bgs.map((b) => ratioRgb(parseColor(color), parseColor(b) ?? b)));
/** 淡化带：按底的亮度选黑/白方向，取能让 ΔL* ≥ 2.5 的最小透明度（纯黑底也能看出带） */
function pickDimBand(bg) {
  const base = parseColorA(bg);
  const delta = (a, color) => Math.abs(lStar(over({ rgb: color, a }, base).rgb) - lStar(base.rgb));
  for (const a of [0.08, 0.12, 0.16, 0.2, 0.24, 0.3]) if (delta(a, [0, 0, 0]) >= 2.5) return `rgba(0, 0, 0, ${a})`;
  for (const a of [0.05, 0.08, 0.11, 0.14, 0.18]) if (delta(a, [255, 255, 255]) >= 2.5) return `rgba(255, 255, 255, ${a})`;
  return "rgba(0, 0, 0, 0.25)";
}
/** 单目标版：把 color 朝 toward 方向二分推进，直到对 bgs 的最小对比度 ≥ target（target 留 2% 余量） */
function fit(color, bgs, target, toward) {
  const need = target * 1.02;
  const ok = (c) => minRatio(c, bgs) >= need;
  if (ok(color)) return color;
  const far = mix(color, toward, 1);
  if (!ok(far)) return far; // 推到顶也不达标 —— 让预检把它报出来（不藏）
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mix(color, toward, mid))) hi = mid;
    else lo = mid;
  }
  return mix(color, toward, hi);
}
/**
 * round85：**多目标版**（同一个色要同时满足几个背景）—— 线性扫一遍取**第一个达标的**（= 最小改动）。
 * 为什么不能直接用二分：色落在几个背景之间时 `ok(t)` 不是单调的（先降后升），二分会越过「刚好达标」
 * 那一档很多（实测块底会暗一大截）。单目标时两者结果一致，但这里只在多目标路径上用，
 * 保老路径（round84 样张生成器）逐字节不变。
 */
function fitClosest(color, bgs, target, toward) {
  const need = target * 1.02;
  const ok = (c) => minRatio(c, bgs) >= need;
  if (ok(color)) return color;
  for (let i = 1; i <= 128; i++) {
    const c = mix(color, toward, i / 128);
    if (ok(c)) return c;
  }
  return fit(color, bgs, target, toward);
}

// ---------------------------------------------------------------- 令牌派生（种子 → 完整第 1 层）
/** 与 `tokens.css` 同款：亮暗两套 Okabe-Ito 变体（默认类目色；候选可覆盖） */
export const DEFAULT_CATS_LIGHT = ["#0072b2", "#008e68", "#a67200", "#a55f86", "#c95500", "#3a7a9e", "#827b24", "#7d7d7d"];
export const DEFAULT_CATS_DARK = ["#3891c3", "#009e73", "#e69f00", "#cc79a7", "#d86b14", "#56b4e9", "#f0e442", "#999999"];

/**
 * 种子 → 一套亮/暗令牌（键 = `tokens.css` 第 1 层的名字）。
 * 顺序：先调「骨架」（accent / 淡化带）→ 再用调过的骨架派生块三态 / 层条 / 类目色 → 最后逐项二分到刚好达标。
 */
export function deriveTokens(seed, mode, opts = {}) {
  const dark = mode === "dark";
  const { bg, card, text, accent: seedAccent, warn } = seed;
  const warnSolid = seed.warnSolid ?? mix(warn, "#000000", dark ? 0.35 : 0.25);
  const white = parseColor("#ffffff");
  const onWarn = seed.onWarn ?? (ratioRgb(white, parseColor(warnSolid)) >= 4.5 ? "#ffffff" : "#1b1b1b");
  const towardWhite = dark ? "#ffffff" : text;
  // ---- 1) 骨架：强调色先保证对卡/底 ≥ 3；淡化带按底的亮度自动选黑/白方向（ΔL* ≥ 2.5）----
  const accent = fit(seedAccent, [card, bg], 3, towardWhite);
  // round86（0.32.0 · ①）：**装饰/底色色**（`accentDeco`，可选）—— 只染「非交互」的东西：
  // 块三态 / 层条（它们今天就是从 accent 派生的，所以北境给木色 = 与 0.31.0 逐值不变）。
  // 没给 `accentDeco` 的配色：`deco === accent` → 与老行为逐字节一致。
  const deco = seed.accentDeco ? fit(seed.accentDeco, [card, bg], 3, towardWhite) : accent;
  const dimBand = pickDimBand(bg);
  const textSecondary = mix(text, bg, dark ? 0.42 : 0.5);
  const textTertiary = mix(text, bg, dark ? 0.6 : 0.64);
  const catBase = seed.cats ?? (dark ? DEFAULT_CATS_DARK : DEFAULT_CATS_LIGHT);
  const tokens = {
    "--bg": bg,
    "--card": card,
    "--text-primary": text,
    "--text-secondary": textSecondary,
    "--text-tertiary": textTertiary,
    "--accent": accent,
    "--accent-deco": deco,
    "--accent-fill": seed.accentFill ?? accent,
    "--warn": warn,
    "--warn-solid": warnSolid,
    "--block-fill-planned": mix(deco, bg, dark ? 0.72 : 0.86),
    "--block-ink-planned": dark ? mix(deco, "#ffffff", 0.78) : text,
    "--block-line-planned": mix(deco, bg, dark ? 0.5 : 0.55),
    "--block-fill-done": mix(deco, bg, dark ? 0.6 : 0.76),
    "--block-ink-done": dark ? mix(deco, "#ffffff", 0.78) : text,
    "--block-line-done": deco,
    "--block-fill-missed": mix(text, bg, dark ? 0.88 : 0.93),
    "--block-ink-missed": textSecondary,
    "--block-line-missed": mix(text, bg, 0.55),
    "--block-line-ghost": mix(text, bg, dark ? 0.45 : 0.5),
    "--layer-required-bar": dark ? deco : mix(deco, "#000000", 0.18),
    "--layer-elastic-bar": mix(text, bg, dark ? 0.45 : 0.6),
    "--on-warn": onWarn,
    "--on-accent": card,
    "--medal": dark ? "#d4a63c" : "#b8860b",
    "--now-line": warn,
    "--cat-1": mix(catBase[0], bg, dark ? 0.08 : 0.1),
    "--cat-2": mix(catBase[1], bg, dark ? 0.08 : 0.1),
    "--cat-3": mix(catBase[2], bg, dark ? 0.08 : 0.1),
    "--cat-4": mix(catBase[3], bg, dark ? 0.08 : 0.1),
    "--cat-5": mix(catBase[4], bg, dark ? 0.08 : 0.1),
    "--cat-6": mix(catBase[5], bg, dark ? 0.08 : 0.1),
    "--cat-7": mix(catBase[6], bg, dark ? 0.08 : 0.1),
    "--cat-8": mix(catBase[7], bg, dark ? 0.08 : 0.1),
    "--grid-line": `rgba(${parseColor(text).join(", ")}, 0.08)`,
    "--dim-band": dimBand,
  };

  // ---- 2) 自动调参：把「刚好达标」的令牌推到达标线之上（预检仍会把不过的报出来）----
  const tuneBg = textureOverBg(tokens, seed.surface) ?? bg;
  const band = over(parseColorA(tokens["--dim-band"]), parseColorA(tuneBg));
  const bandBg = toHex(band.rgb);
  // round85（0.31.0）：可选的**保守目标** —— `contrast.mjs` 的淡化带尺子只看 `--bg`（不知道底纹那一层），
  // 所以「底纹把底压暗了」的配色在那张尺子上会差一点。传 `plainBand: true` = 块底同时对
  // 「带 + 底纹」与「带 + 纯底」都达 1.05（真机上只会更清楚）。默认不传 = 与老行为逐字节一致。
  const plainBandBg = opts.plainBand
    ? toHex(over(parseColorA(tokens["--dim-band"]), parseColorA(bg)).rgb)
    : null;
  const fillTargets = plainBandBg && plainBandBg !== bandBg ? [bandBg, plainBandBg] : [bandBg];
  // 块底要能在淡化带上分得出（调研 §4 的不变量）；多目标时用最小改动版
  const fitFill = fillTargets.length > 1 ? fitClosest : fit;
  tokens["--block-fill-planned"] = fitFill(tokens["--block-fill-planned"], fillTargets, 1.05, deco);
  tokens["--block-fill-done"] = fitFill(tokens["--block-fill-done"], fillTargets, 1.05, deco);
  tokens["--block-ink-planned"] = fit(tokens["--block-ink-planned"], [tokens["--block-fill-planned"]], 4.5, text);
  tokens["--block-ink-done"] = fit(tokens["--block-ink-done"], [tokens["--block-fill-done"]], 4.5, text);
  const fills = [tokens["--block-fill-planned"], tokens["--block-fill-done"], tokens["--block-fill-missed"]];
  tokens["--text-secondary"] = fit(tokens["--text-secondary"], [tuneBg, bandBg, card], 4.5, text);
  tokens["--text-tertiary"] = fit(tokens["--text-tertiary"], [card], 4.5, text);
  tokens["--block-ink-missed"] = fit(tokens["--block-ink-missed"], [tokens["--block-fill-missed"]], 4.5, text);
  tokens["--layer-elastic-bar"] = fit(tokens["--layer-elastic-bar"], fills, 3, towardWhite);
  tokens["--layer-required-bar"] = fit(tokens["--layer-required-bar"], fills, 3, towardWhite);
  tokens["--block-line-missed"] = fit(tokens["--block-line-missed"], [tuneBg, bandBg], 3, towardWhite);
  tokens["--block-line-ghost"] = fit(tokens["--block-line-ghost"], [tuneBg, bandBg], 3, towardWhite);
  tokens["--medal"] = fit(tokens["--medal"], [card, bg], 3, text);
  for (let i = 1; i <= 8; i++) {
    tokens[`--cat-${i}`] = fit(tokens[`--cat-${i}`], [card, ...fills.slice(0, 2)], 3, towardWhite);
  }
  tokens["--now-line"] = fit(tokens["--now-line"], [tuneBg, bandBg, ...fills], 3, towardWhite);
  for (const cand of [card, text, "#ffffff", "#111111", "#000000"]) {
    if (ratioRgb(parseColor(cand), parseColor(accent)) >= 4.5 * 1.02) {
      tokens["--on-accent"] = cand;
      break;
    }
  }
  for (const cand of [onWarn, "#ffffff", "#111111", "#000000", card]) {
    if (cand && ratioRgb(parseColor(cand), parseColor(tokens["--warn-solid"])) >= 4.5 * 1.02) {
      tokens["--on-warn"] = cand;
      break;
    }
  }
  return tokens;
}

// ---------------------------------------------------------------- 底纹（surface）→ CSS
// round85：从 `theme-sample-84.mjs` 挪来（样张生成器与本批的内置配色生成器**共用一处实现**）。
// 口径：只画在**页面底 / 列底**，块面不叠纹理（round84 2h 你拍的）；参数 = 枚举种类 + 定范围数值。
export const rgba = (hexOrRgb, a) => {
  const [r, g, b] = parseColor(hexOrRgb);
  return `rgb(${r} ${g} ${b} / ${a})`;
};
/** 一层（或多层）底纹 → `background-image` 的值（`color` 写 token 名或具体色都可以） */
export function surfaceCss(tokens, s) {
  if (!s) return "none";
  if (Array.isArray(s)) return s.map((x) => surfaceCss(tokens, x)).join(", ");
  const c = tokens[s.color] ?? s.color;
  const line = rgba(c, s.opacity);
  const P = s.period ?? 12;
  const W = s.width ?? 1;
  switch (s.kind) {
    case "grid":
      return `repeating-linear-gradient(0deg, ${line} 0 ${W}px, transparent ${W}px ${P}px), repeating-linear-gradient(90deg, ${line} 0 ${W}px, transparent ${W}px ${P}px)`;
    case "contour":
      return `repeating-radial-gradient(circle at 18% 8%, ${line} 0 ${W}px, transparent ${W}px ${P}px), repeating-radial-gradient(circle at 82% 74%, ${line} 0 ${W}px, transparent ${W}px ${P + 6}px)`;
    case "stripes":
      return `repeating-linear-gradient(${s.angle ?? 45}deg, ${line} 0 ${W}px, transparent ${W}px ${P}px)`;
    case "scanline":
      return `repeating-linear-gradient(0deg, ${line} 0 ${W}px, transparent ${W}px ${P}px)`;
    case "dots": {
      const r = s.radius ?? 1.2;
      return `radial-gradient(circle at 50% 50%, ${line} 0 ${r}px, transparent ${r}px)`;
    }
    case "glow":
      return `radial-gradient(120% 90% at 18% 0%, ${rgba(c, (s.opacity ?? 0.1) * 1.4)} 0%, transparent 62%)`;
    case "rays":
      return `repeating-conic-gradient(from 0deg at 50% 0%, ${line} 0deg ${(s.width ?? 1.5) * 0.8}deg, transparent ${(s.width ?? 1.5) * 0.8}deg ${s.period ?? 9}deg)`;
    default:
      return "none";
  }
}
/** 与 `surfaceCss` 同层的 `background-size`（只有 dots / glow 需要非 auto） */
export const surfaceBgSize = (s) => {
  if (!s) return "auto";
  if (Array.isArray(s)) return s.map((x) => surfaceBgSize(x)).join(", ");
  if (s.kind === "dots") return `${s.period ?? 12}px ${s.period ?? 12}px`;
  if (s.kind === "glow") return "100% 100%";
  return "auto";
};

// ---------------------------------------------------------------- ② 底纹分层（round86 / 0.32.0）
/**
 * **能铺进时间轴列底的只是「细密纹理」**；大尺度背景型（`rays` 放射线 / `glow` 冷光晕）只铺页面。
 *
 * 为什么：列高 = 48 格（实测 1440px）—— 放射线被拉成满列大竖条、光晕被拉成大色块，
 * 观感上抢过内容（你 round85 验收报的「像画在前景」）。而它们在**页面**上尺度正常，
 * 正是你要的「页面外围」效果。
 */
export const COL_SURFACE_KINDS = new Set(["grid", "contour", "scanline", "dots", "stripes"]);
/**
 * **只铺页面**的那些种类（大尺度背景型）。写成**显式枚举**（而不是「不在白名单里就算」）：
 * 生成器会拿它核「种子里出现的每个 kind 都被显式分过类」，加新 kind 时必须先在这里/白名单里表态
 * （否则拒绝写文件）—— 免得一个新 kind 悄悄跑到列底或悄悄消失（6b 复核指出三处列表各自硬编码的漂移风险）。
 */
export const PAGE_ONLY_SURFACE_KINDS = new Set(["rays", "glow"]);
/** 从一份 surface 声明里挑出「能进列底」的层；没过任何一层 → `null`（不写这套的列底令牌） */
export function surfaceForCols(s) {
  if (!s) return null;
  if (Array.isArray(s)) {
    const keep = s.filter((x) => COL_SURFACE_KINDS.has(x.kind));
    return keep.length ? keep : null;
  }
  return COL_SURFACE_KINDS.has(s.kind) ? s : null;
}
