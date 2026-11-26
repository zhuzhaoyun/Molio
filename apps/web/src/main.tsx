import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
// ES2025 Map polyfill —— 最早执行，保证任何 pdfjs-dist 代码（含主线程 display bundle）加载前已就绪。
// Electron 40 (Chromium 144) 缺失 getOrInsert/getOrInsertComputed，pdf.js v6 依赖它们。
import './components/kb/map-polyfills';
import { AccessBoundary } from './access/AccessBoundary';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chat.css';
import './components/RunStatusBar.css';
import './components/WorkBlock.css';
import './components/SourceChips.css';
import './components/WorkCompleteBanner.css';
import './components/SessionOutputPanel.css';
import { initTheme } from './utils/theme';
import { installChunkRecovery } from './chunkRecovery';
import { PublicSite } from './components/public/PublicSite';
import { useLocation } from 'react-router-dom';

// 更新换包后旧页面引用旧 hash chunk 会 404（vite:preloadError），自动刷新一次向
// 当前 daemon 拉 index.html 即恢复；与 AppErrorBoundary 的 chunk 判别共用冷却窗口。
installChunkRecovery(window);

// 首帧应用持久化主题，避免闪烁
initTheme();

function AppEntry() {
  const location = useLocation();
  if (location.pathname === '/public/wiki' || location.pathname.startsWith('/public/wiki/') || location.pathname === '/public/graph') {
    return <PublicSite />;
  }
  return <AccessBoundary />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppEntry />
    </BrowserRouter>
  </React.StrictMode>,
);
