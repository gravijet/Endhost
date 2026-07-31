// Minecraft's own text: the section-sign (§) formatting codes, rendered the way
// the game renders them. Real colours, real bold/italic — a MOTD shown here looks
// like it looks in the server list.

const COLORS: Record<string, string> = {
  '0': '#000000', '1': '#0000aa', '2': '#00aa00', '3': '#00aaaa',
  '4': '#aa0000', '5': '#aa00aa', '6': '#ffaa00', '7': '#aaaaaa',
  '8': '#555555', '9': '#5555ff', a: '#55ff55', b: '#55ffff',
  c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff',
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// Render a §-coded string to safe HTML spans. Shadow is applied by the caller's
// font; here we only carry colour and weight.
export function motdToHtml(input: string): string {
  let color = '#efeaf6';
  let bold = false, italic = false, underline = false, strike = false;
  let out = '';
  let open = false;

  const openSpan = () => {
    const deco = [underline && 'underline', strike && 'line-through'].filter(Boolean).join(' ');
    out += `<span style="color:${color};${bold ? 'font-weight:700;' : ''}${italic ? 'font-style:italic;' : ''}${deco ? `text-decoration:${deco};` : ''}">`;
    open = true;
  };
  const closeSpan = () => { if (open) { out += '</span>'; open = false; } };

  const tokens = input.split(/(§.)/);
  for (const tok of tokens) {
    if (tok.length === 2 && tok[0] === '§') {
      const code = tok[1].toLowerCase();
      closeSpan();
      if (COLORS[code]) { color = COLORS[code]; bold = italic = underline = strike = false; }
      else if (code === 'l') bold = true;
      else if (code === 'o') italic = true;
      else if (code === 'n') underline = true;
      else if (code === 'm') strike = true;
      else if (code === 'r') { color = '#efeaf6'; bold = italic = underline = strike = false; }
      continue;
    }
    if (!tok) continue;
    if (!open) openSpan();
    out += esc(tok);
  }
  closeSpan();
  return out;
}

export function fmtBytes(n: number): string {
  if (!n) return '0 MB';
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  return Math.round(mb) + ' MB';
}

export function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}
