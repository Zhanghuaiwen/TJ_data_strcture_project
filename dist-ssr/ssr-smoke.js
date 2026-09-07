import { jsxs, jsx, Fragment } from "react/jsx-runtime";
import React, { useState, useRef, useEffect, useCallback } from "react";
import { renderToString } from "react-dom/server";
class ObjectPool {
  constructor(name, factory, reset) {
    this.name = name;
    this.factory = factory;
    this.reset = reset;
    this.freeHead = null;
    this.freeCount = 0;
    this.created = 0;
    this.live = 0;
    this.peakLive = 0;
    this.reuseCount = 0;
  }
  /** O(1) 申请：优先从池中取，池空才向系统申请新对象 */
  acquire() {
    let o = this.freeHead;
    if (o !== null) {
      this.freeHead = o.nextFree;
      o.nextFree = null;
      this.freeCount--;
      this.reuseCount++;
    } else {
      o = this.factory();
      this.created++;
    }
    this.live++;
    if (this.live > this.peakLive) this.peakLive = this.live;
    return o;
  }
  /** O(1) 归还：头插回空闲链 */
  release(o) {
    if (this.reset) this.reset(o);
    o.nextFree = this.freeHead;
    this.freeHead = o;
    this.freeCount++;
    this.live--;
  }
  /** 预热：启动时一次性申请 n 个结点，模拟服务端的内存预分配 */
  preload(n) {
    for (let i = 0; i < n; i++) {
      const o = this.factory();
      o.nextFree = this.freeHead;
      this.freeHead = o;
      this.freeCount++;
      this.created++;
    }
  }
  snapshot() {
    return {
      name: this.name,
      created: this.created,
      live: this.live,
      free: this.freeCount,
      peakLive: this.peakLive,
      reuse: this.reuseCount
    };
  }
}
const SUB_COUNT = 10;
function secOf(ts) {
  return Math.floor(ts / 1e3);
}
function subOf(ts) {
  const s = Math.floor(ts / 1e3);
  const ms = ts - s * 1e3;
  const k = Math.floor(ms / (1e3 / SUB_COUNT));
  return k >= SUB_COUNT ? SUB_COUNT - 1 : k;
}
function sameSec(ts, sec) {
  return Math.floor(ts / 1e3) === sec;
}
class HorizontalIndex {
  constructor({ slotCapacity = 64, blockBits = 3, blockCapacity = 16, useSubs = true } = {}) {
    this.useSubs = useSubs;
    this.slotCapacity = slotCapacity;
    this.slotMask = slotCapacity - 1;
    this.slots = new Array(slotCapacity);
    for (let i = 0; i < slotCapacity; i++) this.slots[i] = this._newSlot();
    this.blockBits = blockBits;
    this.blockSize = 1 << blockBits;
    this.blockCapacity = blockCapacity;
    this.blockMask = blockCapacity - 1;
    this.blocks = new Array(blockCapacity);
    for (let i = 0; i < blockCapacity; i++) this.blocks[i] = this._newBlock();
    this.metrics = { slotLookup: 0, blockSkip: 0, blockScan: 0, o1Hit: 0 };
  }
  _newSlot() {
    const s = {
      sec: -1,
      count: 0,
      head: null,
      tail: null,
      dropped: 0,
      // 因权重过低被直接丢弃
      replaced: 0,
      // 因权重更高而被顶替掉的旧弹幕
      minWeight: Infinity,
      // 槽内最小权重缓存（限流降级用）
      minNode: null,
      subs: new Array(SUB_COUNT)
    };
    for (let i = 0; i < SUB_COUNT; i++) s.subs[i] = { count: 0, head: null, tail: null };
    return s;
  }
  _newBlock() {
    return { idx: -1, count: 0, minSec: Infinity, maxSec: -Infinity };
  }
  /** O(1) 取槽；该秒还没有弹幕时返回 null */
  getSlot(sec) {
    this.metrics.slotLookup++;
    const s = this.slots[sec & this.slotMask];
    return s.sec === sec ? s : null;
  }
  /** O(1) 取槽（不存在则复用该环形下标并重置） */
  touchSlot(sec) {
    const s = this.slots[sec & this.slotMask];
    if (s.sec !== sec) {
      s.sec = sec;
      s.count = 0;
      s.head = null;
      s.tail = null;
      s.dropped = 0;
      s.replaced = 0;
      s.minWeight = Infinity;
      s.minNode = null;
      if (this.useSubs) {
        for (let i = 0; i < SUB_COUNT; i++) {
          const b = s.subs[i];
          b.count = 0;
          b.head = null;
          b.tail = null;
        }
      }
    }
    return s;
  }
  _touchBlock(sec) {
    const idx = sec >> this.blockBits;
    const b = this.blocks[idx & this.blockMask];
    if (b.idx !== idx) {
      b.idx = idx;
      b.count = 0;
      b.minSec = Infinity;
      b.maxSec = -Infinity;
    }
    return b;
  }
  /**
   * 插入结点后维护索引（O(1)）
   * @param sec 秒槽
   * @param node 被插入的结点
   * @param prevNode 底层前驱（无则 null）
   * @param nextNode 底层后继（无则 null）
   */
  attach(sec, node, prevNode, nextNode) {
    const slot = this.touchSlot(sec);
    const k = subOf(node.ts);
    const sub = slot.subs[k];
    const prevSameSec = prevNode ? sameSec(prevNode.ts, sec) : false;
    const nextSameSec = nextNode ? sameSec(nextNode.ts, sec) : false;
    const prevSameSub = prevNode ? prevSameSec && subOf(prevNode.ts) === k : false;
    const nextSameSub = nextNode ? nextSameSec && subOf(nextNode.ts) === k : false;
    slot.count++;
    if (slot.count === 1) {
      slot.head = node;
      slot.tail = node;
    } else {
      if (!prevSameSec) slot.head = node;
      if (!nextSameSec) slot.tail = node;
    }
    if (this.useSubs) {
      sub.count++;
      if (sub.count === 1) {
        sub.head = node;
        sub.tail = node;
      } else {
        if (!prevSameSub) sub.head = node;
        if (!nextSameSub) sub.tail = node;
      }
    }
    if (slot.minNode !== null && node.weight < slot.minWeight) {
      slot.minWeight = node.weight;
      slot.minNode = node;
    }
    const b = this._touchBlock(sec);
    b.count++;
    if (sec < b.minSec) b.minSec = sec;
    if (sec > b.maxSec) b.maxSec = sec;
  }
  /** 删除结点后维护索引（O(1)） */
  detach(sec, node, prevNode, nextNode) {
    const slot = this.getSlot(sec);
    if (!slot) return;
    const k = subOf(node.ts);
    const sub = slot.subs[k];
    const nextSameSec = nextNode ? sameSec(nextNode.ts, sec) : false;
    const prevSameSec = prevNode ? sameSec(prevNode.ts, sec) : false;
    const prevSameSub = prevNode ? prevSameSec && subOf(prevNode.ts) === k : false;
    const nextSameSub = nextNode ? nextSameSec && subOf(nextNode.ts) === k : false;
    if (slot.head === node) slot.head = nextSameSec ? nextNode : null;
    if (slot.tail === node) slot.tail = prevSameSec ? prevNode : null;
    slot.count--;
    if (slot.count <= 0) {
      slot.count = 0;
      slot.head = null;
      slot.tail = null;
    }
    if (this.useSubs) {
      if (sub.head === node) sub.head = nextSameSub ? nextNode : null;
      if (sub.tail === node) sub.tail = prevSameSub ? prevNode : null;
      sub.count--;
      if (sub.count <= 0) {
        sub.count = 0;
        sub.head = null;
        sub.tail = null;
      }
    }
    if (slot.minNode === node) {
      slot.minNode = null;
      slot.minWeight = Infinity;
    }
    const idx = sec >> this.blockBits;
    const b = this.blocks[idx & this.blockMask];
    if (b.idx === idx && b.count > 0) b.count--;
  }
  /** 记录限流降级（仅统计用） */
  markDrop(sec, replaced) {
    const slot = this.getSlot(sec);
    if (!slot) return;
    if (replaced) slot.replaced++;
    else slot.dropped++;
  }
  /** 窗口滑动后清理过期槽与空块，防止陈旧索引干扰 */
  resetBefore(cutoffSec) {
    let cleared = 0;
    for (let i = 0; i < this.slotCapacity; i++) {
      const s = this.slots[i];
      if (s.sec >= 0 && s.sec < cutoffSec) {
        s.sec = -1;
        s.count = 0;
        s.head = null;
        s.tail = null;
        s.minNode = null;
        s.minWeight = Infinity;
        cleared++;
      }
    }
    for (let i = 0; i < this.blockCapacity; i++) {
      const b = this.blocks[i];
      if (b.idx >= 0 && b.count <= 0) {
        b.idx = -1;
        b.minSec = Infinity;
        b.maxSec = -Infinity;
      }
    }
    return cleared;
  }
  /**
   * 借助块索引向后整块跳跃，找到 < sec 的最近一个非空秒。
   * 空窗期（大量空块）时不会被退化为逐槽扫描。
   * @returns -1 表示该秒之前没有任何弹幕
   */
  findPrevNonEmptySec(sec) {
    let b = sec - 1 >> this.blockBits;
    for (let guard = 0; guard < this.blockCapacity; guard++, b--) {
      if (b < 0) return -1;
      const blk = this.blocks[b & this.blockMask];
      if (blk.idx !== b || blk.count <= 0) {
        this.metrics.blockSkip++;
        continue;
      }
      const blockStart = b << this.blockBits;
      const hi = Math.min(blk.maxSec, sec - 1);
      const lo = Math.max(blockStart, blk.minSec === Infinity ? blockStart : blk.minSec);
      for (let s = hi; s >= lo; s--) {
        this.metrics.blockScan++;
        const sl = this.slots[s & this.slotMask];
        if (sl.sec === s && sl.count > 0) return s;
      }
    }
    return -1;
  }
  /** 窗口快照：供可视化面板渲染各时间槽密度 */
  snapshotWindow(winStart, winEnd, showNodes = 0) {
    const out = [];
    for (let sec = winStart; sec <= winEnd; sec++) {
      const s = this.getSlot(sec);
      const count = s ? s.count : 0;
      const item = {
        sec,
        count,
        dropped: s ? s.dropped + s.replaced : 0,
        head: null,
        tail: null,
        nodes: []
      };
      if (s) {
        const subs = new Array(SUB_COUNT);
        for (let k = 0; k < SUB_COUNT; k++) subs[k] = this.useSubs ? s.subs[k].count : -1;
        item.subs = subs;
      }
      if (s && showNodes > 0) {
        item.head = s.head ? { ts: s.head.ts, weight: s.head.weight } : null;
        item.tail = s.tail ? { ts: s.tail.ts, weight: s.tail.weight } : null;
        let cur = s.head;
        let k = 0;
        while (cur && k < showNodes) {
          item.nodes.push({ ts: cur.ts, weight: cur.weight, text: cur.text });
          if (cur === s.tail) break;
          cur = cur.next;
          k++;
        }
      }
      out.push(item);
    }
    return out;
  }
}
function createDanmakuNode() {
  return {
    id: 0,
    // 节点编号（对象池内的唯一编号，便于观察复用）
    ts: 0,
    // 弹幕自带的视频时间戳（毫秒，绝对时间轴）
    seq: 0,
    // 到达序号，用于同毫秒下的稳定排序
    weight: 0,
    // 弹幕权重（1~10），限流降级时优先丢弃低权重
    vip: 0,
    // 用户等级（业务字段）
    text: "",
    // 弹幕文本
    user: "",
    // 发送者
    color: "#ffffff",
    // 颜色
    prev: null,
    // 前驱指针（双向循环链表）
    next: null,
    // 后继指针
    up: null,
    // 水平索引层指针（仅索引链表使用）
    nextFree: null
    // 对象池空闲链指针
  };
}
function resetDanmakuNode(n) {
  n.id = 0;
  n.ts = 0;
  n.seq = 0;
  n.weight = 0;
  n.vip = 0;
  n.text = "";
  n.user = "";
  n.color = "#ffffff";
  n.prev = null;
  n.next = null;
  n.up = null;
}
function createSlimNode() {
  return {
    id: 0,
    ts: 0,
    seq: 0,
    weight: 0,
    vip: 0,
    text: "",
    user: "",
    color: "#ffffff",
    next: null,
    nextFree: null
  };
}
function resetSlimNode(n) {
  n.id = 0;
  n.ts = 0;
  n.seq = 0;
  n.weight = 0;
  n.vip = 0;
  n.text = "";
  n.user = "";
  n.color = "#ffffff";
  n.next = null;
}
const MEM = {
  danmakuNode: 12 * 8,
  // 双向循环链表结点：12 个字段
  slimNode: 10 * 8,
  // 标准单链表结点：10 个字段（少 prev / up）
  slot: 8 * 8,
  // 秒级槽位对象
  block: 4 * 8
  // 块级索引对象
};
function compareKey(aTs, aSeq, bTs, bSeq) {
  if (aTs !== bTs) return aTs < bTs ? -1 : 1;
  if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
  return 0;
}
class IndexedCircularList {
  constructor({ windowSec = 30, limitPerSec = 500, slotCapacity = 64 } = {}) {
    this.kind = "indexed";
    this.name = "带水平索引的双向循环链表";
    this.windowSec = windowSec;
    this.limitPerSec = limitPerSec;
    this.pool = new ObjectPool("弹幕结点", createDanmakuNode, resetDanmakuNode);
    this.index = new HorizontalIndex({ slotCapacity });
    this.head = createDanmakuNode();
    this.head.ts = -Infinity;
    this.head.seq = -Infinity;
    this.head.id = -1;
    this.head.prev = this.head;
    this.head.next = this.head;
    this.size = 0;
    this.metrics = {
      compare: 0,
      // 关键字比较次数（与平台无关的时间复杂度指标）
      walk: 0,
      // 指针游走步数
      pointer: 0,
      // 指针改写次数
      o1Hit: 0,
      // 索引 O(1) 直接命中前驱的次数
      localScan: 0,
      // 退化为子桶内局部扫描的次数
      indexJump: 0,
      // 跨秒（块索引跳跃）定位次数
      inserts: 0,
      removes: 0,
      evicted: 0
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
            pred = sub.head.prev;
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
      pred = this._prevSecTail(sec);
      m.indexJump++;
    }
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
      next === this.head ? null : next
    );
    node.prev = null;
    node.next = null;
  }
  /**
   * 滑动窗口过期切除：过期弹幕必为有序前缀，从链首整段摘下并归还对象池。
   * @returns 回收结点数
   */
  evictBefore(cutoffSec) {
    const cutoffTs = cutoffSec * 1e3;
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
    return this.pool.created * MEM.danmakuNode + this.index.slotCapacity * MEM.slot + this.index.slotCapacity * 10 * 8 + // 子桶
    this.index.blockCapacity * MEM.block;
  }
  stats() {
    return {
      kind: this.kind,
      name: this.name,
      size: this.size,
      metrics: { ...this.metrics },
      pool: this.pool.snapshot()
    };
  }
}
class SinglyLinkedList {
  constructor({ windowSec = 30, limitPerSec = 500, slotCapacity = 64 } = {}) {
    this.kind = "single";
    this.name = "标准单链表（基准）";
    this.windowSec = windowSec;
    this.limitPerSec = limitPerSec;
    this.pool = new ObjectPool("弹幕结点", createSlimNode, resetSlimNode);
    this.index = new HorizontalIndex({ slotCapacity, useSubs: false });
    this.head = null;
    this.tail = null;
    this.size = 0;
    this.metrics = {
      compare: 0,
      walk: 0,
      pointer: 0,
      fastPath: 0,
      // 尾指针快速路径命中次数
      fullScan: 0,
      // 退化为从头扫描的次数
      indexJump: 0,
      inserts: 0,
      removes: 0,
      evicted: 0
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
    if (prev === void 0) {
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
    const cutoffTs = cutoffSec * 1e3;
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
    return best ? { node: best, prev: bestPrev === null ? void 0 : bestPrev } : null;
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
    return this.pool.created * MEM.slimNode + this.index.slotCapacity * MEM.slot + this.index.blockCapacity * MEM.block;
  }
  stats() {
    return {
      kind: this.kind,
      name: this.name,
      size: this.size,
      metrics: { ...this.metrics },
      pool: this.pool.snapshot()
    };
  }
}
const LOG_TYPES = {
  info: { label: "信息", color: "#7aa2f7" },
  phase: { label: "场景", color: "#9ece6a" },
  recycle: { label: "过期回收", color: "#e0af68" },
  drop: { label: "限流丢弃", color: "#f7768e" },
  replace: { label: "降级顶替", color: "#ff9e64" },
  reject: { label: "越界拒绝", color: "#bb9af7" },
  burst: { label: "乱序突发", color: "#2ac3de" }
};
class DanmakuEngine {
  constructor(cfg = {}) {
    this.cfg = {
      windowSec: 30,
      limitPerSec: 500,
      slotCapacity: 64,
      logCapacity: 400,
      mode: "indexed",
      ...cfg
    };
    this.list = null;
    this.setMode(this.cfg.mode);
    this.reset();
  }
  setMode(mode) {
    this.cfg.mode = mode;
    this.mode = mode;
    this.list = mode === "single" ? new SinglyLinkedList({
      windowSec: this.cfg.windowSec,
      limitPerSec: this.cfg.limitPerSec,
      slotCapacity: this.cfg.slotCapacity
    }) : new IndexedCircularList({
      windowSec: this.cfg.windowSec,
      limitPerSec: this.cfg.limitPerSec,
      slotCapacity: this.cfg.slotCapacity
    });
  }
  reset() {
    if (this.list) this.list.clear();
    this.nowSec = 0;
    this.seq = 0;
    this.nodeId = 0;
    this.logs = [];
    this.logId = 0;
    this.flash = { recycle: 0, drop: 0 };
    this.stats = {
      received: 0,
      inserted: 0,
      droppedLow: 0,
      // 权重过低被直接丢弃
      replaced: 0,
      // 顶替掉槽内低权重旧弹幕
      evicted: 0,
      // 窗口滑动回收
      rejectExpired: 0,
      // 到达即已过期
      rejectFuture: 0
      // 时间戳超前
    };
    this._log("info", `引擎就绪：${this.list.name}，窗口 ${this.cfg.windowSec}s，单秒上限 ${this.cfg.limitPerSec} 条`);
  }
  get windowStart() {
    return this.nowSec - this.cfg.windowSec + 1;
  }
  get windowEnd() {
    return this.nowSec;
  }
  _log(type, msg, extra) {
    if (this.cfg.silent) return;
    this.logs.push({ id: ++this.logId, sec: this.nowSec, type, msg, ...extra });
    if (this.logs.length > this.cfg.logCapacity) {
      this.logs.splice(0, this.logs.length - this.cfg.logCapacity);
    }
  }
  log(type, msg, extra) {
    this._log(type, msg, extra);
  }
  _flash(kind) {
    if (this.cfg.silent) return;
    this.flash[kind] = Date.now();
  }
  /** 时间轴推进 1 秒：切除并回收窗口前的过期弹幕 */
  advance() {
    this.nowSec++;
    const cutoffSec = this.windowStart;
    const n = this.list.evictBefore(cutoffSec);
    if (n > 0) {
      this.stats.evicted += n;
      this._log("recycle", `窗口滑动至 [${this.windowStart}s, ${this.windowEnd}s]，切除并回收 ${n} 条过期弹幕`, {
        count: n
      });
      this._flash("recycle");
    }
    return n;
  }
  /**
   * 接收一条弹幕（自带视频时间戳，可能严重乱序）
   * @returns {{ok:boolean, reason?:string}}
   */
  receive(d) {
    const st = this.stats;
    const cfg = this.cfg;
    st.received++;
    const sec = secOf(d.ts);
    if (sec > this.nowSec) {
      st.rejectFuture++;
      this._log("reject", `弹幕时间戳 ${(d.ts / 1e3).toFixed(2)}s 超前于当前时间轴 ${this.nowSec}s，拒绝入窗`);
      return { ok: false, reason: "future" };
    }
    if (sec < this.windowStart) {
      st.rejectExpired++;
      this._log("reject", `弹幕时间戳 ${(d.ts / 1e3).toFixed(2)}s 已滑出窗口 [${this.windowStart}s, ${this.windowEnd}s]，拒绝入窗`);
      return { ok: false, reason: "expired" };
    }
    const node = this.list.acquireNode();
    node.id = ++this.nodeId;
    node.ts = d.ts;
    node.seq = ++this.seq;
    node.weight = d.weight;
    node.vip = d.vip || 0;
    node.text = d.text;
    node.user = d.user;
    node.color = d.color;
    const slot = this.list.getSlot(sec);
    if (slot && slot.count >= cfg.limitPerSec) {
      const victim = this.list.findMinWeightInSec(sec);
      if (victim && d.weight > victim.node.weight) {
        const info = { ts: victim.node.ts, weight: victim.node.weight, text: victim.node.text };
        this.list.removeNode(victim.node, victim.prev);
        this.list.releaseNode(victim.node);
        st.replaced++;
        this.list.index.markDrop(sec, true);
        this._log(
          "replace",
          `第 ${sec}s 达上限 ${cfg.limitPerSec}：新弹幕(权重${d.weight}) 顶替 旧弹幕(权重${info.weight})「${info.text}」`,
          { weight: d.weight }
        );
        this._flash("drop");
      } else {
        this.list.releaseNode(node);
        st.droppedLow++;
        this.list.index.markDrop(sec, false);
        this._log("drop", `第 ${sec}s 达上限 ${cfg.limitPerSec}：新弹幕权重 ${d.weight} 不占优，降级丢弃`, {
          weight: d.weight
        });
        this._flash("drop");
        return { ok: false, reason: "limit" };
      }
    }
    this.list.insertNode(node);
    st.inserted++;
    return { ok: true, node };
  }
  /** UI 快照 */
  snapshot(showNodes = 0) {
    const winStart = this.windowStart;
    const winEnd = this.windowEnd;
    return {
      nowSec: this.nowSec,
      windowStart: winStart,
      windowEnd: winEnd,
      mode: this.mode,
      listName: this.list.name,
      size: this.list.size,
      stats: { ...this.stats },
      metrics: { ...this.list.metrics },
      pool: this.list.pool.snapshot(),
      memoryBytes: this.list.memoryBytes(),
      window: this.list.snapshotWindow(winStart, winEnd, showNodes),
      flash: { ...this.flash },
      logs: this.logs.slice(-120)
    };
  }
}
function createRng(seed = 20240901) {
  let a = seed >>> 0;
  return function next() {
    a = a + 1831565813 >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}
function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}
const TEXTS = [
  "666666",
  "awsl",
  "这波操作太秀了",
  "主播牛啊",
  "前排围观",
  "哈哈哈哈哈",
  "爷青回",
  "泪目了",
  "高能预警",
  "速速上分",
  "这也能赢？",
  "全体起立",
  "手速太快了",
  "打得好啊",
  "再来一局",
  "这波稳了",
  "教练我想学",
  "有点东西",
  "弹幕护体",
  "给我也整一个",
  "太顶了",
  "真的假的",
  "救命笑死",
  "这局必赢"
];
const COLORS_LOW = ["#e6e6e6", "#9ad0ff", "#a9dc76", "#c8d3f5"];
const COLORS_MID = ["#7dcfff", "#ffd166", "#8bd5ca"];
const COLORS_HIGH = ["#ff7b72", "#ffb86c", "#f1fa8c"];
function phaseOf(script, sec) {
  const phases = script.phases;
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    if (sec >= p.from && sec <= p.to) return p;
  }
  return phases[phases.length - 1];
}
const SCENARIOS = {
  normal: {
    key: "normal",
    label: "① 正常运行",
    desc: "稳定 220 条/秒，含 6% 轻微乱序，观察窗口常规滑动与插入",
    phases: [{ from: 0, to: Infinity, rate: 220, lateRatio: 0.06, tag: "正常运行" }]
  },
  burstLate: {
    key: "burstLate",
    label: "② 乱序突发（延迟 3~5 秒老弹幕）",
    desc: "第 10~14 秒突发大量延迟 3~5 秒到达的老弹幕，检验乱序原地插入",
    phases: [
      { from: 0, to: 9, rate: 200, lateRatio: 0.05, tag: "正常" },
      { from: 10, to: 14, rate: 200, lateRatio: 0.05, burstLate: 700, tag: "乱序突发：+700 条/秒 延迟 3~5s" },
      { from: 15, to: Infinity, rate: 200, lateRatio: 0.05, tag: "恢复正常" }
    ]
  },
  silent: {
    key: "silent",
    label: "③ 空窗期（无输入仍滑动）",
    desc: "第 12~26 秒完全无弹幕输入，检验窗口照常滑动、结点照常回收",
    phases: [
      { from: 0, to: 11, rate: 260, lateRatio: 0.05, tag: "正常" },
      { from: 12, to: 26, rate: 0, lateRatio: 0, tag: "空窗期：无输入" },
      { from: 27, to: Infinity, rate: 260, lateRatio: 0.05, tag: "恢复输入" }
    ]
  },
  overload: {
    key: "overload",
    label: "④ 超量限流（超 500 条/秒）",
    desc: "第 8~20 秒按 900 条/秒灌入，远超单秒上限 500，触发基于权重的降级丢弃",
    phases: [
      { from: 0, to: 7, rate: 200, lateRatio: 0.05, tag: "正常" },
      { from: 8, to: 20, rate: 900, lateRatio: 0.08, tag: "超量：900 条/秒" },
      { from: 21, to: Infinity, rate: 200, lateRatio: 0.05, tag: "恢复正常" }
    ]
  },
  mixed: {
    key: "mixed",
    label: "⑤ 综合剧本（依次覆盖三种边界）",
    desc: "0-9s 正常 → 10-14s 乱序突发 → 15-25s 空窗 → 26-36s 超量限流 → 之后恢复",
    phases: [
      { from: 0, to: 9, rate: 220, lateRatio: 0.05, tag: "正常运行" },
      { from: 10, to: 14, rate: 220, lateRatio: 0.05, burstLate: 700, tag: "乱序突发：老弹幕延迟 3~5s 到达" },
      { from: 15, to: 25, rate: 0, lateRatio: 0, tag: "空窗期：无输入，窗口仍滑动" },
      { from: 26, to: 36, rate: 900, lateRatio: 0.08, tag: "超量：900 条/秒，触发限流降级" },
      { from: 37, to: Infinity, rate: 220, lateRatio: 0.06, tag: "恢复正常运行" }
    ]
  }
};
function makeUniformScenario({ rate = 300, lateRatio = 0.25, tag = "压测" } = {}) {
  return {
    key: "bench",
    label: "压测场景",
    desc: `固定 ${rate} 条/秒，${(lateRatio * 100).toFixed(0)}% 延迟 3~5 秒到达`,
    phases: [{ from: 0, to: Infinity, rate, lateRatio, tag }]
  };
}
class Emitter {
  constructor(engine, { seed = 20240901, scenario = "mixed" } = {}) {
    this.engine = engine;
    this.rng = createRng(seed);
    this.seed = seed;
    this.lastTag = null;
    this.setScenario(scenario);
  }
  setScenario(scenario) {
    this.scenario = typeof scenario === "string" ? SCENARIOS[scenario] || SCENARIOS.mixed : scenario;
    this.lastTag = null;
  }
  reseed(seed) {
    this.seed = seed;
    this.rng = createRng(seed);
  }
  phaseAt(sec) {
    return phaseOf(this.scenario, sec);
  }
  /** 生成一条弹幕（自带视频时间戳，可能严重乱序） */
  makeDanmaku(nowSec, { forceLate = false, lateRatio = 0, delayMin = 3, delayMax = 5 } = {}) {
    const rng = this.rng;
    let ts;
    let late = false;
    if (forceLate || rng() < lateRatio) {
      const delay = randInt(rng, delayMin, delayMax);
      const base = Math.max(0, nowSec - delay);
      ts = base * 1e3 + randInt(rng, 0, 999);
      late = true;
    } else {
      ts = nowSec * 1e3 + randInt(rng, 0, 999);
    }
    const r = rng();
    let vip = 0;
    let weight;
    if (r < 0.62) {
      weight = randInt(rng, 1, 3);
    } else if (r < 0.92) {
      vip = randInt(rng, 1, 3);
      weight = randInt(rng, 3, 7);
    } else {
      vip = randInt(rng, 3, 6);
      weight = randInt(rng, 7, 10);
    }
    const palette = weight >= 7 ? COLORS_HIGH : weight >= 4 ? COLORS_MID : COLORS_LOW;
    let text = pick(rng, TEXTS);
    if (rng() < 0.18) text += "！".repeat(randInt(rng, 1, 3));
    return {
      ts,
      weight,
      vip,
      text,
      user: "用户" + randInt(rng, 1e3, 9999),
      color: pick(rng, palette),
      late
    };
  }
  /** 生成当前秒到达的全部弹幕 */
  generate(nowSec) {
    const ph = this.phaseAt(nowSec);
    const rng = this.rng;
    const out = [];
    const jitter = 0.85 + 0.3 * rng();
    const base = Math.round((ph.rate || 0) * jitter);
    for (let i = 0; i < base; i++) {
      out.push(this.makeDanmaku(nowSec, { lateRatio: ph.lateRatio || 0 }));
    }
    if (ph.burstLate) {
      const n = Math.round(ph.burstLate * (0.85 + 0.3 * rng()));
      for (let i = 0; i < n; i++) {
        out.push(this.makeDanmaku(nowSec, { forceLate: true, delayMin: 3, delayMax: 5 }));
      }
    }
    return { list: out, phase: ph };
  }
  /** 推进一个模拟秒：先滑动窗口，再投递本秒弹幕 */
  step() {
    const engine = this.engine;
    engine.advance();
    const { list, phase } = this.generate(engine.nowSec);
    if (phase.tag && phase.tag !== this.lastTag) {
      this.lastTag = phase.tag;
      engine.log("phase", `进入阶段：${phase.tag}`);
    }
    if (phase.burstLate && list.length > 800) {
      engine.log("burst", `老弹幕突发：本秒到达 ${list.length} 条，其中大量延迟 3~5 秒（乱序插入）`);
    }
    const results = [];
    for (let i = 0; i < list.length; i++) {
      results.push(engine.receive(list[i]));
    }
    return { batch: list, results, phase };
  }
  /** 手动注入：立即制造一批延迟 3~5 秒的老弹幕 */
  injectLateBurst(count = 600) {
    const engine = this.engine;
    const list = [];
    for (let i = 0; i < count; i++) {
      list.push(this.makeDanmaku(engine.nowSec, { forceLate: true, delayMin: 3, delayMax: 5 }));
    }
    engine.log("burst", `手动注入 ${count} 条延迟 3~5 秒的老弹幕（乱序插入压力测试）`);
    const results = [];
    for (let i = 0; i < list.length; i++) results.push(engine.receive(list[i]));
    return { batch: list, results };
  }
  /** 手动注入：单秒灌入 N 条（用于触发限流） */
  injectFlood(count = 1200) {
    const engine = this.engine;
    const list = [];
    for (let i = 0; i < count; i++) {
      list.push(this.makeDanmaku(engine.nowSec, { lateRatio: 0.1 }));
    }
    engine.log("burst", `手动注入 ${count} 条/秒 流量洪峰（限流降级测试）`);
    const results = [];
    for (let i = 0; i < list.length; i++) results.push(engine.receive(list[i]));
    return { batch: list, results };
  }
}
const LANES = 9;
function DanmakuStage({ items, nowSec, windowStart, windowEnd, onEnd }) {
  return /* @__PURE__ */ jsxs("div", { className: "stage", children: [
    /* @__PURE__ */ jsx("div", { className: "grid-bg" }),
    /* @__PURE__ */ jsxs("div", { className: "video-info", children: [
      "视频时间轴 ",
      nowSec,
      "s · 滑动窗口 [",
      windowStart,
      "s, ",
      windowEnd,
      "s] · 弹幕按视频时间戳对齐播放"
    ] }),
    items.length === 0 && /* @__PURE__ */ jsx("div", { className: "stage-empty", children: "点击「开始」后弹幕将从右向左飘过" }),
    items.map((d) => /* @__PURE__ */ jsx(
      "span",
      {
        className: `danmaku${d.late ? " late" : ""}`,
        style: {
          top: 30 + d.lane % LANES * 25,
          color: d.color,
          animationDuration: `${d.dur}s`
        },
        onAnimationEnd: () => onEnd(d.key),
        title: `ts=${(d.ts / 1e3).toFixed(2)}s 权重=${d.weight}${d.late ? "（延迟到达）" : ""}`,
        children: d.text
      },
      d.key
    ))
  ] });
}
function colorOf(ratio) {
  const r = Math.max(0, Math.min(1, ratio));
  const hue = 210 - 210 * Math.pow(r, 0.7);
  const light = 26 + 30 * r;
  const sat = 45 + 40 * r;
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}
function DensityPanel({ window: win, limit, nowSec, selected, onSelect, droppedTotal }) {
  const max = Math.max(limit, ...win.map((w) => w.count));
  return /* @__PURE__ */ jsxs("div", { className: "panel", children: [
    /* @__PURE__ */ jsxs("h2", { children: [
      "滑动窗口时间槽密度",
      /* @__PURE__ */ jsxs("span", { className: "tag", children: [
        "共 ",
        win.length,
        " 个时间槽 · 单秒上限 ",
        limit
      ] }),
      droppedTotal > 0 && /* @__PURE__ */ jsxs("span", { className: "tag", style: { color: "var(--danger)" }, children: [
        "累计降级 ",
        droppedTotal
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "density", children: [
      /* @__PURE__ */ jsx(
        "div",
        {
          className: "limit-line",
          style: { bottom: `${limit / max * 100}%` },
          title: `单秒上限 ${limit}`
        }
      ),
      win.map((w) => {
        const ratio = w.count / limit;
        return /* @__PURE__ */ jsx(
          "div",
          {
            className: `bar-wrap${w.sec === selected ? " selected" : ""}`,
            onClick: () => onSelect(w.sec),
            title: `第 ${w.sec}s：${w.count} 条${w.dropped ? `，已降级 ${w.dropped} 条` : ""}`,
            children: /* @__PURE__ */ jsx(
              "div",
              {
                className: "bar",
                style: {
                  height: `${w.count / max * 100}%`,
                  background: colorOf(ratio)
                }
              }
            )
          },
          w.sec
        );
      }),
      /* @__PURE__ */ jsxs("span", { className: "limit-tag", style: { bottom: `calc(${limit / max * 100}% + 2px)` }, children: [
        "上限 ",
        limit
      ] })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "axis", children: win.map((w, i) => /* @__PURE__ */ jsx("span", { style: { color: w.sec === nowSec ? "var(--accent)" : void 0 }, children: i % 3 === 0 || w.sec === nowSec ? w.sec : "" }, w.sec)) }),
    /* @__PURE__ */ jsx("h3", { children: "窗口整体结构（每格 = 1 秒时间槽，数字为该槽弹幕条数）" }),
    /* @__PURE__ */ jsx("div", { className: "slots-strip", children: win.map((w) => /* @__PURE__ */ jsx(
      "div",
      {
        className: `slot-cell${w.count > 0 ? " has" : ""}${w.sec === nowSec ? " now" : ""}`,
        style: w.count > 0 ? { background: colorOf(w.count / limit) } : void 0,
        onClick: () => onSelect(w.sec),
        title: `第 ${w.sec}s：${w.count} 条`,
        children: w.count > 0 ? w.count : "·"
      },
      w.sec
    )) }),
    /* @__PURE__ */ jsx("div", { className: "axis", children: win.map((w, i) => /* @__PURE__ */ jsx("span", { children: i % 5 === 0 ? w.sec : "" }, w.sec)) }),
    /* @__PURE__ */ jsx("p", { className: "hint", children: "提示：点击任意时间槽可查看该秒的链表局部结构（头/尾结点、100ms 子桶分布、结点权重）。" })
  ] });
}
function weightColor(w) {
  if (w >= 8) return "#ff7b72";
  if (w >= 5) return "#ffb86c";
  if (w >= 3) return "#7dcfff";
  return "#8b95a7";
}
function StructurePanel({ slot, mode, limit, nowSec }) {
  if (!slot) return null;
  const { sec, count, head, tail, nodes = [], subs = [], dropped } = slot;
  const hasSubs = subs.length > 0 && subs[0] >= 0;
  return /* @__PURE__ */ jsxs("div", { className: "panel", children: [
    /* @__PURE__ */ jsxs("h2", { children: [
      "第 ",
      sec,
      "s 时间槽的链表结构",
      /* @__PURE__ */ jsxs("span", { className: "tag", children: [
        count,
        " 条 / 上限 ",
        limit
      ] }),
      sec === nowSec && /* @__PURE__ */ jsx("span", { className: "tag", children: "当前秒" }),
      dropped > 0 && /* @__PURE__ */ jsxs("span", { className: "tag", style: { color: "var(--danger)" }, children: [
        "本槽已降级 ",
        dropped,
        " 条"
      ] })
    ] }),
    count === 0 ? /* @__PURE__ */ jsx("p", { className: "hint", children: "该秒没有弹幕（空槽：仅占位，不占用任何结点）。" }) : /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsxs("h3", { children: [
        "100ms 子桶索引（",
        hasSubs ? "目标方法维护" : "标准单链表不维护该层",
        "）"
      ] }),
      /* @__PURE__ */ jsx("div", { className: "subs", children: (hasSubs ? subs : new Array(10).fill(-1)).map((c, i) => /* @__PURE__ */ jsx("div", { className: `sub-cell${c > 0 ? " has" : ""}`, title: `${sec}.${i}s~${sec}.${i + 1}s：${c < 0 ? "无索引" : c + " 条"}`, children: c < 0 ? "—" : c }, i)) }),
      /* @__PURE__ */ jsx("div", { className: "axis", children: subs.map((_, i) => /* @__PURE__ */ jsxs("span", { children: [
        ".",
        i * 100
      ] }, i)) }),
      /* @__PURE__ */ jsx("h3", { children: "槽内结点（按视频时间戳升序，方块内为权重）" }),
      /* @__PURE__ */ jsxs("div", { className: "chain", children: [
        /* @__PURE__ */ jsx("span", { className: "arrow", children: "head→" }),
        nodes.map((n, i) => /* @__PURE__ */ jsxs(React.Fragment, { children: [
          /* @__PURE__ */ jsx(
            "span",
            {
              className: `node${i === 0 ? " head-node" : ""}${i === nodes.length - 1 ? " tail-node" : ""}`,
              style: { background: weightColor(n.weight) },
              title: `ts=${(n.ts / 1e3).toFixed(3)}s 权重=${n.weight} ${n.text || ""}`,
              children: n.weight
            }
          ),
          /* @__PURE__ */ jsx("span", { className: "arrow", children: "⇄" })
        ] }, i)),
        count > nodes.length && /* @__PURE__ */ jsxs("span", { className: "arrow", children: [
          "… 其余 ",
          count - nodes.length,
          " 条"
        ] }),
        /* @__PURE__ */ jsx("span", { className: "arrow", children: "←tail" })
      ] }),
      /* @__PURE__ */ jsxs("p", { className: "hint", children: [
        "槽头 ts=",
        head ? (head.ts / 1e3).toFixed(3) : "-",
        "s（权重 ",
        head ? head.weight : "-",
        "） · 槽尾 ts=",
        tail ? (tail.ts / 1e3).toFixed(3) : "-",
        "s（权重 ",
        tail ? tail.weight : "-",
        "）",
        mode === "indexed" ? " · 双向循环链表：头/尾指针 + 前驱指针使插入与摘除均为 O(1)" : " · 标准单链表：定位需从头线性扫描"
      ] })
    ] })
  ] });
}
const DEFAULT_SCALES = [1e3, 3e3, 6e3, 1e4, 2e4, 4e4];
function buildEventStream({ total, rate = 300, lateRatio = 0.3, seed = 20240901 }) {
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
    fullScan: m.fullScan || 0
  };
}
async function runBenchmark({
  scales = DEFAULT_SCALES,
  rate = 300,
  lateRatio = 0.3,
  windowSec = 30,
  limitPerSec = 500,
  seed = 20240901,
  repeat = 1,
  onProgress
} = {}) {
  const cfg = { windowSec, limitPerSec };
  const rows = [];
  for (let i = 0; i < scales.length; i++) {
    const scale = scales[i];
    const groups = buildEventStream({ total: scale, rate, lateRatio, seed });
    let indexed = null;
    let single = null;
    for (let r = 0; r < repeat; r++) {
      const a = replay(groups, "indexed", cfg);
      const b = replay(groups, "single", cfg);
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
function formatBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / 1024 / 1024).toFixed(2) + " MB";
}
function Stat({ k, v, cls = "", small }) {
  return /* @__PURE__ */ jsxs("div", { className: `stat ${cls}`, children: [
    /* @__PURE__ */ jsx("div", { className: "k", children: k }),
    /* @__PURE__ */ jsx("div", { className: `v${small ? " small" : ""}`, children: v })
  ] });
}
function StatsPanel({ snap, windowSec, limit }) {
  if (!snap) return null;
  const { stats, metrics, pool, size, memoryBytes, listName, mode } = snap;
  const perInsert = stats.inserted ? metrics.compare / stats.inserted : 0;
  const degraded = stats.droppedLow + stats.replaced;
  return /* @__PURE__ */ jsxs("div", { className: "panel", children: [
    /* @__PURE__ */ jsxs("h2", { children: [
      "运行状态",
      /* @__PURE__ */ jsx("span", { className: "tag", children: listName })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "stat-grid", children: [
      /* @__PURE__ */ jsx(Stat, { k: "窗口内弹幕", v: size, cls: "accent" }),
      /* @__PURE__ */ jsx(Stat, { k: "累计接收", v: stats.received }),
      /* @__PURE__ */ jsx(Stat, { k: "成功入窗", v: stats.inserted, cls: "ok" }),
      /* @__PURE__ */ jsx(Stat, { k: "过期回收", v: stats.evicted, cls: "warn" }),
      /* @__PURE__ */ jsx(Stat, { k: "降级丢弃", v: degraded, cls: "danger" }),
      /* @__PURE__ */ jsx(Stat, { k: "其中顶替", v: stats.replaced }),
      /* @__PURE__ */ jsx(Stat, { k: "越界拒绝", v: stats.rejectExpired + stats.rejectFuture }),
      /* @__PURE__ */ jsx(Stat, { k: "关键字比较", v: metrics.compare.toLocaleString() }),
      /* @__PURE__ */ jsx(Stat, { k: "平均比较/条", v: perInsert.toFixed(1), cls: "accent" }),
      /* @__PURE__ */ jsx(Stat, { k: "指针游走步数", v: metrics.walk.toLocaleString() }),
      /* @__PURE__ */ jsx(Stat, { k: "对象池新建", v: pool.created.toLocaleString() }),
      /* @__PURE__ */ jsx(Stat, { k: "对象池复用", v: pool.reuse.toLocaleString(), cls: "ok" }),
      /* @__PURE__ */ jsx(Stat, { k: "池空闲/存活", v: `${pool.free} / ${pool.live}`, small: true }),
      /* @__PURE__ */ jsx(Stat, { k: "估算内存占用", v: formatBytes(memoryBytes), small: true }),
      /* @__PURE__ */ jsx(Stat, { k: "窗口 / 限流", v: `${windowSec}s / ${limit}`, small: true })
    ] }),
    /* @__PURE__ */ jsx("p", { className: "hint", style: { marginTop: 8 }, children: mode === "indexed" ? `索引命中：O(1) 直取前驱 ${metrics.o1Hit} 次 · 子桶内局部扫描 ${metrics.localScan} 次 · 跨秒块索引跳跃 ${metrics.indexJump} 次` : `尾指针快速路径 ${metrics.fastPath} 次 · 退化为从头全表扫描 ${metrics.fullScan} 次（单链表的固有代价）` })
  ] });
}
const FILTERS = [
  { key: "all", label: "全部" },
  { key: "recycle", label: "过期回收" },
  { key: "drop", label: "限流降级" },
  { key: "burst", label: "乱序突发" }
];
function LogConsole({ logs, flash }) {
  const [filter, setFilter] = useState("all");
  const listRef = useRef(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);
  const shown = filter === "all" ? logs : logs.filter((l) => l.type === filter || filter === "drop" && (l.type === "drop" || l.type === "replace"));
  return /* @__PURE__ */ jsxs("div", { className: "panel", children: [
    /* @__PURE__ */ jsxs("h2", { children: [
      "控制台日志",
      /* @__PURE__ */ jsx("span", { className: "tag", children: "回收 / 丢弃高亮" }),
      flash.recycle ? /* @__PURE__ */ jsx("span", { className: "flash-badge recycle", children: "已回收过期弹幕" }, flash.recycle) : null,
      flash.drop ? /* @__PURE__ */ jsx("span", { className: "flash-badge drop", children: "触发限流降级" }, flash.drop) : null
    ] }),
    /* @__PURE__ */ jsx("div", { className: "log-tools", children: FILTERS.map((f) => /* @__PURE__ */ jsx("button", { className: filter === f.key ? "active" : "", onClick: () => setFilter(f.key), children: f.label }, f.key)) }),
    /* @__PURE__ */ jsxs("div", { className: "log-list", ref: listRef, children: [
      shown.length === 0 && /* @__PURE__ */ jsx("div", { className: "hint", children: "暂无日志" }),
      shown.map((l) => /* @__PURE__ */ jsxs("div", { className: `log-item hl-${l.type}`, children: [
        /* @__PURE__ */ jsxs("span", { className: "t", children: [
          "[",
          String(l.sec).padStart(3, " "),
          "s]"
        ] }),
        /* @__PURE__ */ jsx("span", { className: "m", style: { color: (LOG_TYPES[l.type] || {}).color }, children: l.msg })
      ] }, l.id))
    ] })
  ] });
}
function LineChart({
  series = [],
  width = 420,
  height = 220,
  xLabel = "",
  yLabel = "",
  formatY = (v) => String(Math.round(v)),
  formatX = (v) => String(v)
}) {
  const padL = 54;
  const padR = 14;
  const padT = 14;
  const padB = 30;
  const iw = width - padL - padR;
  const ih = height - padT - padB;
  const all = series.flatMap((s) => s.points);
  if (!all.length) {
    return /* @__PURE__ */ jsx("div", { className: "hint", children: "暂无数据" });
  }
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys, 1e-9);
  const minY = 0;
  const sx = (x) => padL + (maxX === minX ? iw / 2 : (x - minX) / (maxX - minX) * iw);
  const sy = (y) => padT + ih - (y - minY) / (maxY - minY || 1) * ih;
  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => minY + (maxY - minY) * i / ticks);
  return /* @__PURE__ */ jsxs("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", style: { display: "block" }, children: [
    /* @__PURE__ */ jsx("rect", { x: padL, y: padT, width: iw, height: ih, fill: "rgba(255,255,255,0.015)" }),
    yTicks.map((t, i) => /* @__PURE__ */ jsxs("g", { children: [
      /* @__PURE__ */ jsx("line", { x1: padL, y1: sy(t), x2: padL + iw, y2: sy(t), stroke: "#242e46", strokeDasharray: "3 3" }),
      /* @__PURE__ */ jsx("text", { x: padL - 6, y: sy(t) + 3, textAnchor: "end", fontSize: "10", fill: "#7d879b", children: formatY(t) })
    ] }, i)),
    series[0] && series[0].points.map((p, i) => /* @__PURE__ */ jsx("text", { x: sx(p.x), y: padT + ih + 16, textAnchor: "middle", fontSize: "10", fill: "#7d879b", children: formatX(p.x) }, i)),
    series.map((s) => /* @__PURE__ */ jsxs("g", { children: [
      /* @__PURE__ */ jsx(
        "polyline",
        {
          fill: "none",
          stroke: s.color,
          strokeWidth: "2",
          strokeLinejoin: "round",
          points: s.points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")
        }
      ),
      s.points.map((p, i) => /* @__PURE__ */ jsx("circle", { cx: sx(p.x), cy: sy(p.y), r: "3", fill: s.color }, i))
    ] }, s.name)),
    /* @__PURE__ */ jsx("line", { x1: padL, y1: padT + ih, x2: padL + iw, y2: padT + ih, stroke: "#3a4560" }),
    /* @__PURE__ */ jsx("line", { x1: padL, y1: padT, x2: padL, y2: padT + ih, stroke: "#3a4560" }),
    /* @__PURE__ */ jsx("text", { x: padL + iw, y: height - 4, textAnchor: "end", fontSize: "10", fill: "#5f6b80", children: xLabel }),
    /* @__PURE__ */ jsx("text", { x: 4, y: padT + 8, fontSize: "10", fill: "#5f6b80", children: yLabel })
  ] });
}
const PRESETS = {
  fast: { label: "快速（4 档）", scales: [1e3, 3e3, 6e3, 1e4] },
  std: { label: "标准（6 档）", scales: DEFAULT_SCALES },
  hard: { label: "极限（含 8 万）", scales: [2e3, 5e3, 1e4, 2e4, 4e4, 8e4] }
};
const C_INDEX = "#6aa9ff";
const C_SINGLE = "#ff9e64";
function PerfPanel({ windowSec, limitPerSec }) {
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [preset, setPreset] = useState("std");
  const [rate, setRate] = useState(300);
  const [lateRatio, setLateRatio] = useState(0.3);
  const start = async () => {
    setRunning(true);
    setRows([]);
    setProgress(0);
    await runBenchmark({
      scales: PRESETS[preset].scales,
      rate,
      lateRatio,
      windowSec,
      limitPerSec,
      seed: 20240901,
      onProgress: (row, all, p) => {
        setRows([...all]);
        setProgress(p);
      }
    });
    setRunning(false);
    setProgress(1);
  };
  const last = rows[rows.length - 1];
  return /* @__PURE__ */ jsxs("div", { className: "panel full", children: [
    /* @__PURE__ */ jsxs("h2", { children: [
      "性能对比实验：带水平索引的双向循环链表 vs 标准单链表",
      /* @__PURE__ */ jsxs("span", { className: "tag", children: [
        "窗口 ",
        windowSec,
        "s · 单秒上限 ",
        limitPerSec,
        " · 同种子同输入序列"
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "controls", style: { marginBottom: 10 }, children: [
      /* @__PURE__ */ jsxs("div", { className: "field", children: [
        "规模档位",
        /* @__PURE__ */ jsx("select", { value: preset, onChange: (e) => setPreset(e.target.value), disabled: running, children: Object.entries(PRESETS).map(([k, v]) => /* @__PURE__ */ jsx("option", { value: k, children: v.label }, k)) })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "field", children: [
        "到达速率",
        /* @__PURE__ */ jsx(
          "input",
          {
            type: "number",
            min: 50,
            max: 2e3,
            step: 50,
            value: rate,
            onChange: (e) => setRate(Number(e.target.value)),
            disabled: running,
            style: { width: 74 }
          }
        ),
        "条/秒"
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "field", children: [
        "乱序比例",
        /* @__PURE__ */ jsx(
          "input",
          {
            type: "range",
            min: 0,
            max: 100,
            value: Math.round(lateRatio * 100),
            onChange: (e) => setLateRatio(Number(e.target.value) / 100),
            disabled: running
          }
        ),
        Math.round(lateRatio * 100),
        "%（延迟 3~5 秒到达）"
      ] }),
      /* @__PURE__ */ jsx("button", { className: "primary", onClick: start, disabled: running, children: running ? `实验中… ${Math.round(progress * 100)}%` : "开始实验" }),
      rows.length > 0 && !running && /* @__PURE__ */ jsx("button", { onClick: () => setRows([]), children: "清空结果" })
    ] }),
    rows.length > 0 && /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx("div", { className: "table-wrap", children: /* @__PURE__ */ jsxs("table", { children: [
        /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
          /* @__PURE__ */ jsx("th", { children: "数据规模（条）" }),
          /* @__PURE__ */ jsx("th", { children: "目标：耗时 ms" }),
          /* @__PURE__ */ jsx("th", { children: "基准：耗时 ms" }),
          /* @__PURE__ */ jsx("th", { children: "时间加速比" }),
          /* @__PURE__ */ jsx("th", { children: "目标：比较次数" }),
          /* @__PURE__ */ jsx("th", { children: "基准：比较次数" }),
          /* @__PURE__ */ jsx("th", { children: "比较加速比" }),
          /* @__PURE__ */ jsx("th", { children: "目标峰值结点" }),
          /* @__PURE__ */ jsx("th", { children: "基准峰值结点" }),
          /* @__PURE__ */ jsx("th", { children: "目标内存" }),
          /* @__PURE__ */ jsx("th", { children: "基准内存" })
        ] }) }),
        /* @__PURE__ */ jsx("tbody", { children: rows.map((r) => /* @__PURE__ */ jsxs("tr", { children: [
          /* @__PURE__ */ jsx("td", { children: r.scale.toLocaleString() }),
          /* @__PURE__ */ jsx("td", { style: { color: C_INDEX }, children: r.indexed.timeMs.toFixed(2) }),
          /* @__PURE__ */ jsx("td", { style: { color: C_SINGLE }, children: r.single.timeMs.toFixed(2) }),
          /* @__PURE__ */ jsx("td", { children: r.speedupTime ? `${r.speedupTime.toFixed(1)}x` : "-" }),
          /* @__PURE__ */ jsx("td", { style: { color: C_INDEX }, children: r.indexed.compare.toLocaleString() }),
          /* @__PURE__ */ jsx("td", { style: { color: C_SINGLE }, children: r.single.compare.toLocaleString() }),
          /* @__PURE__ */ jsx("td", { children: r.speedupCompare ? `${r.speedupCompare.toFixed(1)}x` : "-" }),
          /* @__PURE__ */ jsx("td", { children: r.indexed.peakLive.toLocaleString() }),
          /* @__PURE__ */ jsx("td", { children: r.single.peakLive.toLocaleString() }),
          /* @__PURE__ */ jsx("td", { children: formatBytes(r.indexed.memoryBytes) }),
          /* @__PURE__ */ jsx("td", { children: formatBytes(r.single.memoryBytes) })
        ] }, r.scale)) })
      ] }) }),
      /* @__PURE__ */ jsxs("div", { className: "charts", style: { marginTop: 12 }, children: [
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsxs("div", { className: "legend", children: [
            /* @__PURE__ */ jsxs("span", { children: [
              /* @__PURE__ */ jsx("i", { style: { background: C_INDEX } }),
              "带水平索引的双向循环链表"
            ] }),
            /* @__PURE__ */ jsxs("span", { children: [
              /* @__PURE__ */ jsx("i", { style: { background: C_SINGLE } }),
              "标准单链表"
            ] })
          ] }),
          /* @__PURE__ */ jsx(
            LineChart,
            {
              series: [
                { name: "indexed", color: C_INDEX, points: rows.map((r) => ({ x: r.scale, y: r.indexed.timeMs })) },
                { name: "single", color: C_SINGLE, points: rows.map((r) => ({ x: r.scale, y: r.single.timeMs })) }
              ],
              xLabel: "数据规模（条）",
              yLabel: "耗时 ms",
              formatY: (v) => v.toFixed(0),
              formatX: (v) => v >= 1e3 ? v / 1e3 + "k" : v
            }
          ),
          /* @__PURE__ */ jsx("p", { className: "hint", style: { textAlign: "center" }, children: "图 1 · 时间开销随数据规模变化" })
        ] }),
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsxs("div", { className: "legend", children: [
            /* @__PURE__ */ jsxs("span", { children: [
              /* @__PURE__ */ jsx("i", { style: { background: C_INDEX } }),
              "比较次数（目标）"
            ] }),
            /* @__PURE__ */ jsxs("span", { children: [
              /* @__PURE__ */ jsx("i", { style: { background: C_SINGLE } }),
              "比较次数（基准）"
            ] })
          ] }),
          /* @__PURE__ */ jsx(
            LineChart,
            {
              series: [
                { name: "indexed", color: C_INDEX, points: rows.map((r) => ({ x: r.scale, y: r.indexed.compare })) },
                { name: "single", color: C_SINGLE, points: rows.map((r) => ({ x: r.scale, y: r.single.compare })) }
              ],
              xLabel: "数据规模（条）",
              yLabel: "关键字比较次数",
              formatY: (v) => v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(0) + "k" : String(v),
              formatX: (v) => v >= 1e3 ? v / 1e3 + "k" : v
            }
          ),
          /* @__PURE__ */ jsx("p", { className: "hint", style: { textAlign: "center" }, children: "图 2 · 关键字比较次数（与硬件无关的时间复杂度证据）" })
        ] }),
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsxs("div", { className: "legend", children: [
            /* @__PURE__ */ jsxs("span", { children: [
              /* @__PURE__ */ jsx("i", { style: { background: C_INDEX } }),
              "峰值内存（目标）"
            ] }),
            /* @__PURE__ */ jsxs("span", { children: [
              /* @__PURE__ */ jsx("i", { style: { background: C_SINGLE } }),
              "峰值内存（基准）"
            ] })
          ] }),
          /* @__PURE__ */ jsx(
            LineChart,
            {
              series: [
                {
                  name: "indexed",
                  color: C_INDEX,
                  points: rows.map((r) => ({ x: r.scale, y: r.indexed.memoryBytes / 1024 }))
                },
                {
                  name: "single",
                  color: C_SINGLE,
                  points: rows.map((r) => ({ x: r.scale, y: r.single.memoryBytes / 1024 }))
                }
              ],
              xLabel: "数据规模（条）",
              yLabel: "估算内存 KB",
              formatY: (v) => v.toFixed(0),
              formatX: (v) => v >= 1e3 ? v / 1e3 + "k" : v
            }
          ),
          /* @__PURE__ */ jsx("p", { className: "hint", style: { textAlign: "center" }, children: "图 3 · 空间占用随数据规模变化" })
        ] })
      ] }),
      last && /* @__PURE__ */ jsxs("p", { className: "note", children: [
        /* @__PURE__ */ jsx("b", { children: "实验结论：" }),
        "在最大规模 ",
        last.scale.toLocaleString(),
        " 条弹幕下",
        last.speedupTime ? `，目标方法耗时 ${last.indexed.timeMs.toFixed(2)}ms，基准方法 ${last.single.timeMs.toFixed(2)}ms（时间加速比 ${last.speedupTime.toFixed(1)}x）` : "",
        last.speedupCompare ? `；关键字比较次数 ${last.indexed.compare.toLocaleString()} vs ${last.single.compare.toLocaleString()}（${last.speedupCompare.toFixed(1)}x）` : "",
        "。原因在于：标准单链表缺少有序定位索引，每次插入都要从头结点线性扫描，平均比较次数随窗口内弹幕总量 n 线性增长（O(n)）； 而带水平索引的双向循环链表通过“块 → 秒槽 → 100ms 子桶”三级索引把定位范围压缩到一个常数级时间片内， 比较次数与 n 基本无关（近似 O(1)），且双向指针让“摘除任意结点”也是 O(1)。 空间上目标方法为每个结点多付出 prev/up 指针与槽/子桶索引的少量固定开销（约 ",
        (last.memoryRatio || 1).toFixed(2),
        "x）， 属于典型的“以空间换时间”。"
      ] })
    ] }),
    rows.length === 0 && !running && /* @__PURE__ */ jsxs("p", { className: "note", children: [
      "点击「开始实验」：系统会用同一随机种子生成完全相同的弹幕到达序列（含 ",
      Math.round(lateRatio * 100),
      "% 延迟 3~5 秒的乱序弹幕）， 分别交给两种结构处理，并在多个数据规模下统计耗时、关键字比较次数、指针游走步数与峰值内存，最后绘制时空变化曲线。",
      /* @__PURE__ */ jsx("br", {}),
      /* @__PURE__ */ jsx("b", { children: "注意：" }),
      "实验在浏览器主线程同步执行，规模较大时界面会短暂无响应，属正常现象（这本身就是两种结构耗时差距的直接体现）。"
    ] })
  ] });
}
const SHOW_NODES = 26;
function App() {
  const [mode, setMode] = useState("indexed");
  const [windowSec, setWindowSec] = useState(30);
  const [limitPerSec, setLimitPerSec] = useState(500);
  const [scenarioKey, setScenarioKey] = useState("mixed");
  const [speed, setSpeed] = useState(1);
  const [running, setRunning] = useState(false);
  const [flying, setFlying] = useState([]);
  const [selectedSec, setSelectedSec] = useState(null);
  const engineRef = useRef(null);
  const emitterRef = useRef(null);
  const flyKey = useRef(0);
  const scenarioRef = useRef(scenarioKey);
  scenarioRef.current = scenarioKey;
  const bootstrap = useCallback(() => {
    const engine = new DanmakuEngine({ mode, windowSec, limitPerSec });
    const emitter = new Emitter(engine, { seed: 20240901, scenario: SCENARIOS[scenarioRef.current] });
    engineRef.current = engine;
    emitterRef.current = emitter;
    return engine.snapshot(SHOW_NODES);
  }, [mode, windowSec, limitPerSec]);
  const [snap, setSnap] = useState(bootstrap);
  const rebuild = useCallback(() => {
    setFlying([]);
    setSelectedSec(null);
    setSnap(bootstrap());
  }, [bootstrap]);
  useEffect(() => {
    rebuild();
  }, [rebuild]);
  useEffect(() => {
    if (emitterRef.current) emitterRef.current.setScenario(SCENARIOS[scenarioKey]);
  }, [scenarioKey]);
  const pushFlying = useCallback((list) => {
    if (!list.length) return;
    const items = [];
    const step = Math.max(1, Math.ceil(list.length / 26));
    for (let i = 0; i < list.length; i += step) {
      const d = list[i];
      flyKey.current += 1;
      items.push({
        key: flyKey.current,
        text: d.text,
        color: d.color,
        lane: flyKey.current,
        dur: 4 + Math.random() * 2.5,
        ts: d.ts,
        weight: d.weight,
        late: d.late
      });
    }
    setFlying((prev) => [...prev, ...items].slice(-90));
  }, []);
  const refresh = useCallback(() => {
    const engine = engineRef.current;
    if (engine) setSnap(engine.snapshot(SHOW_NODES));
  }, []);
  const doStep = useCallback(() => {
    const engine = engineRef.current;
    const emitter = emitterRef.current;
    if (!engine || !emitter) return;
    const { batch, results } = emitter.step();
    const accepted = [];
    for (let i = 0; i < results.length; i++) if (results[i].ok) accepted.push(batch[i]);
    pushFlying(accepted);
    refresh();
  }, [pushFlying, refresh]);
  const inject = useCallback(
    (kind) => {
      const engine = engineRef.current;
      const emitter = emitterRef.current;
      if (!engine || !emitter) return;
      const { batch, results } = kind === "late" ? emitter.injectLateBurst(700) : emitter.injectFlood(1300);
      const accepted = [];
      for (let i = 0; i < results.length; i++) if (results[i].ok) accepted.push(batch[i]);
      pushFlying(accepted);
      refresh();
    },
    [pushFlying, refresh]
  );
  useEffect(() => {
    if (!running) return void 0;
    const id = setInterval(doStep, Math.max(80, Math.round(1e3 / speed)));
    return () => clearInterval(id);
  }, [running, speed, doStep]);
  const onFlyEnd = useCallback((key) => {
    setFlying((prev) => prev.filter((d) => d.key !== key));
  }, []);
  const selected = selectedSec != null && snap && snap.window.some((w) => w.sec === selectedSec) ? selectedSec : snap == null ? void 0 : snap.nowSec;
  const slot = snap ? snap.window.find((w) => w.sec === selected) : null;
  const droppedTotal = snap ? snap.stats.droppedLow + snap.stats.replaced : 0;
  return /* @__PURE__ */ jsxs("div", { className: "app", children: [
    /* @__PURE__ */ jsxs("header", { className: "header", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("h1", { children: "互联网视频直播高并发弹幕时间轴对齐缓存" }),
        /* @__PURE__ */ jsx("div", { className: "sub", children: "题目 0 · 手工实现「带水平索引的双向循环链表 + 固定对象池」对乱序弹幕做原地插入排序、滑动窗口切除回收与权重限流降级" })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "timeline", children: [
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsxs("div", { className: "clock", children: [
            snap ? snap.nowSec : 0,
            "s"
          ] }),
          /* @__PURE__ */ jsx("div", { className: "win", children: "视频时间轴" })
        ] }),
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsxs("div", { style: { fontSize: 16, fontWeight: 600 }, children: [
            "[",
            snap ? snap.windowStart : 0,
            "s , ",
            snap ? snap.windowEnd : 0,
            "s]"
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "win", children: [
            "滑动窗口（",
            windowSec,
            " 秒）"
          ] })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "panel", style: { marginBottom: 14 }, children: [
      /* @__PURE__ */ jsxs("div", { className: "controls", children: [
        /* @__PURE__ */ jsx("button", { className: running ? "danger" : "primary", onClick: () => setRunning((v) => !v), children: running ? "暂停" : "开始" }),
        /* @__PURE__ */ jsx("button", { onClick: doStep, disabled: running, children: "单步（+1s）" }),
        /* @__PURE__ */ jsx("button", { onClick: rebuild, children: "重置" }),
        /* @__PURE__ */ jsxs("div", { className: "field", children: [
          "结构",
          /* @__PURE__ */ jsxs("div", { className: "seg", children: [
            /* @__PURE__ */ jsx("button", { className: mode === "indexed" ? "active" : "", onClick: () => setMode("indexed"), children: "带水平索引的双向循环链表" }),
            /* @__PURE__ */ jsx("button", { className: mode === "single" ? "active" : "", onClick: () => setMode("single"), children: "标准单链表（基准）" })
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "field", children: [
          "场景",
          /* @__PURE__ */ jsx("select", { value: scenarioKey, onChange: (e) => setScenarioKey(e.target.value), children: Object.values(SCENARIOS).map((s) => /* @__PURE__ */ jsx("option", { value: s.key, children: s.label }, s.key)) })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "field", children: [
          "速度",
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "range",
              min: 1,
              max: 8,
              step: 1,
              value: speed,
              onChange: (e) => setSpeed(Number(e.target.value))
            }
          ),
          speed,
          " 秒/秒"
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "field", children: [
          "窗口",
          /* @__PURE__ */ jsxs("select", { value: windowSec, onChange: (e) => setWindowSec(Number(e.target.value)), children: [
            /* @__PURE__ */ jsx("option", { value: 15, children: "15s" }),
            /* @__PURE__ */ jsx("option", { value: 30, children: "30s" }),
            /* @__PURE__ */ jsx("option", { value: 60, children: "60s" })
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "field", children: [
          "单秒上限",
          /* @__PURE__ */ jsxs("select", { value: limitPerSec, onChange: (e) => setLimitPerSec(Number(e.target.value)), children: [
            /* @__PURE__ */ jsx("option", { value: 200, children: "200" }),
            /* @__PURE__ */ jsx("option", { value: 500, children: "500" }),
            /* @__PURE__ */ jsx("option", { value: 1e3, children: "1000" })
          ] })
        ] }),
        /* @__PURE__ */ jsx("button", { onClick: () => inject("late"), children: "注入老弹幕突发（延迟 3~5s）" }),
        /* @__PURE__ */ jsx("button", { onClick: () => inject("flood"), children: "注入流量洪峰（触发限流）" })
      ] }),
      /* @__PURE__ */ jsx("p", { className: "hint", style: { marginTop: 8 }, children: SCENARIOS[scenarioKey].desc })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "grid", children: [
      /* @__PURE__ */ jsxs("div", { className: "col", children: [
        /* @__PURE__ */ jsxs("div", { className: "panel", children: [
          /* @__PURE__ */ jsxs("h2", { children: [
            "直播画面 · 弹幕飘过",
            /* @__PURE__ */ jsx("span", { className: "tag", children: "下划线虚线 = 延迟到达的老弹幕" })
          ] }),
          /* @__PURE__ */ jsx(
            DanmakuStage,
            {
              items: flying,
              nowSec: snap ? snap.nowSec : 0,
              windowStart: snap ? snap.windowStart : 0,
              windowEnd: snap ? snap.windowEnd : 0,
              onEnd: onFlyEnd
            }
          )
        ] }),
        snap && /* @__PURE__ */ jsx(
          DensityPanel,
          {
            window: snap.window,
            limit: limitPerSec,
            nowSec: snap.nowSec,
            selected,
            onSelect: setSelectedSec,
            droppedTotal
          }
        ),
        /* @__PURE__ */ jsx(StructurePanel, { slot, mode, limit: limitPerSec, nowSec: snap ? snap.nowSec : 0 })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "col", children: [
        /* @__PURE__ */ jsx(StatsPanel, { snap, windowSec, limit: limitPerSec }),
        /* @__PURE__ */ jsx(LogConsole, { logs: snap ? snap.logs : [], flash: snap ? snap.flash : {} })
      ] })
    ] }),
    /* @__PURE__ */ jsx(PerfPanel, { windowSec, limitPerSec })
  ] });
}
const html = renderToString(/* @__PURE__ */ jsx(App, {}));
const must = ["互联网视频直播高并发弹幕时间轴对齐缓存", "滑动窗口时间槽密度", "控制台日志", "性能对比实验"];
let bad = 0;
for (const m of must) {
  if (!html.includes(m)) {
    console.error("缺少内容：", m);
    bad++;
  }
}
console.log("SSR 渲染长度 =", html.length, bad === 0 ? "· 冒烟通过" : `· ${bad} 项缺失`);
process.exit(bad === 0 ? 0 : 1);
