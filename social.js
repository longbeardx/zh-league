"use strict";
/* ZH League — social layer: MVP/Noob votes, accusations (+ who's right), complaints.
 *
 * Stored as comments on one GitHub issue ("zh-social-log") in the same private
 * repo. Player keys get Issues read/write but Contents READ-ONLY, so players can
 * post here but can never change scores. Each comment body is "zh:" + JSON:
 *   {t:"vote",      night, cat:"mvp"|"noob", target, by, at}
 *   {t:"accuse",    id, target, charges:[], text, by, at}
 *   {t:"side",      case, side:"accuser"|"accused", by, at}
 *   {t:"complaint", text, label, verdict, by, at}
 *   {t:"mood",      upset: true|false, by, at}      the "get upset" toggle
 *   {t:"status",    text, by, at}                   personal status line ("" clears it)
 *   {t:"react",     target, kind: "fuck"|"endorse"|null, by, at}   one reaction per person per post
 *   {t:"radio",     night, text, by, at}            a player's short statement on a night's radio
 * Later events from the same person replace earlier ones (re-voting).
 */
const ZS = (() => {
  const TITLE = "zh-social-log";
  const VOTE_DAYS = 5;

  // ----- GitHub issues API -----------------------------------------------------
  function api(fetchFn, conn, method, path, body) {
    return fetchFn(`https://api.github.com/repos/${conn.repo}/${path}`, {
      method, cache: "no-store",
      headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  async function logIssues(fetchFn, conn) {
    const r = await api(fetchFn, conn, "GET", "issues?state=all&per_page=100&sort=created&direction=asc");
    if (!r.ok) throw Object.assign(new Error("http " + r.status), { status: r.status });
    return (await r.json()).filter((i) => i.title === TITLE && !i.pull_request).map((i) => i.number);
  }
  async function load(fetchFn, conn) {
    const nums = await logIssues(fetchFn, conn), events = [];
    for (const n of nums) {
      for (let page = 1; page < 50; page++) {
        const r = await api(fetchFn, conn, "GET", `issues/${n}/comments?per_page=100&page=${page}`);
        if (!r.ok) throw Object.assign(new Error("http " + r.status), { status: r.status });
        const items = await r.json();
        for (const c of items) {
          if (!c.body || !c.body.startsWith("zh:")) continue;
          try { events.push({ ...JSON.parse(c.body.slice(3)), cid: c.id }); } catch {}
        }
        if (items.length < 100) break;
      }
    }
    return events.sort((a, b) => a.at - b.at);
  }
  async function post(fetchFn, conn, ev) {
    let [n] = await logIssues(fetchFn, conn);
    if (!n) {
      const c = await api(fetchFn, conn, "POST", "issues", { title: TITLE, body: "Social log for the ZH League app (votes, accusations, complaints). Please don't edit by hand." });
      if (!c.ok) throw Object.assign(new Error("http " + c.status), { status: c.status });
      n = (await c.json()).number;
    }
    const r = await api(fetchFn, conn, "POST", `issues/${n}/comments`, { body: "zh:" + JSON.stringify(ev) });
    if (!r.ok) throw Object.assign(new Error("http " + r.status), { status: r.status });
    return { ...ev, cid: (await r.json()).id };
  }
  async function remove(fetchFn, conn, cid) {
    const r = await api(fetchFn, conn, "DELETE", `issues/comments/${cid}`);
    if (!r.ok && r.status !== 404) throw Object.assign(new Error("http " + r.status), { status: r.status });
  }

  // ----- tallies ------------------------------------------------------------------
  const latestBy = (events, keyFn) => { const m = new Map(); events.forEach((e) => m.set(keyFn(e), e)); return [...m.values()]; };

  // { mvp: {target: count}, noob: {...}, mine: {mvp, noob} }
  function nightVotes(events, nightId, me) {
    const votes = latestBy(events.filter((e) => e.t === "vote" && e.night === nightId), (e) => e.by + "|" + e.cat);
    const out = { mvp: {}, noob: {}, mine: {}, voters: { mvp: {}, noob: {} } };
    votes.forEach((v) => {
      if (!v.target) return;
      out[v.cat][v.target] = (out[v.cat][v.target] || 0) + 1;
      (out.voters[v.cat][v.target] = out.voters[v.cat][v.target] || []).push(v.by);
      if (v.by === me) out.mine[v.cat] = v.target;
    });
    return out;
  }
  const winners = (counts) => { const max = Math.max(0, ...Object.values(counts)); return max ? Object.keys(counts).filter((k) => counts[k] === max) : []; };
  const votingOpen = (night, now = Date.now()) => now < night.ts + VOTE_DAYS * 86400000;

  // accusations with who's-right tally (parties can't vote on their own case)
  function cases(events, me) {
    const sides = latestBy(events.filter((e) => e.t === "side"), (e) => e.case + "|" + e.by);
    return events.filter((e) => e.t === "accuse").map((c) => {
      const s = sides.filter((x) => x.case === c.id && x.by !== c.by && x.by !== c.target && x.side);
      return { ...c, accuser: s.filter((x) => x.side === "accuser").map((x) => x.by),
        accused: s.filter((x) => x.side === "accused").map((x) => x.by),
        mySide: (s.find((x) => x.by === me) || {}).side || null };
    });
  }

  // per player: MVP/Noob titles won, accusations made/received
  function profileCounts(events, nights) {
    const out = {}, get = (id) => (out[id] = out[id] || { mvp: 0, noob: 0, accused: 0, accusations: 0 });
    nights.forEach((n) => { const v = nightVotes(events, n.id);
      winners(v.mvp).forEach((id) => get(id).mvp++); winners(v.noob).forEach((id) => get(id).noob++); });
    events.filter((e) => e.t === "accuse").forEach((e) => { get(e.by).accusations++; get(e.target).accused++; });
    return out;
  }

  // ----- moods: latest "upset" toggle per player ---------------------------------------
  function moods(events) {
    const out = {};
    events.filter((e) => e.t === "mood").forEach((e) => { out[e.by] = { upset: !!e.upset, at: e.at }; });
    return out;
  }
  // reactions: latest per person per post -> { target: { fuck: [by], endorse: [by] } }
  function reactions(events) {
    const latest = new Map();
    events.filter((e) => e.t === "react").forEach((e) => latest.set(e.target + "|" + e.by, e));
    const out = {};
    for (const e of latest.values()) {
      if (e.kind !== "fuck" && e.kind !== "endorse") continue;
      const r = (out[e.target] = out[e.target] || { fuck: [], endorse: [] });
      r[e.kind].push(e.by);
    }
    return out;
  }

  // players' radio statements for a night: at most RADIO_MAX per player (their latest), newest last
  const RADIO_MAX = 2;
  function radioStatements(events, nightId) {
    const all = events.filter((e) => e.t === "radio" && e.night === nightId && e.text), per = {};
    for (let i = all.length - 1; i >= 0; i--) per[all[i].by] = (per[all[i].by] || 0) + 1, all[i].__n = per[all[i].by];
    return all.filter((e) => e.__n <= RADIO_MAX).map(({ __n, ...e }) => e).slice(-16);
  }

  // latest status line per player (deleting the newest one brings back the previous)
  function statuses(events) {
    const out = {};
    events.filter((e) => e.t === "status").forEach((e) => { out[e.by] = { text: e.text || "", at: e.at }; });
    for (const k of Object.keys(out)) if (!out[k].text) delete out[k];
    return out;
  }
  const UPSET = ["flipped the table.", "is typing in all caps (more than usual).", "has left the chat emotionally.",
    "demands to speak to the manager.", "is not mad. He is VERY mad.", "rage-quit his own feelings.",
    "is drafting a strongly worded message.", "has unfriended the map.", "is breathing loudly into the mic."];
  const CALM = ["has been given a juice box.", "is back from his walk.", "accepted it was a skill issue.",
    "drank water and touched grass.", "has forgiven everyone (for now).", "remembered it's just a game. Briefly."];
  const moodLine = (ev) => { const list = ev.upset ? UPSET : CALM; let h = 0;
    for (const ch of String(ev.cid || ev.at)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return list[h % list.length]; };

  // ----- complaints desk -------------------------------------------------------------
  const LABELS = [
    "What is it this time?",
    "Type your complaint. We'll file it under “nobody asked”.",
    "Go on, tell me how it's everyone's fault but yours.",
    "Write it here. It'll reach exactly who you think it'll reach. (Nobody.)",
    "Complaints department. I'm on my lunch break. Since 2019.",
    "Describe your suffering. Use small words, I'm tired.",
    "Oh good, another one. Start typing.",
    "Your call is important to us. It is not.",
    "Please hold while I pretend to care.",
    "Let me guess: lag?",
    "Write slowly, the judge reads like you micro.",
    "Make it quick, my tea is getting cold.",
    "Every complaint is read carefully, then used as tissue.",
    "Type here. Tears may void the warranty.",
    "Welcome to the Department of Justice. Justice is out. Leave a message.",
    "Is this about losing again? It's about losing again.",
    "Complain away. The shredder is hungry.",
    "Explain, in 300 characters, why it wasn't a skill issue.",
    "Our complaint box is also our trash can. Proceed.",
    "Speak, soldier. I'm pretending to write this down.",
    "Your complaint will be reviewed by a GLA worker. He will work. Eventually.",
    "Kindly state your grievance, then go practice.",
    "Write your complaint below. Crying emojis cost extra.",
    "I've seen 10,000 complaints. Surprise me.",
    "Is it the map? It's never the map. But go on.",
    "Fill this in. Then fill in the gap in your build order.",
    "Department of Justice, complaints desk, worst job in the base. What.",
    "Type your tragedy. We'll file it under comedy.",
    "The court is in session. The court is also asleep.",
    "Go ahead, write it. Nobody's reading. Except everyone.",
  ];
  const STAMPS = ["RECEIVED. IGNORED.", "FILED UNDER: WHINING", "FORWARDED TO THE SHREDDER", "NOTED. NOT CARED.",
    "STATUS: SKILL ISSUE", "ESCALATED TO NOBODY", "CLOSED: WON'T FIX", "ARCHIVED IN THE TRASH", "PENDING (FOREVER)",
    "DENIED. WITH PREJUDICE", "RETURNED TO SENDER", "FILED UNDER: TEARS", "FORWARDED TO THE GLA WORKERS", "STATUS: LOL", "APPROVED (JUST KIDDING)", "LOST IN THE TUNNEL NETWORK", "SHOT DOWN BY A PATRIOT", "NUKED ON ARRIVAL", "USED TO FUEL AN AURORA", "STOLEN BY BLACK LOTUS", "READ BY NO ONE", "ESCALATED TO THE MAP", "REJECTED: TEAMS WERE FAIR", "CASE CLOSED BEFORE OPENING", "CHECKED. STILL A SKILL ISSUE", "WAITING FOR A MANAGER (THERE IS NONE)", "DECLINED: TRY WINNING", "PRINTED, LAUGHED AT, SHREDDED", "QUEUED BEHIND 4,000 OTHERS", "MARKED AS SPAM", "DROPPED FROM A CHINOOK", "OVERRULED BY 14 PATRIOTS", "BURIED UNDER SUPPLY CRATES", "SENT TO GET WATER. NEVER CAME BACK"];
  const randomLabel = () => LABELS[Math.floor(Math.random() * LABELS.length)];
  const randomStamp = () => STAMPS[Math.floor(Math.random() * STAMPS.length)];

  return { load, post, remove, moods, moodLine, statuses, reactions, radioStatements, RADIO_MAX, nightVotes, winners, votingOpen, cases, profileCounts, LABELS, STAMPS, randomLabel, randomStamp, VOTE_DAYS };
})();
if (typeof module !== "undefined") module.exports = ZS;
