/*
 * popup.js — GLM 抢购助手 弹窗逻辑
 *
 * 职责（对应契约 BEHAVIOR popup）：
 *   - 状态药丸（status pill）
 *   - 用 offset 校正的实时倒计时（本地 200ms 定时器刷新到 nextFireAt）
 *   - 目标信息（site/tier/period/stopPoint）+ 主/备标签指示
 *   - 实时日志面板：初次 getLogs，随后 logPush 增量
 *   - 按钮：Arm/Disarm、手动开抢(manualFire)、Dry-run(setDryRun)、导出、清空
 *   - status===captcha-wait 时显示醒目警告横幅
 *
 * 依赖：self.GLM.logger.fmt（由 logger.js 提供）。仅做 UI，不直接操作业务。
 */
(function () {
  "use strict";

  var G = self.GLM || {};
  var LOG_CAP = 500; // 与 background 环形缓冲一致

  // ---- DOM 引用 ----
  var $ = function (id) { return document.getElementById(id); };
  var elStatusPill = $("statusPill");
  var elStatusText = $("statusText");
  var elCaptchaBanner = $("captchaBanner");
  var elCountdownCard = $("countdownCard");
  var elCountdownTime = $("countdownTime");
  var elFireAt = $("fireAtText");
  var elOffset = $("offsetText");
  var elSite = $("mSite");
  var elTier = $("mTier");
  var elPeriod = $("mPeriod");
  var elStop = $("mStop");
  var elChipPrimary = $("chipPrimary");
  var elChipBackup = $("chipBackup");
  var elTargetProduct = $("targetProduct");
  var elBtnArm = $("btnArm");
  var elBtnDisarm = $("btnDisarm");
  var elBtnManual = $("btnManual");
  var elDryToggle = $("dryToggle");
  var elBtnExport = $("btnExport");
  var elBtnClear = $("btnClear");
  var elLogPanel = $("logPanel");
  var elOpenOptions = $("openOptions");
  var elVer = $("verText");

  // ---- 本地状态缓存 ----
  var lastState = null;   // 最近一次拿到的 state
  var lastConfig = null;  // 最近一次拿到的 config
  var offsetMs = 0;       // 服务器-本地 偏移（ms）
  var nextFireAt = 0;     // 下次开抢的服务器时间戳（ms）
  var countdownTimer = null;
  var logBuf = [];        // 本地日志缓冲（用于导出）
  var logEmptyShown = true;

  // ---- 文案映射 ----
  var STATUS_LABEL = {
    idle: "空闲",
    armed: "已布防",
    countdown: "倒计时中",
    preheat: "预热中",
    running: "抢购中",
    "captcha-wait": "等待人工验证",
    ordered: "已下单",
    "reached-payment": "已到支付页",
    "sold-out-retry": "售罄重试",
    "rate-limited": "限流恢复",
    stopped: "已停止",
    error: "错误"
  };
  // 状态 -> 药丸底色变量
  var STATUS_COLOR = {
    idle: "var(--pill-idle)",
    armed: "var(--info)",
    countdown: "var(--info)",
    preheat: "var(--accent)",
    running: "var(--accent)",
    "captcha-wait": "var(--warn)",
    ordered: "var(--ok)",
    "reached-payment": "var(--ok)",
    "sold-out-retry": "var(--warn)",
    "rate-limited": "var(--warn)",
    stopped: "var(--pill-idle)",
    error: "var(--err)"
  };
  // 活动态（药丸闪烁）
  var LIVE_STATES = { countdown: 1, preheat: 1, running: 1, "captcha-wait": 1, "sold-out-retry": 1, "rate-limited": 1 };

  var TIER_LABEL = { lite: "Lite", pro: "Pro", max: "Max" };
  var PERIOD_LABEL = { month: "月付", quarter: "季付", year: "年付" };
  var STOP_LABEL = { hold: "占位保号（下单不付款）", beforeConfirm: "停在确认支付前" };

  // ========== 与 background 通讯（封装异常） ==========
  function send(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, function (resp) {
        // 忽略「receiving end does not exist」等错误
        var err = chrome.runtime.lastError;
        if (err) {
          if (typeof cb === "function") cb(null, err);
          return;
        }
        if (typeof cb === "function") cb(resp, null);
      });
    } catch (e) {
      if (typeof cb === "function") cb(null, e);
    }
  }

  // ========== 倒计时格式化 ==========
  function pad(n, len) {
    var s = String(Math.abs(n));
    while (s.length < (len || 2)) s = "0" + s;
    return s;
  }
  // ms -> "HH:MM:SS" 或 "Dd HH:MM:SS"
  function fmtRemain(ms) {
    if (ms < 0) ms = 0;
    var totalSec = Math.floor(ms / 1000);
    var d = Math.floor(totalSec / 86400);
    var h = Math.floor((totalSec % 86400) / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    if (d > 0) return d + "天 " + pad(h) + ":" + pad(m) + ":" + pad(s);
    return pad(h) + ":" + pad(m) + ":" + pad(s);
  }
  // 时间戳 -> 本地可读
  function fmtClock(ts) {
    try {
      var dt = new Date(ts);
      var mo = pad(dt.getMonth() + 1), da = pad(dt.getDate());
      return mo + "-" + da + " " + pad(dt.getHours()) + ":" + pad(dt.getMinutes()) + ":" + pad(dt.getSeconds());
    } catch (e) { return "-"; }
  }

  // 每 200ms 刷新倒计时（用 offset 校正：服务器现在 = Date.now()+offset）
  function tickCountdown() {
    if (!nextFireAt) {
      elCountdownTime.textContent = "--:--:--";
      elFireAt.textContent = "未设定开抢时间";
      elOffset.textContent = "";
      elCountdownCard.classList.remove("imminent");
      return;
    }
    var serverNow = Date.now() + offsetMs;
    var remain = nextFireAt - serverNow;
    elCountdownTime.textContent = fmtRemain(remain);
    elFireAt.textContent = "开抢：" + fmtClock(nextFireAt);
    var off = Math.round(offsetMs);
    elOffset.textContent = "时间偏移 " + (off >= 0 ? "+" : "") + off + " ms（秒级精度，T0 由内容脚本毫秒自旋补偿）";
    // 临近 10 秒高亮
    if (remain <= 10000 && remain > -3000) {
      elCountdownCard.classList.add("imminent");
    } else {
      elCountdownCard.classList.remove("imminent");
    }
  }
  function startCountdown() {
    if (countdownTimer) return;
    tickCountdown();
    countdownTimer = setInterval(tickCountdown, 200);
  }

  // ========== 渲染状态 ==========
  function renderState(st) {
    lastState = st || {};
    var status = lastState.status || "idle";

    // 状态药丸
    elStatusText.textContent = STATUS_LABEL[status] || status;
    elStatusPill.style.background = STATUS_COLOR[status] || "var(--pill-idle)";
    if (LIVE_STATES[status]) elStatusPill.classList.add("live");
    else elStatusPill.classList.remove("live");

    // 验证码警告横幅
    if (status === "captcha-wait") elCaptchaBanner.classList.add("show");
    else elCaptchaBanner.classList.remove("show");

    // 时间相关
    offsetMs = typeof lastState.offsetMs === "number" ? lastState.offsetMs : 0;
    nextFireAt = typeof lastState.nextFireAt === "number" ? lastState.nextFireAt : 0;
    tickCountdown();

    // 目标产品（来自 state.target，可能比 config 更准）
    var tgt = lastState.target || {};
    if (tgt.productId) {
      elTargetProduct.textContent = "id: " + tgt.productId;
    } else {
      elTargetProduct.textContent = "";
    }

    // 主/备标签指示
    var role = lastState.role || {};
    renderTabChip(elChipPrimary, "主", role.primaryTabId, role.leaderTabId);
    renderTabChip(elChipBackup, "备", role.backupTabId, role.leaderTabId);

    // dry-run 开关
    var dry = !!lastState.dryRun;
    if (elDryToggle.checked !== dry) elDryToggle.checked = dry;

    // 按钮可用性：已布防/活动中禁用 Arm，允许 Disarm
    var armed = !!lastState.armed;
    var busy = LIVE_STATES[status] || status === "ordered" || status === "reached-payment";
    elBtnArm.disabled = armed;
    elBtnDisarm.disabled = !armed && !busy;
  }

  function renderTabChip(el, label, tabId, leaderTabId) {
    el.classList.remove("active", "leader");
    if (tabId != null) {
      el.classList.add("active");
      if (leaderTabId != null && tabId === leaderTabId) {
        el.classList.add("leader");
        setChipText(el, label + "·主控");
      } else {
        setChipText(el, label + " #" + tabId);
      }
    } else {
      setChipText(el, label + " 未开");
    }
  }
  // 仅替换 chip 的文本节点（保留前面的圆点 span）
  function setChipText(el, txt) {
    // 结构：<span class="ledot"></span> + 文本
    var dot = el.querySelector(".ledot");
    el.textContent = "";
    if (dot) el.appendChild(dot);
    el.appendChild(document.createTextNode(txt));
  }

  // ========== 渲染配置（目标信息） ==========
  function renderConfig(cfg) {
    lastConfig = cfg || {};
    elSite.textContent = lastConfig.site || "-";
    elTier.textContent = TIER_LABEL[lastConfig.tier] || lastConfig.tier || "-";
    elPeriod.textContent = PERIOD_LABEL[lastConfig.period] || lastConfig.period || "-";
    elStop.textContent = STOP_LABEL[lastConfig.stopPoint] || lastConfig.stopPoint || "hold";
  }

  // ========== 日志渲染 ==========
  function logLineEl(entry) {
    var line = document.createElement("div");
    var level = (entry && entry.level) || "info";
    line.className = "log-line " + level;
    var fmtFn = (G.logger && typeof G.logger.fmt === "function") ? G.logger.fmt : fallbackFmt;
    var text = fmtFn(entry);
    // 拆分成 时间 / 标签 / 正文 三段着色（基于 "HH:MM:SS.mmm [tag] msg"）
    var m = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\[[^\]]*\])\s*([\s\S]*)$/.exec(text);
    if (m) {
      var ts = document.createElement("span"); ts.className = "ts"; ts.textContent = m[1] + " ";
      var tg = document.createElement("span"); tg.className = "tag"; tg.textContent = m[2] + " ";
      var ms = document.createElement("span"); ms.className = "msg"; ms.textContent = m[3];
      line.appendChild(ts); line.appendChild(tg); line.appendChild(ms);
    } else {
      var msOnly = document.createElement("span"); msOnly.className = "msg"; msOnly.textContent = text;
      line.appendChild(msOnly);
    }
    return line;
  }
  // logger 不可用时的兜底格式化
  function fallbackFmt(entry) {
    try {
      var d = new Date((entry && entry.t) || Date.now());
      var hh = pad(d.getHours()), mm = pad(d.getMinutes()), ss = pad(d.getSeconds()), mss = pad(d.getMilliseconds(), 3);
      return hh + ":" + mm + ":" + ss + "." + mss + " [" + ((entry && entry.tag) || "-") + "] " + ((entry && entry.msg) || "");
    } catch (e) { return (entry && entry.msg) || ""; }
  }

  function clearEmptyHint() {
    if (logEmptyShown) {
      elLogPanel.innerHTML = "";
      logEmptyShown = false;
    }
  }
  function showEmptyHint() {
    elLogPanel.innerHTML = '<div class="log-empty">暂无日志</div>';
    logEmptyShown = true;
  }

  // 是否已滚动到底部（自动跟随用）
  function atBottom() {
    return elLogPanel.scrollTop + elLogPanel.clientHeight >= elLogPanel.scrollHeight - 24;
  }

  function appendLog(entry, follow) {
    if (!entry) return;
    clearEmptyHint();
    var stick = follow && atBottom();
    elLogPanel.appendChild(logLineEl(entry));
    // 限制 DOM 行数，避免无限增长
    while (elLogPanel.childNodes.length > LOG_CAP) {
      elLogPanel.removeChild(elLogPanel.firstChild);
    }
    logBuf.push(entry);
    if (logBuf.length > LOG_CAP) logBuf.shift();
    if (stick) elLogPanel.scrollTop = elLogPanel.scrollHeight;
  }

  function renderLogs(logs) {
    logBuf = Array.isArray(logs) ? logs.slice(-LOG_CAP) : [];
    elLogPanel.innerHTML = "";
    if (!logBuf.length) { showEmptyHint(); return; }
    logEmptyShown = false;
    for (var i = 0; i < logBuf.length; i++) {
      elLogPanel.appendChild(logLineEl(logBuf[i]));
    }
    elLogPanel.scrollTop = elLogPanel.scrollHeight;
  }

  // ========== 初始化拉取 ==========
  function refreshAll() {
    send({ type: "getState" }, function (resp) {
      if (resp && resp.state) renderState(resp.state);
    });
    send({ type: "getConfig" }, function (resp) {
      if (resp && resp.config) renderConfig(resp.config);
    });
    send({ type: "getLogs" }, function (resp) {
      if (resp && Array.isArray(resp.logs)) renderLogs(resp.logs);
      else renderLogs([]);
    });
  }

  // ========== 按钮事件 ==========
  elBtnArm.addEventListener("click", function () {
    elBtnArm.disabled = true;
    send({ type: "arm" }, function (resp) {
      if (resp && resp.state) renderState(resp.state);
      else refreshAll();
    });
  });

  elBtnDisarm.addEventListener("click", function () {
    send({ type: "disarm" }, function (resp) {
      if (resp && resp.state) renderState(resp.state);
      else refreshAll();
    });
  });

  elBtnManual.addEventListener("click", function () {
    // 二次确认：手动开抢会立即触发抢购流程
    var ok = window.confirm("立即手动开抢？将在购买标签页执行抢购流程（验证码仍需人工完成）。");
    if (!ok) return;
    send({ type: "manualFire" }, function (resp) {
      if (resp && resp.state) renderState(resp.state);
    });
  });

  elDryToggle.addEventListener("change", function () {
    var val = !!elDryToggle.checked;
    send({ type: "setDryRun", value: val }, function (resp) {
      if (resp && resp.state) renderState(resp.state);
    });
  });

  elBtnExport.addEventListener("click", function () {
    // 优先请求 background 的导出（获取完整环形缓冲）；失败则用本地缓冲
    send({ type: "exportLogs" }, function (resp) {
      var logs = (resp && Array.isArray(resp.logs)) ? resp.logs : logBuf;
      doExport(logs);
    });
  });

  elBtnClear.addEventListener("click", function () {
    var ok = window.confirm("清空所有日志？");
    if (!ok) return;
    send({ type: "clearLogs" }, function () {
      logBuf = [];
      showEmptyHint();
    });
  });

  elOpenOptions.addEventListener("click", function (e) {
    e.preventDefault();
    try {
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else window.open(chrome.runtime.getURL("src/options.html"));
    } catch (err) {
      try { window.open(chrome.runtime.getURL("src/options.html")); } catch (e2) {}
    }
  });

  // 导出为本地文本文件
  function doExport(logs) {
    try {
      var fmtFn = (G.logger && typeof G.logger.fmt === "function") ? G.logger.fmt : fallbackFmt;
      var lines = (logs || []).map(function (e) { return fmtFn(e); });
      var header = "# GLM 抢购助手 日志导出 " + new Date().toISOString() + "\n";
      var blob = new Blob([header + lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      var stamp = new Date();
      var name = "glm-grab-logs-" + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) +
        "-" + pad(stamp.getHours()) + pad(stamp.getMinutes()) + pad(stamp.getSeconds()) + ".txt";
      a.href = url; a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) {
      window.alert("导出失败：" + (e && e.message ? e.message : e));
    }
  }

  // ========== 监听 background 广播（statePush / logPush） ==========
  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || !msg.type) return;
      if (msg.type === "statePush" && msg.state) {
        renderState(msg.state);
      } else if (msg.type === "logPush" && msg.entry) {
        appendLog(msg.entry, true);
      } else if (msg.type === "configUpdated" && msg.config) {
        renderConfig(msg.config);
      }
    });
  } catch (e) {}

  // ========== 版本号显示 ==========
  try {
    var mf = chrome.runtime.getManifest();
    if (mf && mf.version) elVer.textContent = "v" + mf.version;
  } catch (e) {}

  // ========== 启动 ==========
  startCountdown();
  refreshAll();

  // 弹窗关闭时清理定时器（释放）
  window.addEventListener("unload", function () {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  });
})();
