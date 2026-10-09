/**
 * round45（0.8.1）：布局设置 —— **Backlog 栏宽**（拖两栏之间的分隔条改它）。
 * round67：扩成「外观 / 布局」偏好 —— 面板形态（`open`/`rail`；round67.2 删掉「整栏隐藏」）·
 * 隐藏周末 · 键位提示栏（`always`/`hidden`；round67.1 按你实测删掉了「按需」档）。
 *
 * 为什么单独一个 store（而不是塞进 `ui.svelte.ts`）：`ipc/call.ts` 依赖 `ui.svelte.ts` 的 `toast`，
 * 而这里要调 `ipc/settings` —— 放进 ui 会形成 `ui ↔ ipc` 的环（本仓踩过 `blocks ↔ selection` 那个坑）。
 *
 * 落库走 `settings` 白名单键（键名与取值范围在 Rust `commands/settings.rs` 也有同一套校验，两边都挡一道）。
 */
import { getSettings, setSetting } from "../ipc/settings";
import { setSlotHeightProvider } from "../utils/timeline";
import { appearance, slotHeightPx } from "./appearance.svelte";

/** 栏宽夹子（与 Rust 的 `MIN_BACKLOG_WIDTH` / `MAX_BACKLOG_WIDTH` 同一个区间） */
export const BACKLOG_MIN = 180;
export const BACKLOG_MAX = 520;
/** 默认 260 = 舒适档的密度默认（双击分隔条 / 复位布局回到它；宽-05：240/260/280） */
export const BACKLOG_DEFAULT = 260;

/** round81（3.1c₁ · 宽-05）：栏宽的**密度默认**（紧凑 240 / 舒适 260 / 宽松 280） */
export function backlogDefault(): number {
  if (appearance.density === "compact") return 240;
  if (appearance.density === "loose") return 280;
  return BACKLOG_DEFAULT;
}

/** round81（3.1c₁ · 宽-04）：时间刻度档位（格高 px；与 tokens 的三档 26/30/34 同一批值，档位更细） */
export const SLOT_HEIGHTS = [
  18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62, 64,
] as const;
export type SlotHeight = "auto" | (typeof SLOT_HEIGHTS)[number];

/** 生效的格高：手动值优先（宽-10），`auto` 跟密度 */
export function slotHeightEffective(): number {
  return layout.slotHeight === "auto" ? slotHeightPx() : layout.slotHeight;
}

/** round67：Backlog 面板当前形态 —— 展开 / 收起成细轨（round67.2：「整栏隐藏」档已删） */
export type BacklogPane = "open" | "rail";
/** round67：键位提示栏显示策略 */
export type HintBarMode = "always" | "hidden";

export function clampBacklogWidth(px: number): number {
  if (!Number.isFinite(px)) return BACKLOG_DEFAULT;
  return Math.max(BACKLOG_MIN, Math.min(BACKLOG_MAX, Math.round(px)));
}

export const layout = $state<{
  backlogWidth: number;
  backlogPane: BacklogPane;
  weekendHidden: boolean;
  hintBarMode: HintBarMode;
  /** round81（3.1c₁）：时间刻度格高（`auto` = 跟密度；数字 = 用户手动选的档位） */
  slotHeight: SlotHeight;
}>({
  backlogWidth: BACKLOG_DEFAULT,
  backlogPane: "open",
  weekendHidden: false,
  hintBarMode: "always",
  slotHeight: "auto",
});

/** 把生效格高落到 `<html>`（手动档 = 内联覆盖；`auto` = 撤掉内联让 tokens 的密度档生效） */
function paintSlotHeight(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (layout.slotHeight === "auto") root.style.removeProperty("--slot-height");
  else root.style.setProperty("--slot-height", `${layout.slotHeight}px`);
}

/** 启动时读一次（没存过 / 坏值都回默认；读失败不拦启动）；键位提示有两个面板入口，读同一份 */
export async function loadLayoutSettings(): Promise<boolean> {
  try {
    const s = await getSettings();
    applyLayoutValues(s.values);
    return true;
  } catch (err) {
    console.error("[layout] 读设置失败（用默认值）", err);
    return false; // round79（6b 二轮 P2）：调用方要知道「读回来没有」
  }
}

