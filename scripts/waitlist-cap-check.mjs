/*
 * A waitlist has to end somewhere.
 *
 * An unbounded queue is a promise the club cannot keep: thirty names behind
 * two spare places have all been told "maybe", and the ones at the bottom
 * either turn up for nothing or stop believing the list. The club's limit is
 * five, so the sixth person to try must be turned away on the page rather
 * than discovering it at the gym.
 *
 * Execs are the exception, deliberately: somebody standing at the door who
 * has already handed over cash is a decision a human has made, so the limit
 * asks instead of refusing.
 *
 * And the exec who adds them must be able to record WHAT they handed over,
 * not just that they paid — a walk-in giving $20 for themselves and a friend
 * has not paid their own spot twice.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const KEY = 'crsc-demo-v7';
const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
const DATE = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// cap 1, waitlist limit 5 → one playing, five waiting, then shut.
const row = (i) => ({
  id: 'su' + i, listId: 'v1', name: 'Player ' + i, email: `p${i}@x.com`, phone: '', insta: '', photo: '',
  deviceId: 'd' + i, method: 'etransfer', paid: false, checkedIn: false, team: null,
  order: i, createdAt: i,
});

function fixtureWith(n) {
  return {
    settings: { waitlistMax: 5 }, removals: [], payments: [], log: [], refunds: [], players: {},
    events: [{ id: 'ev', title: 'S', date: DATE, status: 'open', location: 'X',
      sessions: [{ id: 's1', label: '5:30 - 7:30 PM' }],
      lists: [
        { id: 'v1', sessionId: 's1', sport: 'volleyball', label: 'Advanced +', cap: 1, level: 0, priceE: 8, priceC: 10, teamCount: 0 },
        { id: 'v2', sessionId: 's1', sport: 'volleyball', label: 'Advanced', cap: 20, level: 0, priceE: 8, priceC: 10, teamCount: 0 },
      ],
      bundles: [], createdAt: 1 }],
    signups: { ev: Array.from({ length: n }, (_, i) => row(i + 1)) },
  };
}

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errs = [];

async function open(fixture, who, exec) {
  const ctx = await b.newContext();
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push(e.message));
  await pg.route('**/firebase-config.js', r => r.fulfill({ contentType: 'application/javascript', body: 'window.FIREBASE_CONFIG=null;window.MAILER=null;' }));
  await pg.addInitScript(({ KEY, fixture, who, exec }) => {
    localStorage.setItem(KEY, JSON.stringify(fixture));
    localStorage.setItem('crsc-profile', JSON.stringify(who));
    localStorage.setItem('crsc-device-id', who.deviceId);
    if (exec) sessionStorage.setItem('crsc-exec', '1');
  }, { KEY, fixture, who, exec: !!exec });
  await pg.goto('http://localhost:8099/#/event/ev', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(1500);
  return pg;
}

/* What the sign-up sheet offers a newcomer. */
async function offer(n) {
  const pg = await open(fixtureWith(n), { name: 'New Person', email: 'new@x.com', deviceId: 'dNew' });
  await pg.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /sign up|join|inscri/i.test(x.textContent));
    if (b) b.click();
  });
  await pg.waitForTimeout(900);
  const state = await pg.evaluate(() => {
    const cb = document.querySelector('[data-list="v1"]');
    const label = cb?.closest('label');
    return { found: !!cb, disabled: !!cb?.disabled, text: (label?.textContent || '').replace(/\s+/g, ' ').trim() };
  });
  await pg.close();
  return state;
}

// 1 playing + 4 waiting = room for one more.
const room = await offer(5);
console.log('with 4 waiting  : selectable =', !room.disabled, '|', JSON.stringify(room.text));

// 1 playing + 5 waiting = shut.
const shut = await offer(6);
console.log('with 5 waiting  : selectable =', !shut.disabled, '|', JSON.stringify(shut.text));

// An exec can still add the person at the door, and say what they paid.
const pg = await open(fixtureWith(6), { name: 'Juan', email: 'juan@x.com', deviceId: 'dExec' }, true);
await pg.evaluate(() => document.querySelector('[data-exec-add="v1"]')?.click());
await pg.waitForTimeout(700);
const hasAmount = await pg.evaluate(() => !!document.querySelector('#ea-amount'));
console.log('exec-add has an amount box :', hasAmount);
await pg.evaluate(() => {
  document.querySelector('#ea-name').value = 'Walk In';
  document.querySelector('#ea-amount').value = '20';
  document.querySelector('#ea-save').click();
});
await pg.waitForTimeout(600);
await pg.evaluate(() => document.querySelector('#cf-yes')?.click());   // "add anyway"
await pg.waitForTimeout(900);
const added = await pg.evaluate((K) => (JSON.parse(localStorage.getItem(K)).signups.ev || [])
  .filter(x => x.name === 'Walk In').map(x => ({ amount: x.amountPaid, paid: !!x.paid, via: x.paidVia })), KEY);
console.log('walk-in recorded           :', JSON.stringify(added));
await pg.close();

console.log('errors:', errs.length ? errs : 'none');
const ok = room.found && !room.disabled
        && shut.found && shut.disabled && /full/i.test(shut.text)
        && hasAmount
        && added.length === 1 && added[0].amount === 20 && added[0].via === 'cash'
        && !errs.length;
console.log('\n' + (ok
  ? 'the queue stops at five, and an exec can still take the person at the door and what they paid'
  : 'FAILED'));
await b.close();
process.exit(ok ? 0 : 1);
