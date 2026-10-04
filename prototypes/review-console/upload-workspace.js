import { scheduleReview } from './scheduler.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const addDays = (day, amount) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + amount); return d.toISOString().slice(0,10); };
const names = {again:'没想起来',hard:'很吃力',good:'基本掌握',easy:'很轻松'};
const stamp = value => value ? new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value)) : '上传时间未记录';

export function uploadRecords(dataset) {
  if (dataset.uploads) return dataset.uploads;
  return dataset.points.filter(p=>!p.completed).map(p=>({id:`sample-upload:${p.id}`,title:p.title,uploadedAt:p.uploadedAt,scope:'group',version:1,status:'sample',assets:[],items:[{id:p.id,knowledgePointId:p.id,title:p.title,text:p.text}],history:[]}));
}

export function uploadStrip(dataset, selectedId='') {
  const uploads = uploadRecords(dataset).slice().sort((a,b)=>(Date.parse(b.uploadedAt)||0)-(Date.parse(a.uploadedAt)||0));
  return `<section class="panel upload-workspace"><div class="panel-heading"><div><h2>原始图片 · 上传时间线</h2><p>横向查看上传记录，打开后校正转写，再看什么时候复习。</p></div><div class="right"><span class="badge gray">${uploads.length} 次上传</span><button class="date-nav" data-upload-scroll="-1" aria-label="向前浏览上传记录">‹</button><button class="date-nav" data-upload-scroll="1" aria-label="向后浏览上传记录">›</button></div></div><div class="upload-track" aria-label="按时间排列的上传记录">${uploads.map(u=>`<article class="upload-stop ${u.id===selectedId?'selected':''}"><time datetime="${esc(u.uploadedAt||'')}">${esc(stamp(u.uploadedAt))}</time><button class="upload-record" data-upload-record="${esc(u.id)}" aria-label="打开上传记录：${esc(u.title)}"><div class="upload-photo">${u.assets.length?`<img src="/assets/${esc(u.assets[0].id)}" alt="上传原图" loading="eager">`:'<span>文字上传示例</span>'}<span class="upload-item-count">${u.items.length?`${u.items.length} 个转写知识点`:'转写未完成'}</span></div><div class="upload-record-copy"><strong>${esc(u.title)}</strong><span>${u.items.length?'查看与校正转写':'可手动补充转写'} <b>↗</b></span></div></button></article>`).join('')}</div><div class="upload-caption"><span>原始时间按北京时间展示 · 最新在左</span>${selectedId?'<button class="button ghost" data-clear-upload>取消当前记录筛选 ↗</button>':'<span>点击一条上传，连接原图、文字与复习安排。</span>'}</div></section>`;
}

export function predictions(scenario) {
  if (!scenario.enabled) return [];
  const first = scenario.kind==='learn' ? addDays(scenario.on,1) : scenario.on;
  let scheduled = {intervalDays:0}, on = first;
  const result=[{on,number:1,reason:scenario.kind==='learn'?'新学后次日首次复习':'发现遗忘，当天先重新回忆'}];
  for(let i=0;i<3;i++) {
    scheduled=scheduleReview(scheduled,scenario.rating,on);
    on=scheduled.nextReviewOn;
    result.push({on,number:i+2,interval:scheduled.intervalDays,reason:`假设上次自评「${names[scenario.rating]}」，间隔 ${scheduled.intervalDays} 天`});
  }
  return result;
}

export function simulator(scenario) {
  const forecast=predictions(scenario);
  return `<section class="panel recall-simulator"><div class="panel-heading"><div><h2>记忆算法 · 日期预览</h2><p>${scenario.title?`预览：${esc(scenario.title)}`:'把一次上传，连到后面的复习日期。'}</p></div><button class="toggle ${scenario.enabled?'on':''}" data-toggle-prediction aria-pressed="${scenario.enabled}" aria-label="${scenario.enabled?'关闭':'开启'}日期预测"></button></div><div class="sim-controls"><label>学习 / 遗忘日期<input id="scenario-date" type="date" value="${scenario.on}"></label><label>这次上传属于<select id="scenario-kind"><option value="learn" ${scenario.kind==='learn'?'selected':''}>今天新学</option><option value="forgotten" ${scenario.kind==='forgotten'?'selected':''}>以前背过，今天遗忘</option></select></label><label>假设每次复习的自评<select id="scenario-rating">${Object.entries(names).map(([key,name])=>`<option value="${key}" ${scenario.rating===key?'selected':''}>${name}</option>`).join('')}</select></label></div>${scenario.enabled?`<div class="forecast-route">${forecast.map((f,i)=>`<button data-predicted-day="${f.on}" title="${esc(f.reason)}"><small>${i===0?'首次复习':`第 ${i+1} 次复习`}</small><strong>${f.on.slice(5).replace('-',' / ')}</strong><span>${i===0?scenario.kind==='learn'?'新学后 1 天':'当天重新回忆':`再过 ${f.interval} 天`}</span></button>`).join('<span class="forecast-arrow">→</span>')}</div>`:'<div class="empty">开启预测，查看新学或遗忘后该在哪一天复习。</div>'}<p class="forecast-note">虚线日期是预测，不是已完成记录。首复后按真实自评重新计算；新学默认次日首复是本次样板新增规则。</p></section>`;
}

