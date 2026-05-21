/* GRAMPTIOUS — dashboard.js */
'use strict';

/* ─── State ─────────────────────────────────────────────────────────────────── */
var igTabId=null,currentUser=null,scanData=null,activeTab='overview';
var actionQueue=[],isRunning=false,actionPort=null;
var liveLog=[],liveDone=0,livePend=0,liveErr=0;
var settings={interval:30,batchSize:20,skipVerified:false,skipPrivate:false,autoRetaliate:false};
var actionHistory=[]; // [{date,unfollows,follows}]

function $(id){return document.getElementById(id);}

/* ─── Storage ───────────────────────────────────────────────────────────────── */
function sGet(k){return new Promise(function(r){chrome.storage.local.get(k,function(d){r(d[k]||null);});}); }
function sSet(k,v){return new Promise(function(r){chrome.storage.local.set({[k]:v},r);});}

/* ─── Messaging ─────────────────────────────────────────────────────────────── */
function msg(m){
  return new Promise(function(res,rej){
    if(!igTabId){rej(new Error('NO_IG_TAB'));return;}
    chrome.tabs.sendMessage(igTabId,m,function(r){
      if(chrome.runtime.lastError)rej(new Error(chrome.runtime.lastError.message||'MSG_FAIL'));
      else res(r);
    });
  });
}

/* ─── Comparator ────────────────────────────────────────────────────────────── */
function compute(following,followers,prevFollowers){
  var ferMap=new Map(followers.map(function(u){return[u.username,u];}));
  var folMap=new Map(following.map(function(u){return[u.username,u];}));
  var nonFollowers=following.filter(function(u){return!ferMap.has(u.username);});
  var mutuals=following.filter(function(u){return ferMap.has(u.username);});
  var fanZone=followers.filter(function(u){return!folMap.has(u.username);});
  var lostFollowers=[];
  if(prevFollowers&&prevFollowers.length){
    var currFerSet=new Set(followers.map(function(u){return u.username;}));
    lostFollowers=prevFollowers.filter(function(u){return!currFerSet.has(u.username);});
  }
  return{
    following:following,followers:followers,
    nonFollowers:nonFollowers,mutuals:mutuals,fanZone:fanZone,
    lostFollowers:lostFollowers,
    stats:{
      followingCount:following.length,followersCount:followers.length,
      nonFollowersCount:nonFollowers.length,mutualsCount:mutuals.length,
      fanZoneCount:fanZone.length,lostFollowersCount:lostFollowers.length,
      ratio:followers.length>0?(followers.length/Math.max(following.length,1)).toFixed(2):'—'
    }
  };
}

/* ─── Clock ─────────────────────────────────────────────────────────────────── */
function startClock(){
  function tick(){$('clock').textContent=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});}
  tick();setInterval(tick,1000);
}

/* ─── Tab routing ────────────────────────────────────────────────────────────── */
var TABS={
  overview:'tabOverview',nonFollowers:'tabNonFollowers',fanZone:'tabFanZone',
  mutuals:'tabMutuals',lostFollowers:'tabLostFollowers',autoMode:'tabAutoMode'
};
function showTab(tab){
  activeTab=tab;
  Object.keys(TABS).forEach(function(k){$(TABS[k]).hidden=true;});
  $(TABS[tab]).hidden=false;
  document.querySelectorAll('.nav-item').forEach(function(el){
    el.classList.toggle('active',el.dataset.tab===tab);
  });
  if(tab==='overview'&&scanData)renderCharts();
  if(tab==='autoMode')renderAutoMode();
}
function showState(name){
  $('viewWelcome').hidden=name!=='welcome';
  $('viewScanning').hidden=name!=='scanning';
  $('viewError').hidden=name!=='error';
  Object.keys(TABS).forEach(function(k){$(TABS[k]).hidden=true;});
  if(name==='results'){
    $(TABS[activeTab==='overview'?'overview':activeTab]).hidden=false;
  }
}

