// P1 acceptance test: two real WebSocket clients at one table.
//
// This is the test the online plan calls the critical acceptance check: it
// inspects every frame that client A actually received and asserts that B's
// hole cards were never on the wire before showdown, that the deck is never
// serialised at all, and that each socket gets a different view of the same
// hand. It also covers seating, illegal actions, reconnect-by-token and the
// server-side turn clock.

import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer, RunningServer } from '../server/app';
import type { ClientMessage, ServerMessage } from '../server/protocol';
import type { TableView } from '../services/tableController';

let checks = 0;
const ok = (label: string) => {
  checks += 1;
  console.log(`  ok ${checks} - ${label}`);
};

const ROOM = 'TESTROOM';

class TestClient {
  readonly frames: string[] = [];
  readonly messages: ServerMessage[] = [];
  playerId: string | null = null;
  token: string | null = null;
  seat: number | null = null;
  view: TableView | null = null;
  errors: { code: string; actionId?: string }[] = [];

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const raw = data.toString();
      this.frames.push(raw);
      const message = JSON.parse(raw) as ServerMessage;
      this.messages.push(message);
      if (message.t === 'welcome') this.playerId = message.youId;
      if (message.t === 'seated') {
        this.playerId = message.playerId;
        this.token = message.token;
        this.seat = message.seat;
      }
      if (message.t === 'state') this.view = message.view;
      if (message.t === 'error') this.errors.push({ code: message.code, actionId: message.actionId });
    });
  }

  send(message: ClientMessage) {
    this.socket.send(JSON.stringify(message));
  }

  async waitUntil(label: string, predicate: () => boolean, timeoutMs = 8_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error(`timed out waiting for: ${label}`);
  }
}

const connect = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });

const wsUrl = (port: number, code = ROOM) => `ws://127.0.0.1:${port}/ws?code=${code}`;

// ---------------------------------------------------------------------------
console.log('multiplayer: two clients, one table, no leaked cards');

let server: RunningServer | null = null;
let a: TestClient | null = null;
let b: TestClient | null = null;

