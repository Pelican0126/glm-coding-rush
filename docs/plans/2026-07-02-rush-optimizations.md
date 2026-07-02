# 抢购节奏优化(v0.2.x)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 T0 首次「新鲜库存判定」从 ~T+1.2s 提前到 ~T+0.15s(命中提前翻牌)~T+0.9s(准点翻牌),同时把开抢后一小时的重载总量从 ~880 次降到 ~365 次,并清掉已失效的「猛刷时长」配置项。

**Architecture:** 新增 `src/pacing.js` 纯函数模块(无 chrome/DOM 依赖,挂 `self.GLM.pacing`),集中所有「何时刷新/延迟多少/要不要预刷」的**决策**;`content.js` 只负责**执行**。决策层用 Node 内置 `node:test` 单测穷举边界;执行层(DOM/chrome)用「日志化 dry-run + 检查表」人工验收——这是本仓一贯的验证文化(弹窗实时日志)。

**Tech Stack:** Chrome MV3 classic scripts(IIFE + `self.GLM` 命名空间,**无 ES module**)、Node ≥18 内置 `node:test`(本机 v24.13.1,无需 package.json)。

## Global Constraints(每个任务默认继承)

- **单账号本人购买**;**绝不破解/绕过验证码**;**到支付页即停,绝不自动付款**。
- **礼貌限速**:重载执行的最小地板 `RELOAD_FLOOR_MS = 250ms`;常规执行延迟带 ±30% 抖动(`jitter()`);重载节奏由「周期闸」(`since > Math.max(RELOAD_FLOOR_MS, cycle)`)控制。
- **开抢前(fireAt 之前)绝不刷新页面**——`ME.buyPhase` 闸是 2026-06-29 漏抢事故的修复,任何新逻辑不得绕过(唯一例外:本计划 Task 4 的「T-2.5s 一次性预刷新」,它有独立幂等闸,见任务内说明)。
- **create-sign 之后绝不自动重抢**(防本账号重复占单):新代码若触发重载,必须确认所在分支处于「点确认支付之前」。
- **所有排队重载必须走 `ME.reloadTimer` + `ME._reloadPending`**,保证撤防/stop 时可被 `cleanupTimers()` 拦掉(2026-06-25「撤防无效」事故的约定)。
- classic script:新文件必须是 IIFE、挂 `self.GLM`,不用 `import/export`;`content.js` 引用方式为 `var P = G.pacing || {}`(与 27-32 行的 S/L/T 同款防御式)。
- 公开仓库:不得引入任何密钥/个人信息;提交信息用中文、结尾带 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 每个任务收尾必须通过:改动文件的 `node --check` + `node --test tests/`(Task 1 起)。

## 非目标(YAGNI,明确不做)

