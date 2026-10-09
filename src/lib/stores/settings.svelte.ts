/**
 * C18（round63）：设置批次新增偏好的**前端状态**。
 *
 * 后端仍是唯一真相源（`get_settings` / `set_setting` 白名单，见 `src-tauri/src/commands/settings.rs`）——
 * 这里只做三件事：读回来 / 写出去 / **写失败返回 false**（调用方把控件拨回去，BQ 那套口径）。
 *
 * 目前容纳：**免打扰（R41）** · **开始提醒提前（R49）** · **计划任务开关** ·
 * **Backlog 视图记忆（R48）** · **round64 的 15 个功能开关（C10，默认全开）** · **round74 的界面语言**。
 */
import { getSettings, setSetting, systemLocale, refreshWindowTheme } from "../ipc/settings";
import {
  FEATURES,
  parseTemplateSuggest,
  TEMPLATE_SUGGEST_DEFAULT,
  TEMPLATE_SUGGEST_KEY,
  templateSuggestToStored,
  validTemplateSuggest,
  type TemplateSuggest,
} from "../utils/features";
import {
  collapsedFromStored,
  collapsedToStored,
  filterFromStored,
  filterToStored,
  type BacklogFilter,
  BACKLOG_ALL,
} from "../utils/backlog-view";
import { nextDailyMoment, normalizeHHMM } from "../utils/quiet";
import { getLocale, normalizeLocaleChoice, resolveLocaleChoice, setLocale, type Locale, type LocaleChoice } from "../i18n/i18n.svelte";
import { setSystemLocale } from "../utils/datetime.svelte";
import { initKeymap } from "./keymap.svelte";
import { applyAppearance } from "./appearance.svelte";
import { normalizeDensity, normalizeFontFamily, normalizeIconSet, normalizeNightEnd, normalizeNightStart, normalizePalette, normalizeSecondLine, normalizeTheme, switchOn, themeForNow, type Density, type FontFamily, type IconSet, type Palette, type SecondLine, type Theme } from "../utils/appearance";
// round81（3.1c₁ · 时-01…11）：时间 / 日期格式档位 —— 显示实现唯一在 `utils/datetime.svelte.ts`
import {
  normalizeDateFormat,
  normalizeTimeFormat,
  setDateFormat,
  setTimeFormat,
  type DateFormat,
  type TimeFormat,
} from "../utils/datetime.svelte";

/** 开始提醒提前的可选档位（分钟；0 = 到点）——与 Rust `REMIND_LEAD_CHOICES` 一致 */
export const REMIND_LEAD_CHOICES = [0, 5, 10, 15, 30] as const;

/** 暂停提醒的两个快捷档（分钟）——设置面板的按钮与说明页共用，防手抄漂移 */
export const QUIET_PRESET_MINUTES = [30, 60] as const;

