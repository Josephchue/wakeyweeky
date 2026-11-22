/**
 * E1 修复批：文案键的类型单独一个模块。
 *
 * 为什么拆：`MsgKey = keyof typeof zh` 原本写在 `i18n.svelte.ts` 里；某些编辑器 / LSP 会把
 * JSON 模块的形状缓存住（新加键不刷新 → 明明 `npm run check` 0-0，编辑器仍报「键不存在」）。
 * 让键类型从一个**独立的小模块**导出，改 `messages/zh.json` 时它跟着重新解析。
 */
import zh from "../../../messages/zh.json";

export type MsgKey = keyof typeof zh;
