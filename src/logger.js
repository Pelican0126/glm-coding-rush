/*
 * logger.js — GLM 抢购助手 统一日志库
 * 挂载到 self.GLM.logger（IIFE，不使用 ES module）。
 *
 * 约定：
 *   - info/success/warn/error(tag,msg) 均构造 entry {t,level,tag,msg}，
 *     做对应的 console 输出，并调用 _sink(entry)（若已设置）。
 *   - background.js 会将 _sink 设为「写入 storage.logs 环形缓冲 + 广播 logPush」。
 *   - content.js 会将 _sink 设为「chrome.runtime.sendMessage({type:'log',entry})」。
 *   - fmt(entry) -> "HH:MM:SS.mmm [tag] msg"
 */
(function () {
  "use strict";
  var G = (self.GLM = self.GLM || {});

  // 两位/三位补零
  function pad(n, len) {
    var s = String(n);
    while (s.length < len) s = "0" + s;
    return s;
  }

  // 将时间戳格式化为 HH:MM:SS.mmm
  function fmt(entry) {
    try {
      var d = new Date(entry && entry.t ? entry.t : Date.now());
      var hh = pad(d.getHours(), 2);
      var mm = pad(d.getMinutes(), 2);
      var ss = pad(d.getSeconds(), 2);
      var ms = pad(d.getMilliseconds(), 3);
      var tag = entry && entry.tag ? entry.tag : "-";
      var msg = entry && entry.msg != null ? entry.msg : "";
      return hh + ":" + mm + ":" + ss + "." + ms + " [" + tag + "] " + msg;
    } catch (e) {
      return "[fmt-error] " + (entry && entry.msg ? entry.msg : "");
    }
  }

  // 核心：构造 entry、做 console 输出、调用 _sink
  function emit(level, tag, msg) {
    var entry = { t: Date.now(), level: level, tag: tag, msg: msg };
    try {
      var line = fmt(entry);
      if (level === "error") {
        console.error(line);
      } else if (level === "warn") {
        console.warn(line);
      } else {
        // info / success 都走 console.log
        console.log(line);
      }
    } catch (e) {}
    // 调用下游 sink（可能尚未设置）
    try {
      if (typeof G.logger._sink === "function") {
        G.logger._sink(entry);
      }
    } catch (e) {
      // sink 异常不应影响业务
    }
    return entry;
  }

  G.logger = {
    _sink: null, // 由 background/content 各自设置
    fmt: fmt,
    info: function (tag, msg) {
      return emit("info", tag, msg);
    },
    success: function (tag, msg) {
      return emit("success", tag, msg);
    },
    warn: function (tag, msg) {
      return emit("warn", tag, msg);
    },
    error: function (tag, msg) {
      return emit("error", tag, msg);
    }
  };
})();