- 不做直连库存接口轮询(触碰礼貌限速边界,且会加深软限流)。
- 不动双标签/接管(已封禁,见 background.js `wantBackup=false` 注释)。
- 不做毫秒级对时(站点无 ms 时间源,已验证)。

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/pacing.js` | 新建 | 节奏决策纯函数:`reloadCycleMs` / `reloadDelayMs` / `shouldPreReload` |
| `tests/pacing.test.js` | 新建 | 上述三函数的边界单测(node:test) |
| `manifest.json` | 修改 | content_scripts 注册 `src/pacing.js`(在 content.js 之前) |
| `src/content.js` | 修改 | `onSoldOut` 接入渐进长尾与黄金窗口零延迟;`spinUntilFire` 接入预刷新 |
| `src/options.html` / `src/options.js` / `src/background.js` | 修改 | 移除已失效的 burstWindow 配置(死配置清理) |

---

## 测试与 Review 方法论(本计划的"怎么测、怎么审")

### 怎么写测试用例

1. **决策与执行分离**:凡是"算一个数/判一个真假"的逻辑进 `pacing.js` 纯函数——可在 Node 里直接测;凡是碰 DOM/chrome.* 的执行代码不写单测,用第 3 条的日志验收。
2. **边界表格化**:每个函数先列「输入区间 → 期望输出」表,对每个边界**测两侧**(如 60s 档位就测 `59_999` 和 `60_001`)。
3. **随机性注入**:`jitter` 这类随机函数通过参数传入,测试里用返回定值的 stub(`function(x){return 999;}`),断言"传没传对",保持测试确定性。
4. **防御输入必测**:`elapsed` 为负数(逻辑上不该发生,但 buyPhase 闸失效时会)、`cfg` 为 `undefined`、配置被用户改成非默认值(如 `slow=20000`)。
5. **回归用例带"病史"命名**:用例名写明它防的是哪次事故(如 `开抢前(elapsed<0)不得给出慢档`),将来读失败输出即知砸了什么。
6. **断言语义不断言实现**:只断返回值,不断内部调用次数/顺序——允许将来重构。

### 怎么 review(每任务自审 + 终审)

**每任务自审 gate(写在各任务最后一步)**:改动文件 `node --check`、`node --test tests/` 全绿、diff 逐行读一遍确认没夹带无关改动。

**终审(Task 6)用"本仓病灶透镜"逐条过 diff**——每条都是这个仓真实踩过的坑:

| # | 透镜 | 对应历史事故 |
|---|---|---|
| 1 | 新逻辑在 **fireAt 之前还是之后**?之前的路径有没有可能触发刷新? | 2026-06-29 开抢前刷新风暴→自我软限流→漏抢 |
| 2 | 新逻辑在 **create-sign 之前还是之后**?之后的路径有没有自动重抢? | 20s 超时误重抢→本账号重复占单风险 |
| 3 | 新增的 `setTimeout` 重载是否登记进 `reloadTimer`/`_reloadPending`、被 `cleanupTimers` 覆盖? | 2026-06-25 撤防无效/幽灵刷新 |
| 4 | 重载前是否 `saveRunFlag(正确 phase)`?`lastReloadAt` 是否维持"跨重载还原"语义? | 重载后 since 恒天文数字→死循环刷新 |
| 5 | 隐藏标签下行为:有没有依赖 rAF/未钳制 timer 的精确计时? | 后台标签倒计时冻结→漏抢 |
| 6 | **请求量算账**:改动前后"每小时重载次数"给出具体数字对比 | 软限流主因 |
| 7 | `node --check` 全部 src/*.js + `node --test tests/` + 敏感信息 grep | 公开仓库 |

**终审执行方式**:跑 `/code-review`(高档)审当前 diff,或派一个没写过这些代码的 fresh subagent 拿上表逐条核;报告里每条透镜要么"过",要么给出行号级反例。

### 怎么人工验收(日志化 dry-run,不碰真下单)

设置页把「重试时长」调成 180 秒 + 打开 Dry-run → `chrome://extensions` 重载扩展 → 弹窗点「手动开抢」→ 对照各任务给出的**期望日志序列**逐行核对(弹窗实时日志/导出)。全程 dryRun 不点购买、不产生订单。

---

### Task 1: `pacing.js` 纯函数模块 + 单测基建(TDD)

**Files:**
- Create: `tests/pacing.test.js`
- Create: `src/pacing.js`
- Modify: `manifest.json`(content_scripts 第二组 js 数组)

**Interfaces:**
- Consumes: 无(纯函数,零依赖)
- Produces(后续任务依赖的精确签名):
  - `GLM.pacing.reloadCycleMs(elapsedSinceFireMs: number, cfg: {reloadIntervalMs?: number, slowReloadIntervalMs?: number} | null) → number`(毫秒)
  - `GLM.pacing.reloadDelayMs(elapsedSinceFireMs: number, floorMs: number, jitterFn: (n:number)=>number, goldenMs?: number) → number`
  - `GLM.pacing.shouldPreReload(remainMs: number, pageAgeMs: number, opts?: {windowMs?: number, minPageAgeMs?: number}) → boolean`

