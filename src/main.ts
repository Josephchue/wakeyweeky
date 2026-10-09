import { mount } from "svelte";
import App from "./App.svelte";
import "./lib/styles/tokens.css";
// round85（0.31.0）：9 套内置配色（生成物）—— 必须在 tokens.css 之后（第 1 层扩展 + 语义层覆盖）
import "./lib/styles/palettes.css";
import "./lib/styles/overlay.css";
import "./lib/styles/actions.css";
// round86（0.32.0 · ③）：装饰层（读 palettes.css 里的 --deco-* 令牌画形状/线/层）
import "./lib/styles/decor.css";

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
