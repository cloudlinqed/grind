import fs from 'node:fs';

// Read tail windows of increasing size rather than the whole file —
// transcripts of long sessions reach tens of MB.
const WINDOWS = [2 * 1024 * 1024, 16 * 1024 * 1024, 64 * 1024 * 1024];

export function lastAssistantText(transcriptPath) {
  let size;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    return null;
  }
  for (const w of WINDOWS) {
    const start = Math.max(0, size - w);
    let chunk;
    try {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const len = size - start;
        const buf = Buffer.alloc(len);
        // readSync may return short — an unfilled zero-padded buffer would corrupt
        // the trailing lines, silently swapping in an older assistant message
        let total = 0;
        while (total < len) {
          const n = fs.readSync(fd, buf, total, len - total, start + total);
          if (n === 0) break;
          total += n;
        }
        chunk = buf.toString('utf8', 0, total);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
    const lines = chunk.split('\n');
    if (start > 0) lines.shift(); // first line may be partial
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj?.type !== 'assistant') continue;
      const c = obj.message?.content;
      let text = null;
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        text = c.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
      }
      if (text && text.trim()) return text.trim();
    }
    if (start === 0) return null;
  }
  return null;
}
