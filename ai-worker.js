/*
 * 暗棋：電腦對手的 Worker（第三步 b）。畫面（app.js）每輪到電腦就送一個
 *   { type: 'think', id, view, level, seed, mode, nodes? }
 * view 只有引擎的 publicView（沒有暗子身分）；這裡也只把它交給 BanqiAI.think。
 * 回送：{ type: 'progress', id, depth, nodes, ms }（每算完一層）、{ type: 'move', id, move, depth, nodes, ms, reason }，出錯時 { type: 'error', id, message }。
 * 取消＝畫面直接 terminate 這個 Worker（認輸、回首頁、新局）。
 * 單一檔案版（file://、artifact）：app.js 把 engine.js、ai.js、這個檔的原始碼接成一個 Blob 開 Worker，這時 BanqiAI 已經在了，不用 importScripts。
 */
/* global importScripts, BanqiAI */
// 版本號：載入網址的 ?v=（app.js 用 vurl('ai-worker.js') 開）一路帶給 engine.js、ai.js；Blob 版（單一檔案）的網址是 blob:，VQ 是空字串
var VQ = (/[?&]v=([^&#]*)/.exec(self.location.href) || [])[1];
VQ = VQ ? '?v=' + VQ : '';
var BANQI_WORKER_VERSION = 'v0.1.4'; // 發布時 release.py 改成和 BANQI_VERSION 一樣
if (typeof BanqiAI === 'undefined') importScripts('engine.js' + VQ, 'ai.js' + VQ);
self.onmessage = function (e) {
  var d = e.data || {};
  if (d.type !== 'think') return;
  try {
    var opts = {
      level: d.level, seed: d.seed, mode: d.mode,
      onProgress: function (p) { self.postMessage({ type: 'progress', id: d.id, depth: p.depth, nodes: p.nodes, ms: p.ms }); }
    };
    if (d.nodes !== undefined) opts.nodes = d.nodes; // 只有測試小門會傳（把 L6 的節點預算調小）
    var r = BanqiAI.think(d.view, opts);
    self.postMessage({ type: 'move', id: d.id, move: r.move, depth: r.depth, nodes: r.nodes, ms: r.ms, reason: r.reason });
  } catch (err) {
    self.postMessage({ type: 'error', id: d.id, message: String(err && err.message || err) });
  }
};
