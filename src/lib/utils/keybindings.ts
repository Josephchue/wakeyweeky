/**
 * round82（3.1c₂ · `绑-01…20`）：**可改命令键的注册表 + 组合键纯逻辑**（唯一实现）。
 *
 * 数据流：本表（id / 默认组合 / 作用域 / 文案键）→ `stores/keymap.svelte.ts`（用户覆盖，存 `key_bindings`）
 * → 各按键监听点只问 `matches(event, id)`；`?` 总表与设置里的编辑器都从注册表/store 取显示串（C5 同源）。
 *
 * 不在表里的（`绑-02`）：`Esc` / `Tab` / `Enter` / `Del` / 方向键 / `WASD` / `Space` / `X` / `Ctrl+Z` 一族
 * 是**操作语义、保持硬编码**；浏览器加速键（`F5` / `Ctrl+R` / `F12`…）录制时**直接拒绝**（`绑-20`，真机实测会重载页面）。
 *
 * 规范化（C2）：修饰顺序固定 `Ctrl → Shift → Alt → Win`；**字母保 shift**（`Shift+T` 与 `T` 是两个组合）、
 * 数字 / 符号按 `event.key` 的**产出值**落地（`?` 就是 `?`，不写 `Shift+/`）；`AltGr` / `Dead` / IME 组词忽略。
 */
import type { MsgKey } from "../i18n/i18n.svelte";

// ---------------------------------------------------------------- 命令表（唯一数据源）

export type CommandId =
  | "goNow"
  | "keyHelp"
  | "settings"
  | "review"
  | "stats"
  | "newTask"
  | "selectAll"
  | "rename"
  | "followMove"
  | "followCopy";

/**
 * 作用域（照 `键-04` 的优先级分层，不新造）：冲突只在**同层**里算；
 * 跨层撞键 = 真语义（谁在外面谁先吃到），允许保存但提示。
 */
export type CommandScope = "global" | "block";

export type CommandDef = {
  id: CommandId;
  /** 默认组合（**规范串**；字母小写，见文件头） */
  combo: string;
  scope: CommandScope;
  /** 动作名（`?` 总表与编辑器共用；键名本身不翻译） */
  label: MsgKey;
};

export const COMMANDS: CommandDef[] = [
  { id: "goNow", combo: "t", scope: "global", label: "msg.keyboard_help.49" },
  { id: "keyHelp", combo: "?", scope: "global", label: "msg.keyboard_help.50" },
  { id: "settings", combo: "Ctrl+,", scope: "global", label: "msg.keyboard_help.51" },
  { id: "review", combo: "o", scope: "global", label: "msg.keyboard_help.47" },
  { id: "stats", combo: "s", scope: "global", label: "msg.keyboard_help.48" },
  { id: "newTask", combo: "c", scope: "global", label: "ui.keymap_panel.21" },
  { id: "selectAll", combo: "Ctrl+a", scope: "global", label: "msg.keyboard_help.29" },
  { id: "rename", combo: "F2", scope: "block", label: "ui.keymap_panel.18" },
  { id: "followMove", combo: "Ctrl+x", scope: "block", label: "ui.keymap_panel.22" },
  { id: "followCopy", combo: "Ctrl+c", scope: "block", label: "ui.keymap_panel.23" },
];

export const commandById = (id: CommandId): CommandDef =>
  COMMANDS.find((c) => c.id === id) as CommandDef;

/** 默认生效表（全默认；不含用户覆盖）——`keyboard-help` 的测试与「恢复默认」都读它 */
export const DEFAULT_BINDINGS: Record<CommandId, string> = Object.fromEntries(
  COMMANDS.map((c) => [c.id, c.combo]),
) as Record<CommandId, string>;

// ---------------------------------------------------------------- 组合键解析 / 规范化

export type ParsedCombo = { key: string; ctrl: boolean; shift: boolean; alt: boolean; win: boolean };

const MOD_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);

/** `+` 键与分隔符冲突 → 规范串里写成 `Plus`（显示与解析都走这两个函数） */
const KEY_ALIASES: Record<string, string> = { Plus: "+" };

export function serializeCombo(c: ParsedCombo): string {
  const parts: string[] = [];
  if (c.ctrl) parts.push("Ctrl");
  if (c.shift) parts.push("Shift");
  if (c.alt) parts.push("Alt");
  if (c.win) parts.push("Win");
  parts.push(c.key === "+" ? "Plus" : c.key);
  return parts.join("+");
}

/** 规范串 → 结构；不认识 / 不合法 → null（坏值逐条回落靠它） */
export function parseCombo(raw: string): ParsedCombo | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const parts = text.split("+");
  const keyRaw = parts.pop();
  if (!keyRaw) return null;
  const out: ParsedCombo = { key: KEY_ALIASES[keyRaw] ?? keyRaw, ctrl: false, shift: false, alt: false, win: false };
  for (const mod of parts) {
    if (mod === "Ctrl") out.ctrl = true;
    else if (mod === "Shift") out.shift = true;
    else if (mod === "Alt") out.alt = true;
    else if (mod === "Win") out.win = true;
    else return null; // 未知修饰符 = 坏值
  }
  if (out.key.length === 0 || out.key.length > 12) return null;
  return out;
}

/** 显示串：字母大写、`+` 键写 `Plus`（`?` / `!` / `Ctrl+,` 原样） */
export function formatCombo(raw: string): string {
  const c = parseCombo(raw);
  if (!c) return raw;
  const key = /^[a-z]$/.test(c.key) ? c.key.toUpperCase() : c.key;
  return serializeCombo({ ...c, key });
}

