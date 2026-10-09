import { call } from "./call";

type HistoryFocus = { start_at: number; ids: string[] };

/** 撤销/重做的结果：撤掉（重做）了什么 + 视角该开在哪（`focus` 空 = 没有时间轴落点） */
export type HistoryOutcome = { label: string; focus?: HistoryFocus | null };

/** C1.5：撤销上一步（整表回滚，后端做）。**栈只在内存里**，重启即清空 */
export function undo(): Promise<HistoryOutcome> {
  return call<HistoryOutcome>("undo");
}

/** C1.5：重做（撤销之后才能用） */
export function redo(): Promise<HistoryOutcome> {
  return call<HistoryOutcome>("redo");
}
