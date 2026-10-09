# 参与开发（CONTRIBUTING）

谢谢你有兴趣。这是一个**个人项目**：我会尽力回应，但不承诺响应时间 —— 提 issue / PR 之前先看一眼有没有类似的就行。

## 环境

| 需要 | 说明 |
| --- | --- |
| Windows 10 / 11 | 项目只发布 Windows 版（Tauri 的 Windows 打包链） |
| Node.js 20+ | 前端与构建脚本 |
| Rust stable（MSVC 工具链） | <https://rustup.rs> 默认选项即可 |
| MSVC C++ 生成工具 + Windows SDK | 装 Visual Studio Build Tools 时勾「使用 C++ 的桌面开发」；内嵌 SQLite 也需要它 |
| WebView2 运行时 | Windows 11 自带；Windows 10 可能需要装一次 |

## 三个命令

```bash
npm install
npm run tauri dev      # 开发模式（第一次编译 Rust 依赖，几分钟）
npm run tauri build    # 出 MSI：src-tauri/target/release/bundle/msi/
```

技术栈：Tauri 2（Rust 后端 + 命令层）· Svelte 5（runes）+ TypeScript 前端 · SQLite（`rusqlite`，内嵌，无外部服务）· Vite。

主要目录：

```text
src/lib/components/   界面（Svelte 组件）
src/lib/stores/       前端状态（含 vitest 用的假后端测试）
src/lib/styles/       设计令牌（tokens.css）与生成物（palettes.css）
src/lib/i18n/         文案资源层（messages/zh.json 是唯一源）
src-tauri/src/        Rust：db / 命令层 / 提醒 / 托盘 / 统计 / 成就 …
src-tauri/migrations/ 数据库迁移（只追加，不修改历史）
tools/                开发工具：预览断言、文档渲染、i18n、视觉检查、发布脚本
```

## 提交前请跑一遍闸门

```bash
npm run check                                        # svelte-check：0 错 0 警
npm run test:unit                                    # vitest（含会记事、按周过滤的假后端）
(cd src-tauri && cargo test)                         # Rust 单测
(cd src-tauri && cargo clippy --all-targets)         # 期望 0 warning
npm audit                                            # 期望 0 vulnerabilities

# 视觉 / 文案 / 生成物（改过对应部分就跑）
node tools/i18n/check.mjs                            # 文案层：硬编码 / 对照 / 占位 / 英文表
node tools/visual/spacing-audit.mjs --check           # 间距、字号、密度、配色小样、跨语言清单
node tools/visual/contrast.mjs --quiet                # 24 组 × 52 对对比度
node tools/visual/timefmt-scan.mjs                    # 时间 / 日期格式的唯一实现
node tools/visual/gen-palettes-85.mjs --check         # 配色生成物与源逐字节一致（防手改漂移）
```

## 验证界面：用假数据，别碰真实数据

界面行为有一层**真前端 + 假数据**的自动检查（`tools/preview/`）：它启动一个本地服务器 + Edge，把一段**假的 Tauri 后端**注入页面，跑 DOM 断言并截图。

```bash
npm run build                                  # 预览读的是 dist/，改过 src/ 必须先 build
node tools/preview/preview.mjs                 # 全部断言；截图落在系统临时目录
node tools/preview/preview.mjs --width 715     # 窄窗口（最小支持宽度）复现
node tools/preview/preview.mjs --only 窄窗   # 只跑名字含该子串的断言（配合 --width 用）
node tools/preview/preview.mjs --locale en     # 用英文界面跑（排版溢出更容易暴露）
```

想给文档出演示图：

```bash
node tools/preview/preview.mjs --shots docs/images --shots-file scenes/docs-shots.js --width 1500
```

（`tools/preview/scenes/*.js` 是场景表：每幕摆一个状态，跑完一幕拍一张。）

> **两条硬规矩**
> 1. **绝不拿真实数据跑验证**：预览连的是假后端，不会启动应用、不会打开你的库。
> 2. **红色优先**：先让新加的检查在旧代码上**真的失败一次**（证明它抓得住），再去改代码把它变绿。反过来做等于没验证。

## 改代码时的几条约定

- **界面文案不写死**：用户能看到的字都进 `messages/zh.json`（键名 `ui.*` / `msg.*`），英文表由工作表流程生成（`node tools/i18n/check.mjs` 会核对）。新增键要同时满足：键齐、占位符一致、英文无中文残留。
- **颜色 / 间距 / 字号走令牌**：`src/lib/styles/tokens.css` 是唯一来源；`spacing-audit.mjs` 会拦下硬编码的数值。改配色请改生成器的源（`tools/visual/gen-palettes-85.mjs` + `tools/visual/candidates/decor-86.json`），再重跑生成，别直接改 `palettes.css`。
- **数据只经命令层写**：前端一律走 Tauri 命令（会记账、可撤销）；不要在组件里拼 SQL 或直接改文件。
- **迁移只追加**：`src-tauri/migrations/` 里的历史迁移不修改，新增一条。
- **注释里的「不要 X，否则 Y」是硬约束**：那是踩过坑留下的记录，请连同它一起读。
- **一切「会动数据」的操作都要能被 `Ctrl+Z` 撤销**，并有对应的 Rust / vitest 用例。

> 你会在源码注释里看到 `roundNN` 这样的**批次编号**（后面常跟一个括号代号）：那是开发期的批次记法，对应的计划文档没有公开 —— 看注释本身即可，不用去找那份文件。

## 提 PR

- **先开 issue 说清「要解决什么」**（或者直接 PR 但描述里写清）：小改动直接来，大改动先聊，避免白做。
- 一个 PR 一件事；**行为变化**写进描述（不是文件列表）。
- 自检清单见 PR 模板：跑过哪些闸门、有没有新用例、改没改文案 / 令牌 / 迁移。
- 评审我会看三件事：行为对不对、测试有没有覆盖、有没有绕开上面的约定。
- 合并方式：squash（一个 PR 一个提交）。
- 语言：中文 / English 都行。

## 许可

本项目是 [MIT](LICENSE)。你的贡献按同一许可发布（提交 PR 即视为同意）。
