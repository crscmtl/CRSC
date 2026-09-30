/*
 * The Payments screen shows this Saturday's money, and nothing else.
 *
 * It listed every unmatched transfer the club had ever received, in one
 * undated column. Two weeks after launch that was 67 payments for games
 * already played against 5 for the coming Saturday, so an exec looking for
 * tonight's money was reading a screen that was 93% history with nothing on
 * it to say so — and crediting the wrong night took one tap. That is the
 * same mistake the automatic matcher made before it was switched off, only
 * by hand.
 *
 * Three things to hold:
 *   1. transfers sent since this Saturday opened are the ones offered, with
 *      a ✓ next to each,
 *   2. transfers from before that are not offered at all, only listed for
 *      the record behind a fold,
 *   3. every transfer shows its date, because an undated amount is what
 *      made the mistake possible.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const KEY = 'crsc-demo-v7';
const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
const DATE = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = 86400000;
const now = Date.now();

const fixture = {
  // Sign-ups open 6 days before, so "this week" starts 6 days before the game.
  settings: { signupOpenDaysBefore: 6, passPrice2h: 75, passPrice4h: 135 }, removals: [], log: [], refunds: [], players: {},
  payments: [
    { id: 'p-new1', sender: 'FRESH ONE', amount: 8, message: '', receivedAt: now - day },
    { id: 'p-new2', sender: 'FRESH TWO', amount: 15, message: '', receivedAt: now - 2 * day },
    { id: 'p-old1', sender: 'OLD PAYER A', amount: 8, message: '', receivedAt: now - 12 * day },
    { id: 'p-old2', sender: 'OLD PAYER B', amount: 10, message: '', receivedAt: now - 14 * day },
    { id: 'p-old3', sender: 'OLD PAYER C', amount: 15, message: '', receivedAt: now - 20 * day },
    // A season-pass price. Not a night's fee, so it belongs in its own
    // section — an exec who grants the bundle expects it to leave the list.
    { id: 'p-pass', sender: 'DENIZ GUNGOR', amount: 75, message: 'bundle payment for 2h', receivedAt: now - day },
  ],
  events: [{ id: 'ev', title: 'S', date: DATE, status: 'open', location: 'X',
    sessions: [{ id: 's1', label: '5:30 - 7:30 PM' }],
    lists: [{ id: 'v1', sessionId: 's1', sport: 'volleyball', label: 'Advanced +', cap: 20, level: 0, priceE: 8, priceC: 10, teamCount: 0 }],
    bundles: [], createdAt: 1 }],
  players: { dD: { deviceId: 'dD', name: 'Deniz Gungor', email: 'deniz@x.com' } },
  signups: { ev: [{
    id: 'su1', listId: 'v1', name: 'Unpaid Person', email: 'u@x.com', phone: '', insta: '', photo: '',
    deviceId: 'dU', method: 'etransfer', paid: false, checkedIn: false, team: null, order: 1, createdAt: 1,
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
await pg.waitForTimeout(1500);
await pg.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => /payment|money|sommaire|summary/i.test(x.textContent));
  if (b) b.click();
});
await pg.waitForTimeout(900);

const badge = await pg.evaluate(() => document.querySelector('#btn-summary')?.textContent.trim() || '');
const view = await pg.evaluate(() => ({
  offered: [...document.querySelectorAll('.pay-match[data-pay]')].map(r => r.querySelector('strong')?.textContent.trim()),
  dated: [...document.querySelectorAll('.pay-match[data-pay] .pay-when')].length,
  fold: !!document.querySelector('.older-pays'),
  passRows: [...document.querySelectorAll('[data-passpay]')].map(r => r.querySelector('strong')?.textContent.trim()),
}));

console.log('the Payments button says   :', JSON.stringify(badge), '(3 to deal with: 2 fees + 1 pass, not 6)');
console.log('offered for this Saturday :', JSON.stringify(view.offered));
console.log('   each one dated         :', view.dated, 'of', view.offered.length);
console.log('old backlog on screen     :', view.fold, '(must be false — it lives on the spreadsheet)');
console.log('season-pass payments      :', JSON.stringify(view.passRows), '(its own section)');

const oldOffered = view.offered.filter(n => /OLD PAYER/.test(n || ''));
console.log('\nold transfers offered for tonight:', oldOffered.length, '(must be 0)');

// Apply the pass payment, which is the thing an exec does after handing
// somebody a bundle — the transfer has to leave the screen afterwards.
await pg.evaluate(() => {
  const row = document.querySelector('[data-passpay]');
  const sel = row.querySelector('[data-pass-sel]');
  const i = [...sel.options].findIndex(o => /Deniz/i.test(o.textContent));
  if (i >= 0) sel.value = String(i);
  row.querySelector('[data-pass-go]').click();
});
await pg.waitForTimeout(1200);
const after = await pg.evaluate((K) => {
  const s = JSON.parse(localStorage.getItem(K));
  const who = Object.values(s.players || {}).find(p => /Deniz/i.test(p.name || ''));
  return {
    pass: who ? who.battlePass : null,
    stillListed: !!document.querySelector('[data-passpay]'),
    filed: (s.payments || []).find(p => p.id === 'p-pass'),
  };
}, KEY);
console.log('\nafter granting the bundle:');
console.log('   Deniz now holds          :', after.pass, '(must be 2h)');
console.log('   transfer still on screen :', after.stillListed, '(must be false)');
console.log('   transfer filed against   :', JSON.stringify(after.filed?.matchedTo), 'kind', JSON.stringify(after.filed?.kind));

console.log('errors:', errs.length ? errs : 'none');
const scopedHint = await pg.evaluate(() =>
  [...document.querySelectorAll('.hint')].some(h => /whole season|saison enti/i.test(h.textContent)));
console.log('points at the season view :', scopedHint);
const ok = view.offered.length === 2
        && /\b3\b/.test(badge) && !/\b6\b/.test(badge)
        && scopedHint
        && oldOffered.length === 0
        && view.dated === 2
        && view.fold === false
        && view.passRows.length === 1
        && !view.offered.includes('DENIZ GUNGOR')
        && after.pass === '2h' && after.stillListed === false
        && after.filed?.matchedTo === 'Deniz Gungor' && after.filed?.kind === 'pass'
        && !errs.length;
console.log('\n' + (ok
  ? 'only this Saturday\'s fees are in the match list; pass payments are separate and the old backlog is gone'
  : 'FAILED'));
await b.close();
process.exit(ok ? 0 : 1);
