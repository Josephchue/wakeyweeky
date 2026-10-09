// round82 Step 2 · C4 真机探针：用**便携模式**起一份真 WebView2（数据落临时目录，绝不碰真库），
// 再用 CDP 注入键盘事件，记录**页面到底收到了哪些组合键**。
//
// 诚实的边界：CDP 注入的键不一定走系统的「浏览器加速键」拦截路径 → 它只能证明「页面收得到 / 收不到」。
// 浏览器加速键（F5 / Ctrl+R / F12 / Ctrl+P / Ctrl+± …）的真实拦截在 Step 7 录键器里复核。
import { spawn } from "node:child_process";
import { mkdirSync, copyFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.tmpdir(), "ww-c4");
const EXE_SRC = process.argv[2] ?? "src-tauri/target/release/wakeyweeky.exe";
if (!existsSync(EXE_SRC)) {
  console.error("没有 release exe：先 `npm run tauri build`（或给个路径）");
  process.exit(2);
}
mkdirSync(DIR, { recursive: true });
copyFileSync(EXE_SRC, path.join(DIR, "wakeyweeky.exe"));
writeFileSync(path.join(DIR, "portable.flag"), "");
console.log("便携目录：", DIR, "（数据会落在", path.join(DIR, "data"), "）");

const PORT = 9333;
const app = spawn(path.join(DIR, "wakeyweeky.exe"), [], {
  cwd: DIR,
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", "pipe", "pipe"],
});
app.stdout.on("data", (d) => process.stdout.write("[app] " + d));
app.stderr.on("data", (d) => process.stderr.write("[app] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  return null;
}
const wsUrl = await target();
if (!wsUrl) {
  console.error("CDP 没起来（WebView2 没开调试端口）→ 记进文档，走 Step 7");
  app.kill();
  process.exit(3);
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
    return;
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
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

await send("Runtime.enable");
await send("Page.enable");
// 关键：CDP 注入的键只交给**聚焦**的页面 —— 不 bringToFront 的话全部丢在地上（第一次跑就栽在这）
await send("Page.bringToFront");
await sleep(400);
const focused = await evaluate("document.hasFocus()");
console.log("页面是否聚焦：", focused);
// 注：这个页面（`http://tauri.localhost/`）不允许 `sessionStorage` → 用「`__c4` 还在不在」判重载
await evaluate(`
  window.__c4 = { seen: [] };
  window.addEventListener('keydown', (e) => {
    window.__c4.seen.push([e.key, e.ctrlKey, e.shiftKey, e.altKey, e.metaKey, e.defaultPrevented]);
  }, true);
  'ok'
`);

/** [说明, key, code, vk, modifiers] —— modifiers 位图：Alt=1 Ctrl=2 Meta=4 Shift=8 */
const KEYS = [
  ["F5", "F5", "F5", 116, 0],
  ["F12", "F12", "F12", 123, 0],
  ["Ctrl+R", "r", "KeyR", 82, 2],
  ["Ctrl+P", "p", "KeyP", 80, 2],
  ["Ctrl+F", "f", "KeyF", 70, 2],
  ["Ctrl+加号", "+", "Equal", 187, 2],
  ["Ctrl+0", "0", "Digit0", 48, 2],
  ["Ctrl+Shift+I", "I", "KeyI", 73, 10],
  ["Alt+F4", "F4", "F4", 115, 1],
  ["Alt+Tab", "Tab", "Tab", 9, 1],
  ["Ctrl+Shift+Esc", "Escape", "Escape", 27, 10],
  ["PrintScreen", "PrintScreen", "PrintScreen", 44, 0],
  ["Ctrl+A", "a", "KeyA", 65, 2],
  ["Ctrl+Z", "z", "KeyZ", 90, 2],
  ["Ctrl+X", "x", "KeyX", 88, 2],
  ["Ctrl+Shift+Z", "Z", "KeyZ", 90, 10],
  ["Ctrl+,", ",", "Comma", 188, 2],
  ["T", "t", "KeyT", 84, 0],
  ["?", "?", "Slash", 191, 8],
];
const rows = [];
try {
  for (const [label, key, code, vk, mods] of KEYS) {
    // 每个键前**重装**监听（上一个键可能把页面重载掉，监听随之消失 —— 第一次跑就栽在这）
    await evaluate("window.__c4 = { seen: [] }; window.__t0 = performance.timeOrigin; 'ok'");
    // 只在真丢了焦点时（比如刚被 F5 重载过）才把窗口抢回前台 —— 少数几次，别一直抢
    if (!(await evaluate("document.hasFocus()"))) {
      await send("Page.bringToFront");
      await sleep(250);
    }
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      modifiers: mods,
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: mods,
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
    await sleep(250);
    const res = await evaluate(
      "({ seen: (window.__c4 ? window.__c4.seen : null), t0: (window.__t0 || 0), now: performance.timeOrigin })",
    );
    const reloaded = res.seen === null || res.now !== res.t0;
    const got = !reloaded && res.seen.length > 0;
    rows.push({ label, got, reloaded, seen: res.seen ?? [] });
    console.log(
      `  ${label.padEnd(14)} 页面收到=${got ? "是" : "否"}${reloaded ? " （页面被这个键重载了）" : ""}${
        got ? "  " + JSON.stringify(res.seen) : ""
      }`,
    );
  }
  console.log("\n汇总：", JSON.stringify(rows.map((r) => [r.label, r.got, r.reloaded])));
} finally {
  ws.close();
  app.kill();
  await sleep(800);
  try {
    rmSync(DIR, { recursive: true, force: true });
    console.log("已清理临时目录（含便携库）", DIR);
  } catch (e) {
    console.log("临时目录留在", DIR, "（清理失败：", e.message, "）");
  }
}
