<script lang="ts">
  /**
   * round73（3.0b₁）：**富文本消息**渲染（不用 `{@html}`，CSP 不变）。
   *
   * 值里的约定（见 plan §3.1）：`**粗**` → `<b>`、`` `码` `` → `<code>`，其余原样。
   * 用途：说明页 / 长旁批里带强调的整句 —— 让「一条文案是一条消息」，而不是被标签切碎的片段
   * （片段拼接在英文里词序会散架）。
   */
  import { t, type MsgKey, type MsgParams } from "./i18n.svelte";

  let { k, p }: { k: MsgKey; p?: MsgParams } = $props();

  type Seg = { i: number; tag: "b" | "code" | null; text: string };

  const parts = $derived(parse(t(k, p)));

  function parse(text: string): Seg[] {
    const out: Seg[] = [];
    const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ i: i++, tag: null, text: text.slice(last, m.index) });
      out.push({ i: i++, tag: m[1] !== undefined ? "b" : "code", text: m[1] ?? m[2] ?? "" });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ i: i++, tag: null, text: text.slice(last) });
    return out;
  }
</script>

{#each parts as part (part.i)}{#if part.tag === "b"}<b>{part.text}</b>{:else if part.tag === "code"}<code>{part.text}</code>{:else}{part.text}{/if}{/each}
