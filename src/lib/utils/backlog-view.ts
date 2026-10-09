/**
 * C18（round63 / R48）：Backlog 的**视图记忆** —— 筛选 / 分组 / 收起三样存进 `settings`。
 *
 * 存库形态与 Rust `commands/settings.rs` 的校验**同一套**（都是 JSON）：
 * - `backlog_filter`：`{"kind":"all"}` / `{"kind":"uncat"}` / `{"kind":"cat","name":"学习"}`
 * - `backlog_collapsed`：`["工作","学习"]`（JSON 字符串数组）
 *
 * 组件里用的仍是老的 `CategoryFilter`（`null` = 全部、`""` = 未分类、其他 = 分类名）——
 * 这一层只做「两边的翻译」，别在别处再定一套口径。
 */
import type { CategoryFilter } from "./category";

export type BacklogFilter = { kind: "all" } | { kind: "uncat" } | { kind: "cat"; name: string };

export const BACKLOG_ALL: BacklogFilter = { kind: "all" };

/** 转存库形态（规范 JSON；与后端 `normalize_backlog_filter` 的产物一致） */
export function filterToStored(filter: BacklogFilter): string {
  if (filter.kind === "all") return '{"kind":"all"}';
  if (filter.kind === "uncat") return '{"kind":"uncat"}';
  return JSON.stringify({ kind: "cat", name: filter.name });
}

/** 解析存库值；缺省 / 非法 → 全部（坏值不炸界面，与后端读法一致） */
export function filterFromStored(raw: string | undefined): BacklogFilter {
  if (!raw) return BACKLOG_ALL;
  try {
    const value = JSON.parse(raw) as { kind?: unknown; name?: unknown };
    if (value?.kind === "uncat") return { kind: "uncat" };
    if (value?.kind === "cat" && typeof value.name === "string" && value.name.trim() !== "") {
      return { kind: "cat", name: value.name };
    }
  } catch {
    /* 落回「全部」 */
  }
  return BACKLOG_ALL;
}

/** 转组件用的 `CategoryFilter` */
export function filterToUi(filter: BacklogFilter): CategoryFilter {
  if (filter.kind === "all") return null;
  if (filter.kind === "uncat") return "";
  return filter.name;
}

/** 从组件的 `CategoryFilter` 转回来 */
export function filterFromUi(value: CategoryFilter): BacklogFilter {
  if (value === null) return BACKLOG_ALL;
  if (value === "") return { kind: "uncat" };
  return { kind: "cat", name: value };
}

/** 收起的分组 → 存库形态（去重；空数组就是 `[]`） */
export function collapsedToStored(names: Iterable<string>): string {
  return JSON.stringify([...new Set(names)]);
}

/** 解析收起的分组；缺省 / 非法 → 空（"什么都不收"） */
export function collapsedFromStored(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return [
      ...new Set(value.filter((x): x is string => typeof x === "string" && x.trim() !== "")),
    ];
  } catch {
    return [];
  }
}
