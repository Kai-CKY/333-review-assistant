import { todayKey } from './date.js';
import { uploadRecords, uploadStrip, simulator, predictions, openUploadEditor } from './upload-workspace.js';
import { scheduleReview } from './scheduler.js';
import { mountManagementPage } from './management-pages.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const today = todayKey();
const shift = (date, days) => { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };
const date = (value, withTime = false) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value)) : '未记录';
const roleName = role => role === 'learner' ? '学习者' : '管理员';
const scopeName = scope => scope === 'group' ? '群聊' : scope === 'p2p' ? '私聊' : '来源不详';
const ratingName = rating => ({ again: '没想起来', hard: '很吃力', good: '基本掌握', easy: '很轻松' })[rating] || '未自评';
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
let real;
const state = { mode: 'real', page: 'calendar', selected: today, start: today, window: 14, layer: 'current', scope: 'all', search: '', offset: 0, recordTab: 'points', reminder: true, pagesConfirmed: false, dataConfirmed: false, selectedUpload: '', scenario: {enabled:true,on:today,kind:'learn',rating:'good',title:'今天新学的知识点（日期预览）'} };
const data = () => real;
const titles = { calendar: ['学习与复习', 'LEARNING & RECALL', '把今天学过的，变成以后记得的。', '羊羊手动上传，系统安排下一次回忆。'], memory: ['Agent 记忆', 'MEMORY EXPLORER', '助手记住了什么，一眼看清。', '从当下对话到长期备注，查看来源、范围与归档历史。'], identity: ['人员与身份', 'PEOPLE & IDENTITY', '一直是羊羊，也一直是你。', '固定一名学习者和一名管理者，账号绑定与聊天称呼分开记录。'], data: ['迁移数据核对', 'DATA REVIEW', '旧记录，新的整理方式。', '查看运行中的数据、迁移核验与原有记录。'] };
const kindBadge = p => `<span class="badge ${p.completed ? 'green' : p.kind === 'forgotten' ? 'orange' : p.kind === 'learn' ? 'green' : p.kind === 'record' ? 'gray' : ''}">${p.completed ? '已完成' : ({ forgotten: '发现遗忘', review: '到期复习', learn: '当天新学', record: '仅作记录' })[p.kind]}</span>`;
const modeControls = () => '<a class="button" href="/study">背诵与自评 ↗</a>';

function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('visible'), 3500); }
function heading() {
  return `<section class="page-heading"><div><h1>${titles[state.page][0]}</h1></div><div class="heading-actions">${state.page === 'data' ? '' : modeControls()}</div></section>`;
}
function banner() {return '<div class="source-banner"><strong>学习数据</strong><span>与飞书 Agent 共用；上传文字校正会保存并保留修订。</span><span>管理员 · 查看全部数据</span></div>';}

