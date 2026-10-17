/* =====================================================================
   UTIL
   ===================================================================== */
const RANGES = {'24h':{days:1,label:'Last 24 hours'},'7d':{days:7,label:'Last 7 days'},'30d':{days:30,label:'Last 30 days'}};
// API strings land in innerHTML templates; neutralise markup once at ingest.
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
function rng(seed){ let t = seed>>>0; return ()=>{ t += 0x6D2B79F5; let r = Math.imul(t ^ t>>>15, 1|t); r ^= r + Math.imul(r ^ r>>>7, 61|r); return ((r ^ r>>>14)>>>0)/4294967296; }; }
function hash(s){ let h=2166136261; for (const c of s){ h ^= c.charCodeAt(0); h = Math.imul(h,16777619); } return h>>>0; }
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const easeOut=t=>1-Math.pow(1-t,3);
function fmt(n){ if (n>=1e9) return (n/1e9).toFixed(n<1e10?2:1)+'B'; if (n>=1e6) return (n/1e6).toFixed(n<1e7?2:1)+'M'; if (n>=1e3) return (n/1e3).toFixed(n<1e4?1:0)+'k'; return Math.round(n).toString(); }
function money(n){ return n>=1000? '$'+(n/1000).toFixed(2)+'k' : n>=100? '$'+n.toFixed(0) : '$'+n.toFixed(2); }
function pct(n){ return n.toFixed(n<10?1:0)+'%'; }
function hexToRgb(h){ h=h.replace('#',''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; }
function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
let HEAT = [];
function readHeat(){ HEAT = ['--heat-0','--heat-1','--heat-2'].map(v=>hexToRgb(cssVar(v))); }
function heat(t){ t=clamp(t,0,1); const [a,b] = t<.5? [HEAT[0],HEAT[1]] : [HEAT[1],HEAT[2]]; const u = t<.5? t*2 : (t-.5)*2; return `rgb(${Math.round(lerp(a[0],b[0],u))},${Math.round(lerp(a[1],b[1],u))},${Math.round(lerp(a[2],b[2],u))})`; }
function tween(dur, step, done){ if (reduced || dur<=0){ step(1); done&&done(); return; } const t0=performance.now(); (function f(now){ const t=clamp((now-t0)/dur,0,1); step(easeOut(t)); if (t<1) requestAnimationFrame(f); else done&&done(); })(t0); }
const el=(tag,attrs={},parent)=>{ const n=document.createElementNS('http://www.w3.org/2000/svg',tag); for (const k in attrs) n.setAttribute(k,attrs[k]); parent&&parent.appendChild(n); return n; };
function sparkPath(vals,w,h,pad=2){ const mx=Math.max(...vals), mn=Math.min(...vals)*.9; return vals.map((v,i)=>[ (i/(vals.length-1))*w, pad + (1-(v-mn)/((mx-mn)||1))*(h-pad*2) ]); }

/* =====================================================================
   STATE + DERIVED DATA
   ===================================================================== */
// URL is the state: ?range=24h|7d|30d&app=<id>&theme=light|dark, so any view is a shareable link.
const QS = new URLSearchParams(location.search);
const state = { range: RANGES[QS.get('range')] ? QS.get('range') : '24h', app: QS.get('app') || null, hover:null };
function syncUrl(){ const q=new URLSearchParams(); if (state.range!=='24h') q.set('range',state.range); if (state.app) q.set('app',state.app); history.replaceState(null,'',location.pathname+(q.size?'?'+q:'')); }
function syncChip(){ const chip=document.getElementById('chip'); chip.classList.toggle('on',!!state.app); if (state.app) document.getElementById('chipname').textContent=appName(state.app); }
let D = null;   // last /api/usage response
let LIFE = {};  // model -> lifecycle notice (config/model-lifecycle.json)
const SEV_ORDER = {retired:0, urgent:1, deprecated:2, watch:3};
const SEV_LABEL = {retired:'Retired', urgent:'Retiring soon', deprecated:'Deprecated', watch:'Watch'};
let APPS = {}, WORKERS = [], WORKER_APP = {}, GATEWAYS = [], PROVIDERS = [], MODELS = [], ALL = [];
const GW_LABEL = {binding:'Workers AI binding', direct:'Direct (no gateway)'};
const PROV_LABEL = {anthropic:'Anthropic', openai:'OpenAI', 'workers-ai':'Workers AI', 'google-ai-studio':'Google AI Studio', 'azure-openai':'Azure OpenAI', 'aws-bedrock':'AWS Bedrock'};
const SOURCE_LABEL = {gateway:'AI Gateway analytics', anthropic:'Anthropic Admin API (direct keys)', openai:'OpenAI Usage API (direct keys)', workers_ai:'Workers AI analytics (binding)'};

function ingest(d){
  D = d;
  APPS = Object.fromEntries(Object.entries(d.apps).map(([id,name])=>[id,{name:esc(name)}]));
  // Live throughput (last hour, 5-minute grain) per flow, for the particles.
  const fkey = f => [f.app,f.gateway,f.provider,f.model,f.source].join('|');
  const live = new Map((d.live||[]).map(l=>[fkey(l), l.tokens/((d.liveWindow||3600)/60)]));
  ALL = d.flows.filter(f=>f.tokens_in+f.tokens_out+f.requests>0).map(f=>{
    const prov = esc(PROV_LABEL[f.provider]||f.provider), model=esc(f.model), gw=esc(f.gateway), tok=f.tokens_in+f.tokens_out, req=f.requests;
    if (!APPS[f.app]) APPS[f.app]={name:esc(f.app)};
    return { i:[f.app,gw,prov,model,f.source].join('|'), worker:f.app, app:f.app, gw, prov, model, label:SOURCE_LABEL[f.source]||esc(f.source), source:f.source,
      tokIn:f.tokens_in, tokOut:f.tokens_out, tok, cachedPct:f.tokens_in? f.tokens_cached/f.tokens_in*100 : 0, req, cost:f.cost_usd,
      p50:req? f.latency_ms/req : 0, err:req? f.errors/req*100 : 0, rpm:req/(d.days*1440), tpm:live.get(fkey(f))||0, direct:gw==='direct',
      path:['a:'+f.app,'g:'+gw,'p:'+prov,'m:'+model] };
  });
  const byTok = key => { const m={}; for (const f of ALL) m[f[key]]=(m[f[key]]||0)+f.tok; return Object.keys(m).sort((a,b)=>m[b]-m[a]); };
  WORKERS = byTok('app').map(a=>[a,a]); WORKER_APP = Object.fromEntries(WORKERS);
  GATEWAYS = byTok('gw').filter(g=>g!=='binding'&&g!=='direct').concat(['binding','direct'].filter(g=>ALL.some(f=>f.gw===g)));
  PROVIDERS = byTok('prov'); MODELS = byTok('model');
  LIFE = Object.fromEntries((d.lifecycle||[]).map(n=>[esc(n.model), n]));
  ingestBilling(d);
}
/** Per-bucket totals of one metric across the range, zero-filled. */
function seriesFor(metric, app=state.app){
  const n = Math.round(D.days*86400/D.width), m = new Map();
  for (const s of D.series){ if (app && s.app!==app) continue; m.set(s.ts,(m.get(s.ts)||0)+s[metric]); }
  return Array.from({length:n},(_,i)=>m.get(D.start+i*D.width)||0);
}
function agg(flows){
  const s = {tokIn:0,tokOut:0,tok:0,req:0,cost:0,cachedTok:0,p50w:0,errw:0,gwTok:0,n:flows.length};
  for (const f of flows){ s.tokIn+=f.tokIn; s.tokOut+=f.tokOut; s.tok+=f.tok; s.req+=f.req; s.cost+=f.cost; s.cachedTok+=f.tokIn*f.cachedPct/100; s.p50w+=f.p50*f.req; s.errw+=f.err*f.req; if (!f.direct && f.gw!=='binding') s.gwTok+=f.tok; }
  s.cached = s.tokIn? s.cachedTok/s.tokIn*100 : 0; s.p50 = s.req? s.p50w/s.req : 0; s.err = s.req? s.errw/s.req : 0; s.gwPct = s.tok? s.gwTok/s.tok*100 : 0;
  return s;
}
const visible = ()=> state.app ? ALL.filter(f=>f.app===state.app) : ALL;

/* =====================================================================
   KPI STRIP
   ===================================================================== */
const KPI_DEFS = [
  {id:'spend', lbl:'AI spend', val:s=>s.cost, fmt:money, metric:'cost'},
  {id:'tokens', lbl:'Tokens', val:s=>s.tok, fmt:fmt, metric:'tokens'},
  {id:'req', lbl:'Requests', val:s=>s.req, fmt:fmt, metric:'requests'},
  {id:'cache', lbl:'Cache hit rate', val:s=>s.cached, fmt:pct, delta:'prompt-cached input tokens', sub:true},
  {id:'gw', lbl:'Via AI Gateway', val:s=>s.gwPct, fmt:pct, delta:'share of tokens with gateway logs', sub:true},
  {id:'neurons', lbl:'Workers AI neurons', val:s=>s.neurons, fmt:fmt, meter:true},
];
const kpiState = {};
function buildKpis(){
  const root = document.getElementById('kpis');
  root.innerHTML = '<svg width="0" height="0" style="position:absolute"><defs><linearGradient id="sparkfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".28"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs></svg>';
  for (const d of KPI_DEFS){
    const c = document.createElement('article'); c.className='card kpi'; c.id='kpi-'+d.id;
    c.innerHTML = `<div class="lbl">${d.lbl} <span class="rl"></span></div><div class="val"><span class="n">0</span><small class="x"></small></div>
      ${d.meter? '<div class="meter"><i></i></div><div class="delta b"></div>' : `<div class="delta">${d.delta||''}</div>${d.metric?'<svg class="spark" viewBox="0 0 160 34" preserveAspectRatio="none"><path class="area"/><path class="line"/><circle class="dot" r="2.4"/></svg>':''}`}`;
    root.appendChild(c); kpiState[d.id]={cur:0};
  }
}
function updateKpis(){
  const s = agg(visible());
  const days = RANGES[state.range].days;
  const units = D.cloudflare.unitsByApp; s.neurons = Object.entries(units).reduce((a,[app,u])=> a + (!state.app||app===state.app? (u.ai||0) : 0), 0);
  const aiComp = D.cloudflare.components.find(c=>c.key==='ai'); const budget = aiComp? aiComp.included*days/30 : 1;
  const prior = D.prior||{}, priorOf = {cost:prior.cost, tokens:prior.tokens, requests:prior.requests};
  for (const d of KPI_DEFS){
    const c = document.getElementById('kpi-'+d.id), n=c.querySelector('.n'), ks=kpiState[d.id];
    c.querySelector('.rl').textContent = '· '+state.range;
    const target = d.val(s), from = ks.cur;
    tween(1000, t=>{ n.textContent = d.fmt(lerp(from,target,t)); });
    ks.cur = target;
    if (d.meter){
      const over = s.neurons>budget; const bar=c.querySelector('.meter i'); bar.classList.toggle('over',over); bar.style.transform=`scaleX(${clamp(s.neurons/budget,0,1)})`;
      c.querySelector('.x').textContent=' / '+fmt(budget); c.querySelector('.b').textContent = over? `${pct((s.neurons/budget-1)*100)} over included allowance` : `${pct(s.neurons/budget*100)} of included allowance`;
      c.querySelector('.b').className='delta b '+(over?'down':'');
    } else if (d.metric) {
      const p0 = priorOf[d.metric], de=c.querySelector('.delta');
      if (p0) { const ch=(target/p0-1)*100; de.textContent=`${ch>=0?'+':''}${ch.toFixed(1)}% vs prior ${state.range}`; de.className='delta '+(ch>=0?'up':'down'); }
      else { de.textContent='no prior period collected'; de.className='delta'; }
      const vals = seriesFor(d.metric);
      const p = sparkPath(vals,160,34);
      const line = p.map((q,i)=>(i?'L':'M')+q[0].toFixed(1)+' '+q[1].toFixed(1)).join('');
      c.querySelector('.line').setAttribute('d',line);
      c.querySelector('.area').setAttribute('d',line+`L160 34L0 34Z`);
      const last=p[p.length-1]; const dot=c.querySelector('.dot'); dot.setAttribute('cx',last[0]); dot.setAttribute('cy',last[1]);
    }
  }
}

/* =====================================================================
   FLOW GRAPH (Sankey + particles)
   ===================================================================== */
const svg = document.getElementById('flowsvg'), canvas=document.getElementById('flowcanvas'), stage=document.getElementById('stage'), tip=document.getElementById('tip');
const gLinks = el('g',{class:'links'},svg), gNodes = el('g',{class:'nodes'},svg), gHead = el('g',{},svg);
const NW = 14, PAD_T = 44, PAD_B = 20;
let geom = { nodes:{}, links:{} };   // current (animated) geometry
let elems = { nodes:{}, links:{} };  // DOM
let particles = {};                  // link key -> array
let heatDomain = [0,1];
let W = 1180, H = 700;

function colX(){ const x0 = 300, x3 = W - 372; return [x0, x0+(x3-x0)*.36, x0+(x3-x0)*.67, x3]; }
function layout(flows){
  flows = flows.filter(f=>f.tok>0); // ribbon width is tokens; zero-token flows have no geometry
  const xs = colX();
  const canon = [WORKERS.map(w=>'a:'+w[0]), GATEWAYS.map(g=>'g:'+g), PROVIDERS.map(p=>'p:'+p), MODELS.map(m=>'m:'+m)];
  const val={}; let total=0;
  for (const f of flows){ total+=f.tok; for (const id of f.path) val[id]=(val[id]||0)+f.tok; }
  const nodes={}; let kG=Infinity; const cols=[];
  canon.forEach((ids,c)=>{
    const present = ids.filter(id=>val[id]); const n=present.length; const gap = n>8? 10 : 16, minH=6;
    const avail = H-PAD_T-PAD_B-gap*(n-1)-minH*n; const k = total? avail/total : 0; kG=Math.min(kG,k);
    cols.push({present,k,gap,minH});
  });
  canon.forEach((ids,c)=>{
    const {present,gap,minH}=cols[c]; let y=PAD_T; const hs = present.map(id=>minH+val[id]*kG); const used = hs.reduce((a,b)=>a+b,0)+gap*(present.length-1);
    y += (H-PAD_T-PAD_B-used)/2;
    present.forEach((id,i)=>{ nodes[id]={id,col:c,x:xs[c],y,h:hs[i],v:val[id]}; y+=hs[i]+gap; });
  });
  // links
  const links={}; const outAt={}, inAt={};
  const byKey = {};
  for (const f of flows) for (let s=0;s<3;s++){ const key=f.i+':'+s; byKey[key]={f,s,src:nodes[f.path[s]],dst:nodes[f.path[s+1]],w:f.tok*kG}; }
  const list = Object.values(byKey);
  // stack out-links by destination y, in-links by source y
  const groupsOut={}, groupsIn={};
  for (const L of list){ (groupsOut[L.src.id] ||= []).push(L); (groupsIn[L.dst.id] ||= []).push(L); }
  for (const id in groupsOut){ const g=groupsOut[id].sort((a,b)=>a.dst.y-b.dst.y); const sum=g.reduce((a,l)=>a+l.w,0); let y=nodes[id].y+(nodes[id].h-sum)/2; for (const l of g){ l.sy=y+l.w/2; y+=l.w; } }
  for (const id in groupsIn){ const g=groupsIn[id].sort((a,b)=>a.src.y-b.src.y); const sum=g.reduce((a,l)=>a+l.w,0); let y=nodes[id].y+(nodes[id].h-sum)/2; for (const l of g){ l.ty=y+l.w/2; y+=l.w; } }
  for (const L of list){ links[L.f.i+':'+L.s] = {x0:L.src.x+NW, x1:L.dst.x, sy:L.sy, ty:L.ty, w:L.w, f:L.f, s:L.s}; }
  return {nodes,links};
}
const linkPath = g => { const mx=(g.x0+g.x1)/2; return `M${g.x0} ${g.sy}C${mx} ${g.sy} ${mx} ${g.ty} ${g.x1} ${g.ty}`; };
function heatT(tok){ const [a,b]=heatDomain; return Math.pow(clamp((Math.log10(tok+1)-a)/((b-a)||1),0,1),1.5); }

function nodeLabel(id){
  const [t,name] = [id[0], id.slice(2)];
  if (t==='a') return {main:(APPS[name]||{name}).name, id:name}; // node may be animating out after a range switch
  if (t==='g') return {main: GW_LABEL[name] || 'AI Gateway: '+name, id:''};
  if (t==='p') return {main:name, id:''};
  return {main:'', id:name};
}
function ensureElems(nodesNext, linksNext){
  for (const k in linksNext) if (!elems.links[k]){
    const f0 = linksNext[k].f, fid = f0.i, cur = ()=> ALL.find(x=>x.i===fid) || f0; const p = el('path',{class:'link'+(f0.direct?' direct':''),'data-flow':fid}, gLinks);
    p.style.animationDelay = (-((hash(fid)%100)*.37)%4.2).toFixed(2)+'s';
    p.addEventListener('mouseenter',e=>hoverFlow([fid],e,linkTip(cur()))); p.addEventListener('mousemove',moveTip); p.addEventListener('mouseleave',unhover);
    p.addEventListener('click',()=>setApp(cur().app));
    elems.links[k]=p;
  }
  for (const id in nodesNext) if (!elems.nodes[id]){
    const t=id[0]; const g=el('g',{class:'node '+(t==='a'?'app':'')+(id==='g:direct'?' direct':''),'data-id':id}, gNodes);
    el('line',{class:'lead'},g);
    const r=el('rect',{rx:3,ry:3},g); const lab=nodeLabel(id);
    const anchor = t==='a'? 'end' : 'start';
    if (lab.main){ el('text',{class:'main'+(id==='g:direct'?' warn':''),'text-anchor':anchor},g); }
    if (lab.id || t!=='a'){ el('text',{class:'id','text-anchor':anchor},g); }
    g.addEventListener('mouseenter',e=>{ const fl = visible().filter(f=>f.path.includes(id)).map(f=>f.i); hoverFlow(fl,e,nodeTip(id)); });
    g.addEventListener('mousemove',moveTip); g.addEventListener('mouseleave',unhover);
    g.addEventListener('click',()=>{ if (t==='a') setApp(WORKER_APP[id.slice(2)]); });
    elems.nodes[id]=g;
  }
}
function applyGeom(){
  for (const k in geom.links){ const g=geom.links[k], p=elems.links[k]; if (!p) continue; p.setAttribute('d',linkPath(g)); p.setAttribute('stroke-width',Math.max(g.w,.6)); p.setAttribute('stroke',heat(heatT(g.f.tok))); p.style.display = g.w<.05?'none':''; }
  const cols=[[],[],[],[]];
  for (const id in geom.nodes){ const n=geom.nodes[id], g=elems.nodes[id]; if (!g) continue; const r=g.querySelector('rect'); r.setAttribute('x',n.x); r.setAttribute('y',n.y); r.setAttribute('width',NW); r.setAttribute('height',Math.max(n.h,0)); r.setAttribute('fill',heat(heatT(n.v)));
    g.style.display = n.h<.05?'none':''; if (n.h>=.05) cols[n.col].push(n); }
  // labels: stack so they never overlap, leader line when displaced
  cols.forEach(list=>{
    list.sort((a,b)=>a.y-b.y);
    const sp = list.map(n=> n.id[0]==='a'? 30 : 16);
    const pos = list.map(n=>n.y+n.h/2);
    for (let i=1;i<list.length;i++) pos[i]=Math.max(pos[i], pos[i-1]+(sp[i-1]+sp[i])/2);
    const lim = H-PAD_B-4; if (list.length){ pos[list.length-1]=Math.min(pos[list.length-1], lim); for (let i=list.length-2;i>=0;i--) pos[i]=Math.min(pos[i], pos[i+1]-(sp[i]+sp[i+1])/2); }
    list.forEach((n,i)=>{ const g=elems.nodes[n.id]; const t=n.id[0]; const lab=nodeLabel(n.id); const tok=fmt(n.v)+' tok';
      const tx = t==='a'? n.x-14 : n.x+NW+14; const cy=pos[i];
      const main=g.querySelector('.main'), idt=g.querySelector('.id');
      if (t==='a'){ main.textContent=lab.main; idt.textContent=lab.id+' · '+tok; main.setAttribute('x',tx); main.setAttribute('y',cy-2); idt.setAttribute('x',tx); idt.setAttribute('y',cy+11); }
      else if (t==='m'){ const ln=LIFE[lab.id]; idt.textContent=(ln&&ln.severity!=='watch'?'⚠ ':'')+lab.id+' · '+tok+(ln&&ln.retires&&ln.severity!=='watch'?' · retires '+ln.retires:''); idt.classList.toggle('eol', !!ln && ln.severity!=='watch'); idt.setAttribute('x',tx); idt.setAttribute('y',cy+4); }
      else { main.textContent=(n.id==='g:direct'?'⚠ ':'')+lab.main; main.setAttribute('x',tx); main.setAttribute('y',cy+4); idt.textContent=''; }
      const lead=g.querySelector('.lead'); const ncy=n.y+n.h/2; const x0 = t==='a'? n.x : n.x+NW, x1 = t==='a'? n.x-10 : n.x+NW+10;
      lead.setAttribute('x1',x0); lead.setAttribute('y1',ncy); lead.setAttribute('x2',x1); lead.setAttribute('y2',cy); lead.style.opacity = Math.abs(cy-ncy)>3 ? 1 : 0;
    });
  });
}
function relayout(animate=true){
  const flows = visible();
  const toks = ALL.map(f=>Math.log10(f.tok+1)); heatDomain=[Math.min(...toks), Math.max(...toks)];
  const next = layout(flows);
  ensureElems(next.nodes, next.links);
  const from = { nodes:{...geom.nodes}, links:{...geom.links} };
  const keysL = new Set([...Object.keys(from.links),...Object.keys(next.links)]);
  const keysN = new Set([...Object.keys(from.nodes),...Object.keys(next.nodes)]);
  const fromL={}, toL={}, fromN={}, toN={};
  for (const k of keysL){ const a=from.links[k], b=next.links[k]; fromL[k]= a || {...b,w:0}; toL[k]= b || {...a,w:0}; }
  for (const k of keysN){ const a=from.nodes[k], b=next.nodes[k]; fromN[k]= a || {...b,h:0,y:b.y+b.h/2}; toN[k]= b || {...a,h:0,y:a.y+a.h/2}; }
  syncParticles(next.links);
  tween(animate?900:0, t=>{
    for (const k of keysL){ const a=fromL[k], b=toL[k]; geom.links[k]={x0:lerp(a.x0,b.x0,t),x1:lerp(a.x1,b.x1,t),sy:lerp(a.sy,b.sy,t),ty:lerp(a.ty,b.ty,t),w:lerp(a.w,b.w,t),f:b.f,s:b.s}; }
    for (const k of keysN){ const a=fromN[k], b=toN[k]; geom.nodes[k]={...b, x:lerp(a.x,b.x,t), y:lerp(a.y,b.y,t), h:lerp(a.h,b.h,t), v:lerp(a.v,b.v,t)}; }
    applyGeom();
  }, ()=>{
    for (const k of keysL) if (!next.links[k]){ elems.links[k].remove(); delete elems.links[k]; delete geom.links[k]; delete particles[k]; }
    for (const k of keysN) if (!next.nodes[k]){ elems.nodes[k].remove(); delete elems.nodes[k]; delete geom.nodes[k]; }
  });
  drawHeads();
  const fe=document.getElementById('flowempty'); fe.classList.toggle('on', flows.length===0);
  if (!flows.length) fe.innerHTML = state.app ? `<div><b>No AI traffic for ${appName(state.app)}</b>Nothing collected for this app in the ${RANGES[state.range].label.toLowerCase()}. Its Cloudflare usage and billing are shown below.</div>`
    : `<div><b>No AI traffic collected yet</b>The collector runs every 5 minutes. Check the status badge for errors, or POST /api/collect?hours=24 to backfill.</div>`;
  document.querySelectorAll('.node.app').forEach(g=>g.classList.toggle('sel', !!state.app && WORKER_APP[g.dataset.id.slice(2)]===state.app));
}
function drawHeads(){
  gHead.innerHTML=''; const xs=colX();
  [['App','end',xs[0]+NW],['Cloudflare AI Gateway','start',xs[1]],['Provider','start',xs[2]],['Model','start',xs[3]]].forEach(([t,a,x])=>{ el('text',{class:'colhead',x,y:22,'text-anchor':a},gHead).textContent=t; });
}
// particles
const tpmMax = ()=> Math.max(1e-9, ...ALL.map(f=>f.tpm));
function syncParticles(links){
  const mx = Math.log2(1+tpmMax());
  for (const k in links){ const f=links[k].f; // Particles = live tokens/min over the last hour; an idle flow has none.
    const norm = Math.log2(1+f.tpm)/mx; const count = f.tpm>0 ? Math.round(1+norm*norm*11) : 0;
    const arr = particles[k] || []; const r=rng(hash(k));
    while (arr.length<count) arr.push({t:r(), lane:(r()-.5), sp:0});
    arr.length = count; for (const p of arr) p.sp = (.0009+ .0036*norm)*(.85+(hash(k+p.lane)%100)/333);
    particles[k]=arr; }
}
function bez(g,t){ const mx=(g.x0+g.x1)/2; const u=1-t; const b0=u*u*u,b1=3*u*u*t,b2=3*u*t*t,b3=t*t*t;
  const x=b0*g.x0+b1*mx+b2*mx+b3*g.x1, y=b0*g.sy+b1*g.sy+b2*g.ty+b3*g.ty;
  const dx=3*u*u*(mx-g.x0)+6*u*t*(0)+3*t*t*(g.x1-mx), dy=6*u*t*(g.ty-g.sy); const l=Math.hypot(dx,dy)||1; return [x,y,-dy/l,dx/l]; }
let ctx, dpr=1, lastT=0;
function sizeCanvas(){ dpr=Math.min(devicePixelRatio||1,2); canvas.width=W*dpr; canvas.height=H*dpr; ctx=canvas.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); }
function drawParticles(now){
  const dt = Math.min(now-lastT, 50); lastT=now; ctx.clearRect(0,0,W,H);
  const hover = state.hover; const [h0,h1,h2]=HEAT.map(c=>c);
  for (const k in geom.links){ const g=geom.links[k]; if (g.w<.5) continue; const arr=particles[k]; if (!arr) continue;
    const hi = !hover || hover.has(g.f.i); const alpha = hi? .95 : .06; const col = heat(clamp(heatT(g.f.tok)+.12,0,1));
    const rad = clamp(g.w*.16, 1, 2.6);
    for (const p of arr){ p.t += p.sp*dt; if (p.t>1) p.t-=1; const [x,y,nx,ny]=bez(g,p.t); const off=p.lane*g.w*.8; const px=x+nx*off, py=y+ny*off;
      ctx.globalAlpha = alpha*.28; ctx.fillStyle=col; ctx.beginPath(); ctx.arc(px,py,rad*2,0,6.283); ctx.fill();
      ctx.globalAlpha = alpha*.85; ctx.fillStyle = hi? '#fff' : col; ctx.beginPath(); ctx.arc(px,py,rad*.6,0,6.283); ctx.fill(); }
  }
  ctx.globalAlpha=1;
  requestAnimationFrame(drawParticles);
}
// hover / tooltips
function hoverFlow(ids,e,html){ state.hover=new Set(ids); stage.classList.add('dimmed');
  for (const k in elems.links) elems.links[k].classList.toggle('hi', state.hover.has(elems.links[k].dataset.flow));
  const nodeIds = new Set(); for (const f of visible()) if (state.hover.has(f.i)) f.path.forEach(p=>nodeIds.add(p));
  for (const id in elems.nodes) elems.nodes[id].classList.toggle('hi', nodeIds.has(id));
  tip.innerHTML=html; tip.classList.add('on'); moveTip(e); }
