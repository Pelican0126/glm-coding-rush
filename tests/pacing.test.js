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