function stat(label, value, suffix, note, color = '') { return `<div class="stat"><div class="stat-label"><span class="dot ${color}"></span>${label}</div><strong>${value}</strong><small>${suffix}</small><div class="stat-note">${note}</div></div>`; }
function task(p, i, overdue = false) {
  return `<article class="task"><span class="task-number">${String(i + 1).padStart(2, '0')}</span><div><h3 class="task-title">${escape(p.title)}</h3><div class="task-sub"><span>${escape(p.source)}</span><span>·</span><span>${overdue ? `原定 ${date(p.due)}` : p.lastReviewedOn ? `上次 ${date(p.lastReviewedOn)} · ${ratingName(p.lastRating)}` : p.kind === 'learn' ? '从当天上传开始安排' : '首次回忆感受尚未记录'}</span></div></div><div>${kindBadge(p)}<button class="arrow-button" data-point="${escape(p.id)}" aria-label="查看${escape(p.title)}的安排依据">↗</button></div></article>`;
}
function calendarPoints() {
  if (!state.selectedUpload) return data().points;
  const upload = uploadRecords(data()).find(u => u.id === state.selectedUpload);
  const ids = new Set(upload?.items.map(i => i.knowledgePointId) || []);
  return data().points.filter(p => ids.has(p.id));
}
function tasksFor(day) { return calendarPoints().filter(p => p.eligible && p.due === day); }
function calendar() {
  const d = data();
  const overdue = calendarPoints().filter(p => p.eligible && !p.completed && p.due && p.due < today);
  const due = calendarPoints().filter(p => p.eligible && !p.completed && p.due === today);
  const uploaded = d.points.filter(p => p.origin === 'manual_upload');
  const completed = Array.from({length:d.reviewLogCount||0});
  const range = Array.from({ length: state.window }, (_, i) => shift(state.start, i));
  const forecast = predictions(state.scenario);
  const week = range.map(day => { const tasks = tasksFor(day), predicted = forecast.find(f => f.on === day); const weekday = weekdays[new Date(`${day}T12:00:00Z`).getUTCDay()]; const kinds = [...new Set(tasks.map(t => t.completed ? 'done' : t.kind))]; return `<button class="day ${day === state.selected ? 'selected' : ''} ${day === today ? 'today' : ''} ${predicted ? 'predicted' : ''}" data-day="${day}" aria-pressed="${day === state.selected}" aria-label="${day}，${tasks.length}项${predicted?'，有预测复习':''}"><small>${day === today ? '今天' : weekday}</small><strong>${Number(day.slice(-2))}</strong><div class="day-dots">${kinds.map(k => `<span class="dot ${k === 'done' || k === 'learn' ? 'green' : k === 'forgotten' ? 'orange' : ''}"></span>`).join('')}${predicted ? '<span class="prediction-dot"></span>' : ''}${!kinds.length&&!predicted?'<span class="dot gray" style="opacity:.3"></span>':''}</div><div class="day-count">${tasks.length ? `${tasks.length} 项安排` : predicted ? `预测第 ${predicted.number} 次` : '暂无安排'}</div></button>`; }).join('');
  const selected = tasksFor(state.selected);
  return `${heading()}${banner()}<section class="stats">${stat('今日待回忆', due.length, '个知识点', '按当前状态计算', '')}${stat('逾期待复习', overdue.length, '个知识点', '先补一次真实回忆', 'orange')}${stat('上传知识点', uploaded.length, '个知识点', '来自手动上传的资料', '')}${stat('完成复习', completed.length, '次', `已有 ${real.reviewLogCount} 条真实复习记录`, 'green')}</section>
    ${uploadStrip(d,state.selectedUpload)}${simulator(state.scenario)}
    <div class="calendar-layout"><div><section class="panel"><div class="panel-heading"><div><h2>近期回忆安排</h2><p>${date(state.start)} — ${date(shift(state.start, state.window - 1))} · ${state.selectedUpload?'关联选中的上传记录':'全部上传记录'} · 自评后更新</p></div><div class="right"><div class="segmented" aria-label="日历窗口">${[3, 7, 14].map(n => `<button data-window="${n}" class="${state.window === n ? 'active' : ''}">${n} 天</button>`).join('')}</div><button class="date-nav" data-week="-1" aria-label="前一个日期窗口">‹</button><button class="date-nav" data-week="1" aria-label="后一个日期窗口">›</button></div></div><div class="legend"><span><i class="dot green"></i>新学 / 已完成</span><span><i class="dot"></i>真实到期</span><span><i class="dot orange"></i>发现遗忘</span><span><i class="prediction-dot"></i>算法预测</span></div><div class="week" style="grid-template-columns:repeat(${Math.min(7, state.window)},minmax(0,1fr))">${week}</div><div class="selected-date"><strong>${date(state.selected)} · ${state.selected === today ? '今天' : weekdays[new Date(`${state.selected}T12:00:00Z`).getUTCDay()]}</strong><span>${selected.length} 项真实安排 <button class="button ghost small" data-today>回到今天</button></span></div>${selected.length ? selected.map((p, i) => task(p, i)).join('') : `<div class="empty"><strong>这一天，没有真实到期记录。</strong>${state.selectedUpload?'这次上传尚无此日复习安排。上方可以预览新学与遗忘的日期规则。':'真实逾期项单独列在下方；虚线日期展示算法预测。'}</div>`}${forecast.filter(f=>f.on===state.selected).map(f=>`<article class="prediction-task"><span class="prediction-dot"></span><div><strong>${escape(state.scenario.title || '本次学习内容')} · 第 ${f.number} 次复习</strong><p>${escape(f.reason)}</p></div><span class="badge prediction-badge">预测，不是完成记录</span></article>`).join('')}</section>${overdue.length ? `<section class="panel overdue"><div class="panel-heading"><div><h2>之前没来得及回忆的 <span>${overdue.length}</span></h2><p>保留原始到期日期，查看后再开始背诵。</p></div><span class="badge orange">逾期单独列出</span></div>${overdue.slice(0, 5).map((p, i) => task(p, i, true)).join('')}${overdue.length > 5 ? `<div class="pagination"><span>还有 ${overdue.length - 5} 个知识点</span><button data-all-overdue>查看全部</button></div>` : ''}</section>` : ''}</div><aside class="side-stack"><section class="note-panel"><p class="eyebrow">RECALL FIRST</p><h3>先试着回忆，<br>再翻开笔记。</h3><p>新学先安排首次回忆，遗忘先当天补一次。之后由真实自评决定间隔。</p><div class="mini-steps"><span>01 提取</span><span>→</span><span>02 背诵</span><span>→</span><span>03 自评</span></div></section><section class="panel reminder"><div class="reminder-heading"><strong>复习提醒</strong><button class="toggle ${state.reminder ? 'on' : ''}" data-reminder aria-label="${state.reminder ? '关闭' : '打开'}示例提醒开关" aria-pressed="${state.reminder}"></button></div><div class="reminder-time"><input id="reminder-time" aria-label="每日提醒时间" type="time" value="${d.reminderTime || '09:00'}"><span class="small-text muted">提醒时间</span></div><p>到期或逾期内容按北京时间每日提醒；上传、校正和预测不算完成。</p><button class="button ghost" data-algorithm>查看记忆计算规则 ↗</button></section></aside></div>`;
}

