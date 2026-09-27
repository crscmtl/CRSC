import {
  createStore, SPORTS, LEVELS, levelByRank, listLevel, uid, deviceId, setDeviceId, makeTemplateEvent, nextSaturday, saturdaysUntil, localISO,
} from './store.js';
import { t, tLang, getLang, setLang, locale } from './i18n.js';
import { promotionCandidate, sendMail, mailerConfigured } from './notify.js';
import { resolvePayment, nameHits, passPurchase, isTestTransfer, normalize } from './automatch.js';
import { initAuth, currentUser, signInWithGoogle, sendEmailLink, signOutNow, authReady } from './auth.js';

/* ================================================================== */
/* Small utilities                                                     */
/* ================================================================== */

/* ================================================================== */
/* Staying up to date                                                  */
/* ================================================================== */

/*
 * A tab left open keeps running the code it was loaded with, for days.
 *
 * That is not a theory: the sign-up duplicates were fixed, deployed and
 * proven, and two days later a pass holder was seated twice anyway — by an
 * exec's phone still running the version from before the fix. Giving each
 * deploy its own script URLs stopped a RELOAD picking up stale code; it
 * cannot do anything about a page that never reloads.
 *
 * So the page checks, and reloads itself when the club has shipped
 * something newer. The build id is the one the deploy stamped onto this
 * script's own URL, compared against the one it wrote beside the app.
 */
const BUILD = (() => {
  try { return new URL(import.meta.url).searchParams.get('v') || 'dev'; }
  catch (e) { return 'dev'; }
})();

let reloadWanted = false;

/* Never interrupt someone mid-action: a reload while a sheet is open loses
 * whatever they were typing. Take the first moment the screen is idle —
 * closing a sheet just removes it, so there is nothing to hook into, and
 * looking once a second costs nothing. */
function reloadWhenIdle() {
  if (reloadWanted) return;
  reloadWanted = true;
  const timer = setInterval(() => {
    if (document.querySelector('.modal-overlay')) return;
    clearInterval(timer);
    location.reload();
  }, 1000);
}

async function checkForNewBuild() {
  if (BUILD === 'dev') return;            // running locally, or unstamped
  try {
    const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const { v } = await res.json();
    if (v && v !== BUILD) reloadWhenIdle();
  } catch (e) { /* offline, or the file is not there yet */ }
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(locale(), { weekday: 'long', month: 'long', day: 'numeric' });
}

function fmtDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString(locale(), { month: 'short', day: 'numeric' });
}

/* Date + time of an action, e.g. "Sep 12, 8:14 p.m." */
function fmtStamp(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString(locale(), {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function fmtMoney(n) {
  return (n === Math.floor(n) ? n : n.toFixed(2)) + '$';
}

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3200);
}

function openModal(html, { wide = false } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal ${wide ? 'modal-wide' : ''}" role="dialog">${html}</div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  $$('[data-close]', overlay).forEach(b => b.addEventListener('click', () => overlay.remove()));
  return overlay;
}

/*
 * A sheet that keeps up with the database.
 *
 * openModal paints once. That is fine for a confirmation, and wrong for
 * anything showing money: two execs on the door would open the Payments
 * screen, one would mark somebody paid, and the other would go on looking
 * at a page that said otherwise. Same club, two different answers.
 *
 * These rebuild themselves whenever a change arrives. Two things are
 * protected while that happens: whatever somebody is typing or has picked
 * (a rebuild that wiped a half-filled amount would be its own bug), and
 * where they have scrolled to.
 */
const liveModals = new Set();
let rebuilding = false;

function liveModal(build, opts = {}) {
  const ov = openModal('', opts);
  const entry = { ov, build };
  liveModals.add(entry);
  build(ov);
  return ov;
}

function refreshLiveModals() {
  if (rebuilding) return;
  rebuilding = true;
  try {
    for (const entry of [...liveModals]) {
      if (!entry.ov.isConnected) { liveModals.delete(entry); continue; }
      // Never pull the page out from under somebody mid-action.
      if (entry.ov.contains(document.activeElement)
          && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) continue;
      const scrolls = $$('.summary-list', entry.ov).map(el => el.scrollTop);
      const top = entry.ov.querySelector('.modal')?.scrollTop || 0;
      entry.build(entry.ov);
      $$('.summary-list', entry.ov).forEach((el, i) => { el.scrollTop = scrolls[i] || 0; });
      const m = entry.ov.querySelector('.modal');
      if (m) m.scrollTop = top;
    }
  } finally {
    rebuilding = false;
  }
}

/* `alert: true` states something rather than asking it — one button, no
 * destructive option to tap by accident. */
function confirmModal(message, confirmLabel, { alert = false } = {}) {
  return new Promise(resolve => {
    const ov = openModal(`
      <div class="modal-body">
        <p class="confirm-msg">${esc(message)}</p>
        <div class="row gap">
          ${alert ? '' : `<button class="btn btn-ghost grow" data-close>${esc(t('cancel'))}</button>`}
          <button class="btn ${alert ? 'btn-primary' : 'btn-danger'} grow" id="cf-yes">${esc(confirmLabel || t('confirm'))}</button>
        </div>
      </div>`);
    $('#cf-yes', ov).addEventListener('click', () => { ov.remove(); resolve(true); });
    ov.addEventListener('click', e => { if (e.target === ov) resolve(false); });
    $$('[data-close]', ov).forEach(b => b.addEventListener('click', () => resolve(false)));
  });
}

/* ================================================================== */
/* Local identity                                                      */
/* ================================================================== */

function getProfile() {
  try { return JSON.parse(localStorage.getItem('crsc-profile')) || null; } catch (e) { return null; }
}
function saveProfile(p) {
  try { localStorage.setItem('crsc-profile', JSON.stringify(p)); } catch (e) { /* ignore */ }
}

/*
 * Who may change things.
 *
 * It used to be whoever typed four digits, and those four digits sat in a
 * publicly readable record — so the gate stopped honest accidents and
 * nothing else. Now it is an allowlist of addresses, checked against the
 * one the person actually proved by signing in. Execs manage the list
 * themselves; nobody can add themselves to it without already being on it.
 *
 * Demo mode has no Firebase and so nobody to sign in. There the old
 * session flag still opens exec mode, which is what makes the demo and the
 * whole test suite work without accounts.
 */
/* How much sign-in the club is asking for today. See DEFAULT_SETTINGS. */
function signInMode() {
  const m = state.settings?.signInMode;
  return m === 'optional' || m === 'required' ? m : 'off';
}
function signInOffered() { return authReady() && signInMode() !== 'off'; }

function execEmails() {
  const list = state.settings?.execEmails;
  return Array.isArray(list) ? list.map(e => String(e).trim().toLowerCase()).filter(Boolean) : [];
}

function isExec() {
  // Lowercased here rather than trusted from the caller: this one
  // comparison decides who can change the club's money, and Gmail does not
  // care about capitals even though === does.
  const email = (currentUser()?.email || '').trim().toLowerCase();
  if (email && execEmails().includes(email)) return true;
  // The PIN is on its way out, and still the way in for an exec who has
  // not signed in yet. It stops working the moment the club requires
  // sign-in, which is the point at which everyone has an account.
  if (signInMode() === 'required' && authReady()) return false;
  return sessionStorage.getItem('crsc-exec') === '1';
}
function setExec(on) {
  if (on) sessionStorage.setItem('crsc-exec', '1');
  else sessionStorage.removeItem('crsc-exec');
}

function fileToThumb(file, size = 128) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = reject;
    img.src = url;
  });
}

/* ================================================================== */
/* App state                                                           */
/* ================================================================== */

let store = null;
let state = { settings: {}, events: [], signups: {} };
const DEVICE = deviceId();

/* ================================================================== */
/* Domain helpers                                                      */
/* ================================================================== */

function eventSignups(eventId) {
  return state.signups[eventId] || [];
}

/* Has this week's roster actually arrived? An undefined entry means "not
 * fetched yet" — very different from a night nobody signed up for, and the
 * difference matters when the screen is reporting a week's takings. */
function signupsLoaded(eventId) {
  return Array.isArray(state.signups[eventId]);
}

function listEntries(eventId, listId) {
  return eventSignups(eventId)
    .filter(s => s.listId === listId)
    .sort((a, b) => (a.order ?? a.createdAt ?? 0) - (b.order ?? b.createdAt ?? 0));
}

function splitByCap(entries, cap) {
  return { confirmed: entries.slice(0, cap), waitlist: entries.slice(cap) };
}

/*
 * Who a sign-up belongs to.
 *
 * Email first, device second. A device id changes when somebody clears
 * their browser, picks up the site on a second phone, or registers twice by
 * accident — and every "are you already on this list" check that keyed off
 * the device then failed open, which is how one person ended up on the same
 * list three times. Email is the thing that follows the human.
 */
function identityOf(x) {
  const email = (x.email || '').trim().toLowerCase();
  if (email) return 'e:' + email;
  if (x.deviceId && x.deviceId !== 'exec-added') return 'd:' + x.deviceId;
  return 'n:' + (x.name || '').trim().toLowerCase();
}

function myIdentity() {
  const p = getProfile();
  return identityOf({ email: p?.email, deviceId: DEVICE, name: p?.name });
}

/* This person's spots, however many devices or profiles they have made. */
function mySignups(eventId) {
  const me = myIdentity();
  return eventSignups(eventId).filter(s => identityOf(s) === me);
}

/* Everyone already in this time slot, by identity. */
function identitiesInSession(ev, sessionId) {
  const out = new Set();
  for (const su of eventSignups(ev.id)) {
    const l = listById(ev, su.listId);
    if (l && l.sessionId === sessionId) out.add(identityOf(su));
  }
  return out;
}

function listById(event, listId) {
  return (event.lists || []).find(l => l.id === listId);
}

/* Team-count choices per sport (volleyball: at most 4 teams). */
function teamOptionsFor(sport) {
  const max = SPORTS[sport]?.maxTeams;
  const all = [2, 3, 4, 6];
  return max ? all.filter(n => n <= max) : all;
}
function sessionById(event, sessionId) {
  return (event.sessions || []).find(s => s.id === sessionId);
}

function todayStr() {
  return localISO();
}

/* An event whose Saturday has passed becomes a read-only record automatically. */
function isPastEvent(ev) {
  return !!ev.date && ev.date < todayStr();
}

/*
 * Registration opens on a rolling weekly window: a Saturday becomes
 * signable on the Sunday before it (6 days ahead by default), so only the
 * coming Saturday takes sign-ups while later ones sit on the calendar as
 * "opens later". An exec can open any date early from the event page.
 */
function eventOpensAt(ev) {
  if (!ev.date) return 0;
  const days = parseFloat(state.settings.signupOpenDaysBefore);
  const ahead = isNaN(days) ? 6 : days;
  const d = new Date(ev.date + 'T00:00:00');
  d.setDate(d.getDate() - ahead);
  return d.getTime();
}

/* A future event whose sign-up window has not started yet. */
function isScheduled(ev) {
  if (ev.status !== 'open' || isPastEvent(ev) || ev.openEarly) return false;
  return Date.now() < eventOpensAt(ev);
}

function isEventOpen(ev) {
  return ev.status === 'open' && !isPastEvent(ev) && !isScheduled(ev);
}

/*
 * Self-removal closes N hours before the first session (default 24h, so the
 * waitlist has time to fill freed spots). Execs can still remove anyone.
 */
function cancellationLocked(ev) {
  if (!ev.date) return false;
  // A deliberate 0 means "cancel right up to the whistle". `|| 24` read that
  // as unset and locked people out a day early — invisible until the event
  // is today, which is the only day it matters. Same trap a level of 0 fell
  // into: fall back because the setting is missing, never because it is zero.
  const raw = parseFloat(state.settings.cancelLockHours);
  const hours = isFinite(raw) ? raw : 24;
  const start = new Date(ev.date + 'T17:00:00');
  return Date.now() >= start.getTime() - hours * 3600 * 1000;
}

/* Season Battle Pass (volleyball only): '4h' | '2h' | null, set by execs
 * on the player's registry entry. */
/*
 * The club's record of a player, found by identity rather than by whichever
 * device is asking.
 *
 * Somebody who registered twice has two player records on one email. A pass
 * or a level set on one of them was invisible to sign-ups made from the
 * other, so the pass covered their games some weeks and not others — which
 * looks exactly like the app losing track of what they paid for. When two
 * records share an identity, the one carrying a pass or a level wins: an
 * exec set that deliberately, and the empty record is the accident.
 */
let playerIndex = null;
function playerByIdentity(x) {
  if (!playerIndex) {
    playerIndex = {};
    for (const p of Object.values(state.players || {})) {
      const id = identityOf(p);
      const cur = playerIndex[id];
      if (!cur || (!cur.battlePass && p.battlePass) || (!cur.level && p.level)) playerIndex[id] = p;
    }
  }
  return playerIndex[identityOf(x)] || null;
}

/* Accepts a device id (most call sites) or any object carrying an email. */
function playerRecord(who) {
  if (!who) return null;
  if (typeof who === 'string') {
    const direct = (state.players || {})[who];
    return playerByIdentity(direct || { deviceId: who });
  }
  return playerByIdentity(who);
}

/*
 * Somebody's season pass, as it stands on a given Saturday.
 *
 * A pass buys a season, not a lifetime. Without the date a fall pass kept
 * holding seats into the winter and kept paying for the winter's volleyball,
 * so every question that depends on a particular night — is this spot held,
 * is it covered, what does this person owe — asks with that night's date.
 * Editing the pass itself asks without one, because an exec looking at a
 * player's record wants to see the pass that is there, expired or not.
 */
function playerPass(who, onDate = null) {
  const rec = playerRecord(who);
  if (!rec?.battlePass) return null;
  if (onDate && rec.passUntil && onDate > rec.passUntil) return null;
  return rec.battlePass;
}

/* Has this pass run out, as of today? Shown to execs so a renewal is
 * something they can see coming rather than discover. */
function passExpired(who) {
  const rec = playerRecord(who);
  return !!(rec?.battlePass && rec.passUntil && todayStr() > rec.passUntil);
}

/*
 * A player's graded level, set by an exec. Null until someone grades them —
 * a new member plays their first night wherever they like, and the club
 * decides afterwards where they belong.
 */
function playerLevel(who) {
  const r = playerRecord(who)?.level;
  return r ? Number(r) : null;
}

/*
 * May this device sign itself up for this list?
 *
 * Ungraded players and ungraded lists are always allowed. A graded player
 * may play at their level and anything below it. Execs are never gated —
 * they place people by hand, which is how someone gets moved up.
 */
function canSelfJoin(list) {
  const need = listLevel(list);
  if (!need) return true;
  const mine = playerLevel(DEVICE);
  if (!mine) return true;
  return mine >= need;
}

/*
 * The time slots this device already holds a spot in.
 *
 * One person, one spot per slot: nobody plays two lists at 7:30, and a
 * second name in the same hour is a confirmed place the club cannot fill
 * and a head it counts twice. Different slots are fine and expected — the
 * 4h volleyball bundle is exactly that, and so is basketball then
 * volleyball. `exceptId` lets a sign-up ignore its own slot while it is
 * being moved out of it.
 */
function mySessionIds(ev, exceptId = null) {
  const out = new Set();
  for (const su of mySignups(ev.id)) {
    if (su.id === exceptId) continue;
    const l = listById(ev, su.listId);
    if (l) out.add(l.sessionId);
  }
  return out;
}

/*
 * The lists a pass holder is seated in every week — sport + time slot +
 * level, matched by name so it follows the player into each new Saturday.
 * A 2h pass holds one; a 4h pass can hold one in each time slot.
 */
/*
 * The season pass is a VOLLEYBALL pass. That is what the club sells — the
 * note says so, the price says so, and coveredSignupIds has always honoured
 * it by covering volleyball spots and nothing else.
 *
 * The seat picker used to offer every list on the night, so an exec could
 * tick "Basketball — Mixed" for a pass holder. The app then dutifully held
 * that basketball seat every single Saturday, and the coverage rule refused
 * to pay for it — so two members were reserved onto a sport they had not
 * asked for and billed $10 a week for the privilege. Seventeen seats across
 * nine Saturdays before anybody noticed, because a held seat looks exactly
 * like a seat you chose.
 *
 * Filtering here rather than in each of the six callers means the seating,
 * the billing, the picker and the re-save can never disagree about what a
 * pass holds — and the seats already standing on the wrong sport stop being
 * held, so the next render takes them off.
 */
const PASS_SPORT = 'volleyball';

function passLists(player) {
  if (!Array.isArray(player?.passLists)) return [];
  return player.passLists.filter(w => w && w.sport === PASS_SPORT);
}

/*
 * The document id of a pass holder's standing seat.
 *
 * Deterministic on purpose. A held spot is "this person, this time slot" —
 * one fact, so it gets one row, and writing it again lands on the same row
 * instead of making a new one. That is what finally stopped the multiplying:
 * the guards below decide when NOT to write, and this decides that a write
 * that slips through anyway cannot become a duplicate.
 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

function passSeatId(identity, listId) {
  // Slugged for readability, hashed so two identities can never share an id.
  const slug = identity.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  return 'seat-' + listId + '-' + slug + '-' + fnv1a(identity);
}

function findList(ev, want) {
  return (ev.lists || []).find(l =>
    l.sport === want.sport && l.sessionId === want.sessionId && l.label === want.label);
}

/*
 * Seat the season-pass holders.
 *
 * A pass is a standing reservation: the club took a season's money up front,
 * so the spot is theirs before sign-ups open and stays theirs whether or not
 * they remember to sign up. They tell an exec when they cannot make it and
 * the exec takes the name off for that week — which is why this only ever
 * ADDS a missing seat and never re-adds one somebody removed on purpose.
 *
 * `order: -1` puts them above the walk-up queue, so a held spot cannot be
 * pushed onto the waitlist by people signing up at midnight on Sunday.
 */
/*
 * Seat the season-pass holders.
 *
 * Three things made this multiply people instead of seating them, and all
 * three have to hold for it to be safe:
 *
 *  - It ran on every render, without waiting for itself. Its own writes
 *    caused the next render, which started another run against a roster
 *    snapshot taken before the previous writes landed, so every pass holder
 *    was added again on every pass. It runs once per event per page now, and
 *    never twice at once.
 *  - It recognised an existing seat by device id, so a pass holder with two
 *    profiles never matched their own row and was seated afresh each time.
 *    Identity, like everywhere else.
 *  - It only checked the exact list, so a holder already playing something
 *    else at 7:30 got a second 7:30 seat. One spot per slot applies to held
 *    spots too.
 *
 * A pass is a standing reservation: the club took a season's money up front,
 * so the spot is theirs whether or not they remember to sign up. They tell an
 * exec when they cannot make it and the exec takes the name off, which is why
 * this only ever ADDS a missing seat and never re-adds a removed one.
 */
let seating = false;
const seatedEvents = new Set();

async function seatPassHolders(ev) {
  if (!isExec() || !state.settings.passAutoSeat) return;
  if (ev.status !== 'open' || isPastEvent(ev)) return;
  if (seating || seatedEvents.has(ev.id)) return;
  // The roster has to be HERE before we can tell who is already seated.
  // renderEvent starts watching the event and calls this in the same breath,
  // so on the first render the snapshot has not arrived and every sign-up is
  // invisible — which is how a page load kept seating everybody afresh. Do
  // nothing and stay unmarked: the render that follows the snapshot calls
  // again, and that one can see.
  if (!signupsLoaded(ev.id)) return;
  seating = true;
  seatedEvents.add(ev.id);
  try {
    const removed = new Set((state.removals || [])
      .filter(r => r.eventId === ev.id)
      .map(r => identityOf(r) + '|' + r.listId));
    // One record per human: a duplicate profile must not earn a second seat.
    const holders = {};
    for (const player of Object.values(state.players || {})) {
      if (!player.battlePass || !passLists(player).length) continue;
      const id = identityOf(player);
      if (!holders[id] || passLists(holders[id]).length < passLists(player).length) holders[id] = player;
    }
    /*
     * Seats the pass no longer holds, worked out BEFORE anything is added.
     *
     * Moving somebody's held spot from one list to another used to leave the
     * old seat standing, so they were on two lists at 5:30 — the exact thing
     * the rest of the app exists to prevent. The order matters as much as
     * the rule: while the old seat is still on the roster it counts as
     * "already playing at 5:30", so deciding the drop afterwards would take
     * the football seat away and never put the basketball one down.
     *
     * Only untouched seats go. One an exec has marked paid, or that somebody
     * has checked in on, is a fact about that night rather than a standing
     * reservation, and the club can take that name off by hand if it should.
     */
    const drop = [];
    for (const su of eventSignups(ev.id)) {
      if (!su.viaPass || su.paid || su.checkedIn || su.amountPaid) continue;
      const holder = holders[identityOf(su)];
      const list = listById(ev, su.listId);
      if (!list) continue;
      const stillHeld = holder && !(holder.passUntil && ev.date > holder.passUntil)
        && passLists(holder).some(w =>
          w.sport === list.sport && w.sessionId === list.sessionId && w.label === list.label);
      if (!stillHeld) drop.push(su);
    }
    const dropping = new Set(drop.map(su => su.id));
    for (const su of drop) {
      // Straight out, not through removeSignup: a standing reservation the
      // club withdrew is not the player walking away from a game, and
      // filing it in the proof trail would say it was.
      await store.deleteSignup(ev.id, su.id);
    }
    if (drop.length) toast(t('passSeatDropped', { n: drop.length }), 'warn');

    const adds = [];
    // Slots claimed so far, counting the ones this run is about to add.
    const claimed = {};
    for (const [id, player] of Object.entries(holders)) {
      // A pass that has run out stops holding spots on the next Saturday.
      if (player.passUntil && ev.date > player.passUntil) continue;
      for (const want of passLists(player)) {
        const list = findList(ev, want);
        if (!list) continue;
        const key = id + '|' + list.sessionId;
        if (claimed[key]) continue;
        // Already playing then — but a seat this run just withdrew does not
        // count, or moving a held spot could never put the new one down.
        const here = eventSignups(ev.id).some(su => !dropping.has(su.id)
          && listById(ev, su.listId)?.sessionId === list.sessionId
          && identityOf(su) === id);
        if (here) continue;
        if (removed.has(id + '|' + list.id)) continue;                  // taken off on purpose
        claimed[key] = true;
        adds.push({
          id: passSeatId(id, list.id), listId: list.id, name: player.name,
          email: player.email || '', phone: player.phone || '', insta: player.insta || '',
          photo: player.photo || '', method: 'etransfer', deviceId: player.deviceId,
          paid: false, checkedIn: false, lang: player.lang || 'en',
          viaPass: true, order: -1, createdAt: Date.now(),
        });
      }
    }
    if (adds.length) {
      // seatSignups skips ids that already exist, so a seat an exec has
      // since marked paid is never rewritten back to unpaid.
      const fresh = await store.seatSignups(ev.id, adds);
      if (fresh.length) {
        toast(t('passSeated', { n: fresh.length }));
        // Tell the holders their spot is waiting, while there is still time
        // for them to say they cannot make it.
        notifySeatHeld(ev, fresh).catch(err => console.error('seat email', err));
      }
    }
  } catch (err) {
    console.error('seat pass holders', err);
    seatedEvents.delete(ev.id);      // let a later render try again
  } finally {
    seating = false;
  }
}

/*
 * Price for a set of lists (one person, one event), applying bundles:
 * if a bundle exists for a sport and the person plays that sport in 2+
 * time slots, the bundle price replaces the per-slot prices for that sport.
 * A Battle Pass zeroes volleyball: '4h' covers everything, '2h' covers the
 * earliest slot and any extra volleyball is charged per list (no bundle) —
 * this must stay consistent with coveredSignupIds below.
 */
function computePrice(event, listIds, method, pass = null) {
  const key = method === 'cash' ? 'priceC' : 'priceE';
  const bySport = {};
  let total = 0;
  const parts = [];
  for (const id of listIds) {
    const l = listById(event, id);
    if (!l) continue;
    (bySport[l.sport] = bySport[l.sport] || []).push(l);
  }
  for (const [sport, lists] of Object.entries(bySport)) {
    if (sport === 'volleyball' && pass) {
      const sorted = [...lists].sort((a, b) => (a.sessionId || '').localeCompare(b.sessionId || ''));
      sorted.forEach((l, i) => {
        const covered = pass === '4h' || i === 0;
        const price = covered ? 0 : (l[key] ?? 0);
        total += price;
        parts.push({
          label: `${SPORTS[sport].label} — ${l.label}${covered ? ' · ' + t('battlePass') : ''}`,
          price,
        });
      });
      continue;
    }
    const sessions = new Set(lists.map(l => l.sessionId));
    const bundle = (event.bundles || []).find(b => b.sport === sport);
    if (bundle && sessions.size >= 2) {
      total += bundle[key] ?? 0;
      parts.push({ label: bundle.label || (SPORTS[sport].label + ' bundle'), price: bundle[key] ?? 0 });
    } else {
      for (const l of lists) {
        total += l[key] ?? 0;
        parts.push({
          label: `${SPORTS[l.sport]?.label || l.sport} — ${l.label}`,
          price: l[key] ?? 0,
        });
      }
    }
  }
  return { total, parts };
}

/*
 * Which signups of an event are covered by their owner's Battle Pass.
 * Mirrors the computePrice pass rule: '4h' covers every volleyball signup,
 * '2h' covers the one in the earliest slot.
 */
