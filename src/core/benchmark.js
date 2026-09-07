import { DanmakuEngine } from './DanmakuEngine.js';
import { Emitter, makeUniformScenario } from './emitter.js';

/**
 * 性能对比实验
 *
 * 控制变量：
 *   · 两种结构使用**完全相同**的输入序列（同种子、同到达顺序、同时间戳）；
 *   · 同样的窗口长度、限流阈值、对象池策略；
 *   · 同一浏览器同一线程内连续测量（计时用 performance.now()）。
 *
 * 观测指标：
 *   · 时间：总耗时 ms、关键字比较次数、指针游走步数、指针改写次数
 *          （比较次数与硬件/语言无关，是更可信的时间复杂度证据）
 *   · 空间：对象池累计申请结点数、存活峰值、估算字节数
 */

export const DEFAULT_SCALES = [1000, 3000, 6000, 10000, 20000, 40000];

/** 用同一个种子预生成到达序列，保证两种结构吃到的输入完全一致 */
export function buildEventStream({ total, rate = 300, lateRatio = 0.3, seed = 20240901 }) {
  const emitter = new Emitter(null, { seed, scenario: makeUniformScenario({ rate, lateRatio }) });
  const groups = [];
  let remaining = total;
  let sec = 0;
  while (remaining > 0) {
    sec++;
    const n = Math.min(rate, remaining);
    const arr = new Array(n);
    for (let i = 0; i < n; i++) arr[i] = emitter.makeDanmaku(sec, { lateRatio });
    groups.push(arr);
    remaining -= n;
  }
  return groups;
}

function replay(groups, mode, cfg) {
  const engine = new DanmakuEngine({ ...cfg, mode, silent: true });
  const t0 = performance.now();
  for (let i = 0; i < groups.length; i++) {
    engine.advance();
    const g = groups[i];
    for (let j = 0; j < g.length; j++) engine.receive(g[j]);
  }
  const t1 = performance.now();
  const m = engine.list.metrics;
  const st = engine.stats;
  return {
    mode,
    name: engine.list.name,
    timeMs: t1 - t0,
    compare: m.compare,
    walk: m.walk,
    pointer: m.pointer,
    inserted: st.inserted,
    evicted: st.evicted,
    droppedLow: st.droppedLow,
    replaced: st.replaced,
    finalSize: engine.list.size,
    peakLive: engine.list.pool.peakLive,
    created: engine.list.pool.created,
    reuse: engine.list.pool.reuseCount,
    memoryBytes: engine.list.memoryBytes(),
    o1Hit: m.o1Hit || m.fastPath || 0,
    fullScan: m.fullScan || 0,
  };
}

/**
 * 异步执行完整实验（每个规模之间让出主线程，便于 UI 渐进刷新）
 * @returns {Promise<Array>} 每个规模一行，含 indexed / single 两套结果
 */
export async function runBenchmark({
  scales = DEFAULT_SCALES,
  rate = 300,
  lateRatio = 0.3,
  windowSec = 30,
  limitPerSec = 500,
  seed = 20240901,
  repeat = 1,
  onProgress,
} = {}) {
  const cfg = { windowSec, limitPerSec };
  const rows = [];
  for (let i = 0; i < scales.length; i++) {
    const scale = scales[i];
    const groups = buildEventStream({ total: scale, rate, lateRatio, seed });
    let indexed = null;
    let single = null;
    for (let r = 0; r < repeat; r++) {
      const a = replay(groups, 'indexed', cfg);
      const b = replay(groups, 'single', cfg);
      if (!indexed || a.timeMs < indexed.timeMs) indexed = a;
      if (!single || b.timeMs < single.timeMs) single = b;
    }
    const row = { scale, indexed, single };
    if (indexed.compare > 0) {
      row.speedupCompare = single.compare / indexed.compare;
    }
    if (indexed.timeMs > 0) {
      row.speedupTime = single.timeMs / indexed.timeMs;
    }
    row.memoryRatio = single.memoryBytes > 0 ? indexed.memoryBytes / single.memoryBytes : 0;
    rows.push(row);
    if (onProgress) onProgress(row, rows, i / scales.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return rows;
}

export function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}
