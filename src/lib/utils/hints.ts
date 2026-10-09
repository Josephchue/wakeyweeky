/**
 * round64（C10）：渐进式提示的**注册表**（加一条 = 加一行；id 与 Rust `hints.rs` 的白名单一一对应）。
 *
 * 口径（`docs/plans/round64-c10-c11.md` §2.3）：首次用到某功能才提示一次、一次一条、
 * 可就地关掉且不再复活、不挡操作。文案是**一次性教学**，不是状态读数（状态读数在块上/键位栏里）。
 *
 * round73（3.0b₁）：文案外置成 `t(...)`；这里用 **getter**（模块加载时不求值）——
 * 3.0b₂ 加语言切换后，读的时候总是当前语言（普通字段会把首次加载的语言冻住）。
 */
import { t } from "../i18n/i18n.svelte";

export type HintId = "multi" | "review" | "temp" | "zoom";

export interface HintMeta {
  id: HintId;
  /** 提示条上的一句话（最短能说清「你刚解锁了什么」） */
  readonly text: string;
}

export const HINTS: HintMeta[] = [
  {
    id: "multi",
    get text() {
      return t("msg.hints.01");
    },
  },
  {
    id: "review",
    get text() {
      return t("msg.hints.02");
    },
  },
  {
    id: "temp",
    get text() {
      return t("msg.hints.03");
    },
  },
  // round81（3.1c₁ · 宽-09）：第一次用 Ctrl+滚轮时提示它管什么
  // round82（11.4）：动作名改成**带参引用** `?` 表里的同一个消息键 —— 轻提示与表不许两处各写
  // round83（验收回修）：分隔条那条撤掉后，只剩时间刻度一个区域
  {
    id: "zoom",
    get text() {
      return t("msg.hints.04", { slot: t("msg.keyboard_help.53") });
    },
  },
];
