// P0 of the online plan: a headless, time-injected table controller.
//
// It wraps services/pokerEngine.ts (pure functions, already proven to run in
// Node by `npm run test:local`) and adds the things a live table needs that the
// engine deliberately does not have:
//
//   * seats, names, readiness and connection state
//   * turn deadlines driven by an injected `now` instead of setTimeout, so the
//     exact same logic runs in the browser and in the server process
//   * per-seat redaction: `viewFor(playerId)` never includes another seat's
//     hole cards before showdown, and never includes the deck
//   * auto-fold/check on timeout, and auto-start of the next hand
//
// The controller has no DOM, no network and no timers of its own: callers drive
// it with `tick(now)`. That is what makes it testable and reusable server-side.

import { Card, GamePhase, Player, PlayerAction, Pot } from "../types";
import {
  EngineAction,
  EngineState,
  HandResult,
  applyAction,
  createEngine,
  currentHighBet,
  potTotal,
  startHand as engineStartHand,
  visibleBoard,
} from "./pokerEngine";

export interface TableConfig {
  bigBlind: number;
  startingStack: number;
  maxSeats: number;
  turnMs: number; // thinking time for a connected seat
  disconnectedTurnMs: number; // shorter budget once a seat drops off
  nextHandDelayMs: number; // pause between hands, so results can be read
  seatIdleMs: number; // hold a disconnected seat this long before freeing it
}

export const TABLE_DEFAULTS: TableConfig = {
  bigBlind: 20,
  startingStack: 1000,
  maxSeats: 6,
  turnMs: 45_000,
  disconnectedTurnMs: 5_000,
  nextHandDelayMs: 6_000,
  seatIdleMs: 120_000,
};

export interface LegalActions {
  fold: boolean;
  check: boolean;
  call: boolean;
  callAmount: number;
  raise: boolean;
  minRaiseTo: number | null;
  maxRaiseTo: number | null;
}

// One seat as a specific viewer is allowed to see it. `hand` is null whenever
// the viewer has no right to those cards (this is the whole point).
export interface SeatView {
  seat: number;
  playerId: string;
  name: string;
  chips: number;
  currentBet: number;
  committed: number;
  status: PlayerAction;
  position: string;
  isDealer: boolean;
  isActive: boolean;
  connected: boolean;
  ready: boolean;
  hand: Card[] | null;
  handCount: number;
}

export interface TableView {
  seq: number;
  handNumber: number;
  phase: GamePhase;
  board: Card[];
  pot: number;
  pots: Pot[];
  seats: (SeatView | null)[];
  maxSeats: number;
  bigBlind: number;
  activeSeat: number | null;
  youSeat: number | null;
  toCall: number;
  legal: LegalActions | null;
  turnEndsAt: number | null;
  nextHandAt: number | null;
  handOver: boolean;
  result: HandResult | null;
  handHistory: string[];
  serverTime: number;
}

export type TableError =
  | "TABLE_FULL"
  | "ALREADY_SEATED"
  | "NOT_SEATED"
  | "NOT_YOUR_TURN"
  | "HAND_OVER"
  | "CANNOT_CHECK"
  | "NOTHING_TO_CALL"
  | "CANNOT_RAISE"
  | "BAD_ACTION";

export type ActResult = { ok: true; auto?: boolean } | { ok: false; error: TableError };

interface SeatSlot {
  seat: number;
  playerId: string | null;
  name: string;
  ready: boolean;
  connected: boolean;
  lastSeen: number;
  leaving: boolean;
  pendingStack: number; // granted when the current hand ends
}

const inHand = (p: Player) => p.status !== "FOLDED" && p.status !== "ELIMINATED";
const canAct = (p: Player) => inHand(p) && p.status !== "ALL-IN";

export class TableController {
  readonly config: TableConfig;

  private seats: SeatSlot[];
  private engine: EngineState;
  private nextPlayerNumber = 0;

  private seqCounter = 0;
  private turnEndsAt: number | null = null;
  private nextHandAt: number | null = null;

  constructor(config: Partial<TableConfig> = {}) {
    this.config = { ...TABLE_DEFAULTS, ...config };
    this.seats = Array.from({ length: this.config.maxSeats }, (_, seat) => ({
      seat,
      playerId: null,
      name: "",
      ready: false,
      connected: false,
      lastSeen: 0,
      leaving: false,
      pendingStack: 0,
    }));
    this.engine = createEngine(this.emptyPlayers(), this.config.bigBlind);
  }

  // ---------------------------------------------------------------- roster