function unhover(){ state.hover=null; stage.classList.remove('dimmed'); tip.classList.remove('on'); }
function moveTip(e){ const r=stage.getBoundingClientRect(); let x=e.clientX-r.left+16, y=e.clientY-r.top+16; const tw=tip.offsetWidth, th=tip.offsetHeight; const wrap=document.getElementById('flowwrap'); const vx = wrap.scrollLeft + wrap.clientWidth; if (x+tw>vx-8) x = e.clientX-r.left-tw-16; if (y+th>H-8) y = e.clientY-r.top-th-12; tip.style.left=x+'px'; tip.style.top=y+'px'; }
function statsHtml(s){ return `<dl><dt>Tokens in / out</dt><dd>${fmt(s.tokIn)} / ${fmt(s.tokOut)}</dd><dt>Cached input</dt><dd>${pct(s.cached)}</dd><dt>Requests</dt><dd>${fmt(s.req)}</dd><dt>Cost</dt><dd>${money(s.cost)}</dd><dt>p50 latency</dt><dd>${s.p50? Math.round(s.p50).toLocaleString()+' ms' : '—'}</dd><dt>Error rate</dt><dd>${s.req? s.err.toFixed(2)+'%' : '—'}</dd></dl>`; }
function linkTip(f){ const s=agg([f]); return `<h4>${APPS[f.app].name} · ${f.label}</h4><div class="k">${f.worker} → ${f.gw==='direct'?'direct':f.gw==='binding'?'binding':'gw:'+f.gw} → ${f.prov} → ${f.model}</div>${statsHtml(s)}<div class="route">${lifeLine(f.model)}${f.direct? '<b>⚠ bypasses AI Gateway</b> — no gateway logs, caching or rate limits · ' : ''}${f.tpm? fmt(f.tpm)+' tok/min in the last hour' : 'idle in the last hour'}</div>`; }
function lifeLine(model){ const n=LIFE[model]; if(!n) return '';
  const when = n.severity==='watch'? `earliest retirement ${n.retires}` : n.daysLeft!=null && n.daysLeft<=0? `retired ${n.retires}` : `retires ${n.retires} (${n.daysLeft} days)`;
  return `<b>⚠ ${SEV_LABEL[n.severity]}</b> · ${when}${n.replacement? ' · replace with '+esc(n.replacement):''}<br>`; }
