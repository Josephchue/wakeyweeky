import { call } from "./call";
import type { Task } from "./types";

export function listTasks(): Promise<Task[]> {
  return call<Task[]>("list_tasks");
}

export function createTask(title: string, category: string | null): Promise<Task> {
  return call<Task>("create_task", { title, category });
}

/** 删除任务（round40）：返回**连带删掉的块数** —— 界面上的撤销条要说清楚毁掉了什么 */
export function deleteTask(id: string): Promise<number> {
  return call<number>("delete_task", { id });
}

/** 改任务属性（v2 ④ 的 update_task(id, patch)）：只传要改的字段；空串/0 = 清空 */
export function updateTask(
  id: string,
  patch: {
    title?: string;
    category?: string;
    estimatedMinutes?: number;
    isElastic?: boolean;
  },
): Promise<Task> {
  return call<Task>("update_task", {
    id,
    title: patch.title ?? null,
    category: patch.category ?? null,
    estimatedMinutes: patch.estimatedMinutes ?? null,
    isElastic: patch.isElastic ?? null,
  });
}

/** round48：任务级「不计入理智值」（一条任务 → 它**所有**块都不算；`⊘` 在 Backlog 那一行） */
export function setTaskExempt(id: string, exempt: boolean): Promise<Task> {
  return call<Task>("set_task_exempt", { id, exempt });
}

/** 归档任务（v2 ④ / ⑧B8）：写 archived_at，不删数据；归档后不再出现在 Backlog */
export function archiveTask(id: string): Promise<void> {
  return call<void>("archive_task", { id });
}

/** 取消归档（round38 / 任务面板的「恢复」）：把 archived_at 清空 —— 归档不再是单行道 */
export function unarchiveTask(id: string): Promise<void> {
  return call<void>("unarchive_task", { id });
}

/** 改任务名。后端做校验（非空 / ≤200 字 / id 存在），失败时 call 层会弹 Toast。 */
export function renameTask(id: string, title: string): Promise<Task> {
  return call<Task>("rename_task", { id, title });
}

/** round48：Backlog 的**手动顺序**（抓手拖动 / `↑↓` 走这里）—— 按给定顺序落 `sort_order`。
 *  返回**实际写了几条**（界面上不用提示，但断言要看得到）。 */
export function reorderTasks(ids: string[]): Promise<number> {
  return call<number>("reorder_tasks", { ids });
}

/** 8.1 分类管理：分类改名 / 合并 / 清空 —— 一次改掉整个分类下的所有任务（含已归档）。
 *  合并就是「改成一个已有分类名」；`to` 传空串 = 这些任务回到「未分类」。
 *  返回**后端实际改了几条**（界面上的提示要说清数字）。 */
export function renameCategory(from: string, to: string): Promise<number> {
  return call<number>("rename_category", { from, to });
}
