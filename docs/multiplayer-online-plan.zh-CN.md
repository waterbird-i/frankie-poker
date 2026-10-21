# Frankie Poker 联机改造方案（和朋友同桌打牌）

> **状态更新：P0 与 P1 已实现并通过测试**，运行方式、验收结果与限制见 [`multiplayer.zh-CN.md`](multiplayer.zh-CN.md)；P2/P3 仍是方案。实施中有四处与本文不同，以代码为准：
> 1. P0 **没有改动** `PokerGame.tsx`：`services/tableController.ts` 是新增的无头控制器，单机模式原样保留，回归风险更低；
> 2. 服务端拆成 `server/app.ts`（库，导出 `startServer`，测试导入不会占端口）+ `server/index.ts`（可运行入口）；
> 3. 牌桌前端是**第二个 Vite 入口** `table.html`，而不是在 `App.tsx` 里加路由；
> 4. 重连（原计划放在 P2）已提前做了最小版本：入座发 token，带 token 的 `hello` 回到原座位。
>
> 所有"现状"结论都基于本地 fork 的源码核对（提交 `efef7e4`，main 分支），行号可直接跳转查看。

---

## 0. 摘要

| 项 | 结论 |
| --- | --- |
| 现状 | 纯前端静态站（Vite → `dist`），单人 vs AI，全部状态存浏览器 `localStorage`，**零网络层、零服务端** |
| 目标 | 2~6 个真人（可混 AI）同一张桌子，服务端权威，支持断线重连 |
| 关键前提 | **已验证**：现有规则引擎可在 Node 端无头运行（`npm run test:local` 通过，30 手牌、零网络请求），所以服务端可以直接复用，不必重写扑克规则 |
| 工作量（粗估） | P0+P1 能和朋友打上：约 4~7 个工作日；P0~P3 完整可用：约 2~3 周 |
| 最大坑 | 隐藏信息。当前 `GameState` 里含 `deck` 和所有人的 `hand`，**必须**做按座位脱敏，否则改完就是"能看对手底牌" |

---

## 1. 现状盘点（代码级）

| 关注点 | 现状 | 位置 | 联机要变成什么 |
| --- | --- | --- | --- |
| 权威状态 | React `useState<GameState>`，全在浏览器 | `components/PokerGame.tsx:33` | 服务端持有，客户端只拿脱敏视图 |
| 发牌/洗牌 | `generateDeck()` 用 `Math.random()`，在客户端洗 | `constants.ts:240-253` | 服务端洗牌（`crypto.randomInt` 或 crypto 洗牌），客户端永远看不到整副牌 |
| 规则推进 | 大量规则逻辑写在 UI 组件里（发新一手、动作结算、阶段推进、边池） | `components/PokerGame.tsx:88`（startNewHand）、`:356`（handlePlayerAction）、`:267/294/619/631`（useEffect 推进） | 抽成 headless 控制器，服务端跑 |
| 已有无头引擎 | `pokerEngine.ts`（401 行，纯函数：`createEngine` / `startHand` / `applyAction`，带正确边池），供模拟与锦标赛用 | `services/pokerEngine.ts:92, 291` | **直接复用为服务端权威引擎** |
| 隐藏信息 | `GameState.deck: Card[]` + `Player.hand: Card[]` 全量在客户端；引擎注释写明"五张公共牌一次性发好" | `types.ts:60, 139`；`services/pokerEngine.ts:24` | 服务端持牌；按 street 只下发可见公共牌；只下发本人手牌 |
| AI 决策 | 客户端 `await getAIDecision(...)`，浏览器直连模型 | `services/pokerAi.ts:183`；调用点 `components/PokerGame.tsx:635` | 移到服务端调用（key 不外泄、防止客户端篡改） |
| API Key | 存在 `localStorage['franks-holdem:ai-connection']`，请求浏览器直发 OpenRouter | `services/aiConnection.ts:8` | 联机模式下 key 只放服务端环境变量；本地模式保留现状 |
| 身份与进度 | 资金、对手配置、HUD 统计、语言、头像全在 `localStorage`（共 21 处调用） | `services/bankroll.ts`、`playerProfile.ts`、`seatStats.ts`、`playerStats.ts`、`i18n.tsx` 等 | 账号体系 + 数据库；`localStorage` 只留纯 UI 偏好 |
| 计时器 | 客户端 `setTimeout` 驱动 AI 思考、亮牌、all-in runout | `components/PokerGame.tsx:267, 346` | 服务端统一计时与超时（自动 check/fold） |
| 入口/流程 | `App.tsx` 用 `view` 状态机：LOGIN → LOBBY → GAME | `App.tsx:23` | 增加 ROOM（建房/进房/座位）视图 |
| 部署形态 | `vercel.json` 纯静态 + `dist`；无 `api/` 目录；依赖里没有任何 socket/ws/peer 库 | `vercel.json`、`package.json` | 前端仍静态部署，另加一个常驻进程（WebSocket 服务端） |