- [ ] **Step 1: 写失败测试**

创建 `tests/pacing.test.js`:

```js
/* pacing.js 纯函数单测 — node --test tests/ 运行(Node ≥18,本机 v24) */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// classic script 以 self.GLM 挂载;Node 里没有 self,用 global 顶上
global.self = global;
require("../src/pacing.js");
const P = global.GLM.pacing;

// ---------- reloadCycleMs:渐进长尾 ----------
// 档位表:0-60s→fast(1200) | 60s-5min→max(fast,slow)(4000) | 5-15min→≥8000 | >15min→≥15000
test("reloadCycleMs: 60s 内用快档(默认1200)", () => {
  assert.equal(P.reloadCycleMs(0, null), 1200);
  assert.equal(P.reloadCycleMs(59_999, null), 1200);
});
test("reloadCycleMs: 60s-5min 用慢档(默认4000)", () => {
  assert.equal(P.reloadCycleMs(60_001, null), 4000);
  assert.equal(P.reloadCycleMs(300_000, null), 4000);
});
test("reloadCycleMs: 5-15min 抬到 8000", () => {
  assert.equal(P.reloadCycleMs(300_001, null), 8000);
  assert.equal(P.reloadCycleMs(900_000, null), 8000);
});
test("reloadCycleMs: >15min 长尾 15000", () => {
  assert.equal(P.reloadCycleMs(900_001, null), 15000);
  assert.equal(P.reloadCycleMs(3_600_000, null), 15000);
});
test("reloadCycleMs: 自定义 slow=6000 在各档生效且档位单调不减", () => {
  const cfg = { slowReloadIntervalMs: 6000 };
  assert.equal(P.reloadCycleMs(60_001, cfg), 6000);
  assert.equal(P.reloadCycleMs(300_001, cfg), 8000);
  assert.equal(P.reloadCycleMs(900_001, cfg), 15000);
});
test("reloadCycleMs: 极端配置(slow=20000)不会被档位表反向压低", () => {
  const cfg = { slowReloadIntervalMs: 20000 };
  assert.equal(P.reloadCycleMs(60_001, cfg), 20000);
  assert.equal(P.reloadCycleMs(300_001, cfg), 20000);
  assert.equal(P.reloadCycleMs(900_001, cfg), 20000);
});
test("reloadCycleMs: fast>后档时保持单调(fast=10000 不出现 8000 倒挂)", () => {
  const cfg = { reloadIntervalMs: 10000 };
  assert.equal(P.reloadCycleMs(0, cfg), 10000);
  assert.equal(P.reloadCycleMs(300_001, cfg), 10000);
});
test("reloadCycleMs: 开抢前(elapsed<0)不得给出慢档——buyPhase 闸失效时的兜底(病史:开抢前刷新风暴)", () => {
  assert.equal(P.reloadCycleMs(-5000, null), 1200);
});

// ---------- reloadDelayMs:开抢后黄金窗口零延迟 ----------
const stubJitter = (n) => 999; // 返回定值,断言"走了 jitter 分支"
test("reloadDelayMs: 开抢后 5s 内 0ms 立即执行", () => {
  assert.equal(P.reloadDelayMs(0, 250, stubJitter), 0);
  assert.equal(P.reloadDelayMs(4_999, 250, stubJitter), 0);
});
test("reloadDelayMs: 5s 后回到 jitter(floor)", () => {
  assert.equal(P.reloadDelayMs(5_000, 250, stubJitter), 999);
  assert.equal(P.reloadDelayMs(60_000, 250, stubJitter), 999);
});
test("reloadDelayMs: elapsed<0(开抢前,防御)不给零延迟", () => {
  assert.equal(P.reloadDelayMs(-1, 250, stubJitter), 999);
});
test("reloadDelayMs: 自定义黄金窗口 goldenMs 生效", () => {
  assert.equal(P.reloadDelayMs(7_000, 250, stubJitter, 8_000), 0);
  assert.equal(P.reloadDelayMs(8_000, 250, stubJitter, 8_000), 999);
});

// ---------- shouldPreReload:T-2.5s 一次性预刷新 ----------
test("shouldPreReload: 窗口内且页面已旧 → 预刷", () => {
  assert.equal(P.shouldPreReload(2_400, 90_000), true);
  assert.equal(P.shouldPreReload(2_500, 10_000), true); // 双边界:remain=窗口上沿,pageAge=下沿
});
test("shouldPreReload: 窗口外(remain>2500)不预刷", () => {
  assert.equal(P.shouldPreReload(2_501, 90_000), false);
});
test("shouldPreReload: 页面还新(pageAge<10s)不预刷——幂等闸,防预刷后无限连环预刷", () => {
  assert.equal(P.shouldPreReload(2_400, 9_999), false);
  assert.equal(P.shouldPreReload(2_400, 800), false); // 预刷后的新页典型值
});
test("shouldPreReload: 已到点/过点(remain<=0)不预刷", () => {
  assert.equal(P.shouldPreReload(0, 90_000), false);
  assert.equal(P.shouldPreReload(-100, 90_000), false);
});
test("shouldPreReload: 自定义窗口/最小页龄生效", () => {
  assert.equal(P.shouldPreReload(4_000, 90_000, { windowMs: 5_000 }), true);
  assert.equal(P.shouldPreReload(2_400, 20_000, { minPageAgeMs: 30_000 }), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd "D:/code/23-Z.ai抢购" && node --test tests/
```
预期:**FAIL**,报 `Cannot find module '../src/pacing.js'`。

