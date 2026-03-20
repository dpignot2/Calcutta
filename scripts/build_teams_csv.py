#!/usr/bin/env python3
"""
Calcutta Auction Data Builder
=============================
Pulls team ratings, tournament probabilities, and Vegas odds from multiple
sources and outputs teams.csv for the Calcutta Dashboard.

Data Sources (all optional, use any combination):
  1. Barttorvik (T-Rank) -- AdjO, AdjD, AdjT, AdjEM, Luck (free)
  2. KenPom API -- AdjO, AdjD, AdjT, AdjEM, Luck, tournament probs ($)
  3. The Odds API -- Men's + women's championship futures odds (free tier)
  4. KenPom probs CSV -- Manual paste from kenpom.com (if no API)
  5. Bracket CSV -- Seeds + regions (manual, after Selection Sunday)

When both Barttorvik and KenPom provide the same stat, they are averaged.
You can disable either source with CLI flags.

Usage:
  python build_teams_csv.py                    # Use all available sources
  python build_teams_csv.py --no-torvik        # KenPom only
  python build_teams_csv.py --no-kenpom        # Barttorvik only
  python build_teams_csv.py --no-vegas         # Skip Vegas odds

Requirements:
  pip install requests
"""

import argparse, csv, json, os, sys
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERROR: pip install requests"); sys.exit(1)

# ── CLI ──
def parse_args():
    p = argparse.ArgumentParser(description="Build teams.csv for Calcutta Dashboard")
    p.add_argument("--year", type=int, default=2026)
    p.add_argument("--no-torvik", action="store_true", help="Disable Barttorvik")
    p.add_argument("--no-kenpom", action="store_true", help="Disable KenPom API")
    p.add_argument("--no-vegas", action="store_true", help="Disable Vegas odds")
    p.add_argument("--no-womens", action="store_true", help="Disable women's odds")
    p.add_argument("--kenpom-key", default=os.environ.get("KENPOM_API_KEY", ""))
    p.add_argument("--kenpom-paste", default="", help="Path to pasted KenPom table (copy from kenpom.com)")
    p.add_argument("--odds-key", default=os.environ.get("ODDS_API_KEY", ""))
    p.add_argument("--bracket", default="bracket.csv")
    p.add_argument("--output", default="teams.csv")
    return p.parse_args()

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

# ── BARTTORVIK ──
def fetch_torvik_ratings(year):
    print("📊 Fetching Barttorvik T-Rank ratings...")
    for fmt, mode in [("json=1", "json"), ("csv=1", "csv")]:
        try:
            r = requests.get(f"https://barttorvik.com/teamslicejson.php?year={year}&{fmt}",
                             timeout=30, headers=UA)
            r.raise_for_status()
            if "Verifying" in r.text: continue
            data = r.json() if mode == "json" else [row for row in csv.reader(r.text.strip().split("\n"))][1:]
            teams = {}
            for row in data:
                if not isinstance(row, list) or len(row) < 25: continue
                name = str(row[1]).strip()
                try:
                    ao, ad = float(row[4]), float(row[6])
                    teams[name] = {"adj_o": ao, "adj_o_rank": int(row[5]), "adj_d": ad,
                                   "adj_d_rank": int(row[7]), "rating": round(ao - ad, 1),
                                   "adj_t": float(row[24]), "source": "torvik"}
                except (ValueError, IndexError): continue
            print(f"  ✅ {len(teams)} teams from Barttorvik ({mode})")
            return teams
        except: continue
    print("  ❌ Barttorvik unavailable"); return {}

def fetch_torvik_luck(year):
    print("🍀 Fetching Barttorvik luck...")
    try:
        r = requests.get(f"https://barttorvik.com/teamstats.php?year={year}&csv=1", timeout=30, headers=UA)
        if r.status_code != 200 or "Verifying" in r.text: return {}
        luck = {}
        for row in list(csv.reader(r.text.strip().split("\n")))[1:]:
            if len(row) < 10: continue
            name = row[1].strip()
            for v in reversed(row):
                try:
                    f = float(v)
                    if -0.2 < f < 0.2 and f != 0: luck[name] = f; break
                except ValueError: continue
        if luck: print(f"  ✅ {len(luck)} teams")
        return luck
    except: return {}