let editing;
function ensureEditor() {
  let dialog=document.querySelector('#upload-editor');
  if(!dialog){dialog=document.createElement('dialog');dialog.id='upload-editor';dialog.className='upload-editor';document.body.append(dialog);}
  return dialog;
}
function editorHTML(upload) {
  const points=upload.items;
  return `<form id="transcription-form"><div class="detail-top"><span>上传记录 · 原图与转写校正</span><button type="button" class="icon-button" data-close-editor aria-label="关闭上传编辑">×</button></div><div class="upload-editor-heading"><div><h2>${esc(upload.title)}</h2><p>原图上传：${esc(stamp(upload.uploadedAt))} · 当前转写 v${upload.version}</p></div><button type="button" class="button" data-preview-upload>查看这次上传的复习日历 ↗</button></div><div class="upload-editor-layout"><aside class="editor-images">${upload.assets.map(a=>`<a href="/assets/${esc(a.id)}" target="_blank" rel="noopener"><img src="/assets/${esc(a.id)}" alt="上传原图，点击放大"></a>`).join('')||'<div class="empty">文字上传示例</div>'}<p>对照原图校正识别文字。原始图片和最初转写版本都会保留。</p></aside><section class="editor-transcription"><label class="editor-title-label">这次资料的标题<input id="transcription-title" value="${esc(upload.title)}" maxlength="200" required></label><div class="editor-section-title"><strong>转写出来的知识点 <span id="transcription-count">${points.length}</span></strong><button type="button" class="button small" data-add-transcription>＋ 补充知识点</button></div><div id="transcription-items">${points.map((p,i)=>itemEditor(p,i)).join('')||'<p class="attention">这次处理尚未留下完整转写，可以直接对照原图手动补充。</p>'}</div><div class="editor-history"><strong>转写修订记录</strong>${upload.history?.length?upload.history.slice().reverse().map(h=>`<p>v${h.version} · ${h.actor==='migration-original'?'保留的初始转写':'管理员校正'} · ${stamp(h.at)}</p>`).join(''):'<p>示例内容尚未校正。</p>'}</div></section></div><div class="editor-save-bar"><p id="editor-status" role="status">${editing.dataset.mode==='real'?'保存到本机候选，刷新后仍保留；线上不变。':'此处为示例校正，不写入真实候选。'}</p><button class="button primary" id="save-transcription" type="submit">保存校正 <span>✓</span></button></div></form>`;
}
function itemEditor(point,index){return `<article class="transcription-item" data-item-index="${index}"><span class="transcription-order">${String(index+1).padStart(2,'0')}</span><div><label>知识点标题<input data-item-title value="${esc(point.title)}" maxlength="200" required></label><label>识别文字<textarea data-item-text rows="4" maxlength="30000">${esc(point.text)}</textarea></label>${point.knowledgePointId?'<small>已关联知识库；保存后同步校正对应知识点，复习日期保持不变。</small>':'<small>转写草稿，文字校正不会自动加入学习计划。</small>'}</div></article>`;}

export function openUploadEditor(dataset,id,hooks) {
  const upload=uploadRecords(dataset).find(u=>u.id===id);
  if(!upload) return;
  editing={dataset,upload:structuredClone(upload),hooks};
  const dialog=ensureEditor();dialog.innerHTML=editorHTML(editing.upload);dialog.showModal();
}
document.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button||!editing)return;
  if(button.hasAttribute('data-close-editor')) document.querySelector('#upload-editor').close();
  if(button.hasAttribute('data-preview-upload')) {document.querySelector('#upload-editor').close();editing.hooks.preview(editing.upload);}
  if(button.hasAttribute('data-add-transcription')) {
    const point={id:`manual-${crypto.randomUUID()}`,knowledgePointId:null,title:'',text:''};
    const index=editing.upload.items.push(point)-1;
    document.querySelector('#transcription-items .attention')?.remove();
    document.querySelector('#transcription-items').insertAdjacentHTML('beforeend',itemEditor(point,index));
    document.querySelector('#transcription-count').textContent=editing.upload.items.length;
    document.querySelector(`[data-item-index="${index}"] input`).focus();
  }
});
document.addEventListener('submit',async event=>{
  if(event.target.id!=='transcription-form')return;
  event.preventDefault();
  const title=document.querySelector('#transcription-title').value.trim();
  const items=[...document.querySelectorAll('.transcription-item')].map((element,index)=>({...editing.upload.items[index],title:element.querySelector('[data-item-title]').value.trim(),text:element.querySelector('[data-item-text]').value}));
  const button=document.querySelector('#save-transcription'),status=document.querySelector('#editor-status');button.disabled=true;status.textContent='正在保存校正…';
  try {
    if(editing.dataset.mode==='real') {
      const response=await fetch(`/api/uploads/${encodeURIComponent(editing.upload.id)}/corrections`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,items,expectedVersion:editing.upload.version})});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error==='version_conflict'?'此记录已更新，请重新打开后再校正。':'保存失败，请重试。');
      editing.hooks.saved(result.data);
    }else{
      for(const item of items){const point=editing.dataset.points.find(p=>p.id===item.knowledgePointId);if(point){point.title=item.title;point.text=item.text;}}
      editing.hooks.saved(editing.dataset);
    }
    document.querySelector('#upload-editor').close();editing.hooks.toast('校正已保存，复习日期保持不变。');
  }catch(error){status.textContent=error.message;}finally{button.disabled=false;}
});
