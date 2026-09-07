import { createRng, randInt, pick } from './rng.js';

/**
 * 单线程弹幕发射器（模拟前端/网关向弹幕服务器投递弹幕）
 *
 * 每一个模拟秒执行 step()：
 *   1) engine.advance()  —— 时间轴前进 1 秒，窗口滑动并回收过期结点；
 *   2) generate()        —— 按剧本生成本秒到达的弹幕（含乱序/延迟/超量）；
 *   3) 逐条 engine.receive() —— 入窗（原地插入排序 + 限流降级）。
 *
 * 剧本（phase）用于覆盖课程要求中的三类边界情况：
 *   (1) 大批延迟 3~5 秒的“老弹幕”突发到达 —— 检验乱序插入能力；
 *   (2) 某段时间完全没有输入             —— 检验窗口空转滑动；
 *   (3) 单秒弹幕量超过承载上限            —— 检验基于权重的降级丢弃。
 */

const TEXTS = [
  '666666',
  'awsl',
  '这波操作太秀了',
  '主播牛啊',
  '前排围观',
  '哈哈哈哈哈',
  '爷青回',
  '泪目了',
  '高能预警',
  '速速上分',
  '这也能赢？',
  '全体起立',
  '手速太快了',
  '打得好啊',
  '再来一局',
  '这波稳了',
  '教练我想学',
  '有点东西',
  '弹幕护体',
  '给我也整一个',
  '太顶了',
  '真的假的',
  '救命笑死',
  '这局必赢',
];

const COLORS_LOW = ['#e6e6e6', '#9ad0ff', '#a9dc76', '#c8d3f5'];
const COLORS_MID = ['#7dcfff', '#ffd166', '#8bd5ca'];
const COLORS_HIGH = ['#ff7b72', '#ffb86c', '#f1fa8c'];

function phaseOf(script, sec) {
  const phases = script.phases;
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    if (sec >= p.from && sec <= p.to) return p;
  }
  return phases[phases.length - 1];
}

export const SCENARIOS = {
  normal: {
    key: 'normal',
    label: '① 正常运行',
    desc: '稳定 220 条/秒，含 6% 轻微乱序，观察窗口常规滑动与插入',
    phases: [{ from: 0, to: Infinity, rate: 220, lateRatio: 0.06, tag: '正常运行' }],
  },
  burstLate: {
    key: 'burstLate',
    label: '② 乱序突发（延迟 3~5 秒老弹幕）',
    desc: '第 10~14 秒突发大量延迟 3~5 秒到达的老弹幕，检验乱序原地插入',
    phases: [
      { from: 0, to: 9, rate: 200, lateRatio: 0.05, tag: '正常' },
      { from: 10, to: 14, rate: 200, lateRatio: 0.05, burstLate: 700, tag: '乱序突发：+700 条/秒 延迟 3~5s' },
      { from: 15, to: Infinity, rate: 200, lateRatio: 0.05, tag: '恢复正常' },
    ],
  },
  silent: {
    key: 'silent',
    label: '③ 空窗期（无输入仍滑动）',
    desc: '第 12~26 秒完全无弹幕输入，检验窗口照常滑动、结点照常回收',
    phases: [
      { from: 0, to: 11, rate: 260, lateRatio: 0.05, tag: '正常' },
      { from: 12, to: 26, rate: 0, lateRatio: 0, tag: '空窗期：无输入' },
      { from: 27, to: Infinity, rate: 260, lateRatio: 0.05, tag: '恢复输入' },
    ],
  },
  overload: {
    key: 'overload',
    label: '④ 超量限流（超 500 条/秒）',
    desc: '第 8~20 秒按 900 条/秒灌入，远超单秒上限 500，触发基于权重的降级丢弃',
    phases: [
      { from: 0, to: 7, rate: 200, lateRatio: 0.05, tag: '正常' },
      { from: 8, to: 20, rate: 900, lateRatio: 0.08, tag: '超量：900 条/秒' },
      { from: 21, to: Infinity, rate: 200, lateRatio: 0.05, tag: '恢复正常' },
    ],
  },
  mixed: {
    key: 'mixed',
    label: '⑤ 综合剧本（依次覆盖三种边界）',
    desc: '0-9s 正常 → 10-14s 乱序突发 → 15-25s 空窗 → 26-36s 超量限流 → 之后恢复',
    phases: [
      { from: 0, to: 9, rate: 220, lateRatio: 0.05, tag: '正常运行' },
      { from: 10, to: 14, rate: 220, lateRatio: 0.05, burstLate: 700, tag: '乱序突发：老弹幕延迟 3~5s 到达' },
      { from: 15, to: 25, rate: 0, lateRatio: 0, tag: '空窗期：无输入，窗口仍滑动' },
      { from: 26, to: 36, rate: 900, lateRatio: 0.08, tag: '超量：900 条/秒，触发限流降级' },
      { from: 37, to: Infinity, rate: 220, lateRatio: 0.06, tag: '恢复正常运行' },
    ],
  },
};

