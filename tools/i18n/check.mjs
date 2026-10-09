// round73（3.0b₁）：文案资源层的**全部机器判据**（3.4 二次审查与以后每批复用）。
//
// 用法：node tools/i18n/check.mjs [--json] [--quiet]
// 判据（任一红 = 退出码 1）：
//   1) 硬编码：src/ 与 src-tauri/src/ 里不该再有用户可见中文（含插值表达式里的）
//   2) 对账：map-frontend.json / map-rust.json 记的「原文」必须与 messages 的值一致（例外清单在 §例外）
//   3) 机械扫：省略号 / 中英与数字空格 / 情态「得」/ 术语禁用词 / 第一人称 / 感叹号 / 大括号占位
//   4) 调用点：t("key", {…}) 与 tf!(msg::KEY, name = …) 的参数名必须与值里的 {name} 一一对应
//   5) 提示（不算红）：重复值（同一句在多个 key 下）、孤儿 key（没有任何调用点）
//   6) 英文表（round74 / 3.0b₂，E1/E2）：en = 工作表生成物（漂移即红）· 键齐 · 占位齐 · 复数成对 · 无中文 ·
//      复数键必须走 tn（否则英文回落中文）
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAll, walkSource, matchParen, decodeEntities } from "./lib.mjs";
import { buildEn, loadOverrides, loadValues } from "./en-build.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");

// ---------------------------------------------------------------- 读资源

function readJson(rel, fallback) {
  const p = path.join(repoRoot, rel);
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`读不了 ${rel}：${e.message}`);
  }
}

const messages = readJson("messages/zh.json", {});
const glossary = readJson("tools/i18n/glossary.json", { banned: [], firstPerson: [], firstPersonHint: [] });
const mapFrontend = readJson("tools/i18n/map-frontend.json", []);
const mapRust = readJson("tools/i18n/map-rust.json", []);
const audit = readJson("tools/i18n/audit.json", {});

const violations = [];
const infos = [];
const add = (kind, msg) => violations.push({ kind, msg });

// ---------------------------------------------------------------- 1) 硬编码

const remaining = extractAll(repoRoot, { scanExpr: true });
for (const e of remaining) {
  add("hardcoded", `${e.file}:${e.line} 还留着用户可见文案：${JSON.stringify(e.value).slice(0, 80)}`);
}

// ---------------------------------------------------------------- 2) 对账

const INTENTIONAL = {
  // 迁移时重命名的占位（同名冲突）：值随之变化，登记在此（plan §3.3 的机器例外）
  "ui.review_panel.17": "这一周{kind} {count} 次",
  "ui.review_panel.19": "{base}{kind} {count} 次",
  "ui.timeline.11": "落点 {span} · {duration}",
};
const DELETED = new Set([
  "msg.i18n.01", // 资源层自身被误迁移的伪语言包装串
  "msg.blocks.01", // 前端 console.error 日志（不是用户文案，迁回字面量了）
  "msg.blocks.02",
  "msg.blocks.03",
]);
/**
 * round74（3.0b₂）：**片段整句化**删掉的旧键 —— 值已并入右边那条（迁移台账里还记着它们，这里具名放行）。
 * 判据：目标键必须在 messages 里（归属没丢）；用 `**粗**` / `` `码` `` 内联，由 `RichText` 渲染。
 */