- [ ] **Step 3: 写最小实现**

创建 `src/pacing.js`:

```js
/*
 * pacing.js — GLM 抢购助手 节奏决策纯函数
 * 挂载到 self.GLM.pacing(IIFE,classic script,无 ES module)。
 * 零依赖(不碰 chrome.*/DOM),因此可用 node --test 直接单测(tests/pacing.test.js)。
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
```

- [ ] **Step 4: 跑测试确认全绿**

```bash
cd "D:/code/23-Z.ai抢购" && node --check src/pacing.js && node --test tests/
```
预期:`# pass 17`、`# fail 0`。

- [ ] **Step 5: manifest 注册(content.js 之前)**

`manifest.json` 的第二个 content_scripts 条目(`"run_at": "document_idle"` 那组)js 数组改为:

```json
      "js": ["src/selectors.js", "src/logger.js", "src/timesync.js", "src/pacing.js", "src/content.js"]
```

校验:
```bash
cd "D:/code/23-Z.ai抢购" && node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest OK')"
```
预期:`manifest OK`。

- [ ] **Step 6: 提交**

```bash
cd "D:/code/23-Z.ai抢购" && git add src/pacing.js tests/pacing.test.js manifest.json && git commit -m "feat: pacing 纯函数模块(节奏决策)+node:test 单测基建

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `onSoldOut` 接入渐进长尾(reloadCycleMs)

**Files:**
- Modify: `src/content.js` — ① 顶部命名空间引用处(约 27-32 行,`var T = G.timesync` 附近);② `onSoldOut` 内周期计算块(grep `var burst = 60000` 定位)

**Interfaces:**
- Consumes: `GLM.pacing.reloadCycleMs(elapsedSinceFireMs, cfg) → number`(Task 1)
- Produces: `onSoldOut` 作用域内变量 `elapsedSinceFire: number`(Task 3 复用,勿改名)

- [ ] **Step 1: 顶部引用 pacing(防御式,与 S/L/T 同款)**

在 `content.js` 的 `var T = G.timesync || { ... }` 声明之后加:

```js
  var P = G.pacing || {
    // pacing.js 未加载时的保守兜底(不应发生;manifest 顺序保证先加载)
    reloadCycleMs: function (e, c) { return (c && c.reloadIntervalMs) || 1200; },
    reloadDelayMs: function (e, f, j) { return j(f); },
    shouldPreReload: function () { return false; }
  };
