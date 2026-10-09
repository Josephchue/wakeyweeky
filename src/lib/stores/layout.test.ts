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
} = await import("./layout.svelte");

function resetLayout() {
  layout.backlogWidth = 260;
  layout.backlogPane = "open";
  layout.weekendHidden = false;
  layout.hintBarMode = "always";
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
