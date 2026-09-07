import React, { useState } from 'react';
import { runBenchmark, DEFAULT_SCALES, formatBytes } from '../core/benchmark.js';
import LineChart from './LineChart.jsx';

const PRESETS = {
  fast: { label: '快速（4 档）', scales: [1000, 3000, 6000, 10000] },
  std: { label: '标准（6 档）', scales: DEFAULT_SCALES },
  hard: { label: '极限（含 8 万）', scales: [2000, 5000, 10000, 20000, 40000, 80000] },
};

const C_INDEX = '#6aa9ff';
const C_SINGLE = '#ff9e64';

export default function PerfPanel({ windowSec, limitPerSec }) {
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [preset, setPreset] = useState('std');
  const [rate, setRate] = useState(300);
  const [lateRatio, setLateRatio] = useState(0.3);

  const start = async () => {
    setRunning(true);
    setRows([]);
    setProgress(0);
    await runBenchmark({
      scales: PRESETS[preset].scales,
      rate,
      lateRatio,
      windowSec,
      limitPerSec,
      seed: 20240901,
      onProgress: (row, all, p) => {
        setRows([...all]);
        setProgress(p);
      },
    });
    setRunning(false);
    setProgress(1);
  };

  const last = rows[rows.length - 1];

  return (
    <div className="panel full">
      <h2>
        性能对比实验：带水平索引的双向循环链表 vs 标准单链表
        <span className="tag">
          窗口 {windowSec}s · 单秒上限 {limitPerSec} · 同种子同输入序列
        </span>
      </h2>

      <div className="controls" style={{ marginBottom: 10 }}>
        <div className="field">
          规模档位
          <select value={preset} onChange={(e) => setPreset(e.target.value)} disabled={running}>
            {Object.entries(PRESETS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          到达速率
          <input
            type="number"
            min={50}
            max={2000}
            step={50}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            disabled={running}
            style={{ width: 74 }}
          />
          条/秒
        </div>
        <div className="field">
          乱序比例
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(lateRatio * 100)}
            onChange={(e) => setLateRatio(Number(e.target.value) / 100)}
            disabled={running}
          />
          {Math.round(lateRatio * 100)}%（延迟 3~5 秒到达）
        </div>
        <button className="primary" onClick={start} disabled={running}>
          {running ? `实验中… ${Math.round(progress * 100)}%` : '开始实验'}
        </button>
        {rows.length > 0 && !running && (
          <button onClick={() => setRows([])}>清空结果</button>
        )}
      </div>

      {rows.length > 0 && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>数据规模（条）</th>
                  <th>目标：耗时 ms</th>
                  <th>基准：耗时 ms</th>
                  <th>时间加速比</th>
                  <th>目标：比较次数</th>
                  <th>基准：比较次数</th>
                  <th>比较加速比</th>
                  <th>目标峰值结点</th>
                  <th>基准峰值结点</th>
                  <th>目标内存</th>
                  <th>基准内存</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.scale}>
                    <td>{r.scale.toLocaleString()}</td>
                    <td style={{ color: C_INDEX }}>{r.indexed.timeMs.toFixed(2)}</td>
                    <td style={{ color: C_SINGLE }}>{r.single.timeMs.toFixed(2)}</td>
                    <td>{r.speedupTime ? `${r.speedupTime.toFixed(1)}x` : '-'}</td>
                    <td style={{ color: C_INDEX }}>{r.indexed.compare.toLocaleString()}</td>
                    <td style={{ color: C_SINGLE }}>{r.single.compare.toLocaleString()}</td>
                    <td>{r.speedupCompare ? `${r.speedupCompare.toFixed(1)}x` : '-'}</td>
                    <td>{r.indexed.peakLive.toLocaleString()}</td>
                    <td>{r.single.peakLive.toLocaleString()}</td>
                    <td>{formatBytes(r.indexed.memoryBytes)}</td>
                    <td>{formatBytes(r.single.memoryBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="charts" style={{ marginTop: 12 }}>
            <div>
              <div className="legend">
                <span>
                  <i style={{ background: C_INDEX }} />
                  带水平索引的双向循环链表
                </span>
                <span>
                  <i style={{ background: C_SINGLE }} />
                  标准单链表
                </span>
              </div>
              <LineChart
                series={[
                  { name: 'indexed', color: C_INDEX, points: rows.map((r) => ({ x: r.scale, y: r.indexed.timeMs })) },
                  { name: 'single', color: C_SINGLE, points: rows.map((r) => ({ x: r.scale, y: r.single.timeMs })) },
                ]}
                xLabel="数据规模（条）"
                yLabel="耗时 ms"
                formatY={(v) => v.toFixed(0)}
                formatX={(v) => (v >= 1000 ? v / 1000 + 'k' : v)}
              />
              <p className="hint" style={{ textAlign: 'center' }}>图 1 · 时间开销随数据规模变化</p>
            </div>
            <div>
              <div className="legend">
                <span>
                  <i style={{ background: C_INDEX }} />
                  比较次数（目标）
                </span>
                <span>
                  <i style={{ background: C_SINGLE }} />
                  比较次数（基准）
                </span>
              </div>
              <LineChart
                series={[
                  { name: 'indexed', color: C_INDEX, points: rows.map((r) => ({ x: r.scale, y: r.indexed.compare })) },
                  { name: 'single', color: C_SINGLE, points: rows.map((r) => ({ x: r.scale, y: r.single.compare })) },
                ]}
                xLabel="数据规模（条）"
                yLabel="关键字比较次数"
                formatY={(v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(0) + 'k' : String(v))}
                formatX={(v) => (v >= 1000 ? v / 1000 + 'k' : v)}
              />
              <p className="hint" style={{ textAlign: 'center' }}>图 2 · 关键字比较次数（与硬件无关的时间复杂度证据）</p>
            </div>
            <div>
              <div className="legend">
                <span>
                  <i style={{ background: C_INDEX }} />
                  峰值内存（目标）
                </span>
                <span>
                  <i style={{ background: C_SINGLE }} />
                  峰值内存（基准）
                </span>
              </div>
              <LineChart
                series={[
                  {
                    name: 'indexed',
                    color: C_INDEX,
                    points: rows.map((r) => ({ x: r.scale, y: r.indexed.memoryBytes / 1024 })),
                  },
                  {
                    name: 'single',
                    color: C_SINGLE,
                    points: rows.map((r) => ({ x: r.scale, y: r.single.memoryBytes / 1024 })),
                  },
                ]}
                xLabel="数据规模（条）"
                yLabel="估算内存 KB"
                formatY={(v) => v.toFixed(0)}
                formatX={(v) => (v >= 1000 ? v / 1000 + 'k' : v)}
              />
              <p className="hint" style={{ textAlign: 'center' }}>图 3 · 空间占用随数据规模变化</p>
            </div>
          </div>

          {last && (
            <p className="note">
              <b>实验结论：</b>在最大规模 {last.scale.toLocaleString()} 条弹幕下
              {last.speedupTime ? `，目标方法耗时 ${last.indexed.timeMs.toFixed(2)}ms，基准方法 ${last.single.timeMs.toFixed(2)}ms（时间加速比 ${last.speedupTime.toFixed(1)}x）` : ''}
              {last.speedupCompare
                ? `；关键字比较次数 ${last.indexed.compare.toLocaleString()} vs ${last.single.compare.toLocaleString()}（${last.speedupCompare.toFixed(1)}x）`
                : ''}
              。原因在于：标准单链表缺少有序定位索引，每次插入都要从头结点线性扫描，平均比较次数随窗口内弹幕总量 n 线性增长（O(n)）；
              而带水平索引的双向循环链表通过“块 → 秒槽 → 100ms 子桶”三级索引把定位范围压缩到一个常数级时间片内，
              比较次数与 n 基本无关（近似 O(1)），且双向指针让“摘除任意结点”也是 O(1)。
              空间上目标方法为每个结点多付出 prev/up 指针与槽/子桶索引的少量固定开销（约 {(last.memoryRatio || 1).toFixed(2)}x），
              属于典型的“以空间换时间”。
            </p>
          )}
        </>
      )}

      {rows.length === 0 && !running && (
        <p className="note">
          点击「开始实验」：系统会用同一随机种子生成完全相同的弹幕到达序列（含 {Math.round(lateRatio * 100)}% 延迟 3~5 秒的乱序弹幕），
          分别交给两种结构处理，并在多个数据规模下统计耗时、关键字比较次数、指针游走步数与峰值内存，最后绘制时空变化曲线。
          <br />
          <b>注意：</b>实验在浏览器主线程同步执行，规模较大时界面会短暂无响应，属正常现象（这本身就是两种结构耗时差距的直接体现）。
        </p>
      )}
    </div>
  );
}
