/**
 * CRSC — automatic e-transfer matcher.
 *
 * Runs INSIDE THE CLUB GMAIL (the account that receives the e-transfers).
 * Every 15 minutes it looks for new Interac e-Transfer notification emails
 * and records the sender's name, the amount, and the message they typed with
 * the transfer. The app reads those rows and marks people paid on its own
 * when the names and the money both add up — including when one person sends
 * for a group and lists everyone in the message, which is why the message is
 * captured and not just the amount. Anything that does not reconcile is left
 * on the exec Payments screen to confirm by hand.
 *
 * SETUP (~5 minutes, while logged into the club Gmail):
 *  1. Go to https://script.google.com → New project → paste this file.
 *  2. In the toolbar pick the function `checkTransfers` and press Run once →
 *     authorize Gmail access when asked.
 *  3. Left sidebar → Triggers (alarm-clock icon) → Add Trigger:
 *     function `checkTransfers` · event source "Time-driven" ·
 *     "Minutes timer" · "Every 15 minutes" → Save.
 *
 * Notes:
 *  - Each email is recorded once (the Gmail message id is the database key,
 *    so re-running never duplicates).
 *  - Only notification emails from interac.ca are read; nothing else in the
 *    inbox is touched.
 */

var PROJECT_ID = 'crsc-8fec4';
var API_KEY = 'AIzaSyB7tE4RwcQgmAIIxdyISjQwbamEDmts_hQ';

// The amounts that mean something other than one night's game fee: the test
// dollar, and the two season-pass prices. They are read from the club's own
// settings in the database, so changing a price in the app changes it here
// too — they used to be written down twice and could drift apart silently.
// The numbers below are only the fallback if the settings cannot be read.
var FALLBACK = { testAmount: 1, passPrice4h: 135, passPrice2h: 75,
                 etransferEmail: '', clubFullName: 'CRSC', lateFeeNote: '', lateFeeAmount: 5,
                 // If the settings cannot be read at all, do not settle anybody.
                 autoMatch: 'off' };

function clubSettings() {
  try {
    var doc = JSON.parse(UrlFetchApp.fetch(fsUrl('config/main'),
      { muteHttpExceptions: true }).getContentText() || '{}');
    if (!doc.fields) return FALLBACK;
    var n = function (k) {
      var v = val(doc, k);
      return (v === null || v === undefined || v === '') ? FALLBACK[k] : Number(v);
    };
    return {
      testAmount: n('testAmount'), passPrice4h: n('passPrice4h'), passPrice2h: n('passPrice2h'),
      etransferEmail: val(doc, 'etransferEmail') || '',
      clubFullName: val(doc, 'clubFullName') || 'CRSC',
      lateFeeNote: val(doc, 'lateFeeNote') || '',
      lateFeeAmount: Number(val(doc, 'lateFeeAmount')) || 0,
      autoMatch: val(doc, 'autoMatch') === 'on' ? 'on' : 'off',
    };
  } catch (e) {
    return FALLBACK;
  }
}

/*
 * Banks do not agree on how to word a transfer notification. The sender may
 * be Interac itself or the member's own bank; the subject may name the sender
 * before "sent you", after "from", or not at all. Real notifications arriving
 * in the club's inbox were matched by none of the original patterns, so the
 * search is deliberately wide and the sender is looked for in several shapes
 * before giving up — an unrecognised email costs a person being marked unpaid
 * when they have paid, which is the expensive direction to fail.
 */
function checkTransfers() {
  var threads = GmailApp.search(
    'newer_than:7d (from:(interac.ca) OR from:(payments.interac.ca) OR ' +
    'subject:(interac) OR subject:(virement) OR subject:("e-transfer") OR ' +
    'subject:("sent you money") OR subject:("vous a envoyé"))');
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      var subject = msg.getSubject() || '';
      var body = msg.getPlainBody() || '';
      var sender = findSender(subject, body, msg.getFrom());
      if (!sender) return;
      record(msg.getId(), sender, findAmount(subject, body), message(body), msg.getDate());
    });
  });
  // Filing the transfers is only half the job — settle the ones that are
  // unambiguous right now, so nobody has to open the app for it to happen.
  settleTransfers();
  // And chase the people who have not paid. This used to run inside the app,
  // which meant a Friday with nobody opening it was a Friday with no
  // reminders. It belongs next to the thing that already runs unattended.
  sendReminders();
}

