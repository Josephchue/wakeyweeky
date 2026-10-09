// round76（3.1a）：**视觉底座的第二把尺子 —— 对比度实测（270 对）**。
//
// 来历：round75 的《深色模式与WebView2实测》§4 给了一套 WCAG 口径与 45 对检查表，
// 当时的脚本是一次性的（`ww75-contrast.mjs`）。这次落进仓库、进闸门。
//
// 做法：**不解析 CSS 文本** —— 起一个静态服务器 + Edge（headless），在真浏览器里
//   ① 用 `Emulation.setEmulatedMedia` 固定亮/暗；② 给 `<html data-palette="…">` 换配色；
//   ③ 把每个 token 塞进一个隐藏元素的 `color` 里，让浏览器**算出**最终颜色（`var()` / `color-mix()` 都会解开）。
// 这样「脚本读到的值」与「界面真正用的值」永远一致（round76 plan §4.11：浏览器算的才是真的）。
//
// 用法（仓库根跑；需先 `npm run build`）：
//   node tools/visual/contrast.mjs            # 打印 6 组（3 配色 × 亮/暗）的实测表
//   node tools/visual/contrast.mjs --quiet    # 只打印结论行（闸门用）
//   任一达标线不过 → 退出码 1。
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distDir = path.join(repoRoot, "dist");
const quiet = process.argv.includes("--quiet");
if (!existsSync(path.join(distDir, "index.html"))) {
  console.error("没有 dist/index.html —— 先跑 `npm run build`");
  process.exit(1);
}

// ---------------------------------------------------------------- WCAG 2.x 相对亮度
const hex = (h) => {
  const s = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
};
// `hex()` 保留 0–1（给别的用途）；`parseColor()` 统一往外给 **0–255** ✓（与 `lum` 的口径对齐）
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** ⚠️ 入参必须是 **0–255** 的通道值（`parseColor` 统一成这个量纲）——
 *  round76 自查抓到的假绿：以前这里直接 `lin(c)`（把 0–255 当 0–1 算）→ 比值全部虚高（实测 106:1）。 */
const lum = (rgb) => {
  const [r, g, b] = rgb.map((c) => lin(c / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** `rgb(r, g, b)` / `rgba(...)` / `#rrggbb` → [r, g, b]（0–255） */
function parseColor(value) {
  const v = String(value).trim();
  if (v.startsWith("#")) return hex(v).map((x) => Math.round(x * 255));
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return parts.slice(0, 3);
  }
  const cm = v.match(/color\(srgb\s+([^)]+)\)/);
  if (cm) {
    return cm[1]
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((x) => Math.round(Number(x) * 255));
  }
  return null;
}
const ratio = (fg, bg) => {
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};
/** 带 alpha 的解析（淡化带 / 网格线这类半透明 token 要合成后再量） */
function parseColorA(value) {
  const v = String(value).trim();
  const rgba = v.match(/rgba?\(([^)]+)\)/);
  if (rgba) {
    const parts = rgba[1].split(/[,\s/]+/).filter(Boolean);
    const nums = parts.map((x) => (x.endsWith("%") ? parseFloat(x) / 100 : Number(x)));
    const a = nums.length >= 4 ? nums[3] : 1;
    return { rgb: nums.slice(0, 3).map((x) => Math.min(255, x)), a };
  }
  const c = parseColor(v);
  return c ? { rgb: c, a: 1 } : null;
}
/** `fg` 叠在 `bg` 上的合成色（sRGB 简单混合；两色都已不透明时直接取 fg） */
const over = (fg, bg) =>
  !fg || !bg
    ? null
    : {
        rgb: fg.rgb.map((c, i) => Math.round(c * fg.a + bg.rgb[i] * (1 - fg.a))),
        a: 1,
      };
/** CIE L*（大面积「看不看得出」用它比对比度靠谱：JND ≈ 1–2） */
const lStar = (rgb) => {
  const [r, g, b] = rgb.map((c) => lin(c / 255));
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t) / 116 + 16 / 116);
  return 116 * f(y) - 16;
};
/** 全黑 = 样式表还没落地（token 没定义时 `color` 回落成初始值） */
const isBlack = (value) => {
  const c = parseColor(String(value));
  return !!c && c.every((x) => x === 0);
};

