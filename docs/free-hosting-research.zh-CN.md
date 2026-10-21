# 免费部署资源核实报告（朋友间联机德州扑克）
核实时间：2026-10-21（本机时钟）。所有数字均摘自下列官方页面原文；本机网络为中国大陆网络环境（无代理），
google.com / cloud.google.com / firebase.google.com / huggingface.co / raw.githubusercontent.com / web.archive.org / r.jina.ai 全部连接超时或被拒，
因此个别站点改用官方镜像（firebase.google.cn）或社区镜像（hf-mirror.com），已逐条标注。

## 表 A｜支持 WebSocket 的免费容器/Serverless

| 平台 | 免费额度（原文数字） | WS 长连接 | 休眠/冷启动 | 需信用卡 | 官方 URL | 核实状态 |
|---|---|---|---|---|---|---|
| Cloudflare Workers + Durable Objects | **Workers Free 计划包含 Durable Objects**（原文："Durable Objects are available both on Workers Free and Workers Paid plans."；Free 计划**只能用 SQLite-backed DO**）。DO Free：Requests **100,000 / day**；Duration **13,000 GB-s / day**；SQLite 存储 Free：Rows reads **5 million / day**、Rows written **100,000 / day**、SQL Stored data **5 GB (total)**。超限："further operations of that type will fail with an error."（只报错不扣费） | 是（官方示例即 WebSocket 广播游戏/聊天状态；推荐 WebSocket Hibernation API，"Durable Objects that are idle and eligible for hibernation are not billed for duration"） | 无常驻进程概念；DO 空闲即不计时长；pending I/O 最多保活 15 分钟 | 定价页未提及；未核实 | https://developers.cloudflare.com/durable-objects/platform/pricing/ | 已核实 |
| Deno Deploy | Free **$0/month**：Requests **1M**/月、Egress **20 GiB**、Active CPU **10 hr**、Memory time **150 GiB-hr**、KV **1 GiB**、Apps **10**、自定义域 **5** | 未核实（docs 的 websockets 页面在本网络 404，未能取得原文） | 原文："Idle apps automatically shut down after ~20-30 seconds, so you're not billed for memory while scaled to zero." | 未核实 | https://deno.com/deploy/pricing | 额度已核实；WS 未核实 |
| Render | Free Web Service：**750 Free instance hours** 每个 workspace 每自然月，月初重置、不结转；用尽后"suspends all of your Free web services until the start of the next month" | 是（原文把 "WebSocket messages from existing connections" 计为入站流量） | 原文："spins down a Free web service that goes 15 minutes without receiving any inbound traffic"；"spins back up … takes about one minute"；本地磁盘随休眠丢失 | 未核实（官方只写绑卡会做 $1 预授权校验） | https://render.com/docs/free | 已核实 |
| Koyeb | Free Instance：**512MB RAM, 0.1 vCPU, 2GB SSD**，"Each organization is limited to one Free Instance"；仅 Frankfurt 或 Washington D.C. | 未核实 | 原文："They scale down to zero when they don't receive any traffic for 1 hour." | 未核实 | https://www.koyeb.com/docs/reference/instances | 已核实 |
| Railway | 有 **$0/月 Free** 计划，但额度仅："Start with a 30-day free trial with $5 credits, then **$1 per month**"；1 vCPU / 0.5 GB RAM，0.5 GB volume | 未核实 | 未提及 | 原文 "No credit card required" | https://railway.com/pricing | 已核实（但不足以常驻） |
| Fly.io | **已取消**。原文："Is there a free tier? **No. New organizations don't have a free tier or a monthly free usage allowance.**" 仅 free trial："up to 2 hours of Machine runtime or 7 days"；最低常驻 shared-cpu-1x/256MB 在 iad/ewr = **$2.19 per 30 days** | — | — | trial 不需要，trial 结束后要绑卡 | https://fly.io/docs/about/pricing/ | 已核实 |
| Hugging Face Spaces (Docker) | **已取消（对 Docker）**。原文："Static Spaces are free for everyone. **Gradio and Docker Spaces run on compute and require a paid plan to create** … Free personal accounts … can still host up to 2 Gradio Spaces running on ZeroGPU." CPU Basic 2 vCPU / 16 GB 标 "FREE"，但需付费计划才能创建 compute Space | 未核实（文档只写 "standard HTTP and HTTPS ports (80 and 443) along with port 8080"） | 原文："On free hardware, your Space will "go to sleep" and stop executing after a period of time if unused." | — | https://huggingface.co/docs/hub/spaces-overview（经 hf-mirror.com 镜像取得） | 已核实（经镜像） |
| PartyKit | **已取消/即将关停**。官网横幅原文："The hosted PartyKit platform is shutting down. **Deploys stop on 16 October 2026** and the platform **shuts down on 23 October 2026**." | — | — | — | https://www.partykit.io/ | 已核实 |
| Northflank | Sandbox（Free, starts at $0/mo）："**Always-on-compute — no sleeping :)**"、"**2× free services**"、"1× free database"、"2× free cron jobs" | 未核实 | 官方明确不睡眠 | 未核实 | https://northflank.com/pricing | 已核实（免费实例规格未核实） |
| Zeabur | Free Plan **US$0/month**，原文："No credit card required — just sign up and start deploying." | 未核实 | 原文："Services on the Free Plan automatically sleep after a period of inactivity. They wake up on the next incoming request, which may cause a few seconds of cold-start latency."；无 SLA | 不需要（原文） | https://zeabur.com/docs/en-US/pricing/free-plan | 已核实 |
| Glitch | **已关停**（官网/blog 只剩 2025 年关停公告："Important changes are coming to Glitch" 2025-05-22、"Until we meet again" 2025-07-23） | — | — | — | https://glitch.com/ | 已核实（已死） |

