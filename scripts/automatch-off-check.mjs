/*
 * Nothing marks anybody paid by itself.
 *
 * On the club's first busy Saturday the matcher credited the wrong people.
 * With sixty names on a list instead of twelve, one shared word stopped
 * being evidence: a transfer from ALEXA DE VILLA settled Arthur Huon de
 * Penanster on "de", and HUGO HE settled He, Yu Chen on "he". It also
 * reached back and spent payments from games already played against the
 * coming one, and emailed all of them "we received your payment".
 *
 * Reading the mail was always the valuable half, so that stays: every
 * transfer is still recorded with its sender, amount and message, and still
 * listed for an exec. Only the deciding is gone.
 *
 * This runs the Gmail script over exactly that situation — the real names,
 * an old payment and a fresh one — and requires that it files both and
 * settles neither. Then it flips the club setting on and requires the old
 * behaviour back, so the switch is proven in both directions.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sat = new Date(); sat.setDate(sat.getDate() + 1);
const DATE = `${sat.getFullYear()}-${String(sat.getMonth() + 1).padStart(2, '0')}-${String(sat.getDate()).padStart(2, '0')}`;

const mapOf = (o) => ({ mapValue: { fields: Object.fromEntries(Object.entries(o).map(([k, val]) => [k,
  Array.isArray(val) ? { arrayValue: { values: val.map(x => ({ stringValue: x })) } }
  : typeof val === 'number' ? { doubleValue: val } : { stringValue: val }])) } });

function run(autoMatch) {
  const mails = [];
  const store = {
    'dues/ev1': {
      date: { stringValue: DATE }, location: { stringValue: 'The gym' },
      people: { arrayValue: { values: [
        mapOf({ name: 'Arthur Huon de Penanster', owed: 8, ids: ['su-arthur'], email: 'arthur@x.com', lang: 'en' }),
        mapOf({ name: 'He, Yu Chen',              owed: 8, ids: ['su-he'],     email: 'he@x.com',     lang: 'en' }),
      ] } },
    },
    // The real shape of what went wrong: a stranger sharing one weak word.
    'payments/p1': { sender: { stringValue: 'ALEXA DE VILLA' }, amount: { doubleValue: 8 },
                     message: { stringValue: '' }, receivedAt: { integerValue: '1' } },
    'payments/p2': { sender: { stringValue: 'HUGO HE' }, amount: { doubleValue: 8 },
                     message: { stringValue: '' }, receivedAt: { integerValue: '2' } },
  };
  const res = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
  const docsIn = (c) => Object.keys(store).filter(k => k.startsWith(c + '/'))
    .map(k => ({ name: 'projects/p/databases/(default)/documents/' + k, fields: store[k] }));

  const ctx = {
    console,
    MailApp: { sendEmail: (m) => mails.push(m.to) },
    GmailApp: { search: () => [] },
    UrlFetchApp: {
      fetch(url, opts) {
        const path = decodeURIComponent(url.split('/documents/')[1].split('?')[0]);
        if (!opts || opts.method !== 'patch') {
          if (path === 'config/main') return res(200, { fields: {
            etransferEmail: { stringValue: 'club@x.com' }, lateFeeAmount: { integerValue: '5' },
            testAmount: { integerValue: '1' }, passPrice4h: { integerValue: '135' },
            passPrice2h: { integerValue: '75' }, autoMatch: { stringValue: autoMatch },
          } });
          if (path.indexOf('/') < 0) return res(200, { documents: docsIn(path) });
          return store[path] ? res(200, { fields: store[path] }) : res(404, {});
        }
        store[path] = { ...(store[path] || {}), ...JSON.parse(opts.payload).fields };
        return res(200, {});
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(ROOT, 'apps-script/payment-matcher.gs'), 'utf8'), ctx);
  ctx.settleTransfers();

  const settled = Object.keys(store).filter(k => k.startsWith('events/'));
  const claimed = Object.keys(store).filter(k => k.startsWith('payments/') && store[k].matched);
  return { settled, claimed, mails, kept: Object.keys(store).filter(k => k.startsWith('payments/')).length };
}

const off = run('off');
console.log("setting 'off' — sign-ups touched:", off.settled.length, '| payments claimed:', off.claimed.length, '| receipts:', off.mails.length);
console.log("             transfers still on record:", off.kept);

const on = run('on');
console.log("setting 'on'  — sign-ups touched:", on.settled.length, '| payments claimed:', on.claimed.length);

console.log('\nWith it on, these are the matches it would make:');
console.log('   ALEXA DE VILLA -> Arthur Huon de Penanster   (shares only "de")');
console.log('   HUGO HE        -> He, Yu Chen                (shares only "he")');

const ok = off.settled.length === 0 && off.claimed.length === 0 && off.mails.length === 0
        && off.kept === 2
        && on.settled.length > 0;
console.log('\n' + (ok
  ? 'nothing is settled or emailed on its own, and every transfer is still recorded'
  : 'FAILED'));
process.exit(ok ? 0 : 1);
