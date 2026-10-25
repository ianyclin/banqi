/*
 * 暗棋：畫面（第二步 a：可玩原型；第三步 b：接上電腦對手）。對手是「兩人同機」或「電腦」（ai.js，等級 1–6，在 Worker 裡算）。
 * 結構：一個 G（對局狀態）＋幾支 render 函式；文字一律 t()（i18n.js）。第二步 b 要加的帳號、紀錄、分享都還沒有。
 * 第二步 b-1（作者 2026-10-24 定稿）：兩套主題（木與紙／漆器與墨，各有深淺）與設定頁、狀態列移到棋盤下、兩欄一次只顯示「被吃」或「沒翻」。
 * 規則全部交給 engine.js（BanqiEngine）：畫面只問 legalMoves、只用 applyMove 走，不自己判斷能不能吃。
 * 公平：電腦只拿 publicView(state)（沒有暗子身分）；開局排法只在終局後才從棋譜讀出來攤開。
 */
(function () {
  'use strict';
  var E = window.BanqiEngine, I18N = window.I18N, t = I18N.t, AIX = window.BanqiAI, GS = window.BanqiStats;
  function vurl(p) { return typeof window.vurl === 'function' ? window.vurl(p) : p; } // 帶版本號的網址（index.html 的 vurl；單一檔案版沒有就照舊）
  var TEST = window.BANQI_RELEASE !== true && /[?&]test=1(?:&|$)/.test(location.search);
  var HIDDEN = E.HIDDEN;

  function $(id) { return document.getElementById(id); }
  // 認輸鈕（作者 2026-10-24）：兩人同機時上下兩條各有一顆，按自己那顆＝自己認輸（不管輪到誰）；跟電腦下只有下面那條有。
  // 上面那條的右端還有設定與眼睛。renderSide 重畫那條時這兩組按鈕留在原地（不拿下來，焦點不會跑掉）
  var RESIGNS = { bottom: document.getElementById('resignBtn'), top: document.getElementById('resignTopBtn') };
  var SIDE_BTNS = { top: document.getElementById('topBtns'), bottom: document.getElementById('botBtns') };

  // ------------------------------------------------------------ 對局狀態
  var G = {
    page: 'start',
    setup: { mode: 'classic', opponent: 'pvp', drawPlies: 60, first: 'me' },
    state: null,      // 引擎狀態（含暗子身分，只留在記憶體裡）
    me: 0,            // 畫面下方是哪一位（0 先手、1 後手）
    bot: null,        // 電腦是哪一位；兩人同機是 null
    botRng: null,
    sel: null,        // 選中的格子
    path: [],         // 這一步（含連吃）走過的格子
    last: [],         // 上一步走過的格子
    shown: null,
    level: 3,         // 電腦的等級（1–6，ai.js 的 LEVELS）
    thinking: null,   // 電腦在想：{ nodes, depth }（畫在電腦那條）
    aiLog: [],        // 測試用：電腦每一步（只在 ?test=1 時記）
    pid: null,        // 這盤記在哪個帳號（開局時的帳號；接著下時照存的）
    gameTs: 0,        // 開局時間＝紀錄的 ts（去重鍵）
    recAt: null,      // 這個視窗自己記的那一筆紀錄的 at（另一個視窗結束同一盤時分得出來）
    live: false,      // 這盤正在下（會存「接著下」）      // 暫時顯示的棋盤（攻擊暗子：先翻開給你看，再吃）；null＝照 state.board
    busy: false,      // 動畫或電腦在想、在走：不收點擊
    queue: [],        // 攻擊暗子翻開那一下（已經輪到人）點的格子：那一下過了照順序點
    gen: 0,           // 換盤、回首頁時加一，舊的計時器就不會再動
    over: null,       // 結果 { winner, reason }
    revealed: false,  // 終局攤開了沒
    layout: null,     // 開局排法（只在終局後從棋譜讀出來）
    land: false,      // 棋盤橫放（8×4）
    cell: 0,          // 現在的格子大小（px）
    colw: 0,          // 左右兩欄的寬（px）
    intel: true,      // 左右兩欄顯示中；眼睛鈕切換，記在 banqi.settings.v1
    colMode: 'cap',   // 兩欄現在顯示哪一種：'cap' 被吃、'hid' 沒翻。開網頁時＝設定的「欄位預設」；點欄頭兩欄一起換，不記下來
    // 上下兩條各自擠的程度（layoutBoard／remeasureBars 量）：1＝「輪到」小標放到名字下面那一行、2＝名字換短的、
    // 3＝緊湊（間距、顏色標記、設定與眼睛變小）、4＝「吃了 n」收起來（兩欄的被吃還看得到）
    barLevel: { top: 0, bottom: 0 },
    record: null,     // 終局的棋譜（引擎的 encodeRecord；認輸時 app 自己補 [Result]）
    set: null,        // 設定（readSettings()）
    back: null        // 設定頁按「返回」回到哪一頁
  };

  // 時間（毫秒）。測試可以用 __banqiApp.setSpeed(0.05) 調快。
  // later 只用在攻擊暗子時翻開的子停在原地多久、分出勝負後多久出結果卡：都乘設定的動畫速度（「無」也留 1/4，翻出來的子還看得到）
  var MS = { bot: 600, attack: 450, toast: 1800, end: 700, resign: 3000 };
  var speed = 1;
  function later(ms, fn) {
    var gen = G.gen;
    return setTimeout(function () { if (gen === G.gen) fn(); }, ms * speed * Math.max(ANIM[G.set.anim], 0.25));
  }

  // ------------------------------------------------------------ 設定（作者 2026-10-24）：全部記在 banqi.settings.v1（語言由 i18n.js 記在同一個鍵的 lang）
  var SETTINGS_KEY = 'banqi.settings.v1';
  // level＝上次選的電腦等級（開始頁；預設 3 初級）
  var DEFAULTS = { theme: 'wood', scheme: 'auto', font: 'kai', colDefault: 'cap', drawPlies: 60, anim: 'mid', level: 3 };
  var CHOICES = { theme: ['wood', 'lacquer'], scheme: ['auto', 'light', 'dark'], colDefault: ['cap', 'hid'], drawPlies: [30, 40, 50, 60], anim: ['slow', 'mid', 'fast', 'none'], level: [1, 2, 3, 4, 5, 6] };
  // 動畫速度：CSS 的 --anim（所有 transition／animation 的秒數乘它）
  var ANIM = { slow: 1.6, mid: 1, fast: 0.5, none: 0 };
  // 棋子字體：設定頁的選項就是這張表（id 記在設定裡；label 是 i18n 的鍵；stack 放進 CSS 的 --font-piece；weight 放進 --piece-wt；
  // family＝內嵌字型的名字，@font-face 寫在 style.css 最前面，檔案在 fonts/，見 fonts/README.md：每個檔只切了棋子用的 14 個字）。
  // 要加字型：fonts/ 放 woff2、style.css 加一條 @font-face、這裡加一項、i18n.js 加 label 的鍵。隸書／行草這次沒有授權與字數都過的，所以沒有
  var FONTS = [
    { id: 'kai', label: 'font.kai', family: 'Banqi Kai TC', stack: '"Banqi Kai TC", "Kaiti TC", "BiauKai", "Noto Serif TC", "Songti TC", "PingFang TC", serif', weight: 700 },
    { id: 'twkai', label: 'font.twkai', family: 'Banqi TW-Kai', stack: '"Banqi TW-Kai", "Kaiti TC", "BiauKai", "Noto Serif TC", "Songti TC", "PingFang TC", serif', weight: 700 },
    { id: 'song', label: 'font.song', family: 'Banqi Noto Serif', stack: '"Banqi Noto Serif", "Songti TC", "Noto Serif TC", serif', weight: 600 },
    { id: 'hei', label: 'font.hei', family: null, stack: '-apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", "Noto Sans CJK TC", "Microsoft JhengHei", sans-serif', weight: 600 }
  ];
  function fontById(id) {
    for (var i = 0; i < FONTS.length; i++) if (FONTS[i].id === id) return FONTS[i];
    return null;
  }
  function loadSettings() {
    try { var o = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; }
  }
  function saveSettings(patch) {
    var o = loadSettings();
    Object.keys(patch).forEach(function (k) { o[k] = patch[k]; });
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(o)); } catch (e) { /* 存不了就算了 */ }
  }
  // 讀設定：每一項不認得的值都換回預設
  function readSettings() {
    var o = loadSettings(), out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = o[k];
      var ok = k === 'font' ? !!fontById(v) : CHOICES[k].indexOf(v) >= 0;
      out[k] = ok ? v : DEFAULTS[k];
    });
    return out;
  }
  var MQ = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  // 外觀、深淺、棋子字體、動畫速度：放到 <html> 上，馬上生效
  function applyLook() {
    var r = document.documentElement, s = G.set, f = fontById(s.font);
    r.setAttribute('data-theme', s.theme);
    r.setAttribute('data-scheme', s.scheme === 'auto' ? (MQ && MQ.matches ? 'dark' : 'light') : s.scheme);
    r.style.setProperty('--font-piece', f.stack);
    r.style.setProperty('--piece-wt', String(f.weight));
    r.style.setProperty('--anim', String(ANIM[s.anim]));
    var tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.setAttribute('content', getComputedStyle(document.body).backgroundColor);
  }

  // ------------------------------------------------------------ 電腦對手（第三步 b）：ai.js 在 Worker（ai-worker.js）裡算，畫面只送 publicView（沒有暗子身分）。
  // 一般網頁：new Worker('ai-worker.js')（裡面 importScripts engine.js、ai.js）；單一檔案版：inline 時放了 window.BANQI_WORKER_SRC（三支原始碼），接成 Blob 開。
  // new Worker 丟錯（例如 file:// 不給開）或 Worker 載入失敗、算到一半出錯：改在主執行緒算（會卡畫面一下，但棋下得下去）。
  // 取消＝terminate（認輸、回首頁、新局）；下一次要算時再開一個。
  var AI = {
    worker: null, broken: false, id: 0, pending: null,
    test: { nodes: {} }, // 測試小門：把某一級的節點預算調小（{ 6: 3000 }）
    make: function () {
      if (this.worker || this.broken) return this.worker;
      var me = this, src = window.BANQI_WORKER_SRC;
      try {
        this.worker = src ? new Worker(URL.createObjectURL(new Blob(src, { type: 'text/javascript' }))) : new Worker(vurl('ai-worker.js'));
      } catch (e) { this.broken = true; this.worker = null; return null; }
      this.worker.onmessage = function (e) { me.onMessage(e.data || {}); };
      this.worker.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); me.fail(); };
      return this.worker;
    },
    opts: function (level, seed, mode) {
      var o = { level: level, seed: seed, mode: mode };
      if (this.test.nodes[level] !== undefined) o.nodes = this.test.nodes[level];
      return o;
    },
    think: function (view, level, seed, onProgress, onMove) {
      this.pending = { id: ++this.id, view: view, level: level, seed: seed, onProgress: onProgress, onMove: onMove };
      var w = this.make();
      if (!w) { this.runMain(); return; }
      var o = this.opts(level, seed, view.mode), msg = { type: 'think', id: this.pending.id, view: view, level: o.level, seed: o.seed, mode: o.mode };
      if (o.nodes !== undefined) msg.nodes = o.nodes;
      w.postMessage(msg);
    },
    onMessage: function (d) {
      var p = this.pending;
      if (!p || d.id !== p.id) return; // 取消以後才到的舊回覆
      if (d.type === 'progress') { p.onProgress(d); return; }
      if (d.type === 'move') { this.pending = null; p.onMove(d); return; }
      if (d.type === 'error') { console.error('電腦對手出錯：' + d.message); this.fail(); }
    },
    // Worker 用不了：關掉、以後都在主執行緒算，這一步也在主執行緒重算
    fail: function () {
      if (this.worker) { try { this.worker.terminate(); } catch (e) { /* ignore */ } }
      this.worker = null; this.broken = true;
      this.runMain();
    },
    runMain: function () {
      var p = this.pending, me = this;
      if (!p) return;
      setTimeout(function () {
        if (me.pending !== p) return;
        me.pending = null;
        var r;
        try { r = AIX.think(p.view, me.opts(p.level, p.seed, p.view.mode)); }
        catch (e) { console.error('電腦對手出錯：' + e.message); var ms = E.legalMoves(p.view); r = { move: ms[0], depth: 0, nodes: 0, ms: 0, reason: 'error' }; }
        p.onMove(r);
      }, 0);
    },
    cancel: function () {
      this.pending = null;
      if (this.worker) { this.worker.terminate(); this.worker = null; }
    }
  };
  function levelInfo(id) {
    for (var i = 0; i < AIX.LEVELS.length; i++) if (AIX.LEVELS[i].id === id) return AIX.LEVELS[i];
    return AIX.LEVELS[0];
  }

  // ------------------------------------------------------------ 小工具
  function isHuman(p) { return G.bot === null || p !== G.bot; }
  function colorOf(p) { return E.colorOf(p); }
  function isLetter(x) { return typeof x === 'string' && x !== HIDDEN; }
  function rc(sq) { return { c: sq % E.COLS, r: Math.floor(sq / E.COLS) }; }

  function sideName(p) {
    if (G.bot !== null) return p === G.bot ? t('side.bot') : t('side.you');
    var c = G.state.colors[p];
    if (c) return t(c === 'r' ? 'color.rSide' : 'color.bSide');
    return p === G.me ? t('side.bottom') : t('side.top');
  }
  function barName(p) {
    if (G.bot !== null) return p === G.bot ? t('side.bot') : t('side.you');
    return p === G.me ? t('side.bottom') : t('side.top');
  }
  function barKey(p) { return p === G.me ? 'bottom' : 'top'; }
  // 上下兩條上的名字：擠到 level 2（例如英文 320 寬、認輸按了一次）用短的（Bottom／Top）
  function barLabel(p) {
    if (G.barLevel[barKey(p)] >= 2 && G.bot === null) return t(p === G.me ? 'side.bottomShort' : 'side.topShort');
    return barName(p);
  }
  function pieceName(p) { return I18N.pieceName(p, E.NAMES); }

  function findMove(moves, from, to) {
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      if (m.from === from && m.to === to) return m;
    }
    return null;
  }

  // 炮跳吃的炮台：from 和 to 之間唯一的那個子
  function screenOf(b, from, to) {
    var a = rc(from), z = rc(to), dc = Math.sign(z.c - a.c), dr = Math.sign(z.r - a.r);
    var c = a.c + dc, r = a.r + dr;
    while (c !== z.c || r !== z.r) {
      var sq = r * E.COLS + c;
      if (b[sq] !== null) return sq;
      c += dc; r += dr;
    }
    return null;
  }

  // 選中的子能去哪裡：{ sq: 't-move'|'t-cap'|'t-atk' }，炮台另外記
  function targets() {
    var out = { to: {}, screens: {} };
    if (G.sel === null || G.shown || G.over) return out;
    var s = G.state, moves = E.legalMoves(s), isCannon = E.typeOf(s.board[G.sel]) === 'C';
    moves.forEach(function (m) {
      if (m.from !== G.sel) return;
      out.to[m.to] = m.type === 'move' ? 't-move' : m.type === 'capture' ? 't-cap' : 't-atk';
      if (isCannon && m.type !== 'move') {
        var sc = screenOf(s.board, m.from, m.to);
        if (sc !== null) out.screens[sc] = true;
      }
    });
    return out;
  }

  // ------------------------------------------------------------ 棋盤
  var cells = [];
  // 每一格的記號（設計稿 A／B 同一套形狀，顏色看主題）：吃子圈（底下一圈淡色墊著）、攻擊暗子虛線圈、走到空格的點、上一步的四個角。顯示哪個由格子的 class 決定
  var MARKS = '<svg class="mk" viewBox="0 0 54 54" aria-hidden="true" focusable="false"><circle class="u" cx="27" cy="27" r="24.5"/><circle class="cap" cx="27" cy="27" r="24.5"/>' +
    '<circle class="atk" cx="27" cy="27" r="24.5"/><circle class="mv" cx="27" cy="27" r="5.5"/><path class="lst" d="M4 12V4h8M42 4h8v8M50 42v8h-8M12 50H4v-8"/></svg>';

  function buildBoard() {
    var board = $('board');
    for (var sq = 0; sq < E.N; sq++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cell';
      b.setAttribute('data-sq', String(sq));
      b.innerHTML = '<span class="pc"><span class="disc"><span class="back"></span><span class="face"><span class="ch"></span></span></span></span>' + MARKS;
      b._disc = b.querySelector('.disc');
      b._ch = b.querySelector('.ch');
      b._x = undefined;
      b.addEventListener('click', onCellClick);
      board.appendChild(b);
      cells.push(b);
    }
    placeCells();
  }

  // 直式：a1 在左下、d8 在右上（4 欄 8 列）。橫放：1 列在左、8 列在右，a 欄在上（順時針轉 90°）
  function placeCells() {
    cells.forEach(function (b, sq) {
      var p = rc(sq);
      if (G.land) {
        b.style.gridColumn = String(p.r + 1); b.style.gridRow = String(p.c + 1);
        b.classList.toggle('edge-r', p.r === E.ROWS - 1); b.classList.toggle('edge-b', p.c === E.COLS - 1);
      } else {
        b.style.gridColumn = String(p.c + 1); b.style.gridRow = String(E.ROWS - p.r);
        b.classList.toggle('edge-r', p.c === E.COLS - 1); b.classList.toggle('edge-b', p.r === 0);
      }
    });
  }

  // 依可用的寬與高算格子大小（作者 2026-10-24：手機上棋盤和面板要在一個畫面裡、不捲動）。
  // 做法：量 main 現在的總高（含安全區內距、上下兩條、狀態列、面板、間距、棋盤內距），扣掉格子本身的高度＝其他東西的高度；
  // 畫面高度減掉它，再除以列數；寬度扣掉左右兩欄（顯示時）再除以欄數。直式最大 80、橫放最大 96。不到 44 時先換緊湊版（html.tight），還不到 44 才退到 42（最後手段）。
  // 攤開以後（終局、不會再點棋盤）：狀態列收起來，格子可以小到 28，結果條和整個棋盤一定在一個畫面裡
  var MIN_CELL = 44, LAST_CELL = 42, LAST_CELL_REVEALED = 28;
  function fitCell(cols, rows, land) {
    var game = $('game'), main = document.querySelector('main'), cs = getComputedStyle(main);
    var cur = parseFloat(game.style.getPropertyValue('--cell')) || 64;
    var bpad = parseFloat(getComputedStyle(document.querySelector('.board-wrap')).paddingLeft) || 0;
    var hgap = parseFloat(getComputedStyle(document.querySelector('.board-row')).columnGap) || 0;
    G.bpad = bpad; G.hgap = hgap;
    var availW = main.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) - bpad * 2;
    if (G.intel) availW -= 2 * G.colw + 2 * hgap;
    var fixed = main.getBoundingClientRect().height - rows * cur;
    var availH = window.innerHeight - fixed;
    return Math.floor(Math.min(availW / cols, availH / rows, land ? 96 : 80));
  }

  // 量字寬不排版（canvas）：欄頭放不放得下用這個算，每走一步重畫兩欄時不用再量版面
  var mctx = null, BODY_FONT = null;
  function textW(str, font) {
    if (!mctx) mctx = document.createElement('canvas').getContext('2d');
    mctx.font = font;
    return mctx.measureText(str).width;
  }
  function colName(p, short) {
    var k = G.bot !== null ? (p === G.bot ? 'intel.opp' : 'intel.me') : (p === G.me ? 'intel.bottom' : 'intel.top');
    return t(short ? k + 'Short' : k);
  }
  // 兩欄欄頭的版式（兩欄用同一套，欄頭一樣高，兩欄的列才對得齊）：
  //   narrow＝「被吃｜沒翻」並排放不下 → 上下疊；narrowWho＝顏色標記＋名字放不下 → 標記在上、名字在下；
  //   short[id]＝名字自己一行還放不下 → 用短的（英文 Opponent → Opp.）；nmScale[id]＝短的也放不下 → 字縮小（最後手段）
  function colHeadFlags() {
    if (!BODY_FONT) BODY_FONT = getComputedStyle(document.body).fontFamily;
    var headW = G.colw - 6, cg = { narrow: false, narrowWho: false, short: {}, nmScale: {}, split: false, md: 24, stk: 4 };
    var seg = '700 10.5px ' + BODY_FONT, nmf = '700 11.5px ' + BODY_FONT;
    cg.narrow = textW(t('intel.legendCap'), seg) + textW(t('intel.legendHid'), seg) + 12 > headW;
    [['colOpp', 1 - G.me], ['colMe', G.me]].forEach(function (pr) {
      var w = textW(colName(pr[1], false), nmf);
      if (16 + 3 + w > headW) cg.narrowWho = true;
      if (w > headW) {
        cg.short[pr[0]] = true;
        var ws = textW(colName(pr[1], true), nmf);
        if (ws > headW) cg.nmScale[pr[0]] = Math.max(0.6, headW / ws);
      }
    });
    return cg;
  }
  // 小棋子直徑與一疊的位移：w＝放得下的寬、rowH＝一列的高。5 個疊起來（直徑＋4×位移）一定放得進那一列
  function fitStack(w, rowH) {
    var md = Math.min(24, Math.floor(w * 0.48), Math.floor(w - 18));
    md = Math.max(12, Math.min(md, Math.floor(rowH - 10)));
    var stk = Math.max(1, Math.min(4, Math.floor((rowH - 2 - md) / 4)));
    return { md: md, stk: stk };
  }

  // 作者要求的效能寫法：先寫完所有的 CSS 變數與 class，再一次讀，再寫——每次最多三次強制排版（緊湊版四次），每走一步重畫不排版。
  // 實測（2026-10-24，Chrome 無頭、新開一盤、200 次平均）：改之前 375×812 7.7 ms／次、強制排版 5 次，844×390 7.2 ms、3 次；
  // 改之後 375×812 6.7–7.7 ms、4 次（英文要多量一次上下兩條；中文連吃中 3 次），844×390 10.0–10.5 ms、3 次（兩欄排成兩小欄、上下兩條多畫一次，比較慢）。
  // 每走一步的整個重畫：0.2–0.4 ms、0 次強制排版（b01 的 P 段）。視窗大小改了用 requestAnimationFrame 合併成一次。
  function layoutBoard() {
    if (G.page !== 'game') return;
    var game = $('game'), root = document.documentElement, main = document.querySelector('main');
    var revealed = document.body.classList.contains('end-revealed');
    // 讀（一）：畫面寬高、攤開後結果條的高
    var W = root.clientWidth, H = window.innerHeight;
    var card = revealed ? document.querySelector('.end-overlay.revealed .end-card') : null;
    // 結果條底下還有安全區（iPhone 的 34）：留的高度＝畫面底到結果條頂端
    var cardH = card ? Math.ceil(H - card.getBoundingClientRect().top) : 0;
    var land = W > H || W >= 700;
    var cols = land ? E.ROWS : E.COLS, rows = land ? E.COLS : E.ROWS;
    // 寫
    if (land !== G.land) { G.land = land; placeCells(); }
    $('board').classList.toggle('land', land);
    game.style.setProperty('--cols', String(cols));
    game.style.setProperty('--rows', String(rows));
    // 左右兩欄的寬（被吃要放得下一疊小棋子＋×N）：320 寬 46、375 寬 54、400–429 寬 58（設計稿 375 寬是 58），430 以上慢慢加寬到 76
    G.colw = W < 360 ? 46 : W < 400 ? 54 : W < 430 ? 58 : Math.min(76, 60 + Math.floor((W - 430) / 20));
    game.style.setProperty('--colw', G.colw + 'px');
    // 攤開以後：結果條固定在底下，main 的下內距留出它的高度
    main.style.paddingBottom = card ? (cardH + 8) + 'px' : '';
    root.classList.remove('tight');
    game.style.marginTop = '0px';
    // 先把格子縮到一定放得下的大小再量：上一次的格子（或預設 64）太寬時，手機瀏覽器會把整頁縮小，innerHeight 跟著變大，算出來的格子就太大
    game.style.setProperty('--cell', '36px');
    // 讀（二）（緊湊版再讀一次）
    var cell = fitCell(cols, rows, land);
    if (cell < MIN_CELL) { root.classList.add('tight'); cell = fitCell(cols, rows, land); }
    var floor = revealed ? LAST_CELL_REVEALED : LAST_CELL;
    if (cell < floor) cell = floor;
    G.cell = cell;
    // 寫：格子、上下兩條的寬（跟棋盤那一列一樣寬）、兩欄欄頭（字寬算的）、上下兩條先照最擠的情形畫（兩條都有「輪到」）
    game.style.setProperty('--cell', cell + 'px');
    game.style.setProperty('--roww', (cols * cell + 2 * G.bpad + (G.intel ? 2 * G.colw + 2 * G.hgap : 0)) + 'px');
    G.cg = G.intel && G.state ? colHeadFlags() : null;
    if (G.state) {
      G.barLevel = { top: 0, bottom: 0 }; G.measureTag = true;
      renderSide($('sideTop'), 1 - G.me); renderSide($('sideBottom'), G.me);
      // 欄頭的名字換長換短時才重畫兩欄（重畫很花時間）
      var lk = labelKeyOf(G.cg);
      if (G.cg && lk !== G.labelKey) { renderIntelCol($('colOpp'), 1 - G.me); renderIntelCol($('colMe'), G.me); }
      G.labelKey = lk;
      fitIntel();
    }
    // 讀（三）：名字有沒有被切掉、欄頭的高、整頁的高
    var cut = G.state ? barsCut() : null;
    var head = G.cg ? document.querySelector('#colMe .intel-head') : null;
    var headH = head ? head.getBoundingClientRect().height : 0;
    var mainH = main.getBoundingClientRect().height, H2 = window.innerHeight;
    // 寫：上下兩條的最後版式（太擠時「輪到」放到名字下面一行；不改高度）、兩欄的小棋子、多的高度上下平分
    if (G.state) {
      G.measureTag = false;
      settleBars(cut);
    }
    if (G.cg) {
      var inner = cell * rows + 2 * G.bpad - 2, w = G.colw - 4;
      var a = fitStack(w, (inner - headH) / 7), b2;
      // 列太矮（橫放的手機）：七種子排成兩小欄（4＋3），每一列高一點，疊得下 5 個
      if (a.md < 20) { b2 = fitStack(w / 2 - 1, (inner - headH) / 4); if (b2.md > a.md) { a = b2; G.cg.split = true; } }
      G.cg.md = a.md; G.cg.stk = a.stk;
      fitIntel();
    }
    var spare = H2 - mainH;
    if (spare > 1) game.style.marginTop = Math.floor(spare / 2) + 'px';
  }
  // 上下兩條有沒有東西被切掉（讀版面）：名字、紅方／黑方那一行、認輸鈕的字、整條放不下。回傳 { top, bottom }
  function barsCut() {
    function one(el) {
      if (el.scrollWidth > el.clientWidth + 0.5) return true;
      return Array.prototype.some.call(el.querySelectorAll('.who b, .who small, button.resign, .took'), function (e) { return e.offsetParent !== null && e.scrollWidth > e.clientWidth + 0.5; });
    }
    return { top: one($('sideTop')), bottom: one($('sideBottom')) };
  }
  // 照最擠的情形（兩條都有「輪到」）量過一次以後定版式：被切掉的那條一級一級加（每加一級多量一次，只有很窄時才會走到）
  var MAX_BAR_LEVEL = 4;
  function settleBars(cut) {
    var lv = { top: 0, bottom: 0 };
    while (cut.top || cut.bottom) {
      var more = false;
      ['top', 'bottom'].forEach(function (k) { if (cut[k] && lv[k] < MAX_BAR_LEVEL) { lv[k]++; more = true; } });
      if (!more) break;
      G.barLevel = lv; G.measureTag = true;
      renderSide($('sideTop'), 1 - G.me); renderSide($('sideBottom'), G.me);
      cut = barsCut();
    }
    G.barLevel = lv; G.measureTag = false;
    renderSide($('sideTop'), 1 - G.me); renderSide($('sideBottom'), G.me);
  }
  function labelKeyOf(cg) { return cg ? JSON.stringify([cg.short, cg.nmScale, I18N.getLang(), G.bot, G.me]) : null; }
  // 認輸鈕的字換了（按一次、時間到變回來）：上下兩條重量一次
  function remeasureBars() {
    if (!G.state || G.page !== 'game') return;
    G.barLevel = { top: 0, bottom: 0 }; G.measureTag = true;
    renderSide($('sideTop'), 1 - G.me); renderSide($('sideBottom'), G.me);
    settleBars(barsCut());
  }
  // 視窗大小改了：同一個畫格裡只排一次
  var layoutQueued = false;
  function scheduleLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(function () { layoutQueued = false; layoutBoard(); });
  }

  function renderBoard() {
    var s = G.state, b = G.shown || s.board, tg = targets();
    var marks = {};
    (G.path.length ? G.path : G.last).forEach(function (sq) { marks[sq] = true; });
    var markCls = G.path.length ? 'path' : 'last';
    for (var sq = 0; sq < E.N; sq++) {
      var el = cells[sq], x = b[sq], peek = false;
      var disp = x;
      if (x === HIDDEN && G.revealed && G.layout) { disp = G.layout.charAt(sq); peek = true; }
      var cls = ['cell'];
      if (el.classList.contains('edge-r')) cls.push('edge-r');
      if (el.classList.contains('edge-b')) cls.push('edge-b');
      if (el.classList.contains('shake')) cls.push('shake');
      if (disp === null) cls.push('empty');
      else if (isLetter(disp)) cls.push(colorOf(disp));
      if (peek) cls.push('peek');
      if (G.sel === sq && !G.shown) cls.push('sel');
      if (tg.to[sq]) cls.push(tg.to[sq]);
      if (tg.screens[sq]) cls.push('screen');
      if (marks[sq]) cls.push(markCls);
      el.className = cls.join(' ');
      var up = isLetter(disp);
      el._ch.textContent = up ? E.NAMES[disp] : '';
      var prev = el._x;
      if (prev === HIDDEN && up) {
        el._disc.classList.add('up'); // 翻子：照 CSS 的 transition 轉過來（約 250 ms）
      } else if (el._disc.classList.contains('up') !== up) {
        el._disc.style.transition = 'none';
        el._disc.classList.toggle('up', up);
        void el._disc.offsetWidth;
        el._disc.style.transition = '';
      }
      el._x = disp;
      // 讀屏
      var name = E.squareName(sq), label;
      if (disp === null) label = t('cell.empty', { sq: name });
      else if (peek) label = t('cell.peek', { sq: name, piece: pieceName(disp) });
      else if (disp === HIDDEN) label = t('cell.hidden', { sq: name });
      else label = t('cell.piece', { sq: name, piece: pieceName(disp) });
      if (G.sel === sq && !G.shown) label += t('cell.sel');
      if (tg.to[sq] === 't-move') label += t('cell.move');
      else if (tg.to[sq] === 't-cap') label += t('cell.capture');
      else if (tg.to[sq] === 't-atk') label += t('cell.attack');
      if (tg.screens[sq]) label += t('cell.screen');
      if (marks[sq]) label += t('cell.last');
      el.setAttribute('aria-label', label);
    }
  }

  // ------------------------------------------------------------ 上下兩條、狀態、還沒翻的子
  // 小棋子（兩欄用）：col 是 null 時（顏色還沒定）用灰字
  function miniPiece(p, col) {
    var sp = document.createElement('span');
    sp.className = 'mini ' + (col ? colorOf(p) : 'u');
    sp.textContent = E.NAMES[p];
    sp.setAttribute('aria-hidden', 'true');
    return sp;
  }

  // 上下兩條（設計稿）：顏色標記、名字（下面一行寫紅方／黑方）、輪到的那條加「輪到」小標與框（兩人同機時跟著輪到的人上下換）、吃了幾個子、右端的按鈕
  function renderSide(el, p) {
    var s = G.state, col = s.colors[p], on = !G.over && !s.result && s.turn === p; // 分出勝負到結果卡出來之前：哪一條都不框
    var tagOn = on || G.measureTag; // layoutBoard 量寬度時兩條都放小標（最擠的情形）
    var btns = p === G.me ? SIDE_BTNS.bottom : SIDE_BTNS.top, lv = G.barLevel[barKey(p)];
    el.className = 'side' + (p !== G.me ? ' opp' : '') + (on ? ' active' : '');
    el.setAttribute('data-lv', String(lv));
    if (btns.parentNode !== el) el.appendChild(btns);
    while (el.firstChild !== btns) el.removeChild(el.firstChild);
    function add(node) { el.insertBefore(node, btns); return node; }
    var badge = document.createElement('span');
    badge.className = 'badge ' + (col || 'u');
    badge.textContent = col ? (col === 'r' ? E.NAMES.K : E.NAMES.k) : '?';
    badge.setAttribute('role', 'img');
    badge.setAttribute('aria-label', col ? t('color.' + col) : t('color.unknown'));
    add(badge);
    var who = document.createElement('span');
    who.className = 'who';
    var nm = document.createElement('b');
    nm.textContent = barLabel(p);
    var sub = document.createElement('small');
    sub.textContent = col ? t(col === 'r' ? 'color.rSide' : 'color.bSide') : t('color.unknown');
    if (p === G.bot) sub.textContent += t('side.levelSep') + t(levelInfo(G.level).name); // 電腦那條：顏色・等級
    who.appendChild(nm); who.appendChild(sub);
    add(who);
    if (tagOn) {
      var tag = document.createElement('i');
      tag.className = 'turn';
      // 電腦在想：小標改成「思考中…」（量寬度時也照這個比較長的字量）
      tag.textContent = p === G.bot && (G.thinking || G.measureTag) ? t('side.thinking') : t('side.turn');
      // 窄的時候（那條放不下名字＋小標＋吃了幾個＋按鈕）小標放到名字下面那一行（紅方／黑方的後面），名字才不會被切掉
      if (lv >= 1) { sub.appendChild(document.createTextNode(' ')); sub.appendChild(tag); } else add(tag);
    }
    // 吃了幾個子（只有個數；被吃的是哪些子在左右兩欄的「被吃」）
    var n = col ? s.captured.filter(function (x) { return colorOf(x) !== col; }).length : 0;
    var took = document.createElement('span');
    took.className = 'took';
    var parts = t('side.took', { n: '\u0001' }).split('\u0001');
    var num = document.createElement('b');
    num.textContent = String(n);
    took.appendChild(document.createTextNode(parts[0]));
    took.appendChild(num);
    took.appendChild(document.createTextNode(parts[1] || ''));
    took.setAttribute('aria-label', t('side.tookLabel', { name: barName(p), n: n }));
    if (lv < 4) add(took);
    // 電腦在想：那條底下一條細細的進度（已經算的節點數／這一級的節點預算）
    el.classList.toggle('thinking', !!(G.thinking && p === G.bot));
    if (G.thinking && p === G.bot) {
      var bar = document.createElement('span');
      bar.className = 'think-bar';
      bar.setAttribute('aria-hidden', 'true');
      var lvInfo = levelInfo(G.level), frac = lvInfo.nodes ? Math.min(1, G.thinking.nodes / lvInfo.nodes) : 1;
      bar.style.setProperty('--p', frac.toFixed(3));
      add(bar);
    }
  }

  function statusText() {
    var s = G.state;
    if (G.over || s.result) return t('status.over'); // 分出勝負到結果卡出來之前（G.busy）：不寫輪到誰
    if (!isHuman(s.turn)) return t('status.bot');
    if (s.chain) return t('status.chain');
    if (s.colors[0] === null) {
      if (G.bot !== null) return t('status.firstFlipYou');
      return t('status.firstFlipPvp', { name: barName(s.turn) });
    }
    if (G.bot !== null) return t('status.you', { color: t('color.' + s.colors[s.turn]) });
    return t('status.pvp', { side: sideName(s.turn) });
  }

  function renderStatus() {
    var s = G.state;
    var txt = statusText();
    if (G.bot !== null && s.colors[0] === null && s.turn === G.bot) txt = t('status.firstFlipBot');
    if ($('status').textContent !== txt) $('status').textContent = txt;
    $('stopBtn').hidden = !(!G.over && !G.busy && s.chain && isHuman(s.turn));
  }

  // 還沒翻的子：從公開狀態算（每種子的總數 − 盤上的明子 − 被吃的子），跟引擎的 pool 一樣
  function hiddenCounts(view) {
    var n = {};
    E.PIECE_CODES.forEach(function (p) { n[p] = E.COUNT[E.typeOf(p)]; });
    view.board.forEach(function (x) { if (isLetter(x)) n[x]--; });
    view.captured.forEach(function (x) { n[x]--; });
    return n;
  }

  // 棋盤左右兩欄（作者 2026-10-24）：左＝對方、右＝我（兩人同機：左上方、右下方）。一次只顯示一種（G.colMode）：
  //   被吃＝這一色被吃掉的子，同一種疊成一小疊（每個往上錯開 --stk）、兩個以上旁邊寫 ×N，照大小排（帥仕相俥傌炮兵）；沒有的那列是一個虛線空位
  //   沒翻＝這一色還蓋著的子：棋子＋數字，0 的那列變淡
  // 數字都從公開狀態來（pool 與 captured）。顏色還沒定時兩欄都是整副、標「?」。點欄頭兩欄一起換。隱藏時兩欄的內容整個拿掉（不只是看不見）
  function renderIntelCol(el, p) {
    el.textContent = '';
    if (!G.intel) { el.removeAttribute('aria-label'); el.removeAttribute('data-mode'); return; }
    var view = E.publicView(G.state), col = view.colors[p], mode = G.colMode;
    var name = colName(p, false), cg = G.cg || { short: {}, nmScale: {} };
    var modeName = t(mode === 'cap' ? 'col.cap' : 'col.hid'), other = t(mode === 'cap' ? 'col.hid' : 'col.cap');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', t('intel.colLabel', { name: name, color: col ? t('color.' + col) : t('color.unknown'), mode: modeName }));
    el.setAttribute('data-color', col || 'u');
    el.setAttribute('data-mode', mode);
    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'intel-head';
    head.setAttribute('aria-label', t('intel.headLabel', { name: name, mode: modeName, other: other }));
    var who = document.createElement('span');
    who.className = 'who';
    who.setAttribute('aria-hidden', 'true');
    var badge = document.createElement('span');
    badge.className = 'badge ' + (col || 'u');
    badge.textContent = col ? (col === 'r' ? E.NAMES.K : E.NAMES.k) : '?';
    who.appendChild(badge);
    var nmc = document.createElement('span');
    nmc.className = 'nm';
    nmc.textContent = cg.short[el.id] ? colName(p, true) : name;
    if (cg.nmScale[el.id]) nmc.style.fontSize = (11.5 * cg.nmScale[el.id]).toFixed(2) + 'px';
    who.appendChild(nmc);
    var seg = document.createElement('span');
    seg.className = 'seg2';
    seg.setAttribute('aria-hidden', 'true');
    var sc = document.createElement('span'); sc.className = 's-cap'; sc.textContent = t('intel.legendCap');
    var sh = document.createElement('span'); sh.className = 's-hid'; sh.textContent = t('intel.legendHid');
    seg.appendChild(sc); seg.appendChild(sh);
    head.appendChild(who); head.appendChild(seg);
    head.addEventListener('click', toggleColMode);
    el.appendChild(head);
    E.TYPES.forEach(function (T) {
      // 顏色還沒定：整副的數量（每一色都一樣），字用紅方的字、灰色
      var pc = col ? (col === 'r' ? T : T.toLowerCase()) : T;
      var pname = col ? pieceName(pc) : E.NAMES[T];
      var row = document.createElement('div');
      row.setAttribute('data-t', T);
      var n, i, mp;
      if (mode === 'hid') {
        n = col ? view.pool[pc] : E.COUNT[T];
        row.setAttribute('aria-label', t('intel.rowHid', { piece: pname, n: n }));
        mp = miniPiece(pc, col);
        var nh = document.createElement('span'); nh.className = 'n-hid'; nh.textContent = String(n); nh.setAttribute('aria-hidden', 'true');
        row.appendChild(mp); row.appendChild(nh);
      } else {
        n = col ? view.captured.filter(function (x) { return x === pc; }).length : 0;
        row.setAttribute('aria-label', t('intel.rowCap', { piece: pname, n: n }));
        if (n) {
          var st = document.createElement('span');
          st.className = 'n-cap';
          st.setAttribute('aria-hidden', 'true');
          st.style.setProperty('--n', String(n));
          for (i = 0; i < n; i++) { mp = miniPiece(pc, col); mp.style.setProperty('--k', String(i)); st.appendChild(mp); }
          row.appendChild(st);
          if (n >= 2) { var xn = document.createElement('span'); xn.className = 'xn'; xn.textContent = '×' + n; xn.setAttribute('aria-hidden', 'true'); row.appendChild(xn); }
        } else {
          var slot = document.createElement('span'); slot.className = 'slot'; slot.setAttribute('aria-hidden', 'true');
          row.appendChild(slot);
        }
      }
      row.setAttribute('data-n', String(n));
      row.className = 'intel-row' + (n ? '' : ' zero');
      el.appendChild(row);
    });
  }

  // 點欄頭：兩欄一起換「被吃」⇄「沒翻」（只記在 G.colMode，重新開網頁又從設定的「欄位預設」開始）
  function toggleColMode(e) {
    var id = e.currentTarget.parentNode.id, hadFocus = document.activeElement === e.currentTarget;
    G.colMode = G.colMode === 'cap' ? 'hid' : 'cap';
    renderIntel();
    var h = $(id).querySelector('.intel-head');
    if (hadFocus && h) h.focus({ preventScroll: true });
  }

  // 兩欄的細部尺寸：照 layoutBoard 算好的 G.cg 放 class 與 CSS 變數（只寫不讀：每走一步重畫時不會強制排版）
  function fitIntel() {
    if (!G.intel || G.page !== 'game' || !G.state || !G.cg) return;
    var cg = G.cg, game = $('game');
    [$('colOpp'), $('colMe')].forEach(function (el) {
      el.classList.toggle('narrow', cg.narrow);
      el.classList.toggle('narrow-who', cg.narrowWho);
      el.classList.toggle('split', cg.split);
    });
    game.style.setProperty('--md', cg.md + 'px');
    game.style.setProperty('--stk', cg.stk + 'px');
  }

  function renderIntel() {
    var btn = $('intelBtn');
    btn.setAttribute('aria-pressed', G.intel ? 'false' : 'true');
    btn.setAttribute('aria-label', t(G.intel ? 'intel.hide' : 'intel.show'));
    btn.title = t(G.intel ? 'intel.hide' : 'intel.show');
    document.querySelector('.board-row').classList.toggle('no-intel', !G.intel);
    $('colOpp').hidden = !G.intel;
    $('colMe').hidden = !G.intel;
    if (!G.state) return;
    renderIntelCol($('colOpp'), 1 - G.me);
    renderIntelCol($('colMe'), G.me);
    G.labelKey = G.intel ? labelKeyOf(G.cg) : null;
    fitIntel();
  }

  // 情報顯示或隱藏也記在 banqi.settings.v1（intel：shown／hidden）
  function setIntel(on) {
    G.intel = !!on;
    saveSettings({ intel: G.intel ? 'shown' : 'hidden' });
    renderIntel();
    layoutBoard();
  }

  function render() {
    if (!G.state) return;
    renderSide($('sideTop'), 1 - G.me);
    renderSide($('sideBottom'), G.me);
    renderStatus();
    renderBoard();
    renderIntel();
  }

  // ------------------------------------------------------------ 點棋盤
  function shake(sq) {
    var el = cells[sq];
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    setTimeout(function () { el.classList.remove('shake'); }, 320);
  }

  function onCellClick(e) {
    onCell(Number(e.currentTarget.getAttribute('data-sq')));
  }

  function onCell(sq) {
    if (G.page !== 'game' || !G.state || G.over) return;
    var s = G.state;
    if (G.busy) {
      // 攻擊暗子翻開的那一下：狀態列與底下那條已經是走完的樣子（可能已經輪到人），這時點的不能丟掉，記著、那一下過了照順序點。
      // 只收畫面上和走完以後一樣的格子（攻擊成功時起點、終點會變：搖一下）。電腦在想、分出勝負等結果卡：照舊不收
      if (G.shown && !s.result && isHuman(s.turn)) {
        if (G.shown[sq] === s.board[sq]) G.queue.push(sq); else shake(sq);
      }
      return;
    }
    if (!isHuman(s.turn)) return;
    var x = s.board[sq], col = s.colors[s.turn], moves = E.legalMoves(s), m;
    if (s.chain) {
      // 連吃中：點自己這一子＝停；點目標＝接著吃；其他都不行
      if (sq === s.chain.sq) { play({ type: 'stop' }); return; }
      m = findMove(moves, s.chain.sq, sq);
      if (m) play(m); else shake(sq);
      return;
    }
    if (G.sel !== null) {
      m = findMove(moves, G.sel, sq);
      if (m) { play(m); return; }
      if (sq !== G.sel && isLetter(x) && colorOf(x) === col && moves.some(function (mm) { return mm.from === sq; })) { G.sel = sq; render(); return; }
      G.sel = null; render(); // 點別的地方：取消選取（蓋著的子也不會翻，要再點一次）
      return;
    }
    if (x === HIDDEN) { play({ type: 'flip', sq: sq }); return; }
    if (isLetter(x) && col && colorOf(x) === col && moves.some(function (mm) { return mm.from === sq; })) { G.sel = sq; render(); return; }
    shake(sq);
  }

  // 人走一步（翻、走、吃、攻擊、停）
  function play(m) {
    step(m, true);
  }

  // 走一步（人或電腦）。攻擊暗子時先把翻出來的子顯示在原地一下，再吃或停
  function step(m, human) {
    var before = G.state, mover = before.turn;
    var r = E.applyMove(before, m);
    if (!before.chain) G.path = [];
    if (m.type === 'flip') G.path.push(m.sq);
    else if (m.type !== 'stop') { if (!G.path.length) G.path.push(m.from); G.path.push(m.to); }
    G.state = r.state;
    var mid = !!(r.state.chain && r.state.turn === mover);
    if (!mid) { G.last = G.path; G.path = []; }
    G.sel = mid && human ? r.state.chain.sq : null;
    var atk = null;
    r.events.forEach(function (ev) { if (ev.type === 'attack') atk = ev; });
    if (atk) {
      var b = before.board.slice();
      b[atk.to] = atk.revealed;
      G.shown = b;
      G.busy = true;
      render();
      if (!atk.success) toast(t(human ? 'toast.failed' : 'toast.failedBot', { piece: pieceName(atk.revealed) }));
      G.queue = [];
      later(MS.attack, function () {
        G.shown = null; G.busy = false; render(); next();
        // 這一下裡點的格子：照順序點；點到又不收了（又一次攻擊、輪到電腦、分出勝負）剩下的就不要了
        var q = G.queue;
        G.queue = [];
        while (q.length && !G.busy && !G.over) onCell(q.shift());
      });
      return;
    }
    render();
    next();
  }

  // 走完一步之後：分出勝負、輪到電腦、或等人點
  function next() {
    var s = G.state;
    if (!s.result) saveResume(); // 每走一步就存（接著下）
    if (s.result) { G.busy = true; render(); later(MS.end, function () { endGame(s.result); }); return; }
    if (G.bot !== null && s.turn === G.bot) {
      G.busy = true; // 電腦在想：點棋盤沒有反應（也不搖）
      renderStatus();
      botStep();
      return;
    }
    G.busy = false;
    render();
  }

  // 電腦走一步：送 publicView 去算；最少等 max(300 ms, 600 ms × 動畫速度)（連吃一下一下走，跟以前的陪練一樣），算得比較久就照實際的時間
  var MIN_THINK = 300;
  function sameMove(a, b) { return a.type === b.type && a.sq === b.sq && a.from === b.from && a.to === b.to; }
  function botStep() {
    var gen = G.gen, t0 = Date.now(), view = E.publicView(G.state); // 電腦只看得到公開狀態
    var minMs = Math.max(MIN_THINK, MS.bot * Math.max(ANIM[G.set.anim], 0.25)) * speed;
    G.thinking = { nodes: 0, depth: 0 };
    renderSide(sideEl(G.bot), G.bot);
    AI.think(view, G.level, E.randInt(G.botRng, 0x7fffffff), function (pr) {
      if (gen !== G.gen || !G.thinking) return;
      G.thinking.nodes = pr.nodes; G.thinking.depth = pr.depth;
      renderSide(sideEl(G.bot), G.bot);
    }, function (r) {
      if (gen !== G.gen) return;
      setTimeout(function () {
        if (gen !== G.gen) return;
        G.thinking = null;
        var legal = E.legalMoves(G.state), m = null;
        for (var i = 0; i < legal.length; i++) if (r.move && sameMove(legal[i], r.move)) { m = legal[i]; break; }
        if (TEST) G.aiLog.push({ move: r.move, legal: !!m, chain: !!G.state.chain, at: Date.now(), ms: r.ms, depth: r.depth, nodes: r.nodes, reason: r.reason, level: G.level });
        if (!m) { console.error('電腦選的步不合法：' + JSON.stringify(r.move)); m = legal[0]; }
        step(m, false);
      }, Math.max(0, minMs - (Date.now() - t0)));
    });
  }
  function sideEl(p) { return p === G.me ? $('sideBottom') : $('sideTop'); }

  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.hidden = true; }, MS.toast * Math.max(speed, 0.2));
  }

  // ------------------------------------------------------------ 開局、結束
  function startGame(o) {
    G.gen++;
    // 這盤的設定（「再來一盤」照這個開；只有測試小門會帶的 layout、seed 不留）
    G.setup = { mode: o.mode, opponent: o.opponent, drawPlies: o.drawPlies, first: o.first, level: o.level };
    var first = o.first === 'random' ? (E.randInt(E.defaultRng(), 2) === 0 ? 'me' : 'opp') : o.first;
    G.me = first === 'opp' ? 1 : 0;
    G.bot = o.opponent === 'bot' ? 1 - G.me : null;
    G.level = Number(o.level) || G.set.level;
    AI.cancel(); // 新局：上一盤還在算的丟掉
    G.thinking = null;
    var opts = { mode: o.mode, drawPlies: o.drawPlies };
    if (o.layout) opts.layout = o.layout; // 只有測試小門會傳
    else if (o.seed != null) opts.rng = E.makeRng(o.seed);
    G.state = E.newGame(opts);
    G.botRng = o.botSeed != null ? E.makeRng(o.botSeed) : E.defaultRng();
    G.sel = null; G.path = []; G.last = []; G.shown = null; G.busy = false;
    G.over = null; G.revealed = false; G.layout = null; G.record = null;
    if (G.live) clearResume(G.gameTs); // 上一盤還沒下完就開新的：那一盤的「接著下」丟掉
    G.gameTs = Date.now(); G.recAt = null; G.pid = me().id; G.live = true;
    disarmResign();
    RESIGNS.top.hidden = G.bot !== null; // 跟電腦下：上面那條沒有認輸
    $('endOverlay').hidden = true;
    $('endOverlay').classList.remove('revealed');
    document.body.classList.remove('end-revealed');
    $('toast').hidden = true;
    cells.forEach(function (el) { el._x = undefined; });
    showPage('game');
    render();
    layoutBoard();
    next();
  }

  function endGame(res) {
    G.gen++;
    G.over = res;
    G.busy = false;
    G.sel = null;
    // 終局才讀開局排法（棋譜的 Layout）；對局中不放在任何看得到的地方
    // 終局的棋譜：引擎寫 [Result "<贏的那一位：first／second>" "<原因>"]；認輸也是引擎的終局（applyResign），decodeRecord 讀得回來
    var rec = E.encodeRecord(G.state);
    var m = /\[Layout "([^"]+)"\]/.exec(rec);
    G.layout = m ? m[1] : null;
    G.record = rec;
    // 記紀錄（第二步 b-2）：先清「接著下」再記；同一盤在別的視窗已經記過就不記
    G.live = false;
    clearResume(G.gameTs);
    G.lastRec = recordGame(res);
    $('toast').hidden = true;
    render();
    renderEnd();
    $('endOverlay').hidden = false;
    $('againBtn').focus();
  }

  function renderEnd() {
    var res = G.over;
    if (!res) return;
    var title, reason, loser = res.winner === null ? null : 1 - res.winner;
    if (res.winner === null) title = t('end.draw');
    else if (G.bot !== null) title = res.winner === G.bot ? t('end.youLose') : t('end.youWin');
    else title = t('end.sideWins', { side: sideName(res.winner) });
    if (res.reason === 'noPieces') reason = t('end.noPieces', { loser: sideName(loser) });
    else if (res.reason === 'noMoves') reason = t('end.noMoves', { loser: sideName(loser) });
    else if (res.reason === 'resign') reason = t('end.resign', { loser: barName(loser) }); // 上方玩家認輸／下方玩家認輸（跟電腦下：你認輸）
    else if (res.reason === 'drawPlies') reason = t('end.drawPlies', { n: G.state.drawPlies });
    else reason = t('end.repetition');
    $('endTitle').textContent = title;
    $('endReason').textContent = reason;
    var lr = G.lastRec, pr = lr ? GS.profile(lr.pid) : null;
    $('endRecord').hidden = !lr;
    if (lr) $('endRecord').textContent = t('end.recorded', { name: pr ? pr.name : '', line: recLine(lr) });
    $('endRevealNote').hidden = !G.revealed;
  }

  function reveal() {
    if (!G.over || !G.layout) return;
    G.revealed = true;
    $('endOverlay').classList.add('revealed');
    document.body.classList.add('end-revealed');
    renderEnd();
    renderBoard();
    layoutBoard(); // 面板收起、結果條佔下面的位置
    $('againBtn').focus({ preventScroll: true });
    // 結果條壓到棋盤時，把頁面往上捲，讓整個棋盤露在結果條上面
    var card = document.querySelector('.end-card').getBoundingClientRect(), bd = $('board').getBoundingClientRect();
    if (bd.bottom > card.top - 8) window.scrollBy(0, Math.min(bd.bottom - card.top + 8, bd.top));
  }

  // 認輸（作者 2026-10-24）：手指或滑鼠要「長按」約 1 秒（照動畫速度，最短 0.6 秒），按的時候鈕上有進度；早放開＝沒事＋提示「長按才會認輸」；
  // 按著移出鈕外、捲動、系統取消＝沒事。鍵盤（Enter／Space）與讀屏照舊按兩次（3 秒內），第一次會念「再按一次認輸」。
  // 每一顆各自算，按了一顆不會動到另一顆
  var resignArmed = { top: false, bottom: false }, resignTimer = { top: null, bottom: null };
  var HOLD_MS = 1000, HOLD_MIN = 600;
  var hold = { top: null, bottom: null }; // 長按中：{ id: pointerId, timer }
  function holdMs() { return Math.max(HOLD_MIN, HOLD_MS * ANIM[G.set.anim]); }
  function disarmResign(k) {
    if (!k) { disarmResign('top'); disarmResign('bottom'); return; }
    var was = resignArmed[k];
    resignArmed[k] = false;
    clearTimeout(resignTimer[k]);
    RESIGNS[k].textContent = t('game.resign');
    RESIGNS[k].setAttribute('aria-label', t('game.resignLabel'));
    if (was) remeasureBars();
  }
  // 鍵盤與讀屏：按兩次
  function onResign(k) {
    if (G.over || !G.state) return;
    if (k === 'top' && G.bot !== null) return; // 跟電腦下：上面那條沒有認輸
    if (!resignArmed[k]) {
      resignArmed[k] = true;
      RESIGNS[k].textContent = t('game.resignConfirm');
      RESIGNS[k].setAttribute('aria-label', t('game.resignConfirm'));
      $('srLive').textContent = t('game.resignConfirm'); // 讀屏念出來
      remeasureBars(); // 字變長了（中文「再按一次認輸」）：那條放不下時一級一級收
      resignTimer[k] = setTimeout(function () { disarmResign(k); }, MS.resign);
      return;
    }
    doResign(k);
  }
  function holdStart(k, e) {
    if (G.over || !G.state || (k === 'top' && G.bot !== null)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var btn = RESIGNS[k];
    btn._ptr = Date.now();
    // 觸控預設會把指標抓在按下去的元素上，移出去也收不到 pointerleave：放掉，才知道手指離開了鈕
    if (btn.hasPointerCapture && btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId);
    holdCancel(k);
    var ms = holdMs();
    btn.style.setProperty('--hold', ms + 'ms');
    btn.classList.add('holding');
    hold[k] = { id: e.pointerId, timer: setTimeout(function () { hold[k] = null; btn.classList.remove('holding'); if (!G.over && G.state) doResign(k); }, ms) };
  }
  function holdCancel(k, hint) {
    var h = hold[k];
    if (!h) return;
    clearTimeout(h.timer);
    hold[k] = null;
    RESIGNS[k].classList.remove('holding');
    if (hint) toast(t('game.holdHint'));
  }
  function doResign(k) {
    holdCancel('top'); holdCancel('bottom');
    disarmResign();
    AI.cancel(); G.thinking = null; // 電腦還在想就停掉
    // 按的是哪一條，就是那一條的人認輸（跟電腦下只有下面那條＝你）
    var loser = k === 'bottom' ? G.me : 1 - G.me;
    G.shown = null;
    G.state = E.applyResign(G.state, loser).state; // 引擎的認輸：state.result＝{ winner, winnerColor, reason: 'resign' }
    endGame(G.state.result);
  }

  // ------------------------------------------------------------ 頁面
  function showPage(name) {
    G.page = name;
    $('start').hidden = name !== 'start';
    $('game').hidden = name !== 'game';
    $('settings').hidden = name !== 'settings';
    $('records').hidden = name !== 'records';
    $('profiles').hidden = name !== 'profiles';
    document.body.setAttribute('data-page', name);
    if (name === 'start') {
      G.gen++;
      AI.cancel(); G.thinking = null;
      $('endOverlay').hidden = true;
      document.body.classList.remove('end-revealed');
      $('toast').hidden = true;
    }
    if (name !== 'game') document.querySelector('main').style.paddingBottom = '';
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------ 確認框（第二步 b-2）：buttons＝[{ label, primary, danger, focus, onClick }]
  var dialogReturn = null;
  function showDialog(msg, buttons) {
    $('dialogMsg').textContent = msg;
    var box = $('dialogBtns'), focusEl = null;
    box.textContent = '';
    buttons.forEach(function (b) {
      var el = document.createElement('button');
      el.type = 'button';
      el.className = (b.primary ? 'good' : 'secondary') + (b.danger ? ' danger' : '');
      el.textContent = b.label;
      el.addEventListener('click', function () { hideDialog(); if (b.onClick) b.onClick(); });
      box.appendChild(el);
      if (b.focus || (b.primary && !focusEl)) focusEl = el;
    });
    dialogReturn = document.activeElement;
    $('dialog').hidden = false;
    (focusEl || box.lastChild).focus();
  }
  function hideDialog() {
    $('dialog').hidden = true;
    if (dialogReturn && dialogReturn.focus && dialogReturn.getClientRects().length) dialogReturn.focus();
    dialogReturn = null;
  }

  // ------------------------------------------------------------ 帳號（第二步 b-2；照五子棋的帳號頁：換、加、改名、刪除要確認）
  function me() { return GS.current() || GS.profileList()[0]; }
  function renderProfileBtn() {
    var p = me();
    $('profileName').textContent = p ? p.name : '';
    $('profileBtn').setAttribute('aria-label', t('profile.btnLabel', { name: p ? p.name : '' }));
  }
  var profEditing = null; // null＝沒在編；''＝新增；帳號 id＝改名
  function renderProfiles() {
    var ul = $('profList'), list = GS.profileList(), cur = me().id, games = GS.loadGames();
    ul.textContent = '';
    list.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'prof-row' + (p.id === cur ? ' current' : '');
      li.setAttribute('data-pid', p.id);
      var info = document.createElement('div');
      info.className = 'prof-info';
      var nm = document.createElement('b'); nm.className = 'prof-name'; nm.textContent = p.name;
      var sub = document.createElement('small');
      sub.textContent = t('profiles.games', { n: games.filter(function (g) { return g.pid === p.id; }).length });
      info.appendChild(nm); info.appendChild(sub);
      li.appendChild(info);
      var acts = document.createElement('div');
      acts.className = 'prof-acts';
      function btn(cls, label, fn) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = cls; b.textContent = label;
        b.addEventListener('click', fn);
        acts.appendChild(b);
        return b;
      }
      if (p.id === cur) { var tag = document.createElement('span'); tag.className = 'prof-cur'; tag.textContent = t('profiles.current'); acts.appendChild(tag); }
      else btn('good prof-use', t('profiles.use'), function () { GS.setCurrent(p.id); afterProfileChange(); $('profBack').focus(); });
      btn('secondary prof-rename', t('profiles.rename'), function () { openProfForm(p.id); });
      var del = btn('secondary danger prof-del', t('profiles.delete'), function () {
        showDialog(t('profiles.deleteAsk', { name: p.name }), [
          { label: t('profiles.cancel'), focus: true },
          { label: t('profiles.deleteYes'), danger: true, onClick: function () { GS.deleteProfile(p.id); afterProfileChange(); $('profBack').focus(); } }
        ]);
      });
      del.disabled = list.length <= 1;
      li.appendChild(acts);
      ul.appendChild(li);
    });
    $('profAdd').disabled = list.length >= GS.MAX_PROFILES;
    $('profNote').textContent = t('profiles.note', { max: GS.MAX_PROFILES });
  }
  function afterProfileChange() {
    renderProfileBtn();
    if (G.page === 'profiles') renderProfiles();
    if (G.page === 'records') renderRecords();
  }
  function openProfForm(id) {
    profEditing = id;
    var p = id ? GS.profile(id) : null;
    $('profFormTitle').textContent = p ? t('profiles.formRename', { name: p.name }) : t('profiles.formAdd');
    $('profNameInput').value = p ? p.name : t('profile.newName', { n: GS.profileList().length + 1 });
    $('profForm').hidden = false;
    $('profAdd').hidden = true;
    $('profNameInput').focus();
    $('profNameInput').select();
  }
  function closeProfForm() {
    profEditing = null;
    $('profForm').hidden = true;
    $('profAdd').hidden = false;
  }
  function openProfiles() { closeProfForm(); showPage('profiles'); renderProfiles(); $('profBack').focus({ preventScroll: true }); }

  // ------------------------------------------------------------ 紀錄（第二步 b-2；照五子棋的紀錄頁：表格、最近的盤）
  function levelName(lv) { return t(levelInfo(lv).name); }
  function whenText(at) {
    var d = new Date(at), now = new Date(), hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    var day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (at >= day0) return t('when.today', { hm: hm });
    if (at >= day0 - 86400000) return t('when.yesterday', { hm: hm });
    return t('when.date', { m: d.getMonth() + 1, d: d.getDate(), hm: hm });
  }
  function recLine(g) {
    return t('records.line', {
      opp: g.opp === 'pvp' ? t('records.pvp') : t('records.oppAi', { level: levelName(g.level) }),
      color: g.color ? t(g.color === 'r' ? 'color.rSide' : 'color.bSide') : t('color.unknown'),
      result: t('res.' + g.result), reason: t('reason.' + g.reason), n: g.plies
    });
  }
  function recordGame(res) {
    if (!G.gameTs || !G.pid) return null;
    var ex = GS.find(G.gameTs);
    if (ex && ex.at !== G.recAt) return null; // 同一盤在別的視窗已經記過
    var rec = {
      ts: G.gameTs, at: Date.now(), pid: G.pid, mode: G.state.mode, opp: G.bot !== null ? 'ai' : 'pvp', level: G.bot !== null ? G.level : null,
      color: G.state.colors[G.me] || null, result: res.winner === null ? 'draw' : res.winner === G.me ? 'win' : 'loss',
      reason: res.reason, plies: G.state.ply, drawPlies: G.state.drawPlies
    };
    if (!GS.upsert(rec)) return null;
    G.recAt = rec.at;
    return rec;
  }
  function cellEl(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function renderRecords() {
    var p = me(), mode = (document.querySelector('input[name="recMode"]:checked') || {}).value || 'classic';
    $('recWho').textContent = t('records.of', { name: p.name });
    var list = GS.loadFor(p.id), sm = GS.summary(list)[mode], body = $('recBody');
    body.textContent = '';
    if (!sm.total.n) { body.appendChild(cellEl('p', 'note rec-empty', t('records.empty'))); return; }
    function pct(r) { var v = GS.winRate(r); return v === null ? '—' : Math.round(v * 100) + '%'; }
    var tb = cellEl('table', 'rec-table'), th = cellEl('tr');
    ['records.opp', 'records.n', 'records.w', 'records.d', 'records.l', 'records.rate'].forEach(function (k) { th.appendChild(cellEl('th', null, t(k))); });
    tb.appendChild(th);
    function row(label, r, cls) {
      var tr = cellEl('tr', cls);
      tr.appendChild(cellEl('th', null, label));
      [r.n, r.w, r.d, r.l].forEach(function (v) { tr.appendChild(cellEl('td', null, String(v))); });
      tr.appendChild(cellEl('td', null, pct(r)));
      tb.appendChild(tr);
    }
    // 對手那一欄只寫等級的名字（表頭已經是「對手」；手機上一列一行）
    GS.LEVELS.forEach(function (lv) { if (sm.rows[lv].n) row(levelName(lv), sm.rows[lv], 'lv' + lv); });
    if (sm.rows.pvp.n) row(t('records.pvp'), sm.rows.pvp, 'pvp');
    row(t('records.total'), sm.total, 'total');
    body.appendChild(tb);
    if (sm.rows.pvp.n) body.appendChild(cellEl('p', 'note', t('records.pvpNote')));
    // 結束原因、最近的盤：收起來（點開才看），手機上整頁一個畫面
    function more(key, title) {
      var d = cellEl('details', 'card rec-more');
      d.id = 'recMore-' + key;
      d.open = !!recOpen[key];
      d.addEventListener('toggle', function () { recOpen[key] = d.open; });
      d.appendChild(cellEl('summary', null, title));
      body.appendChild(d);
      return d;
    }
    var dr = more('reasons', t('records.reasonHead'));
    var tr2 = cellEl('table', 'rec-table rec-reasons'), h2 = cellEl('tr');
    h2.appendChild(cellEl('th', null, ''));
    ['records.w', 'records.d', 'records.l'].forEach(function (k) { h2.appendChild(cellEl('th', null, t(k))); });
    tr2.appendChild(h2);
    GS.REASONS.forEach(function (rk) {
      var r = sm.reasons[rk];
      if (!(r.w + r.d + r.l)) return;
      var tr = cellEl('tr', 'r-' + rk);
      tr.appendChild(cellEl('th', null, t('reason.' + rk)));
      [r.w, r.d, r.l].forEach(function (v) { tr.appendChild(cellEl('td', null, String(v))); });
      tr2.appendChild(tr);
    });
    dr.appendChild(tr2);
    var dl = more('recent', t('records.recent'));
    var ul = cellEl('ul', 'rec-recent');
    list.filter(function (g) { return g.mode === mode; }).sort(function (a, b) { return GS.timeOf(b) - GS.timeOf(a); }).slice(0, 10).forEach(function (g) {
      var li = cellEl('li', 'res-' + g.result);
      li.appendChild(cellEl('span', 'rec-when', whenText(GS.timeOf(g))));
      li.appendChild(cellEl('span', 'rec-line', recLine(g)));
      ul.appendChild(li);
    });
    dl.appendChild(ul);
  }
  var recOpen = { reasons: false, recent: false };
  function openRecords() { showPage('records'); renderRecords(); $('recBack').focus({ preventScroll: true }); }

  // ------------------------------------------------------------ 接著下（第二步 b-2；照五子棋的 gomoku.resume.v1）
  // 下到一半的盤每走一步就整盤存在 banqi.resume.v1（這台裝置一份），網頁被收掉前（pagehide）、切到背景時再存一次。
  // 要接著下一定要有開局排法（暗子是什麼），所以存的是引擎的棋譜（encodeRecord：Layout＋每一步，連吃中最後有 +）——
  //   稍微打亂（XOR＋base64，不是加密，只是不讓人一眼看出排法），只在 localStorage，不放進 DOM；接著下以後電腦照樣只拿 publicView。
  // 兩個視窗：存檔帶這個視窗的 tab 與心跳 beat（每 4 秒；pagehide／切到背景時放掉＝0）。開網頁時存檔的心跳還新（12 秒內）、又是別的視窗的
  //   ＝那個視窗還在下，不問。另一個視窗接手（存檔的 tab 變了）或已經結束（紀錄裡同一個 ts 的 at 不是這裡記的）：這裡停下來、跟你說一聲（五子棋 recAt 的做法）。
  var RESUME_KEY = 'banqi.resume.v1', TAB_ID = 't' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
  var BEAT_MS = 4000, STALE_MS = 12000, OBK = 'banqi-resume-v1';
  function ob(str) {
    var out = '';
    for (var i = 0; i < str.length; i++) out += String.fromCharCode(str.charCodeAt(i) ^ OBK.charCodeAt(i % OBK.length));
    return btoa(out);
  }
  function unob(b64) {
    var raw = atob(b64), out = '';
    for (var i = 0; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) ^ OBK.charCodeAt(i % OBK.length));
    return out;
  }
  function readResumeRaw() {
    try { var o = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null'); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (e) { return null; }
  }
  function clearResume(ts) {
    var cur = readResumeRaw();
    if (ts != null && cur && cur.ts !== ts) return; // 存的是別的盤（另一個視窗在下）：不動
    try { localStorage.removeItem(RESUME_KEY); } catch (e) { /* 無 */ }
  }
  // claim＝接著下的那一刻：把存檔認領成這個視窗的（不看存檔原本是哪個視窗的）
  function saveResume(release, claim) {
    if (!G.live || !G.state || G.over) return;
    if (!G.state.history.length && !G.state.chain) { clearResume(G.gameTs); return; } // 還沒走第一步：沒東西好接
    var cur = readResumeRaw();
    if (!claim && cur && cur.ts === G.gameTs && cur.tab !== TAB_ID) { stopHere('resume.taken'); return; }
    var now = Date.now(), su = {};
    Object.keys(G.setup).forEach(function (k) { su[k] = G.setup[k]; });
    var o = { v: 1, ts: G.gameTs, at: now, beat: release ? 0 : now, tab: TAB_ID, recAt: G.recAt, pid: G.pid, setup: su,
      me: G.me, bot: G.bot, level: G.level, last: G.last.slice(), x: ob(E.encodeRecord(G.state)) };
    try { localStorage.setItem(RESUME_KEY, JSON.stringify(o)); } catch (e) { /* 存不下就算了 */ }
  }
  // 讀存檔：壞掉、版本不對、帳號刪了、等級不對、棋譜重下不起來、已經分出勝負＝靜靜丟掉。另一個視窗正在下＝{ busy: true }（不問、不丟）
  function readResume() {
    var o = readResumeRaw();
    if (!o) return null;
    var ok = o.v === 1 && typeof o.ts === 'number' && typeof o.x === 'string' && GS.profile(o.pid) && (o.me === 0 || o.me === 1) &&
      (o.bot === null || o.bot === 1 - o.me) && (o.bot === null || [1, 2, 3, 4, 5, 6].indexOf(o.level) >= 0) && o.setup && typeof o.setup === 'object';
    var st = null;
    if (ok) { try { st = E.decodeRecord(unob(o.x)); } catch (e) { st = null; } }
    if (!st || st.result) { clearResume(); return null; }
    if (o.tab !== TAB_ID && o.beat && Date.now() - o.beat < STALE_MS) return { busy: true };
    return { o: o, state: st };
  }
  function offerResume() {
    var r = readResume();
    if (!r || r.busy) return false;
    var o = r.o, pr = GS.profile(o.pid), other = pr && pr.id !== me().id;
    var who = o.bot !== null ? t('records.oppAi', { level: levelName(o.level) }) : t('records.pvp');
    var p = { who: who, mode: t(r.state.mode === 'chain' ? 'mode.chain' : 'mode.classic'), n: r.state.ply, when: whenText(o.at), name: other ? pr.name : '' };
    showDialog(t(other ? 'resume.askOther' : 'resume.ask', p), [
      { label: t('resume.no'), onClick: function () { clearResume(o.ts); } },
      { label: t('resume.yes'), primary: true, onClick: function () { resumeGame(r); } }
    ]);
    return true;
  }
  function resumeGame(r) {
    var o = r.o;
    G.gen++;
    AI.cancel(); G.thinking = null;
    ['mode', 'opponent', 'first', 'level'].forEach(function (k) { if (o.setup[k] != null) check(k, o.setup[k]); });
    readSetup(); // 開始頁的等級卡、兩人同機的說明跟著剛勾的那一項（回首頁才看得到）；readSetup 不存設定、不改 G.set
    G.setup = o.setup; // 這一盤的設定照存檔（readSetup 讀到的平手步數是開始頁現在的，不是這一盤的）
    G.me = o.me; G.bot = o.bot; G.level = o.bot !== null ? o.level : G.set.level;
    G.state = r.state;
    G.botRng = E.defaultRng();
    G.sel = G.state.chain && isHuman(G.state.turn) ? G.state.chain.sq : null;
    G.path = G.state.chain ? [G.state.chain.sq] : [];
    G.last = Array.isArray(o.last) ? o.last.filter(function (q) { return q === (q | 0) && q >= 0 && q < E.N; }) : [];
    G.shown = null; G.busy = false; G.over = null; G.revealed = false; G.layout = null; G.record = null; G.lastRec = null;
    G.gameTs = o.ts; G.recAt = typeof o.recAt === 'number' ? o.recAt : null; G.pid = o.pid; G.live = true;
    disarmResign();
    RESIGNS.top.hidden = G.bot !== null;
    $('endOverlay').hidden = true;
    $('endOverlay').classList.remove('revealed');
    document.body.classList.remove('end-revealed');
    cells.forEach(function (el) { el._x = undefined; });
    showPage('game');
    render();
    layoutBoard();
    saveResume(false, true); // 這個視窗接手（存檔的 tab 換成這裡）
    next();
  }
  // 另一個視窗接手或結束了這盤：這裡停下來
  function stopHere(key) {
    if (!G.live) return;
    G.live = false;
    G.gen++;
    AI.cancel(); G.thinking = null;
    G.busy = true; // 棋盤不能再點
    if (G.page === 'game') render();
    showDialog(t(key), [{ label: t('resume.toHome'), primary: true, onClick: function () { showPage('start'); } }]);
  }
  window.addEventListener('storage', function (e) {
    if (!G.live) return;
    if (e.key === RESUME_KEY || e.key === null) {
      var cur = readResumeRaw();
      if (cur && cur.ts === G.gameTs && cur.tab !== TAB_ID) stopHere('resume.taken');
    }
    if (e.key === GS.GKEY || e.key === null) {
      var ex = GS.find(G.gameTs);
      if (ex && ex.at !== G.recAt) stopHere('resume.endedElsewhere');
    }
  });
  window.addEventListener('pagehide', function () { saveResume(true); });
  document.addEventListener('visibilitychange', function () { saveResume(document.visibilityState === 'hidden'); });
  setInterval(function () { if (G.live && document.visibilityState === 'visible') saveResume(); }, BEAT_MS);

  // ------------------------------------------------------------ 設定頁：開始頁與對局頁都進得來；對局頁進來時對局照走（電腦照想、照下、計時器不停），回去時原封不動
  function openSettings(e) {
    if (G.page !== 'settings') G.back = G.page;
    G.backBtn = e && e.currentTarget ? e.currentTarget.id : null;
    syncSettingsForm();
    showPage('settings');
    $('setBack').focus({ preventScroll: true });
  }
  function closeSettings() {
    if (G.back === 'game' && G.state) {
      showPage('game');
      render(); renderEnd(); layoutBoard();
    } else showPage('start');
    var b = G.backBtn && $(G.backBtn);
    if (b && b.getClientRects().length) b.focus({ preventScroll: true });
  }

  // 設定頁的棋子字體選項：照 FONTS 表產生（每一項的字樣用它自己的字型）
  function buildFontSeg() {
    var seg = $('fontSeg');
    seg.textContent = '';
    FONTS.forEach(function (f) {
      var lab = document.createElement('label');
      var inp = document.createElement('input');
      inp.type = 'radio'; inp.name = 'font'; inp.value = f.id;
      var sp = document.createElement('span');
      var b = document.createElement('b');
      b.setAttribute('data-i18n', f.label);
      b.textContent = t(f.label);
      var sample = document.createElement('span');
      sample.className = 'sample';
      sample.setAttribute('aria-hidden', 'true');
      sample.textContent = E.NAMES.K + E.NAMES.R + E.NAMES.k + E.NAMES.c;
      sample.style.fontFamily = f.stack;
      sample.style.fontWeight = String(f.weight);
      sp.appendChild(b); sp.appendChild(sample);
      lab.appendChild(inp); lab.appendChild(sp);
      seg.appendChild(lab);
    });
  }

  function check(name, value) {
    var el = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
    if (el) el.checked = true;
  }
  function syncSettingsForm() {
    var s = G.set;
    check('theme', s.theme); check('scheme', s.scheme); check('font', s.font); check('colDefault', s.colDefault);
    check('setDrawPlies', s.drawPlies); check('anim', s.anim); check('lang', I18N.getLang());
  }

  // 改一項設定：記下來、馬上套用
  function setSetting(k, v) {
    G.set[k] = v;
    var patch = {};
    patch[k] = v;
    saveSettings(patch);
    if (k === 'theme' || k === 'scheme' || k === 'font' || k === 'anim') applyLook();
    else if (k === 'colDefault') { G.colMode = v; renderIntel(); }
    else if (k === 'drawPlies') { check('drawPlies', v); check('setDrawPlies', v); readSetup(); } // 開始頁那一組和這裡是同一個設定；這一盤不變，下一盤才用
  }
  function onSettingInput(e) {
    var el = e.target, v = el.value;
    if (el.name === 'lang') { I18N.setLang(v); applyLang(); return; }
    if (el.name === 'setDrawPlies') { setSetting('drawPlies', Number(v)); return; }
    setSetting(el.name, v);
  }

  function readSetup() {
    function val(name) { var el = document.querySelector('input[name="' + name + '"]:checked'); return el ? el.value : null; }
    G.setup = { mode: val('mode'), opponent: val('opponent'), drawPlies: Number(val('drawPlies')), first: val('first'), level: Number(val('level')) || G.set.level };
    $('firstNote').hidden = G.setup.opponent !== 'pvp';
    $('levelCard').hidden = G.setup.opponent !== 'bot'; // 等級只在選電腦時出現
    $('rulesDraw').textContent = t('rules.draw', { n: G.setup.drawPlies });
  }

  function applyLang() {
    I18N.apply();
    document.documentElement.lang = I18N.getLang() === 'en' ? 'en' : 'zh-Hant';
    document.title = t('app.title');
    readSetup();
    check('lang', I18N.getLang());
    ['top', 'bottom'].forEach(function (k) {
      RESIGNS[k].setAttribute('aria-label', t(resignArmed[k] ? 'game.resignConfirm' : 'game.resignLabel'));
      if (resignArmed[k]) RESIGNS[k].textContent = t('game.resignConfirm');
    });
    if (G.state && G.page === 'game') { render(); renderEnd(); layoutBoard(); }
    else if (G.state) { render(); renderEnd(); }
    renderProfileBtn();
    if (G.page === 'records') renderRecords();
    if (G.page === 'profiles') renderProfiles();
  }

  function init() {
    G.set = readSettings();
    GS.initProfiles(t('profile.defaultName')); // 第一次開：建預設帳號（名字用現在的語言）
    G.colMode = G.set.colDefault;
    applyLook();
    if (MQ) {
      var onScheme = function () { if (G.set.scheme === 'auto') applyLook(); };
      if (MQ.addEventListener) MQ.addEventListener('change', onScheme); else if (MQ.addListener) MQ.addListener(onScheme);
    }
    buildFontSeg();
    buildBoard();
    check('drawPlies', G.set.drawPlies);
    check('level', G.set.level);
    applyLang();
    syncSettingsForm();
    document.querySelectorAll('#start input[type="radio"]').forEach(function (el) {
      el.addEventListener('change', function () {
        if (el.name === 'drawPlies') setSetting('drawPlies', Number(el.value));
        else if (el.name === 'level') { setSetting('level', Number(el.value)); readSetup(); } // 記住上次的等級
        else readSetup();
      });
    });
    document.querySelectorAll('#settings input[type="radio"]').forEach(function (el) { el.addEventListener('change', onSettingInput); });
    $('langBtn').addEventListener('click', function () { I18N.setLang(I18N.getLang() === 'en' ? 'zh-TW' : 'en'); applyLang(); });
    $('setBtnStart').addEventListener('click', openSettings);
    $('setBtnGame').addEventListener('click', openSettings);
    $('setBack').addEventListener('click', closeSettings);
    $('goBtn').addEventListener('click', function () { readSetup(); startGame(G.setup); });
    $('stopBtn').addEventListener('click', function () {
      var s = G.state;
      if (G.over || G.busy || !s || !s.chain || !isHuman(s.turn)) return;
      play({ type: 'stop' });
    });
    ['bottom', 'top'].forEach(function (k) {
      var btn = RESIGNS[k];
      btn.setAttribute('aria-label', t('game.resignLabel'));
      // 指標（手指、滑鼠、筆）：長按
      btn.addEventListener('pointerdown', function (e) { holdStart(k, e); });
      btn.addEventListener('pointerup', function () { holdCancel(k, true); });
      btn.addEventListener('pointerleave', function () { holdCancel(k); });
      btn.addEventListener('pointercancel', function () { holdCancel(k); });
      btn.addEventListener('pointermove', function (e) {
        if (!hold[k]) return;
        var r = btn.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) holdCancel(k);
      });
      btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      // click：指標按完也會來一個 click，那個不算；鍵盤（Enter／Space）與讀屏的 click（detail 0、前面沒有 pointerdown）＝按兩次
      btn.addEventListener('click', function (e) {
        if (e.detail !== 0 && Date.now() - (btn._ptr || 0) < 4000) return;
        onResign(k);
      });
    });
    window.addEventListener('scroll', function () { holdCancel('top'); holdCancel('bottom'); }, { passive: true });
    G.intel = loadSettings().intel !== 'hidden';
    renderIntel();
    $('intelBtn').addEventListener('click', function () { setIntel(!G.intel); });
    $('revealBtn').addEventListener('click', reveal);
    $('againBtn').addEventListener('click', function () { startGame(G.setup); });
    $('homeBtn').addEventListener('click', function () { showPage('start'); });
    window.addEventListener('resize', scheduleLayout);
    window.addEventListener('orientationchange', scheduleLayout);
    // 帳號、紀錄（第二步 b-2）
    $('profileBtn').addEventListener('click', openProfiles);
    $('recordsBtn').addEventListener('click', openRecords);
    $('recBack').addEventListener('click', function () { showPage('start'); $('recordsBtn').focus(); });
    $('profBack').addEventListener('click', function () { closeProfForm(); showPage('start'); $('profileBtn').focus(); });
    document.querySelectorAll('input[name="recMode"]').forEach(function (el) { el.addEventListener('change', renderRecords); });
    $('profAdd').addEventListener('click', function () { openProfForm(''); });
    $('profCancel').addEventListener('click', function () { closeProfForm(); $('profAdd').focus(); });
    $('profForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('profNameInput').value;
      if (profEditing) GS.renameProfile(profEditing, name);
      else { var p = GS.addProfile(name || t('profile.newName', { n: GS.profileList().length + 1 })); if (p) GS.setCurrent(p.id); } // 新增後直接切過去（五子棋也是）
      closeProfForm();
      afterProfileChange();
      $('profAdd').focus();
    });
    renderProfileBtn();
    offerResume(); // 上一盤還沒下完：問要不要接著下
  }

  init();

  // 測試用的小門：只在網址帶 ?test=1、而且 index.html 的 BANQI_RELEASE 不是 true 時掛上
  if (TEST) {
    window.__banqiApp = {
      G: G, E: E, AI: AI, MS: MS,
      start: function (o) { var s = {}; Object.keys(G.setup).forEach(function (k) { s[k] = G.setup[k]; }); Object.keys(o || {}).forEach(function (k) { s[k] = o[k]; }); startGame(s); },
      tap: onCell,
      setSpeed: function (f) { speed = f; },
      layoutBoard: layoutBoard,
      hiddenCounts: function () { return hiddenCounts(E.publicView(G.state)); },
      setIntel: setIntel,
      FONTS: FONTS,
      GS: GS, RESUME_KEY: RESUME_KEY, TAB_ID: TAB_ID, saveResume: function () { saveResume(); }, readResume: function () { var r = readResume(); return r ? (r.busy ? 'busy' : r.o.ts) : null; },
      remeasureBars: remeasureBars,
      render: render,
      DEFAULTS: DEFAULTS
    };
  }
})();