**容易混淆的一点**：`types.ts:123` 的 `mode?: 'online' | 'local'` 里的 "online" 指的是"对手用远程模型 API"，**不是**联机对战；`localPractice.ts:8` 的 `isLocalGame` 也是这个含义。改联机时别复用这个字段名，建议新增 `transport: 'solo' | 'table'`。

---

## 2. 目标架构

```
┌──────────────┐   WebSocket(JSON)   ┌───────────────────────────────┐
│ 浏览器 A      │ ◄─────────────────► │  游戏服务端 (Node 22 + TS)      │
│ React 客户端  │                     │  ├ rooms.ts   房间注册表         │
│ 只渲染        │   ┌──────────────┐  │  ├ table.ts   每房间一个控制器   │
│ GameView      │   │ 浏览器 B      │  │  ├ engine ──► pokerEngine.ts    │  ← 复用现有引擎
│ 只发动作      │ ◄─┤ 同上          │  │  ├ view.ts   按座位脱敏          │
└──────────────┘   └──────────────┘  │  ├ ai.ts     调模型(服务端持key) │
                                     │  └ store.ts  Postgres(可选)      │
                                     └───────────────────────────────┘
```

三条硬规则：

1. **服务端权威**：洗牌、发牌、合法动作校验、计时、结算全在服务端。
2. **按座位脱敏**：客户端拿到的 `GameView` 只包含"这个座位有权看到的信息"。
3. **传输层可替换**：前端加一个 `GameTransport` 抽象，`LocalTransport`（现有单机逻辑）与 `SocketTransport` 两种实现，单机模式不被破坏。

---

## 3. 分阶段实施

### P0 · 抽出无头牌桌控制器（1~2 天）

目标：把规则逻辑从 `PokerGame.tsx` 搬到可被 Node 直接调用的模块，**玩法行为不变**。

- 新增 `services/tableController.ts`：包一层 `pokerEngine`，对外暴露
  `createTable(config)` / `startHand()` / `act(seatId, action, amount)` / `tick(now)` / `getView(seatId)`。
- 关键改造：把 `setTimeout` 驱动改成**显式时间注入**（`tick(now)`），这样同一套逻辑在浏览器和 Node 里都能跑。
- `PokerGame.tsx` 改为消费控制器输出；删掉组件内的规则分支（保留 UI 组件）。
- 验收：`npx tsc --noEmit`、`npm run build`、`npm run test:local` 全绿；单机模式人工打 3 手牌，行为与改造前一致。

### P1 · 服务端骨架 + 双人联机 MVP（3~5 天）

新增 `server/` 子包（同一仓库，独立 `tsconfig`，`ws` 作为唯一新增运行时依赖）：

| 文件 | 职责 |
| --- | --- |
| `server/index.ts` | HTTP + WebSocket 监听（`ws`），连接鉴权 |
| `server/rooms.ts` | 房间注册表：6 位房间码 → 房间；空房回收 |
| `server/table.ts` | 每房间一个 `tableController` 实例 + 回合计时 |
| `server/protocol.ts` | 消息类型（与前端共享，避免两份定义漂移） |
| `server/view.ts` | `redactForSeat(state, seatId) → GameView`：本人手牌 + 已发公共牌 + 他人手牌数/筹码/状态；**永不下发 `deck`** |
| `server/validate.ts` | 用引擎校验动作合法性（轮到谁、跟注额、最小加注、筹码上限），非法直接拒绝 |

协议草案（JSON）：

```
c→s: {t:'room.join', code, name, token?}      s→c: {t:'room.state', room, seats, seq}
c→s: {t:'seat.take', seat}                     s→c: {t:'error', code:'SEAT_TAKEN'}
c→s: {t:'ready'}                               s→c: {t:'hand.start', handNumber}
c→s: {t:'action', actionId, action:'fold'|'check'|'call'|'raise', amount}
                                               s→c: {t:'hand.view', view, seq}
c→s: {t:'ping'}                                s→c: {t:'pong'}
```

要点：
- 每个动作带 `actionId`，服务端去重（网络重发/乱序安全）；每条广播带递增 `seq`，客户端按 seq 丢弃过期帧。
- 回合超时由服务端计时，超时自动 check/fold。
- 验收：同一台机器开两个浏览器 profile 能同桌打完一手；**打开 A 的 DevTools 检查 WebSocket 帧，确认看不到 B 的底牌**（这是本阶段最关键的安全验收）；断网 30 秒重连后能继续。

### P2 · 房间大厅 + 断线重连 + 旁观（3~5 天）

