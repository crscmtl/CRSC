/*
 * Two members share a name — the club already has two Rayan Sedraoui — and
 * confirming a transfer by hand matched on the name string, so it settled
 * whichever one came first in the list. Silently: nothing looked wrong
 * afterwards, and the person who actually paid stayed marked unpaid.
 *
 * The dropdown now names the email beside the name, and settles the row the
 * exec actually picked.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const KEY = 'crsc-demo-v7';
const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
const DATE = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const row = (id, email) => ({
  id, listId: 'v1', name: 'Rayan Sedraoui', email, phone: '', insta: '', photo: '',
  deviceId: 'dev-' + id, method: 'etransfer', paid: false, checkedIn: false,
  team: null, order: id === 'su1' ? 1 : 2, createdAt: 1,
});

const fixture = {
  settings: {}, removals: [], players: {},
  payments: [{ id: 'pay1', sender: 'Rayan Sedraoui', amount: 8, message: '', matched: false, noAuto: true }],
  events: [{ id: 'ev', title: 'S', date: DATE, status: 'open', location: 'X',
    sessions: [{ id: 's1', label: '5:30 - 7:30 PM' }],
    lists: [{ id: 'v1', sessionId: 's1', sport: 'volleyball', label: 'Advanced +', cap: 21, level: 0, priceE: 8, priceC: 10, teamCount: 3 }],
    bundles: [], createdAt: 1 }],
  signups: { ev: [row('su1', 'rayansedraoui10@gmail.com'), row('su2', 'rayounasedraoui@gmail.com')] },
};

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const pg = await b.newPage();
const errs = []; pg.on('pageerror', e => errs.push(e.message));
await pg.route('**/firebase-config.js', r => r.fulfill({ contentType: 'application/javascript', body: 'window.FIREBASE_CONFIG=null;window.MAILER=null;' }));
await pg.addInitScript(({ KEY, fixture }) => {
  if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify(fixture));
  localStorage.setItem('crsc-profile', JSON.stringify({ name: 'Exec', email: 'e@x.com', deviceId: 'dExec' }));
  sessionStorage.setItem('crsc-exec', '1');
}, { KEY, fixture });

await pg.goto('http://localhost:8099/#/event/ev', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1400);
await pg.evaluate(() => [...document.querySelectorAll('button')].find(b => /payments/i.test(b.textContent))?.click());
await pg.waitForTimeout(700);

const options = await pg.evaluate(() =>
  [...document.querySelectorAll('[data-match-sel] option')].map(o => o.textContent.trim()));
console.log('the exec is offered:');
options.forEach(o => console.log('   ', o));
// The menu opens on "— pick a person —" so no one is credited by accident;
// the two Rayans are the entries after it.
const people = options.filter(o => /@/.test(o));
const tellsApart = options[0] === '— pick a person —'
                && people.length === 2 && new Set(people).size === 2;

// Pick the SECOND one — the one a name match would have got wrong.
await pg.evaluate(() => {
  const sel = document.querySelector('[data-match-sel]');
  sel.value = '1';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});
await pg.evaluate(() => document.querySelector('[data-match-go]')?.click());
await pg.waitForTimeout(1400);

const paid = await pg.evaluate((K) => {
  const st = JSON.parse(localStorage.getItem(K));
  return Object.fromEntries((st.signups.ev || []).map(s => [s.email, !!s.paid]));
}, KEY);
console.log('who is marked paid :', JSON.stringify(paid));
console.log('errors:', errs.length ? errs : 'none');

const ok = tellsApart
        && paid['rayounasedraoui@gmail.com'] === true
        && paid['rayansedraoui10@gmail.com'] === false
        && !errs.length;
console.log('\n' + (ok
  ? 'the exec can tell the two apart, and the one they picked is the one that gets paid'
  : 'FAILED — the wrong Rayan was settled'));
await b.close();
process.exit(ok ? 0 : 1);
