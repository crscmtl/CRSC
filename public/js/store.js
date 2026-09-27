/*
 * Data layer for the CRSC app.
 *
 * Two implementations behind one interface:
 *  - Demo store: everything in localStorage. Used when firebase-config.js
 *    has no config. Great for previewing / testing the UI.
 *  - Firebase store: Firestore with realtime listeners. Used in production.
 *
 * Interface:
 *   store.mode                  -> 'demo' | 'live'
 *   store.init(onChange)        -> starts listeners; onChange(state) fires on every change
 *   store.watchEvent(eventId)   -> subscribe to an event's signups
 *   store.unwatchEvent(eventId)
 *   store.saveSettings(patch)
 *   store.saveEvent(event)      -> create or update (event.id required)
 *   store.deleteEvent(eventId)
 *   store.addSignups(eventId, [signup, ...])
 *   store.updateSignup(eventId, signupId, patch)
 *   store.deleteSignup(eventId, signupId)
 *   store.savePlayer(player)    -> create or merge (player.deviceId required)
 *   store.deletePlayer(deviceId)
 *   store.addLog(entry) / store.watchLog()   -> who did what, append-only
 *   store.addRefund(record) / store.updateRefund(id, patch) / store.watchRefunds()
 *
 * state = { settings, events: [...], signups: { [eventId]: [...] } }
 */

export const DEFAULT_SETTINGS = {
  clubName: 'CRSC',
  clubFullName: 'Concordia Recreational Sports Club',
  etransferEmail: 'concordiaRSclub@gmail.com',
  instagram: 'crsc_concordia',
  location: 'Collège de Maisonneuve, 2701 rue Nicolet, H1X 1Z8, 3rd floor',
  execPin: '1405',
  /*
   * How much the app asks of a Google or email sign-in. One setting rather
   * than two switches, because the three states are a sequence and the club
   * moves along it when it decides to, not when a deploy does:
   *
   *   'off'      nothing about sign-in is shown. The PIN is how an exec gets
   *              in, and the app behaves exactly as it did before any of
   *              this existed. This is the default.
   *   'optional' sign-in is offered. An address on the exec list gets exec
   *              powers; the PIN still works for everyone who has not.
   *   'required' nobody gets in without signing in, and the PIN is retired.
   *
   * Moving to 'optional' needs Google and email-link sign-in switched on in
   * the Firebase console first, or the buttons have nothing to talk to.
   */
  signInMode: 'off',
  seasonEnd: '2026-12-26',
  lateFeeNote: '+5$ late fee if payment is made after the event',
  lateFeeAmount: 5,
  cancelLockHours: 24,
  // How many names may wait behind a full list. An unbounded waitlist is a
  // promise the club cannot keep: thirty people queued for two spare places
  // have all been told "maybe", and the ones at the bottom turn up for
  // nothing. 0 means a full list takes no more names at all.
  waitlistMax: 5,
  // Registration opens this many days before the event: 6 = the Sunday
  // before a Saturday game, so exactly one Saturday is open at a time.
  signupOpenDaysBefore: 6,
  battlePassNote: 'Volleyball season pass — 4h (both slots) 135$ instead of 165$ · 2h 75$ instead of 88$. E-transfer the club and an exec activates it on your profile.',
  // What a season pass costs. An e-transfer for exactly one of these amounts
  // tags the sender's pass on its own, so nobody has to remember to do it.
  passPrice4h: 135,
  passPrice2h: 75,
  // A pass holder's seat is held for them every week; they tell an exec in
  // advance when they cannot make it and the exec takes the name off.
  passAutoSeat: true,
  // Dollar amount reserved for end-to-end testing. A transfer for exactly
  // this never marks anyone paid — it only proves the pipeline works.
  testAmount: 1,
  policiesUrl: 'https://tr.ee/iiwCfpxvsA',
  policies: [
    'For e-Transfer make sure to mention the name of the person(s) you are paying for.',
    'Please note that the host might move your name to the appropriate level.',
    'Your spot is not confirmed until payment is received.',
    "If you can't attend an event you have to remove your name from the list.",
    "You will get reimbursed or play for free next time if you can't attend.",
  ],
};