function memory() {
  const d = data();
  const current = d.sessions.filter(s => s.current), archived = d.sessions.filter(s => !s.current);
  const layers = [['current', '▤', '当前会话', '正在延续的对话', current.length], ['archive', '▧', '归档历史', '/new 后的旧会话', archived.length], ['notes', '≡', '长期备注', '明确记住的事项', d.notes.length], ['profile', '◎', '学习档案', '目标与复习偏好', 1], ['knowledge', '▥', '知识资料', '上传原文和版本', d.points.filter(p => p.origin === 'manual_upload').length], ['context', '⌘', '回复加载依据', '实际用到的记忆引用', d.contextUsage.length]];
  const names = Object.fromEntries(layers.map(l => [l[0], l[2]]));
  let content = '';
  const query = state.search.toLowerCase();
  if (['current', 'archive'].includes(state.layer)) {
    const sessions = (state.layer === 'current' ? current : archived).filter(s => state.scope === 'all' || s.scope === state.scope);
    const rows = sessions.flatMap(s => s.events.filter(e => !query || `${e.text} ${e.assistant || ''} ${e.speaker}`.toLowerCase().includes(query)).map(e => ({ ...e, session: s }))).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    content = rows.slice(state.offset, state.offset + 8).map(e => `<div class="session-header"><span class="badge ${e.session.scope === 'p2p' ? 'gray' : ''}">${scopeName(e.session.scope)}</span><span>${e.session.current ? '当前会话' : '归档会话'}</span><span class="scope-caption">${escape(e.session.id.slice(0, 8))}</span><time>${date(e.session.createdAt)} 建立${e.session.archivedAt ? ` · ${date(e.session.archivedAt)} 归档` : ''}</time></div><article class="message"><span class="message-avatar ${e.speaker === '助手' ? 'assistant' : ''}">${e.speaker === '助手' ? 'AI' : escape(e.speaker.slice(0, 1))}</span><div class="message-content"><div class="message-meta"><strong>${escape(e.speaker)}</strong><span class="badge gray">${({ inbound: '收到消息', turn: '对话记录', outbound: '助手回复', knowledge_input: '资料输入', source_photo_input: '上传图片' })[e.type] || e.type}</span><time>${date(e.at, true)}</time></div><div class="message-body">${escape(cleanMessage(e.text))}</div>${e.assistant ? `<div class="message-body" style="margin-top:12px;color:#5c887c"><strong>助手：</strong>${escape(e.assistant)}</div>` : ''}<div class="message-actions"><button data-message="${escape(e.id)}">查看完整内容 ↗</button>${e.assistant ? `<button data-message-context="${escape(e.id)}">这次回复用了什么？</button>` : ''}${e.hasImages ? '<span class="small-text muted">含图片输入</span>' : ''}</div></div></article>`).join('');
    if (!content) content = '<div class="empty"><strong>没有符合筛选条件的消息。</strong>试试切换范围或清空关键词。</div>';
    content += `<div class="pagination"><span>${rows.length ? `${Math.min(state.offset + 1, rows.length)}–${Math.min(state.offset + 8, rows.length)}` : '0'} / ${rows.length} 条记录</span><div><button data-offset="-8" ${state.offset === 0 ? 'disabled' : ''}>上一页</button> <button data-offset="8" ${state.offset + 8 >= rows.length ? 'disabled' : ''}>下一页</button></div></div><div class="info-strip">${state.layer === 'archive' ? '/new 归档保留历史，不等于删除；归档内容不会自动加入每次回复。' : '群聊和私聊分别保留。管理员可以查看全部数据，助手回复仍按会话范围加载。'}</div>`;
  } else if (state.layer === 'notes') {
    const filtered = d.notes.filter(n => (state.scope === 'all' || n.scope === state.scope) && (!query || n.text.toLowerCase().includes(query)));
    content = filtered.length ? filtered.map(n => `<article class="note-card"><h3>${scopeName(n.scope)}长期备注 <span class="badge green">有效</span></h3><p>${escape(n.text)}</p><small>来源 ${escape(n.sourceId)} · ${date(n.at, true)}</small><div class="message-actions"><button data-note="${escape(n.id)}">查看版本与来源 ↗</button></div></article>`).join('') : '<div class="empty"><strong>目前没有长期备注。</strong>羊羊明确要求记住的事项会显示在这里。</div>';
  } else if (state.layer === 'profile') {
    const p = d.profile;
    content = `<div class="profile-grid">${[['学习者', '羊羊'], ['目标', p.examGoal || '未记录'], ['学习阶段', p.studyStage === 'first_round_completed' ? '已完成第一轮复习' : p.studyStage || '未记录'], ['主要困难', (p.painPoints || []).join('、') || '未记录'], ['每日可用时间', p.dailyAvailableMinutes ? `${p.dailyAvailableMinutes} 分钟` : '未记录'], ['复习偏好', p.reminderPreference === 'non_intrusive' ? '提醒简短，少打扰' : p.reminderPreference || '未记录']].map(([label, value]) => `<div class="profile-field"><small>${label}</small><strong>${escape(value)}</strong></div>`).join('')}</div><div class="info-strip">档案值已保留。旧版字段修改历史没有采集，页面显示“未记录”。</div>`;
  } else if (state.layer === 'knowledge') {
    const points = d.points.filter(p => p.origin === 'manual_upload' && (!query || `${p.title} ${p.text}`.toLowerCase().includes(query)) && (state.scope === 'all' || p.scope === state.scope));
    content = points.map((p, i) => task(p, i)).join('') || '<div class="empty">没有符合条件的知识资料。</div>';
    const images = d.assets.filter(a => a.isImage);
    if (images.length && !query) content += uploadStrip(d,state.selectedUpload);
  } else {
    content = d.contextUsage.length ? d.contextUsage.map(c => `<div class="context-card"><h3>${escape(c.title)}</h3><span class="badge green">引用已记录</span><h4 class="small-text">实际加载</h4><ul class="loaded-list">${c.loaded.map(x => `<li>${escape(x)}</li>`).join('')}</ul><h4 class="small-text">没有加载及原因</h4><ul class="loaded-list omitted">${c.omitted.map(x => `<li>${escape(x)}</li>`).join('')}</ul></div>`).join('') : '<div class="empty"><strong>历史回复的加载依据未记录。</strong>旧系统没有保存实际上下文引用，无法准确倒推。<br>新版会从每次回复开始采集来源 ID、版本及未加载原因。<br>示例体验可查看未来的展示方式。</div>';
  }
  return `${heading()}${banner()}<div class="content-grid"><aside class="panel layers" aria-label="记忆层级">${layers.map(([key, icon, label, description, count]) => `<button class="layer-button ${state.layer === key ? 'active' : ''}" data-layer="${key}"><span>${icon}</span><span><strong>${label}</strong><small>${description}</small></span><b>${count}</b></button>`).join('')}</aside><section class="panel"><div class="panel-heading"><div><h2>${names[state.layer]}</h2><p>属于谁，来自哪里，什么时候留下。</p></div><span class="badge gray">管理者可查看全部</span></div><div class="filter-row"><div class="search-wrap"><span>⌕</span><input id="memory-search" aria-label="搜索记忆" placeholder="搜索内容、关键词…" value="${escape(state.search)}"></div><select id="scope-filter" aria-label="会话范围"><option value="all" ${state.scope === 'all' ? 'selected' : ''}>全部范围</option><option value="group" ${state.scope === 'group' ? 'selected' : ''}>群聊</option><option value="p2p" ${state.scope === 'p2p' ? 'selected' : ''}>私聊</option></select></div>${content}</section></div>`;
}

