/**
 * 商品页结构化内容编辑器 —— 发布表单内使用。
 *
 * AI 只负责起草，最终内容由发布者确认：分区编辑定位、关键事实、内容范围、
 * 典型问题、真实样例、交付说明、来源与核对、SEO 覆盖。字段上限与
 * cloud/market/service.ts 的 validateMarketContent 同口径，超长由云端拒绝。
 */
import type {
  MarketContent, MarketContentDelivery, MarketContentFact, MarketContentPositioning,
  MarketContentQuestion, MarketContentSample, MarketContentTheme,
} from '@molio/contracts';
import { useI18n } from '../../i18n';

export interface MarketContentEditorProps {
  value: MarketContent;
  onChange: (next: MarketContent) => void;
}

/** 编辑期保留空行（否则按 Enter 的空行会被回写吞掉），提交前由 sanitizeMarketContent 清理。 */
function lines(text: string): string[] {
  return text.split('\n');
}

function LinesField(props: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  rows?: number;
  testId?: string;
}) {
  return (
    <label className="publish-field publish-content-field">
      <span>{props.label}</span>
      <textarea
        rows={props.rows ?? 3}
        value={props.value.join('\n')}
        data-testid={props.testId}
        onChange={(e) => props.onChange(lines(e.target.value))}
      />
    </label>
  );
}

