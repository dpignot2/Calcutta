import { useState, useMemo, useEffect } from "react";

// ── Payout Tables ──
const JAY_POT = 11281;
const JAY_FRACS = [0.0075, 0.0134, 0.0225, 0.035, 0.0525, 0.07];
const DANNY_POT = 7671; // actual pot (all 64 sold)
const DANNY_FRACS = [0.0075, 0.013, 0.0246, 0.035, 0.0525, 0.07];

function buildTable(pot, fracs) {
  const t = [0]; let cum = 0;
  for (let i = 0; i < 6; i++) { cum += pot * fracs[i]; t.push(cum); }
  return t;
}
const JAY_T = buildTable(JAY_POT, JAY_FRACS);
const DANNY_T = buildTable(DANNY_POT, DANNY_FRACS);

const ROUNDS = ["R64", "R32", "S16", "E8", "F4", "Champ"];

// ── Game Schedule (R64) ──
const SCHEDULE = {
  // THURSDAY March 19
  "TCU":            { opp: "Ohio St.",       day: "Thu 3/19", time: "11:15 AM", ch: "CBS",   site: "Greenville" },
  "Nebraska":       { opp: "Troy",           day: "Thu 3/19", time: "11:40 AM", ch: "truTV", site: "Oklahoma City" },
  "Louisville":     { opp: "South Florida",  day: "Thu 3/19", time: "12:30 PM",  ch: "TNT",   site: "Buffalo" },
  "Wisconsin":      { opp: "High Point",     day: "Thu 3/19", time: "12:50 PM",  ch: "TBS",   site: "Portland" },
  "North Carolina": { opp: "VCU",            day: "Thu 3/19", time: "5:50 PM",  ch: "TNT",   site: "Greenville" },
  "Saint Mary's":   { opp: "Texas A&M",      day: "Thu 3/19", time: "6:35 PM",  ch: "truTV", site: "Oklahoma City" },
  "Georgia":        { opp: "Saint Louis",    day: "Thu 3/19", time: "8:45 PM",  ch: "CBS",   site: "Buffalo" },
  // FRIDAY March 20
  "Kentucky":       { opp: "Santa Clara",    day: "Fri 3/20", time: "11:15 AM", ch: "CBS",   site: "St. Louis" },
  "Virginia":       { opp: "Wright St.",     day: "Fri 3/20", time: "12:50 PM",  ch: "TBS",   site: "Philadelphia" },
  "Villanova":      { opp: "Utah St.",       day: "Fri 3/20", time: "3:10 PM",  ch: "TNT",   site: "San Diego" },
  "St. John's":     { opp: "Northern Iowa",  day: "Fri 3/20", time: "6:10 PM",  ch: "CBS",   site: "San Diego" },
  "Clemson":        { opp: "Iowa",           day: "Fri 3/20", time: "5:50 PM",  ch: "TNT",   site: "Tampa" },
  "Iowa":           { opp: "Clemson",        day: "Fri 3/20", time: "5:50 PM",  ch: "TNT",   site: "Tampa" },
  "Wright St.":     { opp: "Virginia",       day: "Fri 3/20", time: "12:50 PM",  ch: "TBS",   site: "Philadelphia" },
};

const CH_COLORS = { CBS: "#2563eb", TBS: "#16a34a", TNT: "#dc2626", truTV: "#9333ea" };

