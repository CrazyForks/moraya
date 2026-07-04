// @vitest-environment happy-dom
/**
 * REAL-DOM mount tests for the Typora-style math NodeViews.
 *
 * These construct an actual EditorView with the same nodeViews wiring as
 * setup.ts and drive it through DOM events — verifying the live interaction
 * path (click → source opens → edit → blur → committed), not just helper
 * functions in isolation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Schema } from 'prosemirror-model';

// Mock $lib/i18n: the real module preloads @moraya/core locale JSONs via
// dynamic import, which node's ESM loader rejects here (missing import
// attributes). The NodeView only needs `get(t)('math.placeholder')`.
vi.mock('$lib/i18n', async () => {
  const { readable } = await import('svelte/store');
  return { t: readable((key: string) => key) };
});

import { schema } from './schema';
import { parseMarkdown } from './markdown';
import { mathBlockNodeView, mathInlineNodeView, highlightLatex } from './math-node-views';

let host: HTMLDivElement;
let view: EditorView | null = null;

function mount(md: string): EditorView {
  const doc = parseMarkdown(md);
  const state = EditorState.create({ schema: schema as Schema, doc });
  view = new EditorView(host, {
    state,
    nodeViews: {
      math_block: mathBlockNodeView as never,
      math_inline: mathInlineNodeView as never,
    },
  });
  return view;
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  view?.destroy();
  view = null;
  host.remove();
});

describe('math_block NodeView (in-place source editing)', () => {
  it('renders the preview, source row hidden initially', () => {
    mount('$$\nx_0 + y\n$$');
    const nv = host.querySelector('.math-block-nodeview')!;
    expect(nv).toBeTruthy();
    // happy-dom runs in quirks mode → KaTeX may fall back to raw text; either
    // way the preview must contain the formula content and the source row
    // must start hidden.
    expect(nv.querySelector('.math-preview')?.textContent).toContain('x');
    expect((nv.querySelector('.math-src-row') as HTMLElement).style.display).toBe('none');
  });

  it('click opens the source row above the preview with the LaTeX value', () => {
    mount('$$\nR_m = x\n$$');
    const nv = host.querySelector('.math-block-nodeview')!;
    click(nv.querySelector('.math-preview')!);
    const row = nv.querySelector('.math-src-row') as HTMLElement;
    expect(row.style.display).toBe('');
    const ta = nv.querySelector('textarea.math-src-input') as HTMLTextAreaElement;
    expect(ta.value).toBe('R_m = x');
    // source row sits BEFORE the preview in the flow (reference layout)
    expect(row.nextElementSibling?.classList.contains('math-preview')).toBe(true);
  });

  it('editing + blur commits the new LaTeX into attrs.value', () => {
    const v = mount('$$\nR_m = x\n$$');
    const nv = host.querySelector('.math-block-nodeview')!;
    click(nv.querySelector('.math-preview')!);
    const ta = nv.querySelector('textarea.math-src-input') as HTMLTextAreaElement;
    ta.value = 'R_m = y^2';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new FocusEvent('blur'));

    let value = '';
    v.state.doc.descendants(n => { if (n.type.name === 'math_block') value = n.attrs.value; });
    expect(value).toBe('R_m = y^2');
    // back to rendered-only display
    expect((nv.querySelector('.math-src-row') as HTMLElement).style.display).toBe('none');
  });

  it('Escape reverts without committing', () => {
    const v = mount('$$\na + b\n$$');
    const nv = host.querySelector('.math-block-nodeview')!;
    click(nv.querySelector('.math-preview')!);
    const ta = nv.querySelector('textarea.math-src-input') as HTMLTextAreaElement;
    ta.value = 'CHANGED';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    let value = '';
    v.state.doc.descendants(n => { if (n.type.name === 'math_block') value = n.attrs.value; });
    expect(value).toBe('a + b');
  });

  it('clearing the source and blurring deletes the formula node', () => {
    const v = mount('$$\nz\n$$');
    const nv = host.querySelector('.math-block-nodeview')!;
    click(nv.querySelector('.math-preview')!);
    const ta = nv.querySelector('textarea.math-src-input') as HTMLTextAreaElement;
    ta.value = '';
    ta.dispatchEvent(new FocusEvent('blur'));

    let found = false;
    v.state.doc.descendants(n => { if (n.type.name === 'math_block') found = true; });
    expect(found).toBe(false);
  });
});

describe('math_inline NodeView', () => {
  it('click swaps rendered formula for the inline source field', () => {
    mount('value $x_0$ here');
    const nv = host.querySelector('.math-inline-nodeview')!;
    click(nv.querySelector('.math-preview-inline')!);
    const input = nv.querySelector('input.math-src-input') as HTMLInputElement;
    expect((nv.querySelector('.math-src-inline') as HTMLElement).style.display).toBe('');
    expect((nv.querySelector('.math-preview-inline') as HTMLElement).style.display).toBe('none');
    expect(input.value).toBe('x_0');
  });

  it('edit + blur commits new LaTeX into the text child', () => {
    const v = mount('value $x_0$ here');
    const nv = host.querySelector('.math-inline-nodeview')!;
    click(nv.querySelector('.math-preview-inline')!);
    const input = nv.querySelector('input.math-src-input') as HTMLInputElement;
    input.value = '\\alpha_1';
    input.dispatchEvent(new FocusEvent('blur'));

    let text = '';
    v.state.doc.descendants(n => { if (n.type.name === 'math_inline') text = n.textContent; });
    expect(text).toBe('\\alpha_1');
  });
});

// ── Focus-race regression guard ───────────────────────────────────────
// THE bug that shipped "looking done" three times: after enterEdit() opened
// the source field, ProseMirror's own click handling ran afterwards and called
// view.focus(), stealing focus from the textarea → blur → the source row closed
// in the same frame ("click does nothing"). happy-dom never runs PM's
// click→focus path so it couldn't catch it; only real WebKit did.
//
// The fix is NodeView.stopEvent() returning true for mouse events so PM skips
// its click handling entirely. Lock that contract here so it can't regress.
describe('stopEvent swallows mouse events (focus-race guard)', () => {
  function makeBlockNodeView() {
    const v = mount('$$\nx\n$$');
    // build a standalone NodeView instance to probe stopEvent directly
    const node = v.state.doc.firstChild!;
    return mathBlockNodeView(node, v, () => 0);
  }
  function makeInlineNodeView() {
    const v = mount('a $x$ b');
    let node = v.state.doc.firstChild!;
    node.forEach(c => { if (c.type.name === 'math_inline') node = c; });
    return mathInlineNodeView(node, v, () => 2);
  }

  for (const type of ['mousedown', 'mouseup', 'click'] as const) {
    it(`math_block stopEvent('${type}') === true`, () => {
      const nv = makeBlockNodeView();
      expect(nv.stopEvent!(new MouseEvent(type))).toBe(true);
    });
    it(`math_inline stopEvent('${type}') === true`, () => {
      const nv = makeInlineNodeView();
      expect(nv.stopEvent!(new MouseEvent(type))).toBe(true);
    });
  }
});

// ── LaTeX syntax-highlight backdrop ───────────────────────────────────
describe('highlightLatex (source token coloring)', () => {
  it('wraps control sequences in .tok-cmd', () => {
    expect(highlightLatex('\\frac{a}{b}')).toContain('<span class="tok-cmd">\\frac</span>');
  });

  it('colors braces and sub/superscript markers distinctly', () => {
    const html = highlightLatex('x^2_i');
    expect(html).toContain('<span class="tok-script">^</span>');
    expect(html).toContain('<span class="tok-script">_</span>');
    expect(highlightLatex('{x}')).toContain('<span class="tok-brace">{</span>');
  });

  it('treats an escaped single char as one command token', () => {
    // \\ (line break) and \, (thin space) are single-char control sequences
    expect(highlightLatex('a\\\\b')).toContain('<span class="tok-cmd">\\\\</span>');
  });

  it('escapes HTML so the innerHTML backdrop cannot be injected', () => {
    const html = highlightLatex('a < b > c & d');
    expect(html).toContain('&lt;');
    expect(html).toContain('&gt;');
    expect(html).not.toContain('<b >');
    // & inside plain text is escaped; & as an alignment tab is its own token
    expect(highlightLatex('a & b')).toContain('<span class="tok-amp">&amp;</span>');
  });

  it('pads a trailing newline so the backdrop keeps caret alignment', () => {
    expect(highlightLatex('a\n')).toBe('a\n ');
  });

  it('leaves plain identifiers/numbers uncolored', () => {
    expect(highlightLatex('abc123')).toBe('abc123');
  });
});
