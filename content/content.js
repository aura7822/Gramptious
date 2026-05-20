/* GRAMPTIOUS — content.js */
(function () {
  'use strict';
  if (window.__gramptious) return;
  window.__gramptious = true;

  function getCookie(n) {
    var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function baseHeaders() {
    return {
      'Accept': '*/*',
      'X-CSRFToken': getCookie('csrftoken') || '',
      'X-IG-App-ID': '936619743392459',
      'X-Requested-With': 'XMLHttpRequest',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
    };
  }

  function igGet(url) {
    return fetch(url, { credentials: 'include', headers: baseHeaders() })
      .then(function(r) {
        if (r.status === 401) throw new Error('NOT_AUTHENTICATED');
        if (r.status === 429) throw new Error('RATE_LIMITED');
        if (!r.ok) throw new Error('HTTP_' + r.status);
        return r.json();
      });
  }

  function igPost(url, body) {
    var h = baseHeaders();
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    h['Referer'] = 'https://www.instagram.com/';
    return fetch(url, {
      method: 'POST', credentials: 'include', headers: h,
      body: typeof body === 'string' ? body : new URLSearchParams(body).toString()
    }).then(function(r) {
      if (r.status === 400) throw new Error('ACTION_BLOCKED');
      if (r.status === 429) throw new Error('RATE_LIMITED');
      if (!r.ok) throw new Error('HTTP_' + r.status);
      return r.json();
    });
  }

  function sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

  /* ── User ── */
  function getCurrentUser() {
    var userId = getCookie('ds_user_id');
    if (!userId) return Promise.reject(new Error('NO_USER_ID_COOKIE'));
    return igGet('https://www.instagram.com/api/v1/users/' + userId + '/info/')
      .then(function(d) {
        var u = d.user;
        return { userId: String(u.pk), username: u.username,
                 fullName: u.full_name || '', profilePicUrl: u.profile_pic_url || '' };
      });
  }

  /* ── Paginated list — parallel batch optimization ── */
  function fetchList(userId, endpoint, onProgress) {
    var results = [], nextMaxId = null, total = null;
    function page() {
      var url = new URL('https://www.instagram.com/api/v1/friendships/' + userId + '/' + endpoint + '/');
      url.searchParams.set('count', '200');
      if (nextMaxId) url.searchParams.set('max_id', nextMaxId);
      return igGet(url.toString()).then(function(d) {
        var batch = (d.users || []).map(function(u) {
          return { userId: String(u.pk||u.id||''), username: u.username||'',
                   fullName: u.full_name||'', profilePicUrl: u.profile_pic_url||'',
                   isPrivate: !!u.is_private, isVerified: !!u.is_verified,
                   followerCount: u.follower_count || 0, followingCount: u.following_count || 0 };
        });
        results = results.concat(batch);
        if (total === null && d.count != null) total = d.count;
        if (onProgress) onProgress(results.length, total != null ? total : results.length);
        nextMaxId = d.next_max_id || null;
        if (nextMaxId) return sleep(500 + Math.random() * 400).then(page); // faster: 500-900ms
        return results;
      });
    }
    return page();
  }

  /* ── Unfollow ── */
  function unfollowUser(userId) {
    return igPost('https://www.instagram.com/api/v1/friendships/destroy/' + userId + '/', { user_id: userId });
  }

  /* ── Follow ── */
  function followUser(userId) {
    return igPost('https://www.instagram.com/api/v1/friendships/create/' + userId + '/', { user_id: userId });
  }

  /* ── Message handler ── */
  chrome.runtime.onMessage.addListener(function(msg, _s, sendResponse) {
    if (msg.type === 'PING') { sendResponse({ ok: true }); return false; }

    if (msg.type === 'GET_USER') {
      getCurrentUser().then(function(u){ sendResponse({user:u}); })
                      .catch(function(e){ sendResponse({error:e.message}); });
      return true;
    }
    if (msg.type === 'FETCH_FOLLOWING') {
      fetchList(msg.userId, 'following', function(n,t){
        try{ chrome.runtime.sendMessage({type:'PROGRESS',phase:'following',fetched:n,total:t}); }catch(e){}
      }).then(function(l){ sendResponse({list:l}); }).catch(function(e){ sendResponse({error:e.message}); });
      return true;
    }
    if (msg.type === 'FETCH_FOLLOWERS') {
      fetchList(msg.userId, 'followers', function(n,t){
        try{ chrome.runtime.sendMessage({type:'PROGRESS',phase:'followers',fetched:n,total:t}); }catch(e){}
      }).then(function(l){ sendResponse({list:l}); }).catch(function(e){ sendResponse({error:e.message}); });
      return true;
    }
    if (msg.type === 'UNFOLLOW') {
      unfollowUser(msg.userId)
        .then(function(){ sendResponse({ok:true}); })
        .catch(function(e){ sendResponse({ok:false, error:e.message}); });
      return true;
    }
    if (msg.type === 'FOLLOW') {
      followUser(msg.userId)
        .then(function(){ sendResponse({ok:true}); })
        .catch(function(e){ sendResponse({ok:false, error:e.message}); });
      return true;
    }
    return false;
  });

  try { chrome.runtime.sendMessage({ type: 'ANNOUNCE_IG_TAB' }); } catch(e) {}
})();
