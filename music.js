/*
 * 暗棋：背景音樂（作者 2026-10-26 定）。
 * 曲目＝window.BANQI_MUSIC（陣列，每一項是 banqi/snd/ 底下的一個檔：'snd/xxx.m4a'，或 { src: 'snd/xxx.m4a', db: 這一首自己的增益 }）。
 * 頁面沒先放就用下面的 TRACKS（現金流已經授權的五首，作者 2026-10-26 核准沿用；來源與授權在 snd/SOURCE.txt，tools/release.py 會查）。
 * 曲目是空的：什麼都不做（不建 AudioContext、不抓檔、不出聲、不丟錯）。
 * 瀏覽器下掛到 window.BanqiMusic；node 用 require('./music.js')（沒有 window：什麼都不做；nextBag 這種純函式照樣可以拿來驗）。
 *
 * 規矩：
 *   - 輪流放：整張清單洗牌放完一輪再洗一次；新的一輪第一首不會是上一首（不會連著同一首。只有一首時就是那一首一直接下去）。
 *   - 換曲：交叉淡入淡出約 2 秒（CROSSFADE）；第一首、停了再開也是 2 秒淡入。曲子比 6 秒短時淡入淡出縮成長度的三分之一。
 *   - 總音量 MASTER_DB＝−18 dB：音效（sound.js）的總音量 −12 dB 再低 6 dB，一樣是一個 GainNode。
 *     音效最響的「喀」量起來峰值約 −13 dBFS；曲子正規化到峰值約 −1 dBFS 時放出來峰值約 −19 dBFS，比音效的峰值低約 6 dB。
 *   - 每一首自己的增益（db，接在那一首的淡入淡出上）：五首的整合響度（ffmpeg loudnorm）拉到一樣，含總音量以後都是 −32 LUFS，
 *     放出來的真峰值平均約 −19 dBFS（量的數字在 snd/SOURCE.txt）。不改檔、不重新轉檔。
 *   - AudioContext 只在使用者的手勢裡建、resume（跟 sound.js 同一套：pointerdown／touchend／mousedown／click／keydown；isTrusted false 不算）。
 *     設定的「音樂」關著、清單是空的都不建。設定頁把音樂打開的那一下（navigator.userActivation 還在）就開始放，不用再點一下。
 *   - 頁面藏起來（visibilitychange）：正在放的 <audio> 暫停、AudioContext suspend（放到哪裡就停在哪裡）；回來 resume、接著放。
 *   - 神將開場的鐘：duck() 把音樂壓低約 10 dB（DUCK_DB）、2 秒（DUCK_S），再 0.6 秒回來。
 *   - 串流（2026-10-26 改；原來是 fetch＋decodeAudioData 整首解碼，一首 40–66 MB、交叉時兩首超過 100 MB，舊的 iPhone 會把頁面收掉）：
 *     兩個 <audio>（HTMLAudioElement）輪流用，各接一個 createMediaElementSource → 那一首的 GainNode（淡入淡出、這一首的增益）→ 壓低用的 GainNode → 總音量。
 *     音量一律在 Web Audio 裡調（iOS 的 <audio>.volume 是唯讀的）。正在放的那一個 preload auto；下一首只 preload metadata，輪到它才開始放。
 *     換曲：正在放的剩 2 秒（tick 每 0.25 秒看一次 currentTime／duration）時，下一首開始放、淡入 2 秒，這一首在剩下的時間淡出。
 *     <audio> 會發 Range 請求：sw.js 對 snd/ 先把整個檔抓下來存進 banqi-music，再照 Range 切成 206 回（離線也一樣）。
 *     抓不到、放不了（error 事件）的那一首記成壞的、跳過（重新開網頁才再試）。
 *   - iOS：第一首在手勢裡直接 play()；另一個 <audio> 在同一個手勢裡放一下無聲的（SILENT），之後換曲子時程式叫的 play() 才不會被擋。
 *     還是被擋（NotAllowedError）就等下一次手勢再叫一次。
 *   - log：最近 100 筆 { ev, url, at, t }（ev：start 開始放一首（t＝那時的 AudioContext 時間）、fail 那一首壞了、duck 壓低、stop 關掉；at＝Date.now()）。測試小門與 b01 用。
 */