  private emptyPlayers(): Player[] {
    return this.seats.map((slot) => ({
      id: slot.playerId ?? `seat-${slot.seat}`,
      name: slot.name || `Seat ${slot.seat + 1}`,
      isHuman: true,
      chips: 0,
      hand: [],
      status: "ELIMINATED" as PlayerAction,
      position: "",
      isDealer: false,
      isActive: false,
      currentBet: 0,
    }));
  }

  get seq() {
    return this.seqCounter;
  }

  private bump() {
    this.seqCounter += 1;
  }

  seatOf(playerId: string): number | null {
    const slot = this.seats.find((s) => s.playerId === playerId);
    return slot ? slot.seat : null;
  }

  playerIdAt(seat: number): string | null {
    return this.seats[seat]?.playerId ?? null;
  }

  seatedPlayerIds(): string[] {
    return this.seats.filter((s) => s.playerId).map((s) => s.playerId!);
  }

  /** Sits a new player at the lowest free seat. Returns their player id. */
  sit(name: string, now: number): { ok: true; playerId: string; seat: number } | { ok: false; error: TableError } {
    const free = this.seats.find((s) => !s.playerId);
    if (!free) return { ok: false, error: "TABLE_FULL" };

    const playerId = `p${++this.nextPlayerNumber}`;
    free.playerId = playerId;
    free.name = name.slice(0, 24) || `Player ${free.seat + 1}`;
    free.ready = false;
    free.connected = true;
    free.lastSeen = now;
    free.leaving = false;

    // A seat can only be filled with chips between hands: dropping a live stack
    // into the engine mid-hand would stall the action round.
    if (this.engine.handOver) {
      this.grantStack(free);
    } else {
      free.pendingStack = this.config.startingStack;
    }
    this.syncRoster();
    this.bump();
    return { ok: true, playerId, seat: free.seat };
  }

  /** Frees the seat immediately when no hand is running, otherwise defers. */
  leave(playerId: string, now: number): boolean {
    const slot = this.seats.find((s) => s.playerId === playerId);
    if (!slot) return false;
    slot.connected = false;
    slot.ready = false;
    slot.lastSeen = now;
    if (this.engine.handOver) {
      this.freeSeat(slot);
    } else {
      slot.leaving = true; // freed in tick() once the hand settles
    }
    this.syncRoster();
    this.bump();
    return true;
  }

  private freeSeat(slot: SeatSlot) {
    slot.playerId = null;
    slot.name = "";
    slot.ready = false;
    slot.connected = false;
    slot.leaving = false;
    slot.pendingStack = 0;
    const p = this.engine.players[slot.seat];
    p.chips = 0;
    p.hand = [];
    p.status = "ELIMINATED";
    p.isActive = false;
    p.currentBet = 0;
    p.isDealer = false;
    p.position = "";
  }

  private grantStack(slot: SeatSlot) {
    const p = this.engine.players[slot.seat];
    p.chips = this.config.startingStack;
    p.hand = [];
    p.status = "WAITING";
    p.isActive = false;
    p.currentBet = 0;
    slot.pendingStack = 0;
  }

  /** Rebuilds the engine player array from the seat slots (index === seat). */
  private syncRoster() {
    this.engine = {
      ...this.engine,
      players: this.engine.players.map((p, seat) => {
        const slot = this.seats[seat];
        if (!slot.playerId) {
          return { ...p, id: `seat-${seat}`, name: `Seat ${seat + 1}`, chips: 0, hand: [], isActive: false, status: "ELIMINATED" as PlayerAction };
        }
        return { ...p, id: slot.playerId, name: slot.name };
      }),
    };
  }

  ready(playerId: string, now: number): boolean {
    const slot = this.seats.find((s) => s.playerId === playerId);
    if (!slot) return false;
    slot.ready = true;
    slot.connected = true;
    slot.lastSeen = now;
    this.bump();
    return true;
  }

  setConnected(playerId: string, connected: boolean, now: number): boolean {
    const slot = this.seats.find((s) => s.playerId === playerId);
    if (!slot) return false;
    slot.connected = connected;
    slot.lastSeen = now;
    if (!connected && this.engine.activePlayerId === playerId) {
      // Don't make the table wait the full thinking time for someone who left.
      const shorter = now + this.config.disconnectedTurnMs;
      this.turnEndsAt = this.turnEndsAt === null ? shorter : Math.min(this.turnEndsAt, shorter);
    }
    this.bump();
    return true;
  }

  // ------------------------------------------------------------- lifecycle

  private readyPlayers(): SeatSlot[] {
    return this.seats.filter((s) => s.playerId && s.ready && !s.leaving && this.engine.players[s.seat].chips > 0);
  }

