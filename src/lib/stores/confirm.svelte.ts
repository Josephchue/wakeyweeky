/**
 * round80（79-01）：**危险确认的应用内实现** —— `confirmDanger()` 的唯一实现。
 *
 * 为什么换掉系统对话框（你 2026-10-06 的验收反馈「出戏」+ Pass B 取证）：
 * - 系统框的字体 / 按钮 / 圆角 / 配色不受我们控制；按钮顺序与初始焦点也说了不算 ——
 *   而**初始焦点必须落在「取消」上**（APG：不可逆流程 → 聚焦最不破坏的动作；GNOME HIG：
 *   不可逆动作不绑 Return）—— 这两条只有我们自己的面板才做得到；
 * - 应用内面板能进预览断言（点得到真按钮），系统框只能打桩（旧 `__DIALOG_CONFIRM`）；
 * - 文案能排版（现在要写「删什么 / 保留什么」两句以上）。
 *
 * 形态（`docs/visual/round80-PassA-子题地图.md` §1）：
 * - `role="alertdialog"` + `aria-modal` + labelledby/describedby（APG《Alert and Message Dialogs》）；
 * - **取消在左、危险动作在右**；两者都用具体动词（调用方给）；
 * - `Esc` / 点遮罩 / 「取消」= 取消；`Enter` 落在初始焦点（= 取消）上，**不会**误触发破坏动作；
 * - 面板栈里的 **modal 层**：从设置 / 成就面板里打开**不关父面板**，关掉它回到父面板（`栈-*` 口径）。
 *
 * 不做撤销（round40 定的口径：能撤销的不加确认，不能撤销的才用确认 —— 两者不叠加）。
 */
import { prepareOpen, registerPanel } from "./panels.svelte";

export type DangerOpts = { title: string; body: string; ok: string; cancel: string };

export const confirmState = $state<{
  open: boolean;
  opts: DangerOpts | null;
  resolve: ((ok: boolean) => void) | null;
}>({ open: false, opts: null, resolve: null });

/**
 * 危险操作的统一确认（三处「重置/恢复」+ 从备份恢复 + 数据位置切换都走它）。
 * 调用方给四个文案 —— 它们各自必须**说清「毁掉什么、保留什么」**（`重置与恢复调研.md` §2）。
 */
export function confirmDanger(opts: DangerOpts): Promise<boolean> {
  // 理论上不该「确认框上再开确认框」；真撞上就把前一个按「取消」结掉（不留悬挂的 Promise）
  if (confirmState.open && confirmState.resolve) confirmState.resolve(false);
  prepareOpen("confirm");
  confirmState.opts = opts;
  confirmState.open = true;
  return new Promise<boolean>((resolve) => {
    confirmState.resolve = resolve;
  });
}

/** 面板里的三条出路（取消 / 确认 / Esc / 遮罩）都从这里结账 */
export function settleConfirm(ok: boolean): void {
  const resolve = confirmState.resolve;
  confirmState.open = false;
  confirmState.opts = null;
  confirmState.resolve = null;
  resolve?.(ok);
}

// 注册给面板栈（modal：不关父面板；`Esc` 只关它 —— `Timeline` 的全局处理走 `closeTopPanel()`）
registerPanel({
  id: "confirm",
  kind: "modal",
  isOpen: () => confirmState.open,
  close: () => (settleConfirm(false), true),
});
