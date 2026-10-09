/**
 * round85（0.31.0）· **9 套内置配色的小样数据**（设置面板的迷你界面小样）—— 生成物，勿手改。
 *
 * 由 `tools/visual/gen-palettes-85.mjs` 与 `palettes.css` **同一次生成**：值 = 同一套派生令牌里的 6 个颜色。
 * 必须与 `palettes.css` 逐值一致（`tools/visual/spacing-audit.mjs --check` 核 12 套 × 亮暗 × 6 = 144 个值）。
 * 老 3 套的值仍在 `appearance.ts`（手写，那里是它们的唯一来源）；本文件只放新 9 套。
 */
export const NEW_PALETTE_PREVIEW = {
  "endfield-light": { bg: "#ecebe4", card: "#f7f6f1", accent: "#8a7d00", fill: "#d0cca4", line: "#c0ba7d", ink: "#14150f" },
  "endfield-dark": { bg: "#101110", card: "#1a1b18", accent: "#f5e500", fill: "#504c0c", line: "#837b08", ink: "#fdf9c7" },
  "terminal-light": { bg: "#f5f4ee", card: "#fffef8", accent: "#0f7a45", fill: "#bcd6c4", line: "#8ebda2", ink: "#1b241c" },
  "terminal-dark": { bg: "#0b0e0c", card: "#121713", accent: "#3fd07a", fill: "#1a442b", line: "#256f43", ink: "#d5f5e2" },
  "deepsea-light": { bg: "#eef4f5", card: "#ffffff", accent: "#0d7f8c", fill: "#bbdadd", line: "#89bfc6", ink: "#0d1a20" },
  "deepsea-dark": { bg: "#050f16", card: "#0b1a24", accent: "#46d5e2", fill: "#17464f", line: "#26727c", ink: "#d6f6f9" },
  "bauhaus-light": { bg: "#f4f2ea", card: "#ffffff", accent: "#d21f26", fill: "#edc9c4", line: "#e59392", ink: "#111111" },
  "bauhaus-dark": { bg: "#16151a", card: "#201f26", accent: "#e8484f", fill: "#512329", line: "#7f2f35", ink: "#fad7d8" },
  "artdeco-light": { bg: "#f4efe3", card: "#fbf8ef", accent: "#8a6d1f", fill: "#d7ccaf", line: "#c4b58b", ink: "#191a1e" },
  "artdeco-dark": { bg: "#0d0d10", card: "#16161b", accent: "#c9a227", fill: "#423716", line: "#6b581c", ink: "#f3ebcf" },
  "cassette-light": { bg: "#e7dec7", card: "#f1ead6", accent: "#a85c1e", fill: "#d3b592", line: "#cba47b", ink: "#2b241b" },
  "cassette-dark": { bg: "#221d15", card: "#2c261c", accent: "#ffb000", fill: "#60460f", line: "#91670b", ink: "#ffeec7" },
  "north-light": { bg: "#e9ebec", card: "#f7f8f8", accent: "#3f5d99", fill: "#d4d0c8", line: "#b0a08b", ink: "#1a2028" },
  "north-dark": { bg: "#101723", card: "#182132", accent: "#9bb8ff", fill: "#41372e", line: "#685137", ink: "#f1e5d7" },
  "brutal-light": { bg: "#ffffff", card: "#ffffff", accent: "#ff2d20", fill: "#ffdbd9", line: "#ffa19b", ink: "#0a0a0a" },
  "brutal-dark": { bg: "#0a0a0a", card: "#141414", accent: "#ff5b4d", fill: "#4f211d", line: "#85332c", ink: "#ffdbd8" },
  "porcelain-light": { bg: "#f2f1ed", card: "#ffffff", accent: "#0f6f66", fill: "#cadad5", line: "#8cb7b0", ink: "#0a0a0a" },
  "porcelain-dark": { bg: "#0e1012", card: "#16181b", accent: "#7fd4c6", fill: "#2e4744", line: "#47726c", ink: "#e3f6f2" },
} as const;
