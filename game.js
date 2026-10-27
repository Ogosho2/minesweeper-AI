'use strict';
const $ = id => document.getElementById(id);
const LEVELS = {beginner:[9,9,10], intermediate:[16,16,40], expert:[16,30,99], huge:[30,30,199]};
const REASON = {single:'基本', subset:'組合せ', enum:'列挙', count:'残り地雷数'};
const REPLAY_KEY = 'minesweeper_ai_web_replay_v1';
const MAX_MISSES = 3;
let state = null, cells = [], worker = null, aiReady = false, aiFailure = '';
let aiResult = null, requestId = 0, analyzing = false, queued = false, aiStepWanted = false;
let lastReplay = null, replay = null, autoTimer = null, timeInterval = null, saveTimer = null;
let isModalOpen = false;

function index(r,c){return r*state.cols+c;}
function inside(r,c){return r>=0 && c>=0 && r<state.rows && c<state.cols;}
function neighbors(r,c,rows=state.rows,cols=state.cols){
  const out=[];
  for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
    if(!(dr||dc))continue;
    if(r+dr>=0&&c+dc>=0&&r+dr<rows&&c+dc<cols)out.push([r+dr,c+dc]);
  }
  return out;
}
function clock(){return state.started ? (state.endedAt ?? state.pauseAt ?? performance.now())-state.startedAt : 0;}
function sec(){return Math.max(0,clock()/1000);}
function formatTime(v){return v.toFixed(1)+'s';}
function message(s){$('ai-info').textContent=s;}
function engineStatus(text){$('engine-status').textContent=text;}

