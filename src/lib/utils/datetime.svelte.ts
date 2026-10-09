/**
 * round81（3.1c₁ · `时-01…11`）：**时间与日期显示的唯一实现**（前端）。
 *
 * 规则（出处：`docs/素材库/时间与日期格式调研.md`）：
 * - `time_format` = `system` / `h24` / `h12`；`date_format` = `system` / `dash` / `slash` / `long`，默认都 `system`；
 * - 「跟随系统」= `navigator.language` + `Intl` 的 CLDR 默认（**不是** Windows 区域格式里改过的自定义短日期 ——
 *   平台读不到，说明页写了这一句，`时-02`）；
 * - 12 小时制的整点**不省 `:00`**（`8:00 PM`，`时-11`）；时段后缀只写一次（`8:00–9:00 PM`；跨上下午写两次）；
 * - 固定档在**当前界面语言**的样式下渲染：zh 长式 `2026年10月5日` / 12 小时 `上午8:00`，en 长式 `Oct 5, 2026`；
 * - `.ics` / 文件名 / 时间戳不经过这里（`时-07`）。
 *
 * 结构：**纯核心**（`*At(…, 格式, 系统标签, 界面语言)`，测试与设置样例直接调）+ 读当前状态的外壳
 * （`formatClock` / `formatDateFull` / …）。设置里的「真实样例」用纯核心算**每个选项**的样子，
 * 不靠用户对着文字猜（`设-02`）。
 *
 * 为什么是 `.svelte.ts`：格式跟着设置**响应式**变（切档位后块上时间 / 刻度 / 统计一起换）。
 * 机械扫描 `tools/visual/timefmt-scan.mjs` 保证全仓不再有裸 `format(…"HH:mm"…)`。
 */
import { format } from "date-fns";
import { getLocale, t } from "../i18n/i18n.svelte";

export type TimeFormat = "system" | "h24" | "h12";
export type DateFormat = "system" | "dash" | "slash" | "long";

export const TIME_FORMATS: TimeFormat[] = ["system", "h24", "h12"];
export const DATE_FORMATS: DateFormat[] = ["system", "dash", "slash", "long"];

export function normalizeTimeFormat(raw: string | undefined | null): TimeFormat {
  return TIME_FORMATS.includes(raw as TimeFormat) ? (raw as TimeFormat) : "system";
}
export function normalizeDateFormat(raw: string | undefined | null): DateFormat {
  return DATE_FORMATS.includes(raw as DateFormat) ? (raw as DateFormat) : "system";
}

/** 系统语言标签（Node / 测试环境里没有 `navigator` → 回 zh-CN） */
export function detectSystemLocale(): string {
  return typeof navigator !== "undefined" && navigator.language ? navigator.language : "zh-CN";
}

let timeFormat = $state<TimeFormat>("system");
let dateFormat = $state<DateFormat>("system");
let systemLocale = $state<string>(detectSystemLocale());

export function getTimeFormat(): TimeFormat {
  return timeFormat;
}
export function getDateFormat(): DateFormat {
  return dateFormat;
}
export function setTimeFormat(v: TimeFormat): void {
  timeFormat = v;
  paintTime12();
}
export function setDateFormat(v: DateFormat): void {
  dateFormat = v;
}
/** 测试 / 预览用：换系统语言标签（会同时刷新 `<html data-time12>`） */
export function setSystemLocale(tag: string): void {
  systemLocale = tag || "zh-CN";
  paintTime12();
}

// ------------------------------------------------------------------ 纯核心（显式给格式与标签）

function systemIs12h(sysTag: string): boolean {
  try {
    return new Intl.DateTimeFormat(sysTag, { hour: "numeric" }).resolvedOptions().hour12 === true;
  } catch {
    return false;
  }
}

function use12(fmt: TimeFormat, sysTag: string): boolean {
  if (fmt === "h12") return true;
  if (fmt === "h24") return false;
  return systemIs12h(sysTag);
}

/** 12 小时制写法的语言：`system` 档跟系统 locale，固定档跟**界面语言**（zh = 上午8:00 / en = 8:00 AM） */
function tag12(fmt: TimeFormat, sysTag: string, ui: "zh" | "en"): string {
  if (fmt === "system") return sysTag;
  return ui === "en" ? "en-US" : "zh-CN";
}

