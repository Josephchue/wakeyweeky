/**
 * round82（3.1c₂ · `绑-*`）：注册表 + 组合键纯逻辑的回归防线。
 *
 * 这里只测**纯函数**（规范化矩阵 C2 / 锁定名单 C4 / 冲突 / 逐条回落 `绑-09`）；
 * DOM 侧（录制状态机 / 面板）走 `工具链预览 round82 ⑤`。
 */
import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  DEFAULT_BINDINGS,
  bindingsToStored,
  findConflict,
  formatCombo,
  isSingleKeyCombo,
  lockedReason,
  normalizeEvent,
  parseCombo,
  resolveBindings,
  serializeCombo,
} from "./keybindings";

/** 造一个只带被测字段的「键盘事件」（node 环境没有 KeyboardEvent 全局） */
function ev(over: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    isComposing: false,
    keyCode: 0,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    getModifierState: () => false,
    ...over,
  } as KeyboardEvent;
}

describe("规范化（C2 · 边界表）", () => {
  it("字母保 shift（Shift+T 与 T 是两个组合）；修饰顺序固定 Ctrl → Shift → Alt → Win", () => {
    expect(normalizeEvent(ev({ key: "t" }))).toBe("t");
    expect(normalizeEvent(ev({ key: "T", shiftKey: true }))).toBe("Shift+t");
    expect(
      normalizeEvent(ev({ key: "K", ctrlKey: true, shiftKey: true, altKey: true, metaKey: true })),
    ).toBe("Ctrl+Shift+Alt+Win+k");
  });

  it("数字 / 符号按 event.key 的产出值落地（? 就是 ?，不是 Shift+/）", () => {
    expect(normalizeEvent(ev({ key: "?", shiftKey: true }))).toBe("?");
    expect(normalizeEvent(ev({ key: "!", shiftKey: true }))).toBe("!");
    expect(normalizeEvent(ev({ key: "+", shiftKey: true }))).toBe("Plus");
    expect(normalizeEvent(ev({ key: "1" }))).toBe("1");
    expect(formatCombo("Ctrl+Plus")).toBe("Ctrl+Plus");
  });

  it("F 键 / 方向键等长名字：shift 保留", () => {
    expect(normalizeEvent(ev({ key: "F2" }))).toBe("F2");
    expect(normalizeEvent(ev({ key: "F1", shiftKey: true }))).toBe("Shift+F1");
    expect(normalizeEvent(ev({ key: "ArrowUp" }))).toBe("ArrowUp");
  });

  it("修饰键单独按下 / Dead / AltGr / IME 组词 → 不落定（null）", () => {
    for (const key of ["Control", "Shift", "Alt", "Meta"]) {
      expect(normalizeEvent(ev({ key })), `${key} 不该落定`).toBeNull();
    }
    expect(normalizeEvent(ev({ key: "Dead" }))).toBeNull();
    expect(normalizeEvent(ev({ key: "e", getModifierState: (m: string) => m === "AltGraph" }))).toBeNull();
    expect(normalizeEvent(ev({ key: "a", isComposing: true }))).toBeNull();
    expect(normalizeEvent(ev({ key: "a", keyCode: 229 }))).toBeNull();
  });

  it("parse / serialize 往返；坏串（未知修饰 / 空主键）→ null", () => {
    expect(parseCombo("Ctrl+Shift+Alt+Win+k")).toEqual({
      key: "k",
      ctrl: true,
      shift: true,
      alt: true,
      win: true,
    });
    expect(serializeCombo(parseCombo("Shift+F1")!)).toBe("Shift+F1");
    expect(parseCombo("Hyper+k")).toBeNull();
    expect(parseCombo("Ctrl+")).toBeNull();
    expect(parseCombo("")).toBeNull();
    expect(parseCombo("Ctrl+这个键名太长了超过十二个字")).toBeNull();
  });

  it("显示串：字母大写；单键判定（受「键盘快捷键」开关管的才是单键）", () => {
    expect(formatCombo("t")).toBe("T");
    expect(formatCombo("Ctrl+a")).toBe("Ctrl+A");
    expect(formatCombo("?")).toBe("?");
    expect(isSingleKeyCombo("t")).toBe(true);
    expect(isSingleKeyCombo("Shift+t")).toBe(false);
    expect(isSingleKeyCombo("Ctrl+,")).toBe(false);
  });
});

