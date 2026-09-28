import test from 'node:test';
import assert from 'node:assert/strict';
import { SourcePhotoModel, validateSourceContent } from '../src/knowledge/source-model.js';
import { savedItems } from '../src/knowledge/library.js';

const read = text => ({ pages: [{ image: 1, title: '笔记', text, annotations: [{ color: 'red', text: '原批注', parent: '段1' }], uncertain: [] }] });
const item = (id, text, lineStart, lineEnd = lineStart, image = 1) => ({ id, title: '原文段落', text, region: `图${image}`, uncertain: false, sourceRefs: [{ image, lineStart, lineEnd }] });
const content = items => ({ title: '笔记', transcription: '模型声称的另一份正文，不应被采纳', differences: [], queries: [], items });

test('source model retains independent OCR and asks for faithful paragraphs with first-read line references', async () => {
  const requests = [], images = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }];
  const model = new SourcePhotoModel({ complete: async request => { requests.push(request); return { modelId: 'test', finishReason: 'stop', content: JSON.stringify(requests.length < 3 ? read('第一行\n第二行') : content([item('S1', '第一行\n第二行', 1, 2)])) }; } });
  const first = await model.recognize(images, 1), second = await model.recognize(images, 2);
  const result = await model.align(first.data, second.data);
  assert.deepEqual(requests[0].messages[1].content, images); assert.deepEqual(requests[1].messages[1].content, images);
  assert.ok(requests.every(request => request.stream === true));
  assert.match(requests[2].messages[0].content, /不按知识主张改写/);
  assert.doesNotMatch(requests[2].messages[0].content, /最多40条/);
  const alignedInput = JSON.parse(requests[2].messages[1].content);
  assert.deepEqual(alignedInput.first.pages[0].lines, [{ line: 1, text: '第一行' }, { line: 2, text: '第二行' }]);
  assert.equal(result.data.transcription, '第一行\n第二行');
});

test('originalText is rebuilt from actual OCR1 and transcription from validated items', () => {
  const value = content([{ ...item('S1', '第一行\n第二行', 1, 2), originalText: '模型伪造的原文' }]);
  const result = validateSourceContent(value, [{ data: read('第一行\n第二行') }, { data: read('第一行\n第二行') }]);
  assert.equal(result.items[0].originalText, '第一行\n第二行'); assert.equal(result.transcription, result.items[0].text);
  assert.equal(result.sourceAnnotations.length, 2); assert.equal(result.sourceAnnotations[0].annotations[0].parent, '段1');
});

test('41 and 200 paragraphs are preserved, while 201 is an explicit error rather than a slice', () => {
  for (const count of [41, 200]) {
    const rows = Array.from({ length: count }, (_, index) => `原文第${index + 1}行`);
    const result = validateSourceContent(content(rows.map((text, index) => item(`S${index + 1}`, text, index + 1))), [read(rows.join('\n')), read(rows.join('\n'))]);
    assert.equal(result.items.length, count); assert.ok(result.transcription.includes(rows.at(-1)));
  }
  const rows = Array.from({ length: 201 }, (_, index) => item(`S${index}`, '原文', index + 1));
  assert.throws(() => validateSourceContent(content(rows), [read('原文'), read('原文')]), { code: 'invalid_source_content' });
});

test('blank lines keep their line numbers and all nonempty lines across pages must be covered', () => {
  const first = { pages: [...read('甲\n\n乙').pages, { image: 2, text: '丙' }] };
  const result = validateSourceContent(content([item('S1', '甲\n\n乙', 1, 3), item('S2', '丙', 1, 1, 2)]), [first, first]);
  assert.equal(result.items[0].originalText, '甲\n\n乙');
  assert.throws(() => validateSourceContent(content([item('S1', '甲', 1), item('S2', '丙', 1, 1, 2)]), [first, first]), { code: 'incomplete_source_coverage' });
});

test('duplicate, reversed, invalid and fabricated references are rejected', () => {
  const reads = [read('甲\n乙'), read('甲\n乙')];
  for (const items of [
    [item('S1', '甲', 1), item('S2', '甲乙', 1, 2)],
    [item('S1', '乙', 2), item('S2', '甲', 1)],
    [item('S1', '甲乙', 0, 2)],
    [item('S1', '甲乙', 1, 3)],
    [item('S1', '甲乙', 1, 2, 9)]
  ]) assert.throws(() => validateSourceContent(content(items), reads), { code: 'invalid_source_refs' });
});

test('OCR2 line count disagreement keeps both readings without inventing correspondence', () => {
  const result = validateSourceContent(content([item('S1', '甲乙【待辨认】', 1, 2)]), [read('甲\n乙'), read('甲乙')]);
  assert.equal(result.items[0].originalText, '甲\n乙'); assert.equal(result.items[0].uncertain, true);
  assert.ok(result.items[0].qualityIssues.some(issue => issue.includes('换行分歧')));
  assert.equal(result.items[0].secondReadText, undefined);
});

test('model summaries cannot replace canonical text agreed by both OCR reads', () => {
  const original = '第一句完整原文。第二句完整原文。';
  const result = validateSourceContent(content([item('S1', '摘要', 1)]), [read(original), read(original)]);
  assert.equal(result.items[0].originalText, original); assert.equal(result.items[0].text, original);
  assert.equal(result.items[0].mergedCandidate, '摘要'); assert.ok(result.items[0].qualityIssues.some(issue => issue.includes('篇幅差异')));
});

