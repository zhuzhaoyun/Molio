import { useEffect, useRef, useState } from 'react';
import { parse } from 'yaml';
import { MarkdownText, IconFolderOpenOutlineRegular, IconBranchOutlineRegular, IconAppsAddOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { decorateWiki, fileAddress } from './wiki.mjs';

export const inject = ['slots', 'connection', 'sidebarRight', 'sessions', 'documentPreviews', 'workspaces', 'uiWorkspace', 'conversation', 'layout'];
const pages = [
  ['knowledge', '知识库', '/knowledge?panel=files', IconFolderOpenOutlineRegular],
  ['graph', '知识图谱', '/knowledge?panel=graph', IconBranchOutlineRegular],
  ['resources', '资源市场', '/resources', IconAppsAddOutlineRegular],
];
const labels = { code: { copyLabel: '复制', copiedLabel: '已复制', toolbarLabels: { codeLabel: '代码', wrapLabel: '换行', unwrapLabel: '取消换行' } }, footnotes: '脚注' };
const key = session => 'molio.vault.' + session;
const modes = { ask: '', build: '构建知识库 Wiki。', lint: '检查 Wiki 中的断链和元数据。', ingest: '把以下来源摄取到知识库 Wiki。' };

const propertyLabels = new Map(Object.entries({
  type: '类型', title: '标题', created: '创建日期', updated: '更新日期',
  tags: '标签', aliases: '别名', related: '相关笔记', sources: '来源',
}));

function NoteProperties({ fields }) {
  return <details open style={{ marginBottom: 16, fontSize: '0.9em' }}>
    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>属性</summary>
    <dl style={{ margin: '8px 0 0', paddingBottom: 8, borderBottom: '1px solid color-mix(in srgb, currentColor 18%, transparent)' }}>
      {Object.entries(fields).map(([key, value]) => {
        const list = Array.isArray(value);
        return <div key={key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, min(28%, 6em)) minmax(0, 1fr)', gap: 8, padding: '3px 0', lineHeight: 1.5 }}>
          <dt title={key} style={{ opacity: 0.75, overflowWrap: 'anywhere' }}>{propertyLabels.get(key) ?? key}</dt>
          <dd style={{ margin: 0, display: 'flex', flexWrap: 'wrap', gap: '3px 6px' }}>
            {(list ? value : [value]).map((item, i) => <span key={i} style={{
              maxWidth: '100%', boxSizing: 'border-box', overflowWrap: 'anywhere',
              ...(list && { padding: '0 6px', borderRadius: 4, background: 'color-mix(in srgb, currentColor 8%, transparent)' }),
            }}>{item == null ? '' : typeof item === 'object' ? JSON.stringify(item) : String(item)}</span>)}
          </dd>
        </div>;
      })}
    </dl>
  </details>;
}

export function apply(ctx) {
  async function call(method, payload = {}) {
    const res = await fetch(new URL('api/molio', document.baseURI), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, payload }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || '无法连接 Molio 服务');
    return result.value;
  }
  function draft(session, prompt) {
    const binding = ctx.sessions.binding(session);
    if (!binding || ctx.conversation.input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'append' }) === 'blocked') throw new Error('当前会话无法接收草稿');
  }
  function wiki(session, cwd, vaultId) {
    return async page => {
      const path = await call('resolve', { page, cwd, vaultId });
      ctx.sidebarRight.openResourceIn(session, fileAddress(session, path));
    };
  }
  function register(name, options, component) {
    ctx.slots.inject(name, () => ctx.slots.register({ name, ...options }, component));
  }
  const navigation = new EventTarget();
  let knowledgeRoute = pages[0][2];
  register('sidebar.right.tab.document.actions', { id: 'molio-open-in-vault' }, function OpenInVault({ absolutePath }) {
    const [location, setLocation] = useState(null);
    useEffect(() => {
      let live = true;
      setLocation(null);
      if (absolutePath) call('location', { cwd: absolutePath }).then(value => { if (live) setLocation(value); }).catch(() => {});
      return () => { live = false; };
    }, [absolutePath]);
    return location && <button type="button" onClick={() => {
      knowledgeRoute = '/knowledge?' + new URLSearchParams(location);
      navigation.dispatchEvent(new Event('open'));
      ctx.layout.selectPanel('molio-knowledge');
    }}>在知识库中打开</button>;
  });
  for (const [id, title, route, Icon] of pages) {
    register('sidebar.panellist', { id: 'molio-' + id, label: () => title }, Icon);
    register('main', { key: 'molio-' + id }, function Panel() {
      const [origin, setOrigin] = useState('');
      const [error, setError] = useState('');
      const frame = useRef(null);
      const [currentRoute, setRoute] = useState(id === 'knowledge' ? knowledgeRoute : route);
      useEffect(() => {
        if (id !== 'knowledge') return;
        const navigate = () => setRoute(knowledgeRoute);
        navigation.addEventListener('open', navigate);
        return () => navigation.removeEventListener('open', navigate);
      }, []);
      useEffect(() => {
        let live = true;
        call('endpoint').then(url => live && setOrigin(new URL(url).origin), err => live && setError(err.message));
        return () => { live = false; };
      }, []);
      useEffect(() => {
        async function receive(event) {
          if (!origin || event.origin !== origin || event.source !== frame.current?.contentWindow) return;
          if (event.data?.type === 'molio-pick-directory') {
            const port = event.ports[0];
            if (!port) return;
            try {
              const picker = globalThis.__DSH_DIRECTORY_PICKER__;
              if (!picker) throw new Error('当前宿主没有桌面目录选择器');
              port.postMessage({ path: await picker.pick() });
            } catch (err) { port.postMessage({ error: err.message }); }
            finally { port.close(); }
            return;
          }
          if (event.data?.type !== 'molio-draft') return;
          try {
            const input = event.data.context;
            const { vaults } = await call('targets');
            const vault = vaults.find(v => v.id === input.vaultId);
            if (!vault || !Object.hasOwn(modes, input.mode)) throw new Error('无效的知识库请求');
            const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.path === vault.path) ?? await ctx.workspaces.create({ path: vault.path });
            await ctx.uiWorkspace.openWorkspace(workspace.workspaceId, session => {
              localStorage.setItem(key(session), vault.id);
              if (input.mode === 'ask') {
                const binding = ctx.sessions.binding(session);
                if (!binding) throw new Error('无法打开知识库会话');
                const composer = ctx.conversation.input.for(binding.ctx);
                const file = event.data.attachment;
                if (file instanceof File) {
                  const attachments = ctx.conversation.createDrafts(session, [file], true);
                  if (!composer.addAttachments(attachments.map(item => item.id))) {
                    ctx.conversation.releaseDraftAttachments(attachments);
                    throw new Error('当前会话无法添加附件');
                  }
                }
                if (input.selectedText) composer.insertQuote(input.selectedText);
                return;
              }
              draft(session, [modes[input.mode], vault.path, input.filePath, input.selectedText].filter(Boolean).join('\n\n'));
            });
          } catch (err) { window.alert(err.message); }
        }
        window.addEventListener('message', receive);
        return () => window.removeEventListener('message', receive);
      }, [origin]);
      if (error) return <p role="alert">{error}</p>;
      if (!origin) return null;
      const panelUrl = new URL(currentRoute, origin);
      if (globalThis.__DSH_DIRECTORY_PICKER__) panelUrl.searchParams.set('molioDesktop', '1');
      return <iframe ref={frame} title={title} src={panelUrl.href} style={{ width: '100%', height: '100%', flex: 1, border: 0 }} />;
    });
  }
  const preview = 'dsh-plugin-molio/obsidian';
  ctx.effect(() => ctx.documentPreviews.register({ id: preview, title: () => 'Obsidian', extensions: ['md', 'markdown'], loading: 'text-pages' }));
  register('sidebar.right.tab.document', { key: preview }, function Preview({ content, resourceAddress, useResource, sessionId }) {
    const path = useResource(resourceAddress).value?.absolutePath;
    const root = useRef(null);
    const text = content.kind === 'text' ? content.text : '';
    useEffect(() => root.current && decorateWiki(root.current, '[data-molio-document]', wiki(sessionId, path)), [path, sessionId, text]);
    const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u.exec(text);
    let fields;
    try { fields = match && parse(match[1]); } catch { /* Show malformed YAML verbatim. */ }
    return <article data-molio-document="" ref={root} style={{ padding: 16 }}>
      {match && (fields && typeof fields === 'object' ? <NoteProperties fields={fields} /> : <pre>{match[1]}</pre>)}
      <MarkdownText text={match ? text.slice(match[0].length) : text} labels={labels} streaming={!content.eof} />
    </article>;
  });
  const ingestEvent = new EventTarget();
  ctx.inject(['commandUi'], scope => scope.effect(() => scope.commandUi.register({
    name: 'molio-ingest', label: () => '文件入库', available: () => true,
    ui: { kind: 'action', run: ({ sessionId }) => ingestEvent.dispatchEvent(new CustomEvent('open', { detail: sessionId })) },
  })));
  register('conversation.input.dock', { id: 'molio-ingest' }, function Dock({ sessionId, useSessions }) {
    const cwd = useSessions(state => state.byId[sessionId]?.cwd);
    const [open, setOpen] = useState(false);
    const [vaults, setVaults] = useState([]);
    const [selected, select] = useState('');
    const [source, setSource] = useState('');
    const [error, setError] = useState('');
    useEffect(() => {
      const show = e => { if (e.detail === sessionId) setOpen(true); };
      ingestEvent.addEventListener('open', show);
      return () => ingestEvent.removeEventListener('open', show);
    }, [sessionId]);
    useEffect(() => {
      if (!open) return;
      setError('');
      let live = true;
      call('targets', { cwd }).then(({ vaults, inferred }) => {
        if (!live) return;
        setVaults(vaults);
        if (inferred && localStorage.getItem(key(sessionId)) === null) localStorage.setItem(key(sessionId), inferred);
        select(localStorage.getItem(key(sessionId)) ?? '');
      }, err => live && setError(err.message));
      return () => { live = false; };
    }, [open, cwd, sessionId]);
    useEffect(() => {
      const resolve = page => wiki(sessionId, cwd, localStorage.getItem(key(sessionId)) ?? undefined)(page);
      const selector = '[data-conversation-session="' + CSS.escape(sessionId) + '"] [data-chat-flow-kind="assistant-step"]';
      const stop = decorateWiki(document.body, selector, resolve, true);
      const correctPath = event => {
        const button = event.target.closest?.('button[title]');
        if (!button?.closest(selector) || !/^\/[a-z]:[\\/]/i.test(button.title)) return;
        event.preventDefault();
        event.stopPropagation();
        ctx.sidebarRight.openResourceIn(sessionId, fileAddress(sessionId, button.title));
      };
      document.addEventListener('click', correctPath, true);
      return () => { document.removeEventListener('click', correctPath, true); stop(); };
    }, [sessionId, cwd]);
    if (!open) return null;
    return <form onSubmit={event => {
      event.preventDefault();
      const vault = vaults.find(v => v.id === selected);
      if (!vault || !source.trim()) return;
      try {
        draft(sessionId, [modes.ingest, '知识库：' + vault.path, '来源：' + source.trim()].join('\n'));
        setOpen(false); setSource(''); setError('');
      } catch (err) { setError(err.message); }
    }}>
      <label>知识库 <select required value={selected} onChange={e => { select(e.target.value); localStorage.setItem(key(sessionId), e.target.value); }}>
        <option value="">选择知识库</option>{vaults.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      {globalThis.__DSH_HOST_PATHS__?.pathFor && <label>选择来源文件 <input type="file" onChange={e => {
        const file = e.target.files?.[0];
        if (file) setSource(globalThis.__DSH_HOST_PATHS__.pathFor(file));
      }} /></label>}
      <label>来源文件路径 <input required value={source} onChange={e => setSource(e.target.value)} /></label>
      <button type="submit">生成入库草稿</button><button type="button" onClick={() => setOpen(false)}>关闭</button>{error && <span role="alert">{error}</span>}
    </form>;
  });
}