function coveredSignupIds(ev) {
  const set = new Set();
  const byPerson = {};
  for (const su of eventSignups(ev.id)) (byPerson[personKey(su)] = byPerson[personKey(su)] || []).push(su);
  for (const sus of Object.values(byPerson)) {
    const pass = playerPass(sus[0], ev.date);
    if (!pass) continue;
    const volley = sus
      .filter(s => listById(ev, s.listId)?.sport === 'volleyball')
      .sort((a, b) => (listById(ev, a.listId)?.sessionId || '').localeCompare(listById(ev, b.listId)?.sessionId || ''));
    if (pass === '4h') volley.forEach(s => set.add(s.id));
    else if (volley[0]) set.add(volley[0].id);
  }
  return set;
}

/* One-line price recap for an event: each distinct sport price shown once. */
function pricesSummary(ev) {
  const seen = new Set();
  const parts = [];
  for (const l of ev.lists || []) {
    const sport = SPORTS[l.sport] || SPORTS.other;
    const price = `${fmtMoney(l.priceE ?? 0)}${(l.priceC ?? l.priceE) !== l.priceE ? ` (${fmtMoney(l.priceC)} ${t('cash')})` : ''}`;
    const key = l.sport + '|' + price;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`${esc(sport.label)} <strong>${price}</strong>`);
  }
  for (const b of ev.bundles || []) {
    const sport = SPORTS[b.sport] || SPORTS.other;
    parts.push(`${esc(sport.label)} ${t('bothSlots')} <strong>${fmtMoney(b.priceE ?? 0)}</strong>`);
  }
  return parts.join('&ensp;·&ensp;');
}

/* One human, one bill. Keyed the same way as everything else, so somebody
 * with two profiles is not charged twice or chased twice. */
function personKey(s) {
  return identityOf(s);
}

/*
 * The sign-ups that actually hold a place, as opposed to sitting on the
 * waitlist. Nobody owes for a spot they never got.
 */
function confirmedSignupIds(ev) {
  const set = new Set();
  for (const l of ev.lists || []) {
    const { confirmed } = splitByCap(listEntries(ev.id, l.id), l.cap || 0);
    confirmed.forEach(su => set.add(su.id));
  }
  return set;
}

/* personTotals walks every sign-up on the night, and a roster row needs it
 * once per name. Cleared at the start of each render. */
let totalsCache = {};
function personTotalsCached(ev) {
  return (totalsCache[ev.id] = totalsCache[ev.id] || personTotals(ev));
}
function personSettlement(ev, su) {
  return personTotalsCached(ev).find(p => personKey(p.signups[0]) === personKey(su)) || null;
}

