/*
 * timesync.js — GLM 抢购助手 时间同步库
 * 挂载到 self.GLM.timesync（IIFE，不使用 ES module）。
 *
 * 原理：发起一个 no-store 的轻量请求，读取响应头里的 HTTP `Date`，
 * 用 rtt/2 校正网络单程延迟，得到「服务器时间 - 本地时间」的偏移 offset。
 *
 * ⚠️ 精度说明（重要）：
 *   HTTP `Date` 响应头只精确到「秒」，没有毫秒。
 *   因此单次测得的 offset 误差量级约为 ±500ms（取决于 Date 落在该秒的何处 + rtt 抖动）。
 *   多次采样取中位数可降低抖动，但无法突破秒级量级的系统性误差。
 *   => 真正的毫秒级对齐由 content.js 在 T0 附近用 rAF/performance.now 自旋 +
 *      config.advanceMs（提前量）+ T0 附近的「短时间重试爆发」来补偿，
 *      而不是依赖本库给出毫秒级真值。
 *
 * API：
 *   async measureOnce(url) -> { offset, rtt }
 *   async sync(url, samples=5) -> 中位数 offset（毫秒）
 *   now(offset) -> Date.now() + offset  （估算的服务器当前时间）
 */
(function () {
  "use strict";
  var G = (self.GLM = self.GLM || {});

  // 默认用真实 bigmodel 页面做采样
  var DEFAULT_URL = "https://open.bigmodel.cn/glm-coding";

  /*
   * measureOnce(url) —— 单次测量。
   * 返回 { offset, rtt }；失败时抛出异常，由上层处理。
   */
  async function measureOnce(url) {
    var target = url || DEFAULT_URL;
    var t0 = Date.now();
    // 缓存破坏参数，避免命中缓存导致 Date 失真
    var bust = (target.indexOf("?") === -1 ? "?" : "&") + "_ts=" + t0;
    var resp = await fetch(target + bust, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "follow"
    });
    var t1 = Date.now();
    var rtt = t1 - t0;
    var dateHeader = resp.headers.get("date");
    if (!dateHeader) {
      throw new Error("响应缺少 Date 头，无法同步时间");
    }
    var serverMs = new Date(dateHeader).getTime();
    if (isNaN(serverMs)) {
      throw new Error("Date 头解析失败: " + dateHeader);
    }
    // 估算「请求中点」对应的本地时间，再与服务器秒级时间求差。
    // 服务器时间记录于响应生成时刻，近似 t0 + rtt/2。
    var localMid = t0 + rtt / 2;
    var offset = serverMs - localMid;
    return { offset: offset, rtt: rtt };
  }

  // 取数组中位数
  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) {
      return a - b;
    });
    var mid = Math.floor(s.length / 2);
    if (s.length % 2) return s[mid];
    return (s[mid - 1] + s[mid]) / 2;
  }

  // ===== 毫秒级对时：从接口 JSON 响应体取服务器毫秒时间戳（若存在）=====
  // HTTP Date 头只有秒级；若某接口响应体带服务器 ms 时间戳，精度可达 ~RTT/2(几十 ms)。
  // 候选接口(同源，登录态可达)；若都不带 ts，则自动回退到 Date 头，无任何回归。
  var API_TS_URLS = [
    "https://open.bigmodel.cn/api/biz/tokenResPack/productIdInfo",
    "https://open.bigmodel.cn/api/biz/operation/query?ids=1111"
  ];
  var TS_FIELDS = ["timestamp", "serverTime", "serverTimestamp", "ts", "now", "time", "currentTime", "sysTime", "systemTime", "respTime", "responseTime"];
  var _lastSource = "";

  // 递归在 JSON 里找"像 epoch 毫秒(13位, 约 2001~2100)"的时间戳，优先常见字段名
  function findEpochMs(obj, depth) {
    if (obj == null || depth > 4) return 0;
    try {
      if (typeof obj === "number") return (obj > 1e12 && obj < 4102444800000) ? obj : 0;
      if (typeof obj === "string") {
        if (/^\d{13}$/.test(obj)) { var nn = parseInt(obj, 10); return (nn > 1e12 && nn < 4102444800000) ? nn : 0; }
        return 0;
      }
      if (typeof obj === "object") {
        for (var i = 0; i < TS_FIELDS.length; i++) {
          if (obj[TS_FIELDS[i]] != null) { var g1 = findEpochMs(obj[TS_FIELDS[i]], depth + 1); if (g1) return g1; }
        }
        for (var k in obj) {
          if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
          var g2 = findEpochMs(obj[k], depth + 1);
          if (g2) return g2;
        }
      }
    } catch (e) {}
    return 0;
  }

  async function measureOnceApi(url) {
    var bust = (url.indexOf("?") === -1 ? "?" : "&") + "_ts=" + Date.now();
    var t0 = Date.now();
    var resp = await fetch(url + bust, { method: "GET", cache: "no-store", credentials: "include", redirect: "follow" });
    var t1 = Date.now();
    var data;
    try { data = await resp.json(); } catch (e) { return null; }
    var serverMs = findEpochMs(data, 0);
    if (!serverMs) return null;
    var rtt = t1 - t0;
    return { offset: serverMs - (t0 + rtt / 2), rtt: rtt };
  }

  // 找到第一个带 ms 时间戳的接口，对它采样 n 次取(低 rtt 半数的)中位数；无可用源返回 null
  async function syncApi(urls, samples) {
    var list = urls || API_TS_URLS;
    var n = samples || 5;
    var good = null;
    for (var i = 0; i < list.length; i++) {
      try { var probe = await measureOnceApi(list[i]); if (probe) { good = list[i]; break; } } catch (e) {}
    }
    if (!good) return null;
    var results = [];
    for (var k = 0; k < n; k++) {
      try { var r = await measureOnceApi(good); if (r) results.push(r); } catch (e) {}
    }
    if (!results.length) return null;
    results.sort(function (a, b) { return a.rtt - b.rtt; });
    var keep = results.slice(0, Math.max(1, Math.ceil(results.length / 2)));
    return median(keep.map(function (r) { return r.offset; }));
  }

  /*
   * sync(url, samples=5) —— 优先用接口毫秒时间戳，回退 HTTP Date 头；取中位数 offset（毫秒）。
   * 失败的单次会被跳过；全部失败返回 0（即视为不偏移，保守处理）。优先采用 rtt 较小的样本。
   */
  // 默认关闭接口毫秒对时：已实测 bigmodel 候选接口均不带服务器 ms 时间戳（findEpochMs 找不到），
  // 开启只会在每次对时前多打 2 个带 cookie 的探测请求、徒增噪声/风控面，对精度无任何提升。
  // 保留实现并可在 future 通过 enableApiSync(true) 打开（若某天接口开始返回 ms 时间戳）。
  var _apiEnabled = false;

  async function sync(url, samples) {
    // 优先：接口响应体里的服务器毫秒时间戳（精度 ~RTT/2）—— 默认关闭，见 _apiEnabled 注释
    if (_apiEnabled) {
      try {
        var apiOff = await syncApi(null, samples);
        if (apiOff != null && isFinite(apiOff)) { _lastSource = "api-ms"; return apiOff; }
      } catch (e) {}
    }
    // 回退/默认：HTTP Date 头（仅秒级，±500ms，由 advanceMs+重试补偿）
    _lastSource = "date-header";
    var n = samples || 5;
    var results = [];
    for (var i = 0; i < n; i++) {
      try {
        var r = await measureOnce(url);
        results.push(r);
      } catch (e) {
        // 跳过失败样本
      }
    }
    if (!results.length) return 0;
    // 按 rtt 升序，取较可靠的前若干个（至少一半）求中位数
    results.sort(function (a, b) {
      return a.rtt - b.rtt;
    });
    var keep = results.slice(0, Math.max(1, Math.ceil(results.length / 2)));
    var offsets = keep.map(function (r) {
      return r.offset;
    });
    return median(offsets);
  }

  /*
   * now(offset) —— 用已知 offset 估算服务器当前毫秒时间戳。
   */
  function now(offset) {
    return Date.now() + (offset || 0);
  }

  G.timesync = {
    DEFAULT_URL: DEFAULT_URL,
    measureOnce: measureOnce,
    measureOnceApi: measureOnceApi,
    syncApi: syncApi,
    sync: sync,
    now: now,
    enableApiSync: function (b) { _apiEnabled = !!b; }, // 默认 false：接口无 ms 时间戳，见 _apiEnabled 注释
    apiSyncEnabled: function () { return _apiEnabled; },
    lastSource: function () { return _lastSource; },
    _median: median
  };
})();
