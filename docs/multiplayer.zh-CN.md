# 联机牌桌：实现与运行说明

**状态**：方案里的 **P0 + P1 已实现并通过测试**。P2（大厅/旁观）与 P3（AI 上服务端 + 数据库）仍未做。
设计方案与后续阶段见 [`multiplayer-online-plan.zh-CN.md`](multiplayer-online-plan.zh-CN.md)，免费部署资源的调研见 [`free-hosting-research.zh-CN.md`](free-hosting-research.zh-CN.md)。

---

## 一分钟跑起来

```bash
npm ci
npm run build     # 产出 dist/，其中包含第二入口 table.html
npm run server    # 默认 8787：同一个进程同时托管 dist/ 和 WebSocket
```

浏览器打开 <http://localhost:8787/table?code=FRIENDS>，把链接发给朋友即可同桌。

- **同一台电脑试玩**：开两个浏览器 profile（或一个无痕窗口），都访问上面的地址，各自输入名字 → 坐下 → 准备。
- **局域网和朋友玩**：把 `localhost` 换成你的局域网 IP，例如 `http://192.168.1.20:8787/table?code=FRIENDS`。服务端默认监听 `0.0.0.0`，Windows 需要放行 8787 端口（首次运行会弹防火墙提示）。
- **没有电脑，只用两台手机**：让安卓机跑 Termux + Node 当服务器、自己开热点，iPhone 连进来即可。步骤见 [`mobile-hotspot.zh-CN.md`](mobile-hotspot.zh-CN.md)。
- **公网**：见下面「部署」。

座位满了会有 `TABLE_FULL`；两人都点「准备」后自动开第一手牌，之后每手之间停顿几秒自动继续。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP + WebSocket 端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `BIG_BLIND` | `20` | 大盲 |
| `STARTING_STACK` | `1000` | 每次入座发的筹码 |
| `MAX_SEATS` | `6` | 座位数 |
| `TURN_MS` | `45000` | 回合计时；超时自动看牌或弃牌 |

前端连接地址可用 `VITE_TABLE_WS_URL` 覆盖（前后端分开部署时才需要）。

## 新增与改动的文件

| 文件 | 作用 |
| --- | --- |
| `services/tableController.ts` | **P0**：无头牌桌控制器。时间由 `tick(now)` 显式注入（不用 `setTimeout`），服务端与浏览器共用；负责座位、准备状态、回合计时、超时自动行动、以及**按座位脱敏的视图** |
| `server/protocol.ts` | 前后端共享的线协议。零依赖、浏览器安全（不含任何 `node:` 导入） |
| `server/room.ts` | 一个房间 = 一张桌 + 挂在它上面的 socket；每个 socket 只收到属于自己座位的视图 |
| `server/rooms.ts` | 房间码 → 房间；无人连接且无人入座时回收 |
| `server/app.ts` | HTTP + WebSocket（顺带托管 `dist/`），以库的形式导出 `startServer`，测试可直接导入而不会占端口 |
| `server/index.ts` | 可运行入口（`npm run server`） |
| `scripts/test-table.ts` | P0 验收：18 项，无网络、无定时器 |
| `scripts/test-multiplayer.ts` | P1 端到端验收：12 项，两个真实 WebSocket 客户端同桌打一手，并逐帧审计 |
| `table.html`、`table.tsx` | 牌桌页面入口（Vite 第二入口） |
| `components/multiplayer/TableScreen.tsx`、`services/tableClient.ts` | 牌桌 UI 与客户端传输层 |
| `vite.config.ts` | 增加 `table.html` 作为第二个构建入口 |
| `package.json` | 新增依赖 `ws`，以及 `server` / `test:table` / `test:multiplayer` 脚本 |
| `.gitignore` | 忽略打包产物 `.server` |

**未改动**：单机模式的所有既有代码路径（`App.tsx`、`PokerGame.tsx`、`pokerEngine.ts`、AI 调用与 `localStorage` 存档）保持原样，`npm run test:local` 仍然通过。联机是**新增**的第二入口，不影响原来那套玩法。

## 线协议摘要

客户端 → 服务端：

| 消息 | 说明 |
| --- | --- |
| `{t:'hello', token?}` | 连接后第一件事。带 token 则尝试回到原座位（重连） |
| `{t:'sit', name?}` | 入座，服务端回 `seated` 并给一个 token |
| `{t:'ready'}` | 准备；两人就绪即自动开牌 |
| `{t:'action', actionId, action, amount?}` | `fold` / `check` / `call` / `raise` |
| `{t:'leave'}` | 离座（手牌进行中则本手结束后释放） |
| `{t:'ping', ts}` | 心跳，同时防止免费实例休眠 |

服务端 → 客户端：

| 消息 | 说明 |
| --- | --- |
| `{t:'welcome', protocol, roomCode, youId, config}` | 版本、房间、自己的座位、盲注/座位数等 |
| `{t:'seated', playerId, token, seat}` | 入座成功（token 存 localStorage 用于重连） |
| `{t:'state', view}` | 该座位可见的完整牌桌快照（带递增 `seq`） |
| `{t:'error', code, message, actionId?}` | 非法操作被拒，附带人类可读原因 |
| `{t:'pong', ts}` | 心跳回应 |

### 安全边界（这是联机最关键的部分）

`TableController.viewFor(playerId)` 是**唯一**的状态出口，规则是：

