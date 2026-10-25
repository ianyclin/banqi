/*
 * 暗棋 service worker（草稿：還沒有任何地方註冊它；要接上時見 tools/README-release.md 的「index.html 接線清單」）。
 *
 * 做法：完全離線。安裝時把整個 app（下面的 SHELL，＝ tools/release.py 的白名單去掉 sw.js 自己）抓進一個帶版本號的快取，
 * 之後同網域、在本 SW 範圍（banqi/）內的 GET 一律先查快取（cache-first），快取沒有才走網路、走網路的結果不存。
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
var BANQI_VERSION = 'v0.1.3';
var CACHE_PREFIX = 'banqi-';
var CACHE = CACHE_PREFIX + BANQI_VERSION;

// 要離線的檔（相對 sw.js 所在的資料夾）。和 tools/release.py 的白名單一致（release.py 會核對，不一致就是硬錯）。
var SHELL = [
  './',
  'index.html',
  'style.css',
  'engine.js',
  'ai.js',
  'ai-worker.js',
  'stats.js',
  'i18n.js',
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
  'fonts/LICENSES/tw-kai.txt'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // cache: 'reload'：跳過 HTTP 快取（GitHub Pages 給 max-age=600），一定抓到這一版的檔
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  if (req.url.indexOf(self.registration.scope) !== 0) return; // 範圍外（別的網域、同網域的別的 app）不管
  var nav = req.mode === 'navigate';
  e.respondWith(caches.open(CACHE).then(function (c) {
    // 進頁面（含 ./?test=1、index.html?x）一律給快取裡的 index.html
    return c.match(nav ? 'index.html' : req, { ignoreSearch: true }).then(function (hit) {
      return hit || fetch(req);
    });
  }));
});

self.addEventListener('message', function (e) {
  var d = e.data;
  if (d !== 'version' && !(d && d.type === 'version')) return;
  var msg = { type: 'version', version: BANQI_VERSION };
  if (e.ports && e.ports[0]) e.ports[0].postMessage(msg);
  else if (e.source) e.source.postMessage(msg);
});
