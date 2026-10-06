import { sampleDate, sampleTasks, sampleRequests, categories, environments, sampleRates } from './sample.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = value => new Intl.NumberFormat('zh-CN').format(value);
const money = nano => new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(nano / 1e9);
const preciseMoney = nano => new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(nano / 1e9);
const compact = value => value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}K` : number(value);
const dateLabel = date => `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8))} 日`;
const statusNames = { success: '完成', parse_failed: '格式校验失败', timeout: '超时', interrupted: '连接中断' };
const state = { period: 'month', env: 'prod', view: 'overview', category: 'all', status: 'all', query: '', page: 1, day: null, monthlyBudget: 24, dailyBudget: 5, statement: null };
let toastTimer;

function scopedRequests() {
  return sampleRequests.filter(r => (state.env === 'all' || r.env === state.env) &&
    (state.period !== 'today' || r.date === sampleDate) && (state.period !== 'month' || r.date.startsWith('2026-10')));
}
function summarize(requests) {
  const known = requests.filter(r => r.usageStatus === 'known');
  const sum = key => known.reduce((total, r) => total + (r[key] ?? 0), 0);
  return { count: requests.length, unknown: requests.length - known.length,
    input: sum('input'), output: sum('output'), cached: sum('cached'), reasoning: sum('reasoning'),
    tokens: sum('input') + sum('output'), nanoCost: sum('nanoCost'),
    failed: requests.filter(r => r.status !== 'success').length,
    retry: requests.filter(r => r.retry > 0).length,
    unpriced: requests.filter(r => r.toolCostUnknown).length };
}
function budgetData() {
  const today = state.period === 'today';
  const summary = summarize(sampleRequests.filter(r => r.env === 'prod' && (!today || r.date === sampleDate)));
  const amount = today ? state.dailyBudget : state.monthlyBudget;
  return { ...summary, amount, spent: summary.nanoCost / 1e9, percent: summary.nanoCost / 1e9 / amount * 100, label: today ? '今日' : '本月' };
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3500);
}
function renderBudget() {
  const b = budgetData();
  const level = b.percent >= 100 ? 'over' : b.percent >= 80 ? 'near' : 'safe';
  $('#budget-alert').innerHTML = level === 'safe' ? '' : `<div class="budget-alert"><span class="alert-symbol" aria-hidden="true">ⓘ</span><div><strong>正式环境${b.label}${level === 'over' ? '已超出' : '接近'}参考预算</strong><span class="alert-detail">已观测模型估算 ¥${money(b.nanoCost)} / ¥${b.amount.toFixed(2)} · ${Math.round(b.percent)}%</span></div><span class="badge orange">继续调用</span></div>`;
  $('#budget-summary').innerHTML = `<div class="budget-amount"><strong>¥${money(b.nanoCost)}</strong><span>/ ¥${b.amount.toFixed(2)}</span></div><progress class="budget-progress ${level === 'safe' ? 'safe' : ''}" max="100" value="${Math.min(100, b.percent)}" aria-label="正式环境${b.label}参考预算使用比例"></progress><div class="budget-caption"><span>正式环境 · ${b.label}参考金额</span><span class="${level === 'over' ? 'over' : ''}">${level === 'over' ? `超出 ¥${(b.spent - b.amount).toFixed(2)}` : `${Math.round(b.percent)}%`}</span></div>`;
}
function renderMetrics() {
  const s = summarize(scopedRequests());
  const official = state.statement && state.env === 'prod' && state.period !== 'today';
  const period = state.period === 'today' ? '今日' : state.period === 'week' ? '近 7 天' : '本月';
  const cards = [
    `<article class="metric dark"><div class="metric-label">${period}模型估算费用 <span class="badge">已观测</span></div><div class="metric-number"><span class="currency">¥</span>${money(s.nanoCost)}</div><div class="metric-note">${environments[state.env]} · 不含未知用量及工具费</div></article>`,
    `<article class="metric"><div class="metric-label"><i class="dot blue"></i>已观测 token</div><div class="metric-number">${compact(s.tokens)}</div><div class="metric-note">输入 ${compact(s.input)} · 输出 ${compact(s.output)}</div></article>`,
    `<article class="metric"><div class="metric-label"><i class="dot gray"></i>官方已结算</div><div class="metric-number ${official ? '' : 'empty-number'}">${official ? `<span class="currency">¥</span>${money(state.statement.paid)}` : '—'}</div><div class="metric-note">${official ? '正式环境样例 · 仅覆盖 10.01—10.05' : '未同步当前范围账单，不代表零费用'}</div></article>`,
    `<article class="metric ${s.unknown ? 'alert-metric' : ''}"><div class="metric-label"><i class="dot coral"></i>用量待核实</div><div class="metric-number">${s.unknown}<span class="currency"> 笔</span></div><div class="metric-note">${s.count} 次请求 · 另有 ${s.unpriced} 次请求工具费待核对</div></article>`
  ];
  $('#metrics').innerHTML = cards.join('');
}
function renderTrend() {
  const monthDays = Array.from({ length: 6 }, (_, i) => `2026-10-0${i + 1}`);
  const days = state.period === 'today' ? [sampleDate] : state.period === 'week' ? ['2026-09-30', ...monthDays] : monthDays;
  const summaries = days.map(date => ({ date, ...summarize(scopedRequests().filter(r => r.date === date)) }));
  const width = 600, height = 170, left = 47, right = 23, top = 12, bottom = 21;
  const maxValue = Math.max(1, ...summaries.map(s => s.nanoCost / 1e9));
  const upper = Math.ceil(maxValue / 2) * 2;
  const x = i => summaries.length === 1 ? width / 2 : left + (width - left - right) * i / (summaries.length - 1);
  const y = value => height - bottom - value / upper * (height - top - bottom);
  const points = summaries.map((s, i) => `${x(i)},${y(s.nanoCost / 1e9)}`);
  const grid = [0, 0.5, 1].map(factor => `<line x1="${left}" y1="${y(upper * factor)}" x2="${width - right}" y2="${y(upper * factor)}" stroke="#e7edf2" stroke-dasharray="3 4"/><text x="${left - 9}" y="${y(upper * factor) + 3}" text-anchor="end" fill="#98a6b1" font-size="10">¥${(upper * factor).toFixed(0)}</text>`).join('');
  const area = summaries.length > 1 ? `<path d="M ${x(0)},${height - bottom} L ${points.join(' L ')} L ${x(summaries.length - 1)},${height - bottom} Z" fill="url(#chart-fill)"/><polyline points="${points.join(' ')}" fill="none" stroke="#397b9e" stroke-width="2" stroke-linejoin="round"/>` : '';
  const markers = summaries.map((s, i) => `<g data-chart-day="${s.date}"><title>${dateLabel(s.date)}：模型估算 ¥${money(s.nanoCost)}，${s.unknown} 笔用量未知</title><circle cx="${x(i)}" cy="${y(s.nanoCost / 1e9)}" r="${state.day === s.date ? 6 : 4}" fill="${state.day === s.date ? '#cf825f' : '#397b9e'}" stroke="white" stroke-width="2"/><circle cx="${x(i)}" cy="${y(s.nanoCost / 1e9)}" r="15" fill="transparent"/><text x="${x(i)}" y="${Math.max(10, y(s.nanoCost / 1e9) - 12)}" text-anchor="middle" fill="#7590a4" font-size="10">${money(s.nanoCost)}</text></g>`).join('');
  $('#trend-chart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${environments[state.env]}每日已观测模型费用估算趋势"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#bfd8e8" stop-opacity="0.55"/><stop offset="100%" stop-color="#edf4f8" stop-opacity="0.2"/></linearGradient></defs>${grid}${area}${markers}</svg>`;
  $('#chart-days').innerHTML = days.map(date => `<button data-day="${date}" class="${state.day === date ? 'selected' : ''}" aria-pressed="${state.day === date}">${date.slice(5).replace('-', '.')}</button>`).join('');
  $('#trend-range').textContent = state.period === 'today' ? '10 月 6 日' : state.period === 'week' ? '9 月 30 日—10 月 6 日' : '10 月 1—6 日';
}
function renderPurposes() {
  const requests = scopedRequests();
  const total = summarize(requests).nanoCost;
  const rows = Object.entries(categories).map(([id, category]) => ({ id, category, ...summarize(requests.filter(r => r.category === id)) })).filter(row => row.count > 0).sort((a, b) => b.nanoCost - a.nanoCost);
  $('#purpose-breakdown').innerHTML = rows.length ? `<div class="purpose-list">${rows.map(row => `<div class="purpose-row ${row.id}"><div class="purpose-title"><span class="purpose-name"><i class="dot ${row.id === 'photo' ? 'blue' : row.id === 'feedback' ? 'coral' : row.id === 'chat' ? 'green' : 'gray'}"></i>${row.category.label}</span><span class="purpose-amount">¥${money(row.nanoCost)}</span></div><progress class="purpose-track" max="100" value="${total ? row.nanoCost / total * 100 : 0}" aria-label="${row.category.label}费用占比"></progress><div class="purpose-sub">${row.count} 次请求${row.retry ? ` · ${row.retry} 次重试` : ''}<span class="purpose-share">${total ? Math.round(row.nanoCost / total * 100) : 0}%</span></div></div>`).join('')}</div>` : '<div class="empty-state">这个范围没有样例调用。</div>';
}
function renderTopTasks() {
  const requests = scopedRequests();
  const rows = sampleTasks.map(task => ({ task, requests: requests.filter(r => r.taskId === task.id) })).filter(row => row.requests.length && (!state.day || row.task.date === state.day)).map(row => ({ ...row, ...summarize(row.requests) })).sort((a, b) => b.nanoCost - a.nanoCost).slice(0, 4);
  $('#top-task-heading').textContent = state.day ? `${dateLabel(state.day)}的任务` : '费用较高的任务';
  $('#top-tasks').innerHTML = rows.length ? rows.map(row => `<button class="task-row" data-task="${row.task.id}" aria-label="查看${esc(row.task.title)}费用明细"><span class="task-glyph ${row.task.category}">${categories[row.task.category].short}</span><span><strong class="task-title">${esc(row.task.title)}</strong><span class="task-meta">${row.task.date.slice(5).replace('-', '.')} · ${row.count} 次调用${row.retry ? ` · ${row.retry} 次重试` : ''} · ${environments[row.task.env]}</span></span><span class="task-cost"><strong>¥${money(row.nanoCost)}</strong>${row.unknown ? '<small>另有用量待核实</small>' : row.unpriced ? '<small>工具费待核对</small>' : ''}</span><span class="row-arrow" aria-hidden="true">↗</span></button>`).join('') : '<div class="empty-state"><strong>这一天没有相关任务</strong>可以选择其他日期或切换环境。</div>';
  $('#task-scope-note').innerHTML = state.day ? `按选定日期展示。<button class="text-button" id="clear-day">返回费用排序</button>` : '显示当前范围模型估算费用最高的 4 个任务。';
}
function filteredRequests() {
  const query = state.query.trim().toLowerCase();
  return scopedRequests().filter(r => (state.category === 'all' || r.category === state.category) && (state.status === 'all' || r.usageStatus === state.status) && (!query || [r.id, r.taskId, r.title, r.step, r.key].join(' ').toLowerCase().includes(query))).sort((a, b) => b.at.localeCompare(a.at));
}
function renderRequests() {
  const requests = filteredRequests();
  const totalPages = Math.max(1, Math.ceil(requests.length / 10));
  state.page = Math.min(state.page, totalPages);
  const rows = requests.slice((state.page - 1) * 10, state.page * 10);
  $('#request-rows').innerHTML = rows.length ? rows.map(r => `<tr><td class="mono">${r.date.slice(5).replace('-', '.')} ${r.at.slice(11, 16)}<small>${r.id}</small></td><td><strong>${esc(r.title)}</strong><small>${esc(r.step)}${r.retry ? ` · 重试 ${r.retry}` : ''}</small></td><td>${environments[r.env]}<small class="mono">${r.key}</small></td><td class="numeric">${r.input === null ? '未知' : `${compact(r.input)} / ${compact(r.output)}`}<small>${r.reasoning === null ? '未取得最终用量' : `其中推理 ${compact(r.reasoning)}`}</small></td><td class="numeric">${r.nanoCost === null ? '待核实' : `¥${preciseMoney(r.nanoCost)}`}<small>${r.toolCostUnknown ? '另有工具费待核对' : '模型用量估算'}</small></td><td><span class="badge ${r.status === 'success' ? 'green' : 'orange'}">${statusNames[r.status]}</span></td><td><button class="text-button" data-request="${r.id}" aria-label="查看请求 ${r.id} 详情">详情 ↗</button></td></tr>`).join('') : '<tr><td colspan="7"><div class="empty-state"><strong>没有匹配的调用</strong>试试其他关键词，或重置筛选。</div></td></tr>';
  $('#request-pagination').innerHTML = `<span>${requests.length} 条匹配 · ${state.page} / ${totalPages} 页</span><div class="pagination"><button id="prev-page" ${state.page <= 1 ? 'disabled' : ''} aria-label="上一页">‹</button><button id="next-page" ${state.page >= totalPages ? 'disabled' : ''} aria-label="下一页">›</button></div>`;
}
function renderStatement() {
  $('#clear-statement').hidden = !state.statement;
  $('#load-statement').textContent = state.statement ? '重新载入样例' : '载入对账样例';
  if (!state.statement) {
    $('#statement-content').innerHTML = '<div class="statement-empty"><span class="statement-icon" aria-hidden="true">⇄</span><h3>还没有官方账单</h3><p>本地估算帮助追踪费用来源，官方账单确认最终扣款。<br>载入一份样例，看看范围、差额和抵扣如何展示。</p><button class="text-button" id="load-statement-inline">查看对账样例 ↗</button></div>';
    return;
  }
  const statement = state.statement;
  $('#statement-content').innerHTML = `<div class="statement-intro"><strong>对账样例 · 正式环境 · 333-prod</strong><br>双方范围均为 2026 年 10 月 1—5 日（北京时间），不随顶部筛选改变。10 月 6 日尚未结算。样例导入时间：10 月 6 日 09:00。</div><div class="statement-metrics"><div class="statement-metric"><span>同范围本地模型估算</span><strong>¥${money(statement.local.nanoCost)}</strong><small>已观测 ${number(statement.local.tokens)} token</small></div><div class="statement-metric"><span>官方用量</span><strong>${compact(statement.officialTokens)}</strong><small>比本地多 ${number(statement.officialTokens - statement.local.tokens)} token</small></div><div class="statement-metric"><span>官方结算实扣</span><strong>¥${money(statement.paid)}</strong><small>样例含优惠抵扣，与标价估算口径不同</small></div></div><div class="statement-observation"><p><strong>有 ${number(statement.officialTokens - statement.local.tokens)} token 暂未对应本地请求。</strong><br>先核对漏记、其他脚本调用与统计范围。差额本身不能说明密钥被盗用。</p></div><div class="table-scroll"><table><thead><tr><th>结算项目</th><th>样例金额</th><th>口径说明</th></tr></thead><tbody><tr><td>模型推理标价金额</td><td class="numeric">¥${money(statement.gross)}</td><td>包含尚未匹配的官方用量</td></tr><tr><td>优惠与抵扣</td><td class="numeric">−¥${money(statement.discount)}</td><td>按账单记录，不从本地 token 猜测</td></tr><tr><td>模型推理实扣</td><td class="numeric">¥${money(statement.paid)}</td><td>以上两项相减</td></tr><tr><td>联网工具等其他费用</td><td>未同步</td><td>当前样例账单未覆盖，不记为零</td></tr></tbody></table></div><details class="statement-details"><summary>为什么估算与账单不一定相同？</summary><p>本地只记录本应用已观测到的请求。官方可能包含未返回用量的请求、其他程序调用和优惠抵扣。对账必须对齐 Key、日期与计费项。官方汇总不会再次加入本地请求总量。</p></details>`;
}
function render() {
  renderBudget(); renderMetrics(); renderTrend(); renderPurposes(); renderTopTasks(); renderRequests(); renderStatement();
}
function setView() {
  const hash = location.hash.slice(1);
  state.view = ['overview', 'requests', 'reconciliation'].includes(hash) ? hash : 'overview';
  for (const name of ['overview', 'requests', 'reconciliation']) $(`#${name}-view`).hidden = state.view !== name;
  document.querySelectorAll('[data-view]').forEach(link => {
    link.classList.toggle('active', link.dataset.view === state.view);
    if (link.dataset.view === state.view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
}
function detailSummary(summary, scope) {
  return `<div class="detail-summary"><div><span>已观测模型估算费用</span><strong>¥${money(summary.nanoCost)}</strong></div><div><span>用量与调用</span><strong class="summary-label">${compact(summary.tokens)} token · ${summary.count} 次请求</strong></div></div><div class="detail-context"><p><strong>${scope}</strong></p><p>价目：输入 ¥${sampleRates.input} / 缓存 ¥${sampleRates.cached} / 输出 ¥${sampleRates.output}，每百万 token。</p><p>推理 token 已包含在输出中；缓存 token 已包含在输入中。</p></div>${summary.unknown || summary.unpriced ? `<div class="detail-note">${summary.unknown ? `${summary.unknown} 次请求未返回最终用量，其费用未知。` : ''}${summary.unpriced ? `${summary.unpriced} 次请求涉及联网工具，额外工具费尚未定价。` : ''}以上金额仅为已观测模型部分。</div>` : ''}`;
}
function openTask(id) {
  const task = sampleTasks.find(t => t.id === id);
  if (!task) return;
  const summary = summarize(task.requests);
  $('#detail-title').textContent = task.title;
  $('#detail-content').innerHTML = detailSummary(summary, `${dateLabel(task.date)} · ${environments[task.env]} · ${task.id}`) + `<div class="step-list">${task.requests.map((r, i) => `<div class="step"><span class="step-number">${String(i + 1).padStart(2, '0')}</span><div><div class="step-title">${esc(r.step)} ${r.retry ? '<span class="badge orange">重试</span>' : ''}</div><small>${r.usageStatus === 'unknown' ? '输入、输出和费用未知' : `输入 ${number(r.input)} · 输出 ${number(r.output)} · 其中推理 ${number(r.reasoning)}`}</small><small>${statusNames[r.status]}${r.error ? ` · ${esc(r.error)}` : ''}</small><div class="step-details"><span class="mono">${r.id}</span><br>${r.api} · ${r.toolCalls ? `${r.toolCalls} 次搜索，工具费待核对` : '模型调用'}</div></div><div class="step-cost">${r.nanoCost === null ? '待核实' : `¥${preciseMoney(r.nanoCost)}`}<small>${r.nanoCost === null ? '不记为零' : '模型估算'}</small></div></div>`).join('')}</div>`;
  $('#detail-dialog').showModal();
}
function openRequest(id) {
  const r = sampleRequests.find(r => r.id === id);
  if (!r) return;
  $('#detail-title').textContent = r.step;
  const fields = [
    ['输入 token（含缓存）', r.input], ['其中缓存命中', r.cached], ['输出 token（含推理）', r.output], ['其中推理 token', r.reasoning], ['已观测模型费用', r.nanoCost === null ? null : `¥${preciseMoney(r.nanoCost)}`]
  ];
  $('#detail-content').innerHTML = detailSummary(summarize([r]), `${esc(r.title)} · ${environments[r.env]}`) + `<div class="request-breakdown"><dl>${fields.map(([label, value]) => `<dt>${label}</dt><dd>${value === null ? '未知' : typeof value === 'number' ? number(value) : value}</dd>`).join('')}</dl><p class="detail-footnote">模型：${r.model}<br>API：${r.api} · Key 别名：${r.key}<br>本地请求：${r.id}<br>上游响应：${r.responseId || '未取得'}<br>业务结果：${statusNames[r.status]}${r.error ? ` · ${esc(r.error)}` : ''}<br>价目：${sampleRates.version}<br>所有标识均为演示，不包含真实密钥。</p></div>`;
  $('#detail-dialog').showModal();
}
function openBudget() {
  $('#monthly-budget').value = state.monthlyBudget.toFixed(2);
  $('#daily-budget').value = state.dailyBudget.toFixed(2);
  $('#budget-dialog').showModal();
}
function loadStatement() {
  const local = summarize(sampleRequests.filter(r => r.env === 'prod' && r.date < sampleDate));
  const gross = local.nanoCost + 5400 * 6000;
  const discount = Math.round(gross * 0.08);
  state.statement = { local, officialTokens: local.tokens + 5400, gross, discount, paid: gross - discount };
  renderMetrics(); renderStatement();
  toast('已载入本地对账样例，未访问官方账户。');
}
function exportCsv() {
  const rows = filteredRequests();
  const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const columns = ['样例请求ID', '北京时间', '任务', '步骤', '环境', 'Key别名', '输入token', '缓存token', '输出token', '推理token', '模型估算费用_元', '用量状态', '业务结果'];
  const contents = [columns, ...rows.map(r => [r.id, r.at, r.title, r.step, environments[r.env], r.key, r.input ?? '未知', r.cached ?? '未知', r.output ?? '未知', r.reasoning ?? '未知', r.nanoCost === null ? '未知' : (r.nanoCost / 1e9).toFixed(6), r.usageStatus === 'known' ? '已观测完整' : '未知', statusNames[r.status]])].map(row => row.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', contents], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `333-费用样例-${state.env}-${sampleDate}.csv`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast(`已导出 ${rows.length} 条样例明细。`);
}
$('#environment').addEventListener('change', event => { state.env = event.target.value; state.page = 1; state.day = null; render(); });
document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => {
  state.period = button.dataset.period; state.day = null; state.page = 1;
  document.querySelectorAll('[data-period]').forEach(b => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); });
  render();
}));
$('#request-search').addEventListener('input', event => { state.query = event.target.value; state.page = 1; renderRequests(); });
$('#purpose-filter').addEventListener('change', event => { state.category = event.target.value; state.page = 1; renderRequests(); });
$('#status-filter').addEventListener('change', event => { state.status = event.target.value; state.page = 1; renderRequests(); });
$('#reset-filters').addEventListener('click', () => { state.query = ''; state.category = 'all'; state.status = 'all'; state.page = 1; $('#request-search').value = ''; $('#purpose-filter').value = 'all'; $('#status-filter').value = 'all'; renderRequests(); });
$('#show-all').addEventListener('click', () => { location.hash = 'requests'; });
$('#edit-budget').addEventListener('click', openBudget);
$('#edit-budget-secondary').addEventListener('click', openBudget);
$('#close-detail').addEventListener('click', () => $('#detail-dialog').close());
for (const selector of ['#close-budget', '#cancel-budget']) $(selector).addEventListener('click', () => $('#budget-dialog').close());
$('#budget-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  state.monthlyBudget = Number($('#monthly-budget').value); state.dailyBudget = Number($('#daily-budget').value);
  $('#budget-dialog').close(); renderBudget();
  toast('参考预算已应用到样板。超额继续调用，线上设置未变更。');
});
$('#load-statement').addEventListener('click', loadStatement);
$('#clear-statement').addEventListener('click', () => { state.statement = null; renderMetrics(); renderStatement(); toast('已清除本地对账样例。'); });
$('#export-csv').addEventListener('click', exportCsv);
document.addEventListener('click', event => {
  const task = event.target.closest('[data-task]'); if (task) openTask(task.dataset.task);
  const request = event.target.closest('[data-request]'); if (request) openRequest(request.dataset.request);
  const day = event.target.closest('[data-day], [data-chart-day]'); if (day) { state.day = day.dataset.day || day.dataset.chartDay; renderTrend(); renderTopTasks(); }
  if (event.target.closest('#clear-day')) { state.day = null; renderTrend(); renderTopTasks(); }
  if (event.target.closest('#prev-page')) { state.page--; renderRequests(); }
  if (event.target.closest('#next-page')) { state.page++; renderRequests(); }
  if (event.target.closest('#load-statement-inline')) loadStatement();
});
for (const dialog of [$('#detail-dialog'), $('#budget-dialog')]) dialog.addEventListener('click', event => {
  const rect = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
});
window.addEventListener('hashchange', setView);
render(); setView();