test('malformed reads, duplicate IDs and missing terminal completion are rejected', async () => {
  assert.throws(() => validateSourceContent(content([item('S1', '甲', 1)]), [read('甲'), { pages: [] }]), { code: 'invalid_source_reads' });
  assert.throws(() => validateSourceContent(content([item('S1', '甲', 1), item('S1', '乙', 2)]), [read('甲\n乙'), read('甲\n乙')]), { code: 'invalid_source_item' });
  const model = new SourcePhotoModel({ complete: async () => ({ content: JSON.stringify(content([item('S1', '甲', 1)])) }) });
  await assert.rejects(model.align(read('甲'), read('甲')), /model_output_incomplete/);
});

test('OCR page IDs must refer to actual images and returned page order is normalized', () => {
  const invalid = { pages: [{ image: 9, text: '甲' }] };
  assert.throws(() => validateSourceContent(content([item('S1', '甲', 1, 1, 9)]), [invalid, invalid]), { code: 'invalid_source_reads' });
  const unordered = { pages: [{ image: 2, text: '乙' }, { image: 1, text: '甲' }] };
  const result = validateSourceContent(content([item('S1', '甲', 1), item('S2', '乙', 1, 1, 2)]), [unordered, unordered]);
  assert.equal(result.transcription, '甲\n\n乙');
});

test('matching OCR text wins over an encyclopedia expansion produced by the alignment model', () => {
  const original = '课程标准是教材编写的依据。';
  const candidate = `${original}此外课程标准还是衡量一切教育活动的唯一标准，包含详细百科解释。`;
  const result = validateSourceContent(content([item('S1', candidate, 1)]), [read(original), read(original)]);
  assert.equal(result.items[0].text, original); assert.equal(result.transcription, original);
  assert.equal(result.items[0].mergedCandidate, candidate); assert.equal(result.items[0].canonicalBasis, 'ocr_agreement');
});

test('a hard guess cannot resolve disagreeing OCR characters in the canonical manuscript', () => {
  const result = validateSourceContent(content([item('S1', '不陵节而施之谓孙。', 1)]), [read('不陵节而施之谓孙。'), read('不陵节而施之谓顺。')]);
  assert.equal(result.items[0].text, '不陵节而施之谓【不清】。'); assert.equal(result.items[0].uncertain, true);
  assert.equal(result.items[0].originalText, '不陵节而施之谓孙。'); assert.equal(result.items[0].secondReadText, '不陵节而施之谓顺。');
  assert.equal(result.items[0].canonicalBasis, 'ocr_disagreement');
});

test('existing uncertainty tokens remain atomic and line-count conflicts mark a review blank', () => {
  const disputed = validateSourceContent(content([item('S1', '甲乙', 1)]), [read('甲【不清】乙'), read('甲【裁切】乙')]);
  assert.equal(disputed.items[0].text, '甲【不清】乙');
  const differentLines = validateSourceContent(content([item('S1', '甲乙', 1, 2)]), [read('甲\n乙'), read('甲乙')]);
  assert.equal(differentLines.items[0].text, '甲\n乙\n【待核对】'); assert.equal(differentLines.items[0].canonicalBasis, 'unmatched_lines');
});

test('OCR2-only text at an OCR1 blank line becomes a traceable unresolved source block', () => {
  const reads = [read('甲\n\n乙'), read('甲\n遗漏知识\n乙')];
  const result = validateSourceContent(content([item('S1', '甲', 1), item('S2', '乙', 3)]), reads);
  assert.equal(result.items.length, 3); assert.equal(result.items[1].text, '【不清】');
  assert.equal(result.items[1].originalText, ''); assert.equal(result.items[1].secondReadText, '遗漏知识');
  assert.equal(result.items[1].uncertain, true); assert.deepEqual(result.items[1].sourceRefs, [{ image: 1, lineStart: 2, lineEnd: 2 }]);
  assert.match(result.differences.join('\n'), /图1第2行.*OCR1为空.*遗漏知识/);
  assert.equal(result.transcription, '甲\n\n【不清】\n\n乙');
  assert.deepEqual(validateSourceContent(result, reads), result, 'second validation must not insert duplicate placeholders');
});

test('an OCR2-only line inside a multi-reference block keeps its exact place', () => {
  const value = content([{ ...item('S1', '甲乙', 1), sourceRefs: [{ image: 1, lineStart: 1, lineEnd: 1 }, { image: 1, lineStart: 3, lineEnd: 3 }] }]);
  const result = validateSourceContent(value, [read('甲\n\n乙'), read('甲\n新增行\n乙')]);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].text, '甲\n【不清】\n乙');
  assert.equal(result.items[0].originalText, '甲\n\n乙'); assert.equal(result.items[0].sourceRefs.length, 3);
});

test('blank paragraph titles receive stable positional names and remain discoverable', () => {
  const result = validateSourceContent(content([{ ...item('S1', '完整原文', 1), title: '  ' }]), [read('完整原文'), read('完整原文')]);
  assert.equal(result.items[0].title, '图1第1行');
  const data = { photoKnowledge: { documents: { source: { id: 'source', scopeKey: 'scope', materialKind: 'source_note', currentVersion: 1,
    revisions: [{ version: 1, archivedBy: 'system:source-restoration', items: result.items }] } } } };
  assert.equal(savedItems(data, () => true).length, 1);
});
