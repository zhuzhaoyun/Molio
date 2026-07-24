import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMolioPrompt, buildWeixinFrameMessage } from '../../../src/core/weixin/message.js';

/**
 * The weixin channel role frame used to ride `--append-system-prompt-file`,
 * which the CLI silently dropped (the frame never reached the model, so weixin
 * mechanics + wiki retrieval never applied). It is now prepended to the first
 * weixin message of a fresh run — a channel that always reaches the model.
 * These tests pin that the frame actually wraps the user message and carries
 * the behaviors that used to live only in the system prompt.
 */
describe('weixin channel frame message-prepend', () => {
  it('wraps the user message with the channel frame', () => {
    const out = buildWeixinFrameMessage('介绍一下韩立');
    // Frame identity + routing reach the model.
    assert.ok(out.includes('微信入口助手'), 'carries the weixin channel identity');
    assert.ok(out.includes('wiki-query'), 'routes knowledge questions to the wiki-query skill');
    // Channel mechanics that used to live only in the system prompt survive.
    assert.ok(out.includes('raw/wechat'), 'keeps the raw/wechat 收件暂存 rule');
    assert.ok(out.includes('<attach path='), 'keeps the <attach/> file-return convention');
    // The actual user text is preserved after the frame.
    assert.ok(out.includes('## 本次微信消息'), 'marks the user message section');
    assert.ok(out.includes('介绍一下韩立'), 'preserves the user text');
    // Frame precedes the user message.
    assert.ok(out.indexOf('微信入口助手') < out.indexOf('介绍一下韩立'), 'frame comes before the user text');
  });

  it('composes with the article-URL prepend (mp.weixin link)', () => {
    const url = 'https://mp.weixin.qq.com/s/abc123';
    const out = buildWeixinFrameMessage(url);
    // Both the channel frame and the article-handling instruction are present.
    assert.ok(out.includes('微信入口助手'), 'channel frame present');
    assert.ok(out.includes('公众号文章链接'), 'article-URL handling present');
    assert.ok(out.includes(url), 'the url is preserved');
  });

  it('leaves a plain non-URL message unwrapped by buildMolioPrompt', () => {
    // buildMolioPrompt only prepends for article URLs; plain text passes through.
    assert.equal(buildMolioPrompt('普通的知识库问题'), '普通的知识库问题');
  });
});