function cleanMessage(text) { try { const parsed = JSON.parse(text); return typeof parsed === 'object' && parsed?.text ? parsed.text : text; } catch { return text; } }
function uploadTimestamp(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return '上传时间未记录';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
}
function timeline(items) { return `<div class="timeline">${items.map(item => `<div class="timeline-item"><time>${date(item.at, Boolean(item.at?.includes('T')))}</time><strong>${escape(item.title)}</strong><p>${escape(item.detail || '')}</p></div>`).join('')}</div>`; }
function identity() {
  const d = data();
  return `${heading()}${banner()}<section class="identity-cards">${d.people.map(p => `<article class="panel identity-card"><div class="person-heading"><span class="avatar ${p.role === 'admin' ? 'admin-avatar' : ''}">${p.role === 'learner' ? '羊' : '管'}</span><div><h2>${escape(p.name)}</h2><span class="small-text muted">${p.role === 'learner' ? '唯一学习者 · 上传、背诵与复习' : '项目管理者 · 查看全部数据'}</span></div><span class="badge ${p.role === 'learner' ? 'green' : ''}">${roleName(p.role)}</span></div><div class="person-field"><label>绑定状态</label><span>${p.identity ? '✓ 已明确绑定' : '未记录'}</span></div><div class="person-field"><label>身份依据</label><span>${escape(p.evidence)}</span></div><div class="person-field"><label>已知称呼</label><span>${escape(p.labels.join('、') || p.name)} <span class="badge gray">称呼不授予权限</span></span></div><div class="person-field"><label>飞书账号</label><code>${escape(p.identity ? `${p.identity.slice(0, 9)}…${p.identity.slice(-5)}` : '未记录')}</code></div><div class="person-field"><label>最近识别</label><span>${p.observedAt ? date(p.observedAt, true) : '旧版未记录识别时间'}</span></div><div style="margin-top:17px"><button class="button ghost" data-person="${escape(p.id)}">查看账号与识别记录 ↗</button></div></article>`).join('')}</section><div class="identity-bottom"><section class="panel"><div class="panel-heading"><div><h2>识别与纠正时间线</h2><p>权限绑定、聊天称呼和判断依据分别展示。</p></div><span class="badge gray">${state.mode === 'real' ? '历史不补造' : '示例记录'}</span></div>${timeline(d.people.flatMap(p => p.history.map(h => ({ ...h, title: `${p.name} · ${h.title}` }))))}<div class="info-strip">${state.mode === 'real' ? '本次读取证明当前账号绑定，不代表在这个时间首次识别。历史称呼来源、绑定时间和纠正记录未采集。' : '示例展示更正前后与来源；正式实现会保留每次实际发生的变更。'}</div></section><aside class="panel permission-card"><h3>固定的项目关系</h3><p>只有羊羊和管理者。无需注册、增加学习者或切换工作空间。</p><div class="permission-list"><span>羊羊手动上传学习内容</span><span>算法安排背诵复习</span><span>管理员默认查看所有数据</span><span>自我介绍不改变账号权限</span></div><p class="footnote">群聊、私聊按范围保留；管理员有查看权限，群内回复仍不会自动带入私聊。</p></aside></div>`;
}

