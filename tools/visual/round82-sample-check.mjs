// round82（Step 2）：**样张页自检** —— 把 `docs/visual/round82-*.html` 真的在浏览器里跑一遍。
//
// 为什么值得有：样张是**手写/脚本生成的 HTML**，不出错看不出来（这个仓库已经栽过一次：
// 只靠「文件写出来了」就当交付）。这里量三件事：
//   ① 页面零控制台报错 / 零未捕获异常；
//   ② 关键元素数（迷你预览 16 张、统计面板 5+ 行、键位表 8 行…）；
//   ③ **几何抽查** —— 迷你预览的列宽、并排块宽必须等于按 CSS 常量算出来的真值（±0.5px）。
//
// 用法：node tools/visual/round82-sample-check.mjs
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PAGES = ["docs/visual/round82-样张.html", "docs/visual/round82-托盘候选.html"];
const TYPES = { ".html": "text/html", ".png": "image/png", ".js": "text/javascript" };

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  try {
    const file = await readFile(path.join(repoRoot, decodeURIComponent(url)));
    res.writeHead(200, { "content-type": `${TYPES[path.extname(url)] ?? "application/octet-stream"}; charset=utf-8`, "cache-control": "no-store" });
    res.end(file);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => existsSync(p));
if (!EDGE) {
  console.error("找不到 msedge.exe");
  server.close();
  process.exit(1);
}
const debugPort = 19501;
const child = spawn(
  EDGE,
  ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
   `--user-data-dir=${path.join(os.tmpdir(), "wakeyweeky-sample-check")}`, "--window-size=1400,1000",
   `--remote-debugging-port=${debugPort}`, "about:blank"],
  { stdio: ["ignore", "ignore", "ignore"] },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 120 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page) wsUrl = page.webSocketDebuggerUrl;
  } catch { /* 还没起来 */ }
  if (!wsUrl) await sleep(100);
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
const problems = [];
ws.onmessage = (m) => {
  let msg = null;
  try { msg = JSON.parse(m.data); } catch { return; }
  if (msg.method === "Runtime.exceptionThrown") {
    problems.push("未捕获异常：" + (msg.params?.exceptionDetails?.exception?.description ?? "?"));
  }
  if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params?.type)) {
    problems.push(`console.${msg.params.type}：` + msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};

await send("Runtime.enable");
await send("Page.enable");

const results = [];
for (const page of PAGES) {
  problems.length = 0;
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/${page}` });
  await sleep(1200);
  const probe = await evaluate(`(() => {
    const q = (s) => document.querySelectorAll(s).length;
    const grid = document.querySelector(".mini.frame440 .grid");
    const gridW = grid ? grid.getBoundingClientRect().width : 0;
    const colW = gridW / 7;
    // 第一张 mini 里「并排两块」那档的实际块宽（案 A/B/C 都并排；案 A 不画名字）
    const r = { minis: q(".mini"), blocks: q(".blk"), hasStats: q("#stats-dark *"), kbdRows: q("#kbd-a-dark tbody tr"), trayImgs: q("img.tb"), titles: q("h2") };
    r.gridW = Math.round(gridW * 10) / 10;
    r.colW = Math.round(colW * 100) / 100;
    const widths = [...document.querySelectorAll(".mini.frame440 .blk")].map((b) => b.getBoundingClientRect().width);
    r.minBlockW = widths.length ? Math.round(Math.min(...widths) * 10) / 10 : 0;
    return r;
  })()`);
  results.push({ page, probe, problems: [...problems] });
  console.log(`\n== ${page} ==`);
  console.log("  " + JSON.stringify(probe));
  console.log(problems.length ? "  报错：" + problems.join(" | ") : "  控制台干净 ✓");
}

// 几何断言（真值从页面上**量**出来再对：440 浮窗 → 内容 422 → 迷你卡 border-box 422 → 内层 420 → 网格 = 420 − 38 = 382 → 列宽 54.57 → N=3 块宽 54.57/3 − 4 = 14.19）
const main = results[0].probe;
const checks = [
  ["迷你预览 16 张（440/600 × 亮暗 × 4 案）", main.minis === 16],
  ["迷你网格宽 = 382px", Math.abs(main.gridW - 382) < 0.6],
  ["列宽 = 54.57px", Math.abs(main.colW - 54.57) < 0.05],
  ["最窄的并排块宽 = 14.2px（N=3）", Math.abs(main.minBlockW - 14.19) < 0.6],
  ["统计面板有内容（≥ 30 个节点）", main.hasStats >= 30],
  ["快捷键表 8 行", main.kbdRows === 8],
  ["两个页面共 96 张托盘图标", results[1].probe.trayImgs === 96],
  ["两页零报错", results.every((r) => r.problems.length === 0)],
];
let bad = 0;
console.log("\n== 自检 ==");
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) bad++;
}
console.log(bad ? `\n✗ ${bad} 条不过` : "\n✓ 样张自检全过（ALLOK " + checks.length + "）");

ws.close();
child.kill();
server.close();
process.exit(bad ? 1 : 0);