/*
 * Playing levels, lowest first. A player tagged at a level may sign up for
 * that level and anything below it — the club grades people so a beginner
 * does not end up on the Advanced + court, not to keep anyone out of the
 * easier games.
 *
 * Only volleyball is graded. Basketball's "Mixed" and "Men" lists are about
 * who plays together, not how well.
 */
export const LEVELS = [
  { id: 'intermediate', rank: 1, label: 'Intermediate', short: 'INT' },
  { id: 'advanced',     rank: 2, label: 'Advanced',     short: 'ADV' },
  { id: 'advmixed',     rank: 3, label: 'Adv + Mixed',  short: 'ADV+ MIX' },
  { id: 'advplus',      rank: 4, label: 'Advanced +',   short: 'ADV+' },
];

export function levelByRank(rank) {
  return LEVELS.find(l => l.rank === rank) || null;
}

/*
 * How hard a list is. Events store this per list (`level`), so the club can
 * change the grading without a code change; the label reading below is only
 * the fallback for lists created before that existed.
 */
export function listLevel(list) {
  if (!list || list.sport !== 'volleyball') return 0;   // ungraded
  // An explicit grade always wins, including a deliberate 0 for "anyone".
  // Only a list made before grades existed falls through to its label, and
  // that guess breaks the moment somebody renames one.
  if (list.level !== undefined && list.level !== null && list.level !== '') return Number(list.level);
  const raw = String(list.label || '');
  if (/intermediate|débutant|beginner/i.test(raw)) return 1;
  if (/mix/i.test(raw)) return 3;              // "Adv + Mixed"
  if (/\+|\bmen\b|\bhomme/i.test(raw)) return 4;  // "Advanced +", "Adv + Men"
  return 2;                                     // "Advanced"
}

export const SPORTS = {
  /* Volleyball games: at most 4 teams of at most 7 players each. Team rules
   * for basketball and football are still to be decided by the club. */
  volleyball: { label: 'Volleyball', emoji: '🏐', color: '#2f7dd1', maxTeams: 4, teamSize: 7 },
  basketball: { label: 'Basketball', emoji: '🏀', color: '#e0762c' },
  football:   { label: 'Football',   emoji: '⚽', color: '#2f9e44' },
  badminton:  { label: 'Badminton',  emoji: '🏸', color: '#9c36b5' },
  other:      { label: 'Other',      emoji: '🎽', color: '#64748b' },
};

