/*
 * 暗棋：規則引擎（規格：docs/rules-spec.md，規則編號照那份文件）
 *   mode 'classic' 經典玩法（TCG 2019 規則＋中文維基台灣暗棋）
 *   mode 'chain'   連吃玩法（作者 2026-10-23 定）：同一子吃完可再吃、可攻擊暗子、炮可連跳
 * 純函式，不碰 DOM、不碰 localStorage。瀏覽器／Worker 下掛到 self.BanqiEngine，node 用 require('./engine.js')。
 *
 * 狀態分兩層（規則 14）：
 *   公開的部分＝ board（'?' 暗子、null 空格、字母明子）、輪誰、顏色、未翻子的多重集合 pool、被吃的子、棋譜、計數器；
 *   私密的部分＝ state.secret：{ layout 開局 32 格真實排法, hidden 每個暗格的真實身分 }。
 *   電腦（之後的 AI）只准拿 publicView(state)；要往下推演時用 sampleHidden(view, rng) 抽一個跟公開資訊一致的排法。
 *
 * 子的代號（規則 16，沿用 TCG 2007 棋譜格式）：K 帥／將、G 仕／士、M 相／象、R 俥／車、N 傌／馬、C 炮／包、P 兵／卒；
 * 大寫紅、小寫黑。格子：a–d 是欄（左到右），1–8 是列（下到上）；內部索引 i＝（列−1）×4＋欄，a1=0、d1=3、a2=4、d8=31。
 */
