/**
 * round77（3.1b）：**五套图标的拉取器**（dev 工具，产物进仓库、运行时零联网）。
 *
 * 做什么：把我们用的 40 个语义名 → 五套图标集里各自的名字 → 从官方 CDN 取 SVG →
 * 形状统一转成 `path d` → 写成 `src/lib/icons/sets/<set>.ts`。
 *
 * 用法（在仓库根跑）：
 *   node tools/icons/vendor.mjs --plan      # 只核对名字（打表：命中 / 缺项 / 建议候选），不写文件
 *   node tools/icons/vendor.mjs             # 核对 + 拉取 + 写 .ts + 写对照报告
 *
 * 纪律：
 * - **版本钉死**（`VERSIONS`）：可复跑、结果可复现；升级版本 = 改常量 + 重跑 + 看对照表。
 * - **缺项逐条记账**：某套没有这个图标 → 回退该套用 Lucide 的那一个，并在报告里写出来。
 * - 只保留 `d` 与必要的 paint 覆盖；`fill/stroke/stroke-width` 的默认值按套给（见 `SETS`）。
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const VERSIONS = {
  "lucide-static": "1.52.0",
  "@tabler/icons": "3.49.0",
  "@phosphor-icons/core": "2.1.1",
  "bootstrap-icons": "1.13.1",
  "@material-symbols/svg-400": "0.47.6",
};

/** 五套的取文件方式与渲染默认值 */
const SETS = {
  lucide: {
    pkg: "lucide-static",
    dir: "icons",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
  },
  tabler: {
    pkg: "@tabler/icons",
    dir: "icons/outline",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
  },
  phosphor: {
    pkg: "@phosphor-icons/core",
    dir: "assets/regular",
    viewBox: "0 0 256 256",
    fill: "currentColor",
    stroke: "none",
  },
  bootstrap: {
    pkg: "bootstrap-icons",
    dir: "icons",
    viewBox: "0 0 16 16",
    fill: "currentColor",
    stroke: "none",
  },
  material: {
    pkg: "@material-symbols/svg-400",
    dir: "rounded",
    viewBox: "0 -960 960 960",
    fill: "currentColor",
    stroke: "none",
  },
};

/**
 * 40 个语义名 + 五套里各自的名字。
 * `meaning` 是给人看的（进对照表）；`sets` 里的值 = 那套包里的文件名（不带 .svg）。
 * 名字来源：图标候选图 §2 的 37 项 + 本批新增（close / lock / chevron-down / redo-2 / rotate-cw）。
 */
