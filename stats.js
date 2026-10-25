/*
 * 暗棋：本機帳號與紀錄（第二步 b-2）。寫法參考五子棋的 stats.js（帳號 gomoku.profiles.v1、紀錄 gomoku.games.v1、同一個 ts 只留一筆），
 * 但不共用程式：暗棋自己一份，存在自己的鍵。
 *
 * 帳號 banqi.profiles.v1：{ v: 1, current, defaultId, list: [{ id, name, created, rating? }] }，最多 8 個；一定有一個（第一次開頁時建預設帳號）。
 *   rating（積分，rating.js）：{ classic: { r, games, badge }, chain: { r, games, badge } }，每種玩法各自；沒有這一欄或少一種玩法＝那種玩法還沒計分（起始 1000）。
 *   改名留著積分；刪帳號連同積分一起刪（跟紀錄一樣）。
 * 設定（banqi.settings.v1）是整台裝置共用的，不分帳號。
 * 紀錄 banqi.games.v1：每盤下完一筆，最多留 500 筆（最舊的先丟）。欄位：
 *   ts（開局時間，也是去重鍵：同一盤只留一筆）、at（結束時間）、pid（記在哪個帳號）、mode 'classic'|'chain'、
 *   opp 'ai'|'pvp'、level 1–7（7＝神將，2026-10-25 加；兩人同機是 null）、color 'r'|'b'|null（我的顏色；兩人同機＝下方玩家的顏色）、
 *   result 'win'|'loss'|'draw'（我的角度；兩人同機＝下方玩家的角度）、reason 'noPieces'|'noMoves'|'resign'|'drawPlies'|'repetition'、
 *   plies 步數（引擎的 ply）、drawPlies 這盤的平手步數。
 *   計分的盤（跟電腦下、認得的等級）另有 elo: { before, after, delta, opp }（賽前、賽後積分、加減、電腦的積分）；
 *   接著下時按「不要了」算輸的盤：reason 'resign'＋abandon: true（reason 不另開新值：舊版的 validGame 會把不認得的 reason 丟掉）。
 * 這裡全是純函式＋localStorage 的讀寫，不碰 DOM。
 */
