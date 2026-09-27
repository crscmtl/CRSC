/*
 * Somebody who has paid must never be chased for the money again.
 *
 * The app owns the "who owes" list and republishes it on every change — but
 * only from a browser with the page open. Transfers get filed by the Gmail
 * script on its own fifteen-minute trigger, including at three in the
 * morning when nobody has anything open. So between the payment landing and
 * the next visitor, the list still said they owed, and the reminder chased
 * them for money they had already sent.
 *
 * Being told you owe $8 you paid on Tuesday is exactly what sends somebody
 * back to messaging an exec, which is the sheet the app replaced.
 *
 * Two people owe $8 each. Ana's transfer arrives and settles her exactly;
 * Bo has not paid. Only Bo may be chased. A third, Cy, sends $5 against $8
 * — he stays on the list, but the reminder has to quote the $3 that is
 * actually left, not the original figure.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const sat = new Date();
sat.setDate(sat.getDate() + 1);                  // tomorrow → the "day" reminder
const DATE = `${sat.getFullYear()}-${String(sat.getMonth() + 1).padStart(2, '0')}-${String(sat.getDate()).padStart(2, '0')}`;

function mapOf(o) {
  const fields = {};
  for (const [k, v] of Object.entries(o)) {
    fields[k] = Array.isArray(v)
      ? { arrayValue: { values: v.map(x => ({ stringValue: x })) } }
      : typeof v === 'number' ? { doubleValue: v } : { stringValue: v };
  }
  return { mapValue: { fields } };
}

function run() {
  const mails = [];
  const store = {
    'dues/ev1': {
      date: { stringValue: DATE },
      location: { stringValue: 'The gym' },
      people: { arrayValue: { values: [
        mapOf({ name: 'Ana', owed: 8, ids: ['su-ana'], email: 'ana@x.com', lang: 'en' }),
        mapOf({ name: 'Bo',  owed: 8, ids: ['su-bo'],  email: 'bo@x.com',  lang: 'en' }),
        mapOf({ name: 'Cy',  owed: 8, ids: ['su-cy'],  email: 'cy@x.com',  lang: 'en' }),
      ] } },
    },
    'payments/p1': {
      sender: { stringValue: 'ANA DIAZ' }, amount: { doubleValue: 8 },
      message: { stringValue: '' }, receivedAt: { integerValue: '1' },
    },
    'payments/p2': {
      sender: { stringValue: 'CY LIN' }, amount: { doubleValue: 5 },
      message: { stringValue: '' }, receivedAt: { integerValue: '2' },
    },
  };

  const res = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
  const docsIn = (coll) => Object.keys(store).filter(k => k.startsWith(coll + '/'))
    .map(k => ({ name: 'projects/p/databases/(default)/documents/' + k, fields: store[k] }));

  const ctx = {
    console,
    MailApp: { sendEmail: (m) => mails.push({ to: m.to, subject: m.subject, body: m.body }) },
    GmailApp: { search: () => [] },
    UrlFetchApp: {
      fetch(url, opts) {
        const path = decodeURIComponent(url.split('/documents/')[1].split('?')[0]);
        if (!opts || opts.method !== 'patch') {
          if (path === 'config/main') return res(200, { fields: {
            etransferEmail: { stringValue: 'club@x.com' },
            lateFeeAmount: { integerValue: '5' },
            testAmount: { integerValue: '1' },
            passPrice4h: { integerValue: '135' },
            passPrice2h: { integerValue: '75' },
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

  ctx.settleTransfers();              // the 3am run, with nobody's browser open
  for (let i = 0; i < 4; i++) ctx.sendReminders();   // an hour of the trigger

  const owed = (store['dues/ev1'].people.arrayValue.values || [])
    .map(v => ({ name: v.mapValue.fields.name.stringValue,
                 owed: Number(v.mapValue.fields.owed.doubleValue) }));
  return { mails, owed, paid: !!store['events/ev1/signups/su-ana'] };
}

const { mails, owed, paid } = run();
const chased = mails.filter(m => /remind|owe|paiement|payment due|still/i.test(m.subject + m.body));
const reminded = [...new Set(chased.map(m => m.to))].sort();

console.log('Ana settled by the matcher :', paid);
console.log('who still owes, after      :', JSON.stringify(owed));
console.log('who got chased             :', JSON.stringify(reminded));
const cyMail = chased.find(m => m.to === 'cy@x.com');
console.log('what Cy was asked for      :', JSON.stringify((cyMail?.body || '').match(/\d+(?:[.,]\d+)?\s*\$|\$\s*\d+/g)));

const ok = paid
        && !reminded.includes('ana@x.com')
        && reminded.includes('bo@x.com')
        && reminded.includes('cy@x.com')
        && !owed.some(p => p.name === 'Ana')
        && owed.find(p => p.name === 'Cy')?.owed === 3
        && /3\$|\$3/.test(cyMail?.body || '');
console.log('\n' + (ok
  ? 'a member who paid is never chased again, and a part payment is chased for what is left'
  : 'FAILED'));
process.exit(ok ? 0 : 1);
