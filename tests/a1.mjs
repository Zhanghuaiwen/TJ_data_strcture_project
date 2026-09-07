import { IndexedCircularList } from '../src/core/IndexedCircularList.js';
import { SinglyLinkedList } from '../src/core/SinglyLinkedList.js';
import { DanmakuEngine } from '../src/core/DanmakuEngine.js';
import { Emitter, SCENARIOS } from '../src/core/emitter.js';
import { secOf, subOf } from '../src/core/HorizontalIndex.js';

let failed = 0;
function check(cond, msg) {
  if (cond) console.log('  ok  -', msg);
  else {
    failed++;
    console.error('  FAIL-', msg);
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
  for (let i = 1; i < arr.length; i++) if (arr[i - 1].ts > arr[i].ts) ok = false;
  check(ok, `${tag}: 有序且 size 一致 (${list.size}/${arr.length})`);
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
  check(ok && total === list.size, `${tag}: 槽/子桶一致 (合计=${total}, size=${list.size})`);
}

console.log('[1] 随机乱序插入');
for (const mode of ['indexed', 'single']) {
  const list = mode === 'indexed' ? new IndexedCircularList({}) : new SinglyLinkedList({});
  for (let i = 0; i < 3000; i++) {
    const n = list.acquireNode();
    n.ts = Math.floor(Math.random() * 30000);
    n.seq = i;
    n.weight = 1 + (i % 10);
    list.insertNode(n);
  }
  checkSorted(list, mode);
  checkSlots(list, mode);
}

console.log('[2] 滑动窗口 + 对象池');
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
  check(list.size === 1500, `${mode}: 窗口保留 30 秒 (${list.size})`);
  check(list.pool.reuseCount > 0, `${mode}: 对象池复用 ${list.pool.reuseCount}`);
}

console.log('[3] 限流降级');
for (const mode of ['indexed', 'single']) {
  const engine = new DanmakuEngine({ mode, windowSec: 30, limitPerSec: 500 });
  const emitter = new Emitter(engine, { seed: 7, scenario: SCENARIOS.overload });
  for (let i = 0; i < 25; i++) emitter.step();
  const win = engine.snapshot(0).window;
  const maxCount = Math.max(...win.map((w) => w.count));
  check(maxCount <= 500, `${mode}: 单秒不超上限 (峰值=${maxCount})`);
  check(engine.stats.droppedLow + engine.stats.replaced > 0, `${mode}: 触发降级 丢${engine.stats.droppedLow}/顶${engine.stats.replaced}`);
  checkSorted(engine.list, mode);
  checkSlots(engine.list, mode);
}

console.log('[4] 空窗期');
for (const mode of ['indexed', 'single']) {
  const engine = new DanmakuEngine({ mode, windowSec: 30, limitPerSec: 500 });
  const emitter = new Emitter(engine, { seed: 11, scenario: SCENARIOS.silent });
  for (let i = 0; i < 40; i++) emitter.step();
  check(engine.nowSec === 40, `${mode}: 时间轴 40s`);
  checkSorted(engine.list, mode);
  console.log('   size =', engine.list.size);
}

console.log('[5] 乱序突发');
for (const mode of ['indexed', 'single']) {
  const engine = new DanmakuEngine({ mode, windowSec: 30, limitPerSec: 500 });
  const emitter = new Emitter(engine, { seed: 13, scenario: SCENARIOS.burstLate });
  for (let i = 0; i < 20; i++) emitter.step();
  checkSorted(engine.list, mode);
  checkSlots(engine.list, mode);
  console.log('   接收 =', engine.stats.received, '插入 =', engine.stats.inserted);
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
