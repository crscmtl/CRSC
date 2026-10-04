/*
 * Nobody is credited until an exec picks them, and the register is gone.
 *
 * Two things the club hit on the first night it ran a real Saturday.
 *
 * The match menu had no empty state, so it fell back to its first entry —
 * the first person alphabetically who still owed. Three different transfers
 * on screen all offered to pay off Alaïs Sondervorst, and one tap on the
 * green tick would have done it. That is the same wrong-person failure the
 * automatic matcher was switched off for, rebuilt as a UI default.
 *
 * And nobody taps "I'm here", so the record of a night 103 people played
 * read 20 showed up, 83 no-shows. A number that is wrong in a known
 * direction is worse than no number: every exec reading it has to remember
 * to ignore it. Check-in is a club setting now and it is off.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const KEY = 'crsc-demo-v7';
const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
const DATE = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const past = new Date(); past.setDate(past.getDate() - 7);
const PAST = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, '0')}-${String(past.getDate()).padStart(2, '0')}`;

const row = (id, name, listId, extra = {}) => ({
  id, listId, name, email: name.toLowerCase().replace(/[^a-z]/g, '') + '@x.com',
  phone: '', insta: '', photo: '', deviceId: 'd' + id, method: 'etransfer',
  paid: false, checkedIn: false, team: null, order: 1, createdAt: 1, ...extra,
});
const list = (id) => ({ id, sessionId: 's1', sport: 'volleyball', label: 'Advanced +', cap: 20, level: 3, priceE: 8, priceC: 10, teamCount: 0 });

const fixture = {
  settings: {}, removals: [], log: [], refunds: [], players: {},
  payments: [
    { id: 'p1', sender: 'SOMEBODY ELSE', amount: 8, message: '', receivedAt: Date.now() - 3600e3 },
    { id: 'p2', sender: 'ANOTHER PERSON', amount: 8, message: '', receivedAt: Date.now() - 7200e3 },
  ],
  events: [
    { id: 'ev', title: 'S', date: DATE, status: 'open', location: 'X', openEarly: true,
      sessions: [{ id: 's1', label: '5:30 - 7:30 PM' }], lists: [list('v1')], bundles: [], createdAt: 2 },
    { id: 'evPast', title: 'S', date: PAST, status: 'open', location: 'X',
      sessions: [{ id: 's1', label: '5:30 - 7:30 PM' }], lists: [list('p1l')], bundles: [], createdAt: 1 },
  ],
  signups: {
    ev: [row('su-a', 'Alais Sondervorst', 'v1'), row('su-b', 'Zed Last', 'v1')],
    // A played Saturday where nobody tapped "I'm here".
    evPast: [row('su-p1', 'Played One', 'p1l', { paid: true }), row('su-p2', 'Played Two', 'p1l', { paid: true })],
  },
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

const sel = await pg.evaluate(() =>
  [...document.querySelectorAll('[data-match-sel]')].map(s => ({
    chosen: s.options[s.selectedIndex]?.textContent.trim(), value: s.value,
  })));
console.log('what each transfer has selected:');
sel.forEach(x => console.log('   ', JSON.stringify(x.chosen), '| value', JSON.stringify(x.value)));
const nonePreselected = sel.length > 0 && sel.every(x => x.value === '');
console.log('   nobody pre-selected   :', nonePreselected, '(must be true)');

// Tapping the tick without choosing must do nothing.
await pg.evaluate(() => document.querySelector('[data-match-go]')?.click());
await pg.waitForTimeout(800);
const creditedAnyway = await pg.evaluate((K) =>
  (JSON.parse(localStorage.getItem(K)).signups.ev || []).some(x => x.paid), KEY);
console.log('   tick without choosing credits somebody:', creditedAnyway, '(must be false)');

// The played Saturday must not claim 2 no-shows.
await pg.evaluate(() => document.querySelector('.modal-overlay [data-close]')?.click());
await pg.waitForTimeout(400);
await pg.goto('http://localhost:8099/?p=1#/event/evPast', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1500);
const record = await pg.evaluate(() => ({
  stats: [...document.querySelectorAll('.stat')].map(s => s.textContent.replace(/\s+/g, ' ').trim()),
  noShowHeading: [...document.querySelectorAll('.section-sub')].map(h => h.textContent).join(' | '),
  checkInBtn: !!document.querySelector('#btn-self-in'),
}));
console.log('\nthe played Saturday shows:', JSON.stringify(record.stats));
const claimsNoShows = record.stats.some(s => /show/i.test(s)) || /never checked in|did not show/i.test(record.noShowHeading);
console.log('   mentions showed-up / no-shows:', claimsNoShows, '(must be false)');

console.log('errors:', errs.length ? errs : 'none');
const ok = nonePreselected && !creditedAnyway && !claimsNoShows && !record.checkInBtn && !errs.length;
console.log('\n' + (ok
  ? 'a transfer credits nobody until an exec names them, and the register is gone'
  : 'FAILED'));
await b.close();
process.exit(ok ? 0 : 1);
