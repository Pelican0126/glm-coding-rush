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

  /*
   * sync(url, samples=5) —— 多次采样取中位数 offset（毫秒）。
   * 失败的单次会被跳过；全部失败返回 0（即视为不偏移，保守处理）。
   * 同时优先采用 rtt 较小的样本（网络抖动小，更可信）。
   */
  async function sync(url, samples) {
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
    sync: sync,
    now: now,
    _median: median
  };
})();
