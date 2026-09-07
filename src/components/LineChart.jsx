import React from 'react';

/**
 * 手写 SVG 折线图（不依赖任何图表库）
 * @param series [{ name, color, points: [{x, y}] }]
 */
export default function LineChart({
  series = [],
  width = 420,
  height = 220,
  xLabel = '',
  yLabel = '',
  formatY = (v) => String(Math.round(v)),
  formatX = (v) => String(v),
}) {
  const padL = 54;
  const padR = 14;
  const padT = 14;
  const padB = 30;
  const iw = width - padL - padR;
  const ih = height - padT - padB;

  const all = series.flatMap((s) => s.points);
  if (!all.length) {
    return <div className="hint">暂无数据</div>;
  }
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys, 1e-9);
  const minY = 0;

  const sx = (x) => padL + (maxX === minX ? iw / 2 : ((x - minX) / (maxX - minX)) * iw);
  const sy = (y) => padT + ih - ((y - minY) / (maxY - minY || 1)) * ih;

  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => minY + ((maxY - minY) * i) / ticks);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ display: 'block' }}>
      <rect x={padL} y={padT} width={iw} height={ih} fill="rgba(255,255,255,0.015)" />
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={padL} y1={sy(t)} x2={padL + iw} y2={sy(t)} stroke="#242e46" strokeDasharray="3 3" />
          <text x={padL - 6} y={sy(t) + 3} textAnchor="end" fontSize="10" fill="#7d879b">
            {formatY(t)}
          </text>
        </g>
      ))}
      {series[0] &&
        series[0].points.map((p, i) => (
          <text key={i} x={sx(p.x)} y={padT + ih + 16} textAnchor="middle" fontSize="10" fill="#7d879b">
            {formatX(p.x)}
          </text>
        ))}
      {series.map((s) => (
        <g key={s.name}>
          <polyline
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeLinejoin="round"
            points={s.points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')}
          />
          {s.points.map((p, i) => (
            <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r="3" fill={s.color} />
          ))}
        </g>
      ))}
      <line x1={padL} y1={padT + ih} x2={padL + iw} y2={padT + ih} stroke="#3a4560" />
      <line x1={padL} y1={padT} x2={padL} y2={padT + ih} stroke="#3a4560" />
      <text x={padL + iw} y={height - 4} textAnchor="end" fontSize="10" fill="#5f6b80">
        {xLabel}
      </text>
      <text x={4} y={padT + 8} fontSize="10" fill="#5f6b80">
        {yLabel}
      </text>
    </svg>
  );
}
