/*
 * 暗棋：本機帳號與紀錄（第二步 b-2）。寫法參考五子棋的 stats.js（帳號 gomoku.profiles.v1、紀錄 gomoku.games.v1、同一個 ts 只留一筆），
 * 但不共用程式：暗棋自己一份，存在自己的鍵。
 *
 * 帳號 banqi.profiles.v1：{ v: 1, current, defaultId, list: [{ id, name, created }] }，最多 8 個；一定有一個（第一次開頁時建預設帳號）。
 * 設定（banqi.settings.v1）是整台裝置共用的，不分帳號。
 * 紀錄 banqi.games.v1：每盤下完一筆，最多留 500 筆（最舊的先丟）。欄位：
 *   ts（開局時間，也是去重鍵：同一盤只留一筆）、at（結束時間）、pid（記在哪個帳號）、mode 'classic'|'chain'、
 *   opp 'ai'|'pvp'、level 1–6（兩人同機是 null）、color 'r'|'b'|null（我的顏色；兩人同機＝下方玩家的顏色）、
 *   result 'win'|'loss'|'draw'（我的角度；兩人同機＝下方玩家的角度）、reason 'noPieces'|'noMoves'|'resign'|'drawPlies'|'repetition'、
 *   plies 步數（引擎的 ply）、drawPlies 這盤的平手步數。
 * 這裡全是純函式＋localStorage 的讀寫，不碰 DOM。
 */
