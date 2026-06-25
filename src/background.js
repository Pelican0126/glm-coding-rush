/*
 * background.js — GLM 抢购助手 经典 Service Worker（非 module）
 *
 * 职责：
 *   - 安装时写入默认 config；启动时若已 armed 且 dailyRearm 则重新调度。
 *   - arm/disarm：计算 nextFireAt（配置时区内当天/次日的 dropTime，换算为服务器时间），
 *     设置 chrome.alarms 粗调度（约 T-60s 唤醒）。
 *   - 时间再同步：arm 时与预热时各做一次 GLM.timesync.sync。
 *   - 精度策略：alarms 负责抗挂起的粗调度；约 T-90s 打开/聚焦购买标签页并再同步；
 *     约 T-15s 向 leader 发送 "go"{fireAt(服务器毫秒), config, target, role}，
 *     由 content 在 T0 附近用 rAF/performance.now 做最终毫秒级自旋。
 *   - 双标签：dualTab 时打开 primary+backup，leader=primary；backup 仅观察，
 *     leader 卡顿超过 takeoverMs 后 backup 收到 "becomeLeader" 接管。
 *   - 日志总线：logger._sink 写入 storage.logs 环形缓冲（上限 500）+ 广播 logPush；
 *     同样处理 content 发来的 "log" 消息。
 *   - 通知：captchaShown / reachedPayment / error 触发 chrome.notifications。
 *   - orderCreated/reachedPayment：落状态、通知、向另一标签发 "stop"；
 *     若非成功且 dailyRearm 则安排次日。
 *   - 处理全部 popup/options/content 消息。
 *
 * 注意：本文件以 importScripts 加载 3 个共享库（相对 SW 所在 src/ 目录）。
 */
"use strict";

/* 顶部加载共享库（解析相对于 SW 所在的 src/ 目录） */
try {
  importScripts("selectors.js", "logger.js", "timesync.js");
} catch (e) {
  // importScripts 失败时给出可见报错，但仍尽量让消息处理可用
  console.error("[background] importScripts 失败", e);
}

