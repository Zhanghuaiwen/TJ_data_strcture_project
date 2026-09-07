import React from 'react';
import { formatBytes } from '../core/benchmark.js';

function Stat({ k, v, cls = '', small }) {
  return (
    <div className={`stat ${cls}`}>
      <div className="k">{k}</div>
      <div className={`v${small ? ' small' : ''}`}>{v}</div>
    </div>
  );
}

export default function StatsPanel({ snap, windowSec, limit }) {
  if (!snap) return null;
  const { stats, metrics, pool, size, memoryBytes, listName, mode } = snap;
  const perInsert = stats.inserted ? metrics.compare / stats.inserted : 0;
  const degraded = stats.droppedLow + stats.replaced;

  return (
    <div className="panel">
      <h2>
        运行状态
        <span className="tag">{listName}</span>
      </h2>
      <div className="stat-grid">
        <Stat k="窗口内弹幕" v={size} cls="accent" />
        <Stat k="累计接收" v={stats.received} />
        <Stat k="成功入窗" v={stats.inserted} cls="ok" />
        <Stat k="过期回收" v={stats.evicted} cls="warn" />
        <Stat k="降级丢弃" v={degraded} cls="danger" />
        <Stat k="其中顶替" v={stats.replaced} />
        <Stat k="越界拒绝" v={stats.rejectExpired + stats.rejectFuture} />
        <Stat k="关键字比较" v={metrics.compare.toLocaleString()} />
        <Stat k="平均比较/条" v={perInsert.toFixed(1)} cls="accent" />
        <Stat k="指针游走步数" v={metrics.walk.toLocaleString()} />
        <Stat k="对象池新建" v={pool.created.toLocaleString()} />
        <Stat k="对象池复用" v={pool.reuse.toLocaleString()} cls="ok" />
        <Stat k="池空闲/存活" v={`${pool.free} / ${pool.live}`} small />
        <Stat k="估算内存占用" v={formatBytes(memoryBytes)} small />
        <Stat k="窗口 / 限流" v={`${windowSec}s / ${limit}`} small />
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        {mode === 'indexed'
          ? `索引命中：O(1) 直取前驱 ${metrics.o1Hit} 次 · 子桶内局部扫描 ${metrics.localScan} 次 · 跨秒块索引跳跃 ${metrics.indexJump} 次`
          : `尾指针快速路径 ${metrics.fastPath} 次 · 退化为从头全表扫描 ${metrics.fullScan} 次（单链表的固有代价）`}
      </p>
    </div>
  );
}
