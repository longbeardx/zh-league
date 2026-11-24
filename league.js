"use strict";
/* Zero Hour League — core logic (no DOM; runs in the browser and in Node tests).
 *
 * Data: league.json in a private GitHub repo.
 *   players  {id, aka, sig, role?: "super", admin?, codeHash, codeSalt, codeBox, ts (joined), updatedAt, inactive: [{from, to|null}]}
 *   vault    {pub, wrapped, updatedAt}   super admin's sealed code list (see "the super admin's code list")
 *            names are shown in CAPS followed by the optional signature emoji (sig)
 *   seasons  {id, name, startTs, endTs|null, ts, updatedAt}
 *   nights   {id, seasonId, ts, updatedAt}
 *   games    {id, nightId, type: "1v1"|"2v2"|"3v3", teamA: [pid], teamB: [pid], winner: "A"|"B", ts, updatedAt}
 *   deleted  [ids]            removals, remembered so stale copies can't bring them back
 *   epoch    number           bumped by "restore"; an older-epoch copy is discarded
 *
 * Scoring per season: each winner +3, each loser -1. On a night where games
 * were played, every player who was eligible (joined before the night, not
 * marked inactive) but played no game gets -0.5.
 */
const ZH = (() => {
  const emptyDoc = () => ({ version: 1, epoch: 0, players: [], seasons: [], nights: [], games: [], deleted: [] });
  const stamp = (x) => x.updatedAt || x.ts || 0;

  function merge(a, b) {
    a = a || emptyDoc(); b = b || emptyDoc();
    const ea = a.epoch || 0, eb = b.epoch || 0;
    if (ea !== eb) {                       // a restore happened: newest epoch wins outright
      const w = ea > eb ? a : b;
      return merge(w, { ...emptyDoc(), epoch: w.epoch });
    }
    const del = new Set([...(a.deleted || []), ...(b.deleted || [])]);
    const union = (xs, ys) => {
      const m = new Map();
      for (const x of [...(xs || []), ...(ys || [])]) {
        const o = m.get(x.id);
        if (!o || stamp(x) > stamp(o) || (stamp(x) === stamp(o) && JSON.stringify(x) > JSON.stringify(o))) m.set(x.id, x);
      }
      return [...m.values()].filter((x) => !del.has(x.id))
        .sort((p, q) => (p.ts || 0) - (q.ts || 0) || (p.id < q.id ? -1 : 1));
    };
    const va = a.vault || null, vb = b.vault || null;
    const vault = !va ? vb : !vb ? va : ((va.updatedAt || 0) >= (vb.updatedAt || 0) ? va : vb);
    return { version: 1, epoch: ea, ...(vault ? { vault } : {}), players: union(a.players, b.players), seasons: union(a.seasons, b.seasons),
      nights: union(a.nights, b.nights), games: union(a.games, b.games), deleted: [...del].sort() };
  }

  // ----- seasons, players ----------------------------------------------------
  const currentSeason = (doc) => doc.seasons.filter((s) => !s.endTs).sort((a, b) => b.startTs - a.startTs)[0] || null;
  // Joining, going on leave and coming back count by DAY: whatever happens on a
  // given day applies to that day's nights (a night is often created minutes
  // before or after players are added).
  const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const inactiveAt = (p, t) => (p.inactive || []).some((r) =>
    t >= dayStart(r.from) && (r.to == null || t < dayStart(r.to)));
  const isActiveNow = (p) => !(p.inactive || []).some((r) => r.to == null);
  const eligible = (p, night) => dayStart(p.ts || 0) <= night.ts && !inactiveAt(p, night.ts);
  const player = (doc, id) => doc.players.find((p) => p.id === id);
  // optional signature emoji (older data used "challenge"; the default ⚔️ meant none)
  const sigOf = (p) => (p ? (p.sig != null ? p.sig : (p.challenge && p.challenge !== "⚔️" ? p.challenge : "")) : "");
  const displayName = (p) => (p ? String(p.aka || "").toUpperCase() + (sigOf(p) ? " " + sigOf(p) : "") : "SOMEONE");
  const nightsOf = (doc, sid) => doc.nights.filter((n) => n.seasonId === sid).sort((a, b) => a.ts - b.ts);
  const gamesOf = (doc, nid) => doc.games.filter((g) => g.nightId === nid).sort((a, b) => a.ts - b.ts);

  // One night: who won/lost what, who was absent (-0.5)
  function nightReport(doc, night) {
    const games = gamesOf(doc, night.id), per = {}, played = new Set();
    const get = (id) => (per[id] = per[id] || { w: 0, l: 0 });
    for (const g of games) {
      const win = g.winner === "A" ? g.teamA : g.teamB, lose = g.winner === "A" ? g.teamB : g.teamA;
      win.forEach((id) => { get(id).w++; played.add(id); });
      lose.forEach((id) => { get(id).l++; played.add(id); });
    }
    const absent = games.length ? doc.players.filter((p) => eligible(p, night) && !played.has(p.id)).map((p) => p.id) : [];
    return { games, per, absent };
  }

  // Season table. Points kept as integer halves (x2) so -0.5 never drifts.
  function standings(doc, sid) {
    const rows = new Map();
    const row = (id) => {
      if (!rows.has(id)) rows.set(id, { id, half: 0, w: 0, l: 0, absences: 0, nightsPlayed: 0, results: [], vs: {}, mates: {} });
      return rows.get(id);
    };
    const nights = nightsOf(doc, sid);
    for (const n of nights) {
      const rep = nightReport(doc, n);
      Object.keys(rep.per).forEach((id) => { row(id).nightsPlayed++; });
      rep.absent.forEach((id) => { const r = row(id); r.half -= 1; r.absences++; });
      for (const g of rep.games) {
        const win = g.winner === "A" ? g.teamA : g.teamB, lose = g.winner === "A" ? g.teamB : g.teamA;
        for (const id of win) {
          const r = row(id); r.half += 6; r.w++; r.results.push("W");
          lose.forEach((o) => { (r.vs[o] = r.vs[o] || { beat: 0, lostTo: 0 }).beat++; });
          win.filter((m) => m !== id).forEach((m) => { (r.mates[m] = r.mates[m] || { w: 0, l: 0 }).w++; });
        }
        for (const id of lose) {
          const r = row(id); r.half -= 2; r.l++; r.results.push("L");
          win.forEach((o) => { (r.vs[o] = r.vs[o] || { beat: 0, lostTo: 0 }).lostTo++; });
          lose.filter((m) => m !== id).forEach((m) => { (r.mates[m] = r.mates[m] || { w: 0, l: 0 }).l++; });
        }
      }
    }
    // active players with no nights yet still appear (at 0)
    doc.players.forEach((p) => { if (isActiveNow(p)) row(p.id); });
    const out = [...rows.values()].filter((r) => player(doc, r.id)).map((r) => {
      const last = r.results[r.results.length - 1]; let n = 0;
      for (let i = r.results.length - 1; i >= 0 && r.results[i] === last; i--) n++;
      const top = (obj, key) => { let best = null;
        for (const [k, v] of Object.entries(obj)) if (v[key] > 0 && (!best || v[key] > best.n)) best = { id: k, n: v[key] };
        return best; };
      const games = r.w + r.l;
      return { ...r, pts: r.half / 2, games, winRate: games ? r.w / games : 0,
        streak: last ? { kind: last, n } : null,
        nemesis: top(r.vs, "lostTo"), victim: top(r.vs, "beat"), bestMate: top(r.mates, "w") };
    });
    out.sort((x, y) => y.half - x.half || y.winRate - x.winRate || y.w - x.w ||
      (player(doc, x.id).aka || "").localeCompare(player(doc, y.id).aka || ""));
    return out;
  }

  // ----- deterministic randomness: same night -> same jokes on every phone ---
  function rng(seedStr) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  }
  const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
  const fill = (tpl, v) => tpl.replace(/\{(\w+)\}/g, (_, k) => (v[k] != null ? v[k] : ""));
  function deck(r) {
    const piles = new Map();
    return (xs) => { let p = piles.get(xs); if (!p || !p.length) { p = shuffle(r, xs); piles.set(xs, p); } return p.pop(); };
  }
  function shuffle(r, xs) { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  const ROAST = {
    perfect: [
      "{a} went {w}–0 tonight. The opponents have requested a recount.",
      "{a} won everything tonight. Scientists are puzzled, mothers are proud.",
      "{a}: {w} wins, zero losses, and still complained about lag.",
      "{a} went undefeated. Somebody check his PC for a second player.",
      "{a} didn't lose a single set. The Department of Justice has opened an investigation.",
    ],
    winless: [
      "{a} went 0–{l}. “I will work!” he said. He did not work.",
      "{a} lost {l} times tonight and blamed the map every single time.",
      "Breaking: {a}'s mouse has filed for divorce after {l} losses.",
      "{a} finished 0–{l}. The GLA workers' union has offered him a job.",
      "{a} went 0–{l}. “Do not hurt me!” — {a}, all night.",
      "{a} went 0–{l}. Official statement: “teams were unfairly distributed.”",
    ],
    mixed: [
      "{a} went {w}–{l}. Perfectly balanced, as nothing should be.",
      "{a} split the night {w}–{l}. A true centrist.",
      "{a} went {w}–{l}. Not good, not bad, just… present.",
      "{a} finished {w}–{l}. Peak mediocrity, achieved with honour.",
      "{a}: {w}–{l}. Switzerland called, they want their neutrality back.",
      "{a} went {w}–{l}. The scales of justice remain perfectly level.",
    ],
    mostlyWon: [
      "{a} went {w}–{l}. Solid night. Still found something to complain about.",
      "{a} finished {w}–{l}. The one loss was “definitely lag”.",
    ],
    mostlyLost: [
      "{a} went {w}–{l}. The win was luck, the losses were also luck, apparently.",
      "{a}: {w}–{l}. “I will work!” Work harder, comrade.",
    ],
    absent: [
      "{a} skipped the night: −0.5 and a formal letter from the Department of Justice.",
      "{a} was absent. Sources say he was “practicing”. Sources are lying.",
      "{a} didn't show up. His tanks are still waiting at the base.",
      "{a} missed the night. The worker he left behind is still building a barracks.",
    ],
    duo: [
      "{a} and {b} won {n} sets together. HR has been informed about the relationship.",
      "{a} + {b}: {n} wins as a team. Wedding planners are on standby.",
      "{a} and {b} are now a package deal. {n} wins, zero personal space.",
    ],
    duel: [
      "1v1 verdict: {w} beat {l}. {l} has requested a rematch, a lawyer and a hug.",
      "{w} took the 1v1 off {l}. Witnesses describe it as “a public service announcement”.",
      "{w} vs {l}: {w} wins. {l} is “not even mad”. He is extremely mad.",
    ],
    general: [
      "{n} sets tonight. No civilians were harmed. Several egos were.",
      "{n} sets played. The GLA workers are still cleaning up.",
    ],
  };

  function roastLines(doc, night) {
    const rep = nightReport(doc, night), r = rng("roast:" + night.id), take = deck(r);
    const aka = (id) => displayName(player(doc, id));
    const lines = []; let balanced = 0;
    for (const [id, s] of Object.entries(rep.per)) {
      const v = { a: aka(id), w: s.w, l: s.l };
      if (s.w >= 2 && s.l === 0) lines.push(fill(take(ROAST.perfect), v));
      else if (s.w === 0 && s.l >= 2) lines.push(fill(take(ROAST.winless), v));
      else if (s.w >= 1 && s.l >= 1) {
        if (s.w === s.l) { if (balanced++ < 2) lines.push(fill(take(ROAST.mixed), v)); }
        else lines.push(fill(take(s.w > s.l ? ROAST.mostlyWon : ROAST.mostlyLost), v));
      }
    }
    rep.absent.forEach((id) => lines.push(fill(take(ROAST.absent), { a: aka(id) })));
    const duos = {}, duels = new Set();
    for (const g of rep.games) {
      const win = g.winner === "A" ? g.teamA : g.teamB;
      if (win.length >= 2) for (let i = 0; i < win.length; i++) for (let j = i + 1; j < win.length; j++) {
        const k = [win[i], win[j]].sort().join("|"); duos[k] = (duos[k] || 0) + 1; }
      const pair = g.type === "1v1" && [g.teamA[0], g.teamB[0]].sort().join("|");
      if (pair && !duels.has(pair)) duels.add(pair), lines.push(fill(take(ROAST.duel), { w: aka((g.winner === "A" ? g.teamA : g.teamB)[0]), l: aka((g.winner === "A" ? g.teamB : g.teamA)[0]) }));
    }
    for (const [k, n] of Object.entries(duos)) if (n >= 2) { const [a, b] = k.split("|"); lines.push(fill(take(ROAST.duo), { a: aka(a), b: aka(b), n })); }
    if (rep.games.length) lines.push(fill(take(ROAST.general), { n: rep.games.length }));
    return shuffle(r, lines).slice(0, 5);
  }

  const NEWS = {
    leader: [
      "BREAKING: {a} leads {s} with {p} points. Rest of the lobby “not worried”.",
      "{a} spotted at the top of the {s} table again. Neighbours complain about the noise.",
      "{a} tops {s}. Experts suspect bribery, possibly involving shawarma.",
    ],
    last: [
      "{a} holds last place in {s}, proudly wearing the 💩. “Do not hurt me!” he told reporters.",
      "Local commander {a} discovers a new tactic: losing. Analysts call it “bold”.",
      "{a} confirmed in last place. Says he's “letting the others feel good about themselves”.",
    ],
    hot: ["{a} wins {n} in a row. Opponents have formed a support group.", "{a} is on a {n}-set streak. Somebody unplug his router."],
    cold: ["{a} has lost {n} straight. “I will work!” he insists. Evidence suggests otherwise.", "{a}: {n} losses in a row. His mouse is now in witness protection."],
    ghost: ["MISSING: {a}, absent {n} nights this season. Reward: one (1) tank.", "{a} has missed {n} nights. The base is now a museum."],
    nemesis: ["{a} has beaten {b} {n} times this season. {b} calls it “a personal matter”.", "Diplomatic crisis: {b} lost to {a} {n} times and refuses to comment."],
    filler: [
      "Weather forecast: heavy artillery with a 90% chance of rage-quits.",
      "GLA workers threaten strike: “We will work… later.”",
      "Department of Justice reports record complaints. All dismissed: skill issue.",
      "Scientists confirm: the map is not the problem.",
      "INVESTIGATION: Teams found to be “unfairly distributed” for the 47th week in a row. Factions refuse to comment.",
    ],
  };

  function headlines(doc, sid) {
    const season = doc.seasons.find((s) => s.id === sid);
    if (!season) return [];
    const table = standings(doc, sid).filter((x) => x.games > 0 || x.absences > 0);
    const nights = nightsOf(doc, sid), last = nights[nights.length - 1];
    const r = rng("news:" + sid + ":" + (last ? last.id : "none") + ":" + table.length), take = deck(r);
    const aka = (id) => displayName(player(doc, id));
    const out = [];
    if (table.length >= 2) {
      out.push(fill(take(NEWS.leader), { a: aka(table[0].id), s: season.name, p: table[0].pts }));
      out.push(fill(take(NEWS.last), { a: aka(table[table.length - 1].id), s: season.name }));
    }
    table.forEach((x) => {
      if (x.streak && x.streak.n >= 3) out.push(fill(take(x.streak.kind === "W" ? NEWS.hot : NEWS.cold), { a: aka(x.id), n: x.streak.n }));
      if (x.absences >= 2) out.push(fill(take(NEWS.ghost), { a: aka(x.id), n: x.absences }));
      if (x.victim && x.victim.n >= 3) out.push(fill(take(NEWS.nemesis), { a: aka(x.id), b: aka(x.victim.id), n: x.victim.n }));
    });
    out.push(take(NEWS.filler));
    return shuffle(r, out).slice(0, 6);
  }

  // ----- personal ID codes -------------------------------------------------------
  // Each profile gets a code like K7QM-2XPA-9DHN (12 chars, ~60 bits). Only a salted,
  // slow hash (PBKDF2-SHA256) is stored in the league data, which every player can read,
  // so nobody can work out someone else's code from it.
  const CODE_ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";          // no 0/O, 1/I/L
  const CODE_ITER = 60000;
  function newCode() {
    const r = crypto.getRandomValues(new Uint8Array(12)); let c = "";
    for (let i = 0; i < 12; i++) { c += CODE_ABC[r[i] % CODE_ABC.length]; if (i === 3 || i === 7) c += "-"; }
    return c;
  }
  const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const fromB64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
  async function hashCode(code, saltB64) {
    const salt = saltB64 ? fromB64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(normCode(code)), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: CODE_ITER }, key, 256);
    return { codeHash: toB64(bits), codeSalt: toB64(salt) };
  }
  // the player whose code this is, or null
  async function findByCode(doc, code) {
    if (normCode(code).length !== 12) return null;
    for (const p of doc.players) {
      if (!p.codeHash || !p.codeSalt) continue;
      if ((await hashCode(code, p.codeSalt)).codeHash === p.codeHash) return p;
    }
    return null;
  }

  // ----- the super admin's code list ------------------------------------------------
  // Every new ID code is also sealed (ECDH P-256 + AES-GCM) to the super admin's public
  // key and stored on the player as codeBox. The matching private key is stored in the
  // league data only wrapped (AES-GCM) with a key derived from the super admin's own ID
  // code, so only the super admin can open the list. doc.vault = {pub, wrapped, updatedAt}
  const S = () => crypto.subtle;
  const VAULT_ITER = 200000;
  async function wrapKeyFromCode(code, saltB64) {
    const salt = saltB64 ? fromB64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
    const base = await S().importKey("raw", new TextEncoder().encode(normCode(code)), "PBKDF2", false, ["deriveKey"]);
    const key = await S().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: VAULT_ITER }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return { key, salt: toB64(salt) };
  }
  async function wrapPrivate(pkcs8B64, code) {
    const { key, salt } = await wrapKeyFromCode(code), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await S().encrypt({ name: "AES-GCM", iv }, key, fromB64(pkcs8B64));
    return { salt, iv: toB64(iv), ct: toB64(ct) };
  }
  // new vault for a brand-new super admin; returns { vault, pkcs8 } (pkcs8 = unlocked private key)
  async function createVault(superCode) {
    const kp = await S().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
    const pub = toB64(await S().exportKey("spki", kp.publicKey)), pkcs8 = toB64(await S().exportKey("pkcs8", kp.privateKey));
    return { vault: { pub, wrapped: await wrapPrivate(pkcs8, superCode), updatedAt: Date.now() }, pkcs8 };
  }
  // super admin changed their own code: same keys, re-wrapped with the new code
  async function rewrapVault(vault, pkcs8, newCode) {
    return { ...vault, wrapped: await wrapPrivate(pkcs8, newCode), updatedAt: Date.now() };
  }
  // super admin's code -> unlocked private key (pkcs8, base64), or null if the code is wrong
  async function unlockVault(vault, code) {
    if (!vault) return null;
    try {
      const { key } = await wrapKeyFromCode(code, vault.wrapped.salt);
      return toB64(await S().decrypt({ name: "AES-GCM", iv: fromB64(vault.wrapped.iv) }, key, fromB64(vault.wrapped.ct)));
    } catch { return null; }
  }
  async function sealCode(vault, code) {
    if (!vault) return null;
    const pub = await S().importKey("spki", fromB64(vault.pub), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const eph = await S().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
    const key = await S().deriveKey({ name: "ECDH", public: pub }, eph.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await S().encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(code));
    return { epk: toB64(await S().exportKey("spki", eph.publicKey)), iv: toB64(iv), ct: toB64(ct) };
  }
  async function openCode(pkcs8B64, box) {
    if (!box) return null;
    try {
      const priv = await S().importKey("pkcs8", fromB64(pkcs8B64), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
      const epk = await S().importKey("spki", fromB64(box.epk), { name: "ECDH", namedCurve: "P-256" }, false, []);
      const key = await S().deriveKey({ name: "ECDH", public: epk }, priv, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      return new TextDecoder().decode(await S().decrypt({ name: "AES-GCM", iv: fromB64(box.iv) }, key, fromB64(box.ct)));
    } catch { return null; }
  }

  // ----- Department of Justice ---------------------------------------------
  const VERDICTS = [
    "CASE DISMISSED: skill issue.",
    "GUILTY. Sentence: you play 3v3 on his team next week.",
    "The court has reviewed the replay and is still laughing.",
    "Complaint rejected. The judge was on the other team.",
    "Objection overruled. Have you tried building more tanks?",
    "The court finds the map not guilty. Again.",
    "Case adjourned until you win a set.",
    "Verdict: emotional damages awarded: 0.5 points (deducted from you).",
    "The jury voted unanimously: “I will work!” Translation: get back to work.",
  ];
  const verdict = (seed) => pick(rng("doj:" + seed), VERDICTS);

  // ----- GitHub contents API ---------------------------------------------------
  const FILE = "league.json";
  const b64encode = (str) => { const bytes = new TextEncoder().encode(str); let bin = "";
    bytes.forEach((b) => { bin += String.fromCharCode(b); }); return btoa(bin); };
  const b64decode = (b64) => { const bin = atob(b64.replace(/\s/g, ""));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); };
  function api(fetchFn, conn, method, path, body) {
    return fetchFn(`https://api.github.com/repos/${conn.repo}/${path}`, {
      method, cache: "no-store",
      headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  // Pull, merge, push if changed (skipped for read-only players).
  // Resolves to { doc, status: "ok" | "auth" | "offline" }.
  async function syncDoc(fetchFn, conn, local, opts = {}) {
    let doc = local;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await api(fetchFn, conn, "GET", "contents/" + FILE);
        let remote = null, sha;
        if (r.status === 401 || r.status === 403) return { doc, status: "auth" };
        if (r.status !== 404) {
          if (!r.ok) return { doc, status: "offline" };
          const j = await r.json(); sha = j.sha; remote = JSON.parse(b64decode(j.content));
        } else {
          // No league file. GitHub also says 404 for a repo the key can't see, so ask
          // about the repo itself: reachable = a brand-new, empty league.
          const repo = await fetchFn(`https://api.github.com/repos/${conn.repo}`, { cache: "no-store",
            headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
          if (repo.status === 401 || repo.status === 403 || repo.status === 404) return { doc, status: "auth" };
          if (!repo.ok) return { doc, status: "offline" };
          // never start a league in a PUBLIC repo: everyone on the internet could read it
          if (!(await repo.json()).private) return { doc, status: "public" };
          if (opts.readOnly) return { doc, status: "ok" };      // empty league; nothing to read yet
        }
        doc = merge(doc, remote);
        if (opts.onMerged) opts.onMerged(doc);
        if (opts.readOnly) return { doc, status: "ok" };
        if (remote && JSON.stringify(merge(remote, null)) === JSON.stringify(doc)) return { doc, status: "ok" };
        const put = await api(fetchFn, conn, "PUT", "contents/" + FILE, { message: opts.message || "Update league",
          content: b64encode(JSON.stringify(doc, null, 1)), ...(sha ? { sha } : {}) });
        if (put.ok) return { doc, status: "ok" };
        if (put.status === 409 || put.status === 422) continue;
        if (put.status === 401 || put.status === 403 || put.status === 404) return { doc, status: "auth" };
        return { doc, status: "offline" };
      }
      return { doc, status: "offline" };
    } catch { return { doc, status: "offline" }; }
  }

  // Super admin: list earlier versions, and restore one (bumps the epoch so
  // every phone drops its stale copy instead of merging the bad state back in)
  async function history(fetchFn, conn) {
    const r = await api(fetchFn, conn, "GET", `commits?path=${FILE}&per_page=20`);
    if (!r.ok) throw new Error("http " + r.status);
    return (await r.json()).map((c) => ({ sha: c.sha, date: c.commit.committer.date, message: c.commit.message }));
  }
  async function restore(fetchFn, conn, commitSha) {
    const old = await api(fetchFn, conn, "GET", `contents/${FILE}?ref=${commitSha}`);
    if (!old.ok) throw new Error("http " + old.status);
    const oldDoc = JSON.parse(b64decode((await old.json()).content));
    const cur = await api(fetchFn, conn, "GET", "contents/" + FILE);
    if (!cur.ok) throw new Error("http " + cur.status);
    const curJ = await cur.json(), curDoc = JSON.parse(b64decode(curJ.content));
    const doc = merge({ ...oldDoc, epoch: Math.max(curDoc.epoch || 0, oldDoc.epoch || 0) + 1 }, null);
    const put = await api(fetchFn, conn, "PUT", "contents/" + FILE, { message: "Restore version " + commitSha.slice(0, 7),
      content: b64encode(JSON.stringify(doc, null, 1)), sha: curJ.sha });
    if (!put.ok) throw new Error("http " + put.status);
    return doc;
  }

  return { emptyDoc, merge, sigOf, displayName, newCode, normCode, hashCode, findByCode,
    createVault, rewrapVault, unlockVault, sealCode, openCode, currentSeason, inactiveAt, isActiveNow, eligible, player, nightsOf, gamesOf,
    nightReport, standings, roastLines, headlines, verdict, syncDoc, history, restore, rng };
})();
if (typeof module !== "undefined") module.exports = ZH;
