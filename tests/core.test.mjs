/**
 * 核心正确性测试（npm test）
 * 覆盖：乱序有序性 / 三级索引一致性 / 窗口切除与对象池回收 /
 *       单秒限流降级 / 空窗期滑动 / 延迟老弹幕突发 / 双结构性能对照
 */
import { IndexedCircularList } from '../src/core/IndexedCircularList.js';
import { SinglyLinkedList } from '../src/core/SinglyLinkedList.js';
import { DanmakuEngine } from '../src/core/DanmakuEngine.js';
import { Emitter, SCENARIOS } from '../src/core/emitter.js';
import { runBenchmark } from '../src/core/benchmark.js';
import { secOf, subOf } from '../src/core/HorizontalIndex.js';

let failed = 0;
function check(cond, msg) {
  if (cond) console.log('  ok   -', msg);
  else {
    failed++;
    console.error('  FAIL -', msg);
  }
}

function toArray(list) {
  const out = [];
  if (list.kind === 'indexed') {
    let cur = list.head.next;
    let g = 0;
    while (cur !== list.head && g++ < 2e6) {
      out.push(cur);
      cur = cur.next;
    }
  } else {
    let cur = list.head;
    let g = 0;
    while (cur && g++ < 2e6) {
      out.push(cur);
      cur = cur.next;
    }
  }
  return out;
}

function checkSorted(list, tag) {
  const arr = toArray(list);
  let ok = arr.length === list.size;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i - 1].ts > arr[i].ts || (arr[i - 1].ts === arr[i].ts && arr[i - 1].seq > arr[i].seq)) ok = false;
  }
  check(ok, `${tag}: 链表按 (ts,seq) 有序且 size 一致 (size=${list.size}, 遍历=${arr.length})`);
  return arr;
}

function checkSlots(list, tag) {
  const arr = toArray(list);
  const pos = new Map();
  for (let i = 0; i < arr.length; i++) pos.set(arr[i], i);
  let total = 0;
  let ok = true;
  for (let i = 0; i < list.index.slotCapacity; i++) {
    const s = list.index.slots[i];
    if (s.sec < 0) continue;
    total += s.count;
    if (s.count > 0) {
      if (!s.head || secOf(s.head.ts) !== s.sec) ok = false;
      if (!s.tail || secOf(s.tail.ts) !== s.sec) ok = false;
      const hi = pos.get(s.head);
      const ti = pos.get(s.tail);
      if (hi === undefined || ti === undefined || ti < hi) ok = false;
      if (hi > 0 && secOf(arr[hi - 1].ts) === s.sec) ok = false;
      if (ti < arr.length - 1 && secOf(arr[ti + 1].ts) === s.sec) ok = false;
      if (ti - hi + 1 !== s.count) ok = false;
      if (list.index.useSubs) {
        let subTotal = 0;
        for (let k = 0; k < s.subs.length; k++) {
          const b = s.subs[k];
          subTotal += b.count;
          if (b.count > 0) {
            if (!b.head || subOf(b.head.ts) !== k || secOf(b.head.ts) !== s.sec) ok = false;
            if (!b.tail || subOf(b.tail.ts) !== k || secOf(b.tail.ts) !== s.sec) ok = false;
          }
        }
        if (subTotal !== s.count) ok = false;
      }
    } else if (s.head !== null || s.tail !== null) ok = false;
  }
  check(ok && total === list.size, `${tag}: 秒槽/子桶索引与底层链表一致 (槽计数合计=${total}, size=${list.size})`);
}

console.log('\n[1] 随机乱序插入（2000 条，时间戳随机分布于 30 秒）');
for (const mode of ['indexed', 'single']) {
  const list = mode === 'indexed' ? new IndexedCircularList({}) : new SinglyLinkedList({});
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 2000; i++) {
    const n = list.acquireNode();
    n.ts = Math.floor(rnd() * 30000);
    n.seq = i;
    n.weight = 1 + (i % 10);
    list.insertNode(n);
  }
  checkSorted(list, mode);
  checkSlots(list, mode);
}

