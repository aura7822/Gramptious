function makeAvatar(u){var i=(u||'?').slice(0,2).toUpperCase();var c=['#8B0000','#B8860B','#6B0020'][u.charCodeAt(0)%3];var s='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="'+c+'" opacity="0.2"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" fill="'+c+'" font-size="15" font-weight="700">'+i+'</text></svg>';return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(s);}
/* GRAMPTIOUS — popup.js */
'use strict';
var igTabId = null;
function $(id){return document.getElementById(id);}
function setFoot(t,live){$('footText').textContent=t;$('footDot').className='foot-dot'+(live?' live':'');}
function showNotIG(){$('viewNotIG').hidden=false;$('viewConnected').hidden=true;setFoot('NOT ON INSTAGRAM',false);}
function showConnected(user,lastScan){
  $('viewNotIG').hidden=true;$('viewConnected').hidden=false;
  $('accountName').textContent=user.fullName||user.username;
  $('accountHandle').textContent='@'+user.username;
  var av=$('avatar'); av.src=makeAvatar(user.username); av.alt=user.username;
  if(lastScan&&lastScan.stats){
    $('stFol').textContent=lastScan.stats.followingCount;
    $('sFer') && ($('sFer').textContent=lastScan.stats.followersCount);
    $('stFer') && ($('stFer').textContent=lastScan.stats.followersCount);
    $('stNF').textContent=lastScan.stats.nonFollowersCount;
    $('statsRow').hidden=false;
  }
  setFoot('SESSION ACTIVE — NO PASSWORD REQUIRED',true);
}
function injectThenConnect(tabId){
  setFoot('CONNECTING...',false);
  chrome.scripting.executeScript({target:{tabId:tabId},files:['content/content.js']},function(){
    void chrome.runtime.lastError;
    setTimeout(function(){
      chrome.tabs.sendMessage(tabId,{type:'GET_USER'},function(resp){
        void chrome.runtime.lastError;
        if(!resp||resp.error){showNotIG();return;}
        chrome.storage.local.get('lastScan',function(r){
          chrome.runtime.sendMessage({type:'SET_IG_TAB',tabId:tabId});
          showConnected(resp.user,r.lastScan||null);
        });
      });
    },350);
  });
}
function init(){
  setFoot('CHECKING...',false);
  chrome.runtime.sendMessage({type:'GET_IG_TAB'},function(resp){
    void chrome.runtime.lastError;
    var tid=resp&&resp.tabId;
    if(tid){igTabId=tid;injectThenConnect(tid);return;}
    chrome.tabs.query({},function(tabs){
      var found=null;
      for(var i=0;i<tabs.length;i++){
        if(tabs[i].url&&tabs[i].url.indexOf('instagram.com')!==-1){
          if(!found||tabs[i].active)found=tabs[i];
        }
      }
      if(!found){showNotIG();return;}
      igTabId=found.id;injectThenConnect(igTabId);
    });
  });
}
$('btnGoIG').addEventListener('click',function(){chrome.tabs.create({url:'https://www.instagram.com/'});window.close();});
$('btnOpenDash').addEventListener('click',function(){chrome.runtime.sendMessage({type:'OPEN_DASHBOARD',tabId:igTabId});window.close();});
document.addEventListener('DOMContentLoaded',init);