/* ====================================================================
 * Payment reminders
 *
 * Three of them: three nights before the game, the night before, and on the
 * day. Only the most urgent one that applies is sent, and each at most once
 * — somebody who first shows up in the list on Saturday morning gets "you
 * play today" rather than all three at once.
 *
 * Everything needed is in the `dues` record the app publishes: who owes,
 * how much, their address and their language. What has already gone out is
 * kept in `reminders/{eventId}`, so this is the only thing that sends and
 * nobody can be chased twice by two different machines.
 * ==================================================================== */

function sendReminders() {
  var cfg = clubSettings();
  listDocs('dues').forEach(function (night) {
    var eventId = night.name.split('/').pop();
    var date = val(night, 'date');
    var stage = reminderStage(date);
    if (!stage) return;

    var people = (val(night, 'people') || []).filter(function (p) {
      return p.email && Number(p.owed) > 0;
    });
    if (!people.length) return;

    var sentDoc = getDoc('reminders/' + eventId);
    var sent = (sentDoc && val(sentDoc, stage)) || [];
    var fresh = people.filter(function (p) { return sent.indexOf(p.email) < 0; });
    if (!fresh.length) return;

    /*
     * Claim before sending, and only send if the claim stuck.
     *
     * Recording it afterwards looks tidier and is a trap: if the write is
     * refused — the rules for this collection not published yet, say —
     * nothing is remembered, and fifteen minutes later the same people are
     * emailed again. And again. The cost of getting this backwards is
     * everybody who owes money being chased four times an hour until
     * somebody notices.
     *
     * So the worst case here is a reminder that never arrives, rather than
     * one that arrives thirty times.
     */
    var fields = {};
    fields[stage] = strList(sent.concat(fresh.map(function (p) { return p.email; })));
    fields.date = str(date);
    if (!patch('reminders/' + eventId, fields, [stage, 'date'])) return;

    fresh.forEach(function (p) {
      try {
        reminderMail(p, date, stage, val(night, 'location') || '', cfg);
      } catch (e) { /* one bad address must not stop the rest */ }
    });
  });
}

/*
 * Which reminder is due for a Saturday, counted in nights rather than hours
 * because that is how the email reads: Friday lunchtime is "tomorrow" to a
 * person and twenty-nine hours to a clock. Mirrors reminderStage() in
 * public/js/notify.js.
 */
function reminderStage(date) {
  if (!date) return '';
  var parts = date.split('-');
  var start = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 17, 0, 0);
  var now = new Date();
  if (now > start) return '';                       // the game has started
  var a = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  var b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  var days = Math.round((a - b) / 86400000);
  if (days === 0) return 'soon';
  if (days === 1) return 'day';
  if (days === 2 || days === 3) return 'three';
  return '';
}

function lateFeeLine(cfg, fr) {
  if (cfg.lateFeeNote) return cfg.lateFeeNote;
  if (!cfg.lateFeeAmount) return '';
  return fr ? 'À noter : un paiement après l’événement coûte ' + cfg.lateFeeAmount + '$ de plus.'
            : 'Heads up: payment after the event costs an extra ' + cfg.lateFeeAmount + '$.';
}