(function (root, factory) {
  var M = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = M;
  else root.BanqiMusic = M;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var MASTER_DB = -18;
  var MASTER = Math.pow(10, MASTER_DB / 20); // ≈ 0.126
  var CROSSFADE = 2; // 秒
  var DUCK_DB = -10, DUCK_S = 2, DUCK_IN = 0.12, DUCK_OUT = 0.6;
  var TICK_MS = 250; // 多久看一次正在放的那一首剩多少
  var STOP_S = 0.4; // 關掉時收掉的秒數
  // 8 個取樣的無聲 WAV（iOS：手勢裡先放一下，這個 <audio> 之後程式叫 play() 才准）
  var SILENT = 'data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA==';

  // 洗牌（Fisher–Yates）；新的一輪第一首不是上一首（只有一首時沒辦法）
  function nextBag(list, last, rnd) {
    rnd = rnd || Math.random;
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)), x = a[i]; a[i] = a[j]; a[j] = x; }
    if (a.length > 1 && a[0] === last) { var k = 1 + Math.floor(rnd() * (a.length - 1)), y = a[0]; a[0] = a[k]; a[k] = y; }
    return a;
  }

  var W = typeof window !== 'undefined' && window && typeof window.addEventListener === 'function' ? window : null;
  var D = W && W.document ? W.document : null;
  // 曲目（現金流的 cashflow/snd/ 原封不動複製過來，檔名照現金流的編號）。db：整合響度 I（LUFS）→ −14 − I（＝ −32 − I − MASTER_DB），四捨五入到 0.1
  var TRACKS = [
    { src: 'snd/music-1.m4a', db: -2.8 }, // 〈旅途〉Travel Acoustic Guitar／Tunetank（I −11.2）
    { src: 'snd/music-2.m4a', db: -0.5 }, // 〈山路〉Beautiful Folk Guitar／331music（I −13.5）
    { src: 'snd/music-4.m4a', db: 3.3 }, // 〈暖陽〉Warm Acoustic Guitar／Universfield（I −17.3）
    { src: 'snd/music-6.m4a', db: -0.1 }, // 〈棋局〉Italian Game／Turning_Pages（I −13.9）
    { src: 'snd/music-8.m4a', db: -4.8 } // 〈微風〉Bossa Nova Cafe Morning Breeze／alex-morgan（I −9.2）
  ];
  if (W && !Array.isArray(W.BANQI_MUSIC)) W.BANQI_MUSIC = TRACKS.slice(); // 頁面先放了（測試放空的）就用頁面的
  var on = true, ctx = null, master = null, duckG = null, made = 0, by = null, broken = false, log = [];
  // slots：兩個 <audio>，每一個 { el, node, g, url, lv, st, primed, back }；st：idle 空著、priming 放無聲的、ready 下一首（metadata）、playing 在放、fading 換曲淡出中、stopping 關掉收尾中
  var bag = [], last = null, slots = [], curI = -1, timer = null, bad = {}, blocked = false;

  // 曲目的每一項 → { src, db }（字串＝db 0）；不認得的、壞掉的不算
  function entries() {
    var l = W && Array.isArray(W.BANQI_MUSIC) ? W.BANQI_MUSIC : [], out = [];
    l.forEach(function (e) {
      var src = typeof e === 'string' ? e : e && typeof e.src === 'string' ? e.src : '', db = e && typeof e.db === 'number' && isFinite(e.db) ? e.db : 0;
      if (src && !bad[src]) out.push({ src: src, db: db });
    });
    return out;
  }
  function list() { return entries().map(function (e) { return e.src; }); }
  function levelOf(src) {
    var l = entries();
    for (var i = 0; i < l.length; i++) if (l[i].src === src) return Math.pow(10, l[i].db / 20);
    return 1;
  }
  function hidden() { return !!D && D.visibilityState === 'hidden'; }
  function quiet(p) { if (p && typeof p.catch === 'function') p.catch(function () {}); }
  function note(ev, url, t) { log.push({ ev: ev, url: url || null, at: Date.now(), t: typeof t === 'number' ? t : null }); if (log.length > 100) log.shift(); }

  function pick() {
    var l = list();
    if (!l.length) return null;
    bag = bag.filter(function (u) { return l.indexOf(u) >= 0; });
    if (!bag.length) bag = nextBag(l, last);
    return bag.shift();
  }
  // ------------------------------------------------------------ 兩個 <audio>
  function makeSlot() {
    var el = new W.Audio();
    el.preload = 'none';
    var s = { el: el, node: null, g: null, url: null, lv: 1, st: 'idle', primed: false, back: false };
    s.node = ctx.createMediaElementSource(el);
    s.g = ctx.createGain();
    s.g.gain.value = 0;
    s.node.connect(s.g); s.g.connect(duckG);
    el.addEventListener('ended', function () { onEnded(s); });
    el.addEventListener('error', function () { onError(s); });
    el.addEventListener('loadedmetadata', function () { if (s.st === 'playing' || s.st === 'ready') tick(); });
    return s;
  }
  function ramp(s, to, sec) {
    var t = ctx.currentTime, p = s.g.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(to, t + Math.max(0.01, sec));
  }
  // 空出來：停、拿掉 src（放掉緩衝），音量歸零
  function reset(s) {
    s.st = 'idle'; s.url = null; s.back = false;
    try { s.el.pause(); s.el.removeAttribute('src'); s.el.load(); } catch (err) { /* 算了 */ }
    try { var p = s.g.gain; p.cancelScheduledValues(ctx.currentTime); p.setValueAtTime(0, ctx.currentTime); } catch (err) { /* 算了 */ }
  }
  // 放進一首（還不放）：preload＝'metadata'（下一首）或 'auto'（馬上要放）
  function load(s, url, preload) {
    s.url = url; s.lv = levelOf(url); s.st = 'ready';
    s.el.preload = preload;
    s.el.src = url;
  }
  // 開始放這一個，淡入 xf 秒到這一首自己的大小
  function playSlot(s, xf) {
    var t = ctx.currentTime, p = s.g.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(s.lv, t + xf); // lv＝這一首自己的增益（TRACKS 的 db）
    s.st = 'playing';
    s.el.preload = 'auto';
    curI = slots.indexOf(s); last = s.url;
    note('start', s.url, t);
    var pr;
    try { pr = s.el.play(); } catch (err) { onError(s); return; }
    if (pr && typeof pr.then === 'function') pr.then(function () { s.primed = true; blocked = false; }, function (err) {
      var n = err && err.name;
      if (n === 'NotAllowedError') { blocked = true; return; } // 不是在手勢裡：等下一次手勢
      if (n === 'AbortError') return; // 換了 src、暫停了
      onError(s);
    });
    else s.primed = true;
  }
  // iOS：在手勢裡放一下無聲的，這個 <audio> 之後程式叫的 play() 才准
  function prime(s) {
    s.st = 'priming'; s.primed = true;
    function done() { if (s.st === 'priming') { reset(s); tick(); } }
    try {
      s.el.src = SILENT;
      var p = s.el.play();
      if (p && typeof p.then === 'function') p.then(function () { s.el.pause(); done(); }, done); else done();
    } catch (err) { done(); }
  }
  function onEnded(s) {
    if (s.st === 'idle' || s.st === 'priming') return;
    var was = s === slots[curI] && s.st === 'playing'; // 沒交棒就放完了（下一首還沒好）
    reset(s);
    if (was) { curI = -1; tick(); }
  }
  function onError(s) {
    if (s.st === 'idle' || s.st === 'priming' || !s.url) return;
    var url = s.url, was = s === slots[curI];
    bad[url] = 1; note('fail', url);
    bag = bag.filter(function (u) { return u !== url; });
    reset(s);
    if (was) curI = -1;
    tick();
  }
  function tick() {
    if (!ctx || !on || !duckG || !slots.length || hidden()) return;
    var cur = curI >= 0 ? slots[curI] : null, s, u;
    if (!cur || cur.st !== 'playing') {
      // 沒在放：有放好的下一首就放它，沒有就挑一首放進空著的那一個
      s = slots.filter(function (x) { return x.st === 'ready'; })[0] || slots.filter(function (x) { return x.st === 'idle'; })[0];
      if (!s) return;
      if (s.st === 'idle') { u = pick(); if (!u) return; load(s, u, 'auto'); }
      playSlot(s, CROSSFADE);
      return;
    }
    var oth = slots[1 - curI];
    if (oth.st === 'idle') { u = pick(); if (u) load(oth, u, 'metadata'); }
    var d = cur.el.duration, rem = d - cur.el.currentTime;
    if (!isFinite(d) || !(d > 0) || cur.el.paused) return;
    var xf = Math.min(CROSSFADE, d / 3);
    if (rem <= xf + 0.05 && oth.st === 'ready') {
      cur.st = 'fading';
      ramp(cur, 0, rem); // 這一首在剩下的時間淡出（放完 ended → 空出來）
      playSlot(oth, xf);
    }
  }
  function run() {
    if (!timer && W) timer = W.setInterval(tick, TICK_MS);
    tick();
  }
  // 關掉：正在放的 0.4 秒收掉，之後兩個 <audio> 都空出來
  function halt() {
    if (timer && W) { W.clearInterval(timer); timer = null; }
    var any = false;
    slots.forEach(function (s) {
      if (s.st === 'idle' || s.st === 'priming') return;
      if (s.st === 'playing' || s.st === 'fading') { any = true; note('stop', s.url); }
      s.st = 'stopping';
      try { ramp(s, 0, STOP_S); } catch (err) { /* 算了 */ }
    });
    curI = -1;
    if (W && slots.length) W.setTimeout(function () {
      if (on) return;
      slots.forEach(function (s) { if (s.st === 'stopping') reset(s); });
      if (ctx) quiet(ctx.suspend());
    }, STOP_S * 1000 + 50);
    return any;
  }

  function unlock(e) {
    if (e && e.isTrusted === false) return; // 程式送的事件不是手勢
    if (!on || broken || hidden() || !list().length) return;
    var AC = W.AudioContext || W.webkitAudioContext;
    if (!AC || typeof W.Audio !== 'function') { broken = true; return; }
    try {
      if (!ctx) {
        // iOS 17+：ambient＝跟別的 app 的音樂混在一起、照靜音鍵（同 sound.js）
        try { if (W.navigator && W.navigator.audioSession) W.navigator.audioSession.type = 'ambient'; } catch (err) { /* 不支援就算了 */ }
        ctx = new AC();
        made++;
        by = e ? e.type : 'activation';
        master = ctx.createGain();
        master.gain.value = MASTER;
        master.connect(ctx.destination);
        duckG = ctx.createGain();
        duckG.gain.value = 1;
        duckG.connect(master);
        // 舊的 iOS：手勢裡播一個無聲的 buffer 才算解鎖
        var s = ctx.createBufferSource();
        s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        s.connect(ctx.destination);
        s.start(0);
        slots = [makeSlot(), makeSlot()];
      }
      if (ctx.state !== 'running' && ctx.state !== 'closed') {
        var p = ctx.resume();
        if (p && typeof p.then === 'function') p.then(function () { if (on) run(); }, function () {});
      }
      slots.forEach(function (x) { if (x.st === 'stopping') reset(x); }); // 剛關掉又打開
      // 在手勢裡：沒在放就直接放第一首（這一下的 play() 一定准）；另一個還沒放過的 <audio> 放一下無聲的
      run();
      slots.forEach(function (x) { if (!x.primed && x.st === 'idle') prime(x); });
      // 之前被擋下來的 play()：這一下再叫一次
      if (blocked) slots.forEach(function (x) {
        if ((x.st !== 'playing' && x.st !== 'fading') || !x.el.paused) return;
        var p = x.el.play();
        if (p && typeof p.then === 'function') p.then(function () { blocked = false; }, function () {}); else blocked = false;
      });
    } catch (err) { broken = true; ctx = null; master = null; duckG = null; slots = []; }
  }
  if (W) {
    ['pointerdown', 'touchend', 'mousedown', 'click', 'keydown'].forEach(function (n) { W.addEventListener(n, unlock, true); });
    if (D) D.addEventListener('visibilitychange', function () {
      if (!ctx) return;
      try {
        if (hidden()) {
          slots.forEach(function (x) { if (!x.el.paused && (x.st === 'playing' || x.st === 'fading')) { x.back = true; x.el.pause(); } });
          quiet(ctx.suspend());
        } else if (on) {
          var p = ctx.resume();
          if (p && typeof p.then === 'function') p.then(function () { if (on) run(); }, function () {});
          slots.forEach(function (x) { if (x.back) { x.back = false; quiet(x.el.play()); } });
          run();
        }
      } catch (err) { /* 不給就等下一次手勢 */ }
    });
  }

  function setEnabled(v) {
    v = !!v;
    if (v === on) return;
    on = v;
    if (!W) return;
    if (!on) { halt(); return; }
    // 打開：已經有 AudioContext 就接著放；還沒有、而且這一下是使用者點的（設定頁的開關），就在這裡建
    var act = W.navigator && W.navigator.userActivation;
    if (ctx || (act && act.isActive)) unlock(null);
  }
  // 壓低 db（負的）sec 秒；沒在放（還沒建、關著）回 false
  function duck(db, sec) {
    db = typeof db === 'number' ? db : DUCK_DB;
    sec = typeof sec === 'number' ? sec : DUCK_S;
    if (!ctx || !duckG || !on) return false;
    try {
      var t = ctx.currentTime, p = duckG.gain, lo = Math.pow(10, db / 20);
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(lo, t + DUCK_IN);
      p.setValueAtTime(lo, t + sec);
      p.linearRampToValueAtTime(1, t + sec + DUCK_OUT);
    } catch (err) { return false; }
    note('duck', curI >= 0 ? slots[curI].url : null);
    return true;
  }

  return {
    MASTER_DB: MASTER_DB,
    MASTER: MASTER,
    CROSSFADE: CROSSFADE,
    DUCK_DB: DUCK_DB,
    DUCK_S: DUCK_S,
    nextBag: nextBag,
    TRACKS: TRACKS,
    levelOf: levelOf,
    setEnabled: setEnabled,
    enabled: function () { return on; },
    duck: duck,
    playlist: list,
    log: log,
    tick: tick,
    // playing＝正在放（淡入中、放著）的那一首；next＝放好 metadata、等著接的那一首；els＝兩個 <audio> 現在的樣子
    state: function () {
      var cur = curI >= 0 && slots[curI].st === 'playing' ? slots[curI] : null, nx = slots.filter(function (x) { return x.st === 'ready'; })[0] || null;
      return { ctx: ctx ? ctx.state : null, made: made, by: by, broken: broken, on: on, hidden: hidden(), playing: cur ? cur.url : null,
        next: nx ? nx.url : null, ready: !!(nx && nx.el.readyState >= 1), last: last, bag: bag.slice(), timer: !!timer, bad: Object.keys(bad), blocked: blocked,
        duck: duckG ? duckG.gain.value : null, t: ctx ? ctx.currentTime : null,
        els: slots.map(function (x) { return { url: x.url, st: x.st, paused: x.el.paused, time: x.el.currentTime, dur: x.el.duration, preload: x.el.preload, gain: x.g.gain.value }; }) };
    },
    _els: function () { return slots.map(function (x) { return x.el; }); } // 測試用（b01 把正在放的那一首撥到快結束，馬上看交叉）
  };
});
