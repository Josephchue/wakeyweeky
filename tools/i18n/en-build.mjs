// round74（3.0b₂）：英文工作表 → `messages/en.json` 的**唯一构建实现**。
//
// 数据流：
//   messages/zh.json（唯一源，键顺序）
//     + tools/i18n/en-values/*.json（**按值**翻译：zh 值 → en 字符串；同一句只翻一遍）
//     + tools/i18n/en-overrides.json（**按键**例外：复数 one/other、同值不同译）
//        → messages/en.json（en 缺的键回落 zh，但本批判据要求 0 缺）
//
// 复数约定：override 写成 {"one": "...", "other": "..."} → 展开成 `key.one` / `key.other`
// （zh 侧保留 base 键；`tn()` 在英文时查这两个后缀 —— 见 src/lib/i18n/i18n.svelte.ts）。

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const P = (rel) => path.join(repoRoot, rel);

function readJson(rel, fallback) {
  const p = P(rel);
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`读不了 ${rel}：${e.message}`);
  }
}

/** @param {Record<string,string>} zh @param {Record<string,unknown>} values @param {Record<string,unknown>} overrides */
export function buildEn(zh, values, overrides) {
  const en = {};
  const missing = [];
  const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
  for (const [key, zhValue] of Object.entries(zh)) {
    const ov = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : undefined;
    const val = ov !== undefined ? ov : values[zhValue];
    if (val === undefined) {
      missing.push(key);
      continue;
    }
    if (val && typeof val === "object") {
      if (typeof val.one !== "string" || typeof val.other !== "string") {
        missing.push(`${key}（复数要 one/other 两条）`);
        continue;
      }
      en[`${key}.one`] = val.one;
      en[`${key}.other`] = val.other;
      continue;
    }
    if (typeof val !== "string") {
      missing.push(`${key}（值类型不对）`);
      continue;
    }
    if (CJK.test(val)) {
      missing.push(`${key}（英文里还有中文）`);
      continue;
    }
    en[key] = val;
  }
  return { en, missing };
}

/** 占位集合（`{name}`） */
export const placeholders = (s) => new Set([...String(s).matchAll(/\{([a-zA-Z_][\w]*)\}/g)].map((m) => m[1]));

/** 合并 `en-values/` 下所有批文件；同一句两种翻法 = 报错（翻译只该有一份） */
export function loadValues() {
  const dir = P("tools/i18n/en-values");
  if (!existsSync(dir)) return {};
  const merged = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let part;
    try {
      part = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    } catch (e) {
      throw new Error(`读不了 en-values/${file}：${e.message}`);
    }
    for (const [zh, en] of Object.entries(part)) {
      if (merged[zh] !== undefined && JSON.stringify(merged[zh]) !== JSON.stringify(en)) {
        throw new Error(`同一句两种翻法（${file}）：${JSON.stringify(zh).slice(0, 40)}`);
      }
      merged[zh] = en;
    }
  }
  return merged;
}

export function loadOverrides() {
  return readJson("tools/i18n/en-overrides.json", {});
}

export function loadZh() {
  return readJson("messages/zh.json", {});
}