const ICONS = [
  { name: "check", meaning: "完成标记（块 / 动作条 / 明细）", sets: { lucide: "check", tabler: "check", phosphor: "check", bootstrap: "check", material: "check" } },
  { name: "x", meaning: "未完成标记", sets: { lucide: "x", tabler: "x", phosphor: "x", bootstrap: "x", material: "close" } },
  { name: "close", meaning: "关闭浮层 / 清除一项", sets: { lucide: "x", tabler: "x", phosphor: "x", bootstrap: "x", material: "close" } },
  { name: "link", meaning: "序列（接链）", sets: { lucide: "link", tabler: "link", phosphor: "link", bootstrap: "link-45deg", material: "link" } },
  { name: "trash-2", meaning: "删除", sets: { lucide: "trash-2", tabler: "trash", phosphor: "trash", bootstrap: "trash", material: "delete" } },
  { name: "ban", meaning: "不计入理智", sets: { lucide: "ban", tabler: "ban", phosphor: "prohibit", bootstrap: "slash-circle", material: "block" } },
  { name: "settings", meaning: "任务设置 / 应用设置", sets: { lucide: "settings", tabler: "settings", phosphor: "gear-six", bootstrap: "gear", material: "settings" } },
  { name: "chevron-left", meaning: "上一周", sets: { lucide: "chevron-left", tabler: "chevron-left", phosphor: "caret-left", bootstrap: "chevron-left", material: "chevron_left" } },
  { name: "chevron-right", meaning: "下一周", sets: { lucide: "chevron-right", tabler: "chevron-right", phosphor: "caret-right", bootstrap: "chevron-right", material: "chevron_right" } },
  { name: "chevron-down", meaning: "展开 / 下拉", sets: { lucide: "chevron-down", tabler: "chevron-down", phosphor: "caret-down", bootstrap: "chevron-down", material: "keyboard_arrow_down" } },
  { name: "chevrons-left", meaning: "收起任务栏", sets: { lucide: "chevrons-left", tabler: "chevrons-left", phosphor: "caret-double-left", bootstrap: "chevron-double-left", material: "keyboard_double_arrow_left" } },
  { name: "chevrons-right", meaning: "展开任务栏", sets: { lucide: "chevrons-right", tabler: "chevrons-right", phosphor: "caret-double-right", bootstrap: "chevron-double-right", material: "keyboard_double_arrow_right" } },
  { name: "pencil", meaning: "重命名", sets: { lucide: "pencil", tabler: "pencil", phosphor: "pencil-simple", bootstrap: "pencil", material: "edit" } },
  { name: "info", meaning: "说明", sets: { lucide: "info", tabler: "info-circle", phosphor: "info", bootstrap: "info-circle", material: "info" } },
  { name: "repeat", meaning: "每周重复", sets: { lucide: "repeat", tabler: "repeat", phosphor: "repeat", bootstrap: "arrow-repeat", material: "repeat" } },
  { name: "medal", meaning: "成就（金章）", sets: { lucide: "medal", tabler: "medal", phosphor: "medal", bootstrap: "award", material: "military_tech" } },
  { name: "lock", meaning: "成就未点亮", sets: { lucide: "lock", tabler: "lock", phosphor: "lock", bootstrap: "lock", material: "lock" } },
  { name: "grip-vertical", meaning: "拖动把手", sets: { lucide: "grip-vertical", tabler: "grip-vertical", phosphor: "dots-six-vertical", bootstrap: "grip-vertical", material: "drag_indicator" } },
  { name: "triangle-alert", meaning: "警告 / 超载", sets: { lucide: "triangle-alert", tabler: "alert-triangle", phosphor: "warning", bootstrap: "exclamation-triangle", material: "warning" } },
  { name: "layout-grid", meaning: "总览", sets: { lucide: "layout-grid", tabler: "layout-grid", phosphor: "squares-four", bootstrap: "grid", material: "grid_view" } },
  { name: "chart-column", meaning: "统计", sets: { lucide: "chart-column", tabler: "chart-bar", phosphor: "chart-bar", bootstrap: "bar-chart", material: "bar_chart" } },
  { name: "plus", meaning: "新建任务", sets: { lucide: "plus", tabler: "plus", phosphor: "plus", bootstrap: "plus-lg", material: "add" } },
  { name: "undo-2", meaning: "撤销", sets: { lucide: "undo-2", tabler: "arrow-back-up", phosphor: "arrow-u-up-left", bootstrap: "arrow-counterclockwise", material: "undo" } },
  { name: "redo-2", meaning: "重做", sets: { lucide: "redo-2", tabler: "arrow-forward-up", phosphor: "arrow-u-up-right", bootstrap: "arrow-clockwise", material: "redo" } },
  { name: "rotate-cw", meaning: "重新安排（漂流）", sets: { lucide: "rotate-cw", tabler: "rotate-clockwise", phosphor: "arrow-clockwise", bootstrap: "arrow-clockwise", material: "rotate_right" } },
  { name: "refresh-cw", meaning: "刷新 / 同步", sets: { lucide: "refresh-cw", tabler: "refresh", phosphor: "arrows-clockwise", bootstrap: "arrow-clockwise", material: "refresh" } },
  { name: "history", meaning: "历史 / 快照", sets: { lucide: "history", tabler: "history", phosphor: "clock-counter-clockwise", bootstrap: "clock-history", material: "history" } },
  { name: "sun", meaning: "亮色", sets: { lucide: "sun", tabler: "sun", phosphor: "sun", bootstrap: "sun", material: "light_mode" } },
  { name: "moon", meaning: "暗色", sets: { lucide: "moon", tabler: "moon", phosphor: "moon", bootstrap: "moon", material: "dark_mode" } },
  { name: "clock", meaning: "时刻 / 现在线", sets: { lucide: "clock", tabler: "clock", phosphor: "clock", bootstrap: "clock", material: "schedule" } },
  { name: "calendar-days", meaning: "日期 / 导出 .ics", sets: { lucide: "calendar-days", tabler: "calendar", phosphor: "calendar-dots", bootstrap: "calendar3", material: "calendar_month" } },
  { name: "bell", meaning: "通知 / 提醒", sets: { lucide: "bell", tabler: "bell", phosphor: "bell", bootstrap: "bell", material: "notifications" } },
  { name: "database", meaning: "数据位置", sets: { lucide: "database", tabler: "database", phosphor: "database", bootstrap: "database", material: "database" } },
  { name: "languages", meaning: "语言", sets: { lucide: "languages", tabler: "language", phosphor: "translate", bootstrap: "translate", material: "language" } },
  { name: "keyboard", meaning: "键位说明", sets: { lucide: "keyboard", tabler: "keyboard", phosphor: "keyboard", bootstrap: "keyboard", material: "keyboard" } },
  { name: "tag", meaning: "分类", sets: { lucide: "tag", tabler: "tag", phosphor: "tag", bootstrap: "tag", material: "sell" } },
  { name: "list-checks", meaning: "复盘清单", sets: { lucide: "list-checks", tabler: "list-check", phosphor: "checks", bootstrap: "check2-square", material: "checklist" } },
  { name: "file-text", meaning: "说明页 / 模板", sets: { lucide: "file-text", tabler: "file-text", phosphor: "file-text", bootstrap: "file-text", material: "description" } },
  { name: "download", meaning: "导出备份", sets: { lucide: "download", tabler: "download", phosphor: "download-simple", bootstrap: "download", material: "download" } },
  { name: "upload", meaning: "恢复备份", sets: { lucide: "upload", tabler: "upload", phosphor: "upload-simple", bootstrap: "upload", material: "upload" } },
];