try {
  server = await startServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: null,
    log: () => {},
    config: { turnMs: 1_500, disconnectedTurnMs: 300, nextHandDelayMs: 500, seatIdleMs: 5_000, maxSeats: 4 },
  });
  ok(`server started on an ephemeral port (${server.port})`);

  a = new TestClient(await connect(wsUrl(server.port)));
  b = new TestClient(await connect(wsUrl(server.port)));
  a.send({ t: 'hello', name: 'Alice' });
  b.send({ t: 'hello', name: 'Bob' });
  await a.waitUntil('welcome for A', () => a!.messages.some((m) => m.t === 'welcome'));
  await b.waitUntil('welcome for B', () => b!.messages.some((m) => m.t === 'welcome'));

  const welcome = a.messages.find((m) => m.t === 'welcome');
  assert.ok(welcome && welcome.t === 'welcome');
  assert.equal(welcome.protocol, 1);
  assert.equal(welcome.roomCode, ROOM);
  assert.equal(welcome.youId, null, 'a fresh socket has no seat yet');
  assert.equal(welcome.config.maxSeats, 4);
  ok('both clients are greeted with the room config');

  a.send({ t: 'sit', name: 'Alice' });
  b.send({ t: 'sit', name: 'Bob' });
  await a.waitUntil('A seated', () => a!.seat !== null);
  await b.waitUntil('B seated', () => b!.seat !== null);
  assert.notEqual(a.seat, b.seat, 'the two players get different seats');
  assert.ok(a.token && b.token, 'each seat gets its own token');
  ok('both clients take a seat and receive a reconnect token');

  // Both clients see the same two seats, but only their own cards.
  await a.waitUntil('A sees two seats', () => (a!.view?.seats.filter(Boolean).length ?? 0) === 2);
  const aSeesB = a.view!.seats[b.seat!]!;
  assert.equal(aSeesB.name, 'Bob');
  assert.equal(aSeesB.hand, null, 'pre-deal: no cards for Bob in A view');
  assert.equal(a.view!.youSeat, a.seat);
  ok('a client sees the other seat but not its cards');

  a.send({ t: 'ready' });
  b.send({ t: 'ready' });
  await a.waitUntil('hand dealt', () => a!.view?.handNumber === 1 && a!.view.handOver === false);
  await b.waitUntil('B sees the same hand', () => b!.view?.handNumber === 1 && b!.view.handOver === false);
  ok('two ready players get dealt a hand without any manual start');

  assert.equal(a.view!.seats[a.seat!]!.hand?.length, 2, 'A holds two cards');
  assert.equal(b.view!.seats[b.seat!]!.hand?.length, 2, 'B holds two cards');
  assert.equal(a.view!.seats[b.seat!]!.hand, null, 'A still cannot see B cards');
  const aCards = a.view!.seats[a.seat!]!.hand!.map((c) => c.id).sort().join(',');
  const bCards = b.view!.seats[b.seat!]!.hand!.map((c) => c.id).sort().join(',');
  assert.notEqual(aCards, bCards, 'the two clients hold different cards');
  assert.equal(a.view!.board.length, 0, 'no community cards preflop');
  ok('each client holds a different, private hand');

  // An action out of turn must be refused with an error, not silently applied.
  const notMyTurn = a.view!.activeSeat !== a.seat ? a : b;
  notMyTurn.send({ t: 'action', actionId: 'oops', action: 'fold' });
  await notMyTurn.waitUntil('out-of-turn refusal', () => notMyTurn.errors.some((e) => e.actionId === 'oops'));
  assert.equal(notMyTurn.errors.find((e) => e.actionId === 'oops')!.code, 'NOT_YOUR_TURN');
  ok('an action out of turn is refused with NOT_YOUR_TURN');

  // Play the hand out: each client acts only when the server says it is its turn.
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    for (const client of [a, b]) {
      const view = client.view;
      if (!view || view.handOver) continue;
      if (view.activeSeat !== client.seat || !view.legal) continue;
      const legal = view.legal;
      const action = legal.check ? 'check' : legal.call ? 'call' : 'fold';
      client.send({ t: 'action', actionId: `a-${view.seq}`, action });
    }
    if (a.view?.handOver && b.view?.handOver) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(a.view!.handOver, true, 'the hand reached a result');
  assert.ok(a.view!.result, 'A received the hand result');
  assert.equal(a.view!.board.length, 5, 'A received all five community cards');
  ok('the hand played to showdown through the wire');

  // ------------------------------------------------------------- wire audit
  assert.ok(a.frames.length > 5, 'A received a meaningful number of frames');
  let statesSeen = 0;
  let leaked = 0;
  let deckSeen = 0;
  let foreignHandsPreShowdown = 0;
  for (const frame of a.frames) {
    if (/"deck"\s*:/.test(frame)) deckSeen += 1;
    const message = JSON.parse(frame) as ServerMessage;
    if (message.t !== 'state') continue;
    statesSeen += 1;
    const view = message.view;
    if (view.phase === 'SHOWDOWN') continue;
    view.seats.forEach((seat) => {
      if (!seat) return;
      if (seat.playerId === a!.playerId) {
        // Only while a hand is live: between hands the engine clears a busted
        // seat's cards, and before the first deal nobody holds any yet.
        if (!view.handOver && (!seat.hand || seat.hand.length !== 2)) leaked += 1;
      } else if (seat.hand !== null) {
        foreignHandsPreShowdown += 1;
      }
    });
  }
  assert.equal(deckSeen, 0, 'the deck was never serialised onto the wire');
  assert.equal(foreignHandsPreShowdown, 0, "an opponent's hole cards were on the wire before showdown");
  assert.equal(leaked, 0, 'the viewer always received their own two cards');
  ok(`audited ${statesSeen} state frames on A: no deck, no foreign hole cards`);

  // At showdown the live hands are revealed - and both clients should now see
  // two cards for the other seat.
  const showdownFrame = a.frames.find((frame) => {
    const message = JSON.parse(frame) as ServerMessage;
    return message.t === 'state' && message.view.phase === 'SHOWDOWN';
  });
  assert.ok(showdownFrame, 'A received a showdown frame');
  const showdownView = (JSON.parse(showdownFrame!) as ServerMessage & { view: TableView }).view;
  const bSeatAtShowdown = showdownView.seats[b.seat!]!;
  if (bSeatAtShowdown.status !== 'FOLDED') {
    assert.equal(bSeatAtShowdown.hand?.length, 2, 'showdown reveals the live opponent hand');
    ok('showdown reveals the contesting hand to the other player');
  } else {
    ok('showdown reveal skipped (B folded in this run)');
  }

  // ----------------------------------------------------------- reconnect
  const tokenForA = a.token!;
  const playerIdForA = a.playerId!;
  a.frames.length = 0;
  a.messages.length = 0;
  a.view = null;
  const staleSocket = a;
  void staleSocket;
  (a as unknown as { socket: WebSocket }).socket.close();
  await new Promise((resolve) => setTimeout(resolve, 150));

  const resumed = new TestClient(await connect(wsUrl(server.port)));
  resumed.send({ t: 'hello', token: tokenForA });
  await resumed.waitUntil('resumed welcome', () => resumed.messages.some((m) => m.t === 'welcome'));
  assert.equal(resumed.playerId, playerIdForA, 'the token restored the same seat');
  await resumed.waitUntil('resumed state', () => resumed.view !== null);
  assert.equal(resumed.view!.youSeat, resumed.seat ?? resumed.view!.youSeat);
  assert.ok(resumed.view!.youSeat !== null, 'the resumed client is seated again');
  ok('a client that reconnects with its token returns to the same seat');

  // ------------------------------------------------------- turn clock
  const other = b;
  await other.waitUntil('the next hand is dealt', () => other!.view?.handOver === false, 8_000);
  const before = other.view!.handHistory.length;
  await other.waitUntil(
    'the clock resolves the hand',
    () => (other!.view?.handOver ?? false) || (other!.view?.handHistory.length ?? 0) > before,
    15_000
  );
  ok('the server-side turn clock resolves a hand with no client input at all');

  // ------------------------------------------------------------------ done
  assert.equal(a.errors.length, 0);
} finally {
  if (server) await server.close();
}

console.log(`\nmultiplayer: all ${checks} checks passed`);
