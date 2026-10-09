/** UI 层共享状态：Toast 队列 + 「哪一块正在就地改名」+ **键盘选中的是哪一块**。 */

import { t } from "../i18n/i18n.svelte";
import { prepareOpen, registerPanel } from "./panels.svelte";

export type Toast = {
  id: string;
  msg: string;
  /** round40：带一个按钮的提示（现在只有「撤销」）—— 删除/解链这类**能撤销**的动作不再用模态确认 */
  action?: { label: string; run: () => void };
  /** round68（19.1）：成就类提示 —— 同时只留一条（不跟撤销提示抢队列） */
  kind?: "achievement";
};

export const toasts = $state<Toast[]>([]);

/**
 * round33：键盘选中的块 + 抓起态。
 * 为什么放在 ui 层：写路径（`blocks.svelte.ts`）也要读它 —— 「写操作把选中的那块融合掉了 → 选中转幸存者」
 * 得在写函数里做（鼠标拖动/拉伸、键盘移动/拉伸都经过那几个函数）；放这里才不会形成
 * `blocks ↔ selection` 的循环依赖（真正干活的逻辑仍在 `stores/selection.svelte.ts`）。
 *
 * round61（10.2 多选）：从「一块」扩成「一批」——`ids` = 当前选中的所有块（**含 `blockId`**）。
 * 不变式：`ids` 空 ⟺ `blockId` 空，且 `blockId` 永远是 `ids` 的一员。
 * 单块键盘动作（拉伸/抓起/改名）仍读 `blockId`（锚点）；批量动作（标记/删除/挪/改层）读 `ids`。
 */
export const selection = $state<{
  blockId: string | null;
  ids: string[];
  grabbed: boolean;
  /**
   * round69（B3）：跟鼠标手势（`Ctrl+X` / `Ctrl+C`）的**模式**（null = 没在跟）。
   * 有它时 `selection.grabbed`也为 true —— 预览、方向键、收尾都走现成的「拿起」链路；
   * 它只决定两件事：落地时是**搬**还是**复制**，以及提示条怎么写。
   */
  followMode: "move" | "copy" | null;
}>({
  blockId: null,
  ids: [],
  grabbed: false,
  followMode: null,
});

/**
 * C1.8（R33）：正在就地改名的块 id（null = 没有）。
 * 双击空白格新建临时块后，由时间轴把新块 id 放进来 → TaskBlock 那边的名字变成输入框并自动聚焦。
 */
export const editing = $state<{ blockId: string | null }>({ blockId: null });

/**
 * round38：**任务面板（Backlog）里展开的东西** —— `⚙` 属性面板与「已归档」列表。
 * 为什么放这儿（而不是 Backlog 的局部 state）：`Esc` 是全局键（`Timeline` 那个 window 监听），
 * 它要能收起这些面板 —— 与 round33 把 `selection` 抬上来的同一个理由。
 */
export const taskPanel = $state<{ propsId: string | null; archivedOpen: boolean }>({
  propsId: null,
  archivedOpen: false,
});

/**
 * round66（C12）：数据位置切换面板（便携模式）。
 * 放 ui 层的原因与 `taskPanel` 相同：从设置弹层里点按钮打开，但面板本身挂在 App 根部
 * （覆盖层不能被设置弹层裁掉）—— `DataSwitch.svelte` 读这里的 `open`。
 */
export const dataSwitch = $state<{ open: boolean; busy: boolean }>({ open: false, busy: false });

export function openDataSwitch() {
  prepareOpen("data"); // round78（栈-01）：子层（从设置里打开）
  dataSwitch.open = true;
}

/** 关掉（`Esc` / 关闭钮都走它）。返回 false = 切换中，**拒绝关闭**（round78：忙时不丢操作） */
export function closeDataSwitch(): boolean {
  if (dataSwitch.busy) return false;
  dataSwitch.open = false;
  return true;
}

/**
 * round82（3.1c₂ · `绑-10` / 案 A）：**键位面板**（设置里的子层）。
 * round83（§8.2）：与 `?` 的**快捷键总表**合并成同一个面板 ——
 * 「可改键位」在下面，「全部键位（只读）」在最上（`?` 直达总表的路径不退化）。
 * 与成就 / 说明同一形态：叠在设置上，`Esc` / `✕` 只关它这一层。
 */
export const keymapPanel = $state<{ open: boolean }>({ open: false });

export function openKeymapPanel() {
  prepareOpen("keymap");
  keymapPanel.open = true;
}

export function closeKeymapPanel() {
  keymapPanel.open = false;
}

/**
 * round78（3.1b₂ · `栈-01`）：设置弹层 / 模板弹层的开关状态**上提到这里**。
 * 为什么：以前它们是组件里的 `let open = $state(false)`，面板栈看不见它们 —— 
 * 点顶栏「总览」时设置会明明开着却不关（同级不替换）。上提后栈能看见、只存一处。
 */
