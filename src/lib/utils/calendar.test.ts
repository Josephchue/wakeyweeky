/**
 * round64（C11）：`.ics` 文件名（纯函数）。
 * 时间是**本地**的 —— 用 `new Date(年, 月, 日)` 构造，跑测试的机器时区对它没影响。
 */
import { describe, expect, it } from "vitest";
import { icsFileName } from "./calendar";

describe("icsFileName", () => {
  it("排成 WakeyWeeky-YYYY-MM-DD.ics", () => {
    expect(icsFileName(new Date(2026, 9, 5))).toBe("WakeyWeeky-2026-10-05.ics");
  });

  it("个位数月/日补零", () => {
    expect(icsFileName(new Date(2026, 0, 9))).toBe("WakeyWeeky-2026-01-09.ics");
  });
});
