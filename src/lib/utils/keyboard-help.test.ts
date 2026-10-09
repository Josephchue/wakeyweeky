import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n.svelte";
import { resolveKey, type KeyAction } from "./keyboard";
import { COMMANDS, DEFAULT_BINDINGS, formatCombo } from "./keybindings";
import { KEY_HELP, keyHelpRows, type KeyRef } from "./keyboard-help";

/** 表里一项的显示串（命令引用按**默认**键算 —— 快照表要稳定，不能读用户设置） */
function keysOf(keys: string | KeyRef): string {
  if (typeof keys === "string") return keys;
  if ("cmd" in keys) return formatCombo(DEFAULT_BINDINGS[keys.cmd]);
  return keys.cmds.map((id) => formatCombo(DEFAULT_BINDINGS[id])).join(" / ");
}

/** `resolveKey` 能产生的全部动作（把两张表都跑一遍取 type） */
function allResolveKeyActions(): string[] {
  const keys = [
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "w",
    "a",
    "s",
    "d",
    "Enter",
    "Escape",
    "Delete",
    " ",
    "x",
  ];
  const actions = new Set<string>();
  for (const grabbed of [false, true]) {
    for (const shift of [false, true]) {
      for (const key of keys) {
        const action: KeyAction | null = resolveKey(key, { grabbed, shift });
        if (action) actions.add(action.type);
      }
    }
  }
  return [...actions].sort();
}

describe("键位说明（C18）与 resolveKey 的一致性", () => {
  it("resolveKey 能产生的每一种动作，说明里都有对应人话", () => {
    expect(allResolveKeyActions()).toEqual([
      "cancel",
      "delete",
      "done",
      "drop",
      "grab",
      "missed",
      "move",
      "stretch",
    ]);
    const text = keyHelpRows()
      .map(([keys, label]) => `${keysOf(keys)} ${t(label)}`)
      .join(" · ");
    for (const word of [
      "改开始时间",
      "改结束时间",
      "拿起",
      "放下",
      "取消选中",
      "删除",
      "完成",
      "未完成",
      "挪一天",
      "挪一周",
      "移 15 分钟",
      "移 1 小时",
    ]) {
      expect(text, `说明里缺少「${word}」`).toContain(word);
    }
  });

  it("分组名与验收文档/计划对齐（浏览 / 选中一块 / 拿起中 / 多选 / 撤销 / Backlog / 全局 / 鼠标）", () => {
    expect(KEY_HELP.map((s) => t(s.group))).toEqual([
      "浏览",
      "选中一块",
      "拿起中",
      "多选",
      "撤销",
      "Backlog",
      "全局（在别的程序里也管用）",
      "鼠标",
    ]);
  });

  it("关键配对没写反（挑几个写错就会误导人的）", () => {
    const has = (keys: string, labelStart: string) =>
      keyHelpRows().some(([k, l]) => keysOf(k) === keys && t(l).startsWith(labelStart));
    expect(has("↑↓", "改开始时间"), "未拿起 ↑↓ = 改开始时间").toBe(true);
    expect(has("Shift+↑↓", "改结束时间"), "未拿起 Shift+↑↓ = 改结束时间").toBe(true);
    expect(has("Shift+←→", "挪一周"), "拿起中 Shift+←→ = 挪一周").toBe(true);
    expect(has("Ctrl+Z", "撤销上一步")).toBe(true);
    expect(has("Ctrl+A", "全选这一周")).toBe(true);
  });

  it("注册表覆盖：每条可改命令在 `?` 总表里都有落点（C5 同源）", () => {
    const refs = keyHelpRows().flatMap(([keys]) =>
      typeof keys === "string" ? [] : "cmd" in keys ? [keys.cmd] : keys.cmds,
    );
    for (const cmd of COMMANDS) {
      expect(refs, `命令 ${cmd.id} 不在总表里`).toContain(cmd.id);
    }
  });

  it("以 resolveKey 为准复核两条易错语义（说明与实现必须同一口径）", () => {
    // 未拿起：↑↓ 是**拉伸**（改开始时间），不是移动 —— round61.1 起移动统一收进「拿起」
    expect(resolveKey("ArrowUp", { grabbed: false, shift: false })).toEqual({
      type: "stretch",
      edge: "start",
      dir: -1,
    });
    expect(resolveKey("ArrowUp", { grabbed: false, shift: true })).toEqual({
      type: "stretch",
      edge: "end",
      dir: -1,
    });
    // 拿起中：↑↓ 移 15 分钟、Shift+↑↓ 移 1 小时；←→ 挪一天、Shift+←→ 挪一周
    expect(resolveKey("ArrowUp", { grabbed: true, shift: false })).toEqual({
      type: "move",
      kind: "step",
      dir: -1,
    });
    expect(resolveKey("ArrowUp", { grabbed: true, shift: true })).toEqual({
      type: "move",
      kind: "coarse",
      dir: -1,
    });
    expect(resolveKey("ArrowRight", { grabbed: true, shift: false })).toEqual({
      type: "move",
      kind: "day",
      dir: 1,
    });
    expect(resolveKey("ArrowRight", { grabbed: true, shift: true })).toEqual({
      type: "move",
      kind: "week",
      dir: 1,
    });
    // 未拿起不再 ←→ 搬块（round61.1）—— 说明里也不该出现「未拿起 ←→ 移动」
    expect(resolveKey("ArrowRight", { grabbed: false, shift: false })).toBeNull();
  });
});
