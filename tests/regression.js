// Regressionstests für die in 1.1.1 behobenen Fehler.
// Aufruf ohne Abhängigkeiten: node tests/regression.js
// Das Modul "obsidian" wird durch eine kleine Attrappe ersetzt; geprüft werden
// nur reine Funktionen und der Klick-Handler, nicht die Darstellung in Obsidian.
'use strict';

const Module = require('module');
const path = require('path');
const assert = require('assert');

class MarkdownView {}
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
  Menu: class {},
  TFile: class {},
  setIcon: () => {},
  loadMathJax: async () => {},
  renderMath: () => null,
  finishRenderMath: async () => {},
  loadPrism: async () => null,
  debounce: (fn) => fn,
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return obsidianMock;
  return originalLoad.call(this, request, parent, isMain);
};

const Plugin = require(path.join(__dirname, '..', 'claude-markdown-viewer', 'main.js'));
const T = Plugin.__test;

let failed = 0;
/** @param {string} name @param {() => void} fn */
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

/* ---------- Formel-Begrenzer ---------- */

test('stripTexDelimiters: mehrere $$-Formeln bleiben getrennt', () => {
  const tex = T.stripTexDelimiters('$$a$$\n\n$$b$$');
  const chunks = T.splitTexChunks(tex).map((c) => T.stripTexDelimiters(c));
  assert.deepStrictEqual(chunks, ['a', 'b']);
});

test('stripTexDelimiters: einfache Fälle unverändert', () => {
  assert.strictEqual(T.stripTexDelimiters('$$x$$'), 'x');
  assert.strictEqual(T.stripTexDelimiters('$x$'), 'x');
  assert.strictEqual(T.stripTexDelimiters('\\[ x \\]'), 'x');
  assert.strictEqual(T.stripTexDelimiters('\\(x\\)'), 'x');
  assert.strictEqual(T.stripTexDelimiters('$$ \\text{$x$} $$'), '\\text{$x$}');
  assert.strictEqual(T.stripTexDelimiters('$$\n\\begin{aligned}a\\end{aligned}\n$$'), '\\begin{aligned}a\\end{aligned}');
});

/* ---------- GitHub-Anker ---------- */

test('Doppelte Überschriften: Slugs wie github-slugger', () => {
  const idx = T.buildHeadingIndex('# A\n## Beispiel\n## Beispiel\n## Beispiel 1\n## Beispiel\n');
  assert.deepStrictEqual(
    idx.headings.map((h) => h.slug),
    ['a', 'beispiel', 'beispiel-1', 'beispiel-1-1', 'beispiel-2']
  );
  assert.strictEqual(T.resolveAnchor(idx, 'beispiel-2').line, 4);
  assert.strictEqual(T.resolveAnchor(idx, 'beispiel-1-1').line, 3);
});

/* ---------- Klick-Handler ---------- */

/**
 * Minimale DOM-Attrappe: ein Link in einer Leseansicht.
 * @param {{ href: string, classes: string[] }} spec
 */
function fakeLink(spec) {
  const container = { contains: () => true };
  const a = {
    classList: { contains: (c) => spec.classes.includes(c) },
    getAttribute: (name) => (name === 'href' ? spec.href : null),
    closest: (sel) => (sel === 'a' ? a : sel.includes('.markdown-preview-view') ? container : null),
  };
  return { a, container };
}

/** @param {{ href: string, classes: string[] }} spec */
function clickOn(spec) {
  const { a, container } = fakeLink(spec);
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
  const plugin = new Plugin({ workspace: { getLeavesOfType: () => [{ view }] }, metadataCache: {} }, {});
  plugin.settings = Object.assign({}, T.DEFAULT_SETTINGS, { fileModes: {} });
  let prevented = false;
  plugin.onLinkClick({
    type: 'click',
    button: 0,
    target: a,
    defaultPrevented: false,
    preventDefault: () => (prevented = true),
    stopPropagation: () => {},
    stopImmediatePropagation: () => {},
  });
  return { prevented, scrolledTo };
}

test('Klick auf Tag #test springt nicht zur Überschrift „Test“', () => {
  const r = clickOn({ href: '#test', classes: ['tag'] });
  assert.strictEqual(r.prevented, false);
  assert.strictEqual(r.scrolledTo, null);
});

