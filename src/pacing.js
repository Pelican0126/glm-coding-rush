/*
 * pacing.js — GLM 抢购助手 节奏决策纯函数
 * 挂载到 self.GLM.pacing(IIFE,classic script,无 ES module)。
 * 零依赖(不碰 chrome.* / DOM),因此可用 node --test 直接单测(tests/pacing.test.js)。
 * 约定:所有「何时刷新/延迟多少/要不要预刷」的**决策**集中在这里,content.js 只负责执行。
 */
(function () {
  "use strict";
  var G = (self.GLM = self.GLM || {});

  /*
   * reloadCycleMs(elapsedSinceFireMs, cfg) — 开抢后「售罄重载」的周期(渐进长尾)。
   *   0–60s    : reloadIntervalMs(默认 1200ms)——秒罄放量窗口,猛刷
   *   60s–5min : slowReloadIntervalMs(默认 4000ms)——退单回流高发段
   *   5–15min  : ≥8000ms
   *   >15min   : ≥15000ms——长尾兜底,礼貌为先
   * 档位间用 Math.max 链保证单调不减(用户乱配也不会倒挂)。
   * 60s 爆发窗口刻意写死不读配置:①秒罄放量几秒内售罄,60s 已够,再长只是徒增
   * 上百次卡片接口重拉、把自己刷进软限流(2026-06-29 实测漏抢主因);②老用户已
   * 持久化的旧配置盖不掉新默认值,写死才能"重载扩展即生效"。
   * 效果:1 小时重试窗口的重载总量 ~880 次 → ~365 次(50+60+75+180)。
   */
  function reloadCycleMs(elapsedSinceFireMs, cfg) {
    var fast = (cfg && cfg.reloadIntervalMs) || 1200;
    var slow = (cfg && cfg.slowReloadIntervalMs) || 4000;
    var t2 = Math.max(fast, slow);
    var t3 = Math.max(t2, 8000);
    var t4 = Math.max(t3, 15000);
    if (!(elapsedSinceFireMs > 60000)) return fast; // 含 elapsed<=0 防御:开抢前误入也只给快档
    if (elapsedSinceFireMs <= 300000) return t2;
    if (elapsedSinceFireMs <= 900000) return t3;
    return t4;
  }

  /*
   * reloadDelayMs(elapsedSinceFireMs, floorMs, jitterFn, goldenMs) — 重载「执行延迟」。
   * 开抢后头 goldenMs(默认 5s)是黄金窗口:0ms 立即执行——重载「节奏」已由外层周期闸
   * (since > max(RELOAD_FLOOR_MS, cycle))保证 ≥ 地板,零执行延迟不违反礼貌限速,
   * 却能在关键路径省下 jitter(250)≈175~325ms。窗口外回到 jitterFn(floorMs) 抖动。
   * elapsed<0(开抢前,理应被 buyPhase 闸挡住)防御性给抖动延迟,不给零。
   */
  function reloadDelayMs(elapsedSinceFireMs, floorMs, jitterFn, goldenMs) {
    var g = goldenMs || 5000;
    if (elapsedSinceFireMs >= 0 && elapsedSinceFireMs < g) return 0;
    return jitterFn(floorMs);
  }

  /*
   * shouldPreReload(remainMs, pageAgeMs, opts) — 倒计时 T-N 秒「一次性预刷新」决策。
   * 目的:预热在 T-90s 加载页面,若不预刷,T0 第一拍看到的是 90s 前的旧数据(必然
   * "售罄")→ 还要再等一轮重载(~1.2s)才见到新鲜库存。T-2.5s 预刷一次,T0 即见
   * ~2s 新的数据;若站点提前几秒翻牌(运营手动放量常见),T0 一到立即可点。
   * 幂等:要求页面已"旧"(pageAgeMs ≥ 10s)。预刷后的新页 pageAge 从 0 起算,
   * 天然不会二次预刷;remain<=0(已到点)也绝不预刷(不与买入窗口抢跑)。
   */
  function shouldPreReload(remainMs, pageAgeMs, opts) {
    var win = (opts && opts.windowMs) || 2500;
    var minAge = (opts && opts.minPageAgeMs) || 10000;
    return remainMs > 0 && remainMs <= win && pageAgeMs >= minAge;
  }

  G.pacing = {
    reloadCycleMs: reloadCycleMs,
    reloadDelayMs: reloadDelayMs,
    shouldPreReload: shouldPreReload
  };
})();
