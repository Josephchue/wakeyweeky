// 把 `docs/*.md` 渲染成「方便人读」的单文件 HTML（离线、无外部资源）。
//
// 为什么不用手写 HTML：手写会变成两份真相，md 一改 HTML 就过期。
// 这里是「md 是唯一来源 + 一条命令重新生成」。
//
// 关键保证：**一个字都不能少**。每次生成都会做一次「正文指纹」比对 ——
//   把 md 里的标记（# | > - * ` 等）剥掉，再把 HTML 的标签与实体解码，
//   两边的**非空白字符流**必须完全相同；不一致就**拒绝写文件**并退出码 1。
//
// 用法：
//   node tools/docs/render.mjs docs/WakeyWeeky_v2.md            # 生成 docs/WakeyWeeky_v2.html
//   node tools/docs/render.mjs docs/CHECK.md --out /tmp/x.html
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--"));
if (!input) {
  console.error("用法：node tools/docs/render.mjs <input.md> [--out out.html]");
  process.exit(1);
}
const outIdx = args.indexOf("--out");
const output = outIdx >= 0 ? args[outIdx + 1] : input.replace(/\.md$/, ".html");

const md = await readFile(input, "utf8");

// ---------------------------------------------------------------- 解析
const lines = md.split(/\r?\n/);
const blocks = []; // { type, ... }
let i = 0;

const isTableRow = (s) => /^\|.*\|\s*$/.test(s);
const isTableSep = (s) => /^\|[\s:|-]+\|\s*$/.test(s);
const isHeading = (s) => /^#{1,6}\s/.test(s);
const isFence = (s) => /^```/.test(s);
const isQuote = (s) => /^>\s?/.test(s);
const isUl = (s) => /^[-*]\s+/.test(s);
const isOl = (s) => /^\d+\.\s+/.test(s);
const isHr = (s) => /^(-{3,}|\*{3,})\s*$/.test(s);

/**
 * 拆表格行：`|` 分隔，但**代码段里的 `|`** 与 `\|` 不算分隔符。
 *
 * 为什么不用 `split("|")`（round76 踩到的）：`对账.md` 的 BW 那一行里，代码段内带竖线 ——
 * naive split 会把格子切歪、后面的格子串位，于是**指纹自检拒写**（`对账.html` 就一直没重生）。
 */
function splitCells(row) {
  const inner = row.replace(/^\|/, "").replace(/\|\s*$/, "");
  const cells = [];
  let cur = "";
  let inCode = false;
  for (let k = 0; k < inner.length; k++) {
    const ch = inner[k];
    if (ch === "\\" && inner[k + 1] === "|") {
      cur += "|";
      k++;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      cur += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

while (i < lines.length) {
  const line = lines[i];

  if (line.trim() === "") {
    i++;
    continue;
  }

  if (isHeading(line)) {
    const level = line.match(/^#+/)[0].length;
    blocks.push({ type: "heading", level, text: line.replace(/^#+\s*/, "").trim() });
    i++;
    continue;
  }

  if (isFence(line)) {
    const lang = line.slice(3).trim();
    const body = [];
    i++;
    while (i < lines.length && !isFence(lines[i])) {
      body.push(lines[i]);
      i++;
    }
    i++; // 跳过收尾围栏
    blocks.push({ type: "code", lang, text: body.join("\n") });
    continue;
  }



  if (isTableRow(line)) {
    const rows = [];
    while (i < lines.length && isTableRow(lines[i])) {
      if (!isTableSep(lines[i])) {
        rows.push(splitCells(lines[i]));
      }
      i++;
    }
    const [head, ...body] = rows;
    blocks.push({ type: "table", head: head ?? [], rows: body });
    continue;
  }

  if (isQuote(line)) {
    const body = [];
    while (i < lines.length && (isQuote(lines[i]) || /^\s+\S/.test(lines[i]))) {
      body.push(lines[i].replace(/^>\s?/, ""));
      i++;
    }
    blocks.push({ type: "quote", lines: body });
    continue;
  }

  if (isUl(line) || isOl(line)) {
    const ordered = isOl(line);
    const items = [];
    while (i < lines.length) {
      const cur = lines[i];
      if ((ordered && isOl(cur)) || (!ordered && isUl(cur))) {
        items.push(cur.replace(ordered ? /^\d+\.\s+/ : /^[-*]\s+/, ""));
        i++;
      } else if (/^\s+\S/.test(cur)) {
        items[items.length - 1] += " " + cur.trim();
        i++;
      } else {
        break;
      }
    }
    blocks.push({ type: "list", ordered, items });
    continue;
  }

  if (isHr(line)) {
    blocks.push({ type: "hr" });
    i++;
    continue;
  }

  // 普通段落：吸收后续非空、非块起始的行（含缩进续行）
  const para = [line.trim()];
  i++;
  while (
    i < lines.length &&
    lines[i].trim() !== "" &&
    !isHeading(lines[i]) &&
    !isFence(lines[i]) &&
    !isTableRow(lines[i]) &&
    !isQuote(lines[i]) &&
    !isUl(lines[i]) &&
    !isOl(lines[i]) &&
    !isHr(lines[i])
  ) {
    para.push(lines[i].trim());
    i++;
  }
  blocks.push({ type: "para", text: para.join(" ") });
}

// ---------------------------------------------------------------- 行内标记
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 多反引号代码段的「去一层包围空格」规则（Markdown 口径：`` ` x ` `` → `x`，`` `x` `` 原样） */
function stripPadSpaces(inner) {
  if (inner.length > 2 && inner.startsWith(" ") && inner.endsWith(" ")) return inner.slice(1, -1);
  return inner;
}

/** 行内代码段的正则：**开闭的反引号串长度必须相等**（CommonMark 口径）。
 *  round76 6b：以前是 `/`+([\s\S]+?)`+/`（开闭长度不管）—— `` `` `x` `` `` 这种写法会配错，
 *  html 里冒出**空 code 小方块**（`docs/对账.html` 的 BW 行肉眼可见），而 md 侧用同一套错规则
 *  → 指纹自检抓不到（两侧一致地错）。`mdPlain` 与 `inline()` 必须用**同一个**正则。 */
const CODE_SPAN_RE = /(`+)([\s\S]*?)\1/g;

