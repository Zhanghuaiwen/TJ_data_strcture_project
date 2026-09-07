import { ObjectPool } from './ObjectPool.js';
import { HorizontalIndex, secOf, subOf } from './HorizontalIndex.js';
import { createDanmakuNode, resetDanmakuNode, compareKey, MEM } from './nodes.js';

/**
 * 【目标方法】带水平索引的双向循环链表
 *
 * 逻辑结构：
 *   底层 —— 以哨兵结点 head 构成的双向循环链表，结点按 (视频时间戳 ts, 到达序号 seq)
 *           升序排列；哨兵关键字视为 -∞，因此“空表 / 到表尾”判断统一为 cur === head。
 *   索引 —— 三级时间索引（块 → 秒槽 → 100ms 子桶），见 HorizontalIndex。
 *
 * 关键操作复杂度（n = 窗口内弹幕总数，L = 单秒限流阈值，W = 窗口秒数）：
 *   · 定位插入位置：O(1)（槽/子桶直接寻址 + 双向指针取前驱），最坏 O(L/SUB_COUNT)
 *   · 插入：O(1) 指针改写（4 次）
 *   · 删除任意结点：O(1)（双向指针自足，无需找前驱）
 *   · 窗口过期切除：O(k)（k 为过期弹幕数，必须逐个归还对象池，已是最优）
 *   与 n 完全解耦 —— 这是本结构相对标准单链表的本质优势。
 */
export class IndexedCircularList {
  constructor({ windowSec = 30, limitPerSec = 500, slotCapacity = 64 } = {}) {
    this.kind = 'indexed';
    this.name = '带水平索引的双向循环链表';
    this.windowSec = windowSec;
    this.limitPerSec = limitPerSec;

    this.pool = new ObjectPool('弹幕结点', createDanmakuNode, resetDanmakuNode);
    this.index = new HorizontalIndex({ slotCapacity });

    // 底层：带哨兵的双向循环链表
    this.head = createDanmakuNode();
    this.head.ts = -Infinity;
    this.head.seq = -Infinity;
    this.head.id = -1;
    this.head.prev = this.head;
    this.head.next = this.head;
    this.size = 0;

    this.metrics = {
      compare: 0, // 关键字比较次数（与平台无关的时间复杂度指标）
      walk: 0, // 指针游走步数
      pointer: 0, // 指针改写次数
      o1Hit: 0, // 索引 O(1) 直接命中前驱的次数
      localScan: 0, // 退化为子桶内局部扫描的次数
      indexJump: 0, // 跨秒（块索引跳跃）定位次数
      inserts: 0,
      removes: 0,
      evicted: 0,
    };
  }

  /* ------------------------------ 对象池 ------------------------------ */

  acquireNode() {
    return this.pool.acquire();
  }

  releaseNode(node) {
    this.pool.release(node);
  }

  getSlot(sec) {
    return this.index.getSlot(sec);
  }

  /* ------------------------------ 查找 ------------------------------ */

  /** 用块索引跳跃到 < sec 的最近非空秒，返回该秒槽的尾结点（无则哨兵） */
  _prevSecTail(sec) {
    const s = this.index.findPrevNonEmptySec(sec);
    if (s < 0) return this.head;
    const slot = this.index.getSlot(s);
    return slot && slot.tail ? slot.tail : this.head;
  }

