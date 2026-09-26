const clean = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const stop = new Set(['什么', '哪些', '怎么', '如何', '意思', '解释', '一下', '请问', '告诉', '我', '的', '了', '是', '有什么', '说说']);

export function queryTerms(query, maximum = 16) {
  const words = [...segmenter.segment(String(query || '').normalize('NFKC').toLowerCase())]
    .filter(s => s.isWordLike && s.segment.length >= 2 && !stop.has(s.segment)).map(s => s.segment);
  return [...new Set(words)].slice(0, maximum);
}

export function indexedText(text) {
  const s = clean(text);
  const pairs = Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2));
  return [...new Set([...queryTerms(text, Infinity), ...pairs])].join(' ');
}

// Return complete sentences/lines around the actual hit, with omission explicitly marked.
export function relevantExcerpt(text, query, maximum = 2200) {
  text = String(text || '');
  if (text.length <= maximum) return { text, truncated: false };
  const terms = queryTerms(query);
  const blocks = [...text.matchAll(/[^\n。！？]+[。！？]?|\n/g)].map(m => ({ text: m[0], start: m.index }));
  const ranked = blocks.map((b, index) => ({ index, score: terms.reduce((n, term) => n + Number(clean(b.text).includes(term)), 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const target = ranked[0]?.index ?? 0;
  if (blocks[target]?.text.length > maximum - 100) return { text: '【命中段落过长，请打开知识点详情或原页查看完整内容。】', truncated: true };
  const selected = new Set(); let used = 0;
  for (const index of [target, target - 1, target + 1, target - 2, target + 2]) {
    const b = blocks[index];
    if (b && used + b.text.length <= maximum - 100) { selected.add(index); used += b.text.length; }
  }
  // A very long unbroken sentence must not be silently sliced into a factual assertion.
  const excerpt = [...selected].sort((a, b) => a - b).map(i => blocks[i].text).join('\n');
  return { text: excerpt ? `【相关原文摘录，前后有省略】\n${excerpt}\n【内容未完整取得，请回查原页。】` : '【命中段落过长，请打开知识点详情或原页查看完整内容。】', truncated: true };
}

export function rankItems(items, query) {
  const q = clean(query), terms = queryTerms(query);
  if (q.length < 2) return [];
  return items.map(item => {
    const title = clean(item.title), body = clean(item.text);
    const aliases = (item.aliases || []).map(clean);
    const titleHits = terms.filter(t => title.includes(t) || aliases.some(a => a.includes(t))).length;
    const bodyHits = terms.filter(t => body.includes(t)).length;
    const score = title === q || aliases.includes(q) ? 1000 : q.includes(title) && title.length >= 2 ? 800 :
      title.includes(q) ? 700 : body.includes(q) ? 600 :
      terms.length && (titleHits || bodyHits >= Math.max(1, Math.ceil(terms.length * .6))) ? titleHits * 60 + bodyHits * 10 : 0;
    return { item, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.item.id?.localeCompare(b.item.id || '') || 0);
}
