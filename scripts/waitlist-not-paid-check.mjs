/*
 * Owing nothing is not the same as having paid.
 *
 * A waitlisted player is charged nothing, because they never got on the
 * court. The screen decided who had paid by asking whether they owed
 * anything, so those two landed in PAID showing "0$ ✓" — on the club's
 * first full Saturday, Amine ouali at 21st and Diego Viveros at 22nd on a
 * list capped at 20, neither of whom had handed over a cent or was playing.
 *
 * An exec reading PAID (45) counts them as settled, and the one number the
 * club exists to get right quietly includes people who paid nothing.
 *
 * So: a waitlisted player appears under the waitlist, not under paid; the
 * money totals are unchanged, because they were always correct; and
 * somebody who actually paid still reads as paid.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const KEY = 'crsc-demo-v7';
const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
const DATE = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const row = (id, name, order, extra = {}) => ({
  id, listId: 'v1', name, email: name.toLowerCase().replace(/[^a-z]/g, '') + '@x.com',
  phone: '', insta: '', photo: '', deviceId: 'd' + id, method: 'etransfer',
  paid: false, checkedIn: false, team: null, order, createdAt: order, ...extra,
});

const fixture = {
  settings: {}, removals: [], payments: [], log: [], refunds: [], players: {},
  events: [{ id: 'ev', title: 'S', date: DATE, status: 'open', location: 'X', openEarly: true,
    sessions: [{ id: 's1', label: '5:30 - 7:30 PM' }],
    // Cap 2, so the third and fourth names are waiting.
    lists: [{ id: 'v1', sessionId: 's1', sport: 'volleyball', label: 'Adv + Mixed', cap: 2, level: 3, priceE: 8, priceC: 10, teamCount: 0 }],
    bundles: [], createdAt: 1 }],
  signups: { ev: [
    row('su1', 'Paid Player', 1, { paid: true }),
    row('su2', 'Owing Player', 2),
    row('su3', 'Amine Waiting', 3),
    row('su4', 'Diego Waiting', 4),
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
await pg.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => /payment/i.test(x.textContent));
  if (b) b.click();
});
await pg.waitForTimeout(900);

const view = await pg.evaluate(() => {
  const sections = {};
  let current = null;
  for (const el of document.querySelectorAll('.modal .section-sub, .modal .summary-list')) {
    if (el.classList.contains('section-sub')) { current = el.textContent.trim(); sections[current] = []; }
    else if (current) sections[current].push(...[...el.querySelectorAll('.entry')].map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  }
  return { sections, stats: [...document.querySelectorAll('.stat')].map(s => s.textContent.replace(/\s+/g, ' ').trim()) };
});
console.log('the Payments screen shows:');
for (const [h, rows] of Object.entries(view.sections)) {
  console.log('  ', h);
  rows.forEach(r => console.log('      ', r));
}
console.log('\nstats:', JSON.stringify(view.stats));

const paidHeading = Object.keys(view.sections).find(h => /^Paid/i.test(h)) || '';
const waitHeading = Object.keys(view.sections).find(h => /waitlist/i.test(h)) || '';
const paidRows = view.sections[paidHeading] || [];
const waitRows = view.sections[waitHeading] || [];
const waitersInPaid = paidRows.filter(r => /Waiting/.test(r));
console.log('\nwaitlisted people filed under Paid:', waitersInPaid.length, '(must be 0)');
console.log('waitlisted people shown as waiting:', waitRows.length, '(must be 2)');
console.log('the real payer is still under Paid:', paidRows.some(r => /Paid Player/.test(r)));

console.log('errors:', errs.length ? errs : 'none');
const ok = waitersInPaid.length === 0
        && waitRows.length === 2
        && paidRows.some(r => /Paid Player/.test(r))
        && /8\$/.test(view.stats.join(' '))
        && !errs.length;
console.log('\n' + (ok
  ? 'a name on the waitlist is never counted as paid, and the money is unchanged'
  : 'FAILED'));
await b.close();
process.exit(ok ? 0 : 1);