function reminderMail(p, date, stage, location, cfg) {
  var fr = p.lang === 'fr';
  var owed = Number(p.owed) + '$';
  var club = cfg.clubFullName || 'CRSC';
  var pay = fr
    ? 'Virez ' + owed + ' à ' + cfg.etransferEmail + ' en mentionnant votre nom, ou payez comptant sur place.'
    : 'E-transfer ' + owed + ' to ' + cfg.etransferEmail + ' with your name in the message, or pay cash at the door.';
  var late = lateFeeLine(cfg, fr);
  var where = location ? ((fr ? 'Où : ' : 'Where: ') + location + '\n\n') : '';
  var subject, open, tail;

  if (stage === 'three') {
    subject = fr ? 'CRSC — Le ' + date + ' approche' : 'CRSC — ' + date + ' is coming up';
    open = fr ? 'Vous êtes sur la liste pour le ' + date + ' et il reste ' + owed + ' à payer.'
              : 'You\'re on the list for ' + date + ' and ' + owed + ' is still to pay.';
    tail = fr ? 'Finalement vous ne pouvez pas venir? Retirez votre nom sur la page d\'inscription pour qu\'une personne de la liste d\'attente puisse jouer.'
              : 'Can\'t make it after all? Take your name off on the sign-up page so somebody on the waitlist can play.';
  } else if (stage === 'day') {
    subject = fr ? 'CRSC — Vous jouez demain (' + date + ')' : 'CRSC — You play tomorrow (' + date + ')';
    open = fr ? 'Vous jouez demain, le ' + date + ', et ' + owed + ' reste à payer.'
              : 'You play tomorrow, ' + date + ', and ' + owed + ' is still unpaid.';
    tail = fr ? 'Déjà payé? Ignorez ce message — un exec le confirmera sous peu.'
              : 'Already paid? Ignore this — an exec will confirm it shortly.';
  } else {
    subject = fr ? 'CRSC — Vous jouez aujourd\'hui : ' + owed + ' à régler'
                 : 'CRSC — You play today: ' + owed + ' to settle';
    open = fr ? 'Vous jouez ce soir et ' + owed + ' reste à payer.'
              : 'You play tonight and ' + owed + ' is still unpaid.';
    tail = fr ? 'En arrivant au gymnase, ouvrez la page d\'inscription et touchez « Je suis là ».'
              : 'When you get to the gym, open the sign-up page and tap "I\'m here" to check in.';
  }

  MailApp.sendEmail({
    to: p.email,
    subject: subject,
    body: (fr ? 'Salut ' : 'Hey ') + p.name + '!\n\n' + open + '\n\n' + pay +
          (late ? '\n\n' + late : '') + '\n\n' + where + tail + '\n\n— ' + club,
  });
}

/*
 * The note the sender typed. Interac labels it "Message:" in English and
 * "Message :" in French, sometimes with the sender's name in between. Capped
 * well short of a paragraph — it is read for names, not stored as mail.
 */
/*
 * Who sent the money. Tried against the subject first, then the body, in the
 * wordings Canadian banks actually use in English and French.
 */
