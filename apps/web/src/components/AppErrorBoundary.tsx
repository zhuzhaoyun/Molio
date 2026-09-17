import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 全局兜底 ErrorBoundary：渲染期未捕获错误降级为错误卡片，而不是 React 整树卸载后的白屏
 * （v0.3.56 线上案例：图谱引擎销毁崩溃 → 全局白屏，见 docs/2026-09-17-graph-destroy-white-screen-fix.md）。
 *
 * 边界只覆盖 React 渲染路径；effect cleanup / 事件回调 / rAF 的异常 React 边界接不住，
 * 由各模块就地 try/catch 消化（如 pixiGraphEngine.destroy）。
 *
 * 文案用中英双语静态字面量：本组件位于 LanguageProvider 内侧但为 class 组件，
 * 不引 useI18n（避免为边缘 UI 增加一层函数包装）。
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[app] render error caught by boundary:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        data-testid="app-error-fallback"
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 24,
          background: 'var(--bg-app, #faf8f5)',
          color: 'var(--text, #1f1f1f)',
          fontFamily: 'var(--sans, sans-serif)',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600 }}>出了点问题 / Something went wrong</div>
        <div
          style={{
            maxWidth: 560,
            fontSize: 12,
            color: 'var(--text-muted, #888)',
            wordBreak: 'break-all',
            maxHeight: 120,
            overflow: 'auto',
          }}
        >
          {this.state.error.message}
        </div>
        <button
          type="button"
          data-testid="app-error-reload"
          onClick={() => window.location.reload()}
          style={{
            padding: '6px 16px',
            borderRadius: 6,
            border: '1px solid var(--border, #ddd)',
            background: 'var(--accent, #c9663a)',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          重新加载 / Reload
        </button>
      </div>
    );
  }
}