const tableNames = { people: '固定人员', channel_identities: '平台账号绑定', role_bindings: '角色绑定', identity_observations: '身份观察', identity_change_events: '身份修正历史', learner_profiles: '学习档案', profile_change_events: '档案修改历史', conversation_scopes: '会话范围', conversation_sessions: '当前及归档会话', conversation_events: '逐条会话事件', memory_notes: '长期备注', memory_note_versions: '备注修订', knowledge_sources: '知识来源', knowledge_revisions: '资料版本', knowledge_points: '知识点', source_pages: '资料页面', knowledge_relations: '知识关系', assets: '附件与原文文件', learning_enrollments: '进入复习的知识点', study_plan_items: '新学计划', scheduler_configs: '算法配置', review_states: '当前复习状态', learning_events: '学习与遗忘事件', review_logs: '真实复习日志', answer_attempts: '作答记录', answer_feedbacks: '答案反馈', reference_answers: '核对答案', reference_answer_versions: '答案版本', practice_sessions: '练习会话', task_completion_logs: '自报完成', processing_jobs: '图片处理任务', job_events: '任务处理事件', draft_versions: '处理草稿版本', upload_transcriptions: '可编辑上传转写', upload_transcription_versions: '转写校正版本', context_usage_events: '回复加载引用', channel_records: '渠道辅助历史', migration_inventory: '迁移对应关系', migration_metadata: '快照元信息', schema_migrations: '结构版本' };
function dataPage() {
  const r = real.report;
  const tableRows = Object.entries(r.tableCounts).map(([name, count]) => `<tr><td>${tableNames[name] || name}<br><code>${name}</code></td><td class="mono">${count}</td><td>${count ? '<span class="badge green">已整理</span>' : '<span class="badge gray">原库未记录</span>'}</td></tr>`).join('');
  const pointsRows = real.points.map(p => `<tr><td><button class="button ghost" data-point="${escape(p.id)}">${escape(p.title)} ↗</button><br><code>${escape(p.id)}</code></td><td><span class="badge">手动上传</span></td><td>${p.eligible ? kindBadge(p) : '未加入复习'}</td></tr>`).join('');
  return `${heading()}<div class="source-banner"><strong>运行中的新版数据</strong><span>原格式备份已保留，业务数据按独立表存储。</span><span>下载时间 ${date(r.capturedAt, true)}</span></div><section class="stats">${stat('保留知识点', r.tableCounts.knowledge_points, '个', '稳定 ID 沿用', '')}${stat('保留会话事件', r.tableCounts.conversation_events, '条', '当前及归档分别保留', '')}${stat('实体内容校验', r.verifiedEntities, '项', '逐条往返核验通过', 'green')}${stat('已移除旧示例', (r.removedDemoPointIds || []).length, '个', '以手动上传数据为基准', 'green')}</section><div class="data-layout"><section class="panel"><div class="panel-heading"><div><h2>新版数据清单</h2><p>独立业务表、原有 ID 与时间，按职责整理。</p></div><span class="badge green">完整性通过</span></div><div class="sub-tabs"><button class="${state.recordTab === 'points' ? 'active' : ''}" data-record-tab="points">知识点核对 · ${real.points.length}</button><button class="${state.recordTab === 'tables' ? 'active' : ''}" data-record-tab="tables">独立数据表 · ${Object.keys(r.tableCounts).length}</button><button class="${state.recordTab === 'checks' ? 'active' : ''}" data-record-tab="checks">校验结果</button></div>${state.recordTab === 'checks' ? `<div class="check-list">${r.checks.map(c => `<div class="check-row"><span class="check-icon">${c.passed ? '✓' : '!'}</span>${escape(c.name)}</div>`).join('')}</div><div class="info-strip">附件校验 ${r.assetsVerified} 份；外键错误 ${r.foreignKeyErrors.length}；数据库完整性 ${escape(r.integrityCheck)}。</div>` : `<div class="table-wrap"><table class="data-table"><thead><tr>${state.recordTab === 'points' ? '<th>知识点 / 原有 ID</th><th>来源</th><th>学习状态</th>' : '<th>数据表 / 用途</th><th>记录数</th><th>处理状态</th>'}</tr></thead><tbody>${state.recordTab === 'points' ? pointsRows : tableRows}</tbody></table></div>`}</section><aside class="side-stack"><section class="panel review-files"><h3>数据已迁移</h3><p>沿用手动上传的知识点 ID、原始上传时间和真实学习状态。</p><p>旧示例已移除。原格式数据及图片已备份到管理者本机。</p><button class="button ghost" data-report>查看迁移校验报告 ↗</button></section><section class="note-panel"><p class="eyebrow">KEEP THE HISTORY</p><h3>整理结构，<br>保留原来的事实。</h3><p>上传及遗忘记录不代表已完成复习。历史没有记下的自评、身份判断和上下文引用，保持为空。</p></section></aside></div>`;
}

