"use strict";
/* ZH League — activity tracking (super admin's report only).
 *
 * Each logged-in phone posts a tiny "seen" ping to its own GitHub issue
 * ("zh-activity-log", same private repo) at most once per 30 minutes of use,
 * so one ping ≈ one visit:
 *   {t:"seen", by, at, v: app version, dev: "phone"|"desktop", app: true|false (installed),
 *    tabs: {nights: 3, …}, exit?: "rank", dur?: seconds}
 * `tabs` counts the tabs opened on that phone since its previous ping; `exit` and
 * `dur` describe the PREVIOUS visit (where it ended, how long it lasted), so they're
 * only known once the player is back.
 * Social posts (votes, radio, complaints…) also count as being active that day,
 * so the report has history from before tracking started.
 * Only the super admin's Admin tab ever loads or shows this.
 */
const ZA = (() => {
  const TITLE = "zh-activity-log";
  const GAP = 30 * 60000;                       // a new visit after 30 min away
  const D = 86400000;

  function api(fetchFn, conn, method, path, body) {
    return fetchFn(`https://api.github.com/repos/${conn.repo}/${path}`, {
      method, cache: "no-store",
      headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  const fail = (r) => Object.assign(new Error("http " + r.status), { status: r.status });
  async function logIssue(fetchFn, conn, create) {
    const r = await api(fetchFn, conn, "GET", "issues?state=all&per_page=100&sort=created&direction=asc");
    if (!r.ok) throw fail(r);
    const found = (await r.json()).find((i) => i.title === TITLE && !i.pull_request);
    if (found || !create) return found ? found.number : null;
    const c = await api(fetchFn, conn, "POST", "issues", { title: TITLE, body: "Visit log for the ZH League app (super admin's activity report). Please don't edit by hand." });
    if (!c.ok) throw fail(c);
    return (await c.json()).number;
  }
  let issueNo = null;
  async function ping(fetchFn, conn, ev) {
    if (!issueNo) issueNo = await logIssue(fetchFn, conn, true);
    const r = await api(fetchFn, conn, "POST", `issues/${issueNo}/comments`, { body: "zh:" + JSON.stringify(ev) });
    if (!r.ok) { if (r.status === 404 || r.status === 410) issueNo = null; throw fail(r); }
  }
  async function load(fetchFn, conn) {
    const n = await logIssue(fetchFn, conn, false), out = [];
    if (!n) return out;
    for (let page = 1; page < 200; page++) {
      const r = await api(fetchFn, conn, "GET", `issues/${n}/comments?per_page=100&page=${page}`);
      if (!r.ok) throw fail(r);
      const items = await r.json();
      for (const c of items) {
        if (!c.body || !c.body.startsWith("zh:")) continue;
        try { const e = JSON.parse(c.body.slice(3)); if (e.t === "seen" && e.by && e.at) out.push(e); } catch {}
      }
      if (items.length < 100) break;
    }
    return out.sort((a, b) => a.at - b.at);
  }

  // ----- the report (pure: no DOM, no network) -----------------------------------------
  const day0 = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); };
  const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };   // DST-safe
  const weekStart = (t) => { const d = new Date(day0(t)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };   // Monday

  // pings: "seen" events; social: social-log events; players: league players
  // opts: { now, exclude: player id left out of every count (the super admin),
  //         nights: [{id, ts, start (results in), eligible: [ids], played: [ids]}] newest first }
  function report(pings, social, players, opts = {}) {
    const now = opts.now || Date.now(), today = day0(now);
    const ids = new Set(players.map((p) => p.id).filter((id) => id !== opts.exclude));
    const seen = pings.filter((e) => ids.has(e.by));
    const acts = social.filter((e) => ids.has(e.by) && e.at);
    const days = new Map();                                   // player -> Set(dayKey)
    const mark = (by, at) => { if (!days.has(by)) days.set(by, new Set()); days.get(by).add(dayKey(at)); };
    seen.forEach((e) => mark(e.by, e.at)); acts.forEach((e) => mark(e.by, e.at));
    const activeOn = (t) => [...ids].filter((id) => days.has(id) && days.get(id).has(dayKey(t)));
    const activeBetween = (from, to) => [...ids].filter((id) => [...seen, ...acts].some((e) => e.by === id && e.at >= from && e.at < to));

    const daily = [];                                         // last 30 days, oldest first
    for (let i = 29; i >= 0; i--) { const t = addDays(today, -i); daily.push({ t, n: activeOn(t).length, who: activeOn(t) }); }
    const weekly = [];                                        // last 8 calendar weeks (Mon–Sun)
    for (let i = 7; i >= 0; i--) { const t = addDays(weekStart(now), -7 * i); const who = activeBetween(t, addDays(t, 7)); weekly.push({ t, n: who.length, who }); }

    const since30 = addDays(today, -29), since7 = addDays(today, -6);
    const dau = activeOn(now).length, wau = activeBetween(since7, now + 1).length, mau = activeBetween(since30, now + 1).length;
    const avgDau = daily.reduce((s, d) => s + d.n, 0) / daily.length;
    const visitsToday = seen.filter((e) => e.at >= today).length;

    const avgMin = (xs) => { const d = xs.filter((e) => e.dur > 0); return d.length ? d.reduce((s, e) => s + e.dur, 0) / d.length / 60 : null; };
    const recent = seen.filter((e) => e.at >= since30);
    const features = {};                                      // post type -> {d30, d7}
    acts.filter((e) => e.at >= since30).forEach((e) => { const f = features[e.t] || (features[e.t] = { d30: 0, d7: 0 }); f.d30++; if (e.at >= since7) f.d7++; });
    // after each night: who opened the app within 24 h of the results, and who voted
    const nights = (opts.nights || []).map((n) => {
      const elig = n.eligible.filter((id) => ids.has(id)), played = n.played.filter((id) => ids.has(id));
      const checked = activeBetween(n.start, n.start + D).filter((id) => elig.includes(id));
      const voted = [...new Set(acts.filter((e) => e.t === "vote" && e.night === n.id).map((e) => e.by))].filter((id) => played.includes(id));
      return { id: n.id, ts: n.ts, start: n.start, eligible: elig, checked, played, voted, open: now < n.start + D };
    });

    const hours = Array(24).fill(0), tabs = {}, exits = {}, dev = { phone: 0, desktop: 0 };
    seen.filter((e) => e.at >= since30).forEach((e) => {
      hours[new Date(e.at).getHours()]++;
      Object.entries(e.tabs || {}).forEach(([k, v]) => { tabs[k] = (tabs[k] || 0) + (+v || 0); });
      if (e.exit) exits[e.exit] = (exits[e.exit] || 0) + 1;
    });
    const latestDev = new Map(); seen.forEach((e) => latestDev.set(e.by, e));
    latestDev.forEach((e) => { dev[e.dev === "desktop" ? "desktop" : "phone"]++; });

    const people = [...ids].map((id) => {
      const mine = seen.filter((e) => e.by === id), myActs = acts.filter((e) => e.by === id);
      const set = days.get(id) || new Set();
      const last = Math.max(0, ...mine.map((e) => e.at), ...myActs.map((e) => e.at));
      let streak = 0, t = set.has(dayKey(today)) ? today : addDays(today, -1);   // today not over yet
      while (set.has(dayKey(t))) { streak++; t = addDays(t, -1); }
      const lastPing = mine[mine.length - 1], ex = {};
      mine.filter((e) => e.exit && e.at >= since30).forEach((e) => { ex[e.exit] = (ex[e.exit] || 0) + 1; });
      const exit = Object.keys(ex).sort((a, b) => ex[b] - ex[a])[0] || null;       // where they usually leave
      const my30 = mine.filter((e) => e.at >= since30), hrs = Array(24).fill(0), tb = {}, posts = {};
      my30.forEach((e) => { hrs[new Date(e.at).getHours()]++; Object.entries(e.tabs || {}).forEach(([k, v]) => { tb[k] = (tb[k] || 0) + (+v || 0); }); });
      myActs.filter((e) => e.at >= since30).forEach((e) => { posts[e.t] = (posts[e.t] || 0) + 1; });
      return { id, last: last || null, streak, avgMin: avgMin(my30), hours: hrs, tabs: tb, exits: ex, posts,
        strip: daily.map((d) => d.who.includes(id)), version: lastPing && lastPing.v != null ? lastPing.v : null,
        days7: daily.slice(-7).filter((d) => d.who.includes(id)).length,
        days30: daily.filter((d) => d.who.includes(id)).length,
        visits30: mine.filter((e) => e.at >= since30).length,
        actions30: myActs.filter((e) => e.at >= since30).length,
        exit, dev: lastPing ? lastPing.dev || "phone" : null, app: lastPing ? !!lastPing.app : null };
    }).sort((a, b) => (b.last || 0) - (a.last || 0));

    return { players: ids.size, dau, wau, mau, avgDau, visitsToday, stickiness: mau ? avgDau / mau : 0, avgMin: avgMin(recent),
      daily, weekly, hours, tabs, exits, dev, people, features, nights,
      since: pings.length ? pings[0].at : null, ghosts: people.filter((p) => !p.last || p.last < now - 7 * D).map((p) => p.id) };
  }

  return { GAP, ping, load, report, day0, dayKey };
})();
if (typeof module !== "undefined") module.exports = ZA;