// ---------------------------------------------------------------- 45 对（对照图 §2 口径）+ round76 新增 2 对 + 现在线 4 对 = 51 对
// round86（0.32.0）加 1 对（装饰强调色）→ **52 对**；本表与 `tools/visual/lib/theme-tokens.mjs` 的
// `PAIRS` **必须逐行同表**（那边头注声称有自检，实际没有 —— 改表时两处一起改）。
/** [说明, 前景 token, 背景 token, 达标线] */
const PAIRS = [
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
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(
    (i) => [`类别色 #${i} / 卡`, `--cat-${i}`, "--card", 3],
  ),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(
    (i) => [`类别色 #${i} / 计划中底`, `--cat-${i}`, "--block-fill-planned", 3],
  ),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(
    (i) => [`类别色 #${i} / 完成底`, `--cat-${i}`, "--block-fill-done", 3],
  ),
  // ---- round76 新增 token 的对（round77 删掉了「中性层条」3 对：
  //      关掉层条上色后那条**不可见**（transparent），没有可测的前景与背景。对表回到 51 对 = 45 + 2 + 4；
  //      round86（0.32.0 · ①）再加「装饰强调色 / 卡」1 对 → **52 对**）----
  ["强调底上的字 / 强调色", "--on-accent", "--accent", 4.5],
  ["金章 / 卡", "--medal", "--card", 3],
  // ---- round76 6b 复核补的 4 对：现在线压在块上（它是「现在」位置的唯一信号，按图形档 ≥3）----
  ["现在线 / 底", "--now-line", "--bg", 3],
  ["现在线 / 计划中底", "--now-line", "--block-fill-planned", 3],
  ["现在线 / 完成底", "--now-line", "--block-fill-done", 3],
  ["现在线 / 未完成底", "--now-line", "--block-fill-missed", 3],
];

const ALL_TOKENS = [
  ...new Set([
    ...PAIRS.flatMap(([, fg, bg]) => [fg, bg]),
    // round82（淡-08）：淡化带场景要用的两个 token —— 它们不在对齐表里（是半透明的「层」）
    "--dim-band",
    "--grid-line",
  ]),
];

// ---------------------------------------------------------------- 静态服务器（只服务 dist）
const TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const rel = url === "/" ? "/index.html" : url;
  try {
    const file = await readFile(path.join(distDir, rel));
    res.writeHead(200, {
      "content-type": `${TYPES[path.extname(rel)] ?? "application/octet-stream"}; charset=utf-8`,
      "cache-control": "no-store",
    });
    res.end(file);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// ---------------------------------------------------------------- Edge + 极简 CDP
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) {
  console.error("找不到 msedge.exe");
  server.close();
  process.exit(1);
}
const workDir = path.join(os.tmpdir(), "wakeyweeky-contrast");
const profile = path.join(workDir, "edge-profile");
let debugPort = 0;
for (const candidate of [19401, 19413, 19427]) {
  try {
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(candidate, "127.0.0.1", resolve);
    });
    await new Promise((resolve) => probe.close(resolve));
    debugPort = candidate;
    break;
  } catch {
    /* 换一个 */
  }
}
if (!debugPort) {
  console.error("找不到可用的调试端口");
  server.close();
  process.exit(1);
}
const child = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--window-size=1200,800",
    `--remote-debugging-port=${debugPort}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "ignore"] },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wsUrl = await (async () => {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  return null;
})();
if (!wsUrl) {
  console.error("连不上 Edge 的调试端口");
  child.kill();
  server.close();
  process.exit(1);
}

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return; // 不是 JSON 的帧（CDP 偶尔会夹带心跳/空帧）—— 丢掉就好，别把闸门搞崩
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error.message));
  else p.resolve(msg.result);
};
const send = (method, params) => {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
};
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true });
  return r?.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
const nav = await send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html` });
if (nav?.errorText) {
  console.error(`导航失败：${nav.errorText}（${port}）`);
  child.kill();
  server.close();
  process.exit(1);
}
await sleep(1200); // 等 CSS 落地（token 读不到会重试，见下）