export const prefs = $state<{
  /** 免打扰截止时刻（Unix 秒；`0` = 没静音） */
  quietUntil: number;
  /** 「到明早」的时刻（`"HH:MM"`，用户可改；默认 08:00） */
  quietMorning: string;
  /** 开始提醒提前的分钟数（0 = 到点） */
  remindLeadMinutes: number;
  /** 计划任务（退出后仍按时唤醒）—— **默认关**；只有显式开过才为 true */
  schedulerEnabled: boolean;
  /** R48：Backlog 的筛选（全部 / 未分类 / 某个分类） */
  backlogFilter: BacklogFilter;
  /** R48：Backlog 分组视图开着吗 */
  backlogGrouped: boolean;
  /** R48：收起的那些分组（名字） */
  backlogCollapsed: string[];
  /** round64（C10）：14 个布尔功能开关的生效值（默认全开；键名见 `utils/features.ts`） */
  features: Record<string, boolean>;
  /** round64（C10）：模板建议（开关 + 门限；默认 7 天 / 5 次） */
  templateSuggest: TemplateSuggest;
  /** round68（19.1）：成就（暗章）总开关 —— **默认开**（round85 起唯一版本恒可用） */
  achievementsEnabled: boolean;
  /** round68（19.1）：点亮时弹提示（默认开） */
  achievementToast: boolean;
  /** round74（3.0b₂）：界面语言档位（round81 起含 `system` = 跟随系统，默认） */
  uiLocale: LocaleChoice;
  /** round76（3.1a）：字号密度（紧凑 / 舒适 / 宽松） */
  uiDensity: Density;
  /** round76（3.1a）：深浅色（跟随系统 / 亮 / 暗）—— 写出去由 Rust `set_theme` 落到窗口 */
  uiTheme: Theme;
  /** round76（3.1a）：配色（暖砂 / 冷白 / 素灰绿） */
  uiPalette: Palette;
  /** round76（3.1a）：层条上色（关掉 = 中性色，条仍在、功能不动） */
  layerBarColor: boolean;
  /** round76（3.1a）：分类底边条（默认关） */
  categoryBar: boolean;
  /** round77（3.1b）：图标集（五套；默认 Lucide） */
  iconSet: IconSet;
  /** round77（3.1b）：块内第二行（`time` 默认 = 旧行为 / `remaining`） */
  blockSecondLine: SecondLine;
  /** round87（3.3）：界面字体族（五档系统字体；默认档 = 旧观感） */
  fontFamily: FontFamily;
  /** round78（3.1b₂ · 设-01）：时间轴的「现在线」（**默认开** = 旧行为） */
  nowLine: boolean;
  /** round80（79-02）：模板面板旁的**迷你周视图**（**默认开** = 新体验；关掉 = 旧行为只列列表） */
  templatePreview: boolean;
  /** round81（3.1c₁）：时间格式（`system` 默认 = 旧行为之外的新默认，你 2026-10-05 拍板） */
  timeFormat: TimeFormat;
  /** round81（3.1c₁）：日期格式（`system` 默认） */
  dateFormat: DateFormat;
  /** round82（3.1c₂ · 淡-07）：非工作时段淡化开关（**默认开** —— 纯展示、可一眼关掉） */
  nightDim: boolean;
  /** round82（3.1c₂ · 淡-11）：夜间时段起点（`HH:MM`，默认 22:00；与第四档主题共用） */
  nightStart: string;
  /** round82（3.1c₂ · 淡-11）：夜间时段终点（`HH:MM`，默认 06:00；起 > 止 = 跨天） */
  nightEnd: string;
}>({
  quietUntil: 0,
  quietMorning: "08:00",
  remindLeadMinutes: 0,
  schedulerEnabled: false,
  backlogFilter: BACKLOG_ALL,
  backlogGrouped: false,
  backlogCollapsed: [],
  features: Object.fromEntries(FEATURES.filter((f) => f.boolean).map((f) => [f.key, true])),
  templateSuggest: { ...TEMPLATE_SUGGEST_DEFAULT },
  achievementsEnabled: true,
  achievementToast: true,
  uiLocale: "system",
  uiDensity: "comfortable",
  uiTheme: "system",
  uiPalette: "warm",
  layerBarColor: true,
  categoryBar: false,
  iconSet: "lucide",
  blockSecondLine: "time",
  fontFamily: "default",
  nowLine: true,
  templatePreview: true,
  timeFormat: "system",
  dateFormat: "system",
  nightDim: true,
  nightStart: "22:00",
  nightEnd: "06:00",
});