test('Klick auf Ankerlink #test springt weiterhin zur Überschrift', () => {
  const r = clickOn({ href: '#test', classes: ['internal-link'] });
  assert.strictEqual(r.prevented, true);
  assert.strictEqual(r.scrolledTo, 4);
});

/* ---------- 1.2.0: %%-Kommentare ---------- */

test('Einzelnes %% bleibt Text (so zeigt es die Leseansicht), kein Bereich', () => {
  const lines = ['# T', '', 'Prozent 50 %% sowie mehr', '', '## Weiter', '', 'Text'];
  assert.deepStrictEqual(T.findCommentRegions(lines, T.computeProtectedMask(lines)), []);
});

test('%%-Paar über mehrere Absätze ergibt einen Bereich', () => {
  const lines = ['a 50 %% b', '', 'c', '', 'd 70 %% e'];
  assert.deepStrictEqual(T.findCommentRegions(lines, T.computeProtectedMask(lines)), [{ start: 0, end: 4 }]);
});

test('%% in Code zählt nicht, Paare schließen', () => {
  const lines = ['a %%b%% c', '`%%` code', '```', '%%', '```', 'x'];
  assert.deepStrictEqual(T.findCommentRegions(lines, T.computeProtectedMask(lines)), [{ start: 0, end: 0 }]);
});

test('escapeComments ersetzt %% nur außerhalb von Code', () => {
  assert.strictEqual(
    T.escapeComments('50 %% und `%%`\n```\n%%\n```\nEnde %%'),
    '50 &#37;&#37; und `%%`\n```\n%%\n```\nEnde &#37;&#37;'
  );
});

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
  const ctx = {
    docId: 'doc-1',
    sourcePath: 'docs.md',
    addChild: () => {},
    getSectionInfo: () => ({ text, lineStart, lineEnd }),
  };
  return { el, ctx };
}

test('processSection: %%-Paar über Absätze erscheint als Text, Folgeabschnitt ausgeblendet', async () => {
  const text = '# Titel\n\nRabatt 50 %% und\n\n## Mitte\n\nbis 70 %% gesamt.\n\nEnde\n';
  const plugin = new Plugin({ workspace: { getLeavesOfType: () => [] }, vault: {}, metadataCache: {} }, {});
  plugin.settings = Object.assign({}, T.DEFAULT_SETTINGS, { fileModes: {} });
  const first = fakeSection(2, 2, text);
  await plugin.processSection(first.el, first.ctx);
  assert.ok(first.el.rendered, 'Abschnitt wurde nicht neu dargestellt');
  assert.ok(first.el.rendered.includes('Rabatt 50 &#37;&#37; und'));
  assert.ok(first.el.rendered.includes('## Mitte'));
  assert.ok(first.el.rendered.includes('bis 70 &#37;&#37; gesamt.'));
  assert.ok(!first.el.rendered.includes('Ende'));
  const later = fakeSection(4, 4, text);
  await plugin.processSection(later.el, later.ctx);
  assert.ok(later.el.classes.has('cmv-hidden'), 'Abschnitt im Bereich ist nicht ausgeblendet');
  const after = fakeSection(8, 8, text);
  await plugin.processSection(after.el, after.ctx);
  assert.ok(!after.el.classes.has('cmv-hidden') && !after.el.rendered, 'Abschnitt nach dem Bereich wurde verändert');
});

test('processSection: einzelnes %% im Docs-Export lässt den Abschnitt unverändert', async () => {
  const text = '# Titel\n\nNov 16, 2026 · @Name\n\nProzent 50 %% sowie mehr.\n';
  const plugin = new Plugin({ workspace: { getLeavesOfType: () => [] }, vault: {}, metadataCache: {} }, {});
  plugin.settings = Object.assign({}, T.DEFAULT_SETTINGS, { fileModes: {} });
  const sec = fakeSection(4, 4, text);
  await plugin.processSection(sec.el, sec.ctx);
  assert.strictEqual(sec.el.rendered, null);
  assert.ok(!sec.el.classes.has('cmv-hidden'));
});

/* ---------- 1.2.0: <details> ---------- */

test('Fließtext mit <details> am Zeilenanfang wird kein Klappbereich', () => {
  const lines = ['<details> ist ein HTML-Element.', '', 'Text', '', 'Man schließt mit </details> ab.'];
  assert.deepStrictEqual(T.findDetailsRegions(lines, T.computeProtectedMask(lines)), []);
});

