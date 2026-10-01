/*
 * A pass can hold a level in a slot the club is not running that week.
 *
 * The lists move around. Adv + Men is usually a 7:30 list, but the night
 * football is quiet it might appear at 5:30 instead. The held-spot picker
 * only ever offered the lists running on the Saturday being looked at, so a
 * pass holder could not be given that spot until the week it appeared — and
 * then somebody had to remember to go back and tick it.
 *
 * Ticking it in advance costs nothing: a held spot on a list that is not
 * running that week simply is not seated. So every level the club has ever
 * run is offered under every time slot, and the seat is there the moment
 * the club runs it.
 *
 * Three things:
 *   1. every level appears under both slots, including ones only ever run
 *      in the other one,
 *   2. ticking a level that is not running this week saves, and seats
 *      nobody that week,
 *   3. when a later Saturday does run it at 5:30, the pass seats them.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const KEY = 'crsc-demo-v7';
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sat = new Date(); sat.setDate(sat.getDate() + ((6 - sat.getDay() + 7) % 7));
const nxt = new Date(sat); nxt.setDate(nxt.getDate() + 7);
const D1 = iso(sat), D2 = iso(nxt);

const L = (id, sess, label, level) => ({ id, sessionId: sess, sport: 'volleyball', label, cap: 20, level, priceE: 8, priceC: 10, teamCount: 0 });
const SESS = [{ id: 's1', label: '5:30 - 7:30 PM' }, { id: 's2', label: '7:30 - 9:30 PM' }];

const fixture = {
  settings: { passAutoSeat: true }, removals: [], payments: [], log: [], refunds: [],
  players: { dA: { deviceId: 'dA', name: 'Ana Pass', email: 'ana@x.com' } },
  events: [
    // This Saturday: Adv + Men runs at 7:30 only.
    { id: 'evA', title: 'S', date: D1, status: 'open', location: 'X', openEarly: true, sessions: SESS,
      lists: [L('a1', 's1', 'Advanced +', 3), L('a2', 's2', 'Adv + Men', 4)], bundles: [], createdAt: 1 },
    // Next Saturday the club moves Adv + Men to 5:30 as well.
    { id: 'evB', title: 'S', date: D2, status: 'open', location: 'X', openEarly: true, sessions: SESS,
      lists: [L('b1', 's1', 'Adv + Men', 4), L('b2', 's2', 'Adv + Men', 4)], bundles: [], createdAt: 2 },
    // Other Saturdays, so the picker knows the club's full set of levels —
    // including one night an exec typed "advanced +" in lower case, which
    // must not become a sixth level holding a different seat.
    { id: 'evC', title: 'S', date: D2, status: 'open', location: 'X', sessions: SESS,
      lists: [L('c1', 's2', 'Intermediate', 1), L('c2', 's2', 'Advanced', 2),
              L('c3', 's2', 'Adv + Mixed', 3), L('c4', 's1', 'Advanced +', 4)], bundles: [], createdAt: 3 },
    { id: 'evD', title: 'S', date: D2, status: 'open', location: 'X', sessions: SESS,
      lists: [L('d1', 's1', 'advanced +', 4)], bundles: [], createdAt: 4 },
  ],
  signups: { evA: [], evB: [] },
};

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const pg = await b.newPage();
const errs = []; pg.on('pageerror', e => errs.push(e.message));
await pg.route('**/firebase-config.js', r => r.fulfill({ contentType: 'application/javascript', body: 'window.FIREBASE_CONFIG=null;window.MAILER=null;' }));
await pg.addInitScript(({ KEY, fixture }) => {
  if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify(fixture));
  localStorage.setItem('crsc-profile', JSON.stringify({ name: 'Juan', email: 'juan@x.com', deviceId: 'dExec' }));
  sessionStorage.setItem('crsc-exec', '1');
}, { KEY, fixture });