(function () {
  var G = (self.GLM = self.GLM || {});
  var L = G.logger || {
    // 极端兜底：库未加载时的最小 logger
    info: function () {},
    success: function () {},
    warn: function () {},
    error: function () {},
    fmt: function () {},
    _sink: null
  };
  var T = G.timesync;

  // ===== 常量 =====
  var SITE_URL = "https://open.bigmodel.cn/glm-coding";
  var TIME_SYNC_URL = "https://open.bigmodel.cn/glm-coding";
  var RUN_FLAG_KEY = "runFlag"; // 与 content.js 一致：断点恢复标志键（disarm 时由 background 直接清）
  var LOGS_CAP = 1000; // 日志环形缓冲上限（长跑窗口下保留更多历史）
  var ALARM_NAME = "glm-fire"; // 主调度 alarm
  var PREHEAT_ALARM = "glm-preheat"; // 预热（开标签+再同步）alarm
  var WATCHDOG_ALARM = "glm-watchdog"; // 接管看门狗 alarm
  var ALARM_LEAD_MS = 60 * 1000; // alarm 约提前 60s 唤醒（主调度兜底）
  var PREHEAT_LEAD_MS = 90 * 1000; // 约 T-90s 打开/聚焦标签并再同步，随即下发 go（content 在页面内自旋到 T0）
  // 看门狗 alarm 兜底周期：Chrome 对已安装扩展把 <1min 的周期钳到 1min，
  // 故这里直接用 1min（粗粒度）。真正的快速接管由 setInterval(200ms) 负责，
  // 且 leader 一旦提交(_committed)即永久禁用接管，alarm 仅作 SW 复活时的兜底。
  var WATCHDOG_TICK_MIN = 1; // 分钟

  // ===== 默认配置 =====
  function defaultConfig() {
    return {
      site: "bigmodel",
      tier: "pro",
      period: "month",
      dropTime: "10:00:00",
      timezone: "Asia/Shanghai",
      dailyRearm: true,
      triggerStrategy: "hybrid",
      advanceMs: 150,
      pollIntervalMs: 350,
      reloadIntervalMs: 1200,
      burstWindowMs: 180000,
      slowReloadIntervalMs: 4000,
      retryWindowMs: 3600000,
      dualTab: false,
      takeoverMs: 800,
      stopPoint: "hold", // hold=过验证码后自动点确认支付占位并停在支付页；beforeConfirm=停在确认支付按钮前
      execStrategy: "dom",
      coupon: "9KR0GRHWPL", // 邀请/优惠码(ic)：随 URL ?ic= 注入，下单(create-sign)带上；仅本账号自己的订单
      sound: true,
      notify: true,
      fallbackList: [], // 档位降级备选，元素 {tier,period}；主目标连续售罄达阈值后依次切换
      fallbackAfterRounds: 10, // 当前档位连续售罄多少轮(刷新)后降级到下一备选
      noCardBackoffRounds: 3, // 连续多少轮「无卡片」后判定软限流并退避刷新间隔
      backoffReloadIntervalMs: 12000, // 软限流退避时的刷新间隔
      selectorOverrides: {},
      maxTabs: 2
    };
  }

  // ===== 默认状态 =====
  function defaultState() {
    return {
      status: "idle",
      armed: false,
      dryRun: false,
      target: { tier: "pro", period: "month", productId: "" },
      offsetMs: 0,
      nextFireAt: 0,
      goDispatched: false,
      goDispatchedFireAt: 0,
      lastResult: "",
      role: { primaryTabId: 0, backupTabId: 0, leaderTabId: 0 },
      updatedAt: Date.now()
    };
  }

  // ===== 存储读写工具 =====
  function getLocal(keys) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(keys, function (res) {
          resolve(res || {});
        });
      } catch (e) {
        resolve({});
      }
    });
  }
  function setLocal(obj) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.set(obj, function () {
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  async function getConfig() {
    var r = await getLocal("config");
    if (r && r.config) {
      // 合并默认值，保证新增字段不缺失
      return Object.assign(defaultConfig(), r.config);
    }
    return defaultConfig();
  }
  async function setConfig(cfg) {
    var merged = Object.assign(defaultConfig(), cfg || {});
    await setLocal({ config: merged });
    return merged;
  }

  async function getState() {
    var r = await getLocal("state");
    if (r && r.state) return Object.assign(defaultState(), r.state);
    return defaultState();
  }
  async function setState(patch) {
    var cur = await getState();
    var next = Object.assign({}, cur, patch || {});
    next.updatedAt = Date.now();
    // role 做浅合并，避免覆盖丢失
    if (patch && patch.role) {
      next.role = Object.assign({}, cur.role || {}, patch.role);
    }
    if (patch && patch.target) {
      next.target = Object.assign({}, cur.target || {}, patch.target);
    }
    await setLocal({ state: next });
    broadcast({ type: "statePush", state: next });
    return next;
  }

  // ===== 广播（向 popup/options，runtime.sendMessage）=====
  function broadcast(msg) {
    try {
      chrome.runtime.sendMessage(msg, function () {
        // 没有接收者时会产生 lastError，忽略即可
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  }

  // ===== 向指定标签页发消息 =====
  function sendToTab(tabId, msg) {
    return new Promise(function (resolve) {
      if (!tabId) {
        resolve(false);
        return;
      }
      try {
        chrome.tabs.sendMessage(tabId, msg, function (resp) {
          // 标签未就绪/无 content 时 lastError，视为失败
          if (chrome.runtime.lastError) {
            resolve(false);
            return;
          }
          resolve(resp == null ? true : resp);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  // ===== 日志总线 =====
  // 将 logger._sink 设为：写入 storage.logs 环形缓冲 + 广播 logPush
  var _logBuffer = null; // 内存缓存，减少读写竞争
  async function appendLog(entry) {
    try {
      if (!entry) return;
      if (_logBuffer == null) {
        var r = await getLocal("logs");
        _logBuffer = Array.isArray(r.logs) ? r.logs : [];
      }
      _logBuffer.push(entry);
      if (_logBuffer.length > LOGS_CAP) {
        _logBuffer = _logBuffer.slice(_logBuffer.length - LOGS_CAP);
      }
      await setLocal({ logs: _logBuffer });
      broadcast({ type: "logPush", entry: entry });
    } catch (e) {}
  }
  // _sink 同步触发异步写入（不等待）
  L._sink = function (entry) {
    appendLog(entry);
  };

  async function clearLogs() {
    _logBuffer = [];
    await setLocal({ logs: [] });
  }
  async function getLogs() {
    if (_logBuffer != null) return _logBuffer.slice();
    var r = await getLocal("logs");
    _logBuffer = Array.isArray(r.logs) ? r.logs : [];
    return _logBuffer.slice();
  }

  // ===== 时区/触发时刻计算 =====
  /*
   * 在指定 IANA 时区下，求「今天或明天的 dropTime」对应的 UTC 毫秒时间戳（本地基准）。
   * 思路：用 Intl 取得该时区当前的 Y/M/D/H/M/S，构造目标墙钟时刻，
   * 再借助 tzOffset 反推 UTC。dropTime 形如 "HH:MM:SS"。
   */
  function parseHMS(str) {
    var parts = String(str || "10:00:00").split(":");
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    var s = parseInt(parts[2], 10);
    return {
      h: isNaN(h) ? 10 : h,
      m: isNaN(m) ? 0 : m,
      s: isNaN(s) ? 0 : s
    };
  }

  // 取某时区在某 UTC 时刻的偏移（分钟，东区为正）。
  function tzOffsetMinutes(timeZone, atUtcMs) {
    try {
      var dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: timeZone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });
      var parts = dtf.formatToParts(new Date(atUtcMs));
      var map = {};
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type !== "literal") map[parts[i].type] = parts[i].value;
      }
      // 把「该时区显示的墙钟」当作 UTC 解释，得到的毫秒 - 真实 UTC = 偏移
      var asUtc = Date.UTC(
        parseInt(map.year, 10),
        parseInt(map.month, 10) - 1,
        parseInt(map.day, 10),
        parseInt(map.hour === "24" ? "0" : map.hour, 10),
        parseInt(map.minute, 10),
        parseInt(map.second, 10)
      );
      return Math.round((asUtc - atUtcMs) / 60000);
    } catch (e) {
      // 兜底：Asia/Shanghai 固定 +480
      return 480;
    }
  }

  /*
   * computeNextFireServerMs(config) —— 计算下一次开售时刻对应的「真实纪元毫秒」（UTC）。
   *
   * 重要：本函数用纯日历数学（Intl 取时区年月日 + Date.UTC 反推 UTC）得到
   * dropTime 在配置时区下的真实 UTC 时间戳。它只用设备本地时钟来判定「今天/明天」
   * （日级粒度，几分钟级时钟偏差不会改变日期），不把本地时钟误差带进时刻本身。
   * 因此返回值就是「服务器真实开售时刻」，可直接作为 nextFireAt，
   * 由 content 用 server-now(=Date.now()+offset) 与之比较来触发（offset 不被抵消）。
   */
  function computeNextFireServerMs(config) {
    var tz = config.timezone || "Asia/Shanghai";
    var hms = parseHMS(config.dropTime);
    var nowMs = Date.now();

    // 取「现在」在该时区的年月日
    function ymdInTz(atUtcMs) {
      var dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      });
      var parts = dtf.formatToParts(new Date(atUtcMs));
      var map = {};
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type !== "literal") map[parts[i].type] = parts[i].value;
      }
      return {
        y: parseInt(map.year, 10),
        mo: parseInt(map.month, 10),
        d: parseInt(map.day, 10)
      };
    }

    // 由「该时区某天的墙钟 HH:MM:SS」求 UTC 毫秒
    function wallToUtc(y, mo, d) {
      // 先把墙钟当 UTC 解释，得到近似 UTC，再用该近似时刻的时区偏移反推
      var guessUtc = Date.UTC(y, mo - 1, d, hms.h, hms.m, hms.s);
      var off = tzOffsetMinutes(tz, guessUtc);
      var utc = guessUtc - off * 60000;
      // 二次校正（处理 DST 边界；Asia/Shanghai 无 DST，仍保留稳健性）
      var off2 = tzOffsetMinutes(tz, utc);
      if (off2 !== off) {
        utc = guessUtc - off2 * 60000;
      }
      return utc;
    }

    var today = ymdInTz(nowMs);
    var todayFire = wallToUtc(today.y, today.mo, today.d);
    if (todayFire > nowMs + 1000) {
      // 今天仍在未来（留 1s 余量）
      return todayFire;
    }
    // 否则取明天：用 today+24h 落在的时区日期
    var tomorrow = ymdInTz(nowMs + 24 * 3600 * 1000);
    return wallToUtc(tomorrow.y, tomorrow.mo, tomorrow.d);
  }

  // ===== 时间同步包装 =====
  async function resyncOffset(tag) {
    try {
      if (!T || typeof T.sync !== "function") return 0;
      var off = await T.sync(TIME_SYNC_URL, 5);
      await setState({ offsetMs: off });
      L.info(tag || "timesync", "时间偏移 offset=" + Math.round(off) + "ms (Date 头秒级，±500ms 由 advanceMs+重试补偿)");
      return off;
    } catch (e) {
      L.warn("timesync", "同步失败：" + (e && e.message ? e.message : e));
      return 0;
    }
  }

  // ===== alarms 调度 =====
  function clearAllAlarms() {
    try {
      chrome.alarms.clear(ALARM_NAME);
      chrome.alarms.clear(PREHEAT_ALARM);
      chrome.alarms.clear(WATCHDOG_ALARM);
    } catch (e) {}
  }

  /*
   * scheduleAlarms(fireServerMs, offset) —— 基于「服务器时刻」反推本地时刻设置 alarm。
   * alarm 的 when 必须用设备本地时钟（chrome.alarms 用 Date.now 体系），
   * 故 localWhen = serverFire - offset。
   */
  function scheduleAlarms(fireServerMs, offset) {
    clearAllAlarms();
    var localFire = fireServerMs - (offset || 0);
    var now = Date.now();

    // 预热 alarm（约 T-90s）
    var preheatAt = localFire - PREHEAT_LEAD_MS;
    if (preheatAt <= now + 1000) preheatAt = now + 1000; // 已临近则尽快
    try {
      chrome.alarms.create(PREHEAT_ALARM, { when: preheatAt });
    } catch (e) {}

    // 主调度 alarm（约 T-60s，作为发 go 的兜底唤醒；真正发 go 在更近处由内部计时完成）
    var fireAlarmAt = localFire - ALARM_LEAD_MS;
    if (fireAlarmAt <= now + 1000) fireAlarmAt = now + 1000;
    try {
      chrome.alarms.create(ALARM_NAME, { when: fireAlarmAt });
    } catch (e) {}

    L.info(
      "schedule",
      "已排程：开售(服务器)=" +
        new Date(fireServerMs).toISOString() +
        " 本地=" +
        new Date(localFire).toLocaleString() +
        " offset=" +
        Math.round(offset || 0) +
        "ms"
    );
  }

  // ===== 标签页管理 =====
  function queryTabsByUrl() {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.query(
          { url: ["https://open.bigmodel.cn/*", "https://bigmodel.cn/*"] },
          function (tabs) {
            resolve(tabs || []);
          }
        );
      } catch (e) {
        resolve([]);
      }
    });
  }
  function createTab(url, active) {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.create({ url: url, active: !!active }, function (tab) {
          resolve(tab || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }
  function updateTab(tabId, props) {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.update(tabId, props, function (tab) {
          void chrome.runtime.lastError;
          resolve(tab || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }
  function getTab(tabId) {
    return new Promise(function (resolve) {
      if (!tabId) {
        resolve(null);
        return;
      }
      try {
        chrome.tabs.get(tabId, function (tab) {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(tab || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // 重新加载标签并等待其加载完成。
  // 用途：把内容脚本注入到「扩展加载/更新前就已经打开」的标签（这种标签不会自动注入 content script）。
  function reloadTabAndWait(tabId, timeoutMs) {
    return new Promise(function (resolve) {
      if (!tabId) { resolve(false); return; }
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; cleanup(); resolve(false); }
      }, timeoutMs || 8000);
      function cleanup() {
        try { chrome.tabs.onUpdated.removeListener(listener); } catch (e) {}
      }
      function listener(id, info) {
        if (id === tabId && info && info.status === "complete") {
          if (!done) {
            done = true;
            clearTimeout(timer);
            cleanup();
            // 给 document_idle 的内容脚本一点注册时间
            setTimeout(function () { resolve(true); }, 800);
          }
        }
      }
      try {
        chrome.tabs.onUpdated.addListener(listener);
        chrome.tabs.reload(tabId, { bypassCache: true }, function () { void chrome.runtime.lastError; });
      } catch (e) {
        clearTimeout(timer);
        cleanup();
        resolve(false);
      }
    });
  }

  // 是否为目标抢购页（glm-coding）
  function isPurchaseUrl(url) {
    return typeof url === "string" && url.indexOf("open.bigmodel.cn/glm-coding") !== -1;
  }

  /*
   * ensureTabs(config) —— 确保 primary（+backup）标签存在并指向抢购页。
   * 复用已存在的 glm-coding 标签；尊重 maxTabs<=2 与 dualTab。
   * 返回 { primaryTabId, backupTabId }。
   */
  async function ensureTabs(config) {
    var maxTabs = Math.min(2, Math.max(1, config.maxTabs || 1));
    // 热备（双标签）暂强制停用：当前实现与"刷新驱动重试"有竞态（共享 runFlag 角色错乱 +
    // 看门狗误接管），单账号下有双下单风险。重写为可靠版前一律走单标签，忽略 config.dualTab。
    var wantBackup = false;
    void maxTabs;

    var existing = await queryTabsByUrl();
    // 优先选已在 glm-coding 的标签
    var purchaseTabs = existing.filter(function (t) {
      return isPurchaseUrl(t.url);
    });

    var primaryTabId = 0;
    var backupTabId = 0;

    if (purchaseTabs.length >= 1) {
      primaryTabId = purchaseTabs[0].id;
    } else if (existing.length >= 1) {
      // 有 bigmodel 标签但不在抢购页：导航过去复用
      primaryTabId = existing[0].id;
      await updateTab(primaryTabId, { url: SITE_URL, active: true });
    } else {
      // 全新打开
      var t = await createTab(SITE_URL, true);
      primaryTabId = t ? t.id : 0;
    }

    // 聚焦 primary
    if (primaryTabId) {
      await updateTab(primaryTabId, { active: true });
      try {
        var pt = await getTab(primaryTabId);
        if (pt && pt.windowId != null) {
          chrome.windows.update(pt.windowId, { focused: true }, function () {
            void chrome.runtime.lastError;
          });
        }
      } catch (e) {}
    }

    if (wantBackup) {
      if (purchaseTabs.length >= 2) {
        backupTabId = purchaseTabs[1].id;
      } else {
        var tb = await createTab(SITE_URL, false);
        backupTabId = tb ? tb.id : 0;
      }
    }

    L.info(
      "tabs",
      "标签就绪 primary=" + primaryTabId + (wantBackup ? " backup=" + backupTabId : " (单标签)")
    );
    return { primaryTabId: primaryTabId, backupTabId: backupTabId };
  }

  // ===== 通知 =====
  function notify(title, message) {
    try {
      // getURL 从扩展根目录解析；图标位于 icons/ 下（manifest 已声明 web_accessible_resources）。
      chrome.notifications.create(
        "glm-" + Date.now(),
        {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title: title || "GLM 抢购助手",
          message: message || "",
          priority: 2
        },
        function () {
          // 记录而非吞掉错误，便于发现通知创建失败
          if (chrome.runtime.lastError) {
            console.warn("[background] notifications.create 失败:", chrome.runtime.lastError.message);
          }
        }
      );
    } catch (e) {
      console.warn("[background] notify 异常:", e);
    }
  }

  // ===== 解析 target（从 productCache 取动态 productId 作为提示）=====
  async function buildTarget(config) {
    var target = { tier: config.tier, period: config.period, productId: "" };
    try {
      var r = await getLocal("productCache");
      var cache = r.productCache || {};
      var key = (config.site || "bigmodel") + ":" + config.tier + ":" + config.period;
      var hit = cache[key];
      // 12h TTL
      if (hit && hit.ts && Date.now() - hit.ts < 12 * 3600 * 1000) {
        target.productId = hit.productId || "";
      }
    } catch (e) {}
    return target;
  }

  // ===== 发送 go 给 leader（带 backup 协调）=====
  var _goSent = false; // 防重发
  var _runActive = false; // 本轮抢购是否进行中
  var _leaderTabId = 0;
  var _backupTabId = 0;
  var _lastLeaderSignalAt = 0; // 最近一次收到 leader 活动信号的时间
  var _takenOver = false;
  var _committed = false; // leader 已点过购买/进入验证码：禁止任何接管（防双下单）

  async function sendGo() {
    if (_goSent) return;
    var config = await getConfig();
    var state = await getState();
    // 跨 SW 重启幂等：本轮(同 fireAt)已下发过 go 则不重发——防 SW 挂起重启后 _goSent 归零导致二次 go 打断倒计时。
    if (state.goDispatched && state.goDispatchedFireAt === state.nextFireAt) { _goSent = true; return; }
    var target = await buildTarget(config);

    var role = state.role || {};
    var primaryTabId = role.primaryTabId || _leaderTabId;
    var backupTabId = role.backupTabId || _backupTabId;
    var fireAt = state.nextFireAt; // 服务器毫秒

    if (!primaryTabId) {
      L.error("go", "无可用 leader 标签，尝试重建标签");
      var tabs = await ensureTabs(config);
      primaryTabId = tabs.primaryTabId;
      backupTabId = tabs.backupTabId;
      await setState({ role: { primaryTabId: primaryTabId, backupTabId: backupTabId, leaderTabId: primaryTabId } });
    }

    _leaderTabId = primaryTabId;
    _backupTabId = backupTabId;
    _goSent = true;
    _runActive = true;
    _takenOver = false;
    _committed = false;
    _lastLeaderSignalAt = Date.now();

    await setState({ status: "preheat", role: { leaderTabId: primaryTabId }, goDispatched: true, goDispatchedFireAt: fireAt });

    // leader：正常下单角色
    var goMsg = { type: "go", config: config, target: target, fireAt: fireAt, role: "leader" };
    var okLeader = await sendToTab(primaryTabId, goMsg);
    if (!okLeader) {
      // 标签里没有内容脚本（最常见：扩展加载/更新后这个标签没刷新过）→ 刷新注入再发一次
      L.warn("go", "leader(tab " + primaryTabId + ") 无内容脚本，刷新该标签注入后重试（扩展加载后需刷新页面）");
      await reloadTabAndWait(primaryTabId);
      okLeader = await sendToTab(primaryTabId, goMsg);
    }
    L.info("go", "已向 leader(tab " + primaryTabId + ") 下发 go，fireAt=" + fireAt + (okLeader ? "" : " (仍未确认，请手动刷新该标签后重抢)"));

    // backup：观察角色（不提交，等待 becomeLeader）
    if (backupTabId) {
      await sendToTab(backupTabId, {
        type: "go",
        config: config,
        target: target,
        fireAt: fireAt,
        role: "backup"
      });
      L.info("go", "已向 backup(tab " + backupTabId + ") 下发 go(observe)");
      // 启动接管看门狗
      startWatchdog(config.takeoverMs || 800);
    }
  }

  // 接管看门狗：若 leader 在 takeoverMs 内无活动信号，让 backup 接管。
  var _watchdogTimer = null;
  function startWatchdog(takeoverMs) {
    stopWatchdog();
    if (!_backupTabId) return;
    // 阈值至少 5s：刷新驱动重试时 leader 每次刷新都会"静默"~1s，过低阈值会误判为卡死并反复接管。
    var threshold = Math.max(5000, takeoverMs || 800);
    // 用短周期 setInterval（SW 在本轮活跃期间存活；alarm 兜底见 onAlarm）
    _watchdogTimer = setInterval(async function () {
      try {
        // 一旦 leader 已提交（点过购买/进入验证码），永不接管，避免第二个标签重复下单。
        if (!_runActive || _takenOver || _committed) {
          stopWatchdog();
          return;
        }
        var idle = Date.now() - _lastLeaderSignalAt;
        if (idle > threshold) {
          _takenOver = true;
          L.warn("takeover", "leader 静默 " + idle + "ms > " + threshold + "ms，backup(tab " + _backupTabId + ") 接管");
          await setState({ role: { leaderTabId: _backupTabId } });
          await sendToTab(_backupTabId, { type: "becomeLeader" });
          await sendToTab(_leaderTabId, { type: "standDown" });
          stopWatchdog();
        }
      } catch (e) {}
    }, 200);
    // 同时设置 alarm 兜底（防 SW 被挂起后 setInterval 失效）
    try {
      chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_TICK_MIN });
    } catch (e) {}
  }
  function stopWatchdog() {
    if (_watchdogTimer) {
      clearInterval(_watchdogTimer);
      _watchdogTimer = null;
    }
    try {
      chrome.alarms.clear(WATCHDOG_ALARM);
    } catch (e) {}
  }

  // ===== arm / disarm =====
  async function arm() {
    var config = await getConfig();
    L.info("arm", "开始布防：目标 " + config.tier + "/" + config.period + " @ " + config.dropTime + " " + config.timezone);

    // arm 时再同步时间
    var offset = await resyncOffset("arm");

    // 真实开售纪元（不含本地时钟误差，不预埋 offset）
    var fireServer = computeNextFireServerMs(config);
    var target = await buildTarget(config);

    _goSent = false;
    _runActive = false;
    _takenOver = false;
    _committed = false;

    await setState({
      status: "countdown",
      armed: true,
      target: target,
      offsetMs: offset,
      nextFireAt: fireServer,
      goDispatched: false,
      goDispatchedFireAt: 0,
      lastResult: ""
    });

    scheduleAlarms(fireServer, offset);

    // 展示给用户的本地时刻 = 真实开售时刻在本设备时钟上的对应时刻（fireServer - offset）
    var displayLocal = fireServer - offset;
    notifyIfEnabled(config, "已布防", "将于 " + new Date(displayLocal).toLocaleString() + " 开抢 " + config.tier + "/" + config.period);
    return await getState();
  }

  async function disarm() {
    L.info("disarm", "撤防");
    clearAllAlarms();
    stopWatchdog();
    _goSent = false;
    _runActive = false;
    _committed = false;
    _takenOver = false;
    _leaderTabId = 0;
    _backupTabId = 0;
    // 关键：在 background 侧直接清掉 runFlag。否则 tab 正在 location.replace 过程中时，
    // stop 消息送达失败 → content 不执行 clearRunFlag → 残留 runFlag 被刷新后的新 content 读到
    // 又恢复抢购，造成"撤防了还在刷"。
    try {
      var rf = {};
      rf[RUN_FLAG_KEY] = null;
      await setLocal(rf);
    } catch (e) {}
    var state = await getState();
    // 通知正在跑的标签停止（best-effort；即便消息丢失，runFlag 已清，刷新后也不会再恢复）
    try {
      if (state.role) {
        if (state.role.primaryTabId) sendToTab(state.role.primaryTabId, { type: "stop" });
        if (state.role.backupTabId) sendToTab(state.role.backupTabId, { type: "stop" });
      }
    } catch (e) {}
    return await setState({ status: "idle", armed: false, nextFireAt: 0, goDispatched: false, goDispatchedFireAt: 0 });
  }

  // 手动开抢：立即预热并尽快发 go（fireAt 设为「现在+小提前量」）
  async function manualFire() {
    var config = await getConfig();
    L.warn("manual", "手动开抢触发");
    var offset = await resyncOffset("manual");
    var tabs = await ensureTabs(config);
    var fireServer = (T ? T.now(offset) : Date.now() + offset) + 1200; // 给 content ~1.2s 预热
    await setState({
      status: "preheat",
      armed: true,
      offsetMs: offset,
      nextFireAt: fireServer,
      goDispatched: false,
      goDispatchedFireAt: 0,
      role: { primaryTabId: tabs.primaryTabId, backupTabId: tabs.backupTabId, leaderTabId: tabs.primaryTabId }
    });
    _goSent = false;
    // 立刻发 go（content 内部会自旋到 fireAt）
    await sendGo();
    return await getState();
  }

  function notifyIfEnabled(config, title, msg) {
    if (config && config.notify) notify(title, msg);
  }

  // ===== preheat 流程（alarm 触发 或 手动）=====
  async function doPreheat() {
    var config = await getConfig();
    L.info("preheat", "预热：打开/聚焦标签 + 再同步时间");
    // 再同步
    var offset = await resyncOffset("preheat");
    // 重算 fireAt（真实开售纪元；不含本地时钟误差，不预埋 offset）
    var fireServer = computeNextFireServerMs(config);
    var tabs = await ensureTabs(config);
    await setState({
      status: "preheat",
      offsetMs: offset,
      nextFireAt: fireServer,
      role: { primaryTabId: tabs.primaryTabId, backupTabId: tabs.backupTabId, leaderTabId: tabs.primaryTabId }
    });
    _leaderTabId = tabs.primaryTabId;
    _backupTabId = tabs.backupTabId;

    // 立即下发 go：让 content 在「页面内」自旋到 fireAt（页面计时不受 SW 30s 挂起影响）。
    // 不再用跨挂起会丢失的长 setTimeout，也不依赖 alarm 的亚分钟精度——SW 此后即使被挂起也无妨。
    L.info("preheat", "预热完成，立即下发 go（由内容脚本在页面内自旋到 T0）");
    await sendGo();
  }

  // ===== alarm 处理 =====
  chrome.alarms.onAlarm.addListener(function (alarm) {
    (async function () {
      try {
        if (!alarm) return;
        if (alarm.name === PREHEAT_ALARM) {
          await doPreheat();
        } else if (alarm.name === ALARM_NAME) {
          // 主调度兜底（约 T-60s）：极端情况(PREHEAT_ALARM 未触发)时补做预热+发 go。
          // doPreheat 内部会 sendGo；sendGo 经 state.goDispatched 自带跨 SW 重启幂等，重复调用安全。
          // go 之后由内容脚本在「页面内」自旋到 T0，不再用此处会随 SW 挂起丢失的 setTimeout。
          var state = await getState();
          if (!state.armed) return;
          if (!state.goDispatched) {
            await doPreheat();
          }
        } else if (alarm.name === WATCHDOG_ALARM) {
          // 看门狗 alarm 兜底（SW 复活时）：检查 leader 静默
          // 已提交则绝不接管（防双下单）。
          if (_runActive && !_takenOver && !_committed && _backupTabId) {
            var idle = Date.now() - _lastLeaderSignalAt;
            var cfg = await getConfig();
            if (idle > Math.max(5000, cfg.takeoverMs || 800)) {
              _takenOver = true;
              L.warn("takeover", "[alarm] leader 静默，backup 接管");
              await setState({ role: { leaderTabId: _backupTabId } });
              await sendToTab(_backupTabId, { type: "becomeLeader" });
              await sendToTab(_leaderTabId, { type: "standDown" });
              stopWatchdog();
            }
          }
        }
      } catch (e) {
        L.error("alarm", "处理异常：" + (e && e.message ? e.message : e));
      }
    })();
  });

  // ===== 安排次日（dailyRearm）=====
  async function rearmNextDay(reason) {
    var config = await getConfig();
    if (!config.dailyRearm) {
      L.info("rearm", "未开启每日自动重布防，结束本轮");
      await setState({ armed: false });
      return;
    }
    L.info("rearm", "安排次日开抢（" + (reason || "") + "）");
    _goSent = false;
    _runActive = false;
    _takenOver = false;
    _committed = false;
    stopWatchdog();
    var offset = (await getState()).offsetMs || 0;
    var fireServer = computeNextFireServerMs(config);
    await setState({
      status: "countdown",
      armed: true,
      nextFireAt: fireServer,
      goDispatched: false,
      goDispatchedFireAt: 0
    });
    scheduleAlarms(fireServer, offset);
  }

  // ===== 结束本轮（成功占位/到达支付页）=====
  async function finishRun(success, statusLabel, resultMsg) {
    _runActive = false;
    stopWatchdog();
    var config = await getConfig();
    var state = await getState();
    // 通知另一标签停止
    try {
      var leader = (state.role && state.role.leaderTabId) || _leaderTabId;
      var primary = (state.role && state.role.primaryTabId) || 0;
      var backup = (state.role && state.role.backupTabId) || 0;
      var others = [primary, backup].filter(function (id) {
        return id && id !== leader;
      });
      others.forEach(function (id) {
        sendToTab(id, { type: "stop" });
      });
    } catch (e) {}

    await setState({ status: statusLabel || "stopped", lastResult: resultMsg || "" });

    if (success) {
      // 成功占位：不再每日重布防（库存已占住，需人工付款）
      await setState({ armed: false });
    } else if (config.dailyRearm) {
      await rearmNextDay("本轮未成功");
    } else {
      await setState({ armed: false });
    }
  }

  // ===== 消息路由 =====
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    var senderTabId = sender && sender.tab ? sender.tab.id : 0;

    // 标记 leader 活动（content 任意上行消息都视为活跃信号）
    if (senderTabId && senderTabId === _leaderTabId) {
      _lastLeaderSignalAt = Date.now();
    }

    (async function () {
      try {
        switch (msg.type) {
          // ---- popup ----
          case "getState": {
            sendResponse({ state: await getState() });
            return;
          }
          case "getConfig": {
            sendResponse({ config: await getConfig() });
            return;
          }
          case "getLogs": {
            sendResponse({ logs: await getLogs() });
            return;
          }
          case "arm": {
            sendResponse({ state: await arm() });
            return;
          }
          case "disarm": {
            sendResponse({ state: await disarm() });
            return;
          }
          case "manualFire": {
            sendResponse({ state: await manualFire() });
            return;
          }
          case "setDryRun": {
            var st = await setState({ dryRun: !!msg.value });
            L.info("dryrun", "演练模式=" + (!!msg.value));
            // 若有进行中的标签，转告（携带 config + dryRun，消息才有实际效果）
            try {
              var cfgDr = await getConfig();
              if (st.role) {
                if (st.role.primaryTabId) sendToTab(st.role.primaryTabId, { type: "configUpdated", config: cfgDr, dryRun: st.dryRun });
                if (st.role.backupTabId) sendToTab(st.role.backupTabId, { type: "configUpdated", config: cfgDr, dryRun: st.dryRun });
              }
            } catch (e) {}
            sendResponse({ state: st });
            return;
          }
          case "exportLogs": {
            sendResponse({ logs: await getLogs() });
            return;
          }
          case "clearLogs": {
            await clearLogs();
            sendResponse({ ok: true });
            return;
          }

          // ---- options ----
          case "setConfig": {
            var merged = await setConfig(msg.config);
            L.info("config", "配置已更新");
            // 若已布防：基于新配置重排（dropTime/timezone 可能变化）
            var s = await getState();
            if (s.armed) {
              await arm();
            }
            // 通知运行中的标签 + 广播给 popup（携带合并后的 config，消息才有实际效果）
            try {
              if (s.role) {
                if (s.role.primaryTabId) sendToTab(s.role.primaryTabId, { type: "configUpdated", config: merged, dryRun: s.dryRun });
                if (s.role.backupTabId) sendToTab(s.role.backupTabId, { type: "configUpdated", config: merged, dryRun: s.dryRun });
              }
            } catch (e) {}
            broadcast({ type: "configUpdated", config: merged });
            sendResponse({ config: merged });
            return;
          }

          // ---- content -> bg ----
          case "log": {
            // content 上行日志：写入环形缓冲 + 广播
            if (msg.entry) await appendLog(msg.entry);
            sendResponse({ ok: true });
            return;
          }
          case "state": {
            // content 请求打补丁
            if (msg.patch) await setState(msg.patch);
            sendResponse({ ok: true });
            return;
          }
          case "contentReady": {
            L.info("content", "标签 " + senderTabId + " 就绪 role=" + (msg.role || "?"));
            // 注：content 通过 sendBg() 发送本消息（无响应回调），故不再回传 state；
            // 重载断点恢复完全依赖 storage 的 runFlag。
            sendResponse({ ok: true });
            return;
          }
          case "heartbeat": {
            // 仅用于刷新 leader 活动时间（已在监听器顶部完成），这里直接应答。
            sendResponse({ ok: true });
            return;
          }
          case "buyable": {
            L.success("buyable", "tab " + senderTabId + " 检测到可购买，准备点击");
            sendResponse({ ok: true });
            return;
          }
          case "captchaShown": {
            // leader 已点击购买并触发验证码：锁定提交状态，永久冻结接管，避免 backup 重复下单。
            _committed = true;
            stopWatchdog();
            // 明确让 backup 退场（仅观察，绝不提交），双保险。
            try {
              if (_backupTabId && _backupTabId !== senderTabId) {
                sendToTab(_backupTabId, { type: "standDown" });
              }
            } catch (e) {}
            await setState({ status: "captcha-wait" });
            var c1 = await getConfig();
            notifyIfEnabled(c1, "请立即完成验证码", "腾讯验证码已弹出，请手动完成以占住库存！");
            L.warn("captcha", "验证码已弹出，等待人工完成（绝不自动破解）；已冻结接管看门狗");
            sendResponse({ ok: true });
            return;
          }
          case "captchaPassed": {
            L.success("captcha", "验证码已通过，继续下单流程");
            sendResponse({ ok: true });
            return;
          }
          case "orderCreated": {
            _committed = true;
            stopWatchdog();
            L.success("order", "订单已创建（未支付），库存占位成功");
            var c2 = await getConfig();
            notifyIfEnabled(c2, "下单占位成功", "未支付订单已创建，库存已占住，请尽快人工付款。");
            // 结算对齐：content 在 ordered 分支已 finishRun(true) 永久停手等人工付款；background 也须结算
            // （armed=false、_runActive=false、通知另一标签停），否则状态机分歧→当日 armed 卡死无 go、
            // dailyRearm 形同停摆。占位成功视为本轮终态，当日/次日不再自动重抢（防本账号重复占单）。
            await finishRun(true, "ordered", "已下单(create-sign)占位，请人工核对金额并付款");
            sendResponse({ ok: true });
            return;
          }
          case "reachedPayment": {
            L.success("payment", "已到达支付页，停止（绝不自动付款）");
            var c3 = await getConfig();
            notifyIfEnabled(c3, "已到达支付页", "已停在支付页，请人工完成付款。脚本不会自动付款。");
            await finishRun(true, "reached-payment", "已到达支付页，等待人工付款");
            sendResponse({ ok: true });
            return;
          }
          case "soldOut": {
            await setState({ status: "sold-out-retry" });
            sendResponse({ ok: true });
            return;
          }
          case "rateLimited": {
            await setState({ status: "rate-limited" });
            L.warn("ratelimit", "页面繁忙/限流，按礼貌节流重试");
            sendResponse({ ok: true });
            return;
          }
          case "error": {
            await setState({ status: "error", lastResult: msg.msg || "未知错误" });
            L.error("content", "tab " + senderTabId + " 报错：" + (msg.msg || ""));
            var c4 = await getConfig();
            notifyIfEnabled(c4, "抢购出错", msg.msg || "发生错误，请查看日志。");
            sendResponse({ ok: true });
            return;
          }
          default:
            // 未知类型：忽略
            return;
        }
      } catch (e) {
        L.error("router", "消息处理异常(" + (msg && msg.type) + ")：" + (e && e.message ? e.message : e));
        try {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        } catch (e2) {}
      }
    })();

    // 异步响应：保持消息端口开放
    return true;
  });

  // ===== 标签关闭：角色清理 / 可能触发接管 =====
  chrome.tabs.onRemoved.addListener(function (tabId) {
    (async function () {
      try {
        if (!tabId) return;
        var state = await getState();
        var role = state.role || {};
        if (tabId === role.leaderTabId && _runActive && !_takenOver && !_committed && _backupTabId && tabId !== _backupTabId) {
          // leader 关闭：让 backup 立即接管（仅在 leader 尚未提交时；已提交则不接管以防重复下单）
          _takenOver = true;
          L.warn("takeover", "leader 标签关闭，backup(tab " + _backupTabId + ") 立即接管");
          await setState({ role: { leaderTabId: _backupTabId } });
          await sendToTab(_backupTabId, { type: "becomeLeader" });
          stopWatchdog();
        }
        if (tabId === _leaderTabId) _leaderTabId = role.leaderTabId === _backupTabId ? _backupTabId : 0;
        if (tabId === _backupTabId) _backupTabId = 0;
      } catch (e) {}
    })();
  });

  // ===== 安装 / 启动 =====
  chrome.runtime.onInstalled.addListener(function (details) {
    (async function () {
      try {
        // 写入默认 config（仅在不存在时）
        var r = await getLocal(["config", "state"]);
        if (!r.config) {
          await setLocal({ config: defaultConfig() });
          L.info("install", "已写入默认配置");
        }
        if (!r.state) {
          await setLocal({ state: defaultState() });
        }
        // 初始化日志缓冲
        var lr = await getLocal("logs");
        if (!Array.isArray(lr.logs)) await setLocal({ logs: [] });
        L.info("install", "安装/更新完成 (" + (details && details.reason) + ")");
      } catch (e) {
        L.error("install", "安装初始化异常：" + (e && e.message ? e.message : e));
      }
    })();
  });

  chrome.runtime.onStartup.addListener(function () {
    (async function () {
      try {
        var config = await getConfig();
        var state = await getState();
        L.info("startup", "服务启动，armed=" + state.armed + " dailyRearm=" + config.dailyRearm);
        if (state.armed && config.dailyRearm) {
          // 重新调度（offset 会在 arm 内再同步）
          await arm();
        } else if (state.armed) {
          // 已布防但不每日重布防：基于现有 nextFireAt 重设 alarm（若仍在未来）
          if (state.nextFireAt && state.nextFireAt - (state.offsetMs || 0) > Date.now()) {
            scheduleAlarms(state.nextFireAt, state.offsetMs || 0);
          } else {
            await arm();
          }
        }
      } catch (e) {
        L.error("startup", "启动处理异常：" + (e && e.message ? e.message : e));
      }
    })();
  });

  L.info("bg", "background service worker 已加载");
})();
