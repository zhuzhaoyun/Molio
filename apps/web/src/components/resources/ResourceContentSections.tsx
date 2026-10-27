/** 应用内资源详情：渲染与官网商品页同源的结构化内容（MarketContent）。 */
import type { MarketContent } from '@molio/contracts';
import { useI18n } from '../../i18n';

function paragraphs(text: string): string[] {
  return text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

export function ResourceContentSections({ content }: { content: MarketContent }) {
  const { t } = useI18n();
  const { positioning } = content;

  return (
    <div className="resources-content" data-testid="resources-content">
      <section className="resources-content-section">
        <h2 className="resources-section-title">{t('resources.content.what')}</h2>
        <div className="resources-article">
          {paragraphs(positioning.what).map((p, i) => (
            <p key={i} className={i === 0 ? 'resources-article__lead' : undefined}>{p}</p>
          ))}
          {(positioning.who.length > 0 || positioning.notFor.length > 0) && (
            <div className="resources-content-two-col">
              {positioning.who.length > 0 && (
                <div>
                  <h3>{t('resources.content.who')}</h3>
                  <ul>{positioning.who.map((x, i) => <li key={i}>{x}</li>)}</ul>
                </div>
              )}
              {positioning.notFor.length > 0 && (
                <div>
                  <h3>{t('resources.content.notFor')}</h3>
                  <ul>{positioning.notFor.map((x, i) => <li key={i}>{x}</li>)}</ul>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {content.facts.length > 0 && (
        <section className="resources-content-section">
          <h2 className="resources-section-title">{t('resources.content.facts')}</h2>
          <dl className="resources-content-facts">
            {content.facts.map((f, i) => (
              <div key={i}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {content.themes.length > 0 && (
        <section className="resources-content-section">
          <h2 className="resources-section-title">{t('resources.content.themes')}</h2>
          <div className="resources-content-themes">
            {content.themes.map((theme, i) => (
              <details key={i} open={i === 0}>
                <summary>{theme.name}<span>{t('resources.content.itemsCount', { count: theme.items.length })}</span></summary>
                <p>{theme.summary}</p>
                <ul>{theme.items.map((item, j) => <li key={j}>{item}</li>)}</ul>
              </details>
            ))}
          </div>
        </section>
      )}

      {content.questions.length > 0 && (
        <section className="resources-content-section">
          <h2 className="resources-section-title">{t('resources.content.questions')}</h2>
          {content.questions.map((q, i) => (
            <article className="resources-content-question" key={i}>
              <h3>{q.question}</h3>
              {paragraphs(q.answer).map((p, j) => <p key={j}>{p}</p>)}
              {q.source && <p className="resources-content-source">{t('resources.content.source')}: {q.source}</p>}
            </article>
          ))}
        </section>
      )}

      {(content.samples ?? []).length > 0 && (
        <section className="resources-content-section">
          <h2 className="resources-section-title">{t('resources.content.samples')}</h2>
          {(content.samples ?? []).map((sample, i) => (
            <article className="resources-content-sample" key={i}>
              <h3>{sample.title}</h3>
              {paragraphs(sample.body).map((p, j) => <p key={j}>{p}</p>)}
              {sample.source && <p className="resources-content-source">{t('publish.content.source')}: {sample.source}</p>}
            </article>
          ))}
        </section>
      )}

      <section className="resources-content-section">
        <h2 className="resources-section-title">{t('resources.content.delivery')}</h2>
        <div className="resources-article">
          <p><strong>{t('resources.content.format')}:</strong> {content.delivery.format}</p>
          <div className="resources-content-two-col">
            {content.delivery.includes.length > 0 && (
              <div>
                <h3>{t('resources.content.includes')}</h3>
                <ul>{content.delivery.includes.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )}
            {content.delivery.requirements.length > 0 && (
              <div>
                <h3>{t('resources.content.requirements')}</h3>
                <ul>{content.delivery.requirements.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )}
          </div>
          {content.delivery.steps.length > 0 && (
            <ol>{content.delivery.steps.map((x, i) => <li key={i}>{x}</li>)}</ol>
          )}
        </div>
      </section>

      <section className="resources-content-section">
        <h2 className="resources-section-title">{t('resources.content.review')}</h2>
        <div className="resources-article">
          <p>{content.review.basis}</p>
          <p className="resources-content-source">{t('resources.content.reviewedAt')}: {content.review.reviewedAt}</p>
          {content.review.status === 'draft' && content.review.autoDrafted === true && (
            <p className="resources-content-draft">{t('resources.content.draftNotice')}</p>
          )}
        </div>
      </section>
    </div>
  );
}
