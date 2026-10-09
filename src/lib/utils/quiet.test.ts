import { describe, expect, it } from "vitest";
import { formatQuietUntil, nextDailyMoment, normalizeHHMM, parseHHMM } from "./quiet";
import { setDateFormat, setSystemLocale } from "./datetime.svelte";

// round81（6b P1）：node ≥21 有全局 navigator（取宿主 locale）—— system 档期望显式钉住
setSystemLocale("zh-CN");

describe("parseHHMM / normalizeHHMM（免打扰的「明早」时刻）", () => {
  it("认 8:00 / 08:00 / 9:05", () => {
    expect(parseHHMM("08:00")).toEqual({ hour: 8, minute: 0 });
    expect(parseHHMM("8:00")).toEqual({ hour: 8, minute: 0 });
    expect(parseHHMM(" 9:05 ")).toEqual({ hour: 9, minute: 5 });
    expect(normalizeHHMM("9:5")).toBe("09:05"); // round82 · 6b：与后端 `notify::parse_hhmm` 同宽容（以前前端故意更严 → 同一份外改的库会有两种解释）
    expect(normalizeHHMM(" 9 : 5 ")).toBe("09:05");
    expect(normalizeHHMM("9:05")).toBe("09:05");
  });
  it("拒 08:60 / 25:00 / 空 / 中文", () => {
    for (const bad of ["08:60", "25:00", "", "晚上八点"]) {
      expect(parseHHMM(bad)).toBeNull();
      expect(normalizeHHMM(bad)).toBeNull();
    }
  });
});

describe("nextDailyMoment（到明早）", () => {
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute, 0, 0);

  it("7 点 → 当天 8 点；9 点 → 次日 8 点；正好 8 点 → 次日（严格晚于）", () => {
    expect(nextDailyMoment(at(5, 7, 0), "08:00").getTime()).toBe(at(5, 8, 0).getTime());
    expect(nextDailyMoment(at(5, 9, 0), "08:00").getTime()).toBe(at(6, 8, 0).getTime());
    expect(nextDailyMoment(at(5, 8, 0), "08:00").getTime()).toBe(at(6, 8, 0).getTime());
  });

  it("时刻可改（09:30）；非法值回退 08:00", () => {
    expect(nextDailyMoment(at(5, 7, 0), "09:30").getTime()).toBe(at(5, 9, 30).getTime());
    expect(nextDailyMoment(at(5, 7, 0), "25:00").getTime()).toBe(at(5, 8, 0).getTime());
  });

  it("跨月由 Date 自己进位（10-31 晚 → 11-01 早）", () => {
    const out = nextDailyMoment(new Date(2026, 9, 31, 22, 0), "08:00");
    expect(out.getMonth()).toBe(10); // 11 月
    expect(out.getDate()).toBe(1);
    expect(out.getHours()).toBe(8);
  });
});

describe("formatQuietUntil（状态行显示）", () => {
  it("跟 date_format / time_format：dash = 10-05 08:00；system（zh-CN）= 10/5 08:00", () => {
    setDateFormat("dash");
    expect(formatQuietUntil(new Date(2026, 9, 5, 8, 0).getTime())).toBe("10-05 08:00");
    expect(formatQuietUntil(new Date(2026, 9, 5, 23, 59).getTime())).toBe("10-05 23:59");
    setDateFormat("system");
    expect(formatQuietUntil(new Date(2026, 9, 5, 8, 0).getTime())).toBe("10/5 08:00");
  });
});
