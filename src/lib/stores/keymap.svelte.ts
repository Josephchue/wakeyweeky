/**
 * round82（3.1c₂ · `绑-08…12`）：**用户键位表**（生效值 + 存取）—— 全应用只有这一份。
 *
 * 唯一持久化 = 设置键 `key_bindings`（JSON：id → 组合串；**只存与默认不同的**，默认以后改了没动过的跟着变）。
 * 逐条回落（`绑-09`）：坏 JSON / 未知 id / 坏串 / 被锁的串 → 那一条回默认，**其余条目照用**。
 * 显示与匹配同源（C5）：`?` 总表、编辑器、`matches()` 全读这里的 `bindingFor()` / `displayFor()`。
 */
import { setSetting } from "../ipc/settings";
import {
  COMMANDS,
  DEFAULT_BINDINGS,
  bindingsToStored,
  formatCombo,
  isSingleKeyCombo,
  normalizeEvent,
  resolveBindings,
  type CommandId,
} from "../utils/keybindings";

export const keymap = $state<{ bindings: Record<CommandId, string> }>({
  bindings: { ...DEFAULT_BINDINGS },
});

/** 设置读回来时全量落地（`settings.svelte.ts::applyValues` 调；缺键 = 全默认） */
export function initKeymap(stored: string | undefined): void {
  keymap.bindings = resolveBindings(stored ?? "");
}

export function bindingFor(id: CommandId): string {
  return keymap.bindings[id];
}

/** 给人看的键帽串（字母大写、`+` 键写 `Plus`） */
export function displayFor(id: CommandId): string {
  return formatCombo(keymap.bindings[id]);
}

/** 改过吗（编辑器「已改」标记 / 行尾「恢复默认」的判据） */
export function isModified(id: CommandId): boolean {
  return keymap.bindings[id] !== DEFAULT_BINDINGS[id];
}

/** 保存一条（写后端失败 → 不动内存，返回 false） */
export async function saveBinding(id: CommandId, combo: string): Promise<boolean> {
  if (!combo) return false;
  const next = { ...keymap.bindings, [id]: combo };
  try {
    await setSetting("key_bindings", bindingsToStored(next));
  } catch {
    return false;
  }
  keymap.bindings = next;
  return true;
}

export async function resetBinding(id: CommandId): Promise<boolean> {
  return saveBinding(id, DEFAULT_BINDINGS[id]);
}

/** 全部恢复默认 = 把覆盖清空（写 `{}`） */
export async function resetAllBindings(): Promise<boolean> {
  try {
    await setSetting("key_bindings", "{}");
  } catch {
    return false;
  }
  keymap.bindings = { ...DEFAULT_BINDINGS };
  return true;
}

/** 这一次按键命中这条命令吗（规范化后**全等**；C5） */
export function matches(e: KeyboardEvent, id: CommandId): boolean {
  const combo = normalizeEvent(e);
  return combo !== null && combo === keymap.bindings[id];
}

/** 指定命令当前是不是「单键」（字符键 → 受「键盘快捷键」总开关管；`键-04`） */
export function isSingleKey(id: CommandId): boolean {
  return isSingleKeyCombo(keymap.bindings[id]);
}

/** 冲突检查要用全表 */
export function allBindings(): Record<CommandId, string> {
  return keymap.bindings;
}

export { COMMANDS };
