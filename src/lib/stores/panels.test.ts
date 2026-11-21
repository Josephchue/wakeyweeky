/**
 * round96：**面板栈**的回归防线（纯逻辑，不碰 DOM）。
 *
 * 验的东西（对应 `docs/plans/round96-面板栈实现.md` §6）：
 * ① 层级由打开源推导（auto / top / root）② 同 id 不重开 ③ 上限 5 拒绝 + 计数
 * ④ 关父层连坐 ⑤ 忙时（`canClose`）整段不弹 ⑥ 栈顶现算 ⑦ `depth === openPanelIds().length`
 * ⑧ 根层开口被忙层否决时**一个都不弹** ⑨ `layerIdOf` 从 DOM 找打开源。
 *
 * 假注册表代替 9 个真实 store：这里只验栈的搬运与顺序，不验各面板的数据/界面。
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  closeLayer,
  closeTopPanel,
  layerIdOf,
  layerIndex,
  MAX_LAYERS,
  openLayer,
  openPanelIds,
  panelStats,
  registerPanel,
  resetPanels,
  stackDepth,
  stackRejections,
  topPanel,
} from "./panels.svelte";

type Tid = "review" | "stats" | "help" | "templates" | "settings" | "achievements";

const IDS: Tid[] = ["review", "stats", "help", "templates", "settings", "achievements"];

let opened: Record<string, unknown[]>;
let closeCalls: Record<string, number>;
let refuses: Record<string, boolean>;

function setup(): void {
  opened = {};
  closeCalls = {};
  refuses = {};
  for (const id of IDS) {
    opened[id] = [];
    closeCalls[id] = 0;
    refuses[id] = false;
    registerPanel({
      id,
      open: (params) => opened[id].push(params),
      close: () => {
        if (refuses[id]) return false;
        closeCalls[id] += 1;
        return true;
      },
      canClose: () => !refuses[id],
    });
  }
}

/** 只实现 `closest` 的桩：模拟「从某一层的 DOM 里点开」 */
const fromInside = (id: string) =>
  ({ closest: () => ({ getAttribute: () => id }) }) as unknown as Element;

beforeEach(() => {
  resetPanels();
  setup();
});

