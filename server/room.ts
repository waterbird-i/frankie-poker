// One table (one room code) plus the sockets attached to it.
//
// The room owns the only authoritative copy of the game: the TableController.
// Every socket receives its own redacted view, built by `viewFor(playerId)`.
// Nothing else in the process ever serialises the engine state directly, which
// is what keeps hole cards from leaking.

import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { TableConfig, TableController } from "../services/tableController";
import {
  ClientMessage,
  PROTOCOL_VERSION,
  RoomConfigView,
  ServerMessage,
  decode,
  encode,
} from "./protocol";

const TICK_MS = 250;

export interface Connection {
  socket: WebSocket;
  playerId: string | null;
  token: string | null;
  name: string;
  greeted: boolean;
}

export class Room {
  readonly code: string;

  private readonly controller: TableController;
  private readonly connections = new Set<Connection>();
  private readonly tokens = new Map<string, string>(); // token -> playerId
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBroadcastSeq = -1;

  constructor(code: string, config: TableConfig) {
    this.code = code;
    this.controller = new TableController(config);
  }

  get configView(): RoomConfigView {
    return {
      roomCode: this.code,
      bigBlind: this.controller.config.bigBlind,
      startingStack: this.controller.config.startingStack,
      maxSeats: this.controller.config.maxSeats,
      turnMs: this.controller.config.turnMs,
    };
  }

  get isIdle(): boolean {
    return this.connections.size === 0 && this.controller.seatedPlayerIds().length === 0;
  }

  get size(): number {
    return this.connections.size;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------ connections

  add(socket: WebSocket): Connection {
    const connection: Connection = {
      socket,
      playerId: null,
      token: null,
      name: "",
      greeted: false,
    };
    this.connections.add(connection);
    return connection;
  }

  remove(connection: Connection) {
    this.connections.delete(connection);
    if (connection.playerId) {
      // Keep the seat (and its stack) for a reconnect; the turn clock folds
      // them if they never come back, and the seat is swept once idle.
      this.controller.setConnected(connection.playerId, false, Date.now());
      this.broadcast();
    }
  }

  handle(connection: Connection, raw: string) {
    const message = decodeSafely(raw);
    if (!message) {
      this.send(connection, { t: "error", code: "BAD_MESSAGE", message: "Unreadable frame" });
      return;
    }
    switch (message.t) {
      case "hello":
        return this.onHello(connection, message.token, message.name);
      case "sit":
        return this.onSit(connection, message.name);
      case "ready":
        return this.onReady(connection);
      case "action":
        return this.onAction(connection, message.actionId, message.action, message.amount);
      case "leave":
        return this.onLeave(connection);
      case "ping":
        return this.send(connection, { t: "pong", ts: message.ts, serverTime: Date.now() });
      default:
        return this.send(connection, { t: "error", code: "BAD_MESSAGE", message: "Unknown type" });
    }
  }

  private onHello(connection: Connection, token?: string, name?: string) {
    if (typeof name === "string" && name.trim()) connection.name = name.trim().slice(0, 24);

    let youId: string | null = null;
    if (token && this.tokens.has(token)) {
      const playerId = this.tokens.get(token)!;
      if (this.controller.seatOf(playerId) !== null) {
        connection.playerId = playerId;
        connection.token = token;
        youId = playerId;
        this.controller.setConnected(playerId, true, Date.now());
      } else {
        this.tokens.delete(token); // the seat was swept; the token is spent
      }
    }

    connection.greeted = true;
    this.send(connection, {
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      roomCode: this.code,
      youId,
      config: this.configView,
      serverTime: Date.now(),
    });
    if (youId) {
      this.send(connection, { t: "seated", playerId: youId, token: connection.token!, seat: this.controller.seatOf(youId)! });
    }
    this.sendState(connection);
    this.broadcast();
  }

  private onSit(connection: Connection, name?: string) {
    if (connection.playerId) {
      this.send(connection, { t: "error", code: "ALREADY_SEATED", message: "You already have a seat" });
      return;
    }
    const requested = (name ?? connection.name ?? "").trim().slice(0, 24);
    const result = this.controller.sit(requested, Date.now());
    // `=== false` rather than `!result.ok`: this project compiles without
    // strictNullChecks, where truthiness does not narrow a boolean-literal union.
    if (result.ok === false) {
      this.send(connection, { t: "error", code: result.error, message: "No free seat at this table" });
      return;
    }
    const token = randomUUID();
    this.tokens.set(token, result.playerId);
    connection.playerId = result.playerId;
    connection.token = token;
    connection.name = requested;
    this.send(connection, { t: "seated", playerId: result.playerId, token, seat: result.seat });
    this.sendState(connection);
    this.broadcast();
  }

  private onReady(connection: Connection) {
    if (!connection.playerId) {
      this.send(connection, { t: "error", code: "NOT_SEATED", message: "Take a seat first" });
      return;
    }
    this.controller.ready(connection.playerId, Date.now());
    this.broadcast();
  }

  private onAction(
    connection: Connection,
    actionId: string,
    action: "fold" | "check" | "call" | "raise",
    amount?: number
  ) {
    if (!connection.playerId) {
      this.send(connection, { t: "error", code: "NOT_SEATED", message: "Take a seat first", actionId });
      return;
    }
    const result = this.controller.act(connection.playerId, action, amount, Date.now());
    if (result.ok === false) {
      this.send(connection, {
        t: "error",
        code: result.error,
        message: this.explain(result.error),
        actionId,
      });
      // Re-send the current view so a desynced client can resync immediately.
      this.sendState(connection);
      return;
    }
    this.broadcast();
  }

  private onLeave(connection: Connection) {
    if (!connection.playerId) return;
    const playerId = connection.playerId;
    this.controller.leave(playerId, Date.now());
    if (connection.token) this.tokens.delete(connection.token);
    connection.playerId = null;
    connection.token = null;
    this.send(connection, { t: "state", view: this.controller.viewFor(null, Date.now()) });
    this.broadcast();
  }

  private explain(code: string): string {
    switch (code) {
      case "NOT_YOUR_TURN":
        return "It is not your turn";
      case "CANNOT_CHECK":
        return "There is a bet to you; call, raise or fold";
      case "NOTHING_TO_CALL":
        return "Nothing to call; check instead";
      case "CANNOT_RAISE":
        return "You cannot raise with this stack";
      case "BAD_ACTION":
        return "That bet size is not allowed";
      case "HAND_OVER":
        return "The hand is over";
      default:
        return "Action refused";
    }
  }

  // --------------------------------------------------------------- plumbing

  private pump() {
    if (this.controller.tick(Date.now())) this.broadcast();
  }

  private broadcast() {
    const now = Date.now();
    const seq = this.controller.seq;
    if (seq === this.lastBroadcastSeq) return;
    this.lastBroadcastSeq = seq;
    this.connections.forEach((connection) => this.sendState(connection, now));
  }

  private sendState(connection: Connection, now = Date.now()) {
    // The redaction boundary: each socket gets the view for its own seat only.
    const view = this.controller.viewFor(connection.playerId, now);
    this.send(connection, { t: "state", view });
  }

  private send(connection: Connection, message: ServerMessage) {
    if (connection.socket.readyState !== 1) return; // 1 === OPEN
    connection.socket.send(encode(message));
  }
}

const decodeSafely = (raw: string): ClientMessage | null => decode(raw);
