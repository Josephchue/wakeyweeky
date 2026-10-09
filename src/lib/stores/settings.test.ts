/**
 * C18（round63）：设置 store 的回归防线（R48 的「读回来」这一半）。
 *
 * 为什么要有它：preview 断言只能证明「界面上确实筛选/分组着」—— `loadPrefs` **读失败时**
 * prefs 还留着写入时那份，界面照样是筛选/分组态（round63 交付前 6b 指出的假绿路径）。
 * 这里直接对着假 IPC 验：读回来映射对不对、坏值回不退、写失败状态不动。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/settings", () => ({
  getSettings: vi.fn(),
  setSetting: vi.fn(),
  systemLocale: vi.fn(),
}));

const ipc = await import("../ipc/settings");
const { BACKLOG_ALL } = await import("../utils/backlog-view");
const {
  clearQuiet,
  loadPrefs,
  prefs,
  saveBacklogCollapsed,
  saveBacklogFilter,
  saveBacklogGrouped,
  saveQuietMorning,
  saveRemindLead,
  saveSchedulerEnabled,
  saveUiLocale,
} = await import("./settings.svelte");
const { getLocale } = await import("../i18n/i18n.svelte");

const ALL_KEYS: Record<string, string> = {
  sanity_budget_minutes: "360",
  sanity_enabled: "1",
  scheduler_enabled: "0",
  backlog_width: "260",
  remind_start: "1",
  remind_end: "1",
  review_action: "hint",
  review_remind_at: "sun 20:00",
  quiet_until: "0",
  quiet_morning_at: "08:00",
  remind_lead_minutes: "0",
  backlog_filter: '{"kind":"all"}',
  backlog_grouped: "0",
  backlog_collapsed: "[]",
};

function resetPrefs() {
  prefs.quietUntil = 0;
  prefs.quietMorning = "08:00";
  prefs.remindLeadMinutes = 0;
  prefs.schedulerEnabled = false;
  prefs.backlogFilter = BACKLOG_ALL;
  prefs.backlogGrouped = false;
  prefs.backlogCollapsed = [];
  prefs.uiLocale = "zh";
}

beforeEach(() => {
  vi.mocked(ipc.getSettings).mockReset();
  vi.mocked(ipc.setSetting).mockReset();
  vi.mocked(ipc.systemLocale).mockReset();
  resetPrefs();
});

describe("loadPrefs（读回来）", () => {
  it("把库里存的值映射进 prefs（含规范化：9:30 → 09:30）", async () => {
    vi.mocked(ipc.getSettings).mockResolvedValue({
      values: {
        ...ALL_KEYS,
        quiet_until: "1700000000",
        quiet_morning_at: "9:30",
        remind_lead_minutes: "15",
        scheduler_enabled: "1",
        backlog_filter: '{"kind":"cat","name":"学习"}',
        backlog_grouped: "1",
        backlog_collapsed: '["工作","工作","学习"]',
      },
    });
    await loadPrefs();
    expect(prefs.quietUntil).toBe(1700000000);
    expect(prefs.quietMorning).toBe("09:30");
    expect(prefs.remindLeadMinutes).toBe(15);
    expect(prefs.schedulerEnabled).toBe(true);
    expect(prefs.backlogFilter).toEqual({ kind: "cat", name: "学习" });
    expect(prefs.backlogGrouped).toBe(true);
    expect(prefs.backlogCollapsed).toEqual(["工作", "学习"]);
  });

  it("坏值 / 缺键 → 回默认（不炸、也不把上一份脏值留下）", async () => {
    prefs.backlogGrouped = true;
    prefs.quietUntil = 999;
    vi.mocked(ipc.getSettings).mockResolvedValue({
      values: {
        quiet_until: "垃圾",
        quiet_morning_at: "25:00",
        remind_lead_minutes: "7",
        scheduler_enabled: "yes",
        backlog_filter: "不是 JSON",
        backlog_grouped: "true",
        backlog_collapsed: '{"a":1}',
      },
    });
    await loadPrefs();
    expect(prefs.quietUntil).toBe(0);
    expect(prefs.quietMorning).toBe("08:00");
    expect(prefs.remindLeadMinutes).toBe(0);
    expect(prefs.schedulerEnabled).toBe(false);
    expect(prefs.backlogFilter).toEqual(BACKLOG_ALL);
    expect(prefs.backlogGrouped).toBe(false);
    expect(prefs.backlogCollapsed).toEqual([]);
  });

  it("读失败 → 保留旧值（界面照常，不假装清空）", async () => {
    prefs.backlogGrouped = true;
    vi.mocked(ipc.getSettings).mockRejectedValue(new Error("ipc 炸了"));
    // round79（6b 二轮 P2）：读失败现在**返回 false**（「恢复默认设置」靠它决定要不要说「已恢复」）
    await expect(loadPrefs()).resolves.toBe(false);
    expect(prefs.backlogGrouped, "读不到 ≠ 清空").toBe(true);
  });
});

describe("写设置：成对写、失败不动状态", () => {
  it("saveBacklogFilter：写的是规范 JSON；失败返回 false 且状态不变", async () => {
    vi.mocked(ipc.setSetting).mockResolvedValue(undefined);
    expect(await saveBacklogFilter({ kind: "cat", name: "学习" })).toBe(true);
    expect(ipc.setSetting).toHaveBeenCalledWith("backlog_filter", '{"kind":"cat","name":"学习"}');
    expect(prefs.backlogFilter).toEqual({ kind: "cat", name: "学习" });

    vi.mocked(ipc.setSetting).mockRejectedValue(new Error("炸"));
    expect(await saveBacklogFilter({ kind: "uncat" })).toBe(false);
    expect(prefs.backlogFilter, "写失败 = 没生效").toEqual({ kind: "cat", name: "学习" });
  });

  it("saveQuietMorning：规范化后写、失败把值留在原处", async () => {
    vi.mocked(ipc.setSetting).mockResolvedValue(undefined);
    expect(await saveQuietMorning("9:05")).toBe(true);
    expect(ipc.setSetting).toHaveBeenCalledWith("quiet_morning_at", "09:05");
    expect(prefs.quietMorning).toBe("09:05");

    vi.mocked(ipc.setSetting).mockRejectedValue(new Error("炸"));
    expect(await saveQuietMorning("25:00"), "非法值直接拒").toBe(false);
    expect(await saveQuietMorning("10:00")).toBe(false);
    expect(prefs.quietMorning).toBe("09:05");
  });

  it("saveRemindLead / saveSchedulerEnabled / saveBacklogGrouped / saveBacklogCollapsed / clearQuiet", async () => {
    vi.mocked(ipc.setSetting).mockResolvedValue(undefined);
    expect(await saveRemindLead(30)).toBe(true);
    expect(ipc.setSetting).toHaveBeenCalledWith("remind_lead_minutes", "30");
    expect(await saveRemindLead(7), "非档位直接拒").toBe(false);
    expect(prefs.remindLeadMinutes).toBe(30);

    expect(await saveSchedulerEnabled(true)).toBe(true);
    expect(ipc.setSetting).toHaveBeenCalledWith("scheduler_enabled", "1");
    expect(prefs.schedulerEnabled).toBe(true);

    expect(await saveBacklogGrouped(true)).toBe(true);
    expect(ipc.setSetting).toHaveBeenCalledWith("backlog_grouped", "1");
    expect(prefs.backlogGrouped).toBe(true);

    expect(await saveBacklogCollapsed(["工作", "工作", "学习"])).toBe(true);
    expect(ipc.setSetting).toHaveBeenCalledWith("backlog_collapsed", '["工作","学习"]');
    expect(prefs.backlogCollapsed).toEqual(["工作", "学习"]);

    prefs.quietUntil = 1700000000;
    expect(await clearQuiet()).toBe(true);
    expect(ipc.setSetting).toHaveBeenCalledWith("quiet_until", "0");
    expect(prefs.quietUntil).toBe(0);
  });

  // round74（3.0b₂）：语言 —— E3（写失败不撒谎）/ E10（旧库读回 zh）
  // ⚠️ CI 首跑（2026-10-09）抓到：`navigator` 在现代 Node 里也**存在**，且值随**机器**变（
  //    开发机 zh-CN / runner en-US）—— 所以这两条必须**显式钉住** navigator.language。
  it("saveUiLocale：写成功 → prefs 与 t() 用的 locale 一起换", async () => {
    vi.stubGlobal("navigator", { language: "zh-CN" }); // 「跟随系统」那一档的解析源（不能靠机器）
    vi.mocked(ipc.setSetting).mockResolvedValue(undefined);
    expect(await saveUiLocale("en")).toBe(true);
    expect(ipc.setSetting).toHaveBeenCalledWith("ui_locale", "en");
    expect(prefs.uiLocale).toBe("en");
    expect(getLocale()).toBe("en");
    expect(await saveUiLocale("zh")).toBe(true);
    expect(getLocale()).toBe("zh");
    expect(await saveUiLocale("system")).toBe(true);
    expect(prefs.uiLocale).toBe("system");
    expect(getLocale()).toBe("zh"); // 系统档 = zh-CN → 解析成 zh（上面钉住的）
  });

  it("saveUiLocale：写失败 → 保持原语言（界面不撒谎）", async () => {
    vi.stubGlobal("navigator", { language: "zh-CN" });
    vi.mocked(ipc.setSetting).mockRejectedValue(new Error("炸"));
    prefs.uiLocale = "zh";
    expect(await saveUiLocale("en")).toBe(false);
    expect(prefs.uiLocale).toBe("zh");
    expect(getLocale()).toBe("zh");
  });

  // round82（§5-DP）：`calibrateSystemLocale` 的**守卫分支**（round81 深-03 的 6b 欠账）
  it("calibrateSystemLocale：非语言标签不动；en-GB 切英文；zh-Hant-TW 保中文", async () => {
    vi.stubGlobal("navigator", { language: "zh-CN" });
    vi.mocked(ipc.getSettings).mockResolvedValue({ values: { ...ALL_KEYS } } as never);
    // ① 坏标签（旧包 / 假后端 / 异常值）→ 界面与系统标签都不动
    vi.mocked(ipc.systemLocale).mockResolvedValue("not a tag!");
    await loadPrefs();
    await vi.waitFor(() => expect(ipc.systemLocale).toHaveBeenCalled());
    expect(getLocale()).toBe("zh");
    // ② en-GB → 后台校准切成英文
    vi.mocked(ipc.systemLocale).mockResolvedValue("en-GB");
    await loadPrefs();
    await vi.waitFor(() => expect(getLocale()).toBe("en"));
    // ③ zh-Hant-TW → 回中文（整个繁体族归中文；12 小时制由 datetime 侧近似表管）
    vi.mocked(ipc.systemLocale).mockResolvedValue("zh-Hant-TW");
    await loadPrefs();
    await vi.waitFor(() => expect(getLocale()).toBe("zh"));
    vi.unstubAllGlobals();
  });

  it("loadPrefs：旧库没 ui_locale → 档位 system（解析成 zh）；ui_locale=en → 切英文；非法值回 system", async () => {
    vi.stubGlobal("navigator", { language: "zh-CN" }); // 显式钉住系统语言（node ≥21 有全局 navigator）
    // round81（3.1c₁ · 深-03）：存的是**档位**（system / zh / en）；`system` 在测试环境（无 navigator）解析成 zh
    vi.mocked(ipc.getSettings).mockResolvedValue({ values: { ...ALL_KEYS } } as never);
    await loadPrefs();
    expect(prefs.uiLocale).toBe("system");
    expect(getLocale()).toBe("zh");

    vi.mocked(ipc.getSettings).mockResolvedValue({
      values: { ...ALL_KEYS, ui_locale: "en" },
    } as never);
    await loadPrefs();
    expect(prefs.uiLocale).toBe("en");
    expect(getLocale()).toBe("en");

    vi.mocked(ipc.getSettings).mockResolvedValue({
      values: { ...ALL_KEYS, ui_locale: "bogus" },
    } as never);
    await loadPrefs();
    expect(prefs.uiLocale).toBe("system");
    expect(getLocale()).toBe("zh");
    vi.unstubAllGlobals();
  });
});
