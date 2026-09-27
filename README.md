# CRSC — Saturday Drop-in Sign-up App

A mobile-first, bilingual (English/French) web app for the **Concordia
Recreational Sports Club** that replaces the shared Google Sheet for Saturday
drop-in events (volleyball, basketball, football).

## What it does

**For players**
- **Registration first**: the first time anyone opens the link they create a
  player profile (name + email required; phone, Instagram, photo optional).
  The device remembers them — next visit goes straight to the calendar.
- **Same profile on every device**: the profile screen has *Use on another
  device*, which hands out a personal link — open it in another browser or on
  another phone and it becomes the same player, with the same spots and
  payments. The welcome screen also offers *I already have a profile*, which
  finds the player by the email they signed up with (needs the shared
  database, i.e. live mode).
- A **season calendar** (every Saturday until the configured season end, e.g. Dec 26): tap a date to sign up. Orange = open, dashed = opens later, struck-through = full, green ring = your games.
- **One Saturday at a time**: a game opens for sign-ups on the **Sunday before**
  it (the `signupOpenDaysBefore` setting, default 6 days). Later Saturdays are
  visible on the calendar as "opens later" with their opening date, so nobody
  books a month ahead. Execs can open any date early from its page.
- One-tap sign-up: first time you enter your **name + email + optional phone/Instagram/photo**; the device remembers you.
- Pick **one or several lists** (e.g. volleyball in both slots) — the **4h bundle price** applies automatically. Prices are shown once, in one recap line.
- Choose **e-transfer or cash**, and see exactly how much to send and to which email.
- Full lists automatically become a **waitlist**. When a spot frees up, the first person in line is **promoted automatically and emailed** (see automatic emails below).
- See who's signed up and, once execs set them, **which team everyone is on**.
- Switch the whole app to **Français** with the FR button (English is the default).

**For execs** (unlock with the club PIN — tap "Exec" in the header)
- Tap any player to **mark paid / check in / move lists / assign a team / bump to top / remove**.
- **Players directory**: every registered player with their name, email, phone,
  Instagram, photo, games played and unpaid count — searchable, exportable to CSV.
