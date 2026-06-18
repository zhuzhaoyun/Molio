#!/usr/bin/env node
// WeChat Article Extractor — zero-dependency CLI
// Usage: node extract.js <url>
//        node extract.js --html <file>   (extract from local HTML file)
//
// Output contract:
//   Success: stdout = Markdown body, stderr = JSON metadata, exit 0
//   Failure: stderr = [wechat-extractor] ERROR <code>: <msg>, exit non-zero
'use strict';

const fs = require('fs');
const { fetchWeixinHtml } = require('./lib/fetch');
const { detectErrorPage, extractContent, extractMetadata } = require('./lib/parser');
const { htmlToMarkdown } = require('./lib/converter');
const { getError } = require('./lib/errors');

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    const err = getError(2001);
    process.stderr.write(`[wechat-extractor] ERROR ${err.code}: ${err.msg}\n`);
    process.exit(1);
  }

  let html;
  let sourceUrl;

  if (args[0] === '--html' && args[1]) {
    // Read from local file
    try {
      html = fs.readFileSync(args[1], 'utf8');
      sourceUrl = args[2] || null;
    } catch (e) {
      process.stderr.write(`[wechat-extractor] ERROR 1003: 无法读取文件: ${e.message}\n`);
      process.exit(3);
    }
  } else {
    // Fetch from URL
    sourceUrl = args[0];

    if (!/^https?:\/\/mp\.weixin\.qq\.com/i.test(sourceUrl) &&
        !/^https?:\/\/weixin\.sogou\.com/i.test(sourceUrl)) {
      const err = getError(2009);
      process.stderr.write(`[wechat-extractor] ERROR ${err.code}: ${err.msg}\n`);
      process.exit(1);
    }

    try {
      html = await fetchWeixinHtml(sourceUrl);
    } catch (e) {
      process.stderr.write(`[wechat-extractor] ERROR 1002: ${e.message}\n`);
      process.exit(3);
    }
  }

  if (!html) {
    const err = getError(1003);
    process.stderr.write(`[wechat-extractor] ERROR ${err.code}: ${err.msg}\n`);
    process.exit(3);
  }

  // ── Detect error/risk-control pages ──
  const errorResult = detectErrorPage(html);
  if (errorResult && !errorResult.done) {
    // Special case: account migrated with redirect URL
    if (errorResult.code === 1006 && errorResult.url) {
      process.stderr.write(`[wechat-extractor] INFO 1006: ${errorResult.msg}, redirect: ${errorResult.url}\n`);
      // Try to follow redirect
      try {
        html = await fetchWeixinHtml(errorResult.url);
        sourceUrl = errorResult.url;
      } catch {
        process.stderr.write(`[wechat-extractor] ERROR 2004: 无法获取迁移后的链接\n`);
        process.exit(2);
      }
      // Re-check after redirect
      const recheck = detectErrorPage(html);
      if (recheck && !recheck.done) {
        process.stderr.write(`[wechat-extractor] ERROR ${recheck.code}: ${recheck.msg}\n`);
        process.exit(recheck.code >= 2000 ? 2 : 1);
      }
    } else {
      process.stderr.write(`[wechat-extractor] ERROR ${errorResult.code}: ${errorResult.msg}\n`);
      // Exit code 2 for risk control / content issues, 1 for general errors
      process.exit(errorResult.code >= 2000 ? 2 : 1);
    }
  }

  // ── Extract metadata ──
  const meta = extractMetadata(html);

  // ── Extract and convert content ──
  const contentHtml = extractContent(html);
  let markdown = '';

  if (contentHtml) {
    markdown = htmlToMarkdown(contentHtml);
  }

  // Fallback: use description or title as content
  if (!markdown.trim()) {
    if (meta.description) {
      markdown = meta.description + '\n';
    } else if (meta.title) {
      markdown = meta.title + '\n';
    }
  }

  // Validate minimum result
  if (!meta.title && !markdown.trim()) {
    const err = getError(1001);
    process.stderr.write(`[wechat-extractor] ERROR ${err.code}: ${err.msg}\n`);
    process.exit(1);
  }

  // Use title from content if metadata extraction missed it
  if (!meta.title) {
    const firstLine = markdown.split('\n').find(l => l.startsWith('# '));
    if (firstLine) meta.title = firstLine.replace(/^# /, '');
  }

  // ── Build metadata JSON for stderr ──
  const metaOutput = {
    title: meta.title,
    author: meta.author,
    account: meta.accountName,
    publishTime: meta.publishTimeStr,
    url: sourceUrl,
    type: meta.msgType,
    chars: markdown.length,
  };

  // Clean null values
  for (const key of Object.keys(metaOutput)) {
    if (metaOutput[key] === null || metaOutput[key] === undefined) {
      delete metaOutput[key];
    }
  }

  process.stderr.write(JSON.stringify(metaOutput) + '\n');
  process.stdout.write(markdown);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[wechat-extractor] ERROR 1000: ${err.message}\n`);
  process.exit(1);
});