function nodeTip(id){ const fl=visible().filter(f=>f.path.includes(id)); const s=agg(fl); const lab=nodeLabel(id); const t=id[0];
  const title = t==='a'? lab.main : t==='g'? (GW_LABEL[id.slice(2)]||'AI Gateway · '+id.slice(2)) : t==='p'? id.slice(2) : id.slice(2);
  const apps=[...new Set(fl.map(f=>APPS[f.app].name))], models=[...new Set(fl.map(f=>f.model))];
  return `<h4>${title}</h4><div class="k">${t==='a'?lab.id:(t==='m'?'model':t==='p'?'provider':'gateway')} · ${fl.length} flow${fl.length>1?'s':''}</div>${statsHtml(s)}<div class="route">${t==='m'? lifeLine(id.slice(2)) : ''}${t!=='a'? '<b>from</b> '+apps.join(', ')+'<br>' : ''}${t!=='m'? '<b>models</b> '+models.join(', ') : ''}</div>`; }

/* =====================================================================
   SPEND BY SOURCE
   ===================================================================== */
function updateSources(){
  const v=visible(); const sum = a=>a.reduce((x,f)=>x+f.cost,0); const by = src=>v.filter(f=>f.source===src);
  const rows = [
    {name:'Cloudflare AI Gateway', amt:sum(by('gateway')), api:'GraphQL aiGatewayRequestsAdaptiveGroups · logged cost', note:`${by('gateway').length} gateway flows`, c:'var(--heat-0)'},
    {name:'Anthropic (direct keys)', amt:sum(by('anthropic')), api:'Admin API usage_report/messages × list price', note:'estimated from tokens', c:'var(--heat-1)'},
    {name:'OpenAI (direct keys)', amt:sum(by('openai')), api:'Usage API usage/completions × list price', note:'estimated from tokens', c:'var(--heat-2)'},
    {name:'Workers AI (binding)', amt:sum(by('workers_ai')), api:'GraphQL aiInferenceAdaptiveGroups · neurons × price', note:'before the free daily allowance', c:'var(--text-3)'},
  ];
  const total = rows.reduce((a,r)=>a+r.amt,0)||1;
  const root=document.getElementById('sources');
  if (!root.children.length){ root.innerHTML = rows.map((r,i)=>`<div class="srcrow" data-i="${i}"><span class="name">${r.name}</span><span class="amt num">$0</span><span class="bar"><i style="background:${r.c}"></i></span><span class="note"><span class="src">${r.api}</span><span class="share"></span></span></div>`).join(''); root._cur=[0,0,0,0]; }
  rows.forEach((r,i)=>{ const d=root.children[i]; const from=root._cur[i]; tween(900,t=>{ d.querySelector('.amt').textContent=money(lerp(from,r.amt,t)); }); root._cur[i]=r.amt;
    d.querySelector('.bar i').style.transform=`scaleX(${r.amt/total})`; d.querySelector('.share').textContent=`${pct(r.amt/total*100)} · ${r.note}`; });
  const inv = p => D.providerCost.filter(c=>c.provider===p).reduce((a,c)=>a+c.cost_usd,0);
  const direct = v.filter(f=>f.direct);
  document.getElementById('srcnote').innerHTML = `Provider invoices for this window (daily cost reports, all keys incl. gateway traffic): <b>Anthropic ${money(inv('anthropic'))}</b> · <b>OpenAI ${money(inv('openai'))}</b>. Treat those as the invoice and the rows above as the per-app breakdown. <b>${money(sum(direct))}</b> (${pct(sum(direct)/total*100)}) of spend in this view never touches a gateway.`;
}

