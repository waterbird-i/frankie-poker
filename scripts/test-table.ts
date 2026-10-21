// P0 acceptance test for services/tableController.ts
//
// Runs the whole thing headlessly in Node, with no network and no timers: the
// controller is driven by an injected clock. It checks the rules of the table
// (chip conservation, legal-action gating, timeouts, deferred buy-ins) and, most
// importantly, the redaction boundary that the online plan calls out as the
// number one hazard: a viewer must never receive another seat's hole cards
// before showdown, and the deck must never be serialised at all.

import assert from 'node:assert/strict';
import { GamePhase } from '../types';
import { TABLE_DEFAULTS, TableController } from '../services/tableController';

let checks = 0;
const ok = (label: string) => {
  checks += 1;
  console.log(`  ok ${checks} - ${label}`);
};

const totalChips = (controller: TableController, ids: string[], now: number) => {
  // Chips still in stacks, plus the pot while a hand is live. After a hand
  // settles the pot is zero and everything is back in the stacks.
  const view = controller.viewFor(ids[0], now);
  return view.seats.reduce((sum, seat) => sum + (seat ? seat.chips : 0), 0) + view.pot;
};

const FAST = { turnMs: 1_000, disconnectedTurnMs: 200, nextHandDelayMs: 6_000 };

// ---------------------------------------------------------------------------
console.log('tableController: seats, dealing and redaction');

{
  const table = new TableController({ ...FAST, maxSeats: 6, bigBlind: 20, startingStack: 1_000 });
  let clock = 1_000_000;

  const a = table.sit('Alice', clock);
  const b = table.sit('Bob', clock);
  assert.ok(a.ok && b.ok);
  assert.equal(a.seat, 0);
  assert.equal(b.seat, 1);
  ok('two players take the two lowest seats');

  assert.equal(table.canStartHand(), false, 'nobody is ready yet');
  table.ready(a.playerId, clock);
  assert.equal(table.canStartHand(), false, 'one ready player is not enough');
  table.ready(b.playerId, clock);
  assert.equal(table.canStartHand(), true);
  ok('a hand needs two ready players');

  assert.equal(table.startHand(clock), true);
  const viewA = table.viewFor(a.playerId, clock);
  const viewB = table.viewFor(b.playerId, clock);

  assert.equal(viewA.seats[0]!.hand?.length, 2, 'Alice sees her own cards');
  assert.equal(viewA.seats[1]!.hand, null, 'Alice must NOT see Bob cards pre-showdown');
  assert.equal(viewB.seats[0]!.hand, null, 'Bob must NOT see Alice cards pre-showdown');
  assert.equal(viewA.seats[1]!.handCount, 2, 'Alice still learns how many cards Bob holds');
  ok('pre-showdown: own cards visible, opponent cards redacted');

  const wire = JSON.stringify(viewA);
  assert.ok(!wire.includes('"deck"'), 'the deck must never be serialised into a view');
  assert.equal(viewA.board.length, 0, 'no community cards before the flop');
  assert.equal(viewA.phase, GamePhase.PRE_FLOP);
  ok('no deck on the wire, board empty preflop');

  const spectator = table.viewFor(null, clock);
  assert.equal(spectator.seats[0]!.hand, null, 'a spectator sees no hole cards');
  assert.equal(spectator.youSeat, null);
  ok('spectators never see hole cards');

  // Play the hand out by calling/checking whenever possible.
  let guard = 0;
  let sawOpponentCardsEarly = false;
  while (!table.viewFor(a.playerId, clock).handOver && guard++ < 200) {
    const view = table.viewFor(a.playerId, clock);
    const active = view.activeSeat === null ? null : view.seats[view.activeSeat]!;
    const activeId = active.playerId;
    const legal = table.legalFor(activeId)!; // the actor's options, not the viewer's
    if (view.phase !== GamePhase.SHOWDOWN && view.seats[1]!.hand !== null) sawOpponentCardsEarly = true;
    if (legal.check) assert.ok(table.act(activeId, 'check', undefined, clock).ok);
    else assert.ok(table.act(activeId, 'call', undefined, clock).ok);
    clock += 10;
  }
  assert.equal(sawOpponentCardsEarly, false, 'opponent cards leaked before showdown');
  ok('a full hand plays to showdown without leaking cards');

  const end = table.viewFor(a.playerId, clock);
  assert.equal(end.phase, GamePhase.SHOWDOWN);
  assert.ok(end.result, 'showdown produced a result');
  assert.ok(end.result!.payouts.length >= 1);
  assert.equal(end.board.length, 5, 'five community cards at showdown');
  ok('showdown result carries payouts and the full board');

  // At showdown the contesting hands ARE revealed - that is the point of it.
  const bothIn = end.seats.every((s) => !s || s.status !== 'FOLDED');
  if (bothIn) {
    assert.equal(end.seats[1]!.hand?.length, 2, 'showdown reveals the live opponent hand');
    ok('showdown reveals contesting hands to each other');
  } else {
    ok('showdown reveal skipped (someone folded in this run)');
  }

  const chipsAfter = end.seats.reduce((sum, s) => sum + (s ? s.chips : 0), 0);
  assert.equal(chipsAfter, 2_000, 'chips are conserved through the hand');
  ok('chip conservation after one hand');
}

