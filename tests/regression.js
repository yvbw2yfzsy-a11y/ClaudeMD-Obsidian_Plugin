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
  MarkdownRenderer: { render: async () => {} },
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
function test(name, fn) {
  try {
    fn();
    console.log('ok   ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + String(err && err.message).split('\n').join('\n     '));
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

console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nAlle Tests bestanden');
process.exit(failed ? 1 : 0);