- 建房/加入（房间码）、座位管理、准备/开始、带入筹码、房主踢人。
- 会话 token（JWT，`localStorage` 只存 token）：重连后服务端下发全量快照，自动回到原座位。
- 心跳与僵尸连接清理；旁观者只读模式。
- 验收：刷新页面回到原座位；关掉标签页 5 分钟后重连仍在局中；旁观者看不到任何手牌。

### P3 · AI 搬到服务端 + 持久化（3~6 天）

- `getAIDecision` 在服务端调用；房间级 AI 配置（模型 / 人格 / 提示词，沿用现有 `OpponentSeat` 结构）。
- **费用护栏**：每房间/每天 token 预算，超限自动降级到 `localPractice.ts` 的规则对手（`LOCAL_MODEL = 'local/rules'` 已现成）。
- 数据库（Postgres）：`users` / `rooms` / `hands` / `bankroll` / `stats`；`localStorage` 只留语言、头像、牌桌皮肤。
- 可选：首次登录把本地 `bankroll` 上报一次做迁移。
- 验收：一个房间跑通"真人 + 2 个 AI"；服务端日志里不出现任何 key；预算超限时降级路径生效。

### P4 · 打磨（可选）

- 非自己回合的多人等待 UI、观战、牌谱回放（`handHistory` / `handNotes` 已有数据）。
- 安全加固：动作限流、房间密码、好友白名单、日志脱敏。

---

## 4. 关键设计点与坑

1. **隐藏信息是第一位的问题，不是收尾工作。**
   `types.ts:139` 的 `GameState.deck` 和 `types.ts:60` 的 `Player.hand` 目前都在客户端内存里；`services/pokerEngine.ts:24` 注释明确写着五张公共牌一次性发好。改造时如果图省事直接把 `GameState` 发给所有人，等于给每个玩家开了"透视"。必须实现 `redactForSeat`。
2. **不要做"某个客户端当主机"的方案**（P2P / 房主端跑引擎）：底牌一样会泄露，且房主掉线整局断。
3. **洗牌必须移到服务端**：现在 `constants.ts:253` 是 `Math.random()`，客户端可控，服务端要用 crypto 级随机。
4. **计时器必须在服务端**：客户端 `setTimeout`（`PokerGame.tsx:267, 346`）可被玩家改成"无限思考"。
5. **API key 归属要重新设计**：现在是"每个玩家自己的 key 在自己浏览器"（`services/aiConnection.ts:8`）。联机同桌时，AI 只有一份，key 只能放服务端环境变量，并加预算护栏，否则谁付钱说不清。
6. **前端改动面比看起来大**：`PokerGame.tsx` 905 行，其中相当一部分是规则逻辑，P0 之后要删掉换成"渲染视图 + 发动作"。好消息是 38 个 UI 组件（`AIStratum` / `TableStratum` / `PlayingCard` / `SeatSnake` 等）基本可原样复用。
7. **幂等与顺序**：移动网络下重发、乱序很常见，`actionId` + `seq` 是必需的，不是加分项。
8. **单机模式要保留**：它是这个项目的卖点（无需 key 试玩、离线可跑），别为了联机把 `mode: 'local'` 路径改坏。

---

## 5. 工作量与优先级（粗估，非承诺）

| 阶段 | 内容 | 估时 | 可交付 |
| --- | --- | --- | --- |
| P0 | 抽控制器 | 1~2 天 | 单机模式行为不变，引擎可在 Node 跑 |
| P1 | 服务端 + 双人 MVP | 3~5 天 | **能和朋友打上一手牌**（无账号、无 AI） |
| P2 | 大厅 + 重连 + 旁观 | 3~5 天 | 稳定可日常用 |
| P3 | AI 上服务端 + 数据库 | 3~6 天 | 真人 + AI 混合桌、有账号和牌谱 |

**想这周末就打上**：只做 P0 + P1 的裁剪版——单房间（房间码硬编码）、无账号、无数据库（服务端内存态）、AI 用规则对手或干脆全真人。这版一天半到两天能出。

---

## 6. 免费部署资源

完整调研报告（含每条额度的官方原文引用、逐项核实状态、未能核实清单）见 [`docs/free-hosting-research.zh-CN.md`](free-hosting-research.zh-CN.md)。核实时间 2026-10-21，本机为中国大陆网络环境（无代理）。

### 结论：推荐组合

