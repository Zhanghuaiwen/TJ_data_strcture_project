import React from 'react';

function weightColor(w) {
  if (w >= 8) return '#ff7b72';
  if (w >= 5) return '#ffb86c';
  if (w >= 3) return '#7dcfff';
  return '#8b95a7';
}

/**
 * 选中时间槽的链表局部结构：
 *  · 100ms 子桶索引分布（目标方法的第三级索引；基准方法不维护该层，显示为 —）
 *  · 槽内结点链（方块颜色深浅表示权重，绿框=槽头，金框=槽尾）
 */
export default function StructurePanel({ slot, mode, limit, nowSec }) {
  if (!slot) return null;
  const { sec, count, head, tail, nodes = [], subs = [], dropped } = slot;
  const hasSubs = subs.length > 0 && subs[0] >= 0;

  return (
    <div className="panel">
      <h2>
        第 {sec}s 时间槽的链表结构
        <span className="tag">{count} 条 / 上限 {limit}</span>
        {sec === nowSec && <span className="tag">当前秒</span>}
        {dropped > 0 && <span className="tag" style={{ color: 'var(--danger)' }}>本槽已降级 {dropped} 条</span>}
      </h2>

      {count === 0 ? (
        <p className="hint">该秒没有弹幕（空槽：仅占位，不占用任何结点）。</p>
      ) : (
        <>
          <h3>100ms 子桶索引（{hasSubs ? '目标方法维护' : '标准单链表不维护该层'}）</h3>
          <div className="subs">
            {(hasSubs ? subs : new Array(10).fill(-1)).map((c, i) => (
              <div key={i} className={`sub-cell${c > 0 ? ' has' : ''}`} title={`${sec}.${i}s~${sec}.${i + 1}s：${c < 0 ? '无索引' : c + ' 条'}`}>
                {c < 0 ? '—' : c}
              </div>
            ))}
          </div>
          <div className="axis">
            {subs.map((_, i) => (
              <span key={i}>.{i * 100}</span>
            ))}
          </div>

          <h3>槽内结点（按视频时间戳升序，方块内为权重）</h3>
          <div className="chain">
            <span className="arrow">head→</span>
            {nodes.map((n, i) => (
              <React.Fragment key={i}>
                <span
                  className={`node${i === 0 ? ' head-node' : ''}${i === nodes.length - 1 ? ' tail-node' : ''}`}
                  style={{ background: weightColor(n.weight) }}
                  title={`ts=${(n.ts / 1000).toFixed(3)}s 权重=${n.weight} ${n.text || ''}`}
                >
                  {n.weight}
                </span>
                <span className="arrow">⇄</span>
              </React.Fragment>
            ))}
            {count > nodes.length && <span className="arrow">… 其余 {count - nodes.length} 条</span>}
            <span className="arrow">←tail</span>
          </div>
          <p className="hint">
            槽头 ts={head ? (head.ts / 1000).toFixed(3) : '-'}s（权重 {head ? head.weight : '-'}） · 槽尾 ts=
            {tail ? (tail.ts / 1000).toFixed(3) : '-'}s（权重 {tail ? tail.weight : '-'}）
            {mode === 'indexed' ? ' · 双向循环链表：头/尾指针 + 前驱指针使插入与摘除均为 O(1)' : ' · 标准单链表：定位需从头线性扫描'}
          </p>
        </>
      )}
    </div>
  );
}
