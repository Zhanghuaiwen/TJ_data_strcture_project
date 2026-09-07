/**
 * 水平索引层 HorizontalIndex —— 纯手工实现的三级时间索引（不使用任何内置集合容器）
 *
 *   ┌─────────────── 二级：块索引 BLOCK（每 8 秒一块，用于整块跳过空窗期）───────────────┐
 *   │   ┌─────────── 一级：秒级槽索引 SLOT（每 1 秒一槽，O(1) 直接寻址）───────────────┐ │
 *   │   │  ┌──────── 零级：100ms 子桶（槽内局部索引，把槽内扫描再降一个数量级）───────┐ │ │
 *   │   │  │                                                                        │ │ │
 *   ▼   ▼  ▼        底层：按 (ts, seq) 有序的双向循环链表 / 标准单链表                  ▼ ▼ ▼
 *
 * 物理结构：两个定长环形数组（slots / blocks）——滑动窗口内的秒值连续，
 * 下标 = sec & mask 即可无冲突覆盖整个窗口，旧槽随窗口滑动被原地覆盖复用，
 * 无需任何动态扩容与 rehash，寻址严格 O(1)，且天然具备“自动释放过期槽”的能力。
 *
 * 每个槽 / 子桶只维护 3 个量：count（密度统计）、head、tail（该时间片在底层链表中
 * 的首尾结点指针）。有了 head / tail：
 *   · 插入时若新结点 >= 槽 tail        → 前驱就是 tail，O(1) 定位；
 *   · 插入时若新结点 <  槽 head        → 双向链表可直接取 head.prev，O(1) 定位；
 *   · 否则只在 head..tail 之间做局部扫描（长度 ≤ 限流阈值，与总规模无关）；
 *   · 窗口过期时可按槽整段摘除并回收，无需逐点判断时间戳。
 */
export const SUB_COUNT = 10; // 每秒切 10 个子桶（每 100ms 一个）

export function secOf(ts) {
  return Math.floor(ts / 1000);
}

export function subOf(ts) {
  const s = Math.floor(ts / 1000);
  const ms = ts - s * 1000;
  const k = Math.floor(ms / (1000 / SUB_COUNT));
  return k >= SUB_COUNT ? SUB_COUNT - 1 : k;
}

function sameSec(ts, sec) {
  return Math.floor(ts / 1000) === sec;
}

export class HorizontalIndex {
  constructor({ slotCapacity = 64, blockBits = 3, blockCapacity = 16, useSubs = true } = {}) {
    // useSubs=false 表示基准结构（标准单链表）只维护秒级槽，不维护 100ms 子桶
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
      dropped: 0, // 因权重过低被直接丢弃
      replaced: 0, // 因权重更高而被顶替掉的旧弹幕
      minWeight: Infinity, // 槽内最小权重缓存（限流降级用）
      minNode: null,
      subs: new Array(SUB_COUNT),
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

    // 槽内最小权重缓存：仅在缓存有效（minNode 非空）且新结点更小时更新。
    // 一旦缓存被失效（删除的正好是最小者），必须留空，由查询方重新扫描得到真正的最小值，
    // 否则会把“刚插入的结点”误当成最小值，导致降级策略失效。
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
    let b = (sec - 1) >> this.blockBits;
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
        nodes: [],
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
