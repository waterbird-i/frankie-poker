// The browser half of the multiplayer table.
//
// One WebSocket, one room code, and nothing else: this file forwards the
// server's frames to the UI and the UI's intent back to the server. It never
// derives table state of its own — every seat, pot and card the page draws
// arrived in a `state` frame, already redacted for this viewer by
// services/tableController.ts `viewFor`.
//
// The wire contract lives in server/protocol.ts and is imported, never
// re-declared, so a protocol change breaks this file's types instead of
// silently desynchronising it.

import { DEFAULT_ROOM_CODE, normalizeRoomCode } from "../server/protocol";
import type { ClientMessage, RoomConfigView, ServerMessage } from "../server/protocol";
import type { TableView } from "./tableController";

/** localStorage keys. The token is the seat: it survives a refresh. */
export const TOKEN_STORAGE_KEY = "franke-poker:table-token";
export const PLAYER_STORAGE_KEY = "franke-poker:table-player";
export const NAME_STORAGE_KEY = "franke-poker:table-name";

export type ConnectionStatus = "connecting" | "online" | "reconnecting" | "offline";

export interface TableWelcome {
  protocol: number;
  roomCode: string;
  youId: string | null;
  config: RoomConfigView;
  serverTime: number;
}

export interface SeatedInfo {
  playerId: string;
  token: string;
  seat: number;
}

export interface TableErrorInfo {
  code: string;
  message: string;
  actionId?: string;
}

export interface TableClientHandlers {
  onStatus?: (status: ConnectionStatus, attempts: number) => void;
  onWelcome?: (welcome: TableWelcome) => void;
  onSeated?: (seated: SeatedInfo) => void;
  onState?: (view: TableView) => void;
  onError?: (error: TableErrorInfo) => void;
  onPong?: (pong: { ts: number; serverTime: number }) => void;
}

const PING_INTERVAL_MS = 20_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
/** After this many failures in a row the page says "offline"; it keeps retrying. */
const OFFLINE_AFTER_ATTEMPTS = 6;

const storage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // private mode, or storage disabled
  }
};

export const readStoredToken = (): string | null => {
  try {
    return storage()?.getItem(TOKEN_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
};

export const readStoredName = (): string => {
  try {
    return storage()?.getItem(NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
};

export const writeStoredName = (name: string): void => {
  try {
    storage()?.setItem(NAME_STORAGE_KEY, name.slice(0, 24));
  } catch {
    /* storage is a convenience here, never a requirement */
  }
};

/** Forgets the seat locally. The server owns the truth; this only stops the
 *  next `hello` from offering a token the room has already swept. */
export const clearStoredSeat = (): void => {
  try {
    storage()?.removeItem(TOKEN_STORAGE_KEY);
    storage()?.removeItem(PLAYER_STORAGE_KEY);
  } catch {
    /* ignore */
  }
};

const rememberSeat = (seated: SeatedInfo): void => {
  try {
    storage()?.setItem(TOKEN_STORAGE_KEY, seated.token);
    storage()?.setItem(PLAYER_STORAGE_KEY, seated.playerId);
  } catch {
    /* ignore */
  }
};

/** `?code=ABC` from the address bar, or the default room. */
export const roomCodeFromSearch = (search: string): string =>
  normalizeRoomCode(new URLSearchParams(search).get("code")) || DEFAULT_ROOM_CODE;

/**
 * Same-origin by default: the Node server hosts the page and the socket on one
 * port. `VITE_TABLE_WS_URL` points the client at a different host (a separate
 * game server, or a LAN address during testing).
 */
const socketUrl = (roomCode: string): string => {
  const configured = import.meta.env.VITE_TABLE_WS_URL;
  const base =
    configured && String(configured).trim()
      ? String(configured).trim()
      : window.location.origin.replace(/^http/, "ws");
  return `${base.replace(/\/+$/, "")}/ws?code=${encodeURIComponent(roomCode)}`;
};

export class TableClient {
  readonly roomCode: string;

  private readonly handlers: TableClientHandlers;
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private attempts = 0;
  private actionCounter = 0;
  private disposed = false;
  private currentStatus: ConnectionStatus = "connecting";

  constructor(roomCode: string, handlers: TableClientHandlers = {}) {
    this.roomCode = normalizeRoomCode(roomCode) || DEFAULT_ROOM_CODE;
    this.handlers = handlers;
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  get isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === 1;
  }

  connect(): void {
    if (this.disposed) return;
    if (this.socket && this.socket.readyState <= 1) return; // already opening/open

    this.setStatus(this.attempts === 0 ? "connecting" : this.currentStatus === "offline" ? "offline" : "reconnecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl(this.roomCode));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      this.setStatus("online");
      this.post({ t: "hello", token: readStoredToken() ?? undefined });
      this.startPing();
    };

    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket) return;
      this.receive(event.data);
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopPing();
      this.scheduleReconnect();
    };

    // `onclose` always follows `onerror`; reconnecting is handled there.
    socket.onerror = () => undefined;
  }

  /** Closes for good: used when the component unmounts. */
  dispose(): void {
    this.disposed = true;
    this.stopPing();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, "page closed");
      } catch {
        /* ignore */
      }
    }
  }

  sit(name: string): boolean {
    return this.post({ t: "sit", name: name.slice(0, 24) });
  }

  ready(): boolean {
    return this.post({ t: "ready" });
  }

  leave(): boolean {
    const sent = this.post({ t: "leave" });
    if (sent) clearStoredSeat();
    return sent;
  }

  /** Returns the action id the server will echo back on refusal, or null when
   *  the socket was not open and nothing was sent. */
  act(action: "fold" | "check" | "call" | "raise", amount?: number): string | null {
    this.actionCounter += 1;
    const actionId = `a${this.actionCounter}-${Date.now().toString(36)}`;
    const message: ClientMessage = { t: "action", actionId, action, amount };
    return this.post(message) ? actionId : null;
  }

  // --------------------------------------------------------------- plumbing

  private post(message: ClientMessage): boolean {
    if (!this.isOpen) return false;
    try {
      this.socket!.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private receive(raw: unknown): void {
    if (typeof raw !== "string") return;
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    switch (message.t) {
      case "welcome":
        this.handlers.onWelcome?.(message);
        return;
      case "seated":
        rememberSeat(message);
        this.handlers.onSeated?.(message);
        return;
      case "state":
        if (message.view) this.handlers.onState?.(message.view);
        return;
      case "error":
        this.handlers.onError?.(message);
        return;
      case "pong":
        this.handlers.onPong?.(message);
        return;
      default:
        return;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.currentStatus = status;
    this.handlers.onStatus?.(status, this.attempts);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    // 1s, 2s, 4s, 8s, then the 10s cap.
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(this.attempts, 4));
    this.attempts += 1;
    this.setStatus(this.attempts >= OFFLINE_AFTER_ATTEMPTS ? "offline" : "reconnecting");
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.post({ t: "ping", ts: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
