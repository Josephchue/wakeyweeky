/**
 * round67：外观 / 布局偏好 store 的回归防线。
 *
 * 与 `settings.test.ts` 同一套假 IPC 手法：这里只验**映射与失败路径** ——
 * 读回时坏值必须回默认（界面不能留着上一次的幻觉）、写失败必须不改状态（等于没生效）。
 *
 * 覆盖面：读回三键 / 坏值回落 / 读失败不拦启动 / 写成功 / 写失败 / 收起展开切换。
 * （round67.2：删掉「整栏隐藏」→ `backlog_pane` 只有 open/rail；旧值 hidden 读回 rail。）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/settings", () => ({
  getSettings: vi.fn(),
  setSetting: vi.fn(),
}));

const ipc = await import("../ipc/settings");
const {
  layout,
  loadLayoutSettings,
  saveBacklogPane,
  saveHintBarMode,
  saveSlotHeight,
  saveWeekendHidden,
  toggleBacklogPane,
  applyHeaderPreset,
  headerPreset,
  moveHeaderGroup,
  saveHeaderLayout,
  saveBacklogEdge,
  resetLayout: resetLayoutAction,
} = await import("./layout.svelte");

function resetLayout() {
  layout.backlogWidth = 260;
  layout.backlogPane = "open";
  layout.weekendHidden = false;
  layout.hintBarMode = "always";
  layout.header = { left: ["week-nav"], right: ["edit", "views", "settings"] };
  layout.backlogEdge = "left";
  layout.backlogTopMode = "chips";
  layout.backlogAutoHide = false;
  layout.autoCollapsed = false;
  layout.dockPreview = null;
}

beforeEach(() => {
  vi.mocked(ipc.getSettings).mockReset();
  vi.mocked(ipc.setSetting).mockReset();
  resetLayout();
});

describe("loadLayoutSettings", () => {
  it("读回三个键", async () => {
    vi.mocked(ipc.getSettings).mockResolvedValue({
      values: {
        backlog_width: "300",
        backlog_pane: "rail",
        weekend_hidden: "1",
        hint_bar_mode: "hidden",
      },
    } as never);
    await loadLayoutSettings();
    expect(layout.backlogWidth).toBe(300);
    expect(layout.backlogPane).toBe("rail");
    expect(layout.weekendHidden).toBe(true);
    expect(layout.hintBarMode).toBe("hidden");
  });

  it("坏值回落默认（读法只有一份，界面上不留幻觉）", async () => {
    vi.mocked(ipc.getSettings).mockResolvedValue({
      values: {
        backlog_pane: "nonsense",
        weekend_hidden: "true",
        hint_bar_mode: "sometimes",
      },
    } as never);
    await loadLayoutSettings();
    expect(layout.backlogPane).toBe("open");
    expect(layout.weekendHidden).toBe(false);
    expect(layout.hintBarMode).toBe("always");
    // round67.2：「整栏隐藏」档删了 —— 旧库存过 hidden 也读回 rail（保留「收起」语义）
    vi.mocked(ipc.getSettings).mockResolvedValue({
      values: { backlog_pane: "hidden" },
    } as never);
    await loadLayoutSettings();
    expect(layout.backlogPane).toBe("rail");
    // round67.1：「按需」档已删 —— 旧库存过 on-demand 也读回 always
    vi.mocked(ipc.getSettings).mockResolvedValue({
      values: { hint_bar_mode: "on-demand" },
    } as never);
    await loadLayoutSettings();
    expect(layout.hintBarMode).toBe("always");
  });

  it("读失败不炸、保持现值（不拦启动）", async () => {
    layout.backlogPane = "rail";
    vi.mocked(ipc.getSettings).mockRejectedValue(new Error("boom"));
    // round79（6b 二轮 P2）：读失败现在**返回 false**（与 `loadPrefs` 同一口径）
    await expect(loadLayoutSettings()).resolves.toBe(false);
    expect(layout.backlogPane).toBe("rail");
  });
});

describe("写入", () => {
  it("成功 → 写对键、状态跟着走", async () => {
    vi.mocked(ipc.setSetting).mockResolvedValue(undefined);
    await expect(saveBacklogPane("rail")).resolves.toBe(true);
    expect(ipc.setSetting).toHaveBeenCalledWith("backlog_pane", "rail");
    expect(layout.backlogPane).toBe("rail");
    await expect(saveWeekendHidden(true)).resolves.toBe(true);
    expect(ipc.setSetting).toHaveBeenCalledWith("weekend_hidden", "1");
    expect(layout.weekendHidden).toBe(true);
    await expect(saveHintBarMode("hidden")).resolves.toBe(true);
    expect(ipc.setSetting).toHaveBeenCalledWith("hint_bar_mode", "hidden");
    expect(layout.hintBarMode).toBe("hidden");
  });

  it("写失败 → false 且状态不动", async () => {
    vi.mocked(ipc.setSetting).mockRejectedValue(new Error("boom"));
    await expect(saveBacklogPane("rail")).resolves.toBe(false);
    expect(layout.backlogPane).toBe("open");
    await expect(saveWeekendHidden(true)).resolves.toBe(false);
    expect(layout.weekendHidden).toBe(false);
    await expect(saveHintBarMode("hidden")).resolves.toBe(false);
    expect(layout.hintBarMode).toBe("always");
  });

  // round82（§5-DP）：`commitSlotHeight` 的 store 半边 —— 写失败 → false 且 `layout.slotHeight` 不动（控件据此拨回）
  it("saveSlotHeight：写失败 → false 且刻度状态不动", async () => {
    vi.mocked(ipc.setSetting).mockRejectedValue(new Error("boom"));
    layout.slotHeight = "auto";
    await expect(saveSlotHeight(26)).resolves.toBe(false);
    expect(ipc.setSetting).toHaveBeenCalledWith("slot_height", "26");
    expect(layout.slotHeight).toBe("auto");
  });

  it("toggleBacklogPane：展开 ↔ 细轨（只有两种形态）", async () => {
    vi.mocked(ipc.setSetting).mockResolvedValue(undefined);
    await toggleBacklogPane();
    expect(layout.backlogPane).toBe("rail");
    await toggleBacklogPane();
    expect(layout.backlogPane).toBe("open");
    await toggleBacklogPane();
    expect(layout.backlogPane).toBe("rail");
  });
});

describe("E1 头部按钮组预设", () => {
  it("默认档：nav 左 / 三个动作组在右", () => {
    expect(headerPreset()).toBe("default");
    expect(layout.header).toEqual({ left: ["week-nav"], right: ["edit", "views", "settings"] });
  });

  it("三档预设各自就位", () => {
    applyHeaderPreset("right");
    expect(layout.header).toEqual({ left: [], right: ["week-nav", "edit", "views", "settings"] });
    expect(headerPreset()).toBe("right");
    applyHeaderPreset("left");
    expect(layout.header).toEqual({ left: ["week-nav", "edit", "views", "settings"], right: [] });
    expect(headerPreset()).toBe("left");
    applyHeaderPreset("default");
    expect(headerPreset()).toBe("default");
  });

  it("拖一个组换区 → 自定义；点默认回来", () => {
    moveHeaderGroup("week-nav", "right");
    expect(layout.header).toEqual({ left: [], right: ["edit", "views", "settings", "week-nav"] });
    expect(headerPreset()).toBe("custom");
    applyHeaderPreset("default");
    expect(headerPreset()).toBe("default");
  });

  it("同区移动到末尾 = 换序（两组同区时也能拖）", () => {
    moveHeaderGroup("settings", "left");
    expect(layout.header).toEqual({ left: ["week-nav", "settings"], right: ["edit", "views"] });
    moveHeaderGroup("settings", "left", 0);
    expect(layout.header).toEqual({ left: ["settings", "week-nav"], right: ["edit", "views"] });
    expect(headerPreset()).toBe("custom");
  });
});

describe("E1 持久化", () => {
  it("读回头部排布 / 停靠边 / 上下的形态 / 自动收起", async () => {
    vi.mocked(ipc.getSettings).mockResolvedValue({
      values: {
        header_layout: '{"left":[],"right":["week-nav","edit","views","settings"]}',
        layout_backlog_edge: "top",
        backlog_top_mode: "panel",
        backlog_auto_hide: "1",
        backlog_height: "260",
      },
    } as never);
    await loadLayoutSettings();
    expect(layout.header).toEqual({ left: [], right: ["week-nav", "edit", "views", "settings"] });
    expect(layout.backlogEdge).toBe("top");
    expect(layout.backlogTopMode).toBe("panel");
    expect(layout.backlogAutoHide).toBe(true);
    expect(layout.backlogHeight).toBe(260);
  });

  it("旧形状（2 组）读回时升级成 4 组", async () => {
    vi.mocked(ipc.getSettings).mockResolvedValue({
      values: {
        header_layout: '{"left":["week-nav"],"right":["head-actions"]}',
      },
    } as never);
    await loadLayoutSettings();
    expect(layout.header).toEqual({ left: ["week-nav"], right: ["edit", "views", "settings"] });
  });

  it("坏 JSON / 坏边值都回默认", async () => {
    vi.mocked(ipc.getSettings).mockResolvedValue({
      values: {
        header_layout: "nope",
        layout_backlog_edge: "diag",
        backlog_top_mode: "x",
        backlog_auto_hide: "yes",
      },
    } as never);
    await loadLayoutSettings();
    expect(layout.header).toEqual({ left: ["week-nav"], right: ["edit", "views", "settings"] });
    expect(layout.backlogEdge).toBe("left");
    expect(layout.backlogTopMode).toBe("chips");
    expect(layout.backlogAutoHide).toBe(false);
  });

  it("saveHeaderLayout / saveBacklogEdge 写库", async () => {
    vi.mocked(ipc.setSetting).mockResolvedValue(undefined as never);
    await saveHeaderLayout();
    expect(ipc.setSetting).toHaveBeenCalledWith("header_layout", JSON.stringify(layout.header));
    await saveBacklogEdge("right");
    expect(ipc.setSetting).toHaveBeenCalledWith("layout_backlog_edge", "right");
  });

  it("resetLayout 写 E1 四键并复位状态", async () => {
    vi.mocked(ipc.setSetting).mockResolvedValue(undefined as never);
    layout.header = { left: [], right: ["week-nav", "edit", "views", "settings"] };
    layout.backlogEdge = "bottom";
    layout.backlogTopMode = "panel";
    layout.backlogAutoHide = true;
    const ok = await resetLayoutAction();
    expect(ok).toBe(true);
    expect(ipc.setSetting).toHaveBeenCalledWith(
      "header_layout",
      JSON.stringify({ left: ["week-nav"], right: ["edit", "views", "settings"] }),
    );
    expect(ipc.setSetting).toHaveBeenCalledWith("backlog_height", "180");
    expect(ipc.setSetting).toHaveBeenCalledWith("layout_backlog_edge", "left");
    expect(ipc.setSetting).toHaveBeenCalledWith("backlog_top_mode", "chips");
    expect(ipc.setSetting).toHaveBeenCalledWith("backlog_auto_hide", "0");
    expect(layout.header).toEqual({ left: ["week-nav"], right: ["edit", "views", "settings"] });
    expect(layout.backlogEdge).toBe("left");
    expect(layout.backlogTopMode).toBe("chips");
    expect(layout.backlogAutoHide).toBe(false);
  });
});
