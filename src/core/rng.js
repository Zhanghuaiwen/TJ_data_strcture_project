/**
 * 可复现的伪随机数发生器（mulberry32）。
 * 课程设计要求“在不同数据规模下进行性能测试”，为保证两种数据结构
 * 吃到的输入序列完全一致（公平对比），所有随机量均由种子驱动。
 */
export function createRng(seed = 20240901) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** [min, max] 闭区间整数 */
export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

/** 从数组中随机取一个元素 */
export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}
