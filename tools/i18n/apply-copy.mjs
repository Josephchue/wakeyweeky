// round73（3.0b₁）：**全量严过（整改）** —— 把《文案审计》89 条（并集）+ 全量严过新发现的改动
// 应用到 messages/zh.json（**只改值**），并留下机器台账 tools/i18n/audit.json。
//
// ⚠️ **一次性历史工具（round73 用过就不要重跑）**：N/严过2 的两条在之后的复查里又改过一次（
// 「同一任务块」→「同一任务的块」），本表已同步成最终值；但重跑会把 audit.json 的 `from` 重写
// 成当时值并覆盖现有台账 —— 要动 messages 走新的偏移/补丁流程，别拿它当重放器。
//
// 用法：node tools/i18n/apply-copy.mjs [--apply]
// 规则两种：
//   { key, to }              → 整条值替换（校验原值没变过，防手滑）
//   { key, sub, to }         → 子串替换（用于「漂移→漂流」这类）
// 待补规则（留）与「改渲染」的 E1 不在本表（见 plan/验收文档）。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const apply = process.argv.includes("--apply");
const msgPath = path.join(repoRoot, "messages/zh.json");
let messages;
try {
  messages = JSON.parse(readFileSync(msgPath, "utf8"));
} catch (e) {
  throw new Error(`读不了 ${msgPath}：${e.message}`);
}

// ---------------------------------------------------------------- 规则表
// 出处：docs/visual/文案审计.md §4（A–H 取并集）；「N#」= 全量严过新发现。

