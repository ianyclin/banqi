/*
 * 暗棋：積分與徽章（照五子棋 gomoku/rating.js 改的，不共用程式）。純函式，不碰 DOM、不碰 localStorage。
 * 瀏覽器下掛到 window.BanqiRating（Worker 下 self.BanqiRating），node 用 require('./rating.js')。
 *
 * 每個帳號每種玩法各一份積分（經典、連吃分開算：運氣成分與電腦各級的差距都不一樣）：
 *   帳號的 rating: { classic: { r, games, badge }, chain: { r, games, badge } }；沒有這一欄（舊帳號）＝還沒計分、起始 1000。
 * 只有跟電腦下的盤計分（兩人同機不算）；每盤只在第一次結束時算一次。紀錄多一欄 elo: { before, after, delta, opp }。
 *
 * Elo：期望得分 E = 1/(1+10^((Ro−Rp)/400))；賽後 Rp' = Rp + K×(S−E)，S 勝 1／和 0.5／負 0（認輸、放棄算負）。
 * K：這個帳號在這種玩法賽前已計分的盤數 < 10 時 40，之後 20。delta 四捨五入到整數，正負對稱（±0.5 都往遠離 0 的方向進位）。
 *
 * 電腦各級的積分固定（AI 表）：相鄰兩級的勝率 p（高的那一級贏的比例）換成差距 400·log10(p/(1−p))，以第 4 級＝1200 為錨，
 * 往上逐級加、往下逐級減，先累加再四捨五入。量到的相鄰兩級勝率：
 *   經典 classic：L3 對 L2 83.5%、L4 對 L3 75.5%、L5 對 L4 70.5%、L6 對 L5 74.2%、L7 對 L6 57.3%
 *   連吃 chain：  L3 對 L2 74.5%、L4 對 L3 68.8%、L5 對 L4 54.8%、L6 對 L5 68.3%、L7 對 L6 52.0%
 * （上面的百分比是四捨五入到 0.1% 的；拿它們重算會跟表差 1–2 分，表照定案的數字。）
 * 第 1 級是亂走的，跟第 2 級的差距量不出來（第 2 級幾乎全勝），L2−L1 定為 +400（上限）。
 */