const MERGED = {
  "help.help_panel.11": "help.help_panel.10",
  "help.help_panel.13": "help.help_panel.12",
  "help.help_panel.15": "help.help_panel.14",
  "help.help_panel.17": "help.help_panel.16",
  "help.help_panel.18": "help.help_panel.16",
  "help.help_panel.19": "help.help_panel.16",
  "help.help_panel.21": "help.help_panel.20",
  "help.help_panel.24": "help.help_panel.23",
  "help.help_panel.25": "help.help_panel.23",
  "help.help_panel.26": "help.help_panel.23",
  "help.help_panel.27": "help.help_panel.23",
  "help.help_panel.37": "help.help_panel.36",
  "help.help_panel.39": "help.help_panel.38",
  "help.help_panel.40": "help.help_panel.38",
  "help.help_panel.41": "help.help_panel.38",
  "help.help_panel.43": "help.help_panel.42",
  "help.help_panel.44": "help.help_panel.42",
  "help.help_panel.45": "help.help_panel.42",
  "help.help_panel.47": "help.help_panel.46",
  "help.help_panel.48": "help.help_panel.46",
  "help.help_panel.49": "help.help_panel.46",
  "help.help_panel.50": "help.help_panel.46",
  "help.help_panel.51": "help.help_panel.46",
  "help.help_panel.52": "help.help_panel.46",
  "help.help_panel.53": "help.help_panel.46",
  "help.help_panel.56": "help.help_panel.55",
  "help.help_panel.57": "help.help_panel.55",
  "help.help_panel.58": "help.help_panel.55",
  "help.help_panel.60": "help.help_panel.59",
  "help.help_panel.61": "help.help_panel.59",
  "help.help_panel.63": "help.help_panel.62",
  "help.help_panel.64": "help.help_panel.62",
  "help.help_panel.65": "help.help_panel.62",
  "help.help_panel.67": "help.help_panel.66",
  "help.help_panel.68": "help.help_panel.66",
  "help.help_panel.69": "help.help_panel.66",
  "help.help_panel.70": "help.help_panel.66",
  "help.help_panel.29": "help.help_panel.28",
  "help.help_panel.30": "help.help_panel.28",
  "help.help_panel.32": "help.help_panel.31",
  "help.help_panel.33": "help.help_panel.31",
  "help.help_panel.74": "help.help_panel.73",
  "help.help_panel.76": "help.help_panel.75",
  "help.help_panel.77": "help.help_panel.75",
  "help.help_panel.80": "help.help_panel.79",
  "help.help_panel.82": "help.help_panel.81",
  "help.help_panel.84": "help.help_panel.83",
  "help.help_panel.87": "help.help_panel.86",
  "help.help_panel.88": "help.help_panel.86",
  "ui.sanity_settings.50": "ui.sanity_settings.49",
  "ui.sanity_settings.52": "ui.sanity_settings.51",
  "ui.sanity_settings.81": "ui.sanity_settings.80",
  "ui.sanity_settings.82": "ui.sanity_settings.80",
  "ui.sanity_settings.83": "ui.sanity_settings.80",
  "ui.sanity_settings.84": "ui.sanity_settings.80",
};
for (const e of [...mapFrontend, ...mapRust]) {
  if (INTENTIONAL[e.key]) {
    if (messages[e.key] !== INTENTIONAL[e.key]) {
      add("map", `${e.key} 应为「${INTENTIONAL[e.key]}」，实际「${messages[e.key] ?? "（缺）"}」`);
    }
    continue;
  }
  if (messages[e.key] === undefined) {
    const target = MERGED[e.key];
    if (target) {
      if (messages[target] === undefined) {
        add("map", `${e.key} 的合并目标 ${target} 不在 messages 里（片段整句化后归属丢了）`);
      }
      continue;
    }
    if (!DELETED.has(e.key)) {
      add("map", `${e.file}:${e.line} 的 key ${e.key} 不在 messages 里（迁移丢了？）`);
    }
    continue;
  }
  if (messages[e.key] !== e.value) {
    // 3.0b₁ 的整改会改值：以 audit.json 为准（下面 2b 会把 audit.to 也校一遍）
    if (audit[`changed:${e.key}`]) continue;
    add("map", `${e.key} 与迁移记录不一致：「${e.value}」→「${messages[e.key]}」（未登记改动）`);
  }
}