// ---------------------------------------------------------------------------
console.log('tableController: action validation');

{
  const table = new TableController({ ...FAST, maxSeats: 4 });
  const clock = 2_000_000;
  const a = table.sit('Alice', clock);
  const b = table.sit('Bob', clock);
  assert.ok(a.ok && b.ok);
  table.ready(a.playerId, clock);
  table.ready(b.playerId, clock);
  table.startHand(clock);

  const first = table.viewFor(a.playerId, clock).activeSeat;
  const activeId = first === null ? null : table.playerIdAt(first)!;
  assert.ok(activeId);

  assert.deepEqual(table.act(b.playerId, 'fold', undefined, clock), {
    ok: false,
    error: 'NOT_YOUR_TURN',
  });
  ok('acting out of turn is refused');

  const legal = table.legalFor(activeId)!;
  if (!legal.check) {
    assert.deepEqual(table.act(activeId, 'check', undefined, clock), {
      ok: false,
      error: 'CANNOT_CHECK',
    });
    ok('checking while facing a bet is refused instead of silently folding');
  } else {
    ok('check refused path skipped (nothing to call in this run)');
  }

  if (legal.raise) {
    assert.deepEqual(table.act(activeId, 'raise', 1, clock), { ok: false, error: 'BAD_ACTION' });
    ok('a sub-minimum raise is refused');

    const max = legal.maxRaiseTo!;
    const result = table.act(activeId, 'raise', max + 500, clock);
    assert.equal(result.ok, true);
    const seat = table.viewFor(activeId, clock).seats[first!]!;
    assert.equal(seat.chips, 0, 'an over-max raise is clamped to the all-in total');
    assert.equal(seat.status, 'ALL-IN');
    ok('an over-max raise is clamped to all-in');
  } else {
    ok('raise paths skipped (short stack in this run)');
  }
}

// ---------------------------------------------------------------------------
console.log('tableController: timeouts and deferred buy-ins');

