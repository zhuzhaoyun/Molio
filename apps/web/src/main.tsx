import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
// ES2025 Map polyfill —— 最早执行，保证任何 pdfjs-dist 代码（含主线程 display bundle）加载前已就绪。
// Electron 40 (Chromium 144) 缺失 getOrInsert/getOrInsertComputed，pdf.js v6 依赖它们。
import './components/kb/map-polyfills';
import App from './App';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chat.css';
import './components/RunStatusBar.css';
import { initTheme } from './utils/theme';

// 首帧应用持久化主题，避免闪烁
initTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