## 表 B｜托管实时数据库（免自建服务器）

| 方案 | 免费额度（原文数字） | 实时连接 | 暂停/休眠 | 需信用卡 | 官方 URL | 核实状态 |
|---|---|---|---|---|---|---|
| Supabase | 500 MB database size、Shared CPU / 500 MB RAM、5 GB egress、1 GB file storage。Realtime：**200 included** Concurrent Peak Connections、**2 Million** Messages Per Month、Max Message Size 256 KB。原文："Free projects are paused after 1 week of inactivity. Limit of 2 active projects." | 是（WebSocket Realtime） | 闲置 1 周暂停 | 未核实 | https://supabase.com/pricing | 已核实 |
| Firebase (Spark) | Realtime Database：**100** 并发连接、存储 1 GB、下载 10 GB/月（"No-cost up to 360 MB/day (equivalent to ~10 GB/month)"）。Cloud Firestore：**1 GiB total**、**20K writes/day**、**50K reads/day**、5 GB/月出网 | 是 | 无闲置暂停（Spark 项目长期有效） | Spark 不需绑卡 | https://firebase.google.cn/pricing（= firebase.google.com/pricing 的官方中文站点；google.com 在本网络不可达） | 已核实（经官方 .cn 站点） |
| Ably | Free：**200 concurrent connections**、**500 messages / second**、**6M messages / month** | 是 | — | 未核实 | https://ably.com/pricing | 已核实 |
| Pusher Channels | Sandbox（Free）：**Messages per day 200k**、**Concurrent connections 100** | 是 | — | 未核实 | https://pusher.com/channels/pricing/ | 已核实 |
| Neon | Free：**100 projects**、**100 CU-hrs monthly per project**、**1 GB of storage per project**；原文："no time limits and no credit card required"，compute 闲置自动 scale to zero | 否（仅 Postgres，无 Realtime WS） | scale-to-zero，不消耗 CU-hr | 不需要（原文） | https://neon.com/pricing | 已核实 |

## 表 C｜免费 VPS / 云主机

