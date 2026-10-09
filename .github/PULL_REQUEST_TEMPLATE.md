## 这个 PR 做了什么

（一句话说清**行为变化**；不是文件列表。）

## 为什么

（对应哪个 issue / 解决什么场景。没有 issue 就写清动机。）

## 怎么验的

- [ ] 先复现，后修改：我让新加的检查在旧代码上**真的红过一次**
- [ ] `npm run check`（0 错 0 警）
- [ ] `npm run test:unit`
- [ ] `(cd src-tauri && cargo test)`
- [ ] `(cd src-tauri && cargo clippy --all-targets)`（0 warning）
- [ ] 改过界面 → 跑了 `node tools/preview/preview.mjs`（并说明看了哪几条断言 / 有没有新断言）
- [ ] 改过文案 → 跑了 `node tools/i18n/check.mjs`
- [ ] 改过样式 / 配色 → 跑了 `node tools/visual/spacing-audit.mjs --check` 与 `node tools/visual/contrast.mjs`

## 影响面

- [ ] 用户可见文案（新增 / 改动的键）
- [ ] 设计令牌 / 配色（改的是生成器的源，不是 `palettes.css`）
- [ ] 数据库迁移（**只追加**，写了迁移号）
- [ ] 会动数据的操作（是否走命令层、能否 `Ctrl+Z` 撤销）

## 界面截图（改了界面才需要）

（用 `tools/preview` 的假数据截图；**别贴真实数据**。）
