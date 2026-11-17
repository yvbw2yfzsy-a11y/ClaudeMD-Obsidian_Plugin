// @ts-check
/*
 * Claude Markdown Viewer
 * ----------------------
 * Zeigt Markdown-Dateien aus Claude Docs (Markdown-Export), Claude-Chats und
 * Claude Code in Obsidian immer fertig dargestellt: Formeln, Tabellen,
 * Klappbereiche, Bilder, Diagramm-Platzhalter. Es gibt nur diese eine
 * Darstellung; wer den Quelltext sehen will, öffnet die Datei in einem
 * Texteditor.
 *
 * Reines CommonJS ohne Build-Schritt: main.js, manifest.json und styles.css
 * in <Vault>/.obsidian/plugins/claude-markdown-viewer/ legen und aktivieren.
 * Reiner Viewer: Das Plugin liest Dateien nur, schreibt nie in Notizen und hat
 * keine Bearbeitungsfunktionen. Gespeichert wird nur die eigene Einstellung
 * „Nur ansehen“ (data.json im Plugin-Ordner).
 */
'use strict';

const obsidian = require('obsidian');
const {
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownRenderer,
  MarkdownRenderChild,
  MarkdownView,
  Notice,
  TFile,
  setIcon,
  loadMathJax,
  renderMath,
  finishRenderMath,
  loadPrism,
  normalizePath,
} = obsidian;

/**
 * @typedef {Object} ViewerSettings
 * @property {boolean} viewOnly Leseansicht erzwingen, Checkboxen, Eigenschaften
 *   und Links zu fehlenden Dateien sperren.
 */

/** @type {ViewerSettings} */
const DEFAULT_SETTINGS = { viewOnly: true };

/** Eigenschaften (Frontmatter) in der Leseansicht und in der Seitenleiste. */
const PROPERTIES_SELECTOR =
  '.markdown-preview-view .metadata-container, .workspace-leaf-content[data-type="file-properties"] .metadata-container';

const LOG_PREFIX = '[Claude Markdown Viewer]';
const DETAILS_CALLOUT = 'claude-details';

/**
 * @typedef {{ start: number, end: number }} Region
 * @typedef {{ text: string, raw: string, line: number, level: number, slug: string }} HeadingEntry
 * @typedef {{ headings: HeadingEntry[], anchors: Array<{ id: string, line: number }> }} HeadingIndex
 */

/* ======================================================================
 * Reine Text-Hilfsfunktionen (ohne Obsidian-Abhängigkeit, testbar)
 * ==================================================================== */

/**
 * Zerlegt Text in Zeilen. Die Zeilennummern bleiben identisch mit denen,
 * die Obsidian in getSectionInfo() liefert; ein abschließendes \r fällt weg.
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * Index der schließenden Zeile eines YAML-Frontmatters, sonst -1.
 * @param {string[]} lines
 */
function frontmatterEnd(lines) {
  if (lines.length === 0 || lines[0].trim() !== '---') return -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') return i;
  }
  return -1;
}

const FENCE_RE = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})(.*)$/;

/**
 * Markiert Zeilen, die zu Code-Blöcken (``` oder ~~~) gehören, auch in
 * Zitaten/Callouts. Ein nicht geschlossener Block reicht bis zum Dateiende.
 * @param {string[]} lines
 * @returns {boolean[]}
 */
function computeFenceMask(lines) {
  /** @type {boolean[]} */
  const mask = new Array(lines.length).fill(false);
  /** @type {{ ch: string, len: number } | null} */
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_RE.exec(lines[i]);
    if (open) {
      mask[i] = true;
      if (m && m[1][0] === open.ch && m[1].length >= open.len && m[2].trim() === '') open = null;
      continue;
    }
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      open = { ch: m[1][0], len: m[1].length };
      mask[i] = true;
    }
  }
  return mask;
}

/**
 * Maske für Code-Blöcke und (nur am Dateianfang) Frontmatter.
 * @param {string[]} lines
 * @param {boolean} [withFrontmatter] false für Ausschnitte, die nicht am Dateianfang beginnen
 */
function computeProtectedMask(lines, withFrontmatter = true) {
  const mask = computeFenceMask(lines);
  if (withFrontmatter) {
    const fm = frontmatterEnd(lines);
    for (let i = 0; i <= fm; i++) mask[i] = true;
  }
  return mask;
}

/**
 * Findet Inline-Code-Spans (`…`, ``…``) als [start, ende)-Bereiche.
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
function findInlineCodeRanges(text) {
  /** @type {Array<[number, number]>} */
  const ranges = [];
  const runRe = /`+/g;
  let m;
  while ((m = runRe.exec(text)) !== null) {
    if (isEscapedAt(text, m.index)) continue;
    const len = m[0].length;
    const after = m.index + len;
    const closeRe = /`+/g;
    closeRe.lastIndex = after;
    let c;
    let close = -1;
    while ((c = closeRe.exec(text)) !== null) {
      if (c[0].length === len) {
        close = c.index;
        break;
      }
    }
    if (close === -1) continue;
    if (/\n[ \t]*\n/.test(text.slice(after, close))) continue;
    ranges.push([m.index, close + len]);
    runRe.lastIndex = close + len;
  }
  return ranges;
}

/**
 * Entfernt Inline-Code aus einer Zeile (für die Suche nach <details>-Tags,
 * %% und Fußnoten).
 * @param {string} line
 */
function stripInlineCode(line) {
  const ranges = findInlineCodeRanges(line);
  if (ranges.length === 0) return line;
  let out = '';
  let last = 0;
  for (const [a, b] of ranges) {
    out += line.slice(last, a);
    last = b;
  }
  return out + line.slice(last);
}

/**
 * True, wenn das Zeichen an `index` durch eine ungerade Zahl Backslashes
 * maskiert ist.
 * @param {string} text
 * @param {number} index
 */
function isEscapedAt(text, index) {
  let n = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) n++;
  return n % 2 === 1;
}

/**
 * Wendet `fn` nur auf die Teile außerhalb von Inline-Code an; Code bleibt.
 * @param {string} text
 * @param {(part: string) => string} fn
 */
function mapOutsideInlineCode(text, fn) {
  let out = '';
  let last = 0;
  for (const [a, b] of findInlineCodeRanges(text)) {
    out += fn(text.slice(last, a)) + text.slice(a, b);
    last = b;
  }
  return out + fn(text.slice(last));
}

/**
 * Wendet `fn` auf zusammenhängende Textstücke außerhalb von Code-Blöcken (und
 * am Dateianfang außerhalb des Frontmatters) an. Geschützte Zeilen bleiben.
 * @param {string} md
 * @param {boolean} withFrontmatter
 * @param {(chunk: string) => string} fn
 */
function mapOutsideCodeBlocks(md, withFrontmatter, fn) {
  const lines = md.split('\n');
  const mask = computeProtectedMask(lines, withFrontmatter);
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  let buf = [];
  const flush = () => {
    if (buf.length) {
      out.push(fn(buf.join('\n')));
      buf = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) {
      flush();
      out.push(lines[i]);
    } else {
      buf.push(lines[i]);
    }
  }
  flush();
  return out.join('\n');
}

