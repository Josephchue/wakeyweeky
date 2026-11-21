// round94（#15）· **真库副本 e2e**：外部程序直接写 SQLite → App 该在 ≤3 秒内把块显示出来。
//
// 为什么要有它：预览里的那条断言用的是假后端（`window.__DATA_VERSION += 1`）—— 它能证「前端逻辑对」，
// 但证不了「真的 `PRAGMA data_version` + 真的 WebView2 + 真的库文件」。这个脚本跑的是**真 exe**，
// 库用的是**真库的只读副本**（连同 `-wal` / `-shm` 一起拷），外部写入用 Node 内置 `node:sqlite` 开第二个连接。
//
// 用法（仓库根跑）：
//   node tools/preview/external-write-e2e.mjs --exe src-tauri/target/release/wakeyweeky.exe --expect fail
//   node tools/preview/external-write-e2e.mjs --exe src-tauri/target/debug/wakeyweeky.exe   --expect pass
//
//   --expect fail = 修前的旧版本（1.0.3 真产物）：**应该看不见**新块（这就是「红」）
//   --expect pass = 本批构建：新块 ≤3 秒出现 + 一条「外部改动」提示
//
// 安全边界（都是硬规矩）：
// - **绝不碰真库**：只读副本，跑完再比一次 `size + sha256`（sqlite / -wal / -shm），必须一点没变；
// - 启动前要求**没有 wakeyweeky.exe 在跑**（单实例插件会把新进程吞给已经在跑的那个 → 那就拿真库跑了）；
// - 只删自己这次建的临时目录里的**逐个明确路径**（不递归删）。
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const exeArg = arg("--exe");
const expect = arg("--expect", "pass"); // pass | fail
const port = Number(arg("--port", "9423"));
const timeoutMs = Number(arg("--timeout", "6000"));

if (!exeArg) {
  console.error("✗ 缺 --exe <wakeyweeky.exe>（1.0.3 真产物 或 本批 debug 构建）");
  process.exit(2);
}
const EXE = path.resolve(REPO, exeArg);
if (!existsSync(EXE)) {
  console.error(`✗ 找不到 exe：${EXE}`);
  process.exit(2);
}
if (!["pass", "fail"].includes(expect)) {
  console.error("✗ --expect 只认 pass / fail");
  process.exit(2);
}

const APPDATA = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
const REAL_DIR = path.join(APPDATA, "com.wakeyweeky.app");
const REAL_DB = path.join(REAL_DIR, "wakeyweeky.sqlite");
const REAL_SIDE = ["-wal", "-shm"].map((s) => REAL_DB + s);
/** `-shm` = WAL 的共享内存索引：**任何连接以 WAL 打开真库都会重写它**（维护 §四已记）——
 *  所以它不进 sha256 判据，只报告；`wakeyweeky.sqlite` 与 `-wal` 必须**逐字节**不变。 */