/* Money, kept to the cent — floats drift once you start adding part-payments. */
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function personTotals(ev) {
  const covered = coveredSignupIds(ev);
  const held = confirmedSignupIds(ev);
  const persons = {};
  for (const su of eventSignups(ev.id)) {
    const k = personKey(su);
    if (!persons[k]) persons[k] = { name: su.name, insta: su.insta, method: su.method, deviceId: su.deviceId, signups: [] };
    persons[k].signups.push(su);
  }
  return Object.values(persons).map(p => {
    const pass = playerPass(p.signups?.[0] || p, ev.date);
    // Money is owed per spot, so split the person's spots into what is
    // settled (paid, or covered by their pass) and what is still owed.
    // Someone who paid for volleyball but also signed up for basketball
    // owes the basketball price only — never the whole evening again.
    // The pass is already accounted for by coveredSignupIds, so the
    // remaining spots are priced without it.
    const settled = p.signups.filter(x => x.paid && !covered.has(x.id));
    // A waitlisted name is not a debt. They never got on the court, so they
    // are not billed, not reminded, and not chased — and their spot is not
    // counted in what the club is owed.
    const owing = p.signups.filter(x => !x.paid && !covered.has(x.id) && held.has(x.id));
    const { total: settledValue } = computePrice(ev, settled.map(x => x.listId), p.method, null);
    let { total: billed } = computePrice(ev, owing.map(x => x.listId), p.method, null);
    // Automatic late fee once the Saturday has passed and they still owe.
    const late = isPastEvent(ev) && owing.length > 0 && billed > 0;
    if (late) billed += parseFloat(state.settings.lateFeeAmount) || 0;
    // Cash an exec actually took, when it was not the list price: a partial
    // payment, an odd note, someone rounding up. Recorded against the spot,
    // summed for the person. Without it a $5 handed over against an $8 bill
    // could only be filed as paid or unpaid, and both are wrong.
    const received = p.signups.reduce((a, x) => a + (parseFloat(x.amountPaid) || 0), 0);
    const total = Math.max(0, round2(billed - received));
    const paidAmount = round2(settledValue + received);
    const paid = total === 0;          // settled, covered, waitlisted, or paid off
    return {
      ...p, total, paidAmount, billed, received, pass, late, paid,
      partial: received > 0 && total > 0,
      checkedIn: p.signups.some(x => x.checkedIn),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/* ================================================================== */
/* Emails: confirmation, payment reminders, waitlist promotion         */
/* ================================================================== */

/* Emails render in the recipient's own language (stored on their signup). */
function fmtDateLang(iso, lang) {
  return new Date(iso + 'T12:00:00').toLocaleDateString(lang === 'fr' ? 'fr-CA' : 'en-CA',
    { weekday: 'long', month: 'long', day: 'numeric' });
}

function payLineFor(lang, method, total) {
  const key = method === 'cash' ? 'payLineC' : 'payLineE';
  return tLang(lang, key, { total: fmtMoney(total), email: state.settings.etransferEmail || '' });
}

async function sendConfirmationEmail(ev, profile, listIds, method) {
  const lang = getLang();
  const myPass = playerPass(DEVICE, ev.date);
  const allMine = [...new Set([...mySignups(ev.id).map(m => m.listId), ...listIds])];
  const { total } = computePrice(ev, allMine, method, myPass);
  const lists = allMine.map(id => {
    const l = listById(ev, id);
    const sess = l ? sessionById(ev, l.sessionId) : null;
    return `- ${SPORTS[l?.sport]?.label || ''} ${l?.label || ''} (${sess?.label || ''})`;
  }).join('\n');
  const vars = {
    name: profile.name,
    date: fmtDateLang(ev.date, lang),
    lists,
    payLine: total === 0 && myPass ? tLang(lang, 'battlePassCovered') : payLineFor(lang, method, total),
    late: state.settings.lateFeeNote || '',
    location: ev.location || state.settings.location || '',
    club: state.settings.clubFullName || 'CRSC',
  };
  try {
    if (store.mode === 'demo' || !mailerConfigured()) {
      toast(t('confEmailSim', { email: profile.email }));
      return;
    }
    const r = await sendMail({
      to: profile.email,
      subject: tLang(lang, 'emailConfSubject', { date: vars.date }),
      message: tLang(lang, 'emailConfBody', vars),
    });
    if (r.sent) toast(t('confEmailSent', { email: profile.email }));
  } catch (err) {
    console.error('confirmation email', err);
    toast(t('confEmailFail'), 'err');
  }
}

/*
 * "We got your money" — the receipt.
 *
 * Without it, automatic matching is invisible to the player: they send an
 * e-transfer and hear nothing, so they ask an exec anyway and the club is
 * back to answering messages by hand. Sent once per person per event
 * (claimed before sending, so two execs' open tabs cannot both send it).
 */
async function notifyPaymentReceived(ev, people, pay = null) {
  if (store.mode === 'demo' || !mailerConfigured()) return;
  // One transfer often pays for several people. The person who actually sent
  // it must see the amount they really sent and who it covered — telling a
  // player "we received 8$" when they sent 16$ reads like half of it vanished.
  const senderName = pay && people.length > 1
    ? (nameHits(pay.sender || '', people)[0]?.person?.name || null)
    : null;
  for (const p of people) {
    const sus = (p.signups || []).filter(su => su.email && !su.paidEmailSentAt);
    if (!sus.length) continue;
    const su = sus[0];
    const lang = su.lang === 'fr' ? 'fr' : 'en';
    const lists = sus.map(x => {
      const l = listById(ev, x.listId);
      const sess = l ? sessionById(ev, l.sessionId) : null;
      return `• ${SPORTS[l?.sport]?.label || ''} ${l?.label || ''}${sess ? ' (' + sess.label + ')' : ''}`;
    }).join('\n');
    const isSender = senderName && p.name === senderName;
    const others = people.filter(x => x.name !== p.name).map(x => x.name);
    const date = fmtDateLang(ev.date, lang);
    const openLine = !senderName
      ? tLang(lang, 'paidOpenSelf', { total: fmtMoney(p.paidAmount || p.total || 0), date })
      : isSender
        ? tLang(lang, 'paidOpenGroup', { total: fmtMoney(pay.amount || 0), date, names: others.join(', ') })
        : tLang(lang, 'paidOpenCovered', { date, sender: senderName });
    await Promise.all(sus.map(x => store.updateSignup(ev.id, x.id, { paidEmailSentAt: Date.now() })));
    try {
      await sendMail({
        to: su.email,
        subject: tLang(lang, 'emailPaidSubject', { date }),
        message: tLang(lang, 'emailPaidBody', {
          name: su.name,
          date,
          openLine,
          lists,
          location: ev.location || state.settings.location || '',
          club: state.settings.clubFullName || 'CRSC',
        }),
      });
    } catch (err) { console.error('payment receipt', err); }
  }
}

/*
 * The receipt for a payment an exec recorded by hand.
 *
 * The club settles most money in the gym — cash across the table, or a
 * transfer an exec reads and ticks off — so the manual path is the normal
 * one, not the exception. It has to tell the player the same as the matcher
 * does, or a confirmation only ever reaches the handful of people whose
 * transfer happened to match to the cent.
 *
 * Only once they owe nothing for the whole night: "you're all set" is a lie
 * while a second spot is still unpaid, and notifyPaymentReceived claims
 * paidEmailSentAt before sending, so settling the rest later cannot send a
 * second one.
 */
async function notifyIfSettled(ev, su) {
  const me = personTotals(ev).find(x => personKey(x.signups[0]) === personKey(su));
  if (me && me.paid) await notifyPaymentReceived(ev, [me]);
}

/* A season pass is real money and a standing commitment — it gets its own
 * receipt explaining what the player just bought. */
/*
 * "Your spot for Saturday is held."
 *
 * A pass holder never signs up, so without this the first they hear of a
 * Saturday is the Saturday. One email the moment their seat is put down
 * gives them the week to tell an exec they cannot make it — which is the
 * whole point: a held spot nobody frees is a place the waitlist could have
 * had, and it is the most repetitive message in the exec chat.
 */
/*
 * Snow, a closed gym, no host. An exec closes the Saturday and every name on
 * the list still turns up, because nothing told them not to.
 *
 * Offered rather than automatic: closing sign-ups also means "the list is
 * final, come and play", and an email saying the opposite would be worse
 * than none. The exec says which it is.
 */
async function offerCancelNotice(ev) {
  const people = {};
  for (const su of eventSignups(ev.id)) {
    if (su.email) people[identityOf(su)] = people[identityOf(su)] || su;
  }
  const who = Object.values(people);
  if (!who.length) return;
  if (!await confirmModal(t('cancelAsk', { n: who.length, date: fmtDate(ev.date) }), t('cancelTell'))) return;
  if (store.mode === 'demo' || !mailerConfigured()) {
    toast(t('cancelSim', { n: who.length }));
    return;
  }
  let sent = 0;
  for (const su of who) {
    const lang = su.lang === 'fr' ? 'fr' : 'en';
    try {
      await sendMail({
        to: su.email,
        subject: tLang(lang, 'emailCancelSubject', { date: fmtDateLang(ev.date, lang) }),
        message: tLang(lang, 'emailCancelBody', {
          name: su.name,
          date: fmtDateLang(ev.date, lang),
          insta: state.settings.instagram || '',
          club: state.settings.clubFullName || 'CRSC',
        }),
      });
      sent++;
    } catch (err) { console.error('cancel email', err); }
  }
  toast(t('cancelSent', { n: sent }));
}

async function notifySeatHeld(ev, seats) {
  if (store.mode === 'demo' || !mailerConfigured()) return;
  const byPerson = {};
  for (const su of seats) {
    if (!su.email) continue;
    (byPerson[identityOf(su)] = byPerson[identityOf(su)] || []).push(su);
  }
  for (const rows of Object.values(byPerson)) {
    const su = rows[0];
    const lang = su.lang === 'fr' ? 'fr' : 'en';
    const where = rows.map(r => {
      const l = listById(ev, r.listId);
      const sess = l ? sessionById(ev, l.sessionId) : null;
      return '\u2022 ' + (SPORTS[l?.sport]?.label || '') + ' ' + (l?.label || '')
           + (sess ? ' \u2014 ' + sess.label : '');
    }).join('\n');
    try {
      await sendMail({
        to: su.email,
        subject: tLang(lang, 'emailHeldSubject', { date: fmtDateLang(ev.date, lang) }),
        message: tLang(lang, 'emailHeldBody', {
          name: su.name,
          date: fmtDateLang(ev.date, lang),
          where,
          location: ev.location || state.settings.location || '',
          insta: state.settings.instagram || '',
          club: state.settings.clubFullName || 'CRSC',
        }),
      });
    } catch (err) { console.error('seat held email', err); }
  }
}

async function notifyPassActivated(player, type, amount) {
  if (store.mode === 'demo' || !mailerConfigured() || !player.email) return;
  const lang = player.lang === 'fr' ? 'fr' : 'en';
  try {
    await sendMail({
      to: player.email,
      subject: tLang(lang, 'emailPassSubject', { type: type.toUpperCase() }),
      message: tLang(lang, 'emailPassBody', {
        name: player.name, type: type.toUpperCase(),
        total: fmtMoney(amount), club: state.settings.clubFullName || 'CRSC',
      }),
    });
  } catch (err) { console.error('pass receipt', err); }
}

/*
 * 24h-before payment reminders. A static site has no scheduler, so this runs
 * whenever anyone has the app open inside the reminder window; each person's
 * signups are flagged (claim-first) so nobody is emailed twice.
 */
/*
 * The late-fee sentence. The club's own note if they wrote one, otherwise a
 * plain statement of the policy built from the amount — people should never
 * meet the late fee for the first time when they are being charged it.
 */
function lateFeeLine(lang) {
  const note = (state.settings.lateFeeNote || '').trim();
  if (note) return note;
  const amt = parseFloat(state.settings.lateFeeAmount);
  return amt ? tLang(lang, 'lateFeePolicy', { amount: fmtMoney(amt) }) : '';
}

/* ================================================================== */
/* Waitlist promotion (automatic, with email)                          */
/* ================================================================== */

/*
 * Call BEFORE `leaving` is removed/moved out of its list. Figures out who
 * crosses from the waitlist into the confirmed group, then (after the
 * mutation) emails them and records it on their signup.
 */
function prePromotion(ev, leaving) {
  const l = listById(ev, leaving.listId);
  if (!l) return null;
  const entries = listEntries(ev.id, leaving.listId);
  const cand = promotionCandidate(entries, l.cap || 0, leaving);
  return cand ? { cand, list: l } : null;
}

async function notifyPromotion(ev, promo) {
  if (!promo) return;
  const { cand, list } = promo;
  const sess = sessionById(ev, list.sessionId);
  try {
    if (store.mode === 'demo' || !mailerConfigured()) {
      if (cand.email) toast(t('promotedEmailSim', { name: cand.name }));
      else toast(t('promotedNoEmail', { name: cand.name }));
      await store.updateSignup(ev.id, cand.id, { promotedAt: Date.now(), promotedNotified: !!cand.email });
      return;
    }
    if (!cand.email) {
      toast(t('promotedNoEmail', { name: cand.name }));
      await store.updateSignup(ev.id, cand.id, { promotedAt: Date.now(), promotedNotified: false });
      return;
    }
    const lang = cand.lang === 'fr' ? 'fr' : 'en';
    const pass = playerPass(cand, ev.date);
    const { total } = computePrice(ev, [list.id], cand.method, pass);
    await sendMail({
      to: cand.email,
      subject: tLang(lang, 'emailPromoSubject', { date: fmtDateLang(ev.date, lang) }),
      message: tLang(lang, 'emailPromoBody', {
        name: cand.name,
        date: fmtDateLang(ev.date, lang),
        list: `${SPORTS[list.sport]?.label || list.sport} — ${list.label}`,
        session: sess ? sess.label : '',
        payLine: total === 0 && pass ? tLang(lang, 'battlePassCovered') : payLineFor(lang, cand.method, total),
        location: ev.location || state.settings.location || '',
        club: state.settings.clubFullName || 'CRSC',
      }),
    });
    toast(t('promotedEmailSent', { name: cand.name }));
    await store.updateSignup(ev.id, cand.id, { promotedAt: Date.now(), promotedNotified: true });
  } catch (err) {
    console.error('promotion email', err);
    toast(t('promotedEmailFail', { name: cand.name }), 'err');
  }
}

/*
 * Removing a name frees the spot, so the signup itself has to go — but a
 * record of it is kept forever. That record is the proof trail: if someone
 * signed up, was checked in (or removed their name after the game had
 * started), and then took their name off the list, the club can still see
 * they played and ask them to pay.
 */
async function logRemoval(ev, su, by) {
  const l = listById(ev, su.listId);
  const sess = l ? sessionById(ev, l.sessionId) : null;
  const covered = coveredSignupIds(ev).has(su.id);
  const { total } = covered ? { total: 0 } : computePrice(ev, [su.listId], su.method, playerPass(su, ev.date));
  const now = Date.now();
  const started = ev.date ? now >= new Date(ev.date + 'T17:00:00').getTime() : false;
  try {
    await store.addRemoval({
      id: uid('rm'),
      eventId: ev.id,
      eventDate: ev.date || '',
      name: su.name,
      email: su.email || '',
      phone: su.phone || '',
      insta: su.insta || '',
      deviceId: su.deviceId || '',
      listLabel: l ? l.label : '',
      sportLabel: l ? (SPORTS[l.sport]?.label || l.sport) : '',
      sessionLabel: sess ? sess.label : '',
      signedUpAt: su.createdAt || 0,
      removedAt: now,
      by,
      wasPaid: !!su.paid,
      wasCheckedIn: !!su.checkedIn,
      afterStart: started,
      // Owed only if they never paid and the pass doesn't cover it.
      amountOwed: su.paid ? 0 : total,
      // Proof they were there: checked in, or pulled out mid-game.
      flagged: (!!su.checkedIn || started) && !su.paid && !covered,
    });
  } catch (err) {
    console.error('logRemoval', err);
  }
}

/*
 * Who did what.
 *
 * Removals were already recorded; nothing else was. Marking somebody paid,
 * recording cash, granting a season pass, grading a player, deleting an
 * account — all of it happened anonymously, which is fine with one exec and
 * is how a committee ends up arguing about money.
 *
 * The exec PIN is shared, so the app cannot prove who was holding the phone.
 * It records the profile on that device and says so plainly. That is enough
 * to answer "who marked this paid?" and honest about what it is worth.
 */
let logWarned = false;

async function logAction(kind, what, extra = {}) {
  try {
    const me = getProfile();
    await store.addLog({
      id: uid('lg'),
      kind,
      what,
      by: me?.name || '',
      byDevice: DEVICE,
      at: Date.now(),
      ...extra,
    });
  } catch (err) {
    // Never let the record-keeping stop the thing being recorded — the
    // payment matters more than the note about it. But say so once, because
    // a history that silently records nothing is worse than none at all:
    // this is what a database that has not had the new rules published yet
    // looks like from in here.
    console.error('log', err);
    if (!logWarned) { logWarned = true; toast(t('logBlocked'), 'warn'); }
  }
}

async function removeSignup(ev, su, by = 'self') {
  const promo = prePromotion(ev, su);
  await logRemoval(ev, su, by);
  await store.deleteSignup(ev.id, su.id);
  await notifyPromotion(ev, promo);
}

/*
 * Returns false and says why when the move would put them on a list they are
 * already on — including its waitlist, which is just the back of that same
 * list. The switch sheet already hides those options, but it was drawn at
 * some point in the past: another phone, another tab, or an exec may have
 * signed them up for that slot since. Every other way onto a list re-checks
 * at the moment it writes, and this one now does too.
 */
async function moveSignup(ev, su, newListId) {
  const to = listById(ev, newListId);
  const who = identityOf(su);
  if (!to) { toast(t('switchGone'), 'err'); return false; }
  if (to.id !== su.listId && identitiesInSession(ev, to.sessionId).has(who)) {
    toast(t('onePerSlot'), 'err');
    return false;
  }
  const promo = prePromotion(ev, su);
  await store.updateSignup(ev.id, su.id, { listId: newListId, team: null, order: Date.now() });
  await notifyPromotion(ev, promo);
  return true;
}

/* ================================================================== */
/* Rendering: shell + routing                                          */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* Profile portability                                                  */
/*                                                                      */
/* A profile lives in this browser's storage, so opening the app from a */
/* different browser (or from the Claude artifact versus the real site) */
/* would otherwise look like a brand new person. Two ways across:       */
/*  - a personal link that carries the player id and contact details;   */
/*  - "I already have a profile", which looks the email up in the club  */
/*    registry (works once the club is on the shared database).         */
/* ------------------------------------------------------------------ */

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function profileLink() {
  const p = getProfile() || {};
  const payload = b64urlEncode(JSON.stringify({
    i: DEVICE, n: p.name || '', e: p.email || '', p: p.phone || '', g: p.insta || '',
  }));
  return location.href.split('#')[0] + '#/me/' + payload;
}

/* Take over the identity in a personal link, then reload so everything
 * derived from the player id is rebuilt. */
function adoptIdentity(raw) {
  let d = null;
  try { d = JSON.parse(b64urlDecode(raw)); } catch (e) { d = null; }
  if (!d || !d.i) {
    location.hash = '#/';
    toast(t('linkBad'), 'err');
    return;
  }
  const old = getProfile();
  setDeviceId(d.i);
  saveProfile({
    name: d.n || '', email: d.e || '', phone: d.p || '', insta: d.g || '',
    photo: (old && old.photo) || '',
  });
  $('#view').innerHTML = `<div class="empty">${esc(t('adopting'))}</div>`;
  const base = location.href.split('#')[0];
  location.replace(base + '#/');
  location.reload();
}

function findPlayerByEmail(email) {
  const e = (email || '').trim().toLowerCase();
  if (!e) return null;
  return Object.values(state.players || {}).find(p => (p.email || '').toLowerCase() === e) || null;
}

/*
 * Is this email already somebody else's? Matching your own record is fine —
 * that is just editing your profile.
 */
function emailTakenBy(email, myDeviceId) {
  const found = findPlayerByEmail(email);
  return found && found.deviceId !== myDeviceId ? found : null;
}

/* Registering over an address that already exists: point them at the profile
 * they already have rather than making a second one. */
function openDuplicateEmailModal(existing, email) {
  const ov = openModal(`
    <div class="modal-body">
      <h2 class="m0">${esc(t('emailTakenTitle'))}</h2>
      <p class="hint">${esc(t('emailTakenHint', { email, name: existing.name || '' }))}</p>
      <div class="row gap">
        <button class="btn btn-ghost grow" data-close>${esc(t('cancel'))}</button>
        <button class="btn btn-primary grow" id="dup-restore">${esc(t('haveProfile'))}</button>
      </div>
    </div>`);
  $('#dup-restore', ov).addEventListener('click', () => {
    ov.remove();
    openRestoreModal(email);
  });
}

function openRestoreModal(prefill = '') {
  const ov = openModal(`
    <div class="modal-body">
      <h2>${esc(t('restoreTitle'))}</h2>
      <p class="hint">${esc(t('restoreHint'))}</p>
      <input class="input" id="rs-email" type="email" placeholder="${esc(t('emailPh').replace(' *', ''))}" value="${esc(prefill)}" autofocus>
      <div class="row gap">
        <button class="btn btn-ghost grow" data-close>${esc(t('cancel'))}</button>
        <button class="btn btn-primary grow" id="rs-go">${esc(t('restoreBtn'))}</button>
      </div>
    </div>`);
  const go = () => {
    const found = findPlayerByEmail($('#rs-email', ov).value);
    if (!found) { toast(t('restoreNotFound'), 'err'); return; }
    setDeviceId(found.deviceId);
    saveProfile({
      name: found.name || '', email: found.email || '', phone: found.phone || '',
      insta: found.insta || '', photo: found.photo || '',
    });
    toast(t('welcomeBack', { name: found.name || '' }));
    setTimeout(() => location.reload(), 400);
  };
  $('#rs-go', ov).addEventListener('click', go);
  $('#rs-email', ov).addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  $('#rs-email', ov).focus();
}

function openTransferModal() {
  const link = profileLink();
  const ov = openModal(`
    <div class="modal-body">
      <h2>${esc(t('transferTitle'))}</h2>
      <p class="hint">${esc(t('transferHint'))}</p>
      <input class="input transfer-link" id="tr-link" value="${esc(link)}" readonly>
      <div class="row gap">
        <button class="btn btn-ghost grow" id="tr-copy">${esc(t('copyLink'))}</button>
        ${navigator.share ? `<button class="btn btn-primary grow" id="tr-share">${esc(t('shareLink'))}</button>` : ''}
      </div>
      <p class="hint">${esc(t('photoNotCarried'))}</p>
      <button class="btn btn-ghost wide" data-close>${esc(t('close'))}</button>
    </div>`);
  $('#tr-copy', ov).addEventListener('click', async () => {
    const input = $('#tr-link', ov);
    try {
      await navigator.clipboard.writeText(link);
      toast(t('copiedToast'));
    } catch (e) {
      // Clipboard access is blocked in some embedded views; select instead.
      input.focus();
      input.setSelectionRange(0, link.length);
    }
  });
  $('#tr-share', ov)?.addEventListener('click', () => {
    navigator.share({ title: 'CRSC', url: link }).catch(() => {});
  });
}

function route() {
  const hash = location.hash || '#/';
  const me = hash.match(/^#\/me\/(.+)$/);
  if (me) return { view: 'adopt', payload: me[1] };
  const m = hash.match(/^#\/event\/([^/]+)/);
  if (m) return { view: 'event', eventId: m[1] };
  return { view: 'home' };
}

function render() {
  totalsCache = {};
  playerIndex = null;
  refreshLiveModals();
  const r = route();
  renderHeader();
  if (r.view === 'adopt') { adoptIdentity(r.payload); return; }
  // The door only goes up once the club turns it on. Until then signing in
  // is offered and optional, so nobody is shut out of the app while the
  // team is still getting accounts — and so a Firebase project that has
  // not had its sign-in methods enabled yet cannot lock everybody out.
  if (authReady() && !currentUser() && signInMode() === 'required') { renderSignIn(); return; }
  if (!getProfile()) { renderWelcome(); return; }
  if (r.view === 'event') {
    const ev = state.events.find(e => e.id === r.eventId);
    const hidden = ev && isPastEvent(ev) && !isExec();
    if (ev && !hidden) { store.watchEvent(ev.id); renderEvent(ev); }
    else $('#view').innerHTML = `<div class="empty">${esc(hidden ? t('pastHidden') : t('notFound'))} <a href="#/">${esc(t('backHome'))}</a></div>`;
  } else {
    renderHome();
  }
}

function renderHeader() {
  const s = state.settings;
  const other = getLang() === 'fr' ? 'EN' : 'FR';
  $('#header').innerHTML = `
    <a class="brand" href="#/">
      <span class="brand-mark">CRSC</span>
      <span class="brand-sub">${esc(s.clubFullName || '')}</span>
    </a>
    <div class="header-actions">
      ${store.mode === 'demo' ? `<span class="chip chip-demo" title="${esc(t('demoTitle'))}">DEMO</span>` : ''}
      <button class="btn btn-tiny btn-ghost" id="btn-lang">${other}</button>
      ${isExec() ? `<span class="chip chip-exec-tag">${esc(t('execTag'))}</span>` : ''}
      ${authReady() && currentUser()
        ? `<button class="btn btn-small btn-ghost" id="btn-signout">${esc(t('signOut'))}</button>`
        : signInOffered()
          ? `<button class="btn btn-small btn-primary" id="btn-signin">${esc(t('signInBtn'))}</button>
             ${isExec() ? `<button class="btn btn-small btn-ghost" id="btn-exec-off">${esc(t('execOff'))}</button>`
                        : `<button class="btn btn-tiny btn-ghost" id="btn-exec-on">${esc(t('execBtn'))}</button>`}`
          : (isExec()
              ? `<button class="btn btn-small btn-exec" id="btn-exec-off">${esc(t('execOnBtn'))}</button>`
              : `<button class="btn btn-small btn-ghost" id="btn-exec-on">${esc(t('execBtn'))}</button>`)}
    </div>`;
  $('#btn-lang').addEventListener('click', () => {
    setLang(getLang() === 'fr' ? 'en' : 'fr');
    render();
  });
  const on = $('#btn-exec-on');
  if (on) on.addEventListener('click', openPinModal);
  const off = $('#btn-exec-off');
  if (off) off.addEventListener('click', () => { setExec(false); toast(t('execModeOff')); render(); });
  $('#btn-signin')?.addEventListener('click', () => { location.hash = '#/'; renderSignIn(); });
  $('#btn-signout')?.addEventListener('click', async () => {
    if (!await confirmModal(t('signOutAsk'), t('signOut'))) return;
    try { localStorage.removeItem('crsc-profile'); } catch (e) { /* ignore */ }
    await signOutNow();
  });
}

/* ================================================================== */
/* The door                                                            */
/* ================================================================== */

/*
 * Signing in is how the club knows an address belongs to the person using
 * it. Everything downstream rests on that: one account per person instead
 * of one per phone, and an exec list that means something because nobody
 * can claim an address they cannot open.
 */
function renderSignIn() {
  const s = state.settings;
  $('#view').innerHTML = `
    <section class="hero">
      <h1>${esc(t('heroTitle'))}</h1>
      <p>${esc(t('tagline'))}</p>
    </section>
    <div class="card welcome-card">
      <p class="hint">${esc(t('signInWhy'))}</p>
      <button class="btn btn-primary wide" id="si-google">${esc(t('signInGoogle'))}</button>
      <div class="si-or"><span>${esc(t('orWord'))}</span></div>
      <label class="field-label" for="si-email">${esc(t('signInEmailLbl'))}</label>
      <input class="input" id="si-email" type="email" inputmode="email" autocomplete="email"
             placeholder="${esc(t('emailPh').replace(' *', ''))}">
      <button class="btn btn-ghost wide" id="si-link">${esc(t('signInSendLink'))}</button>
      <p class="hint" id="si-note">${esc(t('signInLinkNote'))}</p>
      ${s.policiesUrl ? `<p class="hint"><a href="${esc(s.policiesUrl)}" target="_blank" rel="noopener">${esc(t('policiesLink'))}</a></p>` : ''}
      ${signInMode() !== 'required' ? `<button class="btn btn-ghost wide" id="si-later">${esc(t('signInLater'))}</button>` : ''}
    </div>`;
  $('#si-later')?.addEventListener('click', () => render());

  $('#si-google').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await signInWithGoogle(); }
    catch (err) { console.error(err); toast(t('signInFailed'), 'err'); e.target.disabled = false; }
  });
  $('#si-link').addEventListener('click', async (e) => {
    const email = $('#si-email').value.trim();
    e.target.disabled = true;
    try {
      await sendEmailLink(email);
      $('#si-note').textContent = t('signInLinkSent', { email });
    } catch (err) {
      console.error(err);
      toast(/bad email/.test(err.message) ? t('emailRequired') : t('signInFailed'), 'err');
      e.target.disabled = false;
    }
  });
}

/* ================================================================== */
/* Registration gate: everyone makes a profile before using the app    */
/* ================================================================== */

/*
 * Bring the profile on this device into line with who just signed in.
 *
 * Three cases. A brand-new person gets a profile started from their Google
 * name and address, so registration is one field instead of five. Somebody
 * the club already knows — matched on the proven address — has their
 * existing record adopted, history, pass, level and all, whichever phone
 * they are on. And a device whose profile belongs to somebody else is
 * simply handed over, because the address is now proof and the leftover
 * profile is not.
 */
function adoptSignedInIdentity(raw) {
  const me = { ...raw, email: (raw.email || '').trim().toLowerCase() };
  if (!me.email) return;
  const known = findPlayerByEmail(me.email);
  if (known && known.deviceId !== DEVICE) {
    // Their account already exists; this device becomes that account.
    setDeviceId(known.deviceId);
    saveProfile({
      name: known.name || me.name, email: me.email,
      phone: known.phone || '', insta: known.insta || '',
      photo: known.photo || me.photo || '', deviceId: known.deviceId,
    });
    return;
  }
  const p = getProfile();
  if (!p) {
    if (me.name) {
      // Enough to skip the registration gate entirely.
      saveProfile({ name: me.name, email: me.email, phone: '', insta: '', photo: me.photo || '' });
      registerPlayer(getProfile());
    }
    return;
  }
  if ((p.email || '').toLowerCase() !== me.email) {
    saveProfile({ ...p, email: me.email });
    registerPlayer(getProfile());
  }
}

function registerPlayer(profile) {
  store.savePlayer({
    deviceId: DEVICE,
    name: profile.name,
    email: profile.email,
    phone: profile.phone || '',
    insta: profile.insta || '',
    photo: profile.photo || '',
    lang: getLang(),
    lastSeen: Date.now(),
  }).catch(err => console.error('savePlayer', err));
}

function renderWelcome() {
  $('#view').innerHTML = `
    <section class="hero">
      <h1>${esc(t('welcomeTitle'))}</h1>
      <p>${esc(t('tagline'))}</p>
    </section>
    <div class="card welcome-card">
      <p class="hint">${esc(t('welcomeText'))}</p>
      ${profileFieldsHtml(null)}
      <p class="hint">${esc(t('welcomePrivacy'))}</p>
      <button class="btn btn-primary wide" id="welcome-save">${esc(t('continueBtn'))}</button>
      <button class="btn btn-ghost wide" id="welcome-restore">${esc(t('haveProfile'))}</button>
    </div>`;
  wireProfileFields(document, null);
  $('#welcome-restore').addEventListener('click', () => openRestoreModal());
  $('#welcome-save').addEventListener('click', () => {
    const np = readProfileFields(document);
    if (!np) return;
    const clash = emailTakenBy(np.email, DEVICE);
    if (clash) { openDuplicateEmailModal(clash, np.email); return; }
    saveProfile(np);
    registerPlayer(np);
    toast(t('profileSaved'));
    render();
  });
}

/* ================================================================== */
/* Home: season calendar                                               */
/* ================================================================== */

function calDayState(ev) {
  if (isPastEvent(ev)) return 'past';
  if (ev.status !== 'open') return 'closed';
  if (isScheduled(ev)) return 'scheduled';
  const anySpace = (ev.lists || []).some(l => listEntries(ev.id, l.id).length < (l.cap || 0));
  return anySpace ? 'open' : 'full';
}

function renderCalendar() {
  const end = state.settings.seasonEnd || nextSaturday(12);
  const exec = isExec();
  const byDate = {};
  // A finished Saturday becomes the club's record of that night — who played,
  // who paid, who was checked in, who took their name off. Players see only
  // the weeks still to come; execs keep every past week.
  for (const ev of state.events) {
    if (!ev.date) continue;
    if (isPastEvent(ev) && !exec) continue;
    byDate[ev.date] = ev;
  }

  const startM = new Date(); startM.setDate(1);
  const endM = new Date(end + 'T12:00:00');
  const months = [];
  const cur = new Date(startM);
  while (cur.getFullYear() < endM.getFullYear() || (cur.getFullYear() === endM.getFullYear() && cur.getMonth() <= endM.getMonth())) {
    months.push(new Date(cur));
    cur.setMonth(cur.getMonth() + 1);
    if (months.length > 12) break;
  }

  const dow = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(2026, 1, i + 1); // Feb 1 2026 is a Sunday
    dow.push(d.toLocaleDateString(locale(), { weekday: 'narrow' }));
  }

  const monthsHtml = months.map(m => {
    const y = m.getFullYear(), mo = m.getMonth();
    const daysInMonth = new Date(y, mo + 1, 0).getDate();
    const offset = new Date(y, mo, 1).getDay();
    let cells = '';
    for (let i = 0; i < offset; i++) cells += '<span class="cal-day cal-blank"></span>';
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${y}-${String(mo + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const ev = byDate[iso];
      if (ev) {
        const st = calDayState(ev);
        const mine = mySignups(ev.id).length > 0;
        cells += `<a class="cal-day cal-sat is-${st} ${mine ? 'is-mine' : ''}" href="#/event/${esc(ev.id)}">${day}</a>`;
      } else {
        cells += `<span class="cal-day">${day}</span>`;
      }
    }
    return `
      <div class="cal-month">
        <div class="cal-month-name">${esc(m.toLocaleDateString(locale(), { month: 'long', year: 'numeric' }))}</div>
        <div class="cal-grid">
          ${dow.map(d => `<span class="cal-dow">${esc(d)}</span>`).join('')}
          ${cells}
        </div>
      </div>`;
  }).join('');

  return `
    <div class="cal-months">${monthsHtml}</div>
    <div class="cal-legend">
      <span><i class="dot dot-open"></i>${esc(t('legendOpen'))}</span>
      <span><i class="dot dot-scheduled"></i>${esc(t('legendScheduled'))}</span>
      <span><i class="dot dot-full"></i>${esc(t('legendFull'))}</span>
      <span><i class="dot dot-mine"></i>${esc(t('legendMine'))}</span>
    </div>`;
}

function avatarHtml(p, size = '') {
  if (p.photo) return `<img class="avatar ${size}" src="${p.photo}" alt="">`;
  const initial = (p.name || '?').trim().charAt(0).toUpperCase();
  return `<span class="avatar avatar-letter ${size}">${esc(initial)}</span>`;
}

function myGamesHtml() {
  const items = [];
  for (const ev of state.events) {
    if (isPastEvent(ev)) continue;
    const covered = coveredSignupIds(ev);
    for (const m of mySignups(ev.id)) {
      const l = listById(ev, m.listId);
      items.push({ ev, m, l, covered: covered.has(m.id) });
    }
  }
  if (!items.length) return '';
  items.sort((a, b) => (a.ev.date > b.ev.date ? 1 : -1));
  return `
    <h2 class="section-title">${esc(t('yourGames'))}</h2>
    <div class="card my-games">
      ${items.map(({ ev, m, l, covered }) => `
        <a class="my-game" href="#/event/${esc(ev.id)}">
          <span class="my-game-date">${esc(fmtDateShort(ev.date))}</span>
          <span class="grow">${esc(SPORTS[l?.sport]?.label || '')} — ${esc(l?.label || '?')}</span>
          ${paymentChip(m, covered)}
        </a>`).join('')}
    </div>`;
}

function weekRecordCard(ev) {
  if (!signupsLoaded(ev.id)) {
    return `
    <a class="record-row" href="#/event/${esc(ev.id)}">
      <span class="record-date">${esc(fmtDateShort(ev.date))}</span>
      <span class="grow hint">${esc(t('loadingWeek'))}</span>
    </a>`;
  }
  const people = personTotals(ev);
  const collected = people.reduce((a, p) => a + (p.paidAmount || 0), 0);
  const outstanding = people.filter(p => !p.paid).reduce((a, p) => a + p.total, 0);
  return `
    <a class="record-row" href="#/event/${esc(ev.id)}">
      <span class="record-date">${esc(fmtDateShort(ev.date))}</span>
      <span class="grow">${people.length} ${esc(t('players'))}</span>
      <span class="rec-good">${fmtMoney(collected)} ${esc(t('collected'))}</span>
      ${outstanding ? `<span class="rec-bad">${fmtMoney(outstanding)} ${esc(t('unpaid'))}</span>` : ''}
    </a>`;
}

/*
 * How somebody reaches the club.
 *
 * Instagram is where this club actually answers — an email to the general
 * inbox waits for whoever opens it next, a DM gets a reply the same evening.
 * So the level request still files itself with the execs by email, and this
 * is how a member asks about it, or about anything else, and gets an answer.
 */
function instagramUrl() {
  const handle = (state.settings.instagram || '').replace(/^@/, '').trim();
  return handle ? 'https://instagram.com/' + encodeURIComponent(handle) : '';
}

function openContactModal(reason = '') {
  const url = instagramUrl();
  const handle = (state.settings.instagram || '').replace(/^@/, '');
  const lvl = levelByRank(playerLevel(DEVICE));
  const ov = openModal(`
    <div class="modal-body">
      <h2 class="m0">${esc(t('contactTitle'))}</h2>
      ${reason ? `<p class="hint">${esc(reason)}</p>` : ''}
      <p class="hint">${esc(lvl ? t('yourLevelIs', { level: lvl.label }) : t('yourLevelNone'))}</p>
      <p>${esc(t('contactBody'))}</p>
      ${url
        ? `<a class="btn btn-primary wide" href="${esc(url)}" target="_blank" rel="noopener">${esc(t('contactInsta', { handle }))}</a>`
        : `<p class="hint">${esc(t('contactNoInsta'))}</p>`}
      ${state.settings.etransferEmail
        ? `<a class="btn btn-ghost wide" href="mailto:${esc(state.settings.etransferEmail)}">${esc(t('contactEmail'))}</a>` : ''}
      <button class="btn btn-ghost wide" data-close>${esc(t('close'))}</button>
    </div>`);
  return ov;
}

function renderHome() {
  const exec = isExec();
  const s = state.settings;
  const profile = getProfile();
  const upcoming = state.events.filter(e => !isPastEvent(e));
  const past = state.events.filter(isPastEvent).sort((a, b) => (a.date < b.date ? 1 : -1));
  // Scheduled weeks have no sign-ups yet, so there is nothing to watch.
  upcoming.filter(e => !isScheduled(e)).forEach(e => store.watchEvent(e.id));
  if (exec) {
    past.forEach(e => store.watchEvent(e.id));
    store.watchPlayers();
    store.watchPayments();
    store.watchRemovals();
    store.watchLog();
    store.watchRefunds();
  }

  $('#view').innerHTML = `
    ${store.mode === 'demo' ? `<div class="offline-banner">${esc(t('offlineBanner'))}</div>` : ''}
    <section class="hero">
      <h1>${esc(t('heroTitle'))}</h1>
      <p>${esc(t('tagline'))}</p>
    </section>

    ${profile ? `
      <div class="profile-strip">
        ${avatarHtml(profile)}
        <div class="grow">
          <strong>${esc(profile.name)}</strong>
          <small>${(() => {
            // Your own grade, in your own words. People used to find out they
            // had one only by finding a list locked.
            const l = levelByRank(playerLevel(DEVICE));
            return l ? esc(t('yourLevelIs', { level: l.label })) : esc(t('yourLevelNone'));
          })()}${profile.insta ? ' · @' + esc(profile.insta) : ''}</small>
        </div>
        <button class="btn btn-small btn-ghost" id="btn-edit-profile">${esc(t('edit'))}</button>
      </div>
      <div class="row gap wrap contact-row">
        <button class="btn btn-small btn-ghost" id="btn-contact">${esc(t('contactUs'))}</button>
      </div>` : ''}

    <h2 class="section-title">${esc(t('chooseSaturday'))}</h2>
    <p class="hint">${(() => {
      // From the Saturdays that exist, not from the season-end setting: the
      // setting is a target for creating weeks, and it drifts. It said
      // "until December 26" while the calendar ran to May.
      const last = [...state.events].map(e => e.date).filter(Boolean).sort().pop();
      return esc(t('calendarHint', { end: fmtDate(last || s.seasonEnd || '') }));
    })()} ${esc(t('weeklyRule'))}</p>
    ${upcoming.length
      ? renderCalendar()
      : `<div class="empty">${t('noEvents', { insta: `<a href="https://instagram.com/${esc(s.instagram || '')}" target="_blank" rel="noopener">@${esc(s.instagram || '')}</a>` })}</div>`}

    ${myGamesHtml()}

    ${exec ? `
      <div class="exec-panel">
        <h2 class="section-title">${esc(t('execTools'))}</h2>
        <div class="row gap wrap">
          <button class="btn btn-primary" id="btn-new-event">${esc(t('newEvent'))}</button>
          ${state.events.length ? `<button class="btn btn-ghost" id="btn-season">${esc(t('openSeason'))}</button>` : ''}
          <button class="btn btn-ghost" id="btn-players">${esc(t('playersBtn'))}</button>
          <button class="btn btn-ghost" id="btn-ledger">${esc(t('ledgerBtn'))}</button>
          <button class="btn btn-ghost" id="btn-log">${esc(t('logBtn'))}</button>
          <button class="btn ${openRefunds().length ? 'btn-warn' : 'btn-ghost'}" id="btn-refunds">${esc(t('refundsBtn'))}${
            openRefunds().length ? ` \u00b7 ${openRefunds().length}` : ''}</button>
          ${authReady() ? `<button class="btn btn-ghost" id="btn-execs">${esc(t('execsBtn'))}</button>` : ''}
          <button class="btn btn-ghost" id="btn-settings">${esc(t('clubSettings'))}</button>
          ${store.mode === 'demo' ? `<button class="btn btn-ghost" id="btn-reset-demo">${esc(t('resetDemo'))}</button>` : ''}
        </div>
        ${past.length ? `<h3 class="section-sub">${esc(t('weekRecord'))}</h3><div class="card record-card">${past.map(weekRecordCard).join('')}</div>
          <button class="btn btn-ghost wide" id="btn-season-csv">${esc(t('exportSeason'))}</button>
          <p class="hint">${esc(t('archiveNote'))}</p>` : ''}
      </div>` : ''}

    <footer class="info-box">
      <h3>${esc(t('importantInfo'))}</h3>
      <p><strong>${esc(t('locationLbl'))}</strong> ${esc(s.location || '')}</p>
      <p><strong>${esc(t('paymentLbl'))}</strong> ${esc(t('paymentLine', { email: s.etransferEmail || '' }))}</p>
      ${s.battlePassNote ? `<p><strong>${esc(t('battlePass'))}:</strong> ${esc(s.battlePassNote)}</p>` : ''}
      <ul>${(s.policies || []).map(p => `<li>${esc(p)}</li>`).join('')}</ul>
      <p class="late-fee">${esc(s.lateFeeNote || '')}</p>
      ${s.policiesUrl ? `<a class="policies-link" href="${esc(s.policiesUrl)}" target="_blank" rel="noopener">${esc(t('policiesLink'))}</a>` : ''}
    </footer>`;

  $('#btn-edit-profile')?.addEventListener('click', () => openProfileModal());
  $('#btn-contact')?.addEventListener('click', () => openContactModal());
  $('#btn-log')?.addEventListener('click', openLogModal);
  $('#btn-refunds')?.addEventListener('click', openRefundsModal);
  $('#btn-execs')?.addEventListener('click', openExecsModal);
  $('#btn-new-event')?.addEventListener('click', () => openEventEditor(null));
  $('#btn-season')?.addEventListener('click', openSeason);
  $('#btn-players')?.addEventListener('click', openPlayersModal);
  $('#btn-ledger')?.addEventListener('click', async () => { await loadWholeSeason(); openLedgerModal(); });
  $('#btn-season-csv')?.addEventListener('click', async () => { await loadWholeSeason(); exportSeasonCsv(); });
  $('#btn-settings')?.addEventListener('click', openSettingsModal);
  $('#btn-reset-demo')?.addEventListener('click', async () => {
    if (await confirmModal(t('resetDemoConfirm'))) {
      // Also forget this device's profile so the demo replays the
      // brand-new-visitor flow (registration gate first).
      try { localStorage.removeItem('crsc-profile'); } catch (e) { /* ignore */ }
      setExec(false);
      store.resetDemo();
      toast(t('demoReset'));
      render();
    }
  });
}

/* Create an event for every remaining Saturday until seasonEnd. */
/*
 * Create the Saturdays that are missing — but let an exec say which.
 *
 * It used to make every Saturday up to the season end, and the club's year
 * is not one unbroken run: there is a month between the fall and the winter,
 * and weeks off inside each. Making them all and deleting the extras by hand
 * is how October 17 and November 28 came to exist in the first place.
 */
async function openSeason() {
  const end = state.settings.seasonEnd || nextSaturday(12);
  const have = new Set(state.events.map(e => e.date));
  const missing = saturdaysUntil(end).filter(d => !have.has(d));
  if (!missing.length) { toast(t('seasonComplete', { end: fmtDate(end) })); return; }

  const picked = await new Promise(resolve => {
    const ov = openModal(`
      <div class="modal-body">
        <h2 class="m0">${esc(t('openSeason'))}</h2>
        <p class="hint">${esc(t('openSeasonPick', { end: fmtDate(end) }))}</p>
        <div class="summary-list">
          ${missing.map(d => `
            <label class="pay-opt">
              <input type="checkbox" data-day="${esc(d)}" checked>
              <span>${esc(fmtDate(d))}</span>
            </label>`).join('')}
        </div>
        <div class="row gap">
          <button class="btn btn-ghost grow" data-close>${esc(t('cancel'))}</button>
          <button class="btn btn-primary grow" id="os-go">${esc(t('createThem'))}</button>
        </div>
      </div>`, { wide: true });
    $('#os-go', ov).addEventListener('click', () => {
      const days = $$('[data-day]:checked', ov).map(c => c.dataset.day);
      ov.remove();
      resolve(days);
    });
    ov.addEventListener('click', e => { if (e.target === ov) resolve(null); });
    $$('[data-close]', ov).forEach(b => b.addEventListener('click', () => resolve(null)));
  });
  if (!picked || !picked.length) return;

  const src = [...state.events].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  for (const date of picked) {
    const copy = src
      ? { ...JSON.parse(JSON.stringify(src)), id: uid('ev'), date, status: 'open', createdAt: Date.now() }
      : makeTemplateEvent(date, 'Saturday Drop-in');
    copy.lists = copy.lists.map(l => ({ ...l, id: uid('l') }));
    await store.saveEvent(copy);
  }
  toast(t('seasonOpened', { n: picked.length }));
}

/* ================================================================== */
/* Event view                                                          */
/* ================================================================== */

/* "Battle Pass 2H" / "Battle Pass 4H" chip. `short` fits narrow phone rows. */
/* A player's grade, shown to execs only — like payment status, it is the
 * club's note about somebody, not a badge for the room to read. */
function levelChipHtml(who) {
  const l = levelByRank(playerLevel(who));
  return l ? `<span class="chip chip-level" title="${esc(l.label)}">${esc(l.short)}</span>` : '';
}

function passChipHtml(type, short = false) {
  const label = short ? 'PASS' : t('battlePass');
  return `<span class="chip chip-pass">${esc(label)}${type ? ' ' + esc(String(type).toUpperCase()) : ''}</span>`;
}

function paymentChip(s, covered = false, short = false, settle = null) {
  if (covered) return passChipHtml(playerPass(s), short);
  // Cash an exec recorded settles the person's whole night, which can cover a
  // spot whose own paid flag was never ticked.
  if (settle && settle.received > 0) {
    if (settle.paid) return `<span class="chip chip-paid">${esc(t('paid'))}</span>`;
    return `<span class="chip chip-part" title="${esc(t('partPaidTitle', { amount: fmtMoney(settle.received) }))}">${esc(t('shortBy', { amount: fmtMoney(settle.total) }))}</span>`;
  }
  if (s.paid) return `<span class="chip chip-paid">${esc(t('paid'))}</span>`;
  return `<span class="chip chip-unpaid">${esc(s.method === 'cash' ? t('cashUnpaid') : t('etransferUnpaid'))}</span>`;
}

/*
 * Status chips at the right of a list row. A Battle Pass is always visible
 * to execs: filled gold when it covers this spot (nothing to collect), and
 * outlined when the person holds a pass that does NOT cover this spot (a 2h
 * pass on their second slot, or another sport) so nobody gets asked twice.
 */
function statusChips(ev, s, covered, exec, settle = null) {
  const pass = playerPass(s, ev.date);
  const here = exec && s.checkedIn
    ? `<span class="chip ${s.paid || covered ? 'chip-in-ok' : 'chip-in-warn'}">${esc(t('here'))}</span>`
    : '';
  const passMark = !covered && pass
    ? `<span class="chip chip-pass-off" title="${esc(t('battlePassLbl'))}">${esc(String(pass).toUpperCase())}</span>`
    : '';
  return here + passMark + paymentChip(s, covered, true, settle);
}

/*
 * Payment status (paid/unpaid/Battle Pass) is private: execs see everyone's,
 * players only see their own.
 */
function entryRow(ev, s, { waitlistPos = null, exec = false, covered = false } = {}) {
  const mine = s.deviceId === DEVICE;
  return `
    <div class="entry ${mine ? 'entry-mine' : ''} ${exec ? 'entry-clickable' : ''}" ${exec ? `data-signup="${esc(s.id)}"` : ''}>
      ${avatarHtml(s, 'avatar-sm')}
      <div class="grow entry-name">
        <span>${esc(s.name)} ${mine ? `<em>${esc(t('you'))}</em>` : ''}</span>
        ${s.addedBy ? `<small>${esc(t('broughtBy', { name: s.addedBy }))}</small>`
          : s.insta ? `<small>@${esc(s.insta)}</small>` : ''}
      </div>
      ${waitlistPos !== null ? `<span class="chip chip-wl">${esc(t('wlShort', { n: waitlistPos }))}</span>` : ''}
      ${exec ? levelChipHtml(s) : ''}
      ${exec || mine ? statusChips(ev, s, covered, exec, personSettlement(ev, s)) : ''}
      ${mine && !exec && !cancellationLocked(ev) ? `<button class="btn btn-tiny btn-ghost" data-cancel="${esc(s.id)}" title="${esc(t('remove'))}">✕</button>` : ''}
    </div>`;
}

/* Confirmed entries, grouped into teams when the list has them. */
function confirmedHtml(ev, l, confirmed, exec, coveredSet) {
  if (!confirmed.length) return `<div class="empty-list">${esc(t('beFirst'))}</div>`;
  const row = e => entryRow(ev, e, { exec, covered: coveredSet.has(e.id) });
  const teamCount = l.teamCount || 0;
  const anyAssigned = confirmed.some(e => e.team);
  if (!teamCount || !anyAssigned) {
    return confirmed.map(row).join('')
      + (teamCount && !anyAssigned ? `<div class="hint team-hint">${esc(t('noTeamYet'))}</div>` : '');
  }
  let html = '';
  for (let n = 1; n <= teamCount; n++) {
    const members = confirmed.filter(e => e.team === n);
    if (!members.length) continue;
    html += `<div class="team-divider">${esc(t('team', { n }))}</div>`;
    html += members.map(row).join('');
  }
  const rest = confirmed.filter(e => !e.team || e.team > teamCount);
  if (rest.length) {
    html += `<div class="team-divider team-unassigned">${esc(t('unassigned'))}</div>`;
    html += rest.map(row).join('');
  }
  return html;
}

/*
 * The summary an exec wants when they open a Saturday that has been played:
 * how it went, in numbers, and who took their name off. The rosters below
 * already carry the detail — this is the part that was only ever reachable
 * through the Payments modal.
 */
function eventRecordHtml(ev) {
  const people = personTotals(ev);
  const held = confirmedSignupIds(ev);
  const collected = people.reduce((a, p) => a + (p.paidAmount || 0), 0);
  const outstanding = people.filter(p => !p.paid).reduce((a, p) => a + p.total, 0);
  const checkedIn = people.filter(p => p.checkedIn).length;
  const noShows = people.filter(p => !p.checkedIn && p.signups.some(su => held.has(su.id)));
  const rms = (state.removals || []).filter(r => r.eventId === ev.id)
    .sort((a, b) => (b.removedAt || 0) - (a.removedAt || 0));

  return `
    <div class="record-banner">${esc(t('recordBanner'))}</div>
    <div class="stat-row">
      <div class="stat"><strong>${people.length}</strong><span>${esc(t('signedUp'))}</span></div>
      <div class="stat stat-good"><strong>${checkedIn}</strong><span>${esc(t('showedUp'))}</span></div>
      <div class="stat ${noShows.length ? 'stat-bad' : ''}"><strong>${noShows.length}</strong><span>${esc(t('didNotShow'))}</span></div>
      <div class="stat stat-good"><strong>${fmtMoney(collected)}</strong><span>${esc(t('collected'))}</span></div>
      <div class="stat ${outstanding ? 'stat-bad' : ''}"><strong>${fmtMoney(outstanding)}</strong><span>${esc(t('outstanding'))}</span></div>
    </div>
    ${noShows.length ? `
      <h3 class="section-sub">${esc(t('didNotShowTitle', { n: noShows.length }))}</h3>
      <div class="summary-list">
        ${noShows.map(p => `
          <div class="entry">
            <span class="grow">${esc(p.name)}</span>
            ${p.paid ? `<span class="chip chip-paid">${esc(t('paidChip'))}</span>`
              : `<span class="chip chip-unpaid">${fmtMoney(p.total)}</span>`}
          </div>`).join('')}
      </div>` : ''}
    ${rms.length ? `
      <h3 class="section-sub">${esc(t('removalsTitle', { n: rms.length }))}</h3>
      <div class="summary-list">
        ${rms.map(r => `
          <div class="entry removal-row ${r.flagged ? 'removal-flagged' : ''}">
            <div class="grow entry-name">
              <span>${esc(r.name)}${r.flagged ? ` <span class="chip chip-flag">${esc(r.wasCheckedIn ? t('wasCheckedIn') : t('removedAfterStart'))}</span>` : ''}</span>
              <small>${esc(r.sportLabel || '')} ${esc(r.listLabel || '')}${r.sessionLabel ? ' · ' + esc(r.sessionLabel) : ''} · ${esc(fmtStamp(r.removedAt))} · ${esc(r.by === 'exec' ? t('removedByExec') : t('removedBySelf'))}</small>
            </div>
            ${r.flagged && r.amountOwed ? `<span class="chip chip-unpaid">${esc(t('stillOwes', { amount: fmtMoney(r.amountOwed) }))}</span>` : ''}
          </div>`).join('')}
      </div>` : ''}`;
}

function renderEvent(ev) {
  const exec = isExec();
  const s = state.settings;
  const mine = mySignups(ev.id);
  const isOpen = isEventOpen(ev);
  const coveredSet = coveredSignupIds(ev);
  if (exec) { store.watchPayments(); store.watchRemovals(); seatPassHolders(ev); }

  const sessionsHtml = (ev.sessions || []).map(sess => {
    const lists = (ev.lists || []).filter(l => l.sessionId === sess.id);
    if (!lists.length) return '';
    return `
      <section class="session">
        <h2 class="session-title">${esc(sess.label)}</h2>
        <div class="lists-grid">
          ${lists.map(l => {
            const entries = listEntries(ev.id, l.id);
            const { confirmed, waitlist } = splitByCap(entries, l.cap || 0);
            const spotsLeft = Math.max(0, (l.cap || 0) - confirmed.length);
            const full = spotsLeft === 0;
            const sport = SPORTS[l.sport] || SPORTS.other;
            const iAmIn = entries.some(e => e.deviceId === DEVICE);
            return `
              <div class="card list-card" style="--c:${sport.color}">
                <div class="list-head">
                  <span class="list-sport">${sport.emoji} ${esc(sport.label)}</span>
                  <span class="list-level">${esc(l.label)}</span>
                </div>
                <div class="list-cap">
                  <div class="capbar"><div class="capbar-fill ${full ? 'full' : ''}" style="width:${l.cap ? Math.min(100, confirmed.length / l.cap * 100) : 0}%"></div></div>
                  <span class="cap-text">${isPastEvent(ev)
                    ? esc(t('playedCount', { n: confirmed.length }))
                    : `${confirmed.length}/${l.cap || 0}${full ? ` · ${esc(t('full'))}` : ` · ${esc(t('spotsLeft', { n: spotsLeft }))}`}`}</span>
                </div>
                <div class="entries">
                  ${confirmedHtml(ev, l, confirmed, exec, coveredSet)}
                  ${waitlist.length ? `<div class="wl-divider">${esc(t('waitlist'))}</div>${waitlist.map((e, i) => entryRow(ev, e, { waitlistPos: i + 1, exec, covered: coveredSet.has(e.id) })).join('')}` : ''}
                </div>
                ${isOpen && !iAmIn ? `<button class="btn ${full ? 'btn-ghost' : 'btn-primary'} btn-join" data-join="${esc(l.id)}">${esc(full ? t('joinWaitlist') : t('join'))}</button>` : ''}
                ${exec ? `
                  <div class="row gap exec-list-tools">
                    <button class="btn btn-tiny btn-ghost" data-exec-add="${esc(l.id)}">${esc(t('addPlayer'))}</button>
                    <label class="teams-ctl">${esc(t('teams'))}
                      <select data-teams="${esc(l.id)}">
                        <option value="0" ${!l.teamCount ? 'selected' : ''}>${esc(t('noTeams'))}</option>
                        ${teamOptionsFor(l.sport).map(n => `<option value="${n}" ${l.teamCount === n ? 'selected' : ''}>${n}</option>`).join('')}
                      </select>
                    </label>
                  </div>` : ''}
              </div>`;
          }).join('')}
        </div>
      </section>`;
  }).join('');

  $('#view').innerHTML = `
    <a class="back" href="#/">${esc(t('back'))}</a>
    <div class="event-head card">
      <div class="row gap wrap">
        <div class="grow">
          <h1 class="event-h1">${esc(fmtDate(ev.date))}</h1>
          <div class="event-sub">${esc(ev.location || s.location || '')}</div>
          <div class="event-prices">${pricesSummary(ev)}</div>
        </div>
        ${!isOpen ? `<span class="chip ${isScheduled(ev) ? 'chip-wl' : 'chip-muted'}">${esc(isScheduled(ev) ? t('opensOn', { date: fmtDateShort(localISO(new Date(eventOpensAt(ev)))) }) : (isPastEvent(ev) ? t('pastEvent') : t('closed')))}</span>` : ''}
      </div>
      ${mine.length ? `
        <div class="my-spots">
          <strong>${esc(t('yourSpots'))}</strong>
          ${mine.map(m => {
            const l = listById(ev, m.listId);
            const sess = l ? sessionById(ev, l.sessionId) : null;
            return `<span class="chip chip-mine">${esc(SPORTS[l?.sport]?.label || '')} ${esc(l ? l.label : '?')}${sess ? ' · ' + esc(sess.label) : ''}</span>${
              isOpen ? `<button class="btn btn-tiny btn-ghost" data-switch="${esc(m.id)}">${esc(t('switchSpot'))}</button>` : ''}${
              isOpen && !cancellationLocked(ev) ? `<button class="btn btn-tiny btn-ghost" data-cantmake="${esc(m.id)}">${esc(t('cantMakeIt'))}</button>` : ''}${
              // Only where there is money to give back. Somebody who never
              // paid wants "can't make it", not a refund form.
              isOpen && !cancellationLocked(ev) && (m.paid || m.amountPaid)
                ? `<button class="btn btn-tiny btn-warn" data-refund="${esc(m.id)}">${esc(t('askRefund'))}</button>` : ''}`;
          }).join('')}
          ${mine.some(m => !m.paid && !coveredSet.has(m.id)) ? `<button class="btn btn-small btn-warn" id="btn-how-pay">${esc(t('howToPay'))}</button>` : (mine.every(m => coveredSet.has(m.id)) ? passChipHtml(playerPass(DEVICE, ev.date)) : `<span class="chip chip-paid">${esc(t('allPaid'))}</span>`)}
          ${ev.date === todayStr() && isOpen ? (mine.every(m => m.checkedIn)
            ? `<span class="chip chip-in-ok">${esc(t('selfCheckedIn'))}</span><button class="btn btn-tiny btn-ghost" id="btn-self-out">${esc(t('undo'))}</button>`
            : `<button class="btn btn-small btn-success" id="btn-self-in">${esc(t('imHere'))}</button>`) : ''}
        </div>
        ${!exec && isOpen && cancellationLocked(ev) ? `<p class="hint">${esc(t('cancelLocked'))}</p>` : ''}` : ''}
      ${isScheduled(ev) ? `<p class="hint scheduled-note">${esc(t('notOpenYet', { date: fmtDate(localISO(new Date(eventOpensAt(ev)))) }))}</p>` : ''}
      ${exec && isPastEvent(ev) ? eventRecordHtml(ev) : ''}
      ${exec ? `
        <div class="row gap wrap exec-toolbar">
          ${isScheduled(ev) ? `<button class="btn btn-small btn-primary" id="btn-open-now">${esc(t('openNow'))}</button>` : ''}
          <button class="btn btn-small btn-ghost" id="btn-edit-event">${esc(t('editEvent'))}</button>
          <button class="btn btn-small ${(state.payments || []).some(p => !p.matched) ? 'btn-warn' : 'btn-ghost'}" id="btn-summary">${esc(t('payments'))}${(state.payments || []).filter(p => !p.matched).length ? ` · ${(state.payments || []).filter(p => !p.matched).length}` : ''}</button>
          <button class="btn btn-small btn-ghost" id="btn-csv">${esc(t('exportCsv'))}</button>
          <button class="btn btn-small btn-ghost" id="btn-toggle-open">${esc(isOpen ? t('closeSignups') : t('reopenSignups'))}</button>
          <button class="btn btn-small btn-ghost" id="btn-find">${esc(t('findPlayer'))}</button>
          ${!isPastEvent(ev) ? `<button class="btn btn-small btn-danger" id="btn-delete-event">${esc(t('deleteThisSaturday'))}</button>` : ''}
        </div>` : ''}
    </div>
    ${sessionsHtml}
  `;

  $$('[data-join]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    openJoinSheet(ev, b.dataset.join);
  }));
  $$('[data-cancel]').forEach(b => b.addEventListener('click', async e => {
    e.preventDefault();
    const su = eventSignups(ev.id).find(x => x.id === b.dataset.cancel);
    if (!su) return;
    if (await confirmModal(t('removeSelfConfirm', { name: su.name }), t('removeMe'))) {
      await removeSignup(ev, su, 'self');
      toast(t('removedSelf'));
    }
  }));
  $$('[data-refund]').forEach(b => b.addEventListener('click', async () => {
    const su = mySignups(ev.id).find(x => x.id === b.dataset.refund);
    if (!su) return;
    const l = listById(ev, su.listId);
    const paid = personSettlement(ev, su);
    const amount = round2(su.amountPaid || paid?.received || computePrice(ev, [su.listId], su.method, null).total);
    if (!await confirmModal(t('askRefundConfirm', {
      list: l?.label || '', amount: fmtMoney(amount),
    }), t('askRefund'))) return;
    b.disabled = true;
    // The request is filed BEFORE the spot goes: if the removal fails we
    // would rather have a refund nobody asked for than money nobody
    // recorded. An exec can always dismiss one.
    await store.addRefund({
      id: uid('rf'),
      eventId: ev.id, date: ev.date,
      name: su.name, email: su.email || '',
      listLabel: l?.label || '', sportLabel: SPORTS[l?.sport]?.label || '',
      sessionLabel: sessionById(ev, l?.sessionId)?.label || '',
      amount, askedAt: Date.now(), settled: false,
    });
    await removeSignup(ev, su, 'self');
    toast(t('askRefundDone'));
  }));
  $$('[data-cantmake]').forEach(b => b.addEventListener('click', async () => {
    const su = mySignups(ev.id).find(x => x.id === b.dataset.cantmake);
    if (!su) return;
    const l = listById(ev, su.listId);
    const held = !!su.viaPass;
    const ask = held ? t('cantMakeHeldConfirm', { list: l?.label || '' })
                     : t('cantMakeConfirm', { list: l?.label || '' });
    if (!await confirmModal(ask, t('cantMakeIt'))) return;
    b.disabled = true;
    await removeSignup(ev, su, 'self');
    toast(held ? t('cantMakeHeldDone') : t('removedSelf'));
  }));
  $$('[data-switch]').forEach(b => b.addEventListener('click', () => {
    const su = mySignups(ev.id).find(x => x.id === b.dataset.switch);
    if (su) openSwitchSheet(ev, su);
  }));
  $('#btn-find')?.addEventListener('click', () => openFindModal(ev));
  $('#btn-how-pay')?.addEventListener('click', () => openPayInfoModal(ev));
  $('#btn-self-in')?.addEventListener('click', async () => {
    await Promise.all(mySignups(ev.id).map(m => store.updateSignup(ev.id, m.id, { checkedIn: true, selfCheckIn: true })));
    toast(t('selfCheckedInToast'));
  });
  $('#btn-self-out')?.addEventListener('click', async () => {
    await Promise.all(mySignups(ev.id).map(m => store.updateSignup(ev.id, m.id, { checkedIn: false, selfCheckIn: false })));
    toast(t('selfCheckOutToast'));
  });

  if (exec) {
    $$('[data-signup]').forEach(row => row.addEventListener('click', e => {
      if (e.target.closest('[data-cancel]')) return;
      const su = eventSignups(ev.id).find(x => x.id === row.dataset.signup);
      if (su) openPlayerAdminModal(ev, su);
    }));
    $$('[data-exec-add]').forEach(b => b.addEventListener('click', () => openExecAddModal(ev, b.dataset.execAdd)));
    $$('[data-teams]').forEach(sel => sel.addEventListener('change', async () => {
      const lists = ev.lists.map(l => l.id === sel.dataset.teams ? { ...l, teamCount: +sel.value } : l);
      await store.saveEvent({ ...ev, lists });
    }));
    $('#btn-open-now')?.addEventListener('click', async () => {
      await store.saveEvent({ ...ev, openEarly: true });
      toast(t('openedNow'));
    });
    $('#btn-edit-event')?.addEventListener('click', () => openEventEditor(ev));
    $('#btn-delete-event')?.addEventListener('click', async () => {
      const n = eventSignups(ev.id).filter(su => !su.viaPass).length;
      const held = eventSignups(ev.id).length - n;
      if (!await confirmModal(t('deleteSaturdayAsk', {
        date: fmtDate(ev.date), n, held,
      }), t('deleteEvent'))) return;
      await store.deleteEvent(ev.id);
      logAction('event', t('logEventDeleted', { date: fmtDateShort(ev.date), n }));
      toast(t('eventDeleted'));
      location.hash = '#/';
    });
    $('#btn-summary')?.addEventListener('click', () => openSummaryModal(ev));
    $('#btn-csv')?.addEventListener('click', () => exportCsv(ev));
    $('#btn-toggle-open')?.addEventListener('click', async () => {
      await store.saveEvent({ ...ev, status: isOpen ? 'closed' : 'open' });
      toast(isOpen ? t('signupsClosed') : t('signupsReopened'));
      // Closing a Saturday is usually a cancelled game. Everyone on the list
      // finds out at the door unless somebody tells them, and "somebody"
      // was nobody.
      if (isOpen) await offerCancelNotice(ev);
    });
  }
}

/* ================================================================== */
/* Profile + join flow                                                 */
/* ================================================================== */

function profileFieldsHtml(p) {
  return `
    <div class="row gap center">
      <label class="avatar-pick" title="${esc(t('addPhoto'))}">
        <span id="pf-avatar">${p ? avatarHtml(p) : '<span class="avatar avatar-letter">+</span>'}</span>
        <input type="file" accept="image/*" id="pf-photo" hidden>
      </label>
      <div class="grow stack">
        <input class="input" id="pf-name" placeholder="${esc(t('namePh'))}" value="${esc(p?.name || '')}" maxlength="40">
        <input class="input" id="pf-email" type="email" placeholder="${esc(t('emailPh'))}" value="${esc(p?.email || '')}" maxlength="80">
        <div class="row gap">
          <input class="input" id="pf-phone" type="tel" placeholder="${esc(t('phonePh'))}" value="${esc(p?.phone || '')}" maxlength="20">
          <input class="input" id="pf-insta" placeholder="${esc(t('instaPh'))}" value="${esc(p?.insta || '')}" maxlength="40">
        </div>
      </div>
    </div>`;
}

let pendingPhoto = null;

function wireProfileFields(ov, existing) {
  pendingPhoto = existing?.photo || '';
  $('#pf-photo', ov).addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      pendingPhoto = await fileToThumb(f);
      $('#pf-avatar', ov).innerHTML = `<img class="avatar" src="${pendingPhoto}" alt="">`;
    } catch (err) { toast(t('badImage'), 'err'); }
  });
}

