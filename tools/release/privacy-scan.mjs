// round88（开源准备）：**公开仓导出前的隐私硬闸门** —— 泄露类问题一律拦下，导出脚本在 `git init` 之前调它。
//
// 用法：
//   node tools/release/privacy-scan.mjs <目录>              # 扫描（有硬命中 → 退出码 1）
//   node tools/release/privacy-scan.mjs <目录> --json        # 机器可读
//   node tools/release/privacy-scan.mjs --self-test          # 自证：种 8 类违规 + 2 类干净样本，断言判据既抓得住也不乱抓
//
// 判据分两级（设计口径见 `docs/plans/round88-open-source-launch.md` §5 · 决定 D3）：
//   · **硬闸门（泄露类）**：任何文件都查 —— 用户路径 / 密钥样式 / 图片与二进制白名单 / 内部目录不得存在
//   · **硬闸门（文档类）**：只查 `.md` / `.txt` —— 公开文档里不许出现内部记法（`roundNN`、`docs/plans`…）
//   · **软提醒**：同样的内部记法出现在**代码**里 → 打印但不拦（源码注释里 1300+ 处批次编号，改不动也没隐私收益）
//
// ⚠️ 判据校准（2026-10-09 实测本仓）：裸 `sk-` 会抓到 20 处 CSS 类名 `sk-row`、裸 `password` 抓到
//    `autocomplete` 列表里的一个词 → 所以密钥规则一律要求**真实长度/形状**，不做关键词匹配。
//    （教训同 round87：**自证工具的判据不许比需求更严**。）
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- 规则

/** 图片只允许出现在这些目录下（它们本来就是仓库里合法的图标/截图） */
const IMAGE_ALLOW = [/^src-tauri[\\/]icons[\\/]/, /^src[\\/]lib[\\/]/, /^docs[\\/]images[\\/]/];
/** 字体只允许这两处（随包的展示字与许可） */
const FONT_ALLOW = [/^src[\\/]lib[\\/]assets[\\/]/, /^src-tauri[\\/]resources[\\/]/];

const HARD = [
  {
    id: "H1-用户路径",
    test: (line) =>
      /[A-Za-z]:[\\/]Users[\\/][^\\/\s"')]+/i.test(line) || // privacy-scan:allow —— 规则自身的字面量
      /\/(?:home|Users)\/[A-Za-z0-9._-]+\//i.test(line) ||
      /PiCodingArea/i.test(line) || // privacy-scan:allow —— 规则自身的字面量
      /\bASUS\b/i.test(line) ||
      /%USERPROFILE%/i.test(line) || // privacy-scan:allow —— 规则自身的字面量
      /\\\\\?\\[A-Za-z]:/.test(line), // privacy-scan:allow —— 规则自身的字面量
    why: "机器/用户名/项目路径（绝对路径）",
  },
  {
    id: "H2-密钥样式",
    test: (line) =>
      /sk-[A-Za-z0-9_-]{20,}/.test(line) ||
      /ghp_[A-Za-z0-9]{20,}/.test(line) ||
      /github_pat_[A-Za-z0-9_]{20,}/.test(line) ||
      /AKIA[0-9A-Z]{16}/.test(line) ||
      /xox[baprs]-[A-Za-z0-9-]{10,}/.test(line) ||
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line) ||
      /(?:token|secret|password|api[_-]?key)\s*[:=]\s*["'][^"']{16,}["']/i.test(line),
    why: "看起来是真密钥/口令",
  },
  {
    id: "H6-会话与临时",
    test: (line) =>
      /\.pi[\\/]agent[\\/]sessions/.test(line) || // privacy-scan:allow —— 规则自身的字面量
      /%TEMP%[\\/]wakeyweeky/i.test(line) ||
      /PI_SESSION_FILE/.test(line), // privacy-scan:allow
    why: "会话记录 / 调试临时目录",
  },
];