/** 把一批 token **算成**具体颜色（塞进隐藏元素的 `color`，让浏览器解开 var()/color-mix()） */
const readTokens = () =>
  evaluate(`(() => {
    const probe = document.createElement("div");
    probe.style.position = "absolute";
    probe.style.opacity = "0";
    document.body.appendChild(probe);
    const out = {};
    for (const name of ${JSON.stringify(ALL_TOKENS)}) {
      probe.style.color = "";
      probe.style.color = "var(" + name + ")";
      out[name] = getComputedStyle(probe).color;
    }
    probe.remove();
    return out;
  })()`);

const repoRoot0 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/**
 * round85（0.31.0）：配色表**从 `appearance.ts` 读**（一处真源）—— 以前硬编码三套，
 * 12 套后手抄必错。拿到几个就核几个（读不到就报错，不静默跑少）。
 */
const PALETTE_IDS = (() => {
  const ts = readFileSync(path.join(repoRoot0, "src/lib/utils/appearance.ts"), "utf8");
  const block = ts.match(/export const PALETTES = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
  return [...block.matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
})();
if (PALETTE_IDS.length !== 12) {
  console.error(`读 appearance.ts 的 PALETTES 失败（拿到 ${PALETTE_IDS.length} 个）`);
  process.exit(1);
}

const groups = [];
for (const palette of PALETTE_IDS) {
  for (const theme of ["light", "dark"]) {
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    await evaluate(`document.documentElement.dataset.palette = ${JSON.stringify(palette)}`);
    await sleep(60);
    let tokens = await readTokens();
    // 页面刚起时可能还没拿到样式（token 解不出来 / 全黑 = 样式表没落地）—— 最多重试 20 次（每次 150ms）
    for (let i = 0; i < 20 && (!tokens || parseColor(tokens["--bg"] ?? "") === null || isBlack(tokens["--bg"])); i++) {
      await sleep(150);
      tokens = await readTokens();
    }
    if (!tokens || parseColor(tokens["--bg"] ?? "") === null || isBlack(tokens["--bg"])) {
      console.error(
        `读不到 token（${palette}/${theme}）：底=${tokens?.["--bg"]} ｜ ${await evaluate(
          `location.href + " ｜ 样式表=" + document.styleSheets.length + " ｜ link=" + (document.querySelector('link[rel=stylesheet]')?.getAttribute('href') ?? "无")`,
        ).catch(() => "诊断也读不到")}`,
      );
      child.kill();
      server.close();
      process.exit(1);
    }
    groups.push({ palette, theme, tokens });
  }
}

// ---------------------------------------------------------------- 算表 + 判据
const failures = [];
const table = [];
const dimTable = [];
let totalPairs = 0;
for (const g of groups) {
  const rows = [];
  for (const [label, fgName, bgName, min] of PAIRS) {
    const fg = parseColor(g.tokens[fgName]);
    const bg = parseColor(g.tokens[bgName]);
    if (!fg || !bg) {
      failures.push(`${g.palette}/${g.theme} ${label}：颜色解不开（${g.tokens[fgName]} / ${g.tokens[bgName]}）`);
      continue;
    }
    const r = ratio(fg, bg);
    const ok = r >= min;
    totalPairs += 1;
    if (!ok) failures.push(`${g.palette}/${g.theme} ${label}：${r.toFixed(2)} < ${min}`);
    rows.push({ label, fg: fgName, bg: bgName, r: Math.round(r * 100) / 100, min, ok });
  }
  table.push({ palette: g.palette, theme: g.theme, rows });
  // ---- round82（3.1c₂ · 淡-08）：夜间淡化带的新场景（6 组 = 3 配色 × 亮/暗）----
  // 带是**半透明**（亮 8% 黑 / 暗 20% 黑）→ 先把带合成到底色上，再量四条不变量：
  //   ① 带要看得见（ΔL* ≥ 2）—— 对比度对半透明块不适用，用 L*（JND ≈1–2）
  //   ② 块在带之上仍更跳（≥1.05）③ 网格线仍看得见（≥1.10）④ 带内若放了次要文字也得及格（≥4.5，兜底）
  const base = parseColorA(g.tokens["--bg"]);
  const band = over(parseColorA(g.tokens["--dim-band"]), base);
  const dimRows = [
    {
      label: "淡化带 / 底（ΔL*）",
      value: base && band ? Math.abs(lStar(band.rgb) - lStar(base.rgb)) : NaN,
      min: 2,
      isDelta: true,
    },
    {
      label: "块底 / 淡化带",
      // 块底是**不透明**的（块永远在带之上）→ 直接量它与带背景的对比度（研究 §4 的 1.09–1.51）
      value: ratio(parseColor(g.tokens["--block-fill-planned"]), band?.rgb ?? [0, 0, 0]),
      min: 1.05,
    },
    {
      label: "网格线 / 淡化带",
      value: ratio(
        (over(parseColorA(g.tokens["--grid-line"]), band) ?? {}).rgb ?? [0, 0, 0],
        band?.rgb ?? [0, 0, 0],
      ),
      min: 1.1,
    },
    {
      label: "次要文字 / 淡化带",
      value: ratio(parseColor(g.tokens["--text-secondary"]), band?.rgb ?? [0, 0, 0]),
      min: 4.5,
    },
  ];
  for (const r of dimRows) {
    const ok = Number.isFinite(r.value) && r.value >= r.min;
    r.ok = ok;
    totalPairs += 1;
    if (!ok) {
      failures.push(
        `${g.palette}/${g.theme}（淡化带）${r.label}：${Number.isFinite(r.value) ? r.value.toFixed(2) : "解不开" } < ${r.min}`,
      );
    }
  }
  dimTable.push({ palette: g.palette, theme: g.theme, rows: dimRows });
  if (!quiet) {
    console.log(`\n=== ${g.palette} · ${g.theme}（${rows.filter((x) => x.ok).length}/${rows.length} 达标）===`);
    // 抽三个 token 写出来：颜色解不开时一眼能看出「是不是根本没读上」
    console.log(
      `  token 抽样：底=${g.tokens["--bg"]} 卡=${g.tokens["--card"]} 计划中底=${g.tokens["--block-fill-planned"]} 类别①=${g.tokens["--cat-1"]}`,
    );
    for (const r of rows) {
      console.log(`  ${r.ok ? "✓" : "✗"} ${r.label.padEnd(34, " ")} ${r.r.toFixed(2)}（要求 ≥${r.min}）`);
    }
  } else {
    const bad = rows.filter((x) => !x.ok).length;
    console.log(`${g.palette} · ${g.theme}：${rows.length - bad}/${rows.length} 达标`);
  }
}

ws.close();
child.kill();
server.close();

if (!quiet) {
  console.log(`\n=== 夜间淡化带（round82 · 淡-08：亮 8% / 暗 20% 黑）===`);
  for (const d of dimTable) {
    console.log(
      `  ${d.palette} · ${d.theme}：` +
        d.rows
          .map((r) => `${r.ok ? "✓" : "✗"} ${r.label}=${Number.isFinite(r.value) ? r.value.toFixed(2) : "?"}（≥${r.min}）`)
          .join("  "),
    );
  }
}

console.log(
  `\n对比度：${groups.length} 组 × ${PAIRS.length} 对 + 淡化带 ${dimTable.length} 组 × ${dimTable[0]?.rows.length ?? 0} 条 = ${totalPairs} 项，失败 ${failures.length} 项`,
);
for (const f of failures) console.log(`  ✗ ${f}`);
// `--json <文件>`：把实测表写出去（组件展示页 / 验收文档引用它；不指定就不写）
const jsonArg = process.argv.indexOf("--json");
if (jsonArg >= 0 && process.argv[jsonArg + 1]) {
  const outFile = path.resolve(repoRoot, process.argv[jsonArg + 1]);
  await writeFile(
    outFile,
    JSON.stringify(
      {
        note: "round86（0.32.0）对比度实测：12 组（12 配色 × 亮/暗，表从 appearance.ts 读）× 52 对（对照图 45 对 + round76 新增 2 对 + 现在线 4 对；关掉层条上色时那条不可见，故删去原来 3 对中性层条）+ round82（3.1c₂ · 淡-08）淡化带 12 组 × 4 条（半透明带用合成色：ΔL* / 块底 / 网格线 / 次要文字）",
        pairs: PAIRS.length,
        dimRows: dimTable[0]?.rows.length ?? 0,
        totalPairs,
        failed: failures.length,
        failures,
        groups: table,
        dim: dimTable,
      },
      null,
      1,
    ),
  );
  console.log(`实测表已写：${path.relative(repoRoot, outFile)}`);
}
if (failures.length) process.exit(1);
