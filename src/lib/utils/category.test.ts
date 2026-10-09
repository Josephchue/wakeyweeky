import { describe, expect, it } from "vitest";
import {
  TEMP_TASK_ID,
  categoryLabel,
  categoryOptions,
  filterByCategory,
  groupByCategory,
  hasUncategorized,
  usedCategories,
} from "./category";

/** 造一条任务：本模块只认 `id` / `category` 两个字段 */
const T = (id: string, category: string | null) => ({ id, category });

describe("usedCategories（分类下拉 / 管理页 / 筛选列表的计数）", () => {
  it("用得多的在前，同数按名字", () => {
    expect(usedCategories([T("a", "学习"), T("b", "工作"), T("c", "工作")])).toEqual([
      { name: "工作", count: 2 },
      { name: "学习", count: 1 },
    ]);
  });

  it("没分类（null / 只有空格）的不进列表", () => {
    expect(usedCategories([T("a", null), T("b", "  ")])).toEqual([]);
  });

  it("排除那块全局隐藏任务（就算它被塞了分类也不算 —— 它的 category 本来就恒为 null）", () => {
    expect(usedCategories([T(TEMP_TASK_ID, "不该出现")])).toEqual([]);
  });
});

describe("filterByCategory（筛选）", () => {
  it("null = 全部（原样返回，不做多余拷贝）", () => {
    const list = [T("a", "工作"), T("b", null)];
    expect(filterByCategory(list, null)).toBe(list);
  });

  it("空串 = 只看未分类", () => {
    expect(filterByCategory([T("a", "工作"), T("b", null)], "").map((t) => t.id)).toEqual(["b"]);
  });

  it("按名字筛（名字来自库里，已 trim）", () => {
    expect(filterByCategory([T("a", "工作"), T("b", "学习")], "学习").map((t) => t.id)).toEqual([
      "b",
    ]);
  });
});

describe("groupByCategory（分堆）", () => {
  it("按名字排，未分类永远在最后（残渣堆）", () => {
    const groups = groupByCategory([T("a", "学习"), T("b", null), T("c", "工作")]);
    expect(groups.map((g) => g.name)).toEqual(["工作", "学习", null]);
  });

  it("空堆不出现", () => {
    expect(groupByCategory([T("a", null)]).map((g) => g.name)).toEqual([null]);
  });

  it("同一堆里的任务保持原顺序（新建/拖拽排出来的顺序不该被打乱）", () => {
    const groups = groupByCategory([T("a", "工作"), T("b", "学习"), T("c", "工作")]);
    expect(groups[0].tasks.map((t) => t.id)).toEqual(["a", "c"]);
  });
});

describe("categoryLabel / categoryOptions / hasUncategorized", () => {
  it("null 显示成「未分类」", () => {
    expect(categoryLabel(null)).toBe("未分类");
    expect(categoryLabel("工作")).toBe("工作");
  });

  it("选项顺序：全部 → 各分类（按名字）→ 未分类", () => {
    expect(categoryOptions([T("a", "学习"), T("b", "工作"), T("c", null)])).toEqual([
      { label: "全部", value: null },
      { label: "工作", value: "工作" },
      { label: "学习", value: "学习" },
      { label: "未分类", value: "" },
    ]);
  });

  it("没有没分类的任务时，「未分类」不给出来（每个选项都能筛出东西、不会点出一个空列表）", () => {
    expect(categoryOptions([T("a", "工作")]).map((o) => o.value)).toEqual([null, "工作"]);
  });

  it("hasUncategorized：有没有没分类的任务", () => {
    expect(hasUncategorized([T("a", "工作")])).toBe(false);
    expect(hasUncategorized([T("a", null)])).toBe(true);
  });
});
