/*
 * 暗棋 service worker。發布版才註冊：index.html 最後那一個 <script>：if (BANQI_RELEASE === true && 'serviceWorker' in navigator) register('sw.js')
 * （來源的 BANQI_RELEASE 是 false，開發時不裝；tools/release.py 在 dist/ 的副本改成 true）。
 *
 * 做法：完全離線。安裝時把整個 app（下面的 SHELL，＝ tools/release.py 的白名單去掉 sw.js 自己）抓進一個帶版本號的快取，
 * 之後同網域、在本 SW 範圍（banqi/）內的 GET 一律先查快取（cache-first），快取沒有才走網路、走網路的結果不存。
 * 例外：snd/ 底下的背景音樂不在 SHELL 裡，第一次抓到存進不分版本的 banqi-music 快取（見下面的 MUSIC_CACHE）。
 * 沒有任何 network-first 的檔。
 *
 * 版本：BANQI_VERSION 由 tools/release.py 在 dist/ 的副本裡改成這次發布的版本號（和 index.html 的 BANQI_VERSION 相同）。
 * 改了版本號 sw.js 的位元組就變了，瀏覽器會裝新的 SW：新快取裝好後 skipWaiting、clients.claim 立刻接手，
 * 舊版本的快取（名字 banqi- 開頭、不是這一版的）在 activate 時刪掉。別的 app（同一個 github.io 網域的五子棋）的快取不碰。
 *
 * 頁面載入網址帶 ?v=<版本號>（index.html 的 vurl()）；快取名字已經分版本，所以查快取時忽略查詢字串（ignoreSearch），
 * ?test=1 之類的參數也一樣對得到 index.html。
 *
 * 訊息：頁面 postMessage('version') 或 { type: 'version' }，回 { type: 'version', version: BANQI_VERSION }
 * （有 MessageChannel 的 port 就回 port，沒有就回給發訊息的那個頁面）。
 */
/* eslint-env serviceworker */
var BANQI_VERSION = 'v0.2.2';
var CACHE_PREFIX = 'banqi-';
var CACHE = CACHE_PREFIX + BANQI_VERSION;
// 背景音樂（music.js；作者 2026-10-26）：snd/ 底下的曲子一首 1–2 MB，不放進 SHELL（安裝時不下載）。
// 第一次放到那一首時從網路抓、存進 MUSIC_CACHE，之後先查快取（cache-first）。這個快取不分版本、改版時不刪（曲子不用每一版重抓）；
// 所以曲子的檔名一旦發布就不改內容，要換曲子就換一個檔名（舊的那一首留在快取裡，不會再被要到）。
// 只存完整的 200（Range 請求的 206 Cache API 存不了）：<audio> 的 Range 請求由下面的 music() 先抓整個檔存起來、再從快取切一段回 206
var MUSIC_CACHE = 'banqi-music';
var MUSIC_DIR = 'snd/';

// 要離線的檔（相對 sw.js 所在的資料夾）。和 tools/release.py 的白名單一致（release.py 會核對，不一致就是硬錯）。
var SHELL = [
  './',
  'index.html',
  'style.css',
  'engine.js',
  'ai.js',
  'ai-worker.js',
  'rating.js',
  'stats.js',
  'i18n.js',
  'replay.js',
  'sound.js',
  'music.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/favicon-32.png',
  'fonts/lxgw-wenkai-tc.woff2',
  'fonts/noto-serif-tc.woff2',
  'fonts/tw-kai.woff2',
  'fonts/LICENSES/lxgw-wenkai-tc.txt',
  'fonts/LICENSES/noto-serif-tc.txt',
  'fonts/LICENSES/tw-kai.txt',
  'fonts/LICENSES/yuji.txt'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // cache: 'reload'：跳過 HTTP 快取（GitHub Pages 給 max-age=600），一定抓到這一版的檔
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE && k !== MUSIC_CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  if (req.url.indexOf(self.registration.scope) !== 0) return; // 範圍外（別的網域、同網域的別的 app）不管
  var nav = req.mode === 'navigate';
  if (!nav && req.url.split('?')[0].indexOf(self.registration.scope + MUSIC_DIR) === 0) { e.respondWith(music(req)); return; }
  e.respondWith(caches.open(CACHE).then(function (c) {
    // 進頁面（含 ./?test=1、index.html?x）一律給快取裡的 index.html
    return c.match(nav ? 'index.html' : req, { ignoreSearch: true }).then(function (hit) {
      return hit || fetch(req);
    });
  }));
});

