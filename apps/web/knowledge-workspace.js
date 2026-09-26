const root = document.querySelector('#knowledge');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = { contains: '包含', contrast: '对比', confusable: '易混淆', prerequisite: '前置' };
const state = { role: null, points: [], cursor: null, selected: null, generation: 0, listGeneration: 0, query: '', documentId: '', learning: '' };
async function api(path, body) {
  const response = await fetch(`/api/knowledge-v2${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (response.status === 401) { location.assign('/login'); throw new Error('请先登录。'); }
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败，请重试。'); return result;
}
function notice(text) { root.querySelector('[data-notice]').textContent = text; }
function busy(button, operation) { button.disabled = true; return operation().catch(e => notice(e.message)).finally(() => { button.disabled = false; }); }
root.innerHTML = `<div class="section-heading"><div><p class="eyebrow">知识之间的联系</p><h2>从一个知识点开始回忆</h2></div><button class="secondary" data-random>随机抽查</button></div>
  <form class="knowledge-search"><label for="knowledge-query">找知识点或教材原文</label><div><input id="knowledge-query" maxlength="500" placeholder="知识名称、章节或原文关键词"><button class="secondary">查找</button></div></form>
  <div class="knowledge-filters"><label>资料来源<select data-source-filter><option value="">全部资料</option></select></label><label>学习范围<select data-learning-filter><option value="">全部知识</option><option value="enrolled">我的学习范围</option></select></label></div>
  <p data-notice role="status" aria-live="polite" class="help-text"></p>
  <div class="knowledge-workspace"><aside class="knowledge-catalog" aria-label="知识目录"><p data-count class="help-text"></p><div data-points></div><button data-more class="secondary" hidden>加载更多</button></aside>
  <div class="knowledge-canvas"><div data-graph class="local-graph" aria-label="局部知识图谱"></div><p class="help-text">点击相邻知识点切换。连线表示已核对的关系，展开节点不会记作完成复习。</p><section data-detail aria-live="polite"></section></div></div>`;

async function load(reset = true) {
  const generation = ++state.listGeneration;
  const result = await api(`/points?limit=30&cursor=${reset ? 0 : state.cursor || 0}&query=${encodeURIComponent(state.query)}&documentId=${encodeURIComponent(state.documentId)}&learning=${state.learning}`);
  if (generation !== state.listGeneration) return;
  state.points = reset ? result.items : [...state.points, ...result.items]; state.cursor = result.nextCursor;
  root.querySelector('[data-count]').textContent = `${result.total} 个知识点${state.query ? ' · 检索结果' : ''}`;
  root.querySelector('[data-more]').hidden = state.cursor === null;
  root.querySelector('[data-points]').innerHTML = state.points.length ? state.points.map(p => `<button class="point-choice ${p.id === state.selected ? 'selected' : ''}" data-point="${esc(p.id)}"><strong>${esc(p.title)}</strong><span>${p.materialKind === 'textbook' ? '教材参考' : '个人知识'} · ${p.hasReviewedAnswer ? '答案已核对' : '答案待核对'}</span></button>`).join('') : '<p class="help-text">没有找到匹配内容。试试知识名称，或先导入资料。</p>';
  root.querySelectorAll('[data-point]').forEach(button => button.addEventListener('click', () => busy(button, () => select(button.dataset.point))));
  if (reset && state.points.length && !state.selected) await select(state.points[0].id);
}

function graphMarkup(graph) {
  const center = graph.nodes.find(p => p.id === graph.rootId), neighbors = graph.nodes.filter(p => p.id !== graph.rootId);
  const mobile = matchMedia('(max-width: 700px)').matches, width = mobile ? 420 : 700;
  const positions = new Map([[center.id, { x: width / 2, y: 190 }]]), shown = neighbors.slice(0, mobile ? 6 : 12);
  shown.forEach((p, i) => { const a = i * Math.PI * 2 / shown.length - Math.PI / 2; positions.set(p.id, { x: width / 2 + (mobile ? 135 : 245) * Math.cos(a), y: 190 + 132 * Math.sin(a) }); });
  const edges = graph.edges.filter(e => positions.has(e.from) && positions.has(e.to)).map(e => {
    const a = positions.get(e.from), b = positions.get(e.to);
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/><text class="edge-label" x="${(a.x+b.x)/2 + 35}" y="${(a.y+b.y)/2-8}">${labels[e.type]}</text>`;
  }).join('');
  const nodes = [center, ...shown].map(p => { const pos = positions.get(p.id), main = p.id === center.id;
    return `<g class="graph-node ${main ? 'center' : ''}" tabindex="0" role="button" aria-label="${esc(p.title)}" data-node="${esc(p.id)}" transform="translate(${pos.x},${pos.y})"><title>${esc(p.title)}</title><circle r="${main ? 35 : 23}"/><text y="${main ? 53 : 39}">${esc(p.title.length > 12 ? `${p.title.slice(0,12)}…` : p.title)}</text><text class="node-state" y="${main ? 71 : 55}">${p.state?.nextReviewOn ? `复习 ${esc(p.state.nextReviewOn)}` : p.materialKind === 'textbook' ? '教材参考' : '个人知识'}</text></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} 410" aria-label="${esc(center.title)}的关联图">${edges}${nodes}</svg>${!neighbors.length ? '<p class="graph-empty">还没有核对过的关联。可以在下方添加“对比”或“易混淆”知识点。</p>' : ''}<div class="graph-neighbors">${neighbors.map(p => `<button class="quiet-action" data-node="${esc(p.id)}">${esc(p.title)}</button>`).join('')}</div>`;
}

async function select(id) {
  const generation = ++state.generation; state.selected = id; notice('正在读取知识点与原文依据…');
  const [point, graph] = await Promise.all([api(`/points/${encodeURIComponent(id)}`), api(`/points/${encodeURIComponent(id)}/graph`)]);
  if (generation !== state.generation) return;
  root.querySelectorAll('[data-point]').forEach(b => b.classList.toggle('selected', b.dataset.point === id));
  const graphArea = root.querySelector('[data-graph]'); graphArea.innerHTML = graphMarkup(graph);
  graphArea.querySelectorAll('[data-node]').forEach(node => {
    const open = () => select(node.dataset.node).catch(e => notice(e.message));
    node.addEventListener('click', open);
    if (node.tagName.toLowerCase() === 'g') node.addEventListener('keydown', e => { if (['Enter',' '].includes(e.key)) { e.preventDefault(); void open(); } });
  });
  const sources = new Map([[point.id, point]]), detail = root.querySelector('[data-detail]');
  for (const e of point.reviewedAnswer?.evidence || []) sources.set(e.pointId, { id: e.pointId, title: e.title, text: e.text || e.quote, sourceVersion: e.version });
  detail.innerHTML = `<div class="point-heading"><div><p class="eyebrow">${point.materialKind === 'textbook' ? '教材参考' : '个人知识'}</p><h3>${esc(point.title)}</h3><p class="help-text">${esc(point.sourceTitle || '')} · ${point.answerStatus === 'reviewed' ? '参考答案已核对' : point.answerStatus === 'stale' ? '资料已变化，答案需重新核对' : '参考答案待核对'}</p></div>
    ${state.role !== 'admin' ? `<button class="primary" data-start>${point.practiceEligible ? '合上资料，开始回忆' : '加入我的学习范围'}</button>` : ''}</div>
    <details class="source-panel"><summary>展开原文与来源</summary><div class="knowledge-text">${esc(point.text)}</div><p>${(point.sourceAnchors || []).map(a => `<a href="${esc(a.pageUrl)}" target="_blank" rel="noopener">PDF 第 ${a.pdfPage} 页</a>`).join(' · ')}</p></details>
    ${point.reviewedAnswer ? `<details class="source-panel"><summary>展开已核对答案</summary><ol>${point.reviewedAnswer.items.map(i => `<li>${esc(i.text)} <small>依据 ${i.evidenceIds.map(esc).join('、')}</small></li>`).join('')}</ol>${point.reviewedAnswer.evidence.map(e => `<blockquote><b>${esc(e.id)} · ${esc(e.title)}</b><p>${esc(e.quote)}</p></blockquote>`).join('')}</details>` : ''}
    <details class="source-panel"><summary>最近学习记录</summary>${point.timeline?.length ? `<ul>${point.timeline.map(e => `<li>${esc(e.on)} · ${e.type === 'review' ? `自评：${esc(e.rating)}；下次 ${esc(e.nextReviewOn)}` : e.type === 'enrollment' ? '加入学习范围' : '上传遗忘知识'}</li>`).join('')}</ul>` : '<p class="help-text">还没有个人学习记录。</p>'}</details>
    <details class="source-panel"><summary>核对并保存参考答案</summary><p class="help-text">先对照原文。填写完整要点和支撑它的摘录；保存表示你已核对答案与引用。</p>
      <form data-evidence-search class="inline-search"><input aria-label="查找教材依据" placeholder="查找其他教材原文" maxlength="500"><button class="secondary">查依据</button></form><div data-evidence-results></div>
      <form data-review><div data-answer-items></div><button type="button" data-add-item class="secondary">增加要点</button><label class="review-check"><input type="checkbox" required> 我已对照原文核对这些要点</label><button class="primary">保存已核对答案</button></form>
    </details>
    <details class="source-panel"><summary>管理知识关联</summary>${graph.edges.map(e => `<p>${esc(graph.nodes.find(n => n.id === e.from)?.title)} → ${labels[e.type]} → ${esc(graph.nodes.find(n => n.id === e.to)?.title)} <button class="quiet-action" data-delete-relation="${esc(e.id)}">移除</button></p>`).join('')}<form data-relation-search class="inline-search"><input aria-label="关联知识名称" maxlength="500" required placeholder="输入另一个知识名称"><button class="secondary">查找</button></form><form data-relation><select aria-label="关联知识" data-relation-target required></select><select aria-label="关系类型" data-relation-type><option value="contrast">对比</option><option value="confusable">易混淆</option><option value="contains">包含</option><option value="prerequisite">前置</option></select><p class="help-text">方向为当前知识点 → 关联知识。例如“前置”表示当前知识是对方的前置知识。</p><button class="secondary">确认关系</button></form></details>`;
  const start = detail.querySelector('[data-start]');
  start?.addEventListener('click', () => busy(start, async () => {
    if (!point.practiceEligible) { await api(`/points/${id}/enrollment`, {}); await select(id); notice('已加入学习范围，可以开始回忆。'); }
    else window.dispatchEvent(new CustomEvent('practice-point', { detail: id }));
  }));
  let itemSequence = 0;
  const addItem = (existing = null) => {
    const row = document.createElement('div'); row.className = 'answer-item-editor';
    row.extraEvidence = [];
    row.innerHTML = `<label>答案要点 ${++itemSequence}<textarea data-item-text maxlength="1500" rows="2" required></textarea></label><label>依据资料<select data-item-source>${[...sources.values()].map(s => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('')}</select></label><label>支撑这一要点的原文摘录<textarea data-item-quote maxlength="3000" rows="3" required placeholder="从原文复制完整相关句段"></textarea></label><button type="button" class="quiet-action" data-remove>移除此要点</button>`;
    row.querySelector('[data-remove]').addEventListener('click', () => row.remove()); detail.querySelector('[data-answer-items]').append(row);
    if (existing?.text) {
      row.querySelector('[data-item-text]').value = existing.text;
      const e = point.reviewedAnswer.evidence.find(e => e.id === existing.evidenceIds[0]);
      if (e) { row.querySelector('[data-item-source]').value = e.pointId; row.querySelector('[data-item-quote]').value = e.quote; }
      for (const eid of existing.evidenceIds.slice(1)) {
        const extra = point.reviewedAnswer.evidence.find(e => e.id === eid); if (!extra) continue;
        row.extraEvidence.push({ pointId: extra.pointId, version: extra.version, quote: extra.quote });
        const note = document.createElement('p'); note.className = 'help-text'; note.textContent = `同时保留依据：${extra.title} · ${extra.quote}`; row.append(note);
      }
    }
  };
  if (point.reviewedAnswer) point.reviewedAnswer.items.forEach(addItem); else addItem();
  detail.querySelector('[data-add-item]').addEventListener('click', () => addItem());
  detail.querySelectorAll('[data-delete-relation]').forEach(b => b.addEventListener('click', () => busy(b, async () => {
    await api(`/points/${id}/relations`, { deleteId: b.dataset.deleteRelation }); await select(id); notice('关联已移除，保留修改记录。');
  })));
  detail.querySelector('[data-evidence-search]').addEventListener('submit', e => { e.preventDefault(); void busy(e.submitter, async () => {
    const result = await api('/search', { query: e.target.querySelector('input').value }); if (generation !== state.generation) return;
    detail.querySelector('[data-evidence-results]').innerHTML = result.hits.map(p => `<button type="button" class="point-choice" data-evidence="${esc(p.id)}"><strong>${esc(p.title)}</strong><span>${esc(p.text)}</span></button>`).join('') || '<p>没有找到教材依据。</p>';
    detail.querySelectorAll('[data-evidence]').forEach(b => b.addEventListener('click', () => busy(b, async () => {
      const source = await api(`/points/${b.dataset.evidence}`); if (generation !== state.generation) return; sources.set(source.id, source);
      detail.querySelectorAll('[data-item-source]').forEach(select => { if (![...select.options].some(o => o.value === source.id)) select.add(new Option(source.title, source.id)); select.value = source.id; });
      const preview = document.createElement('div'); preview.className = 'knowledge-text'; preview.textContent = source.text; b.replaceWith(preview); notice('已选中依据，请复制支撑各要点的完整原文。');
    })));
  }); });
  detail.querySelector('[data-review]').addEventListener('submit', e => { e.preventDefault(); void busy(e.submitter, async () => {
    const items = [...detail.querySelectorAll('.answer-item-editor')].map(row => { const source = sources.get(row.querySelector('[data-item-source]').value); return { text: row.querySelector('[data-item-text]').value, evidence: [{ pointId: source.id, version: source.sourceVersion, quote: row.querySelector('[data-item-quote]').value }, ...row.extraEvidence] }; });
    await api(`/points/${id}/answer-reviews`, { reviewed: true, expectedVersion: point.answerVersion, pointVersion: point.sourceVersion, items }); await select(id); notice('参考答案与依据已保存。新练习使用这份答案，已有练习保持原版本。');
  }); });
  detail.querySelector('[data-relation-search]').addEventListener('submit', e => { e.preventDefault(); void busy(e.submitter, async () => {
    const result = await api('/search', { query: e.target.querySelector('input').value }); if (generation !== state.generation) return;
    detail.querySelector('[data-relation-target]').innerHTML = result.hits.filter(p => p.id !== id).map(p => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('');
  }); });
  detail.querySelector('[data-relation]').addEventListener('submit', e => { e.preventDefault(); void busy(e.submitter, async () => {
    await api(`/points/${id}/relations`, { to: detail.querySelector('[data-relation-target]').value, type: detail.querySelector('[data-relation-type]').value, confirmed: true }); await select(id); notice('已保存核对过的知识关系。');
  }); });
  notice('资料已就绪。先回忆，再展开答案核对。');
}
root.querySelector('.knowledge-search').addEventListener('submit', e => { e.preventDefault(); state.query = root.querySelector('#knowledge-query').value.trim(); void busy(e.submitter, () => load()); });
root.querySelector('[data-more]').addEventListener('click', e => busy(e.target, () => load(false)));
for (const [selector, key] of [['[data-source-filter]', 'documentId'], ['[data-learning-filter]', 'learning']]) root.querySelector(selector).addEventListener('change', e => {
  state[key] = e.target.value; state.selected = null; void load().catch(e => notice(e.message));
});
root.querySelector('[data-random]').addEventListener('click', e => busy(e.target, async () => { const p = await api('/spot-checks', {}); await select(p.id); window.dispatchEvent(new CustomEvent('practice-point', { detail: p.id })); }));
try { const session = await (await fetch('/api/session')).json(); state.role = session.role; root.querySelector('[data-random]').hidden = state.role === 'admin';
  const sources = await api('/sources'); for (const s of sources) root.querySelector('[data-source-filter]').add(new Option(`${s.title} (${s.pointCount})`, s.id));
  await load(); }
catch (e) { notice(e.message); }
async function refreshIdle() {
  if (document.hidden || root.querySelector('details[open]') || document.querySelector('dialog[open]')) return;
  const sources = await api('/sources'), filter = root.querySelector('[data-source-filter]');
  filter.replaceChildren(new Option('全部资料', '')); for (const s of sources) filter.add(new Option(`${s.title} (${s.pointCount})`, s.id)); filter.value = state.documentId;
  await load(); if (state.selected) await select(state.selected);
}
window.addEventListener('focus', () => refreshIdle().catch(e => notice(e.message)));
setInterval(() => refreshIdle().catch(e => notice(e.message)), 30000);
