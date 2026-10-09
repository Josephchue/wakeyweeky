import { describe, expect, it } from "vitest";
import {
  BACKLOG_ALL,
  collapsedFromStored,
  collapsedToStored,
  filterFromStored,
  filterFromUi,
  filterToStored,
  filterToUi,
} from "./backlog-view";

describe("filterToStored / filterFromStored（R48 筛选的存库形态）", () => {
  it("三种 kind 往返一致", () => {
    for (const f of [BACKLOG_ALL, { kind: "uncat" } as const, { kind: "cat", name: "学习" } as const]) {
      expect(filterFromStored(filterToStored(f))).toEqual(f);
    }
  });

  it("存的是规范化 JSON（与后端同一串）", () => {
    expect(filterToStored(BACKLOG_ALL)).toBe('{"kind":"all"}');
    expect(filterToStored({ kind: "uncat" })).toBe('{"kind":"uncat"}');
    expect(filterToStored({ kind: "cat", name: "学习" })).toBe('{"kind":"cat","name":"学习"}');
  });

  it("缺省 / 垃圾 / 形状不对 → 全部（不炸界面）", () => {
    for (const bad of [undefined, "", "学习", "{}", '{"kind":"nope"}', '{"kind":"cat"}', "null"]) {
      expect(filterFromStored(bad)).toEqual(BACKLOG_ALL);
    }
  });
});

describe("filterToUi / filterFromUi（与组件的 CategoryFilter 互转）", () => {
  it("null = 全部、\"\" = 未分类、其余 = 分类名", () => {
    expect(filterToUi(BACKLOG_ALL)).toBeNull();
    expect(filterToUi({ kind: "uncat" })).toBe("");
    expect(filterToUi({ kind: "cat", name: "工作" })).toBe("工作");
    expect(filterFromUi(null)).toEqual(BACKLOG_ALL);
    expect(filterFromUi("")).toEqual({ kind: "uncat" });
    expect(filterFromUi("工作")).toEqual({ kind: "cat", name: "工作" });
  });
});

describe("collapsedToStored / collapsedFromStored（R48 收起的分组）", () => {
  it("往返一致 + 去重", () => {
    expect(collapsedFromStored(collapsedToStored(["工作", "学习", "工作"]))).toEqual([
      "工作",
      "学习",
    ]);
  });

  it("缺省 / 垃圾 → 空（什么都不收）", () => {
    for (const bad of [undefined, "", "工作", '{"a":1}', '["好的", 3, ""]']) {
      const out = collapsedFromStored(bad);
      expect(Array.isArray(out)).toBe(true);
    }
    expect(collapsedFromStored(undefined)).toEqual([]);
    expect(collapsedFromStored('{"a":1}')).toEqual([]);
    expect(collapsedFromStored('["好的", 3, ""]')).toEqual(["好的"]);
  });
});