// snd/ 的曲子（2026-10-26：music.js 改用 <audio> 串流，<audio> 會發 Range 請求）：
//   MUSIC_CACHE 有整個檔：照 Range 從快取的 Blob 切一段回 206（Content-Range、Accept-Ranges、Content-Length）；沒有 Range 就回整個 200。
//   還沒有：不帶 Range 抓整個檔、完整的 200 存進 MUSIC_CACHE，再照原來的請求回（206 的一段或 200）。同一個檔同時好幾個請求只抓一次（inflight）。
//   存好以後離線也照樣給。抓不到（離線、還沒存過）就讓請求失敗（<audio> 出 error，music.js 跳過那一首）
var inflight = {};
function music(req) {
  var key = req.url.split('#')[0].split('?')[0]; // 快取的鍵不帶查詢字串
  return caches.open(MUSIC_CACHE).then(function (c) {
    return c.match(key).then(function (hit) {
      if (hit) return rangeResponse(req, hit);
      var p = inflight[key];
      if (!p) {
        p = inflight[key] = fetch(key, { credentials: 'same-origin' }).then(function (full) {
          if (!full || full.status !== 200) return full;
          return c.put(key, full.clone()).then(function () { return full; }, function () { return full; });
        }).then(function (r) { delete inflight[key]; return r; }, function (err) { delete inflight[key]; throw err; });
      }
      return p.then(function (full) {
        if (!full || full.status !== 200) return full;
        return c.match(key).then(function (h) { return rangeResponse(req, h || full.clone()); }); // 存不進去（空間不夠）時用抓到的那一份
      });
    });
  });
}

// Range 的值 → { start, end }（含兩端）；null＝不認得的寫法或好幾段（照 RFC 9110 可以不理 Range、給整個 200）；false＝範圍不在檔案裡（416）
//   bytes=N-M（M 超過檔尾就到檔尾）、bytes=N-（到檔尾）、bytes=-K（最後 K 個位元組，K 比檔案大就整個檔）
function parseRange(h, size) {
  var m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(String(h || ''));
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') { // 最後 K 個
    var k = Number(m[2]);
    if (k === 0 || size === 0) return false;
    return { start: Math.max(0, size - k), end: size - 1 };
  }
  var s = Number(m[1]), e = m[2] === '' ? size - 1 : Number(m[2]);
  if (m[2] !== '' && e < s) return null; // 寫反了＝不合法的寫法，不理
  if (s >= size) return false;
  return { start: s, end: Math.min(e, size - 1) };
}
// 照 req 的 Range 把完整的 200 回應 res 切成 206（或 416、整個 200）
function rangeResponse(req, res) {
  var h = req.headers.get('range');
  if (!h || !res || res.status !== 200) return Promise.resolve(res);
  var type = res.headers.get('content-type') || 'application/octet-stream';
  return res.blob().then(function (b) {
    var r = parseRange(h, b.size);
    if (r === null) return new Response(b, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(b.size), 'Accept-Ranges': 'bytes' } });
    if (r === false) return new Response('', { status: 416, statusText: 'Range Not Satisfiable', headers: { 'Content-Range': 'bytes */' + b.size, 'Accept-Ranges': 'bytes' } });
    return new Response(b.slice(r.start, r.end + 1, type), { status: 206, statusText: 'Partial Content', headers: {
      'Content-Type': type, 'Content-Range': 'bytes ' + r.start + '-' + r.end + '/' + b.size, 'Content-Length': String(r.end - r.start + 1), 'Accept-Ranges': 'bytes' } });
  });
}

self.addEventListener('message', function (e) {
  var d = e.data;
  if (d !== 'version' && !(d && d.type === 'version')) return;
  var msg = { type: 'version', version: BANQI_VERSION };
  if (e.ports && e.ports[0]) e.ports[0].postMessage(msg);
  else if (e.source) e.source.postMessage(msg);
});
