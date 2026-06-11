const ITEM_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.*\S)\s*$/;
const KEY_RE = /^\s+([a-zA-Z][a-zA-Z-]*):\s+(.*\S)\s*$/;
const HEADING_RE = /^#{1,6}\s/;
const FENCE_RE = /^\s*(```|~~~)/;

export function parseEndstate(md) {
  const lines = md.split(/\r?\n/);
  const criteria = [];
  const errors = [];
  const goalLines = [];
  let current = null;
  let sawCriterion = false;
  let inComment = false;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (line.includes('<!--')) {
      if (!line.includes('-->')) inComment = true;
      continue;
    }
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      current = null;
      continue;
    }
    if (inFence) continue;

    const item = line.match(ITEM_RE);
    if (item) {
      current = { text: item[2], line: i + 1 };
      criteria.push(current);
      sawCriterion = true;
      continue;
    }

    if (current) {
      const kv = line.match(KEY_RE);
      if (kv) {
        const key = kv[1].toLowerCase();
        const val = kv[2];
        if (key === 'verify') current.verify = val;
        else if (key === 'judge') current.judge = val;
        else if (key === 'timeout') {
          const n = Number(val);
          if (!Number.isFinite(n) || n <= 0) errors.push(`line ${i + 1}: invalid timeout "${val}"`);
          else current.timeoutSec = n;
        } else if (key === 'fast') current.fast = /^(true|yes|1)$/i.test(val);
        else if (key === 'context') current.context = val.split(',').map(s => s.trim()).filter(Boolean);
        else errors.push(`line ${i + 1}: unknown key "${key}"`);
        continue;
      }
      current = null;
    }

    if (!sawCriterion && line.trim() !== '' && !HEADING_RE.test(line) && !line.startsWith('>')) {
      goalLines.push(line);
    }
  }

  for (const c of criteria) {
    if (!c.verify && !c.judge) errors.push(`line ${c.line}: criterion "${c.text}" has neither verify: nor judge:`);
    if (c.verify && c.judge) errors.push(`line ${c.line}: criterion "${c.text}" has both verify: and judge: — pick one`);
    if (c.judge && (!c.context || c.context.length === 0)) errors.push(`line ${c.line}: judge criterion "${c.text}" requires context: <files>`);
  }

  return { goal: goalLines.join('\n').trim(), criteria, errors };
}
