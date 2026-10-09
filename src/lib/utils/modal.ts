/**
 * round78（3.1b₂ · `栈-03`/`栈-05`）：**模态契约**的两个共享件。
 *
 * 依据 W3C APG《Dialog (Modal) Pattern》的硬要求（`docs/visual/round78-PassA-子题地图.md` §栈-03）：
 * - 打开时焦点进面板；`Tab`/`Shift+Tab` **在面板内循环**（不许跑到面板后面的页面）；
 * - 关闭时焦点**还给触发它的那个元素**（找不到就退回一个合理落点）；
 * - 滚动容器要能被键盘够到（W3C ACT 规则 `0ssw9k`：滚动内容必须能顺序聚焦到达）。
 *
 * 为什么用 action 而不是每个面板各写一遍：6 个面板要**同一套**行为 —— 一处实现、六处使用，
 * 以后改规则只改这里（round72 的 L1/L2 就是「每处各写一遍」写出来的）。
 */

/**
 * round80（79-01）：**危险操作的统一确认** —— 实现在 `stores/confirm.svelte.ts`（应用内 `alertdialog`）。
 * 这里保留同名再导出：三个调用点（重置统计 / 重置成就 / 恢复默认设置）与文档锚点都不用动。
 *
 * 口径（`docs/visual/round80-PassA-子题地图.md` §1）：
 * - 初始焦点在「取消」；`Enter` = 取消；`Esc` / 点遮罩 = 取消；取消在左、危险动作在右；
 * - 能撤销的不加确认，不能撤销的才用确认（round40 定的）—— 用了确认就不再叠撤销；
 * - 视觉：`src/lib/styles/actions.css` 的 `.danger-action`。
 */
export { confirmDanger, type DangerOpts } from "../stores/confirm.svelte";

type FocusTrapOptions = {
  /** 面板开着吗（关掉时把焦点还回去）。面板组件里传 `open`（或 `$derived` 的布尔） */
  active: boolean;
};

/** 可聚焦元素的选择器（与浏览器 Tab 顺序同一套；`:not([tabindex="-1"])` 排掉「只用来接焦点」的容器） */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary, [contenteditable="true"]';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (n) => n.offsetParent !== null || n === document.activeElement, // 看得见的才进循环
  );
}

/**
 * 用法：`<section use:focusTrap={{ active: open }} ...>`
 * 打开：记住当前焦点 → 焦点进面板（第一个可聚焦项；没有就聚焦面板本身，并临时加 `tabindex="-1"`）。
 * 关闭：把焦点还给它。
 */
export function focusTrap(node: HTMLElement, opts: FocusTrapOptions) {
  let active = opts.active;
  let restoreTo: HTMLElement | null = null;
  let tempTabIndex = false;

  const focusIn = () => {
    const first = focusables(node)[0] ?? node;
    if (first === node && !node.hasAttribute("tabindex")) {
      node.setAttribute("tabindex", "-1");
      tempTabIndex = true;
    }
    first.focus({ preventScroll: false });
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const items = focusables(node);
    if (items.length === 0) return; // 没东西可循环 → 交给浏览器（面板本身可聚焦）
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement as HTMLElement | null;
    if (!event.shiftKey && (current === last || !node.contains(current))) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && (current === first || !node.contains(current))) {
      event.preventDefault();
      last.focus();
    }
  };

  const activate = () => {
    restoreTo = (document.activeElement as HTMLElement | null) ?? null;
    // 等一帧：面板的 `{#if}` 刚渲染出来，尺寸/可聚焦项还要一帧才稳定
    queueMicrotask(focusIn);
    // 捕获阶段拦 Tab：面板内循环优先于页面的其它 Tab 处理
    node.addEventListener("keydown", onKeydown, true);
  };

  const deactivate = () => {
    node.removeEventListener("keydown", onKeydown, true);
    if (tempTabIndex) {
      node.removeAttribute("tabindex");
      tempTabIndex = false;
    }
    // 焦点还给打开它的那个按钮（它没了就留在原地 —— 别把焦点丢到 body 上）
    if (restoreTo && restoreTo.isConnected) restoreTo.focus({ preventScroll: true });
    restoreTo = null;
  };

  if (active) activate();
  return {
    update(next: FocusTrapOptions) {
      if (next.active === active) return;
      active = next.active;
      if (active) activate();
      else deactivate();
    },
    destroy() {
      if (active) deactivate();
    },
  };
}

/**
 * `栈-05`：滚动容器「没东西可聚焦时」自己进 Tab 顺序（ACT 规则 `0ssw9k`）。
 * 用法：`<div class="panel-body" use:scrollableRegion={{ label: t("…") }}>` ——
 * 内部若有可聚焦元素，本 action 不做任何事（不让 Tab 多一个空停顿）。
 */
export function scrollableRegion(node: HTMLElement, opts: { label: string }) {
  const sync = () => {
    const hasFocusable = focusables(node).length > 0;
    const overflows = node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1;
    if (!hasFocusable && overflows) {
      node.setAttribute("tabindex", "0");
      node.setAttribute("role", "region");
      node.setAttribute("aria-label", opts.label);
    } else {
      node.removeAttribute("tabindex");
    }
  };
  sync();
  const ro = new ResizeObserver(sync);
  ro.observe(node);
  return {
    update(next: { label: string }) {
      opts = next;
      sync();
    },
    destroy() {
      ro.disconnect();
    },
  };
}