function applyValues(values: Record<string, string>): void {
  const until = Number(values["quiet_until"]);
  prefs.quietUntil = Number.isFinite(until) && until > 0 ? until : 0;
  prefs.quietMorning = normalizeHHMM(values["quiet_morning_at"] ?? "") ?? "08:00";
  const lead = Number(values["remind_lead_minutes"]);
  prefs.remindLeadMinutes = (REMIND_LEAD_CHOICES as readonly number[]).includes(lead) ? lead : 0;
  prefs.schedulerEnabled = (values["scheduler_enabled"] ?? "0") === "1";
  prefs.backlogFilter = filterFromStored(values["backlog_filter"]);
  prefs.backlogGrouped = values["backlog_grouped"] === "1";
  prefs.backlogCollapsed = collapsedFromStored(values["backlog_collapsed"]);
  // round64（C10）：功能开关 —— **只有显式 "0" 才算关**（缺省/非法都当开，与 Rust `features::enabled` 同口径）
  for (const f of FEATURES) {
    if (!f.boolean) continue;
    prefs.features[f.key] = values[f.key] !== "0";
  }
  prefs.templateSuggest = parseTemplateSuggest(values[TEMPLATE_SUGGEST_KEY]);
  // round68（19.1）：成就两键 —— 默认开（只有显式 "0" 才关）
  prefs.achievementsEnabled = (values["achievements_enabled"] ?? "1") !== "0";
  prefs.achievementToast = (values["achievement_toast"] ?? "1") !== "0";
  // round74（3.0b₂）：语言 —— 后端回 zh / en；round81（3.1c₁ · 深-03）：多一档 `system`（跟随系统，默认）
  prefs.uiLocale = normalizeLocaleChoice(values["ui_locale"]);
  setLocale(resolveLocaleChoice(prefs.uiLocale));
  // 前端先用 `navigator.language` 同步渲染；启动后拿 Rust `sys-locale` 的结果**后台校准**（两边同源）
  void calibrateSystemLocale();
  // round81（3.1c₁）：时间 / 日期格式 —— 后端只会回白名单值（缺省 / 坏值已归一成 system）
  prefs.timeFormat = normalizeTimeFormat(values["time_format"]);
  prefs.dateFormat = normalizeDateFormat(values["date_format"]);
  setTimeFormat(prefs.timeFormat);
  setDateFormat(prefs.dateFormat);
  // round76（3.1a）：外观五件 —— 坏值 / 缺省都回默认（归一实现只有 `utils/appearance.ts` 一份）；
  // 落 `<html data-*>` + 把格高喂给手势数学
  prefs.uiDensity = normalizeDensity(values["ui_density"]);
  prefs.uiTheme = normalizeTheme(values["ui_theme"]);
  prefs.uiPalette = normalizePalette(values["ui_palette"]);
  prefs.layerBarColor = switchOn(values["layer_bar_color"], true);
  prefs.categoryBar = switchOn(values["category_bar"], false);
  prefs.iconSet = normalizeIconSet(values["icon_set"]);
  prefs.blockSecondLine = normalizeSecondLine(values["block_second_line"]);
  // round87（3.3）：界面字体族（缺省 / 坏值回默认档）
  prefs.fontFamily = normalizeFontFamily(values["ui_font"]);
  prefs.nowLine = switchOn(values["now_line"], true);
  prefs.templatePreview = switchOn(values["template_preview"], true);
  // round82（3.1c₂ · 淡-*）：夜间三键 —— 开关同口径；时段归一成 `HH:MM`（缺省 / 坏值回 22:00 / 06:00）
  prefs.nightDim = switchOn(values["night_dim"], true);
  prefs.nightStart = normalizeNightStart(values["night_start"]);
  prefs.nightEnd = normalizeNightEnd(values["night_end"]);
  // round82（3.1c₂ · 绑-08）：键位覆盖 —— 逐条回落（坏 JSON / 未知 id / 坏串 / 锁定键 → 回默认）
  initKeymap(values["key_bindings"]);
  applyAppearance({
    density: prefs.uiDensity,
    palette: prefs.uiPalette,
    iconSet: prefs.iconSet,
    blockSecondLine: prefs.blockSecondLine,
    font: prefs.fontFamily,
    layerBarColor: prefs.layerBarColor,
    categoryBar: prefs.categoryBar,
  });
}

/**
 * 读一次设置。启动时调（`App.svelte` onMount）；**面板每次打开也调**——
 * 托盘菜单那边也能改静音，面板里的状态别落后（round53「拿旧快照」那类教训）。
 */
export async function loadPrefs(): Promise<boolean> {
  try {
    const s = await getSettings();
    applyValues(s.values);
    return true;
  } catch (err) {
    console.error("[settings] 读设置失败（用默认值）", err);
    return false; // round79（6b 二轮 P2）：「恢复默认设置」靠它决定要不要说「已恢复」
  }
}

/** 写 `quiet_until`（Unix 秒）。成功 true；失败 false（IPC 层已弹 Toast） */
async function writeQuietUntil(seconds: number): Promise<boolean> {
  try {
    await setSetting("quiet_until", String(seconds));
  } catch {
    return false;
  }
  prefs.quietUntil = seconds;
  return true;
}

/** 静音 N 分钟（30 / 60 两档按钮走它） */
export function quietForMinutes(minutes: number, nowMs = Date.now()): Promise<boolean> {
  return writeQuietUntil(Math.floor(nowMs / 1000) + minutes * 60);
}

/** 静音到「明早」（用户设定的那个时刻） */
export function quietUntilMorning(nowMs = Date.now()): Promise<boolean> {
  const target = nextDailyMoment(new Date(nowMs), prefs.quietMorning);
  return writeQuietUntil(Math.floor(target.getTime() / 1000));
}

