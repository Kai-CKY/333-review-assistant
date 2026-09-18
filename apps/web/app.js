const state = { dashboard: null, activeTask: null, answerSourceId: null, answerSaved: false, answerSaving: false, feedbackPollToken: 0 };
const dashboard = document.querySelector('#dashboard');
const dialog = document.querySelector('#review-dialog');
const status = document.querySelector('#status');
const answer = document.querySelector('#answer');
let statusTimer = null;

async function request(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function daysUntil(dateKey) {
  const today = new Date();
  const target = new Date(`${dateKey}T00:00:00+08:00`);
  return Math.max(0, Math.ceil((target - today) / 86_400_000));
}

function taskMarkup(task, index) {
  const confidence = Math.max(0, Math.min(100, Math.round(Number(task.mastery) * 100) || 0));
  const taskId = escapeHtml(task.id);
  const label = escapeHtml(task.label);
  const title = escapeHtml(task.title);
  const prompt = escapeHtml(task.prompt);
  const estimatedMinutes = Math.max(0, Math.round(Number(task.estimatedMinutes)) || 0);
  if (index === 0) return `<article class="focus-card">
    <div class="focus-marker"><span>现在开始</span><b>01</b></div>
    <div class="focus-main"><p class="task-meta"><span>${label}</span><i></i><span>约 ${estimatedMinutes} 分钟</span></p>
      <h3>${title}</h3><p>${prompt}</p>
      <div class="mastery-line"><span>掌握度</span><div class="progress"><i style="width:${confidence}%"></i></div><b>${confidence}%</b></div>
    </div>
    <button data-task="${taskId}" class="primary">开始提取 <span>→</span></button>
  </article>`;
  return `<article class="task-row">
    <span class="task-order">${String(index + 1).padStart(2, '0')}</span>
    <div><p class="task-meta"><span>${label}</span><i></i><span>${estimatedMinutes} 分钟</span></p><h3>${title}</h3></div>
    <span class="row-mastery">${confidence}%</span>
    <button data-task="${taskId}" class="quiet-action" aria-label="开始回忆：${title}">开始 <span>→</span></button>
  </article>`;
}

function completionDateLabel(dateKey, dashboardDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return '日期待确认';
  const recorded = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(recorded.getTime())) return '日期待确认';
  const current = /^\d{4}-\d{2}-\d{2}$/.test(dashboardDate)
    ? new Date(`${dashboardDate}T00:00:00`)
    : new Date();
  const dayDifference = Math.round((current - recorded) / 86_400_000);
  if (dayDifference === 0) return '今天';
  if (dayDifference === 1) return '昨天';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(recorded);
}

function completionMarkup(entry, index, dashboardDate) {
  const reportedOn = String(entry.reportedOn ?? '');
  return `<li class="completion-entry">
    <span class="completion-check" aria-hidden="true">✓</span>
    <div class="completion-copy">
      <p>${escapeHtml(entry.content || '（未填写内容）')}</p>
      <span>第 ${String(index + 1).padStart(2, '0')} 条 · 本人自报</span>
    </div>
    <time datetime="${escapeHtml(reportedOn)}">${escapeHtml(completionDateLabel(reportedOn, dashboardDate))}</time>
  </li>`;
}

function render(data) {
  state.dashboard = data;
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const weakPoints = Array.isArray(data.weakPoints) ? data.weakPoints : [];
  const recentTaskCompletions = Array.isArray(data.recentTaskCompletions) ? data.recentTaskCompletions : [];
  const completedToday = Math.max(0, Number(data.completedToday) || 0);
  const selfReportedCompletedToday = Math.max(0, Number(data.selfReportedCompletedToday) || 0);
  document.querySelector('#study-date').textContent = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full' }).format(new Date());
  document.querySelector('#exam-countdown').innerHTML = `<span>距暂定考试日</span><strong>${daysUntil(data.targetExamDate)}<small>天</small></strong>`;
  const taskSummary = tasks.length ? `今天只做 ${tasks.length} 个知识点。` : '今日计划已完成。';
  const taskList = tasks.length ? tasks.map(taskMarkup).join('') : '<div class="empty">没有待办任务。你完成得很好。</div>';
  const completionList = recentTaskCompletions.length
    ? `<ol class="completion-list">${recentTaskCompletions.map((entry, index) => completionMarkup(entry, index, data.date)).join('')}</ol>`
    : '<div class="completion-empty"><strong>还没有完成备案</strong><span>在飞书私聊里说“我今天完成了……”，这里就会自动留下记录。</span></div>';
  const completionCaption = recentTaskCompletions.length ? `最近 ${recentTaskCompletions.length} 条` : '等待第一条';
  const completionDisclaimer = recentTaskCompletions.length
    ? '这些是李羊羊的自报备案，用于日后复盘，不会自动改动复习排期。'
    : '完成备案只用于日后复盘，不会自动改动复习排期。';
  const weak = weakPoints.length
    ? weakPoints.map((point, index) => `<li><span>${String(index + 1).padStart(2, '0')}</span><strong>${escapeHtml(point.title)}</strong><b>${Math.round(Number(point.mastery) * 100) || 0}%</b></li>`).join('')
    : '<li class="weak-empty">完成几次回忆后，这里会出现需要固化的概念。</li>';
  dashboard.innerHTML = `<section class="recall-route" aria-label="主动回忆流程">
      <div class="route-intro"><p class="eyebrow">今日的回忆路径</p><strong>别急着看资料，<br />先让记忆自己出现。</strong></div>
      <ol><li class="active"><span>01</span><div><b>提取</b><small>合上资料，写出所记得的</small></div></li><li><span>02</span><div><b>组织</b><small>把要点排成答题结构</small></div></li><li><span>03</span><div><b>校准</b><small>用自评安排下一次复习</small></div></li></ol>
    </section>
    <section class="work-area"><div class="task-zone"><div class="section-heading"><div><p class="eyebrow">今日清单</p><h2>${taskSummary}</h2></div><span class="completion completion-summary"><span>复习闭环 <b>${completedToday}</b> 次</span><i aria-hidden="true"></i><span>学习备案 <b>${selfReportedCompletedToday}</b> 条</span></span></div><div class="task-list">${taskList}</div>
      <section class="completion-ledger" aria-labelledby="completion-title"><div class="completion-ledger-heading"><div><p class="eyebrow">REVIEW LOG</p><h3 id="completion-title">最近的任务完成情况</h3></div><span>${completionCaption}</span></div>${completionList}<p class="completion-disclaimer">${completionDisclaimer}</p></section>
    </div>
    <aside class="insight-column"><section class="focus-note"><p class="eyebrow">今天的提示</p><strong>回忆得不完整，<br />正说明练习有效。</strong><span>“想不起来”不是失败，它是在告诉系统该把哪里放回明天。</span></section>
    <section class="weak-card"><div class="weak-heading"><p class="eyebrow">需要固化</p><span>易忘清单</span></div><ul>${weak}</ul><p class="help-text">掌握度只来自你的自评，不会被模型随意改写。</p></section></aside></section>`;
  document.querySelectorAll('[data-task]').forEach((button) => button.addEventListener('click', () => openTask(button.dataset.task)));
}

