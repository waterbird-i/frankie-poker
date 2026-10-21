// The game server as a library: one process that speaks WebSocket for the table
// and also serves the built client from dist/, so a single free instance can
// host both. `server/index.ts` is the runnable entry point; tests import
// `startServer` from here so importing it never opens a port.
//
// Configuration comes from the environment so a host can tune it without a
// rebuild.

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { TableConfig, TABLE_DEFAULTS } from "../services/tableController";
import { DEFAULT_ROOM_CODE, normalizeRoomCode } from "./protocol";
import { RoomRegistry } from "./rooms";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface ServerOptions {
  port?: number;
  host?: string;
  staticDir?: string | null; // null disables static hosting
  config?: Partial<TableConfig>;
  log?: (line: string) => void;
}

export interface RunningServer {
  port: number;
  url: string;
  rooms: RoomRegistry;
  close: () => Promise<void>;
}

const numberFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const tableConfigFromEnv = (): Partial<TableConfig> => ({
  bigBlind: numberFromEnv("BIG_BLIND", TABLE_DEFAULTS.bigBlind),
  startingStack: numberFromEnv("STARTING_STACK", TABLE_DEFAULTS.startingStack),
  maxSeats: numberFromEnv("MAX_SEATS", TABLE_DEFAULTS.maxSeats),
  turnMs: numberFromEnv("TURN_MS", TABLE_DEFAULTS.turnMs),
});

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
};

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const log = options.log ?? ((line: string) => console.log(line));
  const config: Partial<TableConfig> = { ...tableConfigFromEnv(), ...options.config };
  const rooms = new RoomRegistry({ ...TABLE_DEFAULTS, ...config } as TableConfig);
  const staticDir = options.staticDir === undefined ? path.resolve(process.cwd(), "dist") : options.staticDir;

  const serveStatic = async (res: ServerResponse, urlPath: string) => {
    if (!staticDir) return false;
    const clean = decodeURIComponent(urlPath.split("?")[0]);
    // `/table` is the multiplayer table page; everything else is a file.
    const relative = clean === "/" ? "index.html" : clean === "/table" || clean === "/table/" ? "table.html" : clean.replace(/^\/+/, "");
    const target = path.resolve(staticDir, relative);
    if (!target.startsWith(path.resolve(staticDir))) return false; // traversal guard
    try {
      const info = await stat(target);
      if (!info.isFile()) return false;
      const body = await readFile(target);
      res.writeHead(200, {
        "content-type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
        "content-length": body.length,
        "cache-control": path.basename(target) === "index.html" || path.basename(target) === "table.html" ? "no-cache" : "public, max-age=300",
      });
      res.end(body);
      return true;
    } catch {
      return false;
    }
  };

  const httpServer: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (url.startsWith("/healthz")) {
      return sendJson(res, 200, { ok: true, rooms: rooms.size, uptimeSeconds: Math.round(process.uptime()) });
    }
    if (url.startsWith("/rooms")) {
      return sendJson(res, 200, { rooms: rooms.list(), defaultRoom: DEFAULT_ROOM_CODE });
    }
    if (req.method === "GET" && (await serveStatic(res, url))) return;
    // Browsers always ask for a favicon and this app ships none, so answer
    // quietly instead of dropping a 404 into every visitor's console.
    if (url.startsWith("/favicon.ico")) {
      res.writeHead(204).end();
      return;
    }
    sendJson(res, 404, { error: "not_found", hint: "Run `npm run build` to serve the client from this process." });
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    const requestUrl = new URL(req.url ?? "/ws", "http://localhost");
    const code = normalizeRoomCode(requestUrl.searchParams.get("code"));
    const room = rooms.get(code);
    const connection = room.add(socket);
    log(`[ws] open room=${code} sockets=${room.size}`);

    socket.on("message", (data) => {
      room.handle(connection, data.toString());
    });
    socket.on("close", () => {
      room.remove(connection);
      log(`[ws] close room=${code} sockets=${room.size}`);
    });
    socket.on("error", () => socket.terminate());
  });

  // Drop sockets that stopped responding, and idle tables with them.
  const heartbeat = setInterval(() => {
    wss.clients.forEach((socket) => {
      if (socket.readyState === 1) socket.ping();
    });
    rooms.sweep();
  }, 30_000);

  const port = options.port ?? numberFromEnv("PORT", 8787);
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  log(`[server] listening on http://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}`);
  log(`[server] table page: /table   websocket: /ws?code=<ROOM>   health: /healthz`);
  if (staticDir) log(`[server] serving static files from ${staticDir}`);

  return {
    port: actualPort,
    url: `http://localhost:${actualPort}`,
    rooms,
    close: async () => {
      clearInterval(heartbeat);
      rooms.closeAll();
      wss.clients.forEach((socket) => socket.terminate());
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
