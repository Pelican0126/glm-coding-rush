/*
 * content.js — GLM Coding Plan 抢购 内容脚本（注入到 open.bigmodel.cn 已登录页面）
 *
 * 依赖（manifest 中按顺序在本文件之前注入，共享 isolated world，挂在 self.GLM 上）：
 *   - selectors.js  -> GLM.selectors （BUY_BTN/CONFIRM_PAY/PAY_DIALOG/CAPTCHA_APPID,
 *                      SOLD_OUT/BUYABLE/BUSY, getVueStore/resolveProduct/findBuyBtnForCard,
 *                      isBuyable/isSoldOut/isBusyPage/captchaOpen/payDialogOpen）
 *   - logger.js     -> GLM.logger  （info/success/warn/error(tag,msg)，fmt，_sink）
 *   - timesync.js   -> GLM.timesync（measureOnce/sync/now）
 *
 * 职责（严格对照契约 BEHAVIOR content.js）：
 *   1. 上线即注册（contentReady），并从 storage 标志位「断点恢复」（页面可能在抢购中被刷新）
 *   2. 收到 "go"：预热(preconnect/dns-prefetch) + resolveProduct + 缓存 productId + MutationObserver
 *   3. rAF + performance.now 自旋等待到 fireAt - advanceMs
 *   4. tryBuy 循环：弹窗冻结 / 可购买点击 / 验证码大声移交 / 售罄分级重试 / 限流恢复
 *   5. 验证码人工通过后：stopPoint==="hold" -> 点击确认支付(create-sign)占位 -> 停在支付页
 *                       stopPoint==="beforeConfirm" -> 停在支付弹窗不点确认
 *   6. dryRun：完整检测与计时、全程记日志，但绝不真正点击 .buy-btn / .confirm-pay-btn
 *   7. 支付安全：若支付页显示 ¥0 / 无金额，记 error 视为失败；绝不进入真实付款
 *
 * 反滥用（不可协商）：重试/刷新地板 250ms + 抖动；绝不破解/绕过验证码；停在支付前；单账号。
 */
