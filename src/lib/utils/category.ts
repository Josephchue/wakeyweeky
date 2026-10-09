/**
 * 分类（`tasks.category`）的**共用口径**：统计 / 筛选 / 分堆。
 *
 * 为什么单独一个文件：8.1 分类管理是本批的读者，而 **C7 的「按类别」视图是下一个读者**
 * （台账 #19）—— 顺序与筛选口径只能有一份定义，不然两边会各排各的。
 *
 * 两条口径（都在这里定死）：
 * 1. **顺序按名字**（`localeCompare`），**「未分类」永远在最后**（残渣堆）。
 *    为什么不像分类下拉那样「用得多的在前」：列表/节头会随条数跳动，
 *    而扫一列东西时位置该稳定（`docs/plans/round47-category-management.md` §4-5）。
 * 2. 分类是**自由文本**（没有独立表）：`null` 表示未分类，非 null 就是分类名（后端已 trim、非空）。
 */

/** 那块**全局隐藏任务**（临时安排块挂在它上面）。它自己也带着 `archived_at`，
 *  但分类统计/筛选/分组一律要排掉它 —— 否则会多出一堆没意义的「未分类」。 */
import { t } from "../i18n/i18n.svelte";

export const TEMP_TASK_ID = "ww-temp-hidden-task";

/**
 * 筛选值（**没有重名分类的可能**，也不靠魔法字符串）：
 * - `null` = 全部（不筛）
 * - `""`   = 只看**未分类**（分类名不可能为空 —— 后端 `update_task` 把空串写成 `NULL`）
 * - 其他   = 只看这个名字的分类
 */
export type CategoryFilter = string | null;

/** 本模块认的最小形状（结构性类型：C7 的马赛克将来可以直接传自己那份数据）。
 *  `archived_at` 可选 —— 筛选页的计数只看**没归档**的，管理页的计数看**全部**；
 *  不传（`undefined`）当没归档处理（单测里只造 id/category 就够）。 */
export type Categorized = { id: string; category: string | null; archived_at?: number | null };

/** 用过的分类（含**已归档**任务：它们也挂着分类，改名/筛选都要认）+ 每个分类几条。
 *  排序：用得多的在前，同数按名字 —— 这是「**选一个**」的场合（分类下拉）要的口径。 */
export function usedCategories(tasks: Categorized[]): { name: string; count: number }[] {
  const count = new Map<string, number>();
  for (const t of tasks) {
    if (t.id === TEMP_TASK_ID) continue;
    const name = t.category?.trim();
    if (!name) continue;
    count.set(name, (count.get(name) ?? 0) + 1);
  }
  return [...count.entries()]
    .map(([name, c]) => ({ name, count: c }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** 按分类筛（`null` = 全部；`""` = 未分类）。派生函数：任务一改分类，它当场就换堆/消失。 */
export function filterByCategory<T extends Categorized>(
  tasks: T[],
  filter: CategoryFilter,
): T[] {
  if (filter === null) return tasks;
  return tasks.filter((t) => (t.category ?? "") === filter);
}

/** 按分类分堆（分组视图）：按名字排，**未分类在最后**；**空堆不出现**。
 *  返回值里的 `name === null` 就是「未分类」那一堆。 */
export function groupByCategory<T extends Categorized>(
  tasks: T[],
): { name: string | null; tasks: T[] }[] {
  const buckets = new Map<string, T[]>();
  for (const t of tasks) {
    const key = t.category ?? "";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(t);
    else buckets.set(key, [t]);
  }
  return [...buckets.entries()]
    .map(([key, list]) => ({ name: key === "" ? null : key, tasks: list }))
    .sort((a, b) => {
      if (a.name === null) return 1; // 未分类永远是残渣堆 → 排最后
      if (b.name === null) return -1;
      return a.name.localeCompare(b.name);
    });
}

/** 分堆节头/筛选列表上的显示名（`null` → 「未分类」） */
export function categoryLabel(name: string | null): string {
  return name ?? t("msg.category.01");
}

/** 筛选/管理页里的选项顺序：**全部 → 各分类（按名字）→ 未分类**（与分堆口径一致）。
 *  ① 选项取自**这个列表里真有的分类**（含只有归档任务在用的——那是在归档那一栏里）；
 *  ② 「未分类」只在真有没分类的任务时才给 —— 于是**每个选项都能筛出东西**（不会点出一个空列表，
 *     也就用不着「筛出来是空的」那种空态：那种空态在本设计里**不可达**）。
 *  隐藏任务的名字与计数在 `usedCategories` 里已经排掉了。 */
export function categoryOptions(tasks: Categorized[]): { label: string; value: CategoryFilter }[] {
  const names = [...new Set(usedCategories(tasks).map((c) => c.name))].sort((a, b) =>
    a.localeCompare(b),
  );
  const options: { label: string; value: CategoryFilter }[] = [
    { label: t("msg.category.02"), value: null },
    ...names.map((name) => ({ label: name, value: name })),
  ];
  if (hasUncategorized(tasks)) options.push({ label: t("msg.category.03"), value: "" });
  return options;
}

/** 这堆任务里有没有**没分类**的（决定要不要给「未分类」这个选项） */
export function hasUncategorized(tasks: Categorized[]): boolean {
  return tasks.some((t) => !t.category);
}
