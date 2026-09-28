import { createHash } from 'node:crypto';
import { savedItems } from './library.js';
import { rankItems, queryTerms } from './text-search.js';
import { ArkKnowledgeSearch } from './search.js';

const fault = code => Object.assign(new Error(code), { code });
const relationTypes = new Set(['supports', 'contradicts', 'related']);

// Quote a contiguous, complete source passage. Long unsplittable passages are not silently cut.
function quoteFor(text, query, maximum = 900) {
  if (text.length <= maximum) return text;
  const terms = queryTerms(query), blocks = [...text.matchAll(/[^\n。！？]+[。！？]?/g)];
  const ranked = blocks.map((block, index) => ({ index, score: terms.reduce((n, term) => n + Number(block[0].includes(term)), 0) }))
    .filter(({ index, score }) => score > 0 && blocks[index][0].length <= maximum).sort((a, b) => b.score - a.score || a.index - b.index);
  if (!ranked.length) return null;
  const target = ranked[0].index;
  let start = blocks[target].index, end = start + blocks[target][0].length;
  if (target > 0 && end - blocks[target - 1].index <= maximum) start = blocks[target - 1].index;
  if (target + 1 < blocks.length && blocks[target + 1].index + blocks[target + 1][0].length - start <= maximum) end = blocks[target + 1].index + blocks[target + 1][0].length;
  return text.slice(start, end);
}

function candidatesFor(content, textbooks) {
  const candidates = new Map();
  for (const item of content.items) {
    const query = `${item.title}\n${item.text}`;
    let matches = rankItems(textbooks, item.title);
    if (!matches.length) matches = rankItems(textbooks, item.text);
    for (const { item: source } of matches.slice(0, 2)) {
      const quote = quoteFor(source.text, query);
      if (!quote || !source.text.includes(quote) || !Number.isInteger(source.sourceVersion) || source.sourceVersion < 1) continue;
      const candidateId = `T-${createHash('sha256').update(JSON.stringify([source.id, source.sourceVersion, quote])).digest('hex').slice(0, 24)}`;
      const candidate = candidates.get(candidateId);
      if (candidate) { candidate.itemIds.push(item.id); continue; }
      candidates.set(candidateId, { candidateId, itemIds: [item.id], sourceId: source.id, sourceDocumentId: source.sourceDocumentId,
        sourceVersion: source.sourceVersion, title: source.title, quote, quoteTruncated: quote !== source.text,
        pageAnchors: structuredClone(source.sourceAnchors || []), qualityIssues: structuredClone(source.qualityIssues || []) });
    }
  }
  return [...candidates.values()];
}

/** One combined web/textbook verification stage; local retrieval never calls a model. */
export class SourcePhotoVerifier {
  constructor({ repository, search = new ArkKnowledgeSearch() }) { Object.assign(this, { repository, search }); }

  async verify(content, { scope } = {}) {
    if (typeof scope?.key !== 'string' || !scope.key) throw fault('invalid_source_scope');
    if (!Array.isArray(content?.items) || !content.items.length || content.items.length > 200) throw fault('invalid_source_content');
    const textbooks = savedItems(await this.repository.read(), key => key === scope.key).filter(item => item.materialKind === 'textbook');
    const textbookStatus = textbooks.length ? 'available' : 'not_imported';
    const candidates = candidatesFor(content, textbooks);
    let result;
    try { result = await this.search.verify(content, { mode: 'source', textbookCandidates: candidates }); }
    catch (cause) { throw Object.assign(cause, { textbookStatus }); }
    const checks = content.items.map(item => {
      const check = (Array.isArray(result.checks) ? result.checks : []).find(check => check?.id === item.id);
      const seen = new Set();
      const textbookMatches = (Array.isArray(check?.textbookMatches) ? check.textbookMatches : []).flatMap(match => {
        const candidate = candidates.find(candidate => candidate.candidateId === match?.candidateId && candidate.itemIds.includes(item.id));
        if (!candidate || !relationTypes.has(match.relation) || seen.has(candidate.candidateId)) return [];
        seen.add(candidate.candidateId);
        // Never accept provider-supplied quotes, versions, page numbers or links.
        return [{ ...structuredClone(candidate), relation: match.relation, reason: typeof match.reason === 'string' ? match.reason : '' }];
      });
      const citations = (Array.isArray(check?.citations) ? check.citations : []).filter(url => typeof url === 'string' && /^https?:\/\//.test(url));
      const validText = typeof check?.text === 'string' && check.text.trim() && check.text.length <= 6000;
      const textbookEvidence = textbookMatches.some(match => match.relation === 'supports' || check?.status === 'corrected' && match.relation === 'contradicts');
      const verified = ['supported', 'corrected'].includes(check?.status) && validText && (citations.length > 0 || textbookEvidence);
      return { ...check, id: item.id, status: verified ? check.status : 'unresolved', text: validText ? check.text : item.text,
        reason: typeof check?.reason === 'string' ? check.reason : '未获得核验结果', citations, textbookMatches };
    });
    return { ...result, checks, textbookStatus, textbookCandidateCount: candidates.length,
      textbookMatches: checks.flatMap(check => check.textbookMatches.map(match => ({ itemId: check.id, ...match }))) };
  }
}