/* ─── Scan ──────────────────────────────────────────────────────────────────── */
async function startScan(){
  if(!igTabId){setErr('No Instagram tab. Close this, open instagram.com, relaunch extension.');return;}
  $('scanBtn').disabled=true;
  showState('scanning');
  actionPort=chrome.runtime.connect({name:'keepalive'});

  try{
    var prevScan=await sGet('lastScan');
    var prevFollowers=prevScan&&prevScan.followers?prevScan.followers:[];

    // Fetch both lists (sequential to avoid rate limits)
    setProgress('FETCHING FOLLOWING...',0,null);
    var fr=await msg({type:'FETCH_FOLLOWING',userId:currentUser.userId});
    if(!fr||fr.error)throw new Error(fr?fr.error:'FETCH_FAILED');

    setProgress('FETCHING FOLLOWERS...',0,null);
    var er=await msg({type:'FETCH_FOLLOWERS',userId:currentUser.userId});
    if(!er||er.error)throw new Error(er?er.error:'FETCH_FAILED');

    setProgress('COMPUTING...',fr.list.length+er.list.length,fr.list.length+er.list.length);

    scanData=compute(fr.list,er.list,prevFollowers);
    scanData.user=currentUser;
    scanData.scannedAt=new Date().toISOString();

    await sSet('lastScan',{...scanData,following:fr.list,followers:er.list});
    var hist=await sGet('scanHistory')||[];
    await sSet('scanHistory',[{scannedAt:scanData.scannedAt,stats:scanData.stats}].concat(hist).slice(0,20));

    updateNavCounts();
    updateTopbar();
    showState('results');
    showTab('overview');
    renderCharts();
    renderAllLists();

    // Auto-retaliate: unfollow people who unfollowed since last scan
    if(settings.autoRetaliate&&scanData.lostFollowers.length>0){
      addLog('info','⚡ Auto-retaliate: queuing '+scanData.lostFollowers.length+' unfollows');
      scheduleActions(scanData.lostFollowers,'unfollow');
    }

  }catch(e){
    setErr('Scan failed: '+friendlyErr(e.message));
    showState('error');
  }finally{
    $('scanBtn').disabled=false;
    if(actionPort){actionPort.disconnect();actionPort=null;}
  }
}

function setProgress(phase,n,total){
  $('scanPhase').textContent=phase;
  $('progN').textContent=n;
  $('progT').textContent=total!==null?total:'—';
  if(total&&total>0)$('progBar').style.width=Math.min(100,Math.round(n/total*100))+'%';
}
function setErr(msg){$('errMsg').textContent=msg;}
function friendlyErr(c){
  var m={NOT_AUTHENTICATED:'Session expired — log back in.',RATE_LIMITED:'Rate limited — wait a few minutes.',
    NO_IG_TAB:'Instagram tab not found.',FETCH_FAILED:'Failed fetching data.',ACTION_BLOCKED:'Action blocked by Instagram.'};
  return m[c]||('Error: '+c);
}

chrome.runtime.onMessage.addListener(function(m){
  if(m.type==='PROGRESS'){
    var ph=m.phase==='following'?'FETCHING FOLLOWING...':'FETCHING FOLLOWERS...';
    setProgress(ph,m.fetched,m.total);
  }
});

/* ─── Nav counts & topbar ────────────────────────────────────────────────────── */
function updateNavCounts(){
  if(!scanData)return;
  var s=scanData.stats;
  $('nc-ov').textContent=s.followingCount;
  $('nc-nf').textContent=s.nonFollowersCount;
  $('nc-fz').textContent=s.fanZoneCount;
  $('nc-mu').textContent=s.mutualsCount;
  $('nc-lf').textContent=s.lostFollowersCount;
  $('ov-fol').textContent=s.followingCount;
  $('ov-fer').textContent=s.followersCount;
  $('ov-nf').textContent=s.nonFollowersCount;
  $('ov-fz').textContent=s.fanZoneCount;
  $('ov-mu').textContent=s.mutualsCount;
  $('ov-lf').textContent=s.lostFollowersCount;
  $('ov-rat').textContent=s.ratio;
}
function updateTopbar(){
  if(!scanData)return;
  $('lastBadge').hidden=false;
  $('lastBadge').textContent='LAST SCAN: '+new Date(scanData.scannedAt).toLocaleTimeString();
}

/* ─── List rendering ─────────────────────────────────────────────────────────── */
/* Load avatars via content script proxy — bypasses Instagram CDN CORS block */

