// @vitest-environment happy-dom
//
// isRichHtml needs a DOM (DOMParser). The main markdown-source-paste.test.ts
// runs under the default `node` env; this file opts into happy-dom just for
// the rich-HTML detection used by the paste plugin's "let core parse rendered
// content" branch.
import { describe, it, expect } from 'vitest';
import { isRichHtml } from './markdown-source-paste';

describe('isRichHtml', () => {
  it('detects rendered rich text copied from a web page / rich editor', () => {
    expect(isRichHtml('<h1>Title</h1><p>body</p>')).toBe(true);
    expect(isRichHtml('<p><strong>bold</strong> text</p>')).toBe(true);
    expect(isRichHtml('<p><em>italic</em></p>')).toBe(true);
    expect(isRichHtml('<ul><li>one</li><li>two</li></ul>')).toBe(true);
    expect(isRichHtml('<ol><li>first</li></ol>')).toBe(true);
    expect(isRichHtml('<blockquote>quote</blockquote>')).toBe(true);
    expect(isRichHtml('<p>see <a href="https://x.com">link</a></p>')).toBe(true);
    expect(isRichHtml('<table><tbody><tr><td>a</td></tr></tbody></table>')).toBe(true);
    expect(isRichHtml('<p><img src="x.png" alt="x"></p>')).toBe(true);
    expect(isRichHtml('<hr>')).toBe(true);
  });

  it('is false for code-editor syntax-highlight HTML (span/pre only)', () => {
    // VS Code / highlight.js copy: markdown source wrapped in styled spans —
    // no semantic formatting elements, so the plugin still renders it as source.
    expect(isRichHtml('<pre><span style="color:#569">#</span> Heading</pre>')).toBe(false);
    expect(isRichHtml('<div><span># Heading</span><br><span>- item</span></div>')).toBe(false);
  });

  it('is false for empty / bare plain-text wrappers', () => {
    expect(isRichHtml('')).toBe(false);
    expect(isRichHtml('   ')).toBe(false);
    expect(isRichHtml('<p>just plain text</p>')).toBe(false);
    expect(isRichHtml('plain text no tags')).toBe(false);
  });
});