const RULES = [
  // ---- A 术语
  { id: "A1", key: "ui.review_panel.72", to: "按分类" },
  { id: "A1", key: "ui.review_panel.51", to: "分类投入" },
  { id: "A1", key: "ui.review_panel.52", to: "分类投入" },
  { id: "A2", key: "ui.backlog.17", to: "展开 Backlog（{length} 个任务）" },
  { id: "A2", key: "ui.backlog.18", to: "展开 Backlog（{length} 个任务）" },
  { id: "A2", key: "ui.backlog.20", to: "收起 Backlog（收成细轨；点窄条整条展开）" },
  { id: "A2", key: "ui.backlog.21", to: "收起 Backlog" },
  { id: "A3", key: "msg.keyboard_help.39", to: "Backlog" },
  { id: "A5", key: "ui.stats_panel.12", sub: "漂移", to: "漂流" },
  { id: "A5", key: "ui.stats_panel.19", to: "漂流" },
  { id: "A5", key: "ui.stats_panel.24", to: "序列 / 漂流把后面的块连带挪走" }, // N4：顺带把「环」改「块」
  { id: "A5", key: "ui.stats_panel.27", to: "一次删多个（含漂流后续）算在一起" },
  { id: "A5", key: "ui.stats_panel.63", to: "漂流" },
  { id: "A6", key: "ui.template_picker.17", to: "铺到这一周" },
  { id: "A6", key: "msg.templates.02", to: "已铺 {created} 块到这一周（Ctrl+Z 可撤销）" },
  { id: "A7", key: "msg.selection.06", to: "{missing} 块不在这一周，没跟上" },
  { id: "A8", key: "msg.week.01", to: "{minutes} 分" },
  { id: "A9", key: "msg.blocks.25", to: "这块在序列里，所以不自动融合（序列里的位置不能动）" },
  { id: "A10", key: "msg.blocks.10", to: "顺延后面的 {cascaded} 块" },
  { id: "A10", key: "msg.blocks.27", to: "后面的 {cascaded} 块跟着挪了（含 {history_moved} 块已标记的）" },
  { id: "A10", key: "msg.blocks.28", to: "后面的 {cascaded} 块跟着挪了" },
  { id: "A10", key: "msg.drift.03", to: "后面的 {cascaded} 块跟着挪了（含 {history_moved} 块已标记的）" },
  { id: "A10", key: "msg.drift.04", to: "后面的 {cascaded} 块跟着挪了（它们原本排在这个时段之前）" },
  { id: "A10", key: "msg.sequences.03", to: "已接在它后面（后面的 {cascaded} 块跟着挪了，含 {history_moved} 块已标记的）" },
  { id: "A10", key: "msg.sequences.04", to: "已接在它后面（后面的 {cascaded} 块跟着挪了）" },
  { id: "A10", key: "err.db.80", sub: "后续链节", to: "后续块" },
  { id: "A10", key: "err.db.81", sub: "后续链节", to: "后续块" },
  { id: "A10", key: "err.db.82", sub: "后续链节", to: "后续块" },
  { id: "A10", key: "err.db.83", sub: "后续链节", to: "后续块" },
  { id: "A10", key: "err.db.117", sub: "链节", to: "块" },

  // ---- B 陈旧
  { id: "B1", key: "ui.task_block.07", sub: "**下一列**", to: "下一列" },
  { id: "B1/N1", key: "ui.backlog.31", sub: "**所有块**", to: "所有块" },
  { id: "B2", key: "ui.sanity_settings.65", to: "一直显示在底部；不想看就选「不显示」（键盘操作不受影响）。" },
  {
    id: "B3",
    key: "ui.sanity_settings.21",
    to: "设置（提醒 / 理智值 / 外观布局 / 成就 / 数据 / 功能开关 / 键位说明 / 引导与教程）",
  },
  { id: "B4", key: "msg.hints.02", sub: "「比上周」", to: "「对比」" },

  // ---- C 内部值
  { id: "C1", key: "err.cmd_settings.07", to: "这个设置只接受三个值（打开总览 / 只提醒 / 什么都不做）" },
  { id: "C2/H1", key: "err.cmd_settings.08", to: "提醒时刻需要写成「周日 20:00」或「周一 09:00」" },
  { id: "C3", key: "err.cmd_settings.14", to: "筛选条件不合法（内部格式，升级后请重启一次）" },
  { id: "C4", key: "err.cmd_settings.17", to: "Backlog 形态只认「展开 / 细轨」" },
  { id: "C5", key: "err.cmd_settings.18", to: "键位提示栏只认「常显 / 不显示」" },
  { id: "C6", key: "err.cmd_settings.19", to: "模板建议的设置不合法（门限请重新填一次）" },
  { id: "C7", key: "err.cmd_settings.02", to: "这个开关只接受「开」或「关」" },
  { id: "C7", key: "err.cmd_settings.04", to: "这个开关只接受「开」或「关」" },
  { id: "C7", key: "err.cmd_settings.06", to: "这个开关只接受「开」或「关」" },
  { id: "C7", key: "err.cmd_settings.15", to: "这个开关只接受「开」或「关」" },
  { id: "C8", key: "err.db.158", to: "只能标成「完成」或「未完成」" },
  { id: "C9", key: "err.db.161", to: "层只能设成「必填」或「弹性」" },
  { id: "C9", key: "err.db.204", to: "层只能设成「必填」或「弹性」" },
  { id: "C9", key: "err.repeats.13", to: "层只能设成「必填」或「弹性」" },
  { id: "C10", key: "err.repeats.17", to: "周几要在「周一…周日」之间" },
  { id: "C10", key: "err.cmd_portable.07", to: "这个选项不认识（请重新选一次）" },

  // ---- D 缺「然后呢」
  { id: "D1", key: "err.db.26", to: "时间超出可排范围（最早 1970、最晚 2099，单块最多 3 天）" },
  { id: "D1", key: "err.db.121", to: "顺延后时段超出可排范围（最早 1970、最晚 2099，单块最多 3 天）" },
  { id: "D1", key: "err.db.185", to: "新时段超出可排范围（最早 1970、最晚 2099，单块最多 3 天）" },
  { id: "D1", key: "err.db.194", to: "顺延后时段超出可排范围（最早 1970、最晚 2099，单块最多 3 天）" },
  { id: "D1", key: "err.db.199", to: "新时段超出可排范围（最早 1970、最晚 2099，单块最多 3 天）" },
  { id: "D1", key: "err.db.200", to: "新时段超出可排范围（最早 1970、最晚 2099，单块最多 3 天）" },
  { id: "D2", key: "err.db.19", to: "这个块已经不在了（可能刚被删掉）" },
  { id: "D2", key: "err.db.20", to: "这个块已经不在了（可能刚被删掉）" },
  { id: "D2", key: "err.db.84", to: "这个块已经不在了（可能刚被删掉）" },
  { id: "D2", key: "err.db.99", to: "这个块已经不在了（可能刚被删掉）" },
  { id: "D2", key: "err.db.155", to: "这个块已经不在了（可能刚被删掉）" },
  { id: "D2", key: "err.db.157", to: "这个块已经不在了（可能刚被删掉）" },
  { id: "D2", key: "err.db.162", to: "这个块已经不在了（可能刚被删掉）" },
  { id: "D2", key: "err.db.164", to: "这个块已经不在了（可能刚被删掉）" },
  { id: "D2", key: "err.db.166", to: "这个块已经不在了（可能刚被删掉）" },
  { id: "D2", key: "err.db.184", to: "这个块已经不在了（可能刚被删掉）" },
  { id: "D3", key: "err.db.105", to: "一条漂流链只能占同一个位置。要放到别处，先把它取出来。" },
  { id: "D4", key: "err.db.189", to: "不能漂到前一环之前（顺序会乱）。要么先挪前一环，要么先解除链接。" },
  { id: "D4", key: "err.db.201", to: "不能排到前一环之前（顺序会乱）。要么先挪前一环，要么先解除链接。" },
  { id: "D5", key: "err.backup.06", to: "这里不是一个文件 —— 选一个具体位置（比如桌面上的某个文件）" },
  {
    id: "D6",
    key: "err.db.208",
    to: "这条漂流链异常（超过 {MAX_CHAIN_DEPTH} 级或绕回自己）—— 已按安全方式处理；反复出现的话请反馈",
  },

  // ---- E 太长 / 说两遍
  { id: "E3", key: "msg.blocks.26", to: "两块拼起来会超过 3 天上限 —— 所以没融合" },
  {
    id: "E4",
    key: "ui.data_switch.04",
    to: "将用「{label}」这份作为接下来的数据，应用会立即重启。\n另一边现有的数据会先留一份副本（副本叫 before-switch，和数据放在同一个文件夹里），不会删除。",
  },
  { id: "E5", key: "msg.features.26", to: "块上的键盘操作与键位栏不生效；Esc 与 Ctrl+Z 仍可用（顶部也有撤销按钮）" },
  {
    id: "E6",
    key: "msg.features.54",
    to: "不再注册全局快捷键（组合键交还给系统 / 别的程序）；窗口照常用，只是别的程序里按组合键不会叫出它",
  },

  // ---- F 语气
  { id: "F1", key: "msg.notify.03", sub: "回应用窗口", to: "回到应用窗口" },
  { id: "F1", key: "sys.notify.02", sub: "回应用窗口", to: "回到应用窗口" },
  { id: "F1", key: "sys.notify.04", sub: "回应用窗口", to: "回到应用窗口" },
  { id: "F1", key: "sys.notify.05", sub: "回应用窗口", to: "回到应用窗口" },
  { id: "F1", key: "sys.notify.08", sub: "回应用窗口", to: "回到应用窗口" },
  { id: "F1", key: "sys.notify.20", sub: "回应用窗口", to: "回到应用窗口" },
  { id: "F2", key: "ui.app.06", sub: "主键", to: "首选" },
  { id: "F3", key: "ui.app.03", to: "便携模式已启用：原有数据已复制一份到应用文件夹里的 data 文件夹（原位置保留）" },
  { id: "F3/N3", key: "ui.sanity_settings.06", to: "便携（应用文件夹里的 data\\）" },
  { id: "F3/N3", key: "ui.data_switch.22", to: "当前：便携（应用文件夹里的 data\\）" },
  { id: "F3/N3", key: "help.help_panel.47", to: "：打开后数据（库 / 恢复前副本 / 待恢复文件）写到应用文件夹里的" },
  { id: "F3/N3", key: "ui.sanity_settings.83", to: "：打开后数据写到应用文件夹里的" },
  { id: "F3/N3", key: "err.cmd_portable.01", to: "便携（应用文件夹里的 data\\）" },
  { id: "F3/N3", key: "err.cmd_portable.04", to: "便携（应用文件夹里的 data\\）" },
  { id: "F3/N3", key: "err.cmd_portable.06", to: "这个位置不能开便携（应用文件夹不可写）—— 把应用整个文件夹拷到一个你能写的位置再开" },
  { id: "F4", key: "ui.sanity_settings.57", to: "超了就变红。日头下那根小条一直显示；关掉后时间轴的日头小条、顶部那句提醒、托盘的细红环都不再出现。" },
  { id: "F5", key: "ui.timeline.31", sub: "键盘先不搬块", to: "键盘暂不搬块" },

  // ---- H 语体
  { id: "H1", key: "ui.sanity_settings.08", to: "自定义的暂停时刻需要晚于现在" },
  { id: "H1", key: "err.cmd_settings.03", to: "每日预算需要是整数（分钟）" },
  { id: "H1", key: "err.cmd_settings.09", to: "栏宽需要是整数（像素）" },
  { id: "H1", key: "err.cmd_settings.10", to: "免打扰截止时刻需要是整数" },
  { id: "H1", key: "err.cmd_settings.12", to: "「明早」的时刻需要写成 HH:MM（比如 08:00）" },
  { id: "H1", key: "err.cmd_settings.13", to: "提前分钟数需要是整数" },
  { id: "H1", key: "err.cmd_settings.16", to: "收起的分类需要是字符串数组" },
  { id: "H2", key: "ui.backlog.24", to: "展开这一组" },
  { id: "H2", key: "ui.backlog.25", to: "收起这一组" },
  { id: "H3", key: "ui.category_picker.01", to: "打字新建，或选一个" },

  // ---- N 全量严过新发现（审计没抓到的）
  { id: "N2", key: "ui.stats_panel.30", to: "相邻的同一任务的块自动合并（每次吃掉 1 块）" },
  { id: "N2", key: "msg.features.05", to: "不再把相接/重叠的同一任务的块合成一块（含启动时的整理）；已经合过的块保持原样" },
  { id: "N3", key: "err.db.51", sub: "任务块", to: "块" },
  { id: "N3", key: "err.db.52", sub: "任务块", to: "块" },
  { id: "N3", key: "err.db.53", sub: "任务块", to: "块" },
  { id: "N3", key: "err.db.65", sub: "任务块", to: "块" },
  { id: "N3", key: "err.db.67", sub: "任务块", to: "块" },
  { id: "N3", key: "err.db.156", sub: "任务块", to: "块" },
  { id: "N3", key: "err.db.163", sub: "任务块", to: "块" },
];

