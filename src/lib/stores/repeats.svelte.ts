/**
 * round69（B3）：**每周重复**的前端状态 —— Backlog 的 ⚙ 面板读写规则。
 *
 * 生成不在这里：打开某一周时后端 `generate_repeats` 自己排（见 `stores/blocks.svelte.ts::reloadWeek`）。
 * 规则按任务缓存；面板打开那一刻拉一次，写完全部重拉（与 `tasks` 的写法同一套）。
 */
import type { Repeat } from "../ipc/types";
import {
  createRepeat as ipcCreate,
  deleteRepeat as ipcDelete,
  listRepeats as ipcList,
  setRepeatEnabled as ipcSetEnabled,
} from "../ipc/repeats";
import { reloadWeek } from "./blocks.svelte";
import { featureOn } from "./settings.svelte";

export const repeats = $state<{ byTask: Record<string, Repeat[]> }>({ byTask: {} });

/** 某个任务当前的规则（没拉过 = 空数组） */
export function rulesOf(taskId: string): Repeat[] {
  return repeats.byTask[taskId] ?? [];
}

/** 拉某个任务的规则；功能开关关掉 → 直接当空（不打扰后端） */
export async function loadRepeats(taskId: string): Promise<void> {
  if (!featureOn("repeat_enabled")) {
    repeats.byTask[taskId] = [];
    return;
  }
  try {
    repeats.byTask[taskId] = await ipcList(taskId);
  } catch {
    // ipc 层已弹 Toast
  }
}

/** 加一条规则（成功返回 true；调用方弹提示）
 *
 * round69.1（#3）：写完**立刻重拉这一周** —— `reloadWeek` 里就有「打开哪一周补哪一周」的生成。
 * 旧写法只重拉规则列表 → 用户加完看不出任何动静，又去点「＋ 添加」得到「这个时段已经有重复规则了」
 * （你验收图1/图3 的现场）。
 */
export async function addRepeat(
  taskId: string,
  weekday: number,
  startMin: number,
  layer: Repeat["layer"],
): Promise<boolean> {
  try {
    await ipcCreate(taskId, weekday, startMin, layer);
    await loadRepeats(taskId);
    await reloadWeek();
    return true;
  } catch {
    return false; // ipc 层已弹 Toast（含后端的中文校验错误）
  }
}

/** 暂停 / 启用一条规则
 *
 * round69.1（#4）：暂停会把**未开始的**生成块一同撤下（后端做）→ 重拉这一周才看得到；
 * 重新启用时水位线已清，若时刻还没到会再排上。
 */
export async function toggleRepeat(taskId: string, id: string, enabled: boolean): Promise<boolean> {
  try {
    await ipcSetEnabled(id, enabled);
    await loadRepeats(taskId);
    await reloadWeek();
    return true;
  } catch {
    return false;
  }
}

/** 删一条规则（可 Ctrl+Z 撤销）；同样把未开始的生成块一起撤下（后端做） */
export async function removeRepeat(taskId: string, id: string): Promise<boolean> {
  try {
    await ipcDelete(id);
    await loadRepeats(taskId);
    await reloadWeek();
    return true;
  } catch {
    return false;
  }
}
