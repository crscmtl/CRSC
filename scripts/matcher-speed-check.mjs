/*
 * The matcher must not re-read mail it has already filed.
 *
 * It used to search the last seven days of Interac mail on every run and
 * fire a database write for each message, letting a 409 mean "already have
 * it". Fine at twenty transfers a week. At a hundred and fifteen the run
 * took six minutes, Google killed it, and nothing was filed and nobody was
 * reminded — the whole job failed because of how it remembered, not what it
 * did.
 *
 * Labels do the remembering now. Three things to hold:
 *   1. the search excludes what has been handled, so a steady week is cheap,
 *   2. a transfer it files is labelled filed; mail it cannot read is
 *      labelled for a human instead of being silently dropped,
 *   3. a backlog is capped per run, so one run can never blow the limit.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeMsg(id, sender, amount) {
  return {
    getId: () => id,
    getSubject: () => `Virement Interac : Vous avez reçu ${amount},00 $ de ${sender} et ce montant a été déposé automatiquement.`,
    getPlainBody: () => `Envoyé par : ${sender}\nMontant : ${amount},00 $`,
    getFrom: () => `${sender} <notify@payments.interac.ca>`,
    getDate: () => new Date(),
  };
}
function makeThread(msgs) {
  const labels = [];
  return { getMessages: () => msgs, addLabel: (l) => labels.push(l.name), labels };
}

function run({ backlog, alreadyLabelled }) {
  const writes = [];
  const searches = [];
  const made = {};
  // A week of transfers, plus one the parser cannot read.
  const all = [];
  for (let i = 0; i < backlog; i++) all.push(makeThread([makeMsg('m' + i, 'PLAYER ' + i, 8)]));
  const junk = makeThread([{
    getId: () => 'junk', getSubject: () => 'Interac newsletter',
    getPlainBody: () => 'nothing here', getFrom: () => 'news@marketing.example',
    getDate: () => new Date(),
  }]);
  all.push(junk);

  const ctx = {
    console,
    MailApp: { sendEmail: () => {} },
    GmailApp: {
      getUserLabelByName: (n) => made[n] || null,
      createLabel: (n) => (made[n] = { name: n }),
      search: (q, start, max) => {
        searches.push(q);
        // Honour the label exclusions the way Gmail would.
        const skip = alreadyLabelled;
        const left = all.filter(t => !skip.includes(t.getMessages()[0].getId()));
        return left.slice(0, max);
      },
    },
    UrlFetchApp: {
      fetch(url, opts) {
        if (opts && opts.method === 'post') writes.push(url);
        const res = (c, b) => ({ getResponseCode: () => c, getContentText: () => JSON.stringify(b) });
        const path = decodeURIComponent(url.split('/documents/')[1].split('?')[0]);
        if (path === 'config/main') return res(200, { fields: { autoMatch: { stringValue: 'off' } } });
        if (path.indexOf('/') < 0) return res(200, { documents: [] });
        return res(404, {});
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(ROOT, 'apps-script/payment-matcher.gs'), 'utf8'), ctx);
  ctx.checkTransfers();
  return { writes: writes.length, searches, threads: all };
}

// A steady week: everything already filed, one new transfer arrives.
const steady = run({ backlog: 1, alreadyLabelled: [] });
console.log('search asks Gmail for      :', /-label:/.test(steady.searches[0] || '') ? 'only mail not yet handled' : 'EVERYTHING');
console.log('writes for 1 new transfer  :', steady.writes, '(must be 1)');
const labels = steady.threads.map(t => t.labels).flat();
console.log('labels applied             :', JSON.stringify(labels));

// A backlog far bigger than one run should attempt.
const flood = run({ backlog: 200, alreadyLabelled: [] });
console.log('\n200 waiting, writes in one run:', flood.writes, '(must be capped, not 200)');

const excludes = /-label:"CRSC\/filed"/.test(steady.searches[0] || '') && /-label:"CRSC\/needs a look"/.test(steady.searches[0] || '');
const filedOk = labels.includes('CRSC/filed');
const lookOk = labels.includes('CRSC/needs a look');
console.log('\nunreadable mail flagged for a human:', lookOk);

const ok = excludes && steady.writes === 1 && filedOk && lookOk
        && flood.writes > 0 && flood.writes <= 25;
console.log('\n' + (ok
  ? 'a steady week costs one write, a backlog drains in capped batches, and nothing is read twice'
  : 'FAILED'));
process.exit(ok ? 0 : 1);