```

- [ ] **Step 2: 替换周期计算**

`onSoldOut` 内,把这一段(grep `var burst = 60000` 定位,连同其上方「爆发窗口写死 60s」的整块注释与 `var cycle/var slow/if (ME.fireAt...)` 三行):

```js
      var cycle = (ME.config && ME.config.reloadIntervalMs) || 1200; // 刷新周期，默认 ~1.2s
      // (「爆发窗口写死 60s、刻意不读 config.burstWindowMs」的多行注释)
      var burst = 60000;
      var slow = (ME.config && ME.config.slowReloadIntervalMs) || 4000;
      if (ME.fireAt && (nowSrv() - ME.fireAt) > burst) cycle = Math.max(cycle, slow);
```

整体替换为:

```js
      // 渐进长尾(决策在 GLM.pacing.reloadCycleMs,纯函数可单测):
      // 0-60s 猛刷(1.2s) → 60s-5min 4s → 5-15min 8s → >15min 15s。
      // 60s 爆发窗口维持写死、档位理由与请求量算账见 pacing.js 注释。
      var elapsedSinceFire = ME.fireAt ? (nowSrv() - ME.fireAt) : 0;
      var cycle = P.reloadCycleMs(elapsedSinceFire, ME.config);
```

注意:此块下方的无卡片分支/售罄重载分支继续使用 `cycle`,无需改动;确认删除后全文再无 `var burst`、无对 `slow` 的悬空引用(`grep -n "var slow\|burst" src/content.js` 应只剩注释)。

- [ ] **Step 3: 校验**

```bash
cd "D:/code/23-Z.ai抢购" && node --check src/content.js && node --test tests/
```
预期:两者全过。

- [ ] **Step 4: 人工验收(日志化 dry-run)**

设置页:重试时长 1200 秒、开 Dry-run → 重载扩展 → 手动开抢,观察弹窗日志:
- 开抢后 60s 内:`售罄 → 刷新页面再抢（周期≈1200ms）`
- 60s 后:同行日志变为 `周期≈4000ms`
- (可选,等 5 分钟)变为 `周期≈8000ms`
核完点「停止」。

- [ ] **Step 5: 提交**

```bash
cd "D:/code/23-Z.ai抢购" && git add src/content.js && git commit -m "perf: 售罄重载渐进长尾(60s/5min/15min 档),1小时重载 ~880→~365 次

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: 开抢后黄金窗口首刷零延迟(reloadDelayMs)

**Files:**
- Modify: `src/content.js` — 仅「有卡片(售罄)→ 刷新」这一处重载排程(grep `maybeFallbackSwitch` 定位其所在块)

**Interfaces:**
- Consumes: `GLM.pacing.reloadDelayMs(elapsed, floor, jitterFn) → number`(Task 1);`elapsedSinceFire`(Task 2)
- Produces: 无

- [ ] **Step 1: 改排程延迟**

「有卡片(售罄)」分支的重载排程,把:

```js
        ME.reloadTimer = setTimeout(function () {
          ME.reloadTimer = null;
          ME._reloadPending = false;
          try { location.replace(target); } catch (e) { try { location.reload(); } catch (e2) {} }
        }, jitter(RELOAD_FLOOR_MS));
```

改为:

```js
        ME.reloadTimer = setTimeout(function () {
          ME.reloadTimer = null;
          ME._reloadPending = false;
          try { location.replace(target); } catch (e) { try { location.reload(); } catch (e2) {} }
        // 开抢后头 5s 黄金窗口:0ms 立即执行(重载节奏已由上方周期闸保证 ≥ 地板/周期,
        // 不违反礼貌限速);窗口外回到 jitter(250ms) 抖动。省下的 ~175-325ms 全在关键路径上。
        }, P.reloadDelayMs(elapsedSinceFire, RELOAD_FLOOR_MS, jitter));
```

