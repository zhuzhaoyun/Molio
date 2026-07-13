import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {EASE_OUT, MONO_FAMILY, PALETTE} from '../theme';

type MolioFocus = 'files' | 'status' | 'graph' | 'write';

type MolioShellProps = {focus: MolioFocus};

const files = [
  {name: '研究笔记.md', state: 'clean'},
  {name: '产品访谈.pdf', state: 'modified'},
  {name: 'LLM Wiki.md', state: 'clean'},
  {name: '新想法.md', state: 'pending'},
] as const;

const stateColor = {clean: PALETTE.success, modified: PALETTE.warning, pending: PALETTE.muted};

export const MolioShell = ({focus}: MolioShellProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = interpolate(frame, [0, 0.9 * fps], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT,
  });

  return (
    <div
      style={{
        height: 600,
        borderRadius: 24,
        overflow: 'hidden',
        border: `1px solid ${PALETTE.edge}`,
        backgroundColor: '#11141C',
        boxShadow: '0 48px 130px rgba(0,0,0,0.42)',
        opacity: enter,
        transform: `translateY(${(1 - enter) * 36}px) scale(${0.97 + enter * 0.03})`,
      }}
    >
      <div
        style={{
          height: 48,
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '0 18px',
          backgroundColor: PALETTE.surface,
          borderBottom: `1px solid ${PALETTE.edge}`,
        }}
      >
        <span style={{width: 10, height: 10, borderRadius: 9, backgroundColor: '#FF6B6B'}} />
        <span style={{width: 10, height: 10, borderRadius: 9, backgroundColor: '#FFD166'}} />
        <span style={{width: 10, height: 10, borderRadius: 9, backgroundColor: '#5DD39E'}} />
        <span style={{marginLeft: 16, color: PALETTE.muted, fontFamily: MONO_FAMILY, fontSize: 14}}>MOLIO · LOCAL KNOWLEDGE WORKSPACE</span>
      </div>
      <div style={{height: 552, display: 'grid', gridTemplateColumns: '320px 1fr 350px'}}>
        <div
          style={{
            padding: 22,
            borderRight: `1px solid ${PALETTE.edge}`,
            backgroundColor: focus === 'files' || focus === 'status' ? 'rgba(139,92,246,0.07)' : 'transparent',
          }}
        >
          <div style={{fontSize: 15, color: PALETTE.muted, marginBottom: 18, letterSpacing: 2}}>LOCAL VAULT</div>
          <div style={{display: 'grid', gap: 9}}>
            {files.map((file) => (
              <div
                key={file.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '11px 12px',
                  borderRadius: 9,
                  backgroundColor: file.name === 'LLM Wiki.md' ? PALETTE.surfaceStrong : 'transparent',
                  fontSize: 17,
                }}
              >
                <span style={{color: PALETTE.muted}}>▤</span>
                <span style={{flex: 1}}>{file.name}</span>
                <span style={{width: 8, height: 8, borderRadius: 8, backgroundColor: stateColor[file.state]}} />
              </div>
            ))}
          </div>
          <div
            style={{
              marginTop: 24,
              borderRadius: 10,
              padding: 14,
              border: `1px solid ${focus === 'status' ? PALETTE.accent : PALETTE.edge}`,
              backgroundColor: PALETTE.surface,
              fontSize: 15,
              color: PALETTE.muted,
            }}
          >
            <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: 10}}><span>Wiki 状态</span><span style={{color: PALETTE.success}}>已初始化</span></div>
            <div style={{height: 5, borderRadius: 5, backgroundColor: PALETTE.edge}}><div style={{width: '76%', height: '100%', borderRadius: 5, backgroundColor: PALETTE.accent}} /></div>
          </div>
        </div>
        <div style={{padding: 30, backgroundColor: focus === 'graph' ? 'rgba(139,92,246,0.05)' : 'transparent'}}>
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
            <div><div style={{fontSize: 14, color: PALETTE.accent, fontFamily: MONO_FAMILY}}>wiki/concepts</div><div style={{fontSize: 34, fontWeight: 750, marginTop: 8}}>LLM Wiki</div></div>
            <div style={{padding: '9px 13px', borderRadius: 9, border: `1px solid ${PALETTE.edge}`, color: PALETTE.muted}}>构建 Wiki</div>
          </div>
          <div style={{marginTop: 30, color: PALETTE.muted, lineHeight: 1.8, fontSize: 18}}>由大模型从本地资料中提取概念、关系和来源，形成可阅读、可维护的知识结构。</div>
          <div style={{height: 290, position: 'relative', marginTop: 18}}>
            {[
              ['源文件', 80, 125], ['概念', 250, 65], ['关系', 290, 220], ['Wiki', 475, 135],
            ].map(([label, x, y]) => (
              <div key={String(label)} style={{position: 'absolute', left: Number(x), top: Number(y), width: 86, height: 86, borderRadius: 60, display: 'grid', placeItems: 'center', border: `2px solid ${label === 'Wiki' ? PALETTE.accent : PALETTE.edgeStrong}`, backgroundColor: PALETTE.surface, fontWeight: 700}}>{label}</div>
            ))}
            <svg width="100%" height="100%" style={{position: 'absolute', inset: 0}}><line x1="165" y1="168" x2="295" y2="110" stroke={PALETTE.edgeStrong}/><line x1="165" y1="168" x2="330" y2="260" stroke={PALETTE.edgeStrong}/><line x1="335" y1="110" x2="515" y2="178" stroke={PALETTE.edgeStrong}/><line x1="370" y1="260" x2="515" y2="178" stroke={PALETTE.edgeStrong}/></svg>
          </div>
        </div>
        <div style={{padding: 22, borderLeft: `1px solid ${PALETTE.edge}`, backgroundColor: focus === 'write' ? 'rgba(139,92,246,0.08)' : PALETTE.surface}}>
          <div style={{fontSize: 15, color: PALETTE.muted, letterSpacing: 2}}>ASK YOUR WIKI</div>
          <div style={{marginTop: 20, padding: 14, borderRadius: 12, backgroundColor: PALETTE.surfaceStrong, lineHeight: 1.55}}>LLM Wiki 和普通 RAG 的区别是什么？</div>
          <div style={{marginTop: 14, padding: 15, borderRadius: 12, border: `1px solid ${PALETTE.edge}`, color: PALETTE.muted, lineHeight: 1.65}}>RAG 负责即时检索；LLM Wiki 维护长期、显式的知识结构。两者可以组合使用。</div>
          <div style={{position: 'absolute', bottom: 32, width: 300, padding: 13, borderRadius: 10, backgroundColor: PALETTE.accentStrong, textAlign: 'center', fontWeight: 700}}>写入新文档</div>
        </div>
      </div>
    </div>
  );
};