function saveReplay(){
  if(!state || state.frames.length<=1)return;
  try{
    const pack={version:1,rows:state.rows,cols:state.cols,mines:state.totalMines,
      mineIndexes:state.placed ? Array.from(state.mine).flatMap((m,i)=>m?[i]:[]) : [],
      frames:state.frames};
    lastReplay=pack;
    localStorage.setItem(REPLAY_KEY,JSON.stringify(pack));
    $('replay-open').disabled=false;
  }catch(e){console.warn('リプレイ保存に失敗（メモリ内では利用可能）',e);}
}
function scheduleReplaySave(){clearTimeout(saveTimer);saveTimer=setTimeout(saveReplay,300);}
function snapshot(){
  return Array.from({length:state.rows*state.cols},(_,i)=>{
    const raw=state.revealed[i]?(state.mine[i]?0:state.adj[i]+2):1;
    return raw+(state.flags[i]?16:0);
  });
}
function record(action,cell=null){
  const current=snapshot();
  const prev=state.lastCodes;
  const changes=[];
  for(let i=0;i<current.length;i++)if(current[i]!==prev[i])changes.push([i,current[i]]);
  if(!changes.length && state.frames.length>0)return;
  state.lastCodes=current;
  state.frames.push({changes,flags:state.flagsLeft,misses:state.misses,elapsed:sec(),
     started:state.placed,outcome:state.outcome,action,cell});
  scheduleReplaySave();
}
function stopAuto(){
  $('ai-auto').checked=false;
  clearTimeout(autoTimer);autoTimer=null;aiStepWanted=false;
}
function reset(rows,cols,mines,level){
  clearTimeout(autoTimer);stopAuto();
  if(state?.frames?.length>1)saveReplay();
  state={rows,cols,totalMines:mines,level, mine:new Uint8Array(rows*cols),adj:new Uint8Array(rows*cols),
    revealed:new Uint8Array(rows*cols),flags:new Uint8Array(rows*cols), flagsLeft:mines,misses:MAX_MISSES,
    safeOpened:0,placed:false,started:false,startedAt:null,endedAt:null,pauseAt:null,gameOver:false,outcome:'',
    version:0,frames:[],lastCodes:Array(rows*cols).fill(1)};
  isModalOpen=false;
  $('dialog').classList.add('hidden');
  $('difficulty').value=level || 'custom';
  aiResult=null;aiStepWanted=false;
  buildBoard();record('最初');render();
  message(aiReady?'AI: 初手はランダムで安全です':(aiFailure||'PythonのAIエンジンを起動しています…'));
  if(aiReady)requestAnalysis();
}
function buildBoard(){
  const px=state.cols>=50?23:state.cols>=30?28:state.cols>=16?34:38;
  const root=$('board');root.style.setProperty('--cell',px+'px');
  root.style.gridTemplateColumns=`repeat(${state.cols}, var(--cell))`;
  root.replaceChildren();cells=[];
  const frag=document.createDocumentFragment();
  for(let r=0;r<state.rows;r++)for(let c=0;c<state.cols;c++){
    const el=document.createElement('button');
    el.type='button';el.className='cell';el.dataset.i=index(r,c);
    el.setAttribute('role','gridcell');el.setAttribute('aria-label',`${r+1}行${c+1}列、未開封`);
    el.addEventListener('click',()=>onCell(r,c));
    el.addEventListener('contextmenu',e=>{e.preventDefault();toggleFlag(r,c);});
    el.addEventListener('mouseenter',()=>hover(r,c));
    el.addEventListener('mouseleave',()=>{$('ai-hover').textContent='';});
    cells.push(el);frag.appendChild(el);
  }
  root.appendChild(frag);
}
function heat(p){
  let from,to,t;
  if(p<=.5){from=[165,214,167];to=[255,241,118];t=p*2;}
  else {from=[255,241,118];to=[239,108,108];t=(p-.5)*2;}
  return `rgb(${from.map((v,i)=>Math.round(v+(to[i]-v)*t)).join(',')})`;
}
function aiMaps(result){
  const safe=new Map(result.safe.map(([r,c,reason])=>[index(r,c),reason]));
  const mines=new Map(result.mines.map(([r,c,reason])=>[index(r,c),reason]));
  const prob=new Map(result.prob.map(([r,c,p])=>[index(r,c),p]));
  const approx=new Set(result.approx.map(([r,c])=>index(r,c)));
  return {safe,mines,prob,approx};
}
function percent(p){const n=p*100;return n>0&&n<1?'<1':n>99&&n<100?'>99':Math.round(n).toString();}
function render(){
  if(!state)return;
  $('flags-left').textContent=state.flagsLeft;
  $('misses-left').textContent=state.misses;
  $('elapsed').textContent=formatTime(sec());
  $('reset').textContent=state.outcome==='clear'?'🏆 Clear!':state.outcome==='over'?'💥 Game Over':'↻ Reset';
  const showAi=$('ai-show').checked && !state.gameOver;
  const ai=showAi && aiResult?aiMaps(aiResult):null;
  const best=aiResult?.move && showAi ? index(aiResult.move.r,aiResult.move.c): -1;
  for(let i=0;i<cells.length;i++){
    const el=cells[i];const revealed=!!state.revealed[i], flagged=!!state.flags[i];
    const cls=['cell'];let content='';
    if(revealed){cls.push('opened');if(state.mine[i]){content='💣';if(state.outcome!=='clear'&&!state.gameOver)cls.push('hit');}
      else if(state.adj[i]){content=String(state.adj[i]);el.dataset.number=String(state.adj[i]);}
    }else {delete el.dataset.number;if(flagged)content='🚩';}
    if(state.gameOver&&!revealed&&flagged&&!state.mine[i]){content='✖';cls.push('wrong');}
    el.className=cls.join(' ');
    el.textContent=content;
    if(ai&&!revealed){
      if(flagged){if(ai.safe.has(i)){const mark=document.createElement('span');mark.className='wrong-flag';el.appendChild(mark);}}
      else if(ai.prob.has(i)){
        const layer=document.createElement('span');layer.className='overlay';
        if(ai.safe.has(i)){layer.classList.add('safe');layer.textContent='✔';}
        else if(ai.mines.has(i)){layer.classList.add('mine');layer.textContent='✖';}
        else {layer.classList.add('prob');layer.style.backgroundColor=heat(ai.prob.get(i));
          if($('ai-probs').checked)layer.textContent=(ai.approx.has(i)?'~':'')+percent(ai.prob.get(i));}
        el.appendChild(layer);
      }
    }
    if(i===best){const mark=document.createElement('span');mark.className='best';el.appendChild(mark);}
  }
}
function invalidate(){
  state.version++;
  aiResult=null;
  render();
  if(!state.gameOver)requestAnalysis();
}
function placeMines(r,c){
  const safe=new Set([[r,c],...neighbors(r,c)].map(([rr,cc])=>index(rr,cc)));
  const candidates=Array.from({length:state.rows*state.cols},(_,i)=>i).filter(i=>!safe.has(i));
  for(let i=0;i<state.totalMines;i++){
    const j=i+Math.floor(Math.random()*(candidates.length-i));
    [candidates[i],candidates[j]]=[candidates[j],candidates[i]];
    state.mine[candidates[i]]=1;
  }
  for(let i=0;i<state.rows*state.cols;i++)if(!state.mine[i]){
    const r=Math.floor(i/state.cols),c=i%state.cols;
    state.adj[i]=neighbors(r,c).reduce((n,[rr,cc])=>n+state.mine[index(rr,cc)],0);
  }
  state.placed=true;state.started=true;state.startedAt=performance.now();
}
function reveal(r,c,changed,hits){
  const stack=[[r,c]];
  while(stack.length){
    const [rr,cc]=stack.pop(),i=index(rr,cc);
    if(state.revealed[i]||state.flags[i])continue;
    state.revealed[i]=1;changed.add(i);
    if(state.mine[i]){hits.add(i);continue;}
    state.safeOpened++;
    if(!state.adj[i]){
      for(const [nr,nc] of neighbors(rr,cc))if(!state.revealed[index(nr,nc)]&&!state.flags[index(nr,nc)])stack.push([nr,nc]);
    }
  }
}
function onCell(r,c){
  if(replay || isModalOpen || state.gameOver)return;
  if($('flag-mode').checked){toggleFlag(r,c);return;}
  const i=index(r,c);
  if(!state.placed)placeMines(r,c);
  if(state.revealed[i]){chord(r,c);return;}
  if(state.flags[i])return;
  const changed=new Set(),hits=new Set();reveal(r,c,changed,hits);
  finalize(`開く (${r+1}, ${c+1})`,[r,c],hits);
}
function toggleFlag(r,c){
  if(isModalOpen||replay||state.gameOver||!state.placed)return;
  const i=index(r,c);
  if(state.revealed[i])return;
  if(state.flags[i]){state.flags[i]=0;state.flagsLeft++;}
  else {if(state.flagsLeft<=0)return;state.flags[i]=1;state.flagsLeft--;}
  record(`旗を${state.flags[i]?'立てる':'外す'} (${r+1}, ${c+1})`,[r,c]);
  invalidate();
}
function chord(r,c){
  if(!state.placed||state.gameOver)return;
  const i=index(r,c),n=state.adj[i];
  if(!state.revealed[i] || state.mine[i] || n<=0)return;
  const around=neighbors(r,c);
  if(around.reduce((a,[rr,cc])=>a+state.flags[index(rr,cc)],0)!==n)return;
  const changed=new Set(),hits=new Set();
  for(const [rr,cc] of around){const j=index(rr,cc);if(!state.revealed[j]&&!state.flags[j])reveal(rr,cc,changed,hits);}
  if(changed.size)finalize(`周囲を開く (${r+1}, ${c+1})`,[r,c],hits);
}
function endGame(outcome){
  state.gameOver=true;state.outcome=outcome;state.endedAt=performance.now();stopAuto();
  if(outcome==='over')for(let i=0;i<state.mine.length;i++)if(state.mine[i])state.revealed[i]=1;
}
function finalize(action,cell,hits){
  if(hits.size){
    state.misses--;
    render();
    const count=state.misses;
    showDialog('💣 地雷を踏みました',`残り猶予: ${count} 回`,[
      ...(count>0?[{text:'続ける',primary:true,run:()=>{
        for(const i of hits)if(state.mine[i]&&!state.flags[i]){state.flags[i]=1;state.flagsLeft--;}
        record(action,cell);invalidate();
      }}]:[]),
      {text:'終わる',run:()=>{endGame('over');record(action,cell);invalidate();}}
    ]);
    stopAuto();return;
  }
  if(state.safeOpened===state.rows*state.cols-state.totalMines){
    endGame('clear');record(action,cell);render();
    showDialog('🏆 CLEAR!',`クリア時間：${formatTime(sec())} ／ ${state.rows}×${state.cols} ／ 地雷${state.totalMines}個`,[
      {text:'閉じる',run:()=>{}},{text:'もう一度',primary:true,run:()=>reset(state.rows,state.cols,state.totalMines,state.level)}
    ]);
  }else{record(action,cell);invalidate();}
}
function showDialog(title,text,buttons,fields){
  isModalOpen=true;
  $('dialog-title').textContent=title;
  $('dialog-message').textContent=text;
  $('dialog-fields').replaceChildren();$('dialog-buttons').replaceChildren();
  if(fields)fields($('dialog-fields'));
  for(const b of buttons){
    const btn=document.createElement('button');btn.textContent=b.text;
    if(b.primary)btn.className='primary';
    btn.addEventListener('click',()=>{
      const ok=b.run?.();if(ok===false)return;
      isModalOpen=false;$('dialog').classList.add('hidden');
    });
    $('dialog-buttons').appendChild(btn);
  }
  $('dialog').classList.remove('hidden');
}
function customDialog(){
  const prior=[state.rows,state.cols,state.totalMines];
  const fields=holder=>{
    [['rows','行数 (2〜50)',prior[0]],['cols','列数 (2〜80)',prior[1]],['mines','地雷数',prior[2]]].forEach(([id,label,value])=>{
      const wrap=document.createElement('label');wrap.textContent=label;
      const inp=document.createElement('input');inp.type='number';inp.id='custom-'+id;inp.value=value;
      wrap.appendChild(inp);holder.appendChild(wrap);
    });
    const error=document.createElement('p');error.className='error';error.id='custom-error';holder.appendChild(error);
  };
  showDialog('Custom Difficulty','行数・列数・地雷数を指定してください。',[
    {text:'キャンセル',run:()=>{$('difficulty').value=state.level;}},
    {text:'適用',primary:true,run:()=>{
      const r=Number($('custom-rows').value),c=Number($('custom-cols').value),m=Number($('custom-mines').value);
      const max=r*c-Math.min(3,r)*Math.min(3,c);
      if(!Number.isInteger(r)||r<2||r>50||!Number.isInteger(c)||c<2||c>80||!Number.isInteger(m)||m<1||m>max){
        $('custom-error').textContent=`行2〜50、列2〜80、地雷1〜${max}（初手の周囲8マスを安全にできる範囲）で入力してください。`;
        return false;
      }
      reset(r,c,m,'custom');
    }}
  ],fields);
}
function snapshotForAi(){
  const out=[];
  for(let r=0;r<state.rows;r++){
    const row=[];for(let c=0;c<state.cols;c++){
      const i=index(r,c);row.push(!state.revealed[i]?-1:(state.mine[i]?-2:state.adj[i]));
    }out.push(row);
  }
  return out;
}
function requestAnalysis(){
  if(!aiReady||state.gameOver||replay)return;
  if(!($('ai-show').checked||$('ai-auto').checked||aiStepWanted))return;
  if(analyzing){queued=true;return;}
  analyzing=true;queued=false;
  const id=++requestId;
  const avoid=[];
  for(let i=0;i<state.flags.length;i++)if(state.flags[i]&&!state.revealed[i])avoid.push([Math.floor(i/state.cols),i%state.cols]);
  const version=state.version;
  worker.postMessage({type:'analyze',id,version,board:snapshotForAi(),mines:state.totalMines,avoid});
  message('AI: 盤面を解析中…');
}
function displayAnalysis(result){
  aiResult=result;
  if(result.error){message('AI: '+result.error);return;}
  const mv=result.move;
  if(!mv){message('AI: 指せるマスがありません');return;}
  const counts=`　安全${result.safe.length}・地雷${result.mines.length}`;
  if(mv.kind==='first')message(`AI: 初手はランダム（${mv.r+1}, ${mv.c+1}）`);
  else if(mv.kind==='safe')message(`AI: 次 (${mv.r+1}, ${mv.c+1}) 安全確定［${REASON[mv.reason]||mv.reason}］${counts}`);
  else message(`AI: 次 (${mv.r+1}, ${mv.c+1}) 推測 地雷${Math.round(mv.prob*100)}%${result.approx.some(([r,c])=>r===mv.r&&c===mv.c)?'（近似）':''}${counts}`);
}
function performAiMove(){
  if(!aiReady||!aiResult?.move||state.gameOver||isModalOpen||replay)return false;
  const {r,c}=aiResult.move,i=index(r,c);
  if(state.flags[i]){state.flags[i]=0;state.flagsLeft++;}
  if(state.revealed[i])return false;
  onCell(r,c);return true;
}
function runAuto(){
  clearTimeout(autoTimer);autoTimer=null;
  if(!$('ai-auto').checked||!aiReady||state.gameOver||isModalOpen||replay)return;
  if(aiResult){if(!performAiMove()){stopAuto();return;}}
  else if(!analyzing)requestAnalysis();
}
function handleAiMessage(event){
  const data=event.data;
  if(data.type==='ready'){
    aiReady=true;aiFailure='';engineStatus('AI準備完了');
    $('ai-step').disabled=false;$('ai-auto').disabled=false;requestAnalysis();return;
  }
  if(data.type==='error'){
    aiFailure='AI起動エラー: '+data.message;engineStatus('AIを使用できません');message(aiFailure);
    $('ai-auto').disabled=true;$('ai-step').disabled=true;stopAuto();return;
  }
  if(data.type==='result'||data.type==='analysis-error'){
    analyzing=false;
    if(data.id!==requestId)return;
    if(queued){queued=false;requestAnalysis();return;}
    if(data.type==='analysis-error'){
      message('AI解析エラー: '+data.message);stopAuto();return;
    }
    if(state.gameOver||replay)return;
    displayAnalysis(data.result);render();
    if(aiStepWanted){aiStepWanted=false;performAiMove();}
    else if($('ai-auto').checked)autoTimer=setTimeout(runAuto,120);
  }
}
function startAi(){
  try{
    worker=new Worker('./ai-worker.js');
    worker.onmessage=handleAiMessage;
    worker.onerror=e=>{
      aiFailure='AIワーカーの読み込みに失敗しました';engineStatus('AI起動エラー');message(aiFailure);
      $('ai-step').disabled=true;$('ai-auto').disabled=true;stopAuto();
      console.error(e);
    };
  }catch(e){aiFailure='AIを開始できません: '+String(e);message(aiFailure);}
}
function hover(r,c){
  if(!aiResult||!$('ai-show').checked||state.gameOver){$('ai-hover').textContent='';return;}
  const v=aiResult.prob.find(([rr,cc])=>rr===r&&cc===c);
  $('ai-hover').textContent=v?`(${r+1},${c+1}) 地雷確率 ${(v[2]*100).toFixed(1)}%`:'未確定（確率未計算）';
}

