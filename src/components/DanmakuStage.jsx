import React from 'react';

const LANES = 9;

/**
 * 弹幕飘过效果：每条成功入窗的弹幕都会从右向左飘过直播画面。
 * late 样式（下划虚线）用于区分“延迟 3~5 秒才到达的老弹幕”。
 */
export default function DanmakuStage({ items, nowSec, windowStart, windowEnd, onEnd }) {
  return (
    <div className="stage">
      <div className="grid-bg" />
      <div className="video-info">
        视频时间轴 {nowSec}s · 滑动窗口 [{windowStart}s, {windowEnd}s] · 弹幕按视频时间戳对齐播放
      </div>
      {items.length === 0 && <div className="stage-empty">点击「开始」后弹幕将从右向左飘过</div>}
      {items.map((d) => (
        <span
          key={d.key}
          className={`danmaku${d.late ? ' late' : ''}`}
          style={{
            top: 30 + (d.lane % LANES) * 25,
            color: d.color,
            animationDuration: `${d.dur}s`,
          }}
          onAnimationEnd={() => onEnd(d.key)}
          title={`ts=${(d.ts / 1000).toFixed(2)}s 权重=${d.weight}${d.late ? '（延迟到达）' : ''}`}
        >
          {d.text}
        </span>
      ))}
    </div>
  );
}
