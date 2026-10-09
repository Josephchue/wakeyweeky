/**
 * round77（3.1b）：`formatRemaining` 的规则钉住（与 `src-tauri/src/hint.rs::format_body` 同口径）。
 *
 * 为什么值得测：第二行会跟着 60 秒节拍反复重算，档位（≤1 分钟 / <1 小时 / <24 小时 / ≥24 小时）
 * 一旦与托盘那行漂移，用户会看到「还剩 45 分钟」与「还剩 45 分」两套说法。
 */
import { describe, expect, it } from "vitest";
import { formatRemaining } from "./remaining";

describe("formatRemaining（块内第二行「还剩 X」）", () => {
  it("≤ 60 秒 → 即将结束", () => {
    expect(formatRemaining(60)).toBe("即将结束");
    expect(formatRemaining(5)).toBe("即将结束");
  });

  it("< 1 小时 → 还剩 N 分（向上取整：剩 61 秒算 2 分钟）", () => {
    expect(formatRemaining(61)).toBe("还剩 2 分");
    expect(formatRemaining(45 * 60)).toBe("还剩 45 分");
    // 向上取整到 60 分 ⇒ 进「小时」档（与 Rust `hint.rs::format_body` 逐字一致：
    // 那边也是 `if minutes < 60` 才走分档）
    expect(formatRemaining(59 * 60 + 1)).toBe("还剩 1 小时");
  });

  it("< 24 小时 → 还剩 H 小时[ M 分]", () => {
    expect(formatRemaining(60 * 60)).toBe("还剩 1 小时");
    expect(formatRemaining(90 * 60)).toBe("还剩 1 小时 30 分");
  });

  it("≥ 24 小时 → 还剩 D 天[ H 小时]", () => {
    expect(formatRemaining(24 * 60 * 60)).toBe("还剩 1 天");
    expect(formatRemaining(30 * 60 * 60)).toBe("还剩 1 天 6 小时");
  });
});
