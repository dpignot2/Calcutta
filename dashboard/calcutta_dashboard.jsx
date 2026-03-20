import { useState, useEffect, useCallback, useMemo, useRef } from "react";

// ============================================================
// CONSTANTS & HISTORICAL DATA
// ============================================================

const HISTORICAL_RATES = {
  1: [0.99, 0.85, 0.67, 0.52, 0.36, 0.22],
  2: [0.94, 0.70, 0.49, 0.32, 0.19, 0.10],
  3: [0.85, 0.60, 0.36, 0.20, 0.11, 0.05],
  4: [0.79, 0.53, 0.29, 0.14, 0.07, 0.03],
  5: [0.64, 0.39, 0.18, 0.09, 0.04, 0.015],
  6: [0.63, 0.37, 0.16, 0.07, 0.03, 0.01],
  7: [0.60, 0.30, 0.12, 0.05, 0.02, 0.007],
  8: [0.50, 0.25, 0.10, 0.04, 0.015, 0.005],
  9: [0.50, 0.25, 0.09, 0.03, 0.01, 0.003],
  10: [0.37, 0.18, 0.06, 0.02, 0.008, 0.002],
  11: [0.40, 0.18, 0.07, 0.03, 0.01, 0.003],
  12: [0.36, 0.16, 0.06, 0.02, 0.007, 0.002],
  13: [0.21, 0.07, 0.02, 0.005, 0.001, 0.0003],
  14: [0.15, 0.05, 0.01, 0.003, 0.001, 0.0002],
  15: [0.07, 0.02, 0.005, 0.001, 0.0003, 0.0001],
  16: [0.01, 0.003, 0.001, 0.0002, 0.0001, 0.00003],
};

const ROUND_NAMES = ["R64", "R32", "Sweet 16", "Elite 8", "Final Four", "Championship"];
// Payouts are PER-WINNER fractions of the pot. pot × frac = payout for one winner in that round.
const DEFAULT_PAYOUTS = { R64: 0.0075, R32: 0.0134, "Sweet 16": 0.0225, "Elite 8": 0.035, "Final Four": 0.0525, Championship: 0.07 };
// Bonuses are fractions of the pot. Heartbreaker not modeled (random, can't predict who gets it).
const DEFAULT_BONUSES = { womens_champ: 0.01, biggest_blowout: 0.02, heartbreaker: 0 };
const DEFAULT_POT_SIZE = 5000;
const DEFAULT_CAP = 0;
const RISK_DISCOUNT = 0.85;
const VEGAS_DISAGREE_THRESHOLD = 1.5;
const STORAGE_KEY = "calcutta-auction-state";

// Expected margin of victory in R64 games by seed matchup (points)
const R64_EXPECTED_MARGINS = {
  "1,16": 22.0, "2,15": 17.0, "3,14": 14.0, "4,13": 11.0,
  "5,12": 5.5, "6,11": 4.5, "7,10": 3.5, "8,9": 1.5,
};

/**
 * Compute P(team loses by biggest R64 blowout) for all teams.
 * The blowout bonus is a CONSOLATION PRIZE — it goes to the team
 * that LOSES by the largest margin in R64.
 *
 * Model: Among all 32 R64 games, the loser of each game suffers some
 * expected margin of defeat. The game with the largest expected margin
 * is most likely to produce the biggest blowout.
 *
 * P(biggest blowout) = P(loses R64) × P(biggest margin | loses).
 * P(biggest margin) uses softmax over margin² (emphasizes large gaps).
 *
 * 16-seeds facing 1-seeds have ~99% chance of losing by ~22 points,
 * making them the most likely blowout bonus recipients.
 */
function computeBlowoutProbabilities(allTeams) {
  const bySeedRegion = {};
  for (const t of allTeams) bySeedRegion[`${t.region},${t.seed}`] = t;

  const regions = [...new Set(allTeams.map((t) => t.region))];
  const R64_MATCHUPS_LIST = [[1,16],[8,9],[5,12],[4,13],[6,11],[3,14],[7,10],[2,15]];

  // Collect (losingTeamName, P(loses R64), expectedMarginOfDefeat) for each side
  const gameData = [];
  for (const region of regions) {
    for (const [hi, lo] of R64_MATCHUPS_LIST) {
      const hiTeam = bySeedRegion[`${region},${hi}`];
      const loTeam = bySeedRegion[`${region},${lo}`];
      if (!hiTeam || !loTeam) continue;

      let pHiWins, margin;
      if (hiTeam.rating != null && hiTeam.rating !== 0 && loTeam.rating != null && loTeam.rating !== 0) {
        pHiWins = winProbability(effectiveRating(hiTeam), effectiveRating(loTeam));
        margin = Math.abs(hiTeam.rating - loTeam.rating) * 0.7;
      } else {
        pHiWins = historicalMatchupRate(hi, lo);
        margin = R64_EXPECTED_MARGINS[`${hi},${lo}`] || Math.max(0.5, (lo - hi) * 1.2);
      }

      // Low seed (underdog) loses → large margin expected (the typical blowout)
      gameData.push({ name: loTeam.name, pLose: pHiWins, margin });
      // High seed (favorite) loses in upset → small margin expected
      gameData.push({ name: hiTeam.name, pLose: 1 - pHiWins, margin: Math.max(1.0, margin * 0.3) });
    }
  }

  // Softmax over margin² weighted by P(lose)
  const totalWeighted = gameData.reduce((s, g) => s + g.pLose * g.margin * g.margin, 0);
  if (totalWeighted <= 0) return {};

  const probs = {};
  for (const g of gameData) {
    probs[g.name] = (probs[g.name] || 0) + (g.pLose * g.margin * g.margin) / totalWeighted;
  }
  return probs;
}

// ============================================================
// FORMAT HELPERS
// ============================================================

function fmt(n) {
  if (n == null) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}

function pct(n) {
  if (n == null) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

// ============================================================
// CALCULATION FUNCTIONS
// ============================================================

// Bracket pods: which seeds a given seed can face in each round (R64-E8)
const BRACKET_PODS = {
  1:{0:[16],1:[8,9],2:[4,5,12,13],3:[2,3,6,7,10,11,14,15]},
  16:{0:[1],1:[8,9],2:[4,5,12,13],3:[2,3,6,7,10,11,14,15]},
  8:{0:[9],1:[1,16],2:[4,5,12,13],3:[2,3,6,7,10,11,14,15]},
  9:{0:[8],1:[1,16],2:[4,5,12,13],3:[2,3,6,7,10,11,14,15]},
  5:{0:[12],1:[4,13],2:[1,8,9,16],3:[2,3,6,7,10,11,14,15]},
  12:{0:[5],1:[4,13],2:[1,8,9,16],3:[2,3,6,7,10,11,14,15]},
  4:{0:[13],1:[5,12],2:[1,8,9,16],3:[2,3,6,7,10,11,14,15]},
  13:{0:[4],1:[5,12],2:[1,8,9,16],3:[2,3,6,7,10,11,14,15]},
  6:{0:[11],1:[3,14],2:[2,7,10,15],3:[1,4,5,8,9,12,13,16]},
  11:{0:[6],1:[3,14],2:[2,7,10,15],3:[1,4,5,8,9,12,13,16]},
  3:{0:[14],1:[6,11],2:[2,7,10,15],3:[1,4,5,8,9,12,13,16]},
  14:{0:[3],1:[6,11],2:[2,7,10,15],3:[1,4,5,8,9,12,13,16]},
  7:{0:[10],1:[2,15],2:[3,6,11,14],3:[1,4,5,8,9,12,13,16]},
  10:{0:[7],1:[2,15],2:[3,6,11,14],3:[1,4,5,8,9,12,13,16]},
  2:{0:[15],1:[7,10],2:[3,6,11,14],3:[1,4,5,8,9,12,13,16]},
  15:{0:[2],1:[7,10],2:[3,6,11,14],3:[1,4,5,8,9,12,13,16]},
};

/**
 * Seed-based matchup win probability (when no ratings available).
 * P(seedA beats seedB) using logistic model calibrated to historical upset rates.
 */
function historicalMatchupRate(seedA, seedB) {
  const sA = 17 - seedA, sB = 17 - seedB;
  return 1.0 / (1.0 + Math.pow(10, -(sA - sB) / 5.5));
}

/**
 * Compute bracket-adjusted cumulative advancement probabilities.
 * Uses actual opponents (from bracket structure) instead of average seed rates.
 *
 * For R64-E8: looks up which seeds this team faces from BRACKET_PODS,
 * computes weighted win prob using opponent ratings or seed matchup rates.
 * For F4/Championship: uses top teams from other regions.
 *
 * Blends 60% bracket-specific / 40% historical to avoid over-rotating
 * on single-matchup variance.
 */
function bracketAdjustedRates(team, regionTeams, allRegions) {
  const hist = HISTORICAL_RATES[team.seed] || HISTORICAL_RATES[16];
  const bySeed = {};
  for (const t of regionTeams) bySeed[t.seed] = t;

  const hasRatings = regionTeams.every(t => t.rating != null && t.rating !== 0);
  const BRACKET_WEIGHT = 0.40; // Calibrated: historical seed rates outperform logistic model (2022-2025 backtest)

  // Compute historical conditional win probs
  const histCond = [hist[0]];
  for (let k = 1; k < 6; k++) {
    histCond.push(hist[k - 1] > 0 ? hist[k] / hist[k - 1] : 0);
  }

  const adjCond = [];

  // Rounds R64-E8 (intra-region, rounds 0-3)
  for (let roundIdx = 0; roundIdx < 4; roundIdx++) {
    const oppSeeds = (BRACKET_PODS[team.seed] || {})[roundIdx] || [];
    if (oppSeeds.length === 0) { adjCond.push(histCond[roundIdx] || 0.5); continue; }

    let totalWeight = 0, weightedP = 0;
    for (const s of oppSeeds) {
      const opp = bySeed[s];
      if (!opp) continue;
      const oppRates = HISTORICAL_RATES[s] || HISTORICAL_RATES[16];
      const w = roundIdx === 0 ? 1.0 : (oppRates[roundIdx - 1] || 0.01);
      const pWin = hasRatings && team.rating != null
        ? winProbability(effectiveRating(team), effectiveRating(opp))
        : historicalMatchupRate(team.seed, s);
      weightedP += w * pWin;
      totalWeight += w;
    }
    const bracketP = totalWeight > 0 ? weightedP / totalWeight : 0.5;
    const h = histCond[roundIdx] || 0.5;
    adjCond.push(Math.max(0.001, Math.min(0.999, BRACKET_WEIGHT * bracketP + (1 - BRACKET_WEIGHT) * h)));
  }

  // Final Four (round 4): top teams from paired region
  if (allRegions) {
    const regionNames = Object.keys(allRegions);
    let myIdx = -1;
    for (let i = 0; i < regionNames.length; i++) {
      if (allRegions[regionNames[i]].some(t => t.name === team.name)) { myIdx = i; break; }
    }
    if (myIdx >= 0) {
      const oppIdx = myIdx % 2 === 0 ? myIdx + 1 : myIdx - 1;
      if (oppIdx >= 0 && oppIdx < regionNames.length) {
        const oppRegion = allRegions[regionNames[oppIdx]];
        let totalW = 0, wP = 0;
        for (const opp of oppRegion.slice(0, 4)) {
          const oppRates = HISTORICAL_RATES[opp.seed] || HISTORICAL_RATES[16];
          const w = oppRates[3] || 0.01;
          const pWin = (hasRatings && team.rating != null && opp.rating != null)
            ? winProbability(effectiveRating(team), effectiveRating(opp))
            : historicalMatchupRate(team.seed, opp.seed);
          wP += w * pWin; totalW += w;
        }
        const bracketP = totalW > 0 ? wP / totalW : 0.5;
        adjCond.push(Math.max(0.001, Math.min(0.999, BRACKET_WEIGHT * bracketP + (1 - BRACKET_WEIGHT) * (histCond[4] || 0.5))));
      } else {
        adjCond.push(histCond[4] || 0.5);
      }

      // Championship (round 5): top teams from other 2 regions
      const otherRegions = regionNames.filter((_, i) => i !== myIdx && i !== oppIdx);
      let totalW = 0, wP = 0;
      for (const rn of otherRegions) {
        for (const opp of (allRegions[rn] || []).slice(0, 2)) {
          const oppRates = HISTORICAL_RATES[opp.seed] || HISTORICAL_RATES[16];
          const w = oppRates[4] || 0.01;
          const pWin = (hasRatings && team.rating != null && opp.rating != null)
            ? winProbability(effectiveRating(team), effectiveRating(opp))
            : historicalMatchupRate(team.seed, opp.seed);
          wP += w * pWin; totalW += w;
        }
      }
      const bracketP = totalW > 0 ? wP / totalW : 0.5;
      adjCond.push(Math.max(0.001, Math.min(0.999, BRACKET_WEIGHT * bracketP + (1 - BRACKET_WEIGHT) * (histCond[5] || 0.5))));
    } else {
      adjCond.push(histCond[4] || 0.5);
      adjCond.push(histCond[5] || 0.5);
    }
  } else {
    adjCond.push(histCond[4] || 0.5);
    adjCond.push(histCond[5] || 0.5);
  }

  // Chain conditionals into cumulative probabilities
  const adjCum = [];
  let running = 1.0;
  for (let k = 0; k < 6; k++) {
    running *= adjCond[k] || 0;
    adjCum.push(running);
  }
  return adjCum;
}

/**
 * Bayesian pot estimation using Normal-Normal conjugate update.
 * Each sale implies a pot size (collected_so_far / fraction_sold).
 * These are noisy observations. Prior is the base pot estimate.
 *
 * Returns { mean, std, confidence } for the posterior pot estimate.
 */
const BAYESIAN_PRIOR_CV = 0.30; // 30% prior uncertainty — wide enough to let data speak quickly
const BAYESIAN_OBS_CV = 0.25;   // 25% observation noise — high-EV teams give strong signals

function bayesianPotUpdate(priorMean, sold, allTeams, evShares) {
  const nSold = Object.keys(sold).length;
  const nTotal = allTeams.length || 64;
  const totalCollected = Object.values(sold).reduce((s, v) => s + v, 0);
  if (nSold === 0) return { mean: priorMean, std: priorMean * BAYESIAN_PRIOR_CV, confidence: 0, ciLow: 0, ciHigh: 0 };

  // All teams sold — pot is known exactly, no estimation needed
  if (nSold >= nTotal) {
    return { mean: totalCollected, std: 0, confidence: 1, ciLow: totalCollected, ciHigh: totalCollected };
  }

  const priorStd = priorMean * BAYESIAN_PRIOR_CV;
  const obsStd = priorMean * BAYESIAN_OBS_CV;

  // Per-sale implied pots: each sale implies a total pot based on
  // that team's share of total EV. Higher-EV teams give more
  // informative observations (e.g. a 1-seed selling for $1,200
  // implies pot more precisely than a 16-seed selling for $5).
  const observations = [];
  for (const [name, price] of Object.entries(sold)) {
    const share = evShares[name];
    if (share && share > 0.001) {
      observations.push(price / share);
    }
  }

  // Fallback: simple extrapolation if no per-team EV data available
  if (observations.length === 0) {
    observations.push(totalCollected / (nSold / nTotal));
  }

  const tau0Sq = priorStd * priorStd;
  const sigmaSq = obsStd * obsStd;
  const n = observations.length;
  const sumX = observations.reduce((s, v) => s + v, 0);

  const postPrecision = 1.0 / tau0Sq + n / sigmaSq;
  const postVar = 1.0 / postPrecision;
  const postMean = postVar * (priorMean / tau0Sq + sumX / sigmaSq);
  const postStd = Math.sqrt(postVar);
  const confidence = Math.min(1.0, nSold / nTotal * 1.5);

  // 90% credible interval
  const ciLow = postMean - 1.645 * postStd;
  const ciHigh = postMean + 1.645 * postStd;

  // Floor at actual collected (pot can't be less than what's already in)
  return { mean: Math.max(postMean, totalCollected), std: postStd, confidence, ciLow, ciHigh };
}

function vegasImpliedProb(odds) {
  if (odds == null) return null;
  return odds > 0 ? 100.0 / (odds + 100.0) : Math.abs(odds) / (Math.abs(odds) + 100.0);
}

function computeTeamAnalysis(team, pot, payouts, bonuses, allTeams, blowoutProbs) {
  // Build region lookup for bracket path computation
  const allRegions = {};
  for (const t of allTeams) {
    if (!allRegions[t.region]) allRegions[t.region] = [];
    allRegions[t.region].push(t);
  }
  const regionTeams = allRegions[team.region] || [team];

  // ── Source 1: Bracket-adjusted rates (opponent-aware, from ratings) ──
  const bracketProbs = bracketAdjustedRates(team, regionTeams, allRegions);
  while (bracketProbs.length < 6) bracketProbs.push(0);

  // ── Source 2: KenPom round probabilities (if provided) ──
  const kenpomProbs = team.kenpom_probs && team.kenpom_probs.length >= 6
    ? [...team.kenpom_probs] : null;

  // ── Build base model: KenPom + bracket-adjusted ──
  let baseProbs;
  if (kenpomProbs) {
    // Calibration (2022-2025, 121 R32 games, 123 R64 games):
    //   R64: Our logistic model beats KP (log loss 0.4700 vs 0.5819)
    //   R32: Pure KP best (0.5452), especially for underdogs (4.9% vs 16.3% error)
    //   S16+: KP well-calibrated (within 5% per bucket)
    // → R64: our model, R32: 90% KP / 10% bracket, S16+: 70% KP / 30% bracket
    baseProbs = bracketProbs.map((bp, i) => {
      if (i === 0) return bp;                           // R64: our model
      if (i === 1) return kenpomProbs[i] * 0.9 + bp * 0.1; // R32: 90/10 KP
      return kenpomProbs[i] * 0.7 + bp * 0.3;           // S16+: 70/30 KP
    });
  } else {
    baseProbs = [...bracketProbs];
  }

  // ── Vegas: computed for CI display and women's bonus only, NOT blended into probabilities ──
  // Calibration showed KenPom round probs are well-calibrated for S16+.
  // Vegas anchor weight was never calibrated (no historical odds available).
  // Keeping it out avoids adding noise to a proven signal.
  let deViggedTitle = null;
  if (team.vegas_odds != null) {
    const rawP = vegasImpliedProb(team.vegas_odds);
    const totalImplied = allTeams.reduce((s, t) => {
      const p = t.vegas_odds != null ? vegasImpliedProb(t.vegas_odds) : 0;
      return s + (p || 0);
    }, 0);
    const vig = totalImplied > 1.0 ? totalImplied : 1.0;
    deViggedTitle = rawP / vig;
  }

  // No Vegas anchoring — probabilities come purely from KenPom ensemble + bracket model
  let finalProbs = [...baseProbs];

  // ── KenPom Profile Modifiers ──
  // Applied as late-round probability adjustments based on team profile

  const profile = { champProfile: false, lopsided: false, lucky: false, balanced: false,
                     returning: false, overseeded: false, underseeded: false, eliteDefense: false };
  let profileAdj = 1.0; // Multiplicative adjustment for F4/Championship conditionals

  // 1. Championship Profile: top 25 in both AdjO rank and AdjD rank
  //    22 of 23 champions since 2002 had this. Binary qualifier.
  if (team.adj_o_rank != null && team.adj_d_rank != null) {
    profile.champProfile = team.adj_o_rank <= 25 && team.adj_d_rank <= 25;
    if (!profile.champProfile) {
      // Outside championship profile: penalize deep run probability
      const worstRank = Math.max(team.adj_o_rank, team.adj_d_rank);
      if (worstRank > 50) profileAdj *= 0.80;       // Major imbalance
      else if (worstRank > 25) profileAdj *= 0.85;   // Mild imbalance

      // Elite defense without championship profile: display badge only.
      // KP round probs already factor defensive efficiency into predictions.
      // Residual signal (+0.50 rounds) exists but sample is small (n=25)
      // and we're testing on training data — overfitting risk.
      if (team.adj_d_rank <= 15) {
        profile.eliteDefense = true; // Badge only, no profileAdj
      }
    } else {
      profileAdj *= 1.12; // Calibrated: 24% F4 rate WITH profile vs 0% WITHOUT
    }
  }

  // 2. Tempo note: extreme pace teams tracked for display only, no probability adjustment.
  //    The "trapezoid of excellence" was removed because 67% of tournament teams qualified
  //    (AdjEM > 15 is too loose), making the +3% boost meaningless noise.
  //    The championship profile (O≤25, D≤25) is calibrated and captures the real signal.

  // 3. Luck factor: display-only flag, NO probability adjustment.
  //    Backtest (2022-2025): lucky teams average +$31 profit in Jay's auction.
  //    The group underprices "lucky" teams, so penalizing them costs us edge.
  //    Unlucky teams average -$112 profit — they're overpriced by the group.
  if (team.luck != null) {
    if (team.luck > 0.04) {
      profile.lucky = true; // Display flag only — no EV adjustment
    }
  }

  // 4. Offensive/defensive balance
  //    Both AdjO and AdjD rank inside top 40 AND gap ≤ 20 = truly balanced
  //    Can win shootouts AND grind-it-out games
  //    Gap check prevents O:#1 D:#36 from being "balanced" (that's offense-heavy)
  if (team.adj_o_rank != null && team.adj_d_rank != null) {
    const odGap = Math.abs(team.adj_o_rank - team.adj_d_rank);
    profile.balanced = team.adj_o_rank <= 40 && team.adj_d_rank <= 40 && odGap <= 20;
    profile.lopsided = (team.adj_o_rank <= 15 && team.adj_d_rank > 60) ||
                       (team.adj_d_rank <= 15 && team.adj_o_rank > 60);
    if (profile.lopsided) profileAdj *= 0.88; // Calibrated: avg 1.5 rounds vs balanced 2.4 (2022-2025)
    else if (profile.balanced) profileAdj *= 1.05; // Calibrated: 43% S16+ vs 28% baseline
  }

  // 5. Source disagreement: Barttorvik vs KenPom
  //    When both sources provided data, check for large gaps
  profile.sourceDisagree = null;

  // 6. Returning tournament team: display badge only.
  //    KP already rates returning teams higher (0.0275 vs 0.0044 champ prob).
  //    Controlled residual (+0.49 rounds) exists but small sample (n=54),
  //    tested on training data — overfitting risk. Badge is useful context for bidding.
  if (team.returning) {
    profile.returning = true; // Badge only, no profileAdj
  }

  // 7. Overseeded/Underseeded: display badge only.
  //    KenPom round probs are COMPUTED from team ratings vs bracket opponents.
  //    A 9-seed ranked #25 already gets higher KP probs than a typical 9.
  //    Any EV adjustment here double-counts what KP probs already capture.
  if (team.seedMismatch != null) {
    if (team.seedMismatch < -10) {
      profile.overseeded = true; // Badge only
    } else if (team.seedMismatch > 14) {
      profile.underseeded = true; // Badge only
    }
  }

  // 8. Source disagreement: Barttorvik vs KenPom
  if (team.torvik_rating != null && team.kenpom_rating != null) {
    const emGap = Math.abs(team.torvik_rating - team.kenpom_rating);
    const oRankGap = (team.torvik_adj_o_rank && team.kenpom_adj_o_rank)
      ? Math.abs(team.torvik_adj_o_rank - team.kenpom_adj_o_rank) : 0;
    const dRankGap = (team.torvik_adj_d_rank && team.kenpom_adj_d_rank)
      ? Math.abs(team.torvik_adj_d_rank - team.kenpom_adj_d_rank) : 0;
    if (emGap >= 3.0 || oRankGap >= 20 || dRankGap >= 20) {
      profile.sourceDisagree = {
        emGap: Math.round(emGap * 10) / 10,
        torvik: team.torvik_rating,
        kenpom: team.kenpom_rating,
        oRankGap, dRankGap,
        torvikORank: team.torvik_adj_o_rank, kenpomORank: team.kenpom_adj_o_rank,
        torvikDRank: team.torvik_adj_d_rank, kenpomDRank: team.kenpom_adj_d_rank,
      };
    }
  }

  // Apply profile adjustment to later rounds (F4, Championship)
  // Like Vegas anchoring, concentrate adjustment in later rounds
  if (Math.abs(profileAdj - 1.0) > 0.001) {
    const cond = [finalProbs[0]];
    for (let i = 1; i < 6; i++) cond.push(finalProbs[i - 1] > 0 ? finalProbs[i] / finalProbs[i - 1] : 0);
    // Apply with increasing weight in later rounds: [0, 0, 0.5, 1, 1.5, 2] → total 5
    const profWeights = [0, 0, 0.5, 1, 1.5, 2];
    const profTotal = profWeights.reduce((s, w) => s + w, 0);
    const logPAdj = Math.log(profileAdj);
    const adjCond = cond.map((c, i) => {
      const share = profWeights[i] / profTotal;
      return Math.min(0.999, Math.max(0.001, c * Math.exp(logPAdj * share)));
    });
    finalProbs = [adjCond[0]];
    for (let i = 1; i < 6; i++) finalProbs.push(finalProbs[i - 1] * adjCond[i]);
  }

  // Round EVs — payouts are per-winner fractions, so pot × frac = payout per winner
  const roundEvs = {};
  let totalEv = 0;
  ROUND_NAMES.forEach((rn, i) => {
    const frac = payouts[rn] || 0;
    const perTeam = pot * frac;
    const ev = (finalProbs[i] || 0) * perTeam;
    roundEvs[rn] = ev;
    totalEv += ev;
  });

  // Bonus EVs
  let bonusEv = 0;
  const bonusEvs = {};
  if (team.womens_win_prob > 0 && bonuses.womens_champ) {
    const wEv = team.womens_win_prob * pot * bonuses.womens_champ;
    bonusEvs.womens_champ = wEv;
    bonusEv += wEv;
  }
  if (bonuses.biggest_blowout) {
    const blowoutProb = (blowoutProbs && blowoutProbs[team.name]) || 0;
    const bEv = blowoutProb * pot * bonuses.biggest_blowout;
    bonusEvs.biggest_blowout = bEv;
    bonusEv += bEv;
  }

  totalEv += bonusEv;

  const modelTitleProb = baseProbs[5] || 0;

  // ── EV Confidence Interval ──
  // Combines two sources of uncertainty:
  //   1. Pot uncertainty (from Bayesian CI — passed in by caller)
  //   2. Probability model spread (disagreement between sources)
  //
  // Compute per-round "pessimistic" and "optimistic" probs from available sources,
  // then derive evLow/evHigh. Pot CI scaling applied by the caller.

  // Collect available probability sets
  const probSets = [bracketProbs];
  if (kenpomProbs) probSets.push(kenpomProbs);
  // Vegas-implied round probs aren't available per-round, but we can create
  // an optimistic/pessimistic envelope from existing sources

  // Pessimistic: min of each source at each round
  // Optimistic: max of each source at each round
  const probLow = [];
  const probHigh = [];
  for (let i = 0; i < 6; i++) {
    let lo = finalProbs[i], hi = finalProbs[i];
    for (const ps of probSets) {
      if (ps[i] < lo) lo = ps[i];
      if (ps[i] > hi) hi = ps[i];
    }
    // If Vegas title prob is available, widen the championship end
    if (i === 5 && deViggedTitle != null) {
      lo = Math.min(lo, deViggedTitle);
      hi = Math.max(hi, deViggedTitle);
    }
    // Apply profile uncertainty: ±half the profile adjustment
    if (Math.abs(profileAdj - 1.0) > 0.005 && i >= 2) {
      const profHalf = Math.abs(profileAdj - 1.0) / 2;
      lo = lo * (1 - profHalf);
      hi = hi * (1 + profHalf);
    }
    probLow.push(Math.max(0, lo));
    probHigh.push(Math.min(1, hi));
  }

  // Compute EV at pessimistic and optimistic probs (same pot — pot CI applied by caller)
  let evLow = 0, evHigh = 0;
  ROUND_NAMES.forEach((rn, i) => {
    const frac = payouts[rn] || 0;
    const perTeam = pot * frac;
    evLow += (probLow[i] || 0) * perTeam;
    evHigh += (probHigh[i] || 0) * perTeam;
  });
  evLow += bonusEv * 0.8;   // Bonuses have less uncertainty but aren't exact
  evHigh += bonusEv * 1.2;

  // Probability spread ratio (for display — how much sources disagree)
  const probSpread = (finalProbs[5] || 0) > 0.0001
    ? (probHigh[5] - probLow[5]) / finalProbs[5]
    : 0;

  return {
    team,
    roundEvs,
    totalEv,
    maxBid: totalEv * RISK_DISCOUNT,
    evLow,
    evHigh,
    probLow,
    probHigh,
    probSpread,
    winProb: finalProbs[5] || 0,
    roundProbs: finalProbs,
    modelTitleProb,
    vegasTitleProb: deViggedTitle,
    blendedTitleProb: finalProbs[5] || 0,
    kenpomTitleProb: kenpomProbs ? kenpomProbs[5] : null,
    bonusEvs,
    bonusEv,
    profile,
    profileAdj,
  };
}

function breakEvenRound(price, pot, probs, payouts, bonuses) {
  const winLabels = ["Win R64", "Win R32", "Win S16", "Win E8", "Win F4", "Win Final"];
  let cumPayout = 0;
  for (let i = 0; i < ROUND_NAMES.length; i++) {
    const rn = ROUND_NAMES[i];
    const frac = payouts[rn] || 0;
    cumPayout += pot * frac;
    if (cumPayout >= price) return { round: winLabels[i], roundName: rn, prob: probs[i] || 0, index: i };
  }
  return { round: "Beyond", roundName: "Beyond", prob: 0, index: -1 };
}

/**
 * Estimate what a team will sell for based on seed pricing history + brand premium.
 * Returns { expectedPrice, expectedEdge } where edge = EV - expectedPrice.
 * This is the key metric for queue decisions — raw EV doesn't matter,
 * only the gap between EV and what your group will actually pay.
 */
function estimateSellingPrice(teamName, seed, ev, pot, seedAvgFrac, schoolPremiums) {
  if (!seedAvgFrac || !pot) return { expectedPrice: ev, expectedEdge: 0 };
  const baseFrac = seedAvgFrac[seed] || 0;
  let expectedPrice = baseFrac * pot;
  // Apply brand premium if available
  const bp = getSchoolBrandPremium(teamName, schoolPremiums);
  if (bp) expectedPrice *= (1 + bp.avgPremium);
  // Floor at $5 (even 16-seeds sell for something)
  expectedPrice = Math.max(5, expectedPrice);
  return { expectedPrice: Math.round(expectedPrice), expectedEdge: Math.round(ev - expectedPrice) };
}

/**
 * Look up a team's brand premium from history data.
 * Returns { premium, loyalBidder, count } or null if not found.
 * Normalizes names: strips *, play-in opponents, trims.
 */
function getSchoolBrandPremium(teamName, schoolPremiums) {
  if (!schoolPremiums || !teamName) return null;
  let name = teamName.replace(/\*/g, "").trim();
  if (name.includes("/")) name = name.split("/")[0].trim();

  // Hardcoded aliases for history name mismatches
  const BRAND_ALIASES = {
    "Miami (FL)": "Miami",
    "Miami FL": "Miami",
  };
  if (BRAND_ALIASES[name] && schoolPremiums[BRAND_ALIASES[name]]) {
    return schoolPremiums[BRAND_ALIASES[name]];
  }

  // Direct match
  if (schoolPremiums[name]) return schoolPremiums[name];
  // Normalized: strip periods
  const norm = name.replace(/\./g, "").toLowerCase();
  let bestMatch = null, bestLen = 0;
  for (const [key, val] of Object.entries(schoolPremiums)) {
    const keyNorm = key.replace(/\./g, "").replace(/\*/g, "").toLowerCase();
    if (keyNorm === norm) return val; // exact normalized match
    if (keyNorm.startsWith(norm) || norm.startsWith(keyNorm)) {
      const lenDiff = Math.abs(keyNorm.length - norm.length);
      const overlap = Math.min(keyNorm.length, norm.length);
      if (lenDiff <= 2 && overlap > bestLen) { bestLen = overlap; bestMatch = val; }
    }
  }
  return bestMatch;
}

/**
 * Compute a per-team bidding strategy based on brand premium,
 * loyal bidders, seed tier, auction phase, portfolio state,
 * remaining value pool, and budget pressure.
 *
 * Returns: { mode, emoji, color, headline, detail, entryPrice, contextNote }
 * Modes: SNIPE, PATIENCE, DECOY, PASS, VALUE, TARGET, CAUTION
 */
function getBiddingStrategy(team, result, schoolPremiums, nSold, nMyTeams, maxBid, ctx) {
  if (!team || !result) return null;

  const seed = team.seed;
  const ev = result.totalEv;
  const bp = getSchoolBrandPremium(team.name, schoolPremiums);
  const hasBrandTax = bp && bp.avgPremium > 0.2;
  const isStealth = bp && bp.avgPremium < -0.15;
  const loyalBidder = bp?.loyalBidder || null;
  const isProfileStrong = result.profile?.champProfile;
  const isProfileWeak = result.profile?.lopsided || result.profile?.lucky;

  // Auction phase
  const phase = nSold < 16 ? "early" : nSold < 42 ? "mid" : "late";

  // Visibility: after buying 2+ teams, you're a target
  const highVisibility = nMyTeams >= 2;

  // ── Market context multipliers ──
  // ctx: { remainingPosEV, totalUnsoldEV, bidderTotals, softCap }
  const remainingPosEV = ctx?.remainingPosEV ?? 30;
  const bidderTotals = ctx?.bidderTotals ?? {};
  const softCap = ctx?.softCap ?? 600;

  // Scarcity: how many good teams are left?
  let scarcityMult = 1.0;
  let scarcityNote = "";
  if (remainingPosEV <= 3) {
    scarcityMult = 1.35;
    scarcityNote = "Only " + remainingPosEV + " positive-EV teams left — bid aggressively.";
  } else if (remainingPosEV <= 6) {
    scarcityMult = 1.20;
    scarcityNote = remainingPosEV + " positive-EV teams remain — value drying up.";
  } else if (remainingPosEV <= 10) {
    scarcityMult = 1.10;
    scarcityNote = remainingPosEV + " positive-EV teams remain.";
  } else {
    scarcityMult = 1.0;
  }

  // Competitor cap analysis: how many rivals can still bid at this price?
  // Soft cap: you CAN exceed $600, but the team that puts you over is your last.
  let competitorMult = 1.0;
  let competitorNote = "";
  const bidders = Object.values(bidderTotals);
  let canBidFreely = 0;
  let lastTeamBid = 0;
  let tappedOut = 0;
  if (bidders.length > 0) {
    const currentPrice = maxBid;
    for (const b of bidders) {
      const spent = b.spent || 0;
      if (spent >= softCap) {
        tappedOut++;
      } else if (spent + currentPrice > softCap) {
        lastTeamBid++; // This would be their final team
      } else {
        canBidFreely++;
      }
    }
    const totalActive = canBidFreely + lastTeamBid;

    if (totalActive <= 3) {
      competitorMult = 0.85; // Very few competitors — you can lowball
      competitorNote = "Only " + totalActive + " bidders can still compete (" + tappedOut + " tapped out). Lowball opportunity.";
    } else if (lastTeamBid >= 3 && lastTeamBid > canBidFreely) {
      competitorMult = 1.10; // Lots of "last team" bidders — they'll bid aggressively
      competitorNote = lastTeamBid + " bidders going all-in (last team), " + canBidFreely + " bidding freely. Expect aggressive competition.";
    } else if (tappedOut >= bidders.length * 0.4) {
      competitorMult = 0.90; // 40%+ of field is done — less competition
      competitorNote = tappedOut + "/" + bidders.length + " bidders tapped out. Thinning field.";
    } else {
      competitorNote = canBidFreely + " bidding freely, " + lastTeamBid + " on last team, " + tappedOut + " done.";
    }
  }

  // Portfolio need: urgency to get on the board
  let portfolioMult = 1.0;
  let portfolioNote = "";
  if (nMyTeams === 0 && nSold > 10) {
    portfolioMult = 1.15;
    portfolioNote = "You own 0 teams — need to get on the board.";
  } else if (nMyTeams === 0 && nSold > 5) {
    portfolioMult = 1.08;
    portfolioNote = "No teams yet — don't wait too long.";
  } else if (nMyTeams >= 3) {
    portfolioMult = 0.95;
    portfolioNote = "3+ teams owned — be selective.";
  }

  // Market temperature: adjust opening bids based on group pricing behavior
  // Does NOT affect maxBid — that's EV-based and doesn't change.
  // Hot market: open LOWER — don't set a bidding floor for chasers.
  // Cold market: no price change — the edge is bidding MORE OFTEN, not higher.
  let marketMult = 1.0;
  let marketNote = "";
  const marketRatio = ctx?.marketTemp;
  if (marketRatio != null && marketRatio !== 0) {
    if (marketRatio > 1.15) {
      marketMult = 0.85; // Hot: open much lower, don't feed the frenzy
      marketNote = "🔥 Hot market — open low, don't set the floor for overpayers.";
    } else if (marketRatio > 1.05) {
      marketMult = 0.92; // Warm: slightly lower openers
      marketNote = "📈 Warm market — trim your openers, stay under max.";
    } else if (marketRatio < 0.85) {
      // Cold: don't raise openers. The edge is frequency, not price.
      marketNote = "❄️ Cold market — bid on MORE teams at these prices. Lowball and accumulate.";
    } else if (marketRatio < 0.95) {
      marketNote = "📉 Cool market — good conditions. Keep lowballing.";
    }
  }

  // Queue intelligence: if we know the auction order, give precise timing advice
  let queueMult = 1.0;
  let queueAdvice = null;
  const upcoming = ctx?.upcoming;
  const allResults = ctx?.allResults;
  const allTeamsCtx = ctx?.allTeamsRef;
  const ctxSeedAvgFrac = ctx?.seedAvgFrac;
  const ctxSchoolPremiums = ctx?.schoolPremiums;
  const ctxPot = ctx?.pot || 12200;

  // Estimate current team's expected edge
  const currentEst = estimateSellingPrice(team.name, seed, ev, ctxPot, ctxSeedAvgFrac, ctxSchoolPremiums);
  const currentEdge = currentEst.expectedEdge;

  if (upcoming && upcoming.length > 0 && allResults && allTeamsCtx) {
    // Resolve upcoming teams with expected edge (EV minus what group will likely pay)
    const upcomingData = [];
    for (const item of upcoming.slice(0, 8)) {
      const t = allTeamsCtx.find(x => x.name === item.name) ||
        allTeamsCtx.find(x => x.name.toLowerCase().replace(/\./g, "") === item.name.toLowerCase().replace(/\./g, ""));
      if (t && allResults[t.name]) {
        const uEv = allResults[t.name].totalEv;
        const est = estimateSellingPrice(t.name, t.seed, uEv, ctxPot, ctxSeedAvgFrac, ctxSchoolPremiums);
        upcomingData.push({ name: t.name, ev: uEv, seed: t.seed, edge: est.expectedEdge,
          expectedPrice: est.expectedPrice, champProfile: allResults[t.name].profile?.champProfile });
      }
    }

    if (upcomingData.length > 0) {
      // Key change: decisions based on EDGE (EV - expected price), not raw EV
      const betterEdge = upcomingData.filter(u => u.edge > currentEdge * 1.5 && u.edge > 50);
      const whaleNext = upcomingData.slice(0, 3).find(u => u.ev > 400 && u.edge > 50);
      const nextFewAvgEdge = upcomingData.slice(0, 3).reduce((s, u) => s + u.edge, 0) / Math.min(3, upcomingData.length);
      const drySpellAhead = upcomingData.slice(0, 4).every(u => u.edge < 20);

      // Whale ahead: a big team is coming that cap-bidders will chase
      if (whaleNext && lastTeamBid >= 2) {
        const whaleIdx = upcomingData.indexOf(whaleNext);
        const afterWhale = upcomingData[whaleIdx + 1];
        queueAdvice = "🐋 WHALE AHEAD: " + whaleNext.name + " (EV $" + Math.round(whaleNext.ev) +
          ", likely sells ~$" + whaleNext.expectedPrice + ", edge +$" + whaleNext.edge + ") is coming in " +
          (whaleIdx + 1) + " team" + (whaleIdx > 0 ? "s" : "") + ". " +
          lastTeamBid + " last-team bidders will fight over it — " +
          "expect them to tap out after." +
          (afterWhale ? " " + afterWhale.name + " (edge +$" + afterWhale.edge + ") could be a bargain right after." : "");
        if (currentEdge < whaleNext.edge * 0.5) queueMult *= 0.90;

      // Better edge coming soon
      } else if (betterEdge.length > 0 && betterEdge[0].edge > currentEdge * 2) {
        const best = betterEdge[0];
        const idx = upcomingData.indexOf(best);
        queueAdvice = "⏳ BETTER EDGE COMING: " + best.name + " (edge +$" + best.edge +
          " vs this team's +$" + currentEdge +
          (best.champProfile ? ", 🏆 champ profile" : "") + ") is " + (idx + 1) + " teams away. " +
          "Save your budget for the bigger edge.";
        queueMult *= 0.92;

      // Dry spell: no good edges ahead — this is the best for a while
      } else if (drySpellAhead && currentEdge > 30) {
        queueAdvice = "🏜️ DRY SPELL: Next " + Math.min(4, upcomingData.length) + " teams all have <$20 expected edge. " +
          "This team's +$" + currentEdge + " edge is the best for a while — bid with conviction.";
        queueMult *= 1.08;

      // Current team has the best edge of the next batch
      } else if (currentEdge > nextFewAvgEdge * 1.8 && currentEdge > 30) {
        queueAdvice = "⭐ BEST EDGE IN BATCH: +$" + currentEdge + " expected edge vs next few (avg +$" +
          Math.round(nextFewAvgEdge) + "). Don't let this one slip.";
        queueMult *= 1.05;
      }
    }
  }

  // Combined context multiplier (applied to base entry prices, NOT maxBid)
  const contextMult = scarcityMult * competitorMult * portfolioMult * marketMult * queueMult;
  // Build context detail string
  const contextParts = [scarcityNote, competitorNote, portfolioNote, marketNote].filter(Boolean);
  const contextNote = contextParts.length > 0 ? contextParts.join(" ") : null;
  // Queue advice is displayed separately (more prominent) so it's not in contextNote

  /**
   * Apply context multiplier to a base entry fraction.
   * Entry is clamped to never exceed maxBid.
   */
  function entry(baseFrac) {
    return Math.min(Math.round(ev * baseFrac * contextMult), Math.round(maxBid));
  }

  // ── PASS: terrible value seeds ──
  if (seed >= 14 && ev < 30) {
    return {
      mode: "PASS", emoji: "🚫", color: "#ef4444",
      headline: "PASS — Let the lottery buyers have this one",
      detail: `Seed ${seed} with $${ev.toFixed(0)} EV. Historically sells for ${seed >= 16 ? "20x" : "2-3x"} fair value in your group. Save your budget.`,
      entryPrice: null, contextNote, queueAdvice,
    };
  }

  // ── CAUTION: profile is terrible (lopsided + lucky) ──
  if (isProfileWeak && !isProfileStrong && seed <= 6) {
    const ep = Math.min(Math.round(maxBid * 0.75 * contextMult), Math.round(maxBid));
    return {
      mode: "CAUTION", emoji: "⚠️", color: "#f97316",
      headline: "CAUTION — Profile red flags, don't overpay",
      detail: `${result.profile?.lopsided ? "Lopsided" : ""}${result.profile?.lucky ? (result.profile?.lopsided ? " + Lucky" : "Lucky") : ""} profile. ` +
        `This team looks better on paper than they'll play in March. Discount your bid — stay under $${ep}.`,
      entryPrice: ep, contextNote, queueAdvice,
    };
  }

  // ── PATIENCE: name tax teams with loyal bidder ──
  if (hasBrandTax && loyalBidder) {
    return {
      mode: "PATIENCE", emoji: "⏳", color: "#a78bfa",
      headline: `PATIENCE — ${loyalBidder} will chase this`,
      detail: `${team.name} carries a +${(bp.avgPremium * 100).toFixed(0)}% name tax. ${loyalBidder} has bought them before and will bid emotionally. ` +
        `Let them open, enter only if price stays under $${maxBid.toFixed(0)}.` +
        (highVisibility ? " You're visible — don't get into a bidding war that others pile onto." : ""),
      entryPrice: Math.round(maxBid), contextNote, queueAdvice,
    };
  }

  // ── PATIENCE: premium seeds (1-2) in early auction ──
  if (seed <= 2 && phase === "early") {
    return {
      mode: "PATIENCE", emoji: "⏳", color: "#a78bfa",
      headline: "PATIENCE — Let the bidding develop",
      detail: `Everyone has full budgets and ${seed === 1 ? "1-seeds" : "2-seeds"} draw emotional bids. ` +
        `Let others open. Enter late at a precise number ($${maxBid.toFixed(0)}). ` +
        `Stop instantly at your max — don't get anchored by the escalation.` +
        (hasBrandTax ? ` Brand premium: +${(bp.avgPremium * 100).toFixed(0)}%.` : ""),
      entryPrice: Math.round(maxBid), contextNote, queueAdvice,
    };
  }

  // ── SNIPE: stealth value, mid seeds, no loyalty ──
  if (isStealth && !loyalBidder && seed >= 4 && seed <= 11) {
    const ep = entry(0.50);
    return {
      mode: "SNIPE", emoji: "🎯", color: "#22c55e",
      headline: "SNIPE — Under the radar, bid fast",
      detail: `${team.name} sells ${Math.abs(bp.avgPremium * 100).toFixed(0)}% below avg for seed ${seed}. No one is loyal to this team. ` +
        `Open at $${ep} or bid quickly after someone opens. ` +
        `Don't wait — these slip through when nobody's paying attention.`,
      entryPrice: ep, contextNote, queueAdvice,
    };
  }

  // ── SNIPE: 6-9 seeds (your group's biggest edge) ──
  if (seed >= 6 && seed <= 9 && !hasBrandTax) {
    const ep = entry(0.55);
    return {
      mode: "SNIPE", emoji: "🎯", color: "#22c55e",
      headline: "SNIPE — Sweet spot, underpriced in your group",
      detail: `Seeds 6-9 sell 24-31% below fair value in your group. ` +
        (phase === "mid" || phase === "late"
          ? "Budgets are thinning — even less competition now. "
          : "Early auction, but few whales compete here. ") +
        `Open around $${ep}, willing to go to $${maxBid.toFixed(0)}.` +
        (isProfileStrong ? " Strong profile — worth pushing for." : ""),
      entryPrice: ep, contextNote, queueAdvice,
    };
  }

  // ── VALUE: 3-5 seeds, no brand tax ──
  if (seed >= 3 && seed <= 5 && !hasBrandTax) {
    const ep = entry(0.60);
    return {
      mode: "VALUE", emoji: "💰", color: "#22c55e",
      headline: "VALUE — Consistently underpriced",
      detail: `Seed ${seed} teams sell 15-24% below fair value in your group. ` +
        (highVisibility
          ? "You've already bought — others may target-bid you. Consider having a friend open, or enter mid-sequence. "
          : "You're still under the radar. Bid with confidence. ") +
        `Target entry: $${ep}, max: $${maxBid.toFixed(0)}.`,
      entryPrice: ep, contextNote, queueAdvice,
    };
  }

  // ── PATIENCE: name tax but no specific loyal bidder ──
  if (hasBrandTax) {
    return {
      mode: "PATIENCE", emoji: "⏳", color: "#a78bfa",
      headline: `PATIENCE — Brand premium (+${(bp.avgPremium * 100).toFixed(0)}%)`,
      detail: `${team.name} historically sells above average for seed ${seed}. ` +
        `Someone will overpay. Let them. Only enter if price stays under $${maxBid.toFixed(0)}.`,
      entryPrice: Math.round(maxBid), contextNote, queueAdvice,
    };
  }

  // ── TARGET: 1-2 seeds mid/late auction ──
  if (seed <= 2) {
    const ep = Math.min(Math.round(maxBid * 0.85 * contextMult), Math.round(maxBid));
    return {
      mode: "TARGET", emoji: "🏹", color: "#3b82f6",
      headline: "TARGET — Premium team, bid deliberately",
      detail: `${phase === "late" ? "Late auction — some rivals may be tapped out. " : ""}` +
        `Enter at $${ep}, max $${maxBid.toFixed(0)}. ` +
        `Use a precise number (not round) to signal you've done the math.` +
        (isProfileStrong ? " Strong profile backs the price." : ""),
      entryPrice: ep, contextNote, queueAdvice,
    };
  }

  // ── DEFAULT: 10-13 seeds ──
  if (seed >= 10 && seed <= 13) {
    const fairish = ev > 50;
    if (!fairish) {
      return {
        mode: "PASS", emoji: "🚫", color: "#ef4444",
        headline: "PASS — Low EV, high variance",
        detail: `$${ev.toFixed(0)} EV isn't worth competing for. Only buy at a steep discount ($${entry(0.4)}) if nobody else wants it.`,
        entryPrice: entry(0.4), contextNote, queueAdvice,
      };
    }
    return {
      mode: "VALUE", emoji: "💰", color: "#22c55e",
      headline: "VALUE — Potential bargain",
      detail: `11-seeds are 50% profitable in your group historically. ` +
        `Don't overpay, but $${entry(0.6)} is a fair entry. Max: $${maxBid.toFixed(0)}.`,
      entryPrice: entry(0.6), contextNote, queueAdvice,
    };
  }

  // Fallback
  return {
    mode: "STANDARD", emoji: "📋", color: "#94a3b8",
    headline: "STANDARD — Bid to your max",
    detail: `No special signals. Enter around $${entry(0.6)}, max $${maxBid.toFixed(0)}.`,
    entryPrice: entry(0.6), contextNote, queueAdvice,
  };
}

function getVerdict(price, ev) {
  const ratio = ev / price;
  if (ratio >= 2.0) return { text: "GREAT VALUE", color: "#22c55e", icon: "💰" };
  if (ratio >= 1.5) return { text: "GOOD VALUE", color: "#22c55e", icon: "✅" };
  if (ratio >= 1.0) return { text: "FAIR PRICE", color: "#eab308", icon: "➡️" };
  if (ratio >= 0.75) return { text: "OVERPAYING", color: "#f97316", icon: "⚠️" };
  return { text: "TOO RICH", color: "#ef4444", icon: "🚫" };
}

// ============================================================
// BRACKET-AWARE MONTE CARLO TOURNAMENT SIMULATION
// ============================================================

const MC_SIMS = 5000;

// Standard R64 seed matchups in bracket order
const R64_MATCHUPS = [[1, 16], [8, 9], [5, 12], [4, 13], [6, 11], [3, 14], [7, 10], [2, 15]];

/**
 * Logistic win probability model calibrated to NCAA tournament outcomes.
 * P(A beats B) = 1 / (1 + 10^(-(ratingA - ratingB) / 11))
 * Scale of 11: ~11-point AdjEM gap ≈ 10:1 odds ratio.
 */
function winProbability(ratingA, ratingB) {
  // Calibrated from 123 R64 games (2022-2025 Barttorvik data)
  // Old divisor: 11.0 (overconfident). New: 23.0 (optimal log loss)
  return 1.0 / (1.0 + Math.pow(10, -(ratingA - ratingB) / 23.0));
}

/**
 * Synthetic rating from seed when team has no rating provided.
 * Calibrated so seed matchup win probs roughly match HISTORICAL_RATES for R64.
 */
function syntheticRating(seed) {
  return 30 - (seed - 1) * (35 / 15);
}

/**
 * Get effective rating for a team, falling back to seed-based synthetic rating.
 */
function effectiveRating(team) {
  return (team.rating != null && team.rating !== 0) ? team.rating : syntheticRating(team.seed);
}

/**
 * Run a full bracket-aware tournament simulation.
 * Properly handles matchups so two teams in the same region/matchup
 * can never both advance past their meeting point.
 *
 * Returns simMatrix: { teamName: Int8Array(nSims) } where each value = rounds won (0-6).
 */
function simulateTournament(allTeams, nSims) {
  // Group teams by region
  const regions = {};
  for (const t of allTeams) {
    if (!regions[t.region]) regions[t.region] = [];
    regions[t.region].push(t);
  }
  const regionNames = Object.keys(regions);

  // Build seed->team lookup per region
  const regionBySeed = {};
  for (const [rn, teams] of Object.entries(regions)) {
    regionBySeed[rn] = {};
    for (const t of teams) regionBySeed[rn][t.seed] = t;
  }

  // Initialize sim matrix
  const simMatrix = {};
  for (const t of allTeams) simMatrix[t.name] = new Int8Array(nSims);

  for (let sim = 0; sim < nSims; sim++) {
    const regionChamps = [];

    for (const rn of regionNames) {
      const bySeed = regionBySeed[rn];

      // R64: 8 games
      const r32 = [];
      for (const [sA, sB] of R64_MATCHUPS) {
        const tA = bySeed[sA], tB = bySeed[sB];
        if (!tA || !tB) { r32.push(tA || tB); continue; }
        const w = Math.random() < winProbability(effectiveRating(tA), effectiveRating(tB)) ? tA : tB;
        simMatrix[w.name][sim] = 1;
        r32.push(w);
      }

      // R32: 4 games
      const s16 = [];
      for (let i = 0; i < r32.length; i += 2) {
        const tA = r32[i], tB = r32[i + 1];
        if (!tA || !tB) { s16.push(tA || tB); continue; }
        const w = Math.random() < winProbability(effectiveRating(tA), effectiveRating(tB)) ? tA : tB;
        simMatrix[w.name][sim] = 2;
        s16.push(w);
      }

      // Sweet 16: 2 games
      const e8 = [];
      for (let i = 0; i < s16.length; i += 2) {
        const tA = s16[i], tB = s16[i + 1];
        if (!tA || !tB) { e8.push(tA || tB); continue; }
        const w = Math.random() < winProbability(effectiveRating(tA), effectiveRating(tB)) ? tA : tB;
        simMatrix[w.name][sim] = 3;
        e8.push(w);
      }

      // Elite 8: region final
      const tA = e8[0], tB = e8[1];
      if (tA && tB) {
        const w = Math.random() < winProbability(effectiveRating(tA), effectiveRating(tB)) ? tA : tB;
        simMatrix[w.name][sim] = 4;
        regionChamps.push(w);
      } else {
        const w = tA || tB;
        if (w) simMatrix[w.name][sim] = 4;
        regionChamps.push(w);
      }
    }

    // Final Four: region 0 vs 1, region 2 vs 3
    if (regionChamps.length >= 4) {
      const semi = [];
      for (let i = 0; i < 4; i += 2) {
        const tA = regionChamps[i], tB = regionChamps[i + 1];
        if (!tA || !tB) { semi.push(tA || tB); continue; }
        const w = Math.random() < winProbability(effectiveRating(tA), effectiveRating(tB)) ? tA : tB;
        simMatrix[w.name][sim] = 5;
        semi.push(w);
      }

      // Championship
      if (semi.length >= 2 && semi[0] && semi[1]) {
        const tA = semi[0], tB = semi[1];
        const w = Math.random() < winProbability(effectiveRating(tA), effectiveRating(tB)) ? tA : tB;
        simMatrix[w.name][sim] = 6;
      }
    }
  }

  return simMatrix;
}

/**
 * Compute the dollar payout for a team that won `roundsWon` rounds (0-6).
 */
function payoutForRoundsWon(roundsWon, pot, payouts, bonuses) {
  let total = 0;
  const rnames = Object.keys(payouts);
  for (let i = 0; i < roundsWon && i < rnames.length; i++) {
    const frac = payouts[rnames[i]] || 0;
    total += pot * frac;
  }
  return total;
}

/**
 * Run portfolio distribution analysis using bracket-aware sim matrix.
 * Because the simMatrix was produced by a proper bracket sim, two teams
 * that play each other early can never both advance — correlations are correct.
 */
function computePortfolioDistribution(teamEntries, simMatrix, pot, payouts, bonuses) {
  if (!teamEntries.length || !simMatrix) return null;

  const firstKey = Object.keys(simMatrix)[0];
  const nSims = firstKey ? simMatrix[firstKey].length : MC_SIMS;
  const totalCost = teamEntries.reduce((s, t) => s + t.price, 0);

  // Precompute default payout table (current auction)
  const defaultPayoutTable = [];
  for (let rw = 0; rw <= 6; rw++) {
    defaultPayoutTable.push(payoutForRoundsWon(rw, pot, payouts, bonuses));
  }

  // Build per-entry payout tables (prev auction entries may have their own)
  const entryPayoutTables = teamEntries.map(t => {
    if (t.prevPayoutTable) return t.prevPayoutTable;
    return defaultPayoutTable;
  });

  // Sum per-sim payouts using the correlated sim matrix
  const profits = new Float64Array(nSims);
  const perTeamTotals = new Array(teamEntries.length).fill(0);
  const perTeamProfitCount = new Array(teamEntries.length).fill(0);

  // Track winning paths for big-win analysis
  const ROUND_LABELS = ["R64", "R32", "S16", "E8", "F4", "Champ"];
  const pathCounts = {};  // "key" → { count, totalProfit, teams: [{name, rounds}] }
  const BIG_WIN_THRESHOLD = 1000;

  for (let s = 0; s < nSims; s++) {
    let totalPayout = 0;
    const simTeamResults = [];
    for (let t = 0; t < teamEntries.length; t++) {
      const teamSims = simMatrix[teamEntries[t].name];
      const roundsWon = teamSims ? teamSims[s] : 0;
      const p = entryPayoutTables[t][roundsWon];
      totalPayout += p;
      perTeamTotals[t] += p;
      if (p > teamEntries[t].price) perTeamProfitCount[t]++;
      if (roundsWon > 0) simTeamResults.push({ idx: t, roundsWon, payout: p });
    }
    const profit = totalPayout - totalCost;
    profits[s] = profit;

    // Track paths for big wins
    if (profit >= BIG_WIN_THRESHOLD) {
      // Key by the top 3 contributors (teams that advanced furthest / paid most)
      // This groups similar outcomes together instead of creating unique keys
      const keyTeams = simTeamResults
        .filter(r => r.roundsWon >= 2)
        .sort((a, b) => b.payout - a.payout)
        .slice(0, 3);
      const key = keyTeams.map(r => teamEntries[r.idx].name + "→" + ROUND_LABELS[r.roundsWon - 1]).join(" + ");
      if (key) {
        if (!pathCounts[key]) pathCounts[key] = { count: 0, totalProfit: 0, teams: keyTeams.map(r => ({ name: teamEntries[r.idx].name, round: ROUND_LABELS[r.roundsWon - 1], payout: Math.round(r.payout) })) };
        pathCounts[key].count++;
        pathCounts[key].totalProfit += profit;
      }
    }
  }

  // Top win paths
  const winPaths = Object.values(pathCounts)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(p => ({ ...p, avgProfit: p.totalProfit / p.count, pct: p.count / nSims }));

  const sorted = Array.from(profits).sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / nSims;
  const median = sorted[Math.floor(nSims / 2)];
  const pProfit = sorted.filter((p) => p > 0).length / nSims;
  const p10 = sorted[Math.floor(nSims * 0.1)];
  const p25 = sorted[Math.floor(nSims * 0.25)];
  const p75 = sorted[Math.floor(nSims * 0.75)];
  const p90 = sorted[Math.floor(nSims * 0.9)];
  const stdDev = Math.sqrt(sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / nSims);

  const perTeamStats = teamEntries.map((t, i) => ({
    name: t.name,
    price: t.price,
    meanPayout: perTeamTotals[i] / nSims,
    meanProfit: perTeamTotals[i] / nSims - t.price,
    pProfit: perTeamProfitCount[i] / nSims,
  }));

  return {
    totalCost, mean, median, pProfit,
    p10, p25, p75, p90,
    maxProfit: sorted[nSims - 1],
    maxLoss: sorted[0],
    stdDev, perTeamStats, winPaths,
  };
}

/**
 * Compute whatif impact: compare current portfolio vs portfolio + candidate.
 * Uses bracket-aware sim matrix for correlated outcomes.
 */
function computeWhatifImpact(currentEntries, candidateName, candidatePrice, simMatrix, allTeams, pot, payouts, bonuses) {
  const newEntries = [...currentEntries, { name: candidateName, price: candidatePrice }];

  const currentDist = computePortfolioDistribution(currentEntries, simMatrix, pot, payouts, bonuses);
  const newDist = computePortfolioDistribution(newEntries, simMatrix, pot, payouts, bonuses);

  if (!currentDist || !newDist) return null;

  // Region analysis
  const myRegions = {};
  currentEntries.forEach((t) => {
    const team = allTeams.find((x) => x.name === t.name);
    if (team) {
      if (!myRegions[team.region]) myRegions[team.region] = [];
      myRegions[team.region].push(t.name);
    }
  });
  const candidateTeam = allTeams.find((t) => t.name === candidateName);
  const candidateRegion = candidateTeam?.region || "Unknown";
  const sameRegionCount = (myRegions[candidateRegion] || []).length;

  let regionTag, regionColor;
  if (sameRegionCount === 0) {
    regionTag = "NEW REGION — adds diversification";
    regionColor = "#22c55e";
  } else if (sameRegionCount === 1) {
    regionTag = `1 team already in ${candidateRegion}`;
    regionColor = "#eab308";
  } else {
    regionTag = `CONCENTRATED — ${sameRegionCount} teams in ${candidateRegion}`;
    regionColor = "#ef4444";
  }

  const dPprofit = newDist.pProfit - currentDist.pProfit;
  const dMean = newDist.mean - currentDist.mean;
  const dMedian = newDist.median - currentDist.median;
  const dP10 = newDist.p10 - currentDist.p10;
  const dP90 = newDist.p90 - currentDist.p90;
  const dStd = newDist.stdDev - currentDist.stdDev;

  let verdict, verdictColor, verdictIcon;
  if (dPprofit > 0.02 && dP10 > -candidatePrice * 0.5) {
    verdict = "GOOD ADD"; verdictColor = "#22c55e"; verdictIcon = "✅";
  } else if (dPprofit > 0.02 && dP10 < -candidatePrice * 0.5) {
    verdict = "HIGH VARIANCE"; verdictColor = "#f97316"; verdictIcon = "⚠️";
  } else if (dPprofit < -0.02) {
    verdict = "PORTFOLIO DRAG"; verdictColor = "#ef4444"; verdictIcon = "❌";
  } else if (dPprofit >= -0.02 && dPprofit <= 0.02 && dMean > 0) {
    verdict = "NEUTRAL"; verdictColor = "#94a3b8"; verdictIcon = "➡️";
  } else {
    verdict = "MARGINAL"; verdictColor = "#64748b"; verdictIcon = "🤔";
  }

  return {
    current: currentDist,
    hypothetical: newDist,
    deltas: { pProfit: dPprofit, mean: dMean, median: dMedian, p10: dP10, p90: dP90, std: dStd },
    region: { tag: regionTag, color: regionColor, count: sameRegionCount, name: candidateRegion, existing: myRegions[candidateRegion] || [] },
    verdict: { text: verdict, color: verdictColor, icon: verdictIcon },
    sameRegionCount,
  };
}
// ============================================================
// HISTORICAL CSV PARSER
// ============================================================

/**
 * Parse history CSV into per-seed aggregated stats.
 * Supports any column order via header names.
 * Required columns: seed, price_paid, payout_received
 * Optional columns: year, team, rounds_won, region, bidder
 */
/**
 * Parse previous portfolio CSV.
 * Columns: auction, team, seed, region, ev, max_bid, price_paid, share, pot_size
 * Returns array of portfolio entries.
 */
function parsePrevPortfolioCSV(csv) {
  if (!csv || !csv.trim()) return [];
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map(s => s.trim().toLowerCase().replace(/\s+/g, "_"));
  const col = (name) => header.indexOf(name);
  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(s => s.trim().replace(/[",]/g, ""));
    if (cols.length < 5) continue;
    const entry = {
      auction: cols[col("auction")] || "Previous",
      team: cols[col("team")] || "",
      seed: parseInt(cols[col("seed")]) || 0,
      region: cols[col("region")] || "",
      ev: parseFloat(cols[col("ev")]) || 0,
      maxBid: parseFloat(cols[col("max_bid")]) || 0,
      pricePaid: parseFloat(cols[col("price_paid")]) || 0,
      share: parseFloat(cols[col("share")]) || 1.0,
      potSize: parseFloat((cols[col("pot_size")] || "0").replace(/,/g, "")) || 0,
    };
    // Per-auction payout structure (optional columns)
    const pr64 = col("payout_r64") >= 0 ? parseFloat(cols[col("payout_r64")]) : null;
    if (pr64 != null) {
      entry.payouts = {
        R64: pr64,
        R32: parseFloat(cols[col("payout_r32")]) || 0,
        "Sweet 16": parseFloat(cols[col("payout_s16")]) || 0,
        "Elite 8": parseFloat(cols[col("payout_e8")]) || 0,
        "Final Four": parseFloat(cols[col("payout_f4")]) || 0,
        Championship: parseFloat(cols[col("payout_champ")]) || 0,
      };
    }
    if (entry.team && entry.pricePaid > 0) results.push(entry);
  }
  return results;
}

function parseHistoryCSV(csv) {
  if (!csv || !csv.trim()) return null;
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return null;

  // Parse header to get column indices
  const header = lines[0].split(",").map((s) => s.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const seedIdx = col("seed");
  const priceIdx = col("price_paid");
  const payoutIdx = col("payout_received");
  const roundsIdx = col("rounds_won");
  const yearIdx = col("year");
  const teamIdx = col("team");
  const bidderIdx = col("bidder");

  if (seedIdx < 0 || priceIdx < 0) return null;

  // Parse rows
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((s) => s.trim());
    if (cols.length < Math.max(seedIdx, priceIdx) + 1) continue;
    const seed = parseInt(cols[seedIdx]);
    const price = parseFloat(cols[priceIdx]);
    const payout = payoutIdx >= 0 ? parseFloat(cols[payoutIdx]) || 0 : 0;
    const roundsWon = roundsIdx >= 0 ? parseInt(cols[roundsIdx]) || 0 : 0;
    const year = yearIdx >= 0 ? cols[yearIdx] : "";
    const team = teamIdx >= 0 ? cols[teamIdx] : "";
    const bidder = bidderIdx >= 0 ? cols[bidderIdx] : "";
    if (isNaN(seed) || isNaN(price)) continue;
    records.push({ year, team, seed, price, roundsWon, payout, bidder });
  }
  if (records.length === 0) return null;

  // Aggregate by seed
  const bySeeds = {};
  for (const r of records) {
    if (!bySeeds[r.seed]) bySeeds[r.seed] = { seed: r.seed, prices: [], payouts: [], profits: [] };
    bySeeds[r.seed].prices.push(r.price);
    bySeeds[r.seed].payouts.push(r.payout);
    bySeeds[r.seed].profits.push(r.payout - r.price);
  }

  // Compute per-year pot totals for normalizing prices across years (must be before seedStats)
  const yearPots = {};
  for (const r of records) {
    if (!yearPots[r.year]) yearPots[r.year] = 0;
    yearPots[r.year] += r.price;
  }

  const seedStats = {};
  for (const [seed, data] of Object.entries(bySeeds)) {
    const s = parseInt(seed);
    const n = data.prices.length;
    const sorted = [...data.prices].sort((a, b) => a - b);
    const avgPrice = data.prices.reduce((a, b) => a + b, 0) / n;
    const medianPrice = n % 2 === 1 ? sorted[Math.floor(n / 2)] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    const minPrice = sorted[0];
    const maxPrice = sorted[n - 1];
    const avgPayout = data.payouts.reduce((a, b) => a + b, 0) / n;
    const avgProfit = data.profits.reduce((a, b) => a + b, 0) / n;
    const avgROI = avgPrice > 0 ? avgProfit / avgPrice : 0;
    const pProfit = data.profits.filter((p) => p > 0).length / n;
    const bias = avgPayout > 0 ? avgPrice / avgPayout : 1;

    // Fraction-of-pot stats (normalized across different pot sizes)
    const fracs = [];
    for (const r of records.filter(rec => rec.seed === s)) {
      const pot = yearPots[r.year];
      if (pot > 0) fracs.push(r.price / pot);
    }
    const sortedFracs = [...fracs].sort((a, b) => a - b);
    const avgFrac = fracs.length > 0 ? fracs.reduce((a, b) => a + b, 0) / fracs.length : 0;
    const medianFrac = fracs.length > 0 ? (fracs.length % 2 === 1 ? sortedFracs[Math.floor(fracs.length / 2)] : (sortedFracs[fracs.length / 2 - 1] + sortedFracs[fracs.length / 2]) / 2) : 0;
    const minFrac = sortedFracs[0] || 0;
    const maxFrac = sortedFracs[sortedFracs.length - 1] || 0;

    let verdict, verdictColor;
    if (avgROI > 0.1 && pProfit >= 0.25) { verdict = "BUY"; verdictColor = "#22c55e"; }
    else if (avgROI > 0 && pProfit >= 0.2) { verdict = "OK"; verdictColor = "#eab308"; }
    else if (avgROI > -0.2) { verdict = "RISKY"; verdictColor = "#f97316"; }
    else { verdict = "AVOID"; verdictColor = "#ef4444"; }

    seedStats[s] = {
      seed: s, count: n, avgPrice, medianPrice, minPrice, maxPrice,
      avgFrac, medianFrac, minFrac, maxFrac,
      avgPayout, avgROI, pProfit, bias, verdict, verdictColor,
    };
  }

  // Seed average as fraction of pot (normalized across years)
  const seedAvgFrac = {};
  for (const [seed, data] of Object.entries(bySeeds)) {
    const s = parseInt(seed);
    const fracs = [];
    for (const r of records.filter((rec) => rec.seed === s)) {
      const pot = yearPots[r.year];
      if (pot > 0) fracs.push(r.price / pot);
    }
    seedAvgFrac[s] = fracs.length > 0 ? fracs.reduce((a, b) => a + b, 0) / fracs.length : 0;
  }

  // School brand premium: for each school that appears 2+ times,
  // compute avg premium vs seed-average price
  const schoolData = {};
  for (const r of records) {
    // Normalize school name: strip *, play-in opponents, trim
    // Also normalize "St" vs "St." so Iowa St and Iowa St. merge
    let name = r.team.replace(/\*/g, "").trim();
    if (name.includes("/")) name = name.split("/")[0].trim();
    // Standardize: ensure trailing "St" always has period
    name = name.replace(/\bSt$/i, "St.");
    if (!name) continue;
    // Normalize "St" vs "St." — always use "St." for consistency
    name = name.replace(/\bSt\b(?!\.)/g, "St.");
    if (!schoolData[name]) schoolData[name] = [];
    const pot = yearPots[r.year] || 1;
    const expectedFrac = seedAvgFrac[r.seed] || 0;
    const expectedPrice = expectedFrac * pot;
    const premium = expectedPrice > 0 ? (r.price - expectedPrice) / expectedPrice : 0;
    schoolData[name].push({ year: r.year, seed: r.seed, price: r.price, expected: expectedPrice, premium, bidder: r.bidder });
  }

  // Build schoolPremiums: only schools with 2+ appearances
  const schoolPremiums = {};
  for (const [name, entries] of Object.entries(schoolData)) {
    if (entries.length < 2) continue;
    const avgPremium = entries.reduce((s, e) => s + e.premium, 0) / entries.length;
    const avgSeed = entries.reduce((s, e) => s + e.seed, 0) / entries.length;
    const bidderCounts = {};
    for (const e of entries) {
      if (e.bidder) bidderCounts[e.bidder] = (bidderCounts[e.bidder] || 0) + 1;
    }
    const loyalBidder = Object.entries(bidderCounts).sort((a, b) => b[1] - a[1])[0];
    schoolPremiums[name] = {
      name, count: entries.length, avgPremium, avgSeed, entries,
      loyalBidder: loyalBidder && loyalBidder[1] >= 2 ? loyalBidder[0] : null,
    };
  }

  // Build bidder profiles for "who's bidding?" predictor
  const bidderProfiles = {};
  const allYears = [...new Set(records.map(r => r.year))];
  for (const r of records) {
    if (!r.bidder) continue;
    if (!bidderProfiles[r.bidder]) {
      bidderProfiles[r.bidder] = { schools: {}, seeds: {}, prices: [], years: new Set() };
    }
    const bp = bidderProfiles[r.bidder];
    const sn = r.team.replace(/\*/g, "").split("/")[0].trim().toLowerCase().replace(/\./g, "");
    bp.schools[sn] = (bp.schools[sn] || 0) + 1;
    bp.seeds[r.seed] = (bp.seeds[r.seed] || 0) + 1;
    bp.prices.push(r.price);
    bp.years.add(r.year);
  }

  return { records, seedStats, seedAvgFrac, schoolPremiums, bidderProfiles, totalRecords: records.length, years: allYears.sort() };
}

/**
 * Predict which bidders from history are likely to compete for a given team.
 * Uses brand loyalty (bought this school before) and seed preference.
 * Returns top 3 likely bidders with reasons.
 */
function predictBidders(teamName, seed, bidderProfiles) {
  if (!bidderProfiles || !teamName) return [];
  const tn = teamName.replace(/\*/g, "").split("/")[0].trim().toLowerCase().replace(/\./g, "");
  const results = [];
  for (const [bname, bdata] of Object.entries(bidderProfiles)) {
    if (bdata.years.size < 2) continue; // skip one-time participants
    let score = 0;
    const reasons = [];
    // Brand loyalty
    const schoolCount = bdata.schools[tn] || 0;
    if (schoolCount >= 2) { score += 3; reasons.push("bought " + schoolCount + "x"); }
    else if (schoolCount === 1) { score += 1; reasons.push("bought 1x"); }
    // Seed preference
    const seedCount = bdata.seeds[seed] || 0;
    const totalTeams = Object.values(bdata.seeds).reduce((s, v) => s + v, 0);
    if (totalTeams > 0 && seedCount / totalTeams > 0.25) {
      score += 2; reasons.push("loves " + seed + "-seeds (" + seedCount + "x)");
    } else if (seedCount >= 2) {
      score += 1; reasons.push("buys " + seed + "-seeds");
    }
    // Price tier match
    const avgPrice = bdata.prices.reduce((s, v) => s + v, 0) / bdata.prices.length;
    if (avgPrice > 250) {
      if (seed <= 3) { score += 1; reasons.push("big spender"); }
    } else if (avgPrice < 80) {
      if (seed >= 10) { score += 1; reasons.push("bargain hunter"); }
    }
    if (score > 0) results.push({ name: bname, score, reasons });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 3);
}

// Sample history CSV for demo
const SAMPLE_HISTORY_CSV = `year,team,seed,price_paid,rounds_won,payout_received
2023,Gonzaga,1,1200,2,200
2023,Alabama,1,1100,2,200
2023,Houston,1,1050,4,700
2023,Kansas,1,950,1,100
2023,Marquette,2,450,0,0
2023,Texas,2,500,1,100
2023,UCLA,2,600,3,400
2023,Arizona,2,550,2,200
2023,Xavier,3,200,2,200
2023,Baylor,3,180,1,100
2023,Kansas St,3,220,3,400
2023,Purdue,3,250,2,200
2023,Indiana,4,130,0,0
2023,Virginia,4,100,0,0
2023,Connecticut,4,150,6,2500
2023,Tennessee,4,120,1,100
2023,Miami FL,5,40,4,700
2023,San Diego St,5,45,5,1200
2023,Duke,5,80,0,0
2023,Saint Marys,5,35,1,100
2022,Gonzaga,1,1300,1,100
2022,Kansas,1,1100,6,2500
2022,Baylor,1,900,1,100
2022,Arizona,1,1000,2,200
2022,Kentucky,2,500,0,0
2022,Auburn,2,600,1,100
2022,Duke,2,650,4,700
2022,Villanova,2,550,4,700
2022,Purdue,3,250,2,200
2022,Tennessee,3,200,1,100
2022,Texas Tech,3,220,2,200
2022,Wisconsin,3,180,1,100
2022,UCLA,4,120,2,200
2022,Providence,4,90,0,0
2022,Arkansas,4,110,3,400
2022,Illinois,4,130,1,100
2022,Iowa,5,50,0,0
2022,Houston,5,60,3,400
2022,UConn,5,55,1,100
2022,Saint Marys,5,30,1,100`;

// ============================================================
// DEFAULT BRACKET (compact — user can replace via JSON paste)
// ============================================================

const SAMPLE_BRACKET = {"pot_size":5000,"payouts":{"R64":0.025,"R32":0.05,"Sweet 16":0.1,"Elite 8":0.15,"Final Four":0.225,"Championship":0.45},"regions":{"South":[{"name":"Houston","seed":1,"rating":29.5,"womens_win_prob":0.0,"vegas_odds":500,"kenpom_probs":[0.99,0.89,0.72,0.56,0.38,0.23],"adj_o":118.5,"adj_d":89.0,"adj_o_rank":13,"adj_d_rank":7,"adj_t":66.2,"luck":0.018},{"name":"Marquette","seed":2,"rating":25.0,"womens_win_prob":0.0,"vegas_odds":3500},{"name":"Kentucky","seed":3,"rating":22.5,"womens_win_prob":0.0,"vegas_odds":8000,"womens_vegas_odds":4000},{"name":"Duke","seed":4,"rating":21.0,"womens_win_prob":0.0,"vegas_odds":15000,"womens_vegas_odds":4000},{"name":"Wisconsin","seed":5,"rating":19.5},{"name":"Texas Tech","seed":6,"rating":18.0},{"name":"Florida","seed":7,"rating":16.5},{"name":"Nebraska","seed":8,"rating":15.0},{"name":"Texas A&M","seed":9,"rating":14.5},{"name":"Colorado St","seed":10,"rating":13.0},{"name":"NC State","seed":11,"rating":12.0,"womens_vegas_odds":2000},{"name":"James Madison","seed":12,"rating":10.5},{"name":"Vermont","seed":13,"rating":6.0},{"name":"Oakland","seed":14,"rating":4.0},{"name":"W Kentucky","seed":15,"rating":1.0},{"name":"Longwood","seed":16,"rating":-4.0}],"East":[{"name":"UConn","seed":1,"rating":32.0,"vegas_odds":200,"kenpom_probs":[0.99,0.93,0.80,0.65,0.48,0.33],"adj_o":123.5,"adj_d":91.5,"adj_o_rank":1,"adj_d_rank":18,"adj_t":68.0,"luck":-0.012,"womens_vegas_odds":500},{"name":"Iowa St","seed":2,"rating":24.5,"vegas_odds":4000,"kenpom_probs":[0.93,0.72,0.46,0.28,0.15,0.07],"womens_vegas_odds":800},{"name":"Illinois","seed":3,"rating":23.0,"vegas_odds":8000},{"name":"Auburn","seed":4,"rating":21.5,"vegas_odds":12000,"kenpom_probs":[0.80,0.48,0.25,0.12,0.05,0.02],"adj_o":115.0,"adj_d":93.5,"adj_o_rank":28,"adj_d_rank":32,"adj_t":69.0,"luck":-0.048},{"name":"San Diego St","seed":5,"rating":19.0},{"name":"BYU","seed":6,"rating":17.5},{"name":"Washington St","seed":7,"rating":16.0},{"name":"FAU","seed":8,"rating":15.5},{"name":"Northwestern","seed":9,"rating":14.0},{"name":"Drake","seed":10,"rating":12.5},{"name":"Duquesne","seed":11,"rating":11.0},{"name":"Richmond","seed":12,"rating":9.5},{"name":"Morehead St","seed":13,"rating":5.5},{"name":"South Dakota St","seed":14,"rating":3.5},{"name":"Stony Brook","seed":15,"rating":0.5},{"name":"Wagner","seed":16,"rating":-5.0}],"Midwest":[{"name":"Purdue","seed":1,"rating":30.0,"vegas_odds":450,"kenpom_probs":[0.99,0.90,0.74,0.58,0.40,0.25],"adj_o":122.0,"adj_d":92.0,"adj_o_rank":2,"adj_d_rank":25,"adj_t":68.8,"luck":0.032},{"name":"Tennessee","seed":2,"rating":26.0,"vegas_odds":2500,"kenpom_probs":[0.94,0.74,0.50,0.33,0.19,0.10],"adj_o":112.5,"adj_d":86.5,"adj_o_rank":45,"adj_d_rank":2,"adj_t":64.5,"luck":0.008,"womens_vegas_odds":2500},{"name":"Creighton","seed":3,"rating":23.5,"vegas_odds":6500},{"name":"Kansas","seed":4,"rating":22.0,"vegas_odds":15000},{"name":"Gonzaga","seed":5,"rating":20.0},{"name":"South Carolina","seed":6,"rating":18.5,"womens_vegas_odds":250},{"name":"Texas","seed":7,"rating":17.0,"womens_vegas_odds":1500},{"name":"Utah St","seed":8,"rating":15.0},{"name":"TCU","seed":9,"rating":14.5},{"name":"Colorado","seed":10,"rating":13.5},{"name":"Oregon","seed":11,"rating":12.5},{"name":"McNeese","seed":12,"rating":10.0},{"name":"Samford","seed":13,"rating":5.0},{"name":"Akron","seed":14,"rating":3.0},{"name":"Montana St","seed":15,"rating":0.0},{"name":"Grambling","seed":16,"rating":-6.0}],"West":[{"name":"North Carolina","seed":1,"rating":28.5,"vegas_odds":900,"kenpom_probs":[0.99,0.87,0.68,0.50,0.32,0.18],"adj_o":119.0,"adj_d":90.5,"adj_o_rank":8,"adj_d_rank":12,"adj_t":73.5,"luck":0.005,"womens_vegas_odds":5000},{"name":"Arizona","seed":2,"rating":27.0,"vegas_odds":2000,"kenpom_probs":[0.95,0.78,0.55,0.37,0.22,0.12],"adj_o":117.5,"adj_d":90.5,"adj_o_rank":18,"adj_d_rank":10,"adj_t":66.8,"luck":-0.015},{"name":"Baylor","seed":3,"rating":24.0,"vegas_odds":6000,"womens_vegas_odds":2500},{"name":"Alabama","seed":4,"rating":22.5,"vegas_odds":12000,"adj_o":120.5,"adj_d":98.0,"adj_o_rank":3,"adj_d_rank":67,"adj_t":74.2,"luck":0.065},{"name":"Saint Mary's","seed":5,"rating":20.5},{"name":"Clemson","seed":6,"rating":19.0},{"name":"Dayton","seed":7,"rating":17.5},{"name":"Mississippi St","seed":8,"rating":16.0},{"name":"Michigan St","seed":9,"rating":15.5},{"name":"Nevada","seed":10,"rating":14.0},{"name":"New Mexico","seed":11,"rating":13.0},{"name":"Grand Canyon","seed":12,"rating":11.0},{"name":"Charleston","seed":13,"rating":6.5},{"name":"Colgate","seed":14,"rating":4.5},{"name":"Long Beach St","seed":15,"rating":1.5},{"name":"Howard","seed":16,"rating":-3.5}]},"bonuses":{"womens_champ":0.02,"biggest_blowout":0.01}};

// Simulated mid-auction state: ~30 teams sold with realistic prices
// Sample sold data — randomized auction order (real Calcuttas draw teams randomly)
// Prices reflect bidding dynamics: early teams often go cheaper (unknown pot),
// mid-auction heats up, late teams can go for steals or overpays.
const SAMPLE_SOLD = {
  "Florida": 22, "Purdue": 1100, "Clemson": 40, "Vermont": 3,
  "Tennessee": 380, "BYU": 32, "UConn": 1350, "Dayton": 28,
  "Kansas": 100, "San Diego St": 58, "Marquette": 290, "FAU": 12,
  "Alabama": 105, "Gonzaga": 72, "Kentucky": 155, "South Carolina": 48,
  "Texas Tech": 38, "Houston": 950, "Iowa St": 260, "Duke": 95,
  "Nebraska": 14, "Saint Mary's": 55, "Baylor": 175, "Auburn": 110,
  "Washington St": 18, "Illinois": 165, "Arizona": 410, "Creighton": 180,
  "Wisconsin": 50, "North Carolina": 780, "Texas": 25,
};

// User bought these teams
const SAMPLE_MY_TEAMS = {
  "Purdue": 1100, "Iowa St": 260, "Auburn": 110,
  "Gonzaga": 72, "South Carolina": 48, "Dayton": 28,
};

// ============================================================
// HELP TOOLTIP COMPONENT
// ============================================================

/**
 * Wraps children with hover tooltip. Only active when help mode is on.
 * Shows a plain-English explanation near the mouse cursor.
 */
function HelpTip({ text, active, children, style }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const ref = useRef(null);

  if (!active) return children;

  const handleEnter = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPos({ x: rect.left + rect.width / 2, y: rect.bottom + 4 });
    setShow(true);
  };

  return (
    <span
      ref={ref}
      onMouseEnter={handleEnter}
      onMouseLeave={() => setShow(false)}
      style={{ position: "relative", cursor: "help", outline: active ? "1px dashed #6366f140" : "none", borderRadius: 4, ...style }}
    >
      {children}
      {show && (
        <div style={{
          position: "fixed", left: Math.min(pos.x, window.innerWidth - 320), top: pos.y,
          zIndex: 9999, maxWidth: 300, padding: "8px 12px", borderRadius: 8,
          background: "#1e293b", border: "1px solid #6366f1", color: "#e2e8f0",
          fontSize: 12, lineHeight: 1.5, boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
          pointerEvents: "none", transform: "translateX(-50%)",
        }}>
          <div style={{ fontWeight: 700, color: "#a5b4fc", marginBottom: 2, fontSize: 10 }}>ℹ️ HELP</div>
          {text}
        </div>
      )}
    </span>
  );
}

// ============================================================
// MAIN COMPONENT
// ============================================================

export default function CalcuttaDashboard() {
  const [bracket, setBracket] = useState(null);
  const [jsonInput, setJsonInput] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [sold, setSold] = useState({});
  const [myTeams, setMyTeams] = useState({});
  const [splitTeams, setSplitTeams] = useState({}); // { name: { price, share (0-1), isBuyer } }
  const [splitPreview, setSplitPreview] = useState({ active: false, share: 0.5 }); // Live "what if I split this?" toggle
  const [prevPortfolio, setPrevPortfolio] = useState([]); // [{ auction, team, seed, region, ev, maxBid, pricePaid, share, potSize }]
  const [showPrevPortfolio, setShowPrevPortfolio] = useState(true); // Toggle previous portfolio on/off
  const [tournamentResults, setTournamentResults] = useState({}); // teamName → roundsWon (known results)
  const [potOverride, setPotOverride] = useState(null);
  const [budget, setBudget] = useState(0);
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [currentBid, setCurrentBid] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const [showSoldInList, setShowSoldInList] = useState(true);
  const [activeTab, setActiveTab] = useState("analysis");
  const [loading, setLoading] = useState(true);
  const [historyCSV, setHistoryCSV] = useState("");
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [stealAlerts, setStealAlerts] = useState([]);
  const [helpMode, setHelpMode] = useState(false);
  const [liveConnected, setLiveConnected] = useState(false);
  const [liveSaleLog, setLiveSaleLog] = useState([]);
  const [liveCurrentItem, setLiveCurrentItem] = useState(null);
  const [liveBid, setLiveBid] = useState(0);
  const [liveBidIsMine, setLiveBidIsMine] = useState(false);
  const [bidderTotals, setBidderTotals] = useState({});  // { userId: { name, spent, teams, teamList } }
  const [upcomingQueue, setUpcomingQueue] = useState([]); // [{ name, order, rank }]
  const [showUpcoming, setShowUpcoming] = useState(true); // Toggle for "Coming Up" panel
  const [budgetCap, setBudgetCap] = useState(0);  // 0 = unlimited, >0 = hard cap with last-team exception
  const [ciMode, setCiMode] = useState("full"); // "full" = pot + model spread, "pot" = pot uncertainty only
  const bidRef = useRef(null);
  const searchRef = useRef(null);
  // Refs so the live message handler can read current state without stale closures
  const selectedTeamRef = useRef(null);
  const liveCurrentItemRef = useRef(null);
  const allTeamsRef = useRef([]);
  useEffect(() => { selectedTeamRef.current = selectedTeam; }, [selectedTeam]);
  useEffect(() => {
    if (selectedTeam && splitTeams[selectedTeam]) {
      setSplitPreview({ active: true, share: splitTeams[selectedTeam].share });
    } else {
      setSplitPreview(prev => ({ ...prev, active: false }));
    }
  }, [selectedTeam]);
  useEffect(() => { liveCurrentItemRef.current = liveCurrentItem; }, [liveCurrentItem]);
  useEffect(() => { allTeamsRef.current = allTeams; }, [allTeams]);

  // ── Live Auction Feed ──
  // Supports two communication modes:
  //   1. BroadcastChannel (same-origin, e.g. both on localhost)
  //   2. window.postMessage (cross-origin, AuctionPro → local file)
  // The scraper sends: { type: "sale"|"live_item"|"ping", ... }
  useEffect(() => {
    let channel;
    let pingTimeout;

    /**
     * Fuzzy-match an incoming team name (from AuctionPro) to our internal team list.
     * Handles: "Michigan State" vs "Michigan St.", "UConn" vs "Connecticut",
     * "St. John's" vs "St Johns", etc.
     */
    function resolveTeamName(rawName) {
      if (!rawName) return rawName;

      // Strip leading seed number (AuctionPro sends "1 Duke", "16 Siena", etc.)
      let cleaned = rawName.replace(/^\d+\s+/, "").trim();
      // If stripping produced nothing, use original
      if (!cleaned) cleaned = rawName;

      // Hardcoded aliases — checked FIRST, no team list needed
      const ALIASES = {
        "michigan state": "Michigan St.",
        "michigan st": "Michigan St.",
        "ohio state": "Ohio St.",
        "ohio st": "Ohio St.",
        "iowa state": "Iowa St.",
        "iowa st": "Iowa St.",
        "utah state": "Utah St.",
        "utah st": "Utah St.",
        "wright state": "Wright St.",
        "wright st": "Wright St.",
        "kennesaw state": "Kennesaw St.",
        "kennesaw st": "Kennesaw St.",
        "north dakota state": "North Dakota St.",
        "north dakota st": "North Dakota St.",
        "tennessee state": "Tennessee St.",
        "tennessee st": "Tennessee St.",
        "connecticut": "UConn",
        "uconn huskies": "UConn",
        "saint marys": "Saint Mary's",
        "saint mary's": "Saint Mary's",
        "st marys": "Saint Mary's",
        "st johns": "St. John's",
        "st. johns": "St. John's",
        "st john's": "St. John's",
        "saint johns": "St. John's",
        "miami": "Miami (FL)",
        "miami fl": "Miami (FL)",
        "miami florida": "Miami (FL)",
        "miami ohio": "Miami (Ohio)",
        "miami oh": "Miami (Ohio)",
        "queens": "Queens (N.C.)",
        "queens nc": "Queens (N.C.)",
        "texas / nc state": "Texas/NC State",
        "texas nc state": "Texas/NC State",
        "umbc / howard": "UMBC/Howard",
        "umbc howard": "UMBC/Howard",
        "prairie view a&m / lehigh": "Prairie View A&M/Lehigh",
        "prairie view lehigh": "Prairie View A&M/Lehigh",
        "miami ohio / smu": "Miami (Ohio)/SMU",
        "miami oh / smu": "Miami (Ohio)/SMU",
        "miami ohio smu": "Miami (Ohio)/SMU",
        "cal state baptist": "Cal Baptist",
        "california baptist": "Cal Baptist",
        // Saint Louis variants
        "st louis": "Saint Louis",
        "st. louis": "Saint Louis",
        "saint louis": "Saint Louis",
        // Long Island University
        "liu": "Long Island",
        "long island university": "Long Island",
        // Safety: prevent "Penn State" from matching "Penn"
        "penn state": "__NOMATCH__",
        "penn st": "__NOMATCH__",
        // Safety: prevent bare "Texas" from matching play-in when Texas A&M/Tech intended
        "texas am": "Texas A&M",
        "texas a&m": "Texas A&M",
        "texas a and m": "Texas A&M",
        "texas tech": "Texas Tech",
        // AuctionPro abbreviations
        "n dakota st": "North Dakota St.", "n dakota st.": "North Dakota St.",
        "n carolina": "North Carolina",
        "miami oh / smu": "Miami (Ohio)/SMU", "miami (oh) / smu": "Miami (Ohio)/SMU",
        "st clara": "Santa Clara", "st. clara": "Santa Clara",
        // Danny's auction full names (with mascots stripped by scraper)
        "central florida": "UCF", "central florida knights": "UCF", "ucf knights": "UCF",
        "liu brooklyn": "Long Island", "liu brooklyn sharks": "Long Island", "liu sharks": "Long Island",
        "howard": "UMBC/Howard", "howard bison": "UMBC/Howard",
        "texas longhorns": "Texas/NC State", "texas / nc state": "Texas/NC State",
        "nc state wolfpack": "Texas/NC State", "nc state": "Texas/NC State",
        "hawaii": "Hawaii", "hawai'i": "Hawaii", "hawai'i rainbow warriors": "Hawaii",
        "hawaii rainbow warriors": "Hawaii",
        "pennsylvania": "Penn", "pennsylvania quakers": "Penn",
        "mcneese state": "McNeese", "mcneese state cowboys": "McNeese", "mcneese cowboys": "McNeese",
        "arkansas": "Arkansas", "arkansas razorbacks": "Arkansas",
        "siena": "Siena", "siena saints": "Siena",
        // Play-in: prevent bare words from false matching
        "lehigh": "Prairie View A&M/Lehigh", "lehigh mountain hawks": "Prairie View A&M/Lehigh",
        "prairie view": "Prairie View A&M/Lehigh", "prairie view a&m": "Prairie View A&M/Lehigh",
        "prairie view a&m panthers / lehigh mountain hawks": "Prairie View A&M/Lehigh",
        "miami (oh) redhawks / smu mustangs": "Miami (Ohio)/SMU",
        "miami oh redhawks / smu mustangs": "Miami (Ohio)/SMU",
        "smu": "Miami (Ohio)/SMU", "smu mustangs": "Miami (Ohio)/SMU",
        "umbc": "UMBC/Howard", "umbc retrievers": "UMBC/Howard",
        "queens royals": "Queens (N.C.)",
      };

      const rawLower = cleaned.toLowerCase().replace(/\./g, "").replace(/'/g, "").replace(/\s+/g, " ").trim();
      if (ALIASES[rawLower] && ALIASES[rawLower] !== "__NOMATCH__") {
        console.log("[Calcutta] Alias match:", rawName, "→", ALIASES[rawLower]);
        return ALIASES[rawLower];
      }
      if (ALIASES[rawLower] === "__NOMATCH__") {
        console.warn("[Calcutta] Blocked match:", rawName, "— not in this tournament");
        return cleaned;
      }

      const teams = allTeamsRef.current || [];
      const names = teams.map(t => t.name);

      // Exact match
      if (names.includes(cleaned)) return cleaned;

      if (teams.length === 0) {
        console.warn("[Calcutta] No teams loaded yet, passing through:", rawName);
        return rawName;
      }

      // Normalize for comparison
      function norm(s) {
        return s.toLowerCase().replace(/\./g, "").replace(/'/g, "").replace(/\(|\)/g, "").replace(/\s+/g, " ").trim();
      }
      const rawNorm = norm(cleaned);

      // Normalized exact match
      for (const n of names) {
        if (norm(n) === rawNorm) { console.log("[Calcutta] Norm match:", rawName, "→", n); return n; }
      }

      // Contains match
      for (const n of names) {
        const nn = norm(n);
        if (nn.length > 3 && rawNorm.length > 3 && (nn.includes(rawNorm) || rawNorm.includes(nn))) {
          console.log("[Calcutta] Contains match:", rawName, "→", n);
          return n;
        }
      }

      // Play-in combo check
      for (const n of names) {
        if (n.includes("/")) {
          const parts = n.split("/").map(p => norm(p.trim()));
          for (const p of parts) {
            if (p === rawNorm || (p.length > 3 && (p.includes(rawNorm) || rawNorm.includes(p)))) {
              console.log("[Calcutta] Play-in match:", rawName, "→", n);
              return n;
            }
          }
        }
      }

      console.warn("[Calcutta] ❌ Could not match team name:", rawName, "(cleaned:", cleaned, ")");
      return cleaned;
    }

    function handleMessage(msg) {
      if (!msg || !msg.type) return;

      // Resolve team name on every message
      if (msg.team) msg.team = resolveTeamName(msg.team);

      setLiveConnected(true);
      clearTimeout(pingTimeout);
      pingTimeout = setTimeout(() => setLiveConnected(false), 15000);

      if (msg.type === "ping") return;

      if (msg.type === "live_item") {
        setLiveCurrentItem(msg.team || null);
        setLiveBid(0);
        setLiveBidIsMine(false);
        // Only auto-follow if user is viewing the previous live team or nothing
        const viewing = selectedTeamRef.current;
        const wasLive = liveCurrentItemRef.current;
        if (msg.team && (!viewing || viewing === wasLive)) {
          setSelectedTeam(msg.team);
          setCurrentBid("");
        }
        return;
      }

      if (msg.type === "live_bid") {
        const bidAmt = parseFloat(msg.amount) || 0;
        setLiveBid(bidAmt);
        setLiveBidIsMine(!!msg.isMine);
        if (msg.team) setLiveCurrentItem(msg.team);
        // Only update bid input if user is viewing the live team
        if (bidAmt > 0 && selectedTeamRef.current === (msg.team || liveCurrentItemRef.current)) {
          setCurrentBid(String(bidAmt));
        }
        return;
      }

      if (msg.type === "sale" && msg.team && msg.price > 0) {
        setLiveSaleLog((prev) => [...prev, { ...msg, time: new Date().toLocaleTimeString() }].slice(-50));
        setSold((prevSold) => {
          if (prevSold[msg.team] === msg.price) return prevSold;
          return { ...prevSold, [msg.team]: msg.price };
        });
        if (msg.isMine) {
          setMyTeams((prev) => {
            if (prev[msg.team]) return prev;
            return { ...prev, [msg.team]: msg.price };
          });
        }
        // Track per-bidder spending from individual sales
        if (msg.buyer) {
          setBidderTotals((prev) => {
            const key = msg.buyer.toLowerCase().trim();
            const existing = prev[key] || { name: msg.buyer, spent: 0, teams: 0, teamList: [] };
            // Avoid double-counting same team
            if (existing.teamList.some(t => t.name === msg.team)) return prev;
            return {
              ...prev,
              [key]: {
                ...existing,
                name: msg.buyer,
                spent: existing.spent + msg.price,
                teams: existing.teams + 1,
                teamList: [...existing.teamList, { name: msg.team, price: msg.price }],
              },
            };
          });
        }
        // Only jump to sold team if user was watching it or the live team
        const viewing = selectedTeamRef.current;
        const wasLive = liveCurrentItemRef.current;
        if (!viewing || viewing === msg.team || viewing === wasLive) {
          setSelectedTeam(msg.team);
          setCurrentBid(String(msg.price));
        }
      }

      if (msg.type === "bidder_totals" && msg.bidders) {
        console.log("[Calcutta] Received bidder_totals:", Object.keys(msg.bidders).length, "bidders");
        // Mark the user's own bidder entry if scraper provides myId
        if (msg.myId) {
          for (const [id, b] of Object.entries(msg.bidders)) {
            if (String(id) === String(msg.myId)) b.isMe = true;
          }
        }
        setBidderTotals(msg.bidders);
      }

      if (msg.type === "upcoming" && msg.teams) {
        setUpcomingQueue(msg.teams);
      }
    }

    // Mode 1: BroadcastChannel (same-origin)
    try {
      channel = new BroadcastChannel("calcutta-live");
      channel.onmessage = (event) => handleMessage(event.data);
    } catch (e) {}

    // Mode 2: window.postMessage (cross-origin — used by AuctionPro scraper)
    function onPostMessage(event) {
      // Accept from any origin (scraper runs on auctionpro.co)
      if (event.data && event.data._calcutta) {
        handleMessage(event.data);
      }
    }
    window.addEventListener("message", onPostMessage);

    // Announce to opener (if scraper opened us via window.open)
    if (window.opener) {
      try { window.opener.postMessage({ type: "calcutta-dashboard-ready" }, "*"); } catch(e) {}
    }

    return () => {
      if (channel) channel.close();
      clearTimeout(pingTimeout);
      window.removeEventListener("message", onPostMessage);
    };
  }, []);

  // Derived data
  const allTeams = useMemo(() => {
    if (!bracket) return [];
    const teams = [];
    for (const [region, teamList] of Object.entries(bracket.regions)) {
      for (const t of teamList) {
        teams.push({ ...t, region, id: `(${t.seed}) ${t.name}` });
      }
    }

    // Convert womens_vegas_odds → womens_win_prob (de-vigged)
    const withWomensOdds = teams.filter((t) => t.womens_vegas_odds != null);
    if (withWomensOdds.length > 0) {
      const rawProbs = withWomensOdds.map((t) => {
        const odds = t.womens_vegas_odds;
        return { team: t, prob: odds > 0 ? 100.0 / (odds + 100.0) : Math.abs(odds) / (Math.abs(odds) + 100.0) };
      });
      const totalImplied = rawProbs.reduce((s, r) => s + r.prob, 0);
      const vig = totalImplied > 1.0 ? totalImplied : 1.0;
      for (const r of rawProbs) {
        r.team.womens_win_prob = r.prob / vig;
      }
    }

    // Mark returning tournament teams (were in the tournament LAST YEAR specifically)
    // Backtest: 1yr window has strongest signal (+$44 gap vs new teams)
    // Teams from 2+ years ago who missed last year actually perform WORST (-$71 profit)
    // — indicates roster/coaching regression. 1-year = continuity signal.
    if (seedHistory?.records?.length) {
      const years = [...new Set(seedHistory.records.map(r => r.year))].sort();
      const lastYear = years[years.length - 1];
      const lastYearTeams = new Set(
        seedHistory.records
          .filter(r => r.year === lastYear)
          .map(r => r.team.replace(/\*/g, "").split("/")[0].trim().toLowerCase().replace(/\./g, ""))
      );
      for (const t of teams) {
        const norm = t.name.split("/")[0].trim().toLowerCase().replace(/\./g, "");
        t.returning = lastYearTeams.has(norm);
      }
    }

    // Mark overseeded teams (KenPom rank much worse than seed suggests)
    // Backtest: overseeded teams avg 0.22 rounds, -$37 profit
    const byRating = [...teams].filter(t => t.rating != null).sort((a, b) => b.rating - a.rating);
    // Expected rank within 64-team tournament field (not all of D1)
    const seedExpectedRank = { 1: 2, 2: 6, 3: 10, 4: 14, 5: 20, 6: 26, 7: 32, 8: 38, 9: 42, 10: 46, 11: 50, 12: 52, 13: 55, 14: 58, 15: 61, 16: 64 };
    for (let i = 0; i < byRating.length; i++) {
      const t = byRating[i];
      const actualRank = i + 1;
      const expectedRank = seedExpectedRank[t.seed] || 50;
      t.ratingRank = actualRank;
      t.seedMismatch = expectedRank - actualRank; // positive = underseeded (better than seed), negative = overseeded
    }

    return teams.sort((a, b) => a.seed - b.seed || a.name.localeCompare(b.name));
  }, [bracket, seedHistory]);

  const payouts = useMemo(() => bracket?.payouts || DEFAULT_PAYOUTS, [bracket]);
  const bonuses = useMemo(() => bracket?.bonuses || DEFAULT_BONUSES, [bracket]);
  const basePot = useMemo(() => potOverride || bracket?.pot_size || DEFAULT_POT_SIZE, [potOverride, bracket]);

  // Projected pot — Bayesian estimation
  // Compute EV shares first (pot-independent ratios for Bayesian observations)
  const actualPotSoFar = useMemo(() => Object.values(sold).reduce((s, v) => s + v, 0), [sold]);

  // Blowout probabilities (depends only on teams, not pot)
  const blowoutProbs = useMemo(() => {
    if (allTeams.length < 4) return {};
    return computeBlowoutProbabilities(allTeams);
  }, [allTeams]);

  const evShares = useMemo(() => {
    if (!allTeams.length) return {};
    // EV shares are pot-independent: EVi/totalEV = f(probs,payouts) ratios
    // Compute with basePot just to get relative shares
    const tempResults = {};
    for (const t of allTeams) tempResults[t.name] = computeTeamAnalysis(t, basePot, payouts, bonuses, allTeams, blowoutProbs);
    const totalEv = Object.values(tempResults).reduce((s, r) => s + r.totalEv, 0);
    if (totalEv <= 0) return {};
    const shares = {};
    for (const [name, r] of Object.entries(tempResults)) shares[name] = r.totalEv / totalEv;
    return shares;
  }, [allTeams, basePot, payouts, bonuses, blowoutProbs]);

  const potEstimate = useMemo(() => {
    return bayesianPotUpdate(basePot, sold, allTeams, evShares);
  }, [basePot, sold, allTeams, evShares]);
  const projectedPot = potEstimate.mean;

  // Compute all EVs
  const results = useMemo(() => {
    if (!allTeams.length) return {};
    const pot = projectedPot;
    const res = {};
    for (const t of allTeams) {
      res[t.name] = computeTeamAnalysis(t, pot, payouts, bonuses, allTeams, blowoutProbs);
    }
    return res;
  }, [allTeams, projectedPot, payouts, bonuses, blowoutProbs]);

  // Bracket-aware tournament simulation (correlated outcomes)
  // Only re-runs when team list changes, not on every pot update
  const simMatrix = useMemo(() => {
    if (allTeams.length < 4) return null;
    return simulateTournament(allTeams, MC_SIMS);
  }, [allTeams]);

  // Historical seed data parsed from CSV (needed by suggestions + display)
  const seedHistory = useMemo(() => {
    return parseHistoryCSV(historyCSV);
  }, [historyCSV]);

  // Selected team result
  const selectedResult = selectedTeam ? results[selectedTeam] : null;
  const bidNum = parseFloat(currentBid) || 0;

  // ============================================================
  // PERSISTENCE
  // ============================================================

  useEffect(() => {
    async function loadState() {
      try {
        const saved = await (window.storage ? window.storage.get(STORAGE_KEY).catch(() => null) : Promise.resolve(null))
          || (() => { try { const v = localStorage.getItem(STORAGE_KEY); return v ? { value: v } : null; } catch(e) { return null; } })();
        if (saved?.value) {
          const state = JSON.parse(saved.value);
          if (state.bracket) setBracket(state.bracket);
          if (state.sold) setSold(state.sold);
          if (state.myTeams) setMyTeams(state.myTeams);
          if (state.splitTeams) setSplitTeams(state.splitTeams);
          if (state.prevPortfolio) setPrevPortfolio(state.prevPortfolio);
          if (state.potOverride) setPotOverride(state.potOverride);
          if (state.budget) setBudget(state.budget);
          if (state.budgetCap) setBudgetCap(state.budgetCap);
          if (state.historyCSV) setHistoryCSV(state.historyCSV);
          if (state.stealAlerts) setStealAlerts(state.stealAlerts);
          if (state.bidderTotals) setBidderTotals(state.bidderTotals);
          if (state.searchFilter) setSearchFilter(state.searchFilter);
          if (state.selectedTeam) setSelectedTeam(state.selectedTeam);
          if (state.activeTab) setActiveTab(state.activeTab);
          if (state.currentBid) setCurrentBid(state.currentBid);
        }
        // Auto-load embedded previous portfolio (if not already loaded from saved state)
        if (!saved?.value || !JSON.parse(saved.value).prevPortfolio) {
          if (window.__CALCUTTA_PREV_PORTFOLIO) {
            const data = parsePrevPortfolioCSV(window.__CALCUTTA_PREV_PORTFOLIO);
            if (data.length > 0) {
              setPrevPortfolio(data);
              console.log("[Calcutta] Auto-loaded embedded previous portfolio:", data.length, "teams");
            }
          }
        }
      } catch (e) {
        // No saved state
      }
      setLoading(false);
    }
    loadState();
  }, []);

  const saveState = useCallback(
    async (overrides = {}) => {
      const state = {
        bracket: overrides.bracket !== undefined ? overrides.bracket : bracket,
        sold: overrides.sold !== undefined ? overrides.sold : sold,
        myTeams: overrides.myTeams !== undefined ? overrides.myTeams : myTeams,
        splitTeams: overrides.splitTeams !== undefined ? overrides.splitTeams : splitTeams,
        prevPortfolio: overrides.prevPortfolio !== undefined ? overrides.prevPortfolio : prevPortfolio,
        potOverride: overrides.potOverride !== undefined ? overrides.potOverride : potOverride,
        budget: overrides.budget !== undefined ? overrides.budget : budget,
        budgetCap: overrides.budgetCap !== undefined ? overrides.budgetCap : budgetCap,
        historyCSV: overrides.historyCSV !== undefined ? overrides.historyCSV : historyCSV,
        stealAlerts: overrides.stealAlerts !== undefined ? overrides.stealAlerts : stealAlerts,
        bidderTotals: overrides.bidderTotals !== undefined ? overrides.bidderTotals : bidderTotals,
        searchFilter: overrides.searchFilter !== undefined ? overrides.searchFilter : searchFilter,
        selectedTeam: overrides.selectedTeam !== undefined ? overrides.selectedTeam : selectedTeam,
        activeTab: overrides.activeTab !== undefined ? overrides.activeTab : activeTab,
        currentBid: overrides.currentBid !== undefined ? overrides.currentBid : currentBid,
      };
      try {
        await (window.storage ? window.storage.set(STORAGE_KEY, JSON.stringify(state)) : Promise.resolve());
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
      } catch (e) {
        console.error("Failed to save state:", e);
      }
    },
    [bracket, sold, myTeams, splitTeams, prevPortfolio, potOverride, budget, budgetCap, historyCSV, stealAlerts, bidderTotals, searchFilter, selectedTeam, activeTab, currentBid]
  );

  // Auto-save on changes
  useEffect(() => {
    if (!loading && bracket) saveState();
  }, [sold, myTeams, splitTeams, prevPortfolio, potOverride, budget, budgetCap, historyCSV, stealAlerts, bidderTotals, searchFilter, selectedTeam, activeTab, currentBid, loading]);

  // ============================================================
  // HANDLERS
  // ============================================================

  function loadBracket() {
    try {
      const data = JSON.parse(jsonInput);
      if (!data.regions) throw new Error("Missing 'regions' in JSON");
      setBracket(data);
      setSold({});
      setMyTeams({});
      setPotOverride(null);
      setJsonError("");
      saveState({ bracket: data, sold: {}, myTeams: {}, potOverride: null, historyCSV });
    } catch (e) {
      setJsonError(e.message);
    }
  }

  function loadSampleData() {
    setBracket(SAMPLE_BRACKET);
    setSold({ ...SAMPLE_SOLD });
    setMyTeams({ ...SAMPLE_MY_TEAMS });
    setPotOverride(null);
    setBudget(400);
    setSelectedTeam("Mississippi St");
    setCurrentBid("15");
    setActiveTab("analysis");
    setHistoryCSV(SAMPLE_HISTORY_CSV);
    setJsonError("");
    saveState({
      bracket: SAMPLE_BRACKET,
      sold: { ...SAMPLE_SOLD },
      myTeams: { ...SAMPLE_MY_TEAMS },
      potOverride: null,
      budget: 400,
      historyCSV: SAMPLE_HISTORY_CSV,
    });
  }

  /**
   * Parse CSV text into array of objects.
   * Handles quoted fields and trims whitespace.
   */
  function parseCSV(text) {
    const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return [];
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
    return lines.slice(1).map((line) => {
      const vals = [];
      let current = "", inQuotes = false;
      for (const ch of line) {
        if (ch === '"') { inQuotes = !inQuotes; }
        else if (ch === ',' && !inQuotes) { vals.push(current.trim()); current = ""; }
        else { current += ch; }
      }
      vals.push(current.trim());
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] || ""; });
      return obj;
    });
  }

  /**
   * Convert teams.csv + config.csv into bracket JSON.
   * Reads file inputs, parses, builds the bracket object.
   */
  function loadFromCSVs() {
    try {
      // Parse config
      if (!csvConfig) throw new Error("Please upload config.csv");
      const configRows = parseCSV(csvConfig);
      if (configRows.length === 0) throw new Error("config.csv is empty or has no data rows");
      const cfg = configRows[0];

      const potSize = parseFloat(cfg.pot_size) || 5000;
      const payouts = {
        "R64": parseFloat(cfg.payout_r64) || DEFAULT_PAYOUTS.R64,
        "R32": parseFloat(cfg.payout_r32) || DEFAULT_PAYOUTS.R32,
        "Sweet 16": parseFloat(cfg.payout_s16) || DEFAULT_PAYOUTS["Sweet 16"],
        "Elite 8": parseFloat(cfg.payout_e8) || DEFAULT_PAYOUTS["Elite 8"],
        "Final Four": parseFloat(cfg.payout_f4) || DEFAULT_PAYOUTS["Final Four"],
        "Championship": parseFloat(cfg.payout_champ) || DEFAULT_PAYOUTS.Championship,
      };
      const bonuses = {};
      if (cfg.bonus_womens_champ) bonuses.womens_champ = parseFloat(cfg.bonus_womens_champ);
      if (cfg.bonus_biggest_blowout) bonuses.biggest_blowout = parseFloat(cfg.bonus_biggest_blowout);
      if (cfg.bonus_heartbreaker) bonuses.heartbreaker = parseFloat(cfg.bonus_heartbreaker);

      // Parse teams
      if (!csvTeams) throw new Error("Please upload teams.csv");
      const teamRows = parseCSV(csvTeams);
      if (teamRows.length === 0) throw new Error("teams.csv is empty or has no data rows");

      // Build regions
      const regions = {};
      for (const row of teamRows) {
        const name = row.name;
        const seed = parseInt(row.seed);
        const region = row.region;
        if (!name || !seed || !region) throw new Error(`Invalid row: missing name/seed/region for "${name || "unknown"}"`);

        const team = { name, seed };

        // Required
        if (row.rating) team.rating = parseFloat(row.rating);

        // Optional KenPom stats
        if (row.adj_o) team.adj_o = parseFloat(row.adj_o);
        if (row.adj_d) team.adj_d = parseFloat(row.adj_d);
        if (row.adj_o_rank) team.adj_o_rank = parseInt(row.adj_o_rank);
        if (row.adj_d_rank) team.adj_d_rank = parseInt(row.adj_d_rank);
        if (row.adj_t) team.adj_t = parseFloat(row.adj_t);
        if (row.luck) team.luck = parseFloat(row.luck);

        // Vegas
        if (row.vegas_odds) team.vegas_odds = parseFloat(row.vegas_odds);

        // KenPom round probabilities
        const kp = [row.kenpom_r64, row.kenpom_r32, row.kenpom_s16, row.kenpom_e8, row.kenpom_f4, row.kenpom_champ];
        if (kp[0] && kp[5]) {
          team.kenpom_probs = kp.map((v) => parseFloat(v) || 0);
        }

        // Women's
        if (row.womens_win_prob) team.womens_win_prob = parseFloat(row.womens_win_prob);

        // Per-source values for disagreement flagging
        if (row.torvik_rating) team.torvik_rating = parseFloat(row.torvik_rating);
        if (row.kenpom_rating) team.kenpom_rating = parseFloat(row.kenpom_rating);
        if (row.torvik_adj_o_rank) team.torvik_adj_o_rank = parseInt(row.torvik_adj_o_rank);
        if (row.kenpom_adj_o_rank) team.kenpom_adj_o_rank = parseInt(row.kenpom_adj_o_rank);
        if (row.torvik_adj_d_rank) team.torvik_adj_d_rank = parseInt(row.torvik_adj_d_rank);
        if (row.kenpom_adj_d_rank) team.kenpom_adj_d_rank = parseInt(row.kenpom_adj_d_rank);

        if (!regions[region]) regions[region] = [];
        regions[region].push(team);
      }

      // Validate
      const regionNames = Object.keys(regions);
      if (regionNames.length !== 4) throw new Error(`Expected 4 regions, got ${regionNames.length}: ${regionNames.join(", ")}`);
      const totalTeams = Object.values(regions).reduce((s, r) => s + r.length, 0);
      if (totalTeams !== 64) throw new Error(`Expected 64 teams, got ${totalTeams}`);

      const bracketData = { pot_size: potSize, payouts, regions, bonuses };

      // Parse history if provided
      if (csvHistory) {
        setHistoryCSV(csvHistory);
      }

      setBracket(bracketData);
      setSold({});
      setMyTeams({});
      setPotOverride(null);
      setJsonError("");
      saveState({ bracket: bracketData, sold: {}, myTeams: {}, potOverride: null, historyCSV: csvHistory || "" });
    } catch (e) {
      setJsonError("CSV Error: " + e.message);
    }
  }

  // CSV file state for upload
  const [csvTeams, setCsvTeams] = useState("");
  const [csvConfig, setCsvConfig] = useState("");
  const [csvHistory, setCsvHistory] = useState("");
  const [setupMode, setSetupMode] = useState("csv"); // "csv" or "json"

  /**
   * Read a File object as text.
   */
  function readFile(file, setter) {
    const reader = new FileReader();
    reader.onload = (e) => setter(e.target.result);
    reader.readAsText(file);
  }

  function recordSale(isMine = false) {
    if (!selectedTeam || !bidNum) return;
    const newSold = { ...sold, [selectedTeam]: bidNum };
    const newMy = isMine ? { ...myTeams, [selectedTeam]: bidNum } : myTeams;
    setSold(newSold);
    if (isMine) setMyTeams(newMy);
    setCurrentBid("");
    saveState({ sold: newSold, myTeams: newMy });

    // Steal alert: fired when team sells for <60% of EV
    const r = results[selectedTeam];
    if (r && bidNum < r.totalEv * 0.6 && bidNum > 0) {
      const alert = {
        id: Date.now(),
        team: selectedTeam,
        seed: r.team.seed,
        price: bidNum,
        ev: r.totalEv,
        pct: bidNum / r.totalEv,
        isMine,
      };
      setStealAlerts((prev) => [alert, ...prev].slice(0, 5));
      // Auto-dismiss after 8 seconds
      setTimeout(() => setStealAlerts((prev) => prev.filter((a) => a.id !== alert.id)), 8000);
    }

    // Auto-advance to next unsold team
    const unsold = allTeams.filter((t) => !newSold[t.name]);
    if (unsold.length > 0) {
      const currentIdx = allTeams.findIndex((t) => t.name === selectedTeam);
      const next = allTeams.slice(currentIdx + 1).find((t) => !newSold[t.name]) || unsold[0];
      setSelectedTeam(next.name);
    }
    if (bidRef.current) bidRef.current.focus();
  }

  // Keyboard shortcuts (global)
  useEffect(() => {
    if (!bracket) return;
    function handleKey(e) {
      // Don't intercept when typing in an input/textarea
      const tag = e.target.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA";

      // / or Ctrl+K → focus search
      if ((e.key === "/" || (e.ctrlKey && e.key === "k")) && !isInput) {
        e.preventDefault();
        if (searchRef.current) searchRef.current.focus();
        return;
      }
      // Escape → clear search, blur inputs
      if (e.key === "Escape") {
        setSearchFilter("");
        e.target.blur?.();
        return;
      }
      // Enter in bid input already handled by onKeyDown

      // S → record sale (when not in input)
      if (e.key === "s" && !isInput && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        recordSale(false);
        return;
      }
      // M → record as mine (when not in input)
      if (e.key === "m" && !isInput && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        recordSale(true);
        return;
      }
      // B → focus bid input (when not in input)
      if (e.key === "b" && !isInput && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (bidRef.current) bidRef.current.focus();
        return;
      }
      // Z → undo (when not in input)
      if (e.key === "z" && !isInput && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        undoLastSale();
        return;
      }
      // Arrow up/down → navigate teams (when not in input)
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !isInput) {
        e.preventDefault();
        const list = showSoldInList ? allTeams : allTeams.filter((t) => !sold[t.name]);
        const idx = list.findIndex((t) => t.name === selectedTeam);
        const next = e.key === "ArrowDown" ? Math.min(idx + 1, list.length - 1) : Math.max(idx - 1, 0);
        if (list[next]) setSelectedTeam(list[next].name);
        return;
      }
      // 1-5 → switch tabs
      if (e.key >= "1" && e.key <= "6" && !isInput && !e.ctrlKey) {
        const tabs = ["analysis", "impact", "rounds", "vegas", "cheatsheet", "bracket", "tournament"];
        const idx = parseInt(e.key) - 1;
        if (idx < tabs.length) { e.preventDefault(); setActiveTab(tabs[idx]); }
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [bracket, selectedTeam, allTeams, sold, showSoldInList, bidNum]);

  function undoLastSale() {
    const names = Object.keys(sold);
    if (names.length === 0) return;
    const last = names[names.length - 1];
    const newSold = { ...sold };
    delete newSold[last];
    const newMy = { ...myTeams };
    delete newMy[last];
    setSold(newSold);
    setMyTeams(newMy);
    setSelectedTeam(last);
    saveState({ sold: newSold, myTeams: newMy });
  }

  function unrecordSale(teamName) {
    if (!sold[teamName]) return;
    const newSold = { ...sold };
    delete newSold[teamName];
    const newMy = { ...myTeams };
    delete newMy[teamName];
    setSold(newSold);
    setMyTeams(newMy);
    saveState({ sold: newSold, myTeams: newMy });
  }

  function toggleMine(teamName) {
    if (myTeams[teamName]) {
      const newMy = { ...myTeams };
      delete newMy[teamName];
      setMyTeams(newMy);
      saveState({ myTeams: newMy });
    } else if (sold[teamName]) {
      const newMy = { ...myTeams, [teamName]: sold[teamName] };
      setMyTeams(newMy);
      saveState({ myTeams: newMy });
    }
  }

  function resetAuction() {
    setSold({});
    setMyTeams({});
    setSplitTeams({});
    setCurrentBid("");
    setBudget(0);
    setStealAlerts([]);
    setSearchFilter("");
    setSelectedTeam(null);
    setActiveTab("analysis");
    saveState({ sold: {}, myTeams: {}, splitTeams: {}, budget: 0, stealAlerts: [], bidderTotals: {}, searchFilter: "", selectedTeam: null, activeTab: "analysis", currentBid: "" });
  }

  // ============================================================
  // COMPUTED VIEWS
  // ============================================================

  // Seed market — live over/underpay tracking for THIS auction
  const seedMarket = useMemo(() => {
    const bySeeds = {};
    for (const [name, price] of Object.entries(sold)) {
      const r = results[name];
      if (!r) continue;
      const seed = r.team.seed;
      if (!bySeeds[seed]) bySeeds[seed] = { seed, prices: [], evs: [], names: [] };
      bySeeds[seed].prices.push(price);
      bySeeds[seed].evs.push(r.totalEv);
      bySeeds[seed].names.push(name);
    }
    return Object.values(bySeeds)
      .map((s) => {
        const avgPrice = s.prices.reduce((a, b) => a + b, 0) / s.prices.length;
        const avgEv = s.evs.reduce((a, b) => a + b, 0) / s.evs.length;
        const bias = avgEv > 0 ? avgPrice / avgEv : 1;
        const overpay = avgPrice - avgEv;
        return { ...s, avgPrice, avgEv, bias, overpay, count: s.prices.length };
      })
      .sort((a, b) => a.seed - b.seed);
  }, [sold, results]);

  // Get seed bias for a specific seed (from current auction)
  const getSeedBias = useCallback((seed) => {
    return seedMarket.find((s) => s.seed === seed) || null;
  }, [seedMarket]);

  // Suggestions: top unsold teams by value score
  const suggestions = useMemo(() => {
    const unsold = allTeams.filter((t) => !sold[t.name]);
    if (!unsold.length || !Object.keys(results).length) return [];

    // Current region exposure
    const myRegionCounts = {};
    Object.keys(myTeams).forEach((name) => {
      const t = allTeams.find((x) => x.name === name);
      if (t) myRegionCounts[t.region] = (myRegionCounts[t.region] || 0) + 1;
    });

    // Current portfolio distribution for marginal P(profit) calc
    const hasPortfolio = Object.keys(myTeams).length > 0 && simMatrix;
    let currentDist = null;
    if (hasPortfolio) {
      const entries = Object.entries(myTeams).map(([n, p]) => ({ name: n, price: p }));
      currentDist = computePortfolioDistribution(entries, simMatrix, projectedPot, payouts, bonuses);
    }

    return unsold
      .map((t) => {
        const r = results[t.name];
        if (!r) return null;
        const price = r.maxBid;
        if (price <= 0) return null;

        // Budget filter
        if (budget > 0 && price > budget) return null;

        // Score 1: Absolute EV matters more than EV/dollar ratio.
        // A team with $800 EV is more valuable than one with $20 EV
        // even if the ratio is the same. Use sqrt(EV) to balance
        // absolute value with efficiency.
        const evScore = Math.sqrt(Math.max(r.totalEv, 1)) / 10;

        // Score 2: Region diversification
        const regionCount = myRegionCounts[t.region] || 0;
        let regionScore;
        if (regionCount === 0) regionScore = 1.25;
        else if (regionCount === 1) regionScore = 1.0;
        else regionScore = Math.max(0.7, 1.0 - (regionCount - 1) * 0.15);

        // Score 3: Portfolio hedge (marginal P(profit) from bracket-aware MC)
        let hedgeScore = 1.0;
        let marginalPProfit = null;
        let marginalP10 = null;
        if (hasPortfolio && currentDist && simMatrix) {
          const testEntries = [...Object.entries(myTeams).map(([n, p]) => ({ name: n, price: p })), { name: t.name, price }];
          const testDist = computePortfolioDistribution(testEntries, simMatrix, projectedPot, payouts, bonuses);
          if (testDist) {
            marginalPProfit = testDist.pProfit - currentDist.pProfit;
            marginalP10 = testDist.p10 - currentDist.p10;
            const profitBoost = marginalPProfit * 5.0;
            const totalCost = Object.values(myTeams).reduce((s, v) => s + v, 0) + price;
            const floorBoost = marginalP10 / Math.max(totalCost, 100) * 2.0;
            hedgeScore = Math.max(0.6, Math.min(1.8, 1.0 + profitBoost + floorBoost));
          }
        }

        // Score 4: Market bias (live auction + historical)
        let biasScore = 1.0;
        const liveSeedData = seedMarket.find((sm) => sm.seed === t.seed);
        const histSeedData = seedHistory?.seedStats?.[t.seed];
        // Prefer live bias if available, fall back to historical
        const effectiveBias = liveSeedData ? liveSeedData.bias : (histSeedData ? histSeedData.bias : 1.0);
        if (effectiveBias !== 1.0) {
          // Invert: overpaid seeds penalized, underpaid boosted
          biasScore = Math.max(0.7, Math.min(1.4, 1.0 / Math.pow(effectiveBias, 0.5)));
        }

        // Vegas upside bonus
        let vegasBonus = 1.0;
        if (r.vegasTitleProb && r.modelTitleProb && r.modelTitleProb > 0) {
          if (r.vegasTitleProb / r.modelTitleProb > VEGAS_DISAGREE_THRESHOLD) vegasBonus = 1.15;
        }

        // Profile bonus: champion-profile teams get a boost
        let profileBonus = 1.0;
        if (r.profile) {
          if (r.profile.champProfile) profileBonus *= 1.10;
          if (r.profile.lopsided) profileBonus *= 0.90;
          if (r.profile.lucky) profileBonus *= 0.93;
        }

        const combinedScore = evScore * regionScore * hedgeScore * biasScore * vegasBonus * profileBonus;

        // Tags
        const tags = [];
        if (regionCount === 0) tags.push("NEW RGN");
        if (vegasBonus > 1) tags.push("VEGAS ↑");
        if (r.totalEv > r.maxBid * 1.5) tags.push("HIGH EV");
        if (marginalPProfit != null && marginalPProfit > 0.02) tags.push("P(+) ↑");
        if (marginalP10 != null && marginalP10 > 0) tags.push("FLOOR ↑");
        if (biasScore > 1.15) tags.push(liveSeedData ? "BARGAIN 🏷️" : "HIST 💰");
        if (hedgeScore > 1.3) tags.push("HEDGE ✓");
        if (r.profile?.champProfile) tags.push("🏆 CHAMP");
        if (r.profile?.eliteDefense) tags.push("🛡️ ELITE D");
        if (r.profile?.lopsided) tags.push("🎲 LOPSIDED");
        if (r.profile?.lucky) tags.push("🍀 LUCKY");
        if (r.profile?.returning) tags.push("🔄 RETURNING");
        if (r.profile?.overseeded) tags.push("⬇️ OVERSEEDED");
        if (r.profile?.underseeded) tags.push("⬆️ UNDERSEEDED");
        if (r.profile?.sourceDisagree) tags.push("🔀 DISAGREE");

        // Brand premium from history
        let brandScore = 1.0;
        const bp = getSchoolBrandPremium(t.name, seedHistory?.schoolPremiums);
        if (bp) {
          if (bp.avgPremium > 0.2) { tags.push("🔥 NAME TAX"); brandScore *= 0.85; }
          else if (bp.avgPremium < -0.15) { tags.push("💎 STEALTH"); brandScore *= 1.15; }
          if (bp.loyalBidder) tags.push(`👤 ${bp.loyalBidder}`);
        }

        const combinedScore2 = combinedScore * brandScore;

        return {
          ...t, result: r, score: combinedScore2, tags,
          marginalPProfit, marginalP10, hedgeScore, regionScore, biasScore,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }, [allTeams, sold, results, myTeams, simMatrix, projectedPot, payouts, bonuses, budget, seedHistory, seedMarket]);

  // Budget optimizer: given remaining budget, find optimal team set
  const budgetOptimal = useMemo(() => {
    if (budget <= 0 || !Object.keys(results).length) return null;
    const unsold = allTeams.filter((t) => !sold[t.name]);
    if (unsold.length === 0) return null;

    // Greedy knapsack: pick teams by EV/maxBid ratio, respecting budget
    const candidates = unsold
      .map((t) => {
        const r = results[t.name];
        if (!r || r.maxBid <= 0) return null;
        return { name: t.name, seed: t.seed, region: t.region, ev: r.totalEv, price: r.maxBid };
      })
      .filter(Boolean)
      .sort((a, b) => (b.ev / b.price) - (a.ev / a.price));

    const picked = [];
    let remaining = budget;
    const usedRegions = {};
    Object.keys(myTeams).forEach((name) => {
      const t = allTeams.find((x) => x.name === name);
      if (t) usedRegions[t.region] = (usedRegions[t.region] || 0) + 1;
    });

    for (const c of candidates) {
      if (c.price > remaining) continue;
      // Prefer region diversification
      const regionPenalty = (usedRegions[c.region] || 0) >= 2 ? 0.7 : 1.0;
      const adjScore = (c.ev / c.price) * regionPenalty;
      if (adjScore < 0.8) continue; // skip bad value
      picked.push(c);
      remaining -= c.price;
      usedRegions[c.region] = (usedRegions[c.region] || 0) + 1;
      if (picked.length >= 6) break; // cap at 6 suggestions
    }

    const totalCost = picked.reduce((s, t) => s + t.price, 0);
    const totalEv = picked.reduce((s, t) => s + t.ev, 0);
    return { picks: picked, totalCost, totalEv, remaining: budget - totalCost };
  }, [budget, results, allTeams, sold, myTeams]);

  // CSV export function
  function exportCSV() {
    const rows = [["Team", "Seed", "Region", "EV", "MaxBid", "Sold Price", "My Team", "Edge", "Win%", "P(profit)", "Champ Profile", "Trapezoid", "Balanced", "Lopsided", "Lucky", "Profile Adj"]];
    for (const t of allTeams) {
      const r = results[t.name];
      if (!r) continue;
      const price = sold[t.name] || "";
      const isMine = myTeams[t.name] ? "Yes" : "";
      const edge = price ? (r.totalEv - price).toFixed(0) : "";
      const p = r.profile || {};
      rows.push([
        t.name, t.seed, t.region, r.totalEv.toFixed(0), r.maxBid.toFixed(0),
        price, isMine, edge, (r.winProb * 100).toFixed(2),
        portfolioDist?.perTeamStats?.find((ps) => ps.name === t.name)?.pProfit?.toFixed(3) || "",
        p.champProfile ? "Yes" : "", p.balanced ? "Yes" : "",
        p.lopsided ? "Yes" : "", p.lucky ? "Yes" : "",
        r.profileAdj != null ? ((r.profileAdj - 1) * 100).toFixed(1) + "%" : "",
      ]);
    }
    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `calcutta_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  // Portfolio stats
  const portfolio = useMemo(() => {
    // Full-ownership teams (current auction)
    const ownedTeams = Object.entries(myTeams).map(([name, price]) => ({
      name, price, share: 1.0, isBuyer: true, isSplit: false, isPrev: false, auction: "Current",
      result: results[name], team: allTeams.find((t) => t.name === name),
    }));
    // Split teams (current auction) — skip any that are also in myTeams (dedup)
    const splitEntries = Object.entries(splitTeams)
      .filter(([name]) => !myTeams[name])
      .map(([name, info]) => ({
        name, price: info.price, share: info.share || 0.5, isBuyer: !!info.isBuyer, isSplit: true, isPrev: false, auction: "Current",
        result: results[name], team: allTeams.find((t) => t.name === name),
      }));
    // Previous portfolio teams (from other auctions) — only included if toggle is on
    const prevEntries = (showPrevPortfolio && prevPortfolio.length > 0) ? prevPortfolio.map(p => ({
      name: p.team, price: p.pricePaid, share: p.share || 1.0, isBuyer: false, isSplit: p.share < 1, isPrev: true,
      auction: p.auction,
      // Use stored EV from the previous auction (computed at that pot)
      prevEv: p.ev, prevMaxBid: p.maxBid, prevPotSize: p.potSize,
      // Also try to find in current team list for region/seed info
      result: results[p.team], team: allTeams.find(t => t.name === p.team),
      region: p.region, seed: p.seed,
    })) : [];

    const currentTeams = [...ownedTeams, ...splitEntries];
    const allPortfolioTeams = [...currentTeams, ...prevEntries];

    // Current auction invested/EV
    const currentInvested = currentTeams.reduce((s, t) => s + t.price * t.share, 0);
    const currentEv = currentTeams.reduce((s, t) => s + (t.result?.totalEv || 0) * t.share, 0);
    // Cap spent = full price ONLY for teams where you're the buyer (current auction only)
    const capSpent = ownedTeams.reduce((s, t) => s + t.price, 0)
      + splitEntries.filter(t => t.isBuyer).reduce((s, t) => s + t.price, 0);

    // Previous auction invested/EV (using stored EVs, not current pot)
    const prevInvested = prevEntries.reduce((s, t) => s + t.price * t.share, 0);
    const prevEv = prevEntries.reduce((s, t) => s + (t.prevEv || 0) * t.share, 0);

    // Combined
    const totalInvested = currentInvested + prevInvested;
    const totalEv = currentEv + prevEv;

    // Regions across ALL owned teams
    const regions = {};
    allPortfolioTeams.forEach((t) => {
      const rgn = t.team?.region || t.region;
      if (rgn) regions[rgn] = (regions[rgn] || 0) + 1;
    });

    return {
      teams: allPortfolioTeams, currentTeams, prevEntries,
      totalInvested, capSpent, totalEv, edge: totalEv - totalInvested,
      currentInvested, currentEv, currentEdge: currentEv - currentInvested,
      prevInvested, prevEv, prevEdge: prevEv - prevInvested,
      regions,
    };
  }, [myTeams, splitTeams, results, allTeams, prevPortfolio, showPrevPortfolio]);

  // Monte Carlo portfolio distribution (bracket-aware)
  const portfolioDist = useMemo(() => {
    const entries = [
      ...Object.entries(myTeams).map(([name, price]) => ({ name, price, share: 1.0 })),
      ...Object.entries(splitTeams).map(([name, info]) => ({ name, price: info.price * info.share, share: info.share })),
    ];
    // Add previous portfolio teams for combined P(profit) and distribution
    if (showPrevPortfolio && prevPortfolio.length > 0) {
      for (const p of prevPortfolio) {
        // Build payout table from this auction's per-winner fractions
        let prevPayoutTable = null;
        if (p.payouts && p.potSize) {
          const ROUND_KEYS = ["R64", "R32", "Sweet 16", "Elite 8", "Final Four", "Championship"];
          prevPayoutTable = [0]; // 0 wins = $0
          let cum = 0;
          for (let i = 0; i < 6; i++) {
            cum += p.potSize * (p.payouts[ROUND_KEYS[i]] || 0);
            prevPayoutTable.push(cum);
          }
        }
        // Check if already in entries (doubling down)
        const existing = entries.find(e => e.name === p.team);
        if (existing) {
          existing.price += p.pricePaid * (p.share || 1);
          // Can't cleanly merge payout tables for doubles — use default
        } else {
          entries.push({
            name: p.team,
            price: p.pricePaid * (p.share || 1),
            share: p.share || 1,
            prevPayoutTable,
          });
        }
      }
    }
    if (entries.length === 0 || !simMatrix) return null;
    return computePortfolioDistribution(entries, simMatrix, projectedPot, payouts, bonuses);
  }, [myTeams, splitTeams, simMatrix, projectedPot, payouts, bonuses, prevPortfolio, showPrevPortfolio]);

  // Monte Carlo for previous portfolio ONLY (Jay's auction stats)
  const prevPortfolioDist = useMemo(() => {
    if (!showPrevPortfolio || prevPortfolio.length === 0 || !simMatrix) return null;
    const entries = [];
    for (const p of prevPortfolio) {
      let prevPayoutTable = null;
      if (p.payouts && p.potSize) {
        const RK = ["R64", "R32", "Sweet 16", "Elite 8", "Final Four", "Championship"];
        prevPayoutTable = [0];
        let cum = 0;
        for (let i = 0; i < 6; i++) { cum += p.potSize * (p.payouts[RK[i]] || 0); prevPayoutTable.push(cum); }
      }
      const existing = entries.find(e => e.name === p.team);
      if (existing) { existing.price += p.pricePaid * (p.share || 1); }
      else { entries.push({ name: p.team, price: p.pricePaid * (p.share || 1), share: p.share || 1, prevPayoutTable }); }
    }
    if (entries.length === 0) return null;
    return computePortfolioDistribution(entries, simMatrix, projectedPot, payouts, bonuses);
  }, [simMatrix, projectedPot, payouts, bonuses, prevPortfolio, showPrevPortfolio]);

  // Monte Carlo for current auction ONLY (when prev is toggled, portfolioDist is combined)
  const currentOnlyDist = useMemo(() => {
    if (!showPrevPortfolio || prevPortfolio.length === 0) return null; // Not needed — portfolioDist is already current-only
    const entries = [
      ...Object.entries(myTeams).map(([name, price]) => ({ name, price, share: 1.0 })),
      ...Object.entries(splitTeams).map(([name, info]) => ({ name, price: info.price * info.share, share: info.share })),
    ];
    if (entries.length === 0 || !simMatrix) return null;
    return computePortfolioDistribution(entries, simMatrix, projectedPot, payouts, bonuses);
  }, [myTeams, splitTeams, simMatrix, projectedPot, payouts, bonuses, showPrevPortfolio, prevPortfolio]);

  // Whatif impact: when selecting an unsold team with a bid entered
  const whatifImpact = useMemo(() => {
    if (!selectedTeam || !bidNum || bidNum <= 0) return null;
    // Build entry objects with per-auction payout tables
    const entries = [
      ...Object.entries(myTeams).map(([name, price]) => ({ name, price })),
      ...Object.entries(splitTeams).map(([name, info]) => ({ name, price: info.price * info.share })),
    ];
    if (showPrevPortfolio && prevPortfolio.length > 0) {
      for (const p of prevPortfolio) {
        let prevPayoutTable = null;
        if (p.payouts && p.potSize) {
          const RK = ["R64", "R32", "Sweet 16", "Elite 8", "Final Four", "Championship"];
          prevPayoutTable = [0];
          let cum = 0;
          for (let i = 0; i < 6; i++) { cum += p.potSize * (p.payouts[RK[i]] || 0); prevPayoutTable.push(cum); }
        }
        const existing = entries.find(e => e.name === p.team);
        if (existing) { existing.price += p.pricePaid * (p.share || 1); }
        else { entries.push({ name: p.team, price: p.pricePaid * (p.share || 1), prevPayoutTable }); }
      }
    }
    if (entries.length === 0) return null;
    // Only skip if owned in CURRENT auction. Prev portfolio = doubling down, show the impact.
    if (myTeams[selectedTeam] || splitTeams[selectedTeam]) return null;
    if (!simMatrix) return null;
    return computeWhatifImpact(entries, selectedTeam, bidNum, simMatrix, allTeams, projectedPot, payouts, bonuses);
  }, [selectedTeam, bidNum, myTeams, splitTeams, simMatrix, allTeams, projectedPot, payouts, bonuses, prevPortfolio, showPrevPortfolio]);

  // Region EVs
  const regionEVs = useMemo(() => {
    const evs = {};
    allTeams.forEach((t) => {
      const r = results[t.name];
      if (r) evs[t.region] = (evs[t.region] || 0) + r.totalEv;
    });
    return Object.entries(evs).sort((a, b) => b[1] - a[1]);
  }, [allTeams, results]);

  // Disagreements
  const disagreements = useMemo(() => {
    return Object.values(results)
      .filter((r) => r.vegasTitleProb && r.modelTitleProb && r.modelTitleProb > 0)
      .filter((r) => {
        const ratio = r.modelTitleProb / r.vegasTitleProb;
        return ratio > VEGAS_DISAGREE_THRESHOLD || ratio < 1 / VEGAS_DISAGREE_THRESHOLD;
      })
      .map((r) => ({
        ...r,
        direction: r.modelTitleProb > r.vegasTitleProb ? "Model HIGH" : "Vegas HIGH",
        isSold: !!sold[r.team.name],
      }))
      .sort((a, b) => Math.abs(b.vegasTitleProb - b.modelTitleProb) - Math.abs(a.vegasTitleProb - a.modelTitleProb));
  }, [results, sold]);

  // Filtered teams for list
  const filteredTeams = useMemo(() => {
    let list = allTeams;
    if (!showSoldInList) list = list.filter((t) => !sold[t.name]);
    if (searchFilter) {
      const q = searchFilter.toLowerCase();
      list = list.filter((t) => t.name.toLowerCase().includes(q) || `${t.seed}`.includes(q) || t.region.toLowerCase().includes(q));
    }
    return list;
  }, [allTeams, sold, showSoldInList, searchFilter]);

  // Pot tracker — projection history and stats
  const potTracker = useMemo(() => {
    const nSold = Object.keys(sold).length;
    const nTotal = allTeams.length || 64;
    const pctSold = nSold / nTotal;
    const avgPerTeam = nSold > 0 ? actualPotSoFar / nSold : 0;
    const unsoldEv = Object.values(results)
      .filter((r) => !sold[r.team.name])
      .reduce((s, r) => s + r.totalEv, 0);
    const delta = projectedPot - basePot;
    const direction = delta > basePot * 0.05 ? "HOT" : delta < -basePot * 0.05 ? "COLD" : "ON TRACK";
    const dirColor = direction === "HOT" ? "#22c55e" : direction === "COLD" ? "#ef4444" : "#eab308";
    return { nSold, nTotal, pctSold, avgPerTeam, unsoldEv, delta, direction, dirColor };
  }, [sold, allTeams, actualPotSoFar, projectedPot, basePot, results]);

  // Market temperature: are teams selling above or below model EV?
  // Top deals and overpays tracker
  const dealsTracker = useMemo(() => {
    // Build team → buyer reverse lookup from bidderTotals
    const buyerMap = {};
    for (const b of Object.values(bidderTotals)) {
      if (b.teamList) {
        for (const t of b.teamList) {
          buyerMap[t.name] = b.name;
        }
      }
    }
    const entries = [];
    for (const [name, price] of Object.entries(sold)) {
      const r = results[name];
      if (!r) continue;
      const edge = r.totalEv - price;
      const pct = r.totalEv > 0 ? edge / r.totalEv : 0;
      const team = allTeams.find(t => t.name === name);
      entries.push({ name, seed: team?.seed, region: team?.region, price, ev: r.totalEv, edge, pct, isMine: !!myTeams[name] || !!splitTeams[name], buyer: buyerMap[name] || null });
    }
    const sorted = [...entries].sort((a, b) => b.edge - a.edge);
    return {
      deals: sorted.slice(0, 10),
      overpays: sorted.slice(-10).reverse(),
    };
  }, [sold, results, allTeams, myTeams, splitTeams, bidderTotals]);

  const marketTemp = useMemo(() => {
    const soldEntries = Object.entries(sold);
    if (soldEntries.length < 3 || !Object.keys(results).length) return null;
    let totalPrice = 0, totalEv = 0, steals = [], overpays = [];
    for (const [name, price] of soldEntries) {
      const r = results[name];
      if (!r) continue;
      totalPrice += price;
      totalEv += r.totalEv;
      const edge = r.totalEv - price;
      const edgePct = r.totalEv > 0 ? edge / r.totalEv : 0;
      if (edgePct > 0.3) steals.push({ name, price, ev: r.totalEv, edge });
      if (edgePct < -0.3) overpays.push({ name, price, ev: r.totalEv, edge });
    }
    const ratio = totalEv > 0 ? totalPrice / totalEv : 1;
    const temp = ratio > 1.15 ? "🔥 HOT" : ratio < 0.85 ? "❄️ COLD" : ratio > 1.05 ? "📈 WARM" : ratio < 0.95 ? "📉 COOL" : "➡️ FAIR";
    const color = ratio > 1.1 ? "#ef4444" : ratio < 0.9 ? "#22c55e" : "#eab308";
    const advice = ratio > 1.15
      ? "Group is overpaying — be patient, let others chase. Deals will come."
      : ratio < 0.85
        ? "Deals everywhere — teams going cheap. Buy now but don't bid against yourself."
        : ratio > 1.05
          ? "Slight premium — stay disciplined, don't chase above max bid."
          : ratio < 0.95
            ? "Group is undervaluing teams — good buying conditions. Lowball and see what sticks."
            : "Prices tracking model closely. Stick to your max bids.";
    return { ratio, temp, color, advice, steals, overpays, nSold: soldEntries.length };
  }, [sold, results]);

  // Live steal alert: fires when current auction item is way below EV
  const liveStealAlert = useMemo(() => {
    if (!liveCurrentItem || !results[liveCurrentItem]) return null;
    const r = results[liveCurrentItem];
    if (!r || liveBid <= 0) return null;
    const edge = r.totalEv - liveBid;
    const edgePct = r.totalEv > 0 ? edge / r.totalEv : 0;
    if (edgePct > 0.4) return { team: liveCurrentItem, bid: liveBid, ev: r.totalEv, edge, pct: edgePct };
    return null;
  }, [liveCurrentItem, liveBid, results]);

  // ── Top-level recommendation: synthesize all signals into one action ──
  const recommendation = useMemo(() => {
    const currentTeam = liveCurrentItem || selectedTeam;
    if (!currentTeam) return { icon: "👋", text: "Select a team to analyze", color: "#64748b", bg: "transparent" };

    const team = allTeams.find(t => t.name === currentTeam);
    const r = results[currentTeam];
    if (!team || !r) return { icon: "❓", text: "No analysis available for " + currentTeam, color: "#64748b", bg: "transparent" };

    const isSold = sold[currentTeam] != null;
    if (isSold) return { icon: "✅", text: currentTeam + " is sold. Look for the next opportunity.", color: "#64748b", bg: "transparent" };

    const bid = liveBid > 0 ? liveBid : bidNum;
    const ev = r.totalEv;
    const splitShare = splitPreview.active ? splitPreview.share : 1.0;
    const myEv = ev * splitShare;
    const myCost = (bid || r.maxBid) * splitShare;
    const edge = myEv - myCost;
    const splitLabel = splitShare < 1 ? " (" + Math.round(splitShare * 100) + "% split)" : "";
    const myTeamNames = [...new Set([...Object.keys(myTeams), ...Object.keys(splitTeams)])];
    const nMyTeams = myTeamNames.length;
    const myCapSpent = Object.values(myTeams).reduce((s, v) => s + v, 0)
      + Object.values(splitTeams).filter(s => s.isBuyer).reduce((s, v) => s + v.price, 0);
    const cap = budgetCap || 0;
    const budgetLeft = cap - myCapSpent;

    // ── You have the winning bid ──
    const iAmWinning = liveBidIsMine && liveBid > 0 && currentTeam === liveCurrentItem;
    if (iAmWinning) {
      const myBidCost = liveBid * splitShare;
      const myBidEv = ev * splitShare;
      const edgeAtMyBid = myBidEv - myBidCost;
      const edgePct = myBidEv > 0 ? edgeAtMyBid / myBidEv : 0;
      if (edgePct > 0.3) {
        return { icon: "✅", text: "YOU'RE WINNING" + splitLabel + " at $" + Math.round(liveBid) + (splitShare < 1 ? " (your share: $" + Math.round(myBidCost) + ")" : "") + " — edge: +$" + Math.round(edgeAtMyBid) + ". Don't bid against yourself.",
          color: "#22c55e", bg: "rgba(34,197,94,0.1)" };
      }
      if (edgeAtMyBid > 0) {
        return { icon: "✅", text: "YOU'RE WINNING" + splitLabel + " at $" + Math.round(liveBid) + (splitShare < 1 ? " (your $" + Math.round(myBidCost) + ", EV $" + Math.round(myBidEv) + ")" : "") + " — still under EV. Hold steady.",
          color: "#4ade80", bg: "rgba(74,222,128,0.06)" };
      }
      if (edgeAtMyBid > -myBidEv * 0.1) {
        return { icon: "🤏", text: "YOU'RE WINNING" + splitLabel + " at $" + Math.round(liveBid) + " — close to EV. Let it ride but don't go higher.",
          color: "#eab308", bg: "rgba(234,179,8,0.06)" };
      }
      return { icon: "😬", text: "YOU'RE WINNING" + splitLabel + " at $" + Math.round(liveBid) + " — overpaid" + (splitShare < 1 ? " (your $" + Math.round(myBidCost) + " vs EV $" + Math.round(myBidEv) + ")" : "") + ". Don't raise it.",
        color: "#f97316", bg: "rgba(249,115,22,0.06)" };
    }

    // ── Bracket conflict check (R64 through E8, cross-auction aware) ──
    const R64_PAIRS = [[1,16],[8,9],[5,12],[4,13],[6,11],[3,14],[7,10],[2,15]];
    const R32_GROUPS = [[[1,16],[8,9]], [[5,12],[4,13]], [[6,11],[3,14]], [[7,10],[2,15]]];
    const S16_GROUPS = [[[1,16],[8,9],[5,12],[4,13]], [[6,11],[3,14],[7,10],[2,15]]];
    const EV_REMAINING = { R64: 0.92, R32: 0.80, S16: 0.63 };

    // Build unified list of all owned teams (current + previous auctions)
    const allOwnedForConflict = [];
    for (const myName of myTeamNames) {
      const myT = allTeams.find(t => t.name === myName);
      const myR = results[myName];
      if (myT) allOwnedForConflict.push({ name: myName, seed: myT.seed, region: myT.region, ev: myR?.totalEv || 0, auction: "Current" });
    }
    if (showPrevPortfolio) {
      for (const p of prevPortfolio) {
        allOwnedForConflict.push({ name: p.team, seed: p.seed, region: p.region, ev: p.ev * (p.share || 1), auction: p.auction });
      }
    }

    let conflicts = [];
    let hasDouble = null;
    for (const owned of allOwnedForConflict) {
      if (owned.region !== team.region) continue;
      const isCross = owned.auction !== "Current";
      const label = isCross ? " (" + owned.auction + ")" : "";

      // Same team = doubling down
      if (owned.name === currentTeam) {
        if (isCross) hasDouble = { round: "DOUBLE", opponent: owned.name + label, wastedEv: 0, severity: "info", crossAuction: true };
        continue;
      }

      // Get round probs for the owned team (how likely they advance to each round)
      const ownedResult = results[owned.name];
      const ownedProbs = ownedResult?.roundProbs || [0.5, 0.25, 0.12, 0.06, 0.03, 0.01]; // fallback
      const candidateProbs = r.roundProbs || [0.5, 0.25, 0.12, 0.06, 0.03, 0.01];

      // P(both reach round) — the chance the overlap actually fires
      // R64: both start here (P=1), but one eliminates the other
      // R32: both must win R64 → P = ownedProbs[0] × candidateProbs[0]
      // S16: both must win through R32 → P = ownedProbs[1] × candidateProbs[1]
      // E8: both must win through S16 → P = ownedProbs[2] × candidateProbs[2]
      const meetProb = {
        R64: 1.0,
        R32: ownedProbs[0] * candidateProbs[0],
        S16: ownedProbs[1] * candidateProbs[1],
        E8: ownedProbs[2] * candidateProbs[2],
      };

      const addConflict = (round, wastedEv, severityFn) => {
        const sev = severityFn(wastedEv);
        const pMeet = meetProb[round] || 0.15;
        conflicts.push({ round, opponent: owned.name + label, wastedEv, severity: sev, crossAuction: isCross, pMeet });
      };

      // R64 — direct opponents, one MUST eliminate the other. Always high severity.
      let foundEarly = false;
      for (const [a, b] of R64_PAIRS) {
        if ((owned.seed === a && team.seed === b) || (owned.seed === b && team.seed === a)) {
          addConflict("R64", Math.min(owned.ev * EV_REMAINING.R64, ev * EV_REMAINING.R64), w => "high");
          foundEarly = true;
        }
      }
      // R32
      if (!foundEarly) {
        for (const group of R32_GROUPS) {
          const seeds = group.flat();
          if (seeds.includes(owned.seed) && seeds.includes(team.seed) && owned.seed !== team.seed) {
            if (R64_PAIRS.some(p => (p[0] === owned.seed && p[1] === team.seed) || (p[1] === owned.seed && p[0] === team.seed))) continue;
            addConflict("R32", Math.min(owned.ev * EV_REMAINING.R32, ev * EV_REMAINING.R32), w => w > 150 ? "high" : w > 50 ? "medium" : "low");
            foundEarly = true;
          }
        }
      }
      // S16
      if (!foundEarly) {
        for (const group of S16_GROUPS) {
          const seeds = group.flat();
          if (seeds.includes(owned.seed) && seeds.includes(team.seed) && owned.seed !== team.seed) {
            const caught = R64_PAIRS.some(p => (p[0] === owned.seed && p[1] === team.seed) || (p[1] === owned.seed && p[0] === team.seed))
              || R32_GROUPS.some(g => g.flat().includes(owned.seed) && g.flat().includes(team.seed));
            if (caught) continue;
            addConflict("S16", Math.min(owned.ev * EV_REMAINING.S16, ev * EV_REMAINING.S16), w => w > 150 ? "medium" : "low");
            foundEarly = true;
          }
        }
      }
      // E8
      if (!foundEarly) {
        const sameS16 = S16_GROUPS.some(g => { const s = g.flat(); return s.includes(owned.seed) && s.includes(team.seed); });
        if (!sameS16 && owned.seed !== team.seed) {
          addConflict("E8", Math.min(owned.ev * 0.50, ev * 0.50), w => w > 200 ? "medium" : "low");
        }
      }
    }

    // Pick the worst conflict for the main banner, but report total overlap cost
    const totalWastedEv = conflicts.reduce((s, c) => s + c.wastedEv, 0);
    const worstConflict = conflicts.sort((a, b) => {
      const order = { high: 3, medium: 2, low: 1 };
      return (order[b.severity] || 0) - (order[a.severity] || 0) || b.wastedEv - a.wastedEv;
    })[0] || null;
    // Build conflict for use in recommendation: worst conflict + aggregate info
    const conflict = worstConflict ? {
      ...worstConflict,
      totalWastedEv,
      allConflicts: conflicts,
      count: conflicts.length,
    } : hasDouble;

    // Handle doubling down
    if (conflict && conflict.round === "DOUBLE") {
      const prevEntry = prevPortfolio.find(p => p.team === currentTeam);
      if (prevEntry) {
        const prevCost = prevEntry.pricePaid * (prevEntry.share || 1);
        const prevEv = prevEntry.ev * (prevEntry.share || 1);
        return { icon: "📊", text: "DOUBLING DOWN: You own " + currentTeam + " from " + prevEntry.auction + " ($" + Math.round(prevCost) + " invested, EV $" + Math.round(prevEv) + "). " +
          "Both investments ride on the same outcomes. " +
          (bid > 0 ? "Total exposure: $" + Math.round(prevCost + bid * splitShare) + " across auctions." : ""),
          color: "#818cf8", bg: "rgba(129,140,248,0.08)" };
      }
    }

    // ── Decision priority chain ──

    // 1. Budget exhausted
    if (budgetLeft <= 0 && cap > 0) {
      return { icon: "🚫", text: "You've hit your cap ($" + cap + "). No more purchases unless this is your last team.", color: "#ef4444", bg: "rgba(239,68,68,0.08)" };
    }

    // 2. Bracket conflict — edge vs actual overlap cost
    if (conflict && conflict.allConflicts && conflict.allConflicts.length > 0) {
      const bidPrice = bid || r.maxBid;
      const edgeAtBid = ev - bidPrice;
      // Sum costs: each conflict's wasted EV × actual probability both teams get there
      const totalEffectiveCost = conflict.allConflicts.reduce((s, c) => s + c.wastedEv * c.pMeet, 0);
      const netEdge = edgeAtBid - totalEffectiveCost;
      const conflictList = conflict.allConflicts.map(c => c.opponent + " " + c.round + " (" + Math.round(c.pMeet * 100) + "%)").join(", ");
      const nConflicts = conflict.allConflicts.length;
      const plural = nConflicts > 1;
      
      if (bid > 0 && netEdge > totalEffectiveCost * 0.5) {
        return { icon: "⚠️", text: "OVERLAP" + (plural ? " ×" + nConflicts : "") + ": " + conflictList + ". If both advance, one kills the other's remaining payouts. Avg cost: $" + Math.round(totalEffectiveCost) + ". Edge +$" + Math.round(edgeAtBid) + " easily covers it → net +$" + Math.round(netEdge) + ". BUY.",
          color: "#f97316", bg: "rgba(249,115,22,0.08)" };
      }
      if (bid > 0 && netEdge > 0) {
        return { icon: "⚠️", text: "OVERLAP" + (plural ? " ×" + nConflicts : "") + ": " + conflictList + ". Avg cost $" + Math.round(totalEffectiveCost) + ". Edge +$" + Math.round(edgeAtBid) + " narrowly covers it (net +$" + Math.round(netEdge) + "). Check Impact tab.",
          color: "#f97316", bg: "rgba(249,115,22,0.08)" };
      }
      if (bid > 0 && edgeAtBid > 0) {
        return { icon: "⚔️", text: "OVERLAP" + (plural ? " ×" + nConflicts : "") + ": " + conflictList + ". Avg cost $" + Math.round(totalEffectiveCost) + " eats your +$" + Math.round(edgeAtBid) + " edge. Check Impact tab — may still work.",
          color: "#ef4444", bg: "rgba(239,68,68,0.08)" };
      }
      return { icon: "⚔️", text: "OVERLAP" + (plural ? " ×" + nConflicts : "") + ": " + conflictList + ". Avg cost $" + Math.round(totalEffectiveCost) + "." + (bid > 0 ? " Negative edge at $" + Math.round(bid) + "." : " Avoid unless it's a steal."),
        color: "#ef4444", bg: "rgba(239,68,68,0.08)" };
    }

    // 3. Steal alert (live bid way below EV)
    if (bid > 0 && ev > 0 && (ev - bid) / ev > 0.4) {
      return { icon: "🚨", text: "STEAL — " + currentTeam + " at $" + Math.round(bid) + " is " + Math.round((ev - bid) / ev * 100) + "% below EV ($" + Math.round(ev) + "). BID NOW.",
        color: "#22c55e", bg: "rgba(34,197,94,0.1)" };
    }

    // 4. Queue: whale ahead with cap bidders
    const upcoming = showUpcoming ? upcomingQueue : [];
    const upcomingResolved = upcoming.slice(0, 5).map(u => {
      const t = allTeams.find(x => x.name === u.name) || allTeams.find(x => x.name.toLowerCase().replace(/\./g, "") === u.name.toLowerCase().replace(/\./g, ""));
      if (!t || !results[t.name]) return null;
      const uEv = results[t.name].totalEv;
      // seedHistory may not be in this scope — use seedAvgFrac from parent if available
      return { name: t.name, ev: uEv, edge: uEv * 0.15 }; // approximate: avg 15% edge in Jay's group
    }).filter(Boolean);
    const whaleAhead = upcomingResolved.find(u => u.ev > 400 && u.edge > 30);

    // Count cap bidders
    const bt = Object.values(bidderTotals);
    let capBidders = 0;
    for (const b of bt) {
      if ((b.spent || 0) < cap && (b.spent || 0) + (r.maxBid || 200) > cap) capBidders++;
    }

    // Current team's approximate edge
    const currentExpEdge = ev * 0.15; // rough estimate — strategy function has precise version

    if (whaleAhead && capBidders >= 3 && currentExpEdge < whaleAhead.edge) {
      return { icon: "🐋", text: "WAIT — " + whaleAhead.name + " (EV $" + Math.round(whaleAhead.ev) + ") is coming soon. " + capBidders + " cap bidders will fight over it and tap out. Buy AFTER the whale.",
        color: "#818cf8", bg: "rgba(129,140,248,0.08)" };
    }

    // 5. Better edge coming
    if (whaleAhead && currentExpEdge < 50 && whaleAhead.edge > currentExpEdge * 2) {
      return { icon: "⏳", text: "WAIT — " + whaleAhead.name + " (EV $" + Math.round(whaleAhead.ev) + ") has bigger edge potential. Save your budget.",
        color: "#818cf8", bg: "rgba(129,140,248,0.08)" };
    }

    // 6. (Medium conflicts now handled in section 2 above)

    // 6b. Low severity bracket overlap — don't block, but inform
    if (conflict && conflict.severity === "low" && conflict.allConflicts) {
      const bidPrice = bid || r.maxBid;
      const edgeAtBid = ev - bidPrice;
      const totalEffCost = conflict.allConflicts.reduce((s, c) => s + c.wastedEv * c.pMeet, 0);
      const conflictList = conflict.allConflicts.map(c => c.opponent + " " + c.round).join(", ");
      if (bid > 0 && edgeAtBid > totalEffCost) {
        return { icon: "ℹ️", text: "Small overlap: " + conflictList + ". Rarely matters (~$" + Math.round(totalEffCost) + " avg cost). Edge +$" + Math.round(edgeAtBid) + " covers it easily.",
          color: "#94a3b8", bg: "transparent" };
      }
      // Fall through to normal edge-based recommendation
    }

    // 7. Wave active — many cap bidders fighting
    if (capBidders >= 4 && bt.length > 0) {
      const freeBidders = bt.filter(b => (b.spent || 0) + (r.maxBid || 200) <= cap).length;
      if (capBidders > freeBidders && ev < 400) {
        return { icon: "🌊", text: "WAVE — " + capBidders + " cap bidders are fighting. Prices are inflated. Let them burn cash and buy the next one cheaper.",
          color: "#f59e0b", bg: "rgba(245,158,11,0.08)" };
      }
    }

    // 8. Dry spell ahead — this is the best edge for a while
    const drySpell = upcomingResolved.length >= 3 && upcomingResolved.slice(0, 4).every(u => u.edge < 20);
    if (drySpell && currentExpEdge > 30) {
      return { icon: "⭐", text: "BID — Best edge for a while. Next " + Math.min(4, upcomingResolved.length) + " teams all have thin expected edge. Open at $" + Math.round(r.maxBid * 0.6) + ", max $" + Math.round(r.maxBid) + ".",
        color: "#22c55e", bg: "rgba(34,197,94,0.08)" };
    }

    // 9. Edge-based recommendation at current bid
    if (bid > 0) {
      if (edge > myEv * 0.3) {
        return { icon: "💰", text: "BUY" + splitLabel + " — $" + Math.round(bid) + (splitShare < 1 ? " (your share: $" + Math.round(myCost) + ")" : "") + ". Strong edge +$" + Math.round(edge) + ".",
          color: "#22c55e", bg: "rgba(34,197,94,0.08)" };
      }
      if (edge > 0) {
        return { icon: "👍", text: "GOOD PRICE" + splitLabel + " — $" + Math.round(bid) + (splitShare < 1 ? " (your $" + Math.round(myCost) + ", EV $" + Math.round(myEv) + ")" : " under EV ($" + Math.round(ev) + ")") + ". Edge: +$" + Math.round(edge) + ".",
          color: "#4ade80", bg: "rgba(74,222,128,0.06)" };
      }
      if (edge > -myEv * 0.1) {
        return { icon: "🤏", text: "FAIR PRICE" + splitLabel + " — $" + Math.round(bid) + (splitShare < 1 ? " (your $" + Math.round(myCost) + " vs EV $" + Math.round(myEv) + ")" : " close to EV ($" + Math.round(ev) + ")") + ". Thin margin.",
          color: "#eab308", bg: "rgba(234,179,8,0.06)" };
      }
      return { icon: "🛑", text: "OVERPRICED" + splitLabel + " — $" + Math.round(bid) + (splitShare < 1 ? " (your $" + Math.round(myCost) + " exceeds your EV $" + Math.round(myEv) + ")" : " exceeds EV ($" + Math.round(ev) + ")") + " by $" + Math.round(Math.abs(edge)) + ".",
        color: "#ef4444", bg: "rgba(239,68,68,0.06)" };
    }

    // 10. No bid entered — show general recommendation
    if (nMyTeams === 0 && Object.keys(sold).length > 10) {
      return { icon: "⏰", text: "You own 0 teams and " + Object.keys(sold).length + " are sold. You need to get on the board soon. Open at $" + Math.round(r.maxBid * 0.6) + ".",
        color: "#f97316", bg: "rgba(249,115,22,0.06)" };
    }

    if (r.profile?.champProfile && ev > 200) {
      return { icon: "🏆", text: "TARGET — " + currentTeam + " has a championship profile. EV: $" + Math.round(ev) + ", max bid: $" + Math.round(r.maxBid) + ". Worth pursuing.",
        color: "#fbbf24", bg: "rgba(251,191,36,0.06)" };
    }

    return { icon: "📊", text: currentTeam + " — EV: $" + Math.round(ev) + " | Max bid: $" + Math.round(r.maxBid) + " | Enter a bid to see edge analysis.",
      color: "#94a3b8", bg: "rgba(148,163,184,0.04)" };

  }, [liveCurrentItem, selectedTeam, allTeams, results, sold, liveBid, liveBidIsMine, bidNum, myTeams, splitTeams, budgetCap, bidderTotals, showUpcoming, upcomingQueue, splitPreview, prevPortfolio, showPrevPortfolio]);

  // ============================================================
  // RENDER HELPERS (use top-level fmt/pct)
  // ============================================================

  // ============================================================
  // SETUP SCREEN
  // ============================================================

  if (loading) {
    return (
      <div style={styles.loadingScreen}>
        <div style={styles.loadingText}>Loading auction state...</div>
      </div>
    );
  }

  if (!bracket) {
    return (
      <div style={styles.setupScreen}>
        <div style={styles.setupCard}>
          <div style={styles.setupLogo}>🏀</div>
          <h1 style={styles.setupTitle}>CALCUTTA AUCTION</h1>

          {/* Mode toggle */}
          <div style={{ display: "flex", gap: 0, justifyContent: "center", marginBottom: 16 }}>
            <button
              style={{ ...styles.setupToggle, ...(setupMode === "csv" ? styles.setupToggleActive : {}) }}
              onClick={() => setSetupMode("csv")}
            >📄 Upload CSVs</button>
            <button
              style={{ ...styles.setupToggle, ...(setupMode === "json" ? styles.setupToggleActive : {}) }}
              onClick={() => setSetupMode("json")}
            >{ } Paste JSON</button>
          </div>

          {setupMode === "csv" ? (
            <>
              <p style={styles.setupSubtitle}>Upload your data files to begin</p>

              {/* Teams CSV */}
              <div style={styles.csvUploadRow}>
                <div style={styles.csvUploadLabel}>
                  <strong>teams.csv</strong> <span style={{ color: "#ef4444" }}>required</span>
                  <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>
                    64 rows: name, seed, region, rating, adj_o_rank, adj_d_rank, adj_t, luck, vegas_odds, kenpom_r64–kenpom_champ
                  </div>
                </div>
                <label style={styles.csvFileLabel}>
                  {csvTeams ? `✅ ${csvTeams.split("\n").filter(Boolean).length - 1} rows` : "Choose file"}
                  <input type="file" accept=".csv,.txt" style={{ display: "none" }}
                    onChange={(e) => e.target.files[0] && readFile(e.target.files[0], setCsvTeams)} />
                </label>
              </div>

              {/* Config CSV */}
              <div style={styles.csvUploadRow}>
                <div style={styles.csvUploadLabel}>
                  <strong>config.csv</strong> <span style={{ color: "#ef4444" }}>required</span>
                  <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>
                    1 row: pot_size, payout_r64 through payout_champ, bonus_womens_champ, bonus_biggest_blowout, bonus_heartbreaker
                  </div>
                </div>
                <label style={styles.csvFileLabel}>
                  {csvConfig ? "✅ Loaded" : "Choose file"}
                  <input type="file" accept=".csv,.txt" style={{ display: "none" }}
                    onChange={(e) => e.target.files[0] && readFile(e.target.files[0], setCsvConfig)} />
                </label>
              </div>

              {/* History CSV */}
              <div style={styles.csvUploadRow}>
                <div style={styles.csvUploadLabel}>
                  <strong>history.csv</strong> <span style={{ color: "#64748b" }}>optional</span>
                  <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>
                    Past auctions: year, team, seed, price_paid, rounds_won, payout_received
                  </div>
                </div>
                <label style={styles.csvFileLabel}>
                  {csvHistory ? `✅ ${csvHistory.split("\n").filter(Boolean).length - 1} rows` : "Choose file"}
                  <input type="file" accept=".csv,.txt" style={{ display: "none" }}
                    onChange={(e) => e.target.files[0] && readFile(e.target.files[0], setCsvHistory)} />
                </label>
              </div>

              {/* Preview */}
              {csvTeams && (
                <div style={{ marginTop: 12, padding: "8px 12px", background: "#0f172a", borderRadius: 8, fontSize: 11, color: "#94a3b8", maxHeight: 120, overflow: "auto" }}>
                  <div style={{ fontWeight: 700, color: "#e2e8f0", marginBottom: 4 }}>teams.csv preview:</div>
                  {csvTeams.split("\n").slice(0, 5).map((line, i) => (
                    <div key={i} style={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>{line}</div>
                  ))}
                  {csvTeams.split("\n").length > 5 && <div style={{ color: "#64748b" }}>... {csvTeams.split("\n").length - 5} more rows</div>}
                </div>
              )}
            </>
          ) : (
            <>
              <p style={styles.setupSubtitle}>Paste your bracket JSON to begin</p>
              <textarea
                style={styles.jsonTextarea}
                value={jsonInput}
                onChange={(e) => setJsonInput(e.target.value)}
                placeholder={`{\n  "pot_size": 5000,\n  "payouts": { "R64": 0.025, ... },\n  "regions": {\n    "South": [\n      { "name": "Houston", "seed": 1, "rating": 29.5, "vegas_odds": 500,\n        "kenpom_probs": [0.99, 0.89, 0.72, 0.56, 0.38, 0.23],\n        "adj_o": 118.5, "adj_d": 89.0, "adj_o_rank": 13, "adj_d_rank": 7,\n        "adj_t": 66.2, "luck": 0.018 },\n      ...\n    ]\n  }\n}`}
                spellCheck={false}
              />
              <p style={{ ...styles.setupSubtitle, marginTop: 16, marginBottom: 6, fontSize: 13 }}>
                📜 Past Auction History (optional CSV)
              </p>
              <textarea
                style={{ ...styles.jsonTextarea, height: 100 }}
                value={historyCSV}
                onChange={(e) => setHistoryCSV(e.target.value)}
                placeholder="year,team,seed,price_paid,rounds_won,payout_received&#10;2023,Gonzaga,1,1200,2,200&#10;2023,Alabama,1,1100,2,200"
                spellCheck={false}
              />
            </>
          )}

          {jsonError && <div style={styles.jsonError}>{jsonError}</div>}
          <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 16 }}>
            {setupMode === "csv" ? (
              <button style={styles.loadBtn} onClick={loadFromCSVs} disabled={!csvTeams || !csvConfig}>
                Load from CSVs
              </button>
            ) : (
              <button style={styles.loadBtn} onClick={loadBracket}>
                Load Bracket
              </button>
            )}
            <button
              style={{ ...styles.loadBtn, background: "#7c3aed" }}
              onClick={loadSampleData}
            >
              Load Sample Auction
            </button>
          </div>
          <p style={styles.setupHint}>
            <strong>Load Sample Auction</strong> drops you into a mid-auction with 30 teams sold,
            6 in your portfolio, and Vegas odds — perfect for exploring the dashboard.
          </p>
        </div>
      </div>
    );
  }

  // ============================================================
  // MAIN DASHBOARD
  // ============================================================

  const nSold = Object.keys(sold).length;
  const nTotal = allTeams.length;

  return (
    <div style={styles.container}>
      {/* TOP BAR */}
      <div style={styles.topBar}>
        <div style={styles.topLeft}>
          <span style={styles.topLogo}>🏀</span>
          <span style={styles.topTitle}>CALCUTTA</span>
        </div>
        <div style={styles.topStats}>
          <HelpTip active={helpMode} text="How many teams have been auctioned out of the total. Track auction progress here.">
            <StatPill label="Sold" value={`${nSold}/${nTotal}`} />
          </HelpTip>
          <HelpTip active={helpMode} text="Bayesian estimate of the final pot size. Updates live as each team sells — early sales are noisy, later estimates are tighter.">
            <StatPill label="Pot" value={fmt(projectedPot)} accent />
          </HelpTip>
          <HelpTip active={helpMode} text="Actual money collected so far from all sales. Compare this to the projected pot to see how the auction is tracking.">
            <StatPill label="Collected" value={fmt(actualPotSoFar)} />
          </HelpTip>
          <HelpTip active={helpMode} text="Number of teams you've bought in this auction.">
            <StatPill label="My Teams" value={`${new Set([...Object.keys(myTeams), ...Object.keys(splitTeams)]).size}`} />
          </HelpTip>
          <HelpTip active={helpMode} text="Total dollars invested in this auction (your share for splits).">
            <StatPill label="My Cost" value={fmt(portfolio.currentInvested)} />
          </HelpTip>
          <HelpTip active={helpMode} text="Combined expected value of your teams in this auction, calculated at the current projected pot. Green = positive edge.">
            <StatPill label="My Edge" value={(portfolio.currentEdge >= 0 ? "+" : "") + fmt(portfolio.currentEdge)} accent={portfolio.currentEdge > 0} warn={portfolio.currentEdge < 0} />
          </HelpTip>
          {marketTemp && (
            <HelpTip active={helpMode} text={`Market temperature: your group is paying ${(marketTemp.ratio * 100).toFixed(0)}% of model EV on average. ${marketTemp.advice}`}>
              <StatPill label="Market" value={marketTemp.temp} accent={marketTemp.ratio < 0.95} warn={marketTemp.ratio > 1.05} />
            </HelpTip>
          )}
        </div>
        {/* Action Recommendation Banner */}
        {recommendation && recommendation.bg !== "transparent" && (
          <div style={{
            margin: "6px 16px", padding: "10px 16px", background: recommendation.bg,
            border: "1px solid " + recommendation.color + "40", borderRadius: 8,
            display: "flex", alignItems: "center", gap: 12,
            cursor: liveCurrentItem ? "pointer" : "default",
          }} onClick={() => { if (liveCurrentItem && !sold[liveCurrentItem]) { setSelectedTeam(liveCurrentItem); } }}>
            <span style={{ fontSize: 22, flexShrink: 0 }}>{recommendation.icon}</span>
            <div style={{ fontSize: 13, color: recommendation.color, fontWeight: 600, lineHeight: 1.4 }}>
              {recommendation.text}
            </div>
          </div>
        )}
        {recommendation && recommendation.bg === "transparent" && (
          <div style={{ margin: "4px 16px", fontSize: 11, color: recommendation.color }}>
            {recommendation.icon} {recommendation.text}
          </div>
        )}
        {/* Steal Alert Banner */}
        {liveStealAlert && (
          <div style={{ margin: "6px 16px", padding: "8px 16px", background: "rgba(34,197,94,0.15)", border: "2px solid #22c55e", borderRadius: 8, display: "flex", alignItems: "center", gap: 12, cursor: "pointer", boxShadow: "0 0 12px rgba(34,197,94,0.3)" }}
            onClick={() => { setSelectedTeam(liveStealAlert.team); setCurrentBid(String(liveStealAlert.bid)); }}>
            <span style={{ fontSize: 20 }}>🚨</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#4ade80" }}>
                STEAL ALERT: {liveStealAlert.team} at ${liveStealAlert.bid}
              </div>
              <div style={{ fontSize: 11, color: "#86efac" }}>
                EV: {fmt(liveStealAlert.ev)} · Edge: +{fmt(liveStealAlert.edge)} ({(liveStealAlert.pct * 100).toFixed(0)}% below value) · Click to bid
              </div>
            </div>
          </div>
        )}
        {/* Market Temperature Detail */}
        {marketTemp && marketTemp.ratio !== 1 && (
          <div style={{ margin: "0 16px 4px", fontSize: 10, color: marketTemp.color, display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <span>{marketTemp.advice}</span>
              {marketTemp.steals.length > 0 && <span>💎 {marketTemp.steals.length} steal{marketTemp.steals.length > 1 ? "s" : ""} so far</span>}
              {marketTemp.overpays.length > 0 && <span>🔥 {marketTemp.overpays.length} overpay{marketTemp.overpays.length > 1 ? "s" : ""}</span>}
            </div>
            <div style={{ fontSize: 9, color: "#94a3b8", fontStyle: "italic" }}>
              {marketTemp.ratio < 0.95
                ? "💡 Cold market = bid MORE OFTEN, not higher. Lowball everything — pick up what falls to you."
                : marketTemp.ratio > 1.05
                  ? "💡 Hot market = bid LESS OFTEN, not lower. Let the overpayers burn cash — your deals come later."
                  : "💡 Fair market = trust your max bids. The model is tracking reality."}
            </div>
          </div>
        )}
        <div style={styles.topActions}>
          {liveConnected && (
            <button
              onClick={() => { if (liveCurrentItem) { setSelectedTeam(liveCurrentItem); if (liveBid > 0) setCurrentBid(String(liveBid)); } }}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 12px", borderRadius: 12, background: "#052e16", border: "1px solid #166534", fontSize: 11, fontWeight: 600, color: "#4ade80", cursor: liveCurrentItem ? "pointer" : "default" }}
              title={liveCurrentItem ? "Click to jump to " + liveCurrentItem : "Connected to AuctionPro"}
            >
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 6px #22c55e", flexShrink: 0 }} />
              LIVE{liveCurrentItem ? ` — ${liveCurrentItem}` : ""}
              {liveBid > 0 && <span style={{ color: "#86efac", fontWeight: 700 }}>${liveBid}</span>}
            </button>
          )}
          <button
            style={{ ...styles.smallBtn, ...(helpMode ? { background: "#4f46e5", color: "#fff" } : {}) }}
            onClick={() => setHelpMode(!helpMode)}
            title="Toggle help tooltips on hover"
          >
            {helpMode ? "❓ Help ON" : "❓ Help"}
          </button>
          <button style={styles.smallBtn} onClick={() => setShowHistoryModal(true)} title="Load/view historical auction data">
            📜 History{seedHistory ? ` (${seedHistory.totalRecords})` : ""}
          </button>
          <button style={{ ...styles.smallBtn, ...(prevPortfolio.length > 0 ? { background: "#312e81", color: "#a5b4fc", border: "1px solid #4338ca" } : {}) }} 
            onClick={() => {
              if (prevPortfolio.length > 0) {
                if (confirm("Previous portfolio loaded (" + prevPortfolio.length + " teams). Clear it?")) {
                  setPrevPortfolio([]);
                  saveState({ prevPortfolio: [] });
                }
              } else {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".csv";
                input.onchange = (e) => {
                  const file = e.target.files[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    const data = parsePrevPortfolioCSV(ev.target.result);
                    if (data.length > 0) {
                      setPrevPortfolio(data);
                      saveState({ prevPortfolio: data });
                      console.log("[Calcutta] Previous portfolio loaded:", data.length, "teams");
                    } else {
                      alert("Could not parse portfolio CSV. Expected columns: auction, team, seed, region, ev, max_bid, price_paid, share, pot_size");
                    }
                  };
                  reader.readAsText(file);
                };
                input.click();
              }
            }}
            title={prevPortfolio.length > 0 ? "Previous portfolio loaded — click to clear" : "Load previous auction portfolio CSV"}>
            📋 Prev Portfolio{prevPortfolio.length > 0 ? ` (${prevPortfolio.length})` : ""}
          </button>
          <button style={styles.smallBtn} onClick={exportCSV} title="Export all data to CSV">
            📥 Export
          </button>
          <button style={styles.smallBtn} onClick={undoLastSale} title="Undo last sale">↩ Undo</button>
          <button style={{ ...styles.smallBtn, ...styles.dangerBtn }} onClick={() => { if (confirm("Reset all auction data?")) resetAuction(); }} title="Reset auction">Reset</button>
          <button style={{ ...styles.smallBtn, ...styles.dangerBtn }} onClick={() => { setBracket(null); setJsonInput(""); }} title="Change bracket">New Bracket</button>
        </div>
      </div>

      {/* Help mode banner */}
      {helpMode && (
        <div style={{ padding: "4px 16px", background: "#312e81", borderBottom: "1px solid #6366f1", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ color: "#c7d2fe", fontSize: 12 }}>
            ℹ️ <strong>Help Mode ON</strong> — Hover over any highlighted element for an explanation. Elements with dashed outlines have help text.
          </span>
          <button onClick={() => setHelpMode(false)} style={{ background: "none", border: "1px solid #6366f1", color: "#a5b4fc", borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontSize: 11 }}>
            Turn Off
          </button>
        </div>
      )}

      {/* MAIN LAYOUT */}
      <div style={styles.mainLayout}>
        {/* LEFT: TEAM LIST */}
        <div style={styles.leftPanel}>
          <div style={styles.searchBox}>
            <input
              ref={searchRef}
              style={styles.searchInput}
              placeholder="Search teams... (press /)"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
            />
          </div>
          <label style={styles.toggleLabel}>
            <input type="checkbox" checked={showSoldInList} onChange={(e) => setShowSoldInList(e.target.checked)} />
            <span style={{ marginLeft: 6 }}>Show sold</span>
          </label>
          <div style={styles.teamList}>
            {filteredTeams.map((t) => {
              const isSold = !!sold[t.name];
              const isMine = !!myTeams[t.name];
              const isSelected = selectedTeam === t.name;
              const r = results[t.name];
              return (
                <div
                  key={t.name}
                  style={{
                    ...styles.teamItem,
                    ...(isSelected ? styles.teamItemSelected : {}),
                    ...(isSold && !isSelected ? styles.teamItemSold : {}),
                  }}
                  onClick={() => { setSelectedTeam(t.name); setCurrentBid(sold[t.name]?.toString() || ""); }}
                >
                  <div style={styles.teamItemLeft}>
                    <span style={{ ...styles.seedBadge, background: seedColor(t.seed) }}>{t.seed}</span>
                    <span style={styles.teamName}>{t.name}</span>
                    <span style={{ fontSize: 8, color: "#475569", marginLeft: 3, flexShrink: 0 }}>{({"EAST":"E","WEST":"W","SOUTH":"S","MIDWEST":"MW"})[t.region] || ""}</span>
                    {r?.profile?.champProfile && <span title="Championship Profile" style={{ fontSize: 9, opacity: 0.7 }}>🏆</span>}
                    {r?.profile?.lopsided && <span title="Lopsided — Matchup Dependent" style={{ fontSize: 9, opacity: 0.7 }}>🎲</span>}
                    {r?.profile?.lucky && <span title="Lucky — Regression Risk" style={{ fontSize: 9, opacity: 0.7 }}>🍀</span>}
                    {r?.profile?.sourceDisagree && <span title="Barttorvik/KenPom disagree" style={{ fontSize: 9, opacity: 0.7 }}>🔀</span>}
                    {(() => {
                      const bp = getSchoolBrandPremium(t.name, seedHistory?.schoolPremiums);
                      if (!bp) return null;
                      if (bp.avgPremium > 0.2) return <span title={`Name tax: +${(bp.avgPremium*100).toFixed(0)}% above avg${bp.loyalBidder ? ` (${bp.loyalBidder} always buys)` : ""}`} style={{ fontSize: 9, opacity: 0.7 }}>🔥</span>;
                      if (bp.avgPremium < -0.15) return <span title={`Undervalued brand: ${(bp.avgPremium*100).toFixed(0)}% below avg`} style={{ fontSize: 9, opacity: 0.7 }}>💎</span>;
                      return null;
                    })()}
                  </div>
                  <div style={styles.teamItemRight}>
                    {isMine && <span style={styles.mineBadge}>MINE</span>}
                    {!isMine && splitTeams[t.name] && <span style={{ fontSize: 9, background: "#312e81", color: "#a5b4fc", padding: "1px 5px", borderRadius: 3, fontWeight: 700 }}>🤝 {(splitTeams[t.name].share*100).toFixed(0)}%</span>}
                    {isSold && <span style={styles.soldPrice}>{fmt(sold[t.name])}</span>}
                    {!isSold && r && <HelpTip active={helpMode} text="Expected Value — the average payout this team would generate across thousands of simulated tournaments. Higher = more valuable.">
                      <span style={styles.evHint}>{fmt(r.totalEv)}</span>
                    </HelpTip>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* CENTER: TEAM ANALYSIS */}
        <div style={styles.centerPanel}>
          {!selectedTeam ? (
            <div style={styles.emptyState}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>👈</div>
              <div style={{ color: "#94a3b8" }}>Select a team to see analysis</div>
            </div>
          ) : (
            <>
              {/* Team header */}
              <div style={styles.teamHeader}>
                <div style={styles.teamHeaderLeft}>
                  <span style={{ ...styles.seedBadgeLg, background: seedColor(selectedResult?.team?.seed || 1) }}>
                    {selectedResult?.team?.seed}
                  </span>
                  <div>
                    <h2 style={styles.teamNameLg}>{selectedTeam}</h2>
                    <span style={styles.regionTag}>{selectedResult?.team?.region}</span>
                  </div>
                </div>
                <div style={styles.teamHeaderRight}>
                  <HelpTip active={helpMode} text="Expected Value with 90% confidence interval. Toggle between pot-only uncertainty (just pot size) and full uncertainty (pot + model disagreement). Below the LOW end = strong buy. Above HIGH end = walk away.">
                    <div style={styles.evBig}>{fmt(selectedResult?.totalEv)}</div>
                    {selectedResult && (() => {
                      const potRatioLow = potEstimate.ciLow > 0 ? potEstimate.ciLow / projectedPot : 0.85;
                      const potRatioHigh = potEstimate.ciHigh > 0 ? potEstimate.ciHigh / projectedPot : 1.15;
                      const ciLow = ciMode === "pot"
                        ? Math.max(0, selectedResult.totalEv * potRatioLow)
                        : Math.max(0, (selectedResult.evLow || selectedResult.totalEv * 0.8) * potRatioLow);
                      const ciHigh = ciMode === "pot"
                        ? selectedResult.totalEv * potRatioHigh
                        : (selectedResult.evHigh || selectedResult.totalEv * 1.2) * potRatioHigh;
                      const spread = selectedResult.totalEv > 0 ? ((ciHigh - ciLow) / selectedResult.totalEv * 100).toFixed(0) : 0;
                      return (
                        <>
                          <div style={{ fontSize: 11, color: "#64748b", fontFamily: "'DM Mono', monospace" }}>
                            90% CI: {fmt(ciLow)} – {fmt(ciHigh)}
                            <span style={{ marginLeft: 6, fontSize: 10, color: parseInt(spread) > 60 ? "#f97316" : "#475569" }}>
                              (±{spread}%)
                            </span>
                          </div>
                          <div style={{ display: "flex", gap: 0, marginTop: 4 }}>
                            <button onClick={() => setCiMode("pot")} style={{ padding: "2px 8px", fontSize: 9, fontWeight: 600, border: "1px solid #334155", cursor: "pointer", borderRadius: "4px 0 0 4px", background: ciMode === "pot" ? "#334155" : "transparent", color: ciMode === "pot" ? "#e2e8f0" : "#64748b" }}>Pot Only</button>
                            <button onClick={() => setCiMode("full")} style={{ padding: "2px 8px", fontSize: 9, fontWeight: 600, border: "1px solid #334155", borderLeft: "none", cursor: "pointer", borderRadius: "0 4px 4px 0", background: ciMode === "full" ? "#334155" : "transparent", color: ciMode === "full" ? "#e2e8f0" : "#64748b" }}>Pot + Model</button>
                          </div>
                        </>
                      );
                    })()}
                    <div style={styles.evLabel}>Expected Value</div>
                  </HelpTip>
                </div>
              </div>

              {/* Bid input + action */}
              <div style={styles.bidRow}>
                <HelpTip active={helpMode} text="Enter the current live bid amount. The dashboard updates EV analysis in real-time as you type. Press Enter to record the sale, Shift+Enter if you bought it.">
                  <div style={styles.bidInputWrap}>
                    <span style={styles.bidDollar}>$</span>
                    <input
                      ref={bidRef}
                      style={styles.bidInput}
                      type="number"
                      value={currentBid}
                      onChange={(e) => setCurrentBid(e.target.value)}
                      placeholder="Current bid"
                      onKeyDown={(e) => { if (e.key === "Enter") recordSale(e.shiftKey); }}
                    />
                  </div>
                </HelpTip>
                {/* Split toggle — works for unsold (preview) and sold (portfolio) teams */}
                {(
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10, color: (splitPreview.active || splitTeams[selectedTeam]) ? "#a5b4fc" : "#64748b", cursor: "pointer" }}>
                      <input type="checkbox" checked={splitPreview.active || !!splitTeams[selectedTeam]}
                        onChange={(e) => {
                          const on = e.target.checked;
                          if (sold[selectedTeam]) {
                            // Sold team: toggle in/out of splitTeams
                            // isBuyer is auto-derived: true if team was in myTeams (scraper marked it)
                            const wasMine = !!myTeams[selectedTeam];
                            if (on) {
                              const newSplits = { ...splitTeams, [selectedTeam]: { price: sold[selectedTeam], share: splitPreview.share || 0.5, isBuyer: wasMine } };
                              // If it was in myTeams, remove from there (split replaces full ownership)
                              if (wasMine) {
                                const newMy = { ...myTeams };
                                delete newMy[selectedTeam];
                                setMyTeams(newMy);
                                setSplitTeams(newSplits);
                                saveState({ myTeams: newMy, splitTeams: newSplits });
                              } else {
                                setSplitTeams(newSplits);
                                saveState({ splitTeams: newSplits });
                              }
                            } else {
                              // Turning split off: if I was the buyer, restore to myTeams at full ownership
                              const wasBuyer = splitTeams[selectedTeam]?.isBuyer;
                              const newSplits = { ...splitTeams };
                              delete newSplits[selectedTeam];
                              if (wasBuyer) {
                                const newMy = { ...myTeams, [selectedTeam]: sold[selectedTeam] };
                                setMyTeams(newMy);
                                setSplitTeams(newSplits);
                                saveState({ myTeams: newMy, splitTeams: newSplits });
                              } else {
                                setSplitTeams(newSplits);
                                saveState({ splitTeams: newSplits });
                              }
                            }
                          }
                          setSplitPreview(prev => ({ ...prev, active: on }));
                        }} />
                      🤝 Split
                    </label>
                    {(splitPreview.active || splitTeams[selectedTeam]) && (
                      <>
                        <input
                          style={{ ...styles.searchInput, width: 42, padding: "2px 4px", fontSize: 10, textAlign: "center" }}
                          type="number" min="1" max="99"
                          value={Math.round((splitTeams[selectedTeam]?.share || splitPreview.share) * 100)}
                          onChange={(e) => {
                            const v = Math.min(99, Math.max(1, parseInt(e.target.value) || 50));
                            const share = v / 100;
                            setSplitPreview(prev => ({ ...prev, share }));
                            if (splitTeams[selectedTeam]) {
                              const newSplits = { ...splitTeams, [selectedTeam]: { ...splitTeams[selectedTeam], share } };
                              setSplitTeams(newSplits);
                              saveState({ splitTeams: newSplits });
                            }
                          }}
                        />
                        <span style={{ fontSize: 10, color: "#818cf8" }}>%</span>
                        {splitTeams[selectedTeam]?.isBuyer && (
                          <span style={{ fontSize: 9, color: "#f97316" }}>📋 counts toward cap</span>
                        )}
                      </>
                    )}
                    {(splitPreview.active || splitTeams[selectedTeam]) && selectedResult && (() => {
                      const sh = splitTeams[selectedTeam]?.share || splitPreview.share;
                      const price = sold[selectedTeam] || bidNum;
                      return price > 0 ? (
                        <span style={{ fontSize: 10, color: "#94a3b8" }}>
                          your cost: {fmt(price * sh)} · your EV: {fmt(selectedResult.totalEv * sh)}
                        </span>
                      ) : null;
                    })()}
                  </div>
                )}
                {!sold[selectedTeam] ? (
                  <>
                    <HelpTip active={helpMode} text="Record that someone else bought this team at the entered price. Tracks the sale for pot estimation and market analysis.">
                      <button style={styles.actionBtn} onClick={() => recordSale(false)} disabled={!bidNum}>
                        Record Sale
                      </button>
                    </HelpTip>
                    <HelpTip active={helpMode} text="Record that YOU bought this team. Adds it to your portfolio for EV tracking, profit simulation, and hedge analysis.">
                      <button style={{ ...styles.actionBtn, ...styles.mineBtn }} onClick={() => recordSale(true)} disabled={!bidNum}>
                        I Bought This
                      </button>
                    </HelpTip>
                  </>
                ) : (
                  <div style={styles.soldBanner}>
                    <span>SOLD for {fmt(sold[selectedTeam])}</span>
                    {myTeams[selectedTeam] ? (
                      <button style={styles.smallBtn} onClick={() => toggleMine(selectedTeam)}>Remove from portfolio</button>
                    ) : !splitTeams[selectedTeam] && (
                      <button style={{ ...styles.smallBtn, ...styles.mineSmallBtn }} onClick={() => toggleMine(selectedTeam)}>Claim as mine</button>
                    )}
                    <button style={{ ...styles.smallBtn, ...styles.dangerBtn }} onClick={() => unrecordSale(selectedTeam)}>Unsell</button>
                  </div>
                )}
              </div>

              {/* Verdict bar */}
              {bidNum > 0 && selectedResult && (
                <HelpTip active={helpMode} text="Color-coded verdict: how the current bid compares to EV. Green = good value (bid < EV). Yellow = fair. Red = overpaying. The bar shows bid position relative to EV and max bid.">
                  <VerdictBar price={bidNum} ev={selectedResult.totalEv} maxBid={selectedResult.maxBid}
                    evLow={ciMode === "pot"
                      ? selectedResult.totalEv * (potEstimate.ciLow > 0 ? potEstimate.ciLow / projectedPot : 0.85)
                      : selectedResult.evLow * (potEstimate.ciLow > 0 ? potEstimate.ciLow / projectedPot : 0.85)}
                    evHigh={ciMode === "pot"
                      ? selectedResult.totalEv * (potEstimate.ciHigh > 0 ? potEstimate.ciHigh / projectedPot : 1.15)
                      : selectedResult.evHigh * (potEstimate.ciHigh > 0 ? potEstimate.ciHigh / projectedPot : 1.15)} />
                </HelpTip>
              )}

              {/* Seed market context */}
              {selectedResult && (() => {
                const sb = getSeedBias(selectedResult.team.seed);
                const hist = seedHistory?.seedStats?.[selectedResult.team.seed];
                if (!sb && !hist) return null;
                const thisBid = bidNum || sold[selectedTeam] || 0;
                return (
                  <div style={{ padding: "6px 12px", background: "#1e293b", borderRadius: 8, marginBottom: 8, fontSize: 12 }}>
                    {sb && sb.count > 0 && (() => {
                      const biasColor = sb.bias > 1.2 ? "#ef4444" : sb.bias < 0.85 ? "#22c55e" : "#94a3b8";
                      return (
                        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: hist ? 4 : 0 }}>
                          <span style={{ color: "#64748b" }}>🏷️ {selectedResult.team.seed}-seeds this auction:</span>
                          <span style={styles.mono}>avg {fmt(sb.avgPrice)}</span>
                          <span style={{ color: biasColor, fontWeight: 600 }}>{sb.bias.toFixed(2)}x EV</span>
                          {thisBid > 0 && (
                            <span style={{ color: thisBid < sb.avgPrice * 0.9 ? "#22c55e" : thisBid > sb.avgPrice * 1.1 ? "#ef4444" : "#94a3b8" }}>
                              {thisBid < sb.avgPrice * 0.9 ? "— BELOW avg" : thisBid > sb.avgPrice * 1.1 ? "— ABOVE avg" : "— near avg"}
                            </span>
                          )}
                          <span style={{ color: "#475569", fontSize: 10 }}>({sb.count} sold: {sb.names.join(", ")})</span>
                        </div>
                      );
                    })()}
                    {hist && (
                      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                        <span style={{ color: "#64748b" }}>📜 Historical {selectedResult.team.seed}-seeds:</span>
                        <span style={styles.mono}>{fmt(hist.minFrac * projectedPot)}–{fmt(hist.maxFrac * projectedPot)}</span>
                        <span style={{ color: "#94a3b8" }}>med {fmt(hist.medianFrac * projectedPot)}</span>
                        <span style={{ color: hist.avgROI >= 0 ? "#22c55e" : "#ef4444" }}>ROI {(hist.avgROI * 100).toFixed(0)}%</span>
                        <span style={{ fontWeight: 700, color: hist.verdictColor }}>{hist.verdict}</span>
                        <span style={{ color: "#94a3b8" }}>({pct(hist.pProfit)} profit)</span>
                        {thisBid > 0 && hist.medianFrac > 0 && (() => {
                          const scaledMin = hist.minFrac * projectedPot;
                          const scaledMax = hist.maxFrac * projectedPot;
                          const scaledMed = hist.medianFrac * projectedPot;
                          return (
                            <span style={{ color: thisBid < scaledMin ? "#22c55e" : thisBid > scaledMax ? "#ef4444" : thisBid <= scaledMed ? "#22c55e" : "#eab308", fontWeight: 600, fontSize: 11 }}>
                              {thisBid < scaledMin ? "📉 BELOW hist range!" : thisBid > scaledMax ? "📈 ABOVE hist range!" : thisBid <= scaledMed ? "— lower half" : "— upper half"}
                            </span>
                          );
                        })()}
                        <span style={{ color: "#475569", fontSize: 10 }}>(scaled to {fmt(projectedPot)} pot)</span>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Tabs */}
              <div style={styles.tabRow}>
                {["analysis", "impact", "rounds", "vegas", "cheatsheet", "bracket", "tournament"].map((tab) => {
                  const tabHelp = {
                    analysis: "Core stats: win probability, max bid, breakeven round, bonus EV, KenPom profile badges, and round-by-round probabilities.",
                    impact: "What-if analysis: shows how buying this team would change your portfolio's profit distribution, P(profit), and downside risk.",
                    rounds: "Payout breakdown by tournament round. Shows EV contribution from each round and cumulative payout if team reaches that round.",
                    vegas: "Compares all probability sources: bracket model, KenPom, and Vegas odds. Shows the ensemble blend and flags major disagreements.",
                    cheatsheet: "Pre-auction prep sheet: region difficulty, value by seed, Vegas value picks, and KenPom profile summaries across all teams.",
                    bracket: "Visual bracket with your teams highlighted. Shows matchup paths, regional conflicts, and which teams in each region are sold.",
                  };
                  return (
                    <HelpTip key={tab} active={helpMode} text={tabHelp[tab]}>
                      <button
                        style={{ ...styles.tab, ...(activeTab === tab ? styles.tabActive : {}),
                          ...(tab === "impact" && whatifImpact ? { color: whatifImpact.verdict.color } : {}) }}
                        onClick={() => setActiveTab(tab)}
                      >
                        {tab === "analysis" ? "📊 Analysis"
                          : tab === "impact" ? `📦 Impact${whatifImpact ? ` (${whatifImpact.verdict.icon})` : ""}`
                          : tab === "rounds" ? "🏆 Rounds"
                          : tab === "vegas" ? "🎰 Vegas"
                          : tab === "bracket" ? "🏅 Bracket"
                          : tab === "tournament" ? "🏀 Tournament"
                          : "📋 Cheatsheet"}
                      </button>
                    </HelpTip>
                  );
                })}
              </div>

              {/* Tab content */}
              <div style={styles.tabContent}>
                {activeTab === "analysis" && selectedResult && (
                  <AnalysisTab result={selectedResult} bid={bidNum} pot={projectedPot} potEstimate={potEstimate} payouts={payouts} bonuses={bonuses} sold={sold} helpMode={helpMode} budgetCap={budgetCap} mySpent={portfolio.capSpent} ciMode={ciMode} seedHistory={seedHistory} nSold={Object.keys(sold).length} nMyTeams={new Set([...Object.keys(myTeams), ...Object.keys(splitTeams)]).size} setCurrentBid={setCurrentBid}
                    bidCtx={{
                      remainingPosEV: allTeams.filter(t => !sold[t.name] && results[t.name] && results[t.name].totalEv > 0).length,
                      totalUnsoldEV: allTeams.filter(t => !sold[t.name] && results[t.name]).reduce((s, t) => s + (results[t.name]?.totalEv || 0), 0),
                      bidderTotals: (() => {
                        // Merge user's own spending into bidder totals so they always appear in the competition meter
                        // Skip if scraper already tagged a bidder as isMe (avoid double-count)
                        const merged = { ...bidderTotals };
                        const scraperHasMe = Object.values(merged).some(b => b.isMe);
                        const mySpentTotal = portfolio.capSpent;
                        if (!scraperHasMe && (mySpentTotal > 0 || Object.keys(myTeams).length > 0)) {
                          merged["__me__"] = {
                            name: "You",
                            spent: mySpentTotal,
                            teams: Object.keys(myTeams).length,
                            teamList: Object.entries(myTeams).map(([n, p]) => ({ name: n, price: p })),
                            isMe: true,
                          };
                        }
                        return merged;
                      })(),
                      softCap: budgetCap || 0,
                      marketTemp: marketTemp?.ratio || null,
                      upcoming: showUpcoming ? upcomingQueue : null,
                      allResults: results,
                      allTeamsRef: allTeams,
                      seedAvgFrac: seedHistory?.seedAvgFrac,
                      schoolPremiums: seedHistory?.schoolPremiums,
                      pot: projectedPot,
                    }} />
                )}
                {activeTab === "impact" && (
                  <ImpactTab
                    whatif={whatifImpact}
                    selectedResult={selectedResult}
                    bid={bidNum}
                    myTeams={myTeams}
                    splitTeams={splitTeams}
                    portfolio={portfolio}
                    portfolioDist={portfolioDist}
                    results={results}
                    allTeams={allTeams}
                    budget={budget}
                    selectedTeam={selectedTeam}
                    prevPortfolio={prevPortfolio}
                    showPrevPortfolio={showPrevPortfolio}
                  />
                )}
                {activeTab === "rounds" && selectedResult && (
                  <RoundsTab result={selectedResult} bid={bidNum} pot={projectedPot} payouts={payouts} bonuses={bonuses} />
                )}
                {activeTab === "vegas" && selectedResult && (
                  <VegasTab result={selectedResult} disagreements={disagreements} pot={projectedPot} payouts={payouts} bonuses={bonuses} />
                )}
                {activeTab === "cheatsheet" && (
                  <CheatsheetTab regionEVs={regionEVs} disagreements={disagreements} results={results} sold={sold} pot={projectedPot} payouts={payouts} bonuses={bonuses} seedHistory={seedHistory} />
                )}
                {activeTab === "bracket" && (
                  <BracketTab allTeams={allTeams} results={results} sold={sold} myTeams={myTeams} onSelect={setSelectedTeam} portfolioDist={portfolioDist} />
                )}
                {activeTab === "tournament" && (
                  <TournamentTab
                    portfolio={portfolio}
                    prevPortfolio={prevPortfolio}
                    showPrevPortfolio={showPrevPortfolio}
                    results={results}
                    simMatrix={simMatrix}
                    projectedPot={projectedPot}
                    payouts={payouts}
                    bonuses={bonuses}
                    tournamentResults={tournamentResults}
                    setTournamentResults={setTournamentResults}
                    allTeams={allTeams}
                    myTeams={myTeams}
                    splitTeams={splitTeams}
                  />
                )}
              </div>
            </>
          )}
        </div>

        {/* RIGHT: PORTFOLIO & SUGGESTIONS */}
        <div style={styles.rightPanel}>
          {/* Pot Tracker */}
          <div style={styles.rightSection}>
            <HelpTip active={helpMode} text="Bayesian estimate of the final pot size. Uses each sale to update the prediction — high-value teams (1-seeds) give the most reliable signal. Confidence increases as more teams sell.">
              <h3 style={styles.sectionTitle}>📈 Pot Tracker</h3>
            </HelpTip>
            <div style={styles.portfolioSummary}>
              <div style={styles.pStatRow}>
                <span>Base Estimate</span><span style={styles.mono}>{fmt(basePot)}</span>
              </div>
              <div style={styles.pStatRow}>
                <span>Collected ({potTracker.nSold}/{potTracker.nTotal})</span>
                <span style={styles.mono}>{fmt(actualPotSoFar)}</span>
              </div>
              <div style={{ ...styles.pStatRow, fontWeight: 700 }}>
                <span>Projected Final</span>
                <span style={{ ...styles.mono, color: potTracker.delta >= 0 ? "#22c55e" : "#ef4444" }}>
                  {fmt(projectedPot)}
                </span>
              </div>
              <div style={styles.pStatRow}>
                <span>vs Base</span>
                <span style={{ ...styles.mono, color: potTracker.dirColor, fontWeight: 600 }}>
                  {potTracker.delta >= 0 ? "+" : ""}{fmt(potTracker.delta)} {potTracker.direction}
                </span>
              </div>
              <div style={styles.pStatRow}>
                <span>Confidence</span>
                <span style={{ ...styles.mono, color: potEstimate.confidence > 0.6 ? "#22c55e" : potEstimate.confidence > 0.3 ? "#eab308" : "#64748b" }}>
                  {(potEstimate.confidence * 100).toFixed(0)}% (±{fmt(potEstimate.std)})
                </span>
              </div>
              {potEstimate.ciLow > 0 && (
                <div style={styles.pStatRow}>
                  <span>90% CI</span>
                  <span style={styles.mono}>{fmt(potEstimate.ciLow)} – {fmt(potEstimate.ciHigh)}</span>
                </div>
              )}
              {potTracker.nSold > 0 && (
                <div style={styles.pStatRow}>
                  <span>Avg / Team</span>
                  <span style={styles.mono}>{fmt(potTracker.avgPerTeam)}</span>
                </div>
              )}
            </div>
            {/* Mini progress bar */}
            <div style={{ marginTop: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#64748b", marginBottom: 2 }}>
                <span>{potTracker.nSold} sold</span>
                <span>{potTracker.nTotal - potTracker.nSold} remaining</span>
              </div>
              <div style={{ height: 6, background: "#1e293b", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", borderRadius: 3, background: "linear-gradient(90deg, #2563eb, #7c3aed)", width: `${potTracker.pctSold * 100}%`, transition: "width 0.3s" }} />
              </div>
            </div>
          </div>

          {/* Portfolio */}
          <div style={styles.rightSection}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <h3 style={{ ...styles.sectionTitle, margin: 0 }}>💼 My Portfolio</h3>
              {prevPortfolio.length > 0 && (
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: showPrevPortfolio ? "#a5b4fc" : "#64748b", cursor: "pointer" }}>
                  <input type="checkbox" checked={showPrevPortfolio} onChange={(e) => setShowPrevPortfolio(e.target.checked)} />
                  + {prevPortfolio[0]?.auction || "Previous"}
                </label>
              )}
            </div>
            {portfolio.teams.length === 0 ? (
              <div style={styles.emptyHint}>Buy teams to build your portfolio</div>
            ) : (
              <>
                <div style={styles.portfolioSummary}>
                  {/* Show combined totals when prev portfolio is active */}
                  {showPrevPortfolio && prevPortfolio.length > 0 && portfolio.currentTeams.length > 0 && (
                    <>
                      <div style={{ fontSize: 9, color: "#818cf8", fontWeight: 700, marginBottom: 4 }}>COMBINED (all auctions)</div>
                      <div style={styles.pStatRow}>
                        <span>Total Invested</span><span style={styles.mono}>{fmt(portfolio.totalInvested)}</span>
                      </div>
                      <div style={styles.pStatRow}>
                        <span>Total EV</span><span style={styles.mono}>{fmt(portfolio.totalEv)}</span>
                      </div>
                      <div style={{ ...styles.pStatRow, color: portfolio.edge >= 0 ? "#22c55e" : "#ef4444", fontWeight: 700 }}>
                        <span>Total Edge</span><span style={styles.mono}>{portfolio.edge >= 0 ? "+" : ""}{fmt(portfolio.edge)}</span>
                      </div>
                      {portfolioDist && (
                        <>
                          <div style={{ ...styles.pStatRow, color: portfolioDist.pProfit >= 0.5 ? "#22c55e" : "#eab308" }}>
                            <span>P(profit)</span><span style={styles.mono}>{pct(portfolioDist.pProfit)}</span>
                          </div>
                          <div style={styles.pStatRow}>
                            <span>Median</span>
                            <span style={{ ...styles.mono, color: portfolioDist.median >= 0 ? "#22c55e" : "#ef4444" }}>
                              {portfolioDist.median >= 0 ? "+" : ""}{fmt(portfolioDist.median)}
                            </span>
                          </div>
                          <div style={styles.pStatRow}>
                            <span>Downside (P10)</span>
                            <span style={{ ...styles.mono, color: "#ef4444" }}>{fmt(portfolioDist.p10)}</span>
                          </div>
                          <div style={styles.pStatRow}>
                            <span>Upside (P90)</span>
                            <span style={{ ...styles.mono, color: "#22c55e" }}>+{fmt(portfolioDist.p90)}</span>
                          </div>
                        </>
                      )}
                      <div style={{ borderBottom: "1px solid #334155", margin: "6px 0" }} />
                      <div style={{ fontSize: 9, color: "#64748b", fontWeight: 700, marginBottom: 4 }}>THIS AUCTION</div>
                    </>
                  )}
                  <div style={styles.pStatRow}>
                    <span>Invested</span><span style={styles.mono}>{fmt(portfolio.currentInvested)}</span>
                  </div>
                  <div style={styles.pStatRow}>
                    <span>EV</span><span style={styles.mono}>{fmt(portfolio.currentEv)}</span>
                  </div>
                  <div style={{ ...styles.pStatRow, color: portfolio.currentEdge >= 0 ? "#22c55e" : "#ef4444", fontWeight: 700 }}>
                    <span>Edge</span><span style={styles.mono}>{portfolio.currentEdge >= 0 ? "+" : ""}{fmt(portfolio.currentEdge)}</span>
                  </div>
                  {/* MC stats: use currentOnlyDist when combined mode, portfolioDist when solo */}
                  {(() => {
                    const dist = (showPrevPortfolio && prevPortfolio.length > 0) ? currentOnlyDist : portfolioDist;
                    if (!dist) return null;
                    return (
                      <>
                        <div style={{ ...styles.pStatRow, color: dist.pProfit >= 0.5 ? "#22c55e" : "#eab308" }}>
                          <span>P(profit)</span><span style={styles.mono}>{pct(dist.pProfit)}</span>
                        </div>
                        <div style={styles.pStatRow}>
                          <span>Median</span>
                          <span style={{ ...styles.mono, color: dist.median >= 0 ? "#22c55e" : "#ef4444" }}>
                            {dist.median >= 0 ? "+" : ""}{fmt(dist.median)}
                          </span>
                        </div>
                        <div style={styles.pStatRow}>
                          <span>Downside (P10)</span>
                          <span style={{ ...styles.mono, color: "#ef4444" }}>{fmt(dist.p10)}</span>
                        </div>
                        <div style={styles.pStatRow}>
                          <span>Upside (P90)</span>
                          <span style={{ ...styles.mono, color: "#22c55e" }}>+{fmt(dist.p90)}</span>
                        </div>
                      </>
                    );
                  })()}
                  {/* Previous auction breakdown */}
                  {showPrevPortfolio && prevPortfolio.length > 0 && portfolio.prevEntries.length > 0 && (
                    <>
                      <div style={{ borderBottom: "1px solid #334155", margin: "6px 0" }} />
                      <div style={{ fontSize: 9, color: "#818cf8", fontWeight: 700, marginBottom: 4 }}>{prevPortfolio[0]?.auction || "PREVIOUS"}</div>
                      <div style={styles.pStatRow}>
                        <span>Invested</span><span style={styles.mono}>{fmt(portfolio.prevInvested)}</span>
                      </div>
                      <div style={styles.pStatRow}>
                        <span>EV</span><span style={styles.mono}>{fmt(portfolio.prevEv)}</span>
                      </div>
                      <div style={{ ...styles.pStatRow, color: portfolio.prevEdge >= 0 ? "#22c55e" : "#ef4444", fontWeight: 700 }}>
                        <span>Edge</span><span style={styles.mono}>{portfolio.prevEdge >= 0 ? "+" : ""}{fmt(portfolio.prevEdge)}</span>
                      </div>
                      {prevPortfolioDist && (
                        <>
                          <div style={{ ...styles.pStatRow, color: prevPortfolioDist.pProfit >= 0.5 ? "#22c55e" : "#eab308" }}>
                            <span>P(profit)</span><span style={styles.mono}>{pct(prevPortfolioDist.pProfit)}</span>
                          </div>
                          <div style={styles.pStatRow}>
                            <span>Median</span>
                            <span style={{ ...styles.mono, color: prevPortfolioDist.median >= 0 ? "#22c55e" : "#ef4444" }}>
                              {prevPortfolioDist.median >= 0 ? "+" : ""}{fmt(prevPortfolioDist.median)}
                            </span>
                          </div>
                          <div style={styles.pStatRow}>
                            <span>Downside (P10)</span>
                            <span style={{ ...styles.mono, color: "#ef4444" }}>{fmt(prevPortfolioDist.p10)}</span>
                          </div>
                          <div style={styles.pStatRow}>
                            <span>Upside (P90)</span>
                            <span style={{ ...styles.mono, color: "#22c55e" }}>+{fmt(prevPortfolioDist.p90)}</span>
                          </div>
                        </>
                      )}
                      <div style={{ ...styles.pStatRow, color: "#64748b", fontSize: 10 }}>
                        <span>{portfolio.prevEntries.length} teams</span>
                        <span style={styles.mono}>{portfolio.prevEntries.filter(t => t.share < 1).length > 0 ? portfolio.prevEntries.filter(t => t.share < 1).length + " split" : ""}</span>
                      </div>
                    </>
                  )}
                  {budget > 0 && (
                    <div style={{ ...styles.pStatRow, color: budget - portfolio.totalInvested > 0 ? "#94a3b8" : "#ef4444" }}>
                      <span>Budget Left</span><span style={styles.mono}>{fmt(budget - portfolio.totalInvested)}</span>
                    </div>
                  )}
                  {budgetCap > 0 && (() => {
                    const spent = portfolio.capSpent;
                    const underCap = spent < budgetCap;
                    const capLeft = budgetCap - spent;
                    const nTeams = Object.keys(myTeams).length;
                    return (
                      <>
                        <div style={{ ...styles.pStatRow, color: underCap ? "#94a3b8" : "#f97316" }}>
                          <span>Cap ({fmt(budgetCap)})</span>
                          <span style={styles.mono}>
                            {underCap ? fmt(capLeft) + " left" : "EXCEEDED"}
                          </span>
                        </div>
                        {underCap && (
                          <div style={{ fontSize: 10, color: "#64748b", marginTop: -4, marginBottom: 4 }}>
                            {capLeft > 0 ? `Can bid up to ${fmt(capLeft)} on next team, or exceed cap on your LAST team` : "At cap — next purchase must be your last"}
                          </div>
                        )}
                        {!underCap && (
                          <div style={{ fontSize: 10, color: "#f97316", marginTop: -4, marginBottom: 4 }}>
                            Over cap — no more purchases allowed
                          </div>
                        )}
                      </>
                    );
                  })()}
                  <div style={styles.pStatRow}>
                    <span>Regions</span>
                    <span>{Object.entries(portfolio.regions).map(([r, c]) => `${r}(${c})`).join(" ")}</span>
                  </div>
                </div>
                {/* Budget editor */}
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: "#64748b" }}>Budget:</span>
                  <input
                    style={{ ...styles.searchInput, width: 70, padding: "3px 6px", fontSize: 11 }}
                    type="number"
                    value={budget || ""}
                    onChange={(e) => { const v = parseFloat(e.target.value) || 0; setBudget(v); saveState({ budget: v }); }}
                    placeholder="$0"
                  />
                  <span style={{ fontSize: 11, color: "#64748b", marginLeft: 4 }}>Cap:</span>
                  <input
                    style={{ ...styles.searchInput, width: 70, padding: "3px 6px", fontSize: 11 }}
                    type="number"
                    value={budgetCap || ""}
                    onChange={(e) => { const v = parseFloat(e.target.value) || 0; setBudgetCap(v); saveState({ budgetCap: v }); }}
                    placeholder="0=none"
                  />
                </div>
                <div style={styles.portfolioTeams}>
                  {/* Current auction teams */}
                  {portfolio.currentTeams.map(({ name, price, share, isSplit, isBuyer, result, team }) => {
                    const ev = (result?.totalEv || 0) * share;
                    const cost = price * share;
                    const edge = ev - cost;
                    const region = team?.region || "?";
                    return (
                      <div key={"cur-" + name} style={{ ...styles.portfolioTeam, ...(isSplit ? { opacity: 0.9 } : {}) }} onClick={() => setSelectedTeam(name)}>
                        <span style={styles.portfolioName}>
                          {isSplit && <span title={`Split: ${(share*100).toFixed(0)}% share`} style={{ marginRight: 4 }}>🤝</span>}
                          {name}
                          <span style={{ fontSize: 9, color: "#64748b", marginLeft: 4 }}>{region}</span>
                          {isSplit && <span style={{ fontSize: 9, color: "#818cf8", marginLeft: 4 }}>({(share*100).toFixed(0)}%{isBuyer ? " 📋cap" : ""})</span>}
                        </span>
                        <span style={{ ...styles.mono, fontSize: 10, color: "#94a3b8" }}>
                          {isSplit ? `${fmt(cost)} of ${fmt(price)}` : `paid ${fmt(price)}`}
                        </span>
                        <span style={{ ...styles.mono, color: edge >= 0 ? "#22c55e" : "#ef4444", fontSize: 11, fontWeight: 600 }}>
                          {edge >= 0 ? "+" : ""}{fmt(edge)}
                        </span>
                      </div>
                    );
                  })}
                  {/* Previous auction teams */}
                  {showPrevPortfolio && portfolio.prevEntries.length > 0 && (
                    <>
                      <div style={{ fontSize: 9, color: "#818cf8", fontWeight: 700, padding: "6px 0 2px", borderTop: "1px solid #4338ca" }}>
                        📋 {portfolio.prevEntries[0]?.auction || "Previous"} — {fmt(portfolio.prevInvested)} invested, edge {portfolio.prevEdge >= 0 ? "+" : ""}{fmt(portfolio.prevEdge)}
                      </div>
                      {portfolio.prevEntries.map(({ name, price, share, prevEv, region, seed, auction }) => {
                        const cost = price * share;
                        const ev = (prevEv || 0) * share;
                        const edge = ev - cost;
                        return (
                          <div key={"prev-" + name + "-" + auction} style={{ ...styles.portfolioTeam, opacity: 0.7 }} onClick={() => setSelectedTeam(name)}>
                            <span style={styles.portfolioName}>
                              {share < 1 && <span style={{ marginRight: 4 }}>🤝</span>}
                              {name}
                              <span style={{ fontSize: 9, color: "#64748b", marginLeft: 4 }}>{region}</span>
                              {share < 1 && <span style={{ fontSize: 9, color: "#818cf8", marginLeft: 4 }}>({(share*100).toFixed(0)}%)</span>}
                            </span>
                            <span style={{ ...styles.mono, fontSize: 10, color: "#94a3b8" }}>
                              {share < 1 ? `${fmt(cost)} of ${fmt(price)}` : `paid ${fmt(price)}`}
                            </span>
                            <span style={{ ...styles.mono, color: edge >= 0 ? "#22c55e" : "#ef4444", fontSize: 11, fontWeight: 600 }}>
                              {edge >= 0 ? "+" : ""}{fmt(edge)}
                            </span>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Coming Up Next */}
          {upcomingQueue.length > 0 && (
            <div style={styles.rightSection}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <h3 style={{ ...styles.sectionTitle, margin: 0 }}>⏭️ Coming Up ({upcomingQueue.length})</h3>
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "#64748b", cursor: "pointer" }}>
                  <input type="checkbox" checked={showUpcoming} onChange={(e) => setShowUpcoming(e.target.checked)} />
                  Show
                </label>
              </div>
              {showUpcoming ? (
                <div style={{ maxHeight: 200, overflowY: "auto" }}>
                  {upcomingQueue.slice(0, 5).map((item, i) => {
                    const team = allTeams.find(t => t.name === item.name) ||
                      allTeams.find(t => t.name.toLowerCase().replace(/\./g, "") === item.name.toLowerCase().replace(/\./g, ""));
                    const r = team ? results[team.name] : null;
                    const isCurrent = i === 0;
                    const est = (r && team && seedHistory?.seedAvgFrac)
                      ? estimateSellingPrice(team.name, team.seed, r.totalEv, projectedPot, seedHistory.seedAvgFrac, seedHistory.schoolPremiums)
                      : null;
                    const edge = est?.expectedEdge || 0;
                    return (
                      <div key={item.name} style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        padding: "5px 6px", borderBottom: "1px solid #1e293b", cursor: team ? "pointer" : "default",
                        ...(isCurrent ? { background: "rgba(165,180,252,0.08)", borderLeft: "3px solid #818cf8" } : {}),
                      }} onClick={() => { if (team) setSelectedTeam(team.name); }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 11, color: isCurrent ? "#c7d2fe" : "#e2e8f0", fontWeight: isCurrent ? 700 : 400 }}>
                            {isCurrent ? "▶ " : ""}{item.name}
                          </div>
                          {r && (
                            <div style={{ fontSize: 9, color: "#64748b", display: "flex", gap: 8, marginTop: 1 }}>
                              {team && <span>({team.seed})</span>}
                              <span>EV: {fmt(r.totalEv)}</span>
                              {est && <span>~sells: {fmt(est.expectedPrice)}</span>}
                              {r.profile?.champProfile && <span style={{ color: "#fbbf24" }}>🏆</span>}
                              {r.profile?.lopsided && <span style={{ color: "#ef4444" }}>🎲</span>}
                            </div>
                          )}
                        </div>
                        {r && (
                          <div style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", textAlign: "right", flexShrink: 0 }}>
                            <div style={{ color: edge > 50 ? "#4ade80" : edge > 0 ? "#eab308" : "#ef4444" }}>
                              {edge >= 0 ? "+" : ""}{fmt(edge)}
                            </div>
                            <div style={{ fontSize: 8, color: "#64748b" }}>edge</div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 10, color: "#64748b", fontStyle: "italic" }}>
                  Queue hidden — auction order unknown or random.
                </div>
              )}
            </div>
          )}

          {/* Suggestions */}
          <div style={styles.rightSection}>
            <HelpTip active={helpMode} text="Smart buy recommendations ranked by: EV-per-dollar, region diversification, portfolio hedge value, market bias, Vegas signal, and KenPom profile. Tags explain why each team is suggested.">
              <h3 style={styles.sectionTitle}>💡 Suggestions</h3>
            </HelpTip>
            {suggestions.length === 0 ? (
              <div style={styles.emptyHint}>Waiting for auction data...</div>
            ) : (
              <div style={styles.suggestionsList}>
                {suggestions.map((s, i) => (
                  <div
                    key={s.name}
                    style={styles.suggestionItem}
                    onClick={() => setSelectedTeam(s.name)}
                  >
                    <div style={styles.suggRank}>#{i + 1}</div>
                    <div style={styles.suggInfo}>
                      <div style={styles.suggName}>({s.seed}) {s.name}</div>
                      <div style={styles.suggMeta}>
                        EV: {fmt(s.result.totalEv)} · Max: {fmt(s.result.maxBid)} · {s.region}
                      </div>
                      <div style={{ display: "flex", gap: 8, fontSize: 10, color: "#64748b", marginTop: 2 }}>
                        {s.marginalPProfit != null && (
                          <span style={{ color: s.marginalPProfit > 0 ? "#22c55e" : s.marginalPProfit < -0.01 ? "#ef4444" : "#94a3b8" }}>
                            ΔP: {(s.marginalPProfit * 100).toFixed(1)}pp
                          </span>
                        )}
                        {s.hedgeScore !== 1.0 && <span>hedge: {s.hedgeScore.toFixed(2)}x</span>}
                        {s.regionScore !== 1.0 && <span>rgn: {s.regionScore.toFixed(2)}x</span>}
                        {s.biasScore !== 1.0 && <span>bias: {s.biasScore.toFixed(2)}x</span>}
                      </div>
                      {s.tags.length > 0 && (
                        <div style={styles.suggTags}>
                          {s.tags.map((tag) => (
                            <span key={tag} style={styles.suggTag}>{tag}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Bidder Tracker */}
          {(() => {
            // Merge user's spending into bidder totals (same logic as bidCtx)
            const merged = { ...bidderTotals };
            const scraperHasMe = Object.values(merged).some(b => b.isMe);
            const mySpentTotal = portfolio.capSpent;
            if (!scraperHasMe && (mySpentTotal > 0 || Object.keys(myTeams).length > 0 || Object.keys(splitTeams).length > 0)) {
              merged["__me__"] = {
                name: "You",
                spent: mySpentTotal,
                teams: Object.keys(myTeams).length + Object.keys(splitTeams).filter(n => splitTeams[n].isBuyer).length,
                teamList: [
                  ...Object.entries(myTeams).map(([n, p]) => ({ name: n, price: p })),
                  ...Object.entries(splitTeams).filter(([, s]) => s.isBuyer).map(([n, s]) => ({ name: n + " (split)", price: s.price })),
                ],
                isMe: true,
              };
            }
            const allBidders = Object.values(merged);
            if (allBidders.length === 0) return null;
            const cap = budgetCap || 0;
            const sorted = [...allBidders].sort((a, b) => (b.spent || 0) - (a.spent || 0));
            return (
              <div style={styles.rightSection}>
                <h3 style={styles.sectionTitle}>👥 Bidder Tracker ({allBidders.length})</h3>
                <div style={{ fontSize: 10, color: "#64748b", marginBottom: 6 }}>
                  Cap: ${cap} · Pot so far: {fmt(Object.values(sold).reduce((s, v) => s + v, 0))}
                </div>
                <div style={{ maxHeight: 280, overflowY: "auto" }}>
                  {sorted.map((b, i) => {
                    const spent = b.spent || 0;
                    const remaining = Math.max(0, cap - spent);
                    const status = spent >= cap ? "done" : (remaining < 100 ? "last" : "free");
                    const statusColor = status === "free" ? "#22c55e" : status === "last" ? "#f97316" : "#64748b";
                    const statusIcon = status === "free" ? "🟥" : status === "last" ? "🟧" : "🔲";
                    return (
                      <div key={i} style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        padding: "4px 0", borderBottom: "1px solid #1e293b",
                        ...(b.isMe ? { background: "rgba(74,222,128,0.06)", padding: "4px 6px", borderRadius: 4, marginBottom: 2 } : {}),
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontSize: 11, color: b.isMe ? "#4ade80" : "#e2e8f0", fontWeight: b.isMe ? 700 : 400 }}>
                            {b.isMe ? "👤 " : ""}{b.name || "Bidder " + (i + 1)}
                          </span>
                          <span style={{ fontSize: 10, color: "#64748b", marginLeft: 6 }}>
                            {b.teams || 0} team{(b.teams || 0) !== 1 ? "s" : ""}
                          </span>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <span style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: "#e2e8f0" }}>
                            ${spent}
                          </span>
                          <span style={{ fontSize: 10, color: statusColor, marginLeft: 6 }}>
                            {statusIcon} {status === "done" ? "done" : "$" + remaining + " left"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {(() => {
                  const free = sorted.filter(b => (b.spent || 0) < cap && cap - (b.spent || 0) >= 100).length;
                  const last = sorted.filter(b => { const r = cap - (b.spent || 0); return r > 0 && r < 100; }).length;
                  const done = sorted.filter(b => (b.spent || 0) >= cap).length;
                  return (
                    <div style={{ marginTop: 6, fontSize: 10, color: "#64748b" }}>
                      🟥 {free} free · 🟧 {last} near cap · 🔲 {done} done
                    </div>
                  );
                })()}
              </div>
            );
          })()}

          {/* Budget Optimizer */}

          {/* Deals & Overpays Tracker */}
          {Object.keys(sold).length >= 3 && (
            <div style={styles.rightSection}>
              <h3 style={styles.sectionTitle}>📊 Deals & Overpays</h3>
              {dealsTracker.deals.length > 0 && (
                <>
                  <div style={{ fontSize: 9, color: "#22c55e", fontWeight: 700, marginBottom: 4 }}>💰 BEST DEALS</div>
                  {dealsTracker.deals.filter(d => d.edge > 0).map((d, i) => (
                    <div key={"deal-" + d.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", cursor: "pointer", fontSize: 11, borderTop: i > 0 ? "1px solid #1e293b" : "none" }}
                      onClick={() => setSelectedTeam(d.name)}>
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {d.isMine ? "⭐ " : ""}<span style={{ color: "#e2e8f0" }}>{d.name}</span>
                        <span style={{ fontSize: 9, color: "#64748b", marginLeft: 4 }}>({d.seed})</span>
                        {d.buyer && <span style={{ fontSize: 9, color: "#94a3b8", marginLeft: 4 }}>— {d.buyer}</span>}
                      </span>
                      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, flexShrink: 0 }}>
                        <span style={{ color: "#94a3b8" }}>${Math.round(d.price)}</span>
                        <span style={{ color: "#22c55e", marginLeft: 6, fontWeight: 600 }}>+{fmt(d.edge)}</span>
                        <span style={{ color: "#4ade80", marginLeft: 4, fontSize: 9 }}>{Math.round(d.pct * 100)}%↓</span>
                      </span>
                    </div>
                  ))}
                </>
              )}
              {dealsTracker.overpays.length > 0 && (
                <>
                  <div style={{ fontSize: 9, color: "#ef4444", fontWeight: 700, marginTop: 8, marginBottom: 4 }}>🔥 BIGGEST OVERPAYS</div>
                  {dealsTracker.overpays.filter(d => d.edge < 0).map((d, i) => (
                    <div key={"overpay-" + d.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", cursor: "pointer", fontSize: 11, borderTop: i > 0 ? "1px solid #1e293b" : "none" }}
                      onClick={() => setSelectedTeam(d.name)}>
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {d.isMine ? "😬 " : ""}<span style={{ color: "#e2e8f0" }}>{d.name}</span>
                        <span style={{ fontSize: 9, color: "#64748b", marginLeft: 4 }}>({d.seed})</span>
                        {d.buyer && <span style={{ fontSize: 9, color: "#94a3b8", marginLeft: 4 }}>— {d.buyer}</span>}
                      </span>
                      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, flexShrink: 0 }}>
                        <span style={{ color: "#94a3b8" }}>${Math.round(d.price)}</span>
                        <span style={{ color: "#ef4444", marginLeft: 6, fontWeight: 600 }}>{fmt(d.edge)}</span>
                        <span style={{ color: "#f87171", marginLeft: 4, fontSize: 9 }}>{Math.round(Math.abs(d.pct) * 100)}%↑</span>
                      </span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {budgetOptimal && budgetOptimal.picks.length > 0 && (
            <div style={styles.rightSection}>
              <HelpTip active={helpMode} text="Given your remaining budget, shows the optimal set of teams to target. Uses a greedy algorithm that maximizes total EV while diversifying across regions.">
                <h3 style={styles.sectionTitle}>💰 Budget Optimizer</h3>
              </HelpTip>
              <div style={{ fontSize: 10, color: "#64748b", marginBottom: 6 }}>
                Best allocation of ${budget} remaining
              </div>
              {budgetOptimal.picks.map((p, i) => (
                <div key={p.name} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #0f172a33", fontSize: 11, cursor: "pointer" }}
                  onClick={() => setSelectedTeam(p.name)}>
                  <span>({p.seed}) {p.name}</span>
                  <span style={styles.mono}>{fmt(p.price)} <span style={{ color: "#22c55e" }}>+{fmt(p.ev - p.price)}</span></span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, paddingTop: 6, borderTop: "1px solid #334155", fontSize: 11 }}>
                <span style={{ fontWeight: 600 }}>Total: {fmt(budgetOptimal.totalCost)} spent</span>
                <span style={{ color: "#22c55e", fontWeight: 600 }}>EV: {fmt(budgetOptimal.totalEv)} (+{fmt(budgetOptimal.totalEv - budgetOptimal.totalCost)})</span>
              </div>
              <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>
                ${budgetOptimal.remaining.toFixed(0)} unspent
              </div>
            </div>
          )}

          {/* Sold log */}
          <div style={styles.rightSection}>
            <h3 style={styles.sectionTitle}>📜 Recent Sales ({nSold})</h3>
            <div style={styles.soldLog}>
              {Object.entries(sold).reverse().slice(0, 12).map(([name, price]) => {
                const r = results[name];
                const ev = r?.totalEv || 0;
                const isMine = !!myTeams[name];
                return (
                  <div key={name} style={styles.soldLogItem} onClick={() => setSelectedTeam(name)}>
                    <span>{isMine ? "⭐ " : ""}{r?.team?.seed ? `(${r.team.seed}) ` : ""}{name}</span>
                    <span style={{ ...styles.mono, color: ev > price ? "#22c55e" : "#ef4444" }}>{fmt(price)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Seed Market — live over/underpay */}
          {seedMarket.length > 0 && (
            <div style={styles.rightSection}>
              <h3 style={styles.sectionTitle}>🏷️ Seed Market (this auction)</h3>
              <div style={{ fontSize: 10, color: "#64748b", marginBottom: 6 }}>
                Avg paid vs EV — bias &gt;1 = overpaying
              </div>
              <div>
                <div style={{ display: "flex", padding: "3px 0", borderBottom: "1px solid #334155", fontSize: 10, color: "#64748b" }}>
                  <span style={{ width: 36 }}>Seed</span>
                  <span style={{ flex: 1, textAlign: "right" }}>Avg $</span>
                  <span style={{ flex: 1, textAlign: "right" }}>Avg EV</span>
                  <span style={{ flex: 1, textAlign: "right" }}>Bias</span>
                  {seedHistory && <span style={{ flex: 1, textAlign: "right" }}>Hist Avg</span>}
                  <span style={{ width: 60, textAlign: "right" }}>Signal</span>
                </div>
                {seedMarket.map((s) => {
                  const biasColor = s.bias > 1.3 ? "#ef4444" : s.bias > 1.1 ? "#f97316" : s.bias < 0.8 ? "#22c55e" : s.bias < 0.95 ? "#22c55e" : "#94a3b8";
                  const signal = s.bias > 1.3 ? "↑ OVERPAY" : s.bias > 1.1 ? "↑ High" : s.bias < 0.8 ? "↓ BARGAIN" : s.bias < 0.95 ? "↓ Low" : "≈ Fair";
                  const hist = seedHistory?.seedStats?.[s.seed];
                  const scaledHistAvg = hist ? hist.avgFrac * projectedPot : null;
                  const vsHist = scaledHistAvg ? s.avgPrice / scaledHistAvg : null;
                  return (
                    <div key={s.seed} style={{ display: "flex", padding: "3px 0", borderBottom: "1px solid #0f172a22", fontSize: 11, alignItems: "center" }}>
                      <span style={{ width: 36, fontWeight: 600 }}>
                        <span style={{ ...styles.seedBadge, background: seedColor(s.seed), width: 18, height: 18, fontSize: 9, display: "inline-flex" }}>{s.seed}</span>
                      </span>
                      <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{fmt(s.avgPrice)}</span>
                      <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: "#64748b" }}>{fmt(s.avgEv)}</span>
                      <span style={{ ...styles.mono, flex: 1, textAlign: "right", fontWeight: 700, color: biasColor }}>
                        {s.bias.toFixed(2)}x
                      </span>
                      {seedHistory && (
                        <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: vsHist && vsHist > 1.15 ? "#ef4444" : vsHist && vsHist < 0.85 ? "#22c55e" : "#64748b" }}>
                          {scaledHistAvg ? `${fmt(scaledHistAvg)}` : "—"}
                          {vsHist && Math.abs(vsHist - 1) > 0.15 ? (vsHist > 1 ? " ↑" : " ↓") : ""}
                        </span>
                      )}
                      <span style={{ width: 60, textAlign: "right", fontSize: 9, fontWeight: 600, color: biasColor }}>
                        {signal}
                      </span>
                    </div>
                  );
                })}
              </div>
              {(() => {
                const overpaid = seedMarket.filter((s) => s.bias > 1.2);
                const underpaid = seedMarket.filter((s) => s.bias < 0.85);
                if (overpaid.length === 0 && underpaid.length === 0) return null;
                return (
                  <div style={{ marginTop: 6, fontSize: 10, color: "#94a3b8", lineHeight: 1.5 }}>
                    {overpaid.length > 0 && (
                      <div>🔴 Overpaying for: {overpaid.map((s) => `${s.seed}-seeds (${s.bias.toFixed(1)}x)`).join(", ")}</div>
                    )}
                    {underpaid.length > 0 && (
                      <div>🟢 Bargains on: {underpaid.map((s) => `${s.seed}-seeds (${s.bias.toFixed(1)}x)`).join(", ")}</div>
                    )}
                  </div>
                );
              })()}
              {/* Historical verdict strip */}
              {seedHistory && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #334155" }}>
                  <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4 }}>📜 Historical verdicts (P(profit) from past auctions)</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {Object.values(seedHistory.seedStats).sort((a, b) => a.seed - b.seed).map((s) => (
                      <span key={s.seed} style={{
                        padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                        background: s.verdictColor + "20", color: s.verdictColor, border: `1px solid ${s.verdictColor}40`,
                      }}>
                        {s.seed}: {s.verdict} ({pct(s.pProfit)})
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* History Modal */}
      {showHistoryModal && (
        <div style={styles.modalOverlay} onClick={() => setShowHistoryModal(false)}>
          <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16, color: "#f8fafc" }}>📜 Historical Auction Data</h3>
              <button style={styles.smallBtn} onClick={() => setShowHistoryModal(false)}>✕ Close</button>
            </div>
            <p style={{ color: "#94a3b8", fontSize: 12, margin: "0 0 10px" }}>
              Paste past auction results (CSV). Format: year,team,seed,price_paid,rounds_won,payout_received
            </p>
            <textarea
              style={{ ...styles.jsonTextarea, height: 160 }}
              value={historyCSV}
              onChange={(e) => { setHistoryCSV(e.target.value); saveState({ historyCSV: e.target.value }); }}
              placeholder="year,team,seed,price_paid,rounds_won,payout_received&#10;2023,Gonzaga,1,1200,2,200"
              spellCheck={false}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button
                style={{ ...styles.loadBtn, padding: "8px 16px", fontSize: 12 }}
                onClick={() => { setHistoryCSV(SAMPLE_HISTORY_CSV); saveState({ historyCSV: SAMPLE_HISTORY_CSV }); }}
              >
                Load Sample History
              </button>
              {historyCSV && (
                <button
                  style={{ ...styles.smallBtn, ...styles.dangerBtn }}
                  onClick={() => { setHistoryCSV(""); saveState({ historyCSV: "" }); }}
                >
                  Clear
                </button>
              )}
            </div>
            {seedHistory && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11, color: "#22c55e", marginBottom: 8 }}>
                  ✅ Loaded {seedHistory.totalRecords} records from {seedHistory.years.join(", ")}
                </div>
                <div style={{ display: "flex", padding: "4px 0", borderBottom: "1px solid #334155", fontSize: 10, color: "#64748b" }}>
                  <span style={{ width: 36 }}>Seed</span>
                  <span style={{ flex: 1, textAlign: "right" }}>Range</span>
                  <span style={{ flex: 1, textAlign: "right" }}>Median</span>
                  <span style={{ flex: 1, textAlign: "right" }}>P(profit)</span>
                  <span style={{ flex: 1, textAlign: "right" }}>Avg ROI</span>
                  <span style={{ width: 55, textAlign: "right" }}>Verdict</span>
                </div>
                {Object.values(seedHistory.seedStats).sort((a, b) => a.seed - b.seed).map((s) => (
                  <div key={s.seed} style={{ display: "flex", padding: "4px 0", borderBottom: "1px solid #0f172a33", fontSize: 11, alignItems: "center" }}>
                    <span style={{ width: 36, fontWeight: 600 }}>{s.seed}</span>
                    <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>
                      {fmt(s.minPrice)}–{fmt(s.maxPrice)}
                    </span>
                    <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{fmt(s.medianPrice)}</span>
                    <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{pct(s.pProfit)}</span>
                    <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: s.avgROI >= 0 ? "#22c55e" : "#ef4444" }}>
                      {(s.avgROI * 100).toFixed(0)}%
                    </span>
                    <span style={{ width: 55, textAlign: "right", fontSize: 10, fontWeight: 700, color: s.verdictColor }}>
                      {s.verdict}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {/* Steal Alert Toasts */}
      {stealAlerts.length > 0 && (
        <div style={{ position: "fixed", top: 80, right: 20, zIndex: 999, display: "flex", flexDirection: "column", gap: 8 }}>
          {stealAlerts.map((a) => (
            <div key={a.id} style={{
              background: a.isMine ? "#065f46" : "#7f1d1d",
              border: a.isMine ? "2px solid #22c55e" : "2px solid #ef4444",
              borderRadius: 12, padding: "12px 16px", minWidth: 260,
              animation: "slideIn 0.3s ease-out",
              boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            }}>
              <div style={{ fontWeight: 800, fontSize: 14, color: a.isMine ? "#22c55e" : "#fbbf24" }}>
                {a.isMine ? "🎉 YOU GOT A STEAL!" : "🚨 STEAL ALERT"}
              </div>
              <div style={{ fontSize: 13, marginTop: 4 }}>
                ({a.seed}) {a.team} sold for {fmt(a.price)}
              </div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                EV: {fmt(a.ev)} — paid only {(a.pct * 100).toFixed(0)}% of value
              </div>
              <button
                style={{ ...styles.smallBtn, marginTop: 6, fontSize: 10 }}
                onClick={() => setStealAlerts((prev) => prev.filter((x) => x.id !== a.id))}
              >Dismiss</button>
            </div>
          ))}
        </div>
      )}

      {/* Keyboard shortcuts hint */}
      <div style={{
        position: "fixed", bottom: 0, left: 0, right: 0,
        background: "#0f172aee", borderTop: "1px solid #1e293b",
        padding: "4px 16px", display: "flex", gap: 16, justifyContent: "center",
        fontSize: 10, color: "#475569", zIndex: 50,
      }}>
        <span><kbd style={styles.kbd}>/</kbd> Search</span>
        <span><kbd style={styles.kbd}>B</kbd> Bid</span>
        <span><kbd style={styles.kbd}>S</kbd> Record Sale</span>
        <span><kbd style={styles.kbd}>M</kbd> I Bought</span>
        <span><kbd style={styles.kbd}>↑↓</kbd> Navigate</span>
        <span><kbd style={styles.kbd}>Z</kbd> Undo</span>
        <span><kbd style={styles.kbd}>1-6</kbd> Tabs</span>
        <span><kbd style={styles.kbd}>Enter</kbd> Sale · <kbd style={styles.kbd}>Shift+Enter</kbd> I Bought</span>
      </div>
    </div>
  );
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function StatPill({ label, value, accent, warn }) {
  return (
    <div style={styles.statPill}>
      <span style={styles.statLabel}>{label}</span>
      <span style={{ ...styles.statValue, ...(accent ? { color: "#22c55e" } : {}), ...(warn ? { color: "#ef4444" } : {}) }}>{value}</span>
    </div>
  );
}

function VerdictBar({ price, ev, maxBid, evLow, evHigh }) {
  const v = getVerdict(price, ev);
  const edge = ev - price;
  const be = edge >= 0;
  // Confidence-adjusted verdict
  const belowFloor = evLow > 0 && price < evLow;
  const aboveCeiling = evHigh > 0 && price > evHigh;
  return (
    <div style={{ ...styles.verdictBar, borderColor: v.color + "40" }}>
      <span style={{ color: v.color, fontWeight: 700, fontSize: 13 }}>{v.icon} {v.text}</span>
      <span style={styles.mono}>Edge: <span style={{ color: be ? "#22c55e" : "#ef4444" }}>{edge >= 0 ? "+" : ""}{`$${edge.toFixed(0)}`}</span></span>
      <span style={styles.mono}>Max Bid: {`$${maxBid.toFixed(0)}`}</span>
      {evLow > 0 && evHigh > 0 && (
        <span style={{ fontSize: 10, color: belowFloor ? "#22c55e" : aboveCeiling ? "#ef4444" : "#94a3b8" }}>
          {belowFloor ? "✅ Below pessimistic EV" : aboveCeiling ? "❌ Above optimistic EV" : `CI: ${fmt(evLow)}–${fmt(evHigh)}`}
        </span>
      )}
    </div>
  );
}

function AnalysisTab({ result, bid, pot, potEstimate, payouts, bonuses, sold, helpMode, budgetCap, mySpent, ciMode, seedHistory, nSold, nMyTeams, setCurrentBid, bidCtx }) {
  if (!result) return null;
  // Breakeven: primary = at max bid (what you'd likely pay), secondary = at current bid if meaningful
  const beAtMax = breakEvenRound(result.maxBid, pot, result.roundProbs, payouts, bonuses);
  const beAtBid = bid > 0 ? breakEvenRound(bid, pot, result.roundProbs, payouts, bonuses) : null;
  // Use bid-specific breakeven only if bid is within reasonable range of EV (> 30% of EV)
  const be = (beAtBid && bid > result.totalEv * 0.3) ? beAtBid : beAtMax;
  const winProb = result.winProb;

  // Pot-scaled EV CI
  const potRatioLow = potEstimate?.ciLow > 0 ? potEstimate.ciLow / pot : 0.85;
  const potRatioHigh = potEstimate?.ciHigh > 0 ? potEstimate.ciHigh / pot : 1.15;
  const evCiLow = ciMode === "pot"
    ? Math.max(0, result.totalEv * potRatioLow)
    : Math.max(0, (result.evLow || result.totalEv * 0.8) * potRatioLow);
  const evCiHigh = ciMode === "pot"
    ? result.totalEv * potRatioHigh
    : (result.evHigh || result.totalEv * 1.2) * potRatioHigh;
  const maxBidLow = evCiLow * RISK_DISCOUNT;
  const maxBidHigh = evCiHigh * RISK_DISCOUNT;

  // Cap-aware max bid
  const evMaxBid = result.maxBid;
  const capRemaining = budgetCap > 0 ? budgetCap - (mySpent || 0) : null;
  const wouldExceedCap = capRemaining != null && capRemaining > 0 && evMaxBid > capRemaining;
  const overCap = capRemaining != null && capRemaining <= 0;

  return (
    <div style={styles.analysisGrid}>
      <HelpTip active={helpMode} text="Probability this team wins all 6 games and takes the championship. Even 1-seeds are typically only 15-25%. Use this to compare teams, not as a prediction.">
        <div style={styles.statCard}>
          <div style={styles.statCardLabel}>Win Championship</div>
          <div style={styles.statCardValue}>{pct(winProb)}</div>
          {result.probSpread > 0.3 && (
            <div style={{ fontSize: 10, color: "#f97316", marginTop: 2 }}>
              range: {pct(result.probLow[5])}–{pct(result.probHigh[5])}
            </div>
          )}
        </div>
      </HelpTip>
      <HelpTip active={helpMode} text="Max bid with 90% confidence interval. The range shows uncertainty from pot estimation and probability model disagreement. If bid is below the LOW end, it's a strong buy even in the worst case.">
        <div style={styles.statCard}>
          <div style={styles.statCardLabel}>Max Bid (85% EV)</div>
          <div style={styles.statCardValue}>{fmt(result.maxBid)}</div>
          <div style={{ fontSize: 10, color: "#64748b", fontFamily: "'DM Mono', monospace", marginTop: 2 }}>
            {fmt(maxBidLow)} – {fmt(maxBidHigh)}
          </div>
          {overCap && (
            <div style={{ fontSize: 10, color: "#ef4444", marginTop: 4 }}>🚫 Over cap — no more purchases</div>
          )}
          {wouldExceedCap && (
            <div style={{ fontSize: 10, color: "#f97316", marginTop: 4 }}>
              ⚠️ Cap: {fmt(capRemaining)} left — bidding over makes this your LAST team
            </div>
          )}
        </div>
      </HelpTip>
      <HelpTip active={helpMode} text="The minimum tournament round this team must reach for the payout to cover what you paid. Green = good odds of breaking even. Red = you need a deep run to recover your money.">
        <div style={styles.statCard}>
          <div style={styles.statCardLabel}>Breakeven Round</div>
          <div style={styles.statCardValue}>{be ? be.round : "—"}</div>
        {be && (
          <>
            <div style={styles.statCardSub}>
              <span style={{ color: be.prob >= 0.5 ? "#22c55e" : be.prob >= 0.25 ? "#eab308" : "#ef4444", fontWeight: 700 }}>
                {pct(be.prob)} chance
              </span>
            </div>
            <div style={{ ...styles.statCardSub, marginTop: 2, fontSize: 10, color: "#64748b" }}>
              {beAtBid && bid > result.totalEv * 0.3
                ? `At $${bid.toFixed(0)} bid`
                : `At max bid $${Math.round(result.maxBid)}`}
            </div>
            {beAtBid && bid > result.totalEv * 0.3 && beAtBid.round !== beAtMax.round && (
              <div style={{ fontSize: 9, color: "#94a3b8", marginTop: 2 }}>
                At max bid ${Math.round(result.maxBid)}: {beAtMax.round} ({pct(beAtMax.prob)})
              </div>
            )}
          </>
        )}
      </div>
      </HelpTip>
      <HelpTip active={helpMode} text="Extra EV from bonus payouts (women's champion, biggest blowout). These are separate from round payouts and can add meaningful value to cheap teams.">
        <div style={styles.statCard}>
          <div style={styles.statCardLabel}>Bonus EV</div>
          <div style={styles.statCardValue}>{fmt(result.bonusEv)}</div>
          <div style={styles.statCardSub}>
            {Object.entries(result.bonusEvs).map(([k, v]) => (
              <span key={k} style={{ marginRight: 8 }}>{k === "womens_champ" ? "👩" : "😵"} {fmt(v)}</span>
            ))}
          </div>
        </div>
      </HelpTip>

      {/* KenPom Profile Badges */}
      {result.profile && (result.team.adj_o_rank != null || result.team.luck != null || result.team.adj_t != null) && (
        <div style={{ ...styles.statCard, gridColumn: "1 / -1" }}>
          <div style={styles.statCardLabel}>Team Profile</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
            {result.profile.champProfile && (
              <HelpTip active={helpMode} text="22 of 23 champions since 2002 ranked top-25 in both offense and defense. This team qualifies — it has the right build to win it all. Deep run probability boosted +5%.">
                <span style={styles.badgeGold}>🏆 Championship Profile</span>
              </HelpTip>
            )}
            {result.team.adj_o_rank != null && result.team.adj_d_rank != null && !result.profile.champProfile && (
              <HelpTip active={helpMode} text="This team doesn't rank top-25 in both offense and defense. Historically, teams without this profile almost never win it all. Deep run probability penalized.">
                <span style={styles.badgeWarn}>
                  ⚠️ Missing Champ Profile (O: #{result.team.adj_o_rank}, D: #{result.team.adj_d_rank})
                </span>
              </HelpTip>
            )}
            {result.profile.balanced && (
              <HelpTip active={helpMode} text="Both offense and defense rank top-40. This team can win shootouts AND grind-it-out defensive games. Tournament-proof build with lower variance. +2% boost.">
                <span style={styles.badgeGreen}>⚖️ Balanced (O: #{result.team.adj_o_rank}, D: #{result.team.adj_d_rank})</span>
              </HelpTip>
            )}
            {result.profile.lopsided && (
              <HelpTip active={helpMode} text="Extreme split: elite on one end, poor on the other. These teams are matchup-dependent — they can look unstoppable or get upset easily. Higher variance, -8% penalty.">
                <span style={styles.badgeDanger}>🎲 Lopsided — Matchup Dependent</span>
              </HelpTip>
            )}
            {result.profile.lucky && (
              <HelpTip active={helpMode} text="This team has been winning close games at an unsustainable rate. However, backtest shows lucky teams are underpriced in your group (+$31 avg profit). No EV penalty applied — display only.">
                <span style={styles.badgeGray}>🍀 Lucky ({(result.team.luck * 100).toFixed(1)}%) — Watch Only</span>
              </HelpTip>
            )}
            {result.team.luck != null && result.team.luck < -0.04 && (
              <HelpTip active={helpMode} text="This team has been losing close games at an unsustainable rate. Conventional wisdom says regression favors them, but backtest shows unlucky teams average -$112 profit in your group — they're actually overpriced because your group bids them up expecting a bounce-back.">
                <span style={styles.badgeDanger}>📉 Unlucky ({(result.team.luck * 100).toFixed(1)}%) — Group Overpays</span>
              </HelpTip>
            )}
            {result.profile.eliteDefense && (
              <HelpTip active={helpMode} text="Elite defense (D rank ≤15) without championship profile. These teams grind through early rounds but KP probs already capture this. Badge is context — no EV adjustment.">
                <span style={styles.badgeGray}>🛡️ Elite Defense (D: #{result.team.adj_d_rank})</span>
              </HelpTip>
            )}
            {result.profile.returning && (
              <HelpTip active={helpMode} text="This team was in last year's tournament. KP already rates returning teams higher. Badge is useful bidding context — your group may undervalue continuity. No EV adjustment (avoids double-counting).">
                <span style={styles.badgeGreen}>🔄 Returning</span>
              </HelpTip>
            )}
            {result.profile.overseeded && (
              <HelpTip active={helpMode} text="Committee overseeded this team — KenPom ranks them lower than their seed suggests. KP probs already account for this. Badge is context for your group's pricing. No EV adjustment.">
                <span style={styles.badgeDanger}>⬇️ Overseeded (KP rank #{result.team.ratingRank} vs {result.team.seed}-seed)</span>
              </HelpTip>
            )}
            {result.profile.underseeded && (
              <HelpTip active={helpMode} text="This team is better than their seed — KenPom ranks them higher. KP probs already capture this. Badge helps spot auction value if your group prices by seed. No EV adjustment.">
                <span style={styles.badgeGreen}>⬆️ Underseeded (KP rank #{result.team.ratingRank} vs {result.team.seed}-seed)</span>
              </HelpTip>
            )}
            {result.profile.sourceDisagree && (() => {
              const d = result.profile.sourceDisagree;
              const details = [];
              if (d.emGap >= 3.0) details.push(`AdjEM: Torvik ${d.torvik} vs KenPom ${d.kenpom} (${d.emGap} pt gap)`);
              if (d.oRankGap >= 20) details.push(`O Rank: #${d.torvikORank} vs #${d.kenpomORank}`);
              if (d.dRankGap >= 20) details.push(`D Rank: #${d.torvikDRank} vs #${d.kenpomDRank}`);
              return (
                <HelpTip active={helpMode} text={`Barttorvik and KenPom disagree significantly on this team. ${details.join(". ")}. The blended average may over- or undervalue them. Investigate: injury, transfer, schedule strength.`}>
                  <span style={styles.badgeWarn}>🔀 Sources Disagree — {details[0]}</span>
                </HelpTip>
              );
            })()}
            {(() => {
              const bp = getSchoolBrandPremium(result.team.name, seedHistory?.schoolPremiums);
              if (!bp) return null;
              if (bp.avgPremium > 0.2) return (
                <HelpTip active={helpMode} text={`This school has historically sold for ${(bp.avgPremium*100).toFixed(0)}% above the average price for its seed in your group (${bp.count} appearances). ${bp.loyalBidder ? `${bp.loyalBidder} has bought them multiple times and may bid emotionally.` : "The brand name drives the premium."} Consider letting someone else overpay.`}>
                  <span style={styles.badgeWarn}>🔥 Name Tax: +{(bp.avgPremium*100).toFixed(0)}% premium{bp.loyalBidder ? ` (${bp.loyalBidder} loyal)` : ""}</span>
                </HelpTip>
              );
              if (bp.avgPremium < -0.15) return (
                <HelpTip active={helpMode} text={`This school has historically sold for ${Math.abs(bp.avgPremium*100).toFixed(0)}% below the average price for its seed in your group (${bp.count} appearances). It flies under the radar — potential value buy if the team is strong this year.`}>
                  <span style={styles.badgeGreen}>💎 Undervalued Brand: {(bp.avgPremium*100).toFixed(0)}% below avg</span>
                </HelpTip>
              );
              return null;
            })()}
          </div>
          {Math.abs(result.profileAdj - 1.0) > 0.005 && (
            <div style={{ marginTop: 6, fontSize: 10, color: result.profileAdj > 1 ? "#22c55e" : "#ef4444" }}>
              Net profile adjustment: {result.profileAdj > 1 ? "+" : ""}{((result.profileAdj - 1) * 100).toFixed(1)}% on deep run probability
            </div>
          )}
        </div>
      )}

      {/* Who's Bidding? Predictor */}
      {(() => {
        const predictions = predictBidders(result.team.name, result.team.seed, seedHistory?.bidderProfiles);
        if (!predictions || predictions.length === 0) return null;
        return (
          <div style={{ ...styles.statCard, gridColumn: "1 / -1" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#f8fafc", marginBottom: 4 }}>🎯 Likely Bidders</div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {predictions.map((p) => (
                <div key={p.name} style={{ fontSize: 11, color: "#94a3b8", display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ color: p.score >= 3 ? "#f97316" : "#64748b", fontWeight: p.score >= 3 ? 700 : 400 }}>
                    {p.score >= 3 ? "🔥" : "👤"} {p.name}
                  </span>
                  <span style={{ fontSize: 9, color: "#64748b" }}>({p.reasons.join(", ")})</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Bidding Strategy */}
      {(() => {
        const isSold = sold[result.team.name] != null;
        if (isSold) return null;
        const strat = getBiddingStrategy(
          result.team, result, seedHistory?.schoolPremiums,
          nSold || 0, nMyTeams || 0, result.maxBid, bidCtx
        );
        if (!strat) return null;
        return (
          <HelpTip active={helpMode} text="Bidding strategy based on this team's brand premium in your group's history, loyal bidders, seed pricing patterns, and where you are in the auction. SNIPE = bid fast. PATIENCE = let others open. PASS = don't bother. VALUE = consistent edge.">
            <div style={{ ...styles.statCard, gridColumn: "1 / -1", borderLeft: `3px solid ${strat.color}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 16 }}>{strat.emoji}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: strat.color }}>{strat.headline}</span>
              </div>
              <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.5 }}>{strat.detail}</div>
              {strat.entryPrice && strat.mode !== "PASS" && (
                <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10, color: "#64748b" }}>Recommended bids:</span>
                  <button
                    onClick={() => setCurrentBid(String(strat.entryPrice))}
                    style={{ padding: "4px 12px", fontSize: 12, fontWeight: 700, fontFamily: "'DM Mono', monospace", background: strat.color + "20", color: strat.color, border: `1px solid ${strat.color}60`, borderRadius: 6, cursor: "pointer" }}
                    title="Click to set as your bid"
                  >
                    {strat.mode === "PATIENCE" ? "Max Entry" : "Open"} ${strat.entryPrice}
                  </button>
                  {strat.mode !== "PATIENCE" && Math.round(result.maxBid) !== strat.entryPrice && (
                    <button
                      onClick={() => setCurrentBid(String(Math.round(result.maxBid)))}
                      style={{ padding: "4px 12px", fontSize: 12, fontWeight: 700, fontFamily: "'DM Mono', monospace", background: "#1e293b", color: "#94a3b8", border: "1px solid #334155", borderRadius: 6, cursor: "pointer" }}
                      title="Click to set max bid"
                    >
                      Max ${Math.round(result.maxBid)}
                    </button>
                  )}
                  {strat.mode === "PATIENCE" && (
                    <span style={{ fontSize: 10, color: "#64748b", fontStyle: "italic" }}>
                      (only enter if price stays under max)
                    </span>
                  )}
                </div>
              )}
              {strat.contextNote && (
                <div style={{ marginTop: 6, fontSize: 10, color: "#64748b", fontStyle: "italic", lineHeight: 1.4 }}>
                  📊 {strat.contextNote}
                </div>
              )}
              {strat.queueAdvice && (
                <div style={{ marginTop: 6, fontSize: 11, color: "#818cf8", lineHeight: 1.4, padding: "6px 8px", background: "rgba(129,140,248,0.08)", borderRadius: 6, border: "1px solid rgba(129,140,248,0.2)" }}>
                  {strat.queueAdvice}
                </div>
              )}
              {/* Live competitor cap status + tactical advice (computed at current bid price) */}
              {(() => {
                const bt = bidCtx?.bidderTotals || {};
                const cap = bidCtx?.softCap || 600;
                const bidders = Object.values(bt);
                if (bidders.length === 0) return null;
                const price = bid || strat.entryPrice || result.maxBid || 0;
                let free = 0, lastTeam = 0, done = 0;
                let myStatus = null;
                for (const b of bidders) {
                  const spent = b.spent || 0;
                  const status = spent >= cap ? "done" : (spent + price > cap ? "last" : "free");
                  if (b.isMe) {
                    myStatus = { spent, remaining: cap - spent, status, teams: b.teams };
                  }
                  if (status === "done") done++;
                  else if (status === "last") lastTeam++;
                  else free++;
                }

                // Tactical advice computed at CURRENT bid price
                let advice = null;
                if (lastTeam >= 4 && free >= 2) {
                  advice = "🌊 WAVE ALERT: " + lastTeam + " bidders would hit their cap at $" + Math.round(price) + ". " +
                    "They're competing with desperate money. If you're bidding freely, consider letting them fight — " +
                    "the team AFTER this wave clears will be cheaper.";
                } else if (lastTeam >= 3 && lastTeam > free) {
                  advice = "⚠️ At $" + Math.round(price) + ", last-team bidders outnumber free bidders " + lastTeam + " to " + free + ". " +
                    "These bidders MUST deploy remaining budget — they'll overpay rather than leave empty.";
                } else if (done >= bidders.length * 0.5 && free >= 2) {
                  advice = "💰 BUYER'S MARKET: " + done + "/" + bidders.length + " bidders are done at this price. " +
                    "Competition is thin — lowball opportunities ahead.";
                } else if (free <= 2 && (myStatus?.teams || 0) >= 2) {
                  advice = "🎯 ENDGAME: Only " + free + " free bidders left at $" + Math.round(price) + ". " +
                    "You have pricing power on remaining teams.";
                }

                const barW = 120;
                const total = bidders.length;
                const freeW = Math.round(free / total * barW);
                const lastW = Math.round(lastTeam / total * barW);
                const doneW = barW - freeW - lastW;
                return (
                  <div style={{ marginTop: 8 }}>
                    {myStatus && (
                      <div style={{ fontSize: 10, marginBottom: 4, color: myStatus.status === "free" ? "#4ade80" : myStatus.status === "last" ? "#f97316" : "#64748b" }}>
                        👤 You: ${myStatus.spent} spent ({myStatus.teams} teams) · ${myStatus.remaining > 0 ? myStatus.remaining : 0} remaining
                        {myStatus.status === "last" && " · ⚠️ next buy is your LAST"}
                        {myStatus.status === "done" && " · cap reached"}
                      </div>
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 10, color: "#64748b" }}>Competition at ${Math.round(price)}:</span>
                      <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", width: barW }}>
                        <div style={{ width: freeW, background: "#ef4444" }} title={free + " bidding freely"} />
                        <div style={{ width: lastW, background: "#f97316" }} title={lastTeam + " last team"} />
                        <div style={{ width: doneW, background: "#334155" }} title={done + " tapped out"} />
                      </div>
                      <span style={{ fontSize: 10, color: "#94a3b8" }}>
                        🟥{free} free 🟧{lastTeam} last 🔲{done} done
                      </span>
                    </div>
                    {advice && (
                      <div style={{ marginTop: 6, fontSize: 11, color: "#f59e0b", lineHeight: 1.4, padding: "6px 8px", background: "rgba(245,158,11,0.08)", borderRadius: 6, border: "1px solid rgba(245,158,11,0.2)" }}>
                        {advice}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </HelpTip>
        );
      })()}

      {/* Quick round preview */}
      <div style={{ ...styles.statCard, gridColumn: "1 / -1" }}>
        <div style={styles.statCardLabel}>Round-by-Round Probability</div>
        <div style={styles.probBars}>
          {ROUND_NAMES.map((rn, i) => {
            const p = result.roundProbs[i] || 0;
            const cumPayout = payoutForRoundsWon(i + 1, pot, payouts, bonuses);
            const isBreakevenRound = be && be.roundName === rn;
            return (
              <div key={rn} style={{ ...styles.probBarRow, ...(isBreakevenRound ? { background: "#22c55e10", borderRadius: 4 } : {}) }}>
                <span style={{ ...styles.probLabel, fontWeight: isBreakevenRound ? 700 : 400 }}>
                  {isBreakevenRound ? "⮕ " : ""}{rn}
                </span>
                <div style={styles.probBarOuter}>
                  <div style={{ ...styles.probBarInner, width: `${p * 100}%`, background: p > 0.5 ? "#22c55e" : p > 0.2 ? "#eab308" : "#64748b" }} />
                </div>
                <span style={styles.probValue}>{pct(p)}</span>
                <span style={{ fontSize: 9, color: "#475569", width: 50, textAlign: "right" }}>{fmt(cumPayout)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RoundsTab({ result, bid, pot, payouts, bonuses }) {
  if (!result) return null;
  let cumPayout = 0;

  return (
    <div style={styles.roundsTable}>
      <div style={styles.roundsHeader}>
        <span style={{ flex: 2 }}>Round</span>
        <span style={{ flex: 1, textAlign: "right" }}>Prob</span>
        <span style={{ flex: 1, textAlign: "right" }}>Payout</span>
        <span style={{ flex: 1, textAlign: "right" }}>EV</span>
        {bid > 0 && <span style={{ flex: 1, textAlign: "right" }}>P&L</span>}
      </div>
      {ROUND_NAMES.map((rn, i) => {
        const frac = payouts[rn] || 0;
        const perTeam = pot * frac;
        cumPayout += perTeam;
        const ev = result.roundEvs[rn] || 0;
        const pnl = bid > 0 ? cumPayout - bid : null;
        const isBreakeven = pnl !== null && pnl >= 0 && (i === 0 || cumPayout - perTeam < bid);
        return (
          <div key={rn} style={{ ...styles.roundsRow, ...(isBreakeven ? { background: "#22c55e15", borderLeft: "3px solid #22c55e" } : {}) }}>
            <span style={{ flex: 2, fontWeight: isBreakeven ? 700 : 400 }}>{rn}{isBreakeven ? " ◄ BE" : ""}</span>
            <span style={{ flex: 1, textAlign: "right" }}>{pct(result.roundProbs[i])}</span>
            <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{fmt(perTeam)}</span>
            <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{fmt(ev)}</span>
            {bid > 0 && (
              <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: pnl >= 0 ? "#22c55e" : "#ef4444" }}>
                {pnl >= 0 ? "+" : ""}{fmt(pnl)}
              </span>
            )}
          </div>
        );
      })}
      {/* Bonus rows */}
      {Object.entries(result.bonusEvs).map(([k, v]) => (
        <div key={k} style={styles.roundsRow}>
          <span style={{ flex: 2, fontStyle: "italic" }}>🎁 {k === "womens_champ" ? "Women's Champ" : "Biggest Blowout"}</span>
          <span style={{ flex: 1 }} />
          <span style={{ flex: 1 }} />
          <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{fmt(v)}</span>
          {bid > 0 && <span style={{ flex: 1 }} />}
        </div>
      ))}
      <div style={{ ...styles.roundsRow, borderTop: "1px solid #334155", fontWeight: 700 }}>
        <span style={{ flex: 2 }}>TOTAL</span>
        <span style={{ flex: 1 }} />
        <span style={{ flex: 1 }} />
        <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{fmt(result.totalEv)}</span>
        {bid > 0 && (
          <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: result.totalEv - bid >= 0 ? "#22c55e" : "#ef4444" }}>
            {result.totalEv - bid >= 0 ? "+" : ""}{fmt(result.totalEv - bid)}
          </span>
        )}
      </div>
    </div>
  );
}

function ImpactTab({ whatif, selectedResult, bid, myTeams, splitTeams, portfolio, portfolioDist, results, allTeams, budget, selectedTeam, prevPortfolio, showPrevPortfolio }) {
  const hasPortfolio = Object.keys(myTeams).length > 0 || Object.keys(splitTeams || {}).length > 0 || (showPrevPortfolio && prevPortfolio && prevPortfolio.length > 0);

  if (!hasPortfolio) {
    return (
      <div style={styles.emptyState}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>📦</div>
        <div style={{ color: "#94a3b8", marginBottom: 4 }}>No portfolio yet</div>
        <div style={{ color: "#64748b", fontSize: 12 }}>Use "I Bought This" to add teams, or load a previous portfolio, then come back here to see how adding more teams impacts your portfolio.</div>
      </div>
    );
  }

  if (!bid || bid <= 0) {
    return (
      <div style={{ padding: 8 }}>
        <div style={{ color: "#94a3b8", marginBottom: 16, fontSize: 13 }}>Enter a bid price above to see portfolio impact analysis.</div>
        {portfolioDist && <PortfolioStatsCard dist={portfolioDist} label="Current Portfolio" />}
      </div>
    );
  }

  // Only block if owned in CURRENT auction (not previous portfolio — that's doubling down)
  const alreadyOwnedCurrent = myTeams[selectedTeam] || (splitTeams || {})[selectedTeam];
  const ownedInPrev = showPrevPortfolio && prevPortfolio && prevPortfolio.some(p => p.team === selectedTeam);
  if (alreadyOwnedCurrent && !ownedInPrev) {
    return (
      <div style={{ padding: 8 }}>
        <div style={{ color: "#94a3b8", marginBottom: 16, fontSize: 13 }}>You already own {selectedTeam} in this auction. Select an unsold team to see whatif impact.</div>
        {portfolioDist && <PortfolioStatsCard dist={portfolioDist} label="Current Portfolio" />}
      </div>
    );
  }
  if (alreadyOwnedCurrent && ownedInPrev) {
    return (
      <div style={{ padding: 8 }}>
        <div style={{ color: "#818cf8", marginBottom: 16, fontSize: 13 }}>📊 You own {selectedTeam} in both this auction and {prevPortfolio.find(p => p.team === selectedTeam)?.auction || "previous"}. Already doubled down.</div>
        {portfolioDist && <PortfolioStatsCard dist={portfolioDist} label="Current Portfolio" />}
      </div>
    );
  }

  // Doubling down context message (prev-only, not sold in current yet)
  const doublingDown = ownedInPrev && !alreadyOwnedCurrent;
  const prevEntry = doublingDown ? prevPortfolio.find(p => p.team === selectedTeam) : null;

  if (!whatif) {
    return (
      <div style={{ padding: 8 }}>
        {doublingDown && prevEntry && (
          <div style={{ color: "#818cf8", marginBottom: 8, fontSize: 12 }}>📊 DOUBLING DOWN: You own {selectedTeam} from {prevEntry.auction} (${Math.round(prevEntry.pricePaid * (prevEntry.share || 1))} invested). Buying here adds a second position — both ride on the same outcomes.</div>
        )}
        <div style={{ color: "#94a3b8", fontSize: 13 }}>Analyzing impact on your portfolio...</div>
        {portfolioDist && <PortfolioStatsCard dist={portfolioDist} label="Current Portfolio" />}
      </div>
    );
  }

  const { current, hypothetical, deltas, region, verdict, sameRegionCount } = whatif;
  const r = selectedResult;
  const teamEdge = r ? r.totalEv - bid : 0;

  function DeltaRow({ label, curVal, newVal, delta, isDollar, goodUp = true }) {
    const d = delta;
    const arrow = Math.abs(d) < 0.001 ? "→" : (d > 0) === goodUp ? "▲" : "▼";
    const arrowColor = Math.abs(d) < 0.001 ? "#64748b" : (d > 0) === goodUp ? "#22c55e" : "#ef4444";
    const fmtVal = (v) => isDollar ? `${v >= 0 ? "+" : ""}${fmt(v)}` : pct(v);
    const fmtDelta = isDollar ? `${d >= 0 ? "+" : ""}${fmt(d)}` : `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}pp`;
    return (
      <div style={styles.impactRow}>
        <span style={styles.impactLabel}>{label}</span>
        <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{fmtVal(curVal)}</span>
        <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{fmtVal(newVal)}</span>
        <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: arrowColor, fontWeight: 600 }}>
          {fmtDelta} {arrow}
        </span>
      </div>
    );
  }

  return (
    <div>
      {/* Verdict banner */}
      <div style={{ ...styles.verdictBanner, borderColor: verdict.color + "60", background: verdict.color + "10" }}>
        <span style={{ fontSize: 20 }}>{verdict.icon}</span>
        <div>
          <div style={{ fontWeight: 800, color: verdict.color, fontSize: 15 }}>{verdict.text}</div>
          <div style={{ fontSize: 11, color: "#94a3b8" }}>
            {verdict.text === "GOOD ADD" && "Improves win probability without crushing downside"}
            {verdict.text === "HIGH VARIANCE" && "Better P(profit) but steeper losses when wrong"}
            {verdict.text === "PORTFOLIO DRAG" && "Reduces P(profit) — likely overpaying at this price"}
            {verdict.text === "NEUTRAL" && "Doesn't change odds much but adds expected value"}
            {verdict.text === "MARGINAL" && "Small impact either way at this price"}
          </div>
        </div>
      </div>

      {/* Quick pros/cons summary */}
      {(() => {
        const pros = [];
        const cons = [];
        const team = r?.team;
        const edge = teamEdge;

        // EV edge
        if (edge > 20) pros.push(`+${fmt(edge)} EV edge — you're buying below expected value`);
        else if (edge > 0) pros.push(`+${fmt(edge)} positive edge (slim margin)`);
        else if (edge < -20) cons.push(`${fmt(edge)} negative edge — you're overpaying by ${fmt(Math.abs(edge))}`);
        else if (edge < 0) cons.push(`Slightly negative edge (${fmt(edge)})`);

        // P(profit) change
        if (deltas.pProfit > 0.02) pros.push(`P(profit) jumps ${(deltas.pProfit * 100).toFixed(1)}pp → ${pct(hypothetical.pProfit)}`);
        else if (deltas.pProfit > 0.005) pros.push(`P(profit) improves slightly (+${(deltas.pProfit * 100).toFixed(1)}pp)`);
        else if (deltas.pProfit < -0.02) cons.push(`P(profit) drops ${(deltas.pProfit * 100).toFixed(1)}pp → ${pct(hypothetical.pProfit)}`);
        else if (deltas.pProfit < -0.005) cons.push(`P(profit) dips slightly (${(deltas.pProfit * 100).toFixed(1)}pp)`);

        // Upside
        if (deltas.p90 > 50) pros.push(`Upside ceiling rises ${fmt(deltas.p90)} (P90: ${fmt(hypothetical.p90)})`);
        else if (deltas.p90 > 0) pros.push(`Modest upside boost (+${fmt(deltas.p90)})`);

        // Downside
        if (deltas.p10 < -50) cons.push(`Downside deepens ${fmt(deltas.p10)} (P10: ${fmt(hypothetical.p10)})`);
        else if (deltas.p10 < -10) cons.push(`Slightly more downside risk (${fmt(deltas.p10)})`);
        else if (deltas.p10 > 20) pros.push(`Floor improves +${fmt(deltas.p10)} — less risk of big loss`);

        // Median
        if (deltas.median > 30) pros.push(`Median outcome improves +${fmt(deltas.median)}`);
        else if (deltas.median < -30) cons.push(`Median outcome drops ${fmt(deltas.median)}`);

        // Region
        if (sameRegionCount === 0) pros.push(`New region (${region.tag.replace(/[^A-Za-z ]/g, '').trim()}) — diversifies bracket risk`);
        else if (sameRegionCount >= 2) cons.push(`${sameRegionCount + 1} teams in ${team?.region || "same region"} — they could eliminate each other`);
        else if (sameRegionCount === 1) cons.push(`2nd team in ${team?.region || "this region"} — some bracket overlap`);

        // Volatility
        if (deltas.std > 100) cons.push(`Volatility jumps +${fmt(deltas.std)} — bigger swings both ways`);

        // Budget
        // No self-budget enforcement — soft cap only applies to competitors

        // Championship profile
        if (r?.profile?.champProfile) pros.push("Strong KenPom profile (championship profile)");
        if (r?.profile?.eliteDefense) pros.push("Elite defense (D ≤15) — context only, KP probs already capture this");
        if (r?.profile?.lopsided) cons.push("Lopsided profile — one-dimensional, matchup-dependent (-12%)");
        if (r?.profile?.lucky) cons.push("Lucky profile — close-game record may regress (but group underprices these)");
        if (r?.profile?.returning) pros.push("Returning tournament team — continuity signal (no EV adj, KP captures)");
        if (r?.profile?.overseeded) cons.push("Overseeded by committee — KP ranks them lower (no EV adj, KP captures)");
        if (r?.profile?.underseeded) pros.push("Underseeded — KP says better than seed (no EV adj, KP captures)");

        if (pros.length === 0 && cons.length === 0) return null;

        return (
          <div style={{ ...styles.impactCard, padding: "12px 16px" }}>
            <h4 style={{ ...styles.impactCardTitle, marginBottom: 8 }}>📋 Quick Summary</h4>
            {pros.length > 0 && (
              <div style={{ marginBottom: pros.length > 0 && cons.length > 0 ? 8 : 0 }}>
                {pros.map((p, i) => (
                  <div key={i} style={{ fontSize: 12, color: "#4ade80", padding: "2px 0", display: "flex", gap: 6 }}>
                    <span style={{ flexShrink: 0 }}>✅</span>
                    <span>{p}</span>
                  </div>
                ))}
              </div>
            )}
            {cons.length > 0 && (
              <div>
                {cons.map((c, i) => (
                  <div key={i} style={{ fontSize: 12, color: "#f87171", padding: "2px 0", display: "flex", gap: 6 }}>
                    <span style={{ flexShrink: 0 }}>⚠️</span>
                    <span>{c}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* EV-level impact */}
      <div style={styles.impactCard}>
        <h4 style={styles.impactCardTitle}>📦 Portfolio Impact</h4>
        <div style={styles.impactHeader}>
          <span style={styles.impactLabel} />
          <span style={styles.impactColHead}>Current</span>
          <span style={styles.impactColHead}>+ This</span>
          <span style={styles.impactColHead}>Delta</span>
        </div>
        <div style={styles.impactRow}>
          <span style={styles.impactLabel}>Teams</span>
          <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{portfolio.teams.length}</span>
          <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{portfolio.teams.length + 1}</span>
          <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>+1</span>
        </div>
        <div style={styles.impactRow}>
          <span style={styles.impactLabel}>Invested</span>
          <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{fmt(portfolio.totalInvested)}</span>
          <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{fmt(portfolio.totalInvested + bid)}</span>
          <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: "#ef4444" }}>+{fmt(bid)}</span>
        </div>
        <div style={styles.impactRow}>
          <span style={styles.impactLabel}>Portfolio EV</span>
          <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{fmt(portfolio.totalEv)}</span>
          <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{fmt(portfolio.totalEv + (r?.totalEv || 0))}</span>
          <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: "#22c55e" }}>+{fmt(r?.totalEv || 0)}</span>
        </div>
        <div style={{ ...styles.impactRow, fontWeight: 700 }}>
          <span style={styles.impactLabel}>EV Edge</span>
          <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: portfolio.edge >= 0 ? "#22c55e" : "#ef4444" }}>
            {portfolio.edge >= 0 ? "+" : ""}{fmt(portfolio.edge)}
          </span>
          <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: portfolio.edge + teamEdge >= 0 ? "#22c55e" : "#ef4444" }}>
            {portfolio.edge + teamEdge >= 0 ? "+" : ""}{fmt(portfolio.edge + teamEdge)}
          </span>
          <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: teamEdge >= 0 ? "#22c55e" : "#ef4444" }}>
            {teamEdge >= 0 ? "+" : ""}{fmt(teamEdge)}
          </span>
        </div>
        {budget > 0 && (
          <div style={styles.impactRow}>
            <span style={styles.impactLabel}>Budget Left</span>
            <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{fmt(budget - portfolio.totalInvested)}</span>
            <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: budget - portfolio.totalInvested - bid < 0 ? "#ef4444" : "#94a3b8" }}>
              {fmt(budget - portfolio.totalInvested - bid)}
            </span>
            <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: "#ef4444" }}>-{fmt(bid)}</span>
          </div>
        )}
      </div>

      {/* Distribution impact */}
      <div style={styles.impactCard}>
        <h4 style={styles.impactCardTitle}>🎲 Distribution Analysis ({MC_SIMS.toLocaleString()} bracket-aware sims)</h4>
        <div style={styles.impactHeader}>
          <span style={styles.impactLabel} />
          <span style={styles.impactColHead}>Current</span>
          <span style={styles.impactColHead}>+ This</span>
          <span style={styles.impactColHead}>Delta</span>
        </div>
        <DeltaRow label="P(profit)" curVal={current.pProfit} newVal={hypothetical.pProfit} delta={deltas.pProfit} />
        <DeltaRow label="Expected Profit" curVal={current.mean} newVal={hypothetical.mean} delta={deltas.mean} isDollar />
        <DeltaRow label="Median Outcome" curVal={current.median} newVal={hypothetical.median} delta={deltas.median} isDollar />
        <DeltaRow label="Downside (P10)" curVal={current.p10} newVal={hypothetical.p10} delta={deltas.p10} isDollar />
        <DeltaRow label="Upside (P90)" curVal={current.p90} newVal={hypothetical.p90} delta={deltas.p90} isDollar />
        <DeltaRow label="Volatility (σ)" curVal={current.stdDev} newVal={hypothetical.stdDev} delta={deltas.std} isDollar goodUp={false} />
      </div>

      {/* Region exposure */}
      <div style={styles.impactCard}>
        <h4 style={styles.impactCardTitle}>🗺️ Region Exposure</h4>

        {/* Profit Distribution Histogram */}
        {whatif.hypothetical && (
          <div style={{ ...styles.impactCard, marginBottom: 12 }}>
            <h4 style={styles.impactCardTitle}>📊 Profit Distribution</h4>
            <ProfitHistogram dist={whatif.hypothetical} label="After" color="#22c55e" />
            <ProfitHistogram dist={whatif.current} label="Before" color="#64748b" />
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: region.color, flexShrink: 0 }} />
          <span style={{ color: region.color, fontWeight: 600, fontSize: 13 }}>{region.tag}</span>
        </div>
        {sameRegionCount >= 2 && (
          <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 8 }}>
            ⚠️ In {region.name} you'd own {sameRegionCount + 1} teams — only 1 can advance past Elite 8
          </div>
        )}
        {region.existing.length > 0 && (
          <div style={{ fontSize: 11, color: "#64748b" }}>
            Already in {region.name}: {region.existing.join(", ")}
          </div>
        )}
        {/* Region coverage map */}
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          {["South", "East", "Midwest", "West"].map((rgn) => {
            const count = portfolio.regions[rgn] || 0;
            const isCandidate = rgn === region.name;
            return (
              <div key={rgn} style={{
                padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                background: count > 0 ? "#1e40af30" : isCandidate ? "#22c55e20" : "#1e293b",
                border: `1px solid ${isCandidate ? "#22c55e" : count > 0 ? "#1e40af" : "#334155"}`,
                color: isCandidate ? "#22c55e" : count > 0 ? "#93c5fd" : "#64748b",
              }}>
                {rgn} {count > 0 ? `(${count})` : ""}{isCandidate && !myTeams[selectedTeam] ? " +1" : ""}
              </div>
            );
          })}
        </div>
      </div>

      {/* Per-team contribution (hypothetical portfolio) */}
      {hypothetical.perTeamStats && (
        <div style={styles.impactCard}>
          <h4 style={styles.impactCardTitle}>👥 Per-Team Contribution (after adding)</h4>
          <div style={{ ...styles.impactHeader, borderBottom: "1px solid #334155" }}>
            <span style={{ flex: 3 }}>Team</span>
            <span style={{ flex: 1, textAlign: "right" }}>Paid</span>
            <span style={{ flex: 1, textAlign: "right" }}>EV</span>
            <span style={{ flex: 1, textAlign: "right" }}>P(profit)</span>
          </div>
          {hypothetical.perTeamStats
            .sort((a, b) => b.meanProfit - a.meanProfit)
            .map((ts) => {
              const isNew = ts.name === selectedTeam;
              return (
                <div key={ts.name} style={{ ...styles.impactRow, ...(isNew ? { background: "#22c55e10", borderLeft: "2px solid #22c55e" } : {}) }}>
                  <span style={{ flex: 3, fontWeight: isNew ? 700 : 400 }}>
                    {isNew ? "→ " : ""}{ts.name}
                  </span>
                  <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{fmt(ts.price)}</span>
                  <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: ts.meanProfit >= 0 ? "#22c55e" : "#ef4444" }}>
                    {ts.meanProfit >= 0 ? "+" : ""}{fmt(ts.meanPayout)}
                  </span>
                  <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: ts.pProfit >= 0.5 ? "#22c55e" : ts.pProfit >= 0.3 ? "#eab308" : "#ef4444" }}>
                    {pct(ts.pProfit)}
                  </span>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

function PortfolioStatsCard({ dist, label }) {
  if (!dist) return null;
  return (
    <div style={styles.impactCard}>
      <h4 style={styles.impactCardTitle}>{label} ({MC_SIMS.toLocaleString()} bracket-aware sims)</h4>
      <div style={styles.pStatRow}><span>P(profit)</span><span style={{ ...styles.mono, color: dist.pProfit >= 0.5 ? "#22c55e" : "#eab308" }}>{pct(dist.pProfit)}</span></div>
      <div style={styles.pStatRow}><span>Expected Profit</span><span style={{ ...styles.mono, color: dist.mean >= 0 ? "#22c55e" : "#ef4444" }}>{dist.mean >= 0 ? "+" : ""}{fmt(dist.mean)}</span></div>
      <div style={styles.pStatRow}><span>Median</span><span style={{ ...styles.mono, color: dist.median >= 0 ? "#22c55e" : "#ef4444" }}>{dist.median >= 0 ? "+" : ""}{fmt(dist.median)}</span></div>
      <div style={styles.pStatRow}><span>Downside (P10)</span><span style={{ ...styles.mono, color: "#ef4444" }}>{fmt(dist.p10)}</span></div>
      <div style={styles.pStatRow}><span>Upside (P90)</span><span style={{ ...styles.mono, color: "#22c55e" }}>+{fmt(dist.p90)}</span></div>
      <div style={styles.pStatRow}><span>Best Case</span><span style={{ ...styles.mono, color: "#22c55e" }}>+{fmt(dist.maxProfit)}</span></div>
      <div style={styles.pStatRow}><span>Worst Case</span><span style={{ ...styles.mono, color: "#ef4444" }}>{fmt(dist.maxLoss)}</span></div>
      <ProfitHistogram dist={dist} label="Portfolio" color="#2563eb" />
      <div style={styles.pStatRow}><span>Volatility (σ)</span><span style={styles.mono}>{fmt(dist.stdDev)}</span></div>
    </div>
  );
}

function VegasTab({ result, disagreements, pot, payouts, bonuses }) {
  const hasVegas = result.vegasTitleProb != null;
  const hasKenpom = result.kenpomTitleProb != null;

  // Per-winner payouts from config (already per-winner fractions)
  const ROUND_KEYS = ["R64", "R32", "Sweet 16", "Elite 8", "Final Four", "Championship"];

  // Compute EV using a simple scaling from title prob
  function evFromTitleProb(titleProb, baseProbs) {
    if (!titleProb || !baseProbs || !baseProbs[5] || baseProbs[5] === 0) return null;
    const scale = titleProb / baseProbs[5];
    let ev = 0;
    for (let i = 0; i < 6; i++) {
      const scaledProb = Math.min(1.0, baseProbs[i] * Math.pow(scale, (i + 1) / 6));
      const frac = payouts[ROUND_KEYS[i]] || 0;
      ev += scaledProb * pot * frac;
    }
    return ev;
  }

  const modelEv = result.totalEv;
  const vegasEv = hasVegas ? evFromTitleProb(result.vegasTitleProb, result.roundProbs) : null;
  const evDelta = vegasEv != null ? modelEv - vegasEv : null;

  return (
    <div>
      <div style={styles.vegasCard}>
        <h4 style={styles.vegasTitle}>Probability Sources — {result.team.name}</h4>
        <div style={styles.vegasCompare}>
          <div style={styles.vegasBox}>
            <div style={styles.vegasBoxLabel}>Bracket Model</div>
            <div style={styles.vegasBoxValue}>{pct(result.modelTitleProb)}</div>
            <div style={styles.vegasBoxSub}>ratings + opponents</div>
          </div>
          {hasKenpom && (
            <>
              <div style={styles.vegasVs}>+</div>
              <div style={styles.vegasBox}>
                <div style={styles.vegasBoxLabel}>KenPom</div>
                <div style={styles.vegasBoxValue}>{pct(result.kenpomTitleProb)}</div>
                <div style={styles.vegasBoxSub}>full bracket sim</div>
              </div>
            </>
          )}
          {hasVegas && (
            <>
              <div style={styles.vegasVs}>+</div>
              <div style={styles.vegasBox}>
                <div style={styles.vegasBoxLabel}>Vegas</div>
                <div style={styles.vegasBoxValue}>{pct(result.vegasTitleProb)}</div>
                <div style={styles.vegasBoxSub}>de-vigged implied</div>
              </div>
            </>
          )}
          <div style={styles.vegasArrow}>→</div>
          <div style={{ ...styles.vegasBox, background: "#1e293b" }}>
            <div style={styles.vegasBoxLabel}>Ensemble</div>
            <div style={{ ...styles.vegasBoxValue, color: "#22c55e" }}>{pct(result.blendedTitleProb)}</div>
            <div style={styles.vegasBoxSub}>
              {hasKenpom && hasVegas ? "KP 50% / Bracket 20% / Vegas 30%"
                : hasKenpom ? "KP 70% / Bracket 30%"
                : hasVegas ? "Bracket 50% / Vegas 50%"
                : "Bracket model only"}
            </div>
          </div>
        </div>
        {/* Vegas adjustment explanation */}
        {hasVegas && (() => {
          const modelBase = result.modelTitleProb;
          const vegasP = result.vegasTitleProb;
          if (modelBase > 0 && vegasP > 0) {
            const ratio = modelBase / vegasP;
            if (ratio > VEGAS_DISAGREE_THRESHOLD) return <div style={{ ...styles.vegasNote, color: "#f97316" }}>⚠️ Model is higher than Vegas — market may know something (injury, matchup fear)</div>;
            if (ratio < 1 / VEGAS_DISAGREE_THRESHOLD) return <div style={{ ...styles.vegasNote, color: "#22c55e" }}>📈 Vegas sees more upside — sharp money or momentum not in ratings</div>;
            return <div style={styles.vegasNote}>✅ Sources in reasonable agreement — Vegas adjustment weighted to later rounds</div>;
          }
          return null;
        })()}
        {/* EV comparison */}
        {vegasEv != null && (
          <div style={{ display: "flex", gap: 12, marginTop: 10, padding: "8px 12px", background: "#0f172a", borderRadius: 6 }}>
            <div style={{ flex: 1, textAlign: "center" }}>
              <div style={{ fontSize: 9, color: "#64748b" }}>Model EV</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0", fontFamily: "'DM Mono', monospace" }}>{fmt(modelEv)}</div>
            </div>
            <div style={{ flex: 1, textAlign: "center" }}>
              <div style={{ fontSize: 9, color: "#64748b" }}>Vegas-Implied EV</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0", fontFamily: "'DM Mono', monospace" }}>{fmt(vegasEv)}</div>
            </div>
            <div style={{ flex: 1, textAlign: "center" }}>
              <div style={{ fontSize: 9, color: "#64748b" }}>Δ EV</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: evDelta > 10 ? "#f97316" : evDelta < -10 ? "#22c55e" : "#94a3b8", fontFamily: "'DM Mono', monospace" }}>
                {evDelta >= 0 ? "+" : ""}{fmt(evDelta)}
              </div>
              <div style={{ fontSize: 8, color: "#64748b" }}>{evDelta > 10 ? "model richer" : evDelta < -10 ? "Vegas sees more" : "in agreement"}</div>
            </div>
          </div>
        )}
        {hasVegas && (
          <div style={{ fontSize: 10, color: "#475569", marginTop: 8, lineHeight: 1.6 }}>
            Vegas odds anchor the championship probability, with adjustment concentrated in later rounds
            (F4/Championship absorb ~56% of the shift, R64/R32 only ~12%). This avoids the problem of
            spreading a title-odds signal evenly across rounds where it doesn't belong.
          </div>
        )}
      </div>

      {/* All disagreements */}
      {disagreements.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h4 style={styles.vegasTitle}>All Model vs. Vegas Disagreements</h4>
          <div style={styles.disagreeTable}>
            <div style={styles.disagreeHeader}>
              <span style={{ flex: 3 }}>Team</span>
              <span style={{ flex: 1, textAlign: "right" }}>Model</span>
              <span style={{ flex: 1, textAlign: "right" }}>Vegas</span>
              <span style={{ flex: 1, textAlign: "right" }}>Δ EV</span>
              <span style={{ flex: 2, textAlign: "right" }}>Signal</span>
            </div>
            {disagreements.slice(0, 10).map((d) => {
              const dVegasEv = evFromTitleProb(d.vegasTitleProb, d.roundProbs);
              const dModelEv = d.totalEv;
              const dEvDelta = dVegasEv != null ? dModelEv - dVegasEv : null;
              return (
              <div key={d.team.name} style={{ ...styles.disagreeRow, opacity: d.isSold ? 0.5 : 1 }}>
                <span style={{ flex: 3 }}>({d.team.seed}) {d.team.name} {d.isSold ? "(sold)" : ""}</span>
                <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{pct(d.modelTitleProb)}</span>
                <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{pct(d.vegasTitleProb)}</span>
                <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: dEvDelta != null && dEvDelta > 10 ? "#f97316" : dEvDelta != null && dEvDelta < -10 ? "#22c55e" : "#94a3b8" }}>
                  {dEvDelta != null ? (dEvDelta >= 0 ? "+" : "") + "$" + Math.round(dEvDelta) : "—"}
                </span>
                <span style={{ flex: 2, textAlign: "right", color: d.direction === "Vegas HIGH" ? "#22c55e" : "#f97316", fontWeight: 600, fontSize: 11 }}>
                  {d.direction === "Vegas HIGH" ? "📈 Value" : "⚠️ Overvalued"}
                </span>
              </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function CheatsheetTab({ regionEVs, disagreements, results, sold, pot, payouts, bonuses, seedHistory }) {
  const maxEV = regionEVs.length > 0 ? regionEVs[0][1] : 1;
  const hasHist = !!seedHistory;

  return (
    <div>
      {/* Region difficulty */}
      <h4 style={styles.csTitle}>🗺️ Region Difficulty</h4>
      <div style={styles.regionBars}>
        {regionEVs.map(([region, ev], i) => (
          <div key={region} style={styles.regionBarRow}>
            <span style={styles.regionName}>{region}</span>
            <div style={styles.regionBarOuter}>
              <div style={{ ...styles.regionBarInner, width: `${(ev / maxEV) * 100}%` }} />
            </div>
            <span style={styles.mono}>{fmt(ev)}</span>
            <span style={{ ...styles.regionLabel, color: i === 0 ? "#22c55e" : i === regionEVs.length - 1 ? "#ef4444" : "#64748b" }}>
              {i === 0 ? "EASIEST" : i === regionEVs.length - 1 ? "HARDEST" : ""}
            </span>
          </div>
        ))}
      </div>

      {/* Seed value table */}
      <h4 style={{ ...styles.csTitle, marginTop: 20 }}>📊 Value by Seed</h4>
      <div style={styles.seedTable}>
        <div style={styles.seedTableHeader}>
          <span style={{ width: 40 }}>Seed</span>
          <span style={{ flex: 1, textAlign: "right" }}>Avg EV</span>
          <span style={{ flex: 1, textAlign: "right" }}>Max Bid</span>
          <span style={{ flex: 1, textAlign: "right" }}>Win %</span>
          <span style={{ flex: 1, textAlign: "right" }}>Unsold</span>
          {hasHist && <span style={{ flex: 1, textAlign: "right" }}>Hist Rng</span>}
          {hasHist && <span style={{ flex: 1, textAlign: "right" }}>P(profit)</span>}
          {hasHist && <span style={{ width: 48, textAlign: "right" }}>Vrdct</span>}
        </div>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((seed) => {
          const seedResults = Object.values(results).filter((r) => r.team.seed === seed);
          if (seedResults.length === 0) return null;
          const avgEv = seedResults.reduce((s, r) => s + r.totalEv, 0) / seedResults.length;
          const avgMax = seedResults.reduce((s, r) => s + r.maxBid, 0) / seedResults.length;
          const avgWin = seedResults.reduce((s, r) => s + r.winProb, 0) / seedResults.length;
          const unsold = seedResults.filter((r) => !sold[r.team.name]).length;
          const hist = seedHistory?.seedStats?.[seed];
          return (
            <div key={seed} style={styles.seedTableRow}>
              <span style={{ width: 40, fontWeight: 600 }}>{seed}</span>
              <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{fmt(avgEv)}</span>
              <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{fmt(avgMax)}</span>
              <span style={{ ...styles.mono, flex: 1, textAlign: "right" }}>{pct(avgWin)}</span>
              <span style={{ flex: 1, textAlign: "right", color: unsold > 0 ? "#22c55e" : "#64748b" }}>{unsold}/{seedResults.length}</span>
              {hasHist && (
                <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: "#64748b", fontSize: 10 }}>
                  {hist ? `${fmt(hist.minFrac * pot)}–${fmt(hist.maxFrac * pot)}` : "—"}
                </span>
              )}
              {hasHist && (
                <span style={{ ...styles.mono, flex: 1, textAlign: "right", color: hist && hist.pProfit >= 0.35 ? "#22c55e" : hist ? "#ef4444" : "#64748b" }}>
                  {hist ? pct(hist.pProfit) : "—"}
                </span>
              )}
              {hasHist && (
                <span style={{ width: 48, textAlign: "right", fontWeight: 700, fontSize: 10, color: hist?.verdictColor || "#64748b" }}>
                  {hist?.verdict || "—"}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Vegas picks */}
      {disagreements.filter((d) => d.direction === "Vegas HIGH" && !d.isSold).length > 0 && (
        <>
          <h4 style={{ ...styles.csTitle, marginTop: 20 }}>📈 Vegas Value Picks (unsold)</h4>
          {disagreements
            .filter((d) => d.direction === "Vegas HIGH" && !d.isSold)
            .slice(0, 5)
            .map((d) => (
              <div key={d.team.name} style={styles.vegasPickRow}>
                <span>({d.team.seed}) {d.team.name}</span>
                <span style={{ color: "#22c55e", fontSize: 12 }}>
                  Vegas {pct(d.vegasTitleProb)} vs Model {pct(d.modelTitleProb)}
                </span>
              </div>
            ))}
        </>
      )}

      {/* Team Profiles Summary */}
      {(() => {
        const allR = Object.values(results);
        const champTeams = allR.filter(r => r.profile?.champProfile);
        const lopsidedTeams = allR.filter(r => r.profile?.lopsided);
        const luckyTeams = allR.filter(r => r.profile?.lucky);
        const disagreeTeams = allR.filter(r => r.profile?.sourceDisagree).sort((a, b) => (b.profile.sourceDisagree.emGap || 0) - (a.profile.sourceDisagree.emGap || 0));
        const hasProfiles = champTeams.length > 0 || lopsidedTeams.length > 0 || luckyTeams.length > 0 || disagreeTeams.length > 0;
        if (!hasProfiles) return null;
        return (
          <>
            <h4 style={{ ...styles.csTitle, marginTop: 20 }}>📋 KenPom Profiles</h4>
            {champTeams.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <span style={styles.badgeGold}>🏆 Championship Profile</span>
                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>
                  {champTeams.map(r => `(${r.team.seed}) ${r.team.name}`).join(", ")}
                </div>
              </div>
            )}
            {luckyTeams.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <span style={styles.badgeWarn}>🍀 Lucky — Regression Risk</span>
                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>
                  {luckyTeams.map(r => `(${r.team.seed}) ${r.team.name} (${(r.team.luck * 100).toFixed(1)}%)`).join(", ")}
                </div>
              </div>
            )}
            {lopsidedTeams.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <span style={styles.badgeDanger}>🎲 Lopsided — Matchup Dependent</span>
                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>
                  {lopsidedTeams.map(r => `(${r.team.seed}) ${r.team.name} (O:#${r.team.adj_o_rank} D:#${r.team.adj_d_rank})`).join(", ")}
                </div>
              </div>
            )}
            {disagreeTeams.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <span style={styles.badgeWarn}>🔀 Sources Disagree (Barttorvik vs KenPom)</span>
                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>
                  {disagreeTeams.map(r => {
                    const d = r.profile.sourceDisagree;
                    const parts = [];
                    if (d.emGap >= 3.0) parts.push(`AdjEM gap ${d.emGap}`);
                    if (d.oRankGap >= 20) parts.push(`O rank gap ${d.oRankGap}`);
                    if (d.dRankGap >= 20) parts.push(`D rank gap ${d.dRankGap}`);
                    return `(${r.team.seed}) ${r.team.name} [${parts.join(", ")}]`;
                  }).join("; ")}
                </div>
              </div>
            )}
          </>
        );
      })()}
      {/* Brand premiums from history */}
      {seedHistory?.schoolPremiums && (() => {
        const premiums = Object.values(seedHistory.schoolPremiums)
          .filter(sp => Math.abs(sp.avgPremium) > 0.15)
          .sort((a, b) => b.avgPremium - a.avgPremium);
        if (premiums.length === 0) return null;
        const overpriced = premiums.filter(sp => sp.avgPremium > 0.15);
        const underpriced = premiums.filter(sp => sp.avgPremium < -0.15);
        return (
          <div style={styles.statCard}>
            <div style={styles.statCardLabel}>🔥 Brand Premiums (Historical)</div>
            {overpriced.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 10, color: "#f97316", fontWeight: 600, marginBottom: 4 }}>NAME TAX — These schools sell above average for their seed:</div>
                <div style={{ fontSize: 11, color: "#94a3b8" }}>
                  {overpriced.map(sp => (
                    <div key={sp.name} style={{ display: "flex", justifyContent: "space-between", padding: "1px 0" }}>
                      <span>{sp.name} <span style={{ color: "#475569" }}>({sp.count}x, avg seed {sp.avgSeed.toFixed(0)})</span></span>
                      <span style={{ color: "#f97316", fontFamily: "'DM Mono', monospace" }}>+{(sp.avgPremium * 100).toFixed(0)}%{sp.loyalBidder ? ` (${sp.loyalBidder})` : ""}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {underpriced.length > 0 && (
              <div>
                <div style={{ fontSize: 10, color: "#22c55e", fontWeight: 600, marginBottom: 4 }}>STEALTH VALUE — These schools sell below average for their seed:</div>
                <div style={{ fontSize: 11, color: "#94a3b8" }}>
                  {underpriced.map(sp => (
                    <div key={sp.name} style={{ display: "flex", justifyContent: "space-between", padding: "1px 0" }}>
                      <span>{sp.name} <span style={{ color: "#475569" }}>({sp.count}x, avg seed {sp.avgSeed.toFixed(0)})</span></span>
                      <span style={{ color: "#22c55e", fontFamily: "'DM Mono', monospace" }}>{(sp.avgPremium * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
// ============================================================

/**
 * SVG histogram of profit distribution from MC simulation.
 * Renders a simple bar chart showing frequency of profit buckets.
 */
function ProfitHistogram({ dist, label, color }) {
  if (!dist) return null;
  // Build histogram bins from distribution stats
  const min = dist.maxLoss || dist.p10 * 1.5;
  const max = dist.maxProfit || dist.p90 * 1.5;
  const nBins = 20;
  const binWidth = (max - min) / nBins;
  if (binWidth <= 0) return null;

  // Approximate bins from known percentiles
  const percentiles = [
    { p: 0, v: min }, { p: 0.1, v: dist.p10 }, { p: 0.25, v: dist.p25 },
    { p: 0.5, v: dist.median }, { p: 0.75, v: dist.p75 }, { p: 0.9, v: dist.p90 },
    { p: 1, v: max },
  ];

  // Interpolate CDF and create histogram
  function cdfAt(x) {
    if (x <= min) return 0;
    if (x >= max) return 1;
    for (let i = 1; i < percentiles.length; i++) {
      if (x <= percentiles[i].v) {
        const t = (x - percentiles[i-1].v) / (percentiles[i].v - percentiles[i-1].v || 1);
        return percentiles[i-1].p + t * (percentiles[i].p - percentiles[i-1].p);
      }
    }
    return 1;
  }

  const bins = [];
  let maxFreq = 0;
  for (let i = 0; i < nBins; i++) {
    const lo = min + i * binWidth;
    const hi = lo + binWidth;
    const freq = cdfAt(hi) - cdfAt(lo);
    bins.push({ lo, hi, freq, mid: (lo + hi) / 2 });
    if (freq > maxFreq) maxFreq = freq;
  }

  const W = 280, H = 60, pad = 2;
  const barW = (W - pad * 2) / nBins;

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 10, color: "#64748b", marginBottom: 2 }}>{label}</div>
      <svg width={W} height={H + 16} style={{ display: "block" }}>
        {bins.map((b, i) => {
          const barH = maxFreq > 0 ? (b.freq / maxFreq) * H : 0;
          const isProfit = b.mid > 0;
          return (
            <rect key={i} x={pad + i * barW} y={H - barH} width={barW - 1} height={barH}
              fill={isProfit ? color : "#ef4444"} opacity={0.7} rx={1} />
          );
        })}
        {/* Zero line */}
        {(() => {
          const zeroX = pad + ((0 - min) / (max - min)) * (W - pad * 2);
          if (zeroX > pad && zeroX < W - pad) {
            return <line x1={zeroX} y1={0} x2={zeroX} y2={H} stroke="#f8fafc" strokeWidth={1} strokeDasharray="3,2" />;
          }
          return null;
        })()}
        <text x={pad} y={H + 12} fontSize={8} fill="#64748b">{fmt(min)}</text>
        <text x={W - pad} y={H + 12} fontSize={8} fill="#64748b" textAnchor="end">{fmt(max)}</text>
        <text x={W / 2} y={H + 12} fontSize={8} fill="#94a3b8" textAnchor="middle">P(profit): {pct(dist.pProfit)}</text>
      </svg>
    </div>
  );
}

/**
 * Bracket visualization showing all 4 regions with teams colored by ownership.
 * Highlights your teams, shows EV and sold prices.
 */
function BracketTab({ allTeams, results, sold, myTeams, onSelect, portfolioDist }) {
  const regions = {};
  for (const t of allTeams) {
    if (!regions[t.region]) regions[t.region] = [];
    regions[t.region].push(t);
  }

  const regionNames = Object.keys(regions);
  // Standard bracket matchup order
  const matchupOrder = [[1,16],[8,9],[5,12],[4,13],[6,11],[3,14],[7,10],[2,15]];

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {regionNames.map((rn) => {
          const teams = regions[rn].sort((a, b) => a.seed - b.seed);
          const bySeed = {};
          teams.forEach((t) => { bySeed[t.seed] = t; });

          // Region total EV
          const regionEv = teams.reduce((s, t) => {
            const r = results[t.name];
            return s + (r?.totalEv || 0);
          }, 0);

          return (
            <div key={rn} style={{ background: "#1e293b", borderRadius: 10, padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>{rn}</span>
                <span style={{ ...{ fontFamily: "'DM Mono', monospace", fontSize: 11 }, color: "#64748b" }}>Σ EV: {fmt(regionEv)}</span>
              </div>
              {matchupOrder.map(([sA, sB], idx) => {
                const tA = bySeed[sA], tB = bySeed[sB];
                return (
                  <div key={idx} style={{ display: "flex", gap: 2, marginBottom: 2 }}>
                    {[tA, tB].map((t) => {
                      if (!t) return <div key={Math.random()} style={{ flex: 1 }} />;
                      const r = results[t.name];
                      const isMine = !!myTeams[t.name];
                      const isSold = !!sold[t.name];
                      const bg = isMine ? "#22c55e18" : isSold ? "#1e293b" : "#0f172a";
                      const border = isMine ? "1px solid #22c55e40" : isSold ? "1px solid #33415580" : "1px solid #1e293b";
                      return (
                        <div
                          key={t.name}
                          style={{
                            flex: 1, padding: "3px 6px", borderRadius: 4,
                            background: bg, border, cursor: "pointer",
                            fontSize: 10, display: "flex", justifyContent: "space-between", alignItems: "center",
                          }}
                          onClick={() => onSelect(t.name)}
                        >
                          <span style={{ fontWeight: isMine ? 700 : 400, color: isMine ? "#22c55e" : isSold ? "#94a3b8" : "#e2e8f0" }}>
                            <span style={{
                              display: "inline-block", width: 14, height: 14, borderRadius: 7,
                              background: seedColor(t.seed), textAlign: "center", lineHeight: "14px",
                              fontSize: 8, fontWeight: 700, color: "#fff", marginRight: 4,
                            }}>{t.seed}</span>
                            {t.name.length > 12 ? t.name.slice(0, 11) + "…" : t.name}
                          </span>
                          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: isMine ? "#22c55e" : "#64748b" }}>
                            {isSold ? fmt(sold[t.name]) : r ? fmt(r.totalEv) : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {/* My teams in this region */}
              {(() => {
                const mine = teams.filter((t) => myTeams[t.name]);
                if (mine.length === 0) return null;
                return (
                  <div style={{ marginTop: 4, fontSize: 9, color: "#22c55e", borderTop: "1px solid #334155", paddingTop: 4 }}>
                    ✓ You own: {mine.map((t) => `(${t.seed}) ${t.name}`).join(", ")}
                    {mine.length >= 2 && <span style={{ color: "#eab308" }}> ⚠️ E8 conflict possible</span>}
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>
      {/* Legend */}
      <div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 12, fontSize: 10, color: "#64748b" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "#22c55e18", border: "1px solid #22c55e40", display: "inline-block" }} /> My Team
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "#1e293b", border: "1px solid #33415580", display: "inline-block" }} /> Sold
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "#0f172a", border: "1px solid #1e293b", display: "inline-block" }} /> Available
        </span>
      </div>
      {/* Win paths */}
      {portfolioDist && portfolioDist.winPaths && portfolioDist.winPaths.length > 0 && (
        <div style={{ marginTop: 16, background: "#1e293b", borderRadius: 10, padding: 12 }}>
          <div style={{ fontSize: 12, color: "#22c55e", fontWeight: 700, marginBottom: 8 }}>🎯 Top 5 Paths to +$1,000</div>
          {portfolioDist.winPaths.map((path, i) => (
            <div key={i} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: i < portfolioDist.winPaths.length - 1 ? "1px solid #334155" : "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ color: "#e2e8f0", fontSize: 11, fontWeight: 600 }}>#{i + 1}</span>
                <span style={{ color: "#22c55e", fontSize: 11, fontWeight: 600 }}>avg +{fmt(path.avgProfit)}</span>
                <span style={{ color: "#64748b", fontSize: 10 }}>{(path.pct * 100).toFixed(1)}% of sims</span>
              </div>
              <div style={{ fontSize: 11, lineHeight: 1.6, paddingLeft: 4 }}>
                {path.teams.map((t, j) => (
                  <div key={j} style={{ display: "flex", justifyContent: "space-between" }}>
                    <span><span style={{ color: "#e2e8f0" }}>{t.name}</span> <span style={{ color: "#818cf8" }}>→ {t.round}</span></span>
                    <span style={{ color: "#94a3b8", fontFamily: "'DM Mono', monospace", fontSize: 10 }}>${t.payout}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div style={{ fontSize: 9, color: "#475569", marginTop: 4 }}>Based on {(portfolioDist.winPaths.reduce((s, p) => s + p.count, 0)).toLocaleString()} sims that exceeded +$1,000. Shows top 3 contributing teams per path.</div>
        </div>
      )}
    </div>
  );
}

function TournamentTab({ portfolio, prevPortfolio, showPrevPortfolio, results, simMatrix, projectedPot, payouts, bonuses, tournamentResults, setTournamentResults, allTeams, myTeams, splitTeams }) {
  // Build list of all portfolio teams
  const portfolioTeams = useMemo(() => {
    const teams = [];
    // Current auction
    for (const [name, price] of Object.entries(myTeams)) {
      const t = allTeams.find(x => x.name === name);
      const r = results[name];
      teams.push({ name, price, share: 1, auction: "Current", seed: t?.seed, region: t?.region, ev: r?.totalEv || 0 });
    }
    for (const [name, info] of Object.entries(splitTeams)) {
      if (myTeams[name]) continue;
      const t = allTeams.find(x => x.name === name);
      const r = results[name];
      teams.push({ name, price: info.price * info.share, share: info.share, auction: "Current", seed: t?.seed, region: t?.region, ev: (r?.totalEv || 0) * info.share });
    }
    // Previous portfolio
    if (showPrevPortfolio && prevPortfolio.length > 0) {
      for (const p of prevPortfolio) {
        teams.push({ name: p.team, price: p.pricePaid * (p.share || 1), share: p.share || 1, auction: p.auction, seed: p.seed, region: p.region, ev: (p.ev || 0) * (p.share || 1) });
      }
    }
    return teams;
  }, [myTeams, splitTeams, allTeams, results, prevPortfolio, showPrevPortfolio]);

  // Result options
  const STATUS_OPTIONS = [
    { value: "", label: "—", wins: 0, eliminated: false },
    { value: "lost_r64", label: "Lost R64", wins: 0, eliminated: true },
    { value: "won_r64", label: "✓ Won R64", wins: 1, eliminated: false },
    { value: "lost_r32", label: "Lost R32", wins: 1, eliminated: true },
    { value: "won_r32", label: "✓ Won R32", wins: 2, eliminated: false },
    { value: "lost_s16", label: "Lost S16", wins: 2, eliminated: true },
    { value: "won_s16", label: "✓ Won S16", wins: 3, eliminated: false },
    { value: "lost_e8", label: "Lost E8", wins: 3, eliminated: true },
    { value: "won_e8", label: "✓ Won E8", wins: 4, eliminated: false },
    { value: "lost_f4", label: "Lost F4", wins: 4, eliminated: true },
    { value: "won_f4", label: "✓ Won F4", wins: 5, eliminated: false },
    { value: "lost_final", label: "Lost Final", wins: 5, eliminated: true },
    { value: "champ", label: "🏆 Champion", wins: 6, eliminated: true },
  ];

  // Compute filtered MC distribution
  const tournamentDist = useMemo(() => {
    if (!simMatrix || portfolioTeams.length === 0) return null;

    const firstKey = Object.keys(simMatrix)[0];
    const nSims = firstKey ? simMatrix[firstKey].length : 0;
    if (nSims === 0) return null;

    // Build constraints from tournamentResults
    const constraints = {};
    for (const t of portfolioTeams) {
      const tr = tournamentResults[t.name];
      if (!tr) continue;
      const opt = STATUS_OPTIONS.find(o => o.value === tr);
      if (opt && opt.value) constraints[t.name] = opt;
    }

    // Build entry payout tables
    const RK = ["R64", "R32", "Sweet 16", "Elite 8", "Final Four", "Championship"];
    const defaultPayoutTable = [0];
    let cum = 0;
    for (let i = 0; i < 6; i++) { cum += projectedPot * (payouts[RK[i]] || 0); defaultPayoutTable.push(cum); }

    const entries = portfolioTeams.map(t => {
      let prevPayoutTable = null;
      if (t.auction !== "Current" && showPrevPortfolio) {
        const p = prevPortfolio.find(pp => pp.team === t.name);
        if (p && p.payouts && p.potSize) {
          prevPayoutTable = [0];
          let c2 = 0;
          for (let i = 0; i < 6; i++) { c2 += p.potSize * (p.payouts[RK[i]] || 0); prevPayoutTable.push(c2); }
        }
      }
      return { name: t.name, price: t.price, payoutTable: prevPayoutTable || defaultPayoutTable };
    });

    const totalCost = entries.reduce((s, e) => s + e.price, 0);

    // Rejection sampling: keep only sims consistent with known results
    const validProfits = [];
    const ROUND_LABELS = ["R64", "R32", "S16", "E8", "F4", "Champ"];
    const pathCounts = {};
    let totalPayout_sum = 0;
    let lockedPayout = 0; // Known payout from eliminated teams

    // Pre-compute locked payouts (teams with final known results)
    for (const e of entries) {
      const c = constraints[e.name];
      if (c && c.eliminated) {
        lockedPayout += e.payoutTable[c.wins] || 0;
      }
    }

    for (let s = 0; s < nSims; s++) {
      let consistent = true;
      let totalPayout = 0;
      const simContributors = [];

      for (let t = 0; t < entries.length; t++) {
        const e = entries[t];
        const c = constraints[e.name];
        const teamSims = simMatrix[e.name];
        const simWins = teamSims ? teamSims[s] : 0;

        if (c) {
          if (c.eliminated) {
            // Team is out — sim must match exactly
            if (simWins !== c.wins) { consistent = false; break; }
            totalPayout += e.payoutTable[c.wins] || 0;
          } else {
            // Team still alive — sim must have at least this many wins
            if (simWins < c.wins) { consistent = false; break; }
            totalPayout += e.payoutTable[simWins] || 0;
          }
        } else {
          totalPayout += e.payoutTable[simWins] || 0;
        }

        if (simWins > 0) simContributors.push({ idx: t, roundsWon: simWins, payout: e.payoutTable[simWins] || 0 });
      }

      if (!consistent) continue;

      const profit = totalPayout - totalCost;
      validProfits.push(profit);
      totalPayout_sum += totalPayout;

      // Track win paths for big wins
      if (profit >= 1000) {
        const top = simContributors.filter(r => r.roundsWon >= 2).sort((a, b) => b.payout - a.payout).slice(0, 3);
        const key = top.map(r => entries[r.idx].name + "→" + ROUND_LABELS[r.roundsWon - 1]).join(" + ");
        if (key) {
          if (!pathCounts[key]) pathCounts[key] = { count: 0, totalProfit: 0, teams: top.map(r => ({ name: entries[r.idx].name, round: ROUND_LABELS[r.roundsWon - 1], payout: Math.round(r.payout) })) };
          pathCounts[key].count++;
          pathCounts[key].totalProfit += profit;
        }
      }
    }

    if (validProfits.length < 10) return { insufficient: true, validCount: validProfits.length, totalSims: nSims };

    const sorted = validProfits.sort((a, b) => a - b);
    const n = sorted.length;
    const mean = sorted.reduce((s, v) => s + v, 0) / n;
    const median = sorted[Math.floor(n / 2)];
    const pProfit = sorted.filter(p => p > 0).length / n;
    const p10 = sorted[Math.floor(n * 0.1)];
    const p90 = sorted[Math.floor(n * 0.9)];
    const maxProfit = sorted[n - 1];
    const maxLoss = sorted[0];

    const winPaths = Object.values(pathCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(p => ({ ...p, avgProfit: p.totalProfit / p.count, pct: p.count / n }));

    return { totalCost, mean, median, pProfit, p10, p90, maxProfit, maxLoss, validCount: n, totalSims: nSims, lockedPayout, winPaths };
  }, [portfolioTeams, simMatrix, tournamentResults, projectedPot, payouts, bonuses, prevPortfolio, showPrevPortfolio]);

  const anyResults = Object.values(tournamentResults).some(v => v);

  // Compute current locked-in payout from known results
  const currentPayout = useMemo(() => {
    let payout = 0;
    const RK = ["R64", "R32", "Sweet 16", "Elite 8", "Final Four", "Championship"];
    for (const t of portfolioTeams) {
      const tr = tournamentResults[t.name];
      if (!tr) continue;
      const opt = STATUS_OPTIONS.find(o => o.value === tr);
      if (!opt || opt.wins === 0) continue;
      let table;
      if (t.auction !== "Current") {
        const p = prevPortfolio.find(pp => pp.team === t.name);
        if (p && p.payouts && p.potSize) {
          table = [0];
          let c2 = 0;
          for (let i = 0; i < 6; i++) { c2 += p.potSize * (p.payouts[RK[i]] || 0); table.push(c2); }
        }
      }
      if (!table) {
        table = [0];
        let c2 = 0;
        for (let i = 0; i < 6; i++) { c2 += projectedPot * (payouts[RK[i]] || 0); table.push(c2); }
      }
      payout += table[opt.wins] || 0;
    }
    return payout;
  }, [portfolioTeams, tournamentResults, projectedPot, payouts, prevPortfolio]);

  const totalInvested = portfolioTeams.reduce((s, t) => s + t.price, 0);

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>🏀 Tournament Tracker</div>
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 12 }}>Enter results as they happen. Stats update live based on remaining possible outcomes.</div>

        {/* Summary stats */}
        <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{ background: "#1e293b", borderRadius: 8, padding: "8px 14px", flex: 1, minWidth: 100 }}>
            <div style={{ fontSize: 9, color: "#64748b" }}>Invested</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{fmt(totalInvested)}</div>
          </div>
          <div style={{ background: "#1e293b", borderRadius: 8, padding: "8px 14px", flex: 1, minWidth: 100 }}>
            <div style={{ fontSize: 9, color: "#64748b" }}>Collected</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: currentPayout > 0 ? "#22c55e" : "#94a3b8" }}>{fmt(currentPayout)}</div>
          </div>
          <div style={{ background: "#1e293b", borderRadius: 8, padding: "8px 14px", flex: 1, minWidth: 100 }}>
            <div style={{ fontSize: 9, color: "#64748b" }}>P&L So Far</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: currentPayout - totalInvested >= 0 ? "#22c55e" : "#ef4444" }}>
              {currentPayout - totalInvested >= 0 ? "+" : ""}{fmt(currentPayout - totalInvested)}
            </div>
          </div>
          {tournamentDist && !tournamentDist.insufficient && (
            <>
              <div style={{ background: "#1e293b", borderRadius: 8, padding: "8px 14px", flex: 1, minWidth: 100 }}>
                <div style={{ fontSize: 9, color: "#64748b" }}>P(profit)</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: tournamentDist.pProfit >= 0.5 ? "#22c55e" : "#eab308" }}>{pct(tournamentDist.pProfit)}</div>
              </div>
              <div style={{ background: "#1e293b", borderRadius: 8, padding: "8px 14px", flex: 1, minWidth: 100 }}>
                <div style={{ fontSize: 9, color: "#64748b" }}>Projected Median</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: tournamentDist.median >= 0 ? "#22c55e" : "#ef4444" }}>
                  {tournamentDist.median >= 0 ? "+" : ""}{fmt(tournamentDist.median)}
                </div>
              </div>
              <div style={{ background: "#1e293b", borderRadius: 8, padding: "8px 14px", flex: 1, minWidth: 100 }}>
                <div style={{ fontSize: 9, color: "#64748b" }}>Downside (P10)</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#ef4444" }}>{fmt(tournamentDist.p10)}</div>
              </div>
              <div style={{ background: "#1e293b", borderRadius: 8, padding: "8px 14px", flex: 1, minWidth: 100 }}>
                <div style={{ fontSize: 9, color: "#64748b" }}>Upside (P90)</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#22c55e" }}>+{fmt(tournamentDist.p90)}</div>
              </div>
            </>
          )}
        </div>

        {tournamentDist && !tournamentDist.insufficient && (
          <div style={{ fontSize: 10, color: "#475569", marginBottom: 12 }}>
            Based on {tournamentDist.validCount.toLocaleString()} / {tournamentDist.totalSims.toLocaleString()} consistent simulations
            {tournamentDist.validCount < tournamentDist.totalSims * 0.05 && (
              <span style={{ color: "#f97316" }}> ⚠️ Few sims match — results may be noisy</span>
            )}
          </div>
        )}
        {tournamentDist && tournamentDist.insufficient && (
          <div style={{ background: "#7f1d1d30", border: "1px solid #ef444440", borderRadius: 8, padding: 8, fontSize: 11, color: "#fca5a5", marginBottom: 12 }}>
            Too few simulations match the entered results ({tournamentDist.validCount} / {tournamentDist.totalSims}). Try checking your entries for errors.
          </div>
        )}
      </div>

      {/* Team results entry */}
      <div style={{ background: "#1e293b", borderRadius: 10, padding: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 8 }}>Enter Results</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {portfolioTeams.map((t) => {
            const tr = tournamentResults[t.name] || "";
            const opt = STATUS_OPTIONS.find(o => o.value === tr);
            const isElim = opt && opt.eliminated;
            const isAlive = opt && opt.value && !opt.eliminated;
            return (
              <div key={t.name + t.auction} style={{
                display: "flex", alignItems: "center", gap: 8, padding: "4px 8px",
                borderRadius: 6, background: isElim ? "#7f1d1d15" : isAlive ? "#14532d15" : "transparent",
              }}>
                <span style={{ width: 18, height: 18, borderRadius: 9, background: seedColor(t.seed), textAlign: "center", lineHeight: "18px", fontSize: 9, fontWeight: 700, color: "#fff", flexShrink: 0 }}>{t.seed}</span>
                <span style={{ flex: 1, fontSize: 11, fontWeight: 600, color: isElim ? "#ef4444" : isAlive ? "#22c55e" : "#e2e8f0", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.name}
                  {t.auction !== "Current" && <span style={{ color: "#818cf8", fontSize: 9, marginLeft: 4 }}>({t.auction})</span>}
                  {t.share < 1 && <span style={{ color: "#64748b", fontSize: 9, marginLeft: 4 }}>{Math.round(t.share * 100)}%</span>}
                </span>
                <span style={{ fontSize: 9, color: "#64748b", flexShrink: 0 }}>{t.region}</span>
                <select
                  value={tr}
                  onChange={(e) => setTournamentResults(prev => ({ ...prev, [t.name]: e.target.value }))}
                  style={{
                    background: "#0f172a", color: isElim ? "#ef4444" : isAlive ? "#22c55e" : "#94a3b8",
                    border: "1px solid #334155", borderRadius: 4, padding: "3px 6px", fontSize: 10, width: 110, flexShrink: 0, cursor: "pointer",
                  }}
                >
                  {STATUS_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      </div>

      {/* Win paths */}
      {tournamentDist && tournamentDist.winPaths && tournamentDist.winPaths.length > 0 && (
        <div style={{ marginTop: 16, background: "#1e293b", borderRadius: 10, padding: 12 }}>
          <div style={{ fontSize: 12, color: "#22c55e", fontWeight: 700, marginBottom: 8 }}>🎯 Top 5 Paths to +$1,000</div>
          {tournamentDist.winPaths.map((path, i) => (
            <div key={i} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: i < tournamentDist.winPaths.length - 1 ? "1px solid #334155" : "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ color: "#e2e8f0", fontSize: 11, fontWeight: 600 }}>#{i + 1}</span>
                <span style={{ color: "#22c55e", fontSize: 11, fontWeight: 600 }}>avg +{fmt(path.avgProfit)}</span>
                <span style={{ color: "#64748b", fontSize: 10 }}>{(path.pct * 100).toFixed(1)}% of sims</span>
              </div>
              <div style={{ fontSize: 11, lineHeight: 1.6, paddingLeft: 4 }}>
                {path.teams.map((t, j) => (
                  <div key={j} style={{ display: "flex", justifyContent: "space-between" }}>
                    <span><span style={{ color: "#e2e8f0" }}>{t.name}</span> <span style={{ color: "#818cf8" }}>→ {t.round}</span></span>
                    <span style={{ color: "#94a3b8", fontFamily: "'DM Mono', monospace", fontSize: 10 }}>${t.payout}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function seedColor(seed) {
  if (seed <= 2) return "#2563eb";
  if (seed <= 4) return "#7c3aed";
  if (seed <= 8) return "#0891b2";
  if (seed <= 12) return "#65a30d";
  return "#64748b";
}

// ============================================================
// STYLES
// ============================================================

const styles = {
  // Loading & setup
  loadingScreen: { display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#0f172a", color: "#e2e8f0" },
  loadingText: { fontSize: 18, fontFamily: "'DM Mono', monospace" },
  setupScreen: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "#0f172a", padding: 20 },
  setupCard: { background: "#1e293b", borderRadius: 16, padding: 40, maxWidth: 600, width: "100%", textAlign: "center" },
  setupLogo: { fontSize: 64, marginBottom: 8 },
  setupTitle: { fontFamily: "'DM Mono', 'JetBrains Mono', monospace", color: "#f8fafc", fontSize: 28, fontWeight: 800, letterSpacing: 4, margin: "0 0 8px" },
  setupSubtitle: { color: "#94a3b8", fontSize: 14, marginBottom: 24 },
  jsonTextarea: { width: "100%", height: 240, background: "#0f172a", border: "1px solid #334155", borderRadius: 8, color: "#e2e8f0", fontFamily: "'DM Mono', monospace", fontSize: 12, padding: 16, resize: "vertical", boxSizing: "border-box" },
  jsonError: { color: "#ef4444", fontSize: 13, marginTop: 8 },
  loadBtn: { marginTop: 16, padding: "12px 32px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: "pointer" },
  setupHint: { color: "#64748b", fontSize: 12, marginTop: 16, lineHeight: 1.5 },
  setupToggle: { padding: "8px 20px", background: "#1e293b", border: "1px solid #334155", color: "#94a3b8", fontSize: 13, cursor: "pointer", fontWeight: 600, transition: "all 0.15s" },
  setupToggleActive: { background: "#4f46e5", borderColor: "#6366f1", color: "#fff" },
  csvUploadRow: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "#0f172a", borderRadius: 8, marginBottom: 8 },
  csvUploadLabel: { flex: 1, fontSize: 12, color: "#e2e8f0" },
  csvFileLabel: { padding: "6px 16px", background: "#334155", borderRadius: 6, color: "#e2e8f0", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", textAlign: "center", minWidth: 100, border: "1px solid #475569" },
  code: { background: "#334155", padding: "2px 6px", borderRadius: 4, fontFamily: "monospace", fontSize: 11 },

  // Main container
  container: { background: "#0f172a", color: "#e2e8f0", minHeight: "100vh", fontFamily: "'Segoe UI', -apple-system, sans-serif", fontSize: 13 },

  // Top bar
  topBar: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 16px", background: "#1e293b", borderBottom: "1px solid #334155", flexWrap: "wrap", gap: 8 },
  topLeft: { display: "flex", alignItems: "center", gap: 8 },
  topLogo: { fontSize: 22 },
  topTitle: { fontFamily: "'DM Mono', monospace", fontWeight: 800, letterSpacing: 3, fontSize: 16, color: "#f8fafc" },
  topStats: { display: "flex", gap: 4, flexWrap: "wrap" },
  topActions: { display: "flex", gap: 6 },

  statPill: { display: "flex", flexDirection: "column", alignItems: "center", padding: "4px 10px", background: "#0f172a", borderRadius: 6, minWidth: 60 },
  statLabel: { fontSize: 9, textTransform: "uppercase", color: "#64748b", letterSpacing: 1 },
  statValue: { fontSize: 13, fontWeight: 700, fontFamily: "'DM Mono', monospace", color: "#e2e8f0" },

  smallBtn: { padding: "4px 10px", background: "#334155", color: "#e2e8f0", border: "none", borderRadius: 6, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" },
  dangerBtn: { background: "#7f1d1d" },
  badgeGold: { display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: "#422006", color: "#fbbf24", border: "1px solid #854d0e" },
  badgeGreen: { display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: "#052e16", color: "#4ade80", border: "1px solid #166534" },
  badgeWarn: { display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: "#451a03", color: "#fb923c", border: "1px solid #9a3412" },
  badgeDanger: { display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: "#450a0a", color: "#f87171", border: "1px solid #991b1b" },
  badgeGray: { display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: "#1e293b", color: "#94a3b8", border: "1px solid #334155" },
  mineSmallBtn: { background: "#1e40af" },

  // Main layout
  mainLayout: { display: "flex", height: "calc(100vh - 52px)", overflow: "hidden" },

  // Left panel
  leftPanel: { width: 240, minWidth: 200, borderRight: "1px solid #334155", display: "flex", flexDirection: "column", background: "#0f172a" },
  searchBox: { padding: "8px 8px 0" },
  searchInput: { width: "100%", padding: "6px 10px", background: "#1e293b", border: "1px solid #334155", borderRadius: 6, color: "#e2e8f0", fontSize: 12, boxSizing: "border-box" },
  toggleLabel: { padding: "4px 10px", fontSize: 11, color: "#94a3b8", display: "flex", alignItems: "center", cursor: "pointer" },
  teamList: { flex: 1, overflowY: "auto", padding: "4px 0" },
  teamItem: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", cursor: "pointer", borderLeft: "3px solid transparent", transition: "background 0.1s" },
  teamItemSelected: { background: "#1e293b", borderLeftColor: "#2563eb" },
  teamItemSold: { opacity: 0.5 },
  teamItemLeft: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
  teamItemRight: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 },
  seedBadge: { width: 22, height: 22, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#fff", flexShrink: 0 },
  teamName: { fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  mineBadge: { fontSize: 9, background: "#1e40af", color: "#93c5fd", padding: "1px 5px", borderRadius: 3, fontWeight: 700 },
  soldPrice: { fontSize: 11, color: "#64748b", fontFamily: "monospace" },
  evHint: { fontSize: 10, color: "#475569", fontFamily: "monospace" },

  // Center panel
  centerPanel: { flex: 1, overflowY: "auto", padding: 16 },
  emptyState: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", opacity: 0.5 },

  teamHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  teamHeaderLeft: { display: "flex", alignItems: "center", gap: 12 },
  seedBadgeLg: { width: 40, height: 40, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 800, color: "#fff" },
  teamNameLg: { margin: 0, fontSize: 20, fontWeight: 700, color: "#f8fafc" },
  regionTag: { fontSize: 11, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 1 },
  teamHeaderRight: { textAlign: "right" },
  evBig: { fontSize: 28, fontWeight: 800, fontFamily: "'DM Mono', monospace", color: "#22c55e" },
  evLabel: { fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 1 },

  // Bid row
  bidRow: { display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" },
  bidInputWrap: { display: "flex", alignItems: "center", background: "#1e293b", borderRadius: 8, border: "1px solid #334155", padding: "0 12px" },
  bidDollar: { color: "#64748b", fontSize: 18, fontWeight: 700, marginRight: 4 },
  bidInput: { background: "transparent", border: "none", color: "#f8fafc", fontSize: 18, fontWeight: 700, fontFamily: "'DM Mono', monospace", width: 120, padding: "8px 0", outline: "none" },
  actionBtn: { padding: "10px 20px", background: "#334155", color: "#e2e8f0", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  mineBtn: { background: "#1e40af", color: "#93c5fd" },
  soldBanner: { display: "flex", alignItems: "center", gap: 12, background: "#1e293b", padding: "8px 16px", borderRadius: 8, fontSize: 14, fontWeight: 600 },

  // Verdict
  verdictBar: { display: "flex", gap: 20, alignItems: "center", padding: "8px 14px", background: "#1e293b", borderRadius: 8, border: "1px solid", marginBottom: 12, fontSize: 13 },

  // Tabs
  tabRow: { display: "flex", gap: 4, marginBottom: 12, borderBottom: "1px solid #334155", paddingBottom: 0 },
  tab: { padding: "8px 16px", background: "transparent", color: "#94a3b8", border: "none", borderBottom: "2px solid transparent", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  tabActive: { color: "#e2e8f0", borderBottomColor: "#2563eb" },
  tabContent: { minHeight: 200 },

  // Analysis tab
  analysisGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 },
  statCard: { background: "#1e293b", borderRadius: 10, padding: 14 },
  statCardLabel: { fontSize: 10, textTransform: "uppercase", color: "#64748b", letterSpacing: 1, marginBottom: 4 },
  statCardValue: { fontSize: 22, fontWeight: 800, fontFamily: "'DM Mono', monospace", color: "#f8fafc" },
  statCardSub: { fontSize: 11, color: "#94a3b8", marginTop: 2 },
  probBars: { marginTop: 10 },
  probBarRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 },
  probLabel: { width: 80, fontSize: 11, color: "#94a3b8" },
  probBarOuter: { flex: 1, height: 8, background: "#0f172a", borderRadius: 4, overflow: "hidden" },
  probBarInner: { height: "100%", borderRadius: 4, transition: "width 0.3s" },
  probValue: { width: 45, fontSize: 11, textAlign: "right", fontFamily: "monospace", color: "#e2e8f0" },

  // Rounds tab
  roundsTable: { background: "#1e293b", borderRadius: 10, overflow: "hidden" },
  roundsHeader: { display: "flex", padding: "8px 14px", background: "#0f172a", fontSize: 10, textTransform: "uppercase", color: "#64748b", letterSpacing: 1 },
  roundsRow: { display: "flex", padding: "8px 14px", borderBottom: "1px solid #0f172a33", fontSize: 13 },

  // Vegas tab
  vegasCard: { background: "#1e293b", borderRadius: 10, padding: 16 },
  vegasTitle: { margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: "#f8fafc" },
  vegasCompare: { display: "flex", alignItems: "center", gap: 12, justifyContent: "center", flexWrap: "wrap" },
  vegasBox: { background: "#0f172a", borderRadius: 10, padding: 16, textAlign: "center", minWidth: 100 },
  vegasBoxLabel: { fontSize: 10, textTransform: "uppercase", color: "#64748b", letterSpacing: 1 },
  vegasBoxValue: { fontSize: 24, fontWeight: 800, fontFamily: "'DM Mono', monospace", color: "#f8fafc" },
  vegasBoxSub: { fontSize: 10, color: "#64748b" },
  vegasVs: { fontSize: 16, color: "#475569", fontWeight: 700 },
  vegasArrow: { fontSize: 20, color: "#475569" },
  vegasNote: { marginTop: 14, fontSize: 13, textAlign: "center" },
  disagreeTable: { background: "#1e293b", borderRadius: 8, overflow: "hidden" },
  disagreeHeader: { display: "flex", padding: "6px 12px", background: "#0f172a", fontSize: 10, textTransform: "uppercase", color: "#64748b" },
  disagreeRow: { display: "flex", padding: "6px 12px", borderBottom: "1px solid #0f172a33", fontSize: 12 },

  // Cheatsheet
  csTitle: { margin: "0 0 8px", fontSize: 14, fontWeight: 700, color: "#f8fafc" },
  regionBars: { marginBottom: 16 },
  regionBarRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 },
  regionName: { width: 70, fontSize: 12, color: "#e2e8f0" },
  regionBarOuter: { flex: 1, height: 12, background: "#1e293b", borderRadius: 4, overflow: "hidden" },
  regionBarInner: { height: "100%", borderRadius: 4, background: "linear-gradient(90deg, #2563eb, #7c3aed)" },
  regionLabel: { width: 60, fontSize: 10, fontWeight: 700, textAlign: "right" },

  seedTable: { background: "#1e293b", borderRadius: 8, overflow: "hidden", marginBottom: 16 },
  seedTableHeader: { display: "flex", padding: "6px 12px", background: "#0f172a", fontSize: 10, textTransform: "uppercase", color: "#64748b" },
  seedTableRow: { display: "flex", padding: "5px 12px", borderBottom: "1px solid #0f172a33", fontSize: 12 },

  vegasPickRow: { display: "flex", justifyContent: "space-between", padding: "6px 12px", background: "#1e293b", borderRadius: 6, marginBottom: 4, fontSize: 12 },

  // Impact tab
  impactCard: { background: "#1e293b", borderRadius: 10, padding: 14, marginBottom: 12 },
  impactCardTitle: { margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: "#f8fafc" },
  impactHeader: { display: "flex", padding: "4px 0", borderBottom: "1px solid #33415566", marginBottom: 4 },
  impactColHead: { flex: 1, textAlign: "right", fontSize: 10, textTransform: "uppercase", color: "#64748b", letterSpacing: 1 },
  impactRow: { display: "flex", alignItems: "center", padding: "4px 0", fontSize: 12, borderBottom: "1px solid #0f172a22" },
  impactLabel: { flex: 2, color: "#94a3b8", fontSize: 12 },
  verdictBanner: { display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderRadius: 10, border: "1px solid", marginBottom: 12 },

  // Modal
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
  modalCard: { background: "#1e293b", borderRadius: 16, padding: 24, maxWidth: 600, width: "90%", maxHeight: "80vh", overflowY: "auto" },

  // Keyboard hint
  kbd: { display: "inline-block", padding: "1px 5px", borderRadius: 3, background: "#1e293b", border: "1px solid #334155", fontFamily: "monospace", fontSize: 10, color: "#94a3b8" },

  // Right panel
  rightPanel: { width: 260, minWidth: 220, borderLeft: "1px solid #334155", overflowY: "auto", background: "#0f172a" },
  rightSection: { padding: 12, borderBottom: "1px solid #1e293b" },
  sectionTitle: { margin: "0 0 8px", fontSize: 13, fontWeight: 700, color: "#f8fafc" },
  emptyHint: { color: "#475569", fontSize: 12, fontStyle: "italic" },

  // Portfolio
  portfolioSummary: { marginBottom: 8 },
  pStatRow: { display: "flex", justifyContent: "space-between", padding: "2px 0", fontSize: 12 },
  portfolioTeams: {},
  portfolioTeam: { display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderTop: "1px solid #1e293b", cursor: "pointer", fontSize: 12 },
  portfolioName: { color: "#e2e8f0", flex: 1 },

  // Suggestions
  suggestionsList: {},
  suggestionItem: { display: "flex", gap: 8, padding: "6px 0", borderBottom: "1px solid #1e293b", cursor: "pointer" },
  suggRank: { width: 24, height: 24, background: "#1e293b", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, flexShrink: 0, color: "#94a3b8" },
  suggInfo: { flex: 1, minWidth: 0 },
  suggName: { fontSize: 12, fontWeight: 600, color: "#e2e8f0" },
  suggMeta: { fontSize: 10, color: "#64748b" },
  suggTags: { display: "flex", gap: 4, marginTop: 2 },
  suggTag: { fontSize: 9, background: "#1e40af", color: "#93c5fd", padding: "1px 5px", borderRadius: 3, fontWeight: 600 },

  // Sold log
  soldLog: {},
  soldLogItem: { display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #1e293b22", fontSize: 11, cursor: "pointer" },

  mono: { fontFamily: "'DM Mono', 'JetBrains Mono', monospace" },
};
