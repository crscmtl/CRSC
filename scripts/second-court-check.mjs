/*
 * Opening a second court in the same time slot, and moving people onto it.
 *
 * Football was quiet, so an exec added another volleyball court at 5:30 and
 * went to move players across. The app refused: "one person per slot". The
 * person it meant was the one he was moving — identitiesInSession counted
 * the row being moved as somebody already in that slot, so anyone moving
 * WITHIN a time slot collided with themselves. Moving between slots had
 * always worked, which is why it went unnoticed.
 *
 * The second court also had the same name as the first, "Advanced +", so
 * every menu offered the same words twice with nothing to tell them apart.
 *
 * So: the move must go through, and the two courts must be distinguishable
 * where somebody has to choose between them.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const KEY = 'crsc-demo-v7';
const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
const DATE = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const player = (id, name, listId, order) => ({
  id, listId, name, email: name.toLowerCase().replace(/ /g, '') + '@x.com',
  phone: '', insta: '', photo: '', deviceId: 'd' + id, method: 'etransfer',
  paid: false, checkedIn: false, team: null, order, createdAt: order,
});

const fixture = {
  settings: {}, removals: [], payments: [], log: [], refunds: [], players: {},
  events: [{ id: 'ev', title: 'S', date: DATE, status: 'open', location: 'X',
    sessions: [{ id: 's1', label: '5:30 - 7:30 PM' }, { id: 's2', label: '7:30 - 9:30 PM' }],
    lists: [
      // The original 5:30 court, and the one the exec just opened beside it.
      { id: 'court1', sessionId: 's1', sport: 'volleyball', label: 'Advanced +', cap: 20, level: 3, priceE: 8, priceC: 10, teamCount: 0 },
      { id: 'court2', sessionId: 's1', sport: 'volleyball', label: 'Advanced +', cap: 18, level: 4, priceE: 8, priceC: 10, teamCount: 0 },
      // And an evening list, so moving between slots is covered too.
      { id: 'evening', sessionId: 's2', sport: 'volleyball', label: 'Adv + Men', cap: 19, level: 4, priceE: 8, priceC: 10, teamCount: 0 },
    ],
    bundles: [], createdAt: 1 }],
  signups: { ev: [
    player('su-a', 'Ana Moves', 'court1', 1),
    player('su-b', 'Bo Stays', 'court1', 2),
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
await pg.waitForTimeout(1500);

// Open Ana and read the move menu.
await pg.evaluate(() => document.querySelector('[data-signup="su-a"]')?.click());
await pg.waitForTimeout(700);
const options = await pg.evaluate(() =>
  [...document.querySelectorAll('#pa-move option')].map(o => o.textContent.trim()));
console.log('the move menu offers:');
options.forEach(o => console.log('   ', o));
const distinct = new Set(options).size === options.length;
console.log('   every entry distinguishable :', distinct);

// Move her to the new court in the SAME slot — the thing that was refused.
await pg.evaluate(() => {
  const sel = document.querySelector('#pa-move');
  sel.value = 'court2';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});
await pg.waitForTimeout(1200);
const where = await pg.evaluate((K) => {
  const s = JSON.parse(localStorage.getItem(K));
  const f = (s.signups.ev || []).find(x => x.id === 'su-a');
  return f ? f.listId : null;
}, KEY);
const refused = await pg.evaluate(() =>
  [...document.querySelectorAll('.toast, .toast-err')].map(t => t.textContent).join(' '));
console.log('\nAna is now on            :', JSON.stringify(where), '(must be court2)');
if (refused.trim()) console.log('toast shown              :', JSON.stringify(refused.trim()));

// Somebody genuinely double-booked in one slot must still be refused.
await pg.evaluate((K) => {
  const s = JSON.parse(localStorage.getItem(K));
  s.signups.ev.push({ id: 'su-dup', listId: 'court1', name: 'Ana Moves', email: 'anamoves@x.com',
    phone: '', insta: '', photo: '', deviceId: 'dsu-a', method: 'etransfer', paid: false,
    checkedIn: false, team: null, order: 9, createdAt: 9 });
  localStorage.setItem(K, JSON.stringify(s));
}, KEY);
await pg.goto('http://localhost:8099/?r=2#/event/ev', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1400);
await pg.evaluate(() => document.querySelector('[data-signup="su-dup"]')?.click());
await pg.waitForTimeout(700);
await pg.evaluate(() => {
  const sel = document.querySelector('#pa-move');
  if (!sel) return;
  sel.value = 'court2';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});
await pg.waitForTimeout(1000);
const dupWhere = await pg.evaluate((K) => {
  const s = JSON.parse(localStorage.getItem(K));
  const f = (s.signups.ev || []).find(x => x.id === 'su-dup');
  return f ? f.listId : null;
}, KEY);
console.log('a real double-booking is still refused:', dupWhere === 'court1', `(stayed on ${dupWhere})`);

console.log('errors:', errs.length ? errs : 'none');
const ok = distinct && where === 'court2' && dupWhere === 'court1' && !errs.length;
console.log('\n' + (ok
  ? 'players move onto a second court in the same slot, and the two courts are tellable apart'
  : 'FAILED'));
await b.close();
process.exit(ok ? 0 : 1);