- **Teams**: give any list teams and assign players from their card. Players see
  the teams; only execs can change them. **Volleyball is capped at 4 teams of 7
  players max** (buttons show each team's count and lock when full); basketball
  and football rules can be added the same way once the club decides them.
- **Battle Pass** (volleyball season pass — 4h 135$ instead of 165$, 2h 75$ instead of 88$):
  execs activate it on a player from the Players directory (tap PASS to cycle
  none → 2h → 4h) or from the player's card. Pass holders show a "Battle Pass"
  tag instead of "unpaid" everywhere, count as paid, are skipped by payment
  reminders, and a 2h pass covers one volleyball slot per Saturday (playing
  both slots only charges the extra slot). The offer text on the home page is
  editable in Club settings.
- **Payments screen**: who paid, who didn't, expected amount per person (bundle-aware), totals collected and outstanding.
- **"Open the season"**: one tap creates an event for every remaining Saturday until the season end, copied from the latest event.
- Every past Saturday is kept automatically as a read-only **week-by-week record** (players, collected, outstanding).
- Add walk-ins, edit caps/prices/levels, close/reopen sign-ups, **export CSV** (includes emails and teams), edit club settings (e-transfer email, PIN, season end, policies…).

Everything updates **live** — all execs and players see the same lists in real time.

## Demo mode vs live mode

- **Demo mode** (default, zero setup): open `public/index.html` and everything runs
  with data stored in your own browser. Waitlist emails are simulated (you see the
  toast, no real email). Default exec PIN: `1234`.
- **Live mode**: connect a free Firebase project (below) and everyone shares the
  same realtime database.

## Going live — one-time setup (~15 minutes, free)

1. **Create a Firebase project**
   - Go to <https://console.firebase.google.com> → *Add project* (e.g. `crsc-app`).

2. **Enable Firestore**
   - *Build → Firestore Database → Create database* → *Production mode*, region
     `northamerica-northeast1` (Montréal).

3. **Register a web app & copy the config**
   - Project overview → *</> (Add app → Web)* → *Register*.
   - Paste the `firebaseConfig` object into
     [`public/firebase-config.js`](public/firebase-config.js) as
     `window.FIREBASE_CONFIG = { ... };`

4. **Publish the security rules and the site** — no command line needed
   - Rules: in the Firebase console open *Firestore Database → Rules*, paste the
     contents of [`firestore.rules`](firestore.rules) over what is there, and
     click **Publish**.
   - Site: in the GitHub repo open *Settings → Pages* and set *Source* to
     **GitHub Actions**. [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
     then publishes `public/` on every push, so later changes go live on their own,
     about a minute after they are pushed.
   - The club's app is then at
     `https://crscmtl.github.io/CRSC/` — put that link in the
     linktr.ee and Instagram bio.

   (The Firebase CLI — `npm install -g firebase-tools`, `firebase deploy` — is an
   alternative if you would rather host on Firebase, but it is not needed and not
   how this club runs it.)

5. **First run**
   - Open the site, tap **Exec**, enter the default PIN `1234`.
   - Open **Club settings**: change the PIN, check the e-transfer email,
     location, and **season end date**.
   - Tap **New event** (pre-filled Saturday template) → create it, then
     **Open the season** to fill every Saturday until the season end.

> Alternative hosting: `public/` is plain static files — drag-and-drop onto
> [Netlify](https://app.netlify.com/drop) or GitHub Pages also works.

## Automatic emails from the club Gmail (free, 5-minute setup)

Three emails are sent automatically, **from the club's own Gmail** — the same
account that receives the e-transfers (`concordiaRSclub@gmail.com`):

1. **Sign-up confirmation** — the moment someone registers: their lists, total,
   and how to pay, in the language (EN/FR) they signed up in.
2. **Payment reminder** — in the 24 hours before the event, everyone still
   marked unpaid gets one reminder with their exact amount. (A static site has
   no scheduler, so the check runs whenever anyone has the app open in that
   window — in practice players and execs open it constantly on game day. Each
   person is flagged after sending, so nobody gets it twice.)
3. **Waitlist promotion** — when a spot frees up, the person moving off the
   waitlist is told they're confirmed.

Setup, done while logged into the club Gmail:

1. Go to <https://script.google.com> → **New project**, and replace the code with:

   ```js
   const SECRET = 'change-me-to-something-random';

   function doPost(e) {
     const d = JSON.parse(e.postData.contents);
     if (d.secret !== SECRET) {
       return ContentService.createTextOutput('forbidden');
     }
     MailApp.sendEmail({
       to: d.to,
       subject: d.subject,
       body: d.message,
       name: 'CRSC',
     });
     return ContentService.createTextOutput('ok');
   }
   ```

2. Change `SECRET` to something random and save.
3. **Deploy → New deployment → Web app**: *Execute as: Me*, *Who has access:
   Anyone* → authorize when asked → copy the **web app URL**.
4. Put the URL and the same secret into `window.MAILER` in
   [`public/firebase-config.js`](public/firebase-config.js) and redeploy the site.

Quota: a normal Gmail account can send ~100 emails/day through Apps Script —
comfortable for a weekly event. If the mailer isn't configured, everything
still works; the app just shows a toast that the email was skipped. Phone
numbers are collected for the exec's reference only (automatic SMS would
require a paid service like Twilio).

One honest caveat: the secret sits in the site's JavaScript, so a determined
person could use the mailer to send emails from the club account (capped at
the daily quota). That matches the app's overall trust level; rotate the
secret in both places if it's ever abused.

## Automatic e-transfer matching (kills the manual payment checking)

A second Apps Script in the club Gmail ([`apps-script/payment-matcher.gs`](apps-script/payment-matcher.gs),
setup instructions inside the file) checks every 15 minutes for Interac
"sent you money" notification emails and records the sender's name, the
amount, and the message they typed with the transfer.

Most of those then mark themselves paid, with no exec involved. The matching
rules live in [`public/js/automatch.js`](public/js/automatch.js) and a
transfer has to satisfy both before anything is marked:

1. **Every name resolves to exactly one unpaid player.** Accents and
   capitals are ignored, so `ANAIS COTE` finds Anaïs Côté. Three Omars on
   the list and a transfer that just says `OMAR` resolves to nobody.
2. **The money adds up to the cent.** The named players' outstanding totals
   must equal the amount sent — Battle Pass coverage, bundles and late fees
   included, since those are what they actually owe.

This is what handles one person paying for several: the club's players
routinely write *"for me and Marc"* in the transfer message, so the message
is matched against the roster the same way the sender's name is. `JUAN BEGA`
sending $16 with *"volleyball for me and Anais Cote"* marks both of them paid.
Phrasing does not matter and neither does language — names are found by
looking them up, not by parsing sentences.

A transfer only applies when **exactly one** Saturday reconciles. Someone who
owes $20 this week and $20 last week is a question for a human, not a guess.

Everything else stays on the exec **Payments** screen under "Received
e-transfers — match to a player", best guess pre-selected, ✓ to confirm and
✕ to dismiss; the Payments button shows a count whenever transfers are
waiting. Automatic matches are listed separately under "Matched
automatically" with the sender and their message, and **↺ undoes one** — that
puts the transfer back on the review list and permanently stops the matcher
from claiming it again, so an exec's correction is never overwritten.

(The outgoing mailer lives in [`apps-script/mailer.gs`](apps-script/mailer.gs).)

## One spot per time slot, and changing it

A player can hold **one list per time slot**. Two names at 7:30 is one body
in two places: a confirmed spot the club cannot fill and a head it counts
twice. Two *different* slots are fine and expected — that is the 4h
volleyball bundle, and it is also basketball at 5:30 then volleyball at 7:30.

The sign-up sheet enforces it as you go: ticking a second list in a slot
unticks the first and says why, and a slot already taken shows "already in
this time slot" rather than quietly vanishing. Submitting re-checks, because
a disabled checkbox is a hint and not a guarantee.

**Change** on each of your spots moves you to another sport or hour without
leaving the event. Removing and re-joining did work, but it filed a removal
against the player in the proof trail — the record that exists to show who
walked away from a game they owed for — and switching lists is not that. The
new list takes you at the end, since the people on it were there first, and
the spot you leave promotes whoever was next on its waitlist.

## Playing levels

Volleyball is graded in four steps — **Intermediate**, **Advanced**,
**Adv + Mixed**, **Advanced +** — and an exec assigns a player's grade from
the same place they set a season pass.

A brand-new member is ungraded and may sign up wherever they like: the club
decides where somebody belongs after seeing them play, not before. Once
graded, a player can sign **themselves** up for their level **and anything
below it**. Higher levels stay visible on the sign-up sheet but locked, with
"ask an exec" beside them — hiding them would only prompt "where did
Advanced + go?", and this way the player can see the game exists and knows
who to ask.

Execs are never gated. Placing somebody by hand is exactly how a player moves
up, and `+ ADD PLAYER` and **Move to** both ignore the grade.

Basketball and football are ungraded: their "Mixed" and "Men" lists are about
who plays together, not how well.

The grade is **exec-only**, like payment status — it is the club's note about
a player, not a badge for the room to read. Each list carries its own
`level` (1–4) so the grading can be changed per event without touching code.

Like the exec PIN, this is a convenience gate rather than a security control:
it lives in the page, so it keeps honest people in the right game rather than
stopping a determined one.

## Season pass (Battle Pass)

A volleyball season pass: **4h $135** (instead of $165) or **2h $75** (instead
of $88). Two things happen on their own.

**Buying one tags it.** An e-transfer for exactly a pass price is read as
buying a pass, not paying for a night — the amounts are nothing like a game
fee, so the amount alone says what it is. If the sender resolves to exactly
one registered player, their pass is set and the payment is filed as such. It
is never spent on a single night's game fee.

**The spot is standing.** Pass holders paid for a season, so their seat is
held every Saturday: when an exec sets the pass they also pick **which lists**
the seat lives in (a 2h pass holds one; a 4h pass can hold one in each time
slot), and from then on every new Saturday seats them there automatically,
above the walk-up queue so a midnight rush cannot push them onto the waitlist.

If a pass holder cannot come, an exec removes their name for that week and it
**stays** removed — the seating only ever adds a missing spot, it never
re-adds one somebody took off on purpose.

## Amounts that are not the list price

Tapping **Mark paid** settles the list price and stays one tap, because that
is nearly every payment. Underneath it, **"Received a different amount?"**
records what was actually handed over, for the ones that are not: $5 against
an $8 bill, a $20 note for a $15 bundle, cash that does not divide neatly.

Recorded cash counts against the person's whole night, not the one spot it
was typed on — so somebody on two lists who hands over $20 is settled
everywhere, and the club is not chasing them for a spot whose tick box was
never checked. A part-payment shows on the roster as **"3$ short"**, never as
unpaid: real money came in, and an exec reading the list should see that.

The remainder flows everywhere the full price used to: the reminder emails,
the money-owed screen, the season CSV, and the dues the Gmail matcher reads —
so a player who has part-paid is expected to transfer only what is left.

## Finding one person

Execs get **Find player** on every event: one box that searches every list at
once by name, @handle, email or phone, and opens that person's row controls
straight from the result. Accents and capitals are ignored — `cote` finds
Anaïs Côté, which matters when you are typing one-handed at the door. The
same search covers the whole club in the **Players** directory.

## Testing the payment pipeline

A transfer for exactly **$1** (`testAmount`) is treated as a test: it appears
on the Payments screen showing everything the club parsed out of it — sender,
amount, message — and **never marks anyone paid**. It exists so the club can
watch a real e-transfer travel Gmail → database → screen without moving real
money or touching a real player's record.

## Marking people paid without anyone watching

The Gmail script does the whole job on its own, every 15 minutes: it reads
new Interac notifications, files them, and **settles the ones that are
unambiguous** — marking people paid and emailing them a receipt — with nobody
signed in anywhere.

Pricing is not duplicated to make that work. Season passes, both-slot
bundles, late fees and part-paid evenings are intricate, and a second copy of
those rules inside a Google Apps Script would drift out of sync the first time
a price changed. So the app publishes the **answer** instead: a `dues/{eventId}`
document listing who owes what, refreshed whenever the night changes — which
is precisely when someone is looking at it (signing up, being marked paid,
gaining a pass). The matcher only reads names and adds up numbers.

The two matching rules are identical on both sides and
`scripts/parity-check` compares them case by case, because two matchers that
disagree would be worse than one. The app still settles anything the script
left behind the moment an exec opens it.

## The four automatic emails

All sent from the club's own Gmail, each in the language the player signed up
in, and each sent once (claimed on the sign-up before sending, so two execs'
open tabs cannot double-send).

| When | Email |
|---|---|
| They sign up | You're on the list, what you owe, how to pay |
| 24h before, through game day | Payment reminder, if still unpaid |
| A spot frees up | You're off the waitlist and confirmed |
| Their money is matched | **Payment received** — receipt, nothing left to do |

The receipt is the half that makes automatic matching visible: without it a
player e-transfers, hears nothing, and asks an exec anyway. It says the right
thing for who is reading — someone who sent $16 for two people sees $16 and
who it covered; the person they paid for is told who covered them, not that
"their payment" arrived. Buying a season pass gets its own receipt explaining
that their spot is now held every week.

## Past Saturdays are the club's record

Nothing is ever deleted. Every Saturday that has been played stays in the
database with its full roster — who was on which list, who paid and how, who
was checked in, who took their name off — and execs reach it two ways: the
**week by week** list on the home screen (date, players, collected, unpaid)
and the event itself, which opens exactly as it did on the night.

Players never see past weeks. A finished Saturday is the club's record, not
a sign-up sheet — and it reads like one. Opening a played Saturday as an exec
leads with what the night came to (signed up, showed up, no-shows, collected,
outstanding), then the people who held a spot and never checked in, then
everyone who took their name off, with the proof-trail flags intact. The
rosters below carry the rest: every name, their level, whether they paid and
whether they were here. Nothing is behind a modal any more, and the lists say
"12 played" rather than offering spots on a night that is over.

Three things protect it:

- **A played Saturday cannot be deleted.** The editor refuses outright once a
  past event has sign-ups recorded on it, rather than asking a question one
  mistaken tap answers wrongly.
- **Every past week loads, not just the recent ones.** The home screen used
  to fetch the twelve most recent, so in a fifteen-week season the earliest
  weeks reported "0 players, 0$ collected" — indistinguishable from a night
  nobody came to. A week whose roster has not arrived yet now says so.
- **The whole season exports to one CSV**, removals included, for handover to
  next year's execs or any question that outlives the app.

## Removal log (proof trail)

Taking a name off a list frees the spot, so the sign-up itself has to go —
but a permanent record is kept: who, which list, when, whether it was the
player or an exec who removed it, and whether they had been **checked in**.

The exec **Payments** screen shows "Removed their name" for each event. A
removal is flagged in red — **WAS CHECKED IN** (or *removed after the game
started*) plus **still owes $X** — when the person was marked present, never
paid, and then came off the list. That is the proof the club needs to still
ask for payment. The Players directory shows a per-player count ("2 played
then removed"), and both CSV exports include the removals.

Two protections work together: the cancellation lock stops players from
removing themselves on game day at all, and the log catches everything else
(exec removals, early removals by someone who shows up anyway). In Firestore
the log is append-only — records can be created and read, never edited or
deleted from the app.

## Cancellation lock & automatic late fee

- Players cannot remove themselves in the final **24 hours** before a game
  (they see "contact an exec"); execs can always remove anyone. The window is
  the `cancelLockHours` setting.
- Once a Saturday has passed, anyone still unpaid automatically owes the
  **late fee** (default +5$, editable in Club settings) — reflected in the
  payments screen, weekly records, and totals.

## Weekly exec workflow

1. Once per season: **Open the season** — every Saturday is bookable from day one.
2. Players pick their Saturdays from the calendar all season long.
3. E-transfers record themselves — open *Payments* and tap ✓ to confirm each match.
4. Saturday afternoon: assign **teams** on each volleyball list.
5. At the gym: tap players → *Check in*; collect cash → *Mark paid*.
6. The *Payments* screen shows who still owes what; past weeks archive themselves.

## Notes & limits (honest ones)

- **Security model**: the exec PIN is a convenience gate, like the club's current
  public Google Sheet — anyone determined could edit data via the API. Same trust
  level the club already operates on, with better structure and history. The
  upgrade path is Firebase Auth with per-exec accounts and stricter rules.
- **Payments** are *tracked*, not *processed* — the club is not a registered
  business, so there is no card checkout. Players declare cash/e-transfer and
  execs confirm.
- **Promotion emails** are sent by whichever device performs the removal (player
  cancelling or exec removing). If that device is offline the email is skipped —
  the promotion itself still happens because positions are recomputed live.
- **Photos** are downscaled to tiny thumbnails (~5 KB) stored inline in
  Firestore — no file storage setup needed.
- Firebase's free tier (50k reads / 20k writes per day) is far beyond a weekly
  ~100-player event, even with the whole season open.

## Project structure

```
public/
  index.html            app shell (loads Barlow / Barlow Condensed fonts)
  css/styles.css        styles
  js/store.js           data layer (localStorage demo store + Firestore store)
  js/app.js             UI: calendar, sign-up flow, teams, exec tools
  js/i18n.js            English/French strings (English primary)
  js/notify.js          mailer client + promotion/reminder logic
  firebase-config.js    Firebase + club mailer config (null = demo mode)
firebase.json           Firebase Hosting + rules wiring
firestore.rules         Firestore security rules
```

No build step, no npm dependencies — plain HTML/CSS/JS, easy for any exec to tweak.

## App or website?

It's a website that behaves like an app. It ships a web-app manifest and icons,
so on a phone players can use "Add to Home Screen" (Share menu on iOS, browser
menu on Android) and it opens full-screen with its own CRSC icon, like a native
app — no app store, no installs to maintain, and every update is live for
everyone the moment it's deployed.