/** 静音到指定时刻（「自定义…」；传本地日期时间的毫秒） */
export function quietUntilAt(ms: number): Promise<boolean> {
  return writeQuietUntil(Math.floor(ms / 1000));
}

/** 取消静音（恢复提醒） */
export function clearQuiet(): Promise<boolean> {
  return writeQuietUntil(0);
}

/** 改「明早」的时刻（设置里的小时间框；写失败返回 false，控件拨回） */
export async function saveQuietMorning(hhmm: string): Promise<boolean> {
  const text = normalizeHHMM(hhmm);
  if (!text) return false;
  try {
    await setSetting("quiet_morning_at", text);
  } catch {
    return false;
  }
  prefs.quietMorning = text;
  return true;
}

/** 改开始提醒的提前档位（0 = 到点；写失败返回 false，控件拨回） */
export async function saveRemindLead(minutes: number): Promise<boolean> {
  if (!(REMIND_LEAD_CHOICES as readonly number[]).includes(minutes)) return false;
  try {
    await setSetting("remind_lead_minutes", String(minutes));
  } catch {
    return false;
  }
  prefs.remindLeadMinutes = minutes;
  return true;
}

/** 开/关「计划任务」（退出后仍按时唤醒）。失败返回 false（调用方把勾拨回） */
export async function saveSchedulerEnabled(on: boolean): Promise<boolean> {
  try {
    await setSetting("scheduler_enabled", on ? "1" : "0");
  } catch {
    return false;
  }
  prefs.schedulerEnabled = on;
  return true;
}

// ---------------------------------------------------------------- round64（C10）：功能开关

/** 这个功能开着吗（缺省/未知键 → 开；与 Rust `features::enabled` 同口径，界面各处加锁读它） */
export function featureOn(key: string): boolean {
  return prefs.features[key] !== false;
}

/** 开/关一个功能（写失败返回 false，调用方把勾拨回 —— round54 BQ 那套） */
export async function saveFeature(key: string, on: boolean): Promise<boolean> {
  if (!FEATURES.some((f) => f.boolean && f.key === key)) return false;
  try {
    await setSetting(key, on ? "1" : "0");
  } catch {
    return false;
  }
  prefs.features[key] = on;
  return true;
}

/** 存模板建议（开关 + 门限；非法值当场拒，写失败返回 false） */
export async function saveTemplateSuggest(next: TemplateSuggest): Promise<boolean> {
  if (!validTemplateSuggest(next)) return false;
  try {
    await setSetting(TEMPLATE_SUGGEST_KEY, templateSuggestToStored(next));
  } catch {
    return false;
  }
  prefs.templateSuggest = { ...next };
  return true;
}

// ---------------------------------------------------------------- R48：Backlog 视图记忆

/** 存 Backlog 的筛选（失败返回 false —— 界面不改，等于没生效） */
export async function saveBacklogFilter(filter: BacklogFilter): Promise<boolean> {
  try {
    await setSetting("backlog_filter", filterToStored(filter));
  } catch {
    return false;
  }
  prefs.backlogFilter = filter;
  return true;
}

/** 存 Backlog 的分组开关 */
export async function saveBacklogGrouped(on: boolean): Promise<boolean> {
  try {
    await setSetting("backlog_grouped", on ? "1" : "0");
  } catch {
    return false;
  }
  prefs.backlogGrouped = on;
  return true;
}

/** 存「收起的那些分组」（去重后写；失败则界面不变） */
export async function saveBacklogCollapsed(names: string[]): Promise<boolean> {
  const canonical = [...new Set(names)];
  try {
    await setSetting("backlog_collapsed", collapsedToStored(canonical));
  } catch {
    return false;
  }
  prefs.backlogCollapsed = canonical;
  return true;
}

// ---------------------------------------------------------------- round68（19.1）：成就（暗章）

/** 开/关成就（写失败返回 false，调用方把勾拨回） */
export async function saveAchievementsEnabled(on: boolean): Promise<boolean> {
  try {
    await setSetting("achievements_enabled", on ? "1" : "0");
  } catch {
    return false;
  }
  prefs.achievementsEnabled = on;
  return true;
}

/** 开/关「点亮时弹提示」 */
export async function saveAchievementToast(on: boolean): Promise<boolean> {
  try {
    await setSetting("achievement_toast", on ? "1" : "0");
  } catch {
    return false;
  }
  prefs.achievementToast = on;
  return true;
}

// ---------------------------------------------------------------- round74（3.0b₂）：语言