/* =====================================================================
   MODEL LEADERBOARD (bubble)
   ===================================================================== */
const bub = document.getElementById('bubble');
function updateBubble(){
  const v=visible(); const byM={};
  for (const f of v){ if (!(f.tok>0)) continue; // log axis
    const m = byM[f.model] ||= {model:f.model, tok:0, cost:0, req:0, prov:f.prov}; m.tok+=f.tok; m.cost+=f.cost; m.req+=f.req; }
  const rows = Object.values(byM).sort((a,b)=>b.tok-a.tok);
  const BW = bub.clientWidth||600, BH=300, L=46, R=20, T=14, B=36;
  bub.setAttribute('viewBox',`0 0 ${BW} ${BH}`);
  const minX = rows.length? Math.log10(Math.min(...rows.map(r=>r.tok))*.6) : 5, maxX= rows.length? Math.log10(Math.max(...rows.map(r=>r.tok))*1.6) : 8;
  const maxY = rows.length? Math.max(...rows.map(r=>r.cost))*1.15 : 1; const maxR = rows.length? Math.max(...rows.map(r=>r.req)) : 1;
  const X = t=>L+(Math.log10(t)-minX)/(maxX-minX)*(BW-L-R), Y=c=>T+(1-Math.sqrt(c/maxY))*(BH-T-B), Rr=q=>6+Math.sqrt(q/maxR)*26;
  if (!bub._init){ bub._init=true; bub.innerHTML=''; el('g',{class:'ax'},bub); el('g',{class:'bubbles'},bub); el('g',{class:'labels'},bub); }
  const ax=bub.querySelector('.ax'); ax.innerHTML='';
  el('line',{class:'axis',x1:L,x2:BW-R,y1:BH-B,y2:BH-B},ax); el('line',{class:'axis',x1:L,x2:L,y1:T,y2:BH-B},ax);
  for (let e=Math.ceil(minX); e<=Math.floor(maxX); e++){ const x=X(Math.pow(10,e)); el('line',{class:'grid',x1:x,x2:x,y1:T,y2:BH-B},ax); el('text',{class:'tick',x,y:BH-B+14,'text-anchor':'middle'},ax).textContent=fmt(Math.pow(10,e)); }
  [0,.25,.5,.75,1].forEach(q=>{ const c=maxY*q*q; const y=Y(c); el('line',{class:'grid',x1:L,x2:BW-R,y1:y,y2:y},ax); el('text',{class:'tick',x:L-6,y:y+3,'text-anchor':'end'},ax).textContent=money(c).replace('.00',''); });
  el('text',{class:'axl',x:BW-R,y:BH-4,'text-anchor':'end'},ax).textContent='tokens (log)'; el('text',{class:'axl',x:L+4,y:T-2},ax).textContent='cost';
  const gb=bub.querySelector('.bubbles'), gl=bub.querySelector('.labels'); const seen=new Set();
  rows.forEach((r,i)=>{ seen.add(r.model); let c=gb.querySelector(`[data-m="${CSS.escape(r.model)}"]`); let lab=gl.querySelector(`[data-m="${CSS.escape(r.model)}"]`);
    if (!c){ c=el('circle',{'data-m':r.model,cx:X(r.tok),cy:BH-B,r:0,opacity:0},gb); el('title',{},c); lab=el('text',{class:'bl','data-m':r.model,opacity:0},gl); lab.textContent=r.model.replace('@cf/','').replace('-instruct',''); requestAnimationFrame(()=>requestAnimationFrame(()=>place())); } else place();
    function place(){ c.setAttribute('cx',X(r.tok)); c.setAttribute('cy',Y(r.cost)); c.setAttribute('r',Rr(r.req)); c.setAttribute('opacity',.88); c.setAttribute('fill',heat(heatT(r.tok))); c.querySelector('title').textContent=`${r.model}\n${fmt(r.tok)} tokens · ${money(r.cost)} · ${fmt(r.req)} requests · ${r.prov}`;
      lab.setAttribute('x',X(r.tok)+Rr(r.req)+5); lab.setAttribute('y',Y(r.cost)+3.5); lab.setAttribute('opacity', i<8? 1 : 0); }
  });
  gb.querySelectorAll('circle').forEach(c=>{ if(!seen.has(c.dataset.m)){ c.setAttribute('r',0); c.setAttribute('opacity',0); gl.querySelector(`[data-m="${CSS.escape(c.dataset.m)}"]`).setAttribute('opacity',0); } });
}