function readProfileFields(ov) {
  const name = $('#pf-name', ov).value.trim();
  const email = $('#pf-email', ov).value.trim();
  const phone = $('#pf-phone', ov).value.trim();
  const insta = $('#pf-insta', ov).value.trim().replace(/^@/, '');
  if (!name) { toast(t('nameRequired'), 'err'); return null; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast(t('emailRequired'), 'err'); return null; }
  return { name, email, phone, insta, photo: pendingPhoto || '' };
}

function openProfileModal() {
  const p = getProfile();
  const ov = openModal(`
    <div class="modal-body">
      <h2>${esc(t('yourProfile'))}</h2>
      <p class="hint">${esc(t('profileHint'))}</p>
      ${profileFieldsHtml(p)}
      <button class="btn btn-ghost wide" id="pf-transfer">${esc(t('useOtherDevice'))}</button>
      <div class="row gap">
        <button class="btn btn-ghost grow" data-close>${esc(t('cancel'))}</button>
        <button class="btn btn-primary grow" id="pf-save">${esc(t('save'))}</button>
      </div>
    </div>`);
  wireProfileFields(ov, p);
  $('#pf-transfer', ov).addEventListener('click', () => { ov.remove(); openTransferModal(); });
  $('#pf-save', ov).addEventListener('click', () => {
    const np = readProfileFields(ov);
    if (!np) return;
    const clash = emailTakenBy(np.email, DEVICE);
    if (clash) { ov.remove(); openDuplicateEmailModal(clash, np.email); return; }
    saveProfile(np);
    registerPlayer(np);
    ov.remove(); toast(t('profileSaved')); render();
  });
}

/*
 * Bring a friend.
 *
 * The friend gets their own sign-up under their own name and email — not a
 * "+1" on somebody else's row — so they can be emailed, reminded, checked in
 * and chased like anyone else, and so the club is not guessing who actually
 * turned up.
 *
 * They can only be put on a list the person adding them could join
 * themselves. An ungraded member vouching for a friend cannot seat them above
 * their own level, and the club still grades the friend properly afterwards.
 * Their row carries who brought them, because the person who vouched is who
 * an exec asks when a stranger does not show.
 */