(function () {
  "use strict";

  var G = self.GLM || {};
  var S = G.selectors || {};
  var L = G.logger || {
    // 兜底空 logger，避免依赖缺失时崩溃
    info: function () {}, success: function () {}, warn: function () {}, error: function () {}
  };
  var T = G.timesync || {
    now: function (o) { return Date.now() + (o || 0); },
    sync: function () { return Promise.resolve(0); }
  };

  var P = G.pacing || {
    // pacing.js 未加载时的保守兜底(不应发生;manifest 顺序保证先加载)
    reloadCycleMs: function (e, c) { return (c && c.reloadIntervalMs) || 1200; },
    reloadDelayMs: function (e, f, j) { return j(f); },
    shouldPreReload: function () { return false; }
  };

  // 仅在目标站点运行（bigmodel）。其它域名直接退出。
  var SITE = "bigmodel";
  var SITE_URL = "https://open.bigmodel.cn/glm-coding";

  // 本次内容脚本(=本次页面加载)的起始时刻。内容脚本每次页面加载都会重新执行，故此值即「本页加载时刻」，
  // 用于给 SPA 挂载渲染卡片留「宽限期」：刚加载就判无卡片不应立刻重载（Vue 还没挂载完）。
  var SCRIPT_START = Date.now();

  // ====== 反滥用常量 ======
  var RELOAD_FLOOR_MS = 250;       // 刷新/重型请求地板间隔
  var POLL_FLOOR_MS = 250;         // 轮询地板间隔
  var JITTER = 0.3;                // ±30% 抖动
  var MAX_ATTEMPTS = 4000;         // 尝试次数硬上限（防失控）
  var FAST_ATTEMPTS = 20;          // 前 ~20 次近零延迟
  var FAST_DELAY_MS = 0;           // 近零
  var MID_DELAY_MS = 30;           // 第二档 30ms

  // ====== 运行期状态（仅内存） ======
  var ME = {
    config: null,                  // 当前 config 快照
    target: null,                  // { tier, period, productId }
    role: "primary",               // "primary" | "backup"
    isLeader: true,                // 是否为 leader（备用 tab 默认非 leader）
    offsetMs: 0,                   // 服务器时间偏移
    fireAt: 0,                     // 服务器纪元毫秒触发时刻
    running: false,                // tryBuy 循环是否在跑
    buyPhase: false,               // 是否已进入「买入窗口」(到点 fireAt 后)。倒计时期间为 false，
                                   // 用于禁止 MutationObserver/tryBuy 在开抢前就刷新页面（防开抢前自我软限流）。
    armed: false,
    dryRun: false,
    attempts: 0,                   // 已尝试次数
    fallbackIndex: 0,              // 档位降级游标（0=主目标，>0=fallbackList 第 N 个）
    soldOutRounds: 0,              // 当前档位连续「售罄重载」轮数（达阈值则降级）
    noCardRounds: 0,              // 连续「无卡片」重载轮数（疑似软限流，达阈值则退避刷新间隔）
    lastReloadAt: 0,               // 上次刷新/重型恢复时间
    lastClickAt: 0,                // 上次点击 buy 时间（去抖）
    clickedBuy: false,            // 本轮是否已点过 buy（进入验证码阶段）
    captchaAnnounced: false,       // 是否已发出验证码大声提醒
    confirmClicked: false,         // 是否已点过确认支付
    finished: false,               // 是否已收尾（ordered/reached-payment/stopped）
    observer: null,                // MutationObserver
    audioCtx: null,                // WebAudio 上下文
    beepTimer: null,               // 蜂鸣循环计时器
    banner: null,                  // 顶部大横幅
    retryTimer: null,              // 重试计时器句柄
    pollTimer: null,               // 等待验证码通过的轮询句柄
    reloadTimer: null              // 售罄/限流刷新排队的 setTimeout 句柄（stop 时需拦掉，防撤防后仍刷新）
  };

  // storage 中的运行进度标志键（断点恢复用）
  var RUN_FLAG_KEY = "runFlag";    // chrome.storage.local: { phase, target, fireAt, role, ts, stopPoint }

  // ---------------------------------------------------------------------------
  // 日志 sink：把日志通过消息送到 background（再入环形缓冲 + 广播）
  // ---------------------------------------------------------------------------
  try {
    L._sink = function (entry) {
      try {
        chrome.runtime.sendMessage({ type: "log", entry: entry });
      } catch (e) {
        // 扩展上下文失效（页面 reload 瞬间）时忽略
      }
    };
  } catch (e) {}

  function log(level, tag, msg) {
    try { (L[level] || L.info)(tag, msg); } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // 与 background 的消息便捷封装
  // ---------------------------------------------------------------------------
  function sendBg(type, extra) {
    try {
      var m = { type: type };
      if (extra) {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) m[k] = extra[k];
        }
      }
      chrome.runtime.sendMessage(m);
    } catch (e) {
      // 静默：SW 可能在重启或上下文失效
    }
  }

  function patchState(patch) {
    sendBg("state", { patch: patch || {} });
  }

  function setStatus(status, extra) {
    var p = { status: status, updatedAt: Date.now() };
    if (extra) for (var k in extra) p[k] = extra[k];
    patchState(p);
  }

  // ---------------------------------------------------------------------------
  // storage 辅助（Promise 包装）
  // ---------------------------------------------------------------------------
  function getLocal(keys) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(keys, function (res) { resolve(res || {}); });
      } catch (e) { resolve({}); }
    });
  }
  function setLocal(obj) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.set(obj, function () { resolve(); });
      } catch (e) { resolve(); }
    });
  }

  function saveRunFlag(phase) {
    try {
      var flag = {
        phase: phase,
        target: ME.target,
        fireAt: ME.fireAt,
        role: ME.role,
        stopPoint: ME.config ? ME.config.stopPoint : "hold",
        fallbackIndex: ME.fallbackIndex || 0,
        soldOutRounds: ME.soldOutRounds || 0,
        noCardRounds: ME.noCardRounds || 0,
        lastReloadAt: ME.lastReloadAt || 0, // 跨重载保留：避免刷新后 lastReloadAt 归零使退避判定的 since 恒为天文数字
        ts: Date.now()
      };
      var o = {}; o[RUN_FLAG_KEY] = flag;
      setLocal(o);
    } catch (e) {}
  }
  function clearRunFlag() {
    try { var o = {}; o[RUN_FLAG_KEY] = null; setLocal(o); } catch (e) {}
  }

  // ===== 「本轮已发起下单(create-sign)」持久闸 —— 防本账号重复占单 =====
  // 在 clickConfirmPay 真正点击「确认支付」后用 sessionStorage 按 fireAt 记一笔。
  // location.replace 同源重载 / 用户手动刷新后 sessionStorage 仍在，故任何重载/恢复路径
  // 再次进入 onBuyable/clickConfirmPay 都能据此拒绝二次下单。
  // 仅在「明确无订单」(显式失败弹窗/纯竞价重抢)时由 retryAfterFail 清除，允许安全重抢。
  var ORDER_FIRED_KEY = "glm_order_fired";
  function markOrderFired() {
    try { window.sessionStorage.setItem(ORDER_FIRED_KEY, String(ME.fireAt || 0)); } catch (e) {}
  }
  function orderAlreadyFired() {
    try {
      var v = window.sessionStorage.getItem(ORDER_FIRED_KEY);
      return !!v && v === String(ME.fireAt || 0) && (ME.fireAt || 0) !== 0;
    } catch (e) { return false; }
  }
  function clearOrderFired() {
    try { window.sessionStorage.removeItem(ORDER_FIRED_KEY); } catch (e) {}
  }
  // 已疑似下单 → 停手交人工核对，绝不二次 create-sign（硬边界：宁可漏抢不可重复占单）。
  function haltSuspectOrdered(reason) {
    log("warn", "order", "本轮已发起过下单(" + reason + ") → 停手交人工核对，不再点击购买/确认(防重复占单)");
    showBanner("⚠ 本轮疑似已下单 — 请人工核对订单/支付，勿重复购买、勿盲付", "#fb8c00");
    try { startBeepLoop(); setTimeout(stopBeepLoop, 4000); } catch (e) {}
    sendBg("orderCreated");
    setStatus("ordered");
    saveRunFlag("ordered");
    finishRun("ordered", true);
  }

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------
  function isOnSite() {
    try { return /(^|\.)bigmodel\.cn$/.test(location.hostname); } catch (e) { return false; }
  }
  function jitter(base) {
    var d = base * JITTER;
    return Math.max(0, Math.round(base - d + Math.random() * (2 * d)));
  }
  function nowSrv() { return T.now(ME.offsetMs); }

  // 邀请/优惠码(ic)：用户在设置里填的 invitationCode。空则不启用（向后兼容）。
  // 仅作用于本账号自己的订单：站点读取 URL 的 ic 写入 invitationCode，随下单(create-sign)提交。
  function couponIc() {
    try { return String((ME.config && (ME.config.coupon || ME.config.invitationCode)) || "").trim(); }
    catch (e) { return ""; }
  }

  // 生成"干净"的刷新 URL：清掉历史累积的 _h/_r/_s/_ts 缓存破坏参数，只留一个最新的，避免 URL 无限膨胀。
  // 保留页面已带的 ic；若设置了 invitationCode 则注入/覆盖，使每次重载后下单仍带优惠码。
  function reloadFreshUrl() {
    try {
      var u = new URL(location.href);
      ["_h", "_r", "_s", "_ts"].forEach(function (k) { u.searchParams.delete(k); });
      var ic = couponIc();
      if (ic) u.searchParams.set("ic", ic);
      u.searchParams.set("_h", String(Date.now()));
      return u.toString();
    } catch (e) {
      var base = location.href.split("#")[0].split("?")[0];
      var ic2 = couponIc();
      return base + "?" + (ic2 ? "ic=" + encodeURIComponent(ic2) + "&" : "") + "_h=" + Date.now();
    }
  }

  // 缓存键： site:tier:period
  function cacheKey(tier, period) { return SITE + ":" + tier + ":" + period; }

  // ---------------------------------------------------------------------------
  // 预热：preconnect / dns-prefetch（降低首包/握手延迟）
  // ---------------------------------------------------------------------------
  function preheatConnections() {
    try {
      var origin = "https://open.bigmodel.cn";
      var rels = [
        { rel: "preconnect", href: origin, cross: true },
        { rel: "dns-prefetch", href: origin }
      ];
      for (var i = 0; i < rels.length; i++) {
        var r = rels[i];
        // 避免重复注入
        if (document.querySelector('link[data-glm-preheat][rel="' + r.rel + '"]')) continue;
        var link = document.createElement("link");
        link.rel = r.rel;
        link.href = r.href;
        if (r.cross) link.crossOrigin = "anonymous";
        link.setAttribute("data-glm-preheat", "1");
        (document.head || document.documentElement).appendChild(link);
      }
      log("info", "preheat", "已注入 preconnect/dns-prefetch");
    } catch (e) {
      log("warn", "preheat", "预热注入失败: " + (e && e.message));
    }
  }

  // ---------------------------------------------------------------------------
  // 套餐分组 / 计费周期选择（关键）
  // 页面同一时刻只展示「个人套餐」下当前所选周期的 3 张卡（Lite/Pro/Max），
  // 可见的 3 个 .buy-btn 即对应这 3 张卡。若展示的不是目标周期/分组，
  // 按索引定位到的按钮就会买错周期或买到团队版 —— 故下单前必须先校正视图。
  // 结构（已实测）：周期 = div.switch-tab-item（选中含 class "active"，文本
  //   连续包月 / 连续包季9折 / 连续包年8折）；分组 = div.el-tabs__item（含 is-active）。
  // ---------------------------------------------------------------------------
  var PERIOD_KEYWORD = { month: "包月", quarter: "包季", year: "包年" };

  function ensurePersonalTab() {
    try {
      var items = document.querySelectorAll(".el-tabs__item");
      for (var i = 0; i < items.length; i++) {
        var t = (items[i].innerText || items[i].textContent || "").replace(/\s+/g, "");
        if (t.indexOf("个人") !== -1) {
          if (!/is-active/.test((items[i].className || "") + "")) {
            log("info", "tab", "切换到「个人套餐」分组");
            try { items[i].click(); } catch (e) {}
            return true; // 发生切换
          }
          return false; // 已是个人套餐
        }
      }
    } catch (e) {}
    return false;
  }

  function ensurePeriodSelected(period) {
    try {
      var key = PERIOD_KEYWORD[period] || "包月";
      var items = document.querySelectorAll(".switch-tab-item");
      var found = false;
      for (var i = 0; i < items.length; i++) {
        var t = (items[i].innerText || items[i].textContent || "").replace(/\s+/g, "");
        if (t.indexOf(key) !== -1) {
          found = true;
          if (!/(^|\s)active(\s|$)/.test((items[i].className || "") + "")) {
            log("info", "period", "切换计费周期 -> " + period + "（" + t + "）");
            try { items[i].click(); } catch (e) {}
            return true; // 发生切换
          }
          return false; // 已是目标周期
        }
      }
      if (!found) log("warn", "period", "未找到周期切换项(" + key + ")，沿用当前展示周期");
    } catch (e) {}
    return false;
  }

  // 确保「个人套餐 + 目标周期」已选中。返回是否发生过切换（切换后页面会重渲染）。
  function ensureTargetView() {
    var changed = false;
    try {
      if (ensurePersonalTab()) changed = true;
      var period = (ME.target && ME.target.period) || (ME.config && ME.config.period) || "month";
      if (ensurePeriodSelected(period)) changed = true;
    } catch (e) {}
    return changed;
  }

  // ---------------------------------------------------------------------------
  // 产品解析 + 缓存（12h TTL）
  // ---------------------------------------------------------------------------
  var CACHE_TTL_MS = 12 * 60 * 60 * 1000;

  async function readProductCache(tier, period) {
    try {
      var res = await getLocal(["productCache"]);
      var pc = res.productCache || {};
      var hit = pc[cacheKey(tier, period)];
      if (hit && hit.ts && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit;
      return null;
    } catch (e) { return null; }
  }
  async function writeProductCache(tier, period, productId, payAmount) {
    try {
      var res = await getLocal(["productCache"]);
      var pc = res.productCache || {};
      pc[cacheKey(tier, period)] = { productId: productId, payAmount: payAmount, ts: Date.now() };
      await setLocal({ productCache: pc });
    } catch (e) {}
  }

  /*
   * resolveTarget —— 解析当前 tier/period 对应的 {entry, productId, payAmount, btn}
   * 优先用 Vue store（resolveProduct），失败则用缓存的价格区间 / productId 兜底匹配。
   */
  async function resolveTarget(tier, period) {
    var out = { entry: null, productId: null, payAmount: null, btn: null, source: "none" };
    try {
      var entry = S.resolveProduct ? S.resolveProduct(tier, period) : null;
      if (entry) {
        out.entry = entry;
        out.productId = entry.productId || null;
        out.payAmount = (entry.payAmount != null) ? entry.payAmount : null;
        out.btn = S.findBuyBtnForCard ? S.findBuyBtnForCard(entry) : null;
        out.source = "store";
        // 写缓存
        if (out.productId != null) writeProductCache(tier, period, out.productId, out.payAmount);
        return out;
      }
    } catch (e) {
      log("warn", "resolve", "Vue store 解析异常: " + (e && e.message));
    }

    // store 尚未就绪 -> 价格区间/缓存兜底
    try {
      var cached = await readProductCache(tier, period);
      if (cached) {
        out.productId = cached.productId;
        out.payAmount = cached.payAmount;
        out.source = "cache";
        // 用缓存的 payAmount 做价格匹配定位按钮
        out.btn = findBtnByPrice(cached.payAmount);
        log("info", "resolve", "store 未就绪，使用缓存 productId=" + cached.productId);
        return out;
      }
    } catch (e) {}

    log("warn", "resolve", "暂未解析到目标产品（store/缓存均未命中），将持续重试");
    return out;
  }

  // 价格区间匹配按钮（store 不可用时的兜底）
  function findBtnByPrice(payAmount) {
    try {
      if (payAmount == null) return null;
      var btns = document.querySelectorAll(S.BUY_BTN || "button.buy-btn");
      var amt = String(payAmount);
      for (var i = 0; i < btns.length; i++) {
        var card = S._findCardContainer ? S._findCardContainer(btns[i]) : btns[i].parentElement;
        var ctext = S._textOf ? S._textOf(card) : (card ? card.textContent : "");
        if (ctext && (ctext.indexOf("¥" + amt) !== -1 || ctext.indexOf(amt) !== -1)) return btns[i];
      }
    } catch (e) {}
    return null;
  }

  // ---------------------------------------------------------------------------
  // MutationObserver：监视卡片/按钮区域变化（补货翻转时尽快感知）
  // ---------------------------------------------------------------------------
  function attachObserver() {
    try {
      if (ME.observer) { try { ME.observer.disconnect(); } catch (e) {} }
      var root = document.querySelector("#app") || document.body;
      if (!root) return;
      ME.observer = new MutationObserver(function () {
        // 仅在「买入窗口」(到点后)、运行中、且尚未进入点击后阶段时，借助变化“提前”触发一次检查。
        // buyPhase 守卫关键：倒计时期间页面渲染会触发大量 mutation，若此时就 tryBuy→onSoldOut→刷新，
        // 会在开抢前把卡片接口刷进软限流，到点反而出不来购买按钮（实测 bug）。
        if (!ME.buyPhase || !ME.running) return;
        if (ME.clickedBuy || ME.finished) return;
        // 不在此直接点击；标记“有变化”，让 tryBuy 的下一拍尽快执行。
        scheduleImmediateCheck();
      });
      // 缩小监听面：childList+subtree 捕获重载后卡片重新挂载（新节点插入）；
      // attributeFilter:["disabled"] 捕获售罄→可购的就地翻转（售罄按钮带 disabled）。
      // 去掉 characterData 与无过滤 attributes —— 它们在 Vue/ElementUI 上每帧高频触发，
      // 会把 scheduleImmediateCheck→tryBuy 拖成近似每帧忙轮询。
      ME.observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
      log("info", "observer", "已挂载 MutationObserver（childList+subtree+disabled）");
    } catch (e) {
      log("warn", "observer", "挂载失败: " + (e && e.message));
    }
  }

  var _immediatePending = false;
  function scheduleImmediateCheck() {
    if (_immediatePending) return;
    _immediatePending = true;
    // 取消已排队的较慢重试，立刻安排一次检查
    if (ME.retryTimer) { clearTimeout(ME.retryTimer); ME.retryTimer = null; }
    requestAnimationFrame(function () {
      _immediatePending = false;
      if (ME.buyPhase && ME.running && !ME.clickedBuy && !ME.finished) tryBuy();
    });
  }

  // ---------------------------------------------------------------------------
  // 大声提醒：WebAudio 蜂鸣循环 + 顶部固定大横幅（验证码 / 到达支付页）
  // ---------------------------------------------------------------------------
  function ensureAudio() {
    try {
      if (!ME.audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) ME.audioCtx = new AC();
      }
      if (ME.audioCtx && ME.audioCtx.state === "suspended") {
        ME.audioCtx.resume().catch(function () {});
      }
    } catch (e) {}
  }
  function beepOnce(freq, durMs) {
    try {
      if (!ME.config || ME.config.sound === false) return;
      ensureAudio();
      if (!ME.audioCtx) return;
      var ctx = ME.audioCtx;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq || 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (durMs || 200) / 1000);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + (durMs || 200) / 1000 + 0.02);
    } catch (e) {}
  }
  function startBeepLoop() {
    try {
      if (ME.beepTimer) return;
      // 间隔蜂鸣，提醒人工处理
      var hi = true;
      ME.beepTimer = setInterval(function () {
        beepOnce(hi ? 988 : 660, 220);
        hi = !hi;
      }, 700);
      beepOnce(988, 220);
    } catch (e) {}
  }
  function stopBeepLoop() {
    try {
      if (ME.beepTimer) { clearInterval(ME.beepTimer); ME.beepTimer = null; }
    } catch (e) {}
  }

  function showBanner(text, color) {
    try {
      if (!ME.banner) {
        var b = document.createElement("div");
        b.id = "glm-grab-banner";
        b.style.cssText = [
          "position:fixed", "top:0", "left:0", "right:0", "z-index:2147483647",
          "padding:18px 24px", "font-size:22px", "font-weight:700",
          "text-align:center", "color:#fff", "letter-spacing:1px",
          "box-shadow:0 4px 18px rgba(0,0,0,.35)", "font-family:system-ui,Segoe UI,Microsoft YaHei,sans-serif",
          "pointer-events:none", "white-space:pre-wrap"
        ].join(";");
        (document.documentElement || document.body).appendChild(b);
        ME.banner = b;
      }
      ME.banner.style.background = color || "#e53935";
      ME.banner.textContent = text;
      ME.banner.style.display = "block";
    } catch (e) {}
  }
  function hideBanner() {
    try { if (ME.banner) ME.banner.style.display = "none"; } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // rAF + performance.now 自旋：等待到 fireAt - advanceMs（服务器时间）
  //
  // 约定（已修正 offset 抵消问题）：ME.fireAt 是「真实服务器开售纪元毫秒」，
  // background 不再把 offset 预埋进去；这里用 server-now = Date.now()+offsetMs
  // 与之比较，offset 真正生效——本地时钟有偏差时，触发时刻仍对齐服务器。
  // ---------------------------------------------------------------------------
  function spinUntilFire() {
    return new Promise(function (resolve) {
      var advance = (ME.config && ME.config.advanceMs != null) ? ME.config.advanceMs : 150;
      var fireServer = ME.fireAt - advance; // 目标：真实服务器纪元毫秒 - 提前量
      setStatus("countdown");
      log("info", "spin", "进入精确等待，目标(服务器)=" + new Date(ME.fireAt).toLocaleTimeString() +
        "，提前量=" + advance + "ms，offset=" + Math.round(ME.offsetMs) + "ms");

      var preheatedAtT15 = false;
      function tick() {
        if (ME.finished) { resolve(); return; }
        var srvNow = nowSrv();
        var remain = fireServer - srvNow;

        if (remain <= 0) {
          log("success", "spin", "到点，开始抢购循环（剩余 " + Math.round(remain) + "ms）");
          resolve();
          return;
        }
        // T-15s 进入预热阶段状态
        if (!preheatedAtT15 && remain <= 15000) {
          preheatedAtT15 = true;
          setStatus("preheat");
          log("info", "spin", "T-15s 预热中…");
          saveRunFlag("preheat");
        }
        // 距离较远时降频（节流，避免空转），临近时用 rAF 自旋。
        // 关键：隐藏/后台标签里 Chrome 完全不触发 rAF——若临近 T0 用户恰好切走了标签，
        // 纯 rAF 会让倒计时冻住、永不开火（漏抢）。隐藏时退化为 setTimeout（后台标签
        // 被钳到 ~1s 粒度，最多迟 ~1s，远好于不触发）；切回可见后下一拍自动恢复 rAF 精度。
        if (remain > 2000) {
          setTimeout(tick, 200);
        } else if (document.hidden) {
          setTimeout(tick, 50);
        } else {
          requestAnimationFrame(tick);
        }
      }
      tick();
    });
  }

  // ---------------------------------------------------------------------------
  // tryBuy 主循环（核心）
  // ---------------------------------------------------------------------------
  function scheduleNextAttempt() {
    if (!ME.running || ME.finished || ME.clickedBuy) return;

    // 是否超过重试窗口（相对 fireAt）
    if (isPastRetryUntil()) {
      log("warn", "loop", "已到重试窗口上限，停止抢购循环");
      stopRun("stopped");
      return;
    }
    if (ME.attempts >= MAX_ATTEMPTS) {
      log("warn", "loop", "达到最大尝试次数上限，停止");
      stopRun("stopped");
      return;
    }

    // 分级延迟：前 FAST_ATTEMPTS 近零；其后 30ms；再后 pollIntervalMs ± 30% 抖动
    var poll = (ME.config && ME.config.pollIntervalMs != null) ? ME.config.pollIntervalMs : 350;
    poll = Math.max(POLL_FLOOR_MS, poll);
    var delay;
    if (ME.attempts < FAST_ATTEMPTS) delay = FAST_DELAY_MS;
    else if (ME.attempts < FAST_ATTEMPTS + 30) delay = MID_DELAY_MS;
    else delay = jitter(poll);

    if (ME.retryTimer) { clearTimeout(ME.retryTimer); }
    ME.retryTimer = setTimeout(function () {
      ME.retryTimer = null;
      tryBuy();
    }, delay);
  }

  function isPastRetryUntil() {
    try {
      // 重试窗口相对「开抢时刻 fireAt」计算（默认 3600s=1 小时，options 可改）。
      // 不用绝对 HH:MM:SS：否则手动开抢/非整点测试时，server-now 可能早已越过该钟点而瞬间停止
      // （例如本机时钟慢 2 分钟时，10:00 开抢、绝对 retryUntil=10:02，服务器实际已过 10:02 → 秒停）。
      // 回退基准：fireAt 缺失(损坏/旧版 flag 恢复)时用 runLoop 首次进入时记的 startedAt，
      // 保证时间窗仍能权威停止，不致只靠 MAX_ATTEMPTS 兜底而长时间空转。
      var base = ME.fireAt || ME.startedAt || 0;
      if (!base) return false;
      var win = (ME.config && ME.config.retryWindowMs) || 3600000;
      return nowSrv() >= (base + win);
    } catch (e) { return false; }
  }

  // 基于 fireAt 当天 + "HH:MM:SS"，按配置时区求服务器纪元毫秒
  function sameDayServerEpoch(refServerEpoch, hms) {
    try {
      var tz = (ME.config && ME.config.timezone) || "Asia/Shanghai";
      // 取参考时刻在该时区的 Y/M/D
      var ref = new Date(refServerEpoch);
      var parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
      }).formatToParts(ref);
      var y, m, d;
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === "year") y = parts[i].value;
        if (parts[i].type === "month") m = parts[i].value;
        if (parts[i].type === "day") d = parts[i].value;
      }
      var seg = (hms || "00:00:00").split(":");
      var hh = parseInt(seg[0] || "0", 10);
      var mm = parseInt(seg[1] || "0", 10);
      var ss = parseInt(seg[2] || "0", 10);
      // 计算该时区在该日期的 UTC 偏移，进而得到 UTC 纪元
      var asUTC = Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10), hh, mm, ss);
      var tzOffsetMin = tzOffsetMinutes(tz, asUTC);
      return asUTC - tzOffsetMin * 60000;
    } catch (e) { return 0; }
  }

  // 求时区在某 UTC 时刻的偏移（分钟，东区为正）
  function tzOffsetMinutes(tz, utcMs) {
    try {
      var dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
      var parts = dtf.formatToParts(new Date(utcMs));
      var map = {};
      for (var i = 0; i < parts.length; i++) map[parts[i].type] = parts[i].value;
      // 某些引擎在 hour12:false 下会把午夜输出为 "24"，需映射为 "0"（与 background.js 保持一致）
      var asIfUTC = Date.UTC(
        parseInt(map.year, 10), parseInt(map.month, 10) - 1, parseInt(map.day, 10),
        parseInt(map.hour === "24" ? "0" : map.hour, 10), parseInt(map.minute, 10), parseInt(map.second, 10)
      );
      return Math.round((asIfUTC - utcMs) / 60000);
    } catch (e) { return 480; /* 兜底东八区 */ }
  }

  /*
   * tryBuy —— 单拍尝试。根据页面状态分派：
   *   - 弹窗打开（验证码/支付）-> 冻结，转入“等待验证码通过”阶段
   *   - 可购买 -> 点击 .buy-btn（backup 非 leader 不点）
   *   - 繁忙/限流 -> 恢复
   *   - 售罄 -> 分级重试
   */
  function tryBuy() {
    // buyPhase 守卫：到点(fireAt)前绝不进入买入/刷新逻辑——倒计时只在 spinUntilFire 里等待。
    if (!ME.running || !ME.buyPhase || ME.finished) return;
    ME.attempts++;

    try {
      // 1) 弹窗优先：验证码或支付弹窗打开 -> 冻结（绝不刷新）
      var capOpen = safe(S.captchaOpen);
      var payOpen = safe(S.payDialogOpen);
      if (capOpen || payOpen) {
        onModalOpened(capOpen, payOpen);
        return; // 不再安排售罄重试，交给 waitCaptchaPass 轮询
      }

      // 1.5) 校正视图（个人套餐 + 目标周期）。若刚发生切换，等下一拍让卡片重渲染后再判定，
      //      避免按错误周期的可见按钮定位/点击。
      if (!ME.clickedBuy && ensureTargetView()) {
        // 防卡死：切换点击长期不生效(被遮挡 / Vue 每次重渲染回退选中态)时，会每拍重切→零进展→永不刷新。
        // 连续多拍仍未就位 → 强制整页重载重置视图（重载后 init→startGoFlow 续跑）。
        ME.viewSwitchStreak = (ME.viewSwitchStreak || 0) + 1;
        if (ME.viewSwitchStreak > 12) {
          log("warn", "view", "目标视图连续 " + ME.viewSwitchStreak + " 拍未切换成功 → 强制重载重置");
          ME.viewSwitchStreak = 0;
          ME.lastReloadAt = Date.now();
          saveRunFlag("running");
          var vt = reloadFreshUrl();
          ME._reloadPending = true; // 与其它重载点一致：走 reloadTimer，stop/撤防时可被 cleanupTimers 拦掉
          if (ME.reloadTimer) { clearTimeout(ME.reloadTimer); }
          ME.reloadTimer = setTimeout(function () {
            ME.reloadTimer = null;
            ME._reloadPending = false;
            try { location.replace(vt); } catch (e) { try { location.reload(); } catch (e2) {} }
          }, jitter(RELOAD_FLOOR_MS));
          return;
        }
        scheduleNextAttempt();
        return;
      }
      ME.viewSwitchStreak = 0; // 视图已就位（或已 clickedBuy）→ 清零卡死计数

      // 2) 解析目标条目与按钮
      var entry = safe(function () { return S.resolveProduct ? S.resolveProduct(ME.target.tier, ME.target.period) : null; });
      var btn = null;
      if (entry) {
        btn = safe(function () { return S.findBuyBtnForCard ? S.findBuyBtnForCard(entry) : null; });
        // store 就绪后顺手刷新缓存
        if (entry.productId != null) {
          ME.target.productId = entry.productId;
          writeProductCache(ME.target.tier, ME.target.period, entry.productId, entry.payAmount);
        }
      }
      if (!btn) btn = findBtnByPrice(ME.target ? ME.target.payAmountHint : null) || safe(function () { return document.querySelector(S.BUY_BTN); });

      // 3) 可购买 -> 点击
      var buyable = safe(function () { return S.isBuyable ? S.isBuyable(entry, btn) : false; });
      if (buyable && btn) {
        onBuyable(btn);
        return;
      }

      // 4) 繁忙/限流 -> 恢复
      if (safe(S.isBusyPage)) {
        onRateLimited();
        return;
      }

      // 5) 售罄 / 尚未翻转 -> 分级重试
      onSoldOut(entry, btn);
    } catch (e) {
      log("error", "loop", "tryBuy 异常: " + (e && e.message));
      scheduleNextAttempt();
    }
  }

  function safe(fn) {
    try { return typeof fn === "function" ? fn() : undefined; } catch (e) { return undefined; }
  }

  // 节流上报健康度（attempts/上次检查时间），供 popup 显示"运行中·已尝试N次·Xs前检查"
  var _lastHealthAt = 0;
  function healthPatch() {
    var t = Date.now();
    if (t - _lastHealthAt < 1500) return;
    _lastHealthAt = t;
    patchState({ attempts: ME.attempts, lastCheckAt: t });
  }

  // ---- 可购买：点击购买 ----
  function onBuyable(btn) {
    sendBg("buyable");
    setStatus("running");

    // backup 且非 leader：仅观察，不点击
    if (ME.role === "backup" && !ME.isLeader) {
      log("info", "buy", "[备用] 检测到可购买，但非 leader，保持观察不点击");
      // 备用持续观察，等待可能的 becomeLeader
      scheduleNextAttempt();
      return;
    }

    // dryRun：绝不点击
    if (ME.dryRun) {
      log("success", "buy", "[DRY] 检测到可购买 -> 将点击 .buy-btn（dryRun 不执行）");
      // dryRun 模式下，模拟“已点击”后停下，避免反复刷屏
      ME.clickedBuy = true; // 标记，进入“等待验证码”模拟阶段（实际不会出验证码）
      log("info", "buy", "[DRY] 模拟已点击，等待人工验证码（真实流程此处会弹码）");
      setStatus("captcha-wait");
      saveRunFlag("captcha-wait");
      // dryRun 下不进入真实轮询点击确认，仅停下
      stopRun("stopped");
      return;
    }

    // 本轮已发起过下单(create-sign) → 不再点击购买，停手交人工（防重复占单）
    if (orderAlreadyFired()) { haltSuspectOrdered("onBuyable 入口"); return; }

    // 真实点击（去抖：避免重复触发）
    var nowT = Date.now();
    if (nowT - ME.lastClickAt < 120) { scheduleNextAttempt(); return; }
    ME.lastClickAt = nowT;
    try {
      log("success", "buy", "检测到可购买，点击购买按钮");
      btn.click();
      ME.clickedBuy = true;
      ME.soldOutRounds = 0; // 本档已真可买并点击 → 清零档位降级计数（与 noCardRounds 的清零对称）
      saveRunFlag("clicked-buy");
      setStatus("captcha-wait");
      // 点击后页面将弹出腾讯验证码 -> 进入等待人工通过阶段
      startWaitCaptchaPass();
    } catch (e) {
      log("error", "buy", "点击购买失败: " + (e && e.message));
      ME.clickedBuy = false;
      scheduleNextAttempt();
    }
  }

  // ---- 限流/繁忙：恢复 ----
  function onRateLimited() {
    sendBg("rateLimited");
    setStatus("rate-limited");
    var nowT = Date.now();
    if (nowT - ME.lastReloadAt < RELOAD_FLOOR_MS) {
      // 距上次恢复太近，节流，稍后再试
      scheduleNextAttempt();
      return;
    }
    ME.lastReloadAt = nowT;
    log("warn", "rate", "页面繁忙/限流，执行恢复");

    // 优先 SPA 软路由（pushState/replaceState 后重初始化），失败再硬刷新
    var soft = trySoftReroute();
    if (soft) {
      log("info", "rate", "已尝试 SPA 软重路由恢复");
      // 软恢复后给页面一点时间，再继续循环
      setTimeout(function () { if (ME.running && !ME.finished) tryBuy(); }, jitter(Math.max(RELOAD_FLOOR_MS, 400)));
      return;
    }
    // 硬刷新（带 cache-busting）。刷新前落盘运行标志以便断点恢复。
    log("warn", "rate", "软恢复不可用，执行硬刷新（cache-busting）");
    saveRunFlag(ME.clickedBuy ? "clicked-buy" : "running");
    var target = reloadFreshUrl();
    ME._reloadPending = true;
    if (ME.reloadTimer) { clearTimeout(ME.reloadTimer); }
    ME.reloadTimer = setTimeout(function () {
      ME.reloadTimer = null;
      ME._reloadPending = false;
      try { location.replace(target); } catch (e) { try { location.reload(); } catch (e2) {} }
    }, jitter(RELOAD_FLOOR_MS));
  }

  function trySoftReroute() {
    try {
      // 仅在仍处于 glm-coding 路由时做软重路由（pushState 触发 SPA 重渲染）
      if (history && typeof history.replaceState === "function") {
        var base = "/glm-coding";
        history.pushState({ glm: Date.now() }, "", base + "?_s=" + Date.now());
        // 派发 popstate 让框架感知（部分路由库监听 popstate）
        try { window.dispatchEvent(new PopStateEvent("popstate", { state: { glm: 1 } })); } catch (e) {}
        return true;
      }
    } catch (e) {}
    return false;
  }

  // 页面是否已渲染出卡片（store 有 allCardDataList，或页面有 .buy-btn）。
  // 用于区分「售罄」(有卡片但不可购) 与「无卡片」(疑似高频刷新软限流了卡片数据接口)。
  function cardsPresent() {
    try {
      var store = S.getVueStore ? S.getVueStore() : null;
      if (store && Array.isArray(store.allCardDataList) && store.allCardDataList.length) return true;
    } catch (e) {}
    try {
      var btns = document.querySelectorAll(S.BUY_BTN || "button.buy-btn");
      if (btns && btns.length > 0) return true;
    } catch (e) {}
    return false;
  }

  // 档位降级（fallbackList）：当前档位连续 K 轮(刷新)售罄 → 切到下一个备选 {tier,period}，提升抢中率。
  // 仅切档、不增购：一旦进入下单(clickedBuy)即不再切换；始终单账号单笔、停在支付前。
  // 在「真正执行一次刷新」时调用（一次刷新 = 一轮）；切档后由刷新→resume 用新 target 重选周期/产品。
  function maybeFallbackSwitch() {
    try {
      if (ME.clickedBuy || ME.finished) return;
      var fbList = (ME.config && Array.isArray(ME.config.fallbackList)) ? ME.config.fallbackList : [];
      if (!fbList.length) return;
      ME.soldOutRounds = (ME.soldOutRounds || 0) + 1;
      var K = (ME.config && ME.config.fallbackAfterRounds) || 10;
      if (ME.soldOutRounds < K) return;
      if ((ME.fallbackIndex || 0) >= fbList.length) return; // 备选已用尽，维持最后一档继续重试
      ME.fallbackIndex = (ME.fallbackIndex || 0) + 1;
      ME.soldOutRounds = 0;
      var nf = fbList[ME.fallbackIndex - 1] || {};
      if (nf && nf.tier && nf.period) {
        ME.target = { tier: nf.tier, period: nf.period };
        log("warn", "fallback", "本档连续售罄 " + K + " 轮 → 降级到备选 " + nf.tier + "/" + nf.period +
          "（第 " + ME.fallbackIndex + "/" + fbList.length + " 个备选）");
        patchState({ target: { tier: nf.tier, period: nf.period, productId: null } });
      }
    } catch (e) {}
  }

  // ---- 售罄/未翻转：刷新驱动重试（点击抢→售罄→刷新→再抢） ----
  function onSoldOut(entry, btn) {
    sendBg("soldOut");
    setStatus("sold-out-retry");
    healthPatch();

    // 很多限量「售罄态」要刷新后才翻牌，故售罄即按「刷新周期」硬刷新拉取最新库存。
    // hybrid / reload 策略都走刷新；observe 策略只原地轮询（靠 MutationObserver 捕获反应式翻转）。
    var strat = (ME.config && ME.config.triggerStrategy) || "hybrid";
    if (strat === "hybrid" || strat === "reload") {
      // 渐进长尾(决策在 GLM.pacing.reloadCycleMs，纯函数可单测)：
      // 0-60s 猛刷(1.2s) → 60s-5min 4s → 5-15min 8s → >15min 15s。
      // 60s 爆发窗口维持写死、档位理由与请求量算账见 pacing.js 注释。
      var elapsedSinceFire = ME.fireAt ? (nowSrv() - ME.fireAt) : 0;
      var cycle = P.reloadCycleMs(elapsedSinceFire, ME.config);

      // 限流降级退避：连续 N 轮重载后页面仍「无卡片」(疑似高频刷新把卡片数据接口刷进了软限流)，
      // 大幅拉长刷新间隔给接口恢复时间，避免越刷越糟、把自己刷进更深的限流。卡片恢复即退出退避。
      var present = cardsPresent();
      if (present && ME.noCardRounds) {
        log("info", "rate", "卡片已恢复，退出限流退避");
        ME.noCardRounds = 0;
      }
      var N = (ME.config && ME.config.noCardBackoffRounds) || 2;
      var backedOff = (!present && (ME.noCardRounds || 0) >= N);
      if (backedOff) {
        var backoff = (ME.config && ME.config.backoffReloadIntervalMs) || 15000;
        cycle = Math.max(cycle, backoff);
      }

      // 「无卡片」两种成因，区别处理（关键：原地死等永远等不来卡片——SPA 不会自己重拉数据）：
      //  (a) 页面刚加载、Vue 还没挂载完 → 宽限期内原地等几拍让卡片渲染（不刷新，避免"刷新→未渲染→再刷新"抖动）。
      //  (b) 过了宽限期卡片仍没出现 = 卡片数据确实没拉到(疑似软限流) → 必须重载重拉，但要「慢」：
      //      无卡片本身就是限流信号，故未达阈值也 ≥8s，达阈值用 backoff(默认15s)，给接口充分恢复时间；
      //      若仍 3s 一刷只会正反馈加深限流——这正是「被限流后越刷越糟」要避免的。
      if (!present) {
        var sinceLoad = Date.now() - SCRIPT_START;
        var GRACE_MS = 2000;
        if (sinceLoad < GRACE_MS) {
          // (a) 宽限期内：原地等卡片渲染
          if (ME.retryTimer) { clearTimeout(ME.retryTimer); }
          ME.retryTimer = setTimeout(function () {
            ME.retryTimer = null;
            if (ME.running && ME.buyPhase && !ME.finished && !ME.clickedBuy) tryBuy();
          }, 300);
          return;
        }
        // (b) 过宽限期仍无卡片 → 慢速重载重拉（这正是修复"原地死等永不刷新→刷不出购买按钮"的关键）
        var noCardCycle = backedOff
          ? ((ME.config && ME.config.backoffReloadIntervalMs) || 15000)
          : Math.max(cycle, 8000);
        var sinceReloadNC = Date.now() - ME.lastReloadAt;
        if (sinceReloadNC > Math.max(RELOAD_FLOOR_MS, noCardCycle)) {
          ME.lastReloadAt = Date.now();
          ME.noCardRounds = (ME.noCardRounds || 0) + 1; // 仅真正重载才计一轮，"连续N轮"才有意义
          log("warn", "rate", "无卡片超宽限期(疑似软限流，连续 " + ME.noCardRounds + " 轮无卡重载) → 慢速重载重拉卡片（周期≈" + noCardCycle + "ms）");
          saveRunFlag("running");
          var ncTarget = reloadFreshUrl();
          ME._reloadPending = true;
          if (ME.reloadTimer) { clearTimeout(ME.reloadTimer); }
          ME.reloadTimer = setTimeout(function () {
            ME.reloadTimer = null;
            ME._reloadPending = false;
            try { location.replace(ncTarget); } catch (e) { try { location.reload(); } catch (e2) {} }
          }, jitter(RELOAD_FLOOR_MS));
          return;
        }
        // 还没到重载时刻：原地等到该刷新
        if (ME.retryTimer) { clearTimeout(ME.retryTimer); }
        ME.retryTimer = setTimeout(function () {
          ME.retryTimer = null;
          if (ME.running && ME.buyPhase && !ME.finished && !ME.clickedBuy) tryBuy();
        }, 500);
        return;
      }

      // 有卡片（售罄）→ 按刷新周期硬刷新拉最新库存
      var since = Date.now() - ME.lastReloadAt;
      if (since > Math.max(RELOAD_FLOOR_MS, cycle)) {
        ME.lastReloadAt = Date.now();
        maybeFallbackSwitch(); // 有卡片但售罄，计入档位降级
        log("info", "soldout", "售罄 → 刷新页面再抢（周期≈" + cycle + "ms）");
        saveRunFlag("running");
        var target = reloadFreshUrl();
        ME._reloadPending = true; // 标记：刷新已排队，stop 收到时需拦掉
        if (ME.reloadTimer) { clearTimeout(ME.reloadTimer); }
        ME.reloadTimer = setTimeout(function () {
          ME.reloadTimer = null;
          ME._reloadPending = false;
          try { location.replace(target); } catch (e) { try { location.reload(); } catch (e2) {} }
        }, jitter(RELOAD_FLOOR_MS));
        return;
      }
    }
    // 刷新周期未到（或 observe 策略）：原地轮询，反应式翻转会被 MutationObserver/poll 立即捕获
    scheduleNextAttempt();
  }

  // ---------------------------------------------------------------------------
  // 验证码移交（弹窗已开 / 点击后等待）
  // ---------------------------------------------------------------------------
  function onModalOpened(capOpen, payOpen) {
    // 进入冻结：不刷新、不重复点击，只等待人工
    if (!ME.clickedBuy) ME.clickedBuy = true; // 弹窗已开，视为已进入下单流程
    if (capOpen && !ME.captchaAnnounced) {
      announceCaptcha();
    }
    if (!ME.captchaWaiting) startWaitCaptchaPass();
  }

  function announceCaptcha() {
    ME.captchaAnnounced = true;
    log("warn", "captcha", "腾讯验证码已弹出 —— 请立即人工完成验证！");
    sendBg("captchaShown");
    setStatus("captcha-wait");
    saveRunFlag("captcha-wait");
    // 大声提醒：蜂鸣循环 + 顶部大横幅（背景通知由 background 负责）
    startBeepLoop();
    showBanner("⚠ 请立即完成验证码（人工） ⚠", "#e53935");
    // 尝试把页面/窗口拉到前台焦点，并把验证码滚动到可视区，便于立刻操作
    try { window.focus(); } catch (e) {}
    try {
      var capEl = document.querySelector('#tcaptcha_transform_dy, iframe[src*="captcha"], [id*="tcaptcha"], .tcaptcha-transform');
      if (capEl && capEl.scrollIntoView) capEl.scrollIntoView({ block: "center", inline: "center" });
    } catch (e) {}
  }

  /*
   * startWaitCaptchaPass —— 进入“等待人工通过验证码”阶段。
   * 不再点击 .buy-btn；周期性检测：验证码已关闭 且 已推进（支付弹窗打开/preview 完成）
   * -> 视为 captchaPassed，按 stopPoint 处理。
   */
  function startWaitCaptchaPass() {
    if (ME.captchaWaiting) return;
    ME.captchaWaiting = true;
    setStatus("captcha-wait");
    saveRunFlag("captcha-wait");
    log("info", "captcha", "等待人工完成验证码…（绝不自动破解）");

    // limbo 计时：仅累加「验证码未显示 + 无支付弹窗 + 无失败提示」的悬空时间；验证码一旦在显示、
    // 或用户最近在操作(点滑块/输短信)就清零，故人工处理期间绝不超时。悬空超上限 → 点击疑似未生效/被抢
    // → 回循环重抢，避免点一次后永久干等。CAP 取 45s（仅用于“点了但码压根没弹”的极端兜底，给慢网/多步过码留足余量）。
    var limboMs = 0;
    var LIMBO_CAP = 45000; // ~45s

    var poll = function () {
      if (ME.finished) return;
      var capOpen = safe(S.captchaOpen);
      var payOpen = safe(S.payDialogOpen);

      if (capOpen) {
        limboMs = 0; // 验证码在显示，人工处理中，不计时
        // 即便人工迟迟未过码，也不无限空转：超过重试时间窗则停手。用 stopRun(不刷新)，
        // 避免把人工正在做的验证码会话冲掉（绝不在 capOpen 时 reload）。
        if (isPastRetryUntil()) { log("warn", "captcha", "已过重试窗口仍未完成验证码，停止等待"); stopRun("stopped"); return; }
        // 验证码仍开 -> 确保提醒在响
        if (!ME.captchaAnnounced) announceCaptcha();
        // 心跳：让 background 的 _lastLeaderSignalAt 保持新鲜（防接管的第二道防线；
        // 主防线是 background 收到 captchaShown 后置 _committed 永久禁用接管）。
        sendBg("heartbeat");
        ME.pollTimer = setTimeout(poll, 250);
        return;
      }

      // 过码后/点击后若弹出「库存不足/已售罄/手慢了/下单失败」等失败提示 → 立即重抢
      // （这正是"过码那几秒被别人抢走"的场景；orderFailed 只看 el-message/通知/对话框，
      //   不会把常驻的"暂时售罄"按钮误判为失败）。
      var failCap = safe(S.orderFailed);
      if (failCap) { retryAfterFail("过码后失败: " + failCap); return; }

      // 验证码已关且出现支付弹窗：验证码通过
      if (payOpen) { onCaptchaPassed(); return; }

      // 悬空：验证码未显示、无支付弹窗、无失败提示。给页面时间（点击后码可能稍后弹），但有上限。
      // 人工活动抑制：用户最近 8s 内有交互（很可能正在过码而 isVisible 瞬时判负）→ 不计悬空，绝不误刷掉人工验证码。
      if (ME._lastUserActAt && (Date.now() - ME._lastUserActAt) < 8000) {
        limboMs = 0;
        ME.pollTimer = setTimeout(poll, 250);
        return;
      }
      limboMs += 250;
      if (limboMs >= LIMBO_CAP) {
        retryAfterFail("点击后约 " + Math.round(LIMBO_CAP / 1000) + "s 未见验证码/支付弹窗/失败提示(点击疑似未生效或被抢)");
        return;
      }
      ME.pollTimer = setTimeout(poll, 250);
    };
    ME.pollTimer = setTimeout(poll, 250);
  }

  function onCaptchaPassed() {
    if (ME.captchaPassedHandled) return;
    ME.captchaPassedHandled = true;
    stopBeepLoop();
    log("success", "captcha", "验证码已通过，支付弹窗已出现");
    sendBg("captchaPassed");
    showBanner("验证码已通过，处理下单中…", "#1e88e5");

    var stopPoint = (ME.config && ME.config.stopPoint) || "hold";

    if (stopPoint === "beforeConfirm") {
      // 停在支付弹窗，不点确认
      log("warn", "order", "stopPoint=beforeConfirm：停在支付弹窗，不点击「确认支付」");
      showBanner("已到支付弹窗（未下单）— 请人工决定", "#fb8c00");
      setStatus("reached-payment");
      saveRunFlag("reached-payment");
      finishRun("reached-payment", false);
      return;
    }

    // stopPoint === "hold"：点击确认支付 -> 触发 create-sign 占位
    if (ME.dryRun) {
      log("success", "order", "[DRY] 将点击「确认支付」(create-sign)（dryRun 不执行）");
      finishRun("stopped", false);
      return;
    }
    clickConfirmPay();
  }

  // ---- 点击确认支付（create-sign，占位下单），随后检测支付页 ----
  function clickConfirmPay(tries) {
    if (ME.confirmClicked) return;
    if (orderAlreadyFired()) { haltSuspectOrdered("clickConfirmPay 入口"); return; }
    tries = tries || 0;
    // 失败优先：preview/确认阶段若已弹失败(库存被抢) → 立即重抢，不要干等按钮
    var failNow = safe(S.orderFailed);
    if (failNow) { retryAfterFail("确认支付阶段失败: " + failNow); return; }
    var cp = safe(function () { return document.querySelector(S.CONFIRM_PAY); });
    if (!cp) {
      if (tries > 25) { // ~5s 仍无「确认支付」按钮(preview 可能失败/弹窗未出) → 回循环重抢，避免无上限干等死循环
        log("warn", "order", "~5s 未出现「确认支付」按钮 → 视为下单未成立，回循环重抢");
        retryAfterFail("未出现确认支付按钮");
        return;
      }
      if (tries === 0) log("info", "order", "未找到「确认支付」按钮，等待渲染…");
      setTimeout(function () { if (!ME.finished) clickConfirmPay(tries + 1); }, 200);
      return;
    }
    try {
      ME.confirmClicked = true;
      log("success", "order", "点击「确认支付」-> 触发 create-sign 占位下单");
      cp.click();
      markOrderFired(); // click 已发出(create-sign 已触发) → 同步落盘「已下单」闸，防任何重载/恢复二次下单
      setStatus("ordered");
      sendBg("orderCreated");
      saveRunFlag("ordered");
      // 等待跳转到支付页 / 出现二维码
      waitForPaymentPage();
    } catch (e) {
      log("error", "order", "点击确认支付失败: " + (e && e.message));
      ME.confirmClicked = false;
      if (tries > 10) { retryAfterFail("点击确认支付反复失败"); return; }
      setTimeout(function () { if (!ME.finished) clickConfirmPay(tries + 1); }, 250);
    }
  }

  /*
   * waitForPaymentPage —— 检测是否到达支付页（二维码 / 跳转支付宝/微信 / 支付容器）。
   * 到达后：金额安全校验（¥0 视为失败）-> reachedPayment + 大声提醒 + STOP（绝不付款）。
   */
  function waitForPaymentPage() {
    var tries = 0;
    var poll = function () {
      if (ME.finished) return;
      tries++;
      // 确认支付后若出现失败弹窗（库存被并发抢走等）→ 重抢
      var failPay = safe(S.orderFailed);
      if (failPay) { retryAfterFail("确认支付后失败: " + failPay); return; }
      var reached = detectPaymentPage();
      if (reached.ok) {
        // 金额安全：解析到金额且 ¥0 -> 异常（视为失败）
        if (reached.zeroAmount) {
          log("error", "pay", "支付页金额为 ¥0，判定为异常（视为失败，不计成功）");
          showBanner("⚠ 支付金额异常(¥0) — 请人工核对，勿付款", "#d32f2f");
          sendBg("error", { msg: "支付页金额为 ¥0" });
          setStatus("error");
          finishRun("error", false);
          return;
        }
        // 站内支付页但金额尚未解析出来：再等几拍让金额渲染（fail-closed，不急于判成功）。
        // 跳转支付宝/微信域名(hostRedirect)时金额本就不在本页，直接认定到达。
        if (!reached.amountKnown && !reached.hostRedirect) {
          if (tries <= 24) { // 约 6s 内持续等待金额出现
            setTimeout(poll, 250);
            return;
          }
          // 超时仍无金额：保守判为「已下单(ordered)」而非完整成功，提示人工核对。
          log("warn", "pay", "已到支付页但未解析到金额，保守判为已下单，请人工核对金额后再付款");
          showBanner("已到支付页（金额未识别）— 请人工核对金额，勿盲目付款", "#fb8c00");
          startBeepLoop();
          setTimeout(stopBeepLoop, 4000);
          sendBg("orderCreated");
          setStatus("ordered");
          saveRunFlag("ordered");
          finishRun("ordered", true);
          return;
        }
        log("success", "pay", "已到达支付页（占位订单已生成，金额=有效）。停止。绝不自动付款。");
        showBanner("✔ 占位成功，已到支付页 — 请人工付款（脚本已停止）", "#2e7d32");
        startBeepLoop(); // 到达支付页同样大声提醒
        setTimeout(stopBeepLoop, 4000); // 响一会儿即可
        sendBg("reachedPayment");
        setStatus("reached-payment");
        saveRunFlag("reached-payment");
        finishRun("reached-payment", true);
        return;
      }
      if (tries > 80) { // ~20s 仍未到支付页、且全程未检测到失败提示
        // 已点过「确认支付」(create-sign 已触发、闸已置)，却既没进支付页也没弹失败提示 → 前端无法可靠判定真伪
        // （收银台可能是跨源 iframe / 文案漏匹配 / 渲染慢）。硬边界优先：宁可漏抢，绝不重复占单。
        // 故保守判「可能已下单」、停手大声提示人工核对，绝不自动重抢（真正“过码被抢走”由上方 orderFailed
        // 分支安全重抢；此处是无任何信号的歧义态，重抢可能造成本账号第二笔订单）。
        log("warn", "pay", "确认支付后 ~20s 未见支付页、也无失败提示 → 可能已下单，保守停手交人工核对(不重抢，防重复占单)");
        showBanner("⚠ 已点确认支付但未识别到支付页 — 可能已下单，请人工核对订单，勿重复购买/勿盲付", "#fb8c00");
        startBeepLoop();
        setTimeout(stopBeepLoop, 4000);
        sendBg("orderCreated");
        setStatus("ordered");
        saveRunFlag("ordered");
        finishRun("ordered", true);
        return;
      }
      setTimeout(poll, 250);
    };
    setTimeout(poll, 200);
  }

  // 检测支付页特征；返回 { ok, zeroAmount, amountKnown }
  // 收紧策略：避免把页面里无关的 <canvas>/含 payment 类名的瞬态元素误判为“已到支付页”。
  // 需要「明确的支付正向信号」：① 跳转支付宝/微信域名；或 ② 支付文案命中
  // 且（命中文案本身即足够强信号，或）二维码位于支付容器内。
  function detectPaymentPage() {
    try {
      // 1) 已跳转到支付宝/微信域名（最强信号）
      var h = location.hostname || "";
      if (/alipay\.com$/.test(h) || /(^|\.)wx\.tenpay\.com$/.test(h) || /weixin|tenpay/.test(h)) {
        return { ok: true, zeroAmount: false, amountKnown: false, hostRedirect: true };
      }
      var payTxt = "";
      try { payTxt = (document.body && document.body.innerText) || ""; } catch (e) {}

      // 2) 明确的扫码支付文案（站内支付页的强文本信号）
      var payTextHit = /扫码支付|请使用(支付宝|微信)(扫一?扫|扫码)|支付宝扫码|微信扫码|二维码支付|打开手机(支付宝|微信)/.test(payTxt);

      // 3) 仅在「支付容器」内部出现的二维码才算（避免误判无关 canvas/图表）
      var qrInPayContainer = false;
      try {
        var payContainers = document.querySelectorAll(
          '.pay-dialog, [class*="pay-qr"], [class*="qrcode"], [class*="qr-code"], [class*="payment"], [class*="pay-modal"], [class*="cashier"]'
        );
        for (var i = 0; i < payContainers.length; i++) {
          var cont = payContainers[i];
          if (!cont || (S._isVisible && !S._isVisible(cont))) continue;
          var inner = cont.querySelector('canvas, img[src*="qrcode"], img[src*="qr"], [class*="qrcode"], [class*="qr-code"]');
          if (inner) { qrInPayContainer = true; break; }
        }
      } catch (e) {}

      var looksPay = payTextHit || qrInPayContainer;
      if (!looksPay) return { ok: false, zeroAmount: false, amountKnown: false };

      // 金额校验：解析 ¥金额；amountKnown 表示是否成功解析到金额
      var amt = parsePaymentAmount(payTxt);
      return {
        ok: true,
        zeroAmount: amt.known ? !(amt.value > 0) : false,
        amountKnown: amt.known,
        hostRedirect: false
      };
    } catch (e) {
      return { ok: false, zeroAmount: false, amountKnown: false, hostRedirect: false };
    }
  }

  // 解析支付金额，返回 { known, value }
  function parsePaymentAmount(text) {
    try {
      var t = text || "";
      var m = t.match(/[¥￥]\s*([0-9]+(?:\.[0-9]{1,2})?)/);
      if (!m) m = t.match(/金额[^0-9]{0,6}([0-9]+(?:\.[0-9]{1,2})?)/);
      if (!m) m = t.match(/([0-9]+(?:\.[0-9]{1,2})?)\s*元/);
      if (!m) return { known: false, value: 0 };
      return { known: true, value: parseFloat(m[1]) };
    } catch (e) {
      return { known: false, value: 0 };
    }
  }


  // ---------------------------------------------------------------------------
  // 运行收尾
  // ---------------------------------------------------------------------------
  function finishRun(status, success) {
    ME.finished = true;
    ME.running = false;
    ME.buyPhase = false;
    ME.captchaWaiting = false;
    cleanupTimers();
    try { if (ME.observer) ME.observer.disconnect(); } catch (e) {}
    setStatus(status);
    // lastResult 统一为字符串（与 background 写法一致，避免下游需同时兼容 string/object）
    patchState({
      lastResult: status + (success ? " 成功" : " 结束") + "（尝试" + ME.attempts + "次）"
    });
    if (status === "reached-payment" || status === "ordered") {
      // 占位成功，提示 background 通知另一标签停手（background 已在收到 reachedPayment/orderCreated 时处理）
      log("success", "done", "流程完成：" + status + "（占位" + (success ? "成功" : "结束") + "）。脚本停止。");
    } else {
      log("warn", "done", "流程结束：" + status);
    }
    // 成功占位后清理运行标志（避免下次加载误恢复）；失败/到达支付保留标志供查看亦可，这里清理以免重复恢复
    clearRunFlag();
  }

  function stopRun(status) {
    ME.running = false;
    ME.buyPhase = false;
    ME.captchaWaiting = false;
    ME._goActive = false; // 释放 go 幂等闸：停止后允许同一 fireAt 重新开抢（如再次布防/手动开抢）
    cleanupTimers();
    stopBeepLoop();
    setStatus(status || "stopped");
    log("info", "stop", "抢购循环已停止：" + (status || "stopped"));
    clearRunFlag();
  }

  // 下单未成功（过码那几秒被别人抢走 / 创建订单失败）→ 重置下单态、刷新清掉错误弹窗、回循环重抢
  // （限重试窗口内）。仅在「明确失败信号」时触发,故不会造成单账号重复下单。
  function retryAfterFail(reason) {
    if (ME.finished) return;
    if (isPastRetryUntil()) {
      log("warn", "retry", "已过重试窗口，不再重抢（" + reason + "）");
      stopRun("stopped");
      return;
    }
    log("warn", "retry", "下单未成功（" + reason + "）→ 刷新后回循环重抢");
    // 清「已下单」闸：retryAfterFail 仅在「明确无订单」(显式失败弹窗/未触发 create-sign 的竞价重抢)被调用，
    // 此时本账号无占位订单，重抢安全；不清则闸会误拦下一轮正常下单。
    clearOrderFired();
    ME.clickedBuy = false;
    ME.confirmClicked = false;
    ME.captchaWaiting = false;
    ME.captchaAnnounced = false;
    ME.captchaPassedHandled = false;
    cleanupTimers();
    stopBeepLoop();
    saveRunFlag("running");
    var target = reloadFreshUrl();
    ME._reloadPending = true;
    if (ME.reloadTimer) { clearTimeout(ME.reloadTimer); }
    ME.reloadTimer = setTimeout(function () {
      ME.reloadTimer = null;
      ME._reloadPending = false;
      try { location.replace(target); } catch (e) { try { location.reload(); } catch (e2) {} }
    }, jitter(RELOAD_FLOOR_MS));
  }

  function cleanupTimers() {
    try { if (ME.retryTimer) { clearTimeout(ME.retryTimer); ME.retryTimer = null; } } catch (e) {}
    try { if (ME.pollTimer) { clearTimeout(ME.pollTimer); ME.pollTimer = null; } } catch (e) {}
    try { if (ME.reloadTimer) { clearTimeout(ME.reloadTimer); ME.reloadTimer = null; } } catch (e) {}
    ME._reloadPending = false;
  }

  // ---------------------------------------------------------------------------
  // 启动一次完整抢购流程（收到 "go" 或断点恢复时调用）
  // ---------------------------------------------------------------------------
  async function startGoFlow(opts) {
    // opts: { config, target, fireAt, role, resume, resumePhase }
    // F2 幂等：同一 fireAt 的 go 若已激活（非断点恢复）→ 忽略重复，避免二次挂 observer / 打断倒计时与循环。
    var _incomingFireAt = opts.fireAt || ME.fireAt || 0;
    if (!opts.resume && ME._goActive && ME._activeFireAt === _incomingFireAt) {
      log("info", "go", "忽略重复 go（同 fireAt=" + _incomingFireAt + " 已激活）");
      return;
    }
    if (!opts.resume) { ME._goActive = true; ME._activeFireAt = _incomingFireAt; }
    ME.config = opts.config || ME.config || {};
    ME.target = opts.target || ME.target || { tier: ME.config.tier, period: ME.config.period };
    if (ME.target && ME.target.payAmount != null && ME.target.payAmountHint == null) {
      ME.target.payAmountHint = ME.target.payAmount;
    }
    ME.fireAt = opts.fireAt || ME.fireAt || 0;
    ME.role = opts.role || (opts.roleObj && opts.roleObj.role) || ME.role || "primary";
    if (ME.role === "backup") ME.isLeader = false; else ME.isLeader = true;

    // 读取最新 state（dryRun / offsetMs / role / 是否已由 background 对时 / 累计尝试次数）
    var bgSynced = false;
    try {
      var st = await getLocal(["state"]);
      var state = st.state || {};
      ME.dryRun = !!state.dryRun;
      if (typeof state.offsetMs === "number") ME.offsetMs = state.offsetMs;
      bgSynced = !!state.goDispatched; // background 下发 go 前必做一次 resync，此标记即其证据
      // F7：断点恢复(刷新续跑)时还原累计尝试次数，使 popup 计数与次数上限跨重载连续
      if (opts.resume && typeof state.attempts === "number") ME.attempts = state.attempts;
      if (state.role) {
        // 由 background 指派的 leader
        if (state.role.leaderTabId != null) {
          // 无法直接拿到自身 tabId；leader 判定主要依赖 role 字段 + becomeLeader 消息
        }
      }
    } catch (e) {}

    log("info", "go", "收到开抢指令：tier=" + ME.target.tier + " period=" + ME.target.period +
      " role=" + ME.role + " stopPoint=" + (ME.config.stopPoint || "hold") +
      " dryRun=" + ME.dryRun + (opts.resume ? " (恢复:" + opts.resumePhase + ")" : ""));

    // F7：尝试次数上限对齐重试时间窗——让「时间窗」(isPastRetryUntil) 成为权威停止条件，
    //     次数上限仅作失控兜底（窗口内以轮询地板间隔可达的最大次数 + 余量，正常绝不先于时间窗触发）。
    var _win = (ME.config && ME.config.retryWindowMs) || 3600000;
    MAX_ATTEMPTS = Math.max(4000, Math.ceil(_win / POLL_FLOOR_MS) + 2000);

    // 优惠/邀请码(ic)：若设置了 invitationCode 且当前页未带或不一致，先把 ic 注入 URL 并重载一次，
    // 让站点在下单(create-sign)时带上该 ic（仅本账号自己的订单）。在 go(≈T-90s)时做，时间充裕；
    // 保存 runFlag 以便重载后经 init→resume 重新进入本流程（届时 ic 已匹配，不再重载，无循环）。
    if (!opts.resume) {
      var _ic = couponIc();
      var _curIc = "";
      try { _curIc = new URL(location.href).searchParams.get("ic") || ""; } catch (e) {}
      if (_ic && _curIc !== _ic) {
        // 一次性闸：防止站点在加载时剥离 ic 导致每次都判定「不一致」而无限重载。
        var _icTried = false;
        try { _icTried = window.sessionStorage.getItem("glm_ic_injected") === _ic; } catch (e) {}
        if (!_icTried) {
          try { window.sessionStorage.setItem("glm_ic_injected", _ic); } catch (e) {}
          log("info", "coupon", "注入邀请/优惠码 ic=" + _ic + "（重载使其在下单时生效）");
          saveRunFlag("countdown");
          var _icUrl = reloadFreshUrl(); // 已含 ic
          ME._reloadPending = true;
          if (ME.reloadTimer) { clearTimeout(ME.reloadTimer); }
          ME.reloadTimer = setTimeout(function () {
            ME.reloadTimer = null;
            ME._reloadPending = false;
            try { location.replace(_icUrl); } catch (e) { try { location.reload(); } catch (e2) {} }
          }, 0);
          return;
        }
        log("warn", "coupon", "页面未保留 ic（站点可能在加载时剥离），跳过注入、继续抢购");
      }
    }

    // 1) 预热
    preheatConnections();

    // 1.5) 校正视图：先切到「个人套餐 + 目标周期」，确保可见的 3 个按钮对应正确周期
    ensureTargetView();

    // 2) 解析产品 + 缓存 + 挂 Observer
    var resolved = await resolveTarget(ME.target.tier, ME.target.period);
    if (resolved.productId) ME.target.productId = resolved.productId;
    if (resolved.payAmount != null) ME.target.payAmountHint = resolved.payAmount;
    patchState({ target: { tier: ME.target.tier, period: ME.target.period, productId: ME.target.productId || null } });
    attachObserver();

    // 3) 时间同步（F6）：background 在 arm/preheat 已对时并写入 state.offsetMs，且 go 必在一次
    //    resync 之后才下发（goDispatched 即证据）。检测到 background 已对时、或断点恢复(刷新续跑)时，
    //    content 直接复用该 offset，不再自行对时——省去每轮 5 连发请求（更快、更礼貌、不与 SW 重复）。
    //    仅当两者皆无（异常/边角路径）时，做一次对时兜底。
    if (opts.resume || bgSynced) {
      log("info", "time", (opts.resume ? "断点恢复" : "复用 background 对时") +
        "，沿用 offset≈" + Math.round(ME.offsetMs) + "ms（不重复对时）");
    } else {
      try {
        var off = await T.sync(SITE_URL, 5);
        if (typeof off === "number" && isFinite(off)) {
          ME.offsetMs = off;
          patchState({ offsetMs: off });
          log("info", "time", "content 侧时间同步完成 offset≈" + Math.round(off) + "ms");
        }
      } catch (e) {
        log("warn", "time", "content 侧时间同步失败，沿用 offset=" + Math.round(ME.offsetMs) + "ms");
      }
    }

    // 断点恢复：若已处于点击后阶段，直接进入对应阶段，不再等待 fireAt
    if (opts.resume) {
      var ph = opts.resumePhase || "running";
      log("warn", "resume", "断点恢复，phase=" + ph);
      ME.running = true;
      if (ph === "captcha-wait" || ph === "clicked-buy") {
        ME.buyPhase = true; // 这些阶段必在 fireAt 之后，buyPhase 应为 true（逻辑一致；observer 仍被 clickedBuy 挡住）
        ME.clickedBuy = true;
        startWaitCaptchaPass();
        return;
      }
      if (ph === "ordered" || ph === "reached-payment") {
        ME.buyPhase = true;
        ME.clickedBuy = true; ME.confirmClicked = true;
        waitForPaymentPage();
        return;
      }
      // running / preheat：直接进入循环（已过 fireAt）
      runLoop(opts.resumePastFire === true);
      return;
    }

    // 4) 精确等待到点，再进入循环
    ME.running = true;
    setStatus("countdown");
    saveRunFlag("countdown");
    await spinUntilFire();
    runLoop(false);
  }

  function runLoop(immediate) {
    if (ME.finished) return;
    ME.running = true;
    ME.buyPhase = true; // 到点，正式进入买入窗口：此后才允许 tryBuy/observer 触发买入与刷新
    ME.startedAt = ME.startedAt || nowSrv(); // 记录循环起点，作为 isPastRetryUntil 在 fireAt 缺失时的回退基准
    setStatus("running");
    saveRunFlag(ME.clickedBuy ? "clicked-buy" : "running");
    log("success", "loop", "进入抢购循环（attempts 上限=" + MAX_ATTEMPTS + "，重试窗口=" + Math.round(((ME.config && ME.config.retryWindowMs) || 3600000) / 1000) + "s，自 fireAt 起算）");
    // 立即开第一拍
    tryBuy();
  }

  // ---------------------------------------------------------------------------
  // 消息处理（background -> content）
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    try {
      switch (msg.type) {
        case "go":
          // { config, target, fireAt, role }
          startGoFlow({
            config: msg.config,
            target: msg.target,
            fireAt: msg.fireAt,
            role: (msg.role && msg.role.role) ? msg.role.role : (msg.role || "primary"),
            roleObj: msg.role
          });
          sendResponse && sendResponse({ ok: true });
          break;

        case "stop":
          if (ME._reloadPending) {
            log("warn", "stop", "收到 stop：拦截已排队但未执行的刷新，停止抢购");
          } else {
            log("info", "msg", "收到 stop");
          }
          stopRun("stopped");
          hideBanner();
          stopBeepLoop();
          sendResponse && sendResponse({ ok: true });
          break;

        case "standDown":
          // 备用 tab 退场：仅观察，不提交
          log("info", "msg", "收到 standDown（转为观察）");
          ME.isLeader = false;
          ME.role = "backup";
          sendResponse && sendResponse({ ok: true });
          break;

        case "becomeLeader":
          log("warn", "msg", "收到 becomeLeader（升级为 leader，开始提交）");
          ME.isLeader = true;
          // 若正在循环，下一拍即会点击
          if (!ME.running && !ME.finished) {
            ME.running = true;
            tryBuy();
          }
          sendResponse && sendResponse({ ok: true });
          break;

        case "configUpdated":
          // 携带 config 时更新运行期配置（stopPoint/sound/pollIntervalMs 等立即生效）
          if (msg.config) {
            ME.config = msg.config;
            log("info", "msg", "配置已更新（stopPoint=" + (msg.config.stopPoint || "?") + "）");
          }
          // 携带 dryRun 时立即生效（修复运行中开启 Dry-run 不生效的安全缺口）
          if (typeof msg.dryRun === "boolean") {
            ME.dryRun = msg.dryRun;
            log("warn", "msg", "演练模式更新为 dryRun=" + ME.dryRun);
          } else {
            // 兜底：未携带时主动重读 state.dryRun
            (function () {
              try {
                chrome.storage.local.get(["state"], function (res) {
                  try {
                    var stt = (res && res.state) || {};
                    ME.dryRun = !!stt.dryRun;
                  } catch (e) {}
                });
              } catch (e) {}
            })();
          }
          sendResponse && sendResponse({ ok: true });
          break;

        default:
          break;
      }
    } catch (e) {
      log("error", "msg", "处理消息异常(" + msg.type + "): " + (e && e.message));
    }
    return true; // 允许异步 sendResponse
  });

  // ---------------------------------------------------------------------------
  // 初始化：注册 + 断点恢复
  // ---------------------------------------------------------------------------
  async function init() {
    if (!isOnSite()) return; // 非目标站点不运行
    log("info", "content", "内容脚本就绪 @ " + location.href);

    // 读取 state / config / 运行标志
    var res = await getLocal(["state", "config", RUN_FLAG_KEY]);
    var state = res.state || {};
    var config = res.config || {};
    var flag = res[RUN_FLAG_KEY] || null;
    ME.config = config;
    if (typeof state.offsetMs === "number") ME.offsetMs = state.offsetMs;
    ME.dryRun = !!state.dryRun;

    // 判定自身角色（默认 primary；若 state.role 标注了 backupTabId 等，由 background 后续用 standDown/becomeLeader 校正）
    ME.role = "primary";
    ME.isLeader = true;

    // 注册到 background
    sendBg("contentReady", { role: ME.role, url: location.href });

    // 断点恢复（F4）：续跑窗口按「抢购时间窗」界定，而非固定 10 分钟。
    // 竞速阶段(countdown/preheat/running)：只要服务器现在仍 < fireAt+retryWindowMs(默认1h,可配)就续跑，
    //   与 isPastRetryUntil 对齐——否则长窗口里一次较慢的重载/系统休眠就会让续跑失效、中途弃抢。
    // 点击后阶段(clicked-buy/captcha-wait/ordered，人工节奏)：用较宽松的新鲜度上限(30min)兜底。
    try {
      if (flag && flag.ts) {
        var resumablePhases = ["countdown", "preheat", "running", "clicked-buy", "captcha-wait", "ordered"];
        var racePhase = (flag.phase === "countdown" || flag.phase === "preheat" || flag.phase === "running");
        var srvNow = Date.now() + (ME.offsetMs || 0);
        var win = (config.retryWindowMs || 3600000);
        var fresh;
        if (racePhase && flag.fireAt) {
          fresh = srvNow < (flag.fireAt + win + 60000);
        } else {
          fresh = (Date.now() - flag.ts) < 30 * 60 * 1000;
        }
        if (fresh && resumablePhases.indexOf(flag.phase) !== -1) {
          log("warn", "resume", "检测到中断的抢购进度(phase=" + flag.phase + ")，恢复…");
          // 还原档位降级游标（flag.target 已是当前/已降级到的目标）与限流退避计数
          ME.fallbackIndex = flag.fallbackIndex || 0;
          ME.soldOutRounds = flag.soldOutRounds || 0;
          ME.noCardRounds = flag.noCardRounds || 0;
          // 还原上次刷新时间：刷新后 content 重新注入，lastReloadAt 本会归零导致
          // onSoldOut 里 since = Date.now() - 0 恒成立 → 立即再刷新 → 死循环。
          // 取「flag 落盘时刻」与「上次真实刷新时刻」中较新者，作为本轮"刚刷过"的基准。
          ME.lastReloadAt = Math.max(flag.lastReloadAt || 0, flag.ts || 0) || Date.now();
          // countdown/preheat：仍按 fireAt 等待；其余阶段：直接恢复
          var resumePast = (flag.phase === "running" || flag.phase === "clicked-buy" ||
                            flag.phase === "captcha-wait" || flag.phase === "ordered");
          startGoFlow({
            config: config,
            target: flag.target || { tier: config.tier, period: config.period },
            fireAt: flag.fireAt || 0,
            role: flag.role || "primary",
            resume: resumePast,
            resumePhase: flag.phase,
            resumePastFire: true
          });
        }
      }
    } catch (e) {
      log("warn", "resume", "断点恢复检查异常: " + (e && e.message));
    }
  }

  // SPA 内部路由跳转后保持注册（监听 popstate / 软导航）
  window.addEventListener("popstate", function () {
    // 仅重新注册，不重复启动流程
    if (isOnSite()) sendBg("contentReady", { role: ME.role, url: location.href });
  });

  // 页面卸载前落盘当前阶段，利于刷新后恢复
  window.addEventListener("beforeunload", function () {
    try {
      if (ME.running && !ME.finished) {
        saveRunFlag(ME.clickedBuy ? (ME.confirmClicked ? "ordered" : "captcha-wait") : "running");
      }
    } catch (e) {}
  });

  // 首次用户交互时解锁 WebAudio（浏览器自动播放策略）
  ["click", "keydown", "pointerdown"].forEach(function (evt) {
    window.addEventListener(evt, function once() {
      ensureAudio();
      window.removeEventListener(evt, once);
    }, { once: true, capture: true });
  });

  // 持续记录「最近一次人工交互时刻」：供 startWaitCaptchaPass 的人工活动抑制使用——
  // 用户正在过验证码(点滑块/输短信)期间绝不被 limbo 超时误刷掉。轻量、被动，不影响抢购。
  ["pointerdown", "keydown", "click", "touchstart"].forEach(function (evt) {
    window.addEventListener(evt, function () { ME._lastUserActAt = Date.now(); }, { capture: true, passive: true });
  });

  // 启动
  try {
    init();
  } catch (e) {
    log("error", "content", "初始化失败: " + (e && e.message));
  }
})();
