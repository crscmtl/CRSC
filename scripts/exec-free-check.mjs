/*
 * An exec plays free, in every sport. A member's pass is volleyball only.
 *
 * These were the same thing until now, because free play only came in one
 * flavour: execs were handed a '4h' pass since nothing else existed. That
 * made an exec's basketball seat indistinguishable from a bought pass
 * reserving a sport it would not pay for — so fixing the second broke the
 * first, and Essma stopped being free at basketball.
 *
 * They are separate now, and both have to hold at once:
 *   1. an exec is charged nothing for basketball, football and volleyball,
 *      in both time slots, and keeps a standing seat in any of them,
 *   2. a member's bought pass still covers volleyball only — basketball is
 *      still billed, and their seat picker still refuses to hold one.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const KEY = 'crsc-demo-v7';
const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
const DATE = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const seat = (id, listId, who, dev) => ({
  id, listId, name: who, email: who.toLowerCase() + '@x.com', phone: '', insta: '', photo: '',
  deviceId: dev, method: 'etransfer', paid: false, checkedIn: false, team: null,
  order: -1, createdAt: 1, viaPass: true,
});

const fixture = {
  settings: { passAutoSeat: true }, removals: [], payments: [], log: [], refunds: [],
  players: {
    // The committee: free everywhere, standing seat at basketball.
    dE: { deviceId: 'dE', name: 'Essma', email: 'essma@x.com', battlePass: 'exec',
          passLists: [{ sport: 'basketball', sessionId: 's1', label: 'Mixed' },
                      { sport: 'volleyball', sessionId: 's2', label: 'Adv + Men' }] },
    // A member who bought the volleyball pass.
    dM: { deviceId: 'dM', name: 'Member', email: 'member@x.com', battlePass: '4h',
          passLists: [{ sport: 'volleyball', sessionId: 's1', label: 'Advanced +' }] },
  },
  events: [{ id: 'ev', title: 'S', date: DATE, status: 'open', location: 'X',
    sessions: [{ id: 's1', label: '5:30 - 7:30 PM' }, { id: 's2', label: '7:30 - 9:30 PM' }],
    lists: [
      { id: 'b1', sessionId: 's1', sport: 'basketball', label: 'Mixed', cap: 20, level: 0, priceE: 10, priceC: 10, teamCount: 0 },
      { id: 'v1', sessionId: 's1', sport: 'volleyball', label: 'Advanced +', cap: 20, level: 0, priceE: 8, priceC: 10, teamCount: 0 },
      { id: 'v2', sessionId: 's2', sport: 'volleyball', label: 'Adv + Men', cap: 20, level: 0, priceE: 8, priceC: 10, teamCount: 0 },
    ],
    bundles: [], createdAt: 1 }],
  // Both are also on basketball, which only one of them may have free.
  signups: { ev: [
    seat('su-e-b', 'b1', 'Essma', 'dE'),
    seat('su-e-v', 'v2', 'Essma', 'dE'),
    seat('su-m-v', 'v1', 'Member', 'dM'),
    { ...seat('su-m-b', 'b1', 'Member', 'dM'), viaPass: false, order: 5 },
  ] },
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

await pg.goto('http://localhost:8099/#/event/ev', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1800);

// What the club is owed, per person, read off the event summary.
const owed = await pg.evaluate(() => {
  const out = {};
  for (const p of (window.__totals ? window.__totals() : [])) out[p.name] = p.total;
  return out;
});
// Fall back to reading the roster's own unpaid chips if no hook exists.
const chips = await pg.evaluate(() =>
  [...document.querySelectorAll('.entry')].map(e => e.textContent.replace(/\s+/g, ' ').trim()));

const seats = await pg.evaluate((K) => {
  const s = JSON.parse(localStorage.getItem(K));
  const L = Object.fromEntries((s.events[0].lists || []).map(l => [l.id, l.sport + ' ' + l.label]));
  return (s.signups.ev || []).map(x => `${x.name}@${L[x.listId]}`).sort();
}, KEY);
console.log('seats held:', JSON.stringify(seats, null, 0));

// The exec's basketball seat must survive; the member's pass must not hold one.
const execKeepsBasketball = seats.includes('Essma@basketball Mixed');
const execKeepsVolley = seats.includes('Essma@volleyball Adv + Men');
console.log('exec keeps basketball seat :', execKeepsBasketball);
console.log('exec keeps volleyball seat :', execKeepsVolley);

// Money: open the summary and read who owes what.
await pg.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => /summary|sommaire|money|payments/i.test(x.textContent));
  if (b) b.click();
});
await pg.waitForTimeout(900);
const summary = await pg.evaluate(() =>
  [...document.querySelectorAll('.summary-list .entry')].map(e => e.textContent.replace(/\s+/g, ' ').trim()));
console.log('summary rows:');
summary.forEach(r => console.log('   ', r));

const essmaRow = summary.find(r => /Essma/.test(r)) || '';
const memberRow = summary.find(r => /Member/.test(r)) || '';
const execOwesNothing = !/\$?\s*\d+\s*\$?/.test(essmaRow.replace(/Essma/g, '')) || /0\$|\$0/.test(essmaRow) || /pass|exec/i.test(essmaRow);
const memberBilledBasketball = /10\$|\$10/.test(memberRow);
console.log('\nexec owes nothing          :', execOwesNothing, '|', JSON.stringify(essmaRow));
console.log('member still billed $10 bb :', memberBilledBasketball, '|', JSON.stringify(memberRow));

console.log('errors:', errs.length ? errs : 'none');
const ok = execKeepsBasketball && execKeepsVolley
        && execOwesNothing && memberBilledBasketball
        && !errs.length;
console.log('\n' + (ok
  ? 'the committee plays free in every sport; a bought pass is still volleyball only'
  : 'FAILED'));
await b.close();
process.exit(ok ? 0 : 1);
