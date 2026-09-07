/**
 * 命令行性能测试：node scripts/bench.mjs [scale1,scale2,...]
 * 输出 Markdown 表格，可直接粘进课程设计报告。
 */
import { runBenchmark, DEFAULT_SCALES, formatBytes } from '../src/core/benchmark.js';

const scales = process.argv[2]
  ? process.argv[2].split(',').map((s) => Number(s.trim()))
  : DEFAULT_SCALES;

console.log(`# 性能对比（窗口 30s，单秒上限 500，到达 300 条/秒，30% 延迟 3~5 秒）`);
console.log('');
console.log('| 数据规模 | 目标耗时ms | 基准耗时ms | 时间比 | 目标比较次数 | 基准比较次数 | 比较比 | 目标峰值结点 | 基准峰值结点 | 目标内存 | 基准内存 |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');

const rows = await runBenchmark({
  scales,
  rate: 300,
  lateRatio: 0.3,
  windowSec: 30,
  limitPerSec: 500,
  seed: 20240901,
  onProgress: (row) => {
    console.log(
      `| ${row.scale.toLocaleString()} | ${row.indexed.timeMs.toFixed(2)} | ${row.single.timeMs.toFixed(2)} | ` +
        `${(row.speedupTime || 0).toFixed(1)}x | ${row.indexed.compare.toLocaleString()} | ${row.single.compare.toLocaleString()} | ` +
        `${(row.speedupCompare || 0).toFixed(1)}x | ${row.indexed.peakLive.toLocaleString()} | ${row.single.peakLive.toLocaleString()} | ` +
        `${formatBytes(row.indexed.memoryBytes)} | ${formatBytes(row.single.memoryBytes)} |`,
    );
  },
});

const last = rows[rows.length - 1];
console.log('');
console.log(
  `结论：最大规模 ${last.scale.toLocaleString()} 条时，时间加速比 ${(last.speedupTime || 0).toFixed(1)}x，` +
    `比较次数加速比 ${(last.speedupCompare || 0).toFixed(1)}x，内存比 ${(last.memoryRatio || 0).toFixed(2)}x。`,
);
