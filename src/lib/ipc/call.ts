import { invoke } from "@tauri-apps/api/core";
import { toast } from "../stores/ui.svelte";

/**
 * 所有 Tauri 命令调用的唯一入口：失败时弹 Toast 并继续抛出，绝不静默失败。
 * 组件里不允许直接 invoke，只能经过 ipc/ 下的函数。
 */
export async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    toast(String(e));
    throw e;
  }
}
