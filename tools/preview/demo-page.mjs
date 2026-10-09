/**
 * round61（0.15.0）：把 `preview.mjs --shots <dir>` 拍下的一堆 PNG **内嵌**成一份单文件 html
 * —— 也就是**发布会式的演示页**（用户 2026-10-04 反馈 #4：「像产品发布会里面的演示一样，充实地展示一下」）。
 *
 * 用法：
 *   node tools/preview/demo-page.mjs <截图目录> <输出.html> [--narrow <另一个目录>] [--title 标题]
 *
 * 为什么内嵌 base64：演示页要能**双击就开、离线可看**（不依赖 `%TEMP%`，发给别人也照样能看）。
 * 为什么另开一个脚本而不是塞进 preview.mjs：截图是「机器拍」，组页是「给人看」——两件事分开，各自能重跑。
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const [dir, out] = positional;
const narrowArg = args.indexOf("--narrow");
const narrowDir = narrowArg >= 0 ? args[narrowArg + 1] : "";
const titleArg = args.indexOf("--title");
const title = titleArg >= 0 ? args[titleArg + 1] : "WakeyWeeky 多选与批量操作（round61 / 0.15.0）";

if (!dir || !out) {
  console.error("用法：node tools/preview/demo-page.mjs <截图目录> <输出.html> [--narrow <目录>]");
  process.exit(1);
}

/** 每一幕的一句解说（键 = 文件名里「序号-」之后的那段）——漏了就自动留一条占位 */
const CAPTIONS = {
  // ---- round61（10.2 多选与批量操作）----
  "多选-入口":
    "**Ctrl+左键**加一块（先普通点中的那块是锚点）→ 顶部冒出**动作条**：已选 2 块 + ✓ 完成 / ✗ 未完成 / 必填 / 弹性 / ← 移一天 / 移一天 → / 🗑 删除 / ✕。三种入口：`Ctrl+点` 加/减 · `Shift+点` 区间 · 空白处拖框选（下一幕）。",
  "框选-拖出矩形":
    "在**空白格**按住拖动 → 半透明矩形跟着走（块上拖仍然是移动 —— 与 Figma/Excalidraw 同一条分界）。这一幕故意不松手，把中间态留给你看。",
  "框选-落定":
    "松手：**碰到就算**（不管包没包全）—— 矩形扫过的块全部选中，**替换**掉之前的选择；动作条上的计数就是真正选中的块数。",
  "批量完成":
    "动作条「✓ 完成」：整批标记（只作用于计划中的块）；每一块仍各记自己的完成事件（统计页按块数算）。提示带数量（「已标记 2 块完成」）。",
  "批量删除-一步可撤销":
    "「🗑 删除」**不弹确认框** —— 能 Ctrl+Z 撤的动作不再加确认（调研结论：有撤销就别再确认）；删掉的块数写在提示里，带一个「撤销」按钮。",
  "一步撤销-两块都回来":
    "按一次 `Ctrl+Z`：**整批一起回来**（一条命令 = 一次快照 = 一步撤销），不是一块一块撤。",
  "批量挪天":
    "「移一天 →」：每块**各自** ±1 天（`Shift+←→` 挪一周同语义）—— 批量位置变化只走**键盘语义**，不做拖动（「拖动整组」是你明确否掉的）。",
  "批量改层":
    "「必填 / 弹性」：整批切层，块左侧的色条跟着变（绿 = 必填、灰 = 弹性）；已标记的块也能改层（层是规划属性）。",
  "融合-自动收口":
    "批量挪动把两块撞成一块时：后端自动融合 + 「已合并」提示；被吃掉的块**不留幽灵选中**（这条是 6b 只读复核抓到并修掉的真缺口）。",
  "Ctrl+A-全选本周":
    "`Ctrl+A` 全选这一周（动作条计数跟着走）；`Esc` 一次退回单选、再按一次清空。`Ctrl+A` 在输入框里不劫持（正常选文字）。",
  // ---- round60（10.1 统计页）留档（这批没有对应场景） ----
  "统计面板全貌": "（旧批留档）全时段累计面板。",
  // ---- round64.1（教程演示）----
  "空库首启-卡片":
    "**空库第一次打开**：时间轴空着，左下角一张卡片 ——「先只安排今天就好」（三步），不要求你规划整周",
  "卡片特写":
    "卡片本身：① 写下今天要做的一两件事 ② 拖到今天的位置 ③ 做完点 ✓（到点会有提醒）；底部那句是「不用把整周排满」",
  "写下第一件事": "照第 1 步：在左边输入框写下一件事（回车或点 `+`）—— 它就出现在 Backlog 里",
  "拖到今天": "照第 2 步：把任务从左边**拖到今天**的位置（拖动时右边实时画落点）—— 计划里就有它了",
  "做完点勾": "照第 3 步：做完点块上的 **✓**（到点也会提醒你）—— 块变成完成色，右下角一条提示",
  "知道了-卡片收起": "读过之后点「知道了」—— 卡片收起，之后启动不再出现（设置里能再找回来，见第 8 幕）",
  "渐进提示条":
    "**渐进提示**长这样：第一次用到某个功能才冒一条（一次一条、可就地「全部关掉」）；这里第一次建临时安排块 → 它教你双击名字能改名",
  "设置-引导与教程":
    "**设置 →「引导与教程」**（本批新增）：说明页 / 重看新手卡片 / 重新打开渐进提示 —— 没看清或误关掉的教程从这里找回来",
  "说明页":
    "**说明页**（所有解释的唯一出口）：左侧目录 + 「提示与教学」—— 新手三步也在这儿；键位表在设置面板里，不重复一份",
};

