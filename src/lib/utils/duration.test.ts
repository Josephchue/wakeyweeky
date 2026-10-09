import { describe, expect, it } from "vitest";
import { estimateMinutes } from "./duration";

/**
 * round69（B3）：块时长 = 任务的「预估」—— 这条口径以前在 `Backlog.svelte` 里写了两遍、Rust 里第三遍
 * （round27/28 就是这块漂过：四舍五入 vs 向上取整）。抽出来一份并加上测试，三处引用。
 */
describe("estimateMinutes（预估 → 块时长，15 分钟步进）", () => {
  it("没填 / 0 / 负数 → 默认 30 分钟", () => {
    expect(estimateMinutes(null)).toBe(30);
    expect(estimateMinutes(undefined)).toBe(30);
    expect(estimateMinutes(0)).toBe(30);
    expect(estimateMinutes(-5)).toBe(30);
  });

  it("向上取整到 15 分钟（宁可多给，也别少于预估）", () => {
    expect(estimateMinutes(1)).toBe(15);
    expect(estimateMinutes(15)).toBe(15);
    expect(estimateMinutes(16)).toBe(30);
    expect(estimateMinutes(50)).toBe(60);
    expect(estimateMinutes(75)).toBe(75);
    expect(estimateMinutes(1440)).toBe(1440);
  });
});
