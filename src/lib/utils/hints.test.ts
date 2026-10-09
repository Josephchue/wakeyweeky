/**
 * round64（C10）：渐进提示注册表（纯数据）。
 * 第三条**真读 Rust 文件**比对白名单 —— 「名字写死在两边」不够，跨语言也得对得上：
 * Rust `hints.rs::HINTS` 改名/增删时这条测试会红（而不是等到真机上 take_hint 报错才发现）。
 *
 * 读文件走 Vite 的 `import.meta.glob(?raw)`（工程没装 `@types/node`，不用 node:fs）。
 */
import { describe, expect, it } from "vitest";
import { HINTS } from "./hints";

const rustFiles = import.meta.glob("../../../src-tauri/src/hints.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const rustSource = Object.values(rustFiles)[0] ?? "";

describe("HINTS 注册表", () => {
  it("4 条、id 唯一", () => {
    expect(HINTS).toHaveLength(4);
    expect(new Set(HINTS.map((h) => h.id)).size).toBe(HINTS.length);
  });

  it("每条都有能读懂的一句话", () => {
    for (const h of HINTS) {
      expect(h.text.length).toBeGreaterThan(10);
      expect(h.text.endsWith("。")).toBe(true);
    }
  });

  it("id 与 Rust `hints.rs` 的白名单逐字一致（真读源文件）", () => {
    const block = rustSource.match(/pub const HINTS:\s*\[&str;\s*\d+\]\s*=\s*\[([^\]]+)\]/);
    expect(block, "找不到 Rust 的 HINTS 白名单（改名了？这条测试该跟着改）").not.toBeNull();
    const rustIds = [...(block?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(rustIds.length).toBeGreaterThan(0);
    expect(HINTS.map((h) => h.id).sort()).toEqual(rustIds.sort());
  });
});
