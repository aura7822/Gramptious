/* GRAMPTIOUS — service-worker.js */
'use strict';
var igTabId = null;

function saveTab(id) {
  igTabId = id;
  chrome.storage.local.set({ igTabId: id });
}

chrome.tabs.onUpdated.addListener(function(tabId, info, tab) {
  if (info.status === 'complete' && tab.url && tab.url.indexOf('instagram.com') !== -1) saveTab(tabId);
});
chrome.tabs.onActivated.addListener(function(a) {
  chrome.tabs.get(a.tabId, function(t) {
    if (!chrome.runtime.lastError && t && t.url && t.url.indexOf('instagram.com') !== -1) saveTab(a.tabId);
  });
});
chrome.tabs.onRemoved.addListener(function(id) {
  if (id === igTabId) { igTabId = null; chrome.storage.local.remove('igTabId'); }
});

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type === 'ANNOUNCE_IG_TAB') {
    if (sender && sender.tab && sender.tab.id) saveTab(sender.tab.id);
    return false;
  }
  if (msg.type === 'GET_IG_TAB') {
    if (igTabId) { sendResponse({ tabId: igTabId }); return false; }
    chrome.storage.local.get('igTabId', function(r) { sendResponse({ tabId: r.igTabId || null }); });
    return true;
  }
  if (msg.type === 'SET_IG_TAB') { if (msg.tabId) saveTab(msg.tabId); sendResponse({ ok: true }); return false; }
  if (msg.type === 'OPEN_DASHBOARD') {
    if (msg.tabId) saveTab(msg.tabId);
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
    sendResponse({ ok: true }); return false;
  }
  if (msg.type === 'PROGRESS') {
    chrome.runtime.sendMessage(msg).catch(function(){});
    return false;
  }
  return false;
});

function scanTabs() {
  chrome.tabs.query({}, function(tabs) {
    if (chrome.runtime.lastError) return;
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].url && tabs[i].url.indexOf('instagram.com') !== -1) { saveTab(tabs[i].id); return; }
    }
  });
}
chrome.runtime.onInstalled.addListener(scanTabs);
chrome.runtime.onStartup.addListener(scanTabs);
chrome.runtime.onConnect.addListener(function(p) { if (p.name === 'keepalive') p.onDisconnect.addListener(function(){}); });
