import { describe, expect, it } from "vitest";
import { LAYER_CYCLE, effectiveLayer, nextLayer } from "./layer";

describe("effectiveLayer（C1.4 遗留值兜底）", () => {
  it("遗留的 suggested 当作弹性层", () => {
    expect(effectiveLayer("suggested")).toBe("elastic");
  });

  it("两层的正式值原样返回", () => {
    expect(effectiveLayer("required")).toBe("required");
    expect(effectiveLayer("elastic")).toBe("elastic");
  });

  it("真正未知的值原样返回（不假装认识它）", () => {
    expect(effectiveLayer("urgent")).toBe("urgent");
    expect(effectiveLayer("")).toBe("");
  });
});

describe("nextLayer（两档循环）", () => {
  it("弹性 ⇄ 必填 来回切", () => {
    expect(nextLayer("elastic")).toBe("required");
    expect(nextLayer("required")).toBe("elastic");
  });

  it("只有两档：不存在第三档", () => {
    expect(LAYER_CYCLE).toHaveLength(2);
    expect(LAYER_CYCLE).not.toContain("suggested");
  });

  it("遗留值与未知值都切到必填（不空操作）", () => {
    expect(nextLayer("suggested")).toBe("required");
    expect(nextLayer("urgent")).toBe("required");
  });
});
