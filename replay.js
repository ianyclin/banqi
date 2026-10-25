/*
 * 暗棋：棋局回放（2026-10-25）。紀錄頁「最近的盤」裡有棋譜的盤（stats.js 的 banqi.recs.v1，每個帳號最近 50 盤）按「回放」進來。
 * 分兩半：
 *   1. 純函式（test.js 也用）：build(棋譜) 用引擎的 decodeRecord 重播一次，每一步以後的狀態都留著（frames[0]＝開局、frames[N]＝最後）；
 *      cellsAt(rp, k, reveal) 第 k 步以後的 32 格（reveal＝蓋著的子照開局排法翻出來看，淡色）。
 *      一步＝棋譜的一步＝引擎的 ply：翻、走、吃，連吃整串算一步（規則 12；紀錄的「n 步」也是這個單位）。
 *      連吃那一步吃了哪些子、攻擊暗子失敗翻出什麼，記在那一步的 caps／fail（畫面寫在上面那一行，走過的格子都有上一步的四個角）。
 *   2. 畫面（只在瀏覽器）：#replay 那一頁。棋盤與兩欄用對局頁的同一套 class（.board／.cell／.intel），主題、字型照樣；只看不點。
 *      app.js 開頁時呼叫 init(ctx)（換頁、時間與等級的寫法、返回紀錄頁都由 app.js 給），紀錄頁按「回放」呼叫 open(紀錄, 棋譜)。
 *      格子大小照對局頁的做法量（layout：先縮小再量剩下的高度），9 種尺寸一個畫面放得下、不捲動。
 * 規則全部交給 engine.js；這裡只重播棋譜，不判斷能不能走。
 */
