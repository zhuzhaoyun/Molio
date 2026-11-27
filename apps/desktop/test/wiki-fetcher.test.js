import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from '../src/wiki-fetcher.js';

const { buildProbeScript, buildExtractScript, CONTENT_SELECTORS } = _internal;

describe('wiki-fetcher script builders (no Electron required)', () => {
  it('exposes a stable list of content selectors', () => {
    assert.ok(Array.isArray(CONTENT_SELECTORS));
    assert.ok(CONTENT_SELECTORS.length >= 5);
    assert.ok(CONTENT_SELECTORS.every((s) => typeof s === 'string' && s.length > 0));
  });

  it('buildProbeScript returns a self-invoking JS expression', () => {
    const script = buildProbeScript();
    assert.ok(script.startsWith('(function ()'));
    assert.ok(script.endsWith('})();'));
    // Login-script hint is embedded.
    assert.ok(script.indexOf('/suite/passport/static/login/') >= 0);
    // CONTENT_SELECTORS inlined as JSON. Strings with quotes (like
    // main[role="main"]) get escaped to `main[role=\"main\"]` inside the
    // JSON literal — compare against the JSON-stringified form.
    const jsonStr = JSON.stringify(CONTENT_SELECTORS);
    assert.ok(script.indexOf(jsonStr) >= 0, 'selectors should be inlined as JSON array');
  });

  it('buildProbeScript is syntactically valid JS', () => {
    // `new Function(body)` parses the body at construction — doesn't execute.
    // Catches unbalanced braces / template-literal escapes without needing
    // a DOM (the script body references `document`, which only exists in a
    // renderer — we just want to confirm the source parses).
    assert.doesNotThrow(() => new Function(buildProbeScript()));
  });

  it('buildExtractScript embeds the html-to-markdown walker source', () => {
    const script = buildExtractScript('.render');
    assert.ok(script.startsWith('(function ()'));
    assert.ok(script.indexOf('function htmlToMarkdown') >= 0, 'walker source should be inlined');
    assert.ok(script.indexOf('document.querySelector') >= 0);
  });

  it('buildExtractScript is syntactically valid JS', () => {
    assert.doesNotThrow(() => new Function(buildExtractScript('.render')));
  });
});
