/**
 * round96：**一张按打开顺序排的栈** —— 全应用只有这一份「谁开着 / 谁在谁上面」的真相。
 *
 * 以前（round78）「层」是面板的身份证：`sibling` / `child` / `modal` 三种 kind 写在注册表里，
 * 再加各组件写死的 z（40/41/48/49）。由此长出 EB-1 三条：子层遮罩比父层面板低（父层露出的那条还能点）、
 * 遮罩只「关自己」不退层、说明页/模板干脆没遮罩。round95 的结论与取证见 `docs/素材库/面板栈调研.md`。
 *
 * 现在的语义（你 2026-11-21 拍的「一张按打开顺序排的栈」）：
 * - `stack` 索引 0 最底、末尾是栈顶；**入栈顺序就是层级**，不再给面板带身份；
 * - **层级由打开源推导**：鼠标从哪一层的 DOM 里点开，就叠在那一层上面；从应用里点开 = 根层（清栈）；
 *   键盘 / 程序化开口显式用 `nest:"top"`（叠栈顶）或 `nest:"root"`；
 * - **单实例**：同 id 已在栈里 → 不新开，只重应用参数 + 把焦点送回；
 * - **上限 5 层（含确认层）**：超了拒绝 + 开发期日志 + 计数，不给用户提示；
 * - **关闭连坐**：`closeLayer(id)` 从该层起把上面全弹掉；`close()` 返 false（忙）就**整段不弹**；
 * - `closeTopPanel()` 只弹一层（`Esc` 的唯一入口）。
 *
 * 为什么用**注册表**而不是直接 import 各 store：那些 store 反过来也要 import 本模块（在自己的
 * `openX()` 里调 `openLayer`）→ 直接 import 会成环。注册表让依赖只有单向：store → panels。
 * 注册在各自的模块初始化时完成（`registerPanel(...)`）。
 *
 * **这些 store 的 `open` 旗子仍保留**（组件靠它画），但**只由本模块写**（走注册的 `open` / `close`）；
 * 组件里不许直接改旗子，否则栈与画面会脱节。
 */

export type PanelId =
  | "review"
  | "stats"
  | "help"
  | "templates"
  | "settings"
  | "achievements"
  | "data"
  | "keymap"
  | "confirm";

/** 一层 = 打开顺序里的一个位置。`openedBy` 是还焦点用的触发元素（键盘/程序化可能为 null） */
export type Layer = { id: PanelId; openedBy: Element | null; params: unknown };

/** `auto`（默认，鼠标）= 由打开源推导；`top` = 叠栈顶（键盘/程序化）；`root` = 清栈后当根层 */
export type Nest = "auto" | "top" | "root";
export type OpenOpts = { nest?: Nest; from?: Element | null; params?: unknown };

/** 含确认层（R7：实测最长链 3，5 是天花板） */
export const MAX_LAYERS = 5;

type PanelReg = {
  id: PanelId;
  /** 幂等：翻旗子（true）+ 应用参数。重复打开时只跑这一步，不新增层 */
  open: (params: unknown) => void;
  /** 关掉自己那面旗；返 false = 忙，拒绝关闭（如数据位置切换中） */
  close: () => boolean;
  /** 预检（可选）：`false` 时连坐关闭 / 根层清栈**整段不弹**（全有或全无） */
  canClose?: () => boolean;
};

const regs = new Map<PanelId, PanelReg>();

/** 唯一真相（索引 0 最底）。组件层只读它来画层序 / 算 z / 加 inert */
export const stack = $state<Layer[]>([]);

/** 诊断计数：撞上限被拒绝的次数（宿主写进 data-stack-rejections，断言读增量） */
export const panelStats = $state<{ rejections: number }>({ rejections: 0 });

/**
 * 最近一次栈变化的信号（给 `PanelHost` 做「还焦点」与「焦点送回」）。
 * `seq` 单调递增；`anchor` = 最后弹出那层的 `openedBy`。
 */
export const panelChange = $state<{
  seq: number;
  kind: "none" | "open" | "close" | "focus";
  anchor: Element | null;
  closed: PanelId | null;
}>({ seq: 0, kind: "none", anchor: null, closed: null });

export function registerPanel(reg: PanelReg): void {
  regs.set(reg.id, reg);
}

function regOf(id: PanelId): PanelReg | null {
  return regs.get(id) ?? null;
}

function bump(kind: "open" | "close" | "focus", anchor: Element | null, closed: PanelId | null): void {
  panelChange.kind = kind;
  panelChange.anchor = anchor;
  panelChange.closed = closed;
  panelChange.seq += 1;
}

/**
 * 从触发元素找出它所在的层（`data-layer-id` 由 `PanelHost` 打在每层包装上）。
 * **唯一读 DOM 的地方**（单测用 `{closest:()=>({getAttribute})}` 桩）。
 */
export function layerIdOf(from: Element | null | undefined): PanelId | null {
  const host = from?.closest?.("[data-layer-id]") ?? null;
  const id = host?.getAttribute("data-layer-id") ?? null;
  return id ? (id as PanelId) : null;
}

