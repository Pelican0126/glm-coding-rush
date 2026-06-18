/*
 * vuebridge.js — MAIN world 桥接脚本（运行在页面主世界，可访问 #app.__vue__）
 *
 * 背景：content_scripts 默认注入 ISOLATED world，读取不到页面 Vue 运行时挂在
 *       DOM 节点上的 __vue__ 属性。本脚本以 "world":"MAIN" 注入，在主世界里做
 *       Vue 内省，把 allCardDataList 的精简快照写到一个共享 DOM 节点上：
 *         - 节点 id = "glm-vue-bridge"，dataset.snapshot = JSON 字符串
 *         - 同时派发 CustomEvent("glm-vue-snapshot", {detail}) 供 isolated world 监听
 *
 * 安全/防御：全程 try/catch；只读取需要的字段，不修改页面状态；不触发任何点击。
 */
(function () {
  "use strict";

  var NODE_ID = "glm-vue-bridge";
  var EVT = "glm-vue-snapshot";

  // 在主世界从 #app.__vue__ 出发 BFS，找到 _data 含 allCardDataList 的组件实例。
  function findStore() {
    try {
      var app = document.querySelector("#app");
      if (!app || !app.__vue__) return null;
      var root = app.__vue__;
      var queue = [root];
      var seen = new Set();
      var guard = 0;
      while (queue.length && guard < 5000) {
        guard++;
        var vm = queue.shift();
        if (!vm || seen.has(vm)) continue;
        seen.add(vm);
        try {
          var data = vm._data || (vm.$ && vm.$data) || vm.$data;
          if (
            data &&
            Object.prototype.hasOwnProperty.call(data, "allCardDataList") &&
            Array.isArray(data.allCardDataList)
          ) {
            return data;
          }
        } catch (e) {}
        try {
          if (vm.$children && vm.$children.length) {
            for (var i = 0; i < vm.$children.length; i++) queue.push(vm.$children[i]);
          }
        } catch (e) {}
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // 精简化一条卡片：只保留判定/解析所需字段。
  function pickCard(e) {
    if (!e) return null;
    try {
      return {
        productId: e.productId != null ? e.productId : null,
        type: e.type != null ? e.type : null,
        unit: e.unit != null ? e.unit : null,
        payAmount: e.payAmount != null ? e.payAmount : null,
        salePrice: e.salePrice != null ? e.salePrice : null,
        activePrice: e.activePrice != null ? e.activePrice : null,
        productName: e.productName != null ? e.productName : null,
        soldOut: e.soldOut != null ? e.soldOut : null,
        canPurchase: e.canPurchase != null ? e.canPurchase : null,
        disabled: e.disabled != null ? e.disabled : null
      };
    } catch (err) {
      return null;
    }
  }

  function buildSnapshot() {
    try {
      var store = findStore();
      if (!store) return { ok: false, ts: Date.now() };
      var all = [];
      try {
        for (var i = 0; i < store.allCardDataList.length; i++) {
          var c = pickCard(store.allCardDataList[i]);
          if (c) all.push(c);
        }
      } catch (e) {}
      var arr = [];
      try {
        if (Array.isArray(store.cardDataArr)) {
          for (var j = 0; j < store.cardDataArr.length; j++) {
            var c2 = pickCard(store.cardDataArr[j]);
            if (c2) arr.push(c2);
          }
        }
      } catch (e) {}
      return { ok: true, ts: Date.now(), allCardDataList: all, cardDataArr: arr };
    } catch (e) {
      return { ok: false, ts: Date.now() };
    }
  }

  function ensureNode() {
    try {
      var n = document.getElementById(NODE_ID);
      if (!n) {
        n = document.createElement("div");
        n.id = NODE_ID;
        n.style.display = "none";
        (document.documentElement || document.body || document).appendChild(n);
      }
      return n;
    } catch (e) {
      return null;
    }
  }

  function publish() {
    try {
      var snap = buildSnapshot();
      var json = JSON.stringify(snap);
      var n = ensureNode();
      if (n) n.setAttribute("data-snapshot", json);
      try {
        document.dispatchEvent(new CustomEvent(EVT, { detail: json }));
      } catch (e) {}
    } catch (e) {}
  }

  // 周期性发布（页面数据会随周期切换/补货翻转变化）；并响应 isolated world 的主动请求。
  try {
    publish();
    setInterval(publish, 600);
    document.addEventListener("glm-vue-request", publish, false);
  } catch (e) {}
})();
