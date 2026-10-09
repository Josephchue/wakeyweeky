// round83（3.2 主题包 · Step 3）：**素材库机器扫描** —— 149 张参考图的尺寸 / 主色 / 明度 / 饱和度 / aHash / 近似去重。
//
// 为什么用浏览器：本机没有 PIL / ImageMagick / ffmpeg（`python -c "import PIL"` 失败、`which ffmpeg/magick` 空），
// 而 Edge 的 canvas 本来就能解码 jpg/png —— 与预览 harness 同一套 CDP，**零新依赖**（本仓的既有家底）。
//
// 用法（仓库根跑）：
//   node tools/visual/material-scan.mjs                 # 扫 docs/视觉素材 → 写 docs/素材库/material-scan.json
//   node tools/visual/material-scan.mjs --out x.json    # 换输出
//   node tools/visual/material-scan.mjs --dir 别的目录
// 每张图输出：尺寸 / 字节 / 平均色 / 明度 / 饱和度 / 透明度占比 / k-means 5 色板 / 8×8 aHash。
// 之后在 Node 侧做：特征聚类（k-means，k=6，确定性种子）+ 近似去重（aHash 汉明距离 ≤ 6）。
//
// ⚠️ 边界：`docs/视觉素材/` 是**第三方参考图**（不入库，见 `主题包调研-用户交代.md` §8）；
//    本工具只读它们、只写统计 JSON（不含图片本身）。
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? dflt) : dflt;
};
const dirRel = argOf("--dir", "docs/视觉素材");
const outRel = argOf("--out", "docs/素材库/material-scan.json");
const dirAbs = path.join(repoRoot, dirRel);

const files = (await readdir(dirAbs))
  .filter((f) => /\.(jpe?g|png)$/i.test(f))
  .sort();
if (files.length === 0) {
  console.error(`没有图片：${dirRel}`);
  process.exit(1);
}
const bytesOf = new Map();
for (const f of files) bytesOf.set(f, (await stat(path.join(dirAbs, f))).size);
console.log(`扫描 ${files.length} 张 → ${dirRel}`);