(function (root, factory) {
  var E = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = E;
  else root.BanqiEngine = E;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var COLS = 4, ROWS = 8, N = 32;
  var TYPES = ['K', 'G', 'M', 'R', 'N', 'C', 'P'];
  // 子力（規則 4）：帥>仕>相>俥>傌>炮>兵
  var RANK = { K: 6, G: 5, M: 4, R: 3, N: 2, C: 1, P: 0 };
  // 每方的子數（規則 1）
  var COUNT = { K: 1, G: 2, M: 2, R: 2, N: 2, C: 2, P: 5 };
  var ALL_PIECES = [];
  TYPES.forEach(function (t) {
    for (var k = 0; k < COUNT[t]; k++) { ALL_PIECES.push(t); ALL_PIECES.push(t.toLowerCase()); }
  });
  var PIECE_CODES = TYPES.concat(TYPES.map(function (t) { return t.toLowerCase(); }));
  var NAMES = {
    K: '帥', G: '仕', M: '相', R: '俥', N: '傌', C: '炮', P: '兵',
    k: '將', g: '士', m: '象', r: '車', n: '馬', c: '包', p: '卒'
  };
  var DRAW_PLIES = [30, 40, 50, 60];
  var DEFAULT_DRAW_PLIES = 60;
  var REPETITION_LIMIT = 3;
  var HIDDEN = '?';
  var MODES = ['classic', 'chain'];

  // 每格四個方向的鄰格（不跨邊；d1 的右邊不是 a2）
  var DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]]; // [dc, dr]
  var NEIGHBORS = [];
  // RAYS[i][d]＝從 i 沿方向 d 一路到邊的格子（炮跳吃用）
  var RAYS = [];
  for (var i0 = 0; i0 < N; i0++) {
    var c0 = i0 % COLS, r0 = (i0 - c0) / COLS, nb = [], rays = [];
    for (var d = 0; d < 4; d++) {
      var ray = [], c = c0 + DIRS[d][0], r = r0 + DIRS[d][1];
      while (c >= 0 && c < COLS && r >= 0 && r < ROWS) { ray.push(r * COLS + c); c += DIRS[d][0]; r += DIRS[d][1]; }
      if (ray.length) nb.push(ray[0]);
      rays.push(ray);
    }
    NEIGHBORS.push(nb);
    RAYS.push(rays);
  }

  // ------------------------------------------------------------ 小工具

  function colorOf(p) { return p === p.toUpperCase() ? 'r' : 'b'; }
  function typeOf(p) { return p.toUpperCase(); }
  function isPiece(x) { return typeof x === 'string' && x.length === 1 && RANK[x.toUpperCase()] !== undefined; }
  function otherColor(c) { return c === 'r' ? 'b' : 'r'; }

  function squareName(i) { return 'abcd'.charAt(i % COLS) + String(Math.floor(i / COLS) + 1); }
  function parseSquare(s) {
    var m = /^([a-d])([1-8])$/.exec(s);
    if (!m) throw new Error('格子名稱不對：' + s);
    return (Number(m[2]) - 1) * COLS + 'abcd'.indexOf(m[1]);
  }

  // 走步吃子（規則 4）：a 吃 t 嗎？只看子力，不看顏色。炮不能走步吃任何子；帥不吃兵、兵可吃帥。
  function canStepCapture(a, t) {
    var A = typeOf(a), T = typeOf(t);
    if (A === 'C') return false;
    if (A === 'K' && T === 'P') return false;
    if (A === 'P' && T === 'K') return true;
    return RANK[A] >= RANK[T];
  }

  // ------------------------------------------------------------ 亂數（規則 15）
  // rng 介面：呼叫一次回傳一個 0 … 2^32−1 的整數。

  // 測試用的可重現亂數：種子先用 fmix32（MurmurHash3 的收尾混合，public domain）打散一次、0 換成固定常數，
  // 之後用 xorshift32（Marsaglia 2003 的演算法）。兩段都是照演算法自己寫的程式。
  function makeRng(seed) {
    var x = (Number(seed) >>> 0) ^ 0x9e3779b9;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    if (x === 0) x = 0x6d2b79f5;
    return function () {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      return x;
    };
  }

  // 正式用：crypto.getRandomValues（瀏覽器、Worker、Node 20+ 都有 globalThis.crypto）；
  // Node 沒有 globalThis.crypto 時改用 require('node:crypto').webcrypto；都沒有才退回 Math.random（只拿 32 位元）
  function findCrypto() {
    var cr = (typeof globalThis !== 'undefined' && globalThis.crypto) || (root && root.crypto) || null;
    if (cr && typeof cr.getRandomValues === 'function') return cr;
    if (typeof require === 'function') {
      try {
        var wc = require('node:crypto').webcrypto;
        if (wc && typeof wc.getRandomValues === 'function') return wc;
      } catch (e) { /* 不是 Node */ }
    }
    return null;
  }

  function defaultRng() {
    var cr = findCrypto();
    if (cr && typeof cr.getRandomValues === 'function') {
      var buf = new Uint32Array(64), pos = 64;
      return function () {
        if (pos >= 64) { cr.getRandomValues(buf); pos = 0; }
        return buf[pos++];
      };
    }
    return function () { return Math.floor(Math.random() * 4294967296) >>> 0; };
  }

  // 0 … n−1 均勻整數：拒絕取樣，沒有偏差
  function randInt(rng, n) {
    var limit = 4294967296 - (4294967296 % n);
    for (;;) {
      var u = rng() >>> 0;
      if (u < limit) return u % n;
    }
  }

  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = randInt(rng, i + 1), t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // ------------------------------------------------------------ 開新局

  function fullPool() {
    var pool = {};
    PIECE_CODES.forEach(function (p) { pool[p] = COUNT[typeOf(p)]; });
    return pool;
  }

  function checkOptions(opts) {
    var mode = opts.mode || 'classic';
    if (MODES.indexOf(mode) < 0) throw new Error('mode 只能是 classic 或 chain：' + mode);
    var drawPlies = opts.drawPlies === undefined ? DEFAULT_DRAW_PLIES : opts.drawPlies;
    if (DRAW_PLIES.indexOf(drawPlies) < 0) throw new Error('drawPlies 只能是 30、40、50、60：' + drawPlies);
    return { mode: mode, drawPlies: drawPlies };
  }

  function checkLayout(layout) {
    var arr = typeof layout === 'string' ? layout.split('') : layout;
    if (!arr || arr.length !== N) throw new Error('開局排法要剛好 32 格');
    var cnt = {};
    arr.forEach(function (p) {
      if (!isPiece(p)) throw new Error('開局排法有不認得的子：' + p);
      cnt[p] = (cnt[p] || 0) + 1;
    });
    PIECE_CODES.forEach(function (p) {
      if ((cnt[p] || 0) !== COUNT[typeOf(p)]) throw new Error('開局排法的子數不對：' + p);
    });
    return arr.slice();
  }

  // opts：{ mode, drawPlies, rng, layout }。layout（32 字的字串或陣列，a1 b1 c1 d1 a2 … d8）只給重播與測試用。
  function newGame(opts) {
    opts = opts || {};
    var o = checkOptions(opts);
    var layout = opts.layout ? checkLayout(opts.layout) : shuffle(ALL_PIECES.slice(), opts.rng || defaultRng());
    var board = [];
    for (var i = 0; i < N; i++) board.push(HIDDEN);
    var s = {
      mode: o.mode,
      drawPlies: o.drawPlies,
      board: board,
      turn: 0,
      colors: [null, null],
      pool: fullPool(),
      captured: [],
      history: [],
      quietPlies: 0,
      seen: [],
      chain: null,
      ply: 0,
      result: null,
      secret: { layout: layout.join(''), hidden: layout.slice() }
    };
    s.seen.push(positionKey(s));
    return s;
  }

  // 測試與題目用：直接擺一個局面。cells：{ a1: 'K', b2: '?p', … }；'?x' 是真實身分為 x 的暗子，沒寫的格子是空的。
  // 不在盤上的子一律當作已被吃（照 ALL_PIECES 順序），所以子數守恆。
  // opts：{ mode, drawPlies, turn 0|1, colors ['r','b']（有明子或少於 32 個暗子時不能是 null）, quietPlies, ply }
  function fromBoard(cells, opts) {
    opts = opts || {};
    var o = checkOptions(opts);
    var board = [], hidden = [], left = fullPool(), i;
    for (i = 0; i < N; i++) { board.push(null); hidden.push(null); }
    Object.keys(cells).forEach(function (name) {
      var sq = parseSquare(name), v = cells[name];
      var p = v.charAt(0) === HIDDEN ? v.slice(1) : v;
      if (!isPiece(p) || (v.charAt(0) === HIDDEN ? v.length !== 2 : v.length !== 1)) throw new Error('格子內容不對：' + name + '=' + v);
      if (!(left[p] > 0)) throw new Error('子數超過：' + p);
      left[p]--;
      if (v.charAt(0) === HIDDEN) { board[sq] = HIDDEN; hidden[sq] = p; } else board[sq] = p;
    });
    var captured = [];
    ALL_PIECES.forEach(function (p) { if (left[p] > 0) { left[p]--; captured.push(p); } });
    var pool = {};
    PIECE_CODES.forEach(function (p) { pool[p] = 0; });
    hidden.forEach(function (p) { if (p) pool[p]++; });
    var colors = opts.colors === undefined ? ['r', 'b'] : opts.colors;
    var allHidden = board.every(function (x) { return x === HIDDEN; });
    var turn = opts.turn === undefined ? 0 : opts.turn;
    if (turn !== 0 && turn !== 1) throw new Error('turn 只能是 0 或 1：' + turn);
    var side = { r: 0, b: 0 };
    board.forEach(function (x, i) { var p = x === HIDDEN ? hidden[i] : x; if (p) side[colorOf(p)]++; });
    if (side.r > 16 || side.b > 16) throw new Error('一方超過 16 子');
    if (colors === null || colors[0] === null) {
      if (!allHidden) throw new Error('顏色未定只可能出現在 32 子全是暗子的開局（規則 13）');
      if (turn !== 0) throw new Error('顏色未定時一定是先手（turn 0）要走');
      colors = [null, null];
    } else {
      if (!((colors[0] === 'r' && colors[1] === 'b') || (colors[0] === 'b' && colors[1] === 'r'))) throw new Error('colors 要是 [r,b] 或 [b,r]');
      colors = colors.slice();
    }
    var s = {
      mode: o.mode,
      drawPlies: o.drawPlies,
      board: board,
      turn: turn,
      colors: colors,
      pool: pool,
      captured: captured,
      history: [],
      quietPlies: opts.quietPlies || 0,
      seen: [],
      chain: null,
      ply: opts.ply || 0,
      result: null,
      secret: { layout: null, hidden: hidden }
    };
    s.seen.push(positionKey(s));
    s.result = computeResult(s);
    return s;
  }

  // ------------------------------------------------------------ 盤面鍵（規則 8）
  // 32 格的公開內容（'?' 暗子、'.' 空格、字母明子）＋輪到哪一位。暗子的真實身分不用放：見規格 8.3。
  function positionKey(s) {
    var out = '';
    for (var i = 0; i < N; i++) { var x = s.board[i]; out += x === null ? '.' : x; }
    return out + s.turn;
  }

  // ------------------------------------------------------------ 合法步（規則 3、4、5、10、11）

  function ownColor(s) { return s.colors[s.turn]; }

  // 從 sq 這個己方明子出發的吃子／攻擊暗子（不含走到空格）。push(move)
  function captureMovesFrom(s, sq, col, push) {
    var b = s.board, a = b[sq], chain = s.mode === 'chain', k, t, to;
    if (typeOf(a) === 'C') {
      // 炮：沿直線越過剛好一個子（炮台，任何子都可以）吃後面第一個子（規則 5、10、11）
      for (k = 0; k < 4; k++) {
        var ray = RAYS[sq][k], j = 0;
        while (j < ray.length && b[ray[j]] === null) j++;          // 找炮台
        j++;
        while (j < ray.length && b[ray[j]] === null) j++;          // 炮台後面第一個子
        if (j >= ray.length) continue;
        to = ray[j]; t = b[to];
        if (t === HIDDEN) { if (chain) push({ type: 'attack', from: sq, to: to }); }
        else if (colorOf(t) !== col) push({ type: 'capture', from: sq, to: to });
      }
      return;
    }
    var nb = NEIGHBORS[sq];
    for (k = 0; k < nb.length; k++) {
      to = nb[k]; t = b[to];
      if (t === null) continue;
      if (t === HIDDEN) { if (chain) push({ type: 'attack', from: sq, to: to }); }
      else if (colorOf(t) !== col && canStepCapture(a, t)) push({ type: 'capture', from: sq, to: to });
    }
  }

  // 只讀公開欄位（board、turn、colors、mode、chain、result），所以 publicView 也能直接用
  function legalMoves(s) {
    var out = [];
    if (s.result) return out;
    function push(m) { out.push(m); }
    var col = ownColor(s), b = s.board, i, k;
    if (s.chain) {
      // 連吃中（規則 9、11）：只能用同一子繼續吃／攻擊暗子，或停
      captureMovesFrom(s, s.chain.sq, col, push);
      out.push({ type: 'stop' });
      return out;
    }
    for (i = 0; i < N; i++) if (b[i] === HIDDEN) out.push({ type: 'flip', sq: i });
    if (col === null) return out; // 第一手：還沒有顏色，只能翻（規則 2、13）
    for (i = 0; i < N; i++) {
      var p = b[i];
      if (p === null || p === HIDDEN || colorOf(p) !== col) continue;
      var nb = NEIGHBORS[i];
      for (k = 0; k < nb.length; k++) if (b[nb[k]] === null) out.push({ type: 'move', from: i, to: nb[k] });
      captureMovesFrom(s, i, col, push);
    }
    return out;
  }

  function sameMove(a, m) {
    if (!m || a.type !== m.type) return false;
    if (a.type === 'flip') return a.sq === m.sq;
    if (a.type === 'stop') return true;
    return a.from === m.from && a.to === m.to;
  }

  function isLegal(s, m) {
    var list = legalMoves(s);
    for (var i = 0; i < list.length; i++) if (sameMove(list[i], m)) return true;
    return false;
  }

  // ------------------------------------------------------------ 勝負與和棋（規則 6、7、8）

  function piecesLeft(s, col) {
    var n = 16;
    for (var i = 0; i < s.captured.length; i++) if (colorOf(s.captured[i]) === col) n--;
    return n;
  }

  // 輪到的人有沒有任何合法步（不產生整張清單）
  function hasAnyMove(s) {
    var b = s.board, col = ownColor(s), i;
    for (i = 0; i < N; i++) if (b[i] === HIDDEN) return true;  // 有暗子就能翻
    if (col === null) return false;
    var found = false;
    function push() { found = true; }
    for (i = 0; i < N && !found; i++) {
      var p = b[i];
      if (p === null || p === HIDDEN || colorOf(p) !== col) continue;
      var nb = NEIGHBORS[i];
      for (var k = 0; k < nb.length; k++) if (b[nb[k]] === null) return true;
      captureMovesFrom(s, i, col, push);
    }
    return found;
  }

  function countSeen(s, key) {
    var n = 0;
    for (var i = 0; i < s.seen.length; i++) if (s.seen[i] === key) n++;
    return n;
  }

  // 一手走完、換人之後判定。先看輪到的人輸了沒（6），再看和棋（7、8）。見規格 6.4。
  // 對局中剛走完的一方不可能沒子；fromBoard 擺出「沒輪到的一方已經沒子」時也要判（他輸）。
  function computeResult(s) {
    if (s.chain) return null;
    var mover = s.turn, col = ownColor(s);
    if (col !== null) {
      if (piecesLeft(s, col) === 0) return makeResult(1 - mover, s, 'noPieces');
      if (piecesLeft(s, otherColor(col)) === 0) return makeResult(mover, s, 'noPieces');
      if (!hasAnyMove(s)) return makeResult(1 - mover, s, 'noMoves');
    }
    if (s.quietPlies >= s.drawPlies) return makeResult(null, s, 'drawPlies');
    if (countSeen(s, positionKey(s)) >= REPETITION_LIMIT) return makeResult(null, s, 'repetition');
    return null;
  }

  function makeResult(winner, s, reason) {
    return { winner: winner, winnerColor: winner === null ? null : s.colors[winner], reason: reason };
  }

  function result(s) {
    if (s.result) return s.result;
    return computeResult(s);
  }

  // ------------------------------------------------------------ 走一步

  function cloneState(s) {
    var pool = {};
    for (var k in s.pool) pool[k] = s.pool[k];
    return {
      mode: s.mode,
      drawPlies: s.drawPlies,
      board: s.board.slice(),
      turn: s.turn,
      colors: s.colors.slice(),
      pool: pool,
      captured: s.captured.slice(),
      history: s.history.slice(),
      quietPlies: s.quietPlies,
      seen: s.seen.slice(),
      chain: s.chain ? { sq: s.chain.sq, n: s.chain.n } : null,
      ply: s.ply,
      result: s.result,
      secret: s.secret ? { layout: s.secret.layout, hidden: s.secret.hidden.slice() } : null
    };
  }

  // 暗子翻成明子（翻子與攻擊暗子共用）
  function reveal(s, sq) {
    var p = s.secret.hidden[sq];
    if (!p) throw new Error('內部錯誤：' + squareName(sq) + ' 沒有暗子');
    s.secret.hidden[sq] = null;
    s.board[sq] = p;
    s.pool[p]--;
    return p;
  }

  // 一手結束：記棋譜、換人、更新計數器、判勝負
  function endMove(s, irreversible, notation, events) {
    s.history.push({ p: s.turn, n: notation });
    s.chain = null;
    s.ply++;
    s.quietPlies = irreversible ? 0 : s.quietPlies + 1;
    s.turn = 1 - s.turn;
    if (irreversible) s.seen = []; // 翻子、吃子以後，之前的盤面都不可能再出現（規格 8.4）
    s.seen.push(positionKey(s));
    s.result = computeResult(s);
    events.push({ type: 'turn', player: s.turn });
    if (s.result) events.push({ type: 'gameOver', result: s.result });
  }

  // 連吃玩法：吃完一子以後（規則 9、11）
  function afterCapture(s, sq, notation, events) {
    if (s.mode !== 'chain') { endMove(s, true, notation, events); return; }
    s.chain = { sq: sq, n: notation };
    var any = false;
    // 規則 11.5：對方已經沒有子了（盤上剩下的暗子全是自己的），這一手立刻結束、交給判勝負
    if (piecesLeft(s, otherColor(ownColor(s))) > 0) captureMovesFrom(s, sq, ownColor(s), function () { any = true; });
    if (!any) {
      events.push({ type: 'chainEnd', reason: 'noTargets' });
      endMove(s, true, notation, events);
    } else events.push({ type: 'chainOpen', sq: sq });
  }

  // 回傳 { state, events }。不合法的步（含 pass、拿 publicView 來走）一律丟錯。
  function applyMove(s, move) {
    if (!s.secret) throw new Error('這是公開狀態，沒有暗子的真實身分；要推演請先用 sampleHidden');
    if (s.result) throw new Error('棋局已結束');
    if (!isLegal(s, move)) throw new Error('不合法的步：' + JSON.stringify(move));
    var t = cloneState(s), events = [], b = t.board, a, x, prefix;
    switch (move.type) {
      case 'flip': {
        x = reveal(t, move.sq);
        events.push({ type: 'flip', sq: move.sq, piece: x });
        if (t.colors[0] === null) {
          // 規則 2：先手第一翻的顏色就是他的
          t.colors = t.turn === 0 ? [colorOf(x), otherColor(colorOf(x))] : [otherColor(colorOf(x)), colorOf(x)];
          events.push({ type: 'colors', colors: t.colors.slice() });
        }
        endMove(t, true, squareName(move.sq) + '(' + x + ')', events);
        break;
      }
      case 'move': {
        a = b[move.from]; b[move.to] = a; b[move.from] = null;
        events.push({ type: 'move', from: move.from, to: move.to, piece: a });
        endMove(t, false, squareName(move.from) + '-' + squareName(move.to), events);
        break;
      }
      case 'capture': {
        a = b[move.from]; x = b[move.to];
        b[move.to] = a; b[move.from] = null; t.captured.push(x);
        events.push({ type: 'capture', from: move.from, to: move.to, piece: a, captured: x, jump: typeOf(a) === 'C' });
        prefix = t.chain ? t.chain.n : squareName(move.from);
        afterCapture(t, move.to, prefix + '-' + squareName(move.to), events);
        break;
      }
      case 'attack': {
        // 規則 10：先翻開，再看能不能吃
        a = b[move.from];
        x = reveal(t, move.to);
        var ok = colorOf(x) !== colorOf(a) && (typeOf(a) === 'C' || canStepCapture(a, x));
        prefix = t.chain ? t.chain.n : squareName(move.from);
        events.push({ type: 'attack', from: move.from, to: move.to, piece: a, revealed: x, success: ok, jump: typeOf(a) === 'C' });
        if (ok) {
          b[move.to] = a; b[move.from] = null; t.captured.push(x);
          afterCapture(t, move.to, prefix + '-' + squareName(move.to) + '(' + x + ')', events);
        } else {
          events.push({ type: 'chainEnd', reason: 'failed' });
          endMove(t, true, prefix + '~' + squareName(move.to) + '(' + x + ')', events);
        }
        break;
      }
      case 'stop': {
        events.push({ type: 'chainEnd', reason: 'stop' });
        endMove(t, true, t.chain.n, events);
        break;
      }
      default:
        throw new Error('不認得的步：' + JSON.stringify(move));
    }
    return { state: t, events: events };
  }

  // 認輸（規則 16.2）：player（0＝先手、1＝後手）認輸，對方勝。不必輪到他；連吃中途也可以（chain 原樣留著，棋譜照樣帶 +）。
  // 回傳 { state, events }，同 applyMove。之後 result 有值、legalMoves 是空的。公開狀態也能認輸（不需要暗子）。
  function applyResign(s, player) {
    if (s.result) throw new Error('棋局已結束');
    if (player !== 0 && player !== 1) throw new Error('認輸的人只能是 0（先手）或 1（後手）：' + JSON.stringify(player));
    var t = cloneState(s);
    t.result = makeResult(1 - player, t, 'resign');
    return { state: t, events: [{ type: 'gameOver', result: t.result }] };
  }

  // ------------------------------------------------------------ 公開資訊（規則 14）

  var PUBLIC_KEYS = ['mode', 'drawPlies', 'board', 'turn', 'colors', 'pool', 'captured', 'history',
    'quietPlies', 'seen', 'chain', 'ply', 'result'];

  // AI 唯一能看的東西：全是新的物件，沒有 secret
  function publicView(s) {
    var v = JSON.parse(JSON.stringify({
      mode: s.mode, drawPlies: s.drawPlies, board: s.board, turn: s.turn, colors: s.colors, pool: s.pool,
      captured: s.captured, history: s.history, quietPlies: s.quietPlies, seen: s.seen, chain: s.chain,
      ply: s.ply, result: s.result
    }));
    return v;
  }

  // 抽一個跟公開資訊一致的暗子排法（給 AI 做 determinization）。只讀 view 的公開欄位，跟真實排法無關。
  // 暗子從開局起就沒動過、翻開的位置和誰翻的都和身分無關，所以「剩下的子均勻排到暗格」正是事後的條件分布（規格 14.3）。
  function sampleHidden(view, rng) {
    rng = rng || defaultRng();
    var bag = [];
    PIECE_CODES.forEach(function (p) { for (var k = 0; k < (view.pool[p] || 0); k++) bag.push(p); });
    var squares = [];
    for (var i = 0; i < N; i++) if (view.board[i] === HIDDEN) squares.push(i);
    if (bag.length !== squares.length) throw new Error('公開資訊不一致：暗格 ' + squares.length + ' 個、未翻的子 ' + bag.length + ' 個');
    shuffle(bag, rng);
    var s = cloneState(publicView(view));
    var hidden = [];
    for (i = 0; i < N; i++) hidden.push(null);
    squares.forEach(function (sq, k) { hidden[sq] = bag[k]; });
    s.secret = { layout: null, hidden: hidden };
    return s;
  }

  // ------------------------------------------------------------ 棋譜（規則 16）
  // [Banqi "1"] [Mode "classic"] [DrawPlies "60"] [Layout "<32 字>"]，接著一回合一行（TCG 2007 的樣子），最後 [Result …]。
  // 一手的寫法：b3(n) 翻子；a4-a5 走或吃；a1-a4 炮跳吃；連吃 a2-a3-b3；攻擊暗子成功 a4-a5(n)、失敗 a4~a5(K)；
  // 連吃還沒結束（存檔時）在最後加 +。

  var RESULT_TEXT = { 0: 'first', 1: 'second' };

  function encodeRecord(s) {
    if (!s.secret || !s.secret.layout) throw new Error('沒有開局排法（擺出來的局面或抽樣出來的狀態不能存棋譜）');
    var lines = ['[Banqi "1"]', '[Mode "' + s.mode + '"]', '[DrawPlies "' + s.drawPlies + '"]', '[Layout "' + s.secret.layout + '"]'];
    var toks = s.history.map(function (h) { return h.n; });
    if (s.chain) toks.push(s.chain.n + '+');
    for (var i = 0; i < toks.length; i += 2) {
      lines.push(String(i / 2 + 1) + '. ' + toks[i] + (i + 1 < toks.length ? ' ' + toks[i + 1] : ''));
    }
    if (s.result) lines.push('[Result "' + (s.result.winner === null ? 'draw' : RESULT_TEXT[s.result.winner]) + '" "' + s.result.reason + '"]');
    return lines.join('\n') + '\n';
  }

  var HOP_RE = /^([-~])([a-d][1-8])(?:\(([KGMRNCPkgmrncp])\))?/;

  // 一手的文字 → 依序套用。回傳新狀態。
  function applyNotation(s, tok, isLast) {
    var m = /^([a-d][1-8])\(([KGMRNCPkgmrncp])\)$/.exec(tok);
    if (m) {
      var r = applyMove(s, { type: 'flip', sq: parseSquare(m[1]) });
      if (r.events[0].piece !== m[2]) throw new Error('棋譜和開局排法不符：' + tok);
      return r.state;
    }
    var open = false;
    if (tok.charAt(tok.length - 1) === '+') {
      if (!isLast) throw new Error('只有最後一手能是未完成的連吃：' + tok);
      open = true; tok = tok.slice(0, -1);
    }
    var head = /^([a-d][1-8])/.exec(tok);
    if (!head) throw new Error('看不懂的一手：' + tok);
    var from = parseSquare(head[1]), rest = tok.slice(2), mover = s.turn, hops = 0;
    while (rest.length) {
      var h = HOP_RE.exec(rest);
      if (!h) throw new Error('看不懂的一手：' + tok);
      rest = rest.slice(h[0].length);
      var to = parseSquare(h[2]), target = s.board[to], type;
      if (target === HIDDEN) type = 'attack';
      else if (target === null) type = 'move';
      else type = 'capture';
      if ((type === 'attack') !== (h[3] !== undefined)) throw new Error('棋譜的翻開標記和盤面不符：' + tok);
      if (type !== 'attack' && h[1] === '~') throw new Error('~ 只用在攻擊暗子失敗：' + tok);
      if (type === 'move' && (hops > 0 || rest.length)) throw new Error('走到空格只能單獨一步：' + tok);
      var res = applyMove(s, { type: type, from: from, to: to });
      if (type === 'attack') {
        var ev = res.events[0];
        if (ev.revealed !== h[3]) throw new Error('棋譜和開局排法不符：' + tok);
        if (ev.success !== (h[1] === '-')) throw new Error('攻擊暗子的成敗和棋譜不符：' + tok);
      }
      s = res.state; from = to; hops++;
      if (rest.length && (s.turn !== mover || !s.chain)) throw new Error('連吃已經結束，後面還有：' + tok);
    }
    if (s.chain && s.turn === mover) {
      if (!open) s = applyMove(s, { type: 'stop' }).state;
    } else if (open) throw new Error('標了 + 但連吃已經結束：' + tok);
    return s;
  }

  function decodeRecord(text) {
    var tags = {}, toks = [];
    String(text).split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line) return;
      var t = /^\[(\w+)((?:\s+"[^"]*")+)\]$/.exec(line);
      if (t) {
        tags[t[1]] = (t[2].match(/"[^"]*"/g) || []).map(function (q) { return q.slice(1, -1); });
        return;
      }
      line.split(/\s+/).forEach(function (w) { if (!/^\d+\.$/.test(w)) toks.push(w); });
    });
    if (!tags.Banqi || tags.Banqi[0] !== '1') throw new Error('不是暗棋棋譜（缺 [Banqi "1"]）');
    if (!tags.Layout) throw new Error('棋譜缺開局排法');
    var s = newGame({ mode: tags.Mode ? tags.Mode[0] : 'classic', drawPlies: tags.DrawPlies ? Number(tags.DrawPlies[0]) : DEFAULT_DRAW_PLIES, layout: tags.Layout[0] });
    toks.forEach(function (tok, k) { s = applyNotation(s, tok, k === toks.length - 1); });
    if (tags.Result && tags.Result[1] === 'resign') {
      // 認輸不是重播判得出來的結果：只有重播完還沒結果時才收，第一個值是勝方（同其他原因），輸的是另一方（規格 16.2）
      var w = tags.Result[0] === 'first' ? 0 : tags.Result[0] === 'second' ? 1 : null;
      if (s.result || w === null) throw new Error('棋譜的結果和重播不符');
      s.result = makeResult(w, s, 'resign');
    } else if (tags.Result) {
      var want = tags.Result[0], got = s.result ? (s.result.winner === null ? 'draw' : RESULT_TEXT[s.result.winner]) : null;
      if (want !== got || (tags.Result[1] && tags.Result[1] !== s.result.reason)) throw new Error('棋譜的結果和重播不符');
    }
    return s;
  }

  return {
    COLS: COLS, ROWS: ROWS, N: N, TYPES: TYPES, RANK: RANK, COUNT: COUNT, ALL_PIECES: ALL_PIECES.slice(),
    PIECE_CODES: PIECE_CODES, NAMES: NAMES, DRAW_PLIES: DRAW_PLIES, DEFAULT_DRAW_PLIES: DEFAULT_DRAW_PLIES,
    REPETITION_LIMIT: REPETITION_LIMIT, HIDDEN: HIDDEN, MODES: MODES, PUBLIC_KEYS: PUBLIC_KEYS,
    NEIGHBORS: NEIGHBORS,
    colorOf: colorOf, typeOf: typeOf, squareName: squareName, parseSquare: parseSquare,
    canStepCapture: canStepCapture,
    makeRng: makeRng, defaultRng: defaultRng, randInt: randInt, shuffle: shuffle,
    newGame: newGame, fromBoard: fromBoard, positionKey: positionKey,
    legalMoves: legalMoves, isLegal: isLegal, applyMove: applyMove, applyResign: applyResign, result: result,
    publicView: publicView, sampleHidden: sampleHidden,
    encodeRecord: encodeRecord, decodeRecord: decodeRecord
  };
});