/* =====================================================================
   PER-APP TABLE
   ===================================================================== */
function updateAppTable(){
  const tb=document.querySelector('#apptable tbody'); const byA={};
  for (const f of ALL){ const a = byA[f.app] ||= {app:f.app, flows:[], models:new Set()}; a.flows.push(f); a.models.add(f.model+(f.direct?'|d':'')); }
  const rows=Object.values(byA).map(a=>({...a, s:agg(a.flows)})).sort((x,y)=>y.s.cost-x.s.cost);
  const show = state.app? rows.filter(r=>r.app===state.app) : rows;
  tb.innerHTML = show.map(r=>{
    const vals=seriesFor('tokens', r.app); const p=sparkPath(vals,110,26,3); const d=p.map((q,i)=>(i?'L':'M')+q[0].toFixed(1)+' '+q[1].toFixed(1)).join('');
    const chips=[...r.models].map(m=>{ const [id,dr]=m.split('|'); return `<span class="chip${dr?' direct':''}" title="${dr?'called directly (no gateway)':'via AI Gateway'}">${id.replace('@cf/','')}</span>`; }).join('');
    return `<tr class="clickable${state.app===r.app?' sel':''}" data-app="${r.app}"><td class="app">${APPS[r.app].name}<small>${[...new Set(r.flows.map(f=>f.worker))].join(' · ')}</small></td><td class="r num">${r.flows.length}</td><td><div class="chips">${chips}</div></td><td class="r num">${fmt(r.s.tok)}</td><td class="r num">${pct(r.s.cached)}</td><td class="r num">${money(r.s.cost)}</td><td><span class="gwpct"><i style="--v:${(r.s.gwPct/100).toFixed(3)}"></i><span class="num">${pct(r.s.gwPct)}</span></span></td><td><svg class="trend" viewBox="0 0 110 26"><path class="a" d="${d}L110 26L0 26Z"/><path d="${d}"/></svg></td></tr>`;
  }).join('');
  tb.querySelectorAll('tr').forEach(tr=>tr.addEventListener('click',()=>setApp(tr.dataset.app===state.app? null : tr.dataset.app)));
}

/* =====================================================================
   CLOUDFLARE PANEL
   ===================================================================== */