// ---------------------------------------------------------------- 静态服务器（图片 + 载入页）
const TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".html": "text/html" };
const page = `<!doctype html><meta charset="utf-8"><title>material-scan</title>
<body style="margin:0;background:#222;color:#eee;font:12px Consolas,monospace">
<div id="log">loading…</div>
<script>
const FILES = ${JSON.stringify(files)};
window.__RESULTS = [];
window.__DONE = false;
window.__ERR = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 8×8 灰度均值哈希（aHash）：近似去重用它 —— 只判「同一张/极近」 */
function ahash(ctx) {
  const N = 8;
  const d = ctx.getImageData(0, 0, N, N).data;
  const g = [];
  let sum = 0;
  for (let i = 0; i < N * N; i++) {
    const v = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    g.push(v);
    sum += v;
  }
  const avg = sum / g.length;
  let bits = "";
  for (const v of g) bits += v >= avg ? "1" : "0";
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}
/** k-means（k=5）—— 固定种子：按亮度分位取初始中心，结果可复现 */
function kmeans(pixels, k = 5) {
  const pts = pixels.map((p) => [p[0], p[1], p[2], 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]]);
  pts.sort((a, b) => a[3] - b[3]);
  let cent = [];
  for (let i = 0; i < k; i++) {
    const p = pts[Math.floor(((i + 0.5) / k) * (pts.length - 1))];
    cent.push([p[0], p[1], p[2]]);
  }
  let assign = new Array(pts.length).fill(0);
  for (let it = 0; it < 12; it++) {
    for (let i = 0; i < pts.length; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = pts[i][0] - cent[c][0];
        const dg = pts[i][1] - cent[c][1];
        const db = pts[i][2] - cent[c][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      assign[i] = best;
    }
    const sum = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) {
      const c = assign[i];
      sum[c][0] += pts[i][0];
      sum[c][1] += pts[i][1];
      sum[c][2] += pts[i][2];
      sum[c][3]++;
    }
    for (let c = 0; c < k; c++) {
      if (sum[c][3] === 0) continue;
      cent[c] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]];
    }
  }
  const counts = new Array(k).fill(0);
  for (const a of assign) counts[a]++;
  return cent
    .map((c, i) => ({
      rgb: c.map((x) => Math.round(x)),
      share: counts[i] / pts.length,
    }))
    .sort((a, b) => b.share - a.share);
}
const hex6 = ([r, g, b]) => "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");

(async () => {
  for (let idx = 0; idx < FILES.length; idx++) {
    const f = FILES[idx];
    try {
      const img = new Image();
      img.src = "img/" + encodeURIComponent(f);
      await img.decode();
      const W = img.naturalWidth, H = img.naturalHeight;
      // 降采样到 64×64（长截图会被压扁 —— 统计要的是**整幅的色调倾向**，不是局部）
      const c = document.createElement("canvas");
      c.width = 64; c.height = 64;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, 64, 64); // PNG 透明区按白底合成（确定性）
      ctx.drawImage(img, 0, 0, 64, 64);
      const d = ctx.getImageData(0, 0, 64, 64).data;
      const px = [];
      let sr = 0, sg = 0, sb = 0, bright = 0, sat = 0, n = 0;
      for (let i = 0; i < 64 * 64; i++) {
        const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
        px.push([r, g, b]);
        sr += r; sg += g; sb += b;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        bright += (mx + mn) / 2 / 255;
        sat += mx === 0 ? 0 : (mx - mn) / mx;
        n++;
      }
      // 8×8 哈希：另外画一次（避免和 64×64 的采样混用）
      const c2 = document.createElement("canvas");
      c2.width = 8; c2.height = 8;
      const ctx2 = c2.getContext("2d", { willReadFrequently: true });
      ctx2.fillStyle = "#ffffff";
      ctx2.fillRect(0, 0, 8, 8);
      ctx2.drawImage(img, 0, 0, 8, 8);
      // 黑边/内容带：逐行（逐列）平均亮度 < 0.08 视为「黑」—— B 站截图的黑边与弹幕带都算进来，
      // 这是本批素材的**主要污染项**（89 张是 2800×2000 的视频截图，上下有黑边 + 顶部弹幕）。
      const lumOf = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const rowLum = [];
      for (let y = 0; y < 64; y++) {
        let s2 = 0;
        for (let x = 0; x < 64; x++) {
          const i = (y * 64 + x) * 4;
          s2 += lumOf(d[i], d[i + 1], d[i + 2]);
        }
        rowLum.push(s2 / 64);
      }
      const colLum = [];
      for (let x = 0; x < 64; x++) {
        let s2 = 0;
        for (let y = 0; y < 64; y++) {
          const i = (y * 64 + x) * 4;
          s2 += lumOf(d[i], d[i + 1], d[i + 2]);
        }
        colLum.push(s2 / 64);
      }
      const dark = (v) => v < 0.08;
      let top = 0, bottom = 0, left = 0, right = 0;
      while (top < 64 && dark(rowLum[top])) top++;
      while (bottom < 64 && dark(rowLum[63 - bottom])) bottom++;
      while (left < 64 && dark(colLum[left])) left++;
      while (right < 64 && dark(colLum[63 - right])) right++;
      const bars = {
        top: Math.round((top / 64) * 1000) / 1000,
        bottom: Math.round((bottom / 64) * 1000) / 1000,
        left: Math.round((left / 64) * 1000) / 1000,
        right: Math.round((right / 64) * 1000) / 1000,
      };
      const contentRatio = Math.round((1 - (bars.top + bars.bottom)) * 1000) / 1000;
      const pal = kmeans(px, 5);
      window.__RESULTS.push({
        file: f,
        w: W, h: H,
        aspect: Math.round((W / H) * 1000) / 1000,
        avg: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)],
        brightness: Math.round((bright / n) * 1000) / 1000,
        saturation: Math.round((sat / n) * 1000) / 1000,
        bars,
        contentRatio,
        palette: pal.map((p) => ({ hex: hex6(p.rgb), rgb: p.rgb, share: Math.round(p.share * 1000) / 1000 })),
        hash: ahash(ctx2),
      });
      img.src = ""; // 让浏览器尽快回收
    } catch (e) {
      window.__RESULTS.push({ file: f, error: String(e && e.message ? e.message : e) });
    }
    document.getElementById("log").textContent = (idx + 1) + "/" + FILES.length + " " + f;
  }
  window.__DONE = true;
})().catch((e) => { window.__ERR = String(e); window.__DONE = true; });
</script>`;
const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  try {
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page);
      return;
    }
    if (url.startsWith("/img/")) {
      const name = decodeURIComponent(url.slice("/img/".length));
      if (!files.includes(name)) {
        res.writeHead(404).end("nope");
        return;
      }
      const buf = await readFile(path.join(dirAbs, name));
      res.writeHead(200, { "content-type": TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream" });
      res.end(buf);
      return;
    }
    res.writeHead(404).end("not found");
  } catch {
    res.writeHead(500).end("err");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
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
const profile = path.join(os.tmpdir(), "ww-material-scan-profile");
const child = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=19555`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 100 && !wsUrl; i++) {
  try {
    const list = await (await fetch("http://127.0.0.1:19555/json/list")).json();
    wsUrl = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? null;
  } catch {}
  await sleep(150);
}
if (!wsUrl) {
  console.error("连不上 Edge 的调试端口");
  child.kill();
  server.close();
  process.exit(1);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  let msg;
  try {
    msg = JSON.parse(m.data);
  } catch {
    return; // 非 JSON 帧（心跳之类）→ 忽略
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) =>
  (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send("Page.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });

let results = [];
for (let i = 0; i < 1200; i++) {
  const done = await evaluate("window.__DONE === true").catch(() => false);
  const n = (await evaluate("(window.__RESULTS || []).length").catch(() => 0)) ?? 0;
  if (i % 10 === 0) process.stdout.write(`\r  进度 ${n}/${files.length}`);
  if (done) break;
  results = (await evaluate("JSON.stringify(window.__RESULTS || [])").catch(() => null)) ?? null;
  void results;
  await sleep(500);
}
const raw = await evaluate("JSON.stringify(window.__RESULTS || [])").catch(() => null);
ws.close();
child.kill();
server.close();
if (!raw) {
  console.error("\n拿不到结果");
  process.exit(1);
}
let items;
try {
  items = JSON.parse(raw);
} catch (e) {
  console.error("结果不是合法 JSON：" + e.message);
  process.exit(1);
}
for (const it of items) it.bytes = bytesOf.get(it.file) ?? 0;
console.log(`\n扫完 ${items.length} 张`);

// ---------------------------------------------------------------- 特征聚类（k-means，k=6，确定性种子）
const feats = items
  .filter((i) => !i.error)
  .map((i) => {
    const f = [
      i.avg[0] / 255,
      i.avg[1] / 255,
      i.avg[2] / 255,
      i.brightness,
      i.saturation,
      Math.min(1, Math.log10(Math.max(1, i.aspect) * 10) / 2), // 长截图 → 偏 1
    ];
    return { file: i.file, f };
  });
const K = 6;
const byBright = [...feats].sort((a, b) => a.f[3] - b.f[3]);
let cent = Array.from({ length: K }, (_, i) => byBright[Math.floor(((i + 0.5) / K) * (byBright.length - 1))].f.slice());
let assign = new Array(feats.length).fill(0);
for (let it = 0; it < 30; it++) {
  feats.forEach((p, i) => {
    let best = 0;
    let bd = Infinity;
    cent.forEach((c, ci) => {
      const d = c.reduce((s, x, k) => s + (x - p.f[k]) ** 2, 0);
      if (d < bd) {
        bd = d;
        best = ci;
      }
    });
    assign[i] = best;
  });
  const sum = Array.from({ length: K }, () => new Array(6).fill(0));
  const cnt = new Array(K).fill(0);
  feats.forEach((p, i) => {
    const c = assign[i];
    p.f.forEach((x, k) => (sum[c][k] += x));
    cnt[c]++;
  });
  cent = cent.map((c, ci) => (cnt[ci] ? sum[ci].map((x) => x / cnt[ci]) : c));
}
const clusters = Array.from({ length: K }, (_, ci) => {
  const members = feats.filter((_, i) => assign[i] === ci).map((p) => p.file);
  const c = cent[ci];
  return {
    id: ci,
    n: members.length,
    avgHex: "#" + [c[0], c[1], c[2]].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join(""),
    brightness: Math.round(c[3] * 1000) / 1000,
    saturation: Math.round(c[4] * 1000) / 1000,
    aspect: Math.round(Math.pow(10, c[5] * 2 - 1) * 100) / 100,
    files: members,
  };
}).sort((a, b) => b.n - a.n);

// ---------------------------------------------------------------- 近似去重（aHash 汉明距离 ≤ 6）
const popcount = (x) => {
  let n = 0;
  while (x) {
    x &= x - 1;
    n++;
  }
  return n;
};
const hamming = (a, b) => {
  if (!a || !b || a.length !== b.length) return 99;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += popcount(parseInt(a[i], 16) ^ parseInt(b[i], 16));
  return d;
};
const dupes = [];
const hashed = items.filter((i) => i.hash);
for (let i = 0; i < hashed.length; i++) {
  for (let j = i + 1; j < hashed.length; j++) {
    const d = hamming(hashed[i].hash, hashed[j].hash);
    if (d <= 6) dupes.push([hashed[i].file, hashed[j].file, d]);
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  dir: dirRel,
  count: items.length,
  errors: items.filter((i) => i.error).length,
  clusters,
  dupes,
  items: items.map((i) => ({
    file: i.file,
    w: i.w,
    h: i.h,
    aspect: i.aspect,
    bytes: i.bytes,
    avg: i.avg,
    avgHex: i.avg ? "#" + i.avg.map((x) => x.toString(16).padStart(2, "0")).join("") : null,
    brightness: i.brightness,
    saturation: i.saturation,
    bars: i.bars,
    contentRatio: i.contentRatio,
    palette: i.palette,
    hash: i.hash,
    error: i.error,
  })),
};
const outAbs = path.join(repoRoot, outRel);
await writeFile(outAbs, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`写出 ${outRel}`);
for (const c of clusters) {
  console.log(`  簇${c.id} n=${c.n} 平均色调=${c.avgHex} 明度=${c.brightness} 饱和=${c.saturation} 长宽比≈${c.aspect}`);
}
console.log(`近似对（aHash ≤6）：${dupes.length} 对`);
