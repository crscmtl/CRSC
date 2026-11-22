/*
 * Getting your own name off a list.
 *
 * The way out was an 11px "✕" at the end of the player's own row, with its
 * only label in a title attribute — which a phone never shows. Players who
 * could not come were leaving their name on the list because they could not
 * find the way off it, so spots went to waste with people on the waitlist.
 *
 * So: a player's own row must carry a button with WORDS on it, big enough to
 * hit with a thumb; the row itself must open their spot; and the sheet it
 * opens must take the name off and file the removal against the player.
 *
 * Also the two readings that are easy to get wrong — somebody on a waitlist
 * is told they have no spot before being asked to give one up, and somebody
 * who has left it too late is told why rather than shown nothing.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const KEY = 'crsc-demo-v7';
const ME = 'dMe';

// Never today: on a Saturday the cancellation lock is already on, which
// would hide the very button this check is about.
const d = new Date();
d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
const iso = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const DATE = iso(d);
const TODAY = iso(new Date());

const player = (id, name, listId, order, deviceId) => ({
  id, listId, name, email: name.toLowerCase().replace(/ /g, '') + '@x.com',
  phone: '', insta: '', photo: '', deviceId: deviceId || 'd' + id,
  method: 'etransfer', paid: false, checkedIn: false, team: null,
  order, createdAt: order,
});

const sessions = [{ id: 's1', label: '5:30 - 7:30 PM' }, { id: 's2', label: '7:30 - 9:30 PM' }];
const lists = [
  // Capped at two, so the third name on it is a waitlist.
  { id: 'tight', sessionId: 's1', sport: 'volleyball', label: 'Advanced +', cap: 2, level: 3, priceE: 8, priceC: 10, teamCount: 0 },
  { id: 'roomy', sessionId: 's2', sport: 'volleyball', label: 'Intermediate', cap: 10, level: 1, priceE: 8, priceC: 10, teamCount: 0 },
];

const fixture = {
  settings: {}, removals: [], payments: [], log: [], refunds: [], players: {},
  events: [
    { id: 'ev', title: 'S', date: DATE, status: 'open', location: 'X',
      sessions, lists, bundles: [], createdAt: 1 },
    // Tonight: past the cancellation lock, so the sheet has to explain.
    { id: 'late', title: 'S', date: TODAY, status: 'open', location: 'X',
      sessions, lists, bundles: [], createdAt: 1 },
  ],
  signups: {
    ev: [
      player('su-a', 'Ana First', 'tight', 1),
      player('su-b', 'Bo Second', 'tight', 2),
      player('su-me-wl', 'Me Myself', 'tight', 3, ME),   // waitlist #1
      // Signed up from a laptop, opened on a phone: a different device id,
      // the same person. The app matches people by email everywhere else.
      { ...player('su-me', 'Me Myself', 'roomy', 4, 'dOtherLaptop'), email: 'memyself@x.com' },
    ],
    late: [player('su-late', 'Me Myself', 'roomy', 1, ME)],
  },
};

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const pg = await b.newPage();
const errs = []; pg.on('pageerror', e => errs.push(e.message));
await pg.route('**/firebase-config.js', r => r.fulfill({ contentType: 'application/javascript', body: 'window.FIREBASE_CONFIG=null;window.MAILER=null;' }));
await pg.addInitScript(({ KEY, fixture, ME }) => {
  if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify(fixture));
  // A player, not an exec: no crsc-exec in sessionStorage. "Mine" is decided
  // by the device id, which lives in its own key.
  localStorage.setItem('crsc-device-id', ME);
  localStorage.setItem('crsc-profile', JSON.stringify({ name: 'Me Myself', email: 'memyself@x.com', deviceId: ME }));
}, { KEY, fixture, ME });

await pg.goto('http://localhost:8099/#/event/ev', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1500);

const fail = [];

/* ---- 1. The button on their own row has words on it and a thumb can hit it. */
const row = await pg.evaluate(() => {
  const r = document.querySelector('[data-myspot="su-me"]');
  if (!r) return null;
  const btn = r.querySelector('button');
  const bx = btn && btn.getBoundingClientRect();
  return {
    tappable: true,
    label: btn ? btn.textContent.trim() : '',
    w: bx ? Math.round(bx.width) : 0,
    h: bx ? Math.round(bx.height) : 0,
  };
});
console.log('their own row in Intermediate (signed up on another device):');
if (!row) {
  console.log('    the row does not open at all');
  fail.push('own row is not tappable');
} else {
  console.log('    button reads        :', JSON.stringify(row.label));
  console.log('    button size         :', row.w + 'x' + row.h, 'px');
  // The old glyph was 2 characters wide and unlabelled.
  if (!/[a-z]/i.test(row.label)) fail.push('the button on their row has no words on it');
  if (row.w < 40) fail.push('the button on their row is ' + row.w + 'px wide');
}

/* ---- 1b. And the strip at the top says the row is worth tapping. */
const strip = await pg.evaluate(() => {
  const el = document.querySelector('.my-spots');
  return el ? (el.parentElement.textContent || '').replace(/\s+/g, ' ').trim() : '';
});
const tellsThem = /tap your name/i.test(strip);
console.log('    top of the event points at it :', tellsThem);
if (!strip) fail.push('"your spots" does not show for a sign-up from another device');
if (!tellsThem) fail.push('nothing tells a player their name is tappable');

