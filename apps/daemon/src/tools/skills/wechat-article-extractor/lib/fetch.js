// Zero-dependency HTTP fetch for WeChat articles.
// Uses Node built-in fetch with browser-like UA.
'use strict';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * Fetch a WeChat article HTML page.
 * Respects HTTPS_PROXY / HTTP_PROXY environment variables (Node fetch honours them natively).
 * @param {string} url
 * @returns {Promise<string>} HTML body
 */
async function fetchWeixinHtml(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return response.text();
}

module.exports = { fetchWeixinHtml };