export const settingsPanel = $state<{ open: boolean }>({ open: false });

export function openSettingsPanel() {
  prepareOpen("settings");
  settingsPanel.open = true;
}

export function closeSettingsPanel() {
  settingsPanel.open = false;
}

// round78（栈-01）：数据位置 = 子层；设置 = 同级（模板在 `templates.svelte.ts` 里自己注册）
registerPanel({ id: "data", kind: "child", isOpen: () => dataSwitch.open, close: () => closeDataSwitch() });
registerPanel({ id: "settings", kind: "sibling", isOpen: () => settingsPanel.open, close: () => (closeSettingsPanel(), true) });
// round78（3.1b₂ · 键-03）：键位面板 = 子层（叠在设置上；关掉回设置）；round83（§8.2）与 `?` 总表合并
registerPanel({ id: "keymap", kind: "child", isOpen: () => keymapPanel.open, close: () => (closeKeymapPanel(), true) });

/** 收起任务面板里的东西（`Esc` 调；本来就没展开 = 空操作） */
export function closeTaskPanel() {
  taskPanel.propsId = null;
  taskPanel.archivedOpen = false;
}

/**
 * round69（B3）：局内键 `C`（「快速加任务」）的**信号**。
 * 为什么用信号而不是直接 focus：DOM 在 Backlog 手里（细轨要先展开、要等一帧才渲染出输入框）——
 * Timeline 只管发出请求，Backlog 的 `$effect` 负责展开 + 聚焦。
 */
export const newTaskRequest = $state<{ seq: number }>({ seq: 0 });

export function requestNewTask() {
  newTaskRequest.seq += 1;
}

export function startEditing(blockId: string) {
  editing.blockId = blockId;
}

export function stopEditing() {
  editing.blockId = null;
}

export function toast(msg: string) {
  pushToast(msg, undefined, 3000);
}

/**
 * round68（19.1）：暗章点亮的短提示 —— 计划定的口径是「5 秒、同时最多一条」。
 * 与 `toast()` 分开：普通提示 3 秒、可叠 5 条；成就提示不该被一堆「已撤销」挤掉，
 * 也不该一次多点亮时刷屏（新的一条顶掉旧的一条）。
 */
export function toastAchievement(msg: string) {
  for (let i = toasts.length - 1; i >= 0; i--) {
    if (toasts[i].kind === "achievement") toasts.splice(i, 1);
  }
  pushToast(msg, undefined, 5000, "achievement");
}

/**
 * round40：带「撤销」按钮的提示（**删除 / 解链 / 取消归档这类动作的确认方式**）。
 *
 * 为什么不用模态确认（用户 2026-10-02 拍板 A 案 + 调研结论）：这些动作**全都能撤销**
 * （后端快照式撤销栈，`Ctrl+Z` 就是它）；给能撤销的动作再加一层确认，只会**训练用户闭眼点掉**，
 * 反而把真正危险的那次也一起点掉了。所以：**直接做 + 一条能点撤销的提示**（8 秒）。
 *
 * 为什么用 `import()`：`history.svelte` 反向 import 了 `blocks.svelte` —— 静态互相引用会成环
 * （本仓踩过 `blocks ↔ selection` 那个坑），动态取一次就绕开了。
 */
export function toastUndo(msg: string) {
  pushToast(
    msg,
    {
      label: t("msg.ui.01"),
      run: () => {
        void import("./history.svelte").then((m) => m.undo());
      },
    },
    8000,
  );
}

/** 点过按钮的提示立刻消失（不等 8 秒） */
export function dismissToast(id: string) {
  const idx = toasts.findIndex((t) => t.id === id);
  if (idx >= 0) toasts.splice(idx, 1);
}

function pushToast(msg: string, action: Toast["action"], ms: number, kind?: Toast["kind"]) {
  const id = crypto.randomUUID();
  // round44（BI）：带按钮的提示（现在只有「撤销」）**同时只留一条**。
  // 为什么：8 秒内连删两样时两条并存，而撤销栈是 LIFO —— 点**旧**的那条其实撤的是**最新**那次操作，
  // 与那条提示写的话对不上 ✗（检查轮登记）。新的一条顶掉旧的一条，语义才对得上。
  if (action) {
    for (let i = toasts.length - 1; i >= 0; i--) {
      if (toasts[i].action) toasts.splice(i, 1);
    }
  }
  toasts.push({ id, msg, action, kind });
  // 队列上限：批量失败时不要把整个屏幕堆满（只保留最近 5 条）
  while (toasts.length > 5) toasts.shift();
  setTimeout(() => dismissToast(id), ms);
}
