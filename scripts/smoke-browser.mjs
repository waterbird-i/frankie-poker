// Headless browser smoke test for the multiplayer table page.
//
// Drives two real Chrome pages over CDP (no Playwright): each one connects to
// the running game server, sits down, readies up, and plays the dealt hand.
// The point is to verify what the automated protocol test cannot: that the page
// actually renders, that a real user can sit and act, and - the security check
// that matters - that player A's DOM never contains player B's hole cards.

import { WebSocket } from 'ws';

const CDP = 'http://127.0.0.1:9222';
const TABLE_URL = process.env.TABLE_URL || 'http://localhost:8787/table?code=FRIENDS';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` -> ${detail}` : ''}`);
};

// ----------------------------------------------------------------- CDP glue
const httpJson = async (path, method = 'GET') => {
  const res = await fetch(`${CDP}${path}`, { method });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
};

const waitForCdp = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await httpJson('/json/version');
      return true;
    } catch {
      await sleep(500);
    }
  }
  throw new Error('Chrome DevTools endpoint never came up');
};

class Page {
  constructor(ws, targetId) {
    this.ws = ws;
    this.targetId = targetId;
    this.nextId = 0;
    this.pending = new Map();
    this.problems = [];
    ws.on('message', (data) => this.onMessage(JSON.parse(data.toString())));
  }

  static async open(url) {
    const target = await httpJson(`/json/new?${encodeURIComponent(url)}`, 'PUT');
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const page = new Page(ws, target.id);
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Page.enable');
    await page.send('Network.enable');
    return page;
  }

  onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      this.problems.push(msg.params.exceptionDetails?.exception?.description ?? 'uncaught exception');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      this.problems.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const entry = msg.params.entry;
      this.problems.push(`${entry.text}${entry.url ? ` [${entry.url}]` : ''}`);
    }
    if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
      this.problems.push(`HTTP ${msg.params.response.status} [${msg.params.response.url}]`);
    }
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
    }
    return result.result.value;
  }

  async waitFor(label, expression, timeoutMs = 15_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch {
        /* page may be mid-navigation */
      }
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
    try {
      await httpJson(`/json/close/${this.targetId}`);
    } catch {
      /* already gone */
    }
  }
}

// ------------------------------------------------------------ page snippets
const DUMP = `(() => {
  const buttons = [...document.querySelectorAll('button')].map((b) => ({
    text: b.textContent.trim().replace(/\\s+/g, ' ').slice(0, 40),
    disabled: b.disabled,
  }));
  const inputs = [...document.querySelectorAll('input')].map((i) => ({
    id: i.id, type: i.type, placeholder: i.placeholder, value: i.value,
  }));
  return {
    title: document.title,
    url: location.href,
    buttons,
    inputs,
    text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 900),
  };
})()`;

const setInput = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'missing';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value;
})()`;

const clickText = (text) => `(() => {
  const button = [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled);
  if (!button) return 'missing';
  button.click();
  return 'clicked';
})()`;

// Card faces render as rank + suit glyph; card backs render no glyph at all.
const CARDS = `(() => {
  const text = document.body.innerText;
  const tokens = [...text.matchAll(/(10|[2-9TJQKA])\\s*([\\u2660\\u2665\\u2666\\u2663])/g)]
    .map((m) => m[1] + m[2]);
  return [...new Set(tokens)];
})()`;

const GLYPH_COUNT = `(document.body.innerText.match(/[\\u2660\\u2665\\u2666\\u2663]/g) || []).length`;

// --------------------------------------------------------------------- run
console.log(`browser smoke: ${TABLE_URL}`);
await waitForCdp();

