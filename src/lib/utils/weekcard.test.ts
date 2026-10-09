/**
 * round57（0.13.0 / C8）：一周口径的回归防线（round58 / 0.13.1 随卡片并进总览，口径不变）。
 *
 * 这里钉死的都是**用户拍板过的口径**（`docs/plans/round57-c8-weekly-card.md` §三）：
 * ① 完成 = 三档（含超时/提前）；② 完成率分母 = 已到点（`planned` 不算、`⊘` 照算）→ 分母 0 显示「—」；
 * ③ 序列：只看这一周有成员的（跨周成员不算）；④ 往期窗口 = 最近 12 周（结语已销，不再有「写过的周」）。
 */
import { describe, expect, it } from "vitest";

import type { MosaicBlock, MosaicState, Sequence } from "../ipc/types";
import { getWeekDays } from "./week";
import { setDateFormat, setSystemLocale } from "./datetime.svelte";

// round81（6b P1）：node ≥21 有全局 navigator（取宿主 locale）—— system 档期望显式钉住
setSystemLocale("zh-CN");
import {
  completionRate,
  countStates,
  formatRate,
  formatSequence,
  formatWeekShort,
  pastWeeks,
  sequenceProgress,
} from "./weekcard";

/** 造一个只带「结局 + id」的块（其余字段本模块用不到） */
function block(id: string, state: MosaicState): MosaicBlock {
  return {
    id,
    task_id: `t-${id}`,
    title: `任务 ${id}`,
    label: null,
    category: null,
    is_temp: false,
    start_at: 0,
    end_at: 0,
    layer: "elastic",
    mosaic_state: state,
    day_start: 0,
    exempt: false,
    rearranged: 0,
    skipped: false,
  };
}

describe("countStates / completionRate：完成率的分母是「已到点」", () => {
  it("三档完成都算「完成」，超时/提前各自计数", () => {
    const counts = countStates([
      block("a", "done"),
      block("b", "done_overtime"),
      block("c", "done_short"),
      block("d", "missed"),
      block("e", "unused"),
      block("f", "planned"),
    ]);
    expect(counts).toEqual({
      done: 3,
      missed: 1,
      unused: 1,
      planned: 1,
      overtime: 1,
      short: 1,
      due: 5,
    });
  });

  it("完成率 = 完成 ÷ 已到点；`planned` 不进分母", () => {
    const counts = countStates([block("a", "done"), block("b", "missed"), block("c", "planned")]);
    expect(completionRate(counts)).toEqual({ done: 1, total: 2, pct: 50 });
    expect(formatRate(completionRate(counts))).toBe("1/2 · 50%");
  });

  it("四舍五入到整数（2/3 = 67%）", () => {
    const counts = countStates([block("a", "done"), block("b", "done"), block("c", "missed")]);
    expect(completionRate(counts).pct).toBe(67);
  });

  it("分母为 0（这一周还没有到点的块）→ pct 为 null、显示「—」，不编 0%/100%", () => {
    const counts = countStates([block("a", "planned"), block("b", "planned")]);
    expect(counts.due).toBe(0);
    expect(completionRate(counts)).toEqual({ done: 0, total: 0, pct: null });
    expect(formatRate(completionRate(counts))).toBe("—");
    // 空周也是同一档
    expect(formatRate(completionRate(countStates([])))).toBe("—");
  });

  it("`⊘` 的块照算（它只关精力账，不关兑现账 —— Q4 拍板）", () => {
    const exempt = { ...block("a", "missed"), exempt: true };
    expect(countStates([exempt]).due).toBe(1);
    expect(completionRate(countStates([exempt]))).toEqual({ done: 0, total: 1, pct: 0 });
  });
});

describe("sequenceProgress：只看这一周里有成员的序列", () => {
  const seq = (id: string, name: string, ids: string[]): Sequence => ({
    id,
    name,
    created_at: 0,
    members: ids.map((block_id, i) => ({ block_id, order_index: i })),
    has_prev_week: false,
    has_next_week: false,
  });

  it("计数 = 完成的成员 ÷ 这一周的成员；超时/提前也算完成", () => {
    const blocks = [block("a", "done"), block("b", "done_overtime"), block("c", "missed")];
    const rows = sequenceProgress(blocks, [seq("s1", "晨间流程", ["a", "b", "c"])]);
    expect(rows).toEqual([{ id: "s1", name: "晨间流程", done: 2, total: 3 }]);
    expect(formatSequence(rows[0])).toBe("晨间流程 2/3");
  });

  it("跨周成员不算这一周（只数这一周里真有的块）", () => {
    const blocks = [block("a", "done")];
    const rows = sequenceProgress(blocks, [seq("s1", "复习", ["a", "上周的块", "下周的块"])]);
    expect(rows).toEqual([{ id: "s1", name: "复习", done: 1, total: 1 }]);
  });

  it("这一周没成员的序列整条不出现（不列 0/0）", () => {
    const rows = sequenceProgress([block("a", "done")], [seq("s1", "别的周", ["x", "y"])]);
    expect(rows).toEqual([]);
    expect(sequenceProgress([], [seq("s1", "空的", [])])).toEqual([]);
  });
});

describe("pastWeeks / formatWeekShort：往期列表", () => {
  const monday = Math.floor(getWeekDays(1_700_000_000)[0].getTime() / 1000);

  it("最近 12 周（含本周）、新 → 旧、不重复", () => {
    const weeks = pastWeeks(monday);
    expect(weeks.length).toBe(12);
    expect(weeks[0]).toBe(monday);
    expect(new Set(weeks).size).toBe(weeks.length);
    // 严格递减
    for (let i = 1; i < weeks.length; i++) expect(weeks[i]).toBeLessThan(weeks[i - 1]);
  });

  it("短标签：跟 date_format（dash = 09-28；system zh-CN = 9/28）；跨年写全", () => {
    // 2026-09-28（周一）那一周
    const w = Math.floor(new Date(2026, 8, 28, 0, 0, 0).getTime() / 1000);
    setDateFormat("dash");
    expect(formatWeekShort(w)).toBe("09-28~10-04");
    setDateFormat("system");
    expect(formatWeekShort(w)).toBe("9/28~10/4");
    const crossYear = Math.floor(new Date(2026, 11, 28, 0, 0, 0).getTime() / 1000);
    setDateFormat("dash");
    expect(formatWeekShort(crossYear)).toBe("2026-12-28~2027-01-03");
    setDateFormat("system");
  });
});
