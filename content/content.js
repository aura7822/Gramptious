/* GRAMPTIOUS — content.js (clean rewrite) */
(function () {
  'use strict';
  if (window.__gramptious) return;
  window.__gramptious = true;

  function getCookie(n) {
    var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function sleep(ms) {
    return new Promise(function(r){ setTimeout(r, ms); });
  }

  function makeRankToken(userId) {
    return userId + '_' + 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random()*16|0;
      return (c==='x'?r:(r&0x3|0x8)).toString(16);
    });
  }

  /* ── Fetch with credentials ── */
  function igFetch(url, opts) {
    opts = opts || {};
    var csrf = getCookie('csrftoken') || '';
    var headers = Object.assign({
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-CSRFToken': csrf,
      'X-IG-App-ID': '936619743392459',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Instagram-AJAX': '1',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'Referer': 'https://www.instagram.com/',
    }, opts.headers || {});

    return fetch(url, {
      method: opts.method || 'GET',
      credentials: 'include',
      headers: headers,
      body: opts.body || undefined,
    }).then(function(r) {
      console.log('[GRAMPTIOUS]', opts.method||'GET', r.url, r.status);
      if (r.status === 401) throw new Error('NOT_AUTHENTICATED');
      if (r.status === 429) throw new Error('RATE_LIMITED');
      if (r.status === 400) {
        return r.text().then(function(t){
          console.log('[GRAMPTIOUS] 400 body:', t.slice(0,300));
          throw new Error('HTTP_400');
        });
      }
      if (!r.ok) throw new Error('HTTP_' + r.status);
      return r.text().then(function(t){
        try { return JSON.parse(t); }
        catch(e) {
          console.log('[GRAMPTIOUS] Non-JSON response:', t.slice(0,200));
          throw new Error('NOT_AUTHENTICATED');
        }
      });
    });
  }

  /* ── Get current user ── */
  function getCurrentUser() {
    var userId = getCookie('ds_user_id');
    console.log('[GRAMPTIOUS] ds_user_id:', userId);
    if (!userId) return Promise.reject(new Error('NO_USER_ID_COOKIE'));
    return igFetch('https://www.instagram.com/api/v1/users/' + userId + '/info/')
      .then(function(d) {
        var u = d.user;
        return {
          userId: String(u.pk || userId),
          username: u.username,
          fullName: u.full_name || '',
          profilePicUrl: u.profile_pic_url || '',
        };
      });
  }

  /* ── Fetch paginated list ── */
  function fetchList(userId, endpoint, onProgress) {
    var results = [];
    var nextMaxId = null;
    var total = null;

    function page() {
      var url = 'https://www.instagram.com/api/v1/friendships/' + userId + '/' + endpoint + '/?count=50&rank_token=' + makeRankToken(userId);
      if (nextMaxId) url += '&max_id=' + encodeURIComponent(nextMaxId);

      return igFetch(url).then(function(d) {
        if (!d || typeof d !== 'object') throw new Error('BAD_RESPONSE');
        var batch = (d.users || []).map(function(u) {
          return {
            userId: String(u.pk || u.id || ''),
            username: u.username || '',
            fullName: u.full_name || '',
            profilePicUrl: u.profile_pic_url || '',
            isPrivate: !!u.is_private,
            isVerified: !!u.is_verified,
          };
        });
        results = results.concat(batch);
        if (total === null && d.count != null) total = d.count;
        if (onProgress) onProgress(results.length, total != null ? total : results.length);
        nextMaxId = d.next_max_id || null;
        if (nextMaxId) return sleep(600 + Math.random()*400).then(page);
        return results;
      });
    }
    return page();
  }

  /* ── Unfollow ── */
  function unfollowUser(userId) {
    return igFetch('https://www.instagram.com/api/v1/friendships/destroy/' + userId + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'user_id=' + userId,
    });
  }

  /* ── Follow ── */
  function followUser(userId) {
    return igFetch('https://www.instagram.com/api/v1/friendships/create/' + userId + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'user_id=' + userId,
    });
  }

  /* ── Message listener ── */
  chrome.runtime.onMessage.addListener(function(msg, _s, sendResponse) {
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'GET_USER') {
      getCurrentUser()
        .then(function(u){ sendResponse({ user: u }); })
        .catch(function(e){ sendResponse({ error: e.message }); });
      return true;
    }
    if (msg.type === 'FETCH_FOLLOWING') {
      fetchList(msg.userId, 'following', function(n,t){
        try{ chrome.runtime.sendMessage({type:'PROGRESS',phase:'following',fetched:n,total:t}); }catch(e){}
      }).then(function(l){ sendResponse({ list: l }); })
        .catch(function(e){ sendResponse({ error: e.message }); });
      return true;
    }
    if (msg.type === 'FETCH_FOLLOWERS') {
      fetchList(msg.userId, 'followers', function(n,t){
        try{ chrome.runtime.sendMessage({type:'PROGRESS',phase:'followers',fetched:n,total:t}); }catch(e){}
      }).then(function(l){ sendResponse({ list: l }); })
        .catch(function(e){ sendResponse({ error: e.message }); });
      return true;
    }
    if (msg.type === 'FOLLOW_BY_USERNAME') {
      // Resolve username to userId then follow
      igFetch('https://www.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent(msg.username))
        .then(function(d) {
          var u = d && d.data && d.data.user;
          if (!u) throw new Error('USER_NOT_FOUND');
          return igFetch('https://www.instagram.com/api/v1/friendships/create/' + u.id + '/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'user_id=' + u.id,
          }).then(function(r) {
            return { ok: true, userId: String(u.id), username: u.username, fullName: u.full_name || '' };
          });
        })
        .then(function(r){ sendResponse(r); })
        .catch(function(e){ sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (msg.type === 'UNFOLLOW') {
      unfollowUser(msg.userId)
        .then(function(){ sendResponse({ ok: true }); })
        .catch(function(e){ sendResponse({ ok: false, error: e.message }); });
      return true;
    }
    if (msg.type === 'FOLLOW') {
      followUser(msg.userId)
        .then(function(){ sendResponse({ ok: true }); })
        .catch(function(e){ sendResponse({ ok: false, error: e.message }); });
      return true;
    }
    return false;
  });

  try { chrome.runtime.sendMessage({ type: 'ANNOUNCE_IG_TAB' }); } catch(e) {}
  console.log('[GRAMPTIOUS] content script loaded');
})();