# ── KENPOM PASTE (from website copy) ──
def load_kenpom_paste(path):
    """
    Parse KenPom ratings from a pasted table copied from kenpom.com.

    Expected format (tab-separated, copied from the main rankings page):
    Rk  Team  Conf  W-L  NetRtg  ORtg  [ORk]  DRtg  [DRk]  AdjT  [TRk]  Luck  [LRk]  ...

    Fields by tab index:
      0: rank, 1: team, 2: conf, 3: W-L, 4: AdjEM, 5: AdjO, 6: AdjO rank,
      7: AdjD, 8: AdjD rank, 9: AdjT, 10: AdjT rank, 11: Luck, 12: Luck rank
    """
    p = Path(path)
    if not p.exists():
        return {}

    print(f"📊 Loading KenPom paste from {p}...")
    teams = {}
    with open(p, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split("\t")
            # Skip header rows and incomplete lines
            if len(parts) < 13:
                continue
            # First field should be a number (rank)
            try:
                int(parts[0])
            except ValueError:
                continue

            name = parts[1].strip()
            try:
                adj_em = float(parts[4].replace("+", ""))
                adj_o = float(parts[5])
                adj_o_rank = int(parts[6])
                adj_d = float(parts[7])
                adj_d_rank = int(parts[8])
                adj_t = float(parts[9])
                # parts[10] is AdjT rank
                luck_str = parts[11].replace("+", "")
                luck = float(luck_str)
                # parts[12] is Luck rank

                teams[name] = {
                    "adj_o": adj_o,
                    "adj_o_rank": adj_o_rank,
                    "adj_d": adj_d,
                    "adj_d_rank": adj_d_rank,
                    "adj_t": adj_t,
                    "rating": round(adj_em, 1),
                    "luck": luck,
                    "source": "kenpom",
                }
            except (ValueError, IndexError):
                continue

    if teams:
        print(f"  ✅ {len(teams)} teams parsed from KenPom paste")
    else:
        print("  ❌ Could not parse any teams. Check the file format.")
    return teams


# ── KENPOM API ──
def fetch_kenpom_ratings(key, year):
    if not key:
        print("📊 Skipping KenPom API (no key -- set KENPOM_API_KEY or --kenpom-key)")
        return {}
    print("📊 Fetching KenPom ratings...")
    h = {"Authorization": f"Bearer {key}", "Accept": "application/json"}
    try:
        r = requests.get(f"https://kenpom.com/api/v1/efficiency/{year}", headers=h, timeout=30)
        if r.status_code in (401, 403):
            print(f"  ❌ KenPom auth failed ({r.status_code})"); return {}
        r.raise_for_status()
        teams = {}
        for e in r.json():
            name = e.get("team", e.get("TeamName", "")).strip()
            if not name: continue
            def g(*keys):
                for k in keys:
                    if k in e: return e[k]
                return 0
            try:
                ao = float(g("adj_o", "AdjO", "adjo"))
                ad = float(g("adj_d", "AdjD", "adjd"))
                teams[name] = {
                    "adj_o": ao, "adj_d": ad, "rating": round(ao - ad, 1),
                    "adj_o_rank": int(g("adj_o_rank", "AdjO_Rank", "RankAdjO", "adjo_rank")),
                    "adj_d_rank": int(g("adj_d_rank", "AdjD_Rank", "RankAdjD", "adjd_rank")),
                    "adj_t": float(g("adj_t", "AdjT", "adjt")),
                    "luck": float(g("luck", "Luck")),
                    "source": "kenpom",
                }
            except: continue
        print(f"  ✅ {len(teams)} teams from KenPom API")
        return teams
    except Exception as e:
        print(f"  ❌ KenPom API failed: {e}"); return {}

def fetch_kenpom_probs(key, year):
    if not key: return {}
    print("📈 Fetching KenPom tournament probs...")
    h = {"Authorization": f"Bearer {key}", "Accept": "application/json"}
    try:
        r = requests.get(f"https://kenpom.com/api/v1/tournament_probs/{year}", headers=h, timeout=30)
        if r.status_code != 200: print(f"  ⚠️  Status {r.status_code}"); return {}
        probs = {}
        for e in r.json():
            name = e.get("team", e.get("TeamName", "")).strip()
            if not name: continue
            def g(*keys):
                for k in keys:
                    if k in e: return float(e[k])
                return 0.0
            p = [g("r64","R64","round_of_64"), g("r32","R32","round_of_32"),
                 g("s16","S16","sweet_16"), g("e8","E8","elite_8"),
                 g("f4","F4","final_4"), g("champ","Championship","champion","title")]
            if any(v > 0 for v in p): probs[name] = p
        if probs: print(f"  ✅ {len(probs)} teams")
        else: print("  ⚠️  No probs (may not be available pre-tournament)")
        return probs
    except Exception as e:
        print(f"  ⚠️  Failed: {e}"); return {}

# ── BLENDING ──
def blend_ratings(torvik, kenpom):
    """Average stats when both sources have a team. Prefer KenPom luck.
    Flags teams where sources disagree significantly."""
    print("🔀 Blending Barttorvik + KenPom...")
    all_names = set(list(torvik.keys()) + list(kenpom.keys()))
    blended = {}; stats = {"both": 0, "torvik": 0, "kenpom": 0}
    disagreements = []  # (name, metric, torvik_val, kenpom_val, delta)

    for name in all_names:
        t = torvik.get(name) or (lambda m: torvik[m] if m else None)(fuzzy_match(name, torvik.keys()))
        k = kenpom.get(name) or (lambda m: kenpom[m] if m else None)(fuzzy_match(name, kenpom.keys()))
        if t and k:
            blended[name] = {
                "adj_o": round((t["adj_o"] + k["adj_o"]) / 2, 1),
                "adj_d": round((t["adj_d"] + k["adj_d"]) / 2, 1),
                "adj_t": round((t.get("adj_t",0) + k.get("adj_t",0)) / 2, 1),
                "rating": round((t["rating"] + k["rating"]) / 2, 1),
                "adj_o_rank": round((t.get("adj_o_rank",0) + k.get("adj_o_rank",0)) / 2),
                "adj_d_rank": round((t.get("adj_d_rank",0) + k.get("adj_d_rank",0)) / 2),
                "luck": k.get("luck") or t.get("luck"),
                "source": "both",
                # Raw per-source values for disagreement flagging
                "torvik_rating": t["rating"],
                "kenpom_rating": k["rating"],
                "torvik_adj_o_rank": t.get("adj_o_rank", ""),
                "kenpom_adj_o_rank": k.get("adj_o_rank", ""),
                "torvik_adj_d_rank": t.get("adj_d_rank", ""),
                "kenpom_adj_d_rank": k.get("adj_d_rank", ""),
            }; stats["both"] += 1

            # Check for significant disagreements
            # AdjEM (rating) diff > 3.0 points is meaningful
            em_diff = abs(t["rating"] - k["rating"])
            if em_diff >= 3.0:
                disagreements.append((name, "AdjEM", t["rating"], k["rating"], em_diff))
            # AdjO or AdjD diff > 3.0 points
            ao_diff = abs(t["adj_o"] - k["adj_o"])
            if ao_diff >= 3.0:
                disagreements.append((name, "AdjO", t["adj_o"], k["adj_o"], ao_diff))
            ad_diff = abs(t["adj_d"] - k["adj_d"])
            if ad_diff >= 3.0:
                disagreements.append((name, "AdjD", t["adj_d"], k["adj_d"], ad_diff))
            # Rank diff > 20 spots in O or D
            if t.get("adj_o_rank") and k.get("adj_o_rank"):
                or_diff = abs(t["adj_o_rank"] - k["adj_o_rank"])
                if or_diff >= 20:
                    disagreements.append((name, "O Rank", t["adj_o_rank"], k["adj_o_rank"], or_diff))
            if t.get("adj_d_rank") and k.get("adj_d_rank"):
                dr_diff = abs(t["adj_d_rank"] - k["adj_d_rank"])
                if dr_diff >= 20:
                    disagreements.append((name, "D Rank", t["adj_d_rank"], k["adj_d_rank"], dr_diff))

        elif k:
            blended[name] = {**k}; stats["kenpom"] += 1
        elif t:
            blended[name] = {**t}; stats["torvik"] += 1

    print(f"  ✅ {stats['both']} averaged, {stats['torvik']} Torvik-only, {stats['kenpom']} KenPom-only")

    # Report disagreements
    if disagreements:
        # Group by team, sort by largest AdjEM gap first
        by_team = {}
        for name, metric, tv, kv, delta in disagreements:
            by_team.setdefault(name, []).append((metric, tv, kv, delta))

        # Sort teams by worst disagreement
        sorted_teams = sorted(by_team.items(), key=lambda x: max(d[3] for d in x[1]), reverse=True)

        print(f"\n  ⚠️  DISAGREEMENTS: {len(by_team)} teams where Barttorvik and KenPom differ significantly")
        print(f"  {'Team':<25} {'Metric':<8} {'Torvik':>8} {'KenPom':>8} {'Gap':>6}")
        print(f"  {'-'*25} {'-'*8} {'-'*8} {'-'*8} {'-'*6}")

        for name, diffs in sorted_teams[:15]:
            for i, (metric, tv, kv, delta) in enumerate(diffs):
                label = name if i == 0 else ""
                # Format values based on metric type
                if "Rank" in metric:
                    tv_s = f"#{int(tv)}"
                    kv_s = f"#{int(kv)}"
                    delta_s = f"{int(delta)} spots"
                else:
                    tv_s = f"{tv:.1f}"
                    kv_s = f"{kv:.1f}"
                    delta_s = f"{delta:.1f} pts"
                print(f"  {label:<25} {metric:<8} {tv_s:>8} {kv_s:>8} {delta_s:>10}")

        print()
        print("  💡 Large gaps mean one model sees something the other doesn't.")
        print("     Check for: recent injuries, transfers, schedule strength differences.")
        print("     The blended average may undervalue or overvalue these teams.")
    else:
        print("  ✅ Sources agree well — no major disagreements found")

    return blended

# ── VEGAS ──
def american_odds_to_prob(odds):
    return 100.0/(odds+100.0) if odds > 0 else abs(odds)/(abs(odds)+100.0)

def _fetch_odds(key, sport_keys):
    for sk in sport_keys:
        try:
            r = requests.get(f"https://api.the-odds-api.com/v4/sports/{sk}/odds",
                             params={"apiKey": key, "regions": "us", "markets": "outrights",
                                     "oddsFormat": "american"}, timeout=15)
            if r.status_code in (404,) or not r.ok: continue
            data = r.json()
            if not data: continue
            to = {}
            for ev in data:
                for bk in ev.get("bookmakers", []):
                    for mk in bk.get("markets", []):
                        if mk["key"] in ("outrights","h2h"):
                            for o in mk["outcomes"]:
                                n = o["name"]; p = o.get("price", 0)
                                to.setdefault(n, []).append(p)
            avg = {clean_team_name(n): round(sum(ps)/len(ps)) for n, ps in to.items()}
            rem = r.headers.get("x-requests-remaining", "?")
            return avg, rem
        except: continue
    return {}, "?"

def fetch_vegas(key):
    if not key: print("🎰 Skipping men's odds (no key)"); return {}
    print("🎰 Fetching men's championship odds...")
    o, rem = _fetch_odds(key, ["basketball_ncaab_championship_winner", "basketball_ncaab"])
    if o: print(f"  ✅ {len(o)} teams (remaining: {rem})")
    else: print("  ⚠️  Not available")
    return o

def fetch_womens(key):
    if not key: print("👩 Skipping women's odds"); return {}
    print("👩 Fetching women's championship odds...")
    o, rem = _fetch_odds(key, ["basketball_wncaab_championship_winner","basketball_wncaab","basketball_ncaaw_championship_winner"])
    if not o: print("  ⚠️  Not available"); return {}
    raw = {n: american_odds_to_prob(v) for n, v in o.items()}
    vig = max(sum(raw.values()), 1.0)
    probs = {n: round(p/vig, 4) for n, p in raw.items()}
    print(f"  ✅ {len(probs)} teams (remaining: {rem})")
    for n, p in sorted(probs.items(), key=lambda x: -x[1])[:5]:
        print(f"     {n}: {p:.1%}")
    return probs

# ── KENPOM PROBS CSV FALLBACK ──
def load_kenpom_probs_csv(path="kenpom_probs.csv"):
    p = Path(path)
    if not p.exists(): return {}
    print(f"📈 Loading KenPom probs from {p}...")
    probs = {}
    with open(p) as f:
        for row in csv.DictReader(f):
            try:
                probs[row["name"].strip()] = [float(row.get(k,0)) for k in ["r64","r32","s16","e8","f4","champ"]]
            except: continue
    if probs: print(f"  ✅ {len(probs)} teams")
    return probs

# ── BRACKET ──
def load_bracket(path):
    p = Path(path)
    if p.exists():
        print(f"📋 Loading bracket from {p}...")
        b = {}
        with open(p) as f:
            for row in csv.DictReader(f):
                b[row["name"].strip()] = {"seed": int(row["seed"]), "region": row["region"].strip()}
        print(f"  ✅ {len(b)} teams"); return b
    print(f"📋 Creating template: {p}")
    with open(p, "w", newline="") as f:
        w = csv.writer(f); w.writerow(["name","seed","region"])
        for reg in ["South","East","Midwest","West"]:
            for s in range(1,17): w.writerow(["TEAM_NAME", s, reg])
    print("  Fill in after Selection Sunday, then re-run."); return None

# ── NAME MATCHING ──
NAME_ALIASES = {
    "UConn":"Connecticut","Connecticut":"UConn","Miami FL":"Miami","Miami (FL)":"Miami",
    "N Carolina":"North Carolina","N.C. State":"NC State","NC St.":"NC State",
    "S Carolina":"South Carolina","S. Carolina":"South Carolina",
    "San Diego St.":"San Diego St","S Diego St":"San Diego St",
    "Mississippi":"Ole Miss","Mississippi St.":"Mississippi St",
    "St. Mary's":"Saint Mary's","St Mary's":"Saint Mary's","St. John's":"St John's",
    "Loyola Chicago":"Loyola-Chicago","Col. of Charleston":"Charleston",
    "College of Charleston":"Charleston","Long Beach State":"Long Beach St",
    "Montana State":"Montana St","Utah State":"Utah St","Morehead State":"Morehead St",
    "South Dakota State":"South Dakota St","Michigan State":"Michigan St",
    "FAU":"Florida Atlantic","Florida Atlantic":"FAU",
    "Duke Blue Devils":"Duke","North Carolina Tar Heels":"North Carolina",
    "UConn Huskies":"UConn","Houston Cougars":"Houston","Purdue Boilermakers":"Purdue",
    "Kansas Jayhawks":"Kansas","Kentucky Wildcats":"Kentucky","Arizona Wildcats":"Arizona",
    "Tennessee Volunteers":"Tennessee","Alabama Crimson Tide":"Alabama",
    "Auburn Tigers":"Auburn","Gonzaga Bulldogs":"Gonzaga","Marquette Golden Eagles":"Marquette",
    "Iowa State Cyclones":"Iowa St","Baylor Bears":"Baylor","Creighton Bluejays":"Creighton",
    "Michigan Wolverines":"Michigan","Illinois Fighting Illini":"Illinois","Texas Longhorns":"Texas",
    "South Carolina Gamecocks":"South Carolina","Iowa Hawkeyes":"Iowa","LSU Tigers":"LSU",
}
MASCOTS = ["Wildcats","Bulldogs","Tigers","Bears","Eagles","Cougars","Huskies","Tar Heels",
    "Wolverines","Boilermakers","Jayhawks","Crimson Tide","Cyclones","Blue Devils","Volunteers",
    "Gators","Seminoles","Golden Eagles","Bluejays","Fighting Illini","Longhorns","Hoosiers",
    "Badgers","Spartans","Hawkeyes","Red Raiders","Aggies","Gamecocks","Mountaineers","Cowboys",
    "Bruins","Trojans","Ducks","Beavers","Cardinal","Sun Devils","Utes","Razorbacks"]

def clean_team_name(name):
    if name in NAME_ALIASES: return NAME_ALIASES[name]
    for m in MASCOTS:
        if name.endswith(m):
            c = name[:-len(m)].strip()
            if c: return c
    return name

def fuzzy_match(name, candidates):
    if not candidates: return None
    cands = list(candidates)
    if name in cands: return name
    a = NAME_ALIASES.get(name)
    if a and a in cands: return a
    lm = {c.lower(): c for c in cands}
    if name.lower() in lm: return lm[name.lower()]
    for c in cands:
        if name.lower() in c.lower() or c.lower() in name.lower(): return c
    return None

# ── BUILD OUTPUT ──
def build_csv(bracket, ratings, t_luck, odds, womens, kp_probs, output):
    print("\n🔨 Building teams.csv...")
    fields = ["name","seed","region","rating","adj_o","adj_d","adj_o_rank","adj_d_rank",
              "adj_t","luck","vegas_odds","kenpom_r64","kenpom_r32","kenpom_s16",
              "kenpom_e8","kenpom_f4","kenpom_champ","womens_win_prob","rating_source",
              "torvik_rating","kenpom_rating","torvik_adj_o_rank","kenpom_adj_o_rank",
              "torvik_adj_d_rank","kenpom_adj_d_rank"]
    rows = []; m = {"ratings":0,"luck":0,"odds":0,"womens":0,"kenpom":0}; unmatched = []
    for name, info in sorted(bracket.items(), key=lambda x: (x[1]["region"], x[1]["seed"])):
        row = {"name": name, "seed": info["seed"], "region": info["region"]}
        # Ratings
        rm = fuzzy_match(name, ratings.keys())
        if rm:
            r = ratings[rm]
            for k in ["rating","adj_o","adj_d","adj_o_rank","adj_d_rank","adj_t","luck","source"]:
                row[k if k != "source" else "rating_source"] = r.get(k, "")
            # Per-source values for disagreement detection
            for k in ["torvik_rating","kenpom_rating","torvik_adj_o_rank","kenpom_adj_o_rank",
                       "torvik_adj_d_rank","kenpom_adj_d_rank"]:
                row[k] = r.get(k, "")
            m["ratings"] += 1
            if r.get("luck"): m["luck"] += 1
        else:
            unmatched.append(name)
            for k in fields[3:10] + ["rating_source"] + fields[19:]: row[k] = ""
        # Torvik luck fallback
        if not row.get("luck") and t_luck:
            lm = fuzzy_match(name, t_luck.keys())
            if lm: row["luck"] = t_luck[lm]; m["luck"] += 1
        # Vegas
        om = fuzzy_match(name, odds.keys()) if odds else None
        row["vegas_odds"] = odds[om] if om else ""; 
        if om: m["odds"] += 1
        # KenPom probs
        kp = fuzzy_match(name, kp_probs.keys()) if kp_probs else None
        if kp:
            p = kp_probs[kp]
            for i, k in enumerate(["kenpom_r64","kenpom_r32","kenpom_s16","kenpom_e8","kenpom_f4","kenpom_champ"]):
                row[k] = p[i]
            m["kenpom"] += 1
        else:
            for k in fields[11:17]: row[k] = ""
        # Women's
        wm = fuzzy_match(name, womens.keys()) if womens else None
        row["womens_win_prob"] = womens[wm] if wm else 0.0
        if wm: m["womens"] += 1
        rows.append(row)
    with open(output, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(rows)
    print(f"  ✅ {len(rows)} teams → {output}")
    print(f"\n  📊 Coverage:")
    print(f"     Ratings:    {m['ratings']}/{len(rows)}   Luck: {m['luck']}/{len(rows)}")
    print(f"     Vegas:      {m['odds']}/{len(rows)}   Women's: {m['womens']}/{len(rows)}")
    print(f"     KenPom probs: {m['kenpom']}/{len(rows)}")
    # Source breakdown
    src = {}
    for r in rows: src[r.get("rating_source","") or "none"] = src.get(r.get("rating_source","") or "none", 0) + 1
    if len(src) > 1 or "both" in src:
        labels = {"both": "Blended", "torvik": "Barttorvik", "kenpom": "KenPom", "none": "None"}
        parts = [f"{labels.get(s,s)}: {n}" for s, n in sorted(src.items())]
        print(f"\n  📊 Sources: " + ", ".join(parts))
    if unmatched: print(f"\n  ⚠️  No ratings: {', '.join(unmatched[:10])}")
    return rows

# ── MAIN ──
def main():
    args = parse_args()
    print("=" * 60)
    print("  🏀 CALCUTTA AUCTION DATA BUILDER")
    print("=" * 60)
    s = []
    if not args.no_torvik: s.append("Barttorvik")
    if not args.no_kenpom: s.append("KenPom")
    if not args.no_vegas: s.append("Vegas")
    print(f"  Sources: {', '.join(s) or 'None!'} | Year: {args.year}\n")

    bracket = load_bracket(args.bracket)
    if not bracket: print("\n❌ Fill in bracket.csv, then re-run."); sys.exit(1)
    print()

    torvik = torvik_luck = {}; kenpom = kenpom_api_probs = {}
    if not args.no_torvik:
        torvik = fetch_torvik_ratings(args.year)
        if torvik: torvik_luck = fetch_torvik_luck(args.year)
        print()
    if not args.no_kenpom:
        # Try paste file first (free — just copy from kenpom.com)
        if args.kenpom_paste:
            kenpom = load_kenpom_paste(args.kenpom_paste)
        # Fall back to API if no paste or paste failed
        if not kenpom and args.kenpom_key:
            kenpom = fetch_kenpom_ratings(args.kenpom_key, args.year)
        # Tournament probs: API only (paste doesn't have them — use kenpom_probs.csv instead)
        if args.kenpom_key and kenpom:
            kenpom_api_probs = fetch_kenpom_probs(args.kenpom_key, args.year)
        if not kenpom and not args.kenpom_paste and not args.kenpom_key:
            print("📊 Skipping KenPom (no --kenpom-paste file and no --kenpom-key)")
            print("   Copy the KenPom table → save as kenpom_paste.txt → use --kenpom-paste kenpom_paste.txt")
        print()

    if torvik and kenpom: ratings = blend_ratings(torvik, kenpom)
    elif kenpom: ratings = kenpom; print(f"📊 KenPom only ({len(ratings)} teams)")
    elif torvik: ratings = torvik; print(f"📊 Barttorvik only ({len(ratings)} teams)")
    else: ratings = {}; print("⚠️  No ratings!")
    print()

    odds = womens = {}
    if not args.no_vegas:
        odds = fetch_vegas(args.odds_key); print()
        if not args.no_womens: womens = fetch_womens(args.odds_key); print()

    kp_probs = kenpom_api_probs or load_kenpom_probs_csv()
    rows = build_csv(bracket, ratings, torvik_luck, odds, womens, kp_probs, args.output)

    print(f"\n{'='*60}\n  ✅ DONE → {Path(args.output).resolve()}\n{'='*60}")
    hr = sum(1 for r in rows if r.get("rating"))
    ho = sum(1 for r in rows if r.get("vegas_odds"))
    hk = sum(1 for r in rows if r.get("kenpom_r64"))
    print(f"  {'✅' if hr>32 else '❌'} Bracket model ({hr} rated)")
    print(f"  {'✅' if ho>10 else '⬜'} Vegas ensemble ({ho} odds)")
    print(f"  {'✅' if hk>10 else '⬜'} KenPom probs ({hk} teams)")

if __name__ == "__main__":
    main()