/** 文件级规则（不看内容） */
const FILE_RULES = [
  {
    id: "H3-图片白名单",
    // 只查**光栅图**：`.svg` 是文本（内容规则照样扫它），放在什么目录都不算隐私问题
    test: (rel) => /\.(png|jpe?g|gif|webp|ico|icns|bmp)$/i.test(rel) && !IMAGE_ALLOW.some((re) => re.test(rel)),
    why: "图片只许出现在 src-tauri/icons · src/lib/** · docs/images",
  },
  {
    id: "H4-禁二进制",
    test: (rel) => /\.(sqlite\d?|sqlite-wal|sqlite-shm|db|exe|dll|msi|zip|7z|lnk|bak|pfx|p12|key|pem|mov|mp4)$/i.test(rel),
    why: "数据库 / 可执行 / 压缩包 / 证书 / 影音 —— 不该进源码仓",
  },
  {
    id: "H5-内部目录",
    test: (rel) =>
      /^docs[\\/](验收|plans|archive|视觉参考|视觉素材|视觉|visual|视觉\+手批)/.test(rel) ||
      /^docs[\\/](对账|NOTES|维护|CHECK|开新会话教程)\./.test(rel) ||
      /^AGENTS\.(md|html)$/.test(rel) ||
      /^\.pi-lens\.json$/.test(rel) ||
      /^\.keys,$/.test(rel) ||
      /^docs[\\/]公开仓[\\/]/.test(rel), // 导出源目录本身不进公开仓（只以映射后的形式出现）
    why: "内部施工记录 / 工具配置 / 中间产物",
  },
  {
    id: "H9-字体白名单",
    test: (rel) => /\.(woff2?|ttf|otf|ttc)$/i.test(rel) && !FONT_ALLOW.some((re) => re.test(rel)),
    why: "字体只许出现在 src/lib/assets · src-tauri/resources",
  },
];
/** 文档类硬闸门：内部记法（只查 .md / .txt） */
const DOC_INTERNAL = [
  { re: /round[0-9]+/, why: "开发期批次编号" },
  { re: /docs[\\/]公开仓/, why: "导出源目录（公开仓里不存在）" }, // privacy-scan:allow
  { re: /docs[\\/](plans|验收|对账|archive|视觉|visual|素材库|视觉参考)/, why: "内部文档路径" },
  { re: /AGENTS\.md/, why: "内部 agent 约定文件" },
  { re: /(^|[^a-zA-Z])对账\.(md|html)/, why: "内部台账文件名" },
];

/** 软提醒：同样的内部记法出现在代码里（打印不拦） */
const SOFT = [
  { re: /round[0-9]+/, why: "批次编号（注释里，正常）" },
  { re: /docs[\\/](plans|验收|对账)[\\/]/, why: "注释里指向内部文档的路径（公开仓里是死链）" },
];

const isDoc = (rel) => /\.(md|txt)$/i.test(rel);
const isText = (rel) => /\.(md|txt|json|ya?ml|ts|tsx|js|mjs|cjs|svelte|rs|toml|html|css|sql|sh|ps1|bat|editorconfig|gitignore|gitattributes)$/i.test(rel) || !/\.[a-z0-9]+$/i.test(rel);
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
/** 行级豁免：这一行里带这个标记就跳过**内容类**规则（文件级规则不受影响）。
 *  只给「工具源码里必须写出这些字面量」用（扫描器自己的规则与自测样本）—— 用完要看得见。 */
const ALLOW_MARK = "privacy-scan:allow";
const clip = (s, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---------------------------------------------------------------- 扫描

/** 递归列出目录里的所有文件（相对路径，正斜杠不统一 —— 保持原样，规则里两种都认） */
function walk(root) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        stack.push(childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  }
  return out.sort();
}

