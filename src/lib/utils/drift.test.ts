import { describe, expect, it } from "vitest";
import { formatSuggestion, suggestSlots } from "./drift";
import { weekOf } from "./week";
import { setDateFormat, setSystemLocale } from "./datetime.svelte";

// round81（6b P1）：node ≥21 有全局 navigator（取宿主 locale）—— system 档期望显式钉住
setSystemLocale("zh-CN");

/**
 * 这里的日期用**真实的 2026 年日历**（10-02 是周五、10-03 是周六、10-04 是周日、10-05 是周一），
 * 所以「今天 / 明天 / 周六」这些措辞也能一起验。
 */
const at = (day: number, hour: number, minute = 0) =>
  Math.floor(new Date(2026, 9, day, hour, minute, 0).getTime() / 1000);

/** 把 [start,end) 标进占用集合（与 `occupiedSlots` 同口径：块覆盖到的每一格都算） */
const occupy = (set: Set<number>, start: number, end: number) => {
  for (let t = start; t < end; t += 1800) set.add(t);
  return set;
};

describe("suggestSlots（漂流建议）", () => {
  const week = weekOf(at(3, 12)); // 2026-09-28 ~ 2026-10-04

  it("round48 回归：**不会把块提到它自己前面**（周六凌晨的块 → 建议不再落在周五晚上）", () => {
    // 用户实测那一幕：现在 = 周五 21:26，块排在周六 01:00–02:30（还没到），
    // 旧逻辑从「今天、从现在起」找空档 → 建议「今天 21:30」（比块本身还早）✗
    const ghost = { start: at(3, 1), end: at(3, 2, 30) };
    const occupied = occupy(new Set<number>(), ghost.start, ghost.end);
    const out = suggestSlots(occupied, at(2, 21, 26), 3, week, ghost.start);

    expect(out.length).toBeGreaterThan(0);
    expect(out.every((s) => s >= ghost.start)).toBe(true);
    expect(out[0]).toBe(at(3, 2, 30)); // 紧接残影之后的第一个空档（周六 02:30）
  });

  it("已经过去的残影：照旧从「现在」往后找（这条行为不变）", () => {
    const occupied = occupy(new Set<number>(), at(3, 1), at(3, 2, 30));
    const out = suggestSlots(occupied, at(3, 15), 3, week, at(3, 1));
    expect(out[0]).toBe(at(3, 15));
  });

  it("只推本周之内（周日晚上也只在剩下那点时间里找）", () => {
    const out = suggestSlots(new Set<number>(), at(4, 21), 3, week, at(4, 20));
    expect(out[0]).toBe(at(4, 21));
    expect(out.every((s) => s >= week.from && s < week.to)).toBe(true);
  });

  it("装不下的日子不算数（块跨过日界时宁可给别的天）", () => {
    // 4 小时（8 格）的块：周日 22:00 起装不下（会跨到周一）→ 不该给这个点
    const out = suggestSlots(new Set<number>(), at(4, 22), 8, week, at(4, 22));
    expect(out.some((s) => s === at(4, 22))).toBe(false);
  });
});

describe("formatSuggestion（说人话）", () => {
  it("今天 / 明天 / 再远一点就带日期（周几跟语言，日期片段跟 date_format）", () => {
    expect(formatSuggestion(at(2, 21, 30), at(2, 21, 26))).toBe("今天 21:30");
    expect(formatSuggestion(at(3, 9), at(2, 21, 26))).toBe("明天 09:00");
    // round81（3.1c₁）：片段跟 `date_format`；周几从 date-fns 的英文 `EEE` 换成语言化的「周二」
    setDateFormat("dash");
    expect(formatSuggestion(at(6, 10), at(2, 21, 26))).toBe("10-06 周二 10:00");
    setDateFormat("system");
    expect(formatSuggestion(at(6, 10), at(2, 21, 26))).toBe("10/6 周二 10:00"); // 测试环境无 navigator → zh-CN
  });
});
