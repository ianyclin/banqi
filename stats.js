/*
 * 暗棋：本機帳號與紀錄（第二步 b-2）。寫法參考五子棋的 stats.js（帳號 gomoku.profiles.v1、紀錄 gomoku.games.v1、同一個 ts 只留一筆），
 * 但不共用程式：暗棋自己一份，存在自己的鍵。
 *
 * 帳號 banqi.profiles.v1：{ v: 1, current, defaultId, list: [{ id, name, created, rating? }] }，最多 8 個；一定有一個（第一次開頁時建預設帳號）。
 *   rating（積分，rating.js）：{ classic: { r, games, badge }, chain: { r, games, badge } }，每種玩法各自；沒有這一欄或少一種玩法＝那種玩法還沒計分（起始 1000）。
 *   改名留著積分；刪帳號連同積分一起刪（跟紀錄一樣）。
 *   achievements（成就，2026-10-25）：{ 成就 id: 解鎖時間（ms） }；沒有這一欄＝一個都還沒有。不認得的 id 照樣留著。見下面「成就」那一段。
 *   帳號上不認得的欄位（之後的版本加的）讀寫時原樣留著。
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
  // 成就欄 { 成就 id: 解鎖時間（ms） }：時間是正的有限數的才留；不認得的 id（之後的版本加的成就）照樣留著，不丟。一個都沒有＝undefined
  function cleanAchievements(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined;
    var out = {}, n = 0;
    Object.keys(x).forEach(function (id) {
      var v = x[id];
      if (typeof v !== 'number' || !isFinite(v) || v <= 0) return;
      out[id] = v;
      n++;
    });
    return n ? out : undefined;
  }
  // 讀帳號：認得的欄位（id、name、created、rating、achievements）照規則清；不認得的欄位（之後的版本加的）原樣留著——
  // v0.1.7 以前的這支只留認得的欄位，舊版的分頁一寫回去，新版加的欄位就沒了（v0.1.7 對 achievements 就是這樣，已經改不了）
  function readProfiles() {
    var st = readJSON(PKEY, null);
    if (!st || typeof st !== 'object' || Array.isArray(st) || !Array.isArray(st.list)) return null;
    st.list = st.list.filter(validProfile).map(function (p) {
      var q = { id: p.id, name: cleanName(p.name, '?'), created: typeof p.created === 'number' ? p.created : 0 }, rt = cleanRating(p.rating), ac = cleanAchievements(p.achievements);
      Object.keys(p).forEach(function (k) { if (!Object.prototype.hasOwnProperty.call(q, k) && k !== 'rating' && k !== 'achievements' && k !== '__proto__') q[k] = p[k]; });
      if (rt) q.rating = rt;
      if (ac) q.achievements = ac;
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

  // ---------------------------------------------------------- 成就（2026-10-25；照五子棋 stats.js 的成就改的，不共用程式）
  // 每盤下完、跟積分同一個時候算一次（app.js recordGame、接著下的「不要了」abandonResume）。順序＝紀錄頁的順序。
  // 只看跟電腦下的盤；唯一的例外是 pvp（同機對決）。放棄（接著下按「不要了」）算輸，照輸棋看。
  // 兩種來源：
  //   1. 對局紀錄（banqi.games.v1）＋帳號的積分：achDerive。紀錄裡有的就回推得出來（開新版第一次開頁時靜靜補，日期用那一盤的）。
  //   2. 這一盤的每一步（棋譜）：achFacts＋achFromFacts（連吃幾子、誰吃了帥、落後過幾子、被吃幾子）。
  //      紀錄裡沒有存棋譜，所以這幾個（chain_3、chain_5、pawn_king、cannon_king、comeback、flawless）回推不了，從這一版開始下的盤才算。
  var ACH = ['first_game', 'first_win', 'games_100', 'chain_3', 'chain_5', 'pawn_king', 'cannon_king', 'no_moves', 'comeback', 'flawless',
    'beat_l6', 'beat_l7', 'tianpeng', 'all_levels', 'streak_3', 'badge_gold', 'badge_master', 'pvp'];
  var ACH_FLOOR = Date.UTC(2020, 0, 1);
  var STREAK_MIN_LEVEL = 4, STREAK_N = 3, GAMES_N = 100, TIANPENG_N = 10, TIANPENG_LEVEL = 7, COMEBACK_N = 5, FLAWLESS_MAX = 3, CHAIN_A = 3, CHAIN_B = 5;
  function saneAt(v) { return typeof v === 'number' && isFinite(v) && v >= ACH_FLOOR; }
  function byTime(a, b) { return timeOf(a) - timeOf(b) || a.ts - b.ts; }
  function rated(g) { return !!(g.elo && typeof g.elo.after === 'number' && isFinite(g.elo.after)); }
  // 徽章的先後（rating.js 的 BADGES；瀏覽器下 rating.js 先載）。認不得＝-1
  function badgeRank(key) {
    var B = root.BanqiRating && root.BanqiRating.BADGES;
    if (!B) return -1;
    for (var i = 0; i < B.length; i++) if (B[i].key === key) return i;
    return -1;
  }
  function badgeMin(key) { var B = root.BanqiRating && root.BanqiRating.BADGES, i = badgeRank(key); return i < 0 ? null : B[i].min; }

  // 從紀錄與帳號回推：{ 成就 id: 成立的時間（ms） }，不成立的不在裡面。list＝這個帳號的紀錄（別的帳號的會濾掉）。
  // opts：{ levels 等級 id 的清單（一路過關要全贏過；省略＝LEVELS，跟 ai.js 的 LEVELS 一樣）, now 只看得到現在的徽章時用的時間 }
  function achDerive(list, prof, opts) {
    opts = opts || {};
    var levels = opts.levels || LEVELS, now = typeof opts.now === 'number' ? opts.now : Date.now(), out = {};
    function set(id, at) { if (!(id in out)) out[id] = at; }
    var pid = prof ? prof.id : null;
    var mine = (list || []).filter(function (g) { return validGame(g) && (pid === null || g.pid === pid); }).sort(byTime);
    var nAi = 0, n7 = 0, run = 0, beat = {}, gold = badgeMin('gold'), master = badgeMin('master');
    mine.forEach(function (g) {
      var at = timeOf(g);
      if (g.opp === 'pvp') { set('pvp', at); return; } // 兩人同機只算同機對決
      nAi++;
      set('first_game', at);
      if (nAi === GAMES_N) set('games_100', at);
      if (g.result === 'win') {
        set('first_win', at);
        if (g.reason === 'noMoves') set('no_moves', at); // 規則 6.2：對方沒有步可以走（不是子被吃光 noPieces）
        if (g.level === 6) set('beat_l6', at);
        if (g.level === TIANPENG_LEVEL) { set('beat_l7', at); if (++n7 === TIANPENG_N) set('tianpeng', at); }
        if (levels.indexOf(g.level) >= 0 && !beat[g.level]) {
          beat[g.level] = true;
          if (levels.every(function (lv) { return beat[lv]; })) set('all_levels', at);
        }
      }
      // 三連勝：只看計分的盤（有 elo）；中級（4）以上贏＋1，輸、和、放棄歸零；4 以下的不加也不斷
      if (rated(g) && g.level >= STREAK_MIN_LEVEL) {
        run = g.result === 'win' ? run + 1 : 0;
        if (run >= STREAK_N) set('streak_3', at);
      }
      // 徽章：升級是立刻的（rating.js badgeAfter），所以賽後積分到了那一級的下限＝那一盤升上去
      if (rated(g)) {
        if (gold !== null && g.elo.after >= gold) set('badge_gold', at);
        if (master !== null && g.elo.after >= master) set('badge_master', at);
      }
    });
    // 現在帳號上的徽章（紀錄只留最近 500 盤，更早升上去的盤可能已經丟了）：日期不明，用 now
    var rt = prof && prof.rating;
    if (rt && typeof rt === 'object') Object.keys(rt).forEach(function (m) {
      var b = rt[m] && typeof rt[m] === 'object' ? badgeRank(rt[m].badge) : -1;
      if (b >= 0 && b >= badgeRank('gold')) set('badge_gold', now);
      if (b >= 0 && b >= badgeRank('master')) set('badge_master', now);
    });
    return out;
  }

  // 這一盤每一步的事實（引擎重播棋譜，decodeRecord 的 onMove）。me＝這個帳號的那一位（引擎的 0 先手／1 後手）。
  // 回傳 { chain 一手最多吃幾子, pawnKing 兵吃了帥, cannonKing 炮吃了帥, trail 最多落後幾子, lost 被吃幾子, color 我的顏色 }；棋譜讀不了＝null。
  //   「吃」＝走步吃、炮跳吃、攻擊暗子成功（翻開的是對方的子、而且吃得了）；攻擊暗子失敗不算。一手＝一個人走一次，連吃整串算一手（規則 12）。
  //   炮攻擊暗子（連吃玩法）也是炮跳吃。帥＝對方的帥／將（K／k）。
  //   落後：每一手走完（雙方都算）看公開的被吃子數：我還在的子＝16 − 我被吃的，暗子顏色看得出來（照被吃的數就知道）；
  //   落後幾子＝我被吃的 − 對方被吃的。顏色還沒定（第一手翻之前）不算落後。
  function achFacts(text, me) {
    var E = root.BanqiEngine;
    if (!E || typeof text !== 'string' || (me !== 0 && me !== 1)) return null;
    var f = { chain: 0, pawnKing: false, cannonKing: false, trail: 0, lost: 0, color: null };
    function lostOf(cap, col) { var n = 0; for (var i = 0; i < cap.length; i++) if (E.colorOf(cap[i]) === col) n++; return n; }
    var s;
    try {
      s = E.decodeRecord(text, function (mv) {
        if (mv.player === me) {
          var n = 0;
          mv.events.forEach(function (ev) {
            var x = ev.type === 'capture' ? ev.captured : ev.type === 'attack' && ev.success ? ev.revealed : null;
            if (!x) return;
            n++;
            if (E.typeOf(x) === 'K' && E.typeOf(ev.piece) === 'P') f.pawnKing = true;
            if (E.typeOf(x) === 'K' && E.typeOf(ev.piece) === 'C') f.cannonKing = true;
          });
          if (n > f.chain) f.chain = n;
        }
        var col = mv.state.colors[me];
        if (col) {
          var d = lostOf(mv.state.captured, col) - lostOf(mv.state.captured, col === 'r' ? 'b' : 'r');
          if (d > f.trail) f.trail = d;
        }
      });
    } catch (e) { return null; }
    f.color = s.colors[me] || null;
    f.lost = f.color ? lostOf(s.captured, f.color) : 0;
    return f;
  }
  // 這一盤的事實 → 成立的成就 id（照 ACH 的順序）。rec＝這一盤的紀錄（opp、result）；兩人同機一個都不算
  function achFromFacts(rec, f) {
    if (!rec || rec.opp !== 'ai' || !f) return [];
    var win = rec.result === 'win', out = [];
    if (f.chain >= CHAIN_A) out.push('chain_3');
    if (f.chain >= CHAIN_B) out.push('chain_5');
    if (f.pawnKing) out.push('pawn_king');
    if (f.cannonKing) out.push('cannon_king');
    if (win && f.trail >= COMEBACK_N) out.push('comeback');
    if (win && f.lost <= FLAWLESS_MAX) out.push('flawless');
    return out;
  }

  // 照現在的紀錄（＋這一盤的 extra：{ 成就 id: 時間 }）補上新成立的成就，寫回帳號；回傳這次新加的 id（照 ACH 的順序）。
  // 已經有的不動（不會重複解鎖、日期不改）；拿到的不會拿掉（紀錄被刪、超過 500 盤丟掉也一樣）。
  function achSync(pid, extra, now) {
    now = typeof now === 'number' ? now : Date.now();
    var st = readProfiles();
    if (!st) return [];
    var p = null;
    st.list.forEach(function (x) { if (x.id === pid) p = x; });
    if (!p) return [];
    var d = achDerive(loadFor(pid), p, { now: now });
    Object.keys(extra || {}).forEach(function (id) { if (!(id in d)) d[id] = extra[id]; });
    var got = p.achievements || {}, fresh = [];
    ACH.forEach(function (id) {
      if (got[id] || !(id in d)) return;
      got[id] = saneAt(d[id]) ? d[id] : now;
      fresh.push(id);
    });
    if (fresh.length) { p.achievements = got; writeJSON(PKEY, st); }
    return fresh;
  }
  // 紀錄頁用：[{ id, at 解鎖時間或 null }]，照 ACH 的順序（不認得的 id 不列）
  function achList(pid) {
    var p = profile(pid), got = p && p.achievements ? p.achievements : {};
    return ACH.map(function (id) { return { id: id, at: got[id] || null }; });
  }

  root.BanqiStats = {
    PKEY: PKEY, GKEY: GKEY, MAX_PROFILES: MAX_PROFILES, NAME_MAX: NAME_MAX, MODES: MODES, LEVELS: LEVELS, REASONS: REASONS,
    initProfiles: initProfiles, profileList: profileList, profile: profile, current: current, setCurrent: setCurrent,
    addProfile: addProfile, renameProfile: renameProfile, deleteProfile: deleteProfile, setRating: setRating,
    loadGames: loadGames, loadFor: loadFor, upsert: upsert, find: find, validGame: validGame, validLevel: validLevel,
    summary: summary, winRate: winRate, timeOf: timeOf, peak: peak,
    ACH: ACH, cleanAchievements: cleanAchievements, achDerive: achDerive, achFacts: achFacts, achFromFacts: achFromFacts, achSync: achSync, achList: achList
  };
})(typeof self !== 'undefined' ? self : this);
