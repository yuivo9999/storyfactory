/* =========================================================
 * 影视前期提示词生成器 · 纯前端 H5
 * 仅调用 DeepSeek 生成文字与提示词；出图交给「即梦」。
 * 复用参考：show-me-the-story(逐章) / character-sheet-generator(角色卡字段)
 *          / video-shot-agent(分镜结构)
 * ========================================================= */
'use strict';

/* ---------- 全局状态 ---------- */
const KEY_CFG = 'fyp_cfg';
const KEY_STATE = 'fyp_state';

const state = {
  idea: '',
  outline: null,        // {title, logline, chapters:[{title,summary}]}
  outlineConfirmed: false,
  chapters: [],         // [{title, content, confirmed}]
  characters: [],       // [{name, role, profile:{...}, prompts:{...}}]
  scenes: [],           // [{name, 作用, description, prompt}]
  storyboard: [],       // [{镜号,景别,运镜,画面描述,对白,出图提示词,连续性锚点}]
  raw: {}               // 容错：各阶段原始返回
};
let currentStep = 1;

/* ---------- 工具函数 ---------- */
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

function toast(msg){
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._t); t._t = setTimeout(()=>t.classList.add('hidden'), 1800);
}
async function copyText(text){
  try{
    await navigator.clipboard.writeText(text);
    toast('已复制');
  }catch(e){
    // 兜底
    const ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); ta.remove(); toast('已复制');
  }
}
function esc(s){ return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function download(name, text){
  const blob = new Blob([text], {type:'text/markdown;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- 配置 ---------- */
function getCfg(){
  try{ return JSON.parse(localStorage.getItem(KEY_CFG)) || {}; }catch(e){ return {}; }
}
function saveCfg(cfg){ localStorage.setItem(KEY_CFG, JSON.stringify(cfg)); }

function loadState(){
  try{
    const s = JSON.parse(localStorage.getItem(KEY_STATE));
    if(s) Object.assign(state, s);
  }catch(e){}
}
function persist(){
  localStorage.setItem(KEY_STATE, JSON.stringify(state));
}

/* ---------- DeepSeek 调用（浏览器直连，已验证支持 CORS） ---------- */
async function callDeepSeek(system, user, {temperature=null, signal}={}){
  const cfg = getCfg();
  if(!cfg.apiKey) throw new Error('请先到 ⚙️ 填写 DeepSeek API Key');
  const base = (cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const body = {
    model: cfg.model || 'deepseek-chat',
    messages: [{role:'system', content: system}, {role:'user', content: user}],
    temperature: (temperature==null ? (cfg.temperature ?? 0.7) : temperature),
    stream: false
  };
  let res;
  try{
    res = await fetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+cfg.apiKey},
      body: JSON.stringify(body),
      signal
    });
  }catch(e){
    throw new Error('网络/跨域失败：' + e.message + '。若被拦截，可在设置里填一个代理地址。');
  }
  if(!res.ok){
    let msg = '请求失败 ('+res.status+')';
    try{ const j = await res.json(); if(j.error && j.error.message) msg = j.error.message; }catch(e){}
    throw new Error(msg);
  }
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

/* 容错 JSON 解析：去代码围栏、抽取首尾 {} 或 [] */
function parseJson(text){
  if(!text) throw new Error('模型返回为空');
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fence) t = fence[1].trim();
  try{ return JSON.parse(t); }catch(e){}
  const m = t.match(/[\{\[][\s\S]*[\}\]]/);
  if(m){ try{ return JSON.parse(m[0]); }catch(e){} }
  throw new Error('返回不是合法 JSON（已原样保留，可在导出中查看）');
}

/* 按钮忙碌态 */
function busy(btn, on, label){
  if(on){ btn._txt = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'+(label||'生成中…'); }
  else { btn.disabled = false; btn.innerHTML = btn._txt; }
}

/* =========================================================
 * 提示词模板（中文，面向国内 + 即梦）
 * ========================================================= */
const PROMPTS = {
  outlineSys: `你是一位专业编剧与故事架构师，擅长短剧/短视频叙事。根据用户的一句或几句话构想，设计一部适合改编为短视频的故事。
请严格只输出如下 JSON（不要任何解释、不要 markdown 代码块）：
{"title":"故事标题","logline":"一句话梗概（含核心冲突）","chapters":[{"title":"第1章标题","summary":"该章核心事件与转折，1-2句"}]}
要求：chapters 数量按故事体量在 6-12 章之间；标题有钩子感；summay 体现人物动机与情节推进。`,

  chapterSys: `你是一位擅长网文与短剧的编剧。请根据「故事大纲」与「本章概要」写出本章完整正文。
要求：有强画面感、对话自然、节奏明快、推进剧情；篇幅 800-1500 字；只输出正文，不要标题、不要解释。`,

  characterSys: `你是一位影视角色设定师。根据完整故事，提取主要角色（3-6 个，含主角与关键配角），为每个角色产出「影视前期定妆提示词包」，用于用户粘贴到「即梦(Dreamina)」生成角色参考图。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"characters":[{"name":"角色名","role":"身份/作用","profile":{"年龄":"","性别":"","身份":"","性格":"","外貌":"脸型/发型/瞳色/身形等","常服与配色":"","标志性道具":"","材质质感":""},
"prompts":{"定妆图":"全身定妆图提示词，需固化固定外貌特征以保证后续垫图一致性","三视图":"正面/侧面/背面描述","表情":"喜/怒/哀/惊等表情参考","服饰细节":"衣物纹样与剪裁放大","道具":"武器/饰品/随身物","配色":"主色/辅色/点缀色色板","材质":"布料/金属/皮革等质感"}}]}
要求：所有 prompts 为中文、具体、可直接粘贴即梦；『定妆图』要写清不变的身份特征；风格统一。`,

  sceneSys: `你是一位美术/场景设定师。根据故事与角色，提取关键场景（4-8 个），产出即梦出图提示词。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"scenes":[{"name":"场景名","作用":"在故事中的功能","description":"场景文字设定","prompt":"即梦出图提示词（中文，含风格/光线/氛围/构图，可直接粘贴）"}]}
要求：prompt 贴合即梦习惯，风格与整体基调一致。`,

  storyboardSys: `你是一位分镜师。根据故事、角色、场景，产出短视频分镜表。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"shots":[{"镜号":1,"景别":"近景/中景/全景等","运镜":"固定/推/拉/摇/跟等","画面描述":"本镜画面内容","对白":"台词或旁白，无则空","出图提示词":"即梦出图提示词（中文，引用对应角色定妆特征与场景以保证一致性）","连续性锚点":"本镜关联的角色/场景"}]}
要求：镜号从 1 开始连续；出图提示词可直接粘贴即梦；数量根据故事体量在 20-60 镜之间，情节点处加密。`
};

function fullStoryText(){
  return state.chapters.map(c => `【${c.title}】\n${c.content}`).join('\n\n');
}

/* =========================================================
 * 渲染：各步骤视图
 * ========================================================= */
function renderStepper(){
  const steps = [
    {n:1,t:'故事构想'},{n:2,t:'角色提示词'},{n:3,t:'场景提示词'},
    {n:4,t:'分镜文字'},{n:5,t:'导出资产包'}
  ];
  $('#stepper').innerHTML = steps.map(s=>{
    const cls = s.n===currentStep ? 'active' : (s.n<currentStep ? 'done' : '');
    return `<span class="chip ${cls}">${s.n<currentStep?'✓ ':''}${s.t}</span>`;
  }).join('');
}

function render(){
  renderStepper();
  $$('.tab').forEach(t=>t.classList.toggle('active', +t.dataset.step===currentStep));
  const v = $('#view');
  if(currentStep===1) v.innerHTML = viewStory();
  else if(currentStep===2) v.innerHTML = viewCharacters();
  else if(currentStep===3) v.innerHTML = viewScenes();
  else if(currentStep===4) v.innerHTML = viewStoryboard();
  else if(currentStep===5) v.innerHTML = viewExport();
  bindView();
}

/* ---------- P1 故事 ---------- */
function viewStory(){
  if(!state.outline){
    return `
    <div class="card">
      <h3>① 输入故事构想</h3>
      <p class="sub">用几句话描述你的点子（世界观、主角、核心冲突都行）。AI 会扩写成完整故事大纲与章节。</p>
      <textarea id="ideaInput" placeholder="例：现代都市，一个能听见别人心声的外卖员，意外卷进一起豪门遗产骗局……">${esc(state.idea)}</textarea>
      <div class="btn-row">
        <button id="btnGenOutline" class="btn primary block">✨ 生成故事大纲</button>
      </div>
      <p id="outlineStatus" class="status"></p>
    </div>`;
  }
  // 大纲已生成
  const o = state.outline;
  let html = `
    <div class="card">
      <h3>📋 故事大纲：${esc(o.title||'')}</h3>
      <p class="sub">${esc(o.logline||'')}</p>
      <div style="margin:10px 0">${ (o.chapters||[]).map((c,i)=>`<span class="pill">${i+1}. ${esc(c.title)}</span>`).join('') }</div>
      ${ state.outlineConfirmed ? `
        <div class="btn-row"><span class="pill tag-ok">✓ 大纲已确认</span></div>
        <div id="chaptersWrap"></div>
        <div class="btn-row" style="margin-top:12px">
          <button id="btnGenAllChapters" class="btn primary">⚡ 一键生成全部章节</button>
          <button id="btnReOutline" class="btn ghost">重生成大纲</button>
        </div>
        <p id="chStatus" class="status"></p>
      ` : `
        <div class="btn-row">
          <button id="btnConfirmOutline" class="btn primary">✓ 确认大纲，进入写正文</button>
          <button id="btnReOutline" class="btn ghost">重生成</button>
        </div>
      ` }
    </div>`;
  return html;
}

function renderChapters(){
  const wrap = $('#chaptersWrap'); if(!wrap) return;
  wrap.innerHTML = state.chapters.map((c,i)=>`
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3 style="margin:0">第${i+1}章 · ${esc(c.title)}</h3>
        <span class="pill ${c.confirmed?'tag-ok':'tag-warn'}">${c.confirmed?'✓ 已确认':'待确认'}</span>
      </div>
      <textarea data-ch="${i}" style="margin-top:8px">${esc(c.content)}</textarea>
      <div class="btn-row">
        <button class="btn ghost" data-regen="${i}">🔄 重生成</button>
        <button class="btn ghost" data-toggle="${i}">${c.confirmed?'↺ 取消确认':'✓ 标记已确认'}</button>
      </div>
    </div>`).join('');
}

/* ---------- P2 角色 ---------- */
function viewCharacters(){
  if(!readyForAssets()){
    return `<div class="center-empty">请先在「故事」里确认大纲并生成章节。<br>角色提示词需要基于完整故事生成。</div>`;
  }
  if(!state.characters.length){
    return `<div class="card">
      <h3>🧑 角色定妆提示词包</h3>
      <p class="sub">基于已确认故事，AI 抽取主要角色，并为每个角色产出：定妆图 / 三视图 / 表情 / 服饰 / 道具 / 配色 / 材质 共 7 组即梦提示词。</p>
      <button id="btnGenChars" class="btn primary block">✨ 生成角色定妆提示词</button>
      <p id="charStatus" class="status"></p>
    </div>`;
  }
  return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3>🧑 角色定妆提示词包（${state.characters.length}）</h3>
        <button id="btnGenChars" class="btn ghost">🔄 重生成</button>
      </div>
    </div>` + state.characters.map(charCard).join('') + fallbackRaw('characters');
}

function charCard(c){
  const pf = c.profile||{};
  const kv = Object.entries(pf).map(([k,v])=>`<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');
  const order = ['定妆图','三视图','表情','服饰细节','道具','配色','材质'];
  const pr = c.prompts||{};
  const cards = order.map(k=>pr[k]==null?'':`
    <div class="subcard">
      <div class="lbl">${esc(k)}<button class="copy" data-copy="${esc(pr[k])}">复制</button></div>
      <div class="prompt-text">${esc(pr[k])}</div>
    </div>`).join('');
  return `<div class="card">
    <h3>${esc(c.name||'未命名')} <span class="pill">${esc(c.role||'')}</span></h3>
    <div class="subcard">${kv}</div>
    ${cards}
  </div>`;
}

/* ---------- P3 场景 ---------- */
function viewScenes(){
  if(!readyForAssets()) return `<div class="center-empty">请先在「故事」里确认大纲并生成章节。</div>`;
  if(!state.scenes.length){
    return `<div class="card">
      <h3>🏞️ 场景提示词</h3>
      <p class="sub">AI 抽取关键场景，产出即梦出图提示词（含风格/光线/氛围/构图）。</p>
      <button id="btnGenScenes" class="btn primary block">✨ 生成场景提示词</button>
      <p id="sceneStatus" class="status"></p>
    </div>`;
  }
  return `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center">
      <h3>🏞️ 场景提示词（${state.scenes.length}）</h3>
      <button id="btnGenScenes" class="btn ghost">🔄 重生成</button></div></div>` +
    state.scenes.map(s=>`
    <div class="card">
      <h3>${esc(s.name||'')}</h3>
      <p class="sub">作用：${esc(s.作用||'')}</p>
      <div class="subcard"><div class="lbl">场景设定</div><div class="prompt-text">${esc(s.description||'')}</div></div>
      <div class="subcard"><div class="lbl">即梦出图提示词<button class="copy" data-copy="${esc(s.prompt||'')}">复制</button></div><div class="prompt-text">${esc(s.prompt||'')}</div></div>
    </div>`).join('') + fallbackRaw('scenes');
}

/* ---------- P4 分镜 ---------- */
function viewStoryboard(){
  if(!readyForAssets()) return `<div class="center-empty">请先在「故事」里确认大纲并生成章节。</div>`;
  if(!state.storyboard.length){
    return `<div class="card">
      <h3>🎞️ 分镜文字</h3>
      <p class="sub">AI 产出结构化分镜表：镜号 / 景别 / 运镜 / 画面描述 / 对白 / 出图提示词 / 连续性锚点。每镜的「出图提示词」可直接去即梦出图。</p>
      <button id="btnGenBoard" class="btn primary block">✨ 生成分镜文字</button>
      <p id="boardStatus" class="status"></p>
    </div>`;
  }
  const rows = state.storyboard.map(s=>`
    <div class="shot">
      <div><span class="no">镜 ${esc(s.镜号)}</span></div>
      <div class="meta"><span class="pill">${esc(s.景别||'')}</span><span class="pill">${esc(s.运镜||'')}</span></div>
      <div class="prompt-text">${esc(s.画面描述||'')}</div>
      ${ s.对白 ? `<div class="sub" style="margin-top:6px">💬 ${esc(s.对白)}</div>`:'' }
      <div class="subcard" style="margin-top:8px"><div class="lbl">出图提示词<button class="copy" data-copy="${esc(s.出图提示词||'')}">复制</button></div><div class="prompt-text">${esc(s.出图提示词||'')}</div></div>
      <div class="muted" style="margin-top:6px">🔗 ${esc(s.连续性锚点||'')}</div>
    </div>`).join('');
  return `<div class="card" style="display:flex;justify-content:space-between;align-items:center">
      <h3>🎞️ 分镜（${state.storyboard.length} 镜）</h3>
      <button id="btnGenBoard" class="btn ghost">🔄 重生成</button>
    </div>${rows}` + fallbackRaw('storyboard');
}

function fallbackRaw(key){
  const raw = state.raw[key];
  if(!raw) return '';
  return `<div class="card"><p class="muted">以下为模型原始返回（解析 JSON 失败时保留）：</p>
    <textarea style="min-height:120px">${esc(raw)}</textarea></div>`;
}

function readyForAssets(){
  return state.outlineConfirmed && state.chapters.some(c=>c.content && c.content.trim());
}

/* ---------- P5 导出 ---------- */
function viewExport(){
  if(!readyForAssets()) return `<div class="center-empty">尚无可导出的内容。请先完成故事章节。</div>`;
  const md = buildMarkdown();
  return `<div class="card">
    <h3>📦 导出资产包</h3>
    <p class="sub">汇总故事 / 角色提示词 / 场景提示词 / 分镜，复制后粘贴到文档，或下载 .md。拿着提示词去「即梦」出图做视频。</p>
    <div class="btn-row">
      <button id="btnCopyAll" class="btn primary">📋 复制全部</button>
      <button id="btnDownload" class="btn ghost">⬇️ 下载 .md</button>
    </div>
  </div>
  <div class="card"><textarea id="exportArea" style="min-height:300px">${esc(md)}</textarea></div>`;
}

function buildMarkdown(){
  const o = state.outline;
  let md = `# 影视前期资产包 · ${o?.title||'未命名'}\n\n> 由「影视前期提示词生成器」生成 · 出图请在即梦用提示词生成\n\n`;
  md += `## 一、故事大纲\n**梗概**：${o?.logline||''}\n\n`;
  (o?.chapters||[]).forEach((c,i)=> md += `${i+1}. **${c.title}** — ${c.summary}\n`);
  md += `\n## 二、章节正文\n`;
  state.chapters.forEach((c,i)=> md += `\n### 第${i+1}章 ${c.title}\n${c.content}\n`);
  if(state.characters.length){
    md += `\n## 三、角色定妆提示词包\n`;
    state.characters.forEach(c=>{
      md += `\n### ${c.name}（${c.role||''}）\n`;
      const pf=c.profile||{}; Object.entries(pf).forEach(([k,v])=> md+=`- **${k}**：${v}\n`);
      const pr=c.prompts||{}; const order=['定妆图','三视图','表情','服饰细节','道具','配色','材质'];
      order.forEach(k=>{ if(pr[k]!=null) md+=`\n**${k}提示词**：\n${pr[k]}\n`; });
    });
  }
  if(state.scenes.length){
    md += `\n## 四、场景提示词\n`;
    state.scenes.forEach(s=> md += `\n### ${s.name}（${s.作用||''}）\n- 设定：${s.description||''}\n- 即梦提示词：${s.prompt||''}\n`);
  }
  if(state.storyboard.length){
    md += `\n## 五、分镜表\n`;
    state.storyboard.forEach(s=> md += `\n**镜${s.镜号}** ｜ ${s.景别||''} ｜ ${s.运镜||''}\n- 画面：${s.画面描述||''}\n${s.对白?('- 对白：'+s.对白+'\n'):''}- 出图提示词：${s.出图提示词||''}\n- 连续性：${s.连续性锚点||''}\n`);
  }
  return md;
}

/* =========================================================
 * 事件绑定
 * ========================================================= */
function bindView(){
  // 复制按钮（事件委托）
  $$('[data-copy]').forEach(b=> b.onclick = ()=> copyText(b.getAttribute('data-copy')) );

  // P1
  const idea = $('#ideaInput'); if(idea){
    idea.oninput = ()=> state.idea = idea.value;
    $('#btnGenOutline').onclick = genOutline;
  }
  const btnCO = $('#btnConfirmOutline'); if(btnCO) btnCO.onclick = ()=>{ state.outlineConfirmed=true; persist(); render(); };
  const btnRO = $('#btnReOutline'); if(btnRO) btnRO.onclick = ()=>{ state.outline=null; state.outlineConfirmed=false; state.chapters=[]; persist(); render(); };
  const btnGA = $('#btnGenAllChapters'); if(btnGA) btnGA.onclick = genAllChapters;

  // P2
  const btnGC = $('#btnGenChars'); if(btnGC) btnGC.onclick = genCharacters;
  // P3
  const btnGS = $('#btnGenScenes'); if(btnGS) btnGS.onclick = genScenes;
  // P4
  const btnGB = $('#btnGenBoard'); if(btnGB) btnGB.onclick = genStoryboard;
  // P5
  const btnCA = $('#btnCopyAll'); if(btnCA) btnCA.onclick = ()=> copyText(buildMarkdown());
  const btnDL = $('#btnDownload'); if(btnDL) btnDL.onclick = ()=> download(`影视资产包_${state.outline?.title||'story'}.md`, buildMarkdown());

  // 章节编辑/重生成/确认（动态）
  renderChapters();
  $$('textarea[data-ch]').forEach(ta=> ta.oninput = ()=>{ state.chapters[+ta.dataset.ch].content = ta.value; persist(); });
  $$('[data-regen]').forEach(b=> b.onclick = ()=> genOneChapter(+b.dataset.regen));
  $$('[data-toggle]').forEach(b=> b.onclick = ()=>{ const i=+b.dataset.toggle; state.chapters[i].confirmed=!state.chapters[i].confirmed; persist(); render(); });
}

/* =========================================================
 * 生成动作
 * ========================================================= */
async function genOutline(){
  const btn = $('#btnGenOutline'); busy(btn,true,'生成大纲中…');
  const st = $('#outlineStatus'); st.className='status'; st.textContent='';
  state.idea = $('#ideaInput').value.trim();
  if(!state.idea){ toast('先写几句构想'); busy(btn,false); return; }
  try{
    const txt = await callDeepSeek(PROMPTS.outlineSys, '故事构想：'+state.idea);
    state.raw.outline = txt;
    const o = parseJson(txt);
    if(!o.chapters || !o.chapters.length) throw new Error('未解析到章节');
    state.outline = o; state.outlineConfirmed=false;
    state.chapters = o.chapters.map(c=>({title:c.title, content:'', confirmed:false}));
    persist(); render();
    toast('大纲已生成');
  }catch(e){
    st.className='status err'; st.textContent = e.message;
  }finally{ busy(btn,false); }
}

async function genOneChapter(i, btn){
  busy(btn,true,'生成中…');
  const o = state.outline;
  const prev = i>0 ? state.chapters[i-1].content : '';
  const user = `故事标题：${o.title}\n一句话梗概：${o.logline}\n全部章节：${o.chapters.map(c=>c.title).join(' / ')}\n\n本章标题：${state.chapters[i].title}\n本章概要：${o.chapters[i].summary}\n${prev?('上一章结尾：'+prev.slice(-200)+'…'):'（这是第一章）'}`;
  try{
    const txt = await callDeepSeek(PROMPTS.chapterSys, user);
    state.chapters[i].content = txt.trim();
    state.chapters[i].confirmed = false;
    persist(); render();
    toast('第'+(i+1)+'章完成');
  }catch(e){ toast('生成失败：'+e.message); }
  finally{ busy(btn,false); }
}

async function genAllChapters(){
  const btn = $('#btnGenAllChapters'); busy(btn,true,'逐章生成中…');
  const st = $('#chStatus'); st.className='status';
  for(let i=0;i<state.chapters.length;i++){
    if(state.chapters[i].content && state.chapters[i].confirmed) continue;
    st.textContent = `正在生成第 ${i+1}/${state.chapters.length} 章…`;
    const fakeBtn = {set innerHTML(v){}, set disabled(v){}};
    await genOneChapterNoUI(i);
  }
  st.className='status ok'; st.textContent = '全部章节已生成，请审阅并标记确认。';
  busy(btn,false); render();
}

// 无 UI 阻塞版（供循环调用）
async function genOneChapterNoUI(i){
  const o = state.outline;
  const prev = i>0 ? state.chapters[i-1].content : '';
  const user = `故事标题：${o.title}\n一句话梗概：${o.logline}\n全部章节：${o.chapters.map(c=>c.title).join(' / ')}\n\n本章标题：${state.chapters[i].title}\n本章概要：${o.chapters[i].summary}\n${prev?('上一章结尾：'+prev.slice(-200)+'…'):'（这是第一章）'}`;
  try{
    const txt = await callDeepSeek(PROMPTS.chapterSys, user);
    state.chapters[i].content = txt.trim();
    persist();
  }catch(e){ /* 继续后续 */ }
}

async function genCharacters(){
  const btn = $('#btnGenChars'); busy(btn,true,'生成角色中…');
  try{
    const txt = await callDeepSeek(PROMPTS.characterSys, '【完整故事】\n'+fullStoryText());
    state.raw.characters = txt;
    const j = parseJson(txt);
    state.characters = j.characters || [];
    persist(); render();
    toast('角色提示词已生成');
  }catch(e){
    const p = $('#charStatus'); if(p){ p.className='status err'; p.textContent=e.message; }
  }finally{ busy(btn,false); }
}

async function genScenes(){
  const btn = $('#btnGenScenes'); busy(btn,true,'生成场景中…');
  try{
    const txt = await callDeepSeek(PROMPTS.sceneSys, '【完整故事】\n'+fullStoryText());
    state.raw.scenes = txt;
    const j = parseJson(txt);
    state.scenes = j.scenes || [];
    persist(); render();
    toast('场景提示词已生成');
  }catch(e){
    const p = $('#sceneStatus'); if(p){ p.className='status err'; p.textContent=e.message; }
  }finally{ busy(btn,false); }
}

async function genStoryboard(){
  const btn = $('#btnGenBoard'); busy(btn,true,'生成分镜中…');
  try{
    const chars = state.characters.map(c=>`${c.name}(${c.role})：定妆特征-${((c.profile&&c.profile.外貌)||'')}，常服-${((c.profile&&c.profile.常服与配色)||'')}`).join('\n');
    const scenes = state.scenes.map(s=>`${s.name}：${s.description||''}`).join('\n');
    const user = `【故事】\n${fullStoryText()}\n\n【角色定妆特征】\n${chars||'（未生成角色）'}\n\n【场景】\n${scenes||'（未生成场景）'}`;
    const txt = await callDeepSeek(PROMPTS.storyboardSys, user);
    state.raw.storyboard = txt;
    const j = parseJson(txt);
    state.storyboard = j.shots || [];
    persist(); render();
    toast('分镜已生成');
  }catch(e){
    const p = $('#boardStatus'); if(p){ p.className='status err'; p.textContent=e.message; }
  }finally{ busy(btn,false); }
}

/* =========================================================
 * 设置弹窗
 * ========================================================= */
function openSettings(){ $('#settingsModal').classList.remove('hidden'); fillCfg(); }
function closeSettings(){ $('#settingsModal').classList.add('hidden'); }
function fillCfg(){
  const c = getCfg();
  $('#cfgKey').value = c.apiKey||'';
  $('#cfgBase').value = c.baseUrl||'';
  $('#cfgModel').value = c.model||'';
  $('#cfgTemp').value = (c.temperature==null?'':c.temperature);
}
function saveSettings(){
  const c = {
    apiKey: $('#cfgKey').value.trim(),
    baseUrl: $('#cfgBase').value.trim() || 'https://api.deepseek.com',
    model: $('#cfgModel').value.trim() || 'deepseek-chat',
    temperature: parseFloat($('#cfgTemp').value)
  };
  if(isNaN(c.temperature)) c.temperature = 0.7;
  saveCfg(c);
  const st = $('#cfgStatus'); st.className='status ok'; st.textContent='已保存到本机浏览器。';
  toast('配置已保存');
}
async function testConn(){
  const st = $('#cfgStatus'); st.className='status'; st.textContent='测试中…';
  const old = getCfg();
  // 临时保存后再测
  saveSettings();
  try{
    const r = await callDeepSeek('你是测试助手，只回复「ok」。','你好');
    st.className='status ok'; st.textContent='连接成功：'+r.slice(0,20);
  }catch(e){
    st.className='status err'; st.textContent='连接失败：'+e.message;
  }
}

/* =========================================================
 * 初始化
 * ========================================================= */
function init(){
  loadState();
  // 顶栏设置
  $('#btnSettings').onclick = openSettings;
  $$('[data-close]').forEach(b=> b.onclick = closeSettings);
  $('#btnCfgSave').onclick = saveSettings;
  $('#btnCfgTest').onclick = testConn;
  // 底部导航
  $$('.tab').forEach(t=> t.onclick = ()=>{ currentStep = +t.dataset.step; render(); window.scrollTo(0,0); });
  // 进入时若无 Key，自动弹设置
  const c = getCfg();
  if(!c.apiKey) setTimeout(openSettings, 300);
  render();
}
document.addEventListener('DOMContentLoaded', init);
