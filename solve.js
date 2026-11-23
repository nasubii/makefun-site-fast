// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly the output tree
// makefun-site's build returns for the same input, byte for byte, in less CPU time.
// The semantics are makefun-site's own (front matter, Markdown subset, template dialect,
// slug rule, report); the machinery is written for speed: single-pass scanners instead of
// per-character work, bulk HTML escaping, and no intermediate token objects.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const isEscapeChar = (c) => c === '&' || c === '<' || c === '>' || c === '"' || c === "'";

/** `text` with & < > " and ' escaped; a text holding none of them is itself. */
function escapeHtml(text) {
  const n = text.length;
  let i = 0;
  while (i < n && !isEscapeChar(text[i])) i++;
  if (i === n) return text;
  let out = text.slice(0, i);
  while (i < n) {
    const e = ESCAPES[text[i]];
    if (e !== undefined) {
      out += e;
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && !isEscapeChar(text[j])) j++;
    out += text.slice(i, j);
    i = j;
  }
  return out;
}

const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters
 * other than a-z and 0-9 one "-", none at either end, at most SLUG_MAX characters (a "-"
 * left at the cut dropped), and "untitled" when nothing is left. Pure-ASCII text skips
 * the normalisation: NFKD is the identity there and no ASCII character is a mark.
 */
