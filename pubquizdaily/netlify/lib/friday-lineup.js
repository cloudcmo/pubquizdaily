// netlify/lib/friday-lineup.js
// Who goes where in each Friday Best-of, from 30 Oct 2026 (Carl's call, 23 Oct):
//   - three blocks: one LEAD (big) and two smaller CARDS underneath
//   - Pub Quiz Daily is always one of the three: it leads one Friday in
//     PQD_LEAD_EVERY, and is the first card on every other Friday
//   - every other slot goes to the other Guff games (Guffinoes left out, Carl:
//     "not much fun"), with no game appearing in two Fridays running
//   - each appearance of a game uses the next opener and the next example
//     from its bank, so the email reads differently every week
// Everything is worked out from the date alone by replaying every Friday from
// PLAN_FROM, so the Thursday preview, a rebuild and the Friday send always
// agree, and nothing has to be stored.

const PLAN_FROM = '2026-10-30';
const PQD_LEAD_EVERY = 3;   // PQD leads on weeks 2, 5, 8... (30 Oct and 6 Nov lead with games)
const GAMES = ['guffitaire', 'wagdaily', 'hexadec', 'wordminer', 'whenly', 'helmet', 'groupie', 'spellbound', 'whatword'];

function seededShuffle(arr, seed) {
  const a = [...arr];
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  const rnd = () => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const weekIndex = fridayISO =>
  Math.round((Date.parse(`${fridayISO}T12:00:00Z`) - Date.parse(`${PLAN_FROM}T12:00:00Z`)) / (7 * 86400000));

// The lead games, one run through GAMES at a time, each run shuffled afresh.
// The last three of a run are moved to the middle of the next, so where two
// runs meet no game leads twice within four weeks. Helmet led on 23 Oct, so
// it goes to the back of the first run.
const leadDecks = {};
function leadDeck(c) {
  if (leadDecks[c]) return leadDecks[c];
  let d = seededShuffle(GAMES, `lead-${c}`);
  if (c === 0) { d.splice(d.indexOf('helmet'), 1); d.push('helmet'); }
  if (c > 0) {
    const tail = leadDeck(c - 1).slice(-3);
    const rest = d.filter(k => !tail.includes(k));
    d = [...rest.slice(0, 3), ...d.filter(k => tail.includes(k)), ...rest.slice(3)];
  }
  return (leadDecks[c] = d);
}

// editionLead(fridayISO) may return a key to force the lead for a one-off
// edition ('pqd' or a game key); anything else is ignored.
function planFor(fridayISO, editionLead = () => null) {
  const n = weekIndex(fridayISO);
  if (n < 0) return null;

  const cardStream = [];
  let cardCycle = 0;
  const refill = () => { cardStream.push(...seededShuffle(GAMES, `cards-${cardCycle++}`)); };

  const seen = {};          // appearances so far per key (lead or card), drives openers and examples
  const leadStream = [];    // the lead decks run end to end
  let leadCycle = 0;
  let prev = new Set();
  let plan = null;

  for (let w = 0; w <= n; w++) {
    const iso = addDaysISO(PLAN_FROM, 7 * w);
    const forced = editionLead(iso);
    let lead;
    if (forced === 'pqd' || GAMES.includes(forced)) lead = forced;
    else if (w % PQD_LEAD_EVERY === PQD_LEAD_EVERY - 1) lead = 'pqd';
    else {
      // Next game in the lead decks that wasn't in last Friday's email.
      let j = 0;
      for (;;) {
        if (j >= leadStream.length) leadStream.push(...leadDeck(leadCycle++));
        if (!prev.has(leadStream[j])) break;
        j++;
      }
      lead = leadStream.splice(j, 1)[0];
    }

    const need = lead === 'pqd' ? 2 : 1;
    const cards = [];
    let i = 0;
    while (cards.length < need) {
      if (i >= cardStream.length) refill();
      const g = cardStream[i];
      if (g !== lead && !prev.has(g) && !cards.includes(g)) { cards.push(g); cardStream.splice(i, 1); }
      else i++;
    }
    if (lead !== 'pqd') cards.unshift('pqd');

    const slot = key => { const k = seen[key] || 0; seen[key] = k + 1; return { key, n: k }; };
    const leadSlot = slot(lead);
    const cardSlots = cards.map(slot);
    plan = { fridayISO: iso, week: w, lead: leadSlot, cards: cardSlots };
    prev = new Set([lead, ...cards].filter(k => k !== 'pqd'));
  }
  return plan;
}

// The k-th use of a list: every entry once, in a shuffled order per pass,
// before any comes round again.
function nth(list, k, seed) {
  if (!list || !list.length) return null;
  const pass = Math.floor(k / list.length);
  return seededShuffle(list, `${seed}-${pass}`)[k % list.length];
}

function addDaysISO(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = { PLAN_FROM, GAMES, planFor, nth, seededShuffle };
