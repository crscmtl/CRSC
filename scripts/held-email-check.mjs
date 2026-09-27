/*
 * A pass holder gets one "your spot is held" email a week, not one per
 * Saturday of the season.
 *
 * Seats are put down for every remaining Saturday at once, so sending the
 * email when the seat was created meant a burst — Michel Fogarty got seven
 * in one minute. That reads as the app breaking rather than as good news,
 * and it buries the one that actually matters.
 *
 * Sign-ups open six days before a game, so a Saturday becomes open on the
 * Sunday before it. The email belongs to that moment: the week they are
 * about to play, while there is still time to say they cannot make it.
 *
 * Three things to hold:
 *   1. the OPEN Saturday sends one email,
 *   2. the ones still weeks away send none, though their seats exist,
 *   3. opening the page again sends nothing further.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const KEY = 'crsc-demo-v7';
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sat = new Date(); sat.setDate(sat.getDate() + ((6 - sat.getDay() + 7) % 7));
// The coming Saturday is open; the three after it are not yet.
const DATES = [0, 7, 14, 21].map(n => { const d = new Date(sat); d.setDate(d.getDate() + n); return iso(d); });

const lists = (eid) => [
  { id: eid + '-v1', sessionId: 's1', sport: 'volleyball', label: 'Advanced +', cap: 20, level: 0, priceE: 8, priceC: 10, teamCount: 0 },
  { id: eid + '-v2', sessionId: 's2', sport: 'volleyball', label: 'Adv + Mixed', cap: 20, level: 0, priceE: 8, priceC: 10, teamCount: 0 },
];

const fixture = {
  settings: { passAutoSeat: true, signupOpenDaysBefore: 6 },
  removals: [], payments: [], log: [], refunds: [],
  players: {
    dF: { deviceId: 'dF', name: 'Fogarty', email: 'fogarty@x.com', battlePass: '4h',
          passLists: [{ sport: 'volleyball', sessionId: 's1', label: 'Advanced +' },
                      { sport: 'volleyball', sessionId: 's2', label: 'Adv + Mixed' }] },
  },
  events: DATES.map((date, i) => ({
    id: 'ev' + i, title: 'S', date, status: 'open', location: 'Maisonneuve',
    sessions: [{ id: 's1', label: '5:30 - 7:30 PM' }, { id: 's2', label: '7:30 - 9:30 PM' }],
    lists: lists('ev' + i), bundles: [], createdAt: 1,
  })),
  signups: Object.fromEntries(DATES.map((_, i) => ['ev' + i, []])),
};

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext();
const errs = [];
const sent = [];

await ctx.route('**/firebase-config.js', r => r.fulfill({ contentType: 'application/javascript',
  body: 'window.FIREBASE_CONFIG=null;window.MAILER={url:"https://mailer.test/exec",secret:"x"};' }));
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

// An exec walks through every Saturday on the calendar, as one did.
for (let i = 0; i < DATES.length; i++) {
  await pg.goto(`http://localhost:8099/?v=${i}#/event/ev${i}`, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(1600);
}
const firstPass = sent.filter(m => /held|gardée|réservée/i.test(m.subject + m.message)).length;
console.log('after visiting all 4 Saturdays :', firstPass, 'held-spot emails (want 1 — only the open one)');

// Seats still exist for the ones weeks away; they just said nothing.
const seats = await pg.evaluate((K) => {
  const s = JSON.parse(localStorage.getItem(K));
  return Object.fromEntries(Object.entries(s.signups).map(([k, v]) => [k, (v || []).length]));
}, KEY);
console.log('seats put down per Saturday    :', JSON.stringify(seats));

// And going round again says nothing further.
for (let i = 0; i < DATES.length; i++) {
  await pg.goto(`http://localhost:8099/?again=${i}#/event/ev${i}`, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(1400);
}
const secondPass = sent.filter(m => /held|gardée|réservée/i.test(m.subject + m.message)).length;
console.log('after a second walk through    :', secondPass, 'total (want still 1)');
console.log('\nsubjects:', JSON.stringify([...new Set(sent.map(m => m.subject))]));

console.log('errors:', errs.length ? errs : 'none');
const seated = Object.values(seats).every(n => n === 2);
const ok = firstPass === 1 && secondPass === 1 && seated && !errs.length;
console.log('\n' + (ok
  ? 'one email, for the Saturday that just opened — the rest are held quietly'
  : 'FAILED'));
await b.close();
process.exit(ok ? 0 : 1);