/** 切换界面语言（写失败返回 false —— 界面保持原语言；成功后才更新响应式状态） */
export async function saveUiLocale(next: LocaleChoice): Promise<boolean> {
  try {
    await setSetting("ui_locale", next);
  } catch {
    return false;
  }
  prefs.uiLocale = next;
  setLocale(resolveLocaleChoice(next));
  if (next === "system") void calibrateSystemLocale();
  // round74（3.0b₂）：成就的文本由 Rust 渲染 → 重新取一次；窗口标题 / 托盘 tooltip 在 Rust 侧刷新
  const { loadAchievements } = await import("./achievements.svelte");
  await loadAchievements();
  return true;
}

/** round81（3.1c₁ · 深-03）：`system` 档的后台校准 —— 问 Rust（`sys-locale`）拿**系统语言标签**。
 *  拿到后两头都跟它对齐：① 界面语言；② 时间 / 日期格式的 `system` 档（`setSystemLocale`）——
 *  这样 `en-GB`（24 小时）与 `en-US`（12 小时）不会因为“前端 navigator / 后端 sys-locale”两个源而分叉。
 *  前端 `navigator.language` 只负责**启动那一帧**的同步渲染。 */
async function calibrateSystemLocale(): Promise<void> {
  if (prefs.uiLocale !== "system") return;
  try {
    const tag = await systemLocale();
    // 只认像语言标签的值（`zh-CN` / `en-GB` / `zh-Hant-TW`）；别的（旧包 / 假后端 / 异常值）不动
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)) return;
    setSystemLocale(tag);
    const lang: Locale = tag.toLowerCase().startsWith("zh") ? "zh" : "en";
    if (lang !== getLocale()) {
      setLocale(lang);
      const { loadAchievements } = await import("./achievements.svelte");
      await loadAchievements();
    }
  } catch {
    /* ipc 层已弹 Toast；前端那套 `navigator.language` 已经生效 */
  }
}

// ---------------------------------------------------------------- round81（3.1c₁）：时间与日期

/** 改「时间格式」（写失败返回 false —— 控件自己拨回去） */
export async function saveTimeFormat(next: TimeFormat): Promise<boolean> {
  try {
    await setSetting("time_format", next);
  } catch {
    return false;
  }
  prefs.timeFormat = next;
  setTimeFormat(next);
  return true;
}

/** 改「日期格式」（写失败返回 false） */
export async function saveDateFormat(next: DateFormat): Promise<boolean> {
  try {
    await setSetting("date_format", next);
  } catch {
    return false;
  }
  prefs.dateFormat = next;
  setDateFormat(next);
  return true;
}

// ------------------------------------------------ round76（3.1a）：外观五件

/** 写一个外观键（成功才动响应式状态；失败返回 false 让控件拨回去） */
async function writeAppearance(key: string, value: string): Promise<boolean> {
  try {
    await setSetting(key, value);
    return true;
  } catch {
    return false;
  }
}

/** 字号密度（紧凑 / 舒适 / 宽松）—— 即时生效（`<html data-density>` + 格高） */
export async function saveDensity(next: Density): Promise<boolean> {
  if (!(await writeAppearance("ui_density", next))) return false;
  prefs.uiDensity = next;
  applyAppearance({ density: next });
  return true;
}

/** 深浅色（跟随系统 / 亮 / 暗 / 按时间）—— 真正落窗口的是 Rust 侧 `set_theme`（`set_setting` 的钩子） */
export async function saveTheme(next: Theme): Promise<boolean> {
  if (!(await writeAppearance("ui_theme", next))) return false;
  prefs.uiTheme = next;
  // round82（淡-04）：选了「按时间」立刻按当前时刻判一次（不等下一个 60 秒节拍）
  void syncNightTheme();
  return true;
}

/** 配色（暖砂 / 冷白 / 素灰绿）—— 6 组 token 整套换 */
export async function savePalette(next: Palette): Promise<boolean> {
  if (!(await writeAppearance("ui_palette", next))) return false;
  prefs.uiPalette = next;
  applyAppearance({ palette: next });
  return true;
}

/** 层条上色开关（关掉 = 条仍在、只换中性色；功能一律不动） */
export async function saveLayerBarColor(on: boolean): Promise<boolean> {
  if (!(await writeAppearance("layer_bar_color", on ? "1" : "0"))) return false;
  prefs.layerBarColor = on;
  applyAppearance({ layerBarColor: on });
  return true;
}