**只改这一处**。无卡片分支、限流恢复、视图卡死、retryAfterFail 的重载保持 `jitter(RELOAD_FLOOR_MS)` 不变(它们不在黄金路径,保留抖动更礼貌)。

- [ ] **Step 2: 校验**

```bash
cd "D:/code/23-Z.ai抢购" && node --check src/content.js && node --test tests/
```
预期:全过。

- [ ] **Step 3: 人工验收**

Dry-run 手动开抢:开抢后第一条 `售罄 → 刷新页面再抢` 到下一条 `内容脚本就绪` 的时间差应比之前缩短 ~0.2-0.3s(对照日志时间戳;之前 ≈ 周期 1.2s + 抖动 0.25s + 页面加载,现在无抖动项)。

- [ ] **Step 4: 提交**

```bash
cd "D:/code/23-Z.ai抢购" && git add src/content.js && git commit -m "perf: 开抢后5s黄金窗口售罄重载零延迟执行(省 ~0.3s 关键路径)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: T-2.5s 一次性预刷新(shouldPreReload)

**Files:**
- Modify: `src/content.js` — `spinUntilFire` 的 `tick` 函数(grep `T-15s 预热中` 定位,插在该块之后、调度分支之前)

**Interfaces:**
- Consumes: `GLM.pacing.shouldPreReload(remainMs, pageAgeMs) → boolean`(Task 1);既有 `SCRIPT_START`、`reloadFreshUrl()`、`saveRunFlag()`、`ME.reloadTimer`/`ME._reloadPending` 约定
- Produces: 无

**为什么安全(review 透镜预答)**:①它在 fireAt **之前**、create-sign 之前;②走 `reloadTimer`/`_reloadPending`,撤防可拦;③幂等——预刷后新页 `SCRIPT_START` 归零 → `pageAge < 10s` → `shouldPreReload=false`,绝无连环预刷;④重载后经 `saveRunFlag("countdown")` → init resume → 重新进入倒计时(该机制已被 coupon-ic 注入路径长期验证);⑤每天固定 **+1 次**页面加载,不增长尾请求。

- [ ] **Step 1: 在 tick 里插入预刷新**

`spinUntilFire` 的 `tick` 内,「T-15s 预热中…」块之后、`// 距离较远时降频…` 调度分支之前,插入:

```js
        // T-2.5s 一次性预刷新(决策在 GLM.pacing.shouldPreReload,含幂等闸):
        // 让 T0 第一拍看到 ~2s 新的数据,而非 T-90s 预热时的旧数据;若站点提前几秒
        // 翻牌(运营手动放量常见),T0 一到立即命中,省掉整整一轮重载(~1.2s)。
        // 仅 hybrid/reload 策略需要;dryRun 下同样执行(只是导航,无副作用)。
        var strat = (ME.config && ME.config.triggerStrategy) || "hybrid";
        if ((strat === "hybrid" || strat === "reload") &&
            P.shouldPreReload(remain, Date.now() - SCRIPT_START)) {
          log("info", "spin", "T-" + (Math.round(remain / 100) / 10) + "s 预刷新:拉最新卡片数据后继续倒计时");
          saveRunFlag("countdown"); // 重载后 init→resume(countdown)→重新进入精确等待
          ME.lastReloadAt = Date.now();
          var pr = reloadFreshUrl();
          ME._reloadPending = true;
          if (ME.reloadTimer) { clearTimeout(ME.reloadTimer); }
          ME.reloadTimer = setTimeout(function () {
            ME.reloadTimer = null;
            ME._reloadPending = false;
            try { location.replace(pr); } catch (e) { try { location.reload(); } catch (e2) {} }
          }, 0);
          return; // 本页即将卸载,终止本 tick 链;新页 resume 后重启倒计时
        }
```

- [ ] **Step 2: 校验**

