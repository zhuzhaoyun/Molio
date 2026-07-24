import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown } from '../src/html-to-markdown.js';

/**
 * Minimal DOM mock — just enough surface for htmlToMarkdown's walker
 * (nodeType / nodeValue / tagName / textContent / childNodes / children /
 * getAttribute / parentElement). No jsdom dependency: the walker is pure DOM
 * reads, so hand-built nodes are sufficient and keep the test fast.
 */

function textContentOf(node) {
  if (node.nodeType === 3) return node.nodeValue || '';
  return (node.childNodes || []).map(textContentOf).join('');
}

function text(value) {
  return { nodeType: 3, nodeValue: value, parentElement: null };
}

function el(tag, children = []) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: children,
    children: children.filter((c) => c.nodeType === 1),
    parentElement: null,
    checked: false,
    getAttribute: () => null,
    textContent: '',
  };
  for (const child of children) child.parentElement = node;
  node.textContent = textContentOf(node);
  return node;
}

describe('htmlToMarkdown — lists (regression: infinite recursion)', () => {
  it('renders an unordered list without recursing forever', () => {
    // <ul><li>A</li><li>B</li></ul>
    const ul = el('ul', [el('li', [text('A')]), el('li', [text('B')])]);
    let md;
    assert.doesNotThrow(() => { md = htmlToMarkdown(ul); });
    assert.match(md, /- A/);
    assert.match(md, /- B/);
  });

  it('renders an ordered list with numbered prefixes', () => {
    // <ol><li>first</li><li>second</li></ol>
    const ol = el('ol', [el('li', [text('first')]), el('li', [text('second')])]);
    let md;
    assert.doesNotThrow(() => { md = htmlToMarkdown(ol); });
    assert.match(md, /1\. first/);
    assert.match(md, /2\. second/);
  });

  it('renders a nested list', () => {
    // <ul><li>A<ul><li>A1</li></ul></li></ul>
    const inner = el('ul', [el('li', [text('A1')])]);
    const outer = el('ul', [el('li', [text('A'), inner])]);
    let md;
    assert.doesNotThrow(() => { md = htmlToMarkdown(outer); });
    assert.match(md, /A/);
    assert.match(md, /A1/);
  });

  it('renders a list reached via a wrapping container', () => {
    // <div><ul><li>X</li></ul></div> — mirrors the real .bear-web-x-container
    // wrapper that matched before the converter blew up.
    const div = el('div', [el('ul', [el('li', [text('X')])])]);
    let md;
    assert.doesNotThrow(() => { md = htmlToMarkdown(div); });
    assert.match(md, /- X/);
  });
});

describe('htmlToMarkdown — blockquote (regression: infinite recursion)', () => {
  it('renders a blockquote without recursing forever', () => {
    // <blockquote><p>quoted</p></blockquote>
    const bq = el('blockquote', [el('p', [text('quoted')])]);
    let md;
    assert.doesNotThrow(() => { md = htmlToMarkdown(bq); });
    assert.match(md, /> quoted/);
  });

  it('renders a blockquote nested in a container', () => {
    const div = el('div', [el('blockquote', [text('note')])]);
    let md;
    assert.doesNotThrow(() => { md = htmlToMarkdown(div); });
    assert.match(md, /> note/);
  });
});

describe('htmlToMarkdown — basics still work', () => {
  it('renders headings, paragraphs and emphasis', () => {
    const root = el('div', [
      el('h1', [text('Title')]),
      el('p', [text('Hello '), el('strong', [text('world')])]),
    ]);
    const md = htmlToMarkdown(root);
    assert.match(md, /# Title/);
    assert.match(md, /Hello \*\*world\*\*/);
  });
});