function openFriendSheet(ev) {
  const me = getProfile();
  const myRank = playerLevel(DEVICE);
  const busy = new Set();   // slots the FRIEND is in, filled as we go

  const listsHtml = (ev.sessions || []).map(sess => {
    const lists = (ev.lists || []).filter(l => l.sessionId === sess.id && canSelfJoin(l));
    if (!lists.length) return '';
    return `
      <div class="join-session">
        <div class="join-session-label">${esc(sess.label)}</div>
        ${lists.map(l => {
          const { confirmed } = splitByCap(listEntries(ev.id, l.id), l.cap || 0);
          const full = confirmed.length >= (l.cap || 0);
          const sport = SPORTS[l.sport] || SPORTS.other;
          return `
            <label class="join-list ${full ? 'join-full' : ''}">
              <input type="checkbox" data-flist="${esc(l.id)}" data-fsess="${esc(sess.id)}">
              <span class="grow">${esc(sport.label)} — ${esc(l.label)}</span>
              ${full ? `<span class="chip chip-wl">${esc(t('waitlist').toLowerCase())}</span>` : ''}
            </label>`;
        }).join('')}
      </div>`;
  }).join('');

  const ov = openModal(`
    <div class="modal-body">
      <h2 class="m0">${esc(t('addFriendTitle'))}</h2>
      <p class="hint">${esc(t('addFriendHint', {
        level: myRank ? levelByRank(myRank).label : t('noLevel'),
      }))}</p>
      <input class="input" id="fr-name" placeholder="${esc(t('friendNamePh'))}" maxlength="40">
      <input class="input" id="fr-email" type="email" placeholder="${esc(t('friendEmailPh'))}" maxlength="80">
      <h3 class="section-sub">${esc(t('pickLists'))}</h3>
      ${listsHtml || `<p class="hint">${esc(t('nothingOpenForFriend'))}</p>`}
      <h3 class="section-sub">${esc(t('payMethod'))}</h3>
      <div class="row gap">
        <label class="pay-opt"><input type="radio" name="fpaym" value="etransfer" checked> <span>${esc(t('etransfer'))}</span></label>
        <label class="pay-opt"><input type="radio" name="fpaym" value="cash"> <span>${esc(t('cashOnSite'))}</span></label>
      </div>
      <p class="hint">${esc(t('addFriendPayNote'))}</p>
      <div class="row gap">
        <button class="btn btn-ghost grow" data-close>${esc(t('cancel'))}</button>
        <button class="btn btn-primary grow" id="fr-go">${esc(t('addFriendGo'))}</button>
      </div>
    </div>`);

  // One list per slot for the friend too — same body, same rule.
  $$('input[data-flist]', ov).forEach(box => box.addEventListener('change', () => {
    if (!box.checked) return;
    for (const other of $$('input[data-flist]', ov)) {
      if (other !== box && other.checked && other.dataset.fsess === box.dataset.fsess) {
        other.checked = false;
        toast(t('onePerSlot'), 'warn');
      }
    }
  }));

  $('#fr-go', ov).addEventListener('click', async () => {
    const name = $('#fr-name', ov).value.trim();
    const email = $('#fr-email', ov).value.trim();
    if (!name) { toast(t('nameRequired'), 'err'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast(t('emailRequired'), 'err'); return; }
    const chosen = $$('input[data-flist]:checked', ov).map(c => c.dataset.flist);
    if (!chosen.length) { toast(t('pickOne'), 'err'); return; }
    if (chosen.some(id => !canSelfJoin(listById(ev, id)))) { toast(t('levelBlocked'), 'err'); return; }

    // One profile per email, friends included: if this address is already a
    // member, adding them here would fork their record.
    const existing = findPlayerByEmail(email);
    const friendDevice = existing ? existing.deviceId : 'friend:' + email.toLowerCase();
    // And they must not end up twice on the same night.
    const theirId = identityOf({ email, deviceId: friendDevice, name });
    if (chosen.some(id => identitiesInSession(ev, listById(ev, id)?.sessionId).has(theirId))) {
      toast(t('friendAlreadyIn', { name }), 'err'); return;
    }

    const method = $('input[name="fpaym"]:checked', ov).value;
    const now = Date.now();
    await store.addSignups(ev.id, chosen.map((listId, i) => ({
      id: uid('su'), listId, name, email, phone: '', insta: '', photo: '',
      deviceId: friendDevice, method, paid: false, checkedIn: false, team: null,
      lang: getLang(), order: now + i, createdAt: now + i,
      addedByExec: false, addedBy: me?.name || '', addedByDevice: DEVICE,
    })));
    ov.remove();
    toast(t('friendAdded', { name }));
    sendConfirmationEmail(ev, { name, email, lang: getLang() }, chosen, method);
  });
}

/*
 * Change a spot: a different sport, or a different hour, without leaving the
 * event and coming back. Removing and re-joining worked, but it filed a
 * removal against the player in the proof trail — the record that exists to
 * show who walked away from a game they owed for — and switching lists is
 * not that.
 *
 * The new list takes them at the back, because the people already on it were
 * there first. The slot they leave promotes whoever was next, exactly as a
 * removal would.
 */
function openSwitchSheet(ev, su) {
  const cur = listById(ev, su.listId);
  const busy = mySessionIds(ev, su.id);     // their other spots, not this one
  const options = (ev.sessions || []).map(sess => {
    const lists = (ev.lists || []).filter(l =>
      l.sessionId === sess.id && l.id !== su.listId && canSelfJoin(l) && !busy.has(sess.id));
    if (!lists.length) return '';
    return `
      <div class="join-session">
        <div class="join-session-label">${esc(sess.label)}</div>
        ${lists.map(l => {
          const { confirmed } = splitByCap(listEntries(ev.id, l.id), l.cap || 0);
          const full = confirmed.length >= (l.cap || 0);
          const sport = SPORTS[l.sport] || SPORTS.other;
          return `
            <button class="join-list switch-opt" data-to="${esc(l.id)}">
              <span class="grow">${esc(sport.label)} — ${esc(l.label)}</span>
              ${full ? `<span class="chip chip-wl">${esc(t('waitlist').toLowerCase())}</span>`
                     : `<span class="chip chip-muted">${esc(t('spotsLeft', { n: (l.cap || 0) - confirmed.length }))}</span>`}
            </button>`;
        }).join('')}
      </div>`;
  }).join('');

  const ov = openModal(`
    <div class="modal-body">
      <h2 class="m0">${esc(t('switchTitle'))}</h2>
      <p class="hint">${esc(t('switchFrom', {
        sport: SPORTS[cur?.sport]?.label || '', list: cur?.label || '',
        session: sessionById(ev, cur?.sessionId)?.label || '',
      }))}</p>
      ${options || `<p class="hint">${esc(t('nowhereToSwitch'))}</p>`}
      <p class="hint">${esc(t('switchNote'))}</p>
      <button class="btn btn-ghost wide" data-close>${esc(t('cancel'))}</button>
    </div>`);

  let switching = false;
  $$('[data-to]', ov).forEach(b => b.addEventListener('click', async () => {
    if (switching) return;                     // double tap on a slow phone
    switching = true;
    $$('[data-to]', ov).forEach(x => x.disabled = true);
    const to = listById(ev, b.dataset.to);
    const moved = await moveSignup(ev, su, b.dataset.to);
    ov.remove();
    if (moved) toast(t('switched', { sport: SPORTS[to?.sport]?.label || '', list: to?.label || '' }));
  }));
}

function openJoinSheet(ev, preselectedListId) {
  const wanted = preselectedListId && listById(ev, preselectedListId);
  if (wanted && !canSelfJoin(wanted)) {
    openContactModal(t('levelBlocked'));
    return;
  }
  const p = getProfile();
  const myIds = new Set(mySignups(ev.id).map(m => m.listId));
  const s = state.settings;

  const busySessions = mySessionIds(ev);
  const listCheckboxes = (ev.sessions || []).map(sess => {
    const lists = (ev.lists || []).filter(l => l.sessionId === sess.id && !myIds.has(l.id));
    if (!lists.length) return '';
    const taken = busySessions.has(sess.id);
    return `
      <div class="join-session">
        <div class="join-session-label">${esc(sess.label)}</div>
        ${lists.map(l => {
          const entries = listEntries(ev.id, l.id);
          const full = entries.length >= (l.cap || 0);
          const sport = SPORTS[l.sport] || SPORTS.other;
          // Levels above the player's grade stay visible but locked. Hiding
          // them would just prompt "where did Advanced + go?" — this says
          // the spot exists and who to ask for it.
          const barred = !canSelfJoin(l) || taken;
          return `
            <label class="join-list ${full ? 'join-full' : ''} ${barred ? 'join-barred' : ''}" data-session="${esc(sess.id)}">
              <input type="checkbox" data-list="${esc(l.id)}" data-sess="${esc(sess.id)}" ${barred ? 'disabled' : ''} ${l.id === preselectedListId && !barred ? 'checked' : ''}>
              <span class="grow">${esc(sport.label)} — ${esc(l.label)}</span>
              ${taken ? `<span class="chip chip-muted">${esc(t('slotTaken'))}</span>`
                : !canSelfJoin(l) ? `<button type="button" class="btn btn-tiny btn-ghost" data-ask="${esc(l.id)}">${esc(t('askExec'))}</button>`
                : full ? `<span class="chip chip-wl">${esc(t('waitlist').toLowerCase())}</span>` : ''}
            </label>`;
        }).join('')}
      </div>`;
  }).join('');

  const ov = openModal(`
    <div class="modal-body">
      <h2>${esc(t('signupTitle', { date: fmtDate(ev.date) }))}</h2>
      ${profileFieldsHtml(p)}
      <h3 class="section-sub">${esc(t('pickLists'))}</h3>
      <div class="prices-once">${pricesSummary(ev)}</div>
      ${listCheckboxes || `<p class="hint">${esc(t('onEveryList'))}</p>`}
      <h3 class="section-sub">${esc(t('payMethod'))}</h3>
      <div class="row gap">
        <label class="pay-opt"><input type="radio" name="paym" value="etransfer" checked> <span>${esc(t('etransfer'))}</span></label>
        <label class="pay-opt"><input type="radio" name="paym" value="cash"> <span>${esc(t('cashOnSite'))}</span></label>
      </div>
      <div class="price-box" id="join-price"></div>
      <div class="pay-instructions" id="join-payinfo"></div>
      <p class="hint">${esc(t('levelNote'))} ${esc(t('waitlistNote'))}</p>
      <div class="row gap">
        <button class="btn btn-ghost grow" data-close>${esc(t('cancel'))}</button>
        <button class="btn btn-primary grow" id="join-confirm">${esc(t('confirmSignup'))}</button>
      </div>
      <button class="btn btn-ghost wide" id="join-friend">${esc(t('addFriendBtn'))}</button>
      ${s.policiesUrl ? `<a class="policies-link" href="${esc(s.policiesUrl)}" target="_blank" rel="noopener">${esc(t('policiesLink'))}</a>` : ''}
    </div>`);

  wireProfileFields(ov, p);

  $('#join-friend', ov)?.addEventListener('click', () => { ov.remove(); openFriendSheet(ev); });

  // "Ask an exec" is a request, not a dead end: it mails the club with who is
  // asking and which level, so an exec can grade them and they can sign up.
  $$('[data-ask]', ov).forEach(b => b.addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation();
    const l = listById(ev, b.dataset.ask);
    const me = getProfile();
    const lvl = levelByRank(playerLevel(DEVICE));
    b.disabled = true;
    const r = await sendMail({
      to: s.etransferEmail || '',
      subject: tLang('en', 'emailAskSubject', { name: me?.name || '' }),
      message: tLang('en', 'emailAskBody', {
        name: me?.name || '', email: me?.email || '', phone: me?.phone || '-',
        level: lvl ? lvl.label : tLang('en', 'noLevel'),
        wants: `${SPORTS[l?.sport]?.label || ''} — ${l?.label || ''}`,
        date: fmtDate(ev.date), club: s.clubFullName || 'CRSC',
      }),
    });
    b.textContent = t('askSent');
    toast(r.sent ? t('askSentToast') : t('askSentOffline'), r.sent ? 'ok' : 'warn');
    // The execs now have it in writing. This is how they get an answer tonight.
    openContactModal(t('askedAbout', { list: `${SPORTS[l?.sport]?.label || ''} — ${l?.label || ''}` }));
  }));

  function refreshPrice() {
    const method = $('input[name="paym"]:checked', ov).value;
    const myPass = playerPass(DEVICE, ev.date);
    const chosen = $$('input[data-list]:checked', ov).map(c => c.dataset.list);
    const already = [...myIds];
    const { total: totalAll } = computePrice(ev, [...chosen, ...already], method, myPass);
    const { total: totalOld } = computePrice(ev, already, method, myPass);
    const due = totalAll - totalOld;
    const { parts } = computePrice(ev, chosen.length ? [...chosen, ...already] : [], method, myPass);
    $('#join-price', ov).innerHTML = chosen.length
      ? `${parts.map(pt => `<div class="price-line"><span>${esc(pt.label)}</span><span>${fmtMoney(pt.price)}</span></div>`).join('')}
         <div class="price-line price-total"><span>${esc(already.length ? t('newTotal') : t('toPay'))}</span><span>${fmtMoney(already.length ? totalAll : due)}</span></div>
         ${(already.length ? totalAll : due) === 0 && myPass ? `<p class="hint">${esc(t('battlePassCovered'))}</p>` : ''}`
      : `<p class="hint">${esc(t('selectOne'))}</p>`;
    $('#join-payinfo', ov).innerHTML = method === 'etransfer'
      ? `<p>${esc(t('etransferTo'))} <strong>${esc(s.etransferEmail)}</strong><br><small>${esc(t('mentionName'))}</small></p>`
      : `<p>${esc(t('bringCash'))} <small>${esc(s.lateFeeNote || '')}</small></p>`;
  }
  // Ticking a second list in a slot unticks the first: the sheet enforces
  // one-per-slot as you go, instead of refusing at the end.
  $$('input[data-list]', ov).forEach(box => box.addEventListener('change', () => {
    if (!box.checked) return;
    for (const other of $$('input[data-list]', ov)) {
      if (other !== box && other.checked && other.dataset.sess === box.dataset.sess) {
        other.checked = false;
        toast(t('onePerSlot'), 'warn');
      }
    }
  }));
  $$('input[data-list], input[name="paym"]', ov).forEach(i => i.addEventListener('change', refreshPrice));
  refreshPrice();

  let joining = false;
  $('#join-confirm', ov).addEventListener('click', async () => {
    if (joining) return;                       // double tap on a slow phone
    const np = readProfileFields(ov);
    if (!np) return;
    const chosen = $$('input[data-list]:checked', ov).map(c => c.dataset.list);
    if (!chosen.length) { toast(t('pickOne'), 'err'); return; }
    // The checkbox is disabled, but never trust the form alone.
    if (chosen.some(id => !canSelfJoin(listById(ev, id)))) { toast(t('levelBlocked'), 'err'); return; }
    const slots = chosen.map(id => listById(ev, id)?.sessionId);
    if (slots.some((x, i) => slots.indexOf(x) !== i)) { toast(t('onePerSlot'), 'err'); return; }
    // Re-check against the list as it is right now, not as it was when this
    // sheet was drawn: another tab, another phone, or a second tap on this
    // button may have put them on it since.
    const meId = identityOf({ email: np.email, deviceId: DEVICE, name: np.name });
    for (const sid of slots) {
      if (identitiesInSession(ev, sid).has(meId)) { toast(t('alreadyOnList'), 'err'); return; }
    }
    const method = $('input[name="paym"]:checked', ov).value;
    saveProfile(np);
    registerPlayer(np);
    const now = Date.now();
    const signups = chosen.map((listId, i) => ({
      id: uid('su'),
      listId,
      name: np.name,
      email: np.email,
      phone: np.phone,
      insta: np.insta,
      photo: np.photo,
      deviceId: DEVICE,
      method,
      paid: false,
      checkedIn: false,
      team: null,
      lang: getLang(),
      order: now + i,
      createdAt: now + i,
      addedByExec: false,
    }));
    joining = true;
    $('#join-confirm', ov).disabled = true;
    try {
      await store.addSignups(ev.id, signups);
      ov.remove();
      toast(t('onTheList'));
      openPayInfoModal(ev, method);
      sendConfirmationEmail(ev, np, chosen, method);
    } catch (err) {
      console.error(err);
      toast(t('errGeneric'), 'err');
      joining = false;
      const btn = $('#join-confirm', ov);
      if (btn) btn.disabled = false;
    }
  });
}

function openPayInfoModal(ev, method) {
  const s = state.settings;
  const mine = mySignups(ev.id).filter(m => !m.paid);
  const m = method || (mine[0]?.method) || 'etransfer';
  const ids = mySignups(ev.id).map(x => x.listId);
  const { total } = computePrice(ev, ids, m, playerPass(DEVICE, ev.date));
  if (total === 0 && playerPass(DEVICE, ev.date)) {
    openModal(`
      <div class="modal-body">
        <h2>${esc(t('howToPay'))}</h2>
        <p class="pay-email">${esc(t('battlePass'))}</p>
        <p class="hint">${esc(t('battlePassCovered'))}</p>
        <button class="btn btn-primary wide" data-close>${esc(t('gotIt'))}</button>
      </div>`);
    return;
  }
  openModal(`
    <div class="modal-body">
      <h2>${esc(t('howToPay'))}</h2>
      <div class="price-box">
        <div class="price-line price-total"><span>${esc(t('yourTotal', { date: fmtDate(ev.date) }))}</span><span>${fmtMoney(total)}</span></div>
      </div>
      ${m === 'etransfer' ? `
        <p>${esc(t('etransferTo'))}</p>
        <p class="pay-email">${esc(s.etransferEmail)}</p>
        <p class="hint">${esc(t('mentionName'))}</p>` : `
        <p>${esc(t('bringCash'))}</p>`}
      <p class="hint">${esc(s.lateFeeNote || '')}</p>
      <button class="btn btn-primary wide" data-close>${esc(t('gotIt'))}</button>
    </div>`);
}

/* ================================================================== */
/* Exec: PIN                                                           */
/* ================================================================== */

function openPinModal() {
  const ov = openModal(`
    <div class="modal-body">
      <h2>${esc(t('execAccess'))}</h2>
      <input class="input input-pin" id="pin-input" type="password" inputmode="numeric" placeholder="${esc(t('clubPin'))}" maxlength="12" autofocus>
      <div class="row gap">
        <button class="btn btn-ghost grow" data-close>${esc(t('cancel'))}</button>
        <button class="btn btn-primary grow" id="pin-go">${esc(t('unlock'))}</button>
      </div>
    </div>`);
  const tryPin = () => {
    const val = $('#pin-input', ov).value.trim();
    if (val && val === String(state.settings.execPin || '')) {
      setExec(true); ov.remove(); toast(t('execModeOn')); render();
    } else {
      toast(t('wrongPin'), 'err');
    }
  };
  $('#pin-go', ov).addEventListener('click', tryPin);
  $('#pin-input', ov).addEventListener('keydown', e => { if (e.key === 'Enter') tryPin(); });
  $('#pin-input', ov).focus();
}

/* ================================================================== */
/* Exec: player admin                                                  */
/* ================================================================== */

function openPlayerAdminModal(ev, su) {
  // Live, like the Payments screen: two execs can be looking at the same
  // person, and the one who did not tap must still see what happened.
  return liveModal(ov => paintPlayerAdmin(ov, ev,
    eventSignups(ev.id).find(x => x.id === su.id) || su));
}

function paintPlayerAdmin(ov, ev, su) {
  const curList = listById(ev, su.listId);
  // A pass already covers this spot, so there is no money to take for it.
  const coveredHere = coveredSignupIds(ev).has(su.id);
  const listsOptions = (ev.lists || []).map(l => {
    const sess = sessionById(ev, l.sessionId);
    return `<option value="${esc(l.id)}" ${l.id === su.listId ? 'selected' : ''}>${esc(sess ? sess.label : '')} · ${esc(SPORTS[l.sport]?.label || '')} ${esc(l.label)}</option>`;
  }).join('');
  const teamCount = curList?.teamCount || 0;
  ov.querySelector('.modal').innerHTML = `
    <div class="modal-body">
      <div class="row gap center">
        ${avatarHtml(su)}
        <div class="grow">
          <h2 class="m0">${esc(su.name)}</h2>
          <small class="hint">
            ${su.insta ? `<a href="https://instagram.com/${esc(su.insta)}" target="_blank" rel="noopener">@${esc(su.insta)}</a>` : esc(t('noInsta'))}
            · ${su.email ? esc(su.email) : esc(t('noEmail'))}${su.phone ? ` · ${esc(su.phone)}` : ''}
          </small>
        </div>
      </div>
      <div class="row gap">
        <button class="btn grow cb" id="pa-paid"></button>
        <button class="btn grow cb" id="pa-in"></button>
      </div>
      <p class="hint">${esc(su.method === 'cash' ? t('cashOnSite') : t('etransfer'))}${su.addedByExec ? ' · ' + esc(t('addedByExec')) : ''}</p>
      ${coveredHere ? '' : `
        <label class="field-label">${esc(t('gotPaidLbl'))}</label>
        <div class="row gap center">
          <input class="input input-amount" id="pa-amount" type="number" inputmode="decimal" min="0" step="0.01"
                 value="${su.amountPaid != null ? esc(String(su.amountPaid)) : ''}" placeholder="0.00">
          <button class="btn btn-small btn-success" id="pa-amount-go">${esc(t('record'))}</button>
          ${su.amountPaid ? `<button class="btn btn-small btn-ghost" id="pa-amount-clear">${esc(t('clear'))}</button>` : ''}
        </div>
        <p class="hint" id="pa-owed"></p>`}
      ${teamCount ? (() => {
        // Enforce per-team size limits (volleyball: max 7 per team).
        const size = SPORTS[curList?.sport]?.teamSize || 0;
        const { confirmed } = splitByCap(listEntries(ev.id, su.listId), curList?.cap || 0);
        return `
        <label class="field-label">${esc(t('putInTeam'))}${size ? ` (max ${size})` : ''}</label>
        <div class="row gap wrap" id="pa-teams">
          <button class="btn btn-small ${!su.team ? 'btn-exec' : 'btn-ghost'}" data-team="0">—</button>
          ${Array.from({ length: teamCount }, (_, i) => {
            const n = i + 1;
            const members = confirmed.filter(e => e.team === n).length;
            const full = size && members >= size && su.team !== n;
            return `<button class="btn btn-small ${su.team === n ? 'btn-exec' : 'btn-ghost'}" data-team="${n}" ${full ? 'disabled' : ''}>${n}${size ? ` · ${members}/${size}` : ''}</button>`;
          }).join('')}
        </div>`;
      })() : ''}
      ${su.deviceId && su.deviceId !== 'exec-added' ? `
        <label class="field-label">${esc(t('levelLbl'))}</label>
        <div class="row gap wrap" id="pa-level">
          <button class="btn btn-small grow" data-level="" title="${esc(t('noLevel'))}">—</button>
          ${LEVELS.map(l => `<button class="btn btn-small grow" data-level="${l.rank}" title="${esc(l.label)}">${esc(l.short)}</button>`).join('')}
        </div>
        <label class="field-label">${esc(t('battlePassLbl'))}</label>
        <button class="btn btn-small wide ${playerPass(su) ? 'btn-exec' : 'btn-ghost'}" id="pa-pass">
          ${esc(playerPass(su) ? t('passSetTo', { type: playerPass(su).toUpperCase() }) : t('setPass'))}
        </button>` : ''}
      <label class="field-label">${esc(t('moveTo'))}</label>
      <select class="input" id="pa-move">${listsOptions}</select>
      <div class="row gap">
        <button class="btn btn-ghost grow" id="pa-top">${esc(t('topOfList'))}</button>
        <button class="btn btn-danger grow" id="pa-remove">${esc(t('remove'))}</button>
      </div>
      <button class="btn btn-ghost wide" data-close>${esc(t('done'))}</button>
    </div>`;
  $$('[data-close]', ov).forEach(b => b.addEventListener('click', () => ov.remove()));

  /*
   * Paid / checked-in as checkboxes with traffic-light colors:
   * both off = red, exactly one on = yellow, both on = green.
   * A Battle Pass counts as paid (its checkbox is locked on).
   */
  function paintStatus() {
    const p = su.paid || coveredHere;
    const c = !!su.checkedIn;
    const onCls = p && c ? 'cb-green' : 'cb-yellow';
    const paidBtn = $('#pa-paid', ov);
    const inBtn = $('#pa-in', ov);
    paidBtn.className = 'btn grow cb ' + (p ? onCls : (c ? 'cb-off' : 'cb-red'));
    inBtn.className = 'btn grow cb ' + (c ? onCls : (p ? 'cb-off' : 'cb-red'));
    paidBtn.textContent = (p ? '☑ ' : '☐ ') + (coveredHere ? `${t('battlePass')} ${(playerPass(su) || '').toUpperCase()}` : (p ? t('paid') : t('markPaid')));
    inBtn.textContent = (c ? '☑ ' : '☐ ') + (c ? t('checkedIn') : t('checkIn'));
    paidBtn.disabled = coveredHere;
  }
  paintStatus();
  $('#pa-paid', ov).addEventListener('click', async () => {
    if (coveredHere) return;
    const next = !su.paid;
    await store.updateSignup(ev.id, su.id, { paid: next, paidAt: next ? Date.now() : null });
    logAction('paid', t(next ? 'logPaid' : 'logUnpaid', {
      name: su.name, email: su.email || '\u2014', date: fmtDateShort(ev.date),
    }));
    su.paid = next;
    paintStatus();
    if (next) await notifyIfSettled(ev, su);
  });
  // What this person still owes for the whole night, not just this one spot,
  // because that is the number the exec is holding cash against.
  const paintOwed = () => {
    const el = $('#pa-owed', ov);
    if (!el) return;
    const me = personTotals(ev).find(x => x.name === su.name);
    if (!me) { el.textContent = ''; return; }
    el.textContent = me.total > 0
      ? t('stillOwesNight', { amount: fmtMoney(me.total), billed: fmtMoney(me.billed) })
      : (me.received ? t('settledWith', { amount: fmtMoney(me.received) }) : t('nothingOwed'));
  };
  paintOwed();

  $('#pa-amount-go', ov)?.addEventListener('click', async () => {
    const raw = $('#pa-amount', ov).value.trim();
    const amount = raw === '' ? null : Math.max(0, round2(raw));
    if (amount !== null && !isFinite(amount)) { toast(t('badAmount'), 'err'); return; }
    await store.updateSignup(ev.id, su.id, { amountPaid: amount, paidAt: amount ? Date.now() : null });
    su.amountPaid = amount;
    logAction('amount', amount
      ? t('logAmount', { name: su.name, amount: fmtMoney(amount), date: fmtDateShort(ev.date) })
      : t('logAmountCleared', { name: su.name, date: fmtDateShort(ev.date) }));
    toast(amount ? t('amountRecorded', { name: su.name, amount: fmtMoney(amount) }) : t('amountCleared'));
    paintOwed();
    paintStatus();
    if (amount) await notifyIfSettled(ev, su);
  });
  $('#pa-amount-clear', ov)?.addEventListener('click', async () => {
    await store.updateSignup(ev.id, su.id, { amountPaid: null });
    su.amountPaid = null;
    $('#pa-amount', ov).value = '';
    toast(t('amountCleared'));
    paintOwed();
    paintStatus();
  });

  $('#pa-in', ov).addEventListener('click', async () => {
    const next = !su.checkedIn;
    await store.updateSignup(ev.id, su.id, { checkedIn: next });
    su.checkedIn = next;
    paintStatus();
  });
  $$('#pa-teams [data-team]', ov).forEach(b => b.addEventListener('click', async () => {
    const n = +b.dataset.team || null;
    await store.updateSignup(ev.id, su.id, { team: n });
    su.team = n;
    $$('#pa-teams [data-team]', ov).forEach(x => {
      x.className = `btn btn-small ${(+x.dataset.team || null) === n ? 'btn-exec' : 'btn-ghost'}`;
    });
  }));
  const paintLevel = () => {
    const now = playerLevel(su);
    $$('#pa-level [data-level]', ov).forEach(b =>
      b.className = 'btn btn-small grow ' + ((Number(b.dataset.level) || null) === now ? 'btn-exec' : 'btn-ghost'));
  };
  $$('#pa-level [data-level]', ov).forEach(b => b.addEventListener('click', async () => {
    await setPlayerLevel({ deviceId: su.deviceId, name: su.name }, Number(b.dataset.level) || null);
    paintLevel();
  }));
  paintLevel();

  const passBtn = $('#pa-pass', ov);
  if (passBtn) passBtn.addEventListener('click', () => {
    openPassModal({ deviceId: su.deviceId, email: su.email, name: su.name, battlePass: playerPass(su) }, (type) => {
      passBtn.className = 'btn btn-small wide ' + (type ? 'btn-exec' : 'btn-ghost');
      passBtn.textContent = type ? t('passSetTo', { type: type.toUpperCase() }) : t('setPass');
    });
  });
  $('#pa-move', ov).addEventListener('change', async e => {
    const select = e.target;
    select.disabled = true;
    if (!await moveSignup(ev, su, select.value)) {
      // Refused — put the menu back where it was rather than leaving it
      // showing a list the player is not on.
      select.value = su.listId;
      select.disabled = false;
      return;
    }
    toast(t('moved', { name: su.name }));
    ov.remove();
  });
  $('#pa-top', ov).addEventListener('click', async () => {
    const first = listEntries(ev.id, su.listId)[0];
    const newOrder = first ? (first.order ?? first.createdAt) - 1000 : Date.now();
    await store.updateSignup(ev.id, su.id, { order: newOrder });
    toast(t('movedTop', { name: su.name }));
    ov.remove();
  });
  $('#pa-remove', ov).addEventListener('click', async () => {
    ov.remove();
    if (await confirmModal(t('removeConfirm', { name: su.name }), t('remove'))) {
      await removeSignup(ev, su, 'exec');
      toast(t('removed', { name: su.name }));
    }
  });
}