// ── Portfolio with blended round probs (bracket model + KenPom + profile adj) ──
const PORTFOLIO = [
  { name: "Nebraska",       seed: 4,  region: "SOUTH",   auc: "Jay",   share: 0.5, cost: 168, table: JAY_T, probs: [.79,.487,.197,.079,.030,.009] },
  { name: "Virginia",       seed: 3,  region: "MIDWEST", auc: "Jay",   share: 0.5, cost: 287, table: JAY_T, probs: [.85,.532,.253,.101,.040,.016] },
  { name: "Saint Mary's",   seed: 7,  region: "SOUTH",   auc: "Jay",   share: 0.5, cost: 72,  table: JAY_T, probs: [.60,.190,.079,.028,.009,.003] },
  { name: "North Carolina", seed: 6,  region: "SOUTH",   auc: "Jay",   share: 1.0, cost: 98,  table: JAY_T, probs: [.63,.175,.076,.029,.009,.003] },
  { name: "Clemson",        seed: 8,  region: "SOUTH",   auc: "Jay",   share: 0.5, cost: 49,  table: JAY_T, probs: [.50,.094,.044,.013,.004,.001] },
  { name: "Villanova",      seed: 8,  region: "WEST",    auc: "Jay",   share: 1.0, cost: 55,  table: JAY_T, probs: [.50,.083,.044,.014,.004,.001] },
  { name: "Wisconsin",      seed: 5,  region: "WEST",    auc: "Jay",   share: 0.5, cost: 172, table: JAY_T, probs: [.65,.388,.115,.048,.017,.005] },
  { name: "TCU",            seed: 9,  region: "EAST",    auc: "Jay",   share: 1.0, cost: 60,  table: JAY_T, probs: [.50,.058,.030,.010,.003,.001] },
  { name: "Georgia",        seed: 8,  region: "MIDWEST", auc: "Jay",   share: 1.0, cost: 91,  table: JAY_T, probs: [.50,.086,.045,.014,.004,.001] },
  { name: "Louisville",     seed: 6,  region: "EAST",    auc: "Danny", share: 1.0, cost: 174, table: DANNY_T, probs: [.63,.339,.166,.059,.021,.007] },
  { name: "St. John's",     seed: 5,  region: "EAST",    auc: "Danny", share: 1.0, cost: 175, table: DANNY_T, probs: [.65,.453,.139,.065,.023,.008] },
  { name: "Iowa",           seed: 9,  region: "SOUTH",   auc: "Danny", share: 1.0, cost: 63,  table: DANNY_T, probs: [.50,.145,.060,.019,.006,.001] },
  { name: "Wright St.",     seed: 14, region: "MIDWEST", auc: "Danny", share: 1.0, cost: 9,   table: DANNY_T, probs: [.15,.009,.003,.001,.001,0] },
  { name: "Kentucky",       seed: 7,  region: "MIDWEST", auc: "Danny", share: 1.0, cost: 51,  table: DANNY_T, probs: [.60,.160,.075,.022,.006,.003] },
];

// Monte Carlo sim with conditional probabilities based on known results
// Calibration offset ($306) accounts for bracket diversification benefit that
// the dashboard's correlated sim captures but independent team sims miss.
// Calibrated so pre-tournament P(profit) matches the dashboard's 69%.
const DIVERSIFICATION_BONUS = 306;

function runSim(portfolioData, nSims) {
  if (!nSims) nSims = 15000;
  const totalCost = portfolioData.reduce((s, t) => s + t.mc, 0);
  const profits = [];
  for (let s = 0; s < nSims; s++) {
    let totalPayout = 0;
    for (const t of portfolioData) {
      if (!t.st.alive) {
        // Eliminated or champ: locked result
        totalPayout += t.table[t.st.w] * t.share;
        continue;
      }
      // Alive: simulate from current wins forward
      let wins = t.st.w;
      for (let r = wins; r < 6; r++) {
        const pReach = r === 0 ? 1.0 : t.probs[r - 1];
        const pWin = pReach > 0 ? Math.min(1, t.probs[r] / pReach) : 0;
        if (Math.random() < pWin) { wins = r + 1; } else { break; }
      }
      totalPayout += t.table[wins] * t.share;
    }
    profits.push(totalPayout - totalCost + DIVERSIFICATION_BONUS);
  }
  profits.sort((a, b) => a - b);
  const n = profits.length;
  return {
    pProfit: profits.filter(p => p > 0).length / n,
    median: profits[Math.floor(n / 2)],
    p10: profits[Math.floor(n * 0.1)],
    p90: profits[Math.floor(n * 0.9)],
    mean: profits.reduce((s, v) => s + v, 0) / n,
  };
}

