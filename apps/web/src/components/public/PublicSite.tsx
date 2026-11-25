import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { PublicGraph, PublicPage, PublicSite as PublicSiteDto } from '@molio/contracts';
import { publicApi } from '../../api/publication';
import { translate, type Locale } from '../../i18n';
import { renderPublicMarkdown } from './publicMarkdown';
import { loadPublicSnapshot, PublicSnapshotError, type PublicSnapshotTarget } from './publicSnapshot';
import './public.css';

const PublicGraphCanvas = lazy(() => import('./PublicGraphCanvas').then((module) => ({ default: module.PublicGraphCanvas })));

function publicLocale(): Locale {
  try { return window.localStorage.getItem('molio.locale') === 'en' ? 'en' : 'zh'; }
  catch { return 'zh'; }
}

export function PublicSite() {
  const locale = publicLocale();
  const t = (key: string, params?: Record<string, string | number>) => translate(locale, key, params);
  const location = useLocation();
  const pageId = location.pathname.match(/^\/public\/wiki\/([^/]+)$/)?.[1];
  const isGraph = location.pathname === '/public/graph';
  const [site, setSite] = useState<PublicSiteDto | null>(null);
  const [page, setPage] = useState<PublicPage | null>(null);
  const [graph, setGraph] = useState<PublicGraph | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const target: PublicSnapshotTarget = isGraph ? { kind: 'graph' } : pageId ? { kind: 'page', pageId } : { kind: 'index' };
    setLoading(true); setError(''); setSite(null); setPage(null); setGraph(null);
    void loadPublicSnapshot(publicApi, target)
      .then((snapshot) => {
        if (!active) return;
        setSite(snapshot.site); setPage(snapshot.page); setGraph(snapshot.graph);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof PublicSnapshotError) {
          setError(t(error.kind === 'closed' ? 'publicWiki.closed' : 'publicWiki.unavailable'));
        } else setError(error instanceof Error ? error.message : t('publicWiki.unavailable'));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [location.pathname, pageId]);

  const html = useMemo(() => page && site ? renderPublicMarkdown(page.markdown, site.revision, t('publicWiki.imageUnavailable')) : '', [page, site, locale]);
  const titles = new Map((site?.pages ?? []).map((item) => [item.id, item.title]));
  const title = page?.title ?? '公开 Wiki';
  return <main className="public-shell" data-testid="public-site">
    <header className="public-header"><Link className="public-brand" to="/public/wiki">Molio <span>{t('publicWiki.title')}</span></Link><nav aria-label="公开站点导航"><Link to="/public/wiki">{t('nav.knowledge')}</Link><Link to="/public/graph" aria-label={t('publicWiki.graph')}>{t('publicWiki.graph')}</Link></nav></header>
    <div className="public-layout"><aside className="public-sidebar"><h2>{t('publicWiki.visitorPages')}</h2>{site?.pages.map((item) => <Link key={item.id} to={`/public/wiki/${item.id}`}>{item.title}</Link>)}</aside>
      <section className="public-content">
        {loading ? <p role="status">{t('publicWiki.loading')}</p> : error ? <p role="alert">{error}</p> : isGraph && graph ? <>
          <h1>{t('publicWiki.graphTitle')}</h1><p className="public-revision">{t('publicWiki.revision', { revision: graph.revision })}</p>
          <div className="public-graph" data-testid="public-graph">
            <Suspense fallback={<p role="status">{t('publicWiki.loading')}</p>}><PublicGraphCanvas graph={graph} t={t} /></Suspense>
            <ul>{graph.nodes.map((node) => <li key={node.id}><Link to={`/public/wiki/${node.id}`} data-testid={`public-graph-page-${node.id}`}>{node.title}</Link><span>{graph.edges.filter((edge) => edge.source === node.id).map((edge) => titles.get(edge.target)).filter(Boolean).join('、') || t('publicWiki.noOutgoing')}</span></li>)}</ul>
          </div>
        </> : page ? <article data-testid="public-wiki-page"><p className="public-revision">{t('publicWiki.revision', { revision: page.revision })}</p><h1>{title}</h1><div className="public-markdown" dangerouslySetInnerHTML={{ __html: html }} /></article> : !pageId ? <section><p className="public-revision">{t('publicWiki.revision', { revision: site?.revision ?? 0 })}</p><h1>{t('publicWiki.title')}</h1><ul>{site?.pages.map((item) => <li key={item.id}><Link to={`/public/wiki/${item.id}`}>{item.title}</Link></li>)}</ul></section> : <p role="alert">{t('publicWiki.unavailable')}</p>}
      </section>
    </div>
  </main>;
}
