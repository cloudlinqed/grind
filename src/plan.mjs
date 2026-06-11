const ITEM_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.*\S)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;

const FENCE_RE = /^\s*(```|~~~)/;

export function parsePlan(md) {
  const items = [];
  let heading = '';
  let inFence = false;
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = lines[i].match(HEADING_RE);
    if (h) {
      heading = h[2];
      continue;
    }
    const m = lines[i].match(ITEM_RE);
    if (m) items.push({ checked: m[1] !== ' ', text: m[2], heading, line: i + 1 });
  }
  return { items };
}

export function uncheckedItems(plan) {
  return plan.items.filter(i => !i.checked);
}