{
  const table = new TableController({ ...FAST, maxSeats: 4, nextHandDelayMs: 60_000 });
  let clock = 3_000_000;
  const a = table.sit('Alice', clock);
  const b = table.sit('Bob', clock);
  assert.ok(a.ok && b.ok);
  table.ready(a.playerId, clock);
  table.ready(b.playerId, clock);
  table.startHand(clock);

  const before = table.viewFor(a.playerId, clock);
  assert.equal(before.handOver, false);

  // Nobody acts: the clock alone must resolve the hand.
  clock += FAST.turnMs + 1;
  assert.equal(table.tick(clock), true, 'tick reports a change');
  const after = table.viewFor(a.playerId, clock);
  assert.equal(after.handOver, true, 'the hand was resolved by the turn clock');
  assert.ok(
    after.seats.some((s) => s && s.status === 'FOLDED'),
    'the player who timed out was folded'
  );
  assert.equal(
    after.seats.reduce((sum, s) => sum + (s ? s.chips : 0), 0),
    2_000,
    'chip conservation after an auto-fold'
  );
  ok('an expired turn clock auto-checks or auto-folds and the hand settles');

  // A seat taken mid-hand is funded only once the hand is over.
  assert.equal(table.startHand(clock), true, 'a new hand can be dealt');
  const c = table.sit('Carol', clock);
  assert.ok(c.ok);
  assert.equal(table.viewFor(a.playerId, clock).seats[c.seat]!.chips, 0, 'no stack mid-hand');
  clock += FAST.turnMs + 1;
  table.tick(clock);
  assert.equal(table.viewFor(a.playerId, clock).handOver, true, 'the hand settled again');
  assert.equal(
    table.viewFor(a.playerId, clock).seats[c.seat]!.chips,
    1_000,
    'the deferred stack lands between hands'
  );
  ok('a mid-hand sit-in is funded between hands, not during one');

  // Disconnecting shortens the budget for the player who left.
  clock += 1_000;
  table.startHand(clock);
  const seated = table.seatedPlayerIds();
  const activeSeat = table.viewFor(a.playerId, clock).activeSeat!;
  const activeId = table.playerIdAt(activeSeat)!;
  table.setConnected(activeId, false, clock);
  clock += FAST.disconnectedTurnMs + 1;
  table.tick(clock);
  const disconnected = table.viewFor(a.playerId, clock);
  assert.ok(
    disconnected.seats.find((s) => s && s.playerId === activeId)!.status === 'FOLDED' ||
      disconnected.handOver,
    'a disconnected player does not hold the table for the full thinking time'
  );
  ok('a disconnected player is auto-folded on the short clock');
  assert.ok(seated.length === 3);
}

// ---------------------------------------------------------------------------
console.log('tableController: 30 hands, chip conservation');

{
  const table = new TableController({ ...TABLE_DEFAULTS, maxSeats: 3, bigBlind: 20, startingStack: 1_000 });
  let clock = 4_000_000;
  const ids = ['Alice', 'Bob', 'Carol'].map((name) => {
    const res = table.sit(name, clock);
    assert.ok(res.ok);
    table.ready(res.playerId, clock);
    return res.playerId;
  });
  let hands = 0;
  let showdowns = 0;
  let guard = 0;
  while (hands < 30 && guard++ < 20_000) {
    if (table.viewFor(ids[0], clock).handOver) {
      if (!table.canStartHand()) break;
      clock += TABLE_DEFAULTS.nextHandDelayMs + 1;
      table.tick(clock);
      if (table.viewFor(ids[0], clock).handOver) break; // everyone else busted
    }
    const view = table.viewFor(ids[0], clock);
    const active = view.activeSeat === null ? null : view.seats[view.activeSeat]!;
    if (!active) break;
    const legal = table.legalFor(active.playerId)!; // the actor's options, not the viewer's
    const action = legal.raise && Math.random() < 0.3 ? 'raise' : legal.check ? 'check' : legal.call ? 'call' : 'fold';
    const amount = action === 'raise' ? legal.minRaiseTo! : undefined;
    const result = table.act(active.playerId, action, amount, clock);
    assert.equal(result.ok, true, `random play must stay legal (${action})`);

    const after = table.viewFor(ids[0], clock);
    if (after.handOver) {
      hands += 1;
      if (after.result?.showdown) showdowns += 1;
      assert.equal(
        after.seats.reduce((sum, s) => sum + (s ? s.chips : 0), 0),
        3_000,
        `chips conserved after hand ${hands}`
      );
    }
    clock += 10;
  }

  assert.ok(hands >= 20, `expected at least 20 hands, played ${hands}`);
  ok(`${hands} hands played, ${showdowns} showdowns, chips conserved throughout`);
  assert.equal(totalChips(table, ids, clock), 3_000);
  ok('final chip total matches the three starting stacks');
}

console.log(`\ntableController: all ${checks} checks passed`);
