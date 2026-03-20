# 🏀 Calcutta Auction Dashboard

A real-time analytics dashboard for NCAA March Madness Calcutta auctions. Combines KenPom ratings, Barttorvik T-Rank, Vegas futures odds, and historical auction data into a live decision-support tool that tells you exactly what every team is worth — and updates as the auction happens.

Built to run alongside [AuctionPro.co](https://www.auctionpro.co) with a live data feed, or standalone with manual entry.

---

## Quick Start

1. **Double-click** `calcutta_dashboard.html` to open in your browser
2. Click **Load Sample Auction** to explore with demo data
3. Browse teams, check EVs, and click the **❓ Help** button for guided tooltips

For a real auction, see [Full Setup](#full-setup-for-a-real-auction) below.

---

## Files

| File | Purpose |
|------|---------|
| `calcutta_dashboard.html` | The dashboard — double-click to run, no install needed |
| `calcutta_dashboard.jsx` | React source (for Vite/dev server) |
| `build_teams_csv.py` | Data scraper — pulls ratings, odds, and probabilities automatically |
| `auctionpro_scraper.js` | Live feed — paste into AuctionPro console for real-time sync |
| `bracket_template.csv` | Template for 64-team bracket (fill in after Selection Sunday) |
| `config_template.csv` | Template for your group's payout structure |
| `teams_template.csv` | Example teams.csv showing all columns |
| `kenpom_probs_template.csv` | Template for manual KenPom tournament probabilities |
| `history_template.csv` | Template for past auction results |

---

## Full Setup for a Real Auction

### Timeline

| When | What to do |
|------|-----------|
| **Pre-Selection Sunday** | Sign up for The Odds API (free). Optionally buy KenPom subscription. |
| **Selection Sunday** | Fill in `bracket.csv` with 64 teams, seeds, regions (15 min). |
| **Selection Sunday evening** | Run `build_teams_csv.py` to pull all data (2 min). |
| **Day before auction** | Fill in `config.csv` with your group's payout rules. Upload history.csv if available. |
| **Auction night** | Open dashboard + AuctionPro, paste scraper, dominate. |

### Step 1: Install dependencies

```powershell
pip install requests
```

### Step 2: Fill in bracket.csv

After Selection Sunday, fill in 64 rows with team name, seed (1-16), and region (4 regions):

```csv
name,seed,region
Houston,1,South
Duke,2,East
...
```

### Step 3: Run the data builder

```powershell
# With all sources (recommended)
$env:ODDS_API_KEY = "your_key"
$env:KENPOM_API_KEY = "your_key"    # optional
python build_teams_csv.py

# Barttorvik only (free, no accounts needed)
python build_teams_csv.py --no-kenpom --no-vegas

# See all options
python build_teams_csv.py --help
```

### Step 4: Fill in config.csv

One row with your group's payout structure:

```csv
pot_size,payout_r64,payout_r32,payout_s16,payout_e8,payout_f4,payout_champ,bonus_womens_champ,bonus_biggest_blowout
5000,0.025,0.05,0.10,0.15,0.225,0.45,0.02,0.01
```

### Step 5: Open the dashboard

Double-click `calcutta_dashboard.html`. Click **📄 Upload CSVs** and upload `teams.csv`, `config.csv`, and optionally `history.csv`.

### Step 6: Connect to AuctionPro (optional)

```powershell
# Start local server (needed for cross-origin communication)
cd C:\Users\YourName\Downloads
npx serve .
```

Open `http://localhost:3000/calcutta_dashboard.html` in one tab, your AuctionPro auction in another. Paste `auctionpro_scraper.js` into the AuctionPro console. Sales auto-populate in the dashboard.

---

## Data Sources

### teams.csv — One row per tournament team (64 rows)

| Column | Required | Source | Description |
|--------|----------|--------|-------------|
| `name` | ✅ | Selection Sunday | Team name (must match across all files) |
| `seed` | ✅ | Selection Sunday | Tournament seed (1–16) |
| `region` | ✅ | Selection Sunday | Bracket region (4 regions) |
| `rating` | ✅ | KenPom/Barttorvik | AdjEM (Adjusted Efficiency Margin = AdjO − AdjD) |
| `adj_o` | optional | KenPom/Barttorvik | Adjusted Offensive Efficiency (pts per 100 possessions) |
| `adj_d` | optional | KenPom/Barttorvik | Adjusted Defensive Efficiency (lower = better) |
| `adj_o_rank` | optional | KenPom/Barttorvik | National rank in AdjO (1 = best offense) |
| `adj_d_rank` | optional | KenPom/Barttorvik | National rank in AdjD (1 = best defense) |
| `adj_t` | optional | KenPom/Barttorvik | Adjusted Tempo (possessions per 40 min, median ~68) |
| `luck` | optional | KenPom/Barttorvik | Luck rating (positive = lucky, negative = unlucky) |
| `vegas_odds` | optional | Sportsbooks | Championship futures in American format (+500 = 5-to-1) |
| `kenpom_r64` | optional | KenPom | Probability of winning R64 (reaching R32) |
| `kenpom_r32` | optional | KenPom | Probability of reaching Sweet 16 |
| `kenpom_s16` | optional | KenPom | Probability of reaching Elite 8 |
| `kenpom_e8` | optional | KenPom | Probability of reaching Final Four |
| `kenpom_f4` | optional | KenPom | Probability of reaching Championship |
| `kenpom_champ` | optional | KenPom | Probability of winning the championship |
| `womens_win_prob` | optional | Odds API | Probability school's women's team wins women's tournament |
| `torvik_rating` | optional | build_teams_csv.py | Barttorvik AdjEM (raw, before blending) |
| `kenpom_rating` | optional | build_teams_csv.py | KenPom AdjEM (raw, before blending) |
| `torvik_adj_o_rank` | optional | build_teams_csv.py | Barttorvik O rank (raw) |
| `kenpom_adj_o_rank` | optional | build_teams_csv.py | KenPom O rank (raw) |
| `torvik_adj_d_rank` | optional | build_teams_csv.py | Barttorvik D rank (raw) |
| `kenpom_adj_d_rank` | optional | build_teams_csv.py | KenPom D rank (raw) |

### What each data tier unlocks

| Data you provide | Features enabled |
|-----------------|-----------------|
| name + seed + region + rating | Bracket model, opponent-aware EV, tournament simulator |
| + adj_o_rank, adj_d_rank | Championship profile, balance/lopsided detection |
| + adj_t | Trapezoid of Excellence check |
| + luck | Luck discount / unlucky undervaluation boost |
| + vegas_odds | 3-way ensemble, Vegas disagreement alerts |
| + kenpom_r64–champ | Full KenPom ensemble (biggest accuracy gain) |
| + womens_win_prob | Women's championship bonus EV |
| + torvik/kenpom raw values | Source disagreement flagging |
| + history.csv | Seed-level buy/avoid verdicts, price ranges, market bias |

---

## EV Model — How Expected Value is Calculated

### Stage 1: Three Probability Sources

Each team gets a probability of reaching each tournament round (R64 through Championship) from up to three independent sources:

**Source 1: Bracket-Adjusted Model** (from `rating`)
- Uses a logistic win probability function on AdjEM differences
- Knows the actual bracket path — a 5-seed facing a strong 4-seed in R32 gets different odds than one facing a weak 4-seed
- Blends 60% opponent-aware model / 40% historical seed rates
- Falls back to pure historical rates if no ratings provided

**Source 2: KenPom Round Probabilities** (from `kenpom_probs`)
- Cumulative P(reach each round) from KenPom's 1-million-simulation tournament model
- Already accounts for specific bracket path, tempo adjustments, and full predictive model
- The most accurate single source

**Source 3: Vegas Championship Odds** (from `vegas_odds`)
- Futures odds converted to de-vigged title probability
- Aggregates sharp money, injury news, and information not in ratings

### Ensemble Blending

| Data available | Blend formula |
|---------------|---------------|
| KenPom + Bracket + Vegas | base = KenPom 70% + Bracket 30%, then Vegas anchors title at 70/30 |
| KenPom + Bracket (no Vegas) | base = KenPom 70% + Bracket 30% |
| Bracket + Vegas (no KenPom) | base = Bracket, then Vegas anchors title at 50/50 |
| Bracket only | Bracket model 100% |

### Stage 2: Vegas Late-Round Anchoring

Vegas only provides a championship probability. Instead of spreading adjustments evenly across all rounds, the correction concentrates in later rounds where uncertainty is highest:

| Round | Weight | Share of adjustment |
|-------|--------|-------------------|
| R64 | 1 | 6% |
| R32 | 1 | 6% |
| Sweet 16 | 2 | 13% |
| Elite 8 | 3 | 19% |
| Final Four | 4 | 25% |
| Championship | 5 | 31% |

### Stage 3: KenPom Profile Modifiers

Five checks that adjust deep-run probabilities based on team profile:

| Check | Input | Effect | Rationale |
|-------|-------|--------|-----------|
| 🏆 Championship Profile | adj_o_rank ≤ 25 AND adj_d_rank ≤ 25 | +5% (or −7% to −15% if missing) | 22/23 champions since 2002 had this |
| 📐 Trapezoid of Excellence | AdjEM > 15, moderate tempo | +3% (or −5% for extreme pace) | Champions cluster at high efficiency + median pace |
| 🍀 Luck | luck > 0.04 | −5% to −10% | Winning close games at unsustainable rate |
| ⚖️ Balance | Both ranks ≤ 40 | +2% (or −8% if extremely lopsided) | Can win shootouts AND grind-it-out games |
| 🔀 Source Disagreement | AdjEM gap ≥ 3 or rank gap ≥ 20 | Flagged (no auto-adjustment) | Uncertainty — investigate manually |

Modifiers stack multiplicatively and concentrate in later rounds (Sweet 16 through Championship).

### Stage 4: Round EVs

For each round:
```
perTeamPayout = pot × payoutFraction × (1 − bonusTotal) / teamsInRound
roundEV = P(reach round) × perTeamPayout
```

### Stage 5: Bonus EVs

**Women's Championship Bonus** (`bonus_womens_champ`)
```
womensEV = womens_win_prob × pot × bonus_fraction
```
Only schools with women's tournament contenders get non-zero values (South Carolina, UConn, Iowa, LSU, etc.).

**Biggest Blowout Bonus** (`bonus_biggest_blowout`)
This is a **consolation prize** — it goes to the team that **LOSES** by the largest margin in Round of 64.

The model computes P(team suffers biggest blowout) using:
- P(loses R64) × expected margin of defeat²
- Softmax across all 32 R64 games
- 16-seeds facing 1-seeds dominate (99% chance of losing by ~22 points)
- Makes 16-seeds worth $10–14 instead of ~$0.05

### Stage 6: Final EV

```
totalEV = sum(roundEVs) + womensEV + blowoutEV
maxBid  = totalEV × 0.85   (15% risk discount)
```

### Sensitivity — What Drives EV the Most

On a $5,000 pot for a 1-seed ($872 base EV):

| Factor | EV Impact | Notes |
|--------|-----------|-------|
| Championship probability model | ±$125–251 | KenPom vs seed-only swings $125 |
| All red flags stacking | −$200 | Lopsided + lucky + no champ profile |
| Pot size estimation | $174 per $1K | Bayesian estimator matters |
| Vegas disagreement | +$151 | Sharp money sees 30% more upside |
| Championship profile | +$33 | Top 25 O + D verification |
| Women's bonus (South Carolina) | +$29 | Best case for any school |
| Sweet 16 probability | +$6 | Later rounds dominate |
| R64 probability | ~$0 | Payout is only $3.80 |

For a 16-seed ($0.10 base EV): blowout bonus ($14) is 99% of total value.

---

## Dashboard Features

### Setup & Data Input
- **CSV Upload mode** — Upload teams.csv, config.csv, history.csv via file pickers
- **JSON Input mode** — Paste bracket JSON directly
- **Sample Auction** — Pre-loaded with 31 teams sold, 6 in portfolio, Vegas odds
- **State Persistence** — All data saves to localStorage. Browser crash = no data loss.

### Team Analysis (per team)
- **Expected Value** — Dollar EV from ensemble model
- **Max Bid** — EV × 85% risk discount
- **Win Championship %** — Blended title probability
- **Breakeven Round** — Minimum round to recover purchase price, with probability
- **Bonus EV** — Women's champion + blowout consolation breakdown
- **Round-by-Round Probabilities** — Bar chart with cumulative payout at each round
- **KenPom Profile Badges** — Championship profile, trapezoid, balance, luck, disagreement
- **Net Profile Adjustment** — Shows exact % impact on deep-run probability

### Verdict System
- **Color-coded verdict bar** — GREAT VALUE / GOOD VALUE / FAIR PRICE / OVERPAYING / TOO RICH
- **Visual position indicator** — Shows bid position between $0, EV, and max bid

### Portfolio Management
- **My Teams list** — All purchased teams with paid price, edge, and +/− display
- **Portfolio EV** — Combined expected value of all your teams
- **Total Invested** — Running total of spend
- **Budget tracking** — Set budget, see remaining
- **Unsell button** — Remove any sale (not just the last one)
- **Claim as mine** — Mark any sold team as yours after the fact

### Live Auction Feed (AuctionPro Integration)
- **Real-time sale detection** — Polls AuctionPro API every 3 seconds
- **Live bid tracking** — Polls current_item.json every 2 seconds
- **Auto-record sales** — Sold teams auto-populate with price and buyer
- **Auto-detect your purchases** — Uses your AuctionPro user ID
- **LIVE badge** — Green indicator showing currently-auctioned team + current bid
- **Click to follow** — Click LIVE badge to jump to current auction item
- **Smart auto-follow** — Only updates your view when you're watching the live team. If you're scouting a future team, it won't interrupt you.
- **Initial sync** — Catches up on all sales that happened before you connected
- **Cross-origin support** — Works between auctionpro.co and localhost via postMessage

### Bayesian Pot Estimation
- **Per-sale implied pots** — Each sale implies a total pot based on that team's EV share
- **Higher-EV teams = more signal** — A 1-seed sale constrains the pot estimate more than a 16-seed
- **90% Credible Interval** — Shows uncertainty range on pot estimate
- **Confidence indicator** — Tightens as more teams sell
- **Projected vs Base** — Shows HOT/COLD/ON TRACK relative to initial estimate

### Suggestions Engine
- **Multi-factor scoring** — Ranks unsold teams by:
  1. EV per dollar at current max bid
  2. Region diversification (penalizes concentration)
  3. Portfolio hedge value (MC simulation of marginal P(profit) impact)
  4. Market bias (live auction + historical seed pricing patterns)
  5. Vegas signal bonus (when Vegas sees more upside than model)
  6. KenPom profile bonus/penalty (champ profile, trapezoid, luck, lopsided)
- **Smart tags** — NEW RGN, VEGAS ↑, HIGH EV, P(+) ↑, FLOOR ↑, BARGAIN, HEDGE ✓, 🏆 CHAMP, 📐 TRAP, 🎲 LOPSIDED, 🍀 LUCKY, 🔀 DISAGREE

### Budget Optimizer
- **Greedy knapsack** — Given remaining budget, finds optimal set of teams to target
- **Region diversification** — Penalizes 2+ teams in same region
- **Value floor** — Skips bad-value teams (adjScore < 0.8)
- **Shows total cost, total EV, remaining budget**

### Impact Tab (What-If Analysis)
- **Before/After portfolio comparison** — Shows how buying the current team would change:
  - P(profit), P10, P25, median, P75, P90
  - Max loss, max profit
  - Portfolio distribution shift
- **Profit distribution histograms** — Side-by-side "Before" vs "After"
- **Verdict** — Whether buying improves or hurts the portfolio

### Vegas / Ensemble Tab
- **All probability sources** — Bracket Model, KenPom, Vegas side-by-side
- **Ensemble result** — Final blended probability with weighting explanation
- **Vegas adjustment explanation** — Why later rounds absorb more of the shift
- **Disagreement table** — All teams where model vs Vegas diverge significantly

### Cheatsheet Tab
- **Region difficulty** — Bar chart ranking regions by total EV (EASIEST → HARDEST)
- **Value by seed** — Table with avg EV, max bid, win %, unsold count per seed line
- **Historical price ranges** — From your group's history.csv
- **P(profit) by seed** — Historical win rate per seed
- **Buy/Avoid verdicts** — Based on historical profitability
- **Vegas value picks** — Unsold teams where Vegas sees more upside
- **KenPom profiles summary** — All champ profile, trapezoid, lucky, lopsided, disagreement teams

### Bracket Tab
- **Visual bracket** — 4 regions × 8 first-round matchups
- **Color-coded teams** — Green (yours), dark (sold by others), darker (available)
- **Sold prices / EV display** — Shows price for sold, EV for unsold
- **Regional conflict warnings** — Flags when you own 2+ teams that could face each other in Elite 8
- **Click to select** — Click any team to jump to its analysis

### Steal Alerts
- **Flash notification** — When any team sells for <60% of its EV
- **Green (yours) / Red (someone else)** — Different styling for your steals vs missed ones
- **Auto-dismiss** — 8 seconds, or click to dismiss
- **Persists across refresh** — Saved to localStorage

### Keyboard Shortcuts
- `/` or `Ctrl+K` — Focus search
- `B` — Focus bid input
- `S` — Record sale
- `M` — Record as mine
- `Z` — Undo last sale
- `↑↓` — Navigate team list
- `1-6` — Switch tabs
- `Enter` — Record sale (in bid input)
- `Shift+Enter` — Record as "I bought this"
- `Escape` — Clear search, blur inputs

### Help Mode
- **Toggle button** — ❓ Help in top bar
- **Hover tooltips** — 28+ elements with plain-English explanations
- **Dashed purple outlines** — Shows which elements have help text
- **Banner with turn-off button**

### CSV Export
- **Full data dump** — Team, Seed, Region, EV, MaxBid, Sold Price, My Team, Edge, Win%, P(profit)
- **Profile flags** — Champ Profile, Trapezoid, Balanced, Lopsided, Lucky, Profile Adj columns
- **Downloads as timestamped file** — `calcutta_YYYY-MM-DD.csv`

---

## Data Builder (build_teams_csv.py)

### Sources

| Source | Cost | What it provides |
|--------|------|-----------------|
| Barttorvik (T-Rank) | Free | AdjO, AdjD, AdjT, AdjEM, Luck |
| KenPom API | ~$25/year | AdjO, AdjD, AdjT, AdjEM, Luck, Tournament Probabilities |
| The Odds API | Free (500 req/mo) | Men's + Women's championship futures odds |
| KenPom probs CSV | Manual (with subscription) | Tournament round probabilities (fallback if no API) |

### CLI Flags

| Flag | Effect |
|------|--------|
| `--no-torvik` | Skip Barttorvik |
| `--no-kenpom` | Skip KenPom API |
| `--no-vegas` | Skip all Vegas odds |
| `--no-womens` | Skip women's championship odds |
| `--kenpom-key KEY` | KenPom API key (or `KENPOM_API_KEY` env var) |
| `--odds-key KEY` | The Odds API key (or `ODDS_API_KEY` env var) |
| `--year YEAR` | Season year (default: 2026) |
| `--bracket PATH` | Custom bracket CSV path |
| `--output PATH` | Custom output CSV path |

### Blending

When both Barttorvik and KenPom are available, the script averages their numeric stats (AdjO, AdjD, AdjT, AdjEM, ranks). KenPom luck is preferred when available. A `rating_source` column indicates `both`, `torvik`, or `kenpom` for each team.

### Disagreement Detection

When both sources disagree significantly (AdjEM gap ≥ 3.0 points, rank gap ≥ 20 spots), the script:
1. Prints a formatted table showing both values and the gap
2. Writes raw per-source values to the CSV (`torvik_rating`, `kenpom_rating`, etc.)
3. The dashboard flags these teams with a 🔀 badge

---

## AuctionPro Live Feed (auctionpro_scraper.js)

### How It Works

1. Paste the script into the AuctionPro browser console
2. It auto-detects your auction ID, auth token, and user ID from cookies
3. Polls `/api/auctions/{id}/items.json` every 3 seconds for completed sales
4. Polls `/api/auctions/{id}/current_item.json` every 2 seconds for live bids
5. Sends data to the dashboard via `postMessage` (cross-origin) and `BroadcastChannel` (same-origin)

### Messages Sent

| Type | When | Data |
|------|------|------|
| `sale` | Team sells | team, price, buyer, isMine |
| `live_item` | New team comes up | team, rank, order |
| `live_bid` | Someone bids | team, amount, bidder, isMine |
| `ping` | Every 5 seconds | (heartbeat) |

### Console Commands

```js
calcuttaStatus()                    // Print all sales in a table
calcuttaSale("Houston", 1200)       // Manual sale entry
calcuttaSale("Duke", 95, true)      // Manual entry (your purchase)
calcuttaStop()                      // Stop polling
```

### Requirements

- Dashboard must be served on localhost (`npx serve .`), not opened as `file://`
- AuctionPro page must be open and logged in
- Chrome recommended (for console paste and BroadcastChannel support)

---

## State Persistence

Everything saves to localStorage automatically. If your browser crashes during the auction, reopen the dashboard and you're exactly where you left off.

| State | Persists? |
|-------|-----------|
| Bracket data | ✅ |
| All sold teams (with insertion order = undo stack) | ✅ |
| Your portfolio | ✅ |
| Pot override | ✅ |
| Budget | ✅ |
| History CSV | ✅ |
| Steal alerts | ✅ |
| Search filter | ✅ |
| Selected team | ✅ |
| Active tab | ✅ |
| Current bid input | ✅ |

---

## Architecture

The dashboard is a single-file React app (~3,900 lines) rendered via Babel in the browser. No build step, no server, no dependencies beyond CDN-hosted React and Babel.

All computation happens client-side:
- Monte Carlo tournament simulation (5,000 sims)
- Bayesian pot estimation (Normal-Normal conjugate update)
- Portfolio profit distribution (full MC with correlated tournament outcomes)
- Ensemble probability blending (3 sources × 6 rounds × 64 teams)

The AuctionPro scraper is a plain JavaScript IIFE that runs in the browser console and communicates via the standard Web APIs (`postMessage`, `BroadcastChannel`, `fetch`).