  canStartHand(): boolean {
    return this.readyPlayers().length >= 2;
  }

  /** Starts a hand. Returns false when the table cannot deal (fewer than 2 ready stacks). */
  startHand(now: number): boolean {
    if (!this.engine.handOver) return false;
    if (!this.canStartHand()) return false;
    this.nextHandAt = null;
    this.engine = engineStartHand(this.engine);
    if (this.engine.handOver) return false; // engine refused: not enough funded seats
    // Everyone who was dealt in stays ready, so the table keeps flowing.
    this.seats.forEach((s) => {
      if (s.playerId) s.ready = true;
    });
    this.afterMutation(now);
    return true;
  }

  act(playerId: string, action: string, amount: number | undefined, now: number): ActResult {
    const slot = this.seats.find((s) => s.playerId === playerId);
    if (!slot) return { ok: false, error: "NOT_SEATED" };
    slot.lastSeen = now;
    return this.applyActionInternal(playerId, action, amount, now, false);
  }

  private applyActionInternal(
    playerId: string,
    action: string,
    amount: number | undefined,
    now: number,
    auto: boolean
  ): ActResult {
    if (this.engine.handOver || !this.engine.activePlayerId) return { ok: false, error: "HAND_OVER" };
    if (this.engine.activePlayerId !== playerId) return { ok: false, error: "NOT_YOUR_TURN" };

    const player = this.engine.players[this.seatOf(playerId) ?? -1];
    if (!player) return { ok: false, error: "NOT_SEATED" };

    const legal = this.legalFor(playerId);
    if (!legal) return { ok: false, error: "HAND_OVER" };

    let engineAction: EngineAction;
    let appliedAmount: number | undefined;

    switch (action) {
      case "fold":
        engineAction = "fold";
        break;
      case "check":
        if (!legal.check) return { ok: false, error: "CANNOT_CHECK" };
        engineAction = "check";
        break;
      case "call":
        if (!legal.call) return { ok: false, error: "NOTHING_TO_CALL" };
        engineAction = "call";
        break;
      case "raise": {
        if (!legal.raise) return { ok: false, error: "CANNOT_RAISE" };
        const min = legal.minRaiseTo!;
        const max = legal.maxRaiseTo!;
        let to = amount ?? min;
        if (!Number.isFinite(to)) return { ok: false, error: "BAD_ACTION" };
        to = Math.floor(to);
        // Over-max is clamped to the all-in total; under-min is refused so a
        // client bug cannot silently create a sub-minimum raise.
        if (to > max) to = max;
        if (to < min) return { ok: false, error: "BAD_ACTION" };
        engineAction = "raise";
        appliedAmount = to;
        break;
      }
      default:
        return { ok: false, error: "BAD_ACTION" };
    }

    const wasActive = this.engine.activePlayerId;
    this.engine = applyAction(this.engine, engineAction, appliedAmount);
    this.afterMutation(now, wasActive);
    return auto ? { ok: true, auto: true } : { ok: true };
  }

  /** Re-arms the turn clock (or the next-hand clock) after the engine moved. */
  private afterMutation(now: number, previousActive?: string | null) {
    this.bump();
    if (this.engine.handOver) {
      this.turnEndsAt = null;
      if (this.nextHandAt === null) this.nextHandAt = now + this.config.nextHandDelayMs;
      return;
    }
    const active = this.engine.activePlayerId;
    if (active && active !== previousActive) {
      const slot = this.seats.find((s) => s.playerId === active);
      const budget = slot && slot.connected ? this.config.turnMs : this.config.disconnectedTurnMs;
      this.turnEndsAt = now + budget;
    } else if (!active) {
      this.turnEndsAt = null;
    }
  }

  /**
   * Advances everything that is driven by the clock: auto-fold/check on a
   * timeout, the pause between hands, granting deferred stacks, and freeing
   * seats whose owner never came back. Returns true when state changed.
   */
  tick(now: number): boolean {
    let changed = false;
    // Bounded: each pass either resolves one pending clock or stops.
    for (let guard = 0; guard < 16; guard++) {
      if (this.engine.handOver) {
        let progressed = false;
        if (this.flushPending()) progressed = true;
        if (this.releaseLeaving()) progressed = true;
        if (this.sweepIdle(now)) progressed = true;
        if (progressed) changed = true;

        if (this.nextHandAt === null) {
          // The very first hand of a fresh table deals straight away; the pause
          // only exists so a settled hand's result can be read before the next.
          this.nextHandAt = now + (this.engine.handNumber === 0 ? 0 : this.config.nextHandDelayMs);
          changed = true;
          continue;
        }
        if (now >= this.nextHandAt && this.canStartHand()) {
          if (this.startHand(now)) {
            changed = true;
            continue;
          }
        }
        break;
      }

      const active = this.engine.activePlayerId;
      if (!active || this.turnEndsAt === null || now < this.turnEndsAt) break;
      const legal = this.legalFor(active);
      if (!legal) break;
      const action = legal.check ? "check" : "fold";
      const result = this.applyActionInternal(active, action, undefined, now, true);
      if (!result.ok) break;
      changed = true;
    }
    return changed;
  }