(function (root) {
  'use strict';
  var PKEY = 'banqi.profiles.v1', GKEY = 'banqi.games.v1';
  var MAX_PROFILES = 8, MAX_GAMES = 500, NAME_MAX = 12;
  var MODES = ['classic', 'chain'], LEVELS = [1, 2, 3, 4, 5, 6];
  var REASONS = ['noPieces', 'noMoves', 'resign', 'drawPlies', 'repetition'];

  function readJSON(key, dflt) {
    try { var v = JSON.parse(localStorage.getItem(key) || 'null'); return v === null ? dflt : v; } catch (e) { return dflt; }
  }
  function writeJSON(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch (e) { return false; }
  }
  function newId() { return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
  function cleanName(s, fallback) {
    var n = String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    return n || fallback;
  }

  // ---------------------------------------------------------- 帳號
  function validProfile(p) { return p && typeof p === 'object' && typeof p.id === 'string' && p.id && typeof p.name === 'string'; }
  function readProfiles() {
    var st = readJSON(PKEY, null);
    if (!st || typeof st !== 'object' || Array.isArray(st) || !Array.isArray(st.list)) return null;
    st.list = st.list.filter(validProfile).map(function (p) { return { id: p.id, name: cleanName(p.name, '?'), created: typeof p.created === 'number' ? p.created : 0 }; });
    if (!st.list.length) return null;
    if (!st.list.some(function (p) { return p.id === st.current; })) st.current = st.list[0].id;
    if (!st.list.some(function (p) { return p.id === st.defaultId; })) st.defaultId = st.list[0].id;
    st.v = 1;
    return st;
  }
  // 開頁時呼叫一次：還沒有帳號（或存的壞掉）就建一個預設帳號
  function initProfiles(defaultName) {
    var st = readProfiles();
    if (st) return st;
    var p = { id: newId(), name: cleanName(defaultName, 'Player'), created: Date.now() };
    st = { v: 1, current: p.id, defaultId: p.id, list: [p] };
    writeJSON(PKEY, st);
    return st;
  }
  function profileList() { var st = readProfiles(); return st ? st.list : []; }
  function profile(id) {
    var l = profileList();
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    return null;
  }
  function current() { var st = readProfiles(); return st ? profile(st.current) : null; }
  function setCurrent(id) {
    var st = readProfiles();
    if (!st || !st.list.some(function (p) { return p.id === id; })) return false;
    st.current = id;
    return writeJSON(PKEY, st);
  }
  function addProfile(name) {
    var st = readProfiles();
    if (!st || st.list.length >= MAX_PROFILES) return null;
    var p = { id: newId(), name: cleanName(name, 'Player ' + (st.list.length + 1)), created: Date.now() };
    st.list.push(p);
    writeJSON(PKEY, st);
    return p;
  }
  function renameProfile(id, name) {
    var st = readProfiles();
    if (!st) return null;
    var hit = null;
    st.list.forEach(function (p) { if (p.id === id) { p.name = cleanName(name, p.name); hit = p; } });
    if (hit) writeJSON(PKEY, st);
    return hit;
  }
  // 刪帳號：連同他的紀錄。最後一個不能刪
  function deleteProfile(id) {
    var st = readProfiles();
    if (!st || st.list.length <= 1 || !st.list.some(function (p) { return p.id === id; })) return false;
    saveGames(loadGames().filter(function (g) { return g.pid !== id; }));
    st.list = st.list.filter(function (p) { return p.id !== id; });
    if (st.current === id) st.current = st.list[0].id;
    if (st.defaultId === id) st.defaultId = st.list[0].id;
    return writeJSON(PKEY, st);
  }

  // ---------------------------------------------------------- 紀錄
  function validGame(g) {
    return g && typeof g === 'object' && typeof g.ts === 'number' && isFinite(g.ts) && typeof g.pid === 'string' &&
      MODES.indexOf(g.mode) >= 0 && (g.opp === 'ai' || g.opp === 'pvp') && (g.opp === 'pvp' || LEVELS.indexOf(g.level) >= 0) &&
      (g.result === 'win' || g.result === 'loss' || g.result === 'draw') && REASONS.indexOf(g.reason) >= 0;
  }
  function timeOf(g) { return typeof g.at === 'number' ? g.at : g.ts; }
  function loadGames() {
    var a = readJSON(GKEY, []);
    return Array.isArray(a) ? a.filter(validGame) : [];
  }
  function saveGames(list) {
    list.sort(function (a, b) { return timeOf(a) - timeOf(b) || a.ts - b.ts; });
    if (list.length > MAX_GAMES) list = list.slice(list.length - MAX_GAMES);
    return writeJSON(GKEY, list);
  }
  // 同一盤（同一個 ts）再記一次就取代
  function upsert(rec) {
    if (!validGame(rec)) return false;
    var list = loadGames().filter(function (g) { return g.ts !== rec.ts; });
    list.push(rec);
    return saveGames(list);
  }
  function find(ts) {
    var l = loadGames();
    for (var i = 0; i < l.length; i++) if (l[i].ts === ts) return l[i];
    return null;
  }
  function loadFor(pid) { return loadGames().filter(function (g) { return g.pid === pid; }); }

  // 統計：每種玩法一份；opp 一列一個（電腦 1–6、兩人同機），每列 n／w／d／l；結束原因每一種的 w／d／l
  function summary(list) {
    var out = {};
    MODES.forEach(function (m) {
      var rows = {}, reasons = {}, tot = { n: 0, w: 0, d: 0, l: 0 };
      LEVELS.forEach(function (lv) { rows[lv] = { n: 0, w: 0, d: 0, l: 0 }; });
      rows.pvp = { n: 0, w: 0, d: 0, l: 0 };
      REASONS.forEach(function (r) { reasons[r] = { w: 0, d: 0, l: 0 }; });
      list.forEach(function (g) {
        if (g.mode !== m) return;
        var row = rows[g.opp === 'pvp' ? 'pvp' : g.level], k = g.result === 'win' ? 'w' : g.result === 'loss' ? 'l' : 'd';
        row.n++; row[k]++; tot.n++; tot[k]++;
        reasons[g.reason][k]++;
      });
      out[m] = { rows: rows, total: tot, reasons: reasons };
    });
    return out;
  }
  // 勝率＝贏的盤數／總盤數（照五子棋 stats.js 的 rate：w／n，和棋不算贏）；0 盤是 null
  function winRate(r) { return r.n ? r.w / r.n : null; }

  root.BanqiStats = {
    PKEY: PKEY, GKEY: GKEY, MAX_PROFILES: MAX_PROFILES, NAME_MAX: NAME_MAX, MODES: MODES, LEVELS: LEVELS, REASONS: REASONS,
    initProfiles: initProfiles, profileList: profileList, profile: profile, current: current, setCurrent: setCurrent,
    addProfile: addProfile, renameProfile: renameProfile, deleteProfile: deleteProfile,
    loadGames: loadGames, loadFor: loadFor, upsert: upsert, find: find, validGame: validGame,
    summary: summary, winRate: winRate, timeOf: timeOf
  };
})(typeof self !== 'undefined' ? self : this);
