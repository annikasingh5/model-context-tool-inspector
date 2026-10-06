/**
 * Minimal, dependency-free Markdown renderer for chat bubbles.
 *
 * Builds DOM nodes directly (never innerHTML), so model output can't inject
 * markup. Supports headings, paragraphs, bold/italic/strikethrough, inline
 * code, fenced code blocks, links, block quotes, ordered/unordered (nested)
 * lists, pipe tables and horizontal rules.
 */

const FENCE = /^\s*```\s*([\w+-]*)/;
const FENCE_END = /^\s*```\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

// Capture groups: 1 escape, 2 code, 3/4 bold, 5 strike, 6/7 italic, 8+9 link, 10 bare URL.
const INLINE =
  /\\([\\`*_{}[\]()#+\-.!~|>])|`([^`\n]+)`|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([\s\S]*?[^\s*])\*|(?<!\w)_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"])/g;

const el = (tag, parent) => {
  const node = document.createElement(tag);
  parent?.appendChild(node);
  return node;
};

function safeUrl(url) {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function makeLink(href, parent) {
  const a = el('a', parent);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function inlineInto(parent, text) {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    last = m.index + m[0].length;

    if (m[1] !== undefined) {
      parent.append(m[1]);
    } else if (m[2] !== undefined) {
      el('code', parent).textContent = m[2];
    } else if (m[3] !== undefined || m[4] !== undefined) {
      inlineInto(el('strong', parent), m[3] ?? m[4]);
    } else if (m[5] !== undefined) {
      inlineInto(el('del', parent), m[5]);
    } else if (m[6] !== undefined || m[7] !== undefined) {
      inlineInto(el('em', parent), m[6] ?? m[7]);
    } else if (m[8] !== undefined) {
      if (safeUrl(m[9])) inlineInto(makeLink(m[9], parent), m[8]);
      else parent.append(m[0]);
    } else if (m[10] !== undefined) {
      makeLink(m[10], parent).textContent = m[10];
    }
  }
  if (last < text.length) parent.append(text.slice(last));
}

const indentOf = (s) => s.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function isTableStart(lines, i) {
  return (
    i + 1 < lines.length &&
    lines[i].includes('|') &&
    lines[i + 1].includes('|') &&
    TABLE_SEP.test(lines[i + 1])
  );
}

function startsBlock(lines, i) {
  const line = lines[i];
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    LIST.test(line) ||
    isTableStart(lines, i)
  );
}

function parseTable(lines, i, parent) {
  const header = splitRow(lines[i]);
  const aligns = splitRow(lines[i + 1]).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
  });
  const wrap = el('div', parent);
  wrap.className = 'md-table-wrap';
  const table = el('table', wrap);
  const headRow = el('tr', el('thead', table));
  header.forEach((text, c) => {
    const th = el('th', headRow);
    if (aligns[c]) th.style.textAlign = aligns[c];
    inlineInto(th, text);
  });
  const tbody = el('tbody', table);
  i += 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    const row = el('tr', tbody);
    splitRow(lines[i]).forEach((text, c) => {
      const td = el('td', row);
      if (aligns[c]) td.style.textAlign = aligns[c];
      inlineInto(td, text);
    });
    i++;
  }
  return i;
}

function parseList(lines, i, parent) {
  const first = LIST.exec(lines[i]);
  const base = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const list = el(ordered ? 'ol' : 'ul', parent);
  if (ordered && parseInt(first[2], 10) !== 1) list.start = parseInt(first[2], 10);

  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m || indentOf(m[1]) !== base || /\d/.test(m[2]) !== ordered) break;
    const li = el('li', list);
    inlineInto(li, m[3]);
    i++;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        // A blank line only continues the item if a list item follows.
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        const next = j < lines.length ? LIST.exec(lines[j]) : null;
        if (!next || indentOf(next[1]) < base) break;
        i = j;
        continue;
      }
      const lm = LIST.exec(line);
      if (lm) {
        if (indentOf(lm[1]) >= base + 2) {
          i = parseList(lines, i, li);
          continue;
        }
        break;
      }
      if (indentOf(line) > base && !startsBlock(lines, i)) {
        li.appendChild(document.createElement('br'));
        inlineInto(li, line.trim());
        i++;
        continue;
      }
      break;
    }
  }
  return i;
}

function parseBlocks(lines, parent) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !FENCE_END.test(lines[i])) code.push(lines[i++]);
      i++; // Closing fence (or end of input).
      const codeEl = el('code', el('pre', parent));
      if (fence[1]) codeEl.className = `language-${fence[1]}`;
      codeEl.textContent = code.join('\n');
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      inlineInto(el(`h${heading[1].length}`, parent), heading[2]);
      i++;
      continue;
    }

    if (HR.test(line)) {
      el('hr', parent);
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      parseBlocks(quoted, el('blockquote', parent));
      continue;
    }

    if (isTableStart(lines, i)) {
      i = parseTable(lines, i, parent);
      continue;
    }

    if (LIST.test(line)) {
      i = parseList(lines, i, parent);
      continue;
    }

    // Paragraph: soft line breaks are kept, as people expect in chat.
    const p = el('p', parent);
    inlineInto(p, line.trim());
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
      p.appendChild(document.createElement('br'));
      inlineInto(p, lines[i].trim());
      i++;
    }
  }
}

export function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  parseBlocks(String(source ?? '').replace(/\r\n?/g, '\n').split('\n'), fragment);
  return fragment;
}
