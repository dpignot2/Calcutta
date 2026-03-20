# Calcutta Auction Estimator — Usage Guide

## Quick Start (30 seconds)

Run with zero setup to see seed-based valuations for a $5,000 pot:

```bash
python calcutta_estimator.py
```

That's it. You'll get EV and max bid for every seed position.

---

## Setup: Building Your Bracket File

For team-specific analysis, you need a bracket JSON file. Generate a blank template:

```bash
python calcutta_estimator.py --template
```

This creates `bracket_template.json`. Fill it in with your bracket. Each team needs a name, seed, and KenPom AdjEM rating (get from kenpom.com the day of your auction):

```json
{
  "pot_size": 5000,
  "payouts": {
    "R64": 0.025, "R32": 0.05, "Sweet 16": 0.1,
    "Elite 8": 0.15, "Final Four": 0.225, "Championship": 0.45
  },
  "regions": {
    "East": [
      {"name": "UConn", "seed": 1, "rating": 32.0},
      {"name": "Iowa St", "seed": 2, "rating": 24.5},
      {"name": "Illinois", "seed": 3, "rating": 23.0}
    ]
  }
}
```

Edit `pot_size` and `payouts` to match your pool's rules. The payouts must sum to 1.0.

### Bonus Payouts

If your pool has bonus prizes (women's tournament winner, biggest blowout, etc.), add a `bonuses` block to the JSON:

```json
{
  "pot_size": 5000,
  "bonuses": {
    "womens_champ": 0.02,
    "biggest_blowout": 0.01
  },
  "regions": { ... }
}
```

Bonuses come out of the pot — round payouts are automatically scaled down (e.g., with 3% in bonuses, rounds are scaled to 97%).

For the women's tournament bonus, add `womens_win_prob` to each team whose school also has a women's team in the women's bracket. This is the probability that school's women's team wins the women's NCAA tournament. Set to 0 (or omit) for schools not in the women's bracket:

```json
{"name": "South Carolina", "seed": 6, "rating": 17.5, "womens_win_prob": 0.25},
{"name": "UConn", "seed": 1, "rating": 32.0, "womens_win_prob": 0.15},
{"name": "Gonzaga", "seed": 5, "rating": 19.0}
```

This creates hidden value — South Carolina as a 6-seed might only be worth $11 from tournament rounds, but with a 25% women's championship probability it's actually worth $36. The tool shows this in breakeven tables and rankings:

```
🎁 Womens Champ                             $    25
EV: $36  |  Edge: $+16  |  ROI: +80%
```

The biggest blowout bonus is modeled automatically from seed matchups — 1-seeds playing 16-seeds have the highest expected margins and dominate the blowout probability.

### Vegas Odds Integration

Add `vegas_odds` to any team in American format to blend sportsbook wisdom with the model:

```json
{"name": "UConn", "seed": 1, "rating": 32.0, "vegas_odds": 200},
{"name": "Purdue", "seed": 1, "rating": 28.5, "vegas_odds": 500},
{"name": "Baylor", "seed": 3, "rating": 22.0, "vegas_odds": 5000}
```

American odds format: `+1400` means bet $100 to win $1,400 (implied 6.7%). `-200` means bet $200 to win $100 (implied 66.7%). Just enter the number — positive values assumed.

The tool:
1. Converts odds to implied championship probabilities and removes the vig
2. Decomposes title probability into round-by-round probs using the seed's historical path shape
3. Blends 50/50 with the Monte Carlo model (configurable via `VEGAS_BLEND_WEIGHT`)
4. Flags significant model vs. Vegas disagreements with dollar impact

```
🎰 VEGAS BLEND: 16 teams blended (50% Vegas / 50% model)

⚡ MODEL vs. VEGAS DISAGREEMENTS (threshold: 1.5x):
   Team                       Model   Vegas        Gap Direction
   (3) Kentucky               0.4%   1.6% $    -234 Vegas HIGHER
   (4) Duke                   0.1%   1.0% $    -229 Vegas HIGHER
```

"Vegas HIGHER" means our model is less optimistic than the market — these teams may be undervalued by the model. "Model HIGHER" means our sim is more bullish than Vegas — be cautious.

---

## Four Estimation Methods

### 1. Seed-Based (no data needed)

```bash
python calcutta_estimator.py --pot 6000
```

Uses historical NCAA tournament advancement rates (1985–2024). All 1-seeds get the same value, all 2-seeds get the same value, etc. Good for quick ballpark estimates.

### 2. Bracket-Adjusted (bracket required, ratings optional)

```bash
python calcutta_estimator.py --method bracket_adjusted --bracket bracket.json
```

Adjusts historical rates based on the actual bracket draw. A 1-seed in a weak region gets higher rates than a 1-seed in a murder region. Shows region difficulty:

```
📊 BRACKET DIFFICULTY BY REGION:
  South        Total EV: $1,190  1-seed title prob: 18.4%
  East         Total EV: $1,361  1-seed title prob: 26.2%
```

Works with or without KenPom ratings — if ratings are present, uses them for opponent strength; otherwise falls back to seed-based strength estimates.

### 3. Monte Carlo (bracket + ratings required)

```bash
python calcutta_estimator.py --method monte_carlo --bracket bracket.json --sims 50000
```

The gold standard. Simulates the full tournament 50,000 times using KenPom ratings. Produces team-specific probabilities, bracket paths, and (crucially) the simulation matrix needed for portfolio analysis in live mode.

### 4. Manual Probabilities

```bash
python calcutta_estimator.py --method manual --bracket bracket.json
```

Uses custom `custom_probs` arrays you specify per team in the JSON. For when you want to plug in probabilities from an external model.

---

## Historical Auction Analysis

Track how your group bids to find market inefficiencies. Generate a history template:

```bash
python calcutta_estimator.py --history-template
```

Fill in past auction data (year, team, seed, price paid, round eliminated), then run:

```bash
python calcutta_estimator.py --method monte_carlo --bracket bracket.json --history auction_history.csv
```

This does two things:

- **Market bias adjustment**: Shows which seeds your group over/underpays for. If your group historically overpays for 1-seeds by 2x, you'll see that reflected everywhere in live mode — the dashboard shows adjusted max bids, sale recordings flag when prices deviate from your group's patterns, suggestions boost undervalued seeds and penalize crowded ones, and whatif notes historical context for the seed you're evaluating.
- **Bayesian pot prior**: Uses historical pot sizes to set an informed prior for pot estimation. If your group's pot has been $4,800, $5,200, and $5,100 the last three years, the Bayesian model starts there instead of blindly trusting your guess.

In the live dashboard, you'll see an `Adj Max` column and bias tags:

```
Rank  Team                       EV  Max Bid  Adj Max   Bias  Win %   BE @ Max
  1   (1) UConn              $ 1,325 $ 1,126 $   537 ↑2.10x 37.0% Championship
  5   (2) Arizona            $   303 $   258 $   129 ↑2.00x  5.0%    Elite 8
 13   (4) Alabama            $    49 $    41 $   143 ↓0.29x  0.3%   Sweet 16

📊 Adj Max = Max Bid ÷ historical bias. ↑ = group overpays (bid less), ↓ = undervalued (opportunity)
```

The `↑` seeds face stiff competition in your group — bid below Adj Max. The `↓` seeds are bargains nobody fights for.

---

## Live Auction Mode

This is the main event. Launch it before your auction starts:

```bash
python calcutta_estimator.py --live --method monte_carlo --bracket bracket.json
```

With historical data (recommended):

```bash
python calcutta_estimator.py --live --method monte_carlo --bracket bracket.json --history auction_history.csv
```

### Recording Sales

As teams sell, type the team name and price:

```
🏀 > UConn 950
✅ SOLD: (1) UConn for $950
   EV: $1,225  |  Edge: $+275  |  💰 GREAT VALUE
   Breakeven: Championship (36% prob)  |  Pot: $950 → $4,596 projected (↓$404)
```

### The `whatif` Command

Test a price without recording it. Essential for deciding your max bid in real time:

```
🏀 > whatif Baylor 50

(3) Baylor  |  Price: $50  |  Pot: $5,000
Round          Opponent                     Prob   Cumul.       P&L
R64            vs (14) Colgate            98.2% $     4 -$    46
R32            vs (6) Clemson / (11) ...  76.3% $    20 -$    30
Sweet 16       vs (2) Arizona / (7) D...  30.5% $    82 $     32  ◄ BREAKEVEN
Elite 8        vs (1) North Carolina ...  11.2% $   270 $    220

Breakeven: Sweet 16 (31% chance) — vs (2) Arizona / (7) Dayton
Risk: 🟢 BALANCED — value spread across rounds
```

This tells you exactly who Baylor has to beat to break even, and the probability of getting there.

When you have a portfolio (i.e., you've used `my` to mark teams as yours), whatif automatically appends a full portfolio impact analysis:

```
📦 PORTFOLIO IMPACT
                                 Current       + This      Delta
                      Teams            1            2
                   Invested $       850 $       900 $     +50
               Portfolio EV $     1,234 $     1,319 $     +85
                    EV Edge $      +384 $      +419 $     +35

  Region: 🟢 NEW REGION — adds diversification

                  P(profit)         37%         40%      +3% ▲
            Expected profit $      +384 $      +419 $    +35 ▲
             Median outcome $       -90 $      -122 $    -32 ▼
                10th pctile $      -832 $      -821 $    +11 ▲
                90th pctile $    +1,966 $    +1,991 $    +25 ▲
           Volatility (std) $     1,230 $     1,254 $    +23 ▼

  ✅ GOOD ADD — improves win probability without crushing downside
```

This shows before/after for every key metric: P(profit), median outcome, downside risk, upside, and volatility. It also flags region overlap — if you already own a team in the same region, it warns you that only one can advance past the Elite 8. The verdict line summarizes: ✅ GOOD ADD, ⚠️ HIGH VARIANCE, ❌ PORTFOLIO DRAG, ➡️ NEUTRAL, or 🤔 MARGINAL.

### Portfolio Tracking

Mark teams you buy with `my` instead of just recording the sale:

```
🏀 > my UConn 950       # Record sale AND mark as mine
🏀 > my Baylor 50       # Same
🏀 > budget 2000        # Set remaining budget
```

If someone else buys a team, just record the sale normally:

```
🏀 > Arizona 300        # Someone else bought it
```

If you forgot to use `my` when you bought something:

```
🏀 > my UConn           # Claim an already-sold team as yours
```

### Portfolio Analysis

```
🏀 > portfolio
```

Shows your complete portfolio breakdown:

```
📊 PORTFOLIO ANALYSIS
Teams owned: 3  |  Total invested: $1,250  |  Portfolio EV: $1,580
Edge: $+330  |  Budget remaining: $750

Region exposure:
  East         ██ 2 — (1) UConn, (3) Baylor
  South        █ 1 — (2) Tennessee
  Midwest      ░ 0   ← UNCOVERED
  West         ░ 0   ← UNCOVERED

📈 PAYOUT DISTRIBUTION (50,000 simulations)
Total invested:     $   1,250
Expected payout:    $   1,580  (EV profit: $+330)
Median outcome:     $    -680

Probability of profit:    38%
Outcome ranges:
  Best case:   $+  5,832
  90th pctile: $+  1,682
  Median:      $-    680
  10th pctile: $-  1,170
  Worst case:  $-  1,250
```

The distribution analysis requires Monte Carlo mode — it uses the simulation matrix to compute your exact payout across 50,000 tournament outcomes.

### Purchase Suggestions

```
🏀 > suggest
```

Ranks unsold teams by marginal value to *your specific portfolio*:

```
🎯 SUGGESTED NEXT BUYS
Score = EV/$ × Region bonus × Hedge bonus

  #  Team                   Max Bid  EV/$  Region  Hedge  Score  BE         Why
  1  (1) North Carolina     $  402  1.18x   1.25x  1.15x  1.69  F4     NEW RGN+HEDGE
  2  (2) Marquette          $  133  1.18x   1.00x  1.08x  1.27  E8     HEDGE
  3  (4) Kansas             $   29  1.17x   1.25x  0.98x  1.43  S16    NEW RGN+VALUE
```

The scoring considers:
- **EV per dollar**: Raw value
- **Region bonus**: 25% bonus for teams in uncovered regions (diversification)
- **Hedge bonus**: Teams that improve your portfolio's probability of profit or reduce downside (requires Monte Carlo)
- **Market bias**: Seeds your group historically underpays get a BARGAIN boost; overpaid seeds get penalized as CROWDED (requires `--history`)

### Cheatsheet

```
🏀 > cheatsheet
```

A condensed bidding guide you can pull up anytime during the auction. Shows four things:

**Region difficulty** — visual ranking from easiest to hardest bracket, with EV totals and 1-seed title probabilities. Flags which regions your portfolio doesn't cover yet:

```
🗺️  REGION DIFFICULTY
  East         █████████████████████████ EV: $2,599  1-seed title: 37.1%  EASIEST
  Midwest      ████████████████████      EV: $2,043  1-seed title: 20.3%
  South        ████████████████          EV: $1,703  1-seed title: 17.3%
  West         ████████████████          EV: $1,628  1-seed title: 10.6%  HARDEST
  ⚠️  Uncovered regions: Midwest, South
```

**Historical prices & win rates** — for each seed, shows your group's price range, what fraction of purchases were profitable, and a BUY/OK/RISKY/AVOID verdict:

```
💰 HISTORICAL PRICES & WIN RATES BY SEED
  Seed          Range   Median  P(profit)  Avg ROI    Verdict
  1    $900–$1,300 $1,075       12%    -52%    🔴 AVOID
  4     $90– $150  $ 120       38%   +247%       🟡 OK
  5     $30–  $80  $  48       75%   +558%      🟢 BUY
```

**Price anchors** — at the median price your group pays for each seed, what round do you need to break even and what's the probability?

```
🎯 PRICE ANCHORS
  Seed   Med Price       BE Round  BE Prob
  1      $  1,075     Final Four     28%
  4      $    120       Sweet 16     28%
  5      $     48       Sweet 16     18%
```

These inline stats also appear automatically on sales and whatif commands when `--history` is provided.

### Bayesian Pot Estimation

The dashboard shows the Bayesian posterior estimate of the final pot:

```
Projected final pot: $4,438
Bayesian 90% CI: $3,043–$5,833  |  Uncertainty: ±$848
Prior: $5,000  |  Implied avg: $3,958  |  EV share sold: 59%
```

Each sale updates the estimate. Early in the auction, the prior dominates. As more teams sell (especially high-EV teams), the data takes over. The credible interval tells you how confident the model is.

### All Live Commands

| Command | What it does |
|---------|-------------|
| `UConn 950` | Record a sale |
| `my UConn 950` | Record a sale and mark as mine |
| `my UConn` | Mark an already-sold team as mine |
| `unmy UConn` | Remove from my portfolio (stays sold) |
| `whatif UConn 800` | Breakeven analysis without recording |
| `portfolio` | Full portfolio analysis |
| `suggest` | Portfolio-optimized purchase recommendations |
| `budget 2000` | Set remaining budget |
| `show` | Refresh the dashboard |
| `search baylor` | Find a team by name |
| `remaining` | Show all unsold teams |
| `undo` | Undo the last sale |
| `pot 6000` | Manually override pot projection |
| `export` | Export current state to CSV |
| `quit` | Save and exit (resume later with `--resume`) |

### Resuming an Auction

If you quit and come back:

```bash
python calcutta_estimator.py --live --method monte_carlo --bracket bracket.json --resume auction_state.json
```

All sales, portfolio data, and budget are restored.

---

## Workflow for Auction Night

**Before the auction:**

1. Fill in your bracket JSON with team names and KenPom ratings
2. If you have historical data, fill in the CSV
3. Run a full analysis to study valuations:
   ```bash
   python calcutta_estimator.py --method monte_carlo --bracket bracket.json --history history.csv
   ```
4. Note your target teams and max bids
5. Decide your total budget (e.g., "$2,000 to spend across ~5 teams")

**During the auction:**

1. Launch live mode:
   ```bash
   python calcutta_estimator.py --live --method monte_carlo --bracket bracket.json --history history.csv
   ```
2. Set your budget: `budget 2000`
3. Record every sale as it happens (yours with `my`, others without)
4. Use `whatif` before bidding to check breakeven
5. Run `suggest` periodically to find the best remaining values for your portfolio
6. Run `portfolio` after each purchase to check region balance and risk

**Key principles:**
- Let others overpay for 1-seeds (60%+ of their EV is Championship-or-bust)
- Target 3-5 seeds in different regions — they break even at Sweet 16
- `suggest` will flag diversification opportunities — listen to it
- Watch the Bayesian pot estimate — if the market is cold, lower seeds become relatively cheaper because the pot (and therefore all payouts) will be smaller
- Schools with strong women's programs are undervalued — the women's champ bonus is "free" EV that most bidders don't factor in
- 1-seeds get a small blowout bonus edge too (1-vs-16 produces the biggest R64 margins)
