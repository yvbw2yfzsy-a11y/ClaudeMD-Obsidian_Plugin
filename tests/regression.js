// Regressionstests für den Claude Markdown Viewer (ab 2.0.0).
// Aufruf ohne Abhängigkeiten: node tests/regression.js
// Das Modul "obsidian" wird durch eine kleine Attrappe ersetzt; geprüft werden
// reine Funktionen, die Abschnittslogik und die Klick-Handler, nicht die
// Darstellung in Obsidian selbst.
'use strict';

const Module = require('module');
const path = require('path');
const assert = require('assert');

class MarkdownView {}
class TFile {
  /** @param {string} p */
  constructor(p) {
    this.path = p;
  }
}
const obsidianMock = {
  Plugin: class {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
    }
  },
  PluginSettingTab: class {},
  Setting: class {},
  MarkdownRenderer: {
    // Merkt sich, was neu dargestellt würde.
    render: async (_app, markdown, el) => {
      el.rendered = markdown;
    },
  },
  MarkdownRenderChild: class {},
  MarkdownView,
  Notice: class {},
  TFile,
  setIcon: () => {},
  loadMathJax: async () => {},
  renderMath: () => null,
  finishRenderMath: async () => {},
  loadPrism: async () => null,
  normalizePath: (p) => p.replace(/\/+/g, '/').replace(/^\/|\/$/g, ''),
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return obsidianMock;
  return originalLoad.call(this, request, parent, isMain);
};

const Plugin = require(path.join(__dirname, '..', 'claude-markdown-viewer', 'main.js'));
const T = Plugin.__test;

let failed = 0;
const queue = [];
function test(name, fn) {
  queue.push({ name, fn });
}
async function runAll() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      console.log('ok   ' + name);
    } catch (err) {
      failed++;
      console.log('FAIL ' + name + '\n     ' + String(err && err.message).split('\n').join('\n     '));
    }
  }
}

/** @param {object} [app] */
function newPlugin(app) {
  const plugin = new Plugin(app || { workspace: { getLeavesOfType: () => [] }, vault: {}, metadataCache: {} }, {});
  plugin.settings = Object.assign({}, T.DEFAULT_SETTINGS);
  return plugin;
}

/**
 * Minimale Attrappe eines Abschnitts der Leseansicht.
 * @param {number} lineStart @param {number} lineEnd @param {string} text
 */
function fakeSection(lineStart, lineEnd, text) {
  const classes = new Set();
  const el = {
    rendered: null,
    childNodes: [],
    classList: { contains: (c) => classes.has(c) },
    addClass: (c) => classes.add(c),
    removeClass: (c) => classes.delete(c),
    empty: () => {},
    appendChild: () => {},
    querySelectorAll: () => [],
    textContent: '',
    classes,
  };
  const ctx = { docId: 'doc-' + text.length, sourcePath: 'a.md', addChild: () => {}, getSectionInfo: () => ({ text, lineStart, lineEnd }) };
  return { el, ctx };
}

/* ---------- Formeln ---------- */

test('\\(…\\) und \\[…\\] werden immer Formel, maskierte Klammern nicht', () => {
  assert.strictEqual(T.convertMathDelimiters('a \\(x^2\\) b'), 'a $x^2$ b');
  assert.strictEqual(T.convertMathDelimiters('\\[\n\\sum k\n\\]'), '$$\n\\sum k\n$$');
  assert.strictEqual(T.convertMathDelimiters('\\[1\\] und \\[\\[Wikilink\\]\\]'), '\\[1\\] und \\[\\[Wikilink\\]\\]');
});

test('stripTexDelimiters: mehrere $$-Formeln bleiben getrennt', () => {
  const chunks = T.splitTexChunks(T.stripTexDelimiters('$$a$$\n\n$$b$$')).map((c) => T.stripTexDelimiters(c));
  assert.deepStrictEqual(chunks, ['a', 'b']);
  assert.strictEqual(T.stripTexDelimiters('$$ \\text{$x$} $$'), '\\text{$x$}');
});

test('LaTeX-Dokument wird erkannt (bleibt Quelltext)', () => {
  assert.strictEqual(T.looksLikeLatexDocument('\\documentclass{article}\n\\begin{document}x\\end{document}'), true);
  assert.strictEqual(T.looksLikeLatexDocument('\\begin{aligned}a&=b\\end{aligned}'), false);
});

