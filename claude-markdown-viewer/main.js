// @ts-check
/*
 * Claude Markdown Viewer
 * ----------------------
 * Zeigt Markdown-Dateien aus Claude Docs (Markdown-Export), Claude-Chats und
 * Claude Code in Obsidian wahlweise so an, wie Claude sie darstellt, oder nach
 * der Norm (Markdown-Standard wie auf GitHub). Umschaltbar als Standard, je
 * Datei (Augen-Symbol) und je Block.
 *
 * Reines CommonJS ohne Build-Schritt: main.js, manifest.json und styles.css
 * in <Vault>/.obsidian/plugins/claude-markdown-viewer/ legen und aktivieren.
 * Reiner Viewer: Das Plugin liest Dateien nur, schreibt nie in Notizen und hat
 * keine Bearbeitungsfunktionen. Gespeichert werden nur die eigenen
 * Einstellungen (data.json im Plugin-Ordner).
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
  Menu,
  TFile,
  setIcon,
  loadMathJax,
  renderMath,
  finishRenderMath,
  loadPrism,
} = obsidian;

/* ======================================================================
 * Einstellungen
 * ==================================================================== */

/**
 * Standard-Darstellung: wie Claude (Docs-Export oder Chat/Code, automatisch
 * erkannt) oder Norm (Markdown-Standard wie auf GitHub).
 * @typedef {'claude' | 'norm'} RenderMode
 */
/**
 * Einfache Zeilenumbrüche: getrennt (jede Zeile einzeln) oder zusammen
 * (ein Absatz, wie die Norm).
 * @typedef {'split' | 'join'} BreakMode
 */
/** @typedef {'auto' | BreakMode} LineBreakMode */
/**
 * Darstellung einer einzelnen Datei.
 * @typedef {'docs' | 'chat' | 'norm'} FileStyle
 */
/**
 * Eigene Einstellung einer Datei. Fehlt ein Wert, gilt der Standard.
 * @typedef {{ style?: FileStyle, breaks?: BreakMode }} FileMode
 */

/**
 * @typedef {Object} ViewerSettings
 * @property {boolean} lockReadingView
 * @property {boolean} readOnlyCheckboxes
 * @property {boolean} blockUnresolvedLinks
 * @property {RenderMode} renderMode
 * @property {LineBreakMode} lineBreaks
 * @property {Record<string, FileMode>} fileModes
 * @property {string} docsFolders
 * @property {boolean} renderDetails
 * @property {boolean} githubAnchors
 * @property {boolean} embedPlaceholders
 * @property {boolean} scrollableTables
 * @property {boolean} githubAlertColors
 * @property {boolean} linkifyWww
 */

/** @type {ViewerSettings} */
const DEFAULT_SETTINGS = {
  lockReadingView: true,
  readOnlyCheckboxes: true,
  blockUnresolvedLinks: true,
  renderMode: 'claude',
  lineBreaks: 'auto',
  fileModes: {},
  docsFolders: '',
  renderDetails: true,
  githubAnchors: true,
  embedPlaceholders: true,
  scrollableTables: true,
  githubAlertColors: true,
  linkifyWww: true,
};

const LOG_PREFIX = '[Claude Markdown Viewer]';
const DETAILS_CALLOUT = 'claude-details';

/** @type {FileStyle[]} */
const FILE_STYLES = ['docs', 'chat', 'norm'];

/**
 * Einfache Zeilenumbrüche, wenn nichts anderes eingestellt ist.
 * Wie Claude: getrennt (so zeigt es auch Obsidian ab Werk, „Strenge
 * Zeilenumbrüche“ aus). Ein Docs-Export enthält einen einfachen Umbruch nur,
 * wenn das Doc dort eine neue Zeile hatte. Norm: zusammen (CommonMark).
 * @type {Record<FileStyle, BreakMode>}
 */
const AUTO_BREAKS = { docs: 'split', chat: 'split', norm: 'join' };

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
 * Entfernt Inline-Code aus einer Zeile (für Tag- und Fußnotensuche).
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