| 平台 | 免费额度（原文数字） | 真长期免费？ | 需信用卡 | 官方 URL | 核实状态 |
|---|---|---|---|---|---|
| Oracle Cloud Always Free | AMD：**up to two** VM.Standard.E2.1.Micro（**1/8th of an OCPU**、**1 GB** 内存）；Ampere A1：**first 1,500 OCPU hours and 9,000 GB hours per month**，"For Always Free tenancies, this is equivalent to **2 OCPUs and 12 GB of memory**"（注意：不是常被引用的 4 OCPU/24 GB）；Block Volume **200 GB** total；**10 TB per month** outbound data；每月 3000 封邮件 | 是（"available for an unlimited time"），但**有回收风险**：原文 "Idle Always Free compute instances may be reclaimed by Oracle … during a 7-day period: CPU utilization for the 95th percentile is less than 20%; Network utilization is less than 20%; Memory utilization is less than 20%（A1 only）"；另有 "Accounts left idle for 30 days or more may be deemed abandoned and become eligible for suspension or termination." | **需要**（"Why do I need to provide credit or debit card information…"，且不接受 PIN 借记卡/虚拟卡/预付卡） | https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm ； https://www.oracle.com/cloud/free/ | 已核实 |
| Google Cloud e2-micro 免费层 | **未核实**——cloud.google.com 在本机网络连接超时，无可用代理 | 未核实 | 未核实 | https://cloud.google.com/free/docs/free-cloud-features（访问失败） | 未核实 |
| AWS 免费层 | 新客户 **Free plan**：原文 "up to 6 months"、"up to $200 in credits"、"Your Free plan expires the earlier of (1) 6 months … or (2) once you have exhausted your Free Tier credits"；到期后 "AWS suspends your account … will retain your data for 90 days … permanently erase your AWS account"。"All customers, new and existing, can access over 30 services with always free offers."（EC2 是否仍有 750 小时/月 长期免费：**未核实**，free 表格为 JS 渲染，未取到原始数字） | 否（新账号 6 个月） | 需要（注册即要卡） | https://aws.amazon.com/free/ ； https://aws.amazon.com/free/free-tier-faqs/ | 部分核实 |
| Azure 免费账户 | **$200 credit**（30 天内用完）+ "Free monthly amounts of 20+ popular services for **12 months**"，含 "**750 hours each of B1s, B2pts v2 (Arm-based), and B2ats v2 (AMD-based)** burstable VMs"；原文要求 "you'll need to move to pay-as-you-go pricing within 30 days or after you've used your credit" | 否（12 个月后按量计费） | **需要**（信用卡/非预付借记卡 + 手机号；仅港/巴接受信用卡） | https://azure.microsoft.com/en-us/free/ | 已核实 |

## 表 D｜静态前端托管

| 平台 | 免费额度（原文数字） | 官方 URL | 核实状态 |
|---|---|---|---|
| Cloudflare Pages | "Static asset requests … on both free and paid plans, requests to static assets are **free and unlimited**"；站点文件数 Free **20,000 files**（付费 100,000）、单文件最大 **25 MiB**、构建 **500 builds/月**、1 个并发构建；Pages Functions 请求计入 Workers Free 的 **100,000/天** | https://developers.cloudflare.com/pages/platform/limits/ ； https://developers.cloudflare.com/pages/functions/pricing/ | 已核实 |
| Vercel Hobby | 免费，但原文："the Hobby plan restricts users to **non-commercial, personal use only**"。额度：Fast Data Transfer **First 100 GB**、CDN Requests **First 1,000,000**、Active CPU **4 CPU-hrs**、Provisioned Memory **360 GB-hrs**、Function Invocations **First 1,000,000**；超限一般要等 30 天。**WebSocket：官方文档写 "WebSockets are available on all plans"，但 "WebSocket connections close when a Vercel Function reaches its maximum duration"，Hobby 为 "300s (5 minutes) default and max"** | https://vercel.com/docs/plans/hobby ； https://vercel.com/docs/functions/websockets ； https://vercel.com/docs/limits | 已核实 |
| Netlify | Free："**300 credit limit**"（月度硬上限，"The free plan is always free, with hard monthly limits that cannot be exceeded or incur any costs"）；计量：生产部署 **15 credits each**、带宽 **20 credits per GB**、请求 **2 credits per 10k requests**、compute **10 credits per GB-hour** | https://www.netlify.com/pricing/ | 已核实 |
| GitHub Pages | 仓库建议 ≤ **1 GB**、发布站点 ≤ **1 GB**、"soft bandwidth limit of **100 GB per month**"、"soft limit of **10 builds per hour**"；原文明确不得用作商业/SaaS 托管 | https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits | 已核实 |

## Top 3 推荐（本场景：1~10 房间、每房 2~6 人、回合制、常驻 WebSocket）