  /**
   * 定位“前驱结点”：即关键字 <= (ts, seq) 的最后一个结点。
   * 之所以能 O(1) 完成，是因为三级时间索引给出了该时间片的 head / tail：
   *   1) 新结点 >= 子桶 tail        → tail 即前驱；
   *   2) 新结点 <  子桶 head        → 双向链表可直接取 head.prev；
   *   3) 否则只在子桶内部做极短扫描（长度被限流阈值与子桶数量双重约束）。
   */
  findPredecessor(ts, seq) {
    const m = this.metrics;
    const sec = secOf(ts);
    const slot = this.index.getSlot(sec);
    let pred = null;

    if (slot && slot.tail !== null) {
      const sub = slot.subs[subOf(ts)];
      if (sub.tail !== null) {
        m.compare++;
        if (compareKey(sub.tail.ts, sub.tail.seq, ts, seq) <= 0) {
          pred = sub.tail;
          m.o1Hit++;
        } else {
          m.compare++;
          if (compareKey(ts, seq, sub.head.ts, sub.head.seq) < 0) {
            pred = sub.head.prev; // 双向指针：O(1) 跨到上一个时间片
            m.o1Hit++;
          } else {
            pred = sub.head;
            let guard = sub.count;
            while (guard-- > 0 && pred.next !== this.head) {
              const nx = pred.next;
              m.compare++;
              m.walk++;
              if (compareKey(nx.ts, nx.seq, ts, seq) <= 0) pred = nx;
              else break;
            }
            m.localScan++;
          }
        }
      } else {
        // 该 100ms 子桶为空：向左找同秒内最近的非空子桶
        const k = subOf(ts);
        let found = null;
        for (let j = k - 1; j >= 0; j--) {
          const b = slot.subs[j];
          if (b.tail !== null) {
            found = b.tail;
            break;
          }
        }
        pred = found !== null ? found : this._prevSecTail(sec);
        m.indexJump++;
      }
    } else {
      // 该秒还没有任何弹幕：用块索引整块跳跃到最近的非空前驱秒
      pred = this._prevSecTail(sec);
      m.indexJump++;
    }

    // 兜底推进（正常情况下 0~1 次比较即可退出，保证索引异常时仍然有序）
    while (pred !== null && pred.next !== this.head) {
      const nx = pred.next;
      m.compare++;
      if (compareKey(nx.ts, nx.seq, ts, seq) <= 0) {
        pred = nx;
        m.walk++;
      } else break;
    }
    return pred === null ? this.head : pred;
  }

  /* ------------------------------ 插入 / 删除 ------------------------------ */

  insertNode(node) {
    const m = this.metrics;
    const sec = secOf(node.ts);
    const pred = this.findPredecessor(node.ts, node.seq);
    const next = pred.next;

    node.prev = pred;
    node.next = next;
    next.prev = node;
    pred.next = node;

    this.size++;
    m.inserts++;
    m.pointer += 4;
    this.index.attach(sec, node, pred === this.head ? null : pred, next === this.head ? null : next);
    return pred;
  }

  /** O(1) 摘除任意结点（双向指针自足，无需查找前驱） */
  removeNode(node) {
    const m = this.metrics;
    const prev = node.prev;
    const next = node.next;
    prev.next = next;
    next.prev = prev;
    this.size--;
    m.removes++;
    m.pointer += 2;
    this.index.detach(
      secOf(node.ts),
      node,
      prev === this.head ? null : prev,
      next === this.head ? null : next,
    );
    node.prev = null;
    node.next = null;
  }

  /**
   * 滑动窗口过期切除：过期弹幕必为有序前缀，从链首整段摘下并归还对象池。
   * @returns 回收结点数
   */
  evictBefore(cutoffSec) {
    const cutoffTs = cutoffSec * 1000;
    let count = 0;
    let cur = this.head.next;
    while (cur !== this.head && cur.ts < cutoffTs) {
      const next = cur.next;
      this.removeNode(cur);
      this.pool.release(cur);
      cur = next;
      count++;
    }
    this.metrics.evicted += count;
    this.index.resetBefore(cutoffSec);
    return count;
  }

  /** 找到该秒内权重最小的弹幕（限流降级时优先淘汰它），O(1) 命中缓存 */
  findMinWeightInSec(sec) {
    const slot = this.index.getSlot(sec);
    if (!slot || slot.count === 0) return null;
    let best = slot.minNode;
    if (!best) {
      best = slot.head;
      let cur = slot.head;
      let guard = slot.count;
      while (cur && guard-- > 0) {
        if (cur.weight < best.weight) best = cur;
        if (cur === slot.tail) break;
        cur = cur.next;
      }
      slot.minNode = best;
      slot.minWeight = best ? best.weight : Infinity;
    }
    if (!best) return null;
    return { node: best, prev: best.prev === this.head ? null : best.prev };
  }

  /* ------------------------------ 其它 ------------------------------ */

  snapshotWindow(winStart, winEnd, showNodes = 0) {
    return this.index.snapshotWindow(winStart, winEnd, showNodes);
  }

  clear() {
    let cur = this.head.next;
    while (cur !== this.head) {
      const next = cur.next;
      cur.prev = null;
      cur.next = null;
      this.pool.release(cur);
      cur = next;
    }
    this.head.next = this.head;
    this.head.prev = this.head;
    this.size = 0;
    this.index.resetBefore(Infinity);
  }

  /** 空间占用估算（确定性模型：字段数 × 指针宽度） */
  memoryBytes() {
    return (
      this.pool.created * MEM.danmakuNode +
      this.index.slotCapacity * MEM.slot +
      this.index.slotCapacity * 10 * 8 + // 子桶
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