const SET_KEYS = Object.keys(SETS);
const usePlan = process.argv.includes("--plan");
const BASE = "https://cdn.jsdelivr.net/npm";

const norm = (s) =>
  s
    .toLowerCase()
    .replace(/\.svg$/, "")
    .replace(/_[a-z]+$/, "") // material 的 `_fill400` 之类后缀
    .replace(/[-_ ]/g, "");

/** 拉一套的**文件清单**（jsDelivr flat API；只请求一次，比逐个 HEAD 快且稳） */
async function listFiles(setKey) {
  const { pkg, dir } = SETS[setKey];
  const url = `https://data.jsdelivr.com/v1/package/npm/${pkg}@${VERSIONS[pkg]}/flat`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${pkg} 文件清单拉取失败：HTTP ${res.status}`);
  const data = await res.json();
  const names = new Set();
  for (const f of data.files ?? []) {
    const n = f.name ?? "";
    if (!n.endsWith(".svg")) continue;
    if (dir && !n.startsWith(`/${dir}/`)) continue;
    names.add(path.basename(n, ".svg"));
  }
  return names;
}

const fetchSvg = async (url) => {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
};

/** 简易相似度：按「语义 token 是否包含」给分，够用来挑候选（真正采用的名字仍由人定） */
function suggest(want, pool) {
  const w = norm(want);
  const scored = [];
  for (const cand of pool) {
    const c = norm(cand);
    let score = 0;
    if (c === w) score = 100;
    else if (c.includes(w) || w.includes(c)) score = 60 + Math.min(c.length, w.length);
    else {
      const parts = w.match(/[a-z]+/g) ?? [];
      score = parts.filter((p) => p.length > 2 && c.includes(p)).length * 10;
    }
    if (score > 0) scored.push([score, cand]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, 4).map(([, c]) => c);
}

/** 把 SVG 里的形状统一转成 `path d`（`circle`/`rect`/`line`/`polyline`/`polygon` 都转） */
function shapeToPath(tag, a) {
  const n = (v, d = 0) => (v == null ? d : Number(v));
  switch (tag) {
    case "path":
      return a.d ?? null;
    case "line":
      return `M${n(a.x1)} ${n(a.y1)}L${n(a.x2)} ${n(a.y2)}`;
    case "polyline":
    case "polygon": {
      const pts = (a.points ?? "").trim().split(/[\s,]+/).map(Number);
      if (pts.length < 4) return null;
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      return tag === "polygon" ? `${d}Z` : d;
    }
    case "circle": {
      const cx = n(a.cx);
      const cy = n(a.cy);
      const r = n(a.r);
      return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
    }
    case "ellipse": {
      const cx = n(a.cx);
      const cy = n(a.cy);
      const rx = n(a.rx);
      const ry = n(a.ry);
      return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
    }
    case "rect": {
      const x = n(a.x);
      const y = n(a.y);
      const w = n(a.width);
      const h = n(a.height);
      const rx = Math.min(n(a.rx, 0) || n(a.ry, 0), w / 2, h / 2);
      if (rx <= 0) return `M${x} ${y}h${w}v${h}h${-w}Z`;
      return `M${x + rx} ${y}h${w - 2 * rx}a${rx} ${rx} 0 0 1 ${rx} ${rx}v${h - 2 * rx}a${rx} ${rx} 0 0 1 ${-rx} ${rx}h${-(w - 2 * rx)}a${rx} ${rx} 0 0 1 ${-rx} ${-rx}v${-(h - 2 * rx)}a${rx} ${rx} 0 0 1 ${rx} ${-rx}Z`;
    }
    default:
      return null;
  }
}

/** 解析一份 SVG → `{ paths: [{d, fill?, stroke?}] }`（paint 只在元素显式声明时记） */
function parseSvg(src) {
  const paths = [];
  const re = /<(path|circle|ellipse|rect|line|polyline|polygon)\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(src))) {
    const attrs = {};
    for (const am of m[2].matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) attrs[am[1]] = am[2];
    const d = shapeToPath(m[1], attrs);
    if (!d) continue;
    const item = { d };
    if (attrs.fill) item.fill = attrs.fill;
    if (attrs.stroke) item.stroke = attrs.stroke;
    if (attrs["stroke-width"]) item.strokeWidth = Number(attrs["stroke-width"]);
    paths.push(item);
  }
  return paths;
}

const round = (v) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3))));

async function main() {
  console.log(`图标：${ICONS.length} 个语义名 × ${SET_KEYS.length} 套`);
  const pools = {};
  for (const k of SET_KEYS) {
    pools[k] = await listFiles(k);
    console.log(`  ${k}: ${pools[k].size} 个可用图标（${VERSIONS[SETS[k].pkg]}）`);
  }

  const resolved = []; // { name, set: {setKey: name|"lucide(回退)"|null} }
  const misses = [];
  for (const icon of ICONS) {
    const row = { name: icon.name, meaning: icon.meaning, sets: {}, fallback: [] };
    for (const k of SET_KEYS) {
      const want = icon.sets[k];
      if (pools[k].has(want)) row.sets[k] = want;
      else {
        const cands = suggest(want, pools[k]);
        row.sets[k] = null;
        misses.push({ icon: icon.name, set: k, want, cands });
      }
    }
    resolved.push(row);
  }

  if (misses.length) {
    console.log(`\n⚠️ 有 ${misses.length} 条映射没命中（下面给候选，改 ICONS 表里的名字再跑）：`);
    for (const m of misses) {
      console.log(`  ${m.icon} / ${m.set}: 写的是「${m.want}」 → 候选 ${m.cands.join(" / ") || "（无）"}`);
    }
    if (usePlan) {
      console.log("\n（--plan：先改名字；命中全绿后再不带参数跑。）");
      return;
    }
    console.log("\n缺项将**逐条回退 Lucide**（报告里会写明）。\n");
  }

  // 拉取 + 解析
  const out = {};
  for (const k of SET_KEYS) out[k] = {};
  const report = [];
  for (const row of resolved) {
    const entry = { name: row.name, meaning: row.meaning, sets: {} };
    for (const k of SET_KEYS) {
      let useName = row.sets[k];
      let fellBack = false;
      if (!useName) {
        useName = ICONS.find((i) => i.name === row.name).sets.lucide;
        fellBack = true;
      }
      const { pkg, dir } = SETS[k];
      const url = `${BASE}/${pkg}@${VERSIONS[pkg]}/${dir}/${useName}.svg`;
      const svg = await fetchSvg(url);
      if (!svg) {
        console.error(`  ✗ 拉取失败：${url}`);
        entry.sets[k] = { fallback: true, reason: "fetch-failed" };
        continue;
      }
      const paths = parseSvg(svg);
      if (!paths.length) {
        console.error(`  ✗ 解析出 0 条路径：${url}`);
        entry.sets[k] = { fallback: true, reason: "empty" };
        continue;
      }
      out[k][row.name] = paths;
      entry.sets[k] = { icon: useName, fallback: fellBack, paths: paths.length };
    }
    report.push(entry);
  }

  // 写 .ts
  const iconDir = "src/lib/icons";
  await mkdir(path.join(iconDir, "sets"), { recursive: true });
  for (const k of SET_KEYS) {
    const meta = SETS[k];
    const lines = [
      `// 本文件由 \`node tools/icons/vendor.mjs\` 生成 —— 不要手改（改 \`tools/icons/vendor.mjs\` 后重跑）。`,
      `// 来源：${meta.pkg}@${VERSIONS[meta.pkg]}（${meta.dir}/），许可见 \`src-tauri/resources/ICONS-LICENSE.md\`。`,
      `export const VIEW_BOX = ${JSON.stringify(meta.viewBox)};`,
      `export const DEFAULT_FILL = ${JSON.stringify(meta.fill)};`,
      `export const DEFAULT_STROKE = ${JSON.stringify(meta.stroke)};`,
      `export const STROKE_WIDTH = ${meta.strokeWidth ?? 0};`,
      "",
      "/** 语义名 → 形状（`d` 字符串；paint 只在需要覆盖默认值时出现） */",
      "export const PATHS = {",
    ];
    for (const [name, paths] of Object.entries(out[k])) {
      const items = paths
        .map((p) => {
          const bits = [`d: ${JSON.stringify(p.d)}`];
          if (p.fill && p.fill !== meta.fill) bits.push(`fill: ${JSON.stringify(p.fill)}`);
          if (p.stroke !== undefined && p.stroke !== meta.stroke)
            bits.push(`stroke: ${JSON.stringify(p.stroke)}`);
          if (p.strokeWidth && p.strokeWidth !== meta.strokeWidth)
            bits.push(`strokeWidth: ${p.strokeWidth}`);
          return `    { ${bits.join(", ")} },`;
        })
        .join("\n");
      lines.push(`  ${JSON.stringify(name)}: [\n${items}\n  ],`);
    }
    lines.push("};", "");
    await writeFile(path.join(iconDir, "sets", `${k}.ts`), lines.join("\n"));
    console.log(`  ✓ 写 ${iconDir}/sets/${k}.ts（${Object.keys(out[k]).length} 个图标）`);
  }

  // 对照表（人看的）
  const rowsMd = report
    .map((r) => {
      const cells = SET_KEYS.map((k) => {
        const s = r.sets[k];
        if (!s) return "—";
        return s.fallback ? `**回退 lucide/${s.icon}**` : `${s.icon}`;
      });
      return `| \`${r.name}\` | ${r.meaning} | ${cells.join(" | ")} |`;
    })
    .join("\n");
  const fallbackCount = report.reduce(
    (n, r) => n + SET_KEYS.filter((k) => r.sets[k]?.fallback).length,
    0,
  );
  const totalPaths = (k) =>
    Object.values(out[k]).reduce((n, ps) => n + ps.length, 0);
  const md = `# 图标落地对照表（round77 · 五套）

> 生成：\`node tools/icons/vendor.mjs\`（版本钉死：${SET_KEYS.map((k) => `\`${SETS[k].pkg}@${VERSIONS[SETS[k].pkg]}\``).join(" · ")}）。
> 用途：\`图-12\`（逐套核名 + 缺项回退）的机器证据；\`图-13\`（逐套渲染差异）的输入。
> **缺项 = 回退 Lucide 那一个**，共 **${fallbackCount}** 处；每处都写在这张表里（不许静默）。

| 语义名 | 用途 | lucide | tabler | phosphor | bootstrap | material |
| --- | --- | --- | --- | --- | --- | --- |
${rowsMd}

## 统计

| 套 | 图标数 | 路径总数（形状数） |
| --- | --- | --- |
${SET_KEYS.map((k) => `| ${k} | ${Object.keys(out[k]).length} | ${totalPaths(k)} |`).join("\n")}

- 许可：${SET_KEYS.map((k) => `${k} = ${SETS[k].pkg}`).join(" · ")} —— 五家许可全文见 \`src-tauri/resources/ICONS-LICENSE.md\`。
- 回退处数：**${fallbackCount}**${fallbackCount ? "（逐条见上表加粗行）" : ""}。
`;
  await writeFile("docs/visual/图标落地对照表.md", md);
  console.log(`  ✓ 写 docs/visual/图标落地对照表.md（回退 ${fallbackCount} 处）`);
  console.log(`总计：${ICONS.length} 个语义名；回退 ${fallbackCount} 处。`);
}

await main();