// round74（6b P2-2a）：整改台账本身也要被校验 —— 否则 130 条改动被改坏/被改回去也全线绿灯
// （round74 片段整句化删掉的键跳过：它们的内容已并入 MERGED 的目标键，见上）
for (const [id, rec] of Object.entries(audit)) {
  const key = id.replace(/^changed:/, "");
  if (MERGED[key]) continue;
  if (messages[key] !== rec.to) {
    add("audit", `${key}：整改记录说要改成「${rec.to}」，实际「${messages[key] ?? "（缺）"}」`);
  }
}

// ---------------------------------------------------------------- 3) 机械扫

const CJK = "\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef";
const GLOSSARY_ALLOW = (key, value, term) => {
  // 逐条允许：术语表里的 allow 是「子串允许」清单
  const rule = (glossary.banned ?? []).find((b) => b.term === term);
  if (!rule) return false;
  if ((rule.allowKeys ?? []).some((p) => key.startsWith(p))) return true;
  return (rule.allow ?? []).some((sub) => value.includes(sub));
};

for (const [key, value] of Object.entries(messages)) {
  // 省略号：`...` 违规；`……` 只允许说明页长文
  if (value.includes("...")) add("ellipsis", `${key} 用了三个点（C8 统一用 …）：${value.slice(0, 60)}`);
  if (value.includes("……") && !key.startsWith("help.")) {
    add("ellipsis", `${key} 用了「……」（只有说明页长文可用）：${value.slice(0, 60)}`);
  }
  // 中英/数字与中文相邻无空格
  for (const m of value.matchAll(new RegExp(`[${CJK}]\\s?[A-Za-z0-9]|[A-Za-z0-9]\\s?[${CJK}]`, "g"))) {
    const around = value.slice(Math.max(0, m.index - 4), m.index + 6);
    if (/^[\u4e00-\u9fff][)）]/.test(around)) continue;
    if (/[\u3000-\u303f\uff00-\uffef]/.test(m[0])) continue; // 全角标点不算相邻
    // 「N 个」「2 小时」算合规（数字与中文之间要空格）；这里只抓**没空格**的
    if (!/\s/.test(m[0])) add("space", `${key} 中英/数字之间缺空格：…${around}…`);
  }
  // 情态「得」
  for (const m of value.matchAll(/得(?=[是为写做用有能该要])/g)) {
    add("de", `${key} 情态「得」：…${value.slice(Math.max(0, m.index - 6), m.index + 8)}…`);
  }
  // 术语禁用词
  for (const rule of glossary.banned ?? []) {
    if (value.includes(rule.term) && !GLOSSARY_ALLOW(key, value, rule.term)) {
      add("term", `${key} 用了禁用词「${rule.term}」（应说：${rule.use}）：${value.slice(0, 60)}`);
    }
  }
  // 第一人称（成就名按 H4 有梗的例外；其余一律红）
  for (const w of glossary.firstPerson ?? []) {
    if (value.includes(w)) {
      if (/^ach\.[\w.]+\.name$/.test(key)) infos.push(`成就名里的第一人称（H4 例外）：${key} = ${JSON.stringify(value).slice(0, 40)}`);
      else add("person", `${key} 出现第一人称「${w}」：${value.slice(0, 60)}`);
    }
  }
  // 提示档（round74 / 6b P2-4）：glossary 是唯一源 —— 「我」这类只提示，不计违规
  for (const w of glossary.firstPersonHint ?? []) {
    if (value.includes(w)) infos.push(`第一人称（提示档，不计违规）：${key} = ${JSON.stringify(value).slice(0, 40)}`);
  }
  // 感叹号
  if (value.includes("！")) add("bang", `${key} 出现感叹号：${value.slice(0, 60)}`);
  // 大括号占位：必须成对且是 {name}/{{/}}
  const stripped = value.replace(/\{\{|\}\}|\{[a-zA-Z_][\w]*\}/g, "");
  if (stripped.includes("{") || stripped.includes("}")) {
    add("braces", `${key} 有不成对/非法的花括号：${value.slice(0, 60)}`);
  }
}

// ---------------------------------------------------------------- 4) 调用点参数