describe("面板栈（round96）", () => {
  it("① auto：打开源在某层里 → 叠在那一层上面", () => {
    openLayer("review", { nest: "root" });
    expect(openLayer("stats", { from: fromInside("review") })).toBe(true);
    expect(openPanelIds()).toEqual(["review", "stats"]);
    expect(topPanel()).toBe("stats");
  });

  it('② auto：打开源不在任何层里 → 根层（清栈再开）', () => {
    openLayer("review", { nest: "root" });
    openLayer("stats", { nest: "top" });
    expect(openLayer("help", { from: null })).toBe(true);
    expect(openPanelIds()).toEqual(["help"]);
    expect(closeCalls.review).toBe(1);
    expect(closeCalls.stats).toBe(1);
  });

  it('③ top：显式叠栈顶（键盘/程序化）', () => {
    openLayer("review", { nest: "root" });
    openLayer("stats", { nest: "top" });
    openLayer("help", { nest: "top" });
    expect(openPanelIds()).toEqual(["review", "stats", "help"]);
    expect(layerIndex("help")).toBe(2);
  });

  it("④ 同 id 不重开：只重应用参数，层数不变", () => {
    openLayer("review", { nest: "root" });
    expect(openLayer("review", { from: fromInside("review"), params: { day: 3 } })).toBe(true);
    expect(stackDepth()).toBe(1);
    expect(opened.review).toEqual([undefined, { day: 3 }]);
    expect(closeCalls.review).toBe(0);
  });

  it("④b 同 id 已开但在栈底：不重开、不重排（单实例）", () => {
    openLayer("review", { nest: "root" });
    openLayer("stats", { nest: "top" });
    expect(openLayer("review", { nest: "top" })).toBe(true);
    expect(openPanelIds()).toEqual(["review", "stats"]);
    expect(opened.review).toEqual([undefined, undefined]);
  });

  it("⑤ 上限 5：第 6 层被拒 + 计数 +1，栈顶不变", () => {
    openLayer("review", { nest: "root" });
    for (const id of IDS.slice(1, MAX_LAYERS)) openLayer(id, { nest: "top" });
    expect(stackDepth()).toBe(5);
    const before = stackRejections();
    expect(openLayer("achievements", { nest: "top" })).toBe(false);
    expect(stackDepth()).toBe(5);
    expect(stackRejections()).toBe(before + 1);
    expect(panelStats.rejections).toBe(1);
    expect(topPanel()).toBe("settings");
  });

  it("⑤b 第 6 层从某层里点开（child）也被拒", () => {
    openLayer("review", { nest: "root" });
    for (const id of IDS.slice(1, MAX_LAYERS)) openLayer(id, { nest: "top" });
    expect(openLayer("achievements", { from: fromInside("settings") })).toBe(false);
    expect(stackDepth()).toBe(5);
  });

  it("⑥ 关父层连坐：从该层起上面全弹掉（自顶向下）", () => {
    openLayer("review", { nest: "root" });
    openLayer("stats", { nest: "top" });
    openLayer("help", { nest: "top" });
    expect(closeLayer("review")).toBe(true);
    expect(openPanelIds()).toEqual([]);
    expect(closeCalls).toMatchObject({ help: 1, stats: 1, review: 1 });
  });

  it("⑦ closeTopPanel：只弹一层", () => {
    openLayer("review", { nest: "root" });
    openLayer("stats", { nest: "top" });
    expect(closeTopPanel()).toBe(true);
    expect(openPanelIds()).toEqual(["review"]);
    expect(topPanel()).toBe("review");
  });

  it("⑧ 忙时否决：close 返 false → 整段不弹", () => {
    openLayer("review", { nest: "root" });
    openLayer("stats", { nest: "top" });
    refuses.stats = true;
    expect(closeLayer("stats")).toBe(false);
    expect(stackDepth()).toBe(2);
    // 关父层也不行：上面那一层忙 → 全有或全无
    expect(closeLayer("review")).toBe(false);
    expect(stackDepth()).toBe(2);
  });

  it("⑨ 栈顶现算：关掉栈顶后 topPanel / layerIndex 跟着变", () => {
    openLayer("review", { nest: "root" });
    openLayer("stats", { nest: "top" });
    expect(topPanel()).toBe("stats");
    closeLayer("stats");
    expect(topPanel()).toBe("review");
    expect(layerIndex("review")).toBe(0);
    expect(layerIndex("stats")).toBe(-1);
  });

  it("⑩ 不变式：stackDepth === openPanelIds().length（每一步之后）", () => {
    const steps = [
      () => openLayer("review", { nest: "root" }),
      () => openLayer("stats", { nest: "top" }),
      () => openLayer("review", { params: { day: 1 } }),
      () => closeTopPanel(),
      () => closeLayer("review"),
    ];
    for (const step of steps) {
      step();
      expect(stackDepth()).toBe(openPanelIds().length);
    }
  });

  it("⑪ 根层开口被忙层否决：一个都不弹、新的也不开", () => {
    openLayer("review", { nest: "root" });
    openLayer("stats", { nest: "top" });
    openLayer("help", { nest: "top" });
    refuses.review = true;
    expect(openLayer("templates", { nest: "root" })).toBe(false);
    expect(openPanelIds()).toEqual(["review", "stats", "help"]);
    expect(opened.templates).toEqual([]);
  });

  it("⑫ 关不存在的层：返回 false、栈不动", () => {
    openLayer("review", { nest: "root" });
    expect(closeLayer("help")).toBe(false);
    expect(openPanelIds()).toEqual(["review"]);
  });

  it("⑬ layerIdOf：从 DOM 找打开源（唯一读 DOM 的地方）", () => {
    expect(layerIdOf(fromInside("help"))).toBe("help");
    expect(layerIdOf(null)).toBeNull();
    expect(layerIdOf({} as Element)).toBeNull();
  });
});
