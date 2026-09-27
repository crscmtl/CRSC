/*
 * The season pass is a volleyball pass, and it must not hold anything else.
 *
 * The seat picker used to offer every list on the night, so an exec could
 * tick "Basketball — Mixed" as somebody's held spot. The app then reserved
 * that basketball seat every Saturday — while coveredSignupIds, which has
 * always covered volleyball and nothing else, refused to pay for it. The
 * result was two members reserved onto a sport they never chose and billed
 * $10 a week for it, on nine Saturdays, invisibly: a held seat looks exactly
 * like a seat you asked for.
 *
 * Two things must hold:
 *   1. a seat already standing on the wrong sport stops being held, so the
 *      next render takes it off and nobody is billed for it again,
 *   2. the picker cannot offer a non-volleyball list, so it cannot come back.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const KEY = 'crsc-demo-v7';
const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
const DATE = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fixture = {
  settings: {}, removals: [], payments: [], log: [], refunds: [],
  players: {
    // Exactly the live shape: a pass whose held spots are basketball.
    dE: { deviceId: 'dE', name: 'Essma', email: 'essma@x.com', battlePass: '4h',
          passLists: [{ sport: 'basketball', sessionId: 's1', label: 'Mixed' }] },
    // And one with both — the volleyball half must survive.
    dR: { deviceId: 'dR', name: 'Rayan', email: 'rayan@x.com', battlePass: '4h',
          passLists: [{ sport: 'basketball', sessionId: 's1', label: 'Men' },
                      { sport: 'volleyball', sessionId: 's2', label: 'Adv + Men' }] },
  },
  events: [{ id: 'ev', title: 'S', date: DATE, status: 'open', location: 'X',
    sessions: [{ id: 's1', label: '5:30 - 7:30 PM' }, { id: 's2', label: '7:30 - 9:30 PM' }],
    lists: [
      { id: 'b1', sessionId: 's1', sport: 'basketball', label: 'Mixed', cap: 20, level: 0, priceE: 10, priceC: 10, teamCount: 0 },
      { id: 'b2', sessionId: 's1', sport: 'basketball', label: 'Men',   cap: 20, level: 0, priceE: 10, priceC: 10, teamCount: 0 },
      { id: 'v1', sessionId: 's1', sport: 'volleyball', label: 'Advanced +', cap: 20, level: 0, priceE: 8, priceC: 10, teamCount: 0 },
      { id: 'v2', sessionId: 's2', sport: 'volleyball', label: 'Adv + Men',  cap: 20, level: 0, priceE: 8, priceC: 10, teamCount: 0 },
    ],
    bundles: [], createdAt: 1 }],
  // The seats the old code had already put down, exactly as they look live.
  signups: { ev: [
    { id: 'seat-b1-essma', listId: 'b1', name: 'Essma', email: 'essma@x.com', phone: '', insta: '', photo: '',
      deviceId: 'dE', method: 'etransfer', paid: false, checkedIn: false, viaPass: true, team: null, order: -1, createdAt: 1 },
    { id: 'seat-b2-rayan', listId: 'b2', name: 'Rayan', email: 'rayan@x.com', phone: '', insta: '', photo: '',
      deviceId: 'dR', method: 'etransfer', paid: false, checkedIn: false, viaPass: true, team: null, order: -1, createdAt: 2 },
  ] },
};

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const pg = await b.newPage();
const errs = []; pg.on('pageerror', e => errs.push(e.message));
await pg.route('**/firebase-config.js', r => r.fulfill({ contentType: 'application/javascript', body: 'window.FIREBASE_CONFIG=null;window.MAILER=null;' }));
await pg.addInitScript(({ KEY, fixture }) => {
  if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify(fixture));
  localStorage.setItem('crsc-profile', JSON.stringify({ name: 'Juan', email: 'juan@x.com', deviceId: 'dExec' }));
  sessionStorage.setItem('crsc-device-id', 'dExec');
  sessionStorage.setItem('crsc-exec', '1');
}, { KEY, fixture });

await pg.goto('http://localhost:8099/#/event/ev', { waitUntil: 'networkidle' });
await pg.waitForTimeout(2000);

const seats = await pg.evaluate((K) => {
  const s = JSON.parse(localStorage.getItem(K));
  const lists = Object.fromEntries((s.events[0].lists || []).map(l => [l.id, l.sport + ' ' + l.label]));
  return (s.signups.ev || []).map(x => ({ who: x.name, where: lists[x.listId], pass: !!x.viaPass }));
}, KEY);
console.log('seats now:');
seats.forEach(x => console.log('   ', x.who, '→', x.where, x.pass ? '(held by pass)' : ''));

const onBasketball = seats.filter(x => /basketball/.test(x.where || ''));
console.log('\nstill held on basketball:', onBasketball.length, '(must be 0)');
const rayanVolley = seats.some(x => x.who === 'Rayan' && /volleyball Adv \+ Men/.test(x.where || ''));
console.log('Rayan keeps his volleyball seat:', rayanVolley);

// And what the seat picker offers an exec now — the door the bad data came
// through. Registry → a player's PASS button → the held-spot checkboxes.
await pg.goto('http://localhost:8099/#/', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1400);
await pg.evaluate(() => document.querySelector('#btn-players')?.click());
await pg.waitForTimeout(800);
await pg.evaluate(() => document.querySelector('[data-pass]')?.click());
await pg.waitForTimeout(800);
const opts = await pg.evaluate(() =>
  [...document.querySelectorAll('.pass-opt')].map(l => l.textContent.replace(/\s+/g, ' ').trim()));
console.log('\npicker offers:', JSON.stringify(opts));

console.log('errors:', errs.length ? errs : 'none');
// An empty list would satisfy "all volleyball" while proving nothing, so
// the picker must actually be showing something.
const ok = onBasketball.length === 0 && rayanVolley
        && opts.length > 0
        && opts.every(o => /volley/i.test(o))
        && !opts.some(o => /basket|football/i.test(o))
        && !errs.length;
console.log('\n' + (ok
  ? 'the pass holds volleyball and only volleyball, and the wrong-sport seats are gone'
  : 'FAILED'));
await b.close();
process.exit(ok ? 0 : 1);
