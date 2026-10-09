/**
 * round73（3.0b₁）：**文案资源层（前端唯一实现）**。
 * round74（3.0b₂）：加**语言维度** —— `locale` 是响应式状态（`$state`），`t()` 读它 →
 * 组件模板 / `$derived` 自动重算；切换语言不用重启、也不用改任何调用点。
 *
 * 数据源 = 仓库根 `messages/{zh,en}.json`（与 Rust 侧**同一份**；Rust 由 `src-tauri/build.rs`
 * 编译期生成双语表）。键名口径、值里 `{name}` 占位、`{{`/`}}` 转义：见 `docs/plans/round73-i18n-and-copy.md` §3.1。
 *
 * - `t(key, params?)`：类型 = `keyof typeof zh`，打字错 = **编译错**（B6）。
 * - `tn(key, n, params?)`：复数（英语）—— 英文找 `key.one` / `key.other`；中文用 `key` 原值（两条同值）。
 * - 未给的占位原样保留（B1），不吞整句；en 缺键回落 zh（本批判据要求 0 缺，回落只是兜底）。
 * - `?pseudo=1`（仅预览/调试）：把值包成 `【…———】`，给英文版提前做长度压力（dev-only，不进设置）。
 */
import zh from "../../../messages/zh.json";
import en from "../../../messages/en.json";

export type Locale = "zh" | "en";
/** round81（3.1c₁ · 深-03）：设置里的**档位** —— `system` = 跟随系统（默认） */
export type LocaleChoice = "system" | "zh" | "en";
export type MsgKey = keyof typeof zh;
export type MsgParams = Record<string, string | number>;

const TABLES: Record<Locale, Record<string, string>> = { zh, en };

/** 档位规范化：只认 `system` / `zh` / `en`；旧库 / 坏值 → `system`（新默认） */
export function normalizeLocaleChoice(raw: string | undefined | null): LocaleChoice {
  return raw === "en" || raw === "zh" || raw === "system" ? raw : "system";
}

/**
 * 档位 → 实际语言（前端能**同步**算的那一部分）：固定档直接用；`system` 看 `navigator.language`
 * （`zh*` → zh，其余 → en；读不到 → zh 回落旧行为）。
 * Rust 侧有一条 `system_locale` 同源命令（`sys-locale`）—— 启动后由 store 后台校准，两边的源头写在这里。
 */
export function resolveLocaleChoice(choice: LocaleChoice): Locale {
  if (choice === "zh" || choice === "en") return choice;
  if (typeof navigator === "undefined" || !navigator.language) return "zh";
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** 当前语言（响应式；设置里切换 → `setLocale`）。默认中文 = 旧行为 */
let locale = $state<Locale>("zh");

/** 当前语言（只读；断言与调试用） */
export function getLocale(): Locale {
  return locale;
}

/** 切换语言：更新状态 + `<html lang>`（写设置与失败回拨由调用方负责，见 stores/settings） */
export function setLocale(next: Locale): void {
  locale = next;
  if (typeof document !== "undefined") {
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
  }
}

const PSEUDO =
  typeof location !== "undefined" && new URLSearchParams(location.search).has("pseudo");

/** 与 Rust `i18n::render` 同一套口径：`{{`/`}}` 是字面花括号；未提供的占位原样保留 */
export function fill(template: string, params?: MsgParams): string {
  let out = "";
  let rest = template;
  for (;;) {
    let idx = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "{" || rest[i] === "}") {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      out += rest;
      break;
    }
    out += rest.slice(0, idx);
    const after = rest.slice(idx);
    if (after.startsWith("{{")) {
      out += "{";
      rest = after.slice(2);
      continue;
    }
    if (after.startsWith("}}")) {
      out += "}";
      rest = after.slice(2);
      continue;
    }
    if (after[0] === "{") {
      const close = after.indexOf("}", 1);
      if (close < 0) {
        out += "{";
        rest = after.slice(1);
        continue;
      }
      const name = after.slice(1, close);
      if (params && Object.prototype.hasOwnProperty.call(params, name)) {
        out += String(params[name]);
      } else {
        out += after.slice(0, close + 1);
      }
      rest = after.slice(close + 1);
      continue;
    }
    out += "}";
    rest = after.slice(1);
  }
  return out;
}

/** 取一条文案（唯一入口；组件里不许再写中文字面量） */
export function t(key: MsgKey, params?: MsgParams): string {
  const table = TABLES[locale] as Record<string, string>;
  const raw = table[key as string] ?? (zh as Record<string, string>)[key as string];
  if (raw === undefined) return key as string; // 类型挡住了；真发生就把 key 露出来便于定位
  const text = fill(raw, params);
  return PSEUDO ? `【${text}———】` : text;
}

/**
 * 复数（round74 / 3.0b₂）：`tn(key, n, params)`
 * 英文取 `key.one` / `key.other`（`n === 1` 用 one）；中文用 `key` 的原值（中文没有单复数）。
 * 若这个 key 还没有英文复数形式，回落 `t(key, params)`（= 中文值），不会炸。
 */
export function tn(key: MsgKey, n: number, params?: MsgParams): string {
  const full = `${key}.${n === 1 ? "one" : "other"}`;
  const table = TABLES[locale] as Record<string, string>;
  const raw = locale === "en" ? table[full] : undefined;
  if (raw === undefined) return t(key, { ...params, n });
  const text = fill(raw, { ...params, n });
  return PSEUDO ? `【${text}———】` : text;
}
