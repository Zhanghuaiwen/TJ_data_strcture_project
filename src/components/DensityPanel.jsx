import React from 'react';

/** 密度 → 颜色深浅（蓝 → 黄 → 红） */
function colorOf(ratio) {
  const r = Math.max(0, Math.min(1, ratio));
  const hue = 210 - 210 * Math.pow(r, 0.7);
  const light = 26 + 30 * r;
  const sat = 45 + 40 * r;
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

/**
 * 滑动窗口“时间槽密度”面板：
 *  · 柱状图高度 = 该秒弹幕条数，颜色深浅 = 密度相对限流阈值的比例；
 *  · 虚线为单秒上限，触顶的槽显示为红色并标记“限流”；
 *  · 下方条带为窗口整体结构（每一秒一个槽位，显示条数与秒号）。
 */
export default function DensityPanel({ window: win, limit, nowSec, selected, onSelect, droppedTotal }) {
  const max = Math.max(limit, ...win.map((w) => w.count));
  return (
    <div className="panel">
      <h2>
        滑动窗口时间槽密度
        <span className="tag">共 {win.length} 个时间槽 · 单秒上限 {limit}</span>
        {droppedTotal > 0 && <span className="tag" style={{ color: 'var(--danger)' }}>累计降级 {droppedTotal}</span>}
      </h2>
      <div className="density">
        <div
          className="limit-line"
          style={{ bottom: `${(limit / max) * 100}%` }}
          title={`单秒上限 ${limit}`}
        />
        {win.map((w) => {
          const ratio = w.count / limit;
          return (
            <div
              key={w.sec}
              className={`bar-wrap${w.sec === selected ? ' selected' : ''}`}
              onClick={() => onSelect(w.sec)}
              title={`第 ${w.sec}s：${w.count} 条${w.dropped ? `，已降级 ${w.dropped} 条` : ''}`}
            >
              <div
                className="bar"
                style={{
                  height: `${(w.count / max) * 100}%`,
                  background: colorOf(ratio),
                }}
              />
            </div>
          );
        })}
        <span className="limit-tag" style={{ bottom: `calc(${(limit / max) * 100}% + 2px)` }}>
          上限 {limit}
        </span>
      </div>
      <div className="axis">
        {win.map((w, i) => (
          <span key={w.sec} style={{ color: w.sec === nowSec ? 'var(--accent)' : undefined }}>
            {i % 3 === 0 || w.sec === nowSec ? w.sec : ''}
          </span>
        ))}
      </div>

      <h3>窗口整体结构（每格 = 1 秒时间槽，数字为该槽弹幕条数）</h3>
      <div className="slots-strip">
        {win.map((w) => (
          <div
            key={w.sec}
            className={`slot-cell${w.count > 0 ? ' has' : ''}${w.sec === nowSec ? ' now' : ''}`}
            style={w.count > 0 ? { background: colorOf(w.count / limit) } : undefined}
            onClick={() => onSelect(w.sec)}
            title={`第 ${w.sec}s：${w.count} 条`}
          >
            {w.count > 0 ? w.count : '·'}
          </div>
        ))}
      </div>
      <div className="axis">
        {win.map((w, i) => (
          <span key={w.sec}>{i % 5 === 0 ? w.sec : ''}</span>
        ))}
      </div>
      <p className="hint">
        提示：点击任意时间槽可查看该秒的链表局部结构（头/尾结点、100ms 子桶分布、结点权重）。
      </p>
    </div>
  );
}