```bash
cd "D:/code/23-Z.ai抢购" && node --check src/content.js && node --test tests/
```
预期:全过。

- [ ] **Step 3: 人工验收(两种情形都要核)**

Dry-run 下:
1. **页面已开 >10s** 再手动开抢(manualFire 的 fireAt≈now+1.2s,remain≈1.05s<2.5s):期望日志序列
   `[spin] 进入精确等待` → `[spin] T-1.0s 预刷新:…` → `[content] 内容脚本就绪` → `[resume] 检测到中断的抢购进度(phase=countdown)` → `[spin] 进入精确等待` → `[spin] 到点`。
2. **紧接着立刻再次手动开抢**(页面刚加载,pageAge<10s):期望**没有**预刷新日志,直接 `到点`——验证幂等闸。
3. 在预刷新日志出现后 1 秒内点「停止」:期望 `收到 stop:拦截已排队但未执行的刷新` 或已重载但**不再恢复循环**(runFlag 已清)——验证撤防可拦。

- [ ] **Step 4: 提交**

```bash
cd "D:/code/23-Z.ai抢购" && git add src/content.js && git commit -m "perf: T-2.5s 一次性预刷新,T0 即见新鲜库存(命中提前翻牌则省一整轮重载)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 死配置清理(burstWindow)

**Files:**
- Modify: `src/options.html` — `data-field="burstWindow"` 整块
- Modify: `src/options.js` — `DEFAULT_CONFIG.burstWindowMs`、fillForm 回填行、collectAndValidate 校验段(均 grep `burstWindow` 定位,共 3 处)
- Modify: `src/background.js` — `defaultConfig()` 里的 `burstWindowMs: 60000,` 行

**Interfaces:**
- Consumes: 无
- Produces: 无(纯清理;Task 2 之后代码已不读 `config.burstWindowMs`,存量用户 storage 里的旧键成为无害死数据,不迁移)

- [ ] **Step 1: options.html 字段改为固定说明**

把 `data-field="burstWindow"` 的整个 `<div class="field">…</div>` 块替换为:

```html
        <div class="field" data-field="burstWindow">
          <label class="k" for="f-burstWindowSec">猛刷时长 burstWindow</label>
          <div class="v">
            <div class="with-unit">
              <input type="number" id="f-burstWindowSec" class="tiny" value="60" disabled />
              <span class="unit">秒</span>
            </div>
            <div class="hint">已固定 60 秒(防开抢后过度重拉把自己刷进软限流,2026-06-29 实测教训),不可配置。之后节奏:5 分钟内按「慢速刷新间隔」,5-15 分钟 8 秒,更久 15 秒。</div>
          </div>
        </div>
```

- [ ] **Step 2: options.js 三处清理**

grep `burstWindow` 定位并删除:
1. `DEFAULT_CONFIG` 里的 `burstWindowMs: 60000,`(Task 前值可能是 60000)整行;
2. fillForm 中回填块(形如 `if ($("f-burstWindowSec")) $("f-burstWindowSec").value = Math.round((c.burstWindowMs != null ? c.burstWindowMs : DEFAULT_CONFIG.burstWindowMs) / 1000);`)整块;
3. collectAndValidate 中校验/写入块(以 `cfg.burstWindowMs = DEFAULT_CONFIG.burstWindowMs;` 与 `cfg.burstWindowMs = bw * 1000;` 结尾的整段,含其 `var bwRaw…` 起始行)。

删除后 `grep -n "burstWindow" src/options.js` 应无结果。

- [ ] **Step 3: background.js 默认值删除**

删除 `defaultConfig()` 中整行:
```js
      burstWindowMs: 60000,