/** 收集「值里该有的占位」 */
const placeholdersOf = (value) => {
  const out = new Set();
  for (const m of value.matchAll(/\{([a-zA-Z_][\w]*)\}/g)) out.add(m[1]);
  return out;
};

/** 从 `t("key"` 或 `tf!(i18n::msg::CONST` 的调用点里取参数名 */
function paramNamesFrom(callTail, style) {
  // callTail 从 ( 或 , 后的 `{` 开始；返回 [start, names]
  const names = [];
  let i = callTail.indexOf("{");
  if (i < 0) return names;
  let depth = 0;
  let start = i;
  let j = i;
  while (j < callTail.length) {
    const c = callTail[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) break;
    }
    j++;
  }
  const body = callTail.slice(i + 1, j);
  for (const part of splitTop(body)) {
    if (style === "js") {
      const m = /^\s*([A-Za-z_$][\w$]*)\s*(:|$)/.exec(part);
      if (m) names.push(m[1]);
    } else {
      const m = /^\s*([A-Za-z_][\w]*)\s*=/.exec(part);
      if (m) names.push(m[1]);
    }
  }
  void start;
  return names;
}

function splitTop(body) {
  const out = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < body.length && body[i] !== q) {
        if (body[i] === "\\") i++;
        i++;
      }
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  out.push(body.slice(start));
  return out;
}

const keyConstName = (key) => key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
const constToKey = new Map(Object.keys(messages).map((k) => [keyConstName(k), k]));

// ---------------------------------------------------------------- 4b) C13：只有符号的按钮必须有可访问名

/** 取 `<button` 起始处往后、属性区结束的 `>` 位置（跳过引号与 `{}` 表达式） */
function buttonTagEnd(text, i) {
  let q = null;
  let d = 0;
  for (let k = i; k < text.length; k++) {
    const c = text[k];
    if (q) {
      if (c === "\\") k++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "{") { d++; continue; }
    if (c === "}") { d--; continue; }
    if (c === ">" && d === 0) return k + 1;
  }
  return text.length;
}

/** 按钮内容里剥掉标签与 `{}` 表达式后的可见字符（用来判「只有符号」） */
function buttonVisible(inner) {
  let out = "";
  let d = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "{") { d++; continue; }
    if (c === "}") { d = Math.max(0, d - 1); continue; }
    if (d === 0) out += c;
  }
  return decodeEntities(out.replace(/<[^>]*>/g, "")).replace(/\s+/g, "");
}

const NON_TEXT_CHAR = /[A-Za-z0-9\u4e00-\u9fff]/;

/** 找配对 `</button>`（Svelte 里常被格式化成 `</button\n>` —— 不能只 indexOf 精确串） */
function findButtonClose(text, from) {
  for (;;) {
    const at = text.indexOf("</button", from);
    if (at < 0) return null;
    let k = at + 8;
    while (k < text.length && /\s/.test(text[k])) k++;
    if (text[k] === ">") return { start: at, end: k + 1 };
    from = at + 8;
  }
}

function checkSymbolButtons(rel, text) {
  let idx = 0;
  for (;;) {
    const open = text.indexOf("<button", idx);
    if (open < 0) break;
    const end = buttonTagEnd(text, open);
    const close = findButtonClose(text, end);
    if (!close) break;
    const attrs = text.slice(open, end);
    const inner = text.slice(end, close.start);
    idx = close.end;
    const vis = buttonVisible(inner);
    const hasIcon = /<svg|<img/i.test(inner);
    if (!hasIcon && !vis) continue;
    if (!hasIcon && NON_TEXT_CHAR.test(vis)) continue;
    if (/\b(title|aria-label)\s*=/.test(attrs)) continue;
    const line = text.slice(0, open).split("\n").length;
    add("c13", `${rel}:${line} 只有符号的按钮没有 title / aria-label（可见：${JSON.stringify(vis || "<icon>")}）`);
  }
}

