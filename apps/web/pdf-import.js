const form = document.querySelector('#pdf-upload');
const status = document.querySelector('#pdf-status');
const list = document.querySelector('#pdf-jobs');
let role, working = false;
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
async function api(url, body) {
  const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (response.status === 401) { location.replace('/login'); throw new Error('请重新登录'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
const labels = { queued: '排队中', running: '正在解析，首次运行需下载模型', ready: '待核对', saved: '已入库', failed: '解析失败' };
async function refresh() {
  const opened = new Set([...list.querySelectorAll('details[open]')].map(d => d.dataset.id));
  const { parser, jobs } = await api('/api/pdf-imports');
  form.hidden = role === 'admin';
  form.querySelector('button').disabled = working || !parser.ready;
  if (!working) status.textContent = !parser.configured ? '尚未启用 PDF 解析服务。' : !parser.ready ? '解析服务暂不可用，请检查部署状态。' : '解析服务已连接。请核对每一页后再确认入库。';
  list.innerHTML = jobs.map(j => `<details class="knowledge-entry" data-id="${escape(j.id)}" ${opened.has(j.id) ? 'open' : ''}><summary>${escape(j.filename)} · ${labels[j.status] || escape(j.status)}</summary>
    <p>${escape(j.error || '')}</p><a href="/api/pdf-imports/${escape(j.id)}/source">下载原 PDF 核对</a>
    ${(j.parsed?.pages || []).map(p => `<h3>第 ${p.pageNumber} 页</h3><div class="knowledge-text">${escape(p.blocks.map(b => b.plainText).join('\n\n') || '此页未识别到文字，请核对原件。')}</div>`).join('')}
    ${j.status === 'ready' && role !== 'admin' ? `<button class="secondary" data-confirm="${escape(j.id)}" type="button">已核对，按待核验资料入库</button>` : ''}</details>`).join('');
  list.querySelectorAll('[data-confirm]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await api(`/api/pdf-imports/${button.dataset.confirm}/confirm`, { reviewed: true }); await refresh(); window.dispatchEvent(new Event('focus')); }
    catch(e) { status.textContent = e.message; button.disabled = false; }
  }));
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const file = document.querySelector('#pdf-file').files[0];
  if (!file || !/\.pdf$/i.test(file.name) || file.size > 10 * 1024 * 1024) { status.textContent = '请选择 10 MB 以内的 PDF。'; return; }
  working = true; form.querySelector('button').disabled = true;
  let uploaded = false;
  try {
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
    await api('/api/pdf-imports', { filename: file.name, base64: data });
    uploaded = true;
    form.reset(); status.textContent = '已接收，可稍后回来查看结果。';
  } catch(e) { status.textContent = e.message; }
  finally { working = false; form.querySelector('button').disabled = false; }
  if (uploaded) try { await refresh(); } catch(e) { status.textContent = e.message; }
});
try { role = (await api('/api/session')).role; await refresh(); } catch(e) { status.textContent = e.message; }
document.querySelector('#pdf-refresh').addEventListener('click', () => refresh().catch(e => { status.textContent = e.message; }));
setInterval(() => { if (!document.hidden && !working && !list.querySelector('details[open]')) refresh().catch(e => { status.textContent = e.message; }); }, 5000);
