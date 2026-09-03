/* =========================================================
 * 影视前期提示词生成器 · 纯前端 H5
 * 仅调用 DeepSeek 生成文字与提示词；出图交给「即梦」。
 * 复用参考：show-me-the-story(逐章) / character-sheet-generator(角色卡字段)
 *          / video-shot-agent(分镜结构)
 * ========================================================= */
'use strict';

/* ---------- 全局状态 ---------- */
const APP_VERSION = '1.0.136';   // v1.0.136 设置新增「API Key 放请求体(api_key)」开关，规避 Authorization: Bearer，适配要求 body 传 Key 的 Cloudflare 中转
const KEY_CFG = 'fyp_cfg';

// 后台任务追踪：autoExtractGlossary / autoUpdateSubplots / extractGlossaryFromChapter 等 fire-and-forget 异步任务
// 防止用户刷新页面中断任务不知情；beforeunload 在 _bgTaskCount > 0 时给出警告
let _bgTaskCount = 0;
function startBgTask(){ _bgTaskCount++; updateBgTaskIndicator(); }
function endBgTask(){ _bgTaskCount = Math.max(0, _bgTaskCount - 1); updateBgTaskIndicator(); }
function updateBgTaskIndicator(){
  const el = $('#bgTaskIndicator');
  if(!el) return;
  if(_bgTaskCount > 0){
    el.textContent = '⏳ 后台任务 ' + _bgTaskCount + ' 项进行中…';
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}
// 页面刷新/关闭时若有后台任务未完成，弹出警告
window.addEventListener('beforeunload', e => {
  if(_bgTaskCount > 0 || state.generating){
    e.preventDefault();
    e.returnValue = '后台任务尚未完成，确定要离开吗？';
  }
});
const KEY_STATE = 'fyp_state';   // 旧版单项目 key（仅用于首次迁移）
const KEY_INDEX = 'fyp_index';   // v12 多项目历史库索引：轻量 {curId, ids, st}，驱动历史列表与恢复
const KEY_PROJ_PREFIX = 'fyp_proj_'; // v12 每个项目单独一条 localStorage 记录的前缀（fyp_proj_<id>）
const KEY_GLIB = 'fyp_glib';     // v8 词典库（跨作品的多套可复用词典，独立于项目轨道）
// v12 存储层：单条 localStorage 安全上限（浏览器约 5MB=5242880 字符，留出 key/索引余量）。
// 单部小说快照超过此阈值（约 150-200 万汉字）才自动降级 IndexedDB 单条存储。
const LS_SINGLE_SAFE = 4.5 * 1024 * 1024;
function lsKeyFor(id){ return KEY_PROJ_PREFIX + id; }
const MAX_PROJECTS = 500;         // 历史项目上限
let lib = { curId: null, items: [] }; // {curId, items:[{id, idea, outline, ..., step, title, logline, updatedAt}]}
let gglib = [];                  // v8 词典库：[{id, name, note, savedAt, g:{characters,places,propernouns}}]

const state = {
  mode: 'shortfilm',    // 'shortfilm' 短片 / 'longnovel' 经典长篇小说
  recipe: 'mesh',       // (兼容旧字段) 旧式单一范式 id；新项目用 recipeSet
  recipeSet: { rhythm:null, titleStyle:[] }, // 长篇写作范式：标题风格(可多选)；结构范式体系已移除(v11)
  wordRange: null,      // (兼容遗留) 不再作为长篇必填；保留字段避免旧快照破坏
  chapterRange: null,   // (兼容遗留) 同上
  totalWords: null,     // (兼容遗留) 同上
  chapterCount: null,   // 全书章节数量（整数 1-200，生成大纲前唯一必填数字；null=未设）
  loglineRange: {min:300, max:700},   // v11 小说简介字数范围（生成大纲前用户可调）：{min,max}，max 上限 5000，min>max 自动对调
  idea: '',
  coverPrompt: '',      // 整部小说封面提示词（场景页生成 / 长篇模式用）
  coverWithTitle: false,// 封面提示词是否包含「汉字书名」（false=纯画面无文字）
  outline: null,        // {title, logline, chapters:[{title,summary}]}
  outlineConfirmed: false,
  glossAdherence: 80,   // v11 遵从度滑条已移除：固定基准 80（尽量沿用既有命名，允许小幅调整）；留有字段兼容旧快照
  glossAllowFill: false, // v8 「允许 AI 补充」开关：低遵从时是否放行 AI 新增实体
  glossAutoFill: true,   // v8c 词典自动补全（默认开）：批量生成章节后自动提取正文中的新人物/地名/专名并入词典；关则只保留手动「📥 提取新增」
  gsCollapsed: true,    // v8b：万物词典卡片是否整卡收缩（默认收缩，点圆形展开全部）
  stCollapsed: false,   // v10.3：长篇结构设计栏是否收缩（默认展开，点击标题收起）
  cpCollapsed: true,    // v10.14：逐章方向梗概卡是否收缩（默认折叠，点击标题展开）
  ctCollapsed: true,    // v10.53：章节标题管理块是否收缩（默认折叠，点击标题展开）
  soCollapsed: false,   // v1.0.107：故事大纲卡「小说简介」是否折叠（默认展开，点标题收起）
  gsCatFold: { char:true, place:true, proper:true, sub:true },   // v10.53：词典小类别（人物/地点/专名）默认折叠，点击标题展开（v1.0.113 增副线）
  subAutoFill: true,    // v1.0.113 副线追踪开关（默认开）：每章生成后自动吸收章节正文推进到副线进度；独立于 glossAutoFill
  subRecallRatio: 0.4,  // v1.0.113 副线消失超全书比例阈值（超过则回归须 ≤20 字轻提前情）
  titleWriteBack: false, // v225/P5-C 章节标题回填已取消：标题只由「全书规划师」生成/定稿；字段保留仅为兼容旧存档读取（UI 开关已移除）
  langLayer: true,   // v1.0.129 语言分层自动调节（仅长篇生效，默认开）：书面语造氛围、口语推剧情；按题材自动定语言底色。关则不注入任何语言分层约束
  banList: null,   // v1.0.132 禁则清单（叙事中间件末位入口，默认 null=沿用内置默认清单）：{enabled, chars[], names[], phrases[], rules[], scopeAi[]}；随项目快照持久化
  useChapterPlans: true,  // v10.29：主线简述本稿是否参与正文生成（默认开）；关则保留内容与历史、仅不注入 AI
  plannerFinalized: false,  // v11：全书规划师是否已定稿全书章节标题（未定稿时正文任务行轻提示「沿用参考稿」）
  chapters: [],         // [{title, content, confirmed, editHistory:[]}]
  characters: [],       // [{name, role, profile:{...}, prompts:{...}}]
  outlineHistory: [],   // 大纲版本历史（上限10）：[{outline, ts}] 覆盖前快照，支持预览/恢复
  expSel: [],           // 长篇导出勾选的章节索引（随项目快照持久化，P3-4）
  expOpenGroups: [],    // 长篇导出章节选择：手动展开的分组序号（配合限高内滚+分组折叠，缓解超长章节列表，P5）
  hist: { characters:[], scenes:[], cover:[], storyboard:[] },  // P1-3 角色/场景/封面/分镜覆盖前快照（各上限10）
  chapterStyle: { tags: [], intensity: 2, collapsed: false, elemOpen: false },   // 写作风格（v2.0）：tags=风格id数组（多选，分 标题/梗概/章节 三组）；elemOpen=卡片内「章节风格」组是否展开（默认收拢）
  scenes: [],           // [{name, 作用, description, prompt}]
  storyboard: [],       // [{镜号,章节,时长,景别,角度,运镜,主体,构图,光线,画面描述,对白,转场,出图提示词,连续性,剪辑动机}]
  boardConcepts: [],    // 每章一条 {视觉概念, 母题}（分镜生成时随章节返回）
  titleHistory: [],     // 曾用书名记录 [{name, date}]（改名时追加，最新在前）
  raw: {}               // 容错：各阶段原始返回
};
let currentStep = 1;

/* ---------- 4.6 Plus：状态字段默认值（第 1/4 章） ---------- */
state.stCollapsed = state.stCollapsed || false;
state.scCollapsed = state.scCollapsed || false;
state.fcCollapsed = state.fcCollapsed || false;
state.rsCollapsed = state.rsCollapsed || false;
state.styleContract = state.styleContract || null;
state._scFallbackOff = !!state._scFallbackOff;   // 显式回退开关：true=清除契约后不自动回退（契约卡显示「未设定」）
state._fixQueue = state._fixQueue || [];
state._chapterPartial = state._chapterPartial || {};   // 4.8 旗舰版（板块一-3）：流式中断续写缓存
// 4.8 旗舰版（板块三）：创新核弹中间件状态
state._tensionCurve = state._tensionCurve || [];
state._personaCards = state._personaCards || {};
state._styleDNA = state._styleDNA || null;
state._styleHistory = state._styleHistory || [];   // 风格历史：每次契约/指纹变更留档
state._branchSandboxes = state._branchSandboxes || [];

/* ---------- 4.8 旗舰版：AI 协作网络状态（第 6 章 6.1） ---------- */
state.aiNetwork = state.aiNetwork || {
  stage: 'idle',          // idle / idea / recipe / outline / titles / plan / writing / review
  running: [],            // 当前正在运行的 AI kind 列表
  completed: [],          // 已完成的 AI kind 列表
  blockedBy: {}           // 每个 AI 被谁阻塞
};

/* ---------- 4.6 Plus：outline 防御归一化（第 1 章） ---------- */
function normalizeOutline(o){
  if(!o) return;
  o.structure = o.structure || { mainLine:'', subLines:[], hiddenLine:'', pivotPlan:'', acts:{} };
  o._rollingSummaries = o._rollingSummaries || [];
  o._factCard = o._factCard || { characters:{}, timeline:[], unresolvedHooks:[], lastScene:'' };
  // 4.8 旗舰版（板块三-1）：伏笔生命周期账本
  o._foreshadowLedger = o._foreshadowLedger || { planted:[], resolved:[], overdue:[] };
  if(Array.isArray(o.chapterPlans)){
    o.chapterPlans = o.chapterPlans.map(p => {
      if(typeof p === 'string') return { summary:p, beats:[], emotionalArc:'', requiredEntities:[] };
      p = p || {};
      p.beats = Array.isArray(p.beats) ? p.beats : [];
      p.requiredEntities = Array.isArray(p.requiredEntities) ? p.requiredEntities : [];
      return p;
    });
  }
}

/* 角色筛选状态 + Tom Select 实例池（render 重建前需销毁） */
let charFilters = {q:'', idents:[], gender:'', ageMin:'', ageMax:''};
let charTS = [];
function destroyCharTS(){ charTS.forEach(t=>{ try{ t.destroy(); }catch(e){} }); charTS = []; }
function parseAge(s){
  if(s==null || s==='') return null;
  const m = String(s).match(/\d+/);
  return m ? +m[0] : null;
}

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

/* ---------- 字数统计：中文按字、英文按单词，分别统计再合计（纯前端，本地算） ---------- */
const CJK_ALL = /\p{Script=Han}|[\u3000-\u303f\uff00-\uffef]/gu;
const EN_WORD = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;
function countWords(text){
  text = String(text||'');
  const cjk = (text.match(CJK_ALL)||[]).length;
  const rest = text.replace(CJK_ALL, ' ');
  const en = (rest.match(EN_WORD)||[]).length;
  return {cjk, en, total: cjk + en};
}
function wcInner(w){
  const fmt = n => n.toLocaleString('en-US');
  return `📝 <b>${fmt(w.total)}</b><i>字</i>`;
}
function wcBadge(text, attrs){
  const w = countWords(text);
  return `<span class="wc" ${attrs||''} title="中文 ${w.cjk} 字 · 英文 ${w.en} 词">${wcInner(w)}</span>`;
}

/* ---------- 配置 ---------- */
/* 多 AI 模型配置：组(groups) → 账号(keys) → 模型(models) 三层。
 * 当前「生成使用」的唯一来源 = cfg.active，绝不并发多模型请求。
 * 深度兼容旧平铺 {apiKey, baseUrl, model}：首次读取时一次性迁移。 */
let uidSeq = 1000;
let genBatchN = 2;   // v1.0.120 批量生成多章：当前步进/预设选定的章数（默认 2，等效旧「下一批 2 章」）
function remainingEmptyChapters(){ return (state.chapters||[]).filter(c=> !(c.content && String(c.content).trim())).length; }
function uid(p){ return (p||'id')+(++uidSeq)+'-'+Date.now().toString(36)+Math.random().toString(36).slice(2,8); }   // v1.0.137 fix：原仅自增序号，刷新页面后 uidSeq 重置回 1000，新增组会与历史组拿到相同 ID（如两个 g1001），导致组间串名/串 Key。现追加时间戳+随机段保证跨会话唯一；会话内自增段保留，同会话也绝不重复。旧数据中的短 ID 仅作比较用、不解析格式，完全兼容。
// v227「使用不同AI」分任务模型：任务档键清单（UI 分组渲染与 resolveActiveSpec 覆盖解析共用）。
// 档位语义与 UI 分组见《使用不同ai.md》§3.2；调用点标注映射见同文 §1.3；测试连接（恒用全局）不在清单内。
const TM_KEYS = ['chapter','outline','planSummary','planBeats','plannerTitles','plannerAux',
  'idea','titleAdvice','contentAdvice','sandbox',
  'glossary','subplot','strip','rolling','audit',
  'assets','recipe'];

function defaultModels(){ return [
  {name:'deepseek-v4-pro', label:'deepseek-v4-pro（质量最高，推荐）', kind:'pro'},
  {name:'deepseek-v4-flash', label:'deepseek-v4-flash（最快/最便宜）', kind:'flash'},
  {name:'deepseek-v4-flash-vision-exp', label:'deepseek-v4-flash-vision-exp（带视觉）', kind:'flash'}
]; }
function cfgDeepSeekGroup(){ return {id:'deepseek', kind:'openai', label:'DeepSeek 官方', baseUrl:'https://api.deepseek.com', keys:[], models:defaultModels()}; }

// 归一化 cfg：保证 groups/active 存在，迁移旧平铺配置。
function normalizeCfg(cfg){
  cfg = cfg || {};
  if(!Array.isArray(cfg.groups)){
    const g = cfgDeepSeekGroup();
    if(cfg.apiKey){            // 旧版单 Key 迁移
      const id = uid('k');
      g.keys.push({id, label:'默认账号', key:cfg.apiKey});
      cfg.active = { groupId:'deepseek', keyId:id, model: cfg.model || 'deepseek-v4-pro' };
    }
    cfg.groups = [g];
  }
  // v1.0.137 fix：存量数据自愈——旧版本已产生的重复组 ID（如两个 g1001）会让两组永远串在一起。
  // 保留每组第一个出现的 ID，其余重复组改发新 ID（active.groupId 在 find 语义下本就指向第一个匹配组，无需修正）。
  const _seenG = new Set();
  cfg.groups.forEach(gr=>{
    if(!gr.id || _seenG.has(gr.id)) gr.id = uid('g');
    _seenG.add(gr.id);
  });
  cfg.groups.forEach((gr,i)=>{
    gr.kind = gr.kind || 'openai';
    gr.baseUrl = gr.baseUrl || '';
    gr.keyInBody = !!gr.keyInBody;   // v1.0.136 Key 传递方式：true=放入请求体 api_key 字段（规避 Authorization: Bearer）
    gr.keys = (gr.keys||[]).map((k,j)=>({id: k.id||uid('k'), label: k.label||('账号'+(j+1)), key: k.key||''}));
    gr.models = (gr.models && gr.models.length) ? gr.models : defaultModels();
  });
  // active 兜底：组 → 账号 → 模型
  const act = cfg.active || {};
  const group = cfg.groups.find(g=>g.id===act.groupId) || cfg.groups[0];
  if(group){
    const key = group.keys.find(k=>k.id===act.keyId) || group.keys[0];
    const model = group.models.find(m=>m.name===act.model)
      || group.models.find(m=>m.name==='deepseek-v4-pro') || group.models[0];
    cfg.active = { groupId: group.id, keyId: key ? key.id : null, model: model ? model.name : 'deepseek-v4-pro' };
  } else {
    cfg.active = { groupId:null, keyId:null, model:'' };
  }
  // v227 分任务模型映射归一化：缺失/字段不全的三元组一律回落 ''（=跟随全局 active，旧存档零迁移）。
  // 必须存「组+账号+模型」完整三元组：只存模型名会发生拿 A 组 Key 调 B 组模型的串号事故（上方组 ID 自愈逻辑即为此类前科的遗迹）。
  const _srcTM = (cfg.taskModels && typeof cfg.taskModels === 'object') ? cfg.taskModels : {};
  const _tm = {};
  TM_KEYS.forEach(k=>{
    const v = _srcTM[k];
    _tm[k] = (v && typeof v==='object' && v.groupId && v.keyId && v.model)
      ? { groupId:String(v.groupId), keyId:String(v.keyId), model:String(v.model) } : '';
  });
  cfg.taskModels = _tm;
  return cfg;
}
function getCfg(){
  try{ return normalizeCfg(JSON.parse(localStorage.getItem(KEY_CFG)) || {}); }catch(e){ return normalizeCfg({}); }
}
function saveCfg(cfg){ localStorage.setItem(KEY_CFG, JSON.stringify(cfg)); }

// 解析「当前生成使用」的具体请求参数（来源唯一，组→账号→模型）。
// v227 分任务模型：传入 taskKey 且 cfg.taskModels[taskKey] 为完整三元组时按任务覆盖（组仍存在才生效，否则回落全局）；
// 不传参 = 现状全局行为，30 个既有调用点未标注 taskKey 时与 v226 逐字节一致（回归红线）。
function resolveActiveSpec(taskKey){
  const cfg = getCfg();
  const act = cfg.active || {};
  let group = cfg.groups.find(g=>g.id===act.groupId) || cfg.groups[0] || {};
  let key = (group.keys||[]).find(k=>k.id===act.keyId) || (group.keys||[])[0] || {};
  let model = (group.models||[]).find(m=>m.name===act.model) || (group.models||[])[0] || {};
  // 覆盖解析：温度字段不受影响——模型与温度正交，分任务温度照常生效
  const _tm = taskKey ? (cfg.taskModels||{})[taskKey] : null;
  let _overridden = false;
  if(_tm){
    const tg = cfg.groups.find(g=>g.id===_tm.groupId);
    if(tg){
      const tk = (tg.keys||[]).find(k=>k.id===_tm.keyId) || (tg.keys||[])[0] || {};
      const tmod = (tg.models||[]).find(m=>m.name===_tm.model) || (tg.models||[])[0] || {};
      group = tg; key = tk; model = tmod; _overridden = true;
    }
  }
  return {
    taskKey: taskKey || '',   // v227 请求日志归因用
    taskOverride: _overridden,   // v227 true=本次请求被分任务映射覆盖（日志标注「🎯分任务」）
    groupId: group.id, groupLabel: group.label,
    keyId: key.id, keyLabel: key.label,
    baseUrl: (group.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, ''),
    apiKey: key.key || '',
    keyInBody: !!group.keyInBody,   // v1.0.136 传递方式：请求体 api_key（规避 Bearer 头）
    model: model.name || 'deepseek-v4-pro',
    temperature: (cfg.temperature==null ? 0.7 : cfg.temperature),
    outlineTemp: (cfg.outlineTemp==null ? 0.7 : cfg.outlineTemp),   // v10.8 分任务温度：大纲
    ideaTemp:    (cfg.ideaTemp==null ? 0.5 : cfg.ideaTemp),          // v10.13 分任务温度：优化构想
    titleTemp:   (cfg.titleTemp==null ? 0.5 : cfg.titleTemp),        // v10.15 分任务温度：标题 AI
    chapterTemp: (cfg.chapterTemp==null ? 0.5 : cfg.chapterTemp),   // v10.8 分任务温度：章节
    qcTemp:      (cfg.qcTemp==null ? 0.2 : cfg.qcTemp),              // 分任务温度：词库提取（严谨低温）
    planTemp:    (cfg.planTemp==null ? 0.4 : cfg.planTemp),          // v10.11 分任务温度：主线简述
    stripTemp:   (cfg.stripTemp==null ? 1.0 : cfg.stripTemp)          // v1.0.115 分任务温度：本章梗概（速读，创作温度偏高）
  };
}
function currentSpecLabel(){
  const s = resolveActiveSpec();
  const model = s.model.replace('deepseek-v4-','').split('-')[0]; // v4-pro → pro
  return (s.groupLabel||'AI') + ' · ' + (s.keyLabel||'默认') + ' · ' + model;
}
// 当前所选模型是否支持流式：DeepSeek / 火山引擎 Doubao 启用流式进度反馈，其他 AI 不反馈。
function currentIsDeepSeek(){
  const s = resolveActiveSpec();
  return /deepseek/i.test(s.model||'') || /deepseek/i.test(s.groupId||'')
      || /doubao/i.test(s.model||'') || /doubao/i.test(s.groupId||'');
}

/* ---------- 主题切换（单页内深色 / 3D 黑板 / 热血 FC） ---------- */
const THEMES = ['dark','light','blackboard','mecha','cyber','guofeng','aurora','paper'];
function applyTheme(theme){
  if(THEMES.indexOf(theme) < 0) theme = 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  const c = getCfg(); c.theme = theme; saveCfg(c);
  // 黑板主题为纯 CSS 实现（不再依赖 blackboard3d.js / three.js），此处无需任何 JS 初始化
  // 机甲主题顶部胶囊导航显隐
  const mtn = $('#mechaTopNav');
  if(mtn) mtn.classList.toggle('hidden', theme !== 'mecha');
  // 机甲背景图类
  document.body.classList.toggle('has-mecha-bg', theme === 'mecha');
  // 赛博朋克背景图类（手柄底座已内嵌 viewStory，不必单独显隐）
  document.body.classList.toggle('has-cyber-bg', theme === 'cyber');
  // 古风国潮背景图类
  document.body.classList.toggle('has-guofeng-bg', theme === 'guofeng');
  $$('.theme-btns .theme').forEach(b=> b.classList.toggle('active', b.dataset.theme === theme));
  updateMechaNav();
  updateWcTotal(); // 主题切换后刷新内嵌总字数
}
function restartCascade(){
  // 黑板主题下，每次切换步骤重放“拉下新黑板”级联动画（纯 CSS）
  if(document.documentElement.getAttribute('data-theme') !== 'blackboard') return;
  const v = $('#view'); if(!v) return;
  v.style.animation = 'none'; void v.offsetWidth; v.style.animation = '';
}

/* =========================================================
 * 多项目历史库：fyp_state（单项目）→ fyp_lib（最多 50 个项目）
 * ========================================================= */
function makeId(){ return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

// 从当前 state 捕获一个项目快照（含步骤，供切换恢复）
function projectSnapshot(){
  return {
    mode: state.mode || 'shortfilm',
    recipe: state.recipe || 'mesh',
    recipeSet: state.recipeSet || { rhythm:null, titleStyle:[] },
    wordRange: state.wordRange || null,
    chapterRange: state.chapterRange || null,
    totalWords: state.totalWords || null,
    chapterCount: (state.chapterCount && +state.chapterCount>0) ? +state.chapterCount : null,
    idea: state.idea,
    coverPrompt: state.coverPrompt,
    coverWithTitle: state.coverWithTitle,
    outline: state.outline,
    outlineConfirmed: state.outlineConfirmed,
    glossAdherence: state.glossAdherence,
    glossAllowFill: state.glossAllowFill,
    glossAutoFill: state.glossAutoFill,
    glossSeenTs: Number(state._glossSeenTs) || 0,   // v226/8.2 词典「🆕 新增」已读水位线（随项目持久化）
    langLayer: (typeof state.langLayer === 'boolean') ? state.langLayer : true,   // v1.0.129 语言分层开关随项目持久化
    banList: (state.banList && typeof state.banList === 'object') ? normalizeBanList(state.banList) : null,   // v1.0.132 禁则清单随项目持久化（null=未自定义）
    gsCollapsed: state.gsCollapsed,
    stCollapsed: state.stCollapsed,
    cpCollapsed: state.cpCollapsed,   // v10.14 梗概卡折叠透传
    soCollapsed: !!state.soCollapsed,
    useChapterPlans: true,   // v10.29 恒参与生成（开关已移除，主线简述始终注入）
    plannerFinalized: !!state.plannerFinalized,   // 4.5 规划师定稿标记（genChapterPlans 分批版写入）
    expOpenGroups: state.expOpenGroups,   // P5 长篇导出分组折叠所展开的分组透传
    polishOptions: state.polishOptions,   // v10.16 优化构想保留方案透传
    polishAdopted: state.polishAdopted,   // v10.16 当前采用的方案名
    polishHistory: state.polishHistory,   // v10.16 优化构想批量版本（≤5）透传
    chapters: state.chapters,
    characters: state.characters,
    ctAdviceHist: Array.isArray(state.ctAdviceHist) ? state.ctAdviceHist : [],   // v10.59 章节标题 AI 建议快照
    contentAdviceHist: Array.isArray(state.contentAdviceHist) ? state.contentAdviceHist : [],   // v10.59 章节内容 AI 建议快照
    outlineHistory: state.outlineHistory,
    expSel: Array.isArray(state.expSel) ? state.expSel : [],
    hist: state.hist || { characters:[], scenes:[], cover:[], storyboard:[] },
    chapterStyle: state.chapterStyle || { tags: [], intensity: 2, collapsed: false },
    styleContract: state.styleContract || null,   // 4.5 风格契约（配方助手/风格指纹产出，正文 L0 注入）
    scCollapsed: !!state.scCollapsed,   // 4.6 Plus 风格契约卡折叠
    scFallbackOff: !!state._scFallbackOff,   // 显式回退开关持久化
    fcCollapsed: !!state.fcCollapsed,   // 4.6 Plus 事实看板卡折叠
    rsCollapsed: !!state.rsCollapsed,   // 4.6 Plus 滚动摘要卡折叠
    _fixQueue: Array.isArray(state._fixQueue) ? state._fixQueue : [],   // 4.6 Plus 正文修复队列
    aiNetwork: state.aiNetwork || { stage:'idle', running:[], completed:[], blockedBy:{} },   // 4.8 旗舰版 AI 协作网络（刷新不丢）
    _lastPolishBrief: state._lastPolishBrief || null,   // 4.7 Pro 优化构想结构化简报（供大纲 AI 经 formatNavBeaconForOutline 注入）
    _chapterPartial: state._chapterPartial || {},   // 4.8 旗舰版（板块一-3）：流式中断续写缓存（刷新不丢）
    _tensionCurve: state._tensionCurve || [],   // 4.8 旗舰版（板块三-3）：张力曲线
    _personaCards: state._personaCards || {},   // 4.8 旗舰版（板块三-2）：人设一致性防火墙
    _styleDNA: state._styleDNA || null,   // 4.8 旗舰版（板块三-4）：风格 DNA
    _styleHistory: Array.isArray(state._styleHistory) ? state._styleHistory : [],   // 风格历史快照
    _branchSandboxes: state._branchSandboxes || [],   // 4.8 旗舰版（板块三-5）：分支沙盘
    scenes: state.scenes,
    storyboard: state.storyboard,
    boardConcepts: state.boardConcepts,
    raw: state.raw,
    titleHistory: state.titleHistory,
    step: currentStep,
    title: (state.outline && state.outline.title) || (state.idea ? state.idea.trim().slice(0,20) : '未命名作品'),
    logline: (state.outline && state.outline.logline) || '',
    _lastCpRaw: state._lastCpRaw || '',
    _lastTitlesRaw: state._lastTitlesRaw || '',
    _lastChapterRaw: state._lastChapterRaw || {}
  };
}
// 把项目快照写入当前 state；内容缺失/损坏时切到空白但保持调用方可控
function applyProject(p){
  state.mode = (p.mode === 'longnovel') ? 'longnovel' : 'shortfilm';
  state.recipe = p.recipe || 'mesh';
  state.recipeSet = migrateRecipeSet(p.recipeSet, p.recipe);
  state.wordRange = (p.wordRange && p.wordRange.min && p.wordRange.max) ? {min:+p.wordRange.min, max:+p.wordRange.max} : (p.chapterRange ? null : null);
  state.chapterRange = (p.chapterRange && p.chapterRange.min && p.chapterRange.max) ? {min:+p.chapterRange.min, max:+p.chapterRange.max} : null;
  state.totalWords = (p.totalWords && +p.totalWords>0) ? +p.totalWords : null;
  state.chapterCount = (p.chapterCount && +p.chapterCount>0) ? +p.chapterCount : null;
  state.idea = p.idea || '';
  state.coverPrompt = p.coverPrompt || '';
  state.coverWithTitle = !!p.coverWithTitle;
  state.outline = p.outline || null;
  state.outlineConfirmed = !!p.outlineConfirmed;
  state.glossAdherence = (typeof p.glossAdherence === 'number') ? p.glossAdherence : 60;
  state.glossAllowFill = !!p.glossAllowFill;
  state.glossAutoFill = (typeof p.glossAutoFill === 'boolean') ? p.glossAutoFill : true;
  state._glossSeenTs = Number(p.glossSeenTs) || 0;   // v226/8.2 已读水位线恢复（旧存档缺省 0；旧词条无 _srcTs 恒不标新，兼容）
  state.langLayer = (typeof p.langLayer === 'boolean') ? p.langLayer : true;   // v1.0.129 语言分层开关恢复（旧项目缺省开）
  state.banList = (p.banList && typeof p.banList === 'object') ? normalizeBanList(p.banList) : null;   // v1.0.132 禁则清单恢复（旧项目缺省 null=内置默认）
  state.gsCollapsed = (typeof p.gsCollapsed === 'boolean') ? p.gsCollapsed : true;
  state.stCollapsed = !!p.stCollapsed;
  state.cpCollapsed = (typeof p.cpCollapsed === 'boolean') ? p.cpCollapsed : true;   // v10.14 梗概卡默认折叠
  state.soCollapsed = !!p.soCollapsed;
  state.useChapterPlans = true;   // v10.29 恒参与生成（开关已移除，主线简述始终注入）
  state.plannerFinalized = (typeof p.plannerFinalized === 'boolean') ? p.plannerFinalized : false;   // v11 标题定稿标记（旧项目默认未定稿）
  state.expOpenGroups = Array.isArray(p.expOpenGroups) ? p.expOpenGroups : [];   // P5 长篇导出分组折叠所展开的分组
  state.polishOptions = Array.isArray(p.polishOptions) ? p.polishOptions : undefined;   // v10.16 保留方案
  state.polishAdopted = (typeof p.polishAdopted === 'string') ? p.polishAdopted : undefined;
  state.polishHistory = Array.isArray(p.polishHistory) ? p.polishHistory : undefined;   // v10.16 优化构想批量版本
  state.chapters = p.chapters || [];
  // v10.60 去除质检：加载即从旧快照剥离已无用的 qcRecord 与标题 titleQC，避免残留数据
  (state.chapters||[]).forEach(c=>{ if(c) delete c.qcRecord; });
  if(state.outline) delete state.outline.titleQC;
  // v11 移除结构范式体系：加载即剥离旧快照残留的章节卷归属，避免脏数据污染。
  // 4.5：structure（三幕结构骨架）由新版大纲 AI 产出并传递给标题/规划师 AI，不再剥离。
  (state.chapters||[]).forEach(c=>{ if(c){ delete c.volume; delete c.volumeTheme; } });
  if(state.outline){ delete state.outline.volumes; delete state.outline._volumes; }
  state.styleContract = (p.styleContract && typeof p.styleContract === 'object') ? p.styleContract : null;   // 4.5 风格契约恢复
  state._scFallbackOff = !!p.scFallbackOff;   // 显式回退开关恢复
  state.characters = p.characters || [];
  state.ctAdviceHist = Array.isArray(p.ctAdviceHist) ? p.ctAdviceHist : [];   // v10.59 老项目缺省空
  state.contentAdviceHist = Array.isArray(p.contentAdviceHist) ? p.contentAdviceHist : [];   // v10.59 老项目缺省空
  state.outlineHistory = Array.isArray(p.outlineHistory) ? p.outlineHistory : [];
  state.expSel = Array.isArray(p.expSel) ? p.expSel.filter(i=> Number.isInteger(i)) : [];
  state.hist = (p.hist && typeof p.hist === 'object') ? {
    characters: Array.isArray(p.hist.characters)?p.hist.characters:[],
    scenes: Array.isArray(p.hist.scenes)?p.hist.scenes:[],
    cover: Array.isArray(p.hist.cover)?p.hist.cover:[],
    storyboard: Array.isArray(p.hist.storyboard)?p.hist.storyboard:[]
  } : { characters:[], scenes:[], cover:[], storyboard:[] };
  state.chapterStyle = (p.chapterStyle && typeof p.chapterStyle === 'object')
    ? { tags: Array.isArray(p.chapterStyle.tags)?p.chapterStyle.tags:[], intensity: (p.chapterStyle.intensity===1||p.chapterStyle.intensity===3)?p.chapterStyle.intensity:2, collapsed: !!p.chapterStyle.collapsed, elemOpen: p.chapterStyle.elemOpen === true }
    : { tags: [], intensity: 2, collapsed: false, elemOpen: false };
  wsDraft = null;   // v2.1 切作品后草稿重置（以新作品的生效配置为起点）
  state.scenes = p.scenes || [];
  state.storyboard = p.storyboard || [];
  state.boardConcepts = p.boardConcepts || [];
  state._lastCpRaw = p._lastCpRaw || '';
  state._lastTitlesRaw = p._lastTitlesRaw || '';
  state._lastChapterRaw = (p._lastChapterRaw && typeof p._lastChapterRaw === 'object') ? p._lastChapterRaw : {};
  state.titleHistory = Array.isArray(p.titleHistory) ? p.titleHistory : [];
  state.raw = p.raw || {};
  currentStep = (p.step && p.step >= 1 && p.step <= 5) ? p.step : 1;
  // 4.6 Plus：新字段随项目还原（第 4 章「与持久化」）+ outline 防御归一化（第 1 章调用点：还原项目后）
  state.scCollapsed = !!p.scCollapsed;
  state.fcCollapsed = !!p.fcCollapsed;
  state.rsCollapsed = !!p.rsCollapsed;
  state._fixQueue = Array.isArray(p._fixQueue) ? p._fixQueue : [];
  state.aiNetwork = (p.aiNetwork && typeof p.aiNetwork === 'object') ? p.aiNetwork : { stage:'idle', running:[], completed:[], blockedBy:{} };   // 4.8 旗舰版 AI 协作网络恢复
  state._lastPolishBrief = (p._lastPolishBrief && typeof p._lastPolishBrief === 'object') ? p._lastPolishBrief : null;   // 4.7 Pro 优化构想简报恢复
  state._chapterPartial = (p._chapterPartial && typeof p._chapterPartial === 'object') ? p._chapterPartial : {};   // 4.8 旗舰版（板块一-3）：流式中断续写缓存恢复
  // 4.8 旗舰版（板块三）：创新核弹中间件恢复
  state._tensionCurve = Array.isArray(p._tensionCurve) ? p._tensionCurve : [];
  state._personaCards = (p._personaCards && typeof p._personaCards === 'object') ? p._personaCards : {};
  state._styleDNA = (p._styleDNA && typeof p._styleDNA === 'object') ? p._styleDNA : null;
  state._styleHistory = Array.isArray(p._styleHistory) ? p._styleHistory : [];   // 风格历史恢复
  state._branchSandboxes = Array.isArray(p._branchSandboxes) ? p._branchSandboxes : [];
  normalizeOutline(state.outline);
}
function clearState(){
  state.mode = 'shortfilm';
  state.recipe = 'mesh';
  state.recipeSet = { rhythm:null, titleStyle:[] };
  state.wordRange = null; state.chapterRange = null; state.totalWords = null; state.chapterCount = null;
  state.idea = ''; state.outline = null; state.coverPrompt = ''; state.coverWithTitle = false; state.outlineConfirmed = false;
  state.glossAdherence = 60; state.glossAllowFill = false; state.glossAutoFill = true; state.gsCollapsed = true;
  state.langLayer = true;   // v1.0.129 语言分层开关：新建作品默认开（仅长篇生效）
  state.banList = null;   // v1.0.132 禁则清单：新建作品缺省用内置默认（无需修改数据）
  state.useChapterPlans = true;  // v10.29 新建作品默认参与生成
  state.chapters = []; state.characters = []; state.scenes = []; state.storyboard = []; state.boardConcepts = []; state.titleHistory = []; state.raw = {};
  state.ctAdviceHist = []; state.contentAdviceHist = [];   // v10.59 随项目的 AI 建议快照（章节标题 / 章节内容）
  state.outlineHistory = []; state.expSel = [];
  state.hist = { characters:[], scenes:[], cover:[], storyboard:[] };
  state.chapterStyle = { tags: [], intensity: 2, collapsed: false, elemOpen: false };
  state.styleContract = null;   // 4.5 风格契约重置
  state.scCollapsed = false; state.fcCollapsed = false; state.rsCollapsed = false;   // 4.6 Plus 折叠态重置
  state._fixQueue = [];   // 4.6 Plus 修复队列重置
  state._lastPolishBrief = null;   // 4.7 Pro 优化构想简报重置
  state._chapterPartial = {};   // 4.8 旗舰版（板块一-3）：流式中断续写缓存重置
  state.aiNetwork = { stage:'idle', running:[], completed:[], blockedBy:{} };   // 4.8 旗舰版 AI 协作网络重置
  // 4.8 旗舰版（板块三）：创新核弹中间件重置
  state._tensionCurve = [];
  state._personaCards = {};
  state._styleDNA = null;
  state._styleHistory = [];   // 风格历史重置
  state._branchSandboxes = [];
  state._lastCpRaw = '';
  state._lastTitlesRaw = '';
  state._lastChapterRaw = {};
  wsDraft = null;   // v2.1 新项目草稿重置
  currentStep = 1;
}
// 兼容旧版单一范式 → 三维 recipeSet
function migrateRecipeSet(set, legacyRecipe){
  // 新格式：set 存在即按新格式处理（rhythm 为 null 也是合法新格式值，表示未选）；结构范式已移除(v11)
  if(set && typeof set === 'object'){
    return {
      rhythm: (typeof set.rhythm === 'string' && RHYTHM_IDS.includes(set.rhythm)) ? set.rhythm : null,
      titleStyle: Array.isArray(set.titleStyle) ? set.titleStyle.filter(id=> TITLE_STYLE_IDS.includes(id)) : []
    };
  }
  // 旧 recipe 单一 id 迁移（仅保留节奏；结构/分层等范式已废弃 v11）
  const legacyMap = { web:{rhythm:'web'}, web100:{rhythm:'web'} };
  return legacyMap[legacyRecipe] || { rhythm:null };
}
// ============ 存储层 v12：每项目一条 localStorage，超限单条自动降级 IndexedDB ============
// 设计（保持内存模型 lib={curId,items} 不变，仅换落盘/加载通道，调用方无需改动）：
//   - 索引 KEY_INDEX：轻量 {curId, ids, st}，驱动历史列表与恢复，始终写 localStorage
//   - 每项目单独一条 localStorage：fyp_proj_<id> = 项目完整快照（快、同步、无 IDB 后台开销）
//   - 单条超限（QuotaExceededError / >LS_SINGLE_SAFE）时该项目自动降级为 IDB 单条（idbPut），索引标 st=idb
//   - 不再使用旧版"全库 clear + 全量重写"（idbPutAll），只写变更项目，避免后台慢与关窗丢写
//   - 不再兼容/读取旧版 fyp_lib 与旧 IDB 全库数据（按需求，全新存储层开始）
// 写入单个项目记录：优先 localStorage 单条；失败则降级 IDB 单条，并移除可能残留的 localStorage 旧版
function writeOneProjectRecord(p){
  if(!p || !p.id) return 'ls';
  try{
    const s = JSON.stringify(p);
    if(s && s.length > LS_SINGLE_SAFE) throw new Error('over-ls-limit');
    localStorage.setItem(lsKeyFor(p.id), s);
    return 'ls';
  }catch(e){
    // localStorage 放不下（单条超限或配额满）：降级写 IDB 单条
    try{ idbPut(p).catch(function(){}); }catch(e2){}
    try{ localStorage.removeItem(lsKeyFor(p.id)); }catch(e3){}   // 清掉旧的 localStorage 版，避免读到旧数据
    return 'idb';
  }
}
// 删除单个项目记录（localStorage + 可能的 IDB 降级副本）
function removeOneProjectRecord(id, wasSt){
  try{ localStorage.removeItem(lsKeyFor(id)); }catch(e){}
  if(wasSt === 'idb' || wasSt == null){ try{ idbDelete(id).catch(function(){}); }catch(e){} }
}
// 落盘：同步写索引 + 只写「当前项目 / 新增项目」，历史未变更项目不动；清理已删除项目。
function idbSaveLib(){
  const ids = new Set(lib.items.map(i=> i.id));
  // 读取旧索引，复用已有项目的存储位置（避免重写历史项目）
  let oldIdx = null;
  try{ oldIdx = JSON.parse(localStorage.getItem(KEY_INDEX)); }catch(e){}
  const oldSt = (oldIdx && oldIdx.st && typeof oldIdx.st === 'object') ? oldIdx.st : {};
  const oldIds = (oldIdx && Array.isArray(oldIdx.ids)) ? oldIdx.ids : [];
  // 1) 写当前项目 + 新增项目；历史未变更项目沿用原存储位置
  const st = {};
  for(const p of lib.items){
    const isNew = !oldIds.includes(p.id);
    if(p.id === lib.curId || isNew){
      st[p.id] = writeOneProjectRecord(p);
    }else{
      st[p.id] = oldSt[p.id] || 'ls';
    }
  }
  // 2) 清理已删除/被淘汰项目（索引存在、内存已无 → 删除存储记录）
  for(const oldId of oldIds){
    if(!ids.has(oldId)) removeOneProjectRecord(oldId, oldSt[oldId]);
  }
  // 3) 写索引
  const idx = { curId: lib.curId, ids: lib.items.map(i=> i.id), st };
  try{ localStorage.setItem(KEY_INDEX, JSON.stringify(idx)); }catch(e){}
}
function saveLib(){
  idbSaveLib();   // 同步写 localStorage（降级项目异步写 IDB）
}
function robustSaveLib(){
  // 超过上限则淘汰最旧非当前项目；已删除项的存储记录由 idbSaveLib 按索引统一清理
  while(lib.items.length > MAX_PROJECTS){
    const others = lib.items.filter(i=> i.id !== lib.curId);
    if(!others.length) break;
    others.sort((a,b)=> (a.updatedAt||0) - (b.updatedAt||0));
    lib.items = lib.items.filter(i=> i.id !== others[0].id);
  }
  idbSaveLib();
}
// 首次加载（异步）：读索引 fyp_index → 逐项目读取（localStorage 单条 / 降级 IDB 单条）。
// 忽略旧版 fyp_lib 与旧 IDB 全库数据（存储层 v12 全新开始，按需求不兼容旧 IDB）。
async function loadState(){
  clearState();
  // 1) 读索引
  let idx = null;
  try{ idx = JSON.parse(localStorage.getItem(KEY_INDEX)); }catch(e){}
  const ids = (idx && Array.isArray(idx.ids)) ? idx.ids : [];
  const stMap = (idx && idx.st && typeof idx.st === 'object') ? idx.st : {};
  const curId = (idx && idx.curId) || null;
  // 2) 逐项目读取
  const items = [];
  for(const id of ids){
    try{
      let p = null;
      if(stMap[id] === 'idb'){
        if(idbAvailable()) p = await idbGet(id);   // 降级项目从 IDB 单条读
      }else{
        const raw = localStorage.getItem(lsKeyFor(id));
        if(raw){ try{ p = JSON.parse(raw); }catch(e){ p = null; } }
      }
      if(p && typeof p === 'object' && p.id) items.push(p);
    }catch(e){ /* 单条损坏/缺失则跳过，不影响其余项目 */ }
  }
  // 3) 恢复
  if(items.length){
    lib = { curId: curId, items: items };
    // 保持 curId 有效
    if(!lib.items.some(i=> i.id === lib.curId)) lib.curId = lib.items[0].id;
    const cur = lib.items.find(i=> i.id === lib.curId);
    if(cur) applyProject(cur);
    return;
  }
  // 4) 全新无索引：先尝试一次性迁移旧版多项目库（fyp_lib / 旧 IDB 全库），再尝试旧版单项目 fyp_state
  if(await migrateLegacyLibrary()) return;
  migrateOldState();
}
// v1.0.130 一次性迁移旧版多项目数据到新通道（仅当新索引为空时触发；成功后正式关闭旧通道）。
// 迁移源：A) localStorage 旧键 fyp_lib（旧版多项目快照数组）; B) 旧 IDB 全库 projects store（idbList）。
// 目标：写入新索引 fyp_index + 每项目单条 fyp_proj_<id>（超限项目复用 st=idb 单条）。
// 返回 true 表示已迁移到至少一个项目并加载；调用方凭此短路后续逻辑。
async function migrateLegacyLibrary(){
  let legacy = [];
  // A) localStorage 旧键 fyp_lib：旧版为 {items:[], curId} 或直接数组，逐个取其（含每个项目自身 id）
  try{
    const raw = localStorage.getItem('fyp_lib');
    if(raw){
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items)) ? parsed.items : null;
      const curId = (!Array.isArray(parsed) && parsed && parsed.curId) ? parsed.curId : null;
      if(Array.isArray(arr)) legacy = legacy.concat(arr.filter(x=> x && typeof x === 'object' && x.id));
      if(curId && !legacy.some(x=> x.id === curId)){ /* 找不到 curId 归属，忽略 */ }
    }
  }catch(e){}
  // B) 旧 IDB 全库 projects store：idbList 返回整库快照数组
  try{
    if(idbAvailable() && typeof idbList === 'function'){
      const list = await idbList();
      if(Array.isArray(list)) legacy = legacy.concat(list.filter(x=> x && typeof x === 'object' && x.id));
    }
  }catch(e){}
  if(!legacy.length) return false;
  // 按 id 去重（IDB 源优先级高、本地 fyp_lib 兜底），并补必填字段
  const byId = {};
  legacy.forEach(x=>{ if(x && x.id) byId[x.id] = x; });
  const merged = Object.keys(byId).map(id=>{
    const p = byId[id];
    const snap = normalizeLegacyProject(p);
    return { ...snap, id: id, updatedAt: p.updatedAt || Date.now() };
  });
  if(!merged.length) return false;
  const prevCur = lib && lib.curId;
  lib = { curId: prevCur || merged[0].id, items: merged };
  idbSaveLib();   // 写新索引 + 逐项目（localStorage 单条，超限自动降级）
  // 迁移成功后加载当前项目
  const cur = lib.items.find(i=> i.id === lib.curId) || lib.items[0];
  if(cur){ lib.curId = cur.id; applyProject(cur); }
  try{ localStorage.removeItem('fyp_lib'); }catch(e){}   // 一次性：迁移完成即清空旧键，正式关闭旧通道
  return true;
}
// 把任意旧版项目快照规范化为新形状（兼容字段缺省/旧字段名），保证 applyProject 可读。
function normalizeLegacyProject(p){
  const s = p && typeof p === 'object' ? p : {};
  const out = {};
  out.mode = (s.mode === 'longnovel' || s.mode === 'long') ? 'longnovel' : (s.mode || 'shortfilm');
  out.mode = (out.mode === 'long') ? 'longnovel' : out.mode;
  out.mode = (out.mode === 'short' || out.mode === 'shortfilm') ? 'shortfilm' : out.mode;
  out.recipe = s.recipe || 'mesh';
  out.idea = s.idea != null ? s.idea : '';
  out.outline = s.outline || null;
  out.outlineConfirmed = !!s.outlineConfirmed;
  out.chapters = Array.isArray(s.chapters) ? s.chapters : [];
  out.characters = Array.isArray(s.characters) ? s.characters : [];
  out.scenes = Array.isArray(s.scenes) ? s.scenes : [];
  out.storyboard = Array.isArray(s.storyboard) ? s.storyboard : [];
  out.qcRecord = undefined;   // 无残留
  if(out.outline) delete out.outline.titleQC;
  out.chapterStyle = (s.chapterStyle && typeof s.chapterStyle === 'object')
    ? { tags: Array.isArray(s.chapterStyle.tags)?s.chapterStyle.tags:[], intensity:(s.chapterStyle.intensity===1||s.chapterStyle.intensity===3)?s.chapterStyle.intensity:2, collapsed:!!s.chapterStyle.collapsed }
    : { tags:[], intensity:2, collapsed:false };
  out.styleContract = (s.styleContract && typeof s.styleContract === 'object') ? s.styleContract : null;
  out._styleHistory = Array.isArray(s._styleHistory) ? s._styleHistory : [];
  out.glossAdherence = (typeof s.glossAdherence === 'number') ? s.glossAdherence : 60;
  out.glossAutoFill = (s.glossAutoFill === undefined) ? true : !!s.glossAutoFill;
  out.langLayer = (s.langLayer === undefined) ? true : !!s.langLayer;
  out.banList = (s.banList && typeof s.banList === 'object') ? normalizeBanList(s.banList) : null;   // v1.0.132 禁则清单随项目持久化（null=未自定义）
  out.ctAdviceHist = Array.isArray(s.ctAdviceHist) ? s.ctAdviceHist : [];
  out.contentAdviceHist = Array.isArray(s.contentAdviceHist) ? s.contentAdviceHist : [];
  out.hist = (s.hist && typeof s.hist === 'object') ? s.hist : { characters:[], scenes:[], cover:[], storyboard:[] };
  out.title = s.title || (s.outline && s.outline.title) || '';
  out.logline = s.logline || (s.outline && s.outline.logline) || '';
  out.step = (s.step && s.step >= 1) ? s.step : (out.outlineConfirmed ? 4 : (out.outline ? 2 : 1));
  return out;
}
function migrateOldState(){
  try{
    const s = JSON.parse(localStorage.getItem(KEY_STATE));
    if(!s || typeof s !== 'object') return;
    Object.assign(state, s);
    state.raw = s.raw || {};
    currentStep = (s.step && s.step >= 1 && s.step <= 5) ? s.step : 1;
    const snap = projectSnapshot();
    lib = { curId: snap.id = makeId(), items: [{ ...snap, updatedAt: Date.now() }] };
    saveLib();
    localStorage.removeItem(KEY_STATE);
  }catch(e){}
}
// persist：把当前状态补存到当前项目（含当前步骤），便于切换后恢复
function persist(){
  // 尚无当前项目时，自动新建一个
  if(!lib.items.some(i=> i.id === lib.curId)){
    const snap = projectSnapshot();
    const newId = makeId();
    lib.items.unshift({ ...snap, id: newId, updatedAt: Date.now() });
    lib.curId = newId;
  }
  const idx = lib.items.findIndex(i=> i.id === lib.curId);
  if(idx >= 0){
    const snap = projectSnapshot();
    lib.items[idx] = { ...snap, id: lib.curId, updatedAt: Date.now() };
  }
  robustSaveLib();
}

/* ---------- AI 请求（浏览器直连 OpenAI 兼容协议，支持流式） ---------- */
// 来源唯一：仅使用 cfg.active 指向的 (组/账号/模型)，绝不并发多模型。
// onStream(deltaText)：提供时开启流式（stream:true），每收到一段增量就回调用；不传则一次性返回全文。
// 函数名沿用 callDeepSeek；内部为通用 OpenAI 兼容协议，非 DeepSeek 型号也照常调用。

/* ---------- P2-1 AI 请求/响应日志（最近50条，只存本机，可一键清空） ---------- */
const KEY_AILOG = 'fyp_ailog';
let aiLog = [];   // [{ts, task, temp, sys, user, resp, ms, ok, err}]
(function loadAiLog(){ try{ aiLog = JSON.parse(localStorage.getItem(KEY_AILOG)) || []; }catch(e){ aiLog = []; } })();
function aiLogPush(rec){
  aiLog.push(rec);
  if(aiLog.length > 50) aiLog.splice(0, aiLog.length - 50);
  try{ localStorage.setItem(KEY_AILOG, JSON.stringify(aiLog)); }catch(e){ /* 存储满则仅内存保留 */ }
}
function aiLogClear(){ aiLog = []; try{ localStorage.removeItem(KEY_AILOG); }catch(e){} }
// 请求日志弹窗：列表（时间/任务/温度/耗时/成败）+ 展开看 prompt/响应前500字 + 一键清空
function openAiLogPanel(){
  closeAiLogPanel();
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0'); };
  const rows = aiLog.length ? [...aiLog].reverse().map((r,ri)=>{
    const task = String(r.task||'').slice(0,40);
    return `<div class="ailog-row">
      <div class="ailog-head">
        <span class="ailog-time">${fmtTs(r.ts)}</span>
        <span class="ailog-task">${esc(task||'（无任务名）')}</span>
        <span class="ailog-meta">${r.temp!=null?('🌡 '+r.temp):''} · ${r.ms!=null?(r.ms+'ms'):''} · <b class="${r.ok?'ok':'err'}">${r.ok?'✓':'✗'}</b>${r.tmo?` · 🎯${esc(String(r.tm||''))}（分任务覆盖）`:''}</span>
        <button type="button" class="btn small ghost" data-ailog-toggle="${ri}">展开</button>
      </div>
      <div class="ailog-body hidden" data-ailog-body="${ri}">
        ${r.err?`<div class="ailog-sec"><b>错误：</b><span class="err">${esc(r.err)}</span></div>`:''}
        <div class="ailog-sec"><b>System · 前500字 / 共 ${(r.sysLen||r.sys.length).toLocaleString('en-US')} 字：</b><div class="ailog-pre">${esc(String(r.sys||''))}</div></div>
        <div class="ailog-sec"><b>User · 前500字 / 共 ${(r.userLen||r.user.length).toLocaleString('en-US')} 字：</b><div class="ailog-pre">${esc(String(r.user||''))}</div></div>
        <div class="ailog-sec"><b>响应 · 前500字 / 共 ${(r.respLen||0).toLocaleString('en-US')} 字：</b><div class="ailog-pre">${esc(String(r.resp||''))}</div></div>
        <p class="muted" style="font-size:11px">50000 字仅为日志预览上限，实际发送/接收为全量，不影响请求。</p>
      </div>
    </div>`;
  }).join('') : '<p class="muted">暂无请求记录。每次调用 AI 都会记录（最近 50 0条，仅存本机）。</p>';
  const ov = document.createElement('div'); ov.id='ailogPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🗒️ AI 请求日志（${aiLog.length}/500）</b>
        <span style="display:flex;gap:6px">
          <button class="gs-x" data-ailog-close>✕</button>
        </span></div>
        <div style="display:flex;gap:6px;padding:0 16px 8px"><button class="btn small ghost" data-ailog-clear>🗑 清空</button></div>
      <div class="cv-body">
        <div class="cv-div">排查「AI 为什么写偏/漏设定」、复现 bug 的唯一证据；只存本机，可一键清空。</div>
        ${rows}
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-ailog-close]').onclick = closeAiLogPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeAiLogPanel(); });
  ov.addEventListener('click', e=>{
    const b = e.target.closest('[data-ailog-toggle]'); if(!b) return;
    const body = ov.querySelector('[data-ailog-body="'+b.dataset.ailogToggle+'"]');
    if(body) body.classList.toggle('hidden');
  });
  ov.querySelector('[data-ailog-clear]').onclick = ()=>{
    if(!window.confirm('清空全部 AI 请求日志？')) return;
    aiLogClear(); closeAiLogPanel(); toast('请求日志已清空');
  };
}
function closeAiLogPanel(){ const p=$('#ailogPanel'); if(p) p.remove(); }

async function callDeepSeek(system, user, {temperature=null, topP=null, signal=null, maxTokens=null, onStream=null, retry=2, taskKey=null}={}){
  const _t0 = Date.now();
  // P2-1 记录基础信息（task 用 system 前 24 字近似任务名；具体字段在成功/失败收尾时补全）
  // v2.4 记录实际完整长度 sysLen/userLen/respLen，日志展示"前500字/共N字"消除误解
  const _rec = {
    ts: _t0,
    task: String(system||'').replace(/\s+/g,' ').slice(0,24),
    temp: (temperature==null ? null : temperature),
    sys: String(system||'').slice(0,500),
    user: String(user||'').slice(0,500),
    sysLen: String(system||'').length,
    userLen: String(user||'').length,
    respLen: 0,
    resp: '', ms: null, ok: false, err: '', tm: taskKey || '', tmo: false   // v227 分任务模型归因字段
  };
  let lastErr;
  for(let attempt=0; attempt<=retry; attempt++){
    try{
      const s = resolveActiveSpec(taskKey);
      if(taskKey) _rec.tmo = !!s.taskOverride;   // v227 日志可见「本次请求被分任务映射覆盖」
      if(!s.apiKey) throw new Error('请先在 ⚙️ 配置并选择要使用的 AI 账号（API Key）');
      const url = s.baseUrl + '/chat/completions';
      const streaming = typeof onStream === 'function';
      const body = {
        model: s.model,
        messages: [{role:'system', content: system}, {role:'user', content: user}],
        temperature: (temperature==null ? s.temperature : temperature),
        top_p: (topP==null ? 0.95 : topP),   // 4.8 旗舰版（板块一-5）：默认开放采样，高潮段可收紧
        stream: streaming
        // v1.0.122 锁防截断：user 一律整段原样入体（内层供构想/配方等全文发送），绝不在此或上游做长度切片；
        // 实际发送的完整长度可在【请求日志 User·前500字/共N字】观测，N 即全量字符数（前500字仅为展示预览，非发送截断）。
      };
      // 缓存友好：请求的前缀（system + user 恒定首部）在全书各章保持不变，
      // DeepSeek 自动命中上下文缓存，命中价远低于未命中价；可变信息一律放 user 最末。
      if(s.keyInBody) body.api_key = s.apiKey;   // v1.0.136 中转规避：Key 放请求体（api_key）而不放 Authorization 头
      if(maxTokens && maxTokens>0) body.max_tokens = maxTokens;
      // 4.5 P0：默认超时 180 秒，可被传入的 signal 覆盖
      const finalSignal = signal || AbortSignal.timeout(180000);
      let res;
      try{
        const hdrs = {'Content-Type':'application/json'};
        if(!s.keyInBody) hdrs['Authorization'] = 'Bearer '+s.apiKey;   // keyInBody 时不发 Bearer 头，规避中转拦截
        if(streaming){ hdrs['Accept'] = 'text/event-stream'; hdrs['Cache-Control'] = 'no-cache'; }
        res = await fetch(url, {
          method:'POST',
          headers: hdrs,
          body: JSON.stringify(body),
          signal: finalSignal
        });
      }catch(e){
        throw new Error('网络/跨域失败：' + e.message + '。若被拦截，可在设置里填一个代理地址。');
      }
      if(!res.ok){
        // 4.5 P0：429 时读取 Retry-After 的指数退避重试
        if(res.status === 429 && attempt < retry){
          const ra = res.headers.get('Retry-After');
          const wait = ra ? parseInt(ra)*1000 : Math.min(4000, 1000*Math.pow(2, attempt));
          await new Promise(r=>setTimeout(r, wait));
          continue;
        }
        let msg = '请求失败 ('+res.status+')';
        try{ const j = await res.json(); if(j.error && j.error.message) msg = j.error.message; }catch(e){}
        throw new Error(msg);
      }
      if(!streaming){
        const data = await res.json();
        const out = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        const finishReason = (data.choices && data.choices[0] && data.choices[0].finish_reason) || '';
        const usage = data.usage || null;
        _rec.resp = String(out).slice(0,50000); _rec.respLen = String(out).length; _rec.ms = Date.now()-_t0; _rec.ok = true;
        aiLogPush(_rec);
        return { text: out, finishReason, usage };
      }
      // 流式：解析 SSE（data: {...}），把 delta content 逐段回传给 onStream，最后返回完整拼接文本
      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if(!reader) throw new Error('当前浏览器不支持流式响应');
      const decoder = new TextDecoder();
      let buf = '', full = '', finishReason = 'stop';
      const feed = (chunk)=>{
        buf += chunk;
        let nl;
        while((nl = buf.indexOf('\n')) >= 0){
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if(!line || !line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if(payload === '[DONE]') continue;
          let j;
          try{ j = JSON.parse(payload); }catch(e){ continue; }
          const delta = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
          if(delta){ full += delta; onStream(delta); }
          // 4.9 加固：捕获流式末尾真实 finish_reason（'length' = 被 max_tokens 截断），不再一律硬编码 'stop'
          const fr = j.choices && j.choices[0] && j.choices[0].finish_reason;
          if(fr) finishReason = fr;
        }
      };
      while(true){
        const {done, value} = await reader.read();
        if(done) break;
        feed(decoder.decode(value, {stream:true}));
      }
      feed(decoder.decode());
      _rec.resp = String(full).slice(0,50000); _rec.respLen = String(full).length; _rec.ms = Date.now()-_t0; _rec.ok = true;
      aiLogPush(_rec);
      // 4.5 P0：流式最后也返回 {text, finishReason, usage:null}（4.9 起 finishReason 为真实结束原因，供上层识别截断）
      return { text: full, finishReason, usage: null };
    }catch(e){
      lastErr = e;
      if(attempt >= retry) break;
      await new Promise(r=>setTimeout(r, 1000*Math.pow(2, attempt)));
    }
  }
  _rec.ms = Date.now()-_t0; _rec.ok = false; _rec.err = String(lastErr.message||lastErr).slice(0,200);
  aiLogPush(_rec);
  throw lastErr;
}

/* 容错 JSON 解析：去代码围栏、抽取首尾 {} 或 [] */
function parseJson(text){
  return robustParseJson(text);
}

/* =========================================================
 * 4.5 契约层：AI 输出校验与错误处理
 * ========================================================= */

const AI_ERR = {
  TRUNCATED: 'AI_TRUNCATED',
  PARSE_FAIL: 'AI_PARSE_FAIL',
  COUNT_MISMATCH: 'AI_COUNT_MISMATCH',
  SCHEMA_MISS: 'AI_SCHEMA_MISS',
  // NAME_DRIFT 已随 v225/P2 专名漂移程序闸移除
  STYLE_DRIFT: 'AI_STYLE_DRIFT',
  PERSONA_DRIFT: 'AI_PERSONA_DRIFT',   // 4.8 旗舰版（板块三-2）：人设一致性防火墙
  // WORD_OVER 已随 v225/P1 字数检验移除
  REPEAT_OVER: 'AI_REPEAT_OVER',
  TIMEOUT: 'AI_TIMEOUT',
  NETWORK: 'AI_NETWORK'
};

/**
 * 统一 AI 输出包装
 * @param {Promise<string>} promise
 * @param {object} opt {expectedCount, schemaValidator, taskName}
 * @returns {Promise<{ok:boolean, text:string, data:any, finishReason:string, usage:object, errorCode:string, error:string}>}
 */
async function callAIWithContract(promise, opt={}){
  const out = { ok:false, text:'', data:null, finishReason:'', usage:null, errorCode:'', error:'' };
  try{
    const res = await promise;
    // 兼容 callDeepSeek 未来返回 {text, finishReason, usage}
    if(res && typeof res === 'object' && ('text' in res)){
      out.text = String(res.text||'');
      out.finishReason = res.finishReason || '';
      out.usage = res.usage || null;
    } else {
      out.text = String(res||'');
    }
    if(out.finishReason === 'length'){ out.errorCode = AI_ERR.TRUNCATED; out.error='响应被截断'; return out; }
    // JSON 解析
    if(opt.needJson !== false){
      try{ out.data = parseJson(out.text); }catch(e){ out.errorCode=AI_ERR.PARSE_FAIL; out.error='JSON解析失败：'+e.message; return out; }
    }
    // 数量校验
    if(opt.expectedCount != null && opt.countPath){
      const arr = opt.countPath.split('.').reduce((o,k)=> (o&&o[k]!=null)?o[k]:null, out.data);
      if(!Array.isArray(arr) || arr.length !== opt.expectedCount){
        out.errorCode = AI_ERR.COUNT_MISMATCH;
        out.error = `数量不符：期望 ${opt.expectedCount}，实际 ${Array.isArray(arr)?arr.length:'非数组'}`;
        return out;
      }
    }
    // Schema 校验
    if(opt.schemaValidator && typeof opt.schemaValidator === 'function'){
      const schemaErr = opt.schemaValidator(out.data);
      if(schemaErr){ out.errorCode=AI_ERR.SCHEMA_MISS; out.error=schemaErr; return out; }
    }
    out.ok = true;
  }catch(e){
    out.error = e.message || String(e);
    out.errorCode = (e.name==='AbortError' || /timeout/i.test(out.error)) ? AI_ERR.TIMEOUT : AI_ERR.NETWORK;
  }
  return out;
}

/**
 * 数量断言
 */
function assertCount(arr, expected, label){
  if(!Array.isArray(arr)) throw new Error(`${label} 不是数组`);
  if(arr.length !== expected) throw new Error(`${label} 数量不符：期望 ${expected}，实际 ${arr.length}`);
}

/**
 * JSON 五级自愈（比现有 parseJson 更强）
 */
function robustParseJson(text){
  if(!text) throw new Error('模型返回为空');
  let t = String(text).trim();
  // 1. 去代码围栏
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fence) t = fence[1].trim();
  // 2. 原文 parse
  try{ return JSON.parse(t); }catch(e){}
  // 3. 首尾 {} / [] 截取
  const m = t.match(/[\{\[]\s*[\s\S]*[\}\]]/);
  if(m){ try{ return JSON.parse(m[0]); }catch(e){} }
  // 4. 引号修复：把中文引号、单引号对象尝试修复
  const fix = t
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
  try{ return JSON.parse(fix); }catch(e){}
  // 5. 逐字段抽取（最后一招）：按行找 "key":"value" 模式
  const obj = {};
  const re = /"([^"]+)"\s*:\s*("([^"]*)"|\[[\s\S]*?\]|\{[\s\S]*?\})/g;
  let mm;
  while((mm = re.exec(t)) !== null){
    try{ obj[mm[1]] = JSON.parse(mm[2]); }catch(e){ obj[mm[1]] = mm[2]; }
  }
  if(Object.keys(obj).length > 0) return obj;
  throw new Error('返回不是合法 JSON（已原样保留）');
}

// 临时兼容：旧代码调用处先 .text，新代码逐步迁移
function unwrapAIResult(res){ return (res && typeof res === 'object' && 'text' in res) ? res.text : String(res||''); }

// 4.7 Pro（2.4）：统一 JSON 提取辅助——整体解析 → markdown 代码块 → 第一个 {} / []，失败返回 null（不抛错）
function extractJsonObject(text){
  if(!text) return null;
  const t = String(text).trim();
  // 先尝试整体解析
  try{ return JSON.parse(t); }catch(e){}
  // 再尝试提取 markdown 代码块
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if(m){ try{ return JSON.parse(m[1].trim()); }catch(e){} }
  // 再尝试提取第一个 { ... } 或 [ ... ]
  const obj = t.match(/\{[\s\S]*\}/);
  if(obj){ try{ return JSON.parse(obj[0]); }catch(e){} }
  const arr = t.match(/\[[\s\S]*\]/);
  if(arr){ try{ return JSON.parse(arr[0]); }catch(e){} }
  return null;
}

/* 按钮忙碌态 */
function busy(btn, on, label){
  if(on){ btn._txt = btn.innerHTML; btn.disabled = true; btn.classList.add('is-busy'); btn.innerHTML = '<span class="spinner"></span>'+(label||'生成中…'); }
  else { btn.disabled = false; btn.classList.remove('is-busy'); btn.innerHTML = btn._txt; }
}

/* ---------- 全局中止控制器（流式停止按钮用） ---------- */
let _abortCtl = null;           // 当前 AbortController
let _abortBtn = null;           // 当前可见的停止按钮 DOM
// 创建一个停止按钮
function makeStopBtn(){
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'stop-btn'; b.innerHTML = '⏹';
  b.onclick = ()=>{
    if(_abortCtl){ _abortCtl.abort(); _abortCtl = null; }
    hideStopBtn();
  };
  b.style.display = 'none';
  return b;
}
// 显示停止按钮，挂载到父容器
function showStopBtn(parent){
  if(!_abortBtn){ _abortBtn = makeStopBtn(); document.body.appendChild(_abortBtn); }
  _abortCtl = new AbortController();
  _abortBtn.style.display = '';
  parent.appendChild(_abortBtn);
}
// 隐藏停止按钮
function hideStopBtn(){
  if(_abortBtn){ _abortBtn.style.display = 'none'; }
  _abortCtl = null;
}
let _aiOptBusy = false;  // v10.43 AI 优化建议进行中标记（无 signal，需单独占位，供 genBusy 判定互斥）
// v10.43 全局"是否有生成任务进行中"判定：任一走 _abortCtl 的流式请求，AI 建议占位，或任意 .is-busy 按钮，均视为 busy。
// 供视图切换/重复触发入口做统一互斥拦截（避免"重生成标题 + AI建议"等多任务并发劫持 _abortCtl）。
function genBusy(){
  if(_aiOptBusy) return true;
  if(_abortCtl) return true;
  const busyAny = document.querySelector('.is-busy, [disabled].cp-gen-btn-loading');
  if(busyAny) return true;
  return false;
}
// v10.43 视图切换守卫：进行中时提示拦截。返回 true 表示允许切换；false 表示被拦截（不切换）。
function guardSwitchStep(){
  if(genBusy()){
    return confirm('当前有生成任务进行中，切换视图会中断其运行，确定继续？');
  }
  return true;
}

/* =========================================================
 * 提示词模板（中文，面向国内 + 即梦）
 * ========================================================= */
/* 主线条四格 JSON 片段（主线必有、副暗汇合有则带、无则空、绝不硬造）。
 * 集中定义为常量，供 6 个结构范式的内联 outlineSys 引用，使「选中结构」时 structure 的 schema
 * 完全由 st.outlineSys 一处描述，消除此前 STRUCTURE_MAIN_SYS 与 st.outlineSys 各写一遍 mainLine/subLines/hiddenLine/pivotPlan
 * 的重复描述（S1）。未选中结构时改由 STRUCTURE_MAIN_SYS 兜底提供这份主线条骨架。 */
const MAIN_LINE_BLOCK = `"mainLine":"全书唯一主线/核心走向（必有：这本到底讲什么）",
  "subLines":["副线1：内容","副线2：内容"],  // 有则带；若故事确实没有副线就空数组或省略，绝不硬造
  "hiddenLine":"暗线内容（如何埋设、何时揭晓）",  // 有则带；若没有暗线就空字符串或省略，绝不硬造
  "pivotPlan":"汇合/大逆转所在章（点式，如 第20章三方对峙）"  // 有则带；无则该字段省略`;

// v10.9 公共 JSON 契约句：longOutlineSys / OUTLINE_GEN_SYS / 各结构 outlineSys 复用，避免双处漂移
const JSON_HEADER = `请按如下 JSON 结构输出（不要任何解释、不要 markdown 代码块；可在此基础上按下方追加块补充 glossary、structure 等其它顶层字段）：`;

// 4.7 Pro（3.5/第7章指令2）：旧正文 System 全文提取为 LONG_CHAPTER_SYS_LEGACY 保留回退。
const LONG_CHAPTER_SYS_LEGACY = `你是一位深谙长篇叙事的章节执行写手。
【核心任务】
负责撰写指定章节的完整正文。您需基于已知的【小说书名】【小说简介】【本章标题】【本章主线简述（辅助参考）】【上一章标题】【上一章全部正文】【下一章标题】与【万物词典】，创作出情节连贯、人物鲜活、符合整体风格的章节内容，确保本章既独立成篇又承上启下。

【硬性约束】

0. 若用户提示中出现【写作风格】块，必须作为首位硬约束执行，其优先级高于本提示词中所有其他要求。
1. 输出格式：仅输出本章正文，不得包含任何说明、章节标题、元评论或分析。正文直接以小说段落形式呈现，不得使用markdown代码块或额外格式。
2. 【本章主线简述】为本章剧情走向的辅助参考：据此铺陈关键事件与人物动向，但具体细节、对白与推进方式由你按人物设定与上文承接自然生发；若它与【上一章全部正文】的结尾或人物处境冲突，以上一文的真实承接为准，保持主线不脱轨。
3. 必须参考【上一章全部正文】，确保人物情绪状态、对话话题、场景延续、时间逻辑等与上一章无缝衔接。若上一章结尾有未完成的动作或对话，本章须自然承接。
4. 必须考虑【下一章标题】，在本章结尾处埋下指向下一章的线索或悬念，但不得提前揭示下一章的具体情节（若上下文未给出下一章标题，则按本章剧情自然收束即可，不强求指向标题）。
5. 万物词典中的既有设定（人物身份与关系、地名、专名等）必须准确使用，不得与词典相悖。剧情自然需要新人物、新地点、新专名时可以引入：新人物须在文中自然交代其身份、年龄、性格、与他人关系等设定信息；新地点/新专名须交代其含义或特征；命名须符合中文常规，禁止乱码与生造外文。
6. 人物言行需符合其性格设定（可从小说简介或万物词典中获取），对话需具有辨识度，避免千人一面。
7. 正文长度控制在2000—5000字之间，可根据本章内容密度适当浮动，但须保证情节充实而不拖沓。
8. 章节内部应有节奏变化，例如紧张场景与舒缓场景交替，避免通篇平铺直叙。每段描写应服务于情节推进或人物塑造。
9. 内部自查（不写入输出）：输出前确认本章主线简述中的关键事件均已覆盖，且与上一章结尾和下一章标题形成合理连接。若主线简述与小说简介有细微冲突，以小说简介为准，并在正文中自然调和，不显突兀。`;

// 4.7 Pro（3.5 原码）：资深章节执行导演 + 本章 consistency 审计员。
const LONG_CHAPTER_SYS_PRO = `你是一位资深长篇小说「章节执行导演」，同时担任本章 consistency 审计员。
【核心任务】基于多层上下文，撰写指定章节的完整正文，并确保在输出前通过内部一致性自检。

【输入上下文层级（L0→L4，优先级递减）】
L0 · 写作风格契约（若提供）：句长、对话占比、禁用词、偏好转场——最高优先级，必须执行。
L1 · 全书导航：书名、简介、核心定位、深层主题、全书主线、结构骨架、当前章在三幕结构中的位置。
L2 · 本章任务：本章标题、本章主线简述、本章节拍表（setup/rise/climax/hook）、本章情绪弧、本章必须使用实体。
L3 · 前后衔接：上一章全文（或摘要）、上一章结尾状态、下一章标题（仅作承接参照）。
L4 · 滚动摘要与相关设定：最近 3 个滚动摘要区块、相关词典条目（人物/地点/专名）、未收束伏笔。

【输出要求】
1. 仅输出本章正文，不得包含标题、章节序号、元评论、分析、json、markdown 代码块。
2. 正文直接以小说段落呈现，段落之间用空行分隔。
3. 正文必须覆盖本章节拍表中的四个事件（setup / rise / climax / hook），不得遗漏。
4. 必须使用本章 requiredEntities 中的全部实体；词典既有实体的设定不得改动或相悖。在此基础上允许按剧情需要自然引入新人物/新地点/新专名：新人物须在文中体现身份、年龄、性格、与既有人物的关系等可入典信息；新地名/新专名须体现其含义或用途。禁止引入与剧情无关的冗余实体。
5. 人物言行须符合其性格设定；对话须有辨识度；时间线须与上一章衔接。
6. 若 L0 风格契约有量化指标，请在输出前自检：平均句长、对话占比是否落在契约区间内。
7. 结尾须指向下一章标题，埋下线索或悬念，但不得提前揭示下一章具体情节（若上下文未给出下一章标题，则按本章剧情自然收束即可，不强求指向标题）。
8. 正文长度 2000—5000 字；根据剧情密度可浮动，但必须保证情节充实。

【内部一致性自检（不写入输出）】
- 时间线不矛盾
- 人物性格/外貌/年龄与词典一致
- 词典既有专名使用无误、无相悖；本章新引入的人名/地名/专名均为剧情所需，且已在文中交代设定信息
- 上一章结尾未完成的动作/对话已承接
- 伏笔 foreshadowing 已按节拍表埋设
- 风格契约未偏离

【失败处理】
若自检发现严重冲突无法调和，请只输出正文，并在正文末尾以单行隐藏注释形式输出：<!-- AI_NOTE: 冲突点 -->, 程序将捕获并转人工复核。`;

// 4.7 Pro（第7章指令2）：新常量用旧名，引用点零改动自动升级
const PROMPTS = {
  outlineSys: `你是一位专业编剧与故事架构师，擅长短剧/短视频叙事。根据用户的一句或几句话构想，设计一部适合改编为短视频的故事。
请严格只输出如下 JSON（不要任何解释、不要 markdown 代码块）：
{"title":"故事标题","logline":"小说简介（含核心冲突）","chapters":[{"title":"第1章标题","summary":"该章核心事件与转折，1-2句"}]}
要求：chapters 数量按故事体量在 6-12 章之间；summay 体现人物动机与情节推进。`,

  chapterSys: `你是一位擅长网文与短剧的编剧。请根据「故事大纲」与「本章概要」写出本章完整正文。
要求：有强画面感、对话自然、节奏明快、推进剧情；篇幅 800-1500 字；只输出正文，不要标题、不要解释。`,

  characterSys: `你是一位影视角色设定师。根据完整故事，提取主要角色（3-6 个，含主角与关键配角），为每个角色产出「影视前期定妆提示词包」，用于用户粘贴到「即梦(Dreamina)」生成角色参考图。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"characters":[{"name":"角色名","role":"身份/作用","profile":{"年龄":"","性别":"","身份":"","性格":"","外貌":"脸型/发型/瞳色/身形等","常服与配色":"","标志性道具":"","材质质感":""},
"prompts":{"定妆图":"全身定妆图提示词，需固化固定外貌特征以保证后续垫图一致性","三视图":"正面/侧面/背面描述","表情":"喜/怒/哀/惊等表情参考","服饰细节":"衣物纹样与剪裁放大","道具":"武器/饰品/随身物","配色":"主色/辅色/点缀色色板","材质":"布料/金属/皮革等质感"}}]}
要求：所有 prompts 为中文、具体、可直接粘贴即梦；『定妆图』要写清不变的身份特征；风格统一。`,

  sceneSys: `你是一位影视场景设定师。根据故事与角色，提取关键场景（4-8 个），产出即梦出图提示词。
⚠️ 重要：场景是「纯环境/空间设定」——它是无人物、无角色的环境模型（空镜），供视频 AI 作环境参考。**严禁出现任何人物、角色、人形、剪影、拟人元素**。出图提示词必须以环境为主体（空间结构/陈设/材质/光线/氛围/天气/时间感），并在提示词末尾附上负向约束：no people, no characters, no humans, no silhouettes, no figures, empty of people。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"scenes":[{"name":"场景名","作用":"在故事中的功能","description":"场景文字设定","prompt":"即梦出图提示词（中文，含风格/光线/氛围/构图，可直接粘贴；末尾附 no people 等负向约束）"}]}
要求：prompt 贴合即梦习惯，风格与整体基调一致；每条 prompt 必须体现「无人环境」这一核心语义。`,

  storyboardSys: `你是一位资深分镜师/导演。根据故事、角色、场景，为【指定章节】产出导演级短视频分镜表。
工作方法（导演脑前置）：
1. 先提炼本章「视觉概念」：一句可证伪、专属本章、能派生镜头序列的画面主意（拒绝"气氛很好"式空话）。
2. 再设计「母题」：建立(镜N) → 变奏(镜M) → 打破/兑现(镜K) 的镜头落点。
3. 最后拆镜头：每镜是一个连续 take，镜间有受控的剪辑动机；只写可拍摄、可生成、可校验的物理事实（拒绝比喻与情绪散文）。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"视觉概念":"本章一句画面主意","母题":"建立→变奏→打破","shots":[{"镜号":1,"时长":3,"景别":"","角度":"","运镜":"","主体":"本镜主体是谁/什么","构图":"主体位置/景深","光线":"","画面描述":"本镜画面与动作","对白":"台词或旁白，无则空","转场":"","出图提示词":"即梦出图提示词（中文，按 运镜+镜头感+主体+风格+光线+比例 拼装；引用对应角色定妆特征与场景，保证一致性）","连续性":"入口引用/出口状态","剪辑动机":"为什么接这一镜"}]}
【镜头技巧库】取值请从这里选：
- 景别：大特写/特写/近景/中景/全景/远景/过肩
- 角度：平视/仰拍/俯拍/荷兰角/鸟瞰/顶视
- 运镜：推/拉/摇/移/跟/升降/环绕/手持/变焦/航拍
- 光线：黄金时刻/柔光漫射/霓虹背光/体积光/轮廓光/烛光暗调
- 转场：硬切/叠化/淡入淡出/匹配剪辑/甩镜
要求：镜号从 1 开始连续；每章 6-12 镜，按本章情节密度增减；每镜时长 2-6 秒，对话密集或大动作镜头可到 8 秒，须填具体秒数；出图提示词可直接粘贴即梦。`,

  // —— 经典长篇小说模式 ——
  coverSysClean: `你是一位资深书籍装帧设计师与插画师。根据用户提供的小说标题与故事梗概，为这部小说的【封面图】产出一条可粘贴到「即梦(Dreamina)」的中文出图提示词【纯画面版，不含任何文字】。
要求：画面要抓住小说核心意象与情绪（世界观/主角困境/关键场景），构图强烈、光影戏剧化、色彩有记忆点；为封面预留的书法/书名排布位置要留出充足留白（如顶部或居中留白区），方便排版方后期加字；长度 150-280 字；结尾可附风格关键词（如"电影级打光、史诗感、高对比、厚涂插画"）；**严禁生成任何文字/标题/字幕/笔画**，画面里不要出现可辨认的汉字或拼音字母；只输出提示词正文，不要解释、不要 markdown 代码块。`,

  coverSysTitle: `你是一位资深书籍装帧设计师与插画师。根据用户提供的小说标题与故事梗概，为这部小说的【封面图】产出一条可粘贴到「即梦(Dreamina)」的中文出图提示词【含书名文字版】。
要求：画面要抓住小说核心意象与情绪（世界观/主角困境/关键场景），构图强烈、光影戏剧化、色彩有记忆点；**封面需包含书法风格的【书名汉字】作为主体文字**，请把小说标题精准写入提示词，指定其为封面主文字（如"金色书法大字『书名』题于画面中央/顶部，字迹遒劲、带有水墨或烫金质感"）；其余可附风格关键词；长度 150-280 字；只输出提示词正文，不要解释、不要 markdown 代码块。`,

  // 4.5：longOutlineSys 已删除，统一使用 OUTLINE_GEN_SYS + buildOutlineSys()（见第 4.2 节）。

  // 4.7 Pro（3.5/第7章指令2）：PROMPTS.longChapterSys 指向 LONG_CHAPTER_SYS_PRO（旧全文见 LONG_CHAPTER_SYS_LEGACY）
  longChapterSys: LONG_CHAPTER_SYS_PRO,

};

/* =========================================================
 * 长篇写作范式：节奏 / 标题风格（结构范式体系已移除 v11）
 * ---------------------------------------------------------
 * 节奏(RHYTHMS, 单选互斥)      web黄金网文 / repress压抑反转 / slice慢生活
 *                              mystery悬疑解谜 / epic群像史诗 / fatal悲剧宿命 / inward文艺向内
 * 标题风格(TITLE_STYLES, 可多选可空)   归纳/画龙点睛/文学语句 等
 * 页面选择与介绍折叠遵循 v2 方案；默认节奏为 web（黄金网文）。
 * ========================================================= */
const SIZE_DEFAULT = { min:3000, max:5000 };

// v10.13 优化构想：调用 IDEA_POLISH_SYS 把粗糙构想优化为结构化高质量版本。
// 极短输入（<15 字）由 AI 走「骨架展开模式」且强制多方案；空输入禁用。
// 多方案模式（polishMulti 开）：AI 返回 JSON（advice + options[]），Tab 切换查看/编辑。
let polishMulti = true;   // v1.0.121 多方案开关（默认开；极短构想强制 true）

// v10.16 多方案留存：采用后不销毁方案（state.polishOptions/polishAdopted 随快照持久化），
// 提示条提供「查看全部（零请求）/ 重新优化（force）/ 清除」；再次优化需 confirm 防误发请求。
async function polishIdea(btn, force){
  const idea = (state.idea || '').trim();
  if(!idea){ toast('请先输入故事构想'); return; }
  const kept = Array.isArray(state.polishOptions) && state.polishOptions.length;
  if(kept && !force){
    if(!confirm(`已有 ${kept} 个保留方案，重新优化将覆盖它们。继续？`)) return;
  }
  const multi = polishMulti || idea.length < 15;   // 极短强制多方案
  // 4.8 旗舰版（P1）：拓扑路由检查 + 运行态标记
  if(!canRunAI('idea')){ toast('优化构想暂不可运行'); return; }
  markAIRunning('idea');
  if(btn) busy(btn,true, multi ? '生成多方案构想中…' : '优化构想中…');
  try{
    // 4.8（4.4）：统一经 callAIGuarded('idea')——system=IDEA_POLISH_SYS(PRO)、user=buildIdeaPolishUser(ctx)、校验=validateIdeaProOutput
    // 4.9 加固：把 multi 透传给 getSystemPrompt，按「多方案/单稿」拼接输出模式后缀，让多方案开关真正生效
    const txt = await callAIGuarded('idea', { multi }, {temperature: resolveActiveSpec().ideaTemp});
    const out = String(txt||'').trim();
    if(!out){ toast('优化失败，请重试'); return; }

    // 新解析：尝试提取结构化 JSON
    const j = extractJsonObject(out);
    if(j && j.brief){
      // 4.7 Pro：结构化简报存档（供大纲 AI 经 formatNavBeaconForOutline 注入【优化构想简报】）
      state._lastPolishBrief = j.brief; persist();
      // 把结构化简报渲染为文本卡片
      const textBrief = formatIdeaBrief(j.brief);
      // 若多方案模式需包装
      if(multi){
        showPolishResult(JSON.stringify({options:[{name:'优化方案', text:textBrief}]}), multi);
      } else {
        showPolishResult(textBrief, multi);
      }
      // 在 pol-cards 区域额外展示诊断
      const diag = formatIdeaDiagnosis(j.diagnosis);
      if(diag){
        const box = $('#polishCards');
        if(box) box.insertAdjacentHTML('afterbegin', diag);
      }
      markAIDone('idea');
      toast('优化完成：已诊断并输出结构化简报');
    } else {
      // 降级：旧行为（4.5 结构 optimizedIdea/navBeacon/defects... 由 showPolishResult 兼容解析展示）
      showPolishResult(out, multi);
      markAIDone('idea');
      toast('优化完成');
    }
  }catch(e){
    addToFixQueue({kind:'idea', error:e.message});   // 4.8（6.4）：失败进修复队列
    toast('优化失败：'+e.message);
  }
  finally{
    state.aiNetwork.running = (state.aiNetwork.running||[]).filter(k=>k!=='idea');   // 兜底清理运行态
    if(btn) busy(btn,false);
  }
}

// 4.7 Pro（3.1）：结构化简报 → 纯文本卡片
function formatIdeaBrief(b){
  return [
    `题材：${b.genre || ''}`,
    `主角：${b.protagonist || ''}`,
    `核心冲突：${b.coreConflict || ''}`,
    `世界观/规则：${b.worldOrRules || '无'}`,
    `对手/压力：${b.antagonistOrPressure || '无'}`,
    `动机：${b.motivation || ''}`,
    `风格：${b.style || ''}`,
    `读者体验：${b.readerExperience || ''}`
  ].join('\n');
}

// 4.7 Pro（3.1）：诊断块 HTML（缺失要素 + 引导问题清单）
function formatIdeaDiagnosis(d){
  if(!d || !Array.isArray(d.missing) || !d.missing.length) return '';
  const qs = (d.questions || []).map(q=>`<li>${esc(q)}</li>`).join('');
  return `<div class="pol-diag" style="margin-bottom:10px;padding:10px;background:var(--warn-bg, #fff8e6);border-radius:6px">
    <b>⚠️ 构想诊断：缺失 ${d.missing.length} 项</b>
    <ul style="margin:6px 0 0;padding-left:18px">${qs}</ul>
  </div>`;
}

// 4.5：优化构想输出 schema 校验（defects 非空、navBeacon 完整、人物字段齐全）
function validatePolishOutput(j){
  if(!j || typeof j !== 'object') return '返回不是对象';
  if(!String(j.optimizedIdea||'').trim()) return '缺少 optimizedIdea';
  const b = j.navBeacon;
  if(!b || typeof b !== 'object') return '缺少 navBeacon';
  const required = ['genre','protagonist','coreConflict','tone'];
  for(const k of required) if(!String(b[k]||'').trim()) return `navBeacon 缺少 ${k}`;
  if(!Array.isArray(j.defects) || !j.defects.length) return '缺少缺陷清单 defects';
  const n = +j.suggestedChapterCount;
  if(!Number.isFinite(n) || n<5 || n>200) return 'suggestedChapterCount 必须在 5-200 之间';
  if(Array.isArray(j.seedCharacters)){
    for(const c of j.seedCharacters){
      const miss = CHAR_FIELDS.filter(k=> c[k]==null || String(c[k]).trim()==='');
      if(miss.length) return `人物 ${c.name||'?'} 缺少字段：${miss.join('/')}`;
    }
  }
  return '';
}

// 展示优化结果：多方案（JSON 2-6 个）→ 竖向多色卡片；单稿（文本）→ 单张卡片。均只读。
// 4.5：入参为 callAIWithContract 解析后的对象（单稿=结构化 JSON；多稿={options:[...]}）；
//      每个方案附加 _v45{defects,navBeacon,seedCharacters,seedPlaces,suggestedChapterCount}，供「📥 导入设定」使用。
function showPolishResult(out, multi){
  const box = $('#polishBox'), cards = $('#polishCards');
  if(!box || !cards) return;
  box.style.display = 'block';
  const pickV45 = (o)=> ({
    defects: Array.isArray(o&&o.defects) ? o.defects : [],
    navBeacon: (o && o.navBeacon && typeof o.navBeacon==='object') ? o.navBeacon : null,
    seedCharacters: Array.isArray(o&&o.seedCharacters) ? o.seedCharacters : [],
    seedPlaces: Array.isArray(o&&o.seedPlaces) ? o.seedPlaces : [],
    suggestedChapterCount: (o && o.suggestedChapterCount!=null && Number.isFinite(+o.suggestedChapterCount)) ? +o.suggestedChapterCount : null
  });
  if(multi){
    const j = (out && typeof out === 'object') ? out : (parseJson(String(out)) || {});
    const opts = Array.isArray(j.options) ? j.options.filter(o=>o && String(o.optimizedIdea||o.text||'').trim()) : [];
    if(opts.length){
      snapshotPolishBatch('重新优化前');   // 覆盖前把旧整批方案归档为可回退版本（≤5）
      state.polishOptions = opts.map(o=> Object.assign({}, o, {
        text: String(o.optimizedIdea||o.text||'').trim(),
        _v45: pickV45(o)
      }));
      state.polishAdopted = null;   // 新方案列表，尚未采用
      persist();
      renderPolishCards(cards);
      return;
    }
    // JSON 解析失败降级：整体当单稿文本
    state.polishOptions = [{ name:'方案1', text: String(typeof out==='object' ? ((out&&out.optimizedIdea)||'') : out).trim(), _v45: pickV45(typeof out==='object'?out:{}) }];
    state.polishAdopted = null;
    persist();
    renderPolishCards(cards);
    return;
  }
  // 单稿：直接作为单个方案展示（4.5：结构化对象 → optimizedIdea 为主体 + _v45 附加数据）
  const single = (out && typeof out === 'object') ? out : { optimizedIdea: String(out||'').trim() };
  state.polishOptions = [{ name:'方案1', text: String(single.optimizedIdea||single.text||'').trim(), _v45: pickV45(single) }];
  state.polishAdopted = null;
  persist();
  renderPolishCards(cards);
}

// 4.9 修复：把「导入设定」的 _v45 结构化设定写入一个真实存在的 outline（词典幂等合并 + navBeacon）。
function applyV45ToOutline(o, d){
  if(!o || !d) return { nC:0, nP:0 };
  if(!o.glossary || typeof o.glossary!=='object') o.glossary = {characters:[],places:[],propernouns:[]};
  const g = o.glossary;
  ['characters','places','propernouns'].forEach(k=>{ if(!Array.isArray(g[k])) g[k]=[]; });
  let nC=0, nP=0;
  (d.seedCharacters||[]).forEach(c=>{
    const nm = String(c&&c.name||'').trim(); if(!nm) return;
    if(g.characters.some(x=>String(x&&x.name||'').trim()===nm)) return;
    g.characters.push({ name:nm, identity:c.identity||'', age:String(c.age==null?'':c.age), gender:c.gender||'', appearance:c.appearance||'', hobby:c.hobby||'', relation:c.relation||'', trait:c.trait||'' });
    nC++;
  });
  (d.seedPlaces||[]).forEach(p=>{
    const nm = String(p&&p.name||'').trim(); if(!nm) return;
    if(g.places.some(x=>String(x&&x.name||'').trim()===nm)) return;
    g.places.push({ name:nm, type:p.type||'', note:p.note||'' });
    nP++;
  });
  if(d.navBeacon && typeof d.navBeacon==='object'){
    o.navBeacon = d.navBeacon;
  }
  return { nC, nP };
}

// 4.5「导入设定」：把方案的结构化设定写入 state——navBeacon→state.outline.navBeacon；
// seedCharacters/seedPlaces 合并进 state.outline.glossary；suggestedChapterCount→state.chapterCount（需用户确认）；
// tone 映射到默认写作风格标签（如"冷峻"→minimal/cutting）。
function importPolishToState(o){
  const d = (o && o._v45) || {};
  // suggestedChapterCount 写入 state.chapterCount（需用户确认；独立于大纲，可即时生效）
  const n = +d.suggestedChapterCount;
  let nCh = 0;
  if(Number.isFinite(n) && n>=5 && n<=200 && state.chapterCount !== n){
    if(confirm(`该方案建议全书 ${n} 章，是否采纳为本书章节数？（当前：${state.chapterCount||'未设'}）`)){ state.chapterCount = n; nCh = 1; }
  }
  // tone 映射到默认写作风格标签（4.5：如"冷峻"→minimal/cutting）；写作风格独立于大纲，即时生效
  const tone = String((d.navBeacon&&d.navBeacon.tone)||'');
  const TONE_TAGS = [['冷峻','minimal'],['克制','minimal'],['冷冽','cutting'],['锋利','cutting'],['热血','flame'],['燃','flame'],['温情','warmth'],['治愈','warmth'],['温柔','warmth'],['悬疑','suspense2'],['黑暗','suspense2']];
  let toneHit = null;
  if(tone){
    for(const [kw,id] of TONE_TAGS){ if(tone.includes(kw)){ toneHit = id; break; } }
  }
  if(toneHit){
    const ws = writeStyleState();
    if(!ws.tags.includes(toneHit)) ws.tags.push(toneHit);
  }
  // 4.9 修复：没有真实大纲时绝不创建空的 state.outline——否则 viewStory 会误判「已有大纲」而切到故事完整界面，
  // 出现无书名/无简介/无章节的全乱状态。改为把结构化设定暂存到 state.pendingV45，待 genOutline 生成真实大纲后自动应用。
  if(!state.outline){
    if(d && (d.navBeacon || (d.seedCharacters&&d.seedCharacters.length) || (d.seedPlaces&&d.seedPlaces.length))){
      state.pendingV45 = JSON.parse(JSON.stringify(d));
    }
    persist(); render();
    toast(`设定已暂存${nCh?(' · 章节数已设为 '+n):''}${toneHit?' · 风格标签已加':''}：导航灯塔/种子人物/种子地点将在生成大纲后自动应用`);
    return;
  }
  // 已有真实大纲：直接写入大纲/词典/风格标签
  const r = applyV45ToOutline(state.outline, d);
  persist(); render();
  toast(`已导入设定：导航灯塔${d.navBeacon?1:0} · 种子人物 ${r.nC} · 种子地点 ${r.nP}${nCh?(' · 章节数已设为 '+n):''}${toneHit?' · 风格标签已加':''}`);
}

// v10.16 用缓存方案重新展开优化区（零请求）：竖向卡片
function openPolishBox(){
  const box = $('#polishBox'), cards = $('#polishCards');
  if(!box || !cards) return;
  box.style.display = 'block';
  renderPolishCards(cards);
}

// v1.0.121 优化构想方案卡：竖向多色卡片（序号徽章/方案名/左侧色条三重视觉编码，复刻 ai配方助手候选列表）。
// 固定六色序列，按生成顺序取色；正文只读可选中；每卡「采用」即导入构想输入框 +「复制」。
const POLISH_PALETTE = ['#E8A33D','#D64545','#4C6FD5','#3FA36B','#8E5AC8','#2CA6A4'];
function renderPolishCards(container){
  if(!container) return;
  const opts = Array.isArray(state.polishOptions) ? state.polishOptions : [];
  if(!opts.length){
    container.style.display = 'block';
    container.innerHTML = `<p class="muted" style="margin:8px 0 0">👆 点「✨ 优化构想」生成 2–6 个候选方案；点某张卡的「采用此方案」即导入上方构想输入框。</p>`;
    return;
  }
  container.style.display = 'block';
  const adopted = state.polishAdopted;
  container.innerHTML = opts.map((o,i)=>{
    const c = POLISH_PALETTE[i % POLISH_PALETTE.length];
    const name = o.name || ('方案'+(i+1));
    const isAdopted = !!adopted && adopted === name;
    const defects = (o._v45 && Array.isArray(o._v45.defects)) ? o._v45.defects.filter(d=>String(d||'').trim()) : [];
    const hasV45 = !!(o._v45 && (o._v45.navBeacon || (o._v45.seedCharacters&&o._v45.seedCharacters.length) || (o._v45.seedPlaces&&o._v45.seedPlaces.length)));
    return `<div class="pol-cand${isAdopted?' on':''}" style="--pc:${c}" data-idx="${i}">
      <div class="pol-cand-head">
        <span class="pol-no" style="background:${c}">${i+1}</span>
        <b class="pol-name" style="color:${c}">${esc(name)}</b>
        ${isAdopted?'<span class="pol-adopted-tag">✔ 已采用</span>':''}
        <span class="pol-cand-actions">
          <button type="button" class="btn small ghost" data-pol-copy="${i}" title="复制此方案">📋 复制</button>
        </span>
      </div>
      <div class="pol-cand-body">${esc(String(o.text||''))}</div>
      ${defects.length?`<div class="pol-cand-body" style="opacity:.85"><b>⚠️ 构想缺陷清单：</b><br>${defects.map(d=>'· '+esc(String(d))).join('<br>')}</div>`:''}
      <div class="pol-cand-foot">
        ${hasV45?`<button type="button" class="btn small ghost" data-pol-import="${i}" title="导入结构化设定（导航灯塔/种子人物/种子地点/建议章节数）">📥 导入设定</button>`:''}
        <button type="button" class="btn small pt-accent" data-pol-use="${i}" style="background:${c}">✔ 采用此方案</button>
      </div>
    </div>`;
  }).join('');
  container.querySelectorAll('[data-pol-use]').forEach(b=>{
    b.onclick = (e)=>{ e.preventDefault();
      const o = (state.polishOptions||[])[+b.dataset.polUse]; if(!o) return;
      state.idea = String(o.text||'');
      state.polishAdopted = o.name || null;
      persist(); render();
      toast('已采用：'+(o.name||('方案'+(+b.dataset.polUse+1)))+'（已导入构想输入框）');
    };
  });
  // 4.5「导入设定」：把该方案的结构化设定写入大纲/词典/章节数/风格标签
  container.querySelectorAll('[data-pol-import]').forEach(b=>{
    b.onclick = (e)=>{ e.preventDefault();
      const o = (state.polishOptions||[])[+b.dataset.polImport]; if(!o) return;
      importPolishToState(o);
    };
  });
  container.querySelectorAll('[data-pol-copy]').forEach(b=>{
    b.onclick = (e)=>{ e.preventDefault();
      const o = (state.polishOptions||[])[+b.dataset.polCopy]; if(!o) return;
      copyText(o.text||'');
    };
  });
}

// v10.13/v10.16 优化区绑定：复制 / 采用此方案（可反复切换）/ 收起 / 多方案开关 / 提示条
function bindPolishIdea(){
  const b = $('#btnPolishIdea');
  if(b) b.onclick = ()=> polishIdea(b);
  const chk = $('#chkPolishMulti');
  if(chk){
    const sync = ()=>{
      const short = (state.idea||'').trim().length < 15;
      chk.checked = polishMulti || short;
      chk.disabled = short;
    };
    sync();
    chk.onchange = ()=>{ polishMulti = chk.checked; };
    const idea = $('#ideaInput');
    if(idea) idea.oninput = ()=>{ state.idea = idea.value; sync(); };
  }
  // v1.0.121 移除「复制/保存此版/采用此方案」顶部按钮：方案只读，复制与采用移入每张卡片（renderPolishCards 内绑定）。
  // v10.16 收起：仅隐藏优化区（方案保留，提示条仍在）
  const disc = $('#btnPolishDiscard');
  if(disc) disc.onclick = ()=>{
    const box = $('#polishBox');
    if(box) box.style.display = 'none';
  };
  // v10.16 提示条按钮：优化版本 / 查看全部 / 重新优化 / 清除
  const hist = $('[data-pol-keep-hist]');
  if(hist) hist.onclick = (e)=>{ e.stopPropagation(); openPolishBatchPanel(); };
  const view = $('[data-pol-keep-view]');
  if(view) view.onclick = (e)=>{ e.stopPropagation(); openPolishBox(); };
  const again = $('[data-pol-keep-again]');
  if(again) again.onclick = (e)=>{ e.stopPropagation(); polishIdea($('#btnPolishIdea'), true); };
  const clear = $('[data-pol-keep-clear]');
  if(clear) clear.onclick = (e)=>{
    e.stopPropagation();
    if(!confirm('清除全部保留方案？')) return;
    snapshotPolishBatch('清除前');   // 归档当前批，之后仍可在「优化版本」找回
    delete state.polishOptions;
    delete state.polishAdopted;
    persist(); render();
    toast('已清除保留方案');
  };
}
// v10.16 方案提示条：采用后保留方案的可视入口（查看全部零请求 / 重新优化 / 清除）
function polishKeepBar(){
  const opts = Array.isArray(state.polishOptions) ? state.polishOptions : [];
  if(!opts.length) return '';
  const cur = state.polishAdopted || opts[0].name || '方案A';
  return `<div class="pol-keep">
    <span class="pol-keep-t">已保留 ${opts.length} 个优化方案（当前采用：${esc(cur)}）</span>
    <span class="pol-keep-btns">
      ${(state.polishHistory&&state.polishHistory.length)?`<button type="button" class="btn small ghost" data-pol-keep-hist>📚 优化版本(${state.polishHistory.length}/50)</button>`:''}
      <button type="button" class="btn small ghost" data-pol-keep-view>🔍 查看全部</button>
      <button type="button" class="btn small ghost" data-pol-keep-again>✨ 重新优化</button>
      <button type="button" class="btn small ghost" data-pol-keep-clear>✕ 清除</button>
    </span>
  </div>`;
}

/* ---------- v10.16 优化构想·批量版本（整批快照 ≤5 份，应用后生效） ---------- */
function polishHistory(){ return Array.isArray(state.polishHistory) ? state.polishHistory : []; }
// 把「当前全部保留方案」整批压入版本栈（最新在前、去重、上限5）；无方案则跳过
function snapshotPolishBatch(label){
  const opts = Array.isArray(state.polishOptions) ? state.polishOptions : [];
  if(!opts.length) return;
  const snap = { options: opts.map(o=>({ name:o.name, text:String(o.text||'') })), adopted: state.polishAdopted||null };
  const hist = state.polishHistory = state.polishHistory || [];
  if(hist.length &&
      JSON.stringify(hist[0].options) === JSON.stringify(snap.options) &&
      hist[0].adopted === snap.adopted) return;
  hist.unshift({ ts: Date.now(), label: label||'快照', options: snap.options, adopted: snap.adopted });
  if(hist.length > 50) hist.length = 50;
  persist();
}
// 整批应用某版：先把当前态归档（保留再回退机会），再覆盖当前保留方案
function applyPolishBatch(idx){
  const hist = polishHistory(); const b = hist[idx]; if(!b || !Array.isArray(b.options) || !b.options.length) return;
  if(!confirm(`整批应用「${idx+1}. ${b.label||'优化版本'}」（共 ${b.options.length} 个方案）？将覆盖当前保留的方案。`)) return;
  snapshotPolishBatch('切换前');
  state.polishOptions = b.options.map(o=>({ name:o.name, text:String(o.text||'') }));
  state.polishAdopted = (b.adopted && b.options.some(o=>o.name===b.adopted)) ? b.adopted : null;
  persist(); closePolishBatchPanel(); render();
  const box = $('#polishBox'); if(box){ box.style.display='block'; openPolishBox(); }
  toast(`已整批应用该优化版本（${state.polishOptions.length} 个方案）`);
}
function deletePolishBatch(idx){
  const hist = polishHistory(); if(!hist.length) return;
  hist.splice(idx,1);
  if(!hist.length) delete state.polishHistory; else state.polishHistory = hist;
  persist(); closePolishBatchPanel(); openPolishBatchPanel();
  toast('已删除该版本');
}
function openPolishBatchPanel(){
  closePolishBatchPanel();
  const hist = polishHistory(); if(!hist.length){ toast('暂无历史优化版本，运行「✨ 优化构想」后自动记录'); return; }
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const rows = hist.map((b,idx)=>`
    <div class="cv-row">
      <div class="cv-meta" style="flex:1;min-width:0">
        <div class="cv-time">${idx+1}. ${esc(b.label||'优化版本')} · ${fmtTs(b.ts)} · ${(b.options||[]).length} 方案</div>
        <div class="cv-t" style="font-size:12px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((b.options||[]).slice(0,3).map(o=>o.name).join(' / '))||'（空）'}</div>
      </div>
      <div class="cv-actions" style="display:flex;gap:6px;flex-shrink:0">
        <button type="button" class="btn ghost cv-b" data-polb-view="${idx}">👁 切换</button>
        <button type="button" class="btn primary cv-b" data-polb-apply="${idx}">应用</button>
        <button type="button" class="btn ghost cv-b" data-polb-del="${idx}">🗑</button>
      </div>
    </div>`).join('');
  const ov = document.createElement('div'); ov.id='polbPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>💾 优化构想 · 批量版本（${hist.length}/50）</b>
        <button class="gs-x" data-polb-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-div">每次「✨ 优化构想」改动前后会把整批方案各归档一份（≤5 份可回退）；「👁 切换」只预览不生效，点「应用」后才覆盖当前保留方案。</div>
        ${rows}
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-polb-close]').onclick = closePolishBatchPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closePolishBatchPanel(); });
  ov.querySelectorAll('[data-polb-view]').forEach(b=> b.onclick = ()=> openPolishBatchPreview(+b.dataset.polbView));
  ov.querySelectorAll('[data-polb-apply]').forEach(b=> b.onclick = ()=> applyPolishBatch(+b.dataset.polbApply));
  ov.querySelectorAll('[data-polb-del]').forEach(b=> b.onclick = ()=> deletePolishBatch(+b.dataset.polbDel));
}
function closePolishBatchPanel(){ const p=$('#polbPanel'); if(p) p.remove(); }
// 单版整批方案的切换预览（不生效）；点「应用此版本」才真正覆盖
function openPolishBatchPreview(idx){
  closePolishBatchPreview();
  const hist = polishHistory(); const b = hist[idx]; if(!b) return;
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const list = (b.options||[]).map(o=>`<div class="cv-row"><div class="cv-t" style="font-size:12px"><b>${esc(o.name||'')}</b><br>${esc(String(o.text||'').slice(0,120))}${(o.text||'').length>120?'…':''}</div></div>`).join('') || '<p class="muted">（空批）</p>';
  const ov = document.createElement('div'); ov.id='polbPreview'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>👁 优化版本切换 · ${esc(b.label||'优化版本')}（${fmtTs(b.ts)} · ${(b.options||[]).length} 方案）</b>
        <button class="gs-x" data-polbp-close>✕</button></div>
      <div class="cv-body"><div style="max-height:60vh;overflow:auto">${list}</div></div>
      <div class="modal-actions" style="padding:12px 16px;border-top:1px solid var(--line)">
        <button type="button" class="btn ghost cv-b" data-polbp-close2>取消</button>
        <button type="button" class="btn primary cv-b" data-polbp-apply>✔ 应用此版本</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-polbp-close]').onclick = closePolishBatchPreview;
  ov.querySelector('[data-polbp-close2]').onclick = closePolishBatchPreview;
  ov.addEventListener('click', e=>{ if(e.target===ov) closePolishBatchPreview(); });
  ov.querySelector('[data-polbp-apply]').onclick = ()=> applyPolishBatch(idx);
}
function closePolishBatchPreview(){ const p=$('#polbPreview'); if(p) p.remove(); }



const RHYTHMS = [
  { id:'web', name:'黄金网文', tag:'爽点密集', short:'黄金网文', src:'经典 · 网文爆款体系',
    outlineNote:'节奏遵循黄金网文强节奏——开篇尽快抛核心冲突与悬念（金手指/秘密）；因果链清晰、角色抉择有代价、实力或关系阶梯递进；情绪节奏有张有弛（爽点-压抑-爆发交替）；主线简述在写正文阶段独立生成。',
    chapterNote:'严格遵循黄金网文强节奏——开篇(前1-2段)尽快进入事件或情绪；以对话与行动推动剧情、少冗长环境描写；本章须兑现一个"爽点/进展"；因果清晰、有记忆点的人设。',
    desc:'当前商业网文最有效的节奏配方，核心是“爽点管理”：全程用小高潮喂给读者，持续满足与追更。',
    mech:'开篇抛冲突悬念；因果清晰、抉择有代价、实力/关系阶梯递进；情绪爽点-压抑-爆发交替。',
    fit:'升级流、逆袭、热血爽文等重代入感连载；读者重爽感、重追更。',
    effect:'留存与追更率高、最懂市场；代价是易套路化，需靠人物与爽点创新破局。' },
  { id:'repress', name:'压抑反转流', tag:'现实虐文', short:'压抑反转', src:'现实 · 黑暗向节奏',
    outlineNote:'节奏为压抑反转流——回报延迟、挫折长期，主角不会立刻打脸、苦难不马上消解；情绪是隐忍煎熬、积蓄良久才释放；困境层层叠加、主角反复受挫；主线简述在写正文阶段独立生成。',
    chapterNote:'遵循压抑反转流——本段情绪以隐忍煎熬为主，不立刻给胜利与奖励；困境层层叠加、主角反复受挫；把发泄点压到很后，部分努力可以没有回报；章末压在反转来临前或苦难加剧处，勾着读者等释放。',
    desc:'与爽文相反：回报延迟、挫折长期、反转来得晚，部分努力无回报；情绪隐忍煎熬、积蓄良久才释放。',
    mech:'困境层层叠加、主角反复受挫、不会立刻打脸；冲突发生后不立刻给胜利，反转往往很晚、甚至部分努力无回报。',
    fit:'社会向、悬疑、悲剧、历史写实网文；追求真实沉重的情感冲击而非即时爽感。',
    effect:'压抑到极点的释放更有力量、人物弧光深；但需控节奏，避免“虐而无解”劝退读者。' },
  { id:'slice', name:'慢生活流', tag:'种田日常', short:'慢生活', src:'现实 · 治愈向节奏',
    outlineNote:'节奏为慢生活流——低外部冲突、少大起大落，冲突是细碎生活矛盾；剧情推进极慢，聚焦人物感受、生活细节、人际关系；爽点来自安宁烟火与人物陪伴，非升级逆袭；主线简述在写正文阶段独立生成。',
    chapterNote:'遵循慢生活流——聚焦日常生活与人物相处，不追求强冲突；剧情推进慢、冲突多为细碎小事；细腻刻画感官与情绪、烟火气与陪伴感；爽点来自安宁与温暖，而非打脸逆袭。',
    desc:'种田/日常/治愈：低外部冲突、少大起大落，冲突是细碎生活矛盾；推进极慢，聚焦感受、细节、关系。',
    mech:'以日常与生活矛盾代替强冲突，推进极慢；爽点来自安宁烟火与人物陪伴。',
    fit:'种田、日常、治愈、慢热的温馨长篇；读者追求沉浸与陪伴而非刺激。',
    effect:'氛团队入手温柔治愈、黏性高、抗弃文；代价是追读节奏需靠情感维系。' },
  { id:'mystery', name:'悬疑解谜流', tag:'悬念悬置', short:'悬疑解谜', src:'正统 · 悬疑推理节奏',
    outlineNote:'节奏为悬疑解谜流——冲突不快速解决，故意压住答案、延迟兑现；不断抛谜团线索、危机接踵但不揭真相；旧问题搁置、释放留到中后期；主线简述在写正文阶段独立生成。',
    chapterNote:'遵循悬疑解谜流——答案要压住，冲突不要立刻收束；不断抛谜团与线索，危机接踵但不揭真相；旧问题先搁置，答案压住不揭。',
    desc:'悬念悬置：冲突不快速解决、故意压住答案、延迟兑现；不断抛谜团线索、危机接踵但不揭真相。',
    mech:'正统悬疑节奏是“悬置＞即时解决”：埋下悬念、转开视角、旧问题搁置、释放拖到中后期。',
    fit:'悬疑、推理、解谜、谍战类长篇；读者重“猜中/揭晓”的智力快感。',
    effect:'抓人、让人放不下、揭晓时爆点强；代价是伏笔回收要求高，烂尾风险大。' },
  { id:'epic', name:'群像史诗节奏', tag:'宏大史诗', short:'群像史诗', src:'历史 · 宏大奇幻节奏',
    outlineNote:'节奏为群像史诗——不以单一主角得失为节奏开关，视角在多人间切换；主角会失败、配角命运独立；大事件周期长、一卷几十章才完成一次大起落；主线简述在写正文阶段独立生成。',
    chapterNote:'遵循群像史诗——视角在多人间切换，不以单一主角成败为节奏开关；主角也会失败、配角命运独立；大事件跨度长、不追求每章小爽点；多线并进、交织成时代洪流。',
    desc:'历史/宏大奇幻：不以单一主角得失为节奏开关，视角在多人间切换、配角命运独立、大事件周期长。',
    mech:'大事件以卷为单位起落，视角多线切换，主角可失败、配角命运独立，格局宏大。',
    fit:'历史演义、宏大奇幻、权谋群像类长篇；读者重世界构建与时代感。',
    effect:'格局与史诗感强、人物群像丰满、可承载大世界；代价是个体代入感弱、节奏偏慢。' },
  { id:'fatal', name:'悲剧宿命流', tag:'命运悲剧', short:'悲剧宿命', src:'文学 · 悲剧节奏',
    outlineNote:'节奏为悲剧宿命——努力≠胜利、结局被命运预先约束；抗争不一定换来圆满，一次次抗争爬升迎短暂光亮再跌落；情绪很少彻底宣泄、留有怅然；主线简述在写正文阶段独立生成。',
    chapterNote:'遵循悲剧宿命——抗争不一定换来圆满，努力可能徒劳；爬升后迎短暂光亮再跌落；情绪很少彻底宣泄、刻意留怅然与无力感，让悲剧宿命感贯穿。',
    desc:'努力≠胜利、结局被命运预先约束：抗争不一定圆满，一次次爬升迎短暂光亮再跌落；情绪少有宣泄、留怅然。',
    mech:'以“命运不可抗”为底色，抗争服务于悲剧张力而非胜利；情绪罕有彻底宣泄。',
    fit:'悲剧、宿命、史诗型沉重作品；读者重情绪厚重感与命运叩问。',
    effect:'情感厚重、后劲足、文学性强；代价是致郁、不适配追求爽感的读者。' },
  { id:'inward', name:'文艺向内流', tag:'心理向内', short:'文艺向内', src:'文学 · 心理向节奏',
    outlineNote:'节奏为文艺向内——节奏由内心驱动，外部事件只是载体；冲突多发生在心里，剧情推进慢、大事件少，重点是人物纠结、自我认知与情感变化；主线简述在写正文阶段独立生成。',
    chapterNote:'遵循文艺向内——节奏由人物内心驱动，外部事件仅是载体；冲突多在心理层面；推进慢、大事件少；着力刻画纠结、自我认知与情感变化、文笔细腻。',
    desc:'情绪/心理向：节奏由内心驱动，外部事件是载体；冲突多在心里，推进慢、大事件少，重纠结与自我认知。',
    mech:'以内心冲突代替外部事件驱动叙事，细腻刻画人物情绪与认知变化。',
    fit:'文艺、情感、成长类长篇；读者重文笔、情绪共鸣与人物内省。',
    effect:'文笔与情绪质感强、人物立体、差异化明显；代价是节奏慢、爽点少，需要读者耐性。' }
];

const RHYTHM_IDS = RHYTHMS.map(r=> r.id);

// 章节标题风格（可多选；不选则大纲阶段不注入任何标题要求，标题由 AI 自由发挥）
const TITLE_STYLES = [
  { id:'summary',  name:'归纳', tag:'归纳概括', short:'归纳', src:'自定义 · 标题风格',
    desc:'标题能概括本章核心事件，读者看标题即知本章讲什么。',
    mech:'要求 AI 以本章核心事件/情节推进为基准拟题，标题与内容强对应。',
    fit:'追求"目录即导览"、读者快速定位剧情的作品。',
    effect:'标题信息密度高、便于检索回顾；代价是可能牺牲悬念感。',
    note:'章节标题须具备归纳作用：能概括本章核心事件，读者看标题即知本章讲什么，忌与内容脱节。' },
  { id:'point',    name:'画龙点睛', tag:'点题升华', short:'点睛', src:'自定义 · 标题风格',
    desc:'标题点出本章主题与情感内核，用双关/象征/意境词升华。',
    mech:'要求 AI 提炼本章情感与主题落点，用一个点睛词或意象完成升华。',
    fit:'情感向、主题鲜明、追求回味与记忆点的作品。',
    effect:'标题有回味与张力、记忆点强；代价是需要主题先行、对 AI 提炼要求高。',
    note:'章节标题须画龙点睛：点出本章主题与情感内核，可用双关、象征或意境词升华，忌平铺直叙。' },
  { id:'literary', name:'文学语句', tag:'诗化表达', short:'文学', src:'自定义 · 标题风格',
    desc:'标题用诗化、意象或典故化表达，讲究语言美感与余韵。',
    mech:'要求 AI 以文学笔法拟题（诗化/意象/典故），拒绝大白话。',
    fit:'文风典雅、追求整体气质的作品。',
    effect:'标题有文学美感、辨识度高；代价是可能与"归纳"取向冲突、需把握分寸。',
    note:'章节标题须有文学语句质感：采用诗化、意象或典故化表达，讲究语言美感与余韵，而非大白话。' },
  { id:'neat',     name:'字数工整', tag:'字数统一', short:'工整', src:'自定义 · 标题风格',
    desc:'全书每章标题字数统一，整齐有节奏。',
    mech:'要求 AI 全书标题保持相同字数（建议 4-6 字，可对仗）。',
    fit:'追求形式美、目录整齐划一的章回体/古风作品。',
    effect:'目录整齐、节奏感强；代价是字数约束下拟题难度上升。',
    note:'章节标题须字数工整：全书每章标题字数统一（建议 4-6 字，可对仗），整体整齐有节奏感。' }
];
const TITLE_STYLE_IDS = TITLE_STYLES.map(s=> s.id);

// v10.18 标题风格(tone)/梗概风格(texture) 残留分组已移除（v11）：TONE_TITLE_STYLES / TEXTURE_PLAN_STYLES 不再参与写作风格库与注入。

/* =========================================================
 * v2.0 / v10.17 写作风格选择器：内置词库 29 项，v10.17 起全部归入「章节风格(element)」组；v10.21 节奏与网感新增 6 项、语言质感新增 5 项、情绪与张力新增 5 项，内置合计 45 项
 * 组别：v11 起仅保留「章节风格(element)」一组，由用户所选词条按五大类 cat 分块展示。
 * 注入：章节正文用完整章节风格（buildChapterSys/chapterStyleNote）；全书规划师用轻量名列表（writeStyleNamesBlock）。
 * 每项 note 为可执行 AI 指令；注入时统一附加一致性红线。
 * ========================================================= */
const WRITE_STYLES = [
  // 写作风格词库·按五大类文风（cat）。均归入 element（章节风格）组，供章节正文生成时注入。
  // ============ ① 语言质感 ============
  { id:'wenyi',  group:'element', cat:'语言质感', name:'文艺/范儿',
    note:'意象化、通感、抒情长句、留白，重氛围轻情节（如张嘉佳、琼瑶式）。',
    tips:['多用意象化与通感修辞','抒情长句铺陈心境，节奏舒缓','点到为止，留白让余味生长'],
    avoid:['情节推进过急','直白说破情绪'],
    check:['氛围优先于情节','有 1-2 处可回味的句子'],
    demo:'散场后影厅的灯一瞬亮起，红绒座椅一排排空下去，像退潮的海。他坐在最后一排，等字幕走完，才把攥了一整场的手，慢慢松开。' },
  { id:'ornate', group:'element', cat:'语言质感', name:'华丽辞藻',
    note:'排比、对仗、四字词、浓墨重彩的画面铺陈。',
    tips:['多用排比、对仗、通感','用四字词与色彩意象铺陈','句子密度与节奏感并重'],
    avoid:['华丽但空洞（只有形容词没有实义）','堆砌到影响阅读'],
    check:['至少 2 处排比/对仗','辞藻服务于画面与情绪'],
    demo:'暮色像一匹被揉皱的绸缎，摊在山脊上，流光一寸寸洇开。' },
  { id:'minimal',group:'element', cat:'语言质感', name:'极简/冷峻',
    note:'短句、白描、不抒情，靠动作和留白传达（海明威式）。',
    tips:['短句、白描、删冗余','情绪用动作与环境暗示','把余味留给读者'],
    avoid:['直白喊出情绪','大段心理独白'],
    check:['情绪段落少于直接描写','无直白情绪标签'],
    demo:'他把刀擦干净，放回架子上。窗外雨没停。' },
  { id:'poetic', group:'element', cat:'语言质感', name:'诗化散文化',
    note:'段落像写诗，长短句错落，节奏淡雅。',
    tips:['段落如诗分行，长短句错落','用淡雅意象营造氛围','节奏舒缓、留白多'],
    avoid:['通篇无叙事推进','堆砌意象失去中心'],
    check:['文字有诗性','节奏淡雅不拖沓'],
    demo:'晨雾里，早班的船离了岸。橹声一下，一下，像在江面上，把昨夜的话一句句抹平。岸上有人立了很久，直到雾把船和人一起收走。' },
  { id:'euro',   group:'element', cat:'语言质感', name:'翻译腔/欧美范',
    note:'长定语从句、欧式标点、西式叙述节奏。',
    tips:['长定语从句与倒装','欧式破折号、分号连接','西式冷静的叙述距离感'],
    avoid:['生硬到读不通','堆砌从句失去节奏'],
    check:['有西式笔调','可读性不牺牲'],
    demo:'她把那份写了很久、又反复修改、最终也没能寄出去的告别信，连同那枚旧贝壳，一起锁进那口棕色的、她从童年起就没再打开过的箱子。' },
  { id:'classic',group:'element', cat:'语言质感', name:'古风文言',
    note:'文言字句、古韵气息，骈散兼用，含蓄蕴藉。',
    tips:['以凝练文言与四六骈句铺陈','动词古雅（顾、掷、敛、挑灯）','对话带古白话韵味，不全程掉书袋'],
    avoid:['生僻掉书袋','古腔盖过剧情可读性'],
    check:['读来有古意不晦涩','用词贴合人物身份'],
    demo:'孤鸿声里，城门缓缓阖上。他负手立于城楼，望那盏渐远的灯，终究没说一句留字。' },
  { id:'folktale',group:'element',cat:'语言质感', name:'市井评书腔',
    note:'说书人腔、话本俚俗、烟火锅气，热闹有人味。',
    tips:['以说书人视角交代，带"话说""且听"的烟火话茬','俚语俗谚与市井行话点人点事','节奏热络、听感活泛'],
    avoid:['盲目复古腔调失真','俚俗过度显油滑'],
    check:['读来像听故事','市井气服务于人物环境'],
    demo:'那王二麻子，是方圆十里出了名的抠门主儿——上他家讨口水喝，都得听他把水瓢掂量三回。' },
  { id:'epic',group:'element', cat:'语言质感', name:'史诗庄重',
    note:'沉着宏阔、碑文式质感，字句有时间的重量。',
    tips:['铺陈用宏大意象（山河、长夜、星海）','句式沉稳、节奏凝重','关键处用克制笔法写大事件'],
    avoid:['空洞的大词堆砌','沉重到拖沓'],
    check:['有厚重史诗感','宏阔处仍有具体细节穿透'],
    demo:'星海横贯头顶，是他的国；脚下冻土延展，也是他的国。一将功成，不过是这漫漫长夜里，那些无名者共用的名字。' },
  { id:'airy',group:'element', cat:'语言质感', name:'轻盈灵动',
    note:'明快清新、短句跳跃、俏皮生趣，读来轻快。',
    tips:['短句快行、节奏轻快','比喻清新俏皮、有少年气','对话灵动带小机锋'],
    avoid:['轻飘无实义','俏皮过度发腻'],
    check:['读来轻快不觉累','明快中不失真情'],
    demo:'她把作业本往桌上一拍，像只炸了毛的小猫，眉毛竖得能挂三斤酱油。' },
  { id:'cutting',group:'element', cat:'语言质感', name:'锋利冷冽',
    note:'犀利讽刺、刀刃句式、冷静不留情面。',
    tips:['短句见锋，一句切中要害','冷静语气说狠话，反差更利','讽刺藏在客观陈述里'],
    avoid:['泼妇式叫骂','为毒而毒失分寸'],
    check:['不语带脏字也伤人','锋芒服务于立场交锋'],
    demo:'他的道歉和他的承诺一样廉价——都只够说出口，不够兑现。' },
  // ============ ② 情绪与张力 ============
  { id:'suspense2',group:'element',cat:'情绪与张力', name:'悬疑压抑',
    note:'名词化、阴冷意象、制造不安感的用词。',
    tips:['制造信息差（读者知道得比角色少或多）','句尾留悬念钩子','环境意象偏暗、紧绷'],
    avoid:['提前泄底','为悬疑而故弄玄虚（逻辑不通）'],
    check:['段落间有悬念牵引','悬念符合逻辑、可回收'],
    demo:'他每天下班都路过那家窗贴磨旧、却从不见人进出的花店。今晚他忍不住推门——门没锁，柜台后的墙上挂着一排照片，每一张，都拍的是他。' },
  { id:'sweet',  group:'element', cat:'情绪与张力', name:'甜宠/温柔',
    note:'细腻心理、绵软对话、小动作描写。',
    tips:['多写微小动作与眼神','对话温和、有生活气','细节传递温度'],
    avoid:['刻意煽情','甜腻到失真'],
    check:['有生活细节体现温度','情感自然不煽情'],
    demo:'她随口说想吃那家老店的糖炒栗子。他没答话，第二天下班拎了一袋回来，隔着纸袋还是热的——袋上，他认认真真写了"趁热"两个字。' },
  { id:'heartwarm',group:'element',cat:'情绪与张力', name:'虐心催泪',
    note:'情感落差、写泪点、克制中爆发。',
    tips:['铺垫情感、制造落差','写泪点时克制不喊叫','在高点克制收束'],
    avoid:['全程强行煽情','情绪喊口号化'],
    check:['有清晰情感高点','泪点自然、铺垫足够'],
    demo:'奶奶把存折交给他，说密码是他的生日。他翻到最后一页才看清存款时间——整整三十年前，正是他出生的那年。那笔钱，她替他攒了一辈子。' },
  { id:'flame',  group:'element', cat:'情绪与张力', name:'热血燃动',
    note:'情绪爆发＋动作节奏带出「燃」，靠张力推进不靠血腥。',
    tips:['动作链密集、节奏如鼓点','短促有力的句式让语气一路走高','以意志力、逆袭转折点燃情绪，不依赖血腥'],
    avoid:['血腥暴力与感官刺激堆砌','喊口号式的假燃','靠场面硬撑而无人物情绪'],
    check:['有清晰的情绪沸点','热血但不越界','燃来自人物选择而非血腥'],
    demo:'一剑破空，少年不退反进，眼底燃起整座江湖的灯。' },
  { id:'zhanshi', group:'element', cat:'情绪与张力', name:'写实战争纪实',
    note:'写实战场实感、群像牺牲、冷峻不煽情的纪实悲壮。',
    tips:['战地细节写实、炮火烟尘与噪声具体','群像式牺牲、点到为止不渲染','冷峻克制、用个别镜头折射整体'],
    avoid:['英雄化、个人光环凌驾群像','血腥刺激堆砌','煽情喊口号'],
    check:['有战场实感与氛围','牺牲有分量不廉价','冷静呼吸、不靠煽动'],
    demo:'担架从泥泞里抬过去，谁也没停。枪声一响，他们又都趴回了开阔地。' },
  { id:'terror', group:'element', cat:'情绪与张力', name:'惊悚寒气',
    note:'具象的感官恐惧、细思极恐、寒意入骨。',
    tips:['用触感/听觉营造阴冷（汗毛、脚步声、指甲刮过）','未知比具象更毒，先露一角','恐怖藏在日常细节里'],
    avoid:['血腥猎奇堆砌','一惊一乍而无逻辑'],
    check:['读完后背发凉','恐怖有来源可解释'],
    demo:'他数完最后一级台阶，楼道灯忽然熄灭。黑暗里，有什么正跟着他的步子——他停，那声音也停；他走，那声音贴在他身后，也走。' },
  { id:'warmth', group:'element', cat:'情绪与张力', name:'温情治愈',
    note:'亲情友情的平淡暖意，柴米油盐里的光。',
    tips:['细写照顾、牵挂、笨拙的表达','暖藏在克制与日常里，不喊口号','一个细节点亮一个场景'],
    avoid:['强行煽情','甜腻到失真'],
    check:['读来心里发烫','暖点有生活依据'],
    demo:'她加班到深夜，桌角放着一碗还冒热气的面，碗边压着张纸：趁热吃。她抬头，对面那位总说"你天天不落屋"的保洁阿姨，正假装在擦她早该擦完的那块玻璃。' },
  { id:'standoff', group:'element', cat:'情绪与张力', name:'对峙张力',
    note:'两方角力、一触即发、空气凝住的压迫。',
    tips:['从动作/物件写紧绷（手按枪柄、茶水渐凉）','对话句句试探、句句留尾','用细节的"没发生"代替爆发'],
    avoid:['一上来就摊牌','张力被废话稀释'],
    check:['全程心悬着','对峙有翻盘可能'],
    demo:'他与她隔桌对坐，谁也没碰那盏茶。窗外蝉鸣陡然一停，空气像被抽干——他咽了口唾沫，那一声响，在寂静里放大如雷。' },
  { id:'melancholy', group:'element', cat:'情绪与张力', name:'苍凉悲怆',
    note:'苍茫宿命、万物有时，厚重的悲怆余味。',
    tips:['用时间与物候的流逝写无力（残碑、西风、老树）','悲在点到为止，不泣不成声','以"无归"收束，留下苍凉'],
    avoid:['滥情哀嚎','为悲而悲脱离事件'],
    check:['悲怆有重量感','克制中透出宿命感'],
    demo:'他蹲在旧碑前，指腹一点点抚过那些名字。风过，草伏下去又立起来，像是替他一排排地，给每个名字鞠了一躬。' },
  { id:'thrill', group:'element', cat:'情绪与张力', name:'惊心动魄',
    note:'千钧一发的生死瞬间、大事件高峰的震动。',
    tips:['倒计时式紧迫（再零点几秒就…）','用瞬间抉择压缩张力','高潮后留一帧静默回响'],
    avoid:['全程紧崩到麻木','为震撼而失真'],
    check:['读时屏住呼吸','高潮有回响'],
    demo:'他按下的不是按钮，是整座城的命。警报倒数最后一声时，他闭上了眼——然后睁开的，是响起的钟声。' },
  // ============ ③ 节奏与网感 ============
  { id:'fast',   group:'element', cat:'节奏与网感', name:'爽文/快节奏',
    note:'短段落、强动作链、钩子密集、打脸反转。',
    tips:['短段落、信息密度高','动作链推进、钩子密集','打脸反转干脆'],
    avoid:['长句拖慢节奏','仅爽无逻辑'],
    check:['平均句长偏短','节奏有快慢变化'],
    demo:'评委按下淘汰键。他反手把U盘插进主机。全场以为他在作死——三分钟后大屏弹出那段从未公映的预告片，满座哗然：他才是那部片的原作者。' },
  { id:'webman', group:'element', cat:'节奏与网感', name:'网文口语化',
    note:'"咱""咋""整点"这类方言口语、接地气。',
    tips:['用接地气口语','短句、像说话','贴近生活原声'],
    avoid:['文绉绉书面语','生硬翻译腔'],
    check:['读起来像听人说话','口语自然不违和'],
    demo:'老板娘扯着嗓子喊："小师傅，麻辣烫要辣不？"他头也不抬："辣！整大份，莫放香菜，多整两勺油辣子！"' },
  { id:'roast',  group:'element', cat:'节奏与网感', name:'逗趣吐槽',
    note:'吐槽回环、毒舌、冷幽默（偏"解说式吐槽"）。',
    tips:['冷幽默旁观者视角','一本正经说反话的拆台式吐槽','毒舌但留分寸'],
    avoid:['刻薄伤人的恶意嘲讽','吐槽脱离剧情变成作者乱入'],
    check:['吐槽符合人物视角','无恶意攻击'],
    demo:'他说他要开始健身了。我看了眼他怀里那袋薯片，他说这是低卡的。我点点头：对，低卡到只够长在你最不常用的那块肉上。' },
  { id:'sliceoflife',group:'element',cat:'节奏与网感', name:'慢节奏生活流',
    note:'长句舒缓、日常细节、流水账式的治愈感。',
    tips:['长句舒缓','写日常细节与烟火气','节奏慢、治愈感'],
    avoid:['节奏拖沓无信息','平淡到无趣'],
    check:['细节有生活气息','读来治愈不焦躁'],
    demo:'傍晚他去买馒头，老板娘多塞了他一根油条，说是刚出锅的。他回家掰开馒头夹上油条，就着一碗滚烫的豆浆慢慢吃完，天正好黑下来。' },
  { id:'breathe',group:'element',cat:'节奏与网感', name:'张弛起伏',
    note:'快慢交替、张弛有度，情绪张满后给回气口。',
    tips:['激烈桥段后接舒缓过渡，避免全程崩弦','单章内安排1-2次情绪高低谷','节奏服务情绪，快慢都有目的'],
    avoid:['全程高能致疲劳','拖沓无高潮'],
    check:['快慢有对比','张弛有度不闷'],
    demo:'枪声刚落，只剩瓦砾里忽明忽暗的火——他忽然很想抽一会儿烟。' },
  { id:'staccato',group:'element',cat:'节奏与网感', name:'顿挫短句',
    note:'多短句、多句号、顿挫压迫，紧张感靠断句砸出来。',
    tips:['短句密集、句号敲击节奏','关键动作用破折号或单字短句定格','对白惜字加句读制造压迫'],
    avoid:['长句堆叠泄气','顿挫变碎碎念'],
    check:['读来有敲击感','氛围紧绷不碎'],
    demo:'灯灭了。门动了。枪，上了膛。他一动不动。' },
  { id:'shot',group:'element',cat:'节奏与网感', name:'画面分镜',
    note:'镜头语言进文字：切镜、推拉、特写、蒙太奇，画面感强。',
    tips:['靠镜头视角切换组织画面','大场面用推拉/俯瞰再切特写','关键处停格特写留画面'],
    avoid:['镜头跳切无联接','纯描写拖节奏'],
    check:['画面在脑中成像','切镜服从叙事'],
    demo:'镜头从燃着的舰队拉远，落在滩头一双攥紧步枪的手上——那只手在抖。' },
  { id:'meme',group:'element',cat:'节奏与网感', name:'玩梗共鸣',
    note:'适度当代网络梗、表情包化表达，提升年轻网感共鸣。',
    tips:['梗服务于人物与情绪，不做作者乱入','用"懂的都懂"式轻梗，不用陈年老梗','一处1-2个足够，密必俗'],
    avoid:['老梗陈词','梗盖过剧情'],
    check:['无梗也能读懂','梗符合人物身份'],
    demo:'他盯着那条消息看了三遍，缓缓打出一个"6"。' },
  { id:'oneliner',group:'element',cat:'节奏与网感', name:'爆点金句',
    note:'在名场面制造一句被记住、可转发的经典台词。',
    tips:['关键转折前铺垫，台词落在一击上','简洁有锋芒，可独立成句','金句说透情绪，不只耍帅'],
    avoid:['句句都是金句反成废话','为金句硬造'],
    check:['单拎出来仍有味道','贴合人物口吻'],
    demo:'"他们都叫我无名氏，可我记得每个名字。"' },
  { id:'punchline',group:'element',cat:'节奏与网感', name:'三连递进',
    note:'三点递进式爆点：铺垫→升格→砸点，笑点/爽点有结构。',
    tips:['先铺垫再翻一转二再砸底','第二/第三点必须递进更强','结尾落点干脆不拖'],
    avoid:['三连平铺无递增','砸底拖泥带水'],
    check:['一层比一层响','落点干脆'],
    demo:'第一次叫错，他笑了；第二次叫错，他黑了脸；第三次——他教那人把名字写在自己的拳头里。' },
  // ============ ④ 叙事技法 ============
  { id:'nonlinear',group:'element',cat:'叙事技法', name:'非线性插叙',
    note:'时间跳跃、倒叙插叙、视角切换的笔法。',
    tips:['倒叙/插叙布局时间线','适时视角切换','留悬念、逐步揭开'],
    avoid:['时间线混乱难懂','为炫技而跳跃'],
    check:['读者能看懂时间线','插叙服务悬念与情感'],
    demo:'多年后他整理父亲的遗物，翻出一张褪色的火车票：终点是当年他离家那晚没到的地方。他想起来了——那晚父亲追出去，其实一直追到了站台。' },
  { id:'multipov',group:'element',cat:'叙事技法', name:'多视角群像',
    note:'视角切换带来的文体变化。',
    tips:['多角色视角切换','各视角文体略有差异','用视角差制造信息差'],
    avoid:['视角混乱','众角色声音雷同'],
    check:['视角切换清晰','各视角有辨识度'],
    demo:'她在台上笑得落落大方，转身时长裙扫过。站在二楼的他，看见的却是她攥住裙摆的手，指节白了一瞬——那是她说不出口的那记再见。' },
  { id:'jinyong', group:'element', cat:'叙事技法', name:'金庸武侠风',
    note:'白话为骨、清隽文雅，重侠义风骨与「武即德」，打斗点到即止。',
    tips:['文白相间但以白话为主，清朗不拗口','对白见人物心性，谈笑间立场分明','武学重在招如其人、胜负系于胸襟与抉择'],
    avoid:['通篇文言掉书袋','靠境界/数据堆战力而无人格','招式浮夸只剩热闹'],
    check:['打斗不靠数值堆砌','人物立得住、侠义贯穿','武与德互为表里'],
    demo:'他这一剑不伤人，只想破开迷障问一句——当年的恩怨，可曾有半分真假？' },
  { id:'cosmic', group:'element', cat:'叙事技法', name:'克苏鲁/神秘叙事',
    note:'慢热、不可名状的形容、氛围堆叠而非直接说明。',
    tips:['慢热铺垫、氛围堆叠','描述不可名状的怪诞','不直接说明，留神秘'],
    avoid:['直接点破诡异真相','描写喧宾夺主'],
    check:['氛围压抑、层层递进','神秘感不流失'],
    demo:'山谷里的小旅馆只住了他一个客人。后半夜，楼道尽头传来敲门声，两下，停，一下。他壮胆开门——走廊空无一人，而他插在门内侧的那把反锁钥匙，不知何时，已经被拔掉了。' },
  { id:'fan',    group:'element', cat:'叙事技法', name:'魔幻奇幻史诗',
    note:'魔法奇观、异界冒险、史诗宿命，奇幻世界观从容自洽。',
    tips:['魔法与异界设定自洽、有内在法则','经典奇幻的大格局与使命宿命','冒险推进带史诗感、旅程即成长'],
    avoid:['设定堆砌只炫世界','奇幻沦为无敌光环','格局大却空泛'],
    check:['世界法则自洽','冒险有史诗张力','设定服务人物与使命'],
    demo:'山脚的灯一盏盏亮起，他握着旧魔杖站在岔路出口：预言说的是他，可他只想先救下那个女孩。' },
  { id:'space',  group:'element', cat:'叙事技法', name:'宇宙史诗/星际文明',
    note:'放大星空与文明兴衰的宏大尺度，用异族视角与技术奇观铺陈未知。',
    tips:['把尺度拉到星海与文明兴衰的跨度','用技术奇观、异族视角制造宇宙感与疏离','让高于个人恩怨的文明命题作底'],
    avoid:['沦为地球都市科幻','堆设定与数据、只炫科技','把外太空当猎奇背景而无文明内核'],
    check:['有宇宙尺度与想象力','设定服务于主题','文明命题能立住'],
    demo:'当那艘沉寂了一万年的方舟重新亮灯，瞭望塔上最后一个人类忽然明白：我们从未孤独。' },
  { id:'sus3',   group:'element', cat:'叙事技法', name:'科幻惊悚衍生态',
    note:'高科技下的危险美学，惊颤与悬念延续而非设定堆砌。',
    tips:['以技术奇观放大未知威胁','惊悚源自科技的失控与人性','慢热铺垫、悬念层层加码'],
    avoid:['堆设定与术语','靠突然惊吓混悬念','高科技沦为背景板'],
    check:['威胁具体可感','悬念持续推进','科技与人性的张力兼顾'],
    demo:'培育缸里那头东西睁开眼，第一反应不是逃，而是隔着防爆玻璃，安静地打量他。' },
  // ============ ⑤ 台词设计 ============
  { id:'jifeng', group:'element', cat:'台词设计', name:'机锋对白',
    note:'短促交锋、话里有话（谍战、职场戏）。',
    tips:['对话短促交锋','话里有话、潜台词丰富','用停顿与留白施压'],
    avoid:['对白直白无张力','所有角色雷同'],
    check:['对话有子面冲突','潜台词清晰可读'],
    demo:'"你早该走了，为什么还留着？""你这话，是想我走，还是怕我听出你舍不得？"他笑了笑，把她面前那杯凉掉的茶，轻轻往她那边推了推。' },
  { id:'cross',  group:'element', cat:'台词设计', name:'插科打诨',
    note:'荤素不忌的相声式对白。',
    tips:['相声式插科打诨','对话热闹、包袱密集','符合人物身份场合'],
    avoid:['低俗失度','为逗而逗脱离剧情'],
    check:['笑点长在人物身上','不失分寸'],
    demo:'"都说了我这人不记仇。""那你上回怎么三个月没理老王？""怪他记性太好——把我早忘了的事，替他记了三个月的仇。"' },
  { id:'storyteller',group:'element',cat:'台词设计', name:'说书人腔',
    note:'旁白式"话说""且听我道来"的叙述介入。',
    tips:['旁白式"话说/且听我道来"','叙述者在场、带节奏','说书式点评与转场'],
    avoid:['旁白过度打断','腔调陈旧呆板'],
    check:['有说书节奏','旁白服务叙事'],
    demo:'话说这码头上，能叫整条船停下来等一个人的主儿，可不多。可这一位啊，偏偏就肯等；这一等，分别的，便成了一段十里八乡都讲不完的交情。' },
  { id:'moli',   group:'element', cat:'叙事技法', name:'无厘头喜剧',
    note:'荒诞夸张、无逻辑转折、错位自嘲，一本正经地胡说八道。',
    tips:['设置夸张与反差、笑点落在荒诞而非逻辑','一本正经说荒唐话、错位自嘲','梗密度高、节奏快、转场跳脱'],
    avoid:['刻意逻辑闭环','低俗恶搞无节制','为搞笑强加剧情'],
    check:['荒诞但有内在喜感','不流于恶俗','笑点服务于人物与剧情'],
    demo:'他认真地思考了三秒，然后很严肃地告诉我：人不能太有钱，因为容易长寿。' },
  { id:'shenghuo', group:'element', cat:'叙事技法', name:'生活情景喜剧',
    note:'家庭日常＋固定人物性格碰撞，误会化解保留温馨底。',
    tips:['生活场景、小冲突环环相扣','用人物固定性格制造笑点与误会','斗嘴后总会化解、留温情收尾'],
    avoid:['冲突升级成狗血','靠强设定硬造笑点','失去生活质感'],
    check:['笑点来自生活与人物关系','误会化解自然','温暖底色不丢'],
    demo:'妈妈问他为什么又考砸，他一本正经：老师把题出得太多，我一时没来得及焦虑。' },
  { id:'fangyan', group:'element', cat:'台词设计', name:'方言/口音区隔',
    note:'用方言俚语、口癖腔调让每个角色开口有辨识度，对话自带地域与身份。',
    tips:['给关键角色赋予标志性口癖与腔调','用少量方言俚语点出身与城，不整段方言','不同地角色用不同语言习惯拉开落差'],
    avoid:['全程方言、读者难读','所有角色腔调雷同','方言作为噱头却无人格'],
    check:['台词不用看名就能分人','方言服务于人物身份','可读性不因口音牺牲'],
    demo:'“听你这口音，是打潞州来的吧？”掌柜的搁下算盘，“俺们这儿不兴这个。”' },
  { id:'qinghua', group:'element', cat:'台词设计', name:'情话/浪漫对白',
    note:'含蓄走心、带诗意的浪漫对白，于细节处表深情。',
    tips:['话里有心意，点到即止不直白','借日常物象与细节表深情','留白，把余味交给读者'],
    avoid:['油腻直白的土味情话','空喊喜欢无行动落点','为美而美、脱离人物语气'],
    check:['含蓄但不晦涩','情出自细节、真实可感','符合人物身份口吻'],
    demo:'他望着她的眼睛，半天只说了句：“今年冬天的雪，我替你先堆好了。”' },
  { id:'yinghan', group:'element', cat:'台词设计', name:'冷峻短促/硬汉对白',
    note:'惜字如金、动作代答，暗示多于直陈的克制型对白。',
    tips:['句子短、信息密，能用一个字不用一句','用动作与沉默代替解释','威胁与真相藏进潜台词'],
    avoid:['废话连篇','情绪过分外露','为装酷而故作高深'],
    check:['每句对白都有信息量','沉默与动作在替人物说话','克制但不冰冷失温'],
    demo:'“去哪？”“走。”“还回来吗？”他没停步，扔下一句：“看运气。”' }
];
// v2.4 组合配方：一键把多个文风词条按层配齐（点击以「替换」方式覆盖当前选择），解决复合文类需多零件叠加的问题。
// 引用的 tags 均为 WRITE_STYLES 中真实存在的 id（经 writeStyleLib 校验）。
const WRITE_COMBOS = [
  { id:'comic',     name:'😆 轻喜剧',  desc:'对白机锋层层叠加诙谐拆台，笑点长在人物与话术上，不硬抖包袱。', tags:['jifeng','cross','roast'] },
  { id:'mystery',   name:'🕵️ 悬疑',   desc:'阴冷压抑＋非线性悬念逐步编织，靠信息差与伏笔牵引推理。', tags:['suspense2','nonlinear'] },
  { id:'burn',      name:'🔥 燃向',   desc:'快节奏加码＋强动作链与密集钩子，情绪与力度一路走高。', tags:['fast','flame'] },
  { id:'aesthetic', name:'🌸 唯美',   desc:'文艺意象＋诗化段落，抒情长句与留白共筑氛围。', tags:['wenyi','poetic'] },
  { id:'speed',     name:'⚡ 快节奏爽文', desc:'爽文节奏＋网文口语与机锋对白，段落短、信息密、不拖沓。', tags:['fast','webman','jifeng'] },
  { id:'moli-combo', name:'🤪 无厘头',     desc:'荒诞夸张、反差自嘲，梗密节奏快，笑点落在荒诞不落在逻辑。', tags:['moli','fast','cross'] },
  { id:'family',   name:'😂 欢脱日常',   desc:'家庭生活小冲突环环相扣，误会化解留温情，笑点来自关系和烟火气。', tags:['shenghuo','sliceoflife','cross'] },
  { id:'jianghu',  name:'🏮 江湖喜剧',   desc:'武侠外壳的生活喜剧：江湖群像斗嘴＋无厘头＋机锋，笑点在人情世故。', tags:['shenghuo','moli','jifeng'] },
  { id:'yosheng',  name:'🦖 侏罗纪式科幻', desc:'高科技惊悚＋冒险奇观：未知威胁延续悬念，科技失控处见人性。', tags:['suspense2','fast','sus3'] },
  { id:'gufeng',   name:'🏯 武侠古风',   desc:'金庸风骨＋古风文言，侠义作魂、古韵为衣，打斗点到即止。', tags:['jinyong','classic','flame'] },
  { id:'romance',  name:'💞 甜宠言情',   desc:'恋爱甜宠＋浪漫对白＋轻盈灵动，细节传情、小动作含糖。', tags:['sweet','qinghua','airy'] },
  { id:'epicfan',  name:'🏰 史诗奇幻',   desc:'奇幻冒险＋史诗厚重＋宇宙尺度，大格局世界观从容铺陈。', tags:['fan','epic','space'] },
  { id:'horror',   name:'👻 惊悚恐怖',   desc:'感官恐惧＋悬念压抑＋顿挫短句，寒意入骨、压迫步步收紧。', tags:['terror','suspense2','staccato'] },
  { id:'heal',     name:'💧 治愈温情',   desc:'平淡暖心＋慢节奏生活流＋轻快灵动，柴米油盐里的光。', tags:['warmth','sliceoflife','airy'] },
  { id:'scheme',   name:'⚔️ 权谋对峙',   desc:'一触即发＋锋利冷冽＋机锋对白，句句试探、胜负在话里。', tags:['standoff','cutting','jifeng'] },
];
// v2.5 组合删除支持：cfg.styleCustom.comboRemoved 记录被用户删除的组合 id；「恢复默认词库」会一并还原
// v10.28 自定义组合：cfg.styleCustom.customCombos 存用户「＋」新建的组合；并入可用列表，并过滤已被词库删除的词条引用
function availableCombos(){
  const c = getCfg().styleCustom || {};
  c.customCombos = Array.isArray(c.customCombos) ? c.customCombos : [];
  const removed = Array.isArray(c.comboRemoved) ? c.comboRemoved : [];
  const libIds = writeStyleLib().map(s=>s.id);
  const builtin = WRITE_COMBOS.filter(x=> !removed.includes(x.id));
  const mine = c.customCombos
    .map(x=>({ ...x, custom:true, tags:(x.tags||[]).filter(id=> libIds.includes(id)) }))
    .filter(x=> x.tags.length > 0);
  return builtin.concat(mine);
}
// —— AI 配方助手（v10.30 · 仅长篇小说模式；服务写作风格卡） ——
// 用户用一段话描述想要的风格/题材/氛围，AI 基于现有词库给出 2~5 个候选配方；
// 每候选含「为何这样选 / 适用场景 / 词条缺口」。缺口词条按词库完整规格返回，用户逐条确认入库，确认即纳入当前配方。
// seal 默认 0（不锁），与"词条加入词库后立即纳入当前配方"两处决策一致。
const AI_CAT_LABEL = { '语言质感':'① 语言质感', '情绪与张力':'② 情绪与张力', '节奏与网感':'③ 节奏与网感', '叙事技法':'④ 叙事技法', '台词设计':'⑤ 台词设计', custom:'⭐ 我的自定义' };
let aiRp = null; // {list:[...], err:'' } 运行期临时候选（不持久化；render 重建主卡时会保留，重启清空）
// —— v10.57 AI 配方历史快照存储（独立 key，与主 cfg 解耦；生成即存，供书本图标回看）——
const KEY_AIHIST = 'fyp_aiRecipeHist_v1';
const AIHIST_CAP = 30;                       // 快照条数上限
const AIHIST_MAX_BYTES = 3600000;            // 存储体积安全阈值（约 3.4MB）
function getAiHist(){ try{ return JSON.parse(localStorage.getItem(KEY_AIHIST)||'[]'); }catch(e){ return []; } }
function setAiHist(a){
  let list = Array.isArray(a) ? a.slice(-AIHIST_CAP) : [];
  let s;
  try{ s = JSON.stringify(list); }catch(e){ return; }
  while(list.length && s.length > AIHIST_MAX_BYTES){ list.shift(); s = JSON.stringify(list); }
  try{ localStorage.setItem(KEY_AIHIST, s); }catch(e){ /* 超限静默；设独立键，不影响主 cfg */ }
}
function addAiHist(entry){ const a = getAiHist(); a.push(entry); setAiHist(a); return a.length; }
function snapAiHist(){ return getAiHist(); }
function aiHistEntryId(){ return 'ah'+Date.now().toString(36); }
/* ---------- v10.59 随项目的 AI 建议快照（复刻配方历史的能力，存入 state、随项目存取） ---------- */
// kind: 'ct'  章节标题 AI 建议；'content'  重生成章节内容 AI 建议
function histState(kind){
  const s = state;
  if(kind === 'ct'){ if(!Array.isArray(s.ctAdviceHist)) s.ctAdviceHist = []; return s.ctAdviceHist; }
  if(kind === 'content'){ if(!Array.isArray(s.contentAdviceHist)) s.contentAdviceHist = []; return s.contentAdviceHist; }
  return [];
}
// 追加一条快照，逆序裁剪到 30 条上限并持久化
function addAdvHist(kind, entry){
  const a = histState(kind);
  a.push(entry);
  if(a.length > 30) a.splice(0, a.length - 30);   // 小体积文本，按条数截断即可
  persist();
  return a.length;
}
// 章节标题建议历史弹窗（复刻 openAiHistPanel；回填语义贴合两处：注入候选 + 回填首条到输入框）
function openAdvHistPanel(kind){
  const hist = histState(kind).slice();
  const mode = kind === 'content';
  const ov = document.createElement('div'); ov.id='advHistPanel'; ov.className='gs-overlay';
  const entHtml = (e,hi)=>{
    const ei = hist.length-1-hi;   // 倒序序号（与展示一致）
    return `<div class="ws-lib-group ws-lib-fold" style="margin-top:6px">
      <div class="ws-lib-fold-t" data-ah-fold="${ei}" role="button" tabindex="0" title="展开/收起">
        <span>${mode?'📄':'📝'} ${esc(e.desc||'')} <span class="muted" style="font-size:10px">· ${new Date(e.ts).toLocaleString('zh-CN',{hour12:false})}</span></span>
        <span class="sc-fold-ico">▸</span>
      </div>
      <div class="ws-lib-fold-body" style="display:none">
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 8px">
          <button type="button" class="btn small ghost" data-ah-apply="${ei}">↩ 回填首条建议</button>
          <button type="button" class="btn small ghost" data-ah-del="${ei}">删</button>
        </div>
        ${ (Array.isArray(e.list)&&e.list.length) ? e.list.map((c,i)=>aiAdvHistCandHtml(c,i)).join('<hr style="margin:6px 0;opacity:.2">') : '<p class="muted">无建议。</p>' }
      </div>
    </div>`;
  };
  const list = hist.slice().reverse();
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>${mode?'📄':'📝'} ${mode?'章节内容':'章节标题'} AI 建议历史（${hist.length}）</b>
        <span style="display:flex;gap:6px">
          <button class="btn small ghost" data-ah-clear>清空</button>
          <button class="gs-x" data-ah-close>✕</button>
        </span></div>
      <div class="cv-body">
        ${ list.length ? list.map(entHtml).join('') : '<p class="muted">暂无历史。用「✨ AI 优化此建议」生成后即自动保存于此，可随时回看。</p>' }
      </div>
    </div>`;
  const close = ()=>{ const p=$('#advHistPanel'); if(p) p.remove(); };
  ov.addEventListener('click', (e)=>{
    const cl = e.target.closest('[data-ah-close]'); if(cl){ close(); return; }
    const fold = e.target.closest('[data-ah-fold]');
    if(fold){ const body = fold.closest('.ws-lib-group').querySelector('.ws-lib-fold-body'); if(body){ const open = body.style.display!=='none'; body.style.display = open?'none':'block'; fold.querySelector('.sc-fold-ico').textContent = open?'▸':'▾'; } return; }
    const apply = e.target.closest('[data-ah-apply]');
    if(apply){
      const ei=+apply.dataset.ahApply; const entry=hist[ei];
      if(entry && Array.isArray(entry.list) && entry.list.length){
        if(mode){
          aiAdviceCand = entry.list.slice(0,3);
          const out = $('[data-advice-ai-out]'); if(out) out.innerHTML = aiAdviceResultHtml();
          const ta = $('#rpAdvice'); if(ta){ ta.value = (entry.list[0]&&entry.list[0].text)||''; ta.focus(); }
        }else{
          ctAdviceCand = entry.list.slice(0,3); ctAdviceFold = false; ctAdoptedIdx = -1;
          const out = $('[data-cth-ai-out]'); if(out) out.innerHTML = ctAdviceResultHtml();
          updateFoldBtn();
          const inp = $('#rtInput'); if(inp) inp.value = (entry.list[0]&&entry.list[0].text)||'';
        }
        toast('已回填该条建议');
      }
      close(); return;
    }
    const del = e.target.closest('[data-ah-del]');
    if(del){ const ei=+del.dataset.ahDel; const a=histState(kind); if(a[ei]){ a.splice(ei,1); persist(); } refreshAdvHistBadge(kind); const p=$('#advHistPanel'); if(p) p.remove(); openAdvHistPanel(kind); return; }
    const clr = e.target.closest('[data-ah-clear]');
    if(clr){ if(confirm('确认清空全部该建议历史？')){ histState(kind).length = 0; persist(); refreshAdvHistBadge(kind); close(); } return; }
    if(e.target===ov) close();
  });
  document.body.appendChild(ov);
}
// 历史条目候选的展示（{title,text}）
function aiAdvHistCandHtml(c,i){
  return `<div class="advice-ai-cand"><div class="advice-ai-head"><span class="advice-ai-idx">${'①②③'[i]||(i+1)}</span><b>${esc(c.title||('方案'+(i+1)))}</b></div><p>${esc(c.text||'')}</p></div>`;
}
// 刷新角标（kind：'ct' 在章节块内 / 'content' 在重生成面板内）
function refreshAdvHistBadge(kind){
  if(kind === 'ct'){
    const card = $('.ct-block');
    if(card){ const b = card.querySelector('[data-ctadv-hist] .ai-hist-badge'); if(b) b.textContent = histState('ct').length||''; }
  }else{
    const rp = $('#regenPanel');
    if(rp){ const b = rp.querySelector('[data-advadv-hist] .ai-hist-badge'); if(b) b.textContent = histState('content').length||''; }
  }
}
// v11 给 AI 配方助手注入本作书名/简介，让候选配方贴合本小说；无大纲时仅提示先生成。
// 4.7 Pro（3.6 原码）：资深风格工程师 + 写作配方设计师（输出可量化 styleContract）
const AI_RECIPE_SYS_PRO = `你是一位资深长篇小说「风格工程师」，同时为「写作配方设计师」。
【核心任务】根据用户描述或上传的主线简述，设计 2~6 个可直接落地的组合配方，并为每个配方输出可量化的「风格契约」。

【必须输出的 JSON 结构】
[
  {
    "name": "配方名（≤12字）",
    "desc": "一句话点明这套风格适用的题材/氛围",
    "tags": ["现有词库词条 id，2-5 个"],
    "styleContract": {
      "sentenceAvg": 28,
      "sentenceTolerance": 0.2,
      "dialogueRatio": 0.35,
      "dialogueTolerance": 0.1,
      "forbiddenPhrases": ["高频网文句式1", "高频网文句式2"],
      "preferredTransitions": ["转场方式1", "转场方式2"],
      "rhythmNote": "节奏说明：如紧张-舒缓交替、短句爆发、长句铺陈等"
    },
    "why": "为何这样选（中文引用词条 name，1-2句）",
    "scenario": "适用场景（题材/章节阶段/文风匹配度，1-2句）",
    "gap": null
    // 或 gap: [{"name":"...","cat":"...","id":"...","note":"...","tips":["..."],"avoid":["..."],"check":["..."],"demo":"...","reasons":"..."}]
  }
]

【硬性约束】
1. tags 只能使用现有词库 id；现有词库是基础参照、不是天花板：当现有词条无法覆盖用户诉求时，必须主动设计 1~3 个新词条放入 gap 补位（这是加分项，不是违规，大胆创造）。
2. styleContract 必填：sentenceAvg（平均句长，12-60 整数）、sentenceTolerance（0.1-0.5）、dialogueRatio（0-1）、dialogueTolerance（0.05-0.2）、forbiddenPhrases（数组）、preferredTransitions（数组）、rhythmNote（字符串）。
3. gap 为 null 表示现有词库足够；gap 非空时每个新词条必须五维齐全（note/tips/avoid/check/demo），缺一作废。
4. 不同候选用词尽量不同、风格拉开差异。
5. why / scenario / reasons 里引用词条时必须使用中文 name，禁止出现英文 id。
6. 只输出上述 JSON 数组，不要 markdown 代码块、不要解释。`;

function aiRecipeUser(extra){
  const o = state.outline || {};
  const head = (String(o.title||'').trim() && String(o.logline||'').trim())
    ? `【小说书名】${o.title}\n【小说简介】${o.logline}\n\n以下为该小说的写作风格配方设计请求：`
    : '（尚未生成大纲：为让 AI 依据本小说书名与简介设计更贴合的风格配方，建议先到「大纲」步生成书名与简介。）';
  return extra ? `${head}\n\n${extra}` : head;
}
function aiRecipePrompt(userDesc){
  const lib = writeStyleLib();
  const spec = lib.map(s=> `- ${s.id}：${s.name}（${s.cat||'custom'}）｜${String(s.note||'').slice(0,60)}`).join('\n');   // v228/P4：注入 note 摘要，AI 不再"只见名字不见味道"
  // 4.7 Pro（3.6）：system 换 AI_RECIPE_SYS_PRO + 现有词库 id/name/cat
  return { system: AI_RECIPE_SYS_PRO + '\n\n【现有词库 id/name/cat】：\n' + spec, user: aiRecipeUser(userDesc) };
}
// v1.0.62 上传主线简述 TXT → 判断该小说文风 → 给可模仿的写作配方（全文直发，不分段）
// 4.7 Pro（3.6）：同步换 PRO system（保留「完整通读主线简述」语境前缀）
function aiPromptFromOutline(text){
  const lib = writeStyleLib();
  const spec = lib.map(s=> `- ${s.id}：${s.name}（${s.cat||'custom'}）｜${String(s.note||'').slice(0,60)}`).join('\n');   // v228/P4：注入 note 摘要，AI 不再"只见名字不见味道"
  return { system:
    '你是资深长篇小说「风格工程师」。用户上传的是一部小说的【主线简述】TXT（非正文）。\n' +
    '请你【完整通读】这份梗概，判断该小说的文风、叙事节奏、对白与情绪质感，再为"想模仿这部小说写作"的用户设计 2~6 个可直接落地的组合配方。\n\n' +
    AI_RECIPE_SYS_PRO + '\n\n【现有词库 id/name/cat】：\n' + spec,
    user: aiRecipeUser(text) };
}
// v1.0.62 上传来源标记：'desc'＝描述入口 ／ 'outline'＝主线简述入口（仅用于结果区提示，不持久化）
let aiSource = 'desc';
// AI 配方助手卡片（仅长篇小说模式在渲染层调用）
function aiRecipeCard(){
  const lib = writeStyleLib();
  const collapsed = getCfg().aiRecipeCollapsed !== false; // v10.31 默认折叠，用户可随时展开；状态持久化
  return `<div class="card ai-recipe-card${collapsed?' collapsed':''}">
    <div class="ai-recipe-head" data-ai-recipe-fold role="button" tabindex="0" title="展开/收起">
      <h3 style="margin:0">🧪 AI 配方助手 <span class="sc-fold-ico">${collapsed?'▸':'▾'}</span></h3>
      <span class="muted" style="font-size:11px;font-weight:400">为「写作风格」而生 · 描述一段风格，或上传主线简述 AI 提炼配方</span>
    </div>
    <div class="ai-recipe-body">
      <div class="ai-desc-wrap">
        <span class="ai-upload-name" data-ai-upload-name></span>
        <textarea id="aiReDesc" rows="3" placeholder="用一段话描述你想要的风格/题材/氛围。例如：轻松治愈的都市言情，带点温馨笑料，配角俏皮，节奏明快。" style="width:100%;box-sizing:border-box"></textarea>
      </div>
      <div class="ai-recipe-tool">
        <button type="button" class="btn primary" data-ai-recipe-gen>✨ 生成配方</button>
        <button type="button" class="btn small ghost" data-ai-recipe-clear>清空</button>
        <button type="button" class="ai-upload-btn ai-hist-btn" data-ai-recipe-hist title="AI 配方历史：回看已生成过的候选配方">📖<span class="ai-hist-badge">${snapAiHist().length||''}</span></button>
        <button type="button" class="ai-upload-btn" data-ai-recipe-file title="上传主线简述TXT">＋</button>
      </div>
      <input type="file" id="aiReFile" accept=".txt,text/plain" hidden />
      <div data-ai-recipe-out>${ aiRecipeResultHtml(lib) }</div>
    </div>
  </div>`;
}
function aiRecipeResultHtml(lib){
  if(aiRp && aiRp.err) return `<p class="muted" style="color:var(--danger);margin:8px 0 0">⚠️ ${esc(aiRp.err)}</p>`;
  if(!aiRp || !Array.isArray(aiRp.list) || !aiRp.list.length){
    return `<p class="muted" style="margin:8px 0 0">${ aiSource==='outline' ? '📤 已读取主线简述，可点「✨」从描述入口，或重新上传后 AI 再次通读。' : '👆 输入描述后点「✨ 生成配方」，AI 将给出 2~6 个组合配方；词库覆盖不了时会附建议新词条（鼓励创造），可自行决定是否加入词库。' }</p>`;
  }
  // libIds 更新（可能已入库缺口词条）
  const libIds = (lib||writeStyleLib()).map(s=>s.id);
  return aiRp.list.map((c,ci)=>`
    <div class="ai-recipe-cand${ ci===aiRp.hi ? ' hi' : '' }">
      <div class="ai-recipe-cand-head">
        <b>${esc(c.name||('候选'+ (ci+1)))}</b>
        ${ recipeScBadge(c) }
        <span class="muted" style="font-size:11px">${esc(c.desc||'')}</span>
      </div>
      <div class="ai-recipe-tags">${ (c.tags||[]).map(id=>{ const s=writeStyleById(id); return `<span class="ai-recipe-tg">${esc(s?s.name:id)}</span>`; }).join('') }</div>
      <div class="ai-recipe-sec"><span class="ar-lab">为何这样选</span>${esc(wiseWhyText(c.why||''))}</div>
      <div class="ai-recipe-sec"><span class="ar-lab">适用场景</span>${esc(wiseWhyText(c.scenario||''))}</div>
      <div class="ai-recipe-gap">
        ${ gapHtml(c, ci) }
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn small primary" data-ai-recipe-pick="${ci}">✔ 选用此配方</button>
        <button type="button" class="btn small ghost" data-ai-recipe-save="${ci}" title="仅存入「我的配方」，不应用到写作风格">＋ 收藏不采用</button>
      </div>
    </div>`).join('');
}
// v10.52 gap 词条五维分列展示：优先用 AI 独立字段；老格式（note 内含写法/避免/自查）回退 parse 拆解
function gapFiveHtml(g){
  const hasStruc = Array.isArray(g.tips)||Array.isArray(g.avoid)||Array.isArray(g.check);
  const p = hasStruc
    ? { intro:g.note||'', tips:Array.isArray(g.tips)?g.tips:[], avoid:Array.isArray(g.avoid)?g.avoid:[], check:Array.isArray(g.check)?g.check:[], demo:g.demo||'' }
    : parseCustomStyleNote(g.note||'');
  const parts = [];
  if(String(p.intro||'').trim()) parts.push('<div><b>指令</b>：'+esc(p.intro)+'</div>');
  if(p.tips&&p.tips.length) parts.push('<div><b>写法</b>：'+esc(p.tips.join('；'))+'</div>');
  if(p.avoid&&p.avoid.length) parts.push('<div><b>避免</b>：'+esc(p.avoid.join('；'))+'</div>');
  if(p.check&&p.check.length) parts.push('<div><b>自查</b>：'+esc(p.check.join('；'))+'</div>');
  if(String(p.demo||'').trim()) parts.push('<div class="ar-gap-demo"><b>示例</b>：'+esc(p.demo)+'</div>');
  return parts.join('');
}
function gapHtml(c, ci){
  if(!Array.isArray(c.gap) || !c.gap.length) return `<span class="ar-ok">✓ 现有词库即可覆盖，无需新词条</span>`;
  return `<div class="ar-gaptitle">⚠️ 存在词条缺口（共 ${c.gap.length} 项，确认后立即纳入当前配方）</div>
  ${ c.gap.map((g,gi)=>`
    <div class="ai-recipe-gapitem">
      <div class="ar-gaphead"><b>${esc(g.name||'')}</b><span class="muted" style="font-size:11px">${ (AI_CAT_LABEL[g.cat]||g.cat||'custom') }</span></div>
      <div class="ar-gapwhy">${esc(g.reasons||'')}</div>
      <div class="ar-gapnote">${gapFiveHtml(g)}</div>
      ${ g.warning ? `<div class="ar-gapwarn">⚠️ ${esc(g.warning)}</div>` : '' }
      <button type="button" class="btn small ghost" data-ai-recipe-addgap="${ci}__${gi}" ${ (c.tags||[]).includes(g.id)|| libHas(g.id) ? 'disabled' : '' }>＋ 加入词库</button>
    </div>`).join('') }`;
}
function libHas(id){ return !!writeStyleById(id); }
// C①/D2：候选配方预校验风格契约。为每个候选标注 _scValid（是否有合格契约）与 _scCleaned（清洗后的契约）。
function prepRecipeList(list){
  if(!Array.isArray(list)) return list;
  list.forEach(c=>{
    if(c && typeof c==='object'){
      const cl = validateStyleContract(c.styleContract);
      c._scCleaned = cl;
      c._scValid = !!cl;
      // v228/P4：新词条（gap）五维齐全度标注——true=齐全 / false=有缺维；仅标注供候选卡提示，不强制丢弃（宁松勿误伤）
      c._gapOk = !(Array.isArray(c.gap) ? c.gap : []).some(n =>
        !n || !String(n.note||'').trim() || !(Array.isArray(n.tips) && n.tips.length) ||
        !(Array.isArray(n.avoid) && n.avoid.length) || !(Array.isArray(n.check) && n.check.length) ||
        !String(n.demo||'').trim());
    }
  });
  return list;
}
// C①：候选卡上的风格契约状态徽标（旧快照无 _scValid 时现场计算）
function recipeScBadge(c){
  const v = !!(c && (c._scValid !== undefined ? c._scValid : !!validateStyleContract(c.styleContract)));
  // v228/P4：新词条缺维提示（复用现有徽标样式，无 CSS 改动）
  const gb = (c && c._gapOk === false) ? `<span class="ai-recipe-sc bad" title="建议的新词条缺少 note/tips/avoid/check/demo 中的维度，入典前请补全">⚠ 词条缺维</span>` : '';
  return gb + `<span class="ai-recipe-sc ${v?'ok':'bad'}" title="带可量化的风格契约（正文按 L0 约束执行）">${v?'✓ 风格契约':'风格契约不足'}</span>`;
}
// D2：生成并预校验候选配方；若无任一候选带合格风格契约（强制必备），自动附修正指令重试 1 次。
async function aiRecipeProduce(system, user){
  const opt = { maxTokens: clampMaxTokens('json'), temperature:(getCfg().aiRecipeTemp==null?0.9:getCfg().aiRecipeTemp), topP:0.5 };
  const FIX = `\n\n【上一轮修正：风格契约必须合格】每个配方都必须带可量化的「风格契约」，且字段必须达标，否则该候选会被判为不合格而丢弃：
- sentenceAvg：平均句长，12-60 的整数；
- sentenceTolerance：0.1-0.5；
- dialogueRatio：对白占比，0-1 之间的数字；
- dialogueTolerance：0.05-0.2；
- forbiddenPhrases：禁用词，至少 3 条；
- preferredTransitions：偏好转场，至少 3 条；
- rhythmNote：节奏说明字符串。
- 含新词条（gap 非空）的配方：每个新词条必须五维齐全——note（一句话定位）、tips（≥2 条）、avoid（≥1 条）、check（≥1 条）、demo（示例句）。
请务必为每个候选给全、给对上述字段。`;
  let list = null;
  for(let attempt=1; attempt<=2; attempt++){
    const sys = attempt>1 ? String(system)+FIX : system;
    const raw = unwrapAIResult(await callDeepSeek(sys, user, Object.assign({}, opt, {taskKey:'recipe'})));
    const cands = prepRecipeList(parseAiJsonList(raw));
    if(Array.isArray(cands) && cands.length){
      list = cands;
      if(cands.some(c=>c && c._scValid)) break;   // 至少一个合格契约 → 接受
    }
  }
  if(!list || !list.length) throw new Error('AI 未返回有效配方，请重试');
  if(!list.some(c=>c && c._scValid)) throw new Error('候选配方均缺少合格风格契约，已达重试上限，请再试一次');
  return list;
}
// 生成候选配方
async function aiRecipeGen(){
  const ta = $('#aiReDesc'); if(!ta) return;
  const desc = (ta.value||'').trim();
  if(!desc){ toast('请先描述你想要的风格'); return; }
  const out = $('[data-ai-recipe-out]'); if(out) out.innerHTML = `<p class="muted" style="margin:8px 0 0">⏳ AI 正在根据你的描述设计候选配方与词条缺口……</p>`;
  const gen = $('[data-ai-recipe-gen]'); if(gen){ gen.disabled = true; gen.textContent = '生成中…'; }
  try{
    const {system, user} = aiRecipePrompt(desc);
    const list = await aiRecipeProduce(system, user);   // D2/C①：生成即预校验风格契约，全缺合格契约自动重试
    aiRp = { list, hi: 0 };
    // v10.57 生成成功即存历史快照（书本图标可回看；outline 由 aiRecipeFromOutline 存）
    if(aiSource !== 'outline') addAiHist({ id: aiHistEntryId(), ts: Date.now(), src:'desc', desc: desc, list: JSON.parse(JSON.stringify(list)), applied:[] });
  }catch(e){
    aiRp = { list:null, err: (e&&e.message)||'生成失败' };
  }
  if(out) out.innerHTML = aiRecipeResultHtml();
  if(gen){ gen.disabled = false; gen.textContent = '✨ 生成配方'; }
}
// v1.0.62 上传主线简述 → 全文直发 AI 通读 → 提炼可模仿的写作配方（复用 aiRp 渲染链，不分段）
let _aiOutlineFname = ''; // v10.57 暂存上传文件名，供快照 desc 标记
async function aiRecipeFromOutline(text){
  aiSource = 'outline';
  const out = $('[data-ai-recipe-out]');
  if(out) out.innerHTML = `<p class="muted" style="margin:8px 0 0">⏳ AI 正通读主线简述并提炼可模仿的写作配方…</p>`;
  const gen = $('[data-ai-recipe-gen]'); if(gen){ gen.disabled = true; gen.textContent = '通读中…'; }
  try{
    const {system, user} = aiPromptFromOutline(text);
    const list = await aiRecipeProduce(system, user);   // D2/C①：生成即预校验风格契约
    aiRp = { list, hi: 0 };
    // v10.57 生成成功即存历史快照（以梗概文件名标记来源；不存原文大文本）
    addAiHist({ id: aiHistEntryId(), ts: Date.now(), src:'outline', desc: _aiOutlineFname || '主线简述', list: JSON.parse(JSON.stringify(list)), applied:[] });
  }catch(e){
    aiRp = { list:null, err: (e&&e.message)||'通读失败' };
  }
  if(out) out.innerHTML = aiRecipeResultHtml();
  if(gen){ gen.disabled = false; gen.textContent = '✨ 生成配方'; }
}
// AI 返回JSON解析（防 markdown 代码块包裹）
function parseAiJsonList(raw){
  let t = String(raw||'').trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if(m) t = m[1].trim();
  try{ const a = JSON.parse(t); return Array.isArray(a)? a : null; }catch(e){
    try{ const i = t.indexOf('['), j = t.lastIndexOf(']'); if(i>=0&&j>i){ const a = JSON.parse(t.slice(i,j+1)); return Array.isArray(a)? a:null; } }catch(e2){}
    return null;
  }
}
// 选用候选配方：① 存入「我的配方」（customCombos）；②（选用时）应用到写作风格并立即持久化生效
function storeRecipeCandidate(c){
  if(!c) return null;
  const cfg = getCfg(); cfg.styleCustom = cfg.styleCustom || {};
  cfg.styleCustom.customCombos = cfg.styleCustom.customCombos || [];
  const libIds = writeStyleLib().map(s=>s.id);
  // name 冲突时追加序号
  let name = (c.name||'').trim(); if(!name) name = 'AI配方'+(cfg.styleCustom.customCombos.length+1);
  const names = cfg.styleCustom.customCombos.map(x=>x.name);
  let k = 2; while(names.includes(name)) name = (c.name||('AI配方'+(cfg.styleCustom.customCombos.length+1)))+'·'+ (k++);
  let tags = (c.tags||[]).filter(id=> libIds.includes(id));
  // 缺口词条若已入库，一并自动纳入 tags（决策2）
  (c.gap||[]).forEach(g=>{ if(g && g.id && libIds.includes(g.id) && !tags.includes(g.id)) tags.push(g.id); });
  cfg.styleCustom.customCombos.push({ id:'cu'+Date.now().toString(36)+Math.random().toString(36).slice(2,5), name, desc:(c.desc||''), why: wiseWhyText(c.why||''), tags });
  saveCfg(cfg);
  return { combo:cfg.styleCustom.customCombos[cfg.styleCustom.customCombos.length-1], name };
}
// [历史兼容] 走 aiRp 的存储封装
function aiRecipeStore(ci){
  if(!aiRp || !Array.isArray(aiRp.list)) return null;
  return storeRecipeCandidate(aiRp.list[ci]);
}
// 4.5：风格契约清洗与校验（规则6：sentenceAvg 整数 10-40、dialogueRatio 0-1 小数、forbiddenPhrases/preferredTransitions 各至少 3 条，否则不视为有效契约）
function validateStyleContract(raw){
  if(!raw || typeof raw !== 'object') return null;
  const sentenceAvg = Math.round(+raw.sentenceAvg);
  const dialogueRatio = +raw.dialogueRatio;
  const fp = (Array.isArray(raw.forbiddenPhrases)?raw.forbiddenPhrases:[]).map(s=>String(s||'').trim()).filter(Boolean);
  const pt = (Array.isArray(raw.preferredTransitions)?raw.preferredTransitions:[]).map(s=>String(s||'').trim()).filter(Boolean);
  const okNum = Number.isFinite(sentenceAvg) && sentenceAvg>=12 && sentenceAvg<=60;   // 4.7 Pro（3.6）：范围与 AI_RECIPE_SYS_PRO（12-60）对齐
  const okDia = Number.isFinite(dialogueRatio) && dialogueRatio>=0 && dialogueRatio<=1;
  if(!okNum || !okDia || fp.length<3 || pt.length<3) return null;
  return {
    sentenceAvg,
    sentenceTolerance: Number.isFinite(+raw.sentenceTolerance) ? Math.min(0.5, Math.max(0.05, +raw.sentenceTolerance)) : 0.2,
    dialogueRatio,
    dialogueTolerance: Number.isFinite(+raw.dialogueTolerance) ? Math.min(0.3, Math.max(0.05, +raw.dialogueTolerance)) : 0.1,
    forbiddenPhrases: fp,
    preferredTransitions: pt,
    rhythmNote: String(raw.rhythmNote||'').trim()
  };
}
// 选用此配方 → 存储 + 立即应用（替换式写生效配置并持久化）；opts 兼容历史弹层（无需 render 主卡时传 render:false）
function applyChosenCandidate(c, opts){
  if(!c) return null;
  const stored = storeRecipeCandidate(c); if(!stored) return null;
  const libIds = writeStyleLib().map(s=>s.id);
  // v10.48 选用即应用：替换写生效配置并持久化；回退依赖「收藏当前」预设或本配方仍存于「我的配方」
  const st2 = writeStyleState();
  const d2 = wsDraftInit();                       // 从生效配置取 intensity
  d2.tags = (c.tags||[]).filter(id=> libIds.includes(id));   // 替换而非并集
  (c.gap||[]).forEach(g=>{ if(g && g.id && libIds.includes(g.id) && !d2.tags.includes(g.id)) d2.tags.push(g.id); });
  st2.tags = d2.tags.slice(); st2.intensity = d2.intensity||2;
  // 4.5：配方 styleContract 保存到 state.styleContract（正文生成时 buildChapterUser 在 L0 注入）
  // C②：配方无合格契约时，若已有确认章节则自动回退到「从确认章节提取」
  let sc = validateStyleContract(c.styleContract);
  let scMsg = '';
  if(sc){ state.styleContract = sc; state._scFallbackOff = false; pushStyleHistory('配方选用：「'+stored.name+'」'); }
  else {
    const fp = buildStyleFingerprintFromConfirmed();
    if(fp){ state.styleContract = fp; state._scFallbackOff = false; sc = fp; pushStyleHistory('配方「'+stored.name+'」无合格契约，已回退到已确认章节提取'); scMsg = '该配方无合格风格契约，已从已确认章节回退提取风格契约'; }
  }
  persist();
  wsDraft = null;                                 // 草稿与生效合一 -> 卡片显示「✔已生效」
  if(!opts || opts.render !== false) aiRp = null;
  if(!opts || opts.render !== false){ render(); refreshWsUI(); }
  toast('已应用到「写作风格」：'+stored.name+(sc?(scMsg?'（'+scMsg+'）':'（风格契约已存，正文将按 L0 校验）'):'（无风格契约）'));
  return stored;
}
function aiRecipePick(ci){
  if(!aiRp || !Array.isArray(aiRp.list)) return;
  applyChosenCandidate(aiRp.list[ci]);
}
// 4.7 Pro（3.6 原码）：配方选用入口——选用时把 styleContract 写入 state（正文生成 L0 注入）。
// 融合说明：4.5 的 applyChosenCandidate 已完整实现 md 意图（tags 替换式应用 + styleContract 落库 + 我的配方存储 + UI 刷新），
// 此处按 md 原码落地函数签名并委托，保证「data-ai-recipe-pick → aiRecipeApply」链路与 md 一致。
function aiRecipeApply(idx){
  if(!aiRp || !aiRp.list[idx]) return;
  applyChosenCandidate(aiRp.list[idx], {});
}
// 收藏不采用：仅存入「我的配方」，不应用到写作风格
function aiRecipeSave(ci){
  if(!aiRp || !Array.isArray(aiRp.list)) return;
  const stored = aiRecipeStore(ci); if(!stored) return;
  toast('已加入「我的配方」（未应用）：'+stored.name);
}
// 确认加入缺口词条 → styleCustom.added，并立即纳入当前配方草稿（决策2）
function aiRecipeAddGap(key){
  if(!aiRp || !Array.isArray(aiRp.list)) return;
  const [ci, gi] = String(key||'').split('__').map(Number);
  const c = aiRp.list[ci]; if(!c) return;
  const g = (c.gap||[])[gi]; if(!g) return;
  if(writeStyleById(g.id)){ toast('该词条已在词库中'); return; }
  const group = ['语言质感','情绪与张力','节奏与网感','叙事技法','台词设计'].includes(g.cat) ? g.cat : 'custom';
  const cfg = getCfg(); cfg.styleCustom = cfg.styleCustom || {};
  cfg.styleCustom.added = cfg.styleCustom.added || [];
  const id = (g.id && /^[a-z][a-z0-9_]*$/i.test(g.id)) ? g.id : ('c'+Math.random().toString(36).slice(2,8));
  // id 冲突则加后缀
  let finalId = id, mx = 1; const existing = writeStyleLib().map(s=>s.id);
  while(existing.includes(finalId)) finalId = id + (mx++);
  cfg.styleCustom.added.push({ id:finalId, group, name:(g.name||'').trim(), note:(g.note||'').trim(),
    tips:Array.isArray(g.tips)?g.tips.map(x=>String(x||'').trim()).filter(Boolean):[],
    avoid:Array.isArray(g.avoid)?g.avoid.map(x=>String(x||'').trim()).filter(Boolean):[],
    check:Array.isArray(g.check)?g.check.map(x=>String(x||'').trim()).filter(Boolean):[],
    demo:(g.demo||'').trim(), seal:(g.seal===undefined?0:g.seal), warning:(g.warning||'') });
  saveCfg(cfg);
  // 立即纳入当前配方草稿 + 把该 id 补进当前候选 tag
  const d = wsDraftInit(); if(!d.tags.includes(finalId)) d.tags.push(finalId);
  if(c.tags && !c.tags.includes(finalId)) c.tags.push(finalId);
  toast('已加入词库并纳入当前配方：'+(g.name||finalId));
  const out = $('[data-ai-recipe-out]'); if(out) out.innerHTML = aiRecipeResultHtml();
}

// 运行时词库 = 内置 45 项（note 可被 cfg.styleCustom.notes 覆盖、可被 removed 删除）⊕ 用户新增
// v2.4 自定义风格 note 支持三行配方：写法:/避免:/自查:（按行解析成 tips/avoid/check）
// v10.52 扩展识别「指令/示例」前缀 + 支持「前缀：内容」同行；指令→intro(总纲)、示例→demo
function parseCustomStyleNote(note){
  const tips=[], avoid=[], check=[];
  let intro='', demo='';
  const lines = String(note||'').split(/\n/);
  let mode = null;
  lines.forEach(l=>{
    const t = String(l||'').trim();
    if(!t) return;
    let m;
    if((m=/^指令[:：]\s*(.*)$/.exec(t))){ mode='intro'; if(m[1]) intro=m[1]; return; }
    if((m=/^写法[:：]\s*(.*)$/.exec(t))){ mode='tips'; if(m[1]) tips.push(m[1].replace(/^[①②③④⑤]?[.、）)]?\s*/,'')); return; }
    if((m=/^避免[:：]\s*(.*)$/.exec(t))){ mode='avoid'; if(m[1]) avoid.push(m[1].replace(/^[✗×\-\s]+/,'')); return; }
    if((m=/^自查[:：]\s*(.*)$/.exec(t))){ mode='check'; if(m[1]) check.push(m[1].replace(/^[□✅◇\-\s]+/,'')); return; }
    if((m=/^示例[:：]\s*(.*)$/.exec(t))){ mode='demo'; if(m[1]) demo=m[1]; return; }
    // 无前缀：按当前 mode 收集（兼容前缀独立成行的旧格式）
    if(mode==='intro'){ if(!intro) intro=t; }
    else if(mode==='tips') tips.push(t.replace(/^[①②③④⑤]?[.、）)]?\s*/,''));
    else if(mode==='avoid') avoid.push(t.replace(/^[✗×\-\s]+/,''));
    else if(mode==='check') check.push(t.replace(/^[□✅◇\-\s]+/,''));
    else if(mode==='demo'){ if(!demo) demo=t; }
  });
  return { intro, tips, avoid, check, demo };
}
function writeStyleLib(){
  const c = getCfg().styleCustom || {};
  const notes = (c && c.notes) || {};
  const removed = Array.isArray(c && c.removed) ? c.removed : [];
  const added = Array.isArray(c && c.added) ? c.added : [];
  // v10.19 系统内置词条保留原始来源 cat（语气基调/文风质感/语言元素），供章节风格组内分块展示
  const base = WRITE_STYLES.filter(s=> !removed.includes(s.id)).map(s=>{
    const cat = s.cat || (s.group==='tone' ? 'tone' : (s.group==='texture' ? 'texture' : 'element'));
    return { ...s, group:'element', cat, note: notes[s.id] || s.note };
  });
  const customs = added.map(a=>{
    // v10.52 优先用入库时持久化的五维；老数据（无独立 tips/avoid/check）回退 parseCustomStyleNote 从 note 拆
    const hasStruc = (Array.isArray(a.tips)&&a.tips.length) || (Array.isArray(a.avoid)&&a.avoid.length) || (Array.isArray(a.check)&&a.check.length);
    const parsed = hasStruc ? { tips:a.tips||[], avoid:a.avoid||[], check:a.check||[], demo:a.demo||'' } : parseCustomStyleNote(a.note||'');
    // v10.20 自定义项归入用户选择的五大类分类；老数据（tone/texture/element）映射到自定义兜底
    const cat = ['语言质感','情绪与张力','节奏与网感','叙事技法','台词设计'].includes(a.group) ? a.group : 'custom';
    return { id:a.id, group:'element', name:a.name||'未命名', note:a.note||'', custom:true, cat, tips:parsed.tips||[], avoid:parsed.avoid||[], check:parsed.check||[], demo:parsed.demo||a.demo||'', seal:(a.seal===undefined?0:a.seal), warning:a.warning||'' };
  });
  // v11 移除「标题风格(tone)/梗概风格(texture)」残留分组：写作风格收敛为章节风格(element)，按五大类 cat 组织展示。
  return base.concat(customs);
}
function writeStyleById(id){
  return writeStyleLib().find(s=> s.id === id) || null;
}
// v10.57 方案2兜底：把自由文本（why/scenario 等）里出现的英文词条 id 替换为中文 name。
// 仅替换词库内真实存在的 id；查不到（拼错/幻觉）的原样保留，不误伤；中文不受影响。
let _idNameMap = null;
function _idName(){
  if(_idNameMap) return _idNameMap;
  const m = new Map();
  writeStyleLib().forEach(s=>{ if(s.id) m.set(s.id, s.name); });
  return (_idNameMap = m);
}
function wiseWhyText(txt){
  if(!txt) return txt;
  const N = _idName();
  return String(txt).replace(/\b[A-Za-z_]\w*\b/g, w=> (N.has(w) ? N.get(w) : w));
}
// 当前生效的写作风格配置：override 优先（单章覆盖/对比用），缺省用 state.chapterStyle
function curWriteStyle(override){
  if(override && Array.isArray(override.tags)) return { tags: override.tags, intensity: (override.intensity===1||override.intensity===3)?override.intensity:2 };
  const s = state.chapterStyle || {};
  return { tags: Array.isArray(s.tags)?s.tags:[], intensity: (s.intensity===1||s.intensity===3)?s.intensity:2 };
}
// v10.17 按使用目标分组取所选风格对象：章节风格(element)/标题风格(tone)/梗概风格(texture)
function wsGroupStyleTags(override, group){
  const st = curWriteStyle(override);
  const lib = writeStyleLib();
  return (Array.isArray(st.tags) ? st.tags : []).map(id=> lib.find(s=>s.id===id)).filter(s=> s && s.group === group);
}
const WS_CONC_TXT = {
  1:'浓度（轻）：全章约三分之一段落体现风格，其余按常规写作；每段最多 1-2 处风格痕迹。写完自查：不足处不必强补，保持自然。',
  2:'浓度（中）：全章大部分段落（约三分之二）体现风格，每段至少 1 处明显痕迹；开头段落必须体现以立住基调。写完自查：不达标段落补强。',
  3:'浓度（重）：全章每一段都要体现风格，对话与叙述几乎句句带痕迹，形成统一文风。写完自查：无风格痕迹的段落一律重写。'
};
// 生成注入块：最高优先指令 + 浓度量化 + 四件套配方（仅展开选中项）；无选中返回空串
function wsStyleNoteBlock(items, st, headTitle, intro, demoLabel){
  if(!items.length) return '';
  const lines = ['【' + headTitle + '（用户指定 · 最高优先指令）】', intro];
  items.forEach(s=>{
    lines.push('· '+s.name+'（总纲）：'+(s.note||''));
    if(Array.isArray(s.tips) && s.tips.length) lines.push('  写法：' + s.tips.map((t,i)=>`${['①','②','③','④','⑤'][i]||(i+1)+'.'} ${t}`).join('；'));
    if(Array.isArray(s.avoid) && s.avoid.length) lines.push('  避免：✗ ' + s.avoid.join('；✗ '));
    if(s.demo) lines.push('  示范写法：「'+s.demo+'」（可模仿其语感，不要照抄句子）');
    if(Array.isArray(s.check) && s.check.length) lines.push('  自查：' + s.check.map(c=>'□ '+c).join(' '));
  });
  lines.push('红线：以上风格仅约束表达方式，不得破坏人名/地名/专名一致性，不得违反基础剧情逻辑与人物设定。');
  return '\n\n' + lines.join('\n');
}
// 章节风格（element 组）注入：用于章节正文生成（单章/批量/重生成；含角色扮演对比）
function chapterStyleNote(override){
  const items = wsGroupStyleTags(override, 'element');
  const st = curWriteStyle(override);
  return wsStyleNoteBlock(items, st, '写作风格', '本指令为本章写作的最高优先要求（第一优先，压过本次人工干预）：当它与节奏、篇幅、原创性等任何其他要求冲突时，以本指令为准；唯一不可逾越的红线：不得破坏人名/地名/专名一致性、不得违反基础剧情逻辑与人物设定。');
}
// v11 规划师轻量风格注入：只给所选章节风格(element)的名称 + 浓度，不给 note/五维（规划师只需风格基调锚点，避免与正文完整版重复）。
function writeStyleNamesBlock(){
  const items = wsGroupStyleTags(null, 'element');
  if(!items.length) return '';
  const names = items.map(s=>s.name).join('、');
  const st = curWriteStyle();
  const conc = WS_CONC_TXT[st.intensity] ? `浓度：${WS_CONC_TXT[st.intensity]}` : '';
  return `【写作风格（第一优先）】写作风格：${names}${conc?('，'+conc):''}。\n本指令为本章规划的最高优先要求：当其与其它要求冲突时以本指令为准；唯一不可逾越红线：不破坏人名/地名/专名一致性、不违反基础剧情逻辑与人物设定。`;
}

// 当前所选
function selRhythm(){ return state.recipeSet && RHYTHMS.find(r=> r.id === state.recipeSet.rhythm) || null; }
// 章节标题风格（多选）：返回选中的样式对象数组；未选返回 []
function selTitleStyles(){ return (state.recipeSet && Array.isArray(state.recipeSet.titleStyle)) ? state.recipeSet.titleStyle.filter(id=> TITLE_STYLE_IDS.includes(id)).map(id=> TITLE_STYLES.find(s=> s.id===id)).filter(Boolean) : []; }
function hasTitleStyle(id){ return Array.isArray(state.recipeSet && state.recipeSet.titleStyle) && state.recipeSet.titleStyle.includes(id); }
// 标题风格注入块：选中才生成，未选返回空（不发送任何标题要求，AI 自由发挥）
function titleStyleNote(){
  const arr = selTitleStyles();
  if(!arr.length) return '';
  return '【章节标题风格（用户指定，必须遵守）】\n' + arr.map(s=>'·'+s.note).join('\n');
}

// 默认体量：用户填了哪一侧就用哪一侧；都没填回退默认字数区间 3000-5000
// 归一化：把可能残缺的区间补全（min/max 任一缺省则用对侧/默认补足），保证派生计算不出现 NaN
function normalRange(r, fallback){
  const min = (typeof r==='object' && +r.min>0) ? +r.min : fallback.min;
  const max = (typeof r==='object' && +r.max>0) ? +r.max : Math.max(min, fallback.max);
  return { min, max: Math.max(min, max) };
}
function selSize(){
  if(state.chapterRange && (state.chapterRange.min>0 || state.chapterRange.max>0)){
    return { kind:'chapter', range: normalRange(state.chapterRange, {min:80,max:100}) };
  }
  if(state.wordRange && (state.wordRange.min>0 || state.wordRange.max>0)){
    return { kind:'word', range: normalRange(state.wordRange, SIZE_DEFAULT) };
  }
  return { kind:'word', range: SIZE_DEFAULT };
}
const fmtRange = r => `${r.min}-${r.max}`;
// 全书章节数量：用户给定（1-200 整数）；未设返回 null。
function chapterCountVal(){
  const v = +state.chapterCount;
  if(Number.isInteger(v) && v>=1 && v<=200) return v;
  return null;
}
// 生成大纲前唯一必填数字：本章节数量一句提示
function chapterCountHint(){
  const v = chapterCountVal();
  return v ? `全书 ${v} 章` : '请填写全书章节数（1-200，必填）';
}
// v1.0.119 真实章节数：已生成标题时以 chapters.length 为准（历史存档解耦、自动跟随真实标题数）；无章节时回退用户声明值
function realChapterCount(){
  const n = (state.outline && Array.isArray(state.outline.chapters)) ? state.outline.chapters.length : 0;
  if(n>0) return n;
  return chapterCountVal();
}
// 全书总字数基准：优先用用户在「最前」设定的 totalWords，未设时回退 30 万
function totalWordsBase(){ return (state.totalWords && +state.totalWords>0) ? +state.totalWords : 300000; }
const totalWan = () => (totalWordsBase()/10000).toLocaleString('en-US');
// 由区间中值映射到对侧建议值（总字数可调，故按 totalWordsBase）
function estCounterpart(sz){
  const mid = (sz.range.min + sz.range.max) / 2;
  if(!mid) return null;
  return Math.round(totalWordsBase()/mid);
}
// 体量一句提示（页面 + 可复用）
function sizeHintText(){
  const hasW = state.wordRange && (state.wordRange.min>0 || state.wordRange.max>0);
  const hasC = state.chapterRange && (state.chapterRange.min>0 || state.chapterRange.max>0);
  if(!hasW && !hasC) return '请先 ☑ 勾选「每章字数」或「全书章节」其中一项，再滑动滑条调整区间。';
  const sz = selSize();
  const cnt = estCounterpart(sz);
  if(sz.kind==='word') return `按每章 ${fmtRange(sz.range)} 字，全书约需 ${cnt} 章。`;
  return `全书约 ${fmtRange(sz.range)} 章，每章据此约 ${cnt} 字。`;
}
// 生成「体量」单侧块：顶部为二选一勾选框（radio），下方为该侧双滑条。
// side ∈ {word,chapter}；r 为已有区间（可为 null 用默认）；on 表示该侧是否已勾选生效。
// 只有勾选（on）的一侧滑条才可操作；未勾选侧整块灰色、滑条禁用占位。
function sizeSlider(side, label, lo, hi, step, r, on){
  const dflt = side==='word' ? {min:3000,max:5000} : {min:80,max:100};
  const v = (r && +r.min>0 && +r.max>0) ? {min:+r.min, max:+r.max} : dflt;
  v.min = Math.max(lo, Math.min(hi, v.min));
  v.max = Math.max(lo, Math.min(hi, v.max));
  if(v.max < v.min) v.max = v.min;
  const cls = on ? 'size-block on' : 'size-block';
  const fmt = n => side==='word' ? n.toLocaleString() : String(n);
  return `<div class="${cls}" data-side="${side}">
      <button type="button" class="size-pick" data-pick="${side}" aria-pressed="${on}">
        <span class="size-radio">${on?'✓':''}</span>
        <span class="size-lbl">${label}</span>
      </button>
      <span class="size-val"><b data-dr-val="${side}">${fmt(v.min)} ~ ${fmt(v.max)}</b></span>
      <div class="drs ${on?'':'ds-off'}" data-drs="${side}" data-min="${lo}" data-max="${hi}" data-step="${step}"></div>
      <span class="size-scale">${lo.toLocaleString()} ~ ${hi.toLocaleString()}${side==='word'?' 字':' 章'}</span>
    </div>`;
}
// 同轨双滑块：采用成熟的 noUiSlider（零依赖，双手柄 + 触屏 + 键盘 + ARIA，社区最通用）
// 参考 https://github.com/leongersen/noUiSlider  · 用法见 https://refreshless.com/nouislider/
// margin=step 保证两柄不交叉；update 实时刷新标签，change 松手才提交到 state
function initDRS(){
  $$('.drs').forEach(drs=>{
    const side = drs.dataset.drs;
    const lo = +drs.dataset.min, hi = +drs.dataset.max, step = +drs.dataset.step;
    const stateR = side==='word' ? state.wordRange : state.chapterRange;
    const dflt = side==='word' ? {min:3000,max:5000} : {min:80,max:100};
    let v0 = (stateR && +stateR.min>0) ? +stateR.min : dflt.min;
    let v1 = (stateR && +stateR.max>0) ? +stateR.max : dflt.max;
    v0 = Math.max(lo, Math.min(hi, v0));
    v1 = Math.max(lo, Math.min(hi, v1));
    if(v1 < v0) v1 = v0;
    if(drs.noUiSlider){ drs.noUiSlider.destroy(); drs.noUiSlider = null; } // render 会重建；先销毁旧实例
    // 未勾选侧：不创建滑块，仅保留灰色禁用占位（.ds-off）
    if(drs.classList.contains('ds-off')) return;
    noUiSlider.create(drs, {
      start: [v0, v1],
      connect: true,
      step: step,
      margin: step,
      range: { min: lo, max: hi }
    });
    const lbl = drs.parentElement.querySelector('[data-dr-val="'+side+'"]');
    const fmt = n => side==='word' ? n.toLocaleString() : String(n);
    // 拖动实时更新上面的数值标签
    drs.noUiSlider.on('update', (vals)=>{
      if(lbl){ const a=+vals[0], b=+vals[1]; lbl.textContent = fmt(a)+' ~ '+fmt(b); }
    });
    // 松手/键盘结束时提交到 state，并刷新派生提示
    drs.noUiSlider.on('change', (vals)=>{
      const R = { min: Math.round(+vals[0]), max: Math.round(+vals[1]) };
      if(side==='word'){ state.wordRange=R; state.chapterRange=null; }
      else { state.chapterRange=R; state.wordRange=null; }
      const hint = $('#sizeHint'); if(hint) hint.textContent = sizeHintText();
      persist(); render();
    });
  });
}
// 勾选「体量」某侧（radio 二选一）：选中该侧并把另一侧置空；该侧无已设区间则给默认区间作为滑条起点。
function pickSize(side){
  if(side==='word'){
    if(!(state.wordRange && +state.wordRange.min>0)) state.wordRange = { min:3000, max:5000 };
    state.chapterRange = null;
  }else{
    if(!(state.chapterRange && +state.chapterRange.min>0)) state.chapterRange = { min:80, max:100 };
    state.wordRange = null;
  }
  const hint = $('#sizeHint'); if(hint) hint.textContent = sizeHintText();
  persist(); render();
}

// 按所选体量推导「单章正文的 max_tokens 上限」，防止模型偶发超长输出推高成本
// 不再按字数设定：章节数只定章数，正文长度由模型自然把握，这里给一个安全的通用上限（约 8000 字缓冲）
function chapterMaxTokens(){
  return clampMaxTokens('chapter');
}
// 4.8 旗舰版（板块二-3）：按任务类型限制 max_tokens，避免 50000 这种远超 API 上限的无效参数触发频繁截断。
function clampMaxTokens(task){
  const limits = {
    chapter: 12000,     // 正文最大单次输出
    chapterPlan: 32000, // 全书规划师单批(25章完整节拍表)输出，避免批次 JSON 超出 4096 被截断
    json: 4096,         // JSON 类契约输出
    continue: 8192,     // 续写补充段
    summary: 2048,      // 梗概/摘要
    strip: 5000         // 速读梗概
  };
  return limits[task] || 4096;
}
// 4.8 旗舰版（板块一-5）：按章节所处结构阶段动态调整 temperature/top_p，使开篇立人设、中段铺陈、高潮收紧、结局收束各有差异。
function dynamicChapterParams(idx){
  const o = state.outline;
  const base = resolveActiveSpec().chapterTemp;
  const acts = (o && o.structure && o.structure.acts) || {};
  const total = (o && o.chapters && o.chapters.length) || 1;
  // 默认：均匀三段 act
  const ratio = (idx + 1) / total;
  let phase = 'act1';
  if(acts.act1 && acts.act2 && acts.act3){
    if(idx + 1 <= acts.act1.end) phase = 'act1';
    else if(idx + 1 <= acts.act2.end) phase = 'act2';
    else phase = 'act3';
  } else if(ratio > 0.75) phase = 'act3';
  else if(ratio > 0.35) phase = 'act2';
  // climax beat 密度检测：本章节拍表 climax 段 requiredEntities 密度高时再降温度保稳
  const plan = (o && Array.isArray(o.chapterPlans) && o.chapterPlans[idx]) || {};
  let climaxDense = false;
  if(plan && Array.isArray(plan.beats)){
    const climax = plan.beats.find(b => b.type === 'climax');
    if(climax && Array.isArray(climax.requiredEntities) && climax.requiredEntities.length >= 3) climaxDense = true;
  }
  const map = {
    act1: { temperature: 0.70, topP: 0.95 },   // 立人设：低温稳
    act2: { temperature: 0.85, topP: 0.95 },   // 中段铺陈：稍高激发变化
    act3: { temperature: 0.80, topP: 0.90 }    // 高潮+收束：收紧采样
  };
  const p = map[phase] || map.act2;
  // 以用户配置为基准做偏移，而不是完全覆盖
  const t = base + (p.temperature - 0.75);
  return {
    temperature: Math.max(0.1, Math.min(1.2, t)),
    topP: climaxDense ? Math.max(0.5, p.topP - 0.05) : p.topP,
    phase
  };
}
// 体量提示（拼入大纲提示词）：只给固定章节数，不给任何字数限制
function outlineSizeNote(){
  const n = chapterCountVal();
  return `全书共 ${n} 章（已由用户定死）。请严格生成恰好 ${n} 个章节，章号从 1 到 ${n} 连续，每章给出标题与梗概，不得增加也不得减少章节。全程不限制任何字数（不设单章字数、不设全书字数），按内容需要自然成稿。`;
}
/* 万物词典统一要求块：无论选哪种结构都追加到大纲提示词，保证模型输出 glossary（建议7/决策8/9）
 * glossary 等顶层字段仍以“下方追加块”形式补充（S2）；而各结构的主线条四格已内联进各自的 outlineSys（S1，见 MAIN_LINE_BLOCK）。 */
/* 基础大纲 JSON 契约（仅是大纲内容，与『结构』彻底无关）：用户未选任何结构范式时，作为独立的大纲内容块注入，
  * 只定 title/logline/chapters 的形态。不含任何"多线/三定"等结构偏好——结构未选则不推主线条/副暗线等结构命令；
  * 但"全部章节安排"仍由 CHAPTER_PLAN_FREE_SYS 以自由分组的形式轻量补充到 structure.chapterPlan。 */
// 4.5：大纲 AI 必须输入 navBeacon 与章节数 N，输出 title/logline/anchor/thesis/structure（结构骨架）；
// 章节标题仍在后续独立步骤生成，但结构骨架必须保留并显式传递给标题 AI 与规划师 AI。
// 4.7 Pro（3.2/第7章指令2）：旧常量改名为 OUTLINE_GEN_SYS_LEGACY 保留回退，新常量用旧名指向 OUTLINE_GEN_SYS_PRO。
const OUTLINE_GEN_SYS_LEGACY = `你是一位能驾驭超长篇的小说架构师。

【核心任务】
基于用户的结构化构想（navBeacon），设计一部经典长篇小说的：书名、简介、核心定位、深层主题、结构骨架。

【输入】
用户会提供：
- navBeacon：题材、主角、对手、核心冲突、世界观规则、风格基调、目标体验
- 章节数 N（全书总章数，必须严格遵守）

【输出格式】
严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{
  "title": "小说名",
  "logline": "小说简介（含核心冲突与深层命题，严格落在指定字数区间）",
  "anchor": "核心一句话定位：题材+主角+核心冲突，≤50字",
  "thesis": "深层主题命题，≤80字",
  "structure": {
    "mainLine": "全书唯一主线/核心走向",
    "subLines": ["副线1", "副线2"],
    "hiddenLine": "暗线内容与揭晓时机",
    "pivotPlan": "汇合/大逆转所在章（点式，如 第20章三方对峙）",
    "acts": {
      "act1": {"start":1, "end":25, "mission":"本幕任务", "mustHappen":["事件1","事件2"]},
      "act2": {"start":26, "end":75, "mission":"本幕任务", "mustHappen":["事件1","事件2"]},
      "act3": {"start":76, "end":100, "mission":"本幕任务", "mustHappen":["事件1","事件2"]}
    }
  }
}

【硬性约束】
1. title 必须有记忆点，不与常见网文重名。
2. logline 必须包含：主角、核心冲突、核心动机、代价/悬念；字数严格落在【简介字数约束】区间内。
3. anchor 必须包含 navBeacon.genre + protagonist + coreConflict 三要素，≤50字。
4. thesis 必须点出作品要探讨的核心主题/情感内核，≤80字。
5. structure.mainLine 必有；subLines/hiddenLine/pivotPlan 有则带、无则空数组/空字符串，绝不硬造。
6. structure.acts 必须覆盖全部 N 章：act1.start=1，act3.end=N，三幕连续无遗漏。
7. 每个 act 的 mustHappen 至少 2 条、最多 5 条，且必须是可在正文中被验证是否发生的具体事件。
8. 严禁输出 chapters 字段；章节标题在后续独立步骤生成。`;

// 4.7 Pro（3.2）大纲 AI 新系统提示词：资深长篇架构师 + 结构诊断师，输出 书名+简介+structure（主线条+章节计划）。
// 注：md 原码中「当前为 ${N} 章」为运行时插值，顶层求值会崩；此处改为引用用户提示中给定的 N（buildOutlineSys 会注入具体 N）。
const OUTLINE_GEN_SYS_PRO = `你是一位资深长篇小说架构师，同时担任「结构诊断师」。
【核心任务】根据用户的一句话或几句构想，设计一部长篇小说的：书名、小说简介、以及可直接落地的结构骨架。

【必须输出的 JSON 结构】
{
  "title": "小说名（≤12字，有记忆点，不套路）",
  "logline": "小说简介：必须包含 题材+主角+核心冲突+深层命题，控制在【简介字数约束】区间内",
  "anchor": "核心一句话定位：题材+主角+核心冲突，≤50字",
  "thesis": "深层主题命题，≤80字，点出作品要探讨的核心主题/情感内核",
  "structure": {
    "mainLine": "全书唯一主线/核心走向（必有，≤60字）",
    "subLines": ["副线1（有才填）", "副线2（有才填）"],
    "hiddenLine": "暗线内容（有才填，没有就空字符串）",
    "pivotPlan": "汇合/大逆转所在章（有才填，没有就空字符串）",
    "chapterPlan": {
      "维度名1": ["第1章标题", "第2章标题"],
      "维度名2": ["第3章标题"]
    }
  },
  "genreTags": ["题材标签1", "题材标签2"],
  "tone": "整体情绪基调"
}

【硬性约束】
1. title ≤ 12 字；不得使用高频套路书名（如《重生之xxx》《xxx系统》《xxx的xxx》）。
2. logline 必须点明核心冲突与深层命题，篇幅严格落在末尾【简介字数约束】区间内，偏差不得超过 5%。
3. structure.mainLine 必填；subLines / hiddenLine / pivotPlan 有才填、无则空字符串或空数组，绝不硬造。
4. structure.chapterPlan 必须覆盖全书每一章（当前为用户提示中给定的 N 章），一章不落；维度名按主题/起承转合/人物线自由拟定。
5. genreTags 只能出现 2-4 个，且必须与 logline 一致。
6. anchor 必须包含 题材+主角+核心冲突 三要素，≤50字；thesis 必须点出作品的核心主题/情感内核，≤80字；二者均不得为空。
7. 忠实度硬约束：用户构想中出现的专名、称谓、设定、意象与关键情节点，必须在输出中原样保留；不得替换、改名或省略；如需调整须以用户原文为基准做增量扩展。
8. 只输出上述 JSON，不要 markdown 代码块、不要解释。

【输出示例】
{
  "title": "雾中第七日",
  "logline": "一座滨海小城在第七次大雾中接连发生失踪案，退休法医沈渔为追查女儿下落，发现凶手正是三十年前她亲手定罪、如今早已"死去"的连环杀手。",
  "structure": {
    "mainLine": "沈渔追踪女儿失踪真相，揭开三十年旧案与新案交织的凶手身份",
    "subLines": ["女儿与母亲破裂又修复的亲情", "小城权力结构对真相的掩盖"],
    "hiddenLine": "凶手每次作案前都会给沈渔寄一封未寄出的旧信",
    "pivotPlan": "第18章，沈渔在旧案卷宗中发现自己的签名被伪造",
    "chapterPlan": {
      "雾起": ["第1章 雾中第七日", "第2章 旧信"],
      "追踪": ["第3章 退休法医", "第4章 第一次谎言"]
    }
  },
  "genreTags": ["悬疑", "女性视角", "冷峻克制"],
  "tone": "冷峻、压抑、结尾沉重",
  "anchor": "冷峻悬疑：退休法医为救女儿追查三十年旧案，揭开小城权力与亲情的双重谎言。",
  "thesis": "面对体制性遗忘与亲情创伤，个人如何在执念中完成自我救赎。"
}`;

// 4.7 Pro（第7章指令2）：新常量用旧名——buildOutlineSys 等既有引用点自动升级为 PRO 提示词
const OUTLINE_GEN_SYS = OUTLINE_GEN_SYS_PRO;

/* =========================================================
 * 人名硬约束（中国角色）· 百家姓 + 两字名 + 禁叠字 + 避网文高频名
 * 判定：姓名首字（单姓）/ 首两字（复姓）属《百家姓》→ 视为中国角色并约束；
 *       否则视为外国角色不约束。供提示词注入与词典写入口/校验器共用。
 * ========================================================= */
const NM_SURNAME_1 = new Set('赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴鬱胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍郤璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公'.split(''));
const NM_SURNAME_2 = new Set(['万俟','司马','上官','欧阳','夏侯','诸葛','闻人','东方','赫连','皇甫','尉迟','公羊','澹台','公冶','宗政','濮阳','淳于','单于','太叔','申屠','公孙','仲孙','轩辕','令狐','钟离','宇文','长孙','慕容','鲜于','闾丘','司徒','司空','亓官','司寇','仉督','子车','颛孙','端木','巫马','公西','漆雕','乐正','壤驷','公良','拓跋','夹谷','宰父','谷梁','段干','百里','东郭','南门','呼延','归海','羊舌','微生','梁丘','左丘','东门','西门']);
const NM_WEB_BLACKLIST = ['林晚','苏晚','顾沉','云深','顾言','江晚','许墨','陆离','沈舟','苏念','林陌'];
// v1.0.130 用户指定禁用字与禁用人名（软硬约束均须遵守）：先保留原网文高频名单，再叠加以下两条从严。
const NM_BANNED_CHARS = ['晚','砚','秋','檐'];   // 姓名中禁止出现这四个汉字（任何位置）
const NM_BANNED_NAMES = [   // 逐字精确禁用名单（含去空格），命中即判违规
  '林辰','苏辰','顾夜寒','陆泽','墨渊','叶辰','江亦琛','傅景深','沈辞','萧景琰','凌夜','顾言','裴衍','楚慕言','厉承勋','谢珩','温景然','云烬','宋砚','慕云凡',
  '苏清月','晚卿','沈知予','顾晚柠','林晚星','慕晚晴','苏沐瑶','温妤','夏晚璃','楚清鸢','叶轻寒','姜知微','云舒','苏念汐','洛清欢','白若曦','顾绾绾','江晚渔','宋知晚','宁疏影'
];
const BANLIST_DEFAULT = {   // v1.0.132 禁则清单内置默认（含既有硬/软约束收敛入口）
  enabled: true,                            // 总开关（默认开）：清单是否参与注入
  chars: [],                                // 禁用字/词（人名/专名任何位置命中即拒，由校验器联动）；默认沿用 NM_BANNED_CHARS 读取
  names: [],                                // 禁用姓名（逐字精确）；默认沿用 NM_BANNED_NAMES
  phrases: [],                              // 禁用短语/模板词（仅正文注入，控词频）
  rules: [                                 // 附加规则条目：每条声明生效 AI 范围
    { text:'禁止直接叙述人物内心情绪，不写"心里感到""心头一颤"，一律用动作、微表情、下意识小动作间接呈现；人物行为须有清晰动机、允许小瑕疵，不美化。', ai:['planner','chapter'] },
    { text:'规避网文模板词，控制"倏然、眸光、眼底"等高频词密度：同章同类词同一意象不超过 1 次，能避则避。', ai:['chapter'] }
  ],
  scopeAi: ['chapter']                       // 缺省生效范围（仅正文）；用户可按 AI 扩展大纲/标题/规划师
};
const NM_NAME_RULE_TEXT = '\n【人名规范（硬约束，仅限中国角色）】凡姓名首字（或首两字）属《百家姓》者视为中国角色：必须为「百家姓姓氏 + 两字名」——单姓全名恰为 3 个汉字、复姓全名恰为 4 个汉字；名字不得使用叠字（如"琳琳""小雨"）。【用户禁则（软硬均须遵守）】全姓名中禁止出现汉字「晚」「砚」「秋」「檐」中任意一个（任何位置都算）；禁止使用以下指定人名（不得逐字符原样使用，也不得把其中某个人名作为现成名字选用）：男生——林辰、苏辰、顾夜寒、陆泽、墨渊、叶辰、江亦琛、傅景深、沈辞、萧景琰、凌夜、顾言、裴衍、楚慕言、厉承勋、谢珩、温景然、云烬、宋砚、慕云凡；女生——苏清月、晚卿、沈知予、顾晚柠、林晚星、慕晚晴、苏沐瑶、温妤、夏晚璃、楚清鸢、叶轻寒、姜知微、云舒、苏念汐、洛清欢、白若曦、顾绾绾、江晚渔、宋知晚、宁疏影。宜用职业特征/意象组合造名且风格与世界观一致。姓名首字不在百家姓者视为外国角色，不适用本条约束（但禁用字与禁用名清单仍应规避）。';
// 返回违规原因字符串；合规返回 ''。首字非百家姓（外国角色/外文名）一律放行。
function nmNameRuleViolation(nm){
  const s = String(nm||'').trim();
  if(!s) return '';
  if(!/^[\u4e00-\u9fa5]+$/.test(s)) return '';           // 含非汉字（外文名）不约束
  // 用户禁则优先（全姓名判定，不分国籍）：禁用字 / 禁用名单（v1.0.132 与禁则清单数据联动）
  const bv = banListViolation(s);
  if(bv) return bv;
  let surLen = 0;
  if(NM_SURNAME_2.has(s.slice(0,2))) surLen = 2;
  else if(NM_SURNAME_1.has(s.charAt(0))) surLen = 1;
  if(!surLen) return '';                                   // 首字(两字)非百家姓 → 外国角色不约束
  const exp = surLen + 2;                                  // 姓 + 两字名
  if(s.length !== exp) return `姓名应为百家姓(${surLen}字姓)+两字名＝${exp}字（当前「${s}」为${s.length}字）`;
  const given = s.slice(surLen);
  if(/([\u4e00-\u9fa5])\1/.test(given)) return `名字不得叠字（「${s}」）`;
  if(NM_WEB_BLACKLIST.some(w => s.indexOf(w) >= 0)) return `疑似网文高频名（「${s}」）`;
  return '';
}

/* v1.0.132 禁则清单：数据归一化 + 按 AI 角色生成注入块（四路 AI 共用同一清单，按生效范围过滤） */
// 归一化用户禁则清单：补齐缺失数组/字段，防止旧快照脏数据
function normalizeBanList(b){
  if(!b || typeof b !== 'object') return null;
  const out = { enabled: !(b.enabled === false) };
  out.chars = Array.isArray(b.chars) ? b.chars.filter(x=>x&&String(x).trim()) : [];
  out.names = Array.isArray(b.names) ? b.names.filter(x=>x&&String(x).trim()) : [];
  out.phrases = Array.isArray(b.phrases) ? b.phrases.filter(x=>x&&String(x).trim()) : [];
  out.rules = Array.isArray(b.rules) ? b.rules.filter(r=>r&&r.text).map(r=>({ text:String(r.text), ai:Array.isArray(r.ai)?r.ai:[] })) : [];
  out.scopeAi = Array.isArray(b.scopeAi) ? b.scopeAi.filter(x=>x) : (Array.isArray(BANLIST_DEFAULT.scopeAi) ? BANLIST_DEFAULT.scopeAi.slice() : []);
  return out;
}
function banListRaw(){ return (state.banList && typeof state.banList === 'object') ? state.banList : BANLIST_DEFAULT; }
function stateBanEnabled(){ const b = banListRaw(); return !(b && b.enabled === false); }
function banListChars(){ const c = banListRaw().chars; return (Array.isArray(c) && c.length) ? c : NM_BANNED_CHARS; }
function banListNames(){ const n = banListRaw().names; return (Array.isArray(n) && n.length) ? n : NM_BANNED_NAMES; }
// 判断某类 AI 是否在清单生效范围内（scopeAi 为空则视为全生效）
function banListAiActive(role){
  const sc = banListRaw().scopeAi;
  if(!Array.isArray(sc) || !sc.length) return true;
  return sc.indexOf(role) >= 0;
}
// 为指定 AI 角色生成「用户禁则清单」提示词块；无内容或不生效时返回 ''。
function banListBlockFor(role){
  if(!isLong()) return '';   // v1.0.132 禁则清单仅长篇生效（与语言分层同属叙事中间件，短片不注入）
  if(!stateBanEnabled()) return '';
  const b = banListRaw();
  const lines = [];
  const chars = banListChars(), names = banListNames();
  if(chars.length && banListAiActive(role)) lines.push('人名禁用字：' + chars.join('、') + '（姓名任何位置命中即违规）');
  if(names.length && banListAiActive(role)) lines.push('禁用姓名（不得逐字原样使用或当作现成名）：' + names.join('、'));
  // 附加规则按角色生效范围过滤
  const rules = Array.isArray(b.rules) ? b.rules : [];
  rules.forEach(r => {
    if(!r || !r.text) return;
    const ai = Array.isArray(r.ai) ? r.ai : [];
    if(ai.indexOf(role) >= 0) lines.push(r.text);
  });
  // 禁用短语/模板词：仅正文(chapter)注入，避免污染大纲/标题/规划师
  const phrases = Array.isArray(b.phrases) ? b.phrases : [];
  if(role === 'chapter' && phrases.length) lines.push('规避高频模板词/禁用短语：' + phrases.join('、'));
  if(!lines.length) return '';
  return '\n\n【用户禁则清单（最高优先）】\n' + lines.join('\n');
}
// 后端校验器是否命中用户禁则字符/名单（与 nmNameRuleViolation 的首判逻辑保持一致但始终生效）
function banListViolation(nm){
  const s = String(nm||'').trim(); if(!s) return '';
  const ch = banListChars().find(c => s.indexOf(c) >= 0);
  if(ch) return `名字含禁用字「${ch}」（禁则清单）`;
  if(banListNames().indexOf(s) >= 0) return `命中禁则名单「${s}」`;
  return '';
}

const GLOSSARY_SYS = `\n\n【glossary 万物词典（必须一并输出）】请在返回的 JSON 顶层再追加一个 glossary 字段，作为全文保持一致性的权威基准：
"glossary":{"characters":[{"name":"人物姓名","identity":"身份/职业/社会身份","age":"岁数/年龄","gender":"性别","appearance":"外貌特征","hobby":"爱好/习惯","relation":"与该人的血缘/人际关联（妹妹/姐姐/朋友/仆人等）","trait":"性格要点"}],"places":[{"name":"地名/场景名","type":"类型","note":"设定要点"}],"propernouns":[{"name":"专名/专属设定术语","note":"含义与拼写唯一约定"}]}
必须列出本故事涉及的全部重要人物（含配角）、关键地域地名与专属设定术语；**全书正文一律只使用本词典中的人名/地名/专名，禁止自造或混用其他拼写**。每名人物**必须**标注 identity（身份/职业/社会身份）、age（岁数/年龄）、gender（性别）、appearance（外貌特征）、hobby（爱好/习惯），正文中人物的身份、年龄、性别、外貌、爱好须与此保持一致。
【relation 与 identity 务必区分，不可混淆】
· identity 身份 = 她/他自己是谁：职业/职务/族群/社会地位，可独立成句——「她是捕快」「她是市长」「她是尼罗河努比亚族船女」「她是篮球运动员」；
· relation 关系 = 她/他和谁是什么关联：血缘/姻亲/友伴/主仆，必须带"谁的"才成立——「林晚的妹妹」「她的仆人」「朋友：陈默」；禁止把身份词（捕快/市长/船女）写进 relation；
人物条目中不设"职能/角色定位"字段。trait 归纳稳定性格以便后续各章保持一致。
【人物字段自洽（硬约束）】同一人物的名字与其各字段必须相互自洽、并能容纳其剧情设定，禁止出现下列矛盾：
· 已写明"在此地居住/任职/习武多年"，而 age 却小于该年限——例如"已在此住了30年"却仅23岁；应上调 age 或下调年限，取能自圆其说的一致值；
· 履历类身份（当官/从军/任职）须让年龄能容纳任职时长——例如18岁却"当官5年"自相矛盾；任职起始须早于当前 age，身份与 age 区间匹配（太后/驸马/童养媳等对 age 亦有隐含约束）；
· relation 蕴含的年龄轴：子代须小于亲代、兄弟/姐妹年龄差须合理；
· 特殊预设（转世/穿越/长生/修仙/不老/永生）可豁免数值约束，但必须在 identity 或 relation 中显式标注，不允许无理由的年限冲突。` + NM_NAME_RULE_TEXT;

// v11 全书规划师：不再生成"节奏/埋点/回收"三段式梗概，改为每章主线简述 + 定稿章节标题 + 初期万物词典。
// 一套请求三样产出：titles(定稿标题) / chapterPlans(每章主线简述) / glossary(初期词典，写正文的一致性种子)。
// 4.5：升级为节拍表版——每章输出 {summary, beats[], requiredEntities[], emotionalArc}；分批调用见 genChapterPlans。
// 4.7 Pro（3.4/第7章指令2）：旧常量改名 CHAPTER_PLAN_SYS_LEGACY 保留回退，新常量用旧名指向 CHAPTER_PLAN_SYS_PRO。
const CHAPTER_PLAN_SYS_LEGACY = `你是一名全书级叙事规划师（全书规划师）。

【核心任务】
基于小说书名、简介、导航灯塔、结构骨架、设定词典，为指定批次的章节产出：
1. 每章主线简述（summary）
2. 每章节拍表（beats）
3. 该批次所需的初期万物词典（glossary，仅第一批）

【输出格式】
严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{
  "titles": ["第x章·定稿标题", "第x+1章·定稿标题", ...],
  "chapterPlans": [
    {
      "summary": "本章主线简述（80-160字）：关键事件、人物动向、冲突推进",
      "beats": [
        {"type":"setup", "event":"事件", "emotional":"情绪", "requiredEntities":["人物/地点/专名"], "foreshadowing":[]},
        {"type":"rise", "event":"事件", "emotional":"情绪", "requiredEntities":["..."], "foreshadowing":[]},
        {"type":"climax", "event":"事件", "emotional":"情绪", "requiredEntities":["..."], "foreshadowing":[]},
        {"type":"hook", "event":"事件", "emotional":"情绪", "requiredEntities":["..."], "foreshadowing":["下一章伏笔"]}
      ],
      "emotionalArc": "本章情绪曲线：起→承→转→合",
      "requiredEntities": ["本章必须出现的全部人物/地点/专名"]
    }
  ],
  "glossary": {"characters":[...], "places":[...], "propernouns":[...]}
}

【硬性约束】
1. titles 与 chapterPlans 数量必须严格等于本批次章节数，顺序一一对应。
2. 每章 summary 必须显式引用 structure.acts 中对应幕的 mission 与 mustHappen；若本章属于某幕，必须在 summary 开头注明「第 X 幕」。
3. 每章 beats 必须包含 setup/rise/climax/hook 四段，不得省略；requiredEntities 必须来自设定词典，禁止自造新名。
4. 批次衔接：若提供了【已定稿的前文骨架】，本章情节必须自然承接前文状态，不得推翻已发生事件。
5. glossary 只在第一批返回；后续批次 glossary 字段可空对象 {}。
6. 人物字段必须自洽：identity/age/gender/appearance/hobby/relation/trait 齐全，age 与履历年限不得矛盾。
7. 不要 markdown 代码块。`;

// 4.7 Pro（3.4 原码）：资深全书级叙事工程师 + 节拍设计师。
// 修复 md 原码 bug：硬性约束1 原文为「必须严格等于现有章节数」，与分批生成（每批≤25 章）冲突，
// 改为「用户提示中指定的章节数」——批次章节数由 genChapterPlans 在 user 侧注入。
const CHAPTER_PLAN_SYS_PRO = `你是一位资深全书级叙事工程师，同时担任「节拍设计师」。
【核心任务】基于小说书名、小说简介、结构骨架、全部章节标题、设定词典，产出三样产物：定稿标题、每章主线简述、初期万物词典，并为每章生成四段节拍表。

【必须输出的 JSON 结构】
{
  "titles": ["第1章·定稿标题", "第2章·定稿标题", "..."],
  "chapterPlans": [
    {
      "summary": "本章主线简述：关键事件+人物动向+冲突推进，80—160字",
      "beats": [
        {"type": "setup",   "event": "切入本章情境的触发事件", "emotional": "本章起始情绪", "requiredEntities": ["必须出现的人名/地名/专名"], "foreshadowing": ["本章埋下的伏笔（有才填）"]},
        {"type": "rise",    "event": "冲突升级/人物行动推进", "emotional": "情绪变化", "requiredEntities": [], "foreshadowing": []},
        {"type": "climax",  "event": "本章高潮/关键转折", "emotional": "高潮情绪", "requiredEntities": [], "foreshadowing": []},
        {"type": "hook",    "event": "章末钩子/悬念/承接下一章的线索", "emotional": "章末情绪落点", "requiredEntities": [], "foreshadowing": []}
      ],
      "emotionalArc": "本章情绪弧：从X到Y，用一句话概括",
      "requiredEntities": ["本章必须使用的核心实体汇总"]
    }
  ],
  "glossary": {
    "characters": [{"name":"人名","identity":"身份","age":"岁数","gender":"性别","appearance":"外貌","hobby":"爱好","relation":"关系","trait":"性格"}],
    "places": [{"name":"地名","type":"类型","note":"设定"}],
    "propernouns": [{"name":"专名","note":"含义"}]
  }
}

【硬性约束】
1. titles 与 chapterPlans 数量必须严格等于用户提示中指定的章节数，顺序一一对应。
2. 每章 chapterPlans[i].beats 必须恰好包含 4 段，type 严格为 setup / rise / climax / hook，顺序不可变。
3. summary 80—160 字；每段 beat.event 10—40 字；emotional 1—8 字。
4. requiredEntities 与 foreshadowing 只能使用设定词典中已有人名/地名/专名，禁止自造新名。
5. glossary 人物必须 7 字段齐全；人物字段自洽（年龄与履历/居住年限不矛盾）。
6. 若用户提示中出现【写作风格】块，主线简述与标题措辞必须优先贴合。
7. 若用户提示中出现【核心定位】与【深层主题】，主线简述必须优先服务于核心冲突。
8. 只输出上述 JSON，不要 markdown 代码块、不要解释。

【输出示例】
{
  "titles": ["第1章 雾中第七日", "第2章 旧信"],
  "chapterPlans": [
    {
      "summary": "第七次大雾降临，退休法医沈渔接到女儿失踪前的最后一条语音，决定重返旧案现场。",
      "beats": [
        {"type": "setup",  "event": "大雾降临，沈渔独居小屋接到女儿语音", "emotional": "不安", "requiredEntities": ["沈渔"], "foreshadowing": ["旧信"] },
        {"type": "rise",   "event": "她重返旧案现场，发现与三十年前案件相同的符号", "emotional": "警觉", "requiredEntities": ["沈渔"], "foreshadowing": [] },
        {"type": "climax", "event": "她在雾中看见一个与已故凶手身形一致的人", "emotional": "震惊", "requiredEntities": ["沈渔"], "foreshadowing": [] },
        {"type": "hook",   "event": "她回到家，发现门缝里塞着三十年前的旧信封", "emotional": "悬念", "requiredEntities": ["旧信"], "foreshadowing": ["旧信"] }
      ],
      "emotionalArc": "从孤独不安到震惊悬念",
      "requiredEntities": ["沈渔", "旧信"]
    }
  ],
  "glossary": {...}
}`;

// 4.7 Pro（第7章指令2）：新常量用旧名，引用点零改动自动升级
const CHAPTER_PLAN_SYS = CHAPTER_PLAN_SYS_PRO;

/* ============ v1.0.134 规划师五段拆分 ============
 * 原「全书规划师」一次请求产出 标题+简述+节拍+词典，30 章可达 2.6 万字，易截断。
 * 现拆成 5 个独立阶段（各自可单独重跑）：
 *   ① 主线简述 PLANNER_SUMMARY_SYS    → chapterPlans[i].summary（分批，批间携前文骨架）
 *   ② 章节标题（复用 REGEN_TITLES_SYS）→ chapters[i].title
 *   ③ 节拍表   PLANNER_BEATS_SYS      → chapterPlans[i].beats（分批）
 *   ④ 万物词典 PLANNER_GLOSSARY_SYS   → glossary
 *   ⑤ 伏笔网   PLANNER_FORESHADOW_SYS → _foreshadowLedger
 */

// ① 主线简述：每批只返回 summary（+ 本章核心实体），量最小、是全书第一步，后续各阶段以它为基。
const PLANNER_SUMMARY_SYS = `你是一位资深长篇小说「主线简述规划师」。请为指定批次的章节各写一段主线简述，作为全书叙事的第一层骨架。
【输入】会给出：核心定位/深层主题、导航灯塔、结构骨架、本批次章节标题、可能的已定稿前文骨架、设定词典、写作风格。
【输出格式】严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{
  "chapterPlans": [
    {"summary": "本章主线简述：关键事件+人物动向+冲突推进，80—160字", "requiredEntities": ["本章必须出现的核心人名/地名/专名"]}
  ]
}
【硬性约束】
1. chapterPlans 数量必须严格等于用户提示中指定的章节数，顺序一一对应。
2. 每章 summary 80—160 字；只写「本章发生什么、人物怎么动、冲突怎么推」，不写环境铺陈、不写无信息量装饰语。
3. 若本章属于某幕，summary 开头须注明「第X幕」；情节必须服务结构骨架的 mission 与 mustHappen。
4. 若提供了【已定稿的前文骨架】，本章情节必须自然承接前文状态，不得推翻已发生事件（前文骨架内容可稍长，仅作衔接参考，不算入正文字数）。
5. requiredEntities 只能使用设定词典中已有人名/地名/专名，禁止自造新名。
6. 若出现【写作风格】块，措辞必须优先贴合。`;

// ③ 节拍表：每批只返回 4 段节拍（+ 情绪弧 + 核心实体汇总），以既有主线简述为锚。
const PLANNER_BEATS_SYS = `你是一位资深长篇「节拍设计师」。请为指定批次的章节，基于它们已有的【主线简述】与【已定稿的前文骨架】生成四段节拍表。
【输入】会给出：本批次每章主线简述、核心定位/深层主题、结构骨架、设定词典。
【输出格式】严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{
  "chapterPlans": [
    {
      "beats": [
        {"type":"setup",  "event":"切入本章情境的触发事件，10—40字", "emotional":"情绪，1—8字", "requiredEntities":["必须出现的人名/地名/专名"], "foreshadowing":["本章埋下的伏笔（有才填）"]},
        {"type":"rise",   "event":"冲突升级/人物行动推进", "emotional":"情绪变化", "requiredEntities":[], "foreshadowing":[]},
        {"type":"climax", "event":"本章高潮/关键转折", "emotional":"高潮情绪", "requiredEntities":[], "foreshadowing":[]},
        {"type":"hook",   "event":"章末钩子/悬念/承接下一章的线索", "emotional":"章末情绪落点", "requiredEntities":[], "foreshadowing":[]}
      ],
      "emotionalArc": "本章情绪弧：从X到Y，用一句话概括",
      "requiredEntities": ["本章必须使用的核心实体汇总"]
    }
  ]
}
【硬性约束】
1. chapterPlans 数量必须严格等于用户提示中指定的章节数，顺序一一对应。
2. 每章 beats 必须恰好 4 段，type 严格为 setup / rise / climax / hook，顺序不可变。
3. 节拍事件必须从该章主线简述推导，不得偏离主线、不得自创剧情。
4. requiredEntities 与 foreshadowing 只能使用设定词典中已有人名/地名/专名，禁止自造新名。
5. 精简输出（提速）：每段 beat 的 event 只写一句话（≤40 字），不得展开描写；每段 requiredEntities 至多 2 个；emotional ≤6 字。
6. 只输出上述 JSON，不要 markdown 代码块、不要解释。`;

// ④ 万物词典：产出初期词典种子，合并进权威词典（同名以现有为准）。
const PLANNER_GLOSSARY_SYS = `你是一位长篇「设定词典构建师」。请基于全书结构骨架、全部章节主线简述与标题，产出作品初期万物词典。
【输出格式】严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{
  "glossary": {
    "characters": [{"name":"人名","identity":"身份","age":"岁数","gender":"性别","appearance":"外貌","hobby":"爱好","relation":"关系","trait":"性格"}],
    "places": [{"name":"地名","type":"类型","note":"设定"}],
    "propernouns": [{"name":"专名","note":"含义"}]
  }
}
【硬性约束】
1. 只收录主线简述中实际出现或明显会贯穿全书的人/地/专名，宁缺毋滥；禁止为了凑数自造名称。
2. 人物 name 必须符合《百家姓》姓氏+两字名（中国角色）；7 个字段尽量齐全，age 与履历不得矛盾。
3. 若输入中已给出【现有词典】，同名条目不要重复输出，只补缺失条目。
4. 只输出上述 JSON。`;

// ⑤ 伏笔网：跨章节设计伏笔—回收链，写入伏笔台账。
const PLANNER_FORESHADOW_SYS = `你是一位长篇「伏笔设计师」。请基于全部章节主线简述与标题，设计一张贯穿全书的伏笔网络（植入章—回收章配对）。
【输出格式】严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{
  "foreshadows": [
    {"plantChapter": 5, "payoffChapter": 21, "text": "伏笔内容（≤40字）", "type": "人物/物件/事件/设定"}
  ]
}
【硬性约束】
1. 伏笔必须能从主线简述中找到依据，禁止无中生有；每条给出明确的植入章与回收章（回收章 > 植入章）。
2. 全书记 5—15 条为宜；重大主线伏笔 1—3 条贯穿全书，其余为局部小伏笔（回收跨度 3—8 章）。
3. 回收章的剧情必须能承接该伏笔的兑现。
4. 只输出上述 JSON，不要 markdown 代码块、不要解释。`;

// v1.0.116 小说核心锚点提取器：从完整线性简介中提炼「核心一句话定位 + 深层命题」，作为下游 AI 的导航灯塔。
// 只读提炼，不做创作；低温(0.2)严格把关，不改变 logline 本身。
const ANCHOR_EXTRACT_SYS = `你是小说核心定位提取器。给定一段完整的小说简介（通常按开端—发展—高潮—结局的顺序写成一段连续叙事），请从整段中主动提炼最核心的定位，而不是照抄简介的开头或结尾。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"anchor":"核心一句话定位，≤50字，须包含 题材+主角+核心冲突 三要素","thesis":"深层主题命题，≤80字，点出作品要探讨的核心主题/情感内核"}`;

// v1.0.115 本章梗概（速读）：把本章正文压缩到约 1/3 字数，作为用户没耐心读完全文时的省时阅读工具。
// 最大来源是本章真实正文；规划师主线简述与该章词典仅作覆盖性参考；区别于「主线简述(chapterPlans)」。
// 4.7 Pro（3.9/第7章指令2）：旧常量改名 STRIP_READ_SYS_LEGACY 保留回退，新常量用旧名指向 STRIP_READ_SYS_PRO。
const STRIP_READ_SYS_LEGACY = `你是一名长篇章节「速读梗概」撰写助手。本章梗概的最大来源是本章正文，其余（主线简述、词典）仅作参考；你要做的是把本章正文压缩到约 1/3 的字数，让没耐心读完全文的读者能省时读完，却基本不失信息。
要求：
1. 只依据【本章真实正文】概括，覆盖：主要情节推进、关键对话意图、人物状态变化、情绪转折、章末悬念/钩子。
2. 可舍弃：环境描写、场景铺陈、修辞排比、次要过程性动作。
3. 不得遗漏正文中的人物、地点、专名、关键事件与因果；不得虚构正文没有的内容；不剧透下一章。
4. 目标字数约 [TARGET_ZHS] 字，请落在目标字数的 0.9–1.1 倍区间内（即 [LO_HI] 字之间）。
5. 只输出梗概正文本身，不要 markdown 代码块、不要「第N章」前缀、不要解释。`;

// 4.7 Pro（3.9 原码）：资深速读梗概专员（目标字数严格区间 + 失败自报注释）
const STRIP_READ_SYS_PRO = `你是一位资深长篇章节「速读梗概专员」。
【核心任务】把本章正文压缩到约 1/3 字数，让没耐心读完全文的读者省时读完且基本不失信息。

【输出要求】
1. 只依据【本章真实正文】概括，覆盖：主要情节推进、关键对话意图、人物状态变化、情绪转折、章末悬念/钩子。
2. 可舍弃：环境描写、场景铺陈、修辞排比、次要过程性动作。
3. 不得遗漏正文中的人物、地点、专名、关键事件与因果；不得虚构正文没有的内容；不剧透下一章。
4. 目标字数 [TARGET_ZHS] 字，必须落在 [LO_HI] 字之间（目标字数的 0.9–1.1 倍）。
5. 只输出梗概正文本身，不要 markdown 代码块、不要「第N章」前缀、不要解释。

【失败处理】
若无法达到字数区间，请在输出末尾附加单行：<!-- STRIP_LEN: 实际字数 -->，程序将捕获并提示用户。`;

// 4.7 Pro（第7章指令2）：新常量用旧名，引用点零改动自动升级
const STRIP_READ_SYS = STRIP_READ_SYS_PRO;

// 4.7 Pro（3.9 原码）：梗概字数区间校验
function validateStripLen(text, target){
  const len = countWords(String(text||'')).cjk;
  const lo = Math.round(target * 0.9);
  const hi = Math.round(target * 1.1);
  return { ok: len >= lo && len <= hi, len, lo, hi };
}

/* ---------- 4.7 Pro 第 4 章 · 统一校验层 ---------- */
// 集中各 AI 的 validateXXXOutput()。修复 md 原码 bug：idea 指向的 validateIdeaOutput 不存在，
// 4.5 已有 validatePolishOutput（返回字符串约定），此处指向它；其余按 4.7 Pro 各节新增的 validator。
const AIValidators = {
  idea: validateIdeaProOutput,   // 4.8 适配：兼容 4.7 Pro 的 {diagnosis,brief,advice} 结构与 4.5 的 optimizedIdea 结构
  outline: validateOutlineFaithful,   // v228/P3：结构 + 忠实度双闸（未保留用户构想核心词将被打回修复队列）
  titles: validateTitleOutput,
  chapterPlan: validateChapterPlanOutput,
  chapter: validateChapterContent,  // 4.5 已有
  subplot: validateSubplotOutput,
  glossary: validateGlossaryExtract,
  strip: validateStripLen
};

// 4.8 适配修复：4.7 Pro 优化构想 AI 输出 {diagnosis, brief, advice}（非 4.5 的 optimizedIdea 结构），
// 统一校验入口对两种结构都放行；4.5 结构仍走 validatePolishOutput 严格校验。
// v225/P6：新增本地忠实度校验——从 ctx.rawIdea（callAIGuarded 新形态经 AIBus.get('idea') 注入的用户原文）提取必须保留的关键词，
// 优化稿/方案未保留过半则拦截（走既有修复队列重试链，不删稿）。
// 从用户原文提取"必须保留"的关键词：引号/书名号内词 + 高频实词窗（出现≥2次）
function ideaKeyTerms(idea){
  const t = String(idea||'').trim();
  const must = new Set();
  (t.match(/[“"「『《]([^”"」』》]{1,12})[”"」』》]/g)||[]).forEach(s=>{ const w=s.slice(1,-1).trim(); if(w) must.add(w); });
  const words = t.match(/[\u4e00-\u9fa5a-zA-Z0-9]{2,8}/g)||[];
  const STOP = new Set(['一个','一种','这个','那个','什么','怎么','可以','我们','他们','自己','故事','主角','因为','所以','但是','然后','就是','不是']);
  const freq = {}; words.forEach(w=>{ if(!STOP.has(w)) freq[w]=(freq[w]||0)+1; });
  Object.keys(freq).forEach(w=>{ if(freq[w]>=2) must.add(w); });
  return { must:[...must], short: t.length < 15 };
}
// 返回 ''=通过，否则返回不忠实原因（走既有修复队列链，不删稿）
function validateIdeaFaithful(j, idea){
  const { must, short } = ideaKeyTerms(idea);
  if(short || !must.length) return '';                    // 极短输入/无关键词：豁免（靠提示词硬边界约束）
  const blob = JSON.stringify(j);
  const miss = must.filter(w => !blob.includes(w));
  return (miss.length <= must.length * 0.5) ? '' : `优化稿未保留用户核心设定词（缺 ${miss.length}/${must.length}）：${miss.slice(0,5).join('、')}`;
}
function validateIdeaProOutput(j, ctx){
  if(!j || typeof j !== 'object') return {ok:false, code:'EMPTY'};
  if(j.brief && typeof j.brief === 'object'){
    // v225/P6：本地忠实度拦截（code=UNFAITHFUL；第二参 ctx 为旧形态调用时的透传，无 rawIdea 则豁免）
    const bad = validateIdeaFaithful(j, (ctx && ctx.rawIdea) || '');
    if(bad) return {ok:false, code:'UNFAITHFUL', details:bad};
    return {ok:true};   // 4.7 Pro 结构（brief 存在即通过）
  }
  if(Array.isArray(j.options) && j.options.length){
    // v225/P6：多方案载体逐方案忠实度校验
    const idea = (ctx && ctx.rawIdea) || '';
    for(const op of j.options){ const bad = validateIdeaFaithful(op, idea); if(bad) return {ok:false, code:'UNFAITHFUL', details:bad}; }
    return {ok:true};   // 4.9 加固：多方案载体（{options:[...]}）放行，展示层已有兼容解析
  }
  const err = validatePolishOutput(j);                            // 4.5 结构（字符串约定）
  return err ? {ok:false, code:'SCHEMA', details:err} : {ok:true};
}

// 4.7 Pro（第 4 章原码）：统一校验入口。
// 适配修复①：4.5 校验器存在两类返回约定——{ok:boolean} 对象（validateTitleOutput 等）与字符串（''=通过，非空=错误信息，validatePolishOutput/validateOutlineOutput），此处归一化。
// 适配修复②：chapter / strip 属于「非 JSON 输出」（正文/梗概为纯文本），extractJsonObject 会毁掉原文，直接传 raw 原文给校验器。
function validateAIOutput(kind, raw, ctx){
  const j = extractJsonObject(raw);
  if(j && j.error) return {ok:false, code:'AI_ERROR', details:j.error};
  const fn = AIValidators[kind];
  if(!fn) return {ok:true};
  const arg = (kind === 'chapter' || kind === 'strip') ? raw : j;
  const r = fn(arg, ctx);
  if(r && typeof r === 'object' && 'ok' in r) return r;                       // {ok} 对象约定
  if(typeof r === 'string') return r ? {ok:false, code:'SCHEMA', details:r} : {ok:true};  // 4.5 字符串约定
  return r ? {ok:false, code:'SCHEMA', details:String(r)} : {ok:true};
}

// 4.7 Pro（第 4 章原码）：统一「调用 + 校验」入口；校验失败抛错（上层可接入 4.6 Plus 修复队列）。
// 4.8 旗舰版（第 4 章 4.4）：新形态 callAIGuarded(kind, extra, opts)——system / user / ctx 全部由 AIBus 派生；
// 兼容旧形态 callAIGuarded(kind, system, user, ctx, opts)（第二参为字符串时按 4.7 逻辑执行）。
async function callAIGuarded(kind, systemOrExtra, userOrOpts, ctx, opts){
  // v227 分任务模型：kind（'idea'/'outline'）在 TM_KEYS 内时透传为 taskKey，新旧形态共用；其余 kind 不注入（跟随全局）
  const _tmKey = TM_KEYS.includes(kind) ? kind : null;
  // 4.9 修复：callDeepSeek 已改为返回 {text, finishReason, usage} 对象，必须经 unwrapAIResult 解包为纯文本后再校验/回传；
  // 否则对象被 String() 转成 "[object Object]"，JSON 解析必然失败（大纲误报「SCHEMA 返回不是对象」、构想误报「EMPTY」），
  // 且回传给调用方的也是对象导致结果永远无法落盘展示。此处同时检测 finishReason==='length'（输出被 max_tokens 截断）并抛出明确错误。
  const _unwrap = (res) => {
    const txt = unwrapAIResult(res);
    if(res && res.finishReason === 'length'){
      throw new Error(`${kind} AI 输出被截断，请增大输出上限或减少篇幅后重试`);
    }
    return txt;
  };
  if(typeof systemOrExtra === 'string'){
    // 4.7 旧形态：callAIGuarded(kind, system, user, ctx, opts)
    const txt = _unwrap(await callDeepSeek(systemOrExtra, userOrOpts, Object.assign({}, opts||{}, _tmKey?{taskKey:_tmKey}:{})));
    const report = validateAIOutput(kind, txt, ctx);
    if(!report.ok){
      throw new Error(`${kind} AI 输出校验失败：${report.code} ${report.details || ''}`);
    }
    return txt;
  }
  // 4.8 新形态：callAIGuarded(kind, extra, opts)
  const extra = systemOrExtra || {};
  const callOpts = Object.assign({}, userOrOpts||{}, _tmKey?{taskKey:_tmKey}:{});   // v227 分任务模型透传
  const system = getSystemPrompt(kind, extra);
  const user = buildAIPrompt(kind, extra);
  const busCtx = AIBus.get(kind, extra);
  const txt = _unwrap(await callDeepSeek(system, user, callOpts));
  const report = validateAIOutput(kind, txt, busCtx);
  if(!report.ok){
    throw new Error(`${kind} AI 输出校验失败：${report.code} ${report.details || ''}`);
  }
  return txt;
}

/* ==================== 4.8 旗舰版：AIBus 统一数据总线（第 4 章 4.2） ==================== */
// 所有 AI 调用前不直接拼接 state 字段，一律经 AIBus.get(kind) 读取已校验的结构化上下文；
// 自动过滤未生成的上游数据、自动附加 styleContract 与 navBeacon。
// 适配说明（相对 md 原码）：state.writeStyle → state.chapterStyle（项目写作风格状态）；
// state.subplotLog → outline.glossary.subplots（项目副线存储）；getRollingSummariesForChapter → buildRollingSummary（项目现有实现）。
const AIBus = {
  get(kind, extra){
    const o = state.outline || {};
    const sc = state.styleContract || null;
    const nb = o.navBeacon || '';
    const base = {
      mode: state.mode,
      longMode: isLong(),
      navBeacon: nb,
      styleContract: sc,
      idea: state.idea || '',
      userParams: {
        chapterCount: chapterCountVal() || 30,
        loglineMin: state.loglineRange?.min ?? 300,
        loglineMax: state.loglineRange?.max ?? 700
      }
    };
    switch(kind){
      case 'idea': return { ...base, rawIdea: state.idea || '', loglineRange: state.loglineRange };
      case 'recipe': return { ...base, outline: o, existingTags: (state.chapterStyle?.tags||[]) };
      case 'outline': return { ...base, polishBrief: state._lastPolishBrief || null, originality: ORIGINALITY_OUTLINE_SYS };
      case 'titles': return { ...base, outline: o, glossary: o.glossary, expectedN: extra?.n || (o.chapters||[]).length };
      case 'chapterPlan': return { ...base, outline: o, titles: (o.chapters||[]).map(c=>c.title), glossary: o.glossary };
      case 'chapter': return this._chapterCtx(extra?.idx);
      case 'subplot': return { ...base, chapterIdx: extra?.idx, content: state.chapters[extra?.idx]?.content, subLines: o.structure?.subLines, prevLog: (o.glossary?.subplots)||[] };
      case 'glossary': return { ...base, chapterIdx: extra?.idx, content: state.chapters[extra?.idx]?.content, existingGlossary: o.glossary };
      case 'strip': return { ...base, chapterIdx: extra?.idx, content: state.chapters[extra?.idx]?.content, targetZhs: extra?.targetZhs };
      default: return base;
    }
  },

  // 正文 AI 的 L0-L4 分层上下文（第 3 章 3.6）
  _chapterCtx(idx){
    const o = state.outline || {};
    const c = state.chapters[idx];
    const prev = state.chapters[idx-1];
    const next = state.chapters[idx+1];
    const plan = (o.chapterPlans||[])[idx] || {};
    return {
      mode: state.mode, longMode: isLong(),
      navBeacon: o.navBeacon || '',
      styleContract: state.styleContract || null,
      L0_style: state.styleContract,
      L1_outline: { title: o.title, logline: o.logline, tone: o.tone, structure: o.structure, total: (o.chapters||[]).length, idx: idx+1 },
      L2_chapter: { title: c?.title, summary: plan.summary, beats: plan.beats, emotionalArc: plan.emotionalArc, requiredEntities: plan.requiredEntities },
      L3_neighbor: { prevTitle: prev?.title, prevTail: prev?.content?.slice(-300), nextTitle: next?.title, lastScene: o._factCard?.lastScene },
      L4_context: { rollingSummaries: buildRollingSummary(idx), relevantGlossary: relevantGlossaryForChapter(idx), unresolvedHooks: o._factCard?.unresolvedHooks || [] }
    };
  }
};

// 4.8 旗舰版（第 4 章 4.4）：根据 kind 返回 *_PRO 系统提示词（outline/chapter 为组装函数，strip 注入目标字数）
function getSystemPrompt(kind, extra){
  switch(kind){
    case 'idea': return IDEA_POLISH_SYS + (extra && extra.multi ? POLISH_MULTI_MODE : '');   // 4.9 加固：多方案开关接线（此前 POLISH_MULTI_MODE 只定义从未拼入，勾选「多方案」实际不生效）
    case 'recipe': return AI_RECIPE_SYS_PRO;
    case 'outline': return buildOutlineSys();
    case 'titles': return REGEN_TITLES_SYS;
    case 'chapterPlan': return CHAPTER_PLAN_SYS;
    case 'chapter': return longChapterSys();
    case 'subplot': return SUBPROGRESS_UPDATE_SYS;
    case 'glossary': return GLOSSARY_EXTRACT_SYS;
    case 'strip': {
      const ctx = AIBus.get('strip', extra);
      const target = ctx.targetZhs || 300;
      const lo = Math.round(target*0.9), hi = Math.round(target*1.1);
      return STRIP_READ_SYS.replace('[TARGET_ZHS]', target).replace('[LO_HI]', `${lo}–${hi}`);
    }
    default: throw new Error('未知 AI kind: '+kind);
  }
}

// 4.8 旗舰版（第 4 章 4.3）：prompt 组装统一路由——所有 AI 的 user 都经 buildAIPrompt(kind, extra) 产出
// 适配说明（相对 md 原码）：titles/chapterPlan/chapter 复用项目 4.7 已有组装函数（titlesGenUser/chapterPlanUser/buildChapterUser）；
// idea/recipe/outline/subplot/glossary/strip 由下方新增的 build*User(ctx) 承接（与项目既有内联拼装等价）。
function buildAIPrompt(kind, extra){
  const ctx = AIBus.get(kind, extra);
  switch(kind){
    case 'idea': return buildIdeaPolishUser(ctx);
    case 'recipe': return buildRecipeUser(ctx);
    case 'outline': return buildOutlineUser(ctx);
    case 'titles': return titlesGenUser(extra);
    case 'chapterPlan': return chapterPlanUser();
    case 'chapter': return buildChapterUser(extra?.idx, extra);
    case 'subplot': return buildSubplotUser(ctx);
    case 'glossary': return buildGlossaryExtractUser(ctx);
    case 'strip': return buildStripUser(ctx);
    default: throw new Error('未知 AI kind: '+kind);
  }
}

// —— 4.8 新增组装函数（与项目既有内联拼装等价，供 buildAIPrompt 统一路由） ——
function buildIdeaPolishUser(ctx){
  return `【用户构想】\n${ctx.rawIdea || ''}`;
}
function buildRecipeUser(ctx){
  return aiRecipeUser(ctx.idea);
}
function buildOutlineUser(ctx){
  // 与 4.7 Pro（3.2）genOutline 的 user 拼装等价：【用户构想】+【优化构想简报】
  const brief = ctx.polishBrief ? formatNavBeaconForOutline() : '';
  return `【用户构想】\n${ctx.idea}\n\n${brief ? '【优化构想简报】\n' + brief : ''}`;
}
function buildSubplotUser(ctx){
  const chIdx = ctx.chapterIdx;
  const body = String(ctx.content || '').trim();
  const o = state.outline || {};
  const g = (o.glossary) || {};
  const subs = (Array.isArray(g.subplots)?g.subplots:[]).filter(Boolean);
  const prog = subs.map(s=>{
    const nm = String(s.name||'').trim() || '（未命名）';
    const ts = (Array.isArray(s.log)?s.log:[]).map(x=>`第${x.ch}章${x.note?`（${x.note.trim()}）`:''}`).join(' → ');
    const q = String(s.question||'').trim();
    return `· ${nm}（${['进行中','搁置','已收束'].includes(s.status)?s.status:'进行中'}）${q?`｜问：${q}`:''}\n  ${ts||'（尚无进度）'}`;
  }).join('\n') || '（暂无副线）';
  const mainLine = String(o.mainLine||'').trim();
  const curPlan = (Array.isArray(o.chapterPlans)&&o.chapterPlans[chIdx]) ? chapterPlanText(o.chapterPlans[chIdx]) : '';
  return `【本章正文（第 ${chIdx+1} 章）】\n${String(body).slice(-50000)}\n\n【现有副线进度】\n${prog}${mainLine?`\n\n【全书主线】\n${mainLine}`:''}${curPlan?`\n\n【本章主线简述】\n${curPlan}`:''}`;
}
function buildGlossaryExtractUser(ctx){
  const o = state.outline || {};
  const g = (o.glossary) || {};
  const dict = [['characters','人物'],['places','地点'],['propernouns','专名']].map(([k,label])=>{
    const arr = (g[k]||[]).map(x=>x&&x.name).filter(Boolean);
    return arr.length ? `${label}：${arr.join('、')}` : `${label}：（无）`;
  }).join('\n');
  return `【现有词典】\n${dict}\n\n【本章正文】\n${String(ctx.content||'').slice(-50000)}`;
}
function buildStripUser(ctx){
  const chIdx = ctx.chapterIdx;
  const o = state.outline || {};
  const title = (state.chapters[chIdx] && state.chapters[chIdx].title) || ((o.chapters&&o.chapters[chIdx]&&o.chapters[chIdx].title)) || ('第'+(chIdx+1)+'章');
  const plan = (o && Array.isArray(o.chapterPlans) && o.chapterPlans[chIdx]) ? chapterPlanText(o.chapterPlans[chIdx]).trim() : '';
  const g = o.glossary || {};
  const dict = [
    ...(g.characters||[]).map(x=>'人物『'+((x&&x.name)||'')+'』'+((x&&x.identity)?'－'+x.identity:'')),
    ...(g.places||[]).map(x=>'地名『'+((x&&x.name)||'')+'』'),
    ...(g.propernouns||[]).map(x=>'专名『'+((x&&x.name)||'')+'』')
  ].slice(0,90).join('、');
  return `${outlineAnchorBlock()?outlineAnchorBlock()+'\n':''}【全书简介】书名：${o.title||''}\n${o.logline||''}\n\n【本章标题】${title}\n\n${plan?`【主线简述（应覆盖锚点）】${plan}\n\n`:''}${dict?`【本章词典（必保不得遗漏）】${dict}\n\n`:''}【本章真实正文】\n${String(ctx.content||'').slice(-50000)}`;
}

/* ==================== 4.8 旗舰版：风格层去重（第 5 章 5.4） ==================== */
// 三个概念职责边界：文章风格 tone（大纲 AI 定）< 写作风格卡片 writeStyle（用户/配方推荐）< 写作风格契约 styleContract（配方 AI 量化）。
// 优先级：用户手动覆盖 > styleContract > writeStyle.tags 描述 > outline.tone（量化指标 > 标签描述 > 情绪基调）。
// 适配说明（相对 md 原码）：state.writeStyle → state.chapterStyle（项目写作风格状态）。
// v1.0.133：DNA→契约的统一构造（供 resolveStyleContract 与 extractStyleDNA 回写共用，保证 system/user 两路取数一致）
function dnaContract(fp){
  return {
    sentenceAvg: Number.isFinite(fp.sentenceAvg) ? fp.sentenceAvg : 22,
    sentenceTolerance: 0.15,   // DNA 模式更严格
    dialogueRatio: Number.isFinite(fp.dialogueRatio) ? fp.dialogueRatio : 0.35,
    dialogueTolerance: 0.15,
    forbiddenPhrases: fp.forbiddenPhrases || [],
    preferredTransitions: fp.preferredTransitions || [],
    rhythmNote: fp.rhythmNote || '按风格 DNA 执行',
    _dna: true
  };
}
function resolveStyleContract(){
  // 1. 如果用户手动覆盖了 styleContract，直接返回
  if(state._manualStyleContract) return state._manualStyleContract;
  // 4.8 旗舰版（板块三-4）：文学风格 DNA 作为最高优先级契约数据源（模仿特定作家笔锋）
  if(state._styleDNA && state._styleDNA.fingerprint){
    return dnaContract(state._styleDNA.fingerprint);
  }
  // 2. 如果配方助手已生成，返回生成的
  if(state.styleContract) return state.styleContract;
  // 3. 否则从 writeStyle.tags 推导一个默认契约
  return deriveStyleContractFromTags(state.chapterStyle?.tags || []);
}

function deriveStyleContractFromTags(tags){
  // 基于词库词条 id，给出合理的默认量化指标
  const base = { sentenceAvg: 28, sentenceTolerance: 0.2, dialogueRatio: 0.35, dialogueTolerance: 0.1, forbiddenPhrases: [], preferredTransitions: [], rhythmNote: '无' };
  if(tags.includes('kouwen')){ base.sentenceAvg = 18; base.rhythmNote = '短句、口语化、节奏快'; }
  if(tags.includes('xuanxuan')){ base.sentenceAvg = 35; base.dialogueRatio = 0.2; base.rhythmNote = '长句铺陈、环境描写多、对话少'; }
  // ... 其他词条映射
  return base;
}

function buildStyleNote(styleOverride){
  // 组装成 prompt 中使用的【风格说明】块
  const sc = resolveStyleContract();
  const tags = (state.chapterStyle?.tags || []).map(id => {
    const s = writeStyleLib().find(x=>x.id===id);
    return s ? s.name : id;
  }).join('、');
  const parts = [];
  parts.push(`【文章风格基调】${state.outline?.tone || '未指定'}`);
  if(tags) parts.push(`【写作风格标签】${tags}`);
  parts.push(`【写作风格契约】平均句长 ${sc.sentenceAvg} 字（±${Math.round(sc.sentenceTolerance*100)}%），对话占比 ${Math.round(sc.dialogueRatio*100)}%（±${Math.round(sc.dialogueTolerance*100)}%），禁用词：${(sc.forbiddenPhrases||[]).join('、') || '无'}，偏好转场：${(sc.preferredTransitions||[]).join('、') || '无'}，节奏说明：${sc.rhythmNote || '无'}`);
  return parts.join('\n');
}

/* ==================== 4.8 旗舰版：AI 协作看板与路由层（第 6 章） ==================== */

// 6.2 AI 协作看板渲染（阶段状态：done / running / blocked / ready）
function renderAINetworkPanel(){
  const net = state.aiNetwork || {};
  const stages = [
    {key:'idea', label:'优化构想', deps:[]},
    {key:'recipe', label:'配方设计', deps:[]},
    {key:'outline', label:'生成大纲', deps:['idea']},
    {key:'titles', label:'生成标题', deps:['outline']},
    {key:'plan', label:'规划章节', deps:['outline','titles']},
    {key:'writing', label:'撰写正文', deps:['plan']},
    {key:'review', label:'后验审查', deps:['writing']}
  ];
  const html = stages.map(s => {
    const done = net.completed?.includes(s.key);
    const running = net.running?.includes(s.key);
    const blocked = s.deps.some(d => !net.completed?.includes(d));
    const cls = done ? 'done' : (running ? 'running' : (blocked ? 'blocked' : 'ready'));
    return `<div class="ai-stage ${cls}">${s.label}</div>`;
  }).join('');
  return `<div class="ai-network-panel">${html}</div>`;
}

// 6.3 路由层：强制按拓扑顺序执行（唯一执行前检查入口）。
// 4.8 修复（md 第 2 章顺序 0「优化构想 AI 可选，用户已有好构想可跳过」与 6.3 deps 硬依赖矛盾）：
// idea 视为可跳过步骤——未跑优化构想不阻塞大纲生成。
function canRunAI(kind){
  const deps = {
    idea: [],
    recipe: [],
    outline: ['idea'],
    titles: ['outline'],
    chapterPlan: ['outline','titles'],
    chapter: ['outline','titles','chapterPlan'],
    subplot: ['chapter'],
    glossary: ['chapter'],
    strip: ['chapter']
  };
  const net = state.aiNetwork;
  return (deps[kind]||[]).every(d => d === 'idea' || net.completed?.includes(d) || d === kind);
}

function markAIRunning(kind){
  state.aiNetwork.running = Array.from(new Set([...(state.aiNetwork.running||[]), kind]));
  persist();
}

function markAIDone(kind){
  state.aiNetwork.running = (state.aiNetwork.running||[]).filter(k=>k!==kind);
  state.aiNetwork.completed = Array.from(new Set([...(state.aiNetwork.completed||[]), kind]));
  persist();
}

// 6.4 失败进修复队列：与 4.6 Plus 修复队列打通（正文条目 {ch,...} 与 AI 协作条目 {kind,...} 双结构兼容）
function addToFixQueue(entry){
  state._fixQueue = state._fixQueue || [];
  if(entry && Number.isInteger(entry.ch)){
    // 正文条目（4.6 Plus 结构）：按章去重
    const exist = state._fixQueue.find(x => x.ch === entry.ch);
    if(exist){ exist.attempts = (exist.attempts||1) + 1; exist.ts = Date.now(); }
    else state._fixQueue.push({ ch:entry.ch, code:entry.code, errors:entry.errors||[], attempts:1, ts:Date.now() });
  } else if(entry && entry.kind){
    // AI 协作类条目（4.8 结构）：按 kind 去重
    const exist = state._fixQueue.find(x => x.kind === entry.kind && !Number.isInteger(x.ch));
    if(exist){ exist.error = entry.error; exist.attempts = (exist.attempts||1)+1; exist.ts = Date.now(); }
    else state._fixQueue.push({ kind:entry.kind, error:entry.error, raw:entry.raw||'', attempts:1, ts:Date.now() });
  }
  persist();
}

// v10.12 原创性要求（防雷同）· 大纲侧：防套路结构 + 高频人名 + 流水线标题。
// 独立注入块而非改写各结构常量：一处定义，经组装函数自动覆盖全部结构范式与默认路径。
const ORIGINALITY_OUTLINE_SYS = `【原创性要求（防雷同）】本作追求独特设定，避免与常见网络作品雷同：
1. 拒绝套路模板：不开局退婚/系统提示音/赘婿打脸/主角降智等烂大街桥段；情节逻辑优先从本作独有设定推导，而非套用通用模板。
2. 人名规避（硬约束·中国角色）：人物姓名必须为《百家姓》姓氏+两字名——单姓全名恰 3 个汉字、复姓恰 4 个汉字；名字不叠字；避开网文高频名（如林晚/苏晚/顾沉/云深/顾言之类）。【用户禁则（软硬均须遵守）】全姓名禁止出现汉字「晚」「砚」「秋」「檐」任意一个（任何位置都算）；禁止使用指定名单人名（林辰、苏辰、顾夜寒、陆泽、墨渊、叶辰、江亦琛、傅景深、沈辞、萧景琰、凌夜、顾言、裴衍、楚慕言、厉承勋、谢珩、温景然、云烬、宋砚、慕云凡；苏清月、晚卿、沈知予、顾晚柠、林晚星、慕晚晴、苏沐瑶、温妤、夏晚璃、楚清鸢、叶轻寒、姜知微、云舒、苏念汐、洛清欢、白若曦、顾绾绾、江晚渔、宋知晚、宁疏影）。首字不在百家姓者视为外国角色，不受长度约束，但仍须规避禁用字与禁用名单。可采用职业特征/意象组合造名，姓名风格与世界观一致。
3. 章节标题同理：标题立意避免"xx之怒/惊变/震惊"式流水线命名。`;

// v10.12 原创性要求（防雷同）· 章节侧：防桥段套路 + 高频句式 + 无关套路元素。
const ORIGINALITY_CHAPTER_SYS = `【原创性要求（防雷同）】本章内容追求自然独特：
1. 桥段防套路：避免无理由误会、工具人反派强行送头、为冲突而冲突的降智桥段；冲突应来自前文设定与人物动机的自然推进。
2. 句式防高频：避免网文高频表达（"嘴角勾起一抹冷笑""眼神一凛"等），对话与描写尽量具体、贴合本作人物。
3. 不硬塞元素：不引入与既有设定无关的常见套路元素（金手指/系统/穿越梗等），除非本作设定明确包含。`;

// v1.0.129 语言分层硬约束（仅长篇生效，开关 langLayer 默认开）：书面语造氛围、口语推剧情。
// 源自「写网文要不要用书面语」核心结论——必须会书面语、但绝不滥用；对话说人话、书面语只用于情绪峰值提咖。
const LANG_LAYER_SYS = `【语言分层（硬约束）】
1. 对白一律口语化：台词必须贴合人物身份与说话习惯，像"人话"，禁止"端着"的书面腔（如"此举甚妥""在下以为"）；古风题材也用现代人能听懂的古风（"我瞧着这事不妥"优于"吾观此事实为不妥"）。旁白可文艺，台词必须自然。
2. 书面语只用于"提咖"：大高潮、深情告白、终极顿悟等情绪峰值可用书面语加重分量；日常赶路、打斗过招、系统提示、对白推进一律大白话短句。原则：书面语造氛围，口语推剧情。
3. 可读性自检（不写入输出）：逐句自问"读者需要动脑子拐个弯才能懂吗？"需要即改为大白话，目标是让读者"忘记自己在看字"。
4. 一句话口诀：书面语是你藏起来的底牌，别一上来就全甩桌上。`;

// v1.0.129 语言底色软约束（仅长篇生效）：随题材自动判定语言底色并稳定贯穿全书。开关 langLayer 开启时注入。
function langLayerNote(){
  return `【语言底色（随题材自动调节）】依据本作题材（navBeacon.genre / genreTags / 简介）自动判定语言底色，并稳定贯穿全书：
- 都市 / 网游 / 系统 / 轻松沙雕类：整体贴近生活口语，叙述短句直白，对话大白话，避免咬文嚼字；
- 仙侠 / 科幻史诗 / 红楼风等古雅题材：旁白与叙述可适度用书面语撑起世界观高级感，但对白仍须贴合人设口语化（服从【语言分层】第 1 条）；
- 全书底色一经判定即保持一致，不得在后续章节漂移或推翻。`;
}
// 仅长篇 + 开关开时，返回语言分层提示词（硬约束 + 软约束）；否则返回空串。
function langLayerInjection(){
  if(!isLong() || !state.langLayer) return '';
  return '\n\n' + LANG_LAYER_SYS + '\n\n' + langLayerNote();
}

// v10.15 重生成全部章节标题：保留大纲骨架，只重出标题；服从既有设定 + 用户建议 + 防套路第一优先。
// 4.5：标题 AI 必须参考 structure.acts 的 mustHappen，保证标题能反映结构节点；数量契约由调用点 assertCount 校验。
// 4.7 Pro（3.3/第7章指令2）：旧常量改名 REGEN_TITLES_SYS_LEGACY 保留回退，新常量用旧名指向 REGEN_TITLES_SYS_PRO。
const REGEN_TITLES_SYS_LEGACY = `你是一位深谙标题艺术与长篇小说结构的章节标题策划师。

【核心任务】
根据小说书名、简介、导航灯塔（navBeacon）、结构骨架（structure.acts）、设定词典，为每一章生成一个既有表现力又服从整体结构的标题。

【输出格式】
严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"titles":["第1章 标题","第2章 标题",...]}

【硬性约束】
1. titles 数量必须严格等于【全书章节数 N】，一章不增、一章不减。
2. 每个标题必须满足：
   a. 与本书简介、navBeacon.coreConflict、structure.mainLine 保持一致；
   b. 不剧透后续反转与结局；
   c. 不引入设定词典之外的新人物/地名/专名；
   d. 立意从本作独特设定推导，避免"xx之怒/惊变/震惊"式流水线命名。
3. 标题必须反映结构节点：
   - act1（第 1—N1 章）的标题侧重"引入冲突、建立人物"；
   - act2（第 N1+1—N2 章）的标题侧重"上升行动、困境加深"；
   - act3（第 N2+1—N 章）的标题侧重"高潮、对决、收束"。
4. 若用户提供了【标题风格】（归纳/画龙点睛/文学语句/字数工整），所有标题必须统一服从该风格；若提供了多种风格，以第一个为准。
5. 若用户提供了【重生成要求】，以该要求为最高优先级，但不得违反设定一致性。
6. 相邻标题不得重名或高度相似；同一核心意象全书使用不超过 3 次。
7. 每个标题 ≤ 20 字。`;

// 4.7 Pro（3.3 原码）：资深章节标题策展人 + 标题审计师。
// 修复 md 原码 bug：原文第 1 条含 ${state.outline.chapters.length} 顶层求值（state.outline 为 null 时 ReferenceError），
// 改为不含运行时插值的文案，N 的具体值由 titlesGenUser 在 user 侧注入。
const REGEN_TITLES_SYS_PRO = `你是一位资深长篇小说「章节标题策展人」，同时是标题审计师。
【核心任务】根据给定的小说信息，在【不改变章节数量与顺序】的前提下，为每一章生成一版最终标题。

【必须输出的 JSON 结构】
{"titles":["第1章 标题","第2章 标题",...]}

【标题生成契约】
1. titles 数组长度必须严格等于【N】（N 为用户提示中给定的章节总数），一章不多、一章不少。
2. 每个标题：≤18 字，必须以「第N章」开头（N 为阿拉伯数字），后面接空格，再接章节名。
3. 标题必须：贴合本章剧情走向、不剧透后续反转、不泄露结局、不与相邻章标题重名或高度相似。
4. 标题风格必须贴合【整体情绪基调 tone】与【写作风格】；若风格为「冷峻克制」，标题不得煽情；若风格为「热血燃向」，标题不得过于婉约。
5. 标题中不得引入设定词典以外的新人名/地名/专名。
6. 只输出上述 JSON，不要 markdown 代码块、不要解释。

【输出示例】
{"titles":["第1章 雾中第七日","第2章 旧信","第3章 退休法医"]}`;

// 4.7 Pro（第7章指令2）：新常量用旧名，引用点零改动自动升级
const REGEN_TITLES_SYS = REGEN_TITLES_SYS_PRO;

// v10.13 优化构想 AI：把用户粗糙构想优化为结构化高质量构想（通用核心要素 + 自适应分类要素）。
// 极短输入（<15 字仅题材词）走「骨架展开模式」：给可改草稿 + 显式标注 + 反问清单引导补充独有设定。
// 4.5：输出结构化 JSON（optimizedIdea/defects/navBeacon/seedCharacters/seedPlaces/suggestedChapterCount），配合 validatePolishOutput 校验。
// 4.7 Pro（3.1/第7章指令2）：旧常量改名为 IDEA_POLISH_SYS_LEGACY 保留回退，新常量用旧名指向 IDEA_POLISH_SYS_PRO。
const IDEA_POLISH_SYS_LEGACY = `你是一位深谙长篇网文与影视叙事的构想编辑。你的任务是把用户的粗糙故事构想，优化成一份**结构化、可执行、可校验**的高质量构想。

【输出格式】
必须严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{
  "optimizedIdea": "150-300 字的条目式优化构想（保留用户原意，补全可推导细节）",
  "defects": ["缺陷1：用户构想中缺少xxx", "缺陷2：xxx设定不够具体"],
  "navBeacon": {
    "genre": "题材（如重生复仇/悬疑解谜/末世生存）",
    "protagonist": "主角：身份+核心动机+特殊能力/缺陷",
    "antagonist": "对手/阻力：身份+与主角的冲突来源",
    "coreConflict": "核心冲突：一句话概括主角与谁的不可调和矛盾",
    "worldRules": ["世界观规则1", "世界观规则2"],
    "tone": "风格基调（冷峻/热血/温情/悬疑/黑暗/治愈）",
    "targetExperience": "目标读者体验（如追更爽感/沉浸解谜/情绪共鸣）"
  },
  "seedCharacters": [
    {"name":"人名", "identity":"身份", "age":"岁数", "gender":"性别", "appearance":"外貌", "hobby":"爱好", "relation":"关系", "trait":"性格"}
  ],
  "seedPlaces": [
    {"name":"地名", "type":"类型", "note":"设定要点"}
  ],
  "suggestedChapterCount": 30
}

【硬性约束】
1. 绝不删减、篡改用户明确表达的内容（题材/元素/风格）。
2. 不替用户新增核心设定（不凭空加角色/势力/金手指），只补全"可推导的通用细节"。
3. 输入极短（少于 15 字）时：navBeacon、seedCharacters、seedPlaces 按题材惯例生成通用骨架，并在 optimizedIdea 开头标注"（基于题材惯例的通用展开）"，defects 列出必须补充的内容。
4. seedCharacters 每个人物必须输出完整 7 字段：identity/age/gender/appearance/hobby/relation/trait，缺字段填"未知"。
5. 若用户构想含风格基调，navBeacon.tone 必须与之完全一致，并在 optimizedIdea 中给出 2-3 个落地方式。
6. defects 必须真实指出用户构想中可被后续 AI 利用的信息缺口，不得为空（至少 1 条）。
7. suggestedChapterCount 必须是 5-200 之间的整数。`;

// 4.7 Pro（3.1）优化构想 AI 新系统提示词：资深长篇策划编辑 + 故事诊断师，输出结构化故事简报（含缺陷清单）
const IDEA_POLISH_SYS_PRO = `你是一位资深长篇小说策划编辑，同时担任「故事诊断师」。
【核心任务】把用户输入的粗糙故事构想，诊断并优化成一份可直接交付给大纲 AI 的「结构化故事简报」。

【处理流程】
1. 先诊断：识别构想中是否缺失下列关键要素，缺失几项就列出几项（不要硬造内容）。
2. 再优化：在保留用户原意的前提下，把构想补全为结构化简报。

【必须输出的 JSON 结构】
{
  "diagnosis": {
    "missing": ["缺失要素1", "缺失要素2"],  // 从下面 8 项中勾选：题材定位、主角、核心冲突、世界观/规则、核心对手/压力、主角动机、风格基调、目标读者体验
    "questions": ["为了补全题材定位，请回答：故事发生在什么时代/世界？", "..."]  // 每个缺失项对应一个引导问题
  },
  "brief": {
    "genre": "题材定位（如：都市悬疑 / 古风权谋 / 末世生存）",
    "protagonist": "主角身份 + 核心困境（≤40字）",
    "coreConflict": "核心冲突：谁想要什么？阻碍是什么？代价是什么？（≤80字）",
    "worldOrRules": "世界观或核心规则（没有就写"无"，绝不硬造）",
    "antagonistOrPressure": "对手/压力源（没有就写"无"）",
    "motivation": "主角行动的内在动机",
    "style": "风格基调 + 2-3 个落地方式",
    "readerExperience": "目标读者读完后的情绪/体验"
  },
  "advice": "给用户的下一步建议（≤60字）"
}

【硬性约束】
1. diagnosis.missing 只能从 8 个枚举值中选取：题材定位、主角、核心冲突、世界观/规则、核心对手/压力、主角动机、风格基调、目标读者体验。禁止自创缺失项名称。
2. 绝不删减、篡改用户明确表达的内容；只能在原意上细化。
3. 不替用户新增故事设定（不凭空加角色/势力/冲突/金手指）。补全仅限两类：a) 直接由用户原文逻辑推导的细节；b) 题材通用、无设定含义的填充。所有新增推断内容须在句末标注"（推断）"。用户原文中的专有名词（人名、地名、组织、物品、术语、独特说法）必须在 brief 对应字段中原样保留，禁止同义替换、改名或重新包装。
4. brief.worldOrRules / antagonistOrPressure 若用户未提及，必须写"无"，禁止硬造。
5. 极短输入（<15 字）时：diagnosis.missing 全部勾选；brief 仅填写能从原文直接推导的字段，其余一律写"无"并全部列入 diagnosis.questions 逐项提问；advice 引导用户补充，禁止用题材模板代填设定。
6. 只输出上述 JSON，不要 markdown 代码块、不要解释文字。
7. 输出前自检：把用户原文逐句列出要点，逐一核对 brief；任何用户明确表达的设定若未出现或被改写，必须修正后再输出。

【输出示例】
{
  "diagnosis": {"missing":["世界观/规则"], "questions":["这个世界的运行规则或特殊设定是什么？"] },
  "brief": {
    "genre": "都市悬疑",
    "protagonist": "落魄前刑警因女儿失踪案被迫重出江湖",
    "coreConflict": "他必须在 72 小时内找到女儿，而绑匪似乎来自他已故搭档的过去",
    "worldOrRules": "无",
    "antagonistOrPressure": "绑匪 + 警局内部阻力",
    "motivation": "救女儿、赎罪",
    "style": "冷峻克制，短句为主，克制抒情，用细节替代解释",
    "readerExperience": "紧张、揪心、结尾反转后的沉重"
  },
  "advice": "建议补充世界观：是普通当代都市，还是有特殊社会背景？"
}`;

// 4.7 Pro（第7章指令2）：新常量用旧名——所有既有引用点（polishIdea 等）自动升级为 PRO 提示词
const IDEA_POLISH_SYS = IDEA_POLISH_SYS_PRO;

// v10.13 优化构想·输出模式后缀：单稿（4.5：与多方案同一 JSON 契约，仅不带 options 包装）
const POLISH_SINGLE_MODE = `\n\n【本次输出模式：单稿】严格只输出一个完整 JSON（与【输出格式】完全一致，不要解释、不要 markdown 代码块）。`;

// v1.0.121 优化构想·输出模式后缀：多方案（JSON 载体，2-6 个方向方案，无编辑意见）
const POLISH_MULTI_MODE = `\n\n【本次输出模式：多方案】严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"options":[{"name":"方案A 稳健向","optimizedIdea":"...","defects":["..."],"navBeacon":{...},"seedCharacters":[...],"seedPlaces":[...],"suggestedChapterCount":30}]}
要求：输出 2-6 个方案；每个方案都是完整 JSON；seedCharacters/seedPlaces 仅整理用户构想中已明确提及的人物/地点（原样沿用其名字与设定），用户未提及的一律输出空数组 []，禁止新增任何人物或地名；方案差异只允许在走向/补全，必须逐条保留用户原意；navBeacon 的 genre/coreConflict/tone 既要方案间一致，也必须与用户构想一致。`;

// v8c 词典增量补全：从已生成章节正文中提取「现有词典未收录」的新人物/新地名/新专名，去重后并入词典。
// 供批量生成章节后的自动补全与词典卡片的「📥 提取新增」共用；人物字段对齐词典契约（age/gender 必填）。
// v1.0.112 词典提取提示词：从正文提取新实体；7 字段强制 + 自洽审查；与现有词典逐名去重。
// 4.7 Pro（3.8/第7章指令2）：旧常量改名 GLOSSARY_EXTRACT_SYS_LEGACY 保留回退，新常量用旧名指向 GLOSSARY_EXTRACT_SYS_PRO。
const GLOSSARY_EXTRACT_SYS_LEGACY = `你是长篇小说设定整理助手。给定【本章正文】与【现有词典】，提取正文中出现但现有词典【未收录】的新人物、新地名、新专名。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"characters":[{"name":"人名","identity":"身份/职业/社会身份","age":"岁数/年龄","gender":"性别","appearance":"外貌特征","hobby":"爱好/习惯","relation":"与该人的血缘/人际关联","trait":"性格要点"}],"places":[{"name":"地名","type":"类型","note":"设定要点"}],"propernouns":[{"name":"专名","note":"含义"}]}
规则：
1. 只提取正文中真实出现、且有明确所指（被命名）的实体；纯叙述性泛指不提取。
2. 必须与现有词典逐名去重：同名条目一律不再输出。
3. ★【人物必须输出全部 7 个字段：identity / age / gender / appearance / hobby / relation / trait】
   · 禁止只输出人名、禁止缺字段、禁止省略任何字段；
   · 从正文中提取该人物的身份、年龄、性别、外貌、爱好、关系、性格等信息，正文未明说的字段按上下文合理推断后填写；
   · 实在无法推断的字段填「未知」，不得留空、不得删除该字段；
   · relation 与 identity 务必区分：身份词（捕快/市长/船女）归 identity；带"谁的"的人际关联（XX的妹妹/她的仆人）归 relation。
   · ★推断须自洽：填写的 age 与履历/居住年限类设定不得矛盾（如"在此已住30年"却23岁、"18岁却已当官5年"）；子代须小于亲代；转世/穿越/长生/修仙等特殊预设可豁免，但需有对应标注。
4. 无明显新实体时输出 {"characters":[],"places":[],"propernouns":[]}。`;

// 4.7 Pro（3.8 原码）：资深设定审计师
const GLOSSARY_EXTRACT_SYS_PRO = `你是一位资深长篇小说「设定审计师」。
【核心任务】给定本章正文与现有词典，提取正文中出现但现有词典未收录的新人物、新地名、新专名，并做字段自洽审查。

【必须输出的 JSON 结构】
{"characters":[{"name":"人名","identity":"身份/职业/社会身份","age":"岁数/年龄","gender":"性别","appearance":"外貌特征","hobby":"爱好/习惯","relation":"与该人的血缘/人际关联","trait":"性格要点"}],"places":[{"name":"地名","type":"类型","note":"设定要点"}],"propernouns":[{"name":"专名","note":"含义"}]}

【硬性约束】
1. 只提取正文中真实出现、且有明确所指（被命名）的实体；纯叙述性泛指不提取。
2. 与现有词典逐名去重：同名条目一律不再输出。
3. 人物必须输出全部 7 个字段：identity / age / gender / appearance / hobby / relation / trait；禁止缺字段、留空；无法推断的字段填「未知」。
4. relation 与 identity 区分：身份词（捕快/市长/船女）归 identity；带"谁的"的人际关联归 relation。
5. 字段自洽：age 与履历/居住年限不得矛盾；子代须小于亲代；特殊预设（转世/穿越/长生/修仙）可豁免但需标注。
6. 无明显新实体时输出 {"characters":[], "places":[], "propernouns":[]}。
7. 只输出上述 JSON，不要 markdown 代码块、不要解释。`;

// 4.7 Pro（第7章指令2）：新常量用旧名，引用点零改动自动升级
const GLOSSARY_EXTRACT_SYS = GLOSSARY_EXTRACT_SYS_PRO;

// 4.7 Pro（3.8 原码）：词典提取输出校验（不阻断，仅告警）
function validateGlossaryExtract(j){
  if(!j) return {ok:false, code:'EMPTY'};
  for(const c of (j.characters || [])){
    const missing = ['name','identity','age','gender','appearance','hobby','relation','trait'].filter(k => !String(c[k]||'').trim());
    if(missing.length) return {ok:false, code:'CHAR_FIELD_MISSING', details: c.name};
    const nameViol = nmNameRuleViolation(String(c.name||'').trim());
    if(nameViol) return {ok:false, code:'CHAR_NAME_RULE', details: nameViol};
  }
  return {ok:true};
}

// v1.0.113 副线追踪提示词：读「本章正文 + 现有副线进度 + 主线简述」，判断推进/新建/收束哪些副线。
// 事后轻量调用（不在正文内嵌 JSON）；仅本章确有进展才输出该副线；question 首次强制采集。
// 4.7 Pro（3.7/第7章指令2）：旧常量改名 SUBPROGRESS_UPDATE_SYS_LEGACY 保留回退，新常量用旧名指向 SUBPROGRESS_UPDATE_SYS_PRO。
const SUBPROGRESS_UPDATE_SYS_LEGACY = `你是长篇小说副线追踪助手。给定【本章正文】与【现有副线进度】，判断本章推进、新建或收束了哪些副线。
请严格只输出如下 JSON（不要解释、不要 markdown 代码块）：
{"subplots":[{"name":"副线名","status":"进行中|搁置|已收束","question":"该副线提出的核心问题","arc":{"from":"起点状态","to":"当前状态"},"pivot":"对主线的影响(有才填，没有就别写)","note":"本章进展一句话，只写本章新增，不重复旧进度，≤60字"}]}
规则：
1. 只输出本章【确有推进或新建】的副线；本章未触碰的一律不出现。
2. 已存在副线按 name 同名合并；仅当本章确实引出一条新的跨章叙事线索（有延续悬念、将多次出现）才允许新建，一次性事件/路人戏不建。
3. status 只能是三态之一：进行中 / 搁置 / 已收束，禁止其它值。
4. 首次新建某副线时尽量给出 question（该线索提出的核心问题）与 arc.from；一时给不出也要输出该副线，question 留空字符串（程序会标记"待补充"），禁止为凑数硬编问题。
5. 推进时若人物状态发生跃迁，更新 arc.to；若本章该副线与主线交织并影响主线，补 pivot（确有关联才填，绝不硬造）。
6. 当该副线的核心问题已被回答（哪怕开放式结局，如没抓到凶手但回答了追查动机）→ status 改「已收束」，note 说明它以何种方式完成闭合（回应问题 / 状态到位）。
7. 已收束的副线本章又明显复活推进 → 显式改回「进行中」再追加。
8. 与既有进度冲突时以既有进度为准，不得改写或推翻旧进度；note 只记录本章新增内容。
9. 本章无任何副线推进时输出 {"subplots":[]}。`;

// 4.7 Pro（3.7 原码）：资深副线审计师
const SUBPROGRESS_UPDATE_SYS_PRO = `你是一位资深长篇小说「副线审计师」。
【核心任务】阅读本章正文，判断本章推进、新建或收束了哪些副线；同时审计本章**新埋设的伏笔**与**回收的旧伏笔**，并以严格的 JSON 输出。

【必须输出的 JSON 结构】
{"subplots":[{"name":"副线名","status":"进行中|搁置|已收束","question":"该副线提出的核心问题（必填，≤60字）","arc":{"from":"起点状态","to":"当前状态"},"pivot":"对主线的影响（有才填，没有就空字符串）","note":"本章进展一句话，只写本章新增，≤60字"}],"foreshadowing":{"planted":[{"text":"伏笔文本（≤40字）","expectedCh":"预计兑现章号（数字）"}],"resolved":["已回收的旧伏笔文本"]}}

【硬性约束】
1. 只输出本章确有推进或新建的副线；未触碰的一律不出现。
2. status 只能是：进行中 / 搁置 / 已收束。其他值视为无效。
3. 首次新建某副线时尽量给出 question；给不出时输出空字符串并保留该副线，禁止硬编问题。
4. arc.from / arc.to 必须能体现状态跃迁；没有变化时两者可相同。
5. pivot 只在确实影响主线时才填；没有就空字符串，禁止硬造。
6. 与既有进度冲突时以既有进度为准，不得改写旧进度。
7. 伏笔 planted 只收录本章**首次埋设**、且明显指向未来章节的线索（道具、异常对话、未解事件、人物背景暗示等）；一次性交代或本章即解释的信息不要收录。
8. resolved 只收录本章**明确回收/解答**的旧伏笔文本；未明确回收的不要硬填。
9. 本章无任何副线推进且无任何新伏笔/回收时输出 {"subplots":[],"foreshadowing":{"planted":[],"resolved":[]}}。
10. 只输出 JSON，不要 markdown 代码块、不要解释。`;

// 4.7 Pro（第7章指令2）：新常量用旧名，引用点零改动自动升级
const SUBPROGRESS_UPDATE_SYS = SUBPROGRESS_UPDATE_SYS_PRO;

// 4.7 Pro（3.7 原码）：副线输出校验（不阻断，仅告警）
function validateSubplotOutput(j){
  if(!j || !Array.isArray(j.subplots)) return {ok:false, code:'NOT_ARRAY'};
  for(const s of j.subplots){
    if(!['进行中','搁置','已收束'].includes(s.status)) return {ok:false, code:'BAD_STATUS'};
    if(!String(s.name||'').trim()) return {ok:false, code:'MISSING_NAME'};
    if(!String(s.question||'').trim()) return {ok:false, code:'MISSING_QUESTION'};
  }
  return {ok:true};
}

// 4.8 旗舰版（板块三-5）：多分支情节沙盘推演。对分歧点推演各分支后果。
const SANDBOX_BRANCH_SYS = `你是一位长篇小说「情节沙盘推演师」。
【核心任务】给定当前分歧点与各分支选项，分别推演每个分支继续 3 章后的连锁后果。

【必须输出的 JSON 结构】
{"branches":[{"id":"分支标识","summary":"3 章后状态概述（≤80字）","risks":["代价1","代价2"],"payoffs":["收益1","收益2"],"consistency":8}]}

【评分标准】
- consistency：0-10 整数，分支与已有人设、伏笔、全书主线的自洽程度；越高越优。
- risks：该分支必然引发的代价或隐患（至少 1 条）。
- payoffs：该分支带来的剧情收益或高潮铺垫（至少 1 条）。

【硬性约束】
1. 只输出 JSON，不要 markdown 代码块、不要解释。
2. 禁止引入设定词典之外的新人物/地名/专名。
3. 推演必须尊重已发生剧情，不得推翻前文。`;

// 4.8 旗舰版（板块三-4）：文学风格指纹提取。从作家范文提取量化风格 DNA。
const STYLE_FINGERPRINT_SYS = `你是一位文学风格指纹提取师。
【核心任务】阅读给定范文文本，提取其量化风格指纹，输出严格 JSON。

【必须输出的 JSON 结构】
{"sentenceAvg":22,"dialogueRatio":0.35,"lexicon":["高频词1","高频词2","高频词3"],"punctuation":{"dash":0.02,"ellipsis":0.03},"rhetoricDensity":0.15,"rhythmNote":"短句密集/长句舒缓/排比铺陈等","exemplars":["金句1（≤60字）","金句2","金句3"]}

【字段说明】
- sentenceAvg：平均句长（中文字/句）。
- dialogueRatio：对话字数占全文比例（0-1）。
- lexicon：3-8 个高频或标志性词汇（优先提取该作者常用词、独特动词/形容词）。
- punctuation.dash / ellipsis：破折号 / 省略号出现频率（占全文标点比例）。
- rhetoricDensity：修辞密度（比喻、排比、对偶等修辞句占全句比例，0-1）。
- rhythmNote：一句话节奏特征说明。
- exemplars：3 句最能代表该作者笔锋的金句摘录（必须来自原文，≤60字/句）。

【硬性约束】
1. 只输出 JSON，不要 markdown 代码块、不要解释。
2. exemplars 必须真实来自输入文本，禁止编造。`;

// 4.8 旗舰版（板块三-3）：情节冲突强度实时评估。按外在/内心/信息差三维度打分。
const TENSION_SCORE_SYS = `你是一位长篇小说「张力评估师」。
【核心任务】阅读本章正文，从三个维度评估本章冲突强度，输出量化分数。

【必须输出的 JSON 结构】
{"external":0,"internal":0,"mystery":0,"delta_vs_prev":0}

【评分标准】
- external（外在冲突）：人物与外部阻力/对手/环境的对抗强度，0-10。
- internal（内心冲突）：人物内心挣扎、信念冲突、情感撕裂强度，0-10。
- mystery（信息差）：悬念、未知、信息不对称引发的紧张感，0-10。
- delta_vs_prev：与上一章相比本章张力变化（-10 到 +10，正数表示提升）。

【硬性约束】
1. 只输出上述 JSON 对象（external/internal/mystery/delta_vs_prev 四个数字字段），不要解释、不要 markdown 代码块、不要输出裸数字。
2. 分数必须为 0-10 整数（delta_vs_prev 为 -10 到 +10 整数）。`;

// 4.8 旗舰版（板块三-2）：人设一致性防火墙。对照人物卡逐条核对本章正文，找出年龄/外貌/性格/口癖等矛盾。
const PERSONA_DRIFT_SYS = `你是一位资深长篇小说「人设审计师」。
【核心任务】对照给定的人物卡（含 identity/age/gender/appearance/hobby/relation/trait），逐条检查本章正文中是否出现与该人物卡矛盾或漂移的描写。

【必须输出的 JSON 结构】
{"violations":[{"name":"人物名","field":"age|gender|appearance|hobby|relation|trait|口癖","evidence":"本章正文中矛盾的原文片段（≤60字）","expected":"人物卡中的正确信息"}]}

【硬性约束】
1. 只输出确实存在矛盾的条目；没有矛盾时输出 {"violations":[]}。
2. 证据必须引用本章正文原句或短语，禁止虚构。
3. age 矛盾包括：明确写出与人物卡年龄不符的数字、履历年限与年龄冲突、子代年龄大于等于亲代等。
4. appearance 矛盾包括：发色/瞳色/体型/显著特征与人物卡不一致。
5. trait/口癖 矛盾包括：人物表现出与其性格标签明显冲突的行为或说话方式（至少出现 2 次才记录）。
6. 只输出 JSON，不要 markdown 代码块、不要解释。`;

// v225/P5-C：TITLE_FINALIZE_SYS（正文回填标题提示词）已随 finalizeChapterTitle 一并移除。

/** 未选结构时的「章节安排」提示：仅要求 AI 输出 structure.chapterPlan，把全部章节按主题/起承转合自由分组、一章不落；
 *  不强制主线/副线/暗线（未选结构时用户本就不要求结构骨架）。集中定义为独立常量，便于以后调整分组口径。 */
const CHAPTER_PLAN_FREE_SYS = `\n\n【章节安排（未选结构时）】请在返回 JSON 的 "structure" 字段中补一个 "chapterPlan"：
"structure":{"chapterPlan":{  // 维度名 → 章标题列表；全书每一章都归入某个维度，一章不落、最后一章也要归组
  "维度名1":["章标题","章标题"],
  "维度名2":["章标题"]
}}
维度名由你按故事内容自由拟定（例如按主题、按起承转合、按人物视角、按事件板块），不必套用任何固定范式；每章都归入某维度、一章不落即可。`;

/** 统一「结构任务块 · 主线条 · 兜底」：仅当用户【未选中任何结构范式】时才推。
 *  S1 之后，选中结构时主线条四格已内联进各 st.outlineSys（见 MAIN_LINE_BLOCK），故此处不再重复推送、避免同一 structure 被两处描述；
 *  仅未选结构时作为轻量主线条骨架要求，让 AI 产出 mainLine/subLines/hiddenLine/pivotPlan（主线必有、副暗汇合有则带、无则空，绝不硬造）。 */
const STRUCTURE_MAIN_SYS = `\n\n【长篇结构设计 · 主线条（未选结构范式时，请一并输出，作为轻量结构骨架）】
请在返回 JSON 顶层的 "structure" 字段中，按下面契约输出一份基础情节骨架：
"structure":{
  "mainLine":"全书唯一主线/核心走向（必有：这本到底讲什么）",
  "subLines":["副线1：内容","副线2：内容"],  // 有则带；若故事确实没有副线就空数组或省略，绝不硬造
  "hiddenLine":"暗线内容（如何埋设、何时揭晓）",  // 有则带；若没有暗线就空字符串或省略，绝不硬造
  "pivotPlan":"汇合/大逆转所在章（点式，如 第20章三方对峙）"  // 有则带；无则该字段省略
}
请完成：① 定全书唯一主线/走向（必填：这本到底讲什么）→ ② 若故事确有副线/暗线/汇合才补，没有就空着、别硬造。
绝不为了"凑三线"而编造不存在的副线暗线；汇合只在确实有多条线交织时才点出。`;

/** 统一「结构任务块 · 章节计划」：仅【无结构专属章节映射】的范式（网状多线 mesh / 单线因果 causal）才输出。
 *  英雄之旅→stageChapters、节拍表→beats、七点→points、分层→volumes 由各自专属字段承载章节映射，故不在此重复要求。 */
const STRUCTURE_PLAN_SYS = `\n\n【长篇结构设计 · 章节计划（仅网状多线 / 单线因果等"无专属章节映射"的结构才一并输出）】
如果所选范式没有自带"阶段 / 节拍 / 锚点 / 卷"式的章节映射字段，请在上述 JSON 的 "structure" 中补一个 "chapterPlan" 字段：
"structure":{
  "chapterPlan":{  // ★必有：维度名 → 章标题列表；书中每一章都要被归入某个维度，一章不落、最后一章也要归组
    "维度名1":["章标题","章标题"],
    "维度名2":["章标题"]
  }
}
维度名按所选范式叫法（网状多线用各线索名、单线因果用各关卡名），反映的都是"章节→维度"的分组，每一章都归入某维度、一章不落。`;



// 4.7 Pro（3.2）大纲 Sys 组装改造：PRO 提示词 + 防套路 + 简介字数约束与 chapterPlan 覆盖（N 未填按默认 30 章）
function buildOutlineSys(){
  const parts = [];
  parts.push(OUTLINE_GEN_SYS_PRO);          // 新书目+简介+结构
  parts.push('\n\n'+ORIGINALITY_OUTLINE_SYS);
  const lr = state.loglineRange;
  const _m = Number.isFinite(lr&&lr.min)?Math.max(1,Math.floor(lr.min)):300;
  const _x = Number.isFinite(lr&&lr.max)?Math.min(5000,Math.max(1,Math.floor(lr.max))):700;
  const _lo = Math.min(_m,_x), _hi = Math.max(_m,_x);
  const N = chapterCountVal() || 30;        // 若未填，按默认 30 章
  parts.push(`\n\n【简介字数约束】本作小说简介总字数必须控制在 ${_lo}—${_hi} 字之间，严格遵守区间，不得超出。当前全书预设 ${N} 章，chapterPlan 必须覆盖全部 ${N} 章，数量严格一致。`);
  const banNote = banListBlockFor('outline');
  if(banNote) parts.push(banNote);
  return parts.join('\n\n');
}
// 遵从度 → 喂给 AI 的要求（v8：与 adherenceHint 的语义一一对应，供模型判断遵循程度）
function adherenceSys(a, allowFill){
  if(a>=100) return '遵从度为 100%（铁律）：词典中已有的人名/地名/专名必须逐字沿用，禁止改拼写或另造别名，仅允许按本作大纲新增角色。';
  if(a>=80)  return `遵从度为 ${a}%（基准）：尽量沿用既有命名，允许个别因新情节做小幅调整。`;
  if(a>=60)  return `遵从度为 ${a}%（主要参照）：核心人物保留原名，地名/专名可按新剧情调整。`;
  if(a>=30)  return `遵从度为 ${a}%（灵感来源）：可适度大改命名，仅保留题材与语感。`;
  return `遵从度为 ${a}%（几乎放弃）：仅作背景语感参考，允许完全重新构建设定${allowFill?'，可自由创新命名。':''}`;
}
// v8 阶段3：大纲提示词词典块（双轨关键）。有 pendingGlossary 时生成「权威复用词典块」，
// 把导入词典作为一致性底稿回填给模型；无导入时返回默认 GLOSSARY_SYS，主轨完全不受影响。
function outlineGlossaryInject(g){
  if(!g || !sourceHasGlossary(g)) return GLOSSARY_SYS;
  const cs=(g.characters||[]).map(c=>{
    const head=[c.identity||'',(c.age?`${c.age}岁`:''),c.gender||''].filter(Boolean).join('·');
    const tail=[c.appearance?`外貌:${c.appearance}`:'',c.hobby?`爱好:${c.hobby}`:'',c.relation?`关系:${c.relation}`:'',c.trait?`性格:${c.trait}`:''].filter(Boolean).join('｜');
    return `${c.name}${(head||tail)?`（${head}${tail?'｜'+tail:''}）`:''}`;
  }).join('； ');
  const ps=(g.places||[]).map(p=>`${p.name}${p.type?`（${p.type}）`:''}${p.note?`｜${p.note}`:''}`).join('； ');
  const pn=(g.propernouns||[]).map(p=>`${p.name}${p.note?`（${p.note}）`:''}`).join('； ');
  const fill = state.glossAllowFill ? '\n允许并鼓励你在不在底稿中的新设定上自由新增人物/地名/专名。' : '\n除非必要，避免无谓地新增与底稿无关的实体。';
  return `\n\n【复用词典 · 权威一致性底稿（v8）】以下是既有的权威词典，请在返回 JSON 顶层照常追加 glossary 字段，并以本底稿为主集：${adherenceSys(state.glossAdherence, state.glossAllowFill)}
"glossary":{"characters":[{"name":"人物姓名","identity":"身份/职业/社会身份","age":"岁数/年龄","gender":"性别","appearance":"外貌特征","hobby":"爱好/习惯","relation":"与该人的血缘/人际关联（妹妹/姐姐/朋友/仆人等）","trait":"性格要点"}],"places":[{"name":"地名","type":"类型","note":"设定"}],"propernouns":[{"name":"专名","note":"含义"}]}
人物：${cs||'（无）'}
地点：${ps||'（无）'}
专名：${pn||'（无）'}
底稿中已有人名/地名/专名一律沿用，不得推倒重造一套；只按本作大纲补充新增条目，新增条目 schema 与该类别保持一致。新增/沿用人物均须区分 relation（血缘/人际关联，带"谁的"，如「林晚的妹妹」「她的仆人」）与 identity（职业/社会身份，可独立成句，如「捕快」「市长」），禁止把身份词写进 relation。${fill}`;
}
// v8 阶段3：本体词典块（章节正文共同复用）。取合并后的大纲词典，生成「严格服从」一致性基准。
// v8b（建议1）：正文也全量带词典详情（人物关系/身份/外貌/爱好/性格、地点类型/说明、专名含义），
// 不再做瘦身上限——详情对提高重生成的上下文一致性收益大于其微小 token 开销（约 +300~500 token/章）。


// 追加·传给 AI 的词典：完整保留原始内容（不删重复、不合并、不改结构），仅做「分类 + 排序 + 重复检测标注」。
// 1) 三类各自保留 ALL 条目（含重复名称），不删除任何文字与人名——重复情况只「检测并标注」，供 AI 知悉而非删改；
// 2) 每类按名称中文排序，条理化、易扫读（排序不改变数据本身）；
// 3) 检测同类内重名与跨类同名，返回 repeat 报告（仅提示，不动数据）。
// 仅作用于生成上下文，绝不改动 state 里的原始词典。
function glossaryForAI(){
  const g = (state.outline && state.outline.glossary) || {};
  const nrm = s => String(s||'').trim();
  const sortByName = arr => (arr||[]).slice().sort((a,b)=>String(a&&a.name||'').localeCompare(String(b&&b.name||''),'zh-Hans-CN'));
  const characters = sortByName(g.characters);
  const places     = sortByName(g.places);
  const propernouns= sortByName(g.propernouns);
  // 同类内重名检测（仅统计，不删）：返回 [{name, count}]
  const repeatIn = arr => {
    const m = {};
    arr.forEach(it=>{ const n = nrm(it.name); if(n) m[n] = (m[n]||0)+1; });
    return Object.keys(m).filter(n=>m[n]>1).map(n=>({name:n, count:m[n]})).sort((a,b)=>b.count-a.count);
  };
  // 跨类同名检测：同一名称出现在多类，提示 AI 视作同一实体而非重复
  const tag = {characters:'人物', places:'地点', propernouns:'专名'};
  const seen = {};
  [[characters,'characters'],[places,'places'],[propernouns,'propernouns']].forEach(([arr,cat])=>{
    arr.forEach(it=>{ const n = nrm(it.name); if(n) (seen[n]=seen[n]||[]).push(cat); });
  });
  const cross = Object.keys(seen).filter(n=>seen[n].length>1).map(n=>({name:n, cats:seen[n].map(c=>tag[c])}));
  return { characters, places, propernouns, repeatIn, cross, empty: sourceHasGlossary(g) ? '' : '（无）' };
}
// 词典「重复情况检查」只读提示，供用户在词典卡片直接看到是否有重复（仅提示，绝不动数据）
function glossaryDupNoteHtml(){
  const rf = glossaryForAI();
  const repLabels = {characters:'人物', places:'地点', propernouns:'专名'};
  const lines = [];
  [['characters',rf.characters],['places',rf.places],['propernouns',rf.propernouns]].forEach(([cat,arr])=>{
    const dup = rf.repeatIn(arr);
    if(dup.length) lines.push(`${repLabels[cat]}：「${dup.map(d=>`${d.name}×${d.count}`).join('」、')}」`);
  });
  if(rf.cross.length) lines.push('跨类同名：'+rf.cross.map(x=>`${x.name}（${x.cats.join('+')}）`).join('、'));
  if(!lines.length) return '';
  return `<div class="gs-panel gs-dup-note"><div class="gs-panel-title">⚠️ 重复情况检查（仅提示，未做任何删除/合并；原词典原样保留）</div>
    <pre class="gs-pre">${esc(lines.join('\n'))}</pre></div>`;
}

// 每次生成新章节时，向 AI 提供「全局创作上下文」：
// B) 【设定词典】——人物/地点/专名（完整保留、分类排序、同名仅提示不删）。仅当词典有条目时注入，避免空标签浪费 token。
function chapterGlossaryBlock(curN){
  const o = state.outline;
  if(!o) return '';
  // v10.61 章节正文不注入"长篇结构设计"卡片数据；结构走向由主线简述承接，词典单独注入。
  let body = `\n\n【全局创作上下文（严格服从，禁止自造新名）】`;
  const g = (o && o.glossary) || {};
  if(sourceHasGlossary(g)){
    const rf = glossaryForAI();
    const cDetail = c => [c.identity?`身份:${c.identity}`:'', c.age?`岁数:${c.age}`:'', c.gender?`性别:${c.gender}`:'', c.appearance?`外貌:${c.appearance}`:'', c.hobby?`爱好:${c.hobby}`:'', c.relation?`关系:${c.relation}`:'', c.trait?`性格:${c.trait}`:''].filter(Boolean).join('；');
    const pDetail = p => [p.type?`类型:${p.type}`:'', p.note?`说明:${p.note}`:''].filter(Boolean).join('；');
    const cs = rf.characters.map(c=> `${c.name}${cDetail(c)?`（${cDetail(c)}）`:''}`).join('、');
    const ps = rf.places.map(p=> `${p.name}${pDetail(p)?`（${pDetail(p)}）`:''}`).join('、');
    const pn = rf.propernouns.map(p=> `${p.name}${p.note?`（${p.note}）`:''}`).join('、');
    // 同类内重名：仅检测并标注提示 AI（条目本身原样全保留，不删除任何一例）
    const repLabels = {characters:'人物', places:'地点', propernouns:'专名'};
    const repeatNotes = [];
    [['characters',rf.characters],['places',rf.places],['propernouns',rf.propernouns]].forEach(([cat,arr])=>{
      const dup = rf.repeatIn(arr);
      if(dup.length) repeatNotes.push(`${repLabels[cat]}：${dup.map(d=>`「${d.name}」×${d.count}`).join('、')}`);
    });
    const repeatNote = repeatNotes.length ? `\n【词典同名提示（非删除，仅供知悉）】以下名称在同一类别中出现多次，均按原样保留：${repeatNotes.join('；')}` : '';
    // 追加·跨类同名提示：让 AI 识别「同一实体分属多类」，而非当作重复避免自造新名
    const crossNote = rf.cross.length ? `\n【跨类同名提示】以下名称在多类中出现（系同一实体分属多类，原样保留，不要当成两条新增，也不要据此另造新名）：${rf.cross.map(x=>`${x.name}（${x.cats.join('+')}）`).join('、')}` : '';
    body += `\n·【设定词典】（给定的人/地/专名，正文一律采用，人名/地名/专名不可自造新名，人物关系/性格、地点类型、专名含义按此保持统一）\n人物：${cs||'（无）'}\n地点：${ps||'（无）'}\n专名：${pn||'（无）'}${repeatNote}${crossNote}`;
  }
  body += subplotProgressBlock(curN);   // v1.0.113 副线进度块（无副线则返回空串，不占 token）
  return body;
}
// v1.0.113 副线进度注入块：仅当副线非空时生成「进度 + 创作契约」。
// 逐条计算消失跨度：gap = curN - _lastCh；lost = gap/全书章数。超过 subRecallRatio 时打「需 ≤20 字轻提」标记。
function subplotProgressBlock(curN){
  const o = state.outline; if(!o) return '';
  const g = (o.glossary) || {};
  const subs = (Array.isArray(g.subplots) ? g.subplots : []).filter(Boolean);
  if(!subs.length) return '';
  const full = (o.chapters||[]).length || 1;
  const cur = (Number.isFinite(curN) && curN>0) ? curN : (o.chapters||[]).length;   // 当前章：正文生成传 i+1；规划/标题无当前章则用全书章数
  const lines = subs.map(s=>{
    const nm = String(s.name||'').trim() || '（未命名副线）';
    const st = ['进行中','搁置','已收束'].includes(s.status) ? s.status : '进行中';
    const q = String(s.question||'').trim();
    const arc = (s.arc && (s.arc.from || s.arc.to))
      ? `${s.arc.from||'？'}→${s.arc.to||'——'}`
      : '';
    const pivot = String(s.pivot||'').trim();
    const lastCh = Number.isFinite(s._lastCh) ? s._lastCh : (s.log&&s.log.length ? Math.max(...s.log.map(x=>x.ch||0)) : 0);
    const ts = (Array.isArray(s.log)?s.log:[]).map(x=>`第${x.ch}章${x.note?`（${x.note.trim()}）`:''}`).join(' → ');
    let head = `· ${nm}（${st}）`;
    if(q) head += `｜问：${q}`;
    if(arc) head += `｜态：${arc}`;
    let block = `${head}\n  ${ts||'（尚无进度记录）'}`;
    const gap = lastCh ? (cur - lastCh) : -1;
    if(lastCh>0 && gap > full * state.subRecallRatio){
      block += `\n  ⚠ 本条已消失超全书 ${Math.round(state.subRecallRatio*100)}%（约 ${gap} 章未出现），读者可能淡忘：本章若回归，必须先用 ≤20 字一句话轻提前情，再续写。`;
    }
    if(pivot) block += `\n  蝴蝶效应：${pivot}`;
    return block;
  }).join('\n');
  return `\n\n【副线进度（截至第 ${cur} 章）】\n${lines}\n【副线创作契约】
· 是否推进某条副线由你判断：适合则自然写一笔；强行加入会生硬/喧宾夺主则本章不推进，正文照常。
· 回归一条消失过久的副线，开篇以 ≤20 字轻提前情，避免读者认知断裂。
· 闭环是硬性要求：副线可开放式结局（如没抓到凶手），但必须回应其【核心问题】；理想收束是完成状态 A→B 并给主线留出蝴蝶效应（见各条 pivot）。
· 未推进的副线不勉强提及；不得推翻既有进度；「已收束」的副线本章不复活（除非本章有重大理由并显式改回「进行中」）。`;
}
// v8 阶段4：覆盖面自检——对每条词典条目统计其在已生成章节正文的出现次数，返回 {used:[],unused:[]} 与全局命中率。
function checkGlossaryCoverage(){
  const g = (state.outline && state.outline.glossary) || {};
  const body = state.chapters.filter(c=>c && c.content).map(c=>String(c.content)).join('\n');
  const summary = { total:0, hit:0, chars:{used:[],unused:[]}, places:{used:[],unused:[]}, props:{used:[],unused:[]} };
  const scan = (arr, bucket)=>{
    (arr||[]).forEach(it=>{
      const nm = String(it.name||'').trim(); if(!nm) return;
      summary.total++;
      const re = new RegExp(escRe(nm), 'g');
      const n = body.match(re) ? body.match(re).length : 0;
      (n>0 ? bucket.used : bucket.unused).push({name:nm, count:n});
      if(n>0) summary.hit++;
    });
  };
  scan(g.characters, summary.chars);
  scan(g.places, summary.places);
  scan(g.propernouns, summary.props);
  return summary;
}
// v2.4 人物字段契约（与大纲词典 GLOSSARY_SYS 完全一致：name + 7 字段）；词典卡字段检查共用
const CHAR_FIELDS = ['identity','age','gender','appearance','hobby','relation','trait'];
const CHAR_FIELD_LABEL = { identity:'身份', age:'岁数', gender:'性别', appearance:'外貌', hobby:'爱好', relation:'关系', trait:'性格' };
// v2.4 提取结果补全：空字段一律填「未知」，保证新人物 7 字段齐全再入库（禁止"只有名字的新人物"）
function completeCharFields(c){
  CHAR_FIELDS.forEach(k=>{ if(c[k]==null || String(c[k]).trim()==='') c[k] = '未知'; });
  return c;
}
// v225/P2：提取结果字段白名单过滤（原 extractNewGlossary 内联逻辑抽出共用，供全量兜底链与逐章提取通道共用）
function sanitizeGlossaryExtract(j){
  j = j || {};
  const keepChar = c => {
    if(c.name == null || !String(c.name).trim()) return null;
    const o = { name: String(c.name).trim() };
    CHAR_FIELDS.forEach(k=>{ if(c[k]!=null) o[k] = String(c[k]).trim(); });
    return completeCharFields(o);   // v2.4 缺字段补「未知」，保证 7 字段齐全
  };
  const keepPlace = p => { const o = {}; ['name','type','note'].forEach(k=>{ if(p[k]!=null) o[k]=String(p[k]).trim(); }); return o.name ? o : null; };
  const keepProp = p => { const o = {}; ['name','note'].forEach(k=>{ if(p[k]!=null) o[k]=String(p[k]).trim(); }); return o.name ? o : null; };
  return {
    characters: (Array.isArray(j.characters)?j.characters:[]).map(keepChar).filter(Boolean),
    places:     (Array.isArray(j.places)?j.places:[]).map(keepPlace).filter(Boolean),
    propernouns:(Array.isArray(j.propernouns)?j.propernouns:[]).map(keepProp).filter(Boolean)
  };
}
// v8c 词典增量补全——从已生成正文提取「未收录」新实体（人物/地名/专名），字段白名单过滤后返回
async function extractNewGlossary(bodyTexts){
  const g = (state.outline && state.outline.glossary) || {};
  // 4.5 P3 增量游标：超 50000 字的累积文本不再固定取前 50000 字（那会漏掉后期章节、50 章后提不出新人物），
  // 而是从上次处理位点继续滚动开窗；游标存 outline._v45.glossCursor（老数据无损）。
  const allText = (bodyTexts||[]).filter(Boolean).map(String).join('\n\n');
  const _o = state.outline;
  if(_o && !_o._v45) _o._v45 = {};
  const _LIMIT = 50000;
  let body;
  if(allText.length <= _LIMIT){
    body = allText;
    if(_o) _o._v45.glossCursor = allText.length;
  }else{
    let _cur = Math.min((_o && _o._v45.glossCursor) || 0, allText.length);
    if(allText.length - _cur < _LIMIT) _cur = allText.length - _LIMIT;   // 尾部不足一窗时对齐到末窗
    body = allText.slice(_cur, _cur + _LIMIT);
    if(_o) _o._v45.glossCursor = _cur + body.length;
  }
  if(!body.trim()) return {characters:[], places:[], propernouns:[]};
  // 4.8 旗舰版（P2）：user 统一经 buildAIPrompt('glossary') 从 AIBus 上下文组装（与旧内联拼装等价）
  const user = buildAIPrompt('glossary', { content: body });
  const txt = unwrapAIResult(await callDeepSeek(GLOSSARY_EXTRACT_SYS, user, {maxTokens: clampMaxTokens('json'), temperature: 0.25, topP: 0.5, taskKey:'glossary'}));   // 4.8 旗舰版（板块二-2）：契约类任务窄采样，提升 JSON 合规率
  const j = parseJson(txt) || {};
  // 4.7 Pro（3.8）：解析后校验（不阻断，仅告警；7 字段缺失由 keepChar + completeCharFields 兜底补齐）
  const _glRep = validateGlossaryExtract(j);
  if(!_glRep.ok) console.warn('[词典] 输出校验未通过（不阻断）：', _glRep.code, _glRep.details||'');
  return sanitizeGlossaryExtract(j);   // v225/P2：字段白名单过滤抽为共用函数（逐章提取通道同用）
}
// 把提取结果按 name 去重（同名以现有为准）并入词典；新增条目打 _auto 标记（供清理弹窗默认勾选）。返回 {c,p,k,total}
// v226/8.2 溯源：src 为正数=来源章节号（1 基），为字符串=非章节来源标签（'批量兜底'/'手动提取'/'规划师'）；写入 _srcCh/_srcHow/_srcTs 供「🆕 新增」面板展示来源章节与真实入库时间。
function mergeExtractedGlossary(ext, src){
  const o = state.outline; if(!o) return {c:0,p:0,k:0,total:0};
  if(!o.glossary) o.glossary = {characters:[], places:[], propernouns:[]};
  const gl = o.glossary;
  const n = {c:0, p:0, k:0, rejected:0};
  const mergeArr = (cur, add, tag, checkName) => {
    const have = new Set((cur||[]).map(x=>String(x&&x.name||'').trim()).filter(Boolean));
    (add||[]).forEach(it=>{
      const nm = String(it.name||'').trim(); if(!nm || have.has(nm)) return;
      if(checkName && nmNameRuleViolation(nm)){ n.rejected++; return; }
      cur.push({ ...it, _auto:true, _srcCh: (typeof src==='number'&&src>0)?src:0, _srcHow: typeof src==='string'?src:'', _srcTs: Date.now() }); have.add(nm); n[tag]++;
    });
  };
  mergeArr(gl.characters, ext.characters, 'c', true);
  mergeArr(gl.places, ext.places, 'p');
  mergeArr(gl.propernouns, ext.propernouns, 'k');
  n.total = n.c + n.p + n.k;
  return n;
}
// v11 规划师初期词典播种：把规划师返回的初始词典合并进权威词典。按 name 去重、同名以现有为准；
// 不打 _auto 标记（与正文自动增量区分，清理弹窗将按「原始条目」处理，便于保留种子）。返回实际新增条数。
function mergeSeedGlossary(seed){
  const o = state.outline; if(!o) return 0;
  if(!o.glossary) o.glossary = {characters:[], places:[], propernouns:[]};
  if(!seed || (!Array.isArray(seed.characters) && !Array.isArray(seed.places) && !Array.isArray(seed.propernouns))) return 0;
  const gl = o.glossary; let added = 0, rejected = 0;
  const mergeArr = (cur, arr, checkName) => {
    const have = new Set((cur||[]).map(x=>String(x&&x.name||'').trim()).filter(Boolean));
    (arr||[]).forEach(it=>{
      const nm = String(it&&it.name||'').trim(); if(!nm || have.has(nm)) return;
      if(checkName && nmNameRuleViolation(nm)){ rejected++; return; }
      cur.push(it); have.add(nm); added++;
    });
  };
  mergeArr(gl.characters, seed.characters, true);
  mergeArr(gl.places, seed.places);
  mergeArr(gl.propernouns, seed.propernouns);
  if(rejected) console.warn('规划师播种：已拦截 '+rejected+' 个违规人名（需百家姓+两字名、禁叠字）');
  return added;
}
// v11 规划师定稿标题应用：长度必须与当前章节数严格一致才应用，否则保留现有标题并提示防错位。
// 应用前把当前（步2参考/手动）标题整批入版本栈，保证初稿可一键回退。返回是否成功应用。
function bindPlannerTitles(newTitles){
  const o = state.outline; if(!o) return false;
  const n = (o.chapters||[]).length;
  if(!Array.isArray(newTitles) || newTitles.length !== n) return false;
  snapshotTitleBatch('规划师定稿前');
  const applied = setAllTitles(newTitles);
  if(applied > 0){
    state.plannerFinalized = true;   // v11：规划师定稿成功 → 正文任务行取消「沿用参考稿」提示
    persist();
  }
  return applied > 0;
}
// 批量生成章节后的自动补全入口：开关开 + 词典已建立才执行；失败静默不阻塞
async function autoExtractGlossary(){
  if(!isLong() || !state.glossAutoFill) return;
  startBgTask();
  try{
    if(!state.outline || !sourceHasGlossary(state.outline.glossary)) return;
    // v226/8.1：只认正式正文（c.content）；质检失败的 _draft 章不参与提取（失败章零入典）
    const written = state.chapters.filter(c=> c && c.content && String(c.content).trim()).map(c=> c.content);
    if(!written.length) return;
    const ext = await extractNewGlossary(written);
    const n = mergeExtractedGlossary(ext, '批量兜底');
    if(n.total > 0){ persist(); toast(`词典已补全：+${n.c} 人物（含完整设定）、+${n.p} 地名、+${n.k} 专名`); }
  }catch(e){ /* 静默失败，不阻塞章节生成 */ }
  finally{ endBgTask(); }
}
// v226/8.1 逐章提取（仅正式正文）：c.content 非空才提取；_draft（质检失败未转正）一律不入典——失败章零入典。
// 不走 extractNewGlossary 的 50000 字滚动游标（那是全量兜底链的机制，逐章提取绕开它，避免游标互踩）。
// 新实体复用既有 7 字段保障链：GLOSSARY_EXTRACT_SYS → sanitizeGlossaryExtract（含 completeCharFields）→ mergeExtractedGlossary（人名过 nmNameRuleViolation 规范闸、同名去重、打 _auto）。
async function extractGlossaryFromChapter(i){
  if(!isLong() || !state.glossAutoFill) return;
  const c = state.chapters[i];
  const body = String((c && c.content) || '').trim();
  if(!body || !state.outline || !sourceHasGlossary(state.outline.glossary)) return;
  startBgTask();
  try{
    const user = buildAIPrompt('glossary', { content: body.slice(0, 50000) });
    const txt = unwrapAIResult(await callDeepSeek(GLOSSARY_EXTRACT_SYS, user, {maxTokens: clampMaxTokens('json'), temperature: 0.25, topP: 0.5, taskKey:'glossary'}));
    const n = mergeExtractedGlossary(sanitizeGlossaryExtract(parseJson(txt) || {}), i+1);
    if(n.total > 0){ persist(); toast(`第 ${i+1} 章新增词典：+${n.c} 人物（7字段）/ +${n.p} 地名 / +${n.k} 专名`); }
  }catch(e){ /* 静默失败，不阻塞正文 */ }
  finally{ endBgTask(); }
}
// v1.0.113 副线追踪 —— 事后轻量提取：读「本章正文 + 现有副线进度 + 主线简述」，判定推进/新建/收束。
// 只喂单章正文，保证 note 能精确标章号、AI 能看全进度做判断；与词典提取(extractNewGlossary)完全同构。
const SUB_STATUSES = ['进行中','搁置','已收束'];
async function extractSubplotUpdates(chIdx, content){
  const o = state.outline;
  const g = (o && o.glossary) || {};
  const body = String(content||'').trim();
  if(!body) return {subplots:[]};
  // 4.8 旗舰版（P2）：user 统一经 buildAIPrompt('subplot') 从 AIBus 上下文组装（与旧内联拼装等价）
  const user = buildAIPrompt('subplot', { idx: chIdx });
  const txt = unwrapAIResult(await callDeepSeek(SUBPROGRESS_UPDATE_SYS, user, {maxTokens: clampMaxTokens('json'), temperature: 0.25, topP: 0.5, taskKey:'subplot'}));   // 4.8 旗舰版（板块二-2）：契约类任务窄采样
  const j = parseJson(txt) || {};
  // 4.7 Pro（3.7）：解析后校验（不阻断，仅告警）
  const _subRep = validateSubplotOutput(j);
  if(!_subRep.ok) console.warn('[副线] 输出校验未通过（不阻断）：', _subRep.code, _subRep.details||'');
  const norm = (Array.isArray(j.subplots)?j.subplots:[]).map(s=>{
    const name = String(s&&s.name||'').trim(); if(!name) return null;
    const note = String(s&&s.note||'').trim();
    const o2 = {
      name,
      status: SUB_STATUSES.includes(s.status) ? s.status : '进行中',
      question: String(s.question||'').trim(),
      arc: { from: String((s.arc&&s.arc.from)||'').trim(), to: String((s.arc&&s.arc.to)||'').trim() },
      pivot: String(s.pivot||'').trim(),
      note
    };
    return o2;
  }).filter(Boolean);
  // 4.8 旗舰版（板块三-1）：解析伏笔埋设/回收
  const fs = (j && j.foreshadowing && typeof j.foreshadowing === 'object') ? j.foreshadowing : {};
  const planted = (Array.isArray(fs.planted)?fs.planted:[]).map(p => ({
    text: String(p.text||'').trim(),
    expectedCh: Number.isFinite(+p.expectedCh) ? +p.expectedCh : null
  })).filter(p => p.text);
  const resolved = (Array.isArray(fs.resolved)?fs.resolved:[]).map(r => String(r||'').trim()).filter(Boolean);
  return { subplots: norm, foreshadowing: { planted, resolved } };
}
// 把提取结果并入副线进度。Q7：首次新建且无 question 的副线被拦在 merge 层之外（拒绝落库，防无法闭环的孤儿副线）。
// 返回 {total, newCount, noQuestionCount}。
function mergeSubplotUpdates(ext, chIdx){
  const o = state.outline; if(!o) return {total:0,newCount:0,noQuestionCount:0};
  if(!o.glossary) o.glossary = {characters:[], places:[], propernouns:[]};
  const gl = o.glossary;
  if(!Array.isArray(gl.subplots)) gl.subplots = [];
  const cur = gl.subplots;
  let total=0, newCount=0, noQuestionCount=0;
  (ext&&ext.subplots||[]).forEach(s=>{
    const name = String(s.name||'').trim(); if(!name) return;
    const exist = cur.find(x=> String(x.name||'').trim() === name);
    if(!exist){
      // v225/P2 放行（用户口径"禁止阻止"）：无核心问题不再拒收，question 先落"待补充"，后续章节推进时经下方 if(s.question) 更新链自动补填
      if(!String(s.question||'').trim()){ s.question = '待补充：该副线的核心问题尚未明确'; }
      const entry = {
        name,
        status: s.status || '进行中',
        question: String(s.question).trim(),
        arc: { from: s.arc&&s.arc.from?s.arc.from:'', to: s.arc&&s.arc.to?s.arc.to:'' },
        pivot: s.pivot||'',
        log: s.note ? [{ch: chIdx, note: s.note}] : [],
        _lastCh: s.note ? chIdx : 0,
        _auto: true
      };
      cur.push(entry); total++; newCount++;
      return;
    }
    // 已存在：推进（追加 note / 更新状态 / 元字段）
    exist.status = SUB_STATUSES.includes(s.status) ? s.status : exist.status;
    if(s.question) exist.question = String(s.question).trim();
    if(s.arc && (s.arc.from||s.arc.to)){ exist.arc = exist.arc || {from:'',to:''}; if(s.arc.from) exist.arc.from = String(s.arc.from).trim(); if(s.arc.to) exist.arc.to = String(s.arc.to).trim(); }
    if(s.pivot) exist.pivot = String(s.pivot).trim();
    if(s.note){
      if(!Array.isArray(exist.log)) exist.log = [];
      // v1.0.113 乱序生成防护：日志按章号有序插入，保证进度串始终按时间序
      const ch = chIdx; let lo=0, hi=exist.log.length;
      while(lo<hi){ const mid=(lo+hi)>>1; if((exist.log[mid].ch||0) <= ch) lo=mid+1; else hi=mid; }
      exist.log.splice(lo, 0, {ch: chIdx, note: String(s.note).trim()});
      exist._lastCh = Math.max(...exist.log.map(x=>x.ch||0));
    }
    total++;
  });
  return {total, newCount, noQuestionCount};
}
// 增量入口：遍历所有已生成章中【尚未吸收】的章节（乱序生成也不会漏），逐章提取→合并。
// 成功记录已吸收章号；失败静默不阻塞。
async function autoUpdateSubplots(){
  if(!isLong() || !state.subAutoFill) return;
  startBgTask();
  try{
    const o = state.outline; if(!o) return;
    if(!o.glossary) o.glossary = {characters:[], places:[], propernouns:[]};
    if(!Array.isArray(o.glossary.subplots)) o.glossary.subplots = [];
    const absorbed = Array.isArray(o.glossary._subAbsorbed) ? o.glossary._subAbsorbed : [];
    const todo = state.chapters.map((c,i)=> (c && c.content && String(c.content).trim()) ? i : -1)
      .filter(i=> i>=0 && !absorbed.includes(i)).sort((a,b)=>a-b);
    if(!todo.length) return;
    let noQ = 0, total = 0;
    try{
      for(const i of todo){
        const c = state.chapters[i];
        const ext = await extractSubplotUpdates(i, c.content);
        const n = mergeSubplotUpdates(ext, i+1);
        // 4.8 旗舰版（板块三-1）：同步更新伏笔生命周期账本
        if(ext.foreshadowing) updateForeshadowLedger(i, ext.foreshadowing);
        noQ += n.noQuestionCount; total += n.total;
        absorbed.push(i);
      }
      o.glossary._subAbsorbed = absorbed;
      if(total>0 || noQ>0) persist();
      if(noQ>0) toast(`副线追踪：${total} 条推进；${noQ} 条因缺核心问题未入库`);
      else if(total>0) toast(`副线追踪：${total} 条副线进度已更新`);
    }catch(e){ /* 静默失败，不阻塞章节生成 */ }
  }finally{ endBgTask(); }
}
// v225/P5-C：finalizeChapterTitle（正文 AI 回填定稿标题）已整体移除——标题只由「全书规划师」生成/定稿；
// 旧存档中的 _titleByAI/_titleFinalized 标记残留无害（无人再读）。
// 全部已生成正文中「零出现」的词典条目（可能因重生成覆盖而失效；复用 checkGlossaryCoverage 的统计）
function scanUnusedGlossary(){
  const s = checkGlossaryCoverage();
  const g = (state.outline && state.outline.glossary) || {};
  const withAuto = (unused, src) => (unused||[]).map(x => {
    const it = (src||[]).find(y=> String(y&&y.name||'').trim() === x.name);
    return { name: x.name, _auto: !!(it && it._auto) };
  });
  return {
    characters: withAuto(s.chars.unused, g.characters),
    places:     withAuto(s.places.unused, g.places),
    propernouns:withAuto(s.props.unused, g.propernouns)
  };
}
// 手动「📥 提取新增」：对全部已生成正文提取一次（补历史遗漏），与自动补全共用提取/合并逻辑
async function manualExtractGlossary(){
  const written = state.chapters.filter(c=> c && c.content && String(c.content).trim()).map(c=>c.content);
  if(!written.length){ toast('尚无已生成章节正文'); return; }
  toast('正在提取新增词典条目…');
  try{
    const ext = await extractNewGlossary(written);
    const n = mergeExtractedGlossary(ext, '手动提取');
    if(n.total > 0){ persist(); render(); toast(`词典已补全：+${n.c} 人物（含完整设定）、+${n.p} 地名、+${n.k} 专名`); }
    else toast('未发现词典未收录的新实体');
  }catch(e){ toast('提取失败：'+e.message); }
}
// v8c 清理弹窗：列出全部已生成正文「零出现」的条目，勾选后确认删除（防误删：自动补全条目默认勾选，原始条目不勾选）
function openCleanPanel(){
  const closePanel = ()=>{ const p=$('#cleanPanel'); if(p) p.remove(); };
  const s = scanUnusedGlossary();
  const written = state.chapters.filter(c=>c && c.content && String(c.content).trim()).length;
  const row = (arr, icon) => arr.length ? arr.map(x=>`
    <label class="gs-hit"><input type="checkbox" class="gs-clean-cb" data-name="${esc(x.name)}" ${x._auto?'checked':''} />
      <span>${esc(x.name)}</span>${x._auto?'<i class="gs-auto-tag">🆕 自动补全</i>':'<i class="gs-orig-tag">原始条目</i>'}</label>`).join('') : '';
  const empty = !s.characters.length && !s.places.length && !s.propernouns.length;
  const ov = document.createElement('div');
  ov.id='cleanPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🧹 清理未使用条目</b><button class="gs-x" data-clean-close>✕</button></div>
      <div class="gs-modal-sub">已生成 ${written} 章。以下条目在全部已生成正文中均未出现，可能因重生成覆盖而失效；尚未写的章节可能仍会用到，请谨慎勾选。</div>
      <div class="gs-body">
        ${empty ? '<p class="muted">✓ 没有需要清理的条目（全部词典条目都已在正文中出现）。</p>' : `
          ${s.characters.length?`<div class="gs-q">👤 人物</div>${row(s.characters,'👤')}`:''}
          ${s.places.length?`<div class="gs-q">🏞️ 地名</div>${row(s.places,'🏞️')}`:''}
          ${s.propernouns.length?`<div class="gs-q">📌 专名</div>${row(s.propernouns,'📌')}`:''}
        `}
      </div>
      ${empty
        ? `<div class="gs-modal-head" style="justify-content:flex-end;border:none"><button class="btn ghost" data-clean-close>关闭</button></div>`
        : `<div class="gs-modal-head" style="justify-content:flex-end;border:none"><button class="btn ghost" data-clean-close>取消</button><button class="btn primary" data-clean-do>确认删除勾选项</button></div>`}
    </div>`;
  document.body.appendChild(ov);
  $$('[data-clean-close]').forEach(b=> b.onclick = closePanel);
  const doBtn = $('[data-clean-do]');
  if(doBtn) doBtn.onclick = ()=>{
    const picked = $$('.gs-clean-cb:checked').map(cb=> cb.dataset.name);
    if(!picked.length){ toast('未勾选任何条目'); return; }
    const g = state.outline && state.outline.glossary; if(!g){ closePanel(); return; }
    let c=0,p=0,k=0;
    g.characters = (g.characters||[]).filter(x=>{ if(picked.includes(String(x&&x.name||'').trim())){ c++; return false; } return true; });
    g.places     = (g.places||[]).filter(x=>{ if(picked.includes(String(x&&x.name||'').trim())){ p++; return false; } return true; });
    g.propernouns= (g.propernouns||[]).filter(x=>{ if(picked.includes(String(x&&x.name||'').trim())){ k++; return false; } return true; });
    persist(); closePanel(); render();
    toast(`已清理：-${c} 人物、-${p} 地名、-${k} 专名`);
  };
}
// v8 阶段4：覆盖面自检弹窗（列每条条目的出现次数，标出 0 次者）
function openCoveragePanel(){
  closeCoveragePanel();
  const s = checkGlossaryCoverage();
  const row = (arr, icon)=> arr.length ? arr.map(x=>`<div class="cv-row ${x.count===0?'cv-zero':''}"><span class="cv-icon">${icon}</span><b>${esc(x.name)}</b><span class="cv-cnt">${x.count===0?'未用到':x.count+' 次'}</span></div>`).join('') : '';
  const pct = s.total ? Math.round(s.hit/s.total*100) : 0;
  const ov = document.createElement('div');
  ov.id='cvPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>📊 词典覆盖面自检</b><button class="gs-x" data-cv-close>✕</button></div>
      <div class="gs-body">
        <p class="muted" style="margin:0 0 8px">对已在正文中出现过的章节做统计；0 次的条目可能未被使用，可考虑精简。共 ${s.total} 条 · 已覆盖 ${s.hit} 条（${pct}%）</p>
        ${s.chars.used.length||s.chars.unused.length?`<div class="cv-sec">👤 人物</div>${row(s.chars.used.concat(s.chars.unused),'👤')}`:''}
        ${s.places.used.length||s.places.unused.length?`<div class="cv-sec">📍 地点</div>${row(s.places.used.concat(s.places.unused),'📍')}`:''}
        ${s.props.used.length||s.props.unused.length?`<div class="cv-sec">🔤 专名</div>${row(s.props.used.concat(s.props.unused),'🔤')}`:''}
      </div>
      <div class="gs-actions"><button class="btn" data-cv-close>关闭</button></div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelectorAll('[data-cv-close]').forEach(b=> b.onclick = ()=>{ closeCoveragePanel(); });
  ov.addEventListener('click', e=>{ if(e.target===ov) closeCoveragePanel(); });
}
function closeCoveragePanel(){ const p=$('#cvPanel'); if(p) p.remove(); }
// v1.0.113 副线收束看板：列出未收束且消失超全书 subRecallRatio 比例的副线，提示是否安排回归。
// 同时展示各副线核心问题是否已回答（status==已收束 且 question 存在 视为已合环）。
function openSubplotBoard(){
  const old = $('#subBoard'); if(old) old.remove();
  const g = (state.outline && state.outline.glossary) || {};
  const subs = (Array.isArray(g.subplots)?g.subplots:[]).filter(Boolean);
  if(!subs.length){ toast('暂无副线'); return; }
  const full = (state.outline&&state.outline.chapters||[]).length || 1;
  // v228/P1：cur = 最新已生成正文的章号（0 = 尚未写任何章），不再拿规划总章数冒充当前进度
  const cur = Math.max(0, ...(state.chapters||[]).map((c,i)=> (c && c.content && String(c.content).trim()) ? i+1 : 0));
  const ratio = Number.isFinite(state.subRecallRatio) ? state.subRecallRatio : 0.4;
  const rows = subs.map((s,i)=>{
    const nm = String(s.name||'').trim() || '（未命名）';
    const st = SUB_STATUSES.includes(s.status) ? s.status : '进行中';
    const closed = st==='已收束';
    const q = String(s.question||'').trim();
    const lastCh = Number.isFinite(s._lastCh) ? s._lastCh : (s.log&&s.log.length?Math.max(...s.log.map(x=>x.ch||0)):0);
    const gap = lastCh ? (cur-lastCh) : -1;
    const lost = lastCh>0 && gap > full*ratio;
    const statusTxt = closed ? (q ? '✅ 已收束（核心问题已回答）' : '🔒 已收束（未记录核心问题）') : (lost ? '⚠️ 未收束 · 已消失过久' : '🟢 进行中');
    const rowCls = closed ? 'sb-closed' : (lost ? 'sb-lost' : '');
    return `<div class="sb-row ${rowCls}">
      <div class="sb-head"><b>${esc(nm)}</b><span class="sb-status">${statusTxt}</span></div>
      <div class="sb-meta">${q?`问：${esc(q)}`:''}${lost?` · 距最新已生成章（第 ${cur} 章）已缺席 ${gap} 章（超全书 ${Math.round(ratio*100)}%）`:''}</div>
      <div class="sb-meta muted">${closed ? '已闭合，无需回归' : (lost ? '建议在后续章节安排一次回归并轻提前情' : '尚未收束，可继续自然推进')}</div>
    </div>`;
  }).join('');
  const ov = document.createElement('div');
  ov.id='subBoard'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🧵 副线收束看板</b><button class="gs-x" data-sb-close>✕</button></div>
      <div class="gs-body">
        <p class="muted" style="margin:0 0 8px">闭环硬性要求：副线可开放式结局，但必须回应其核心问题。消失超全书 ${Math.round(ratio*100)}% 的副线读者容易淡忘，建议安排回归（回归时 ≤20 字轻提前情）。</p>
        ${rows}
      </div>
      <div class="gs-actions"><button class="btn" data-sb-close>关闭</button></div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelectorAll('[data-sb-close]').forEach(b=> b.onclick = ()=>{ const p=$('#subBoard'); if(p) p.remove(); });
  ov.addEventListener('click', e=>{ if(e.target===ov){ const p=$('#subBoard'); if(p) p.remove(); } });
}
// 体量提示（拼入章节正文提示词）：只交代全书章节数与当前章位，不给任何字数限制
function sizeChapterInjection(){
  const n = realChapterCount();   // v1.0.119 用真实章节数（对齐 users 看到的章数），无章节时不注入
  const total = n ? `全书共 ${n} 章；` : '';
  return `${total}本章正文不设字数上限，按剧情需要自然成稿，章与章之间衔接顺畅、节奏自然。`;
}
// 更新体量派生提示（页面内）
function bindSizeHint(){
  const el = $('#sizeHint'); if(!el) return;
  el.textContent = sizeHintText();
  // 同步刷新两个滑条侧的值标签（render 会重画滑条位置，这里先改文字，避免拿旧值）
  $$('[data-size-lbl]').forEach(b=>{
    const key = b.dataset.sizeLbl;          // e.g. 'word-min'
    const [side, kind] = key.split('-');
    const r = side==='word' ? state.wordRange : state.chapterRange;
    if(r && +r[kind]>0){ b.textContent = side==='word' ? (+r[kind]).toLocaleString() : r[kind]; }
  });
}
// 拼装：章节提示词 = 4.7 Pro 执行导演 + 风格契约置顶 +（篇幅 × 原创性）
// 4.7 Pro（3.5 原码）：风格契约（L0）必须置顶于正文 System 之前
function buildChapterSys(styleOverride){
  const parts = [];
  parts.push(LONG_CHAPTER_SYS_PRO);
  const styleNote = chapterStyleNote(styleOverride);
  if(styleNote) parts.unshift(styleNote);          // 风格契约必须置顶
  // 注入风格契约 L0
  const sc = state.styleContract;
  if(sc) parts.unshift(buildStyleContractBlock(sc));
  const langLayer = langLayerInjection();   // v1.0.129 语言分层（仅长篇+开关开时注入）
  if(langLayer) parts.push(langLayer);
  const banNote = banListBlockFor('chapter');   // v1.0.132 禁则清单（仅长篇，按生效范围）
  if(banNote) parts.push(banNote);
  parts.push('\n【篇幅体量】\n'+sizeChapterInjection());
  parts.push('\n\n'+ORIGINALITY_CHAPTER_SYS);
  return parts.join('\n\n');
}

// 4.7 Pro（3.5 原码）：L0 风格契约块（量化指标 + 输出后校验提示）
function buildStyleContractBlock(sc){
  return `【L0 · 写作风格契约（最高优先级）】
- 平均句长目标：${sc.sentenceAvg} 字（容忍 ±${Math.round((sc.sentenceTolerance||0.2)*100)}%）
- 对话占比目标：${Math.round((sc.dialogueRatio||0)*100)}%（容忍 ±${Math.round((sc.dialogueTolerance||0.1)*100)}%）
- 禁用词/短语：${(sc.forbiddenPhrases||[]).join('、') || '无'}
- 偏好转场：${(sc.preferredTransitions||[]).join('、') || '无'}
- 节奏说明：${sc.rhythmNote || '无'}
请在输出前自检上述指标，输出正文后程序将后验校验。`;
}

// 4.5：longOutlineSys 已删除，统一使用 buildOutlineSys()
// 4.5 longChapterSys 新版：强化 L0-L4 五层上下文约束（L0 风格契约/L1 节拍表/L2 上一章正文/L3 相关词典/L4 滚动摘要）
// 4.7 Pro（3.5）：正文 System 改由 LONG_CHAPTER_SYS_PRO 驱动，风格契约块置顶（与 buildChapterSys 同一组装逻辑，供实际生成链路使用）
const longChapterSys = (styleOverride) => {
  const parts = [];
  parts.push(LONG_CHAPTER_SYS_PRO);
  const styleNote = chapterStyleNote(styleOverride);
  if(styleNote) parts.unshift(styleNote);          // 风格契约必须置顶
  const sc = state.styleContract;
  if(sc) parts.unshift(buildStyleContractBlock(sc));
  const langLayer = langLayerInjection();   // v1.0.129 语言分层（仅长篇+开关开时注入）
  if(langLayer) parts.push(langLayer);
  const banNote2 = banListBlockFor('chapter');   // v1.0.132 禁则清单（仅长篇，按生效范围）
  if(banNote2) parts.push(banNote2);
  parts.push('\n【篇幅体量】\n'+sizeChapterInjection());
  parts.push('\n\n'+ORIGINALITY_CHAPTER_SYS);
  return parts.join('\n\n');
};

function fullStoryText(){
  return state.chapters.map(c => `【${c.title}】\n${c.content}`).join('\n\n');
}

function isLong(){ return state.mode === 'longnovel'; }

/* =========================================================
 * 创作规范：仅作用于「写小说」环节（大纲 + 章节正文）。
 * 角色 / 场景 / 分镜提示词生成不使用规范，保持独立性。
 * ========================================================= */
const SPECS = [
  { id:'full',        name:'完整长篇',     short:'完整长篇',
    desc:'生成全部章节的完整小说。默认行为，不选任何其他规范时即是此模式。',
    sys:'' },
  { id:'planfirst',   name:'先规划再动笔', short:'先规划',
    desc:'先确立世界观、人物小传与伏笔架构再动笔；章章服务整体。',
    sys:'动笔前先确立清晰的世界观（时代/地理/力量或社会规则）、主要人物小传（动机/弧光/关系网）与贯穿全书的伏笔与核心冲突。每一章都须服务于整体架构，避免随意发散。' },
  { id:'webnovel',    name:'黄金网文节奏', short:'网文节奏',
    desc:'开篇抛冲突与悬念；因果链清晰、抉择有代价、阶梯递进、情绪张弛有度。',
    sys:'遵循强节奏网文写法：开篇尽快抛出核心冲突与悬念（金手指/秘密）；每章保证因果链清晰、角色抉择有代价、实力或关系阶梯递进、情绪节奏有张有弛（爽点-压抑-爆发交替）；以对话推动剧情、少冗长描写。' },
  { id:'consistency', name:'强一致性自检', short:'一致性',
    desc:'每章生成后自检时间线/性格/视角/伏笔/专名，与上文冲突即自我修正。',
    sys:'生成每一章后，自行核对并维持一致性：时间线不矛盾、人物性格与外貌前后统一、POV 视角不跳脱、已铺设伏笔需回收或有交代、地名与专有名词拼写统一；若与上文冲突须自我修正。' },
  { id:'character',   name:'角色/情节驱动', short:'角色驱动',
    desc:'以人物弧光与强情节为核心，弱化宏大世界观，单线深挖、心理优先。',
    sys:'以人物弧光与强情节为核心，弱化宏大世界观铺陈。每一章聚焦角色在压力下的抉择与关系变化，用紧凑单线深挖取代多线铺开；心理描写优先于环境描写。' }
];
function getSpec(){
  const cfg = getCfg();
  const id = cfg.spec || 'full';
  return SPECS.find(s=>s.id===id) || SPECS[0];
}
/* 故事页内联创作规范选择器（替代原顶栏规范弹层） */
function specPickerHtml(){
  const cur = getSpec().id;
  return `<div class="spec-pick" id="specPicker">
    <div class="spec-pick-head"><span>📐 创作规范（作用于「写小说」）</span></div>
    <div class="spec-pick-opts">${SPECS.map(s=>`<button type="button" class="spec-opt ${s.id===cur?'active':''}" data-spec="${s.id}" title="${esc(s.desc)}">${esc(s.short)}</button>`).join('')}</div>
  </div>`;
}
function specSysAddition(){
  const s = getSpec();
  return (s && s.sys) ? '\n\n【本次创作规范 · '+s.name+'】\n'+s.sys : '';
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

function updateMechaNav(){
  const mtn = $('#mechaTopNav'); if(!mtn) return;
  $$('.cap', mtn).forEach(c=>{
    const n = c.dataset.step ? +c.dataset.step : null;
    c.classList.toggle('active', n && n === currentStep);
  });
}

function render(){
  normalizeOutline(state.outline);   // 4.6 Plus：outline 防御归一化（第 1 章调用点：render 开始时）
  destroyCharTS(); // 先销毁旧 Tom Select，避免 DOM 残留/重复实例
  restartCascade();
  renderStepper();
  updateMechaNav();
  $$('.tab').forEach(t=>{
    const n = +t.dataset.step;
    // 长篇模式隐藏「角色」「分镜」（不需要生成视频提示词）
    const hideLong = isLong() && (n===2 || n===4);
    t.classList.toggle('hidden', hideLong);
    t.classList.toggle('active', n===currentStep);
  });
  const v = $('#view');
  if(currentStep===1) v.innerHTML = viewStory();
  else if(currentStep===2) v.innerHTML = viewCharacters();
  else if(currentStep===3) v.innerHTML = viewScenes();
  else if(currentStep===4) v.innerHTML = viewStoryboard();
  else if(currentStep===5) v.innerHTML = viewExport();
  bindView();
  updateWcTotal();
}

/* ---------- P1 故事 ---------- */

// 当前书名
function currentTitle(){
  const o = state.outline;
  if(o && o.title) return o.title;
  return state.idea ? state.idea.trim().slice(0,20) : '未命名作品';
}
// 曾用名记录：每次改名时把旧名压入历史（最新在前）
function pushTitleHistory(oldName){
  if(!oldName) return;
  const d = new Date();
  const date = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')
    + ' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  state.titleHistory.unshift({ name: oldName, date });
  if(state.titleHistory.length > 50) state.titleHistory = state.titleHistory.slice(0,50);
}
// 修改书名：确认后改 outline.title/state 标题，并把旧名压入曾用名
function renameTitle(newName){
  newName = String(newName||'').trim();
  if(!newName){ toast('书名不能为空'); return; }
  const oldName = currentTitle();
  if(oldName === newName){ toast('书名未变化'); return; }
  pushTitleHistory(oldName);
  if(state.outline) state.outline.title = newName;
  persist(); render();
  toast(`已改名为「${newName}」，原「${oldName}」已记入曾用名`);
}
// 标题栏：当前名 + 改名按钮 +「曾用名」小三角（点击展开）
function titleManagerHtml(){
  let histRows;
  if(state.titleHistory && state.titleHistory.length){
    histRows = state.titleHistory.map((h,idx)=>
      `<div class="hist-row"><span class="hist-name">${esc(h.name)}</span><span class="hist-date">${esc(h.date)}</span>
        <span class="hist-ops">
          <button type="button" class="icon-btn hist-op" data-hist-restore="${esc(h.name)}" title="恢复为此名">↩</button>
          <button type="button" class="icon-btn hist-op" data-hist-del="${idx}" title="删除该记录">🗑</button>
        </span></div>`
    ).join('');
  }else{
    histRows = `<div class="hist-empty">暂无曾用名</div>`;
  }
  return `
    <div class="title-manager">
      <span class="tm-cur" id="tmCur" title="点击改名">${esc(currentTitle())}</span>
      <button type="button" class="icon-btn tm-tri" id="btnTmTri" title="曾用名" data-tm-tri>▾</button>
      <div class="tm-hist hidden" id="tmHist">
        <div class="hist-title">曾用名</div>
        ${histRows}
      </div>
    </div>`;
}
const CYBER_HOME_GRID = `
  <div class="cyber-home-grid">
    <button class="cyber-card-btn purple" data-step="1"><span class="ico">📖</span><span class="lab">故事</span><span class="sub">输入构想并生成章节</span></button>
    <button class="cyber-card-btn cyan" data-step="2"><span class="ico">🧑</span><span class="lab">角色</span><span class="sub">生成角色定妆提示词</span></button>
    <button class="cyber-card-btn pink" data-step="3"><span class="ico">🏞️</span><span class="lab">场景</span><span class="sub">生成场景即梦提示词</span></button>
    <button class="cyber-card-btn orange" data-step="4"><span class="ico">🎞️</span><span class="lab">分镜</span><span class="sub">生成视频分镜文字</span></button>
  </div>`;

/* =========================================================
 * v2.0 写作风格选择器：主卡片 + 预设 + 收藏 + 词库管理
 * ========================================================= */
const WRITE_PRESETS = [
  { id:'clear',          name:'🧹 默认（无风格）', tags:[], intensity:2 },
  { id:'preset-humor',   name:'😆 网感轻喜',  tags:['roast','webman','fast'], intensity:2 },
  { id:'preset-art',     name:'🌸 文艺唯美',  tags:['wenyi','poetic','minimal'], intensity:2 },
  { id:'preset-classic', name:'🏮 古典文学',  tags:['jinyong','ornate','storyteller'], intensity:3 },
  { id:'preset-mystery', name:'🕵️ 悬疑压抑',  tags:['suspense2','jifeng','multipov'], intensity:2 },
  { id:'preset-passion', name:'🔥 热血燃向',  tags:['fast','sliceoflife'], intensity:3 }
];
function writeStyleState(){ return state.chapterStyle = state.chapterStyle || { tags:[], intensity:2, collapsed:false }; }
// v2.1 主卡「生效确认」：草稿态（内存，不参与生成）vs 生效态（state.chapterStyle）
let wsDraft = null;   // null=未编辑（与生效一致）；非 null=有草稿待应用
function wsDraftInit(){
  if(!wsDraft){ const st = writeStyleState(); wsDraft = { tags:(st.tags||[]).slice(), intensity: st.intensity||2 }; }
  return wsDraft;
}
function wsDraftDirty(d, st){
  const a = ((d&&d.tags)||[]).slice().sort().join(',');
  const b = ((st&&st.tags)||[]).slice().sort().join(',');
  return a !== b || ((d&&d.intensity)||2) !== ((st&&st.intensity)||2);
}
// 局部刷新主卡 UI（不重建 DOM，避免丢焦点）：chips 高亮 / 摘要行双态 / 应用按钮 / 提示行
function refreshWsUI(){
  const st = writeStyleState();
  const dirty = !!wsDraft && wsDraftDirty(wsDraft, st);
  const draft = wsDraft || st;
  const selName = (draft.tags||[]).map(id=>{ const s=writeStyleById(id); return s?s.name:id; }).join(' + ') || '无';
  const sum = $('.ws-sum');
  if(sum){ sum.textContent = (dirty?'⚠️ 待应用':'✔ 已生效')+' · '+(draft.tags||[]).length+' 项 · '+selName; sum.classList.toggle('dirty', dirty); }
  $$('[data-ws-tag]').forEach(b=> b.classList.toggle('on', (draft.tags||[]).includes(b.dataset.wsTag)));
  // v1.0.117 配方（组合）高亮刷新：完全包含该配方所有词条则标 on
  $$('[data-ws-combo]').forEach(b=>{
    const combo = availableCombos().find(c=> c.id === b.dataset.wsCombo);
    if(!combo) return;
    const active = combo.tags&&combo.tags.length && combo.tags.every(t=>(draft.tags||[]).includes(t));
    b.classList.toggle('on', active);
  });
  // v10.22 勾选/应用后自动展开含已选词条的分类（保证「选了就看得见」；不影响用户对手动折叠的空类偏好）
  $$('.ws-subcat').forEach(sub=>{
    if(sub.classList.contains('open')) return;
    if(sub.querySelector('.ws-opt.on')){
      sub.classList.add('open');
      const ico = sub.querySelector('.ws-subcat-t .sc-fold-ico'); if(ico) ico.textContent='▾';
    }
  });
  const ap = $('[data-ws-apply]');
  if(ap){ ap.disabled = !dirty; ap.classList.toggle('disabled', !dirty); }
  const hint = $('.ws-dirty-hint');
  if(hint) hint.style.display = dirty ? '' : 'none';
}
// 通用 chips / 浓度段选渲染（主卡片与重生成弹窗复用；dataPrefix 区分绑定域）
// opts.plus：每组末尾加「＋」添加入口；opts.cardFold：主卡启用「章节风格」折叠（默认收拢）
// v10.19 写作风格三组配色方案：色序固定 [标题(tone), 梗概(texture), 章节(element)]（即上/中/下）
// 来自用户提供的 11 套三色搭配图；空字符串代表「默认无配色」。存入 cfg.styleCustom.colorScheme（存索引，''=默认）
const WS_COLOR_SCHEMES = [
  { id:'none',    name:'默认（无配色）', c:[] },
  { id:'s1',  name:'活力橙紫青', c:['#f84914','#59187e','#2fb4af'] },
  { id:'s2',  name:'海洋蓝青',   c:['#1e95d4','#78cede','#b1e4e7'] },
  { id:'s3',  name:'皇家蓝绛红', c:['#0176bb','#c42536','#dcb582'] },
  { id:'s4',  name:'蔷薇粉紫',   c:['#f6afad','#c49ee4','#e2d8ef'] },
  { id:'s5',  name:'绯红玫紫',   c:['#f83177','#c6979c','#fcbed4'] },
  { id:'s6',  name:'绯红钢青',   c:['#fa2742','#7384af','#f8b79a'] },
  { id:'s7',  name:'青黄珊瑚',   c:['#54d5c7','#edba38','#f65150'] },
  { id:'s8',  name:'深蓝明黄',   c:['#17519e','#f7dd2f','#4fcbe9'] },
  { id:'s9',  name:'薄荷明黄',   c:['#8fedc2','#fdd741','#24b4a5'] },
  { id:'s10', name:'暖金珊瑚',   c:['#f4d474','#ef5a56','#f9e9da'] },
  { id:'s11', name:'自然翠金',   c:['#67d47e','#efeb86','#f5b11e'] },
];
/* ===== 配色管理（v10.20）：内置11套 + 我的自定义；支持删除 / 撤销 / 恢复全部 / 新建三色 ===== */
function wsColorCfgOf(c){ c.styleCustom = c.styleCustom || { notes:{},added:[],removed:[] }; c.styleCustom.colorSchemes = c.styleCustom.colorSchemes || { custom:[], removedCustom:[], removedBuiltin:[], undo:[] }; return c.styleCustom.colorSchemes; }
function wsColorCfg(){ return wsColorCfgOf(getCfg()); }               // 只读访问
function wsCustomColors(){ return wsColorCfg().custom || []; }        // 未删除的自定义
function wsRemovedBuiltin(){ return wsColorCfg().removedBuiltin || []; }
function wsRemovedCustom(){ return wsColorCfg().removedCustom || []; }
function wsUndoLog(){ return wsColorCfg().undo || []; }
// 展示用完整方案列表：内置（未删）+ 我的自定义（未删）
function wsColorSchemesList(){
  const rm = wsRemovedBuiltin();
  return WS_COLOR_SCHEMES.filter(s=>!rm.includes(s.id)).concat(wsCustomColors());
}
// 取某方案的三色（含已删除的自定义，供撤销恢复用）；无配色返回空数组
function wsSchemeColors(id){
  if(id==='none') return [];
  const s = WS_COLOR_SCHEMES.find(x=>x.id===id) || wsCustomColors().find(x=>x.id===id) || wsRemovedCustom().find(x=>x.id===id);
  return s ? (s.c||[]) : [];
}
function wsSchemeName(id){
  if(id==='none') return '默认（无配色）';
  const s = WS_COLOR_SCHEMES.find(x=>x.id===id) || wsCustomColors().find(x=>x.id===id);
  return s ? s.name : id;
}
// 当前选中方案；若所选配色已被删除则回落「默认」
function wsColorSchemeId(){
  const sc = getCfg().styleCustom||{};
  const id = sc.colorScheme || 'none';
  if(id==='none') return 'none';
  if(WS_COLOR_SCHEMES.find(s=>s.id===id) && !wsRemovedBuiltin().includes(id)) return id;
  if(wsCustomColors().find(s=>s.id===id)) return id;
  return 'none';
}
// 重建「我的自定义」配色的注入 CSS（[data-cs="cu_*"] → 三色变量），供卡片/重生成弹窗即时着色
function rebuildCustomColorCss(){
  let el = document.getElementById('wsCustomCss');
  if(!el){ el = document.createElement('style'); el.id='wsCustomCss'; document.head.appendChild(el); }
  el.textContent = wsCustomColors().map(s=>`[data-cs="${s.id}"]{--c-tone:${s.c[0]};--c-texture:${s.c[1]};--c-element:${s.c[2]}}`).join('\n');
}
function writeStyleChipsHtml(sel, dataPrefix, opts){
  opts = opts || {};
  const lib = writeStyleLib();
  // v10.19 直接以五大类文风（cat）排列，不再分「标题/梗概/章节」三组
  const CAT_LABEL = { '语言质感':'① 语言质感', '情绪与张力':'② 情绪与张力', '节奏与网感':'③ 节奏与网感', '叙事技法':'④ 叙事技法', '台词设计':'⑤ 台词设计', custom:'⭐ 我的自定义' };
  const CAT_ORDER = ['语言质感','情绪与张力','节奏与网感','叙事技法','台词设计','custom'];
  const items = lib.filter(s=>s.group==='element');
  const mkOpt = s=>`<div class="ws-opt ${(sel.tags||[]).includes(s.id)?'on':''}" data-${dataPrefix}-tag="${s.id}">
    <div class="ws-opt-name">${esc(s.name)}</div>
    <div class="ws-opt-note">${esc(s.note)}</div>
  </div>`;
  const plus = opts.plus ? `<button type="button" class="ws-chip ws-chip-plus" data-${dataPrefix}-add="element" title="点击新建文风词条">＋</button>` : '';
  // v10.22 五大类分类折叠（仅主写作卡片 dataPrefix==='ws' 启用）：默认只开含已选词条的类，其余收成一行标题；
  // 用户手动切换后按 state.chapterStyle.catOpen 持久化；重生成/对比面板 useFold=false 保持全展开，不受影响。
  const useFold = dataPrefix === 'ws';
  const catOpen = (useFold && writeStyleState().catOpen) || {};
  const blocks = CAT_ORDER.map(cat=>{
    const its = items.filter(s=>(s.cat||'element')===cat);
    if(!its.length) return '';
    // v1.0.117 词条专注：默认只显示当前选中的词条，其余不出现；点分类标题条才临时展开显示本类全部
    const hits = its.filter(s=>(sel.tags||[]).includes(s.id));
    const expanded = useFold ? (catOpen[cat] === true) : false;    // 展开态=显示本类全部
    const hasSel = hits.length > 0;
    const showBody = useFold ? (expanded || hasSel) : true;        // 专注态下：有已选则展示体(只显已选)，无已选则收成标题
    const shown = expanded ? its : hits;                            // 展开=全部；专注=仅已选
    const fold = useFold ? `<span class="sc-fold-ico">${expanded?'▾':'▸'}</span>` : '';
    return `<div class="ws-subcat${showBody?' open':''}"${useFold?` data-ws-catfold="${cat}"`:''}>
      <div class="ws-subcat-t"${useFold?' role="button" tabindex="0" title="专注态只显示已选词条，点此展开查看本类全部"':''}>${CAT_LABEL[cat]||cat}${useFold?`（${expanded ? `共 ${its.length}` : `已选 ${hits.length}`}）`:''}${fold}</div>
      <div class="ws-subcat-fold"><div class="ws-opt-list">${shown.map(mkOpt).join('')}</div></div>
    </div>`;
  }).filter(Boolean).join('');
  // v2.4 组合配方栏：一键配齐（点击替换当前选择），仅主写作卡片展示（dataPrefix==='ws'）；重生成章节覆盖/对比面板不渲染，避免出现无法绑定的死按钮
  // v2.5 支持删除内置组合（写入 cfg.styleCustom.comboRemoved），卡片右上角 ✕ 删除；被删后显示「恢复已删组合」
  const comboList = dataPrefix==='ws' ? availableCombos() : [];
  const comboRemovedN = (getCfg().styleCustom||{}).comboRemoved && getCfg().styleCustom.comboRemoved.length ? getCfg().styleCustom.comboRemoved.length : 0;
  const customCombos = dataPrefix==='ws' ? ((getCfg().styleCustom||{}).customCombos||[]) : [];
  const comboOpen = (dataPrefix==='ws' && getCfg().styleCustom && getCfg().styleCustom.comboOpen) || {}; // v10.31 内置/我的配方独立折叠
  // 单个组合卡片模板（内置/自定义通用）
  // v1.0.117 配方高亮：当前草稿已完全包含该配方词条时标 .on（内置+我的配方同规则；叠加细项后仍保持）
  const comboActive = c => !!(c.tags&&c.tags.length && (c.tags||[]).every(t=>(sel.tags||[]).includes(t)));
  const mkCombo = c=> `<div class="ws-opt ws-combo-btn${comboActive(c)?' on':''}" data-ws-combo="${c.id}"><span class="ws-combo-del" data-ws-combo-del="${c.id}" title="删除此组合">✕</span><div class="ws-opt-name">${esc(c.name)}</div><div class="ws-opt-note">${esc(c.desc||'')}</div></div>`;
  const comboBar = dataPrefix==='ws'
    ? `<div class="ws-combo${comboOpen.builtin===false?'':' open'}" data-ws-combofold="builtin">
       <div class="ws-subcat-t" role="button" tabindex="0" title="展开/收起">
         <span class="ws-combo-title"><span class="sc-fold-ico">${comboOpen.builtin===false?'▸':'▾'}</span> 🎬 组合配方 <span class="muted" style="font-size:10px;font-weight:400">点击即替换当前选择，可再叠加细项</span></span>
         ${comboRemovedN?`<button type="button" class="ws-combo-restore" data-ws-combo-restore>恢复已删组合(${comboRemovedN})</button>`:''}
       </div>
       <div class="ws-subcat-fold"><div class="ws-opt-list">${comboList.filter(c=>!c.custom).map(mkCombo).join('')}</div></div>
     </div>
     <div class="ws-combo ws-combo-mine${comboOpen.custom===false?'':' open'}" data-ws-combofold="custom">
       <div class="ws-subcat-t" role="button" tabindex="0" title="展开/收起">
         <span class="ws-combo-title"><span class="sc-fold-ico">${comboOpen.custom===false?'▸':'▾'}</span> 🏷 我的配方</span>
         <button type="button" class="ws-combo-add" data-ws-combo-add title="把当前草稿保存为自定义组合配方">＋</button>
       </div>
       <div class="ws-subcat-fold"><div class="ws-opt-list">${customCombos.map(mkCombo).join('')}</div></div>
     </div>`
    : '';
  // v10.54 加号已移入主卡片 .ws-tools 行最左；此处仅在有 plus 或需要提示时渲染底部行，避免主卡片出现孤立「可多选」
  const chipsTail = (opts.plus || opts.showTip !== false)
    ? `<div class="ws-chips">${opts.showTip !== false ? '<span class="ws-group-tip">可多选</span>' : ''}${plus}</div>` : '';
  return `${comboBar}${blocks}${chipsTail}`;
}
function writeStyleIntHtml(){} // v2.6 浓度已整体移除，保留空占位避免外部引用误伤
// 风格 chip 切换公共逻辑：五大类词条可多选、可清空
function toggleWriteTag(sel, id){
  const s = writeStyleById(id); if(!s) return;
  if(sel.tags.includes(id)){
    sel.tags = sel.tags.filter(x=>x!==id);
  } else {
    if(!sel.tags.includes(id)) sel.tags.push(id);
  }
}
// v10.53 已去除「选择预设」功能，writePresetOptions 随之删除；WRITE_PRESETS 仍被「收藏当前」解析引用
// 主卡片
function writeStyleCard(){
  const st = writeStyleState();
  const draft = wsDraft || st;
  const dirty = !!wsDraft && wsDraftDirty(wsDraft, st);
  const selName = (draft.tags||[]).map(id=>{ const s=writeStyleById(id); return s?s.name:id; }).join(' + ') || '无';
  const sumTxt = (dirty?'⚠️ 待应用':'✔ 已生效')+' · '+(draft.tags||[]).length+' 项 · '+selName;
  return `<div class="card ws-card${st.collapsed?' ws-collapsed':''}" data-cs="${wsColorSchemeId()}">
    <div class="ws-head" data-ws-fold role="button" tabindex="0" title="展开/收起">
      <h3 style="margin:0">✍️ 写作风格</h3>
      <span class="ws-sum${dirty?' dirty':''}">${sumTxt}</span>
      <button type="button" class="btn ghost ws-manage-btn" data-ws-lib title="编辑风格词库与我的收藏">⚙️ 管理</button>
      <span class="sc-fold-ico">${st.collapsed?'▸':'▾'}</span>
    </div>
    <div class="ws-body"${st.collapsed?' hidden':''}>
      <div class="ws-fold-tools">
        <button type="button" class="btn small ghost" data-ws-fold-all title="展开全部词条类别">⤵ 全部展开</button>
        <button type="button" class="btn small ghost" data-ws-fold-none title="收起全部词条类别">⤴ 全部收起</button>
      </div>
      ${ isLong() ? `
      <div class="ws-lang-layer" title="开启：正文按题材自动调节语言底色，对白口语化、书面语只用于情绪峰值；关闭：不注入任何语言分层约束">
        <label class="gs-autofill" style="display:inline-flex;align-items:center;gap:6px">
          <input type="checkbox" data-lang-layer ${state.langLayer?'checked':''} />
          <b>语言分层自动调节</b>
        </label>
        <span class="muted" style="font-size:11px">书面语造氛围、口语推剧情；随题材自动定底色。仅长篇生效</span>
      </div>` : '' }
      ${writeStyleChipsHtml(draft, 'ws', { plus:false, cardFold:true, showTip:false })}
      <div class="ws-tools">
        <button type="button" class="ws-chip ws-chip-plus" data-ws-add="element" title="点击新建文风词条">＋</button>
        <button type="button" class="btn small primary ws-apply${dirty?'':' disabled'}" data-ws-apply ${dirty?'':'disabled'} title="把当前草稿设为生效配置（从此生成用这套风格）">✔ 应用并保存</button>
        <button type="button" class="btn small ghost" data-ws-save title="把当前草稿收藏为预设（跨作品可用）">💾 收藏当前</button>
        <button type="button" class="btn small ghost" data-ws-clear>✕ 清空</button>
      </div>
      <p class="ws-dirty-hint" style="display:${dirty?'':'none'}">⚠️ 当前为草稿（${(draft.tags||[]).length} 项未生效），点「✔ 应用并保存」后开始生效；生成章节读的是已生效配置。</p>
      <p class="muted" style="margin:6px 0 0;font-size:11px">按五大类文风多选，可同取多个词条叠加效果（如「文艺/范儿」＋「金句」）；浓度默认「中」，生成章节正文时生效。选完点「✔ 应用并保存」才生效。</p>
    </div>
  </div>`;
}
function bindWriteStyle(){
  const st = writeStyleState();
  const head = $('[data-ws-fold]');
  if(head) head.onclick = ()=>{
    st.collapsed = !st.collapsed; persist();
    const body = $('.ws-body'); if(body) body.hidden = st.collapsed;
    const ico = head.querySelector('.sc-fold-ico'); if(ico) ico.textContent = st.collapsed?'▸':'▾';
  };
  // v2.1：chips/浓度/预设/清空 一律改「草稿」→ 局部刷新 → 点「✔ 应用并保存」才生效
  $$('[data-ws-tag]').forEach(b=> b.onclick = ()=>{
    toggleWriteTag(wsDraftInit(), b.dataset.wsTag);
    refreshWsUI();
  });
  // v2.4 组合配方按钮：点击即以「替换」方式覆盖草稿标签（清空当前 + 填入组合），再点「✔ 应用并保存」生效
  // v10.28 兼容自定义组合（availableCombos 返回内置+我的配方）
  $$('[data-ws-combo]').forEach(b=> b.onclick = ()=>{
    const combo = availableCombos().find(c=> c.id === b.dataset.wsCombo); if(!combo) return;
    const d = wsDraftInit();
    const libIds = writeStyleLib().map(s=>s.id);
    d.tags = (combo.tags||[]).filter(id=> libIds.includes(id));
    render(); // v1.0.117 重建卡片，令词条专注态立即展示该配方所包含的词条 + 配方高亮
    toast(`已套用组合「${combo.name}」：${(d.tags.map(id=>{const s=writeStyleById(id);return s?s.name:id}).join(' + '))||'（部分词条已删，未套用）'}，点「✔ 应用并保存」生效`);
  });
  // v2.5 组合删除：内置写入 styleCustom.comboRemoved / 自定义直接移除 customCombos → 完整 render 重建卡片
  $$('[data-ws-combo-del]').forEach(b=> b.onclick = (e)=>{
    e.stopPropagation();
    const id = b.dataset.wsComboDel; if(!id) return;
    const cfg = getCfg(); cfg.styleCustom = cfg.styleCustom || {};
    const isBuiltin = WRITE_COMBOS.some(c=> c.id === id);
    if(isBuiltin){
      const combo = WRITE_COMBOS.find(c=> c.id === id);
      if(!combo) return;
      if(!window.confirm(`删除组合「${combo.name}」后不再显示，可通过「恢复已删组合」还原。确定删除？`)) return;
      cfg.styleCustom.comboRemoved = cfg.styleCustom.comboRemoved || [];
      if(!cfg.styleCustom.comboRemoved.includes(id)) cfg.styleCustom.comboRemoved.push(id);
      saveCfg(cfg); render(); toast(`已删除组合「${combo.name}」`);
    } else {
      const combo = (cfg.styleCustom.customCombos||[]).find(c=> c.id === id);
      if(window.confirm(`删除自定义组合「${combo?combo.name:id}」？删后不可撤销。确定删除？`)){
        cfg.styleCustom.customCombos = (cfg.styleCustom.customCombos||[]).filter(x=> x.id !== id);
        saveCfg(cfg); render(); toast('已删除自定义组合');
      }
    }
  });
  // v10.28 「我的配方」加号：把当前草稿（未编辑时取生效配置）保存为自定义组合配方
  const cadd = $('[data-ws-combo-add]');
  if(cadd) cadd.onclick = ()=>{
    const cur = wsDraft || writeStyleState();
    const tags = (cur.tags||[]).slice();
    if(!tags.length){ toast('当前无风格，暂无可保存的组合配方'); return; }
    const cfg = getCfg(); cfg.styleCustom = cfg.styleCustom || {};
    cfg.styleCustom.customCombos = cfg.styleCustom.customCombos || [];
    const name = prompt('给这个组合配方起个名字：', '我的配方' + (cfg.styleCustom.customCombos.length + 1));
    if(!name || !name.trim()) return;
    const desc = tags.map(id=>{ const s=writeStyleById(id); return s? s.name : id; }).join(' + ');
    cfg.styleCustom.customCombos.push({ id:'cu'+Date.now().toString(36), name:name.trim(), desc, tags });
    saveCfg(cfg); render();
    toast('已保存为自定义组合「' + name.trim() + '」，点它即可一键套用');
  };
  const cre = $('[data-ws-combo-restore]');
  if(cre) cre.onclick = ()=>{
    if(!window.confirm('恢复全部被删除的组合配方？')) return;
    const cfg = getCfg(); cfg.styleCustom = cfg.styleCustom || {};
    cfg.styleCustom.comboRemoved = [];
    saveCfg(cfg); render(); toast('已恢复全部默认组合');
  };
  const sel = $('#wsPreset');
  // v10.53 已去除「选择预设」功能，绑定代码保留空守卫避免历史调用误伤
  const ap = $('[data-ws-apply]');
  if(ap) ap.onclick = ()=>{
    if(!wsDraft) return;
    const st2 = writeStyleState();
    st2.tags = wsDraft.tags.slice(); st2.intensity = wsDraft.intensity;
    persist();
    const name = wsDraft.tags.map(id=>{ const s=writeStyleById(id); return s?s.name:id; }).join(' + ') || '无';
    wsDraft = null;
    refreshWsUI();
    toast('写作风格已生效：'+(name==='无'?'无风格（AI 默认文风）':name));
  };
  // 收藏当前：收藏草稿组合（未编辑时即生效配置）
  const sv = $('[data-ws-save]');
  if(sv) sv.onclick = ()=>{
    const cur = wsDraft || writeStyleState();
    if(!cur.tags.length){ toast('当前无风格，无需收藏'); return; }
    const cfg = getCfg(); if(!Array.isArray(cfg.stylePresets)) cfg.stylePresets = [];
    const name = prompt('给这个风格组合起个名字：', '我的风格'+(cfg.stylePresets.length+1));
    if(!name || !name.trim()) return;
    cfg.stylePresets.push({ id:'sp'+Date.now().toString(36), name:name.trim(), tags:cur.tags.slice(), intensity:cur.intensity });
    saveCfg(cfg); render();
    toast('已收藏：'+name.trim());
  };
  const lb = $('[data-ws-lib]');
  if(lb) lb.onclick = (e)=>{ e.stopPropagation(); openStyleLibPanel(); };
  // 清空：只清草稿，点应用才生效（语义统一）
  const cl = $('[data-ws-clear]');
  if(cl) cl.onclick = ()=>{ const d = wsDraftInit(); d.tags=[]; d.intensity=2; refreshWsUI(); toast('已清空草稿，点「✔ 应用并保存」生效'); };
  // v10.22 五大类分类折叠（主卡，事件委托处理动态渲染）：点类标题展开/收起，偏好持久化到 state.chapterStyle.catOpen
  // 兼容重生成面板（.ws-subcat-t 无 role，不响应）；render 重建后 .ws-card 为新节点，dataset 为空会重新绑定一次
  const wsCard = $('.ws-card');
  // v1.0.129 语言分层开关（仅长篇显示；事件冒泡导致重复绑定，先清理旧监听）
  const langToggle = $('[data-lang-layer]');
  if(langToggle){
    langToggle.onchange = ()=>{
      state.langLayer = langToggle.checked;
      persist();
      toast(state.langLayer ? '已开启语言分层自动调节（正文按题材自动定语言底色，书面语造氛围、口语推剧情）' : '已关闭语言分层自动调节（正文不再注入语言分层约束）');
    };
  }
  // v10.51 一键全部展开/收起（仅作用于词条五大类 data-ws-catfold；组合配方 data-ws-combofold 不动）
  const fa = wsCard && wsCard.querySelector('[data-ws-fold-all]');
  if(fa) fa.onclick = ()=>{ const st=writeStyleState(); st.catOpen=st.catOpen||{};
    ['语言质感','情绪与张力','节奏与网感','叙事技法','台词设计'].forEach(k=> st.catOpen[k]=true);
    persist(); render(); };
  const fn = wsCard && wsCard.querySelector('[data-ws-fold-none]');
  if(fn) fn.onclick = ()=>{ const st=writeStyleState(); st.catOpen=st.catOpen||{};
    ['语言质感','情绪与张力','节奏与网感','叙事技法','台词设计'].forEach(k=> st.catOpen[k]=false);
    persist(); render(); };
  if(wsCard && !wsCard.dataset.catfoldBound){
    wsCard.dataset.catfoldBound = '1';
    wsCard.addEventListener('click', e=>{
      const t = e.target.closest('.ws-subcat-t');
      if(!t || !t.hasAttribute('role')) return;
      // 组合板块的加号/恢复按钮不触发布内折叠
      if(e.target.closest('.ws-combo-add, .ws-combo-restore')) return;
      const sub = t.closest('.ws-subcat, .ws-combo');
      if(!sub) return;
      // v10.31 组合配方独立折叠（data-ws-combofold → cfg.styleCustom.comboOpen.builtin/custom）
      if(sub.dataset.wsCombofold!==undefined){
        const cfg = getCfg(); cfg.styleCustom = cfg.styleCustom || {};
        cfg.styleCustom.comboOpen = cfg.styleCustom.comboOpen || {};
        const open = !sub.classList.contains('open');
        cfg.styleCustom.comboOpen[sub.dataset.wsCombofold] = open; saveCfg(cfg);
        sub.classList.toggle('open', open);
        const ico = t.querySelector('.sc-fold-ico'); if(ico) ico.textContent = open?'▾':'▸';
        return;
      }
      // 五大类折叠（state.chapterStyle.catOpen）：专注↔展开，需重渲染以切换「只显已选 / 显示全部」
      if(sub.dataset.wsCatfold===undefined) return;
      const st = writeStyleState(); st.catOpen = st.catOpen || {};
      st.catOpen[sub.dataset.wsCatfold] = !(st.catOpen[sub.dataset.wsCatfold]===true); persist();
      render();
    });
  }
  // v10.17 每组末尾「＋」→ 弹窗新建该组风格词条
  $$('[data-ws-add]').forEach(b=> b.onclick = ()=> openStyleNewDialog(b.dataset.wsAdd));
}
// v10.17 新建风格词条弹窗（归属分组固定为调用它的那组；确认后立即入库并出现在该组）
function openStyleNewDialog(group){
  closeStyleNewDialog();
  const CAT_LABEL = { '语言质感':'① 语言质感', '情绪与张力':'② 情绪与张力', '节奏与网感':'③ 节奏与网感', '叙事技法':'④ 叙事技法', '台词设计':'⑤ 台词设计', custom:'⭐ 我的自定义' };
  const catLabel = ()=> CAT_LABEL[group] || '自定义';
  const ov = document.createElement('div'); ov.id='wsNewPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>＋ 新建文风词条</b>
        <button class="gs-x" data-wsn-close>✕</button></div>
      <div class="cv-body">
        <label style="font-size:12px;color:var(--sub)">归属分类</label>
        <select id="wsnCat" style="margin:4px 0 10px">
          <option value="语言质感"${group==='语言质感'?' selected':''}>① 语言质感</option>
          <option value="情绪与张力"${group==='情绪与张力'?' selected':''}>② 情绪与张力</option>
          <option value="节奏与网感"${group==='节奏与网感'?' selected':''}>③ 节奏与网感</option>
          <option value="叙事技法"${group==='叙事技法'?' selected':''}>④ 叙事技法</option>
          <option value="台词设计"${group==='台词设计'?' selected':''}>⑤ 台词设计</option>
          <option value="custom"${group==='custom'?' selected':''}>⭐ 我的自定义</option>
        </select>
        <label style="font-size:12px;color:var(--sub)">风格名称（≤20字）*</label>
        <input type="text" id="wsnName" maxlength="20" placeholder="如：民国腔调 / 冷硬悬疑" style="margin:4px 0 10px" />
        <label style="font-size:12px;color:var(--sub)">指令文本（≤500字）</label>
        <textarea id="wsnNote" rows="4" maxlength="500" placeholder="推荐三行配方：&#10;写法：…&#10;避免：…&#10;自查：…" style="margin:4px 0 6px"></textarea>
        <div class="muted" style="font-size:11px">确认后将于「<span data-wsn-catlab>${catLabel()}</span>」分类下添加并默认勾选（草稿态，点「✔ 应用并保存」正式生效）。</div>
      </div>
      <div class="modal-actions" style="padding:12px 16px;border-top:1px solid var(--line)">
        <button type="button" class="btn ghost" data-wsn-close2>取消</button>
        <button type="button" class="btn primary" data-wsn-ok>✔ 确认新建</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const lab = ov.querySelector('[data-wsn-catlab]');
  const catSel = ov.querySelector('#wsnCat');
  if(catSel && lab) catSel.onchange = ()=> lab.textContent = CAT_LABEL[catSel.value] || '自定义';
  const close = ()=> closeStyleNewDialog();
  ov.querySelector('[data-wsn-close]').onclick = close;
  ov.querySelector('[data-wsn-close2]').onclick = close;
  ov.addEventListener('click', e=>{ if(e.target===ov) close(); });
  ov.querySelector('[data-wsn-ok]').onclick = ()=>{
    const name = ($('#wsnName') && $('#wsnName').value.trim()) || '';
    if(!name){ toast('请填写风格名称'); return; }
    const note = ($('#wsnNote') && $('#wsnNote').value.trim().slice(0,500)) || '';
    const cat = (catSel && catSel.value) || group || 'custom';
    const c = getCfg(); c.styleCustom = c.styleCustom || { notes:{}, added:[], removed:[] };
    c.styleCustom.added = c.styleCustom.added || [];
    const id = 'c'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
    c.styleCustom.added.push({ id, group:cat, name, note });
    saveCfg(c);
    // 立即加入并默认勾选（草稿态待应用）
    const d = wsDraftInit(); if(!d.tags.includes(id)) d.tags.push(id);
    closeStyleNewDialog();
    render();
    toast('已新建并加入「'+name+'」');
  };
  const inp = $('#wsnName'); if(inp) inp.focus();
}
function closeStyleNewDialog(){ const p=$('#wsNewPanel'); if(p) p.remove(); }
// v2.1 预设 → 填入草稿（不直接生效）
function applyWritePresetDraft(v){
  const d = wsDraftInit();
  if(v === 'clear'){ d.tags=[]; d.intensity=2; }
  else if(v.indexOf('u:')===0){
    const cfg = getCfg();
    const p = (Array.isArray(cfg.stylePresets)?cfg.stylePresets:[]).find(x=>x.id===v.slice(2));
    if(p){ d.tags = (p.tags||[]).slice(); d.intensity = p.intensity||2; }
  } else {
    const p = WRITE_PRESETS.find(x=>x.id===v);
    if(p){ d.tags = p.tags.slice(); d.intensity = p.intensity; }
  }
  refreshWsUI();
}
// 词库管理弹窗：系统项 note 可改 / 自定义项可增删改 / 收藏可删 / 恢复默认
function openStyleLibPanel(){
  closeStyleLibPanel();
  const cfg = getCfg();
  if(!cfg.styleCustom) cfg.styleCustom = { notes:{}, added:[], removed:[], comboRemoved:[] };
  const lib = writeStyleLib();
  const CAT_LABEL = { '语言质感':'① 语言质感', '情绪与张力':'② 情绪与张力', '节奏与网感':'③ 节奏与网感', '叙事技法':'④ 叙事技法', '台词设计':'⑤ 台词设计', custom:'⭐ 我的自定义' };
  const groups = Object.keys(CAT_LABEL);
  const notes = cfg.styleCustom.notes || {};
  // v10.20 管理面板：按五大类文风分组、默认折叠、点击展开
  const groupHtml = groups.map(g=>{
    const its = lib.filter(s=>(s.cat||'element')===g);
    return `<div class="ws-lib-group ws-lib-fold">
      <div class="ws-lib-fold-t" data-lib-fold="${g}" role="button" tabindex="0" title="展开/收起">
        <span>${CAT_LABEL[g]}${its.length?`（${its.length}）`:'（空）'}</span><span class="sc-fold-ico">▸</span>
      </div>
      <div class="ws-lib-fold-b" hidden>
        ${its.map(s=>`
        <div class="ws-lib-item">
          <div class="ws-lib-name">${esc(s.name)}${notes[s.id]?'<span class="ws-changed">已改</span>':''}${s.custom?'<span class="ws-custom">自定义</span>':''}</div>
          <textarea class="ws-lib-note" data-lib-note="${s.id}" rows="2" maxlength="500" placeholder="指令文本（≤500字；可用 写法:/避免:/自查: 三行写配方）">${esc(s.note||'')}</textarea>
          <div class="ws-lib-tools">
            ${s.custom?`<button type="button" class="btn small ghost" data-lib-del="${s.id}" title="删除该自定义词条">🗑 删除</button>`:`<button type="button" class="btn small ghost" data-lib-hide="${s.id}" title="从选择中移除该词条（「恢复默认」可还原）">🚫 停用</button>`}
          </div>
        </div>`).join('')}
        ${its.length?'':`<p class="muted" style="margin:4px 0">该组暂无词条：回到写作风格卡片点该组「＋」新建。</p>`}
      </div>
    </div>`;
  }).join('');
  const mine = (Array.isArray(cfg.stylePresets)?cfg.stylePresets:[]).map((p,i)=>`
    <div class="ws-lib-item">
      <div class="ws-lib-name">⭐ ${esc(p.name||'未命名')}</div>
      <span class="muted" style="font-size:11px">${(p.tags||[]).map(id=>{const s=writeStyleById(id); return s?s.name:id;}).join('+')||'无'} · ${['','轻','中','重'][p.intensity]||'中'}</span>
      <button type="button" class="btn small ghost del" data-sp-del="${i}">删</button>
    </div>`).join('') || '<p class="muted">暂无收藏。</p>';
  // v10.50 全部配方查看：内置🎬 + 我的配方🏷 + AI配方（availableCombos 已合并），展示完整原始信息
  const combos_ = availableCombos();
  const combosHtml = combos_.length ? combos_.map(c=>`
    <div class="ws-lib-item">
      <div class="ws-lib-name">${c.custom?'🏷':'🎬'} ${esc(c.name||'未命名')}</div>
      <div class="ws-lib-note" style="white-space:pre-wrap;margin:2px 0 4px">${esc(c.desc||'')}</div>
      ${c.why?`<div class="ws-lib-why">💡 为何这样选：${esc(wiseWhyText(c.why))}</div>`:''}
      <span class="muted" style="font-size:11px">词条：${(c.tags||[]).map(id=>{const s=writeStyleById(id); return s?s.name:id;}).join(' + ')||'无'}</span>
    </div>`).join('') : '<p class="muted">暂无配方。</p>';
  const ov = document.createElement('div'); ov.id='wsLibPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>⚙️ 写作风格管理</b>
        <span style="display:flex;gap:6px">
          <button class="btn small ghost" data-lib-read>📖 阅读</button>
          <button class="btn small ghost" data-lib-reset>恢复默认</button>
          <button class="gs-x" data-lib-close>✕</button>
        </span></div>
      <div class="cv-body">
        <div class="ws-lib-group ws-lib-fold">
          <div class="ws-lib-fold-t" data-lib-fold="combos" role="button" tabindex="0" title="展开/收起">
            <span>🧪 全部配方（${combos_.length}）</span><span class="sc-fold-ico">▾</span>
          </div>
          <div class="ws-lib-fold-b">${combosHtml}</div>
        </div>
        <div class="cv-div">「全部配方」为只读查看区（名称/说明/所含词条）；需新增或删除配方请回到写作风格卡片操作。下方每组词条均可修改指令（打"已改"标记）、可停用内置项（🚫）、可删除自定义项（🗑）；内置项被停用后由「恢复默认」一并还原；「恢复默认」清空全部词库改动。改动即时生效。</div>
        ${groupHtml}
        <div class="ws-lib-group ws-lib-fold">
          <div class="ws-lib-fold-t" data-lib-fold="mine" role="button" tabindex="0" title="展开/收起">
            <span>⭐ 我的收藏</span><span class="sc-fold-ico">▸</span>
          </div>
          <div class="ws-lib-fold-b" hidden>${mine}</div>
        </div>
      </div>
      <div class="ws-lib-foot">
        <button type="button" class="btn small ghost" data-lib-export>⬇ 导出</button>
        <button type="button" class="btn small ghost" data-lib-import>⬆ 导入</button>
        <input type="file" id="wsLibImportFile" accept=".json,application/json" hidden />
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-lib-close]').onclick = closeStyleLibPanel;
  ov.querySelector('[data-lib-read]').onclick = () => openStyleLibReader();
  // v10.32 底部工具条：导出整套；导入触发隐藏文件选择
  ov.querySelector('[data-lib-export]').onclick = exportWsStyleBundle;
  ov.querySelector('[data-lib-import]').onclick = ()=>{ const f=$('#wsLibImportFile'); if(f) f.click(); };
  const wlImp = ov.querySelector('#wsLibImportFile'); if(wlImp) wlImp.onchange = e=>{ const file=e.target.files && e.target.files[0]; if(file) importWsStyleBundle(file); e.target.value=''; };
  ov.addEventListener('click', e=>{ if(e.target===ov) closeStyleLibPanel(); });
  // v10.17 分组/我的收藏折叠开关（默认折叠，点击展开）
  ov.querySelectorAll('[data-lib-fold]').forEach(h=> h.onclick = ()=>{
    const b = h.nextElementSibling; if(!b) return;
    const ico = h.querySelector('.sc-fold-ico'); if(ico) ico.textContent = b.hidden ? '▾' : '▸';
    b.hidden = !b.hidden;
  });
  // note 编辑即存
  ov.querySelectorAll('[data-lib-note]').forEach(ta=>{
    ta.onchange = ()=>{
      const id = ta.dataset.libNote;
      const v = ta.value.trim().slice(0,500);
      if(v) cfg.styleCustom.notes[id] = v; else delete cfg.styleCustom.notes[id];
      saveCfg(cfg);
      // 就近更新「已改」标记（不整层重建，避免打断编辑/丢焦点）
      const it = ta.closest('.ws-lib-item'); const nm = it && it.querySelector('.ws-lib-name');
      if(nm){
        let badge = nm.querySelector('.ws-changed');
        if(v){ if(!badge){ badge=document.createElement('span'); badge.className='ws-changed'; badge.textContent='已改'; nm.appendChild(badge); } }
        else if(badge) badge.remove();
      }
      toast('已保存指令');
    };
  });
  // 删除自定义项
  ov.querySelectorAll('[data-lib-del]').forEach(b=>{
    b.onclick = ()=>{
      cfg.styleCustom.added = (cfg.styleCustom.added||[]).filter(x=>x.id!==b.dataset.libDel);
      saveCfg(cfg); render(); toast('已删除自定义风格');
      closeStyleLibPanel(); openStyleLibPanel();   // 立即刷新面板，删除项即时消失
    };
  });
  // v10.19 停用系统词条：加入 removed（从选择中移除；「恢复默认」可还原）
  ov.querySelectorAll('[data-lib-hide]').forEach(b=>{
    b.onclick = ()=>{
      if(!window.confirm('停用后该词条将从选择中移除，可通过「恢复默认」还原。确定停用？')) return;
      cfg.styleCustom.removed = cfg.styleCustom.removed || [];
      if(!cfg.styleCustom.removed.includes(b.dataset.libHide)) cfg.styleCustom.removed.push(b.dataset.libHide);
      saveCfg(cfg); render(); toast('已停用该词条');
      closeStyleLibPanel(); openStyleLibPanel();
    };
  });
  // 删除收藏
  ov.querySelectorAll('[data-sp-del]').forEach(b=>{
    b.onclick = ()=>{
      cfg.stylePresets.splice(+b.dataset.spDel,1);
      saveCfg(cfg); render(); toast('已删除收藏');
      closeStyleLibPanel(); openStyleLibPanel();   // 立即刷新面板，删除项即时消失
    };
  });
  // 恢复默认
  ov.querySelector('[data-lib-reset]').onclick = ()=>{
    if(!window.confirm('恢复默认将清空全部词库改动（自定义新增也会删除）。确定？')) return;
    cfg.styleCustom = { notes:{}, added:[], removed:[], comboRemoved:[] };
    saveCfg(cfg); render(); toast('已恢复默认词库');
    closeStyleLibPanel(); openStyleLibPanel();   // 立即重建面板：清掉「已改」标记、自定义项与编辑过的指令
  };
}
// v10.32 写作风格「词条+组合」整套导出：写 writing-styles-YYYYMMDD-HHmmss.json（覆盖式导入用）
function exportWsStyleBundle(){
  const c = getCfg().styleCustom || { notes:{}, added:[], removed:[], comboRemoved:[] };
  const styleCustom = {
    notes: c.notes && typeof c.notes==='object' ? c.notes : {},
    added: Array.isArray(c.added) ? c.added : [],
    removed: Array.isArray(c.removed) ? c.removed : [],
    comboRemoved: Array.isArray(c.comboRemoved) ? c.comboRemoved : [],
    customCombos: Array.isArray(c.customCombos) ? c.customCombos : []
  };
  const data = { ver:1, exportedAt:Date.now(), kind:'wsStyleBundle', styleCustom };
  const ts = new Date();
  const pad = n => String(n).padStart(2,'0');
  const stamp = `${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
  const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `writing-styles-${stamp}.json`; a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出词条与组合配方');
}
// v10.32 整套导入（覆盖式）：整体替换 styleCustom 的词条/组合定制字段，附结构校验与词条悬挂引用过滤
function importWsStyleBundle(file){
  const reader = new FileReader();
  reader.onload = ()=>{
    let data;
    try{ data = JSON.parse(reader.result); }
    catch(e){ toast('导入失败：文件不是合法 JSON'); return; }
    if(!data || typeof data !== 'object' || !data.styleCustom || typeof data.styleCustom !== 'object'){
      toast('导入失败：不是合法的写作风格配方 JSON'); return;
    }
    const sc = data.styleCustom;
    const strArr = v => Array.isArray(v) ? v.map(String).filter(x=> !!x) : [];
    const builtinIds = [].concat(WRITE_STYLES || []).map(s=> s && s.id).filter(Boolean);
    const libNowIds = writeStyleLib().map(s=> s.id);
    const cfg = getCfg(); cfg.styleCustom = cfg.styleCustom || { notes:{}, added:[], removed:[], comboRemoved:[] };
    // 词条 notes：覆盖式整体替换
    cfg.styleCustom.notes = (sc.notes && typeof sc.notes==='object') ? sc.notes : {};
    // added：逐项校验 id/name；group 归入五大类否则 custom 兜底
    cfg.styleCustom.added = (Array.isArray(sc.added) ? sc.added : [])
      .filter(x=> x && x.id && x.name)
      .map(x=>({ id:String(x.id), group:['语言质感','情绪与张力','节奏与网感','叙事技法','台词设计'].includes(x.group)?x.group:'custom', name:String(x.name), note:String(x.note||''), demo:x.demo?String(x.demo):'', seal:(x.seal===undefined?0:x.seal), warning:x.warning?String(x.warning):'' }));
    // removed：仅保留存在于内置词条中的 id
    cfg.styleCustom.removed = strArr(sc.removed).filter(id=> builtinIds.includes(id));
    // comboRemoved：仅保留存在于内置组合中的 id
    cfg.styleCustom.comboRemoved = strArr(sc.comboRemoved).filter(id=> (WRITE_COMBOS||[]).some(c=> c.id === id));
    // customCombos：保留合法条目，tags 过滤为当前库内仍存在的词条 id
    cfg.styleCustom.customCombos = (Array.isArray(sc.customCombos) ? sc.customCombos : [])
      .filter(x=> x && x.id && x.name)
      .map(x=>({ id:String(x.id), name:String(x.name), desc:String(x.desc||''), tags:strArr(x.tags).filter(id=> libNowIds.includes(id)) }));
    saveCfg(cfg); render();
    toast('已导入词条与组合配方');
    closeStyleLibPanel(); openStyleLibPanel();   // 重建面板，导入内容立即可见
  };
  reader.readAsText(file);
}
function closeStyleLibPanel(){ const p=$('#wsLibPanel'); if(p) p.remove(); }

/* ---------- 写作风格配方 · 阅读视图（独立函数，复用 gs 浮层 + reader 排版） ---------- */
function openStyleLibReader(){
  closeStyleLibReader();
  // v10.55 方案B：阅读器仅展示五大类章节风格 + 我的自定义；过滤内置「标题风格(tone)/梗概风格(texture)」组（用户自定义旧数据已归入 element 组，不受影响）
  const lib = writeStyleLib().filter(s=> s.group !== 'tone' && s.group !== 'texture');
  const CAT_LABEL = { '语言质感':'① 语言质感', '情绪与张力':'② 情绪与张力', '节奏与网感':'③ 节奏与网感', '叙事技法':'④ 叙事技法', '台词设计':'⑤ 台词设计', custom:'⭐ 我的自定义' };
  const groups = {};
  lib.forEach(s=>{
    const cat = s.cat || 'custom';
    if(!groups[cat]) groups[cat] = [];
    groups[cat].push(s);
  });
  const order = Object.keys(CAT_LABEL).filter(g=>groups[g] && groups[g].length);
  (Object.keys(groups).filter(g=>!Object.prototype.hasOwnProperty.call(CAT_LABEL,g))).forEach(g=>order.push(g));
  let html = order.map(cat=>{
    let catHtml = `<h2>${CAT_LABEL[cat] || cat}（${groups[cat].length}）</h2>`;
    catHtml += groups[cat].map(s=>`
      <div class="style-recipe">
        <h3>【${esc(s.name)}】${s.custom?'<span class="ws-custom">自定义</span>':''}</h3>
        <p><strong>指令：</strong>${esc(s.note||'')}</p>
        ${s.tips && s.tips.length ? `<p><strong>写法：</strong>${s.tips.map((t,i)=>`${i+1}. ${esc(t)}`).join('；')}</p>` : ''}
        ${s.avoid && s.avoid.length ? `<p><strong>避免：</strong>${s.avoid.map(a=>'✗ '+esc(a)).join('；')}</p>` : ''}
        ${s.check && s.check.length ? `<p><strong>自查：</strong>${s.check.map(c=>'□ '+esc(c)).join('　')}</p>` : ''}
        ${s.demo ? `<p><strong>示例：</strong>「${esc(s.demo)}」</p>` : ''}
      </div>`).join('');
    return catHtml;
  }).join('');
  const ov = document.createElement('div'); ov.id='wsLibReader'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal reader-modal">
      <div class="gs-modal-head"><b>📖 写作风格配方大全</b>
        <span style="display:flex;gap:6px">
          <button class="btn small ghost" data-lib-read-copy>复制全文</button>
          <button class="gs-x" data-lib-read-close>✕</button>
        </span></div>
      <div class="cv-body"><div class="reader-body">${html}</div></div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-lib-read-close]').onclick = closeStyleLibReader;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeStyleLibReader(); });
  // 复制全文：生成纯文本配方，按分组/词条排列
  ov.querySelector('[data-lib-read-copy]').onclick = ()=>{
    let txt = '写作风格配方大全\n' + '='.repeat(24) + '\n\n';
    order.forEach(cat=>{
      txt += `${CAT_LABEL[cat] || cat}（${groups[cat].length}）\n${'-'.repeat(20)}\n`;
      groups[cat].forEach(s=>{
        txt += `\n【${s.name}】${s.custom?'[自定义]':''}\n`;
        if(s.note) txt += `指令：${s.note}\n`;
        if(s.tips && s.tips.length) txt += `写法：${s.tips.map((t,i)=>`${i+1}. ${t}`).join('；')}\n`;
        if(s.avoid && s.avoid.length) txt += `避免：✗ ${s.avoid.join('；✗ ')}\n`;
        if(s.check && s.check.length) txt += `自查：${s.check.map(c=>`□ ${c}`).join('　')}\n`;
        if(s.demo) txt += `示例：「${s.demo}」\n`;
      });
      txt += '\n';
    });
    copyText(txt);
  };
}
function closeStyleLibReader(){ const p=$('#wsLibReader'); if(p) p.remove(); }

function viewStory(){
  if(!state.outline){
    const homeSub = isLong()
      ? `用几句话描述你的长篇构想（世界观、主角、核心冲突都行）。AI 会扩写成全书 ${chapterCountHint()} 大纲，之后按「生成章节」逐步写完。`
      : '用几句话描述你的点子（世界观、主角、核心冲突都行）。AI 会扩写成完整故事大纲与章节。';
    return CYBER_HOME_GRID + `
    <div class="card">
      <h3>① 输入故事构想</h3>
      <p class="sub">${homeSub}</p>
      <div class="idea-row">
        <textarea id="ideaInput" placeholder="">${esc(state.idea)}</textarea>
      </div>
      <div class="btn-row">
        <button id="btnPolishIdea" class="btn ghost" title="把构想优化成结构化高质量版本">✨ 优化构想</button>
        <label class="pol-multi" title="构想不完整时，生成 2-6 份不同方向的构想供选择"><input type="checkbox" id="chkPolishMulti" checked> 多方案</label>
      </div>
      <div id="polishBox" class="pol-box" style="display:none">
        <div class="pol-head"><b>✨ 优化稿（点「采用此方案」即导入上方构想输入框）</b>
          <span class="pol-tools">
            <button id="btnPolishDiscard" class="btn small ghost">✕ 收起</button>
          </span>
        </div>
        <div id="polishCards" class="pol-cards"></div>
      </div>
      ${ polishKeepBar() }
      ${ isLong() ? '' : specPickerHtml() }
      ${ isLong() ? loglineRangeHtml() : '' }
      <div class="btn-row">
        <button id="btnGenOutline" class="btn primary block">${isLong()?'📚 生成长篇大纲':'✨ 生成故事大纲'}</button>
      </div>
      <p id="outlineStatus" class="status"></p>
    </div>`;
  }
  // 大纲已生成
  const o = state.outline;
  let html = `
    ${ origIdeaCard() }
    <div class="card">
      <div class="card-head-row">
        <h3 style="margin:0">📋 故事大纲</h3>
        ${hasOutlineHistory()?`<button type="button" class="btn small ghost" id="btnOutlineHist" title="查看并恢复历史大纲版本">📚 大纲版本(${outlineHistoryCount()})</button>`:''}
        ${titleManagerHtml()}
      </div>
      <div class="so-fold-head" data-so-toggle role="button" tabindex="0" title="展开/收起小说简介">
        <span class="so-fold">${state.soCollapsed?'▸':'▾'}</span><b>📌 小说简介</b>
      </div>
      <p class="sub so-logline" ${state.soCollapsed?'hidden':''}>${esc(o.logline||'')}</p>
      ${ isLong() ? anchorEditHtml() : '' }
      ${ isLong() ? structureCardHtml() : '' }
      ${ chapterTitleBlock() }
      ${ isLong() ? aiRecipeCard() : '' }   <!-- v11 卡片顺序：AI配方助手 移到 章节标题 与 全书规划师 之间 -->
      ${ isLong() ? styleContractCardHtml() : '' }
      ${ writeStyleCard() }
      ${ state.outlineConfirmed ? `
        ${ isLong() ? chapterPlanBlock() : '' }
        ${ isLong() ? glossaryCardHtml() : '' }
        ${ isLong() ? factCardHtml() : '' }
        ${ isLong() ? `<div class="btn-row" style="margin-top:8px">
          <label class="long-jump"><span>跳到章节：</span>
          <select id="longJump"><option value="">— 选择章节阅读 —</option>${state.chapters.map((c,i)=>`<option value="${i}">第${i+1}章 ${esc(cleanChapterTitle(c.title))}</option>`).join('')}</select></label>
        </div>` : '' }
        ${ isLong() ? rollingSummaryCardHtml() : '' }
        ${ isLong() ? qualityReportCardHtml() : '' }
        <div class="ch-toolbar">
          <span class="ch-toolbar-t">📚 章节列表（共 ${state.chapters.length} 章，已生成 ${state.chapters.filter(c=>c.content && String(c.content).trim()).length} 章）</span>
        </div>
        <div id="chaptersWrap"></div>
        ${ isLong() ? fixQueueCardHtml() : '' }
        <div class="btn-row" style="margin-top:12px">
          ${ isLong() ? `<span class="multi-gen">
            <span class="multi-gen-main">
              <button id="btnGenMany" class="btn blue">⚡ 批量生成多章</button>
            </span>
            <span class="gen-stepper">
              <button type="button" class="gen-step" data-gen-dec title="减少章数">−</button>
              <output id="genCountOut" class="gen-count-out" aria-live="polite">${genBatchN}</output><span class="gen-unit">章</span>
              <button type="button" class="gen-step" data-gen-inc title="增加章数">＋</button>
            </span>
          </span>` : `<button id="btnGenAllChapters" class="btn primary">⚡ 一键生成全部章节</button><button id="btnReOutline" class="btn ghost">重生成大纲</button>` }
        </div>
        ${ isLong() ? `<div class="range-gen">
          <button id="btnRangeGen" class="btn blue">⚡ 区间生成</button>
          <label class="rg-label">从第
            <input id="rgStart" type="number" min="1" max="${state.chapters.length}" value="1" class="rg-input">
          章</label>
          <span class="muted" style="font-size:12px">到第</span>
          <label class="rg-label">
            <input id="rgEnd" type="number" min="1" max="${state.chapters.length}" value="2" class="rg-input">
          章</label>
          <span id="rgStatus" class="muted" style="font-size:11px"></span>
        </div>` : '' }
        <p id="chStatus" class="status"></p>
        <p id="bgTaskIndicator" class="status muted" style="display:none;font-size:12px;margin-top:2px"></p>
        ${ isLong() ? `<div class="long-progress"></div>` : '' }
        <div id="wcTotal" class="wc-total hidden"></div>
        <div class="cyber-pad hidden"></div>
      ` : `
        <div class="btn-row">
          <button id="btnConfirmOutline" class="btn primary">✓ 确认大纲，进入写正文</button>
          <button id="btnReOutline" class="btn ghost">重生成</button>
        </div>
      ` }
    </div>`;
  return html;
}

/* ==================== 4.6 Plus 新增卡片（第 2 章） ==================== */

// —— 2.1 结构骨架卡 ——
function structureCardHtml(){
  const o = state.outline || {};
  const s = o.structure || {};
  const acts = s.acts || {};
  const actRows = ['act1','act2','act3'].map(k => {
    const a = acts[k] || {};
    const start = a.start || '';
    const end = a.end || '';
    const mission = a.mission || '';
    const must = Array.isArray(a.mustHappen) ? a.mustHappen : [];
    const mustList = must.map((m,i)=>`
      <div class="st-mh-row">
        <input type="text" class="st-mh-in" data-st-mh="${k}:${i}" value="${esc(m)}" placeholder="本幕必须发生的具体事件">
        <button type="button" class="btn small ghost" data-st-mh-del="${k}:${i}">✕</button>
      </div>`).join('');
    return `
      <div class="st-act" data-st-act="${k}">
        <div class="st-act-head">${k.replace('act','第')}幕 · 第 ${start}—${end} 章</div>
        <label class="st-field"><span>任务</span><input type="text" data-st-mission="${k}" value="${esc(mission)}" placeholder="本幕核心任务"></label>
        <div class="st-mh">
          <div class="st-mh-head">必须事件 <button type="button" class="btn small ghost" data-st-mh-add="${k}">＋ 添加</button></div>
          ${mustList || '<span class="muted">暂无必须事件</span>'}
        </div>
      </div>`;
  }).join('');

  return `<div class="card st-card${state.stCollapsed?' st-collapsed':''}">
    <div class="st-head" data-st-fold role="button" tabindex="0" title="展开/收起">
      <h3 style="margin:0">🏗️ 结构骨架</h3>
      <span class="sc-fold-ico">${state.stCollapsed?'▸':'▾'}</span>
    </div>
    <div class="st-body" ${state.stCollapsed?'hidden':''}>
      <label class="st-field"><span>全书主线</span><textarea id="stMainLine" rows="2" placeholder="全书唯一主线/核心走向">${esc(s.mainLine||'')}</textarea></label>
      <label class="st-field"><span>汇合/逆转点</span><input type="text" id="stPivot" value="${esc(s.pivotPlan||'')}" placeholder="汇合/大逆转所在章"></label>
      <div class="st-acts">${actRows}</div>
      <p class="muted" style="margin:6px 0 0;font-size:11px">主线与必须事件会注入标题 AI 与规划师 AI；修改后即时保存。</p>
    </div>
  </div>`;
}

function bindStructureCard(){
  const head = $('[data-st-fold]');
  if(head) head.onclick = ()=>{
    state.stCollapsed = !state.stCollapsed; persist();
    const body = $('.st-body'); if(body) body.hidden = state.stCollapsed;
    const ico = head.querySelector('.sc-fold-ico'); if(ico) ico.textContent = state.stCollapsed?'▸':'▾';
  };
  const s = state.outline && state.outline.structure; if(!s) return;

  // 主线 / 汇合点
  const ml = $('#stMainLine');
  if(ml) ml.onchange = ()=>{ s.mainLine = ml.value.trim(); persist(); toast('全书主线已更新'); };
  const pv = $('#stPivot');
  if(pv) pv.onchange = ()=>{ s.pivotPlan = pv.value.trim(); persist(); toast('汇合/逆转点已更新'); };

  // 幕任务
  $$('[data-st-mission]').forEach(inp=>{
    inp.onchange = ()=>{
      const k = inp.dataset.stMission;
      if(!s.acts[k]) s.acts[k] = {};
      s.acts[k].mission = inp.value.trim(); persist();
    };
  });

  // mustHappen 增删改
  $$('[data-st-mh]').forEach(inp=>{
    inp.onchange = ()=>{
      const [k,i] = inp.dataset.stMh.split(':');
      if(!s.acts[k] || !Array.isArray(s.acts[k].mustHappen)) return;
      s.acts[k].mustHappen[+i] = inp.value.trim(); persist();
    };
  });
  $$('[data-st-mh-del]').forEach(btn=>{
    btn.onclick = ()=>{
      const [k,i] = btn.dataset.stMhDel.split(':');
      if(!s.acts[k] || !Array.isArray(s.acts[k].mustHappen)) return;
      s.acts[k].mustHappen.splice(+i,1); persist(); render();
    };
  });
  $$('[data-st-mh-add]').forEach(btn=>{
    btn.onclick = ()=>{
      const k = btn.dataset.stMhAdd;
      if(!s.acts[k]) s.acts[k] = { start:'', end:'', mission:'', mustHappen:[] };
      s.acts[k].mustHappen.push(''); persist(); render();
    };
  });
}

// —— 2.3 风格契约卡 ——
function styleContractCardHtml(){
  // 显式回退开关：用户「清除契约」后关闭自动回退，使契约卡真实显示「未设定」；重新提取/确认风格时恢复
  const sc = state.styleContract || (state._scFallbackOff ? null : buildStyleFingerprintFromConfirmed());
  const hasConfirmed = state.chapters.some(c => c && c._styleConfirmed);
  const stats = sc ? computeCurrentStyleStats() : null;
  return `<div class="card sc-card${state.scCollapsed?' sc-collapsed':''}">
    <div class="sc-head" data-sc-fold role="button" tabindex="0" title="展开/收起">
      <h3 style="margin:0">🎨 风格契约</h3>
      <span class="pill ${sc?'tag-ok':'tag-warn'}">${sc?'已生效':'未设定'}</span>
      <button type="button" class="btn small ghost" data-sc-hist style="margin-left:auto" ${(state._styleHistory||[]).length?'':'disabled'} title="查看风格契约 / 风格指纹变更历史（每次确认、提取、设定、清除自动留档）">🕘 历史</button>
      <span class="sc-fold-ico">${state.scCollapsed?'▸':'▾'}</span>
    </div>
    <div class="sc-body" ${state.scCollapsed?'hidden':''}>
      ${sc ? `
        <div class="sc-grid">
          <div><b>平均句长</b><span>${sc.sentenceAvg} ± ${Math.round((sc.sentenceTolerance||0.2)*100)}%</span></div>
          <div><b>对话占比</b><span>${Math.round((sc.dialogueRatio||0)*100)}% ± ${Math.round((sc.dialogueTolerance||0.1)*100)}%</span></div>
          <div><b>禁用词</b><span>${(sc.forbiddenPhrases||[]).join('、') || '无'}</span></div>
          <div><b>偏好转场</b><span>${(sc.preferredTransitions||[]).join('、') || '无'}</span></div>
        </div>
        <p class="muted" style="font-size:11px">${sc.rhythmNote || ''}</p>
        ${stats ? `
          <div class="sc-diff">
            <div><b>当前全文实际</b> 句长 ${stats.avgLen.toFixed(1)} / 对话 ${(stats.diaRatio*100).toFixed(1)}%</div>
            ${stats.avgOk && stats.diaOk ? '<span class="pill tag-ok">✓ 符合契约</span>' : '<span class="pill tag-warn">⚠ 偏离契约</span>'}
          </div>
        ` : ''}
        <div class="btn-row">
          <button type="button" class="btn small ghost" data-sc-extract>🔄 从确认章节重新提取</button>
          <button type="button" class="btn small ghost" data-sc-clear>✕ 清除契约</button>
        </div>
      ` : `
        <p class="sub">尚未设定风格契约。AI 配方助手可选用一个带 styleContract 的配方，或点下方按钮从已确认章节提取。</p>
        <div class="btn-row">
          <button type="button" class="btn small primary" data-sc-extract ${hasConfirmed?'':'disabled'}>从已确认章节提取</button>
        </div>
      `}
    </div>
  </div>`;
}

function bindStyleContractCard(){
  const head = $('[data-sc-fold]');
  if(head) head.onclick = ()=>{
    state.scCollapsed = !state.scCollapsed; persist();
    const body = $('.sc-body'); if(body) body.hidden = state.scCollapsed;
    const ico = head.querySelector('.sc-fold-ico'); if(ico) ico.textContent = state.scCollapsed?'▸':'▾';
  };
  const hist = $('[data-sc-hist]');
  if(hist) hist.onclick = (e)=>{ e.stopPropagation(); e.preventDefault(); openStyleHistoryPanel(); };
  const ext = $('[data-sc-extract]');
  if(ext) ext.onclick = ()=>{
    const fp = buildStyleFingerprintFromConfirmed();
    if(!fp){ toast('没有已确认风格的章节，无法提取'); return; }
    state.styleContract = fp; state._scFallbackOff = false; pushStyleHistory('从确认章节提取风格契约'); persist(); render(); toast('已从确认章节提取风格契约');
  };
  const clr = $('[data-sc-clear]');
  if(clr) clr.onclick = ()=>{
    if(!confirm('清除风格契约后，正文 AI 不再受量化约束。清除后契约卡将显示「未设定」，不再自动回退提取，是否继续？')) return;
    state.styleContract = null;
    state._scFallbackOff = true;               // 关闭自动回退，使契约卡真实显示「未设定」
    (state.chapters||[]).forEach(c => { if(c) c._styleConfirmed = false; });   // 同步清空确认来源
    pushStyleHistory('清除风格契约（含确认来源，关闭自动回退）');
    persist(); render(); toast('已清除风格契约（不再自动回退）');
  };
}

function computeCurrentStyleStats(){
  const texts = state.chapters.filter(c=>c && c.content).map(c=>c.content).join('\n');
  if(!texts) return null;
  const sc = state.styleContract;
  const avgLen = avgSentenceLength(texts);
  const diaRatio = dialogueRatio(texts);
  return {
    avgLen,
    diaRatio,
    avgOk: Math.abs(avgLen - sc.sentenceAvg) <= sc.sentenceAvg * (sc.sentenceTolerance||0.2),
    diaOk: Math.abs(diaRatio - sc.dialogueRatio) <= (sc.dialogueTolerance||0.1)
  };
}

// —— 2.4 事实与一致性看板 ——
function factCardHtml(){
  const fc = (state.outline && state.outline._factCard) || { characters:{}, timeline:[], unresolvedHooks:[], lastScene:'' };
  const chars = Object.entries(fc.characters || {}).map(([name, st])=>`
    <div class="fc-char-row">
      <input type="text" class="fc-name" data-fc-char-name="${esc(name)}" value="${esc(name)}" placeholder="人名">
      <input type="text" class="fc-state" data-fc-char-state="${esc(name)}" value="${esc(st.state||'')}" placeholder="当前状态">
      <input type="text" class="fc-loc" data-fc-char-loc="${esc(name)}" value="${esc(st.location||'')}" placeholder="所在地点">
      <input type="text" class="fc-emo" data-fc-char-emo="${esc(name)}" value="${esc(st.emotion||'')}" placeholder="情绪">
    </div>
  `).join('');
  const timeline = (fc.timeline || []).slice(-10).reverse().map(t=>`
    <div class="fc-tl-row">
      <span class="pill">第 ${t.ch+1} 章</span>
      <span>${esc(t.event||'')}</span>
    </div>
  `).join('');
  const hooks = (fc.unresolvedHooks || []).map((h,i)=>`
    <div class="fc-hook-row">
      <span class="pill">第 ${h.ch+1} 章</span>
      <input type="text" data-fc-hook="${i}" value="${esc(h.text||'')}" placeholder="伏笔内容">
      <button type="button" class="btn small ghost" data-fc-hook-resolve="${i}">✓ 已收束</button>
    </div>
  `).join('');

  return `<div class="card fc-card${state.fcCollapsed?' fc-collapsed':''}">
    <div class="fc-head" data-fc-fold role="button" tabindex="0" title="展开/收起">
      <h3 style="margin:0">🧩 事实与一致性看板</h3>
      <span class="sc-fold-ico">${state.fcCollapsed?'▸':'▾'}</span>
    </div>
    <div class="fc-body" ${state.fcCollapsed?'hidden':''}>
      <div class="fc-sec">
        <div class="fc-sec-head">人物状态 <button type="button" class="btn small ghost" data-fc-char-add>＋ 添加</button></div>
        ${chars || '<span class="muted">暂无人物状态，可手动添加或在正文生成后自动提取</span>'}
      </div>
      <div class="fc-sec">
        <div class="fc-sec-head">最近时间线</div>
        ${timeline || '<span class="muted">暂无时间线</span>'}
      </div>
      <div class="fc-sec">
        <div class="fc-sec-head">未收束伏笔</div>
        ${hooks || '<span class="muted">暂无未收束伏笔</span>'}
      </div>
      <label class="fc-field"><span>最新场景</span><input type="text" id="fcLastScene" value="${esc(fc.lastScene||'')}" placeholder="最后一章结束时的场景/环境"></label>
      <p class="muted" style="font-size:11px">看板内容可由正文 AI 生成后自动更新，也可手动修正。未收束伏笔会注入后续章节提示词。</p>
    </div>
  </div>`;
}

function bindFactCard(){
  const head = $('[data-fc-fold]');
  if(head) head.onclick = ()=>{
    state.fcCollapsed = !state.fcCollapsed; persist();
    const body = $('.fc-body'); if(body) body.hidden = state.fcCollapsed;
    const ico = head.querySelector('.sc-fold-ico'); if(ico) ico.textContent = state.fcCollapsed?'▸':'▾';
  };
  const o = state.outline; if(!o) return;
  o._factCard = o._factCard || { characters:{}, timeline:[], unresolvedHooks:[], lastScene:'' };
  const fc = o._factCard;

  // 添加人物
  const add = $('[data-fc-char-add]');
  if(add) add.onclick = ()=>{
    const name = prompt('人物名：'); if(!name) return;
    fc.characters[name] = { state:'', location:'', emotion:'' }; persist(); render();
  };
  // 编辑人物
  $$('[data-fc-char-state],[data-fc-char-loc],[data-fc-char-emo]').forEach(inp=>{
    inp.onchange = ()=>{
      const name = inp.dataset.fcCharState || inp.dataset.fcCharLoc || inp.dataset.fcCharEmo;
      if(!fc.characters[name]) return;
      if(inp.dataset.fcCharState) fc.characters[name].state = inp.value.trim();
      if(inp.dataset.fcCharLoc) fc.characters[name].location = inp.value.trim();
      if(inp.dataset.fcCharEmo) fc.characters[name].emotion = inp.value.trim();
      persist();
    };
  });
  // 编辑伏笔
  $$('[data-fc-hook]').forEach(inp=>{
    inp.onchange = ()=>{
      const i = +inp.dataset.fcHook;
      if(!fc.unresolvedHooks[i]) return;
      fc.unresolvedHooks[i].text = inp.value.trim(); persist();
    };
  });
  // 收束伏笔
  $$('[data-fc-hook-resolve]').forEach(btn=>{
    btn.onclick = ()=>{
      const i = +btn.dataset.fcHookResolve;
      const hook = fc.unresolvedHooks[i];
      if(hook) hook.resolvedIn = 'manual';
      fc.unresolvedHooks.splice(i,1); persist(); render();
    };
  });
  // 最新场景
  const ls = $('#fcLastScene');
  if(ls) ls.onchange = ()=>{ fc.lastScene = ls.value.trim(); persist(); };
}

// 4.8 旗舰版（板块三-1）：伏笔生命周期账本更新。i 为 0 基章索引，fs 来自副线审计师输出。
function updateForeshadowLedger(i, fs){
  const o = state.outline; if(!o) return;
  const ledger = o._foreshadowLedger = o._foreshadowLedger || { planted:[], resolved:[], overdue:[] };
  const total = (o.chapters && o.chapters.length) || 1;
  // 新埋设
  (fs.planted || []).forEach(p => {
    if(!p.text) return;
    const exists = ledger.planted.find(x => x.text === p.text);
    if(!exists){
      ledger.planted.push({
        id: 'fs_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
        text: p.text,
        chPlanted: i,
        expectedCh: Number.isFinite(p.expectedCh) && p.expectedCh > i ? p.expectedCh : Math.min(total, Math.round(i + total * 0.25))
      });
    }
  });
  // 已回收：从未埋设的也按 text 记录，避免重复报警
  (fs.resolved || []).forEach(r => {
    const t = String(r).trim(); if(!t) return;
    const p = ledger.planted.find(x => x.text === t);
    if(p && !ledger.resolved.some(x => x.text === t)){
      ledger.resolved.push({ id:p.id, text:t, chPlanted:p.chPlanted, chResolved:i });
      ledger.planted = ledger.planted.filter(x => x.text !== t);
    } else if(!ledger.resolved.some(x => x.text === t)){
      ledger.resolved.push({ text:t, chResolved:i });
    }
  });
  // 逾期：当前章号超过 expectedCh 仍未回收
  ledger.overdue = ledger.planted.filter(p => i >= p.expectedCh && !ledger.resolved.some(r => r.id === p.id));
  persist();
}
// 新卡片界面：伏笔看板操作辅助函数
function resolveForeshadow(idx, ch){
  const o=state.outline; if(!o) return;
  const ledger=o._foreshadowLedger=o._foreshadowLedger||{planted:[],resolved:[],overdue:[]};
  const p=ledger.planted[idx]; if(!p) return;
  ledger.resolved.push({id:p.id,text:p.text,chPlanted:p.chPlanted,chResolved:ch});
  ledger.planted=ledger.planted.filter((_,i)=>i!==idx);
  ledger.overdue=ledger.planted.filter(x=>ch>=x.expectedCh);
  persist(); toast('已标记伏笔回收');
}
function delayForeshadow(idx){
  const o=state.outline; if(!o) return;
  const ledger=o._foreshadowLedger=o._foreshadowLedger||{planted:[],resolved:[],overdue:[]};
  const p=ledger.planted[idx]; if(!p) return;
  const total=(o.chapters&&o.chapters.length)||1;
  const ext=Math.max(1,Math.round(total*0.1));
  p.expectedCh=Math.min(total-1,p.expectedCh+ext);
  ledger.overdue=ledger.planted.filter(x=>p.chPlanted>=x.expectedCh);
  persist(); toast('已延后回收预期');
}
function deleteForeshadow(idx){
  const o=state.outline; if(!o) return;
  const ledger=o._foreshadowLedger=o._foreshadowLedger||{planted:[],resolved:[],overdue:[]};
  ledger.planted=ledger.planted.filter((_,i)=>i!==idx);
  ledger.overdue=ledger.planted.filter(x=>x.chPlanted>=x.expectedCh);
  persist(); toast('已删除伏笔');
}
function resolveOverdueForeshadow(idx){
  const o=state.outline; if(!o) return;
  const ledger=o._foreshadowLedger=o._foreshadowLedger||{planted:[],resolved:[],overdue:[]};
  const p=ledger.overdue[idx]; if(!p) return;
  ledger.resolved.push({id:p.id,text:p.text,chPlanted:p.chPlanted,chResolved:state.chapters.length-1});
  ledger.planted=ledger.planted.filter(x=>x.id!==p.id);
  ledger.overdue=ledger.overdue.filter((_,i)=>i!==idx);
  persist(); toast('已回收逾期伏笔');
}
function applySandboxBranch(point, branchId){
  const sb=(state._branchSandboxes||[]).find(x=>x.point===point);
  if(!sb) return;
  const branch=(sb.branches||[]).find(b=>(b.id||'')===branchId);
  if(!branch) return;
  sb.chosen=branchId;
  updateSandboxHistory(point, sb.branches, branchId);
  const o=state.outline; if(!o) return;
  const ledger=o._foreshadowLedger=o._foreshadowLedger||{planted:[],resolved:[],overdue:[]};
  const total=(o.chapters&&o.chapters.length)||1;
  (branch.risks||[]).forEach((r,idx)=>{
    const text=String(r).trim(); if(!text) return;
    if(!ledger.planted.some(x=>x.text===text)){
      ledger.planted.push({id:'sb_'+Date.now()+'_'+idx,text:text,chPlanted:point,expectedCh:Math.min(total-1,Math.round(point+total*0.2))});
    }
  });
  persist();
}
function updateSandboxHistory(point, branches, chosen){
  state._branchSandboxes=state._branchSandboxes||[];
  const idx=state._branchSandboxes.findIndex(x=>x.point===point);
  const rec={point,branches:branches||[],chosen:chosen||''};
  if(idx>=0) state._branchSandboxes[idx]=rec; else state._branchSandboxes.push(rec);
  persist();
}
function updateFactCardFromChapter(i, text){
  const o = state.outline; if(!o) return;
  const fc = o._factCard = o._factCard || { characters:{}, timeline:[], unresolvedHooks:[], lastScene:'' };
  const plan = (o.chapterPlans && o.chapterPlans[i]) || {};
  // 时间线：按 ch 幂等去重，重写一章只保留最新摘要
  fc.timeline = fc.timeline || [];
  fc.timeline = fc.timeline.filter(x => x.ch !== i);
  fc.timeline.push({ ch:i, event:plan.summary || `第 ${i+1} 章正文` });
  if(fc.timeline.length > 50) fc.timeline = fc.timeline.slice(-50);
  // 伏笔：从 beats 的 foreshadowing 提取；已存在同名 hook 更新 plantedIn，不重复Push
  if(plan.beats) plan.beats.forEach(b => {
    (b.foreshadowing || []).forEach(h => {
      if(!h) return;
      const found = fc.unresolvedHooks.find(x => x.text === h);
      if(found){ found.plantedIn = i; return; }
      fc.unresolvedHooks.push({ ch:i, plantedIn:i, text:h, resolvedIn:null });
    });
  });
  persist();
}

// 4.8 旗舰版（板块三-3）：根据章节所处结构位置给出张力目标。
function getTargetTension(i){
  const o = state.outline;
  const acts = (o && o.structure && o.structure.acts) || {};
  const total = (o && o.chapters && o.chapters.length) || 1;
  const ratio = (i + 1) / total;
  let phase = 'act1';
  if(acts.act1 && acts.act2 && acts.act3){
    if(i + 1 <= acts.act1.end) phase = 'act1';
    else if(i + 1 <= acts.act2.end) phase = 'act2';
    else phase = 'act3';
  } else if(ratio > 0.75) phase = 'act3';
  else if(ratio > 0.35) phase = 'act2';
  const map = {
    act1: { phase:'第一幕（建立冲突）', external:4, internal:3, mystery:4 },
    act2: { phase:'第二幕（上升行动）', external:6, internal:5, mystery:6 },
    act3: { phase:'第三幕（高潮收束）', external:8, internal:7, mystery:7 }
  };
  const plan = (o && Array.isArray(o.chapterPlans) && o.chapterPlans[i]) || {};
  const hasClimax = (plan.beats || []).some(b => b.type === 'climax');
  const base = map[phase] || map.act2;
  if(hasClimax) base.external = Math.max(base.external, 9);
  return base;
}

// 4.8 旗舰版（板块三-3）：情节冲突强度实时评估，写入张力曲线。
async function scoreChapterTension(i, text){
  const o = state.outline; if(!o) return;
  const prev = state._tensionCurve && state._tensionCurve.length ? state._tensionCurve[state._tensionCurve.length-1] : null;
  const user = `【上一章张力参考】${prev ? `外在${prev.external}/内心${prev.internal}/信息差${prev.mystery}` : '（无）'}\n\n【本章正文（第 ${i+1} 章）】\n${text.slice(0, 12000)}`;
  try{
    const txt = unwrapAIResult(await callDeepSeek(TENSION_SCORE_SYS, user, {maxTokens: clampMaxTokens('json'), temperature: 0.3, topP: 0.5, taskKey:'audit'}));
    const j = parseJson(txt) || {};
    const clamp = n => Math.max(0, Math.min(10, Math.round(Number(n)||0)));
    const score = {
      ch: i,
      external: clamp(j.external),
      internal: clamp(j.internal),
      mystery: clamp(j.mystery),
      delta_vs_prev: Math.max(-10, Math.min(10, Math.round(Number(j.delta_vs_prev)||0)))
    };
    state._tensionCurve = state._tensionCurve || [];
    state._tensionCurve = state._tensionCurve.filter(x => x.ch !== i);
    state._tensionCurve.push(score);
    persist();
  }catch(e){ /* 静默失败 */ }
}

// —— 2.5 滚动摘要卡 ——
function rollingSummaryCardHtml(){
  const o = state.outline; if(!o) return '';
  const sums = (o._rollingSummaries || []).slice().sort((a,b)=>{
    const [a1] = a.key.split('-').map(Number);
    const [b1] = b.key.split('-').map(Number);
    return a1 - b1;
  });
  const rows = sums.map(s=>`
    <div class="rs-row">
      <span class="pill">第 ${s.key} 章</span>
      <span class="rs-text">${esc(s.text)}</span>
    </div>
  `).join('');
  return `<div class="card rs-card${state.rsCollapsed?' rs-collapsed':''}">
    <div class="rs-head" data-rs-fold role="button" tabindex="0" title="展开/收起">
      <h3 style="margin:0">📜 滚动摘要</h3>
      <span class="sc-fold-ico">${state.rsCollapsed?'▸':'▾'}</span>
    </div>
    <div class="rs-body" ${state.rsCollapsed?'hidden':''}>
      ${rows || '<span class="muted">暂无滚动摘要，批量生成正文后会自动生成</span>'}
      <div class="btn-row" style="margin-top:8px">
        <button type="button" class="btn small primary" data-rs-gen ${sums.length?'':'disabled'}>🔄 补齐缺失摘要</button>
        <button type="button" class="btn small ghost" data-rs-clear>清空摘要</button>
      </div>
      <p class="muted" style="font-size:11px">每 5 章生成一次 300-400 字摘要；写新章时会注入最近 3 个区块（约 15 章）的摘要。</p>
    </div>
  </div>`;
}

function bindRollingSummaryCard(){
  const head = $('[data-rs-fold]');
  if(head) head.onclick = ()=>{
    state.rsCollapsed = !state.rsCollapsed; persist();
    const body = $('.rs-body'); if(body) body.hidden = state.rsCollapsed;
    const ico = head.querySelector('.sc-fold-ico'); if(ico) ico.textContent = state.rsCollapsed?'▸':'▾';
  };
  const gen = $('[data-rs-gen]');
  if(gen) gen.onclick = async ()=>{
    busy(gen, true, '生成中…');
    try{ await ensureChapterDigests(); await generateRollingSummaries(); render(); toast('滚动摘要已补齐'); }
    catch(e){ toast('摘要生成失败：'+e.message); }
    finally{ busy(gen, false); }
  };
  const clr = $('[data-rs-clear]');
  if(clr) clr.onclick = ()=>{
    if(!confirm('清空所有滚动摘要？正文生成时会重新生成。')) return;
    const o = state.outline; if(!o) return;
    o._rollingSummaries = []; persist(); render(); toast('已清空滚动摘要');
  };
}

// —— 2.6 质量报告卡 ——
function qualityReportCardHtml(){
  const issues = state.chapters.map((c,i)=> ({i, q:c && c._qualityIssue})).filter(x => x.q && !x.q.ok);
  // 4.8 旗舰版（P3）：AI 协作网络有进展记录时也渲染看板（即便暂无质量问题）
  const net = state.aiNetwork || {};
  const netHas = (Array.isArray(net.completed) && net.completed.length) || (Array.isArray(net.running) && net.running.length);
  if(!issues.length && !netHas) return '';
  const rows = issues.map(({i,q})=>`
    <div class="qr-row">
      <span class="pill tag-warn">第 ${i+1} 章</span>
      <span class="qr-code">${esc(q.code || 'ISSUE')}</span>
      <span class="qr-msg">${esc(q.errors.join('；'))}</span>
      <span class="btn-row" style="margin:0">
        <button type="button" class="btn small primary" data-qr-retry="${i}">🔄 重试</button>
        <button type="button" class="btn small ghost" data-qr-ignore="${i}">忽略</button>
      </span>
    </div>
  `).join('');
  return `<div class="card qr-card">
    <div class="qr-head">
      <h3 style="margin:0">⚠️ 质量报告${issues.length ? `（${issues.length} 章需关注）` : ''}</h3>
      ${issues.length ? `<button type="button" class="btn small ghost" data-qr-retry-all>全部重试</button>` : ''}
    </div>
    <div class="qr-body">
      ${renderAINetworkPanel()}   <!-- 4.8 旗舰版（P3）：AI 协作看板（消费 state.aiNetwork） -->
      ${rows}
    </div>
  </div>`;
}

function bindQualityReportCard(){
  $$('[data-qr-retry]').forEach(btn=>{
    btn.onclick = ()=>{
      const i = +btn.dataset.qrRetry;
      delete state.chapters[i]._qualityIssue;
      persist();
      genNChapters(i, 1);
    };
  });
  $$('[data-qr-ignore]').forEach(btn=>{
    btn.onclick = ()=>{
      const i = +btn.dataset.qrIgnore;
      delete state.chapters[i]._qualityIssue;
      persist(); render(); toast(`第 ${i+1} 章问题已忽略`);
    };
  });
  const all = $('[data-qr-retry-all]');
  if(all) all.onclick = ()=>{
    const list = state.chapters.map((c,i)=> (c && c._qualityIssue && !c._qualityIssue.ok) ? i : -1).filter(i=>i>=0);
    if(!list.length) return;
    list.forEach(i => delete state.chapters[i]._qualityIssue);
    persist();
    if(list.length) genNChapters(list[0], 1); // 启动队列，实际需改成连续区间
  };
}

// —— 2.7 本章相关词典浮板 ——
function formatRelevantGlossaryHtml(rg){
  const lines = [];
  if(rg.characters && rg.characters.length) lines.push('<b>人物：</b>'+rg.characters.map(c=>esc(c.name)).join('、'));
  if(rg.places && rg.places.length) lines.push('<b>地点：</b>'+rg.places.map(p=>esc(p.name)).join('、'));
  if(rg.propernouns && rg.propernouns.length) lines.push('<b>专名：</b>'+rg.propernouns.map(p=>esc(p.name)).join('、'));
  if(!lines.length) return '';
  return `<div class="reader-rg"><span class="reader-rg-lab">📌 本章相关设定</span>${lines.join(' · ')}</div>`;
}

// —— 2.8 正文修复队列卡 ——
function fixQueueCardHtml(){
  const q = state._fixQueue || [];
  if(!q.length) return '';
  const rows = q.map((item, idx)=>{
    // 4.8 旗舰版（P3）：兼容两类条目——正文条目 {ch,code,errors} 与 AI 协作条目 {kind,error}
    const isKind = !Number.isInteger(item.ch);
    return `<div class="fq-row">
      ${isKind
        ? `<span class="pill tag-warn">${esc(item.kind || 'AI')}</span><span>${esc(item.error || '')}</span>`
        : `<span class="pill tag-warn">第 ${item.ch+1} 章</span><span>${esc(item.code)}</span>`}
      <span class="muted">重试 ${item.attempts||0} 次</span>
      <button type="button" class="btn small ghost" data-fq-remove="${idx}">移除</button>
    </div>`;
  }).join('');
  return `<div class="card fq-card">
    <div class="fq-head"><h3 style="margin:0">🔧 修复队列（${q.length}）</h3></div>
    <div class="fq-body">${rows}</div>
  </div>`;
}

function bindFixQueueCard(){
  $$('[data-fq-remove]').forEach(btn=>{
    btn.onclick = ()=>{
      const idx = +btn.dataset.fqRemove;
      state._fixQueue.splice(idx,1); persist(); render();
    };
  });
}

/* ==================== 4.6 Plus 新增卡片结束 ==================== */

// v10.2 原始构想只读卡：故事页最顶部展示生成大纲时的用户构想原文（快照 outline.userIdea，
// 缺省回退当前 state.idea）。只读不可编辑、可复制；默认收缩，点击展开。纯前端、无 AI 参与。
function origIdeaCard(){
  const o = state.outline;
  const idea = (o && typeof o.userIdea === 'string' && o.userIdea.trim())
    ? o.userIdea : (state.idea || '');
  return `<div class="card orig-card">
    <div class="orig-head" role="button" tabindex="0" data-orig-toggle title="展开/收起">
      <span class="orig-t">📝 原始构想</span>
      <span class="orig-fold">▸</span>
    </div>
    <div class="orig-body" hidden>
      <textarea readonly class="orig-text" spellcheck="false">${esc(idea || '（无构想记录）')}</textarea>
      <div class="orig-actions">
        <button type="button" class="btn ghost gs-tool" data-orig-copy>📋 复制</button>
        <span class="muted orig-note">只读展示，不可编辑；修改构想需重新生成大纲才会更新此快照。</span>
      </div>
    </div>
  </div>`;
}

// v10.2 原始构想只读卡绑定：展开/收缩切换 + 复制（复用全局 copyText，自带 toast）
function bindOrigIdea(){
  const og = $('[data-orig-toggle]');
  if(og) og.onclick = ()=>{
    const body = $('.orig-body'); if(!body) return;
    const on = !body.hidden;
    body.hidden = on;
    const fold = og.querySelector('.orig-fold');
    if(fold) fold.textContent = on ? '▸' : '▾';
  };
  const cpy = $('[data-orig-copy]');
  if(cpy) cpy.onclick = ()=>{
    const ta = $('.orig-text'); if(!ta) return;
    copyText(ta.value);
  };
}
// v1.0.107 故事大纲卡「小说简介」折叠绑定：点标题头翻转简介 hidden + 箭头，并持久化 soCollapsed（纯 DOM，不整卡重渲染）
function bindOutlineFold(){
  const h = $('[data-so-toggle]'); if(!h) return;
  h.onclick = ()=>{
    const body = $('.so-logline'); if(!body) return;
    const on = !body.hidden;
    body.hidden = on;
    const f = h.querySelector('.so-fold'); if(f) f.textContent = on ? '▸' : '▾';
    if(state){ state.soCollapsed = on; if(typeof persist==='function') persist(); }
  };
}
// v1.0.116 小说核心锚点辅助：下游 AI 提示词统一「锚点在前、完整简介在后」；(anchor/thesis) 为可空字段
function outlineAnchorBlock(){
  const o = state.outline||{};
  const a = String(o.anchor||'').trim(), t = String(o.thesis||'').trim();
  if(!a && !t) return '';
  return `【核心定位】${a||'未提取'}\n【深层主题】${t||'未提取'}`;
}
// 长度兜底裁剪，防止手填/AI 输出超长反噬下游 AI 焦点
function clampAnchor(str, max){
  str = String(str||'').trim();
  return str.length>max ? str.slice(0,max) : str;
}
// v1.0.116 懒惰提取：仅当简介字数 > 阈值才自动调用（短文下游 AI 直接读懂，省这次轻量请求）
const ANCHOR_LEN_MIN = 200;
async function extractStoryAnchors(opts){
  opts = opts || {};
  const o = state.outline; if(!o || !isLong()) return;
  const body = String(o.logline||'').trim();
  if(!body){ toast('尚无小说简介'); return; }
  if(!opts.force && body.length <= ANCHOR_LEN_MIN) return;   // 短文：跳过
  const btn = opts.btn;
  if(btn){ btn.disabled = true; busy(btn,true,'提取中…'); }
  try{
    const txt = unwrapAIResult(await callDeepSeek(ANCHOR_EXTRACT_SYS, `【完整简介】\n${body}`, {temperature:0.2, topP:0.5, signal:_abortCtl?.signal, maxTokens:clampMaxTokens('json'), taskKey:'audit'}));   // 4.8 旗舰版（板块二-2/3）：JSON 窄采样 + 限长
    const j = parseJson(txt) || {};
    const a = clampAnchor(j.anchor, 60), t = clampAnchor(j.thesis, 120);
    if(!a && !t){ if(!opts.silent) toast('未提取到有效核心定位/深层命题'); return; }
    o.anchor = a; o.thesis = t;
    persist();
    const i1 = $('#soAnchor'); if(i1) i1.value = a;
    const i2 = $('#soThesis'); if(i2) i2.value = t;
    if(!opts.silent) toast('核心定位已更新');
  }catch(e){
    if(e.name !== 'AbortError' && !opts.silent) toast('提取核心定位失败：'+e.message);
  }finally{
    if(btn){ btn.disabled = false; busy(btn,false); }
  }
}
// 简介区可复核小面板：anchor(一句话定位) + thesis(深层命题) 两行可编辑 + 重新提取
function anchorEditHtml(){
  const o = state.outline || {};
  return `<div class="so-anchor" ${state.soCollapsed?'hidden':''}>
    <div class="so-anchor-row">
      <span class="so-anchor-t" title="题材+主角+核心冲突，一句话内定位">核心定位</span>
      <input type="text" id="soAnchor" class="so-anchor-in" maxlength="60" placeholder="题材+主角+核心冲突（≤50字）" value="${esc(o.anchor||'')}">
    </div>
    <div class="so-anchor-row">
      <span class="so-anchor-t" title="作品要探讨的核心主题/情感内核">深层命题</span>
      <input type="text" id="soThesis" class="so-anchor-in" maxlength="120" placeholder="作品探讨的核心主题/情感内核（≤80字）" value="${esc(o.thesis||'')}">
    </div>
    <div class="so-anchor-foot">
      <button type="button" class="btn small ghost" id="btnAnchorExtract" title="从小说简介重新提炼核心定位/深层命题">↺ 重新提取</button>
      <span class="muted so-anchor-note">供标题/规划师/正文等 AI 快速抓重点；可手动删减复核</span>
    </div>
  </div>`;
}
// 简介区锚点面板绑定：输入即存（用户有最终编辑权）+ 重新提取按钮
function bindAnchors(){
  const a1 = $('#soAnchor'), a2 = $('#soThesis');
  const save = ()=>{
    const o = state.outline; if(!o) return;
    o.anchor = clampAnchor(a1 ? a1.value : o.anchor, 60);
    o.thesis = clampAnchor(a2 ? a2.value : o.thesis, 120);
    persist();
  };
  if(a1) a1.addEventListener('input', save);
  if(a2) a2.addEventListener('input', save);
  const b = $('#btnAnchorExtract');
  if(b) b.onclick = ()=> extractStoryAnchors({ btn:b });
}
// v10.30 AI 配方助手绑定（事件委托到容器，容动态渲染的候选/缺口；仅长篇小说模式有该容器）
function bindAiRecipe(){
  const card = $('.ai-recipe-card'); if(!card) return;
  const gen = card.querySelector('[data-ai-recipe-gen]');
  if(gen) gen.onclick = ()=>{ aiRecipeGen(); };
  const clr = card.querySelector('[data-ai-recipe-clear]');
  if(clr) clr.onclick = ()=>{
    const ta = $('#aiReDesc'); if(ta) ta.value = '';
    const nm = card.querySelector('[data-ai-upload-name]'); if(nm) nm.textContent = '';
    aiRp = null; aiSource = 'desc';
    const out = card.querySelector('[data-ai-recipe-out]'); if(out) out.innerHTML = aiRecipeResultHtml();
  };
  // v10.31 卡片折叠：点头部整卡展开/收起，状态持久化到 cfg.aiRecipeCollapsed（默认折叠）
  const foldHead = card.querySelector('[data-ai-recipe-fold]');
  if(foldHead) foldHead.addEventListener('click', ()=>{
    const cfg = getCfg();
    card.classList.toggle('collapsed');
    const nowCollapsed = card.classList.contains('collapsed');
    cfg.aiRecipeCollapsed = nowCollapsed; saveCfg(cfg);
    const ico = foldHead.querySelector('.sc-fold-ico'); if(ico) ico.textContent = nowCollapsed?'▸':'▾';
  });
  // v10.57 书本图标：打开 AI 配方历史弹层（徽标随快照数更新）
  const histBtn = card.querySelector('[data-ai-recipe-hist]');
  if(histBtn) histBtn.onclick = ()=>{ openAiHistPanel(); };
  // v1.0.62 上传主线简述 TXT：圆形加号 → FileReader.readAsText → AI 通读提炼配方
  const fIn = $('#aiReFile');
  const readOutline = (f)=>{
    if(!f) return;
    if(!/\.txt$/i.test(f.name)){ toast('请上传 .txt 文本'); return; }
    const r = new FileReader();
    r.onload = ()=>{
      const txt = String((r.result)||'').trim();
      if(!txt){ toast('文件内容为空'); return; }
      const nm = card.querySelector('[data-ai-upload-name]'); if(nm) nm.textContent = f.name;
      _aiOutlineFname = f.name;   // v10.57 供快照标记来源
      aiRecipeFromOutline(txt);
    };
    r.onerror = ()=> toast('读取文件失败');
    r.readAsText(f);
  };
  if(fIn) fIn.onchange = ()=>{ const f = fIn.files && fIn.files[0]; readOutline(f); fIn.value=''; };
  const openPick = ()=>{ if(fIn) fIn.click(); };
  const fileBtn = card.querySelector('[data-ai-recipe-file]');
  if(fileBtn) fileBtn.onclick = openPick;
  // 事件委托：选用候选 / 加入缺口词条（点选候选后内部 render()，事件需在容器上重查）
  card.addEventListener('click', (e)=>{
    const pick = e.target.closest('[data-ai-recipe-pick]');
    if(pick){ aiRecipeApply(+pick.dataset.aiRecipePick); return; }   // 4.7 Pro（3.6）：选用走 aiRecipeApply（styleContract 落库）
    const save = e.target.closest('[data-ai-recipe-save]');
    if(save){ aiRecipeSave(+save.dataset.aiRecipeSave); return; }
    const ag = e.target.closest('[data-ai-recipe-addgap]');
    if(ag){ aiRecipeAddGap(ag.dataset.aiRecipeAddgap); return; }
  });
}
// —— v10.57 AI 配方历史弹层（书本图标；读持久化快照，与瞬时 aiRp 解耦）——
function aiHistCandHtml(c, idx){
  if(!c) return '';
  return `<div class="ai-recipe-cand" style="margin-top:6px">
    <div class="ai-recipe-cand-head">
      <b>${esc(c.name||('候选'+(idx+1)))}</b>
      ${ recipeScBadge(c) }
      <span class="muted" style="font-size:11px">${esc(c.desc||'')}</span>
    </div>
    <div class="ai-recipe-tags">${ (c.tags||[]).map(id=>{ const s=writeStyleById(id); return `<span class="ai-recipe-tg">${esc(s?s.name:id)}</span>`; }).join('') }</div>
    <div class="ai-recipe-sec"><span class="ar-lab">为何这样选</span>${esc(wiseWhyText(c.why||''))}</div>
    <div class="ai-recipe-sec"><span class="ar-lab">适用场景</span>${esc(wiseWhyText(c.scenario||''))}</div>
    <div class="ai-recipe-gap">
      ${ Array.isArray(c.gap) && c.gap.length
        ? `<div class="ar-gaptitle">⚠️ 词条缺口（${c.gap.length} 项）</div>` + c.gap.map(g=>`
            <div class="ai-recipe-gapitem">
              <div class="ar-gaphead"><b>${esc((g&&g.name)||'')}</b><span class="muted" style="font-size:11px">${ (AI_CAT_LABEL[(g&&g.cat)||'']||((g&&g.cat)||'custom')) }</span></div>
              <div class="ar-gapwhy">${esc((g&&g.reasons)||'')}</div>
              ${gapFiveHtml(g)}
            </div>`).join('')
        : `<span class="ar-ok">✓ 现有词库即可覆盖，无需新词条</span>` }
    </div>
    <div style="margin-top:6px"><button type="button" class="btn small primary" data-ah-candpick="${idx}" title="恢复此候选并应用到写作风格">✔ 恢复为此候选</button></div>
  </div>`;
}
function openAiHistPanel(){
  const hist = getAiHist();
  const ov = document.createElement('div'); ov.id='aiHistPanel'; ov.className='gs-overlay';
  const entHtml = (e,hi)=>{
    const ei = hist.length-1-hi;   // 倒序序号（与展示一致）
    return `<div class="ws-lib-group ws-lib-fold" style="margin-top:6px">
      <div class="ws-lib-fold-t" data-ah-fold="${ei}" role="button" tabindex="0" title="展开/收起">
        <span>${e.src==='outline'?'📑':'📝'} ${esc(e.desc||'')} <span class="muted" style="font-size:10px">· ${new Date(e.ts).toLocaleString('zh-CN',{hour12:false})}</span></span>
        <span class="sc-fold-ico">▸</span>
      </div>
      <div class="ws-lib-fold-body" style="display:none">
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 8px">
          <button type="button" class="btn small ghost" data-ah-apply="${ei}">✔ 重新采用首个</button>
          <button type="button" class="btn small ghost" data-ah-del="${ei}">删</button>
        </div>
        ${ (Array.isArray(e.list)&&e.list.length) ? e.list.map((c,i)=>aiHistCandHtml(c,i)).join('<hr style="margin:6px 0;opacity:.2">') : '<p class="muted">无候选。</p>' }
      </div>
    </div>`;
  };
  const list = hist.slice().reverse();
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>📖 AI 配方历史（${hist.length}）</b>
        <span style="display:flex;gap:6px">
          <button class="btn small ghost" data-ah-clear>清空</button>
          <button class="gs-x" data-ah-close>✕</button>
        </span></div>
      <div class="cv-body">
        ${ list.length ? list.map(entHtml).join('') : '<p class="muted">暂无历史。用「✨ 生成配方」生成后即自动保存于此，可随时回看。</p>' }
      </div>
    </div>`;
  const close = ()=>{ const p=$('#aiHistPanel'); if(p) p.remove(); };
  ov.addEventListener('click', (e)=>{
    const cl = e.target.closest('[data-ah-close]'); if(cl){ close(); return; }
    const fold = e.target.closest('[data-ah-fold]');
    if(fold){ const body = fold.closest('.ws-lib-group').querySelector('.ws-lib-fold-body'); if(body){ const open = body.style.display!=='none'; body.style.display = open?'none':'block'; fold.querySelector('.sc-fold-ico').textContent = open?'▸':'▾'; } return; }
    const apply = e.target.closest('[data-ah-apply]');
    if(apply){ const ei=+apply.dataset.ahApply; const entry=hist[ei]; if(entry&&Array.isArray(entry.list)&&entry.list.length){ applyChosenCandidate(entry.list[0], {render:false}); refreshAiHistBadge(); close(); } return; }
    const candpick = e.target.closest('[data-ah-candpick]');
    if(candpick){ const ci=+candpick.dataset.ahCandpick; const grp=candpick.closest('.ws-lib-group'); const fold=grp&&grp.querySelector('[data-ah-fold]'); const ei=fold?+fold.dataset.ahFold:-1; const entry=hist[ei]; const c=(entry&&Array.isArray(entry.list))?entry.list[ci]:null; if(c){ applyChosenCandidate(c, {render:true}); refreshAiHistBadge(); close(); } return; }
    const del = e.target.closest('[data-ah-del]');
    if(del){ const ei=+del.dataset.ahDel; const a=getAiHist(); if(a[ei]){ a.splice(ei,1); setAiHist(a); } refreshAiHistBadge(); const p=$('#aiHistPanel'); if(p) p.remove(); openAiHistPanel(); return; }
    const clr = e.target.closest('[data-ah-clear]');
    if(clr){ if(confirm('确认清空全部 AI 配方历史？')){ setAiHist([]); refreshAiHistBadge(); close(); } return; }
    if(e.target===ov) close();
  });
  document.body.appendChild(ov);
}
function closeAiHistPanel(){ const p=$('#aiHistPanel'); if(p) p.remove(); }
// 更新卡片书本徽标（按当前快照数）
function refreshAiHistBadge(){
  const n = getAiHist().length;
  const card = $('.ai-recipe-card');
  if(card){ const b = card.querySelector('[data-ai-recipe-hist] .ai-hist-badge'); if(b) b.textContent = n||''; }
}
// v10.14 章节标题管理：大纲生成后用户可编辑全部章节标题，一键同步两数据源 + 复制全部标题。
// 数据源说明：o.chapters[i].title（大纲骨架）与 state.chapters[i].title（章节状态）在大纲确认时复制一次，
// 之后各自独立——编辑必须经 setChapterTitle 同步两处，否则消费点错位。
function setChapterTitle(i, title){
  const t = String(title||'').trim();
  const o = state.outline;
  if(o && Array.isArray(o.chapters) && o.chapters[i]){
    // P1-2：改前记录旧标题入 o.chTitleHistory（上限10，最新在前）
    const oldT = (o.chapters[i].title||'').trim();
    if(oldT && oldT !== t && o.chapters[i].title !== undefined){
      if(!Array.isArray(o.chTitleHistory)) o.chTitleHistory = [];
      o.chTitleHistory.unshift({ i, title: oldT, ts: Date.now() });
      if(o.chTitleHistory.length > 50) o.chTitleHistory.splice(50);
    }
    o.chapters[i].title = t;
  }
  if(state.chapters && state.chapters[i]) { state.chapters[i].title = t; state.chapters[i]._titleByAI = false; state.chapters[i]._titleFinalized = false; }   // v1.0.114 手动改标题即取消「正文 AI 定稿」标记；4.8 旗舰版（板块一-1）同时允许再次 AI 定稿
  persist();
}
// P1-2 标题曾用记录辅助
function chTitleHistory(){ const o=state.outline; return (o && Array.isArray(o.chTitleHistory)) ? o.chTitleHistory : []; }
function hasChTitleHistory(){ return chTitleHistory().length > 0; }

// 生成"第N章 标题"纯文本（仅章节+标题，无多余内容），供一键复制。
// 标题常自带"第N章"前缀（cleanChapterTitle 去前缀后再统一加"第N章 "，避免"第1章 第1章 起点"）
function chapterTitleListText(){
  const o = state.outline;
  const arr = (o && Array.isArray(o.chapters)) ? o.chapters : [];
  return arr.map((c,i)=>`第${i+1}章 ${cleanChapterTitle((c&&c.title)||'')}`.replace(/\s+$/,'')).filter(Boolean).join('\n');
}

// v10.14 章节标题管理块：工具行（复制全部）+ 每行标题 + ✎ 编辑
// v11 第二步：无标题时渲染「全书章节数 + 生成全部章节标题」最小入口；有标题时渲染完整管理。
function chapterTitleBlock(){
  const o = state.outline;
  const arr = (o && Array.isArray(o.chapters)) ? o.chapters : [];
  const cc = chapterCountVal();
  const ccOn = !!cc;
  // v1.0.119 阶段C（已生成标题）整块移除章节数面板（不占版面），总数并入标题栏；A/B 保留可编辑输入
  // v225/P5-B：locked 改为"存在非空标题"——标题全空（占位态）时章节数输入保持可改
  const locked = arr.some(c=>String(c&&c.title||'').trim());
  const nIn = locked ? ''
    : `
    <div class="tw-panel ct-n-panel">
      <div class="poly-head"><span class="poly-ic">📐</span><b>全书章节数</b><span class="poly-rule">第二步 · 生成全部章节标题前必填 · 填 1-200 整数</span></div>
      <div class="tw-row">
        <input type="number" id="totalWordsIn" class="tw-in cc-in" min="1" max="200" step="1" inputmode="numeric" placeholder="如 30" value="${cc||''}" ${ccOn?'':'data-first'} />
        <span class="tw-unit">章</span>
        ${cc ? `<span class="pill tag-ok">${chapterCountHint()}</span>` : ''}
      </div>
    </div>`;
  // v225/P5-B：无标题时纯展示——仅章节数输入 + 序号占位列表；标题生成统一归「全书规划师」，卡片不再提供任何 AI 生成入口
  if(!arr.length){
    const phRows = cc ? Array.from({length:cc},(_,i)=>`<div class="ct-row"><span class="ct-no">第${i+1}章</span><span class="ct-title muted">（待规划师生成）</span></div>`).join('') : '';
    return `<div class="ct-block">
    <div class="ct-head" style="cursor:default">
      <b>📚 章节标题</b>
    </div>
    ${nIn}
    <p class="muted" style="margin:8px 0 6px">第二步：填写「全书章节数」后即可进入第三步，标题由「全书规划师」统一生成。${cc?'下方按当前章节数展示章节序号（标题待生成）。':'先填写章节数。'}</p>
    ${phRows?`<div class="ct-list">${phRows}</div>`:''}
  </div>`;
  }
  const rows = arr.map((c,i)=>`
    <div class="ct-row" data-ct-row="${i}">
      <span class="ct-no">第${i+1}章</span>
      <span class="ct-title${String((c&&c.title)||'').trim()?'':' muted'}" title="${esc((c&&c.title)||'')}">${esc(String((c&&c.title)||'').trim())||'（待规划师生成）'}</span>
      <button type="button" class="ct-edit" data-ct-edit="${i}" title="编辑标题">✎</button>
    </div>`).join('');
  return `<div class="ct-block${state.ctCollapsed?' ct-collapsed':''}">
    <div class="ct-head" data-ct-fold role="button" tabindex="0" title="展开/收起">
      <b>📚 章节标题（共 ${arr.length} 章） <span class="ct-fold-ico">${state.ctCollapsed?'▸':'▾'}</span></b>
      <span class="ct-tools">
        <button type="button" class="btn small ghost" data-ct-hist>单历(${chTitleHistory().length})</button>
        <button type="button" class="btn small ghost" data-ct-copy>📋 复制全部章节标题</button>
      </span>
    </div>
    <div class="ct-row2">
      <button type="button" class="btn small ghost" data-ct-batch title="查看并可整批回退「重生成全部标题」的历史版本">版本(${chTitleBatches().length}/50)</button>
      <button type="button" class="btn small ghost" data-ct-raw title="手动提取 AI 原始响应数据，当自动更新失败时使用">🔧</button>
    </div>
    ${nIn}
    <div class="ct-list">${rows}</div>
  </div>`;
}

// v10.14 章节标题绑定：复制全部 / ✎ 进入编辑态（失焦或回车存、Esc 还原、同刻单行互斥）
function bindChapterTitles(){
  const ctFold = $('[data-ct-fold]');
  if(ctFold) ctFold.onclick = ()=>{
    state.ctCollapsed = !state.ctCollapsed; persist();
    const blk = ctFold.closest('.ct-block'); if(blk) blk.classList.toggle('ct-collapsed', state.ctCollapsed);
    const ico = ctFold.querySelector('.ct-fold-ico'); if(ico) ico.textContent = state.ctCollapsed?'▸':'▾';
  };
  const cp = $('[data-ct-copy]');
  if(cp) cp.onclick = ()=>{ copyText(chapterTitleListText()); };
  const ch = $('[data-ct-hist]');
  if(ch) ch.onclick = ()=> openChTitleHistoryPanel();
  const ctb = $('[data-ct-batch]');
  if(ctb) ctb.onclick = ()=> openChTitleBatchPanel();
  const rawT = $('[data-ct-raw]');
  if(rawT) rawT.onclick = ()=> openTitlesRawPanel();
  // v225/P5-B：AI 生成类入口与绑定已移除——重生成/优化建议/建议历史/正文回填开关不再挂在卡片上，
  // 标题生成只归「全书规划师」（genPlannerTitles）；✎ 手动编辑、📋 复制、单历/版本/🔧 原始响应属展示与人工微调，保留。
  $$('[data-ct-edit]').forEach(btn=>{
    btn.onclick = ()=>{
      const i = +btn.dataset.ctEdit;
      const row = $('[data-ct-row="'+i+'"]'); if(!row) return;
      const span = row.querySelector('.ct-title'); if(!span) return;
      // 先提交其他处于编辑态的行（单行互斥）
      $$('.ct-edit-input').forEach(inp=> commitChapterTitle(inp));
      const inp = document.createElement('input');
      inp.className = 'ct-edit-input';
      inp.value = span.textContent;
      span.replaceWith(inp);
      inp.focus(); inp.select();
      inp.onkeydown = e=>{
        if(e.key==='Enter'){ e.preventDefault(); commitChapterTitle(inp); }
        else if(e.key==='Escape'){ commitChapterTitle(inp, true); }
      };
      inp.onblur = ()=> commitChapterTitle(inp);
    };
  });
}

// v10.32 章节标题 AI 优化建议：把 rtInput 里的粗略要求提炼成 3 条可直接作「重生成要求」的建议稿
let ctAdviceCand = null;   // {title,text}[] 候选，模块级；重渲会随标签重置
let ctAdviceFold = false;  // v10.33 候选是否已收起（采纳后收起，可再展开）；重渲复位
let ctAdoptedIdx = -1;     // v10.34 当前已采用的选项索引（-1 表示未采用）
function buildCtAdviceCtx(){
  const o = state.outline || {};
  return {
    小说书名: o.title || '',
    小说简介: o.logline || '',
    现有全部章节标题: (o.chapters||[]).map((c,i)=>`第${i+1}章 ${cleanChapterTitle(c&&c.title)}`).join('\n')
  };
}
function ctAiRefinePrompt(ctx, raw){
  const _raw = String(raw||'').trim();
  return { system:[
    '你是资深长篇小说的章标题策划师。用户在"重生成要求"框里可能写了一段补充要求（风格方向、悬念感、字数对仗、避免套路等），也可能留空、只想听你对全部章节标题的专业点评。',
    '请审读给出的【现有全部章节标题】【小说书名】【小说简介】，输出 1–3 条建议（至少 1 条、最多 3 条）；每条 = { title(一句话定位本条侧重), text(完整点评 + 可直接作为重生成要求下发给标题 AI 的可执行命令) }。',
    '【允许"无建议"】若现有标题整体已足够好，就只返回 1 条：{"title":"无建议","text":"现有标题整体稳定，暂不建议改动。"}——宁缺毋滥，不硬凑条数、不胡说。',
    '【点评要点】整套标题风格是否统一、有无重复/呆板/同质化标题、字数是否对仗、悬念与画面感、与书名/简介的契合度、整体节奏感。',
    '【有补充要求时】先满足用户要求（'+ (_raw? _raw.slice(0,120)+'…' : '（用户未给出方向）') +'）的角度，再在该方向之外综合点评；要求为空时直接审读全部标题点评。',
    '【可执行】text 用对标题 AI 说的命令式祈使句，明确范围与幅度，可行时用换行拆 2–3 个可独立启用的子要点；不臆造与书名/简介冲突的新名或专名。',
    '输出仅一个 JSON 数组（1–3 项），无任何讲解、无 markdown 代码块前后缀。每项结构：{ "title":"一句话说明本条侧重什么", "text":"完整点评+可执行命令" }'
    ].join('\n'),
    user: JSON.stringify({ 上下文: ctx, 用户原始要求: (_raw||'(无)') }, null, 1) };
}
async function ctAiRefineAdvice(){
  if(_aiOptBusy){ toast('AI 建议优化中，请稍候'); return; }
  if(genBusy()){ toast('已有生成任务进行中，请稍候'); return; }   // v10.43 互斥：重生成标题等任务进行中不并发
  _aiOptBusy = true;   // v10.43 占位，供 genBusy 判定「AI 建议进行中」
  const inp = $('#rtInput'); if(!inp){ _aiOptBusy = false; return; }
  const raw = inp.value.trim();   // 可空：无补充要求也能生成点评
  const out = $('[data-cth-ai-out]');
  if(out) out.innerHTML = `<p class="muted" style="margin:6px 0 0">⏳ AI 正审读现有全部章节标题并给出优化建议…</p>`;
  const btn = $('[data-cth-ai]'); if(btn){ btn.disabled = true; btn.classList.add('is-busy'); btn.textContent = '生成中…'; }
  try{
    const ctx = buildCtAdviceCtx();
    const {system, user} = ctAiRefinePrompt(ctx, raw);
    const spec = resolveActiveSpec();
    const res = unwrapAIResult(await callDeepSeek(system, user, {temperature: spec.titleTemp, topP:0.5, maxTokens:clampMaxTokens('json'), taskKey:'titleAdvice'}));   // 4.8 旗舰版（板块二-2/3）：建议类 JSON 窄采样 + 限长
    const list = parseAiJsonList(res);
    const ls = Array.isArray(list) ? list.filter(x=> x && String(x.text||'').trim()) : [];
    if(!ls.length) throw new Error('AI 未返回有效建议，请重试');
    // 单条"无建议"标记 → 只提示，不强制造可选择回填项
    if(ls.length===1 && /无建议/.test(String(ls[0].title||'')+' '+String(ls[0].text||''))){
      ctAdviceCand = null; ctAdviceFold = false; ctAdoptedIdx = -1;
      if(out) out.innerHTML = `<p class="muted" style="margin:6px 0 0">💡 ${esc(String(ls[0].text||'现有标题整体稳定，暂不建议改动。').trim())}</p>`;
      _aiOptBusy = false;
      const fBtn = $('[data-cth-ai-unfold]'); if(fBtn) fBtn.style.display = 'none';
      if(btn){ btn.disabled = false; btn.textContent = '✨ 标题优化建议'; btn.classList.remove('is-busy'); }
      return;
    }
    ctAdviceCand = ls.slice(0,3);
    ctAdviceFold = false;   // v10.33 新一批默认展开显示
    ctAdoptedIdx = -1;      // v10.34 新一批重置已采用状态
    // v10.59 生成成功即存项目快照（随项目保存，切页/刷新不丢）
    addAdvHist('ct', { id: aiHistEntryId(), ts: Date.now(), desc: '标题优化建议', list: JSON.parse(JSON.stringify(ls.slice(0,3))) });
    refreshAdvHistBadge('ct');
  }catch(e){
    ctAdviceCand = null;
    if(out) out.innerHTML = `<p class="muted" style="color:var(--danger);margin:6px 0 0">⚠️ ${esc((e&&e.message)||'生成失败')}</p>`;
  }
  _aiOptBusy = false;   // v10.43 结束/异常均复位
  if(out) out.innerHTML = ctAdviceResultHtml();
  if(btn){ btn.disabled = false; btn.textContent = '✨ 标题优化建议'; btn.classList.remove('is-busy'); }
  // v10.34 控制折叠按钮显示
  const foldBtn = $('[data-cth-ai-unfold]');
  if(foldBtn){
    foldBtn.style.display = (ctAdviceCand && ctAdviceCand.length) ? '' : 'none';
    foldBtn.textContent = ctAdviceFold ? '↗ 展开建议' : '↘ 收起建议';
  }
}
function ctAdviceResultHtml(){
  if(!Array.isArray(ctAdviceCand) || !ctAdviceCand.length) return '';
  if(ctAdviceFold) return '';   // v10.34 折叠态由外部 cth-fold-btn 控制，此处不渲染
  return ctAdviceCand.map((a,ai)=>`
    <div class="advice-ai-cand${ctAdoptedIdx===ai?' adopted':''}" data-cth-ai-pick="${ai}">
      <div class="advice-ai-head">
        <span class="advice-ai-idx">${'①②③'[ai]||(ai+1)}</span>
        <b>${esc(a.title||('方案'+(ai+1)))}</b>
      </div>
      <p>${esc(a.text||'')}</p>
    </div>`).join('');
}
// v10.34 同步折叠按钮显示与文字
function updateFoldBtn(){
  const foldBtn = $('[data-cth-ai-unfold]');
  if(!foldBtn) return;
  foldBtn.style.display = (ctAdviceCand && ctAdviceCand.length) ? '' : 'none';
  foldBtn.textContent = ctAdviceFold ? '↗ 展开建议' : '↘ 收起建议';
}
function commitChapterTitle(inp, revert){
  if(!inp || inp.dataset.done) return;
  inp.dataset.done = '1';
  const row = inp.closest('[data-ct-row]');
  const i = row ? +row.dataset.ctRow : -1;
  const o = state.outline;
  const oldT = (o && o.chapters && o.chapters[i] && o.chapters[i].title) || ('第'+(i+1)+'章');
  const val = inp.value.trim();
  if(!revert && i>=0 && val) setChapterTitle(i, val);
  const span = document.createElement('span');
  span.className = 'ct-title';
  const finalT = (revert||!val) ? oldT : val;
  span.textContent = finalT;
  span.title = finalT;
  inp.replaceWith(span);
}

// v10.16 批量更新全部章节标题：直接写两处数据源（不逐条走 setChapterTitle，避免污染单条曾用标题）；返回实际更新数
function setAllTitles(titles){
  const o = state.outline;
  const n = (o && Array.isArray(o.chapters)) ? o.chapters.length : 0;
  let cnt = 0;
  (titles||[]).forEach((t,i)=>{
    if(i<n && String(t||'').trim()){
      const tt0 = String(t).trim();
      const tt = cleanChapterTitle(tt0) || tt0;   // 入库前剥掉可能重复的"第N章"前缀，只存标题名
      if(o && o.chapters[i]) o.chapters[i].title = tt;
      if(state.chapters && state.chapters[i]) { state.chapters[i].title = tt; state.chapters[i]._titleByAI = false; }   // v1.0.114 重生成/批量回退后清除「正文 AI 定稿」标记
      cnt++;
    }
  });
  persist();
  return cnt;
}

/* ---------- P1-2 章节标题曾用记录：🕘 弹窗查看 + 一键恢复（上限10） ---------- */
function openChTitleHistoryPanel(){
  closeChTitleHistoryPanel();
  const hist = chTitleHistory(); if(!hist.length){ toast('暂无曾用标题'); return; }
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const o = state.outline;
  const rows = hist.map((h,idx)=>`
    <div class="cv-row">
      <div class="cv-meta" style="flex:1;min-width:0"><div class="cv-time">第${h.i+1}章 · ${fmtTs(h.ts)}</div><div class="cv-t" style="font-size:12px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.title||'')}</div></div>
      <div class="cv-actions" style="display:flex;gap:6px;flex-shrink:0">
        <button type="button" class="btn ghost cv-b" data-cth-restore="${idx}">↩ 恢复为此标题</button>
        <button type="button" class="btn ghost cv-b" data-cth-del="${idx}">🗑 删除</button>
      </div>
    </div>`).join('');
  const ov = document.createElement('div'); ov.id='cthPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🕘 章节标题 · 单历（${hist.length}/50）</b>
        <button class="gs-x" data-cth-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-div">仅记录您手动修改单个标题前的旧标题；整批重生成/整批恢复走「版本」，不会混入本列表。可一键恢复或删除某条记录；恢复会把当前标题也记入本列表。</div>
        ${rows}
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-cth-close]').onclick = closeChTitleHistoryPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeChTitleHistoryPanel(); });
  ov.addEventListener('click', e=>{
    const rb = e.target.closest('[data-cth-restore]'); if(!rb) return;
    const h = hist[+rb.dataset.cthRestore]; if(!h) return;
    if(!window.confirm(`把第${h.i+1}章标题恢复为「${h.title}」？`)) return;
    setChapterTitle(h.i, h.title);
    closeChTitleHistoryPanel(); render();
    toast('已恢复该标题');
  });
  ov.addEventListener('click', e=>{
    const db = e.target.closest('[data-cth-del]'); if(!db) return;
    const idx = +db.dataset.cthDel;
    const o2 = state.outline;
    if(o2 && Array.isArray(o2.chTitleHistory)) o2.chTitleHistory.splice(idx,1);
    persist(); closeChTitleHistoryPanel(); render();
    toast('已删除该记录');
  });
}
function closeChTitleHistoryPanel(){ const p=$('#cthPanel'); if(p) p.remove(); }

/* ---------- v10.16 章节标题·批量版本回退（整批快照 ≤5 份，独立于单条曾用标题） ---------- */
function chTitleBatches(){ const o=state.outline; return (o && Array.isArray(o.chTitleBatches)) ? o.chTitleBatches : []; }
// 把「当前全部章节标题」整批压入版本栈（最新在前；与最新一份相同则跳过去重；上限5）
function snapshotTitleBatch(label){
  const o = state.outline; if(!o) return;
  const titles = (o.chapters||[]).map(c=> (c&&c.title)||'');
  if(!Array.isArray(o.chTitleBatches)) o.chTitleBatches = [];   // fixed: 先挂回 state.outline，persist 才存得住
  const bt = o.chTitleBatches;
  if(bt.length && JSON.stringify(bt[0].titles) === JSON.stringify(titles)) return;
  const d = new Date();
  const t = (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  bt.unshift({ ts: Date.now(), label: `${t} · ${label||'生成批次'}`, titles });
  if(bt.length > 50) bt.length = 50;
  persist();
}
// 整批应用某版本：先把当前态也归档（保留再回退机会），再覆盖全部标题
function applyTitleBatch(idx){
  const bt = chTitleBatches(); const b = bt[idx]; if(!b) return;
  const n = (b.titles||[]).length;
  if(!confirm(`整批恢复「${idx+1}. ${b.label||'标题版本'}」（共 ${n} 章）？将覆盖当前全部章节标题。`)) return;
  snapshotTitleBatch('切换前');
  const titles = (Array.isArray(b.titles)?b.titles:[]).map(t=>String(t||'').trim()).filter(Boolean);
  setAllTitles(titles);
  snapshotTitleBatch('本次恢复结果');   // v10.34 记录整批恢复后的结果版本
  closeTitleBatchPreview(); closeChTitleBatchPanel();
  render();
  toast(`已整批应用该版本标题（${titles.length} 章）`);
}
function deleteTitleBatch(idx){
  const o = state.outline; if(!o) return;
  const bt = chTitleBatches(); if(!bt.length) return;
  bt.splice(idx,1);
  if(!bt.length) delete o.chTitleBatches; else o.chTitleBatches = bt;
  persist();
  closeTitleBatchPreview(); closeChTitleBatchPanel(); openChTitleBatchPanel();
  toast('已删除该版本');
}
function openChTitleBatchPanel(){
  closeChTitleBatchPanel();
  const bt = chTitleBatches();
  if(!bt.length){ toast('暂无批量版本，执行「重生成全部标题」后自动记录'); return; }
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const rows = bt.map((b,idx)=>`
    <div class="cv-row">
      <div class="cv-meta" style="flex:1;min-width:0">
        <div class="cv-time">${idx+1}. <b style="color:var(--accent2)">${esc((b.label||'').split(' · ')[0]||fmtTs(b.ts))}</b>${esc((b.label||'').split(' · ')[1]?' · '+b.label.split(' · ')[1]:'')} · ${(b.titles||[]).length} 章</div>
        <div class="cv-t" style="font-size:12px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((b.titles||[]).slice(0,2).join(' / '))||'（空）'}…</div>
      </div>
      <div class="cv-actions" style="display:flex;gap:6px;flex-shrink:0">
        <button type="button" class="btn ghost cv-b" data-batch-view="${idx}">👁 预览</button>
        <button type="button" class="btn primary cv-b" data-batch-apply="${idx}">应用</button>
        <button type="button" class="btn ghost cv-b" data-batch-del="${idx}">🗑</button>
      </div>
    </div>`).join('');
  const ov = document.createElement('div'); ov.id='ctbPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🔁 章节标题 · 批量版本（${bt.length}/50）</b>
        <button class="gs-x" data-ctb-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-div">「重生成全部标题」会把改动前/后的整批标题各归档一份（≤50 份可回退）；每行可👁预览整批，或点「应用」整批恢复。单条手改标题的记录仍在「单历」查看。</div>
        ${rows}
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-ctb-close]').onclick = closeChTitleBatchPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeChTitleBatchPanel(); });
  ov.querySelectorAll('[data-batch-view]').forEach(b=> b.onclick = ()=> openTitleBatchPreview(+b.dataset.batchView));
  ov.querySelectorAll('[data-batch-apply]').forEach(b=> b.onclick = ()=> applyTitleBatch(+b.dataset.batchApply));
  ov.querySelectorAll('[data-batch-del]').forEach(b=> b.onclick = ()=> deleteTitleBatch(+b.dataset.batchDel));
}
function closeChTitleBatchPanel(){ const p=$('#ctbPanel'); if(p) p.remove(); }
// 单版整批标题完整预览（可自由切换查看）；点「应用此版本」才真正生效
function openTitleBatchPreview(idx){
  closeTitleBatchPreview();
  const bt = chTitleBatches(); const b = bt[idx]; if(!b) return;
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const list = (b.titles||[]).map((t,i)=>`<div class="cv-row"><div class="cv-t" style="font-size:12px">第${i+1}章　${esc(t||'')}</div></div>`).join('') || '<p class="muted">（空批）</p>';
  const ov = document.createElement('div'); ov.id='ctbPreview'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>👁 版本预览 · ${esc(b.label||'标题版本')}（${fmtTs(b.ts)} · ${(b.titles||[]).length} 章）</b>
        <button class="gs-x" data-ctbp-close>✕</button></div>
      <div class="cv-body"><div style="max-height:60vh;overflow:auto">${list}</div></div>
      <div class="modal-actions" style="padding:12px 16px;border-top:1px solid var(--line)">
        <button type="button" class="btn ghost cv-b" data-ctbp-close2>取消</button>
        <button type="button" class="btn primary cv-b" data-ctbp-apply>✔ 应用此版本</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-ctbp-close]').onclick = closeTitleBatchPreview;
  ov.querySelector('[data-ctbp-close2]').onclick = closeTitleBatchPreview;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeTitleBatchPreview(); });
  ov.querySelector('[data-ctbp-apply]').onclick = ()=> applyTitleBatch(idx);
}
function closeTitleBatchPreview(){ const p=$('#ctbPreview'); if(p) p.remove(); }

// v225/P5-B：regenAllTitles（卡片"重生成"入口）已整体移除——标题生成只归「全书规划师」。
// v11 标题统一 user 拼装：规划师 titles 阶段（genPlannerTitles）共用。
// 4.7 Pro（3.3 原码）：统一注入 tone / 结构 / 风格信息；opts.n（首次）与 opts.req（重生成）双路。
function titlesGenUser(opts){
  opts = opts || {};
  const o = state.outline || {};
  const parts = [];
  const anchor = outlineAnchorBlock();
  parts.push(anchor ? `${anchor}\n【小说标题】${o.title||''}\n【小说简介】${o.logline||''}` : `【小说标题】${o.title||''}\n【小说简介】${o.logline||''}`);
  parts.push(`【原始构想】${o.userIdea||state.idea||''}`);
  parts.push(`【整体情绪基调】${o.tone || '未指定'}`);
  parts.push(`【长篇结构设计】${JSON.stringify(o.structure || {})}`);
  parts.push(`【设定词典】${chapterGlossaryBlock()}`);
  // 注入风格说明
  const styleNote = chapterStyleNote();
  if(styleNote) parts.push(styleNote);
  if(opts.n){
    parts.push(`请生成恰好 ${opts.n} 个章节标题（第1章…第${opts.n}章）。只输出如下 JSON：{"titles":["第1章 标题",...,"第${opts.n}章 标题"]}。标题数量必须严格等于 ${opts.n}，每个标题≤18字。`);
  } else {
    const existing = (o.chapters||[]).map((c,i)=>`第${i+1}章 ${(c&&c.title)||''}`).join(' / ');
    if(existing) parts.push(`【现有章节标题】${existing}`);
    if(opts.req) parts.push(`【重生成要求】${opts.req}`);
    parts.push(`请重生成全部 ${o.chapters.length} 个章节标题。只输出如下 JSON：{"titles":["第1章 标题",...]}。数量必须严格等于 ${o.chapters.length}。`);
  }
  return parts.join('\n\n');
}

// 4.7 Pro（3.3 原码）：标题解析后校验（数量 + 格式「第N章 」+ ≤18 字）
function validateTitleOutput(j, expectedN){
  if(!j || !Array.isArray(j.titles)) return {ok:false, code:'NOT_ARRAY'};
  if(j.titles.length !== expectedN) return {ok:false, code:'COUNT_MISMATCH', details:`${j.titles.length} vs ${expectedN}`};
  const re = /^第\d+章\s+.{1,18}$/;
  const bad = j.titles.map((t,i)=> re.test(String(t||'').trim()) ? null : i).filter(i=>i!==null);
  if(bad.length) return {ok:false, code:'FORMAT_ERROR', details:bad};
  return {ok:true};
}
// 新卡片界面：标题候选评分与构建 UI 数据
function buildTitleCandidates(cands, expectedN){
  const valid = cands.filter(c => c && c.ok && c.data && Array.isArray(c.data.titles));
  if(!valid.length) return [];
  const g = (state.outline && state.outline.glossary) || {};
  const names = new Set([
    ...(g.characters||[]).map(x=>String(x.name||'').trim()),
    ...(g.places||[]).map(x=>String(x.name||'').trim()),
    ...(g.propernouns||[]).map(x=>String(x.name||'').trim())
  ]);
  const re = /^第\d+章\s+.{1,18}$/;
  return valid.map(res => {
    const titles = res.data.titles.map(t => String(t||'').trim());
    const clean = titles.map(t => t.replace(/^第\d+章\s+/, ''));
    let s = 0; let dup = 0; let hits = 0;
    titles.forEach(t => { if(re.test(t)) s += 2; });
    for(let i=1;i<clean.length;i++) if(clean[i] === clean[i-1]) dup++;
    clean.forEach(t => { for(const n of names) if(n && t.includes(n)) hits++; });
    s -= dup * 5; s += hits;
    return { valid: titles.length===expectedN && titles.every(t=>re.test(t)), titles, dupRate: dup, glossRate: hits, score: s, raw: res.data };
  }).sort((a,b)=>b.score - a.score);
}
function applyTitleCandidate(cand, n, isRegen){
  const _tr = validateTitleOutput(cand.raw, n);
  if(!_tr.ok) throw new Error(`标题输出校验失败：${_tr.code} ${_tr.details||''}`);
  const titles = cand.titles.filter(Boolean);
  if(isRegen){
    snapshotTitleBatch('重生成前');
    const cnt = setAllTitles(titles);
    snapshotTitleBatch('本次重生成结果');
    const o = state.outline;
    if(Array.isArray(o.chapterPlans) && o.chapterPlans.some(Boolean)){
      toast(`已重生成 ${cnt} 个标题；主线简述可能与新标题不匹配，建议重生成规划师`);
    } else toast(`已重生成 ${cnt} 个章节标题`);
  } else {
    const o0 = state.outline; if(!o0) { toast('请先生成大纲'); return; }
    o0.chapters = titles.map(t=>({ title: t }));
    state.chapters = titles.map((t,i)=>({ title:t, content:'', strip:'', confirmed:false }));
    setAllTitles(titles);
    persist(); render();
    if(Array.isArray(o0.chapterPlans) && o0.chapterPlans.some(Boolean)){
      toast(`已生成 ${titles.length} 个章节标题；主线简述可能与新标题不匹配，建议重生成规划师`);
    } else toast(`已生成 ${titles.length} 个章节标题`);
  }
}

// 4.8 旗舰版（板块二-5）：标题多候选择优。评分维度：数量契约硬通过、相邻重名率低、专有名词/关键词命中率高。
function pickBestTitles(cands, expectedN){
  const ui = buildTitleCandidates(cands, expectedN);
  if(!ui.length) return cands.find(c => c && !c.ok) || {ok:false, error:'所有标题候选均失败'};
  return { ok:true, data: ui[0].raw };
}

// v225/P5-B：genAllTitles（卡片"生成全部章节标题"入口）已整体移除——填完章节数直接进规划师（ensureChaptersPlaceholder 占位 + genPlannerTitles 生成）。

// v10.19 主线简述区块：暗红渐变色卡片，独立设计通用于所有主题
function chapterPlanBlock(){
  const o = state.outline;
  const plans = (o && Array.isArray(o.chapterPlans)) ? o.chapterPlans : [];
  const hasPlans = plans.some(Boolean);
  const collapsed = !!state.cpCollapsed;
  const items = plans.map((p,i)=>{
    // 4.6 Plus（2.2）：items 渲染改造为节拍表版（normalizeOutline 已保证 p 为对象）
    const beats = (p && Array.isArray(p.beats)) ? p.beats : [];
    const beatHtml = beats.map((b, bi)=>`
      <div class="bs-beat" data-bs-beat="${i}:${bi}">
        <span class="bs-type">${({setup:'铺垫',rise:'推进',climax:'燃点',hook:'悬念'})[b.type] || b.type || 'beat'}</span>
        <input type="text" class="bs-event" data-bs-event="${i}:${bi}" value="${esc(b.event||'')}" placeholder="事件">
        <input type="text" class="bs-emo" data-bs-emo="${i}:${bi}" value="${esc(b.emotional||'')}" placeholder="情绪">
        <input type="text" class="bs-ent" data-bs-ent="${i}:${bi}" value="${esc((b.requiredEntities||[]).join('、'))}" placeholder="必须实体（顿号分隔）">
        <input type="text" class="bs-fore" data-bs-fore="${i}:${bi}" value="${esc((b.foreshadowing||[]).join('、'))}" placeholder="伏笔（顿号分隔）">
      </div>
    `).join('');
    return `
      <div class="cp-item" data-cp-item="${i}">
        <span class="cp-no">${i+1}</span>
        <div class="cp-body-col">
          <textarea class="cp-input" rows="3" data-cp-set="${i}" data-orig="${esc(p.summary||'')}" placeholder="本章主线简述（可编辑）">${esc(p.summary||'')}</textarea>
          <div class="bs-block">
            <div class="bs-head">节拍表 <button type="button" class="btn small ghost" data-bs-add="${i}">＋ 补全四段</button></div>
            ${beatHtml || '<span class="muted">暂无节拍，可点上方按钮由 AI 补齐</span>'}
          </div>
        </div>
        <span class="cp-wc">${(p.summary||'').length}字</span>
      </div>`;
  }).join('');
  return `<div class="card cp-card">
    <div class="cp-head" data-cp-fold role="button" tabindex="0" title="展开/收起">
      <div class="cp-head-top">
        <div class="cp-head-left">
          <h3>🧭 全书规划师 <span class="cp-arrow">${collapsed?'▸':'▾'}</span></h3>
        </div>
      </div>
      <div class="cp-head-row action-row">
        <button type="button" class="btn ghost" data-cp-raw title="手动提取 AI 原始响应数据，当自动更新失败时使用">🔧</button>
        ${hasChapterPlansHistory()?`<button type="button" class="btn ghost" data-cp-hist>📚 版本(${chapterPlansHistoryCount()})</button>`:''}
      </div>
    </div>
    <div class="cp-body"${collapsed?' hidden':''}>
      <div class="cp-stagebar">
        <button type="button" class="cp-stage-all" data-cp-all title="按顺序一键执行 5 个规划师阶段（①主线简述→②章节标题→③节拍表→④万物词典→⑤伏笔网）">⚡ 一键五步</button>
        ${PLANNER_STAGES.map(st=>{
          const done = plannerStageDone(st.id);
          return `<button type="button" class="cp-stage ${done?'done':'undone'}" data-cp-stage="${st.id}" title="${st.label}：${done?'已完成（点击可重新生成）':'未完成（点击生成）'}">
            <i class="cp-dot">${done?'✓':'·'}</i>${st.num}${st.label}
          </button>`;
        }).join('')}
      </div>
      <div class="cp-stage-hint muted">按顺序生成效果最佳；任一步失败可单独点该步重跑，不影响已完成步骤。</div>
      ${hasPlans ? `<div class="cp-list">${items}</div>
        <p class="muted" style="margin:6px 0 0">每条主线简述可编辑，失焦即存；写正文时注入为【本章主线简述】（辅助参考）。</p>`
        : `<p class="sub">可选步骤：分五步规划全书——①每章主线简述（本书叙事第一层骨架）、②定稿全书章节标题、③每章四段节拍表、④初期万物词典、⑤跨章伏笔网。按顺序生成效果最佳，任一步可单独重跑；不做也不影响默认流程。</p>`}
    </div>
  </div>`;
}

// v10.19 梗概卡折叠绑定：点击标题行切换，状态持久化
function bindChapterPlanFold(){
  const head = $('[data-cp-fold]');
  if(!head) return;
  head.onclick = (e)=>{
    if(e.target.closest('[data-cp-hist]') || e.target.closest('[data-cp-all]') || e.target.closest('[data-cp-stage]') || e.target.closest('[data-cp-raw]') || e.target.closest('.stop-btn')) return;   // 不拦截版本/生成/原始数据/停止按钮
    state.cpCollapsed = !state.cpCollapsed;
    persist();
    const body = $('.cp-body'); if(body) body.hidden = state.cpCollapsed;
    const ico = head.querySelector('.cp-arrow'); if(ico) ico.textContent = state.cpCollapsed ? '▸' : '▾';
  };
}
// v10.11 主线简述绑定：一键五步 / 五阶段独立按钮 / 逐条编辑即存
function bindChapterPlan(){
  const all = $('[data-cp-all]');
  if(all) all.onclick = ()=> genPlannerAll(all);
  $$('[data-cp-stage]').forEach(btn=>{
    btn.onclick = ()=>{
      const stage = btn.dataset.cpStage;
      if(plannerStageDone(stage) && !confirm(`将重新生成「${stageLabel(stage)}」，覆盖现有内容，继续？`)) return;
      genPlannerStage(btn, stage);
    };
  });
  const hist = $('[data-cp-hist]');
  if(hist) hist.onclick = ()=> openChapterPlansHistoryPanel();
  const rawBtn = $('[data-cp-raw]');
  if(rawBtn) rawBtn.onclick = ()=> openCpRawPanel();
  $$('[data-cp-set]').forEach(inp=>{
    // 实时更新字数
    inp.oninput = ()=>{
      const wc = inp.parentNode && inp.parentNode.querySelector('.cp-wc');
      if(wc) wc.textContent = inp.value.length + '字';
    };
    inp.onchange = ()=>{
      const o = state.outline; if(!o) return;
      if(!Array.isArray(o.chapterPlans)) o.chapterPlans = [];
      const i = +inp.dataset.cpSet;
      if(inp.value === inp.dataset.orig) return;
      // 4.6 Plus：normalizeOutline 后 plan 为对象（含 beats），编辑简述只更新 summary，不覆盖整个对象
      const cur = o.chapterPlans[i];
      if(cur && typeof cur === 'object'){ cur.summary = inp.value; }
      else { o.chapterPlans[i] = inp.value; }
      inp.dataset.orig = inp.value;
      persist();
      toast('本章主线简述已保存，后续生成章节生效');
    };
  });
}

// 4.6 Plus（2.2）节拍表绑定：自动补齐四段 + 四字段编辑即存
function bindBeatSheet(){
  const o = state.outline; if(!o) return;
  // 自动补齐四段
  $$('[data-bs-add]').forEach(btn=>{
    btn.onclick = ()=>{
      const i = +btn.dataset.bsAdd;
      if(!Array.isArray(o.chapterPlans)) return;
      const p = o.chapterPlans[i] || {};
      if(!p.beats || p.beats.length < 4){
        p.beats = p.beats || [];
        const types = ['setup','rise','climax','hook'];
        for(let k=p.beats.length; k<4; k++){
          p.beats.push({ type:types[k], event:'', emotional:'', requiredEntities:[], foreshadowing:[] });
        }
        persist(); render();
      }
    };
  });
  // 编辑保存
  $$('[data-bs-event],[data-bs-emo],[data-bs-ent],[data-bs-fore]').forEach(inp=>{
    inp.onchange = ()=>{
      const [i,bi] = inp.dataset.bsEvent || inp.dataset.bsEmo || inp.dataset.bsEnt || inp.dataset.bsFore;
      const [ii,bbi] = (inp.dataset.bsEvent || inp.dataset.bsEmo || inp.dataset.bsEnt || inp.dataset.bsFore).split(':');
      const idx = +ii, bIdx = +bbi;
      const p = o.chapterPlans[idx]; if(!p || !p.beats[bIdx]) return;
      if(inp.dataset.bsEvent) p.beats[bIdx].event = inp.value.trim();
      if(inp.dataset.bsEmo) p.beats[bIdx].emotional = inp.value.trim();
      if(inp.dataset.bsEnt) p.beats[bIdx].requiredEntities = inp.value.split(/[,，、]/).map(s=>s.trim()).filter(Boolean);
      if(inp.dataset.bsFore) p.beats[bIdx].foreshadowing = inp.value.split(/[,，、]/).map(s=>s.trim()).filter(Boolean);
      persist(); toast(`第 ${idx+1} 章节拍已保存`);
    };
  });
}

// v2.4 词典人物字段检查：7 字段完整性三态（缺失红 / 未知黄 / 齐全 ✅）
function glossaryFieldCheck(){
  const g = (state.outline && state.outline.glossary) || {};
  const rows = [];
  (g.characters||[]).forEach(c=>{
    const missing = CHAR_FIELDS.filter(k=> c[k]==null || String(c[k]).trim()==='');
    const unknown = CHAR_FIELDS.filter(k=> String(c[k]||'').trim()==='未知');
    if(missing.length || unknown.length) rows.push({ name: String(c.name||'未命名').trim(), missing, unknown });
  });
  return rows;
}
function glossaryCheckCount(){ return glossaryFieldCheck().length; }
// v1.0.106 后置软审计：对词典人物做「属性自洽」低置信检查（不阻断，仅软提示）。
// 只标记高风险矛盾；命中转世/穿越/长生/修仙/永生/不老等豁免词则跳过，避免误伤超自然设定。
function parseAgeNum(v){
  if(v==null) return null;
  const s = String(v).replace(/[，。、；：,.；\s\/~\-]/g,'');
  const m = s.match(/([0-9一二三四五六七八九十百]+)/g);
  if(!m) return null;
  const n = m[m.length-1];
  const c = n.match(/^[0-9]+$/) ? parseInt(n,10) : /^[一二三四五六七八九十]{1,2}$/.test(n) ? (Array.from(n).reduce((a,ch)=>{const t={'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10}[ch]; return a + (ch==='十'?(a?10:0):t);},0)||10) : null;
  return c;
}
function auditGlossaryPlausibility(){
  const g = (state.outline && state.outline.glossary) || {};
  const EXEMPT = /长生|修仙|修者|转世|穿越|永生|不朽|不老|活了几百|活了一百|千百岁|岁月如刀|修真|修仙界|活了\s*\d+\s*岁|永世|不死不灭|寿元/;
  const rows = [];
  (g.characters||[]).forEach(c=>{
    const name = String(c.name||'未命名').trim();
    const ageStr = String(c.age||'').trim();
    if(!ageStr) return;
    const n = parseAgeNum(ageStr);
    if(n==null) return;
    const txt = ['identity','hobby','relation','trait'].map(k=>String(c[k]||'')).join('，');
    if(EXEMPT.test(txt)) return;                       // 超自然豁免：不校验数值
    const yre = txt.match(/(?:已|在此|从小|在这|于此|待了)?\s*([0-9一二三四五六七八九十]+)\s*年(?:了|的|多|整)?/g) || [];
    yre.forEach(ym=>{
      const m = ym.match(/([0-9一二三四五六七八九十]+)/);
      const yrs = m ? parseAgeNum(m[1]) : null;
      if(yrs!=null && yrs>1 && n<yrs+2){
        rows.push({ name, reason:`设定提到「${ym.trim()}」，但年龄仅${ageStr}，疑似自相矛盾（软提示，可人工修正）` });
      }
    });
    if(/父|母|父亲|母亲|亲/.test(txt) && n<=8){ rows.push({ name, reason:`年龄${ageStr}却担"父亲/母亲"类亲老关系，疑似过早（软提示，可人工修正）` }); }
  });
  // 去重（同一人物多条只留首条，避免刷屏）
  const seen = {}; const out = [];
  rows.forEach(r=>{ if(!seen[r.name]){ seen[r.name]=1; out.push(r); } });
  return out;
}
function plausibilityCount(){ return auditGlossaryPlausibility().length; }
function openGlossaryCheckPanel(){
  closeGlossaryCheckPanel();
  const rows = glossaryFieldCheck();
  const plaus = auditGlossaryPlausibility();
  const plausBody = plaus.length ? `<div class="cv-div" style="margin-top:8px">⚠️ 属性自洽软提示（${plaus.length}）：以下为低置信猜测，可能与修仙/转世/长生等设定冲突而误报，可人工修正或忽略，不影响流程。</div>` + plaus.map(r=>
    `<div class="cv-row"><div class="cv-meta" style="flex:1;min-width:0">
      <div class="cv-time">${esc(r.name)}</div>
      <div class="cv-t" style="font-size:12px;line-height:1.6"><span class="gs-unk">自洽：${esc(r.reason)}</span></div>
    </div></div>`
  ).join('') : '';
  const body = rows.length ? rows.map(r=>{
    const m = r.missing.map(k=>CHAR_FIELD_LABEL[k]).join('、');
    const u = r.unknown.map(k=>CHAR_FIELD_LABEL[k]).join('、');
    return `<div class="cv-row">
      <div class="cv-meta" style="flex:1;min-width:0">
        <div class="cv-time">${esc(r.name)}</div>
        <div class="cv-t" style="font-size:12px;line-height:1.6">
          ${m?`<span class="gs-miss">缺失：${m}</span>`:''} ${u?`<span class="gs-unk">未知：${u}（建议补全）</span>`:''}
        </div>
      </div>
    </div>`;
  }).join('') : '<p class="muted">✅ 全部人物字段齐全（身份/岁数/性别/外貌/爱好/关系/性格），无缺失、无未知。</p>';
  const ov = document.createElement('div'); ov.id='gsCheckPanel'; ov.className='gs-overlay';
  ov.innerHTML = `<div class="gs-modal">
    <div class="gs-modal-head"><b>🔍 词典人物字段检查（${rows.length}）</b><button class="gs-x" data-gsck-close>✕</button></div>
    <div class="cv-body">
      <div class="cv-div">生成章节时，人物 7 字段会完整注入给章节 AI；字段缺失或「未知」会导致 AI 信息不足而写错内容。可点开对应词典条目补全，补全后对后续生成的章节生效。</div>
      ${body}
      ${plausBody}
    </div></div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-gsck-close]').onclick = closeGlossaryCheckPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeGlossaryCheckPanel(); });
}
function closeGlossaryCheckPanel(){ const p=$('#gsCheckPanel'); if(p) p.remove(); }

// v226/8.2 「🆕 新增」面板：列出最近自动入典的新实体（来源章节/方式 + 真实入库时间），支持定位与移除，可一键全部标为已读。
// 溯源信息存在词条自身（_srcCh/_srcHow/_srcTs），无独立日志表——条目被移除即随条目消失，无双写漂移。
function openGlossaryNewPanel(){
  closeGlossaryNewPanel();
  const o = state.outline; if(!o){ toast('尚无词典'); return; }
  const gl = o.glossary || {characters:[], places:[], propernouns:[]};
  const seen = Number(state._glossSeenTs) || 0;
  const kinds = [['characters','人物','char'],['places','地点','place'],['propernouns','专名','proper']];
  const flat = ()=> kinds.flatMap(([k,lab,type])=> (gl[k]||[]).map((x,i)=> ({x, k, lab, type, i})))
    .filter(r=> r.x && r.x._auto && (r.x._srcTs||0) > seen)
    .sort((a,b)=> (b.x._srcTs||0) - (a.x._srcTs||0));
  const rows = flat();
  const fmtTs = ts => new Date(ts||Date.now()).toLocaleString('zh-CN',{hour12:false});
  const srcLabel = x => x._srcCh ? `来自第 ${x._srcCh} 章` : (x._srcHow || '批量提取');
  const body = rows.length ? rows.slice(0,50).map((r,pos)=>`
    <div class="cv-row">
      <div class="cv-meta" style="flex:1;min-width:0">
        <div class="cv-time">${esc(r.lab)} · ${esc(String(r.x.name||'').trim())}</div>
        <div class="cv-t" style="font-size:12px;line-height:1.6"><span class="gs-unk">${esc(srcLabel(r.x))} · ${fmtTs(r.x._srcTs)}</span></div>
      </div>
      <button type="button" class="btn ghost gs-tool" data-gsn-locate="${pos}" title="在词典中展开并高亮该条目">定位</button>
      <button type="button" class="btn ghost gs-tool" data-gsn-remove="${pos}" title="从词典移除该条目">移除</button>
    </div>`).join('') : '<p class="muted">✅ 暂无未读的自动入典新实体。</p>';
  const ov = document.createElement('div'); ov.id='gsNewPanel'; ov.className='gs-overlay';
  ov.innerHTML = `<div class="gs-modal">
    <div class="gs-modal-head"><b>🆕 最近自动入典（${rows.length}${rows.length>50?'，显示前 50 条':''}）</b><button class="gs-x" data-gsn-close>✕</button></div>
    <div class="cv-body">
      <div class="cv-div">以下为自动补全新入典的实体（逐章提取 / 批量兜底 / 手动提取）；「全部标为已读」后红点角标消失，溯源信息仍保留在词条上。</div>
      ${body}
    </div>
    <div style="padding:10px 14px;border-top:1px solid rgba(127,127,127,.25);display:flex;gap:8px;justify-content:flex-end">
      <button type="button" class="btn ghost" data-gsn-seen ${rows.length?'':'hidden'}>全部标为已读</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-gsn-close]').onclick = closeGlossaryNewPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeGlossaryNewPanel(); });
  $$('[data-gsn-locate]', ov).forEach(b=> b.onclick = ()=>{
    const r = flat()[+b.dataset.gsnLocate]; if(!r) return;
    closeGlossaryNewPanel();
    state.gsCatFold = state.gsCatFold || {}; state.gsCatFold[r.type] = false;
    persist(); renderGlossaryOnly();
    const box = $(`[data-gs-entry="${r.type}:${r.i}"]`);
    if(box){
      box.classList.add('open'); const ico = box.querySelector('.gs-fold-ico'); if(ico) ico.textContent='▾';
      box.scrollIntoView({behavior:'smooth', block:'center'});
      box.classList.add('gs-flash'); setTimeout(()=> box.classList.remove('gs-flash'), 1600);
    }
  });
  $$('[data-gsn-remove]', ov).forEach(b=> b.onclick = ()=>{
    const r = flat()[+b.dataset.gsnRemove]; if(!r) return;
    if(!confirm(`从词典移除「${String(r.x.name||'').trim()}」？（${srcLabel(r.x)}）`)) return;
    const arr = gl[r.k] || []; const gi = arr.indexOf(r.x); if(gi>=0) arr.splice(gi,1);
    persist(); renderGlossaryOnly(); closeGlossaryNewPanel(); openGlossaryNewPanel();   // 重开以刷新列表与角标
  });
  const seenBtn = ov.querySelector('[data-gsn-seen]');
  if(seenBtn) seenBtn.onclick = ()=>{ state._glossSeenTs = Date.now(); persist(); renderGlossaryOnly(); closeGlossaryNewPanel(); toast('已全部标为已读'); };
}
function closeGlossaryNewPanel(){ const p=$('#gsNewPanel'); if(p) p.remove(); }

// 万物词典「设定表」卡片：展示人物/地名/专名，用户可更正错名（决策9）
// 词典是全文一致性准则，可小幅修正，但禁用删除（应由大纲确立）。
function glossaryCardHtml(){
  const g = (state.outline && state.outline.glossary) || {characters:[], places:[], propernouns:[]};
  const gl = ()=>state.outline.glossary = state.outline.glossary || {characters:[],places:[],propernouns:[]};
  const empty = !(g.characters&&g.characters.length) && !(g.places&&g.places.length) && !(g.propernouns&&g.propernouns.length) && !(g.subplots&&g.subplots.length);
  const hasBody = state.chapters.some(c=>c && c.content);   // 是否有正文可做覆盖面统计（阶段4）
  // v226/8.2 「🆕 新增」徽标：_srcTs 晚于已读水位线的自动入典条目数（旧存档词条无 _srcTs 恒不标新）
  const seen = Number(state._glossSeenTs) || 0;
  const newCount = [...(g.characters||[]), ...(g.places||[]), ...(g.propernouns||[])].filter(x=> x && x._auto && (x._srcTs||0) > seen).length;
  const tools = `<span class="gs-tools">
    <button type="button" class="btn ghost gs-tool" data-gs-history>🕘 历史更改</button>
    <button type="button" class="btn ghost gs-tool" data-gs-check ${glossaryCheckCount()+plausibilityCount()?'':'hidden'} title="人物 7 字段完整性 + 属性自洽软审计：缺失/未知标出，建议补全">🔍 字段检查${(glossaryCheckCount()+plausibilityCount())?`<b class="gs-check-badge" ${plausibilityCount()&&!glossaryCheckCount()?'style="background:#b8860b"':''}>${glossaryCheckCount()||plausibilityCount()}</b>`:''}</button>
    <button type="button" class="btn ghost gs-tool" data-gs-coverage ${hasBody?'':'hidden'}>📊 覆盖面</button>
    <button type="button" class="btn ghost gs-tool" data-gs-new ${newCount?'':'hidden'} title="查看最近自动入典的新实体（来源章节 + 实际入库时间）">🆕 新增${newCount?`<b class="gs-check-badge">${newCount}</b>`:''}</button>
    <button type="button" class="btn ghost gs-tool" data-gs-extract ${hasBody?'':'hidden'} title="从已生成正文提取词典未收录的新人物/地名/专名并入库">📥 提取新增</button>
    <button type="button" class="btn ghost gs-tool" data-gs-clean ${hasBody?'':'hidden'} title="清理在全部已生成正文中均未出现的条目（如重生成覆盖后失效的旧人物）">🧹 清理未使用</button>
    <button type="button" class="btn ghost gs-tool" data-gs-export>导出 JSON</button>
    <button type="button" class="btn ghost gs-tool" data-gs-import>导入 JSON</button>
    <label class="gs-autofill" title="批量生成章节后自动提取新实体入词典"><input type="checkbox" data-gs-autofill ${state.glossAutoFill?'checked':''} /> 自动补全</label>
    <label class="gs-autofill" title="每章生成后自动吸收副线进度；只有章节正文 AI 会新增/推进副线"><input type="checkbox" data-gs-subfill ${state.subAutoFill?'checked':''} /> 副线追踪</label>
    <button type="button" class="btn ghost gs-tool" data-gs-subboard ${(g.subplots&&g.subplots.length)?'':'hidden'} title="列出未收束且消失过久的副线，提示是否安排回归">🧵 副线看板</button>
    <input type="file" id="gsImportFile" accept=".json,application/json" hidden />
  </span>`;
  if(empty) return `<div class="card"><h3 class="gs-card-title">📇 设定表 · 万物词典 ${tools}</h3><p class="sub">当前大纲未含万物词典。此词典会在生成大纲时自动确立，作为全书人名/地名/专名的一致性基准；请重生成大纲以启用。</p></div>`;
  // 可折叠条目：点击展开/收起该条目全部字段（建议1·此轮）
  // 折叠态只显示名字 + 一行简述；展开态显示该条全部可编辑介绍，文字再多也能全部看到。
  const fmt = (o, keys)=>{ const ks = (keys||[]).filter(k=>o[k]); return ks.map(k=>o[k]).join(' · '); };
  const entry = (o, type, i, nameKeys, detailKeys)=>{
    const name = o.name || '';
    const brief = fmt(o, nameKeys);
    // v226/8.2 折叠态「🆕·第N章」角标：悬停显示来源与真实入库时间
    const newTag = (o._auto && (o._srcTs||0) > (Number(state._glossSeenTs)||0)) ? `<span class="gs-newtag" title="自动入典：${o._srcCh?('来自第 '+o._srcCh+' 章'):esc(o._srcHow||'批量提取')} · ${new Date(o._srcTs||Date.now()).toLocaleString('zh-CN',{hour12:false})}">🆕${o._srcCh?('·第'+o._srcCh+'章'):''}</span>` : '';
    const detail = detailKeys.map(k=>({k, v:o[k]})).filter(x=>x.v).map(x=>`<label class="gs-f"><span>${kLabel(x.k)}</span><input type="text" data-gs-set="${type}" data-gs-idx="${i}" data-gs-key="${x.k}" data-orig="${esc(x.v)}" value="${esc(x.v)}" /></label>`).join('');
    // 折叠态：名字 + 简述（可点）；展开态：把名字也变成可编辑 + 全字段
    return `<div class="gs-entry" data-gs-entry="${type}:${i}">
      <div class="gs-head" role="button" tabindex="0" data-gs-toggle="${type}:${i}">
        <span class="gs-fold-ico">▸</span>
        <input type="text" class="gs-name" data-gs-name="${type}:${i}" data-orig="${esc(name)}" value="${esc(name)}" placeholder="名称" />
        <span class="gs-brief">${esc(brief||'（无简介，点击展开编辑）')}</span>
        ${newTag}
      </div>
      <div class="gs-detail">
        ${detail}
      </div>
    </div>`;
  };
  const kLabel = k => ({name:'名称', identity:'身份', age:'岁数', gender:'性别', appearance:'外貌', hobby:'爱好', relation:'关系', trait:'性格', type:'类型', note:'说明', question:'核心问题', pivot:'蝴蝶效应'}[k]||k);
  const chars = (g.characters||[]).map((c,i)=>entry(c,'char',i,['identity','gender','age'],['name','identity','age','gender','appearance','hobby','relation','trait'])).join('');
  const places = (g.places||[]).map((p,i)=>entry(p,'place',i,['type','note'],['name','type','note'])).join('');
  const props = (g.propernouns||[]).map((p,i)=>entry(p,'proper',i,['note'],['name','note'])).join('');
  // v1.0.113 副线条目：名称可编辑 + status 三态 select + question/arc/pivot 可编辑 + 进度只读 + 「回退一步」
  const subStatusOpt = (cur) => SUB_STATUSES.map(s=>`<option value="${s}" ${s===cur?'selected':''}>${s}</option>`).join('');
  const subsHtml = (g.subplots||[]).map((s,i)=>{
    const name = String(s.name||'').trim();
    const st = SUB_STATUSES.includes(s.status) ? s.status : '进行中';
    const arcF = (s.arc&&s.arc.from)||'';
    const arcT = (s.arc&&s.arc.to)||'';
    const ts = (Array.isArray(s.log)?s.log:[]).map(x=>`第${x.ch}章${x.note?`（${x.note.trim()}）`:''}`).join(' → ');
    return `<div class="gs-entry" data-gs-entry="sub:${i}">
      <div class="gs-head" role="button" tabindex="0" data-gs-toggle="sub:${i}">
        <span class="gs-fold-ico">▸</span>
        <input type="text" class="gs-name" data-gs-name="sub:${i}" data-orig="${esc(name)}" value="${esc(name)}" placeholder="副线名" />
        <span class="gs-brief">${esc([st, String(s.question||'').trim(), arcF+('→'+arcT||'')].filter(Boolean).join(' · ')||'（点击展开编辑）')}</span>
      </div>
      <div class="gs-detail">
        <label class="gs-f"><span>状态</span><select data-gs-set="sub" data-gs-idx="${i}" data-gs-key="status" data-orig="${esc(st)}">${subStatusOpt(st)}</select></label>
        <label class="gs-f"><span>核心问题</span><input type="text" data-gs-set="sub" data-gs-idx="${i}" data-gs-key="question" data-orig="${esc(String(s.question||'').trim())}" value="${esc(String(s.question||'').trim())}" placeholder="本副线提出的核心问题（必须回答）" /></label>
        <label class="gs-f"><span>起点状态</span><input type="text" data-gs-set="sub" data-gs-idx="${i}" data-gs-key="arcfrom" data-orig="${esc(arcF)}" value="${esc(arcF)}" placeholder="A 状态" /></label>
        <label class="gs-f"><span>当前状态</span><input type="text" data-gs-set="sub" data-gs-idx="${i}" data-gs-key="arcto" data-orig="${esc(arcT)}" value="${esc(arcT)}" placeholder="B 状态" /></label>
        <label class="gs-f"><span>蝴蝶效应</span><input type="text" data-gs-set="sub" data-gs-idx="${i}" data-gs-key="pivot" data-orig="${esc(String(s.pivot||'').trim())}" value="${esc(String(s.pivot||'').trim())}" placeholder="有才填：此副线变化如何影响主线（绝不硬造）" /></label>
        <div class="gs-f"><span>进度（只读）</span><div class="gs-sub-progress">${esc(ts||'（暂无进度）')}</div></div>
        <button type="button" class="btn ghost gs-tool" data-gs-subpop="${i}" title="删除最后一条进度（供纠偏，不会改历史）">↩ 回退一步</button>
      </div>
    </div>`;
  }).join('');
  const collapsed = !!state.gsCollapsed;
  const total = (g.characters||[]).length + (g.places||[]).length + (g.propernouns||[]).length + (g.subplots||[]).length;
  return `<div class="card gs-card${collapsed?' gs-collapsed':''}">
    <div class="gs-card-head">
      <h3 class="gs-card-title" role="button" tabindex="0" data-gs-card-toggle>
        <span class="gs-card-t"><span class="gs-card-arrow">${collapsed?'▸':'▾'}</span>📇 设定表 · 万物词典（${total} 条）</span>
        ${tools}
      </h3>
    </div>
    <div class="gs-card-body"${collapsed?' style="display:none"':''}>
    <p class="sub">有改则改</p>
    <div class="gs-panel" id="gsHistory" hidden><div class="gs-panel-title">🕘 历史更改</div><div id="gsHistoryList"></div></div>
    ${(['char','place','proper','sub']).map(t=>{
      const fold = !!(state.gsCatFold && state.gsCatFold[t]);
      const arr = t==='char'?g.characters:t==='place'?g.places:(t==='proper'?g.propernouns:(g.subplots||[]));
      const body = t==='char'?chars:t==='place'?places:(t==='proper'?props:subsHtml);
      const lab = t==='char'?'👤 人物':t==='place'?'🗺️ 地点':(t==='proper'?'📌 专名':'🧵 副线');
      return `<div class="gs-group${fold?' gs-folded':''}" data-gs-type="${t}" data-gs-catfold>
        <div class="gs-title" role="button" tabindex="0" title="展开/收起">${lab}（${(arr||[]).length}）<span class="gs-cat-ico">${fold?'▸':'▾'}</span></div>
        ${body||'<span class="muted">（无）</span>'}
      </div>`;
    }).join('')}
    ${glossaryDupNoteHtml()}
    <p class="muted" style="margin:6px 0 0">修改后自动保存生效。</p>
    </div>
  </div>`;
}
// 绑定设定表编辑：失焦即写回 state；点击条目折叠/展开全部字段（建议1·此轮）
// 改动透明化（本版）：失焦判定改动→扫描受影响章节→弹出选择卡（仅新章生效 / 批量重生成 / 回退）
function bindGlossary(){
  if(!state.outline || !state.outline.glossary) return;
  const g = state.outline.glossary;
  const getArr = t => t==='char'?(g.characters||[]):t==='place'?(g.places||[]):(t==='proper'?(g.propernouns||[]):(g.subplots||[]));
  // 整卡收缩/展开：点击标题栏（与主线简述一致）；点工具按钮不触发折叠；词条始终保持默认折叠
  const gsHead = $('[data-gs-card-toggle]');
  if(gsHead){
    const toggleCard = ()=>{
      state.gsCollapsed = !state.gsCollapsed;
      persist();
      const card = gsHead.closest('.gs-card');
      const body = card && card.querySelector('.gs-card-body');
      if(body){ body.style.display = state.gsCollapsed ? 'none' : ''; }
      const arrow = gsHead.querySelector('.gs-card-arrow');
      if(arrow) arrow.textContent = state.gsCollapsed ? '▸' : '▾';
      if(state.gsCollapsed){ // 收缩整卡时把所有词条一并折叠（展开整卡时词条保持折叠态，由用户逐个点击展开）
        card && $$('.gs-entry', card).forEach(en=>{ en.classList.remove('open'); const h=en.querySelector('.gs-fold-ico'); if(h) h.textContent='▸'; });
      }
    };
    gsHead.onclick = (e)=>{ if(e.target.closest('.gs-tools')) return; toggleCard(); };
    gsHead.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); if(e.target.closest('.gs-tools')) return; toggleCard(); } };
  }
  // 折叠/展开：仅点击折线图标或简介触发；点击名字输入框不折叠
  $$('[data-gs-toggle]').forEach(h=>{
    const toggle = ()=>{ const box=h.closest('.gs-entry'); const on=box.classList.toggle('open'); h.querySelector('.gs-fold-ico').textContent = on?'▾':'▸'; };
    h.onclick = (e)=>{
      if(e.target.closest('input.gs-name')) return;   // 编辑名字时不折叠
      toggle();
    };
    h.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(); } };
  });
  // v10.53 词典小类别折叠：点击「人物/地点/专名」标题展开/收起整组（默认折叠）
  $$('[data-gs-catfold]').forEach(grp=>{
    const t = grp.dataset.gsType;
    const toggleCat = ()=>{
      state.gsCatFold = state.gsCatFold || {};
      state.gsCatFold[t] = !state.gsCatFold[t];
      persist();
      grp.classList.toggle('gs-folded', state.gsCatFold[t]);
      const ico = grp.querySelector('.gs-cat-ico'); if(ico) ico.textContent = state.gsCatFold[t]?'▸':'▾';
    };
    const tt = grp.querySelector('.gs-title');
    if(tt){
      tt.onclick = (e)=>{ e.stopPropagation(); toggleCat(); };
      tt.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggleCat(); } };
    }
  });
  // 所有可编辑字段（名字 + 各详情）失焦即存；改动时评估影响范围
  $$('[data-gs-name],[data-gs-set]').forEach(inp=>{
    inp.onchange = ()=>{
      const [type, idx] = inp.dataset.gsSet ? [inp.dataset.gsSet, +inp.dataset.gsIdx]
        : inp.dataset.gsName.split(':').map((v,k)=> k===0?v:(+v));
      const arr = getArr(type);
      if(!arr[idx]) return;
      const oldVal = inp.dataset.orig;
      const newVal = inp.value;
      if(newVal === oldVal) return;            // 无实质变化：不记录、不弹窗
      const isName = inp.hasAttribute('data-gs-name');
      const key = isName ? 'name' : inp.dataset.gsKey;
      gsPushUndo();                            // 记录改动前的整本词典（任意模式，供常驻撤销）
      // v1.0.113 副线 arc 特殊字段映射：arcfrom/arcto → arc.from/arc.to
      if(type==='sub' && (key==='arcfrom'||key==='arcto')){
        const arcK = key==='arcfrom' ? 'from' : 'to';
        if(!arr[idx].arc) arr[idx].arc = {from:'', to:''};
        arr[idx].arc[arcK] = newVal;
      } else {
        arr[idx][key] = newVal;                  // 再写回 state（保持现状可编辑即存）
      }
      persist();                               // 改动即保存（防误操作丢数据）
      glossaryHistoryPush(`修改 ${isName?'名称':'字段'}「${type}·${idx}」`); // 追加·历史更改记录
      inp.dataset.orig = newVal;               // 该输入框的 basline 更新
      // 触发「改动透明化」评估：长篇（有正文生成）时弹选择卡
      if(isLong() && type!=='sub'){            // v1.0.113 副线改动不触发正文重生成评估
        openGlossaryPanel({type, idx, isName, key, oldVal, newVal});
      }
    };
  });
  // 覆盖面自检（阶段4）：需有正文后才可见
  $$('[data-gs-coverage]').forEach(b=> b.onclick = openCoveragePanel);
  // v2.4 字段检查
  $$('[data-gs-check]').forEach(b=> b.onclick = openGlossaryCheckPanel);
  // v226/8.2 「🆕 新增」面板：最近自动入典新实体的溯源查看
  $$('[data-gs-new]').forEach(b=> b.onclick = openGlossaryNewPanel);
  // v8c 提取新增：手动对全部已生成正文提取词典未收录的新实体
  $$('[data-gs-extract]').forEach(b=> b.onclick = ()=>{ manualExtractGlossary(); });
  // v8c 清理未使用：弹窗勾选确认删除全部正文零出现的条目
  $$('[data-gs-clean]').forEach(b=> b.onclick = openCleanPanel);
  // v8c 词典自动补全开关（默认开）：批量生成后自动提取；关则仅保留手动按钮
  $$('[data-gs-autofill]').forEach(b=> b.onchange = ()=>{
    state.glossAutoFill = b.checked; persist();
    toast(state.glossAutoFill ? '词典自动补全已开启（批量生成后自动提取新实体）' : '词典自动补全已关闭（仅保留手动「📥 提取新增」）');
  });
  // v1.0.113 副线追踪开关（默认开）：每章生成后自动吸收副线进度
  $$('[data-gs-subfill]').forEach(b=> b.onchange = ()=>{
    state.subAutoFill = b.checked; persist();
    toast(state.subAutoFill ? '副线追踪已开启（每章生成后自动吸收副线进度）' : '副线追踪已关闭（不再自动吸收副线）');
  });
  // v1.0.113 副线「回退一步」：删除该副线最后一条进度（供纠偏；不影响历史快照）
  $$('[data-gs-subpop]').forEach(b=> b.onclick = ()=>{
    const i = +b.dataset.gsSubpop; if(!Number.isFinite(i)) return;
    const sub = (g.subplots||[])[i]; if(!sub || !Array.isArray(sub.log) || !sub.log.length){ toast('该副线暂无进度可回退'); return; }
    gsPushUndo();
    sub.log.pop();
    sub._lastCh = sub.log.length ? Math.max(...sub.log.map(x=>x.ch||0)) : 0;
    persist();
    if(typeof render === 'function') render();
    toast('已回退该副线最后一条进度');
  });
  // v1.0.113 副线看板：列出未收束且消失过久的副线，提示安排回归
  $$('[data-gs-subboard]').forEach(b=> b.onclick = openSubplotBoard);
  // 导出词典 JSON（项6）
  $$('[data-gs-export]').forEach(b=> b.onclick = exportGlossaryJson);
  // 导入词典 JSON（项7）
  $$('[data-gs-import]').forEach(b=> b.onclick = ()=> { const f=$('#gsImportFile'); if(f) f.click(); });
  const imp = $('#gsImportFile'); if(imp) imp.onchange = e=>{ const file = e.target.files && e.target.files[0]; if(file) importGlossaryJson(file); e.target.value=''; };
  // 追加规划·「历史更改」按钮：展开/收起历史记录列表
  $$('[data-gs-history]').forEach(b=> b.onclick = ()=>{
    const panel = $('#gsHistory');
    if(!panel) return;
    const show = panel.hidden;
    if(show) renderGlossaryHistory();
    panel.hidden = !show;
    $$('.gs-panel').forEach(p=>{ if(p.id!=='gsHistory') p.hidden = true; }); // 与内容互斥显示
    if(show) b.classList.add('gs-tool-on'); else b.classList.remove('gs-tool-on');
  });
  }

// 快照（项5）：记录任一条目改动前的整本词典，供「改动透明化弹窗」内的即时回退；最多保留 10 步防无限膨胀
let gsUndoStack = [];
const GS_UNDO_MAX = 10;
function gsPushUndo(){
  const g = state.outline && state.outline.glossary;
  if(g) gsUndoStack.push(JSON.stringify(g));
  if(gsUndoStack.length > GS_UNDO_MAX) gsUndoStack.shift();
}
// 追加规划·词典「历史更改」：持久化记录每次真实修改，供长期回溯。
// 存于 state.outline.glossary._history（上限 30 条），与 gsUndoStack(一次性近撤销) 并存。
function glossaryHistoryPush(desc){
  const g = state.outline && state.outline.glossary;
  if(!g) return;
  const h = Array.isArray(g._history) ? g._history : (g._history = []);
  h.push({ ts: Date.now(), desc: desc || '修改词典', snapshot: JSON.stringify({characters:g.characters||[], places:g.places||[], propernouns:g.propernouns||[], subplots:g.subplots||[]}) });
  if(h.length > 30) h.splice(0, h.length - 30);
  persist();
}
// 渲染「历史更改」列表：按时间倒序，每条可「还原到此」或「查看此版」
function renderGlossaryHistory(){
  const list = $('#gsHistoryList');
  if(!list) return;
  const g = state.outline && state.outline.glossary;
  const h = Array.isArray(g && g._history) ? g._history : [];
  if(!h.length){ list.innerHTML = '<p class="muted">暂无历史更改记录。修改词典后会自动记录。</p>'; return; }
  list.innerHTML = h.slice().reverse().map((r,i)=>{
    const idx = h.length - 1 - i;               // 正序索引
    const d = new Date(r.ts);
    const pad = n => n<10?('0'+n):n;
    const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    return `<div class="gs-hist-row" data-gs-hist="${idx}">
      <span class="gs-hist-ts">回退到第 ${h.length-idx} 次 · ${t}</span>
      <span class="gs-hist-desc">${esc(r.desc||'')}</span>
      <span class="gs-hist-actions">
        <button type="button" class="btn ghost gs-tool" data-gs-hist-view="${idx}">查看</button>
        <button type="button" class="btn ghost gs-tool" data-gs-hist-restore="${idx}">还原</button>
      </span>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-gs-hist-view]').forEach(b=>{
    b.onclick = ()=>{ try{ applyGlossaryHistorySnapshot(+b.dataset.gsHistView); }catch(e){} };
  });
  list.querySelectorAll('[data-gs-hist-restore]').forEach(b=>{
    b.onclick = ()=>{ applyGlossaryHistorySnapshot(+b.dataset.gsHistRestore); glossaryHistoryPush('还原到历史版本'); };
  });
}
// 应用历史快照到当前词典
function applyGlossaryHistorySnapshot(idx){
  const g = state.outline && state.outline.glossary;
  const h = Array.isArray(g && g._history) ? g._history : [];
  const r = h[idx]; if(!r) return;
  let snap; try{ snap = JSON.parse(r.snapshot); }catch(e){ return; }
  if(!snap) return;
  g.characters = snap.characters || [];
  g.places = snap.places || [];
  g.propernouns = snap.propernouns || [];
  g.subplots = snap.subplots || [];   // v1.0.113 副线随历史快照一并还原
  persist();
  // 关闭历史面板并整卡重绘以同步词典条目
  const panel = $('#gsHistory'); if(panel) panel.hidden = true;
  if(typeof renderGlossaryOnly === 'function') renderGlossaryOnly(); else render();
  toast('已应用所选历史版本');
}
// 词典 JSON：导出（v8 带 _meta 元数据头，便于多库/续作版本管理）。来源优先辅轨槽位（构想阶段挂载的），否则大纲词典。
// 导出的文件始终是 {characters,places,propernouns,...} 结构，可用 importGlossaryJson 再读回；_meta 会被导入时忽略。
function exportGlossaryJson(){
  const src = state.pendingGlossary || (state.outline && state.outline.glossary);
  if(!src || (!sourceHasGlossary(src))){ toast('当前没有可导出的词典'); return; }
  const title = (state.outline && state.outline.title) || (state.idea ? state.idea.trim().slice(0,12) : 'story');
  const meta = { _meta:{ title, source:'storyfactory', version:'2.0', exportedAt: new Date().toISOString(), adherence: state.glossAdherence } };
  download(`词典_${title}.json`, JSON.stringify({ ...meta, ...src }, null, 2));
  toast('已导出词典 JSON（含元数据头）');
}
function sourceHasGlossary(g){
  return g && ((g.characters&&g.characters.length)||(g.places&&g.places.length)||(g.propernouns&&g.propernouns.length)||(g.subplots&&g.subplots.length));
}
// v8 阶段3：依遵从度把「导入词典(imported)」与「模型输出词典(modelOut)」合并为新作权威词典。
// 语义与 adherenceHint/adherenceSys 对齐：a>=50 导入为主，a<50 模型为主，a<30 几乎放弃。
// 返回 { glossary, kept, added, rec }。
function glossaryMerge(imported, modelOut, adherence, allowFill){
  const cat = ['characters','places','propernouns'];
  const res = { glossary:{characters:[],places:[],propernouns:[],subplots:[]}, kept:0, added:0, rec:0 };
  const a = (typeof adherence==='number') ? adherence : 100;
  cat.forEach(k=>{
    const imp = (imported&&imported[k])||[];
    const mdl = (modelOut&&modelOut[k])||[];
    const impBy = {};
    imp.forEach(it=>{ const nm=String(it.name||'').trim(); if(nm) impBy[nm]=it; });
    const has = it=>String(it.name||'').trim();
    const out = res.glossary[k];
    if(a < 30){                                       // 几乎放弃：完全采用模型输出
      mdl.forEach(it=>{ if(has(it)){ out.push(it); res.added++; } });
      return;
    }
    if(a < 50){                                       // 灵感来源：模型为主，仅补同名导入详情
      mdl.forEach(it=>{
        const nm = has(it); if(!nm) return;
        if(impBy[nm]){ out.push(impBy[nm]); res.kept++; }   // 同名以导入版为准（名+详情）
        else { out.push(it); res.added++; }
      });
      return;
    }
    imp.forEach(it=>{ if(has(it)){ out.push(it); res.kept++; } });   // a>=50：导入词典为主体
    mdl.forEach(it=>{
      const nm = has(it); if(!nm) return;
      if(impBy[nm]) return;                                          // 重名：一律保留导入版，丢弃模型版（词典保持唯一）
      if(allowFill || a<80){ out.push(it); res.added++; }            // 新名：a<80 自动补，a>=80 需「允许补充」才补
    });
  });
  return res;
}
/* ================= v8 词典库 + 历史一键导出 ================= */
function loadGlib(){
  try{ gglib = JSON.parse(localStorage.getItem(KEY_GLIB)) || []; }catch(e){ gglib = []; }
}
function saveGlib(){ try{ localStorage.setItem(KEY_GLIB, JSON.stringify(gglib)); }catch(e){} }
// 从「词典库」选用某套 → 挂载到当前辅轨槽位（intent: reuse across works）
function glibUse(id){
  const it = gglib.find(x=> x.id === id); if(!it) return;
  state.pendingGlossary = it.g;
  persist(); render();
  closeGlibPanel();
  toast(`已选用词典「${it.name}」挂载到本作，可调遵从度后生成大纲`);
}
// 把当前条件里可用的词典存入库（当前辅轨槽位优先，否则大纲词典）
function glibSave(){
  const src = state.pendingGlossary || (state.outline && state.outline.glossary);
  if(!src || !sourceHasGlossary(src)){ toast('当前没有可入库的词典'); return; }
  const name = prompt('给这套词典起个名字（如：仙侠传·世界观）', (state.outline&&state.outline.title) || '无题词典');
  if(name === null) return;
  const t = name.trim() || ('词典'+(gglib.length+1));
  if(gglib.some(x=> x.name === t)){ if(!confirm('词典库已有同名「'+t+'」，仍要覆盖保存吗？')) return; gglib = gglib.filter(x=> x.name !== t); }
  gglib.push({ id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2,6), name:t, savedAt: Date.now(), g: JSON.parse(JSON.stringify(src)) });
  saveGlib(); openGlibPanel();
  toast('已存入词典库：'+t);
}
function glibDel(id){ gglib = gglib.filter(x=> x.id !== id); saveGlib(); openGlibPanel(); }
function closeGlibPanel(){ const p=$('#glibPanel'); if(p) p.remove(); }
function openGlibPanel(){
  closeGlibPanel();
  const ov = document.createElement('div'); ov.id='glibPanel'; ov.className='gs-overlay';
  const itemsHtml = gglib.length ? gglib.map(x=>{
    const n = x.g; const cn=(n.characters||[]).length, pn=(n.places||[]).length, rn=(n.propernouns||[]).length;
    return `<div class="cv-row">
      <b>${esc(x.name)}</b>
      <span class="cv-cnt">👤${cn} · 📍${pn} · 🔤${rn}</span>
      <span class="cv-actions">
        <button class="cv-b btn" data-glib-use="${x.id}">选用</button>
        <button class="cv-b btn" data-glib-del="${x.id}">删除</button>
      </span>
    </div>`;
  }).join('') : '<p class="muted" style="margin:8px 0">还没有保存过词典。先打开一个新长篇并导入/生成词典，点「存入词典库」即可在此汇集多套世界观。</p>';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🗂️ 词典库</b><button class="gs-x" data-glib-close>✕</button></div>
      <div class="gs-body">
        <p class="muted" style="margin:0 0 8px">跨作品汇集可复用词典。点「选用」即挂载到当前新篇的辅轨槽位，之后设置遵从度、生成大纲即可带入。</p>
        ${itemsHtml}
      </div>
      <div class="gs-actions" style="grid-template-columns:1fr 1fr">
        <button class="btn" data-glib-close>关闭</button>
        <button class="btn primary" data-glib-save>＋ 存入当前词典</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelectorAll('[data-glib-close]').forEach(b=> b.onclick = closeGlibPanel);
  ov.querySelector('[data-glib-save]').onclick = glibSave;
  ov.querySelectorAll('[data-glib-use]').forEach(b=> b.onclick = ()=> glibUse(b.dataset.glibUse));
  ov.querySelectorAll('[data-glib-del]').forEach(b=> b.onclick = ()=>{ if(confirm('从库中删除该词典？不影响已生成作品。')) glibDel(b.dataset.glibDel); });
  ov.addEventListener('click', e=>{ if(e.target===ov) closeGlibPanel(); });
}
// 历史作品一键导出该作词典（阶段5）：无需切换进项目，直接下载该作词典 JSON
function exportWorkGlossaryJSON(id){
  const p = lib.items.find(i=> i.id === id);
  const g = p && p.outline && p.outline.glossary;
  if(!p || !g || !sourceHasGlossary(g)){ toast('该作品暂无可用词典'); return; }
  const meta = { _meta:{ title:p.title||'复用词典', source:'storyfactory', version:'2.0', exportedAt:new Date().toISOString() } };
  download(`词典_${(p.title||'story').slice(0,12)}.json`, JSON.stringify({ ...meta, ...g }, null, 2));
  toast('已导出该作词典 JSON');
}
// 词典 JSON 导入入口：已导出的文件可能带 _meta 头，在此剥离；仅写入已生成大纲的 outline.glossary（用户主动导入，不走影响评估）
function normalizeGlossaryJSON(j){
  const src = (j && j._meta) ? j : j;
  const ok = src && typeof src==='object'
    && Array.isArray(src.characters) && Array.isArray(src.places) && Array.isArray(src.propernouns);
  if(!ok) return null;
  // v1.0.113 副线：白名单清洗 status，非法值回退「进行中」；arc 结构兜底；log 每项校验 ch/note
  const subs = (Array.isArray(src.subplots)?src.subplots:[]).map(s=>{
    const name = String(s&&s.name||'').trim(); if(!name) return null;
    const st = SUB_STATUSES.includes(s.status) ? s.status : '进行中';
    const log = (Array.isArray(s.log)?s.log:[]).filter(x=>x && Number.isFinite(x.ch)).map(x=>({ch:x.ch, note:String(x.note||'').trim()}));
    return { name, status: st,
      question: String(s.question||'').trim(),
      arc: { from: String((s.arc&&s.arc.from)||'').trim(), to: String((s.arc&&s.arc.to)||'').trim() },
      pivot: String(s.pivot||'').trim(),
      log,
      _lastCh: log.length ? Math.max(...log.map(x=>x.ch)) : 0,
      _auto: !!s._auto };
  }).filter(Boolean);
  return { characters: src.characters, places: src.places, propernouns: src.propernouns, subplots: subs };
}
function importGlossaryJson(file, target){
  const r = new FileReader();
  r.onload = ()=>{
    try{
      const j = JSON.parse(r.result);
      const g = normalizeGlossaryJSON(j);
      if(!g) throw 0;
      if(state.outline && state.outline.glossary){
        state.outline.glossary = g;
        persist(); render();
        toast('词典已导入');
      } else {
        toast('请先生成大纲后再导入词典');
      }
    }catch(e){ toast('导入失败：JSON 结构须含 characters/places/propernouns'); }
  };
  r.readAsText(file);
}

// 扫描正文：旧名/条目引用出现在哪些已生成章节（项2，纯本地字符串检索，零成本）
function scanGlossaryImpact({type, idx, oldVal, newVal, isName}){
  const g = state.outline.glossary;
  const getArr = t => t==='char'?(g.characters||[]):t==='place'?(g.places||[]):(g.propernouns||[]);
  const arr = getArr(type);
  // 被改动的「实体名」：名字字段用旧名（正文里旧章节存的是旧名）；其它字段看该条自身名字 + 旧值
  const entityName = arr[idx] ? arr[idx].name : oldVal;
  const terms = new Set();
  if(isName && oldVal) terms.add(oldVal);      // 改名：扫旧名，找旧章节正文
  else if(entityName) terms.add(entityName);   // 改详情：扫该实体名是否被正文引用
  const hits = state.chapters.map((c,i)=>{
    if(!c || !c.content) return null;
    let n = 0, occurs = 0;
    for(const t of terms){ if(t){ const re = new RegExp(escRe(t), 'g'); const m = String(c.content).match(re); if(m){ n += m.length; occurs++; } } }
    return occurs>0 ? {i, n, title: c.title||('第'+(i+1)+'章')} : null;
  }).filter(Boolean);
  // 词典内部相互引用：其它条目是否引用了被改条目（名字/名字改动时旧名）
  const refs = [];
  const refNames = isName ? [oldVal, newVal] : [entityName];
  ['char','place','proper'].forEach(t=>{
    getArr(t).forEach((it, ii)=>{
      if(t===type && ii===idx) return;
      const tsv = Object.values(it).join(' ');
      for(const rn of refNames){ if(rn && tsv.includes(rn)){ refs.push({t, ii, name: it.name||''}); break; } }
    });
  });
  return {hits, refs, word: isName ? oldVal : entityName};
}
function escRe(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 弹出「改动透明化」选择卡（项3/4/5）：默认全选可取消，出口=仅新章生效 / 批量重生成
function openGlossaryPanel(info){
  closeGlossaryPanel();
  if(!state.outline || !state.outline.glossary) return;
  const g = state.outline.glossary;
  const getArr = t => t==='char'?(g.characters||[]):t==='place'?(g.places||[]):(g.propernouns||[]);
  const arr = getArr(info.type);
  const itemName = arr[info.idx] ? arr[info.idx].name : '该条目';
  const scan = scanGlossaryImpact(info);
  const hits = scan.hits || [];

  const labels = {name:'名称', identity:'身份', age:'岁数', gender:'性别', appearance:'外貌', hobby:'爱好', relation:'关系', trait:'性格', type:'类型', note:'说明'};
  const kind = info.isName ? `「${info.oldVal||''}」→「${info.newVal||''}」`
    : `「${itemName}」的「${labels[info.key]||info.key||'详情'}」已修改（正文引用该条目 ${scan.word?('出现自 「'+scan.word+'」'):''}）`;
  const hitHtml = hits.length ? hits.map(h=>`
    <label class="gs-hit"><input type="checkbox" class="gs-hit-cb" data-ch="${h.i}" checked />
      <span>第${h.i+1}章 · ${esc(h.title||'')}</span><i>正文出现 ${h.n} 次</i></label>`).join('')
    : `<p class="gs-nohit">✓ 旧名在已生成正文中未出现，无需重塑任何章节。该改动仅对后续新生成章节生效。</p>`;
  const refHtml = scan.refs.length ? `<div class="gs-refs">⚠️ 词典内其它条目仍引用旧名（建议一并核对）：${scan.refs.map(r=>{
    const lab = r.t==='char'?'人物':r.t==='place'?'地点':'专名';
    return `<span class="pill">${lab}「${esc(r.name||'')}」</span>`;
  }).join('')}</div>` : '';

  const names = {char:'人物',place:'地点',proper:'专名'};
  const ov = document.createElement('div');
  ov.id = 'gsPanel';
  ov.className = 'gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>📇 词典改动 · 影响范围</b>
        <button class="gs-x" data-gs-close>✕</button></div>
      <p class="gs-modal-sub">检测到你改动了 ${names[info.type]||''}：${kind}</p>
      <div class="gs-body">
        <p class="gs-q"><b>① 会影响的已生成章节（默认全选，可取消个别）：</b></p>
        ${hitHtml}
        ${refHtml}
      </div>
      <div class="gs-actions">
        <button class="btn ghost" data-gs-undo>↩ 回退本次改动</button>
        <button class="btn ghost" data-gs-future>仅对新章生效</button>
        <button class="btn primary" data-gs-regen ${hits.length?'':'disabled'}>⚡ 批量重生成所选章节（${hits.length}）</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-gs-close]').onclick = closeGlossaryPanel;
  ov.querySelector('[data-gs-future]').onclick = ()=>{
    gsUndoStack.pop();   // 已生效，丢弃快照
    closeGlossaryPanel();
    toast('已保存，仅对后续新章生效');
  };
  ov.querySelector('[data-gs-undo]').onclick = ()=>{
    const snap = gsUndoStack.pop();
    if(snap){ try{ state.outline.glossary = JSON.parse(snap); persist(); }catch(e){} }
    closeGlossaryPanel(); renderGlossaryOnly(); toast('已恢复改动前词典');
  };
  const regenBtn = ov.querySelector('[data-gs-regen]');
  if(regenBtn) regenBtn.onclick = ()=>{
    const sel = $$('.gs-hit-cb:checked', ov).map(b=>+b.dataset.ch);
    gsUndoStack.pop();   // 用户已确认批量重生成，丢弃快照（重生成后为新一致性）
    closeGlossaryPanel();
    regenSelectedChapters(sel);
  };
  // 点遮罩关闭
  ov.addEventListener('click', e=>{ if(e.target===ov) closeGlossaryPanel(); });
}
// 仅重绘「故事」视图（保留词典卡片反映回退后的词典；页面回顶，属可接受）
function renderGlossaryOnly(){
  const host = $('#view');
  if(host){ host.innerHTML = viewStory(); bindView(); window.scrollTo({top:100, behavior:'smooth'}); }
}

// 批量重生成（项2/4）：对选中的受影响章节逐章按新词典重写，保证前后连贯
async function regenSelectedChapters(list){
  if(!list || !list.length) return;
  const panel = document.createElement('div');
  panel.id = 'gsPanel'; panel.className = 'gs-overlay';
  panel.innerHTML = `<div class="gs-modal"><div class="gs-modal-head"><b>⚡ 正在按新词典重生成 ${list.length} 章…</b></div>
    <p class="gs-progress muted">请保持页面打开，逐章推进，不会打断你浏览已生成章节。</p></div>`;
  document.body.appendChild(panel);
  state.generating = true;
  try{
    for(const i of list){
      chState[i]='generating'; patchChapter(i);
      const pg = panel.querySelector('.gs-progress');
      if(pg) pg.textContent = `正在重写第 ${i+1} 章…`;
      try{
        const user = buildChapterUser(i, {regenerating:true});
        const txt = await writeOneChapterContent(i, user);      // 关闭流式，单章连贯
        snapshotChapterVersion(i);            // v7.2：覆盖前存旧版，支持回退
        state.chapters[i].content = txt;
        chState[i]='done'; persist(); patchChapter(i);
      }catch(e){ chState[i]='error'; persist(); patchChapter(i); }
    }
    closeGlossaryPanel();
    renderChapters();
    toast('所选章节已按新词典重生成完成');
  }finally{ state.generating = false; }
}
function closeGlossaryPanel(){ const p=$('#gsPanel'); if(p) p.remove(); }

/* =====================================================
 * 章节版本历史（v7.2）：重生成后可回退到之前版本
 * 章节结构：{ title, content, confirmed, history:[{content,ts}] }
 * 生成/重生成覆盖前快照旧内容；卡片「📚 版本」按钮可预览并恢复。
 * ===================================================== */
function ensureChapterHistory(i){
  const c = state.chapters[i]; if(!c) return c;
  if(!Array.isArray(c.history)) c.history = [];
  return c;
}
// 生成/重生成覆盖前调用：把当前非空正文存入历史（尾=最新）
function snapshotChapterVersion(i){
  const c = ensureChapterHistory(i); if(!c) return;
  const cur = c.content;
  if(cur && String(cur).trim()) c.history.push({ content: cur, ts: Date.now() });
  if(c.history.length > 50) c.history.splice(0, c.history.length - 50); // 上限50防膨胀
}
function chVersions(i){ const c=ensureChapterHistory(i); return c? c.history : []; }
function hasChVersions(i){ return chVersions(i).length > 0; }

/* ---------- P0-3 章节正文手动编辑撤销（editHistory 上限10） ---------- */
function hasEditHistory(i){ const c=state.chapters[i]; return !!(c && Array.isArray(c.editHistory) && c.editHistory.length); }
// 撤销一次手动编辑：弹出最后一条旧值覆盖当前内容（pop 后不写回，支持连续往回撤）
function undoChapterEdit(i){
  const c = state.chapters[i];
  if(!c || !Array.isArray(c.editHistory) || !c.editHistory.length){ toast('没有可撤销的编辑'); return; }
  c.content = c.editHistory.pop();
  persist(); renderChapters(); updateWcTotal();
  toast('已撤销一次编辑');
}

// 版本历史弹窗：列出当前 + 历史，可预览、可恢复
function openChapterVersionPanel(i){
  closeChapterVersionPanel();
  const c = ensureChapterHistory(i); if(!c) return;
  const title = c.title || ('第'+(i+1)+'章');
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const cur = String(c.content||'');
  const hist = c.history;
  const rows = hist.map((v,origIdx)=>`
    <div class="cv-row">
      <div class="cv-meta"><span class="cv-time">${fmtTs(v.ts)}</span><span class="cv-wc">${(v.content||'').length} 字</span></div>
      <div class="cv-actions">
        <button type="button" class="btn ghost cv-b" data-cv-prev="${origIdx}">预览</button>
        <button type="button" class="btn ghost cv-b" data-cv-restore="${origIdx}">↩ 恢复</button>
      </div>
    </div>`).join('');
  const ov = document.createElement('div'); ov.id='cvPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>📚 版本历史 · 第${i+1}章「${esc(cleanChapterTitle(title))}」</b>
        <button class="gs-x" data-cv-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-row cur"><div class="cv-meta"><span class="cv-time">当前版本</span><span class="cv-wc">${cur.length} 字</span></div></div>
        ${hist.length? `<div class="cv-div">历史版本（点「恢复」回到该版；恢复前会先把当前正文存为新的历史版本）</div>${rows}`
        : '<p class="muted cv-empty">暂无历史版本。当章节被重生成时，旧正文会自动存档在这里，供你随时回退。</p>'}
        <div class="cv-preview hidden" id="cvPreview">
          <div class="cv-prev-head"><b id="cvPrevTitle">版本预览</b><button class="gs-x" data-cv-prev-close>✕</button></div>
          <div class="cv-pre" id="cvReader"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-cv-close]').onclick = closeChapterVersionPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeChapterVersionPanel(); });
  // 预览：显示该版本全文
  ov.addEventListener('click', e=>{
    const p = e.target.closest('[data-cv-prev]'); if(!p) return;
    const v = hist[+p.dataset.cvPrev]; if(!v) return;
    const pr=$('#cvPreview'), rd=$('#cvReader'), pt=$('#cvPrevTitle');
    if(pr && rd){ pt.textContent = '预览 · 历史版本（'+fmtTs(v.ts)+'）'; rd.textContent = v.content||'（空）'; pr.classList.remove('hidden'); }
  });
  ov.querySelector('[data-cv-prev-close]').onclick = ()=>{ const pr=$('#cvPreview'); if(pr) pr.classList.add('hidden'); };
  // 恢复：确认后把当前正文存历史，再用选中版覆盖当前
  ov.addEventListener('click', e=>{
    const rb = e.target.closest('[data-cv-restore]'); if(!rb) return;
    const v = hist[+rb.dataset.cvRestore]; if(!v) return;
    if(!window.confirm('恢复该历史版本将覆盖当前正文。\n\n（当前正文会自动保存为一条新的历史版本，不会被删除。）\n确定恢复吗？')) return;
    snapshotChapterVersion(i);                  // 先把当前正文存历史
    c.content = v.content;                      // 用历史版覆盖当前
    c.history.splice(+rb.dataset.cvRestore, 1); // 移除已升为当前的版本
    persist(); closeChapterVersionPanel(); renderChapters();
    toast('已恢复历史版本');
  });
}
function closeChapterVersionPanel(){ const p=$('#cvPanel'); if(p) p.remove(); }

function renderChapters(){
  const wrap = $('#chaptersWrap'); if(!wrap) return;
  const total = state.chapters.length;
  if(isLong()){
    // 建议3：长篇每页 10 章，分页渲染；chPage 对齐到有效页
    const maxPage = Math.max(0, Math.ceil(total / CH_PAGE_SIZE) - 1);
    if(chPage > maxPage) chPage = maxPage;
    const from = chPage * CH_PAGE_SIZE;
    const slice = state.chapters.slice(from, from + CH_PAGE_SIZE);
    const html = slice.map((c,offset)=>{
      const i = from + offset;
      const hasC = !!(c.content && c.content.trim());
      // 建议1：无正文章节→卡片折叠成标题行；有正文→默认展开；点击标题行切换
      const foldedCls = hasC ? '' : ' folded';
       return `<div class="card ch-card" data-ch-card="${i}">
        <div class="ch-head" data-fold="${i}" role="button" tabindex="0" aria-expanded="${foldedCls?'false':'true'}">
          <span class="ch-fold-ico">${hasC?'▾':'▸'}</span>
          <h3 style="margin:0;flex:1;word-break:break-word;line-height:1.35" title="第${i+1}章 · ${esc(cleanChapterTitle(c.title))}">第${i+1}章 · ${esc(cleanChapterTitle(c.title))}${c._titleByAI?'<i class="tbd-title-tag" style="font-style:normal;font-size:11px;font-weight:400;opacity:.55;margin-left:6px" title="本章标题已由章节正文 AI 定稿">正文定稿</i>':(!state.plannerFinalized?'<i class="tbd-title-tag" style="font-style:normal;font-size:11px;font-weight:400;opacity:.55;margin-left:6px" title="标题尚未由全书规划师定稿，当前沿用第二步参考稿">参考稿</i>':'')}</h3>
          ${wcBadge(c.content, `data-wc-ch="${i}"`)}
        </div>
        <div class="ch-meta ch-status-wrap" data-ch-status="${i}">${chapterBadgesHtml(i)}</div>
        <div class="ch-body${foldedCls}">
          <textarea data-ch="${i}" style="margin-top:8px">${esc(c.content)}</textarea>
          <div class="btn-row">
            <button class="btn ghost" data-regen="${i}" ${state.generating?'disabled':''}>🔄 重生成</button>
            <button class="btn ghost" data-read="${i}">📖 阅读</button>
            <button class="btn ghost" data-style-ok="${i}" ${hasC?'':'disabled'} title="确认本章风格良好：后续生成将自动提取风格指纹，作为 L0 风格契约">${c._styleConfirmed?'🎨 风格已确认':'🎨 确认风格'}</button>
            ${c._styleConfirmed?`<button class="btn ghost" data-style-unok="${i}" title="取消本章的风格确认：该章将从风格指纹提取来源中移除">↺ 取消确认</button>`:''}
            <button class="btn ghost" data-ch-raw="${i}" title="手动提取 AI 原始响应数据，当自动更新失败时使用">🔧</button>
            <button class="btn ghost" data-ch-sum="${i}" title="生成本章速读梗概（本章正文压缩至约 1/3，省时阅读）" ${hasC?'':'disabled'}>🏮 本章梗概</button>
            ${chapterExtraButtonsHtml(i)}
            ${hasChVersions(i)?`<button class="btn ghost" data-ver="${i}">📚 版本(${chVersions(i).length})</button>`:''}
            ${hasEditHistory(i)?`<button class="btn ghost" data-undo="${i}" title="撤销最近一次手动编辑">↩ 撤销编辑</button>`:''}
          </div>
        </div>
      </div>`;
    }).join('');
    // 分页条
    const pageCount = Math.max(1, Math.ceil(total / CH_PAGE_SIZE));
    const pages = Array.from({length:pageCount},(_,p)=>p)
      .map(p=>`<button type="button" class="ch-page${p===chPage?' active':''}" data-page="${p}">${p+1}</button>`).join('');
    wrap.innerHTML = `<div class="ch-pager"><span class="muted">第 ${from+1}–${from+slice.length} 章 / 共 ${total} 章</span>${pages}</div>
      ${html}
      <div class="ch-pager">${pages}</div>`;
  } else {
    // 短片模式：全部渲染，保留「待确认/已确认」（决策7：仅长篇去除确认）
    wrap.innerHTML = state.chapters.map((c,i)=>`
      <div class="card ch-card" data-ch-card="${i}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
         <div style="display:flex;align-items:center;gap:8px;min-width:0">
  <h3 style="margin:0;word-break:break-word;line-height:1.35" title="第${i+1}章 · ${esc(cleanChapterTitle(c.title))}">第${i+1}章 · ${esc(cleanChapterTitle(c.title))}</h3>
  <button class="btn ghost" data-ver="${i}" style="padding:2px 6px;font-size:11px;flex-shrink:0" title="版本历史">📚 ${chVersions(i).length}</button>
  ${wcBadge(c.content, `data-wc-ch="${i}"`)}
</div>
<span class="pill ${c.confirmed?'tag-ok':'tag-warn'}">${c.confirmed?'✓ 已确认':'待确认'}</span>
        </div>
        <textarea data-ch="${i}" style="margin-top:8px">${esc(c.content)}</textarea>
        <div class="btn-row">
          <button class="btn ghost" data-regen="${i}">🔄 重生成</button>
          <button class="btn ghost" data-read="${i}">📖 阅读</button>
          <button class="btn ghost" data-ch-raw="${i}" title="手动提取 AI 原始响应数据，当自动更新失败时使用">🔧</button>
          <button class="btn ghost" data-ch-sum="${i}" title="生成本章速读梗概（本章正文压缩至约 1/3，省时阅读）" ${c.content&&String(c.content).trim()?'':'disabled'}>🏮 本章梗概</button>
        
          ${hasEditHistory(i)?`<button class="btn ghost" data-undo="${i}" title="撤销最近一次手动编辑">↩ 撤销编辑</button>`:''}
          <button class="btn ghost" data-toggle="${i}">${c.confirmed?'↺ 取消确认':'✓ 标记已确认'}</button>
        </div>
      </div>`).join('');
  }
}

/* ---------- 沉浸式章节阅读 ---------- */
let readerCur = -1;
function renderToc(current){
  const list = $('#tocList'); if(!list) return;
  const total = state.chapters.length;
  const cn = $('#tocCount'); if(cn) cn.textContent = total;
  list.innerHTML = state.chapters.map((c,i)=>{
    const active = i === current ? ' active' : '';
    const done = c.content && c.content.trim() ? ' done' : '';
    return `<button type="button" class="toc-item${active}${done}" data-toc="${i}"><span class="toc-idx">${i+1}</span><span class="toc-t">${esc(cleanChapterTitle(c.title)||('第'+(i+1)+'章'))}</span></button>`;
  }).join('');
}
// 阿拉伯数字 → 汉字（用于阅读界面汉字章序）
function toCnNum(n){
  const cn=['零','一','二','三','四','五','六','七','八','九'];
  if(n < 10) return cn[n];
  if(n < 20) return '十' + (n%10 ? cn[n%10] : '');
  if(n < 100){ const t=Math.floor(n/10), u=n%10; return cn[t]+'十'+(u?cn[u]:''); }
  if(n < 1000){ const h=Math.floor(n/100), r=n%100; return cn[h]+'百'+(r? (r<10?'零'+cn[r] : toCnNum(r)) : ''); }
  return String(n);
}
// 剥离章节标题里自带的章序前缀（模型生成 title 常带「第三章 / 第3章 / 第十章」），
// 只保留纯章节名，避免与 UI 统一的「第N章」前置重复成「第3章 · 第三章」。
function cleanChapterTitle(title){
  if(!title) return '';
  let t = String(title).trim();
  t = t.replace(/^(第\s*[0-9一二三四五六七八九十百千两0-9]+\s*章|[一二三四五六七八九十百千]+章)(\s*[·、：:．.，,，\-–—]\s*|\s*)/,'');
  return t.trim();
}
function openReader(i){
  const c = state.chapters[i]; if(!c) return;
  const ov = $('#readerOverlay'); if(!ov) return;
  $('#readerTitle').textContent = `第${toCnNum(i+1)}章 · ${cleanChapterTitle(c.title)}`;
  const paras = String(c.content||'').split(/\n+/).map(p=>p.trim()).filter(Boolean);
  // 无正文时：优先展示本章梗概（c.strip）；否则回退规划师主线简述（chapterPlans），让「空章也可预览剧情定位」
  let fallback = `<p class="muted">（本章尚未生成正文）</p>`;
  const csum = (state.chapters[i] && state.chapters[i].strip) ? String(state.chapters[i].strip).trim() : '';
  const plan = (state.outline && Array.isArray(state.outline.chapterPlans) && state.outline.chapterPlans[i])
    ? chapterPlanText(state.outline.chapterPlans[i]) : '';
  if(csum) fallback = `<p class="muted">🗂 本章梗概：${esc(csum)}</p>
    <p class="muted" style="margin-top:6px">生成正文后将在此展示全文。可用下方「重生成」或「一键批量生成」补写。</p>`;
  else if(plan) fallback = `<p class="muted">🧭 本章主线简述：${esc(plan)}</p>
    <p class="muted" style="margin-top:6px">生成正文后将在此展示全文。可用下方「重生成」或「一键批量生成」补写。</p>`;
  // v1.0.133 阅读器正文只显示正文，不再前置「本章相关设定」浮板（相关设定仍服务于正文生成的 L3 上下文，见 relevantGlossaryForChapter）
  $('#readerBody').innerHTML = paras.length ? paras.map(p=>`<p>${esc(p)}</p>`).join('') : fallback;
  // 构建目录并定位当前章
  renderToc(i);
  readerCur = i;
  ov.classList.remove('hidden');
  document.body.classList.add('reader-lock'); // 锁定背景滚动
  // P3-3 续读进度（fixed8 修订）：打开时先归零——首开/切到未读过的章一律从开头显示，不再残留上一章滚动位置；
  // 再尝试恢复「本章」上次关闭前的位置（按 项目id + 章节 分别记忆，弃用旧单章 key fyp_rp_${curId}）。
  const body0 = $('#readerBody');
  if(body0) body0.scrollTop = 0;
  updateReaderProgress();   // v10.42 打开章节即复位进度条（无续读时为 0）
  try{
    const rp = JSON.parse(localStorage.getItem('fyp_rp_' + (lib.curId||'x') + '_' + i) || 'null');
    if(rp && rp.top){
      requestAnimationFrame(()=>{ const b=$('#readerBody'); if(b) b.scrollTop = rp.top; updateReaderProgress(); });
    }
  }catch(e){}
}
// P3-3 续读进度：阅读中节流记录滚动位置（关闭/切换章节后再次打开可续读）
function bindReaderScrollSave(){
  const b = $('#readerBody'); if(!b || b.dataset.rpBound) return;
  b.dataset.rpBound = '1';
  let _t = null;
  b.addEventListener('scroll', ()=>{
    if(_t) return;
    _t = setTimeout(()=>{
      _t = null;
      try{
        // fixed8：按 项目id + 章节 分别记忆，每章各自续读上次关闭前位置
        localStorage.setItem('fyp_rp_' + (lib.curId||'x') + '_' + readerCur, JSON.stringify({ top: b.scrollTop }));
      }catch(e){}
      updateReaderProgress();   // v10.42 滚动过程同步阅读进度条 + 悬停气泡
    }, 400);
  }, {passive:true});
}
// v10.42 阅读进度条：按 #readerBody 滚动实时计算本章进度，更新细条宽度与悬停气泡（段数/百分比）
function updateReaderProgress(){
  const b = $('#readerBody'), fill = $('#readerProgressFill'), tip = $('#readerPctTip');
  if(!b || !fill) return;
  const max = b.scrollHeight - b.clientHeight;
  const p = max>0 ? Math.min(100, Math.max(0, Math.round(b.scrollTop/max*100))) : 0;
  fill.style.width = p+'%';
  if(tip){
    const paras = b.querySelectorAll('p').length;
    tip.innerHTML = `第 <b>${p}%</b> · 全文 <b>${paras}</b> 段`;
  }
}
// v1.0.133 阅读进度条随机渐变：每次打开阅读器/导出全文时生成一组随机色相渐变，内联覆盖主题变量（.reader-progress i 的 var(--accent/--accent2) 作为兜底）
function randomizeReaderGradient(){
  const fill = $('#readerProgressFill'); if(!fill) return;
  const h1 = Math.floor(Math.random()*360), h2 = Math.floor(Math.random()*360);
  fill.style.background = `linear-gradient(90deg, hsl(${h1} 78% 62%), hsl(${h2} 78% 62%))`;
}
function closeReader(){
  const ov = $('#readerOverlay'); if(!ov) return;
  ov.classList.add('hidden');
  // 如果是导出阅读模式，恢复隐藏的按钮
  if(ov.dataset.exportReader === '1'){
    delete ov.dataset.exportReader;
    const tocBtn = $('#readerTocBtn'); if(tocBtn) tocBtn.style.display = '';
    const synBtn = $('#readerSynBtn'); if(synBtn) synBtn.style.display = '';
  }
  const toc = $('#readerToc'); if(toc) toc.classList.add('hidden');
  document.body.classList.remove('reader-lock');
}
function bindReader(){
  const ov = $('#readerOverlay'); if(!ov) return;
  bindReaderScrollSave();   // P3-3 续读进度：滚动位置节流保存
  $$('[data-reader-close]', ov).forEach(el=> el.onclick = (e)=>{
    // 点击面板内部不关闭（backdrop 与 ✕ 按钮才关闭）
    if(e.target.closest('.reader-panel') && !e.target.closest('.reader-close')) return;
    closeReader();
  });
  // 右上角「☰」章节目录：开合抽屉
  const tocBtn = $('#readerTocBtn'); const toc = $('#readerToc');
  if(tocBtn && toc){
    tocBtn.onclick = (e)=>{ e.stopPropagation(); const show = toc.classList.toggle('hidden'); tocBtn.classList.toggle('on', !show); };
  }
  const tocClose = $('#tocClose');
  if(tocClose && toc) tocClose.onclick = (e)=>{ e.stopPropagation(); toc.classList.add('hidden'); if(tocBtn) tocBtn.classList.remove('on'); };
  // 目录展开时，点击面板其它区域（正文/顶栏空白处）自动收起，无需再点 ✕
  const panel = ov.querySelector('.reader-panel');
  if(panel && toc && tocBtn){
    panel.addEventListener('click', (e)=>{
      if(toc.classList.contains('hidden')) return;      // 目录已收起，无需处理
      if(e.target.closest('#readerToc')) return;        // 点目录内部不收起
      if(e.target.closest('#readerTocBtn')) return;     // 点目录开关不收起（交由自身 toggle）
      toc.classList.add('hidden');
      tocBtn.classList.remove('on');
    });
  }
  // 目录项点击跳转
  const list = $('#tocList');
  if(list && toc) list.onclick = (e)=>{
    const item = e.target.closest('[data-toc]'); if(!item) return;
    openReader(+item.dataset.toc);
  };
  // v1.0.115 底部中央「概」按钮 → 优先级填充：本章速读梗概(strip) → 规划师主线简述(summary) → 引导。
  // v1.0.134 修复：chapterPlans 为对象时 String() 会得到 "[object Object]"，改用 chapterPlanText() 取文本。
  const synBtn = $('#readerSynBtn'), synPop = $('#readerSynPop'), synCard = $('#readerSynCard');
  if(synBtn && synPop && synCard){
    synBtn.onclick = (e)=>{
      e.stopPropagation();
      const o = state.outline || {};
      const ch = (Array.isArray(state.chapters) && state.chapters[readerCur]) ? state.chapters[readerCur] : null;
      const strip = ch && String(ch.strip||'').trim();
      const plans = Array.isArray(o.chapterPlans) ? o.chapterPlans : [];
      const plan = chapterPlanText(plans[readerCur]);
      let title, body;
      if(strip){
        title = `第${toCnNum(readerCur+1)}章 · 本章梗概`;
        body = `<div class="syn-body">${esc(strip)}</div>`;
      } else if(plan){
        title = `第${toCnNum(readerCur+1)}章 · 主线简述`;
        body = `<div class="syn-body">${esc(plan)}</div>`;
      } else {
        title = `第${toCnNum(readerCur+1)}章 · 梗概`;
        body = `<div class="syn-body muted">本章暂无梗概或主线简述：可先去「章节阅读」生成本章梗概，或在「全书规划师」生成主线简述。</div>`;
      }
      synCard.innerHTML = `<h4>${title}</h4>${body}`;
      synPop.classList.remove('hidden');
    };
    synPop.onclick = (e)=>{ if(e.target === synPop) synPop.classList.add('hidden'); };  // 点遮罩关闭
  }
}
document.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape'){
    const sp = $('#readerSynPop');
    if(sp && !sp.classList.contains('hidden')){ sp.classList.add('hidden'); return; }  // fixed8：先收起梗概浮层
    closeReader();
    const h = $('#histPanel'); if(h && !h.classList.contains('hidden')) closeHistPanel();
    const t = $('#themePanel'); if(t && !t.classList.contains('hidden')) closeThemePanel();
  }
});

/* ---------- 字数角标实时更新 + 页面末尾总字数 ---------- */
function updateChapterWc(i, text){
  const el = $('[data-wc-ch="'+i+'"]');
  if(!el) return;
  const w = countWords(text);
  el.innerHTML = wcInner(w);
  el.title = `中文 ${w.cjk} 字 · 英文 ${w.en} 词`;
}
function updateWcTotal(){
  const el = $('#wcTotal'); if(!el) return;
  const chapters = state.chapters.filter(c=> c.content && c.content.trim());
  if(!chapters.length){ el.classList.add('hidden'); el.innerHTML=''; return; }
  let total=0, cjk=0, en=0;
  chapters.forEach(c=>{ const w = countWords(c.content); total+=w.total; cjk+=w.cjk; en+=w.en; });
  const fmt = n=> n.toLocaleString('en-US');
  el.classList.remove('hidden');
  el.innerHTML = `<span class="inner">📚 小说内容总字数 <b>${fmt(total)}</b> <span class="brk">（中 ${fmt(cjk)} · 英 ${en}）</span></span>`;
}

/* 长篇模式：写入进度（已写/总章数 + 估算字数目标） */
function renderLongProgress(){
  const el = $('.long-progress'); if(!el) return;
  const done = state.chapters.filter(c=> c.content && c.content.trim()).length;
  const total = state.chapters.length;
  let chars = 0; state.chapters.forEach(c=> chars += countWords(c.content).total);
  const cap = total ? `全书 ${total} 章` : (chapterCountVal() ? `全书 ${chapterCountVal()} 章` : '');
  el.innerHTML = `<span class="pill">写作进度：${done}/${total} 章</span> <span class="pill">已写约 ${chars.toLocaleString('en-US')} 字${cap ? ' · '+cap : ''}</span>`;
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
  const ids = [...new Set(state.characters.map(c=>(c.profile&&c.profile.身份)||c.role||'').filter(Boolean))];
  const identOptions = ids.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');
  return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3>🧑 角色定妆提示词包（${state.characters.length}）</h3>
        <span class="btn-row" style="margin:0">
          ${hasAssetHist('characters')?`<button id="btnCharHist" class="btn ghost">🕘 历史(${assetHistCount('characters')})</button>`:''}
          <button id="btnGenChars" class="btn ghost">🔄 重生成</button>
        </span>
      </div>
      <div class="char-toolbar">
        <input id="charSearch" class="char-search" placeholder="🔍 搜索角色姓名 / 身份…" value="${esc(charFilters.q)}">
        <select id="charJump" class="char-jump" placeholder="选择角色快速定位"></select>
        <select id="charIdent" multiple placeholder="身份筛选（可多选）">${identOptions}</select>
        <div class="char-filters">
          <select id="charGender">
            <option value="" ${charFilters.gender===''?'selected':''}>性别：全部</option>
            <option value="男" ${charFilters.gender==='男'?'selected':''}>男</option>
            <option value="女" ${charFilters.gender==='女'?'selected':''}>女</option>
            <option value="其他" ${charFilters.gender==='其他'?'selected':''}>其他</option>
          </select>
          <div class="cf-age">
            <input type="number" id="ageMin" class="age-input" placeholder="年龄≥" min="0" max="200" value="${esc(charFilters.ageMin)}">
            <span class="age-sep">~</span>
            <input type="number" id="ageMax" class="age-input" placeholder="年龄≤" min="0" max="200" value="${esc(charFilters.ageMax)}">
          </div>
        </div>
        <div class="char-count" id="charCount"></div>
      </div>
    </div>
    <div id="charList">${charFiltered().map(idx=>charCard(state.characters[idx], idx)).join('')}</div>` + fallbackRaw('characters');
}

function charCard(c, idx){
  const pf = c.profile||{};
  // P1-3 角色卡内字段可编辑：profile 键值 → input，prompts → textarea，失焦即存
  const kv = Object.entries(pf).map(([k,v])=>`<div class="kv"><span class="k">${esc(k)}</span><input type="text" class="char-edit" data-char-kv="${idx}" data-key="${esc(k)}" data-orig="${esc(v)}" value="${esc(v)}" /></div>`).join('');
  const order = ['定妆图','三视图','表情','服饰细节','道具','配色','材质'];
  const pr = c.prompts||{};
  const cards = order.map(k=>pr[k]==null?'':`
    <div class="subcard">
      <div class="lbl">${esc(k)}<button class="copy" data-copy="${esc(pr[k])}">复制</button></div>
      <textarea class="char-edit" data-char-prompt="${idx}" data-key="${esc(k)}" data-orig="${esc(pr[k])}" rows="3">${esc(pr[k])}</textarea>
    </div>`).join('');
  const allText = Object.values(pf).join(' ') + ' ' + Object.values(pr).join(' ');
  return `<div class="card" id="char-${idx}">
    <h3 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${esc(c.name||'未命名')} <span class="pill">${esc(c.role||'')}</span> ${wcBadge(allText)}</h3>
    <div class="subcard">${kv}</div>
    ${cards}
    <p class="muted" style="margin:4px 0 0;font-size:11px">字段可直接编辑，失焦即存（不触发 AI）。</p>
  </div>`;
}
// P1-3 角色卡编辑绑定：失焦即存（profile 键值 / prompts 提示词）
function bindCharEdit(){
  $$('[data-char-kv],[data-char-prompt]').forEach(inp=>{
    inp.onchange = ()=>{
      const idx = inp.hasAttribute('data-char-kv') ? +inp.dataset.charKv : +inp.dataset.charPrompt;
      const c = state.characters[idx]; if(!c) return;
      const k = inp.dataset.key;
      const v = inp.value;
      if(v === inp.dataset.orig) return;
      if(inp.hasAttribute('data-char-kv')){
        if(!c.profile) c.profile = {};
        c.profile[k] = v;
      } else {
        if(!c.prompts) c.prompts = {};
        c.prompts[k] = v;
      }
      inp.dataset.orig = v;
      persist();
      toast('角色卡已保存');
    };
  });
}

/* ---------- 角色筛选：搜索 / 身份 / 性别 / 年龄区间（返回保留原索引） ---------- */
function charFiltered(){
  const {q, idents, gender, ageMin, ageMax} = charFilters;
  const min = ageMin===''||ageMin==null ? null : +ageMin;
  const max = ageMax===''||ageMax==null ? null : +ageMax;
  const out = [];
  state.characters.forEach((c,i)=>{
    const pf = c.profile||{};
    if(q){
      const hay = ((c.name||'')+' '+(c.role||'')+' '+(pf.身份||'')).toLowerCase();
      if(!hay.includes(q.toLowerCase())) return;
    }
    if(idents && idents.length){
      const id = pf.身份||c.role||'';
      if(!idents.some(v=> id.includes(v) || v.includes(id))) return;
    }
    if(gender){
      const g = pf.性别||'';
      if(gender==='其他'){ if(g==='男'||g==='女') return; }
      else if(g!==gender && !g.includes(gender)) return;
    }
    if(min!=null || max!=null){
      const age = parseAge(pf.年龄);
      if(age==null) return; // 未知年龄在有区间约束时默认不显示
      if(min!=null && age<min) return;
      if(max!=null && age>max) return;
    }
    out.push(i);
  });
  return out;
}
function applyCharFilters(){
  const wrap = $('#charList'); if(!wrap) return;
  const idxs = charFiltered();
  wrap.innerHTML = idxs.length
    ? idxs.map(i=>charCard(state.characters[i], i)).join('')
    : `<div class="center-empty">没有符合条件的角色，试试放宽筛选条件。</div>`;
  const cnt = $('#charCount');
  if(cnt) cnt.textContent = `显示 ${idxs.length} / ${state.characters.length} 个角色`;
  bindCopyBtns();
  bindCharEdit();
}
function bindCopyBtns(){ $$('[data-copy]').forEach(b=> b.onclick = ()=> copyText(b.getAttribute('data-copy')) ); }

/* 角色页筛选/下拉初始化（Tom Select：选择角色快速定位 + 身份多选筛选） */
function initCharFilter(){
  if(!window.TomSelect) return;
  const wrap = $('#charList'); if(!wrap) return;
  // 下拉「选择角色快速定位」
  const jumpSel = $('#charJump');
  if(jumpSel){
    jumpSel.innerHTML = `<option value="">⬇️ 选择角色快速定位…</option>` + state.characters.map((c,i)=>`<option value="${i}">${esc(c.name||'未命名')}${c.role?(' · '+esc(c.role)):''}</option>`).join('');
    try{
      charTS.push(new TomSelect(jumpSel, {
        plugins:['dropdown_input'],
        placeholder:'⬇️ 选择角色快速定位…',
        allowEmptyOption:true,
        onChange: v=>{
          if(v==='' || v==null) return;
          const card = $('#char-'+v);
          if(card){ card.scrollIntoView({behavior:'smooth', block:'center'}); card.classList.add('flash'); setTimeout(()=>card.classList.remove('flash'), 1600); }
        }
      }));
      // 确保空占位
      try{ jumpSel.tomselect.setValue('', true); }catch(e){}
    }catch(e){}
  }
  // 身份多选筛选
  const identSel = $('#charIdent');
  if(identSel){
    try{
      const ts = new TomSelect(identSel, {
        plugins:['dropdown_input','clear_button'],
        placeholder:'身份筛选（可多选）',
        allowEmptyOption:false,
        onChange: v=>{ charFilters.idents = v||[]; applyCharFilters(); }
      });
      charTS.push(ts);
      if(charFilters.idents.length) ts.setValue(charFilters.idents, true);
    }catch(e){}
  }
}

/* ---------- P3 场景 ---------- */
// 封面提示词卡片（含「纯画面无文字 / 含汉字书名」双模式切换），长短篇共用
function coverCardHtml(){
  const modeLab = state.coverWithTitle ? '含汉字书名' : '纯画面·无文字';
  const modeHint = state.coverWithTitle
    ? '封面将包含书名汉字的书法大字作为主体文字。'
    : '封面为纯画面，预留书名留白，仅作底图，文字后期排版。';
  const seg = state.coverWithTitle
    ? `<div class="cover-modes"><button type="button" class="cm-on">🏷️ 含汉字书名</button><button type="button" class="cm-off" data-cv="clean">🖼️ 纯画面</button></div>`
    : `<div class="cover-modes"><button type="button" class="cm-off" data-cv="title">🏷️ 含汉字书名</button><button type="button" class="cm-on">🖼️ 纯画面</button></div>`;
  return `
    <div class="card cover-card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3 style="margin:0">📕 小说封面提示词</h3>
        <span class="btn-row" style="margin:0">
          ${hasAssetHist('cover')?`<button type="button" class="btn ghost" data-cover-hist>🕘 历史(${assetHistCount('cover')})</button>`:''}
          <span class="pill" id="coverModeLab">${modeLab}</span>
        </span>
      </div>
      ${seg}
      <p class="sub">${modeHint}</p>
      ${state.coverPrompt ? `
        <div class="subcard"><div class="lbl">封面提示词<button class="copy" data-copy="${esc(state.coverPrompt)}">复制</button></div><div class="prompt-text">${esc(state.coverPrompt)}</div></div>
        <label class="field" style="margin-top:8px"><span>✎ 编辑封面提示词（失焦即存，不触发 AI）</span>
          <textarea class="cover-edit" data-cover-edit>${esc(state.coverPrompt)}</textarea></label>
        <div class="btn-row" style="margin-top:8px"><button id="btnGenCover" class="btn ghost">🔄 重生成封面提示词</button></div>
      ` : `
        <div class="btn-row"><button id="btnGenCover" class="btn primary block">🖼️ 生成封面提示词</button></div>
        <p id="coverStatus" class="status"></p>
      `}
    </div>`;
}
function viewScenes(){
  if(!readyForAssets()) return `<div class="center-empty">请先在「故事」里确认大纲并生成章节。</div>`;
  // 长篇模式：只需封面提示词，无需"场景/角色/分镜"等视频资产
  if(isLong()) return coverCardHtml();
  const coverCard = coverCardHtml();
  if(!state.scenes.length){
    return coverCard + `<div class="card">
      <h3>🏞️ 场景提示词</h3>
      <p class="sub">AI 抽取关键场景，产出即梦出图提示词（含风格/光线/氛围/构图）。</p>
      <button id="btnGenScenes" class="btn primary block">✨ 生成场景提示词</button>
      <p id="sceneStatus" class="status"></p>
    </div>`;
  }
  return coverCard + `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center">
      <h3>🏞️ 场景提示词（${state.scenes.length}）</h3>
      <span class="btn-row" style="margin:0">
        ${hasAssetHist('scenes')?`<button id="btnSceneHist" class="btn ghost">🕘 历史(${assetHistCount('scenes')})</button>`:''}
        <button id="btnGenScenes" class="btn ghost">🔄 重生成</button>
      </span></div></div>` +
    state.scenes.map((s,si)=>`
    <div class="card">
      <h3 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <input type="text" class="scene-edit-name" data-scene-name="${si}" value="${esc(s.name||'')}" placeholder="场景名" style="flex:0 0 auto;min-width:120px;max-width:220px" />
        <span class="pill tag-env">🌿 纯环境·无人物</span> ${wcBadge((s.description||'')+' '+(s.prompt||''))}</h3>
      <p class="sub">作用：<input type="text" class="scene-edit-role" data-scene-role="${si}" value="${esc(s.作用||'')}" style="flex:1;min-width:160px" /></p>
      <div class="subcard"><div class="lbl">场景设定</div><textarea class="scene-edit-desc" data-scene-desc="${si}" rows="2">${esc(s.description||'')}</textarea></div>
      <div class="subcard"><div class="lbl">即梦出图提示词<button class="copy" data-copy="${esc(s.prompt||'')}">复制</button></div><textarea class="scene-edit-prompt" data-scene-prompt="${si}" rows="3">${esc(s.prompt||'')}</textarea></div>
      <p class="muted" style="margin:4px 0 0;font-size:11px">字段可直接编辑，失焦即存（不触发 AI）。</p>
    </div>`).join('') + fallbackRaw('scenes');
}

/* ---------- P4 分镜 ---------- */
function viewStoryboard(){
  if(!readyForAssets()) return `<div class="center-empty">请先在「故事」里确认大纲并生成章节。</div>`;
  if(!state.storyboard.length){
    return `<div class="card">
      <h3>🎞️ 分镜文字</h3>
      <p class="sub">AI 按章节产出导演级分镜：每章先给「视觉概念+母题」，再拆镜头（景别/角度/运镜/光线/主体/构图/转场/时长/出图提示词/连续性契约）。每镜的「出图提示词」可直接去即梦出图，时长可手改。</p>
      <button id="btnGenBoard" class="btn primary block">✨ 生成分镜文字（逐章）</button>
      <p id="boardStatus" class="status"></p>
    </div>`;
  }
  // 按章节分组（兼容旧数据：无 章节 的归「未分组」，无 时长 按 3 秒）
  const groups = {};
  state.storyboard.forEach((s,i)=>{ const k = s.章节 || '未分组'; (groups[k]=groups[k]||[]).push(i); });
  const keys = Object.keys(groups).sort((a,b)=>{
    const na=+a, nb=+b;
    return (!isNaN(na)&&!isNaN(nb)) ? na-nb : String(a).localeCompare(String(b),'zh');
  });
  const rows = keys.map(k=>{
    const idxs = groups[k];
    const sec = idxs.reduce((sum,i)=> sum + (Number(state.storyboard[i].时长)||0), 0);
    const ci = (!isNaN(+k)&&state.boardConcepts&&state.boardConcepts[+k-1]) ? state.boardConcepts[+k-1] : null;
    return `<div class="board-ch">
      <div class="board-ch-head">
        <div class="board-ch-title">🎬 第${esc(k)}章</div>
        <div class="board-ch-stat" id="chStat-${esc(k)}">共 ${idxs.length} 镜 · 总时长 ${sec}s</div>
      </div>
      ${ci && (ci.视觉概念||ci.母题) ? `<div class="board-concept"><b>视觉概念：</b>${esc(ci.视觉概念||'')}${ci.母题?('<br><b>母题：</b>'+esc(ci.母题)):''}</div>`:''}
      ${idxs.map(i=>shotHtml(i)).join('')}
    </div>`;
  }).join('');
  const totalSec = state.storyboard.reduce((sum,s)=> sum + (Number(s.时长)||0), 0);
  return `<div class="card" style="display:flex;justify-content:space-between;align-items:center">
      <h3>🎞️ 分镜（${state.storyboard.length} 镜）</h3>
      <span class="btn-row" style="margin:0">
        ${hasAssetHist('storyboard')?`<button id="btnBoardHist" class="btn ghost">🕘 历史(${assetHistCount('storyboard')})</button>`:''}
        <button id="btnGenBoard" class="btn ghost">🔄 重生成</button>
      </span>
    </div>${rows}
    <div class="card board-total">⏱ 全局：<b id="boardTotal">共 ${state.storyboard.length} 镜 · 总时长 ${totalSec}s</b><span class="muted">（每镜时长可点击数字直接修改，统计实时联动）</span></div>`
    + fallbackRaw('storyboard');
}
function shotHtml(i){
  const s = state.storyboard[i];
  // P1-3 分镜卡字段可编辑：text 字段 → input/textarea（失焦即存，不触发 AI）
  const ed = (key, tag='input', rows=2)=> tag==='textarea'
    ? `<textarea class="shot-edit" data-shot="${i}" data-key="${esc(key)}" rows="${rows}">${esc(s[key]||'')}</textarea>`
    : `<input type="text" class="shot-edit" data-shot="${i}" data-key="${esc(key)}" value="${esc(s[key]||'')}" />`;
  return `<div class="shot">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span class="no">镜 ${esc(s.镜号)}</span>
      <span class="dur">⏱ <input type="number" class="dur-input" data-dur="${i}" value="${esc(s.时长??3)}" min="0.5" max="30" step="0.5"> 秒</span>
      ${wcBadge((s.画面描述||'')+' '+(s.出图提示词||''))}
    </div>
    <div class="meta">
      ${['景别','角度','运镜','光线','转场'].map(k=> s[k]?`<span class="pill">${esc(s[k])}</span>`:'').join('')}
    </div>
    ${s.主体!==undefined && s.主体!=='' ? `<div class="prompt-text" style="margin-top:6px"><b>主体：</b>${ed('主体')}</div>`:''}
    ${s.构图!==undefined && s.构图!=='' ? `<div class="prompt-text" style="margin-top:4px"><b>构图：</b>${ed('构图')}</div>`:''}
    <div class="prompt-text" style="margin-top:6px">${ed('画面描述','textarea',2)}</div>
    ${ s.对白 ? `<div class="sub" style="margin-top:6px">💬 ${ed('对白')}</div>`:'' }
    <div class="subcard" style="margin-top:8px"><div class="lbl">出图提示词<button class="copy" data-copy="${esc(s.出图提示词||'')}">复制</button></div>${ed('出图提示词','textarea',3)}</div>
    ${ s.连续性 ? `<div class="muted" style="margin-top:6px">🔗 连续性：${ed('连续性')}</div>`:'' }
    ${ s.剪辑动机 ? `<div class="muted" style="margin-top:4px">🎯 剪辑动机：${ed('剪辑动机')}</div>`:'' }
    <p class="muted" style="margin:4px 0 0;font-size:11px">字段可直接编辑，失焦即存（不触发 AI）。</p>
  </div>`;
}
// P1-3 分镜卡编辑绑定：失焦即存
function bindShotEdit(){
  $$('[data-shot]').forEach(inp=>{
    inp.onchange = ()=>{
      const s = state.storyboard[+inp.dataset.shot]; if(!s) return;
      s[inp.dataset.key] = inp.value;
      persist();
      toast('分镜已保存');
    };
  });
}
/* 分镜时长联动：手改某镜秒数后，实时刷新对应章段头 + 全局统计 */
function updateBoardTiming(){
  const groups = {};
  state.storyboard.forEach((s,i)=>{ const k=s.章节||'未分组'; (groups[k]=groups[k]||[]).push(i); });
  Object.keys(groups).forEach(k=>{
    const sec = groups[k].reduce((sum,i)=> sum + (Number(state.storyboard[i].时长)||0), 0);
    const el = $('#chStat-'+k); if(el) el.textContent = `共 ${groups[k].length} 镜 · 总时长 ${sec}s`;
  });
  const totalSec = state.storyboard.reduce((sum,s)=> sum + (Number(s.时长)||0), 0);
  const el = $('#boardTotal'); if(el) el.textContent = `共 ${state.storyboard.length} 镜 · 总时长 ${totalSec}s`;
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
// P3-4 长篇导出勾选持久化：勾选状态存 state.expSel，随项目快照持久化（刷新/切换不丢）

function viewExport(){
  // 长篇模式：多选章节 + TXT / EPUB / DOCX 导出
  if(isLong()) return longExportView();
  // 门槛只要求「已生成大纲」：大纲一产出即展示「一、故事大纲」；生成章节后「二、章节正文」随之填充，始终可导
  if(!state.outline) return `<div class="center-empty">尚无可导出的内容。请先生成并确认故事大纲。</div>`;
  const md = buildMarkdown();
  return `<div class="card">
    <h3>📦 导出资产包</h3>
    <p class="sub">汇总故事 / 角色提示词 / 场景提示词 / 分镜，复制后粘贴到文档，或下载 .md。拿着提示词去「即梦」出图做视频。</p>
    <div class="btn-row">
      <button id="btnCopyAll" class="btn primary">📋 复制全部</button>
    </div>
  </div>
  <div class="card"><textarea id="exportArea" style="min-height:300px">${esc(md)}</textarea></div>`;
}

/* ---------- 长篇模式导出 ---------- */
function longExportView(){
  if(!state.outline) return `<div class="center-empty">尚无可导出的内容。请先生成故事大纲。</div>`;
  const written = state.chapters.filter(c=> c.content && String(c.content).trim()).length;
  // 清理已失效的勾选（章节被重生成等）
  state.expSel = state.expSel.filter(i=> state.chapters[i] && state.chapters[i].content && String(state.chapters[i].content).trim());
  const title = state.outline?.title || '未命名长篇小说';
  const md = buildLongMarkdown();
  // P5 分组折叠：仅当章节数超过阈值(20)才启用；默认只展开「含已勾选章节」的分组，其余收成一行分组头（借鉴 shutters-accordion 的折叠策略 + 写作卡片的 grid 折叠动画）
  const CH_PER_GROUP = 10, EXP_GROUP_THRESHOLD = 20;
  const useGroup = state.chapters.length > EXP_GROUP_THRESHOLD;
  if(useGroup && state.expOpenGroups.length === 0){
    const selSet = new Set(state.expSel);
    const ng = Math.ceil(state.chapters.length / CH_PER_GROUP);
    state.expOpenGroups = [];
    for(let g=0; g<ng; g++){
      let has=false;
      for(let i=g*CH_PER_GROUP; i<Math.min(state.chapters.length,(g+1)*CH_PER_GROUP); i++){ if(selSet.has(i)){ has=true; break; } }
      if(has) state.expOpenGroups.push(g);
    }
  }
  const expGroupHTML = ()=>{
    const label = (c,i,ok)=> `<label class="exp-ch ${ok?'':'disabled'}"><input type="checkbox" data-expch="${i}" ${state.expSel.includes(i)?'checked':''} ${ok?'':'disabled'}><span class="exp-ch-no">第${i+1}章</span><span class="exp-ch-title">${esc(c.title||'')}</span><span class="wc">${ok? wcInner(countWords(c.content)) : '未写'}</span></label>`;
    if(!useGroup) return state.chapters.map((c,i)=> label(c,i,!!(c.content&&String(c.content).trim()))).join('');
    const n = state.chapters.length, ng = Math.ceil(n/CH_PER_GROUP);
    let out='';
    for(let g=0; g<ng; g++){
      const s=g*CH_PER_GROUP, e=Math.min(n,(g+1)*CH_PER_GROUP), open=state.expOpenGroups.includes(g);
      let items='';
      for(let i=s;i<e;i++){ const c=state.chapters[i]; items += label(c,i,!!(c.content&&String(c.content).trim())); }
      const selCnt = state.expSel.filter(i=> i>=s && i<e).length;
      out += `<div class="exp-group ${open?'open':''}" data-expgroup="${g}"><div class="exp-group-t" role="button" data-expgroup-t="${g}"><span class="exp-group-ttl">第${s+1}—${e}章</span>${selCnt?`<span class="muted exp-group-sum">已选${selCnt}</span>`:''}<span class="sc-fold-ico">${open?'▾':'▸'}</span></div><div class="exp-group-body">${items}</div></div>`;
    }
    return out;
  };
  // 资产包（story 大纲 + 章节梗概 + 章节全文）前置，与普通模式 viewExport 同款；原长篇选择/格式导出后置
  return `
    <div class="card">
      <h3>📦 导出资产包 · ${esc(title)}</h3>
      <p class="sub">汇总故事大纲 / 各章主线简述，复制后粘贴到文档，或下载 .md；章节全文请用下方成书导出（TXT / EPUB / DOCX）。</p>
      <div class="btn-row">
      <button id="lnCopyAll" class="btn primary">📋 复制全部</button>
<button id="lnExportReader" class="btn ghost">📖 阅读</button>
    </div>
    </div>
    <div class="card"><textarea id="lnExportArea" style="min-height:300px" readonly>${esc(md)}</textarea></div>
    <div class="card">
      <h3>📦 导出成书（选章节 + 三种格式）</h3>
      <p class="sub">勾选要导出的章节（单章 / 多章 / 全部）。不勾选直接点导出将默认导出全部已写章节。支持三种格式：<b>TXT</b> 纯文本、<b>EPUB</b> 电子书、<b>DOCX</b> 文档。</p>
      <div class="btn-row">
        <button id="expSelAll" class="btn ghost">☑️ 全选已写</button>
        <button id="expSelNone" class="btn ghost">⬜ 清空</button>
        <span class="muted" id="expCount">已选 ${state.expSel.length} / 已写 ${written} 章（共 ${state.chapters.length} 章）</span>
      </div>
      <div class="exp-ch-list" data-exp-ch-list>
        ${expGroupHTML()}
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button id="expTxt" class="btn">📄 导出 TXT</button>
        <button id="expEpub" class="btn">📚 导出 EPUB</button>
        <button id="expDocx" class="btn">📝 导出 DOCX</button>
      </div>
      <p id="exportStatus" class="status"></p>
    </div>`;
}

// 导出内容「阅读」模式：复用阅读器展示全文
function openExportReader(){
  const ta = $('#lnExportArea');
  if(!ta || !ta.value.trim()){ toast('暂无导出内容'); return; }
  const ov = $('#readerOverlay'); if(!ov) return;
  $('#readerTitle').textContent = `📖 全文阅读 · ${esc(state.outline?.title||'未命名')}`;
  // 解析 markdown 行，章节标题渲染为 h3，其他为段落
  const lines = ta.value.split('\n').map(l=>l.trim());
  let html = '';
  for(const l of lines){
    if(!l) continue;
    if(/^#{1,3}\s/.test(l)) html += `<h3>${esc(l.replace(/^#+\s*/,''))}</h3>`;
    else if(/^第\d+[章节]/.test(l) || /^第[一二三四五六七八九十百千]+[章节]/.test(l)) html += `<h3>${esc(l)}</h3>`;
    else html += `<p>${esc(l)}</p>`;
  }
  $('#readerBody').innerHTML = html || '<p class="muted">（暂无内容）</p>';
  // 隐藏章节目录和梗概按钮（全文阅读不适用）
  const tocBtn = $('#readerTocBtn'); if(tocBtn) tocBtn.style.display = 'none';
  const synBtn = $('#readerSynBtn'); if(synBtn) synBtn.style.display = 'none';
  // 重置滚动位置
  const body0 = $('#readerBody');
  if(body0) body0.scrollTop = 0;
  updateReaderProgress();   // v10.42 导出全文阅读打开时复位进度条
  ov.dataset.exportReader = '1';   // 标记为导出阅读模式
  ov.classList.remove('hidden');
  document.body.classList.add('reader-lock');
}

// 长篇导出「资产包」内容：故事大纲 + 主线简述 + 章节全文（与普通 buildMarkdown 的结构对齐，取长篇字段）
function buildLongMarkdown(){
  const o = state.outline;
  let md = `# ${o?.title||'未命名长篇小说'}\n\n`;
  md += `## 一、故事大纲\n**小说简介**：${o?.logline||''}\n\n`;
  if(o?.anchor) md += `**核心定位**：${o.anchor}\n${o?.thesis?`**深层命题**：${o.thesis}`:''}\n\n`;
  (o?.chapters||[]).forEach((c,i)=>{
    // v1.0.117 导出内容框只保留各章主线简述：不再含本章梗概(strip)与章节正文（成书全文走 TXT/EPUB/DOCX）
    const plan = (Array.isArray(o.chapterPlans) && o.chapterPlans[i] && chapterPlanText(o.chapterPlans[i])) ? chapterPlanText(o.chapterPlans[i]) : '';
    md += `${i+1}. **${cleanChapterTitle(c.title)||''}**${plan?` — 主线简述：${plan}`:'（未生成梗概）'}\n`;
  });
  return md;
}
function activeChapters(){
  let idx = state.expSel.filter(i=> state.chapters[i] && state.chapters[i].content && String(state.chapters[i].content).trim()).sort((a,b)=>a-b);
  if(!idx.length) idx = state.chapters.map((c,i)=> (c.content && String(c.content).trim())?i:null).filter(x=>x!==null);
  return idx;
}
function syncExpChecks(){
  $$('#view [data-expch]').forEach(cb=> cb.checked = state.expSel.includes(+cb.dataset.expch));
  const cnt = $('#expCount'); if(cnt) cnt.textContent = `已选 ${state.expSel.length} / 已写 ${state.chapters.filter(c=>c.content&&String(c.content).trim()).length} 章（共 ${state.chapters.length} 章）`;
}
function downloadBlob(name, blob){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(()=> URL.revokeObjectURL(a.href), 1000);
}
function expText(){
  const idx = activeChapters(); if(!idx.length){ toast('没有可导出的已写章节'); return; }
  const title = state.outline?.title || '未命名长篇小说';
  let t = `${title}\n${'='.repeat(24)}\n`;
  if(state.outline?.logline) t += `\n${state.outline.logline}\n\n`;
  idx.forEach(i=>{ const c=state.chapters[i]; t += `\n第${i+1}章 ${cleanChapterTitle(c.title)||''}\n\n${String(c.content||'').trim()}\n`; });
  download(`${title}_长篇.txt`, t);
  toast(`已导出 ${idx.length} 章 TXT`);
}
function expEpub(){
  const idx = activeChapters(); if(!idx.length){ toast('没有可导出的已写章节'); return; }
  if(typeof JSZip === 'undefined'){ toast('找不到 JSZip 库'); return; }
  const title = state.outline?.title || '未命名长篇小说';
  const author = '使用者';
  const uid = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('uuid-'+Date.now()+'-'+Math.random().toString(16).slice(2));
  const modDate = new Date().toISOString();
  const base = 'OEBPS';
  const chapterFiles = idx.map(i=>{
    const c = state.chapters[i];
    const paras = String(c.content||'').split(/\n+/).map(p=>p.trim()).filter(Boolean)
      .map(p=> `<p>${esc(p)}</p>`).join('\n');
    const h1 = `第${i+1}章 ${esc(cleanChapterTitle(c.title)||'')}`;
    const xhtml = `<?xml version="1.0" encoding="utf-8"?>\n`+
      `<!DOCTYPE html>\n`+
      `<html xmlns="http://www.w3.org/1999/xhtml">\n<head>\n  <title>${freeText(h1)}</title>\n  <link rel="stylesheet" type="text/css" href="styles.css"/>\n</head>\n<body>\n  <h1>${h1}</h1>\n${paras}\n</body>\n</html>`;
    return { id:'ch'+(i+1), file:`text/ch${i+1}.xhtml`, title:h1, xhtml };
  });
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', {compression:'STORE'});
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="${base}/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>`);
  const manifest = chapterFiles.map(f=>`    <item id="${f.id}" href="${f.file}" media-type="application/xhtml+xml"/>`).join('\n');
  const spine = chapterFiles.map(f=>`    <itemref idref="${f.id}"/>`).join('\n');
  zip.file(`${base}/content.opf`, `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">\n  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n    <dc:identifier id="uid">urn:uuid:${uid}</dc:identifier>\n    <dc:title>${freeText(title)}</dc:title>\n    <dc:language>zh-CN</dc:language>\n    <dc:creator>${freeText(author)}</dc:creator>\n    <meta property="dcterms:modified">${modDate}</meta>\n  </metadata>\n  <manifest>\n    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n    <item id="css" href="styles.css" media-type="text/css"/>\n${manifest}\n  </manifest>\n  <spine>\n${spine}\n  </spine>\n</package>`);
  const navLis = chapterFiles.map(f=>`    <li><a href="${f.file}">${freeText(f.title)}</a></li>`).join('\n');
  zip.file(`${base}/nav.xhtml`, `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n<head>\n  <meta charset="utf-8"/>\n  <title>${freeText(title)}</title>\n</head>\n<body>\n  <nav epub:type="toc" id="toc">\n    <h1>目录</h1>\n    <ol>\n${navLis}\n    </ol>\n  </nav>\n</body>\n</html>`);
  const ncxPts = chapterFiles.map((f,i)=>`    <navPoint id="${f.id}" playOrder="${i+1}"><navLabel><text>${freeText(f.title)}</text></navLabel><content src="${f.file}"/></navPoint>`).join('\n');
  zip.file(`${base}/toc.ncx`, `<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n  <head><meta name="dtb:uid" content="urn:uuid:${uid}"/></head>\n  <docTitle><text>${freeText(title)}</text></docTitle>\n  <navMap>\n${ncxPts}\n  </navMap>\n</ncx>`);
  zip.file(`${base}/styles.css`, `body{font-family:serif,"PingFang SC","Source Han Serif SC",serif;line-height:1.9;margin:2em;color:#222}\nh1{font-size:1.4em;text-align:center;margin-bottom:1.6em;color:#333}\np{text-indent:2em;margin:0.5em 0}`);
  chapterFiles.forEach(f=> zip.file(`${base}/${f.file}`, f.xhtml));
  const st = $('#exportStatus'); if(st) st.textContent = '正在打包 EPUB…';
  zip.generateAsync({type:'blob', mimeType:'application/epub+zip'}).then(blob=>{
    downloadBlob(`${title}_长篇.epub`, blob);
    if(st) st.textContent = '';
    toast(`已导出 EPUB（${idx.length} 章）`);
  }).catch(()=>{ if(st) st.textContent='打包失败'; toast('EPUB 打包失败'); });
}
function expDocx(){
  const idx = activeChapters(); if(!idx.length){ toast('没有可导出的已写章节'); return; }
  if(typeof JSZip === 'undefined'){ toast('找不到 JSZip 库'); return; }
  const title = state.outline?.title || '未命名长篇小说';
  const xmlEsc = t=> String(t??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const paras = [];
  paras.push(`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t xml:space="preserve">${xmlEsc(title)}</w:t></w:r></w:p>`);
  if(state.outline?.logline) paras.push(`<w:p><w:r><w:t xml:space="preserve">${xmlEsc(state.outline.logline)}</w:t></w:r></w:p>`);
  idx.forEach(i=>{
    const c = state.chapters[i];
    paras.push(`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">第${i+1}章 ${xmlEsc(cleanChapterTitle(c.title)||'')}</w:t></w:r></w:p>`);
    String(c.content||'').split(/\n+/).map(p=>p.trim()).filter(Boolean)
      .forEach(p=> paras.push(`<w:p><w:r><w:t xml:space="preserve">${xmlEsc(p)}</w:t></w:r></w:p>`));
  });
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n  <Default Extension="xml" ContentType="application/xml"/>\n  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>\n</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>\n</Relationships>`);
  const body = paras.join('\n');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`);
  const st = $('#exportStatus'); if(st) st.textContent = '正在打包 DOCX…';
  zip.generateAsync({type:'blob', mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}).then(blob=>{
    downloadBlob(`${title}_长篇.docx`, blob);
    if(st) st.textContent = '';
    toast(`已导出 DOCX（${idx.length} 章）`);
  }).catch(()=>{ if(st) st.textContent='打包失败'; toast('DOCX 打包失败'); });
}
function freeText(t){ return String(t??'').replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function buildMarkdown(){
  const o = state.outline;
  let md = `# 影视前期资产包 · ${o?.title||'未命名'}\n\n> 由「影视前期提示词生成器」生成 · 出图请在即梦用提示词生成\n\n`;
  md += `## 一、故事大纲\n**小说简介**：${o?.logline||''}\n\n`;
  if(o?.anchor) md += `**核心定位**：${o.anchor}\n${o?.thesis?`**深层命题**：${o.thesis}`:''}\n\n`;
  (o?.chapters||[]).forEach((c,i)=>{
    // v1.0.117 导出内容框只保留各章主线简述，去掉本章梗概与章节正文（全文走 TXT/EPUB/DOCX）
    const plan = (Array.isArray(o.chapterPlans) && o.chapterPlans[i] && chapterPlanText(o.chapterPlans[i])) ? chapterPlanText(o.chapterPlans[i]) : '';
    md += `${i+1}. **${cleanChapterTitle(c.title)||''}** — ${plan||'（未生成梗概）'}\n`;
  });
  // 章节正文不再拼入内容框（成书全文走 TXT/EPUB/DOCX 导出）
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
    md += `\n## 四、场景提示词（纯环境 · 无人物，供视频 AI 空镜/环境参考）\n`;
    state.scenes.forEach(s=> md += `\n### ${s.name}（${s.作用||''}）\n- 设定：${s.description||''}\n- 即梦提示词（无人物）：${s.prompt||''}\n`);
  }
  if(state.storyboard.length){
    md += `\n## 五、分镜表（按章节，含时长）\n`;
    const groups = {};
    state.storyboard.forEach(s=>{ const k=s.章节||'未分组'; (groups[k]=groups[k]||[]).push(s); });
    const keys = Object.keys(groups).sort((a,b)=>{ const na=+a,nb=+b; return (!isNaN(na)&&!isNaN(nb))?na-nb:String(a).localeCompare(String(b),'zh'); });
    keys.forEach(k=>{
      const list = groups[k];
      const sec = list.reduce((a,s)=> a+(Number(s.时长)||0),0);
      md += `\n### 第${k}章（${list.length} 镜 · 总时长 ${sec}s）\n`;
      list.forEach(s=>{
        md += `\n**镜${s.镜号}**（${s.时长??3}s）｜ ${s.景别||''} ｜ ${s.角度||''} ｜ ${s.运镜||''} ｜ ${s.光线||''}\n`;
        if(s.主体) md += `- 主体：${s.主体}\n`;
        if(s.构图) md += `- 构图：${s.构图}\n`;
        md += `- 画面：${s.画面描述||''}\n`;
        if(s.对白) md += `- 对白：${s.对白}\n`;
        if(s.转场) md += `- 转场：${s.转场}\n`;
        md += `- 出图提示词：${s.出图提示词||''}\n`;
        if(s.连续性) md += `- 连续性：${s.连续性}\n`;
        if(s.剪辑动机) md += `- 剪辑动机：${s.剪辑动机}\n`;
      });
    });
  }
  return md;
}

/* =========================================================
 * 事件绑定
 * ========================================================= */
function bindView(){
  // 复制按钮（事件委托）
  bindCopyBtns();
  bindCharEdit();      // P1-3 角色卡字段编辑
  bindShotEdit();      // P1-3 分镜卡字段编辑

  // 赛博朋克首页入口卡片
  $$('.cyber-home-grid [data-step]').forEach(b=> b.onclick = ()=>{ if(!guardSwitchStep()) return; currentStep = +b.dataset.step; render(); window.scrollTo(0,0); });

  // P1
  const idea = $('#ideaInput'); if(idea){
    idea.oninput = ()=> state.idea = idea.value;
    bindPolishIdea();   // v10.13 优化构想按钮 + 优化区绑定
    $('#btnGenOutline').onclick = genOutline;
  }
  // v11 简介字数范围（生成大纲前、仅长篇）：双数字输入，min>max 自动对调、max 上限 5000
  const llMin = $('#llMin'), llMax = $('#llMax');
  if(isLong() && llMin && llMax){
    const commitLL = ()=>{
      let mn = Math.floor(Number(llMin.value)), mx = Math.floor(Number(llMax.value));
      if(!Number.isFinite(mn) || mn<1) mn = 300;
      if(!Number.isFinite(mx) || mx<1) mx = 700;
      if(mn>5000){ mn = 5000; llMin.value = 5000; }
      if(mx>5000){ mx = 5000; llMax.value = 5000; }
      if(mn>mx){ const _t=mn; mn=mx; mx=_t; llMin.value=mn; llMax.value=mx; }   // 兜底：自动对调
      state.loglineRange = {min:mn, max:mx};
      persist();
    };
    llMin.addEventListener('change', commitLL);
    llMax.addEventListener('change', commitLL);
  }
  // v10.18 结构骨架 / 可复用词典折叠（默认收起，点标题展开）
  $$('[data-rec-fold]').forEach(h=> h.onclick = ()=>{
    const key = h.dataset.recFold;
    state.recipeSet = state.recipeSet || {rhythm:null,titleStyle:[]};
    if(!state.recipeSet.recFold) state.recipeSet.recFold = {};
    state.recipeSet.recFold[key] = !state.recipeSet.recFold[key];
    const body = h.parentNode && h.parentNode.querySelector('.recipe-fold-b');
    if(body) body.hidden = !state.recipeSet.recFold[key];
    const ico = h.querySelector('.rec-fold-ico'); if(ico) ico.textContent = state.recipeSet.recFold[key]?'▾':'▸';
    h.setAttribute('aria-expanded', String(state.recipeSet.recFold[key]));
    persist();
  });
  // 全书章节数：直接填整数（1-200 必填）。失焦/回车提交 → 设定或解锁范式
  const ccIn = $('#totalWordsIn');
  if(ccIn){
    ccIn.addEventListener('keydown', e=>{ if(e.key==='Enter') ccIn.blur(); });
    ccIn.addEventListener('change', ()=>{
      const v = Math.floor(Number(ccIn.value));
      if(Number.isInteger(v) && v>=1 && v<=200){
        const _o = state.outline;
        const _hasTitle = _o && Array.isArray(_o.chapters) && _o.chapters.some(c=>c && String(c.title||'').trim());
        // v1.0.118 已生成章节标题后锁定：拒绝静默修改章节数（v225/P5-B：占位态（标题全空）不锁，保持可改）
        if(_hasTitle){
          toast('已生成章节标题，全书章节数已锁定；如需修改请通过「历史版本」恢复不同章节数的大纲');
          render(); return;
        }
        // v225/P5-B：占位态章节数变更——规划师已写过简述/节拍时显式确认并归档，再按新数量重建占位
        if(_o && Array.isArray(_o.chapters) && _o.chapters.length>0 && _o.chapters.length !== v){
          const _hasPlans = Array.isArray(_o.chapterPlans) && _o.chapterPlans.some(Boolean);
          if(_hasPlans && !confirm(`规划师已生成过主线简述/节拍表。章节数改为 ${v} 将按新数量重建章节占位（旧内容先归档入历史版本）。继续？`)){ render(); return; }
          if(_hasPlans){ snapshotOutline(); _o.chapterPlans = new Array(v).fill(null); }
          _o.chapters = Array.from({length:v}, ()=>({title:'', summary:''}));
        }
        state.chapterCount = v;
      }
      else { state.chapterCount = null; toast('章节数需为 1-200 的整数'); }
      persist(); render();
    });
  }
  bindGlossary();
  bindOrigIdea();     // v10.2 原始构想只读卡绑定
  bindOutlineFold();  // v1.0.107 故事大纲卡「小说简介」折叠绑定
  bindAnchors();     // v1.0.116 简介区核心定位/深层命题可编辑 + 重新提取
  bindAiRecipe();     // v10.30 AI配方助手绑定
  bindChapterPlan();  // v10.11 主线简述区块绑定
  bindChapterPlanFold(); // v10.14 梗概卡折叠绑定
  bindChapterTitles();// v10.14 章节标题编辑 + 复制绑定
  bindWriteStyle();   // v2.0 写作风格卡片绑定（chips/浓度/预设/收藏/管理/清空）
  // 故事页内联规范选择器
  $$('.spec-opt').forEach(b=> b.onclick = ()=>{ selectSpec(b.dataset.spec); });
  const btnCO = $('#btnConfirmOutline'); if(btnCO) btnCO.onclick = ()=>{ state.outlineConfirmed=true; persist(); render(); };
  const btnOH = $('#btnOutlineHist'); if(btnOH) btnOH.onclick = ()=> openOutlineHistoryPanel();
  const btnRO = $('#btnReOutline'); if(btnRO) btnRO.onclick = ()=>{ state.outline=null; state.outlineConfirmed=false; state.chapters=[]; persist(); render(); };
  // 短片：一键生成全部章节（从头生成全部，保留原「生成全部」覆盖语义）
  const btnGAShort = $('#btnGenAllChapters'); if(btnGAShort) btnGAShort.onclick = ()=> genManyChapters(state.chapters.length, true);
  // v1.0.120 长篇：批量生成多章（步进 + 预设 + 剩余章数联动，统一走 genManyChapters）
  bindGenBatchControls();
  bindRangeGen();   // v1.0.123 区间生成：指定起始章~结束章，无条件覆盖（旧版自动入历史）

  // 4.6 Plus 新增绑定（第 3 章：统一入口，isLong() 门控）
  if(isLong()){
    bindStructureCard();
    bindBeatSheet();
    bindStyleContractCard();
    bindFactCard();
    bindRollingSummaryCard();
    bindQualityReportCard();
    bindFixQueueCard();
  }

  // 标题管理器：点击当前名改名；点小三角展开/收起曾用名
  const tmCur = $('#tmCur'); if(tmCur) tmCur.onclick = ()=>{
    const newName = prompt('修改书名：', currentTitle());
    if(newName == null) return; // 取消
    renameTitle(newName);
  };
  const histPanel_ = $('#tmHist');
  // 曾用名：点击外部关闭
  const triBtn = $('#btnTmTri');
  if(triBtn) triBtn.onclick = (e)=>{
    e.stopPropagation();
    const on = triBtn.classList.toggle('on');
    if(histPanel_) histPanel_.classList.toggle('hidden', !on);
  };
  if(histPanel_) histPanel_.onclick = (e)=> e.stopPropagation();
  // P3-1 曾用名：一键恢复（改回该名，当前名自动记入曾用）/ 删除该条记录
  $$('#tmHist [data-hist-restore]').forEach(b=> b.onclick = (e)=>{
    e.stopPropagation();
    if(!confirm(`将书名恢复为「${b.dataset.histRestore}」？（当前名会记入曾用名）`)) return;
    renameTitle(b.dataset.histRestore);
    histPanel_.classList.add('hidden');
    const tri = $('#btnTmTri'); if(tri) tri.classList.remove('on');
  });
  $$('#tmHist [data-hist-del]').forEach(b=> b.onclick = (e)=>{
    e.stopPropagation();
    if(!confirm('删除该条曾用名记录？')) return;
    state.titleHistory.splice(+b.dataset.histDel, 1);
    persist(); render();
    toast('已删除该记录');
  });
  document.addEventListener('click', (e)=>{
    const pan = $('#tmHist');
    if(pan && !pan.classList.contains('hidden') && !e.target.closest('.title-manager')){
      pan.classList.add('hidden');
      const b = $('#btnTmTri'); if(b) b.classList.remove('on');
    }
  });
  // 长篇：章节跳转下拉
  const longJump = $('#longJump'); if(longJump) longJump.onchange = ()=>{ const i=+longJump.value; if(longJump.value!=='') openReader(i); longJump.value=''; }; 
  if(isLong()) renderLongProgress();

  // P2 角色：搜索 / 性别 / 年龄区间 / Tom Select 初始化
  if(currentStep===2){
    const s = $('#charSearch'); if(s){
      s.oninput = ()=>{ charFilters.q = s.value; applyCharFilters(); };
    }
    const g = $('#charGender'); if(g){
      g.onchange = ()=>{ charFilters.gender = g.value; applyCharFilters(); };
    }
    const aMin = $('#ageMin'), aMax = $('#ageMax');
    if(aMin) aMin.oninput = ()=>{ charFilters.ageMin = aMin.value; applyCharFilters(); };
    if(aMax) aMax.oninput = ()=>{ charFilters.ageMax = aMax.value; applyCharFilters(); };
    initCharFilter();
  }
  // P2
  const btnGC = $('#btnGenChars'); if(btnGC) btnGC.onclick = genCharacters;
  const btnCH = $('#btnCharHist'); if(btnCH) btnCH.onclick = ()=> openAssetHistPanel('characters');
  // P3
  const btnGS = $('#btnGenScenes'); if(btnGS) btnGS.onclick = genScenes;
  const btnCV = $('#btnGenCover'); if(btnCV) btnCV.onclick = genCover;
  const btnCVH = $('[data-cover-hist]'); if(btnCVH) btnCVH.onclick = ()=> openAssetHistPanel('cover');
  // P1-3 封面提示词行内编辑：失焦即存（不触发 AI）
  $$('[data-cover-edit]').forEach(ta=>{
    ta.onchange = ()=>{ state.coverPrompt = ta.value; persist(); toast('封面提示词已保存'); };
  });
  // 封面模式切换：纯画面(clean) / 含汉字书名(title)
  $$('[data-cv]').forEach(b=> b.onclick = ()=>{
    const v = b.dataset.cv === 'title';
    if(state.coverWithTitle === v) return;
    state.coverWithTitle = v;
    state.coverPrompt = ''; // 切换模式后旧提示词不再适用，清空待重生成
    persist(); render();
  });
  // P4
  const btnGB = $('#btnGenBoard'); if(btnGB) btnGB.onclick = genStoryboard;
  const btnBH = $('#btnBoardHist'); if(btnBH) btnBH.onclick = ()=> openAssetHistPanel('storyboard');
  const btnSH = $('#btnSceneHist'); if(btnSH) btnSH.onclick = ()=> openAssetHistPanel('scenes');
  // P1-3 场景卡行内编辑：失焦即存
  $$('[data-scene-name]').forEach(inp=> inp.onchange = ()=>{ const s=state.scenes[+inp.dataset.sceneName]; if(s){ s.name=inp.value; persist(); } });
  $$('[data-scene-role]').forEach(inp=> inp.onchange = ()=>{ const s=state.scenes[+inp.dataset.sceneRole]; if(s){ s.作用=inp.value; persist(); } });
  $$('[data-scene-desc]').forEach(ta=> ta.onchange = ()=>{ const s=state.scenes[+ta.dataset.sceneDesc]; if(s){ s.description=ta.value; persist(); } });
  $$('[data-scene-prompt]').forEach(ta=> ta.onchange = ()=>{ const s=state.scenes[+ta.dataset.scenePrompt]; if(s){ s.prompt=ta.value; persist(); toast('场景提示词已保存'); } });
  // P5
  const btnCA = $('#btnCopyAll'); if(btnCA) btnCA.onclick = ()=> copyText(buildMarkdown());
 
  // 长篇：多选章节 + 三种格式导出
  if(isLong()){
    // 资产包（与普通模式同款）：复制全部 / 下载 .md
    const lnCA = $('#lnCopyAll'); if(lnCA) lnCA.onclick = ()=> copyText(buildLongMarkdown());
const lnER = $('#lnExportReader'); if(lnER) lnER.onclick = openExportReader;
    $$('#view [data-expch]').forEach(cb=> cb.onchange = ()=>{
      const i = +cb.dataset.expch;
      if(cb.checked){ if(!state.expSel.includes(i)) state.expSel.push(i); } else state.expSel = state.expSel.filter(x=>x!==i);
      persist();   // P3-4 勾选随项目快照持久化
      syncExpChecks();
    });
    const selAll = $('#expSelAll'); if(selAll) selAll.onclick = ()=>{ state.expSel = state.chapters.map((c,i)=> (c.content && String(c.content).trim())?i:null).filter(x=>x!==null); persist(); syncExpChecks(); };
    const selNone = $('#expSelNone'); if(selNone) selNone.onclick = ()=>{ state.expSel=[]; persist(); syncExpChecks(); };
    // P5 分组头点击：展开/收起该分组，状态持久化（不重渲染，仅切类）
    $$('#view [data-expgroup-t]').forEach(t=> t.onclick = ()=>{
      const g = +t.dataset.expgroupT;
      const grp = t.closest('[data-expgroup]');
      const adding = !grp.classList.contains('open');
      grp.classList.toggle('open', adding);
      const ico = t.querySelector('.sc-fold-ico'); if(ico) ico.textContent = adding ? '▾' : '▸';
      if(adding){ if(!state.expOpenGroups.includes(g)) state.expOpenGroups.push(g); }
      else state.expOpenGroups = state.expOpenGroups.filter(x=>x!==g);
      persist();
    });
    const bt = $('#expTxt'); if(bt) bt.onclick = expText;
    const be = $('#expEpub'); if(be) be.onclick = expEpub;
    const bd = $('#expDocx'); if(bd) bd.onclick = expDocx;
  }

  // 章节编辑/重生成/确认/阅读（动态）
  renderChapters();
  // 用事件委托处理章节区内部点击：分页/折叠会重建部分按钮，委托在 #chaptersWrap 上保证始终生效（Bug2 修复）
  const chaptersDelegate = (e)=>{
    const t = e.target.closest('[data-regen],[data-toggle],[data-read],[data-fold],[data-page],[data-ver],[data-undo],[data-ch-raw],[data-ch-sum],[data-style-ok],[data-ne-resume-ch],[data-ne-sandbox-ch]');
    if(!t) return;
    if(t.hasAttribute('data-ver')){ openChapterVersionPanel(+t.dataset.ver); }
    else if(t.hasAttribute('data-undo')){ undoChapterEdit(+t.dataset.undo); }
    else if(t.hasAttribute('data-regen')){ openChapterRegenPanel(+t.dataset.regen); }
    else if(t.hasAttribute('data-ch-raw')){ openChRawPanel(+t.dataset.chRaw); }
    else if(t.hasAttribute('data-ch-sum')){ openChapterSummaryPanel(+t.dataset.chSum); }
    else if(t.hasAttribute('data-style-ok')){ confirmChapterStyle(+t.dataset.styleOk); }   // 4.5 确认风格 → 风格指纹来源
    else if(t.hasAttribute('data-style-unok')){ unconfirmChapterStyle(+t.dataset.styleUnok); }   // 取消确认风格 → 移出指纹来源
    else if(t.hasAttribute('data-toggle')){ const i=+t.dataset.toggle; state.chapters[i].confirmed=!state.chapters[i].confirmed; persist(); render(); }
    else if(t.hasAttribute('data-read')){ openReader(+t.dataset.read); }
    else if(t.hasAttribute('data-ne-resume-ch')){ const i=+t.dataset.neResumeCh; continueAndFinalizeChapter(i, '继续生成'); }
    else if(t.hasAttribute('data-ne-sandbox-ch')){ const i=+t.dataset.neSandboxCh; renderBranchSandbox(i); }
    else if(t.hasAttribute('data-fold')){ const i=+t.dataset.fold; const body=t.closest('.ch-card').querySelector('.ch-body'); const ico=t.querySelector('.ch-fold-ico'); const on = body.classList.toggle('folded'); t.setAttribute('aria-expanded', String(!on)); if(ico) ico.textContent = on?'▸':'▾'; }
    else if(t.hasAttribute('data-page')){ chPage = +t.dataset.page; renderChapters(); }
  };
  const cw = $('#chaptersWrap');
  if(cw && !cw.dataset.delegated){
    cw.dataset.delegated = '1';           // 只绑定一次，跨次 render 复用
    cw.addEventListener('click', chaptersDelegate);
    // textarea 输入也委托，分页重建后仍生效（Bug2 连带修复）
    cw.addEventListener('input', (e)=>{
      const ta = e.target.closest('textarea[data-ch]'); if(!ta) return;
      const i = +ta.dataset.ch; state.chapters[i].content = ta.value;
      persist(); updateChapterWc(i, ta.value); updateWcTotal();
    });
    // P0-3 手动编辑撤销：聚焦时记录原值，失焦（change）时若有变化把旧值快照入 editHistory（上限10）
    cw.addEventListener('focusin', (e)=>{
      const ta = e.target.closest('textarea[data-ch]'); if(!ta) return;
      const c = state.chapters[+ta.dataset.ch];
      ta._orig = c ? (c.content||'') : '';
    });
    cw.addEventListener('change', (e)=>{
      const ta = e.target.closest('textarea[data-ch]'); if(!ta) return;
      const i = +ta.dataset.ch; const c = state.chapters[i]; if(!c) return;
      const old = (ta._orig !== undefined) ? ta._orig : (c.content||'');
      if(ta.value !== old && String(ta.value||'') !== String(old||'')){
        if(!Array.isArray(c.editHistory)) c.editHistory = [];
        c.editHistory.push(old);
        if(c.editHistory.length > 10) c.editHistory.splice(0, c.editHistory.length - 10);   // 上限10
        persist(); renderChapters(); updateWcTotal();
        toast('已记录编辑快照，可用「↩ 撤销编辑」回退');
      }
    });
  }
  // 分镜时长手改：实时联动章段头与全局统计
  $$('[data-dur]').forEach(inp=> inp.oninput = ()=>{
    const i = +inp.dataset.dur;
    const v = parseFloat(inp.value);
    state.storyboard[i].时长 = isNaN(v)||v<=0 ? 0.5 : Math.min(30, v);
    persist(); updateBoardTiming();
  });
  bindReader();
}

/* =========================================================
 * 生成动作
 * ========================================================= */
/* ---------- P0-1 大纲版本历史：覆盖前快照 + 📚 弹窗预览/恢复（上限10） ---------- */
function snapshotOutline(){
  const o = state.outline;
  if(!o || typeof o !== 'object') return;
  const copy = JSON.parse(JSON.stringify(o));
  state.outlineHistory.unshift({ outline: copy, ts: Date.now() });
  if(state.outlineHistory.length > 50) state.outlineHistory.splice(50);
}
function hasOutlineHistory(){ return Array.isArray(state.outlineHistory) && state.outlineHistory.length > 0; }
function outlineHistoryCount(){ return hasOutlineHistory() ? state.outlineHistory.length : 0; }
function openOutlineHistoryPanel(){
  closeOutlineHistoryPanel();
  if(!hasOutlineHistory()){ toast('暂无历史版本'); return; }
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getFullYear())+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const wc = o => { const s = JSON.stringify(o||{}); return (s.length||0); };
  const rows = state.outlineHistory.map((h,idx)=>{
    const o = h.outline || {};
    const n = (o.chapters||[]).length;
    return `<div class="cv-row">
      <div class="cv-meta" style="flex:1;min-width:0"><div class="cv-time">${fmtTs(h.ts)}</div><div class="cv-t" style="font-size:12px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(o.title||'未命名')} · ${n} 章 · ${wc(o)} 字符</div></div>
      <div class="cv-actions" style="display:flex;gap:6px;flex-shrink:0">
        <button type="button" class="btn ghost cv-b" data-ov-prev="${idx}">预览</button>
        <button type="button" class="btn ghost cv-b" data-ov-restore="${idx}">↩ 恢复</button>
      </div>
    </div>`;
  }).join('');
  const ov = document.createElement('div'); ov.id='ovPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>📚 大纲版本历史（${state.outlineHistory.length}/50）</b>
        <button class="gs-x" data-ov-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-row cur"><div class="cv-meta"><span class="cv-time">当前版本</span><span class="cv-wc">${esc((state.outline&&state.outline.title)||'未命名')} · ${(state.outline&&state.outline.chapters||[]).length} 章</span></div></div>
        <div class="cv-div">历史版本：恢复前会把当前大纲自动存入历史；恢复后章节列表按该版大纲重建（正文清空，已写章节保留在版本内可回退）。</div>
        ${rows}
        <div class="cv-preview hidden" id="ovPreview">
          <div class="cv-prev-head"><b id="ovPrevTitle">版本预览</b><button class="gs-x" data-ov-prev-close>✕</button></div>
          <div class="cv-pre" id="ovReader"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-ov-close]').onclick = closeOutlineHistoryPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeOutlineHistoryPanel(); });
  ov.addEventListener('click', e=>{
    const p = e.target.closest('[data-ov-prev]'); if(!p) return;
    const h = state.outlineHistory[+p.dataset.ovPrev]; if(!h) return;
    const o = h.outline||{};
    const pr=$('#ovPreview'), rd=$('#ovReader'), pt=$('#ovPrevTitle');
    if(pr && rd){
      pt.textContent = '预览 · '+fmtTs(h.ts);
      rd.innerHTML = `<b>${esc(o.title||'')}</b><br><span class="muted">${esc(o.logline||'')}</span><br><br>` +
        (o.chapters||[]).map((c,i)=>`${i+1}. ${esc((c&&c.title)||'')}`).join('<br>');
      pr.classList.remove('hidden');
    }
  });
  ov.querySelector('[data-ov-prev-close]').onclick = ()=>{ const pr=$('#ovPreview'); if(pr) pr.classList.add('hidden'); };
  ov.addEventListener('click', e=>{
    const rb = e.target.closest('[data-ov-restore]'); if(!rb) return;
    const h = state.outlineHistory[+rb.dataset.ovRestore]; if(!h) return;
    if(!window.confirm('恢复该版大纲将覆盖当前大纲（当前大纲自动存入历史，不会丢失）。若新旧章节数一致，已写正文会保留；否则章节列表按该版重建。确定恢复吗？')) return;
    snapshotOutline();                       // 当前大纲入历史
    const newOutline = JSON.parse(JSON.stringify(h.outline));
    const oldOutline = state.outline;
    state.outline = newOutline;
    state.outlineConfirmed = false;
    if(state.chapters.length === (newOutline.chapters||[]).length && oldOutline && (oldOutline.chapters||[]).length === state.chapters.length){
      // 章节数一致：保留已写正文，仅同步标题（避免恢复大纲把正文冲掉）
      state.chapters.forEach((c,i)=>{ const oc=newOutline.chapters[i]; if(oc) c.title = oc.title; });
    } else {
      state.chapters = (newOutline.chapters||[]).map(c=>({title:(c&&c.title)||'', content:'', strip:'', confirmed:false}));
    }
    persist(); closeOutlineHistoryPanel(); render();
    toast('已恢复历史大纲');
  });
}
function closeOutlineHistoryPanel(){ const p=$('#ovPanel'); if(p) p.remove(); }

// 4.5：genOutline 改造——走 callAIWithContract 校验；保留 title/logline/anchor/thesis/structure；
// chapters 数量一致时保留旧标题；锚点前移（直接使用 AI 返回的 anchor/thesis，不再事后提取）。
async function genOutline(){
  const btn = $('#btnGenOutline');
  const st = $('#outlineStatus');
  if(st){ st.className='status'; st.textContent=''; }
  state.idea = $('#ideaInput').value.trim();
  if(!state.idea){ toast('先写几句构想'); if(btn) busy(btn,false); return; }
  // 4.8 旗舰版（6.4）：拓扑路由检查 + 运行态标记（唯一执行前检查入口）
  if(!canRunAI('outline')){ toast('请先完成上游步骤：优化构想'); if(btn) busy(btn,false); return; }
  markAIRunning('outline');
  if(btn) busy(btn,true,'生成大纲中…');
  // 如果还没有 navBeacon，提示用户先优化构想
  if(!state.outline || !state.outline.navBeacon){
    toast('建议先「优化构想」生成结构化设定，再生成大纲');
  }
  const stopParent = btn.parentNode;
  showStopBtn(stopParent);
  try{
    // 4.8（4.4）：统一经 callAIGuarded('outline')——system=buildOutlineSys()、user=buildOutlineUser(ctx)、校验=validateOutlineOutput
    // 4.9 加固：大纲 JSON 体量大（含 chapterPlan 全章节覆盖），显式放宽输出上限到 8192，避免服务商默认上限把 JSON 截断成非法结构
    const txt = await callAIGuarded('outline', null, {temperature: resolveActiveSpec().outlineTemp, maxTokens: 8192, signal: _abortCtl?.signal});
    const o = extractJsonObject(txt);
    if(!o || !String(o.title||'').trim() || !String(o.logline||'').trim()) throw new Error('未解析到书名/简介');
    // 4.7 Pro（3.2）：校验 chapterPlan 覆盖（数量不符将被程序拒绝）
    const _N = chapterCountVal() || 30;
    const covered = (o.structure && o.structure.chapterPlan)
      ? Object.values(o.structure.chapterPlan).flat().length : 0;
    if(covered !== _N){
      throw new Error(`chapterPlan 覆盖 ${covered} 章，与预设 ${_N} 章不符`);
    }
    // 保留旧章节标题（如果数量一致）
    const oldChapters = (state.outline && state.outline.chapters) || [];
    const newN = state.chapterCount || oldChapters.length;
    if(newN && oldChapters.length === newN){
      o.chapters = oldChapters;
    } else {
      o.chapters = [];
    }
    // 沿用旧词典（4.5 注：在覆盖 state.outline 前读取，否则"沿用旧词典"永远失效）
    const prevGloss = (state.outline && state.outline.glossary && sourceHasGlossary(state.outline.glossary)) ? state.outline.glossary : null;
    snapshotOutline();
    state.outline = o;
    normalizeOutline(state.outline);   // 4.6 Plus：outline 防御归一化（第 1 章调用点：genOutline 赋值后）
    state.outlineConfirmed = false;
    // 简介字数检查
    const _ll = String(o.logline||'').trim().length;
    const _lr = state.loglineRange||{};
    const _lo = Math.min(Number.isFinite(_lr.min)?_lr.min:300, Number.isFinite(_lr.max)?_lr.max:700);
    const _hi = Math.max(Number.isFinite(_lr.min)?_lr.min:300, Number.isFinite(_lr.max)?_lr.max:700);
    if(_ll < _lo || _ll > _hi){ toast(`提示：简介当前 ${_ll} 字，目标 ${_lo}—${_hi} 字，未落在区间内。`); }
    if(prevGloss) o.glossary = prevGloss;
    else if(!o.glossary) o.glossary = {characters:[], places:[], propernouns:[]};
    // 4.9 修复：应用「导入设定」暂存的结构化设定（生成大纲前点击导入设定时暂存于 state.pendingV45），
    // 使导航灯塔/种子人物/种子地点自动落到这份真实大纲上，然后清空待应用槽位。
    if(state.pendingV45){
      applyV45ToOutline(o, state.pendingV45);
      state.pendingV45 = null;
    }
    // 4.10 修复：大纲 AI 已不再输出 navBeacon（确认：大纲需要 anchor/thesis，不需要 navBeacon）。
    // 但 navBeacon 仍被 AIBus/规划师/沙盘等下游消费，这里用优化构想简报 _lastPolishBrief 回填，保住「导航灯塔」上下文；
    // 若已通过「导入设定」带入 navBeacon 或已存在，则不覆盖。
    if(!o.navBeacon && state._lastPolishBrief){
      const _b = state._lastPolishBrief;
      o.navBeacon = {
        genre: String(_b.genre||'').trim(),
        protagonist: String(_b.protagonist||'').trim(),
        coreConflict: String(_b.coreConflict||'').trim(),
        tone: String(_b.style||'').trim()
      };
    }
    o.userIdea = state.idea;
    if(!Array.isArray(o.chapterPlans)) o.chapterPlans = [];
    // 如果 chapters 已重建，同步 state.chapters
    if(o.chapters.length){
      state.chapters = o.chapters.map(c=>({title:c.title, content:'', strip:'', confirmed:false}));
    }
    markAIDone('outline');   // 4.8（6.4）：成功后标记完成
    persist(); render();
    toast('大纲已生成');
  }catch(e){
    if(e.name==='AbortError'){ if(st){ st.className='status'; st.textContent='已停止生成'; } }
    else {
      if(st){ st.className='status err'; st.textContent = e.message; }
      addToFixQueue({kind:'outline', error:e.message});   // 4.8（6.4）：失败进修复队列
      toast('大纲生成失败，已加入修复队列');
    }
  }finally{
    state.aiNetwork.running = (state.aiNetwork.running||[]).filter(k=>k!=='outline');   // 兜底清理运行态
    hideStopBtn(); if(btn) busy(btn,false);
  }
}

// 4.7 Pro（3.2 原码）：若优化构想产出了 brief，将其注入大纲 AI 的【优化构想简报】
function formatNavBeaconForOutline(){
  // 若 4.7 Pro 优化构想生成了 brief，可将其注入大纲 AI
  const b = state._lastPolishBrief;
  if(!b) return '';
  return `题材：${b.genre || ''}\n主角：${b.protagonist || ''}\n核心冲突：${b.coreConflict || ''}\n风格：${b.style || ''}`;
}

// 4.5：大纲输出 schema 校验（title/logline/anchor/thesis/structure.mainLine 完整性）
// 4.7 Pro：OUTLINE_GEN_SYS_PRO 输出 structure.chapterPlan 而非 acts；acts 改为条件式校验——有则查完整性，无则放行（章节覆盖校验在 genOutline 内联）。
function validateOutlineOutput(o){
  if(!o || typeof o !== 'object') return '返回不是对象';
  if(!String(o.title||'').trim()) return '缺少 title';
  if(!String(o.logline||'').trim()) return '缺少 logline';
  if(!String(o.anchor||'').trim()) return '缺少 anchor';
  if(!String(o.thesis||'').trim()) return '缺少 thesis';
  const s = o.structure;
  if(!s || typeof s !== 'object') return '缺少 structure';
  if(!String(s.mainLine||'').trim()) return 'structure 缺少 mainLine';
  // 4.7 Pro 兼容：有 acts 才校验三幕完整性；无 acts（PRO 的 chapterPlan 结构）直接放行
  if(s.acts && typeof s.acts === 'object'){
    const acts = ['act1','act2','act3'];
    for(const a of acts){
      const act = s.acts[a];
      if(!act || typeof act !== 'object') return `acts 缺少 ${a}`;
      if(!Number.isFinite(act.start) || !Number.isFinite(act.end)) return `${a} 的 start/end 不是数字`;
      if(!Array.isArray(act.mustHappen) || act.mustHappen.length < 1) return `${a} 的 mustHappen 至少 1 条`;
    }
  }
  // 人名硬约束：词典初始人名违规即令大纲重试
  if(o.glossary && Array.isArray(o.glossary.characters)){
    for(const c of o.glossary.characters){
      const v = nmNameRuleViolation(String(c&&c.name||'').trim());
      if(v) return '人名规范：'+v;
    }
  }
  return '';
}

// v228/P3：大纲忠实度闸——先过结构校验，再校验是否保留用户构想核心词（复用 v225/P6 的 validateIdeaFaithful；
// ctx 由 AIBus.get('outline') 提供，base 含 idea=state.idea）。返回 ''=通过，非空=不忠实原因，经 validateAIOutput
// 字符串约定归一化后自动走 genOutline 的修复队列重试链，零新增管道。
function validateOutlineFaithful(j, ctx){
  const err = validateOutlineOutput(j);
  if(err) return err;
  return validateIdeaFaithful(j, (ctx && (ctx.idea || ctx.rawIdea)) || '');
}

// v10.18 主线简述生成（4.5 改造：强制分批，每批最多 PLAN_BATCH_SIZE 章，批间携带"已定稿前文骨架"）。
// 每批结果合并到 state.outline.chapterPlans 与 state.outline.chapters；每批都校验数量与 schema。
// 失败保持原值不清空；覆盖由调用方 confirm 把关。
const PLAN_BATCH_SIZE = 25;

/* ============ v1.0.134 规划师五段拆分：阶段定义 / 状态 / 生成函数 ============ */
const PLANNER_STAGES = [
  { id:'summary',    num:'①', label:'主线简述' },
  { id:'titles',     num:'②', label:'章节标题' },
  { id:'beats',      num:'③', label:'节拍表'   },
  { id:'glossary',   num:'④', label:'万物词典' },
  { id:'foreshadow', num:'⑤', label:'伏笔网'   }
];
function stageLabel(id){ const s=PLANNER_STAGES.find(x=>x.id===id); return s ? s.num+s.label : id; }
// 阶段完成判定（v225/P4 重写：以"每一章都有数据"为准；空数组/部分批次完成一律不亮绿灯——修"刷新后假绿灯"）
function plannerStageDone(stage){
  const o = state.outline; if(!o) return false;
  const totalN = (o.chapters||[]).length;
  const plans = Array.isArray(o.chapterPlans) ? o.chapterPlans : [];
  const everyPlan = pred => totalN > 0 && plans.length >= totalN && plans.every(p => p && typeof p==='object' && pred(p));
  switch(stage){
    case 'summary':    return everyPlan(p => String(p.summary||'').trim());
    case 'titles':     return totalN > 0 && (o.chapters||[]).every(c => String(c&&c.title||'').trim());
    case 'beats':      return everyPlan(p => Array.isArray(p.beats) && p.beats.length >= 4);
    case 'glossary':   return sourceHasGlossary((o.glossary)||{});
    case 'foreshadow': return !!(o._foreshadowLedger && Array.isArray(o._foreshadowLedger.planted) && o._foreshadowLedger.planted.length);
  }
  return false;
}
// 就地刷新阶段栏状态（不重建整卡 DOM，避免总控链式运行时打断按钮引用）
function refreshPlannerStageBar(running, failed){
  const bar = $('.cp-stagebar'); if(!bar) return;
  const o = state.outline || {};   // v225/P4：供半程态读取 _plannerProgress
  PLANNER_STAGES.forEach(st=>{
    const b = bar.querySelector(`[data-cp-stage="${st.id}"]`); if(!b) return;
    const dot = b.querySelector('.cp-dot'); if(!dot) return;
    b.classList.remove('done','undone','running','fail','partial');
    if(st.id === running){ b.classList.add('running'); dot.innerHTML = '<span class="spinner"></span>'; b.disabled = true; }
    else { b.disabled = false;
      if(st.id === failed){ b.classList.add('fail'); dot.textContent = '✕'; }
      else if(plannerStageDone(st.id)){ b.classList.add('done'); dot.textContent = '✓'; }
      // v225/P4：半程态——进度持久化显示"进行到 N/M 批"（琥珀色，样式 .cp-dot.partial）
      else if((o._plannerProgress||{})[st.id] && o._plannerProgress[st.id].done > 0 && o._plannerProgress[st.id].done < o._plannerProgress[st.id].total){
        b.classList.add('partial'); dot.textContent = `${o._plannerProgress[st.id].done}/${o._plannerProgress[st.id].total}`;
      }
      else { b.classList.add('undone'); dot.textContent = '·'; }
    }
  });
  const all = bar.querySelector('[data-cp-all]');
  if(all) all.classList.toggle('running', !!running);
}
// v225/P5-A：填完章节数即可进入规划师——无章节数组时按 N 生成占位（空标题），规划师五阶段均可直接跑
function ensureChaptersPlaceholder(){
  const o = state.outline; if(!o) return false;
  const n = Math.floor(Number(chapterCountVal())||0);
  if(n < 1 || n > 200) return false;
  if(!Array.isArray(o.chapters)) o.chapters = [];
  if(o.chapters.length === n) return true;          // 幂等：每次过闸都调也不重复建
  if(o.chapters.length === 0){
    o.chapters = Array.from({length:n}, ()=>({title:'', summary:''}));
    persist(); return true;
  }
  return false;   // 已有内容且数量不符：不动，交给既有覆盖/重生成流程
}
// 规划师上游闸门：只需大纲完成即可（标题由阶段②自行生成，不再强制先跑独立标题步）
function plannerGate(opts){
  if(!isLong() || !state.outline) return false;
  if(!(state.aiNetwork.completed||[]).includes('outline')){ if(!(opts&&opts.silent)) toast('请先完成上游步骤：生成大纲'); return false; }
  if(genBusy()){ if(!(opts&&opts.silent)) toast('已有生成任务进行中，请稍候'); return false; }
  ensureChaptersPlaceholder();   // v225/P5-A：占位章节数组就位，五阶段入口共用此闸
  return true;
}
// 规划师批次上下文拼装（简述/节拍共用）：withPlans=注入本批次既有主线简述（节拍阶段锚点）；withGlossary=注入设定词典
function plannerBatchContext(b, opts){
  opts = opts || {};
  const o = state.outline || {};
  const n = b.end - b.start;
  const batchTitles = (o.chapters||[]).slice(b.start, b.end).map((c,i)=> `第${b.start+i+1}章《${c&&c.title||''}》`).join(' / ');
  const parts = [];
  if(opts.withStyle !== false){ const ws = writeStyleNamesBlock(); if(ws.trim()) parts.push(ws.trim()); }
  const anchor = outlineAnchorBlock(); if(anchor) parts.push(anchor);
  parts.push(`【导航灯塔】\n${JSON.stringify(o.navBeacon||{})}`);   // v228/P6：紧凑 JSON 输入瘦身（提速，语义不变）
  parts.push(`【结构骨架】\n${JSON.stringify(o.structure||{})}`);
  parts.push(`【整体情绪基调】${o.tone || '未指定'}`);
  parts.push(`【本批次】第 ${b.start+1}—${b.end} 章，共 ${n} 章\n${batchTitles}`);
  if(opts.withPlans){
    const plans = (o.chapterPlans||[]).slice(b.start, b.end).map((p,i)=>`第${b.start+i+1}章：${chapterPlanText(p)||'(无简述)'}`).join('\n');
    if(plans.trim()) parts.push(`【本批次主线简述】\n${plans}`);
  }
  const prev = b.start > 0 ? buildPrevSkeleton(b.start) : '';
  if(prev) parts.push(prev);
  if(opts.withGlossary !== false){ const g = chapterGlossaryBlock(); if(g.trim()) parts.push(g.trim()); }
  const ban = banListBlockFor('planner');
  if(ban) parts.push(ban);
  return parts.join('\n\n') + '\n\n' + ORIGINALITY_OUTLINE_SYS;
}
// 简述批次校验（只查 summary）
function validatePlannerSummaryBatch(j){
  if(!j || typeof j !== 'object') return '返回不是对象';
  if(!Array.isArray(j.chapterPlans)) return '缺少 chapterPlans 数组';
  for(const [i,p] of j.chapterPlans.entries()){
    if(!p || typeof p !== 'object') return `第 ${i+1} 个 chapterPlan 不是对象`;
    if(!String(p.summary||'').trim()) return `第 ${i+1} 章缺少 summary`;
  }
  return '';
}
// 节拍批次校验（只查 beats 四段）
function validatePlannerBeatsBatch(j){
  if(!j || typeof j !== 'object') return '返回不是对象';
  if(!Array.isArray(j.chapterPlans)) return '缺少 chapterPlans 数组';
  for(const [i,p] of j.chapterPlans.entries()){
    if(!p || typeof p !== 'object') return `第 ${i+1} 个 chapterPlan 不是对象`;
    if(!Array.isArray(p.beats) || p.beats.length < 4) return `第 ${i+1} 章 beats 不足 4 段`;
    for(const [k,b] of p.beats.entries()){
      if(!['setup','rise','climax','hook'].includes(b.type)) return `第 ${i+1} 章第 ${k+1} 个 beat 类型非法`;
      if(!String(b.event||'').trim()) return `第 ${i+1} 章第 ${k+1} 个 beat 缺少 event`;
    }
  }
  return '';
}
// 规划师流式预览（复用旧 cp-stream-preview 样式）
function plannerPreview(btn, tip){
  if(!currentIsDeepSeek()) return null;
  const cpBody = btn && btn.closest('.cp-card') && btn.closest('.cp-card').querySelector('.cp-body');
  if(!cpBody) return null;
  const preview = document.createElement('pre');
  preview.className = 'cp-stream-preview'; preview.textContent = tip;
  cpBody.insertBefore(preview, cpBody.firstChild);
  return preview;
}
function plannerRunBtn(btn, on){
  if(!btn) return;
  if(on){ btn.classList.add('cp-gen-btn-loading'); busy(btn,true,'生成中…'); }
  else { btn.classList.remove('cp-gen-btn-loading'); busy(btn,false); }
}

// ① 主线简述（分批 ≤25；批间即时写回 o.chapterPlans，供下一批前文骨架衔接）
async function genPlannerSummary(btn, opts){
  opts = opts || {};
  if(!plannerGate(opts)) return false;
  markAIRunning('chapterPlan');
  refreshPlannerStageBar('summary', null);
  let preview = plannerPreview(btn, '正在生成主线简述…'), _streamBuf = '';
  plannerRunBtn(btn, true);
  const o = state.outline;
  const stopParent = btn && btn.closest('.cp-head-top') ? btn.closest('.cp-head-top') : (btn && btn.parentNode);
  if(stopParent) showStopBtn(stopParent);
  try{
    const totalN = (o.chapters||[]).length;
    if(!totalN){ if(!opts.silent) toast('请先生成章节标题'); return false; }
    // 覆盖前归档旧版（旧版存入版本历史，可回退）
    if(Array.isArray(o.chapterPlans) && o.chapterPlans.some(Boolean)) pushChapterPlansSnapshot();
    const batches = [];
    for(let start=0; start<totalN; start+=PLAN_BATCH_SIZE) batches.push({start, end: Math.min(start+PLAN_BATCH_SIZE, totalN)});
    let wrote = 0;
    for(const [bi,b] of batches.entries()){
      const n = b.end - b.start;
      const user = plannerBatchContext(b, {});
      const onStream = delta => { _streamBuf += String(delta||''); if(preview){ preview.textContent = `（批次 ${bi+1}/${batches.length}）\n` + _streamBuf; preview.scrollTop = preview.scrollHeight; } };
      _streamBuf = '';
      const cands = await Promise.all([
        callAIWithContract(callDeepSeek(PLANNER_SUMMARY_SYS, user, {temperature:0.35, topP:0.8, maxTokens:clampMaxTokens('chapterPlan'), onStream, signal:_abortCtl?.signal, taskKey:'planSummary'}), {needJson:true, expectedCount:n, countPath:'chapterPlans', schemaValidator:validatePlannerSummaryBatch, taskName:`主线简述批次 ${bi+1}/${batches.length}-A`}),
      ]);
      const best = pickBestChapterPlan(cands, n);
      if(!best.ok) throw new Error(`批次 ${bi+1} 失败：${best.error || '所有候选均无效'}`);
      // 批间衔接：每批即时写回（保留既有 beats/emotionalArc），下一批 buildPrevSkeleton 立即可读
      if(!Array.isArray(o.chapterPlans)) o.chapterPlans = new Array(totalN).fill(null);
      (best.data.chapterPlans||[]).forEach((p,i)=>{
        const idx = b.start + i;
        const cur = (o.chapterPlans[idx] && typeof o.chapterPlans[idx]==='object') ? o.chapterPlans[idx] : {};
        o.chapterPlans[idx] = Object.assign({}, cur, {
          summary: String(p.summary||'').trim(),
          requiredEntities: Array.isArray(p.requiredEntities)&&p.requiredEntities.length ? p.requiredEntities : (Array.isArray(cur.requiredEntities)?cur.requiredEntities:[])
        });
        if(chapterPlanText(o.chapterPlans[idx])) wrote++;
      });
      o._plannerProgress = o._plannerProgress || {};
      o._plannerProgress.summary = { done: bi+1, total: batches.length, ts: Date.now() };   // v225/P4：批次进度持久化，刷新后可见半程态
      persist();
    }
    if(state.glossAutoFill && sourceHasGlossary(o.glossary)){
      try{
        const texts = (o.chapterPlans||[]).map(chapterPlanText).filter(Boolean);
        if(texts.length){ const ext = await extractNewGlossary(texts); const nm = mergeExtractedGlossary(ext, '规划师'); if(nm.total>0) persist(); }
      }catch(e){}
    }
    render();
    markAIDone('chapterPlan');
    o._plannerProgress = o._plannerProgress || {};
    o._plannerProgress.summary = { done: batches.length, total: batches.length, ts: Date.now() };   // v225/P4：全部批次完成
    refreshPlannerStageBar(null, null);
    if(!opts.silent) toast(`主线简述已生成：${wrote} 章`);
    return true;
  }catch(e){
    if(e.name !== 'AbortError') addToFixQueue({kind:'chapterPlan', error:'主线简述：'+e.message});
    if(!opts.silent) toast(e.name==='AbortError' ? '已停止生成主线简述' : '主线简述生成失败：'+e.message);
    refreshPlannerStageBar(null, 'summary');
    return false;
  }finally{
    state.aiNetwork.running = (state.aiNetwork.running||[]).filter(k=>k!=='chapterPlan');
    hideStopBtn(); if(preview) preview.remove(); plannerRunBtn(btn, false);
  }
}

// ② 章节标题（单批；复用 REGEN_TITLES_SYS，直接定稿应用）
async function genPlannerTitles(btn, opts){
  opts = opts || {};
  if(!plannerGate(opts)) return false;
  markAIRunning('chapterPlan');
  refreshPlannerStageBar('titles', null);
  let preview = plannerPreview(btn, '正在生成章节标题…'), _streamBuf = '';
  plannerRunBtn(btn, true);
  const o = state.outline;
  const stopParent = btn && btn.closest('.cp-head-top') ? btn.closest('.cp-head-top') : (btn && btn.parentNode);
  if(stopParent) showStopBtn(stopParent);
  try{
    const n = (o.chapters||[]).length;
    if(!n){ if(!opts.silent) toast('请先设置章节数并生成大纲'); return false; }
    const user = titlesGenUser({ req:'' });
    const onStream = delta => { _streamBuf += String(delta||''); if(preview){ preview.textContent = _streamBuf; preview.scrollTop = preview.scrollHeight; } };
    const cands = await Promise.all([
      callAIWithContract(callDeepSeek(REGEN_TITLES_SYS, user, {temperature:0.3, topP:0.5, onStream, signal:_abortCtl?.signal, taskKey:'plannerTitles'}), {needJson:true, expectedCount:n, countPath:'titles', taskName:'规划师-标题-A'}),
    ]);
    const best = pickBestTitles(cands, n);
    if(!best.ok) throw new Error(best.error);
    const titles = (best.data.titles||[]).map(t=>String(t||'').trim());
    if(!bindPlannerTitles(titles)) throw new Error('标题数量与章节数不一致，未应用');
    state.plannerFinalized = true;
    persist(); render(); markAIDone('chapterPlan'); refreshPlannerStageBar(null, null);
    if(!opts.silent) toast(`章节标题已定稿：${n} 章`);
    return true;
  }catch(e){
    if(e.name !== 'AbortError') addToFixQueue({kind:'chapterPlan', error:'标题：'+e.message});
    if(!opts.silent) toast(e.name==='AbortError' ? '已停止生成章节标题' : '章节标题生成失败：'+e.message);
    refreshPlannerStageBar(null, 'titles');
    return false;
  }finally{
    state.aiNetwork.running = (state.aiNetwork.running||[]).filter(k=>k!=='chapterPlan');
    hideStopBtn(); if(preview) preview.remove(); plannerRunBtn(btn, false);
  }
}

// ③ 节拍表（分批 ≤25；以既有主线简述为锚，批间即时写回）
async function genPlannerBeats(btn, opts){
  opts = opts || {};
  if(!plannerGate(opts)) return false;
  markAIRunning('chapterPlan');
  refreshPlannerStageBar('beats', null);
  let preview = plannerPreview(btn, '正在生成节拍表…'), _streamBuf = '';
  plannerRunBtn(btn, true);
  const o = state.outline;
  const stopParent = btn && btn.closest('.cp-head-top') ? btn.closest('.cp-head-top') : (btn && btn.parentNode);
  if(stopParent) showStopBtn(stopParent);
  try{
    const totalN = (o.chapters||[]).length;
    if(!totalN){ if(!opts.silent) toast('请先生成章节标题'); return false; }
    const batches = [];
    for(let start=0; start<totalN; start+=PLAN_BATCH_SIZE) batches.push({start, end: Math.min(start+PLAN_BATCH_SIZE, totalN)});
    let wrote = 0;
    for(const [bi,b] of batches.entries()){
      const n = b.end - b.start;
      const user = plannerBatchContext(b, {withPlans:true});
      const onStream = delta => { _streamBuf += String(delta||''); if(preview){ preview.textContent = `（批次 ${bi+1}/${batches.length}）\n` + _streamBuf; preview.scrollTop = preview.scrollHeight; } };
      _streamBuf = '';
      const cands = await Promise.all([
        callAIWithContract(callDeepSeek(PLANNER_BEATS_SYS, user, {temperature:0.35, topP:0.8, maxTokens:clampMaxTokens('chapterPlan'), onStream, signal:_abortCtl?.signal, taskKey:'planBeats'}), {needJson:true, expectedCount:n, countPath:'chapterPlans', schemaValidator:validatePlannerBeatsBatch, taskName:`节拍表批次 ${bi+1}/${batches.length}-A`}),
      ]);
      const best = pickBestChapterPlan(cands, n);
      if(!best.ok) throw new Error(`批次 ${bi+1} 失败：${best.error || '所有候选均无效'}`);
      if(!Array.isArray(o.chapterPlans)) o.chapterPlans = new Array(totalN).fill(null);
      (best.data.chapterPlans||[]).forEach((p,i)=>{
        const idx = b.start + i;
        const cur = (o.chapterPlans[idx] && typeof o.chapterPlans[idx]==='object') ? o.chapterPlans[idx] : {};
        o.chapterPlans[idx] = Object.assign({}, cur, {
          beats: Array.isArray(p.beats) ? p.beats : (Array.isArray(cur.beats)?cur.beats:[]),
          emotionalArc: String(p.emotionalArc||cur.emotionalArc||'').trim(),
          requiredEntities: Array.isArray(p.requiredEntities)&&p.requiredEntities.length ? p.requiredEntities : (Array.isArray(cur.requiredEntities)?cur.requiredEntities:[])
        });
        if(Array.isArray(p.beats) && p.beats.length>=4) wrote++;
      });
      o._plannerProgress = o._plannerProgress || {};
      o._plannerProgress.beats = { done: bi+1, total: batches.length, ts: Date.now() };   // v225/P4：批次进度持久化，刷新后可见半程态
      persist();
    }
    render();
    markAIDone('chapterPlan');
    o._plannerProgress = o._plannerProgress || {};
    o._plannerProgress.beats = { done: batches.length, total: batches.length, ts: Date.now() };   // v225/P4：全部批次完成
    refreshPlannerStageBar(null, null);
    if(!opts.silent) toast(`节拍表已生成：${wrote} 章 · 每章四段`);
    return true;
  }catch(e){
    if(e.name !== 'AbortError') addToFixQueue({kind:'chapterPlan', error:'节拍表：'+e.message});
    if(!opts.silent) toast(e.name==='AbortError' ? '已停止生成节拍表' : '节拍表生成失败：'+e.message);
    refreshPlannerStageBar(null, 'beats');
    return false;
  }finally{
    state.aiNetwork.running = (state.aiNetwork.running||[]).filter(k=>k!=='chapterPlan');
    hideStopBtn(); if(preview) preview.remove(); plannerRunBtn(btn, false);
  }
}

// ④ 万物词典（单批；产出种子合并进权威词典，同名以现有为准）
async function genPlannerGlossary(btn, opts){
  opts = opts || {};
  if(!plannerGate(opts)) return false;
  markAIRunning('chapterPlan');
  refreshPlannerStageBar('glossary', null);
  let preview = plannerPreview(btn, '正在生成万物词典…'), _streamBuf = '';
  plannerRunBtn(btn, true);
  const o = state.outline;
  const stopParent = btn && btn.closest('.cp-head-top') ? btn.closest('.cp-head-top') : (btn && btn.parentNode);
  if(stopParent) showStopBtn(stopParent);
  try{
    const titles = (o.chapters||[]).map((c,i)=>`第${i+1}章《${c&&c.title||''}》`).join(' / ');
    const summaries = (o.chapterPlans||[]).map((p,i)=>`第${i+1}章：${chapterPlanText(p)||'(无简述)'}`).join('\n');
    const parts = [];
    const anchor = outlineAnchorBlock(); if(anchor) parts.push(anchor);
    parts.push(`【小说标题】${o.title||''}\n【小说简介】${o.logline||''}`);
    parts.push(`【结构骨架】${JSON.stringify(o.structure||{}, null, 2)}`);
    parts.push(`【章节标题】${titles||'(无)'}`);
    parts.push(`【主线简述】\n${summaries||'(无简述，建议先生成主线简述)'}`);
    if(sourceHasGlossary((o.glossary)||{})) parts.push(`【现有词典】${JSON.stringify(o.glossary,null,2)}`);
    const user = parts.join('\n\n');
    const onStream = delta => { _streamBuf += String(delta||''); if(preview){ preview.textContent = _streamBuf; preview.scrollTop = preview.scrollHeight; } };
    const res = await callAIWithContract(callDeepSeek(PLANNER_GLOSSARY_SYS, user, {temperature:0.3, topP:0.6, maxTokens:clampMaxTokens('json'), onStream, signal:_abortCtl?.signal, taskKey:'plannerAux'}), {needJson:true, taskName:'规划师-词典'});
    if(!res.ok) throw new Error(res.error);
    const g = res.data && res.data.glossary;
    if(!g || (!Array.isArray(g.characters) && !Array.isArray(g.places) && !Array.isArray(g.propernouns))) throw new Error('词典结构缺失');
    const added = mergeSeedGlossary(g);
    if(added === 0) throw new Error('未提取到新条目（可能全部重复）');
    persist(); render(); markAIDone('chapterPlan'); refreshPlannerStageBar(null, null);
    if(!opts.silent) toast(`万物词典已生成：新增 ${added} 条`);
    return true;
  }catch(e){
    if(e.name !== 'AbortError') addToFixQueue({kind:'chapterPlan', error:'词典：'+e.message});
    if(!opts.silent) toast(e.name==='AbortError' ? '已停止生成万物词典' : '万物词典生成失败：'+e.message);
    refreshPlannerStageBar(null, 'glossary');
    return false;
  }finally{
    state.aiNetwork.running = (state.aiNetwork.running||[]).filter(k=>k!=='chapterPlan');
    hideStopBtn(); if(preview) preview.remove(); plannerRunBtn(btn, false);
  }
}

// ⑤ 伏笔网（单批；读全部主线简述，产出植入章→回收章配对，写入 _foreshadowLedger）
async function genPlannerForeshadow(btn, opts){
  opts = opts || {};
  if(!plannerGate(opts)) return false;
  markAIRunning('chapterPlan');
  refreshPlannerStageBar('foreshadow', null);
  let preview = plannerPreview(btn, '正在生成伏笔网…'), _streamBuf = '';
  plannerRunBtn(btn, true);
  const o = state.outline;
  const stopParent = btn && btn.closest('.cp-head-top') ? btn.closest('.cp-head-top') : (btn && btn.parentNode);
  if(stopParent) showStopBtn(stopParent);
  try{
    const total = (o.chapters||[]).length;
    if(!total){ if(!opts.silent) toast('请先生成章节标题'); return false; }
    const titles = (o.chapters||[]).map((c,i)=>`第${i+1}章《${c&&c.title||''}》`).join(' / ');
    const summaries = (o.chapterPlans||[]).map((p,i)=>`第${i+1}章：${chapterPlanText(p)||'(无简述)'}`).join('\n');
    const parts = [];
    const anchor = outlineAnchorBlock(); if(anchor) parts.push(anchor);
    parts.push(`【小说标题】${o.title||''}\n【小说简介】${o.logline||''}`);
    parts.push(`【章节标题】${titles||'(无)'}`);
    parts.push(`【主线简述】\n${summaries||'(无简述，建议先生成主线简述)'}`);
    parts.push(`【全书章数】${total}`);
    const user = parts.join('\n\n');
    const onStream = delta => { _streamBuf += String(delta||''); if(preview){ preview.textContent = _streamBuf; preview.scrollTop = preview.scrollHeight; } };
    const res = await callAIWithContract(callDeepSeek(PLANNER_FORESHADOW_SYS, user, {temperature:0.3, topP:0.6, maxTokens:clampMaxTokens('json'), onStream, signal:_abortCtl?.signal, taskKey:'plannerAux'}), {needJson:true, taskName:'规划师-伏笔'});
    if(!res.ok) throw new Error(res.error);
    const fs = (res.data && Array.isArray(res.data.foreshadows)) ? res.data.foreshadows : [];
    if(!fs.length) throw new Error('未提取到伏笔条目');
    const ledger = o._foreshadowLedger = o._foreshadowLedger || { planted:[], resolved:[], overdue:[] };
    let cnt = 0;
    fs.forEach(f=>{
      const text = String(f && f.text || '').trim(); if(!text) return;
      if(ledger.planted.some(x=>x.text===text)) return;
      const plant = Math.max(0, Math.min(total-1, Math.round(Number(f.plantChapter)||1)-1));
      const pay = Math.max(plant+1, Math.min(total, Math.round(Number(f.payoffChapter)||(plant+1))));
      ledger.planted.push({ id:'pf_'+Date.now()+'_'+Math.random().toString(36).slice(2,7), text, chPlanted:plant, expectedCh:pay, type:String(f.type||'事件') });
      cnt++;
    });
    if(!cnt) throw new Error('伏笔条目均重复或无效');
    ledger.overdue = ledger.planted.filter(x=>0>=x.expectedCh && !ledger.resolved.some(r=>r.id===x.id));
    persist(); render(); markAIDone('chapterPlan'); refreshPlannerStageBar(null, null);
    if(!opts.silent) toast(`伏笔网已生成：${cnt} 条（植入章→回收章）`);
    return true;
  }catch(e){
    if(e.name !== 'AbortError') addToFixQueue({kind:'chapterPlan', error:'伏笔：'+e.message});
    if(!opts.silent) toast(e.name==='AbortError' ? '已停止生成伏笔网' : '伏笔网生成失败：'+e.message);
    refreshPlannerStageBar(null, 'foreshadow');
    return false;
  }finally{
    state.aiNetwork.running = (state.aiNetwork.running||[]).filter(k=>k!=='chapterPlan');
    hideStopBtn(); if(preview) preview.remove(); plannerRunBtn(btn, false);
  }
}

const PLANNER_GEN = {
  summary: genPlannerSummary,
  titles: genPlannerTitles,
  beats: genPlannerBeats,
  glossary: genPlannerGlossary,
  foreshadow: genPlannerForeshadow
};
// 单阶段入口：独立重跑某个规划师阶段（只跑失败的那一步，不重跑前面已成功的）
async function genPlannerStage(btn, stage){
  const fn = PLANNER_GEN[stage]; if(!fn) return false;
  return await fn(btn, {});
}
// 总控：按顺序一键执行 5 阶段；单步失败即停（其余保持原状态，可单独补跑该步）
async function genPlannerAll(btn){
  const o = state.outline; if(!isLong() || !o) return;
  const has = Array.isArray(o.chapterPlans) && o.chapterPlans.some(Boolean);
  if(has && !confirm('一键将按顺序生成：①主线简述→②章节标题→③节拍表→④万物词典→⑤伏笔网，会覆盖现有规划内容（旧版存入历史），继续？')) return;
  if(btn) busy(btn, true, '五步生成中…');
  for(const st of PLANNER_STAGES.map(s=>s.id)){
    refreshPlannerStageBar(st, null);
    const ok = await PLANNER_GEN[st](null, {silent:true});
    if(!ok){ if(btn) busy(btn, false); toast('一键生成中断于「'+stageLabel(st)+'」，可单独点击该步骤按钮重试'); return; }
    refreshPlannerStageBar(null, null);
  }
  if(btn) busy(btn, false);
  toast('规划师五步全部完成');
}

// 4.5：前文骨架（供规划师批间衔接）：全部前序标题 + 最近 3 章简述
function buildPrevSkeleton(endIdx){
  const o = state.outline;
  // v225/P5-D：空标题兜底，规划师批间上下文不渲染"《》"
  const titles = (o.chapters||[]).slice(0, endIdx).map((c,i)=>{ const t=String((c&&c.title)||'').trim(); return `第${i+1}章${t?`《${t}》`:'（标题未定）'}`; }).join(' / ');
  const plans = (o.chapterPlans||[]).slice(0, endIdx);
  const lastFew = plans.slice(-3).map((p,i)=> {
    const idx = endIdx - 3 + i;
    return `第${idx+1}章：${chapterPlanText(p)||'(无)'}`;
  }).join('\n');
  return `【已定稿的前文骨架】\n全部前序标题：${titles}\n最近 3 章简述：\n${lastFew}`;
}

// 4.5：规划师批次输出 schema 校验（titles/chapterPlans 结构、beats 四段完整性）
function validateBatchPlanOutput(j){
  if(!j || typeof j !== 'object') return '返回不是对象';
  if(!Array.isArray(j.titles)) return '缺少 titles 数组';
  if(!Array.isArray(j.chapterPlans)) return '缺少 chapterPlans 数组';
  for(const [i, p] of j.chapterPlans.entries()){
    if(!p || typeof p !== 'object') return `第 ${i+1} 个 chapterPlan 不是对象`;
    if(!String(p.summary||'').trim()) return `第 ${i+1} 个 chapterPlan 缺少 summary`;
    if(!Array.isArray(p.beats) || p.beats.length < 4) return `第 ${i+1} 个 chapterPlan 的 beats 不足 4 段`;
    for(const [k, b] of p.beats.entries()){
      if(!['setup','rise','climax','hook'].includes(b.type)) return `第 ${i+1} 章第 ${k+1} 个 beat 类型非法`;
      if(!String(b.event||'').trim()) return `第 ${i+1} 章第 ${k+1} 个 beat 缺少 event`;
      if(!Array.isArray(b.requiredEntities)) return `第 ${i+1} 章第 ${k+1} 个 beat 缺少 requiredEntities`;
    }
  }
  // 人名硬约束：规划师播种的词典人名违规即令整批重试
  if(Array.isArray(j.glossary && j.glossary.characters)){
    for(const c of j.glossary.characters){
      const v = nmNameRuleViolation(String(c&&c.name||'').trim());
      if(v) return '人名规范：'+v;
    }
  }
  return '';
}

// 4.8 旗舰版（板块三-5）：多分支情节沙盘推演。返回 {branches} 并已写入 state._branchSandboxes。
async function sandboxBranch(choicePointIdx, options){
  const o = state.outline; if(!o) return null;
  const cp = choicePointIdx + 1;
  const parts = [];
  parts.push(outlineAnchorBlock());
  parts.push(`【导航灯塔】\n${JSON.stringify(o.navBeacon||{}, null, 2)}`);
  parts.push(`【结构骨架】\n${JSON.stringify(o.structure||{}, null, 2)}`);
  parts.push(`【分歧点】第 ${cp} 章《${(o.chapters[choicePointIdx]&&o.chapters[choicePointIdx].title)||''}》`);
  const prevPlans = (o.chapterPlans||[]).slice(Math.max(0, choicePointIdx-2), choicePointIdx).map((p,i)=>`第 ${Math.max(0, choicePointIdx-2)+i+1} 章：${chapterPlanText(p)}`).join('\n');
  if(prevPlans) parts.push(`【前文简述】\n${prevPlans}`);
  const nextTitles = (o.chapters||[]).slice(choicePointIdx+1, choicePointIdx+4).map((c,i)=>`第 ${choicePointIdx+i+2} 章《${c&&c.title||''}》`).join(' / ');
  if(nextTitles) parts.push(`【后续标题约束】${nextTitles}`);
  parts.push(`【分支选项】\n${(options||[]).map((opt,idx)=>`${idx+1}. ${opt}`).join('\n')}`);
  const user = parts.join('\n\n');
  const txt = unwrapAIResult(await callDeepSeek(SANDBOX_BRANCH_SYS, user, {maxTokens: clampMaxTokens('json'), temperature: 0.4, topP: 0.85, taskKey:'sandbox'}));
  const j = parseJson(txt) || {};
  const branches = (Array.isArray(j.branches)?j.branches:[]).map((b,idx)=>({
    id: String(b.id || `opt${idx+1}`),
    summary: String(b.summary||'').trim(),
    risks: (Array.isArray(b.risks)?b.risks:[]).map(String),
    payoffs: (Array.isArray(b.payoffs)?b.payoffs:[]).map(String),
    consistency: Math.max(0, Math.min(10, Math.round(Number(b.consistency)||0)))
  })).filter(b => b.summary);
  branches.sort((a,b) => b.consistency - a.consistency);
  state._branchSandboxes = state._branchSandboxes || [];
  state._branchSandboxes.push({ point: choicePointIdx, branches, chosen: null });
  // 自动把 risks 注册为伏笔（预计 3-4 章后兑现）
  const ledger = o._foreshadowLedger = o._foreshadowLedger || { planted:[], resolved:[], overdue:[] };
  branches.forEach(b => {
    b.risks.forEach(r => {
      const text = String(r).trim(); if(!text) return;
      if(!ledger.planted.some(p => p.text === text)){
        ledger.planted.push({
          id: 'sb_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
          text,
          chPlanted: choicePointIdx,
          expectedCh: Math.min((o.chapters||[]).length, choicePointIdx + 4)
        });
      }
    });
  });
  persist();
  return { branches };
}

// 4.8 旗舰版（板块二-5）：规划师批次多候选择优。评分维度：schema 通过、beats 完整性、summary 非空率。
function pickBestChapterPlan(cands, expectedN){
  const valid = cands.filter(c => c && c.ok && c.data && Array.isArray(c.data.chapterPlans));
  if(!valid.length) return cands.find(c => c && !c.ok) || {ok:false, error:'所有规划师候选均失败'};
  const score = (res) => {
    const j = res.data;
    const plans = (j.chapterPlans || []);
    let s = 0;
    // 数量与格式
    if(Array.isArray(j.titles) && j.titles.length === expectedN) s += 10;
    if(plans.length === expectedN) s += 10;
    // 每章 beats 四段完整
    plans.forEach(p => {
      if(p && String(p.summary||'').trim()) s += 2;
      if(p && Array.isArray(p.beats) && p.beats.length >= 4){
        s += 4;
        const types = p.beats.map(b => b.type);
        if(['setup','rise','climax','hook'].every(t => types.includes(t))) s += 4;
      }
    });
    return s;
  };
  valid.sort((a,b) => score(b) - score(a));
  return valid[0];
}

// 4.7 Pro（3.4 原码）：规划师统一 user 拼装（注入 structure / tone / navBeacon / 标题参考稿 / 词典 / 风格）
function chapterPlanUser(){
  const o = state.outline || {};
  const parts = [];
  const anchor = outlineAnchorBlock();
  parts.push(anchor ? `${anchor}\n【小说标题】${o.title||''}\n【小说简介】${o.logline||''}` : `【小说标题】${o.title||''}\n【小说简介】${o.logline||''}`);
  parts.push(`【原始构想】${o.userIdea||state.idea||''}`);
  parts.push(`【整体情绪基调】${o.tone || '未指定'}`);
  parts.push(`【结构骨架】${JSON.stringify(o.structure || {})}`);
  parts.push(`【章节标题参考稿】${(o.chapters||[]).map((c,i)=>`第${i+1}章 ${cleanChapterTitle(c&&c.title)}`).join('\n')}`);
  parts.push(`【设定词典】${chapterGlossaryBlock()}`);
  const styleNote = chapterStyleNote();
  if(styleNote) parts.push(styleNote);
  return parts.join('\n\n');
}

// 4.7 Pro（3.4 原码）：规划师解析后整体校验（titles/chapterPlans 数量一致、summary 存在、beats 恰好 4 段且 type 顺序固定）
function validateChapterPlanOutput(j){
  const o = state.outline || {};
  const N = (o.chapters||[]).length;
  if(!j) return {ok:false, code:'JSON_EMPTY'};
  if(!Array.isArray(j.titles)) return {ok:false, code:'TITLES_MISSING'};
  if(!Array.isArray(j.chapterPlans)) return {ok:false, code:'PLANS_MISSING'};
  if(j.titles.length !== N || j.chapterPlans.length !== N) return {ok:false, code:'COUNT_MISMATCH'};
  for(let i=0;i<N;i++){
    const p = j.chapterPlans[i];
    if(!p || typeof p.summary !== 'string') return {ok:false, code:'SUMMARY_MISSING', idx:i};
    if(!Array.isArray(p.beats) || p.beats.length !== 4) return {ok:false, code:'BEATS_COUNT', idx:i};
    const types = ['setup','rise','climax','hook'];
    for(let k=0;k<4;k++){
      if(p.beats[k].type !== types[k]) return {ok:false, code:'BEAT_TYPE', idx:i, beat:k};
      if(typeof p.beats[k].event !== 'string' || p.beats[k].event.length < 3) return {ok:false, code:'BEAT_EVENT', idx:i, beat:k};
    }
  }
  return {ok:true};
}

// 4.5：主线简述统一取文本（兼容 4.5 对象形态 {summary,beats,...} 与旧字符串形态，老数据无损）
function chapterPlanText(p){
  if(p && typeof p === 'object') return String(p.summary||'').trim();
  return String(p||'').trim();
}

/* ---------- P1-1v3 主线简述批量版本（整批快照 ≤5 份，应用后生效） ---------- */
function chapterPlansHistory(){ const o=state.outline; return (o && Array.isArray(o.chapterPlansHistory)) ? o.chapterPlansHistory : []; }
function hasChapterPlansHistory(){ return chapterPlansHistory().length > 0; }
function chapterPlansHistoryCount(){ return chapterPlansHistory().length; }
// 把「当前全部主线简述」整批压入版本栈（最新在前、去重、上限50）；空则不记
function pushChapterPlansSnapshot(){
  const o = state.outline;
  if(!Array.isArray(o.chapterPlans) || !o.chapterPlans.some(Boolean)) return;
  if(!Array.isArray(o.chapterPlansHistory)) o.chapterPlansHistory = [];
  const snap = o.chapterPlans.slice();
  if(o.chapterPlansHistory.length && JSON.stringify(o.chapterPlansHistory[0].plans) === JSON.stringify(snap)) return;
  o.chapterPlansHistory.unshift({ plans: snap, ts: Date.now() });
  if(o.chapterPlansHistory.length > 50) o.chapterPlansHistory.length = 50;
}
// 整批应用某版：先把当前态归档（保留再回退机会），再覆盖全部主线简述
function applyChapterPlansVersion(idx){
  const o = state.outline; const hist = chapterPlansHistory(); const h = hist[idx]; if(!h) return;
  if(!window.confirm(`整批应用「${idx+1}. 主线简述」版本（共 ${(h.plans||[]).filter(Boolean).length} 条）？将覆盖当前主线简述。`)) return;
  pushChapterPlansSnapshot();
  o.chapterPlans = (h.plans||[]).slice();
  persist(); closeChapterPlansHistoryPanel(); render();
  toast('已整批应用该版主线简述');
}
function deleteChapterPlansVersion(idx){
  const o = state.outline; const hist = chapterPlansHistory(); if(!hist.length) return;
  hist.splice(idx,1);
  if(!hist.length) delete o.chapterPlansHistory; else o.chapterPlansHistory = hist;
  persist(); closeChapterPlansHistoryPanel(); openChapterPlansHistoryPanel();
  toast('已删除该版本');
}
function openChapterPlansHistoryPanel(){
  closeChapterPlansHistoryPanel();
  const hist = chapterPlansHistory(); if(!hist.length){ toast('暂无历史版本'); return; }
  const o = state.outline;
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const rows = hist.map((h,idx)=>{
    const n = (h.plans||[]).filter(Boolean).length;
    const first = (h.plans||[]).slice(0,2).filter(Boolean).join(' / ');
    return `<div class="cv-row">
      <div class="cv-meta" style="flex:1;min-width:0"><div class="cv-time">${idx+1}. ${fmtTs(h.ts)} · ${n} 条</div><div class="cv-t" style="font-size:12px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(first||'')}</div></div>
      <div class="cv-actions" style="display:flex;gap:6px;flex-shrink:0">
        <button type="button" class="btn ghost cv-b" data-cph-prev="${idx}">👁 预览</button>
        <button type="button" class="btn primary cv-b" data-cph-apply="${idx}">应用</button>
        <button type="button" class="btn ghost cv-b" data-cph-del="${idx}">🗑</button>
      </div>
    </div>`;
  }).join('');
  const ov = document.createElement('div'); ov.id='cphPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🧭 主线简述 · 批量版本（${hist.length}/50）</b>
        <button class="gs-x" data-cph-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-row cur"><div class="cv-meta"><span class="cv-time">当前版本</span><span class="cv-wc">${(Array.isArray(o.chapterPlans)?o.chapterPlans:[]).filter(Boolean).length} 条</span></div></div>
        <div class="cv-div">「生成/重生成主线简述」会把改动前后的整批各归档一份（≤5 份可回退）；可👁预览切换，点「应用」整批生效——只有应用后才覆盖当前梗概。</div>
        ${rows}
        <div class="cv-preview hidden" id="cphPreview">
          <div class="cv-prev-head"><b id="cphPrevTitle">版本预览</b><button class="gs-x" data-cph-prev-close>✕</button></div>
          <div class="cv-pre" id="cphReader"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-cph-close]').onclick = closeChapterPlansHistoryPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeChapterPlansHistoryPanel(); });
  ov.addEventListener('click', e=>{
    const p = e.target.closest('[data-cph-prev]'); if(!p) return;
    const h = hist[+p.dataset.cphPrev]; if(!h) return;
    const pr=$('#cphPreview'), rd=$('#cphReader'), pt=$('#cphPrevTitle');
    if(pr && rd){ pt.textContent = '预览 · '+fmtTs(h.ts); rd.textContent = (h.plans||[]).map((t,i)=>`第${i+1}章 ${t||''}`).join('\n'); pr.classList.remove('hidden'); }
  });
  ov.querySelector('[data-cph-prev-close]').onclick = ()=>{ const pr=$('#cphPreview'); if(pr) pr.classList.add('hidden'); };
  ov.querySelectorAll('[data-cph-apply]').forEach(b=> b.onclick = ()=> applyChapterPlansVersion(+b.dataset.cphApply));
  ov.querySelectorAll('[data-cph-del]').forEach(b=> b.onclick = ()=> deleteChapterPlansVersion(+b.dataset.cphDel));
}
function closeChapterPlansHistoryPanel(){ const p=$('#cphPanel'); if(p) p.remove(); }

/* ---------- P1-1v4 手动提取 AI 原始响应（自动更新失败时手工救急） ---------- */
// 打开原始响应面板
function openCpRawPanel(){
  closeCpRawPanel();
  const o = state.outline;
  let raw = state._lastCpRaw || '';
  if(!raw && aiLog.length){
    const match = [...aiLog].reverse().find(r => r.task && r.task.includes('主线简述'));
    if(match && match.respLen > 0){ raw = match.resp || ''; }
  }
  const hasRaw = !!raw;
  const escRaw = esc(raw);
  const ov = document.createElement('div'); ov.id='cpRawPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal" style="max-width:780px">
      <div class="gs-modal-head"><b>🔧 原始 AI 响应 — 主线简述</b>
        <span style="display:flex;gap:6px">
          <button class="btn small ghost" data-cpraw-searchlog>📋 搜索最近日志</button>
          <button class="btn small ghost" data-cpraw-import>📂 导入 JSON</button>
          <button class="btn small ghost" data-cpraw-export ${hasRaw?'':'disabled'}>💾 导出 JSON</button>
          <button class="btn small ghost" data-cpraw-copy ${hasRaw?'':'disabled'}>📋 复制全部</button>
          <input type="file" id="cprawImportFile" accept=".json,application/json" hidden />
          <button class="gs-x" data-cpraw-close>✕</button>
        </span></div>
      <div class="cv-body">
        <div class="cv-div">这里是最近一次生成梗概时 AI 返回的原始 JSON 响应。如果自动更新失败，可手动点击下方按钮来提取数据。</div>
        <div class="cpraw-actions">
          <button type="button" class="btn primary" data-cpraw-apply ${hasRaw?'':'disabled'}>解析并应用到梗概</button>
          <span style="font-size:12px;color:var(--sub);align-self:center">${hasRaw?`共 ${raw.length} 字`:'（暂无原始响应数据）'}</span>
        </div>
        <div class="cpraw-tools" style="display:${hasRaw?'flex':'none'};flex-direction:column;gap:6px;border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:var(--panel2);margin:6px 0">
          <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--sub)">
            <span>🔍 替换</span>
            <span style="font-weight:400;font-size:11px;color:var(--dim)">在下方内容中查找并替换，替换结果立即生效，点击「解析并应用到梗概」即可写入</span>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <input type="text" class="cpraw-inp" id="cprawFind" placeholder="查找..." style="flex:1;min-width:80px">
            <input type="text" class="cpraw-inp" id="cprawReplace" placeholder="替换为..." style="flex:1;min-width:80px">
            <button type="button" class="btn small" data-cpraw-replaceall>🔄 替换全部</button>
          </div>
        </div>
        <pre class="cpraw-pre">${hasRaw?escRaw:'(暂无原始响应数据。生成一次主线简述后，原始响应会自动保存至此。)'}</pre>
        <p class="muted" style="margin:6px 0 0;font-size:11px">💡 提示：导入 JSON 文件后自动解析并应用；替换后点「解析并应用到梗概」写入；导入的梗概会自动进入历史版本。</p>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-cpraw-close]').onclick = closeCpRawPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeCpRawPanel(); });
  // ★ 改为从 pre 元素读取最新内容（替换/导入后的内容）
  ov.querySelector('[data-cpraw-apply]').onclick = ()=>{
    const pre = ov.querySelector('.cpraw-pre');
    applyCpRawResponse(pre ? pre.textContent : raw);
  };
  ov.querySelector('[data-cpraw-searchlog]').onclick = ()=>{
    closeCpRawPanel(); openAiLogPanel();
    setTimeout(()=>{
      const rows = $$('[data-ailog-toggle]');
      if(rows.length){
        for(let i=rows.length-1; i>=0; i--){
          const taskEl = rows[i].closest('.ailog-row') && rows[i].closest('.ailog-row').querySelector('.ailog-task');
          if(taskEl && taskEl.textContent.includes('主线简述')){ rows[i].click(); break; }
        }
      }
    }, 300);
  };
  // 导入 JSON：点击按钮 → 触发隐藏 file input → 读取后自动调用 applyCpRawResponse
  const importBtn = ov.querySelector('[data-cpraw-import]');
  const importFile = ov.querySelector('#cprawImportFile');
  if(importBtn && importFile){
    importBtn.onclick = ()=> importFile.click();
    importFile.onchange = (e)=>{
      const f = e.target.files && e.target.files[0];
      if(f){
        const r = new FileReader();
        r.onload = ()=>{
          applyCpRawResponse(r.result);
          importFile.value = '';
        };
        r.readAsText(f);
      }
    };
  }
  // 导出 JSON：导出当前 pre 元素内容为 .json 文件
  ov.querySelector('[data-cpraw-export]').onclick = ()=>{
    const txt = ov.querySelector('.cpraw-pre').textContent;
    const blob = new Blob([txt], {type:'text/plain;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = '主线简述原始响应.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href); toast('✅ 已导出');
  };
  // 复制全部
  const copyBtn = ov.querySelector('[data-cpraw-copy]');
  if(copyBtn) copyBtn.onclick = ()=>{
    navigator.clipboard.writeText(ov.querySelector('.cpraw-pre').textContent)
      .then(()=> toast('✅ 已复制原始响应')).catch(()=> toast('❌ 复制失败'));
  };
  // 替换全部：替换后立即在 pre 中生效
  ov.querySelector('[data-cpraw-replaceall]').onclick = ()=>{
    const find = ov.querySelector('#cprawFind').value;
    const repl = ov.querySelector('#cprawReplace').value;
    if(!find) { toast('请输入查找内容'); return; }
    const pre = ov.querySelector('.cpraw-pre');
    const before = pre.textContent;
    const after = before.replaceAll(find, repl);
    if(before === after) { toast('未找到匹配内容'); return; }
    pre.textContent = after;
    toast('✅ 已替换 ' + (before.split(find).length - 1) + ' 处');
  };
}
function closeCpRawPanel(){ const p=$('#cpRawPanel'); if(p) p.remove(); }
// 手动解析原始响应并应用到主线简述
function applyCpRawResponse(raw){
  if(!raw){ toast('无原始响应数据'); return; }
  const o = state.outline;
  if(!o){ toast('无当前项目'); return; }
  try{
    const j = parseJson(raw) || {};
    const arr = Array.isArray(j.chapterPlans) ? j.chapterPlans.map(x=>String(x||'').trim()) : [];
    if(!arr.length || !arr.some(Boolean)){ toast('解析失败：未找到 chapterPlans 数组'); return; }
    const n = (o.chapters||[]).length;
    const plans = Array.from({length:n},(_,i)=> arr[i] || '');
    // 覆盖前先归档
    pushChapterPlansSnapshot();
    o.chapterPlans = plans;
    persist();
    closeCpRawPanel();
    // 就地更新 UI
    const cpList = document.querySelector('.cp-card .cp-list');
    if(cpList){
      const items = plans.map((t,i)=>`
        <div class="cp-item">
          <span class="cp-no">${i+1}</span>
          <textarea class="cp-input" rows="3" data-cp-set="${i}" data-orig="${esc(t)}" placeholder="本章主线简述（可编辑）">${esc(t)}</textarea>
          <span class="cp-wc">${t.length}字</span>
        </div>`).join('');
      cpList.innerHTML = items;
      // 重新绑定失焦存 + 字数统计
      $$('.cp-input').forEach(inp=>{
        inp.oninput = ()=>{
          const wc = inp.parentNode && inp.parentNode.querySelector('.cp-wc');
          if(wc) wc.textContent = inp.value.length + '字';
        };
        inp.onchange = ()=>{
          const o = state.outline; if(!o) return;
          if(!Array.isArray(o.chapterPlans)) o.chapterPlans = [];
          const i = +inp.dataset.cpSet;
          if(inp.value === inp.dataset.orig) return;
          const _curP = o.chapterPlans[i];
          if(_curP && typeof _curP==='object'){ _curP.summary = inp.value; } else { o.chapterPlans[i] = inp.value; }
          inp.dataset.orig = inp.value;
          persist();
        };
      });
    }
    // 刷新版本按钮
    const actionRow = document.querySelector('.cp-card .action-row');
    if(actionRow){
      const histBtn = actionRow.querySelector('[data-cp-hist]');
      if(histBtn) histBtn.innerHTML = '📚 版本('+chapterPlansHistoryCount()+')';
    }
    bindChapterPlanFold();
    toast('✅ 已手动解析并应用 '+plans.filter(Boolean).length+' 条主线简述');
  }catch(e){
    toast('解析失败：'+e.message+'。请检查原始数据格式');
  }
}

/* ---------- P1-1v4 标题原始响应手动提取 ---------- */
function openTitlesRawPanel(){
  closeTitlesRawPanel();
  let raw = state._lastTitlesRaw || '';
  const hasRaw = !!raw;
  const escRaw = esc(raw);
  const ov = document.createElement('div'); ov.id='titlesRawPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal" style="max-width:780px">
      <div class="gs-modal-head"><b>🔧 原始 AI 响应 — 重生成全部标题</b>
        <span style="display:flex;gap:6px">
          <button class="btn small ghost" data-traw-searchlog>📋 搜索最近日志</button>
          <button class="gs-x" data-traw-close>✕</button>
        </span></div>
      <div class="cv-body">
        <div class="cv-div">这里是最近一次「重生成全部标题」时 AI 返回的原始 JSON 响应。如果自动更新失败，可手动点击「解析并应用到标题」来提取数据。</div>
        <div class="cpraw-actions">
          <button type="button" class="btn primary" data-traw-apply ${hasRaw?'':'disabled'}>解析并应用到标题</button>
          <span style="font-size:12px;color:var(--sub);align-self:center">${hasRaw?`共 ${raw.length} 字`:'（暂无原始响应数据）'}</span>
        </div>
        <pre class="cpraw-pre">${hasRaw?escRaw:'(暂无原始响应数据。执行一次「重生成全部标题」后，原始响应会自动保存至此。)'}</pre>
        <p class="muted" style="margin:6px 0 0;font-size:11px">💡 提示：也可点击「搜索最近日志」从 AI 请求日志中查找最近一次标题重生成响应。</p>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-traw-close]').onclick = closeTitlesRawPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeTitlesRawPanel(); });
  ov.querySelector('[data-traw-apply]').onclick = ()=> applyTitlesRawResponse(raw);
  ov.querySelector('[data-traw-searchlog]').onclick = ()=>{
    closeTitlesRawPanel(); openAiLogPanel();
    setTimeout(()=>{
      const rows = $$('[data-ailog-toggle]');
      if(rows.length){
        for(let i=rows.length-1; i>=0; i--){
          const row = rows[i]; const taskEl = row.closest('.ailog-row') && row.closest('.ailog-row').querySelector('.ailog-task');
          if(taskEl && taskEl.textContent.includes('重生成全部标题')){ row.click(); break; }
        }
      }
    }, 300);
  };
}
function closeTitlesRawPanel(){ const p=$('#titlesRawPanel'); if(p) p.remove(); }
function applyTitlesRawResponse(raw){
  if(!raw){ toast('无原始响应数据'); return; }
  const o = state.outline;
  if(!o){ toast('无当前项目'); return; }
  try{
    const j = parseJson(raw) || {};
    const titles = Array.isArray(j.titles) ? j.titles.map(t=>String(t||'').trim()).filter(Boolean) : [];
    if(!titles.length){ toast('解析失败：未找到 titles 数组'); return; }
    snapshotTitleBatch('手动提取前');
    const cnt = setAllTitles(titles);
    snapshotTitleBatch('本次提取结果');   // v10.34 记录手动提取的结果版本
    persist();
    closeTitlesRawPanel();
    // 就地更新标题行
    document.querySelectorAll('.ct-row').forEach((row,i)=>{
      const el = row.querySelector('.ct-title');
      if(el && o.chapters[i] && o.chapters[i].title){ el.textContent = o.chapters[i].title; el.title = o.chapters[i].title; }
    });
    // 刷新标题版本按钮
    const ctRow2 = document.querySelector('.ct-block .ct-row2');
    if(ctRow2){
      const batchBtn = ctRow2.querySelector('[data-ct-batch]');
      if(batchBtn) batchBtn.innerHTML = '版本('+chTitleBatches().length+'/50)';
    }
    toast('✅ 已手动解析并应用 '+cnt+' 个章节标题');
  }catch(e){ toast('解析失败：'+e.message+'。请检查原始数据格式'); }
}

/* ---------- v1.0.115 单章速读梗概（成文后回顾 · 本章正文压缩至约 1/3）生成 · 面板 ---------- */
function closeChapterSummaryPanel(){ const p=document.getElementById('chSumPanel'); if(p) p.remove(); }

// 密度自检：正文中实际出现的词典实体（人物/地名/专名）为「必保」名单；主线简述作为「应覆盖」锚点（其专名即词典同名）。
// 梗概若漏掉其中任何一个 → 返回缺失实体，提示重生成，把「不丢信息」变成可验证项。
function densityCheck(body, summary, o, i){
  const g = (o && o.glossary) || {};
  const seed = [];
  (g.characters||[]).forEach(x=>{ if(x&&x.name) seed.push({n:''+x.name,t:'人物'}); });
  (g.places||[]).forEach(x=>{ if(x&&x.name) seed.push({n:''+x.name,t:'地名'}); });
  (g.propernouns||[]).forEach(x=>{ if(x&&x.name) seed.push({n:''+x.name,t:'专名'}); });
  const plan = (o && Array.isArray(o.chapterPlans) && o.chapterPlans[i]) ? chapterPlanText(o.chapterPlans[i]) : '';
  const miss = [], seen = new Set();
  seed.forEach(it=>{
    const nm = it.n.trim(); if(!nm || seen.has(nm)) return; seen.add(nm);
    const inBody = body.indexOf(nm)>=0, inAnchor = plan?plan.indexOf(nm)>=0:false;
    if((inBody || inAnchor) && summary.indexOf(nm)<0) miss.push(it);
  });
  return miss;
}

function renderChapterSummaryBody(i, miss){
  const c = state.chapters[i]; if(!c) return;
  const has = c.strip && String(c.strip).trim();
  const box = document.getElementById('chSumBody'); if(!box) return;
  const missHtml = (Array.isArray(miss) && miss.length)
    ? `<p class="strip-warn">⚠️ 密度自检：本段未覆盖「${miss.slice(0,4).map(m=>m.t+'：'+m.n).join('、')}」${miss.length>4?` 等 ${miss.length} 项`:''}，建议<b>重新生成</b>；若持续报警，可将「本章梗概」温度下调到 0.7–0.9 提升忠实度。</p>` : '';
  box.innerHTML = has
    ? `<article class="strip-read"><h3>🏮 速读 · 本章梗概</h3>${esc(String(c.strip).trim())}</article>
       ${missHtml}
       <p class="hint" style="margin:6px 0 0">已生成（把本章正文压缩到约 1/3 的省时读物，只读它也能抓住本章精华不丢信息）。速读偏低保真，可下调「本章梗概」温度至 0.7–0.9 提升忠实度。</p>`
    : `<article class="strip-read"><h3>🏮 速读 · 本章梗概</h3>
        <p class="muted" style="text-indent:0">暂无本章梗概。它是把<b>本章正文压缩到约 1/3</b>的省时读物：没耐心读完全文时，读它即可抓住本章精华、不丢失关键信息。基于本章真实正文生成（&lt;900 字的极短章不作压缩，直接呈现全文）。</p></article>`;
  const g = document.getElementById('chSumGen'); if(g) g.innerHTML = has ? '🔄 重新生成本章梗概' : '✨ 生成本章梗概';
  const c2 = document.getElementById('chSumCopy'); if(c2) c2.style.display = has ? '' : 'none';
}

async function chSumGenerate(i, genBtn){
  const c = state.chapters[i]; if(!c) return;
  const o = state.outline || {};
  const body = String(c.content||'').trim();
  if(!body){ toast('本章尚无正文，请先生成正文再生成本章梗概'); return; }
  const L = body.length;
  // 极短章（<900 字）：不压缩，直接采用全文作速读梗概
  if(L < 900){
    c.strip = body;
    if(o.chapters && o.chapters[i]) o.chapters[i].strip = body;
    persist();
    renderChapterSummaryBody(i);
    toast('本章为极短章，已直接采用全文作速读梗概');
    return;
  }
  if(genBtn){ genBtn.disabled = true; busy(genBtn,true,'生成中…'); }
  const title = c.title || ((o.chapters&&o.chapters[i]&&o.chapters[i].title)) || ('第'+(i+1)+'章');
  const plan = (o && Array.isArray(o.chapterPlans) && o.chapterPlans[i]) ? chapterPlanText(o.chapterPlans[i]).trim() : '';
  // 动态字数：目标 = round(正文/3)，区间 [0.9×, 1.1×]；1200 字内短章下限 200
  const target = (L<=1200) ? Math.max(200, Math.round(L/3)) : Math.round(L/3);
  const lo = Math.round(target*0.9), hi = Math.round(target*1.1);
  // 4.8 旗舰版（P2）：system/user 统一经 getSystemPrompt / buildAIPrompt（AIBus 上下文组装，与旧拼装等价）
  const sys = getSystemPrompt('strip', { targetZhs: target });
  const user = buildAIPrompt('strip', { idx: i, targetZhs: target });
  try{
    const txt = unwrapAIResult(await callDeepSeek(sys, user, {temperature: 0.3, topP: 0.5, signal: _abortCtl?.signal, maxTokens: clampMaxTokens('strip'), taskKey:'strip'}));   // 4.8 旗舰版（板块二-2/3）：梗概类窄采样 + 限长
    let strip = String(txt||'').trim();
    if(!strip){ toast('未生成到本章梗概'); return; }
    strip = strip.replace(/^```[\s\S]*?\n/, '').replace(/\n```\s*$/,'').trim();   // 去 markdown 代码块围栏
    // 4.7 Pro（3.9）：捕获 AI 自报字数注释（<!-- STRIP_LEN: 实际字数 -->）并校验字数区间（不阻断，仅提示）
    const _slm = strip.match(/<!--\s*STRIP_LEN:\s*(\d+)\s*-->/);
    const _stripRep = validateStripLen(strip, target);
    if(!_stripRep.ok){
      const _auto = _slm ? +_slm[1] : null;
      console.warn('[梗概] 字数未达标（不阻断）：', _stripRep.len, '目标', target, '区间', _stripRep.lo, '-', _stripRep.hi, _auto!==null ? `（AI 自报 ${_auto}）` : '');
      toast(`⚠️ 梗概 ${_auto!==null?_auto:_stripRep.len} 字，目标区间 ${_stripRep.lo}—${_stripRep.hi} 字`);
    }
    c.strip = strip;
    if(o.chapters && o.chapters[i]) o.chapters[i].strip = strip;
    persist();
    const miss = densityCheck(body, strip, o, i);   // 密度自检
    renderChapterSummaryBody(i, miss);
    if(miss.length){ toast(`⚠️ 密度自检：本段未覆盖 ${miss.slice(0,3).map(m=>m.t+'「'+m.n+'」').join('、')}${miss.length>3?' 等':''}，建议重生成或下调本章梗概温度至 0.7–0.9`); }
    else { toast('本章梗概已生成'); }
  }catch(e){
    if(e.name==='AbortError'){ toast('已停止生成本章梗概'); }
    else { toast('生成本章梗概失败：'+e.message); }
  }finally{
    if(genBtn){ genBtn.disabled = false; busy(genBtn,false); }
  }
}

function openChapterSummaryPanel(i){
  closeChapterSummaryPanel();
  const c = state.chapters[i]; if(!c) return;
  const title = cleanChapterTitle(c.title || ('第'+(i+1)+'章'));
  const has = !!(c.content && String(c.content).trim());
  const ov = document.createElement('div'); ov.id='chSumPanel'; ov.className='gs-overlay';
  ov.innerHTML = `<div class="gs-modal" style="max-width:780px">
    <div class="gs-modal-head"><b>🏮 速读 · 本章梗概 · 第${i+1}章「${esc(title)}」</b>
      <span style="display:flex;gap:6px">
        <button type="button" class="btn small ghost" id="chSumCopy" title="复制本章梗概文本">📋 复制</button>
        <button type="button" class="gs-x" data-chsum-close>✕</button>
      </span></div>
    <div class="cv-body">
      <div id="chSumBody"></div>
      <div class="advice-ai-row" style="margin-top:12px">
        <button type="button" class="ct-rtgen" id="chSumGen" ${has?'':'disabled'}>✨ 生成本章梗概</button>
      </div>
    </div></div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-chsum-close]').onclick = closeChapterSummaryPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeChapterSummaryPanel(); });
  ov.querySelector('#chSumGen').onclick = ()=> chSumGenerate(i, ov.querySelector('#chSumGen'));
  ov.querySelector('#chSumCopy').onclick = ()=>{ const s=(c.strip||'').trim(); if(s) copyText(s); };
  renderChapterSummaryBody(i);
}
/* ---------- P1-1v4 单章原始响应手动提取 ---------- */
function openChRawPanel(i){
  closeChRawPanel();
  let raw = (state._lastChapterRaw && state._lastChapterRaw[i]) || '';
  const hasRaw = !!raw;
  const escRaw = esc(raw);
  const c = state.chapters[i];
  const title = c && c.title ? c.title : ('第'+(i+1)+'章');
  const ov = document.createElement('div'); ov.id='chRawPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal" style="max-width:780px">
      <div class="gs-modal-head"><b>🔧 原始 AI 响应 — 第${i+1}章「${esc(cleanChapterTitle(title))}」</b>
        <span style="display:flex;gap:6px">
          <button class="btn small ghost" data-chraw-searchlog>📋 搜索最近日志</button>
          <button class="gs-x" data-chraw-close>✕</button>
        </span></div>
      <div class="cv-body">
        <div class="cv-div">这里是最近一次重生成本章时 AI 返回的原始响应。如果自动更新失败，可手动点击「应用原始内容到本章」来提取数据。</div>
        <div class="cpraw-actions">
          <button type="button" class="btn primary" data-chraw-apply ${hasRaw?'':'disabled'}>应用原始内容到本章</button>
          <span style="font-size:12px;color:var(--sub);align-self:center">${hasRaw?`共 ${raw.length} 字`:'（暂无原始响应数据）'}</span>
        </div>
        <pre class="cpraw-pre">${hasRaw?escRaw:'(暂无原始响应数据。执行一次本章「重生成」后，原始响应会自动保存至此。)'}</pre>
        <p class="muted" style="margin:6px 0 0;font-size:11px">💡 提示：也可点击「搜索最近日志」从 AI 请求日志中查找最近一次本章生成响应。</p>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-chraw-close]').onclick = closeChRawPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeChRawPanel(); });
  ov.querySelector('[data-chraw-apply]').onclick = ()=> applyChRawResponse(i, raw);
  ov.querySelector('[data-chraw-searchlog]').onclick = ()=>{
    closeChRawPanel(); openAiLogPanel();
    setTimeout(()=>{
      const rows = $$('[data-ailog-toggle]');
      if(rows.length){
        // 找最近一条包含"第X章"的日志（task 字段可能包含章节信息）
        const target = '第'+(i+1); // 简化匹配
        for(let i2=rows.length-1; i2>=0; i2--){
          const row = rows[i2]; const taskEl = row.closest('.ailog-row') && row.closest('.ailog-row').querySelector('.ailog-task');
          if(taskEl && taskEl.textContent.includes(target)){ row.click(); break; }
        }
      }
    }, 300);
  };
}
function closeChRawPanel(){ const p=$('#chRawPanel'); if(p) p.remove(); }
function applyChRawResponse(i, raw){
  if(!raw){ toast('无原始响应数据'); return; }
  const c = state.chapters[i];
  if(!c){ toast('无此章节'); return; }
  // 直接应用原始内容到本章
  snapshotChapterVersion(i);
  c.content = raw;
  if(!isLong()) c.confirmed = false;
  persist();
  closeChRawPanel();
  // 就地更新文本区
  const ta = document.querySelector(`textarea[data-ch="${i}"]`);
  if(ta) ta.value = raw;
  patchChapter(i);
  toast('✅ 已手动应用原始内容到第'+(i+1)+'章');
}


// 长篇：写作范式选择器（结构 + 可复用词典，均折叠；节奏/标题/质量 v10.18/10.60 移除）
// 长篇：写作范式选择器（可复用词典折叠；结构/节奏/标题风格已移除 v11）
function loglineRangeHtml(){
  const lr = state.loglineRange || {min:300, max:700};
  const _m = Number.isFinite(lr.min)?Math.max(1,Math.min(5000,Math.floor(lr.min))):300;
  const _x = Number.isFinite(lr.max)?Math.max(1,Math.min(5000,Math.floor(lr.max))):700;
  const _lo = Math.min(_m,_x), _hi = Math.max(_m,_x);
  return `<div class="logline-range">
    <span class="llr-label">简介字数范围：</span>
    <input type="number" id="llMin" class="llr-input" min="1" max="5000" step="1" value="${_lo}" aria-label="简介最少字数">
    <span class="llr-sep">—</span>
    <input type="number" id="llMax" class="llr-input" min="1" max="5000" step="1" value="${_hi}" aria-label="简介最多字数">
    <span class="llr-hint">字（生成大纲时 AI 严格遵守此区间；两数颠倒会自动对调）</span>
  </div>
  <p class="muted" style="margin:8px 0 0">全书章节数请到「第二步 · 章节标题」区填写；填完后点击「生成全部章节标题」。</p>`;
}

// 遵从度 → 语义化说明（v8：把百分比翻译成给用户看的自然语言）
function adherenceHint(a){
  if(a>=100) return '铁律：人名/地名/专名必须逐字沿用，禁止改拼写，仅按新大纲补新角色。';
  if(a>=80)  return '基准：尽量沿用，允许个别因新情节小幅调整。';
  if(a>=60)  return '主要参照：核心角色沿用，地名/专名可按新剧情调整。';
  if(a>=30)  return '灵感来源：可大改人名地名，仅保留题材与语感。';
  return '几乎放弃：仅作背景语感参考，允许完全重新构建设定。';
}
// 拆分章节输出：AI 输出全文即正文，直接落库
// 省 token 策略：正文沿用写入时的 max_tokens 上限；
// v10.11 已去除「AI 返回本章梗概」契约，v1.0.115 本章梗概(strip)改由事后速读生成（单章梗概面板）。
function splitChapterOutput(txt){
  return { content: String(txt||'').trim(), strip: '' };
}
let _chRawBuf = null;   // P1-1v4 单章原始响应缓存，供手动提取

async function writeOneChapterContent(i, user, onPhase, onStream, styleOverride, signal){
  const mt = chapterMaxTokens();
  onPhase = onPhase || (()=>{});
  onPhase('撰写本章正文…');
  // 4.8 旗舰版（板块一-3）：若存在流式中断缓存，先尝试续写
  const resumePartial = (state._chapterPartial && state._chapterPartial[i]) || '';
  let txt = '';
  if(resumePartial.length >= 200){
    txt = await continueTruncatedChapter(i, '', resumePartial);
    delete state._chapterPartial[i];
    persist();
  } else {
    // 流式回调里累积 partial，中断后可 resume
    let partial = (state._chapterPartial && state._chapterPartial[i]) || '';
    const _onStream = (delta)=>{ partial += delta; state._chapterPartial[i] = partial; if(onStream) onStream(delta); };
    try{
      txt = unwrapAIResult(await callDeepSeek(longChapterSys(styleOverride), user, {maxTokens: mt, onStream: _onStream, temperature: dynamicChapterParams(i).temperature, topP: dynamicChapterParams(i).topP, signal: signal || _abortCtl?.signal, taskKey:'chapter'}));
      delete state._chapterPartial[i];
      persist();
    }catch(e){
      // 中断时保留 partial，下次进入续写
      state._chapterPartial[i] = partial;
      persist();
      throw e;
    }
  }
  _chRawBuf = { i, raw: txt, ts: Date.now() };
  const sp = splitChapterOutput(txt);
  return String(sp.content).trim();
}
// 组装单章生成的 user 提示词。恒定前缀块（标题/梗概/全部章节标题/一致性词典）保持在前、全章不变，
// 以最大化 DeepSeek 上下文缓存命中；可变信息（上一章全文/结构注入）尽量放后。
// opt.regenerating=true 时（单章重生成）额外注入下章概要，保证前后连贯（建议5/决策5）。
// 衔接来源 = 上一章完整正文（替代旧的本章概要/上章结尾200字，避免丢信息），批内多章一体时更由前文临时写入承接。
// 章节标题列表（v9 曾全列；v2.4 起不再注入章节生成——用户要求全部章节标题零夹带，主线简述生成自行拼标题列表）
// 承接来源（v10）：只提供「上一章真实正文」，取代旧的全量前文（cumulativeChapters）。恒定内容块承载全书脉络。
// 上一章标签统一为【上一章（第 N 章《标题》）】，i 为当前章 0 基下标；第 1 章（i<=0）无前文返回空。
function prevChapter(i){
  if(i <= 0) return '';
  const c = state.chapters[i-1];
  if(!(c && c.content && String(c.content).trim())) return '';
  return `【上一章（第 ${i} 章《${c.title||''}》）真实正文】\n${String(c.content).trim()}`;
}
// 批间累积前缀（v9）：拼接第 1..(i-1) 章完整正文，放进恒定前缀区（从第0个token起与前序请求完整复用 → 缓存命中，见 安排token.md §14）。
// 每写一章只在末尾追加上一章，前缀部分整段命中；为尽量减少宽占用可根据体量不超上下文，单章下限亦覆盖。
// 注：v10 生成的「AI 注入」改用 prevChapter（仅上一章）；本函数保留供阅读/导出等仍用全量文本的地方复用，勿删。
function cumulativeChapters(i){
  const out = [];
  const start = 0;
  for(let k=start; k<i; k++){
    const c = state.chapters[k];
    if(c && c.content && String(c.content).trim()) out.push(`【第${k+1}章】${c.title||''}\n${c.content}`);
  }
  return out.join('\n\n');
}
// v2.4 章节 User 组装：按用户指定优先级（人工干预 > 写作风格 > 词典）——
// ① 写作风格（第一优先）② 上一章真实正文（必须接着写）③ 本章任务+主线简述 ④ 本章/下一章边界（禁越界，末章收束）⑤ 大纲/结构/词典 ⑥ 人工干预（重生成，最高优先）
// 不注入"全部章节标题"（v2.3 零夹带）；词典全字段经 chapterGlossaryBlock 注入。
const USER_PRIO_BILL = '\n\n【优先级契约】当同时存在多条用户要求时，按此裁决（高→低）：写作风格（第一优先，压过所有） > 人工干预要求 > 设定词典。前者与后者冲突时以前者为准；设定词典（人名/地名/专名一致性）为不可逾越红线，任何要求不得破坏。';
// 4.5 buildChapterUser 升级：L0 风格契约 / L1 节拍表 / L2 上一章全文 / L3 相关词典（替代全量词典）/ L4 滚动摘要；
// 原边界逻辑（本章任务/本章边界/下一章边界/末章收束/开篇与上章兜底说明）按 4.5 方案要求保留。
// 4.8 旗舰版（板块一-2）：上下文长度预算器。按优先级从低到高（L4→L3→简介→L1 详细说明）逐级裁剪，
// 保证 system+user 不超限，同时保住 L0、L1 节拍骨架、L2 承接锚点、本章任务与边界。
function budgetChapterContext(parts, maxChars){
  const total = () => parts.join('\n\n').length;
  if(total() <= maxChars) return parts;
  // 辅助：找到并替换/删除某个块的文本
  const idx = (label) => parts.findIndex(s => s.startsWith(label));
  // 1) 截断 L4 滚动摘要（只保留前 200 字）
  const l4 = idx('【L4 前文滚动摘要】');
  if(l4 >= 0){
    const head = '【L4 前文滚动摘要】\n';
    const body = parts[l4].slice(head.length).trim();
    parts[l4] = head + body.slice(0, 200) + (body.length > 200 ? '…' : '');
  }
  if(total() <= maxChars) return parts;
  // 2) 截断衔接事实
  const bridge = idx('【衔接事实】');
  if(bridge >= 0){
    const head = '【衔接事实】';
    const body = parts[bridge].slice(head.length).trim();
    parts[bridge] = head + body.slice(0, 160) + (body.length > 160 ? '…' : '');
  }
  if(total() <= maxChars) return parts;
  // 3) 截断 L3 相关词典
  const l3 = idx('【L3 相关设定词典');
  if(l3 >= 0){
    const lines = parts[l3].split('\n');
    parts[l3] = lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n…（词典已截断）' : '');
  }
  if(total() <= maxChars) return parts;
  // 4) 截断简介定位
  const ref = idx('【小说简介】');
  if(ref >= 0){
    parts[ref] = parts[ref].slice(0, 260) + (parts[ref].length > 260 ? '…' : '');
  }
  if(total() <= maxChars) return parts;
  // 5) 截断 L1 的详细说明，只保留 beats 列表和情绪弧/实体汇总
  const l1 = idx('【L1 本章节拍表】');
  if(l1 >= 0){
    const lines = parts[l1].split('\n');
    // 保留标题行、情绪弧、实体汇总、以及每节拍的前 60 字
    parts[l1] = lines.map((line, i) => {
      if(i <= 2) return line;   // 标题/情绪弧/实体汇总
      if(line.startsWith(' ')) return line;
      return line.slice(0, Math.min(line.length, 120)) + (line.length > 120 ? '…' : '');
    }).join('\n');
  }
  if(total() <= maxChars) return parts;
  // 6) 最后防线：直接截断末尾（人工干预与优先级契约之前）
  let s = parts.join('\n\n');
  if(s.length > maxChars){
    s = s.slice(0, maxChars) + '…';
    // 直接返回单字符串会丢失 parts 结构，但总比崩溃好；这里保留原数组并截断最后非关键块
    // 实际不会走到这里，因为前面已大幅裁剪
  }
  return parts;
}

function buildChapterUser(i, opt={}){
  const o = state.outline;
  const chap = state.chapters[i];
  const curN = i + 1;
  const parts = [];
  // L0 风格契约（恒定最高优先级，放最前以命中上下文缓存前缀）
  const sc = opt.styleContract || state.styleContract || buildStyleFingerprintFromConfirmed();
  if(sc && typeof sc === 'object'){
    parts.push(`【L0 风格契约（最高优先级）】\n平均句长 ${sc.sentenceAvg||22} 字（容忍 ±${Math.round((sc.sentenceTolerance||0.2)*100)}%）；对话占比 ${Math.round((sc.dialogueRatio||0.3)*100)}%（容忍 ±${Math.round((sc.dialogueTolerance||0.1)*100)}%）；禁用词：${(sc.forbiddenPhrases||[]).join('、')||'无'}；偏好转场：${(sc.preferredTransitions||[]).join('、')||'无'}；节奏：${sc.rhythmNote||'按主线简述自然铺陈'}。`);
  }
  // 4.8 旗舰版（板块三-4）：范文镜像——轮换注入作家金句，辅助风格迁移
  if(state._styleDNA && Array.isArray(state._styleDNA.exemplars) && state._styleDNA.exemplars.length){
    const idx = i % state._styleDNA.exemplars.length;
    const ex = state._styleDNA.exemplars;
    parts.push(`【范文镜像 · 风格参照（仅作语感参照，禁止照搬情节）】\n${ex[idx]}${ex.length>1?'\n…（还有 '+ex.length+' 句镜像句按章轮换）':''}`);
  }
  // 4.8 旗舰版（板块二-1）：恒定前缀块前置（简介定位 → L3 词典 → L4 摘要 → 事实衔接），可变信息（L1 节拍、L2 上章、任务边界）放后，提升 DeepSeek 上下文缓存命中率
  // 简介定位
  let ref = outlineAnchorBlock() ? `${outlineAnchorBlock()}\n【小说简介】书名：${o.title||''}｜一句话概览：${o.logline||''}` : `【小说简介】书名：${o.title||''}｜一句话概览：${o.logline||''}`;
  parts.push(ref);
  // L3 相关词典（替代全量）
  const rg = relevantGlossaryForChapter(i);
  const rgBlock = formatRelevantGlossary(rg);
  if(rgBlock) parts.push(`【L3 相关设定词典（本章必须采用）】\n${rgBlock}`);
  // L4 滚动摘要
  const rolling = buildRollingSummary(i);
  if(rolling) parts.push(`【L4 前文滚动摘要】\n${rolling}`);
  // 4.7 Pro（3.5）：L3/L4 补充事实卡衔接——上一章结尾状态 / 未收束伏笔
  const fc = (o._factCard || {});
  if(fc.lastScene || (fc.unresolvedHooks||[]).length){
    parts.push(`【衔接事实】上一章结尾状态：${fc.lastScene||'（未记录）'}；未收束伏笔：${(fc.unresolvedHooks||[]).map(h=>h.text).join('、')||'无'}`);
  }
  // 4.8 旗舰版（板块三-1）：伏笔生命周期强制注入——逾期伏笔置顶；全书末 20% 章节必须开始收束清单
  const ledger = (o._foreshadowLedger || { planted:[], resolved:[], overdue:[] });
  const totalCh = (o.chapters && o.chapters.length) || 1;
  const inEndgame = (i + 1) >= Math.floor(totalCh * 0.8);
  const overdue = ledger.overdue || [];
  const unresolved = ledger.planted || [];
  if(overdue.length){
    parts.push(`【伏笔收束警报 · 最高优先级】以下伏笔已逾期，必须在本章或下一章明确兑现：\n${overdue.map((h,idx)=>`${idx+1}. ${h.text}（第${h.chPlanted+1}章埋设，预计第${h.expectedCh+1}章兑现）`).join('\n')}`);
  }
  if(inEndgame && unresolved.length){
    parts.push(`【全书末段收束清单】本书仅剩 ${totalCh - (i+1)} 章，以下未收束伏笔必须在结局前给出交代：\n${unresolved.slice(0,8).map((h,idx)=>`${idx+1}. ${h.text}`).join('\n')}${unresolved.length>8?'\n…（其余伏笔酌情收束）':''}`);
  }
  // 4.8 旗舰版（板块三-3）：张力目标注入
  const tTarget = getTargetTension(i);
  const curScore = (state._tensionCurve || []).find(t => t.ch === i);
  if(tTarget){
    let tNote = `【张力目标】本章位于${tTarget.phase}，目标外在冲突 ≥ ${tTarget.external}、内心冲突 ≥ ${tTarget.internal}、信息差 ≥ ${tTarget.mystery}。`;
    if(curScore) tNote += ` 当前草稿分别为 ${curScore.external}/${curScore.internal}/${curScore.mystery}，请按目标强化正面对抗、内心挣扎或悬念铺设。`;
    parts.push(tNote);
  }
  // L1 节拍表（每章必变，放恒定前缀之后）
  const plan = (Array.isArray(o.chapterPlans) && o.chapterPlans[i]) || null;
  if(plan && Array.isArray(plan.beats)){
    let beatText = `【L1 本章节拍表】\n本章主线简述：${plan.summary||''}\n`;
    // 4.7 Pro（3.5）：补情绪弧 + 本章必须使用实体汇总
    beatText += `情绪弧：${plan.emotionalArc||'按上下文自然推进'}\n`;
    beatText += `必须使用实体汇总：${(plan.requiredEntities||[]).join('、')||'无'}\n`;
    plan.beats.forEach((b, idx)=>{
      beatText += `${idx+1}. [${b.type}] ${b.event}（情绪：${b.emotional||'按上下文'}）——必须出现：${(b.requiredEntities||[]).join('、')||'无'}${(b.foreshadowing||[]).length ? '；埋伏笔：'+b.foreshadowing.join('、') : ''}\n`;
    });
    parts.push(beatText);
  }
  // L2 上一章：三层压缩，避免头重脚轻；若上一章是失败草稿则只给摘要+简述，避免污染链（4.8 旗舰版 板块一-2 / 一-4）
  if(i > 0){
    const pc = state.chapters[i-1];
    if(pc && pc.content && String(pc.content).trim()){
      if(pc._qualityIssue){
        // 上一章校验未通过：禁止把失败/旧正文注入本章上下文
        const prevPlan = (Array.isArray(o.chapterPlans) && o.chapterPlans[i-1]) ? chapterPlanText(o.chapterPlans[i-1]) : '';
        const prevSummary = buildRollingSummary(i);
        const prevLastScene = (state.outline._factCard && state.outline._factCard.lastScene) || '';
        parts.push(`【L2 上一章说明】上一章（第 ${i} 章《${pc.title||''}》）当前状态为「校验未通过：${pc._qualityIssue.code}」。本章不得以上一章正文为承接依据，只能依据以下信息继续：\n上一章结尾场景：${prevLastScene || '（未记录）'}\n上一章主线简述：${prevPlan || '（暂无）'}\n\n近期滚动摘要：\n${prevSummary || '（暂无）'}\n\n请保持全书主线不跑偏，但细节按本章节拍表与事实卡自然铺陈。`);
      } else {
        const prevFull = String(pc.content).trim();
        const prevSummary = buildRollingSummary(i);   // 第 i 章能看到的、覆盖上一章的滚动摘要
        const prevLastScene = (state.outline._factCard && state.outline._factCard.lastScene) || '';
        if(prevSummary || prevLastScene){
          parts.push(`【L2 上一章承接（第 ${i} 章《${pc.title||''}》）】\n上一章结尾场景：${prevLastScene || '（未记录）'}\n\n近期滚动摘要：\n${prevSummary || '（暂无）'}\n\n上章末尾原文（承接锚点，约 1500 字）：\n${prevFull.slice(-1500)}`);
        } else {
          // 无摘要兜底：注入上一章尾部 5000 字（仍优先保章尾钩子）
          parts.push(`【L2 上一章真实正文（第 ${i} 章《${pc.title||''}》）】\n${prevFull.slice(-5000)}`);
        }
      }
    } else {
      parts.push(`【上一章说明】上一章（第 ${i} 章）尚无正文，本章按大纲独立展开，但不得违背全局设定。`);
    }
  } else {
    parts.push(`【开篇说明】本章为全书第一章，无前文，请直接开篇立住基调。`);
  }
  // 本章任务（原边界逻辑保留：对象形态的简述已由 L1 节拍表承载，避免重复注入；旧字符串形态在此注入）
  // v225/P5-D：空标题兜底——标题未定稿时不渲染"《》"
  const hasT = String(chap.title||'').trim();
  let task = `【本章任务】第 ${curN} 章${hasT ? `《${chap.title}》` : '（本章标题未定稿）'}`;
  if(!(plan && Array.isArray(plan.beats))){
    const planTxt = chapterPlanText(plan);
    if(planTxt) task += `\n【本章主线简述（辅助参考，非硬性脚本）】\n${planTxt}\n本章按此主线展开剧情，细节、对白与具体走向由你按人物设定与上文承接自然铺陈；若它与上章结尾或人物处境冲突，以上文真实承接为准。`;
  }
  parts.push(task);
  // 本章边界 + 下一章边界（禁越界）/ 末章收束（原边界逻辑保留）
  const isLast = (i + 1) >= (o.chapters||[]).length;
  // v225/P5-D：标题未定稿时本章边界改挂主线简述/节拍表；下一章有标题才带书名号
  let boundary = hasT
    ? `【本章边界】本章内容须紧扣本章标题展开、不得偏离；已发生的剧情不重复叙述。`
    : `【本章边界】本章标题未定稿，内容须紧扣本章主线简述与节拍表展开、不得偏离；已发生的剧情不重复叙述。`;
  if(isLast){
    boundary += `\n【全书收束】本章为全书最后一章：请收束全书，交代主要线索与人物归宿，给出结局，不留开放式烂尾。`;
  } else {
    const nextC = o.chapters[i+1];
    const nextPlan = (Array.isArray(o.chapterPlans) && o.chapterPlans[i+1]) ? chapterPlanText(o.chapterPlans[i+1]) : '';
    const nt = (nextC && String(nextC.title||'').trim()) || '';
    boundary += `\n【下一章边界】下一章为第 ${i+2} 章${nt?`《${nt}》`:''}${nextPlan?`，其主线简述：${nextPlan}`:''}。\n本章严禁展开、暗示或提前完成下一章内容；下一章的情节一律留到下一章再写。`;
  }
  parts.push(boundary);
  parts.push(USER_PRIO_BILL);
  if(opt.advice) parts.push(`【人工干预要求（用户指定 · 第二优先）】\n${opt.advice}`);
  // 4.8 旗舰版（板块一-2）：按 24000 字符预算裁剪上下文，防止超上下文窗口
  return budgetChapterContext(parts, 24000).join('\n\n');
}

// 4.5：为第 i 章（0 基）生成相关词典，只返回与本周相关的条目 + 主角条目
// 4.8 旗舰版（板块二-4）：改为以 _factCard.characters 出场索引为主、正则一次匹配、结果缓存，避免 O(N×M) 重复扫描。
function relevantGlossaryForChapter(i){
  const o = state.outline;
  if(!o) return {characters:[], places:[], propernouns:[]};
  // 缓存命中：未重写时直接复用
  if(o._relGlossCache && o._relGlossCache[i] && !o._relGlossCache[i]._stale) return o._relGlossCache[i];
  const g = o.glossary || {};
  const plan = (Array.isArray(o.chapterPlans) && o.chapterPlans[i]) || {};
  const beats = Array.isArray(plan.beats) ? plan.beats : [];
  const prev = i > 0 ? state.chapters[i-1] : null;
  // 收集关键词
  const keywords = new Set();
  beats.forEach(b => (b.requiredEntities||[]).forEach(e => keywords.add(String(e).trim())));
  (plan.requiredEntities||[]).forEach(e => keywords.add(String(e).trim()));
  // 主角保护
  if(o.navBeacon && o.navBeacon.protagonist){
    const name = String(o.navBeacon.protagonist).split(/[，,：:（(]/)[0].trim();
    if(name) keywords.add(name);
  }
  // 上一章出场人物：优先用 _factCard.characters 索引（O(1)），否则回退到正文正则扫描
  if(prev && prev.content){
    const fc = o._factCard || {};
    const appeared = fc.characters || {};
    Object.keys(appeared).forEach(name => { if(appeared[name] > 0) keywords.add(name); });
    // 兜底：正文尾部 3000 字内出现的人名（保章尾钩子相关人物）
    const tail = String(prev.content).slice(-3000);
    (g.characters||[]).forEach(c => {
      const nm = String(c.name||'').trim();
      if(nm && new RegExp(escapeRegExp(nm)).test(tail)) keywords.add(nm);
    });
  }
  if(!keywords.size){
    const empty = {characters:[], places:[], propernouns:[]};
    o._relGlossCache = o._relGlossCache || {}; o._relGlossCache[i] = empty;
    return empty;
  }
  // 预编译正则：所有关键词按长度降序，避免短名误匹配长名
  const kwArr = Array.from(keywords).filter(Boolean).sort((a,b)=>b.length-a.length);
  const kwRe = kwArr.length ? new RegExp(kwArr.map(escapeRegExp).join('|'), 'g') : null;
  // 匹配词典条目
  const match = (arr) => {
    if(!kwRe) return [];
    return (arr||[]).filter(it => {
      const nm = String(it.name||'').trim();
      if(!nm) return false;
      kwRe.lastIndex = 0;
      if(kwRe.test(nm)) return true;
      const hay = [it.identity, it.relation, it.note, it.appearance, it.type].join(' ');
      kwRe.lastIndex = 0;
      return kwRe.test(hay);
    });
  };
  const res = {
    characters: match(g.characters),
    places: match(g.places),
    propernouns: match(g.propernouns)
  };
  o._relGlossCache = o._relGlossCache || {};
  o._relGlossCache[i] = res;
  return res;
}
function escapeRegExp(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function formatRelevantGlossary(rg){
  const lines = [];
  if(rg.characters && rg.characters.length) lines.push('人物：'+rg.characters.map(c=>`${c.name}（${c.identity||''}${c.age?','+c.age+'岁':''}${c.gender?','+c.gender:''}）`).join('、'));
  if(rg.places && rg.places.length) lines.push('地点：'+rg.places.map(p=>`${p.name}${p.note?'（'+p.note+'）':''}`).join('、'));
  if(rg.propernouns && rg.propernouns.length) lines.push('专名：'+rg.propernouns.map(p=>`${p.name}${p.note?'（'+p.note+'）':''}`).join('、'));
  return lines.join('\n');
}

// 4.5：正文后验校验（字数/节拍实体覆盖/专名漂移/与上章重复/风格契约偏离）
async function validateChapterContent(i, text){
  const report = { ok:true, errors:[], code:'' };
  const plan = (state.outline && state.outline.chapterPlans && state.outline.chapterPlans[i]) || {};
  // 1. 字数检验已移除（v225/P1）：篇幅由用户自行判断，提示词仅作引导、程序不再按字数拦截
  // 2. 节拍表覆盖
  if(plan && Array.isArray(plan.beats)){
    const allRequired = new Set();
    plan.beats.forEach(b => (b.requiredEntities||[]).forEach(e => allRequired.add(String(e).trim())));
    const missed = [];
    allRequired.forEach(e => { if(!text.includes(e)) missed.push(e); });
    if(missed.length){ report.ok = false; report.code = AI_ERR.SCHEMA_MISS; report.errors.push(`未覆盖节拍实体：${missed.join('、')}`); }
  }
  // 3. 专名漂移程序闸已移除（v225/P2）：正文按剧情可自然引入新实体，新实体由逐章提取通道（extractGlossaryFromChapter）自动入典，不再按"自造专名"拦截
  // 4.8 旗舰版（板块三-2）：人设一致性防火墙（异步 AI 审计），阈值 1 条即阻断
  try{
    const pd = await personaDriftCheck(i, text);
    if(pd.violations.length >= 1){
      report.ok = false; report.code = AI_ERR.PERSONA_DRIFT;
      report.errors.push(...pd.violations.map(v => `人设漂移 · ${v.name} · ${v.field}：${v.evidence}（应为：${v.expected}）`));
      // 把修正指令写入重试通道
      state._chapterRetryFix = `【人设一致性强制修正】本章出现以下人物设定矛盾，重写时必须避免：\n${pd.violations.map(v => `· ${v.name} 的 ${v.field}：证据「${v.evidence}」与设定「${v.expected}」矛盾`).join('\n')}`;
    }
  }catch(e){ /* 静默失败，不阻断 */ }
  // 4. 与上章重复
  if(i > 0){
    const prev = state.chapters[i-1] && state.chapters[i-1].content;
    if(prev){
      const rep = longestCommonPrefix(prev, text);
      if(rep.length > 80){ report.ok = false; report.code = AI_ERR.REPEAT_OVER; report.errors.push(`与上章开头重复 ${rep.length} 字`); }
    }
  }
  // 5. 风格契约
  // v225/P3 窄迁移：存量契约若对话比=0（旧算法 bug 产物）且未标 _fnVer:2，按新算法仅重算该字段一次；配方/DNA 等其他来源契约的非 0 字段一律不动
  let sc = state.styleContract || buildStyleFingerprintFromConfirmed();
  if(sc && sc._fnVer !== 2 && Number(sc.dialogueRatio) === 0){
    const fp2 = buildStyleFingerprintFromConfirmed();
    if(fp2 && Number.isFinite(fp2.dialogueRatio) && fp2.dialogueRatio > 0){
      if(state.styleContract){
        state.styleContract = Object.assign({}, state.styleContract, { dialogueRatio: fp2.dialogueRatio, _fnVer: 2 });
        persist();
        sc = state.styleContract;
      } else {
        sc = fp2;
      }
    }
    if(sc && sc._fnVer !== 2) sc = Object.assign({}, sc, { _fnVer: 2 });
  }
  if(sc){
    const avg = avgSentenceLength(text);
    const tol = sc.sentenceTolerance || 0.2;
    if(avg < sc.sentenceAvg*(1-tol) || avg > sc.sentenceAvg*(1+tol)){
      report.ok = false; report.code = AI_ERR.STYLE_DRIFT;
      report.errors.push(`句长 ${avg.toFixed(1)} 超出契约 ${sc.sentenceAvg}±${Math.round(tol*100)}%`);
    }
    const dia = dialogueRatio(text);
    const dtol = sc.dialogueTolerance || 0.1;
    if(dia < sc.dialogueRatio*(1-dtol) || dia > sc.dialogueRatio*(1+dtol)){
      report.ok = false; report.code = AI_ERR.STYLE_DRIFT;
      report.errors.push(`对话比 ${(dia*100).toFixed(1)}% 超出契约 ${Math.round(sc.dialogueRatio*100)}±${Math.round(dtol*100)}%`);
    }
  }
  return report;
}

// 4.8 旗舰版（板块三-2）：人设一致性防火墙 AI 审计。返回 {violations:[...]}。
async function personaDriftCheck(i, text){
  const o = state.outline; if(!o) return {violations:[]};
  const g = o.glossary || {};
  const chars = (g.characters || []).filter(c => c && c.name);
  if(!chars.length) return {violations:[]};
  // 同步 canon 到 _personaCards
  const pc = state._personaCards = state._personaCards || {};
  chars.forEach(c => {
    pc[c.name] = pc[c.name] || { canon:{}, chapterTraits:{} };
    pc[c.name].canon = {
      identity: String(c.identity||'').trim(),
      age: String(c.age||'').trim(),
      gender: String(c.gender||'').trim(),
      appearance: String(c.appearance||'').trim(),
      hobby: String(c.hobby||'').trim(),
      relation: String(c.relation||'').trim(),
      trait: String(c.trait||'').trim()
    };
    pc[c.name].chapterTraits = pc[c.name].chapterTraits || {};
  });
  const cards = chars.map(c => `${c.name}：identity=${c.identity||'未知'}，age=${c.age||'未知'}，gender=${c.gender||'未知'}，appearance=${c.appearance||'未知'}，hobby=${c.hobby||'未知'}，relation=${c.relation||'未知'}，trait=${c.trait||'未知'}`).join('\n');
  const user = `【人物卡】\n${cards}\n\n【本章正文（第 ${i+1} 章）】\n${text.slice(0, 12000)}`;
  const txt = unwrapAIResult(await callDeepSeek(PERSONA_DRIFT_SYS, user, {maxTokens: clampMaxTokens('json'), temperature: 0.1, topP: 0.3, taskKey:'audit'}));
  const j = parseJson(txt) || {};
  const violations = (Array.isArray(j.violations)?j.violations:[]).filter(v => v && String(v.name||'').trim() && String(v.field||'').trim());
  // 记录本章特质（用于后续 canon 演化，当前仅存储）
  violations.forEach(v => {
    const entry = pc[v.name]; if(!entry) return;
    entry.chapterTraits[i] = entry.chapterTraits[i] || [];
    entry.chapterTraits[i].push(`${v.field}:${v.evidence}`);
  });
  return { violations };
}
// detectUnknownProperNouns 已随 v225/P2 专名漂移程序闸移除（唯一调用点一并删除）

function longestCommonPrefix(a, b){
  let i = 0;
  while(i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  return a.slice(0, i);
}

function avgSentenceLength(text){
  const sents = text.split(/[。！？；\n]+/).filter(s => s.trim());
  if(!sents.length) return 0;
  const total = sents.reduce((sum, s) => sum + (s.match(/[\u4e00-\u9fa5]/g)||[]).length, 0);
  return total / sents.length;
}

// v225/P3 重写：对话占比 = 成对引号内的对话汉字数 / 全文汉字数（弃用"每对引号≈30字"的假估计——旧正则字符类只含直引号，不含中文弯引号 U+201C/U+201D，正文用弯引号时统计恒 0）
function dialogueRatio(text){
  const t = String(text||'');
  let dia = 0;
  // 简体中文主用弯引号；兼容直角引号与半角直引号。『』常嵌套在「」内，先剥外层再算内层，防重复计数
  [/“([^“”]*)”/g, /「([^「」]*)」/g, /"([^"]*)"/g, /'([^']*)'/g].forEach(re => {
    let m; while((m = re.exec(t)) !== null) dia += (m[1].match(/[\u4e00-\u9fa5]/g)||[]).length;
  });
  const inner = t.replace(/“[^“”]*”/g, '　').replace(/「[^「」]*」/g, '　');
  let m2; while((m2 = /『([^『』]*)』/g.exec(inner)) !== null) dia += (m2[1].match(/[\u4e00-\u9fa5]/g)||[]).length;
  const total = (t.match(/[\u4e00-\u9fa5]/g)||[]).length;
  return total ? Math.min(1, dia / total) : 0;
}

// 4.8 旗舰版（板块三-4）：从作家范文提取风格 DNA，存入 state._styleDNA。
async function extractStyleDNA(text){
  if(!String(text||'').trim()) return null;
  try{
    const txt = unwrapAIResult(await callDeepSeek(STYLE_FINGERPRINT_SYS, text.slice(0, 15000), {maxTokens: clampMaxTokens('json'), temperature: 0.2, topP: 0.5, taskKey:'audit'}));
    const j = parseJson(txt) || {};
    const fp = {
      sentenceAvg: Number.isFinite(j.sentenceAvg) ? j.sentenceAvg : 22,
      dialogueRatio: Number.isFinite(j.dialogueRatio) ? j.dialogueRatio : 0.35,
      rhetoricDensity: Number.isFinite(j.rhetoricDensity) ? j.rhetoricDensity : null,
      lexicon: Array.isArray(j.lexicon) ? j.lexicon.map(s=>String(s).trim()).filter(Boolean).slice(0,20) : [],
      punctuation: (j.punctuation && typeof j.punctuation==='object') ? j.punctuation : {},
      forbiddenPhrases: Array.isArray(j.forbiddenPhrases) ? j.forbiddenPhrases.map(String) : [],
      preferredTransitions: Array.isArray(j.preferredTransitions) ? j.preferredTransitions.map(String) : [],
      rhythmNote: String(j.rhythmNote||'').trim() || '按风格 DNA 执行'
    };
    const exemplars = (Array.isArray(j.exemplars)?j.exemplars:[]).map(s=>String(s).trim()).filter(Boolean).slice(0,5);
    state._styleDNA = { fingerprint: fp, exemplars };
    // v1.0.133 提取 DNA 时同步回写风格契约（DNA 派生值），保证 user 提示词 L0 与 system 走 resolveStyleContract 拿到同一份契约，杜绝两路打架
    state.styleContract = dnaContract(fp);
    pushStyleHistory('风格指纹提取');
    persist();
    return state._styleDNA;
  }catch(e){ return null; }
}
// 取消确认风格：把该章移出「风格指纹提取来源」。安全，不改动已生成正文；仅影响后续指纹重建/契约卡 hasConfirmed。
function unconfirmChapterStyle(i){
  const c = state.chapters[i]; if(!c) return;
  c._styleConfirmed = false;
  pushStyleHistory('取消章节确认风格：第'+(i+1)+'章');
  // 取消后若契约正依赖该章，重建一次契约状态；如契约为空则一律回退重建，让契约卡真实反映当前来源
  if(state.styleContract){
    const fp = buildStyleFingerprintFromConfirmed();
    if(fp){ state.styleContract = fp; pushStyleHistory('取消确认后重建风格契约'); }
    else { state.styleContract = null; pushStyleHistory('已无确认章节，清除风格契约'); }
  }
  persist(); render();
  toast(`已取消第 ${i+1} 章的风格确认`);
}

// 4.5 用户确认风格：标记本章风格良好，作为风格指纹提取来源（仅功能按钮，不做样式美化）
function confirmChapterStyle(i){
  const c = state.chapters[i]; if(!c) return;
  c._styleConfirmed = true;
  state._scFallbackOff = false;   // 有了显式确认来源，恢复自动回退
  // 即时按下反馈：先把按钮切到「确认中…」，杜绝「按了没反应」的观感
  const btn = document.querySelector(`[data-style-ok="${i}"]`);
  if(btn){ btn.textContent = '🎨 确认中…'; btn.disabled = true; }
  extractStyleDNA(c.content).then(()=>{
    pushStyleHistory('章节确认风格：第'+(i+1)+'章');
    persist(); render();   // 强制全量渲染：按钮→「风格已确认」，风格契约卡「从已确认章节提取」同步亮起
    toast(`第 ${i+1} 章风格已确认：后续生成将自动提取风格指纹作为 L0 契约`);
  }).catch(()=>{
    pushStyleHistory('章节确认风格：第'+(i+1)+'章（指纹提取失败）');
    persist(); render();
    toast(`第 ${i+1} 章风格已确认（指纹提取失败，仍作为 L0 来源）`);
  });
}

// 风格历史：每次风格契约 / 风格指纹变更时留档快照（时间戳 + 触发来源 + 生效快照）
function pushStyleHistory(label, detail){
  state._styleHistory = state._styleHistory || [];
  state._styleHistory.push({
    ts: Date.now(),
    label: String(label || '风格变更'),
    detail: detail || null,
    styleContract: state.styleContract ? JSON.parse(JSON.stringify(state.styleContract)) : null,
    styleDNA: state._styleDNA ? JSON.parse(JSON.stringify(state._styleDNA)) : null
  });
  if(state._styleHistory.length > 30) state._styleHistory = state._styleHistory.slice(-30);
}

function openStyleHistoryPanel(){
  const hist = state._styleHistory || [];
  // v228/P2：修复面板打不开——fmtTs 此处无全局定义（其余 11 处均为各函数内局部量），点开即 ReferenceError；补一行同款本地实现（与 9085 行大纲历史面板格式一致）
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getFullYear())+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  if(!hist.length){ toast('暂无风格历史'); return; }
  const rows = hist.slice().reverse().map((h, ri)=>{
    const ridx = hist.length - 1 - ri;
    const sc = h.styleContract;
    const dna = h.styleDNA;
    const meta = [];
    if(sc) meta.push(`契约 · 句长${sc.sentenceAvg} / 对话${Math.round((sc.dialogueRatio||0)*100)}% / 禁用词${(sc.forbiddenPhrases||[]).length||0} / 转场${(sc.preferredTransitions||[]).length||0}`);
    if(dna && dna.fingerprint) meta.push(`指纹 · 句长${dna.fingerprint.sentenceAvg} / 对话${Math.round((dna.fingerprint.dialogueRatio||0)*100)}%`);
    if(h.detail) meta.push(h.detail);
    return `<div class="hist-item" style="padding:10px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;background:var(--panel)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${esc(h.label)}</b><span class="muted" style="font-size:11px">${fmtTs(h.ts)}</span></div>
      <div class="muted" style="font-size:12px;margin-top:4px">${meta.join('<br>') || '<span>无量化字段</span>'}</div>
      <button type="button" class="btn small ghost" data-sthist-snap="${ridx}" style="margin-top:6px">📥 应用到当前</button>
    </div>`;
  }).join('');
  openNeModal('🎨 风格历史', `<div class="hist-list">${rows}</div><p class="hint">每次「确认风格 / 提取指纹 / 设定契约 / 清除」都会自动留档。「应用到当前」会把该版契约与指纹覆盖为当前生效值（覆盖前会先把当前值自动留档）。</p>`);
  setTimeout(()=>{
    document.querySelectorAll('[data-sthist-snap]').forEach(b=>{
      b.onclick = ()=>{
        const h = state._styleHistory && state._styleHistory[+b.dataset.sthistSnap];
        if(!h) return;
        pushStyleHistory('恢复历史：'+h.label);
        if(h.styleContract) state.styleContract = JSON.parse(JSON.stringify(h.styleContract));
        if(h.styleDNA) state._styleDNA = JSON.parse(JSON.stringify(h.styleDNA));
        persist(); closeNeModal(); render(); toast('已应用历史版风格');
      };
    });
  }, 0);
}

// 4.5 风格指纹提取：从已确认章节自动提取风格契约（句长/对话比/禁用词/转场词）
function buildStyleFingerprintFromConfirmed(){
  // 优先从用户显式确认的章节提取
  const confirmed = (state.chapters||[]).filter(c => c && c._styleConfirmed && c.content);
  if(!confirmed.length) return null;
  const texts = confirmed.slice(-3).map(c => c.content);
  const full = texts.join('\n\n');
  const avg = avgSentenceLength(full);
  const dia = dialogueRatio(full);
  // 高频禁用词检测：统计常见 AI 套话出现次数
  const forbidden = ['嘴角勾起一抹冷笑','眼神一凛','眼底闪过','心中一震','冷冷道','淡淡道','缓缓道'];
  const found = forbidden.filter(p => full.includes(p));
  // 高频转场词
  const transitions = ['次日','第二天','三天后','夜里','清晨','傍晚','后来','与此同时'];
  const preferred = transitions.filter(t => full.includes(t));
  return {
    sentenceAvg: Math.round(avg) || 22,
    sentenceTolerance: 0.2,
    dialogueRatio: Math.round(dia*100)/100 || 0.3,
    dialogueTolerance: 0.1,
    forbiddenPhrases: found.length ? found : ['（暂无）'],
    preferredTransitions: preferred.length ? preferred.slice(0,5) : ['次日','后来'],
    rhythmNote: '基于已确认章节自动提取'
  };
}

/* =========================================================
 * 4.5 记忆与摘要层：滚动摘要（每 5 章 400 字，只保留最近 3 个区块）
 * ========================================================= */
const ROLLING_SUMMARY_SYS = `你是长篇小说滚动摘要助手。请把以下连续若干章的剧情压缩成一份 300-400 字的摘要，保留：主线推进、关键人物状态变化、未收束伏笔、情绪转折。不要细节描写，不要环境铺陈。`;

function buildRollingSummary(i){
  if(i <= 0) return '';
  const o = state.outline; if(!o) return '';
  // v228/P5：双层输出——L1 细（最近 10 章逐章纪要，堵住旧版 ch1–4 的记忆真空）+ L2 粗（更早章节的 5 章块，窗口扩到 30 章）。
  // 保持同步纯函数：补算全部由 ensureChapterDigests / generateRollingSummaries 负责，本函数只读不写。
  const digests = Array.isArray(o._chapterDigests) ? o._chapterDigests : [];
  const blocks  = Array.isArray(o._rollingSummaries) ? o._rollingSummaries : [];
  const near = [];
  for(let k = i-1; k >= Math.max(0, i-10); k--){
    if(digests[k] && digests[k].text) near.unshift(`第 ${k+1} 章：${digests[k].text}`);
  }
  const far = blocks.filter(s=>{
    const [a,b] = String(s.key||'').split('-').map(Number);
    return Number.isFinite(b) && b < i && b >= i - 30 && b < i - 10;
  }).map(s => `第 ${s.key} 章：${s.text}`).join('\n');
  return [far ? `【远期摘要】\n${far}` : '', near.length ? `【近期逐章纪要】\n${near.join('\n')}` : ''].filter(Boolean).join('\n\n');
}

// 4.8 旗舰版（板块一-1）：重写第 i 章后，失效所有覆盖该章的记忆层（滚动摘要/事实卡/章节 partial）
function invalidateChapterMemory(i){
  const o = state.outline; if(!o) return;
  // 滚动摘要：key 区间覆盖 i 则删除，下次 buildRollingSummary 会自动触发重算
  if(o._rollingSummaries){
    o._rollingSummaries = o._rollingSummaries.filter(s => {
      const [a,b] = String(s.key||'').split('-').map(Number);
      return !(a <= i+1 && b >= i+1);
    });
  }
  // 事实卡时间线按 ch 去重已在上层 updateFactCardFromChapter 保证；这里仅清理该章的流式缓存
  if(state._chapterPartial) delete state._chapterPartial[i];
  // v228/P5：逐章细摘要同步失效（重写后由 ensureChapterDigests 自动重算）
  if(Array.isArray(o._chapterDigests)) delete o._chapterDigests[i];
  // 4.8 旗舰版（板块二-4）：相关词典缓存失效
  if(o._relGlossCache){
    Object.keys(o._relGlossCache).forEach(k => { if(+k >= i) o._relGlossCache[k]._stale = true; });
  }
  persist();
  // v228/P5-⑤：剧情贴合软审计（仅 toast 提示、不阻断、不入修复队列；本函数 4 个调用点均在正文落库成功之后）
  auditChapterAdherence(i);
}

// v228/P5-⑤：剧情贴合软审计——节拍 event 的信息二元组在正文中的命中率，<60% 仅 toast 提示「可能跑偏」，
// 不阻断、不入修复队列（先观察误报率，后续可再收紧）。函数声明提升，供 invalidateChapterMemory 调用。
function auditChapterAdherence(i){
  try{
    const text = String((state.chapters && state.chapters[i] && state.chapters[i].content)||'');
    const plan = (state.outline && state.outline.chapterPlans && state.outline.chapterPlans[i]) || {};
    if(!text.trim() || !Array.isArray(plan.beats) || plan.beats.length < 4) return;
    const FUNC = /[的了是在和与也被把又就还着有个这那不上为到说得很]/;   // 滤掉含虚词的跨词二元组
    const kws = new Set();
    plan.beats.forEach(b=>{
      const ev = String((b && b.event)||'');
      (ev.match(/[\u4e00-\u9fa5a-zA-Z0-9]{2,10}/g)||[]).forEach(run=>{
        for(let p=0; p+1<run.length; p++){ const bg = run.slice(p, p+2); if(!FUNC.test(bg)) kws.add(bg); }
      });
    });
    if(kws.size < 6) return;   // 关键词太少不评估，避免小样本噪声
    let hit = 0; kws.forEach(w=>{ if(text.includes(w)) hit++; });
    const ratio = hit / kws.size;
    if(ratio < 0.6) toast(`⚠️ 第 ${i+1} 章剧情贴合度偏低（约 ${Math.round(ratio*100)}%），建议对照节拍表检查是否跑偏（仅提示，不阻断）`);
  }catch(e){ /* 软审计绝不影响主流程 */ }
}

// v228/P5：逐章细摘要（200-300 字/章）。与 5 章一块的粗摘要互补——粗块在第 5 章前完全缺位（旧版开头几章记忆真空，
// 正是「第三章开始乱来」的根因），细摘要从第 2 章起即有。失败静默、下次触发再续，绝不阻塞写作主流程。
const CHAPTER_DIGEST_SYS = `你是长篇小说剧情摘要助手。把这一章压缩成 200-300 字的剧情纪要：本章发生的事件、人物状态变化、新出现的人/物/设定、留下的伏笔。只记事实，不写景不抒情。`;
async function ensureChapterDigests(){
  const o = state.outline; if(!o) return;
  if(!Array.isArray(o._chapterDigests)) o._chapterDigests = [];
  const written = state.chapters.map((c,i)=> (c && c.content && String(c.content).trim()) ? i : -1).filter(i=>i>=0);
  for(const idx of written){
    if(o._chapterDigests[idx] && o._chapterDigests[idx].text) continue;
    try{
      const res = await callDeepSeek(CHAPTER_DIGEST_SYS, `第 ${idx+1} 章正文：\n` + String(state.chapters[idx].content||'').slice(0,6000),
        {maxTokens: clampMaxTokens('summary'), temperature: 0.3, topP: 0.5, taskKey:'rolling'});
      o._chapterDigests[idx] = { ts: Date.now(), text: String(res.text||'').trim().slice(0,400) };
      persist();
    }catch(e){ return; }   // 一次失败即退出，下次触发再续
  }
}

async function generateRollingSummaries(){
  ensureChapterDigests().catch(()=>{});   // v228/P5：细摘要与粗块同点触发（火后不管），既有 4 个调用点零改动
  const o = state.outline;
  if(!o) return;
  if(!o._rollingSummaries) o._rollingSummaries = [];
  const written = state.chapters.map((c,i) => (c && c.content && String(c.content).trim()) ? i : -1).filter(i => i >= 0);
  if(!written.length) return;
  const max = Math.max(...written) + 1;
  for(let end=5; end<=max; end+=5){
    const start = end - 4;
    const key = `${start}-${end}`;
    if(o._rollingSummaries.some(s => s.key === key)) continue;
    const bodies = state.chapters.slice(start-1, end).map(c => c.content).join('\n\n');
    // 4.8 旗舰版（P2）：滚动摘要生成器使用 AIBus.L4——把未收束伏笔作为参考注入，确保摘要不丢失关键事件
    const _l4 = AIBus.get('chapter', { idx: end-1 }).L4_context;
    const _hooks = (_l4 && Array.isArray(_l4.unresolvedHooks) && _l4.unresolvedHooks.length)
      ? '【未收束伏笔（摘要须保留相关线索）】\n' + _l4.unresolvedHooks.map(h=>h.text||'').join('、') + '\n\n' : '';
    try{
      const res = await callDeepSeek(ROLLING_SUMMARY_SYS, _hooks + bodies, {maxTokens: clampMaxTokens('summary'), temperature: 0.3, topP: 0.5, taskKey:'rolling'});   // 4.8 旗舰版（板块二-2/3）：摘要类窄采样 + 限长
      o._rollingSummaries.push({key, text: String(res.text||'').trim().slice(0,500)});
      persist();
    }catch(e){ /* 静默失败 */ }
  }
}
// 章节生成状态机：chState[i] = 'idle'|'generating'|'done'|'error'（健壮性契约）
const chState = {};
// 章节所在页数（建议3：每页 10 章），供渲染与跳转定位
let chPage = 0;
const CH_PAGE_SIZE = 10;

// 新卡片界面：章节状态徽章与操作按钮 HTML（供 renderChapters / patchChapter 复用）
function chapterBadgesHtml(i){
  const c = state.chapters[i] || {};
  const hasC = !!(c.content && String(c.content).trim());
  const partial = state._chapterPartial && state._chapterPartial[i];
  const partialW = partial ? countWords(String(partial).trim()).total : 0;
  const pc = state._personaCards || {};
  // 人设防火墙：统计本章被记录的矛盾条目数
  const personaViol = Object.values(pc).reduce((s,cd)=> s + ((cd.chapterTraits && Array.isArray(cd.chapterTraits[i])) ? cd.chapterTraits[i].length : 0), 0);
  const tension = (state._tensionCurve||[]).find(t=>t.ch===i);
  const tensionLow = tension && (tension.external<5 || tension.internal<5 || tension.mystery<5);
  const o = state.outline; const fs = (o && o._foreshadowLedger) || {};
  const fsDue = (fs.overdue||[]).some(x=>x.expectedCh===i);
  const parts = [];
  // 主状态
  if(chState[i]==='generating'){
    parts.push(`<span class="pill is-busy" data-ch-state><span class="spinner"></span>生成中${partialW?' · '+partialW.toLocaleString()+'字':''}</span>`);
  } else if(chState[i]==='error'){
    parts.push(`<span class="pill tag-warn" data-ch-state>⚠️ 生成失败</span>`);
  } else if(c._draft && String(c._draft).trim()){
    parts.push(`<span class="pill tag-warn" data-ch-state>⚠️ 草稿待审</span>`);
  } else if(c._qualityIssue){
    parts.push(`<span class="pill tag-warn" data-ch-state>✗ 校验失败</span>`);
  } else if(hasC){
    parts.push(`<span class="pill tag-ok" data-ch-state>✓ 已确认</span>`);
  } else {
    parts.push(`<span class="pill tag-warn" data-ch-state>未生成</span>`);
  }
  // 续写按钮
  if(partialW>=50 && chState[i]!=='generating'){
    parts.push(`<button class="btn small primary" data-ne-resume-ch="${i}" title="利用已缓存的 ${partialW.toLocaleString()} 字继续生成">▶️ 继续生成</button>`);
  }
  // 中间件状态徽章
  if(personaViol) parts.push(`<span class="pill tag-persona" title="发现 ${personaViol} 处人设矛盾">🛡️ ${personaViol}</span>`);
  if(tensionLow) parts.push(`<span class="pill tag-tension" title="本章张力低于目标值">📉 张力低</span>`);
  if(fsDue) parts.push(`<span class="pill tag-fs" title="本章承担伏笔回收任务">🪝 收束</span>`);
  return parts.join('');
}
function chapterExtraButtonsHtml(i){
  return `<button class="btn ghost" data-ne-sandbox-ch="${i}" title="在该章后推演多分支情节">🌿 沙盘</button>`;
}

// 定点刷新第 i 章卡片（健壮性契约：不整页 render，保留其它卡片/滚动位置/焦点）
function patchChapter(i){
  const card = document.querySelector('.ch-card[data-ch-card="'+i+'"]');
  if(!card) return;               // 该章不在当前页渲染范围，跳过 DOM（数据已落库，翻页即见）
  // 字数徽标
  const wc = card.querySelector('[data-wc-ch="'+i+'"]');
  if(wc) wc.innerHTML = wcBadge(state.chapters[i].content, `data-wc-ch="${i}"`);
  // 状态徽章 + 操作按钮整体刷新
  const statusWrap = card.querySelector('.ch-status-wrap[data-ch-status="'+i+'"]');
  if(statusWrap) statusWrap.innerHTML = chapterBadgesHtml(i);
  // textarea 值（焦点保护：正在编辑的不覆盖）
  const hasC = !!(state.chapters[i].content && state.chapters[i].content.trim());
  const body = card.querySelector('.ch-body');
  const ta = card.querySelector('textarea[data-ch="'+i+'"]');
  if(ta && !ta.matches(':focus')) ta.value = state.chapters[i].content;
  if(body && body.classList.contains('folded') && hasC){ body.classList.remove('folded'); }
  const ico = card.querySelector('.ch-fold-ico'); if(ico) ico.textContent = hasC ? '▾' : '▸';
  const re = card.querySelector('[data-regen="'+i+'"]');
  if(re){ re.disabled = !!state.generating; }
  // 本章梗概按钮 disabled 状态（正文生成后即亮起，无需刷新）
  const sum = card.querySelector('[data-ch-sum="'+i+'"]');
  if(sum){ sum.disabled = !hasC; }
  // 版本历史按钮文字（已有版本时更新计数）
  const ver = card.querySelector('[data-ver="'+i+'"]');
  if(ver){ ver.textContent = '📚 版本('+chVersions(i).length+')'; }
  // 撤销编辑按钮（正文生成后可能产生编辑历史）
  const undo = card.querySelector('[data-undo="'+i+'"]');
  if(undo){ undo.style.display = hasEditHistory(i) ? '' : 'none'; }
  // 标题文字 + 定稿/参考稿标记（正文 AI 回填后即时刷新，无需翻页）
  if(isLong() && state.chapters[i]){
    const h3 = card.querySelector('.ch-head h3');
    if(h3){
      const c = state.chapters[i];
      const titleTxt = `第${i+1}章 · ${esc(cleanChapterTitle(c.title))}`;
      h3.title = titleTxt;
      // 替换 h3 内部 HTML：标题文字 + 定稿标记
      let badgeHtml = '';
      if(c._titleByAI){
        badgeHtml = '<i class="tbd-title-tag" style="font-style:normal;font-size:11px;font-weight:400;opacity:.55;margin-left:6px" title="本章标题已由章节正文 AI 定稿">正文定稿</i>';
      } else if(!state.plannerFinalized){
        badgeHtml = '<i class="tbd-title-tag" style="font-style:normal;font-size:11px;font-weight:400;opacity:.55;margin-left:6px" title="标题尚未由全书规划师定稿，当前沿用第二步参考稿">参考稿</i>';
      }
      h3.innerHTML = titleTxt + badgeHtml;
    }
  }
}

// 重生成干预弹窗（建议3·此轮）：可任选「直接重生成」或「带人工建议重生成」
// v10.3：记录每次用户干预（regenHistory，每章独立、上限 10 条），下次打开可查看并点击回填。
function openChapterRegenPanel(i){
  closeChapterRegenPanel();
  const c = state.chapters[i];
  const title = c && c.title ? c.title : ('第'+(i+1)+'章');
  // 历史干预：仅用户手动重生成经过此弹窗，批量/首次生成不记录
  const hist = Array.isArray(c && c.regenHistory) ? c.regenHistory : [];
  const pushRegen = (mode, advice)=>{
    const h = Array.isArray(state.chapters[i].regenHistory) ? state.chapters[i].regenHistory : (state.chapters[i].regenHistory = []);
    h.push({ ts: Date.now(), mode, advice: String(advice||'') });
    if(h.length > 10) h.splice(0, h.length - 10);
    persist();
  };
  const pad = n => n<10?('0'+n):n;
  const histHtml = hist.length ? `
    <div class="rp-hist">
      <div class="rp-hist-title">📜 历史干预（点击回填到上方输入框）</div>
      ${hist.slice().sort((a,b)=>b.ts-a.ts).map(r=>{
        const d = new Date(r.ts);
        const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const txt = r.advice || '（直接重生成，无干预）';
        return `<div class="rp-hist-item" data-rp-fill="${esc(txt)}" title="${esc(txt)}">
          <span class="rp-hist-ts">${t}</span>
          <span class="rp-hist-txt">${esc(txt)}</span>
        </div>`;
      }).join('')}
    </div>` : '';
  // v2.0 本章风格覆盖 + 双风格对比的局部状态（一次性，不持久化）
  const rpOv = { on:false, tags:[] };
  const rpCmpB = { tags:[] };
  let rpOvApplied = null;     // 覆盖块「应用」确认快照 {on,tags,intensity}；null=未确认（未点应用则重生成不生效）
  let rpCmpBApplied = null;   // 对比块「应用」确认快照 {tags,intensity}；null=未确认（未点应用则 B 稿不生效）
  const ov = document.createElement('div');
  ov.id = 'regenPanel'; ov.className = 'gs-overlay';
  ov.setAttribute('data-cs', wsColorSchemeId());   // v10.19 让重生成弹窗内 chips 跟随所选配色
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🔄 重生成 · 第${i+1}章「${esc(cleanChapterTitle(title))}」</b>
        <button class="gs-x" data-rp-close>✕</button></div>
      <div class="gs-body">
        <p class="gs-q"><b>想如何改动这一章？</b> 可在下方填写你的具体要求（改动方向、补充设定、错误修正等）；留空则 AI 会直接审读本章正文给出点评建议。</p>
        <textarea id="rpAdvice" class="rp-advice" placeholder="可选：写具体要求（如压缩到1500字、女主性格外放、增加与上章衔接…）；留空则直接点评本章正文"></textarea>
        <div class="advice-ai-row">
          <button type="button" class="btn small ghost" data-advice-ai="${i}">✨ 正文优化建议</button>
          <button type="button" class="ai-upload-btn ai-hist-btn" data-advadv-hist="${i}" title="章节内容 AI 建议历史：回看已生成过的建议（随项目保存）">📖<span class="ai-hist-badge">${Array.isArray(state.contentAdviceHist)?state.contentAdviceHist.length:''}</span></button>
          <span class="muted" style="font-size:11px">AI 审读本章全文、上一章全文、下一章标题与万物词典给 1–3 条点评建议；点击即回填，可再手改</span>
        </div>
        <div data-advice-ai-out></div>
        ${histHtml}
        <div class="rp-style">
          <div class="rp-style-head" data-rpov-fold role="button" tabindex="0">
            <span>🎨 本章风格覆盖 <span class="rp-style-arrow">▸</span></span>
            <span class="muted" style="font-size:11px;font-weight:400">默认跟随全书 · 一次性不保存</span>
          </div>
          <div class="rp-style-body hidden">
           <div class="rp-ov-toggle" data-rpov-toggle>
  <span class="rp-ov-opt active" data-rpov-val="off">📖 全文</span>
  <span class="rp-ov-opt" data-rpov-val="on">🎨 仅本章</span>
</div>
            <div class="rp-style-sub hidden" id="rpOvBox">
              <div class="rp-style-label">覆盖风格（语气单选 · 质感/元素多选）</div>
              ${writeStyleChipsHtml(rpOv, 'rpov')}
              <div class="rp-apply-row">
                <button type="button" class="btn small primary" data-rpov-apply disabled title="确认本次覆盖风格，重生成时方才生效">✔ 应用</button>
                <span class="rp-apply-status" id="rpOvStatus">⚠️ 待应用</span>
              </div>
            </div>
          </div>
        </div>
        <div class="rp-style disabled" data-rpcmp-box>
          <div class="rp-style-head" data-rpcmp-fold role="button" tabindex="0">
            <span>⚡ 双风格对比生成 <span class="rp-style-arrow">▸</span></span>
            <span class="muted" style="font-size:11px;font-weight:400">需先开启上方本章覆盖</span>
          </div>
          <div class="rp-style-body hidden">
            <p class="rp-cmp-lock-hint">🔒 未开启「仅本章覆盖」时不可用；先在上一区选择「仅本章覆盖」以解锁。</p>
            <p class="muted" style="font-size:12px;margin:4px 0 8px">A 稿 = 本章覆盖风格；B 稿 = 下方所选（留空 = 无风格直白版）。</p>
            <div class="rp-style-label">B 稿对比风格</div>
            ${writeStyleChipsHtml(rpCmpB, 'rpcmp')}
            <div class="rp-apply-row">
              <button type="button" class="btn small primary" data-rpcmp-apply disabled title="确认 B 稿对比风格，再点上方按钮生成两稿">✔ 应用</button>
              <span class="rp-apply-status" id="rpCmpStatus">⚠️ 待应用 B 稿</span>
            </div>
            <button class="btn blue" data-rp-compare>⚡ 生成 A/B 两稿并对比</button>
          </div>
        </div>
      </div>
      <div class="gs-actions">
        <button class="btn" data-rp-plain>直接重生成（无干预）</button>
        <button class="btn primary" data-rp-with>💡 带我的建议重生成</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-rp-close]').onclick = closeChapterRegenPanelAll;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeChapterRegenPanelAll(); });
  // v2.1 对比区可用性：未开启「仅本章覆盖」→ 整区置灰锁定
  const rpCmpBox = ov.querySelector('[data-rpcmp-box]');
  const refreshRpCmpState = ()=>{
    if(!rpCmpBox) return;
    const locked = !rpOv.on;
    rpCmpBox.classList.toggle('disabled', locked);
    const hint = rpCmpBox.querySelector('.rp-cmp-lock-hint');
    if(hint) hint.style.display = locked ? 'block' : 'none';
    const head = rpCmpBox.querySelector('.rp-style-head .muted');
    if(head) head.textContent = locked ? '需先开启上方本章覆盖' : '两次调用 · 左右对照选稿';
  };
  // v2.0 折叠区开关
  const foldOv = ov.querySelector('[data-rpov-fold]');
  if(foldOv) foldOv.onclick = ()=>{
    const body = ov.querySelector('.rp-style-body'); if(!body) return;
    const on = body.classList.toggle('hidden');
    const arrow = foldOv.querySelector('.rp-style-arrow'); if(arrow) arrow.textContent = on?'▸':'▾';
  };
  const foldCmp = ov.querySelector('[data-rpcmp-fold]');
  if(foldCmp) foldCmp.onclick = ()=>{
    const body = foldCmp.closest('.rp-style').querySelector('.rp-style-body'); if(!body) return;
    const on = body.classList.toggle('hidden');
    const arrow = foldCmp.querySelector('.rp-style-arrow'); if(arrow) arrow.textContent = on?'▸':'▾';
  };
  // 默认折叠（与主线简述一致）：每次打开面板两块均折叠，箭头显示 ▸（模板已带 hidden，此处再次兜底）
  ov.querySelectorAll('.rp-style-body').forEach(b=> b.classList.add('hidden'));
  ov.querySelectorAll('.rp-style-arrow').forEach(a=> a.textContent = '▸');
  // v2.x 风格块「应用」：确认当前选择，生成只读已确认快照（模仿顶部风格卡「应用并保存」的草稿→生效语义）
  function refreshRpOvApply(){
    const ap = ov.querySelector('[data-rpov-apply]'); const st = ov.querySelector('#rpOvStatus');
    if(!ap) return;
    ap.disabled = !rpOv.on; ap.classList.toggle('disabled', !rpOv.on);
   if(st){ st.textContent = rpOvApplied ? '✔ 已确认' : (rpOv.on ? '⚠️ 待应用' : '全文，无需应用'); st.classList.toggle('ok', !!rpOvApplied); }
  }
  function refreshRpCmpApply(){
    const ap = ov.querySelector('[data-rpcmp-apply]'); const st = ov.querySelector('#rpCmpStatus');
    if(!ap) return;
    const locked = !rpOv.on;
    ap.disabled = locked; ap.classList.toggle('disabled', locked);
    if(st){ st.textContent = rpCmpBApplied ? '✔ 已确认 B 稿' : (locked ? '需先开启本章覆盖' : '⚠️ 待应用 B 稿'); st.classList.toggle('ok', !!rpCmpBApplied); }
  }
  const rpovApplyBtn = ov.querySelector('[data-rpov-apply]');
  if(rpovApplyBtn) rpovApplyBtn.onclick = ()=>{
    if(!rpOv.on) return;
    rpOvApplied = { on:true, tags: rpOv.tags.slice() };
    refreshRpOvApply();
    toast('本章风格覆盖已应用，重生成时生效（仅本次）');
  };
  const rpcmpApplyBtn = ov.querySelector('[data-rpcmp-apply]');
  if(rpcmpApplyBtn) rpcmpApplyBtn.onclick = ()=>{
    if(!rpOv.on) return;
    rpCmpBApplied = { tags: rpCmpB.tags.slice() };
    refreshRpCmpApply();
    toast('B 稿对比风格已应用，生成 A/B 两稿时生效');
  };
  // v2.0 本章覆盖：radio 切换 + chips + 浓度（任一改动后清空确认态，须重新点「应用」）
  ov.querySelectorAll('[data-rpov-val]').forEach(el=> el.onclick = ()=>{
  ov.querySelectorAll('[data-rpov-val]').forEach(x=> x.classList.remove('active'));
  el.classList.add('active');
  rpOv.on = el.dataset.rpovVal === 'on';
  rpOvApplied = null;
  const box = ov.querySelector('#rpOvBox'); if(box) box.classList.toggle('hidden', !rpOv.on);
  refreshRpCmpState();
  refreshRpOvApply(); refreshRpCmpApply();
});

  ov.querySelectorAll('[data-rpov-tag]').forEach(b=> b.onclick = ()=>{ toggleWriteTag(rpOv, b.dataset.rpovTag); ov.querySelectorAll('[data-rpov-tag]').forEach(x=> x.classList.toggle('on', rpOv.tags.includes(x.dataset.rpovTag))); rpOvApplied = null; refreshRpOvApply(); });
  // v2.0 对比 B 风格：chips（任一改动后清空确认态，须重新点「应用」）
  ov.querySelectorAll('[data-rpcmp-tag]').forEach(b=> b.onclick = ()=>{ toggleWriteTag(rpCmpB, b.dataset.rpcmpTag); ov.querySelectorAll('[data-rpcmp-tag]').forEach(x=> x.classList.toggle('on', rpCmpB.tags.includes(x.dataset.rpcmpTag))); rpCmpBApplied = null; refreshRpCmpApply(); });
  // 生成按钮：携带「已应用」的本章覆盖（未应用则不生效，回归全书风格）
  ov.querySelector('[data-rp-plain]').onclick = ()=>{
    const btn = document.querySelector('[data-regen="'+i+'"]');
    closeChapterRegenPanel();
    pushRegen('plain','');
    const ovr = rpOvApplied ? { styleOverride: { tags: rpOvApplied.tags.slice() } } : {};
    if(rpOv.on && !rpOvApplied) toast('已按全书风格重生成（未点「✔ 应用」的覆盖不生效）');
    genOneChapter(i, btn, ovr);
  };
  ov.querySelector('[data-rp-with]').onclick = ()=>{
    const advice = $('#rpAdvice').value.trim();
    const btn = document.querySelector('[data-regen="'+i+'"]');
    closeChapterRegenPanel();
    pushRegen('advice', advice);
    const ovr = rpOvApplied ? { advice, styleOverride: { tags: rpOvApplied.tags.slice() } } : { advice };
    if(rpOv.on && !rpOvApplied) toast('已按全书风格重生成（未点「✔ 应用」的覆盖不生效）');
    genOneChapter(i, btn, ovr);
  };
  // 对比生成：A/B 均须先「应用」确认，未确认则提示
  ov.querySelector('[data-rp-compare]').onclick = ()=>{
    if(!rpOvApplied){ toast('请先在「🎨 本章风格覆盖」点「✔ 应用」确认 A 稿风格'); return; }
    if(!rpCmpBApplied){ toast('请先在「⚡ 双风格对比」点「✔ 应用」确认 B 稿风格'); return; }
    const btn = document.querySelector('[data-regen="'+i+'"]');
    const styleA = { tags: rpOvApplied.tags.slice() };
    closeChapterRegenPanel();
    genChapterCompare(i, styleA, { tags: rpCmpBApplied.tags.slice() });
  };
  refreshRpCmpState();   // v2.1 初始即按「跟随全书」置灰对比区
  // 历史条目点击回填
  ov.querySelectorAll('[data-rp-fill]').forEach(el=>{
    el.onclick = ()=>{
      const ta = $('#rpAdvice'); if(ta) ta.value = el.dataset.rpFill;
      el.classList.add('rp-fill-on');
      ta && ta.focus();
    };
  });
  const ta = $('#rpAdvice'); if(ta) ta.focus();
  // v1.0.60 AI 提炼优化：触发生成 + 候选点击回填并聚焦
  const aiBtn = ov.querySelector('[data-advice-ai]');
  if(aiBtn) aiBtn.onclick = ()=>{ aiRefineAdvice(i); };
  const advH = ov.querySelector('[data-advadv-hist]');
  if(advH) advH.onclick = ()=> openAdvHistPanel('content');   // v10.59 章节内容 AI 建议历史
  ov.addEventListener('click', e=>{
    const t = e.target.closest('[data-advice-ai-pick]'); if(!t) return;
    const j = +t.dataset.adviceAiPick;
    const a = Array.isArray(aiAdviceCand) ? aiAdviceCand[j] : null; if(!a) return;
    const ta2 = $('#rpAdvice'); if(ta2){ ta2.value = a.text || ''; ta2.focus(); }
    ov.querySelectorAll('[data-advice-ai-pick]').forEach((el,k)=> el.classList.toggle('on', k===j));
  });
}
function closeChapterRegenPanel(){ const p=$('#regenPanel'); if(p) p.remove(); }

/* ---------- v1.0.60 AI 提炼优化建议（仅重生成弹窗内） ---------- */
let aiAdviceCand = null;   // {title,text}[] 候选，模块级；关闭弹窗不保留（closeChapterRegenPanel 会一并清）
function closeChapterRegenPanelAll(){ closeChapterRegenPanel(); aiAdviceCand = null; }
// 提炼 AI 所需的当前章节基础状态（上下文）
function buildAiRefineCtx(i){
  const o = state.outline || {};
  const chap = state.chapters[i] || {};
  const prev = i>0 ? (state.chapters[i-1]||{}) : null;
  const st = curWriteStyle();
  const chapNames = (Array.isArray(st.tags)?st.tags:[]).map(id=>{ const s=writeStyleById(id); return s&&s.group==='element'?s.name:null; }).filter(Boolean).join('、');
  // 万物词典全量（人物全字段 / 地点 / 专名）
  const g = (o && o.glossary) || {};
  const dictChars = (g.characters||[]).map(c=>{
    const parts=[];
    if(c.identity) parts.push('身份:'+c.identity);
    if(c.age) parts.push('年龄:'+c.age);
    if(c.gender) parts.push('性别:'+c.gender);
    if(c.appearance) parts.push('外貌:'+c.appearance);
    if(c.hobby) parts.push('爱好:'+c.hobby);
    if(c.relation) parts.push('关系:'+c.relation);
    if(c.trait) parts.push('性格:'+c.trait);
    return (c.name||'')+(parts.length?'（'+parts.join('；')+'）':'');
  }).join('；');
  const dictPlaces = (g.places||[]).map(p=>`${p.name||''}${p.note?`（${p.note}）`:''}`).join('；');
  const dictProps  = (g.propernouns||[]).map(p=>`${p.name||''}${p.note?`（${p.note}）`:''}`).join('；');
  return {
    书名: (o.title||''), 简介: (o.logline||''),
    本章标题: (chap.title||('第'+(i+1)+'章')),
    本章全文: (chap.content||''),   // 续写/扩写需全文，原样提供
    上一章标题: prev ? (prev.title||('第'+i+'章')) : '',
    上一章全文: (prev && prev.content) ? String(prev.content) : '',   // 上一章全文全量
    下一章标题: (o.chapters[i+1]&&o.chapters[i+1].title)||'',
    万物词典: `人物：${dictChars||'（无）'}\n地点：${dictPlaces||'（无）'}\n专名：${dictProps||'（无）'}`,
    当前写作风格: chapNames || '无'
  };
}
function aiRefineAdvicePrompt(ctx, raw){
  const _raw = String(raw||'').trim();
  return { system:[
    '你是资深网文长篇编辑。用户在建议框里可能写了一段补充要求（续写、扩写、改段落、修正称呼错别字等），也可能留空、只是想听你对本章正文的专业点评。',
    '请审读给出的【本章全文】【万物词典】【上下文】，输出 1–3 条建议（至少 1 条、最多 3 条）；每条 = { title(一句话定位本条侧重), text(完整点评 + 可直接下发给章节生成 AI 的可执行命令) }。',
    '【允许"无建议"】若本章已写得很稳、没有真正值得动的地方，就只返回 1 条：{"title":"无建议","text":"本章整体稳定，暂不建议改动。"}——宁缺毋滥，绝不为了凑满条数硬找问题或胡说八道。',
    '【点评要点】节奏是否拖沓或太赶、对白是否有辨识度与推进力、悬念与留白是否给足、人物言行是否与万物词典中的身份/性格/关系一致（有无OOC）、是否承接上一章结尾、是否为下一章（'+ (ctx.下一章标题||'') +'）留好引子、与万物词典命名/设定是否冲突。',
    '【有补充要求时】先满足用户要求（'+ (_raw? _raw.slice(0,120)+'…' : '（用户未给出方向）') +'）的角度，再在该方向之外综合点评；要求为空时直接审读本章正文点评。',
    '【可执行】text 用对章节 AI 说的祈使句，明确范围与幅度，可行时用换行拆 2–3 个可独立启用的子要点；续写/扩写必须承接本章与上一章结尾、不越界到下一章；不臆造万物词典外的新名。',
    '输出仅一个 JSON 数组（1–3 项），无任何讲解、无 markdown 代码块前后缀。每项结构：{ "title":"一句话说明本条侧重什么", "text":"完整点评+可执行命令" }'
    ].join('\n'),
    user: JSON.stringify({ 上下文: ctx, 用户原始要求: (_raw||'(无)') }, null, 1) };
}
async function aiRefineAdvice(i){
  const ta = $('#rpAdvice'); if(!ta) return;
  const raw = ta.value.trim();   // 可空：无补充要求也能生成点评
  const out = $('[data-advice-ai-out]');
  if(out) out.innerHTML = `<p class="muted" style="margin:6px 0 0">⏳ AI 正审读本章正文并给出优化建议…</p>`;
  const btn = $('[data-advice-ai]'); if(btn){ btn.disabled = true; btn.textContent = '生成中…'; }
  try{
    const ctx = buildAiRefineCtx(i);
    const {system, user} = aiRefineAdvicePrompt(ctx, raw);
    const res = unwrapAIResult(await callDeepSeek(system, user, {temperature:0.6, topP:0.5, maxTokens:clampMaxTokens('json'), taskKey:'contentAdvice'}));   // 4.8 旗舰版（板块二-2/3）：建议类 JSON 窄采样 + 限长
    const list = parseAiJsonList(res);
    const ls = Array.isArray(list) ? list.filter(x=> x && String(x.text||'').trim()) : [];
    if(!ls.length) throw new Error('AI 未返回有效建议，请重试');
    // 单条"无建议"标记 → 只提示，不强制造可选择回填项
    if(ls.length===1 && /无建议/.test(String(ls[0].title||'')+' '+String(ls[0].text||''))){
      aiAdviceCand = null;
      if(out) out.innerHTML = `<p class="muted" style="margin:6px 0 0">💡 ${esc(String(ls[0].text||'本次无建议，正文暂无需改动。').trim())}</p>`;
      if(btn){ btn.disabled = false; btn.textContent = '✨ 正文优化建议'; }
      return;
    }
    aiAdviceCand = ls.slice(0,3);
    // v10.59 生成成功即存项目快照（随项目保存，关弹窗/切页不丢）
    const _ch = state.chapters[i] || {};
    addAdvHist('content', { id: aiHistEntryId(), ts: Date.now(), desc: '正文优化建议 · 第'+(i+1)+'章', list: JSON.parse(JSON.stringify(ls.slice(0,3))) });
    refreshAdvHistBadge('content');
  }catch(e){
    aiAdviceCand = null;
    if(out) out.innerHTML = `<p class="muted" style="color:var(--danger);margin:6px 0 0">⚠️ ${esc((e&&e.message)||'生成失败')}</p>`;
  }
  if(out) out.innerHTML = aiAdviceResultHtml();
  if(btn){ btn.disabled = false; btn.textContent = '✨ 正文优化建议'; }
}
function aiAdviceResultHtml(){
  if(!Array.isArray(aiAdviceCand) || !aiAdviceCand.length) return '';
  return aiAdviceCand.map((a,ai)=>`
    <div class="advice-ai-cand" data-advice-ai-pick="${ai}">
      <div class="advice-ai-head">
        <span class="advice-ai-idx">${'①②③'[ai]||(ai+1)}</span>
        <b>${esc(a.title||('方案'+(ai+1)))}</b>
        <button type="button" class="advice-ai-use">✔ 采用</button>
      </div>
      <p>${esc(a.text||'')}</p>
    </div>`).join('');
}

/* ---------- v2.0 双风格对比生成：A=当前生效风格 / B=所选对比风格，两次调用后左右对照选稿 ---------- */
async function genChapterCompare(i, styleA, styleB){
  const c = state.chapters[i]; if(!c) return;
  const btn = document.querySelector('[data-regen="'+i+'"]');
  chState[i] = 'generating'; state.generating = true; patchChapter(i);
  if(btn) busy(btn,true,'对比生成中…');
  const st = $('#chStatus');
  const setPhase = m => { if(st){ st.className='status'; st.textContent = `第 ${i+1}/${state.chapters.length} 章：${m||''}`; } };
  try{
    const user = buildChapterUser(i, {regenerating:true});
    setPhase('生成 A 稿（当前风格）…');
    const txtA = await writeOneChapterContent(i, user, setPhase, null, styleA);
    setPhase('生成 B 稿（对比风格）…');
    const txtB = await writeOneChapterContent(i, user, setPhase, null, styleB);
    chState[i] = 'done';
    openComparePanel(i, txtA, txtB);
    if(st){ st.className='status ok'; st.textContent = `第 ${i+1} 章双风格对比稿已生成，请在弹窗中选择采用。`; }
    toast('两稿已生成，请选择采用');
  }catch(e){
    chState[i] = 'error'; patchChapter(i);
    if(st){ st.className='status err'; st.textContent = '对比生成失败：'+e.message; }
    toast('对比生成失败：'+e.message);
  }finally{
    state.generating = false;
    if(btn) busy(btn,false);
    patchChapter(i);
  }
}
// 对比结果弹窗：左右两栏（复用 .qc-pair）+ 采用 A/B + 未采用稿与旧正文一并入版本历史
function openComparePanel(i, a, b){
  closeComparePanel();
  const c = state.chapters[i];
  const title = c && c.title ? c.title : ('第'+(i+1)+'章');
  const ov = document.createElement('div'); ov.id='cmpPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>⚡ 双风格对比 · 第${i+1}章「${esc(cleanChapterTitle(title))}」</b>
        <button class="gs-x" data-cmp-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-div">A 稿 = 当前生效风格；B 稿 = 对比风格。采用后，未采用稿会连同旧正文一起存入版本历史（📚 版本 可回退）。</div>
        <div class="qc-pair">
          <div class="qc-side"><div class="qc-side-t">A 稿 · 当前生效风格（${countWords(a).total} 字）</div><div class="qc-pre cmp-pre">${esc(a)}</div></div>
          <div class="qc-side"><div class="qc-side-t">B 稿 · 对比风格（${countWords(b).total} 字）</div><div class="qc-pre cmp-pre">${esc(b)}</div></div>
        </div>
        <div class="gs-actions" style="margin-top:10px">
          <button class="btn primary" data-cmp-use="a">✔ 采用 A 稿</button>
          <button class="btn primary" data-cmp-use="b">✔ 采用 B 稿</button>
          <button class="btn" data-cmp-close>暂不采用（两稿都存历史）</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelectorAll('[data-cmp-close]').forEach(b=> b.onclick = closeComparePanel);
  ov.addEventListener('click', e=>{ if(e.target===ov) closeComparePanel(); });
  ov.addEventListener('click', e=>{
    const u = e.target.closest('[data-cmp-use]'); if(!u) return;
    const isA = u.dataset.cmpUse === 'a';
    const pick = isA ? a : b;
    const other = isA ? b : a;
    snapshotChapterVersion(i);                    // 旧正文入历史
    const ch = ensureChapterHistory(i);
    ch.content = pick;
    if(other && String(other).trim()) ch.history.push({ content: other, ts: Date.now() });   // 未采用稿也入历史备查
    if(ch.history.length > 50) ch.history.splice(0, ch.history.length - 50);
    persist(); closeComparePanel(); renderChapters(); updateWcTotal();
    toast('已采用 '+(isA?'A':'B')+' 稿');
  });
}
function closeComparePanel(){ const p=$('#cmpPanel'); if(p) p.remove(); }

// 单章生成（🔄 重生成，决策5：只重写目标章，注入上章结尾+下章概要+全局词典）
// opt.advice：可选的人工干预要求（建议3·此轮），随 buildChapterUser 注入模型
// opt.styleOverride：可选的本章风格覆盖 {tags,intensity}（v2.0：仅本章生效，一次性消费）
async function genOneChapter(i, btn, opt={}){
  chState[i] = 'generating'; state.generating = true; patchChapter(i);
  if(btn) busy(btn,true,'生成中…');
  // 显示停止按钮：放在「阅读」按钮右侧
  const stopParent = btn && btn.closest('.btn-row') ? btn.closest('.btn-row') : null;
  if(stopParent){
    if(!_abortBtn){ _abortBtn = makeStopBtn(); document.body.appendChild(_abortBtn); }
    _abortCtl = new AbortController();
    _abortBtn.style.display = '';
    const readBtn = stopParent.querySelector(`[data-read="${i}"]`);
    if(readBtn && readBtn.nextSibling){
      stopParent.insertBefore(_abortBtn, readBtn.nextSibling);
    } else {
      stopParent.appendChild(_abortBtn);
    }
  }
  // 进度区：与「一键批量生成」同源。单章也在此实时显示「第几章 + 当前阶段」。
  const st = $('#chStatus');
  const setPhase = msg => { if(st){ st.className='status'; st.textContent = `第 ${i+1}/${state.chapters.length} 章：${msg||''}`; } };
  setPhase('准备中…');
  let _fullContent = '';
  try{
    const user = buildChapterUser(i, {regenerating:true, advice:opt.advice, styleOverride: opt.styleOverride});   // v2.4 本章覆盖时 user 风格重申同步
    // 实时进度：流式内容实时推送到文本区
    const stStream = $('#chStatus');
    let _s = 0;
    const onStream = currentIsDeepSeek() ? (delta => {
      const d = String(delta||'');
      _s += d.length; _fullContent += d;
      if(stStream){ stStream.className='status'; stStream.textContent = `第 ${i+1}/${state.chapters.length} 章：撰写中 · 已生成 ${_s} 字`; }
      // 实时推送内容到文本区
      const ta = document.querySelector(`textarea[data-ch="${i}"]`);
      if(ta){ ta.value = _fullContent; ta.scrollTop = ta.scrollHeight; }
      // 新卡片界面：刷新状态徽标实时字数
      patchChapter(i);
    }) : null;
    const txt = await writeOneChapterContent(i, user, setPhase, onStream, opt.styleOverride);   // 各阶段经 setPhase 上报，正文流式实时字数经 onStream；v2.0 支持本章风格覆盖
    // ★ 保存原始 AI 响应到 state，供手动提取
    if(!state._lastChapterRaw) state._lastChapterRaw = {};
    if(_chRawBuf && _chRawBuf.i === i){ state._lastChapterRaw[i] = _chRawBuf.raw; _chRawBuf = null; persist(); }
    // v225/附1（方案 A）：单章路径接入同口径后验质检，与批量路径一致——失败落 _draft + 修复队列并阻断
    const _qc = await validateChapterContent(i, txt);
    if(!_qc.ok){
      state.chapters[i]._draft = txt; state.chapters[i]._qualityIssue = _qc;
      state._fixQueue = state._fixQueue || [];
      if(!state._fixQueue.find(x=>x.ch===i)) state._fixQueue.push({ ch:i, code:_qc.code, errors:_qc.errors, attempts:1, ts:Date.now() });
      persist(); patchChapter(i);
      throw new Error(`第 ${i+1} 章校验未通过：${_qc.errors.join('；')}`);
    }
    snapshotChapterVersion(i);            // v7.2：覆盖前存旧版，支持回退
    state.chapters[i].content = txt;
    // 4.8 旗舰版（板块一-1）：单章重写成功后失效旧记忆层
    invalidateChapterMemory(i);
    chState[i] = 'done';
    if(!isLong()) state.chapters[i].confirmed = false;
    persist();                       // 不整页 render，仅定点刷新
    patchChapter(i);
    if(st){ st.className='status ok'; st.textContent = `第 ${i+1} 章已生成。`; }
    toast('第'+(i+1)+'章完成');
    // 4.8 旗舰版（板块一-1）：单章重写后异步补齐滚动摘要，确保记忆层基于新正文
    generateRollingSummaries().catch(()=>{});
  }catch(e){
    if(e.name==='AbortError'){ if(st) st.textContent = '第'+(i+1)+'章已停止生成'; }
    else { chState[i] = 'error'; patchChapter(i); if(st){ st.className='status err'; st.textContent = '第'+(i+1)+'章生成失败：'+e.message; } toast('第'+(i+1)+'章生成失败：'+e.message); }
  }
  finally{ hideStopBtn(); state.generating = false; if(btn) busy(btn,false); patchChapter(i); extractGlossaryFromChapter(i); autoExtractGlossary(); autoUpdateSubplots(); }   // v225/P2/P5：逐章提取入典 + 全量兜底；正文回填标题已取消
}

// 一次写 2 章（v10）：由「一次请求连写两章再切分」改为逐章顺序生成——每章独立一个请求，
// 第 k 章用「上一章」刚生成的（或此前已写）真实正文承接，产出即章节，无需【第N章】切分，杜绝两章挤一格/错切。
// 章节定位契约（统一编号）在 buildChapterUser 内体现；恒定的词典/内容块/章节定位随每章完整注入。
async function genTwoChapters(pairStart){
  for(let k=0;k<2;k++){
    const idx = pairStart + k;
    // 每章完整上下文：词典+内容块（梗概/风格/边界）+ 上一章真实正文
    let _s2 = 0; let _full2 = '';
    const onStream = currentIsDeepSeek() ? (delta => {
      const d = String(delta||'');
      _s2 += d.length; _full2 += d;
      state._chapterPartial[idx] = _full2;   // 4.8 旗舰版（板块一-3）：流式中断续写缓存
      const ta = document.querySelector(`textarea[data-ch="${idx}"]`);
      if(ta){ ta.value = _full2; ta.scrollTop = ta.scrollHeight; }
      patchChapter(idx);
    }) : null;
    const txt = await writeOneChapterContent(idx, buildChapterUser(idx), null, onStream);
    // v225/附1（方案 A）：与批量/单章路径同口径质检（注：genTwoChapters 当前无调用入口，保留同步改造以防复用）
    const _qc2 = await validateChapterContent(idx, txt);
    if(!_qc2.ok){
      state.chapters[idx]._draft = txt; state.chapters[idx]._qualityIssue = _qc2;
      state._fixQueue = state._fixQueue || [];
      if(!state._fixQueue.find(x=>x.ch===idx)) state._fixQueue.push({ ch:idx, code:_qc2.code, errors:_qc2.errors, attempts:1, ts:Date.now() });
      persist(); patchChapter(idx);
      throw new Error(`第 ${idx+1} 章校验未通过：${_qc2.errors.join('；')}`);
    }
    snapshotChapterVersion(idx);            // v7.2：覆盖前存旧版，支持回退
    state.chapters[idx].content = txt;
    // 4.8 旗舰版（板块一-1）：重写成功后失效旧记忆层
    invalidateChapterMemory(idx);
  }
  extractGlossaryFromChapter(pairStart); extractGlossaryFromChapter(pairStart+1);   // v225/P2：两章正文落库即提取入典（fire-and-forget）
  generateRollingSummaries().catch(()=>{});   // v228/P5：两章路径同样触发记忆层补齐（与其他生成路径口径一致）
}

// 一次写 n 章（4.5 改造：每章生成后检查 finishReason；validateChapterContent 后验校验；
// 失败时自动重试 1 次并携带修正指令；连续失败 2 次则停批并标 error）。
async function genNChapters(start, n){
  if(n <= 0) return;
  // 4.8 旗舰版（P1）：正文 AI 运行态标记（正文保持「可跳过规划师」的既有弹性，不做硬拓扑拦截）
  markAIRunning('chapter');
  try{
  for(let k=0; k<n; k++){
    const idx = start + k;
    if(!isLong() && state.chapters[idx] && state.chapters[idx].content && String(state.chapters[idx].content).trim() && state.chapters[idx].confirmed) continue;
    let attempt = 0;
    let lastReport = null;
    let txt = '', finishReason = '';
    // 4.8 旗舰版（板块一-3）：若本章节流式中断残留 partial，优先续写
    const resumePartial = (state._chapterPartial && state._chapterPartial[idx]) || '';
    if(resumePartial.length >= 200){
      try{
        txt = await continueTruncatedChapter(idx, '', resumePartial);
        delete state._chapterPartial[idx];
        finishReason = 'stop';
      }catch(e){ /* 续写失败则走正常流程 */ }
    }
    while(attempt < 2){
      attempt++;
      try{
        // 4.8 旗舰版（板块一-3）：若已通过 resumePartial 续写，第一次 attempt 直接走落库校验，不再请求 AI
        if(!(resumePartial.length >= 200 && txt && finishReason === 'stop')){
          let _fullN = '', _finishReason = '';
          const onStream = currentIsDeepSeek() ? (delta => {
            const d = String(delta||''); _fullN += d;
            state._chapterPartial[idx] = _fullN;   // 4.8 旗舰版（板块一-3）：流式中断续写缓存
            const ta = document.querySelector(`textarea[data-ch="${idx}"]`);
            if(ta){ ta.value = _fullN; ta.scrollTop = ta.scrollHeight; }
            patchChapter(idx);
          }) : null;
          // 4.5：重试时把上一轮校验报告作为修正指令注入（经 opt.advice 通道）
          const _fix = state._chapterRetryFix ? `【上一轮生成校验未通过，必须修正以下问题】\n${state._chapterRetryFix}` : '';
          const _userOpt = _fix ? { advice: _fix } : {};
          const _dyn = dynamicChapterParams(idx);
          if(isLong()){
            const res = await callDeepSeek(longChapterSys(), buildChapterUser(idx, _userOpt), {maxTokens: chapterMaxTokens(), onStream, temperature: _dyn.temperature, topP: _dyn.topP, signal: _abortCtl?.signal, taskKey:'chapter'});
            txt = res.text; finishReason = res.finishReason;
          } else {
            const res = await callDeepSeek(PROMPTS.chapterSys + specSysAddition() + '\n\n' + ORIGINALITY_CHAPTER_SYS + chapterStyleNote(), buildChapterUser(idx, _userOpt), {maxTokens: chapterMaxTokens(), temperature: _dyn.temperature, topP: _dyn.topP, signal: (_abortCtl && _abortCtl.signal), taskKey:'chapter'});
            txt = res.text; finishReason = res.finishReason;
          }
          _chRawBuf = { i:idx, raw: txt, ts: Date.now() };
          // 截断检测
          if(finishReason === 'length'){
            txt = await continueTruncatedChapter(idx, txt);
            finishReason = 'stop';
          }
        }
        const content = String(txt||'').trim();
        // 后验校验
        const report = await validateChapterContent(idx, content);
        if(report.ok){
          snapshotChapterVersion(idx);
          // 4.8 旗舰版（板块一-4）：校验通过，草稿转正（如有旧失败草稿）
          if(state.chapters[idx]._draft) delete state.chapters[idx]._draft;
          delete state.chapters[idx]._qualityIssue;
          state.chapters[idx].content = content;
          if(!isLong()) state.chapters[idx].confirmed = false;
          delete state._chapterPartial[idx];   // A：校验通过即清流式缓存，避免已完成章残留"可续写"态
          state._chapterRetryFix = '';
          persist();
          // 4.6 Plus（2.4）：每章生成成功后自动更新事实卡
          updateFactCardFromChapter(idx, content);
          // 4.8 旗舰版（板块三-3）：评估并记录本章张力曲线
          scoreChapterTension(idx, content);
          // 4.8 旗舰版（板块一-1）：重写成功后失效旧记忆层，避免后续章节基于旧世界续写
          invalidateChapterMemory(idx);
          chState[idx] = 'done';
          patchChapter(idx);
          extractGlossaryFromChapter(idx);   // v225/P2：正文落库即提取入典（fire-and-forget，新实体 7 字段自动齐全）
          break;
        } else {
          // 4.6 Plus（2.8）：加入修复队列而不是立即重试（避免 4.5 静默自动重试导致的循环扣费）
          lastReport = report;
          state._fixQueue = state._fixQueue || [];
          const exist = state._fixQueue.find(x => x.ch === idx);
          if(!exist){
            state._fixQueue.push({ ch:idx, code:report.code, errors:report.errors, attempts:1, ts:Date.now() });
          } else {
            exist.attempts++; exist.ts = Date.now();
          }
          // 4.8 旗舰版（板块一-4）：失败正文写入 _draft，不污染正式 content，阻断级联错误
          snapshotChapterVersion(idx);
          state.chapters[idx]._draft = content;
          if(!isLong()) state.chapters[idx].confirmed = false;
          state.chapters[idx]._qualityIssue = report;
          state._chapterRetryFix = '';
          persist();
          // v226/8.1-c：质检失败章（_draft）零入典——不挂载任何提取，正文未转正前词典不得新增
          chState[idx] = 'error';
          patchChapter(idx);
          attempt = 2;   // 4.6 Plus：不自动重试，终止 while 链（throw 后由 catch 上抛）
          throw new Error(`第 ${idx+1} 章校验未通过：${report.errors.join('；')}`);
        }
      }catch(e){
        // 4.8 旗舰版（板块一-3）：resume 内容校验未通过，清空后让第二次 attempt 正常重生成
        if(resumePartial.length >= 200 && attempt === 1 && txt && finishReason === 'stop'){
          txt = ''; finishReason = '';
          continue;
        }
        if(attempt >= 2){
          chState[idx] = 'error';
          patchChapter(idx);
          throw e;
        }
      }
    }
  }
  // v225/P5-C：正文回填标题已取消；批次完成后异步补全滚动摘要（静默失败，不阻塞批次流程）
  generateRollingSummaries().catch(()=>{});
  }finally{
    // 4.8（6.4）：正文批次结束——清理运行态并标记完成（部分章节失败由 4.6 Plus 修复队列兜底）
    state.aiNetwork.running = (state.aiNetwork.running||[]).filter(k=>k!=='chapter');
    state.aiNetwork.completed = Array.from(new Set([...(state.aiNetwork.completed||[]), 'chapter']));
    persist();
  }
}

// 4.5：截断章节续写（拼接与去重：续写开头与前文末尾重复超 20 字则去重后拼接）
// 4.8 旗舰版（板块一-3）：新增 resumeFrom 模式——传入已生成 partial，从中断处无缝继续
async function continueTruncatedChapter(i, firstPart, resumeFrom){
  const full = resumeFrom ? String(resumeFrom||'') : String(firstPart||'');
  const tail = full.slice(-800);
  const user = `【前文末尾（${resumeFrom ? '已生成但尚未落库的草稿尾部' : '被截断'}）】\n${tail}\n\n【续写要求】\n从上文中断处无缝继续，不要重复任何已有内容，不要重新开头。保持与原文一致的叙事节奏、人物称谓和风格。`;
  let secondPartial = '';
  const res = await callDeepSeek(longChapterSys(), user, {maxTokens: clampMaxTokens('continue'), taskKey:'chapter', onStream: (delta)=>{
    // 4.8 旗舰版（板块一-3）：续写时 partial 应包含前文完整内容 + 新生成内容，避免再次中断后丢失前文
    secondPartial += delta;
    state._chapterPartial[i] = full + secondPartial;
  }, temperature: dynamicChapterParams(i).temperature, topP: dynamicChapterParams(i).topP, signal: _abortCtl?.signal});
  let second = String(res.text||'').trim();
  // 去重：如果续写开头与前文末尾重复
  const lcp = longestCommonPrefix(tail, second);
  if(lcp.length > 20) second = second.slice(lcp.length).trim();
  return resumeFrom ? (full + '\n' + second) : (firstPart + '\n' + second);
}
// A：独立入口「继续生成 / 从中断处继续 / 流式续写」的统一交接封装。
// 之前这些按钮直接调用 continueTruncatedChapter 却丢弃返回值、不落库、无反馈，导致"点了没反应"。
// 本封装：读取缓存 → 置生成态 → 续写 → 落库/清缓存/收尾清理，失败保留缓存可再次续写。
async function continueAndFinalizeChapter(i, sourceNote){
  const partial = (state._chapterPartial && state._chapterPartial[i]) || '';
  if(!partial || String(partial).trim().length < 50){ toast('没有可续写的缓存内容'); return; }
  const _w = countWords(String(partial).trim()).total;
  chState[i] = 'generating';
  patchChapter(i);
  toast(`${sourceNote||'续写'}：已缓存 ${_w.toLocaleString()} 字，开始续写…`);
  try{
    const txt = await continueTruncatedChapter(i, '', partial);
    const content = String(txt||'').trim();
    if(!content) throw new Error('续写结果为空');
    delete state._chapterPartial[i];
    snapshotChapterVersion(i);
    state.chapters[i].content = content;
    invalidateChapterMemory(i);
    chState[i] = 'done';
    persist(); patchChapter(i); renderNarrativeEngineMenu();
    toast(`第 ${i+1} 章续写完成（${countWords(content).total.toLocaleString()} 字）`);
    autoExtractGlossary(); autoUpdateSubplots();
    generateRollingSummaries().catch(()=>{});
  }catch(e){
    if(!(e && e.name === 'AbortError')) toast('续写失败：' + ((e&&e.message)||'未知错误'));
    chState[i] = 'error';
    patchChapter(i); renderNarrativeEngineMenu();
  }
}

// v1.0.121 批量生成多章控件：步进器 + 「批量生成多章」；可用态随剩余章数联动，全写完后禁用并切换文案。
function syncGenBatchControls(){
  const mg = $('.multi-gen'); const out = $('#genCountOut'); const many = $('#btnGenMany');
  if(!mg || !out) return;
  const rem = remainingEmptyChapters();
  const done = rem <= 0;
  if(genBatchN < 1) genBatchN = 1;
  if(rem > 0 && genBatchN > rem) genBatchN = rem;
  out.textContent = String(genBatchN);
  mg.querySelectorAll('[data-gen-dec],[data-gen-inc]').forEach(b=>{ b.disabled = done; });
  if(many){ many.disabled = done; many.textContent = done ? '✅ 已全部写完' : '⚡ 批量生成多章'; }
}
function bindGenBatchControls(){
  const mg = $('.multi-gen'); if(!mg) return;
  const dec = mg.querySelector('[data-gen-dec]');
  const inc = mg.querySelector('[data-gen-inc]');
  if(dec) dec.onclick = (e)=>{ e.preventDefault(); genBatchN = Math.max(1, genBatchN - 1); syncGenBatchControls(); };
  if(inc) inc.onclick = (e)=>{ e.preventDefault(); genBatchN = Math.min(Math.max(1, remainingEmptyChapters()), genBatchN + 1); syncGenBatchControls(); };
  const many = $('#btnGenMany');
  if(many) many.onclick = (e)=>{
    e.preventDefault();
    const rem = remainingEmptyChapters();
    if(rem <= 0){ toast('已全部写完'); return; }   // 二次拦截：全写完后不可再触发
    genManyChapters(Math.min(Math.max(1, genBatchN), rem));
  };
  syncGenBatchControls();
}

// v1.0.123 区间生成：从起始章到结束章无条件生成（覆盖已写章，旧版自动入历史）；与现有批量生成并行独立。
function bindRangeGen(){
  const s = $('#rgStart'), e = $('#rgEnd'), btn = $('#btnRangeGen'), st = $('#rgStatus');
  if(!s || !e || !btn) return;
  const total = state.chapters.length;
  const clamp = (v, lo, hi)=> Math.max(lo, Math.min(hi, v));
  const validateWarn = ()=>{
    const sv = parseInt(s.value) || 1;
    const ev = parseInt(e.value) || 1;
    if(sv > ev){
      if(st) st.textContent = '⚠️ 起始章不能大于结束章';
      btn.disabled = true;
      return false;
    }
    if(st) st.textContent = '';
    btn.disabled = false;
    return true;
  };
  const validateClamp = ()=>{
    const sv = clamp(parseInt(s.value) || 1, 1, total);
    const ev = clamp(parseInt(e.value) || 1, 1, total);
    s.value = sv; e.value = ev;
    validateWarn();
  };
  s.oninput = validateWarn; e.oninput = validateWarn;   
  s.onblur = validateClamp; e.onblur = validateClamp;
  btn.onclick = async ()=>{
    if(!validate()) return;
    const sv = parseInt(s.value), ev = parseInt(e.value);
    const n = ev - sv + 1;
    // v225/P4-④：残缺 chapterPlans 的"裸写"显式知情护栏
    {
      const _o = state.outline || {};
      const miss = [];
      (_o.chapters||[]).forEach((c,i)=>{ const p=(_o.chapterPlans||[])[i];
        if(!p || !String(p.summary||'').trim() || !Array.isArray(p.beats) || p.beats.length<4) miss.push(i+1); });
      if(miss.length && !confirm(`第 ${miss.join('、')} 章缺主线简述/节拍表，这些章将按大纲直接裸写。继续？`)) return;
    }
    btn.disabled = true; btn.textContent = '生成中…';
    try{
      await genNChapters(sv - 1, n);   // 0-based start，genNChapters 内每章 snapshotChapterVersion + 覆盖
      toast(`第 ${sv}~${ev} 章（共 ${n} 章）已生成`);
      if(st) st.textContent = `✅ 第 ${sv}~${ev} 章已生成`;
    }catch(err){
      toast(`第 ${sv}~${ev} 章生成失败：${err.message}`);
      if(st) st.textContent = `❌ 生成失败`;
    }finally{
      btn.disabled = false; btn.textContent = '⚡ 区间生成';
      autoExtractGlossary(); autoUpdateSubplots();
    }
  };
  validateClamp();
}

// 统一批量生成入口（v1.0.120）：长篇按当前步进/预设章数连续生成；短片「一键生成全部」从头生成全部。
// 定位从第一个尚无正文的章节起，本次生成 count 章；若剩余空章不足则生成剩余全部。
// fromStart=true 时从第 1 章开始（短片生成全部语义，可覆盖已写章节）。
// 任一章失败即停批，进度区 #chStatus 实时更新。
async function genManyChapters(count, fromStart){
  // v225/P4-④：残缺 chapterPlans 的"裸写"显式知情护栏（把静默裸写变显式确认）
  {
    const _o = state.outline || {};
    const miss = [];
    (_o.chapters||[]).forEach((c,i)=>{ const p=(_o.chapterPlans||[])[i];
      if(!p || !String(p.summary||'').trim() || !Array.isArray(p.beats) || p.beats.length<4) miss.push(i+1); });
    if(miss.length && !confirm(`第 ${miss.join('、')} 章缺主线简述/节拍表，这些章将按大纲直接裸写。继续？`)) return;
  }
  const btn = $('#btnGenMany'); if(btn) busy(btn,true,'逐章生成中…');
  const st = $('#chStatus'); if(st){ st.className='status'; st.textContent=''; }
  const genCtl = $('#btnGenAllChapters');
  const stopParent = (btn && btn.parentNode) || (genCtl && genCtl.parentNode);
  if(stopParent) showStopBtn(stopParent);
  const totalCh = (state.chapters||[]).length;
  let start;
  if(fromStart){ start = 0; }
  else {
    const firstEmpty = state.chapters.findIndex(c=> !(c.content && String(c.content).trim()));
    start = firstEmpty < 0 ? 0 : firstEmpty;
  }
  if(totalCh <= 0 || start >= totalCh){ if(st){st.className='status ok'; st.textContent='全部章节已生成。';} busy(btn,false); hideStopBtn(); syncGenBatchControls(); return; }
  const n = Math.max(1, Math.min(count, totalCh - start));
  state.generating = true;
  for(let k=0;k<n;k++){ chState[start+k] = 'generating'; patchChapter(start+k); }
  if(st) st.textContent = `正在生成第 ${start+1}~${start+n} 章（共 ${n} 章）…`;
  try{
    await genNChapters(start, n);
    for(let k=0;k<n;k++){ chState[start+k] = 'done'; patchChapter(start+k); }
    const rem = remainingEmptyChapters();
    if(st){ st.className='status ok'; st.textContent = isLong()
      ? (rem > 0 ? `本批共 ${n} 章已生成，全书还剩 ${rem} 章未写。` : `全部章节已写完（共 ${totalCh} 章）。`)
      : '全部章节已生成，请审阅并标记确认。'; }
    if(rem <= 0 && isLong()) toast(`已全部写完（共 ${totalCh} 章）`);
    // 若生成落在当前页之外，切到其所在页以便用户看到
    const targetPage = Math.floor(start / CH_PAGE_SIZE);
    if(Math.abs(chPage - targetPage) >= 1){ chPage = targetPage; renderChapters(); }
  }catch(e){
    for(let k=0;k<n;k++){ if(chState[start+k] === 'generating'){ chState[start+k]='error'; } patchChapter(start+k); }
    if(st){ st.className='status err'; st.textContent = `第${start+1}~${start+n}章生成失败（${e.message}）。已停止本批，请修复后重试。`; }
    toast(`第${start+1}~${start+n}章生成失败：${e.message}`);
  }finally{
    state.generating = false; hideStopBtn();
    if(btn) busy(btn,false);
    autoExtractGlossary();   // v8c 词典自动补全：本批成功后提取新实体入库（失败静默）
    autoUpdateSubplots();    // v1.0.113 副线追踪：本批成功后逐章吸收副线进度（失败静默）
    if(isLong()) syncGenBatchControls();
  }
}

// 无 UI 阻塞版（供短片循环调用，保留）
async function genOneChapterNoUI(i){
  const user = buildChapterUser(i);
  try{
    const txt = isLong()
      ? await writeOneChapterContent(i, user)
      : unwrapAIResult(await callDeepSeek(PROMPTS.chapterSys + specSysAddition() + '\n\n' + ORIGINALITY_CHAPTER_SYS + chapterStyleNote(), user, {temperature: resolveActiveSpec().chapterTemp, taskKey:'chapter'})).trim();   // v10.8 章节温度 / v10.12 防套路 / v2.0 写作风格
    state.chapters[i].content = txt;
    persist();
  }catch(e){ /* 继续后续 */ }
}

/* ---------- P1-3 角色/场景/封面/分镜：覆盖前快照 + 历史弹窗（各上限10） ---------- */
function pushAssetHist(kind, data){
  if(data == null) return;
  if(!state.hist) state.hist = { characters:[], scenes:[], cover:[], storyboard:[] };
  const arr = state.hist[kind]; if(!Array.isArray(arr)) return;
  arr.unshift({ data: JSON.parse(JSON.stringify(data)), ts: Date.now() });
  if(arr.length > 10) arr.splice(10);
}
function assetHistCount(kind){ return Array.isArray(state.hist && state.hist[kind]) ? state.hist[kind].length : 0; }
function hasAssetHist(kind){ return assetHistCount(kind) > 0; }
const ASSET_LABEL = { characters:'角色定妆', scenes:'场景提示词', cover:'封面提示词', storyboard:'分镜' };
function openAssetHistPanel(kind){
  closeAssetHistPanel();
  const hist = Array.isArray(state.hist && state.hist[kind]) ? state.hist[kind] : [];
  if(!hist.length){ toast('暂无历史版本'); return; }
  const fmtTs = ts=>{ const d=new Date(ts); return (d.getMonth()+1)+'-'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
  const rows = hist.map((h,idx)=>{
    const d = h.data;
    let brief = '';
    if(kind==='characters') brief = (Array.isArray(d)?d.map(x=>x&&x.name).filter(Boolean).join('、'):'');
    else if(kind==='scenes') brief = (Array.isArray(d)?d.map(x=>x&&x.name).filter(Boolean).join('、'):'');
    else if(kind==='cover') brief = String(d||'').slice(0,40);
    else if(kind==='storyboard') brief = `${Array.isArray(d)?d.length:0} 镜`;
    const cnt = Array.isArray(d) ? d.length : 1;
    return `<div class="cv-row">
      <div class="cv-meta" style="flex:1;min-width:0"><div class="cv-time">${fmtTs(h.ts)} · ${cnt} 条</div><div class="cv-t" style="font-size:12px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(brief||'')}</div></div>
      <div class="cv-actions" style="display:flex;gap:6px;flex-shrink:0">
        <button type="button" class="btn ghost cv-b" data-ah-prev="${idx}">预览</button>
        <button type="button" class="btn ghost cv-b" data-ah-restore="${idx}">↩ 恢复</button>
      </div>
    </div>`;
  }).join('');
  const ov = document.createElement('div'); ov.id='ahPanel'; ov.className='gs-overlay';
  ov.innerHTML = `
    <div class="gs-modal">
      <div class="gs-modal-head"><b>🕘 ${ASSET_LABEL[kind]} · 历史版本（${hist.length}/10）</b>
        <button class="gs-x" data-ah-close>✕</button></div>
      <div class="cv-body">
        <div class="cv-row cur"><div class="cv-meta"><span class="cv-time">当前版本</span><span class="cv-wc">${kind==='cover' ? (state.coverPrompt?'有':'空') : (Array.isArray(state[kind==='characters'?'characters':(kind==='scenes'?'scenes':'storyboard')])?state[kind==='characters'?'characters':(kind==='scenes'?'scenes':'storyboard')].length:0)+' 条'}</span></div></div>
        <div class="cv-div">重生成前旧版会自动存入这里；恢复会覆盖当前内容（当前版也先存入历史）。</div>
        ${rows}
        <div class="cv-preview hidden" id="ahPreview">
          <div class="cv-prev-head"><b id="ahPrevTitle">版本预览</b><button class="gs-x" data-ah-prev-close>✕</button></div>
          <div class="cv-pre" id="ahReader"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-ah-close]').onclick = closeAssetHistPanel;
  ov.addEventListener('click', e=>{ if(e.target===ov) closeAssetHistPanel(); });
  ov.addEventListener('click', e=>{
    const p = e.target.closest('[data-ah-prev]'); if(!p) return;
    const h = hist[+p.dataset.ahPrev]; if(!h) return;
    const pr=$('#ahPreview'), rd=$('#ahReader'), pt=$('#ahPrevTitle');
    if(pr && rd){
      pt.textContent = '预览 · '+fmtTs(h.ts);
      const d = h.data;
      let txt = '';
      if(kind==='characters') txt = (d||[]).map(x=>`${x.name||''}（${x.role||''}）\n${JSON.stringify(x.profile||{},null,1)}`).join('\n\n');
      else if(kind==='scenes') txt = (d||[]).map(x=>`${x.name||''}（${x.作用||''}）\n${x.description||''}`).join('\n\n');
      else if(kind==='cover') txt = String(d||'');
      else if(kind==='storyboard') txt = (d||[]).map(x=>`镜${x.镜号||''}：${x.画面描述||''}`).join('\n');
      rd.textContent = txt.slice(0,1500) + (txt.length>1500?'\n…':''); 
      pr.classList.remove('hidden');
    }
  });
  ov.querySelector('[data-ah-prev-close]').onclick = ()=>{ const pr=$('#ahPreview'); if(pr) pr.classList.add('hidden'); };
  ov.addEventListener('click', e=>{
    const rb = e.target.closest('[data-ah-restore]'); if(!rb) return;
    const h = hist[+rb.dataset.ahRestore]; if(!h) return;
    if(!window.confirm(`恢复该版${ASSET_LABEL[kind]}将覆盖当前内容（当前版先存入历史）。确定恢复吗？`)) return;
    const curData = kind==='cover' ? (state.coverPrompt||'') : state[kind==='characters'?'characters':(kind==='scenes'?'scenes':'storyboard')];
    pushAssetHist(kind, curData);
    if(kind==='cover') state.coverPrompt = String(h.data||'');
    else state[kind==='characters'?'characters':(kind==='scenes'?'scenes':'storyboard')] = JSON.parse(JSON.stringify(h.data||[]));
    persist(); closeAssetHistPanel(); render();
    toast('已恢复历史版本');
  });
}
function closeAssetHistPanel(){ const p=$('#ahPanel'); if(p) p.remove(); }

async function genCharacters(){
  const btn = $('#btnGenChars'); busy(btn,true,'生成角色中…');
  try{
    // P1-3 覆盖前快照
    if(state.characters && state.characters.length) pushAssetHist('characters', state.characters);
    const txt = unwrapAIResult(await callDeepSeek(PROMPTS.characterSys, '【完整故事】\n'+fullStoryText(), {taskKey:'assets'}));
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
    // P1-3 覆盖前快照
    if(state.scenes && state.scenes.length) pushAssetHist('scenes', state.scenes);
    const txt = unwrapAIResult(await callDeepSeek(PROMPTS.sceneSys, '【完整故事】\n'+fullStoryText(), {taskKey:'assets'}));
    state.raw.scenes = txt;
    const j = parseJson(txt);
    state.scenes = (j.scenes || []).map(s=>{
      // 兜底：确保每条出图提示词带「无人环境」负向约束（防模型漏写）
      const p = String(s.prompt||'');
      const neg = ['no people','no characters','no humans','无人'];
      if(!neg.some(k=>p.toLowerCase().includes(k))){
        s.prompt = p.replace(/\s*$/,'') + '\n（无人物纯环境：no people, no characters, no humans, empty of figures）';
      }
      return s;
    });
    persist(); render();
    toast('场景提示词已生成');
  }catch(e){
    const p = $('#sceneStatus'); if(p){ p.className='status err'; p.textContent=e.message; }
  }finally{ busy(btn,false); }
}

/* 生成整部小说封面提示词（场景页顶部 / 长篇模式专用） */
async function genCover(){
  const btn = $('#btnGenCover'); busy(btn,true,'生成封面提示词…');
  const st = $('#coverStatus'); if(st){ st.className='status'; st.textContent=''; }
  const o = state.outline;
  if(!o){ toast('先生成故事大纲'); busy(btn,false); return; }
  // 依据「是否含汉字书名」选择对应提示词体系
  const sys = state.coverWithTitle ? PROMPTS.coverSysTitle : PROMPTS.coverSysClean;
  const user = `小说标题：${o.title}\n${outlineAnchorBlock()?outlineAnchorBlock()+'\n':''}小说简介：${o.logline}\n章节：${(o.chapters||[]).map(c=>c.title).join(' / ')}\n\n请为这部小说设计封面图的出图提示词。\n模式：${state.coverWithTitle?'包含书名汉字作为封面主体文字':'纯画面、无任何文字、预留书名留白'}`;
  try{
    // P1-3 覆盖前快照
    if(state.coverPrompt) pushAssetHist('cover', state.coverPrompt);
    const txt = unwrapAIResult(await callDeepSeek(sys, user, {taskKey:'assets'}));
    state.coverPrompt = txt.trim();
    persist(); render();
    toast(state.coverWithTitle?'已生成含书名封面提示词':'已生成纯画面封面提示词');
  }catch(e){
    if(st){ st.className='status err'; st.textContent=e.message; }
    else toast('生成失败：'+e.message);
  }finally{ busy(btn,false); }
}

async function genStoryboard(){
  const btn = $('#btnGenBoard'); busy(btn,true,'生成分镜中…');
  const st = $('#boardStatus');
  try{
    const chars = state.characters.map(c=>`${c.name}(${c.role})：定妆特征-${((c.profile&&c.profile.外貌)||'')}，常服-${((c.profile&&c.profile.常服与配色)||'')}`).join('\n');
    const scenes = state.scenes.map(s=>`${s.name}：${s.description||''}`).join('\n');
    const base = `【角色定妆特征】\n${chars||'（未生成角色）'}\n\n【场景】\n${scenes||'（未生成场景）'}`;
    const shots = [];
    const concepts = [];
    const fails = [];
    for(let i=0;i<state.chapters.length;i++){
      if(st){ st.className='status'; st.textContent = `正在为第 ${i+1}/${state.chapters.length} 章生成分镜…`; }
      const ch = state.chapters[i];
      const oc = (state.outline&&state.outline.chapters&&state.outline.chapters[i])||{};
      const content = ch.content||'';
      const user = `【本章】第${i+1}章 ${ch.title||oc.title||''}\n主线简述：${(state.outline&&Array.isArray(state.outline.chapterPlans)&&state.outline.chapterPlans[i])?chapterPlanText(state.outline.chapterPlans[i]):''}\n本章正文：\n${content.slice(0,50000)}${content.length>50000?'…':''}\n\n${base}`;
      try{
        const txt = unwrapAIResult(await callDeepSeek(PROMPTS.storyboardSys, user, {taskKey:'assets'}));
        const j = parseJson(txt);
        (j.shots||[]).forEach(s=>{
          s.章节 = i+1;
          if(s.时长==null) s.时长 = 3;
          shots.push(s);
        });
        concepts.push({视觉概念:j.视觉概念||'', 母题:j.母题||''});
      }catch(e){
        fails.push('第'+(i+1)+'章：'+e.message);
        concepts.push({视觉概念:'', 母题:''});
      }
    }
    if(!shots.length) throw new Error('分镜生成失败：' + fails.join('；'));
    // P1-3 覆盖前快照
    if(state.storyboard && state.storyboard.length) pushAssetHist('storyboard', state.storyboard);
    state.boardConcepts = concepts;
    state.storyboard = shots;
    state.raw.storyboard = '';
    persist(); render();
    toast(fails.length ? `分镜已生成（${fails.length} 章失败）` : '分镜已生成（按章节分组）');
  }catch(e){
    const p = $('#boardStatus'); if(p){ p.className='status err'; p.textContent=e.message; }
  }finally{
    busy(btn,false);
    if(st){ st.className='status'; st.textContent=''; }
  }
}

/* =========================================================
 * 历史作品弹层（多项目管理：切换/新建/删除）
 * ========================================================= */
let histOpenId = null;   // 当前展开详情的历史项目 id（折叠态，互不影响）
function fmtHistTime(ts){
  if(!ts) return '';
  const d = new Date(ts), now = new Date();
  const pad = n => String(n).padStart(2,'0');
  if(d.toDateString() === now.toDateString()) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function histProgress(p){
  if(p.chapters && p.chapters.length){
    const done = p.chapters.filter(c=> c.confirmed).length;
    return `${done}/${p.chapters.length} 章`;
  }
  if(p.outline && p.outline.chapters && p.outline.chapters.length) return `大纲 ${p.outline.chapters.length} 章`;
  if(p.characters && p.characters.length) return `${p.characters.length} 角色`;
  if(p.scenes && p.scenes.length) return `${p.scenes.length} 场景`;
  if(p.storyboard && p.storyboard.length) return `${p.storyboard.length} 镜`;
  if(p.idea) return '草稿';
  return `第 ${p.step||1} 步`;
}
function renderHistList(){
  const list = $('#histList'); if(!list) return;
  const items = [...lib.items].sort((a,b)=> (b.updatedAt||0) - (a.updatedAt||0));
  list.innerHTML = items.map(p=>{
    const isCur = p.id === lib.curId;
    const open = histOpenId === p.id;
    // 展开详情：按项目类型展示正文/大纲/已完成内容片段
    const preview = histItemPreview(p);
    return `<div class="hist-item ${isCur?'active':''} ${open?'open':''}" data-hist="${p.id}">
      <div class="hist-head" data-hist-toggle="${p.id}">
        <span class="hist-fold" data-hist-fold="${p.id}">${open?'▾':'▸'}</span>
        <button class="hist-main" data-switch="${p.id}">
          <span class="hist-title">${isCur?'<em class="hist-cur">当前</em>':''}${esc(p.title||'未命名作品')}</span>
          ${p.logline?`<span class="hist-desc">${esc(p.logline)}</span>`:''}
          <span class="hist-meta">${histProgress(p)} · ${fmtHistTime(p.updatedAt)}</span>
        </button>
        <button class="hist-del" data-fypexp="${p.id}" title="导出 .fyp 项目">📤</button>
        <button class="hist-del" data-del="${p.id}" title="删除作品">🗑</button>
      </div>
      <div class="hist-body">${preview}</div>
    </div>`;
  }).join('') || `<div class="hist-empty">还没有作品，点击「＋ 新建小说」开始。</div>`;
  $$('#histList [data-switch]').forEach(b=> b.onclick = ()=> switchProject(b.dataset.switch));
  $$('#histList [data-del]').forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); deleteProject(b.dataset.del); });
  // 历史作品一键导出整本 .fyp 项目
  $$('#histList [data-fypexp]').forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); exportProjectFile(b.dataset.fypexp); });
  // 折叠/展开单条项目详情：只影响当前项，不影响其它项的选择
  $$('#histList .hist-head').forEach(h=> h.onclick = (e)=>{
    if(e.target.closest('[data-switch]')) return;   // 点标题=切换项目，不折叠
    if(e.target.closest('[data-del]')) return;      // 删除按钮不触发折叠
    if(e.target.closest('[data-fypexp]')) return;   // .fyp 导出按钮不触发折叠
    const id = h.dataset.histToggle;
    histOpenId = (histOpenId===id) ? null : id;
    renderHistList();                               // 重新渲染以切折叠态
  });
}
// 单条历史作品的详情预览（HTML）
function histItemPreview(p){
  // 优先展示已有章正文的前若干字符，其次大纲标题，其次其它阶段摘要
  const chapters = (p.chapters||[]).filter(c=> c && c.content && String(c.content).trim());
  const parts = [];
  if(chapters.length){
    parts.push(`<b>正文已生成 ${chapters.length} 章：</b>`);
    const rows = chapters.slice(0, 8).map((c,i)=>`<div class="hist-p-row">第${i+1}章 · ${esc(cleanChapterTitle(c.title)||'')}</div>`).join('');
    parts.push(rows);
    if(chapters.length>8) parts.push(`<div class="muted">… 其余 ${chapters.length-8} 章</div>`);
  }
  const outline = p.outline && p.outline.chapters;
  if(outline && outline.length){
    parts.push(`<b>大纲（${outline.length} 章）：</b>`);
    parts.push(`<div class="hist-p-row muted">${esc(outline.map(c=>c.title).slice(0,6).join(' / '))}${outline.length>6?' …':''}</div>`);
  }
  if(p.characters && p.characters.length){
    parts.push(`<div class="hist-p-row muted">角色：${esc(p.characters.map(c=>c.name).slice(0,6).join('、'))}</div>`);
  }
  if(p.scenes && p.scenes.length){
    parts.push(`<div class="hist-p-row muted">场景：${esc(p.scenes.map(s=>s.name).slice(0,6).join('、'))}</div>`);
  }
  if(!parts.length) parts.push('<div class="muted">（暂无内容，仅记录了构想与进度）</div>');
  return parts.join('');
}
function openHistPanel(){ renderHistList(); $('#histPanel').classList.remove('hidden'); }
function closeHistPanel(){ $('#histPanel').classList.add('hidden'); }
function switchProject(id){
  if(id === lib.curId){ closeHistPanel(); return; }
  persist(); // 先保存当前项目
  lib.curId = id;
  const cur = lib.items.find(i=> i.id === id);
  applyProject(cur || {}); // 内容缺失 → 空白，id 仍保持有效
  saveLib(); // 提交 curId 切换
  closeHistPanel();
  render();
  window.scrollTo(0,0);
  toast(`已切换到「${cur ? (cur.title||'未命名作品') : '空白项目'}」`);
}
function newProject(mode){
  // 上限：满 MAX_PROJECTS 弹 confirm 是否删除最旧以新建
  if(lib.items.length >= MAX_PROJECTS){
    const oldest = [...lib.items].sort((a,b)=> (a.updatedAt||0) - (b.updatedAt||0))[0];
    if(oldest && !confirm(`历史已达 ${MAX_PROJECTS} 个上限，是否删除最旧的「${oldest.title||'未命名作品'}」以新建？`)){
      return false;
    }
    if(oldest) lib.items = lib.items.filter(i=> i.id !== oldest.id);
  }
  clearState();
  if(mode) state.mode = mode; // 'longnovel' 经典长篇小说
  const snap = projectSnapshot();
  const newId = makeId();
  lib.items.unshift({ ...snap, id: newId, updatedAt: Date.now() });
  lib.curId = newId;
  saveLib();
  closeHistPanel();
  render();
  window.scrollTo(0,0);
  toast(mode==='longnovel' ? '已新建经典长篇小说' : '已新建空白小说');
  return true;
}
function newLongProject(){
  // 点击「新建长篇」不再弹确认页，直接新建并进入经典长篇小说页面
  return newProject('longnovel');
}
function deleteProject(id){
  const it = lib.items.find(i=> i.id === id);
  if(!it) return;
  if(!confirm(`确定删除「${it.title||'未命名作品'}」？此操作不可恢复。`)) return;
  const wasCur = id === lib.curId;
  lib.items = lib.items.filter(i=> i.id !== id);
  if(wasCur){
    // 删当前项目：切到最近项目；若全删空则空白
    if(lib.items.length){
      const next = [...lib.items].sort((a,b)=> (b.updatedAt||0) - (a.updatedAt||0))[0];
      lib.curId = next.id;
      applyProject(next);
      toast('已删除，已切换到最近作品');
    }else{
      clearState();
      lib.curId = null;
      toast('已删除全部作品');
    }
    closeHistPanel(); render(); window.scrollTo(0,0);
  }
  saveLib();
  renderHistList();
}
function rebindHistPanel(){
  const btn = $('#btnHist');
  if(btn) btn.onclick = (e)=>{
    e.stopPropagation();
    const p = $('#histPanel');
    if(p.classList.contains('hidden')) openHistPanel(); else closeHistPanel();
  };
  const nb = $('#btnNewProject');
  if(nb) nb.onclick = (e)=>{ e.stopPropagation(); newProject(); };
  // 历史弹层头部「＋ 新建长篇」：确认后新建经典长篇小说项目
  const nlo = $('#histNewLong');
  if(nlo) nlo.onclick = (e)=>{ e.stopPropagation(); newLongProject(); };
  // 历史弹层头部「📥 导入 .fyp」：触发隐藏 file input
  const imp = $('#btnImportFyp');
  if(imp) imp.onclick = (e)=>{ e.stopPropagation(); const fi = $('#fypImportInput'); if(fi) fi.click(); };
  // 隐藏 file input 改变即解析导入
  const fi = $('#fypImportInput');
  if(fi) fi.onchange = (e)=>{ const f = e.target.files && e.target.files[0]; if(f) importProjectFile(f); e.target.value = ''; };
}

/* =========================================================
 * 整本项目导入 / 导出（自创 .fyp 格式）
 * 格式：{ format:'fyp-project', version:1, kind:'complete', exportedAt, app, book:{完整项目快照} }
 * book 与 lib.items[i] 同结构，导入后整体还原到历史列表并可打开。
 * ========================================================= */
function buildFyp(project){
  return {
    format: 'fyp-project',
    version: 1,
    kind: 'complete',
    exportedAt: new Date().toISOString(),
    app: 'storyfactory',
    appVersion: APP_VERSION,   // 导出时的应用版本号，供对方工具识别本项目由哪一版生成
    book: project   // 完整项目快照（与 lib.items[i] 同结构）
  };
}
function parseFyp(text){
  const obj = JSON.parse(text);
  if(!obj || typeof obj !== 'object') throw new Error('文件不是合法 JSON');
  if(obj.format !== 'fyp-project') throw new Error('不是 .fyp 项目文件（format 字段不匹配）');
  if(!obj.book || typeof obj.book !== 'object') throw new Error('.fyp 缺少 book 字段');
  return obj.book;
}
// 导出指定 id 的整本项目为 .fyp 文件（含大纲/全部章节正文/梗概/词典/结构/角色/场景/分镜/版本历史/写作风格/进度）
function exportProjectFile(id){
  const p = lib.items.find(i=> i.id === id);
  if(!p){ toast('未找到该作品'); return; }
  const fyp = buildFyp(p);
  const title = String(p.title || 'story').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 40);
  const blob = new Blob([JSON.stringify(fyp, null, 2)], { type:'application/octet-stream' });
  downloadBlob(`${title}.fyp`, blob);
  toast('已导出 .fyp 项目文件');
}
// 导入 .fyp 文件：解析后整体还原到历史列表，经 IDB 落盘并打开
function importProjectFile(file){
  if(!file) return;
  const big = file.size > 5 * 1024 * 1024;
  toast(big ? '文件较大，解析中…' : '正在导入项目…');
  const r = new FileReader();
  r.onload = function(){
    try{
      const book = parseFyp(String(r.result));
      // 重新生成 id，避免与现有项目同 id 冲突覆盖
      const newId = makeId();
      const item = Object.assign({}, book, { id: newId, updatedAt: Date.now() });
      if(!item.title) item.title = (item.outline && item.outline.title) || '导入的作品';
      lib.items.unshift(item);
      // 超限淘汰（与 newProject 一致）：删最旧非当前
      if(lib.items.length > MAX_PROJECTS){
        const others = lib.items.filter(i=> i.id !== lib.curId && i.id !== newId);
        others.sort((a,b)=> (a.updatedAt||0) - (b.updatedAt||0));
        const victim = others[0];
        if(victim){ lib.items = lib.items.filter(i=> i.id !== victim.id); }
      }
      lib.curId = newId;
      applyProject(item);
      saveLib(); // 经 IDB 落盘（fire-and-forget）
      closeHistPanel();
      render();
      window.scrollTo(0,0);
      toast(`已导入「${item.title}」并打开`);
    }catch(err){
      toast('导入失败：' + (err && err.message ? err.message : '文件格式错误'));
    }
  };
  r.onerror = function(){ toast('读取文件失败'); };
  r.readAsText(file);
}

/* =========================================================
 * 创作规范：故事页内联选择器（仅作用于写小说）
 * ========================================================= */
function selectSpec(id){
  const cfg = getCfg(); cfg.spec = id; saveCfg(cfg);
  toast('创作规范：'+getSpec().name+'（仅作用于写小说）');
  if(currentStep===1) render(); // 刷新故事页规范高亮
}

/* ===== 配色弹层（顶栏 🎨 颜色）：选择 / 删除 / 撤销 / 恢复全部 / 新建三色 v10.20 ===== */
function wsColorToolbarHtml(){
  const undoN = wsUndoLog().length, rmB = wsRemovedBuiltin().length;
  return `<div class="ws-cs-toolbar">
    <button type="button" class="cs-tool" data-cs-undo ${undoN?'':'disabled'} title="撤销上一步删除">↩ 撤销</button>
    <button type="button" class="cs-tool" data-cs-restore ${rmB?'':'disabled'} title="仅恢复项目自带的 11 套内置配色（不影响你自建的配色）">↺ 恢复全部</button>
    <span class="ws-cs-spacer"></span>
    <button type="button" class="cs-tool cs-tool-new" data-cs-new title="新建一套三色配色">＋ 新建配色</button>
  </div>`;
}
function wsColorGridHtml(){
  const cur = wsColorSchemeId();
  const customIds = wsCustomColors().map(s=>s.id);
  return wsColorSchemesList().map(s=>{
    const isCustom = customIds.includes(s.id);
    return `<div class="ws-cs-item${cur===s.id?' active':''}" data-cs="${s.id}" title="点击应用「${esc(s.name)}」">
      <div class="ws-cs-top">
        <span class="ws-cs-name">${esc(s.name)}${isCustom?'<i class="ws-cs-tag">我的</i>':''}</span>
        ${s.id==='none'?'':`<button type="button" class="ws-cs-del" data-cs-del="${s.id}" title="删除此配色">✕</button>`}
      </div>
      <div class="ws-cs-bars">
        ${(s.c&&s.c.length)? s.c.map(c=>`<i style="background:${c}"></i>`).join('') : `<i class="ws-cs-none">无</i>`}
      </div>
    </div>`;
  }).join('');
}
function wsColorNewFormHtml(){
  return `<div id="wsCsForm" class="ws-cs-form hidden">
    <div class="ws-cs-form-row"><label>名称</label><input id="csName" class="cs-inp" type="text" maxlength="12" placeholder="例如：晚霞粉蓝"></div>
    <div class="ws-cs-form-row"><label>上 · 标题</label><input id="csC0" class="cs-color" type="color" value="#e25a6a"></div>
    <div class="ws-cs-form-row"><label>中 · 梗概</label><input id="csC1" class="cs-color" type="color" value="#5b8def"></div>
    <div class="ws-cs-form-row"><label>下 · 章节</label><input id="csC2" class="cs-color" type="color" value="#3fc6a0"></div>
    <div class="ws-cs-form-ops">
      <button type="button" class="btn" data-cs-cancel>取消</button>
      <button type="button" class="btn primary" data-cs-confirm>确认新建</button>
    </div>
  </div>`;
}
function renderWsColorPanel(){
  const box = $('#wsColorBody'); if(!box) return;
  box.innerHTML = wsColorToolbarHtml() + `<div class="ws-cs-grid">${wsColorGridHtml()}</div>` + wsColorNewFormHtml();
}
function openWsColorPanel(){ const p=$('#wsColorPanel'); if(!p) return; renderWsColorPanel(); p.classList.remove('hidden'); }
function closeWsColorPanel(){ const p=$('#wsColorPanel'); if(p) p.classList.add('hidden'); }
// 保存 → 重建自定义css → 重渲面板 + 主卡
function wsColorRepaint(){ rebuildCustomColorCss(); renderWsColorPanel(); render(); }
// —— 动作 ——
function wsColorSelect(id){
  const c=getCfg(); c.styleCustom = c.styleCustom||{};
  c.styleCustom.colorScheme = id; saveCfg(c);
  wsColorRepaint(); toast('已切换写作风格配色：'+wsSchemeName(id));
}
function wsColorDelete(id){
  if(id==='none') return;
  const c=getCfg(); const cs=wsColorCfgOf(c);
  const active=(c.styleCustom||{}).colorScheme;
  const bi=WS_COLOR_SCHEMES.find(x=>x.id===id);
  if(bi){
    if(cs.removedBuiltin.includes(id)) return;
    cs.removedBuiltin.push(id); cs.undo.push({type:'builtin',id:id});
  } else {
    const s=cs.custom.find(x=>x.id===id); if(!s) return;
    cs.custom=cs.custom.filter(x=>x.id!==id);
    cs.removedCustom=cs.removedCustom.concat([s]); cs.undo.push({type:'custom',id:id});
  }
  if(active===id) c.styleCustom.colorScheme='none';
  saveCfg(c); wsColorRepaint();
  toast('已删除配色：'+wsSchemeName(id)+(active===id?'（当前配色已回退默认）':''));
}
function wsColorUndo(){
  const c=getCfg(); const cs=wsColorCfgOf(c); const last=cs.undo.pop(); if(!last) return;
  let label=last.id;
  if(last.type==='builtin'){ cs.removedBuiltin=cs.removedBuiltin.filter(x=>x!==last.id); }
  else { const s=cs.removedCustom.find(x=>x.id===last.id); if(s){ cs.custom=cs.custom.concat([s]); cs.removedCustom=cs.removedCustom.filter(x=>x.id!==last.id); label=s.name; } }
  saveCfg(c); wsColorRepaint(); toast('已撤销删除：'+label);
}
function wsColorRestoreAll(){
  const c=getCfg(); const cs=wsColorCfgOf(c);
  cs.removedBuiltin=[];
  cs.undo = cs.undo.filter(u=>u.type!=='builtin');   // 内置已全部恢复，仅清除其对应的撤销记录；保留自建配色的删除与撤销记录
  saveCfg(c); wsColorRepaint(); toast('已恢复全部内置配色（自建配色不受影响）');
}
function wsColorCreate(){
  const name=((($('#csName')||{}).value)||'').trim();
  const c0=(($('#csC0')||{}).value)||'', c1=(($('#csC1')||{}).value)||'', c2=(($('#csC2')||{}).value)||'';
  if(!name){ toast('请先填写配色名称'); return; }
  const c=getCfg(); const cs=wsColorCfgOf(c);
  cs.custom=cs.custom.concat([{id:'cu_'+(Date.now()), name:name, c:[c0,c1,c2]}]);
  saveCfg(c); rebuildCustomColorCss();
  const f=$('#wsCsForm'); if(f) f.classList.add('hidden');
  wsColorRepaint(); toast('已新建配色：'+name);
}
// 绑定配色面板：面板内容会被动态重建，故在容器上做事件委托
function rebindWsColorPanel(){
  const btn = $('#btnWsColor');
  if(btn) btn.onclick = (e)=>{ e.stopPropagation(); const p=$('#wsColorPanel'); if(p.classList.contains('hidden')) openWsColorPanel(); else closeWsColorPanel(); };
  const body = $('#wsColorBody');
  if(body) body.onclick = (e)=>{
    const del = e.target.closest('[data-cs-del]'); if(del){ e.stopPropagation(); wsColorDelete(del.dataset.csDel); return; }
    const item = e.target.closest('.ws-cs-item[data-cs]'); if(item){ e.stopPropagation(); if(!item.classList.contains('active')) wsColorSelect(item.dataset.cs); return; }
    if(e.target.closest('[data-cs-new]')){ e.stopPropagation(); const f=$('#wsCsForm'); if(f) f.classList.toggle('hidden'); return; }
    if(e.target.closest('[data-cs-undo]')){ e.stopPropagation(); wsColorUndo(); return; }
    if(e.target.closest('[data-cs-restore]')){ e.stopPropagation(); wsColorRestoreAll(); return; }
    if(e.target.closest('[data-cs-confirm]')){ e.stopPropagation(); wsColorCreate(); return; }
    if(e.target.closest('[data-cs-cancel]')){ e.stopPropagation(); const f=$('#wsCsForm'); if(f) f.classList.add('hidden'); return; }
  };
  rebuildCustomColorCss();   // 刷新后自定义配色仍能正确上色
}
function openThemePanel(){
  const p = $('#themePanel'); if(!p) return;
  // 同步高亮当前主题
  const cur = (document.documentElement.getAttribute('data-theme')) || 'dark';
  $$('.theme-btns .theme').forEach(b=> b.classList.toggle('active', b.dataset.theme===cur));
  // v10.16 温度已移入主题面板：打开时回显当前配置
  editCfg = JSON.parse(JSON.stringify(getCfg()));
  echoTemps();
  p.classList.remove('hidden');
}
function closeThemePanel(){ const p=$('#themePanel'); if(p) p.classList.add('hidden'); }

/* =========================================================
 * 新卡片界面：叙事引擎抽屉与通用弹窗
 * ========================================================= */
function openNarrativeEngine(){
  const p = $('#narrativeEnginePanel'); if(!p) return;
  renderNarrativeEngineMenu();
  p.classList.remove('hidden');
}
function closeNarrativeEngine(){ const p=$('#narrativeEnginePanel'); if(p) p.classList.add('hidden'); }

function openNeModal(title, bodyHtml, actionsHtml){
  const m=$('#neModal'); if(!m) return;
  $('#neModalTitle').textContent = title || '叙事引擎';
  $('#neModalBody').innerHTML = bodyHtml || '';
  const acts=$('#neModalActions');
  if(actionsHtml){ acts.innerHTML = actionsHtml; acts.classList.remove('hidden'); }
  else { acts.innerHTML=''; acts.classList.add('hidden'); }
  m.classList.remove('hidden');
}
function closeNeModal(){ const m=$('#neModal'); if(m) m.classList.add('hidden'); }

function renderNarrativeEngineMenu(){
  const box=$('#nePanelBody'); if(!box) return;
  const o = state.outline;
  const fs = (o && o._foreshadowLedger) || {planted:[], resolved:[], overdue:[]};
  const overdueN = fs.overdue ? fs.overdue.length : 0;
  const personaN = Object.values(state._personaCards||{}).reduce((s,c)=> s + (c.violations?c.violations.length:0), 0);
  const partialN = Object.keys(state._chapterPartial||{}).length;
  const branchN = (state._branchSandboxes||[]).length;
  const tensionN = (state._tensionCurve||[]).length;
  box.innerHTML = `
    <div class="ne-menu-hint">AI 叙事中间件总入口，点击打开对应面板</div>
    <button class="ne-menu-item" data-ne-panel="resume"><span class="ne-ico">▶️</span><span class="ne-lbl">流式续写状态</span>${partialN?`<span class="ne-badge">${partialN}</span>`:''}</button>
    <button class="ne-menu-item" data-ne-panel="foreshadow"><span class="ne-ico">🪝</span><span class="ne-lbl">伏笔看板</span>${overdueN?`<span class="ne-badge">${overdueN}</span>`:`${fs.planted.length?`<span class="ne-badge info">${fs.planted.length}</span>`:''}`}</button>
    <button class="ne-menu-item" data-ne-panel="persona"><span class="ne-ico">🛡️</span><span class="ne-lbl">人设防火墙</span>${personaN?`<span class="ne-badge">${personaN}</span>`:''}</button>
    <button class="ne-menu-item" data-ne-panel="tension"><span class="ne-ico">📈</span><span class="ne-lbl">张力曲线</span>${tensionN?`<span class="ne-badge info">${tensionN}</span>`:''}</button>
    <button class="ne-menu-item" data-ne-panel="style"><span class="ne-ico">🎨</span><span class="ne-lbl">风格 DNA</span>${state._styleDNA?'<span class="ne-badge ok">ON</span>':''}</button>
    <button class="ne-menu-item" data-ne-panel="sandbox"><span class="ne-ico">🌿</span><span class="ne-lbl">分支沙盘推演</span></button>
    <button class="ne-menu-item" data-ne-panel="sandboxHistory"><span class="ne-ico">📜</span><span class="ne-lbl">沙盘历史</span>${branchN?`<span class="ne-badge info">${branchN}</span>`:''}</button>
    <button class="ne-menu-item" data-ne-panel="banlist"><span class="ne-ico">🚫</span><span class="ne-lbl">禁则清单</span>${stateBanEnabled()?'<span class="ne-badge ok">ON</span>':'<span class="ne-badge">OFF</span>'}</button>
  `;
}

function rebindNarrativeEngine(){
  const btn=$('#btnNarrativeEngine');
  if(btn) btn.onclick = (e)=>{ e.stopPropagation(); const p=$('#narrativeEnginePanel'); if(p && p.classList.contains('hidden')) openNarrativeEngine(); else closeNarrativeEngine(); };
  const p=$('#narrativeEnginePanel');
  if(p) p.onclick = (e)=>{
    const item=e.target.closest('[data-ne-panel]'); if(!item) return;
    const panel=item.dataset.nePanel;
    if(panel==='resume') renderResumePanel();
    else if(panel==='foreshadow') renderForeshadowLedger();
    else if(panel==='persona') renderPersonaFirewall();
    else if(panel==='tension') renderTensionCurve();
    else if(panel==='style') renderStyleDnaPanel();
    else if(panel==='sandbox') renderBranchSandbox();
    else if(panel==='sandboxHistory') renderSandboxHistory();
    else if(panel==='banlist') renderBanListPanel();
    // 交互优化：选择某一项后收起抽屉（子面板经 openNeModal 弹窗接管后续交互，抽屉不再需要）
    closeNarrativeEngine();
  };
  const m=$('#neModal');
  if(m) m.onclick = (e)=>{
    if(e.target.closest('[data-ne-close]')){ closeNeModal(); return; }
    // 流式续写
    const resume=e.target.closest('[data-ne-resume]'); if(resume){ const i=+resume.dataset.neResume; closeNeModal(); continueAndFinalizeChapter(i, '从中断处继续'); return; }
    const discard=e.target.closest('[data-ne-discard]'); if(discard){ const i=+discard.dataset.neDiscard; delete state._chapterPartial[i]; toast('已丢弃第 '+(i+1)+' 章缓存'); renderResumePanel(); renderNarrativeEngineMenu(); return; }
    // 伏笔看板
    const fsRes=e.target.closest('[data-ne-fs-resolve]'); if(fsRes){ const idx=+fsRes.dataset.neFsResolve; resolveForeshadow(idx, state.chapters.length-1); renderForeshadowLedger(); renderNarrativeEngineMenu(); return; }
    const fsDelay=e.target.closest('[data-ne-fs-delay]'); if(fsDelay){ const idx=+fsDelay.dataset.neFsDelay; delayForeshadow(idx); renderForeshadowLedger(); renderNarrativeEngineMenu(); return; }
    const fsDel=e.target.closest('[data-ne-fs-del]'); if(fsDel){ const idx=+fsDel.dataset.neFsDel; deleteForeshadow(idx); renderForeshadowLedger(); renderNarrativeEngineMenu(); return; }
    const fsResOd=e.target.closest('[data-ne-fs-resolve-od]'); if(fsResOd){ const idx=+fsResOd.dataset.neFsResolveOd; resolveOverdueForeshadow(idx); renderForeshadowLedger(); renderNarrativeEngineMenu(); return; }
    // 张力节点
    const tDot=e.target.closest('[data-ne-tension]'); if(tDot){ const ch=+tDot.dataset.neTension; const c=state._tensionCurve.find(x=>x.ch===ch); if(c) toast(`第 ${ch+1} 章 · 外在 ${c.external||0} · 内心 ${c.internal||0} · 信息差 ${c.mystery||0}`); return; }
    // 分支沙盘选择
    const sbCh=e.target.closest('[data-ne-sb-choose]'); if(sbCh){ const point=+sbCh.dataset.neSbChoose; const id=sbCh.dataset.neSbId||''; applySandboxBranch(point, id); closeNeModal(); toast('已选择分支并注册风险为伏笔'); return; }
    // v1.0.132 禁则清单面板交互
    if(handleBanListAction(e)) return;
  };
  // 点击空白处关闭抽屉
  document.addEventListener('click', (e)=>{
    const p=$('#narrativeEnginePanel');
    if(p && !p.classList.contains('hidden') && !p.contains(e.target) && !e.target.closest('#btnNarrativeEngine')) closeNarrativeEngine();
  });
}

/* =========================================================
 * 新卡片界面：各中间件面板渲染
 * ========================================================= */
function renderResumePanel(){
  const partials = state._chapterPartial || {};
  const keys = Object.keys(partials).filter(k=> String(partials[k]||'').trim().length>=50);
  if(!keys.length){ openNeModal('流式续写状态', '<div class="empty">暂无中断缓存，所有章节均未处于生成中或中断状态。</div>'); return; }
  const rows = keys.map(k=>{
    const i=+k; const c=state.chapters[i]; const w=countWords(partials[k]||'').total;
    return `<div class="card"><div class="kv"><span class="k">第 ${i+1} 章</span><span class="v">${esc(c && c.title ? c.title : '未命名')}</span></div><div class="kv"><span class="k">已缓存</span><span class="v">${w.toLocaleString()} 字</span></div><div class="btn-row"><button class="btn primary" data-ne-resume="${i}">从中断处继续</button><button class="btn ghost" data-ne-discard="${i}">丢弃缓存</button></div></div>`;
  }).join('');
  openNeModal('流式续写状态', `<div class="ne-body">${rows}<p class="hint">「从中断处继续」会把已缓存文本作为锚点，让 AI 无缝续写，避免从零重跑。</p></div>`);
}

function renderForeshadowLedger(){
  const o=state.outline; const fs=(o && o._foreshadowLedger)||{planted:[],resolved:[],overdue:[]};
  const planted=(fs.planted||[]).map((it,idx)=>`<div class="ne-fs-item"><b>🪝 ${esc(it.text)}</b><div class="muted">埋于第 ${(it.chPlanted||0)+1} 章 · 预计第 ${(it.expectedCh||0)+1} 章回收</div><div class="ne-fs-ops"><button class="btn small ghost" data-ne-fs-resolve="${idx}">标记为本章回收</button><button class="btn small ghost" data-ne-fs-delay="${idx}">延后回收</button><button class="btn small ghost" data-ne-fs-del="${idx}">删除</button></div></div>`).join('') || '<div class="empty">暂无埋下伏笔</div>';
  const resolved=(fs.resolved||[]).map(it=>`<div class="ne-fs-item"><b>✓ ${esc(it.text)}</b><div class="muted">回收于第 ${(it.chResolved||0)+1} 章</div></div>`).join('') || '<div class="empty">暂无已回收伏笔</div>';
  const overdue=(fs.overdue||[]).map((it,idx)=>`<div class="ne-fs-item"><b>⚠️ ${esc(it.text)}</b><div class="muted">预计第 ${(it.expectedCh||0)+1} 章回收 · 已逾期</div><div class="ne-fs-ops"><button class="btn small ghost" data-ne-fs-resolve-od="${idx}">立即回收</button></div></div>`).join('') || '<div class="empty">暂无逾期伏笔</div>';
  openNeModal('伏笔看板', `
    <div class="ne-fs-board">
      <div class="ne-fs-col"><h5>已埋下 (${fs.planted?fs.planted.length:0})</h5>${planted}</div>
      <div class="ne-fs-col"><h5>已回收 (${fs.resolved?fs.resolved.length:0})</h5>${resolved}</div>
      <div class="ne-fs-col overdue"><h5>逾期报警 (${fs.overdue?fs.overdue.length:0})</h5>${overdue}</div>
    </div>
    <p class="hint">逾期伏笔会在后续章节生成时被强制置顶，提醒 AI 必须兑现。</p>
  `);
}

function renderPersonaFirewall(){
  const cards=state._personaCards||{}; const names=Object.keys(cards);
  if(!names.length){ openNeModal('人设防火墙', '<div class="empty">暂无人物卡数据，生成正文后会自动建立 canon 与审计。</div>'); return; }
  const html=names.map(name=>{
    const c=cards[name]; const canon=c.canon||{};
    const fields=['identity','age','gender','appearance','hobby','relation','trait'];
    const fieldNames={'identity':'身份','age':'年龄','gender':'性别','appearance':'外貌','hobby':'爱好','relation':'关系','trait':'特质'};
    const canonRows=fields.map(f=>`<div class="kv"><span class="k">${fieldNames[f]}</span><span class="v">${esc(canon[f]||'—')}</span></div>`).join('');
    // 收集本章及全部已记录的矛盾
    const allViol=[];
    Object.entries(c.chapterTraits||{}).forEach(([chIdx, arr])=>{
      if(!Array.isArray(arr)) return;
      arr.forEach(entry=>{
        const m=String(entry).match(/^([^:]+):(.+)$/);
        if(m) allViol.push({ch:+chIdx, field:m[1], evidence:m[2]});
      });
    });
    const violHtml=allViol.length? allViol.map((v,i)=>`<div class="ne-violation"><b>矛盾 ${i+1}</b>：第 ${v.ch+1} 章 · ${esc(v.field)}<br>证据：${esc(v.evidence)}</div>`).join('') : '<div class="muted">本章未发现明显矛盾</div>';
    return `<div class="card ne-persona-card"><div class="ne-persona-head"><b>${esc(name)}</b>${allViol.length?'<span class="pill tag-warn">'+allViol.length+' 处矛盾</span>':'<span class="pill tag-ok">一致</span>'}</div><div class="subcard">${canonRows}</div><h4>本章表现 / 审计</h4>${violHtml}</div>`;
  }).join('');
  openNeModal('人设防火墙', `<div class="ne-body">${html}</div>`);
}

function renderTensionCurve(){
  const curve=state._tensionCurve||[];
  if(!curve.length){ openNeModal('张力曲线', '<div class="empty">暂无张力评分，生成正文后会自动评估每章 external/internal/mystery。</div>'); return; }
  const w=520, h=180, pad={t:10,r:20,b:30,l:30};
  const maxCh=Math.max(curve.length, 1);
  const pts = curve.map((c,i)=>{
    const x=pad.l + (i/(maxCh-1||1))*(w-pad.l-pad.r);
    return {x, external:c.external||0, internal:c.internal||0, mystery:c.mystery||0, ch:c.ch||i};
  });
  function line(values, cls){
    return `<polyline class="${cls}" points="${pts.map((p,i)=>`${p.x.toFixed(1)},${(h-pad.b-(values[i]/10)*(h-pad.t-pad.b)).toFixed(1)}`).join(' ')}"/>`;
  }
  const dots = pts.map((p,i)=>{
    const ye=h-pad.b-(p.external/10)*(h-pad.t-pad.b);
    const yi=h-pad.b-(p.internal/10)*(h-pad.t-pad.b);
    const ym=h-pad.b-(p.mystery/10)*(h-pad.t-pad.b);
    return `<circle class="tension-dot tension-line-external" cx="${p.x.toFixed(1)}" cy="${ye.toFixed(1)}" data-ne-tension="${p.ch}"/><circle class="tension-dot tension-line-internal" cx="${p.x.toFixed(1)}" cy="${yi.toFixed(1)}" data-ne-tension="${p.ch}"/><circle class="tension-dot tension-line-mystery" cx="${p.x.toFixed(1)}" cy="${ym.toFixed(1)}" data-ne-tension="${p.ch}"/>`;
  }).join('');
  const labels = pts.map((p,i)=>`<text class="tension-label" x="${p.x.toFixed(1)}" y="${h-8}" text-anchor="middle">${p.ch+1}</text>`).join('');
  const gridY=[0,5,10].map(v=>{
    const y=h-pad.b-(v/10)*(h-pad.t-pad.b);
    return `<line class="tension-grid" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w-pad.r}" y2="${y.toFixed(1)}"/><text class="tension-label" x="${pad.l-6}" y="${y+3}" text-anchor="end">${v}</text>`;
  }).join('');
  const svg=`<svg viewBox="0 0 ${w} ${h}"><line class="tension-axis" x1="${pad.l}" y1="${h-pad.b}" x2="${w-pad.r}" y2="${h-pad.b}"/><line class="tension-axis" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${h-pad.b}"/>${gridY}${line(pts.map(p=>p.external),'tension-line-external')}${line(pts.map(p=>p.internal),'tension-line-internal')}${line(pts.map(p=>p.mystery),'tension-line-mystery')}${dots}${labels}</svg>`;
  openNeModal('张力曲线', `<div class="tension-chart">${svg}</div><div class="tension-legend"><span><i style="background:#f87171"></i> 外在冲突</span><span><i style="background:#60a5fa"></i> 内心冲突</span><span><i style="background:#a78bfa"></i> 信息差</span></div><p class="hint">点击节点可查看该章评分详情。</p>`);
}

function renderStyleDnaPanel(){
  const dna=state._styleDNA;
  const fp=dna && dna.fingerprint;
  const exemplars=dna && dna.exemplars ? dna.exemplars : [];
  const fingerprintHtml=fp?`
    <div class="card"><h4>当前风格指纹</h4><div class="ne-style-fingerprint">
      <div class="kv"><span class="k">平均句长</span><span class="v">${fp.sentenceAvg||'—'}</span></div>
      <div class="kv"><span class="k">对话占比</span><span class="v">${fp.dialogueRatio!=null ? (fp.dialogueRatio*100).toFixed(1)+'%' : '—'}</span></div>
      <div class="kv"><span class="k">修辞密度</span><span class="v">${fp.rhetoricDensity!=null ? fp.rhetoricDensity : '—'}</span></div>
      <div class="kv"><span class="k">节奏注记</span><span class="v">${esc(fp.rhythmNote||'—')}</span></div>
    </div>
    ${fp.lexicon && fp.lexicon.length? `<div class="hint">高频词：${esc(fp.lexicon.slice(0,12).join('、'))}</div>`:''}
    ${fp.punctuation? `<div class="hint">标点特征：${Object.entries(fp.punctuation).map(([k,v])=>`${esc(k)} ${(v*100).toFixed(1)}%`).join(' · ')}</div>`:''}
    </div>
    <div class="card"><h4>范文镜像（轮换注入）</h4><div class="ne-exemplars">${exemplars.length? exemplars.map(e=>`<div class="ne-exemplar">${esc(e)}</div>`).join('') : '<div class="muted">暂无金句，请提取或手动添加。</div>'}</div></div>
  `:'<div class="empty">尚未提取风格指纹。粘贴范文后点击「提取指纹」。</div>';
  openNeModal('风格 DNA', `
    <div class="ne-body">
      <div class="card"><h4>作家范文输入</h4><textarea id="neStyleInput" class="ne-style-input" placeholder="粘贴 1-3 段你喜欢的作家范文（建议 500-2000 字）"></textarea><div class="btn-row"><button class="btn primary" id="neBtnExtractStyle">提取指纹</button>${dna?'<button class="btn ghost" id="neBtnClearStyle">清除 DNA</button>':''}</div></div>
      ${fingerprintHtml}
    </div>
  `);
  setTimeout(()=>{
    const extract=$('#neBtnExtractStyle'); if(extract) extract.onclick=()=>{
      if(extract.disabled) return;   // 防抖：提取期间连点只发一次，避免重复请求
      const text=(($('#neStyleInput')||{}).value||'').trim();
      if(text.length<50){ toast('范文太短，建议至少 50 字'); return; }
      extract.disabled=true; extract.textContent='🔍 提取中…';
      extractStyleDNA(text).then(()=>{ toast('风格指纹已提取'); renderStyleDnaPanel(); renderNarrativeEngineMenu(); }).catch(e=>{ toast('提取失败：'+e.message); if(!extract.parentNode){ /* 面板已换，无需复原 */ } }).finally(()=>{ });
    };
    const clear=$('#neBtnClearStyle'); if(clear) clear.onclick=()=>{ state._styleDNA=null; if(state.styleContract && state.styleContract._dna){ state.styleContract = buildStyleFingerprintFromConfirmed() || null; pushStyleHistory('清除 DNA 后回退风格契约'); } pushStyleHistory('清除风格 DNA'); toast('已清除风格 DNA'); renderStyleDnaPanel(); renderNarrativeEngineMenu(); };
  },0);
}

function renderBranchSandbox(preIdx){
  const idx=preIdx!=null?preIdx:(state.chapters.length?state.chapters.length-1:0);
  openNeModal('分支沙盘推演', `
    <div class="ne-body">
      <div class="card">
        <h4>分歧点设置</h4>
        <label class="field"><span>分歧点所在章</span><input id="neSbIdx" type="number" min="1" max="${Math.max(1,state.chapters.length)}" value="${idx+1}"></label>
        <label class="field"><span>分歧描述（如：主角是否揭发反派）</span><input id="neSbQuestion" type="text" placeholder="输入核心抉择"></label>
        <label class="field"><span>备选分支（每行一个，建议 2-4 个）</span><textarea id="neSbOptions" rows="4" placeholder="分支一：主角选择揭发&#10;分支二：主角选择隐忍"></textarea></label>
        <div class="btn-row"><button class="btn primary" id="neBtnRunSandbox">开始推演</button></div>
      </div>
      <div id="neSbResult"></div>
    </div>
  `);
  setTimeout(()=>{
    const btn=$('#neBtnRunSandbox'); if(!btn) return;
    btn.onclick=async ()=>{
      const i=Math.max(0,Math.min(state.chapters.length-1,parseInt($('#neSbIdx').value||'1',10)-1));
      const q=(($('#neSbQuestion')||{}).value||'').trim();
      const opts=(($('#neSbOptions')||{}).value||'').split('\n').map(s=>s.trim()).filter(Boolean);
      if(!q || opts.length<2){ toast('请填写分歧描述和至少两个分支'); return; }
      btn.disabled=true; btn.innerHTML='<span class="spinner"></span>推演中…';
      try{
        const res=await sandboxBranch(i, opts);
        const branches=(res && res.branches)||[];
        updateSandboxHistory(i, branches, '');
        const sorted=[...branches].sort((a,b)=>(b.consistency||0)-(a.consistency||0));
        const cards=sorted.map((b,idx)=>`
          <div class="ne-branch-card ${idx===0?'best':''}">
            <div class="ne-branch-score">${(b.consistency||0).toFixed(1)}</div>
            <div><b>${esc(b.id||('分支'+(idx+1)))}</b></div>
            <div class="muted">${esc(b.summary||'')}</div>
            <div><b>风险</b><ul>${(b.risks||[]).map(r=>`<li>${esc(r)}</li>`).join('')||'<li>—</li>'}</ul></div>
            <div><b>收益</b><ul>${(b.payoffs||[]).map(r=>`<li>${esc(r)}</li>`).join('')||'<li>—</li>'}</ul></div>
            <div class="ne-branch-actions"><button class="btn primary" data-ne-sb-choose="${i}" data-ne-sb-id="${esc(b.id||'')}">选择此分支</button></div>
          </div>
        `).join('');
        $('#neSbResult').innerHTML = `<div class="card"><h4>推演结果（按一致性评分排序）</h4><div class="ne-branch-grid">${cards}</div></div>`;
      }catch(e){ toast('推演失败：'+e.message); }
      finally{ btn.disabled=false; btn.textContent='开始推演'; }
    };
  },0);
}

function renderSandboxHistory(){
  const list=state._branchSandboxes||[];
  if(!list.length){ openNeModal('沙盘历史', '<div class="empty">暂无分支推演记录。</div>'); return; }
  const html=list.map((sb,i)=>{
    const chosen=sb.chosen ? `<span class="pill tag-ok">已选：${esc(sb.chosen)}</span>` : '<span class="pill tag-warn">未选择</span>';
    const cards=(sb.branches||[]).map(b=>`<div class="ne-branch-card"><div class="ne-branch-score">${(b.consistency||0).toFixed(1)}</div><div><b>${esc(b.id||'')}</b></div><div class="muted">${esc(b.summary||'')}</div></div>`).join('');
    return `<div class="card"><div class="kv"><span class="k">第 ${(sb.point||0)+1} 章后</span><span class="v">${chosen}</span></div><div class="ne-branch-grid">${cards}</div></div>`;
  }).join('');
  openNeModal('沙盘历史', `<div class="ne-body">${html}</div>`);
}

// v1.0.132 禁则清单面板：编辑禁用字/姓名/短语/规则与生效范围；保存写回持久化，恢复默认回退内置清单。
function handleBanListAction(e){
  const m=$('#neModal'); if(!m || m.style.display==='none' && m.classList&&m.classList.contains('hidden')) return false;
  if(!m.contains(e.target)) return false;
  // 总开关即时切换
  const en=e.target.closest('[data-bl-enabled]'); if(en){ /* 保存时统一读回，此处仅占位避免误关面板 */ return false; }
  // 新增规则：重新渲染并预置一条空规则
  const add=e.target.closest('[data-bl-rule-add]'); if(add){
    const b=banListRaw();
    const cur=normalizeBanList(b)||{enabled:true,chars:[],names:[],phrases:[],rules:[],scopeAi:[]};
    cur.rules.push({ text:'', ai:['chapter'] });
    state.banList=cur; renderBanListPanel(); return true;
  }
  // 删除规则
  const del=e.target.closest('[data-bl-rule-del]'); if(del){
    const i=+del.dataset.blRuleDel; const cur=normalizeBanList(state.banList)||{enabled:true,chars:[],names:[],phrases:[],rules:[],scopeAi:[]};
    (cur.rules||[]).splice(i,1); state.banList=cur; renderBanListPanel(); return true;
  }
  // 保存
  const save=e.target.closest('[data-bl-save]'); if(save){
    const cur=normalizeBanList(state.banList)||{enabled:true,chars:[],names:[],phrases:[],rules:[],scopeAi:BANLIST_DEFAULT.scopeAi.slice()};
    const gv=el=>m.querySelector(el); const val=el=>{const x=gv(el); return x?x.value.trim():'';};
    cur.enabled = !!(m.querySelector('[data-bl-enabled]')&&m.querySelector('[data-bl-enabled]').checked);
    cur.chars = val('[data-bl-chars]').split(/[,，]/).map(s=>s.trim()).filter(Boolean);
    cur.names = val('[data-bl-names]').split(/[,，\n]/).map(s=>s.trim()).filter(Boolean);
    cur.phrases = val('[data-bl-phrases]').split(/[,，]/).map(s=>s.trim()).filter(Boolean);
    // 规则文本回读
    m.querySelectorAll('[data-bl-rule-text]').forEach(t=>{ const i=+t.dataset.blRuleText; const aiSel=m.querySelector('[data-bl-rule-ai="'+i+'"]'); const ai=aiSel?aiSel.value.split(',') : []; if(cur.rules[i]){ cur.rules[i].text=t.value.trim(); cur.rules[i].ai=ai; } });
    cur.rules=cur.rules.filter(r=>r&&r.text);
    // 生效范围
    const scope=[];
    if(m.querySelector('[data-bl-scope="chapter"]')&&m.querySelector('[data-bl-scope="chapter"]').checked) scope.push('chapter');
    if(m.querySelector('[data-bl-scope="planner"]')&&m.querySelector('[data-bl-scope="planner"]').checked) scope.push('planner');
    if(m.querySelector('[data-bl-scope="outline"]')&&m.querySelector('[data-bl-scope="outline"]').checked) scope.push('outline');
    if(m.querySelector('[data-bl-scope="title"]')&&m.querySelector('[data-bl-scope="title"]').checked) scope.push('title');
    cur.scopeAi = scope.length?scope:BANLIST_DEFAULT.scopeAi.slice();
    state.banList=cur; persist(); renderNarrativeEngineMenu();
    toast('禁则清单已保存'); return true;
  }
  // 恢复默认
  const reset=e.target.closest('[data-bl-reset]'); if(reset){
    state.banList=null; persist(); renderNarrativeEngineMenu();
    toast('已恢复默认禁则清单'); return true;
  }
  return false;
}
function renderBanListPanel(){
  const b = banListRaw();
  const enabled = stateBanEnabled();
  const chars = banListChars().map(esc).join(', ');
  const names = banListNames().map(esc).join(', ');
  const bRaw = banListRaw();
  const phrases = (Array.isArray(bRaw.phrases)?bRaw.phrases:[]).map(esc).join(', ');
  const rules = (Array.isArray(bRaw.rules)?bRaw.rules:[]).map((r,i)=>`
    <div class="ne-bl-rule">
      <label>生效 AI：<select data-bl-rule-ai="${i}">
        ${['chapter','planner','outline','title'].map(r2=>`<option value="${r2}" ${(Array.isArray(r.ai)&&r.ai.indexOf(r2)>=0)?'selected':''}>${r2==='chapter'?'正文':r2==='planner'?'规划师':r2==='outline'?'大纲':'标题'}</option>`).join('')}
      </select></label>
      <textarea data-bl-rule-text="${i}" rows="2">${esc(r.text||'')}</textarea>
      <button class="btn small ghost" data-bl-rule-del="${i}">删除</button>
    </div>`).join('');
  const aiScope = banListAiScopeLabels();
  const html = `
    <div class="ne-body ne-bl-body">
      <div class="ne-bl-enable">
        <label class="mini-check"><input type="checkbox" data-bl-enabled ${enabled?'checked':''}> <b>总开关：启用「禁则清单」对四个写作 AI 的注入</b></label>
      </div>
      <div class="bl-note muted">清单为「最高优先」约束，但不得超越输出格式红线（禁标题/json/markdown）与人名/专名一致性红线。</div>
      <label class="kv"><span class="k">禁用字</span>
        <input data-bl-chars value="${chars}" placeholder="逗号分隔，如：晚,砚,秋,檐"/>
      </label>
      <label class="kv"><span class="k">禁用姓名</span>
        <textarea data-bl-names rows="3">${names}</textarea>
      </label>
      <label class="kv"><span class="k">禁用短语/模板词（仅正文）</span>
        <input data-bl-phrases value="${phrases}" placeholder="逗号分隔，如：倏然,眸光"/>
      </label>
      <div class="ne-bl-rules-head">附加规则 <button class="btn small" data-bl-rule-add>＋ 新增规则</button></div>
      ${rules || '<div class="muted">暂无附加规则。</div>'}
      <div class="ne-bl-scope-head"><b>生效范围（按 AI）</b></div>
      <div class="ne-bl-scope">
        <label class="mini-check"><input type="checkbox" data-bl-scope="chapter" ${aiScope.chapter?'checked':''}> 正文</label>
        <label class="mini-check"><input type="checkbox" data-bl-scope="planner" ${aiScope.planner?'checked':''}> 规划师</label>
        <label class="mini-check"><input type="checkbox" data-bl-scope="outline" ${aiScope.outline?'checked':''}> 大纲</label>
        <label class="mini-check"><input type="checkbox" data-bl-scope="title" ${aiScope.title?'checked':''}> 标题</label>
      </div>
      <div class="btn-row">
        <button class="btn primary" data-bl-save>保存</button>
        <button class="btn ghost" data-bl-reset>恢复默认</button>
      </div>
    </div>`;
  openNeModal('禁则清单', html);
}
function banListAiScopeLabels(){
  const b=banListRaw(); const sc=Array.isArray(b.scopeAi)?b.scopeAi:(BANLIST_DEFAULT.scopeAi||[]);
  return { chapter: sc.indexOf('chapter')>=0, planner: sc.indexOf('planner')>=0, outline: sc.indexOf('outline')>=0, title: sc.indexOf('title')>=0 };
}

function renderTitleCandidates(candidates, onSelect){
  if(!Array.isArray(candidates) || candidates.length<2){ onSelect && onSelect(0); return; }
  const cards=candidates.map((cand,i)=>`
    <div class="ne-candidate">
      <div class="ne-cand-head">方案 ${String.fromCharCode(65+i)}</div>
      <div class="ne-cand-meta">数量契约：${cand.valid?'✓':'✗'} · 相邻重名：${(cand.dupRate||0).toFixed(2)} · 专名命中：${(cand.glossRate||0).toFixed(2)}</div>
      <div class="ne-cand-list">${esc((cand.titles||[]).join('\n'))}</div>
      <div class="ne-cand-actions"><button class="btn primary" data-ne-title-select="${i}">应用方案 ${String.fromCharCode(65+i)}</button></div>
    </div>
  `).join('');
  openNeModal('标题候选方案', `<div class="ne-candidates">${cards}</div><p class="hint">选择一套方案后，章节标题将立即更新。</p>`);
  setTimeout(()=>{
    const m=$('#neModal');
    m.querySelectorAll('[data-ne-title-select]').forEach(b=>{
      b.onclick=()=>{ closeNeModal(); onSelect && onSelect(+b.dataset.neTitleSelect); };
    });
  },0);
}

function renderPlanCandidates(candidates, onSelect){
  if(!Array.isArray(candidates) || candidates.length<2){ onSelect && onSelect(0); return; }
  const cards=candidates.map((cand,i)=>`
    <div class="ne-candidate">
      <div class="ne-cand-head">规划方案 ${String.fromCharCode(65+i)}</div>
      <div class="ne-cand-meta">字数契约：${cand.valid?'✓':'✗'} · 实体覆盖：${(cand.entityRate||0).toFixed(2)}</div>
      <div class="ne-cand-list">${esc((cand.plans||[]).map(p=>p.summary).join('\n\n'))}</div>
      <div class="ne-cand-actions"><button class="btn primary" data-ne-plan-select="${i}">应用方案 ${String.fromCharCode(65+i)}</button></div>
    </div>
  `).join('');
  openNeModal('主线简述候选方案', `<div class="ne-candidates">${cards}</div><p class="hint">选择一套方案后，当前批次主线简述将更新。</p>`);
  setTimeout(()=>{
    $('#neModal').querySelectorAll('[data-ne-plan-select]').forEach(b=>{
      b.onclick=()=>{ closeNeModal(); onSelect && onSelect(+b.dataset.nePlanSelect); };
    });
  },0);
}

/* =========================================================
 * 设置弹窗（多 AI 模型：服务列表 → 组详情 → 三级联动选择）
 * 红色护栏：生成来源永远只有一个 editCfg.active 指向的账号/模型，绝不并发多模型请求。
 * ========================================================= */
let editCfg = null;        // 弹窗编辑中的工作副本（打开时从 getCfg 深拷贝）
let selGroupId = null;     // 当前「组详情」区选中的组

function openSettings(){
  editCfg = JSON.parse(JSON.stringify(getCfg()));
  selGroupId = editCfg.active ? editCfg.active.groupId : (editCfg.groups[0] && editCfg.groups[0].id);
  $('#settingsModal').classList.remove('hidden');
  echoTemps();
  const st = $('#cfgStatus'); if(st){ st.className='status'; st.textContent=''; }
  renderGroupsList(); renderGroupDetail(); renderActiveSelects(); updateCfgBadge();
}
function closeSettings(){ $('#settingsModal').classList.add('hidden'); }

// v10.16 温度回显（设置弹窗与主题面板共用；id 查找与 DOM 位置无关）
function echoTemps(){
  const c = editCfg || getCfg();
  $('#cfgTemp').value = (c.temperature==null ? '' : c.temperature);
  $('#cfgTempOutline').value = (c.outlineTemp==null ? '' : c.outlineTemp);
  $('#cfgTempIdea').value = (c.ideaTemp==null ? '' : c.ideaTemp);
  $('#cfgTempTitle').value = (c.titleTemp==null ? '' : c.titleTemp);
  $('#cfgTempPlan').value = (c.planTemp==null ? '' : c.planTemp);
  $('#cfgTempStrip').value = (c.stripTemp==null ? '' : c.stripTemp);
  $('#cfgTempChapter').value = (c.chapterTemp==null ? '' : c.chapterTemp);
  $('#cfgTempQC').value = (c.qcTemp==null ? '' : c.qcTemp);
  $('#cfgAiRecipeTemp').value = (c.aiRecipeTemp==null ? '' : c.aiRecipeTemp);   // v1.0.122 AI配方助手温度（默认0.9）
}

// v10.16 温度保存（从 saveSettings 拆出，主题面板「保存温度」与设置弹窗「保存」共用）
function saveTemps(){
  const rd = (id, def)=>{ const v=parseFloat($(id) && $(id).value); return isNaN(v)?def:v; };
  editCfg.temperature = rd('#cfgTemp', 0.7);
  editCfg.outlineTemp = rd('#cfgTempOutline', 0.7);
  editCfg.ideaTemp    = rd('#cfgTempIdea', 0.5);
  editCfg.titleTemp   = rd('#cfgTempTitle', 0.5);
  editCfg.planTemp    = rd('#cfgTempPlan', 0.4);
  editCfg.stripTemp   = rd('#cfgTempStrip', 1.0);
  editCfg.chapterTemp = rd('#cfgTempChapter', 0.5);
  editCfg.qcTemp      = rd('#cfgTempQC', 0.2);
  editCfg.aiRecipeTemp = rd('#cfgAiRecipeTemp', 0.9);   // v1.0.122 AI配方助手温度（默认0.9）
}

function _curSpec(){
  const cfg = (editCfg && editCfg.groups) ? editCfg : getCfg();
  const act = cfg.active || {};
  const g = cfg.groups.find(x=>x.id===act.groupId) || cfg.groups[0];
  const m = g && (g.models.find(x=>x.name===act.model) || g.models[0]);
  const k = g && (g.keys.find(x=>x.id===act.keyId) || g.keys[0]);
  return { group: g?g.label:'', key: k?k.label:'', model: m?m.name:'', flash: !!(m && m.kind==='flash') };
}
function shortModel(name){
  if(!name) return '';
  if(name.indexOf('deepseek-v4-')===0) return name.replace('deepseek-v4-','');
  const parts=name.split('-');
  return parts.length>1 ? parts.slice(-1)[0] : name;
}
function updateCfgBadge(){
  const b=$('#cfgBadge'); if(!b) return;
  const s=_curSpec();
  b.textContent = (s.group?'':'AI') + s.group + ' · ' + (shortModel(s.model)||'未选') + (s.flash?' ⚡':'');
  if(b.title != null) b.title='当前模型：'+s.group+' · '+s.key+' · '+s.model+'（点击切换）';
  updateTmBadge();   // v227 徽标联动（幂等）
}

/* --- v227「使用不同AI」分任务模型二级面板（设计见《使用不同ai.md》§3） --- */
// 档位分组：顺序=创作流水线；同档默认推荐同模型（§3.2 排列逻辑：按写书流程排、三档分组、全局置顶）
const TM_GROUPS = [
  { title:'✍️ 重创作（要质量，费用大头，建议主力模型）', keys:[
    ['chapter','正文生成','全书正文质量与费用大头；所选模型须支持流式（stream）'],
    ['outline','故事大纲','决定全书骨架，建议质量优先'],
    ['planSummary','规划师 · 主线简述','JSON，注入每章正文的结构锚'],
    ['planBeats','规划师 · 节拍表','JSON，逐章情节节拍'],
    ['plannerTitles','规划师 · 标题定稿','JSON，全书章节标题'],
    ['plannerAux','规划师 · 词典播种/伏笔','JSON 任务']
  ]},
  { title:'💡 建议类（要点子，建议中档模型）', keys:[
    ['idea','优化构想','对既有构想发散/收敛'],
    ['titleAdvice','标题 AI 建议','JSON 任务'],
    ['contentAdvice','章节内容 AI 建议','JSON 任务'],
    ['sandbox','分支沙盘','JSON 任务']
  ]},
  { title:'🔧 轻维护（高频小请求，建议 flash 省钱）', keys:[
    ['glossary','词典提取','JSON 严谨任务；换弱模型解析失败率会升高（有校验兜底，不阻断）'],
    ['subplot','副线追踪','JSON 任务'],
    ['strip','本章梗概（速读）','每章生成后都会调用'],
    ['rolling','滚动摘要','长篇记忆层，每批正文后调用'],
    ['audit','一致性巡检（张力/人设/指纹/锚点）','纯 JSON 后台巡检，用户无感']
  ]},
  { title:'📦 其他资产', keys:[
    ['assets','封面/人物/场景/分镜','提示词类产出'],
    ['recipe','配方产物','AI 配方助手']
  ]}
];
let editTM = null;          // 面板暂存：保存前绝不落盘（对齐设置弹窗 editCfg 模式）
let _tmEscHandler = null;   // ESC 关闭挂钩（现有 modal 无全局 ESC，本面板自持）
function tmCustomCount(tm){ return TM_KEYS.filter(k=> tm && tm[k]).length; }
function updateTmBadge(){
  const n = tmCustomCount(getCfg().taskModels);
  const el = $('#tmBadge'); if(el) el.textContent = n ? ('已自定义 '+n+' 项') : '全部跟随全局';
  const b = $('#cfgBadge'); if(b) b.classList.toggle('tm-on', n>0);
}
function tmResolvePreview(triple){
  if(!triple) return '跟随全局';
  const cfg = getCfg();
  const g = cfg.groups.find(x=>x.id===triple.groupId);
  if(!g) return '⚠️ 服务组不存在（保存后仍会回落全局）';
  const k = (g.keys||[]).find(x=>x.id===triple.keyId) || (g.keys||[])[0];
  const m = (g.models||[]).find(x=>x.name===triple.model) || (g.models||[])[0];
  return '实际:' + (g.label||'') + ' · ' + (k?(k.label||'账号'):'⚠️ 无账号') + ' · ' + (m?m.name:'⚠️ 无模型');
}
function openTaskModelPanel(){
  editTM = JSON.parse(JSON.stringify(getCfg().taskModels || {}));
  $('#taskModelModal').classList.remove('hidden');
  const st=$('#tmStatus'); if(st){ st.className='status'; st.textContent=''; }
  renderTaskModelPanel();
  _tmEscHandler = (e)=>{ if(e.key==='Escape') requestCloseTaskModelPanel(); };
  document.addEventListener('keydown', _tmEscHandler);
}
function closeTaskModelPanel(){
  $('#taskModelModal').classList.add('hidden');
  if(_tmEscHandler){ document.removeEventListener('keydown', _tmEscHandler); _tmEscHandler=null; }
  editTM = null;
}
// 关闭保护：有未保存差异时确认放弃（现有设置弹窗无此保护，本面板新增）
function requestCloseTaskModelPanel(){
  if(editTM && JSON.stringify(editTM) !== JSON.stringify(getCfg().taskModels || {})){
    if(!window.confirm('分任务模型有未保存的更改，放弃并关闭？')) return;
  }
  closeTaskModelPanel();
}
function refreshTmResetBtn(){
  const btn=$('#btnTmReset'); if(!btn) return;
  const n = tmCustomCount(editTM||{});
  btn.classList.toggle('hidden', n===0);
  btn.textContent = '全部恢复跟随全局（'+n+' 项自定义）';
}
function renderTaskModelPanel(){
  const body = $('#tmBody'); if(!body) return;
  const cfg = getCfg();
  const cur = cfg.active || {};
  const curGroup = cfg.groups.find(g=>g.id===cur.groupId) || cfg.groups[0] || {};
  const curKey = (curGroup.keys||[]).find(k=>k.id===cur.keyId) || (curGroup.keys||[])[0];
  const curModel = (curGroup.models||[]).find(m=>m.name===cur.model) || (curGroup.models||[])[0];
  const optHtml = (arr, val, ph)=> arr.length
    ? arr.map(x=>`<option value="${esc(String(x.v))}" ${String(x.v)===String(val)?'selected':''}>${esc(x.t)}</option>`).join('')
    : `<option value="">${esc(ph)}</option>`;
  const row = (key, name, note)=>{
    const tm = editTM[key] || '';
    const gid = tm ? tm.groupId : '';
    const grp = cfg.groups.find(g=>g.id===gid);
    const kid = tm ? tm.keyId : '';
    const mid = tm ? tm.model : '';
    return `<div class="tm-row${tm?' tm-custom':''}" data-tm-row="${key}">
      <div class="tm-head"><span class="tm-name">${esc(name)}</span><span class="tm-note">${esc(note||'')}</span></div>
      <div class="tm-sels">
        <select data-tm-sel="group" data-tm-key="${key}">
          <option value="">跟随全局</option>
          ${cfg.groups.map(g=>`<option value="${esc(g.id)}" ${gid===g.id?'selected':''}>${esc(g.label)}</option>`).join('')}
        </select>
        <select data-tm-sel="key" data-tm-key="${key}" ${grp?'':'disabled'}>${optHtml((grp?(grp.keys||[]):[]).map(k=>({v:k.id,t:k.label||'账号'})), kid, '（该组无账号）')}</select>
        <select data-tm-sel="model" data-tm-key="${key}" ${grp?'':'disabled'}>${optHtml((grp?(grp.models||[]):[]).map(m=>({v:m.name,t:m.name})), mid, '（该组无模型）')}</select>
      </div>
      <div class="tm-preview${tm?'':' tm-follow'}">${esc(tmResolvePreview(tm||null))}</div>
    </div>`;
  };
  body.innerHTML = `
    <div class="cv-div">全书费用大头 = <b>正文生成</b>；把轻维护任务换成 flash 通常能省一半以上。所有任务仍是单出口串行请求，不会并发多个 AI。deepseek-v4-flash-vision-exp 为带视觉模型，本应用全站纯文本请求，选它无额外收益。</div>
    <div class="set-block">
      <div class="set-block-head"><span>◆ 全局默认（未单独设置的任务都用它）</span></div>
      <div class="tm-preview">${esc((curGroup.label||'AI') + ' · ' + (curKey?(curKey.label||'账号'):'⚠️ 无账号') + ' · ' + (curModel?curModel.name:'⚠️ 无模型'))}（只读；去上方「AI 模型配置」修改）</div>
    </div>
    ${TM_GROUPS.map(gr=>`<div class="set-block"><div class="set-block-head"><span>${esc(gr.title)}</span></div>${gr.keys.map(k=>row(k[0],k[1],k[2])).join('')}</div>`).join('')}`;
  // 三级级联：换组→账号/模型重置为该组第一项；暂存只改 editTM，重渲染由数据派生、无丢失
  $$('#tmBody [data-tm-sel]').forEach(sel=>{
    sel.onchange = ()=>{
      const key = sel.dataset.tmKey, level = sel.dataset.tmSel;
      const cfgNow = getCfg();
      const tm = editTM[key] || '';
      if(level==='group'){
        if(!sel.value){ editTM[key]=''; }
        else{
          const grp = cfgNow.groups.find(g=>g.id===sel.value);
          editTM[key] = grp ? { groupId:grp.id, keyId:((grp.keys||[])[0]||{}).id||'', model:((grp.models||[])[0]||{}).name||'' } : '';
        }
      }else if(tm){
        if(level==='key') tm.keyId = sel.value;
        if(level==='model') tm.model = sel.value;
      }
      renderTaskModelPanel();
      refreshTmResetBtn();
    };
  });
  refreshTmResetBtn();
}
function saveTaskModels(){
  // 兜底清洗：组不存在/三元组不齐的条目一律回落 ''（与 normalizeCfg 同规则，杜绝串号）
  const cfg = getCfg();
  const clean = {};
  TM_KEYS.forEach(k=>{
    const v = editTM && editTM[k];
    const ok = v && typeof v==='object' && v.groupId && v.keyId && v.model && cfg.groups.some(g=>g.id===v.groupId);
    clean[k] = ok ? { groupId:v.groupId, keyId:v.keyId, model:v.model } : '';
  });
  const c = getCfg(); c.taskModels = clean; saveCfg(c);
  const n = tmCustomCount(clean);
  closeTaskModelPanel();
  updateCfgBadge();
  toast(n ? ('分任务模型已保存：'+n+' 项自定义，其余跟随全局') : '分任务模型已保存：全部跟随全局');
}

/* --- 第一段：服务列表 --- */
function renderGroupsList(){
  const el=$('#groupsList'); if(!el) return;
  el.innerHTML='';
  if(!editCfg.groups.length){ el.innerHTML='<div class="muted">暂无服务，点上方「＋ 新增组」添加。</div>'; return; }
  editCfg.groups.forEach(g=>{
    if(!selGroupId) selGroupId=g.id;
    const d=document.createElement('div');
    d.className='group-item' + (g.id===selGroupId ? ' active' : '');
    d.innerHTML = `<span class="gi-label">${esc(g.label)}</span><span class="gi-meta">${g.keys.length} 账号 · ${g.models.length} 模型</span>`;
    d.onclick = ()=>{ selGroupId=g.id; renderGroupsList(); renderGroupDetail(); };
    el.appendChild(d);
  });
}

/* --- 第二段：组详情（baseUrl + 多账号 + 模型清单） --- */
function _dg(){ return editCfg.groups.find(x=>x.id===selGroupId) || editCfg.groups[0]; }
function renderGroupDetail(){
  const el=$('#groupDetail'); if(!el) return;
  const g=_dg();
  if(!g){ el.innerHTML='<div class="muted">选择左侧一个服务，或点上方「＋ 新增组」添加。</div>'; return; }
  selGroupId=g.id;
  el.innerHTML = `
    <div class="set-block-head">
      <span>${esc(g.label)} · 详情</span>
      <span class="gd-acts">
        <button class="btn small ghost" data-act="addkey" type="button">＋ 账号</button>
        <button class="btn small ghost" data-act="addmodel" type="button">＋ 模型</button>
        ${g.id!=='deepseek' ? '<button class="btn small ghost del" data-act="delgroup" type="button">删组</button>' : ''}
      </span>
    </div>
    <label class="field"><span>接口地址（OpenAI 兼容协议）</span>
      <input class="g-base" type="text" value="${esc(g.baseUrl)}" placeholder="https://api.deepseek.com">
    </label>
    <label class="mini-check g-kib" title="部分 Cloudflare 中转不读 Authorization 头，要求把 Key 放进请求体 api_key 字段。开启后请求将不再携带 Bearer 头。">
      <input type="checkbox" class="g-kib-cb" ${g.keyInBody?'checked':''}> API Key 放请求体（api_key）传递，规避 Bearer 头
    </label>
    <div class="gd-title">账号（API Key 仅存本机，多账号=多卡分流）</div>
    ${g.keys.length ? g.keys.map((k,i)=>`
      <div class="key-row">
        <input class="k-lab" data-idx="${i}" type="text" value="${esc(k.label)}" placeholder="备注">
        <input class="k-key" data-idx="${i}" type="password" value="${esc(k.key)}" placeholder="sk-..." autocomplete="off">
        <button class="btn small ghost k-eye" data-key-eye="${i}" type="button" title="显示/隐藏 Key">👁</button>
        <button class="btn small ghost k-copy" data-key-copy="${i}" type="button" title="复制 Key">📋</button>
        <button class="btn small ghost del" data-act="delkey" data-id="${k.id}" type="button">删</button>
      </div>`).join('') : '<div class="muted">该组还没有账号，点「＋ 账号」粘贴 API Key。</div>'}
    <div class="gd-title">模型清单</div>
    ${g.models.length ? g.models.map(m=>`
      <div class="model-row">
        <span class="m-name">${esc(m.name)}</span>
        ${m.kind==='flash' ? '<span class="pill tag-warn">最快/最便宜</span>' : ''}
        <button class="btn small ghost del" data-act="delmodel" data-name="${esc(m.name)}" type="button">删</button>
      </div>`).join('') : '<div class="muted">请点「＋ 模型」添加模型名。</div>'}
  `;
  el.onclick = onDetail;
  el.querySelectorAll('.k-lab').forEach(inp=> inp.onchange=()=>{ const gg=_dg(); gg.keys[+inp.dataset.idx].label = inp.value || ('账号'+(+inp.dataset.idx+1)); });
  el.querySelectorAll('.k-key').forEach(inp=> { inp.onchange=()=>{ const gg=_dg(); gg.keys[+inp.dataset.idx].key = inp.value.trim(); updateCfgBadge(); }; });
  // v10.4 眼睛：显示/隐藏 Key（password ⇄ text，图标 👁/🙈 同步）
  el.querySelectorAll('[data-key-eye]').forEach(btn=>{
    btn.onclick = ()=>{
      const inp = el.querySelector('.k-key[data-idx="'+btn.dataset.keyEye+'"]');
      if(!inp) return;
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁';
      btn.title = show ? '隐藏 Key' : '显示 Key';
    };
  });
  // v10.4 复制：一键复制该 Key（复用全局 copyText，自带 toast 反馈）
  el.querySelectorAll('[data-key-copy]').forEach(btn=>{
    btn.onclick = ()=>{
      const inp = el.querySelector('.k-key[data-idx="'+btn.dataset.keyCopy+'"]');
      if(!inp || !inp.value.trim()){ toast('该账号暂无 Key'); return; }
      copyText(inp.value.trim());
    };
  });
  const base = el.querySelector('.g-base'); if(base) base.onchange=(ev)=>{ const gg=_dg(); gg.baseUrl = ev.target.value.trim(); };
  const kib = el.querySelector('.g-kib-cb'); if(kib) kib.onchange=(ev)=>{ const gg=_dg(); gg.keyInBody = ev.target.checked; };  // v1.0.136
}
function onDetail(ev){
  const b = ev.target && ev.target.closest('[data-act]'); if(!b) return;
  const act = b.dataset.act, g = _dg(); if(!g) return;
  if(act==='addkey'){
    const v=prompt('粘贴该账号的 API Key（sk-...）：');
    if(v==null) return;
    if(!v.trim()){ toast('Key 为空，未添加'); return; }
    g.keys.push({ id: uid('k'), label:'账号'+(g.keys.length+1), key:v.trim() });
  } else if(act==='addmodel'){
    const n=prompt('模型名（如 deepseek-v4-flash 或第三方模型名）：');
    if(n==null) return;
    if(!n.trim()){ toast('模型名为空，未添加'); return; }
    g.models.push({ name:n.trim(), label:n.trim(), kind:'' });
  } else if(act==='delkey'){
    g.keys = g.keys.filter(x=>x.id!==b.dataset.id);
  } else if(act==='delmodel'){
    g.models = g.models.filter(x=>x.name!==b.dataset.name);
  } else if(act==='delgroup'){
    editCfg.groups = editCfg.groups.filter(x=>x.id!==g.id);
    selGroupId = null;
  }
  refreshAfter();
}
function refreshAfter(){ renderGroupsList(); renderGroupDetail(); renderActiveSelects(); updateCfgBadge(); }

function addGroup(){
  const label=prompt('新服务名称（如：Kimi / 智谱 / 我的中转）：');
  if(label==null) return;
  if(!label.trim()){ toast('名称为空，未添加'); return; }
  const base=prompt('接口地址（OpenAI 兼容，如 https://api.deepseek.com）：','');
  const g={ id:uid('g'), kind:'openai', label:label.trim(), baseUrl:(base||'').trim(), keys:[], models:defaultModels(), keyInBody:false };
  editCfg.groups.push(g); selGroupId=g.id; refreshAfter();
}

/* --- 第三段：三级联动「当前生成使用」 --- */
function renderActiveSelects(){
  const selG=$('#c_selGroup'), selK=$('#c_selKey'), selM=$('#c_selModel');
  if(!selG || !editCfg) return;
  const act = editCfg.active || {};
  selG.innerHTML = editCfg.groups.map(g=>`<option value="${esc(g.id)}">${esc(g.label)}</option>`).join('');
  selG.value = editCfg.groups.some(g=>g.id===act.groupId) ? act.groupId : (editCfg.groups[0]?editCfg.groups[0].id:'');
  const g = editCfg.groups.find(x=>x.id===selG.value) || editCfg.groups[0];
  const keys = g?g.keys:[];
  selK.innerHTML = keys.map(k=>`<option value="${esc(k.id)}">${esc(k.label)}${k.key?'':'（未填）'}</option>`).join('');
  selK.value = keys.some(k=>k.id===act.keyId) ? act.keyId : (keys[0]?keys[0].id:'');
  const models = g?g.models:[];
  selM.innerHTML = models.map(m=>`<option value="${esc(m.name)}">${esc(m.label)}${m.kind==='flash'?' ⚡':''}</option>`).join('');
  selM.value = models.some(m=>m.name===act.model) ? act.model : (models[0]?models[0].name:'');
}

function saveSettings(){
  if(!editCfg){ return; }
  saveTemps();   // v10.16 温度保存已拆出（与主题面板共用）
  const selG=$('#c_selGroup'), selK=$('#c_selKey'), selM=$('#c_selModel');
  if(selG){
    const gId=selG.value || (editCfg.groups[0] && editCfg.groups[0].id);
    editCfg.active = { groupId:gId, keyId:(selK&&selK.value)||null, model:(selM&&selM.value)||'' };
  }
  saveCfg(editCfg);
  const st=$('#cfgStatus'); if(st){ st.className='status ok'; st.textContent='已保存到本机浏览器。'; }
  toast('配置已保存');
  updateCfgBadge();
}
async function testConn(){
  const st = $('#cfgStatus'); if(st){ st.className='status'; st.textContent='测试中…'; }
  saveSettings();
  try{
    const r = unwrapAIResult(await callDeepSeek('你是测试助手，只回复「ok」。','你好'));
    if(st){ st.className='status ok'; st.textContent='连接成功：'+r.slice(0,20); }
  }catch(e){
    if(st){
      st.className='status err';
      let msg = e.message;
      if(/insufficient balance/i.test(msg)) msg += '（账户余额不足，请到对应控制台充值，不是 Key 填错）';
      else if(/not found.*model/i.test(msg)) msg += '（模型名不存在，请检查当前所选模型）';
      st.textContent='连接失败：'+msg;
    }
  }
}

/* =========================================================
 * 初始化
 * ========================================================= */
// 启动加载遮罩（首次 await 读取 IDB，毫秒级，无感；IDB 失败也有兜底不卡死）
function showBootLoading(show){
  const el = $('#bootLoading'); if(!el) return;
  el.classList.toggle('hidden', !show);
}
async function init(){
  showBootLoading(true);
  try{ await loadState(); }catch(e){ /* 兜底：保持空白 state，不卡死 */ }
  loadGlib();                        // v8 词典库（跨作品复用）
  // 应用已保存主题（统一走 applyTheme，保证 mecha nav 显隐等副作用一致）
  const c = getCfg();
  applyTheme(c.theme || 'dark');
  // 顶栏设置
  $('#btnSettings').onclick = openSettings;
  // P2-1 顶栏「🗒️ 日志」入口
  const btnLog = $('#btnAiLog');
  if(btnLog) btnLog.onclick = (e)=>{ e.stopPropagation(); openAiLogPanel(); };
  // 历史作品按钮：展开/收起弹层；新建小说 / 新建长篇按钮
  rebindHistPanel();
  // 写作风格配色按钮（顶栏 🎨）：展开/收起配色弹层 + 选择即着色
  rebindWsColorPanel();
  // 主题按钮：展开/收起主题弹层
  const btnTheme = $('#btnTheme');
  if(btnTheme) btnTheme.onclick = (e)=>{ e.stopPropagation(); const p=$('#themePanel'); if(p.classList.contains('hidden')) openThemePanel(); else closeThemePanel(); };
  // 叙事引擎按钮与抽屉
  rebindNarrativeEngine();
  // v10.16 主题面板「保存温度」：仅保存 7 个温度字段（独立于设置弹窗，不影响其他配置）
  const btnTS = $('#btnTempSave');
  if(btnTS) btnTS.onclick = (e)=>{
    e.stopPropagation();
    if(!editCfg) editCfg = JSON.parse(JSON.stringify(getCfg()));
    saveTemps();
    saveCfg(editCfg);
    updateCfgBadge();
    toast('温度已保存');
  };
  // 点击空白处关闭主题/历史/配色弹层
  document.addEventListener('click', (e)=>{
    const t = $('#themePanel'); if(t && !t.classList.contains('hidden') && !t.contains(e.target) && !e.target.closest('#btnTheme')) closeThemePanel();
    const h = $('#histPanel'); if(h && !h.classList.contains('hidden') && !h.contains(e.target) && !e.target.closest('#btnHist')) closeHistPanel();
    const col = $('#wsColorPanel'); if(col && !col.classList.contains('hidden') && !col.contains(e.target) && !e.target.closest('#btnWsColor')) closeWsColorPanel();
  });
  $$('[data-close]').forEach(b=> b.onclick = closeSettings);
  $('#btnCfgSave').onclick = ()=>{ saveSettings(); closeSettings(); };   // v10.10 保存后自动关闭设置窗口（测试连接仍走 testConn，不关窗）
  $('#btnCfgTest').onclick = testConn;
  // v227「使用不同AI」分任务模型二级面板
  $('#btnTaskModels').onclick = openTaskModelPanel;
  $('#btnTmSave').onclick = saveTaskModels;
  $('#btnTmReset').onclick = ()=>{
    if(!window.confirm('确定清除全部分任务设置，全部恢复跟随全局？')) return;
    TM_KEYS.forEach(k=>{ editTM[k]=''; });
    renderTaskModelPanel();
  };
  $$('#taskModelModal [data-tm-close]').forEach(el=> el.onclick = requestCloseTaskModelPanel);
  // 多 AI 模型控件
  const btnAddG = $('#btnAddGroup'); if(btnAddG) btnAddG.onclick = addGroup;
  const selG=$('#c_selGroup'), selK=$('#c_selKey'), selM=$('#c_selModel');
  if(selG) selG.onchange = ()=>{ if(editCfg){ editCfg.active.groupId = selG.value; renderActiveSelects(); updateCfgBadge(); } };
  if(selK) selK.onchange = ()=>{ if(editCfg){ editCfg.active.keyId = selK.value; updateCfgBadge(); } };
  if(selM) selM.onchange = ()=>{ if(editCfg){ editCfg.active.model = selM.value; updateCfgBadge(); } };
  const cfgBadge=$('#cfgBadge'); if(cfgBadge) cfgBadge.onclick = openSettings;
  updateCfgBadge();
  // 主题按钮（顶栏 🎨 弹层内）：点击即应用并收起
  $$('.theme-btns .theme').forEach(b=> b.onclick = ()=>{ applyTheme(b.dataset.theme); closeThemePanel(); });
  // 机甲主题顶部胶囊导航
  const mtn = $('#mechaTopNav');
  if(mtn){
    $$('.cap', mtn).forEach(c=> c.onclick = ()=>{
      if(c.dataset.export){ currentStep = 5; }
      else { currentStep = +c.dataset.step; }
      render(); window.scrollTo(0,0);
    });
  }
  // 底部导航
  $$('.tab').forEach(t=> t.onclick = ()=>{ if(!guardSwitchStep()) return; currentStep = +t.dataset.step; render(); window.scrollTo(0,0); });
  // 首次进入直接渲染主界面（不再自动弹设置；用户可随时点右上角 ☰ 配置 API Key）
  showBootLoading(false);
  render();
}
document.addEventListener('DOMContentLoaded', init);