/** 把一份 `get_settings` 的 values 应用到布局状态（`loadLayoutSettings` 与复位失败的回读共用） */
function applyLayoutValues(values: Record<string, string>): void {
  const px = Number(values["backlog_width"]);
  if (Number.isFinite(px) && px > 0) layout.backlogWidth = clampBacklogWidth(px);
  const pane = values["backlog_pane"];
  // round67.2：「整栏隐藏」档删了 —— 旧库存过 hidden 也当「收起」读回 rail
  layout.backlogPane = pane === "rail" || pane === "hidden" ? "rail" : "open";
  layout.weekendHidden = values["weekend_hidden"] === "1";
  // round67.1（你 2026-10-05 实测）：「按需」档已删 —— 旧库存过 on-demand 也读回 always（不报错、不破）
  layout.hintBarMode = values["hint_bar_mode"] === "hidden" ? "hidden" : "always";
  // round81（3.1c₁ · 宽-04）：时间刻度 —— 坏值 / 缺省回 `auto`（跟密度）
  const slot = Number(values["slot_height"]);
  layout.slotHeight = (SLOT_HEIGHTS as readonly number[]).includes(slot)
    ? (slot as SlotHeight)
    : "auto";
  paintSlotHeight();
}

/** 松手时存一次；失败只记日志（界面上宽度已经生效，不值得弹 Toast 打断） */
export async function saveBacklogWidth(px: number): Promise<void> {
  try {
    await setSetting("backlog_width", String(clampBacklogWidth(px)));
  } catch (err) {
    console.error("[layout] 存栏宽失败（这次会话内仍生效）", err);
  }
}

/** 写一个布局键；成功 true，失败 false（调用方把控件拨回去 —— 与设置面板同一套口径） */
async function writeSetting(key: string, value: string): Promise<boolean> {
  try {
    await setSetting(key, value);
    return true;
  } catch {
    return false; // ipc 层已经弹过 Toast
  }
}

/** round81（3.1c₁ · 宽-04）；round82（11.6）扩到 18–64：改时间刻度（`auto` / 18–64 偶数）；写失败返回 false */
export async function saveSlotHeight(next: SlotHeight): Promise<boolean> {
  const stored = next === "auto" ? "auto" : String(next);
  if (!(await writeSetting("slot_height", stored))) return false;
  layout.slotHeight = next;
  paintSlotHeight();
  return true;
}

/** round81（3.1c₁ · 宽-05/宽-10）：**复位布局** —— 只碰尺寸与栏位（颜色 / 字号 / 图标 / 开关不动）；
 *  你 2026-10-06 拍：集合按钮 + **无确认**（可逆、不删数据），失败只记日志（写完的状态已生效） */
export async function resetLayout(): Promise<boolean> {
  const width = backlogDefault();
  const results = await Promise.all([
    writeSetting("backlog_width", String(width)),
    writeSetting("backlog_pane", "open"),
    writeSetting("weekend_hidden", "0"),
    writeSetting("hint_bar_mode", "always"),
    writeSetting("slot_height", "auto"),
  ]);
  const ok = results.every(Boolean);
  if (ok) {
    layout.backlogWidth = width;
    layout.backlogPane = "open";
    layout.weekendHidden = false;
    layout.hintBarMode = "always";
    layout.slotHeight = "auto";
    paintSlotHeight();
    return true;
  }
  // round81（6b P2）：**有键没写成** → 以库为准把界面拉回来（不让界面说“已复位”而库里还是旧值）；
  // 读也失败就用默认值兜底（至少不回退到更旧的状态）
  try {
    const s = await getSettings();
    applyLayoutValues(s.values);
  } catch {
    layout.backlogWidth = width;
    layout.slotHeight = "auto";
    paintSlotHeight();
  }
  return false;
}

/** 收起 / 展开 Backlog（只有 `open`/`rail` 两态；失败返回 false，界面不动） */
export async function saveBacklogPane(pane: BacklogPane): Promise<boolean> {
  if (!(await writeSetting("backlog_pane", pane))) return false;
  layout.backlogPane = pane;
  return true;
}

export async function saveWeekendHidden(on: boolean): Promise<boolean> {
  if (!(await writeSetting("weekend_hidden", on ? "1" : "0"))) return false;
  layout.weekendHidden = on;
  return true;
}

export async function saveHintBarMode(mode: HintBarMode): Promise<boolean> {
  if (!(await writeSetting("hint_bar_mode", mode))) return false;
  layout.hintBarMode = mode;
  return true;
}

/** 一键收起 / 展开（收起 = 细轨；round67.2 起没有第二种形态） */
export async function toggleBacklogPane(): Promise<boolean> {
  const next: BacklogPane = layout.backlogPane === "open" ? "rail" : "open";
  return saveBacklogPane(next);
}

// round81（3.1c₁）：格高的运行时来源（CSS 内联覆盖 + 手势数学读同一个值）——
// 与密度一起响应式：在 `$derived` 里调 `slotHeightPx()` 会同时依赖 `layout.slotHeight` 与密度。
setSlotHeightProvider(slotHeightEffective);
