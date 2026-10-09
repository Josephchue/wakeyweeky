import { call } from "./call";
import type { Repeat } from "./types";

/**
 * round69（B3）：每周重复的 IPC 层 —— 与 Rust `commands/repeats.rs` 一一对应。
 * 写命令在后端都走 `record`（一次 = 一步撤销）。
 */

/** 某个任务的规则（`taskId` 不传 = 全部） */
export function listRepeats(taskId?: string): Promise<Repeat[]> {
  return call<Repeat[]>("list_repeats", { taskId: taskId ?? null });
}

/** 加一条规则（周几 + 时刻；时长读任务的预估）；非法值后端返回中文错误 */
export function createRepeat(
  taskId: string,
  weekday: number,
  startMin: number,
  layer: Repeat["layer"],
): Promise<Repeat> {
  return call<Repeat>("create_repeat", { taskId, weekday, startMin, layer });
}

/** 暂停 / 启用一条规则 */
export function setRepeatEnabled(id: string, enabled: boolean): Promise<Repeat> {
  return call<Repeat>("set_repeat_enabled", { id, enabled });
}

/** 删一条规则 */
export function deleteRepeat(id: string): Promise<void> {
  return call<void>("delete_repeat", { id });
}

/** 打开某一周时补这一周的重复块；返回新建的块数（0 = 无事可做 / 开关关着） */
export function generateRepeats(weekStart: number): Promise<number> {
  return call<number>("generate_repeats", { weekStart });
}
