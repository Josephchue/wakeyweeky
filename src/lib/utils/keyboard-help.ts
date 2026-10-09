/**
 * C18（round63）：设置面板「键位说明」的**数据**（从组件里搬出来 —— 组件里的常量单测不到）。
 *
 * 口径以 `utils/keyboard.ts::resolveKey` + Timeline 的键盘分支 + Backlog 为准；
 * 措辞照 round42 定的人话（改开始时间 / 改结束时间 / 拿起 / 放下 / 挪一天 / 挪一周）。
 * `keyboard-help.test.ts` 钉住：**`resolveKey` 能产生的每一种动作，说明里都有对应词** ——
 * 改了键位却忘了改说明，那条测试会红。
 */
import type { MsgKey } from "../i18n/i18n.svelte";
import type { CommandId } from "./keybindings";

/** 键位栏里的一项：字面串（锁定键 / 鼠标）或**注册表命令引用**（显示串跟着用户改 —— C5 同源） */
export type KeyRef = { cmd: CommandId } | { cmds: CommandId[] };
export type KeyHelpRow = [keys: string | KeyRef, label: MsgKey];
export type KeyHelpSection = { group: MsgKey; rows: KeyHelpRow[] };

export const KEY_HELP: KeyHelpSection[] = [
  {
    group: "msg.keyboard_help.01",
    rows: [
      ["← / →", "msg.keyboard_help.02"],
      ["msg.keyboard_help.03", "msg.keyboard_help.04"],
      ["Esc", "msg.keyboard_help.05"],
      // round78（3.1b₂ · 键-02）：回到本周 / 快捷键总表 / 打开设置（都是局内键，受「键盘快捷键」开关管）
      [{ cmd: "goNow" }, "msg.keyboard_help.49"],
      [{ cmd: "keyHelp" }, "msg.keyboard_help.50"],
      [{ cmd: "settings" }, "msg.keyboard_help.51"],
    ],
  },
  {
    group: "msg.keyboard_help.06",
    rows: [
      ["↑↓", "msg.keyboard_help.07"],
      ["Shift+↑↓", "msg.keyboard_help.08"],
      ["Enter", "msg.keyboard_help.09"],
      [{ cmd: "followMove" }, "msg.keyboard_help.10"],
      [{ cmd: "followCopy" }, "msg.keyboard_help.11"],
      ["Space / X", "msg.keyboard_help.12"],
      ["Delete", "msg.keyboard_help.13"],
      [{ cmd: "rename" }, "msg.keyboard_help.14"],
    ],
  },
  {
    group: "msg.keyboard_help.15",
    rows: [
      ["↑↓", "msg.keyboard_help.16"],
      ["Shift+↑↓", "msg.keyboard_help.17"],
      ["←→", "msg.keyboard_help.18"],
      ["Shift+←→", "msg.keyboard_help.19"],
      ["Enter", "msg.keyboard_help.20"],
      ["Esc", "msg.keyboard_help.21"],
    ],
  },
  {
    group: "msg.keyboard_help.22",
    rows: [
      ["msg.keyboard_help.23", "msg.keyboard_help.24"],
      ["msg.keyboard_help.25", "msg.keyboard_help.26"],
      ["msg.keyboard_help.27", "msg.keyboard_help.28"],
      [{ cmd: "selectAll" }, "msg.keyboard_help.29"],
      [{ cmds: ["followMove", "followCopy"] }, "msg.keyboard_help.30"],
      ["Enter", "msg.keyboard_help.31"],
      ["Space / X / Del", "msg.keyboard_help.32"],
      ["Esc", "msg.keyboard_help.33"],
    ],
  },
  {
    group: "msg.keyboard_help.34",
    rows: [
      ["Ctrl+Z", "msg.keyboard_help.35"],
      ["Ctrl+Shift+Z / Ctrl+Y", "msg.keyboard_help.36"],
      ["msg.keyboard_help.37", "msg.keyboard_help.38"],
    ],
  },
  {
    group: "msg.keyboard_help.39",
    rows: [
      [{ cmd: "newTask" }, "msg.keyboard_help.40"],
      // round77（3.1b）：局内快捷键 O / S（总览 / 统计；浮层开着不抢）
      [{ cmd: "review" }, "msg.keyboard_help.47"],
      [{ cmd: "stats" }, "msg.keyboard_help.48"],
      ["msg.keyboard_help.41", "msg.keyboard_help.42"],
      [{ cmd: "rename" }, "msg.keyboard_help.43"],
    ],
  },
  {
    group: "msg.keyboard_help.44",
    rows: [
      [
        "Win+Shift+W",
        "msg.keyboard_help.45",
      ],
    ],
  },
  // round82（11.4）：鼠标手势单独一组 —— 动作名与首次轻提示（`msg.hints.04`）**引用同一个消息键**，
  // 不许两处各写（轻提示的 `{slot}` 就是这里的 .53）。
  // round83（验收回修）：`Ctrl+滚轮（分隔条）→ 调整栏宽` 那条**撤掉**（你说没用）—— 栏宽改回拖动 / 双击复位 / ←→。
  {
    group: "msg.keyboard_help.54",
    rows: [["msg.keyboard_help.56", "msg.keyboard_help.53"]],
  },
];

/** 摊平成一行行（测试与检索用） */
export function keyHelpRows(): KeyHelpRow[] {
  return KEY_HELP.flatMap((section) => section.rows);
}