function drawer(label, html) { $('#drawer-label').textContent = label; $('#detail-content').innerHTML = `<div class="detail-inner">${html}</div>`; if (!$('#detail').open) $('#detail').showModal(); }
function editUpload(id) {
  state.selectedUpload=id;
  render();
  openUploadEditor(data(),id,{
    saved: updated=>{real=updated;render();},
    preview: upload=>{state.selectedUpload=upload.id;state.scenario.enabled=true;state.scenario.title=upload.items[0]?.title||upload.title;state.scenario.kind=calendarPoints().some(p=>p.kind==='forgotten')?'forgotten':'learn';state.scenario.on=today;state.start=today;state.selected=today;state.window=14;state.page='calendar';location.hash='calendar';render();window.scrollTo(0,0);},
    toast
  });
}
function pointDetail(id) {
  const p = (state.page === 'data' ? real : data()).points.find(p => p.id === id);
  if (!p) return;
  const original = p.origin === 'legacy_unknown';
  drawer('知识点 · 来源与安排依据', `<p class="eyebrow">${original ? 'LEGACY RECORD' : 'KNOWLEDGE & RECALL'}</p><h2>${escape(p.title)}</h2>${kindBadge(p)}<div class="detail-grid"><div><label>所属范围</label><strong>${scopeName(p.scope)}</strong></div><div><label>下次到期</label><strong>${date(p.due)}</strong></div><div><label>上次真实复习</label><strong>${date(p.lastReviewedOn)}</strong></div><div><label>上次自评</label><strong>${ratingName(p.lastRating)}</strong></div><div><label>当前间隔</label><strong>${p.interval === null ? '未记录' : `${p.interval} 天`}</strong></div><div><label>资料版本</label><strong>${p.sourceVersion ? `v${p.sourceVersion}` : '未记录'}</strong></div></div><h3>为什么安排这一次？</h3><p>${original ? '这是来源不明的迁移存量。保留原内容，不自动加入羊羊的新学或复习计划。' : p.kind === 'forgotten' ? `羊羊上传资料时记录了遗忘，保留原定到期日期 ${date(p.due)}。目前没有完成复习或自评记录；下一次间隔要等真实自评后计算。` : p.kind === 'record' ? '这条内容只是记录，没有加入背诵复习。' : p.lastReviewedOn ? `上次复习 ${date(p.lastReviewedOn)}，自评「${ratingName(p.lastRating)}」，间隔 ${p.interval} 天。四档间隔算法 v1 计算本次日期。` : '当天上传内容进入学习安排；尚未完成自评，不把上传算作已完成复习。'}</p><h3>上传原文 / 保留内容</h3><div class="source-text">${escape(p.text || '原库没有正文')}</div><p class="small-text">来源：${escape(p.source)}<br>上传：${date(p.uploadedAt, true)}<br>稳定 ID：<code>${escape(p.id)}</code></p><h3>学习时间线</h3>${p.history.length ? timeline(p.history) : '<p>旧库没有学习事件记录。</p>'}<h3>这次回忆得怎么样？</h3>${state.mode === 'sample' && state.page !== 'data' && p.eligible ? `<div class="ratings">${['again', 'hard', 'good', 'easy'].map(r => `<button data-rating="${r}" data-rating-point="${escape(p.id)}">${ratingName(r)}</button>`).join('')}</div><p class="footnote">示例自评只改变本地演示，查看算法如何重新安排时间。</p>` : '<p>管理员可以校正文字；完成背诵和四档自评请由羊羊本人执行。</p><a class="button" href="/study">打开背诵与自评 ↗</a>'}`);
}
function algorithm() { drawer('记忆计算 · 四档间隔算法 v1', '<p class="eyebrow">SPACED RECALL</p><h2>按这次回忆感受，<br>决定下一次见面的时间。</h2><p>沿用当前已实现的四档间隔算法。它不是 FSRS，旧状态的历史算法版本未记录。</p><table class="data-table"><thead><tr><th>回忆感受</th><th>首次间隔</th><th>已有间隔后</th></tr></thead><tbody><tr><td>没想起来</td><td>1 天</td><td>重置为 1 天</td></tr><tr><td>很吃力</td><td>1 天</td><td>原间隔 × 1.2</td></tr><tr><td>基本掌握</td><td>3 天</td><td>原间隔 × 2.5</td></tr><tr><td>很轻松</td><td>5 天</td><td>原间隔 × 3.8</td></tr></tbody></table><h3>上传与完成分开</h3><p>拍照说明这次内容来自羊羊。发现遗忘可以加入待回忆队列，但不能生成虚构的“已经背过”或历史自评。</p><p>未来日期按当前状态预测；完成背诵并自评后，新的间隔和日期会更新。</p>'); }
function render() {
  if(['operations','review-records'].includes(state.page)){
    document.querySelectorAll('[data-page]').forEach(a=>a.classList.toggle('active',a.dataset.page===state.page));
    $('#breadcrumb').textContent='工作台 / '+(state.page==='operations'?'管理操作':'复习记录');
    mountManagementPage(state.page,{drawer,toast}).catch(e=>toast(e.message));return;
  }
  document.querySelectorAll('[data-page]').forEach(a => { a.classList.toggle('active', a.dataset.page === state.page); a.setAttribute('aria-current', a.dataset.page === state.page ? 'page' : 'false'); });
  $('#breadcrumb').textContent = `工作台 / ${titles[state.page][0]}`;
  $('#main').innerHTML = ({ calendar, memory, identity, data: dataPage })[state.page]();
  $('#footer-source').textContent = state.mode === 'sample' && state.page !== 'data' ? '示例数据 · 不写入真实学习记录' : '学习数据与飞书 Agent 同步';
}

