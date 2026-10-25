/*
 * 暗棋：音效（作者 2026-10-25 定案）。全部用 Web Audio 當場合成（振盪器、雜訊、濾波器、包絡），沒有音檔：沒有授權問題、不用下載。
 * 瀏覽器下掛到 window.BanqiSound；node 用 require('./sound.js')（沒有 window：什麼都不做、不記，play 回 false；表與 renderInto 照樣可以拿來驗）。
 *
 * 事件 → 聲音（EVENTS；null＝不出聲）：
 *   flip 翻暗子＝紙一樣的「唰」接一聲輕的木頭「叩」；move 走到空格＝輕的木頭敲一下；capture 吃子＝比較重的「喀」；
 *   連吃的第 n 吃＝同一聲「喀」，一吃比一吃高（opts.step：這一手的第幾吃，1 起算，每多一吃高 2 個半音，第 7 吃以後不再高）；
 *   attackFail 連吃攻擊暗子失敗＝悶悶的一聲「咚」；stop 停在這裡、illegal 不合法的點＝不出聲（搖一下就夠）；
 *   win 贏＝往上的三個音；loss 輸＝輕的往下三個音；draw 和＝中性的一個輕音；resign 長按認輸＝跟輸一樣；sjCard 神將的開場字卡＝一聲低沉的鐘（約 1.2 秒收掉）。
 * 電腦走的步、兩人同機都一樣。
 *
 * 規矩：
 *   - AudioContext 只在使用者的手勢裡建、裡面 resume（第一次點、按、按鍵；iOS 一定要這樣）。不是真的手勢（isTrusted false）不算。建不起來就安安靜靜不出聲。
 *   - 設定的「音效」關著：不建、不出聲、不記；開著才建（下一次手勢）。
 *   - 頁面藏起來（visibilitychange）：不出聲、把 AudioContext 暫停；回來再 resume（不給 resume 就等下一次手勢）。
 *   - 減少動態效果、動畫「無」都不關音效。
 *   - 總音量 −12 dB（MASTER_DB）；每一聲自己的大小在 LEVEL。
 *   - log：最近 100 筆真的要出聲的事件 { ev, sound, step, voiced, at }（voiced＝AudioContext 在跑、真的排進去了）。測試小門與 b01 的 SD 段用。
 *   - renderInto(ctx, dest, ev, t0, opts)：把一個事件的聲音排進任何一個 BaseAudioContext（OfflineAudioContext 也行），回傳長度（秒）。play 也走這一條。
 */
