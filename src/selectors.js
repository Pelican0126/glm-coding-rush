/*
 * selectors.js — GLM 抢购助手 共享选择器/页面探测库
 * 挂载到全局命名空间 self.GLM.selectors（IIFE，不使用 ES module）。
 * 所有 Vue 内省与 DOM 查找均包裹 try/catch，保持防御性。
 */
(function () {
  "use strict";
  var G = (self.GLM = self.GLM || {});

  // ---- 常量：DOM 选择器 ----
  var BUY_BTN = "button.buy-btn";
  var CONFIRM_PAY = ".pay-dialog .confirm-pay-btn, .confirm-pay-btn";
  var PAY_DIALOG = ".pay-dialog";
  var CAPTCHA_APPID = "196026326";

  // ---- 文本正则数组：用于状态判断 ----
  var SOLD_OUT = [/暂时售罄/, /补货/]; // 售罄/补货
  var BUYABLE = [/特惠订阅/, /立即订阅/, /立即购买/]; // 可购买
  var BUSY = [/访问人数过多/, /访客过多/, /系统繁忙/, /排队/]; // 繁忙/限流

  // ---- MAIN world 桥接（vuebridge.js）快照 ----
  // content_scripts 默认在 isolated world，读不到页面的 #app.__vue__。
  // vuebridge.js 以 world:"MAIN" 注入，把 allCardDataList 精简快照写到
  // #glm-vue-bridge[data-snapshot] 并派发 "glm-vue-snapshot" 事件。这里消费它。
  var BRIDGE_NODE_ID = "glm-vue-bridge";
  var BRIDGE_EVT = "glm-vue-snapshot";
  var _bridgeSnapshot = null; // { ok, ts, allCardDataList, cardDataArr }

  function applySnapshotJson(json) {
    try {
      if (!json) return;
      var snap = typeof json === "string" ? JSON.parse(json) : json;
      if (snap && snap.ok && Array.isArray(snap.allCardDataList)) {
        _bridgeSnapshot = snap;
      }
    } catch (e) {}
  }

  // 监听桥接事件（实时刷新）
  try {
    document.addEventListener(
      BRIDGE_EVT,
      function (ev) {
        try {
          applySnapshotJson(ev && ev.detail);
        } catch (e) {}
      },
      false
    );
  } catch (e) {}

  // 读取当前桥接快照：优先内存事件缓存，否则即时读取 DOM 节点属性；
  // 并主动请求桥接刷新一次（异步，下一拍生效）。
  function readBridgeSnapshot() {
    try {
      var node = document.getElementById(BRIDGE_NODE_ID);
      if (node) {
        var attr = node.getAttribute("data-snapshot");
        if (attr) applySnapshotJson(attr);
      }
      // 主动请求一次刷新（主世界会重新发布）
      try {
        document.dispatchEvent(new CustomEvent("glm-vue-request"));
      } catch (e) {}
    } catch (e) {}
    return _bridgeSnapshot;
  }

  // 工具：安全获取元素文本
  function textOf(el) {
    try {
      if (!el) return "";
      return (el.innerText || el.textContent || "").trim();
    } catch (e) {
      return "";
    }
  }

  // 工具：任一正则命中文本
  function matchAny(text, regexArr) {
    if (!text) return false;
    for (var i = 0; i < regexArr.length; i++) {
      try {
        if (regexArr[i].test(text)) return true;
      } catch (e) {}
    }
    return false;
  }

  /*
   * getVueStore() —— 返回含 allCardDataList 的「数据快照」。
   * 主路径：消费 MAIN world 桥接（vuebridge.js）发布的快照（isolated world 读不到 __vue__）。
   * 兜底路径：万一本脚本运行在 MAIN world（__vue__ 可达），则直接 BFS #app.__vue__。
   * 找不到返回 null。完全防御。
   */
  function getVueStore() {
    // 1) 优先桥接快照（isolated world 的唯一可行路径）
    try {
      var snap = readBridgeSnapshot();
      if (snap && snap.ok && Array.isArray(snap.allCardDataList) && snap.allCardDataList.length) {
        return { allCardDataList: snap.allCardDataList, cardDataArr: snap.cardDataArr || [] };
      }
    } catch (e) {}

    // 2) 兜底：直接读取 __vue__（仅在 MAIN world 可用）
    try {
      var app = document.querySelector("#app");
      if (!app || !app.__vue__) return null;
      var root = app.__vue__;
      var queue = [root];
      var seen = new Set();
      var guard = 0; // 防止异常环导致死循环
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
        // 入队子组件
        try {
          if (vm.$children && vm.$children.length) {
            for (var i = 0; i < vm.$children.length; i++) {
              queue.push(vm.$children[i]);
            }
          }
        } catch (e) {}
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /*
   * resolveProduct(tier, unit) —— 在 allCardDataList 中按 type+unit 匹配，
   * 返回该条目（含动态 productId / payAmount / soldOut 等），找不到返回 null。
   */
  function resolveProduct(tier, unit) {
    try {
      var store = getVueStore();
      if (!store || !Array.isArray(store.allCardDataList)) return null;
      var list = store.allCardDataList;
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!e) continue;
        if (e.type === tier && e.unit === unit) return e;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /*
   * findBuyBtnForCard(entry) —— 为指定卡片条目定位它的 .buy-btn。
   * 策略：优先匹配包含 productName / payAmount 文本的卡片容器内的按钮；
   * 退化策略：按 allCardDataList 中的索引对应页面按钮顺序取第 N 个。
   */
  function findBuyBtnForCard(entry) {
    try {
      if (!entry) return null;
      var btns = Array.prototype.slice.call(
        document.querySelectorAll(BUY_BTN)
      );
      if (!btns.length) return null;

      // 0) 最稳：校正视图后（个人套餐 + 目标周期），页面固定展示 3 张卡，
      //    顺序为 Lite / Pro / Max，可见的 3 个 .buy-btn 与之一一对应。
      //    直接按 tier 位置映射 —— 与桥接快照新鲜度无关，最可靠，避免买错档位。
      var TIER_INDEX = { lite: 0, pro: 1, max: 2 };
      if (btns.length === 3 && entry.type && TIER_INDEX[entry.type] != null) {
        return btns[TIER_INDEX[entry.type]];
      }

      // 1) 通过卡片容器文本（productName / 金额）匹配
      var name = entry.productName ? String(entry.productName) : "";
      var amt = entry.payAmount != null ? String(entry.payAmount) : "";
      for (var i = 0; i < btns.length; i++) {
        var card = findCardContainer(btns[i]);
        var ctext = textOf(card);
        if (name && ctext.indexOf(name) !== -1) return btns[i];
        if (amt && ctext.indexOf("¥" + amt) !== -1) return btns[i];
        if (amt && ctext.indexOf(amt) !== -1 && name && ctext.indexOf(entry.type || "") !== -1) {
          return btns[i];
        }
      }

      // 2) 退化：按索引匹配（allCardDataList 与可见卡片顺序大致一致时）
      var store = getVueStore();
      if (store && Array.isArray(store.cardDataArr)) {
        // cardDataArr 是当前展示周期的卡片，尝试在其中定位 entry
        var arr = store.cardDataArr;
        for (var j = 0; j < arr.length; j++) {
          if (
            arr[j] &&
            arr[j].type === entry.type &&
            arr[j].unit === entry.unit
          ) {
            if (btns[j]) return btns[j];
          }
        }
      }

      // 3) 最后兜底：若仅有一个按钮则返回它
      if (btns.length === 1) return btns[0];
      return null;
    } catch (e) {
      return null;
    }
  }

  // 向上寻找最近的卡片容器（含价格/名称的盒子）
  function findCardContainer(btn) {
    try {
      var el = btn;
      var hops = 0;
      while (el && el.parentElement && hops < 8) {
        el = el.parentElement;
        hops++;
        var cls = (el.className || "") + "";
        if (/card|plan|tier|product|sku/i.test(cls)) return el;
      }
      // 退化：返回按钮的祖父节点
      return btn.parentElement ? btn.parentElement.parentElement || btn.parentElement : btn;
    } catch (e) {
      return btn;
    }
  }

  /*
   * isBuyable(entry, btn) —— 综合数据层与 DOM 判断是否可购买。
   * 条件（任一为真即视为可购买，取最先翻转者）：
   *   - entry.soldOut === false
   *   - entry.canPurchase 为真
   *   - entry.disabled === false
   *   - .buy-btn 文本命中 BUYABLE 且未 disabled
   */
  function isBuyable(entry, btn) {
    try {
      var dataBuyable = false;
      if (entry) {
        if (entry.soldOut === false) dataBuyable = true;
        if (entry.canPurchase) dataBuyable = true;
        if (entry.disabled === false) dataBuyable = true;
      }
      var domBuyable = false;
      if (btn) {
        var disabled =
          btn.disabled === true ||
          btn.getAttribute("disabled") != null ||
          /is-disabled/.test((btn.className || "") + "");
        var t = textOf(btn);
        if (!disabled && matchAny(t, BUYABLE)) domBuyable = true;
      }
      return dataBuyable || domBuyable;
    } catch (e) {
      return false;
    }
  }

  /*
   * isSoldOut(btn) —— 按钮处于售罄/补货状态（文本命中 SOLD_OUT 或 disabled）。
   */
  function isSoldOut(btn) {
    try {
      if (!btn) return false;
      var t = textOf(btn);
      if (matchAny(t, SOLD_OUT)) return true;
      var disabled =
        btn.disabled === true ||
        btn.getAttribute("disabled") != null ||
        /is-disabled/.test((btn.className || "") + "");
      // 既 disabled 又不在可购买文案上，视为售罄
      if (disabled && !matchAny(t, BUYABLE)) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  /*
   * isBusyPage() —— 页面是否出现繁忙/限流提示（文本扫描）。
   */
  function isBusyPage() {
    try {
      var body = document.body;
      if (!body) return false;
      var t = textOf(body);
      return matchAny(t, BUSY);
    } catch (e) {
      return false;
    }
  }

  /*
   * captchaOpen() —— 检测腾讯验证码 iframe / 容器是否打开。
   */
  function captchaOpen() {
    try {
      var sel =
        'iframe[src*="captcha"], .tcaptcha-transform, #tcaptcha_iframe, [id*="tcaptcha"], iframe[id*="tcaptcha"], [class*="tcaptcha"]';
      var nodes = document.querySelectorAll(sel);
      for (var i = 0; i < nodes.length; i++) {
        if (isVisible(nodes[i])) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  /*
   * payDialogOpen() —— 支付弹窗（.pay-dialog / PayModel）是否打开且可见。
   */
  function payDialogOpen() {
    try {
      var nodes = document.querySelectorAll(PAY_DIALOG);
      for (var i = 0; i < nodes.length; i++) {
        if (isVisible(nodes[i])) return true;
      }
      // 兜底：存在确认支付按钮且可见
      var cp = document.querySelector(CONFIRM_PAY);
      if (cp && isVisible(cp)) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  // 元素是否「真正可见」。
  // 注意（实测踩坑）：腾讯天御验证码会在页面里常驻一个闲置容器
  //   #tcaptcha_transform_dy —— display:block / visibility:visible / 有尺寸，
  //   但被移到屏外（top:-1e6px）且 opacity:0。仅看 display/visibility/尺寸会误判为可见，
  //   导致 captchaOpen() 在没有验证码时也返回 true，进而让抢购循环误冻结。
  //   因此这里额外排除：opacity:0、离屏（视口外）。激活的真验证码会居中显示、opacity:1，
  //   仍会被正确判为可见。
  function isVisible(el) {
    try {
      if (!el) return false;
      var style = window.getComputedStyle(el);
      if (style) {
        if (style.display === "none" || style.visibility === "hidden") return false;
        var op = parseFloat(style.opacity);
        if (!isNaN(op) && op === 0) return false; // 完全透明
      }
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      // 离屏检测：被移出视口（如 tcaptcha 闲置容器 top:-1e6px）视为不可见
      var vw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
      var vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
      if (rect.right <= 0 || rect.bottom <= 0) return false;
      if (vw && rect.left >= vw) return false;
      if (vh && rect.top >= vh) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  G.selectors = {
    // 常量
    BUY_BTN: BUY_BTN,
    CONFIRM_PAY: CONFIRM_PAY,
    PAY_DIALOG: PAY_DIALOG,
    CAPTCHA_APPID: CAPTCHA_APPID,
    // 文本数组
    SOLD_OUT: SOLD_OUT,
    BUYABLE: BUYABLE,
    BUSY: BUSY,
    // 方法
    getVueStore: getVueStore,
    resolveProduct: resolveProduct,
    findBuyBtnForCard: findBuyBtnForCard,
    isBuyable: isBuyable,
    isSoldOut: isSoldOut,
    isBusyPage: isBusyPage,
    captchaOpen: captchaOpen,
    payDialogOpen: payDialogOpen,
    // 辅助（导出便于复用/测试）
    _textOf: textOf,
    _matchAny: matchAny,
    _isVisible: isVisible,
    _findCardContainer: findCardContainer,
    _readBridgeSnapshot: readBridgeSnapshot
  };
})();
