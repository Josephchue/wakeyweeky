<script lang="ts">
  import { blocks } from "../stores/blocks.svelte";
  import { link, linkCursor, sequences } from "../stores/sequences.svelte";
  import { week } from "../stores/week.svelte";
  import type { Sequence } from "../ipc/types";

  /** 一条连线（坐标相对 .board：这样滚动时不用重算） */
  type Wire = { key: string; x1: number; y1: number; x2: number; y2: number };

  let wires = $state<Wire[]>([]);

  const CENTER_Y = (rect: DOMRect) => rect.top + rect.height / 2;

  /**
   * 每一环的**代表块**：优先「计划中」的那个。
   * 为什么要选代表：残影与它漂出去的新块**共享同一环**（C3.1），连线只该连新块那个。
   */
  function representative(sequence: Sequence, position: number): string | null {
    const same = sequence.members.filter((m) => m.order_index === position);
    if (same.length === 0) return null;
    const planned = same.find(
      (m) => blocks.find((b) => b.id === m.block_id)?.status === "planned",
    );
    return (planned ?? same[same.length - 1]).block_id;
  }

  /**
   * C3.3：待接链时的线头 —— 从起点块连到鼠标位置。
   *
   * round26 #5（用户实测「链接翻页时手上没线头」）：起点块在**别的周**时 DOM 里没有它 →
   * 以前整条线都不画 ✗。现在从**板子靠源块那一侧**的边探出一截（末端还是鼠标那个圆点），
   * 配合顶部「点 ‹ 回去接」的提示条 —— 让人看得出「线头还在手上、它从哪边来」。
   * （跨周接链的功能本身没问题，这里只是视觉兜底，不动语义。）
   */
  function pendingWire(boardRect: DOMRect): Wire | null {
    if (!link.pendingId) return null;
    const x2 = linkCursor.x - boardRect.left;
    const y2 = linkCursor.y - boardRect.top;
    const from = document.querySelector<HTMLElement>(`[data-block-id="${link.pendingId}"]`);
    if (from) {
      const a = from.getBoundingClientRect();
      return { key: "__pending", x1: a.right - boardRect.left, y1: CENTER_Y(a) - boardRect.top, x2, y2 };
    }
    // 起点不在本屏（在别的周）：从板子的日列区边缘探出来
    const bodies = document.querySelectorAll<HTMLElement>(".day-body");
    if (bodies.length === 0) return null;
    const earlier = link.originWeekFrom !== null && link.originWeekFrom < week.from;
    const edge = earlier
      ? bodies[0].getBoundingClientRect().left
      : bodies[bodies.length - 1].getBoundingClientRect().right;
    return { key: "__pending", x1: edge - boardRect.left, y1: y2, x2, y2 };
  }

  /**
   * 量一次：把序列里**相邻环**的代表块连起来，另外画上「手里那根线头」。
   * 跨周（或成员不在当前 DOM 里）时两端找不到 → 不画线（序号徽标还在，见 TaskBlock）；
   * 但**手里的线头**即使起点不在本屏也要画（走到板子边上，round26 #5）。
   */
  function measure() {
    const board = document.querySelector(".board");
    if (!board) return;
    const boardRect = board.getBoundingClientRect();

    const next: Wire[] = [];
    for (const sequence of sequences) {
      const positions = [...new Set(sequence.members.map((m) => m.order_index))].sort(
        (a, b) => a - b,
      );
      for (let i = 0; i < positions.length - 1; i++) {
        const fromId = representative(sequence, positions[i]);
        const toId = representative(sequence, positions[i + 1]);
        if (!fromId || !toId) continue;

        const from = document.querySelector<HTMLElement>(`[data-block-id="${fromId}"]`);
        const to = document.querySelector<HTMLElement>(`[data-block-id="${toId}"]`);
        if (!from || !to) continue;

        const a = from.getBoundingClientRect();
        const b = to.getBoundingClientRect();
        next.push({
          key: `${sequence.id}-${positions[i]}`,
          x1: a.right - boardRect.left,
          y1: CENTER_Y(a) - boardRect.top,
          x2: b.left - boardRect.left,
          y2: CENTER_Y(b) - boardRect.top,
        });
      }
    }
    const pending = pendingWire(boardRect);
    if (pending) next.push(pending);
    wires = next;
  }

  // 块/序列变化 → 下一帧重量（重建 DOM 后坐标会变；rAF 合并连续变化）
  $effect(() => {
    void blocks.length;
    // C3.2：块**时间**变了也要重量（拖拽移动后连线得跟着走）
    void blocks.map((b) => b.start_at).join(",");
    void sequences.length;
    // C3.3：线头跟着鼠标 → 每次移动都要重算坐标（每次只读几个 rect，很便宜）
    void link.pendingId;
    void linkCursor.x;
    void linkCursor.y;
    void sequences.map((s) => s.members.length).join(",");
    const handle = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(handle);
  });

  // 窗口/面板尺寸变化 → 重量（块的像素位置变了）
  $effect(() => {
    const board = document.querySelector(".board");
    if (!board) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(board);
    return () => observer.disconnect();
  });
</script>

<!-- C3：细线连接（叠在时间轴上的一层；pointer-events 关掉，绝不挡块的点击与拖拽） -->
<svg class="wires" aria-hidden="true">
  {#each wires as wire (wire.key)}
    {#if wire.key === "__pending"}
      <!-- 手里的线头：实线 + 末端一个小圆点，读起来像「捏着线头」 -->
      <g class="pending">
        <line x1={wire.x1} y1={wire.y1} x2={wire.x2} y2={wire.y2} />
        <circle cx={wire.x2} cy={wire.y2} r="3" />
      </g>
    {:else}
      <path d="M {wire.x1} {wire.y1} L {wire.x2} {wire.y2}" />
    {/if}
  {/each}
</svg>

<style>
  .wires {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
    /* C1.1 实测反馈：块改成绝对定位后，DOM 顺序在后面的块会把没有 z-index 的线盖住
       （以前块是普通流元素，定位的线本来就在上面）→ 明确抬到块之上；
       pointer-events 已关掉，所以在上面也不会挡块的点击与拖拽 */
    z-index: 2;
  }

  path {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.5;
    stroke-dasharray: 3 2;
    opacity: 0.75;
  }

  .pending line {
    stroke: var(--accent);
    stroke-width: 2;
  }

  .pending circle {
    fill: var(--accent);
  }
</style>
