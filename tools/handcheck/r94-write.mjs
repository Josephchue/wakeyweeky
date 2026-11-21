// round94 · **手测助手**：往「便携副本」里插一块，模拟「外部程序直接改库」（学业OS 就是这么干的）。
//
// 只对**副本**用 —— 别指向真库。用法（在应用开着的时候跑，看界面会不会自己跟上）：
//   node tools/handcheck/r94-write.mjs --db "%TEMP%\ww94-handcheck\data\wakeyweeky.sqlite"
//
// 行为：挑一条**未归档**的任务，在今天「现在」那一格插一块 30 分钟的；打印 block id / 时间。
// 它**不会**删任何东西，也不改别的表（只 INSERT blocks 一行）。
import { existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const i = args.indexOf("--db");
const dbPath = i >= 0 ? args[i + 1] : null;
if (!dbPath) {
  console.error("✗ 用法：node tools/handcheck/r94-write.mjs --db <副本的 wakeyweeky.sqlite>");
  process.exit(2);
}
if (!existsSync(dbPath)) {
  console.error(`✗ 找不到库：${dbPath}`);
  process.exit(2);
}

const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout=8000");

// 今天「现在」所在的那一格（15 分钟对齐），30 分钟长 —— 出现在「现在线」附近，一眼能看到
const now = new Date();
const start = new Date(now);
start.setSeconds(0, 0);
start.setMinutes(Math.floor(start.getMinutes() / 15) * 15);
const startSec = Math.floor(start.getTime() / 1000);
const endSec = startSec + 30 * 60;

const task = db
  .prepare("SELECT id, title FROM tasks WHERE archived_at IS NULL ORDER BY sort_order LIMIT 1")
  .get();
if (!task) {
  console.error("✗ 副本里没有未归档的任务 —— 换一份有数据的副本");
  process.exit(2);
}
const id = `handcheck-${Date.now()}`;
db.prepare(
  "INSERT INTO blocks (id, task_id, start_at, end_at, status, created_at) VALUES (?,?,?,?,'planned',?)",
).run(id, task.id, startSec, endSec, Math.floor(Date.now() / 1000));
db.close();

const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
console.log(
  `✓ 已插入一块（外部连接直写，没经过 App）：\n` +
    `  任务：${task.title}\n` +
    `  时间：今天 ${hhmm(start)}–${hhmm(new Date(endSec * 1000))}\n` +
    `  id：${id}\n` +
    `  库：${path.resolve(dbPath)}\n\n` +
    `现在看应用窗口：≤3 秒应该出现这块 + 右下角一条「检测到外部改动，已重新载入」。`,
);