test('<details> in einem Listenpunkt bleibt in der Liste', () => {
  const out = T.convertDetailsInText('1. Punkt\n   <details>\n   <summary>Mehr</summary>\n\n   - innen\n\n   </details>\n2. Weiter');
  assert.strictEqual(out, '1. Punkt\n\n   > [!claude-details]- Mehr\n   > - innen\n\n2. Weiter');
});

test('<details open> und einzeiliges <details> werden erkannt', () => {
  const a = ['<details open>', '<summary>S</summary>', '', 'x', '', '</details>'];
  assert.deepStrictEqual(T.findDetailsRegions(a, T.computeProtectedMask(a)), [{ start: 0, end: 5 }]);
  const b = ['<details><summary>A</summary>x</details>'];
  assert.deepStrictEqual(T.findDetailsRegions(b, T.computeProtectedMask(b)), [{ start: 0, end: 0 }]);
});

/* ---------- 1.2.0: Zeilenumbrüche nach CommonMark ---------- */

test('„2024. Jahr“ nach einer Absatzzeile ist Absatztext, keine Liste', () => {
  assert.strictEqual(T.convertSoftBreaks('Seit\n2024. Jahr. Fazit:\n2. Punkt', 'join'), 'Seit 2024. Jahr. Fazit: 2. Punkt');
  assert.strictEqual(T.convertSoftBreaks('1. a\n2. b\n3. c', 'join'), '1. a\n2. b\n3. c');
  assert.strictEqual(T.convertSoftBreaks('Text\n1. a\n2. b', 'join'), 'Text\n1. a\n2. b');
});

/* ---------- 1.2.0: Kleinigkeiten ---------- */

test('Mehrzeilige Fußnote: ganzer Text im Tooltip', () => {
  const lines = ['Text[^a].', '[^a]: Erste Zeile', '    zweite Zeile', '', '    zweiter Absatz', 'Danach'];
  assert.strictEqual(T.collectFootnotes(lines, new Array(lines.length).fill(false)).defs.get('a'), 'Erste Zeile zweite Zeile zweiter Absatz');
});

test('Slug: hochgestellte Ziffern fallen weg wie bei GitHub', () => {
  assert.strictEqual(T.githubSlug('x²'), 'x');
  assert.strictEqual(T.githubSlug('Ⅻ Kapitel'), 'ⅻ-kapitel');
});

test('Docs-Ordner: Groß- und Kleinschreibung egal, kein Präfix-Treffer', () => {
  assert.strictEqual(T.inDocsFolder('claude/docs/a.md', ['Claude/Docs']), true);
  assert.strictEqual(T.inDocsFolder('Claude/DocsAlt/a.md', ['Claude/Docs']), false);
});

/* ---------- 1.2.0: Nur ansehen ---------- */

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

function guardPlugin() {
  const plugin = new Plugin({ workspace: { getLeavesOfType: () => [] } }, {});
  plugin.settings = Object.assign({}, T.DEFAULT_SETTINGS, { fileModes: {} });
  return plugin;
}

function fakeEvent(target) {
  const e = { target, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} };
  return e;
}

test('Checkbox: Klick (auch per Leertaste) wird verworfen', () => {
  const e = fakeEvent(guardTarget({ matches: 'input.task-list-item-checkbox', inside: ['.markdown-preview-view'] }));
  guardPlugin().onGuardClick(e);
  assert.strictEqual(e.prevented, true);
});

test('Eigenschaften: kein Fokus, keine Eingabe', () => {
  const t = guardTarget({ inside: ['.metadata-container'] });
  const p = guardPlugin();
  p.onGuardFocus(fakeEvent(t));
  assert.strictEqual(t.blurred, true);
  const e = fakeEvent(t);
  p.onGuardInput(e);
  assert.strictEqual(e.prevented, true);
});

test('Eigenschaften: Link bleibt anklickbar', () => {
  const e = fakeEvent(guardTarget({ inside: ['.metadata-container', 'a'] }));
  guardPlugin().onGuardClick(e);
  assert.strictEqual(e.prevented, false);
});

runAll().then(() => {
  console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nAlle Tests bestanden');
  process.exit(failed ? 1 : 0);
});
