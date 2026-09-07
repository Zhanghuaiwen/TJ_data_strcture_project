/**
 * 核心数据结构正确性测试（node tests/core.test.mjs）
 * 校验：有序性 / 槽索引一致性 / 对象池回收 / 限流降级 / 空窗滑动
 */
import { IndexedCircularList } from '../src/core/IndexedCircularList.js';
import { SinglyLinkedList } from '../src/core/SinglyLinkedList.js';
import { DanmakuEngine } from '../src/core/DanmakuEngine.js';
import { Emitter, SCENARIOS } from '../src/core/emitter.js';
import { runBenchmark } from '../src/core/benchmark.js';
import { secOf, subOf } from '../src/core/HorizontalIndex.js';

let failed = 0;
function check(cond, msg) {
  if (cond) {
    console.log('  ok  -', msg);
  } else {
    failed++;
    console.error('  FAIL-', msg);
  }
}

function toArray(list) {
  const out = [];
  if (list.kind === 'indexed') {
    let cur = list.head.next;
    let guard = 0;
    while (cur !== list.head && guard++ < 1e7) {
      out.push(cur);
      cur = cur.next;
    }
  } else {
    let cur = list.head;
    let guard = 0;
    while (cur && guard++ < 1e7) {
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
    const a = arr[i - 1];
    const b = arr[i];
    if (a.ts > b.ts || (a.ts === b.ts && a.seq > b.seq)) ok = false;
  }
  check(ok, `${tag}: 链表有序且 size 一致 (size=${list.size}, 实际=${arr.length})`);
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
    // head / tail 必须落在该秒
    if (s.count > 0) {
      if (!s.head || secOf(s.head.ts) !== s.sec) ok = false;
      if (!s.tail || secOf(s.tail.ts) !== s.sec) ok = false;
      // head 必须是该秒第一个，tail 必须是最后一个
      const hi = pos.get(s.head);
      const ti = pos.get(s.tail);
      if (hi < 0 || ti < 0 || ti < hi) ok = false;
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
    } else if (s.head !== null || s.tail !== null) {
      ok = false;
    }
  }
  check(ok && total === list.size, `${tag}: 槽/子桶索引与链表一致 (槽计数合计=${total}, size=${list.size})`);
}

/* ---------------- 1. 随机乱序插入 ---------------- */
console.log('\n[1] 随机乱序插入');
for (const mode of ['indexed', 'single']) {
  const list =
    mode === 'indexed' ? new IndexedCircularList({ limitPerSec: 500 }) : new SinglyLinkedList({ limitPerSec: 500 });
  for (let i = 0; i < 5000; i++) {
    const n = list.acquireNode();
    n.ts = Math.floor(Math.random() * 30000);
    n.seq = i;
    n.weight = 1 + (i % 10);
    n.text = 't' + i;
    list.insertNode(n);
  }
  checkSorted(list, mode);
  checkSlots(list, mode);
}

/* ---------------- 2. 过期切除与对象池回收 ---------------- */
console.log('\n[2] 滑动窗口切除 + 对象池回收');
for (const mode of ['indexed', 'single']) {
  const list = mode === 'indexed' ? new IndexedCircularList({}) : new SinglyLinkedList({});
  for (let sec = 0; sec < 40; sec++) {
    for (let i = 0; i < 50; i++) {
      const n = list.acquireNode();
      n.ts = sec * 1000 + i * 20;
      n.seq = sec * 50 + i;
      n.weight = 1 + (i % 10);
      list.insertNode(n);
    }
    list.evictBefore(sec - 29);
  }
  checkSorted(list, mode);
  checkSlots(list, mode);
  check(list.size === 30 * 50, `${mode}: 窗口内仅保留 30 秒数据 (size=${list.size})`);
  check(list.pool.reuseCount > 0 && list.pool.created > list.pool.live, `${mode}: 过期结点被对象池复用 (复用=${list.pool.reuseCount}, 新建=${list.pool.created}, 存活=${list.pool.live})`);
}

/* ---------------- 3. 限流降级 ---------------- */
console.log('\n[3] 单秒超阈值 -> 基于权重的降级');
for (const mode of ['indexed', 'single']) {
  const engine = new DanmakuEngine({ mode, windowSec: 30, limitPerSec: 500 });
  const emitter = new Emitter(engine, { seed: 7, scenario: SCENARIOS.overload });
  for (let i = 0; i < 25; i++) emitter.step();
  const win = engine.snapshot(0).window;
  const maxCount = Math.max(...win.map((w) => w.count));
  check(maxCount <= 500, `${mode}: 单秒弹幕数不超过上限 (峰值=${maxCount})`);
  check(engine.stats.droppedLow + engine.stats.replaced > 0, `${mode}: 触发降级 (丢弃=${engine.stats.droppedLow}, 顶替=${engine.stats.replaced})`);
  // 保留下来的应当整体偏向高权重：窗口内平均权重 > 4
  const arr = toArray(engine.list);
  const avg = arr.reduce((s, n) => s + n.weight, 0) / arr.length;
  check(avg > 4, `${mode}: 降级后保留弹幕平均权重偏高 (avg=${avg.toFixed(2)})`);
}

/* ---------------- 4. 空窗期 ---------------- */
console.log('\n[4] 空窗期窗口照常滑动');
for (const mode of ['indexed', 'single']) {
  const engine = new DanmakuEngine({ mode, windowSec: 30, limitPerSec: 500 });
  const emitter = new Emitter(engine, { seed: 11, scenario: SCENARIOS.silent });
  for (let i = 0; i < 40; i++) emitter.step();
  check(engine.nowSec === 40, `${mode}: 时间轴推进到 40s (nowSec=${engine.nowSec})`);
  check(engine.list.size === 0 || engine.list.size < 30 * 300, `${mode}: 空窗后旧数据被回收 (size=${engine.list.size})`);
  checkSorted(engine.list, mode);
}

/* ---------------- 5. 乱序突发 ---------------- */
console.log('\n[5] 延迟 3~5 秒的老弹幕突发');
for (const mode of ['indexed', 'single']) {
  const engine = new DanmakuEngine({ mode, windowSec: 30, limitPerSec: 500 });
  const emitter = new Emitter(engine, { seed: 13, scenario: SCENARIOS.burstLate });
  for (let i = 0; i < 20; i++) emitter.step();
  checkSorted(engine.list, mode);
  checkSlots(engine.list, mode);
  check(engine.stats.received > 8000, `${mode}: 突发期间接收量 ${engine.stats.received}`);
}

/* ---------------- 6. 小规模性能对照 ---------------- */
console.log('\n[6] 性能对照（小规模冒烟）');
const rows = await runBenchmark({ scales: [2000, 5000], rate: 300, lateRatio: 0.3 });
for (const r of rows) {
  console.log(
    `  规模=${r.scale}  索引链: ${r.indexed.timeMs.toFixed(2)}ms/${r.indexed.compare}次比较` +
      `  单链表: ${r.single.timeMs.toFixed(2)}ms/${r.single.compare}次比较` +
      `  比较次数比=${r.speedupCompare.toFixed(1)}x`,
  );
  check(r.indexed.compare < r.single.compare, `规模=${r.scale}: 索引结构比较次数更少`);
  check(r.indexed.inserted === r.single.inserted, `规模=${r.scale}: 两种结构插入量一致 (${r.indexed.inserted})`);
}

console.log(failed === 0 ? '\n全部测试通过 ✅' : `\n存在 ${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