(function (root, factory) {
  var R = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = R;
  else root.BanqiRating = R;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var START = 1000;           // 還沒計分的帳號（每種玩法各自）
  var PROVISIONAL_GAMES = 10; // 前 10 盤 K＝40
  var K_NEW = 40, K_NORMAL = 20;
  var DEMOTE_BUFFER = 50;     // 降級緩衝：要低於該徽章下限 50 分才降
  var MODES = ['classic', 'chain'];

  // 徽章：min 是下限（含）。木沒有下限
  var BADGES = [
    { key: 'wood', min: -Infinity, zh: '木', en: 'Wood' },
    { key: 'bronze', min: 900, zh: '銅', en: 'Bronze' },
    { key: 'silver', min: 1050, zh: '銀', en: 'Silver' },
    { key: 'gold', min: 1200, zh: '金', en: 'Gold' },
    { key: 'platinum', min: 1350, zh: '白金', en: 'Platinum' },
    { key: 'diamond', min: 1500, zh: '鑽石', en: 'Diamond' },
    { key: 'master', min: 1600, zh: '大師', en: 'Grandmaster' }
  ];

  // 電腦各級的積分（等級 id → 分數），經典與連吃各一張；來源見檔頭
  var AI = {
    classic: { 1: 323, 2: 723, 3: 1005, 4: 1200, 5: 1352, 6: 1536, 7: 1587 },
    chain: { 1: 478, 2: 878, 3: 1063, 4: 1200, 5: 1233, 6: 1367, 7: 1381 }
  };

  // 四捨五入到整數，正負對稱（-2.5 → -3，2.5 → 3）
  function roundSym(x) { return x < 0 ? -Math.round(-x) : Math.round(x); }

  // P 對 O 的期望得分（0–1）
  function expected(rp, ro) {
    return 1 / (1 + Math.pow(10, (ro - rp) / 400));
  }

  // 賽前已計分的盤數 → K
  function kFactor(games) {
    return (games || 0) < PROVISIONAL_GAMES ? K_NEW : K_NORMAL;
  }

  // 結算。score：勝 1／和 0.5／負 0；games：賽前已計分的盤數（決定 K）。
  // 回傳 { rating: 新積分（整數）, delta: 變動（整數）, expected: 賽前期望得分, k }
  function update(rp, ro, score, games) {
    var e = expected(rp, ro), k = kFactor(games);
    var delta = roundSym(k * (score - e));
    return { rating: Math.round(rp) + delta, delta: delta, expected: e, k: k };
  }

  function badgeIndex(key) {
    for (var i = 0; i < BADGES.length; i++) if (BADGES[i].key === key) return i;
    return -1;
  }

  // 積分所在區間的徽章（不管緩衝）→ 'wood'…'master'
  function badge(rating) {
    for (var i = BADGES.length - 1; i > 0; i--) if (rating >= BADGES[i].min) return BADGES[i].key;
    return BADGES[0].key;
  }

  // 有緩衝的徽章：升級立即；降級要低於「目前徽章的下限 − 50」才降，逐級看；最低降到 badge(rating)。
  // prevBadge 認不得（null、舊資料）時就回傳 badge(rating)
  function badgeAfter(prevBadge, rating) {
    var now = badge(rating), pi = badgeIndex(prevBadge), ni = badgeIndex(now);
    if (pi < 0 || ni >= pi) return now;
    for (var i = pi; i > ni; i--) if (rating >= BADGES[i].min - DEMOTE_BUFFER) return BADGES[i].key;
    return now;
  }

  // 電腦第 level 級在這種玩法的積分；不認得的玩法或等級（例如之後的版本加的第 8 級）＝null（那一盤不計分）
  function aiRating(mode, level) {
    var t = AI[mode];
    return t && Object.prototype.hasOwnProperty.call(t, level) ? t[level] : null;
  }

  // 帳號的 rating 欄裡某一種玩法的那一份；沒有或壞掉＝還沒計分（START、0 盤、START 的徽章）
  function entry(rating, mode) {
    var x = rating && typeof rating === 'object' ? rating[mode] : null;
    if (!x || typeof x !== 'object' || typeof x.r !== 'number' || !isFinite(x.r)) return { r: START, games: 0, badge: badge(START) };
    var g = typeof x.games === 'number' && x.games >= 0 && x.games % 1 === 0 ? x.games : 0;
    return { r: Math.round(x.r), games: g, badge: badgeIndex(x.badge) >= 0 ? x.badge : badge(x.r) };
  }

  function scoreOf(result) {
    return result === 'win' ? 1 : result === 'draw' ? 0.5 : result === 'loss' ? 0 : null;
  }

  // 一盤紀錄（stats.js 的欄位：opp、mode、level、result）照帳號這種玩法賽前的那一份（entry）結算。
  // 不計分（兩人同機、不認得的等級或玩法、結果不對）＝null。
  // 回傳 { elo: { before, after, delta, opp }（寫進紀錄）, entry: 新的那一份 { r, games, badge }（寫回帳號）, badgeBefore, k }
  function rateGame(ent, rec) {
    if (!rec || rec.opp !== 'ai') return null;
    var ro = aiRating(rec.mode, rec.level), s = scoreOf(rec.result);
    if (ro === null || s === null) return null;
    var e = ent || entry(null), u = update(e.r, ro, s, e.games);
    return {
      elo: { before: e.r, after: u.rating, delta: u.delta, opp: ro },
      entry: { r: u.rating, games: e.games + 1, badge: badgeAfter(e.badge, u.rating) },
      badgeBefore: e.badge, k: u.k
    };
  }

  // 幫我挑對手：這種玩法裡積分比玩家高 50–150 分的等級中，挑最接近 +100 的（一樣近挑高的）；
  // 沒有這種等級就挑比玩家高的裡面最接近的；玩家比每一級都高（或一樣）就挑最強的那一級。
  // levels：等級 id 的清單（省略＝AI 表裡這種玩法的全部）。回傳等級 id；玩法不認得或清單是空的＝null
  function recommendLevel(rating, mode, levels) {
    var t = AI[mode];
    if (!t) return null;
    levels = (levels || Object.keys(t).map(Number)).filter(function (lv) { return aiRating(mode, lv) !== null; });
    if (!levels.length) return null;
    var best = null, bestD = Infinity, i, d, lv;
    for (i = 0; i < levels.length; i++) {
      lv = levels[i]; d = t[lv] - rating;
      if (d >= 50 && d <= 150) {
        var off = Math.abs(d - 100);
        if (off < bestD || (off === bestD && t[lv] > t[best])) { best = lv; bestD = off; }
      }
    }
    if (best !== null) return best;
    for (i = 0; i < levels.length; i++) {
      lv = levels[i]; d = t[lv] - rating;
      if (d > 0 && d < bestD) { best = lv; bestD = d; }
    }
    if (best !== null) return best;
    for (i = 0; i < levels.length; i++) if (best === null || t[levels[i]] > t[best]) best = levels[i];
    return best;
  }

  return {
    START: START,
    MODES: MODES,
    BADGES: BADGES,
    AI: AI,
    DEMOTE_BUFFER: DEMOTE_BUFFER,
    PROVISIONAL_GAMES: PROVISIONAL_GAMES,
    roundSym: roundSym,
    expected: expected,
    kFactor: kFactor,
    update: update,
    badge: badge,
    badgeAfter: badgeAfter,
    aiRating: aiRating,
    entry: entry,
    scoreOf: scoreOf,
    rateGame: rateGame,
    recommendLevel: recommendLevel
  };
});