function openExecAddModal(ev, listId) {
  const l = listById(ev, listId);
  const ov = openModal(`
    <div class="modal-body">
      <h2>${esc(t('addPlayer').replace('＋ ', ''))}</h2>
      <p class="hint">${esc(SPORTS[l?.sport]?.label || '')} — ${esc(l?.label || '')}</p>
      <div class="stack">
        <input class="input" id="ea-name" placeholder="${esc(t('nameOnly'))}" maxlength="40">
        <input class="input" id="ea-email" type="email" placeholder="${esc(t('emailPh').replace(' *', ''))}" maxlength="80">
        <input class="input" id="ea-insta" placeholder="${esc(t('instaPh'))}" maxlength="40">
        <label class="pay-opt"><input type="checkbox" id="ea-paid"> <span>${esc(t('alreadyPaid'))}</span></label>
      </div>
      <div class="row gap">
        <button class="btn btn-ghost grow" data-close>${esc(t('cancel'))}</button>
        <button class="btn btn-primary grow" id="ea-save">${esc(t('add'))}</button>
      </div>
    </div>`);
  $('#ea-save', ov).addEventListener('click', async () => {
    const name = $('#ea-name', ov).value.trim();
    if (!name) { toast(t('nameReq'), 'err'); return; }
    const email = $('#ea-email', ov).value.trim();
    const who = identityOf({ email, deviceId: 'exec-added', name });
    if (identitiesInSession(ev, l?.sessionId).has(who)
        && !await confirmModal(t('execDupWarn', { name }), t('addAnyway'))) return;
    await store.addSignups(ev.id, [{
      id: uid('su'),
      listId,
      name,
      email,
      phone: '',
      insta: $('#ea-insta', ov).value.trim().replace(/^@/, ''),
      photo: '',
      deviceId: 'exec-added',
      method: 'cash',
      paid: $('#ea-paid', ov).checked,
      checkedIn: false,
      team: null,
      order: Date.now(),
      createdAt: Date.now(),
      addedByExec: true,
    }]);
    ov.remove();
    toast(t('added', { name }));
  });
}

/* ================================================================== */
/* Exec: players directory                                             */
/* ================================================================== */

/*
 * Every registered player (from the registration gate) merged with their
 * game history from the loaded events. People who signed up on someone
 * else's phone or were added by an exec appear too, via their signups.
 */
/*
 * What the club is owed, and who never showed up — across the whole season.
 *
 * Both were invisible before this. Outstanding money was only ever totalled
 * one night at a time, so somebody who plays six Saturdays and pays for none
 * of them appeared as a small number on six separate screens and never as
 * "$48". And a no-show left no mark at all: the removal log catches people
 * who take their name off, but the commoner case — name on the list, never
 * turned up, never paid — was recorded and never read.
 *
 * A no-show only counts against a CONFIRMED spot. Someone who sat on the
 * waitlist and did not play was never given a place to waste.
 */
function seasonLedger() {
  const by = {};
  const person = (key, p) => {
    if (!by[key]) by[key] = {
      key, name: p.name, email: '', deviceId: p.deviceId,
      owed: 0, nights: [], noShows: [], games: 0,
    };
    return by[key];
  };

  for (const ev of state.events) {
    if (!state.signups[ev.id]) continue;      // week not loaded on this device
    const past = isPastEvent(ev);
    const confirmed = confirmedSignupIds(ev);
    for (const p of personTotals(ev)) {
      const rec = person(personKey(p.signups[0]), p);
      if (!rec.email) rec.email = p.signups.find(su => su.email)?.email || '';
      if (past) rec.games++;
      if (!p.paid && p.total > 0) {
        rec.owed += p.total;
        rec.nights.push({ id: ev.id, date: ev.date, amount: p.total, late: p.late, received: p.received });
      }
      // Held a spot on a night that has been and gone, never checked in.
      if (past && p.signups.some(su => confirmed.has(su.id)) && !p.checkedIn) {
        rec.noShows.push({ id: ev.id, date: ev.date, paid: p.paid });
      }
    }
  }
  return Object.values(by)
    .filter(r => r.owed > 0 || r.noShows.length)
    .sort((a, b) => b.owed - a.owed || b.noShows.length - a.noShows.length);
}

/*
 * The money screen: everyone who owes, most first, plus repeat no-shows.
 * The club's founding problem was that nobody could answer "who owes us
 * what" — so that number is the first thing on the page.
 */
/*
 * The whole season in one file. Per-event CSV answers "what happened that
 * night"; this answers "what happened this season", which is the question
 * asked when the club hands over to next year's execs.
 */
function exportSeasonCsv() {
  const covered = {};
  const rows = [['Date', 'Session', 'Sport', 'List', 'Status', 'Name', 'Email', 'Phone',
                 'Instagram', 'Team', 'Payment method', 'Paid', 'Amount received', 'Checked in']];
  const played = state.events.filter(e => signupsLoaded(e.id) && eventSignups(e.id).length)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const ev of played) {
    const cov = coveredSignupIds(ev);
    for (const l of ev.lists || []) {
      const sess = sessionById(ev, l.sessionId);
      const { confirmed, waitlist } = splitByCap(listEntries(ev.id, l.id), l.cap || 0);
      const add = (su, status) => rows.push([ev.date, sess?.label || '', SPORTS[l.sport]?.label || l.sport,
        l.label, status, su.name, su.email || '', su.phone || '', su.insta || '', su.team || '',
        su.method, su.paid ? 'yes' : (cov.has(su.id) ? 'BATTLE PASS' : 'no'),
        su.amountPaid != null ? su.amountPaid : '', su.checkedIn ? 'yes' : 'no']);
      confirmed.forEach(su => add(su, 'confirmed'));
      waitlist.forEach(su => add(su, 'waitlist'));
    }
  }
  // Removals belong in the archive too — they are the proof trail.
  for (const r of state.removals || []) {
    const ev = state.events.find(e => e.id === r.eventId);
    rows.push([ev?.date || '', r.sessionLabel || '', r.sportLabel || '', r.listLabel || '',
      'REMOVED' + (r.flagged ? ' (was checked in)' : ''), r.name, r.email || '', '', '', '',
      '', '', '']);
  }
  const csv = rows.map(x => x.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'crsc-season-' + todayStr() + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  toast(t('seasonExported', { n: played.length }));
}

/*
 * The season ledger totals what has loaded, and past weeks load on demand —
 * so a figure read the instant the app opens could be low. Ask for every
 * past week first and give the snapshots a moment to land.
 */
async function loadWholeSeason() {
  const missing = state.events.filter(e => !signupsLoaded(e.id));
  if (!missing.length) return;
  missing.forEach(e => store.watchEvent(e.id));
  for (let i = 0; i < 20 && state.events.some(e => !signupsLoaded(e.id)); i++) {
    await new Promise(r => setTimeout(r, 150));
  }
}

