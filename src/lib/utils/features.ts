/**
 * round64（C10）：二期功能开关的**元数据表**（用户 2026-10-04：「除了 MVP 的功能全部可以自己选择开关，
 * 默认开着」）—— 设置面板的「功能开关（默认全开）」区、说明页的「功能开关总表」与单测**共用这一份**，
 * 防止两处文案 / 键名漂移（键名与 Rust `crate::features` 一一对应）。
 *
 * `off` 写「关掉后会怎样」：只收 UI 与行为、**不删数据**（已合并的块、已接的序列、已存的模板都保持原样）。
 */
import { t, type MsgKey } from "../i18n/i18n.svelte";

type FeatureTag = "noisy" | "mutating" | "visual";

/** 标签（内部 id）→ 文案 key；渲染时才取，3.0b₂ 切语言不会冻住 */
export const FEATURE_TAG_KEY: Record<FeatureTag, MsgKey> = {
  noisy: "msg.features.01",
  mutating: "msg.features.02",
  visual: "msg.features.03",
};

export interface FeatureMeta {
  /** 设置键（`settings.rs` 白名单 + `features.rs`） */
  key: string;
  /** 面板行名 */
  label: string;
  /** 关掉后会怎样（面板 title + 说明页） */
  off: string;
  /** 后果标签（一行可两个） */
  tags: FeatureTag[];
  /** 是不是布尔开关（`template_suggest` 是 JSON，行内有门限输入） */
  boolean: boolean;
}

/** 16 个开关的展示顺序（按日常碰到它们的次序排：排程 → 组织 → 模板 → 重复 → 复盘 → 教学 → 托盘） */
export const FEATURES: FeatureMeta[] = [
  {
    key: "merge_enabled",
    get label() {
      return t("msg.features.04");
    },
    get off() {
      return t("msg.features.05");
    },
    tags: ["mutating"],
    boolean: true,
  },
  {
    key: "resize_enabled",
    get label() {
      return t("msg.features.07");
    },
    get off() {
      return t("msg.features.08");
    },
    tags: ["mutating"],
    boolean: true,
  },
  {
    key: "temp_block_enabled",
    get label() {
      return t("msg.features.10");
    },
    get off() {
      return t("msg.features.11");
    },
    tags: ["mutating"],
    boolean: true,
  },
  {
    key: "remnants_enabled",
    get label() {
      return t("msg.features.13");
    },
    get off() {
      return t("msg.features.14");
    },
    tags: ["visual"],
    boolean: true,
  },
  {
    key: "drift_enabled",
    get label() {
      return t("msg.features.16");
    },
    get off() {
      return t("msg.features.17");
    },
    tags: ["noisy"],
    boolean: true,
  },
  {
    key: "sequences_enabled",
    get label() {
      return t("msg.features.19");
    },
    get off() {
      return t("msg.features.20");
    },
    tags: ["mutating"],
    boolean: true,
  },
  {
    key: "multi_select_enabled",
    get label() {
      return t("msg.features.22");
    },
    get off() {
      return t("msg.features.23");
    },
    tags: ["mutating"],
    boolean: true,
  },
  {
    key: "keyboard_enabled",
    get label() {
      return t("msg.features.25");
    },
    get off() {
      return t("msg.features.26");
    },
    tags: ["mutating"],
    boolean: true,
  },
  {
    key: "templates_enabled",
    get label() {
      return t("msg.features.28");
    },
    get off() {
      return t("msg.features.29");
    },
    tags: ["mutating"],
    boolean: true,
  },
  {
    key: "template_suggest",
    get label() {
      return t("msg.features.31");
    },
    get off() {
      return t("msg.features.32");
    },
    tags: ["noisy"],
    boolean: false,
  },
  {
    key: "repeat_enabled",
    get label() {
      return t("msg.features.34");
    },
    get off() {
      return t("msg.features.35");
    },
    tags: ["mutating"],
    boolean: true,
  },
  {
    key: "review_enabled",
    get label() {
      return t("msg.features.37");
    },
    get off() {
      return t("msg.features.38");
    },
    tags: ["visual", "noisy"],
    boolean: true,
  },
  {
    key: "stats_enabled",
    get label() {
      return t("msg.features.41");
    },
    get off() {
      return t("msg.features.42");
    },
    tags: ["visual"],
    boolean: true,
  },
  {
    key: "hints_enabled",
    get label() {
      return t("msg.features.44");
    },
    get off() {
      return t("msg.features.45");
    },
    tags: ["noisy"],
    boolean: true,
  },
  {
    key: "tray_state_enabled",
    get label() {
      return t("msg.features.47");
    },
    get off() {
      return t("msg.features.48");
    },
    tags: ["visual"],
    boolean: true,
  },
  {
    key: "current_hint_enabled",
    get label() {
      return t("msg.features.50");
    },
    get off() {
      return t("msg.features.51");
    },
    tags: ["visual"],
    boolean: true,
  },
  {
    key: "hotkeys_enabled",
    get label() {
      return t("msg.features.53");
    },
    get off() {
      return t("msg.features.54");
    },
    tags: ["noisy"],
    boolean: true,
  },
];

/** 模板建议的门限（默认：满 7 天 · 完成 ≥5 次；理由与调研见 plan §1.4 / T9） */
export interface TemplateSuggest {
  enabled: boolean;
  days: number;
  done: number;
}

export const TEMPLATE_SUGGEST_DEFAULT: TemplateSuggest = { enabled: true, days: 7, done: 5 };

export const TEMPLATE_SUGGEST_KEY = "template_suggest";

/** 门限是否合法（1..365 天 / 0..1000 次；与 Rust `normalize_template_suggest` 同一套） */
export function validTemplateSuggest(v: TemplateSuggest): boolean {
  return (
    typeof v.enabled === "boolean" &&
    Number.isInteger(v.days) &&
    v.days >= 1 &&
    v.days <= 365 &&
    Number.isInteger(v.done) &&
    v.done >= 0 &&
    v.done <= 1000
  );
}

/** 读回来的 `template_suggest`（JSON；非法/缺省回默认） */
export function parseTemplateSuggest(raw: string | undefined): TemplateSuggest {
  if (!raw) return { ...TEMPLATE_SUGGEST_DEFAULT };
  try {
    const value = JSON.parse(raw) as Partial<TemplateSuggest>;
    const candidate: TemplateSuggest = {
      enabled: value.enabled === true || value.enabled === false ? value.enabled : false,
      days: Number(value.days),
      done: Number(value.done),
    };
    return validTemplateSuggest(candidate) ? candidate : { ...TEMPLATE_SUGGEST_DEFAULT };
  } catch {
    return { ...TEMPLATE_SUGGEST_DEFAULT };
  }
}

/** 写回去的规范 JSON（键序固定，和 Rust 端 serde_json 的输出对齐） */
export function templateSuggestToStored(v: TemplateSuggest): string {
  return JSON.stringify({ days: v.days, done: v.done, enabled: v.enabled });
}