export function uid(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/* Adopt an existing player identity (profile transfer / restore). */
export function setDeviceId(id) {
  try { localStorage.setItem('crsc-device-id', id); } catch (e) { /* ignore */ }
}

export function deviceId() {
  let id = null;
  try { id = localStorage.getItem('crsc-device-id'); } catch (e) { /* ignore */ }
  if (!id) {
    id = uid('dev_');
    try { localStorage.setItem('crsc-device-id', id); } catch (e) { /* ignore */ }
  }
  return id;
}

/* A ready-to-use Saturday template mirroring the club's current sheet. */
export function makeTemplateEvent(dateStr, title) {
  // The club's actual lists. Labels say who a list is for — a player picking
  // a level should never have to ask whether it is mixed or men's.
  const lists = [
    { id: uid('l'), sessionId: 's1', sport: 'basketball', label: 'Mixed',              cap: 12, priceE: 10, priceC: 10, teamCount: 0 },
    { id: uid('l'), sessionId: 's1', sport: 'basketball', label: 'Men',                cap: 12, priceE: 10, priceC: 10, teamCount: 0 },
    { id: uid('l'), sessionId: 's1', sport: 'football',   label: '5v5',                cap: 15, priceE: 10, priceC: 10, teamCount: 0 },
    // Graded lists read easiest first, the way the 7:30 slot always has.
    { id: uid('l'), sessionId: 's1', sport: 'volleyball', label: 'Advanced',           cap: 21, level: 2, priceE: 8,  priceC: 10, teamCount: 3 },
    { id: uid('l'), sessionId: 's1', sport: 'volleyball', label: 'Advanced +',         cap: 21, level: 4, priceE: 8,  priceC: 10, teamCount: 3 },
    { id: uid('l'), sessionId: 's2', sport: 'volleyball', label: 'Intermediate',       cap: 21, level: 1, priceE: 8,  priceC: 10, teamCount: 3 },
    { id: uid('l'), sessionId: 's2', sport: 'volleyball', label: 'Advanced',           cap: 28, level: 2, priceE: 8,  priceC: 10, teamCount: 4 },
    { id: uid('l'), sessionId: 's2', sport: 'volleyball', label: 'Adv + Mixed',        cap: 21, level: 3, priceE: 8,  priceC: 10, teamCount: 3 },
    { id: uid('l'), sessionId: 's2', sport: 'volleyball', label: 'Adv + Men',          cap: 21, level: 4, priceE: 8,  priceC: 10, teamCount: 3 },
  ];
  return {
    id: uid('ev'),
    title: title || 'Saturday Drop-in',
    date: dateStr,
    status: 'open',
    location: DEFAULT_SETTINGS.location,
    sessions: [
      { id: 's1', label: '5:30 – 7:30 PM' },
      { id: 's2', label: '7:30 – 9:30 PM' },
    ],
    lists,
    bundles: [
      { sport: 'volleyball', label: 'Volleyball 4h (both time slots)', priceE: 15, priceC: 15 },
    ],
    createdAt: Date.now(),
  };
}

/* Local-time ISO date (YYYY-MM-DD). Never use toISOString() for calendar
 * dates: it converts to UTC, which in Montréal shifts evening dates to the
 * next day — turning Saturdays into Sundays. */
export function localISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* The coming Saturday — and on a Saturday, TODAY. A drop-in game stays the
 * current one all through its own day, so game-day check-in still finds it. */
export function nextSaturday(offsetWeeks = 0) {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7) + offsetWeeks * 7);
  return localISO(d);
}

