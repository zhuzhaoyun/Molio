import type { MarketContent } from '@molio/contracts';

/** 发布前最低完整性检查；与云端必填项一致（不替代云端校验）。 */
export function isMarketContentComplete(c: MarketContent): boolean {
  return Boolean(
    c.positioning.what.trim()
    && c.facts.some((f) => f.label.trim() && f.value.trim())
    && c.themes.some((t) => t.name.trim() && t.summary.trim() && t.items.length > 0)
    && c.delivery.format.trim(),
  );
}

/**
 * 提交前清理：编辑器允许新增空行/清空可选项，但云端校验会拒绝空字符串。
 * 这里只去掉空行与空的可选字段，不改变已填内容；必填项缺失由
 * isMarketContentComplete 在提交前拦截。
 */
export function sanitizeMarketContent(c: MarketContent): MarketContent {
  const text = (s: string) => s.trim();
  const optSource = (s?: string) => {
    const v = s?.trim();
    return v ? { source: v } : {};
  };
  const facts = c.facts
    .map((f) => ({ label: text(f.label), value: text(f.value) }))
    .filter((f) => f.label && f.value);
  const themes = c.themes
    .map((t) => ({
      name: text(t.name),
      summary: text(t.summary),
      items: t.items.map(text).filter(Boolean),
    }))
    .filter((t) => t.name && t.summary);
  const questions = c.questions
    .map((q) => ({ question: text(q.question), answer: text(q.answer), ...optSource(q.source) }))
    .filter((q) => q.question && q.answer);
  const samples = (c.samples ?? [])
    .map((s) => ({ title: text(s.title), body: text(s.body), ...optSource(s.source) }))
    .filter((s) => s.title && s.body);
  const seoTitle = c.seo?.title?.trim();
  const seoDescription = c.seo?.description?.trim();
  const seoAliases = (c.seo?.aliases ?? []).map(text).filter(Boolean);
  const seo = seoTitle || seoDescription || seoAliases.length > 0
    ? {
        ...(seoTitle ? { title: seoTitle } : {}),
        ...(seoDescription ? { description: seoDescription } : {}),
        ...(seoAliases.length > 0 ? { aliases: seoAliases } : {}),
      }
    : undefined;
  return {
    version: 1,
    positioning: {
      what: text(c.positioning.what),
      who: c.positioning.who.map(text).filter(Boolean),
      notFor: c.positioning.notFor.map(text).filter(Boolean),
    },
    facts,
    themes,
    questions,
    ...(samples.length > 0 ? { samples } : {}),
    delivery: {
      format: text(c.delivery.format),
      includes: c.delivery.includes.map(text).filter(Boolean),
      requirements: c.delivery.requirements.map(text).filter(Boolean),
      steps: c.delivery.steps.map(text).filter(Boolean),
    },
    review: {
      basis: text(c.review.basis) || '内容由发布者整理，发布前请核对。',
      reviewedAt: text(c.review.reviewedAt) || new Date().toISOString().slice(0, 10),
      status: c.review.status === 'reviewed' ? 'reviewed' : 'draft',
    },
    ...(seo ? { seo } : {}),
  };
}
