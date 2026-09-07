/**
 * 冒烟测试：在 Node 中把整个 React 界面渲染为字符串，
 * 用于验证所有组件在首次渲染时不报错（不含浏览器 API）。
 */
import React from 'react';
import { renderToString } from 'react-dom/server';
import App from './App.jsx';

const html = renderToString(<App />);
const must = ['互联网视频直播高并发弹幕时间轴对齐缓存', '滑动窗口时间槽密度', '控制台日志', '性能对比实验'];
let bad = 0;
for (const m of must) {
  if (!html.includes(m)) {
    console.error('缺少内容：', m);
    bad++;
  }
}
console.log('SSR 渲染长度 =', html.length, bad === 0 ? '· 冒烟通过' : `· ${bad} 项缺失`);
process.exit(bad === 0 ? 0 : 1);