```
删除后 `grep -n "burstWindow" src/background.js` 应无结果。

- [ ] **Step 4: 校验**

```bash
cd "D:/code/23-Z.ai抢购" && node --check src/options.js && node --check src/background.js && node --test tests/ && grep -rn "burstWindow" src/ | grep -v "options.html" || echo "clean"
```
预期:check 全过、测试全绿、最后输出 `clean`(仅 options.html 剩展示用字段)。

- [ ] **Step 5: 人工验收**

重载扩展 → 打开设置页:「猛刷时长」显示 60 且置灰不可改 → 随便改一项(如提前量)点保存 → 显示「已保存」无报错;再 `chrome.storage.local.get('config')`(设置页 DevTools Console)确认保存后的 config **不再新增** `burstWindowMs` 键(旧值残留无妨)。

- [ ] **Step 6: 提交**

```bash
cd "D:/code/23-Z.ai抢购" && git add src/options.html src/options.js src/background.js && git commit -m "chore: 移除已失效的 burstWindow 配置项(代码已固定 60s),设置页改为只读说明

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: 终审 + 敏感审计 + 推送

**Files:**
- 无新改动(只审、只推)

**Interfaces:**
- Consumes: Tasks 1-5 的全部提交
- Produces: 推送到 `origin/main` 的最终状态

- [ ] **Step 1: 全量静态校验**

```bash
cd "D:/code/23-Z.ai抢购" && for f in src/*.js; do node --check "$f" || echo "FAIL: $f"; done && node --test tests/ && node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest OK')"
```
预期:无 FAIL、测试 `# fail 0`、`manifest OK`。

- [ ] **Step 2: 病灶透镜终审(方法论见开头「怎么 review」表)**

对 `git diff <本计划首个提交>^..HEAD` 逐条过 7 面透镜;推荐跑 `/code-review`(高档)或派 fresh subagent。**每条透镜给结论**,重点:
- 透镜 1:预刷新(Task 4)是 fireAt 前唯一的导航——确认其幂等闸(pageAge≥10s)与 `remain>0` 条件都在;
- 透镜 3:Task 4 的 setTimeout 走了 `reloadTimer`/`_reloadPending`;
- 透镜 6:给出数字——长尾 ~880→~365 次/小时,预刷新 +1 次/天,黄金窗口不增请求只减延迟。

- [ ] **Step 3: 敏感信息审计(公开仓库)**

```bash
cd "D:/code/23-Z.ai抢购" && git --no-pager grep -nE "api[_-]?key|secret|Bearer |password|privaterelay|appleid" -- src/ tests/ manifest.json docs/ || echo "audit clean"
```
预期:`audit clean`。

- [ ] **Step 4: 推送**

```bash
cd "D:/code/23-Z.ai抢购" && git push origin main && git --no-pager log --oneline -7
```
预期:推送成功,最近 6 个提交对应 Tasks 1-5 + 本前的基线。

- [ ] **Step 5: 实战前提醒(写给使用者,非代码)**

- `chrome://extensions` 重载扩展;
- 开抢日**只布防一次**,不要反复手动开抢(每次都是整页加载+接口请求,自我限流主因);
- 开抢那一分钟让标签留在前台(rAF 亚帧精度;后台已修为最多迟 ~1s,但前台更优)。

---

## Self-Review 记录

- **覆盖核对**:四个优化点(预刷新 Task 4、首刷零延迟 Task 3、渐进长尾 Task 2、死配置 Task 5)+ 测试方法论与 review 方法论(专节 + 各任务内嵌)——全覆盖,无遗漏。
- **占位符扫描**:全文无 TBD/TODO/"适当处理";所有代码步骤给出完整代码;Task 5 的删除步骤给出被删代码的可辨识特征与删除后校验命令。
- **类型/签名一致性**:`reloadCycleMs(elapsed, cfg)`、`reloadDelayMs(elapsed, floor, jitterFn, goldenMs?)`、`shouldPreReload(remain, pageAge, opts?)` 在 Task 1 定义、Tasks 2-4 使用,名称与参数序一致;`elapsedSinceFire` 变量 Task 2 产出、Task 3 消费,已在 Interfaces 声明。