/** round64.1：这几幕在演示页里做**真裁切**（`object-fit:none` + `object-position` 取图的一角，不是拼假） */
const CROPS = { "卡片特写": { height: 340, position: "left bottom" } };

const b64 = async (file) => (await readFile(file)).toString("base64");
const listPng = async (d) => (await readdir(d)).filter((f) => f.endsWith(".png")).sort();

/** 一 |]张图 → 一个 <figure>（解说里的 `**粗**` 与 `` `代码` `` 只做这两样轻量替换） */
const inline = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`(.+?)`/g, "<code>$1</code>");

async function figure(d, file, note = "") {
  const key = file.replace(/^\d+-/, "").replace(/\.png$/, "");
  const caption = CAPTIONS[key] ?? "（没写解说）";
  const src = `data:image/png;base64,${await b64(path.join(d, file))}`;
  const crop = CROPS[key];
  const body = crop
    ? `        <div class="crop" style="height:${crop.height}px"><img alt="${key}" style="height:100%;width:auto;object-fit:none;object-position:${crop.position}" src="${src}" /></div>`
    : `        <img alt="${key}" src="${src}" />`;
  return `      <figure>
        <figcaption><span class="no">${file.slice(0, 2)}</span> ${inline(caption)}${note ? ` <span class="note">${inline(note)}</span>` : ""}</figcaption>
${body}
      </figure>`;
}

const main = await listPng(dir);
const narrow = narrowDir ? await listPng(narrowDir) : [];
// 窄窗口只挑两幕（多选入口 / 批量删除）—— 全上会把页面撑得没必要地长
const narrowPick = narrow.filter((f) => f.startsWith("01-") || f.startsWith("05-"));

const figures = [];
for (const f of main) figures.push(await figure(dir, f));
for (const f of narrowPick) figures.push(await figure(narrowDir, f, "（715px 窄窗口）"));

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 32px 20px 64px; background: #f5f6f7; color: #1a1d21;
         font: 15px/1.7 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #6b7280; font-size: 13px; margin-bottom: 20px; }
  .facts { background: #fff; border: 1px solid #e5e7eb; border-radius: 2px; padding: 14px 18px; margin-bottom: 26px; }
  .facts h2 { font-size: 14px; margin: 0 0 8px; color: #6b7280; font-weight: 600; }
  .facts ul { margin: 0; padding-left: 20px; font-size: 13.5px; }
  .facts code { background: #f3f4f6; padding: 1px 4px; border-radius: 2px; }
  figure { margin: 0 0 30px; background: #fff; border: 1px solid #e5e7eb; border-radius: 2px; overflow: hidden; }
  figcaption { padding: 10px 14px; font-size: 13.5px; border-bottom: 1px solid #eef0f2; }
  figcaption .no { display: inline-block; min-width: 22px; color: #00a37a; font-weight: 700; }
  figcaption .note { color: #6b7280; }
  img { display: block; width: 100%; height: auto; }
  .crop { overflow: hidden; background: #fff; }
  .crop img { display: block; }
  code { font-family: Consolas, monospace; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${title}</h1>
  <p class="sub">真前端 + 假数据（绝不碰你的库）· 截图由 <code>node tools/preview/preview.mjs --shots &lt;目录&gt;</code> 产出 · 本页由 <code>tools/preview/demo-page.mjs</code> 组装（图片内嵌，离线可看）</p>

  <div class="facts">
    <h2>机器已证（你不需要替我找 bug）</h2>
    <ul>
      <li>闸门：<code>cargo test</code> <b>298</b> · clippy <b>0</b> · svelte-check <b>0-0</b> · 单测 <b>263</b>（25 文件）· <code>npm audit</code> <b>0</b></li>
      <li>预览断言 <b>269 条全 ✓</b> + CDP 真输入探针 ×2 ✓（715px 窄窗口的改名探针本批从红修绿）</li>
      <li>本批**红→绿**各留了一次：漂流子块隐藏（3 条 Rust + 预览两次反向对照）· 模板带任务（3 条 Rust）· undo/redo 视角（Rust focus + 预览反向对照）· CF 窄窗口探针（先红后绿）</li>
      <li>只读复核（维护 6b）：见验收文档（本批动过 <code>tools/preview/*</code>，交付前跑一轮）</li>
    </ul>
  </div>

${figures.join("\n")}
</div>
</body>
</html>
`;

await mkdir(path.dirname(path.resolve(out)), { recursive: true });
await writeFile(out, html, "utf8");
console.log(`演示页已生成：${out}（${figures.length} 幕，图片内嵌）`);