/** @param {string} s */
function trimBlankLines(s) {
  const lines = s.split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

/* ---------- Formeln mit \( … \) und \[ … \] ---------- */

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
  const lines = md.split('\n');
  const mask = computeProtectedMask(lines, withFrontmatter);
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  let buf = [];
  const flush = () => {
    if (buf.length) {
      out.push(convertMathChunk(buf.join('\n')));
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

/* ---------- <details>/<summary> ---------- */

const DETAILS_OPEN_LINE = /^[ \t]{0,3}<details(?:\s[^>]*)?>/i;
const DETAILS_OPEN_ANY = /<details(?:\s[^>]*)?>/gi;
const DETAILS_CLOSE_ANY = /<\/details\s*>/gi;

/**
 * @param {string} line
 */
function countDetailsTags(line) {
  const s = stripInlineCode(line).replace(/\\</g, '');
  return {
    opens: (s.match(DETAILS_OPEN_ANY) || []).length,
    closes: (s.match(DETAILS_CLOSE_ANY) || []).length,
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
 */
function detailsBlockToCallout(block) {
  const m = /^[ \t]{0,3}<details(\s[^>]*)?>/i.exec(block);
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

/* ---------- Einfache Zeilenumbrüche: getrennt oder zusammen ---------- */

const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const ATX_RE = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
const HR_RE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_UNDERLINE_RE = /^[ \t]{0,3}(?:=+|-+)[ \t]*$/;
const DEFINITION_RE = /^[ \t]{0,3}\[[^\]]+\]:/;
const HARD_BREAK_SYNTAX_RE = /(?: {2,}|\\)$/;
const BR_END_RE = /<br\s*\/?>$/i;
const CALLOUT_HEAD_RE = /^\[![\w-]+\][+-]?/;
const QUOTE_PREFIX_RE = /^((?:[ \t]{0,3}>[ \t]?)*)([\s\S]*)$/;

/*
 * HTML-Blöcke nach CommonMark (Abschnitt 4.6). Typ 1 bis 5 enden an einer
 * Schlussmarke, Typ 6 und 7 an einer Leerzeile. Typ 7 (ein beliebiges Tag
 * allein auf der Zeile) kann keinen Absatz unterbrechen.
 */
/** @type {Array<{ start: RegExp, end: RegExp }>} */
const HTML_BLOCK_1_TO_5 = [
  { start: /^[ \t]{0,3}<(?:script|pre|style|textarea)(?:\s|>|$)/i, end: /<\/(?:script|pre|style|textarea)>/i },
  { start: /^[ \t]{0,3}<!--/, end: /-->/ },
  { start: /^[ \t]{0,3}<\?/, end: /\?>/ },
  { start: /^[ \t]{0,3}<![A-Za-z]/, end: />/ },
  { start: /^[ \t]{0,3}<!\[CDATA\[/, end: /\]\]>/ },
];
const HTML_BLOCK_6_RE =
  /^[ \t]{0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i;
const HTML_BLOCK_7_RE =
  /^[ \t]{0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/;

/**
 * True, wenn die Zeile einen HTML-Block beginnt, der auch mitten in einem
 * Absatz anfangen darf (Typ 1 bis 6).
 * @param {string} content
 */
function startsInterruptingHtml(content) {
  return HTML_BLOCK_6_RE.test(content) || HTML_BLOCK_1_TO_5.some((t) => t.start.test(content));
}

/**
 * Trennt Zitat-Präfixe (>) vom Zeileninhalt.
 * @param {string} line
 */
function splitQuote(line) {
  const m = QUOTE_PREFIX_RE.exec(line);
  const prefix = m ? m[1] : '';
  return { prefix, depth: (prefix.match(/>/g) || []).length, content: m ? m[2] : line };
}

/**
 * Zeilen, in denen ein Zeilenumbruch nie angefasst wird: Code, Frontmatter,
 * $$-Formeln, Tabellen und HTML-Blöcke.
 * @param {string[]} lines
 * @param {boolean} withFrontmatter
 */
function computeBreakProtection(lines, withFrontmatter) {
  const prot = computeProtectedMask(lines, withFrontmatter);
  /** @param {number} i */
  const content = (i) => splitQuote(lines[i]).content;
  /** @param {number} i */
  const blankBefore = (i) => i === 0 || content(i - 1).trim() === '';

  let inMath = false;
  for (let i = 0; i < lines.length; i++) {
    if (prot[i]) continue;
    const c = content(i).trim();
    if (inMath) {
      prot[i] = true;
      if (c.endsWith('$$')) inMath = false;
      continue;
    }
    if (c.startsWith('$$')) {
      prot[i] = true;
      if (c === '$$' || !c.endsWith('$$')) inMath = true;
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (prot[i]) continue;
    const t = content(i).replace(/\s/g, '');
    if (t.includes('|') && t.includes('-') && /^[|:-]+$/.test(t)) {
      if (i > 0 && lines[i - 1].trim() !== '') prot[i - 1] = true;
      for (let j = i; j < lines.length && lines[j].trim() !== ''; j++) prot[j] = true;
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (prot[i]) continue;
    const c = content(i);
    const typed = HTML_BLOCK_1_TO_5.find((t) => t.start.test(c));
    if (typed) {
      let j = i;
      while (j < lines.length && !prot[j]) {
        prot[j] = true;
        if (typed.end.test(content(j))) break;
        j++;
      }
      i = j;
      continue;
    }
    // Typ 7 darf nicht mitten in einem Absatz beginnen, wohl aber nach einer
    // Leerzeile, einer Überschrift oder einem anderen geschützten Block.
    const afterBlock = blankBefore(i) || prot[i - 1] || ATX_RE.test(content(i - 1)) || HR_RE.test(content(i - 1));
    if (HTML_BLOCK_6_RE.test(c) || (HTML_BLOCK_7_RE.test(c) && afterBlock)) {
      let j = i;
      for (; j < lines.length && lines[j].trim() !== ''; j++) prot[j] = true;
      i = j;
    }
  }
  // Eingerückter Code: 4 Leerzeichen oder Tab nach einer Leerzeile, außerhalb
  // von Listen. In Listen ist so eine Zeile ein eingerückter Absatz.
  let inList = false;
  let indentedRun = false;
  for (let i = 0; i < lines.length; i++) {
    const c = content(i);
    if (c.trim() === '') {
      indentedRun = false;
      continue;
    }
    const isCode = !prot[i] && /^(?: {4}|\t)/.test(c) && (indentedRun || (blankBefore(i) && !inList));
    if (isCode) {
      prot[i] = true;
      indentedRun = true;
      continue;
    }
    indentedRun = false;
    if (LIST_ITEM_RE.test(c)) inList = true;
    else if (!/^[ \t]/.test(c) && (blankBefore(i) || ATX_RE.test(c) || HR_RE.test(c))) inList = false;
  }
  return prot;
}

/**
 * Art des Zeilenumbruchs zwischen Zeile i und i+1: 'soft' (einfacher Umbruch
 * im Absatz), 'br' (Zeile endet mit <br>, danach ein einfacher Umbruch) oder
 * null (kein einfacher Umbruch: Leerzeile, harter Umbruch, neuer Block).
 * @param {string[]} lines
 * @param {boolean[]} prot
 * @param {number} i
 * @returns {'soft' | 'br' | null}
 */
function softBreakKind(lines, prot, i) {
  if (prot[i] || prot[i + 1]) return null;
  const a = splitQuote(lines[i]);
  const b = splitQuote(lines[i + 1]);
  if (a.content.trim() === '' || b.content.trim() === '') return null;
  if (HARD_BREAK_SYNTAX_RE.test(a.content)) return null;
  if (b.depth > a.depth) return null;
  if (CALLOUT_HEAD_RE.test(a.content.trim())) return null;
  for (const c of [a.content, b.content]) {
    if (ATX_RE.test(c) || HR_RE.test(c) || DEFINITION_RE.test(c) || FENCE_RE.test(c) || startsInterruptingHtml(c)) return null;
    if (/^[ \t]*\|/.test(c)) return null;
  }
  if (LIST_ITEM_RE.test(b.content) || SETEXT_UNDERLINE_RE.test(b.content) || SETEXT_UNDERLINE_RE.test(a.content)) return null;
  return BR_END_RE.test(a.content.replace(/[ \t]+$/, '')) ? 'br' : 'soft';
}

/**
 * Macht einfache Zeilenumbrüche eindeutig: 'split' setzt einen harten
 * Umbruch (jede Zeile einzeln), 'join' zieht die Zeilen zu einem Absatz
 * zusammen (CommonMark-Norm). Harte Umbrüche, Listen, Tabellen, Code und
 * Überschriften bleiben unverändert. Endet eine Zeile mit <br>, ist das schon
 * der Umbruch: 'split' lässt sie, 'join' hängt die nächste Zeile an.
 * @param {string} md
 * @param {BreakMode} mode
 * @param {boolean} [withFrontmatter]
 */
function convertSoftBreaks(md, mode, withFrontmatter = true) {
  if (md.indexOf('\n') === -1) return md;
  const lines = md.split('\n');
  const prot = computeBreakProtection(lines, withFrontmatter);
  /** @type {string[]} */
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let cur = lines[i];
    while (i + 1 < lines.length) {
      const kind = softBreakKind(lines, prot, i);
      if (!kind || (kind === 'br' && mode === 'split')) break;
      if (mode === 'split') {
        out.push(cur.replace(/[ \t]+$/, '') + '  ');
        i++;
        cur = lines[i];
      } else {
        const next = splitQuote(lines[i + 1]).content.replace(/^[ \t]+/, '');
        cur = cur.replace(/[ \t]+$/, '') + ' ' + next;
        i++;
      }
    }
    out.push(cur);
    i++;
  }
  return out.join('\n');
}

/**
 * Wandelt alles um (für Vorschauen und verschachtelte Darstellungen).
 * @param {string} md
 * @param {{ details: boolean, delims: boolean, breaks?: BreakMode | null }} opts
 */
function transformMarkdown(md, opts) {
  let out = md;
  if (opts.details) out = convertDetailsInText(out);
  if (opts.delims) out = convertMathDelimiters(out);
  if (opts.breaks) out = convertSoftBreaks(out, opts.breaks, true);
  return out;
}

/**
 * Baut den Markdown-Text, den ein Abschnitt der Leseansicht zeigen soll.
 * Obsidian rendert jeden durch Leerzeilen getrennten Block einzeln; ein
 * <details>-Block mit Leerzeilen zerfällt dabei in mehrere Abschnitte. Der
 * erste Abschnitt zeigt deshalb den ganzen Block, die übrigen bleiben leer.
 * @param {string[]} lines Zeilen der ganzen Datei
 * @param {number} lineStart
 * @param {number} lineEnd
 * @param {Array<{ start: number, end: number }>} regions
 * @param {{ details: boolean, delims: boolean, breaks?: BreakMode | null }} opts
 * @returns {{ changed: boolean, markdown: string }}
 */
function buildSectionMarkdown(lines, lineStart, lineEnd, regions, opts) {
  /** @type {string[]} */
  const parts = [];
  let changed = false;
  let i = lineStart;
  const last = Math.min(lineEnd, lines.length - 1);
  while (i <= last) {
    const line = i;
    const r = opts.details ? regions.find((x) => x.start <= line && line <= x.end) : undefined;
    if (r && r.start < lineStart) {
      changed = true;
      i = r.end + 1;
      continue;
    }
    if (r && r.start === i) {
      changed = true;
      if (parts.length && parts[parts.length - 1].trim() !== '') parts.push('');
      parts.push(detailsBlockToCallout(lines.slice(r.start, r.end + 1).join('\n')));
      parts.push('');
      i = r.end + 1;
      continue;
    }
    parts.push(lines[i]);
    i++;
  }
  let markdown = parts.join('\n');
  if (opts.delims) {
    const converted = convertMathDelimiters(markdown, lineStart === 0);
    if (converted !== markdown) {
      changed = true;
      markdown = converted;
    }
  }
  if (opts.breaks) {
    const converted = convertSoftBreaks(markdown, opts.breaks, lineStart === 0);
    if (converted !== markdown) {
      changed = true;
      markdown = converted;
    }
  }
  return { changed, markdown };
}

/* ---------- Fußnoten (für neu dargestellte Abschnitte) ---------- */

/**
 * @param {string[]} lines
 * @param {boolean[]} mask
 * @returns {{ defs: Map<string, string>, order: Map<string, number> }}
 */
function collectFootnotes(lines, mask) {
  /** @type {Map<string, string>} */
  const defs = new Map();
  /** @type {Map<string, number>} */
  const order = new Map();
  const defRe = /^\[\^([^\]\s]+)\]:\s?(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const d = defRe.exec(lines[i]);
    if (d) {
      defs.set(d[1], d[2].trim());
      continue;
    }
    const refRe = /\[\^([^\]\s]+)\](?!:)/g;
    const line = stripInlineCode(lines[i]);
    let m;
    while ((m = refRe.exec(line)) !== null) {
      if (!order.has(m[1])) order.set(m[1], order.size + 1);
    }
  }
  return { defs, order };
}

/* ---------- Überschriften und GitHub-Anker ---------- */

/**
 * Slug wie bei GitHub (github-slugger): Kleinbuchstaben, Satzzeichen und
 * Emoji entfernen, Leerzeichen zu Bindestrichen. Umlaute bleiben.
 * @param {string} text
 */
function githubSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
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
 * @typedef {{ text: string, raw: string, line: number, level: number, slug: string }} HeadingEntry
 * @typedef {{ headings: HeadingEntry[], anchors: Array<{ id: string, line: number }> }} HeadingIndex
 */

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

/* ---------- Claude-Docs-Export erkennen ---------- */

const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const DOCS_DATE = `(?:${MONTHS}) \\d{1,2}, \\d{4}`;
const DOCS_BYLINE_RE = new RegExp(`^(?:${DOCS_DATE}(?: · @.+)?|@.+ · ${DOCS_DATE})$`);
const EMBED_PLACEHOLDER_RE = /^\[embedded content(?::\s*([\s\S]*?))?\]$/;

/**
 * @param {string} folders Kommagetrennte Liste aus den Einstellungen
 * @returns {string[]}
 */
function parseFolderList(folders) {
  return folders
    .split(/[,\n]/)
    .map((f) => f.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
}

/**
 * Erkennt einen Markdown-Export aus Claude Docs.
 * @param {string} text
 * @param {string} path
 * @param {string[]} folders
 */
function isDocsExport(text, path, folders) {
  if (path && folders.some((f) => path === f || path.startsWith(f + '/'))) return true;
  if (text.includes('&#91;embedded content')) return true;
  const head = splitLines(text).slice(0, 15).map((l) => l.trim());
  const h1 = head.findIndex((l) => /^# \S/.test(l));
  if (h1 >= 0) {
    const next = head.slice(h1 + 1).find((l) => l !== '');
    if (next && DOCS_BYLINE_RE.test(next)) return true;
  }
  return false;
}

/* ---------- Formeln aus ```latex / ```math ---------- */

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

/* ---------- CSV ---------- */

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

/* ======================================================================
 * DOM-Hilfsfunktionen
 * ==================================================================== */

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
    note.textContent = 'Fehlt im Markdown-Export. Im Original-Doc ansehen oder Claude bitten, das Doc mit Diagrammen als Bilder zu exportieren.';
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

const WWW_RE = /(^|[\s(\[<"'„“])(www\.[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+(?:[/?#][^\s<>"')\]]*)?)/gi;

/**
 * Verlinkt nackte www.-Adressen (GitHub tut das, Obsidian nicht).
 * @param {HTMLElement} root
 */
function linkifyWww(root) {
  if (!/www\./i.test(root.textContent || '')) return;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  /** @type {Text[]} */
  const nodes = [];
  let n;
  while ((n = walker.nextNode()) !== null) {
    const parent = n.parentElement;
    if (!parent || parent.closest('a, code, pre, .math, mjx-container, .katex, svg')) continue;
    if (/www\./i.test(n.nodeValue || '')) nodes.push(/** @type {Text} */ (n));
  }
  for (const node of nodes) {
    const text = node.nodeValue || '';
    WWW_RE.lastIndex = 0;
    const frag = doc.createDocumentFragment();
    let last = 0;
    let any = false;
    let m;
    while ((m = WWW_RE.exec(text)) !== null) {
      let url = m[2];
      const trail = /[.,;:!?]+$/.exec(url);
      if (trail) url = url.slice(0, -trail[0].length);
      const start = m.index + m[1].length;
      frag.append(text.slice(last, start));
      const a = doc.createElement('a');
      a.className = 'external-link';
      a.href = 'https://' + url;
      a.textContent = url;
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener nofollow');
      frag.append(a);
      last = start + url.length;
      any = true;
    }
    if (!any) continue;
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

/**
 * Macht aus wörtlichem "[^1]" in neu dargestellten Abschnitten wieder eine
 * hochgestellte Fußnotennummer mit Tooltip.
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
      sup.textContent = String(fn.order.get(m[1]) || m[1]);
      sup.setAttribute('title', def);
      sup.setAttribute('aria-label', `Fußnote ${sup.textContent}: ${def}`);
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

/**
 * Kleine Werkzeugleiste oben rechts an einem Block.
 * @param {HTMLElement} host
 * @param {Array<{ icon: string, label: string, onClick: (btn: HTMLElement) => void }>} buttons
 */
function addToolbar(host, buttons) {
  const bar = host.createDiv({ cls: 'cmv-toolbar' });
  for (const b of buttons) {
    const btn = bar.createEl('button', { cls: 'cmv-toolbar-btn', attr: { type: 'button' } });
    setButtonFace(btn, b.icon, b.label);
    btn.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      b.onClick(btn);
    });
  }
  return bar;
}

/**
 * Setzt Symbol und Beschriftung eines Knopfs (Text, falls das Symbol fehlt).
 * @param {HTMLElement} btn
 * @param {string} icon
 * @param {string} label
 */
function setButtonFace(btn, icon, label) {
  btn.empty();
  btn.setAttr('aria-label', label);
  btn.setAttr('title', label);
  setIcon(btn, icon);
  if (!btn.querySelector('svg')) btn.setText(label);
}

/* ======================================================================
 * Darstellung je Datei: wie Claude (Docs oder Chat/Code) oder Norm
 * ==================================================================== */

/** @type {Record<FileStyle, string>} */
const STYLE_SHORT = { docs: 'wie Claude Docs', chat: 'wie Claude-Chat/Code', norm: 'Norm' };

/** @type {Record<FileStyle, string>} */
const STYLE_LONG = {
  docs: 'Wie Claude Docs (Docs-Export)',
  chat: 'Wie Claude-Chat und Claude Code',
  norm: 'Norm (Markdown-Standard wie auf GitHub)',
};

/** @type {Record<BreakMode, string>} */
const BREAKS_SHORT = { split: 'getrennt', join: 'zusammen' };

/** @type {Record<BreakMode, string>} */
const BREAKS_LONG = {
  split: 'Getrennt: jede Zeile einzeln',
  join: 'Zusammen: ein Absatz (Norm)',
};

/** @type {BreakMode[]} */
const BREAK_MODES = ['split', 'join'];

/**
 * Übernimmt aus gespeicherten Datei-Einstellungen nur gültige Einträge.
 * @param {unknown} raw
 * @returns {Record<string, FileMode>}
 */
function sanitizeFileModes(raw) {
  /** @type {Record<string, FileMode>} */
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [path, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const v = /** @type {any} */ (value);
    /** @type {FileMode} */
    const fm = {};
    if (FILE_STYLES.includes(v.style)) fm.style = v.style;
    if (BREAK_MODES.includes(v.breaks)) fm.breaks = v.breaks;
    if (fm.style || fm.breaks) out[path] = fm;
  }
  return out;
}

/**
 * Darstellung ohne eigene Einstellung der Datei.
 * @param {ViewerSettings} settings
 * @param {boolean} isDocs
 * @returns {FileStyle}
 */
function autoStyle(settings, isDocs) {
  if (settings.renderMode === 'norm') return 'norm';
  return isDocs ? 'docs' : 'chat';
}

/**
 * @param {ViewerSettings} settings
 * @param {string} path
 * @param {boolean} isDocs
 * @returns {FileStyle}
 */
function resolveStyle(settings, path, isDocs) {
  const own = settings.fileModes[path];
  if (own && own.style) return own.style;
  return autoStyle(settings, isDocs);
}

/**
 * Zeilenumbrüche ohne eigene Einstellung der Datei.
 * @param {ViewerSettings} settings
 * @param {FileStyle} style
 * @returns {BreakMode}
 */
function autoLineBreaks(settings, style) {
  return settings.lineBreaks === 'auto' ? AUTO_BREAKS[style] : settings.lineBreaks;
}

/**
 * @param {ViewerSettings} settings
 * @param {string} path
 * @param {FileStyle} style
 * @returns {BreakMode}
 */
function resolveLineBreaks(settings, path, style) {
  const own = settings.fileModes[path];
  if (own && own.breaks) return own.breaks;
  return autoLineBreaks(settings, style);
}

/**
 * Was am Text noch zu tun ist, damit Obsidian die Zeilenumbrüche wie gewünscht
 * zeigt. null: Obsidian zeigt sie schon so.
 * @param {BreakMode} mode
 * @param {boolean | null} strict Obsidian-Einstellung „Strenge Zeilenumbrüche“, null wenn unbekannt
 * @returns {BreakMode | null}
 */
function breakTransform(mode, strict) {
  if (mode === 'join' && strict === true) return null;
  if (mode === 'split' && strict === false) return null;
  return mode;
}

/**
 * Verschiebt Datei-Einstellungen nach Umbenennen einer Datei oder eines Ordners.
 * @param {Record<string, FileMode>} fileModes
 * @param {string} oldPath
 * @param {string} newPath
 * @returns {boolean} true, wenn sich etwas geändert hat
 */
function moveFileModes(fileModes, oldPath, newPath) {
  let changed = false;
  for (const key of Object.keys(fileModes)) {
    /** @type {string | null} */
    let next = null;
    if (key === oldPath) next = newPath;
    else if (key.startsWith(oldPath + '/')) next = newPath + key.slice(oldPath.length);
    if (next === null || next === key) continue;
    fileModes[next] = fileModes[key];
    delete fileModes[key];
    changed = true;
  }
  return changed;
}

/* ======================================================================
 * Plugin
 * ==================================================================== */

/**
 * @typedef {Object} SwitchView
 * @property {string} id
 * @property {string} icon Symbol des Knopfs, der zu dieser Ansicht wechselt
 * @property {string} label Beschriftung dieses Knopfs
 * @property {(pane: HTMLElement) => Promise<boolean>} render false: Ansicht nicht möglich
 */

class ClaudeMarkdownViewer extends Plugin {
  /** @type {ViewerSettings} */
  settings = Object.assign({}, DEFAULT_SETTINGS, { fileModes: {} });

  /** Analyse der ganzen Datei je Darstellung (docId). */
  /** @type {Map<string, { text: string, lines: string[], regions: Array<{ start: number, end: number }>, isDocs: boolean, footnotes: { defs: Map<string, string>, order: Map<string, number> } }>} */
  analysisByDoc = new Map();

  /** Claude-Docs-Erkennung je Dateipfad. */
  /** @type {Map<string, boolean>} */
  docsFlagByPath = new Map();

  /** Pfade, deren Darstellung Mehrabschnitts-Blöcke (<details>) enthält. */
  /** @type {Set<string>} */
  pathsWithRegions = new Set();

  /** @type {Map<string, number>} */
  rerenderTimers = new Map();

  /** @type {WeakSet<import('obsidian').WorkspaceLeaf>} */
  switchingLeaves = new WeakSet();

  /** Fenster, in denen Klick-Handler und Klassen schon gesetzt sind. */
  /** @type {WeakSet<Document>} */
  attachedDocuments = new WeakSet();

  /** Augen-Symbol „Darstellung dieser Datei“ je Ansicht. */
  /** @type {WeakMap<import('obsidian').MarkdownView, HTMLElement>} */
  viewActions = new WeakMap();

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new ViewerSettingTab(this.app, this));

    for (const lang of ['latex', 'math']) {
      this.registerMarkdownCodeBlockProcessor(lang, (source, el, ctx) => this.renderTexBlock(source, el, ctx, lang));
    }
    for (const lang of ['csv', 'tsv']) {
      this.registerMarkdownCodeBlockProcessor(lang, (source, el, ctx) => this.renderCsvBlock(source, el, ctx, lang));
    }
    for (const lang of ['markdown', 'md']) {
      this.registerMarkdownCodeBlockProcessor(lang, (source, el, ctx) => this.renderMarkdownBlock(source, el, ctx));
    }

    this.registerMarkdownPostProcessor((el, ctx) => this.processSection(el, ctx), 100);
    this.registerMarkdownPostProcessor((el) => this.processDom(el), 200);

    this.attachToDocument(document);
    this.registerEvent(
      this.app.workspace.on('window-open', (win) => {
        this.attachToDocument(win.doc);
      })
    );

    const onLayout = () => {
      this.enforceReadingView();
      this.refreshViewActions();
    };
    this.registerEvent(this.app.workspace.on('layout-change', onLayout));
    this.registerEvent(this.app.workspace.on('active-leaf-change', onLayout));
    this.registerEvent(this.app.workspace.on('file-open', onLayout));
    this.registerEvent(this.app.vault.on('modify', (file) => this.onFileModified(file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onFileRenamed(file, oldPath)));

    this.addCommand({
      id: 'file-display-menu',
      name: 'Darstellung dieser Datei wählen …',
      checkCallback: (checking) => this.withActiveView(checking, (view) => this.openModeMenu(view, null)),
    });
    this.addCommand({
      id: 'toggle-norm',
      name: 'Diese Datei: Norm oder wie Claude',
      checkCallback: (checking) => this.withActiveView(checking, (view) => void this.toggleNorm(view)),
    });
    this.addCommand({
      id: 'toggle-line-breaks',
      name: 'Diese Datei: Zeilenumbrüche getrennt oder zusammen',
      checkCallback: (checking) => this.withActiveView(checking, (view) => void this.toggleLineBreaks(view)),
    });
    this.addCommand({
      id: 'rerender',
      name: 'Alle offenen Dateien neu darstellen',
      callback: () => this.rerenderAll(),
    });

    this.app.workspace.onLayoutReady(() => {
      for (const doc of this.knownDocuments()) this.attachToDocument(doc);
      onLayout();
      this.rerenderAll();
    });
  }

  onunload() {
    for (const doc of this.knownDocuments()) {
      doc.body.classList.remove('cmv-readonly-tasks', 'cmv-gh-alerts');
      doc.querySelectorAll('.cmv-view-action').forEach((node) => node.remove());
    }
    for (const t of this.rerenderTimers.values()) window.clearTimeout(t);
    this.rerenderAll();
  }

  async loadSettings() {
    /** @type {any} */
    const data = (await this.loadData()) || {};
    /** @type {any} */
    const s = Object.assign({}, DEFAULT_SETTINGS, data);
    if (s.renderMode !== 'norm') s.renderMode = 'claude';
    if (s.lineBreaks !== 'split' && s.lineBreaks !== 'join') s.lineBreaks = 'auto';
    s.fileModes = sanitizeFileModes(data.fileModes);
    // Einstellungen aus Version 1.0.0, die es nicht mehr gibt.
    for (const key of ['markdownBlockMode', 'renderLatexBlocks', 'renderCsvBlocks', 'renderMathDelimiters']) delete s[key];
    this.settings = s;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyBodyClasses();
    this.analysisByDoc.clear();
    this.docsFlagByPath.clear();
    this.rerenderAll();
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
    this.registerDomEvent(doc, 'click', (evt) => this.onLinkClick(evt), { capture: true });
    this.registerDomEvent(doc, 'auxclick', (evt) => this.onLinkClick(evt), { capture: true });
    this.applyBodyClasses(doc);
  }

  /** @param {Document} [only] */
  applyBodyClasses(only) {
    const docs = only ? [only] : this.knownDocuments();
    for (const doc of docs) {
      doc.body.classList.toggle('cmv-readonly-tasks', this.settings.readOnlyCheckboxes);
      doc.body.classList.toggle('cmv-gh-alerts', this.settings.githubAlertColors);
    }
  }

  /* ---------- Leseansicht ---------- */

  enforceReadingView() {
    if (!this.settings.lockReadingView) return;
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
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.previewMode) view.previewMode.rerender(true);
    }
  }

  /** @param {string} path */
  rerenderPath(path) {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file && view.file.path === path && view.previewMode) {
        view.previewMode.rerender(true);
      }
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
   * Eigene Einstellungen wandern beim Umbenennen mit (Datei oder Ordner).
   * @param {import('obsidian').TAbstractFile} file
   * @param {string} oldPath
   */
  onFileRenamed(file, oldPath) {
    if (moveFileModes(this.settings.fileModes, oldPath, file.path)) {
      void this.saveData(this.settings);
    }
  }

  /* ---------- Darstellung je Datei ---------- */

  /**
   * Obsidian-Einstellung „Strenge Zeilenumbrüche“. Nicht offizielle API,
   * deshalb vorsichtig gelesen; null, wenn unbekannt.
   * @returns {boolean | null}
   */
  obsidianStrictLineBreaks() {
    try {
      const vault = /** @type {any} */ (this.app.vault);
      const value = typeof vault.getConfig === 'function' ? vault.getConfig('strictLineBreaks') : undefined;
      return typeof value === 'boolean' ? value : null;
    } catch (_e) {
      return null;
    }
  }

  /**
   * @param {string} path
   * @param {FileStyle} style
   * @returns {BreakMode | null}
   */
  breakTransformFor(path, style) {
    return breakTransform(resolveLineBreaks(this.settings, path, style), this.obsidianStrictLineBreaks());
  }

  /**
   * Darstellung der Datei, zu der ein Block gehört.
   * @param {HTMLElement} el
   * @param {import('obsidian').MarkdownPostProcessorContext} ctx
   * @returns {Promise<FileStyle>}
   */
  async styleForContext(el, ctx) {
    const path = ctx.sourcePath || '';
    const own = this.settings.fileModes[path];
    if (own && own.style) return own.style;
    if (this.settings.renderMode === 'norm') return 'norm';
    return (await this.isDocsContext(el, ctx)) ? 'docs' : 'chat';
  }

  /**
   * Erkennung und Darstellung der Datei in einer Ansicht.
   * @param {import('obsidian').MarkdownView} view
   */
  fileState(view) {
    const path = view.file ? view.file.path : '';
    const text = view.data || '';
    const isDocs = isDocsExport(text, path, parseFolderList(this.settings.docsFolders));
    /** @type {FileMode} */
    const own = Object.assign({}, this.settings.fileModes[path]);
    const auto = autoStyle(this.settings, isDocs);
    const style = own.style || auto;
    const autoBreaks = autoLineBreaks(this.settings, style);
    const breaks = own.breaks || autoBreaks;
    return { path, isDocs, own, auto, style, autoBreaks, breaks };
  }

  /**
   * Setzt die eigene Einstellung einer Datei. undefined: zurück auf Standard.
   * Gespeichert wird in den Plugin-Daten, nie in der Datei.
   * @param {string} path
   * @param {{ style?: FileStyle, breaks?: BreakMode }} patch
   */
  async setFileMode(path, patch) {
    /** @type {FileMode} */
    const next = Object.assign({}, this.settings.fileModes[path]);
    if ('style' in patch) {
      if (patch.style) next.style = patch.style;
      else delete next.style;
    }
    if ('breaks' in patch) {
      if (patch.breaks) next.breaks = patch.breaks;
      else delete next.breaks;
    }
    if (next.style || next.breaks) this.settings.fileModes[path] = next;
    else delete this.settings.fileModes[path];
    await this.saveData(this.settings);
    this.analysisByDoc.clear();
    this.rerenderPath(path);
  }

  /**
   * @param {boolean} checking
   * @param {(view: import('obsidian').MarkdownView) => void} run
   */
  withActiveView(checking, run) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return false;
    if (!checking) run(view);
    return true;
  }

  /** @param {import('obsidian').MarkdownView} view */
  async toggleNorm(view) {
    const st = this.fileState(view);
    /** @type {FileStyle} */
    const target = st.style === 'norm' ? (st.isDocs ? 'docs' : 'chat') : 'norm';
    await this.setFileMode(st.path, { style: target === st.auto ? undefined : target });
    new Notice(`Darstellung: ${STYLE_LONG[target]}`);
  }

  /** @param {import('obsidian').MarkdownView} view */
  async toggleLineBreaks(view) {
    const st = this.fileState(view);
    /** @type {BreakMode} */
    const target = st.breaks === 'split' ? 'join' : 'split';
    await this.setFileMode(st.path, { breaks: target === st.autoBreaks ? undefined : target });
    new Notice(`Zeilenumbrüche: ${BREAKS_LONG[target]}`);
  }

  /**
   * Menü „Darstellung dieser Datei“.
   * @param {import('obsidian').MarkdownView} view
   * @param {MouseEvent | null} evt
   */
  openModeMenu(view, evt) {
    if (!view.file) return;
    const st = this.fileState(view);
    const menu = new Menu();
    /** @param {string} title */
    const label = (title) => menu.addItem((item) => item.setTitle(title).setIsLabel(true));
    /**
     * @param {string} title
     * @param {boolean} checked
     * @param {{ style?: FileStyle, breaks?: BreakMode }} patch
     */
    const choice = (title, checked, patch) =>
      menu.addItem((item) =>
        item
          .setTitle(title)
          .setChecked(checked)
          .onClick(() => void this.setFileMode(st.path, patch))
      );

    label('Darstellung dieser Datei');
    choice(`Automatisch (${STYLE_SHORT[st.auto]})`, !st.own.style, { style: undefined });
    for (const style of FILE_STYLES) choice(STYLE_LONG[style], st.own.style === style, { style });
    menu.addSeparator();
    label('Einfache Zeilenumbrüche');
    choice(`Automatisch (${BREAKS_SHORT[st.autoBreaks]})`, !st.own.breaks, { breaks: undefined });
    for (const breaks of BREAK_MODES) choice(BREAKS_LONG[breaks], st.own.breaks === breaks, { breaks });
    if (st.own.style || st.own.breaks) {
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle('Diese Datei auf Standard zurücksetzen')
          .setIcon('rotate-ccw')
          .onClick(() => void this.setFileMode(st.path, { style: undefined, breaks: undefined }))
      );
    }

    if (evt) {
      menu.showAtMouseEvent(evt);
      return;
    }
    const anchor = this.viewActions.get(view);
    const box = (anchor && anchor.isConnected ? anchor : view.containerEl).getBoundingClientRect();
    const pos = anchor && anchor.isConnected ? { x: box.left, y: box.bottom } : { x: box.left + box.width / 2, y: box.top + 48 };
    menu.showAtPosition(pos, view.containerEl.ownerDocument);
  }

  /** Augen-Symbol oben rechts in jeder Markdown-Ansicht. */
  refreshViewActions() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || this.viewActions.has(view)) return;
      const btn = view.addAction('eye', 'Darstellung dieser Datei (Claude Markdown Viewer)', (evt) => this.openModeMenu(view, evt));
      btn.addClass('cmv-view-action');
      this.viewActions.set(view, btn);
    });
  }

  /* ---------- Abschnitte: <details>, \( \[, Zeilenumbrüche ---------- */

  /**
   * @param {string} text
   * @param {string} docId
   * @param {string} sourcePath
   */
  analyze(text, docId, sourcePath) {
    const cached = this.analysisByDoc.get(docId);
    if (cached && cached.text === text) return cached;
    const lines = splitLines(text);
    const mask = computeProtectedMask(lines);
    const regions = findDetailsRegions(lines, mask);
    const isDocs = isDocsExport(text, sourcePath, parseFolderList(this.settings.docsFolders));
    const footnotes = collectFootnotes(lines, mask);
    const analysis = { text, lines, regions, isDocs, footnotes };
    if (this.analysisByDoc.size > 50) this.analysisByDoc.clear();
    this.analysisByDoc.set(docId, analysis);
    if (regions.length) this.pathsWithRegions.add(sourcePath);
    if (sourcePath) this.docsFlagByPath.set(sourcePath, isDocs);
    return analysis;
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
    const s = this.settings;
    const text = info.text;
    const mayHaveDetails = s.renderDetails && /<details/i.test(text);
    const mayHaveDelims = text.includes('\\(') || text.includes('\\[');
    const multiLine = info.lineEnd > info.lineStart;
    if (!mayHaveDetails && !mayHaveDelims && !multiLine) return;

    try {
      const a = this.analyze(text, ctx.docId, ctx.sourcePath);
      const style = resolveStyle(s, ctx.sourcePath, a.isDocs);
      const opts = {
        details: mayHaveDetails && a.regions.length > 0,
        delims: mayHaveDelims && style === 'chat',
        breaks: this.breakTransformFor(ctx.sourcePath, style),
      };
      if (!opts.details && !opts.delims && !opts.breaks) return;
      const res = buildSectionMarkdown(a.lines, info.lineStart, info.lineEnd, a.regions, opts);
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

  /** @param {HTMLElement} el */
  processDom(el) {
    const s = this.settings;
    try {
      if (s.embedPlaceholders) decorateEmbedPlaceholders(el);
      if (s.scrollableTables) wrapTables(el);
      if (s.linkifyWww) linkifyWww(el);
    } catch (err) {
      console.error(LOG_PREFIX, 'Fehler bei der Nachbearbeitung', err);
    }
  }

  /* ---------- Claude-Docs-Erkennung ---------- */

  /**
   * @param {HTMLElement} el
   * @param {import('obsidian').MarkdownPostProcessorContext} ctx
   * @returns {Promise<boolean>}
   */
  async isDocsContext(el, ctx) {
    const folders = parseFolderList(this.settings.docsFolders);
    const path = ctx.sourcePath || '';
    if (path && folders.some((f) => path === f || path.startsWith(f + '/'))) return true;
    /** @type {import('obsidian').MarkdownSectionInformation | null} */
    let info = null;
    try {
      info = ctx.getSectionInfo(el);
    } catch (_e) {
      info = null;
    }
    if (info && info.lineStart >= 0) {
      const flag = isDocsExport(info.text, path, folders);
      if (path) this.docsFlagByPath.set(path, flag);
      return flag;
    }
    const cached = this.docsFlagByPath.get(path);
    if (cached !== undefined) return cached;
    const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
    if (file instanceof TFile) {
      try {
        const text = await this.app.vault.cachedRead(file);
        const flag = isDocsExport(text, path, folders);
        this.docsFlagByPath.set(path, flag);
        return flag;
      } catch (_e) {
        return false;
      }
    }
    return false;
  }

  /* ---------- Code als Code zeigen ---------- */

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
   * Block mit zwei Ansichten (z. B. Formel und Code). Ein Knopf oben rechts
   * wechselt, ein zweiter kopiert den Quelltext. Nichts davon ändert die Datei.
   * @param {HTMLElement} el
   * @param {{ views: [SwitchView, SwitchView], initial: string, fallback: string, copyLabel: string, copy: () => string }} spec
   */
  async renderSwitchBlock(el, spec) {
    el.addClass('cmv-block', 'cmv-switch');
    /** @type {Map<string, { pane: HTMLElement, state: Promise<boolean> | null }>} */
    const panes = new Map();
    for (const v of spec.views) {
      panes.set(v.id, { pane: el.createDiv({ cls: 'cmv-pane cmv-is-hidden', attr: { 'data-view': v.id } }), state: null });
    }
    /** @type {SwitchView} */
    let current = spec.views[0];
    /** @type {HTMLElement | null} */
    let toggleBtn = null;

    /** @param {SwitchView} v */
    const ensure = (v) => {
      const p = /** @type {{ pane: HTMLElement, state: Promise<boolean> | null }} */ (panes.get(v.id));
      if (!p.state) {
        p.state = v.render(p.pane).catch((err) => {
          console.error(LOG_PREFIX, 'Ansicht konnte nicht erstellt werden', err);
          return false;
        });
      }
      return p.state;
    };
    /** @param {string} id */
    const show = (id) => {
      current = spec.views.find((v) => v.id === id) || spec.views[0];
      const other = spec.views.find((v) => v !== current) || spec.views[1];
      for (const [pid, p] of panes) p.pane.toggleClass('cmv-is-hidden', pid !== current.id);
      el.setAttr('data-cmv-view', current.id);
      if (toggleBtn) setButtonFace(toggleBtn, other.icon, other.label);
      return ensure(current);
    };

    const bar = addToolbar(el, [
      {
        icon: 'repeat',
        label: 'Ansicht wechseln',
        onClick: () => {
          const other = spec.views.find((v) => v !== current) || spec.views[1];
          void show(other.id);
        },
      },
      { icon: 'copy', label: spec.copyLabel, onClick: () => void copyText(spec.copy()) },
    ]);
    toggleBtn = /** @type {HTMLElement | null} */ (bar.querySelector('.cmv-toolbar-btn'));

    const ok = await show(spec.initial);
    if (!ok && spec.fallback !== spec.initial) await show(spec.fallback);
  }

  /* ---------- ```latex und ```math ---------- */

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
      pane.createDiv({ cls: 'cmv-note', text: 'Formel-Engine nicht verfügbar. Den Quelltext zeigt der Umschalter oben rechts.' });
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
        pane.createDiv({ cls: 'cmv-note', text: 'Formel konnte nicht gesetzt werden. Den Quelltext zeigt der Umschalter oben rechts.' });
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
   * Claude Docs: ```latex als Formel. Claude-Chat/Code und Norm: als Code.
   * ```math ist überall Formel (so zeigt es GitHub).
   * @param {string} source
   * @param {HTMLElement} el
   * @param {import('obsidian').MarkdownPostProcessorContext} ctx
   * @param {string} lang
   */
  async renderTexBlock(source, el, ctx, lang) {
    el.addClass('cmv-tex');
    const tex = stripTexDelimiters(source);
    if (!tex || looksLikeLatexDocument(source)) {
      el.addClass('cmv-block');
      await this.renderPlainCode(el, source, 'latex');
      return;
    }
    const style = await this.styleForContext(el, ctx);
    const formulaFirst = lang === 'math' || style === 'docs';
    await this.renderSwitchBlock(el, {
      views: [
        { id: 'formula', icon: 'sigma', label: 'Als Formel zeigen', render: (pane) => this.renderFormulaInto(pane, tex) },
        {
          id: 'code',
          icon: 'code',
          label: 'Als Code zeigen',
          render: async (pane) => {
            await this.renderPlainCode(pane, source, 'latex', { copyButton: false });
            return true;
          },
        },
      ],
      initial: formulaFirst ? 'formula' : 'code',
      fallback: 'code',
      copyLabel: 'TeX kopieren',
      copy: () => source.trim(),
    });
  }

  /* ---------- ```csv und ```tsv ---------- */

  /**
   * Claude Docs: Tabelle. Claude-Chat/Code und Norm: Text.
   * @param {string} source
   * @param {HTMLElement} el
   * @param {import('obsidian').MarkdownPostProcessorContext} ctx
   * @param {string} lang
   */
  async renderCsvBlock(source, el, ctx, lang) {
    el.addClass('cmv-csv');
    const codeLang = lang === 'tsv' ? 'tsv' : 'csv';
    const rows = parseCsv(source, lang === 'tsv' ? '\t' : detectDelimiter(source));
    if (rows.length === 0) {
      el.addClass('cmv-block');
      await this.renderPlainCode(el, source, codeLang);
      return;
    }
    const style = await this.styleForContext(el, ctx);
    await this.renderSwitchBlock(el, {
      views: [
        {
          id: 'grid',
          icon: 'table',
          label: 'Als Tabelle zeigen',
          render: async (pane) => {
            renderCsvTable(pane, rows);
            return true;
          },
        },
        {
          id: 'text',
          icon: 'code',
          label: 'Als Text zeigen',
          render: async (pane) => {
            await this.renderPlainCode(pane, source, codeLang, { copyButton: false });
            return true;
          },
        },
      ],
      initial: style === 'docs' ? 'grid' : 'text',
      fallback: 'text',
      copyLabel: lang === 'tsv' ? 'TSV kopieren' : 'CSV kopieren',
      copy: () => source,
    });
  }

  /* ---------- ```markdown und ```md ---------- */

  /**
   * Claude Docs: gerendertes Beispiel. Claude-Chat/Code und Norm: Quelltext.
   * @param {string} source
   * @param {HTMLElement} el
   * @param {import('obsidian').MarkdownPostProcessorContext} ctx
   */
  async renderMarkdownBlock(source, el, ctx) {
    el.addClass('cmv-mdblock');
    const path = ctx.sourcePath || '';
    const style = await this.styleForContext(el, ctx);
    const startWithPreview = style === 'docs';

    const header = el.createDiv({ cls: 'cmv-mdblock-header' });
    header.createSpan({ cls: 'cmv-mdblock-label', text: 'Markdown' });
    const tabs = header.createDiv({ cls: 'cmv-tabs', attr: { role: 'tablist' } });
    const tabPreview = tabs.createEl('button', { cls: 'cmv-tab', text: 'Vorschau', attr: { type: 'button', role: 'tab' } });
    const tabSource = tabs.createEl('button', { cls: 'cmv-tab', text: 'Quelltext', attr: { type: 'button', role: 'tab' } });
    const copyBtn = header.createEl('button', { cls: 'cmv-toolbar-btn', attr: { type: 'button' } });
    setButtonFace(copyBtn, 'copy', 'Markdown kopieren');

    const body = el.createDiv({ cls: 'cmv-mdblock-body' });
    const previewEl = body.createDiv({ cls: 'cmv-mdblock-preview' });
    const sourceEl = body.createDiv({ cls: 'cmv-mdblock-source' });
    const child = new MarkdownRenderChild(el);
    ctx.addChild(child);
    let previewDone = false;
    let sourceDone = false;

    /** @param {boolean} preview */
    const show = async (preview) => {
      tabPreview.toggleClass('is-active', preview);
      tabSource.toggleClass('is-active', !preview);
      tabPreview.setAttr('aria-selected', String(preview));
      tabSource.setAttr('aria-selected', String(!preview));
      previewEl.toggleClass('cmv-is-hidden', !preview);
      sourceEl.toggleClass('cmv-is-hidden', preview);
      if (preview && !previewDone) {
        previewDone = true;
        const md = transformMarkdown(source, {
          details: this.settings.renderDetails,
          delims: style === 'chat',
          breaks: this.breakTransformFor(path, style),
        });
        try {
          await MarkdownRenderer.render(this.app, md, previewEl, path, child);
        } catch (err) {
          console.error(LOG_PREFIX, 'Markdown-Vorschau fehlgeschlagen', err);
          previewEl.setText('Vorschau nicht möglich.');
        }
      }
      if (!preview && !sourceDone) {
        sourceDone = true;
        await this.renderPlainCode(sourceEl, source, 'markdown', { copyButton: false });
      }
    };
    /** @param {MouseEvent} evt @param {boolean} preview */
    const onTab = (evt, preview) => {
      evt.preventDefault();
      evt.stopPropagation();
      void show(preview);
    };
    tabPreview.addEventListener('click', (evt) => onTab(evt, true));
    tabSource.addEventListener('click', (evt) => onTab(evt, false));
    copyBtn.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      void copyText(source);
    });
    await show(startWithPreview);
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
      if (this.settings.githubAnchors && href.includes('#') && this.tryResolveAnchor(evt, a, href)) return;
      if (this.settings.blockUnresolvedLinks && a.classList.contains('is-unresolved')) {
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
      const target = resolveAnchor(buildHeadingIndex(view.data || view.getViewData()), anchor);
      if (!target || target.exact) return false;
      this.stopEvent(evt);
      this.scrollToLine(view, target.line, target.heading ? target.heading.raw : null);
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

    /**
     * @param {keyof ViewerSettings} key
     * @param {string} name
     * @param {string} desc
     */
    const toggle = (key, name, desc) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(Boolean(plugin.settings[key])).onChange(async (value) => {
            /** @type {any} */ (plugin.settings)[key] = value;
            await plugin.saveSettings();
          })
        );
    };

    new Setting(containerEl).setName('Darstellung: wie Claude oder nach Norm').setHeading();
    new Setting(containerEl)
      .setName('Standard-Darstellung')
      .setDesc(
        'Wie Claude: Docs-Exporte wie in Claude Docs (```latex als Formel, ```csv als Tabelle, ```markdown als gerendertes Beispiel), alle anderen Dateien wie im Claude-Chat (\\(…\\) und \\[…\\] als Formel). Norm: wie auf GitHub, diese Blöcke als Code, \\( und \\[ als Text. Einzelne Dateien stellst du über das Augen-Symbol oben rechts um, einzelne Blöcke über ihren Umschalter.'
      )
      .addDropdown((d) =>
        d
          .addOption('claude', 'Wie Claude (automatisch)')
          .addOption('norm', 'Norm (wie GitHub)')
          .setValue(plugin.settings.renderMode)
          .onChange(async (value) => {
            plugin.settings.renderMode = value === 'norm' ? 'norm' : 'claude';
            await plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName('Einfache Zeilenumbrüche')
      .setDesc(
        'Ein einzelner Zeilenumbruch ohne Leerzeile ist nach der Norm nur ein Leerzeichen: die Zeilen bilden einen Absatz. Bei Claude beginnt dort eine neue Zeile. Automatisch: wie Claude getrennt, bei Norm zusammen. Die Obsidian-Einstellung „Strenge Zeilenumbrüche“ musst du dafür nicht ändern.'
      )
      .addDropdown((d) =>
        d
          .addOption('auto', 'Automatisch')
          .addOption('split', 'Immer getrennt')
          .addOption('join', 'Immer zusammen (Norm)')
          .setValue(plugin.settings.lineBreaks)
          .onChange(async (value) => {
            plugin.settings.lineBreaks = value === 'split' || value === 'join' ? value : 'auto';
            await plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName('Ordner mit Docs-Exporten')
      .setDesc(
        'Optional, kommagetrennt, z. B. „Claude/Docs“. Dateien darin gelten immer als Docs-Export. Ohne Angabe erkennt das Plugin Exporte an der Datumszeile unter dem Titel und an Diagramm-Platzhaltern.'
      )
      .addText((t) =>
        t
          .setPlaceholder('Claude/Docs')
          .setValue(plugin.settings.docsFolders)
          .onChange(async (value) => {
            plugin.settings.docsFolders = value;
            await plugin.saveSettings();
          })
      );
    const count = Object.keys(plugin.settings.fileModes).length;
    new Setting(containerEl)
      .setName('Dateien mit eigener Darstellung')
      .setDesc(
        count === 0
          ? 'Keine. Gespeichert wird in den Plugin-Daten, nicht in den Dateien.'
          : `${count} ${count === 1 ? 'Datei' : 'Dateien'}. Gespeichert in den Plugin-Daten, nicht in den Dateien.`
      )
      .addButton((b) =>
        b
          .setButtonText('Alle zurücksetzen')
          .setDisabled(count === 0)
          .onClick(async () => {
            plugin.settings.fileModes = {};
            await plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl).setName('Nur ansehen, nie ändern').setHeading();
    toggle(
      'lockReadingView',
      'Immer Leseansicht',
      'Markdown-Dateien öffnen in der Leseansicht. Ein Wechsel in den Bearbeitungsmodus wird sofort zurückgenommen. Das Plugin selbst hat keine Bearbeitungsfunktionen, auch nicht für Tabellen.'
    );
    toggle('readOnlyCheckboxes', 'Checkboxen nicht anklickbar', 'Ein Klick auf eine Aufgaben-Checkbox würde sonst die Datei ändern.');
    toggle(
      'blockUnresolvedLinks',
      'Keine Notizen durch Link-Klick anlegen',
      'Obsidian legt beim Klick auf einen Link zu einer fehlenden Datei eine neue Notiz an. Stattdessen erscheint ein Hinweis.'
    );

    new Setting(containerEl).setName('Zusätzlich, in jeder Darstellung').setHeading();
    toggle('renderDetails', '<details> ausklappbar mit Markdown-Inhalt', 'Auch mit Leerzeilen, Code, Tabellen und Verschachtelung.');
    toggle('githubAnchors', 'GitHub-Ankerlinks auflösen', 'Links wie [Abschnitt](#mein-abschnitt) springen zur passenden Überschrift.');
    toggle('embedPlaceholders', 'Diagramm-Platzhalter hervorheben', 'Docs-Exporte enthalten statt Charts nur „[embedded content: …]“.');
    toggle('scrollableTables', 'Breite Tabellen scrollbar', 'Statt über den Rand zu laufen.');
    toggle('githubAlertColors', 'GitHub-Farben für Hinweisboxen', 'IMPORTANT violett, CAUTION rot statt der Obsidian-Standardfarben.');
    toggle('linkifyWww', 'www.-Adressen verlinken', 'Wie GitHub bei Adressen ohne https://.');
  }
}

/* Nur für Tests: reine Funktionen. Obsidian ignoriert diese Eigenschaft. */
/** @type {any} */ (ClaudeMarkdownViewer).__test = {
  splitLines,
  frontmatterEnd,
  computeFenceMask,
  findInlineCodeRanges,
  convertMathDelimiters,
  convertDetailsInText,
  detailsBlockToCallout,
  findDetailsRegions,
  computeProtectedMask,
  buildSectionMarkdown,
  transformMarkdown,
  convertSoftBreaks,
  computeBreakProtection,
  splitQuote,
  sanitizeFileModes,
  autoStyle,
  resolveStyle,
  autoLineBreaks,
  resolveLineBreaks,
  breakTransform,
  moveFileModes,
  AUTO_BREAKS,
  collectFootnotes,
  githubSlug,
  headingPlainText,
  buildHeadingIndex,
  makeHeadingIndex,
  resolveAnchor,
  linkSafeHeading,
  isDocsExport,
  parseFolderList,
  looksLikeLatexDocument,
  stripTexDelimiters,
  splitTexChunks,
  normalizeTexChunk,
  detectDelimiter,
  parseCsv,
  numericColumns,
  decorateEmbedPlaceholders,
  wrapTables,
  linkifyWww,
  decorateFootnoteRefs,
  DEFAULT_SETTINGS,
};

module.exports = ClaudeMarkdownViewer;
/** @type {any} */ (module.exports).default = ClaudeMarkdownViewer;
