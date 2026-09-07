/**
 * 节点定义（纯手工结构体，不使用任何内置集合容器）
 *
 * 物理结构设计说明：
 *  · 弹幕节点 DanmakuNode 是“双向循环链表”的基础结点，除业务字段外，
 *    仅含 prev / next 两个链指针（循环链表不需要额外头尾指针）。
 *  · nextFree 是对象池的“空闲链”指针：节点被回收后不交还 GC，
 *    而是通过 nextFree 串成一条空闲单链，实现 O(1) 申请 / O(1) 归还。
 *  · up 指向水平索引层（跳跃索引）中对应的索引节点。
 *
 * 空间估算模型（用于实验中的空间复杂度对比，单位：字节，64 位平台）：
 *  · 数值字段（ts / seq / weight / vip / id / slotSec...）按 8B 计
 *  · 引用字段（指针 / 字符串引用）按 8B 计
 * 该模型为“字段计数 × 指针宽度”的确定性估算，保证两次实验可比。
 */

export function createDanmakuNode() {
  return {
    id: 0, // 节点编号（对象池内的唯一编号，便于观察复用）
    ts: 0, // 弹幕自带的视频时间戳（毫秒，绝对时间轴）
    seq: 0, // 到达序号，用于同毫秒下的稳定排序
    weight: 0, // 弹幕权重（1~10），限流降级时优先丢弃低权重
    vip: 0, // 用户等级（业务字段）
    text: '', // 弹幕文本
    user: '', // 发送者
    color: '#ffffff', // 颜色
    prev: null, // 前驱指针（双向循环链表）
    next: null, // 后继指针
    up: null, // 水平索引层指针（仅索引链表使用）
    nextFree: null, // 对象池空闲链指针
  };
}

/** 归还对象池前清空所有引用，避免悬挂指针与内存泄漏 */
export function resetDanmakuNode(n) {
  n.id = 0;
  n.ts = 0;
  n.seq = 0;
  n.weight = 0;
  n.vip = 0;
  n.text = '';
  n.user = '';
  n.color = '#ffffff';
  n.prev = null;
  n.next = null;
  n.up = null;
  // 注意：nextFree 由对象池自己维护，此处不清空
}

/** 标准单链表使用的精简结点：无 prev、无 up（少 2 个指针字段） */
export function createSlimNode() {
  return {
    id: 0,
    ts: 0,
    seq: 0,
    weight: 0,
    vip: 0,
    text: '',
    user: '',
    color: '#ffffff',
    next: null,
    nextFree: null,
  };
}

export function resetSlimNode(n) {
  n.id = 0;
  n.ts = 0;
  n.seq = 0;
  n.weight = 0;
  n.vip = 0;
  n.text = '';
  n.user = '';
  n.color = '#ffffff';
  n.next = null;
}

export function createIndexNode() {
  return {
    down: null, // 指向底层链表中被索引的结点
    prev: null, // 索引层前驱（索引层同样为双向循环链表）
    next: null,
    nextFree: null,
  };
}

export function resetIndexNode(n) {
  n.down = null;
  n.prev = null;
  n.next = null;
}

/** 空间估算常量（字节） */
export const MEM = {
  danmakuNode: 12 * 8, // 双向循环链表结点：12 个字段
  slimNode: 10 * 8, // 标准单链表结点：10 个字段（少 prev / up）
  slot: 8 * 8, // 秒级槽位对象
  sub: 3 * 8, // 100ms 子桶对象
  block: 4 * 8, // 块级索引对象
};

/**
 * 关键字比较：先比视频时间戳，再比到达序号（保证同毫秒稳定有序）。
 * 返回 <0 表示 a 在 b 之前。
 */
export function compareKey(aTs, aSeq, bTs, bSeq) {
  if (aTs !== bTs) return aTs < bTs ? -1 : 1;
  if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
  return 0;
}
