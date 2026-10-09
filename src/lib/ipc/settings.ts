import { call } from "./call";
import type { Settings } from "./types";

/**
 * v2 ④ 的设置命令（round44 才补做）。**白名单以 `src-tauri/src/commands/settings.rs` 的
 * `KNOWN_KEYS` 为准**（round69 起 **36 键**：理智值 / 提醒 / 免打扰 / 计划任务 / Backlog 栏宽与视图记忆 /
 * 16 个功能开关 + 模板建议 / 全局快捷键 / 外观布局三个 / 成就两键 / 每周重复）——
 * 非白名单键后端直接拒；值也由后端校验（非法值报中文错误、不落库）。
 */
export function getSettings(): Promise<Settings> {
  return call<Settings>("get_settings");
}

/** 写一个已知键；值也由后端校验（非法值报中文错误、不落库） */
export function setSetting(key: string, value: string): Promise<void> {
  return call<void>("set_setting", { key, value });
}

/**
 * round81（3.1c₁ · 深-03）：`ui_locale=system` 时问后端要**系统语言标签**（BCP-47，如 `zh-CN` / `en-GB`）。
 * 前端先用 `navigator.language` 同步渲染；启动后用这个标签后台校准**界面语言与时间格式**（同一来源）。
 */
export function systemLocale(): Promise<string> {
  return call<string>("system_locale");
}

/**
 * round82（3.1c₂ · 淡-05）：夜间档跨界 —— 让后端按**库里**的档位 + 时段 + 当前时刻重解析窗口主题。
 * **不写任何设置**（与 `set_setting` 不同）；`ui_theme != night` 时等于重放当前档（幂等）。
 */
export function refreshWindowTheme(): Promise<void> {
  return call<void>("refresh_window_theme");
}

/**
 * round79（78-01）：**恢复默认设置** —— 后端把白名单键删掉（= 下次读取落回默认值）；
 * **保留界面语言**、**不碰数据**；后端同时把副作用（托盘 / 快捷键 / 主题…）回放一遍。
 */
export function resetSettings(): Promise<void> {
  return call<void>("reset_settings");
}