- 只下发自己的底牌；
- 别人的底牌只在**摊牌阶段**且该玩家**仍在争夺底池**时才下发（弃牌的不亮）；
- `deck`（整副牌）**永不**进入任何视图；
- 公共牌按街道只下发已翻开的张数；
- 服务端用引擎校验每一个动作（轮次、跟注额、最小加注、筹码上限），非法动作直接拒绝。

`scripts/test-multiplayer.ts` 会把它收到的**每一个原始网络帧**解析出来逐帧断言这几点，而不只是检查最终状态。

## 已验证（可复现）

| 命令 | 结果 |
| --- | --- |
| `npm run test:table` | 18/18 通过：座位/发牌/脱敏、摊牌亮牌、超时自动弃牌、跨手入座延后发筹码、非法动作拒绝（过小加注拒绝、超上限加注收敛为全下、面对下注不能看牌）、30 手牌逐手筹码守恒 |
| `npm run test:multiplayer` | 12/12 通过：两个真实客户端入座、拿 token、自动开牌、越权操作返回 `NOT_YOUR_TURN`、打完一手到摊牌；**审计 A 收到的 16 个 state 帧：无 `deck`、无对手底牌**；摊牌后对手亮牌；带 token 重连回到原座位；服务端计时器在无人操作时自动结手 |
| `npm run test:local` | 仍然通过（单机模式未被破坏） |
| `npx tsc --noEmit` | 通过 |
| `npm run build` | 通过，`dist/` 内含 `index.html` 与 `table.html`（加载 `assets/table-*.js`，并复用 `PlayingCard` 那个 chunk），无 API key 残留 |
| `npm run server` | 通过：真实启动并监听，`/healthz`、`/rooms` 返回 JSON，`/table` 返回 200 并托管 `dist/` |
| 前端关键路径代码审查 | 按钮严格按 `legal.fold/check/call/raise` 分支渲染（含键盘快捷键）；陈旧帧按 `seq` 丢弃；隐藏牌只渲染牌背（`seat.hand === null` → `hidden`）；带 token 重连；每 20 秒 `ping` |
| `npm run test:browser` | **全部通过**（用 CDP 驱动真实 Chrome，同时开两个页面）：页面标题与入座表单渲染 → 输入名字点 `Sit down` 入座 → 双方点 `Ready` 后自动开牌 → **A 的 DOM 里只有自己的两张牌（如 4♥ 6♥）、B 的只有自己的（7♦ K♦），两者交集为空 —— DOM 层没有底牌泄露** → 通过界面点操作按钮把整手牌打到结算（"Alice wins $30 · Opponents folded"）→ 无控制台报错、无失败请求 |

自己复跑浏览器验证需要三样东西（服务端 + 一个开了调试端口的 Chrome + 测试脚本）：

```bash
npm run server                 # 终端 A
chrome --headless=new --remote-debugging-port=9222 --user-data-dir=%TEMP%\fp-cdp about:blank   # 终端 B
npm run test:browser           # 终端 C
```

## 部署

前后端是**同一个进程**，所以一台免费实例就够：

| 平台 | 做法 | 注意 |
| --- | --- | --- |
| Render 免费 Web Service | Build：`npm ci && npm run build`；Start：`npm run server` | 15 分钟无入站流量会休眠；前端已每 20 秒 `ping` 一次保活。端口用平台注入的 `PORT` |
| Oracle Always Free / 任意 VPS | `npm ci && npm run build && npm run server`，用 pm2 或 systemd 常驻 | 需要自己放行端口；长期免费但闲置可能被回收 |
| 前后端分离 | 前端静态托管（Cloudflare Pages / Vercel），把 `VITE_TABLE_WS_URL` 指向服务端 `wss://` 地址 | Vercel 的 WebSocket 连接会在函数最长时长（Hobby 300s）处断开，不要用它跑游戏长连接 |

Cloudflare Workers + Durable Objects 是额度最宽裕的免费方案，但**不能直接跑这个常驻 Node 进程**，需要把房间改写成 Durable Object 模型（见方案文档 P1 备注）。

## 当前限制（有意为之的 MVP 取舍）

- **无账号、无数据库**：牌局和筹码都在服务端内存里，进程重启即清空，重连 token 也随之失效。
- **每次入座固定发 `STARTING_STACK` 筹码**：没有带入/补码，也不写回任何资金库。
- **联机桌只有真人**：服务端不调用任何模型（key 只应存在于服务端环境变量，见方案文档 P3）。想和 AI 打仍用原来的单机模式。
- **无旁观者界面**：不发送 `hello` 的连接会以观众身份收到脱敏视图（看不到任何底牌），但没有专门的观战 UI。
- **无速率限制**：朋友局够用；公网开放前应补上动作限流与房间密码。

## 下一步（P2 / P3）

1. **P2**：房间大厅（建房/房间列表/房主踢人）、旁观模式、更完整的重连体验（座位回收提示）。
2. **P3**：把 AI 对手搬到服务端（`services/pokerAi.ts` 的 `getAIDecision` 在服务端调用，key 只放环境变量），加 token 预算护栏，超预算降级到 `services/localPractice.ts` 的规则对手；用 Postgres 存账号、牌局与战绩。
3. 安全加固：动作限流、房间密码、好友白名单、日志脱敏。