/** 行内：先取出 code span（避免里面的 ** 被当粗体），再处理 **bold**。 */
function inline(text) {
  // `\|` = 字面竖线：**先**还原（连代码段内一起）—— 与 `splitCells` 同一口径，
  // 否则「md 侧代码段里是 \|、html 侧已经是 |」会指纹差字（round76 踩到）。
  text = text.replace(/\\\|/g, "|");
  const codes = [];
  let s = text.replace(CODE_SPAN_RE, (_, _delim, inner) => {
    codes.push(stripPadSpaces(inner));
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${esc(codes[Number(n)])}</code>`);
  return s;
}

// ---------------------------------------------------------------- 渲染
let sectionNo = 0;
const toc = [];
const html = [];

for (const b of blocks) {
  if (b.type === "heading") {
    const level = b.level;
    const id = `s${++sectionNo}`;
    if (level === 1) {
      html.push(`<h1 id="${id}">${inline(b.text)}</h1>`);
      toc.push({ id, level: 1, text: b.text });
    } else if (level === 2) {
      html.push(`<h2 id="${id}">${inline(b.text)}</h2>`);
      toc.push({ id, level: 2, text: b.text });
    } else {
      html.push(`<h3 id="${id}">${inline(b.text)}</h3>`);
      toc.push({ id, level: level, text: b.text });
    }
    continue;
  }
  if (b.type === "code") {
    html.push(
      `<pre class="code"><code>${esc(b.text)}</code></pre>`,
    );
    continue;
  }
  if (b.type === "table") {
    const head = `<tr>${b.head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr>`;
    const rows = b.rows
      .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
      .join("\n");
    html.push(
      `<div class="tw"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>`,
    );
    continue;
  }
  if (b.type === "quote") {
    html.push(
      `<blockquote>${b.lines
        .map((l) => (l.trim() === "" ? "" : `<span class="ql">${inline(l)}</span>`))
        .filter(Boolean)
        .join("<br />")}</blockquote>`,
    );
    continue;
  }
  if (b.type === "list") {
    const tag = b.ordered ? "ol" : "ul";
    html.push(
      `<${tag}>${b.items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`,
    );
    continue;
  }
  if (b.type === "hr") {
    html.push('<hr class="sep" />');
    continue;
  }
  html.push(`<p>${inline(b.text)}</p>`);
}

// ---------------------------------------------------------------- 指纹比对（一个字都不能少）
const fingerprint = (s) => s.replace(/\s+/g, "").trim();

/** md → 纯文本（剥掉语法标记；**围栏代码块内一律原样保留**） */
function mdPlain(src) {
  const out = [];
  let inFence = false;
  for (const raw of src.split(/\r?\n/)) {
    if (/^```/.test(raw)) {
      inFence = !inFence;
      continue; // 围栏行本身不是内容
    }
    if (inFence) {
      out.push(raw);
      continue;
    }
    if (/^\|[\s:|-]+\|\s*$/.test(raw)) continue; // 表格分隔行

    // `\|` = 字面竖线：**先**还原（连代码段内一起）—— 与 `splitCells` / `inline()` 同一口径
    const line = raw.replace(/\\\|/g, "|");

    const codes = [];
    // 与 `inline()` 同一套正则（长度相等的反引号串才算一对）—— 两侧口径必须一致，否则指纹自检必红
    let s = line.replace(CODE_SPAN_RE, (_, _delim, inner) => {
      codes.push(stripPadSpaces(inner));
      return `\u0001${codes.length - 1}\u0001`;
    });
    // 标题只剥 # 与行内标记：标题里的「0.」「1)」是正文（如 `## 0. 准备`），不能当列表编号剥掉
    if (/^#{1,6}\s/.test(s)) {
      s = s
        .replace(/^#{1,6}\s*/, "")
        .replace(/\*\*/g, "")
        .replace(/~~/g, "");
      out.push(s.replace(/\u0001(\d+)\u0001/g, (_, n) => codes[Number(n)]));
      continue;
    }
    s = s
      .replace(/^#{1,6}\s*/, "")
      .replace(/^>\s?/, "")
      .replace(/^[-*]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/^(-{3,}|\*{3,})\s*$/, "")
      .replace(/^\||\|$/g, "")
      .replace(/\\\|/g, "|") // `\|` = 字面竖线（与 `splitCells` 的口径对齐；不还原就会指纹差字）
      .replace(/\|/g, "")
      .replace(/\*\*/g, "")
      .replace(/~~/g, "");
    out.push(s.replace(/\u0001(\d+)\u0001/g, (_, n) => codes[Number(n)]));
  }
  return out.join("\n");
}

/** html → 纯文本（去标签、解实体） */
function htmlPlain(src) {
  return src
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<br\s*\/?>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const bodyHtml = html.join("\n");
// 把开头的 H1 提到元信息之上（页面读起来更自然）
let h1Html = "";
const bodyLines = html.slice();
if (bodyLines[0]?.startsWith("<h1")) h1Html = bodyLines.shift();
const bodyRest = bodyLines.join("\n");

// 额外体检：正文（排除代码块/行内代码）里不应再出现未渲染的标记
const proseOnly = bodyHtml
  .replace(/<pre[\s\S]*?<\/pre>/g, "")
  .replace(/<code>[\s\S]*?<\/code>/g, "");
const leftovers = ["**", "```", "|", "~~"].filter((t) => proseOnly.includes(t));
if (leftovers.length) {
  console.warn(`⚠️ 正文里疑似有未渲染的标记：${leftovers.map((x) => JSON.stringify(x)).join(" ")}`);
}
const a = fingerprint(mdPlain(md));
const b2 = fingerprint(htmlPlain(bodyHtml));
if (a !== b2) {
  // ⚠️ 比差异必须按**码点**来：字符串下标是 UTF-16 单元，而 md 里的 emoji（🗑 这类星平面字符）
  // 占两个单元 —— 混用会导致「首个差异」定位错位（打印出来的两段看着一模一样）、
  // 而且长度差看起来像「丢了 7 个字」（其实全是代理对算重了）。round76 踩到并修。
  const A = [...a];
  const B = [...b2];
  const at = A.findIndex((ch, n) => ch !== B[n]);
  console.error("❌ 内容指纹不一致 —— 拒绝输出（会有内容丢失/增加）");
  console.error(`   md 非空白字符数 ${A.length} / html ${B.length}，首个差异在第 ${at} 字符`);
  console.error(`   md   : ...${A.slice(Math.max(0, at - 40), at + 40).join("")}...`);
  console.error(`   html : ...${B.slice(Math.max(0, at - 40), at + 40).join("")}...`);
  process.exit(1);
}

const title = toc.find((t) => t.level === 1)?.text ?? path.basename(input);
const tocHtml = toc
  .filter((t) => t.level >= 2)
  .map((t) => `<a class="t${t.level}" href="#${t.id}">${inline(t.text)}</a>`)
  .join("\n");

const now = new Date().toLocaleString("zh-CN", { hour12: false });

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<style>
  :root {
    --bg: #f7f8f9; --card: #ffffff; --ink: #16191d; --ink2: #4d5761; --line: #d7dce1;
    --accent: #00695c; --accent-soft: #e6f2f0; --warn: #a35200; --code-bg: #f0f3f5;
    --quote-bg: #f3f7f8; --quote-bar: #9fb8b4; --mark: #ffe9a8; --measure: 76ch;
  }
  html[data-theme="dark"] {
    --bg: #0f1317; --card: #161b20; --ink: #e6e9ec; --ink2: #a4aeb8; --line: #2a3239;
    --accent: #4fd1c0; --accent-soft: #12241f; --warn: #e0a15a; --code-bg: #1b2127;
    --quote-bg: #171f23; --quote-bar: #3d5b56; --mark: #6b5b17;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15.5px/1.85 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  /* ---------- 顶部条 ---------- */
  .bar {
    position: sticky; top: 0; z-index: 30; display: flex; gap: 12px; align-items: center;
    padding: 8px 18px; background: color-mix(in srgb, var(--card) 92%, transparent);
    border-bottom: 1px solid var(--line); backdrop-filter: blur(6px);
  }
  .bar .t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar .sp { flex: 1 }
  .bar input {
    width: min(280px, 34vw); padding: 5px 10px; border: 1px solid var(--line);
    border-radius: 5px; background: var(--bg); color: var(--ink); font: inherit; font-size: 13px;
  }
  .bar button {
    padding: 5px 10px; border: 1px solid var(--line); border-radius: 5px;
    background: var(--card); color: var(--ink); font: inherit; font-size: 13px; cursor: pointer;
  }
  .bar button:hover { border-color: var(--accent); color: var(--accent) }
  #hits { color: var(--ink2); font-size: 12px; font-variant-numeric: tabular-nums; }
  #prog { position: fixed; top: 0; left: 0; height: 2px; background: var(--accent); z-index: 31; width: 0 }
  /* ---------- 骨架 ---------- */
  .wrap { display: grid; grid-template-columns: 290px minmax(0, 1fr); gap: 34px; max-width: 1320px; margin: 0 auto; padding: 26px 22px 80px; }
  nav.toc { position: sticky; top: 58px; align-self: start; max-height: calc(100vh - 80px); overflow: auto; font-size: 13px; padding-right: 6px }
  nav.toc h4 { margin: 0 0 8px; font-size: 11px; letter-spacing: .14em; color: var(--ink2); text-transform: uppercase }
  nav.toc a { display: block; padding: 4px 8px; border-left: 2px solid transparent; color: var(--ink2); text-decoration: none; line-height: 1.5 }
  nav.toc a.t3 { padding-left: 20px; font-size: 12.5px }
  nav.toc a:hover { color: var(--ink); background: var(--accent-soft) }
  nav.toc a.on { color: var(--accent); border-left-color: var(--accent); background: var(--accent-soft); font-weight: 600 }
  main { min-width: 0 }
  main > * { max-width: var(--measure) }
  /* ---------- 排版 ---------- */
  h1 { font-size: 27px; line-height: 1.4; margin: 8px 0 22px; padding-bottom: 14px; border-bottom: 2px solid var(--accent) }
  h2 {
    font-size: 20px; margin: 44px 0 14px; padding: 6px 0 6px 12px; border-left: 4px solid var(--accent);
    background: linear-gradient(90deg, var(--accent-soft), transparent 62%); border-radius: 2px;
  }
  h3 { font-size: 16.5px; margin: 26px 0 10px; color: var(--ink) }
  p { margin: 11px 0 }
  strong { font-weight: 650 }
  code { padding: 1px 5px; background: var(--code-bg); border: 1px solid var(--line); border-radius: 4px; font-family: Consolas, "Courier New", monospace; font-size: .89em }
  del { color: var(--ink2); text-decoration-thickness: 1px }
  pre.code { margin: 14px 0; padding: 12px 14px; background: var(--code-bg); border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 5px; overflow: auto }
  pre.code code { padding: 0; background: none; border: none; font-size: 12.6px; line-height: 1.7; white-space: pre }
  blockquote { margin: 14px 0; padding: 10px 14px; background: var(--quote-bg); border-left: 3px solid var(--quote-bar); border-radius: 0 4px 4px 0; color: var(--ink2) }
  blockquote .ql { display: inline }
  hr.sep { margin: 30px 0; border: none; border-top: 1px solid var(--line) }
  ul, ol { margin: 10px 0; padding-left: 26px }
  li { margin: 5px 0 }
  ol { list-style: decimal }
  /* ---------- 表格（本文件的重点）---------- */
  .tw { margin: 14px 0; overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--card) }
  table { border-collapse: collapse; width: 100%; font-size: 13.6px }
  thead th { position: sticky; top: 0; background: var(--accent-soft); color: var(--ink); text-align: left; padding: 9px 11px; border-bottom: 1px solid var(--line); white-space: nowrap; font-weight: 650 }
  tbody td { padding: 9px 11px; border-top: 1px solid var(--line); vertical-align: top }
  tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--bg) 55%, transparent) }
  tbody tr:hover td { background: var(--accent-soft) }
  tbody td:first-child { white-space: nowrap; color: var(--ink2) }
  /* ---------- 其它 ---------- */
  mark { background: var(--mark); color: inherit; border-radius: 2px }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 14px 0 4px; padding: 10px 12px; background: var(--card); border: 1px solid var(--line); border-radius: 6px; font-size: 12.5px; color: var(--ink2) }
  .meta { margin: 0 0 8px; font-size: 12.5px; color: var(--ink2) }
  #top { position: fixed; right: 18px; bottom: 18px; z-index: 30; display: none; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--ink); cursor: pointer }
  @media (max-width: 1000px) {
    .wrap { grid-template-columns: 1fr }
    nav.toc { position: static; max-height: none; border: 1px solid var(--line); border-radius: 6px; padding: 10px; background: var(--card) }
    nav.toc a { display: inline-block }
  }
  @media print {
    .bar, nav.toc, #top, #prog { display: none !important }
    .wrap { display: block; max-width: none; padding: 0 }
    body { font-size: 11pt; background: #fff }
    .tw { overflow: visible; break-inside: avoid }
    h2 { break-after: avoid }
    thead th { position: static }
  }
</style>
</head>
<body>
<div id="prog"></div>
<div class="bar">
  <span class="t">${title}</span>
  <span class="sp"></span>
  <span id="hits"></span>
  <input id="q" type="search" placeholder="页内搜索（回车下一个）" />
  <button id="theme" title="切换日间/夜间">🌓</button>
  <button id="print" title="打印 / 存 PDF">打印</button>
</div>
<div class="wrap">
  <nav class="toc">
    <h4>目录</h4>
    ${tocHtml}
  </nav>
  <main>
    ${h1Html}
    <p class="meta">来源：<code>${path.basename(input)}</code>　·　生成时间 ${now}　·　重新生成：<code>node tools/docs/render.mjs ${input}</code>（正文零丢失自检通过）</p>
    <div class="legend">
      <span>✅ 已完成／已定</span><span>🔵 建议默认值</span><span>🟠 需你确认</span>
      <span>⚠️ 注意／风险</span><span>⛔ 禁止</span><span><del>删除线</del> = 已废弃</span>
    </div>
${bodyRest}
  </main>
</div>
<button id="top">↑ 顶部</button>
<script>
  // 主题（记住选择）
  const root = document.documentElement;
  const saved = localStorage.getItem("ww-doc-theme");
  if (saved) root.dataset.theme = saved;
  document.getElementById("theme").onclick = () => {
    const next = root.dataset.theme === "dark" ? "" : "dark";
    root.dataset.theme = next;
    localStorage.setItem("ww-doc-theme", next);
  };
  document.getElementById("print").onclick = () => window.print();

  // 阅读进度 + 回到顶部
  const prog = document.getElementById("prog");
  const top = document.getElementById("top");
  const onScroll = () => {
    const h = document.body.scrollHeight - window.innerHeight;
    prog.style.width = (h > 0 ? (window.scrollY / h) * 100 : 0) + "%";
    top.style.display = window.scrollY > 600 ? "block" : "none";
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  top.onclick = () => scrollTo({ top: 0, behavior: "smooth" });

  // 目录高亮当前小节
  const links = [...document.querySelectorAll("nav.toc a")];
  const targets = links.map((a) => document.querySelector(a.getAttribute("href"))).filter(Boolean);
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        links.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + e.target.id));
      }
    },
    { rootMargin: "-58px 0px -75% 0px", threshold: 0 },
  );
  targets.forEach((t) => io.observe(t));

  // 页内搜索（高亮 + 命中计数 + 回车跳下一个）
  const q = document.getElementById("q");
  const hits = document.getElementById("hits");
  let marks = [];
  const clear = () => {
    marks.forEach((m) => {
      const p = m.parentNode;
      p.replaceChild(document.createTextNode(m.textContent), m);
      p.normalize();
    });
    marks = [];
    hits.textContent = "";
  };
  const run = (scroll) => {
    clear();
    const term = q.value.trim();
    if (term.length < 2) return;
    const walker = document.createTreeWalker(document.querySelector("main"), NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.nodeValue.toLowerCase().includes(term.toLowerCase())) nodes.push(n);
    }
    for (const n of nodes) {
      const parts = n.nodeValue.split(new RegExp("(" + term.replace(/[.*+?^$\\{\\}()|[\\]\\\\]/g, "\\\\$&") + ")", "gi"));
      const frag = document.createDocumentFragment();
      parts.forEach((p, idx) => {
        if (idx % 2 === 1) {
          const m = document.createElement("mark");
          m.textContent = p;
          frag.appendChild(m);
          marks.push(m);
        } else if (p) frag.appendChild(document.createTextNode(p));
      });
      n.parentNode.replaceChild(frag, n);
    }
    hits.textContent = marks.length ? marks.length + " 处" : "没找到";
    if (scroll && marks.length) marks[0].scrollIntoView({ block: "center", behavior: "smooth" });
  };
  let cur = 0;
  q.addEventListener("input", () => { cur = 0; run(true); });
  q.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !marks.length) return;
    cur = (cur + 1) % marks.length;
    marks[cur].scrollIntoView({ block: "center", behavior: "smooth" });
  });
</script>
</body>
</html>
`;

await writeFile(output, page, "utf8");
console.log(`✅ 已生成 ${output}`);
console.log(`   正文零丢失自检通过：md 与 html 的非空白字符完全一致（${a.length} 字符）`);
console.log(`   章节 ${toc.length} 个（目录条目 ${toc.filter((t) => t.level >= 2).length}），表格 ${blocks.filter((b) => b.type === "table").length} 张`);