document.addEventListener('click', event => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.uploadRecord) editUpload(target.dataset.uploadRecord);
  else if (target.dataset.uploadScroll) document.querySelector('.upload-track')?.scrollBy({left:Number(target.dataset.uploadScroll)*420,behavior:'smooth'});
  else if (target.hasAttribute('data-clear-upload')) {state.selectedUpload='';render();}
  else if (target.hasAttribute('data-toggle-prediction')) {state.scenario.enabled=!state.scenario.enabled;render();}
  else if (target.dataset.predictedDay) {state.selected=target.dataset.predictedDay;if(state.selected<state.start||state.selected>shift(state.start,state.window-1))state.start=state.selected;render();document.querySelector('.calendar-layout').scrollIntoView({block:'start',behavior:'smooth'});}
  else if (target.dataset.window) { state.window = Number(target.dataset.window); render(); }
  else if (target.dataset.week) { state.start = shift(state.start, Number(target.dataset.week) * state.window); state.selected = state.start; render(); }
  else if (target.dataset.day) { state.selected = target.dataset.day; render(); }
  else if (target.hasAttribute('data-today')) { state.start = today; state.selected = today; render(); }
  else if (target.dataset.point) pointDetail(target.dataset.point);
  else if (target.hasAttribute('data-algorithm')) algorithm();
  else if (target.hasAttribute('data-reminder')) { fetch('/api/console/reminders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!state.reminder})}).then(async r=>{if(!r.ok)throw new Error('提醒设置保存失败');const value=await r.json();state.reminder=value.enabled;render();toast(value.enabled?'每日复习提醒已开启。':'每日复习提醒已暂停。');}).catch(e=>toast(e.message)); }
  else if (target.dataset.layer) { state.layer = target.dataset.layer; state.offset = 0; state.search = ''; render(); }
  else if (target.dataset.offset) { state.offset = Math.max(0, state.offset + Number(target.dataset.offset)); render(); }
  else if (target.dataset.recordTab) { state.recordTab = target.dataset.recordTab; render(); }
  else if (target.hasAttribute('data-all-overdue')) drawer('全部逾期待复习', `<h2>先从一个知识点开始。</h2>${data().points.filter(p => p.eligible && !p.completed && p.due < today).map((p, i) => task(p, i, true)).join('')}`);
  else if (target.dataset.message || target.dataset.messageContext) {
    const id = target.dataset.message || target.dataset.messageContext;
    const session = data().sessions.find(s => s.events.some(e => e.id === id));
    const message = session?.events.find(e => e.id === id);
    if (!message) return;
    if (target.dataset.messageContext) { const usage = data().contextUsage.find(c => c.replyId === id); drawer('这次回复的实际加载依据', `<h2>${usage ? escape(usage.title) : '历史加载引用未记录'}</h2>${usage ? `<h3>实际加载</h3><ul class="loaded-list">${usage.loaded.map(x => `<li>${escape(x)}</li>`).join('')}</ul><h3>未加载及原因</h3><ul class="loaded-list omitted">${usage.omitted.map(x => `<li>${escape(x)}</li>`).join('')}</ul>` : '<p>旧系统没有采集这些引用。根据回复内容猜测来源不可靠，新版会从实际请求中保存引用和版本。</p>'}`); }
    else drawer(`${scopeName(session.scope)} · ${session.current ? '当前' : '归档'}会话`, `<h2>${escape(message.speaker)}的记录</h2><p>${date(message.at, true)} · ${escape(message.type)}</p><div class="source-text">${escape(cleanMessage(message.text))}</div>${message.assistant ? `<h3>助手回复</h3><div class="source-text">${escape(message.assistant)}</div>` : ''}<p>来源消息：<code>${escape(message.sourceEventId || '原库未记录')}</code><br>会话：<code>${escape(session.id)}</code></p>`);
  }
  else if (target.dataset.person) { const p = data().people.find(p => p.id === target.dataset.person); drawer('人员身份 · 绑定与来源', `<h2>${escape(p.name)}</h2><span class="badge">${roleName(p.role)}</span><div class="detail-grid"><div><label>权限依据</label><strong>服务器明确绑定</strong></div><div><label>最近历史识别时间</label><strong>${date(p.observedAt, true)}</strong></div></div><h3>飞书账号标识</h3><div class="source-text"><code>${escape(p.identity)}</code></div><p>应用：<code>${escape(p.appId)}</code><br>账号标识仅用于绑定身份，聊天自称不会授予权限。</p><h3>当前称呼</h3><p>${escape(p.labels.join('、') || p.name)}</p><h3>已记录的识别与纠正</h3>${timeline(p.history)}<p class="footnote">${state.mode === 'real' ? '迁移存量的称呼依据不详；读取时间不是历史首次识别时间。' : '此处是示例审计事件。'}</p>`); }
  else if (target.dataset.note) { const n = data().notes.find(n => n.id === target.dataset.note); drawer('长期备注 · 来源与版本', `<h2>明确记住的事项</h2><span class="badge green">有效 · v1</span><div class="source-text" style="margin-top:22px">${escape(n.text)}</div><p>${scopeName(n.scope)} · ${date(n.at, true)}<br>来源消息：<code>${escape(n.sourceId)}</code></p>${timeline([{ at: n.at, title: '备注 v1', detail: '来自学习者明确表达。更正或撤销会产生新版本。' }])}`); }
  else if (target.dataset.asset) drawer('保留的上传原图', `<h2>查看原始资料</h2><p><strong>原图上传时间：${escape(uploadTimestamp(target.dataset.uploadedAt))}</strong><br>北京时间 · 图片来自本机原始备份，哈希已校验。</p><img class="wide-image" src="/assets/${escape(target.dataset.asset)}" alt="上传原始资料">`);
  else if (target.hasAttribute('data-report')) drawer('迁移 · 完整校验报告', `<h2>数据处理报告</h2><p>当前运行数据使用新版独立表；此报告保留迁移时的核验结果。</p><div class="source-text"><code>${escape(JSON.stringify(real.report, null, 2))}</code></div>`);
  else if (target.hasAttribute('data-export-review')) { const payload = { status: 'local-demo-review', capturedAt: real.capturedAt, reviewedAt: new Date().toISOString(), pagesConfirmed: state.pagesConfirmed, dataConfirmed: state.dataConfirmed, sourceSha256: real.report.sourceSha256, productionChanged: false }; const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = '333-local-review-20261004.json'; a.click(); URL.revokeObjectURL(url); toast('核对记录已导出，线上未修改。'); }
});
$('#close-detail').addEventListener('click', () => $('#detail').close());
document.addEventListener('change', event => {
  if(event.target.id==='reminder-time'){fetch('/api/console/reminders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:state.reminder,time:event.target.value})}).then(async r=>{if(!r.ok)throw new Error('提醒时间保存失败');const v=await r.json();real.reminderTime=v.time;toast('提醒时间已保存（北京时间）。');}).catch(e=>toast(e.message));}

  if (['scenario-date','scenario-kind','scenario-rating'].includes(event.target.id)) {
    if(event.target.id==='scenario-date'&&event.target.value){state.scenario.on=event.target.value;state.start=event.target.value;state.selected=event.target.value;}
    if(event.target.id==='scenario-kind')state.scenario.kind=event.target.value;
    if(event.target.id==='scenario-rating')state.scenario.rating=event.target.value;
    render();
  }
  if (event.target.id === 'scope-filter') { state.scope = event.target.value; state.offset = 0; render(); }
  if (event.target.id === 'confirm-pages') state.pagesConfirmed = event.target.checked;
  if (event.target.id === 'confirm-data') state.dataConfirmed = event.target.checked;
});
document.addEventListener('input', event => {
  if (event.target.id !== 'memory-search') return;
  state.search = event.target.value; state.offset = 0;
  const cursor = event.target.selectionStart;
  render(); $('#memory-search').focus(); $('#memory-search').setSelectionRange(cursor, cursor);
});
function route() { const page = location.hash.slice(1); state.page = titles[page]||['operations','review-records'].includes(page) ? page : 'calendar'; state.offset = 0; render(); window.scrollTo(0, 0); }
window.addEventListener('hashchange', route);
try {
  const response = await fetch('/api/console');
  if(response.status===401){location.replace('/login');throw new Error('登录已过期');} if (!response.ok) throw new Error('读取失败');
  real = await response.json(); state.reminder=real.reminderEnabled; route();
} catch { $('#main').innerHTML = '<div class="empty"><strong>学习数据暂时无法读取。</strong>请稍后刷新；登录过期时重新登录。</div>'; }
