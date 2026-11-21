// round94（#2）· **打开那一刻**的视野（必须单独一个场景文件：`round94.js` 里的幕会先滚来滚去）。
//
// 用法（仓库根跑；先 `npm run build`）：
//   node tools/preview/preview.mjs --shots docs/visual/round94/02-now --shots-file scenes/round94-open.js
document.documentElement.dataset.checks = "shots";

window.__SHOTS = [
  {
    name: "02-打开时滚到现在",
    run: async () => {
      const scroll = document.querySelector(".scroll");
      const line = document.querySelector(".now-line");
      const sr = scroll?.getBoundingClientRect();
      const ratio = line && sr ? (line.getBoundingClientRect().top - sr.top) / sr.height : -1;
      window.__DIAG?.push?.(
        `round94 截图 #2：scrollTop=${Math.round(scroll?.scrollTop ?? -1)} 现在线在视口 ${(ratio * 100).toFixed(1)}% 视口=${Math.round(sr?.height ?? -1)}`,
      );
    },
  },
];