function makeAvatar(username) {
  var initials = (username || '?').slice(0,2).toUpperCase();
  var colors = ['#8B0000','#B8860B','#6B0020','#7A5C00','#5C0000','#4A3800','#990000','#DAA520'];
  var c = colors[username.charCodeAt(0) % colors.length];
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">'
    + '<rect width="40" height="40" fill="' + c + '" opacity="0.25"/>'
    + '<rect width="40" height="40" fill="none" stroke="' + c + '" stroke-width="1" opacity="0.6"/>'
    + '<text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" '
    + 'fill="' + c + '" font-size="15" font-family="Calibri,sans-serif" font-weight="700">'
    + initials + '</text></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

var actionedUsers={};// track per-user action state

function renderList(containerId,users,opts){
  opts=opts||{};
  var el=$(containerId);
  if(!users||!users.length){
    el.innerHTML='<div class="empty-state"><div class="empty-icon">◈</div><div class="empty-txt">'+( opts.emptyMsg||'NO ACCOUNTS IN THIS LIST')+'</div></div>';
    return;
  }
  // Apply filters
  var filtered=users;
  if(opts.filter){
    var f=opts.filter.toLowerCase();
    filtered=filtered.filter(function(u){
      return u.username.toLowerCase().indexOf(f)!==-1||(u.fullName||'').toLowerCase().indexOf(f)!==-1;
    });
  }
  if(opts.skipVerified) filtered=filtered.filter(function(u){return!u.isVerified;});
  if(opts.skipPrivate)  filtered=filtered.filter(function(u){return!u.isPrivate;});
  if(opts.skipNoPic)    filtered=filtered.filter(function(u){return!!u.profilePicUrl;});

  if(!filtered.length){
    el.innerHTML='<div class="empty-state"><div class="empty-icon">⌕</div><div class="empty-txt">NO MATCHES FOUND</div></div>';
    return;
  }

  var frag=document.createDocumentFragment();
  filtered.forEach(function(u,i){
    var row=document.createElement('div');
    row.className='user-row';
    row.dataset.uid=u.userId;
    row.dataset.uname=u.username;

    // Checkbox
    if(opts.selectable){
      var cb=document.createElement('input');
      cb.type='checkbox';cb.className='row-check';cb.dataset.uid=u.userId;cb.dataset.uname=u.username;
      row.appendChild(cb);
    }

    // Number
    var num=document.createElement('span');
    num.className='row-num';num.textContent=(i+1);
    row.appendChild(num);

    // Avatar
    var awrap=document.createElement('div');awrap.className='row-avatar-wrap';
    var av=document.createElement('img');
    av.className='row-avatar'+(u.isPrivate?' private':'')+(u.isVerified?' verified':'');
    av.alt=u.username;av.width=38;av.height=38;
    av.src=makeAvatar(u.username);
    awrap.appendChild(av);
    if(u.isVerified){
      var tick=document.createElement('div');tick.className='verified-tick';tick.textContent='✓';
      awrap.appendChild(tick);
    }
    row.appendChild(awrap);

    // Info
    var info=document.createElement('div');info.className='row-info';
    var ulink=document.createElement('a');
    ulink.href='https://www.instagram.com/'+u.username+'/';
    ulink.target='_blank';ulink.rel='noopener noreferrer';
    ulink.className='row-user';ulink.textContent='@'+u.username;
    var name=document.createElement('div');name.className='row-name';name.textContent=u.fullName||'—';
    info.appendChild(ulink);info.appendChild(name);
    row.appendChild(info);

    // Badges
    var badges=document.createElement('div');badges.className='row-badges';
    if(u.isPrivate){var b=document.createElement('span');b.className='badge badge-priv';b.textContent='PRIVATE';badges.appendChild(b);}
    if(u.isVerified){var b2=document.createElement('span');b2.className='badge badge-ver';b2.textContent='VERIFIED';badges.appendChild(b2);}
    row.appendChild(badges);

    // Action buttons
    var acts=document.createElement('div');acts.className='row-actions';
    if(opts.unfollowBtn){
      var btn=document.createElement('button');
      var state=actionedUsers[u.userId];
      if(state==='done'){btn.className='act-btn act-done';btn.textContent='✓ Done';btn.disabled=true;}
      else{
        btn.className='act-btn act-unfollow';btn.textContent='Unfollow';
        (function(user,b){
          b.addEventListener('click',function(){doSingleAction(user,'unfollow',b);});
        })(u,btn);
      }
      acts.appendChild(btn);
    }
    if(opts.followBtn){
      var btn3=document.createElement('button');
      var state3=actionedUsers[u.userId];
      if(state3==='done'){btn3.className='act-btn act-done';btn3.textContent='✓ Done';btn3.disabled=true;}
      else{
        btn3.className='act-btn act-follow';btn3.textContent='Follow';
        (function(user,b){
          b.addEventListener('click',function(){doSingleAction(user,'follow',b);});
        })(u,btn3);
      }
      acts.appendChild(btn3);
    }
    row.appendChild(acts);
    frag.appendChild(row);
  });
  el.innerHTML='';
  el.appendChild(frag);
}

function renderAllLists(){
  if(!scanData)return;
  renderList('listNF',scanData.nonFollowers,{selectable:true,unfollowBtn:true,
    filter:$('srchNF').value,
    skipVerified:$('filt-ver-nf').checked,
    skipPrivate:$('filt-priv-nf').checked,
    skipNoPic:$('filt-nopic-nf').checked});
  renderList('listFZ',scanData.fanZone,{selectable:true,followBtn:true,filter:$('srchFZ').value,emptyMsg:'NO ONE FOLLOWS YOU THAT YOU DON\'T FOLLOW BACK'});
  renderList('listMU',scanData.mutuals,{filter:$('srchMU').value,emptyMsg:'NO MUTUAL FOLLOWERS FOUND'});
  renderList('listLF',scanData.lostFollowers,{selectable:true,unfollowBtn:true,filter:$('srchLF').value,emptyMsg:'NO LOST FOLLOWERS DETECTED — SCAN AGAIN TO COMPARE'});
}

/* ─── Single action ──────────────────────────────────────────────────────────── */
function doSingleAction(user,action,btn){
  if(btn){btn.disabled=true;btn.textContent='...';}
  msg({type:action==='unfollow'?'UNFOLLOW':'FOLLOW',userId:user.userId})
    .then(function(r){
      if(r&&r.ok){
        actionedUsers[user.userId]='done';
        addLog('success','✓ '+action+' <strong>@'+user.username+'</strong>');
        liveDone++;updateLiveCounts();
        if(btn){btn.className='act-btn act-done';btn.textContent='✓ Done';btn.disabled=true;}
        recordActionHistory(action);
      }else{
        addLog('error','✗ '+action+' @'+user.username+': '+(r&&r.error||'failed'));
        liveErr++;updateLiveCounts();
        if(btn){btn.disabled=false;btn.textContent=action==='unfollow'?'Unfollow':'Follow';}
      }
    })
    .catch(function(e){
      addLog('error','✗ '+action+' @'+user.username+': '+e.message);
      liveErr++;updateLiveCounts();
      if(btn){btn.disabled=false;btn.textContent=action==='unfollow'?'Unfollow':'Follow';}
    });
}

/* ─── Bulk / Auto actions ────────────────────────────────────────────────────── */
function getSelected(listId){
  var checks=document.querySelectorAll('#'+listId+' .row-check:checked');
  var result=[];
  checks.forEach(function(c){result.push({userId:c.dataset.uid,username:c.dataset.uname});});
  return result;
}

function scheduleActions(users,action){
  if(isRunning){addLog('info','⚠ Already running — stop first');return;}
  var filtered=users.filter(function(u){
    if(actionedUsers[u.userId]==='done')return false;
    if(settings.skipVerified&&u.isVerified)return false;
    if(settings.skipPrivate&&u.isPrivate)return false;
    return true;
  });
  if(!filtered.length){addLog('info','No eligible accounts to process.');return;}
  actionQueue=filtered.slice(0,settings.batchSize);
  livePend=actionQueue.length;updateLiveCounts();
  isRunning=true;
  renderAutoStatus(true);
  runNextAction(action);
}

function runNextAction(action){
  if(!isRunning||!actionQueue.length){
    isRunning=false;renderAutoStatus(false);
    addLog('info','— Queue complete');
    livePend=0;updateLiveCounts();
    return;
  }
  var user=actionQueue.shift();
  livePend=actionQueue.length;updateLiveCounts();
  addLog('pending','⏳ '+(action==='unfollow'?'Unfollowing':'Following')+' @'+user.username+'...');
  msg({type:action==='unfollow'?'UNFOLLOW':'FOLLOW',userId:user.userId})
    .then(function(r){
      if(r&&r.ok){
        actionedUsers[user.userId]='done';
        addLog('success','✓ '+action+'ed <strong>@'+user.username+'</strong>');
        liveDone++;updateLiveCounts();
        recordActionHistory(action);
      }else{
        addLog('error','✗ @'+user.username+': '+(r&&r.error||'blocked'));
        liveErr++;updateLiveCounts();
        if(r&&r.error==='ACTION_BLOCKED'){
          isRunning=false;renderAutoStatus(false);
          addLog('error','⛔ Action blocked by Instagram. Stopping.');return;
        }
      }
      if(isRunning)setTimeout(function(){runNextAction(action);},settings.interval*1000);
    })
    .catch(function(e){
      addLog('error','✗ @'+user.username+': '+e.message);
      liveErr++;updateLiveCounts();
      if(isRunning)setTimeout(function(){runNextAction(action);},settings.interval*1000);
    });
}

function stopActions(){
  isRunning=false;actionQueue=[];livePend=0;updateLiveCounts();
  renderAutoStatus(false);
  addLog('info','— Stopped by user');
}

/* ─── Live log ───────────────────────────────────────────────────────────────── */
function addLog(type,text){
  var icons={success:'✓',pending:'⏳',error:'✗',info:'◦'};
  liveLog.unshift({type:type,text:text,icon:icons[type]||'◦',time:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})});
  if(liveLog.length>60)liveLog.pop();
  var log=$('rpLog');
  var entry=document.createElement('div');
  entry.className='log-entry '+(type||'');
  var ic=document.createElement('span');ic.className='log-icon';ic.textContent=icons[type]||'◦';
  var tx=document.createElement('div');tx.className='log-text';tx.innerHTML=text;
  entry.appendChild(ic);entry.appendChild(tx);
  if(log.firstChild&&log.firstChild.style){}
  log.insertBefore(entry,log.firstChild);
  while(log.children.length>60)log.removeChild(log.lastChild);
}
function updateLiveCounts(){
  $('rpDone').textContent=liveDone;
  $('rpPend').textContent=livePend;
  $('rpErr').textContent=liveErr;
}