function openLedgerModal() {
  const rows = seasonLedger();
  const debtors = rows.filter(r => r.owed > 0);
  const total = debtors.reduce((a, r) => a + r.owed, 0);
  const ghosts = rows.filter(r => r.noShows.length >= 2);

  const ov = openModal(`
    <div class="modal-body">
      <h2 class="m0">${esc(t('ledgerTitle'))}</h2>
      <div class="stat-row">
        <div class="stat stat-bad"><strong>${fmtMoney(total)}</strong><span>${esc(t('outstanding'))}</span></div>
        <div class="stat"><strong>${debtors.length}</strong><span>${esc(t('peopleOwing'))}</span></div>
        <div class="stat ${ghosts.length ? 'stat-bad' : ''}"><strong>${ghosts.length}</strong><span>${esc(t('repeatNoShows'))}</span></div>
      </div>
      ${debtors.length ? `
        <h3 class="section-sub">${esc(t('whoOwes', { n: debtors.length }))}</h3>
        <div class="summary-list">
          ${debtors.map(r => `
            <div class="entry">
              <div class="grow entry-name">
                <span>${esc(r.name)}${r.noShows.length ? ` <span class="chip chip-flag">${esc(t('noShowChip', { n: r.noShows.length }))}</span>` : ''}</span>
                <small>
                  ${r.nights.map(n => esc(fmtDate(n.date)) + (n.late ? ' ⚠' : '') + (n.received ? ' (' + fmtMoney(n.received) + ' ' + esc(t('partOf')) + ')' : '')).join(' · ')}
                  ${r.email ? ' · ' + esc(r.email) : ' · ' + esc(t('noEmail'))}
                </small>
              </div>
              <span class="chip chip-unpaid">${fmtMoney(r.owed)}</span>
            </div>`).join('')}
        </div>
        <button class="btn btn-warn wide" id="lg-chase" ${mailerConfigured() ? '' : 'disabled'}>
          ${esc(mailerConfigured() ? t('chaseAll', { n: debtors.filter(r => r.email).length }) : t('mailerOff'))}
        </button>
        <p class="hint">${esc(t('chaseNote'))}</p>`
      : `<p class="hint">${esc(t('nobodyOwes'))}</p>`}
      ${ghosts.length ? `
        <h3 class="section-sub">${esc(t('noShowsTitle', { n: ghosts.length }))}</h3>
        <div class="summary-list">
          ${ghosts.map(r => `
            <div class="entry">
              <div class="grow entry-name">
                <span>${esc(r.name)}</span>
                <small>${r.noShows.map(n => esc(fmtDate(n.date))).join(' · ')}</small>
              </div>
              <span class="chip chip-flag">${esc(t('noShowChip', { n: r.noShows.length }))}</span>
            </div>`).join('')}
        </div>
        <p class="hint">${esc(t('noShowNote'))}</p>` : ''}
      <div class="row gap">
        <button class="btn btn-ghost grow" id="lg-csv">${esc(t('exportLedger'))}</button>
        <button class="btn btn-primary grow" data-close>${esc(t('close'))}</button>
      </div>
    </div>`, { wide: true });

  // One email each, with that person's own total — never a group mail-out
  // that tells everybody what everybody else owes.
  $('#lg-chase', ov)?.addEventListener('click', async () => {
    const targets = debtors.filter(r => r.email);
    if (!targets.length) { toast(t('noEmails'), 'err'); return; }
    if (!await confirmModal(t('chaseConfirm', { n: targets.length, total: fmtMoney(total) }), t('sendThem'))) return;
    let sent = 0;
    for (const r of targets) {
      const lang = 'en';
      try {
        await sendMail({
          to: r.email,
          subject: tLang(lang, 'emailOwedSubject'),
          message: tLang(lang, 'emailOwedBody', {
            name: r.name,
            total: fmtMoney(r.owed),
            nights: r.nights.map(n => '• ' + fmtDateLang(n.date, lang) + ' — ' + fmtMoney(n.amount)).join('\n'),
            email: state.settings.etransferEmail || '',
            club: state.settings.clubFullName || 'CRSC',
          }),
        });
        sent++;
      } catch (err) { console.error('chase email', err); }
    }
    toast(t('chaseSent', { n: sent }));
  });

  $('#lg-csv', ov).addEventListener('click', () => {
    const out = [['Name', 'Email', 'Owes', 'Unpaid nights', 'No-shows', 'No-show dates']];
    for (const r of rows) out.push([r.name, r.email, r.owed,
      r.nights.map(n => n.date).join(' '), r.noShows.length, r.noShows.map(n => n.date).join(' ')]);
    const csv = out.map(x => x.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'crsc-owed.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

function allPlayers() {
  const byId = {};
  for (const p of Object.values(state.players || {})) {
    byId[p.deviceId] = { ...p, games: 0, unpaid: 0 };
  }
  for (const [evId, signups] of Object.entries(state.signups)) {
    const ev = state.events.find(e => e.id === evId);
    if (!ev) continue;
    const covered = coveredSignupIds(ev);
    for (const su of signups) {
      const key = su.deviceId && su.deviceId !== 'exec-added' ? su.deviceId : 'name:' + su.name.toLowerCase();
      if (!byId[key]) byId[key] = { deviceId: key, name: su.name, insta: su.insta, email: su.email || '', phone: su.phone || '', photo: su.photo || '', games: 0, unpaid: 0 };
      byId[key].games++;
      if (!su.paid && !covered.has(su.id)) byId[key].unpaid++;
      if (!byId[key].email && su.email) byId[key].email = su.email;
      if (!byId[key].photo && su.photo) byId[key].photo = su.photo;
    }
  }
  // No-shows and money owed come from the season ledger, so the directory
  // and the money screen can never tell an exec two different stories.
  for (const r of seasonLedger()) {
    const rec = byId[r.deviceId] || Object.values(byId).find(p => p.name === r.name);
    if (rec) { rec.noShows = r.noShows.length; rec.owes = r.owed; }
  }
  // Removal history (the proof trail) follows the player too.
  for (const r of state.removals || []) {
    // A removal with nobody's name on it is not a removal. The log is
    // append-only by design, so a malformed record cannot be tidied away
    // from in here and would otherwise sit in the directory for ever as a
    // nameless player who was taken off a list once.
    if (!(r.name || '').trim()) continue;
    const key = r.deviceId && r.deviceId !== 'exec-added' ? r.deviceId : 'name:' + (r.name || '').toLowerCase();
    if (!byId[key]) byId[key] = { deviceId: key, name: r.name, insta: r.insta || '', email: r.email || '', phone: r.phone || '', photo: '', games: 0, unpaid: 0 };
    byId[key].removals = (byId[key].removals || 0) + 1;
    if (r.flagged) byId[key].flagged = (byId[key].flagged || 0) + 1;
  }
  return Object.values(byId).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

/*
 * Grade a player. From then on they can sign themselves up for this level
 * and anything below it; execs can still place them anywhere by hand, which
 * is how somebody moves up.
 */
async function setPlayerLevel(player, rank) {
  if (playerLevel(player) === (rank || null)) return;
  await store.savePlayer({ deviceId: player.deviceId, name: player.name, level: rank || null });
  const l = rank ? levelByRank(rank) : null;
  logAction('level', l ? t('logLevel', { name: player.name, level: l.label })
                       : t('logLevelCleared', { name: player.name }));
  toast(l ? t('levelSet', { name: player.name, level: l.label }) : t('levelCleared', { name: player.name }));
}

/* Set/clear a player's Battle Pass (execs only; volleyball season pass). */
async function setBattlePass(player, type, lists = null, until = undefined) {
  await store.savePlayer({
    deviceId: player.deviceId,
    name: player.name,
    battlePass: type || null,
    // Clearing the pass clears the standing reservation with it.
    passLists: type ? (lists || passLists(player)) : [],
    // The season it was bought for. A pass with no end date holds spots
    // for ever, which is how a fall pass kept seating people in May.
    ...(until === undefined ? {} : { passUntil: type ? (until || null) : null }),
  });
  logAction('pass', type
    ? t('logPassSet', { name: player.name, type: type.toUpperCase(), until: until || '\u2014' })
    : t('logPassCleared', { name: player.name }));
  toast(type ? t('battlePassSet', { name: player.name, type: type.toUpperCase() }) : t('battlePassRemoved', { name: player.name }));
}

/*
 * Set a player's season pass and the level their seat is held in.
 *
 * The level matters as much as the pass: holding a spot is meaningless until
 * the club knows WHICH list to hold it in, and pass holders are usually
 * regulars in one specific level. A 4h pass can hold a spot in both time
 * slots, which is what it is paying for.
 */
function openPassModal(player, onDone) {
  const ev = state.events.find(e => !isPastEvent(e) && e.status === 'open') || state.events[0];
  const chosen = passLists(state.players[player.deviceId] || player).slice();
  const has = (l) => chosen.some(c => c.sport === l.sport && c.sessionId === l.sessionId && c.label === l.label);
  let type = player.battlePass || null;
  let level = playerLevel(player);
  const rec = playerRecord(player) || {};

  const ov = openModal(`
    <div class="modal-body">
      <h2 class="m0">${esc(player.name)}</h2>
      <label class="field-label">${esc(t('levelLbl'))}</label>
      <div class="row gap wrap" id="pm-level">
        <button class="btn btn-small grow" data-level="">${esc(t('noLevel'))}</button>
        ${LEVELS.map(l => `<button class="btn btn-small grow" data-level="${l.rank}">${esc(l.label)}</button>`).join('')}
      </div>
      <p class="hint">${esc(t('levelModalHint'))}</p>
      <p class="hint">${esc(t('passModalHint'))}</p>
      <label class="field-label">${esc(t('battlePassLbl'))}</label>
      <div class="row gap" id="pm-type">
        <button class="btn btn-small grow" data-type="">${esc(t('noPass'))}</button>
        <button class="btn btn-small grow" data-type="2h">2H · ${fmtMoney(state.settings.passPrice2h)}</button>
        <button class="btn btn-small grow" data-type="4h">4H · ${fmtMoney(state.settings.passPrice4h)}</button>
      </div>
      <div id="pm-seats">
        <label class="field-label">${esc(t('passUntilLbl'))}</label>
        <input class="input" id="pm-until" type="date" value="${esc(rec.passUntil || state.settings.seasonEnd || '')}">
        <p class="hint">${esc(t('passUntilHint'))}</p>
        <label class="field-label">${esc(t('heldSpotLbl'))}</label>
        <div class="pass-lists">
          ${(ev?.sessions || []).filter(sess =>
            (ev.lists || []).some(l => l.sessionId === sess.id && l.sport === PASS_SPORT)).map(sess => `
            <div class="pass-sess">
              <small class="hint">${esc(sess.label)}</small>
              ${(ev.lists || []).filter(l => l.sessionId === sess.id && l.sport === PASS_SPORT).map(l => `
                <label class="pass-opt">
                  <input type="checkbox" data-list="${esc(l.id)}" ${has(l) ? 'checked' : ''}>
                  <span>${esc(SPORTS[l.sport]?.emoji || '')} ${esc(SPORTS[l.sport]?.label || l.sport)} — ${esc(l.label)}</span>
                </label>`).join('')}
            </div>`).join('')}
        </div>
        <p class="hint">${esc(t('heldSpotNote'))}</p>
      </div>
      <div class="row gap">
        <button class="btn btn-ghost grow" data-close>${esc(t('cancel'))}</button>
        <button class="btn btn-primary grow" id="pm-save">${esc(t('save'))}</button>
      </div>
    </div>`, { wide: true });

  function paint() {
    $$('#pm-type [data-type]', ov).forEach(b =>
      b.className = 'btn btn-small grow ' + ((b.dataset.type || null) === type ? 'btn-exec' : 'btn-ghost'));
    $('#pm-seats', ov).hidden = !type;
    $$('#pm-level [data-level]', ov).forEach(b =>
      b.className = 'btn btn-small grow ' + ((Number(b.dataset.level) || null) === level ? 'btn-exec' : 'btn-ghost'));
  }
  $$('#pm-level [data-level]', ov).forEach(b => b.addEventListener('click', () => {
    level = Number(b.dataset.level) || null;
    paint();
  }));
  $$('#pm-type [data-type]', ov).forEach(b => b.addEventListener('click', () => {
    type = b.dataset.type || null;
    paint();
  }));
  paint();

  $('#pm-save', ov).addEventListener('click', async () => {
    const lists = [];
    if (type) {
      for (const cb of $$('[data-list]', ov)) {
        if (!cb.checked) continue;
        const l = (ev.lists || []).find(x => x.id === cb.dataset.list);
        if (l && l.sport === PASS_SPORT) lists.push({ sport: l.sport, sessionId: l.sessionId, label: l.label });
      }
    }
    await setBattlePass(player, type, lists, $('#pm-until', ov)?.value || '');
    await setPlayerLevel(player, level);
    ov.remove();
    if (onDone) onDone(type, level);
  });
}

/*
 * Retire an account.
 *
 * Someone who registers twice on two addresses is two people as far as the
 * app can tell — nothing can merge them automatically, because nothing knows
 * they are the same human. An exec does, so an exec has to be able to say so
 * by deleting the account that should not exist.
 *
 * What goes and what stays:
 *  - The account record goes, with its level and its season pass.
 *  - Their spots on Saturdays still to come go too, held spots included, or
 *    the pass would keep seating a person who no longer exists.
 *  - Saturdays already played keep every row. That history is the club's
 *    record of who was on the court and who owed for it, and deleting an
 *    account is not a reason to lose it.
 */
function upcomingSignupsOf(player) {
  const id = identityOf(player);
  const out = [];
  for (const ev of state.events) {
    if (isPastEvent(ev) || !signupsLoaded(ev.id)) continue;
    for (const su of eventSignups(ev.id)) {
      if (identityOf(su) === id) out.push({ ev, su });
    }
  }
  return out;
}

async function deletePlayerAccount(player) {
  const spots = upcomingSignupsOf(player);
  const isAccount = !!(state.players || {})[player.deviceId];
  const key = !spots.length ? 'deleteAccountAsk'
            : spots.length === 1 ? 'deleteAccountAskSpots' : 'deleteAccountAskSpotsN';
  const ok = await confirmModal(
    t(key, { name: player.name, n: spots.length }), t('deleteAccount'));
  if (!ok) return false;
  try {
    // Spots first: an account with no rows left is tidier to fail on than
    // rows left behind pointing at an account that is gone.
    for (const { ev, su } of spots) await store.deleteSignup(ev.id, su.id);
    if (isAccount) await store.deletePlayer(player.deviceId);
    logAction('account', t('logAccountDeleted', { name: player.name, email: player.email || '\u2014', n: spots.length }));
    toast(t('accountDeleted', { name: player.name }));
    return true;
  } catch (err) {
    console.error('delete account', err);
    toast(t('accountDeleteFailed'), 'err');
    return false;
  }
}

/*
 * The record of what the execs did. Newest first, kept to the last few
 * hundred entries — long enough to answer a question about last Saturday,
 * short enough to stay readable on a phone.
 */
/* Refund requests nobody has dealt with yet. */
function openRefunds() {
  return (state.refunds || []).filter(r => !r.settled)
    .sort((a, b) => (b.askedAt || 0) - (a.askedAt || 0));
}

/*
 * Who is owed money back.
 *
 * Somebody who paid and then cannot come gives up their spot and asks for
 * their money — the spot goes to the waitlist immediately, and the club
 * still owes them. Before this, that promise lived in whichever exec
 * happened to read the message.
 *
 * Marking one settled does not move any money. It records that an exec has
 * dealt with it, which is the whole job: the list exists so nobody is
 * forgotten and nobody is paid twice.
 */
function openRefundsModal() {
  store.watchRefunds();
  return liveModal(ov => {
    const open = openRefunds();
    const done = (state.refunds || []).filter(r => r.settled)
      .sort((a, b) => (b.settledAt || 0) - (a.settledAt || 0)).slice(0, 20);
    const owed = open.reduce((a, r) => a + (parseFloat(r.amount) || 0), 0);
    ov.querySelector('.modal').innerHTML = `
      <div class="modal-body">
        <h2 class="m0">${esc(t('refundsTitle'))}</h2>
        <p class="hint">${esc(t('refundsHint'))}</p>
        ${open.length ? `
          <div class="stat-row">
            <div class="stat"><strong>${open.length}</strong><span>${esc(t('refundsWaiting'))}</span></div>
            <div class="stat stat-bad"><strong>${fmtMoney(owed)}</strong><span>${esc(t('refundsOwed'))}</span></div>
          </div>
          <div class="summary-list">
            ${open.map(r => `
              <div class="entry">
                <div class="grow entry-name">
                  <span>${esc(r.name)}</span>
                  <small>${esc(fmtDateShort(r.date))} \u00b7 ${esc(r.sportLabel)} ${esc(r.listLabel)}${
                    r.sessionLabel ? ' \u00b7 ' + esc(r.sessionLabel) : ''}${
                    r.email ? ' \u00b7 ' + esc(r.email) : ''}</small>
                </div>
                <span class="chip chip-unpaid">${fmtMoney(r.amount || 0)}</span>
                <button class="btn btn-small btn-success" data-settle="${esc(r.id)}">${esc(t('refundsDone'))}</button>
              </div>`).join('')}
          </div>` : `<p class="hint">${esc(t('refundsNone'))}</p>`}
        ${done.length ? `
          <h3 class="section-sub">${esc(t('refundsPaidBack', { n: done.length }))}</h3>
          <div class="summary-list">
            ${done.map(r => `
              <div class="entry">
                <div class="grow entry-name">
                  <span>${esc(r.name)}</span>
                  <small>${esc(fmtDateShort(r.date))} \u00b7 ${esc(t('refundsSettledBy', {
                    name: r.settledBy || t('logByUnknown'), when: fmtStamp(r.settledAt),
                  }))}</small>
                </div>
                <span class="chip chip-paid">${fmtMoney(r.amount || 0)} \u2713</span>
              </div>`).join('')}
          </div>` : ''}
        <button class="btn btn-primary wide" data-close>${esc(t('close'))}</button>
      </div>`;
    $$('[data-close]', ov).forEach(b => b.addEventListener('click', () => ov.remove()));
    $$('[data-settle]', ov).forEach(b => b.addEventListener('click', async () => {
      const r = (state.refunds || []).find(x => x.id === b.dataset.settle);
      if (!r) return;
      if (!await confirmModal(t('refundsDoneAsk', { name: r.name, amount: fmtMoney(r.amount || 0) }), t('refundsDone'))) return;
      await store.updateRefund(r.id, {
        settled: true, settledAt: Date.now(), settledBy: getProfile()?.name || '',
      });
      logAction('refund', t('logRefund', { name: r.name, amount: fmtMoney(r.amount || 0), date: fmtDateShort(r.date) }));
      toast(t('refundsDoneToast', { name: r.name }));
    }));
  }, { wide: true });
}

function openLogModal() {
  store.watchLog();
  const rows = [...(state.log || [])].sort((a, b) => (b.at || 0) - (a.at || 0));
  const icon = { paid: '$', amount: '$', pass: 'P', level: 'L', account: 'X' };
  const ov = openModal(`
    <div class="modal-body">
      <h2 class="m0">${esc(t('logTitle'))}</h2>
      <p class="hint">${esc(t('logHint'))}</p>
      <input class="input" id="lg-q" placeholder="${esc(t('searchPh'))}" autocomplete="off">
      <div class="summary-list" id="lg-list"></div>
      <button class="btn btn-primary wide" data-close>${esc(t('close'))}</button>
    </div>`, { wide: true });

  function paint() {
    const q = $('#lg-q', ov).value.trim().toLowerCase();
    const shown = rows.filter(r => !q || matchesQuery([r.what, r.by, r.kind], q));
    $('#lg-list', ov).innerHTML = shown.length ? shown.map(r => `
      <div class="entry log-row">
        <span class="chip chip-muted log-kind">${esc(icon[r.kind] || '\u00b7')}</span>
        <div class="grow entry-name">
          <span>${esc(r.what || '')}</span>
          <small>${esc(fmtStamp(r.at))}${r.by ? ' \u00b7 ' + esc(t('logBy', { name: r.by })) : ' \u00b7 ' + esc(t('logByUnknown'))}</small>
        </div>
      </div>`).join('') : `<p class="hint">${esc(rows.length ? t('noMatches') : t('logEmpty'))}</p>`;
  }
  $('#lg-q', ov).addEventListener('input', paint);
  paint();
}

function openPlayersModal() {
  const ov = openModal(`
    <div class="modal-body">
      <h2 id="pl-title"></h2>
      <input class="input" id="pl-search" placeholder="${esc(t('searchPh'))}">
      <div class="summary-list players-list" id="pl-list"></div>
      <div class="row gap">
        <button class="btn btn-ghost grow" id="pl-csv">${esc(t('exportPlayers'))}</button>
        <button class="btn btn-primary grow" data-close>${esc(t('close'))}</button>
      </div>
    </div>`, { wide: true });

  function renderList() {
    const q = $('#pl-search', ov).value.trim().toLowerCase();
    const players = allPlayers().filter(p => matchesQuery([p.name, p.insta, p.email, p.phone], q));
    $('#pl-title', ov).textContent = t('playersTitle', { n: players.length });
    $('#pl-list', ov).innerHTML = players.map((p, i) => `
      <div class="entry player-row">
        ${avatarHtml(p, 'avatar-sm')}
        <div class="grow entry-name">
          <span>${esc(p.name)}</span>
          <small>
            ${p.insta ? '@' + esc(p.insta) + ' · ' : ''}${esc(p.email || '')}${p.phone ? ' · ' + esc(p.phone) : ''}
          </small>
        </div>
        ${levelChipHtml(p)}
        ${p.noShows >= 2 ? `<span class="chip chip-flag">${esc(t('noShowChip', { n: p.noShows }))}</span>` : ''}
        ${p.flagged ? `<span class="chip chip-flag">${esc(t('flaggedRemovals', { n: p.flagged }))}</span>` : (p.removals ? `<span class="chip chip-muted">${esc(t('removalsCount', { n: p.removals }))}</span>` : '')}
        ${p.owes ? `<span class="chip chip-unpaid">${esc(t('owesAmount', { amount: fmtMoney(p.owes) }))}</span>`
          : p.unpaid ? `<span class="chip chip-unpaid">${esc(t('unpaidCount', { n: p.unpaid }))}</span>`
          : `<span class="chip ${p.games ? 'chip-mine' : 'chip-muted'}">${esc(p.games ? t('gamesPlayed', { n: p.games }) : t('neverPlayed'))}</span>`}
        ${p.deviceId.startsWith('name:')
          ? (p.battlePass ? `<span class="chip chip-pass">${esc(p.battlePass.toUpperCase())}</span>` : '')
          : `<button class="btn btn-tiny ${p.battlePass ? 'btn-exec' : 'btn-ghost'}" data-pass="${i}" title="${esc(t('battlePassLbl'))}">${esc(p.battlePass ? 'PASS ' + p.battlePass.toUpperCase() : 'PASS')}</button>`}
        <button class="btn btn-tiny btn-danger-ghost" data-del="${i}" title="${esc(t('deleteAccount'))}" aria-label="${esc(t('deleteAccount'))}">✕</button>
      </div>`).join('') || `<p class="hint">${esc(t('noMatches'))}</p>`;
    // Tap PASS to set the pass and the level the player's spot is held in.
    $$('[data-pass]', ov).forEach(b => b.addEventListener('click', () => {
      const p = players[+b.dataset.pass];
      openPassModal(p, (type) => { p.battlePass = type; renderList(); });
    }));
    $$('[data-del]', ov).forEach(b => b.addEventListener('click', async () => {
      if (b.disabled) return;
      b.disabled = true;
      if (await deletePlayerAccount(players[+b.dataset.del])) renderList();
      else b.disabled = false;
    }));
  }
  $('#pl-search', ov).addEventListener('input', renderList);
  $('#pl-csv', ov).addEventListener('click', () => {
    const rows = [['Name', 'Email', 'Phone', 'Instagram', 'Games', 'Unpaid signups', 'Removals', 'Played then removed']];
    for (const p of allPlayers()) rows.push([p.name, p.email || '', p.phone || '', p.insta || '', p.games, p.unpaid, p.removals || 0, p.flagged || 0]);
    const csv = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'crsc-players.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  renderList();
}

/*
 * Find one person on a night with nine lists and a couple of hundred names.
 *
 * Scrolling for a name at the door is the single most common thing an exec
 * does, so this searches every list at once and opens the same row controls
 * — paid, checked in, team, move, remove — straight from the result.
 */
/* Accent- and case-blind "does this record contain what they typed". */
function matchesQuery(fields, q) {
  const needle = normalize(q);
  if (!needle) return true;
  return fields.some(v => normalize(v).includes(needle));
}

function openFindModal(ev) {
  const covered = coveredSignupIds(ev);
  const ov = openModal(`
    <div class="modal-body">
      <h2 class="m0">${esc(t('findTitle'))}</h2>
      <input class="input" id="fp-q" placeholder="${esc(t('findPh'))}" autocomplete="off">
      <div class="summary-list" id="fp-list"></div>
      <button class="btn btn-ghost wide" data-close>${esc(t('close'))}</button>
    </div>`, { wide: true });

  function paint() {
    const q = $('#fp-q', ov).value.trim().toLowerCase();
    const rows = !q ? [] : eventSignups(ev.id).filter(su =>
      matchesQuery([su.name, su.insta, su.email, su.phone], q));
    $('#fp-list', ov).innerHTML = !q
      ? `<p class="hint">${esc(t('findEmpty'))}</p>`
      : (rows.map(su => {
          const l = listById(ev, su.listId);
          const sess = l ? sessionById(ev, l.sessionId) : null;
          const entries = listEntries(ev.id, su.listId);
          const pos = entries.findIndex(e => e.id === su.id);
          const waiting = pos >= (l?.cap || 0);
          const paid = su.paid || covered.has(su.id);
          return `
          <div class="entry find-row" data-find="${esc(su.id)}">
            ${avatarHtml(su, 'avatar-sm')}
            <div class="grow entry-name">
              <span>${esc(su.name)}</span>
              <small>
                ${esc(SPORTS[l?.sport]?.label || '')} ${esc(l?.label || '?')}${sess ? ' · ' + esc(sess.label) : ''}
                · ${esc(waiting ? t('onWaitlist', { n: pos - (l?.cap || 0) + 1 }) : t('confirmedSpot'))}
                ${su.email ? ' · ' + esc(su.email) : ''}${su.phone ? ' · ' + esc(su.phone) : ''}
              </small>
            </div>
            ${levelChipHtml(su)}
            ${su.viaPass ? `<span class="chip chip-pass-off">${esc(t('heldChip'))}</span>` : ''}
            <span class="chip ${paid ? 'chip-paid' : 'chip-unpaid'}">${esc(paid ? t('paidChip') : t('unpaidChip'))}</span>
            <span class="chip ${su.checkedIn ? 'chip-in-ok' : 'chip-muted'}">${esc(su.checkedIn ? t('inChip') : t('outChip'))}</span>
          </div>`;
        }).join('') || `<p class="hint">${esc(t('noMatches'))}</p>`);
    $$('[data-find]', ov).forEach(row => row.addEventListener('click', () => {
      const su = eventSignups(ev.id).find(x => x.id === row.dataset.find);
      if (su) { ov.remove(); openPlayerAdminModal(ev, su); }
    }));
  }
  $('#fp-q', ov).addEventListener('input', paint);
  paint();
  $('#fp-q', ov).focus();
}

/* ================================================================== */
/* Automatic e-transfer matching                                       */
/* ================================================================== */

/*
 * Which weeks a received transfer could be paying for. Money shows up late
 * (someone sends it Sunday morning) and early (the pass-holder who pays on
 * sight), so the search reaches either side of today rather than assuming
 * the transfer belongs to tonight's game.
 */
function matchableEvents() {
  const day = 86400000;
  const now = Date.now();
  return state.events.filter(ev => {
    if (!ev.date || ev.status !== 'open') return false;
    const at = new Date(ev.date + 'T12:00:00').getTime();
    return at > now - 30 * day && at < now + 14 * day;
  });
}

function unpaidFor(ev) {
  return personTotals(ev).filter(p => !p.paid && p.total > 0);
}

/*
 * Publish what each person still owes, for the Gmail matcher to settle
 * against while nobody has the app open.
 *
 * Pricing is genuinely intricate — season passes, both-slot bundles, late
 * fees, someone who paid for volleyball and also played basketball — and it
 * lives here, in one place. Rather than reimplement any of that inside a
 * Google Apps Script (where it would drift out of sync the first time a
 * price changed), the app publishes the ANSWER: a plain list of who owes
 * what. The matcher only has to read names and add up numbers.
 *
 * Republished whenever the night changes, which is exactly when someone is
 * looking at it: signing up, being marked paid, gaining a pass, being
 * removed. A player signing up at 2 AM refreshes it by that very act.
 */
async function publishDues(ev) {
  if (store.mode === 'demo' || !ev || ev.status !== 'open') return;
  const people = personTotals(ev)
    .filter(p => !p.paid && p.total > 0)
    .map(p => ({
      name: p.name,
      owed: p.total,
      ids: p.signups.map(su => su.id),
      email: p.signups.find(su => su.email)?.email || '',
      lang: p.signups[0]?.lang === 'fr' ? 'fr' : 'en',
    }));
  try {
    await store.saveDues(ev.id, {
      date: ev.date, updatedAt: Date.now(), people,
      // The Gmail script sends the reminders now, and a reminder that does
      // not say where the gym is has wasted its one chance.
      location: ev.location || state.settings.location || '',
    });
  } catch (err) { console.error('publish dues', err); }
}

/* Keep every open night's dues current, debounced so a burst of changes
 * publishes once. */
let duesTimer = null;
function scheduleDues() {
  clearTimeout(duesTimer);
  duesTimer = setTimeout(() => {
    // Exactly the nights the matcher considers — no wider, so nothing is
    // published that will not be kept current, and no narrower, so a stale
    // total can never out-live the payment that settled it. Someone paying
    // last week's game late (the club allows it until Tuesday) still settles.
    for (const ev of matchableEvents()) {
      if (!isScheduled(ev)) publishDues(ev);
    }
  }, 2000);
}

/*
 * Mark people paid for the transfers that speak for themselves.
 *
 * Runs on any exec's device whenever the data changes — the Gmail script
 * writes a payment row, every open app sees it within seconds. Two execs
 * doing this at once write the same answer, so no coordination is needed.
 *
 * A transfer is only applied when exactly one week reconciles: a $20 sender
 * who owes $20 this Saturday AND $20 last Saturday is a question for a human,
 * not a coin flip.
 */
async function runAutoMatch() {
  if (!isExec()) return;
  // `noAuto` is an exec having undone this one by hand. The matcher does not
  // get to argue: a transfer a human took back stays back, and waits for them
  // on the review list instead.
  const pending = (state.payments || []).filter(p => !p.matched && !p.noAuto);
  if (!pending.length) return;
  const events = matchableEvents();
  if (!events.length) return;

  for (const pay of pending) {
    // A test transfer proves the plumbing and nothing else: it is shown on
    // the Payments screen with everything the club parsed out of it, and no
    // player is touched.
    if (isTestTransfer(pay, state.settings)) continue;

    // Season passes are bought outright, often weeks before the player signs
    // up for anything, so they are matched against the whole player registry
    // rather than one night's unpaid list.
    const pass = passPurchase(pay, state.settings);
    if (pass) {
      const who = nameHits((pay.sender || '') + ' ' + (pay.message || ''), allPlayers());
      const top = who.length === 1 ? who[0].person : null;
      if (top && !top.deviceId.startsWith('name:')) {
        await setBattlePass(top, pass, passLists(state.players[top.deviceId]),
                            state.settings.seasonEnd || '');
        await store.updatePayment(pay.id, {
          matched: true, matchedTo: top.name, auto: true,
          matchedAt: Date.now(), kind: 'pass',
        });
        await notifyPassActivated(top, pass, pay.amount || 0);
        toast(t('passAutoToast', { name: top.name, type: pass.toUpperCase() }));
      }
      continue;   // never spend a pass payment on a single night's game fee
    }

    const hits = [];
    for (const ev of events) {
      const res = resolvePayment(pay, unpaidFor(ev));
      if (res.status === 'matched') hits.push({ ev, people: res.people, exact: true });
      // One person, an amount that is not what they owe: worth recording
      // rather than leaving on a review list. See resolvePayment.
      else if (res.status === 'partial') hits.push({ ev, people: res.people, exact: false });
    }
    if (hits.length !== 1) continue;   // nothing certain, or certain twice over
    const { ev, people, exact } = hits[0];
    const names = people.map(p => p.name).join(', ');
    if (exact) {
      await Promise.all(people.flatMap(p => p.signups.map(su =>
        store.updateSignup(ev.id, su.id, { paid: true, paidAt: Date.now(), paidVia: 'auto' }))));
    } else {
      // The whole amount on one row: a person's payments are summed across
      // their spots, so the screen shows settled or short by the difference.
      const su = people[0].signups?.[0];
      if (su) {
        await store.updateSignup(ev.id, su.id, {
          amountPaid: round2(pay.amount || 0), paidAt: Date.now(), paidVia: 'auto',
        });
      }
    }
    await store.updatePayment(pay.id, {
      matched: true, matchedTo: names, matchedEvent: ev.id,
      auto: true, matchedAt: Date.now(), kind: exact ? 'full' : 'partial',
    });
    if (exact) await notifyPaymentReceived(ev, people, pay);
    toast(t(exact ? 'autoMatchedToast' : 'autoPartialToast',
            { names, amount: fmtMoney(pay.amount || 0) }));
  }
}

/* ================================================================== */
/* Exec: payments summary + CSV                                        */
/* ================================================================== */

/* Best guess for which unpaid player a transfer the matcher left behind is
 * for — the same name reading as the automatic pass, minus the certainty. */
function suggestMatch(pay, unpaid) {
  const hits = nameHits((pay.sender || '') + ' ' + (pay.message || ''), unpaid);
  let best = null; let bestScore = 0;
  for (const h of hits) if (h.score > bestScore) { best = h.person; bestScore = h.score; }
  return best;
}

function openSummaryModal(ev) {
  // Rebuilt from scratch on every change, so two execs on the door are
  // never looking at two different answers.
  return liveModal(ov => paintSummary(ov, ev), { wide: true });
}

function paintSummary(ov, ev) {
  const people = personTotals(ev);
  const paid = people.filter(p => p.paid);
  const unpaid = people.filter(p => !p.paid);
  const collected = people.reduce((a, p) => a + (p.paidAmount || 0), 0);
  const outstanding = unpaid.reduce((a, p) => a + p.total, 0);
  const pays = (state.payments || []).filter(p => !p.matched && !isTestTransfer(p, state.settings));
  ov.querySelector('.modal').innerHTML = `
    <div class="modal-body">
      <h2>${esc(t('paymentsTitle', { date: fmtDate(ev.date) }))}</h2>
      <div class="stat-row">
        <div class="stat"><strong>${people.length}</strong><span>${esc(t('players'))}</span></div>
        <div class="stat stat-good"><strong>${fmtMoney(collected)}</strong><span>${esc(t('collected'))}</span></div>
        <div class="stat stat-bad"><strong>${fmtMoney(outstanding)}</strong><span>${esc(t('outstanding'))}</span></div>
      </div>
      ${pays.length ? `
        <h3 class="section-sub">${esc(t('moneyReceived'))}</h3>
        <div class="summary-list">
          ${pays.map(pay => {
            const sug = suggestMatch(pay, unpaid);
            return `
            <div class="pay-match" data-pay="${esc(pay.id)}">
              <div class="row gap center">
                <strong class="grow">${esc(pay.sender || '?')}</strong>
                <span class="pay-amt">${fmtMoney(pay.amount || 0)}</span>
              </div>
              ${pay.message ? `<p class="pay-note">${esc(t('transferNote', { note: pay.message }))}</p>` : ''}
              <div class="row gap">
                ${unpaid.length ? `
                  <select class="input grow" data-match-sel>
                    ${unpaid.map((u, i) => `<option value="${i}" ${sug && sug.name === u.name ? 'selected' : ''}>${esc(u.name)}${u.signups?.[0]?.email ? ' · ' + esc(u.signups[0].email) : ''} (${fmtMoney(u.total)})</option>`).join('')}
                  </select>
                  <button class="btn btn-small btn-success" data-match-go>✓</button>` : `<span class="hint grow">${esc(t('noUnpaidHere'))}</span>`}
                <button class="btn btn-small btn-ghost" data-match-x title="${esc(t('dismiss'))}">✕</button>
              </div>
            </div>`;
          }).join('')}
        </div>` : ''}
      ${(() => {
        const tests = (state.payments || []).filter(p => !p.matched && isTestTransfer(p, state.settings));
        if (!tests.length) return '';
        return `
        <h3 class="section-sub">${esc(t('testTitle'))}</h3>
        <div class="summary-list">
          ${tests.map(p => `
            <div class="entry" data-test="${esc(p.id)}">
              <div class="grow entry-name">
                <span>${esc(t('testOk'))}</span>
                <small>${esc(t('testFrom', { sender: p.sender || '?', amount: fmtMoney(p.amount || 0) }))}${p.message ? ' · ' + esc(t('transferNote', { note: p.message })) : ''}</small>
              </div>
              <button class="btn btn-small btn-ghost" data-test-x>\u2715</button>
            </div>`).join('')}
        </div>
        <p class="hint">${esc(t('testNote', { amount: fmtMoney(state.settings.testAmount) }))}</p>`;
      })()}
      ${(() => {
        const autos = (state.payments || [])
          .filter(p => p.auto && p.matchedEvent === ev.id)
          .sort((a, b) => (b.matchedAt || 0) - (a.matchedAt || 0));
        if (!autos.length) return '';
        return `
        <h3 class="section-sub">${esc(t('autoMatchedTitle', { n: autos.length }))}</h3>
        <div class="summary-list">
          ${autos.map(p => `
            <div class="entry" data-auto="${esc(p.id)}">
              <div class="grow entry-name">
                <span>${esc(p.matchedTo || '')}</span>
                <small>${esc(t('autoFrom', { sender: p.sender || '?' }))}${p.message ? ' · ' + esc(p.message) : ''}</small>
              </div>
              <span class="chip chip-paid">${fmtMoney(p.amount || 0)} \u2713</span>
              <button class="btn btn-small btn-ghost" data-auto-undo title="${esc(t('undo'))}">\u21ba</button>
            </div>`).join('')}
        </div>
        <p class="hint">${esc(t('autoMatchNote'))}</p>`;
      })()}
      ${unpaid.length ? `
        <h3 class="section-sub">${esc(t('notPaidYet', { n: unpaid.length }))}</h3>
        <div class="summary-list">
          ${unpaid.map(p => `<div class="entry"><span class="grow">${esc(p.name)}${p.insta ? ` <small>@${esc(p.insta)}</small>` : ''}${p.late ? ` <small>(${esc(t('lateFee'))})</small>` : ''}</span>${p.pass ? `<span class="chip chip-pass-off">${esc(String(p.pass).toUpperCase())}</span>` : ''}<span class="chip chip-unpaid">${esc(p.method === 'cash' ? t('cash') : t('etransfer'))} ${fmtMoney(p.total)}</span></div>`).join('')}
        </div>` : `<p class="hint">${esc(t('everyonePaid'))}</p>`}
      ${(() => {
        const rms = (state.removals || []).filter(r => r.eventId === ev.id)
          .sort((a, b) => (b.removedAt || 0) - (a.removedAt || 0));
        if (!rms.length) return '';
        return `
        <h3 class="section-sub">${esc(t('removalsTitle', { n: rms.length }))}</h3>
        <div class="summary-list">
          ${rms.map(r => `
            <div class="entry removal-row ${r.flagged ? 'removal-flagged' : ''}">
              <div class="grow entry-name">
                <span>${esc(r.name)}${r.flagged ? ` <span class="chip chip-flag">${esc(r.wasCheckedIn ? t('wasCheckedIn') : t('removedAfterStart'))}</span>` : ''}</span>
                <small>
                  ${esc(r.sportLabel)} ${esc(r.listLabel)}${r.sessionLabel ? ' · ' + esc(r.sessionLabel) : ''}
                  · ${esc(fmtStamp(r.removedAt))} · ${esc(r.by === 'exec' ? t('removedByExec') : t('removedBySelf'))}
                  ${r.email ? ' · ' + esc(r.email) : ''}
                </small>
              </div>
              ${r.flagged && r.amountOwed ? `<span class="chip chip-unpaid">${esc(t('stillOwes', { amount: fmtMoney(r.amountOwed) }))}</span>` : ''}
            </div>`).join('')}
        </div>
        <p class="hint">${esc(t('removalNote'))}</p>`;
      })()}
      ${paid.length ? `
        <h3 class="section-sub">${esc(t('paidList', { n: paid.length }))}</h3>
        <div class="summary-list">
          ${paid.map(p => `<div class="entry"><span class="grow">${esc(p.name)}</span>${p.pass && !p.paidAmount ? passChipHtml(p.pass) : `<span class="chip chip-paid">${fmtMoney(p.paidAmount || 0)} ✓</span>`}</div>`).join('')}
        </div>` : ''}
      <button class="btn btn-primary wide" data-close>${esc(t('close'))}</button>
    </div>`;
  $$('[data-close]', ov).forEach(b => b.addEventListener('click', () => ov.remove()));

  $$('.pay-match', ov).forEach(row => {
    const pay = pays.find(p => p.id === row.dataset.pay);
    const go = $('[data-match-go]', row);
    if (go) go.addEventListener('click', async () => {
      // Picked by position, not by name: two members share a name often
      // enough that settling by name could quietly pay off the wrong one.
      const person = unpaid[+$('[data-match-sel]', row).value];
      if (!person) return;
      const name = person.name;
      await Promise.all(person.signups.map(su => store.updateSignup(ev.id, su.id, { paid: true, paidAt: Date.now() })));
      await store.updatePayment(pay.id, { matched: true, matchedTo: name, matchedEvent: ev.id });
      logAction('paid', t('logMatched', {
        name, amount: fmtMoney(pay.amount || 0),
        email: person.signups?.[0]?.email || '\u2014', date: fmtDateShort(ev.date),
      }));
      await notifyPaymentReceived(ev, [person], pay);
      toast(t('matchedToast', { name, amount: fmtMoney(pay.amount || 0) }));
    });
    $('[data-match-x]', row).addEventListener('click', async () => {
      await store.updatePayment(pay.id, { matched: true, matchedTo: '' });
      toast(t('dismissedToast'));
      row.remove();
    });
  });

  $$('[data-test]', ov).forEach(row => {
    $('[data-test-x]', row).addEventListener('click', async () => {
      await store.updatePayment(row.dataset.test, { matched: true, matchedTo: '', kind: 'test' });
      row.remove();
    });
  });

  // Undo an automatic match: the transfer goes back to the review list above
  // and only the spots the matcher marked are cleared, never a cash payment
  // or a tick an exec made by hand.
  $$('[data-auto]', ov).forEach(row => {
    const pay = (state.payments || []).find(p => p.id === row.dataset.auto);
    $('[data-auto-undo]', row).addEventListener('click', async () => {
      const names = (pay.matchedTo || '').split(',').map(n => n.trim()).filter(Boolean);
      const targets = people.filter(p => names.includes(p.name));
      await Promise.all(targets.flatMap(p => p.signups
        .filter(su => su.paidVia === 'auto')
        .map(su => store.updateSignup(ev.id, su.id,
          pay.kind === 'partial' ? { amountPaid: null, paidVia: '' } : { paid: false, paidVia: '' }))));
      await store.updatePayment(pay.id, { matched: false, matchedTo: '', auto: false, noAuto: true });
      toast(t('autoUndone', { names: pay.matchedTo || '' }), 'warn');
    });
  });
}

function exportCsv(ev) {
  const covered = coveredSignupIds(ev);
  const rows = [['Name', 'Email', 'Phone', 'Instagram', 'Session', 'List', 'Sport', 'Team', 'Status', 'Payment method', 'Paid', 'Checked in']];
  for (const l of ev.lists || []) {
    const sess = sessionById(ev, l.sessionId);
    const entries = listEntries(ev.id, l.id);
    const { confirmed, waitlist } = splitByCap(entries, l.cap || 0);
    const row = (su, status) => [su.name, su.email || '', su.phone || '', su.insta, sess?.label || '', l.label, SPORTS[l.sport]?.label || l.sport, su.team || '', status, su.method, su.paid ? 'yes' : (covered.has(su.id) ? 'BATTLE PASS' : 'NO'), su.checkedIn ? 'yes' : ''];
    for (const su of confirmed) rows.push(row(su, 'confirmed'));
    for (const su of waitlist) rows.push(row(su, 'waitlist'));
  }
  // Removed names stay in the export as the proof trail.
  for (const r of (state.removals || []).filter(x => x.eventId === ev.id)) {
    rows.push([r.name, r.email || '', r.phone || '', r.insta || '', r.sessionLabel || '', r.listLabel || '', r.sportLabel || '', '',
      `REMOVED ${r.by === 'exec' ? 'by exec' : 'by player'} ${fmtStamp(r.removedAt)}${r.flagged ? ' — PLAYED, OWES ' + fmtMoney(r.amountOwed) : ''}`,
      '', r.wasPaid ? 'yes' : 'NO', r.wasCheckedIn ? 'yes' : '']);
  }
  const csv = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `crsc-${ev.date || 'event'}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ================================================================== */
/* Exec: event editor                                                  */
/* ================================================================== */

function sportOptions(sel) {
  return Object.entries(SPORTS).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v.label}</option>`).join('');
}

/*
 * Push one Saturday's lists onto every Saturday still to come.
 *
 * Thirty-two Saturdays run on the same shape, so changing a cap or a price
 * or a grade meant opening thirty-two editors, or not bothering — which is
 * how a season drifts apart from the one before it.
 *
 * Matched by slot, sport and label, and the matching list keeps its own id:
 * sign-ups point at those ids, and replacing one would orphan everybody on
 * it. A list on a later Saturday that this one does not have is removed
 * only when nobody has signed up for it; otherwise it stays and is
 * reported, because quietly deleting somebody's spot is worse than leaving
 * one list out of step.
 */
async function applyListsToSeason(src) {
  const targets = state.events.filter(e =>
    e.id !== src.id && !isPastEvent(e) && e.date > src.date);
  if (!targets.length) { toast(t('nothingLater'), 'warn'); return; }
  if (!await confirmModal(
    t('applySeasonConfirm', { n: targets.length, date: fmtDate(src.date) }), t('applySeason'))) return;

  const key = l => `${l.sessionId}|${l.sport}|${(l.label || '').trim().toLowerCase()}`;
  let kept = 0;
  for (const ev of targets) {
    const have = {};
    for (const l of ev.lists || []) have[key(l)] = l;
    const lists = [];
    for (const tpl of src.lists) {
      const mine = have[key(tpl)];
      if (mine) {
        // Same list, new numbers. The id stays, so nobody loses their spot.
        lists.push({ ...mine, cap: tpl.cap, priceE: tpl.priceE, priceC: tpl.priceC,
                     level: tpl.level ?? 0, teamCount: tpl.teamCount || 0 });
        delete have[key(tpl)];
      } else {
        lists.push({ ...tpl, id: uid('l') });
      }
    }
    // Anything left over is a list this Saturday has and the template does
    // not. Empty ones go; ones with names on them stay.
    for (const leftover of Object.values(have)) {
      if (listEntries(ev.id, leftover.id).length) { lists.push(leftover); kept++; }
    }
    await store.saveEvent({ ...ev, lists,
      sessions: JSON.parse(JSON.stringify(src.sessions || ev.sessions)),
      bundles: JSON.parse(JSON.stringify(src.bundles || [])) });
  }
  toast(t('appliedSeason', { n: targets.length }));
  if (kept) toast(t('appliedKept', { n: kept }), 'warn');
}

/* Copy a Saturday onto another date — a one-off extra session, or a week
 * that needs a different shape, without rebuilding it by hand. */
function askForDate(title, initial) {
  return new Promise(resolve => {
    const ov = openModal(`
      <div class="modal-body">
        <h2 class="m0">${esc(title)}</h2>
        <input class="input" id="ad-date" type="date" value="${esc(initial)}">
        <div class="row gap">
          <button class="btn btn-ghost grow" data-close>${esc(t('cancel'))}</button>
          <button class="btn btn-primary grow" id="ad-go">${esc(t('ok'))}</button>
        </div>
      </div>`);
    $('#ad-go', ov).addEventListener('click', () => {
      const v = $('#ad-date', ov).value;
      ov.remove();
      resolve(v || null);
    });
    ov.addEventListener('click', e => { if (e.target === ov) resolve(null); });
    $$('[data-close]', ov).forEach(b => b.addEventListener('click', () => resolve(null)));
  });
}

async function duplicateEvent(src) {
  const next = new Date(src.date + 'T12:00:00');
  next.setDate(next.getDate() + 7);
  const date = await askForDate(t('duplicateAsk'), localISO(next));
  if (!date) return;
  if (state.events.some(e => e.date === date)) { toast(t('dateTaken', { date: fmtDate(date) }), 'err'); return; }
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid('ev');
  copy.date = date;
  copy.status = 'open';
  copy.openEarly = false;
  copy.createdAt = Date.now();
  copy.lists = copy.lists.map(l => ({ ...l, id: uid('l') }));
  await store.saveEvent(copy);
  toast(t('duplicated', { date: fmtDate(date) }));
  location.hash = '#/event/' + copy.id;
}

function openEventEditor(ev, { isNew = false } = {}) {
  const creating = !ev || isNew;
  const draft = ev ? JSON.parse(JSON.stringify(ev)) : makeTemplateEvent(nextSaturday(), 'Saturday Drop-in');
  if (!ev) draft.lists = draft.lists || [];

  const ov = openModal(`
    <div class="modal-body">
      <h2>${esc(creating ? t('newEventTitle') : t('editEventTitle'))}</h2>
      <div class="stack">
        <label class="field-label">${esc(t('title'))}</label>
        <input class="input" id="ee-title" value="${esc(draft.title || '')}" maxlength="60">
        <label class="field-label">${esc(t('date'))}</label>
        <input class="input" id="ee-date" type="date" value="${esc(draft.date || '')}">
        <label class="field-label">${esc(t('location'))}</label>
        <input class="input" id="ee-location" value="${esc(draft.location || state.settings.location || '')}" maxlength="120">
        <div class="row gap">
          <div class="grow stack">
            <label class="field-label">${esc(t('slot1'))}</label>
            <input class="input" id="ee-s1" value="${esc(draft.sessions?.[0]?.label || '5:30 – 7:30 PM')}">
          </div>
          <div class="grow stack">
            <label class="field-label">${esc(t('slot2'))}</label>
            <input class="input" id="ee-s2" value="${esc(draft.sessions?.[1]?.label || '7:30 – 9:30 PM')}">
          </div>
        </div>
      </div>
      <h3 class="section-sub">${esc(t('lists'))}</h3>
      <div id="ee-lists"></div>
      <button class="btn btn-ghost wide" id="ee-addlist">${esc(t('addList'))}</button>
      <h3 class="section-sub">${esc(t('bundleLabel'))}</h3>
      <div class="row gap center">
        <select class="input grow" id="ee-bsport">
          <option value="">${esc(t('noBundle'))}</option>
          ${sportOptions(draft.bundles?.[0]?.sport)}
        </select>
        <input class="input input-num" id="ee-bprice" type="number" min="0" step="1" placeholder="$" value="${esc(draft.bundles?.[0]?.priceE ?? '')}">
      </div>
      ${!creating ? `
        <div class="row gap wrap ee-bulk">
          <button class="btn btn-small btn-ghost grow" id="ee-apply">${esc(t('applySeason'))}</button>
          <button class="btn btn-small btn-ghost grow" id="ee-dup">${esc(t('duplicateEvent'))}</button>
        </div>
        <p class="hint">${esc(t('applySeasonHint'))}</p>` : ''}
      <div class="row gap sticky-actions">
        <button class="btn btn-ghost grow" data-close>${esc(t('cancel'))}</button>
        ${!creating ? `<button class="btn btn-danger" id="ee-delete">${esc(t('deleteBtn'))}</button>` : ''}
        <button class="btn btn-primary grow" id="ee-save">${esc(creating ? t('createEvent') : t('saveChanges'))}</button>
      </div>
    </div>`, { wide: true });

  function renderLists() {
    $('#ee-lists', ov).innerHTML = draft.lists.map((l, i) => `
      <div class="ee-list" data-i="${i}">
        <div class="row gap">
          <select class="input" data-f="sessionId">
            <option value="s1" ${l.sessionId === 's1' ? 'selected' : ''}>${esc(t('slotN', { n: 1 }))}</option>
            <option value="s2" ${l.sessionId === 's2' ? 'selected' : ''}>${esc(t('slotN', { n: 2 }))}</option>
          </select>
          <select class="input grow" data-f="sport">${sportOptions(l.sport)}</select>
          <select class="input input-num" data-f="teamCount" title="${esc(t('teams'))}">
            ${[0, ...teamOptionsFor(l.sport)].map(n => `<option value="${n}" ${(l.teamCount || 0) === n ? 'selected' : ''}>${n || '—'}</option>`).join('')}
          </select>
          <button class="btn btn-tiny btn-danger" data-del="${i}">✕</button>
        </div>
        <div class="row gap">
          <input class="input grow" data-f="label" placeholder="${esc(t('levelPh'))}" value="${esc(l.label)}">
          <input class="input input-num" data-f="cap" type="number" min="0" step="1" value="${esc(l.cap)}">
          <input class="input input-num" data-f="priceE" type="number" min="0" step="1" value="${esc(l.priceE)}">
          <input class="input input-num" data-f="priceC" type="number" min="0" step="1" value="${esc(l.priceC)}">
        </div>
        <div class="row gap">
          <select class="input grow" data-f="level" title="${esc(t('gradeLbl'))}">
            <option value="0" ${!l.level ? 'selected' : ''}>${esc(t('gradeNone'))}</option>
            ${LEVELS.map(x => `<option value="${x.rank}" ${Number(l.level) === x.rank ? 'selected' : ''}>${esc(t('gradeIs', { level: x.label }))}</option>`).join('')}
          </select>
        </div>
        <div class="ee-cols"><span>${esc(t('listCols'))}</span><span>${esc(t('listCols2'))}</span></div>
      </div>`).join('');
    $$('.ee-list', ov).forEach(rowEl => {
      const i = +rowEl.dataset.i;
      $$('[data-f]', rowEl).forEach(inp => inp.addEventListener('change', () => {
        const f = inp.dataset.f;
        const numeric = f === 'cap' || f === 'priceE' || f === 'priceC' || f === 'teamCount' || f === 'level';
        draft.lists[i][f] = numeric ? (parseFloat(inp.value) || 0) : inp.value;
      }));
    });
    $$('[data-del]', ov).forEach(b => b.addEventListener('click', () => {
      draft.lists.splice(+b.dataset.del, 1);
      renderLists();
    }));
  }
  renderLists();

  $('#ee-addlist', ov).addEventListener('click', () => {
    draft.lists.push({ id: uid('l'), sessionId: 's1', sport: 'volleyball', label: '', cap: 14, level: 0, priceE: 8, priceC: 10, teamCount: 0 });
    renderLists();
  });

  $('#ee-save', ov).addEventListener('click', async () => {
    draft.title = $('#ee-title', ov).value.trim() || 'Saturday Drop-in';
    draft.date = $('#ee-date', ov).value;
    draft.location = $('#ee-location', ov).value.trim();
    draft.sessions = [
      { id: 's1', label: $('#ee-s1', ov).value.trim() || t('slotN', { n: 1 }) },
      { id: 's2', label: $('#ee-s2', ov).value.trim() || t('slotN', { n: 2 }) },
    ];
    const bsport = $('#ee-bsport', ov).value;
    const bprice = parseFloat($('#ee-bprice', ov).value);
    draft.bundles = bsport && !isNaN(bprice)
      ? [{ sport: bsport, label: `${SPORTS[bsport].label} 4h`, priceE: bprice, priceC: bprice }]
      : [];
    if (!draft.date) { toast(t('pickDate'), 'err'); return; }
    if (!draft.lists.length) { toast(t('addOneList'), 'err'); return; }
    draft.status = draft.status || 'open';
    await store.saveEvent(draft);
    ov.remove();
    toast(creating ? t('eventCreated') : t('eventSaved'));
    location.hash = '#/event/' + draft.id;
  });

  // Both of these publish the draft first, so what spreads is what is on
  // screen rather than what was last saved.
  $('#ee-apply', ov)?.addEventListener('click', async () => {
    await store.saveEvent(draft);
    ov.remove();
    await applyListsToSeason(draft);
  });
  $('#ee-dup', ov)?.addEventListener('click', async () => {
    await store.saveEvent(draft);
    ov.remove();
    await duplicateEvent(draft);
  });

  const del = $('#ee-delete', ov);
  if (del) del.addEventListener('click', async () => {
    const played = isPastEvent(draft) && eventSignups(draft.id).length;
    if (played) {
      ov.remove();
      await confirmModal(t('cannotDeletePast', { n: played, date: fmtDate(draft.date) }), t('ok'), { alert: true });
      return;
    }
    ov.remove();
    if (await confirmModal(t('deleteEventConfirm'), t('deleteEvent'))) {
      await store.deleteEvent(draft.id);
      location.hash = '#/';
      toast(t('eventDeleted'));
    }
  });
}

/* ================================================================== */
/* Exec: club settings                                                 */
/* ================================================================== */

/*
 * Who is an exec.
 *
 * The list lives in the club's settings and is the only thing that grants
 * exec powers, so it is also the only thing worth protecting: once the
 * database rules are tightened, nobody who is not already on it can change
 * it. Two guards here are for the honest mistakes rather than the attacks —
 * you cannot remove yourself, and you cannot empty the list, because either
 * one locks the club out of its own app on a Saturday night.
 */
function openExecsModal() {
  // Same normalising as isExec, for the same reason: this is what decides
  // whether the "you cannot remove yourself" guard recognises you.
  const me = (currentUser()?.email || '').trim().toLowerCase();
  const ov = openModal(`
    <div class="modal-body">
      <h2 class="m0">${esc(t('execsTitle'))}</h2>
      <p class="hint">${esc(t('execsHint'))}</p>
      <div class="summary-list" id="ex-list"></div>
      <label class="field-label" for="ex-new">${esc(t('execsAddLbl'))}</label>
      <div class="row gap">
        <input class="input grow" id="ex-new" type="email" inputmode="email"
               placeholder="${esc(t('emailPh').replace(' *', ''))}">
        <button class="btn btn-primary" id="ex-add">${esc(t('add'))}</button>
      </div>
      <button class="btn btn-ghost wide" data-close>${esc(t('close'))}</button>
    </div>`, { wide: true });

  async function save(list) {
    await store.saveSettings({ execEmails: list });
    logAction('execs', t('logExecs', { n: list.length, list: list.join(', ') }));
  }

  function paint() {
    const list = execEmails();
    $('#ex-list', ov).innerHTML = list.length ? list.map(email => `
      <div class="entry">
        <span class="grow entry-name"><span>${esc(email)}</span>${
          email === me ? `<small>${esc(t('execsYou'))}</small>` : ''}</span>
        ${email === me
          ? `<span class="chip chip-muted">${esc(t('execsYouChip'))}</span>`
          : `<button class="btn btn-tiny btn-danger-ghost" data-drop="${esc(email)}">\u2715</button>`}
      </div>`).join('') : `<p class="hint">${esc(t('execsEmpty'))}</p>`;

    $$('[data-drop]', ov).forEach(b => b.addEventListener('click', async () => {
      const email = b.dataset.drop;
      const left = execEmails().filter(x => x !== email);
      if (!left.length) { toast(t('execsLastOne'), 'err'); return; }
      if (!await confirmModal(t('execsDropAsk', { email }), t('remove'))) return;
      await save(left);
      toast(t('execsDropped', { email }));
      paint();
    }));
  }

  $('#ex-add', ov).addEventListener('click', async () => {
    const email = $('#ex-new', ov).value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast(t('emailRequired'), 'err'); return; }
    const list = execEmails();
    if (list.includes(email)) { toast(t('execsAlready', { email }), 'warn'); return; }
    await save([...list, email]);
    $('#ex-new', ov).value = '';
    toast(t('execsAdded', { email }));
    paint();
  });
  paint();
}

function openSettingsModal() {
  const s = state.settings;
  const ov = openModal(`
    <div class="modal-body">
      <h2>${esc(t('clubSettings'))}</h2>
      <div class="stack">
        <label class="field-label">${esc(t('etransferEmailLbl'))}</label>
        <input class="input" id="cs-email" value="${esc(s.etransferEmail || '')}">
        <label class="field-label">${esc(t('defaultLocation'))}</label>
        <input class="input" id="cs-location" value="${esc(s.location || '')}">
        <label class="field-label">${esc(t('instaHandle'))}</label>
        <input class="input" id="cs-insta" value="${esc(s.instagram || '')}">
        ${signInMode() !== 'required' ? `
          <label class="field-label">${esc(t('execPinLbl'))}</label>
          <input class="input" id="cs-pin" value="${esc(s.execPin || '')}" maxlength="12">
          <p class="hint">${esc(t('execPinHint'))}</p>` : ''}
        <label class="field-label">${esc(t('signInModeLbl'))}</label>
        <select class="input" id="cs-signin">
          <option value="off" ${signInMode() === 'off' ? 'selected' : ''}>${esc(t('signInModeOff'))}</option>
          <option value="optional" ${signInMode() === 'optional' ? 'selected' : ''}>${esc(t('signInModeOptional'))}</option>
          <option value="required" ${signInMode() === 'required' ? 'selected' : ''}>${esc(t('signInModeRequired'))}</option>
        </select>
        <p class="hint">${esc(t('signInModeHint'))}</p>
        <label class="field-label">${esc(t('seasonEndLbl'))}</label>
        <input class="input" id="cs-season" type="date" value="${esc(s.seasonEnd || '')}">
        <label class="field-label">${esc(t('lateFeeLbl'))}</label>
        <input class="input" id="cs-latefee" value="${esc(s.lateFeeNote || '')}">
        <label class="field-label">${esc(t('lateFeeAmountLbl'))}</label>
        <input class="input input-num" id="cs-latefeeamt" type="number" min="0" step="1" value="${esc(s.lateFeeAmount ?? 5)}">
        <label class="field-label">${esc(t('passPricesLbl'))}</label>
        <div class="row gap">
          <input class="input input-num grow" id="cs-pass4" type="number" min="0" step="1" value="${esc(s.passPrice4h ?? 135)}" title="4H">
          <input class="input input-num grow" id="cs-pass2" type="number" min="0" step="1" value="${esc(s.passPrice2h ?? 75)}" title="2H">
        </div>
        <p class="hint">${esc(t('passPricesHint'))}</p>
        <label class="field-label">${esc(t('testAmountLbl'))}</label>
        <input class="input input-num" id="cs-test" type="number" min="0" step="1" value="${esc(s.testAmount ?? 1)}">
        <p class="hint">${esc(t('testAmountHint'))}</p>
        <label class="field-label">${esc(t('signupOpenLbl'))}</label>
        <input class="input input-num" id="cs-openahead" type="number" min="0" step="1" value="${esc(s.signupOpenDaysBefore ?? 6)}">
        <label class="field-label">${esc(t('battlePassNoteLbl'))}</label>
        <textarea class="input" id="cs-bpnote" rows="3">${esc(s.battlePassNote || '')}</textarea>
        <label class="field-label">${esc(t('policiesLbl'))}</label>
        <textarea class="input" id="cs-policies" rows="6">${esc((s.policies || []).join('\n'))}</textarea>
        <label class="field-label">${esc(t('policiesUrlLbl'))}</label>
        <input class="input" id="cs-policies-url" value="${esc(s.policiesUrl || '')}" placeholder="https://">
      </div>
      <div class="row gap">
        <button class="btn btn-ghost grow" data-close>${esc(t('cancel'))}</button>
        <button class="btn btn-primary grow" id="cs-save">${esc(t('save'))}</button>
      </div>
    </div>`, { wide: true });
  $('#cs-save', ov).addEventListener('click', async () => {
    const want = $('#cs-signin', ov).value;
    if (want === 'required' && signInMode() !== 'required'
        && !await confirmModal(t('requireSignInAsk'), t('requireSignInGo'))) return;
    if (want === 'optional' && signInMode() === 'off'
        && !await confirmModal(t('offerSignInAsk'), t('offerSignInGo'))) return;
    await store.saveSettings({
      etransferEmail: $('#cs-email', ov).value.trim(),
      location: $('#cs-location', ov).value.trim(),
      instagram: $('#cs-insta', ov).value.trim().replace(/^@/, ''),
      ...($('#cs-pin', ov) ? { execPin: $('#cs-pin', ov).value.trim() || '1405' } : {}),
      signInMode: $('#cs-signin', ov).value,
      seasonEnd: $('#cs-season', ov).value || s.seasonEnd || '',
      lateFeeNote: $('#cs-latefee', ov).value.trim(),
      lateFeeAmount: parseFloat($('#cs-latefeeamt', ov).value) || 0,
      // The Gmail matcher reads these from here too, so a price only ever
      // exists in one place.
      passPrice4h: parseFloat($('#cs-pass4', ov).value) || 0,
      passPrice2h: parseFloat($('#cs-pass2', ov).value) || 0,
      testAmount: parseFloat($('#cs-test', ov).value) || 0,
      signupOpenDaysBefore: parseFloat($('#cs-openahead', ov).value) || 0,
      battlePassNote: $('#cs-bpnote', ov).value.trim(),
      policies: $('#cs-policies', ov).value.split('\n').map(x => x.trim()).filter(Boolean),
      policiesUrl: $('#cs-policies-url', ov).value.trim(),
    });
    ov.remove();
    toast(t('settingsSaved'));
  });
}

/* ================================================================== */
/* Boot                                                                */
/* ================================================================== */

let matchTimer = null;

async function main() {
  document.documentElement.lang = getLang();
  // Reaching the shared database can take a few seconds on a phone; never
  // leave the screen blank while it happens.
  $('#view').innerHTML = `<div class="empty">${esc(t('connecting'))}</div>`;
  store = await createStore();
  window.addEventListener('hashchange', render);
  const existing = getProfile();
  if (existing) registerPlayer(existing); // keep the directory's "last seen" fresh
  // Everyone watches the player registry: Battle Pass status must be known
  // on every device for prices, chips, and reminder emails to be right.
  store.watchPlayers();
  // The signed-in address is the one the app trusts from here on. Nobody
  // can claim somebody else's, which is what makes the exec list mean
  // anything and what stops one person becoming two accounts.
  await initAuth(store.firebaseApp, (me) => {
    if (me) adoptSignedInIdentity(me);
    render();
  });
  await store.init(newState => {
    state = newState;
    render();
    // Received e-transfers land here the moment the Gmail script files them.
    clearTimeout(matchTimer);
    matchTimer = setTimeout(runAutoMatch, 1200);
    // Keep the Gmail matcher's view of who owes what current.
    scheduleDues();
  });
  // Every ten minutes, and whenever the phone comes back to this tab.
  checkForNewBuild();
  setInterval(checkForNewBuild, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkForNewBuild();
  });
}

main();