/** 分类底边条开关（关掉 = 不画） */
export async function saveCategoryBar(on: boolean): Promise<boolean> {
  if (!(await writeAppearance("category_bar", on ? "1" : "0"))) return false;
  prefs.categoryBar = on;
  applyAppearance({ categoryBar: on });
  return true;
}

/** round77（3.1b）：图标集（五套）—— 只换画法，行为与 i18n 键不变 */
export async function saveIconSet(next: IconSet): Promise<boolean> {
  if (!(await writeAppearance("icon_set", next))) return false;
  prefs.iconSet = next;
  applyAppearance({ iconSet: next });
  return true;
}

/** round77（3.1b）：块内第二行（时间 / 剩余分钟）—— `time` = 旧行为 */
export async function saveBlockSecondLine(next: SecondLine): Promise<boolean> {
  if (!(await writeAppearance("block_second_line", next))) return false;
  prefs.blockSecondLine = next;
  applyAppearance({ blockSecondLine: next });
  return true;
}

/** round87（3.3）：界面字体族（五档）—— 即时生效（`<html data-font>`），只改 `--font-ui` */
export async function saveFontFamily(next: FontFamily): Promise<boolean> {
  if (!(await writeAppearance("ui_font", next))) return false;
  prefs.fontFamily = next;
  applyAppearance({ font: next });
  return true;
}

/** round78（3.1b₂ · 设-01）：现在线开关（关掉 = 不画那条线；默认开 = 旧行为） */
export async function saveNowLine(on: boolean): Promise<boolean> {
  if (!(await writeAppearance("now_line", on ? "1" : "0"))) return false;
  prefs.nowLine = on;
  return true;
}

/** round80（79-02）：模板预览开关（关掉 = 模板面板旁不再画迷你周视图；默认开） */
export async function saveTemplatePreview(on: boolean): Promise<boolean> {
  if (!(await writeAppearance("template_preview", on ? "1" : "0"))) return false;
  prefs.templatePreview = on;
  return true;
}

// ------------------------------------------------ round82（3.1c₂ · 淡-*）：夜间淡化 + 第四档「按时间」

/**
 * 夜间档的**到点重算**（`淡-05`）：前端 60 秒节拍（`App.svelte`）与三处写入后调它。
 * - `ui_theme != night` → 空操作（并清掉记忆，下次切回夜间档时立刻重算）；
 * - 目标与「上次已应用」不同才调后端；后端读同一份数据重算（**幂等、不写设置**）。
 * 备注：`lastNightTheme` 只是「少调一次 IPC」的节流 —— 真相源仍是后端；失败就清记忆、下个节拍重试。
 */
let lastNightTheme: "light" | "dark" | null = null;
export async function syncNightTheme(): Promise<void> {
  if (prefs.uiTheme !== "night") {
    lastNightTheme = null;
    return;
  }
  const want = themeForNow(Date.now(), prefs.nightStart, prefs.nightEnd);
  if (want === lastNightTheme) return;
  // **先记账再等**（乐观）：写设置触发的 store 调用与 App 的 `$effect` 会撞在一次
  //（实测每次变目标发了两条 IPC）；失败回滚，下个节拍/下次改动重来。
  lastNightTheme = want;
  try {
    await refreshWindowTheme();
  } catch {
    lastNightTheme = null;
  }
}

/** round82（淡-07）：夜间淡化开关（默认开）—— 渲染层读 `prefs.nightDim` + 时段算带 */
export async function saveNightDim(on: boolean): Promise<boolean> {
  if (!(await writeAppearance("night_dim", on ? "1" : "0"))) return false;
  prefs.nightDim = on;
  return true;
}

/** round82（淡-11）：夜间时段起点 —— 归一成 `HH:MM`；改完立刻按当前时刻重判第四档主题 */
export async function saveNightStart(hhmm: string): Promise<boolean> {
  const text = normalizeNightStart(hhmm);
  if (!(await writeAppearance("night_start", text))) return false;
  prefs.nightStart = text;
  void syncNightTheme();
  return true;
}

/** round82（淡-11）：夜间时段终点 —— 与起点同一套（起 > 止 = 跨天） */
export async function saveNightEnd(hhmm: string): Promise<boolean> {
  const text = normalizeNightEnd(hhmm);
  if (!(await writeAppearance("night_end", text))) return false;
  prefs.nightEnd = text;
  void syncNightTheme();
  return true;
}
