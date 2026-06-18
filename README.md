# GLM Coding 抢购助手

一个 Chrome MV3 扩展：在你**已登录**的 [open.bigmodel.cn/glm-coding](https://open.bigmodel.cn/glm-coding) 标签页内，
于每日开售时刻（默认 `10:00:00` Asia/Shanghai）检测补货（售罄 → 可购买的翻转），
**瞬时点击购买**，把腾讯验证码交给**人工**完成（伴随响亮提醒），
随后自动下单（create-sign）以**占住库存**，并**停在支付页面**。

> 本工具**绝不**自动付款、**绝不**尝试破解/绕过验证码。

## 它做什么

- 到点在已登录标签页内检测「暂时售罄/补货」→「特惠订阅」的状态翻转。
- 运行时从 Vue store（`allCardDataList`）按 `tier`+`period` 解析当前 `productId`（动态哈希，不硬编码），定位对应 `button.buy-btn`。
- 翻转瞬间点击购买，触发页面自带的腾讯验证码。
- 验证码弹出时**响亮提醒**（WebAudio 蜂鸣 + 系统通知 + 页面横幅「请立即完成验证码」），由你本人手动完成。
- 你通过验证码后，按设置：
  - `hold`（默认）：自动点击「确认支付」（create-sign）下未付款订单**占住库存**，然后**停在支付页**。
  - `beforeConfirm`：停在支付弹窗，不点确认。
- 全程实时日志；支持可选的「热备第二标签页」；内置礼貌限速。

## 安装（加载未打包扩展）

1. 打开 `chrome://extensions`。
2. 右上角开启「开发者模式 / Developer mode」。
3. 点击「加载已解压的扩展程序 / Load unpacked」。
4. 选择本文件夹（包含 `manifest.json` 的目录）。

## 使用

1. **先登录并完成实名**：在浏览器里正常打开 `https://open.bigmodel.cn/glm-coding` 并登录，确保账号已实名、可正常购买。
2. **设置目标与时间**：点击扩展图标右键 →「选项 / Options」（或在扩展管理页打开），设置：
   - 抢购目标：站点 / 档位（lite/pro/max）/ 周期（month/quarter/year）/ 优惠码。
   - 时间与触发：开售时间、时区、提前量、轮询间隔、重试截止、每日自动重新武装。
   - 下单与停点：`hold`（默认，占库存后停在支付页）或 `beforeConfirm`。
   - 双标签 / 提醒 / 高级（选择器覆盖、备选清单）。
3. **武装（Arm）**：点击扩展图标打开弹窗，点「Arm」。弹窗显示状态、到点倒计时、主/备标签指示、实时日志。
4. **彩排（强烈建议）**：先打开「Dry-run」开关做一次干跑——它会完整执行检测与计时并打印「[DRY] would click buy / would confirm」，但**不会真正点击**，零副作用。确认流程无误后再关闭 Dry-run 正式抢购。

## 安全边界（不可协商）

- **绝不破解/绕过验证码**：ticket/randstr 只能来自人工完成的腾讯验证码。
- **绝不自动付款**：流程止于支付页面（占库存的未付款订单），真正的支付宝/微信付款由你本人完成。
- 单账号；最多 2 个标签页。
- 轮询/刷新有下限（≥250ms）+ 抖动；不做请求指纹伪造。
- 所有 Vue 内省与 DOM 查找均带 try/catch，保持防御性。

## 文件结构

- `manifest.json` — MV3 清单（经典 service worker，无 `type:module`）。
- `src/selectors.js` — 页面探测/选择器库（`self.GLM.selectors`）。
- `src/logger.js` — 统一日志库（`self.GLM.logger`）。
- `src/timesync.js` — 基于 HTTP `Date` 头的时间同步库（`self.GLM.timesync`，秒级精度，见文件内说明）。
- `src/background.js` — 经典 service worker：调度、计时、消息总线、通知（后续实现）。
- `src/content.js` — 购买页内容脚本：检测、计时自旋、点击、验证码交接、下单占位（后续实现）。
- `src/popup.html` / `src/popup.js` — 弹窗 UI（后续实现）。
- `src/options.html` / `src/options.js` — 设置页（后续实现）。
