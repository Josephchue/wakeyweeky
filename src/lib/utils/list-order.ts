/**
 * round48：Backlog 手动排序的**位置数学** —— 只此一处（组件里算错就没法测）。
 *
 * 口径：`from` 是被拖的那一项在**原列表**里的下标；`to` 是**落点**（插到第 `to` 项**之前**，
 * `to === list.length` 表示放到最后）—— 与界面上那条插入线**同一个口径**（线的位置 = 插到它前面）。
 * 于是「落点 = 自己现在的位置 或 自己右邻」时结果与原来一模一样（调用方据此判断「没动就不写库」）。
 */
/**
 * round49：**组内**挪一位 —— 组与组之间、以及别的组的成员**都不动**（用户 2026-10-03 拍板
 * 「只在本组内挪」，跨组不给放）。平铺视图等价于 `moveItem`（整张表就是一组）。
 *
 * @param globalIds 整张表的 id 顺序（落库用）
 * @param groupIds  这一组的 id 顺序（界面上的组内顺序）
 * @param from/to   组内下标（`to` 的口径与插入线一致：插到第 `to` 项之前）
 */
export function moveWithinGroup<T>(globalIds: T[], groupIds: T[], from: number, to: number): T[] {
  const nextGroup = moveItem(groupIds, from, to);
  if (nextGroup.length === 0 || nextGroup.every((id, index) => id === groupIds[index])) {
    return globalIds.slice(); // 没动
  }
  const queue = nextGroup.slice();
  const inGroup = new Set(groupIds);
  return globalIds.map((id) => (inGroup.has(id) ? (queue.shift() as T) : id));
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  if (from < 0 || from >= next.length) return next;
  const [item] = next.splice(from, 1);
  // 被拖的那项已经拿走了：它后面的那些在数组里都往前挪了一格
  const insertAt = to > from ? to - 1 : to;
  next.splice(Math.max(0, Math.min(insertAt, next.length)), 0, item);
  return next;
}
