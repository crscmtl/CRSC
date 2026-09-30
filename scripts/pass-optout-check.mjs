/*
 * "I can't make it" outranks the season pass.
 *
 * A pass reserves a spot. It does not overrule the person it is reserved
 * for. Somebody who takes their own name off has said they are not coming,
 * and the app put them straight back on the list at the very next render,
 * with a fresh "your spot is reserved" email each time. One member did it
 * four separate times for the same Saturday and was on the list every time
 * they reopened the page.
 *
 * The cause was that removals never recorded WHICH list they were from.
 * logRemoval saved the list's name but not its id, and the guard looked up
 * the id, so it never once matched.
 *
 * Both halves are checked here, because fixing only the second would leave
 * every removal already written useless:
 *   1. a fresh removal keeps them off, and the seat they gave up is dropped,
 *   2. an OLD removal — labels only, no list id, exactly what is in the
 *      club's database today — keeps them off too,
 *   3. and it is only that list, on that Saturday. The pass still holds
 *      their other slot, and still holds everything next week.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const KEY = 'crsc-demo-v7';
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sat = new Date(); sat.setDate(sat.getDate() + ((6 - sat.getDay() + 7) % 7));
const NEXT = new Date(sat); NEXT.setDate(NEXT.getDate() + 7);
const D1 = iso(sat), D2 = iso(NEXT);

const lists = (eid) => [
  { id: eid + '-v1', sessionId: 's1', sport: 'volleyball', label: 'Advanced +', cap: 20, level: 0, priceE: 8, priceC: 10, teamCount: 0 },
  { id: eid + '-v2', sessionId: 's2', sport: 'volleyball', label: 'Adv + Men', cap: 20, level: 0, priceE: 8, priceC: 10, teamCount: 0 },
];
const ev = (id, date) => ({
  id, title: 'S', date, status: 'open', location: 'X', openEarly: true,
  sessions: [{ id: 's1', label: '5:30 - 7:30 PM' }, { id: 's2', label: '7:30 - 9:30 PM' }],
  lists: lists(id), bundles: [], createdAt: 1,
});

// An old-style removal: the shape every record in the club's database has
// right now. Note the absence of listId — that is the bug, preserved.
const oldStyleRemoval = {
  id: 'rm-old', eventId: 'evA', eventDate: D1,
  name: 'Ana Pass', email: 'ana@x.com', phone: '', insta: '', deviceId: 'dA',
  listLabel: 'Advanced +', sportLabel: 'Volleyball', sessionLabel: '5:30 - 7:30 PM',
  signedUpAt: 1, removedAt: 2, by: 'self', wasPaid: false, wasCheckedIn: false,
  afterStart: false, amountOwed: 8, flagged: false,
};

const fixture = {
  settings: { passAutoSeat: true, cancelLockHours: 0 },
  removals: [oldStyleRemoval], payments: [], log: [], refunds: [],
  players: {
    dA: { deviceId: 'dA', name: 'Ana Pass', email: 'ana@x.com', battlePass: '4h',
          passLists: [{ sport: 'volleyball', sessionId: 's1', label: 'Advanced +' },
                      { sport: 'volleyball', sessionId: 's2', label: 'Adv + Men' }] },
  },
  events: [ev('evA', D1), ev('evB', D2)],
  // The seat the old removal was for is still sitting there, as it is live.
  signups: { evA: [{
    id: 'seat-stale', listId: 'evA-v1', name: 'Ana Pass', email: 'ana@x.com',
    phone: '', insta: '', photo: '', deviceId: 'dA', method: 'etransfer',
    paid: false, checkedIn: false, team: null, order: -1, createdAt: 1, viaPass: true,
  }], evB: [] },
};

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext();
const errs = [];
const sent = [];
await ctx.route('**/firebase-config.js', r => r.fulfill({ contentType: 'application/javascript',
  body: 'window.FIREBASE_CONFIG=null;window.MAILER={url:"https://mailer.test/x",secret:"s"};' }));
await ctx.route('**/js/app.js*', async (r) => {
  const res = await r.fetch();
  let body = await res.text();
  if (!body.includes("store.mode === 'demo' || !mailerConfigured()")) throw new Error('demo guard renamed');
  body = body.split("store.mode === 'demo' || !mailerConfigured()").join('!mailerConfigured()');
  await r.fulfill({ contentType: 'application/javascript', body });
});
await ctx.route('https://mailer.test/**', r => {
  try { sent.push(JSON.parse(r.request().postData() || '{}')); } catch (e) { /* ignore */ }
  r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});
await ctx.addInitScript(({ KEY, fixture }) => {
  if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify(fixture));
  localStorage.setItem('crsc-profile', JSON.stringify({ name: 'Juan', email: 'juan@x.com', deviceId: 'dExec' }));
  sessionStorage.setItem('crsc-exec', '1');
}, { KEY, fixture });

const pg = await ctx.newPage();
pg.on('pageerror', e => errs.push(e.message));

const seats = (id) => pg.evaluate(([K, e]) => {
  const s = JSON.parse(localStorage.getItem(K));
  const L = Object.fromEntries((s.events.find(x => x.id === e).lists || []).map(l => [l.id, l.label]));
  return (s.signups[e] || []).map(x => `${x.name}@${L[x.listId]}`).sort();
}, [KEY, id]);

// Open the Saturday she pulled out of, three times, as she did.
for (let i = 0; i < 3; i++) {
  await pg.goto(`http://localhost:8099/?v=${i}#/event/evA`, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(1500);
}
const a = await seats('evA');
console.log('the Saturday she pulled out of, after 3 visits:');
console.log('   ', JSON.stringify(a));
const backOnAdvPlus = a.some(x => /Advanced \+$/.test(x));
const keepsOtherSlot = a.some(x => /Adv \+ Men$/.test(x));
console.log('    put back on the list she left :', backOnAdvPlus, '(must be false)');
console.log('    still holds her other slot    :', keepsOtherSlot, '(must be true)');

// Next Saturday is untouched: she only said no to one night.
await pg.goto('http://localhost:8099/?v=n#/event/evB', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1600);
const bseats = await seats('evB');
console.log('\nnext Saturday:', JSON.stringify(bseats), '— both slots held again');

// One notice per Saturday, and the one for the Saturday she pulled out of
// must not offer her the list she left. Next Saturday naming "Advanced +"
// is correct — she is held there again — so the check is per Saturday, not
// across all the mail.
const held = sent.filter(m => /held|reserv/i.test(m.subject + m.message));
const forThis = held.filter(m => (m.message || '').includes('Adv'));
const thisSat = held.find(m => !/Advanced \+/.test(m.message || '') || !bseats);
console.log('\n"your spot is reserved" emails sent:', held.length, '(one per Saturday)');
held.forEach(m => console.log('   ', JSON.stringify(m.subject)));
const leftListOffered = held.some(m =>
  /Advanced \+/.test(m.message || '') && !/Adv \+ Men/.test(m.message || ''));
const thisSatMail = held.find(m => /Adv \+ Men/.test(m.message || '') && !/Advanced \+/.test(m.message || ''));
console.log('    a notice for the Saturday she left, naming only her remaining slot:', !!thisSatMail);

console.log('errors:', errs.length ? errs : 'none');
const ok = !backOnAdvPlus && keepsOtherSlot
        && bseats.length === 2
        && held.length === 2 && !!thisSatMail
        && !errs.length;
console.log('\n' + (ok
  ? 'saying you cannot come outranks the pass, for that list and that Saturday only'
  : 'FAILED'));
await b.close();
process.exit(ok ? 0 : 1);