/* リプレイは盤面の差分だけをブラウザ内に保存。元のTkinter版と同じ見取り図。 */
function openReplay(){
  if(!lastReplay?.frames?.length||lastReplay.frames.length<2)return;
  stopAuto();if(state.started&&!state.gameOver)state.pauseAt=performance.now();
  replay={data:lastReplay,index:0,timer:null,states:[]};
  let current=Array(lastReplay.rows*lastReplay.cols).fill(1);
  for(const frame of lastReplay.frames){
    current=current.slice();for(const [i,code] of frame.changes)current[i]=code;
    replay.states.push(current);
  }
  const board=$('replay-board');board.replaceChildren();
  const px=lastReplay.cols>=50?22:lastReplay.cols>=30?27:lastReplay.cols>=16?33:38;
  board.style.setProperty('--cell',px+'px');
  board.style.gridTemplateColumns=`repeat(${lastReplay.cols},var(--cell))`;
  const frag=document.createDocumentFragment();
  for(let i=0;i<lastReplay.rows*lastReplay.cols;i++){
    const el=document.createElement('div');el.className='cell';frag.appendChild(el);
  }
  board.appendChild(frag);
  $('replay-slider').max=lastReplay.frames.length-1;
  $('replay-dialog').classList.remove('hidden');showReplay(0);
}
function showReplay(n){
  if(!replay)return;
  const {data,states}=replay;
  replay.index=Math.max(0,Math.min(data.frames.length-1,n));
  const f=data.frames[replay.index];
  $('replay-slider').value=replay.index;
  $('replay-status').textContent=`${replay.index}/${data.frames.length-1}手　${f.action}　🚩${f.flags}　💥${f.misses}　${formatTime(f.elapsed)}　${f.outcome==='clear'?'クリア':f.outcome==='over'?'ゲームオーバー':''}`;
  const codes=states[replay.index],mineSet=new Set(data.mineIndexes),nodes=$('replay-board').children;
  for(let i=0;i<codes.length;i++){
    const v=codes[i]&15,flagged=!!(codes[i]&16),el=nodes[i];
    el.className='cell';el.textContent='';delete el.dataset.number;
    if(v!==1){el.classList.add('opened');if(v===0)el.textContent='💣';else if(v>2){el.textContent=String(v-2);el.dataset.number=String(v-2);}}
    else if(flagged){el.textContent=(f.outcome==='over'&&!mineSet.has(i))?'✖':'🚩';}
  }
  if(f.cell){const [r,c]=f.cell,node=nodes[r*data.cols+c];if(node){const border=document.createElement('span');border.className='last-move';node.appendChild(border);}}
  for(const [id,disabled] of [['replay-first',replay.index===0],['replay-prev',replay.index===0],['replay-next',replay.index===data.frames.length-1],['replay-last',replay.index===data.frames.length-1]])$(id).disabled=disabled;
}
function stopReplayTimer(){if(replay?.timer){clearInterval(replay.timer);replay.timer=null;}$('replay-play').textContent='▶';}
function closeReplay(){stopReplayTimer();replay=null;$('replay-dialog').classList.add('hidden');
  if(state.pauseAt!==null){state.startedAt+=performance.now()-state.pauseAt;state.pauseAt=null;}
  if(aiReady&&!state.gameOver)requestAnalysis();}