/* ─── Action history ─────────────────────────────────────────────────────────── */
function recordActionHistory(action){
  var today=new Date().toDateString();
  var last=actionHistory[0];
  if(last&&last.date===today){
    if(action==='unfollow')last.unfollows++;else last.follows++;
  }else{
    actionHistory.unshift({date:today,unfollows:action==='unfollow'?1:0,follows:action==='follow'?1:0});
    if(actionHistory.length>14)actionHistory.pop();
  }
  sSet('actionHistory',actionHistory);
}

/* ─── Charts ─────────────────────────────────────────────────────────────────── */
function renderCharts(){
  if(!scanData)return;
  requestAnimationFrame(function(){
    drawDonut();
    drawTrend();
    drawActionBars();
  });
}

function ctxSize(id){
  var c=$(id);if(!c)return null;
  var p=c.parentElement;
  c.width=p.clientWidth||200;c.height=p.clientHeight||120;
  return c.getContext('2d');
}

function drawDonut(){
  var ctx=ctxSize('chartDonut');if(!ctx)return;
  var s=scanData.stats;
  var W=ctx.canvas.width,H=ctx.canvas.height,cx=W/2,cy=H/2,R=Math.min(W,H)*0.38,r=R*0.55;
  ctx.clearRect(0,0,W,H);
  var slices=[
    {v:s.nonFollowersCount,c:'#DC143C'},
    {v:s.mutualsCount,c:'#FFD700'},
    {v:s.fanZoneCount,c:'#FF1493'},
  ];
  var total=slices.reduce(function(a,b){return a+b.v;},0)||1;
  var start=-Math.PI/2;
  slices.forEach(function(sl){
    var angle=(sl.v/total)*Math.PI*2;
    ctx.beginPath();ctx.moveTo(cx,cy);
    ctx.arc(cx,cy,R,start,start+angle);ctx.closePath();
    ctx.fillStyle=sl.c;ctx.fill();
    ctx.strokeStyle='#000';ctx.lineWidth=2;ctx.stroke();
    start+=angle;
  });
  // Hole
  ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);
  ctx.fillStyle='rgba(0,0,0,0.85)';ctx.fill();
  // Center text
  ctx.fillStyle='#FFD700';ctx.font='bold '+(r*0.5)+'px Courier New';ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(s.followersCount,cx,cy);
  ctx.fillStyle='#6B5530';ctx.font=(r*0.22)+'px Calibri';
  ctx.fillText('FOLLOWERS',cx,cy+r*0.35);
  // Legend
  var lbls=['Non-Fol','Mutuals','Fan Zone'];
  slices.forEach(function(sl,i){
    var lx=8,ly=H-14-(slices.length-1-i)*16;
    ctx.fillStyle=sl.c;ctx.fillRect(lx,ly-5,10,10);
    ctx.fillStyle='#6B5530';ctx.font='10px Calibri';ctx.textAlign='left';
    ctx.fillText(lbls[i]+' '+sl.v,lx+14,ly+1);
  });
}

