import { describe, expect, it } from "vitest";
import { moveItem, moveWithinGroup } from "./list-order";

describe("moveWithinGroup（round49：组内挪，组边界与别的组都不动）", () => {
  const global = ["a1", "a2", "b1", "b2", "b3"];

  it("组内下移：把该组第 1 项挪到第 3 项之前", () => {
    expect(moveWithinGroup(global, ["b1", "b2", "b3"], 0, 2)).toEqual([
      "a1",
      "a2",
      "b2",
      "b1",
      "b3",
    ]);
  });

  it("组内上移：把该组最后一项挪到组首", () => {
    expect(moveWithinGroup(global, ["b1", "b2", "b3"], 2, 0)).toEqual([
      "a1",
      "a2",
      "b3",
      "b1",
      "b2",
    ]);
  });

  it("别的组的成员一个都不动（它们占的槽位照旧）", () => {
    const after = moveWithinGroup(global, ["b1", "b2", "b3"], 0, 1);
    expect(after[0]).toBe("a1");
    expect(after[1]).toBe("a2");
    expect(after.slice(2).sort()).toEqual(["b1", "b2", "b3"]);
  });

  it("没动 / 空组 → 原样返回", () => {
    expect(moveWithinGroup(global, ["b1", "b2"], 1, 1)).toEqual(global);
    expect(moveWithinGroup(global, ["b1", "b2"], 0, 1)).toEqual(global);
    expect(moveWithinGroup(global, [], 0, 0)).toEqual(global);
  });
});

describe("moveItem（Backlog 手动排序的位置数学）", () => {
  const A = ["A", "B", "C", "D"];

  it("往下挪：把第 1 项插到第 3 项之前", () => {
    expect(moveItem(A, 0, 2)).toEqual(["B", "A", "C", "D"]);
  });

  it("往上挪：把最后一项插到第 1 项之前", () => {
    expect(moveItem(A, 3, 0)).toEqual(["D", "A", "B", "C"]);
  });

  it("放到最后（to = 长度）", () => {
    expect(moveItem(A, 0, 4)).toEqual(["B", "C", "D", "A"]);
  });

  it("落点 = 自己的位置 或 自己右邻 → 顺序不变（调用方靠这个跳过写库）", () => {
    for (const from of [0, 1, 2, 3]) {
      expect(moveItem(A, from, from)).toEqual(A);
      expect(moveItem(A, from, from + 1)).toEqual(A);
    }
  });

  it("越界与空列表不炸（返回原样拷贝）", () => {
    expect(moveItem(A, -1, 0)).toEqual(A);
    expect(moveItem(A, 9, 0)).toEqual(A);
    expect(moveItem([], 0, 0)).toEqual([]);
  });

  it("不改原数组（组件的 `$derived` 还在读它）", () => {
    const copy = A.slice();
    moveItem(A, 0, 3);
    expect(A).toEqual(copy);
  });
});