/** 扫描一个目录，返回 { hard: [...], soft: [...], files } */
export function scan(root, { denylist = [] } = {}) {
  const hard = [];
  const soft = [];
  const files = walk(root);
  for (const rel of files) {
    for (const r of FILE_RULES) {
      if (r.test(rel)) hard.push({ rule: r.id, file: rel, line: 0, snippet: r.why });
    }
    if (!isText(rel)) continue;
    let text;
    try {
      const size = statSync(path.join(root, rel)).size;
      if (size > MAX_SCAN_BYTES) text = readFileSync(path.join(root, rel), "utf8").slice(0, MAX_SCAN_BYTES);
      else text = readFileSync(path.join(root, rel), "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes(ALLOW_MARK)) continue; // 行级豁免（只给工具自身字面量用）
      for (const r of HARD) {
        if (r.test(line)) hard.push({ rule: r.id, file: rel, line: i + 1, snippet: clip(line.trim()), why: r.why });
      }
      for (const w of denylist) {
        if (w && line.includes(w))
          hard.push({ rule: "H7-禁用词表", file: rel, line: i + 1, snippet: clip(line.trim()), why: "私有词表命中（tools/release/denylist.local.txt）" });
      }
      if (isDoc(rel)) {
        for (const d of DOC_INTERNAL) {
          if (d.re.test(line)) hard.push({ rule: "H8-文档内部记法", file: rel, line: i + 1, snippet: clip(line.trim()), why: d.why });
        }
      } else {
        for (const s of SOFT) {
          if (s.re.test(line)) soft.push({ rule: "S-代码内部记法", file: rel, line: i + 1, snippet: clip(line.trim()), why: s.why });
        }
      }
    }
  }
  return { hard, soft, files };
}

/** 读可选的本地私有词表（不部署也能跑；有就多一道网）。**导出器也会调它**（复核 ①-2：以前只 CLI 用）。 */
export function loadDenylist() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const p = path.join(here, "denylist.local.txt");
  try {
    return readFileSync(p, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function report(root, res, asJson) {
  if (asJson) {
    console.log(JSON.stringify({ root, hard: res.hard, soft: res.soft, files: res.files.length }, null, 2));
    return;
  }
  console.log(`扫描目录：${root}`);
  console.log(`文件数：${res.files.length}（硬命中 ${res.hard.length} · 软提醒 ${res.soft.length}）`);
  for (const h of res.hard) console.log(`  ✗ [${h.rule}] ${h.file}:${h.line} ${h.snippet}   ← ${h.why}`);
  for (const s of res.soft.slice(0, 10)) console.log(`  · [${s.rule}] ${s.file}:${s.line} ${s.snippet}`);
  if (res.soft.length > 10) console.log(`  · …其余 ${res.soft.length - 10} 条软提醒（不拦）`);
  console.log(res.hard.length ? "结论：✗ 有硬命中 —— 不要导出/不要 git init" : "结论：✓ 0 硬命中");
}

// ---------------------------------------------------------------- 自证（先证红）

/** 8 类违规 + 2 类干净样本（干净样本里故意放「像违规其实合法」的东西 —— 证明判据不乱抓） */
const SELF_TEST_CASES = [
  { file: "a.md", text: "路径：D:\\PiCodingArea\\wakeyweeky\\docs\\x.md\n", expect: "H1-用户路径" }, // privacy-scan:allow
  { file: "b.ts", text: 'const k = "sk-abcdefghijklmnopqrstuvwxyz0123456789";\n', expect: "H2-密钥样式" }, // privacy-scan:allow
  { file: "c.png", text: "", expect: "H3-图片白名单" },
  { file: "d/db.sqlite", text: "", expect: "H4-禁二进制" },
  { file: "docs/验收/round1.md", text: "内部\n", expect: "H5-内部目录" },
  { file: "e.md", text: "会话在 .pi/agent/sessions/xxx.jsonl\n", expect: "H6-会话与临时" }, // privacy-scan:allow
  { file: "f.md", text: "这一条抄自 round87 的结论\n", expect: "H8-文档内部记法" },
  { file: "g.txt", text: "见 docs/plans/round88-xxx.md\n", expect: "H8-文档内部记法" },
  // —— 复核补的样本（之前 H7 / H9 根本没有样本）——
  { file: "h.md", text: "这里写了 超级机密词 四个字\n", expect: "H7-禁用词表" },
  { file: "i/font.ttf", text: "", expect: "H9-字体白名单" },
  { file: "j.md", text: "路径 c:\\users\\bob\\x（小写写法）\n", expect: "H1-用户路径" },
  { file: "k.md", text: "导出源在 docs/公开仓/images 里\n", expect: "H8-文档内部记法" },
  // —— 干净样本（必须 0 硬命中）——
  { file: "clean1.svelte", text: '<span class="sk-row">sk-time</span>\n// 走 C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe\n', clean: true },
  { file: "clean2.md", text: "本项目不联网；数据在 %APPDATA% 下（不带用户名）。\n", clean: true },
];
/** 私有词表样本用的词（只在自测里用） */
const SELF_TEST_DENYLIST = ["超级机密词"];

function selfTest() {
  const root = path.join(os.tmpdir(), "ww88-privacy-selftest");
  rmSync(root, { recursive: true, force: true }); // 只删这一个明确路径（自测专用临时目录）
  mkdirSync(path.join(root, "d"), { recursive: true });
  mkdirSync(path.join(root, "docs", "验收"), { recursive: true });
  for (const c of SELF_TEST_CASES) {
    const p = path.join(root, c.file);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, c.text, "utf8");
  }
  const res = scan(root, { denylist: SELF_TEST_DENYLIST });
  const found = new Set(res.hard.map((h) => `${h.file}|${h.rule}`));
  let bad = 0;
  console.log("自证：种下的每一类违规都必须被抓到，干净样本必须一条不抓\n");
  for (const c of SELF_TEST_CASES) {
    if (c.clean) {
      const hit = res.hard.filter((h) => h.file === c.file);
      const ok = hit.length === 0;
      if (!ok) bad++;
      console.log(`  ${ok ? "✓" : "✗"} 干净样本不被误抓：${c.file}${ok ? "" : `（误抓 ${hit.map((h) => h.rule).join(",")}）`}`);
    } else {
      const ok = found.has(`${c.file}|${c.expect}`);
      if (!ok) bad++;
      console.log(`  ${ok ? "✓" : "✗"} 抓得到：${c.file} → ${c.expect}`);
    }
  }
  // 元断言（复核 ①-1）：**每一条规则都必须有样本** —— 否则规则坏了自测也不会红
  const allRules = [
    ...HARD.map((r) => r.id),
    ...FILE_RULES.map((r) => r.id),
    "H7-禁用词表",
    "H8-文档内部记法",
  ];
  const covered = new Set(SELF_TEST_CASES.filter((c) => !c.clean).map((c) => c.expect));
  const uncovered = allRules.filter((r) => !covered.has(r));
  console.log(`\n规则覆盖：${allRules.length - uncovered.length}/${allRules.length} 条有样本`);
  if (uncovered.length) {
    bad++;
    console.log(`  ✗ 没有样本的规则：${uncovered.join(" · ")}（补样本）`);
  }
  const expected = SELF_TEST_CASES.filter((c) => !c.clean).length;
  console.log(`\n硬命中总数 ${res.hard.length}（期望 ${expected} 类各 ≥1 条）· 失败 ${bad}`);
  rmSync(root, { recursive: true, force: true });
  return bad === 0;
}

// ---------------------------------------------------------------- CLI（**只有直接跑它时**才执行 —— 否则被 export-public.mjs import 会误跑）

const ENTRY = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isEntry = ENTRY === fileURLToPath(import.meta.url);

if (isEntry) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    process.exit(selfTest() ? 0 : 1);
  }
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("用法：node tools/release/privacy-scan.mjs <目录> [--json]   ·   或 --self-test");
    process.exit(2);
  }
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`不是目录：${dir}`);
    process.exit(2);
  }
  const res = scan(dir, { denylist: loadDenylist() });
  report(dir, res, args.includes("--json"));
  process.exit(res.hard.length ? 1 : 0);
}