/* ---------- Maskiertes HTML aus Docs-Exporten ---------- */

test('\\<u>, \\<sub>, \\<sup> werden Formatierung, Code bleibt', () => {
  assert.strictEqual(
    T.unescapeHtmlLine('mit \\<u>u\\</u>, H\\<sub>2\\</sub>O, x\\<sup>2\\</sup> und `\\<u>`'),
    'mit <u>u</u>, H<sub>2</sub>O, x<sup>2</sup> und `\\<u>`'
  );
  assert.strictEqual(T.unescapeHtmlLine('Sternchen \\* und \\[\\[Wikilink\\]\\]'), 'Sternchen \\* und \\[\\[Wikilink\\]\\]');
  assert.strictEqual(T.unescapeHtmlLine('Zeile \\<br> bleibt'), 'Zeile \\<br> bleibt');
});

test('Hinweisbox &#91;!NOTE\\] im Zitat wird [!NOTE]', () => {
  assert.strictEqual(T.unescapeHtmlLine('> &#91;!NOTE\\] GitHub-Hinweisbox.'), '> [!NOTE] GitHub-Hinweisbox.');
  assert.strictEqual(T.unescapeHtmlLine('&#91;embedded content: X\\]'), '&#91;embedded content: X\\]');
});

test('Maskiertes <details> aus dem Docs-Export wird Klappbereich', () => {
  const raw = ['\\<details>&#10;\\<summary>Ausklappbar\\</summary>', '', 'Inhalt mit **fett**.', '', '\\</details>'];
  const lines = T.prepareLines(raw);
  assert.strictEqual(raw.length, lines.length);
  const regions = T.findDetailsRegions(lines, T.computeProtectedMask(lines));
  assert.deepStrictEqual(regions, [{ start: 0, end: 4 }]);
  const res = T.buildSectionMarkdown(lines, raw, 0, 0, regions);
  assert.strictEqual(res.markdown.trim(), '> [!claude-details]- Ausklappbar\n> Inhalt mit **fett**.');
});

test('processSection: Docs-Zeile mit maskierten Tags wird neu dargestellt', async () => {
  const text = '# T\n\nNormaler Text, \\<u>unterstrichen\\</u>, H\\<sub>2\\</sub>O, Prozent 50 %% sowie \\[\\[Wikilink\\]\\].\n';
  const sec = fakeSection(2, 2, text);
  await newPlugin().processSection(sec.el, sec.ctx);
  assert.strictEqual(sec.el.rendered, 'Normaler Text, <u>unterstrichen</u>, H<sub>2</sub>O, Prozent 50 %% sowie \\[\\[Wikilink\\]\\].');
});

test('processSection: Abschnitt ohne Umbau bleibt, wie Obsidian ihn zeigt', async () => {
  const text = '# T\n\nNur Text mit \\(x\\) weiter unten.\n\nKein Umbau hier.\n';
  const sec = fakeSection(4, 4, text);
  await newPlugin().processSection(sec.el, sec.ctx);
  assert.strictEqual(sec.el.rendered, null);
  assert.ok(!sec.el.classes.has('cmv-hidden'));
});

/* ---------- %%-Kommentare ---------- */

test('Einzelnes %% bleibt Text (so zeigt es die Leseansicht), kein Bereich', () => {
  const lines = ['# T', '', 'Prozent 50 %% sowie mehr', '', 'Text'];
  assert.deepStrictEqual(T.findCommentRegions(lines, T.computeProtectedMask(lines)), []);
});

test('%%-Paar über Absätze: Text sichtbar, Folgeabschnitt ausgeblendet', async () => {
  const text = '# Titel\n\nRabatt 50 %% und\n\n## Mitte\n\nbis 70 %% gesamt.\n\nEnde\n';
  const plugin = newPlugin();
  const first = fakeSection(2, 2, text);
  await plugin.processSection(first.el, first.ctx);
  assert.ok(first.el.rendered.includes('Rabatt 50 &#37;&#37; und'));
  assert.ok(first.el.rendered.includes('bis 70 &#37;&#37; gesamt.'));
  const later = fakeSection(4, 4, text);
  await plugin.processSection(later.el, later.ctx);
  assert.ok(later.el.classes.has('cmv-hidden'));
});