console.log('\n[2] 滑动窗口切除 + 对象池回收');
for (const mode of ['indexed', 'single']) {
  const list = mode === 'indexed' ? new IndexedCircularList({}) : new SinglyLinkedList({});
  for (let sec = 0; sec < 40; sec++) {
    for (let i = 0; i < 40; i++) {
      const n = list.acquireNode();
      n.ts = sec * 1000 + i * 25;
      n.seq = sec * 40 + i;
      n.weight = 1 + (i % 10);
      list.insertNode(n);
    }
    list.evictBefore(sec - 29);
  }
  checkSorted(list, mode);
  checkSlots(list, mode);
  check(list.size === 1200, `${mode}: 窗口内仅保留 30 秒数据 (size=${list.size})`);
  check(
    list.pool.reuseCount > 0 && list.pool.created > list.pool.live,
    `${mode}: 过期结点被对象池回收复用 (复用=${list.pool.reuseCount}, 累计新建=${list.pool.created}, 存活=${list.pool.live})`,
  );
}

console.log('\n[3] 单秒超阈值 -> 基于权重的降级丢弃');
for (const mode of ['indexed', 'single']) {
  const engine = new DanmakuEngine({ mode, windowSec: 30, limitPerSec: 500 });
  const emitter = new Emitter(engine, { seed: 7, scenario: SCENARIOS.overload });
  for (let i = 0; i < 14; i++) emitter.step();
  const win = engine.snapshot(0).window;
  const maxCount = Math.max(...win.map((w) => w.count));
  check(maxCount <= 500, `${mode}: 单秒弹幕数不超过上限 (峰值=${maxCount})`);
  check(
    engine.stats.droppedLow + engine.stats.replaced > 0,
    `${mode}: 触发降级 (低权丢弃=${engine.stats.droppedLow}, 顶替=${engine.stats.replaced})`,
  );
  const arr = toArray(engine.list);
  const avg = arr.reduce((s, n) => s + n.weight, 0) / arr.length;
  check(avg > 4, `${mode}: 降级后保留弹幕平均权重高于总体均值 3.4 (avg=${avg.toFixed(2)})`);
  checkSorted(engine.list, mode);
  checkSlots(engine.list, mode);
}

console.log('\n[4] 空窗期：无输入时窗口照常滑动');
for (const mode of ['indexed', 'single']) {
  const engine = new DanmakuEngine({ mode, windowSec: 30, limitPerSec: 500 });
  const emitter = new Emitter(engine, { seed: 11, scenario: SCENARIOS.silent });
  for (let i = 0; i < 30; i++) emitter.step();
  check(engine.nowSec === 30, `${mode}: 时间轴推进到 30s`);
  const arr = toArray(engine.list);
  // 12~26s 无输入；取 12~22s 这一“干净区间”（不受 27s 之后延迟 3~5s 的老弹幕影响）断言为空
  const inSilent = arr.filter((n) => n.ts >= 12000 && n.ts < 22000).length;
  check(
    inSilent === 0 && arr.length > 0,
    `${mode}: 空窗期 12~26s 无输入，窗口仍正常滑动 (空窗区间残留=${inSilent}, 窗口=${engine.windowStart}~${engine.windowEnd}s, size=${arr.length})`,
  );
}

console.log('\n[5] 延迟 3~5 秒的老弹幕突发（乱序插入）');
for (const mode of ['indexed', 'single']) {
  const engine = new DanmakuEngine({ mode, windowSec: 30, limitPerSec: 500 });
  const emitter = new Emitter(engine, { seed: 13, scenario: SCENARIOS.burstLate });
  for (let i = 0; i < 15; i++) emitter.step();
  checkSorted(engine.list, mode);
  checkSlots(engine.list, mode);
  check(engine.stats.inserted > 5000, `${mode}: 突发期间入窗 ${engine.stats.inserted} 条`);
}

console.log('\n[6] 双结构性能对照（小规模冒烟）');
const rows = await runBenchmark({ scales: [1000, 3000], rate: 300, lateRatio: 0.3 });
for (const r of rows) {
  console.log(
    `  规模=${r.scale}: 索引链 ${r.indexed.timeMs.toFixed(2)}ms / ${r.indexed.compare} 次比较` +
      ` | 单链表 ${r.single.timeMs.toFixed(2)}ms / ${r.single.compare} 次比较` +
      ` | 比较次数比 ${r.speedupCompare.toFixed(1)}x`,
  );
  check(r.indexed.compare < r.single.compare, `规模=${r.scale}: 索引结构比较次数更少`);
  check(r.indexed.inserted === r.single.inserted, `规模=${r.scale}: 两种结构入窗量一致 (${r.indexed.inserted})`);
}

console.log(failed === 0 ? '\n全部测试通过' : `\n存在 ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
