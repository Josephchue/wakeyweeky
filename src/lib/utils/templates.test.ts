/**
 * round64（C10）：模板界面的纯函数（骨架行 → 人话）。
 * 时间是**相对周一**的分钟 —— 不涉及时区，机器位置对它没影响。
 */
import { describe, expect, it } from "vitest";
import { clockOfWeekMinute, layerLabel, skeletonRowLabel, skeletonRowName } from "./templates";

describe("clockOfWeekMinute", () => {
  it("把一周内的分钟偏移写成 HH:MM", () => {
    expect(clockOfWeekMinute(0)).toBe("00:00");
    expect(clockOfWeekMinute(540)).toBe("09:00");
    expect(clockOfWeekMinute(1439)).toBe("23:59");
  });

  it("跨到第二天也取当天时刻", () => {
    expect(clockOfWeekMinute(1440 + 90)).toBe("01:30");
  });
});

describe("skeletonRowName", () => {
  it("有任务名就写名字（带分类）", () => {
    expect(
      skeletonRowName({ start_min: 540, duration_min: 180, layer: "elastic", title: "数学", category: "学习" }),
    ).toBe("数学 · 学习");
  });

  it("没分类就只写名字；名字两边空白去掉", () => {
    expect(
      skeletonRowName({ start_min: 540, duration_min: 180, layer: "elastic", title: "  数学  " }),
    ).toBe("数学");
  });

  it("没有名字（无任务行）→ 空串", () => {
    expect(skeletonRowName({ start_min: 540, duration_min: 180, layer: "elastic" })).toBe("");
  });
});

describe("skeletonRowLabel", () => {
  it("写成「周一 09:00–12:00」", () => {
    expect(skeletonRowLabel({ start_min: 540, duration_min: 180, layer: "required", label: null })).toBe(
      "周一 09:00–12:00",
    );
  });

  it("第 7 天（偏移 ≥ 8640）是周日", () => {
    expect(skeletonRowLabel({ start_min: 8640, duration_min: 60, layer: "elastic", label: null })).toBe(
      "周日 00:00–01:00",
    );
  });

  it("跨天的行终点取次日时刻（显示回绕到当天钟点）", () => {
    // 周日 23:00 + 2 小时 → 终点写 01:00（真实语义见后端 T3：尾巴会被夹进这一周）
    expect(skeletonRowLabel({ start_min: 10020, duration_min: 120, layer: "elastic", label: null })).toBe(
      "周日 23:00–01:00",
    );
  });
});

describe("layerLabel", () => {
  it("只认两层，遗留值当弹性", () => {
    expect(layerLabel("required")).toBe("必填");
    expect(layerLabel("elastic")).toBe("弹性");
    expect(layerLabel("suggested")).toBe("弹性");
  });
});