test('escapeComments ersetzt %% nur außerhalb von Code', () => {
  assert.strictEqual(T.escapeComments('50 %% und `%%`\n```\n%%\n```\nEnde %%'), '50 &#37;&#37; und `%%`\n```\n%%\n```\nEnde &#37;&#37;');
});

/* ---------- <details> ---------- */

test('Fließtext mit <details> am Zeilenanfang wird kein Klappbereich', () => {
  const lines = ['<details> ist ein HTML-Element.', '', 'Text', '', 'Man schließt mit </details> ab.'];
  assert.deepStrictEqual(T.findDetailsRegions(lines, T.computeProtectedMask(lines)), []);
});

test('<details> in einem Listenpunkt bleibt in der Liste', () => {
  const out = T.convertDetailsInText('1. Punkt\n   <details>\n   <summary>Mehr</summary>\n\n   - innen\n\n   </details>\n2. Weiter');
  assert.strictEqual(out, '1. Punkt\n\n   > [!claude-details]- Mehr\n   > - innen\n\n2. Weiter');
});

/* ---------- Markdown-Block, CSV, SVG, Bilder ---------- */

test('```markdown-Vorschau: alles umgebaut', () => {
  assert.strictEqual(T.transformMarkdown('Formel \\(x\\) und H\\<sub>2\\</sub>O'), 'Formel $x$ und H<sub>2</sub>O');
});

test('CSV: Anführungszeichen, Semikolon, Zahlenspalten', () => {
  assert.deepStrictEqual(T.parseCsv('Name,Notiz\nA,"mit, Komma"\nB,"mit ""X"""', ','), [['Name', 'Notiz'], ['A', 'mit, Komma'], ['B', 'mit "X"']]);
  assert.strictEqual(T.detectDelimiter('a;b\n1,5;2'), ';');
  assert.deepStrictEqual(T.numericColumns([['M', 'U'], ['Jan', '1.200,50'], ['Feb', '980']], 2), [false, true]);
});

test('SVG wird data:-Bild, anderes nicht', () => {
  assert.ok(T.svgDataUrl('<svg viewBox="0 0 1 1"><rect/></svg>').startsWith('data:image/svg+xml'));
  assert.ok(decodeURIComponent(T.svgDataUrl('<svg><rect/></svg>')).includes('xmlns="http://www.w3.org/2000/svg"'));
  assert.strictEqual(T.svgDataUrl('<div>kein svg</div>'), null);
});

test('Bildpfade relativ zur Datei', () => {
  assert.strictEqual(T.relativeImagePath('bilder/a.png', 'repo/docs/README.md'), 'repo/docs/bilder/a.png');
  assert.strictEqual(T.relativeImagePath('../img/a%20b.png?x=1', 'repo/docs/README.md'), 'repo/img/a b.png');
  assert.strictEqual(T.relativeImagePath('/root.png', 'a/b.md'), 'root.png');
  assert.strictEqual(T.relativeImagePath('https://x.de/a.png', 'a.md'), null);
  assert.strictEqual(T.relativeImagePath('app://local/a.png', 'a.md'), null);
});

test('resolveImages setzt die Adresse für gefundene Bilder', () => {
  const files = { 'repo/bilder/a.png': new TFile('repo/bilder/a.png') };
  const plugin = newPlugin({
    workspace: { getLeavesOfType: () => [] },
    vault: { getAbstractFileByPath: (p) => files[p] || null, getResourcePath: (f) => 'app://res/' + f.path },
    metadataCache: { getFirstLinkpathDest: () => null },
  });
  const img = { tagName: 'IMG', attrs: { src: 'bilder/a.png' }, getAttribute(n) { return this.attrs[n]; }, setAttribute(n, v) { this.attrs[n] = v; } };
  const missing = Object.assign({}, img, { attrs: { src: 'fehlt.png' } });
  plugin.resolveImages(img, 'repo/README.md');
  plugin.resolveImages(missing, 'repo/README.md');
  assert.strictEqual(img.attrs.src, 'app://res/repo/bilder/a.png');
  assert.strictEqual(missing.attrs.src, 'fehlt.png');
});

/* ---------- Anker, Fußnoten ---------- */

