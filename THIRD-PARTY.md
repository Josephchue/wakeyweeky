# 第三方组件与许可（THIRD-PARTY）

> 本文件由 `tools/release/gen-third-party.mjs` 生成（`--check` 可对账：与仓库里这份逐字节一致）。
> 生成源：`package.json` + `package-lock.json`（npm）与 `cargo metadata`（Rust）。
> 本项目自身：**MIT**（见 [LICENSE](LICENSE)）。

## 一、随包分发的素材（许可全文已随安装包）

| 素材 | 许可 | 全文 |
| --- | --- | --- |
| 展示字 Poiret One · Jost · Archivo Black · Marcellus · Samigirian | SIL Open Font License 1.1 | `src-tauri/resources/*-OFL.txt` |
| 图标集 lucide · tabler · phosphor · bootstrap · Material Symbols | ISC / MIT / MIT / MIT / Apache-2.0 | `src-tauri/resources/ICONS-LICENSE.md` |

## 二、npm 依赖

直接依赖 11 个；`node_modules` 里共 101 个包（含间接，全部为宽松许可）。

| 包 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| `@tauri-apps/api` | 2.12.0 | Apache-2.0 OR MIT | 运行时 |
| `@tauri-apps/plugin-dialog` | 2.8.1 | MIT OR Apache-2.0 | 运行时 |
| `@tauri-apps/plugin-notification` | 2.5.0 | MIT OR Apache-2.0 | 运行时 |
| `date-fns` | 4.4.0 | MIT | 运行时 |
| `@sveltejs/vite-plugin-svelte` | 7.3.1 | MIT | 开发/构建 |
| `@tauri-apps/cli` | 2.12.0 | Apache-2.0 OR MIT | 开发/构建 |
| `svelte` | 5.57.1 | MIT | 开发/构建 |
| `svelte-check` | 4.7.6 | MIT | 开发/构建 |
| `typescript` | 6.0.3 | Apache-2.0 | 开发/构建 |
| `vite` | 8.3.1 | MIT | 开发/构建 |
| `vitest` | 5.0.2 | MIT | 开发/构建 |

## 三、Rust 依赖

直接依赖 15 个；完整依赖树来自 crates.io，共 497 个 crate。

| crate | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| `chrono` | 0.4.45 | MIT OR Apache-2.0 | 运行时 |
| `ical` | 0.11.0 | Apache-2.0（license-file） | 运行时 |
| `notify-rust` | 4.18.1 | MIT OR Apache-2.0 | 运行时 |
| `rusqlite` | 0.40.2 | MIT | 运行时 |
| `serde` | 1.0.229 | MIT OR Apache-2.0 | 运行时 |
| `serde_json` | 1.0.151 | MIT OR Apache-2.0 | 运行时 |
| `sys-locale` | 0.3.2 | MIT OR Apache-2.0 | 运行时 |
| `tauri` | 2.12.0 | Apache-2.0 OR MIT | 运行时 |
| `tauri-build` | 2.7.0 | Apache-2.0 OR MIT | 运行时 |
| `tauri-plugin-dialog` | 2.8.0 | Apache-2.0 OR MIT | 运行时 |
| `tauri-plugin-global-shortcut` | 2.4.0 | Apache-2.0 OR MIT | 运行时 |
| `tauri-plugin-notification` | 2.5.0 | Apache-2.0 OR MIT | 运行时 |
| `tauri-plugin-single-instance` | 2.5.0 | Apache-2.0 OR MIT | 运行时 |
| `tauri-plugin-window-state` | 2.5.0 | Apache-2.0 OR MIT | 运行时 |
| `uuid` | 1.26.1 | Apache-2.0 OR MIT | 运行时 |

### 完整依赖树的许可分布

| 许可 | 数量 |
| --- | --- |
| MIT OR Apache-2.0 | 231 |
| MIT | 113 |
| Apache-2.0 OR MIT | 51 |
| Unicode-3.0 | 18 |
| Zlib OR Apache-2.0 OR MIT | 17 |
| MIT/Apache-2.0 | 16 |
| Unlicense OR MIT | 9 |
| MPL-2.0 | 5 |
| Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | 5 |
| Apache-2.0/MIT | 3 |
| Apache-2.0 | 3 |
| BSD-3-Clause | 2 |
| Zlib | 2 |
| MIT OR Zlib OR Apache-2.0 | 2 |
| BSD-3-Clause OR MIT OR Apache-2.0 | 2 |
| MIT OR Apache-2.0 OR LGPL-2.1-or-later | 2 |
| MIT OR Apache-2.0 OR Zlib | 2 |
| Unlicense/MIT | 2 |
| BSD-2-Clause OR Apache-2.0 OR MIT | 2 |
| 0BSD OR MIT OR Apache-2.0 | 1 |
| BSD-3-Clause AND MIT | 1 |
| BSD-3-Clause/MIT | 1 |
| Apache-2.0 AND MIT | 1 |
| CC0-1.0 OR MIT-0 OR Apache-2.0 | 1 |
| Apache-2.0 / MIT | 1 |
| (无字段) | 1 |
| ISC | 1 |
| Apache-2.0 WITH LLVM-exception | 1 |
| (MIT OR Apache-2.0) AND Unicode-3.0 | 1 |

## 四、许可审计

**范围 = 全部依赖**（npm 101 个包 + cargo 497 个 crate；不只直接依赖）。

**npm 全树的许可分布**

| 许可 | 数量 |
| --- | --- |
| MIT | 67 |
| Apache-2.0 OR MIT | 13 |
| MPL-2.0 | 12 |
| Apache-2.0 | 5 |
| MIT OR Apache-2.0 | 2 |
| ISC | 1 |
| BSD-3-Clause | 1 |

审计结论：**没有**需要人工确认的许可（允许集：MIT / MIT-0 / Apache-2.0 / Apache-2.0 WITH LLVM-exception / BSD-2-Clause / BSD-3-Clause / ISC / Zlib / 0BSD / Unlicense / CC0-1.0 / MPL-2.0 / Unicode-3.0 / Unicode-DFS-2016 / BSL-1.0 / CC-BY-4.0 / OpenSSL）。
> 多许可（A OR B 这种写法）按**宽松那一项**判 —— 例如「MIT OR Apache-2.0 OR LGPL-2.1-or-later」我们选 MIT。
