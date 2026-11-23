/*
 * The club's five playing levels, and what the old grades turn into.
 *
 * The ladder used to run Intermediate, Advanced, Adv + Mixed, Advanced +,
 * with Adv + Men sharing a number with Advanced + because it had none of
 * its own. The club's actual order puts Advanced + below Adv + Mixed and
 * Adv + Men on top, so the middle two swap and a fifth rung is added.
 *
 * The level number is what decides who may sign themselves up, and there
 * were 82 graded players and 31 events' worth of graded lists in the
 * database when this changed. Renumbering 1-4 in place would have
 * reclassified every one of them silently, so the new ranks start at 10
 * and the old numbers are read through a map instead of being rewritten.
 *
 * This check is about that map as much as the ladder: an old grade has to
 * keep meaning what the exec who set it meant.
 */
import {
  LEVELS, levelByRank, listLevel, storedListLevel, normalizeLevel,
} from '../public/js/store.js';

const fail = [];
const eq = (what, got, want) => {
  const ok = got === want;
  console.log(`    ${ok ? ' ' : '!'} ${what}: ${JSON.stringify(got)}${ok ? '' : '   expected ' + JSON.stringify(want)}`);
  if (!ok) fail.push(`${what} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
};

/* ---- 1. The ladder the club asked for, lowest to highest. */
const WANT = ['Intermediate', 'Advanced', 'Advanced +', 'Adv + Mixed', 'Adv + Men'];
console.log('the ladder, lowest first:');
const got = LEVELS.map(l => l.label);
console.log('   ', got.join('  <  '));
eq('the five levels in order', got.join('|'), WANT.join('|'));
// Ranks must climb, or "my level and anything below" means nothing.
const climbing = LEVELS.every((l, i) => i === 0 || l.rank > LEVELS[i - 1].rank);
eq('ranks climb with the ladder', climbing, true);
eq('Adv + Men is the top', LEVELS[LEVELS.length - 1].label, 'Adv + Men');
// Every level needs a tag an exec can read on a roster row.
const tagged = LEVELS.every(l => l.short && l.short.trim().length);
eq('every level has a tag', tagged, true);
console.log('    tags:', LEVELS.map(l => l.short).join(', '));

/* ---- 2. Old grades keep their meaning.
 *
 * A list says which it is in its own name, and the name is what an exec
 * reads, so a stored 4 on "Advanced +" must not come back as Adv + Men. */
console.log('lists graded before the change:');
const L = (label, level) => ({ sport: 'volleyball', label, level });
eq('"Advanced +" stored as 4', levelByRank(listLevel(L('Advanced +', 4)))?.label, 'Advanced +');
eq('"Adv + Men" stored as 4', levelByRank(listLevel(L('Adv + Men', 4)))?.label, 'Adv + Men');
eq('"Adv + Mixed" stored as 3', levelByRank(listLevel(L('Adv + Mixed', 3)))?.label, 'Adv + Mixed');
eq('"Advanced" stored as 2', levelByRank(listLevel(L('Advanced', 2)))?.label, 'Advanced');
eq('"Intermediate" stored as 1', levelByRank(listLevel(L('Intermediate', 1)))?.label, 'Intermediate');
// The three lists in the live calendar where Adv + Mixed was typed as a 4.
eq('"Adv + Mixed" mis-stored as 4', levelByRank(listLevel(L('Adv + Mixed', 4)))?.label, 'Adv + Mixed');
// A deliberate 0 still means anyone, and ungraded sports stay ungraded.
eq('a deliberate 0 still means anyone', listLevel(L('Advanced +', 0)), 0);
eq('basketball is never graded', listLevel({ sport: 'basketball', label: 'Men', level: 4 }), 0);
// A grade already on the new ladder is left alone.
eq('a new grade passes through', listLevel(L('Advanced +', 30)), 30);

/* ---- 3. The grade editor must not invent a grade nobody set. Opening an
 * event and saving it used to be harmless; it must stay harmless. */
console.log('the grade editor:');
eq('an ungraded list reads as no grade', storedListLevel({ sport: 'volleyball', label: 'Adv + Men' }), null);
eq('but the ladder still places it', listLevel({ sport: 'volleyball', label: 'Adv + Men' }), 50);
eq('an old grade shows the right rung', storedListLevel(L('Advanced +', 4)), 30);

/* ---- 4. Players. The club chose to keep anyone on the old top rank at
 * the top, so nobody who can sign up for a list today is turned away by
 * the renumbering. */
console.log('players graded before the change:');
eq('old top rank 4 stays at the top', levelByRank(normalizeLevel(4))?.label, 'Adv + Men');
eq('old rank 3 is Adv + Mixed', levelByRank(normalizeLevel(3))?.label, 'Adv + Mixed');
eq('old rank 2 is Advanced', levelByRank(normalizeLevel(2))?.label, 'Advanced');
eq('old rank 1 is Intermediate', levelByRank(normalizeLevel(1))?.label, 'Intermediate');
eq('ungraded stays ungraded', normalizeLevel(null), null);
eq('a zero is not a grade', normalizeLevel(0), null);

/* ---- 5. The gate: my level and anything below it. */
console.log('who may sign themselves up:');
const may = (playerStored, list) => (normalizeLevel(playerStored) || 0) >= listLevel(list);
eq('an old top player may join Adv + Men', may(4, L('Adv + Men', 4)), true);
eq('an old top player may join Adv + Mixed', may(4, L('Adv + Mixed', 3)), true);
eq('an old top player may join Advanced +', may(4, L('Advanced +', 4)), true);
eq('an Advanced player may not join Adv + Men', may(2, L('Adv + Men', 4)), false);
eq('an Advanced player may not join Advanced +', may(2, L('Advanced +', 4)), false);
eq('an Advanced player may join Intermediate', may(2, L('Intermediate', 1)), true);
eq('Advanced + does not reach Adv + Mixed', may(30, L('Adv + Mixed', 40)), false);
eq('Adv + Mixed reaches Advanced +', may(40, L('Advanced +', 30)), true);

if (fail.length) {
  console.log('\nFAIL');
  fail.forEach(f => console.log('  -', f));
  process.exit(1);
}
console.log('\nPASS — five levels in the club’s order, and old grades still mean what they meant.');