  private flushPending(): boolean {
    let changed = false;
    this.seats.forEach((slot) => {
      if (slot.playerId && slot.pendingStack > 0) {
        this.grantStack(slot);
        changed = true;
      }
    });
    return changed;
  }

  private releaseLeaving(): boolean {
    let changed = false;
    this.seats.forEach((slot) => {
      if (slot.playerId && slot.leaving) {
        this.freeSeat(slot);
        changed = true;
      }
    });
    return changed;
  }

  private sweepIdle(now: number): boolean {
    let changed = false;
    this.seats.forEach((slot) => {
      if (slot.playerId && !slot.connected && now - slot.lastSeen > this.config.seatIdleMs) {
        this.freeSeat(slot);
        changed = true;
      }
    });
    return changed;
  }

  // ----------------------------------------------------------------- views

  legalFor(playerId: string): LegalActions | null {
    if (this.engine.handOver || this.engine.activePlayerId !== playerId) return null;
    const seat = this.seatOf(playerId);
    if (seat === null) return null;
    const player = this.engine.players[seat];
    const high = currentHighBet(this.engine);
    const toCall = Math.max(0, high - player.currentBet);
    const maxTotal = player.chips + player.currentBet;
    const minRaiseTo = Math.min(high + this.engine.bigBlind, maxTotal);
    const canRaise = player.chips > toCall && maxTotal > high;
    return {
      fold: true,
      check: toCall <= 0,
      call: toCall > 0 && player.chips > 0,
      callAmount: Math.min(toCall, player.chips),
      raise: canRaise,
      minRaiseTo: canRaise ? minRaiseTo : null,
      maxRaiseTo: canRaise ? maxTotal : null,
    };
  }

  /**
   * The redaction boundary. A viewer gets their own hole cards, plus anyone
   * else's only at showdown and only if that player is still contesting the
   * pot. `deck` is never part of any view.
   */
  viewFor(playerId: string | null, now: number): TableView {
    const youSeat = playerId ? this.seatOf(playerId) : null;
    const showdown = this.engine.phase === GamePhase.SHOWDOWN;

    const seats: (SeatView | null)[] = this.seats.map((slot) => {
      if (!slot.playerId) return null;
      const player = this.engine.players[slot.seat];
      const isSelf = playerId !== null && slot.playerId === playerId;
      const maySee = isSelf || (showdown && inHand(player));
      return {
        seat: slot.seat,
        playerId: slot.playerId,
        name: slot.name,
        chips: player.chips,
        currentBet: player.currentBet,
        committed: this.engine.committed[slot.playerId] ?? 0,
        status: player.status,
        position: player.position,
        isDealer: player.isDealer,
        isActive: player.isActive,
        connected: slot.connected,
        ready: slot.ready,
        hand: maySee ? player.hand.map((c) => ({ ...c })) : null,
        handCount: player.hand.length,
      };
    });

    const high = currentHighBet(this.engine);
    const legal = playerId ? this.legalFor(playerId) : null;
    const yourPlayer = youSeat === null ? null : this.engine.players[youSeat];
    const toCall = yourPlayer ? Math.max(0, high - yourPlayer.currentBet) : 0;

    return {
      seq: this.seqCounter,
      handNumber: this.engine.handNumber,
      phase: this.engine.phase,
      board: visibleBoard(this.engine).map((c) => ({ ...c })),
      // Once the hand settles the chips are back in the stacks, so a live pot
      // figure would double-count them. The settled amount lives in result.potTotal.
      pot: this.engine.handOver ? 0 : potTotal(this.engine),
      pots: this.engine.result?.pots ?? [],
      seats,
      maxSeats: this.config.maxSeats,
      bigBlind: this.engine.bigBlind,
      activeSeat: this.engine.activePlayerId ? this.seatOf(this.engine.activePlayerId) : null,
      youSeat,
      toCall,
      legal,
      turnEndsAt: this.turnEndsAt,
      nextHandAt: this.nextHandAt,
      handOver: this.engine.handOver,
      result: this.engine.result,
      handHistory: [...this.engine.handHistory],
      serverTime: now,
    };
  }
}