const frontendFiles = walkSource(path.join(repoRoot, "src"));
/** `t("key")` 直调的 key（round74：用来查「有英文复数却还在用 t」的调用点） */
const tCalled = new Set();
/** `tn("key", n)` 的 key（用来查「用了 tn 却没英文复数形式」） */
const tnCalled = new Set();
for (const full of frontendFiles) {
  const rel = path.relative(repoRoot, full).replace(/\\/g, "/");
  const text = readFileSync(full, "utf8");
  if (rel.endsWith(".svelte")) checkSymbolButtons(rel, text);
  // round74（3.0b₂）：`t(` 与复数 `tn(` 都要校参（tn 的值仍是 zh 的 base key）
  const re = /\bt(n)?\(\s*"([a-z][\w.]*\.[\w.]+)"\s*(?=[,)])/g;
  let m;
  while ((m = re.exec(text))) {
    const key = m[2];
    const isPlural = !!m[1];
    const value = messages[key];
    if (value === undefined) {
      add("call", `${rel} 用了不存在的 key：${key}`);
      continue;
    }
    // 解析这次调用本身（t / tn 都行）：最后一个以 `{` 开头的顶层参数 = 参数字典
    // （tn 的第二个参数是数量，不能拿它当参数字典 —— 老写法只看「紧跟着 , {」会误判）
    const open = text.indexOf("(", m.index);
    const callEnd = matchParen(text, open, text.length);
    const args = splitTop(text.slice(open + 1, callEnd - 1)).slice(1);
    const objArg = args.map((a) => a.trim()).find((a) => a.startsWith("{"));
    const names = objArg ? paramNamesFrom(objArg, "js") : [];
    tCalled.add(key);
    if (isPlural) { tnCalled.add(key); tCalled.delete(key); }
    checkNames("call", rel, key, value, names);
  }
}
for (const full of walkSource(path.join(repoRoot, "src-tauri/src"))) {
  const rel = path.relative(repoRoot, full).replace(/\\/g, "/");
  if (rel.endsWith("i18n.rs")) continue;
  const text = readFileSync(full, "utf8");
  const re = /\btf!\(\s*i18n::msg::([A-Z0-9_]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const key = constToKey.get(m[1]);
    if (!key) {
      add("call", `${rel} 用了不存在的常量：${m[1]}`);
      continue;
    }
    // 取出 tf!(  的括号整体（**不能**只找下一个 }，那会吃过界 —— 踩过）
    const open = text.indexOf("(", m.index);
    const end = matchParen(text, open, text.length);
    const body = text.slice(open + 1, end - 1);
    const args = splitTop(body).slice(1);
    const names = args
      .map((a) => {
        const mm = /^\s*([A-Za-z_]\w*)\s*=/.exec(a);
        return mm ? mm[1] : null;
      })
      .filter(Boolean);
    checkNames("call", rel, key, messages[key], names);
  }
  // round74（6b P2-11）：直调 i18n::t(msg::X) 没有参数可给 —— 值里有占位就必须用 tf!
  const reDirect = /\bi18n::t\(\s*(?:i18n::)?msg::([A-Z0-9_]+)\s*\)/g;
  while ((m = reDirect.exec(text))) {
    const key = constToKey.get(m[1]);
    if (!key) {
      add("call", `${rel} 用了不存在的常量：${m[1]}`);
      continue;
    }
    const want = placeholdersOf(messages[key] ?? "");
    if (want.size > 0) {
      add("call", `${rel} 的 ${key} 值里有占位 {${[...want].join("} {")}}，但用的是无参 i18n::t()（应用 tf!）`);
    }
  }
}

function checkNames(kind, rel, key, value, names) {
  const want = placeholdersOf(value ?? "");
  const got = new Set(names);
  for (const w of want) if (!got.has(w)) add(kind, `${rel} 的 ${key} 少给占位 {${w}}（值：「${(value ?? "").slice(0, 50)}」）`);
  for (const g of got) if (!want.has(g)) add(kind, `${rel} 的 ${key} 多给参数 ${g}（值里没有 {${g}}）`);
}

// ---------------------------------------------------------------- 5) 提示

const seen = new Map();
for (const [key, value] of Object.entries(messages)) {
  if (!seen.has(value)) seen.set(value, []);
  seen.get(value).push(key);
}
for (const [value, keys] of seen) {
  if (keys.length > 1 && value.length > 3) infos.push(`重复文案 ×${keys.length}：${JSON.stringify(value).slice(0, 50)} → ${keys.slice(0, 4).join(", ")}`);
}

// ---------------------------------------------------------------- 6) 英文表（round74 / 3.0b₂）

const CJK_ANY = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const en = readJson("messages/en.json", {});
const built = buildEn(messages, loadValues(), loadOverrides());
for (const m of built.missing) add("en", `en 表缺：${m}`);
for (const [key, value] of Object.entries(built.en)) {
  if (en[key] === undefined) {
    add("en", `en 缺 ${key}（工作表有、en.json 没有 —— 忘了 --emit？）`);
    continue;
  }
  if (en[key] !== value) {
    add("en", `en 的 ${key} 与工作表不一致（en.json 手改过？重跑 --emit）`);
    continue;
  }
  const base = key.replace(/\.(one|other)$/, "");
  const zhValue = messages[base];
  if (zhValue === undefined) {
    add("en", `${key} 没有对应的中文 base`);
    continue;
  }
  const a = [...placeholdersOf(value)].sort().join(",");
  const b = [...placeholdersOf(zhValue)].sort().join(",");
  if (a !== b) add("en", `${key} 占位不一致：zh {${b}} vs en {${a}}`);
  if (CJK_ANY.test(value)) add("en", `${key} 英文里还有中文：${value.slice(0, 40)}`);
}
for (const key of Object.keys(en)) {
  if (built.en[key] === undefined) add("en", `en.json 多出 ${key}（工作表里没有）`);
}
for (const key of Object.keys(en)) {
  if (key.endsWith(".one") && en[`${key.slice(0, -4)}.other`] === undefined) add("en", `${key} 缺配对的 .other`);
  if (key.endsWith(".other") && en[`${key.slice(0, -6)}.one`] === undefined) add("en", `${key} 缺配对的 .one`);
  if (key.endsWith(".one")) {
    const base = key.slice(0, -4);
    if (tCalled.has(base)) add("en", `${base} 有英文复数形式，但调用点用的是 t()（应改用 tn()，否则英文回落中文）`);
  }
}
// 反向：用了 tn() 却没有英文复数形式 → 英文会把 base 串当所有数量用（如「1 tasks」）
for (const key of tnCalled) {
  if (en[`${key}.one`] === undefined || en[`${key}.other`] === undefined) {
    add("en", `${key} 用了 tn()，但英文表没有 .one/.other（1 也套 base 串）`);
  }
}

// ---------------------------------------------------------------- 输出

const byKind = {};
for (const v of violations) byKind[v.kind] = (byKind[v.kind] ?? 0) + 1;
if (asJson) {
  console.log(JSON.stringify({ violations, infos, counts: byKind, messages: Object.keys(messages).length }, null, 1));
} else {
  console.log(`messages ${Object.keys(messages).length} 条；违规 ${violations.length}（${JSON.stringify(byKind)}）`);
  for (const v of violations.slice(0, Number(process.env.SHOW ?? 60))) console.log(`  [${v.kind}] ${v.msg}`);
  if (violations.length > Number(process.env.SHOW ?? 60)) console.log(`  …（共 ${violations.length} 条，SHOW=all 看全部）`);
  if (process.env.SHOW === "all") for (const v of violations) console.log(`  [${v.kind}] ${v.msg}`);
  if (infos.length && process.env.INFO) {
    console.log(`\n提示 ${infos.length} 条：`);
    for (const i of infos.slice(0, 30)) console.log(`  ${i}`);
  }
}
process.exit(violations.length ? 1 : 0);
