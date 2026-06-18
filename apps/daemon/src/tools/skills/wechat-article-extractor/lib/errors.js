// Error codes for WeChat article extraction.
// Borrowed from https://github.com/freestylefly/wechat-article-extractor-skill
'use strict';

const ERRORS = {
  1000: '文章获取失败',
  1001: '无法获取文章信息',
  1002: '请求失败',
  1003: '响应为空',
  1004: '访问过于频繁',
  1005: '脚本解析失败',
  1006: '公众号已迁移',
  2001: '请提供文章内容或链接',
  2002: '链接已过期',
  2003: '内容涉嫌侵权，无法查看',
  2004: '无法获取迁移后的链接',
  2005: '内容已被发布者删除',
  2006: '内容因违规无法查看',
  2007: '内容发送失败无法查看',
  2008: '系统出错',
  2009: '不支持的链接',
  2010: '内容获取失败',
  2011: '由用户投诉并经平台审核，涉嫌过度营销、骚扰用户',
  2012: '此帐号已被屏蔽，内容无法查看',
  2013: '此帐号已自主注销，内容无法查看',
  2014: '此内容被投诉且经审核确认存在不实信息',
  2015: '此帐号处于帐号迁移流程中',
  2016: '由用户投诉并经平台审核，涉嫌冒名侵权',
};

/**
 * Build an error result object.
 * @param {number} code
 * @returns {{ done: false, code: number, msg: string }}
 */
function getError(code) {
  return { done: false, code, msg: ERRORS[code] || `未知错误 (${code})` };
}

module.exports = { ERRORS, getError };
