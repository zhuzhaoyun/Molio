// Zero-dependency HTML parser for WeChat articles.
// Extracts metadata from <script> tags and content from #js_content.
// Borrows detection logic from https://github.com/freestylefly/wechat-article-extractor-skill
// but replaces cheerio/new Function with regex-based parsing.
'use strict';

const { getError } = require('./errors');

// ─── Risk control & error page detection ───

/**
 * Check HTML for known error/risk-control pages.
 * Returns an error result if detected, null otherwise.
 */
function detectErrorPage(html) {
  const hasContent = html.includes('id="js_content"') || html.includes('id=\\"js_content\\"');

  if (html.includes('访问过于频繁') && !hasContent) return getError(1004);
  if (html.includes('链接已过期') && !hasContent) return getError(2002);
  if (html.includes('被投诉且经审核涉嫌侵权，无法查看')) return getError(2003);

  if (html.includes('该公众号已迁移')) {
    const match = html.match(/var\s+transferTargetLink\s*=\s*['"](.*?)['"]/);
    if (match && match[1]) {
      return { ...getError(1006), url: match[1] };
    }
    return getError(2004);
  }

  if (html.includes('该内容已被发布者删除')) return getError(2005);
  if (html.includes('此内容因违规无法查看')) return getError(2006);
  if (html.includes('此内容发送失败无法查看')) return getError(2007);
  if (html.includes('由用户投诉并经平台审核，涉嫌过度营销')) return getError(2011);
  if (html.includes('此帐号已被屏蔽') && !hasContent) return getError(2012);
  if (html.includes('此帐号已自主注销') && !hasContent) return getError(2013);
  if (!hasContent && html.includes('此帐号处于帐号迁移流程中')) return getError(2015);
  if (html.includes('page_rumor') && !hasContent) return getError(2014);
  if (html.includes('投诉类型') && html.includes('冒名侵权')) return getError(2016);

  // Generic system error
  const sysErrMatch = html.match(/class=["']global_error_msg[^"']*["'][^>]*>([^<]*)/);
  if (sysErrMatch && sysErrMatch[1].includes('系统出错')) return getError(2008);

  // Link expired via weui-msg
  const weuiMatch = html.match(/class=["']weui-msg__title["'][^>]*>([^<]*)/);
  if (weuiMatch && weuiMatch[1].trim() === '链接已过期') return getError(2002);

  if (!hasContent && !html.includes('cover_url')) {
    return getError(1000);
  }

  return null;
}

// ─── Content extraction ───

/**
 * Extract the main article HTML content from #js_content.
 * Uses tag-depth counting to handle nested <div> elements correctly.
 * @param {string} html
 * @returns {string|null} inner HTML of #js_content, or null
 */
function extractContent(html) {
  // Find the opening tag with id="js_content"
  const openMatch = html.match(/<div[^>]+id=["']js_content["'][^>]*>/i);
  if (!openMatch) return null;

  const startIdx = openMatch.index + openMatch[0].length;
  const rest = html.slice(startIdx);

  // Count div depth to find the matching closing </div>
  let depth = 1;
  let pos = 0;
  while (depth > 0 && pos < rest.length) {
    const nextOpen = rest.indexOf('<div', pos);
    const nextClose = rest.indexOf('</div>', pos);

    if (nextClose === -1) break;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Check it's actually a <div tag (not <divider etc.)
      const charAfter = rest[nextOpen + 4];
      if (charAfter === ' ' || charAfter === '>' || charAfter === '\n' || charAfter === '\r' || charAfter === '/') {
        depth++;
      }
      pos = nextOpen + 4;
    } else {
      depth--;
      if (depth === 0) {
        return rest.slice(0, nextClose).trim();
      }
      pos = nextClose + 6;
    }
  }

  // Fallback: if depth counting failed, try to grab until next major section
  const fallback = rest.match(/^([\s\S]*?)(?=<div\s+(?:id|class)=["'](?!js_content))/i);
  if (fallback && fallback[1]) {
    return fallback[1].trim();
  }

  // Last resort: return everything up to </body> or end
  const bodyEnd = rest.indexOf('</body>');
  if (bodyEnd > 0) return rest.slice(0, bodyEnd).trim();

  return rest.trim() || null;
}

// ─── Metadata extraction from <script> tags ───

/**
 * Safely extract a JS variable value from script content using regex.
 * Handles: var x = "value"; / var x = 'value'; / var x = 123;
 */
function extractVar(scriptContent, varName) {
  // Try string values first
  const strPattern = new RegExp(`(?:var\\s+${varName}|window\\.${varName})\\s*=\\s*['"]([^'"]*)['"]`);
  const strMatch = scriptContent.match(strPattern);
  if (strMatch) return strMatch[1];

  // Try numeric values
  const numPattern = new RegExp(`(?:var\\s+${varName}|window\\.${varName})\\s*=\\s*(\\d+)`);
  const numMatch = scriptContent.match(numPattern);
  if (numMatch) return numMatch[1];

  return null;
}

/**
 * Extract metadata from page scripts and DOM.
 * @param {string} html
 * @returns {object} metadata object
 */
function extractMetadata(html) {
  const meta = {
    title: null,
    author: null,
    accountName: null,
    accountId: null,
    accountBiz: null,
    accountAvatar: null,
    publishTime: null,
    publishTimeStr: null,
    description: null,
    coverUrl: null,
    sourceUrl: null,
    msgType: 'post',
    sn: null,
    mid: null,
    idx: null,
  };

  // ── Extract from <meta> tags ──
  const ogTitle = html.match(/property=["']og:title["']\s+content=["']([^"']*)["']/i);
  if (ogTitle) meta.title = decodeHtmlEntities(ogTitle[1]);

  const ogDesc = html.match(/property=["']og:description["']\s+content=["']([^"']*)["']/i);
  if (ogDesc) meta.description = decodeHtmlEntities(ogDesc[1]);

  const ogImage = html.match(/property=["']og:image["']\s+content=["']([^"']*)["']/i);
  if (ogImage) meta.coverUrl = ogImage[1];

  const metaAuthor = html.match(/name=["']author["']\s+content=["']([^"']*)["']/i);
  if (metaAuthor) meta.author = decodeHtmlEntities(metaAuthor[1]);

  const metaDesc = html.match(/name=["']description["']\s+content=["']([^"']*)["']/i);
  if (metaDesc && !meta.description) meta.description = decodeHtmlEntities(metaDesc[1]);

  // ── Extract from <script> tags ──
  const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];

  for (const scriptTag of scripts) {
    const content = scriptTag.replace(/<\/?script[^>]*>/gi, '');

    // Post/repost type: var msg_link = ...
    if (content.includes('var msg_link') || content.includes('var msg_title')) {
      const title = extractVar(content, 'msg_title');
      if (title) meta.title = decodeHtmlEntities(title);

      const desc = extractVar(content, 'msg_desc');
      if (desc) meta.description = decodeHtmlEntities(desc);

      const link = extractVar(content, 'msg_link');
      if (link) meta.sourceUrl = link.replace(/&amp;/g, '&');

      const cdnUrl = extractVar(content, 'msg_cdn_url');
      if (cdnUrl) meta.coverUrl = cdnUrl;

      const nickname = extractVar(content, 'nickname');
      if (nickname) meta.accountName = decodeHtmlEntities(nickname);

      const userName = extractVar(content, 'user_name');
      if (userName) meta.accountId = userName;

      const headImg = extractVar(content, 'ori_head_img_url');
      if (headImg) meta.accountAvatar = headImg;

      const biz = extractVar(content, 'biz');
      if (biz) meta.accountBiz = biz;

      const ct = extractVar(content, 'ct');
      if (ct) {
        const ts = parseInt(ct, 10);
        if (ts > 1000000000) {
          meta.publishTime = new Date(ts * 1000);
          meta.publishTimeStr = formatDate(meta.publishTime);
        }
      }

      const sn = extractVar(content, 'sn');
      if (sn) meta.sn = sn;

      const mid = extractVar(content, 'mid');
      if (mid) meta.mid = mid;

      const idx = extractVar(content, 'idx');
      if (idx) meta.idx = idx;
    }

    // Image/voice/video type: d.title = ...
    if (content.includes('d.title') && content.includes('d.create_time')) {
      const dTitle = content.match(/d\.title\s*=\s*['"]([^'"]*)['"]/);
      if (dTitle && !meta.title) meta.title = decodeHtmlEntities(dTitle[1]);

      const dNick = content.match(/d\.nick_name\s*=\s*['"]([^'"]*)['"]/);
      if (dNick && !meta.accountName) meta.accountName = decodeHtmlEntities(dNick[1]);

      const dUser = content.match(/d\.user_name\s*=\s*['"]([^'"]*)['"]/);
      if (dUser && !meta.accountId) meta.accountId = dUser[1];

      const dHead = content.match(/d\.hd_head_img\s*=\s*['"]([^'"]*)['"]/);
      if (dHead && !meta.accountAvatar) meta.accountAvatar = dHead[1];

      const dBiz = content.match(/d\.biz\s*=\s*['"]([^'"]*)['"]/);
      if (dBiz && !meta.accountBiz) meta.accountBiz = dBiz[1];

      const dCt = content.match(/d\.create_time\s*=\s*['"]?(\d+)['"]?/);
      if (dCt && !meta.publishTime) {
        const ts = parseInt(dCt[1], 10);
        if (ts > 1000000000) {
          meta.publishTime = new Date(ts * 1000);
          meta.publishTimeStr = formatDate(meta.publishTime);
        }
      }
    }

    // Voice type: voiceid
    if (content.includes('voiceid')) {
      meta.msgType = 'voice';
      const voiceMatch = content.match(/voiceid['":\s]+([A-Za-z0-9_-]+)/);
      if (voiceMatch) {
        meta.sourceUrl = `https://res.wx.qq.com/voice/getvoice?mediaid=${voiceMatch[1]}`;
      }
    }
  }

  // ── Detect article type ──
  if (/video/.test(html.match(/<body[^>]*class=["']([^"']*)["']/i)?.[1] || '')) {
    meta.msgType = 'video';
  }
  if (html.includes('id="img_list"') || html.includes('picture_page_info_list')) {
    meta.msgType = 'image';
  }
  if (html.includes('id="js_share_content"')) {
    meta.msgType = 'repost';
  }
  if (html.includes('page_share_audio') || html.includes('id="voice_parent"')) {
    meta.msgType = 'voice';
  }

  // ── Fallback: DOM-based extraction ──
  if (!meta.title) {
    const titleMatch = html.match(/class=["']rich_media_title["'][^>]*>([\s\S]*?)<\/h[12]>/i);
    if (titleMatch) meta.title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '').trim());
  }

  if (!meta.accountName) {
    const nickMatch = html.match(/class=["']profile_nickname["'][^>]*>([^<]*)/i);
    if (nickMatch) meta.accountName = decodeHtmlEntities(nickMatch[1].trim());
    if (!meta.accountName) {
      const followMatch = html.match(/class=["']wx_follow_nickname["'][^>]*>([^<]*)/i);
      if (followMatch) meta.accountName = decodeHtmlEntities(followMatch[1].trim());
    }
  }

  if (!meta.author) {
    const authorMatch = html.match(/id=["']js_author_name["'][^>]*>([^<]*)/i);
    if (authorMatch) meta.author = decodeHtmlEntities(authorMatch[1].trim());
  }

  if (!meta.publishTime) {
    const dateMatch = html.match(/id=["'](?:post-date|publish_time)["'][^>]*>([^<]*)/i);
    if (dateMatch) {
      const d = new Date(dateMatch[1].trim());
      if (!isNaN(d.getTime())) {
        meta.publishTime = d;
        meta.publishTimeStr = formatDate(d);
      }
    }
  }

  // Fallback publish time from ct in HTML
  if (!meta.publishTime) {
    const ctMatch = html.match(/\.ct\s*=\s*["'](\d+)["']/);
    if (ctMatch) {
      const ts = parseInt(ctMatch[1], 10);
      if (ts > 1000000000) {
        meta.publishTime = new Date(ts * 1000);
        meta.publishTimeStr = formatDate(meta.publishTime);
      }
    }
  }

  // Fallback description from content text
  if (!meta.description && meta.msgType !== 'video') {
    // Will be filled after content extraction if needed
  }

  // Extract biz number
  if (meta.accountBiz && !meta.accountBizNumber) {
    try {
      meta.accountBizNumber = parseInt(Buffer.from(meta.accountBiz, 'base64').toString(), 10);
    } catch { /* ignore */ }
  }

  return meta;
}

// ─── Helpers ───

function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&yen;/g, '¥');
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}/${m}/${d} ${h}:${min}:${s}`;
}

module.exports = { detectErrorPage, extractContent, extractMetadata, decodeHtmlEntities };