let a = null;
let b = null;
try {
  a = await Page.open(TABLE_URL);
  b = await Page.open(TABLE_URL);

  await a.waitFor('A page load', `document.readyState === 'complete'`);
  await b.waitFor('B page load', `document.readyState === 'complete'`);
  await sleep(2_500); // React mount + WebSocket handshake

  const firstDump = await a.evaluate(DUMP);
  check('page loads with the expected title', /table/i.test(firstDump.title), firstDump.title);
  check('join form renders a name field', firstDump.inputs.some((i) => i.id === 'pt-sit-name'), JSON.stringify(firstDump.inputs));
  check('join form renders a Sit down button', firstDump.buttons.some((x) => x.text === 'Sit down'), JSON.stringify(firstDump.buttons.map((x) => x.text)));

  check('A: name typed', (await a.evaluate(setInput('#pt-sit-name', 'Alice'))) === 'Alice');
  check('B: name typed', (await b.evaluate(setInput('#pt-sit-name', 'Bob'))) === 'Bob');
  check('A: Sit down clicked', (await a.evaluate(clickText('Sit down'))) === 'clicked');
  check('B: Sit down clicked', (await b.evaluate(clickText('Sit down'))) === 'clicked');

  await a.waitFor('A seated', `document.body.innerText.includes('Alice')`);
  await a.waitFor('A sees Bob', `document.body.innerText.includes('Bob')`);
  await sleep(600);
  const seatedDump = await a.evaluate(DUMP);
  check('A sees both players at the table', /Alice/.test(seatedDump.text) && /Bob/.test(seatedDump.text));
  check('A gets a Ready button once seated', seatedDump.buttons.some((x) => x.text === 'Ready'), JSON.stringify(seatedDump.buttons.map((x) => x.text)));

  check('A: Ready clicked', (await a.evaluate(clickText('Ready'))) === 'clicked');
  check('B: Ready clicked', (await b.evaluate(clickText('Ready'))) === 'clicked');

  // Two ready stacks -> the server deals the first hand on its own.
  await a.waitFor('A receives a dealt hand', `${GLYPH_COUNT} > 0`, 20_000);
  await b.waitFor('B receives a dealt hand', `${GLYPH_COUNT} > 0`, 20_000);
  await sleep(800);

  const aTokens = await a.evaluate(CARDS);
  const bTokens = await b.evaluate(CARDS);
  check('A renders exactly its own two cards', aTokens.length === 2, JSON.stringify(aTokens));
  check('B renders exactly its own two cards', bTokens.length === 2, JSON.stringify(bTokens));

  const shared = aTokens.filter((t) => bTokens.includes(t));
  check('A never renders B hole cards (and vice versa)', shared.length === 0, `shared=${JSON.stringify(shared)}`);

  const aText = await a.evaluate(`document.body.innerText.replace(/\\s+/g,' ')`);
  check('A can see the pot and its own turn state', /pot|\$/i.test(aText), aText.slice(0, 160));

  // Play the hand through the UI: whoever has action buttons presses them.
  let acted = 0;
  for (let i = 0; i < 60; i++) {
    for (const page of [a, b]) {
      const pressed = await page.evaluate(`(() => {
        const wanted = ['Check', 'Call', 'Call ', 'Fold'];
        const button = [...document.querySelectorAll('button')].find((b) =>
          !b.disabled && wanted.some((w) => b.textContent.trim() === w || b.textContent.trim().startsWith(w)));
        if (!button) return null;
        const label = button.textContent.trim();
        button.click();
        return label;
      })()`);
      if (pressed) acted += 1;
    }
    if (acted >= 4) break;
    await sleep(400);
  }
  check('the action bar is usable from the UI', acted > 0, `${acted} action(s) sent`);

  await sleep(1_500);
  const afterTokens = await a.evaluate(CARDS);
  const boardOrResult = await a.evaluate(`/wins|Winner|Showdown|FLOP|TURN|RIVER/i.test(document.body.innerText)`);
  check('the hand advanced past preflop', afterTokens.length > 2 || boardOrResult, JSON.stringify(afterTokens));

  check('no console errors or failed requests on A', a.problems.length === 0, a.problems.join(' | '));
  check('no console errors or failed requests on B', b.problems.length === 0, b.problems.join(' | '));

  console.log('\n--- A page text (first 400 chars) ---');
  console.log((await a.evaluate(`document.body.innerText.replace(/\\s+/g,' ')`)).slice(0, 400));
} catch (error) {
  failures += 1;
  console.log(`  FAIL harness error: ${error.message}`);
  if (a) console.log(`  A problems: ${a.problems.slice(0, 3).join(' | ')}`);
  if (b) console.log(`  B problems: ${b.problems.slice(0, 3).join(' | ')}`);
} finally {
  if (a) await a.close();
  if (b) await b.close();
}

console.log(`\nbrowser smoke: ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