function allCanClose(): boolean {
  for (const layer of stack) {
    if (regOf(layer.id)?.canClose?.() === false) return false;
  }
  return true;
}

/** 清空栈（根层开口前）。任一层面忙 → 整体不弹，返回 false */
function popAll(): boolean {
  if (!allCanClose()) return false;
  while (stack.length > 0) {
    const layer = stack.at(-1);
    if (!layer) break;
    const reg = regOf(layer.id);
    if (!reg || !reg.close()) return false;
    stack.pop();
  }
  return true;
}

/**
 * 打开 / 叠上一层。返回 false = 被拒绝（撞上限 / 忙）—— **调用方必须看返回值**，
 * 不要把数据拉取、`note` 之类副作用先跑掉。
 */
export function openLayer(id: PanelId, opts: OpenOpts = {}): boolean {
  const reg = regOf(id);
  if (!reg) return false;

  const nest: Nest = opts.nest ?? "auto";
  let from: Element | null;
  if (opts.from !== undefined) from = opts.from;
  else from = typeof document === "undefined" ? null : document.activeElement;

  // 1) 先定父层（打开源）——
  let parent: PanelId | null;
  if (nest === "root") parent = null;
  else if (nest === "top") parent = stack.at(-1)?.id ?? null;
  else parent = layerIdOf(from);

  // 2) 根层开口 = 清栈再开。忙的一层能否决（全有或全无）
  if (parent === null) {
    if (!popAll()) return false;
  } else if (!stack.some((layer) => layer.id === parent)) {
    // 打开源指向一个已不在栈里的层（元素被移除 / 栈刚被清）→ 当作栈顶，不凭空造父层
    parent = stack.at(-1)?.id ?? null;
    if (parent === null && !popAll()) return false;
  }

  // 3) 单实例：已在栈里 → 只重应用参数 + 把焦点送回（不入栈、不重复层）
  if (stack.some((layer) => layer.id === id)) {
    reg.open(opts.params);
    bump("focus", null, id);
    return true;
  }

  // 4) 上限护栏（含确认层）
  if (stack.length >= MAX_LAYERS) {
    panelStats.rejections += 1;
    if (import.meta.env.DEV) {
      console.warn(`[panels] 栈深已达上限 ${MAX_LAYERS}，拒绝打开「${id}」`);
    }
    return false;
  }

  // 5) 入栈。旗子先翻开（同一个更新周期里 PanelHost 会把它画出来）
  reg.open(opts.params);
  stack.push({ id, openedBy: from, params: opts.params });
  bump("open", null, id);
  return true;
}

/**
 * 从 `id` 这一层起把上面全弹掉（关父层连坐）。返回 true = **目标层**关掉了。
 * 范围里任一层 `canClose` 为 false（忙）→ 整段不动。
 */
export function closeLayer(id: PanelId): boolean {
  const idx = stack.findIndex((layer) => layer.id === id);
  if (idx < 0) return false;

  for (let i = idx; i < stack.length; i++) {
    if (regOf(stack[i].id)?.canClose?.() === false) return false;
  }

  let lastPopped: Layer | null = null;
  for (let i = stack.length - 1; i >= idx; i--) {
    const layer = stack[i];
    const reg = regOf(layer.id);
    if (!reg || !reg.close()) break; // canClose 已预检；这是兜底
    stack.pop();
    lastPopped = layer;
  }
  if (!lastPopped) return false;

  bump("close", lastPopped.openedBy, lastPopped.id);
  return !stack.some((layer) => layer.id === id);
}

/** `Esc` / 点遮罩的唯一入口：只弹一层。返回 false = 没有层或顶层忙 */
export function closeTopPanel(): boolean {
  const top = stack.at(-1);
  if (!top) return false;
  return closeLayer(top.id);
}

export function topPanel(): PanelId | null {
  return stack.at(-1)?.id ?? null;
}

export function stackDepth(): number {
  return stack.length;
}

export function isTopPanel(id: PanelId): boolean {
  return stack.at(-1)?.id === id;
}

/** 层在栈里的索引（0 最底；-1 = 不在栈里）—— z 由它算 */
export function layerIndex(id: PanelId): number {
  return stack.findIndex((layer) => layer.id === id);
}

export function openPanelIds(): PanelId[] {
  return stack.map((layer) => layer.id);
}

/** 有没有任何面板开着（Timeline 的全局键守卫 / App 的 `inert` 用） */
export function anyPanelOpen(): boolean {
  return stack.length > 0;
}

export function stackRejections(): number {
  return panelStats.rejections;
}

/** 单测 / 诊断用：清掉栈、注册表与计数（不跑各层的 close 回调） */
export function resetPanels(): void {
  stack.length = 0;
  regs.clear();
  panelStats.rejections = 0;
  panelChange.kind = "none";
  panelChange.anchor = null;
  panelChange.closed = null;
  panelChange.seq = 0;
}
