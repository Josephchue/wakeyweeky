/**
 * round62（C14）：备份文件名 / 大小显示（纯函数）。
 * 时间是**本地**的 —— 用 `new Date(年, 月, 日, 时, 分)` 构造，跑测试的机器时区对它没影响。
 */
import { describe, expect, it } from "vitest";
import { backupFileName, formatBytes } from "./backup";

describe("backupFileName", () => {
  it("排成 WakeyWeeky-YYYY-MM-DD-HHmm.db", () => {
    expect(backupFileName(new Date(2026, 9, 4, 19, 30))).toBe("WakeyWeeky-2026-10-04-1930.db");
  });

  it("个位数月/日/时/分都补零", () => {
    expect(backupFileName(new Date(2026, 0, 5, 7, 8))).toBe("WakeyWeeky-2026-01-05-0708.db");
  });
});

describe("formatBytes", () => {
  it("分档显示 B / KB / MB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(12_300)).toBe("12 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("异常值不当场炸（给 0 B 这种保守显示）", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});
