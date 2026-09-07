import { ObjectPool } from './ObjectPool.js';
import { HorizontalIndex, secOf } from './HorizontalIndex.js';
import { createSlimNode, resetSlimNode, compareKey, MEM } from './nodes.js';

/**
 * 【基准方法】标准单链表
 *
 * 逻辑结构：仅保留 head / tail / size 的最朴素单链表，结点只有 next 指针。
 * 物理结构上同样复用对象池（与实验组保持一致，排除 GC 差异的干扰），
 * 并共享“秒级槽计数”以满足密度统计与限流的工程需求；但：
 *   · 插入定位必须从头结点线性扫描（O(n)）；
 *   · 删除任意结点必须重新查找前驱（O(n)）；
 * 即本结构不提供任何用于“有序定位”的索引 —— 这正是与实验组的对照点。
 *
 * 注：为公平起见，本实现保留了任何工程师都会写的“尾指针快速路径”
 * （新弹幕时间戳 >= 尾结点时直接尾插 O(1)）。即便如此，一旦出现
 * 乱序 / 延迟到达的老弹幕，该优化立即失效并退化为 O(n) 扫描。
 */
export class SinglyLinkedList {
  constructor({ windowSec = 30, limitPerSec = 500, slotCapacity = 64 } = {}) {
    this.kind = 'single';
    this.name = '标准单链表（基准）';
    this.windowSec = windowSec;
    this.limitPerSec = limitPerSec;

    this.pool = new ObjectPool('弹幕结点', createSlimNode, resetSlimNode);
    // 基准结构只维护秒级槽（用于密度统计与限流），不维护 100ms 子桶
    this.index = new HorizontalIndex({ slotCapacity, useSubs: false });

    this.head = null;
    this.tail = null;
    this.size = 0;

    this.metrics = {
      compare: 0,
      walk: 0,
      pointer: 0,
      fastPath: 0, // 尾指针快速路径命中次数
      fullScan: 0, // 退化为从头扫描的次数
      indexJump: 0,
      inserts: 0,
      removes: 0,
      evicted: 0,
    };
  }

  acquireNode() {
    return this.pool.acquire();
  }

  releaseNode(node) {
    this.pool.release(node);
  }

  getSlot(sec) {
    return this.index.getSlot(sec);
  }

  /** 从头线性扫描找前驱（关键字 < (ts, seq) 的最后一个结点），没有则为 null */
  findPredecessor(ts, seq) {
    const m = this.metrics;
    // 尾指针快速路径：仅当新弹幕时间戳不小于尾结点时有效
    if (this.tail) {
      m.compare++;
      if (compareKey(this.tail.ts, this.tail.seq, ts, seq) <= 0) {
        m.fastPath++;
        return this.tail;
      }
    }
    let pred = null;
    let cur = this.head;
    while (cur !== null) {
      m.compare++;
      if (compareKey(cur.ts, cur.seq, ts, seq) < 0) {
        pred = cur;
        cur = cur.next;
        m.walk++;
      } else break;
    }
    m.fullScan++;
    return pred;
  }

  insertNode(node) {
    const m = this.metrics;
    const sec = secOf(node.ts);
    const pred = this.findPredecessor(node.ts, node.seq);

    if (pred === null) {
      node.next = this.head;
      this.head = node;
      if (this.tail === null) this.tail = node;
    } else {
      node.next = pred.next;
      pred.next = node;
      if (pred === this.tail) this.tail = node;
    }
    this.size++;
    m.inserts++;
    m.pointer += 2;
    this.index.attach(sec, node, pred, node.next);
    return pred;
  }

  /**
   * 删除结点：单链表必须知道前驱。
   * @param prevNode 已知前驱（null 表示删除头结点，undefined 表示未知需重新扫描）
   */
  removeNode(node, prevNode) {
    const m = this.metrics;
    let prev = prevNode;
    if (prev === undefined) {
      if (this.head === node) {
        prev = null;
      } else {
        let cur = this.head;
        while (cur !== null && cur.next !== node) {
          m.compare++;
          m.walk++;
          cur = cur.next;
        }
        prev = cur;
      }
    }
    if (prev === null) {
      this.head = node.next;
      if (this.tail === node) this.tail = node.next;
    } else {
      prev.next = node.next;
      if (this.tail === node) this.tail = prev;
    }
    this.size--;
    m.removes++;
    m.pointer += 1;
    this.index.detach(secOf(node.ts), node, prev, node.next);
    node.next = null;
  }

  /** 过期弹幕必为有序前缀，从链首逐个摘除并归还对象池 */
  evictBefore(cutoffSec) {
    const cutoffTs = cutoffSec * 1000;
    let count = 0;
    while (this.head !== null && this.head.ts < cutoffTs) {
      const node = this.head;
      this.head = node.next;
      if (this.tail === node) this.tail = null;
      this.index.detach(secOf(node.ts), node, null, this.head);
      node.next = null;
      this.size--;
      this.pool.release(node);
      count++;
    }
    this.metrics.evicted += count;
    this.index.resetBefore(cutoffSec);
    return count;
  }

  /** 该秒内权重最小的弹幕：只能从槽首线性扫描（单链表还需顺带记录前驱） */
  findMinWeightInSec(sec) {
    const slot = this.index.getSlot(sec);
    if (!slot || slot.count === 0) return null;
    let best = slot.head;
    let bestPrev = null;
    let prev = null;
    let cur = slot.head;
    let guard = slot.count;
    while (cur !== null && guard-- > 0) {
      if (cur.weight < best.weight) {
        best = cur;
        bestPrev = prev;
      }
      if (cur === slot.tail) break;
      prev = cur;
      cur = cur.next;
    }
    // bestPrev 为 null 有两种可能：best 就是链首，或 best 就是槽首（其真正前驱在更早的秒）。
    // 单链表无法 O(1) 区分，故交回 undefined 由 removeNode 从头定位前驱（这是单链表的固有代价）。
    return best ? { node: best, prev: bestPrev === null ? undefined : bestPrev } : null;
  }

  snapshotWindow(winStart, winEnd, showNodes = 0) {
    return this.index.snapshotWindow(winStart, winEnd, showNodes);
  }

  clear() {
    let cur = this.head;
    while (cur !== null) {
      const next = cur.next;
      cur.next = null;
      this.pool.release(cur);
      cur = next;
    }
    this.head = null;
    this.tail = null;
    this.size = 0;
    this.index.resetBefore(Infinity);
  }

  memoryBytes() {
    return (
      this.pool.created * MEM.slimNode +
      this.index.slotCapacity * MEM.slot +
      this.index.blockCapacity * MEM.block
    );
  }

  stats() {
    return {
      kind: this.kind,
      name: this.name,
      size: this.size,
      metrics: { ...this.metrics },
      pool: this.pool.snapshot(),
    };
  }
}