const CF_COLS = ['wreq','wcpu','d1r','d1w','d1s','r2s','r2a','r2b','kvr','q','do','vecq','ai'];
const CF_GAUGES = ['wreq','wcpu','d1r','d1w','r2s','kvr','q','ai'];
function updateCF(){
  document.getElementById('cfrange').textContent = RANGES[state.range].label;
  const days=D.days, units=D.cloudflare.unitsByApp, comps=Object.fromEntries(D.cloudflare.components.map(c=>[c.key,c]));
  const fmtU = (k,v)=> comps[k]&&comps[k].unit==='GB-mo'? v.toFixed(2)+' GB' : fmt(v);
  const gz=document.getElementById('gauges');
  if (!gz.children.length){ gz.innerHTML = CF_GAUGES.map(k=>`<div class="gauge"><svg viewBox="0 0 72 72"><circle class="track" cx="36" cy="36" r="32"/><circle class="fill" cx="36" cy="36" r="32"/><text class="pct" x="36" y="41" text-anchor="middle">0%</text></svg><div class="nm">${comps[k].name}</div><div class="vs"></div></div>`).join(''); gz._cur=CF_GAUGES.map(()=>0); }
  CF_GAUGES.forEach((k,i)=>{ const c=comps[k]; const used=Object.values(units).reduce((a,u)=>a+(u[k]||0),0); const limR = c.storage? c.included : c.included*days/30; const q=limR? used/limR : 0; const g=gz.children[i]; const f=g.querySelector('.fill'); f.style.strokeDashoffset = 201*(1-clamp(q,0,1)); f.classList.toggle('hot',q>1); f.classList.toggle('warm',q>.75&&q<=1);
    const from=gz._cur[i]; tween(1000,t=>{ g.querySelector('.pct').textContent=Math.round(lerp(from,q,t)*100)+'%'; }); gz._cur[i]=q; g.querySelector('.vs').textContent = `${fmtU(k,used)} / ${fmtU(k,limR)}`; });
  const tb=document.querySelector('#cftable tbody');
  const rows = Object.entries(units).filter(([app])=>!state.app||app===state.app).sort((a,b)=>(b[1].wreq||0)-(a[1].wreq||0));
  tb.innerHTML = rows.length? rows.map(([app,u])=>`<tr class="${state.app===app?'sel':''}"><td class="app">${appName(app)}</td>${CF_COLS.map(k=>`<td class="r num">${u[k]? fmtU(k,u[k]) : '<span style="color:var(--text-3)">—</span>'}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${CF_COLS.length+1}" style="color:var(--text-3)">No Cloudflare usage collected for this range yet.</td></tr>`;
}


/* =====================================================================
   CLOUDFLARE BILLING
   ===================================================================== */
// [key, name, unit, included per 30d, $ per unit, family, storage?] — filled from the API (config/prices.json)
let COMP = [], CI = {};
const FAM = {workers:'#4F7FA8', storage:'#1F6F7A', msg:'#7A6AA6', ai:'#B8963E', platform:'#C85A2E'};
const FAM_NAME = {workers:'Workers', storage:'Storage', msg:'Messaging', ai:'AI', platform:'Platform'};
function compColor(k){ const c=COMP[CI[k]]; const sib=COMP.filter(x=>x[5]===c[5]); const i=sib.indexOf(c); const [r,g,b]=hexToRgb(FAM[c[5]]); const f = 1 - i*(.55/Math.max(sib.length-1,1)); return `rgb(${Math.round(r*f+20*(1-f))},${Math.round(g*f+30*(1-f))},${Math.round(b*f+50*(1-f))})`; }
let BILL_NAME = {}, BILL = null;
const BILL_SUB = {shared:'infrastructure marked shared in config', unattributed:'matched no config pattern'};
function ingestBilling(d){
  COMP = d.cloudflare.components.map(c=>[c.key,esc(c.name),c.unit,c.included,c.price,c.family,c.storage?1:0]);
  CI = Object.fromEntries(COMP.map((c,i)=>[c[0],i]));
  BILL_NAME = Object.fromEntries(Object.entries(APPS).map(([id,a])=>[id,a.name]));
  const b = d.cloudflare.bill;
  BILL = {...b,
    rows: b.rows.map(r=>({...r, name:BILL_NAME[r.id]||esc(r.id), sub:BILL_SUB[r.id]})),
    comps: b.comps.map(c=>({...c, name:esc(c.name), fam:c.family, pushers:c.pushers.map(p=>BILL_NAME[p]||esc(p))}))};
}
const bill = { sortKey:'total', sortDir:-1, colsByTotal:false, mxMode:null, stackMode:'usd', tmMode:'comp', cur:{} };

function billingFor(){ return BILL; }
const unitFmt = (v,unit)=> unit==='GB-mo'? v.toFixed(1) : unit==='hours'? v.toFixed(1)+' h' : unit==='M dims'? v.toFixed(0)+'M' : unit==='vCPU-min'? fmt(v)+' min' : fmt(v);
const billRows = B => state.app ? B.rows.filter(r=>r.id===state.app) : B.rows;
const btip=document.getElementById('btip');
function showBtip(e,html){ btip.innerHTML=html; btip.classList.add('on'); moveBtip(e); }
function moveBtip(e){ let x=e.clientX+14, y=e.clientY+14; if (x+btip.offsetWidth>innerWidth-8) x=e.clientX-btip.offsetWidth-14; if (y+btip.offsetHeight>innerHeight-8) y=e.clientY-btip.offsetHeight-14; btip.style.left=x+'px'; btip.style.top=y+'px'; }
function hideBtip(){ btip.classList.remove('on'); }
function cellTip(r,c){ return `<h4>${r.name} · ${c.name}</h4><dl><dt>Units used (app)</dt><dd>${unitFmt(r.units[c.key],c.unit)} ${c.unit}</dd><dt>Share of account</dt><dd>${pct(c.total? r.units[c.key]/c.total*100:0)}</dd><dt>Included allowance</dt><dd>${unitFmt(c.incl,c.unit)}</dd><dt>Account overage</dt><dd>${unitFmt(c.over,c.unit)}</dd><dt>Unit price</dt><dd>$${c.price>=.01? c.price.toFixed(3) : (c.price*1e6).toFixed(3)+' / M'}</dd><dt>Attributed cost</dt><dd>${money(r.cost[c.key])}</dd></dl>`; }

function updateBillKpis(B){
  const root=document.getElementById('bkpis'); const proj = B.base*30/B.days + B.usage/B.days*30;
  const rows=billRows(B); const scoped = state.app? rows.reduce((a,r)=>a+r.total,0) : B.total;
  const defs=[
    {id:'mtd', lbl:(state.app? BILL_NAME[state.app]+' · ':'')+'Cloudflare estimate', v:scoped, d:RANGES[state.range].label+' · estimate'},
    {id:'proj', lbl:'30-day run-rate', v: state.app? scoped/B.days*30 : proj, d:'linear run-rate on usage · base fees fixed'},
    {id:'base', lbl:'Base vs usage', v:B.usage, d:`${money(B.base)} subscription · ${money(B.usage)} overage`, split:[B.base,B.usage]},
    {id:'chg', lbl:'Unattributed', v:(B.rows.find(r=>r.id==='unattributed')||{total:0}).total, d:'usage no config pattern matched'},
  ];
  if (!root.children.length){ root.innerHTML=defs.map(d=>`<div class="bkpi" id="bk-${d.id}"><div class="lbl">${d.lbl}</div><div class="val"><span class="n">0</span></div>${d.split?'<div class="split"><i style="background:var(--text-3)"></i><i style="background:var(--heat-2)"></i></div>':''}<div class="d"></div></div>`).join(''); }
  defs.forEach(d=>{ const c=document.getElementById('bk-'+d.id); c.querySelector('.lbl').textContent=d.lbl; const n=c.querySelector('.n'); const from=bill.cur[d.id]||0; const f=d.fmtv||money; tween(1000,t=>{ n.textContent=f(lerp(from,d.v,t)); }); bill.cur[d.id]=d.v;
    const dd=c.querySelector('.d'); dd.textContent=d.d; dd.className='d '+(d.up?'up':''); if (d.split){ const [a,b]=d.split, t=a+b; const is=c.querySelectorAll('.split i'); is[0].style.width=(a/t*100)+'%'; is[1].style.width=(b/t*100)+'%'; } });
}
function updateMatrix(B){
  // "$ spend" shows each app's share of the billed overage; "Usage" shows the units behind it,
  // which is the only signal while everything is inside the included allowance.
  const usage = (bill.mxMode ?? (B.usage < 1 ? 'units' : 'usd')  /* until overage reaches $1, usage is the useful view */) === 'units';
  document.querySelectorAll('#mxmode button').forEach(b=>b.setAttribute('aria-pressed', (b.dataset.v==='units')===usage));
  document.getElementById('mxsub').textContent = usage
    ? "Each cell is the app's usage of the component in this range; colour is its share of the account's total. Click a column to sort."
    : "Each cell is that app's attributed share of the component's overage. Click a column to sort rows; click \"App\" to sort alphabetically.";
  const compByKey=Object.fromEntries(B.comps.map(c=>[c.key,c]));
  const val = (r,k) => usage ? (compByKey[k].total? r.units[k]/compByKey[k].total : 0) : r.cost[k];
  const shown = (r,k) => usage ? r.units[k] > 0 : r.cost[k] >= .005;
  const tbl=document.getElementById('matrix'); const rows=[...billRows(B)]; const comps=[...B.comps];
  if (bill.colsByTotal) comps.sort((a,b)=> usage ? b.total/b.incl - a.total/a.incl : b.cost-a.cost);
  const rowVal = (r,k) => k==='total' ? (usage ? comps.reduce((a,c)=>a+val(r,c.key),0) : r.total) : val(r,k);
  rows.sort((a,b)=> bill.sortKey==='name' ? a.name.localeCompare(b.name)*bill.sortDir : (rowVal(a,bill.sortKey)-rowVal(b,bill.sortKey))*bill.sortDir);
  const maxCell = usage ? 1 : (Math.max(...B.rows.flatMap(r=>Object.values(r.cost)))||1);
  const ar = k => bill.sortKey===k? `<span class="ar">${bill.sortDir<0?'▼':'▲'}</span>` : '';
  tbl.querySelector('thead').innerHTML = `<tr><th data-k="name" class="${bill.sortKey==='name'?'on':''}">App${ar('name')}</th>${comps.map(c=>`<th class="r ${bill.sortKey===c.key?'on':''}" data-k="${c.key}" title="${c.name} · included ${unitFmt(c.incl,c.unit)} ${c.unit}">${c.name}${ar(c.key)}</th>`).join('')}<th class="r ${bill.sortKey==='total'?'on':''}" data-k="total" title="${usage?'Sum of the app’s shares across components':''}">${usage?'Share sum':'Total'}${ar('total')}</th></tr>`;
  tbl.querySelector('tbody').innerHTML = rows.map(r=>`<tr data-app="${r.id}" class="${state.app===r.id?'sel':''}"><td class="lab">${r.name}${r.sub?`<small>${r.sub}</small>`:''}</td>${comps.map(c=>{ const on=shown(r,c.key); const t=Math.sqrt(val(r,c.key)/maxCell); const bg = on? heat(t) : 'transparent'; const txt = !on? '·' : usage? unitFmt(r.units[c.key],c.unit) : money(r.cost[c.key]); return `<td><span class="cell ${on?'':'z'} ${t>.55?'hot':''}" data-r="${r.id}" data-c="${c.key}" style="background:${bg}${on?'; opacity:'+(.35+.65*t).toFixed(2):''}">${txt}</span></td>`; }).join('')}<td class="tot">${usage? pct(rowVal(r,'total')*100/Math.max(comps.length,1)) : money(r.total)}</td></tr>`).join('');
  const colTot = k => rows.reduce((a,r)=>a+(usage? r.units[k] : r.cost[k]),0);
  tbl.querySelector('tfoot').innerHTML = `<tr><td class="lab">${state.app?'App total':(usage?'Account total':'Account usage')}</td>${comps.map(c=>`<td>${usage? unitFmt(colTot(c.key),c.unit) : money(colTot(c.key))}</td>`).join('')}<td>${usage? '' : money(rows.reduce((a,r)=>a+r.total,0))}</td></tr>`;
  tbl.querySelectorAll('th').forEach(th=>th.onclick=()=>{ const k=th.dataset.k; if (bill.sortKey===k) bill.sortDir*=-1; else { bill.sortKey=k; bill.sortDir = k==='name'?1:-1; } updateMatrix(B); });
  tbl.querySelectorAll('td.lab[data-app], tbody td.lab').forEach(td=>td.onclick=()=>{ const id=td.parentElement.dataset.app; if (BILL_NAME[id]) setApp(state.app===id?null:id); });
  const rowById=Object.fromEntries(B.rows.map(r=>[r.id,r]));
  tbl.querySelectorAll('.cell').forEach(cell=>{ cell.onmouseenter=e=>showBtip(e,cellTip(rowById[cell.dataset.r],compByKey[cell.dataset.c])); cell.onmousemove=moveBtip; cell.onmouseleave=hideBtip; });
}
function updateStack(B){
  const root=document.getElementById('stack'); const rows=billRows(B).filter(r=>r.total>0.005).sort((a,b)=>b.total-a.total); const max=Math.max(...rows.map(r=>r.total))||1;
  const seen=new Set();
  rows.forEach(r=>{ seen.add(r.id); let nm=root.querySelector(`.nm[data-app="${r.id}"]`), bar, v;
    if (!nm){ nm=document.createElement('div'); nm.className='nm'; nm.dataset.app=r.id; nm.textContent=r.name; nm.onclick=()=>{ if (APPS[r.id]||BILL_NAME[r.id]) setApp(state.app===r.id?null:r.id); };
      bar=document.createElement('div'); bar.className='bar'; bar.dataset.app=r.id; bar.style.width='0%'; bar.innerHTML=COMP.map(c=>`<i data-c="${c[0]}" style="width:0%;background:${compColor(c[0])}"></i>`).join('');
      v=document.createElement('div'); v.className='v'; v.dataset.app=r.id; root.append(nm,bar,v);
      bar.querySelectorAll('i').forEach(i=>{ i.onmouseenter=e=>{ const c=B.comps.find(x=>x.key===i.dataset.c); const rr=BILL.rows.find(x=>x.id===r.id); showBtip(e,`<h4>${r.name} · ${c.name}</h4><dl><dt>Attributed</dt><dd>${money(rr.cost[c.key])}</dd><dt>Share of app bill</dt><dd>${pct(rr.cost[c.key]/rr.total*100)}</dd><dt>Units</dt><dd>${unitFmt(rr.units[c.key],c.unit)} ${c.unit}</dd></dl>`); }; i.onmousemove=moveBtip; i.onmouseleave=hideBtip; });
    } else { bar=root.querySelector(`.bar[data-app="${r.id}"]`); v=root.querySelector(`.v[data-app="${r.id}"]`); }
    root.append(nm,bar,v); // reorder
    requestAnimationFrame(()=>{ bar.style.width = bill.stackMode==='usd'? (r.total/max*100)+'%' : '100%'; bar.querySelectorAll('i').forEach(i=>{ i.style.width=(r.cost[i.dataset.c]/r.total*100)+'%'; }); });
    v.textContent = money(r.total);
  });
  root.querySelectorAll('[data-app]').forEach(n=>{ if(!seen.has(n.dataset.app)) n.remove(); });
  const lg=document.getElementById('klegend'); if (!lg.children.length) lg.innerHTML=Object.keys(FAM).filter(f=>COMP.some(c=>c[5]===f)).map(f=>`<span><b style="background:${FAM[f]}"></b>${FAM_NAME[f]}: ${COMP.filter(c=>c[5]===f).map(c=>c[1]).join(', ')}</span>`).join('');
}
// squarified treemap
function squarify(items,x,y,w,h){ const out=[]; items=items.filter(i=>i.v>0).sort((a,b)=>b.v-a.v); const total=items.reduce((a,i)=>a+i.v,0); if(!total) return out; const scale=w*h/total; let row=[], rx=x, ry=y, rw=w, rh=h;
  const worst=(row,s)=>{ const sum=row.reduce((a,i)=>a+i.v*scale,0); const mx=Math.max(...row.map(i=>i.v*scale)), mn=Math.min(...row.map(i=>i.v*scale)); return Math.max(s*s*mx/(sum*sum), sum*sum/(s*s*mn)); };
  const layoutRow=(row)=>{ const sum=row.reduce((a,i)=>a+i.v*scale,0); if (rw>=rh){ const cw=sum/rh; let cy=ry; for (const i of row){ const ch=i.v*scale/cw; out.push({...i,x:rx,y:cy,w:cw,h:ch}); cy+=ch; } rx+=cw; rw-=cw; } else { const ch=sum/rw; let cx=rx; for (const i of row){ const cw=i.v*scale/ch; out.push({...i,x:cx,y:ry,w:cw,h:ch}); cx+=cw; } ry+=ch; rh-=ch; } };
  for (const it of items){ const s=Math.min(rw,rh); if (!row.length || worst([...row,it],s)<=worst(row,s)) row.push(it); else { layoutRow(row); row=[it]; } }
  if (row.length) layoutRow(row); return out; }
function updateTreemap(B){
  const root=document.getElementById('treemap'); const Wt=root.clientWidth||600, Ht=root.clientHeight||360; const rows=billRows(B); const byApp = state.app && bill.tmMode==='comp' ? false : bill.tmMode==='app';
  let groups;
  if (byApp || state.app){ groups = rows.map(r=>({id:r.id,name:r.name,v:r.total,color:null,leaves:B.comps.map(c=>({id:r.id+'|'+c.key,name:c.name,v:r.cost[c.key],color:compColor(c.key),sub:money(r.cost[c.key])}))})); }
  else { groups = B.comps.map(c=>({id:c.key,name:c.name,v:rows.reduce((a,r)=>a+r.cost[c.key],0),color:compColor(c.key),leaves:rows.map(r=>({id:c.key+'|'+r.id,name:r.name,v:r.cost[c.key],color:compColor(c.key),sub:money(r.cost[c.key])}))})); }
  const G=squarify(groups,0,0,Wt,Ht); const seen=new Set(); const pad=3;
  G.forEach(g=>{ seen.add('g'+g.id); let d=root.querySelector(`[data-id="g${g.id}"]`); if(!d){ d=document.createElement('div'); d.className='grp'; d.dataset.id='g'+g.id; d.innerHTML='<span class="gl"></span>'; d.style.cssText=`left:${g.x+g.w/2}px;top:${g.y+g.h/2}px;width:0;height:0;opacity:0`; root.appendChild(d); }
    d.querySelector('.gl').textContent=g.name+' · '+money(g.v); requestAnimationFrame(()=>{ d.style.left=g.x+'px'; d.style.top=g.y+'px'; d.style.width=g.w+'px'; d.style.height=g.h+'px'; d.style.opacity=1; d.style.background = g.color? g.color : 'color-mix(in srgb, var(--navy-light) 70%, transparent)'; });
    const L=squarify(g.leaves,g.x+pad,g.y+16,Math.max(g.w-pad*2,0),Math.max(g.h-16-pad,0));
    L.forEach(l=>{ seen.add('l'+l.id); let e=root.querySelector(`[data-id="l${l.id}"]`); if(!e){ e=document.createElement('div'); e.className='leaf'; e.dataset.id='l'+l.id; e.style.cssText=`left:${l.x+l.w/2}px;top:${l.y+l.h/2}px;width:0;height:0;opacity:0`; root.appendChild(e); e.onmouseenter=ev=>showBtip(ev,`<h4>${g.name} → ${l.name}</h4><dl><dt>Attributed</dt><dd>${money(l.v)}</dd><dt>Share of group</dt><dd>${pct(l.v/g.v*100)}</dd><dt>Share of bill</dt><dd>${pct(l.v/(B.usage||1)*100)}</dd></dl>`); e.onmousemove=moveBtip; e.onmouseleave=hideBtip; }
      e.style.background = byApp||state.app ? l.color : `color-mix(in srgb, ${l.color} ${Math.round(55+45*Math.sqrt(l.v/g.v))}%, var(--navy-deep))`; e.textContent=''; if (l.w>54&&l.h>30){ e.textContent=l.name; const b=document.createElement('b'); b.textContent=l.sub; e.appendChild(b); }
      requestAnimationFrame(()=>{ e.style.left=l.x+'px'; e.style.top=l.y+'px'; e.style.width=l.w+'px'; e.style.height=l.h+'px'; e.style.opacity=1; }); });
  });
  root.querySelectorAll('[data-id]').forEach(n=>{ if(!seen.has(n.dataset.id)){ n.style.opacity=0; n.style.width='0px'; n.style.height='0px'; setTimeout(()=>n.remove(),600); } });
}
function updateAllow(B){
  const root=document.getElementById('allow'); const comps=[...B.comps].sort((a,b)=>(b.total/b.incl)-(a.total/a.incl));
  root.innerHTML = comps.map(c=>{ const q=c.total/c.incl; const mark=Math.min(1,1/Math.max(q,1))*100; const incW=Math.min(q,1)/Math.max(q,1)*100; const ovrW=q>1? (1-1/q)*100 : 0;
    const appShare = state.app? (B.rows.find(r=>r.id===state.app)?.units[c.key]||0) : 0;
    const who = c.over>0? `<b>${pct(Math.min(q,99.9)*100)} of allowance</b> · overage ${unitFmt(c.over,c.unit)} ${c.unit} = ${money(c.cost)}<br>pushed over by ${c.pushers.slice(0,3).join(', ')}${c.pushers.length>3?' +'+(c.pushers.length-3):''}` : `${pct(q*100)} of allowance · ${unitFmt(Math.max(c.incl-c.total,0),c.unit)} ${c.unit} headroom`;
    return `<div class="arow"><div class="nm">${c.name}<small>${unitFmt(c.total,c.unit)} / ${unitFmt(c.incl,c.unit)} ${c.unit} included${state.app? ' · '+BILL_NAME[state.app]+': '+unitFmt(appShare,c.unit):''}</small></div><div class="track" style="--mark:${mark}%"><i class="inc" style="width:0%"></i><i class="ovr" style="left:${mark}%;width:0%"></i></div><div class="who">${who}</div></div>`; }).join('');
  requestAnimationFrame(()=>requestAnimationFrame(()=>{ root.querySelectorAll('.arow').forEach((d,i)=>{ const c=comps[i]; const q=c.total/c.incl; d.querySelector('.inc').style.width=(Math.min(q,1)/Math.max(q,1)*100)+'%'; d.querySelector('.ovr').style.width=(q>1?(1-1/q)*100:0)+'%'; }); }));
}
function updateBilling(){ const B=billingFor(state.range); document.getElementById('billrange').textContent=RANGES[state.range].label; updateBillKpis(B); updateMatrix(B); updateStack(B); updateTreemap(B); updateAllow(B); }
function wireToggle(id, fn){ const g=document.getElementById(id); g.addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return; g.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x===b)); fn(b.dataset.v); }); }
wireToggle('mxmode', v=>{ bill.mxMode=v; updateMatrix(BILL); });
wireToggle('colsort', v=>{ bill.colsByTotal = v==='total'; updateMatrix(billingFor(state.range)); });
wireToggle('stackmode', v=>{ bill.stackMode=v; updateStack(billingFor(state.range)); });
wireToggle('tmmode', v=>{ bill.tmMode=v; updateTreemap(billingFor(state.range)); });