function TextField(props: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  testId?: string;
}) {
  return (
    <label className="publish-field publish-content-field">
      <span>{props.label}</span>
      <input
        value={props.value}
        placeholder={props.placeholder}
        data-testid={props.testId}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

function AreaField(props: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  testId?: string;
}) {
  return (
    <label className="publish-field publish-content-field">
      <span>{props.label}</span>
      <textarea
        rows={props.rows ?? 4}
        value={props.value}
        data-testid={props.testId}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

function RemoveBtn(props: { onClick: () => void; label: string; testId?: string }) {
  return (
    <button type="button" className="publish-content-remove" data-testid={props.testId} onClick={props.onClick}>
      {props.label}
    </button>
  );
}

export function MarketContentEditor({ value, onChange }: MarketContentEditorProps) {
  const { t } = useI18n();
  const patch = (p: Partial<MarketContent>) => onChange({ ...value, ...p });

  const setPositioning = (p: Partial<MarketContentPositioning>) =>
    patch({ positioning: { ...value.positioning, ...p } });
  const setDelivery = (p: Partial<MarketContentDelivery>) =>
    patch({ delivery: { ...value.delivery, ...p } });

  const setFact = (i: number, p: Partial<MarketContentFact>) => {
    const facts = value.facts.map((f, j) => (j === i ? { ...f, ...p } : f));
    patch({ facts });
  };
  const setTheme = (i: number, p: Partial<MarketContentTheme>) => {
    const themes = value.themes.map((x, j) => (j === i ? { ...x, ...p } : x));
    patch({ themes });
  };
  const setQuestion = (i: number, p: Partial<MarketContentQuestion>) => {
    const questions = value.questions.map((x, j) => (j === i ? { ...x, ...p } : x));
    patch({ questions });
  };
  const setSample = (i: number, p: Partial<MarketContentSample>) => {
    const samples = (value.samples ?? []).map((x, j) => (j === i ? { ...x, ...p } : x));
    patch({ samples });
  };

  return (
    <div className="publish-content-editor" data-testid="market-content-editor">
      <section className="publish-content-section">
        <h4>{t('publish.content.positioning')}</h4>
        <AreaField label={t('publish.content.what')} value={value.positioning.what}
          onChange={(what) => setPositioning({ what })} rows={5} testId="content-positioning-what" />
        <LinesField label={t('publish.content.who')} value={value.positioning.who}
          onChange={(who) => setPositioning({ who })} testId="content-positioning-who" />
        <LinesField label={t('publish.content.notFor')} value={value.positioning.notFor}
          onChange={(notFor) => setPositioning({ notFor })} testId="content-positioning-notfor" />
      </section>

      <section className="publish-content-section">
        <div className="publish-content-head">
          <h4>{t('publish.content.facts')}</h4>
          <button type="button" className="publish-content-add" data-testid="content-fact-add"
            onClick={() => patch({ facts: [...value.facts, { label: '', value: '' }] })}>
            + {t('publish.content.add')}
          </button>
        </div>
        {value.facts.map((f, i) => (
          <div className="publish-content-row" key={i}>
            <input value={f.label} placeholder={t('publish.content.label')} aria-label={t('publish.content.label')}
              onChange={(e) => setFact(i, { label: e.target.value })} />
            <input value={f.value} placeholder={t('publish.content.value')} aria-label={t('publish.content.value')}
              onChange={(e) => setFact(i, { value: e.target.value })} />
            <RemoveBtn label={t('publish.content.remove')} testId={'content-fact-remove-' + i}
              onClick={() => patch({ facts: value.facts.filter((_, j) => j !== i) })} />
          </div>
        ))}
      </section>

      <section className="publish-content-section">
        <div className="publish-content-head">
          <h4>{t('publish.content.themes')}</h4>
          <button type="button" className="publish-content-add" data-testid="content-theme-add"
            onClick={() => patch({ themes: [...value.themes, { name: '', summary: '', items: [] }] })}>
            + {t('publish.content.add')}
          </button>
        </div>
        {value.themes.map((theme, i) => (
          <div className="publish-content-card" key={i}>
            <TextField label={t('publish.content.themeName')} value={theme.name}
              onChange={(name) => setTheme(i, { name })} testId={'content-theme-name-' + i} />
            <AreaField label={t('publish.content.themeSummary')} value={theme.summary}
              onChange={(summary) => setTheme(i, { summary })} rows={2} testId={'content-theme-summary-' + i} />
            <LinesField label={t('publish.content.items')} value={theme.items}
              onChange={(items) => setTheme(i, { items })} rows={4} testId={'content-theme-items-' + i} />
            <RemoveBtn label={t('publish.content.remove')} testId={'content-theme-remove-' + i}
              onClick={() => patch({ themes: value.themes.filter((_, j) => j !== i) })} />
          </div>
        ))}
      </section>

      <section className="publish-content-section">
        <div className="publish-content-head">
          <h4>{t('publish.content.questions')}</h4>
          <button type="button" className="publish-content-add" data-testid="content-question-add"
            onClick={() => patch({ questions: [...value.questions, { question: '', answer: '', source: '' }] })}>
            + {t('publish.content.add')}
          </button>
        </div>
        {value.questions.map((q, i) => (
          <div className="publish-content-card" key={i}>
            <TextField label={t('publish.content.question')} value={q.question}
              onChange={(question) => setQuestion(i, { question })} testId={'content-question-title-' + i} />
            <AreaField label={t('publish.content.answer')} value={q.answer}
              onChange={(answer) => setQuestion(i, { answer })} rows={4} testId={'content-question-answer-' + i} />
            <TextField label={t('publish.content.source')} value={q.source ?? ''}
              onChange={(source) => setQuestion(i, { source })} testId={'content-question-source-' + i} />
            <RemoveBtn label={t('publish.content.remove')} testId={'content-question-remove-' + i}
              onClick={() => patch({ questions: value.questions.filter((_, j) => j !== i) })} />
          </div>
        ))}
      </section>

      <section className="publish-content-section">
        <div className="publish-content-head">
          <h4>{t('publish.content.samples')}</h4>
          <button type="button" className="publish-content-add" data-testid="content-sample-add"
            onClick={() => patch({ samples: [...(value.samples ?? []), { title: '', body: '', source: '' }] })}>
            + {t('publish.content.add')}
          </button>
        </div>
        {(value.samples ?? []).map((s, i) => (
          <div className="publish-content-card" key={i}>
            <TextField label={t('publish.content.sampleTitle')} value={s.title}
              onChange={(title) => setSample(i, { title })} testId={'content-sample-title-' + i} />
            <AreaField label={t('publish.content.sampleBody')} value={s.body}
              onChange={(body) => setSample(i, { body })} rows={4} testId={'content-sample-body-' + i} />
            <TextField label={t('publish.content.source')} value={s.source ?? ''}
              onChange={(source) => setSample(i, { source })} testId={'content-sample-source-' + i} />
            <RemoveBtn label={t('publish.content.remove')} testId={'content-sample-remove-' + i}
              onClick={() => patch({ samples: (value.samples ?? []).filter((_, j) => j !== i) })} />
          </div>
        ))}
      </section>

      <section className="publish-content-section">
        <h4>{t('publish.content.delivery')}</h4>
        <TextField label={t('publish.content.format')} value={value.delivery.format}
          onChange={(format) => setDelivery({ format })} testId="content-delivery-format" />
        <LinesField label={t('publish.content.includes')} value={value.delivery.includes}
          onChange={(includes) => setDelivery({ includes })} testId="content-delivery-includes" />
        <LinesField label={t('publish.content.requirements')} value={value.delivery.requirements}
          onChange={(requirements) => setDelivery({ requirements })} testId="content-delivery-requirements" />
        <LinesField label={t('publish.content.steps')} value={value.delivery.steps}
          onChange={(steps) => setDelivery({ steps })} testId="content-delivery-steps" />
      </section>

      <section className="publish-content-section">
        <h4>{t('publish.content.review')}</h4>
        <AreaField label={t('publish.content.reviewBasis')} value={value.review.basis}
          onChange={(basis) => patch({ review: { ...value.review, basis } })} rows={2} testId="content-review-basis" />
        <div className="publish-content-row">
          <label className="publish-field publish-content-field">
            <span>{t('publish.content.reviewedAt')}</span>
            <input type="date" value={value.review.reviewedAt}
              onChange={(e) => patch({ review: { ...value.review, reviewedAt: e.target.value } })}
              data-testid="content-review-date" />
          </label>
          <label className="publish-field publish-content-field">
            <span>{t('publish.content.status')}</span>
            <select value={value.review.status}
              onChange={(e) => patch({ review: { ...value.review, status: e.target.value === 'reviewed' ? 'reviewed' : 'draft' } })}
              data-testid="content-review-status">
              <option value="draft">{t('publish.content.statusDraft')}</option>
              <option value="reviewed">{t('publish.content.statusReviewed')}</option>
            </select>
          </label>
        </div>
      </section>

      <section className="publish-content-section">
        <h4>{t('publish.content.seo')}</h4>
        <TextField label={t('publish.content.seoTitle')} value={value.seo?.title ?? ''}
          onChange={(title) => patch({ seo: { ...value.seo, title } })} testId="content-seo-title" />
        <AreaField label={t('publish.content.seoDescription')} value={value.seo?.description ?? ''}
          onChange={(description) => patch({ seo: { ...value.seo, description } })} rows={2} testId="content-seo-description" />
        <LinesField label={t('publish.content.aliases')} value={value.seo?.aliases ?? []}
          onChange={(aliases) => patch({ seo: { ...value.seo, aliases } })} testId="content-seo-aliases" />
      </section>
    </div>
  );
}