/** 从一次 keydown 取规范串（C2 的全部边界都在这里）；取不到（修饰键 / 死键 / IME）→ null */
export function normalizeEvent(e: KeyboardEvent): string | null {
  if (e.isComposing || e.keyCode === 229) return null; // IME 组词中
  if (e.key === "Dead" || e.key === "Unidentified") return null;
  if (MOD_KEYS.has(e.key)) return null; // 只按了修饰键 —— 还没落定
  if (e.getModifierState("AltGraph")) return null; // AltGr
  const single = e.key.length === 1;
  const key = single && /[a-z]$/i.test(e.key) ? e.key.toLowerCase() : e.key;
  return serializeCombo({
    key,
    ctrl: e.ctrlKey,
    // 字母**保** shift（Shift+T ≠ T）；数字 / 符号的 shift 已经体现在产出字符里（? / ! / Plus）→ 丢掉
    shift: single && !/[a-z]$/i.test(e.key) ? false : e.shiftKey,
    alt: e.altKey,
    win: e.metaKey,
  });
}

/** 没有修饰键的组合（= 字符键 → 受「键盘快捷键」总开关管；`键-04`） */
export function isSingleKeyCombo(combo: string): boolean {
  const c = parseCombo(combo);
  return !!c && !c.ctrl && !c.shift && !c.alt && !c.win;
}

/** 录制中的「实时预览」：只按了修饰键时显示已经按住哪些（主键落定才算数；C1 边界表） */
export function heldModifiers(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Win");
  return parts.join("+");
}

// ---------------------------------------------------------------- 黑名单（录制时拒绝）

/** 系统占用（应用根本收不到） */
const SYSTEM_RESERVED = new Set([
  "Ctrl+Alt+Delete",
  "Ctrl+Shift+Escape",
  "Alt+Tab",
  "Alt+Escape",
  "Alt+F4",
  "Ctrl+Escape",
  "PrintScreen",
]);

/** 窗口 / 浏览器占用（`F5` / `Ctrl+R` 真机实测会重载页面；其余归 WebView2） */
const WINDOW_RESERVED = new Set([
  "F5",
  "Ctrl+r",
  "F3",
  "Ctrl+f",
  "Ctrl+p",
  "Ctrl+0",
  "Ctrl+-",
  "Ctrl+=",
  "Ctrl+Plus",
  "Ctrl+Shift+=",
  "F12",
  "Ctrl+Shift+i",
  "Ctrl+Shift+j",
  "Ctrl+Shift+c",
  "Ctrl+u",
  "Alt+ArrowLeft",
  "Alt+ArrowRight",
  "Alt+Home",
]);

/** 本应用锁定（管操作语义，`绑-02`）。
 *  ⚠️ `s` 是**双角色**：块内 = 往下（WASD），没选中块时 = 默认的「打开统计」——
 *  录制时仍拒收（别的命令别想占用它），但**允许录回自己当前的值**（见 `KeymapPanel`）。 */
const APP_LOCKED = new Set([
  "Escape",
  "Tab",
  "Enter",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "w",
  "a",
  "s",
  "d",
  " ",
  "x",
  "Ctrl+z",
  "Ctrl+Shift+z",
  "Ctrl+y",
]);

export type LockedReason = "system" | "window" | "app";

/** 这个组合能不能当快捷键？不能 → 给三档之一（文案键在编辑器里） */
export function lockedReason(combo: string): LockedReason | null {
  const c = parseCombo(combo);
  if (!c) return "app"; // 坏串按「不能改」处理
  if (c.win) return "system"; // Win+* 全归系统
  if (SYSTEM_RESERVED.has(combo)) return "system";
  if (WINDOW_RESERVED.has(combo)) return "window";
  if (APP_LOCKED.has(combo)) return "app";
  return null;
}

// ---------------------------------------------------------------- 冲突

export type Conflict = { id: CommandId; kind: "hard" | "soft" };

/**
 * 找冲突（同层 = hard 拒绝保存；跨层 = soft 允许但提示）。
 * `exceptId` = 正在改的那条自己不算。
 */
export function findConflict(
  combo: string,
  scope: CommandScope,
  bindings: Record<string, string>,
  exceptId: CommandId,
): Conflict | null {
  for (const cmd of COMMANDS) {
    if (cmd.id === exceptId) continue;
    if (bindings[cmd.id] !== combo) continue;
    return { id: cmd.id, kind: cmd.scope === scope ? "hard" : "soft" };
  }
  return null;
}

// ---------------------------------------------------------------- 一条用户的 JSON → 生效表（`绑-09`）

/**
 * 逐条回落：坏 JSON / 未知 id / 坏串 / 被锁的串 → 那一条回默认，**其余条目照用**。
 * 返回值 = 生效表（全量，含默认）。
 */
export function resolveBindings(raw: string): Record<CommandId, string> {
  const out = { ...DEFAULT_BINDINGS };
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [id, value] of Object.entries(parsed)) {
    const def = COMMANDS.find((c) => c.id === id);
    if (!def) continue; // 未知 id（旧版本 / 手改）→ 忽略
    if (typeof value !== "string") continue;
    const parsed = parseCombo(value);
    if (!parsed) continue;
    const canonical = serializeCombo(parsed);
    if (lockedReason(canonical)) continue; // 存进来的锁定键 = 坏值（编辑器本来就不让存）
    out[def.id] = canonical;
  }
  return out;
}

/** 生效表 → 只存「和默认不一样」的覆盖（默认将来变了，没改过的条目跟着变） */
export function bindingsToStored(bindings: Record<string, string>): string {
  const out: Record<string, string> = {};
  for (const cmd of COMMANDS) {
    if (bindings[cmd.id] !== cmd.combo) out[cmd.id] = bindings[cmd.id];
  }
  return JSON.stringify(out);
}