type H12 = { clock: string; period: string; periodFirst: boolean };
function h12Parts(d: Date, tag: string): H12 {
  try {
    const parts = new Intl.DateTimeFormat(tag, {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(d);
    const val = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const periodFirst = parts.findIndex((p) => p.type === "dayPeriod") < parts.findIndex((p) => p.type === "hour");
    return {
      clock: `${val("hour") || String(d.getHours() % 12 || 12)}:${val("minute") || String(d.getMinutes()).padStart(2, "0")}`,
      period: val("dayPeriod"),
      periodFirst,
    };
  } catch {
    const h = d.getHours();
    return {
      clock: `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}`,
      period: h < 12 ? "AM" : "PM",
      periodFirst: false,
    };
  }
}

/** 单个时刻（显式格式）：24h `09:15`（旧行为）/ 12h `8:00 PM`（zh = `上午8:00`） */
export function formatClockAt(
  sec: number,
  fmt: TimeFormat,
  sysTag: string = systemLocale,
  ui: "zh" | "en" = getLocale(),
): string {
  const d = new Date(sec * 1000);
  if (!use12(fmt, sysTag)) return format(d, "HH:mm");
  const p = h12Parts(d, tag12(fmt, sysTag, ui));
  return p.periodFirst ? `${p.period}${p.clock}` : `${p.clock} ${p.period}`;
}

/**
 * 时段（显式格式）：24h `09:00–10:30`；12h 同时段只写一次后缀（`8:00–9:00 PM`）、跨上下午写两次（`11:00 AM–1:00 PM`）。
 * 用 en dash `–`（与旧实现一致）。
 */
export function formatClockRangeAt(
  startSec: number,
  endSec: number,
  fmt: TimeFormat,
  sysTag: string = systemLocale,
  ui: "zh" | "en" = getLocale(),
): string {
  if (!use12(fmt, sysTag)) {
    return `${format(new Date(startSec * 1000), "HH:mm")}–${format(new Date(endSec * 1000), "HH:mm")}`;
  }
  const a = h12Parts(new Date(startSec * 1000), tag12(fmt, sysTag, ui));
  const b = h12Parts(new Date(endSec * 1000), tag12(fmt, sysTag, ui));
  if (a.period === b.period) {
    return a.periodFirst ? `${a.period}${a.clock}–${b.clock}` : `${a.clock}–${b.clock} ${a.period}`;
  }
  return a.periodFirst
    ? `${a.period}${a.clock}–${b.period}${b.clock}`
    : `${a.clock} ${a.period}–${b.clock} ${b.period}`;
}

/** 短日期**片段**（显式格式）：dash `10-05` · slash `10/05` · long `10月5日` / `Oct 5` · system 跟 locale */
export function formatDateFragmentAt(
  day: Date,
  fmt: DateFormat,
  sysTag: string = systemLocale,
  ui: "zh" | "en" = getLocale(),
): string {
  switch (fmt) {
    case "dash":
      return format(day, "MM-dd");
    case "slash":
      return format(day, "MM/dd");
    case "long":
      return ui === "en" ? format(day, "MMM d") : t("msg.datetime.01", { m: day.getMonth() + 1, d: day.getDate() });
    default:
      try {
        return new Intl.DateTimeFormat(sysTag, { month: "numeric", day: "numeric" }).format(day);
      } catch {
        return format(day, "MM-dd");
      }
  }
}

/** 完整日期（显式格式）：dash `2026-10-05` · slash `2026/10/05` · long `2026年10月5日` / `Oct 5, 2026` · system `2026/10/5` */
export function formatDateFullAt(
  sec: number,
  fmt: DateFormat,
  sysTag: string = systemLocale,
  ui: "zh" | "en" = getLocale(),
): string {
  const d = new Date(sec * 1000);
  switch (fmt) {
    case "dash":
      return format(d, "yyyy-MM-dd");
    case "slash":
      return format(d, "yyyy/MM/dd");
    case "long":
      return ui === "en"
        ? format(d, "MMM d, yyyy")
        : t("msg.datetime.02", { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() });
    default:
      try {
        return new Intl.DateTimeFormat(sysTag, {
          year: "numeric",
          month: "numeric",
          day: "numeric",
        }).format(d);
      } catch {
        return format(d, "yyyy-MM-dd");
      }
  }
}

// ------------------------------------------------------------------ 读当前状态的外壳（组件调用这些）

/** 单个时刻：`09:15` / `8:00 PM`（跟着当前设置） */
export function formatClock(sec: number): string {
  return formatClockAt(sec, timeFormat);
}

/** 时段：`09:00–10:30` / `8:00–9:00 PM`（跟着当前设置） */
export function formatClockRange(startSec: number, endSec: number): string {
  return formatClockRangeAt(startSec, endSec, timeFormat);
}

/** 短日期片段（跟着当前设置） */
export function formatDateFragment(day: Date): string {
  return formatDateFragmentAt(day, dateFormat);
}

/** 完整日期（跟着当前设置） */
export function formatDateFull(sec: number): string {
  return formatDateFullAt(sec, dateFormat);
}

/** 当前是不是 12 小时制 —— 时间轴刻度栏 / 迷你预览要按它加宽 */
export function is12Hour(): boolean {
  return use12(timeFormat, systemLocale);
}

/** 设置里的「真实样例」用：固定一天（2026-10-05 20:30 本地）—— 不随当前周变化 */
export const SAMPLE_DAY_SEC = Math.floor(new Date(2026, 9, 5, 20, 30, 0).getTime() / 1000);

/** 某个时间格式档位的真实样例（设置下拉的选项文字用） */
export function sampleClock(fmt: TimeFormat): string {
  return formatClockAt(SAMPLE_DAY_SEC, fmt);
}

/** 某个日期格式档位的真实样例（设置下拉的选项文字用） */
export function sampleDate(fmt: DateFormat): string {
  return formatDateFullAt(SAMPLE_DAY_SEC, fmt);
}

/** `<html data-time12>` —— 时间轴刻度栏 / 迷你预览靠它加宽（12 小时制标签更宽） */
function paintTime12(): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.time12 = is12Hour() ? "on" : "off";
}

// 模块加载时先落一次（设置读回来之前按 `system` 走；读回后由 `setTimeFormat` 再落）
paintTime12();
