// The wire contract between the game server and the browser client.
//
// This file must stay dependency-free and browser-safe: it is imported by both
// the Node server bundle and the Vite client bundle. No `ws`, no `fs`, no
// `node:` imports anywhere below.

import type { TableView } from "../services/tableController";

export const PROTOCOL_VERSION = 1;

export const DEFAULT_ROOM_CODE = "FRIENDS";
export const ROOM_CODE_PATTERN = /^[A-Z0-9]{3,12}$/;

export const normalizeRoomCode = (raw: string | null | undefined): string => {
  const code = (raw ?? "").trim().toUpperCase();
  return ROOM_CODE_PATTERN.test(code) ? code : DEFAULT_ROOM_CODE;
};

export interface RoomConfigView {
  roomCode: string;
  bigBlind: number;
  startingStack: number;
  maxSeats: number;
  turnMs: number;
}

export type ClientMessage =
  | { t: "hello"; token?: string; name?: string }
  | { t: "sit"; name?: string }
  | { t: "ready" }
  | { t: "action"; actionId: string; action: "fold" | "check" | "call" | "raise"; amount?: number }
  | { t: "leave" }
  | { t: "ping"; ts: number };

export type ServerMessage =
  | {
      t: "welcome";
      protocol: number;
      roomCode: string;
      youId: string | null;
      config: RoomConfigView;
      serverTime: number;
    }
  | { t: "seated"; playerId: string; token: string; seat: number }
  | { t: "state"; view: TableView }
  | { t: "error"; code: string; message: string; actionId?: string }
  | { t: "pong"; ts: number; serverTime: number };

export const encode = (message: ServerMessage): string => JSON.stringify(message);

/** Parses an inbound frame, returning null for anything malformed. */
export const decode = (raw: string): ClientMessage | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const message = parsed as { t?: unknown };
  if (typeof message.t !== "string") return null;
  switch (message.t) {
    case "hello":
    case "sit":
    case "ready":
    case "leave":
    case "ping":
    case "action":
      return parsed as ClientMessage;
    default:
      return null;
  }
};

export const clientUrl = (base: string, roomCode: string): string => {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/ws?code=${encodeURIComponent(roomCode)}`;
};