function slugify(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason
 * it is refused. `text` has "\n" line ends. A front-matter line is blank, a comment,
 * or "key: value" — a key of [a-z_]+, a colon, then nothing or one space and the
 * value. Lines are scanned in place (no split of the body), the close line is found
 * first, as the refusal order requires.
 */
function parseFrontMatter(text) {
  const lineEnd = (from) => {
    const nl = text.indexOf('\n', from);
    return nl === -1 ? text.length : nl;
  };
  if (text.slice(0, lineEnd(0)) !== '---') return { error: 'no front matter' };
  // The closing line, found before any line is judged.
  let closeStart = -1;
  let closeEnd = -1;
  let pos = lineEnd(0);
  if (pos < text.length) pos++;
  while (pos <= text.length) {
    const e = lineEnd(pos);
    if (text.slice(pos, e) === '---') {
      closeStart = pos;
      closeEnd = e;
      break;
    }
    if (e === text.length) break;
    pos = e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1;
  pos = lineEnd(0);
  if (pos < text.length) pos++;
  while (pos < closeStart) {
    const e = lineEnd(pos);
    const line = text.slice(pos, e);
    lineNo++;
    pos = e + 1;
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    let key = null;
    let raw = null;
    if (colon > 0) {
      let ok = true;
      for (let j = 0; j < colon; j++) {
        const c = line[j];
        if (!((c >= 'a' && c <= 'z') || c === '_')) {
          ok = false;
          break;
        }
      }
      if (ok) {
        if (colon === line.length - 1) {
          key = line.slice(0, colon);
          raw = '';
        } else if (line[colon + 1] === ' ') {
          key = line.slice(0, colon);
          raw = line.slice(colon + 2).replace(/[ \t]+$/, '');
        }
      }
    }
    if (key === null) return { error: `line ${lineNo} is not "key: value"` };
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;

const SPECIAL_RE = /[\\`*\[]/g;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain runs between the
 * special characters (\ ` * [) are escaped in bulk; the special cases are
 * makefun-site's own: code spans, strong, emphasis, links and backslash escapes.
 */
function inline(s, env) {
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    SPECIAL_RE.lastIndex = i;
    const sm = SPECIAL_RE.exec(s);
    const j = sm === null ? n : sm.index;
    if (j > i) {
      out += escapeHtml(s.slice(i, j));
      i = j;
      if (i >= n) break;
    }
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        const e = s[i + 1];
        out += e === '>' ? '&gt;' : e;
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, k), env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) {
        out += `<em>${inline(s.slice(i + 1, k), env)}</em>`;
        i = k + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', i + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !WS_RE.test(target)) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
      i = m + 1;
      continue;
    }
    out += '[';
    i++;
  }
  return out;
}

/** Whether `line` is blank: nothing but spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/**
 * A fence opening at `line`: its language, or null. The line is ``` then language
 * characters [A-Za-z0-9_+-]* then only spaces and tabs.
 */
function fenceLang(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length) {
    const c = line[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: ``` then only spaces and tabs. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/**
 * A heading at `line`: { depth, text } or null. One to six #, at least one space or
 * tab, then the text (never empty) with trailing spaces and tabs dropped.
 */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line[d] === '#') d++;
  if (d === 0 || d > 6) return null;
  if (d >= line.length || (line[d] !== ' ' && line[d] !== '\t')) return null;
  let s = d;
  while (s < line.length && (line[s] === ' ' || line[s] === '\t')) s++;
  let e = line.length;
  while (e > s && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  if (e === s) return null;
  return { depth: d, text: line.slice(s, e) };
}

/** Whether `line` is a thematic break: --- or *** then only spaces and tabs. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A bullet item at `line`: its text after "- " or "* ", or null. */
function bulletOf(line) {
  return line.length >= 2 && (line[0] === '-' || line[0] === '*') && line[1] === ' ' ? line.slice(2) : null;
}

/** An ordered item at `line`: { start, text } after "N. " (1-9 digits), or null. */
function orderedOf(line) {
  let d = 0;
  while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
  if (d === 0 || d > 9) return null;
  if (line[d] !== '.' || line[d + 1] !== ' ') return null;
  return { start: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

/** Whether `line` continues a list item: two or more spaces then a non-whitespace character. */
function isContinued(line) {
  let s = 0;
  while (s < line.length && line[s] === ' ') s++;
  return s >= 2 && s < line.length && !WS_RE.test(line[s]);
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line[s] === ' ' || line[s] === '\t')) s++;
  while (e > s && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its
 * table of contents (every level 2 and 3 heading: level, id and its inline HTML) and
 * its excerpt (the first paragraph's inline HTML, or ""). Blocks are lexed and
 * rendered in one pass, in makefun-site's order: fence, heading, break, quote,
 * list, paragraph.
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      let body = '';
      i++;
      while (i < lines.length && !isFenceClose(lines[i])) {
        body += `${escapeHtml(lines[i])}\n`;
        i++;
      }
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      html += `<pre><code${cls}>${body}</code></pre>\n`;
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const inner = inline(heading.text, env);
      html += `<h${heading.depth} id="${id}">${inner}</h${heading.depth}>\n`;
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: inner });
      i++;
      continue;
    }
    if (isHr(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      while (i < lines.length && lines[i][0] === '>') {
        let l = lines[i].slice(1);
        if (l[0] === ' ') l = l.slice(1);
        l = trimLine(l);
        if (l !== '') body.push(l);
        i++;
      }
      html += body.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(body.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      let cur = null;
      while (i < lines.length) {
        const l = lines[i];
        const item = isOrdered ? orderedOf(l) : bulletOf(l);
        if (item !== null) {
          cur = [trimLine(isOrdered ? item.text : item)];
          items.push(cur);
          i++;
        } else if (cur !== null && isContinued(l)) {
          cur.push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.start !== 1 ? `<ol start="${ordered.start}">` : `<${tag}>`;
      let block = `${open}\n`;
      for (const parts of items) block += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      html += `${block}</${tag}>\n`;
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const inner = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = inner;
    html += `<p>${inner}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) out += ', ';
      out += textOf(v[k]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` compiled to a JavaScript function (scope, ctx, depth, H, P) -> string,
 * where P is the template's table of lookup paths. Rendering a page is then plain
 * string building and property reads, with H's helpers carrying the scope, text
 * and truthiness rules above. Includes call the included template's own compiled
 * function through ctx.templates, at most INCLUDE_DEPTH deep.
 */
function compileTemplate(nodes) {
  const paths = [];
  let counter = 0;
  const pathIndex = (path) => {
    paths.push(path);
    return paths.length - 1;
  };
  const gen = (list, scopeVar) => {
    let code = '';
    for (const n of list) {
      switch (n.kind) {
        case 'text':
          code += `o+=${JSON.stringify(n.text)};`;
          break;
        case 'var':
          code += `o+=H.esc(H.txt(H.lk(${scopeVar},P[${pathIndex(n.path)}])));`;
          break;
        case 'raw':
          code += `o+=H.txt(H.lk(${scopeVar},P[${pathIndex(n.path)}]));`;
          break;
        case 'if': {
          code += `if(H.tr(H.lk(${scopeVar},P[${pathIndex(n.path)}]))!==${n.not}){${gen(n.then, scopeVar)}}`;
          if (n.else !== null) code += `else{${gen(n.else, scopeVar)}}`;
          break;
        }
        case 'for': {
          const id = counter++;
          const xs = `xs${id}`;
          const kk = `k${id}`;
          const inner = `s${id}`;
          code += `{const ${xs}=H.lk(${scopeVar},P[${pathIndex(n.path)}]);if(Array.isArray(${xs})){const ln${id}=${xs}.length;for(let ${kk}=0;${kk}<ln${id};${kk}++){const ${inner}={vars:{[${JSON.stringify(n.name)}]:${xs}[${kk}],loop:{index:${kk}+1,first:${kk}===0,last:${kk}===ln${id}-1,length:ln${id}}},parent:${scopeVar}};${gen(n.body, inner)}}}}`;
          break;
        }
        case 'include': {
          const id = counter++;
          code += `if(depth<${INCLUDE_DEPTH}){const t${id}=ctx.templates.get(${JSON.stringify(n.name)});if(t${id}!==undefined)o+=t${id}.f(${scopeVar},ctx,depth+1,H,t${id}.P);}`;
          break;
        }
      }
    }
    return code;
  };
  const body = gen(nodes, 'scope');
  const f = new Function('scope', 'ctx', 'depth', 'H', 'P', `let o='';${body}return o;`);
  return { f, P: paths };
}

const HELPERS = { lk: lookup, txt: textOf, esc: escapeHtml, tr: truthy };

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** Whether a code unit is whitespace to JavaScript's \s (the set \S runs break on). */
function isWsCode(c) {
  if (c <= 32) return c === 32 || (c >= 9 && c <= 13);
  return c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/** The words of a body: its runs of characters other than whitespace, counted in one pass. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWsCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text, exactly as makefun-site 1.0.0's build returns it. */
function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source
  // that is not .md is static.
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order,
  // ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const readingOf = (s) => s.reading ?? (s.reading = Math.max(1, Math.ceil(wordsOf(s.body) / 200)));
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: readingOf(s),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const t = templates.get(name);
    return t === undefined ? null : t.f({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, HELPERS, t.P);
  };
  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse,
  // sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
