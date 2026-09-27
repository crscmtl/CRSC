/*
 * Moving a held spot has to move it, not copy it.
 *
 * Essma's season pass was changed from holding one volleyball level to
 * holding another, and the old seat stayed where it was — so she was on two
 * lists at 5:30, which is the exact thing the rest of the app exists to
 * prevent. Nobody did anything wrong; the seating only ever added.
 *
 * (Both lists are volleyball because that is all a season pass may hold —
 * see pass-sport-check. This used to move a seat from football to
 * basketball, which the pass was never entitled to reserve.)
 *
 * A seat an exec has already marked paid, or that somebody has checked in
 * on, is a fact about that night rather than a standing reservation, so it
 * is left alone even when the pass moves.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const KEY = 'crsc-demo-v7';
const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
const DATE = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const L = (id, sport, label) => ({ id, sessionId: 's1', sport, label, cap: 21, level: 0, priceE: 8, priceC: 10, teamCount: 0 });
const seat = (id, listId, email, extra = {}) => ({
  id, listId, name: 'Essma', email, phone: '', insta: '', photo: '',
  deviceId: 'dE', method: 'etransfer', paid: false, checkedIn: false,
  team: null, order: -1, createdAt: 1, viaPass: true, ...extra,
});

const fixture = {
  settings: { passAutoSeat: true }, removals: [], payments: [], log: [],
  players: {
    // Her pass now holds Advanced +. The Advanced seat below is the one it
    // used to hold, and has to go.
    dE: { deviceId: 'dE', name: 'Essma', email: 'essma@x.com', battlePass: '4h',
          passLists: [{ sport: 'volleyball', sessionId: 's1', label: 'Advanced +' }] },
    // Somebody else's paid seat on a list their pass no longer holds: a fact
    // about the night, left alone.
    dP: { deviceId: 'dP', name: 'Paid Pat', email: 'pat@x.com', battlePass: '4h',
          passLists: [{ sport: 'volleyball', sessionId: 's1', label: 'Advanced +' }] },
  },
  events: [{ id: 'ev', title: 'S', date: DATE, status: 'open', location: 'X',
    sessions: [{ id: 's1', label: '5:30 - 7:30 PM' }],
    lists: [L('v0', 'volleyball', 'Advanced'), L('v1', 'volleyball', 'Advanced +')],
    bundles: [], createdAt: 1 }],
  signups: { ev: [
    seat('su-old', 'v0', 'essma@x.com'),
    { ...seat('su-paid', 'v0', 'pat@x.com'), name: 'Paid Pat', deviceId: 'dP', paid: true },
  ] },
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

const rows = () => pg.evaluate((K) => (JSON.parse(localStorage.getItem(K)).signups.ev || [])
  .map(s => `${s.name}@${s.listId}${s.paid ? ' (paid)' : ''}`).sort(), KEY);

// Read from the fixture: the page has not loaded yet, so there is no
// localStorage to look at.
console.log('before      :', JSON.stringify(fixture.signups.ev
  .map(s => `${s.name}@${s.listId}${s.paid ? ' (paid)' : ''}`).sort()));
await pg.goto('http://localhost:8099/#/event/ev', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1800);
const after = await rows();
console.log('after seating:', JSON.stringify(after));
console.log('errors:', errs.length ? errs : 'none');

const ok = after.includes('Essma@v1')          // seated where the pass holds now
        && !after.includes('Essma@v0')          // and no longer where it used to
        && after.includes('Paid Pat@v0 (paid)') // a paid seat is a fact, left alone
        && after.filter(x => x.startsWith('Essma')).length === 1
        && !errs.length;
console.log('\n' + (ok
  ? 'moving a held spot moves it, and a paid seat is left where it is'
  : 'FAILED'));
await b.close();
process.exit(ok ? 0 : 1);