export function makeUniformScenario({ rate = 300, lateRatio = 0.25, tag = '压测' } = {}) {
  return {
    key: 'bench',
    label: '压测场景',
    desc: `固定 ${rate} 条/秒，${(lateRatio * 100).toFixed(0)}% 延迟 3~5 秒到达`,
    phases: [{ from: 0, to: Infinity, rate, lateRatio, tag }],
  };
}

export class Emitter {
  constructor(engine, { seed = 20240901, scenario = 'mixed' } = {}) {
    this.engine = engine;
    this.rng = createRng(seed);
    this.seed = seed;
    this.lastTag = null;
    this.setScenario(scenario);
  }

  setScenario(scenario) {
    this.scenario = typeof scenario === 'string' ? SCENARIOS[scenario] || SCENARIOS.mixed : scenario;
    this.lastTag = null;
  }

  reseed(seed) {
    this.seed = seed;
    this.rng = createRng(seed);
  }

  phaseAt(sec) {
    return phaseOf(this.scenario, sec);
  }

  /** 生成一条弹幕（自带视频时间戳，可能严重乱序） */
  makeDanmaku(nowSec, { forceLate = false, lateRatio = 0, delayMin = 3, delayMax = 5 } = {}) {
    const rng = this.rng;
    let ts;
    let late = false;
    if (forceLate || rng() < lateRatio) {
      const delay = randInt(rng, delayMin, delayMax);
      const base = Math.max(0, nowSec - delay);
      ts = base * 1000 + randInt(rng, 0, 999);
      late = true;
    } else {
      ts = nowSec * 1000 + randInt(rng, 0, 999);
    }

    const r = rng();
    let vip = 0;
    let weight;
    if (r < 0.62) {
      weight = randInt(rng, 1, 3);
    } else if (r < 0.92) {
      vip = randInt(rng, 1, 3);
      weight = randInt(rng, 3, 7);
    } else {
      vip = randInt(rng, 3, 6);
      weight = randInt(rng, 7, 10);
    }

    const palette = weight >= 7 ? COLORS_HIGH : weight >= 4 ? COLORS_MID : COLORS_LOW;
    let text = pick(rng, TEXTS);
    if (rng() < 0.18) text += '！'.repeat(randInt(rng, 1, 3));

    return {
      ts,
      weight,
      vip,
      text,
      user: '用户' + randInt(rng, 1000, 9999),
      color: pick(rng, palette),
      late,
    };
  }

  /** 生成当前秒到达的全部弹幕 */
  generate(nowSec) {
    const ph = this.phaseAt(nowSec);
    const rng = this.rng;
    const out = [];
    const jitter = 0.85 + 0.3 * rng();
    const base = Math.round((ph.rate || 0) * jitter);
    for (let i = 0; i < base; i++) {
      out.push(this.makeDanmaku(nowSec, { lateRatio: ph.lateRatio || 0 }));
    }
    if (ph.burstLate) {
      const n = Math.round(ph.burstLate * (0.85 + 0.3 * rng()));
      for (let i = 0; i < n; i++) {
        out.push(this.makeDanmaku(nowSec, { forceLate: true, delayMin: 3, delayMax: 5 }));
      }
    }
    return { list: out, phase: ph };
  }

  /** 推进一个模拟秒：先滑动窗口，再投递本秒弹幕 */
  step() {
    const engine = this.engine;
    engine.advance();
    const { list, phase } = this.generate(engine.nowSec);
    if (phase.tag && phase.tag !== this.lastTag) {
      this.lastTag = phase.tag;
      engine.log('phase', `进入阶段：${phase.tag}`);
    }
    if (phase.burstLate && list.length > 800) {
      engine.log('burst', `老弹幕突发：本秒到达 ${list.length} 条，其中大量延迟 3~5 秒（乱序插入）`);
    }
    const results = [];
    for (let i = 0; i < list.length; i++) {
      results.push(engine.receive(list[i]));
    }
    return { batch: list, results, phase };
  }

  /** 手动注入：立即制造一批延迟 3~5 秒的老弹幕 */
  injectLateBurst(count = 600) {
    const engine = this.engine;
    const list = [];
    for (let i = 0; i < count; i++) {
      list.push(this.makeDanmaku(engine.nowSec, { forceLate: true, delayMin: 3, delayMax: 5 }));
    }
    engine.log('burst', `手动注入 ${count} 条延迟 3~5 秒的老弹幕（乱序插入压力测试）`);
    const results = [];
    for (let i = 0; i < list.length; i++) results.push(engine.receive(list[i]));
    return { batch: list, results };
  }

  /** 手动注入：单秒灌入 N 条（用于触发限流） */
  injectFlood(count = 1200) {
    const engine = this.engine;
    const list = [];
    for (let i = 0; i < count; i++) {
      list.push(this.makeDanmaku(engine.nowSec, { lateRatio: 0.1 }));
    }
    engine.log('burst', `手动注入 ${count} 条/秒 流量洪峰（限流降级测试）`);
    const results = [];
    for (let i = 0; i < list.length; i++) results.push(engine.receive(list[i]));
    return { batch: list, results };
  }
}