(function (root) {
  'use strict';
  var PKEY = 'banqi.profiles.v1', GKEY = 'banqi.games.v1';
  var MAX_PROFILES = 8, MAX_GAMES = 500, NAME_MAX = 12;
  var MODES = ['classic', 'chain'], LEVELS = [1, 2, 3, 4, 5, 6, 7]; // ＝ ai.js 的 LEVELS 的 id（test.js 核對）
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
  // 積分欄：每種玩法一份 { r 有限的數, games 非負整數（不對＝0）, badge 字串或 null }；r 不對的那一份丟掉（＝還沒計分）。
  // 不認得的玩法鍵（之後的版本加的）照樣留著，不丟。一份都沒有＝undefined（帳號上不放這一欄）
  function cleanRating(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined;
    var out = {}, n = 0;
    Object.keys(x).forEach(function (m) {
      var e = x[m];
      if (!e || typeof e !== 'object' || typeof e.r !== 'number' || !isFinite(e.r)) return;
      out[m] = { r: e.r, games: typeof e.games === 'number' && e.games >= 0 && e.games % 1 === 0 ? e.games : 0, badge: typeof e.badge === 'string' ? e.badge : null };
      n++;
    });
    return n ? out : undefined;
  }
  function readProfiles() {
    var st = readJSON(PKEY, null);
    if (!st || typeof st !== 'object' || Array.isArray(st) || !Array.isArray(st.list)) return null;
    st.list = st.list.filter(validProfile).map(function (p) {
      var q = { id: p.id, name: cleanName(p.name, '?'), created: typeof p.created === 'number' ? p.created : 0 }, rt = cleanRating(p.rating);
      if (rt) q.rating = rt;
      return q;
    });
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
  // 寫回一種玩法的積分（rating.js 的 rateGame 給的 entry）；別的玩法那一份不動
  function setRating(id, mode, ent) {
    var st = readProfiles();
    if (!st || !ent || typeof ent.r !== 'number' || !isFinite(ent.r)) return false;
    var hit = false;
    st.list.forEach(function (p) {
      if (p.id !== id) return;
      p.rating = p.rating || {};
      p.rating[mode] = { r: ent.r, games: ent.games, badge: ent.badge };
      hit = true;
    });
    return hit && writeJSON(PKEY, st);
  }
  // 刪帳號：連同他的紀錄（積分在帳號上，跟著帳號一起沒了）。最後一個不能刪
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
  // 等級：認得的（LEVELS）照常；不認得的正整數（之後的版本加的等級，例如 8）也留著，不丟、不改寫——舊版把新等級的紀錄丟掉再整串寫回去，
  // 紀錄就沒了（v0.1.4 的 stats.js 對第 7 級就是這樣，已經改不了）。這種紀錄在統計表裡算在「其他」那一列（summary 的 rows.other）
  function validLevel(lv) { return typeof lv === 'number' && lv > 0 && lv % 1 === 0 && lv < 1000; }
  function validGame(g) {
    return g && typeof g === 'object' && typeof g.ts === 'number' && isFinite(g.ts) && typeof g.pid === 'string' &&
      MODES.indexOf(g.mode) >= 0 && (g.opp === 'ai' || g.opp === 'pvp') && (g.opp === 'pvp' || validLevel(g.level)) &&
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

  // 統計：每種玩法一份；opp 一列一個（電腦 1–7、不認得的等級合成一列 other、兩人同機），每列 n／w／d／l；結束原因每一種的 w／d／l
  function summary(list) {
    var out = {};
    MODES.forEach(function (m) {
      var rows = {}, reasons = {}, tot = { n: 0, w: 0, d: 0, l: 0 };
      LEVELS.forEach(function (lv) { rows[lv] = { n: 0, w: 0, d: 0, l: 0 }; });
      rows.pvp = { n: 0, w: 0, d: 0, l: 0 };
      rows.other = { n: 0, w: 0, d: 0, l: 0 };
      REASONS.forEach(function (r) { reasons[r] = { w: 0, d: 0, l: 0 }; });
      list.forEach(function (g) {
        if (g.mode !== m) return;
        var row = rows[g.opp === 'pvp' ? 'pvp' : LEVELS.indexOf(g.level) >= 0 ? g.level : 'other'], k = g.result === 'win' ? 'w' : g.result === 'loss' ? 'l' : 'd';
        row.n++; row[k]++; tot.n++; tot[k]++;
        reasons[g.reason][k]++;
      });
      out[m] = { rows: rows, total: tot, reasons: reasons };
    });
    return out;
  }
  // 這些紀錄裡這種玩法計分過的盤最高到幾分（elo.after 的最大值）；沒有計分過的盤＝null。
  // 紀錄最多留 500 盤，更早的盤丟掉以後就不算在裡面（紀錄頁另外拿現在的積分比，見 app.js renderRecords）
  function peak(list, mode) {
    var best = null;
    list.forEach(function (g) {
      if (g.mode !== mode || !g.elo || typeof g.elo.after !== 'number' || !isFinite(g.elo.after)) return;
      if (best === null || g.elo.after > best) best = g.elo.after;
    });
    return best;
  }
  // 勝率＝贏的盤數／總盤數（照五子棋 stats.js 的 rate：w／n，和棋不算贏）；0 盤是 null
  function winRate(r) { return r.n ? r.w / r.n : null; }

  root.BanqiStats = {
    PKEY: PKEY, GKEY: GKEY, MAX_PROFILES: MAX_PROFILES, NAME_MAX: NAME_MAX, MODES: MODES, LEVELS: LEVELS, REASONS: REASONS,
    initProfiles: initProfiles, profileList: profileList, profile: profile, current: current, setCurrent: setCurrent,
    addProfile: addProfile, renameProfile: renameProfile, deleteProfile: deleteProfile, setRating: setRating,
    loadGames: loadGames, loadFor: loadFor, upsert: upsert, find: find, validGame: validGame, validLevel: validLevel,
    summary: summary, winRate: winRate, timeOf: timeOf, peak: peak
  };
})(typeof self !== 'undefined' ? self : this);