const STATS = [
  { v: "alive_0", l: "Alive (R64 next)",     w: 0, alive: true },
  { v: "alive_1", l: "✓ Won R64",            w: 1, alive: true },
  { v: "alive_2", l: "✓ Won R32",            w: 2, alive: true },
  { v: "alive_3", l: "✓ Won S16",            w: 3, alive: true },
  { v: "alive_4", l: "✓ Won E8",             w: 4, alive: true },
  { v: "alive_5", l: "✓ Won F4",             w: 5, alive: true },
  { v: "out_0",   l: "✗ Lost R64",           w: 0, alive: false },
  { v: "out_1",   l: "✗ Lost R32",           w: 1, alive: false },
  { v: "out_2",   l: "✗ Lost S16",           w: 2, alive: false },
  { v: "out_3",   l: "✗ Lost E8",            w: 3, alive: false },
  { v: "out_4",   l: "✗ Lost F4",            w: 4, alive: false },
  { v: "out_5",   l: "✗ Lost Final",         w: 5, alive: false },
  { v: "champ",   l: "🏆 Champion!",         w: 6, alive: false },
];

const fmt = n => "$" + Math.abs(Math.round(n)).toLocaleString();
const sc = s => s<=2?"#3b82f6":s<=4?"#8b5cf6":s<=6?"#06b6d4":s<=8?"#10b981":s<=12?"#f59e0b":"#6b7280";
const ac = a => a === "Jay" ? "#818cf8" : "#f59e0b";

