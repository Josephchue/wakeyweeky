/**
 * E1 修复批：头部按钮组的**纯数据模型**（不碰 Svelte 状态，便于单测与复用）。
 *
 * 为什么单独一个文件：`layout.svelte.ts` 已经有「栏宽 / 形态 / 自动收起 / 头部」四件事；
 * 头部这次从 2 组变 4 组 + 按落点插入，逻辑（读旧值升级 / 预设判定 / 插入位置）足够独立。
 * 状态仍在 `layout.svelte.ts` 的 `layout.header`，这里只做「给定 layout → 新 layout」。
 */

/** 头部的四个按钮组（E1 修复批：从 2 组拆成 4 组） */
export type HeadGroup = "week-nav" | "edit" | "views" | "settings";
export type HeadZone = "left" | "right";
export type HeaderPresetId = "default" | "right" | "left";
export type HeaderLayout = { left: HeadGroup[]; right: HeadGroup[] };

export const HEADER_GROUPS: readonly HeadGroup[] = ["week-nav", "edit", "views", "settings"];

/** 三档内置布局：默认 / 都靠右 / 都靠左 */
export const HEADER_PRESETS: Record<HeaderPresetId, HeaderLayout> = {
  default: { left: ["week-nav"], right: ["edit", "views", "settings"] },
  right: { left: [], right: ["week-nav", "edit", "views", "settings"] },
  left: { left: ["week-nav", "edit", "views", "settings"], right: [] },
};

export function cloneHeaderLayout(h: HeaderLayout): HeaderLayout {
  return { left: [...h.left], right: [...h.right] };
}

/** 旧形状的单组展开（`head-actions` 就地拆成 edit / views / settings） */
function expandLegacyGroup(id: string): string[] {
  if (id === "head-actions") return ["edit", "views", "settings"];
  return [id];
}

/** 读回 header_layout：坏 JSON / 缺组 / 重复组 → null（调用方回默认）；
 *  同时接受旧形状（2 组）并升级成 4 组。 */
export function parseHeaderLayout(raw: string | undefined): HeaderLayout | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { left?: unknown; right?: unknown };
    const validArr = (a: unknown): a is string[] =>
      Array.isArray(a) && a.every((g) => typeof g === "string");
    if (!validArr(v.left) || !validArr(v.right)) return null;
    const expand = (arr: string[]): HeadGroup[] =>
      arr
        .flatMap((g) => expandLegacyGroup(g))
        .filter((g): g is HeadGroup => (HEADER_GROUPS as readonly string[]).includes(g));
    const left = expand(v.left);
    const right = expand(v.right);
    const all = [...left, ...right];
    if (all.length !== HEADER_GROUPS.length) return null;
    if (new Set(all).size !== HEADER_GROUPS.length) return null;
    return { left, right };
  } catch {
    return null;
  }
}

/** 应用一档预设（返回新 layout，不改入参） */
export function applyPresetTo(id: HeaderPresetId): HeaderLayout {
  return cloneHeaderLayout(HEADER_PRESETS[id]);
}

/** 当前排布对应哪一档；都不匹配 = 自定义 */
export function presetOf(h: HeaderLayout): HeaderPresetId | "custom" {
  const same = (a: HeadGroup[], b: HeadGroup[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  for (const id of Object.keys(HEADER_PRESETS) as HeaderPresetId[]) {
    if (same(h.left, HEADER_PRESETS[id].left) && same(h.right, HEADER_PRESETS[id].right)) return id;
  }
  return "custom";
}

/** 某个组现在在哪个区 */
export function zoneOf(h: HeaderLayout, id: HeadGroup): HeadZone {
  return h.left.includes(id) ? "left" : "right";
}

/** 把一个组移到目标区的指定位置（`index` 缺省 = 追加到末尾）；
 *  index 按「先把自己从两侧摘掉」之后的列表算 —— 拖到某组前面/后面都用它。 */
export function moveInLayout(h: HeaderLayout, id: HeadGroup, zone: HeadZone, index?: number): HeaderLayout {
  const next = cloneHeaderLayout(h);
  next.left = next.left.filter((g) => g !== id);
  next.right = next.right.filter((g) => g !== id);
  const target = next[zone];
  const at = index == null ? target.length : Math.max(0, Math.min(target.length, index));
  target.splice(at, 0, id);
  return next;
}