await pg.goto('http://localhost:8099/#/', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1400);
await pg.evaluate(() => document.querySelector('#btn-players')?.click());
await pg.waitForTimeout(800);
await pg.evaluate(() => document.querySelector('[data-pass]')?.click());
await pg.waitForTimeout(700);
await pg.evaluate(() => [...document.querySelectorAll('#pm-type [data-type]')].find(b => b.dataset.type === '4h')?.click());
await pg.waitForTimeout(600);

const offered = await pg.evaluate(() =>
  [...document.querySelectorAll('.pass-sess')].map(sec => ({
    slot: sec.querySelector('small')?.textContent.trim(),
    opts: [...sec.querySelectorAll('.pass-opt')].map(o => o.textContent.replace(/\s+/g, ' ').trim()),
  })));
console.log('what the picker offers:');
offered.forEach(sec => { console.log('  ', sec.slot); sec.opts.forEach(o => console.log('      ', o)); });

// "Adv + Men" must be offered at 5:30 even though it only runs at 7:30 today.
const earlySlot = offered.find(s => /5:30/.test(s.slot || ''));
const hasAdvMenEarly = (earlySlot?.opts || []).some(o => /Adv \+ Men/.test(o));
console.log('\nAdv + Men offered at 5:30 :', hasAdvMenEarly, '(must be true — it only runs at 7:30 this week)');

// The club runs five levels. A lower-case spelling of one of them on a
// single night is the same level, not a sixth.
const names = (earlySlot?.opts || []).map(o =>
  o.replace(/\(not running this week\)/, '').replace(/^[^A-Za-z]*Volleyball — /, '').trim());
console.log('levels offered, in order  :', JSON.stringify(names));
const expected = ['Intermediate', 'Advanced', 'Advanced +', 'Adv + Mixed', 'Adv + Men'];
const rightSet = JSON.stringify(names) === JSON.stringify(expected);
console.log('   matches the club\'s five :', rightSet);

// Tick it for 5:30 and save.
await pg.evaluate(() => {
  const cb = document.querySelector('input[data-sess="s1"][data-label="Adv + Men"]');
  if (cb && !cb.checked) cb.click();
  document.querySelector('#pm-save')?.click();
});
await pg.waitForTimeout(1200);
const saved = await pg.evaluate((K) => {
  const s = JSON.parse(localStorage.getItem(K));
  const p = Object.values(s.players || {}).find(x => /Ana/.test(x.name || ''));
  return { pass: p?.battlePass, holds: (p?.passLists || []).map(w => w.sessionId + ':' + w.label) };
}, KEY);
console.log('saved on her profile      :', JSON.stringify(saved));

// This Saturday does not run it at 5:30, so nobody is seated there.
await pg.goto('http://localhost:8099/?a=1#/event/evA', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1800);
const thisWeek = await pg.evaluate((K) => (JSON.parse(localStorage.getItem(K)).signups.evA || []).map(x => x.listId).sort(), KEY);
console.log('\nthis Saturday seats       :', JSON.stringify(thisWeek), '(none — she holds the 5:30 Adv + Men, which is not running)');

// Next Saturday does, so the seat is waiting.
await pg.goto('http://localhost:8099/?b=1#/event/evB', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1800);
const nextWeek = await pg.evaluate((K) => (JSON.parse(localStorage.getItem(K)).signups.evB || []).map(x => x.listId).sort(), KEY);
console.log('next Saturday seats       :', JSON.stringify(nextWeek), '(b1 is the 5:30 Adv + Men)');

console.log('errors:', errs.length ? errs : 'none');
const ok = hasAdvMenEarly && rightSet
        && saved.holds.includes('s1:Adv + Men')
        // She holds only the 5:30 Adv + Men. This Saturday does not run it,
        // so she is seated nowhere — a held spot waiting for its week costs
        // nothing and seats nobody.
        && thisWeek.length === 0
        && nextWeek.includes('b1')
        && !errs.length;
console.log('\n' + (ok
  ? 'a level can be held in either slot ahead of the week the club runs it there'
  : 'FAILED'));
await b.close();
process.exit(ok ? 0 : 1);