// ---------------------------------------------------------------- 应用

const auditPath = path.join(repoRoot, "tools/i18n/audit.json");
let audit = {};
if (existsSync(auditPath)) {
  try {
    audit = JSON.parse(readFileSync(auditPath, "utf8"));
  } catch (e) {
    throw new Error(`读不了 ${auditPath}：${e.message}`);
  }
}

const report = [];
let applied = 0;
for (const r of RULES) {
  const old = messages[r.key];
  if (old === undefined) {
    report.push({ ...r, status: "缺 key" });
    continue;
  }
  let next = old;
  if (r.sub !== undefined) {
    if (!old.includes(r.sub)) {
      // 可能已经改过（幂等）
      const already = audit[`changed:${r.key}`];
      report.push({ ...r, status: already ? "已改过" : "找不到子串" });
      continue;
    }
    next = old.split(r.sub).join(r.to);
  } else if (r.to !== undefined) {
    if (old === r.to) {
      report.push({ ...r, status: "已是新值" });
      continue;
    }
    if (old.includes("**")) {
      report.push({ ...r, status: `旧值里还有星号，人工看：${old.slice(0, 40)}` });
      continue;
    }
    next = r.to;
  }
  report.push({ ...r, status: "改", from: old, to: next });
  messages[r.key] = next;
  audit[`changed:${r.key}`] = { from: old, to: next, rule: r.id };
  applied++;
}

if (apply) {
  writeFileSync(msgPath, JSON.stringify(messages, null, 2) + "\n");
  writeFileSync(auditPath, JSON.stringify(audit, null, 1));
}
for (const r of report) console.log(`${r.status === "改" ? "改" : "—"} [${r.id}] ${r.key}: ${r.status}`);
console.log(`\n${apply ? "已应用" : "将应用"} ${applied} 条；台账 ${Object.keys(audit).length} 条`);
if (!apply) console.log("（干跑；加 --apply 落地）");
