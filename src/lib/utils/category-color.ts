/**
 * round76（3.1a）：**分类底边条的颜色分配**（B2；依据 `docs/visual/类别上色与纹理调研.md` §7/§8）。
 *
 * 规则（写死在边界表里，本文件是唯一实现）：
 * - 色板 = Okabe-Ito 工作变体 8 色（`--cat-1`…`--cat-8`，亮/暗各一套，值在 `tokens.css`）。
 * - 分配顺序 = **「该分类最早任务」的时间顺序**（不是名字顺序）→ 改名不变色、重开不变色、稳定不跳。
 * - 未分类 / 临时块 / 查不到分类 → 不画（返回 0）。
 * - 超过 8 个分类 → 循环（第 9 个回到 1 号色）。
 */
export const CAT_COLOR_COUNT = 8;

/** 名字定序（与 locale 无关 —— 只用来在「同刻创建」时保持稳定） */
function compareName(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 由任务清单算「分类顺序」：每个分类取**最早**那条任务的 `created_at` 升序；同刻按名字定序（稳定） */
export function categoryOrder(
  tasks: readonly { category: string | null; created_at: number }[],
): string[] {
  const first = new Map<string, number>();
  for (const t of tasks) {
    const name = t.category?.trim();
    if (!name) continue;
    const cur = first.get(name);
    if (cur === undefined || t.created_at < cur) first.set(name, t.created_at);
  }
  return [...first.entries()]
    .sort((a, b) => a[1] - b[1] || compareName(a[0], b[0]))
    .map(([name]) => name);
}

/** 分类名 → 色号（1…8）；不画的情况返回 0（未分类 / 不在顺序表里） */
export function categoryColorIndex(
  name: string | null | undefined,
  order: readonly string[],
): number {
  const key = name?.trim();
  if (!key) return 0;
  const i = order.indexOf(key);
  return i < 0 ? 0 : (i % CAT_COLOR_COUNT) + 1;
}

/** 色号 → CSS 值（`var(--cat-N)`）；0 或越界返回空串（调用方据此不渲染） */
export function categoryColorVar(index: number): string {
  return index >= 1 && index <= CAT_COLOR_COUNT ? `var(--cat-${index})` : "";
}
