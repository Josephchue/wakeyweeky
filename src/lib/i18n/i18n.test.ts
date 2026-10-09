import { afterEach, describe, expect, it, vi } from "vitest";
import { fill, normalizeLocaleChoice, resolveLocaleChoice, t } from "./i18n.svelte";

/**
 * round73（3.0b₁）：资源层的**前端判据**（B1/B2）。
 * 口径与 Rust 的 `i18n::render` 逐条一致（那边有同名测试；改一边必须改两边）。
 */
describe("fill（占位渲染）", () => {
  it("B2：`{{`/`}}` 是字面花括号，`{name}` 是占位，未知占位原样保留", () => {
    expect(fill("a{{b}}c{x}d{nope}", { x: "X" })).toBe("a{b}cXd{nope}");
  });

  it("B1：没给的参数不吞整句；多给的参数忽略", () => {
    expect(fill("落点 {span} · {duration}")).toBe("落点 {span} · {duration}");
    expect(fill("落点 {span} · {duration}", { span: "09:00", duration: "1 小时" })).toBe(
      "落点 09:00 · 1 小时",
    );
  });

  it("半截 / 单个花括号不炸", () => {
    expect(fill("{abc")).toBe("{abc");
    expect(fill("a}b")).toBe("a}b");
    expect(fill("")).toBe("");
    // round74（6b P2-10）：单个 '}' 后面还有 '}' —— 不能把中间那个词当参数名
    //（与 Rust `i18n::render` 同名用例对齐；双边必须一致）
    expect(fill("}y}", { y: "Y" })).toBe("}y}");
    expect(fill("} {y}", { y: "Y" })).toBe("} Y");
    expect(fill("}y{x}", { y: "Y", x: "X" })).toBe("}yX");
  });

  it("真消息能取到值（打字错在编译期就挡）", () => {
    expect(t("ui.hint_bar.03")).toContain("模板");
    expect(t("ui.timeline.11", { span: "09:00", duration: "30 分" })).toBe("落点 09:00 · 30 分");
  });
});

/** round81（3.1c₁ · 深-03）：语言**: 档位**的规范化与前端解析（Rust 侧有同名规则 + `resolve_tag` 单测） */
describe("语言档位（system / zh / en）", () => {
  it("只认三档；旧库 / 坏值 → system", () => {
    expect(normalizeLocaleChoice("zh")).toBe("zh");
    expect(normalizeLocaleChoice("en")).toBe("en");
    expect(normalizeLocaleChoice("system")).toBe("system");
    expect(normalizeLocaleChoice("EN")).toBe("system");
    expect(normalizeLocaleChoice(undefined)).toBe("system");
  });

  it("固定档直接用；system 看 navigator（显式 stub，避免靠宿主 locale —— node ≥21 有全局 navigator）", () => {
    expect(resolveLocaleChoice("en")).toBe("en");
    expect(resolveLocaleChoice("zh")).toBe("zh");
    vi.stubGlobal("navigator", { language: "zh-CN" });
    expect(resolveLocaleChoice("system")).toBe("zh");
    vi.stubGlobal("navigator", { language: "zh-Hant-TW" });
    expect(resolveLocaleChoice("system")).toBe("zh");
    vi.stubGlobal("navigator", { language: "en-US" });
    expect(resolveLocaleChoice("system")).toBe("en");
    vi.stubGlobal("navigator", { language: "de-DE" });
    expect(resolveLocaleChoice("system")).toBe("en");
    vi.stubGlobal("navigator", undefined);
    expect(resolveLocaleChoice("system")).toBe("zh"); // 读不到 → 回落旧行为
  });

  afterEach(() => vi.unstubAllGlobals());
});