1. **Cloudflare Workers + Durable Objects（每房间一个 DO），前端放 Cloudflare Pages**
   理由：唯一被官方明确写进免费计划的"长连接+持久状态"方案（"Durable Objects are available both on Workers Free and Workers Paid plans"），用 WebSocket Hibernation API 后空闲连接不计时长，免费额度（10 万请求/天、13,000 GB-s/天、SQLite 5M 读/10 万写/天）对 10 房×6 人完全够用，且超限只报错不扣费。Pages 静态资源"free and unlimited"。
   风险：(a) 需要把 Node 服务器改写成 Worker+DO 模型（不能直接跑 `ws` 常驻进程）；(b) 免费计划只能用 SQLite-backed DO，且 SQLite 存储计费自 2026-01-07 起生效（免费额度内不收费）；(c) 每房间一个 DO 的并发/请求计费需按 20:1 比例估算入站 WS 消息；(d) 中国大陆访问 Cloudflare 域名长期不稳定（经验性判断）。

2. **Render 免费 Web Service（直接跑现有 Node/TS + ws）**
   理由：改动最小，官方文档明确 WebSocket 计入入站流量、750 instance hours/月≈刚好够 1 个常驻服务（730 h/月），冷启动约 1 分钟可接受（回合制、朋友局）。
   风险：(a) 15 分钟无任何入站流量（含 WS 消息）就休眠——牌局间隙要客户端心跳或接受重连；(b) 休眠/重启丢本地磁盘数据，牌局状态必须放外部存储（Render 免费 Postgres **30 天后过期**，建议用 Neon 免费库）；(c) 750 小时用尽会暂停到次月；(d) 是否必须绑卡官方未写明。

3. **Koyeb Free Instance（512MB / 0.1 vCPU，每组织 1 个）或 Northflank Sandbox（"no sleeping"，2 个免费服务）**
   理由：Koyeb 免费实例官方明文存在且 scale-to-zero 保额度；Northflank 官方宣称免费层"Always-on-compute — no sleeping"。
   风险：Koyeb 1 小时无流量即缩零、仅 Frankfurt/Washington D.C.、0.1 vCPU 很弱；Northflank 免费实例规格未核实（可能是小规格且绑卡才可用）。

备选（不自建服务器）：Supabase Realtime（200 并发连接、200 万消息/月）+ Firebase RTDB（100 并发）可做房间内广播，但**没有权威游戏逻辑服务器**，牌局公平性/防作弊只能靠客户端或自建校验，不建议作为德州扑克主方案。

## 本次未能核实的项
1. **Google Cloud 免费层 e2-micro 具体限制**：cloud.google.com 从本机网络连接超时（无代理可用），完全未核实。
2. **AWS 是否仍有"12 个月/长期免费"的 EC2 750 小时**：free tier 页面为 JS 渲染，未取到原始数字；只核实了新账号 Free plan 仅 6 个月 + $200 credits 且到期停号。
3. **Northflank 免费服务/数据库的规格**（vCPU、RAM、是否需要绑卡）：定价页只写了数量，未写规格。
4. **Deno Deploy 的 WebSocket 支持**：docs.deno.com 的 websockets 页面在本网络 404，未取得原文。
5. **各平台"免费计划是否必须绑定信用卡"**：Render、Koyeb、Railway(付费)、Deno Deploy、Supabase、Ably、Pusher 的官方页面未明确写免费层是否需绑卡（Oracle/Azure/Neon/Zeabur 有明文）。
6. **中国大陆可访问性与备案**：本报告中所有关于大陆访问稳定性、是否需要备案的判断均为**经验性判断**，未在任何官方页面核实；本机网络本身对 Google/HuggingFace/GitHub raw/archive.org 的连接失败可作为一个客观旁证（同一网络下 Cloudflare、Render、Koyeb、Railway、Supabase、Ably、Neon、Oracle、AWS、Azure 的官网均可直接访问）。
7. **PartyKit 关停公告正文**：只取到官网首页横幅原文，未打开公告全文。

## 访问方式说明（可复现）
- 使用 `curl.exe -s -L --max-time 45 -A "Mozilla/5.0 …" <url>` 抓取 HTML，去 script/style/标签后按行提取；PowerShell `Invoke-WebRequest` 同样可用。
- 被网络阻断无法访问的：`huggingface.co`（改用 `hf-mirror.com` 镜像）、`firebase.google.com`（改用官方 `firebase.google.cn`）、`cloud.google.com`、`google.com`、`raw.githubusercontent.com`、`web.archive.org`、`r.jina.ai`（401）。
