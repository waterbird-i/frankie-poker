# 两台手机互连：安卓当服务器（不依赖电脑）

目标：**安卓开热点 + 在安卓上跑服务端**，iPhone 连热点当第二个玩家。不需要 Mac，不需要外网。

## 原理（为什么必须有一台手机跑服务端）

热点只转发数据包，它本身不跑程序。这个游戏的发牌、验牌、按座位脱敏、广播状态都由 `server/` 那份 Node 进程完成，手机浏览器只是客户端。所以两台手机要互打，其中一台必须自己当服务器。

选安卓当服务器是因为安卓能装 Termux 跑 Node；iOS 无法在后台常驻一个监听端口的进程。

代码在这个方向上没有障碍：核心牌桌控制器 `services/tableController.ts` 不含任何 Node 专属 API，服务端只额外用 `node:http` / `node:crypto`（Node 内置），第三方依赖只有 `ws` 一个。

## 一、在电脑上打包（一次性）

```bash
npm ci
npm run pack:server
```

产出 `.server/mobile/`，共 48 个文件、约 2.9 MB：

```
.server/mobile/
├── server.mjs          # 打包好的服务端
├── dist/               # 前端（含 table.html）
└── node_modules/ws/    # 唯一的第三方依赖
```

把整个 `.server/mobile` 文件夹传到安卓手机（微信文件传输 / USB / 网盘都行）。

## 二、安卓手机装 Termux

**必须从 F-Droid 或 GitHub Releases 装，不要用 Google Play 版本**（Play 版已废弃，装不上 Node）。

- F-Droid: <https://f-droid.org/packages/com.termux/>
- 或 GitHub Releases 的 `.apk`

装好后打开 Termux：

```bash
# 1) 换国内镜像（否则下载很慢）
termux-change-repo        # 选 Mirror group → 选清华或中科大

# 2) 更新
pkg update -y && pkg upgrade -y

# 3) 装 Node
pkg install nodejs-lts -y
node -v                   # 需要 v18 或更高
```

## 三、把包放进 Termux 并启动

把 `.server/mobile` 里的**内容**拷到 Termux 可访问的位置，例如手机内部存储：

```
/storage/emulated/0/Download/mobile/
```

在 Termux 里授权存储访问（首次需要）：

```bash
termux-setup-storage
```

然后启动：

```bash
cd /storage/emulated/0/Download/mobile
node server.mjs
```

看到这行就是成功了：

```
[server] listening on http://localhost:8787
[server] table page: /table   websocket: /ws?code=<ROOM>   health: /healthz
```

> 服务端默认监听 `0.0.0.0:8787`，换端口用 `PORT=8899 node server.mjs`。
> 静态目录按 `server.mjs` 所在位置解析，所以从哪个目录启动都能找到 `dist/`。

## 四、安卓开热点，iPhone 连进来

1. 安卓：设置 → 热点 → 打开个人热点
2. **关掉「客户端隔离 / AP 隔离」**（部分 ROM 在热点高级设置里），否则 iPhone 连上了也访问不到安卓
3. iPhone：连这个热点
4. 在**安卓**上查自己的热点 IP：
   ```bash
   ifconfig 2>/dev/null | grep -A2 wlan
   ```
   或直接在 Termux 里看启动日志的地址；多数机型热点网关是 `192.168.43.1` 或 `192.168.230.1`

5. 两台手机浏览器都打开：

   ```
   http://<安卓热点IP>:8787/table
   ```

   不带 `?code=` 就是默认的 `FRIENDS` 房间。

6. 各自输名字 → `Sit down` → `Ready`。两人都 Ready 自动开第一手。

## 五、必做的连通自检

**iPhone 连上热点后，先用 Safari 打开：**

```
http://<安卓热点IP>:8787/healthz
```

- 看到 `{"ok":true,...}` → 通了，继续第 4 步
- 一直转圈 / 超时 → 热点有客户端隔离，或被 ROM 拦了（见下面第 7 条）

## 六、游戏参数（可用环境变量改）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP + WebSocket 端口 |
| `BIG_BLIND` | `20` | 大盲 |
| `STARTING_STACK` | `1000` | 每次入座筹码 |
| `MAX_SEATS` | `6` | 座位数 |
| `TURN_MS` | `45000` | 回合计时，超时自动过牌/弃牌 |

## 七、安卓上的已知坑

1. **Termux 被后台杀掉** —— 最常见的问题。去设置里给 Termux 开「允许后台运行 / 自启动」，并在最近任务里给 Termux 加锁。玩的时候**保持 Termux 在前台或通知栏常驻**，别切后台太久。
2. **熄屏后 Termux 被暂停** —— 把屏幕超时调长，或开发者选项里开「充电时不锁屏」。
3. **`node: command not found`** —— `pkg install nodejs-lts` 没装成功，或重装后需要重开 Termux。
4. **`Error: Cannot find module 'ws'`** —— 拷贝时漏了 `node_modules/ws`，重新完整拷一次 `.server/mobile`。
5. **页面能开但没有 Connected / 一直 Reconnecting** —— 热点内的 WebSocket 被拦，检查客户端隔离；也确认 iPhone 用的 IP 是热点 IP，不是旧 Wi-Fi 的 IP。
6. **`Copy invite link` 按钮无效** —— 纯 HTTP 下浏览器禁用剪贴板，这是已知限制，手动把地址发给对方。
7. **国产 ROM（小米/华为/OPPO/vivo）** —— 除自启动外，还要关掉「省电策略」对 Termux 的限制，否则热点一开就被杀。
8. **热点没流量也能玩**，这个游戏联机不需要外网。iPhone 可能提示「无互联网连接」，属正常。

## 八、验证记录（在电脑上复现过）

| 项目 | 结果 |
| --- | --- |
| `npm run pack:server` | 产出 48 文件 / 2.9 MB |
| 复制到无关目录后 `node server.mjs` | 正常启动，静态目录按脚本位置解析成功 |
| 打包产物 `/healthz`、`/table` | 200 |
| 打包产物上的双设备联机 | 11/11 通过（各拿私牌、互相只看到 hidden、帧内无 deck） |
| `npx tsc --noEmit` | 通过 |
| `npm run test:table` | 18/18 |
| `npm run test:multiplayer` | 12/12 |
| `npm run test:local` | 单机 30 手、零网络调用 |

**尚未验证**：以上全部在 macOS + Node 24 上完成。Termux 的 Node 版本、安卓各 ROM 的热点隔离、iOS Safari 上的实际连入，需要在你的真机上跑一遍才算数。第一步先做第五节的 `/healthz` 自检。
