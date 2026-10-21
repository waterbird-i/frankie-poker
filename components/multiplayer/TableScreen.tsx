// The multiplayer table page: one room, up to `maxSeats` players, drawn from
// the redacted `TableView` the server sends. Nothing on this screen is guessed:
// the buttons exist because `view.legal` says they do, and every card that is
// face-up is face-up because the server sent it that way.
//
// ── Design contract ────────────────────────────────────────────────────────
// Mission: sit down fast on a phone, always know whose turn it is and what it
// costs, and never misread a pot.
//
// Colour is state, never decoration:
//   live  #66edbd → the seat that is acting now (ring + clock bar)
//   gold  #d4af37 → money and the button (dealer D, hero's own seat, bets)
//   red   #ff6b6b → folded, offline, refused action
//   ink   #f5f5f5 at 100/58/34% → text hierarchy, nothing else
// Type: Inter (the app's body face) for names and controls, Space Mono for
// numbers that change (stacks, bets, pot, clocks) so digits do not jitter.
// Space: Tailwind's 4px scale (gap-1/2/3/4). Radius: 14px pod, 18px panel,
// 999px for chips and the dealer button. Motion: 90–120ms for press/hover,
// 220–260ms spring for arrivals, all of it carrying a state change.
//
// Do: keep the ring's grid tracks fixed and let content reflow inside a slot.
// Do: label fixture-free demo affordances (there are none — this page has no
//     fake data; an unconnected page says so).
// Don't: animate anything that is not a state change; don't hide a layout
//     defect behind overflow clipping; don't use transition: all.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlayingCard } from "../PlayingCard";
import { GamePhase } from "../../types";
import type { Card, PlayerAction } from "../../types";
import { PROTOCOL_VERSION } from "../../server/protocol";
import type { LegalActions, SeatView, TableView } from "../../services/tableController";
import type { HandResult } from "../../services/pokerEngine";
import {
  TableClient,
  readStoredName,
  roomCodeFromSearch,
  writeStoredName,
} from "../../services/tableClient";
import type { ConnectionStatus, TableWelcome } from "../../services/tableClient";

// ══ Page CSS ══════════════════════════════════════════════════════════════
// The card component depends on a handful of global rules that the main app
// declares inside index.html's inline <style>. This entry page has no such
// block (and must not copy it), so the five rules PlayingCard.tsx actually
// uses are re-declared here verbatim — without them a hidden card would not
// flip and the two faces of every card would paint on top of each other.
// Everything after them is this page's own contract, scoped to .pt-root.
const TABLE_CSS = `
:root {
  --ease-out-expo: cubic-bezier(0.19, 1, 0.22, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* ── card mechanics (mirrors index.html, required by components/PlayingCard) */
@keyframes dealSlide {
  0% { opacity: 0; transform: translateY(120%) scale(0.8) rotateX(45deg); }
  100% { opacity: 1; transform: translateY(0) scale(1) rotateX(0); }
}
.animate-deal { animation: dealSlide 0.6s var(--ease-out-expo) backwards; }
.transform-style-3d { transform-style: preserve-3d; }
.backface-hidden { backface-visibility: hidden; }
.rotate-y-180 { transform: rotateY(180deg); }
.rotate-y-0 { transform: rotateY(0deg); }
.card-back-hatch {
  background: repeating-linear-gradient(135deg, #111 0 0.45em, #fafafa 0.45em 1.25em);
}

.pt-root {
  --pt-ink: #f5f5f5;
  --pt-dim: rgba(245, 245, 245, 0.58);
  --pt-faint: rgba(245, 245, 245, 0.34);
  --pt-edge: rgba(255, 255, 255, 0.10);
  --pt-slab: rgba(9, 18, 14, 0.86);
  --pt-slab-solid: #0d1712;
  --pt-gold: #d4af37;
  --pt-live: #66edbd;
  --pt-danger: #ff6b6b;
  --pt-radius-pod: 14px;
  --pt-radius-panel: 18px;
  --pt-fast: 120ms;
  --pt-base: 220ms;
  --pt-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --pt-out: cubic-bezier(0.19, 1, 0.22, 1);
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--pt-ink);
}

/* ── the ring: five opponent slots around the felt, hero at the bottom.
   Grid areas rather than absolute offsets, so a long name or a six-figure
   stack reflows inside its own slot instead of colliding with its neighbour. */
.pt-ring {
  display: grid;
  grid-template-columns: minmax(160px, 0.8fr) minmax(0, 1.7fr) minmax(160px, 0.8fr);
  grid-template-rows: auto minmax(0, 1fr) auto;
  grid-template-areas:
    "tl tc tr"
    "ml board mr"
    "bl hero br";
  align-items: center;
  justify-items: center;
  gap: 10px 14px;
  padding: 14px;
  position: relative;
  isolation: isolate;
}
.pt-slot-tl { grid-area: tl; }
.pt-slot-tc { grid-area: tc; }
.pt-slot-tr { grid-area: tr; }
.pt-slot-ml { grid-area: ml; }
.pt-slot-mr { grid-area: mr; }
.pt-slot-bl { grid-area: bl; }
.pt-slot-br { grid-area: br; }
.pt-slot-board { grid-area: board; }
.pt-slot-hero { grid-area: hero; }

/* The felt is behind the seats, not a panel among them. */
.pt-felt {
  position: absolute;
  inset: 3% 0;
  z-index: -1;
  border-radius: 50% / 40%;
  background: radial-gradient(circle at 50% 44%, #35654d 0%, #13251d 74%);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06), 0 24px 70px rgba(0, 0, 0, 0.55);
}

/* ── seat pods */
.pt-pod {
  border-radius: var(--pt-radius-pod);
  background: var(--pt-slab);
  box-shadow: 0 0 0 1px var(--pt-edge);
  transition: box-shadow var(--pt-fast) ease, opacity var(--pt-base) var(--pt-out);
}
.pt-pod[data-you="true"] { background: #101b16; box-shadow: 0 0 0 1px rgba(212, 175, 55, 0.35); }
.pt-pod[data-turn="true"] {
  box-shadow: 0 0 0 1px rgba(102, 237, 189, 0.6), 0 0 0 5px rgba(102, 237, 189, 0.10);
}
.pt-pod[data-quiet="true"] { opacity: 0.5; }
.pt-pod[data-away="true"] { opacity: 0.62; }
.pt-pod[data-empty="true"] {
  background: transparent;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
  border-radius: var(--pt-radius-pod);
}

/* ── controls: immediate feedback, never a delayed one */
.pt-btn {
  transition: background-color var(--pt-fast) ease, color var(--pt-fast) ease,
    box-shadow var(--pt-fast) ease, transform 90ms var(--pt-out);
}
.pt-btn:active:not(:disabled) { transform: translateY(1px); }
.pt-btn:focus-visible { outline: 2px solid #ffffff; outline-offset: 2px; }
.pt-btn:disabled { opacity: 0.36; cursor: not-allowed; }

.pt-field {
  background: rgba(0, 0, 0, 0.4);
  box-shadow: inset 0 0 0 1px var(--pt-edge);
  transition: box-shadow var(--pt-fast) ease;
}
.pt-field:focus-visible { outline: none; box-shadow: inset 0 0 0 1.5px var(--pt-gold); }

/* The turn clock is a quantity, not a mood: a bar is the honest shape, and it
   is the one thing on this page allowed to move at a constant rate. */
.pt-clock { transition: width 250ms linear, background-color 200ms ease; }

/* ── arrivals: seats assemble with a short stagger, results rise */
@keyframes pt-seat-in {
  from { opacity: 0; transform: translateY(6px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
.pt-seat-in { animation: pt-seat-in 260ms var(--pt-out) both; }

@keyframes pt-rise {
  from { opacity: 0; transform: translateY(5px); }
  to { opacity: 1; transform: none; }
}
.pt-rise { animation: pt-rise 220ms var(--pt-out) both; }

/* ── card sizing: each row sizes its own cards from its own width, so five
   community cards can never push the felt wider than its column. */
.pt-card-row { container-type: inline-size; width: 100%; }
.pt-card-board { font-size: min(calc((100cqw - 40px) / 50), 14px); }
.pt-card-hero { font-size: min(calc((100cqw - 20px) / 20), 13px); }
.pt-card-opp { font-size: min(calc((100cqw - 12px) / 20), 5px); }

.pt-placeholder {
  width: 10em;
  height: 14em;
  flex: none;
  border-radius: 1.8em;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.07);
  background: rgba(0, 0, 0, 0.16);
}

.pt-scroll { scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.18) transparent; }

@media (prefers-reduced-motion: reduce) {
  .pt-seat-in, .pt-rise, .animate-deal { animation: none; }
  .pt-clock { transition: none; }
  .pt-btn:active:not(:disabled) { transform: none; }
}
`;