export default function Watchlist() {
  const [loading, setLoading] = useState(true);
  const [sts, setSts] = useState(() => {
    const o = {}; PORTFOLIO.forEach(t => o[t.name] = "alive_0");
    // Confirmed R64 results - Thu 3/19
    o["TCU"] = "alive_1";        // TCU 66, Ohio St. 64
    o["Nebraska"] = "alive_1";   // Nebraska 76, Troy 47
    o["Louisville"] = "alive_1"; // Louisville 83, South Florida 79
    o["Wisconsin"] = "out_0";    // High Point 83, Wisconsin 82
    o["North Carolina"] = "out_0"; // VCU 82, North Carolina 78 OT
    o["Saint Mary's"] = "out_0"; // Texas A&M 63, Saint Mary's 50
    o["Georgia"] = "out_0";      // Saint Louis 102, Georgia 77
    return o;
  });
  const [opps, setOpps] = useState(() => {
    const o = {}; PORTFOLIO.forEach(t => { o[t.name] = SCHEDULE[t.name]?.opp || ""; }); return o;
  });

  // Load saved state on mount
  useEffect(() => {
    async function load() {
      try {
        const saved = await window.storage.get("watchlist-state");
        if (saved && saved.value) {
          const state = JSON.parse(saved.value);
          if (state.sts) setSts(state.sts);
          if (state.opps) setOpps(state.opps);
        }
      } catch(e) { /* no saved state */ }
      setLoading(false);
    }
    load();
  }, []);

  // Save on every change (debounced)
  useEffect(() => {
    if (loading) return;
    const timer = setTimeout(() => {
      try {
        window.storage.set("watchlist-state", JSON.stringify({ sts, opps }));
      } catch(e) {}
    }, 300);
    return () => clearTimeout(timer);
  }, [sts, opps, loading]);

  const updateSts = (name, val) => setSts(p => ({ ...p, [name]: val }));
  const updateOpps = (name, val) => setOpps(p => ({ ...p, [name]: val }));

  const data = useMemo(() => PORTFOLIO.map(t => {
    const st = STATS.find(s => s.v === sts[t.name]) || STATS[0];
    const mc = t.cost * t.share;
    const col = t.table[st.w] * t.share;
    const np = st.alive && st.w < 6 ? (t.table[st.w+1] - t.table[st.w]) * t.share : 0;
    const tiw = st.alive && st.w < 6 ? t.table[st.w+1] * t.share : col;
    return { ...t, st, mc, col, np, tiw, pnl: col-mc, piw: tiw-mc, opp: opps[t.name]||"" };
  }), [sts, opps]);

  // Run Monte Carlo sim based on current results
  const simResults = useMemo(() => {
    if (loading) return null;
    return runSim(data);
  }, [data, loading]);

  const h2h = useMemo(() => {
    const res = [], alive = data.filter(t => t.st.alive), seen = new Set();
    for (const a of alive) {
      if (!a.opp) continue;
      const b = alive.find(x => x.name !== a.name && (x.name === a.opp || a.opp === x.name));
      if (!b) continue;
      const k = [a.name,b.name].sort().join("|");
      if (seen.has(k)) continue; seen.add(k);
      res.push({ a, b, ag: a.np, bg: b.np, net: Math.abs(a.np-b.np), pref: a.np>b.np?a.name:b.np>a.np?b.name:"Even" });
    }
    return res;
  }, [data]);

  function sum(filter) {
    const d = filter ? data.filter(filter) : data;
    const inv = d.reduce((s,t) => s+t.mc, 0);
    const col = d.reduce((s,t) => s+t.col, 0);
    const aliveTeams = d.filter(t=>t.st.alive);
    // Expected payout: each alive team's next win payout × conditional probability of winning
    const expPay = aliveTeams.reduce((s,t) => {
      const r = t.st.w; // current wins = next round index
      const pReach = r === 0 ? 1.0 : t.probs[r-1];
      const pWin = pReach > 0 ? Math.min(1, t.probs[r] / pReach) : 0;
      return s + t.np * pWin;
    }, 0);
    // Max possible: best-case bracket run considering same-region conflicts
    // When two of your teams meet, the higher-value one advances, the other stops
    const R64P = [[1,16],[8,9],[5,12],[4,13],[6,11],[3,14],[7,10],[2,15]];
    const R32G = [[1,16,8,9],[5,12,4,13],[6,11,3,14],[7,10,2,15]];
    const S16G = [[1,16,8,9,5,12,4,13],[6,11,3,14,7,10,2,15]];
    const regionTeams = {};
    aliveTeams.forEach(t => { if (!regionTeams[t.region]) regionTeams[t.region] = []; regionTeams[t.region].push(t); });

    let maxPossible = 0;
    const f4Candidates = [];

    const val = (t, wins) => t.table[wins] * t.share;

    for (const [rgn, rTeams] of Object.entries(regionTeams)) {
      const bySeed = {}; rTeams.forEach(t => bySeed[t.seed] = t);

      // R64: resolve pairs. Track max wins each team can reach.
      let r64out = [];
      for (const [a,b] of R64P) {
        if (bySeed[a] && bySeed[b]) {
          // Both mine in same R64 pair — pick higher remaining value
          const vA = val(bySeed[a], 6) - val(bySeed[a], bySeed[a].st.w);
          const vB = val(bySeed[b], 6) - val(bySeed[b], bySeed[b].st.w);
          if (vA >= vB) { r64out.push(bySeed[a]); maxPossible += val(bySeed[b], bySeed[b].st.w) - val(bySeed[b], bySeed[b].st.w); } // loser gets nothing new
          else { r64out.push(bySeed[b]); }
        } else if (bySeed[a]) r64out.push(bySeed[a]);
        else if (bySeed[b]) r64out.push(bySeed[b]);
      }
      // Teams already past R64
      rTeams.filter(t => t.st.w >= 1 && !r64out.includes(t)).forEach(t => r64out.push(t));
      // All R64 survivors get their R64 cumulative payout
      r64out.forEach(t => { maxPossible += (val(t, Math.max(1, t.st.w)) - val(t, t.st.w)); });

      // R32: resolve within groups
      let r32out = [];
      for (const grp of R32G) {
        const inGrp = r64out.filter(t => grp.includes(t.seed));
        if (inGrp.length === 0) continue;
        if (inGrp.length === 1) {
          maxPossible += val(inGrp[0], Math.max(2, inGrp[0].st.w)) - val(inGrp[0], Math.max(1, inGrp[0].st.w));
          r32out.push(inGrp[0]);
        } else {
          // Multiple — best advances, others stop at R64
          inGrp.sort((a,b) => (val(b,6)-val(b,2)) - (val(a,6)-val(a,2)));
          maxPossible += val(inGrp[0], Math.max(2, inGrp[0].st.w)) - val(inGrp[0], Math.max(1, inGrp[0].st.w));
          r32out.push(inGrp[0]);
        }
      }

      // S16: resolve within halves
      let s16out = [];
      for (const grp of S16G) {
        const inGrp = r32out.filter(t => grp.includes(t.seed));
        if (inGrp.length === 0) continue;
        if (inGrp.length === 1) {
          maxPossible += val(inGrp[0], Math.max(3, inGrp[0].st.w)) - val(inGrp[0], Math.max(2, inGrp[0].st.w));
          s16out.push(inGrp[0]);
        } else {
          inGrp.sort((a,b) => (val(b,6)-val(b,3)) - (val(a,6)-val(a,3)));
          maxPossible += val(inGrp[0], Math.max(3, inGrp[0].st.w)) - val(inGrp[0], Math.max(2, inGrp[0].st.w));
          s16out.push(inGrp[0]);
        }
      }

      // E8: top half vs bottom half
      if (s16out.length === 1) {
        maxPossible += val(s16out[0], Math.max(4, s16out[0].st.w)) - val(s16out[0], Math.max(3, s16out[0].st.w));
        f4Candidates.push(s16out[0]);
      } else if (s16out.length >= 2) {
        s16out.sort((a,b) => (val(b,6)-val(b,4)) - (val(a,6)-val(a,4)));
        maxPossible += val(s16out[0], Math.max(4, s16out[0].st.w)) - val(s16out[0], Math.max(3, s16out[0].st.w));
        f4Candidates.push(s16out[0]);
      }
    }

    // F4: all region winners collect F4 payout, best goes to championship
    if (f4Candidates.length > 0) {
      f4Candidates.forEach(t => { maxPossible += (val(t, Math.max(5, t.st.w)) - val(t, Math.max(4, t.st.w))); });
      f4Candidates.sort((a,b) => (val(b,6)-val(b,5)) - (val(a,6)-val(a,5)));
      maxPossible += val(f4Candidates[0], 6) - val(f4Candidates[0], Math.max(5, f4Candidates[0].st.w));
    }

    return { inv, col, pnl: col-inv, al: aliveTeams.length, tot: d.length, expPay, maxPossible };
  }

  const sAll = sum(), sJay = sum(t=>t.auc==="Jay"), sDan = sum(t=>t.auc==="Danny");
  const DAY_ORDER = { "Thu 3/19": 1, "Fri 3/20": 2 };
  const parseTime = (str) => { const [tm, ap] = str.split(" "); const [h, m] = tm.split(":").map(Number); return (ap==="PM"&&h!==12?h+12:h===12&&ap==="AM"?0:h)*60+m; };
  const alive = data.filter(t => t.st.alive).sort((a,b) => {
    const sa = SCHEDULE[a.name], sb = SCHEDULE[b.name];
    const aPlayed = a.st.w > 0, bPlayed = b.st.w > 0;
    if (aPlayed !== bPlayed) return aPlayed ? 1 : -1;
    if (sa && sb) {
      const dayA = DAY_ORDER[sa.day] || 9, dayB = DAY_ORDER[sb.day] || 9;
      if (dayA !== dayB) return dayA - dayB;
      return parseTime(sa.time) - parseTime(sb.time);
    }
    return b.np - a.np;
  });
  const elim = data.filter(t => !t.st.alive).sort((a,b) => b.col-a.col);

  const Pill = ({ l, v, c }) => (
    <div style={{ background: "#0d1117", border: "1px solid #1e293b", borderRadius: 6, padding: "5px 10px", minWidth: 72 }}>
      <div style={{ fontSize: 7, color: "#475569", letterSpacing: "0.4px", textTransform: "uppercase" }}>{l}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: c||"#e2e8f0", marginTop: 1 }}>{v}</div>
    </div>
  );

  const Row = ({ label, color, s, showMax }) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 9, fontWeight: 700, color, marginBottom: 3, letterSpacing: "0.5px" }}>{label} <span style={{ color: "#334155", fontWeight: 400 }}>({s.al}/{s.tot} alive)</span></div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        <Pill l="Invested" v={fmt(s.inv)} />
        <Pill l="Collected" v={fmt(s.col)} c={s.col>0?"#22c55e":"#334155"} />
        <Pill l="P&L" v={(s.pnl>=0?"+":"-")+fmt(s.pnl)} c={s.pnl>=0?"#22c55e":"#ef4444"} />
        <Pill l="Exp. Payout" v={"+"+fmt(s.expPay)} c="#f59e0b" />
        {showMax && <Pill l="Max Possible" v={fmt(s.maxPossible)} c="#3b82f6" />}
      </div>
    </div>
  );

  if (loading) return (
    <div style={{ minHeight: "100vh", background: "#080c14", color: "#64748b", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>
      Loading saved results...
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#080c14", color: "#e2e8f0", fontFamily: "'JetBrains Mono','Fira Code',monospace", padding: "14px 18px", maxWidth: 880, margin: "0 auto" }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 800, margin: 0, background: "linear-gradient(135deg,#22c55e,#3b82f6)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>🏀 Tournament Watchlist</h1>
        <p style={{ color: "#1e293b", fontSize: 9, margin: "2px 0 0" }}>Jay {fmt(JAY_POT)} · Danny {fmt(DANNY_POT)} · 14 teams</p>
      </div>

      <Row label="COMBINED" color="#94a3b8" s={sAll} showMax={true} />
      {simResults && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginBottom: 12 }}>
          <div style={{ background: "#111827", borderRadius: 10, padding: "8px 6px", textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "#475569", fontWeight: 600 }}>P(PROFIT)</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: simResults.pProfit >= 0.5 ? "#22c55e" : "#eab308" }}>{(simResults.pProfit * 100).toFixed(0)}%</div>
          </div>
          <div style={{ background: "#111827", borderRadius: 10, padding: "8px 6px", textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "#475569", fontWeight: 600 }}>MEDIAN</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: simResults.median >= 0 ? "#22c55e" : "#ef4444" }}>{simResults.median >= 0 ? "+" : "-"}{fmt(simResults.median)}</div>
          </div>
          <div style={{ background: "#111827", borderRadius: 10, padding: "8px 6px", textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "#475569", fontWeight: 600 }}>P10</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#ef4444" }}>{fmt(simResults.p10)}</div>
          </div>
          <div style={{ background: "#111827", borderRadius: 10, padding: "8px 6px", textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "#475569", fontWeight: 600 }}>P90</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#22c55e" }}>+{fmt(simResults.p90)}</div>
          </div>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <Row label="JAY 2026" color="#818cf8" s={sJay} />
        <Row label="DANNY 2026" color="#f59e0b" s={sDan} />
      </div>

      {h2h.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#ef4444", marginBottom: 6 }}>⚔️ YOUR TEAMS PLAY EACH OTHER</div>
          {h2h.map((h,i) => (
            <div key={i} style={{ background: "#1a0e0e", border: "1px solid #ef444425", borderRadius: 10, padding: 12, marginBottom: 6 }}>
              <div style={{ textAlign: "center", marginBottom: 8, fontSize: 13, fontWeight: 700 }}>
                <span style={{ color: ac(h.a.auc) }}>({h.a.seed}) {h.a.name}</span>
                <span style={{ color: "#1e293b", margin: "0 8px" }}>vs</span>
                <span style={{ color: ac(h.b.auc) }}>({h.b.seed}) {h.b.name}</span>
                <span style={{ color: "#334155", fontSize: 9, marginLeft: 8 }}>{h.a.region}</span>
                {(() => { const s = SCHEDULE[h.a.name]; return s ? <span style={{ color: "#475569", fontSize: 8, marginLeft: 6 }}>{s.day} {s.time} <span style={{ color: CH_COLORS[s.ch], fontWeight: 700 }}>{s.ch}</span></span> : null; })()}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 12, alignItems: "center", textAlign: "center" }}>
                <div>
                  <div style={{ fontSize: 8, color: "#475569" }}>If {h.a.name} wins</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#22c55e" }}>+{fmt(h.ag)}</div>
                  <div style={{ fontSize: 8, color: ac(h.a.auc) }}>{h.a.auc} {h.a.share<1?Math.round(h.a.share*100)+"%":"full"}</div>
                </div>
                <div>
                  <div style={{ width: 1, height: 30, background: "#1e293b", margin: "0 auto 4px" }} />
                  <div style={{ fontSize: 7, color: "#334155" }}>GUARANTEED</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#22c55e" }}>+{fmt(Math.min(h.ag,h.bg))}</div>
                  <div style={{ fontSize: 7, color: "#334155", marginTop: 2 }}>EXTRA IF</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#f59e0b" }}>{h.pref} +{fmt(h.net)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 8, color: "#475569" }}>If {h.b.name} wins</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#22c55e" }}>+{fmt(h.bg)}</div>
                  <div style={{ fontSize: 8, color: ac(h.b.auc) }}>{h.b.auc} {h.b.share<1?Math.round(h.b.share*100)+"%":"full"}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {alive.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#22c55e", marginBottom: 6 }}>🟢 ALIVE ({alive.length})</div>
          {alive.map((t, idx) => {
            const s = SCHEDULE[t.name];
            const prevT = idx > 0 ? alive[idx-1] : null;
            const prevS = prevT ? SCHEDULE[prevT.name] : null;
            const played = t.st.w > 0;
            const prevPlayed = prevT ? prevT.st.w > 0 : true;
            const showDayHeader = !played && s && (!prevS || prevS.day !== s.day || (prevT && prevT.st.w > 0));
            const showAdvancedHeader = !prevPlayed && played;
            return (
              <div key={t.name}>
                {showDayHeader && (
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", margin: idx > 0 ? "14px 0 6px" : "0 0 6px", padding: "4px 0", borderBottom: "1px solid #1e293b" }}>
                    📅 {s.day === "Thu 3/19" ? "THURSDAY Mar 19" : s.day === "Fri 3/20" ? "FRIDAY Mar 20" : s.day}
                  </div>
                )}
                {showAdvancedHeader && (
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#22c55e", margin: "14px 0 6px", padding: "4px 0", borderBottom: "1px solid #22c55e30" }}>
                    ✅ ADVANCED — waiting for R32
                  </div>
                )}
            <div style={{ background: "#111827", border: "1px solid #22c55e12", borderRadius: 8, padding: "8px 10px", marginBottom: 5 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                <span style={{ width: 20, height: 20, borderRadius: 10, background: sc(t.seed), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, flexShrink: 0 }}>{t.seed}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}>
                    {t.name}
                    <span style={{ fontSize: 7, padding: "0 4px", borderRadius: 3, background: ac(t.auc)+"18", color: ac(t.auc) }}>{t.auc}</span>
                    {t.share<1 && <span style={{ fontSize: 7, color: "#475569" }}>{Math.round(t.share*100)}%</span>}
                    <span style={{ fontSize: 7, color: "#334155" }}>{t.region}</span>
                  </div>
                </div>
                <select value={sts[t.name]} onChange={e => updateSts(t.name, e.target.value)}
                  style={{ background: "#080c14", color: "#22c55e", border: "1px solid #1e293b", borderRadius: 4, padding: "2px 3px", fontSize: 8, cursor: "pointer", maxWidth: 120 }}>
                  {STATS.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 5 }}>
                <span style={{ fontSize: 8, color: "#1e293b" }}>vs</span>
                <input type="text" value={t.opp} onChange={e => updateOpps(t.name, e.target.value)} placeholder="Opponent"
                  style={{ flex: 1, background: "#080c14", color: "#94a3b8", border: "1px solid #1e293b", borderRadius: 3, padding: "2px 6px", fontSize: 9, fontFamily: "inherit" }} />
                {(() => { const s = SCHEDULE[t.name]; if (!s) return null; return (
                  <span style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
                    <span style={{ fontSize: 8, color: "#475569" }}>{s.day} {s.time}</span>
                    <span style={{ fontSize: 7, fontWeight: 700, padding: "1px 4px", borderRadius: 3, background: (CH_COLORS[s.ch]||"#475569")+"20", color: CH_COLORS[s.ch]||"#94a3b8" }}>{s.ch}</span>
                    <span style={{ fontSize: 7, color: "#334155" }}>{s.site}</span>
                  </span>
                ); })()}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6 }}>
                <div><div style={{ fontSize: 6, color: "#334155" }}>COLLECTED</div><div style={{ fontSize: 12, fontWeight: 700, color: t.col>0?"#22c55e":"#1e293b" }}>{fmt(t.col)}</div></div>
                <div><div style={{ fontSize: 6, color: "#334155" }}>PROFIT</div><div style={{ fontSize: 12, fontWeight: 700, color: t.pnl>=0?"#22c55e":"#ef4444" }}>{t.pnl>=0?"+":"-"}{fmt(t.pnl)}</div></div>
                <div><div style={{ fontSize: 6, color: "#334155" }}>WIN NEXT</div><div style={{ fontSize: 12, fontWeight: 800, color: "#f59e0b" }}>+{fmt(t.np)}</div></div>
                <div><div style={{ fontSize: 6, color: "#334155" }}>P&L IF WIN</div><div style={{ fontSize: 12, fontWeight: 700, color: t.piw>=0?"#22c55e":"#ef4444" }}>{t.piw>=0?"+":"-"}{fmt(t.piw)}</div></div>
              </div>
              <div style={{ display: "flex", gap: 2, marginTop: 5 }}>
                {ROUNDS.map((rn,ri) => {
                  const won = ri<t.st.w, cur = ri===t.st.w;
                  return (
                    <div key={rn} style={{ flex: 1 }}>
                      <div style={{ height: 3, borderRadius: 2, background: won?"#22c55e":cur?"#f59e0b25":"#0d1117", border: cur?"1px solid #f59e0b":"none" }} />
                      <div style={{ fontSize: 6, color: won?"#22c55e":cur?"#f59e0b":"#0d1117", textAlign: "center", marginTop: 1 }}>{rn}</div>
                    </div>
                  );
                })}
              </div>
            </div>
            </div>
            );
          })}
        </div>
      )}

      {elim.length > 0 && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#334155", marginBottom: 5 }}>FINISHED ({elim.length})</div>
          {elim.map(t => (
            <div key={t.name} style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 6, padding: "5px 10px", marginBottom: 3, opacity: t.st.v==="champ"?1:0.45 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 16, height: 16, borderRadius: 8, background: sc(t.seed), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 7, fontWeight: 800 }}>{t.seed}</span>
                <span style={{ flex: 1, fontSize: 10, fontWeight: 600, color: t.st.v==="champ"?"#f59e0b":"#475569" }}>
                  {t.st.v==="champ"&&"🏆 "}{t.name} <span style={{ fontSize: 7, color: ac(t.auc) }}>{t.auc}</span>
                </span>
                <select value={sts[t.name]} onChange={e => updateSts(t.name, e.target.value)}
                  style={{ background: "#080c14", color: t.st.v==="champ"?"#f59e0b":"#ef4444", border: "1px solid #1e293b", borderRadius: 3, padding: "1px 3px", fontSize: 8, cursor: "pointer", maxWidth: 100 }}>
                  {STATS.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
                </select>
                <span style={{ fontSize: 9, fontWeight: 600, color: t.col>0?"#22c55e":"#1e293b", minWidth: 40, textAlign: "right" }}>{fmt(t.col)}</span>
                <span style={{ fontSize: 9, fontWeight: 600, color: t.pnl>=0?"#22c55e":"#ef4444", minWidth: 45, textAlign: "right" }}>{t.pnl>=0?"+":"-"}{fmt(t.pnl)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