function findSender(subject, body, from) {
  var patterns = [
    // What the club's own inbox actually receives. Every one of these was
    // read off a real notification, not out of Interac's documentation:
    //   "Virement Interac : Vous avez reçu 8,00 $ de JOHNNY HOANG et ce
    //    montant a été déposé automatiquement."
    /Vous avez re[çc]u[^$]*\$\s*de\s+(.+?)\s+et ce montant/i,
    /You(?:'ve| have)? received[^$]*\$?[\d.,\s]*\s*from\s+(.+?)\s+and (?:the|this)/i,
    // The body spells it out twice more, and both are unambiguous.
    /Envoy[ée] par\s*:\s*(.+)/i,
    /Sent by\s*:\s*(.+)/i,
    /au nom de\s+(.+?)\s+[àa] la\s/i,
    /on behalf of\s+(.+?)\s+at\s/i,
    // Interac's documented wordings, kept for banks that use them.
    /INTERAC e-Transfer:?\s*(.+?)\s+sent you/i,
    /Virement INTERAC\s*:?\s*(.+?)\s+vous a envoy/i,
    /^(.+?)\s+sent you (?:money|\$)/i,
    /(.+?)\s+vous a envoyé/i,
    /money from\s+(.+?)(?:\s+has|\s*[.!,]|$)/i,
    /argent de\s+(.+?)(?:\s*[.!,]|$)/i,
    /transfer from\s+(.+?)(?:\s*[.!,]|$)/i,
    /de la part de\s+(.+?)(?:\s*[.!,]|$)/i,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = subject.match(patterns[i]) || body.match(patterns[i]);
    if (m && m[1]) {
      var name = m[1].replace(/["'\u201c\u201d]/g, '').trim();
      // A greedy capture runs past the name into the rest of the sentence
      // ("Rayan Sedraoui was auto-deposited"), so cut it at the first word
      // that can only be the sentence continuing, not part of a name.
      name = name.split(/\s+(?:was|has|have|is|a été|vous|to|into|on|for|and|et)\b/i)[0].trim();
      // A plausible human name, not a stray sentence fragment.
      if (name.length >= 2 && name.length <= 60 && !/\d{3}/.test(name)) return name;
    }
  }
  /*
   * Last resort: the display name on the From header, which on these
   * notifications is the payer rather than the bank —
   * "JOHNNY HOANG <notify@payments.interac.ca>".
   *
   * Last, because a bank that sends as "Interac" or "RBC Alerts" would
   * otherwise have every transfer filed under the bank's name. Anything
   * that looks like the service rather than a person is refused.
   */
  var disp = String(from || '').split('<')[0].replace(/["']/g, '').trim();
  if (disp.length >= 2 && disp.length <= 60 && !/\d{3}/.test(disp)
      && !/interac|virement|e-?transfer|notif|alert|bank|banque|desjardins|scotia|rbc|bmo|cibc|td\b/i.test(disp)) {
    return disp;
  }
  return '';
}

/*
 * How much arrived.
 *
 * Canadian French puts the figure before the sign and uses a comma —
 * "8,00 $" — where English puts it after and uses a point: "$8.00". The
 * original only knew the English shape, so every French notification the
 * club receives was read as zero, which is why three real payments from
 * the first Saturday were skipped without a word.
 *
 * The body states it plainly ("Montant : 10,00 $ (CAD)"), so that is tried
 * first, and the subject second.
 */
function findAmount(subject, body) {
  var patterns = [
    /Montant\s*:\s*([\d\s\u00a0\u202f.,]+)\s*\$/i,   // Montant : 10,00 $
    /Amount\s*:\s*\$\s*([\d\s,.]+)/i,                  // Amount: $10.00
    /([\d\u00a0\u202f][\d\s\u00a0\u202f.,]*)\s*\$/,  // 8,00 $
    /\$\s*([\d,]+(?:[.,]\d{2})?)/,                       // $8.00
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = body.match(patterns[i]) || subject.match(patterns[i]);
    if (!m) continue;
    var n = parseAmount(m[1]);
    if (n > 0) return n;
  }
  return 0;
}

/* "1 234,56" and "1,234.56" are the same number written two ways. */
function parseAmount(raw) {
  var t = String(raw).replace(/[\s\u00a0\u202f]/g, '');
  // Whichever separator comes last is the decimal point.
  var lastComma = t.lastIndexOf(','), lastDot = t.lastIndexOf('.');
  if (lastComma > lastDot) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  var n = parseFloat(t);
  return isNaN(n) ? 0 : n;
}

function message(body) {
  var m = body.match(/Message(?:\s+(?:from|de)\s+[^:]{0,60})?\s*:\s*(.+)/i);
  return m ? m[1].trim().slice(0, 200) : '';
}

function record(id, sender, amount, note, date) {
  var url = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID +
    '/databases/(default)/documents/payments?documentId=' + encodeURIComponent(id) +
    '&key=' + API_KEY;
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true, // 409 ALREADY_EXISTS = recorded before, fine
    payload: JSON.stringify({
      fields: {
        sender: { stringValue: sender },
        amount: { doubleValue: amount },
        message: { stringValue: note },
        receivedAt: { integerValue: String(date.getTime()) },
        matched: { booleanValue: false },
      },
    }),
  });
}

/* ==================================================================== *
 * Settling: mark people paid, without anyone having the app open.
 *
 * The app publishes what each person still owes for each open night (the
 * `dues` collection). All of the pricing — season passes, both-slot
 * bundles, late fees — is decided there and only there, so nothing below
 * has to know a single price. This reads names and adds up numbers.
 *
 * The two rules match the app's exactly, and both must hold:
 *   1. every name in the transfer lands on exactly one person who owes
 *   2. what those people owe equals the amount sent, to the cent
 * Anything else is left for an exec on the Payments screen.
 * ==================================================================== */

function settleTransfers() {
  /*
   * Off unless the club has deliberately switched it on.
   *
   * On the first busy Saturday this credited the wrong people. With sixty
   * names on a list instead of twelve, one shared word is not evidence:
   * ALEXA DE VILLA settled Arthur Huon de Penanster on "de", HUGO HE
   * settled He, Yu Chen on "he". It also spent payments from games already
   * played against the coming one.
   *
   * Reading the mail was always the valuable half. checkTransfers still
   * records every transfer with its sender, amount and message, and the
   * Payments screen still shows them. Deciding whose money it is turned out
   * to need a person.
   */
  if (clubSettings().autoMatch !== 'on') return;
  var pending = listDocs('payments').filter(function (p) {
    return !val(p, 'matched') && !val(p, 'noAuto');
  });
  if (!pending.length) return;

  var dues = listDocs('dues').map(function (d) {
    return {
      eventId: d.name.split('/').pop(),
      date: val(d, 'date'),
      people: (val(d, 'people') || []).map(function (p) {
        return { name: p.name, owed: Number(p.owed), ids: p.ids || [], email: p.email || '', lang: p.lang || 'en' };
      }),
    };
  });

  var cfg = clubSettings();
  pending.forEach(function (pay) {
    var amount = cents(val(pay, 'amount'));
    if (amount <= 0 || amount === cents(cfg.testAmount)) return;   // $1 = pipeline test
    if (amount === cents(cfg.passPrice4h) || amount === cents(cfg.passPrice2h)) return; // pass: the app tags it

    var sender = val(pay, 'sender') || '';
    var text = sender + ' ' + (val(pay, 'message') || '');
    var hits = [];
    dues.forEach(function (night) {
      var all = resolve(text, night.people);
      if (!all || !all.length) return;        // names collide, or nobody named
      // The whole group first — that is the "paying for my friends" case the
      // message is there to describe. Falling back to the sender alone covers
      // a message that happens to name someone not being paid for.
      var sets = [all];
      var justSender = resolve(sender, night.people);
      if (justSender && justSender.length) sets.push(justSender);
      for (var i = 0; i < sets.length; i++) {
        var owed = sets[i].reduce(function (a, p) { return a + cents(p.owed); }, 0);
        if (owed === amount) { hits.push({ night: night, people: sets[i], exact: true }); return; }
      }
      // Not what is owed, but pointing at ONE person: record the amount and
      // let the screen work out what is left. With a group there is no
      // honest way to split a figure that does not add up, so that waits for
      // an exec. Mirrors resolvePayment() in public/js/automatch.js.
      if (all.length === 1) hits.push({ night: night, people: all, exact: false });
    });
    if (hits.length !== 1) return;   // nothing certain, or certain on two nights

    var night = hits[0].night, people = hits[0].people, exact = hits[0].exact;
    var names = people.map(function (p) { return p.name; });
    // What each of them owes once this transfer is applied, keyed by sign-up
    // id rather than by name because two members share a name often enough.
    var settled = {};
    people.forEach(function (p) {
      if (exact) {
        p.ids.forEach(function (id) {
          patch('events/' + night.eventId + '/signups/' + id,
            { paid: bool(true), paidAt: int(Date.now()), paidVia: str('auto-gmail'), paidEmailSentAt: int(Date.now()) },
            ['paid', 'paidAt', 'paidVia', 'paidEmailSentAt']);
        });
        if (p.ids.length) settled[p.ids[0]] = 0;
      } else if (p.ids.length) {
        // The whole amount on one row; the app sums what a person paid
        // across their spots, so it does not matter which.
        //
        // Somebody who rounded up — $10 on an $8 spot — owes nothing now,
        // so they are as settled as an exact payer and hear the same thing.
        // Claim paidEmailSentAt in the same write, or an exec opening the
        // player afterwards would send a second receipt.
        var covers = amount >= cents(p.owed);
        var fields = { amountPaid: dbl(Number(val(pay, 'amount')) || 0), paidAt: int(Date.now()), paidVia: str('auto-gmail') };
        var mask = ['amountPaid', 'paidAt', 'paidVia'];
        if (covers) { fields.paidEmailSentAt = int(Date.now()); mask.push('paidEmailSentAt'); }
        patch('events/' + night.eventId + '/signups/' + p.ids[0], fields, mask);
        settled[p.ids[0]] = covers ? 0 : (cents(p.owed) - amount) / 100;
        if (covers) receipt(p, pay, night, names);
      }
      if (exact) receipt(p, pay, night, names);
    });
    trimDues(night, settled);
    patch('payments/' + pay.name.split('/').pop(),
      { matched: bool(true), matchedTo: str(names.join(', ')), matchedEvent: str(night.eventId),
        auto: bool(true), matchedAt: int(Date.now()), kind: str(exact ? 'full' : 'partial') },
      ['matched', 'matchedTo', 'matchedEvent', 'auto', 'matchedAt', 'kind']);
  });
}

/*
 * Take the people this transfer just paid for off the "who owes" list.
 *
 * The app owns `dues` and republishes it on every change — but only from a
 * browser that has the page open. Nobody has one open at three in the
 * morning, which is exactly when a transfer gets filed. Without this the
 * list still says these people owe, and the next reminder chases them for
 * money they have already sent. Being told you owe $8 you paid on Tuesday
 * is the kind of thing that sends somebody back to asking an exec.
 *
 * Whatever the app publishes next overwrites this, so it only has to hold
 * until somebody opens the page. The local copy is trimmed too, so a second
 * transfer in the same run cannot settle the same person twice.
 */
function trimDues(night, settled) {
  var kept = [], changed = false;
  (night.people || []).forEach(function (p) {
    var key = (p.ids || [])[0];
    var owed = (key && settled.hasOwnProperty(key)) ? settled[key] : Number(p.owed);
    // A part payment leaves them owing less, not nothing — the reminder has
    // to quote the new figure, so this counts as a change even though the
    // person stays on the list.
    if (owed !== Number(p.owed)) changed = true;
    if (!(owed > 0)) return;
    kept.push({ name: p.name, owed: owed, ids: p.ids || [], email: p.email || '', lang: p.lang || 'en' });
  });
  if (!changed) return;
  night.people = kept;
  patch('dues/' + night.eventId, { people: duesPeople(kept) }, ['people']);
}

function duesPeople(list) {
  return { arrayValue: { values: list.map(function (p) {
    return { mapValue: { fields: {
      name: str(p.name),
      owed: dbl(p.owed),
      ids: strList(p.ids || []),
      email: str(p.email || ''),
      lang: str(p.lang || 'en'),
    } } };
  }) } };
}

/* Accents off, punctuation out — ANAIS COTE and Anaïs Côté are one name. */
function norm(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function words(s) {
  return norm(s).split(' ').filter(function (w) { return w.length >= 2; });
}
function cents(n) { return Math.round((Number(n) || 0) * 100); }

/*
 * Everyone named in the text: an array (empty when nobody is named), or
 * null when two people answer to the same words and nothing separates them.
 * Mirrors resolvePayment() in public/js/automatch.js.
 */
function resolve(text, people) {
  var set = {};
  words(text).forEach(function (w) { set[w] = true; });
  var hits = [];
  people.forEach(function (p) {
    var m = words(p.name).filter(function (w) { return set[w]; });
    if (m.length) hits.push({ person: p, matched: m, score: m.length });
  });
  // "Omar" and "Omar Khaled" both answer to "omar khaled"; the fuller name wins.
  hits = hits.filter(function (h) {
    return !hits.some(function (o) {
      return o !== h && o.score > h.score && h.matched.every(function (w) { return o.matched.indexOf(w) >= 0; });
    });
  });
  // Two people answering to the very same words: nothing separates them.
  var seen = {};
  for (var i = 0; i < hits.length; i++) {
    var key = hits[i].matched.slice().sort().join(' ');
    if (seen[key]) return null;
    seen[key] = true;
  }
  return hits.map(function (h) { return h.person; });
}

/* "We got your money" — sent from the club Gmail, in their own language. */
function receipt(person, pay, night, allNames) {
  if (!person.email) return;
  var fr = person.lang === 'fr';
  var sent = Number(val(pay, 'amount')) + '$';
  var others = allNames.filter(function (n) { return n !== person.name; });
  var sender = norm(val(pay, 'sender') || '');
  var isSender = words(person.name).some(function (w) { return sender.indexOf(w) >= 0; });
  var open;
  if (others.length === 0) {
    open = fr ? 'Nous avons reçu votre paiement de ' + sent + ' pour le ' + night.date + '. Tout est réglé — rien d’autre à faire.'
              : 'We received your payment of ' + sent + ' for ' + night.date + '. You’re all set — nothing else to do.';
  } else if (isSender) {
    open = fr ? 'Nous avons reçu votre paiement de ' + sent + ' pour le ' + night.date + ' — il couvrait vous et ' + others.join(', ') + '. Tout est réglé.'
              : 'We received your payment of ' + sent + ' for ' + night.date + ' — it covered you and ' + others.join(', ') + '. You’re all set.';
  } else {
    open = fr ? 'Votre place pour le ' + night.date + ' est payée — ' + val(pay, 'sender') + ' l’a couverte par virement. Tout est réglé.'
              : 'Your spot for ' + night.date + ' is paid — ' + val(pay, 'sender') + ' covered it with their e-transfer. You’re all set.';
  }
  MailApp.sendEmail({
    to: person.email,
    subject: fr ? 'CRSC — Paiement reçu pour le ' + night.date + ' ✓'
                : 'CRSC — Payment received for ' + night.date + ' ✓',
    body: (fr ? 'Salut ' : 'Hey ') + person.name + '!\n\n' + open +
      (fr ? '\n\nEn arrivant au gymnase, ouvrez la page d’inscription et touchez « Je suis là ».\n\n— CRSC'
          : '\n\nWhen you arrive at the gym, open the sign-up page and tap "I’m here".\n\n— CRSC'),
    name: 'CRSC',
  });
}

/* ---- Firestore REST helpers ---- */

function fsUrl(path) {
  return 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID +
    '/databases/(default)/documents/' + path + '?key=' + API_KEY;
}

function listDocs(collection) {
  var out = [], token = '';
  do {
    var url = fsUrl(collection) + '&pageSize=300' + (token ? '&pageToken=' + token : '');
    var res = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText() || '{}');
    (res.documents || []).forEach(function (d) { out.push(d); });
    token = res.nextPageToken || '';
  } while (token);
  return out;
}

/* Returns true when the write actually landed. Callers that are about to do
 * something irreversible — send an email — have to know. */
function patch(path, fields, mask) {
  var url = fsUrl(path) + mask.map(function (f) { return '&updateMask.fieldPaths=' + f; }).join('');
  var res = UrlFetchApp.fetch(url, {
    method: 'patch', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ fields: fields }),
  });
  return res.getResponseCode() === 200;
}

function str(v) { return { stringValue: String(v) }; }
function int(v) { return { integerValue: String(v) }; }
function bool(v) { return { booleanValue: !!v }; }
function dbl(v) { return { doubleValue: Number(v) || 0 }; }
function strList(arr) {
  return { arrayValue: { values: (arr || []).map(function (x) { return { stringValue: String(x) }; }) } };
}

/* One document, or null when it is not there yet. */
function getDoc(path) {
  var res = UrlFetchApp.fetch(fsUrl(path), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  try { return JSON.parse(res.getContentText() || '{}'); } catch (e) { return null; }
}

/* Firestore's typed JSON back into plain values. */
function val(doc, field) {
  var f = (doc.fields || {})[field];
  return f === undefined ? undefined : decode(f);
}
function decode(f) {
  if ('stringValue' in f) return f.stringValue;
  if ('integerValue' in f) return Number(f.integerValue);
  if ('doubleValue' in f) return Number(f.doubleValue);
  if ('booleanValue' in f) return f.booleanValue;
  if ('nullValue' in f) return null;
  if ('arrayValue' in f) return (f.arrayValue.values || []).map(decode);
  if ('mapValue' in f) {
    var o = {};
    Object.keys(f.mapValue.fields || {}).forEach(function (k) { o[k] = decode(f.mapValue.fields[k]); });
    return o;
  }
  return undefined;
}
