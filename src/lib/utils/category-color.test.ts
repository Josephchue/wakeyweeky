import { describe, expect, it } from "vitest";
import {
  CAT_COLOR_COUNT,
  categoryColorIndex,
  categoryColorVar,
  categoryOrder,
} from "./category-color";

/** 只关心「分类 + 创建时间」这两个字段 */
const t = (category: string | null, created_at: number) => ({ category, created_at });

describe("分类顺序（B2 底边条的配色依据）", () => {
  it("按「该分类最早任务」的创建时间升序 —— 不是名字顺序", () => {
    // 「写作」虽然名字排序靠后，但它是 200 建的最早任务 → 排在 300 建的「学习」前面
    expect(categoryOrder([t("写作", 300), t("学习", 400), t("写作", 200)])).toEqual([
      "写作",
      "学习",
    ]);
  });

  it("未分类（null / 空串 / 纯空格）不参与", () => {
    expect(categoryOrder([t(null, 1), t("", 2), t("   ", 3), t("学习", 4)])).toEqual(["学习"]);
  });

  it("同刻创建 → 按名字定序（两次算出来必须一样：稳定不跳）", () => {
    const a = categoryOrder([t("乙", 100), t("甲", 100)]);
    const b = categoryOrder([t("甲", 100), t("乙", 100)]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
  });

  it("顺序只认「最早那条」—— 后面新加的同名任务不改顺序", () => {
    expect(categoryOrder([t("学习", 100), t("学习", 999), t("健身", 500)])).toEqual([
      "学习",
      "健身",
    ]);
  });
});

describe("分类 → 色号", () => {
  const order = ["学习", "健身", "写作"];

  it("顺序里的第 i 个 → i+1", () => {
    expect(categoryColorIndex("学习", order)).toBe(1);
    expect(categoryColorIndex("健身", order)).toBe(2);
    expect(categoryColorIndex("写作", order)).toBe(3);
  });

  it("未分类 / 不在顺序表里 → 0（= 不画）", () => {
    expect(categoryColorIndex(null, order)).toBe(0);
    expect(categoryColorIndex("", order)).toBe(0);
    expect(categoryColorIndex("   ", order)).toBe(0);
    expect(categoryColorIndex("没这个分类", order)).toBe(0);
  });

  it("超过 8 个分类 → 8 色循环（第 9 个回到 1 号色）", () => {
    const many = Array.from({ length: 10 }, (_, i) => `分类${i + 1}`);
    expect(categoryColorIndex("分类1", many)).toBe(1);
    expect(categoryColorIndex("分类8", many)).toBe(CAT_COLOR_COUNT);
    expect(categoryColorIndex("分类9", many)).toBe(1);
    expect(categoryColorIndex("分类10", many)).toBe(2);
  });

  it("色号 → CSS 变量：只有 1…8 出值，其它一律空串（调用方据此不渲染）", () => {
    expect(categoryColorVar(1)).toBe("var(--cat-1)");
    expect(categoryColorVar(8)).toBe("var(--cat-8)");
    expect(categoryColorVar(0)).toBe("");
    expect(categoryColorVar(9)).toBe("");
  });

  it("改名不变色：色号跟着「分类身份」（顺序里的位置），不跟名字", () => {
    // 改名后任务清单里只剩新名字；顺序表也重算成新名字 —— 位置没变 → 色号没变
    const before = categoryColorIndex("写作", ["学习", "健身", "写作"]);
    const after = categoryColorIndex("记录", ["学习", "健身", "记录"]);
    expect(after).toBe(before);
  });
});
