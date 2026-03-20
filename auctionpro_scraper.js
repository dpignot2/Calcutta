// ============================================================
// CALCUTTA LIVE FEED — AuctionPro API Scraper
// ============================================================
//
// SETUP (two options):
//
// OPTION A — Simple (two tabs, manual):
//   1. Start a local server:  npx serve .  (in your Downloads folder)
//   2. Open http://localhost:8080/calcutta_dashboard.html in Tab 1
//   3. Open your AuctionPro auction in Tab 2
//   4. Paste this script into Tab 2's console
//   5. Dashboard shows green LIVE badge
//
// OPTION B — Auto (scraper opens dashboard):
//   1. Update DASHBOARD_URL below to your localhost URL
//   2. Paste script into AuctionPro console
//   3. Dashboard opens automatically
//
// Commands:
//   calcuttaStatus()  — show all sales
//   calcuttaStop()    — stop polling
//   calcuttaSale('Houston', 1200, true)  — manual entry
//
// ============================================================

(function() {
  "use strict";

  if (window._calcuttaPollId) clearInterval(window._calcuttaPollId);
  if (window._calcuttaPingId) clearInterval(window._calcuttaPingId);
  if (window._calcuttaBidPollId) clearInterval(window._calcuttaBidPollId);

  // ── CONFIG ──
  var POLL_INTERVAL = 3000;
  var PING_INTERVAL = 5000;

  // Set this to your local dashboard URL (or leave empty to skip auto-open)
  var DASHBOARD_URL = "http://localhost:8080/calcutta_dashboard.html";

  // ── Auto-detect auth ──
  var tokenMatch = document.cookie.match(/token=([^;]+)/);
  var secretMatch = document.cookie.match(/secret=([^;]+)/);
  if (!tokenMatch) {
    console.error("%c❌ No auth token. Are you logged into AuctionPro?", "color: #ef4444; font-size: 14px");
    return;
  }
  var AUTH_TOKEN = tokenMatch[1];
  var MY_USER_ID = secretMatch ? parseInt(secretMatch[1]) : null;

  // ── Auto-detect auction ID ──
  var AUCTION_ID = null;
  try {
    var scope = angular.element(document.querySelector("[ng-controller]")).scope();
    if (scope && scope.auction) AUCTION_ID = scope.auction.id;
  } catch(e) {}
  if (!AUCTION_ID) {
    var entries = performance.getEntriesByType("resource");
    for (var i = 0; i < entries.length; i++) {
      var m = entries[i].name.match(/\/api\/auctions\/(\d+)\//);
      if (m) { AUCTION_ID = parseInt(m[1]); break; }
    }
  }
  if (!AUCTION_ID) {
    var input = prompt("Enter AuctionPro auction ID (numeric).\nFind it in Network tab: /api/auctions/XXXXX/items.json");
    if (input) AUCTION_ID = parseInt(input);
  }
  if (!AUCTION_ID) { console.error("%c❌ No auction ID.", "color: #ef4444"); return; }

  var ITEMS_URL = "/api/auctions/" + AUCTION_ID + "/items.json";
  var CURRENT_URL = "/api/auctions/" + AUCTION_ID + "/current_item.json";

  // ── Dashboard connection ──
  // Two modes:
  //   1. BroadcastChannel: works when both on localhost (testing)
  //   2. postMessage via window.open: works cross-origin (auction night)
  // Dashboard saves state to localStorage, so reopening it preserves loaded CSVs.

  // Try BroadcastChannel first (same-origin only)
  try { window._calcuttaBC = new BroadcastChannel("calcutta-live"); } catch(e) {}

  // Open/reuse dashboard window for postMessage (cross-origin)
  if (DASHBOARD_URL) {
    try {
      // window.open with same name reuses existing window but navigates to URL.
      // Dashboard will auto-restore from localStorage on reload.
      if (!window._calcuttaDashboard || window._calcuttaDashboard.closed) {
        window._calcuttaDashboard = window.open(DASHBOARD_URL, "calcutta-dashboard");
        console.log("%c📺 Dashboard opened at " + DASHBOARD_URL, "color: #22c55e");
      } else {
        console.log("%c📺 Dashboard already open", "color: #22c55e");
      }
    } catch(e) {}
  }

  function send(msg) {
    msg._calcutta = true;
    // Strip leading seed number from team names (AuctionPro sends "1 Duke", "16 Siena", etc.)
    if (msg.team) msg.team = msg.team.replace(/^\d+\s+/, "").trim();
    if (msg.teams) msg.teams = msg.teams.map(function(t) {
      return Object.assign({}, t, { name: (t.name || "").replace(/^\d+\s+/, "").trim() });
    });

    // Method 1: BroadcastChannel (same-origin, e.g. both on localhost)
    if (window._calcuttaBC) {
      try { window._calcuttaBC.postMessage(msg); } catch(e) {}
    }

    // Method 2: postMessage to window reference (cross-origin)
    if (window._calcuttaDashboard && !window._calcuttaDashboard.closed) {
      try { window._calcuttaDashboard.postMessage(msg, "*"); } catch(e) {}
    }
  }

  // Listen for dashboard announcing itself
  window.addEventListener("message", function(event) {
    if (event.data && event.data.type === "calcutta-dashboard-ready") {
      window._calcuttaDashboard = event.source;
      console.log("%c📺 Dashboard connected!", "color: #22c55e; font-weight: bold");
    }
  });

  // ── State ──
  var knownSales = {};
  var pollCount = 0;
  var lastLiveItem = null;
  var lastBidAmount = 0;
  var lastBidId = null;

  function authHeaders() {
    var t = document.cookie.match(/token=([^;]+)/);
    return { "Accept": "application/json", "Authorization": t ? t[1] : AUTH_TOKEN };
  }

  // ── Startup ──
  console.log("%c🏀 Calcutta Live Feed — AuctionPro API", "color: #22c55e; font-size: 16px; font-weight: bold");
  console.log("%c   Auction ID: " + AUCTION_ID, "color: #94a3b8");
  console.log("%c   User ID:    " + MY_USER_ID, "color: #94a3b8");
  console.log("%c   API:        " + ITEMS_URL, "color: #94a3b8");
  console.log("");

  // ── Heartbeat ──
  window._calcuttaPingId = setInterval(function() { send({ type: "ping" }); }, PING_INTERVAL);

  // ── Poll ──
  async function poll() {
    try {
      var resp = await fetch(ITEMS_URL, { credentials: "same-origin", headers: authHeaders() });
      if (!resp.ok) {
        if (pollCount % 10 === 0) console.warn("⚠️ API returned " + resp.status);
        return;
      }
      var items = await resp.json();
      pollCount++;

      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item.price != null && item.winner != null) {
          var price = parseFloat(item.price);
          if (price <= 0) continue;
          if (knownSales[item.name] === price) continue;

          knownSales[item.name] = price;
          var isMine = MY_USER_ID && item.winner_id === MY_USER_ID;
          send({ type: "sale", team: item.name, price: price, buyer: item.winner, isMine: isMine });
          console.log(
            "%c🔔 SOLD: " + item.name + " → $" + price + " [" + item.winner + "]" + (isMine ? " ★YOU" : ""),
            "color: " + (isMine ? "#22c55e" : "#eab308") + "; font-weight: bold"
          );
        }
      }

      if (pollCount % 20 === 0) {
        var sc = 0, pot = 0;
        for (var k in knownSales) { sc++; pot += knownSales[k]; }
        console.log("%c📊 " + sc + "/" + items.length + " sold | Pot: $" + pot.toFixed(0), "color: #64748b");
      }

      // Compute per-bidder spending totals and send to dashboard
      var bidderTotals = {};
      var bidderTeams = {};
      for (var b = 0; b < items.length; b++) {
        var bi = items[b];
        if (bi.price != null && bi.winner != null && bi.winner_id != null) {
          var bp = parseFloat(bi.price);
          if (bp <= 0) continue;
          var bid = bi.winner_id;
          if (!bidderTotals[bid]) {
            bidderTotals[bid] = { name: bi.winner, spent: 0, teams: 0, teamList: [] };
          }
          bidderTotals[bid].spent += bp;
          bidderTotals[bid].teams += 1;
          bidderTotals[bid].teamList.push({ name: bi.name, price: bp });
        }
      }
      send({ type: "bidder_totals", bidders: bidderTotals, myId: MY_USER_ID });

      // Send upcoming auction queue (unsold items in order)
      var upcoming = items
        .filter(function(x) { return x.price == null || x.winner == null; })
        .sort(function(a, b) { return (a.order || 999) - (b.order || 999); })
        .slice(0, 10)
        .map(function(x) { return { name: x.name, order: x.order, rank: x.rank }; });
      if (upcoming.length > 0) {
        send({ type: "upcoming", teams: upcoming });
      }
    } catch (e) {
      console.error("Poll error:", e);
    }
  }

  // ── Initial sync ──
  async function initialSync() {
    await new Promise(function(r) { setTimeout(r, 2500); });
    console.log("%c🔄 Syncing...", "color: #a5b4fc");
    try {
      var resp = await fetch(ITEMS_URL, { credentials: "same-origin", headers: authHeaders() });
      var items = await resp.json();
      var existing = 0, pot = 0;
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item.price != null && item.winner != null) {
          var price = parseFloat(item.price);
          if (price <= 0) continue;
          knownSales[item.name] = price;
          existing++;
          pot += price;
          send({ type: "sale", team: item.name, price: price, buyer: item.winner, isMine: MY_USER_ID && item.winner_id === MY_USER_ID });
        }
      }
      send({ type: "ping" });
      console.log("%c✅ Synced " + existing + " sales ($" + pot.toFixed(0) + ")", "color: #22c55e; font-weight: bold");
      console.log("");
    } catch (e) { console.error("Sync failed:", e); }
  }

  // ── Poll current item for live bid updates (faster — every 2s) ──
  async function pollCurrentItem() {
    try {
      var resp = await fetch(CURRENT_URL, { credentials: "same-origin", headers: authHeaders() });
      if (!resp.ok) return;
      var item = await resp.json();
      if (!item || !item.name) return;

      // Track current live item
      if (item.name !== lastLiveItem) {
        lastLiveItem = item.name;
        lastBidAmount = 0;
        lastBidId = null;
        send({ type: "live_item", team: item.name, rank: item.rank, order: item.order });
        console.log("%c⏳ NOW LIVE: " + item.name, "color: #a5b4fc; font-weight: bold");
      }

      // Track current bid — send update when bid changes
      var currentBid = item.current_bid;
      var bidAmount = 0;
      var bidder = "";
      if (currentBid && currentBid.amount) {
        bidAmount = parseFloat(currentBid.amount);
        bidder = currentBid.bidder || "";
      } else if (item.bids && item.bids.length > 0) {
        // Fallback: last bid in bids array
        var lastBid = item.bids[item.bids.length - 1];
        bidAmount = parseFloat(lastBid.amount);
        bidder = lastBid.bidder || "";
      }

      if (bidAmount > 0 && (bidAmount !== lastBidAmount)) {
        lastBidAmount = bidAmount;
        var isMine = MY_USER_ID && currentBid && currentBid.user_id === MY_USER_ID;
        send({ type: "live_bid", team: item.name, amount: bidAmount, bidder: bidder, isMine: isMine, timeRemaining: item.time_remaining });
      }
    } catch(e) {}
  }

  initialSync().then(function() {
    window._calcuttaPollId = setInterval(poll, POLL_INTERVAL);
    window._calcuttaBidPollId = setInterval(pollCurrentItem, 2000);
  });

  // ── Manual helpers ──
  window.calcuttaSale = function(team, price, isMine) {
    send({ type: "sale", team: team, price: price, isMine: !!isMine });
    console.log("%c📤 " + team + " → $" + price, "color: #22c55e");
  };
  window.calcuttaStop = function() {
    clearInterval(window._calcuttaPollId);
    clearInterval(window._calcuttaPingId);
    clearInterval(window._calcuttaBidPollId);
    console.log("%c⏹ Stopped.", "color: #ef4444");
  };
  window.calcuttaStatus = async function() {
    var resp = await fetch(ITEMS_URL, { credentials: "same-origin", headers: authHeaders() });
    var items = await resp.json();
    var sold = items.filter(function(x) { return x.price != null; });
    var pot = sold.reduce(function(s, x) { return s + parseFloat(x.price); }, 0);
    console.log("%c📊 " + sold.length + "/" + items.length + " sold | $" + pot.toFixed(0), "color: #22c55e; font-weight: bold");
    console.table(sold.map(function(x) { return { name: x.name, price: "$" + parseFloat(x.price).toFixed(0), buyer: x.winner }; }));
  };

  console.log("%c  calcuttaStatus() · calcuttaStop() · calcuttaSale(name, price, isMine)", "color: #64748b");

})();