test('Doppelte Überschriften: Slugs wie github-slugger', () => {
  const idx = T.buildHeadingIndex('# A\n## Beispiel\n## Beispiel\n## Beispiel 1\n## Beispiel\n');
  assert.deepStrictEqual(idx.headings.map((h) => h.slug), ['a', 'beispiel', 'beispiel-1', 'beispiel-1-1', 'beispiel-2']);
  assert.strictEqual(T.githubSlug('x²'), 'x');
});

test('Mehrzeilige Fußnote: ganzer Text im Tooltip', () => {
  const lines = ['Text[^a].', '[^a]: Erste Zeile', '    zweite Zeile', '', '    zweiter Absatz', 'Danach'];
  assert.strictEqual(T.collectFootnotes(lines, new Array(lines.length).fill(false)).defs.get('a'), 'Erste Zeile zweite Zeile zweiter Absatz');
});

/* ---------- Klick-Handler ---------- */

/** @param {{ href: string, classes: string[] }} spec */
function clickOn(spec) {
  const container = { contains: () => true };
  const a = {
    classList: { contains: (c) => spec.classes.includes(c) },
    getAttribute: (name) => (name === 'href' ? spec.href : null),
    closest: (sel) => (sel === 'a' ? a : sel.includes('.markdown-preview-view') ? container : null),
  };
  const view = Object.create(MarkdownView.prototype);
  let scrolledTo = null;
  Object.assign(view, {
    containerEl: container,
    file: { path: 'a.md', name: 'a.md', basename: 'a' },
    data: '# A\n\nTags: #test\n\n## Test\n',
    getViewData() {
      return this.data;
    },
    getMode: () => 'preview',
    previewMode: { applyScroll: (line) => (scrolledTo = line) },
    setEphemeralState: () => {},
  });
  const plugin = newPlugin({ workspace: { getLeavesOfType: () => [{ view }] }, metadataCache: {} });
  let prevented = false;
  plugin.onLinkClick({ type: 'click', button: 0, target: a, defaultPrevented: false, preventDefault: () => (prevented = true), stopPropagation: () => {}, stopImmediatePropagation: () => {} });
  return { prevented, scrolledTo };
}

test('Klick auf Tag #test springt nicht zur Überschrift „Test“', () => {
  const r = clickOn({ href: '#test', classes: ['tag'] });
  assert.strictEqual(r.prevented, false);
});

test('Klick auf Ankerlink #test springt zur Überschrift', () => {
  const r = clickOn({ href: '#test', classes: ['internal-link'] });
  assert.strictEqual(r.prevented, true);
  assert.strictEqual(r.scrolledTo, 4);
});

/* ---------- Nur ansehen ---------- */

/** @param {{ matches?: string, inside?: string[] }} spec */
function guardTarget(spec) {
  const inside = spec.inside || [];
  return {
    matches: (sel) => sel === spec.matches,
    closest: (sel) => (sel.split(',').some((s) => inside.some((i) => s.trim().includes(i))) ? {} : null),
    blurred: false,
    blur() {
      this.blurred = true;
    },
  };
}
function fakeEvent(target) {
  return { target, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} };
}

test('Checkbox: Klick (auch per Leertaste) wird verworfen', () => {
  const e = fakeEvent(guardTarget({ matches: 'input.task-list-item-checkbox', inside: ['.markdown-preview-view'] }));
  newPlugin().onGuardClick(e);
  assert.strictEqual(e.prevented, true);
});

test('Eigenschaften: kein Fokus, keine Eingabe; Link bleibt anklickbar', () => {
  const t = guardTarget({ inside: ['.metadata-container'] });
  const p = newPlugin();
  p.onGuardFocus(fakeEvent(t));
  assert.strictEqual(t.blurred, true);
  const e = fakeEvent(t);
  p.onGuardInput(e);
  assert.strictEqual(e.prevented, true);
  const link = fakeEvent(guardTarget({ inside: ['.metadata-container', 'a'] }));
  p.onGuardClick(link);
  assert.strictEqual(link.prevented, false);
});

test('„Nur ansehen“ aus: keine Sperren', () => {
  const p = newPlugin();
  p.settings.viewOnly = false;
  const e = fakeEvent(guardTarget({ matches: 'input.task-list-item-checkbox', inside: ['.markdown-preview-view'] }));
  p.onGuardClick(e);
  assert.strictEqual(e.prevented, false);
});

runAll().then(() => {
  console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nAlle Tests bestanden');
  process.exit(failed ? 1 : 0);
});
