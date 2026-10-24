/*
 * 暗棋：電腦對手（設計見 README「電腦對手」一節；規則照 docs/rules-spec.md，規則引擎 engine.js 是權威）
 *
 * 只看公開資訊：think／choose 只讀 publicView 的公開欄位（board、pool、captured、colors、turn、chain、
 * quietPlies、drawPlies、seen、mode、result）。傳進完整狀態也一樣只讀這些欄位；暗子的真實身分這個檔案碰不到。
 *
 * 搜尋：Expectiminimax。決策節點用 αβ（negamax、fail-soft）；機會節點（翻子；連吃玩法的攻擊暗子）用 Star1
 * （Ballard 1983；照 Hsu 的 TCG 講義的寫法：每個結果的視窗 (A, B)、上下界 m／M），結果是袋子裡每一種子、權重是個數。
 * 連吃的接著吃是普通的決策節點（同一方再走）；每一下扣一層，stop 是一步但不扣（收手）。
 * 迭代加深，預算用「節點數」（每走一步＝一個節點），所以強度跟機器快慢無關；另有牆鐘時間上限只當保險。
 * 置換表的鍵：公開盤面＋未翻子袋＋輪到哪一色＋連吃中的那一格（子樹碰得到不吃不翻上限的影響時再加計數）。重複盤面、不吃不翻計數照引擎判。
 *
 * 評估（全部在參數表與功能開關後面，可以調、可以拿掉）：
 *   天敵數子力：子的價值＝top × ratio^n，n＝還活著（含未翻開）、能走步吃它的敵方子數＋cannonPred × 敵方活著的炮數
 *   （炮能跳吃任何子，算「部分天敵」）。炮自己也照這樣算（天敵＝帥仕相俥傌＋部分的炮；兵吃不了炮），用自己的 top／ratio。
 *   沒有暗子時看「吃不掉的子」：一方有一個子是對方剩下的子都吃不了的，他就不會被吃光——另一方最多和棋（評估壓在和棋值以下但仍照子力分高低，見 drawSquash）。
 *   位置項：機動性、被困、炮線、帥（將）的安全、翻子風險；沒有靜態搜尋的等級另加「吊著的子」（輪到的人最好的一吃）。
 *   帥被追（genDanger）：敵兵離帥多近、是不是沿著空線過來，乘上帥被困的程度（安全退路少、在角落或邊上；旁邊的暗子算半條退路）。
 *   和棋：領先時和棋算負分（contempt）；沒有暗子時領先看的是「誰有吃不掉的子」，不是子力差。
 *   接近不吃不翻上限時把評估往和棋值拉（逼領先的一方去吃、去翻）。
 *
 * 純 ES5（同 engine.js），UMD：瀏覽器／Worker 下先載 engine.js 再載這個檔，掛到 self.BanqiAI；node 用 require('./ai.js')。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module && module.exports;
  var E = isNode ? require('./engine.js') : root.BanqiEngine;
  var A = factory(E);
  if (isNode) module.exports = A;
  else root.BanqiAI = A;
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  // ------------------------------------------------------------ 常數與表

  var N = 32, HID = 15;
  var K_FLIP = 5, K_MOVE = 1, K_CAPTURE = 2, K_ATTACK = 3, K_STOP = 4; // 步的編碼：種類 | 起點<<3 | 終點<<8；0 不是任何一步
  var T_K = 0, T_G = 1, T_M = 2, T_R = 3, T_N = 4, T_C = 5, T_P = 6;
  var R_NONE = 0, R_LOSS = 1, R_WIN = 2, R_DRAW = 3; // 對「輪到的人」而言
  var WIN = 100000, VMIN = -WIN, VMAX = WIN, EVAL_CAP = 60000, MATE_ZONE = WIN - 1000;
  var INF = Infinity;
  var MAXPLY = 160, MAXM = 160;

  // 子的內部代號：0 空、1–7 紅 K G M R N C P、8–14 黑、15 暗子
  var COL = new Int8Array(16), TYP = new Int8Array(16), CODE_OF = {}, COUNT_OF = new Int8Array(16);
  COL[0] = COL[HID] = -1; TYP[0] = TYP[HID] = -1;
  E.TYPES.forEach(function (t, i) {
    CODE_OF[t] = 1 + i; CODE_OF[t.toLowerCase()] = 8 + i;
    COL[1 + i] = 0; COL[8 + i] = 1; TYP[1 + i] = i; TYP[8 + i] = i;
    COUNT_OF[1 + i] = COUNT_OF[8 + i] = E.COUNT[t];
  });
  // CAN[a*7+t]：a 型的子能不能走步吃 t 型的子（照引擎的 canStepCapture，不看顏色）
  var CAN = new Int8Array(49);
  for (var ia = 0; ia < 7; ia++) for (var it = 0; it < 7; it++) CAN[ia * 7 + it] = E.canStepCapture(E.TYPES[ia], E.TYPES[it]) ? 1 : 0;
  // PRED[t]：能走步吃 t 的子型（炮不能走步吃，自然不在裡面）＝「天敵」；炮另外以 cannonPred 的權重算成每一種子的部分天敵
  var PRED = [];
  for (it = 0; it < 7; it++) { var pl = []; for (ia = 0; ia < 7; ia++) if (CAN[ia * 7 + it]) pl.push(ia); PRED.push(pl); }

  // 鄰格與射線（跟引擎同一套幾何：a1=0、d1=3、a2=4；不跨邊）
  var NBS = new Int8Array(N * 4), NBC = new Int8Array(N);
  var RAYBUF = [], RAYS = new Int16Array(N * 4), RAYL = new Int8Array(N * 4);
  (function () {
    var DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]];
    for (var i = 0; i < N; i++) {
      var c0 = i % 4, r0 = (i - c0) / 4;
      var nb = E.NEIGHBORS[i];
      NBC[i] = nb.length;
      for (var k = 0; k < nb.length; k++) NBS[i * 4 + k] = nb[k];
      for (var d = 0; d < 4; d++) {
        RAYS[i * 4 + d] = RAYBUF.length;
        var c = c0 + DIRS[d][0], r = r0 + DIRS[d][1], len = 0;
        while (c >= 0 && c < 4 && r >= 0 && r < 8) { RAYBUF.push(r * 4 + c); len++; c += DIRS[d][0]; r += DIRS[d][1]; }
        RAYL[i * 4 + d] = len;
      }
    }
    RAYBUF = new Int8Array(RAYBUF);
  })();
  function dist(a, b) { return Math.abs((a % 4) - (b % 4)) + Math.abs(((a / 4) | 0) - ((b / 4) | 0)); }

  // Zobrist（固定種子，跟對局的亂數無關）
  var zr = E.makeRng(0x5eed1234);
  function zi() { return zr() | 0; }
  var Z1 = new Int32Array(N * 16), Z2 = new Int32Array(N * 16);
  for (var zk = 0; zk < N * 16; zk++) { if (zk % 16 === 0) { Z1[zk] = 0; Z2[zk] = 0; } else { Z1[zk] = zi(); Z2[zk] = zi(); } }
  var ZS1 = zi(), ZS2 = zi();
  var ZB1 = new Int32Array(16 * 6), ZB2 = new Int32Array(16 * 6);
  for (zk = 0; zk < 16 * 6; zk++) { ZB1[zk] = zi(); ZB2[zk] = zi(); }
  var ZC1 = new Int32Array(N + 1), ZC2 = new Int32Array(N + 1);
  for (zk = 0; zk <= N; zk++) { ZC1[zk] = zk ? zi() : 0; ZC2[zk] = zk ? zi() : 0; }
  var ZQ1 = new Int32Array(256), ZQ2 = new Int32Array(256); // 不吃不翻計數（只在它會影響值的時候進鍵）
  for (zk = 0; zk < 256; zk++) { ZQ1[zk] = zi(); ZQ2[zk] = zi(); }

  // ------------------------------------------------------------ 參數表與功能開關

  var DEFAULT_PARAMS = {
    top: [1000, 1000, 1000, 1000, 1000, 0, 1000], // 天敵數模型的 top（K G M R N C P；炮用 cannonTop）
    ratio: 0.8,          // 每多一個活著的天敵，價值乘這個數
    cannonPred: 0.5,     // 敵方每一門活著的炮算幾個天敵（炮能跳吃任何子，但要有炮台、要對上線）
    cannonTop: 750,      // 炮的 top：炮的天敵（帥仕相俥傌＋部分的炮）全死時的價值
    cannonRatio: 0.9,    // 炮每多一個活著的天敵乘這個數（全滿 n＝10：750 × 0.9^10 ≈ 262，高於俥的 168；Misty 的教訓：炮不能低估）
    mobility: 4,         // 每一個能走的空格
    trapped: 0.4,        // 被威脅又沒有安全退路的子，扣它價值的這個比例
    cannonLine: 20,      // 炮現在能跳吃的每一個目標
    kingSafety: 80,      // 帥（將）沒有退路時，附近每一個敵兵
    genDanger: 10,       // 帥被追：Σ敵兵（距離 1／2／3／4 記 4／3／2／1，沿空線再 ×1.5）×（0.5＋被困＋角邊）× 這個數
    flipRisk: 0.5,       // 明子旁的暗格翻出它的天敵的期望損失
    hanging: 0.7,        // 輪到的人現在最好的一吃（扣掉被吃回）的這個比例（沒有靜態搜尋的等級用）
    contempt: 150,       // 和棋對領先方的扣分上限
    contemptFrac: 0.25,  // 和棋扣分＝子力差 × 這個比例（不超過 contempt）
    npWindow: 20,        // 不吃不翻剩這麼多手以內，評估往和棋值拉
    flipMinDepth: 3,     // 翻子門檻：非根節點剩餘深度不到這個數就不展開翻子（當作「可以等一手」，值見 passQ）
    flipTopK: 6,         // 非根節點最多展開幾個翻子（照啟發分數）
    qMaxDepth: 12        // 靜態搜尋最多幾層
  };

  var FEATURE_KEYS = ['mobility', 'trapped', 'cannonLine', 'kingSafety', 'genDanger', 'flipRisk', 'hanging', 'contempt',
    'noProgress', 'tt', 'quiesce', 'flipGate', 'passQ', 'star1', 'history'];

  var BASE_FEATURES = {
    mobility: true, trapped: true, cannonLine: true, kingSafety: true, genDanger: false, flipRisk: true, hanging: true,
    contempt: true, noProgress: false, tt: false, quiesce: false, flipGate: false, passQ: false, star1: true, history: true
  };
  function feats(over) {
    var f = {}, k;
    for (k in BASE_FEATURES) f[k] = BASE_FEATURES[k];
    for (k in over) f[k] = over[k];
    return f;
  }

  // 分級（第一版，之後用自我對弈調）。name 是 i18n 的鍵（3b 接畫面時加到 i18n.js）
  var LEVELS = [
    { id: 1, name: 'ai.level1', algo: 'random', depth: 0, nodes: 0, features: {} },
    { id: 2, name: 'ai.level2', algo: 'search', depth: 1, nodes: 4000, features: feats({ contempt: false }) },
    { id: 3, name: 'ai.level3', algo: 'search', depth: 2, nodes: 6000, features: feats({}) },
    { id: 4, name: 'ai.level4', algo: 'search', depth: 4, nodes: 20000, features: feats({}) },
    { id: 5, name: 'ai.level5', algo: 'search', depth: 6, nodes: 150000, features: feats({}) },
    { id: 6, name: 'ai.level6', algo: 'search', depth: 64, nodes: 300000,
      features: feats({ tt: true, quiesce: true, flipGate: true, passQ: true, noProgress: true, genDanger: true, hanging: false }) }
  ];
  var DEFAULT_TIME_LIMIT = 10000; // 毫秒；只是保險，正常由節點預算決定

  // ------------------------------------------------------------ 搜尋狀態（模組內共用；一次只跑一個搜尋）

  var B = new Int8Array(N), BAG = new Int8Array(16), ALIVE = new Int8Array(16), ALIVE_COL = new Int8Array(2);
  var HIDN = 0, STM = 0, UNDEC = 0, CHAIN = -1, QUIET = 0, DRAWP = 60, MODE_CHAIN = false, RESULT = 0;
  var H1 = 0, H2 = 0, BH1 = 0, BH2 = 0;
  var REP1 = new Int32Array(1024), REP2 = new Int32Array(1024), REPLEN = 0, REPBASE = 0;
  var GEN_ALL = false; // true：連必敗的攻擊暗子也產生（只拿來跟引擎核對）

  // 走一步的復原紀錄
  var SP = 0, SMAX = MAXPLY + 64;
  var S_M = new Int32Array(SMAX), S_OC = new Int8Array(SMAX), S_X = new Int8Array(SMAX);
  var S_QUIET = new Int16Array(SMAX), S_CHAIN = new Int8Array(SMAX), S_STM = new Int8Array(SMAX), S_UNDEC = new Int8Array(SMAX);
  var S_H1 = new Int32Array(SMAX), S_H2 = new Int32Array(SMAX), S_BH1 = new Int32Array(SMAX), S_BH2 = new Int32Array(SMAX);
  var S_REPLEN = new Int16Array(SMAX), S_REPBASE = new Int16Array(SMAX), S_RES = new Int8Array(SMAX);

  var MV = new Int32Array(MAXPLY * MAXM), SC = new Float64Array(MAXPLY * MAXM);
  var HIST = new Float64Array(N * N);

  // 評估用
  // PV[(t*17 + n)*3 + c]：t 型的子、n 個走步天敵、c 門敵炮活著時的價值（configure 填）
  var VAL = new Float64Array(16), MAT = new Float64Array(2), PB = new Float64Array(16), PV = new Float64Array(7 * 17 * 3);
  var ACC_MOB = new Float64Array(2), ACC_TRAP = new Float64Array(2), ACC_CL = new Float64Array(2), ACC_FR = new Float64Array(2), ACC_KS = new Float64Array(2);
  var KSQ = new Int8Array(2), KEMP = new Int8Array(2);

  // 設定（configure 填）
  var F_MOB, F_TRAP, F_CL, F_KS, F_GD, F_FR, F_HANG, F_CONT, F_NP, F_TT, F_Q, F_GATE, F_PASSQ, F_STAR1, F_HIST, F_POS;
  var P_TOP = new Float64Array(7), P_MOB, P_TRAP, P_CL, P_KS, P_GD, P_FR, P_HANG, P_CONT, P_CF, P_NPW, P_FMD, P_FTOPK, P_QMAX;

  // 預算
  var NODES = 0, LIMIT = 0, HARD_LIMIT = 0, DEADLINE = 0, STOPPED = false, STOP_REASON = '', COMPLETED = 0, SHOULD_STOP = null;

  // 置換表（2^18 格；用 AGE 分代，每次思考換一代，所以每一步的結果跟之前的思考無關）
  var TT_BITS = 18, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
  var TK1 = null, TK2, TV, TD, TF, TM, TA, AGE = 0;
  var TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;
  function ensureTT() {
    if (TK1) return;
    TK1 = new Int32Array(TT_SIZE); TK2 = new Int32Array(TT_SIZE); TV = new Float64Array(TT_SIZE);
    TD = new Int8Array(TT_SIZE); TF = new Int8Array(TT_SIZE); TM = new Int32Array(TT_SIZE); TA = new Int32Array(TT_SIZE);
  }

  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  // ------------------------------------------------------------ 從公開資訊建內部局面

  function hashSquares(codes, stm) {
    var h1 = 0, h2 = 0;
    for (var i = 0; i < N; i++) { h1 ^= Z1[i * 16 + codes[i]]; h2 ^= Z2[i * 16 + codes[i]]; }
    if (stm) { h1 ^= ZS1; h2 ^= ZS2; }
    return [h1, h2];
  }
  function codeOfCell(x) { return x === null || x === undefined ? 0 : x === E.HIDDEN ? HID : CODE_OF[x]; }
  function colorIndex(c) { return c === 'b' ? 1 : 0; }

  function setup(view) {
    var i, c;
    for (i = 0; i < N; i++) B[i] = codeOfCell(view.board[i]);
    HIDN = 0;
    for (i = 0; i < N; i++) if (B[i] === HID) HIDN++;
    for (c = 0; c < 16; c++) { BAG[c] = 0; ALIVE[c] = COUNT_OF[c]; }
    for (var p in view.pool) if (CODE_OF[p]) BAG[CODE_OF[p]] = view.pool[p];
    for (i = 0; i < view.captured.length; i++) ALIVE[CODE_OF[view.captured[i]]]--;
    ALIVE_COL[0] = ALIVE_COL[1] = 0;
    for (c = 1; c <= 14; c++) ALIVE_COL[COL[c]] += ALIVE[c];
    UNDEC = view.colors[0] === null ? 1 : 0;
    STM = UNDEC ? 0 : colorIndex(view.colors[view.turn]);
    CHAIN = view.chain ? view.chain.sq : -1;
    QUIET = view.quietPlies; DRAWP = view.drawPlies; MODE_CHAIN = view.mode === 'chain';
    Q_T = F_NP ? Math.min(DRAWP - 1, DRAWP - P_NPW) : DRAWP - 1; // 計數到 DRAWP 和；noProgress 開著時超過 DRAWP − npWindow 就往和棋拉
    var h = hashSquares(B, STM); H1 = h[0]; H2 = h[1];
    BH1 = 0; BH2 = 0;
    for (c = 1; c <= 14; c++) { BH1 ^= ZB1[c * 6 + BAG[c]]; BH2 ^= ZB2[c * 6 + BAG[c]]; }
    // 盤面紀錄：引擎的鍵是 32 個字＋輪到哪一位（0／1）；這裡換成同一個盤面的雜湊（輪到的那一色）
    REPLEN = 0; REPBASE = 0;
    var seen = view.seen || [], cells = new Int8Array(N);
    for (var s = 0; s < seen.length; s++) {
      var key = seen[s];
      for (i = 0; i < N; i++) { var ch = key.charAt(i); cells[i] = ch === '.' ? 0 : ch === E.HIDDEN ? HID : CODE_OF[ch]; }
      var d = Number(key.charAt(N));
      var stm = UNDEC ? 0 : colorIndex(view.colors[d]);
      var hh = hashSquares(cells, stm);
      REP1[REPLEN] = hh[0]; REP2[REPLEN] = hh[1]; REPLEN++;
    }
    RESULT = R_NONE; SP = 0;
  }

  // ------------------------------------------------------------ 合法步（跟引擎同規則；另寫一份是為了快，測試逐步核對兩份一致）

  function setSq(sq, v) {
    var o = B[sq];
    H1 ^= Z1[sq * 16 + o] ^ Z1[sq * 16 + v];
    H2 ^= Z2[sq * 16 + o] ^ Z2[sq * 16 + v];
    B[sq] = v;
  }
  function bagDec(c) {
    var n = BAG[c];
    BH1 ^= ZB1[c * 6 + n] ^ ZB1[c * 6 + n - 1];
    BH2 ^= ZB2[c * 6 + n] ^ ZB2[c * 6 + n - 1];
    BAG[c] = n - 1; HIDN--;
  }

  // 攻擊暗子有沒有可能成功：袋子裡有沒有這個子吃得了的敵子（炮：任何敵子）
  function attackCanWin(a) {
    var col = COL[a], at = TYP[a], base = col === 0 ? 8 : 1;
    for (var t = 0; t < 7; t++) if (BAG[base + t] > 0 && (at === T_C || CAN[at * 7 + t])) return true;
    return false;
  }

  // 從 sq 出發的吃子（與連吃玩法的攻擊暗子）寫進 MV[n…]；回傳新的 n
  function genFrom(sq, n, withAttacks) {
    var a = B[sq], at = TYP[a], col = COL[a], to, t, k;
    var atk = withAttacks && MODE_CHAIN && (GEN_ALL || attackCanWin(a));
    if (at === T_C) {
      for (var d = 0; d < 4; d++) {
        var j = RAYS[sq * 4 + d], e = j + RAYL[sq * 4 + d];
        while (j < e && B[RAYBUF[j]] === 0) j++;
        j++;
        while (j < e && B[RAYBUF[j]] === 0) j++;
        if (j >= e) continue;
        to = RAYBUF[j]; t = B[to];
        if (t === HID) { if (atk) MV[n++] = K_ATTACK | (sq << 3) | (to << 8); }
        else if (COL[t] !== col) MV[n++] = K_CAPTURE | (sq << 3) | (to << 8);
      }
      return n;
    }
    var nb = sq * 4, cnt = NBC[sq];
    for (k = 0; k < cnt; k++) {
      to = NBS[nb + k]; t = B[to];
      if (t === 0) continue;
      if (t === HID) { if (atk) MV[n++] = K_ATTACK | (sq << 3) | (to << 8); }
      else if (COL[t] !== col && CAN[at * 7 + TYP[t]]) MV[n++] = K_CAPTURE | (sq << 3) | (to << 8);
    }
    return n;
  }

  // 連吃還能不能繼續（引擎 afterCapture 的判法：吃子或攻擊暗子都算目標，含必敗的攻擊）
  function hasTargetFrom(sq) {
    var a = B[sq], at = TYP[a], col = COL[a], to, t, k;
    if (at === T_C) {
      for (var d = 0; d < 4; d++) {
        var j = RAYS[sq * 4 + d], e = j + RAYL[sq * 4 + d];
        while (j < e && B[RAYBUF[j]] === 0) j++;
        j++;
        while (j < e && B[RAYBUF[j]] === 0) j++;
        if (j >= e) continue;
        t = B[RAYBUF[j]];
        if (t === HID || COL[t] !== col) return true;
      }
      return false;
    }
    var nb = sq * 4, cnt = NBC[sq];
    for (k = 0; k < cnt; k++) {
      to = NBS[nb + k]; t = B[to];
      if (t === 0) continue;
      if (t === HID) return true;
      if (COL[t] !== col && CAN[at * 7 + TYP[t]]) return true;
    }
    return false;
  }

  // qOnly：只要吃子（靜態搜尋用；連吃中另加 stop）
  function genMoves(n, qOnly) {
    var i, a, k, nb, cnt;
    if (CHAIN >= 0) {
      n = genFrom(CHAIN, n, !qOnly);
      MV[n++] = K_STOP;
      return n;
    }
    if (!qOnly) for (i = 0; i < N; i++) if (B[i] === HID) MV[n++] = K_FLIP | (i << 8);
    if (UNDEC) return n;
    for (i = 0; i < N; i++) {
      a = B[i];
      if (a === 0 || a === HID || COL[a] !== STM) continue;
      if (!qOnly) {
        nb = i * 4; cnt = NBC[i];
        for (k = 0; k < cnt; k++) if (B[NBS[nb + k]] === 0) MV[n++] = K_MOVE | (i << 3) | (NBS[nb + k] << 8);
      }
      n = genFrom(i, n, !qOnly);
    }
    return n;
  }

  function hasAnyMove() {
    if (HIDN > 0) return true;
    for (var i = 0; i < N; i++) {
      var a = B[i];
      if (a === 0 || a === HID || COL[a] !== STM) continue;
      var nb = i * 4, cnt = NBC[i];
      for (var k = 0; k < cnt; k++) if (B[NBS[nb + k]] === 0) return true;
      if (hasTargetFrom(i)) return true;
    }
    return false;
  }

  // 一手結束、換人之後判勝負（引擎 computeResult 的順序：先輸、再和）
  function computeResult() {
    if (ALIVE_COL[STM] === 0) return R_LOSS;
    if (ALIVE_COL[STM ^ 1] === 0) return R_WIN;
    if (HIDN === 0 && !hasAnyMove()) return R_LOSS;
    if (QUIET >= DRAWP) return R_DRAW;
    var c = 0;
    for (var i = REPBASE; i < REPLEN; i++) if (REP1[i] === H1 && REP2[i] === H2) c++;
    if (c >= 3) return R_DRAW;
    return R_NONE;
  }

  function endMove(irrev) {
    CHAIN = -1;
    if (irrev) { QUIET = 0; REPBASE = REPLEN; } else QUIET++;
    STM ^= 1; H1 ^= ZS1; H2 ^= ZS2;
    REP1[REPLEN] = H1; REP2[REPLEN] = H2; REPLEN++;
    RESULT = computeResult();
  }

  function afterCapture(sq) {
    if (MODE_CHAIN && ALIVE_COL[STM ^ 1] > 0 && hasTargetFrom(sq)) { CHAIN = sq; RESULT = R_NONE; }
    else endMove(1);
  }

  function checkLimits() {
    if (SHOULD_STOP && SHOULD_STOP()) { STOPPED = true; STOP_REASON = 'cancel'; return; }
    if (NODES >= LIMIT && (COMPLETED >= 1 || NODES >= HARD_LIMIT)) { STOPPED = true; STOP_REASON = 'nodes'; return; }
    if (now() > DEADLINE) { STOPPED = true; STOP_REASON = 'time'; }
  }

  // 走一步；oc 是機會節點的結果（翻出的子）
  function make(m, oc) {
    var sp = SP++;
    S_M[sp] = m; S_OC[sp] = oc; S_QUIET[sp] = QUIET; S_CHAIN[sp] = CHAIN; S_STM[sp] = STM; S_UNDEC[sp] = UNDEC;
    S_H1[sp] = H1; S_H2[sp] = H2; S_BH1[sp] = BH1; S_BH2[sp] = BH2; S_REPLEN[sp] = REPLEN; S_REPBASE[sp] = REPBASE; S_RES[sp] = RESULT;
    NODES++;
    if ((NODES & 1023) === 0 || NODES === LIMIT) checkLimits();
    var k = m & 7, from = (m >> 3) & 31, to = (m >> 8) & 31, a, x;
    if (k === K_FLIP) {
      setSq(to, oc); bagDec(oc);
      if (UNDEC) { UNDEC = 0; if (COL[oc] !== STM) { STM = COL[oc]; H1 ^= ZS1; H2 ^= ZS2; } }
      endMove(1);
    } else if (k === K_MOVE) {
      a = B[from]; setSq(from, 0); setSq(to, a); endMove(0);
    } else if (k === K_CAPTURE) {
      a = B[from]; x = B[to]; S_X[sp] = x;
      setSq(from, 0); setSq(to, a); ALIVE[x]--; ALIVE_COL[COL[x]]--;
      afterCapture(to);
    } else if (k === K_ATTACK) {
      a = B[from]; bagDec(oc);
      if (COL[oc] !== COL[a] && (TYP[a] === T_C || CAN[TYP[a] * 7 + TYP[oc]])) {
        S_X[sp] = 1; setSq(from, 0); setSq(to, a); ALIVE[oc]--; ALIVE_COL[COL[oc]]--;
        afterCapture(to);
      } else {
        S_X[sp] = 0; setSq(to, oc); endMove(1);
      }
    } else {
      endMove(1);
    }
  }

  function unmake() {
    var sp = --SP, m = S_M[sp], oc = S_OC[sp], k = m & 7, from = (m >> 3) & 31, to = (m >> 8) & 31, x;
    if (k === K_FLIP) { B[to] = HID; BAG[oc]++; HIDN++; }
    else if (k === K_MOVE) { B[from] = B[to]; B[to] = 0; }
    else if (k === K_CAPTURE) { x = S_X[sp]; B[from] = B[to]; B[to] = x; ALIVE[x]++; ALIVE_COL[COL[x]]++; }
    else if (k === K_ATTACK) {
      if (S_X[sp]) { B[from] = B[to]; ALIVE[oc]++; ALIVE_COL[COL[oc]]++; }
      B[to] = HID; BAG[oc]++; HIDN++;
    }
    QUIET = S_QUIET[sp]; CHAIN = S_CHAIN[sp]; STM = S_STM[sp]; UNDEC = S_UNDEC[sp];
    H1 = S_H1[sp]; H2 = S_H2[sp]; BH1 = S_BH1[sp]; BH2 = S_BH2[sp]; REPLEN = S_REPLEN[sp]; REPBASE = S_REPBASE[sp]; RESULT = S_RES[sp];
  }

  // ------------------------------------------------------------ 評估

  // 天敵數子力：VAL[每種子]、MAT[每色]、PB[每種子]＝袋子裡它的敵方（走步）天敵個數
  function computeVal() {
    for (var col = 0; col < 2; col++) {
      var eb = col === 0 ? 8 : 1, mat = 0, ec = ALIVE[eb + T_C];
      for (var t = 0; t < 7; t++) {
        var code = 1 + col * 7 + t, preds = PRED[t], n = 0, nb = 0, v;
        for (var j = 0; j < preds.length; j++) { n += ALIVE[eb + preds[j]]; nb += BAG[eb + preds[j]]; }
        v = PV[(t * 17 + n) * 3 + ec];
        VAL[code] = v; PB[code] = nb;
        mat += ALIVE[code] * v;
      }
      MAT[col] = mat;
    }
  }

  function cannonTarget(sq, d) {
    var j = RAYS[sq * 4 + d], e = j + RAYL[sq * 4 + d];
    while (j < e && B[RAYBUF[j]] === 0) j++;
    j++;
    while (j < e && B[RAYBUF[j]] === 0) j++;
    return j >= e ? -1 : RAYBUF[j];
  }

  // ATK[col*32+n]：col 色的明子裡，貼著 n 的那些能走步吃哪些子型（位元：1<<子型）
  var ATK = new Int32Array(64), CANMASK = new Int32Array(7);
  for (ia = 0; ia < 7; ia++) for (it = 0; it < 7; it++) if (CAN[ia * 7 + it]) CANMASK[ia] |= 1 << it;

  // a、b 在同一列或同一欄，中間全是空格（相鄰也算）
  function openLine(a, b) {
    var ca = a % 4, cb = b % 4, step;
    if (ca === cb) step = 4; else if (((a / 4) | 0) === ((b / 4) | 0)) step = 1; else return false;
    if (a > b) { var tmp = a; a = b; b = tmp; }
    for (var x = a + step; x < b; x += step) if (B[x] !== 0) return false;
    return true;
  }
  // 帥（將）被追的程度（c 色的帥；要先算好 ATK、KSQ）
  function genDanger(c) {
    var k = KSQ[c];
    if (k < 0) return 0;
    var ep = c === 0 ? 14 : 7, eb = (c ^ 1) * 32, room = 0, nb = k * 4, cnt = NBC[k], j, x;
    for (j = 0; j < cnt; j++) {
      x = B[NBS[nb + j]];
      if (x === 0) { if (!(ATK[eb + NBS[nb + j]] & 1)) room += 1; } // 1＝1 << T_K：沒有敵子能吃到那一格的帥
      else if (x === HID) room += 0.5;                                 // 暗子：翻開以後可能讓出退路
    }
    var tight = room >= 2 ? 0 : 2 - room, edge = (4 - cnt) * 0.5, thr = 0;
    for (var sq = 0; sq < N; sq++) {
      if (B[sq] !== ep) continue;
      var d = dist(sq, k), w = d <= 1 ? 4 : d === 2 ? 3 : d === 3 ? 2 : d === 4 ? 1 : 0;
      if (w && openLine(sq, k)) w *= 1.5;
      thr += w;
    }
    return thr * (0.5 + tight + edge);
  }

  function positional(me) {
    var hang = 0, sq, k, n, a, x;
    ACC_MOB[0] = ACC_MOB[1] = ACC_TRAP[0] = ACC_TRAP[1] = ACC_CL[0] = ACC_CL[1] = ACC_FR[0] = ACC_FR[1] = ACC_KS[0] = ACC_KS[1] = 0;
    KSQ[0] = KSQ[1] = -1;
    for (k = 0; k < 64; k++) ATK[k] = 0;
    for (sq = 0; sq < N; sq++) {
      a = B[sq];
      if (a === 0 || a === HID) continue;
      var mask = CANMASK[TYP[a]], ab = COL[a] * 32, nb0 = sq * 4, cnt0 = NBC[sq];
      if (mask) for (k = 0; k < cnt0; k++) ATK[ab + NBS[nb0 + k]] |= mask;
    }
    for (sq = 0; sq < N; sq++) {
      a = B[sq];
      if (a === 0 || a === HID) continue;
      var col = COL[a], t = TYP[a], v = VAL[a], nb = sq * 4, cnt = NBC[sq], bit = 1 << t, eb = (col ^ 1) * 32;
      var emp = 0, safe = 0, hid = 0, thr = 0;
      for (k = 0; k < cnt; k++) {
        n = NBS[nb + k]; x = B[n];
        if (x === 0) { emp++; if (!(ATK[eb + n] & bit)) safe++; }
        else if (x === HID) hid++;
        else if (COL[x] !== col) {
          if (CAN[TYP[x] * 7 + t]) thr = 1;
          if (F_HANG && col === me && CAN[t * 7 + TYP[x]]) {
            var g = VAL[x] - ((ATK[eb + n] & bit) ? v : 0);
            if (g > hang) hang = g;
          }
        }
      }
      ACC_MOB[col] += emp;
      if (thr && safe === 0) ACC_TRAP[col] += v;
      if (hid && HIDN) ACC_FR[col] += v * hid * PB[a] / HIDN;
      if (t === T_C && (F_CL || F_HANG)) {
        for (var d = 0; d < 4; d++) {
          var to = cannonTarget(sq, d);
          if (to < 0) continue;
          var y = B[to];
          if (y === HID || COL[y] === col) continue;
          ACC_CL[col]++;
          if (F_HANG && col === me) {
            var g2 = VAL[y] - ((ATK[eb + to] & bit) ? v : 0);
            if (g2 > hang) hang = g2;
          }
        }
      }
      if (t === T_K) { KSQ[col] = sq; KEMP[col] = emp; }
    }
    if (F_KS) {
      for (var c = 0; c < 2; c++) {
        if (KSQ[c] < 0 || KEMP[c] > 1) continue;
        var ep = c === 0 ? 14 : 7; // 敵兵
        for (sq = 0; sq < N; sq++) if (B[sq] === ep && dist(sq, KSQ[c]) <= 2) ACC_KS[c]++;
      }
    }
    var op = me ^ 1, s = 0;
    if (F_GD) s -= P_GD * (genDanger(me) - genDanger(op));
    if (F_MOB) s += P_MOB * (ACC_MOB[me] - ACC_MOB[op]);
    if (F_TRAP) s -= P_TRAP * (ACC_TRAP[me] - ACC_TRAP[op]);
    if (F_CL) s += P_CL * (ACC_CL[me] - ACC_CL[op]);
    if (F_KS) s -= P_KS * (ACC_KS[me] - ACC_KS[op]);
    if (F_FR) s -= P_FR * (ACC_FR[me] - ACC_FR[op]);
    if (F_HANG) s += P_HANG * hang;
    return s;
  }

  // 沒有暗子時：col 有沒有一個子是對方剩下的子全都吃不了的（走步照 CAN；炮能跳吃任何子，但盤上要有第三個子當炮台）。
  // 對方只剩一門炮時 col 也吃不光：炮最多吃到 col 剩一子，最後一子沒有炮台可跳。
  // 有的話 col 不會被吃光，但不等於不會輸：規則 6.2 輪到時沒有合法步就輸，所以 col 還是可能被困死。
  // 這裡不算困死；搜尋在深度 1 就看得到「沒步可走」，只有地平線外的葉子會估錯。
  // 例：吃不掉的炮對兵卒，兵卒那一方唯一贏的路就是把炮困住。
  function hasSafePiece(col) {
    var mb = col === 0 ? 1 : 8, eb = col === 0 ? 8 : 1, cannonOk = ALIVE_COL[0] + ALIVE_COL[1] >= 3;
    if (ALIVE_COL[col ^ 1] === 1 && ALIVE[eb + T_C] === 1) return ALIVE_COL[col] > 0;
    for (var t = 0; t < 7; t++) {
      if (!ALIVE[mb + t]) continue;
      var safe = true;
      for (var y = 0; y < 7 && safe; y++) if (ALIVE[eb + y] && (y === T_C ? cannonOk : CAN[y * 7 + t])) safe = false;
      if (safe) return true;
    }
    return false;
  }
  // 吃不掉的子：+1＝輪到的人有、對方沒有（對方吃不光我）；−1 反過來；0＝都有、都沒有、或還有暗子
  function robustSide() {
    if (HIDN) return 0;
    var a = hasSafePiece(STM), b = hasSafePiece(STM ^ 1);
    return a === b ? 0 : a ? 1 : -1;
  }

  function drawValue() {
    if (!F_CONT) return 0;
    var r = robustSide();
    if (r > 0) return -P_CONT;  // 我不會輸（不會被吃光）：和棋對我不好
    if (r < 0) return P_CONT;   // 我吃不光對方：和棋對我好
    computeVal();
    var md = MAT[STM] - MAT[STM ^ 1];
    if (md > 0) return -Math.min(P_CONT, md * P_CF);
    if (md < 0) return Math.min(P_CONT, -md * P_CF);
    return 0;
  }

  // 吃不光對方的一方最多和棋：把評估壓到和棋值的那一側（r＜0 嚴格低於 dv，r＞0 嚴格高於 dv）。
  // 不是硬封頂：硬封頂讓封頂那一方每個局面都是 dv，就不在乎子力、會送子。
  // 離 dv 還有 δ＝SQUASH_D 以上的分數不動；超過門檻 x 的部分壓成 dv − δ²／(x＋δ)（r＞0 鏡像）：
  // x＝0 時是 dv − δ、斜率 1（門檻兩邊連續、斜率也連續），之後嚴格遞增、永遠到不了 dv。
  // 所以真的和棋（值正好是 dv）還是比任何沒結束的葉子好，但子力多的葉子仍然比子力少的高。
  // 用有理式不用指數：斜率 δ²／(x＋δ)² 只隨 x 平方變小。封頂方最大的子力領先約 7800（相相俥俥傌傌＋五兵 對 一個士：
  // 兵相俥傌都吃不了士），x 約 8000 時離 dv 還有約 11、斜率約 1.3e-3（差 100 分子力還差約 0.13 分、差一格機動約 5e-3）；
  // 指數式 δ·e^(−x/δ) 在那裡只剩 1e-9 量級，比搜尋空視窗開的縫（約 1.5e-4）還小，位置項再大一點就捨入成 dv，又變回平的。
  // SQUASH_D＝300：門檻在 dv − 300，離和棋值這麼近的分數本來就該往和棋值靠；再小的話遠處的分差會更小（δ² 決定尾巴）。
  var SQUASH_D = 300;
  function drawSquash(s, r, dv) {
    var d = SQUASH_D;
    if (r < 0) { var hi = dv - d; return s > hi ? dv - d * d / (s - hi + d) : s; }
    if (r > 0) { var lo = dv + d; return s < lo ? dv + d * d / (lo - s + d) : s; }
    return s;
  }

  // 從輪到的人看的分數
  function evaluate() {
    computeVal();
    var me = STM, s = MAT[me] - MAT[me ^ 1];
    if (F_POS) s += positional(me);
    if (!HIDN) {
      var r = robustSide();
      if (r) s = drawSquash(s, r, drawValue());
    }
    if (F_NP && QUIET > DRAWP - P_NPW) {
      var f = (DRAWP - QUIET) / P_NPW;
      if (f < 0) f = 0;
      s = s * f + drawValue() * (1 - f);
    }
    return s > EVAL_CAP ? EVAL_CAP : s < -EVAL_CAP ? -EVAL_CAP : s;
  }

  function terminal(ply) {
    if (RESULT === R_LOSS) return -(WIN - ply);
    if (RESULT === R_WIN) return WIN - ply;
    return drawValue();
  }

  // ------------------------------------------------------------ Star1（Hsu 講義的一般權重版）
  // ws[0…cnt−1] 是各結果的權重（個數），child(i, a, b) 回傳第 i 個結果的值（從同一方看）。
  // 每個結果的視窗 (A, B)：A＝(W·alpha − (已知加權和＋vmax·剩下的權重))／w，B 同理用 vmin。
  // 結果 ≥ B：下界 m ≥ beta，剪（回 m）；結果 ≤ A：上界 M ≤ alpha，剪（回 M）。全部看完回期望值。
  // 視窗是空的（浮點捨入、或呼叫端給了 alpha ≥ beta）時另外處理，不把顛倒的視窗傳下去。
  function star1(ws, cnt, alpha, beta, vmin, vmax, child) {
    var W = 0, i;
    for (i = 0; i < cnt; i++) W += ws[i];
    var sum = 0, done = 0;
    for (i = 0; i < cnt; i++) {
      var w = ws[i], rest = W - done - w;
      var A = (W * alpha - (sum + vmax * rest)) / w;
      var Bv = (W * beta - (sum + vmin * rest)) / w;
      // 這個結果最差是 vmin 也已經 ≥ beta（最好是 vmax 也 ≤ alpha）：不用搜就有界
      if (Bv <= vmin) return (sum + vmin * (w + rest)) / W;
      if (A >= vmax) return (sum + vmax * (w + rest)) / W;
      var a = A > vmin ? A : vmin, b = Bv < vmax ? Bv : vmax, t;
      if (a >= b) {
        // 空的視窗（A ≥ B）：任何結果都 ≥ B 或 ≤ A，用 (B, A) 搜一次（相等時開一點點）就能定是哪一邊
        var hi = a > b ? a : b + 1e-6 * (b > 1 || b < -1 ? Math.abs(b) : 1);
        t = child(i, b, hi);
        if (STOPPED) return 0;
        if (t <= b) return (sum + w * t + vmax * rest) / W; // t 是上界，t ≤ B ≤ A
        return (sum + w * t + vmin * rest) / W;             // t 是下界或真值，t > B
      }
      t = child(i, a, b);
      if (STOPPED) return 0;
      if (t >= Bv) return (sum + w * t + vmin * rest) / W;
      if (t <= A) return (sum + w * t + vmax * rest) / W;
      sum += w * t; done += w;
    }
    return sum / W;
  }
  // Star0：每個結果都用全視窗搜，取期望值（拿來和 Star1 對照）
  function star0(ws, cnt, alpha, beta, vmin, vmax, child) {
    var W = 0, sum = 0, i;
    for (i = 0; i < cnt; i++) W += ws[i];
    for (i = 0; i < cnt; i++) { sum += ws[i] * child(i, vmin, vmax); if (STOPPED) return 0; }
    return sum / W;
  }

  // ------------------------------------------------------------ 搜尋

  function toTT(v, ply) { return v > MATE_ZONE ? v + ply : v < -MATE_ZONE ? v - ply : v; }
  function fromTT(v, ply) { return v > MATE_ZONE ? v - ply : v < -MATE_ZONE ? v + ply : v; }

  // 走 m（結果 oc）以後，從走的這一方看的值。每一下（吃、攻擊、走、翻）扣一層；stop 只是收手，不扣。
  // 所以「吃一子就停」跟經典玩法的一步一樣是一層，連吃每多吃一下多一層（不扣的話連吃樹會爆）。
  function childValue(m, oc, depth, alpha, beta, ply) {
    make(m, oc);
    var v = CHAIN >= 0 ? search(depth - 1, alpha, beta, ply + 1) : -search((m & 7) === K_STOP ? depth : depth - 1, -beta, -alpha, ply + 1);
    unmake();
    return v;
  }

  // 機會節點：翻子、攻擊暗子。結果照個數多到少排
  var OC_BUF = new Int8Array(MAXPLY * 16), OW_BUF = new Float64Array(MAXPLY * 16);
  function chanceValue(m, depth, alpha, beta, ply) {
    var ob = ply * 16, cnt = 0, c, j;
    for (c = 1; c <= 14; c++) if (BAG[c] > 0) {
      // 插入排序（個數大的先；同數照代號）
      for (j = cnt; j > 0 && OW_BUF[ob + j - 1] < BAG[c]; j--) { OW_BUF[ob + j] = OW_BUF[ob + j - 1]; OC_BUF[ob + j] = OC_BUF[ob + j - 1]; }
      OW_BUF[ob + j] = BAG[c]; OC_BUF[ob + j] = c; cnt++;
    }
    var ws = OW_BUF.subarray(ob, ob + cnt);
    var child = function (k, a, b) { return childValue(m, OC_BUF[ob + k], depth, a, b, ply); };
    return F_STAR1 ? star1(ws, cnt, alpha, beta, VMIN, VMAX, child) : star0(ws, cnt, alpha, beta, VMIN, VMAX, child);
  }

  function moveValue(m, depth, alpha, beta, ply) {
    var k = m & 7;
    if (k === K_FLIP || k === K_ATTACK) return chanceValue(m, depth, alpha, beta, ply);
    return childValue(m, 0, depth, alpha, beta, ply);
  }

  // 翻子的啟發分數（輪到的人翻 sq）：翻出敵方天敵貼著自己的明子＝風險；翻出自己的子貼著敵方明子＝小小的機會
  function flipScore(sq) {
    if (!HIDN) return 0;
    var nb = sq * 4, cnt = NBC[sq], s = 0;
    for (var k = 0; k < cnt; k++) {
      var x = B[NBS[nb + k]];
      if (x === 0 || x === HID) continue;
      if (COL[x] === STM) s -= VAL[x] * PB[x] / HIDN;
      else s += 0.3 * VAL[x] * PB[x] / HIDN;
    }
    return s;
  }

  function scoreMoves(base, end, ttMove) {
    for (var i = base; i < end; i++) {
      var m = MV[i], k = m & 7, from = (m >> 3) & 31, to = (m >> 8) & 31, s;
      if (m === ttMove && ttMove !== 0) s = 1e9;
      else if (k === K_CAPTURE) s = 1e7 + VAL[B[to]] * 16 - VAL[B[from]];
      else if (k === K_ATTACK) s = 5e6;
      else if (k === K_STOP) s = 4e6;
      else if (k === K_MOVE) s = F_HIST ? HIST[from * 32 + to] : 0;
      else s = -1e7 + flipScore(to);
      SC[i] = s;
    }
    // 插入排序（大的先；同分保持原順序）
    for (i = base + 1; i < end; i++) {
      var mv = MV[i], sc = SC[i], j = i - 1;
      while (j >= base && SC[j] < sc) { MV[j + 1] = MV[j]; SC[j + 1] = SC[j]; j--; }
      MV[j + 1] = mv; SC[j + 1] = sc;
    }
  }

  // 翻子門檻的「等一手」值：讓對方先走、只看吃子的靜態搜尋（對方吊著的子、我吊著的子都算進去），從我看
  function passValue(alpha, beta, ply) {
    STM ^= 1; H1 ^= ZS1; H2 ^= ZS2;
    var v = -qsearch(-beta, -alpha, ply + 1, 0);
    STM ^= 1; H1 ^= ZS1; H2 ^= ZS2;
    return v;
  }

  // 置換表的鍵：公開盤面（含輪到誰）＋未翻子袋＋連吃中那一格；子樹碰得到「不吃不翻」的影響範圍（往和棋拉、或到上限和棋）時
  // 再加上計數本身。Q_T：計數超過它，評估或判和就跟計數有關
  var KEY1 = 0, KEY2 = 0, Q_T = 0;
  function ttKey(depth) {
    KEY1 = H1 ^ BH1 ^ ZC1[CHAIN + 1]; KEY2 = H2 ^ BH2 ^ ZC2[CHAIN + 1];
    if (QUIET + depth > Q_T) { KEY1 ^= ZQ1[QUIET]; KEY2 ^= ZQ2[QUIET]; return true; }
    return false;
  }

  function search(depth, alpha, beta, ply) {
    if (RESULT) return terminal(ply);
    if (STOPPED) return 0;
    if (alpha >= beta) beta = alpha + 1e-6 * (alpha > 1 || alpha < -1 ? Math.abs(alpha) : 1); // 空視窗：開一點點（結果的界照樣對）
    if (depth <= 0 || ply >= MAXPLY - 4) return F_Q ? qsearch(alpha, beta, ply, 0) : evaluate();
    var ttMove = 0, k1 = 0, k2 = 0, idx = 0, a0 = alpha, v;
    if (F_TT) {
      var qk = ttKey(depth);
      k1 = KEY1; k2 = KEY2; idx = k1 & TT_MASK;
      if (TK1[idx] === k1 && TK2[idx] === k2 && TA[idx] === AGE) {
        ttMove = TM[idx];
        // 鍵裡沒有計數的格子：存的那次搜尋深度 TD 比這次深時，要確定它也碰不到計數的影響範圍
        if (TD[idx] >= depth && (qk || QUIET + TD[idx] <= Q_T)) {
          v = fromTT(TV[idx], ply);
          var f = TF[idx];
          if (f === TT_EXACT || (f === TT_LOWER && v >= beta) || (f === TT_UPPER && v <= alpha)) return v;
        }
      }
    }
    var base = ply * MAXM, end = genMoves(base, false);
    computeVal();
    scoreMoves(base, end, ttMove);
    var best = -INF, bestM = 0, gated = false, flips = 0;
    for (var i = base; i < end; i++) {
      var m = MV[i];
      if ((m & 7) === K_FLIP && F_GATE && ply > 0) {
        if (depth < P_FMD || flips >= P_FTOPK) {
          if (!gated) {
            // 不展開的翻子當作「可以等一手」：passQ 開著時用「對方先吃」的靜態搜尋當底，否則用靜態評估
            gated = true;
            v = F_PASSQ ? passValue(alpha, beta, ply) : evaluate();
            if (STOPPED) return 0;
            if (v > best) { best = v; bestM = 0; }
            if (v > alpha) alpha = v;
            if (alpha >= beta) break;
          }
          continue;
        }
        flips++;
      }
      v = moveValue(m, depth, alpha, beta, ply);
      if (STOPPED) return 0;
      if (v > best) {
        best = v; bestM = m;
        if (v > alpha) alpha = v;
        if (alpha >= beta) {
          if (F_HIST && (m & 7) === K_MOVE) HIST[((m >> 3) & 31) * 32 + ((m >> 8) & 31)] += depth * depth;
          break;
        }
      }
    }
    if (best === -INF) best = evaluate(); // 不會發生（沒有合法步的局面在 RESULT 已經判輸）
    if (F_TT) {
      if (TA[idx] !== AGE || TD[idx] <= depth) {
        TK1[idx] = k1; TK2[idx] = k2; TA[idx] = AGE; TD[idx] = depth; TM[idx] = bestM;
        TV[idx] = toTT(best, ply);
        TF[idx] = best <= a0 ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
      }
    }
    return best;
  }

  // 靜態搜尋：只看吃子（連吃中另有 stop，沒有「不走」可選）
  function qsearch(alpha, beta, ply, qd) {
    if (RESULT) return terminal(ply);
    if (STOPPED) return 0;
    var best, v, inChain = CHAIN >= 0;
    if (ply >= MAXPLY - 4 || qd >= P_QMAX) return evaluate();
    if (!inChain) {
      best = evaluate();
      if (best >= beta) return best;
      if (best > alpha) alpha = best;
    } else best = -INF;
    var base = ply * MAXM, end = genMoves(base, true);
    if (end === base) return best;
    computeVal();
    scoreMoves(base, end, 0);
    for (var i = base; i < end; i++) {
      var m = MV[i];
      make(m, 0);
      v = CHAIN >= 0 ? qsearch(alpha, beta, ply + 1, qd + 1) : -qsearch(-beta, -alpha, ply + 1, qd + 1);
      unmake();
      if (STOPPED) return 0;
      if (v > best) { best = v; if (v > alpha) alpha = v; if (alpha >= beta) break; }
    }
    return best;
  }

  // ------------------------------------------------------------ 設定、根節點、對外 API

  function levelOf(id) {
    var n = id === undefined ? 4 : Number(id);
    for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i].id === n) return LEVELS[i];
    throw new Error('沒有這個等級：' + id);
  }

  function configure(lv, opts) {
    var f = {}, k, p = {};
    for (k in lv.features) f[k] = lv.features[k];
    if (opts.features) for (k in opts.features) {
      if (FEATURE_KEYS.indexOf(k) < 0) throw new Error('不認得的功能開關：' + k);
      f[k] = !!opts.features[k];
    }
    for (k in DEFAULT_PARAMS) p[k] = DEFAULT_PARAMS[k];
    if (opts.params) for (k in opts.params) {
      if (!(k in DEFAULT_PARAMS)) throw new Error('不認得的參數：' + k);
      p[k] = opts.params[k];
    }
    F_MOB = !!f.mobility; F_TRAP = !!f.trapped; F_CL = !!f.cannonLine; F_KS = !!f.kingSafety; F_GD = !!f.genDanger; F_FR = !!f.flipRisk;
    F_HANG = !!f.hanging; F_CONT = !!f.contempt; F_NP = !!f.noProgress; F_TT = !!f.tt; F_Q = !!f.quiesce;
    F_GATE = !!f.flipGate; F_PASSQ = !!f.passQ; F_STAR1 = f.star1 !== false; F_HIST = !!f.history;
    F_POS = F_MOB || F_TRAP || F_CL || F_KS || F_GD || F_FR || F_HANG;
    for (k = 0; k < 7; k++) P_TOP[k] = p.top[k];
    P_MOB = p.mobility; P_TRAP = p.trapped; P_CL = p.cannonLine; P_KS = p.kingSafety; P_GD = p.genDanger;
    P_FR = p.flipRisk; P_HANG = p.hanging; P_CONT = p.contempt; P_CF = p.contemptFrac; P_NPW = p.npWindow;
    P_FMD = p.flipMinDepth; P_FTOPK = p.flipTopK; P_QMAX = p.qMaxDepth;
    for (var t = 0; t < 7; t++) for (var n = 0; n < 17; n++) for (var c = 0; c < 3; c++) {
      var e = n + p.cannonPred * c;
      PV[(t * 17 + n) * 3 + c] = t === T_C ? p.cannonTop * Math.pow(p.cannonRatio, e) : P_TOP[t] * Math.pow(p.ratio, e);
    }
    if (F_TT) { ensureTT(); AGE++; }
    for (k = 0; k < HIST.length; k++) HIST[k] = 0;
    return f;
  }

  function moveKey(m) {
    if (m.type === 'flip') return 'f' + m.sq;
    if (m.type === 'stop') return 's';
    return m.type.charAt(0) + m.from + '-' + m.to;
  }
  var KIND_NAME = ['', 'move', 'capture', 'attack', 'stop', 'flip'];
  function internalKey(m) {
    var k = m & 7;
    if (k === K_FLIP) return 'f' + ((m >> 8) & 31);
    if (k === K_STOP) return 's';
    return KIND_NAME[k].charAt(0) + ((m >> 3) & 31) + '-' + ((m >> 8) & 31);
  }
  function toEngineMove(m, legal) {
    var key = internalKey(m);
    for (var i = 0; i < legal.length; i++) if (moveKey(legal[i]) === key) return legal[i];
    throw new Error('內部錯誤：AI 選的步不在合法步裡：' + key);
  }

  // 只取公開欄位（傳進完整狀態也一樣只讀這些）
  function publicPart(v) {
    return {
      mode: v.mode, drawPlies: v.drawPlies, board: v.board, turn: v.turn, colors: v.colors, pool: v.pool,
      captured: v.captured, quietPlies: v.quietPlies, seen: v.seen, chain: v.chain, result: v.result, ply: v.ply
    };
  }

  // 根節點：內部產生的合法步要跟引擎一致（不一致就是規則鏡像寫錯，直接丟錯）
  function checkRoot(legal) {
    GEN_ALL = true;
    var end = genMoves(0, false);
    GEN_ALL = false;
    var mine = [], theirs = legal.map(moveKey).sort();
    for (var i = 0; i < end; i++) mine.push(internalKey(MV[i]));
    mine.sort();
    if (mine.join(' ') !== theirs.join(' ')) throw new Error('AI 的合法步和引擎不一致：' + mine.join(' ') + ' ／ ' + theirs.join(' '));
  }

  function think(view0, opts) {
    opts = opts || {};
    var t0 = now();
    var view = publicPart(view0);
    var lv = levelOf(opts.level);
    if (opts.mode !== undefined && opts.mode !== view.mode) throw new Error('mode 和局面不一致：' + opts.mode + ' ／ ' + view.mode);
    var legal = E.legalMoves(view);
    var out = { move: null, score: 0, depth: 0, nodes: 0, ms: 0, level: lv.id, reason: '' };
    if (!legal.length) { out.reason = 'over'; return out; }
    var rng = opts.seed === undefined || opts.seed === null ? E.defaultRng() : E.makeRng(opts.seed);
    if (lv.algo === 'random') {
      out.move = legal[E.randInt(rng, legal.length)]; out.reason = 'random'; out.ms = now() - t0;
      return out;
    }
    configure(lv, opts);
    setup(view);
    checkRoot(legal);
    var n = genMoves(0, false); // 必敗的攻擊暗子不在這裡（見 genFrom）
    var root = [], i, j;
    for (i = 0; i < n; i++) root.push(MV[i]);
    if (root.length === 1) {
      out.move = toEngineMove(root[0], legal); out.reason = 'single'; out.ms = now() - t0;
      return out;
    }
    // 同分時的選擇交給種子：先洗牌，再照啟發分數穩定排序
    for (i = root.length - 1; i > 0; i--) { j = E.randInt(rng, i + 1); var tmp = root[i]; root[i] = root[j]; root[j] = tmp; }
    computeVal();
    for (i = 0; i < root.length; i++) MV[i] = root[i];
    scoreMoves(0, root.length, 0);
    for (i = 0; i < root.length; i++) root[i] = MV[i];

    var maxDepth = opts.depth !== undefined ? opts.depth : lv.depth;
    LIMIT = opts.nodes !== undefined ? opts.nodes : lv.nodes;
    HARD_LIMIT = LIMIT * 3 + 20000; // 第一層一定要跑完；萬一第一層就超過這個數才中斷
    DEADLINE = t0 + (opts.timeLimit !== undefined ? opts.timeLimit : DEFAULT_TIME_LIMIT);
    SHOULD_STOP = typeof opts.shouldStop === 'function' ? opts.shouldStop : null;
    NODES = 0; STOPPED = false; STOP_REASON = ''; COMPLETED = 0;
    var bestM = root[0], bestScore = -INF, scores = new Float64Array(root.length);

    for (var d = 1; d <= maxDepth; d++) {
      var alpha = -INF, iterBest = -INF, iterM = 0;
      for (i = 0; i < root.length; i++) {
        var v = moveValue(root[i], d, alpha, INF, 0);
        if (STOPPED) break;
        scores[i] = v;
        if (v > iterBest) { iterBest = v; iterM = root[i]; alpha = v; }
      }
      if (STOPPED) {
        // 這一層沒跑完：第一步（上一層最好的）跑完了，後面跑完又更好的才採用
        if (iterM !== 0 && i > 0 && COMPLETED >= 1) { bestM = iterM; bestScore = iterBest; }
        else if (COMPLETED === 0 && iterM !== 0) { bestM = iterM; bestScore = iterBest; }
        break;
      }
      bestM = iterM; bestScore = iterBest; COMPLETED = d;
      // 下一層照這一層的分數排（穩定）
      var idx = [];
      for (i = 0; i < root.length; i++) idx.push(i);
      idx.sort(function (x, y) { return scores[y] - scores[x] || x - y; });
      var r2 = [], s2 = new Float64Array(root.length);
      for (i = 0; i < idx.length; i++) { r2.push(root[idx[i]]); s2[i] = scores[idx[i]]; }
      root = r2; scores = s2;
      if (opts.onProgress) opts.onProgress({ depth: d, score: bestScore, nodes: NODES, ms: now() - t0, move: toEngineMove(bestM, legal) });
      if (bestScore > MATE_ZONE || bestScore < -MATE_ZONE) break; // 已經算到勝負
      if (NODES >= LIMIT) { STOP_REASON = 'nodes'; break; }
    }
    out.move = toEngineMove(bestM, legal);
    out.score = bestScore === -INF ? 0 : bestScore;
    out.depth = COMPLETED; out.nodes = NODES; out.ms = now() - t0;
    out.reason = STOP_REASON || 'depth';
    STOPPED = false; SHOULD_STOP = null;
    return out;
  }

  function choose(view, opts) { return think(view, opts).move; }

  // ------------------------------------------------------------ 給測試與工具用的內部入口

  // 局面的評估（從輪到的人看）、每種子的天敵數子力、robust＝robustSide()（＋1／−1／0，意思見 robustSide）
  function evaluateView(view, opts) {
    opts = opts || {};
    configure(levelOf(opts.level === undefined ? 6 : opts.level), opts);
    setup(publicPart(view));
    var s = evaluate(), vals = {};
    E.PIECE_CODES.forEach(function (p) { vals[p] = VAL[CODE_OF[p]]; });
    return { score: s, values: vals, material: [MAT[0], MAT[1]], robust: robustSide() };
  }

  // 內部規則鏡像：在公開局面上走一步（機會步要給翻出的子），回傳走完的公開摘要（測試拿來跟引擎逐步核對）
  function mirrorStep(view, move, revealed) {
    configure(levelOf(3), {});
    setup(publicPart(view));
    var m = move.type === 'flip' ? (K_FLIP | (move.sq << 8)) : move.type === 'stop' ? K_STOP :
      ((move.type === 'move' ? K_MOVE : move.type === 'capture' ? K_CAPTURE : K_ATTACK) | (move.from << 3) | (move.to << 8));
    make(m, revealed ? CODE_OF[revealed] : 0);
    return snapshot();
  }
  // 同一次思考裡（置換表不換代）在根局面依序用幾個視窗各搜一次固定深度，回傳每次的值（測試置換表存的界對不對）
  function searchWindows(view, depth, windows, opts) {
    configure(levelOf(6), opts || {});
    setup(publicPart(view));
    NODES = 0; LIMIT = INF; HARD_LIMIT = INF; DEADLINE = INF; STOPPED = false; COMPLETED = 1; SHOULD_STOP = null;
    var out = [];
    for (var i = 0; i < windows.length; i++) out.push(search(depth, windows[i][0], windows[i][1], 0));
    return out;
  }
  // 翻子門檻的「等一手」值與靜態評估（L6 的設定，從輪到的人看）
  function passView(view) {
    configure(levelOf(6), {});
    setup(publicPart(view));
    var st = evaluate();
    return { pass: passValue(-INF, INF, 0), stat: st };
  }
  // 置換表的鍵（L6 的設定；depth＝剩餘深度，決定計數要不要進鍵）
  function ttKeyView(view, depth) {
    configure(levelOf(6), {});
    setup(publicPart(view));
    ttKey(depth);
    return [KEY1, KEY2];
  }
  function mirrorMoves(view) {
    configure(levelOf(3), {});
    setup(publicPart(view));
    GEN_ALL = true;
    var end = genMoves(0, false);
    GEN_ALL = false;
    var out = [];
    for (var i = 0; i < end; i++) out.push(internalKey(MV[i]));
    return out.sort();
  }
  function snapshot() {
    var board = [], pool = {}, c;
    for (var i = 0; i < N; i++) { c = B[i]; board.push(c === 0 ? null : c === HID ? E.HIDDEN : (c > 7 ? E.TYPES[c - 8].toLowerCase() : E.TYPES[c - 1])); }
    for (c = 1; c <= 14; c++) pool[c > 7 ? E.TYPES[c - 8].toLowerCase() : E.TYPES[c - 1]] = BAG[c];
    return { board: board, pool: pool, stm: STM ? 'b' : 'r', chain: CHAIN, quiet: QUIET, result: ['none', 'loss', 'win', 'draw'][RESULT], alive: [ALIVE_COL[0], ALIVE_COL[1]] };
  }

  return {
    LEVELS: LEVELS.map(function (l) {
      var f = {}, k;
      for (k in l.features) f[k] = l.features[k];
      return { id: l.id, name: l.name, algo: l.algo, depth: l.depth, nodes: l.nodes, features: f };
    }),
    DEFAULT_PARAMS: JSON.parse(JSON.stringify(DEFAULT_PARAMS)),
    FEATURE_KEYS: FEATURE_KEYS.slice(),
    WIN: WIN,
    think: think,
    choose: choose,
    _internal: {
      star1: star1, star0: star0, evaluateView: evaluateView, mirrorStep: mirrorStep, mirrorMoves: mirrorMoves, ttKey: ttKeyView,
      passValue: passView, searchWindows: searchWindows, drawSquash: drawSquash, SQUASH_D: SQUASH_D
    }
  };
});