/** @param {string} s */
function trimBlankLines(s) {
  const lines = s.split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

/* ---------- Formeln mit \\( … \\) und \\[ … \\] ---------- */

const INLINE_MATH_HINT = /[\\^_=<>+\-*/{}|0-9]|[≤≥≠±×÷·∑∏∫√∞∂∇αβγδεθλμπσφωΔΣΩ]/;

const DISPLAY_MATH_HINT = /\\[A-Za-z]{2,}|[\^_]|\\[,;:!{}]|[=<>≤≥≠]/;

const PROSE_ONLY = /^[\p{L}\s,.;:!?'"„“”‚‘’()-]+$/u;

/**
 * @param {string} text
 * @param {number} idx
 */
function isLineStartAt(text, idx) {
  const ls = text.lastIndexOf('\n', idx - 1) + 1;
  return /^[ \t>]*$/.test(text.slice(ls, idx));
}

/**
 * @param {string} text
 * @param {number} idx
 */
function isLineEndAt(text, idx) {
  let le = text.indexOf('\n', idx);
  if (le === -1) le = text.length;
  return text.slice(idx, le).trim() === '';
}

/**
 * Sucht das schließende \) bzw. \]. Inline-Formeln dürfen keine Zeile
 * überspannen, abgesetzte Formeln keine Leerzeile.
 * @param {string} text
 * @param {number} from
 * @param {boolean} display
 * @param {number} limit Position, die nicht überschritten wird (Code-Span)
 */
function findMathClose(text, from, display, limit) {
  const closer = display ? ']' : ')';
  for (let j = from; j < limit - 1; j++) {
    const ch = text[j];
    if (ch === '\n') {
      if (!display) return -1;
      if (/^\n[ \t>]*\n/.test(text.slice(j, j + 64))) return -1;
    }
    if (ch === '\\' && text[j + 1] === closer && !isEscapedAt(text, j)) return j;
  }
  return -1;
}

/**
 * Entscheidet, ob \(…\) bzw. \[…\] wirklich eine Formel ist und nicht nur
 * maskierte Klammern wie \[1\] oder \[\[Wikilink\]\].
 * @param {string} inner
 * @param {boolean} display
 * @param {string} text
 * @param {number} start
 * @param {number} end
 */
function acceptMath(inner, display, text, start, end) {
  const t = inner.trim();
  if (!t || t.includes('$')) return false;
  if (!display) {
    if (t.length > 600) return false;
    return INLINE_MATH_HINT.test(t) || !/\s/.test(t);
  }
  if (/\n[ \t>]*\n/.test(inner)) return false;
  if (DISPLAY_MATH_HINT.test(t)) return true;
  return isLineStartAt(text, start) && isLineEndAt(text, end) && !PROSE_ONLY.test(t);
}

/**
 * Wandelt \(…\) und \[…\] in einem Textstück ohne Code-Blöcke um.
 * @param {string} text
 */
function convertMathChunk(text) {
  const code = findInlineCodeRanges(text);
  let out = '';
  let i = 0;
  let ci = 0;
  while (i < text.length) {
    while (ci < code.length && code[ci][1] <= i) ci++;
    if (ci < code.length && code[ci][0] === i) {
      out += text.slice(code[ci][0], code[ci][1]);
      i = code[ci][1];
      ci++;
      continue;
    }
    if (text[i] === '\\' && (text[i + 1] === '(' || text[i + 1] === '[') && !isEscapedAt(text, i)) {
      const display = text[i + 1] === '[';
      const limit = ci < code.length ? code[ci][0] : text.length;
      const end = findMathClose(text, i + 2, display, limit);
      if (end !== -1) {
        const inner = text.slice(i + 2, end);
        if (acceptMath(inner, display, text, i, end + 2)) {
          out += display ? '$$' + inner + '$$' : '$' + inner.trim() + '$';
          i = end + 2;
          continue;
        }
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

/**
 * Wandelt alle \(…\) in $…$ und alle \[…\] in $$…$$ um, außer in Code
 * und Frontmatter. Ändert nur den Text für die Anzeige, nie die Datei.
 * @param {string} md
 * @param {boolean} [withFrontmatter] false für Ausschnitte mitten aus einer Datei
 */
function convertMathDelimiters(md, withFrontmatter = true) {
  if (md.indexOf('\\(') === -1 && md.indexOf('\\[') === -1) return md;
  return mapOutsideCodeBlocks(md, withFrontmatter, convertMathChunk);
}

/* ---------- <details>/<summary> ---------- */

// Ein <details>-Block beginnt nur, wenn das Tag allein oder mit <summary> auf
// der Zeile steht. Fließtext wie „<details> ist ein HTML-Element …“ bleibt so,
// wie er ist.
const DETAILS_OPEN_LINE = /^[ \t]{0,3}<details(?:\s[^>]*)?>[ \t]*(?:<summary[\s>]|$)/i;

const DETAILS_OPEN_NESTED = /^[ \t>]*<details(?:\s[^>]*)?>[ \t]*(?:<summary[\s>]|$)/i;

const DETAILS_OPEN_ANY = /<details(?:\s[^>]*)?>/gi;

const DETAILS_CLOSE_ANY = /<\/details\s*>/gi;

const DETAILS_CLOSE_EDGE = /^[ \t>]*<\/details\s*>|<\/details\s*>[ \t]*$/i;

/**
 * Zählt <details>-Tags einer Zeile. Gezählt werden nur Tags am Zeilenanfang
 * bzw. -ende, nicht Erwähnungen mitten im Satz.
 * @param {string} line
 */
function countDetailsTags(line) {
  const s = stripInlineCode(line).replace(/\\</g, '');
  return {
    opens: DETAILS_OPEN_NESTED.test(s) ? (s.match(DETAILS_OPEN_ANY) || []).length : 0,
    closes: DETAILS_CLOSE_EDGE.test(s) ? (s.match(DETAILS_CLOSE_ANY) || []).length : 0,
  };
}

/**
 * Findet <details>-Blöcke (Zeilenbereiche, verschachtelt gezählt). Ein Block
 * ohne schließendes Tag wird nicht angefasst.
 * @param {string[]} lines
 * @param {boolean[]} mask
 * @returns {Array<{ start: number, end: number }>}
 */
function findDetailsRegions(lines, mask) {
  /** @type {Array<{ start: number, end: number }>} */
  const regions = [];
  let i = 0;
  while (i < lines.length) {
    if (!mask[i] && DETAILS_OPEN_LINE.test(lines[i])) {
      let depth = 0;
      let end = -1;
      for (let j = i; j < lines.length; j++) {
        if (mask[j]) continue;
        const { opens, closes } = countDetailsTags(lines[j]);
        depth += opens - closes;
        if (depth <= 0) {
          end = j;
          break;
        }
      }
      if (end !== -1) {
        regions.push({ start: i, end });
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return regions;
}

/**
 * Wandelt einen <details>-Block in einen einklappbaren Callout um. Obsidian
 * rendert Markdown in Callouts vollständig, auch verschachtelt.
 * @param {string} block
 * @returns {string}
 */
function detailsBlockToCallout(block) {
  // Eingerückt (z. B. in einem Listenpunkt): Einrückung abziehen, Callout
  // bauen und wieder einrücken, damit er im Listenpunkt bleibt.
  const indent = (/^[ \t]*/.exec(block) || [''])[0];
  if (indent) {
    const inner = block
      .split('\n')
      .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.replace(/^[ \t]+/, '')))
      .join('\n');
    return detailsBlockToCallout(inner)
      .split('\n')
      .map((l) => (l === '' ? '' : indent + l))
      .join('\n');
  }
  const m = /^<details(\s[^>]*)?>/i.exec(block);
  if (!m) return block;
  const isOpen = /(^|\s)open(\s|=|$)/i.test(m[1] || '');
  const rest = block.slice(m[0].length);
  let closeAt = -1;
  let closeLen = 0;
  const closeRe = /<\/details\s*>/gi;
  let c;
  while ((c = closeRe.exec(rest)) !== null) {
    closeAt = c.index;
    closeLen = c[0].length;
  }
  let body = closeAt === -1 ? rest : rest.slice(0, closeAt);
  const trailing = closeAt === -1 ? '' : rest.slice(closeAt + closeLen);
  let title = '';
  const sm = /^\s*<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary\s*>/i.exec(body);
  if (sm) {
    title = sm[1];
    body = body.slice(sm[0].length);
  }
  title = title.replace(/\s+/g, ' ').trim() || 'Details';
  body = convertDetailsInText(trimBlankLines(body), false);
  const out = [`> [!${DETAILS_CALLOUT}]${isOpen ? '+' : '-'} ${title}`];
  if (body) {
    for (const line of body.split('\n')) out.push(line.trim() === '' ? '>' : '> ' + line);
  }
  let result = out.join('\n');
  if (trailing.trim()) result += '\n\n' + trailing.trim();
  return result;
}

/**
 * Wandelt alle <details>-Blöcke eines Markdown-Texts um.
 * @param {string} md
 * @param {boolean} [withFrontmatter] false für Ausschnitte mitten aus einer Datei
 */
function convertDetailsInText(md, withFrontmatter = true) {
  if (!/<details/i.test(md)) return md;
  const lines = md.split('\n');
  const mask = computeProtectedMask(lines, withFrontmatter);
  const regions = findDetailsRegions(lines, mask);
  if (regions.length === 0) return md;
  /** @type {string[]} */
  const out = [];
  let i = 0;
  for (const r of regions) {
    while (i < r.start) out.push(lines[i++]);
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(detailsBlockToCallout(lines.slice(r.start, r.end + 1).join('\n')));
    i = r.end + 1;
    if (i < lines.length && lines[i].trim() !== '') out.push('');
  }
  while (i < lines.length) out.push(lines[i++]);
  return out.join('\n');
}

/* ---------- Obsidian-Kommentare %%…%% ---------- */

/**
 * Zeilenbereiche, die Obsidian in der Leseansicht als Kommentar %%…%%
 * ausblendet. Claude kennt diese Syntax nicht. Gezählt werden nur Paare: Ein
 * einzelnes %% (etwa „Prozent 50 %%“) zeigt die Leseansicht als Text (am
 * iPad geprüft); nur der Bearbeitungsmodus färbt dann den Rest als Kommentar.
 * %% in Code zählt nicht.
 * @param {string[]} lines
 * @param {boolean[]} mask
 * @returns {Array<{ start: number, end: number }>}
 */
function findCommentRegions(lines, mask) {
  /** @type {Array<{ start: number, end: number }>} */
  const regions = [];
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    if (mask[i] || lines[i].indexOf('%%') === -1) continue;
    const n = (stripInlineCode(lines[i]).match(/%%/g) || []).length;
    for (let k = 0; k < n; k++) {
      if (open === -1) {
        open = i;
      } else {
        regions.push({ start: open, end: i });
        open = -1;
      }
    }
  }
  return regions;
}

/**
 * Ersetzt %% außerhalb von Code durch &#37;&#37;. Obsidian zeigt dann „%%“
 * als Text statt einen Kommentar zu beginnen.
 * @param {string} text Textstück ohne Code-Blöcke
 */
function escapeCommentChunk(text) {
  return mapOutsideInlineCode(text, (part) => part.replace(/%%/g, '&#37;&#37;'));
}

/**
 * @param {string} md
 * @param {boolean} [withFrontmatter] false für Ausschnitte mitten aus einer Datei
 */
function escapeComments(md, withFrontmatter = true) {
  if (md.indexOf('%%') === -1) return md;
  return mapOutsideCodeBlocks(md, withFrontmatter, escapeCommentChunk);
}

/**
 * Vereinigt sich überschneidende Zeilenbereiche (<details> und Kommentare).
 * @param {...Array<{ start: number, end: number }>} lists
 * @returns {Array<{ start: number, end: number }>}
 */
function mergeRegions(...lists) {
  const all = lists
    .flat()
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start);
  /** @type {Array<{ start: number, end: number }>} */
  const out = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/* ---------- Maskiertes HTML aus Claude-Docs-Exporten ---------- */

/*
 * Der Docs-Export maskiert Formatierungen, die er als HTML schreibt:
 * „\<u>unterstrichen\</u>“, „H\<sub>2\</sub>O“, „\<details>&#10;\<summary>“.
 * Hinweisboxen schreibt er als „> &#91;!NOTE\]“. Ohne Plugin stehen diese
 * Zeichen roh da. Das Plugin stellt sie dar. Nur diese Formatierungs-Tags,
 * nur außerhalb von Code; die Zeilenzahl bleibt gleich.
 */
const ESCAPED_TAG_RE =
  /\\<(\/?)(u|ins|sub|sup|mark|kbd|b|strong|i|em|s|del|small|details|summary)(?=[\s/>])([^<>]*)>/gi;
const TAG_GAP_RE = /(<\/?(?:details|summary)\b[^<>]*>)&#10;(?=<\/?(?:details|summary)\b)/gi;
const ESCAPED_ALERT_RE = /^((?:[ \t]{0,3}>[ \t]?)+)&#91;!([A-Za-z][\w-]*)\\?\]/;

/**
 * @param {string} text Textstück ohne Inline-Code
 */
function unescapeHtmlSegment(text) {
  return text.replace(ESCAPED_TAG_RE, '<$1$2$3>').replace(TAG_GAP_RE, '$1 ');
}

/**
 * Stellt maskierte Formatierungen einer Zeile wieder her.
 * @param {string} line
 */
function unescapeHtmlLine(line) {
  const out = line.replace(ESCAPED_ALERT_RE, '$1[!$2]');
  if (out.indexOf('\\<') === -1) return out;
  return mapOutsideInlineCode(out, unescapeHtmlSegment);
}

/**
 * Zeilen, wie das Plugin sie darstellt (gleich viele wie im Original).
 * @param {string[]} lines
 * @returns {string[]}
 */
function prepareLines(lines) {
  if (!lines.some((l) => l.indexOf('\\<') !== -1 || l.indexOf('&#91;!') !== -1)) return lines;
  const mask = computeProtectedMask(lines);
  return lines.map((l, i) => (mask[i] ? l : unescapeHtmlLine(l)));
}

/* ---------- Abschnitt neu bauen ---------- */

/**
 * Wandelt alles um (für die Vorschau von ```markdown-Blöcken).
 * @param {string} md
 */
function transformMarkdown(md) {
  let out = prepareLines(md.split('\n')).join('\n');
  out = convertDetailsInText(out);
  out = convertMathDelimiters(out);
  out = escapeComments(out);
  return out;
}

/**
 * Baut den Markdown-Text, den ein Abschnitt der Leseansicht zeigen soll.
 * Obsidian rendert jeden durch Leerzeilen getrennten Block einzeln; ein
 * <details>-Block mit Leerzeilen zerfällt dabei in mehrere Abschnitte. Der
 * erste Abschnitt zeigt deshalb den ganzen Block, die übrigen bleiben leer.
 * Dasselbe gilt für Bereiche zwischen zwei %%, die Obsidian als Kommentar
 * ausblendet.
 * @param {string[]} lines vorbereitete Zeilen der ganzen Datei (prepareLines)
 * @param {string[]} raw Originalzeilen der ganzen Datei
 * @param {number} lineStart
 * @param {number} lineEnd
 * @param {Region[]} regions <details>- und Kommentarbereiche
 * @param {boolean} [hasComments] Datei enthält %%-Paare; nur dann wird %% maskiert
 *   (ein einzelnes %% zeigt Obsidian ohnehin als Text)
 * @returns {{ changed: boolean, markdown: string }}
 */
function buildSectionMarkdown(lines, raw, lineStart, lineEnd, regions, hasComments = false) {
  /** @type {string[]} */
  const parts = [];
  let inRegion = false;
  let i = lineStart;
  const last = Math.min(lineEnd, lines.length - 1);
  while (i <= last) {
    const line = i;
    const r = regions.length ? regions.find((x) => x.start <= line && line <= x.end) : undefined;
    if (r && r.start < lineStart) {
      inRegion = true;
      i = r.end + 1;
      continue;
    }
    if (r && r.start === i) {
      inRegion = true;
      const block = lines.slice(r.start, r.end + 1).join('\n');
      if (DETAILS_OPEN_LINE.test(lines[r.start])) {
        // <details> ist ein eigener Block: Leerzeilen davor und danach.
        if (parts.length && parts[parts.length - 1].trim() !== '') parts.push('');
        parts.push(convertDetailsInText(block, false));
        parts.push('');
      } else {
        // Kommentarbereich: kann mitten im Absatz beginnen, keine Leerzeilen einfügen.
        parts.push(convertDetailsInText(block, false));
      }
      i = r.end + 1;
      continue;
    }
    parts.push(lines[i]);
    i++;
  }
  let markdown = parts.join('\n');
  markdown = convertMathDelimiters(markdown, lineStart === 0);
  if (hasComments) markdown = escapeComments(markdown, lineStart === 0);
  const original = raw.slice(lineStart, last + 1).join('\n');
  return { changed: inRegion || markdown !== original, markdown };
}

/* ---------- Fußnoten, Überschriften und GitHub-Anker ---------- */

/**
 * @param {string[]} lines
 * @param {boolean[]} mask
 * @returns {{ defs: Map<string, string>, order: Map<string, number> }}
 */
function collectFootnotes(lines, mask) {
  /** @type {Map<string, string>} */
  const defs = new Map();
  /** @type {string[]} Verweise in der Reihenfolge ihres ersten Auftretens */
  const refs = [];
  const defRe = /^\[\^([^\]\s]+)\]:\s?(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const d = defRe.exec(lines[i]);
    if (d) {
      // Mehrzeilige Fußnote: eingerückte Folgezeilen gehören dazu, auch nach
      // einer Leerzeile (weiterer Absatz der Fußnote).
      const parts = [d[2].trim()];
      for (let j = i + 1; j < lines.length && !mask[j]; j++) {
        if (/^(?: {2,}|\t)\S/.test(lines[j])) {
          parts.push(lines[j].trim());
          continue;
        }
        if (lines[j].trim() === '' && j + 1 < lines.length && /^(?: {4}|\t)\S/.test(lines[j + 1])) continue;
        break;
      }
      defs.set(d[1], parts.filter(Boolean).join(' '));
      continue;
    }
    const refRe = /\[\^([^\]\s]+)\](?!:)/g;
    const line = stripInlineCode(lines[i]);
    let m;
    while ((m = refRe.exec(line)) !== null) refs.push(m[1]);
  }
  // Nummeriert werden nur Verweise mit Definition: Ein [^x] ohne Definition
  // bleibt Text und bekommt keine Nummer (wie bei GitHub und markdown-it).
  /** @type {Map<string, number>} */
  const order = new Map();
  for (const id of refs) {
    if (defs.has(id) && !order.has(id)) order.set(id, order.size + 1);
  }
  return { defs, order };
}

/**
 * Slug wie bei GitHub (github-slugger): Kleinbuchstaben, Satzzeichen und
 * Emoji entfernen, Leerzeichen zu Bindestrichen. Umlaute bleiben.
 * @param {string} text
 */
function githubSlug(text) {
  return text
    .toLowerCase()
    // Wie github-slugger: Dezimal- und Buchstabenziffern bleiben, hochgestellte
    // Ziffern, Brüche und eingekreiste Zahlen (²  ½  ①) fallen weg.
    .replace(/[^\p{L}\p{M}\p{Nd}\p{Nl}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

/**
 * Text einer Überschrift ohne Markdown-Syntax (so wie GitHub ihn sluggt).
 * @param {string} raw
 */
function headingPlainText(raw) {
  let s = raw;
  s = s.replace(/\s+#+\s*$/, '');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2');
  s = s.replace(/(^|[^\p{L}\p{N}])([*_])(.+?)\2(?=$|[^\p{L}\p{N}])/gu, '$1$3');
  s = s.replace(/~~(.+?)~~/g, '$1');
  s = s.replace(/==(.+?)==/g, '$1');
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, '$1');
  s = s.replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)));
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
  return s.trim();
}

/**
 * @param {Array<{ raw: string, line: number, level: number }>} list
 * @param {Array<{ id: string, line: number }>} anchors
 * @returns {HeadingIndex}
 */
function makeHeadingIndex(list, anchors) {
  // Doppelte Slugs wie github-slugger: Ist ein Slug schon vergeben (auch durch
  // eine Überschrift, die selbst auf "-1" endet), wird weitergezählt.
  /** @type {Map<string, number>} */
  const occurrences = new Map();
  const headings = list.map((h) => {
    const text = headingPlainText(h.raw);
    const base = githubSlug(text);
    let slug = base;
    while (occurrences.has(slug)) {
      const n = (occurrences.get(base) || 0) + 1;
      occurrences.set(base, n);
      slug = `${base}-${n}`;
    }
    occurrences.set(slug, 0);
    return { text, raw: h.raw, line: h.line, level: h.level, slug };
  });
  return { headings, anchors };
}

/**
 * Überschriften (ATX und Setext) und HTML-Anker eines Markdown-Texts.
 * @param {string} source
 * @returns {HeadingIndex}
 */
function buildHeadingIndex(source) {
  const lines = splitLines(source);
  const mask = computeProtectedMask(lines);
  /** @type {Array<{ raw: string, line: number, level: number }>} */
  const list = [];
  /** @type {Array<{ id: string, line: number }>} */
  const anchors = [];
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const line = lines[i];
    const atx = /^[ \t]{0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (atx) {
      list.push({ raw: atx[2] || '', line: i, level: atx[1].length });
    } else if (
      i + 1 < lines.length &&
      !mask[i + 1] &&
      line.trim() !== '' &&
      !/^[ \t]*([-*+]|\d+[.)])[ \t]/.test(line) &&
      !/^[ \t]*>/.test(line) &&
      /^[ \t]{0,3}(=+|-+)[ \t]*$/.test(lines[i + 1]) &&
      (i === 0 ||
        lines[i - 1].trim() === '' ||
        mask[i - 1] ||
        /^[ \t]{0,3}#{1,6}([ \t]|$)/.test(lines[i - 1]) ||
        /^[ \t]{0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(lines[i - 1]))
    ) {
      list.push({ raw: line.trim(), line: i, level: lines[i + 1].trim()[0] === '=' ? 1 : 2 });
    }
    const anchorRe = /<a\s[^>]*?(?:name|id)\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = anchorRe.exec(line)) !== null) anchors.push({ id: m[1], line: i });
  }
  return makeHeadingIndex(list, anchors);
}

/** @param {string} s */
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (_e) {
    return s;
  }
}

/**
 * Löst einen Anker (#…) zu einer Überschrift auf.
 * exact = true heißt: Obsidian findet die Überschrift selbst.
 * @param {HeadingIndex} index
 * @param {string} anchorRaw
 * @returns {{ heading: HeadingEntry | null, line: number, exact: boolean } | null}
 */
function resolveAnchor(index, anchorRaw) {
  let a = safeDecode(anchorRaw).trim();
  if (a.includes('~')) a = a.slice(a.lastIndexOf('~') + 1);
  if (!a) return null;
  const al = a.toLowerCase();
  const hs = index.headings;
  /** @param {HeadingEntry | undefined} h @param {boolean} exact */
  const hit = (h, exact) => (h ? { heading: h, line: h.line, exact } : null);
  return (
    hit(hs.find((h) => h.text === a), true) ||
    hit(hs.find((h) => h.slug === al), false) ||
    hit(hs.find((h) => h.text.toLowerCase() === al), false) ||
    hit(hs.find((h) => h.slug.replace(/-+/g, '-') === al.replace(/-+/g, '-')), false) ||
    hit(hs.find((h) => githubSlug(h.text).replace(/-+/g, '-') === githubSlug(a.replace(/-/g, ' ')).replace(/-+/g, '-')), false) ||
    (() => {
      const anc = index.anchors.find((x) => x.id === a || x.id.toLowerCase() === al);
      if (!anc) return null;
      const next = hs.find((h) => h.line >= anc.line);
      return next && next.line - anc.line <= 3 ? { heading: next, line: next.line, exact: false } : { heading: null, line: anc.line, exact: false };
    })()
  );
}

/**
 * Überschrift so umschreiben, dass sie als Obsidian-Linkziel taugt.
 * @param {string} raw
 */
function linkSafeHeading(raw) {
  return raw.replace(/[#|^:%[\]\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ---------- Formeln, CSV, Platzhalter, Tabellen ---------- */

const EMBED_PLACEHOLDER_RE = /^\[embedded content(?::\s*([\s\S]*?))?\]$/;

const LATEX_DOCUMENT_RE =
  /\\documentclass|\\usepackage|\\begin\{document\}|\\(?:sub)*section\*?\{|\\chapter\*?\{|\\maketitle|\\title\{|\\author\{|\\(?:input|include)\{|\\bibliography|\\begin\{(?:itemize|enumerate|description|figure|table|tabular|abstract|center|verbatim|lstlisting|minted|tikzpicture|thebibliography|frame)\}/;

/**
 * True, wenn ein ```latex-Block ein LaTeX-Dokument und keine Formel ist.
 * @param {string} src
 */
function looksLikeLatexDocument(src) {
  return LATEX_DOCUMENT_RE.test(src);
}

/**
 * Entfernt äußere $$, \[ \], $ oder \( \) und leere Ränder.
 * @param {string} source
 * @returns {string | null}
 */
function stripTexDelimiters(source) {
  let s = source.trim();
  /** @param {string} a @param {string} b */
  const strip = (a, b) => {
    if (s.length >= a.length + b.length && s.startsWith(a) && s.endsWith(b)) {
      const inner = s.slice(a.length, s.length - b.length);
      // Mehrere Formeln wie "$$a$$ … $$b$$": nicht das äußere Paar entfernen,
      // sonst bleibt "a$$ … $$b" stehen. Die Teile werden einzeln behandelt.
      if (inner.includes(a) || inner.includes(b)) return false;
      s = inner.trim();
      return true;
    }
    return false;
  };
  if (!strip('$$', '$$') && !strip('\\[', '\\]') && !strip('\\(', '\\)')) {
    if (!s.startsWith('$$')) strip('$', '$');
  }
  return s ? s : null;
}

/**
 * Teilt an Leerzeilen in mehrere Formeln, wenn jede für sich vollständig ist.
 * @param {string} tex
 */
function splitTexChunks(tex) {
  if (!/\n[ \t]*\n/.test(tex)) return [tex];
  const parts = tex.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);
  /** @param {string} p @param {RegExp} re */
  const count = (p, re) => (p.match(re) || []).length;
  const balanced = parts.every((p) => count(p, /\\begin\{/g) === count(p, /\\end\{/g));
  return balanced && parts.length > 1 ? parts : [tex];
}

/**
 * Mehrzeilige Formel ohne Umgebung: \\ würde sonst ignoriert. Mit & wird
 * ausgerichtet (aligned), sonst zentriert (gathered).
 * @param {string} chunk
 */
function normalizeTexChunk(chunk) {
  if (!/\\begin\{/.test(chunk) && /\\\\/.test(chunk)) {
    return /(^|[^\\])&/.test(chunk) ? `\\begin{aligned}${chunk}\\end{aligned}` : `\\begin{gathered}${chunk}\\end{gathered}`;
  }
  return chunk;
}

/**
 * @param {Element} el
 */
function mathHasError(el) {
  if (el.matches('mjx-merror, [data-mjx-error], .katex-error')) return true;
  return el.querySelector('mjx-merror, [data-mjx-error], .katex-error') !== null;
}

/**
 * Trennzeichen raten (Komma, Semikolon, Tab).
 * @param {string} text
 */
function detectDelimiter(text) {
  const first = splitLines(text).find((l) => l.trim() !== '') || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (const ch of first) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[/** @type {',' | ';' | '\t'} */ (ch)]++;
  }
  if (counts[','] === 0 && counts[';'] === 0 && counts['\t'] === 0) return ',';
  if (counts['\t'] > counts[','] && counts['\t'] >= counts[';']) return '\t';
  if (counts[';'] > counts[',']) return ';';
  return ',';
}

/**
 * CSV nach RFC 4180 (Anführungszeichen, "" als Escape, Umbrüche in Feldern).
 * @param {string} text
 * @param {string} delim
 * @returns {string[][]}
 */
function parseCsv(text, delim) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let inQ = false;
  const s = text.replace(/\r\n?/g, '\n');
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQ = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      inQ = true;
      field = '';
      i++;
      continue;
    }
    if (ch === delim) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1].every((f) => f.trim() === '')) rows.pop();
  return rows;
}

const NUMERIC_CELL_RE =
  /^(?:[-+−]?(?:\d{1,3}(?:[ .,'’]\d{3})+|\d+)(?:[.,]\d+)?\s?(?:%|€|\$|£|CHF)?|[-+−]?(?:€|\$|£|CHF)\s?\d[\d.,' ]*)$/;

/**
 * Spalten, die nur Zahlen enthalten (werden rechtsbündig gesetzt).
 * @param {string[][]} rows
 * @param {number} cols
 */
function numericColumns(rows, cols) {
  /** @type {boolean[]} */
  const result = [];
  const body = rows.slice(1);
  for (let c = 0; c < cols; c++) {
    const cells = body.map((r) => (r[c] || '').trim()).filter((v) => v !== '');
    result.push(cells.length > 0 && cells.every((v) => NUMERIC_CELL_RE.test(v)));
  }
  return result;
}

/**
 * Ersetzt Platzhalter wie "[embedded content: Titel]" aus Docs-Exporten durch
 * einen deutlichen Hinweis.
 * @param {HTMLElement} root
 */
function decorateEmbedPlaceholders(root) {
  const paragraphs = root.tagName === 'P' ? [root] : Array.from(root.querySelectorAll('p'));
  for (const p of paragraphs) {
    const text = (p.textContent || '').trim();
    if (!text.startsWith('[embedded content')) continue;
    const m = EMBED_PLACEHOLDER_RE.exec(text);
    if (!m || p.closest('.cmv-embed')) continue;
    const doc = p.ownerDocument;
    const box = doc.createElement('div');
    box.className = 'cmv-embed';
    box.setAttribute('role', 'note');
    const icon = box.appendChild(doc.createElement('div'));
    icon.className = 'cmv-embed-icon';
    setIcon(icon, 'bar-chart-2');
    if (!icon.querySelector('svg')) setIcon(icon, 'image');
    const body = box.appendChild(doc.createElement('div'));
    body.className = 'cmv-embed-body';
    const title = body.appendChild(doc.createElement('div'));
    title.className = 'cmv-embed-title';
    title.textContent = 'Diagramm oder Chart aus Claude Docs';
    if (m[1] && m[1].trim()) {
      const cap = body.appendChild(doc.createElement('div'));
      cap.className = 'cmv-embed-caption';
      cap.textContent = m[1].trim();
    }
    const note = body.appendChild(doc.createElement('div'));
    note.className = 'cmv-embed-note';
    note.textContent = 'Fehlt im Markdown-Export. Nur im Original-Doc in Claude Docs zu sehen.';
    p.replaceWith(box);
  }
}

/**
 * Packt Tabellen in einen horizontal scrollbaren Rahmen.
 * @param {HTMLElement} root
 */
function wrapTables(root) {
  const tables = root.tagName === 'TABLE' ? [root] : Array.from(root.querySelectorAll('table'));
  for (const table of tables) {
    const parent = table.parentElement;
    if (!parent || parent.classList.contains('cmv-table-scroll') || table.closest('.cmv-csv')) continue;
    const wrap = table.ownerDocument.createElement('div');
    wrap.className = 'cmv-table-scroll';
    parent.insertBefore(wrap, table);
    wrap.appendChild(table);
  }
}

/**
 * Macht aus wörtlichem "[^1]" in neu dargestellten Abschnitten wieder ein
 * hochgestelltes Fußnotenzeichen „[1]“ wie bei Obsidian, mit Tooltip. Das
 * Plugin hängt einen Tipp-Handler an (data-fn), der zur Fußnote springt;
 * auf dem iPad gibt es keinen Tooltip.
 * @param {HTMLElement} root
 * @param {{ defs: Map<string, string>, order: Map<string, number> }} fn
 */
function decorateFootnoteRefs(root, fn) {
  if (fn.defs.size === 0 || !/\[\^/.test(root.textContent || '')) return;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  /** @type {Text[]} */
  const nodes = [];
  let n;
  while ((n = walker.nextNode()) !== null) {
    const parent = n.parentElement;
    if (!parent || parent.closest('code, pre, a, .math, mjx-container')) continue;
    if (/\[\^[^\]\s]+\]/.test(n.nodeValue || '')) nodes.push(/** @type {Text} */ (n));
  }
  for (const node of nodes) {
    const text = node.nodeValue || '';
    const re = /\[\^([^\]\s]+)\]/g;
    const frag = doc.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const def = fn.defs.get(m[1]);
      if (def === undefined) continue;
      frag.append(text.slice(last, m.index));
      const sup = doc.createElement('sup');
      sup.className = 'footnote-ref cmv-fnref';
      const num = fn.order.get(m[1]);
      sup.textContent = `[${num || m[1]}]`;
      if (num) sup.setAttribute('data-fn', String(num));
      sup.setAttribute('title', def);
      sup.setAttribute('role', 'link');
      sup.setAttribute('aria-label', `Fußnote ${num || m[1]}: ${def}`);
      frag.append(sup);
      last = m.index + m[0].length;
    }
    if (last === 0) continue;
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

/**
 * @param {string} text
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    new Notice('In die Zwischenablage kopiert');
  } catch (_e) {
    new Notice('Kopieren nicht möglich');
  }
}

/**
 * Zeichnet CSV-Zeilen als Tabelle (erste Zeile als Kopf, Zahlen rechtsbündig).
 * @param {HTMLElement} container
 * @param {string[][]} rows
 */
function renderCsvTable(container, rows) {
  const cols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const numeric = numericColumns(rows, cols);
  const gridEl = container.createDiv({ cls: 'cmv-csv-grid cmv-table-scroll' });
  const table = gridEl.createEl('table', { cls: 'cmv-csv-table' });
  const headRow = table.createEl('thead').createEl('tr');
  for (let c = 0; c < cols; c++) {
    headRow.createEl('th', { text: rows[0][c] || '', cls: numeric[c] ? 'cmv-num' : undefined });
  }
  if (rows.length > 1) {
    const tbody = table.createEl('tbody');
    for (const row of rows.slice(1)) {
      const tr = tbody.createEl('tr');
      for (let c = 0; c < cols; c++) tr.createEl('td', { text: row[c] || '', cls: numeric[c] ? 'cmv-num' : undefined });
    }
  }
}

/* ---------- Bilder mit relativem Pfad ---------- */

/**
 * Pfad eines Bilds relativ zur Datei auflösen (für <img src="bilder/a.png">,
 * das Obsidian sonst nicht findet). null bei Adressen mit Schema oder Anker.
 * @param {string} src
 * @param {string} sourcePath Pfad der Markdown-Datei im Vault
 * @returns {string | null} Vault-Pfad oder null
 */
function relativeImagePath(src, sourcePath) {
  if (!src || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) return null;
  const clean = safeDecode(src.split(/[?#]/)[0]);
  if (!clean) return null;
  if (clean.startsWith('/')) return clean.replace(/^\/+/, '');
  const base = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')).split('/') : [];
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') base.pop();
    else base.push(part);
  }
  return base.join('/');
}

/**
 * ```svg als Bild. Als data:-Adresse in <img> laufen keine Skripte aus der
 * Datei.
 * @param {string} source
 * @returns {string | null}
 */
function svgDataUrl(source) {
  const s = source.trim();
  // Vor dem <svg>-Tag erlaubt: XML-Deklaration, Kommentare, DOCTYPE (ohne
  // eigene Entity-Definitionen in [ … ]).
  const m = /^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE\s+svg\b[^>[]*>\s*)*<svg(?=[\s>])/i.exec(s);
  if (!m) return null;
  // Ohne xmlns am <svg>-Tag selbst zeigt der Browser das Bild nicht an.
  // Geprüft wird nur dieses Tag, nicht ein xmlns weiter innen oder in einem
  // Kommentar davor.
  const at = m[0].length;
  const rootTag = s.slice(at, s.indexOf('>', at) + 1);
  const withNs = /\sxmlns\s*=/.test(rootTag) ? s : s.slice(0, at) + ' xmlns="http://www.w3.org/2000/svg"' + s.slice(at);
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(withNs);
}

/* ======================================================================
 * Plugin
 * ==================================================================== */

class ClaudeMarkdownViewer extends Plugin {
  /** @type {ViewerSettings} */
  settings = Object.assign({}, DEFAULT_SETTINGS);

  /** Analyse der ganzen Datei je Darstellung (docId). */
  /** @type {Map<string, { text: string, raw: string[], lines: string[], regions: Region[], hasComments: boolean, footnotes: { defs: Map<string, string>, order: Map<string, number> } }>} */
  analysisByDoc = new Map();

  /**
   * Ergebnis des Schnelltests je Darstellung (docId): Enthält die Datei
   * überhaupt etwas, das umgebaut werden müsste? Ohne Merker liefe der Test
   * für jeden Abschnitt über die ganze Datei.
   * @type {Map<string, { text: string, hit: boolean }>}
   */
  quickCheckByDoc = new Map();

  /** Pfade, deren Darstellung Mehrabschnitts-Blöcke (<details>, %%) enthält. */
  /** @type {Set<string>} */
  pathsWithRegions = new Set();

  /** @type {Map<string, number>} */
  rerenderTimers = new Map();

  /** @type {WeakSet<import('obsidian').WorkspaceLeaf>} */
  switchingLeaves = new WeakSet();

  /** Fenster, in denen Klick-Handler und Klassen schon gesetzt sind. */
  /** @type {WeakSet<Document>} */
  attachedDocuments = new WeakSet();

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new ViewerSettingTab(this.app, this));

    // Ist eine Sprache schon von einem anderen Plugin belegt, wirft Obsidian
    // einen Fehler. Ohne Abfangen bräche onload hier ab, und das ganze Plugin
    // (auch die Leseansicht-Sperre) liefe nicht.
    /** @type {string[]} */
    const busy = [];
    /**
     * @param {string} lang
     * @param {(source: string, el: HTMLElement, ctx: import('obsidian').MarkdownPostProcessorContext) => Promise<void>} handler
     */
    const codeBlock = (lang, handler) => {
      try {
        this.registerMarkdownCodeBlockProcessor(lang, handler);
      } catch (err) {
        console.error(LOG_PREFIX, `Code-Block „${lang}“ ist schon von einem anderen Plugin belegt`, err);
        busy.push(lang);
      }
    };
    for (const lang of ['latex', 'math']) codeBlock(lang, (source, el) => this.renderTexBlock(source, el));
    for (const lang of ['csv', 'tsv']) codeBlock(lang, (source, el) => this.renderCsvBlock(source, el, lang));
    for (const lang of ['markdown', 'md']) codeBlock(lang, (source, el, ctx) => this.renderMarkdownBlock(source, el, ctx));
    codeBlock('svg', (source, el) => this.renderSvgBlock(source, el));
    if (busy.length) {
      new Notice(`Claude Markdown Viewer: Code-Blöcke „${busy.join('“, „')}“ sind von einem anderen Plugin belegt und werden nicht umgebaut.`);
    }

    this.registerMarkdownPostProcessor((el, ctx) => this.processSection(el, ctx), 100);
    this.registerMarkdownPostProcessor((el, ctx) => this.processDom(el, ctx), 200);

    this.attachToDocument(document);
    this.registerEvent(this.app.workspace.on('window-open', (win) => this.attachToDocument(win.doc)));

    const lock = () => this.enforceReadingView();
    this.registerEvent(this.app.workspace.on('layout-change', lock));
    this.registerEvent(this.app.workspace.on('active-leaf-change', lock));
    this.registerEvent(this.app.workspace.on('file-open', lock));
    this.registerEvent(this.app.vault.on('modify', (file) => this.onFileModified(file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onFileRenamed(file, oldPath)));

    this.app.workspace.onLayoutReady(() => {
      for (const doc of this.knownDocuments()) this.attachToDocument(doc);
      lock();
      this.rerenderAll();
    });
  }

  onunload() {
    for (const doc of this.knownDocuments()) doc.body.classList.remove('cmv-view-only');
    for (const t of this.rerenderTimers.values()) window.clearTimeout(t);
    this.rerenderAll();
  }

  async loadSettings() {
    /** @type {any} */
    const data = (await this.loadData()) || {};
    // Bis 1.2.1 hieß die Einstellung lockReadingView; andere Einstellungen gibt es nicht mehr.
    const viewOnly =
      typeof data.viewOnly === 'boolean' ? data.viewOnly : typeof data.lockReadingView === 'boolean' ? data.lockReadingView : true;
    this.settings = { viewOnly };
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyBodyClasses();
    this.enforceReadingView();
  }

  /* ---------- Fenster und globale Klassen ---------- */

  /** @returns {Document[]} */
  knownDocuments() {
    /** @type {Set<Document>} */
    const docs = new Set([document]);
    this.app.workspace.iterateAllLeaves((leaf) => {
      const d = leaf.view && leaf.view.containerEl ? leaf.view.containerEl.ownerDocument : null;
      if (d) docs.add(d);
    });
    return Array.from(docs);
  }

  /** @param {Document} doc */
  attachToDocument(doc) {
    if (this.attachedDocuments.has(doc)) return;
    this.attachedDocuments.add(doc);
    // Sperren zuerst: Sie laufen vor dem Link-Handler und beenden das Ereignis.
    this.registerDomEvent(doc, 'click', (evt) => this.onGuardClick(evt), { capture: true });
    this.registerDomEvent(doc, 'click', (evt) => this.onLinkClick(evt), { capture: true });
    this.registerDomEvent(doc, 'auxclick', (evt) => this.onLinkClick(evt), { capture: true });
    this.registerDomEvent(doc, 'contextmenu', (evt) => this.onContextMenu(evt), { capture: true });
    this.registerDomEvent(doc, 'focusin', (evt) => this.onGuardFocus(evt), { capture: true });
    this.registerDomEvent(doc, 'beforeinput', (evt) => this.onGuardInput(evt), { capture: true });
    this.registerDomEvent(doc, 'paste', (evt) => this.onGuardInput(evt), { capture: true });
    this.registerDomEvent(doc, 'cut', (evt) => this.onGuardInput(evt), { capture: true });
    this.registerDomEvent(doc, 'drop', (evt) => this.onGuardInput(evt), { capture: true });
    this.applyBodyClasses(doc);
  }

  /** @param {Document} [only] */
  applyBodyClasses(only) {
    for (const doc of only ? [only] : this.knownDocuments()) {
      doc.body.classList.toggle('cmv-view-only', this.settings.viewOnly);
    }
  }

  /* ---------- Nur ansehen: Checkboxen und Eigenschaften ---------- */

  /**
   * Checkboxen: CSS sperrt nur die Maus. Mit Tab und Leertaste entsteht
   * dasselbe Klick-Ereignis, und Obsidian würde die Datei ändern. Abfangen
   * verhindert auch das Umschalten des Häkchens.
   * Eigenschaften: Klicks im Bereich werden verworfen, außer auf Links und auf
   * die Überschrift „Eigenschaften“ (Ein- und Ausklappen).
   * @param {MouseEvent} evt
   */
  onGuardClick(evt) {
    if (!this.settings.viewOnly) return;
    const target = /** @type {Element | null} */ (evt.target);
    if (!target || typeof target.closest !== 'function') return;
    if (target.matches('input.task-list-item-checkbox') && target.closest('.markdown-preview-view, .markdown-rendered')) {
      this.stopEvent(evt);
      return;
    }
    if (target.closest(PROPERTIES_SELECTOR) && !target.closest('a, .metadata-properties-heading')) {
      this.stopEvent(evt);
    }
  }

  /**
   * Eigenschaften: Felder bekommen keinen Fokus, damit nichts per Tastatur
   * geändert werden kann.
   * @param {FocusEvent} evt
   */
  onGuardFocus(evt) {
    if (!this.settings.viewOnly) return;
    const target = /** @type {HTMLElement | null} */ (evt.target);
    if (!target || typeof target.closest !== 'function' || !target.closest(PROPERTIES_SELECTOR)) return;
    if (target.closest('a, .metadata-properties-heading')) return;
    if (typeof target.blur === 'function') target.blur();
  }

  /**
   * Eigenschaften: Eingaben, Einfügen, Ausschneiden und Ablegen verwerfen.
   * @param {Event} evt
   */
  onGuardInput(evt) {
    if (!this.settings.viewOnly) return;
    const target = /** @type {Element | null} */ (evt.target);
    if (!target || typeof target.closest !== 'function' || !target.closest(PROPERTIES_SELECTOR)) return;
    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation();
  }

  /**
   * Kontextmenü auf einem Link zu einer fehlenden Datei: „In neuem Tab
   * öffnen“ würde die Notiz anlegen. Stattdessen der Hinweis wie beim Klick.
   * @param {MouseEvent} evt
   */
  onContextMenu(evt) {
    if (!this.settings.viewOnly) return;
    const target = /** @type {Element | null} */ (evt.target);
    if (!target || typeof target.closest !== 'function') return;
    const a = target.closest('a.is-unresolved');
    if (!a || !a.closest('.markdown-preview-view, .markdown-rendered')) return;
    this.stopEvent(evt);
    const href = a.getAttribute('data-href') || a.getAttribute('href') || '';
    new Notice(`Link-Ziel nicht im Vault: ${safeDecode(href)}`);
  }

  /* ---------- Leseansicht ---------- */

  enforceReadingView() {
    if (!this.settings.viewOnly) return;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      if (view.getMode() !== 'source' || this.switchingLeaves.has(leaf)) return;
      const state = leaf.getViewState();
      if (state.type !== 'markdown') return;
      this.switchingLeaves.add(leaf);
      const next = Object.assign({}, state, { state: Object.assign({}, state.state, { mode: 'preview' }) });
      leaf
        .setViewState(next)
        .catch((err) => console.error(LOG_PREFIX, 'Leseansicht konnte nicht gesetzt werden', err))
        .finally(() => this.switchingLeaves.delete(leaf));
    });
  }

  rerenderAll() {
    this.analysisByDoc.clear();
    this.quickCheckByDoc.clear();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.previewMode) view.previewMode.rerender(true);
    }
  }

  /** @param {import('obsidian').TAbstractFile} file */
  onFileModified(file) {
    if (!(file instanceof TFile) || !this.pathsWithRegions.has(file.path)) return;
    const old = this.rerenderTimers.get(file.path);
    if (old) window.clearTimeout(old);
    const timer = window.setTimeout(() => {
      this.rerenderTimers.delete(file.path);
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file && view.file.path === file.path && view.getMode() === 'preview') {
          view.previewMode.rerender(true);
        }
      }
    }, 400);
    this.rerenderTimers.set(file.path, timer);
  }

  /**
   * @param {import('obsidian').TAbstractFile} file
   * @param {string} oldPath
   */
  onFileRenamed(file, oldPath) {
    if (this.pathsWithRegions.delete(oldPath)) this.pathsWithRegions.add(file.path);
  }

  /* ---------- Abschnitte: <details>, \( \[, %%, maskiertes HTML ---------- */

  /**
   * <details>- und Kommentarbereiche.
   * @param {string[]} lines
   * @param {boolean[]} mask
   */
  findRegions(lines, mask) {
    const comments = findCommentRegions(lines, mask);
    return { comments, regions: mergeRegions(findDetailsRegions(lines, mask), comments) };
  }

  /**
   * @param {string} text
   * @param {string} docId
   * @param {string} sourcePath
   */
  analyze(text, docId, sourcePath) {
    const cached = this.analysisByDoc.get(docId);
    if (cached && cached.text === text) return cached;
    const raw = splitLines(text);
    const lines = prepareLines(raw);
    const mask = computeProtectedMask(lines);
    const { regions, comments } = this.findRegions(lines, mask);
    const analysis = { text, raw, lines, regions, hasComments: comments.length > 0, footnotes: collectFootnotes(lines, mask) };
    if (this.analysisByDoc.size > 50) this.analysisByDoc.clear();
    this.analysisByDoc.set(docId, analysis);
    if (regions.length && sourcePath) this.pathsWithRegions.add(sourcePath);
    return analysis;
  }

  /**
   * @param {string} text ganze Datei
   * @param {string} docId
   */
  fileNeedsWork(text, docId) {
    const cached = this.quickCheckByDoc.get(docId);
    if (cached && cached.text === text) return cached.hit;
    const hit = /<details|\\\(|\\\[|%%|\\<|&#91;!/i.test(text);
    if (this.quickCheckByDoc.size > 50) this.quickCheckByDoc.clear();
    this.quickCheckByDoc.set(docId, { text, hit });
    return hit;
  }

  /**
   * @param {HTMLElement} el
   * @param {import('obsidian').MarkdownPostProcessorContext} ctx
   */
  async processSection(el, ctx) {
    if (el.classList.contains('cmv-rerendered')) return;
    /** @type {import('obsidian').MarkdownSectionInformation | null} */
    let info = null;
    try {
      info = ctx.getSectionInfo(el);
    } catch (_e) {
      info = null;
    }
    if (!info) return;
    // Schneller Ausschluss: nichts in der Datei, was umgebaut werden müsste.
    if (!this.fileNeedsWork(info.text, ctx.docId)) return;
    try {
      const a = this.analyze(info.text, ctx.docId, ctx.sourcePath);
      const res = buildSectionMarkdown(a.lines, a.raw, info.lineStart, info.lineEnd, a.regions, a.hasComments);
      if (!res.changed) return;
      if (res.markdown.trim() === '') {
        el.addClass('cmv-hidden');
        return;
      }
      const backup = Array.from(el.childNodes);
      el.empty();
      el.addClass('cmv-rerendered');
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      try {
        await MarkdownRenderer.render(this.app, res.markdown, el, ctx.sourcePath, child);
        decorateFootnoteRefs(el, a.footnotes);
        this.wireFootnoteRefs(el);
      } catch (err) {
        console.error(LOG_PREFIX, 'Abschnitt konnte nicht neu dargestellt werden', err);
        el.empty();
        el.removeClass('cmv-rerendered');
        for (const node of backup) el.appendChild(node);
      }
    } catch (err) {
      console.error(LOG_PREFIX, 'Fehler bei der Abschnittsanalyse', err);
    }
  }

  /**
   * Fußnotenzeichen aus decorateFootnoteRefs: Tippen springt zur Fußnote am
   * Dateiende. Ist dieser Teil noch nicht dargestellt, erscheint ihr Text als
   * Hinweis.
   * @param {HTMLElement} el
   */
  wireFootnoteRefs(el) {
    for (const ref of Array.from(el.querySelectorAll('.cmv-fnref[data-fn]'))) {
      ref.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const n = Number(ref.getAttribute('data-fn'));
        const root = ref.closest('.markdown-preview-view');
        const items = root ? Array.from(root.querySelectorAll('.footnotes li')) : [];
        const li = items.find((item) => (item.id || '').startsWith(`fn-${n}-`)) || items[n - 1];
        if (li) li.scrollIntoView({ block: 'center' });
        else new Notice(`Fußnote ${n}: ${ref.getAttribute('title') || ''}`, 8000);
      });
    }
  }

  /**
   * @param {HTMLElement} el
   * @param {import('obsidian').MarkdownPostProcessorContext} ctx
   */
  processDom(el, ctx) {
    try {
      decorateEmbedPlaceholders(el);
      wrapTables(el);
      this.resolveImages(el, (ctx && ctx.sourcePath) || '');
    } catch (err) {
      console.error(LOG_PREFIX, 'Fehler bei der Nachbearbeitung', err);
    }
  }

  /**
   * <img src="bilder/a.png"> mit Pfad relativ zur Datei: Obsidian findet das
   * Bild nicht selbst. Das Plugin sucht es im Vault und setzt die Adresse.
   * @param {HTMLElement} root
   * @param {string} sourcePath
   */
  resolveImages(root, sourcePath) {
    const imgs = root.tagName === 'IMG' ? [root] : Array.from(root.querySelectorAll('img'));
    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      const path = relativeImagePath(src, sourcePath);
      if (!path) continue;
      let file = this.app.vault.getAbstractFileByPath(normalizePath(path));
      if (!(file instanceof TFile)) {
        file = this.app.metadataCache.getFirstLinkpathDest(safeDecode(src.split(/[?#]/)[0]), sourcePath);
      }
      if (file instanceof TFile) img.setAttribute('src', this.app.vault.getResourcePath(file));
    }
  }

  /* ---------- Code-Blöcke: immer dargestellt ---------- */

  /**
   * @param {HTMLElement} el
   * @param {string} source
   * @param {string} lang
   * @param {{ note?: string, copyButton?: boolean }} [opts]
   */
  async renderPlainCode(el, source, lang, opts = {}) {
    if (opts.note) el.createDiv({ cls: 'cmv-note', text: opts.note });
    const pre = el.createEl('pre', { cls: `language-${lang}` });
    const code = pre.createEl('code', { cls: `language-${lang}`, text: source.replace(/\n$/, '') });
    if (opts.copyButton !== false) {
      const btn = pre.createEl('button', { cls: 'copy-code-button', text: 'Kopieren', attr: { type: 'button' } });
      btn.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        void copyText(source);
      });
    }
    try {
      const Prism = await loadPrism();
      if (Prism && Prism.languages && Prism.languages[lang]) Prism.highlightElement(code);
    } catch (_e) {
      /* ohne Hervorhebung weiter */
    }
  }

  /**
   * Setzt TeX als Formel. false, wenn das nicht geht (Hinweis steht dann im Bereich).
   * @param {HTMLElement} pane
   * @param {string} tex
   * @returns {Promise<boolean>}
   */
  async renderFormulaInto(pane, tex) {
    try {
      await loadMathJax();
    } catch (_e) {
      pane.createDiv({ cls: 'cmv-note', text: 'Formel-Engine nicht verfügbar. Darunter der Quelltext.' });
      return false;
    }
    const viewEl = pane.createDiv({ cls: 'cmv-math-view' });
    for (const part of splitTexChunks(tex)) {
      // Jede Formel kann eigene Begrenzer haben ($$a$$, Leerzeile, $$b$$).
      const chunk = stripTexDelimiters(part) || part;
      /** @type {HTMLElement | null} */
      let math = null;
      try {
        math = renderMath(normalizeTexChunk(chunk), true);
      } catch (_e) {
        math = null;
      }
      if (!math || mathHasError(math)) {
        viewEl.remove();
        pane.createDiv({ cls: 'cmv-note', text: 'Formel konnte nicht gesetzt werden. Darunter der Quelltext.' });
        return false;
      }
      viewEl.createDiv({ cls: 'cmv-math-display' }).appendChild(math);
    }
    try {
      await finishRenderMath();
    } catch (_e) {
      /* Stylesheet wird beim nächsten Mal geschrieben */
    }
    return true;
  }

  /**
   * ```latex und ```math als Formel. Ein ganzes LaTeX-Dokument (\documentclass
   * usw.) lässt sich ohne LaTeX-Programm nicht setzen; es bleibt Quelltext.
   * @param {string} source
   * @param {HTMLElement} el
   */
  async renderTexBlock(source, el) {
    el.addClass('cmv-tex');
    const tex = stripTexDelimiters(source);
    if (!tex) return;
    if (looksLikeLatexDocument(source)) {
      await this.renderPlainCode(el, source, 'latex', { note: 'Ganzes LaTeX-Dokument: Obsidian kann es nicht setzen. Hier der Quelltext.' });
      return;
    }
    if (!(await this.renderFormulaInto(el, tex))) await this.renderPlainCode(el, source, 'latex');
  }

  /**
   * ```csv und ```tsv als Tabelle.
   * @param {string} source
   * @param {HTMLElement} el
   * @param {string} lang
   */
  async renderCsvBlock(source, el, lang) {
    el.addClass('cmv-csv');
    const rows = parseCsv(source, lang === 'tsv' ? '\t' : detectDelimiter(source));
    if (rows.length === 0) return;
    renderCsvTable(el, rows);
  }

  /**
   * ```markdown und ```md als dargestelltes Beispiel.
   * @param {string} source
   * @param {HTMLElement} el
   * @param {import('obsidian').MarkdownPostProcessorContext} ctx
   */
  async renderMarkdownBlock(source, el, ctx) {
    el.addClass('cmv-mdblock');
    const child = new MarkdownRenderChild(el);
    ctx.addChild(child);
    try {
      await MarkdownRenderer.render(this.app, transformMarkdown(source), el, ctx.sourcePath, child);
    } catch (err) {
      console.error(LOG_PREFIX, 'Markdown-Vorschau fehlgeschlagen', err);
      el.empty();
      await this.renderPlainCode(el, source, 'markdown');
    }
  }

  /**
   * ```svg als Bild.
   * @param {string} source
   * @param {HTMLElement} el
   */
  async renderSvgBlock(source, el) {
    const url = svgDataUrl(source);
    if (!url) {
      await this.renderPlainCode(el, source, 'svg');
      return;
    }
    el.addClass('cmv-svg');
    el.createEl('img', { attr: { src: url, alt: 'SVG-Grafik' } });
  }

  /* ---------- Links: GitHub-Anker, keine neuen Notizen ---------- */

  /** @param {Element} el */
  viewForElement(el) {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.containerEl.contains(el)) return view;
    }
    return null;
  }

  /** @param {MouseEvent} evt */
  stopEvent(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation();
  }

  /** @param {MouseEvent} evt */
  onLinkClick(evt) {
    if (evt.defaultPrevented) return;
    if (evt.type === 'auxclick' && evt.button !== 1) return;
    const target = /** @type {Element | null} */ (evt.target);
    if (!target || typeof target.closest !== 'function') return;
    const a = target.closest('a');
    if (!a || !a.closest('.markdown-preview-view, .markdown-rendered')) return;
    // Obsidian-Tags (<a class="tag" href="#tag">) sind keine Anker: Ein Klick
    // soll die Tag-Suche öffnen, nicht zu einer gleichnamigen Überschrift springen.
    if (a.classList.contains('tag')) return;
    const href = a.getAttribute('data-href') || a.getAttribute('href') || '';
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
    try {
      if (href.includes('#') && this.tryResolveAnchor(evt, a, href)) return;
      if (this.settings.viewOnly && a.classList.contains('is-unresolved')) {
        this.stopEvent(evt);
        new Notice(`Link-Ziel nicht im Vault: ${safeDecode(href)}`);
      }
    } catch (err) {
      console.error(LOG_PREFIX, 'Fehler beim Link-Klick', err);
    }
  }

  /**
   * @param {MouseEvent} evt
   * @param {Element} a
   * @param {string} href
   */
  tryResolveAnchor(evt, a, href) {
    const hashAt = href.indexOf('#');
    const pathPart = safeDecode(href.slice(0, hashAt)).replace(/^\.\//, '');
    const anchor = href.slice(hashAt + 1);
    if (!anchor || anchor.startsWith('^')) return false;
    const view = this.viewForElement(a);
    if (!view) return false;
    const file = view.file;
    const sameFile =
      pathPart === '' ||
      (file !== null && (pathPart === file.path || pathPart === file.name || pathPart === file.basename));
    if (sameFile) {
      const text = view.data || view.getViewData();
      const index = buildHeadingIndex(text);
      const target = resolveAnchor(index, anchor);
      if (!target) return false;
      // Liegt das Ziel in einem Klapp- oder Kommentarbereich, steckt die
      // Überschrift im ersten Abschnitt des Bereichs; ihr eigener Abschnitt ist
      // ausgeblendet. Dann im DOM suchen statt über die Zeile springen.
      // prepareLines wie in analyze(), sonst fehlen maskierte \<details> aus
      // Docs-Exporten.
      const lines = prepareLines(splitLines(text));
      const region = this.findRegions(lines, computeProtectedMask(lines)).regions.find(
        (r) => r.start <= target.line && target.line <= r.end
      );
      if (target.exact && !region) return false;
      this.stopEvent(evt);
      if (region && target.heading && this.scrollToHeadingInDom(view, index, target.heading)) return true;
      this.scrollToLine(view, region ? region.start : target.line, target.heading ? target.heading.raw : null);
      return true;
    }
    const sourcePath = file ? file.path : '';
    const dest =
      this.app.metadataCache.getFirstLinkpathDest(pathPart, sourcePath) ||
      this.app.metadataCache.getFirstLinkpathDest(pathPart.replace(/\.md$/i, ''), sourcePath);
    if (!dest) return false;
    const cache = this.app.metadataCache.getFileCache(dest);
    const list = ((cache && cache.headings) || []).map((h) => ({ raw: h.heading, line: h.position.start.line, level: h.level }));
    const target = resolveAnchor(makeHeadingIndex(list, []), anchor);
    if (!target || target.exact || !target.heading) return false;
    this.stopEvent(evt);
    const newLeaf = evt.ctrlKey || evt.metaKey || evt.type === 'auxclick';
    void this.app.workspace.openLinkText(`${dest.path}#${linkSafeHeading(target.heading.raw)}`, sourcePath, newLeaf);
    return true;
  }

  /**
   * @param {import('obsidian').MarkdownView} view
   * @param {number} line
   * @param {string | null} headingRaw
   */
  scrollToLine(view, line, headingRaw) {
    try {
      // Leseansicht: applyScroll und setEphemeralState arbeiten zeilenbasiert
      // (0-basiert); setEphemeralState hebt die Zeile zusätzlich kurz hervor.
      if (view.getMode() === 'preview') view.previewMode.applyScroll(line);
      view.setEphemeralState({ line });
    } catch (err) {
      if (headingRaw && view.file) {
        void this.app.workspace.openLinkText(`#${linkSafeHeading(headingRaw)}`, view.file.path, false);
      } else {
        console.error(LOG_PREFIX, 'Sprung zur Überschrift fehlgeschlagen', err);
      }
    }
  }

  /**
   * Sucht die Überschrift in der Leseansicht und scrollt zu ihr. Liegt sie in
   * eingeklappten Bereichen, werden diese zuerst aufgeklappt (nur Anzeige).
   * @param {import('obsidian').MarkdownView} view
   * @param {HeadingIndex} index
   * @param {HeadingEntry} heading
   * @returns {boolean} false, wenn die Überschrift nicht im DOM steht
   */
  scrollToHeadingInDom(view, index, heading) {
    const want = heading.text;
    const nth = index.headings.filter((h) => h.text === want).indexOf(heading);
    const root = view.containerEl.querySelector('.markdown-preview-view') || view.containerEl;
    const found = Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6')).filter(
      (h) => !h.closest('.cmv-hidden') && (h.textContent || '').replace(/\s+/g, ' ').trim() === want
    );
    const el = found[Math.max(0, nth)] || found[0];
    if (!el) return false;
    /** @type {Element[]} */
    const collapsed = [];
    for (let c = el.closest('.callout.is-collapsed'); c; c = c.parentElement ? c.parentElement.closest('.callout.is-collapsed') : null) {
      collapsed.unshift(c);
    }
    for (const c of collapsed) {
      const title = /** @type {HTMLElement | null} */ (c.querySelector(':scope > .callout-title'));
      if (title) title.click();
    }
    window.setTimeout(() => el.scrollIntoView({ block: 'start' }), collapsed.length ? 80 : 0);
    return true;
  }
}

/* ======================================================================
 * Einstellungsseite
 * ==================================================================== */

class ViewerSettingTab extends PluginSettingTab {
  /**
   * @param {import('obsidian').App} app
   * @param {ClaudeMarkdownViewer} plugin
   */
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const plugin = this.plugin;
    new Setting(containerEl)
      .setName('Nur ansehen')
      .setDesc(
        'Markdown-Dateien öffnen immer in der Leseansicht; ein Wechsel zum Bearbeiten wird sofort zurückgenommen. Checkboxen und Eigenschaften sind nicht änderbar, Links zu fehlenden Dateien legen keine Notiz an. Ausschalten, um ausnahmsweise in Obsidian zu bearbeiten.'
      )
      .addToggle((t) =>
        t.setValue(plugin.settings.viewOnly).onChange(async (value) => {
          plugin.settings.viewOnly = value;
          await plugin.saveSettings();
        })
      );
  }
}

/* Nur für Tests: reine Funktionen. Obsidian ignoriert diese Eigenschaft. */
/** @type {any} */ (ClaudeMarkdownViewer).__test = {
  splitLines,
  computeFenceMask,
  computeProtectedMask,
  findInlineCodeRanges,
  convertMathDelimiters,
  convertDetailsInText,
  detailsBlockToCallout,
  findDetailsRegions,
  findCommentRegions,
  escapeComments,
  mergeRegions,
  unescapeHtmlLine,
  prepareLines,
  transformMarkdown,
  buildSectionMarkdown,
  collectFootnotes,
  githubSlug,
  headingPlainText,
  buildHeadingIndex,
  makeHeadingIndex,
  resolveAnchor,
  linkSafeHeading,
  looksLikeLatexDocument,
  stripTexDelimiters,
  splitTexChunks,
  normalizeTexChunk,
  detectDelimiter,
  parseCsv,
  numericColumns,
  relativeImagePath,
  svgDataUrl,
  decorateEmbedPlaceholders,
  wrapTables,
  decorateFootnoteRefs,
  DEFAULT_SETTINGS,
};

module.exports = ClaudeMarkdownViewer;
/** @type {any} */ (module.exports).default = ClaudeMarkdownViewer;