const SHM = REAL_DB + "-shm";
const STRICT_SIDE = ["-wal"].map((s) => REAL_DB + s);
const realFiles = [REAL_DB, ...REAL_SIDE].filter((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const snapshot = (files) =>
  Object.fromEntries(
    files.map((p) => [path.basename(p), `${statSync(p).size}|${sha256(p)}`]),
  );

const results = [];
const check = (ok, name, detail) => {
  results.push({ ok, name, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` —— ${detail}` : ""}`);
};

// ---------------------------------------------------------------- 0 前置：单实例 / 真库存在

if (!existsSync(REAL_DB)) {
  console.error(`✗ 真库不存在：${REAL_DB}（这台机器还没跑过 WakeyWeeky？）`);
  process.exit(2);
}
let running = "";
try {
  running = execFileSync("tasklist", ["/fi", "imagename eq wakeyweeky.exe"], { encoding: "utf8" });
} catch {
  running = "";
}
const runningHit = running
  .split(/\r?\n/)
  .some((l) => l.trim().toLowerCase().startsWith("wakeyweeky.exe"));
if (runningHit) {
  console.error(
    "✗ 有 wakeyweeky.exe 在跑 —— 先关掉它再跑本脚本。\n" +
      "  为什么：单实例插件会把新实例的启动吞给已在跑的那个 → 那就变成拿**真库**在跑（绝对不行）。",
  );
  process.exit(2);
}
check(true, "⓪ 没有 wakeyweeky.exe 在跑 / 真库位置可用", REAL_DB);

// ---------------------------------------------------------------- 1 只读副本 + 便携目录

const RUN = path.join(os.tmpdir(), "ww94-e2e", "run");
const DATA = path.join(RUN, "data");
mkdirSync(DATA, { recursive: true });
const realBefore = snapshot(realFiles);
copyFileSync(EXE, path.join(RUN, "wakeyweeky.exe"));
writeFileSync(path.join(RUN, "portable.flag"), "", "utf8");
const RUN_DB = path.join(DATA, "wakeyweeky.sqlite");
for (const f of realFiles) copyFileSync(f, path.join(DATA, path.basename(f)));
check(
  realFiles.length >= 1 && existsSync(RUN_DB),
  "① 真库只读副本已就位（含 -wal / -shm 有几份拷几份）",
  `源 ${realFiles.map((p) => path.basename(p)).join(" + ")}`,
);

// ---------------------------------------------------------------- 2 启动真 exe + CDP

const app = spawn(path.join(RUN, "wakeyweeky.exe"), [], {
  cwd: RUN,
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  stdio: ["ignore", "pipe", "pipe"],
});
const logs = [];
const grab = (d) => {
  const s = String(d);
  logs.push(s);
  process.stderr.write(`[app] ${s}`);
};
app.stdout.on("data", grab);
app.stderr.on("data", grab);

const killApp = async () => {
  try {
    app.kill();
  } catch {}
  await sleep(600);
};

async function pageWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  return null;
}

const wsUrl = await pageWs();
if (!wsUrl) {
  console.error("✗ CDP 没起来（WebView2 没开调试端口）");
  await killApp();
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
await send("Runtime.enable");

let ready = false;
for (let i = 0; i < 100 && !ready; i++) {
  ready = await evaluate(`!!document.querySelector(".week-nav")`).catch(() => false);
  if (!ready) await sleep(150);
}
check(ready, "② 页面起来了（能看到周导航）", ready ? "" : "等 15s 没等到 .week-nav");
if (!ready) {
  await killApp();
  process.exit(1);
}
await sleep(1200); // 让首屏加载（list_blocks / 理智值）跑完

// **正向对照**（6b P2）：先证明「今天那一列真的在界面上」——
// 否则下面「旧版本看不见」可能只是因为界面停在本周以外 / 周末被藏起来（那就是假红）。
const pre = await evaluate(`(() => {
  const now = new Date();
  const mmdd = (now.getMonth() + 1) + "/" + now.getDate();
  const heads = [...document.querySelectorAll(".day-head")].map((n) => (n.textContent || "").replace(/\s/g, ""));
  return {
    blocks: document.querySelectorAll("[data-block-id]").length,
    heads: heads.length,
    hasToday: heads.some((t) => t.includes(mmdd)),
    mmdd,
    head0: heads[0] ?? "",
  };
})()`).catch(() => null);
check(!!pre && pre.heads >= 1, "③a 时间轴已渲染（天列 ≥1）", pre ? `天列 ${pre.heads} 个 / 屏上块 ${pre.blocks} 个` : "读不到 DOM");
if (!pre || !pre.hasToday) {
  console.error(
    `⏭ 跳过：今天的列不在界面上（今天 ${pre?.mmdd ?? "?"}；天列=[${pre?.head0 ?? ""}]）。` +
      "\n   常见原因：隐藏周末开着而今天是周末 / 应用停在本周以外。先临时打开周末再跑。",
  );
  await killApp();
  process.exit(2);
}
check(true, "③b 今天那一列在界面上（正向对照）", `今天 ${pre.mmdd}`);

// ---------------------------------------------------------------- 3 外部写入（第二个连接）

const start = (() => {
  const d = new Date();
  d.setHours(13, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
})();
const end = start + 30 * 60;
const blockId = `e2e-${Date.now()}`;
{
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(RUN_DB);
  db.exec("PRAGMA busy_timeout=8000");
  const task = db.prepare("SELECT id FROM tasks ORDER BY created_at LIMIT 1").get();
  if (!task) {
    console.error("✗ 副本里连一条任务都没有 —— 换一份有数据的库副本再跑");
    await killApp();
    process.exit(1);
  }
  db.prepare(
    "INSERT INTO blocks (id, task_id, start_at, end_at, status, created_at) VALUES (?,?,?,?,'planned',?)",
  ).run(blockId, task.id, start, end, Math.floor(Date.now() / 1000));
  db.close();
  check(true, "③ 外部连接写入成功（真 SQLite，不是假后端）", `block=${blockId} ${new Date(start * 1000).toLocaleString()}`);
}

// ---------------------------------------------------------------- 4 观察：≤3 秒出现 + 提示

const t0 = Date.now();
let seen = false;
let toastSeen = false;
while (Date.now() - t0 < timeoutMs) {
  await sleep(100);
  const st = await evaluate(
    `({ seen: !!document.querySelector('[data-block-id="${blockId}"]'),
        toast: [...document.querySelectorAll('.toast')].some((n) => (n.textContent || '').includes('外部改动')) })`,
  ).catch(() => ({ seen: false, toast: false }));
  seen = seen || st.seen;
  toastSeen = toastSeen || st.toast;
  if (seen && toastSeen) break;
}
const waited = Date.now() - t0;
if (expect === "pass") {
  check(seen, "④ 新块出现在界面上（≤3 秒）", `用时 ${waited}ms`);
  check(seen && waited <= 3000, "④b 在 3 秒判据内（不是靠运气等到的）", `${waited}ms`);
  check(toastSeen, "⑤ 出现「检测到外部改动」提示", toastSeen ? "" : "没看到提示条");
} else {
  check(!seen, "④ 旧版本：新块**不**出现（这就是「修前」的红）", `等了 ${waited}ms`);
  check(!toastSeen, "⑤ 旧版本：也没有外部改动提示", "");
}

// ---------------------------------------------------------------- 5 收尾：真库没被碰 + 只删自己建的文件

await killApp();
ws.close?.();

const realAfter = snapshot(realFiles);
const strictFiles = [REAL_DB, ...STRICT_SIDE].filter((p) => existsSync(p));
const untouched = strictFiles.every(
  (p) => realBefore[path.basename(p)] === realAfter[path.basename(p)],
);
check(
  untouched,
  "⑥ 真库本体 + `-wal` 的 size+sha256 一点没变（副本里的外部写入没有回流）",
  `${strictFiles.map((p) => path.basename(p)).join(" + ")}`,
);
if (existsSync(SHM)) {
  const same = realBefore["wakeyweeky.sqlite-shm"] === realAfter["wakeyweeky.sqlite-shm"];
  console.log(
    `  ・(注) \`-shm\` ${same ? "也没变" : "变了"} —— 它是 WAL 的共享内存索引，任何连接打开真库都会重写；` +
      `不算「改了数据」`,
  );
}

// 只删本脚本自己建的**明确路径**（不递归）
for (const f of [
  path.join(RUN, "wakeyweeky.exe"),
  path.join(RUN, "portable.flag"),
  RUN_DB,
  RUN_DB + "-wal",
  RUN_DB + "-shm",
]) {
  try {
    if (existsSync(f)) rmSync(f, { force: true });
  } catch {}
}
for (const d of [DATA, RUN, path.dirname(RUN)]) {
  try {
    rmdirSync(d);
  } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${failed.length === 0 ? "✓" : "✗"} e2e（--expect ${expect}）：${results.length - failed.length}/${results.length} 条通过` +
    (failed.length ? ` ｜ 失败：${failed.map((r) => r.name).join(" ｜ ")}` : ""),
);
process.exit(failed.length === 0 ? 0 : 1);