| 方案 | 适合谁 | 免费额度要点（官方原文） | 主要风险 |
| --- | --- | --- | --- |
| **① Cloudflare Workers + Durable Objects**（每房间一个 DO）+ Pages 托管前端 | 想做成长久自用的产品，愿意把 Node 服务改写成 Worker/DO 模型 | 官方明文："Durable Objects are available both on Workers Free and Workers Paid plans"；Free：Requests **100,000/天**（**含 WebSocket 消息**）、Duration **13,000 GB-s/天**、SQLite **5M 行读 / 10 万行写/天**；**超限只报错不扣费**；空闲 hibernation 不计时长；Pages 静态资源 "free and unlimited" | 不能直接跑 `ws` 常驻进程，需改写；Free 仅支持 SQLite-backed DO；大陆访问稳定性为经验性判断 |
| **② Render 免费 Web Service** | **改动最小**：直接跑现有 Node + `ws` | "**750 Free instance hours**" / workspace / 自然月（≈ 1 个常驻服务，730 h/月）；官方把 "WebSocket messages from existing connections" 计为入站流量 | 15 分钟无任何入站（含 WS 消息）即休眠、冷启动约 1 分钟 → 牌局间隙需客户端心跳保活；本地盘随休眠丢失，状态必须外置；**免费 Postgres 30 天后过期**（建议配 Neon） |
| **③ Koyeb Free Instance / Northflank Sandbox** | 备用 | Koyeb：512MB / 0.1 vCPU / 2GB SSD，每组织 1 个；Northflank 宣称 "Always-on-compute — no sleeping :)"、"2× free services" | Koyeb 1 小时无流量即缩零、仅 Frankfurt / Washington D.C.、0.1 vCPU 很弱；Northflank 免费实例规格未核实 |

### 已取消，别再找了

| 平台 | 官方原文 / 现状 |
| --- | --- |
| Fly.io | "No. New organizations don't have a free tier or a monthly free usage allowance."（最低常驻约 $2.19 / 30 天） |
| Hugging Face Spaces（Docker/Gradio） | "Gradio and Docker Spaces run on compute and **require a paid plan to create**" |
| PartyKit | 官网横幅："Deploys stop on **16 October 2026** and the platform **shuts down on 23 October 2026**" |
| Glitch | 已关停（2025 年公告） |
| AWS 新账号 | 只有 **6 个月 / $200 credits**，到期停号、90 天后永久删除 |
| Azure 免费账户 | $200 credit（30 天）+ 12 个月免费额度，之后必须转按量计费 |
| Heroku | 免费档早已取消（本项目早期文档时代的选择，不要再参考） |

### 真·长期免费 VPS：只有 Oracle Cloud Always Free 值得考虑

注意两个被广泛误传的点（均为官方原文）：

- Ampere A1 免费额度是 **1,500 OCPU hours + 9,000 GB hours/月 ≈ 2 OCPU + 12 GB 内存**，**不是**常被引用的 4 OCPU / 24 GB；另有 AMD 微实例 up to two（1/8 OCPU、1 GB）。
- **有回收风险**：闲置实例（7 天内 CPU / 网络 95 分位 < 20%）"may be reclaimed"；账号闲置 30 天以上可能被判定为 abandoned。
- 需要信用卡，且**不接受**预付卡 / 虚拟卡。

### 托管实时数据库：能广播，但不解决公平性

Supabase Realtime（200 并发连接、200 万消息/月，闲置 1 周暂停）、Firebase RTDB（Spark：100 并发连接）可以省掉自建服务器，但**它们不提供权威游戏逻辑**——发牌、校验、结算仍得有人做，放客户端就等于作弊。对德州扑克这种有隐藏信息的游戏，不建议作主方案；最多用来做大厅/房间列表这类非关键部分。

### 本项目的落地建议

- **周末局**：用方案 ② Render，接受冷启动；状态放内存，客户端每 5 分钟发一次心跳防休眠。
- **长期自用**：用方案 ① Cloudflare Workers + DO；前端继续静态托管（注意 Vercel Hobby 官方限制 "non-commercial, personal use only"，且其 WebSocket 连接会在函数最大时长 300s 处断开，不适合游戏长连接）。
- **想要一台真服务器、能接受绑卡和偶尔被回收**：Oracle Always Free。

---

## 7. 本次实际验证了什么

| 验证项 | 结果 |
| --- | --- |
| 本地 fork | 已克隆到 `frankie-poker/`，`origin` 已重命名为 `upstream`，分支 `main`，提交 `efef7e4` |
| 依赖安装 | `npm ci` 成功，546 包（仅有 `@lobehub/ui` 要求 Node ≥ 22.22 的 engine 警告，本机 22.21.0，不影响构建） |
| 类型检查 | `npx tsc --noEmit` 通过（exit 0） |
| 生产构建 | `npm run build` 通过（exit 0，约 5s） |
| 密钥安全 | `dist/` 内无 `OPENROUTER_API_KEY` / `sk-or-` 残留（构建期不注入 key，符合预期） |
| **引擎可无头复用** | `npm run test:local` 通过：*"30 offline hands across 2/6/10 seats completed; 24 showdowns. All streets, legal actions, chip conservation, short stacks and zero network calls verified."* —— 这是本方案"服务端复用现有引擎"的前提，已验证 |
| 未做 | 联机代码本身尚未实现（本文是方案）；未做真实多端联机压测 |
