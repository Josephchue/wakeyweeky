/**
 * round64（C10）：说明页的功能开关总表（纯函数）。
 * 只验「派生关系」：17 行（round69 起：16 布尔 + 模板建议 JSON）、默认全开、按状态翻转 ——
 * 文案本身由 `FEATURES` 一份说了算。
 */
import { describe, expect, it } from "vitest";
import { FEATURES } from "./features";
import { featuresOnSummary } from "./help";

const state = (over: Partial<Record<string, boolean>> = {}, suggestOn = true) => ({
  features: Object.fromEntries(FEATURES.filter((f) => f.boolean).map((f) => [f.key, over[f.key] ?? true])),
  templateSuggest: { enabled: suggestOn },
});

describe("featuresOnSummary", () => {
  it("17 行、顺序与元数据一致、默认全开", () => {
    const rows = featuresOnSummary(FEATURES, state());
    expect(rows).toHaveLength(17);
    expect(rows.map((r) => r.key)).toEqual(FEATURES.map((f) => f.key));
    expect(rows.every((r) => r.on)).toBe(true);
  });

  it("关掉一把锁 → 对应行显示关；模板建议读它自己的 enabled", () => {
    const rows = featuresOnSummary(FEATURES, state({ sequences_enabled: false }, false));
    expect(rows.find((r) => r.key === "sequences_enabled")?.on).toBe(false);
    expect(rows.find((r) => r.key === "template_suggest")?.on).toBe(false);
    expect(rows.filter((r) => !r.on)).toHaveLength(2);
  });

  it("每行都有「关掉后会怎样」", () => {
    for (const row of featuresOnSummary(FEATURES, state())) {
      expect(row.off.length).toBeGreaterThan(4);
    }
  });
});