// ══ small helpers ═════════════════════════════════════════════════════════

const useMinWidth = (query: string): boolean => {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches
  );
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const formatChips = (amount: number): string => `$${Math.round(amount).toLocaleString("en-US")}`;

const PHASE_LABEL: Record<GamePhase, string> = {
  [GamePhase.PRE_FLOP]: "Pre-flop",
  [GamePhase.FLOP]: "Flop",
  [GamePhase.TURN]: "Turn",
  [GamePhase.RIVER]: "River",
  [GamePhase.SHOWDOWN]: "Showdown",
};

const STATUS_LABEL: Record<PlayerAction, string> = {
  WAITING: "Waiting",
  THINKING: "Thinking",
  ACTING: "Acting",
  FOLDED: "Folded",
  CHECKED: "Checked",
  CALLED: "Called",
  RAISED: "Raised",
  "ALL-IN": "All-in",
  ELIMINATED: "Out",
};

const statusTone = (status: PlayerAction): string => {
  if (status === "FOLDED" || status === "ELIMINATED") return "text-[var(--pt-danger)]";
  if (status === "ALL-IN") return "text-[var(--pt-gold)]";
  if (status === "RAISED" || status === "CALLED" || status === "CHECKED") return "text-[var(--pt-live)]";
  return "text-[var(--pt-faint)]";
};

const connectionCopy = (status: ConnectionStatus): { label: string; dot: string; text: string } => {
  switch (status) {
    case "online":
      return { label: "Connected", dot: "bg-[var(--pt-live)]", text: "text-[var(--pt-live)]" };
    case "reconnecting":
      return { label: "Reconnecting…", dot: "bg-[var(--pt-gold)]", text: "text-[var(--pt-gold)]" };
    case "offline":
      return { label: "Offline — retrying", dot: "bg-[var(--pt-danger)]", text: "text-[var(--pt-danger)]" };
    default:
      return { label: "Connecting…", dot: "bg-[var(--pt-gold)]", text: "text-[var(--pt-dim)]" };
  }
};

/** "Opponents Folded" is the engine's phrase for a pot nobody contested. */
const handLabel = (description: string): string =>
  !description ? "" : description === "Opponents Folded" ? "all opponents folded" : description;

const RING_SLOTS = ["tc", "ml", "mr", "tl", "tr", "bl", "br"] as const;

interface SlotOccupant {
  seatIndex: number;
  seat: SeatView | null;
}

// ══ pieces ════════════════════════════════════════════════════════════════

const EmptySeat: React.FC<{ index: number; compact: boolean }> = ({ index, compact }) => (
  <div
    className={`pt-pod pt-seat-in flex items-center justify-center text-[11px] text-[var(--pt-faint)] ${
      compact ? "w-full max-w-[168px] px-3 py-3" : "w-full max-w-[168px] px-3 py-4"
    }`}
    data-empty="true"
    style={{ animationDelay: `${index * 40}ms` }}
  >
    <span className="tracking-[0.16em] uppercase">Empty seat</span>
  </div>
);