/* =====================================================================
   WIRING
   ===================================================================== */
function appName(id){ return (APPS[id]&&APPS[id].name) || BILL_NAME[id] || id; }
function setApp(app){ state.app=app; syncChip(); syncUrl(); unhover(); refresh(); }
function updateLife(){
  const sec=document.getElementById('life'), v=visible();
  const rows = Object.values(LIFE).map(n=>{ const m=esc(n.model); const fl=v.filter(f=>f.model===m); return {n, m, fl, apps:[...new Set(fl.map(f=>APPS[f.app].name))], tok:fl.reduce((a,f)=>a+f.tok,0)}; })
    .filter(r=>r.fl.length).sort((a,b)=> SEV_ORDER[a.n.severity]-SEV_ORDER[b.n.severity] || (a.n.daysLeft??1e9)-(b.n.daysLeft??1e9));
  sec.hidden = !rows.length;
  document.getElementById('liferows').innerHTML = rows.map(({n,m,apps,tok})=>{
    const when = n.severity==='watch' ? `not before ${n.retires}<small>earliest retirement date</small>`
      : n.daysLeft!=null && n.daysLeft<=0 ? `${n.retires}<small>retired: requests fail</small>` : `${n.retires}<small>${n.daysLeft} days left</small>`;
    const detail = n.replacement? `replace with <b>${esc(n.replacement)}</b>` : esc(n.note||'');
    return `<div class="lrow ${n.severity}"><span class="sev">${SEV_LABEL[n.severity]}</span><div class="m">${m}<small>${detail} ${/^https:\/\//.test(n.source)? ` · <a href="${esc(n.source)}" target="_blank" rel="noopener noreferrer">source</a>` : ''}</small></div><div class="when">${when}</div><div class="apps">${apps.join(', ')}<small>${fmt(tok)} tokens in ${RANGES[state.range].label.toLowerCase()}</small></div></div>`; }).join('');
}
function updateGaps(){
  const g = D.gaps||[]; const sec=document.getElementById('gaps'); sec.hidden = !g.length || !!state.app;
  sec.querySelector('tbody').innerHTML = g.slice(0,30).map(x=>`<tr><td><span class="chip">${esc(x.field)}</span></td><td class="mono">${esc(x.name)}</td><td style="white-space:normal;color:var(--text-2)">${esc(x.detail)}</td><td class="r num">${x.tokens!=null? fmt(x.tokens) : '—'}</td></tr>`).join('')
    + (g.length>30? `<tr><td colspan="4" style="color:var(--text-3)">+${g.length-30} more</td></tr>` : '');
}
function refresh(){ updateGaps(); updateLife(); updateKpis(); relayout(true); updateSources(); updateBubble(); updateAppTable(); updateCF(); updateBilling(); updateChrome(); }
async function load(){
  try {
    const r = await fetch(`/api/usage?range=${state.range}`, {headers:{accept:'application/json'}});
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    ingest(await r.json()); if (state.app && !APPS[state.app]) { state.app=null; syncUrl(); } syncChip(); refresh();
  } catch (e) { const b=document.getElementById('live'); b.textContent='ERROR'; b.className='badge stale'; b.title=String(e); }
}
let brandSet=false;
function updateChrome(){
  const c=D.config;
  if (!brandSet){ brandSet=true; const brand = c.theme==='navy-gold'? 'navy-gold' : ''; if (brand) root.dataset.brand=brand; else delete root.dataset.brand; try{ localStorage.setItem('ud-brand',brand);}catch(e){} readHeat(); applyGeom(); }
  const wm=document.getElementById('wordmark');
  if (c.wordmark){ wm.className='wordmark split'; wm.innerHTML=`<span class="p">${esc(c.wordmark[0])}</span><span class="s">${esc(c.wordmark[1])}</span>`; wm.setAttribute('aria-label',c.wordmark.join('')); document.title=c.wordmark.join('')+' · '+c.title; }
  else { wm.className='wordmark'; wm.textContent=c.title; document.title=c.title; }
  document.getElementById('crumb').innerHTML=`<b>${esc(c.title)}</b>`; document.getElementById('title').textContent=c.title;
  const ok = D.runs.filter(r=>r.ok), last = Math.max(0,...ok.map(r=>r.ran_at)), age = D.generatedAt-last, bad = D.runs.filter(r=>!r.ok && !/^not configured/.test(r.message||''));
  const b=document.getElementById('live'); const stale = !last || age>900;
  b.textContent = !last? 'NO DATA YET' : `LIVE · ${age<90? 'just now' : Math.round(age/60)+'m ago'}`; b.className='badge'+(stale||bad.length?' stale':'');
  b.title = D.runs.map(r=>`${r.source}: ${r.source==='backfill'? 'history from '+new Date(+r.message*1000).toLocaleDateString() : r.ok?'ok, '+r.rows+' rows':r.message} (${new Date(r.ran_at*1000).toLocaleTimeString()})`).join('\n') || 'Collector has not run';
  document.getElementById('foot').innerHTML = ['Cloudflare dollar figures are estimates: usage × list price above the included allowance, attributed by config. AI Gateway cost is as logged by the gateway; direct Anthropic/OpenAI cost is tokens × list price until the daily provider cost report lands.', ...c.notes].map(esc).join('<br>');
}
setInterval(()=>{ if (!document.hidden) load(); }, 5*60*1000);
document.getElementById('chipclear').addEventListener('click',()=>setApp(null));
document.getElementById('range').addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return; document.querySelectorAll('#range button').forEach(x=>x.setAttribute('aria-pressed',x===b)); state.range=b.dataset.r; syncUrl(); load(); });
// theme
const root=document.documentElement;
function applyTheme(t){ root.dataset.theme=t; try{ localStorage.setItem('wh-theme',t);}catch(e){} document.getElementById('themeicon').setAttribute('d', t==='dark'? 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z' : 'M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'); readHeat(); if (D){ applyGeom(); updateBubble(); } }
(function(){ let t=QS.get('theme'); if (t!=='light' && t!=='dark'){ try{ t=localStorage.getItem('wh-theme'); }catch(e){} }
  if (t!=='light' && t!=='dark') t = matchMedia('(prefers-color-scheme: dark)').matches? 'dark' : 'light'; applyTheme(t); })();
document.querySelectorAll('#range button').forEach(x=>x.setAttribute('aria-pressed', x.dataset.r===state.range));
document.getElementById('theme').addEventListener('click',()=>applyTheme(root.dataset.theme==='dark'?'light':'dark'));
// size
function sizeStage(){ const wrap=document.getElementById('flowwrap'); W=Math.max(1300, wrap.clientWidth); H=700; stage.style.width=W+'px'; svg.setAttribute('viewBox',`0 0 ${W} ${H}`); sizeCanvas(); }
let rsz; addEventListener('resize',()=>{ clearTimeout(rsz); rsz=setTimeout(()=>{ sizeStage(); geom={nodes:{},links:{}}; for (const k in elems.links) elems.links[k].remove(); for (const k in elems.nodes) elems.nodes[k].remove(); elems={nodes:{},links:{}}; if (D){ relayout(false); updateBubble(); updateTreemap(BILL); } },150); });

buildKpis(); sizeStage(); readHeat(); load();
if (!reduced){ lastT=performance.now(); requestAnimationFrame(drawParticles); } else { stage.classList.remove('motion'); }