(function (root) {
  'use strict';
  var E = root.BanqiEngine || (typeof require === 'function' ? require('./engine.js') : null);

  // ------------------------------------------------------------ 1. 純函式
  // 一步的摘要：走的那一位、這一步的事件、走過的格子（翻子＝那一格；走、吃、連吃＝起點＋每一個落點）、吃到的子、攻擊暗子失敗（翻出什麼）
  function frameOf(mv) {
    var f = { state: mv.state, player: mv.player, events: mv.events, path: [], caps: [], fail: null, flip: null, piece: null, open: false };
    mv.events.forEach(function (ev) {
      if (ev.type === 'flip') { f.flip = { sq: ev.sq, piece: ev.piece }; f.path.push(ev.sq); }
      else if (ev.type === 'move' || ev.type === 'capture' || ev.type === 'attack') {
        if (!f.path.length) { f.path.push(ev.from); f.piece = ev.piece; }
        f.path.push(ev.to);
        if (ev.type === 'capture') f.caps.push(ev.captured);
        else if (ev.type === 'attack' && ev.success) f.caps.push(ev.revealed);
        else if (ev.type === 'attack') f.fail = { sq: ev.to, piece: ev.revealed };
      }
    });
    f.open = !!(mv.state.chain && mv.state.turn === mv.player); // 棋譜最後一步是沒走完的連吃（連吃到一半認輸）
    return f;
  }
  // 讀棋譜：{ frames, n 步數, layout 開局排法, final 最後的狀態 }。棋譜讀不了就丟錯（呼叫的人接）
  function build(text) {
    var frames = [];
    var fin = E.decodeRecord(text, function (mv) { frames.push(frameOf(mv)); });
    var s0 = E.newGame({ mode: fin.mode, drawPlies: fin.drawPlies, noChase: fin.noChase, layout: fin.secret.layout });
    frames.unshift({ state: s0, player: null, events: [], path: [], caps: [], fail: null, flip: null, piece: null, open: false });
    return { frames: frames, n: frames.length - 1, layout: fin.secret.layout, final: fin };
  }
  // 第 k 步以後的 32 格：{ x 字母／'?'／null, peek 原本蓋著、照開局排法翻出來看的 }
  function cellsAt(rp, k, reveal) {
    var s = rp.frames[k].state, out = [];
    for (var i = 0; i < E.N; i++) {
      var x = s.board[i];
      if (x === E.HIDDEN && reveal) out.push({ x: s.secret.hidden[i], peek: true });
      else out.push({ x: x, peek: false });
    }
    return out;
  }

  var API = { build: build, cellsAt: cellsAt };
  if (typeof module === 'object' && module && module.exports) { module.exports = API; return; }
  root.BanqiReplay = API;
  if (typeof document === 'undefined') return;

  // ------------------------------------------------------------ 2. 畫面
  var HIDDEN = E.HIDDEN, MIN_CELL = 20, PLAY_MS = 1000;
  var ctx = null, cells = [];
  // rp＝build 的結果、g＝紀錄、me＝這個帳號是哪一位（下面那邊）、k＝現在第幾步、reveal＝顯示蓋著的子、colMode＝兩欄顯示被吃（cap）或沒翻（hid）
  var V = { rp: null, g: null, me: 0, k: 0, reveal: false, colMode: 'cap', timer: null, land: false, cell: 0, colw: 0, cg: null };
  function $(id) { return document.getElementById(id); }
  function t(k, p) { return root.I18N.t(k, p); }
  function pieceName(p) { return root.I18N.pieceName(p, E.NAMES); }
  function isLetter(x) { return typeof x === 'string' && x !== HIDDEN; }
  function shown() { return !!V.rp && !$('replay').hidden; }

  // 只有上一步的四個角（.cell.last 的樣子同對局頁）
  var MARK = '<svg class="mk" viewBox="0 0 54 54" aria-hidden="true" focusable="false"><path class="lst" d="M4 12V4h8M42 4h8v8M50 42v8h-8M12 50H4v-8"/></svg>';
  function buildBoard() {
    var board = $('rpBoard');
    for (var sq = 0; sq < E.N; sq++) {
      var el = document.createElement('div');
      el.className = 'cell';
      el.setAttribute('role', 'img');
      el.setAttribute('data-rsq', String(sq));
      el.innerHTML = '<span class="pc"><span class="disc"><span class="back"></span><span class="face"><span class="ch"></span></span></span></span>' + MARK;
      el._disc = el.querySelector('.disc');
      el._ch = el.querySelector('.ch');
      el._x = undefined;
      el._edge = '';
      board.appendChild(el);
      cells.push(el);
    }
    placeCells();
  }
  // 直式：a1 在左下、d8 在右上；橫放：1 列在左、a 欄在上（同對局頁的 placeCells）
  function placeCells() {
    cells.forEach(function (el, sq) {
      var c = sq % E.COLS, r = Math.floor(sq / E.COLS);
      if (V.land) { el.style.gridColumn = String(r + 1); el.style.gridRow = String(c + 1); el._edge = (r === E.ROWS - 1 ? ' edge-r' : '') + (c === E.COLS - 1 ? ' edge-b' : ''); }
      else { el.style.gridColumn = String(c + 1); el.style.gridRow = String(E.ROWS - r); el._edge = (c === E.COLS - 1 ? ' edge-r' : '') + (r === 0 ? ' edge-b' : ''); }
    });
  }

  function renderBoard(anim) {
    var f = V.rp.frames[V.k], info = cellsAt(V.rp, V.k, V.reveal), marks = {};
    f.path.forEach(function (sq) { marks[sq] = true; });
    for (var sq = 0; sq < E.N; sq++) {
      var el = cells[sq], c = info[sq], disp = c.x, up = isLetter(disp);
      var cls = 'cell' + el._edge;
      if (disp === null) cls += ' empty';
      else if (up) cls += ' ' + E.colorOf(disp);
      if (c.peek) cls += ' peek';
      if (marks[sq]) cls += ' last';
      el.className = cls;
      el._ch.textContent = up ? E.NAMES[disp] : '';
      // 往下一步、剛翻開的子照 CSS 轉過來；其他（跳步、往回、切換顯示蓋著的子）直接換
      if (anim && el._x === HIDDEN && up && !c.peek) el._disc.classList.add('up');
      else if (el._disc.classList.contains('up') !== up) {
        el._disc.style.transition = 'none';
        el._disc.classList.toggle('up', up);
        void el._disc.offsetWidth;
        el._disc.style.transition = '';
      }
      el._x = c.peek ? HIDDEN : disp;
      var name = E.squareName(sq), label;
      if (disp === null) label = t('cell.empty', { sq: name });
      else if (c.peek) label = t('cell.peek', { sq: name, piece: pieceName(disp) });
      else if (disp === HIDDEN) label = t('cell.hidden', { sq: name });
      else label = t('cell.piece', { sq: name, piece: pieceName(disp) });
      if (marks[sq]) label += t('cell.last');
      el.setAttribute('aria-label', label);
    }
  }

  // ---- 兩欄（同對局頁的 renderIntelCol：左＝對方、右＝我；兩人同機：左上方、右下方）。點欄頭兩欄一起換「被吃」⇄「沒翻」
  function colName(p, short) {
    var k = V.g.opp === 'ai' ? (p === V.me ? 'intel.me' : 'intel.opp') : (p === V.me ? 'intel.bottom' : 'intel.top');
    return t(short ? k + 'Short' : k);
  }
  function miniPiece(p, col) {
    var sp = document.createElement('span');
    sp.className = 'mini ' + (col ? E.colorOf(p) : 'u');
    sp.textContent = E.NAMES[p];
    sp.setAttribute('aria-hidden', 'true');
    return sp;
  }
  function renderCol(el, p, view) {
    el.textContent = '';
    var col = view.colors[p], mode = V.colMode, name = colName(p, false), cg = V.cg || { short: {}, nmScale: {} };
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
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = cg.short[el.id] ? colName(p, true) : name;
    if (cg.nmScale[el.id]) nm.style.fontSize = (11.5 * cg.nmScale[el.id]).toFixed(2) + 'px';
    who.appendChild(nm);
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
      var pc = col ? (col === 'r' ? T : T.toLowerCase()) : T, pname = col ? pieceName(pc) : E.NAMES[T];
      var row = document.createElement('div'), n, i, mp;
      row.setAttribute('data-t', T);
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
  function renderCols() {
    var view = E.publicView(V.rp.frames[V.k].state);
    renderCol($('rpColOpp'), 1 - V.me, view);
    renderCol($('rpColMe'), V.me, view);
    fitCols();
  }
  function toggleColMode(e) {
    var id = e.currentTarget.parentNode.id, hadFocus = document.activeElement === e.currentTarget;
    V.colMode = V.colMode === 'cap' ? 'hid' : 'cap';
    renderCols();
    var h = $(id).querySelector('.intel-head');
    if (hadFocus && h) h.focus({ preventScroll: true });
  }
  function fitCols() {
    var cg = V.cg;
    if (!cg) return;
    [$('rpColOpp'), $('rpColMe')].forEach(function (el) {
      el.classList.toggle('narrow', cg.narrow);
      el.classList.toggle('narrow-who', cg.narrowWho);
      el.classList.toggle('split', cg.split);
    });
    $('replay').style.setProperty('--md', cg.md + 'px');
    $('replay').style.setProperty('--stk', cg.stk + 'px');
  }
  // 欄頭放不放得下（同對局頁的 colHeadFlags，用 canvas 量字寬，不排版）
  var mctx = null, BODY_FONT = null;
  function textW(str, font) {
    if (!mctx) mctx = document.createElement('canvas').getContext('2d');
    mctx.font = font;
    return mctx.measureText(str).width;
  }
  function colHeadFlags() {
    if (!BODY_FONT) BODY_FONT = getComputedStyle(document.body).fontFamily;
    var headW = V.colw - 6, cg = { narrow: false, narrowWho: false, short: {}, nmScale: {}, split: false, md: 24, stk: 4 };
    var seg = '700 10.5px ' + BODY_FONT, nmf = '700 11.5px ' + BODY_FONT;
    cg.narrow = textW(t('intel.legendCap'), seg) + textW(t('intel.legendHid'), seg) + 12 > headW;
    [['rpColOpp', 1 - V.me], ['rpColMe', V.me]].forEach(function (pr) {
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
  function fitStack(w, rowH) {
    var md = Math.min(24, Math.floor(w * 0.48), Math.floor(w - 18));
    md = Math.max(12, Math.min(md, Math.floor(rowH - 10)));
    var stk = Math.max(1, Math.min(4, Math.floor((rowH - 2 - md) / 4)));
    return { md: md, stk: stk };
  }

  // ---- 上面兩行：這一盤（日期・玩法・對手・顏色・結果）、第幾步與這一步
  function whoMoved(f) {
    if (V.g.opp === 'ai') return t(f.player === V.me ? 'side.you' : 'side.bot');
    var c = f.state.colors[f.player];
    return c ? t(c === 'r' ? 'color.rSide' : 'color.bSide') : t(f.player === V.me ? 'side.bottom' : 'side.top');
  }
  function moveText(f) {
    if (f.player === null) return t('rp.at0');
    if (f.flip) return t('rp.flip', { who: whoMoved(f), sq: E.squareName(f.flip.sq), piece: pieceName(f.flip.piece) });
    var s = t('rp.go', { who: whoMoved(f), piece: pieceName(f.piece), path: f.path.map(E.squareName).join('→') });
    if (f.caps.length) s += t('rp.took', { list: f.caps.map(pieceName).join(t('rp.sep')) });
    if (f.fail) s += t('rp.failed', { sq: E.squareName(f.fail.sq), piece: pieceName(f.fail.piece) });
    return s;
  }
  function renderHead() {
    var g = V.g;
    $('rpMeta').textContent = t('rp.meta', {
      when: ctx.whenText(ctx.timeOf(g)), mode: t('mode.' + g.mode),
      opp: g.opp === 'pvp' ? t('records.pvp') : t('records.oppAi', { level: ctx.levelName(g.level) }),
      color: g.color ? t(g.color === 'r' ? 'color.rSide' : 'color.bSide') : t('color.unknown'),
      result: t('res.' + g.result), reason: t(g.abandon ? 'reason.abandon' : 'reason.' + g.reason)
    });
    var txt = t('rp.line', { ply: t('rp.ply', { k: V.k, n: V.rp.n }), move: moveText(V.rp.frames[V.k]) });
    $('rpMove').textContent = txt;
    $('rpMove').title = txt;
  }
  function renderCtl() {
    var sl = $('rpSlider'), n = V.rp.n;
    sl.max = String(n);
    sl.value = String(V.k);
    sl.setAttribute('aria-valuetext', t('rp.ply', { k: V.k, n: n }));
    ['rpFirst', 'rpPrev'].forEach(function (id) { $(id).setAttribute('aria-disabled', V.k <= 0 ? 'true' : 'false'); });
    ['rpNext', 'rpLast'].forEach(function (id) { $(id).setAttribute('aria-disabled', V.k >= n ? 'true' : 'false'); });
    var pb = $('rpPlay'), on = !!V.timer;
    pb.setAttribute('aria-pressed', on ? 'true' : 'false');
    pb.setAttribute('aria-label', t(on ? 'rp.pause' : 'rp.play'));
    $('rpReveal').checked = V.reveal;
  }
  function render(anim) {
    if (!V.rp) return;
    renderBoard(!!anim);
    renderCols();
    renderHead();
    renderCtl();
  }

  // ---- 版面（同對局頁的 layoutBoard 的做法：先把格子縮小再量，畫面高度扣掉其他東西的高度，再除以列數）
  function layout() {
    if (!shown()) return;
    var page = $('replay'), main = document.querySelector('main'), cs = getComputedStyle(main);
    // 先把格子縮到一定放得下再讀畫面寬高：上一次的格子太大時，手機瀏覽器會把整頁縮小、innerHeight 跟著變大（同對局頁 layoutBoard 的註解）
    page.style.setProperty('--cell', MIN_CELL + 'px');
    var W = document.documentElement.clientWidth, H = window.innerHeight, land = W > H || W >= 700;
    var cols = land ? E.ROWS : E.COLS, rows = land ? E.COLS : E.ROWS;
    if (land !== V.land) { V.land = land; placeCells(); renderBoard(false); }
    $('rpBoard').classList.toggle('land', land);
    page.style.setProperty('--cols', String(cols));
    page.style.setProperty('--rows', String(rows));
    V.colw = W < 360 ? 46 : W < 400 ? 54 : W < 430 ? 58 : Math.min(76, 60 + Math.floor((W - 430) / 20));
    page.style.setProperty('--colw', V.colw + 'px');
    page.style.setProperty('--cell', MIN_CELL + 'px');
    var bpad = parseFloat(getComputedStyle(page.querySelector('.board-wrap')).paddingLeft) || 0;
    var hgap = parseFloat(getComputedStyle(page.querySelector('.board-row')).columnGap) || 0;
    var availW = main.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) - bpad * 2 - 2 * V.colw - 2 * hgap;
    var fixed = main.getBoundingClientRect().height - rows * MIN_CELL;
    var cell = Math.floor(Math.min(availW / cols, (H - fixed) / rows, land ? 96 : 80));
    if (!(cell >= MIN_CELL)) cell = MIN_CELL;
    V.cell = cell;
    page.style.setProperty('--cell', cell + 'px');
    page.style.setProperty('--roww', (cols * cell + 2 * bpad + 2 * V.colw + 2 * hgap) + 'px');
    V.cg = colHeadFlags();
    renderCols();
    var head = $('rpColMe').querySelector('.intel-head'), headH = head ? head.getBoundingClientRect().height : 0;
    var inner = cell * rows + 2 * bpad - 2, w = V.colw - 4, a = fitStack(w, (inner - headH) / 7), b2;
    if (a.md < 20) { b2 = fitStack(w / 2 - 1, (inner - headH) / 4); if (b2.md > a.md) { a = b2; V.cg.split = true; } }
    V.cg.md = a.md; V.cg.stk = a.stk;
    fitCols();
  }
  var layoutQueued = false;
  function scheduleLayout() {
    if (layoutQueued || !shown()) return;
    layoutQueued = true;
    requestAnimationFrame(function () { layoutQueued = false; layout(); });
  }

  // ---- 走到第幾步；自動播放
  function go(k, byUser) {
    if (!V.rp) return;
    if (byUser) stopPlay();
    k = Math.max(0, Math.min(V.rp.n, k | 0));
    if (k === V.k) { renderCtl(); return; }
    var anim = k === V.k + 1;
    V.k = k;
    render(anim);
  }
  function stopPlay() {
    if (!V.timer) return;
    clearInterval(V.timer);
    V.timer = null;
    if (V.rp) renderCtl();
  }
  function togglePlay() {
    if (!V.rp) return;
    if (V.timer) { stopPlay(); return; }
    if (V.k >= V.rp.n) go(0, false);
    V.timer = setInterval(function () {
      if (!shown() || V.k >= V.rp.n) { stopPlay(); return; }
      go(V.k + 1, false);
      if (V.k >= V.rp.n) stopPlay();
    }, PLAY_MS);
    renderCtl();
  }

  // 打開回放：g＝紀錄（stats.js 的一筆），rec＝stats.js recOf 給的棋譜 { text, me }。棋譜讀不了回 false（不換頁）
  function open(g, rec) {
    var rp;
    try { rp = build(rec.text); } catch (e) { return false; }
    stopPlay();
    V.rp = rp; V.g = g; V.me = rec.me === 1 ? 1 : 0; V.k = 0; V.reveal = false;
    V.colMode = ctx.colMode() === 'hid' ? 'hid' : 'cap';
    cells.forEach(function (el) { el._x = undefined; });
    ctx.showPage('replay');
    render(false);
    layout();
    $('rpBack').focus({ preventScroll: true });
    return true;
  }
  function back() {
    stopPlay();
    var g = V.g;
    if (ctx && g) ctx.back(g.ts);
  }

  function init(c) {
    ctx = c;
    buildBoard();
    $('rpBack').addEventListener('click', back);
    $('rpFirst').addEventListener('click', function () { go(0, true); });
    $('rpPrev').addEventListener('click', function () { go(V.k - 1, true); });
    $('rpNext').addEventListener('click', function () { go(V.k + 1, true); });
    $('rpLast').addEventListener('click', function () { if (V.rp) go(V.rp.n, true); });
    $('rpSlider').addEventListener('input', function () { go(Number($('rpSlider').value), true); });
    $('rpPlay').addEventListener('click', togglePlay);
    $('rpReveal').addEventListener('change', function () { V.reveal = $('rpReveal').checked; if (V.rp) renderBoard(false); });
    // 鍵盤：← → 一步、Home／End 到開局／最後一步（焦點在滑桿上也是這樣，不另外再走一次）
    document.addEventListener('keydown', function (e) {
      if (!shown() || e.altKey || e.ctrlKey || e.metaKey) return;
      var dlg = $('dialog');
      if (dlg && !dlg.hidden) return;
      var k = e.key, to = null;
      if (k === 'ArrowLeft' || k === 'Left') to = V.k - 1;
      else if (k === 'ArrowRight' || k === 'Right') to = V.k + 1;
      else if (k === 'Home') to = 0;
      else if (k === 'End') to = V.rp.n;
      if (to === null) return;
      e.preventDefault();
      go(to, true);
    });
    window.addEventListener('resize', scheduleLayout);
    window.addEventListener('orientationchange', scheduleLayout);
  }

  API.init = init;
  API.open = open;
  API.stop = stopPlay;
  API.render = function () { if (V.rp) { render(false); if (shown()) layout(); } };
  API.layout = layout;
  API.go = function (k) { go(k, true); };
  API.state = function () { return { k: V.k, n: V.rp ? V.rp.n : 0, reveal: V.reveal, playing: !!V.timer, ts: V.g ? V.g.ts : null, cell: V.cell, land: V.land, colMode: V.colMode }; };
  API.setPlayMs = function (ms) { PLAY_MS = ms; };
})(typeof self !== 'undefined' ? self : this);