(function (root, factory) {
  var S = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = S;
  else root.BanqiSound = S;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var MASTER_DB = -12;
  var MASTER = Math.pow(10, MASTER_DB / 20); // ≈ 0.251

  // 事件 → 聲音。null＝不出聲（照樣列出來，表才完整）
  var EVENTS = {
    flip: 'flip',
    move: 'tap',
    capture: 'clack',
    attackFail: 'thud',
    stop: null,
    illegal: null,
    win: 'win',
    loss: 'loss',
    draw: 'draw',
    resign: 'loss',
    sjCard: 'gong'
  };
  // 每一聲的長度（秒；包絡收到 −80 dB 以下、振盪器停掉的時間）與大小（乘在 MASTER 前面）
  var DUR = { flip: 0.26, tap: 0.13, clack: 0.24, thud: 0.24, win: 0.98, loss: 1.04, draw: 0.72, gong: 2.0 };
  var LEVEL = { flip: 0.8, tap: 0.75, clack: 0.85, thud: 0.9, win: 0.62, loss: 0.55, draw: 0.5, gong: 0.75 };
  var STEP_SEMI = 2, STEP_MAX = 7; // 連吃：每多一吃高 2 個半音，第 7 吃以後不再高

  // ------------------------------------------------------------ 小零件
  // 雜訊：每個 context 一份 1 秒的白雜訊（固定種子，離線算出來每次都一樣）
  var noiseCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function noiseBuf(ctx) {
    var b = noiseCache && noiseCache.get(ctx);
    if (b) return b;
    var n = Math.floor(ctx.sampleRate), s = 0x2545f491;
    b = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = b.getChannelData(0);
    for (var i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; d[i] = ((s >>> 0) / 4294967296) * 2 - 1; }
    if (noiseCache) noiseCache.set(ctx, b);
    return b;
  }
  // 包絡：t0 起 att 秒線性上到 peak，再 dec 秒指數收到 −80 dB，之後歸零
  function env(g, t0, peak, att, dec) {
    var p = g.gain;
    p.setValueAtTime(0, t0);
    p.linearRampToValueAtTime(peak, t0 + att);
    p.exponentialRampToValueAtTime(peak * 1e-4, t0 + att + dec);
    p.setValueAtTime(0, t0 + att + dec + 0.001);
    return t0 + att + dec + 0.002;
  }
  // 一個音：f 起、f1 收（音高往下掉一點像木頭），type 預設 sine
  function tone(ctx, out, t0, o) {
    var osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t0);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t0 + (o.glide || o.dec));
    if (o.detune) osc.detune.setValueAtTime(o.detune, t0);
    var end = env(g, t0, o.peak, o.att || 0.002, o.dec);
    osc.connect(g); g.connect(out);
    osc.start(t0); osc.stop(end + 0.01);
    return end;
  }
  // 一段雜訊：過一個濾波器（ft 類型、f 頻率、q；f1＝頻率掃到哪裡）
  function noise(ctx, out, t0, o) {
    var src = ctx.createBufferSource(), flt = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = noiseBuf(ctx);
    flt.type = o.ft || 'bandpass';
    flt.frequency.setValueAtTime(o.f, t0);
    if (o.f1) flt.frequency.exponentialRampToValueAtTime(o.f1, t0 + (o.sweep || (o.att + o.dec)));
    flt.Q.setValueAtTime(o.q || 1, t0);
    var end;
    if (o.swell) { // 先慢慢大起來再收（翻子的「唰」）
      var p = g.gain;
      p.setValueAtTime(0, t0);
      p.linearRampToValueAtTime(o.peak, t0 + o.att);
      p.exponentialRampToValueAtTime(o.peak * 1e-4, t0 + o.att + o.dec);
      p.setValueAtTime(0, t0 + o.att + o.dec + 0.001);
      end = t0 + o.att + o.dec + 0.002;
    } else end = env(g, t0, o.peak, o.att || 0.001, o.dec);
    src.connect(flt); flt.connect(g); g.connect(out);
    src.start(t0, (o.off || 0) % 0.9); src.stop(end + 0.01);
    return end;
  }
  // 木琴一樣的音（翻牌與結束的音用）：基音＋第 4 倍左右的泛音（木琴的第二個模態）＋一點槌頭的雜訊
  function mallet(ctx, out, t0, f, peak, dec, bright) {
    tone(ctx, out, t0, { f: f, peak: peak, att: 0.004, dec: dec });
    tone(ctx, out, t0, { f: f * 3.93, peak: peak * (bright == null ? 0.22 : bright), att: 0.002, dec: dec * 0.22 });
    tone(ctx, out, t0, { f: f * 2, peak: peak * 0.08, att: 0.003, dec: dec * 0.4 });
    noise(ctx, out, t0, { f: Math.min(f * 4, 6000), q: 1.4, peak: peak * 0.18, att: 0.001, dec: 0.012, off: f / 1000 });
  }

  // ------------------------------------------------------------ 各聲（ctx、out、開始時間、opts）
  var SOUNDS = {
    // 走到空格：輕輕敲一下木頭
    tap: function (ctx, out, t0) {
      noise(ctx, out, t0, { f: 3200, q: 0.9, peak: 0.32, att: 0.0008, dec: 0.012, off: 0.11 });
      tone(ctx, out, t0, { f: 820, f1: 760, peak: 0.5, att: 0.0015, dec: 0.065 });
      tone(ctx, out, t0, { f: 2050, peak: 0.14, att: 0.001, dec: 0.028 });
      tone(ctx, out, t0, { f: 210, f1: 150, peak: 0.3, att: 0.002, dec: 0.05 });
    },
    // 吃子：比較重的「喀」——兩片木頭撞一下（第二下是被吃的那一子），音高照連吃的第幾吃往上
    clack: function (ctx, out, t0, o) {
      var k = Math.max(1, Math.min(STEP_MAX, (o && o.step) | 0 || 1)), r = Math.pow(2, (k - 1) * STEP_SEMI / 12);
      noise(ctx, out, t0, { f: 2500 * r, q: 0.8, peak: 0.55, att: 0.0008, dec: 0.018, off: 0.23 });
      noise(ctx, out, t0 + 0.013, { f: 1800 * r, q: 1.1, peak: 0.28, att: 0.0008, dec: 0.016, off: 0.37 });
      tone(ctx, out, t0, { f: 540 * r, f1: 495 * r, peak: 0.62, att: 0.0015, dec: 0.11 });
      tone(ctx, out, t0, { f: 1390 * r, peak: 0.26, att: 0.001, dec: 0.05 });
      tone(ctx, out, t0, { f: 2940 * r, peak: 0.08, att: 0.001, dec: 0.022 });
      tone(ctx, out, t0, { f: 150 * r, f1: 100 * r, peak: 0.45, att: 0.002, dec: 0.09 });
    },
    // 翻暗子：紙一樣的「唰」（帶通雜訊往上掃、先大起來再收），接一聲輕的「叩」
    flip: function (ctx, out, t0) {
      noise(ctx, out, t0, { f: 900, f1: 3600, sweep: 0.12, q: 1.1, peak: 0.24, att: 0.06, dec: 0.08, swell: true, off: 0.51 });
      noise(ctx, out, t0, { ft: 'highpass', f: 4500, q: 0.7, peak: 0.07, att: 0.05, dec: 0.06, swell: true, off: 0.63 });
      var tk = t0 + 0.15;
      noise(ctx, out, tk, { f: 3600, q: 1, peak: 0.2, att: 0.0008, dec: 0.008, off: 0.71 });
      tone(ctx, out, tk, { f: 1080, f1: 1010, peak: 0.42, att: 0.0015, dec: 0.05 });
      tone(ctx, out, tk, { f: 260, f1: 200, peak: 0.15, att: 0.002, dec: 0.03 });
    },
    // 攻擊暗子失敗：悶的「咚」，沒有高頻（中低頻在手機喇叭上也聽得到）
    thud: function (ctx, out, t0) {
      tone(ctx, out, t0, { f: 250, f1: 160, glide: 0.1, peak: 0.55, att: 0.003, dec: 0.15 });
      tone(ctx, out, t0, { f: 115, f1: 80, glide: 0.12, peak: 0.5, att: 0.004, dec: 0.16 });
      tone(ctx, out, t0, { f: 420, f1: 380, peak: 0.2, att: 0.002, dec: 0.04 }); // 手機喇叭放不出 200 Hz 以下：靠這一支讓人聽得到
      noise(ctx, out, t0, { ft: 'lowpass', f: 650, q: 0.7, peak: 0.5, att: 0.002, dec: 0.045, off: 0.81 });
    },
    // 贏：Do Mi Sol 往上（最後一個音長一點）
    win: function (ctx, out, t0) {
      mallet(ctx, out, t0, 523.25, 0.42, 0.34);
      mallet(ctx, out, t0 + 0.12, 659.25, 0.42, 0.34);
      mallet(ctx, out, t0 + 0.24, 783.99, 0.48, 0.72);
    },
    // 輸：輕的 Sol Mi♭ Do 往下（泛音少、慢一點）
    loss: function (ctx, out, t0) {
      mallet(ctx, out, t0, 392.0, 0.4, 0.3, 0.1);
      mallet(ctx, out, t0 + 0.17, 311.13, 0.36, 0.3, 0.1);
      mallet(ctx, out, t0 + 0.34, 261.63, 0.38, 0.68, 0.1);
    },
    // 和：一個中性的輕音（La）
    draw: function (ctx, out, t0) {
      tone(ctx, out, t0, { f: 440, peak: 0.42, att: 0.012, dec: 0.68 });
      tone(ctx, out, t0, { f: 880, peak: 0.07, att: 0.01, dec: 0.3 });
      noise(ctx, out, t0, { f: 1800, q: 1.2, peak: 0.05, att: 0.001, dec: 0.012, off: 0.05 });
    },
    // 神將：一聲低沉的鐘。泛音照吊鐘的比例（hum 0.5、prime 1、小三度 1.2、五度 1.5、八度 2…），低的收得慢；hum 兩支差一點點，會慢慢地「嗡」
    gong: function (ctx, out, t0) {
      // [對 prime 的倍數, 大小, 收到 −80 dB 的秒數, 起音, detune（cent）]；整聲收到最大 −60 dB 約 1.2 秒
      var f = 196, P = [[0.5, 0.2, 1.95, 0.012, 0], [0.5, 0.2, 1.9, 0.012, 9], [1, 0.3, 1.6, 0.006, 0], [1.2, 0.2, 1.25, 0.004, 0], [1.5, 0.11, 1.0, 0.004, 0],
        [2, 0.24, 1.2, 0.003, 0], [2.52, 0.09, 0.6, 0.002, 0], [2.67, 0.07, 0.55, 0.002, 0], [3.01, 0.05, 0.42, 0.002, 0], [4.17, 0.035, 0.26, 0.002, 0]];
      P.forEach(function (p) { tone(ctx, out, t0, { f: f * p[0], peak: p[1], att: p[3], dec: p[2], detune: p[4] }); });
      noise(ctx, out, t0, { ft: 'lowpass', f: 1400, q: 0.8, peak: 0.22, att: 0.002, dec: 0.06, off: 0.33 });
    }
  };

  // 把一個事件的聲音排進 ctx（任何 BaseAudioContext），接到 dest。回傳長度（秒）；不出聲的事件回 0
  function renderInto(ctx, dest, ev, t0, opts) {
    var name = EVENTS[ev];
    if (!name) return 0;
    var g = ctx.createGain();
    g.gain.value = LEVEL[name];
    g.connect(dest);
    SOUNDS[name](ctx, g, t0, opts || {});
    return DUR[name];
  }

  // ------------------------------------------------------------ 瀏覽器：AudioContext、手勢、頁面藏起來
  var W = typeof window !== 'undefined' && window && typeof window.addEventListener === 'function' ? window : null;
  var D = W && W.document ? W.document : null;
  var on = true, ctx = null, master = null, made = 0, by = null, broken = false, log = [], resumeAt = 0;
  function hidden() { return !!D && D.visibilityState === 'hidden'; }
  function quiet(p) { if (p && typeof p.catch === 'function') p.catch(function () {}); }
  function unlock(e) {
    if (e && e.isTrusted === false) return; // 程式送的事件不是手勢
    if (!on || broken || hidden()) return;
    var AC = W.AudioContext || W.webkitAudioContext;
    if (!AC) { broken = true; return; }
    try {
      if (!ctx) {
        // iOS 17+：ambient＝跟別的 app 的音樂混在一起、照靜音鍵（不打斷使用者在聽的東西）
        try { if (W.navigator && W.navigator.audioSession) W.navigator.audioSession.type = 'ambient'; } catch (err) { /* 不支援就算了 */ }
        ctx = new AC();
        made++;
        by = e ? e.type : null;
        master = ctx.createGain();
        master.gain.value = MASTER;
        master.connect(ctx.destination);
        // 舊的 iOS：手勢裡播一個無聲的 buffer 才算解鎖
        var s = ctx.createBufferSource();
        s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        s.connect(ctx.destination);
        s.start(0);
      }
      if (ctx.state !== 'running' && ctx.state !== 'closed') { resumeAt = Date.now(); quiet(ctx.resume()); }
    } catch (err) { broken = true; ctx = null; master = null; }
  }
  if (W) {
    ['pointerdown', 'touchend', 'mousedown', 'click', 'keydown'].forEach(function (n) { W.addEventListener(n, unlock, true); });
    if (D) D.addEventListener('visibilitychange', function () {
      if (!ctx) return;
      try {
        if (hidden()) quiet(ctx.suspend());
        else if (on) { resumeAt = Date.now(); quiet(ctx.resume()); }
      } catch (err) { /* 不給就等下一次手勢 */ }
    });
  }

  // 出聲。opts.step：連吃的第幾吃。回傳 true＝真的排進去了
  function play(ev, opts) {
    if (!W || !on || !EVENTS.hasOwnProperty(ev) || !EVENTS[ev] || hidden()) return false;
    // 在跑，或剛在手勢裡叫了 resume、還在等（第一下點的聲音不要丟掉；等太久＝不給，就不排，免得之後一起冒出來）
    var voiced = !!(ctx && master && (ctx.state === 'running' || (ctx.state === 'suspended' && Date.now() - resumeAt < 500)));
    log.push({ ev: ev, sound: EVENTS[ev], step: EVENTS[ev] === 'clack' ? (opts && opts.step) | 0 : 0, voiced: voiced, at: Date.now() }); // step 只有「喀」用得到
    if (log.length > 100) log.shift();
    if (!voiced) return false;
    try { renderInto(ctx, master, ev, ctx.currentTime + 0.005, opts); } catch (err) { return false; }
    return true;
  }
  function setEnabled(v) {
    on = !!v;
    if (!on && ctx) { try { quiet(ctx.suspend()); } catch (err) { /* 算了 */ } }
  }

  return {
    EVENTS: EVENTS,
    SOUNDS: SOUNDS,
    DUR: DUR,
    LEVEL: LEVEL,
    MASTER: MASTER,
    MASTER_DB: MASTER_DB,
    STEP_SEMI: STEP_SEMI,
    STEP_MAX: STEP_MAX,
    play: play,
    setEnabled: setEnabled,
    enabled: function () { return on; },
    renderInto: renderInto,
    log: log,
    state: function () { return { ctx: ctx ? ctx.state : null, made: made, by: by, broken: broken, on: on, hidden: hidden() }; }
  };
});