function openTask(taskId) {
  const task = state.dashboard.tasks.find((item) => item.id === taskId);
  if (!task) return;
  // Do not let a completed request from the previously open task overwrite the
  // status message for this task.
  state.feedbackPollToken += 1;
  state.activeTask = task;
  state.answerSourceId = newAnswerSourceId();
  state.answerSaved = false;
  state.answerSaving = false;
  answer.value = '';
  document.querySelector('#task-label').textContent = task.label;
  document.querySelector('#task-title').textContent = task.title;
  document.querySelector('#task-prompt').textContent = task.prompt;
  dialog.showModal();
}

async function saveAnswer() {
  if (!state.activeTask || !answer.value.trim()) return showStatus('先写下一点自己的回忆内容，再保存。', 'warning');
  if (state.answerSaved) return showStatus('这份答案已经保存，结构提示会继续在这里显示。', 'success');
  if (state.answerSaving) return showStatus('答案正在保存，请稍候。', 'success');
  state.answerSaving = true;
  try {
    const result = await request('/api/answer-attempts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        knowledgePointId: state.activeTask.knowledgePointId,
        content: answer.value,
        sourceId: state.answerSourceId ?? (state.answerSourceId = newAnswerSourceId())
      })
    });
    state.answerSaved = true;
    showStatus(result.message, 'success');
    if (result.job?.id) void pollFeedbackJob(result.job.id);
  } finally {
    state.answerSaving = false;
  }
}

function newAnswerSourceId() {
  const random = globalThis.crypto?.randomUUID?.();
  return `web:answer:${random ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function feedbackText(result) {
  const candidate = result?.feedback ?? result?.job?.answerFeedback?.feedback;
  if (typeof candidate === 'string') return candidate;
  return typeof candidate?.feedback === 'string' ? candidate.feedback : '';
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function pollFeedbackJob(jobId) {
  const token = ++state.feedbackPollToken;
  // The provider may be configured with up to a 60-second request timeout.
  // Keep polling long enough to surface its terminal result without making the
  // browser keep an unbounded background request alive.
  const maximumAttempts = 65;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      const result = await request(`/api/feedback-jobs/${encodeURIComponent(jobId)}`);
      const job = result.job ?? result;
      if (token !== state.feedbackPollToken) return;
      if (job?.status === 'succeeded') {
        const feedback = feedbackText(result);
        showStatus(feedback ? `结构提示：${feedback.replace(/\s*\n\s*/g, ' · ')}` : '结构提示已生成。', 'success', 12_000);
        return;
      }
      if (job?.status === 'failed') {
        showStatus('结构提示暂时无法生成，但答案、自评和复习安排都已保留。', 'warning', 8_000);
        return;
      }
    } catch (error) {
      if (attempt === maximumAttempts - 1 && token === state.feedbackPollToken) {
        showStatus('暂时无法查询结构提示；答案、自评和复习安排不受影响。', 'warning', 8_000);
        return;
      }
    }
    await wait(1_000);
  }
  if (token === state.feedbackPollToken) {
    showStatus('结构提示仍在生成中；答案、自评和复习安排不受影响。', 'success', 8_000);
  }
}

async function rate(rating) {
  if (!state.activeTask) return;
  await request('/api/reviews', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ knowledgePointId: state.activeTask.knowledgePointId, rating })
  });
  dialog.close();
  showStatus('已记录。下一次复习已重新安排。', 'success');
  await loadDashboard();
}

function showStatus(message, kind, duration = 3_600) {
  if (statusTimer) window.clearTimeout(statusTimer);
  status.textContent = message;
  status.className = `status visible ${kind}`;
  statusTimer = window.setTimeout(() => {
    status.className = 'status';
    statusTimer = null;
  }, duration);
}

async function loadDashboard() {
  try { render(await request('/api/dashboard')); }
  catch (error) { showStatus(`无法加载本地数据：${error.message}`, 'warning'); }
}

document.querySelector('#save-answer').addEventListener('click', () => saveAnswer().catch((error) => showStatus(error.message, 'warning')));
document.querySelectorAll('[data-rating]').forEach((button) => button.addEventListener('click', () => rate(button.dataset.rating).catch((error) => showStatus(error.message, 'warning'))));
loadDashboard();
