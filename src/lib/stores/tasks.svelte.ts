import { archiveTask as archiveTaskIpc, createTask, deleteTask, listTasks, renameCategory as renameCategoryIpc, renameTask as renameTaskIpc, reorderTasks as reorderTasksIpc, setTaskExempt as setTaskExemptIpc, unarchiveTask as unarchiveTaskIpc, updateTask as updateTaskIpc } from "../ipc/tasks";
import type { Task } from "../ipc/types";
import { categoryOrder } from "../utils/category-color";
import { reloadWeek } from "./blocks.svelte";

export const tasks = $state<Task[]>([]);

/** round76（3.1a）：分类顺序（按「该分类最早任务」的时间）—— 类别底边条配色的唯一依据。
 *  以**函数**暴露：Svelte 5 不允许从模块导出 `$derived`（组件里调用它就会建立依赖）。 */
const categoryOrderState = $derived(categoryOrder(tasks));
export function categoryOrderList(): string[] {
  return categoryOrderState;
}

/** round76（3.1a）：任务 id → 分类（块上画类别条 / tooltip 补「分类：X」用；避免每个块都 find 一遍） */
const taskCategoryState = $derived(new Map(tasks.map((t) => [t.id, t.category])));
export function taskCategoryById(id: string): string | null | undefined {
  return taskCategoryState.get(id);
}

export async function loadTasks() {
  const data = await listTasks();
  tasks.length = 0;
  tasks.push(...data);
}

/** 新建任务。round47：可以带上分类 —— 在「只看学习」里新建的任务直接归到那一类。
 *  round48：后端把新任务排在最上（`sort_order` 取当前最小值 − 1）→ 这里**插到最前面**，
 *  不然界面要等到下一次整表重拉才看得见它归位。 */
export async function addTask(title: string, category: string | null = null) {
  const task = await createTask(title, category);
  tasks.unshift(task);
  return task;
}

/** 删任务（round40）：**不再二次确认** —— 直接删 + 右下角一条带「撤销」的提示（`toastUndo`）；
 *  这里把后端回报的「连带删了几个块」交给调用方去说。 */
export async function removeTask(id: string): Promise<number> {
  const deletedBlocks = await deleteTask(id);
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx >= 0) tasks.splice(idx, 1);
  // 任务删掉后，它已排进时间轴的块由 ON DELETE CASCADE 一并删除 → 同步刷新界面
  await reloadWeek();
  return deletedBlocks;
}

/**
 * 改任务属性（v2 ④ 的 `update_task(id, patch)`）：标题 / 分类 / 预估时长 / 弹性任务。
 * 弹性任务会影响「它拖出来的块默认进哪一层」（规范 ⑧B7），所以改完要刷新本周。
 */
export async function updateTask(
  id: string,
  patch: { title?: string; category?: string; estimatedMinutes?: number; isElastic?: boolean },
) {
  const updated = await updateTaskIpc(id, patch);
  const task = tasks.find((t) => t.id === id);
  if (task) Object.assign(task, updated);
  await reloadWeek();
}

/** 归档任务（v2 ④ / ⑧B8）：数据与时间轴上的块都保留，只是不再出现在 Backlog。
 *  round28 #2：**不再把它从 store 里摘掉**，只改写 `archived_at` —— 因为时间轴上的块要靠它拿名字
 *  （以前摘掉 → 归档后那些块全变成「?」）；Backlog 自己按 `archived_at` 过滤。 */
export async function archiveTask(id: string) {
  await archiveTaskIpc(id);
  const task = tasks.find((t) => t.id === id);
  if (task) task.archived_at = Math.floor(Date.now() / 1000);
  await reloadWeek();
}

/** 取消归档（round38 / 任务面板的「恢复」）：与 `archiveTask` 同形状 —— 改写 store 里那一条 +
 *  刷新本周。数据一直没动过（块/事件/序列都在），所以不需要别的补偿。 */
export async function unarchiveTask(id: string) {
  await unarchiveTaskIpc(id);
  const task = tasks.find((t) => t.id === id);
  if (task) task.archived_at = null;
  await reloadWeek();
}

/** 改任务名：先比一下再发请求（名字没变就不写库）。
 *  时间轴上的名字是前端按 task_id 从本 store 取的（Timeline.svelte），
 *  所以这里改 `task.title` 就够，不需要刷新块、也不需要广播。 */
export async function renameTask(id: string, title: string) {
  const task = tasks.find((t) => t.id === id);
  const next = title.trim();
  if (!task || task.title === next) return;

  const updated = await renameTaskIpc(id, next);
  task.title = updated.title; // 以后端返回值为准（它做过 trim 与校验）
}

/**
 * round48：任务级「不计入理智值」（由任务决定，不由时间块决定）—— 它**所有**块都不算。
 * 改完要 `reloadWeek()`：日头小条与托盘超载态都跟着变。
 */
export async function setTaskExempt(id: string, exempt: boolean) {
  const updated = await setTaskExemptIpc(id, exempt);
  const task = tasks.find((t) => t.id === id);
  if (task) Object.assign(task, updated);
  await reloadWeek();
}

/**
 * round48：Backlog 的**手动顺序**（抓手拖动 / `↑↓`）。
 * 顺序本身是数据（`tasks.sort_order`），所以**整表重拉**最不容易出错 —— 反正就一张小表。
 */
export async function reorderTasks(ids: string[]) {
  const changed = await reorderTasksIpc(ids);
  await loadTasks();
  return changed;
}

/**
 * 8.1 分类管理：分类改名 / 合并 / 清空（合并 = 改成一个已有分类名；空串 = 回到「未分类」）。
 * 返回**后端实际改了几条** —— 界面上的提示要说清「改了几个」（与 `removeTask` 回报块数同一个口径）。
 *
 * 就地改 store 就够：分类**不参与块渲染**（时间轴上的块只拿任务名），所以不用整周重拉。
 */
export async function renameCategory(from: string, to: string): Promise<number> {
  const changed = await renameCategoryIpc(from, to);
  const src = from.trim();
  const next = to.trim() === "" ? null : to.trim();
  for (const task of tasks) {
    if (task.category === src) task.category = next;
  }
  return changed;
}
