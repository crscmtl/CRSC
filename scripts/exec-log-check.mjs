/*
 * Removals were recorded and nothing else was. Marking somebody paid,
 * granting a pass, grading a player, deleting an account — all anonymous,
 * which is fine with one exec and is how a committee argues about money.
 *
 * The PIN is shared, so the app cannot prove who held the phone. It records
 * the profile on the device and says so. This checks that each action lands
 * in the record with that name on it.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const KEY = 'crsc-demo-v7';
const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
const DATE = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fixture = {
  settings: {}, removals: [], payments: [], log: [],
  players: { dA: { deviceId: 'dA', name: 'Ana Costa', email: 'ana@x.com' } },
  events: [{ id: 'ev', title: 'S', date: DATE, status: 'open', location: 'X',
    sessions: [{ id: 's1', label: '5:30 - 7:30 PM' }],
    lists: [{ id: 'v1', sessionId: 's1', sport: 'volleyball', label: 'Advanced +', cap: 21, level: 0, priceE: 8, priceC: 10, teamCount: 3 }],
    bundles: [], createdAt: 1 }],
  signups: { ev: [{
    id: 'su1', listId: 'v1', name: 'Ana Costa', email: 'ana@x.com', phone: '', insta: '', photo: '',
    deviceId: 'dA', method: 'cash', paid: false, checkedIn: false, team: null, order: 1, createdAt: 1,
  }] },
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
await pg.waitForTimeout(1400);

// Open Ana's row, mark her paid, then record an odd amount.
await pg.evaluate(() => document.querySelector('[data-signup]')?.click());
await pg.waitForTimeout(500);
await pg.evaluate(() => document.querySelector('#pa-paid')?.click());
await pg.waitForTimeout(600);
await pg.evaluate(() => {
  const inp = document.querySelector('#pa-amount');
  if (inp) { inp.value = '5'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
  document.querySelector('#pa-amount-go')?.click();
});
await pg.waitForTimeout(700);
// And grade her. By the level's name, not its number — the rungs were
// renumbered when Adv + Men was added, and a test that hard-codes a rank
// goes quietly green-to-red for a reason that has nothing to do with the
// record it is checking.
await pg.evaluate(() => document.querySelector('#pa-level [title="Advanced"]')?.click());
await pg.waitForTimeout(700);
await pg.evaluate(() => document.querySelector('.modal-overlay [data-close]')?.click());
await pg.waitForTimeout(400);

const log = await pg.evaluate((K) => (JSON.parse(localStorage.getItem(K)).log || [])
  .map(e => ({ kind: e.kind, what: e.what, by: e.by })), KEY);
console.log('recorded:');
log.forEach(e => console.log(`   [${e.kind}] ${e.what}  — by ${e.by}`));

// And the exec can read it back.
await pg.goto('http://localhost:8099/#/', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1200);
await pg.evaluate(() => document.querySelector('#btn-log')?.click());
await pg.waitForTimeout(600);
const shown = await pg.evaluate(() =>
  [...document.querySelectorAll('.log-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()));
console.log('the history screen shows', shown.length, 'entries');

console.log('errors:', errs.length ? errs : 'none');
const kinds = new Set(log.map(e => e.kind));
const ok = kinds.has('paid') && kinds.has('amount') && kinds.has('level')
        && log.every(e => e.by === 'Juan')
        && log.some(e => /5\$/.test(e.what))
        && shown.length === log.length && shown.length > 0
        && !errs.length;
console.log('\n' + (ok
  ? 'every exec action lands in the record, with the device profile that did it'
  : 'FAILED'));
await b.close();
process.exit(ok ? 0 : 1);
