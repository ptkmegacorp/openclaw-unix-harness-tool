export function parseChain(input) {
  const segments = [];
  const ops = [];
  let buf = '';
  let i = 0;
  let quote = null;
  while (i < input.length) {
    const ch = input[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        buf += ch + input[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      buf += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      i++;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      pushSegment(buf, segments);
      ops.push(two);
      buf = '';
      i += 2;
      continue;
    }
    if (ch === ';') {
      pushSegment(buf, segments);
      ops.push(';');
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (quote) throw new Error('Unterminated quote in command');
  pushSegment(buf, segments);
  if (segments.length === 0) return { segments: [], ops: [] };
  if (ops.length !== segments.length - 1) throw new Error('Malformed command chain');
  return { segments, ops };
}

function pushSegment(raw, segments) {
  const s = raw.trim();
  if (s.length > 0) segments.push(s);
}
