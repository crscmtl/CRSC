/*
 * The seating must not decide before the removals have arrived.
 *
 * pass-optout-check proved the RULE — a removal beats the pass — but it ran
 * against the demo store, where removals are in hand the instant the page
 * loads. Live they are not: watchRemovals() starts a Firestore listener and
 * the rows land a moment later, while seatPassHolders runs in the same
 * breath as that call. It read an empty array, concluded nobody had pulled
 * out, and put every pass holder back on the list with a fresh "your spot is
 * reserved" email. The seatedEvents guard then stopped it ever looking
 * again on that page load.
 *
 * So the member removed themselves, the removal was written correctly with
 * its list id, and an hour later they were seated again anyway. The first
 * test could not see that, because in demo mode the race does not exist.
 *
 * This one creates the race: the store is patched so removals arrive 900ms
 * after the page asks for them, exactly as they do over the network.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const KEY = 'crsc-demo-v7';
const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
const DATE = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fixture = {
  settings: { passAutoSeat: true }, payments: [], log: [], refunds: [],
  players: {
    dA: { deviceId: 'dA', name: 'Ana Pass', email: 'ana@x.com', battlePass: '4h',
          passLists: [{ sport: 'volleyball', sessionId: 's1', label: 'Advanced +' },
                      { sport: 'volleyball', sessionId: 's2', label: 'Adv + Men' }] },
  },
  // She pulled out of the 5:30 list. Recorded properly, with the list id.
  removals: [{
    id: 'rm1', eventId: 'ev', eventDate: DATE, name: 'Ana Pass', email: 'ana@x.com',
    phone: '', insta: '', deviceId: 'dA', listId: 'v1', listLabel: 'Advanced +',
    sportLabel: 'Volleyball', sessionLabel: '5:30 - 7:30 PM',
    signedUpAt: 1, removedAt: 2, by: 'self', wasPaid: false, wasCheckedIn: false,
    afterStart: false, amountOwed: 8, flagged: false,
  }],
  events: [{ id: 'ev', title: 'S', date: DATE, status: 'open', location: 'X', openEarly: true,
    sessions: [{ id: 's1', label: '5:30 - 7:30 PM' }, { id: 's2', label: '7:30 - 9:30 PM' }],
    lists: [
      { id: 'v1', sessionId: 's1', sport: 'volleyball', label: 'Advanced +', cap: 20, level: 0, priceE: 8, priceC: 10, teamCount: 0 },
      { id: 'v2', sessionId: 's2', sport: 'volleyball', label: 'Adv + Men',  cap: 20, level: 0, priceE: 8, priceC: 10, teamCount: 0 },
    ],
    bundles: [], createdAt: 1 }],
  signups: { ev: [] },
};

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext();
const errs = [];
await ctx.route('**/firebase-config.js', r => r.fulfill({ contentType: 'application/javascript', body: 'window.FIREBASE_CONFIG=null;window.MAILER=null;' }));

// Make the demo store behave like the network one: the removals are not
// there when the page first asks, and turn up 900ms later.
await ctx.route('**/js/store.js*', async (r) => {
  const res = await r.fetch();
  let body = await res.text();
  /*
   * The demo store's watchRemovals is the one-liner; the two live ones span
   * several lines, so this only ever rewrites the demo one. Matching its
   * shape rather than its exact body means the check still runs against a
   * build that has no removalsReady in it at all — which is the build that
   * has to fail here.
   */
  const marker = /watchRemovals\(\) \{[^\n]*\},/;
  if (!marker.test(body)) throw new Error('demo watchRemovals not found — has it changed?');
  // Idempotent, like the real one: the live store returns early if it is
  // already watching. Without that this patch re-blanks the list on every
  // render and tests the harness rather than the app.
  body = body.replace(marker, `watchRemovals() {
      if (this._watching) return;
      this._watching = true;
      const landed = state.removals; state.removals = [];
      setTimeout(() => { state.removals = landed; state.removalsReady = true; onChange(state); }, 900);
    },`);
  await r.fulfill({ contentType: 'application/javascript', body });
});

await ctx.addInitScript(({ KEY, fixture }) => {
  if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify(fixture));
  localStorage.setItem('crsc-profile', JSON.stringify({ name: 'Juan', email: 'juan@x.com', deviceId: 'dExec' }));
  sessionStorage.setItem('crsc-exec', '1');
}, { KEY, fixture });

const pg = await ctx.newPage();
pg.on('pageerror', e => errs.push(e.message));
await pg.goto('http://localhost:8099/#/event/ev', { waitUntil: 'domcontentloaded' });

/*
 * Watch the whole load, not one instant of it.
 *
 * Sampling at a fixed moment races the thing under test: catch it a little
 * late and the removals have already landed, so the check passes without
 * ever having looked at the window where the bug lives. Sampling throughout
 * and requiring that the list she left NEVER appears is the claim that
 * actually matters, and it does not depend on timing.
 */
const seen = new Set();
for (let i = 0; i < 34; i++) {
  await pg.waitForTimeout(100);
  for (const id of await pg.evaluate((K) => {
    try { return (JSON.parse(localStorage.getItem(K)).signups.ev || []).map(x => x.listId); }
    catch (e) { return []; }
  }, KEY)) seen.add(id);
}
const after = await pg.evaluate((K) => (JSON.parse(localStorage.getItem(K)).signups.ev || []).map(x => x.listId).sort(), KEY);

console.log('every list she was ever seated on, across the whole load:', JSON.stringify([...seen].sort()));
console.log('   ever seated on the list she left (v1) :', seen.has('v1'), '(must be false)');
console.log('settled state once the removals landed   :', JSON.stringify(after));
console.log('   holds her other list (v2)             :', after.includes('v2'), '(must be true)');

console.log('errors:', errs.length ? errs : 'none');
const ok = !seen.has('v1')
        && after.includes('v2') && after.length === 1
        && !errs.length;
console.log('\n' + (ok
  ? 'the seating waits for the answer instead of assuming nobody pulled out'
  : 'FAILED'));
await b.close();
process.exit(ok ? 0 : 1);
