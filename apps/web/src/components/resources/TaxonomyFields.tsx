import { useEffect, useState } from 'react';
import type { MarketTaxonomy, MarketTaxon } from '@molio/contracts';
import { useI18n } from '../../i18n';

export function TaxonomyFields({ categoryId, resourceTypeId, onChange, isAdmin }: {
  categoryId: string; resourceTypeId: string; isAdmin: boolean;
  onChange: (key: 'categoryId' | 'resourceTypeId', value: string) => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<MarketTaxonomy | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [newKind, setNewKind] = useState<'category' | 'type' | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    fetch('/api/market/taxonomy', {signal:controller.signal}).then(async r => {
      if (!r.ok) throw new Error();
      const body = await r.json() as MarketTaxonomy;
      setData(body);
    }).catch(() => { if (!controller.signal.aborted) setError(t('catalog.loadError')); });
    return () => controller.abort();
  }, [retry, t]);
  async function create() {
    if (!name.trim() || !newKind || busy) return;
    const kind = newKind;
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/market/taxonomy', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({kind,name:name.trim()})});
      if (!res.ok) throw new Error();
      const item = await res.json() as MarketTaxon;
      setData(current => {
        const next = current ?? {categories:[],types:[]};
        const key = kind === 'category' ? 'categories' : 'types';
        return {...next,[key]:[...next[key].filter(t => t.id !== item.id),item].sort((a,b)=>a.position-b.position)};
      });
      onChange(kind === 'category' ? 'categoryId' : 'resourceTypeId', item.id);
      setNewKind(null); setName('');
    } catch { setError(t('catalog.createError')); }
    finally { setBusy(false); }
  }
  return <fieldset className="catalog-publish" data-testid="publish-taxonomy">
    <legend>{t('catalog.classification')}</legend>
    {(['category','type'] as const).map(kind => {
      const list = data?.[kind === 'category' ? 'categories' : 'types'] ?? [];
      const value = kind === 'category' ? categoryId : resourceTypeId;
      return <div key={kind}>
        <label>{t(`catalog.${kind}`)}
          <select data-testid={`publish-${kind}`} value={value} disabled={!data || busy}
            onChange={e => onChange(kind === 'category' ? 'categoryId' : 'resourceTypeId', e.target.value)}>
            <option value="">{t('catalog.select')}</option>
            {value && !list.some(x=>x.id===value) && <option value={value}>{t('catalog.unavailable')}</option>}
            {list.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        {isAdmin && <button type="button" className="kb-btn" disabled={busy || !data} data-testid={`new-${kind}`} onClick={()=>{setNewKind(kind);setName('');}}>＋ {t(`catalog.new.${kind}`)}</button>}
      </div>;
    })}
    {newKind && <div className="catalog-create">
      <label>{t(`catalog.new.${newKind}`)}<input data-testid="taxon-name" maxLength={30} value={name} disabled={busy} onChange={e=>setName(e.target.value)} /></label>
      <button type="button" className="kb-btn" data-testid="taxon-save" disabled={busy||!name.trim()} onClick={()=>void create()}>{t('catalog.createSelect')}</button>
      <button type="button" className="kb-btn" disabled={busy} onClick={()=>setNewKind(null)}>{t('common.cancel')}</button>
    </div>}
    {error && <p role="alert">{error} <button type="button" onClick={()=>setRetry(n=>n+1)}>{t('catalog.retry')}</button></p>}
  </fieldset>;
}
