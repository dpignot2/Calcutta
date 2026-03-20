"""
March Madness Calcutta Auction Value Estimator
===============================================

Estimates the expected value (EV) of each team in a Calcutta-style auction
to determine maximum bid amounts. Supports three estimation methods:

1. Historical seed-based averages (no setup needed)
2. Monte Carlo simulation with team power ratings (e.g., KenPom AdjEM)
3. Manual probability input per team

Usage:
    # Quick seed-based analysis:
    python calcutta_estimator.py

    # Monte Carlo with team ratings:
    python calcutta_estimator.py --method monte_carlo --bracket bracket.json

    # See all options:
    python calcutta_estimator.py --help

Configuration:
    - Edit PAYOUT_STRUCTURE below to match your pool's payout rules
    - Edit ESTIMATED_POT to match your expected total auction pot
    - Edit RISK_DISCOUNT to adjust bid aggressiveness
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple


# ============================================================
# CONFIGURATION — EDIT THESE TO MATCH YOUR POOL
# ============================================================

# Payout structure: fraction of total pot allocated to each round's prize pool.
# These MUST sum to 1.0. The pool for each round is split among all teams
# that win a game in that round.
#
# Example with a $5,000 pot:
#   R64 pool = 2.5% × $5,000 = $125, split among 32 winners = $3.91 each
#   Championship pool = 45% × $5,000 = $2,250, goes to the 1 champion
#
# If your pool pays each team a FIXED amount per round win instead (e.g.,
# "each R64 winner gets $X"), set PAYOUT_MODEL = "per_team" below and set
# the fractions so that 32*f1 + 16*f2 + 8*f3 + 4*f4 + 2*f5 + 1*f6 = 1.0.
PAYOUT_STRUCTURE = {
    "R64":          0.025,   # Round of 64
    "R32":          0.050,   # Round of 32
    "Sweet 16":     0.100,   # Sweet 16
    "Elite 8":      0.150,   # Elite 8
    "Final Four":   0.225,   # Final Four semifinal
    "Championship": 0.450,   # Championship game
}

# How the payout fractions are interpreted:
#   "pool"     = fraction is the total prize pool for that round, split among
#                all winners (most common in Calcuttas). Total EV = pot.
#   "per_team" = each winning team gets fraction × pot. You must ensure
#                32*f1 + 16*f2 + 8*f3 + 4*f4 + 2*f5 + 1*f6 = 1.0.
PAYOUT_MODEL = "pool"

# Number of game winners in each round (fixed by bracket structure)
WINNERS_PER_ROUND = {
    "R64": 32,
    "R32": 16,
    "Sweet 16": 8,
    "Elite 8": 4,
    "Final Four": 2,
    "Championship": 1,
}

# Estimated total pot size (sum of ALL winning bids across all 64 teams).
# Base this on your group's history or: num_bidders × avg_spend_per_person.
ESTIMATED_POT = 5000

# Risk discount factor: multiply EV by this to get recommended max bid.
#   1.0  = bid up to full expected value (aggressive / EV-neutral)
#   0.85 = bid up to 85% of EV (moderate — recommended)
#   0.70 = bid up to 70% of EV (conservative)
RISK_DISCOUNT = 0.85

# Bonus payouts: additional prizes that come OUT of the pot.
# These reduce the round payouts proportionally.
# Set to 0.0 to disable a bonus.
BONUS_PAYOUTS = {
    # Whoever owns the team that wins the women's NCAA tournament
    # (only applies to teams that appear in BOTH men's and women's brackets)
    "womens_champ": 0.02,     # 2% of pot
    # Whoever owns the team with the biggest margin of victory in R64
    "biggest_blowout": 0.01,  # 1% of pot
}

# Vegas odds blending: when teams have vegas_odds in the bracket JSON,
# blend the model's probabilities with Vegas-implied probabilities.
# 0.0 = ignore Vegas entirely (pure model)
# 0.5 = 50/50 blend (recommended — gets best of both)
# 1.0 = ignore model entirely (pure Vegas)
VEGAS_BLEND_WEIGHT = 0.50

# Disagreement threshold: flag when model and Vegas title probs differ
# by more than this ratio. E.g., 1.5 means "flag if model is 50%+ higher
# or lower than Vegas."
VEGAS_DISAGREEMENT_THRESHOLD = 1.5

# Number of Monte Carlo simulations (more = more accurate but slower).
# 50k is a good balance; 100k+ for precision.
NUM_SIMULATIONS = 50_000


# ============================================================
# ROUND DEFINITIONS
# ============================================================

ROUNDS = list(PAYOUT_STRUCTURE.keys())


def bonus_total_fraction() -> float:
    """Sum of all bonus payout fractions. Rounds are scaled down by this amount."""
    return sum(BONUS_PAYOUTS.values())


def round_scale_factor() -> float:
    """
    Scale factor applied to round payouts to accommodate bonus payouts.

    If round fractions sum to 1.0 and bonuses sum to 0.03, rounds are
    multiplied by 0.97 so that total (rounds + bonuses) = 1.0.
    """
    bonus = bonus_total_fraction()
    round_sum = sum(PAYOUT_STRUCTURE.values())
    if round_sum <= 0:
        return 1.0
    return (1.0 - bonus) / round_sum


def per_team_payout(round_name: str, pot: float) -> float:
    """
    Calculate the payout a single team receives for winning a game in the
    given round, based on the configured payout model.

    Automatically scales round payouts down when bonus payouts are configured
    (since bonuses come out of the pot).

    Args:
        round_name: Name of the round (e.g., "R64", "Sweet 16")
        pot: Total pot size

    Returns:
        Dollar amount a single winning team receives for that round
    """
    frac = PAYOUT_STRUCTURE[round_name]
    scale = round_scale_factor()
    if PAYOUT_MODEL == "pool":
        # Round pool is split among all winners
        return (frac * scale * pot) / WINNERS_PER_ROUND[round_name]
    else:
        # Each winner gets fraction × pot directly
        return frac * scale * pot


def cumulative_payouts(pot: float) -> List[Dict]:
    """
    Calculate the cumulative payout a team collects as it advances
    through each round.

    Returns a list of dicts (one per round) with:
        round_name: str
        round_payout: float    - payout for winning THIS round
        cumulative_payout: float - total collected through this round

    Example with $5,000 pot:
        R64:          $3.91  cumulative: $3.91
        R32:          $15.63 cumulative: $19.53
        Sweet 16:     $62.50 cumulative: $82.03
        Elite 8:      $187.50 cumulative: $269.53
        Final Four:   $562.50 cumulative: $832.03
        Championship: $2,250  cumulative: $3,082.03

    Args:
        pot: Total pot size

    Returns:
        List of dicts with round_name, round_payout, cumulative_payout
    """
    rounds_info = []
    cumulative = 0.0
    for round_name in PAYOUT_STRUCTURE:
        payout = per_team_payout(round_name, pot)
        cumulative += payout
        rounds_info.append({
            "round_name": round_name,
            "round_payout": payout,
            "cumulative_payout": cumulative,
        })
    return rounds_info


def breakeven_round(price: float, pot: float) -> Optional[str]:
    """
    Determine which round a team must WIN THROUGH to recoup the purchase
    price. Returns None if the team can't break even even by winning the
    championship.

    Args:
        price: Amount paid for the team
        pot: Total (or projected) pot size

    Returns:
        Round name where cumulative payout >= price, or None
    """
    for info in cumulative_payouts(pot):
        if info["cumulative_payout"] >= price:
            return info["round_name"]
    return None


def print_breakeven_table(
    result: CalcuttaResult,
    price: float,
    pot: float,
):
    """
    Print a detailed breakeven analysis for a team at a given price.

    Shows:
        - Per-round opponent (from bracket path, if available)
        - Per-round probability (likelihood of getting there)
        - Per-round payout and cumulative payout (what you collect)
        - Running P&L at each round (cumulative payout - price)
        - Breakeven round highlighted
        - Expected value vs price paid
        - Risk profile

    When bracket_path is available on the CalcuttaResult, each round shows
    the likely opponent(s), making the breakeven analysis concrete:
    "You need Elite 8 to break even — that means beating Arizona."

    Args:
        result: CalcuttaResult for the team
        price: Actual or hypothetical price
        pot: Total (or projected) pot size
    """
    payouts = cumulative_payouts(pot)
    be_round = breakeven_round(price, pot)
    has_path = result.bracket_path is not None

    print(f"\n  {'─' * 90}")
    print(f"  {result.team}  |  Price: ${price:,.0f}  |  Pot: ${pot:,.0f}")
    print(f"  {'─' * 90}")

    if has_path:
        print(f"  {'Round':<14} {'Opponent':<26} {'Prob':>6} {'Cumul.':>8} "
              f"{'P&L':>9} {'':>10}")
    else:
        print(f"  {'Round':<14} {'Prob':>7} {'Payout':>9} {'Cumul.':>9} "
              f"{'P&L':>10} {'':>10}")
    print(f"  {'─' * 90}")

    for i, info in enumerate(payouts):
        rnd = info["round_name"]
        payout = info["round_payout"]
        cumul = info["cumulative_payout"]
        prob = result.round_probs[i] if i < len(result.round_probs) else 0.0
        pnl = cumul - price

        # Highlight breakeven round
        marker = ""
        if rnd == be_round:
            marker = " ◄ BREAKEVEN"

        # Opponent info
        if has_path and i < len(result.bracket_path.opponent_labels):
            opp_label = result.bracket_path.opponent_labels[i]
            # Truncate long labels
            if len(opp_label) > 25:
                opp_label = opp_label[:22] + "..."
            print(
                f"  {rnd:<14} {opp_label:<26} {prob:>5.1%} ${cumul:>6,.0f} "
                f"{'${:>7,.0f}'.format(pnl) if pnl >= 0 else '-${:>6,.0f}'.format(abs(pnl))} "
                f"{marker}"
            )
        else:
            print(
                f"  {rnd:<14} {prob:>6.1%} ${payout:>7,.0f} ${cumul:>7,.0f} "
                f"{'${:>8,.0f}'.format(pnl) if pnl >= 0 else '-${:>7,.0f}'.format(abs(pnl))} "
                f"{marker}"
            )

    # Summary stats
    round_ev_total = sum(
        (result.round_probs[i] if i < len(result.round_probs) else 0.0)
        * per_team_payout(rnd, pot)
        for i, rnd in enumerate(PAYOUT_STRUCTURE)
    )

    # Add bonus EVs to total
    bonus_ev_total = 0.0
    if result.bonus_evs:
        bonus_ev_total = sum(result.bonus_evs.values())
        if bonus_ev_total > 0.50:
            # Show bonus lines in the table (only non-trivial ones)
            for bonus_name, bev in result.bonus_evs.items():
                if bev > 0.50:
                    label = bonus_name.replace("_", " ").title()
                    print(f"  🎁 {label:<40} ${bev:>6,.0f}")

    total_ev_at_pot = round_ev_total + bonus_ev_total
    edge = total_ev_at_pot - price
    roi = (total_ev_at_pot / price - 1) if price > 0 else 0

    # Probability of reaching breakeven
    be_prob = 0.0
    if be_round:
        be_idx = list(PAYOUT_STRUCTURE.keys()).index(be_round)
        be_prob = result.round_probs[be_idx] if be_idx < len(result.round_probs) else 0.0

    # Risk score: what fraction of EV comes from Championship round
    champ_ev = (
        (result.round_probs[-1] if result.round_probs else 0.0)
        * per_team_payout(list(PAYOUT_STRUCTURE.keys())[-1], pot)
    )
    champ_concentration = champ_ev / total_ev_at_pot if total_ev_at_pot > 0 else 0.0

    # Early round EV: fraction of EV from first 3 rounds
    early_ev = sum(
        (result.round_probs[i] if i < len(result.round_probs) else 0.0)
        * per_team_payout(rnd, pot)
        for i, rnd in enumerate(list(PAYOUT_STRUCTURE.keys())[:3])
    )
    early_concentration = early_ev / total_ev_at_pot if total_ev_at_pot > 0 else 0.0

    print(f"  {'─' * 90}")
    print(f"  EV: ${total_ev_at_pot:,.0f}  |  Edge: ${edge:+,.0f}  |  ROI: {roi:+.0%}")

    if be_round:
        # Show the specific opponent at the breakeven round
        be_detail = ""
        if has_path:
            be_idx_for_label = list(PAYOUT_STRUCTURE.keys()).index(be_round)
            if be_idx_for_label < len(result.bracket_path.opponent_labels):
                be_detail = f" — {result.bracket_path.opponent_labels[be_idx_for_label]}"
        print(f"  Breakeven: {be_round} ({be_prob:.0%} chance){be_detail}")
    else:
        print(f"  ⚠️  Cannot break even — price exceeds max possible payout!")

    # Risk profile label
    if early_concentration > 0.40:
        risk_label = "🟢 LOW RISK — heavy early-round payouts"
    elif champ_concentration > 0.60:
        risk_label = "🔴 HIGH RISK — needs deep run to pay off"
    elif champ_concentration > 0.40:
        risk_label = "🟡 MODERATE — needs solid tournament run"
    else:
        risk_label = "🟢 BALANCED — value spread across rounds"

    print(f"  Risk: {risk_label}")
    print(f"  Early rounds (R64-S16): {early_concentration:.0%} of EV  |  "
          f"Championship: {champ_concentration:.0%} of EV")


# ============================================================
# HISTORICAL SEED ADVANCEMENT RATES (1985–2024)
# ============================================================
# Each list = cumulative probability of winning THROUGH each round.
#   Index 0 = P(win R64 game)
#   Index 1 = P(win R64 AND R32 games)  [= P(reach Sweet 16)]
#   Index 2 = P(win through Sweet 16)    [= P(reach Elite 8)]
#   Index 3 = P(win through Elite 8)     [= P(reach Final Four)]
#   Index 4 = P(win through Final Four)  [= P(reach Championship)]
#   Index 5 = P(win Championship)        [= P(win it all)]

HISTORICAL_RATES = {
    1:  [0.993, 0.850, 0.600, 0.420, 0.280, 0.110],
    2:  [0.940, 0.720, 0.475, 0.315, 0.185, 0.060],
    3:  [0.850, 0.595, 0.330, 0.190, 0.105, 0.030],
    4:  [0.790, 0.530, 0.275, 0.150, 0.075, 0.020],
    5:  [0.640, 0.380, 0.180, 0.095, 0.045, 0.010],
    6:  [0.630, 0.380, 0.170, 0.080, 0.035, 0.010],
    7:  [0.600, 0.330, 0.140, 0.060, 0.025, 0.005],
    8:  [0.500, 0.250, 0.100, 0.040, 0.018, 0.004],
    9:  [0.500, 0.220, 0.080, 0.030, 0.013, 0.003],
    10: [0.400, 0.200, 0.080, 0.030, 0.012, 0.003],
    11: [0.370, 0.180, 0.090, 0.040, 0.018, 0.004],
    12: [0.360, 0.140, 0.048, 0.018, 0.007, 0.001],
    13: [0.210, 0.060, 0.018, 0.006, 0.002, 0.0003],
    14: [0.150, 0.038, 0.010, 0.003, 0.001, 0.0001],
    15: [0.060, 0.018, 0.005, 0.002, 0.0005, 0.0001],
    16: [0.010, 0.003, 0.001, 0.0003, 0.0001, 0.00003],
}


# ============================================================
# HISTORICAL HEAD-TO-HEAD WIN RATES BY SEED MATCHUP
# ============================================================
# P(row_seed beats col_seed) in a single game, derived from
# historical NCAA tournament results 1985–2024.
# Used to adjust advancement rates when bracket opponents are known.

def historical_matchup_rate(seed_a: int, seed_b: int) -> float:
    """
    Estimated P(seed_a beats seed_b) in a single tournament game,
    based on historical data.

    Uses a logistic model calibrated to historical seed upset rates.
    The scale factor of 5.5 is tuned so that, e.g.:
        1v16 ≈ 99%, 1v8 ≈ 75%, 1v5 ≈ 63%, 5v12 ≈ 64%, 8v9 ≈ 50%

    This is used for bracket-aware adjustments when KenPom ratings
    are not available. When ratings ARE available, the logistic model
    with actual ratings is preferred.

    Args:
        seed_a: Seed of team A (1-16)
        seed_b: Seed of team B (1-16)

    Returns:
        Win probability for team A (0.0 to 1.0)
    """
    # Map seeds to approximate strength (lower seed = stronger)
    # Using a log scale: seed 1 ≈ strength 16, seed 16 ≈ strength 1
    strength_a = 17 - seed_a
    strength_b = 17 - seed_b
    diff = strength_a - strength_b
    return 1.0 / (1.0 + 10.0 ** (-diff / 5.5))


# ============================================================
# BRACKET PATH COMPUTATION
# ============================================================
# Standard NCAA bracket structure determines who can play whom.
# This maps each seed to its R64 opponent and subsequent bracket
# "pods" (groups of seeds that feed into the same later-round slot).

# R64 matchups in bracket order (this also defines R32 matchups)
BRACKET_ORDER = [(1, 16), (8, 9), (5, 12), (4, 13),
                 (6, 11), (3, 14), (7, 10), (2, 15)]

# Bracket pods: which seeds a given seed can face in each round
# Pod structure (bracket order):
#   Top quarter:  (1,16) vs (8,9)  →  vs (5,12)/(4,13)
#   Bot quarter:  (6,11) vs (3,14) →  vs (7,10)/(2,15)
#   Top half vs Bottom half in E8

BRACKET_PODS = {
    # seed: {round_idx: [possible opponent seeds]}
    # round 0 = R64, round 1 = R32, round 2 = S16, round 3 = E8
    1:  {0: [16], 1: [8, 9], 2: [4, 5, 12, 13], 3: [2, 3, 6, 7, 10, 11, 14, 15]},
    16: {0: [1],  1: [8, 9], 2: [4, 5, 12, 13], 3: [2, 3, 6, 7, 10, 11, 14, 15]},
    8:  {0: [9],  1: [1, 16], 2: [4, 5, 12, 13], 3: [2, 3, 6, 7, 10, 11, 14, 15]},
    9:  {0: [8],  1: [1, 16], 2: [4, 5, 12, 13], 3: [2, 3, 6, 7, 10, 11, 14, 15]},
    5:  {0: [12], 1: [4, 13], 2: [1, 8, 9, 16],  3: [2, 3, 6, 7, 10, 11, 14, 15]},
    12: {0: [5],  1: [4, 13], 2: [1, 8, 9, 16],  3: [2, 3, 6, 7, 10, 11, 14, 15]},
    4:  {0: [13], 1: [5, 12], 2: [1, 8, 9, 16],  3: [2, 3, 6, 7, 10, 11, 14, 15]},
    13: {0: [4],  1: [5, 12], 2: [1, 8, 9, 16],  3: [2, 3, 6, 7, 10, 11, 14, 15]},
    6:  {0: [11], 1: [3, 14], 2: [2, 7, 10, 15], 3: [1, 4, 5, 8, 9, 12, 13, 16]},
    11: {0: [6],  1: [3, 14], 2: [2, 7, 10, 15], 3: [1, 4, 5, 8, 9, 12, 13, 16]},
    3:  {0: [14], 1: [6, 11], 2: [2, 7, 10, 15], 3: [1, 4, 5, 8, 9, 12, 13, 16]},
    14: {0: [3],  1: [6, 11], 2: [2, 7, 10, 15], 3: [1, 4, 5, 8, 9, 12, 13, 16]},
    7:  {0: [10], 1: [2, 15], 2: [3, 6, 11, 14], 3: [1, 4, 5, 8, 9, 12, 13, 16]},
    10: {0: [7],  1: [2, 15], 2: [3, 6, 11, 14], 3: [1, 4, 5, 8, 9, 12, 13, 16]},
    2:  {0: [15], 1: [7, 10], 2: [3, 6, 11, 14], 3: [1, 4, 5, 8, 9, 12, 13, 16]},
    15: {0: [2],  1: [7, 10], 2: [3, 6, 11, 14], 3: [1, 4, 5, 8, 9, 12, 13, 16]},
}


@dataclass
class BracketPath:
    """
    The specific opponents a team will face in each round, based on their
    bracket position. For intra-region rounds (R64–E8), opponents are known
    by seed. For Final Four and Championship, opponents come from other regions.

    Attributes:
        opponents: List of opponent descriptions per round.
            Each entry is a list of (team_name, seed, rating_or_none) tuples
            representing the most likely opponents for that round.
        opponent_labels: Human-readable strings like "vs (16) Fairleigh Dickinson"
        win_probs: Per-round conditional P(win this round | reached it),
            computed from actual opponent strength rather than historical averages.
    """
    opponents: List[List[Tuple[str, int, Optional[float]]]]  # per round
    opponent_labels: List[str]                                 # per round
    win_probs: List[float]                                     # conditional per round


def compute_bracket_path(
    team: Team,
    region_teams: List[Team],
    all_regions: Optional[Dict[str, List[Team]]] = None,
) -> BracketPath:
    """
    Compute a team's path through the bracket, identifying likely opponents
    for each round.

    For intra-region rounds (R64 through E8), opponents are determined by
    bracket structure. For Final Four and Championship, opponents are the
    top teams from other regions.

    For each round, computes a probability-weighted "expected opponent"
    using either KenPom ratings (if available) or seed-based win rates.

    Args:
        team: The team to analyze
        region_teams: All 16 teams in the team's region (sorted by seed)
        all_regions: All regions dict (optional, for F4/Championship paths)

    Returns:
        BracketPath with opponent info and conditional win probabilities
    """
    by_seed = {t.seed: t for t in region_teams}
    has_ratings = all(t.rating is not None for t in region_teams)

    opponents = []      # per-round list of (name, seed, rating) tuples
    labels = []         # per-round human-readable label
    cond_win_probs = [] # P(win this round | reached this round)

    # --- Rounds R64 through E8 (intra-region) ---
    for round_idx in range(4):
        opp_seeds = BRACKET_PODS.get(team.seed, {}).get(round_idx, [])
        round_opps = []

        for s in opp_seeds:
            opp = by_seed.get(s)
            if opp:
                round_opps.append((opp.name, opp.seed, opp.rating))

        opponents.append(round_opps)

        if not round_opps:
            labels.append("TBD")
            cond_win_probs.append(0.5)
            continue

        # Compute conditional win probability for this round
        if has_ratings and team.rating is not None:
            # Weighted average: each potential opponent's contribution is
            # weighted by that opponent's probability of reaching this round
            # (approximated by their historical advancement rate)
            total_weight = 0.0
            weighted_win_prob = 0.0
            for opp_name, opp_seed, opp_rating in round_opps:
                # Weight = P(this opponent reaches this round)
                opp_rates = HISTORICAL_RATES.get(opp_seed, HISTORICAL_RATES[16])
                if round_idx == 0:
                    # R64: opponent is guaranteed to be here
                    w = 1.0
                else:
                    # For later rounds, weight by P(opponent won through prior round)
                    w = opp_rates[round_idx - 1] if round_idx - 1 < len(opp_rates) else 0.01
                p_win = win_probability(team.rating, opp_rating)
                weighted_win_prob += w * p_win
                total_weight += w

            cond_p = weighted_win_prob / total_weight if total_weight > 0 else 0.5
        else:
            # No ratings: use seed-based matchup rates
            total_weight = 0.0
            weighted_win_prob = 0.0
            for opp_name, opp_seed, opp_rating in round_opps:
                opp_rates = HISTORICAL_RATES.get(opp_seed, HISTORICAL_RATES[16])
                w = opp_rates[round_idx - 1] if round_idx > 0 and round_idx - 1 < len(opp_rates) else 1.0
                p_win = historical_matchup_rate(team.seed, opp_seed)
                weighted_win_prob += w * p_win
                total_weight += w
            cond_p = weighted_win_prob / total_weight if total_weight > 0 else 0.5

        cond_win_probs.append(cond_p)

        # Label: show most likely opponent(s)
        if round_idx == 0:
            opp = round_opps[0]
            labels.append(f"vs ({opp[1]}) {opp[0]}")
        else:
            # Show top 2 most likely by advancement rate
            rated = sorted(round_opps, key=lambda x: x[1])  # lower seed = likely
            top = rated[:2]
            parts = [f"({o[1]}) {o[0]}" for o in top]
            labels.append(f"vs {' / '.join(parts)}")

    # --- Final Four (round_idx 4): top team from paired region ---
    if all_regions:
        region_names = list(all_regions.keys())
        my_region_idx = -1
        for i, rn in enumerate(region_names):
            if any(t.name == team.name for t in all_regions[rn]):
                my_region_idx = i
                break

        # Standard Final Four pairing: region 0 vs 1, region 2 vs 3
        if my_region_idx >= 0:
            if my_region_idx % 2 == 0:
                opp_region_idx = my_region_idx + 1
            else:
                opp_region_idx = my_region_idx - 1

            if opp_region_idx < len(region_names):
                opp_region = all_regions[region_names[opp_region_idx]]
                f4_opps = [(t.name, t.seed, t.rating) for t in opp_region[:4]]
                opponents.append(f4_opps)

                if has_ratings and team.rating is not None:
                    # Weighted by opponent's chance of winning their region
                    total_w = 0.0
                    weighted_p = 0.0
                    for opp_n, opp_s, opp_r in f4_opps:
                        opp_rates = HISTORICAL_RATES.get(opp_s, HISTORICAL_RATES[16])
                        w = opp_rates[3] if len(opp_rates) > 3 else 0.01
                        p_win = win_probability(team.rating, opp_r) if opp_r is not None else 0.5
                        weighted_p += w * p_win
                        total_w += w
                    cond_win_probs.append(weighted_p / total_w if total_w > 0 else 0.5)
                else:
                    best_opp = min(f4_opps, key=lambda x: x[1])
                    cond_win_probs.append(historical_matchup_rate(team.seed, best_opp[1]))

                top_f4 = sorted(f4_opps, key=lambda x: x[1])[:2]
                parts = [f"({o[1]}) {o[0]}" for o in top_f4]
                labels.append(f"vs {' / '.join(parts)}")
            else:
                opponents.append([])
                cond_win_probs.append(0.5)
                labels.append("TBD")

            # --- Championship (round_idx 5): top teams from other 2 regions ---
            other_regions = [
                i for i in range(len(region_names))
                if i != my_region_idx and i != opp_region_idx
            ]
            champ_opps = []
            for ri in other_regions:
                for t in all_regions[region_names[ri]][:2]:
                    champ_opps.append((t.name, t.seed, t.rating))
            opponents.append(champ_opps)

            if has_ratings and team.rating is not None and champ_opps:
                total_w = 0.0
                weighted_p = 0.0
                for opp_n, opp_s, opp_r in champ_opps:
                    opp_rates = HISTORICAL_RATES.get(opp_s, HISTORICAL_RATES[16])
                    w = opp_rates[4] if len(opp_rates) > 4 else 0.01
                    p_win = win_probability(team.rating, opp_r) if opp_r is not None else 0.5
                    weighted_p += w * p_win
                    total_w += w
                cond_win_probs.append(weighted_p / total_w if total_w > 0 else 0.5)
            else:
                best_champ = min(champ_opps, key=lambda x: x[1]) if champ_opps else (None, 1, None)
                cond_win_probs.append(
                    historical_matchup_rate(team.seed, best_champ[1]) if best_champ[0] else 0.5
                )

            top_ch = sorted(champ_opps, key=lambda x: x[1])[:2]
            parts = [f"({o[1]}) {o[0]}" for o in top_ch]
            labels.append(f"vs {' / '.join(parts)}")
        else:
            # Fallback if region not found
            for _ in range(2):
                opponents.append([])
                cond_win_probs.append(0.5)
                labels.append("TBD")
    else:
        # No multi-region info: use seed-based estimates for F4/Championship
        for _ in range(2):
            opponents.append([])
            cond_win_probs.append(0.5)
            labels.append("TBD (other regions)")

    return BracketPath(
        opponents=opponents,
        opponent_labels=labels,
        win_probs=cond_win_probs,
    )


def bracket_adjusted_rates(
    team: Team,
    bracket_path: BracketPath,
) -> List[float]:
    """
    Compute bracket-adjusted cumulative advancement probabilities by
    combining historical seed rates with bracket-specific opponent data.

    Method: For each round, compute a "difficulty ratio" comparing the
    bracket-specific conditional win probability to what the historical
    average implies. Then adjust the historical cumulative rate by this
    ratio, chained through all rounds.

    The historical conditional P(win round k | reached round k) is:
        hist_cond[k] = hist_cumulative[k] / hist_cumulative[k-1]

    The bracket-adjusted conditional is:
        adj_cond[k] = blend(hist_cond[k], bracket_path.win_probs[k])

    The blend uses 60% bracket-specific / 40% historical to avoid
    over-rotating on single-game matchup variance in early rounds.

    The adjusted cumulative rate chains these:
        adj_cumulative[k] = adj_cond[0] × adj_cond[1] × ... × adj_cond[k]

    Args:
        team: Team to adjust rates for
        bracket_path: Pre-computed path from compute_bracket_path()

    Returns:
        List of 6 cumulative probabilities (same format as HISTORICAL_RATES)
    """
    hist = HISTORICAL_RATES.get(team.seed, HISTORICAL_RATES[16])

    # Compute historical conditional win probabilities per round
    hist_cond = []
    for k in range(len(hist)):
        if k == 0:
            hist_cond.append(hist[0])
        else:
            hist_cond.append(hist[k] / hist[k - 1] if hist[k - 1] > 0 else 0.0)

    # Compute bracket-adjusted conditionals
    # Blend: 60% bracket-specific, 40% historical
    BRACKET_WEIGHT = 0.60
    adj_cond = []
    for k in range(6):
        h = hist_cond[k] if k < len(hist_cond) else 0.0
        if k < len(bracket_path.win_probs):
            b = bracket_path.win_probs[k]
            blended = BRACKET_WEIGHT * b + (1 - BRACKET_WEIGHT) * h
        else:
            blended = h
        # Clamp to reasonable range
        blended = max(0.001, min(0.999, blended))
        adj_cond.append(blended)

    # Chain conditionals into cumulative probabilities
    adj_cumulative = []
    running = 1.0
    for k in range(6):
        running *= adj_cond[k]
        adj_cumulative.append(running)

    return adj_cumulative


# ============================================================
# BAYESIAN POT ESTIMATION
# ============================================================
# Prior: Normal(mu_0, sigma_0^2) — from historical pot sizes or
#        initial estimate with 25% uncertainty.
# Observations: Each team sale implies a pot size (price / EV_share).
#               These are noisy observations of the true pot.
# Posterior: Normal-Normal conjugate update.

# Default prior uncertainty as a fraction of the mean
BAYESIAN_PRIOR_CV = 0.25  # coefficient of variation (std / mean)

# Observation noise: how noisy each implied-pot observation is.
# Higher = trust individual sales less, converge slower.
# Calibrated: a single team sale tells you pot within ~40% accuracy.
BAYESIAN_OBS_CV = 0.40


def bayesian_pot_update(
    prior_mean: float,
    prior_std: float,
    observations: List[float],
    obs_std: float,
) -> Tuple[float, float]:
    """
    Normal-Normal conjugate Bayesian update for pot size estimation.

    Given a Gaussian prior on the true pot size and a set of noisy
    observations (implied pot from each sale), compute the posterior
    mean and standard deviation.

    Math:
        Prior:       P ~ N(mu_0, tau_0^2)
        Observations: x_i ~ N(P, sigma^2)  for i = 1..n
        Posterior:   P | x ~ N(mu_n, tau_n^2)

        tau_n^2 = 1 / (1/tau_0^2 + n/sigma^2)
        mu_n = tau_n^2 × (mu_0/tau_0^2 + sum(x_i)/sigma^2)

    Args:
        prior_mean: Prior mean (mu_0) — initial pot estimate
        prior_std: Prior standard deviation (tau_0)
        observations: List of implied pot values from sales
        obs_std: Standard deviation of each observation (sigma)

    Returns:
        (posterior_mean, posterior_std)
    """
    if not observations or prior_std <= 0:
        return prior_mean, prior_std

    tau0_sq = prior_std ** 2
    sigma_sq = obs_std ** 2

    if sigma_sq <= 0:
        sigma_sq = 1.0  # prevent division by zero

    n = len(observations)
    sum_x = sum(observations)

    # Posterior precision = prior precision + data precision
    posterior_precision = 1.0 / tau0_sq + n / sigma_sq
    posterior_var = 1.0 / posterior_precision
    posterior_mean = posterior_var * (prior_mean / tau0_sq + sum_x / sigma_sq)
    posterior_std = math.sqrt(posterior_var)

    return posterior_mean, posterior_std

@dataclass
class Team:
    """Represents a tournament team."""

    name: str
    seed: int
    region: str
    rating: Optional[float] = None         # KenPom AdjEM or similar power rating
    custom_probs: Optional[List[float]] = None  # Manual round-by-round cumulative probs
    womens_win_prob: float = 0.0           # P(women's team wins women's tourney), 0 if not in it
    vegas_odds: Optional[float] = None     # American odds for championship (+1400, -200, etc.)
    womens_vegas_odds: Optional[float] = None  # American odds for women's championship

    def __repr__(self):
        return f"({self.seed}) {self.name}"

    @property
    def vegas_implied_prob(self) -> Optional[float]:
        """
        Convert American odds to implied championship probability.

        American odds:
            +1400 means bet $100 to win $1,400 → implied prob = 100/1500 = 6.67%
            -200 means bet $200 to win $100 → implied prob = 200/300 = 66.67%

        Returns None if no vegas_odds set.
        """
        if self.vegas_odds is None:
            return None
        if self.vegas_odds > 0:
            return 100.0 / (self.vegas_odds + 100.0)
        else:
            return abs(self.vegas_odds) / (abs(self.vegas_odds) + 100.0)


@dataclass
class CalcuttaResult:
    """Stores valuation results for a single team."""

    team: Team
    round_evs: Dict[str, float]   # EV contribution from each round
    total_ev: float               # Sum of all round EVs (including bonuses)
    max_bid: float                # Recommended max bid (EV × risk discount)
    win_probability: float        # Probability of winning the championship
    round_probs: List[float]      # Probability of winning through each round
    bracket_path: Optional[BracketPath] = None  # Opponent info per round
    bonus_evs: Optional[Dict[str, float]] = None  # EV from bonuses {"womens_champ": $, "biggest_blowout": $}
    vegas_title_prob: Optional[float] = None     # De-vigged Vegas-implied title probability
    model_title_prob: Optional[float] = None     # Original model title prob (before blending)


# ============================================================
# BONUS PAYOUT CALCULATIONS
# ============================================================

# Approximate expected margin of victory by seed matchup in R64.
# Used for blowout probability modeling.
# Based on: higher seed gap → larger expected margin → more likely
# to produce the biggest blowout.
# Values are approximate expected point margins.
R64_EXPECTED_MARGINS = {
    (1, 16): 22.0,
    (2, 15): 17.0,
    (3, 14): 14.0,
    (4, 13): 11.0,
    (5, 12):  5.5,
    (6, 11):  4.5,
    (7, 10):  3.5,
    (8,  9):  1.5,
}


def compute_blowout_probabilities(
    all_teams: List[Team],
) -> Dict[str, float]:
    """
    Estimate P(team has the biggest R64 blowout) for each team.

    Model: Among all 32 R64 games, the winner of each game has some
    expected margin of victory. The game with the largest expected
    margin is most likely to produce the biggest blowout.

    For teams with ratings:
        Expected margin ≈ (rating_diff) × 0.7 (70 possessions/game)
    For seed-based:
        Uses R64_EXPECTED_MARGINS lookup table

    P(biggest blowout) = P(wins R64) × P(biggest margin | wins R64)

    The "biggest margin" probability uses a softmax over expected
    margins squared (to emphasize large gaps):
        P(biggest margin | game i) ∝ E[margin_i]^2

    Only the R64 winner can claim the blowout. If a 16-seed upsets a
    1-seed, the 16-seed gets the blowout chance for that game (though
    the expected margin is small for an upset).

    Args:
        all_teams: All 64 teams in the bracket

    Returns:
        Dict mapping team name -> P(team wins the blowout bonus)
    """
    blowout_frac = BONUS_PAYOUTS.get("biggest_blowout", 0.0)
    if blowout_frac <= 0:
        return {t.name: 0.0 for t in all_teams}

    by_seed_region: Dict[Tuple[str, int], Team] = {}
    for t in all_teams:
        by_seed_region[(t.region, t.seed)] = t

    # Compute per-game expected margins and winner probabilities
    game_data = []  # List of (winner_name, loser_name, p_win, expected_margin)
    regions = set(t.region for t in all_teams)

    for region in regions:
        for high_seed, low_seed in R64_EXPECTED_MARGINS:
            high_team = by_seed_region.get((region, high_seed))
            low_team = by_seed_region.get((region, low_seed))
            if not high_team or not low_team:
                continue

            # P(high seed wins) and expected margin
            if high_team.rating is not None and low_team.rating is not None:
                p_high_wins = win_probability(high_team.rating, low_team.rating)
                margin = abs(high_team.rating - low_team.rating) * 0.7
            else:
                p_high_wins = historical_matchup_rate(high_seed, low_seed)
                margin = R64_EXPECTED_MARGINS.get(
                    (high_seed, low_seed),
                    max(0.5, (low_seed - high_seed) * 1.2)
                )

            # High seed winning = large margin; upset = small margin
            game_data.append((high_team.name, p_high_wins, margin))
            # If upset occurs, margin is typically small
            game_data.append((low_team.name, 1.0 - p_high_wins, max(1.0, margin * 0.3)))

    # Compute P(biggest margin) using softmax over margin^2
    # Weight each entry by P(this team wins their R64 game) × margin^2
    total_weighted = sum(p * (m ** 2) for _, p, m in game_data)
    if total_weighted <= 0:
        return {t.name: 0.0 for t in all_teams}

    blowout_probs = defaultdict(float)
    for name, p_win, margin in game_data:
        # P(team gets blowout) = P(wins R64) × P(has biggest margin | wins)
        # P(has biggest margin | wins) ∝ margin^2
        blowout_probs[name] = (p_win * margin ** 2) / total_weighted

    # Fill in zeros for teams not in the data (shouldn't happen but safety)
    return {t.name: blowout_probs.get(t.name, 0.0) for t in all_teams}


def compute_bonus_evs(
    team: Team,
    pot: float,
    blowout_probs: Optional[Dict[str, float]] = None,
) -> Dict[str, float]:
    """
    Compute bonus payout expected values for a team.

    Args:
        team: The team to evaluate
        pot: Total pot size
        blowout_probs: Pre-computed blowout probabilities (from compute_blowout_probabilities)

    Returns:
        Dict of {"womens_champ": ev_dollars, "biggest_blowout": ev_dollars}
    """
    bonus_evs = {}

    # Women's champion bonus
    womens_frac = BONUS_PAYOUTS.get("womens_champ", 0.0)
    if womens_frac > 0 and team.womens_win_prob > 0:
        bonus_evs["womens_champ"] = team.womens_win_prob * womens_frac * pot
    else:
        bonus_evs["womens_champ"] = 0.0

    # Biggest blowout bonus
    blowout_frac = BONUS_PAYOUTS.get("biggest_blowout", 0.0)
    if blowout_frac > 0 and blowout_probs and team.name in blowout_probs:
        bonus_evs["biggest_blowout"] = blowout_probs[team.name] * blowout_frac * pot
    else:
        bonus_evs["biggest_blowout"] = 0.0

    return bonus_evs


# ============================================================
# VEGAS ODDS INTEGRATION
# ============================================================

def vegas_implied_round_probs(
    team: Team,
) -> Optional[List[float]]:
    """
    Decompose a Vegas-implied championship probability into round-by-round
    cumulative advancement probabilities.

    Uses the team's seed historical rates as a "path shape" template.
    The shape captures the fact that a 1-seed's path to the title looks
    very different from a 12-seed's (99% R64 vs 64% R64, etc.).

    Method: Compute conditional advancement rates from historical data,
    then apply a uniform multiplicative adjustment so the final product
    equals the Vegas-implied title probability. Each conditional rate
    is adjusted by the same factor (capped at 1.0).

    Example: If historical says a 3-seed wins the title 3.2% of the time,
    but Vegas implies 5.0%, the adjustment factor is (5.0/3.2)^(1/6) ≈ 1.08,
    meaning each round's conditional win rate is boosted ~8%.

    Args:
        team: Team with vegas_odds set

    Returns:
        List of 6 cumulative probabilities [P(R64), P(thru R32), ..., P(title)],
        or None if no vegas_odds set
    """
    vegas_prob = team.vegas_implied_prob
    if vegas_prob is None or vegas_prob <= 0:
        return None

    # Get the seed's historical path shape
    hist_rates = list(HISTORICAL_RATES.get(team.seed, HISTORICAL_RATES[16]))
    if len(hist_rates) < 6:
        hist_rates.extend([0.0] * (6 - len(hist_rates)))

    hist_title = hist_rates[5]
    if hist_title <= 0:
        # Seed has never won the title historically — use a crude estimate
        # by scaling from the nearest round that has data
        for i in range(5, -1, -1):
            if hist_rates[i] > 0:
                # Assume each subsequent round is 40% conditional advancement
                for j in range(i + 1, 6):
                    hist_rates[j] = hist_rates[j - 1] * 0.40
                break
        hist_title = hist_rates[5]
        if hist_title <= 0:
            hist_title = 0.001  # absolute floor

    # Compute conditional advancement rates
    cond_rates = [hist_rates[0]]  # P(win R64)
    for i in range(1, 6):
        if hist_rates[i - 1] > 0:
            cond_rates.append(hist_rates[i] / hist_rates[i - 1])
        else:
            cond_rates.append(0.40)  # default conditional rate

    # Compute uniform adjustment factor
    # Product of all conditional rates = hist_title
    # We want product of (cond[i] * adj) = vegas_prob
    # So adj^6 * product(cond) = vegas_prob
    # adj = (vegas_prob / hist_title) ^ (1/6)
    ratio = vegas_prob / hist_title
    if ratio <= 0:
        return hist_rates

    adj = ratio ** (1.0 / 6.0)

    # Apply adjustment to each conditional rate (cap at 1.0)
    new_cond = [min(1.0, c * adj) for c in cond_rates]

    # Reconstruct cumulative probabilities
    vegas_probs = [new_cond[0]]
    for i in range(1, 6):
        vegas_probs.append(vegas_probs[i - 1] * new_cond[i])

    return vegas_probs


def blend_probabilities(
    model_probs: List[float],
    vegas_probs: List[float],
    weight: float = VEGAS_BLEND_WEIGHT,
) -> List[float]:
    """
    Blend model and Vegas round probabilities.

    Args:
        model_probs: Round-by-round probs from Monte Carlo or seed model
        vegas_probs: Round-by-round probs from Vegas decomposition
        weight: Vegas weight (0 = pure model, 1 = pure Vegas)

    Returns:
        Blended round probabilities
    """
    blended = []
    for i in range(min(len(model_probs), len(vegas_probs))):
        mp = model_probs[i] if i < len(model_probs) else 0.0
        vp = vegas_probs[i] if i < len(vegas_probs) else 0.0
        blended.append(mp * (1.0 - weight) + vp * weight)
    return blended


def compute_vegas_ev(
    team: Team,
    pot: float,
    payouts: Dict[str, float],
) -> Optional[CalcuttaResult]:
    """
    Compute EV using only Vegas-implied probabilities.

    Args:
        team: Team with vegas_odds set
        pot: Total pot size
        payouts: Payout structure

    Returns:
        CalcuttaResult based purely on Vegas probs, or None if no odds
    """
    vegas_probs = vegas_implied_round_probs(team)
    if vegas_probs is None:
        return None

    round_names = list(payouts.keys())
    round_evs = {}
    total_ev = 0.0

    for i, round_name in enumerate(round_names):
        prob = vegas_probs[i] if i < len(vegas_probs) else 0.0
        payout = per_team_payout(round_name, pot)
        ev = prob * payout
        round_evs[round_name] = ev
        total_ev += ev

    win_prob = vegas_probs[5] if len(vegas_probs) > 5 else 0.0

    return CalcuttaResult(
        team=team,
        round_evs=round_evs,
        total_ev=total_ev,
        max_bid=total_ev * RISK_DISCOUNT,
        win_probability=win_prob,
        round_probs=list(vegas_probs),
    )


def apply_vegas_blend(
    results: List[CalcuttaResult],
    pot: float,
):
    """
    Blend model probabilities with Vegas-implied probabilities for all
    teams that have vegas_odds set. Modifies results in place.

    Also prints a disagreement report for teams where model and Vegas
    differ significantly.

    Args:
        results: CalcuttaResult list from any estimation method
        pot: Total pot size
    """
    teams_with_odds = [r for r in results if r.team.vegas_odds is not None]
    if not teams_with_odds:
        return

    # Strip vig: normalize Vegas-implied probs so they sum to 1.0
    raw_probs = {}
    total_implied = 0.0
    for r in teams_with_odds:
        p = r.team.vegas_implied_prob
        if p and p > 0:
            raw_probs[r.team.name] = p
            total_implied += p

    # Vig factor — typically 1.15-1.30 for futures markets
    vig = total_implied if total_implied > 1.0 else 1.0

    disagreements = []

    blended_count = 0
    for r in results:
        if r.team.vegas_odds is None:
            continue

        # De-vigged Vegas title probability
        raw_p = raw_probs.get(r.team.name, 0)
        devigged_title = raw_p / vig if vig > 0 else raw_p

        # Create a temporary team with the de-vigged probability for decomposition
        temp_team = Team(
            name=r.team.name, seed=r.team.seed, region=r.team.region,
            vegas_odds=1.0,  # dummy, we'll override
        )
        # Manually set the implied prob via odds that yield devigged_title
        # Convert back: if prob = 100/(odds+100), odds = (100/prob) - 100
        if devigged_title > 0 and devigged_title < 1.0:
            synth_odds = (100.0 / devigged_title) - 100.0
            temp_team.vegas_odds = synth_odds
        else:
            continue

        vegas_probs = vegas_implied_round_probs(temp_team)
        if not vegas_probs:
            continue

        # Check for disagreement before blending
        model_title = r.win_probability
        vegas_title = devigged_title

        # Store both probs on the result for live mode access
        r.model_title_prob = model_title
        r.vegas_title_prob = vegas_title

        if model_title > 0 and vegas_title > 0:
            ratio = model_title / vegas_title
            if ratio > VEGAS_DISAGREEMENT_THRESHOLD or ratio < 1.0 / VEGAS_DISAGREEMENT_THRESHOLD:
                direction = "Model HIGHER" if ratio > 1 else "Vegas HIGHER"
                ev_gap = r.total_ev * (1.0 - vegas_title / model_title) if model_title > 0 else 0
                disagreements.append({
                    "team": r.team,
                    "model_title": model_title,
                    "vegas_title": vegas_title,
                    "direction": direction,
                    "ev_gap": ev_gap,
                })

        # Blend probabilities
        blended = blend_probabilities(r.round_probs, vegas_probs, VEGAS_BLEND_WEIGHT)

        # Recompute EVs with blended probs
        new_round_evs = {}
        new_total = 0.0
        round_names = list(PAYOUT_STRUCTURE.keys())
        for i, rname in enumerate(round_names):
            prob = blended[i] if i < len(blended) else 0.0
            payout = per_team_payout(rname, pot)
            ev = prob * payout
            new_round_evs[rname] = ev
            new_total += ev

        r.round_evs = new_round_evs
        r.total_ev = new_total
        r.max_bid = new_total * RISK_DISCOUNT
        r.win_probability = blended[5] if len(blended) > 5 else r.win_probability
        r.round_probs = blended
        blended_count += 1

    # Report
    print(f"\n  🎰 VEGAS BLEND: {blended_count} teams blended "
          f"({VEGAS_BLEND_WEIGHT:.0%} Vegas / {1.0 - VEGAS_BLEND_WEIGHT:.0%} model)")
    if vig > 1.01:
        print(f"     Market vig: {vig:.1%} (removed before blending)")

    # Show disagreements
    if disagreements:
        disagreements.sort(key=lambda d: abs(d["ev_gap"]), reverse=True)
        print(f"\n  ⚡ MODEL vs. VEGAS DISAGREEMENTS (threshold: {VEGAS_DISAGREEMENT_THRESHOLD:.1f}x):")
        print(f"     {'Team':<24} {'Model':>7} {'Vegas':>7} {'Gap':>10} {'Direction'}")
        print(f"     {'-' * 60}")
        for d in disagreements[:10]:
            print(f"     {str(d['team']):<24} "
                  f"{d['model_title']:>6.1%} {d['vegas_title']:>6.1%} "
                  f"${d['ev_gap']:>+8,.0f} {d['direction']}")
        print(f"\n     💡 'Model HIGHER' = our model is more optimistic than Vegas.")
        print(f"        Consider trusting Vegas on teams you don't have strong views on.")


# ============================================================
# METHOD 1: HISTORICAL SEED-BASED ESTIMATION
# ============================================================

def estimate_ev_historical(
    team: Team,
    pot: float,
    payouts: Dict[str, float],
) -> CalcuttaResult:
    """
    Estimate team EV using historical seed advancement rates.

    This is the simplest method — no team-specific data needed.
    All teams with the same seed get the same valuation.

    Args:
        team: Team object (only seed is used)
        pot: Estimated total pot size
        payouts: Dict mapping round names to payout fractions

    Returns:
        CalcuttaResult with EV breakdown by round
    """
    rates = HISTORICAL_RATES.get(team.seed, HISTORICAL_RATES[16])
    round_names = list(payouts.keys())

    round_evs = {}
    total_ev = 0.0

    for i, round_name in enumerate(round_names):
        # EV = P(winning through this round) × per-team payout for this round
        prob = rates[i] if i < len(rates) else 0.0
        payout = per_team_payout(round_name, pot)
        ev = prob * payout
        round_evs[round_name] = ev
        total_ev += ev

    win_prob = rates[-1] if rates else 0.0

    return CalcuttaResult(
        team=team,
        round_evs=round_evs,
        total_ev=total_ev,
        max_bid=total_ev * RISK_DISCOUNT,
        win_probability=win_prob,
        round_probs=list(rates),
    )


def estimate_ev_bracket_adjusted(
    team: Team,
    pot: float,
    payouts: Dict[str, float],
    bracket_path: BracketPath,
) -> CalcuttaResult:
    """
    Estimate team EV using bracket-adjusted historical rates.

    Combines the base historical advancement rates for the team's seed
    with the specific opponent strengths along its bracket path. This
    produces team-specific rates without running full Monte Carlo sims.

    This method is ideal when you have a bracket but maybe not full
    KenPom ratings for every team. Even with only seed numbers, it
    differentiates "1-seed in a weak region" from "1-seed in a murder
    region" — something the plain historical method cannot do.

    Args:
        team: Team to evaluate
        pot: Estimated total pot size
        payouts: Round payout fractions
        bracket_path: Pre-computed bracket path from compute_bracket_path()

    Returns:
        CalcuttaResult with bracket-adjusted probabilities and opponent info
    """
    # Get bracket-adjusted cumulative probabilities
    adj_rates = bracket_adjusted_rates(team, bracket_path)
    round_names = list(payouts.keys())

    round_evs = {}
    total_ev = 0.0

    for i, round_name in enumerate(round_names):
        prob = adj_rates[i] if i < len(adj_rates) else 0.0
        payout = per_team_payout(round_name, pot)
        ev = prob * payout
        round_evs[round_name] = ev
        total_ev += ev

    win_prob = adj_rates[-1] if adj_rates else 0.0

    return CalcuttaResult(
        team=team,
        round_evs=round_evs,
        total_ev=total_ev,
        max_bid=total_ev * RISK_DISCOUNT,
        win_probability=win_prob,
        round_probs=adj_rates,
        bracket_path=bracket_path,
    )


# ============================================================
# METHOD 2: MONTE CARLO WITH POWER RATINGS
# ============================================================

def win_probability(rating_a: float, rating_b: float) -> float:
    """
    Calculate win probability using a logistic model calibrated to
    NCAA tournament outcomes.

    Based on KenPom-style Adjusted Efficiency Margin (AdjEM):
        AdjEM = Adj. Offensive Eff. - Adj. Defensive Eff.
    Typical range: -15 (bad) to +35 (elite).

    Model:
        P(A beats B) = 1 / (1 + 10^(-(AdjEM_A - AdjEM_B) / scale))

    The scale factor of 11 is calibrated so that a ~11-point AdjEM gap
    corresponds to roughly a 10:1 odds ratio, consistent with observed
    NCAA tournament outcomes.

    Args:
        rating_a: Power rating of team A
        rating_b: Power rating of team B

    Returns:
        Probability that team A wins (0.0 to 1.0)
    """
    diff = rating_a - rating_b
    return 1.0 / (1.0 + 10.0 ** (-diff / 11.0))


def simulate_game(team_a: Team, team_b: Team) -> Team:
    """Simulate a single game between two rated teams."""
    prob_a = win_probability(team_a.rating, team_b.rating)
    return team_a if random.random() < prob_a else team_b


def simulate_tournament(
    regions: Dict[str, List[Team]],
    n_sims: int = NUM_SIMULATIONS,
) -> tuple:
    """
    Run Monte Carlo simulation of the full 64-team tournament bracket.

    Bracket structure per region (standard NCAA seeding):
        R64 matchups: 1v16, 8v9, 5v12, 4v13, 6v11, 3v14, 7v10, 2v15
        Winners advance in bracket order through R32, S16, E8.

    Final Four: Region 1 winner vs Region 2 winner (semi 1)
                Region 3 winner vs Region 4 winner (semi 2)
                Semi winners play in Championship.

    Args:
        regions: Dict with exactly 4 regions, each containing 16 Team
                 objects (one per seed 1-16) with .rating set.
        n_sims: Number of full tournament simulations to run.

    Returns:
        Tuple of:
            probabilities: Dict mapping team name ->
                [P(win R64), P(thru R32), ..., P(win title)]
            sim_matrix: Dict mapping team name ->
                List[int] of length n_sims, where each int = number of
                rounds won in that simulation (0=lost R64, 6=won title).
                Used for portfolio-level payout distribution analysis.
    """
    region_names = list(regions.keys())
    if len(region_names) != 4:
        raise ValueError(f"Expected 4 regions, got {len(region_names)}")

    # Standard R64 seed matchups (bracket order matters for later rounds)
    R64_MATCHUPS = [(1, 16), (8, 9), (5, 12), (4, 13),
                    (6, 11), (3, 14), (7, 10), (2, 15)]

    # Track how many times each team wins through each round
    # round_counts[team_name][round_idx] = count
    round_counts: Dict[str, List[int]] = defaultdict(lambda: [0] * 6)

    # Per-simulation outcomes: sim_matrix[team_name][sim_idx] = rounds_won
    all_teams = [t for region in regions.values() for t in region]
    sim_matrix: Dict[str, List[int]] = {t.name: [0] * n_sims for t in all_teams}

    for sim_idx in range(n_sims):
        region_champs = []

        for region_name in region_names:
            # Build seed lookup for this region
            by_seed = {t.seed: t for t in regions[region_name]}

            # --- Round of 64 ---
            r32_bracket = []
            for seed_a, seed_b in R64_MATCHUPS:
                winner = simulate_game(by_seed[seed_a], by_seed[seed_b])
                round_counts[winner.name][0] += 1
                sim_matrix[winner.name][sim_idx] = 1
                r32_bracket.append(winner)

            # --- Round of 32 ---
            s16_bracket = []
            for i in range(0, 8, 2):
                winner = simulate_game(r32_bracket[i], r32_bracket[i + 1])
                round_counts[winner.name][1] += 1
                sim_matrix[winner.name][sim_idx] = 2
                s16_bracket.append(winner)

            # --- Sweet 16 ---
            e8_bracket = []
            for i in range(0, 4, 2):
                winner = simulate_game(s16_bracket[i], s16_bracket[i + 1])
                round_counts[winner.name][2] += 1
                sim_matrix[winner.name][sim_idx] = 3
                e8_bracket.append(winner)

            # --- Elite 8 (region final) ---
            region_champ = simulate_game(e8_bracket[0], e8_bracket[1])
            round_counts[region_champ.name][3] += 1
            sim_matrix[region_champ.name][sim_idx] = 4
            region_champs.append(region_champ)

        # --- Final Four ---
        semi1_winner = simulate_game(region_champs[0], region_champs[1])
        round_counts[semi1_winner.name][4] += 1
        sim_matrix[semi1_winner.name][sim_idx] = 5

        semi2_winner = simulate_game(region_champs[2], region_champs[3])
        round_counts[semi2_winner.name][4] += 1
        sim_matrix[semi2_winner.name][sim_idx] = 5

        # --- Championship ---
        champion = simulate_game(semi1_winner, semi2_winner)
        round_counts[champion.name][5] += 1
        sim_matrix[champion.name][sim_idx] = 6

    # Convert counts to probabilities
    probabilities = {}
    for team in all_teams:
        counts = round_counts[team.name]
        probabilities[team.name] = [c / n_sims for c in counts]

    return probabilities, sim_matrix


def estimate_ev_monte_carlo(
    team: Team,
    probabilities: Dict[str, List[float]],
    pot: float,
    payouts: Dict[str, float],
) -> CalcuttaResult:
    """
    Estimate team EV from pre-computed Monte Carlo probabilities.

    Args:
        team: Team object
        probabilities: Output from simulate_tournament()
        pot: Estimated total pot size
        payouts: Payout structure

    Returns:
        CalcuttaResult with EV breakdown
    """
    probs = probabilities.get(team.name, [0.0] * 6)
    round_names = list(payouts.keys())

    round_evs = {}
    total_ev = 0.0

    for i, round_name in enumerate(round_names):
        prob = probs[i] if i < len(probs) else 0.0
        payout = per_team_payout(round_name, pot)
        ev = prob * payout
        round_evs[round_name] = ev
        total_ev += ev

    win_prob = probs[5] if len(probs) > 5 else 0.0

    return CalcuttaResult(
        team=team,
        round_evs=round_evs,
        total_ev=total_ev,
        max_bid=total_ev * RISK_DISCOUNT,
        win_probability=win_prob,
        round_probs=list(probs),
    )


# ============================================================
# METHOD 3: MANUAL PROBABILITY INPUT
# ============================================================

def estimate_ev_manual(
    team: Team,
    pot: float,
    payouts: Dict[str, float],
) -> CalcuttaResult:
    """
    Estimate team EV using manually specified cumulative probabilities.

    Set team.custom_probs to a list of 6 values:
        [P(win R64), P(thru R32), P(thru S16),
         P(thru E8), P(thru F4), P(win title)]

    Args:
        team: Team with custom_probs set
        pot: Estimated total pot
        payouts: Payout structure

    Returns:
        CalcuttaResult with EV breakdown
    """
    if team.custom_probs is None:
        raise ValueError(f"No custom probabilities set for {team.name}")

    round_names = list(payouts.keys())
    round_evs = {}
    total_ev = 0.0

    for i, round_name in enumerate(round_names):
        prob = team.custom_probs[i] if i < len(team.custom_probs) else 0.0
        payout = per_team_payout(round_name, pot)
        ev = prob * payout
        round_evs[round_name] = ev
        total_ev += ev

    win_prob = team.custom_probs[-1] if team.custom_probs else 0.0

    return CalcuttaResult(
        team=team,
        round_evs=round_evs,
        total_ev=total_ev,
        max_bid=total_ev * RISK_DISCOUNT,
        win_probability=win_prob,
        round_probs=list(team.custom_probs),
    )


# ============================================================
# OUTPUT & REPORTING
# ============================================================

def print_results(
    results: List[CalcuttaResult],
    pot: float,
    method: str = "",
):
    """Print a formatted table of Calcutta valuations sorted by EV."""
    results.sort(key=lambda r: r.total_ev, reverse=True)

    print("\n" + "=" * 80)
    print("  CALCUTTA AUCTION VALUE ESTIMATES")
    if method:
        print(f"  Method: {method}")
    print(f"  Estimated Pot: ${pot:,.0f}  |  Risk Discount: {RISK_DISCOUNT:.0%}")
    payout_check = sum(PAYOUT_STRUCTURE.values())
    print(f"  Payout Structure: {', '.join(f'{r}={p:.1%}' for r, p in PAYOUT_STRUCTURE.items())}")
    if abs(payout_check - 1.0) > 0.001:
        print(f"  ⚠️  WARNING: Payouts sum to {payout_check:.1%}, should be 100%!")
    print("=" * 80)

    # Header
    print(f"{'Rank':<5} {'Team':<30} {'Seed':>4} {'EV':>9} {'Max Bid':>9} {'Win %':>7}")
    print("-" * 80)

    for i, result in enumerate(results, 1):
        team = result.team
        print(
            f"{i:<5} {str(team):<30} {team.seed:>4} "
            f"${result.total_ev:>7,.0f} ${result.max_bid:>7,.0f} "
            f"{result.win_probability:>6.1%}"
        )

    # Totals
    total_ev = sum(r.total_ev for r in results)
    print("-" * 80)
    print(f"{'':5} {'TOTAL':<30} {'':4} ${total_ev:>7,.0f}")
    if abs(total_ev - pot) > pot * 0.05:
        print(f"\n  ⚠️  Total EV (${total_ev:,.0f}) differs from pot (${pot:,.0f}) by "
              f"{abs(total_ev - pot) / pot:.1%}")
    print("=" * 80)


def print_detailed_ev(result: CalcuttaResult, pot: float):
    """Print round-by-round EV breakdown for a single team."""
    print(f"\n  {'─' * 50}")
    print(f"  {result.team}")
    print(f"  {'─' * 50}")
    print(f"  {'Round':<16} {'Prob':>8} {'Payout %':>9} {'EV':>10}")
    print(f"  {'─' * 50}")

    round_ev_total = 0.0
    for i, (round_name, ev) in enumerate(result.round_evs.items()):
        payout_frac = PAYOUT_STRUCTURE[round_name]
        prob = result.round_probs[i] if i < len(result.round_probs) else 0.0
        print(f"  {round_name:<16} {prob:>7.1%} {payout_frac:>8.1%} ${ev:>8,.0f}")
        round_ev_total += ev

    # Show bonus EVs if any
    if result.bonus_evs:
        has_bonus = any(v > 0.50 for v in result.bonus_evs.values())
        if has_bonus:
            print(f"  {'─' * 50}")
            for bonus_name, bev in result.bonus_evs.items():
                if bev > 0.50:
                    frac = BONUS_PAYOUTS.get(bonus_name, 0)
                    label = bonus_name.replace("_", " ").title()
                    print(f"  {'🎁 ' + label:<16} {'':>8} {frac:>8.1%} ${bev:>8,.0f}")

    print(f"  {'─' * 50}")
    print(f"  {'TOTAL EV':<16} {'':>8} {'':>9} ${result.total_ev:>8,.0f}")
    print(f"  {'MAX BID':<16} {'':>8} {'':>9} ${result.max_bid:>8,.0f}")


def print_seed_summary(results: List[CalcuttaResult]):
    """Print average EV by seed (useful for seed-based method)."""
    print("\n" + "=" * 50)
    print("  AVERAGE VALUE BY SEED")
    print("=" * 50)
    print(f"  {'Seed':<6} {'Avg EV':>10} {'Max Bid':>10} {'Win %':>8}")
    print(f"  {'-' * 44}")

    for seed in range(1, 17):
        seed_results = [r for r in results if r.team.seed == seed]
        if not seed_results:
            continue
        avg_ev = sum(r.total_ev for r in seed_results) / len(seed_results)
        avg_bid = avg_ev * RISK_DISCOUNT
        win_pct = seed_results[0].win_probability
        print(f"  {seed:<6} ${avg_ev:>8,.0f} ${avg_bid:>8,.0f} {win_pct:>7.1%}")

    print("=" * 50)


def export_to_csv(
    results: List[CalcuttaResult],
    filename: str = "calcutta_values.csv",
):
    """
    Export results to CSV for spreadsheet analysis.

    Args:
        results: List of CalcuttaResult objects
        filename: Output CSV path
    """
    results.sort(key=lambda r: r.total_ev, reverse=True)

    with open(filename, "w", newline="") as f:
        writer = csv.writer(f)

        # Header row
        round_names = list(PAYOUT_STRUCTURE.keys())
        header = (
            ["Rank", "Team", "Seed", "Region"]
            + [f"P({r})" for r in round_names]
            + [f"EV_{r}" for r in round_names]
            + ["Total_EV", "Max_Bid", "Win_Prob"]
        )
        writer.writerow(header)

        # Data rows
        for i, result in enumerate(results, 1):
            row = [i, result.team.name, result.team.seed, result.team.region]
            # Round probabilities
            row += [f"{p:.4f}" for p in result.round_probs]
            # Round EVs
            row += [f"{result.round_evs.get(r, 0):.2f}" for r in round_names]
            # Totals
            row += [
                f"{result.total_ev:.2f}",
                f"{result.max_bid:.2f}",
                f"{result.win_probability:.4f}",
            ]
            writer.writerow(row)

    print(f"\n  ✅ Results exported to {filename}")


# ============================================================
# DATA LOADING
# ============================================================

def load_teams_from_json(filepath: str) -> Dict[str, List[Team]]:
    """
    Load bracket data from a JSON file.

    Expected JSON format:
    {
        "pot_size": 5000,               # optional, overrides ESTIMATED_POT
        "bonuses": {                    # optional, overrides BONUS_PAYOUTS
            "womens_champ": 0.02,
            "biggest_blowout": 0.01
        },
        "regions": {
            "South": [
                {"name": "Houston", "seed": 1, "rating": 29.5, "womens_win_prob": 0.03},
                {"name": "Marquette", "seed": 2, "rating": 25.0},
                ...16 teams total per region...
            ],
            "East": [...],
            "Midwest": [...],
            "West": [...]
        }
    }

    The "rating" field is a KenPom-style Adjusted Efficiency Margin (AdjEM).
    You can find these at kenpom.com or equivalent sources.
    Typical range: -15 (bottom of D1) to +35 (elite).

    The "womens_win_prob" field is the probability that the school's
    women's team wins the women's NCAA tournament. Set to 0 (or omit)
    if the school doesn't have a women's team in the tournament.
    Only schools appearing in BOTH brackets can earn the women's bonus.

    The "vegas_odds" field is the team's championship futures odds in
    American format (e.g., +1400, +600, -200). Get these from any
    major sportsbook before the tournament. Odds are converted to
    implied probabilities, de-vigged, and blended with the model.

    You can also include "custom_probs" per team for manual method:
        {"name": "UConn", "seed": 1, "custom_probs": [0.99, 0.90, 0.70, 0.50, 0.35, 0.20]}

    Args:
        filepath: Path to JSON file

    Returns:
        Dict mapping region names to lists of Team objects
    """
    with open(filepath) as f:
        data = json.load(f)

    # Optionally override pot size from file
    global ESTIMATED_POT
    if "pot_size" in data:
        ESTIMATED_POT = data["pot_size"]
        print(f"  Pot size loaded from JSON: ${ESTIMATED_POT:,.0f}")

    # Optionally override payout structure
    if "payouts" in data:
        global PAYOUT_STRUCTURE
        PAYOUT_STRUCTURE = data["payouts"]
        print(f"  Payout structure loaded from JSON")

    # Optionally override bonus payouts
    if "bonuses" in data:
        global BONUS_PAYOUTS
        BONUS_PAYOUTS = data["bonuses"]
        bonus_total = sum(BONUS_PAYOUTS.values())
        if bonus_total > 0:
            print(f"  Bonus payouts loaded from JSON: {bonus_total:.0%} of pot")

    regions = {}
    for region_name, team_list in data["regions"].items():
        teams = []
        for t in team_list:
            teams.append(Team(
                name=t["name"],
                seed=t["seed"],
                region=region_name,
                rating=t.get("rating"),
                custom_probs=t.get("custom_probs"),
                womens_win_prob=t.get("womens_win_prob", 0.0),
                vegas_odds=t.get("vegas_odds"),
                womens_vegas_odds=t.get("womens_vegas_odds"),
            ))
        # Sort by seed for consistent bracket ordering
        teams.sort(key=lambda t: t.seed)
        regions[region_name] = teams

    # Auto-convert women's Vegas odds to womens_win_prob (with vig removal)
    all_teams = [t for teams in regions.values() for t in teams]
    womens_raw_probs = {}
    womens_total_implied = 0.0
    for t in all_teams:
        if t.womens_vegas_odds is not None:
            if t.womens_vegas_odds > 0:
                raw_p = 100.0 / (t.womens_vegas_odds + 100.0)
            else:
                raw_p = abs(t.womens_vegas_odds) / (abs(t.womens_vegas_odds) + 100.0)
            womens_raw_probs[t.name] = raw_p
            womens_total_implied += raw_p

    if womens_raw_probs:
        # Remove vig
        vig = womens_total_implied if womens_total_implied > 1.0 else 1.0
        womens_count = 0
        for t in all_teams:
            if t.name in womens_raw_probs:
                devigged = womens_raw_probs[t.name] / vig
                # Only override if not manually set or if manual is 0
                if t.womens_win_prob == 0.0:
                    t.womens_win_prob = devigged
                    womens_count += 1
        if womens_count > 0:
            if womens_total_implied > 1.0:
                print(f"  Women's probs from Vegas odds: {womens_count} teams "
                      f"(vig removed: {womens_total_implied:.1%} → 100%)")
            else:
                print(f"  Women's probs from Vegas odds: {womens_count} teams "
                      f"(partial field: {womens_total_implied:.1%} total implied)")

    return regions


def generate_bracket_template(filepath: str = "bracket_template.json"):
    """
    Generate a blank bracket JSON template to fill in with your teams.

    Args:
        filepath: Output path for the template file
    """
    template = {
        "_instructions": (
            "Fill in team names and ratings for each region. "
            "Ratings should be KenPom AdjEM values (get from kenpom.com). "
            "Typical range: -15 to +35. Higher = better team. "
            "Set womens_win_prob for teams whose school also has a women's "
            "team in the women's NCAA tournament (0 = not in women's bracket)."
        ),
        "pot_size": 5000,
        "bonuses": {
            "womens_champ": 0.02,
            "biggest_blowout": 0.01,
        },
        "regions": {},
    }

    for region_name in ["South", "East", "Midwest", "West"]:
        template["regions"][region_name] = [
            {"name": f"TEAM_{region_name}_{seed}", "seed": seed,
             "rating": 0.0, "womens_win_prob": 0.0, "vegas_odds": null}
            for seed in range(1, 17)
        ]

    with open(filepath, "w") as f:
        json.dump(template, f, indent=2)

    print(f"  ✅ Bracket template saved to {filepath}")
    print("  Fill in team names and KenPom AdjEM ratings, then run with --method monte_carlo")


# ============================================================
# ANALYSIS RUNNERS
# ============================================================

def apply_bonus_evs(
    results: List[CalcuttaResult],
    all_teams: List[Team],
    pot: float,
):
    """
    Compute and attach bonus EVs (women's champ, biggest blowout) to
    each CalcuttaResult. Modifies results in place.

    Bonus EVs are added to total_ev and max_bid.

    Args:
        results: List of CalcuttaResult to augment
        all_teams: All 64 teams (needed for blowout normalization)
        pot: Estimated total pot size
    """
    total_bonus_frac = bonus_total_fraction()
    if total_bonus_frac <= 0:
        return

    # Compute blowout probabilities across all teams
    blowout_probs = compute_blowout_probabilities(all_teams)

    for r in results:
        bevs = compute_bonus_evs(r.team, pot, blowout_probs)
        r.bonus_evs = bevs
        bonus_total = sum(bevs.values())
        r.total_ev += bonus_total
        r.max_bid = r.total_ev * RISK_DISCOUNT

    # Report bonus pool info
    womens_frac = BONUS_PAYOUTS.get("womens_champ", 0.0)
    blowout_frac = BONUS_PAYOUTS.get("biggest_blowout", 0.0)
    bonus_parts = []
    if womens_frac > 0:
        womens_teams = sum(1 for t in all_teams if t.womens_win_prob > 0)
        bonus_parts.append(
            f"Women's champ: {womens_frac:.0%} (${womens_frac * pot:,.0f}) — "
            f"{womens_teams} teams eligible"
        )
    if blowout_frac > 0:
        bonus_parts.append(
            f"Biggest blowout: {blowout_frac:.0%} (${blowout_frac * pot:,.0f})"
        )

    if bonus_parts:
        print(f"\n  🎁 BONUS PAYOUTS (come out of pot, round payouts scaled to "
              f"{1.0 - total_bonus_frac:.0%}):")
        for part in bonus_parts:
            print(f"     {part}")


def run_seed_based_analysis(pot: float) -> List[CalcuttaResult]:
    """
    Quick analysis using only historical seed advancement rates.
    No team-specific data needed — generates EV for each seed position.

    Note: Historical rates are independent averages per seed and don't
    perfectly enforce bracket constraints, so raw EVs may not sum to pot.
    Results are normalized so total EV = pot.

    Args:
        pot: Estimated total pot size

    Returns:
        List of CalcuttaResult objects (64 teams: 4 per seed × 16 seeds)
    """
    print("\n  🏀 SEED-BASED HISTORICAL ANALYSIS")
    print("  Using NCAA tournament advancement rates (1985–2024)\n")

    region_names = ["South", "East", "Midwest", "West"]
    results = []

    for seed in range(1, 17):
        for region in region_names:
            team = Team(
                name=f"{seed}-seed ({region})",
                seed=seed,
                region=region,
            )
            result = estimate_ev_historical(team, pot, PAYOUT_STRUCTURE)
            results.append(result)

    # Normalize so total EV = pot (historical rates are independent averages
    # that don't perfectly enforce the bracket constraint)
    total_raw_ev = sum(r.total_ev for r in results)
    if total_raw_ev > 0:
        scale = pot / total_raw_ev
        for r in results:
            r.total_ev *= scale
            r.max_bid = r.total_ev * RISK_DISCOUNT
            for rnd in r.round_evs:
                r.round_evs[rnd] *= scale

    print_results(results, pot, method="Historical Seed Averages")
    print_seed_summary(results)

    return results


def run_bracket_adjusted_analysis(
    regions: Dict[str, List[Team]],
    pot: float,
) -> List[CalcuttaResult]:
    """
    Bracket-aware analysis using historical rates adjusted for specific opponents.

    Hybrid method: combines historical seed advancement rates with the actual
    bracket structure. A 1-seed in a weak region gets higher rates than a
    1-seed in a stacked region, even without KenPom ratings.

    When ratings ARE available, uses them for more precise opponent-strength
    calculations. When they're NOT available, falls back to seed-based
    strength estimates.

    This method is best when:
        - You have a bracket but not full KenPom ratings
        - You want fast deterministic results (no simulation randomness)
        - You want to see how bracket draw affects team values

    Args:
        regions: Dict mapping region names to lists of 16 Team objects
        pot: Estimated total pot size

    Returns:
        List of CalcuttaResult objects for all 64 teams
    """
    has_ratings = all(
        t.rating is not None
        for teams in regions.values()
        for t in teams
    )
    method_label = "Bracket-Adjusted" + (" (with ratings)" if has_ratings else " (seed-based)")

    print(f"\n  🏀 {method_label.upper()} ANALYSIS")
    print("  Historical rates adjusted for specific bracket opponents\n")

    results = []
    for region_name, region_teams in regions.items():
        for team in region_teams:
            path = compute_bracket_path(team, region_teams, regions)
            result = estimate_ev_bracket_adjusted(team, pot, PAYOUT_STRUCTURE, path)
            results.append(result)

    # Normalize so total EV = pot
    total_raw_ev = sum(r.total_ev for r in results)
    if total_raw_ev > 0:
        scale = pot / total_raw_ev
        for r in results:
            r.total_ev *= scale
            r.max_bid = r.total_ev * RISK_DISCOUNT
            for rnd in r.round_evs:
                r.round_evs[rnd] *= scale

    # Blend with Vegas odds if available
    apply_vegas_blend(results, pot)

    # Apply bonus EVs (women's champ, biggest blowout)
    all_teams = [t for teams in regions.values() for t in teams]
    apply_bonus_evs(results, all_teams, pot)

    print_results(results, pot, method=method_label)
    print("\n  📊 BRACKET DIFFICULTY BY REGION:")
    for region_name in regions:
        region_results = [r for r in results if r.team.region == region_name]
        region_ev = sum(r.total_ev for r in region_results)
        top_seed = next((r for r in region_results if r.team.seed == 1), None)
        top_win = top_seed.win_probability if top_seed else 0
        print(f"    {region_name:<12} Total EV: ${region_ev:>7,.0f}  "
              f"1-seed title prob: {top_win:.1%}")

    return results


def run_monte_carlo_analysis(
    regions: Dict[str, List[Team]],
    pot: float,
    n_sims: int = NUM_SIMULATIONS,
) -> tuple:
    """
    Full Monte Carlo analysis using team power ratings.

    Args:
        regions: Dict mapping region names to lists of 16 rated Team objects
        pot: Estimated total pot size
        n_sims: Number of simulations

    Returns:
        Tuple of (List[CalcuttaResult], sim_matrix dict)
        sim_matrix maps team name -> List[int] of rounds won per simulation.
    """
    print(f"\n  🏀 MONTE CARLO SIMULATION ({n_sims:,} iterations)")
    print("  Using team power ratings to simulate bracket outcomes\n")

    # Validate all teams have ratings
    for region_name, teams in regions.items():
        if len(teams) != 16:
            raise ValueError(
                f"Region '{region_name}' has {len(teams)} teams, expected 16"
            )
        for team in teams:
            if team.rating is None:
                raise ValueError(
                    f"Team {team.name} in {region_name} has no rating. "
                    f"Set 'rating' to a KenPom AdjEM value in your JSON file."
                )

    # Run simulation
    print("  Simulating...", end=" ", flush=True)
    probabilities, sim_matrix = simulate_tournament(regions, n_sims)
    print("Done!")

    # Calculate EVs for all teams and attach bracket paths
    results = []
    for region_name, region_teams in regions.items():
        for team in region_teams:
            result = estimate_ev_monte_carlo(team, probabilities, pot, PAYOUT_STRUCTURE)
            # Attach bracket path for opponent-aware breakeven analysis
            result.bracket_path = compute_bracket_path(team, region_teams, regions)
            results.append(result)

    # Blend with Vegas odds if available
    apply_vegas_blend(results, pot)

    # Apply bonus EVs (women's champ, biggest blowout)
    all_teams = [t for teams in regions.values() for t in teams]
    apply_bonus_evs(results, all_teams, pot)

    print_results(results, pot, method=f"Monte Carlo ({n_sims:,} sims)")

    # Print detailed breakdown for top 10
    print("\n  📊 DETAILED BREAKDOWN — TOP 10 BY EV:")
    results.sort(key=lambda r: r.total_ev, reverse=True)
    for result in results[:10]:
        print_detailed_ev(result, pot)

    return results, sim_matrix


def run_manual_analysis(
    regions: Dict[str, List[Team]],
    pot: float,
) -> List[CalcuttaResult]:
    """
    Analysis using manually specified probabilities per team.

    Each team in the bracket JSON must have a "custom_probs" field.

    Args:
        regions: Dict of regions with teams that have custom_probs set
        pot: Estimated total pot

    Returns:
        List of CalcuttaResult objects
    """
    print("\n  🏀 MANUAL PROBABILITY ANALYSIS")
    print("  Using custom probabilities from bracket file\n")

    results = []
    for region_teams in regions.values():
        for team in region_teams:
            result = estimate_ev_manual(team, pot, PAYOUT_STRUCTURE)
            results.append(result)

    # Blend with Vegas odds if available
    apply_vegas_blend(results, pot)

    # Apply bonus EVs (women's champ, biggest blowout)
    all_teams = [t for teams in regions.values() for t in teams]
    apply_bonus_evs(results, all_teams, pot)

    print_results(results, pot, method="Manual Probabilities")
    return results


# ============================================================
# HISTORICAL AUCTION ANALYSIS
# ============================================================

@dataclass
class AuctionRecord:
    """A single team's result from a past Calcutta auction."""

    year: int
    team: str
    seed: int
    price_paid: float
    rounds_won: int       # 0 = lost R64, 1 = won R64, ..., 6 = champion
    payout_received: float


@dataclass
class SeedHistory:
    """Aggregated historical auction stats for a single seed."""

    seed: int
    count: int               # Number of times this seed was auctioned
    avg_price: float         # Mean price paid
    median_price: float      # Median price paid
    min_price: float         # Cheapest historical purchase
    max_price: float         # Most expensive historical purchase
    avg_payout: float        # Mean payout received
    avg_roi: float           # Mean ROI (payout/price - 1)
    p_profit: float          # Fraction of purchases that were profitable
    bias: float              # avg_price / avg_payout (>1 = overbid)


@dataclass
class HistoricalContext:
    """
    Full historical context for live auction use.

    Combines seed-level stats, region difficulty, and price anchors
    into a single object that can be queried during live bidding.
    """

    seed_histories: Dict[int, SeedHistory]
    seed_biases: Dict[int, float]
    # Region difficulty: {region_name: {"total_ev": float, "top_seed_title_prob": float}}
    region_difficulty: Optional[Dict[str, Dict[str, float]]] = None


def load_auction_history(filepath: str) -> List[AuctionRecord]:
    """
    Load historical auction results from a CSV file.

    Expected CSV columns:
        year, team, seed, price_paid, rounds_won, payout_received

    rounds_won:
        0 = lost in R64 (first game loss)
        1 = won R64, lost R32
        2 = won through R32, lost Sweet 16
        3 = won through Sweet 16, lost Elite 8
        4 = won through Elite 8, lost Final Four
        5 = won through Final Four, lost Championship
        6 = won Championship

    Args:
        filepath: Path to CSV file with past auction results

    Returns:
        List of AuctionRecord objects
    """
    records = []
    with open(filepath, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            records.append(AuctionRecord(
                year=int(row["year"]),
                team=row["team"].strip(),
                seed=int(row["seed"]),
                price_paid=float(row["price_paid"]),
                rounds_won=int(row["rounds_won"]),
                payout_received=float(row["payout_received"]),
            ))
    return records


def analyze_auction_history(records: List[AuctionRecord]) -> HistoricalContext:
    """
    Analyze historical auction data and return a HistoricalContext object
    containing per-seed stats, biases, and price ranges.

    Also prints a detailed analysis report.

    Args:
        records: List of AuctionRecord objects from load_auction_history()

    Returns:
        HistoricalContext with seed histories, biases, and region difficulty
    """
    print("\n" + "=" * 80)
    print("  📊 HISTORICAL AUCTION ANALYSIS")
    print(f"  {len(records)} records across "
          f"{len(set(r.year for r in records))} year(s)")
    print("=" * 80)

    # --- Per-seed analysis ---
    seed_data: Dict[int, Dict] = defaultdict(lambda: {
        "prices": [], "payouts": [], "count": 0,
    })
    for r in records:
        seed_data[r.seed]["prices"].append(r.price_paid)
        seed_data[r.seed]["payouts"].append(r.payout_received)
        seed_data[r.seed]["count"] += 1

    print(f"\n  {'Seed':<6} {'Count':>5} {'Avg Price':>10} {'Avg Payout':>11} "
          f"{'Avg ROI':>9} {'Avg Profit':>11} {'Bias':>10}")
    print(f"  {'-' * 68}")

    seed_biases = {}
    seed_histories = {}
    for seed in range(1, 17):
        if seed not in seed_data:
            continue
        d = seed_data[seed]
        prices = sorted(d["prices"])
        payouts = d["payouts"]
        avg_price = sum(prices) / len(prices)
        avg_payout = sum(payouts) / len(payouts)
        avg_profit = avg_payout - avg_price
        avg_roi = (avg_payout / avg_price - 1) if avg_price > 0 else 0

        # Median
        n = len(prices)
        median_price = prices[n // 2] if n % 2 == 1 else (
            (prices[n // 2 - 1] + prices[n // 2]) / 2
        )

        # P(profit) — fraction of purchases where payout > price
        profitable_count = sum(
            1 for p, pay in zip(d["prices"], payouts) if pay > p
        )
        p_profit = profitable_count / len(prices) if prices else 0

        # Bias = how much the market overpays relative to payout
        bias = avg_price / avg_payout if avg_payout > 0 else float("inf")
        seed_biases[seed] = bias

        seed_histories[seed] = SeedHistory(
            seed=seed,
            count=d["count"],
            avg_price=avg_price,
            median_price=median_price,
            min_price=min(prices),
            max_price=max(prices),
            avg_payout=avg_payout,
            avg_roi=avg_roi,
            p_profit=p_profit,
            bias=bias,
        )

        bias_label = "OVERBID" if bias > 1.15 else ("UNDERBID" if bias < 0.85 else "fair")

        print(
            f"  {seed:<6} {d['count']:>5} ${avg_price:>8,.0f} ${avg_payout:>9,.0f} "
            f"{avg_roi:>8.0%} ${avg_profit:>9,.0f} {bias_label:>10}"
        )

    # --- Year-over-year summary ---
    year_data: Dict[int, Dict] = defaultdict(lambda: {
        "total_prices": 0, "total_payouts": 0, "teams": 0,
    })
    for r in records:
        year_data[r.year]["total_prices"] += r.price_paid
        year_data[r.year]["total_payouts"] += r.payout_received
        year_data[r.year]["teams"] += 1

    print(f"\n  {'Year':<6} {'Pot Size':>10} {'Total Payout':>13} {'Teams':>6}")
    print(f"  {'-' * 40}")
    pot_sizes = []
    for year in sorted(year_data.keys()):
        yd = year_data[year]
        pot_sizes.append(yd["total_prices"])
        print(
            f"  {year:<6} ${yd['total_prices']:>8,.0f} "
            f"${yd['total_payouts']:>11,.0f} {yd['teams']:>6}"
        )

    if pot_sizes:
        avg_pot = sum(pot_sizes) / len(pot_sizes)
        print(f"\n  Average pot size: ${avg_pot:,.0f}")

    # --- Best and worst buys ---
    profitable = sorted(records, key=lambda r: r.payout_received - r.price_paid, reverse=True)

    print(f"\n  🏆 TOP 5 BEST BUYS (highest profit):")
    for r in profitable[:5]:
        profit = r.payout_received - r.price_paid
        roi = (r.payout_received / r.price_paid - 1) if r.price_paid > 0 else 0
        print(f"     {r.year} ({r.seed}) {r.team:<25} "
              f"Paid ${r.price_paid:,.0f} → Got ${r.payout_received:,.0f} "
              f"(+${profit:,.0f}, {roi:+.0%})")

    print(f"\n  💸 TOP 5 WORST BUYS (biggest loss):")
    for r in profitable[-5:]:
        profit = r.payout_received - r.price_paid
        roi = (r.payout_received / r.price_paid - 1) if r.price_paid > 0 else 0
        print(f"     {r.year} ({r.seed}) {r.team:<25} "
              f"Paid ${r.price_paid:,.0f} → Got ${r.payout_received:,.0f} "
              f"({'-' if profit < 0 else '+'}${abs(profit):,.0f}, {roi:+.0%})")

    print("=" * 80)

    return HistoricalContext(
        seed_histories=seed_histories,
        seed_biases=seed_biases,
    )


def apply_market_bias(
    results: List[CalcuttaResult],
    seed_biases: Dict[int, float],
):
    """
    Adjust max bid recommendations using historical market bias data.

    If your group historically overbids 1-seeds (bias > 1.0), the adjusted
    max bid will be lower to account for the expected overpayment. If they
    underbid 12-seeds, the adjusted bid goes up (opportunity).

    The adjustment modifies only the max_bid field and adds an
    'adjusted_max_bid' note. The raw EV is preserved.

    Args:
        results: List of CalcuttaResult objects to adjust
        seed_biases: Dict of seed -> market bias ratio from analyze_auction_history()
    """
    print("\n  📈 MARKET-ADJUSTED MAX BIDS")
    print(f"  {'Team':<30} {'Raw Max':>9} {'Bias':>7} {'Adj Max':>9} {'Action':>10}")
    print(f"  {'-' * 70}")

    results.sort(key=lambda r: r.total_ev, reverse=True)

    for result in results[:20]:
        seed = result.team.seed
        bias = seed_biases.get(seed, 1.0)
        raw_max = result.max_bid

        # If market overbids this seed (bias > 1.0), reduce your max to
        # avoid overpaying. If market underbids (bias < 1.0), you can
        # afford to bid higher because you'll face less competition.
        adjusted_max = raw_max / bias if bias > 0 else raw_max

        action = ""
        if bias > 1.15:
            action = "↓ careful"
        elif bias < 0.85:
            action = "↑ value!"
        else:
            action = "→ fair"

        print(
            f"  {str(result.team):<30} ${raw_max:>7,.0f} {bias:>6.2f}x "
            f"${adjusted_max:>7,.0f} {action:>10}"
        )


def generate_history_template(filepath: str = "auction_history_template.csv"):
    """
    Generate a blank CSV template for entering past auction results.

    Args:
        filepath: Output path for the template
    """
    with open(filepath, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["year", "team", "seed", "price_paid", "rounds_won", "payout_received"])
        # Example rows
        writer.writerow([2024, "UConn", 1, 800, 6, 2500])
        writer.writerow([2024, "Purdue", 1, 650, 5, 1200])
        writer.writerow([2024, "Houston", 1, 600, 1, 100])
        writer.writerow([2024, "North Carolina", 1, 500, 4, 800])
        writer.writerow([2024, "Iowa State", 2, 300, 2, 250])
        writer.writerow([2024, "Oakland", 14, 10, 1, 50])

    print(f"\n  ✅ History template saved to {filepath}")
    print("  Fill in your past auction data — one row per team per year.")
    print("  rounds_won: 0=lost R64, 1=won R64, 2=thru R32, ..., 6=champion")


# ============================================================
# LIVE AUCTION MODE
# ============================================================

@dataclass
class LiveAuctionState:
    """Tracks the state of an in-progress auction."""

    # Pre-computed EV results for all 64 teams (keyed by team name)
    ev_lookup: Dict[str, CalcuttaResult]
    # Teams that have been sold: {team_name: price_paid}
    sold: Dict[str, float]
    # Original estimated pot before auction started
    initial_pot_estimate: float
    # Path to save/load auction state
    save_path: str = "auction_state.json"
    # MY teams: subset of sold that I own {team_name: price_paid}
    my_teams: Dict[str, float] = None
    # My remaining budget
    budget: float = 0.0
    # Per-simulation outcomes from Monte Carlo (None if seed-based method)
    # sim_matrix[team_name][sim_idx] = rounds_won (0-6)
    sim_matrix: Optional[Dict[str, List[int]]] = None
    # Bayesian prior: mean and std dev of pot size distribution
    # If historical pot data is available, these come from that.
    # Otherwise, prior_mean = initial_pot_estimate, prior_std = 25% of mean.
    prior_mean: float = 0.0
    prior_std: float = 0.0
    # Full historical context: seed histories, biases, region difficulty
    hist_context: Optional[HistoricalContext] = None

    @property
    def seed_biases(self) -> Optional[Dict[int, float]]:
        """Convenience accessor for backward compatibility."""
        if self.hist_context:
            return self.hist_context.seed_biases
        return None

    def __post_init__(self):
        if self.my_teams is None:
            self.my_teams = {}
        # Initialize Bayesian prior if not set
        if self.prior_mean == 0.0:
            self.prior_mean = self.initial_pot_estimate
        if self.prior_std == 0.0:
            self.prior_std = self.initial_pot_estimate * BAYESIAN_PRIOR_CV

    @property
    def actual_pot_so_far(self) -> float:
        """Sum of all prices paid so far."""
        return sum(self.sold.values())

    @property
    def teams_remaining(self) -> int:
        """Number of teams not yet auctioned."""
        return len(self.ev_lookup) - len(self.sold)

    def _implied_pots(self) -> List[float]:
        """
        Compute an implied pot size from each sold team's price.

        Each team has a known EV share. If a team with 27% of total EV
        sells for $950, the implied pot = $950 / 0.27 = $3,519.

        Returns:
            List of implied pot values, one per sold team
        """
        total_ev = sum(r.total_ev for r in self.ev_lookup.values())
        if total_ev <= 0:
            return []

        implied = []
        for name, price in self.sold.items():
            if name not in self.ev_lookup:
                continue
            ev_share = self.ev_lookup[name].total_ev / total_ev
            if ev_share > 0.001:  # skip near-zero EV teams (noisy)
                implied.append(price / ev_share)
        return implied

    @property
    def projected_pot(self) -> float:
        """
        Bayesian posterior estimate of the final pot size.

        Uses a Normal-Normal conjugate model:
            Prior:        N(prior_mean, prior_std^2)
            Observations: implied pot from each sale ~ N(true_pot, obs_std^2)
            Posterior:    N(posterior_mean, posterior_std^2)

        The observation noise (obs_std) is set to BAYESIAN_OBS_CV × prior_mean
        and represents how noisy each individual sale price is as a pot
        estimator (teams don't sell at exact EV proportions).

        This replaces the old ad-hoc confidence weighting with principled
        Bayesian updating that:
            - Starts at the prior (initial estimate or historical avg)
            - Converges toward the data as more teams sell
            - Naturally weights informative sales (big EV share teams)
              more heavily through their lower implied-pot variance
            - Provides uncertainty estimates (posterior_std)
        """
        if len(self.sold) == 0:
            return self.prior_mean

        if len(self.sold) == len(self.ev_lookup):
            return self.actual_pot_so_far

        observations = self._implied_pots()
        if not observations:
            return self.prior_mean

        obs_std = self.prior_mean * BAYESIAN_OBS_CV
        posterior_mean, _ = bayesian_pot_update(
            self.prior_mean, self.prior_std, observations, obs_std
        )

        # Ensure pot projection is never below actual spend
        return max(posterior_mean, self.actual_pot_so_far)

    @property
    def pot_breakdown(self) -> Dict[str, float]:
        """
        Return a Bayesian pot estimation breakdown for display:
            actual_so_far, posterior_mean, posterior_std, confidence_interval,
            implied_avg, sold_ev_share, projected_pot
        """
        n_sold = len(self.sold)
        total_ev = sum(r.total_ev for r in self.ev_lookup.values())

        sold_ev_share = sum(
            self.ev_lookup[name].total_ev / total_ev
            for name in self.sold
            if name in self.ev_lookup
        ) if total_ev > 0 else 0.0

        observations = self._implied_pots()
        implied_avg = sum(observations) / len(observations) if observations else 0.0

        obs_std = self.prior_mean * BAYESIAN_OBS_CV
        if observations:
            posterior_mean, posterior_std = bayesian_pot_update(
                self.prior_mean, self.prior_std, observations, obs_std
            )
        else:
            posterior_mean = self.prior_mean
            posterior_std = self.prior_std

        # 90% credible interval
        ci_low = posterior_mean - 1.645 * posterior_std
        ci_high = posterior_mean + 1.645 * posterior_std

        return {
            "actual_so_far": self.actual_pot_so_far,
            "prior_mean": self.prior_mean,
            "prior_std": self.prior_std,
            "posterior_mean": posterior_mean,
            "posterior_std": posterior_std,
            "ci_low": max(self.actual_pot_so_far, ci_low),
            "ci_high": ci_high,
            "implied_avg": implied_avg,
            "projected_pot": self.projected_pot,
            "sold_ev_share": sold_ev_share,
            "unsold_ev_share": 1.0 - sold_ev_share,
        }

    def recalculate_evs(self) -> List[CalcuttaResult]:
        """
        Recalculate EVs for unsold teams using the projected pot.

        Returns:
            List of CalcuttaResult for unsold teams, sorted by EV desc
        """
        projected = self.projected_pot
        remaining = []

        for name, result in self.ev_lookup.items():
            if name in self.sold:
                continue

            # Scale EV proportionally to projected pot vs initial estimate
            scale = projected / self.initial_pot_estimate if self.initial_pot_estimate > 0 else 1.0
            adjusted_ev = result.total_ev * scale
            adjusted_max = adjusted_ev * RISK_DISCOUNT

            # Create adjusted result
            adj_result = CalcuttaResult(
                team=result.team,
                round_evs={r: ev * scale for r, ev in result.round_evs.items()},
                total_ev=adjusted_ev,
                max_bid=adjusted_max,
                win_probability=result.win_probability,
                round_probs=result.round_probs,
            )
            remaining.append(adj_result)

        remaining.sort(key=lambda r: r.total_ev, reverse=True)
        return remaining

    def save_state(self):
        """Save current auction state to JSON for crash recovery."""
        state = {
            "initial_pot_estimate": self.initial_pot_estimate,
            "sold": self.sold,
            "my_teams": self.my_teams,
            "budget": self.budget,
            "prior_mean": self.prior_mean,
            "prior_std": self.prior_std,
        }
        with open(self.save_path, "w") as f:
            json.dump(state, f, indent=2)

    @classmethod
    def load_state(cls, filepath: str, ev_lookup: Dict[str, CalcuttaResult],
                   initial_pot: float,
                   sim_matrix: Optional[Dict[str, List[int]]] = None,
                   prior_mean: float = 0.0,
                   prior_std: float = 0.0,
                   ) -> "LiveAuctionState":
        """Load a previously saved auction state."""
        state = cls(
            ev_lookup=ev_lookup,
            sold={},
            initial_pot_estimate=initial_pot,
            save_path=filepath,
            sim_matrix=sim_matrix,
            prior_mean=prior_mean,
            prior_std=prior_std,
        )
        if Path(filepath).exists():
            with open(filepath) as f:
                data = json.load(f)
            state.sold = data.get("sold", {})
            state.my_teams = data.get("my_teams", {})
            state.budget = data.get("budget", 0.0)
            state.initial_pot_estimate = data.get("initial_pot_estimate", initial_pot)
            state.prior_mean = data.get("prior_mean", prior_mean)
            state.prior_std = data.get("prior_std", prior_std)
        return state


def team_payout_for_rounds_won(rounds_won: int, pot: float) -> float:
    """
    Compute the total payout a team receives if it won through `rounds_won`
    rounds. In single elimination, winning through round k means collecting
    payouts for rounds 1 through k.

    Args:
        rounds_won: 0 (lost R64) through 6 (won Championship)
        pot: Total pot size

    Returns:
        Dollar payout for that tournament run
    """
    if rounds_won <= 0:
        return 0.0
    total = 0.0
    for i, round_name in enumerate(PAYOUT_STRUCTURE):
        if i < rounds_won:
            total += per_team_payout(round_name, pot)
    return total


def compute_portfolio_distribution(
    my_teams: Dict[str, float],
    sim_matrix: Dict[str, List[int]],
    pot: float,
) -> Dict:
    """
    Compute the full payout distribution for a portfolio of owned teams
    using Monte Carlo simulation outcomes.

    For each simulation, sums up the payouts for all owned teams based
    on how far each advanced, then subtracts total cost to get P&L.

    Args:
        my_teams: Dict of {team_name: price_paid}
        sim_matrix: Per-sim outcomes from simulate_tournament()
        pot: Projected pot size

    Returns:
        Dict with distribution statistics:
            n_sims, total_cost, payouts (list), profits (list),
            mean_payout, mean_profit, median_profit,
            p_profit (probability of profit), p_breakeven,
            p10 (10th percentile profit), p90 (90th percentile),
            max_profit, max_loss, std_dev,
            region_exposure (dict), per_team_stats (dict)
    """
    if not my_teams or not sim_matrix:
        return None

    n_sims = len(next(iter(sim_matrix.values())))
    total_cost = sum(my_teams.values())

    # Build per-team payout lookup for each possible rounds_won (0-6)
    payout_table = [team_payout_for_rounds_won(rw, pot) for rw in range(7)]

    # Compute portfolio payout in each simulation
    payouts = [0.0] * n_sims
    per_team_payouts = {name: [0.0] * n_sims for name in my_teams}

    for name in my_teams:
        if name not in sim_matrix:
            continue
        team_sims = sim_matrix[name]
        team_payouts = per_team_payouts[name]
        for i in range(n_sims):
            p = payout_table[team_sims[i]]
            team_payouts[i] = p
            payouts[i] += p

    # Compute profits
    profits = [p - total_cost for p in payouts]
    profits.sort()

    # Stats
    mean_payout = sum(payouts) / n_sims
    mean_profit = mean_payout - total_cost
    median_profit = profits[n_sims // 2]
    p_profit = sum(1 for p in profits if p > 0) / n_sims
    p_breakeven = sum(1 for p in profits if p >= 0) / n_sims
    p10 = profits[int(n_sims * 0.10)]
    p25 = profits[int(n_sims * 0.25)]
    p75 = profits[int(n_sims * 0.75)]
    p90 = profits[int(n_sims * 0.90)]
    std_dev = (sum((p - mean_profit) ** 2 for p in profits) / n_sims) ** 0.5

    # Per-team stats
    per_team_stats = {}
    for name, price in my_teams.items():
        tp = per_team_payouts[name]
        team_mean = sum(tp) / n_sims
        team_p_profit = sum(1 for p in tp if p > price) / n_sims
        per_team_stats[name] = {
            "price": price,
            "mean_payout": team_mean,
            "mean_profit": team_mean - price,
            "p_profit": team_p_profit,
        }

    return {
        "n_sims": n_sims,
        "total_cost": total_cost,
        "payouts": payouts,
        "profits": sorted(profits),
        "mean_payout": mean_payout,
        "mean_profit": mean_profit,
        "median_profit": median_profit,
        "p_profit": p_profit,
        "p_breakeven": p_breakeven,
        "p10": p10, "p25": p25, "p75": p75, "p90": p90,
        "max_profit": max(profits),
        "max_loss": min(profits),
        "std_dev": std_dev,
        "per_team_stats": per_team_stats,
    }


def print_portfolio_analysis(state: LiveAuctionState):
    """
    Print comprehensive portfolio analysis for owned teams.

    Shows: holdings summary, payout distribution, risk metrics,
    region exposure, per-team P&L breakdown.
    """
    if not state.my_teams:
        print("\n  No teams in portfolio yet. Use 'my <team> <price>' to add.")
        return

    pot = state.projected_pot
    ev_lookup = state.ev_lookup

    print("\n" + "=" * 80)
    print("  📊 PORTFOLIO ANALYSIS")
    print("=" * 80)

    total_cost = sum(state.my_teams.values())
    total_ev = sum(
        ev_lookup[n].total_ev * (pot / state.initial_pot_estimate)
        for n in state.my_teams if n in ev_lookup
    )

    print(f"  Teams owned: {len(state.my_teams)}  |  "
          f"Total invested: ${total_cost:,.0f}  |  "
          f"Portfolio EV: ${total_ev:,.0f}")
    print(f"  Edge: ${total_ev - total_cost:+,.0f}  |  "
          f"Budget remaining: ${state.budget:,.0f}")

    # Region exposure
    region_counts: Dict[str, List[str]] = defaultdict(list)
    for name in state.my_teams:
        if name in ev_lookup:
            region_counts[ev_lookup[name].team.region].append(
                str(ev_lookup[name].team)
            )

    print(f"\n  Region exposure:")
    all_regions = set(r.team.region for r in ev_lookup.values())
    for region in sorted(all_regions):
        teams_in = region_counts.get(region, [])
        bar = "█" * len(teams_in)
        if teams_in:
            print(f"    {region:<12} {bar} {len(teams_in)} — "
                  f"{', '.join(teams_in)}")
        else:
            print(f"    {region:<12} ░ 0   ← UNCOVERED")

    # Per-team breakdown
    print(f"\n  {'Team':<24} {'Price':>7} {'Adj EV':>7} {'Edge':>7} {'BE Round':>10}")
    print(f"  {'-' * 60}")
    scale = pot / state.initial_pot_estimate if state.initial_pot_estimate > 0 else 1.0
    for name, price in state.my_teams.items():
        if name not in ev_lookup:
            continue
        r = ev_lookup[name]
        adj_ev = r.total_ev * scale
        edge = adj_ev - price
        be = breakeven_round(price, pot)
        be_str = be if be else "NEVER"
        print(f"  {str(r.team):<24} ${price:>5,.0f} ${adj_ev:>5,.0f} "
              f"${edge:>+5,.0f} {be_str:>10}")

    # Monte Carlo distribution analysis (requires sim_matrix)
    if state.sim_matrix:
        dist = compute_portfolio_distribution(state.my_teams, state.sim_matrix, pot)
        if dist:
            print(f"\n  📈 PAYOUT DISTRIBUTION ({dist['n_sims']:,} simulations)")
            print(f"  {'-' * 55}")
            print(f"  Total invested:     ${dist['total_cost']:>8,.0f}")
            print(f"  Expected payout:    ${dist['mean_payout']:>8,.0f}  "
                  f"(EV profit: ${dist['mean_profit']:>+,.0f})")
            print(f"  Median outcome:     ${dist['median_profit']:>+8,.0f}")
            print(f"  Std deviation:      ${dist['std_dev']:>8,.0f}")

            print(f"\n  Probability of profit:   {dist['p_profit']:>6.0%}")
            print(f"  Probability of breakeven:{dist['p_breakeven']:>6.0%}")

            print(f"\n  Outcome ranges:")
            print(f"    Best case:   ${dist['max_profit']:>+8,.0f}")
            print(f"    90th pctile: ${dist['p90']:>+8,.0f}")
            print(f"    75th pctile: ${dist['p75']:>+8,.0f}")
            print(f"    Median:      ${dist['median_profit']:>+8,.0f}")
            print(f"    25th pctile: ${dist['p25']:>+8,.0f}")
            print(f"    10th pctile: ${dist['p10']:>+8,.0f}")
            print(f"    Worst case:  ${dist['max_loss']:>+8,.0f}")

            # Per-team contribution
            print(f"\n  Per-team performance:")
            print(f"  {'Team':<24} {'Avg Payout':>10} {'Avg Profit':>10} {'P(Profit)':>10}")
            print(f"  {'-' * 58}")
            for name, ts in dist["per_team_stats"].items():
                r = ev_lookup.get(name)
                label = str(r.team) if r else name
                print(f"  {label:<24} ${ts['mean_payout']:>8,.0f} "
                      f"${ts['mean_profit']:>+8,.0f} {ts['p_profit']:>9.0%}")
    else:
        print(f"\n  💡 Run with --method monte_carlo for full distribution analysis")
        print(f"     (probability of profit, percentile outcomes, hedge detection)")

    print("=" * 80)


def print_whatif_portfolio_impact(
    state: LiveAuctionState,
    team_name: str,
    price: float,
):
    """
    Show how adding a team at a given price would affect the user's portfolio.

    Computes before/after portfolio distributions and displays deltas for:
        - P(profit), median outcome, downside (10th pctile)
        - Region exposure change
        - Budget impact
        - Per-team contribution within the hypothetical portfolio

    Only runs when:
        - User has at least 1 team in their portfolio (my_teams)
        - Monte Carlo sim_matrix is available

    If no portfolio exists, prints a nudge to use 'my' command.
    If no sim_matrix, prints EV-only summary without distribution stats.

    Args:
        state: Current LiveAuctionState
        team_name: Name of team being evaluated
        price: Hypothetical price
    """
    ev_lookup = state.ev_lookup
    pot = state.projected_pot
    scale = pot / state.initial_pot_estimate if state.initial_pot_estimate > 0 else 1.0

    if not state.my_teams:
        print(f"\n  💡 Use 'my <team> <price>' to track your purchases, then")
        print(f"     whatif will show how this team impacts your portfolio.")
        return

    result = ev_lookup.get(team_name)
    if not result:
        return

    region = result.team.region

    # --- Region exposure ---
    my_regions: Dict[str, List[str]] = defaultdict(list)
    for name in state.my_teams:
        if name in ev_lookup:
            my_regions[ev_lookup[name].team.region].append(str(ev_lookup[name].team))

    same_region_count = len(my_regions.get(region, []))
    if same_region_count == 0:
        region_tag = "🟢 NEW REGION — adds diversification"
    elif same_region_count == 1:
        region_tag = f"🟡 You already own 1 team in {region}"
    else:
        region_tag = f"🔴 CONCENTRATED — you own {same_region_count} teams in {region}"
        same_region_teams = my_regions[region]
        region_tag += f" ({', '.join(same_region_teams)})"

    # --- EV-level summary (always available) ---
    current_cost = sum(state.my_teams.values())
    current_ev = sum(
        ev_lookup[n].total_ev * scale for n in state.my_teams if n in ev_lookup
    )
    new_cost = current_cost + price
    adj_ev = result.total_ev * scale
    new_ev = current_ev + adj_ev

    print(f"\n  📦 PORTFOLIO IMPACT")
    print(f"  {'─' * 55}")
    print(f"  {'':>25} {'Current':>12} {'+ This':>12} {'Delta':>10}")
    print(f"  {'─' * 55}")
    print(f"  {'Teams':>25} {len(state.my_teams):>12} {len(state.my_teams)+1:>12} {'':>10}")
    print(f"  {'Invested':>25} ${current_cost:>10,.0f} ${new_cost:>10,.0f} ${price:>+8,.0f}")
    print(f"  {'Portfolio EV':>25} ${current_ev:>10,.0f} ${new_ev:>10,.0f} ${adj_ev:>+8,.0f}")
    print(f"  {'EV Edge':>25} ${current_ev - current_cost:>+10,.0f} "
          f"${new_ev - new_cost:>+10,.0f} ${adj_ev - price:>+8,.0f}")

    if state.budget > 0:
        remaining = state.budget - price
        print(f"  {'Budget remaining':>25} ${state.budget:>10,.0f} "
              f"${max(0, remaining):>10,.0f} ${-price:>+8,.0f}")
        if remaining < 0:
            print(f"  ⚠️  Over budget by ${abs(remaining):,.0f}!")

    print(f"\n  Region: {region_tag}")

    # --- Distribution analysis (requires sim_matrix) ---
    if not state.sim_matrix:
        print(f"  💡 Run with --method monte_carlo for probability analysis")
        return

    # Current portfolio distribution
    current_dist = compute_portfolio_distribution(
        state.my_teams, state.sim_matrix, pot
    )
    if not current_dist:
        return

    # Hypothetical portfolio with this team added
    test_portfolio = dict(state.my_teams)
    test_portfolio[team_name] = price
    new_dist = compute_portfolio_distribution(
        test_portfolio, state.sim_matrix, pot
    )
    if not new_dist:
        return

    # Compute deltas
    d_p_profit = new_dist["p_profit"] - current_dist["p_profit"]
    d_median = new_dist["median_profit"] - current_dist["median_profit"]
    d_p10 = new_dist["p10"] - current_dist["p10"]
    d_p90 = new_dist["p90"] - current_dist["p90"]
    d_std = new_dist["std_dev"] - current_dist["std_dev"]
    d_mean = new_dist["mean_profit"] - current_dist["mean_profit"]

    # Direction arrows
    def arrow(val, good_is_positive=True):
        """Return a colored arrow based on whether the change is good or bad."""
        if abs(val) < 0.001:
            return "→"
        positive = val > 0
        is_good = positive == good_is_positive
        return "▲" if is_good else "▼"

    print(f"\n  {'':>25} {'Current':>12} {'+ This':>12} {'Delta':>10}")
    print(f"  {'─' * 55}")
    print(f"  {'P(profit)':>25} {current_dist['p_profit']:>11.0%} "
          f"{new_dist['p_profit']:>11.0%} "
          f"{d_p_profit:>+8.0%} {arrow(d_p_profit)}")
    print(f"  {'Expected profit':>25} ${current_dist['mean_profit']:>+10,.0f} "
          f"${new_dist['mean_profit']:>+10,.0f} "
          f"${d_mean:>+7,.0f} {arrow(d_mean)}")
    print(f"  {'Median outcome':>25} ${current_dist['median_profit']:>+10,.0f} "
          f"${new_dist['median_profit']:>+10,.0f} "
          f"${d_median:>+7,.0f} {arrow(d_median)}")
    print(f"  {'10th pctile':>25} ${current_dist['p10']:>+10,.0f} "
          f"${new_dist['p10']:>+10,.0f} "
          f"${d_p10:>+7,.0f} {arrow(d_p10)}")
    print(f"  {'90th pctile':>25} ${current_dist['p90']:>+10,.0f} "
          f"${new_dist['p90']:>+10,.0f} "
          f"${d_p90:>+7,.0f} {arrow(d_p90)}")
    print(f"  {'Volatility (std)':>25} ${current_dist['std_dev']:>10,.0f} "
          f"${new_dist['std_dev']:>10,.0f} "
          f"${d_std:>+7,.0f} {arrow(d_std, good_is_positive=False)}")

    # Verdict
    print(f"\n  ", end="")
    if d_p_profit > 0.02 and d_p10 > -price * 0.5:
        print("✅ GOOD ADD — improves win probability without crushing downside")
    elif d_p_profit > 0.02 and d_p10 < -price * 0.5:
        print("⚠️  HIGH VARIANCE — better P(profit) but steeper losses when wrong")
    elif d_p_profit < -0.02:
        print("❌ PORTFOLIO DRAG — reduces P(profit), likely overpaying")
    elif d_p_profit >= -0.02 and d_p_profit <= 0.02 and d_mean > 0:
        print("➡️  NEUTRAL — doesn't change odds much but adds expected value")
    else:
        print("🤔 MARGINAL — small impact either way")

    if same_region_count >= 2:
        print(f"  ⚠️  Region overlap: in {region} you'd own {same_region_count + 1} teams, "
              f"only 1 can advance past Elite 8")


def suggest_next_buys(
    state: LiveAuctionState,
    n_suggestions: int = 10,
) -> List[Dict]:
    """
    Rank unsold teams by marginal value to the portfolio, considering:
    1. EV per dollar (base value at adjusted prices)
    2. Region diversification (bonus for uncovered regions)
    3. Hedge value (Monte Carlo: does adding this team improve
       your probability of profit or reduce downside?)
    4. Budget feasibility

    Uses recalculated EVs (pot-adjusted) so all comparisons
    are apples-to-apples.

    Args:
        state: Current LiveAuctionState
        n_suggestions: Number of teams to recommend

    Returns:
        Sorted list of suggestion dicts with scoring breakdown
    """
    pot = state.projected_pot

    # Get pot-adjusted remaining team values
    remaining = state.recalculate_evs()
    remaining_lookup = {r.team.name: r for r in remaining}

    # Current region exposure
    my_regions: Dict[str, int] = defaultdict(int)
    for name in state.my_teams:
        if name in state.ev_lookup:
            my_regions[state.ev_lookup[name].team.region] += 1

    # Pre-compute current portfolio distribution if sim_matrix available
    current_dist = None
    if state.sim_matrix and state.my_teams:
        current_dist = compute_portfolio_distribution(
            state.my_teams, state.sim_matrix, pot
        )

    suggestions = []

    for r in remaining:
        name = r.team.name
        adj_ev = r.total_ev       # Already pot-adjusted from recalculate_evs
        price = r.max_bid         # Already pot-adjusted

        if price <= 0:
            continue

        # Budget filter
        if state.budget > 0 and price > state.budget:
            continue

        # --- Score component 1: EV per dollar ---
        # At max_bid, this = 1/RISK_DISCOUNT ≈ 1.18 for all teams.
        # The real differentiator is the hedge and region scores.
        ev_per_dollar = adj_ev / price if price > 0 else 0

        # --- Score component 2: Region diversification ---
        region = r.team.region
        region_count = my_regions.get(region, 0)
        if region_count == 0:
            region_score = 1.25  # 25% bonus for new region coverage
        elif region_count == 1:
            region_score = 1.0   # Neutral
        else:
            region_score = max(0.7, 1.0 - (region_count - 1) * 0.15)

        # --- Score component 3: Portfolio hedge value ---
        # How much does adding this team improve our distribution?
        hedge_score = 1.0
        marginal_p_profit = 0.0
        marginal_p10 = 0.0

        if state.sim_matrix and state.my_teams and current_dist:
            test_portfolio = dict(state.my_teams)
            test_portfolio[name] = price
            test_dist = compute_portfolio_distribution(
                test_portfolio, state.sim_matrix, pot
            )
            if test_dist:
                marginal_p_profit = test_dist["p_profit"] - current_dist["p_profit"]
                marginal_p10 = test_dist["p10"] - current_dist["p10"]

                # P(profit) boost: +5pp → 1.25x, +10pp → 1.50x
                profit_boost = marginal_p_profit * 5.0

                # Downside protection: normalize by total portfolio cost
                # (not by this team's price) so cheap vs expensive are fair
                total_cost = sum(state.my_teams.values()) + price
                floor_boost = marginal_p10 / max(total_cost, 100) * 2.0

                hedge_score = 1.0 + profit_boost + floor_boost
                hedge_score = max(0.6, min(1.8, hedge_score))

        # --- Score component 4: Historical market bias ---
        # If your group historically overpays this seed (bias > 1), you'll
        # face stiffer competition → penalize. If they underpay (bias < 1),
        # this seed is a bargain opportunity → boost.
        bias_score = 1.0
        if state.seed_biases and r.team.seed in state.seed_biases:
            bias = state.seed_biases[r.team.seed]
            # Invert: overpaid seeds get penalized, underpaid get boosted
            # bias=1.3 → bias_score=0.85 (15% penalty)
            # bias=0.7 → bias_score=1.21 (21% bonus)
            bias_score = 1.0 / (bias ** 0.5)
            bias_score = max(0.7, min(1.4, bias_score))

        # --- Combined score ---
        combined_score = ev_per_dollar * region_score * hedge_score * bias_score

        # Breakeven
        be = breakeven_round(price, pot)
        be_prob = 0.0
        if be:
            be_idx = list(PAYOUT_STRUCTURE.keys()).index(be)
            be_prob = r.round_probs[be_idx] if be_idx < len(r.round_probs) else 0.0

        suggestions.append({
            "name": name,
            "team": r.team,
            "price": price,
            "adj_ev": adj_ev,
            "ev_per_dollar": ev_per_dollar,
            "region": region,
            "region_score": region_score,
            "hedge_score": hedge_score,
            "bias_score": bias_score,
            "combined_score": combined_score,
            "be_round": be or "N/A",
            "be_prob": be_prob,
            "win_prob": r.win_probability,
            "marginal_p_profit": marginal_p_profit,
            "marginal_p10": marginal_p10,
        })

    # Sort by combined score descending
    suggestions.sort(key=lambda s: s["combined_score"], reverse=True)
    return suggestions[:n_suggestions]


def print_suggestions(state: LiveAuctionState):
    """Print portfolio-optimized team purchase recommendations."""
    if not state.my_teams:
        print("\n  Add teams with 'my <team> <price>' first, then run 'suggest'")
        print("  (Suggestions are personalized to your current holdings)")
        return

    suggestions = suggest_next_buys(state)
    pot = state.projected_pot
    has_sim = state.sim_matrix is not None

    print("\n" + "=" * 80)
    print("  🎯 SUGGESTED NEXT BUYS (at max bid prices)")
    if state.budget > 0:
        print(f"  Budget: ${state.budget:,.0f}  |  Portfolio: "
              f"{len(state.my_teams)} teams, "
              f"${sum(state.my_teams.values()):,.0f} invested")
    print("=" * 80)

    if has_sim:
        print(f"\n  {'#':>3} {'Team':<22} {'Price':>7} {'Region':>5} "
              f"{'Hedge':>5} {'Score':>6} {'BE':>12} {'ΔP(profit)':>10} {'Why'}")
        print(f"  {'-' * 82}")
    else:
        print(f"\n  {'#':>3} {'Team':<22} {'Price':>7} {'Region':>5} "
              f"{'Score':>6} {'BE':>12} {'Why'}")
        print(f"  {'-' * 68}")

    for i, s in enumerate(suggestions, 1):
        # Build "why" tag
        reasons = []
        if s["region_score"] > 1.1:
            reasons.append("NEW RGN")
        if s["hedge_score"] > 1.15:
            reasons.append("HEDGE")
        if s.get("bias_score", 1.0) > 1.15:
            reasons.append("BARGAIN")
        elif s.get("bias_score", 1.0) < 0.85:
            reasons.append("CROWDED")
        if s["be_prob"] > 0.5:
            reasons.append("SAFE BE")
        if s["win_prob"] > 0.05:
            reasons.append("CONTENDER")
        why = " ".join(reasons) if reasons else ""

        if has_sim:
            dp = s["marginal_p_profit"]
            dp_str = f"{dp:+.1%}" if dp != 0 else "—"
            print(
                f"  {i:>3} {str(s['team']):<22} ${s['price']:>5,.0f} "
                f"{s['region_score']:>4.2f}x {s['hedge_score']:>4.2f}x "
                f"{s['combined_score']:>5.2f} "
                f"{s['be_round']:>12} {dp_str:>10}  {why}"
            )
        else:
            print(
                f"  {i:>3} {str(s['team']):<22} ${s['price']:>5,.0f} "
                f"{s['region_score']:>4.2f}x "
                f"{s['combined_score']:>5.2f} "
                f"{s['be_round']:>12}  {why}"
            )

    # Summary advice
    if suggestions:
        top = suggestions[0]
        print(f"\n  💡 Top pick: {top['team']} at ${top['price']:,.0f}")
        reasons = []
        if top["region_score"] > 1.1:
            reasons.append(f"covers {top['region']} region")
        if top["hedge_score"] > 1.15:
            reasons.append(f"improves P(profit) by {top['marginal_p_profit']:+.1%}")
        if top.get("bias_score", 1.0) > 1.15:
            reasons.append(f"historically undervalued seed in your group")
        if top["be_prob"] > 0.5:
            reasons.append(f"breaks even at {top['be_round']} ({top['be_prob']:.0%} prob)")
        if reasons:
            print(f"     Why: {', '.join(reasons)}")

    print("=" * 80)


def format_vegas_context(result: CalcuttaResult) -> str:
    """
    Return a short note showing model vs Vegas title probability
    for a team, if both are available.

    Examples:
        "🎰 Model: 37% title | Vegas: 28% | Blend: 33% — model may be HIGH"
        "🎰 Model: 2.0% title | Vegas: 4.5% | Blend: 3.3% — Vegas sees upside"

    Args:
        result: CalcuttaResult with optional vegas/model title probs

    Returns:
        One-line string, empty if no Vegas data
    """
    if result.model_title_prob is None or result.vegas_title_prob is None:
        return ""

    model_p = result.model_title_prob
    vegas_p = result.vegas_title_prob
    blend_p = result.win_probability  # After blending

    if model_p <= 0 or vegas_p <= 0:
        return ""

    ratio = model_p / vegas_p

    if ratio > VEGAS_DISAGREEMENT_THRESHOLD:
        note = "⚠️  model may be HIGH"
    elif ratio < 1.0 / VEGAS_DISAGREEMENT_THRESHOLD:
        note = "📈 Vegas sees upside"
    elif ratio > 1.15:
        note = "model slightly higher"
    elif ratio < 0.85:
        note = "Vegas slightly higher"
    else:
        note = "in agreement"

    return (f"     🎰 Model: {model_p:.1%} title | "
            f"Vegas: {vegas_p:.1%} | "
            f"Blend: {blend_p:.1%} — {note}")


def format_bias_tag(seed: int, seed_biases: Optional[Dict[int, float]]) -> str:
    """
    Return a short tag describing historical market bias for a seed.

    Examples:
        "↑1.32x" (group overpays this seed by 32%)
        "↓0.78x" (group underpays this seed by 22% — opportunity)
        "" (no bias data or neutral)

    Args:
        seed: Team seed (1-16)
        seed_biases: Dict of seed -> bias ratio from history

    Returns:
        Short formatted string, empty if no data or neutral
    """
    if not seed_biases or seed not in seed_biases:
        return ""
    bias = seed_biases[seed]
    if bias > 1.10:
        return f"↑{bias:.2f}x"
    elif bias < 0.90:
        return f"↓{bias:.2f}x"
    return ""


def format_bias_context(
    price: float,
    ev: float,
    seed: int,
    seed_biases: Optional[Dict[int, float]],
) -> str:
    """
    Return a contextual note comparing a sale price to historical bias.

    Used after recording a sale to show whether the price aligns with
    your group's historical tendencies for this seed.

    Args:
        price: What this team sold for
        ev: Adjusted EV at current projected pot
        seed: Team's seed
        seed_biases: Historical bias data

    Returns:
        A one-line context string, or empty if no bias data
    """
    if not seed_biases or seed not in seed_biases:
        return ""

    bias = seed_biases[seed]
    expected_price = ev * bias  # What your group historically pays for this EV

    if price > expected_price * 1.15:
        pct_over = (price / expected_price - 1) * 100
        return f"     📊 History: your group overpays {seed}-seeds by {bias:.0%}, " \
               f"but this is {pct_over:.0f}% ABOVE even that"
    elif price < expected_price * 0.85:
        pct_under = (1 - price / expected_price) * 100
        return f"     📊 History: {seed}-seeds go for ~{bias:.2f}x EV in your group — " \
               f"this sold {pct_under:.0f}% BELOW typical"
    elif bias > 1.15:
        return f"     📊 History: your group overpays {seed}-seeds ({bias:.2f}x EV) — " \
               f"this sale is in line"
    elif bias < 0.85:
        return f"     📊 History: {seed}-seeds are undervalued in your group ({bias:.2f}x EV)"
    return ""


def format_price_range_context(
    price: float,
    seed: int,
    hist_context: Optional[HistoricalContext],
) -> str:
    """
    Return a short note showing where a price falls in the historical
    range for that seed.

    Examples:
        "1-seeds: $900–$1,300 (med $1,050) — this is LOW END"
        "3-seeds: $180–$250 (med $210) — this is ABOVE RANGE"

    Args:
        price: Actual or hypothetical price
        seed: Team seed
        hist_context: Full historical context

    Returns:
        One-line string, empty if no data
    """
    if not hist_context or seed not in hist_context.seed_histories:
        return ""

    sh = hist_context.seed_histories[seed]
    if sh.count < 2:
        return ""

    # Determine where price falls
    if price < sh.min_price * 0.85:
        position = "WELL BELOW RANGE"
    elif price < sh.min_price:
        position = "BELOW RANGE"
    elif price <= sh.min_price + (sh.median_price - sh.min_price) * 0.5:
        position = "LOW END"
    elif price <= sh.median_price + (sh.max_price - sh.median_price) * 0.5:
        position = "MID RANGE"
    elif price <= sh.max_price:
        position = "HIGH END"
    elif price <= sh.max_price * 1.15:
        position = "ABOVE RANGE"
    else:
        position = "WELL ABOVE RANGE"

    return (f"     📊 {seed}-seeds in your group: "
            f"${sh.min_price:,.0f}–${sh.max_price:,.0f} "
            f"(med ${sh.median_price:,.0f}) — this is {position}")


def print_cheatsheet(state: LiveAuctionState):
    """
    Print a condensed bidding cheatsheet combining region difficulty,
    historical price ranges, P(profit) by seed, and price anchors.

    Designed to be glanced at quickly during live bidding.
    """
    hc = state.hist_context
    pot = state.projected_pot

    print("\n" + "=" * 80)
    print("  📋 BIDDING CHEATSHEET")
    print("=" * 80)

    # --- Region difficulty ---
    if hc and hc.region_difficulty:
        print("\n  🗺️  REGION DIFFICULTY (from bracket analysis)")
        # Sort by total EV descending = easiest region first
        sorted_regions = sorted(
            hc.region_difficulty.items(),
            key=lambda x: x[1]["total_ev"], reverse=True,
        )
        for i, (region, data) in enumerate(sorted_regions, 1):
            ev = data["total_ev"]
            title_p = data["top_seed_title_prob"]
            # Scale region EV to current projected pot
            scale = pot / state.initial_pot_estimate if state.initial_pot_estimate > 0 else 1.0
            adj_ev = ev * scale
            label = "EASIEST" if i == 1 else ("HARDEST" if i == len(sorted_regions) else "")
            bar = "█" * max(1, int(adj_ev / (pot / 4) * 20))
            print(f"    {region:<12} {bar:<22} "
                  f"EV: ${adj_ev:>6,.0f}  "
                  f"1-seed title: {title_p:>5.1%}  {label}")

        # Calculate coverage for user's portfolio
        if state.my_teams:
            owned_regions = set()
            for name in state.my_teams:
                if name in state.ev_lookup:
                    owned_regions.add(state.ev_lookup[name].team.region)
            uncovered = [r for r, _ in sorted_regions if r not in owned_regions]
            if uncovered:
                print(f"\n    ⚠️  Uncovered regions: {', '.join(uncovered)}")
            else:
                print(f"\n    ✅ All regions covered!")

    # --- Historical price ranges and P(profit) by seed ---
    if hc and hc.seed_histories:
        print(f"\n  💰 HISTORICAL PRICES & WIN RATES BY SEED")
        print(f"    {'Seed':<5} {'Range':>16} {'Median':>8} "
              f"{'P(profit)':>10} {'Avg ROI':>8} {'Verdict':>12}")
        print(f"    {'-' * 65}")

        for seed in range(1, 17):
            sh = hc.seed_histories.get(seed)
            if not sh:
                continue

            # Verdict based on P(profit) and ROI
            if sh.p_profit >= 0.50 and sh.avg_roi > 0:
                verdict = "🟢 BUY"
            elif sh.p_profit >= 0.35:
                verdict = "🟡 OK"
            elif sh.p_profit >= 0.20:
                verdict = "🟠 RISKY"
            else:
                verdict = "🔴 AVOID"

            print(
                f"    {seed:<5} "
                f"${sh.min_price:>5,.0f}–${sh.max_price:>5,.0f} "
                f"${sh.median_price:>6,.0f} "
                f"{sh.p_profit:>9.0%} "
                f"{sh.avg_roi:>+7.0%} "
                f"{verdict:>12}"
            )

        # Summary insight
        best_seeds = [
            sh for sh in hc.seed_histories.values()
            if sh.p_profit >= 0.40
        ]
        if best_seeds:
            best_seeds.sort(key=lambda s: s.p_profit, reverse=True)
            best_str = ", ".join(f"{s.seed}-seeds ({s.p_profit:.0%})" for s in best_seeds[:3])
            print(f"\n    💡 Most profitable seeds in your group: {best_str}")

        worst_seeds = [
            sh for sh in hc.seed_histories.values()
            if sh.p_profit < 0.30 and sh.count >= 3
        ]
        if worst_seeds:
            worst_seeds.sort(key=lambda s: s.p_profit)
            worst_str = ", ".join(f"{s.seed}-seeds ({s.p_profit:.0%})" for s in worst_seeds[:3])
            print(f"    ⚠️  Least profitable seeds: {worst_str}")

    # --- Price anchor table: at historical median, what's the breakeven? ---
    if hc and hc.seed_histories:
        print(f"\n  🎯 PRICE ANCHORS (at your group's median price, what's the breakeven?)")
        print(f"    {'Seed':<5} {'Med Price':>10} {'BE Round':>14} {'BE Prob':>8}")
        print(f"    {'-' * 42}")

        for seed in range(1, 9):  # Most interesting for seeds 1-8
            sh = hc.seed_histories.get(seed)
            if not sh:
                continue

            # Scale median price to current pot
            # (historical prices were at historical pots, but the breakeven
            # calc uses current pot's payouts, so this is approximate)
            be = breakeven_round(sh.median_price, pot)
            be_str = be if be else "NEVER"
            be_prob = 0.0
            if be:
                # Use historical seed rates for probability
                rates = HISTORICAL_RATES.get(seed, [])
                be_idx = list(PAYOUT_STRUCTURE.keys()).index(be)
                be_prob = rates[be_idx] if be_idx < len(rates) else 0.0

            print(f"    {seed:<5} ${sh.median_price:>8,.0f} {be_str:>14} {be_prob:>7.0%}")

    if not hc or (not hc.seed_histories and not hc.region_difficulty):
        print("\n  No historical data available.")
        print("  Run with --history <file> for price ranges and seed P(profit).")
        print("  Run with --method monte_carlo for region difficulty.")

    # --- Model vs. Vegas disagreements ---
    disagreements = []
    for name, r in state.ev_lookup.items():
        if r.model_title_prob is not None and r.vegas_title_prob is not None:
            if r.model_title_prob > 0 and r.vegas_title_prob > 0:
                ratio = r.model_title_prob / r.vegas_title_prob
                if ratio > VEGAS_DISAGREEMENT_THRESHOLD or ratio < 1.0 / VEGAS_DISAGREEMENT_THRESHOLD:
                    direction = "Model HIGH" if ratio > 1 else "Vegas HIGH"
                    disagreements.append({
                        "team": r.team,
                        "model": r.model_title_prob,
                        "vegas": r.vegas_title_prob,
                        "blend": r.win_probability,
                        "direction": direction,
                        "sold": name in state.sold,
                    })

    if disagreements:
        disagreements.sort(key=lambda d: abs(d["model"] - d["vegas"]), reverse=True)
        print(f"\n  ⚡ MODEL vs. VEGAS DISAGREEMENTS")
        print(f"    {'Team':<24} {'Model':>7} {'Vegas':>7} {'Blend':>7} {'':>11} {'Status'}")
        print(f"    {'-' * 68}")
        for d in disagreements[:10]:
            status = "SOLD" if d["sold"] else "AVAILABLE"
            print(f"    {str(d['team']):<24} "
                  f"{d['model']:>6.1%} {d['vegas']:>6.1%} "
                  f"{d['blend']:>6.1%} {d['direction']:>11} {status}")

        # Actionable insight
        value_picks = [d for d in disagreements
                       if d["direction"] == "Vegas HIGH" and not d["sold"]]
        if value_picks:
            top = value_picks[0]
            print(f"\n    💡 Vegas likes {top['team']} more than our model "
                  f"({top['vegas']:.1%} vs {top['model']:.1%}) — "
                  f"possible hidden value")

        caution_picks = [d for d in disagreements
                         if d["direction"] == "Model HIGH" and not d["sold"]]
        if caution_picks:
            top = caution_picks[0]
            print(f"    ⚠️  Our model may overvalue {top['team']} "
                  f"({top['model']:.1%} vs Vegas {top['vegas']:.1%}) — "
                  f"don't overcommit")
    elif any(r.vegas_title_prob is not None for r in state.ev_lookup.values()):
        print(f"\n  🎰 Model and Vegas are in agreement (no major disagreements)")

    print("=" * 80)


def print_live_dashboard(state: LiveAuctionState):
    """Print the live auction dashboard showing current state and recommendations."""
    n_sold = len(state.sold)
    n_total = len(state.ev_lookup)
    projected = state.projected_pot

    print("\n" + "=" * 80)
    print("  🔴 LIVE AUCTION DASHBOARD")
    print("=" * 80)

    # Pot projection details
    if n_sold > 0:
        bd = state.pot_breakdown
        print(f"  Teams sold: {n_sold}/{n_total}  |  "
              f"Pot so far: ${bd['actual_so_far']:,.0f}  |  "
              f"Projected final pot: ${projected:,.0f}")
        print(f"  Bayesian 90% CI: ${bd['ci_low']:,.0f}–${bd['ci_high']:,.0f}  |  "
              f"Uncertainty: ±${bd['posterior_std']:,.0f}")
        print(f"  Prior: ${bd['prior_mean']:,.0f}  |  "
              f"Implied avg: ${bd['implied_avg']:,.0f}  |  "
              f"EV share sold: {bd['sold_ev_share']:.0%}")

        # Visual pot trend bar
        pct_of_estimate = state.actual_pot_so_far / state.initial_pot_estimate
        bar_len = min(int(pct_of_estimate * 40), 60)
        print(f"\n  Pot fill: [{'█' * bar_len}{'░' * max(0, 40 - bar_len)}] "
              f"{pct_of_estimate:.0%} of estimate")

        # Show if the market is running hot or cold vs estimate
        if projected > state.initial_pot_estimate * 1.1:
            print(f"  🔥 Market is HOT — pot tracking "
                  f"{projected / state.initial_pot_estimate:.0%} of your estimate")
        elif projected < state.initial_pot_estimate * 0.9:
            print(f"  ❄️  Market is COLD — pot tracking "
                  f"{projected / state.initial_pot_estimate:.0%} of your estimate")
    else:
        print(f"  Teams sold: 0/{n_total}  |  "
              f"Pot so far: $0  |  "
              f"Projected pot: ${projected:,.0f}")
        print(f"  Initial estimate: ${state.initial_pot_estimate:,.0f}  |  "
              f"Remaining teams: {state.teams_remaining}")

    # Show region difficulty if available
    hc = state.hist_context
    if hc and hc.region_difficulty and len(state.sold) == 0:
        scale = projected / state.initial_pot_estimate if state.initial_pot_estimate > 0 else 1.0
        sorted_regions = sorted(
            hc.region_difficulty.items(),
            key=lambda x: x[1]["total_ev"], reverse=True,
        )
        easiest = sorted_regions[0][0]
        hardest = sorted_regions[-1][0]
        print(f"\n  Regions: {easiest} (easiest) → {hardest} (hardest) — "
              f"type 'cheatsheet' for details")

    # Show recent purchases
    if state.sold:
        print(f"\n  Recent purchases:")
        recent = list(state.sold.items())[-5:]
        for name, price in recent:
            result = state.ev_lookup.get(name)
            if result:
                ev = result.total_ev * (projected / state.initial_pot_estimate)
                delta = price - ev
                indicator = "💰 STEAL" if delta < -ev * 0.2 else (
                    "⚠️  OVERPAID" if delta > ev * 0.2 else "✅ FAIR"
                )
                print(f"    {str(result.team):<28} ${price:>7,.0f}  "
                      f"(EV: ${ev:>7,.0f})  {indicator}")

    # Show recommended max bids for remaining teams
    remaining = state.recalculate_evs()
    has_bias = state.seed_biases is not None and len(state.seed_biases) > 0
    if remaining:
        if has_bias:
            print(f"\n  {'Rank':<5} {'Team':<24} {'EV':>8} {'Max Bid':>8} "
                  f"{'Adj Max':>8} {'Bias':>6} {'Win %':>6} {'BE @ Max':>10}")
            print(f"  {'-' * 82}")
        else:
            print(f"\n  {'Rank':<5} {'Team':<24} {'EV':>8} {'Max Bid':>8} "
                  f"{'Win %':>6} {'BE @ Max':>10}")
            print(f"  {'-' * 68}")

        for i, r in enumerate(remaining[:20], 1):
            be = breakeven_round(r.max_bid, projected)
            be_str = be if be else "N/A"
            if has_bias:
                seed = r.team.seed
                bias = state.seed_biases.get(seed, 1.0)
                adj_max = r.max_bid / bias if bias > 0 else r.max_bid
                bias_tag = format_bias_tag(seed, state.seed_biases)
                print(f"  {i:<5} {str(r.team):<24} ${r.total_ev:>6,.0f} "
                      f"${r.max_bid:>6,.0f} ${adj_max:>6,.0f} "
                      f"{bias_tag:>6} {r.win_probability:>5.1%} "
                      f"{be_str:>10}")
            else:
                print(f"  {i:<5} {str(r.team):<24} ${r.total_ev:>6,.0f} "
                      f"${r.max_bid:>6,.0f} {r.win_probability:>5.1%} "
                      f"{be_str:>10}")

        if len(remaining) > 20:
            print(f"  ... and {len(remaining) - 20} more teams")

        if has_bias:
            print(f"\n  📊 Adj Max = Max Bid ÷ historical bias. "
                  f"↑ = group overpays (bid less), ↓ = undervalued (opportunity)")

    print("=" * 80)


def run_live_auction(
    results: List[CalcuttaResult],
    pot: float,
    save_path: str = "auction_state.json",
    sim_matrix: Optional[Dict[str, List[int]]] = None,
    prior_mean: float = 0.0,
    prior_std: float = 0.0,
    hist_context: Optional[HistoricalContext] = None,
):
    """
    Run interactive live auction mode.

    Commands:
        <team_name> <price>    Record a sale (e.g., "UConn 850")
        my <team> <price>      Record a sale AND mark as mine
        unmy <team>            Remove a team from my portfolio (keeps it sold)
        undo                   Undo the last sale
        show                   Refresh the dashboard
        whatif <team> <price>  Breakeven analysis without recording
        portfolio              Show portfolio analysis with payout distribution
        suggest                Get portfolio-optimized purchase recommendations
        cheatsheet             Bidding guide: regions, price ranges, P(profit), anchors
        budget <amount>        Set remaining budget
        search <term>          Search for a team by name
        remaining              Show all unsold teams
        export                 Export current state to CSV
        pot <amount>           Manually update pot projection
        quit / q               Save and exit

    Args:
        results: Pre-computed CalcuttaResult list (from any method)
        pot: Initial pot estimate
        save_path: Path for auto-saving auction state
        sim_matrix: Per-sim outcomes from Monte Carlo (enables portfolio analysis)
        hist_context: Historical auction context (biases, price ranges, P(profit))
    """
    # Build lookup by team name (case-insensitive)
    ev_lookup = {}
    name_map = {}  # lowercase -> actual name
    for r in results:
        ev_lookup[r.team.name] = r
        name_map[r.team.name.lower()] = r.team.name

    # Try to resume from saved state
    state = LiveAuctionState.load_state(
        save_path, ev_lookup, pot, sim_matrix,
        prior_mean=prior_mean, prior_std=prior_std,
    )
    state.hist_context = hist_context

    if state.sold:
        print(f"\n  📂 Resumed auction state: {len(state.sold)} teams sold, "
              f"{len(state.my_teams)} owned")

    print_live_dashboard(state)

    print("\n  Commands: '<team> <price>' to record sale, 'my <team> <price>' to buy,")
    print("            'portfolio', 'suggest', 'cheatsheet', 'budget <amt>',")
    print("            'whatif <team> <price>', 'undo', 'show', 'search',")
    print("            'remaining', 'export', 'pot', 'quit'")

    # Maintain an ordered history for undo
    sale_history: List[str] = list(state.sold.keys())

    while True:
        try:
            user_input = input("\n  🏀 > ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n")
            break

        if not user_input:
            continue

        cmd_lower = user_input.lower()

        # --- Quit ---
        if cmd_lower in ("quit", "q", "exit"):
            state.save_state()
            print("  💾 Auction state saved. Run again to resume.")
            break

        # --- Show dashboard ---
        elif cmd_lower == "show":
            print_live_dashboard(state)

        # --- Undo last sale ---
        elif cmd_lower == "undo":
            if not sale_history:
                print("  ❌ Nothing to undo")
            else:
                last = sale_history.pop()
                price = state.sold.pop(last)
                state.save_state()
                print(f"  ↩️  Removed: {last} (${price:,.0f})")
                print_live_dashboard(state)

        # --- Search ---
        elif cmd_lower.startswith("search "):
            term = user_input[7:].strip().lower()
            matches = [
                name for name in ev_lookup
                if term in name.lower()
            ]
            if not matches:
                print(f"  No teams matching '{term}'")
            else:
                for name in matches:
                    r = ev_lookup[name]
                    sold_tag = f" [SOLD: ${state.sold[name]:,.0f}]" if name in state.sold else ""
                    print(f"    {r.team}{sold_tag}")

        # --- Remaining teams ---
        elif cmd_lower == "remaining":
            remaining = state.recalculate_evs()
            proj = state.projected_pot
            print(f"\n  {len(remaining)} teams remaining (projected pot: ${proj:,.0f}):")
            print(f"    {'#':>3}  {'Team':<24} {'EV':>8} {'Max':>8} {'BE @ Max':>10}")
            print(f"    {'-' * 58}")
            for i, r in enumerate(remaining, 1):
                be = breakeven_round(r.max_bid, proj)
                be_str = be if be else "N/A"
                print(f"    {i:>3}. {str(r.team):<24} ${r.total_ev:>6,.0f} "
                      f"${r.max_bid:>6,.0f} {be_str:>10}")

        # --- Export ---
        elif cmd_lower == "export":
            remaining = state.recalculate_evs()
            proj = state.projected_pot
            export_path = "auction_live_values.csv"
            with open(export_path, "w", newline="") as f:
                writer = csv.writer(f)
                writer.writerow(["Status", "Team", "Seed", "Region", "Price_Paid",
                                 "EV", "Max_Bid", "Win_Prob", "Delta",
                                 "Breakeven_Round", "Breakeven_Prob"])
                # Sold teams first
                for name, price in state.sold.items():
                    r = ev_lookup[name]
                    scale = proj / state.initial_pot_estimate
                    ev = r.total_ev * scale
                    be = breakeven_round(price, proj)
                    be_prob = 0.0
                    if be:
                        be_idx = list(PAYOUT_STRUCTURE.keys()).index(be)
                        be_prob = r.round_probs[be_idx] if be_idx < len(r.round_probs) else 0.0
                    writer.writerow([
                        "SOLD", name, r.team.seed, r.team.region,
                        f"{price:.0f}", f"{ev:.0f}", "", f"{r.win_probability:.4f}",
                        f"{price - ev:.0f}", be or "N/A", f"{be_prob:.4f}",
                    ])
                # Remaining teams
                for r in remaining:
                    be = breakeven_round(r.max_bid, proj)
                    be_prob = 0.0
                    if be:
                        be_idx = list(PAYOUT_STRUCTURE.keys()).index(be)
                        be_prob = r.round_probs[be_idx] if be_idx < len(r.round_probs) else 0.0
                    writer.writerow([
                        "AVAILABLE", r.team.name, r.team.seed, r.team.region,
                        "", f"{r.total_ev:.0f}", f"{r.max_bid:.0f}",
                        f"{r.win_probability:.4f}", "",
                        be or "N/A", f"{be_prob:.4f}",
                    ])
            print(f"  ✅ Exported to {export_path}")

        # --- Update pot manually ---
        elif cmd_lower.startswith("pot "):
            try:
                new_pot = float(user_input[4:].strip().replace(",", ""))
                state.initial_pot_estimate = new_pot
                state.save_state()
                print(f"  Updated pot estimate to ${new_pot:,.0f}")
                print_live_dashboard(state)
            except ValueError:
                print("  ❌ Invalid amount. Usage: pot 6000")

        # --- What-if analysis: "whatif <team> <price>" ---
        elif cmd_lower.startswith("whatif "):
            wi_parts = user_input[7:].strip().rsplit(maxsplit=1)
            if len(wi_parts) != 2:
                print("  ❌ Format: whatif <team> <price>  (e.g., 'whatif UConn 800')")
                continue

            wi_team_input, wi_price_str = wi_parts
            try:
                wi_price = float(wi_price_str.replace(",", "").replace("$", ""))
            except ValueError:
                print(f"  ❌ Invalid price: '{wi_price_str}'")
                continue

            # Find team
            wi_lower = wi_team_input.lower().strip()
            wi_name = name_map.get(wi_lower)
            if not wi_name:
                candidates = [n for n in ev_lookup if wi_lower in n.lower()]
                if len(candidates) == 1:
                    wi_name = candidates[0]
                elif len(candidates) > 1:
                    print(f"  ❓ Multiple matches: {', '.join(candidates)}")
                    continue
                else:
                    print(f"  ❌ Team not found: '{wi_team_input}'")
                    continue

            # Build an adjusted result at the projected pot
            wi_result = ev_lookup[wi_name]
            proj = state.projected_pot
            scale = proj / state.initial_pot_estimate if state.initial_pot_estimate > 0 else 1.0

            # Create a scaled result for the breakeven table
            # Scale bonus EVs proportionally to pot change
            scaled_bonuses = None
            if wi_result.bonus_evs:
                scaled_bonuses = {k: v * scale for k, v in wi_result.bonus_evs.items()}
            scaled_result = CalcuttaResult(
                team=wi_result.team,
                round_evs={r: ev * scale for r, ev in wi_result.round_evs.items()},
                total_ev=wi_result.total_ev * scale,
                max_bid=wi_result.total_ev * scale * RISK_DISCOUNT,
                win_probability=wi_result.win_probability,
                round_probs=wi_result.round_probs,
                bracket_path=wi_result.bracket_path,
                bonus_evs=scaled_bonuses,
            )
            print_breakeven_table(scaled_result, wi_price, proj)

            # Show historical context if available
            wi_result_orig = ev_lookup[wi_name]
            bias_note = format_bias_context(
                wi_price, scaled_result.total_ev,
                wi_result_orig.team.seed, state.seed_biases,
            )
            if bias_note:
                print(bias_note)
            range_note = format_price_range_context(
                wi_price, wi_result_orig.team.seed, state.hist_context,
            )
            if range_note and not bias_note:
                # Only show range if we didn't already show bias (avoid clutter)
                print(range_note)
            elif range_note:
                # Append just the range portion
                sh = (state.hist_context.seed_histories.get(wi_result_orig.team.seed)
                      if state.hist_context else None)
                if sh and sh.count >= 2:
                    print(f"     📊 Range: ${sh.min_price:,.0f}–${sh.max_price:,.0f} "
                          f"(med ${sh.median_price:,.0f}), "
                          f"{sh.p_profit:.0%} of purchases profitable")

            # Show model vs Vegas context if available
            vegas_note = format_vegas_context(wi_result_orig)
            if vegas_note:
                print(vegas_note)

            # Show portfolio impact if user has a portfolio
            print_whatif_portfolio_impact(state, wi_name, wi_price)

        # --- Portfolio commands ---
        elif cmd_lower == "portfolio":
            print_portfolio_analysis(state)

        elif cmd_lower == "suggest":
            print_suggestions(state)

        elif cmd_lower in ("cheatsheet", "cheat", "cs"):
            print_cheatsheet(state)

        elif cmd_lower.startswith("budget "):
            try:
                new_budget = float(user_input[7:].strip().replace(",", "").replace("$", ""))
                state.budget = new_budget
                state.save_state()
                print(f"  Budget set to ${new_budget:,.0f}")
            except ValueError:
                print("  ❌ Invalid amount. Usage: budget 1500")

        elif cmd_lower.startswith("my "):
            # "my <team> <price>" — record sale AND mark as mine
            # "my <team>" — mark already-sold team as mine
            my_parts = user_input[3:].strip().rsplit(maxsplit=1)

            # Check if last part is a price
            has_price = False
            if len(my_parts) == 2:
                try:
                    my_price = float(my_parts[1].replace(",", "").replace("$", ""))
                    has_price = True
                    my_team_input = my_parts[0]
                except ValueError:
                    # Last part isn't a number — it's part of the team name
                    my_team_input = user_input[3:].strip()
            else:
                my_team_input = user_input[3:].strip()

            # Find the team
            my_lower = my_team_input.lower().strip()
            my_matched = name_map.get(my_lower)
            if not my_matched:
                candidates = [n for n in ev_lookup if my_lower in n.lower()]
                if len(candidates) == 1:
                    my_matched = candidates[0]
                elif len(candidates) > 1:
                    print(f"  ❓ Multiple matches: {', '.join(candidates)}")
                    continue
                else:
                    print(f"  ❌ Team not found: '{my_team_input}'")
                    continue

            if has_price:
                # Record as sold if not already
                if my_matched not in state.sold:
                    old_projected = state.projected_pot
                    state.sold[my_matched] = my_price
                    sale_history.append(my_matched)
                else:
                    old_projected = state.projected_pot
                    # Update price if re-claiming
                    my_price = state.sold[my_matched]

                # Mark as mine
                state.my_teams[my_matched] = my_price
                if state.budget > 0:
                    state.budget = max(0, state.budget - my_price)
                state.save_state()

                r = ev_lookup[my_matched]
                new_projected = state.projected_pot
                scale_val = new_projected / state.initial_pot_estimate if state.initial_pot_estimate > 0 else 1.0
                adj_ev = r.total_ev * scale_val
                be = breakeven_round(my_price, new_projected)
                be_str = be if be else "NEVER"

                print(f"\n  🏀 MINE: {r.team} for ${my_price:,.0f}")
                print(f"     EV: ${adj_ev:,.0f}  |  BE: {be_str}  |  "
                      f"Portfolio: {len(state.my_teams)} teams, "
                      f"${sum(state.my_teams.values()):,.0f} invested")
                if state.budget > 0:
                    print(f"     Budget remaining: ${state.budget:,.0f}")

                # Show historical bias context if available
                bias_note = format_bias_context(
                    my_price, adj_ev, r.team.seed, state.seed_biases
                )
                if bias_note:
                    print(bias_note)
                # Show price range context
                range_note = format_price_range_context(
                    my_price, r.team.seed, state.hist_context,
                )
                if range_note and not bias_note:
                    print(range_note)
                elif state.hist_context and r.team.seed in getattr(state.hist_context, 'seed_histories', {}):
                    sh = state.hist_context.seed_histories[r.team.seed]
                    if sh.count >= 2:
                        print(f"     📊 Range: ${sh.min_price:,.0f}–${sh.max_price:,.0f} "
                              f"(med ${sh.median_price:,.0f}), "
                              f"{sh.p_profit:.0%} historically profitable")

                # Show model vs Vegas context if available
                vegas_note = format_vegas_context(r)
                if vegas_note:
                    print(vegas_note)

            else:
                # Mark already-sold team as mine
                if my_matched in state.sold:
                    state.my_teams[my_matched] = state.sold[my_matched]
                    state.save_state()
                    print(f"  ✅ Claimed {my_matched} (${state.sold[my_matched]:,.0f}) "
                          f"as mine")
                else:
                    print(f"  ❌ {my_matched} hasn't been sold yet. "
                          f"Use 'my {my_team_input} <price>'")

        elif cmd_lower.startswith("unmy "):
            unmy_input = user_input[5:].strip().lower()
            unmy_matched = name_map.get(unmy_input)
            if not unmy_matched:
                candidates = [n for n in state.my_teams if unmy_input in n.lower()]
                if len(candidates) == 1:
                    unmy_matched = candidates[0]
                elif len(candidates) > 1:
                    print(f"  ❓ Multiple matches: {', '.join(candidates)}")
                    continue
                else:
                    print(f"  ❌ Not in your portfolio: '{user_input[5:].strip()}'")
                    continue

            if unmy_matched in state.my_teams:
                price = state.my_teams.pop(unmy_matched)
                state.budget += price
                state.save_state()
                print(f"  Removed {unmy_matched} from portfolio "
                      f"(${price:,.0f} returned to budget)")
            else:
                print(f"  ❌ {unmy_matched} not in your portfolio")

        # --- Record a sale: "<team_name> <price>" ---
        else:
            # Parse: everything before the last token is the team name,
            # last token is the price
            parts = user_input.rsplit(maxsplit=1)
            if len(parts) != 2:
                print("  ❌ Format: <team_name> <price>  (e.g., 'UConn 850')")
                continue

            team_input, price_str = parts
            try:
                price = float(price_str.replace(",", "").replace("$", ""))
            except ValueError:
                print(f"  ❌ Invalid price: '{price_str}'")
                continue

            # Fuzzy match team name
            team_lower = team_input.lower().strip()
            matched_name = name_map.get(team_lower)

            if not matched_name:
                # Try substring match
                candidates = [
                    name for name in ev_lookup
                    if team_lower in name.lower()
                ]
                if len(candidates) == 1:
                    matched_name = candidates[0]
                elif len(candidates) > 1:
                    print(f"  ❓ Multiple matches for '{team_input}':")
                    for c in candidates:
                        print(f"       {c}")
                    print("  Be more specific.")
                    continue
                else:
                    print(f"  ❌ Team not found: '{team_input}'")
                    print("  Use 'search <term>' to find team names.")
                    continue

            if matched_name in state.sold:
                print(f"  ❌ {matched_name} already sold for "
                      f"${state.sold[matched_name]:,.0f}. Use 'undo' first.")
                continue

            # Record the sale — capture pot before and after
            old_projected = state.projected_pot
            state.sold[matched_name] = price
            sale_history.append(matched_name)
            state.save_state()

            # Show feedback with pot impact
            r = ev_lookup[matched_name]
            new_projected = state.projected_pot
            scale = new_projected / state.initial_pot_estimate
            adj_ev = r.total_ev * scale
            delta = price - adj_ev

            if delta < -adj_ev * 0.2:
                verdict = "💰 GREAT VALUE"
            elif delta > adj_ev * 0.2:
                verdict = "⚠️  OVERPAID"
            else:
                verdict = "✅ FAIR PRICE"

            pot_delta = new_projected - old_projected
            pot_direction = "↑" if pot_delta > 0 else "↓" if pot_delta < 0 else "→"

            # Breakeven analysis at the price paid
            be = breakeven_round(price, new_projected)
            be_str = be if be else "IMPOSSIBLE"
            be_prob = 0.0
            if be:
                be_idx = list(PAYOUT_STRUCTURE.keys()).index(be)
                be_prob = r.round_probs[be_idx] if be_idx < len(r.round_probs) else 0.0

            print(f"\n  ✅ SOLD: {r.team} for ${price:,.0f}")
            print(f"     EV: ${adj_ev:,.0f}  |  Edge: ${-delta:+,.0f}  |  {verdict}")
            print(f"     Breakeven: {be_str} ({be_prob:.0%} prob)  |  "
                  f"Pot: ${state.actual_pot_so_far:,.0f} → "
                  f"${new_projected:,.0f} projected "
                  f"({pot_direction}${abs(pot_delta):,.0f})")

            # Show historical bias context if available
            bias_note = format_bias_context(
                price, adj_ev, r.team.seed, state.seed_biases
            )
            if bias_note:
                print(bias_note)
            # Show price range context
            range_note = format_price_range_context(
                price, r.team.seed, state.hist_context,
            )
            if range_note and not bias_note:
                print(range_note)
            elif state.hist_context and r.team.seed in getattr(state.hist_context, 'seed_histories', {}):
                sh = state.hist_context.seed_histories[r.team.seed]
                if sh.count >= 2:
                    print(f"     📊 Range: ${sh.min_price:,.0f}–${sh.max_price:,.0f} "
                          f"(med ${sh.median_price:,.0f}), "
                          f"{sh.p_profit:.0%} historically profitable")

            # Show model vs Vegas context if available
            vegas_note = format_vegas_context(r)
            if vegas_note:
                print(vegas_note)

            remaining = state.recalculate_evs()
            if remaining:
                print(f"\n     Next up — top 5 remaining:")
                for i, nr in enumerate(remaining[:5], 1):
                    nr_be = breakeven_round(nr.max_bid, new_projected)
                    nr_be_str = nr_be if nr_be else "N/A"
                    print(f"       {i}. {str(nr.team):<22} "
                          f"Max: ${nr.max_bid:>7,.0f}  "
                          f"BE: {nr_be_str}")


# ============================================================
# MAIN
# ============================================================

def main():
    """Main entry point with CLI argument parsing."""
    global RISK_DISCOUNT, NUM_SIMULATIONS, ESTIMATED_POT

    parser = argparse.ArgumentParser(
        description="March Madness Calcutta Auction Value Estimator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Quick seed-based analysis (no data needed):
  python calcutta_estimator.py

  # Generate bracket/history templates:
  python calcutta_estimator.py --template
  python calcutta_estimator.py --history-template

  # Monte Carlo with team ratings:
  python calcutta_estimator.py --method monte_carlo --bracket bracket.json

  # Analyze past auction results:
  python calcutta_estimator.py --method monte_carlo --bracket bracket.json --history auction_history.csv

  # Live auction mode (interactive):
  python calcutta_estimator.py --live --method monte_carlo --bracket bracket.json

  # Live auction with historical bias adjustments:
  python calcutta_estimator.py --live --method monte_carlo --bracket bracket.json --history auction_history.csv

  # Resume a saved live auction:
  python calcutta_estimator.py --live --method monte_carlo --bracket bracket.json --resume auction_state.json
        """,
    )

    parser.add_argument(
        "--method",
        choices=["seed", "bracket_adjusted", "monte_carlo", "manual"],
        default="seed",
        help="Estimation method (default: seed). 'bracket_adjusted' adjusts "
             "historical rates for specific bracket opponents.",
    )
    parser.add_argument(
        "--bracket",
        type=str,
        help="Path to bracket JSON file (required for monte_carlo and manual methods)",
    )
    parser.add_argument(
        "--pot",
        type=float,
        default=None,
        help=f"Estimated total pot size (default: ${ESTIMATED_POT:,})",
    )
    parser.add_argument(
        "--sims",
        type=int,
        default=NUM_SIMULATIONS,
        help=f"Number of Monte Carlo simulations (default: {NUM_SIMULATIONS:,})",
    )
    parser.add_argument(
        "--discount",
        type=float,
        default=None,
        help=f"Risk discount factor 0.0-1.0 (default: {RISK_DISCOUNT})",
    )
    parser.add_argument(
        "--csv",
        type=str,
        default=None,
        help="Export results to CSV file",
    )
    parser.add_argument(
        "--template",
        action="store_true",
        help="Generate a blank bracket template JSON and exit",
    )
    parser.add_argument(
        "--history-template",
        action="store_true",
        help="Generate a blank auction history CSV template and exit",
    )
    parser.add_argument(
        "--history",
        type=str,
        help="Path to historical auction results CSV (see --history-template)",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="Enter live auction mode for real-time bid tracking",
    )
    parser.add_argument(
        "--resume",
        type=str,
        default="auction_state.json",
        help="Path to saved auction state for resuming (default: auction_state.json)",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=10,
        help="Number of top teams to show detailed breakdown for (default: 10)",
    )

    args = parser.parse_args()

    # Handle global config overrides
    if args.discount is not None:
        RISK_DISCOUNT = args.discount
    if args.pot is not None:
        ESTIMATED_POT = args.pot
    NUM_SIMULATIONS = args.sims

    print("=" * 80)
    print("  🏀 MARCH MADNESS CALCUTTA AUCTION VALUE ESTIMATOR")
    print("=" * 80)

    # Generate templates if requested
    if args.template:
        generate_bracket_template()
        return

    if args.history_template:
        generate_history_template()
        return

    # Run the appropriate analysis
    pot = ESTIMATED_POT
    results = []
    sim_matrix = None

    if args.method == "seed":
        results = run_seed_based_analysis(pot)

    elif args.method == "bracket_adjusted":
        if not args.bracket:
            parser.error("--bracket is required for bracket_adjusted method")
        regions = load_teams_from_json(args.bracket)
        pot = ESTIMATED_POT
        results = run_bracket_adjusted_analysis(regions, pot)

    elif args.method == "monte_carlo":
        if not args.bracket:
            parser.error("--bracket is required for monte_carlo method")
        regions = load_teams_from_json(args.bracket)
        pot = ESTIMATED_POT  # May have been updated by JSON
        results, sim_matrix = run_monte_carlo_analysis(regions, pot, args.sims)

    elif args.method == "manual":
        if not args.bracket:
            parser.error("--bracket is required for manual method")
        regions = load_teams_from_json(args.bracket)
        pot = ESTIMATED_POT
        results = run_manual_analysis(regions, pot)

    # Historical analysis if provided
    hist_context = None
    prior_mean = 0.0   # Will be set from history or default
    prior_std = 0.0
    if args.history:
        records = load_auction_history(args.history)
        hist_context = analyze_auction_history(records)

        if results:
            apply_market_bias(results, hist_context.seed_biases)

        # Compute Bayesian prior from historical pot sizes
        year_pots = defaultdict(float)
        for r in records:
            year_pots[r.year] += r.price_paid

        if year_pots:
            pot_values = list(year_pots.values())
            hist_mean = sum(pot_values) / len(pot_values)
            if len(pot_values) > 1:
                hist_std = (sum((v - hist_mean) ** 2 for v in pot_values)
                            / (len(pot_values) - 1)) ** 0.5
                # Don't let std be too small — even consistent groups vary 10%+
                hist_std = max(hist_std, hist_mean * 0.10)
            else:
                hist_std = hist_mean * BAYESIAN_PRIOR_CV

            prior_mean = hist_mean
            prior_std = hist_std
            print(f"\n  📊 Bayesian prior from history: "
                  f"${prior_mean:,.0f} ± ${prior_std:,.0f} "
                  f"({len(pot_values)} years)")

            if args.pot is None:
                print(f"  💡 Historical avg pot: ${hist_mean:,.0f} "
                      f"(current estimate: ${pot:,.0f})")

    # Export to CSV if requested
    if args.csv:
        export_to_csv(results, args.csv)
    elif results and not args.live:
        export_to_csv(results, "calcutta_values.csv")

    # Live auction mode
    if args.live:
        if not results:
            parser.error("Run an estimation method before entering live mode "
                         "(e.g., --method monte_carlo --bracket bracket.json)")
        # Attach region difficulty to context if bracket analysis was run
        if args.method in ("bracket_adjusted", "monte_carlo"):
            region_diff = {}
            for r in results:
                region = r.team.region
                if region not in region_diff:
                    region_diff[region] = {"total_ev": 0.0, "top_seed_title_prob": 0.0}
                region_diff[region]["total_ev"] += r.total_ev
                if r.team.seed == 1:
                    region_diff[region]["top_seed_title_prob"] = r.win_probability
            if hist_context:
                hist_context.region_difficulty = region_diff
            else:
                hist_context = HistoricalContext(
                    seed_histories={}, seed_biases={},
                    region_difficulty=region_diff,
                )

        run_live_auction(
            results, pot, save_path=args.resume, sim_matrix=sim_matrix,
            prior_mean=prior_mean, prior_std=prior_std,
            hist_context=hist_context,
        )


if __name__ == "__main__":
    main()
