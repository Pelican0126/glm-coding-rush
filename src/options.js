/*
 * options.js — GLM 抢购助手 设置页脚本
 *
 * 职责：
 *   - 通过 runtime 消息 "getConfig" 读取当前配置并回填表单。
 *   - 校验每个字段后，通过 "setConfig" 保存配置。
 *   - 提供「恢复默认」。
 *
 * 约定：不使用 ES module；logger.js 已先行加载（self.GLM.logger）。
 * 所有 DOM / 消息交互均包裹 try/catch，保持防御性。
 */
(function () {
  "use strict";

  var G = (self.GLM = self.GLM || {});
  var log = G.logger || {
    info: function () {},
    warn: function () {},
    error: function () {}
  };

  // ===== 默认配置（与契约 STORAGE.config 完全一致）=====
  var DEFAULT_CONFIG = {
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
    burstWindowMs: 60000,
    slowReloadIntervalMs: 4000,
    retryWindowMs: 3600000,
    dualTab: false,
    takeoverMs: 800,
    stopPoint: "hold",
    execStrategy: "dom",
    coupon: "",
    sound: true,
    notify: true,
    fallbackList: [],
    fallbackAfterRounds: 10,
    selectorOverrides: {},
    maxTabs: 2
  };

  // 枚举集合，用于校验
  var TIERS = ["lite", "pro", "max"];
  var PERIODS = ["month", "quarter", "year"];
  var TRIGGERS = ["hybrid", "observe", "reload"];
  var STOP_POINTS = ["hold", "beforeConfirm"];
  var EXEC_STRATEGIES = ["dom", "api"];
  var TIMEZONES = ["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Tokyo", "UTC"];

  // 防滥用硬下限/上限
  var POLL_FLOOR = 250; // 轮询/刷新下限 250ms
  var MAX_TABS_CAP = 2; // 最多 2 个标签

  // ---------- 小工具 ----------
  function $(id) {
    return document.getElementById(id);
  }
  function fieldEl(name) {
    return document.querySelector('.field[data-field="' + name + '"]');
  }
  function setInvalid(name, isInvalid, msg) {
    try {
      var f = fieldEl(name);
      if (!f) return;
      if (isInvalid) {
        f.classList.add("invalid");
        if (msg) {
          var err = f.querySelector(".err");
          if (err) err.textContent = msg;
        }
      } else {
        f.classList.remove("invalid");
      }
    } catch (e) {}
  }
  function clearAllInvalid() {
    try {
      var nodes = document.querySelectorAll(".field.invalid");
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].classList.remove("invalid");
      }
    } catch (e) {}
  }
  function showStatus(text, kind) {
    try {
      var s = $("status");
      if (!s) return;
      s.textContent = text || "";
      s.className = "status" + (kind ? " " + kind : "");
      if (text) {
        clearTimeout(showStatus._t);
        if (kind !== "err") {
          showStatus._t = setTimeout(function () {
            try {
              s.textContent = "";
              s.className = "status";
            } catch (e) {}
          }, 2600);
        }
      }
    } catch (e) {}
  }

  // HH:MM:SS 校验；返回标准化字符串或 null
  function normTime(v) {
    if (typeof v !== "string") return null;
    var s = v.trim();
    // time 控件 step=1 时给出 HH:MM:SS；某些情况下可能仅 HH:MM
    var m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
    if (!m) return null;
    var hh = parseInt(m[1], 10);
    var mm = parseInt(m[2], 10);
    var ss = m[3] != null ? parseInt(m[3], 10) : 0;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) return null;
    function p2(n) {
      return n < 10 ? "0" + n : "" + n;
    }
    return p2(hh) + ":" + p2(mm) + ":" + p2(ss);
  }
  function timeToSeconds(hhmmss) {
    var parts = hhmmss.split(":");
    return (
      parseInt(parts[0], 10) * 3600 +
      parseInt(parts[1], 10) * 60 +
      parseInt(parts[2], 10)
    );
  }
  function isInt(n) {
    return typeof n === "number" && isFinite(n) && Math.floor(n) === n;
  }
  function clampInt(v, lo, hi) {
    var n = Math.round(v);
    if (n < lo) n = lo;
    if (n > hi) n = hi;
    return n;
  }

  // ===== 回填表单 =====
  function fillForm(cfg) {
    try {
      var c = cfg || {};
      // 抢购目标
      if ($("f-site")) $("f-site").value = c.site || DEFAULT_CONFIG.site;
      if ($("f-tier")) $("f-tier").value = c.tier || DEFAULT_CONFIG.tier;
      if ($("f-period")) $("f-period").value = c.period || DEFAULT_CONFIG.period;

      // 时间与触发
      if ($("f-dropTime"))
        $("f-dropTime").value = normTime(c.dropTime) || DEFAULT_CONFIG.dropTime;
      if ($("f-timezone"))
        $("f-timezone").value = c.timezone || DEFAULT_CONFIG.timezone;
      if ($("f-triggerStrategy"))
        $("f-triggerStrategy").value =
          c.triggerStrategy || DEFAULT_CONFIG.triggerStrategy;
      if ($("f-advanceMs"))
        $("f-advanceMs").value =
          c.advanceMs != null ? c.advanceMs : DEFAULT_CONFIG.advanceMs;
      if ($("f-pollIntervalMs"))
        $("f-pollIntervalMs").value =
          c.pollIntervalMs != null
            ? c.pollIntervalMs
            : DEFAULT_CONFIG.pollIntervalMs;
      if ($("f-reloadIntervalMs"))
        $("f-reloadIntervalMs").value =
          c.reloadIntervalMs != null ? c.reloadIntervalMs : DEFAULT_CONFIG.reloadIntervalMs;
      if ($("f-burstWindowSec"))
        $("f-burstWindowSec").value =
          Math.round((c.burstWindowMs != null ? c.burstWindowMs : DEFAULT_CONFIG.burstWindowMs) / 1000);
      if ($("f-slowReloadIntervalMs"))
        $("f-slowReloadIntervalMs").value =
          c.slowReloadIntervalMs != null ? c.slowReloadIntervalMs : DEFAULT_CONFIG.slowReloadIntervalMs;
      if ($("f-retryWindowSec"))
        $("f-retryWindowSec").value =
          Math.round((c.retryWindowMs != null ? c.retryWindowMs : DEFAULT_CONFIG.retryWindowMs) / 1000);
      if ($("f-dailyRearm"))
        $("f-dailyRearm").checked =
          c.dailyRearm != null ? !!c.dailyRearm : DEFAULT_CONFIG.dailyRearm;

      // 下单与停点（radio）
      setRadio("stopPoint", c.stopPoint || DEFAULT_CONFIG.stopPoint);
      setRadio("execStrategy", c.execStrategy || DEFAULT_CONFIG.execStrategy);

      // 双标签
      if ($("f-dualTab"))
        $("f-dualTab").checked =
          c.dualTab != null ? !!c.dualTab : DEFAULT_CONFIG.dualTab;
      if ($("f-takeoverMs"))
        $("f-takeoverMs").value =
          c.takeoverMs != null ? c.takeoverMs : DEFAULT_CONFIG.takeoverMs;
      if ($("f-maxTabs"))
        $("f-maxTabs").value =
          c.maxTabs != null ? c.maxTabs : DEFAULT_CONFIG.maxTabs;

      // 提醒
      if ($("f-sound"))
        $("f-sound").checked =
          c.sound != null ? !!c.sound : DEFAULT_CONFIG.sound;
      if ($("f-notify"))
        $("f-notify").checked =
          c.notify != null ? !!c.notify : DEFAULT_CONFIG.notify;

      // 高级
      if ($("f-selectorOverrides")) {
        var so = c.selectorOverrides;
        $("f-selectorOverrides").value =
          so && Object.keys(so).length ? JSON.stringify(so, null, 2) : "";
      }
      if ($("f-fallbackList")) {
        var fl = c.fallbackList;
        $("f-fallbackList").value =
          fl && fl.length ? JSON.stringify(fl, null, 2) : "";
      }
      if ($("f-fallbackAfterRounds"))
        $("f-fallbackAfterRounds").value =
          c.fallbackAfterRounds != null ? c.fallbackAfterRounds : DEFAULT_CONFIG.fallbackAfterRounds;
    } catch (e) {
      log.error("options", "回填表单失败: " + (e && e.message));
    }
  }

  function setRadio(name, value) {
    try {
      var radios = document.querySelectorAll('input[name="' + name + '"]');
      for (var i = 0; i < radios.length; i++) {
        radios[i].checked = radios[i].value === value;
      }
    } catch (e) {}
  }
  function getRadio(name) {
    try {
      var sel = document.querySelector('input[name="' + name + '"]:checked');
      return sel ? sel.value : null;
    } catch (e) {
      return null;
    }
  }

  // ===== 从表单收集 + 校验 -> { ok, config, errors } =====
  function collectAndValidate() {
    clearAllInvalid();
    var errors = [];
    var cfg = {};

    function fail(name, msg) {
      setInvalid(name, true, msg);
      errors.push(name);
    }

    try {
      // --- 站点 ---
      var site = $("f-site") ? $("f-site").value : DEFAULT_CONFIG.site;
      if (site !== "bigmodel") fail("site", "站点无效。");
      cfg.site = site;

      // --- tier / period ---
      var tier = $("f-tier") ? $("f-tier").value : "";
      if (TIERS.indexOf(tier) === -1) fail("tier", "请选择套餐等级。");
      cfg.tier = tier;

      var period = $("f-period") ? $("f-period").value : "";
      if (PERIODS.indexOf(period) === -1) fail("period", "请选择订阅周期。");
      cfg.period = period;

      // --- dropTime ---
      var dropRaw = $("f-dropTime") ? $("f-dropTime").value : "";
      var dropTime = normTime(dropRaw);
      if (!dropTime) fail("dropTime", "时间格式应为 HH:MM:SS。");
      cfg.dropTime = dropTime || DEFAULT_CONFIG.dropTime;

      // --- timezone ---
      var tz = $("f-timezone") ? $("f-timezone").value : "";
      if (TIMEZONES.indexOf(tz) === -1) fail("timezone", "时区无效。");
      cfg.timezone = tz;

      // --- triggerStrategy ---
      var trig = $("f-triggerStrategy") ? $("f-triggerStrategy").value : "";
      if (TRIGGERS.indexOf(trig) === -1) fail("triggerStrategy", "触发策略无效。");
      cfg.triggerStrategy = trig;

      // --- advanceMs ---
      var advRaw = $("f-advanceMs") ? $("f-advanceMs").value : "";
      var adv = parseInt(advRaw, 10);
      if (advRaw === "" || isNaN(adv) || adv < 0 || adv > 2000) {
        fail("advanceMs", "应为 0 ~ 2000 的整数。");
        cfg.advanceMs = DEFAULT_CONFIG.advanceMs;
      } else {
        cfg.advanceMs = clampInt(adv, 0, 2000);
      }

      // --- pollIntervalMs（防滥用下限 250）---
      var pollRaw = $("f-pollIntervalMs") ? $("f-pollIntervalMs").value : "";
      var poll = parseInt(pollRaw, 10);
      if (pollRaw === "" || isNaN(poll) || poll < POLL_FLOOR || poll > 5000) {
        fail(
          "pollIntervalMs",
          "应为 " + POLL_FLOOR + " ~ 5000 的整数（防滥用下限）。"
        );
        cfg.pollIntervalMs = DEFAULT_CONFIG.pollIntervalMs;
      } else {
        cfg.pollIntervalMs = clampInt(poll, POLL_FLOOR, 5000);
      }

      // --- reloadIntervalMs（刷新周期，下限 250）---
      var rlRaw = $("f-reloadIntervalMs") ? $("f-reloadIntervalMs").value : "";
      var rl = parseInt(rlRaw, 10);
      if (rlRaw === "" || isNaN(rl) || rl < POLL_FLOOR || rl > 10000) {
        fail("reloadIntervalMs", "应为 " + POLL_FLOOR + " ~ 10000 的整数（毫秒）。");
        cfg.reloadIntervalMs = DEFAULT_CONFIG.reloadIntervalMs;
      } else { cfg.reloadIntervalMs = clampInt(rl, POLL_FLOOR, 10000); }

      // --- burstWindowSec（猛刷时长，秒 → ms）---
      var bwRaw = $("f-burstWindowSec") ? $("f-burstWindowSec").value : "";
      var bw = parseInt(bwRaw, 10);
      if (bwRaw === "" || isNaN(bw) || bw < 0 || bw > 3600) {
        fail("burstWindow", "应为 0 ~ 3600 的整数（秒）。");
        cfg.burstWindowMs = DEFAULT_CONFIG.burstWindowMs;
      } else { cfg.burstWindowMs = bw * 1000; }

      // --- slowReloadIntervalMs（退避后刷新周期，下限 250）---
      var srRaw = $("f-slowReloadIntervalMs") ? $("f-slowReloadIntervalMs").value : "";
      var sr = parseInt(srRaw, 10);
      if (srRaw === "" || isNaN(sr) || sr < POLL_FLOOR || sr > 60000) {
        fail("slowReloadIntervalMs", "应为 " + POLL_FLOOR + " ~ 60000 的整数（毫秒）。");
        cfg.slowReloadIntervalMs = DEFAULT_CONFIG.slowReloadIntervalMs;
      } else { cfg.slowReloadIntervalMs = clampInt(sr, POLL_FLOOR, 60000); }

      // --- retryWindow（重试时长，秒 → ms）---
      var rwRaw = $("f-retryWindowSec") ? $("f-retryWindowSec").value : "";
      var rwSec = parseInt(rwRaw, 10);
      if (rwRaw === "" || isNaN(rwSec) || rwSec < 10 || rwSec > 21600) {
        fail("retryWindow", "应为 10 ~ 21600 的整数（秒）。");
        cfg.retryWindowMs = DEFAULT_CONFIG.retryWindowMs;
      } else {
        cfg.retryWindowMs = rwSec * 1000;
      }

      // --- dailyRearm ---
      cfg.dailyRearm = $("f-dailyRearm") ? !!$("f-dailyRearm").checked : true;

      // --- stopPoint ---
      var sp = getRadio("stopPoint");
      if (STOP_POINTS.indexOf(sp) === -1) {
        fail("stopPoint", "请选择停点策略。");
        cfg.stopPoint = DEFAULT_CONFIG.stopPoint;
      } else {
        cfg.stopPoint = sp;
      }

      // --- execStrategy ---
      var es = getRadio("execStrategy");
      if (EXEC_STRATEGIES.indexOf(es) === -1) {
        fail("execStrategy", "请选择执行方式。");
        cfg.execStrategy = DEFAULT_CONFIG.execStrategy;
      } else {
        cfg.execStrategy = es;
      }

      // --- dualTab ---
      cfg.dualTab = $("f-dualTab") ? !!$("f-dualTab").checked : true;

      // --- takeoverMs ---
      var toRaw = $("f-takeoverMs") ? $("f-takeoverMs").value : "";
      var to = parseInt(toRaw, 10);
      if (toRaw === "" || isNaN(to) || to < 200 || to > 5000) {
        fail("takeoverMs", "应为 200 ~ 5000 的整数。");
        cfg.takeoverMs = DEFAULT_CONFIG.takeoverMs;
      } else {
        cfg.takeoverMs = clampInt(to, 200, 5000);
      }

      // --- maxTabs（上限 2）---
      var mtRaw = $("f-maxTabs") ? $("f-maxTabs").value : "";
      var mt = parseInt(mtRaw, 10);
      if (mtRaw === "" || isNaN(mt) || mt < 1 || mt > MAX_TABS_CAP) {
        fail("maxTabs", "应为 1 或 " + MAX_TABS_CAP + "。");
        cfg.maxTabs = DEFAULT_CONFIG.maxTabs;
      } else {
        cfg.maxTabs = clampInt(mt, 1, MAX_TABS_CAP);
      }

      // --- sound / notify ---
      cfg.sound = $("f-sound") ? !!$("f-sound").checked : true;
      cfg.notify = $("f-notify") ? !!$("f-notify").checked : true;

      // --- selectorOverrides（JSON 对象，可空）---
      var soRaw = $("f-selectorOverrides")
        ? String($("f-selectorOverrides").value || "").trim()
        : "";
      if (!soRaw) {
        cfg.selectorOverrides = {};
      } else {
        var soParsed = null;
        var soBad = false;
        try {
          soParsed = JSON.parse(soRaw);
        } catch (e) {
          soBad = true;
        }
        if (
          soBad ||
          soParsed === null ||
          typeof soParsed !== "object" ||
          Array.isArray(soParsed)
        ) {
          fail("selectorOverrides", "必须是合法的 JSON 对象。");
          cfg.selectorOverrides = {};
        } else {
          cfg.selectorOverrides = soParsed;
        }
      }

      // --- fallbackList（JSON 数组，每项 {tier, period}，可空）---
      var flRaw = $("f-fallbackList")
        ? String($("f-fallbackList").value || "").trim()
        : "";
      if (!flRaw) {
        cfg.fallbackList = [];
      } else {
        var flParsed = null;
        var flBad = false;
        try {
          flParsed = JSON.parse(flRaw);
        } catch (e) {
          flBad = true;
        }
        if (flBad || !Array.isArray(flParsed)) {
          fail("fallbackList", "必须是合法的 JSON 数组。");
          cfg.fallbackList = [];
        } else {
          // 校验每一项 tier/period
          var allItemsOk = true;
          for (var i = 0; i < flParsed.length; i++) {
            var it = flParsed[i];
            if (
              !it ||
              typeof it !== "object" ||
              TIERS.indexOf(it.tier) === -1 ||
              PERIODS.indexOf(it.period) === -1
            ) {
              allItemsOk = false;
              break;
            }
          }
          if (!allItemsOk) {
            fail(
              "fallbackList",
              "每项须为 {tier, period}，且 tier∈[lite,pro,max]、period∈[month,quarter,year]。"
            );
            cfg.fallbackList = [];
          } else {
            // 仅保留 tier/period 字段，避免脏数据
            cfg.fallbackList = flParsed.map(function (it) {
              return { tier: it.tier, period: it.period };
            });
          }
        }
      }

      // --- fallbackAfterRounds（候补切换轮数，1~200 整数）---
      var farRaw = $("f-fallbackAfterRounds") ? $("f-fallbackAfterRounds").value : "";
      var far = parseInt(farRaw, 10);
      if (farRaw === "" || isNaN(far) || far < 1 || far > 200) {
        fail("fallbackAfterRounds", "应为 1 ~ 200 的整数。");
        cfg.fallbackAfterRounds = DEFAULT_CONFIG.fallbackAfterRounds;
      } else {
        cfg.fallbackAfterRounds = clampInt(far, 1, 200);
      }
    } catch (e) {
      log.error("options", "校验异常: " + (e && e.message));
      errors.push("_internal");
    }

    return { ok: errors.length === 0, config: cfg, errors: errors };
  }

  // ===== 消息封装：getConfig / setConfig =====
  function sendMessage(payload) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(payload, function (resp) {
          var err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message));
            return;
          }
          resolve(resp);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  async function loadConfig() {
    try {
      var resp = await sendMessage({ type: "getConfig" });
      var cfg =
        resp && resp.config ? resp.config : null;
      if (!cfg) {
        // 后台尚未就绪：直接读 storage 兜底
        cfg = await readStorageConfig();
      }
      fillForm(mergeDefaults(cfg));
    } catch (e) {
      log.warn("options", "getConfig 失败，尝试直接读 storage: " + (e && e.message));
      try {
        var fallback = await readStorageConfig();
        fillForm(mergeDefaults(fallback));
      } catch (e2) {
        fillForm(DEFAULT_CONFIG);
        showStatus("读取配置失败，已载入默认值。", "err");
      }
    }
  }

  // 直接读 storage.local.config 作为兜底
  function readStorageConfig() {
    return new Promise(function (resolve) {
      try {
        if (!chrome.storage || !chrome.storage.local) {
          resolve(null);
          return;
        }
        chrome.storage.local.get(["config"], function (res) {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(res && res.config ? res.config : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // 合并默认值，确保所有字段齐全
  function mergeDefaults(cfg) {
    var out = {};
    for (var k in DEFAULT_CONFIG) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, k)) {
        out[k] = cfg && cfg[k] != null ? cfg[k] : DEFAULT_CONFIG[k];
      }
    }
    return out;
  }

  async function saveConfig() {
    var res = collectAndValidate();
    if (!res.ok) {
      showStatus("有 " + res.errors.length + " 处填写有误，请检查标红项。", "err");
      // 滚动到第一个错误
      try {
        var first = document.querySelector(".field.invalid");
        if (first && first.scrollIntoView) {
          first.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      } catch (e) {}
      return;
    }
    try {
      showStatus("保存中…");
      var resp = await sendMessage({ type: "setConfig", config: res.config });
      // 后台通常返回 {config} 或 {ok:true}
      var saved =
        resp && resp.config ? resp.config : res.config;
      fillForm(mergeDefaults(saved));
      showStatus("已保存。", "ok");
      log.info("options", "配置已保存");
    } catch (e) {
      // 兜底：直接写 storage（后台未就绪时仍能保存）
      try {
        await writeStorageConfig(res.config);
        showStatus("已保存（直写存储）。", "ok");
        log.warn("options", "setConfig 消息失败，已直写 storage: " + (e && e.message));
      } catch (e2) {
        showStatus("保存失败：" + (e2 && e2.message ? e2.message : "未知错误"), "err");
        log.error("options", "保存失败: " + (e2 && e2.message));
      }
    }
  }

  function writeStorageConfig(config) {
    return new Promise(function (resolve, reject) {
      try {
        if (!chrome.storage || !chrome.storage.local) {
          reject(new Error("storage 不可用"));
          return;
        }
        chrome.storage.local.set({ config: config }, function () {
          var err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function resetDefaults() {
    clearAllInvalid();
    fillForm(DEFAULT_CONFIG);
    showStatus("已载入默认值，点击「保存设置」生效。", "ok");
  }

  // ===== 初始化 =====
  function init() {
    try {
      var saveBtn = $("btn-save");
      var resetBtn = $("btn-reset");
      if (saveBtn) saveBtn.addEventListener("click", saveConfig);
      if (resetBtn) resetBtn.addEventListener("click", resetDefaults);

      // Ctrl/Cmd + S 快捷保存
      document.addEventListener("keydown", function (ev) {
        if ((ev.ctrlKey || ev.metaKey) && (ev.key === "s" || ev.key === "S")) {
          ev.preventDefault();
          saveConfig();
        }
      });

      loadConfig();
    } catch (e) {
      log.error("options", "初始化失败: " + (e && e.message));
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