/* ---- 2. Tapping the row opens the sheet, and it offers the way out. */
await pg.evaluate(() => document.querySelector('[data-myspot="su-me"]')?.click());
await pg.waitForTimeout(500);
const sheet = await pg.evaluate(() => {
  const ov = document.querySelector('.modal-overlay');
  if (!ov) return null;
  const rm = ov.querySelector('#ms-remove');
  const bx = rm && rm.getBoundingClientRect();
  return {
    remove: rm ? rm.textContent.trim() : '',
    wide: bx ? Math.round(bx.width) : 0,
    switch: !!ov.querySelector('#ms-switch'),
    text: ov.textContent,
  };
});
console.log('the sheet it opens:');
if (!sheet) {
  console.log('    nothing opened');
  fail.push('tapping their name opens nothing');
} else {
  console.log('    remove button reads :', JSON.stringify(sheet.remove));
  console.log('    its width           :', sheet.wide + 'px');
  console.log('    offers a change too :', sheet.switch);
  if (!sheet.remove) fail.push('the sheet does not offer to remove the name');
  if (sheet.wide < 150) fail.push('the remove button is only ' + sheet.wide + 'px wide');
  if (!/Intermediate/.test(sheet.text)) fail.push('the sheet does not say which list it is about');
}

/* ---- 3. It takes the name off, and files the removal against the player. */
await pg.evaluate(() => document.querySelector('#ms-remove')?.click());
await pg.waitForTimeout(400);
await pg.evaluate(() => document.querySelector('#cf-yes')?.click());
await pg.waitForTimeout(1200);

const after = await pg.evaluate(KEY => {
  const db = JSON.parse(localStorage.getItem(KEY));
  const left = (db.signups.ev || []).filter(s => s.listId === 'roomy').map(s => s.name);
  const rm = (db.removals || []).filter(r => r.eventId === 'ev');
  return { left, removals: rm.map(r => ({ name: r.name, by: r.by, listId: r.listId })) };
}, KEY);
console.log('after confirming:');
console.log('    still on Intermediate :', after.left.length ? after.left.join(', ') : '(nobody)');
console.log('    removals filed        :', JSON.stringify(after.removals));
if (after.left.includes('Me Myself')) fail.push('their name is still on the list');
if (!after.removals.some(r => r.by === 'self' && r.listId === 'roomy')) {
  fail.push('the removal was not filed against the player');
}

/* ---- 4. A waitlisted name is told it has no spot before giving one up. */
await pg.waitForTimeout(300);
await pg.evaluate(() => document.querySelector('[data-myspot="su-me-wl"]')?.click());
await pg.waitForTimeout(500);
const wl = await pg.evaluate(() => {
  const ov = document.querySelector('.modal-overlay');
  return ov ? ov.textContent.replace(/\s+/g, ' ').trim() : '';
});
const saysWaitlist = /waitlist/i.test(wl);
console.log('the sheet for their waitlisted name:');
console.log('    says they have no spot yet :', saysWaitlist);
if (!saysWaitlist) fail.push('a waitlisted player is not told they have no spot');
await pg.evaluate(() => document.querySelector('.modal-overlay [data-close]')?.click());

/* ---- 5. Too late to cancel: explain, do not just show nothing. */
await pg.goto('http://localhost:8099/#/event/late', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1400);
const locked = await pg.evaluate(() => {
  const r = document.querySelector('[data-myspot="su-late"]');
  if (!r) return { tappable: false };
  r.click();
  const ov = document.querySelector('.modal-overlay');
  return {
    tappable: true,
    offersRemove: !!(ov && ov.querySelector('#ms-remove')),
    text: ov ? ov.textContent.replace(/\s+/g, ' ').trim() : '',
  };
});
console.log('tonight, past the cancellation lock:');
console.log('    the row still opens   :', locked.tappable);
console.log('    offers to remove      :', locked.offersRemove);
console.log('    explains              :', /closed|exec/i.test(locked.text || ''));
if (!locked.tappable) fail.push('past the lock their row is a dead end');
if (locked.offersRemove) fail.push('past the lock it still offers a cancellation');
if (!/closed|exec/i.test(locked.text || '')) fail.push('past the lock nothing explains why');

/* ---- 6. On a phone it has to be ON the phone.
 *
 * This is the one that was really biting. The row did not wrap, so a long
 * name pushed the chips and the way out past the right edge of the screen:
 * the old "✕" sat at x=409 on a 390px phone, and the player had to scroll
 * sideways to reach it. A bigger button only made the row wider. */
await pg.setViewportSize({ width: 360, height: 760 });
await pg.goto('http://localhost:8099/#/event/ev', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1400);
const fits = await pg.evaluate(() => {
  const row = document.querySelector('[data-myspot="su-me-wl"]');
  const btn = row && row.querySelector('button');
  const bx = btn && btn.getBoundingClientRect();
  const nm = row && row.querySelector('.entry-name');
  return {
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    right: bx ? Math.round(bx.right) : 0,
    vw: window.innerWidth,
    nameW: nm ? Math.round(nm.getBoundingClientRect().width) : 0,
  };
});
console.log('on a 360px phone:');
console.log('    page scrolls sideways by :', fits.overflow + 'px');
console.log('    button right edge        :', fits.right + ' of ' + fits.vw);
console.log('    room left for the name   :', fits.nameW + 'px');
if (fits.overflow > 0) fail.push('the page scrolls sideways by ' + fits.overflow + 'px on a phone');
if (!fits.right || fits.right > fits.vw) fail.push('the button is off the right edge of a phone');
if (fits.nameW < 90) fail.push('the name is squeezed to ' + fits.nameW + 'px');

if (errs.length) {
  console.log('page errors:');
  errs.forEach(e => console.log('   ', e));
  fail.push(errs.length + ' page error(s)');
}

await b.close();
if (fail.length) {
  console.log('\nFAIL');
  fail.forEach(f => console.log('  -', f));
  process.exit(1);
}
console.log('\nPASS — a player can find their own name and take it off.');