describe("锁定名单（C4 · 三档）", () => {
  it("系统 / 窗口 / 本应用三档各有人；普通组合放行", () => {
    expect(lockedReason("Alt+Tab")).toBe("system");
    expect(lockedReason("Win+k")).toBe("system");
    expect(lockedReason("Ctrl+r")).toBe("window");
    expect(lockedReason("F5")).toBe("window");
    expect(lockedReason("Ctrl+w")).toBeNull();
    expect(lockedReason("Escape")).toBe("app");
    expect(lockedReason("Ctrl+z")).toBe("app");
    expect(lockedReason("Ctrl+Shift+z")).toBe("app");
    expect(lockedReason("Shift+t")).toBeNull();
    expect(lockedReason("Ctrl+Alt+g")).toBeNull();
  });

  it("锁定默认：只许 `s` 这一条双角色（块内往下 / 未选中时统计）；其余默认都不在锁定名单", () => {
    const lockedDefaults = COMMANDS.filter((c) => lockedReason(c.combo)).map((c) => c.id);
    expect(lockedDefaults).toEqual(["stats"]);
    expect(DEFAULT_BINDINGS.stats).toBe("s");
  });
});

describe("冲突（同层硬拒 / 跨层软提示）", () => {
  const bindings = { ...DEFAULT_BINDINGS, goNow: "k" };

  it("同层全等 → hard；跨层 → soft；自己不算", () => {
    const hard = findConflict("c", "global", bindings, "goNow");
    expect(hard).toEqual({ id: "newTask", kind: "hard" });
    const soft = findConflict("k", "block", bindings, "rename");
    expect(soft).toEqual({ id: "goNow", kind: "soft" });
    expect(findConflict("k", "global", bindings, "goNow")).toBeNull();
    expect(findConflict("q", "global", bindings, "goNow")).toBeNull();
  });
});

describe("存储三态（绑-08…10）：逐条回落，其余条目照用", () => {
  it("缺键 / 坏 JSON / 数组 → 全默认", () => {
    expect(resolveBindings("")).toEqual(DEFAULT_BINDINGS);
    expect(resolveBindings("{断")).toEqual(DEFAULT_BINDINGS);
    expect(resolveBindings("[\"k\"]")).toEqual(DEFAULT_BINDINGS);
  });

  it("未知 id / 坏串 / 锁定串 → 那一条回默认，其余照用", () => {
    const raw = JSON.stringify({
      goNow: "k",
      stats: "Ctrl+Alt+S",
      ghost: "x", // 未知 id → 忽略
      review: "Ctrl+++nope", // 坏串 → 回默认
      rename: "F5", // 锁定（窗口）→ 回默认
    });
    const out = resolveBindings(raw);
    expect(out.goNow).toBe("k");
    expect(out.stats).toBe("Ctrl+Alt+S");
    expect(out.review).toBe(DEFAULT_BINDINGS.review);
    expect(out.rename).toBe(DEFAULT_BINDINGS.rename);
    expect(Object.keys(out).sort()).toEqual(COMMANDS.map((c) => c.id).sort());
  });

  it("写出去只带覆盖（没改过的条目不带 —— 默认将来改了能跟着变）", () => {
    const all = { ...DEFAULT_BINDINGS, stats: "Ctrl+Alt+S" };
    expect(JSON.parse(bindingsToStored(all))).toEqual({ stats: "Ctrl+Alt+S" });
    expect(bindingsToStored(DEFAULT_BINDINGS)).toBe("{}");
  });
});