/* Every Saturday from the next one through endDate (inclusive), as ISO dates. */
export function saturdaysUntil(endDate) {
  const out = [];
  for (let i = 0; ; i++) {
    const s = nextSaturday(i);
    if (!endDate || s > endDate) break;
    out.push(s);
    if (out.length > 60) break; // safety
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Demo store (localStorage)                                          */
/* ------------------------------------------------------------------ */

const DEMO_KEY = 'crsc-demo-v7';

/*
 * Real line-up for the September 12 event, transcribed from the club's
 * Google Sheet so execs can test check-in and payment marking with the
 * actual roster. Slot-2 volleyball merges the sheet's two "court" columns
 * into one Advanced and one Advanced + list, as the club asked.
 */
const SEPT12_LISTS = [
  { sessionId: 's1', sport: 'basketball', label: 'Mixed', cap: 12, priceE: 10, priceC: 10,
    names: ['Essma', 'Maya Marshel', 'Christina', 'Hela', 'Fairouz'] },
  { sessionId: 's1', sport: 'basketball', label: 'Men', cap: 12, priceE: 10, priceC: 10,
    names: ['Rayan', 'mo', 'Nathanael', 'Huy', 'Malik', 'Houssam', 'Alexandre', 'Arthur', 'Mattis', 'Simon-Pierre'] },
  { sessionId: 's1', sport: 'football', label: '5v5', cap: 13, priceE: 10, priceC: 10,
    names: ['Siavash Shahbazi', 'Sepehr Seifpour', 'Soroush Seifpour', 'Omar el akrae', 'Jaberty',
            'Saad Achaou', 'Lokmene Almouba', 'Omar', 'Mohamed', 'Jad', 'Hussein', 'Omar (2)', 'Abdeltif'],
    wait: ['Ibram'] },
  { sessionId: 's1', sport: 'volleyball', label: 'Advanced', cap: 21, priceE: 8, priceC: 10, teamCount: 4,
    names: ['Heejin', 'Anthony', 'Deniz', 'Maura', 'Jason', 'Rohan', 'Wissame', 'Nesrine', 'William', 'Fernando',
            'Denis', 'Amine', 'Kerby', 'Jia', 'Jaeden', 'Aarif', 'isaiah', 'Arvic', 'wacim', 'Ameena', 'Yomna'],
    wait: ['Ines', 'Clément C', 'Siomara', 'Viviana', 'jeet', 'Alexi'] },
  { sessionId: 's1', sport: 'volleyball', label: 'Advanced +', cap: 21, priceE: 8, priceC: 10, teamCount: 4,
    names: ['Giulio', 'Juansi', 'Minhtu', 'Cami', 'Ayman', 'Theo', 'Fred', 'Michael F', 'Vicky', 'Yu chen',
            'Kai', 'Colby', 'Sarah', 'Mohammed E', 'Milo', 'Hyun', 'Ben', 'Dodam', 'Lorys', 'Paul', 'Ishak'],
    wait: ['Adel', 'Nassim', 'Rubens', 'Alejandro', 'Camille', 'Mathias'] },
  { sessionId: 's2', sport: 'volleyball', label: 'Advanced', cap: 41, priceE: 8, priceC: 10, teamCount: 4,
    names: ['Kevin', 'Raul', 'Ben', 'Anaïs', 'Rishit', 'Daiwei', 'Jaeden', 'Heejin', 'Anthony', 'Bea',
            'Deniz', 'Arvic', 'Rohan', 'Wissame', 'Nesrine', 'William', 'Ines', 'Haig', 'Ida', 'Selim',
            'Ben F', 'Jason', 'isaiah', 'Jennifer Z', 'Gabs', 'frédérique', 'ana', 'Fernando', 'Denis', 'Amine',
            'Kerby', 'Jia', 'Amy', 'wacim', 'Benito', 'Camila', 'Tyrel', 'Mohammad a', 'Mahmoud a',
            'Faris', 'Alya'],
    wait: ['Ehsan', 'Neil G', 'Glob', 'Célia D', 'Gab C', 'Max', 'Alexa DV'] },
  { sessionId: 's2', sport: 'volleyball', label: 'Advanced +', cap: 40, priceE: 8, priceC: 10, teamCount: 4,
    names: ['Romain', 'Fred', 'Michael F', 'Vicky', 'Cami', 'Aidan', 'Clement C', 'Kanghee', 'Yuan',
            'Micheal khoo', 'Colby', 'Kai', 'Nassim', 'Rubens', 'Alejandro', 'Camille', 'Milo', 'Ben',
            'Arthur', 'Sarah', 'Top', 'Ayman', 'Yu Chen', 'Theo', 'mo', 'Lorys', 'Nathanael', 'Mohammed E',
            'Etienne', 'Alexis', 'Hyun', 'Dodam', 'Keon', 'Ishak', 'Paul', 'Rayan', 'Giulio', 'Juansi',
            'Minhtu', 'Adel'] },
];

/* Paid by e-transfer (green checks on the bundle payment sheet). Their
 * volleyball spots start marked paid; other sports stay unpaid. */
const SEPT12_PAID = ['Etienne', 'Alexis', 'Top', 'Arthur', 'Hyun', 'Heejin', 'Ines'];

function playerId(name) {
  return 'p-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function demoSeed() {
  const players = {};
  const base = Date.now();
  let seq = 0;

  // The whole season is open; September 12 carries the real roster.
  const season = saturdaysUntil(DEFAULT_SETTINGS.seasonEnd).slice(0, 16)
    .map(d => makeTemplateEvent(d, 'Saturday Drop-in'));
  const signups = {};
  for (const ev of season) signups[ev.id] = [];

  const first = season[0];
  first.lists = [];
  const roster = [];
  for (const spec of SEPT12_LISTS) {
    const list = {
      id: uid('l'), sessionId: spec.sessionId, sport: spec.sport, label: spec.label,
      cap: spec.cap, priceE: spec.priceE, priceC: spec.priceC, teamCount: spec.teamCount || 0,
    };
    first.lists.push(list);
    for (const name of [...spec.names, ...(spec.wait || [])]) {
      const deviceId = playerId(name);
      if (!players[deviceId]) {
        players[deviceId] = { deviceId, name, insta: '', email: '', phone: '', photo: '', lang: 'en', lastSeen: base };
      }
      roster.push({
        id: uid('su'),
        listId: list.id,
        name, insta: '', email: '', phone: '', photo: '',
        deviceId,
        method: 'etransfer',
        paid: spec.sport === 'volleyball' && SEPT12_PAID.includes(name),
        checkedIn: false,
        team: null,
        order: base + seq,
        createdAt: base + seq,
        addedByExec: true,
      });
      seq++;
    }
  }
  signups[first.id] = roster;

  return {
    settings: { ...DEFAULT_SETTINGS },
    events: season,
    signups,
    players,
    payments: [],
    removals: [],
  };
}

function createDemoStore() {
  let state;
  try {
    state = JSON.parse(localStorage.getItem(DEMO_KEY));
  } catch (e) { state = null; }
  if (!state || !state.settings || !Array.isArray(state.events)) state = demoSeed();
  state.settings = { ...DEFAULT_SETTINGS, ...state.settings };
  state.players = state.players || {};
  state.payments = state.payments || [];
  state.removals = state.removals || [];
  let onChange = () => {};

  function persist() {
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    onChange(state);
  }

  return {
    mode: 'demo',
    firebaseApp: null,
    async init(cb) { onChange = cb; onChange(state); },
    watchEvent() {},
    unwatchEvent() {},
    async saveSettings(patch) {
      state.settings = { ...state.settings, ...patch };
      persist();
    },
    async saveEvent(event) {
      const i = state.events.findIndex(e => e.id === event.id);
      if (i >= 0) state.events[i] = event; else state.events.push(event);
      if (!state.signups[event.id]) state.signups[event.id] = [];
      persist();
    },
    async deleteEvent(eventId) {
      state.events = state.events.filter(e => e.id !== eventId);
      delete state.signups[eventId];
      persist();
    },
    async addSignups(eventId, signups) {
      if (!state.signups[eventId]) state.signups[eventId] = [];
      const rows = state.signups[eventId];
      // Upsert by id, the same as setDoc() on the real backends. An id that
      // is already there is the same row written twice, not a second person.
      for (const su of signups) {
        const i = rows.findIndex(x => x.id === su.id);
        if (i >= 0) rows[i] = { ...rows[i], ...su }; else rows.push(su);
      }
      persist();
    },
    async seatSignups(eventId, signups) {
      if (!state.signups[eventId]) state.signups[eventId] = [];
      const have = new Set(state.signups[eventId].map(x => x.id));
      const fresh = signups.filter(su => !have.has(su.id));
      state.signups[eventId].push(...fresh);
      persist();
      return fresh;
    },
    async updateSignup(eventId, signupId, patch) {
      const list = state.signups[eventId] || [];
      const s = list.find(x => x.id === signupId);
      if (s) Object.assign(s, patch);
      persist();
    },
    async deleteSignup(eventId, signupId) {
      state.signups[eventId] = (state.signups[eventId] || []).filter(x => x.id !== signupId);
      persist();
    },
    async savePlayer(player) {
      state.players[player.deviceId] = { ...state.players[player.deviceId], ...player };
      persist();
    },
    async deletePlayer(deviceId) {
      delete state.players[deviceId];
      persist();
    },
    watchPlayers() {},
    watchPayments() {},
    watchRemovals() {},
    async saveDues() { /* demo mode has no server-side matcher to feed */ },
    async updatePayment(paymentId, patch) {
      const p = state.payments.find(x => x.id === paymentId);
      if (p) Object.assign(p, patch);
      persist();
    },
    async addRemoval(record) {
      state.removals.push(record);
      persist();
    },
    async addLog(entry) {
      state.log = state.log || [];
      state.log.push(entry);
      persist();
    },
    watchLog() {},
    async addRefund(record) {
      state.refunds = state.refunds || [];
      state.refunds.push(record);
      persist();
    },
    async updateRefund(id, patch) {
      const r = (state.refunds || []).find(x => x.id === id);
      if (r) Object.assign(r, patch);
      persist();
    },
    watchRefunds() {},
    resetDemo() {
      state = demoSeed();
      persist();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Firebase store (Firestore)                                         */
/* ------------------------------------------------------------------ */

async function createFirebaseStore(config) {
  const appMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
  const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');

  const app = appMod.initializeApp(config);
  const db = fs.getFirestore(app);

  const state = { settings: { ...DEFAULT_SETTINGS }, events: [], signups: {}, players: {}, payments: [], removals: [] };
  let onChange = () => {};
  const eventWatchers = {}; // eventId -> unsubscribe
  let playersWatcher = null;
  let paymentsWatcher = null;
  let removalsWatcher = null;
  let logWatcher = null;
  let refundsWatcher = null;

  function emit() { onChange(state); }

  return {
    mode: 'live',
    // The auth module attaches to this same app, so there is one project
    // and one session rather than two that can disagree.
    firebaseApp: app,
    async init(cb) {
      onChange = cb;
      fs.onSnapshot(fs.doc(db, 'config', 'main'), snap => {
        state.settings = { ...DEFAULT_SETTINGS, ...(snap.exists() ? snap.data() : {}) };
        emit();
      }, err => console.error('settings listener', err));
      fs.onSnapshot(fs.query(fs.collection(db, 'events')), snap => {
        state.events = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        state.events.sort((a, b) => (a.date < b.date ? 1 : -1));
        emit();
      }, err => console.error('events listener', err));
      emit();
    },
    watchEvent(eventId) {
      if (eventWatchers[eventId]) return;
      eventWatchers[eventId] = fs.onSnapshot(
        fs.collection(db, 'events', eventId, 'signups'),
        snap => {
          state.signups[eventId] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          emit();
        },
        err => console.error('signups listener', err)
      );
    },
    unwatchEvent(eventId) {
      if (eventWatchers[eventId]) { eventWatchers[eventId](); delete eventWatchers[eventId]; }
    },
    async saveSettings(patch) {
      await fs.setDoc(fs.doc(db, 'config', 'main'), patch, { merge: true });
    },
    async saveEvent(event) {
      const { id, ...data } = event;
      await fs.setDoc(fs.doc(db, 'events', id), data);
    },
    async deleteEvent(eventId) {
      // Delete signups first (client-side; fine at club scale).
      const snap = await fs.getDocs(fs.collection(db, 'events', eventId, 'signups'));
      await Promise.all(snap.docs.map(d => fs.deleteDoc(d.ref)));
      await fs.deleteDoc(fs.doc(db, 'events', eventId));
    },
    async addSignups(eventId, signups) {
      await Promise.all(signups.map(s => {
        const { id, ...data } = s;
        return fs.setDoc(fs.doc(db, 'events', eventId, 'signups', id), data);
      }));
    },
    /* Write only the rows that are not there yet, and never overwrite one
     * that is: an auto-seated spot may already have been marked paid. */
    async seatSignups(eventId, signups) {
      const fresh = [];
      await Promise.all(signups.map(async s => {
        const { id, ...data } = s;
        const ref = fs.doc(db, 'events', eventId, 'signups', id);
        if ((await fs.getDoc(ref)).exists()) return;
        await fs.setDoc(ref, data);
        fresh.push(s);
      }));
      return fresh;
    },
    async updateSignup(eventId, signupId, patch) {
      await fs.setDoc(fs.doc(db, 'events', eventId, 'signups', signupId), patch, { merge: true });
    },
    async deleteSignup(eventId, signupId) {
      await fs.deleteDoc(fs.doc(db, 'events', eventId, 'signups', signupId));
    },
    async savePlayer(player) {
      const { deviceId, ...data } = player;
      await fs.setDoc(fs.doc(db, 'players', deviceId), data, { merge: true });
    },
    async deletePlayer(deviceId) {
      await fs.deleteDoc(fs.doc(db, 'players', deviceId));
    },
    watchPlayers() {
      if (playersWatcher) return;
      playersWatcher = fs.onSnapshot(fs.collection(db, 'players'), snap => {
        state.players = {};
        for (const d of snap.docs) state.players[d.id] = { deviceId: d.id, ...d.data() };
        emit();
      }, err => console.error('players listener', err));
    },
    watchPayments() {
      if (paymentsWatcher) return;
      paymentsWatcher = fs.onSnapshot(fs.collection(db, 'payments'), snap => {
        state.payments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        state.payments.sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0));
        emit();
      }, err => console.error('payments listener', err));
    },
    /* What each person still owes for one night, published for the Gmail
     * matcher to read. Prices live in the app and only in the app; this is
     * the answer, not the rules. */
    async saveDues(eventId, data) {
      await fs.setDoc(fs.doc(db, 'dues', eventId), data);
    },
    async updatePayment(paymentId, patch) {
      await fs.setDoc(fs.doc(db, 'payments', paymentId), patch, { merge: true });
    },
    watchRemovals() {
      if (removalsWatcher) return;
      removalsWatcher = fs.onSnapshot(fs.collection(db, 'removals'), snap => {
        state.removals = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        emit();
      }, err => console.error('removals listener', err));
    },
    async addRemoval(record) {
      const { id, ...data } = record;
      await fs.setDoc(fs.doc(db, 'removals', id), data);
    },
    async addLog(entry) {
      const { id, ...data } = entry;
      await fs.setDoc(fs.doc(db, 'log', id), data);
    },
    async addRefund(record) {
      const { id, ...data } = record;
      await fs.setDoc(fs.doc(db, 'refunds', id), data);
    },
    async updateRefund(id, patch) {
      await fs.setDoc(fs.doc(db, 'refunds', id), patch, { merge: true });
    },
    watchRefunds() {
      if (refundsWatcher) return;
      refundsWatcher = fs.onSnapshot(fs.collection(db, 'refunds'), snap => {
        state.refunds = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        emit();
      }, err => console.error('refunds listener', err));
    },
    watchLog() {
      if (logWatcher) return;
      logWatcher = fs.onSnapshot(fs.query(fs.collection(db, 'log'),
        fs.orderBy('at', 'desc'), fs.limit(300)), snap => {
        state.log = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        emit();
      }, err => console.error('log listener', err));
    },
  };
}


/* ------------------------------------------------------------------ */
/* Artifact store (claude.ai shared database)                          */
/*                                                                     */
/* When the page runs as a published Artifact with the `db` capability, */
/* every viewer reads and writes the same documents, live. Same shape   */
/* as the Firestore store below, so every exec sees each other's        */
/* check-ins, payments, passes, team moves and removals immediately.    */
/* ------------------------------------------------------------------ */

async function createArtifactDbStore() {
  const api = typeof window !== 'undefined' ? window.claude : null;
  if (!api || typeof api.use !== 'function') return null;
  let db = null;
  try { db = await api.use('db'); } catch (e) { db = null; }
  if (!db) return null;

  const state = { settings: { ...DEFAULT_SETTINGS }, events: [], signups: {}, players: {}, payments: [], removals: [] };
  let onChange = () => {};
  const eventWatchers = {};
  let playersWatcher = null, paymentsWatcher = null, removalsWatcher = null, logWatcher = null, refundsWatcher = null;
  const emit = () => onChange(state);
  const onErr = where => e => console.error('db ' + where, e);

  /* `update` requires the document to exist; fall back to a full write. */
  async function mergeWrite(ref, patch) {
    try {
      await ref.update(patch);
    } catch (e) {
      if (e && e.code === 'invalid_argument') await ref.set(patch);
      else throw e;
    }
  }

  return {
    mode: 'live',
    backend: 'artifact',
    async init(cb) {
      onChange = cb;
      db.doc('config/main').onSnapshot(snap => {
        state.settings = { ...DEFAULT_SETTINGS, ...(snap.exists ? snap.data() : {}) };
        emit();
      }, onErr('settings'));
      db.collection('events').onSnapshot(snap => {
        state.events = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        state.events.sort((a, b) => (a.date < b.date ? 1 : -1));
        emit();
      }, onErr('events'));
      emit();
    },
    watchEvent(eventId) {
      if (eventWatchers[eventId]) return;
      eventWatchers[eventId] = db.collection('events/' + eventId + '/signups').onSnapshot(snap => {
        state.signups[eventId] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        emit();
      }, onErr('signups'));
    },
    unwatchEvent(eventId) {
      if (eventWatchers[eventId]) { eventWatchers[eventId](); delete eventWatchers[eventId]; }
    },
    watchPlayers() {
      if (playersWatcher) return;
      playersWatcher = db.collection('players').onSnapshot(snap => {
        state.players = {};
        for (const d of snap.docs) state.players[d.id] = { deviceId: d.id, ...d.data() };
        emit();
      }, onErr('players'));
    },
    watchPayments() {
      if (paymentsWatcher) return;
      paymentsWatcher = db.collection('payments').onSnapshot(snap => {
        state.payments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        state.payments.sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0));
        emit();
      }, onErr('payments'));
    },
    watchRemovals() {
      if (removalsWatcher) return;
      removalsWatcher = db.collection('removals').onSnapshot(snap => {
        state.removals = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        emit();
      }, onErr('removals'));
    },
    async saveSettings(patch) {
      await mergeWrite(db.doc('config/main'), patch);
    },
    async saveEvent(event) {
      const { id, ...data } = event;
      await db.doc('events/' + id).set(data);
    },
    async deleteEvent(eventId) {
      const snap = await db.collection('events/' + eventId + '/signups').get();
      await Promise.all(snap.docs.map(d => db.doc('events/' + eventId + '/signups/' + d.id).delete()));
      await db.doc('events/' + eventId).delete();
    },
    async addSignups(eventId, signups) {
      await Promise.all(signups.map(su => {
        const { id, ...data } = su;
        return db.doc('events/' + eventId + '/signups/' + id).set(data);
      }));
    },
    /* Write only the rows that are not there yet, and never overwrite one
     * that is: an auto-seated spot may already have been marked paid. */
    async seatSignups(eventId, signups) {
      const fresh = [];
      await Promise.all(signups.map(async su => {
        const { id, ...data } = su;
        const ref = db.doc('events/' + eventId + '/signups/' + id);
        if ((await ref.get()).exists) return;
        await ref.set(data);
        fresh.push(su);
      }));
      return fresh;
    },
    async updateSignup(eventId, signupId, patch) {
      await mergeWrite(db.doc('events/' + eventId + '/signups/' + signupId), patch);
    },
    async deleteSignup(eventId, signupId) {
      await db.doc('events/' + eventId + '/signups/' + signupId).delete();
    },
    async savePlayer(player) {
      const { deviceId, ...data } = player;
      await mergeWrite(db.doc('players/' + deviceId), data);
    },
    async deletePlayer(deviceId) {
      await db.doc('players/' + deviceId).delete();
    },
    async saveDues(eventId, data) {
      await mergeWrite(db.doc('dues/' + eventId), data);
    },
    async updatePayment(paymentId, patch) {
      await mergeWrite(db.doc('payments/' + paymentId), patch);
    },
    async addRemoval(record) {
      const { id, ...data } = record;
      await db.doc('removals/' + id).set(data);
    },
    async addLog(entry) {
      const { id, ...data } = entry;
      await db.doc('log/' + id).set(data);
    },
    async addRefund(record) {
      const { id, ...data } = record;
      await db.doc('refunds/' + id).set(data);
    },
    async updateRefund(id, patch) {
      await mergeWrite(db.doc('refunds/' + id), patch);
    },
    watchRefunds() {
      if (refundsWatcher) return;
      refundsWatcher = db.collection('refunds').onSnapshot(snap => {
        state.refunds = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        emit();
      }, err => console.error('refunds listener', err));
    },
    watchLog() {
      if (logWatcher) return;
      logWatcher = db.collection('log').orderBy('at', 'desc').limit(300)
        .onSnapshot(snap => {
          state.log = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          emit();
        }, err => console.error('log listener', err));
    },
  };
}

export async function createStore() {
  const cfg = (typeof window !== 'undefined' && window.FIREBASE_CONFIG) || null;
  if (cfg && cfg.apiKey) {
    try {
      return await createFirebaseStore(cfg);
    } catch (err) {
      console.error('Firebase unavailable, falling back:', err);
    }
  }
  // Published as a claude.ai Artifact: one shared database for every viewer.
  try {
    const shared = await createArtifactDbStore();
    if (shared) return shared;
  } catch (err) {
    console.error('Artifact database unavailable, falling back:', err);
  }
  return createDemoStore();
}
