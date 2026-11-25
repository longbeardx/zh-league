"use strict";
/* ZH League — screens. Scores/sync: league.js (ZH). Votes/accusations/complaints: social.js (ZS). */
(() => {
  const $ = (id) => document.getElementById(id);
  const VERSION = 46;                                 // keep equal to CACHE in sw.js ("zh-league-v46")
  // Tiny safe DOM builder: text is always inserted as text, never as HTML.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "style") el.setAttribute("style", v);
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  const LS = {
    get(k, d) { try { const v = localStorage.getItem("zh." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("zh." + k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem("zh." + k); } catch {} },
  };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const toast = (msg) => { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove("show"), 2600); };
  const pts = (n) => (n > 0 ? "+" : "") + (Number.isInteger(n) ? n : n.toFixed(1));
  const dayLabel = (ts) => new Date(ts).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const ago = (ts) => { const m = Math.round((Date.now() - ts) / 60000);
    return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" }); };
  const GLA = ["I will work!", "Do not hurt me!", "Yes, boss?", "Working…", "We will rebuild!"];
  const gla = () => GLA[Math.floor(Math.random() * GLA.length)];
  const SIGNATURES = ["", "🍆", "🥊", "🗡️", "💣", "🧨", "🔥", "🐓", "🦂", "🪓", "🧄", "🥾", "🍑", "🐍", "👊", "🫵", "🐐", "👻", "🦍", "🥔"];
  const CRIMES = ["Suspicious amount of luck 🍀", "Teams were unfairly distributed. Every single time ⚖️",
    "Too many Auroras. Nobody needs that many Auroras ✈️", "Camped behind 14 Patriots and called it “strategy” 🛡️",
    "Left “to get water” and came back after we lost 🚰"];
  const ACCUSE_PROMPTS = ["Describe the crime. Be dramatic.", "What did he do this time?", "Tell the court everything. Leave out nothing.",
    "Explain, slowly, how he ruined your night.", "Speak. The court is (mostly) listening."];

  // ----- links: …/#join=<base64url {"r":repo,"t":shared key,"c"?:personal ID code}> -----
  // Group link = repo + shared key (then you type your ID code). A personal link also
  // carries the ID code, so opening it logs you straight in.
  (function readLink() {
    const m = location.hash.match(/join=([A-Za-z0-9_-]+)/);
    if (!m) return;
    try {
      const c = JSON.parse(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (c.r && c.t) {
        const old = LS.get("conn", null);
        if (!old || old.token !== c.t || old.repo !== c.r) LS.del("me");     // a different league/key: log out first
        LS.set("conn", { repo: c.r, token: c.t, ...(old && old.demo && old.token === c.t ? { demo: true } : {}) });   // keep local preview mode
        if (c.c) LS.set("pendingCode", c.c);
      }
    } catch {}
    history.replaceState(null, "", location.pathname + location.search);
  })();
  const makeLink = (repo, token, code) => location.origin + location.pathname + "#join=" +
    btoa(JSON.stringify(code ? { r: repo, t: token, c: code } : { r: repo, t: token })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  let conn = LS.get("conn", null);
  let doc = ZH.merge(LS.get("doc", null), null);
  let events = LS.get(conn && conn.demo ? "demoSocial" : "social", []);   // votes, accusations, complaints
  let me = LS.get("me", null);                      // set by your personal ID code; nobody picks a name
  let loaded = !!(conn && conn.demo) || doc.players.length > 0;   // league data received at least once
  let keyProblem = false;                                          // the key couldn't open the league
  let tab = "nights";                                // the app always opens on Nights…
  { const m = location.hash.match(/^#t=(nights|rank|feed|justice|bets|admin)$/);   // …unless linked to a tab (#t=feed)
    if (m) { tab = m[1]; history.replaceState(null, "", location.pathname + location.search); } }
  let seasonId = null;
  let openPlayer = null, openNight = LS.get("openNight", null);
  // Roles live on the profile: the first profile of a new league is the super admin,
  // and the super admin switches "admin" on/off for anyone, live.
  const role = () => { const p = me && ZH.player(doc, me); return !p ? "player" : p.role === "super" ? "super" : p.admin ? "admin" : "player"; };
  const isAdmin = () => role() === "admin" || role() === "super";
  const isSuper = () => role() === "super";
  const saveLocal = () => LS.set("doc", doc);
  const P = (id) => ZH.player(doc, id);
  const aka = (id) => ZH.displayName(P(id));          // CAPS name + optional signature emoji, e.g. "DARK GOAT 🍆"
  const nm = (p) => ZH.displayName(p);
  const up = (name) => String(name || "").toUpperCase();
  const playersSorted = () => doc.players.slice().sort((a, b) => a.aka.localeCompare(b.aka));

  // ----- sync: scores (league.json) + social log ------------------------------------
  let syncing = null, again = false;
  const setStatus = (kind, text) => { $("dot").className = "dot " + kind; $("syncText").textContent = text;
    $("syncBtn").classList.toggle("quiet", kind === "ok"); $("syncBtn").title = text; };
  function sync(message) {
    if (!conn) return Promise.resolve();
    if (conn.demo) { setStatus("busy", "Demo ⇄"); return Promise.resolve(); }   // local preview: never touches GitHub
    if (syncing) { again = true; return syncing; }
    setStatus("busy", "Syncing…");
    syncing = ZH.syncDoc(fetch.bind(window), conn, doc, { readOnly: !isAdmin(), message,
      onMerged: (m) => { doc = m; saveLocal(); render(); } })
      .then(async ({ doc: d, status }) => {
        doc = d; saveLocal();
        if (status === "ok") {
          loaded = true; keyProblem = false;
          const pending = LS.get("pendingCode", null);
          if (pending) { LS.del("pendingCode"); await tryLogin(pending); }
          if (me && !P(me)) { me = null; LS.del("me"); }   // profile was deleted
          try { events = await ZS.load(fetch.bind(window), conn); LS.set("social", events); } catch {}
          LS.set("dirty", false); setStatus("ok", "Synced");
          pingVisit();
        } else if (status === "auth") { setStatus("err", "Key expired or wrong"); if (!me) keyProblem = true; }
        else if (status === "public") { setStatus("err", "Public repo"); if (!me) keyProblem = "public"; }
        else setStatus("err", LS.get("dirty", false) ? "Offline · will sync" : "Offline");
        render();
      })
      .finally(() => { syncing = null; if (again) { again = false; sync(); } });
    return syncing;
  }
  function change(message, mutator) {
    if (!isAdmin()) return;
    mutator(doc); doc = ZH.merge(doc, null); LS.set("dirty", true); saveLocal(); render(); sync(message);
  }
  // post a social event (vote / accusation / side / complaint); shows instantly
  async function postEvent(ev) {
    if (!me) { toast("Pick who you are first (Me tab)."); return false; }
    const full = { ...ev, by: me, at: Date.now() };
    if (conn.demo) { events.push({ ...full, cid: uid() }); LS.set("demoSocial", events); render(); return true; }
    const temp = { ...full, cid: "pending-" + uid() }; events.push(temp); render();
    try {
      const saved = await ZS.post(fetch.bind(window), conn, full);
      events = events.map((e) => (e === temp ? saved : e)); LS.set("social", events); render(); return true;
    } catch {
      events = events.filter((e) => e !== temp); render(); toast("Couldn't post: check your connection."); return false;
    }
  }
  async function deleteEvent(ev) {
    if (!confirm("Delete this post for everyone?")) return;
    if (!conn.demo) { try { await ZS.remove(fetch.bind(window), conn, ev.cid); } catch { toast("Couldn't delete: check your connection."); return; } }
    events = events.filter((e) => e.cid !== ev.cid); LS.set(conn.demo ? "demoSocial" : "social", events); render(); toast("Deleted.");
  }

  // ----- activity: one tiny "seen" ping per visit (30 min away = new visit) ------------------
  // Only the super admin sees the report (Admin → Activity report).
  function countTab(t) { const c = LS.get("act.tabs", {}); c[t] = (c[t] || 0) + 1; LS.set("act.tabs", c); }
  let pinging = false;
  async function pingVisit() {
    if (!conn || !me || !P(me) || pinging || document.visibilityState !== "visible") return;
    const now = Date.now(), lastActive = LS.get("act.active", 0);
    LS.set("act.active", now);
    if (now - lastActive < ZA.GAP) return;             // still the same visit
    const start = LS.get("act.start", 0), end = LS.get("act.end", 0);   // the previous visit
    const dur = start && end > start && end - start < 6 * 3600e3 ? Math.round((end - start) / 1000) : 0;
    const ev = { t: "seen", by: me, at: now, v: VERSION, ...(dur ? { dur } : {}), dev: matchMedia("(pointer: coarse)").matches ? "phone" : "desktop",
      app: matchMedia("(display-mode: standalone)").matches, tabs: LS.get("act.tabs", {}),
      ...(LS.get("act.exit", null) ? { exit: LS.get("act.exit", null) } : {}) };   // where the previous visit ended
    const done = () => { LS.set("act.tabs", {}); LS.del("act.exit"); LS.del("act.end"); LS.set("act.start", now); };
    if (conn.demo) { const a = LS.get("demoActivity", []); a.push(ev); LS.set("demoActivity", a); done(); return; }
    pinging = true;
    try { await ZA.ping(fetch.bind(window), conn, ev); done(); }
    catch { LS.set("act.active", lastActive); }       // try again on the next sync
    finally { pinging = false; }
  }

  // ----- shell --------------------------------------------------------------------------
  function render() {
    if (conn && !me && keyProblem) {
      $("repo").value = conn.repo; $("connectErr").hidden = false;
      $("connectErr").textContent = keyProblem === "public"
        ? "“" + conn.repo + "” is a PUBLIC repository. League data must live in a private one (e.g. your …-data repo). Check the repository name."
        : "This key can't open the league. On GitHub, check the key: repository access must include " +
          conn.repo.split("/")[1] + ", with Contents and Issues set to “Read and write”. Then paste it again.";
      conn = null; LS.del("conn"); keyProblem = false;
    }
    const connected = !!conn, inside = connected && !!me && !!P(me);
    const firstRun = connected && !me && loaded && doc.players.length === 0;
    $("connectView").hidden = connected;
    $("loginView").hidden = !connected || inside || firstRun;
    $("firstRunView").hidden = !firstRun;
    $("app").hidden = !inside; $("tabs").hidden = !inside;
    if (!connected) { setStatus("", "Locked"); $("seasonPick").hidden = true; return; }
    if (!inside) { $("seasonPick").hidden = true; if (!loaded && !syncing) setStatus("busy", "Loading…"); return; }
    $("adminTabLabel").textContent = isAdmin() ? "Admin" : "Me";
    const seasons = doc.seasons.slice().sort((a, b) => b.startTs - a.startTs);
    const cur = ZH.currentSeason(doc);
    if (!seasonId || !doc.seasons.some((s) => s.id === seasonId)) seasonId = cur ? cur.id : (seasons[0] || {}).id || null;
    const sp = $("seasonPick"); sp.hidden = !seasons.length; sp.innerHTML = "";
    seasons.forEach((s) => sp.append(h("option", { value: s.id, selected: s.id === seasonId }, s.name + (s.endTs ? " (ended)" : ""))));
    document.querySelectorAll("nav.tabs button").forEach((b) => b.setAttribute("aria-current", b.dataset.tab === tab ? "page" : "false"));
    ["nights", "rank", "feed", "justice", "bets", "admin"].forEach((t) => { $("tab-" + t).hidden = t !== tab; });
    ({ rank: renderRank, nights: renderNights, feed: renderFeed, justice: renderJustice, bets: renderBets, admin: renderAdmin })[tab]();
  }
  const noSeason = () => h("div", { class: "card" }, h("span", { class: "empty" },
    isSuper() ? "No season yet. Start Season 26 in the Admin tab." : "No season has started yet. The generals are still loading…"));

  // ----- the "get upset" toggle (your own profile only) -------------------------------------
  function upsetToggle() {
    const upset = !!(ZS.moods(events)[me] || {}).upset;
    return h("button", { class: "btn " + (upset ? "secondary" : "danger"), type: "button", onclick: async (ev) => {
      ev.stopPropagation();
      if (await postEvent({ t: "mood", upset: !upset }))
        toast(upset ? "😌 You calmed down. Proud of you." : "😤 You are now officially upset. Everyone has been notified.");
    } }, upset ? "😌 Calm down" : "😤 Get upset");
  }

  // ----- Ranking: only the top (👑) and the bottom (💩) get an icon ----------------------
  function renderRank() {
    const box = $("tab-rank"); box.innerHTML = "";
    if (!seasonId) { box.append(noSeason()); return; }
    const season = doc.seasons.find((s) => s.id === seasonId);
    const table = ZH.standings(doc, seasonId);
    const social = ZS.profileCounts(events, ZH.nightsOf(doc, seasonId)), mood = ZS.moods(events), status = ZS.statuses(events);
    const card = h("div", { class: "card" }, h("h2", {}, season.name + (season.endTs ? " · final standings" : " · standings")));
    if (!table.length) card.append(h("span", { class: "empty" }, "No players yet."));
    table.forEach((r, i) => {
      const p = P(r.id), n = table.length, s = social[r.id] || { mvp: 0, noob: 0, accused: 0, accusations: 0 };
      const icon = n >= 2 && i === 0 ? "👑" : n >= 2 && i === n - 1 ? "💩" : "";
      card.append(h("div", { class: "rank" + (i === 0 && n >= 2 ? " top" : "") + (r.id === me ? " me" : "") + (ZH.isActiveNow(p) ? "" : " inactive"),
        onclick: () => { openPlayer = openPlayer === r.id ? null : r.id; render(); } },
        h("div", { class: "pos" }, i + 1),
        h("div", { class: "badge" }, icon),
        h("div", { class: "who" }, h("b", {}, nm(p)), (mood[r.id] || {}).upset ? h("span", { class: "upset" }, "😤 UPSET") : null,
          status[r.id] ? h("span", { class: "status" }, "“" + status[r.id].text + "”") : null),
        h("div", { class: "pts" }, pts(r.pts), h("small", {}, `${r.w}W–${r.l}L`))));
      if (openPlayer === r.id) {
        const pct = r.games ? Math.round(r.winRate * 100) + "%" : "—";
        card.append(h("div", { class: "detail" },
          h("div", {}, "Sets: ", h("b", {}, r.games)), h("div", {}, "Win rate: ", h("b", {}, pct)),
          h("div", {}, "Nights played: ", h("b", {}, r.nightsPlayed)), h("div", {}, "Absences: ", h("b", {}, r.absences)),
          h("div", {}, "🏅 MVP of the night: ", h("b", {}, s.mvp + "×")), h("div", {}, "🤡 Noob of the night: ", h("b", {}, s.noob + "×")),
          h("div", {}, "Accusations made: ", h("b", {}, s.accusations)), h("div", {}, "Times accused: ", h("b", {}, s.accused)),
          h("div", {}, "Streak: ", h("b", {}, r.streak ? `${r.streak.n} ${r.streak.kind === "W" ? "win" : "loss"}${r.streak.n > 1 ? (r.streak.kind === "W" ? "s" : "es") : ""}` : "—")),

          h("div", {}, "Nemesis: ", h("b", {}, r.nemesis ? `${aka(r.nemesis.id)} (${r.nemesis.n})` : "none yet")),
          h("div", {}, "Favourite victim: ", h("b", {}, r.victim ? `${aka(r.victim.id)} (${r.victim.n})` : "none yet")),
          h("div", {}, "Best teammate: ", h("b", {}, r.bestMate ? `${aka(r.bestMate.id)} (${r.bestMate.n} wins)` : "—")),
          h("div", {}, "Status: ", h("b", {}, ZH.isActiveNow(p) ? "active" : "on leave")),
          r.id === me ? h("div", { class: "q", style: "font-style:normal" }, upsetToggle()) : null,
          i === n - 1 && n >= 2 ? h("div", { class: "q" }, "“Do not hurt me!” — " + nm(p) + ", probably") :
          i === 0 && n >= 2 ? h("div", { class: "q" }, "Supreme commander of " + season.name + ". Bow accordingly.") : null));
      }
    });
    box.append(card);
    box.append(h("p", { class: "rules" }, "Win +3 · Loss −1 · Skipped a night −0.5 · Tap a player for stats"));
    const ended = doc.seasons.filter((s) => s.endTs).sort((a, b) => b.endTs - a.endTs);
    const hof = h("div", { class: "card" }, h("h2", {}, "Hall of Fame (and Shame)"));
    ended.forEach((s) => {
      const t = ZH.standings(doc, s.id).filter((r) => r.games || r.absences);
      if (t.length < 2) return;
      hof.append(h("div", { class: "prow" }, h("div", { class: "who" }, h("b", {}, s.name),
        h("small", {}, `👑 ${aka(t[0].id)} (${pts(t[0].pts)})  ·  💩 ${aka(t[t.length - 1].id)} (${pts(t[t.length - 1].pts)})`))));
    });
    if (hof.children.length > 1) box.append(hof);
  }

  // ----- Nights: latest night big, older ones compact; forms only when asked ------------
  let gameDraft = null, newNightOpen = false, gameOpen = null;
  function renderNights() {
    const box = $("tab-nights"); box.innerHTML = "";
    if (!seasonId) { box.append(noSeason()); return; }
    const season = doc.seasons.find((s) => s.id === seasonId);
    const writable = isAdmin() && !season.endTs;
    box.append(h("div", { class: "bar-title" }, h("h2", {}, "Nights · " + season.name + (season.endTs ? " (ended)" : "")),
      writable ? h("button", { class: "btn small", type: "button", onclick: () => { newNightOpen = !newNightOpen; render(); } }, newNightOpen ? "Cancel" : "+ New night") : null));
    if (writable && newNightOpen) {
      const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      const dt = h("input", { class: "t", type: "datetime-local", value: now, "aria-label": "Night date" });
      box.append(h("div", { class: "card" }, h("label", { class: "f" }, "When"), dt,
        h("button", { class: "btn", type: "button", onclick: () => {
          const ts = new Date(dt.value).getTime() || Date.now(), id = uid();
          change("Add night", (d) => d.nights.push({ id, seasonId, ts, updatedAt: Date.now() }));
          newNightOpen = false; openNight = id; gameOpen = id; toast("Night created. “I will work!”");
        } }, "Start the night")));
    }
    const nights = ZH.nightsOf(doc, seasonId).slice().reverse();
    if (!nights.length) { box.append(h("div", { class: "card" }, h("span", { class: "empty" }, "No nights yet. Suspiciously peaceful."))); return; }
    box.append(nightPanel(nights[0], writable));
    const older = nights.slice(1);
    if (older.length) {
      const list = h("div", { class: "card" }, h("h2", {}, "Earlier nights"));
      older.forEach((n) => {
        if (openNight === n.id) { list.append(nightPanel(n, writable, true)); return; }
        const rep = ZH.nightReport(doc, n), v = ZS.nightVotes(events, n.id, me);
        const mvp = ZS.winners(v.mvp), noob = ZS.winners(v.noob);
        list.append(h("div", { class: "older", onclick: () => { openNight = n.id; render(); } },
          h("div", {}, h("b", {}, dayLabel(n.ts)), h("small", {}, ` · ${rep.games.length} set${rep.games.length === 1 ? "" : "s"}`)),
          h("small", {}, (mvp.length ? "🏅 " + mvp.map(aka).join(", ") + "  " : "") + (noob.length ? "🤡 " + noob.map(aka).join(", ") : "") || "›")));
      });
      box.append(list);
    }
  }

  function nightPanel(n, writable, nested) {
    const rep = ZH.nightReport(doc, n), votes = ZS.nightVotes(events, n.id, me);
    const mvp = ZS.winners(votes.mvp), noob = ZS.winners(votes.noob);
    const panel = h("div", nested ? { class: "sub" } : { class: "card" });
    panel.append(h("div", { class: "night-head", onclick: nested ? () => { openNight = null; render(); } : null },
      h("span", { class: "date" }, dayLabel(n.ts)), h("span", { class: "count" }, `${rep.games.length} set${rep.games.length === 1 ? "" : "s"}` + (nested ? "  ▴" : ""))));
    if (mvp.length || noob.length) panel.append(h("div", { class: "awards" },
      mvp.length ? h("span", { class: "award" }, "🏅 MVP: " + mvp.map(aka).join(", ")) : null,
      noob.length ? h("span", { class: "award" }, "🤡 Noob: " + noob.map(aka).join(", ")) : null));
    const games = h("div", { style: "margin-top:6px" });
    rep.games.forEach((g) => games.append(h("div", { class: "game" },
      h("span", { class: "type" }, g.type),
      h("span", { class: "team " + (g.winner === "A" ? "won" : "lost") }, g.teamA.map(aka).join(", ")),
      h("span", { class: "vs" }, "VS"),
      h("span", { class: "team " + (g.winner === "B" ? "won" : "lost") }, g.teamB.map(aka).join(", ")),
      writable ? h("button", { class: "x", type: "button", "aria-label": "Delete set", onclick: () => {
        if (confirm("Delete this set?")) change("Delete set", (d) => d.deleted.push(g.id)); } }, "✕") : h("span"))));
    if (!rep.games.length) games.append(h("p", { class: "note" }, "No sets yet."));
    panel.append(games);
    if (rep.absent.length) panel.append(h("div", { class: "absent" }, "−0.5 for skipping: " + rep.absent.map(aka).join(", ")));
    const lines = ZH.roastLines(doc, n);
    const said = ZS.radioStatements(events, n.id);
    if (lines.length || said.length) panel.append(radioTicker(n.id, lines, said));
    if (rep.games.length && ZS.votingOpen(n)) panel.append(radioInput(n));
    const mine = said.filter((e) => e.by === me || isAdmin());
    if (mine.length) panel.append(h("div", { class: "radio-mine" }, mine.map((e) => h("div", {},
      h("span", {}, (e.by === me ? "You" : aka(e.by)) + ": “" + e.text + "”"),
      String(e.cid).startsWith("pending") ? null : h("button", { class: "xbtn", type: "button", "aria-label": "Delete transmission", onclick: () => deleteEvent(e) }, "✕")))));
    if (rep.games.length) panel.append(voteBox(n, rep, votes));
    if (writable) {
      if (gameOpen === n.id) panel.append(gameForm(n));
      else panel.append(h("button", { class: "btn", type: "button", onclick: () => { gameOpen = n.id; render(); } }, "+ Add set"));
    }
    if (isSuper()) panel.append(h("button", { class: "linkbtn", type: "button", onclick: () => {
      if (confirm(`Delete the whole night of ${dayLabel(n.ts)} and its ${rep.games.length} sets?`))
        change("Delete night", (d) => { d.deleted.push(n.id); rep.games.forEach((g) => d.deleted.push(g.id)); });
    } }, "Delete this night"));
    return panel;
  }

  // Radio chatter as a scrolling LED ticker (display only)
  function radioTicker(key, lines, said) {
    // players' statements first (in their own colour), then the radio chatter
    const items = [...said.map((e) => ({ t: `📢 ${aka(e.by)}: ${e.text}`, player: true })), ...lines.map((l) => ({ t: l }))];
    const sep = () => h("span", { class: "sep" }, "   ✦   ");
    const strip = () => h("span", {}, items.flatMap((x) => [h("span", { class: x.player ? "said" : null }, x.t), sep()]));
    const chars = items.reduce((n, x) => n + x.t.length + 7, 0);
    const secs = Math.max(12, Math.round(chars / 7));                 // ~7 characters per second
    return h("div", { class: "radio-ticker", "aria-label": "Radio: " + items.map((x) => x.t).join(" · ") },
      h("span", { class: "tag" }, "📻 RADIO"),
      h("div", { class: "track", "aria-hidden": "true" },
        h("div", { class: "belt", style: `animation-duration:${secs}s` }, strip(), strip())),
      h("div", { class: "full" }, items.map((x) => h("p", { class: x.player ? "said" : null }, x.t))));   // reduced-motion users
  }
  // say something on a night's radio (open while voting is open)
  const radioDrafts = {};
  function radioInput(night) {
    if (!me) return null;
    const used = ZS.radioStatements(events, night.id).filter((e) => e.by === me).length;
    if (used >= ZS.RADIO_MAX) return h("p", { class: "note radio-used" }, "📡 You've used both transmissions for this night.");
    const inp = h("input", { class: "t radio-in", maxlength: 80, placeholder: "Say something on the radio…", value: radioDrafts[night.id] || "",
      oninput: (e) => { radioDrafts[night.id] = e.target.value; },
      onkeydown: (e) => { if (e.key === "Enter") send(); } });
    const send = async () => {
      const text = (radioDrafts[night.id] || "").trim().replace(/\s+/g, " ").slice(0, 80);
      if (!text) { toast("Radio silence. Very mysterious."); return; }
      if (ZS.radioStatements(events, night.id).filter((e) => e.by === me).length >= ZS.RADIO_MAX) { toast("Two transmissions per night. The radio needs a break."); return; }
      radioDrafts[night.id] = "";                                     // clear first (posting redraws the screen)
      if (await postEvent({ t: "radio", night: night.id, text })) toast("📡 Transmitted. Everyone heard that.");
      else { radioDrafts[night.id] = text; render(); }                 // keep it if it failed
    };
    return h("div", { class: "radio-say" }, inp, h("button", { class: "btn small", type: "button", onclick: send }, "📡 Transmit"));
  }

  function voteBox(night, rep, votes) {
    const played = Object.keys(rep.per).sort((a, b) => aka(a).localeCompare(aka(b)));
    const open = ZS.votingOpen(night);
    const wrap = h("div", { class: "sub" }, h("label", { class: "f", style: "margin-top:0" }, open ? "Vote · open for " + ZS.VOTE_DAYS + " days" : "Votes · closed"));
    const row = (cat, label) => {
      wrap.append(h("div", { class: "note", style: "margin:8px 0 6px" }, label));
      wrap.append(h("div", { class: "seg" }, played.map((id) => {
        const n = votes[cat][id] || 0, mine = votes.mine[cat] === id, selfMvp = cat === "mvp" && id === me;
        return h("button", { type: "button", "aria-pressed": String(mine), disabled: !open || !me || selfMvp, title: selfMvp ? "Nice try." : null,
          onclick: async () => { const target = mine ? null : id;
            if (await postEvent({ t: "vote", night: night.id, cat, target }))
              toast(target ? (cat === "mvp" ? `🏅 Voted ${aka(id)} MVP.` : `🤡 Voted ${aka(id)} noob. Brutal.`) : "Vote removed."); } },
          aka(id) + (n ? ` · ${n}` : ""));
      })));
    };
    row("mvp", "🏅 MVP of the night");
    row("noob", "🤡 Noob of the night (yes, you can vote yourself)");
    if (!me) wrap.append(h("p", { class: "note" }, "Pick who you are in the Me tab to vote."));
    return wrap;
  }

  function gameForm(night) {
    if (!gameDraft || gameDraft.nightId !== night.id) gameDraft = { nightId: night.id, type: "1v1", A: [], B: [], winner: null };
    const g = gameDraft, size = +g.type[0];
    const wrap = h("div", { class: "sub" }, h("div", { class: "bar-title" }, h("h2", {}, "Add a set"),
      h("button", { class: "linkbtn", type: "button", onclick: () => { gameOpen = null; render(); } }, "Close")));
    const players = playersSorted().filter((p) => ZH.isActiveNow(p) || ZH.eligible(p, night));
    wrap.append(h("div", { class: "seg" }, ["1v1", "2v2", "3v3"].map((t) =>
      h("button", { type: "button", "aria-pressed": String(g.type === t), onclick: () => { g.type = t; g.A = g.A.slice(0, +t[0]); g.B = g.B.slice(0, +t[0]); render(); } }, t))));
    const side = (key, label) => {
      const other = key === "A" ? g.B : g.A, mine = g[key];
      return [h("label", { class: "f" }, `${label} (${mine.length}/${size})`),
        h("div", { class: "seg" }, players.map((p) => h("button", { type: "button", "aria-pressed": String(mine.includes(p.id)),
          disabled: other.includes(p.id) || (!mine.includes(p.id) && mine.length >= size),
          onclick: () => { const i = mine.indexOf(p.id); i >= 0 ? mine.splice(i, 1) : mine.push(p.id); if (!mine.length && g.winner === key) g.winner = null; render(); } },
          nm(p))))];
    };
    wrap.append(...side("A", "Team A"), ...side("B", "Team B"));
    wrap.append(h("label", { class: "f" }, "Who won the set?"));
    wrap.append(h("div", { class: "seg" }, ["A", "B"].map((k) =>
      h("button", { type: "button", "aria-pressed": String(g.winner === k), disabled: !g[k].length,
        onclick: () => { g.winner = k; render(); } }, "Team " + k + (g[k].length ? ": " + g[k].map(aka).join(", ") : "")))));
    const ready = g.A.length === size && g.B.length === size && g.winner;
    wrap.append(h("button", { class: "btn", type: "button", disabled: !ready, onclick: () => {
      const rec = { id: uid(), nightId: night.id, type: g.type, teamA: g.A.slice(), teamB: g.B.slice(), winner: g.winner, ts: Date.now(), updatedAt: Date.now() };
      change("Add set", (d) => d.games.push(rec));
      const winners = (g.winner === "A" ? g.A : g.B).map(aka).join(" & ");
      gameDraft = { nightId: night.id, type: g.type, A: [], B: [], winner: null };
      toast(`Victory for ${winners}! ${gla()}`);
    } }, "Save set"));
    return wrap;
  }

  // ----- Feed: the news + everything people did ---------------------------------------------
  function renderFeed() {
    const box = $("tab-feed"); box.innerHTML = "";
    if (seasonId) {
      const season = doc.seasons.find((s) => s.id === seasonId);
      const heads = ZH.headlines(doc, seasonId);
      const paper = h("div", { class: "card" },
        h("div", { class: "paper" }, h("b", {}, "The Zero Hour Times"),
          h("small", {}, `${season.name} edition · ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })} · price: one (1) supply crate`)));
      if (!heads.length) paper.append(h("span", { class: "empty" }, "Slow news day. Somebody please lose dramatically."));
      heads.slice(0, 5).forEach((t) => paper.append(h("div", { class: "headline" }, t)));
      const ns = ZH.nightsOf(doc, seasonId), lastN = ns[ns.length - 1];
      if (heads.length) paper.append(reactBar("news:" + seasonId + ":" + (lastN ? lastN.id : "none")));
      box.append(paper);
    }
    const allCases = ZS.cases(events, me), caseById = Object.fromEntries(allCases.map((c) => [c.id, c]));
    // one feed item per accusation/complaint; votes and side-picking grouped per person
    const items = [];
    const sidesSeen = new Set();
    events.slice().reverse().forEach((e) => {
      if (e.t === "accuse") items.push(accuseItem(caseById[e.id], e));
      else if (e.t === "complaint") items.push(complaintItem(e));
      else if (e.t === "status" && e.text) items.push(feedRow(e, "💬", `${aka(e.by)} set a status: “${e.text}”`, true));
      else if (e.t === "mood") items.push(feedRow(e, e.upset ? "😤" : "😌", `${aka(e.by)} ${e.upset ? "GOT UPSET" : "CALMED DOWN"} · ${ZS.moodLine(e)}`, true));
      else if (e.t === "vote" && e.target) {
        const night = doc.nights.find((n) => n.id === e.night);
        if (night) items.push(feedRow(e, e.cat === "mvp" ? "🏅" : "🤡",
          `${aka(e.by)} voted ${aka(e.target)} ${e.cat === "mvp" ? "MVP" : "noob"} of ${dayLabel(night.ts)}`));
      } else if (e.t === "side" && !sidesSeen.has(e.case + e.by) && caseById[e.case]) {
        sidesSeen.add(e.case + e.by);
        const c = caseById[e.case];
        items.push(feedRow(e, "🗳️", `${aka(e.by)} sided with ${aka(e.side === "accuser" ? c.by : c.target)} in “${aka(c.by)} vs ${aka(c.target)}”`));
      }
    });
    const card = h("div", { class: "card" }, h("h2", {}, "The feed"));
    if (!items.length) card.append(h("span", { class: "empty" }, "Nothing yet. Go accuse someone (Justice tab)."));
    items.slice(0, 80).forEach((x) => card.append(x));
    box.append(card);
  }
  // 🤬 FUCK THIS! / ✅ I ENDORSE THIS — one reaction per person per post
  function reactBar(target) {
    const r = ZS.reactions(events)[target] || { fuck: [], endorse: [] };
    const mine = r.fuck.includes(me) ? "fuck" : r.endorse.includes(me) ? "endorse" : null;
    const off = !me || !target || String(target).includes("pending");
    const b = (kind, label) => h("button", { type: "button", class: "react-btn " + kind, "aria-pressed": String(mine === kind), disabled: off,
      title: r[kind].length ? r[kind].map(aka).join(", ") : "Nobody yet",
      onclick: async (ev) => { ev.stopPropagation(); await postEvent({ t: "react", target, kind: mine === kind ? null : kind }); } },
      label + (r[kind].length ? " · " + r[kind].length : ""));
    return h("div", { class: "reacts" }, b("fuck", "🤬 FUCK THIS!"), b("endorse", "✅ I ENDORSE THIS"));
  }
  const delBtn = (e) => (isAdmin() || e.by === me) && !String(e.cid).startsWith("pending")
    ? h("button", { class: "xbtn", type: "button", "aria-label": "Delete post", onclick: () => deleteEvent(e) }, "✕") : null;
  const feedRow = (e, icon, text, reactable) => h("div", { class: "feed small" }, h("span", { class: "ico" }, icon),
    h("div", { class: "body" }, text, h("small", {}, ago(e.at)), reactable ? reactBar("post:" + e.cid) : null), delBtn(e));

  function accuseItem(c, e) {
    const sign = ZH.sigOf(P(c.by)) || "⚔️";
    const total = c.accuser.length + c.accused.length, pctA = total ? Math.round(100 * c.accuser.length / total) : 50;
    const party = me === c.by || me === c.target;
    const pick = async (side) => { const next = c.mySide === side ? null : side;
      if (await postEvent({ t: "side", case: c.id, side: next })) toast(next ? `You're with ${aka(side === "accuser" ? c.by : c.target)}.` : "You're neutral now. Coward."); };
    return h("div", { class: "feed case" },
      h("div", { class: "case-head" }, h("span", { class: "sign" }, sign),
        h("div", { class: "body" }, h("b", {}, `${aka(c.by)} accuses ${aka(c.target)}`), h("small", {}, ago(c.at))), delBtn(e)),
      c.charges && c.charges.length ? h("ul", { class: "charges" }, c.charges.map((x) => h("li", {}, x))) : null,
      c.text ? h("p", { class: "quote" }, "“" + c.text + "”") : null,
      h("div", { class: "tug" }, h("div", { class: "a", style: `width:${pctA}%` }), h("div", { class: "b", style: `width:${100 - pctA}%` })),
      h("div", { class: "tug-l" }, h("span", {}, `${aka(c.by)} · ${c.accuser.length}`), h("span", {}, `${c.accused.length} · ${aka(c.target)}`)),
      party ? h("p", { class: "note" }, "You're part of this one. No voting on your own drama.") :
      h("div", { class: "seg two" },
        h("button", { type: "button", "aria-pressed": String(c.mySide === "accuser"), disabled: !me, onclick: () => pick("accuser") }, `${aka(c.by)} is right`),
        h("button", { type: "button", "aria-pressed": String(c.mySide === "accused"), disabled: !me, onclick: () => pick("accused") }, `${aka(c.target)} is innocent`)),
      reactBar("case:" + c.id));
  }
  function complaintItem(e) {
    return h("div", { class: "feed case" },
      h("div", { class: "case-head" }, h("span", { class: "sign" }, "📮"),
        h("div", { class: "body" }, h("b", {}, `${aka(e.by)} filed a complaint`), h("small", {}, ago(e.at))), delBtn(e)),
      h("p", { class: "quote" }, "“" + e.text + "”"),
      h("div", { class: "stamp-row" }, h("span", { class: "stamp" }, e.verdict || "RECEIVED. IGNORED.")),
      reactBar("post:" + e.cid));
  }

  // ----- Justice: two big buttons, one form at a time ---------------------------------------
  let accuseDraft = null, complaintDraft = null, justiceMode = null;
  function renderJustice() {
    const box = $("tab-justice"); box.innerHTML = "";
    box.append(h("div", { class: "card doj" }, h("b", {}, "⚖ Department of Justice"), h("small", { class: "note" }, "Everything filed here goes public in the feed.")));
    if (!me) { box.append(h("div", { class: "card" }, h("span", { class: "empty" }, "The court needs to know who you are. Pick yourself in the Me tab."))); return; }
    const mySign = ZH.sigOf(P(me)) || "⚔️";
    box.append(h("div", { class: "bigchoice" },
      h("button", { type: "button", "aria-pressed": String(justiceMode === "accuse"), onclick: () => { justiceMode = justiceMode === "accuse" ? null : "accuse"; render(); } }, h("span", {}, mySign), "Accuse someone"),
      h("button", { type: "button", "aria-pressed": String(justiceMode === "complain"), onclick: () => {
        justiceMode = justiceMode === "complain" ? null : "complain"; if (justiceMode && !complaintDraft) complaintDraft = { label: ZS.randomLabel(), text: "" }; render(); } }, h("span", {}, "📮"), "File a complaint")));

    if (justiceMode === "accuse") {
      if (!accuseDraft) accuseDraft = { target: "", charges: new Set(), text: "", prompt: ACCUSE_PROMPTS[Math.floor(Math.random() * ACCUSE_PROMPTS.length)] };
      const a = accuseDraft;
      box.append(h("div", { class: "card" },
        h("label", { class: "f", for: "accused", style: "margin-top:0" }, "The accused"),
        h("select", { class: "t", id: "accused", onchange: (ev) => { a.target = ev.target.value; } },
          h("option", { value: "" }, "— choose the guilty party —"),
          playersSorted().filter((p) => p.id !== me).map((p) => h("option", { value: p.id, selected: p.id === a.target }, nm(p)))),
        h("label", { class: "f", for: "stmt" }, "What did he do?"),
        h("textarea", { class: "t", id: "stmt", maxlength: 280, placeholder: a.prompt, oninput: (ev) => { a.text = ev.target.value; } }, a.text),
        h("label", { class: "f" }, "Add charges (optional)"),
        h("div", { class: "seg charges-pick" }, CRIMES.map((cr) => h("button", { type: "button", "aria-pressed": String(a.charges.has(cr)),
          onclick: () => { a.charges.has(cr) ? a.charges.delete(cr) : a.charges.add(cr); render(); } }, cr))),
        h("button", { class: "btn", type: "button", onclick: async () => {
          if (!a.target) { toast("The court needs someone to blame."); return; }
          if (!a.charges.size && !a.text.trim()) { toast("Accuse him of SOMETHING."); return; }
          if (await postEvent({ t: "accuse", id: uid(), target: a.target, charges: [...a.charges], text: a.text.trim().slice(0, 280) })) {
            toast(`${mySign} Accusation filed against ${aka(a.target)}.`); accuseDraft = null; justiceMode = null; tab = "feed"; render();
          }
        } }, mySign + " File accusation")));
    }
    if (justiceMode === "complain") {
      const c = complaintDraft;
      const ta = h("textarea", { class: "t", id: "complaint", maxlength: 300, oninput: (ev) => { c.text = ev.target.value; } }, c.text);
      box.append(h("div", { class: "card" },
        h("label", { class: "f clerk", for: "complaint", style: "margin-top:0" }, c.label), ta,
        h("button", { class: "btn", type: "button", onclick: async () => {
          const text = c.text.trim(); if (!text) { toast("Blank complaint. Honestly, the best kind."); return; }
          if (await postEvent({ t: "complaint", text: text.slice(0, 300), label: c.label, verdict: ZS.randomStamp() })) {
            toast("Your tears have been received."); complaintDraft = null; justiceMode = null; tab = "feed"; render(); }
        } }, "Submit complaint")));
      setTimeout(() => ta.focus(), 0);
    }
  }

  // ----- Bets: under construction ---------------------------------------------------------
  const BRIBES = ["Construction bribed: +0%. The workers took the money anyway.", "The GLA workers are on a tea break. Since Tuesday.",
    "Progress report: someone stole the shovel.", "“I will work!” — worker, 3 weeks ago", "Foreman says: “two more weeks.” He always says that.",
    "A batenjene was found on site. Work has stopped for questioning. 🍆", "Building permit denied: teams were unfairly distributed.",
    "Bribe accepted. Progress: still 12%.",
    "The foreman bought a new car. Progress unchanged.",
    "Your money was converted into one (1) supply crate. Then stolen.",
    "Black Lotus intercepted your bribe. Classic.",
    "The workers say thank you. That's all they say.",
    "Bribe rejected: not enough. It's never enough.",
    "Construction paused: someone parked an Overlord on the site.",
    "The architect left “to get water”. 🚰",
    "Progress bar repainted to look like 13%. Still 12%.",
    "Your bribe funded a Scud Storm. Wrong project.",
    "Workers spotted napping inside a Tunnel Network.",
    "Inspector says the site needs 14 more Patriots.",
    "Bribe received. Receipt shredded. Nice doing business.",
    "Delayed: the workers were unfairly distributed.",
    "The crane is on strike. The crane has a union now.",
    "An Aurora flew over and scared the workers. Again.",
    "Your bribe was spent on shawarma. Morale +100, progress +0.",
    "The workers refuse to continue until they get chairs.",
    "Estimated completion: two weeks. Since forever.",
    "Thank you for your bribe. Please hold. Your bribe is important to us."];
  let bribes = 0, bribeOrder = null;
  function renderBets() {
    const box = $("tab-bets"); box.innerHTML = "";
    box.append(h("div", { class: "card uc" },
      h("div", { class: "tape" }),
      h("div", { class: "big" }, "🚧"),
      h("b", { class: "title" }, "Betting window"),
      h("div", { class: "note" }, "Under construction"),
      h("p", { class: "worker" }, "A GLA worker is building it. “I will work!”… eventually."),
      h("div", { class: "progress", title: "Tap to bribe the workers", onclick: () => { if (!bribeOrder) bribeOrder = BRIBES.slice().sort(() => Math.random() - 0.5); toast(bribeOrder[bribes++ % bribeOrder.length]); } },
        h("div", { style: "width:12%" }), h("span", {}, "12% · TAP TO BRIBE")),
      h("div", { class: "tape bottom" })));
  }

  // ----- Admin / Me -----------------------------------------------------------------------
  let editPlayer = null;
  let adminView = null;                               // "activity" = the super admin's report
  function renderAdmin() {
    const box = $("tab-admin"); box.innerHTML = "";
    if (adminView === "activity" && isSuper()) { renderActivity(box); return; }
    if (codeReveal) { const c = codeCard(); if (c) box.append(c); }
    const roleName = { player: "Player", admin: "Admin", super: "Super admin 🦸" }[role()];
    const mine = h("div", { class: "card" }, h("h2", {}, "This phone"), h("p", { class: "note" }, "Role: ", h("b", {}, roleName)));
    mine.append(h("p", { class: "note" }, "You are ", h("b", {}, aka(me)), "."));
    if (me) {
      const cur = (ZS.statuses(events)[me] || {}).text || "";
      const inp = h("input", { class: "t", maxlength: 60, value: cur, placeholder: "e.g. noob" });
      mine.append(h("label", { class: "f" }, "Status (shows under your name)"), inp,
        h("div", { class: "row" },
          h("button", { class: "btn", type: "button", onclick: async () => {
            const text = inp.value.trim().replace(/\s+/g, " ").slice(0, 60);
            if (text === cur) { toast("Same status. Bold move."); return; }
            if (await postEvent({ t: "status", text })) toast(text ? "Status updated. The world has been informed." : "Status cleared. Mysterious.");
          } }, "Save status"),
          cur ? h("button", { class: "btn secondary", type: "button", onclick: async () => {
            if (await postEvent({ t: "status", text: "" })) toast("Status cleared. Mysterious."); } }, "Clear") : null),
        h("label", { class: "f" }, "Mood"), upsetToggle());
    }
    mine.append(h("button", { class: "linkbtn", type: "button", onclick: () => {
      if (!confirm("Log out on this phone? You'll need your ID code to come back.")) return;
      me = null; LS.del("me"); LS.del("vaultKey"); render(); } }, "Log out"));
    box.append(mine);
    if (isAdmin()) box.append(playersCard());
    if (isSuper()) box.append(h("div", { class: "card" }, h("h2", {}, "Activity report"),
      h("p", { class: "note", style: "margin-top:0" }, "Daily and weekly active players, visits, who's ghosting. Only you can see this."),
      h("button", { class: "btn", type: "button", onclick: () => { adminView = "activity"; render(); window.scrollTo(0, 0); } }, "📊 Open activity report")));
    if (isSuper()) { box.append(codesCard()); box.append(seasonsCard()); box.append(inviteCard()); box.append(restoreCard()); }
    if (conn.demo) box.append(h("div", { class: "card" }, h("h2", {}, "Local preview"),
      h("p", { class: "note" }, "Demo data on this computer only. Switch role or reset the sample data."),
      h("button", { class: "btn secondary", type: "button", onclick: () => { location.href = "dev/"; } }, "Open preview launcher")));
    box.append(h("div", { class: "card" }, h("button", { class: "btn danger", type: "button", onclick: () => {
      if (!confirm("Disconnect this phone? You'll need the group link (or key) and your ID code to come back.")) return;
      ["conn", "doc", "me", "dirty", "social", "pendingCode", "vaultKey"].forEach(LS.del); loaded = false; conn = null; doc = ZH.emptyDoc(); events = []; me = null; render();
    } }, "Disconnect this phone")));
  }

  // ----- super admin: activity report ------------------------------------------------------
  let act = null, actBusy = false, actDay = null, actWeek = null, actPlayer = null;
  const FEAT = { react: "🤬/✅ reactions", vote: "MVP/Noob votes", side: "Who's right votes", accuse: "Accusations",
    complaint: "Complaints", radio: "Radio", status: "Status lines", mood: "Get upset" };
  // the last 6 nights with sets, for "after each night"
  function nightsForReport() {
    return doc.nights.map((n) => ({ n, gs: ZH.gamesOf(doc, n.id) })).filter((x) => x.gs.length)
      .sort((a, b) => b.n.ts - a.n.ts).slice(0, 6).map(({ n, gs }) => ({ id: n.id, ts: n.ts,
        start: Math.max(n.ts, ...gs.map((g) => g.ts || 0)),
        eligible: doc.players.filter((p) => ZH.eligible(p, n)).map((p) => p.id),
        played: [...new Set(gs.flatMap((g) => [...g.teamA, ...g.teamB]))] }));
  }
  async function loadActivity() {
    if (actBusy) return; actBusy = true; render();
    try {
      const pings = conn.demo ? LS.get("demoActivity", []) : await ZA.load(fetch.bind(window), conn);
      act = { pings, at: Date.now() };
    } catch { toast("Couldn't load the activity log: check your connection."); }
    actBusy = false; render();
  }
  function bars(series, { label, tip, pick, picked, cls }) {
    const max = Math.max(1, ...series.map((d) => d.n));
    return h("div", { class: "bars " + (cls || "") }, series.map((d, i) => h("button", {
      type: "button", class: "bar" + (picked === i ? " on" : ""), title: tip(d), "aria-label": tip(d),
      onclick: pick ? () => pick(i) : null },
      h("span", { class: "fill", style: `height:${d.n ? Math.max(4, (d.n / max) * 100) : 0}%` }),
      h("small", {}, label(d, i)))));
  }
  function hbars(counts, empty) {
    const xs = Object.entries(counts).sort((a, b) => b[1] - a[1]), max = Math.max(1, ...xs.map((t) => t[1]));
    return xs.length ? xs.map(([k, v]) => h("div", { class: "hbar" }, h("span", {}, TABN[k] || k),
      h("i", {}, h("em", { style: `width:${(v / max) * 100}%` })), h("b", {}, v))) : h("p", { class: "note" }, empty);
  }
  function playerDetail(p, r) {
    const posts = Object.entries(p.posts).sort((a, b) => b[1] - a[1]);
    return h("div", { class: "pdetail" },
      h("small", { class: "lbl" }, "Last 30 days"),
      h("div", { class: "strip" }, p.strip.map((on, i) => h("i", { class: on ? "on" : "", title: dayLabel(r.daily[i].t) + (on ? ": active" : ": not seen") }))),
      h("small", { class: "lbl" }, "Visits by hour"),
      bars(p.hours.map((n, i) => ({ n, i })), { cls: "thin mini", tip: (d) => `${String(d.i).padStart(2, "0")}:00 · ${d.n} visits`, label: (d) => (d.i % 6 === 0 ? String(d.i).padStart(2, "0") : "") }),
      h("small", { class: "lbl" }, "Opens"), hbars(p.tabs, "No tab data yet."),
      h("small", { class: "lbl" }, "Leaves from"), hbars(p.exits, "No exits recorded yet."),
      h("p", { class: "note" }, posts.length ? "Posts: " + posts.map(([k, v]) => `${FEAT[k] || k} ${v}`).join(" · ") : "No posts in 30 days."));
  }
  const TABN = { nights: "Nights", rank: "Rank", feed: "News", justice: "Justice", bets: "Bets", admin: "Admin / Me", report: "Activity report" };
  function renderActivity(box) {
    const includeMe = LS.get("act.includeMe", false);
    box.append(h("div", { class: "row", style: "margin-bottom:12px" },
      h("button", { class: "btn secondary", type: "button", onclick: () => { adminView = null; render(); } }, "← Admin"),
      h("button", { class: "btn secondary", type: "button", disabled: actBusy, onclick: loadActivity }, actBusy ? "Loading…" : "↻ Refresh")));
    if (!act) { box.append(h("div", { class: "card" }, h("p", { class: "note" }, "Pulling the intel…"))); if (!actBusy) loadActivity(); return; }
    const r = ZA.report(act.pings, events, doc.players, { exclude: includeMe ? null : me, nights: nightsForReport() });
    const short = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const names = (ids) => ids.length ? ids.map(aka).join(", ") : "nobody";
    const tile = (n, lbl, sub) => h("div", { class: "kpi" }, h("b", {}, n), h("span", {}, lbl), sub ? h("small", {}, sub) : null);
    const of = "of " + r.players;

    box.append(h("div", { class: "card" }, h("h2", {}, "Activity report"),
      h("p", { class: "note", style: "margin-top:0" }, "A visit = opening the app after 30+ minutes away. Posts (votes, radio, complaints…) also count as being active.",
        r.since ? " Visit tracking since " + dayLabel(r.since) + "." : " Visit tracking just started: only posts so far."),
      h("div", { class: "checks" }, h("label", {}, h("input", { type: "checkbox", checked: includeMe,
        onchange: (e) => { LS.set("act.includeMe", e.target.checked); render(); } }), "Count me too"))));

    box.append(h("div", { class: "kpis" },
      tile(r.dau, "Today", of), tile(r.wau, "Last 7 days", of), tile(r.mau, "Last 30 days", of),
      tile(r.avgDau.toFixed(1), "Avg per day", "30 days"), tile(r.avgMin == null ? "—" : r.avgMin.toFixed(1), "Min per visit", r.visitsToday + " visits today"),
      tile(Math.round(r.stickiness * 100) + "%", "Stickiness", "avg day ÷ month")));

    const dSel = actDay == null ? r.daily.length - 1 : actDay, dd = r.daily[dSel];
    box.append(h("div", { class: "card" }, h("h2", {}, "Daily active players"), h("p", { class: "note", style: "margin-top:0" }, "Last 30 days. Tap a day."),
      bars(r.daily, { picked: dSel, pick: (i) => { actDay = i; render(); },
        tip: (d) => `${short(d.t)}: ${d.n} active`,
        label: (d, i) => (i % 5 === 4 || i === r.daily.length - 1 ? new Date(d.t).getDate() : "") }),
      h("p", { class: "note" }, h("b", {}, dayLabel(dd.t) + ": "), dd.n + " · " + names(dd.who))));

    const wSel = actWeek == null ? r.weekly.length - 1 : actWeek, ww = r.weekly[wSel];
    box.append(h("div", { class: "card" }, h("h2", {}, "Weekly active players"), h("p", { class: "note", style: "margin-top:0" }, "Calendar weeks, Monday to Sunday. Tap a week."),
      bars(r.weekly, { picked: wSel, pick: (i) => { actWeek = i; render(); }, cls: "wide",
        tip: (d) => `Week of ${short(d.t)}: ${d.n} active`, label: (d) => short(d.t) }),
      h("p", { class: "note" }, h("b", {}, "Week of " + short(ww.t) + ": "), ww.n + " · " + names(ww.who))));

    const tbl = h("div", { class: "card" }, h("h2", {}, "Players"),
      h("p", { class: "note", style: "margin-top:0" }, "Days active (7 / 30), visits and posts in the last 30 days. Tap a player for details."));
    r.people.forEach((p) => {
      const ghost = r.ghosts.includes(p.id), pl = P(p.id), away = pl && !ZH.isActiveNow(pl), old = p.version != null && p.version < VERSION;
      const open = actPlayer === p.id;
      tbl.append(h("button", { type: "button", class: "prow actrow" + (open ? " open" : ""), "aria-expanded": String(open),
        onclick: () => { actPlayer = open ? null : p.id; render(); } },
        h("div", { class: "who" }, h("b", {}, aka(p.id), ghost ? h("span", { class: "tag ghost" }, "GHOSTING") : null,
            old ? h("span", { class: "tag ghost" }, "OLD v" + p.version) : null),
          h("small", {}, (p.last ? "last seen " + ago(p.last) : "never seen") + (p.streak > 1 ? ` · 🔥 ${p.streak}-day streak` : "") +
            (p.avgMin != null ? ` · ${p.avgMin.toFixed(1)} min/visit` : "") +
            (p.exit ? " · leaves on " + (TABN[p.exit] || p.exit) : "") +
            (p.dev ? " · " + p.dev + (p.app ? " app" : "") : "") + (p.version != null && !old ? " · v" + p.version : "") + (away ? " · on leave" : ""))),
        h("div", { class: "nums" },
          h("span", { title: "days active, last 7" }, h("b", {}, p.days7), "/7"),
          h("span", { title: "days active, last 30" }, h("b", {}, p.days30), "/30"),
          h("span", { title: "visits, last 30 days" }, h("b", {}, p.visits30), " v"),
          h("span", { title: "posts, last 30 days" }, h("b", {}, p.actions30), " p"))));
      if (open) tbl.append(playerDetail(p, r));
    });
    box.append(tbl);

    box.append(h("div", { class: "card" }, h("h2", {}, "After each night"),
      h("p", { class: "note", style: "margin-top:0" }, "Who opened the app within 24 h of the results, and who of the players voted MVP/Noob."),
      r.nights.length ? r.nights.map((n) => {
        const missed = n.eligible.filter((id) => !n.checked.includes(id)), noVote = n.played.filter((id) => !n.voted.includes(id));
        const early = !r.since || n.start < r.since;      // before visit tracking: only posts count as "checked"
        return h("div", { class: "prow nightrow" }, h("div", { class: "who" },
          h("b", {}, dayLabel(n.ts), n.open ? h("span", { class: "tag" }, "COUNTING") : early ? h("span", { class: "tag" }, "BEFORE TRACKING") : null),
          n.eligible.length ? h("small", {}, missed.length ? "didn't check: " + missed.map(aka).join(", ") : "everyone checked") : null,
          n.played.length ? h("small", {}, noVote.length ? "didn't vote: " + noVote.map(aka).join(", ") : "everyone voted") : null),
          h("div", { class: "nums col" },
            h("span", { title: "checked the results within 24 h" }, h("b", {}, n.checked.length), "/" + n.eligible.length + " seen"),
            h("span", { title: "voted (of those who played)" }, h("b", {}, n.voted.length), "/" + n.played.length + " voted")));
      }) : h("p", { class: "note" }, "No nights with sets yet.")));

    const hrs = r.hours.map((n, i) => ({ n, i }));
    box.append(h("div", { class: "card" }, h("h2", {}, "When the crew shows up"), h("p", { class: "note", style: "margin-top:0" }, "Visits by hour of day, last 30 days (your time)."),
      bars(hrs, { cls: "thin", tip: (d) => `${String(d.i).padStart(2, "0")}:00 · ${d.n} visits`, label: (d) => (d.i % 6 === 0 ? String(d.i).padStart(2, "0") : "") })));

    box.append(h("div", { class: "card" }, h("h2", {}, "Feature use"),
      h("p", { class: "note", style: "margin-top:0" }, "Posts by type, last 30 days (last 7 days in the small number)."),
      Object.keys(r.features).length ? Object.entries(r.features).sort((a, b) => b[1].d30 - a[1].d30).map(([k, f], _, xs) =>
        h("div", { class: "hbar feat" }, h("span", {}, FEAT[k] || k),
          h("i", {}, h("em", { style: `width:${(f.d30 / xs[0][1].d30) * 100}%` })), h("b", {}, f.d30, h("small", {}, " " + f.d7))))
        : h("p", { class: "note" }, "Nobody has posted anything in 30 days. Tragic."),
      (() => { const dead = Object.keys(FEAT).filter((k) => !r.features[k]); return dead.length ? h("p", { class: "note" }, "Unused: " + dead.map((k) => FEAT[k]).join(", ")) : null; })()));
    box.append(h("div", { class: "card" }, h("h2", {}, "Where they close the app"),
      h("p", { class: "note", style: "margin-top:0" }, "The tab on screen when a visit ended, last 30 days. Shows up when they come back."),
      hbars(r.exits, "No exits recorded yet.")));
    box.append(h("div", { class: "card" }, h("h2", {}, "Most opened tabs"),
      hbars(r.tabs, "No tab data yet."),
      h("p", { class: "note" }, `Devices: ${r.dev.phone} on phone, ${r.dev.desktop} on desktop (latest visit each).`)));
  }

  // a card that folds away; remembers which ones you left open
  function fold(key, title, ...content) {
    const open = LS.get("fold." + key, false);
    const d = h("details", { class: "card fold", open });
    d.addEventListener("toggle", () => LS.set("fold." + key, d.open));
    d.append(h("summary", {}, h("h2", {}, title)), h("div", { style: "margin-top:10px" }, ...content));
    return d;
  }
  function playersCard() {
    const card = h("div");
    const list = playersSorted();
    list.forEach((p) => {
      const active = ZH.isActiveNow(p);
      card.append(h("div", { class: "prow" }, h("div", { class: "badge" }, ZH.sigOf(p)),
        h("div", { class: "who" }, h("b", {}, nm(p), p.role === "super" ? h("span", { class: "tag" }, "SUPER") : p.admin ? h("span", { class: "tag" }, "ADMIN") : null), h("small", {}, active ? "active" : "on leave (no −0.5)")),
        h("button", { class: "chip", type: "button", onclick: () => { editPlayer = editPlayer === p.id ? null : p.id; render(); } }, "Edit")));
      if (editPlayer === p.id) card.append(playerEditor(p));
    });
    if (!list.length) card.append(h("span", { class: "empty" }, "No players yet. Recruit some generals."));
    card.append(editPlayer === "new" ? playerEditor(null) :
      h("button", { class: "btn secondary", type: "button", onclick: () => { editPlayer = "new"; render(); } }, "+ Add player"));
    return fold("players", `Players (${list.length})`, card);
  }

  function playerEditor(p) {
    const draft = { aka: p ? p.aka : "", sig: p ? ZH.sigOf(p) : "" };
    const wrap = h("div", { class: "card", style: "margin:8px 0" });
    const nameIn = h("input", { class: "t", maxlength: 20, value: draft.aka, placeholder: "AKA, e.g. DARK GOAT", style: "text-transform:uppercase", oninput: (e) => { draft.aka = e.target.value; } });
    const emo = h("div", { class: "emojis" });
    const drawEmo = () => { emo.innerHTML = ""; SIGNATURES.forEach((b) => emo.append(h("button", { type: "button", "aria-pressed": String(draft.sig === b), "aria-label": b ? "Signature " + b : "No signature",
      onclick: () => { draft.sig = b; drawEmo(); } }, b || "∅"))); };
    drawEmo();
    wrap.append(h("label", { class: "f" }, "AKA"), nameIn,
      h("label", { class: "f" }, "Signature emoji (optional · shows after their name everywhere)"), emo);
    wrap.append(h("button", { class: "btn", type: "button", onclick: () => {
      const name = draft.aka.trim().replace(/\s+/g, " ");
      if (!name) { toast("Every general needs a name."); return; }
      if (doc.players.some((x) => x.aka.toLowerCase() === name.toLowerCase() && (!p || x.id !== p.id))) { toast("That AKA is taken."); return; }
      if (p) change("Edit player", (d) => { const x = d.players.find((y) => y.id === p.id); Object.assign(x, { aka: name, sig: draft.sig, updatedAt: Date.now() }); delete x.faction; delete x.challenge; });
      else {
        const id = uid(), code = ZH.newCode();
        Promise.all([ZH.hashCode(code), ZH.sealCode(doc.vault, code)]).then(([hashed, codeBox]) => {
          change("Add player", (d) => d.players.push({ id, aka: name, sig: draft.sig, ...hashed, codeBox, ts: Date.now(), updatedAt: Date.now(), inactive: [] }));
          codeReveal = { pid: id, code }; render(); window.scrollTo(0, 0);
        });
      }
      toast(p ? "Updated. " + gla() : `${up(name)} has joined the army. “I will work!”`); editPlayer = null; render();
    } }, p ? "Save" : "Add to the army"));
    if (p) {
      const active = ZH.isActiveNow(p);
      wrap.append(h("button", { class: "btn secondary", type: "button", onclick: () => {
        change(active ? "Mark inactive" : "Mark active", (d) => {
          const x = d.players.find((y) => y.id === p.id), now = Date.now(); x.inactive = (x.inactive || []).map((r) => ({ ...r }));
          if (active) x.inactive.push({ from: now, to: null }); else { const open = x.inactive.find((r) => r.to == null); if (open) open.to = now; }
          x.updatedAt = now;
        });
        toast(active ? `${nm(p)} is on leave. No −0.5 while away.` : `${nm(p)} is back. ${gla()}`); editPlayer = null;
      } }, active ? "Mark as on leave (inactive)" : "Mark as active again"));
      if (isSuper() || (!p.admin && p.role !== "super")) wrap.append(h("button", { class: "btn secondary", type: "button", onclick: () => {
        if (!confirm(`Make a new ID code for ${nm(p)}? Their old code stops working${p.id === me ? " (including on your other phones)" : ""}.`)) return;
        editPlayer = null; giveNewCode(p.id, p.id === me);
      } }, "New ID code"));
      if (isSuper() && p.role !== "super") wrap.append(h("button", { class: "btn secondary", type: "button", onclick: () => {
        const make = !p.admin;
        change(make ? "Make admin" : "Remove admin", (d) => { const x = d.players.find((y) => y.id === p.id); x.admin = make; x.updatedAt = Date.now(); });
        toast(make ? `${nm(p)} is now an admin. Power corrupts.` : `${nm(p)} is no longer an admin. Back to the trenches.`); editPlayer = null;
      } }, p.admin ? "Remove admin" : "Make admin"));
      if (isSuper() && p.role !== "super") wrap.append(h("button", { class: "btn danger", type: "button", onclick: () => {
        const n = doc.games.filter((g) => g.teamA.includes(p.id) || g.teamB.includes(p.id)).length;
        if (!confirm(`Delete ${nm(p)} forever? ${n ? `Their ${n} sets will be deleted too, which changes everyone's points. Consider “on leave” instead.` : ""}`)) return;
        change("Delete player", (d) => { d.deleted.push(p.id); d.games.filter((g) => g.teamA.includes(p.id) || g.teamB.includes(p.id)).forEach((g) => d.deleted.push(g.id)); });
        editPlayer = null;
      } }, "Delete player (super admin)"));
    }
    return wrap;
  }

  function seasonsCard() {
    const card = h("div");
    const cur = ZH.currentSeason(doc);
    const nextNum = () => { const nums = doc.seasons.map((s) => +(s.name.match(/(\d+)/) || [])[1]).filter((x) => x > 0); return nums.length ? Math.max(...nums) + 1 : 26; };
    if (cur) {
      const nameIn = h("input", { class: "t", maxlength: 30, value: cur.name });
      card.append(h("p", { class: "note" }, "Current: ", h("b", {}, cur.name), " · started " + new Date(cur.startTs).toLocaleDateString()),
        h("label", { class: "f" }, "Rename current season"), nameIn,
        h("button", { class: "btn secondary", type: "button", onclick: () => {
          const name = nameIn.value.trim(); if (!name) return;
          change("Rename season", (d) => { const s = d.seasons.find((x) => x.id === cur.id); s.name = name; s.updatedAt = Date.now(); }); toast("Renamed to " + name);
        } }, "Rename"),
        h("button", { class: "btn danger", type: "button", onclick: () => {
          if (!confirm(`End ${cur.name}? Its standings become final and move to the Hall of Fame.`)) return;
          change("End season", (d) => { const s = d.seasons.find((x) => x.id === cur.id); s.endTs = Date.now(); s.updatedAt = Date.now(); });
          toast(cur.name + " is over. Somebody is getting the 💩 forever.");
        } }, "End " + cur.name));
    } else {
      const nameIn = h("input", { class: "t", maxlength: 30, value: "Season " + nextNum() });
      card.append(h("p", { class: "note" }, "No season running."), h("label", { class: "f" }, "New season name"), nameIn,
        h("button", { class: "btn", type: "button", onclick: () => {
          const name = nameIn.value.trim() || "Season " + nextNum(), id = uid(), now = Date.now();
          change("Start season", (d) => d.seasons.push({ id, name, startTs: now, endTs: null, ts: now, updatedAt: now }));
          seasonId = id; toast(name + " has begun. " + gla());
        } }, "Start season"));
    }
    return fold("seasons", "Seasons", card);
  }

  // ----- ID codes: shown ONCE when created; only a scrambled version is stored ----------
  let codeReveal = null;   // { pid, code, mine }
  const copyText = async (text, msg) => { try { await navigator.clipboard.writeText(text); toast(msg); } catch { prompt("Copy this:", text); } };
  function codeCard() {
    const r = codeReveal, p = P(r.pid); if (!p) { codeReveal = null; return null; }
    return h("div", { class: "card codecard" },
      h("h2", {}, r.mine ? "Your ID code · save it now" : nm(p) + "'s ID code"),
      h("div", { class: "code" }, r.code),
      h("p", { class: "note" }, r.mine
        ? "You need this code to log in on any other phone. It's shown only once: save it in your password manager."
        : "Send it to " + nm(p) + " privately. It's shown only once; if it gets lost, make a new one (Players → Edit → New ID code)."),
      h("div", { class: "row" },
        h("button", { class: "btn secondary", type: "button", onclick: () => copyText(r.mine ? r.code :
          `${nm(p)}, your ZH League ID code: ${r.code}\n\nOpen the group link and enter it. Don't share it with anyone: it's you.`,
          r.mine ? "Code copied." : `Message with ${nm(p)}'s code copied. Send it privately.`) }, r.mine ? "Copy code" : "Copy message"),
        h("button", { class: "btn secondary", type: "button", onclick: () => copyText(makeLink(conn.repo, conn.token, r.code),
          "Personal link copied: opening it logs " + (r.mine ? "you" : nm(p)) + " straight in. Keep it private.") }, "Copy personal link")),
      h("button", { class: "btn", type: "button", onclick: () => { codeReveal = null; render(); } }, r.mine ? "I saved it" : "Done, I sent it"));
  }
  async function giveNewCode(pid, mine) {
    const target = P(pid), isSuperTarget = target && target.role === "super", pkcs8 = LS.get("vaultKey", null);
    if (isSuperTarget && doc.vault && !pkcs8) { toast("Unlock your code list first (Admin → ID codes), then try again."); return; }
    const code = ZH.newCode();
    const [hashed, codeBox] = await Promise.all([ZH.hashCode(code), ZH.sealCode(doc.vault, code)]);
    const vault = isSuperTarget && doc.vault ? await ZH.rewrapVault(doc.vault, pkcs8, code) : null;
    change("New ID code", (d) => { const x = d.players.find((y) => y.id === pid); Object.assign(x, hashed, { codeBox, updatedAt: Date.now() }); if (vault) d.vault = vault; });
    codeReveal = { pid, code, mine }; tab = "admin"; render(); window.scrollTo(0, 0);
  }
  function codesCard() {
    const pkcs8 = LS.get("vaultKey", null), wrap = h("div");
    if (!doc.vault) {
      wrap.append(h("p", { class: "note", style: "margin-top:0" }, "This league has no code list yet (it was created before this feature). New codes will show up here once one exists."));
      return fold("codes", "ID codes", wrap);
    }
    if (!pkcs8) {
      const inp = h("input", { class: "t", placeholder: "Your own ID code", autocomplete: "off", style: "text-transform:uppercase;letter-spacing:.12em;font-family:ui-monospace,monospace" });
      wrap.append(h("p", { class: "note", style: "margin-top:0" }, "Only you can open this list. Unlock it on this device with your own ID code."), inp,
        h("button", { class: "btn", type: "button", onclick: async (ev) => {
          ev.target.disabled = true; ev.target.textContent = "Unlocking…";
          const key = await ZH.unlockVault(doc.vault, inp.value);
          if (!key) { toast("That's not your code, commander."); ev.target.disabled = false; ev.target.textContent = "Unlock"; return; }
          LS.set("vaultKey", key); LS.set("fold.codes", true); render();
        } }, "Unlock"));
      return fold("codes", "ID codes 🔒", wrap);
    }
    wrap.append(h("p", { class: "note", style: "margin-top:0" }, "Hand each player their code (or their personal link, which logs them straight in). Only you can see this list."));
    playersSorted().forEach((p) => {
      const codeEl = h("span", { class: "mono" }, "…");
      const row = h("div", { class: "prow" }, h("div", { class: "who" }, h("b", {}, nm(p)), h("small", {}, codeEl)));
      const btns = h("div", { class: "row" });
      row.append(btns); wrap.append(row);
      ZH.openCode(pkcs8, p.codeBox).then((code) => {
        if (!code) { codeEl.textContent = "not in the list (older code) · use Edit → New ID code"; return; }
        codeEl.textContent = code;
        const msg = `${nm(p)}, your ZH League ID code: ${code}\n\nOpen the group link and enter it. Don't share it with anyone: it's you.`;
        btns.append(h("button", { class: "chip", type: "button", onclick: () => copyText(msg, `Message with ${nm(p)}'s code copied. Send it privately.`) }, "Code"),
          h("button", { class: "chip", type: "button", onclick: () => copyText(makeLink(conn.repo, conn.token, code), `${nm(p)}'s personal link copied. Send it privately.`) }, "Link"));
      });
    });
    wrap.append(h("button", { class: "linkbtn", type: "button", onclick: () => { LS.del("vaultKey"); render(); toast("Code list locked on this device."); } }, "Lock the list on this device"));
    return fold("codes", "ID codes", wrap);
  }

  function inviteCard() {
    return fold("invite", "Invite players", h("div", {},
      h("p", { class: "note", style: "margin-top:0" }, "Everyone uses the same group link (it holds the shared key). Each person then types their own ID code, which you get when you add them in Players."),
      h("button", { class: "btn secondary", type: "button", onclick: () => copyText(makeLink(conn.repo, conn.token), "Group link copied. Share it only with the crew.") }, "Copy group link"),
      h("p", { class: "note" }, "Tip: “Copy personal link” on a new code gives one link that does both: key + code, straight in.")));
  }

  function restoreCard() {
    const card = h("div", {},
      h("p", { class: "note", style: "margin-top:0" }, "Every change to the scores is saved on GitHub. Bring back an earlier version for everyone."));
    const list = h("div");
    card.append(h("button", { class: "btn secondary", type: "button", onclick: async () => {
      if (conn.demo) { toast("History needs the real GitHub repo (not available in preview)."); return; }
      list.innerHTML = ""; list.append(h("p", { class: "note" }, "Loading history…"));
      try {
        const items = await ZH.history(fetch.bind(window), conn);
        list.innerHTML = "";
        items.forEach((c, i) => list.append(h("div", { class: "prow" },
          h("div", { class: "who" }, h("b", {}, c.message.split("\n")[0]), h("small", {}, new Date(c.date).toLocaleString())),
          i === 0 ? h("small", { class: "note" }, "current") : h("button", { class: "chip", type: "button", onclick: async () => {
            if (!confirm(`Restore the league to how it was at ${new Date(c.date).toLocaleString()}? Later changes are undone for everyone (still kept in history).`)) return;
            try { doc = await ZH.restore(fetch.bind(window), conn, c.sha); saveLocal(); render(); toast("Restored. “We will rebuild!”"); }
            catch { toast("Restore failed: check connection"); }
          } }, "Restore"))));
      } catch { list.innerHTML = ""; list.append(h("p", { class: "warn" }, "Couldn't load history.")); }
    } }, "Show recent changes"), list);
    return fold("restore", "Undo disasters", card);
  }

  // ----- events --------------------------------------------------------------------------------
  document.querySelectorAll("nav.tabs button").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; LS.set("tab", tab); countTab(tab); LS.set("act.active", Date.now()); if (tab !== "admin") adminView = null; render(); window.scrollTo(0, 0); }));
  $("seasonPick").addEventListener("change", (e) => { seasonId = e.target.value; render(); });
  $("syncBtn").addEventListener("click", () => { if (conn && conn.demo) location.href = "dev/"; else sync(); });
  async function tryLogin(code) {
    const p = await ZH.findByCode(doc, code);
    if (!p) return false;
    me = p.id; LS.set("me", me); tab = "nights"; toast(`Welcome, ${nm(p)}. “I will work!”`); render(); return true;
  }
  $("connectBtn").addEventListener("click", async () => {
    const repo = $("repo").value.trim(), token = $("token").value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || token.length < 20) { $("connectErr").hidden = false; $("connectErr").textContent = "Check the repository (owner/repo) and the key."; return; }
    conn = { repo, token }; LS.set("conn", conn); $("token").value = ""; $("connectErr").hidden = true; loaded = false; render(); await sync(); render();
  });
  $("loginBtn").addEventListener("click", async () => {
    const code = $("codeIn").value, err = $("loginErr");
    if (ZH.normCode(code).length !== 12) { err.hidden = false; err.textContent = "That's not a code. Codes look like K7QM-2XPA-9DHN."; return; }
    $("loginBtn").disabled = true;
    if (!loaded) await sync();
    const ok = await tryLogin(code);
    $("loginBtn").disabled = false;
    if (ok) { $("codeIn").value = ""; err.hidden = true; }
    else { err.hidden = false; err.textContent = loaded ? "Access denied. Nice try, soldier." : "Couldn't reach the league. Check your connection."; }
  });
  $("forgetKey").addEventListener("click", () => { if (!confirm("Forget this key on this phone?")) return;
    ["conn", "doc", "me", "dirty", "social", "pendingCode", "vaultKey"].forEach(LS.del); conn = null; doc = ZH.emptyDoc(); events = []; me = null; loaded = false; render(); });
  $("firstBtn").addEventListener("click", async () => {
    const name = "Commander";        // the super admin renames everyone (themselves included) in Players
    const id = uid(), code = ZH.newCode(), now = Date.now();
    const [hashed, { vault, pkcs8 }] = await Promise.all([ZH.hashCode(code), ZH.createVault(code)]);
    const codeBox = await ZH.sealCode(vault, code);
    // bootstrap: the first profile is the super admin (written directly; nobody is logged in yet)
    doc.vault = vault; LS.set("vaultKey", pkcs8);
    doc.players.push({ id, aka: name, sig: "", role: "super", ...hashed, codeBox, ts: now, updatedAt: now, inactive: [] });
    doc = ZH.merge(doc, null); me = id; LS.set("me", me); LS.set("dirty", true); saveLocal();
    codeReveal = { pid: id, code, mine: true }; tab = "admin"; render(); sync("Create league");
    toast("You're in command. Save your code, then name yourself in Players → Edit.");
  });
  // the tab on screen when the app goes to the background; the last one before a 30-min gap is where the visit ended
  const noteExit = () => { if (me) { LS.set("act.exit", adminView === "activity" ? "report" : tab); LS.set("act.end", Date.now()); } };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync(); else noteExit(); });
  window.addEventListener("pagehide", noteExit);
  window.addEventListener("online", () => sync());

  countTab(tab);
  render();
  // personal link opened and the league data is already here (or demo): log straight in
  { const pending = LS.get("pendingCode", null);
    if (pending && loaded) { LS.del("pendingCode"); tryLogin(pending); } }
  sync();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