function toggleReplay(){
  if(!replay)return;
  if(replay.timer){stopReplayTimer();return;}
  if(replay.index>=replay.data.frames.length-1)showReplay(0);
  $('replay-play').textContent='Ⅱ';
  replay.timer=setInterval(()=>{
    if(!replay)return;
    if(replay.index+1<replay.data.frames.length)showReplay(replay.index+1);
    else stopReplayTimer();
  },600);
}
function bind(){
  $('difficulty').addEventListener('change',e=>{
    if(e.target.value==='custom'){customDialog();return;}
    reset(...LEVELS[e.target.value],e.target.value);
  });
  $('reset').addEventListener('click',()=>reset(state.rows,state.cols,state.totalMines,state.level));
  $('ai-step').addEventListener('click',()=>{
    if(state.gameOver||isModalOpen||replay)return;
    if(aiResult){performAiMove();return;}
    aiStepWanted=true;requestAnalysis();
  });
  $('ai-auto').addEventListener('change',e=>{
    if(!e.target.checked){clearTimeout(autoTimer);autoTimer=null;return;}
    if(!state.gameOver)runAuto();
  });
  $('ai-show').addEventListener('change',()=>{render();if($('ai-show').checked)requestAnalysis();else message('AI表示はオフです');});
  $('ai-probs').addEventListener('change',render);
  $('replay-open').addEventListener('click',openReplay);
  $('replay-close').addEventListener('click',closeReplay);
  $('replay-first').addEventListener('click',()=>{stopReplayTimer();showReplay(0);});
  $('replay-prev').addEventListener('click',()=>{stopReplayTimer();showReplay(replay.index-1);});
  $('replay-next').addEventListener('click',()=>{stopReplayTimer();showReplay(replay.index+1);});
  $('replay-last').addEventListener('click',()=>{stopReplayTimer();showReplay(replay.data.frames.length-1);});
  $('replay-play').addEventListener('click',toggleReplay);
  $('replay-slider').addEventListener('input',e=>{stopReplayTimer();showReplay(Number(e.target.value));});
  document.addEventListener('keydown',e=>{
    if(!replay)return;
    if(e.key==='Escape'){closeReplay();return;}
    if(['ArrowLeft','ArrowRight',' ','Home','End'].includes(e.key))e.preventDefault();
    if(e.key==='ArrowLeft')showReplay(replay.index-1);
    if(e.key==='ArrowRight')showReplay(replay.index+1);
    if(e.key==='Home')showReplay(0);
    if(e.key==='End')showReplay(replay.data.frames.length-1);
    if(e.key===' ')toggleReplay();
  });
  window.addEventListener('beforeunload',saveReplay);
}
function main(){
  try{
    const saved=JSON.parse(localStorage.getItem(REPLAY_KEY)||'null');
    if(saved?.version===1&&saved?.frames?.length>1)lastReplay=saved;
  }catch(e){console.warn('保存済みリプレイの読み込みに失敗',e);}
  $('replay-open').disabled=!lastReplay;
  bind();reset(...LEVELS.beginner,'beginner');
  timeInterval=setInterval(()=>{if(state?.started&&!state.gameOver&&!replay)$('elapsed').textContent=formatTime(sec());},100);
  startAi();
}
main();
