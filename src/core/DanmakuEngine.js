import { IndexedCircularList } from './IndexedCircularList.js';
import { SinglyLinkedList } from './SinglyLinkedList.js';
import { secOf } from './HorizontalIndex.js';

export const LOG_TYPES = {
  info: { label: '信息', color: '#7aa2f7' },
  phase: { label: '场景', color: '#9ece6a' },
  recycle: { label: '过期回收', color: '#e0af68' },
  drop: { label: '限流丢弃', color: '#f7768e' },
  replace: { label: '降级顶替', color: '#ff9e64' },
  reject: { label: '越界拒绝', color: '#bb9af7' },
  burst: { label: '乱序突发', color: '#2ac3de' },
};

/**
 * 弹幕时间轴对齐缓存引擎
 *
 * 职责：
 *   1. 维护视频时间轴（nowSec，每秒推进 1 秒）与滑动窗口 [nowSec-W+1, nowSec]；
 *   2. 收弹幕 → 按视频时间戳做“原地插入排序”落到正确位置；
 *   3. 窗口滑动 → 切除并回收过期结点（归还对象池，非 GC）；
 *   4. 单秒密度超阈值 → 基于权重的降级丢弃（先淘汰槽内最低权重者，仍不达标则丢弃新弹幕）。
 *
 * 底层结构由 mode 决定：indexed（带水平索引的双向循环链表）/ single（标准单链表）。
 */
export class DanmakuEngine {
  constructor(cfg = {}) {
    this.cfg = {
      windowSec: 30,
      limitPerSec: 500,
      slotCapacity: 128, // 环形槽数组长度（需 ≥ 窗口秒数，取 2 的幂）
      logCapacity: 400,
      mode: 'indexed',
      ...cfg,
    };
    this.list = null;
    this.setMode(this.cfg.mode);
    this.reset();
  }

  setMode(mode) {
    this.cfg.mode = mode;
    this.mode = mode;
    this.list =
      mode === 'single'
        ? new SinglyLinkedList({
            windowSec: this.cfg.windowSec,
            limitPerSec: this.cfg.limitPerSec,
            slotCapacity: this.cfg.slotCapacity,
          })
        : new IndexedCircularList({
            windowSec: this.cfg.windowSec,
            limitPerSec: this.cfg.limitPerSec,
            slotCapacity: this.cfg.slotCapacity,
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
      droppedLow: 0, // 权重过低被直接丢弃
      replaced: 0, // 顶替掉槽内低权重旧弹幕
      evicted: 0, // 窗口滑动回收
      rejectExpired: 0, // 到达即已过期
      rejectFuture: 0, // 时间戳超前
    };
    this._log('info', `引擎就绪：${this.list.name}，窗口 ${this.cfg.windowSec}s，单秒上限 ${this.cfg.limitPerSec} 条`);
  }

  get windowStart() {
    return this.nowSec - this.cfg.windowSec + 1;
  }

  get windowEnd() {
    return this.nowSec;
  }

  _log(type, msg, extra) {
    if (this.cfg.silent) return; // 压测模式：关闭日志，避免日志干扰计时
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
      this._log('recycle', `窗口滑动至 [${this.windowStart}s, ${this.windowEnd}s]，切除并回收 ${n} 条过期弹幕`, {
        count: n,
      });
      this._flash('recycle');
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
      this._log('reject', `弹幕时间戳 ${(d.ts / 1000).toFixed(2)}s 超前于当前时间轴 ${this.nowSec}s，拒绝入窗`);
      return { ok: false, reason: 'future' };
    }
    if (sec < this.windowStart) {
      st.rejectExpired++;
      this._log('reject', `弹幕时间戳 ${(d.ts / 1000).toFixed(2)}s 已滑出窗口 [${this.windowStart}s, ${this.windowEnd}s]，拒绝入窗`);
      return { ok: false, reason: 'expired' };
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
        // 降级策略：高权重弹幕顶替槽内权重最低者
        const info = { ts: victim.node.ts, weight: victim.node.weight, text: victim.node.text };
        this.list.removeNode(victim.node, victim.prev);
        this.list.releaseNode(victim.node);
        st.replaced++;
        this.list.index.markDrop(sec, true);
        this._log(
          'replace',
          `第 ${sec}s 达上限 ${cfg.limitPerSec}：新弹幕(权重${d.weight}) 顶替 旧弹幕(权重${info.weight})「${info.text}」`,
          { weight: d.weight },
        );
        this._flash('drop');
      } else {
        // 新弹幕权重不占优：直接丢弃，槽内容不变
        this.list.releaseNode(node);
        st.droppedLow++;
        this.list.index.markDrop(sec, false);
        this._log('drop', `第 ${sec}s 达上限 ${cfg.limitPerSec}：新弹幕权重 ${d.weight} 不占优，降级丢弃`, {
          weight: d.weight,
        });
        this._flash('drop');
        return { ok: false, reason: 'limit' };
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
      logs: this.logs.slice(-120),
    };
  }
}
