/**
 * 固定对象池 ObjectPool（纯手工实现）
 *
 * 设计要点：
 *  1. 空闲结点不丢弃，而是通过结点自身的 nextFree 指针串成一条
 *     “空闲单链表”（freeHead 为链头），因此池本身不占用任何额外的
 *     容器结构，申请 / 归还均为 O(1)，且零 GC 压力。
 *  2. 池只负责“结点的生与死”，不负责结点语义，reset 回调用于归还时
 *     断开所有引用（防止悬挂指针）。
 *  3. 统计 created / live / peakLive / reuseCount，供空间复杂度实验使用。
 */
export class ObjectPool {
  constructor(name, factory, reset) {
    this.name = name;
    this.factory = factory;
    this.reset = reset;
    this.freeHead = null; // 空闲链头
    this.freeCount = 0; // 空闲结点数
    this.created = 0; // 累计新建结点数
    this.live = 0; // 当前在链表中存活的结点数
    this.peakLive = 0; // 存活峰值（空间复杂度指标）
    this.reuseCount = 0; // 复用次数
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
      reuse: this.reuseCount,
    };
  }
}