function drawTrend(){
  var ctx=ctxSize('chartTrend');if(!ctx)return;
  ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
  sGet('scanHistory').then(function(hist){
    if(!hist||hist.length<2){
      ctx.fillStyle='#3D3018';ctx.font='11px Courier New';ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillText('SCAN MORE TO SEE TRENDS',ctx.canvas.width/2,ctx.canvas.height/2);return;
    }
    var W=ctx.canvas.width,H=ctx.canvas.height,pad={l:36,r:10,t:10,b:24};
    var data=hist.slice(0,10).reverse();
    var maxV=data.reduce(function(a,b){return Math.max(a,b.stats.followersCount,b.stats.followingCount);},0)||1;
    function px(i){return pad.l+(i/(data.length-1))*(W-pad.l-pad.r);}
    function py(v){return H-pad.b-(v/maxV)*(H-pad.t-pad.b);}
    // Grid
    for(var g=0;g<=4;g++){
      var gy=py(maxV*g/4);
      ctx.strokeStyle='rgba(255,215,0,0.05)';ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(pad.l,gy);ctx.lineTo(W-pad.r,gy);ctx.stroke();
    }
    // Followers line (gold)
    ctx.strokeStyle='#FFD700';ctx.lineWidth=2;ctx.shadowColor='#FFD700';ctx.shadowBlur=6;
    ctx.beginPath();
    data.forEach(function(d,i){i===0?ctx.moveTo(px(i),py(d.stats.followersCount)):ctx.lineTo(px(i),py(d.stats.followersCount));});
    ctx.stroke();ctx.shadowBlur=0;
    // Following line (red)
    ctx.strokeStyle='#DC143C';ctx.lineWidth=2;ctx.shadowColor='#DC143C';ctx.shadowBlur=6;
    ctx.beginPath();
    data.forEach(function(d,i){i===0?ctx.moveTo(px(i),py(d.stats.followingCount)):ctx.lineTo(px(i),py(d.stats.followingCount));});
    ctx.stroke();ctx.shadowBlur=0;
    // Dots
    data.forEach(function(d,i){
      ctx.fillStyle='#FFD700';ctx.beginPath();ctx.arc(px(i),py(d.stats.followersCount),3,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#DC143C';ctx.beginPath();ctx.arc(px(i),py(d.stats.followingCount),3,0,Math.PI*2);ctx.fill();
    });
    // Legend
    ctx.fillStyle='#FFD700';ctx.fillRect(pad.l,H-20,10,8);
    ctx.fillStyle='#6B5530';ctx.font='9px Calibri';ctx.textAlign='left';ctx.textBaseline='top';
    ctx.fillText('Followers',pad.l+13,H-20);
    ctx.fillStyle='#DC143C';ctx.fillRect(pad.l+70,H-20,10,8);
    ctx.fillStyle='#6B5530';ctx.fillText('Following',pad.l+83,H-20);
  });
}

function drawActionBars(){
  var ctx=ctxSize('chartActions');if(!ctx)return;
  ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
  if(!actionHistory||!actionHistory.length){
    ctx.fillStyle='#3D3018';ctx.font='11px Courier New';ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText('NO ACTIONS YET',ctx.canvas.width/2,ctx.canvas.height/2);return;
  }
  var W=ctx.canvas.width,H=ctx.canvas.height,pad={l:28,r:8,t:10,b:28};
  var data=actionHistory.slice(0,7).reverse();
  var maxV=data.reduce(function(a,b){return Math.max(a,b.unfollows+b.follows,1);},1);
  var bw=Math.floor((W-pad.l-pad.r)/data.length*0.7);
  var gap=Math.floor((W-pad.l-pad.r)/data.length);
  data.forEach(function(d,i){
    var x=pad.l+i*gap;
    var uh=Math.round((d.unfollows/maxV)*(H-pad.t-pad.b));
    var fh=Math.round((d.follows/maxV)*(H-pad.t-pad.b));
    // Unfollow bar (red)
    ctx.fillStyle='rgba(220,20,60,0.7)';
    ctx.fillRect(x,H-pad.b-uh,bw/2,uh);
    // Follow bar (gold)
    ctx.fillStyle='rgba(255,215,0,0.7)';
    ctx.fillRect(x+bw/2,H-pad.b-fh,bw/2,fh);
    // Date label
    var dt=new Date(d.date);
    ctx.fillStyle='#3D3018';ctx.font='9px Calibri';ctx.textAlign='center';ctx.textBaseline='top';
    ctx.fillText((dt.getMonth()+1)+'/'+(dt.getDate()),x+bw/2,H-pad.b+3);
  });
  ctx.fillStyle='#DC143C';ctx.fillRect(pad.l,H-18,8,6);
  ctx.fillStyle='#6B5530';ctx.font='9px Calibri';ctx.textAlign='left';ctx.textBaseline='top';ctx.fillText('Unfollows',pad.l+11,H-18);
  ctx.fillStyle='#FFD700';ctx.fillRect(pad.l+64,H-18,8,6);
  ctx.fillStyle='#6B5530';ctx.fillText('Follows',pad.l+75,H-18);
}

/* ─── Auto Mode panel ────────────────────────────────────────────────────────── */
function renderAutoMode(){
  var grid=$('autoGrid');
  grid.innerHTML='';

  // Settings card
  var sc=makeAutoCard('AUTO UNFOLLOW SETTINGS','⚙',false);
  sc.appendChild(makeSlider('Interval between actions','interval-sl',10,120,settings.interval,'s',function(v){settings.interval=v;},false));
  sc.appendChild(makeSlider('Max accounts per session','batch-sl',5,200,settings.batchSize,'',function(v){settings.batchSize=v;},false));
  sc.appendChild(makeToggle('Skip verified accounts',settings.skipVerified,function(v){settings.skipVerified=v;}));
  sc.appendChild(makeToggle('Skip private accounts',settings.skipPrivate,function(v){settings.skipPrivate=v;}));
  sc.appendChild(makeToggle('Auto-retaliate (unfollow anyone who unfollows you)',settings.autoRetaliate,function(v){settings.autoRetaliate=v;}));
  grid.appendChild(sc);

  // Mass unfollow card
  var mu=makeAutoCard('MASS UNFOLLOW','⊘',true);
  var p1=document.createElement('p');p1.style.cssText='font-size:11px;color:var(--dim);line-height:1.7;margin-bottom:12px;';
  p1.textContent='Unfollows all non-followers using the configured interval and filters. Respects skip settings above.';
  mu.appendChild(p1);
  var cnt1=document.createElement('div');cnt1.style.cssText='font-family:monospace;font-size:11px;color:rgba(220,20,60,0.6);margin-bottom:10px;';
  cnt1.textContent=(scanData?scanData.nonFollowers.length:0)+' non-followers eligible';
  mu.appendChild(cnt1);
  var rb=document.createElement('button');
  rb.className='run-btn red';rb.id='massUnfollowBtn';
  rb.textContent=isRunning?'RUNNING...':'START MASS UNFOLLOW';rb.disabled=!scanData;
  rb.addEventListener('click',function(){
    if(!scanData)return;
    var eligible=scanData.nonFollowers.filter(function(u){
      if(settings.skipVerified&&u.isVerified)return false;
      if(settings.skipPrivate&&u.isPrivate)return false;
      return true;
    });
    scheduleActions(eligible,'unfollow');
    renderAutoMode();
  });
  mu.appendChild(rb);
  if(isRunning){var sb=document.createElement('button');sb.className='stop-btn';sb.textContent='⬛ STOP';sb.addEventListener('click',function(){stopActions();renderAutoMode();});mu.appendChild(sb);}
  grid.appendChild(mu);

  // Mass follow card
  var mf=makeAutoCard('MASS FOLLOW (FAN ZONE)','★',false);
  var p2=document.createElement('p');p2.style.cssText='font-size:11px;color:var(--dim);line-height:1.7;margin-bottom:12px;';
  p2.textContent='Follow back everyone in your Fan Zone — accounts that follow you but you don\'t follow back.';
  mf.appendChild(p2);
  var cnt2=document.createElement('div');cnt2.style.cssText='font-family:monospace;font-size:11px;color:rgba(255,215,0,0.5);margin-bottom:10px;';
  cnt2.textContent=(scanData?scanData.fanZone.length:0)+' fan zone accounts eligible';
  mf.appendChild(cnt2);
  var fb=document.createElement('button');fb.className='run-btn gold';fb.textContent='START MASS FOLLOW';fb.disabled=!scanData;
  fb.addEventListener('click',function(){if(!scanData)return;scheduleActions(scanData.fanZone,'follow');renderAutoMode();});
  mf.appendChild(fb);
  grid.appendChild(mf);

  // Lost followers auto-retaliate card
  var lr=makeAutoCard('LOST FOLLOWERS — AUTO RETALIATE','📉',true);
  lr.classList.add('full');
  var p3=document.createElement('p');p3.style.cssText='font-size:11px;color:var(--dim);line-height:1.7;margin-bottom:12px;';
  p3.innerHTML='<strong style="color:var(--text)">'+( scanData?scanData.lostFollowers.length:0)+'</strong> people unfollowed you since the last scan. Enable auto-retaliate above to automatically unfollow them after each scan.';
  lr.appendChild(p3);
  if(scanData&&scanData.lostFollowers.length){
    var lb=document.createElement('button');lb.className='run-btn red';lb.textContent='UNFOLLOW LOST FOLLOWERS NOW';
    lb.addEventListener('click',function(){scheduleActions(scanData.lostFollowers,'unfollow');renderAutoMode();});
    lr.appendChild(lb);
  }
  grid.appendChild(lr);
}
function renderAutoStatus(running){
  var btn=$('massUnfollowBtn');
  if(btn)btn.textContent=running?'RUNNING...':'START MASS UNFOLLOW';
}
function makeAutoCard(title,icon,isRed){
  var c=document.createElement('div');
  c.className='auto-card'+(isRed?' red':'');
  var h=document.createElement('div');h.className='ac-title'+(isRed?' red':'');
  h.innerHTML='<span class="ac-title-icon">'+icon+'</span>'+title;
  c.appendChild(h);return c;
}
function makeSlider(label,id,min,max,val,unit,onChange){
  var row=document.createElement('div');row.className='field-row';
  var lbl=document.createElement('span');lbl.className='field-label';lbl.textContent=label;
  var disp=document.createElement('span');disp.className='field-val';disp.textContent=val+unit;
  var sl=document.createElement('input');sl.type='range';sl.id=id;sl.min=min;sl.max=max;sl.value=val;
  sl.addEventListener('input',function(){var v=parseInt(this.value);disp.textContent=v+unit;onChange(v);});
  row.appendChild(lbl);row.appendChild(sl);row.appendChild(disp);return row;
}
function makeToggle(label,checked,onChange){
  var row=document.createElement('div');row.className='toggle-row';
  var lbl=document.createElement('span');lbl.className='toggle-label';lbl.textContent=label;
  var tog=document.createElement('label');tog.className='toggle';
  var inp=document.createElement('input');inp.type='checkbox';inp.checked=checked;
  var track=document.createElement('div');track.className='toggle-track';
  inp.addEventListener('change',function(){onChange(this.checked);});
  tog.appendChild(inp);tog.appendChild(track);
  row.appendChild(lbl);row.appendChild(tog);return row;
}

/* ─── CSV Export ─────────────────────────────────────────────────────────────── */
function exportCSV(users,name){
  if(!users||!users.length)return;
  var ts=new Date().toISOString().slice(0,19).replace('T','_').replace(/:/g,'-');
  var hdr=['#','Username','Full Name','Profile URL','Private','Verified'];
  var rows=users.map(function(u,i){
    return[i+1,u.username,u.fullName||'','https://www.instagram.com/'+u.username+'/',u.isPrivate?'Yes':'No',u.isVerified?'Yes':'No'];
  });
  var csv=[hdr].concat(rows).map(function(r){return r.map(function(c){return'"'+String(c).replace(/"/g,'""')+'"';}).join(',');}).join('\r\n');
  var blob=new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8;'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');a.href=url;a.download=name+'_'+ts+'.csv';a.style.display='none';
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  setTimeout(function(){URL.revokeObjectURL(url);},5000);
}

/* ─── Filter chips ───────────────────────────────────────────────────────────── */
function bindFilterChip(chipId,inputId,rerender){
  var chip=$(chipId),inp=$(inputId);
  chip.addEventListener('click',function(){
    var now=inp.checked;
    inp.checked=!now;
    chip.classList.toggle('on',inp.checked);
    rerender();
  });
}

/* ─── Warning modal ──────────────────────────────────────────────────────────── */
function showWarning(){$('warnModal').style.display='flex';}
function hideWarning(){$('warnModal').style.display='none';}

/* ─── Init ───────────────────────────────────────────────────────────────────── */
async function init(){
  startClock();
  showWarning(); // Always show on open

  // Load settings
  var s=await sGet('gramSettings');
  if(s)Object.assign(settings,s);

  // Load action history
  var ah=await sGet('actionHistory');
  if(ah)actionHistory=ah;

  // Get IG tab
  var resp=await new Promise(function(r){
    chrome.runtime.sendMessage({type:'GET_IG_TAB'},function(x){void chrome.runtime.lastError;r(x);});
  });
  igTabId=resp&&resp.tabId;

  if(!igTabId){showState('error');setErr('No Instagram tab. Open instagram.com then relaunch.');return;}

  // Get user from content script
  var ur=await new Promise(function(r){
    chrome.tabs.sendMessage(igTabId,{type:'GET_USER'},function(x){void chrome.runtime.lastError;r(x||null);});
  });
  if(!ur||!ur.user){showState('error');setErr('Could not read Instagram session. Refresh instagram.com and relaunch.');return;}
  currentUser=ur.user;
  $('tAvatar').src=makeAvatar(currentUser.username);
  $('tAvatar').alt=currentUser.username;
  $('tHandle').textContent='@'+currentUser.username;

  // Load last scan
  var last=await sGet('lastScan');
  if(last&&last.nonFollowers){
    scanData=last;
    updateNavCounts();updateTopbar();
    showState('results');showTab('overview');
    renderCharts();renderAllLists();
    $('scanBtn').textContent='↺ RESCAN';
  }else{
    showState('welcome');
  }
}

/* ─── Event bindings ─────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded',function(){
  $('warnClose').addEventListener('click',hideWarning);
  $('warnAgainBtn').addEventListener('click',showWarning);
  $('scanBtn').addEventListener('click',startScan);
  $('retryBtn').addEventListener('click',startScan);

  // Nav
  document.querySelectorAll('.nav-item').forEach(function(el){
    el.addEventListener('click',function(){if(el.dataset.tab)showTab(el.dataset.tab);});
  });

  // Search inputs
  [['srchNF','listNF'],['srchFZ','listFZ'],['srchMU','listMU'],['srchLF','listLF']].forEach(function(pair){
    $(pair[0]).addEventListener('input',function(){if(scanData)renderAllLists();});
  });

  // Filter chips NF
  bindFilterChip('fc-verified-nf','filt-ver-nf',function(){if(scanData)renderAllLists();});
  bindFilterChip('fc-private-nf','filt-priv-nf',function(){if(scanData)renderAllLists();});
  bindFilterChip('fc-nopic-nf','filt-nopic-nf',function(){if(scanData)renderAllLists();});

  // Select all / unfollow selected
  $('selAllNF').addEventListener('click',function(){
    var cbs=document.querySelectorAll('#listNF .row-check');
    var anyUnchecked=[].some.call(cbs,function(c){return!c.checked;});
    cbs.forEach(function(c){c.checked=anyUnchecked;});
  });

  $('unfollowSelNF').addEventListener('click',function(){
    var sel=getSelected('listNF');
    if(!sel.length){addLog('info','No accounts selected');return;}
    if(!scanData)return;
    var full=sel.map(function(s){return scanData.nonFollowers.find(function(u){return u.userId===s.userId;})||s;});
    scheduleActions(full,'unfollow');
  });

  $('followSelFZ').addEventListener('click',function(){
    var sel=getSelected('listFZ');
    if(!sel.length){addLog('info','No accounts selected');return;}
    if(!scanData)return;
    var full=sel.map(function(s){return scanData.fanZone.find(function(u){return u.userId===s.userId;})||s;});
    scheduleActions(full,'follow');
  });

  $('unfollowSelLF').addEventListener('click',function(){
    var sel=getSelected('listLF');
    if(!sel.length){addLog('info','No accounts selected');return;}
    if(!scanData)return;
    var full=sel.map(function(s){return scanData.lostFollowers.find(function(u){return u.userId===s.userId;})||s;});
    scheduleActions(full,'unfollow');
  });

  // Exports
  $('exportNF').addEventListener('click',function(){if(scanData)exportCSV(scanData.nonFollowers,'gramptious_non_followers');});
  $('exportFZ').addEventListener('click',function(){if(scanData)exportCSV(scanData.fanZone,'gramptious_fan_zone');});
  $('exportMU').addEventListener('click',function(){if(scanData)exportCSV(scanData.mutuals,'gramptious_mutuals');});
  $('exportLF').addEventListener('click',function(){if(scanData)exportCSV(scanData.lostFollowers,'gramptious_lost_followers');});

  // Resize charts on window resize
  window.addEventListener('resize',function(){if(scanData&&activeTab==='overview')renderCharts();});

  init();
});
