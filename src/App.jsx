import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DanmakuEngine } from './core/DanmakuEngine.js';
import { Emitter, SCENARIOS } from './core/emitter.js';
import DanmakuStage from './components/DanmakuStage.jsx';
import DensityPanel from './components/DensityPanel.jsx';
import StructurePanel from './components/StructurePanel.jsx';
import StatsPanel from './components/StatsPanel.jsx';
import LogConsole from './components/LogConsole.jsx';
import PerfPanel from './components/PerfPanel.jsx';

const SHOW_NODES = 26; // 每个时间槽最多展示的结点数（避免 DOM 爆炸）

export default function App() {
  const [mode, setMode] = useState('indexed');
  const [windowSec, setWindowSec] = useState(30);
  const [limitPerSec, setLimitPerSec] = useState(500);
  const [scenarioKey, setScenarioKey] = useState('mixed');
  const [speed, setSpeed] = useState(1);
  const [running, setRunning] = useState(false);
  const [flying, setFlying] = useState([]);
  const [selectedSec, setSelectedSec] = useState(null);

  const engineRef = useRef(null);
  const emitterRef = useRef(null);
  const flyKey = useRef(0);
  const scenarioRef = useRef(scenarioKey);
  scenarioRef.current = scenarioKey;

  /* ---------------- 引擎生命周期 ---------------- */
  const bootstrap = useCallback(() => {
    const engine = new DanmakuEngine({ mode, windowSec, limitPerSec });
    const emitter = new Emitter(engine, { seed: 20240901, scenario: SCENARIOS[scenarioRef.current] });
    engineRef.current = engine;
    emitterRef.current = emitter;
    return engine.snapshot(SHOW_NODES);
  }, [mode, windowSec, limitPerSec]);

  // 首次渲染即有数据（useState 惰性初始化）
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

  /* ---------------- 弹幕上屏 ---------------- */
  const pushFlying = useCallback((list) => {
    if (!list.length) return;
    const items = [];
    const step = Math.max(1, Math.ceil(list.length / 26)); // 采样，避免 DOM 过多
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
        late: d.late,
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
      const { batch, results } = kind === 'late' ? emitter.injectLateBurst(700) : emitter.injectFlood(1300);
      const accepted = [];
      for (let i = 0; i < results.length; i++) if (results[i].ok) accepted.push(batch[i]);
      pushFlying(accepted);
      refresh();
    },
    [pushFlying, refresh],
  );

  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(doStep, Math.max(80, Math.round(1000 / speed)));
    return () => clearInterval(id);
  }, [running, speed, doStep]);

  const onFlyEnd = useCallback((key) => {
    setFlying((prev) => prev.filter((d) => d.key !== key));
  }, []);

  /* ---------------- 派生数据 ---------------- */
  const selected =
    selectedSec != null && snap && snap.window.some((w) => w.sec === selectedSec) ? selectedSec : snap?.nowSec;
  const slot = snap ? snap.window.find((w) => w.sec === selected) : null;
  const droppedTotal = snap ? snap.stats.droppedLow + snap.stats.replaced : 0;

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>互联网视频直播高并发弹幕时间轴对齐缓存</h1>
          <div className="sub">
            题目 0 · 手工实现「带水平索引的双向循环链表 + 固定对象池」对乱序弹幕做原地插入排序、滑动窗口切除回收与权重限流降级
          </div>
        </div>
        <div className="timeline">
          <div>
            <div className="clock">{snap ? snap.nowSec : 0}s</div>
            <div className="win">视频时间轴</div>
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>
              [{snap ? snap.windowStart : 0}s , {snap ? snap.windowEnd : 0}s]
            </div>
            <div className="win">滑动窗口（{windowSec} 秒）</div>
          </div>
        </div>
      </header>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="controls">
          <button className={running ? 'danger' : 'primary'} onClick={() => setRunning((v) => !v)}>
            {running ? '暂停' : '开始'}
          </button>
          <button onClick={doStep} disabled={running}>
            单步（+1s）
          </button>
          <button onClick={rebuild}>重置</button>

          <div className="field">
            结构
            <div className="seg">
              <button className={mode === 'indexed' ? 'active' : ''} onClick={() => setMode('indexed')}>
                带水平索引的双向循环链表
              </button>
              <button className={mode === 'single' ? 'active' : ''} onClick={() => setMode('single')}>
                标准单链表（基准）
              </button>
            </div>
          </div>

          <div className="field">
            场景
            <select value={scenarioKey} onChange={(e) => setScenarioKey(e.target.value)}>
              {Object.values(SCENARIOS).map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            速度
            <input
              type="range"
              min={1}
              max={8}
              step={1}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            />
            {speed} 秒/秒
          </div>

          <div className="field">
            窗口
            <select value={windowSec} onChange={(e) => setWindowSec(Number(e.target.value))}>
              <option value={15}>15s</option>
              <option value={30}>30s</option>
              <option value={60}>60s</option>
            </select>
          </div>

          <div className="field">
            单秒上限
            <select value={limitPerSec} onChange={(e) => setLimitPerSec(Number(e.target.value))}>
              <option value={200}>200</option>
              <option value={500}>500</option>
              <option value={1000}>1000</option>
            </select>
          </div>

          <button onClick={() => inject('late')}>注入老弹幕突发（延迟 3~5s）</button>
          <button onClick={() => inject('flood')}>注入流量洪峰（触发限流）</button>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          {SCENARIOS[scenarioKey].desc}
        </p>
      </div>

      <div className="grid">
        <div className="col">
          <div className="panel">
            <h2>
              直播画面 · 弹幕飘过
              <span className="tag">下划线虚线 = 延迟到达的老弹幕</span>
            </h2>
            <DanmakuStage
              items={flying}
              nowSec={snap ? snap.nowSec : 0}
              windowStart={snap ? snap.windowStart : 0}
              windowEnd={snap ? snap.windowEnd : 0}
              onEnd={onFlyEnd}
            />
          </div>

          {snap && (
            <DensityPanel
              window={snap.window}
              limit={limitPerSec}
              nowSec={snap.nowSec}
              selected={selected}
              onSelect={setSelectedSec}
              droppedTotal={droppedTotal}
            />
          )}

          <StructurePanel slot={slot} mode={mode} limit={limitPerSec} nowSec={snap ? snap.nowSec : 0} />
        </div>

        <div className="col">
          <StatsPanel snap={snap} windowSec={windowSec} limit={limitPerSec} />
          <LogConsole logs={snap ? snap.logs : []} flash={snap ? snap.flash : {}} />
        </div>
      </div>

      <PerfPanel windowSec={windowSec} limitPerSec={limitPerSec} />
    </div>
  );
}
