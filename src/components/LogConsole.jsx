import React, { useEffect, useRef, useState } from 'react';
import { LOG_TYPES } from '../core/DanmakuEngine.js';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'recycle', label: '过期回收' },
  { key: 'drop', label: '限流降级' },
  { key: 'burst', label: '乱序突发' },
];

/**
 * 控制台日志面板：过期回收与限流丢弃会高亮并触发闪烁提示
 */
export default function LogConsole({ logs, flash }) {
  const [filter, setFilter] = useState('all');
  const listRef = useRef(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const shown =
    filter === 'all'
      ? logs
      : logs.filter((l) => l.type === filter || (filter === 'drop' && (l.type === 'drop' || l.type === 'replace')));

  return (
    <div className="panel">
      <h2>
        控制台日志
        <span className="tag">回收 / 丢弃高亮</span>
        {flash.recycle ? (
          <span key={flash.recycle} className="flash-badge recycle">
            已回收过期弹幕
          </span>
        ) : null}
        {flash.drop ? (
          <span key={flash.drop} className="flash-badge drop">
            触发限流降级
          </span>
        ) : null}
      </h2>
      <div className="log-tools">
        {FILTERS.map((f) => (
          <button key={f.key} className={filter === f.key ? 'active' : ''} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="log-list" ref={listRef}>
        {shown.length === 0 && <div className="hint">暂无日志</div>}
        {shown.map((l) => (
          <div key={l.id} className={`log-item hl-${l.type}`}>
            <span className="t">[{String(l.sec).padStart(3, ' ')}s]</span>
            <span className="m" style={{ color: (LOG_TYPES[l.type] || {}).color }}>
              {l.msg}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
