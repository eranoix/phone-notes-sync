const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/(?:<\/(?:div|p|h[1-6]|li|tr|blockquote|pre|ul|ol)>\s*)+/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(withBreaks)
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim();
}

export function titleFromHtml(html: string): string | null {
  const first = htmlToText(html).split('\n').find((line) => line.length > 0);
  return first ? first.slice(0, 200) : null;
}

export function excerpt(text: string, title: string, max = 200): string {
  const lines = text.split('\n').map((l) => l.replace(/^- /, '').trim()).filter(Boolean);
  if (lines[0] === title.trim()) lines.shift();
  const joined = lines.join(' · ');
  return joined.length > max ? joined.slice(0, max - 1).trimEnd() + '…' : joined;
}