interface SeatPodProps {
  seat: SeatView;
  index: number;
  isYou: boolean;
  compact: boolean;
  turnRemaining: number | null;
  turnFraction: number;
  handOver: boolean;
  result: HandResult | null;
  winningCardIds: Set<string>;
  winnerIds: Set<string>;
}

const SeatPod: React.FC<SeatPodProps> = ({
  seat,
  index,
  isYou,
  compact,
  turnRemaining,
  turnFraction,
  handOver,
  result,
  winningCardIds,
  winnerIds,
}) => {
  const quiet = seat.status === "FOLDED" || seat.status === "ELIMINATED";
  const away = !seat.connected;
  const revealed = seat.hand !== null;
  const cards: Card[] = revealed ? seat.hand! : [];
  const backCount = Math.min(seat.handCount, 2);
  const slots = revealed ? cards.length : backCount;
  const isWinner = winnerIds.has(seat.playerId);
  const cardClass = isYou ? "pt-card-hero" : "pt-card-opp";

  return (
    <div
      className={`pt-pod pt-seat-in relative flex flex-col gap-1.5 px-2.5 py-2 ${
        compact ? "w-full max-w-[168px]" : isYou ? "w-full max-w-[340px]" : "w-full max-w-[168px]"
      }`}
      data-you={isYou ? "true" : undefined}
      data-turn={seat.isActive ? "true" : undefined}
      data-quiet={quiet ? "true" : undefined}
      data-away={away && !quiet ? "true" : undefined}
      style={{ animationDelay: `${index * 45}ms` }}
    >
      {/* dealer button + name + stack */}
      <div className="flex items-center gap-1.5 min-w-0">
        {seat.isDealer ? (
          <span
            className="grid h-4 w-4 flex-none place-items-center rounded-full bg-[var(--pt-gold)] text-[9px] font-bold text-[#171408]"
            title="Dealer button"
            aria-label="Dealer button"
          >
            D
          </span>
        ) : null}
        <span className={`truncate text-[12.5px] ${isYou ? "font-semibold" : ""}`} title={seat.name}>
          {seat.name}
        </span>
        {isYou ? (
          <span className="flex-none rounded-full bg-[rgba(212,175,55,0.16)] px-1.5 text-[9.5px] font-medium tracking-[0.08em] text-[var(--pt-gold)] uppercase">
            You
          </span>
        ) : null}
        {away ? (
          <span className="flex-none text-[10px] text-[var(--pt-danger)]" title="Disconnected">
            ⚡
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-2 min-w-0">
        <span className="font-mono text-[12px] text-[var(--pt-dim)]">{formatChips(seat.chips)}</span>
        {seat.position && !isYou ? (
          <span className="text-[10px] tracking-[0.1em] text-[var(--pt-faint)] uppercase">{seat.position}</span>
        ) : null}
      </div>

      {/* cards */}
      <div className={`pt-card-row flex items-center justify-center gap-1 ${isYou ? "pt-0.5" : ""}`}>
        {slots > 0
          ? Array.from({ length: slots }).map((_, cardIndex) =>
              revealed ? (
                <PlayingCard
                  key={cards[cardIndex]?.id ?? cardIndex}
                  card={cards[cardIndex]}
                  size="inherit"
                  className={cardClass}
                  dimmed={handOver && result !== null && !isWinner}
                  isWinning={winningCardIds.has(cards[cardIndex]?.id ?? "")}
                />
              ) : (
                <PlayingCard key={`back-${cardIndex}`} hidden size="inherit" className={cardClass} />
              )
            )
          : Array.from({ length: 2 }).map((_, cardIndex) => (
              <div key={`slot-${cardIndex}`} className={`pt-placeholder ${cardClass}`} />
            ))}
      </div>

      {/* state line: what this seat did, what it is holding back */}
      <div className="flex items-center justify-between gap-1 min-w-0">
        <span className={`truncate text-[10.5px] tracking-[0.06em] uppercase ${statusTone(seat.status)}`}>
          {STATUS_LABEL[seat.status]}
          {seat.status === "WAITING" && !seat.ready ? " · not ready" : ""}
        </span>
        {seat.currentBet > 0 ? (
          <span className="flex-none rounded-full bg-[rgba(212,175,55,0.14)] px-1.5 font-mono text-[11px] text-[var(--pt-gold)]">
            {formatChips(seat.currentBet)}
          </span>
        ) : null}
      </div>

      {/* this seat's own clock, so you can see an opponent's time run out */}
      {seat.isActive && turnRemaining !== null ? (
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="pt-clock h-full rounded-full"
            style={{
              width: `${Math.round(turnFraction * 100)}%`,
              backgroundColor: turnFraction < 0.2 ? "var(--pt-danger)" : "var(--pt-live)",
            }}
          />
        </div>
      ) : null}
    </div>
  );
};

const BoardPanel: React.FC<{ view: TableView; compact: boolean; winningCardIds: Set<string> }> = ({
  view,
  compact,
  winningCardIds,
}) => {
  const pot = view.handOver && view.result ? view.result.potTotal : view.pot;
  return (
    <div className={`flex w-full flex-col items-center ${compact ? "gap-2 py-1" : "gap-3"}`}>
      <div className="flex items-center gap-2 text-[11px] tracking-[0.16em] uppercase">
        <span className="rounded-full bg-white/8 px-2 py-0.5 text-[var(--pt-dim)]">
          {PHASE_LABEL[view.phase]}
        </span>
        <span className="text-[var(--pt-faint)]">Hand {view.handNumber}</span>
      </div>

      <div className="pt-card-row flex items-center justify-center gap-2">
        {Array.from({ length: 5 }).map((_, index) => {
          const card = view.board[index];
          return card ? (
            <PlayingCard
              key={card.id}
              card={card}
              size="inherit"
              className="pt-card-board"
              isWinning={winningCardIds.has(card.id)}
            />
          ) : (
            <div key={`board-slot-${index}`} className="pt-placeholder pt-card-board" />
          );
        })}
      </div>

      <div className="flex flex-col items-center gap-0.5">
        <span className="text-[10.5px] tracking-[0.2em] text-[var(--pt-faint)] uppercase">
          {view.handOver ? "Pot awarded" : "Pot"}
        </span>
        <span className="font-mono text-[26px] leading-none text-[var(--pt-gold)]">
          {formatChips(pot)}
        </span>
      </div>
    </div>
  );
};

const ResultPanel: React.FC<{ view: TableView; nameOf: (playerId: string) => string; youId: string | null }> = ({
  view,
  nameOf,
  youId,
}) => {
  const result = view.result;
  if (!result || result.payouts.length === 0) return null;
  return (
    <div className="pt-rise flex w-full max-w-[420px] flex-col gap-1 rounded-[var(--pt-radius-panel)] bg-black/35 px-3 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
      <span className="text-[10.5px] tracking-[0.16em] text-[var(--pt-faint)] uppercase">
        {result.showdown ? "Showdown" : "No showdown"}
      </span>
      {result.payouts.map((payout) => (
        <div
          key={`${payout.playerId}-${payout.potDescription}`}
          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]"
        >
          <span className={payout.playerId === youId ? "font-semibold text-[var(--pt-gold)]" : ""}>
            {payout.playerId === youId ? "You" : nameOf(payout.playerId)}
          </span>
          <span className="text-[var(--pt-dim)]">win{payout.playerId === youId ? "" : "s"}</span>
          <span className="font-mono text-[var(--pt-ink)]">{formatChips(payout.amount)}</span>
          <span className="text-[var(--pt-dim)]">· {handLabel(payout.winningHandName)}</span>
          {result.payouts.length > 1 ? (
            <span className="text-[11px] text-[var(--pt-faint)]">{payout.potDescription}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
};

const LogPanel: React.FC<{ view: TableView | null; lines: number; title?: string }> = ({ view, lines, title }) => {
  const recent = view !== null ? view.handHistory.slice(-lines) : [];
  return (
    <div className="flex min-h-0 flex-col gap-1.5">
      {title ? (
        <span className="text-[10.5px] tracking-[0.16em] text-[var(--pt-faint)] uppercase">{title}</span>
      ) : null}
      {recent.length === 0 ? (
        <span className="text-[11.5px] text-[var(--pt-faint)]">No action yet this hand.</span>
      ) : (
        recent.map((line, index) => (
          <span
            key={`${index}-${line}`}
            className="font-mono text-[11px] leading-snug text-[var(--pt-dim)]"
            style={{ opacity: 0.55 + (0.45 * (index + 1)) / recent.length }}
          >
            {line}
          </span>
        ))
      )}
    </div>
  );
};

const SitPanel: React.FC<{
  name: string;
  onName: (value: string) => void;
  onSit: () => void;
  canSit: boolean;
  seatsLeft: number;
  bigBlind: number;
  startingStack: number;
}> = ({ name, onName, onSit, canSit, seatsLeft, bigBlind, startingStack }) => (
  <div className="pt-pod pt-rise flex w-full max-w-[360px] flex-col gap-2.5 px-3 py-3">
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[12px] tracking-[0.14em] text-[var(--pt-faint)] uppercase">Take a seat</span>
      <span className="font-mono text-[11px] text-[var(--pt-dim)]">
        {seatsLeft} open · {formatChips(bigBlind)} BB · {formatChips(startingStack)} buy-in
      </span>
    </div>
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSit();
      }}
    >
      <label className="sr-only" htmlFor="pt-sit-name">
        Your name
      </label>
      <input
        id="pt-sit-name"
        className="pt-field min-w-0 flex-1 rounded-[10px] px-3 py-2 text-[14px] text-[var(--pt-ink)] outline-none placeholder:text-[var(--pt-faint)]"
        value={name}
        maxLength={24}
        placeholder="Your name"
        autoComplete="nickname"
        onChange={(event) => onName(event.target.value)}
      />
      <button
        type="submit"
        className="pt-btn flex-none rounded-[10px] bg-[var(--pt-gold)] px-4 py-2 text-[13.5px] font-semibold text-[#171408] hover:bg-[#e3c353]"
        disabled={!canSit}
      >
        Sit down
      </button>
    </form>
  </div>
);

const ActionBar: React.FC<{
  view: TableView | null;
  legal: LegalActions | null;
  youName: string;
  activeName: string;
  turnRemaining: number | null;
  turnFraction: number;
  nextHandRemaining: number | null;
  pendingAction: string | null;
  online: boolean;
  seated: boolean;
  ready: boolean;
  raiseTo: number;
  raiseText: string;
  onRaiseText: (value: string) => void;
  onRaiseCommit: () => void;
  onRaiseQuick: (value: number) => void;
  onReady: () => void;
  onSubmit: (action: "fold" | "check" | "call" | "raise", amount?: number) => void;
}> = ({
  view,
  legal,
  youName,
  activeName,
  turnRemaining,
  turnFraction,
  nextHandRemaining,
  pendingAction,
  online,
  seated,
  ready,
  raiseTo,
  raiseText,
  onRaiseText,
  onRaiseCommit,
  onRaiseQuick,
  onReady,
  onSubmit,
}) => {
  const handOver = view !== null && view.handOver === true;
  const busy = pendingAction !== null;
  const locked = !online || busy || legal === null;
  const min = legal && legal.minRaiseTo !== null ? legal.minRaiseTo : 0;
  const max = legal && legal.maxRaiseTo !== null ? legal.maxRaiseTo : 0;
  const potForHalf = view ? view.pot : 0;
  const toCall = legal ? legal.callAmount : 0;
  const youBet = view && view.youSeat !== null ? view.seats[view.youSeat]?.currentBet ?? 0 : 0;
  // Half-pot raise-to: call first, then half of the pot that call creates.
  // Clamped into what the server said is legal — the server is the authority.
  const halfPotTo = clamp(Math.round(youBet + toCall + 0.5 * (potForHalf + toCall)), min, max);

  let headline = "Waiting for the first hand";
  let headlineTone = "text-[var(--pt-dim)]";
  if (!online) {
    headline = "Not connected — actions are disabled";
    headlineTone = "text-[var(--pt-danger)]";
  } else if (!seated) {
    headline = "Take a seat to join the table";
  } else if (handOver) {
    // `handOver` is also true before the first deal of a fresh table, which is
    // not a result — it is a table waiting for two ready stacks.
    headline =
      view !== null && view.handNumber === 0
        ? ready
          ? "Ready — the first hand deals when two players are ready"
          : "Press Ready to join the first hand"
        : nextHandRemaining !== null
          ? `Next hand in ${Math.ceil(nextHandRemaining / 1000)}s`
          : "Hand over";
    headlineTone = "text-[var(--pt-dim)]";
  } else if (legal !== null) {
    headline = "Your turn";
    headlineTone = "text-[var(--pt-live)]";
  } else if (activeName) {
    headline = `Waiting for ${activeName}`;
  }

  return (
    <div className="flex flex-col gap-2 rounded-[var(--pt-radius-panel)] bg-[rgba(5,12,9,0.82)] px-3 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] backdrop-blur-sm">
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[12.5px] ${headlineTone}`}>{headline}</span>
        {legal !== null && turnRemaining !== null ? (
          <span className="font-mono text-[12.5px] text-[var(--pt-live)]">
            {Math.ceil(turnRemaining / 1000)}s
          </span>
        ) : null}
        {seated && !ready && legal === null ? (
          <button
            type="button"
            className="pt-btn flex-none rounded-[10px] bg-[var(--pt-live)] px-3.5 py-1.5 text-[13px] font-semibold text-[#08201a] hover:bg-[#8ff5cf]"
            onClick={onReady}
            disabled={!online}
          >
            Ready
          </button>
        ) : null}
      </div>

      {/* your own clock, full width: the one number that decides the hand */}
      {legal !== null && turnRemaining !== null ? (
        <div className="h-[5px] w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="pt-clock h-full rounded-full"
            style={{
              width: `${Math.round(turnFraction * 100)}%`,
              backgroundColor: turnFraction < 0.2 ? "var(--pt-danger)" : "var(--pt-live)",
            }}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-stretch gap-2">
        <button
          type="button"
          className="pt-btn min-w-[84px] flex-1 rounded-[12px] bg-[rgba(255,107,107,0.14)] px-3 py-3 text-[14px] font-medium text-[var(--pt-danger)] shadow-[inset_0_0_0_1px_rgba(255,107,107,0.35)] hover:bg-[rgba(255,107,107,0.22)]"
          onClick={() => onSubmit("fold")}
          disabled={locked || legal === null || legal.fold !== true}
        >
          {pendingAction === "fold" ? "Folding…" : "Fold"}
        </button>

        {legal && legal.check === true ? (
          <button
            type="button"
            className="pt-btn min-w-[96px] flex-1 rounded-[12px] bg-[rgba(102,237,189,0.14)] px-3 py-3 text-[14px] font-semibold text-[var(--pt-live)] shadow-[inset_0_0_0_1px_rgba(102,237,189,0.4)] hover:bg-[rgba(102,237,189,0.22)]"
            onClick={() => onSubmit("check")}
            disabled={locked}
          >
            {pendingAction === "check" ? "Checking…" : "Check"}
          </button>
        ) : null}

        {legal && legal.call === true ? (
          <button
            type="button"
            className="pt-btn min-w-[120px] flex-1 rounded-[12px] bg-[rgba(102,237,189,0.14)] px-3 py-3 text-[14px] font-semibold text-[var(--pt-live)] shadow-[inset_0_0_0_1px_rgba(102,237,189,0.4)] hover:bg-[rgba(102,237,189,0.22)]"
            onClick={() => onSubmit("call")}
            disabled={locked}
          >
            {pendingAction === "call" ? "Calling…" : `Call ${formatChips(legal.callAmount)}`}
          </button>
        ) : null}

        {legal && legal.raise === true ? (
          <button
            type="button"
            className="pt-btn min-w-[120px] flex-1 rounded-[12px] bg-[rgba(212,175,55,0.16)] px-3 py-3 text-[14px] font-semibold text-[var(--pt-gold)] shadow-[inset_0_0_0_1px_rgba(212,175,55,0.45)] hover:bg-[rgba(212,175,55,0.24)]"
            onClick={() => onSubmit("raise", raiseTo)}
            disabled={locked}
          >
            {pendingAction === "raise"
              ? "Raising…"
              : raiseTo >= max
                ? `All-in ${formatChips(max)}`
                : `Raise to ${formatChips(raiseTo)}`}
          </button>
        ) : null}
      </div>

      {legal && legal.raise === true ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              type="range"
              className="h-6 min-w-0 flex-1"
              style={{ accentColor: "var(--pt-gold)" }}
              min={min}
              max={max}
              step={1}
              value={raiseTo}
              aria-label="Raise amount"
              onChange={(event) => onRaiseQuick(Number(event.target.value))}
            />
            <input
              type="number"
              className="pt-field w-[104px] flex-none rounded-[10px] px-2 py-1.5 text-right font-mono text-[13.5px] text-[var(--pt-ink)] outline-none"
              min={min}
              max={max}
              step={1}
              value={raiseText}
              aria-label="Raise to"
              onChange={(event) => onRaiseText(event.target.value)}
              onBlur={onRaiseCommit}
              onKeyDown={(event) => {
                if (event.key === "Enter") onRaiseCommit();
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="pt-btn flex-1 rounded-[10px] bg-white/6 px-2 py-2.5 text-[12px] text-[var(--pt-dim)] hover:bg-white/12"
              onClick={() => onRaiseQuick(min)}
              disabled={locked}
            >
              Min {formatChips(min)}
            </button>
            <button
              type="button"
              className="pt-btn flex-1 rounded-[10px] bg-white/6 px-2 py-2.5 text-[12px] text-[var(--pt-dim)] hover:bg-white/12"
              onClick={() => onRaiseQuick(halfPotTo)}
              disabled={locked}
            >
              Half pot {formatChips(halfPotTo)}
            </button>
            <button
              type="button"
              className="pt-btn flex-1 rounded-[10px] bg-white/6 px-2 py-2.5 text-[12px] text-[var(--pt-dim)] hover:bg-white/12"
              onClick={() => onRaiseQuick(max)}
              disabled={locked}
            >
              All-in {formatChips(max)}
            </button>
          </div>
        </div>
      ) : null}

      <p className="text-[10.5px] leading-relaxed text-[var(--pt-faint)]">
        {seated ? (
          <>
            <kbd className="font-mono">F</kbd> fold · <kbd className="font-mono">C</kbd> check/call ·{" "}
            <kbd className="font-mono">R</kbd> min raise
          </>
        ) : (
          <>Seat {youName ? youName : "a player"}, then press Ready to start the first hand.</>
        )}
      </p>
    </div>
  );
};

// ══ the screen ════════════════════════════════════════════════════════════

export const TableScreen: React.FC = () => {
  const roomCode = useMemo(() => roomCodeFromSearch(window.location.search), []);
  const wide = useMinWidth("(min-width: 1100px)");

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [welcome, setWelcome] = useState<TableWelcome | null>(null);
  const [view, setView] = useState<TableView | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [nextHandDeadline, setNextHandDeadline] = useState<number | null>(null);
  const [clock, setClock] = useState<number>(() => Date.now());
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const [name, setName] = useState<string>(() => readStoredName());
  const [raiseTo, setRaiseTo] = useState<number>(0);
  const [raiseText, setRaiseText] = useState<string>("0");
  const [pending, setPending] = useState<{ id: string; action: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const clientRef = useRef<TableClient | null>(null);
  const toastSeq = useRef(0);

  const notify = useCallback((message: string) => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, message });
  }, []);

  // ── transport ──────────────────────────────────────────────────────────
  useEffect(() => {
    const client = new TableClient(roomCode, {
      onStatus: (next) => setStatus(next),
      onWelcome: (message) => setWelcome(message),
      onState: (next) => {
        // Frames can overtake each other across a reconnect; an older view is
        // stale by definition and is dropped.
        setView((previous) => (previous !== null && next.seq < previous.seq ? previous : next));
        // `turnEndsAt - serverTime` is the remaining time at the instant the
        // frame arrived, so it is rebased onto this machine's clock once.
        setDeadline(next.turnEndsAt === null ? null : Date.now() + (next.turnEndsAt - next.serverTime));
        setNextHandDeadline(next.nextHandAt === null ? null : Date.now() + (next.nextHandAt - next.serverTime));
        setPending(null);
      },
      onError: (error) => {
        setPending(null);
        notify(error.message);
      },
    });
    clientRef.current = client;
    client.connect();
    return () => {
      client.dispose();
      clientRef.current = null;
    };
  }, [roomCode, notify]);

  // local clock for the turn bar and the between-hands pause
  useEffect(() => {
    if (deadline === null && nextHandDeadline === null) return;
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [deadline, nextHandDeadline]);

  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  // a pending action is cleared by the next authoritative frame; this is the
  // backstop for a frame that never comes.
  useEffect(() => {
    if (pending === null) return;
    const timer = window.setTimeout(() => setPending(null), 3500);
    return () => window.clearTimeout(timer);
  }, [pending]);

  // ── derived view state ─────────────────────────────────────────────────
  const youSeat = view !== null ? view.youSeat : null;
  const you: SeatView | null = view !== null && youSeat !== null ? view.seats[youSeat] ?? null : null;
  const seated = you !== null;
  const legal: LegalActions | null = view !== null ? view.legal : null;
  const handOver = view !== null && view.handOver === true;
  const online = status === "online";
  const turnMs = welcome && welcome.config.turnMs > 0 ? welcome.config.turnMs : 45_000;

  const turnRemaining = deadline === null ? null : Math.max(0, deadline - clock);
  const turnFraction = turnRemaining === null ? 0 : clamp(turnRemaining / turnMs, 0, 1);
  const nextHandRemaining = nextHandDeadline === null ? null : Math.max(0, nextHandDeadline - clock);

  const names = useMemo(() => {
    const map: Record<string, string> = {};
    view?.seats.forEach((seat) => {
      if (seat) map[seat.playerId] = seat.name;
    });
    return map;
  }, [view]);
  const nameOf = useCallback((playerId: string) => names[playerId] ?? "Player", [names]);

  const result = view !== null ? view.result : null;
  const winningCardIds = useMemo(() => {
    const ids = new Set<string>();
    result?.payouts.forEach((payout) => payout.winningCardIds.forEach((id) => ids.add(id)));
    return ids;
  }, [result]);
  const winnerIds = useMemo(() => {
    const ids = new Set<string>();
    result?.payouts.forEach((payout) => ids.add(payout.playerId));
    return ids;
  }, [result]);

  const activeName =
    view !== null && view.activeSeat !== null ? view.seats[view.activeSeat]?.name ?? "" : "";

  // A new legal set is a new decision: the slider starts at the minimum the
  // server allows, never at a number left over from the previous street.
  const minRaiseTo = legal && legal.minRaiseTo !== null ? legal.minRaiseTo : null;
  const maxRaiseTo = legal && legal.maxRaiseTo !== null ? legal.maxRaiseTo : null;
  useEffect(() => {
    if (minRaiseTo === null) return;
    setRaiseTo(minRaiseTo);
    setRaiseText(String(minRaiseTo));
  }, [minRaiseTo, maxRaiseTo]);

  // ── actions ────────────────────────────────────────────────────────────
  const submit = useCallback(
    (action: "fold" | "check" | "call" | "raise", amount?: number) => {
      const client = clientRef.current;
      if (!client) return;
      const id = client.act(action, amount);
      if (id === null) {
        notify("Not connected — that action was not sent.");
        return;
      }
      setPending({ id, action });
    },
    [notify]
  );

  const sitDown = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    const trimmed = name.trim().slice(0, 24);
    if (trimmed) writeStoredName(trimmed);
    if (!client.sit(trimmed)) notify("Not connected — could not take a seat.");
  }, [name, notify]);

  const copyInvite = useCallback(async () => {
    const url = `${window.location.origin}/table?code=${roomCode}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      notify("Copy was blocked by the browser — select the link and copy it.");
    }
  }, [roomCode, notify]);

  // keyboard: F fold, C check/call, R min raise. Ignored while typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (legal === null || status !== "online" || pending !== null) return;
      const key = event.key.toLowerCase();
      if (key === "f" && legal.fold === true) {
        event.preventDefault();
        submit("fold");
      } else if (key === "c") {
        if (legal.check === true) {
          event.preventDefault();
          submit("check");
        } else if (legal.call === true) {
          event.preventDefault();
          submit("call");
        }
      } else if (key === "r" && legal.raise === true) {
        event.preventDefault();
        submit("raise", raiseTo);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [legal, pending, raiseTo, status, submit]);

  // ── seat placement ─────────────────────────────────────────────────────
  const occupants: SlotOccupant[] = useMemo(() => {
    if (view === null) return [];
    const list: SlotOccupant[] = [];
    for (let index = 0; index < view.maxSeats; index += 1) {
      if (youSeat !== null && index === youSeat) continue;
      list.push({ seatIndex: index, seat: view.seats[index] ?? null });
    }
    return list;
  }, [view, youSeat]);

  const ringOccupants = occupants.slice(0, RING_SLOTS.length);
  const spilled = occupants.slice(RING_SLOTS.length);
  const openSeats = occupants.filter((occupant) => occupant.seat === null).length;

  const inviteUrl = `${typeof window === "undefined" ? "" : window.location.origin}/table?code=${roomCode}`;
  const connection = connectionCopy(status);
  const protocolMismatch = welcome !== null && welcome.protocol !== PROTOCOL_VERSION;

  const renderOccupant = (occupant: SlotOccupant, index: number) =>
    occupant.seat ? (
      <SeatPod
        key={occupant.seatIndex}
        seat={occupant.seat}
        index={index}
        isYou={false}
        compact={!wide}
        turnRemaining={turnRemaining}
        turnFraction={turnFraction}
        handOver={handOver}
        result={result}
        winningCardIds={winningCardIds}
        winnerIds={winnerIds}
      />
    ) : (
      <EmptySeat key={occupant.seatIndex} index={index} compact={!wide} />
    );

  const header = (
    <header className="flex flex-wrap items-center gap-2 rounded-[var(--pt-radius-panel)] bg-[rgba(5,12,9,0.7)] px-3 py-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold tracking-[0.04em]">Frankie Poker</span>
        <span className="rounded-full bg-white/8 px-2 py-0.5 font-mono text-[11.5px] text-[var(--pt-dim)]">
          {welcome !== null ? welcome.roomCode : roomCode}
        </span>
      </div>
      <span className="flex items-center gap-1.5 text-[12px]">
        <span className={`h-2 w-2 rounded-full ${connection.dot}`} aria-hidden="true" />
        <span className={connection.text}>{connection.label}</span>
      </span>
      <span className="ml-auto flex items-center gap-2">
        <span className="hidden font-mono text-[11px] text-[var(--pt-faint)] sm:inline">{inviteUrl}</span>
        <button
          type="button"
          className="pt-btn rounded-[10px] bg-white/8 px-3 py-1.5 text-[12px] text-[var(--pt-ink)] hover:bg-white/16"
          onClick={() => void copyInvite()}
        >
          {copied ? "Link copied" : "Copy invite link"}
        </button>
        {seated ? (
          <button
            type="button"
            className="pt-btn rounded-[10px] bg-white/6 px-3 py-1.5 text-[12px] text-[var(--pt-dim)] hover:bg-white/12 hover:text-[var(--pt-ink)]"
            onClick={() => {
              if (!clientRef.current?.leave()) notify("Not connected — could not leave the seat.");
            }}
            disabled={!online}
          >
            Leave seat
          </button>
        ) : null}
      </span>
    </header>
  );

  const board = view !== null ? (
    <div className="pt-slot-board flex w-full flex-col items-center gap-3">
      <BoardPanel view={view} compact={!wide} winningCardIds={winningCardIds} />
      {handOver ? <ResultPanel view={view} nameOf={nameOf} youId={you?.playerId ?? null} /> : null}
    </div>
  ) : (
    <div className="pt-slot-board flex flex-col items-center gap-2 py-6 text-center">
      <span className="text-[13px] text-[var(--pt-dim)]">
        {status === "online" ? "Waiting for the table…" : "Connecting to the table…"}
      </span>
      <span className="font-mono text-[11.5px] text-[var(--pt-faint)]">Room {roomCode}</span>
    </div>
  );

  const hero = seated ? (
    <SeatPod
      seat={you!}
      index={0}
      isYou
      compact={!wide}
      turnRemaining={turnRemaining}
      turnFraction={turnFraction}
      handOver={handOver}
      result={result}
      winningCardIds={winningCardIds}
      winnerIds={winnerIds}
    />
  ) : (
    <SitPanel
      name={name}
      onName={setName}
      onSit={sitDown}
      canSit={online}
      seatsLeft={view !== null ? openSeats : 0}
      bigBlind={welcome !== null ? welcome.config.bigBlind : 0}
      startingStack={welcome !== null ? welcome.config.startingStack : 0}
    />
  );

  const actionBar = (
    <ActionBar
      view={view}
      legal={legal}
      youName={name}
      activeName={activeName}
      turnRemaining={turnRemaining}
      turnFraction={turnFraction}
      nextHandRemaining={nextHandRemaining}
      pendingAction={pending !== null ? pending.action : null}
      online={online}
      seated={seated}
      ready={you !== null ? you.ready : false}
      raiseTo={raiseTo}
      raiseText={raiseText}
      onRaiseText={(value) => {
        setRaiseText(value);
        const parsed = Number(value);
        if (value.trim() !== "" && Number.isFinite(parsed) && minRaiseTo !== null && maxRaiseTo !== null) {
          setRaiseTo(clamp(Math.floor(parsed), minRaiseTo, maxRaiseTo));
        }
      }}
      onRaiseCommit={() => {
        setRaiseText(String(raiseTo));
      }}
      onRaiseQuick={(value) => {
        setRaiseTo(value);
        setRaiseText(String(value));
      }}
      onReady={() => {
        if (!clientRef.current?.ready()) notify("Not connected — could not ready up.");
      }}
      onSubmit={submit}
    />
  );

  return (
    <div className="pt-root felt-background min-h-[100svh] w-full">
      <style>{TABLE_CSS}</style>

      <div
        className={
          wide
            ? "mx-auto flex min-h-[100svh] w-full max-w-[1760px] flex-col gap-3 p-4"
            : "mx-auto flex min-h-[100svh] w-full max-w-[720px] flex-col gap-3 p-3 pb-[max(12px,env(safe-area-inset-bottom))]"
        }
      >
        {header}

        {protocolMismatch ? (
          <p className="pt-rise rounded-[var(--pt-radius-pod)] bg-[rgba(255,107,107,0.14)] px-3 py-2 text-[12px] text-[var(--pt-danger)] shadow-[inset_0_0_0_1px_rgba(255,107,107,0.3)]">
            This page speaks protocol v{PROTOCOL_VERSION} and the server answered with v
            {welcome!.protocol}. Reload after the deploy finishes; the table below may be stale.
          </p>
        ) : null}

        {toast !== null ? (
          <div
            role="status"
            aria-live="polite"
            className="pt-rise flex items-start gap-2 rounded-[var(--pt-radius-pod)] bg-[rgba(255,107,107,0.16)] px-3 py-2 text-[12.5px] text-[var(--pt-ink)] shadow-[inset_0_0_0_1px_rgba(255,107,107,0.35)]"
          >
            <span aria-hidden="true">⚠</span>
            <span className="min-w-0 flex-1">{toast.message}</span>
            <button
              type="button"
              className="pt-btn flex-none rounded px-1 text-[var(--pt-dim)] hover:text-[var(--pt-ink)]"
              onClick={() => setToast(null)}
              aria-label="Dismiss message"
            >
              ✕
            </button>
          </div>
        ) : null}

        {wide ? (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_280px] gap-4">
            <section className="pt-ring min-h-[520px] min-w-0" aria-label="Table">
              <div className="pt-felt" aria-hidden="true" />
              {RING_SLOTS.map((slot, index) => {
                const occupant = ringOccupants[index];
                return (
                  <div key={slot} className={`pt-slot-${slot} flex w-full justify-center`}>
                    {occupant ? renderOccupant(occupant, index) : null}
                  </div>
                );
              })}
              {board}
              <div className="pt-slot-hero flex w-full justify-center">{hero}</div>
            </section>

            <aside className="flex min-h-0 flex-col gap-3">
              {spilled.length > 0 ? (
                <div className="flex flex-wrap justify-center gap-2">
                  {spilled.map((occupant, index) => renderOccupant(occupant, index + ringOccupants.length))}
                </div>
              ) : null}
              <div className="flex min-h-0 flex-1 flex-col gap-2 rounded-[var(--pt-radius-panel)] bg-[rgba(5,12,9,0.72)] px-3 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
                <LogPanel view={view} lines={14} title="Hand log" />
              </div>
              <div className="flex flex-col gap-1 rounded-[var(--pt-radius-panel)] bg-[rgba(5,12,9,0.72)] px-3 py-3 text-[11.5px] text-[var(--pt-faint)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
                <span>
                  Blinds {formatChips(welcome !== null ? welcome.config.bigBlind / 2 : 0)} /{" "}
                  {formatChips(welcome !== null ? welcome.config.bigBlind : 0)}
                </span>
                <span>
                  {view !== null ? view.seats.filter((seat) => seat !== null).length : 0} of{" "}
                  {view !== null ? view.maxSeats : welcome !== null ? welcome.config.maxSeats : 0} seats taken
                </span>
                <span>
                  Turn clock {Math.round((welcome !== null ? welcome.config.turnMs : 0) / 1000)}s
                </span>
              </div>
            </aside>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {spilled.length > 0 ? (
              <div className="flex flex-wrap justify-center gap-2">
                {spilled.map((occupant, index) => renderOccupant(occupant, index + ringOccupants.length))}
              </div>
            ) : null}

            <section className="flex flex-wrap justify-center gap-2" aria-label="Table">
              {ringOccupants.map((occupant, index) => renderOccupant(occupant, index))}
            </section>

            <section className="flex flex-col items-center gap-2" aria-label="Board">
              {board}
            </section>

            <section className="flex justify-center" aria-label="Your seat">
              {hero}
            </section>

            <div className="rounded-[var(--pt-radius-panel)] bg-[rgba(5,12,9,0.72)] px-3 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
              <LogPanel view={view} lines={4} title="Hand log" />
            </div>
          </div>
        )}

        <div className="sticky bottom-0 z-30 -mx-3 mt-auto px-3 pb-[max(0px,env(safe-area-inset-bottom))]">
          {actionBar}
        </div>
      </div>
    </div>
  );
};

export default TableScreen;
