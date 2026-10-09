/**
 * round78（3.1b₂ · `栈-01`/`栈-02`）：**面板栈** —— 全应用只有这一份「谁开着 / 谁是栈顶」的真相。
 *
 * 为什么要有它（round72 的 L1/L2 病根）：以前每个面板各判自己的 `open`、各自监听 `Escape` →
 * 一次 Esc 全关（找不到「退一层」），开着新面板时旧的也不关（叠成一坨、焦点不知道在哪）。
 *
 * 语义（你 2026-10-06 拍板，见 `docs/visual/round78-PassA-子题地图.md` §栈-01）：
 * - **同级**（顶栏那几个入口：总览 / 统计 / 设置 / 模板）互相**替换** —— 开新的就关旧的；
 * - **子层**（只能从面板内部打开的：说明页 / 成就 / 数据位置）叠在同级之上，**关掉子层回到同级**
 *   （所以「设置 → 成就」关掉成就后**设置还在**）；
 * - 同级最多开一个、子层最多开一个、**modal（确认层）最多开一个** → 栈深最多 **3**（round80 · 79-01 加的 modal 层），判定表三态穷举，断言能写满；
 * - `Esc` / 关闭按钮永远只关**栈顶**（`closeTopPanel()`）。
 *
 * 为什么用**注册表**而不是直接 import 各 store：那些 store 反过来也要 import 本模块
 * （在自己的 `open*()` 里调 `prepareOpen`）→ 直接 import 会成环。注册表让依赖只有单向：
 * store → panels。注册在各自的模块初始化时完成（`registerPanel(...)`）。
 */

export type PanelId = "review" | "stats" | "help" | "templates" | "settings" | "achievements" | "data" | "keymap" | "confirm";

/**
 * 同级 = 顶栏入口（互相替换）；子层 = 从面板内部打开（叠在同级之上）；
 * **modal = 盖在最上的确认层**（round80 · 79-01）：可以从任何面板内部打开而**不关父面板**，
 * `Esc` / 遮罩 / "取消" 都只关它（关掉后回到父面板）。
 */
type PanelKind = "sibling" | "child" | "modal";

type PanelReg = {
  id: PanelId;
  /**
   * 同级 / 子层 / modal。
   *
   * round82（11.5）：**可以给函数** —— 统计面板从总览顶栏进来时是**子层**（不关总览、`Esc` 只关它），
   * 从顶栏独立入口进来时是**同级**。其余面板继续用字面量（不改变它们的语义）。
   */
  kind: PanelKind | (() => PanelKind);
  /** 现在开着吗（读各自 store 的 flag） */
  isOpen: () => boolean;
  /** 关掉它（各自 store 的 close*；返回值 = 真的关了吗 —— 忙时可能拒绝，如数据位置切换中） */
  close: () => boolean;
};

/** 取实际层级（字面量或函数） */
const kindOf = (r: PanelReg): PanelKind => (typeof r.kind === "function" ? r.kind() : r.kind);

const regs: PanelReg[] = [];

export function registerPanel(reg: PanelReg): void {
  // 重复注册（热更新 / 测试里重复 import）时覆盖，不重复堆
  const i = regs.findIndex((r) => r.id === reg.id);
  if (i >= 0) regs[i] = reg;
  else regs.push(reg);
}

function reg(id: PanelId): PanelReg | null {
  return regs.find((r) => r.id === id) ?? null;
}

export function panelOpen(id: PanelId): boolean {
  return reg(id)?.isOpen() ?? false;
}

/** 有没有任何面板开着（Timeline 的全局键守卫用） */
export function anyPanelOpen(): boolean {
  return regs.some((r) => r.isOpen());
}

/** 开着几个（诊断 / 断言用；正常最多 **3**：一个同级 + 一个子层 + 一个 modal 确认层） */
export function stackDepth(): number {
  return regs.filter((r) => r.isOpen()).length;
}

/** 栈顶：modal（确认层）优先 → 子层 → 同级 */
export function topPanel(): PanelId | null {
  const open = regs.filter((r) => r.isOpen());
  return (open.find((r) => kindOf(r) === "modal") ?? open.find((r) => kindOf(r) === "child") ?? open[0])?.id ?? null;
}

/**
 * 「我准备要开了」—— 打开之前先把该关的关掉。
 * modal：只关别的 modal（叠在上层，不动父面板）；
 * 子层：关另一个子层 + modal（modal 挡着它下面的互动，开新面板时不该留着）；
 * 同级：关掉所有其它同级 + 子层 + modal（父没了，上面的都没意义）。
 */
export function prepareOpen(id: PanelId): void {
  const me = reg(id);
  if (!me) return;
  const myKind = kindOf(me);
  if (myKind === "modal") {
    for (const r of regs) if (r.id !== id && kindOf(r) === "modal" && r.isOpen()) r.close();
    return;
  }
  for (const r of regs) {
    if (r.id === id || !r.isOpen()) continue;
    if (myKind === "child") {
      if (kindOf(r) === "child" || kindOf(r) === "modal") r.close();
    } else {
      r.close();
    }
  }
}

export function closePanel(id: PanelId): boolean {
  return reg(id)?.close() ?? false;
}

/**
 * `Esc` / 「关掉栈顶」的唯一入口。返回 true = 真的关掉了一层（调用方据此决定还要不要继续往下处理）。
 * 拒绝关闭（如数据位置切换中）= false —— 不挡后面的 Esc 语义（放弃拿起 / 清选中那些）。
 */
export function closeTopPanel(): boolean {
  const top = topPanel();
  if (!top) return false;
  return closePanel(top);
}

/** 诊断用：当前开着的面板 id（断言 / 报错信息用，别拿它做业务判断） */
export function openPanelIds(): PanelId[] {
  return regs.filter((r) => r.isOpen()).map((r) => r.id);
}
