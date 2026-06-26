/* =========================================================================
   RIDE SEQUENCE PLANNER — shared app logic
   Self-contained: graph + Dijkstra, wait interpolation, sequence sim,
   canvas render, animation, drag-reorder, export.

   Park-specific data lives in the per-park park.js (the global SAMPLE
   object, including SAMPLE.meta), loaded before this file.
   ========================================================================= */

const WALK_FT_PER_MIN = 114; // brisk theme-park pace (~30% quicker than the old 88)

// URL-safe slug from the park name (used for export filenames).
function parkSlug() {
  return (SAMPLE.meta.name || "park").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
// Apply park identity (browser tab + header) from SAMPLE.meta.
function applyParkMeta() {
  const m = SAMPLE.meta || {};
  document.title = (m.name || "Ride") + " Ride Sequence Planner";
  const h1 = document.getElementById("parkTitle");
  if (h1) h1.innerHTML =
    '<a class="crumb" href="../../" title="Choose a different park">Parks</a>' +
    '<span class="sep">›</span>' +
    (m.emoji ? m.emoji + " " : "") + (m.name || "") +
    ' <span>Ride Sequence Planner</span>';
}

// Attraction categories. A "restaurant" is an attraction with no wait time
// but a duration (like a ride) — it just gets its own color/category.
// Categories: ride (queue + entrance/exit), restaurant/shop/pin (no queue,
// hook to a single node). Anything unrecognized is treated as a ride.
const CATEGORIES = ["ride", "restaurant", "shop", "pin", "restroom", "other"];
function attrCat(a) {
  const c = a && a.category;
  return CATEGORIES.indexOf(c) >= 0 ? c : "ride";
}
// Dwell minutes for a non-ride stop. "other" and "pin" default to 5 when unset;
// the user can override it (including to 0). Other categories default to 0.
function attrDuration(a) {
  if (a && typeof a.rideDuration === "number") return a.rideDuration;
  const c = attrCat(a);
  return (c === "other" || c === "pin") ? 5 : 0;
}
// Closed = not open at the park today; shown as a flat gray circle.
function attrClosed(a) { return !!(a && a.closed); }
const CLOSED_COLOR = "#6b7687";
const LL_COLOR = "#ffd23b";   // gold — Lightning Lane countdown fill + bolt badge
const TRANSIT_COLOR = "#46c6b8";   // teal — transit (rail/ferry) legs on the map + timeline
// Marker colors per category: { off: not in sequence, on: in sequence }.
const ATTR_COLORS = {
  ride:       { off: "#ffcc4d", on: "#5cc8ff" },
  restaurant: { off: "#57d9a3", on: "#2bb487" },
  shop:       { off: "#c08cff", on: "#9b6bff" },
  pin:        { off: "#ff8aa8", on: "#ff5d86" },
  restroom:   { off: "#6cb8e6", on: "#3a93d6" },
  other:      { off: "#9aa7bd", on: "#6d7d99" }
};
// Per-category labels/markers used by the timeline, itinerary and animation.
const CAT_META = {
  ride:       { verb: "Ride ",    short: "Ride", phase: "RIDE", cls: "ride", anim: "🎢 Riding ",      barVar: "var(--ride)", color: "#9d7bff", wait: true },
  restaurant: { verb: "Eat at ",  short: "Eat",  phase: "DINE", cls: "dine", anim: "🍽 Eating at ",   barVar: "var(--rest)", color: "#57d9a3", wait: false },
  shop:       { verb: "Shop at ", short: "Shop", phase: "SHOP", cls: "shop", anim: "🛍 Shopping at ", barVar: "var(--shop)", color: "#c08cff", wait: false },
  pin:        { verb: "Visit ",   short: "Stop", phase: "STOP", cls: "pin",  anim: "📍 Visiting ",    barVar: "var(--pin)",  color: "#ff8aa8", wait: false },
  restroom:   { verb: "Break at ", short: "Break", phase: "BREAK", cls: "restroom", anim: "🚻 Break at ", barVar: "var(--restroom)", color: "#6cb8e6", wait: false, icon: "🚻", iconNode: true },
  other:      { verb: "Stop at ",  short: "Stop", phase: "STOP", cls: "other", anim: "⏱ At ", barVar: "var(--other)", color: "#9aa7bd", wait: false },
  transit:    { verb: "Take ",     short: "Transit", phase: "TRANSIT", cls: "transit", anim: "🚂 ", barVar: "var(--transit)", color: "#46c6b8", wait: false }
};
// A sequence entry "@transit:<lineId>" (optionally ">@<alightStopId>") schedules
// an explicit transit ride. Board = nearest stop; alight = chosen, else auto.
const TRANSIT_TOKEN = "@transit:";
function isTransitToken(s) { return typeof s === "string" && s.indexOf(TRANSIT_TOKEN) === 0; }
function parseTransitToken(s) {
  const rest = s.slice(TRANSIT_TOKEN.length);
  const gt = rest.indexOf(">");
  return gt >= 0 ? { lineId: rest.slice(0, gt), alight: rest.slice(gt + 1) } : { lineId: rest, alight: null };
}
function transitTokenFor(lineId, alight) { return TRANSIT_TOKEN + lineId + (alight ? ">" + alight : ""); }
function catMeta(c) { return CAT_META[c] || CAT_META.ride; }
// Which categories are shown in the picker / on the map (toggled by the chips).
const catFilter = { ride: true, restaurant: true, shop: true, pin: true, restroom: true, other: true, transit: true };



/* ---------- State ------------------------------------------------------- */
const state = {
  nodes: new Map(),        // id -> node
  adj: new Map(),          // id -> [{to, dist(px)}]
  attractions: new Map(),  // id -> attraction
  waits: new Map(),        // attractionId -> [{t(min), w}]
  sequence: [],            // [attractionId, ...]
  steps: [],               // computed sim steps
  hoverPath: null,         // node-id path to preview
  mapExtent: null          // { x, y, w, h } background rect in node coords
};

/* ---------- Time helpers ------------------------------------------------ */
function hmToMin(hm) { const p = hm.split(":"); return (+p[0]) * 60 + (+p[1]); }
function minToHM(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60) % 24, m = ((min % 60) + 60) % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}
function fmtDur(min) {
  min = Math.round(min);
  if (min < 60) return min + "m";
  return Math.floor(min / 60) + "h " + (min % 60) + "m";
}
// Walk distance from a step's pixel length, in real-world units.
function stepFeet(distPx) { return distPx * ftPerPx(); }
// Per-step distance: feet (with thousands separators).
function fmtFeet(ft) { return Math.round(ft).toLocaleString() + " ft"; }
// Totals: switch to miles once it's far enough to be more readable.
function fmtDist(ft) {
  return ft >= 5280 ? (ft / 5280).toFixed(2) + " mi" : fmtFeet(ft);
}

/* ---------- Parsing & graph build -------------------------------------- */
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function polylineLength(pts) {
  let L = 0;
  for (let i = 0; i < pts.length - 1; i++) L += dist(pts[i], pts[i + 1]);
  return L;
}
function nodePt(id) { const n = state.nodes.get(id); return n ? { x: n.x, y: n.y } : { x: 0, y: 0 }; }
// Dense polyline for a node-id path, following each edge's stored geometry
// (falls back to straight segments where an edge has no points).
function buildRoute(ids) {
  if (!ids || !ids.length) return [];
  if (ids.length === 1) return [nodePt(ids[0])];
  const out = [];
  for (let i = 0; i < ids.length - 1; i++) {
    const a = ids[i], b = ids[i + 1];
    const edge = (state.adj.get(a) || []).find(e => e.to === b);
    let seg = (edge && edge.points && edge.points.length >= 2)
      ? edge.points.map(p => ({ x: p.x, y: p.y }))
      : [nodePt(a), nodePt(b)];
    if (i > 0) seg = seg.slice(1); // drop shared junction vertex
    for (const p of seg) out.push(p);
  }
  return out;
}

function buildFromData(nodes, connections, attractions, waitsTSV, transport) {
  state.nodes = new Map();
  nodes.forEach(n => state.nodes.set(n.id, n));

  // adjacency (undirected, dedup)
  state.adj = new Map();
  nodes.forEach(n => state.adj.set(n.id, []));
  const seen = new Set();
  // points (optional) is an ordered [{x,y}...] polyline from a -> b. When
  // present, edge length is the polyline length; otherwise straight Euclidean.
  function addEdge(a, b, points) {
    if (a === b) return;
    const na = state.nodes.get(a), nb = state.nodes.get(b);
    if (!na || !nb) return;
    const key = a < b ? a + "|" + b : b + "|" + a;
    if (seen.has(key)) return;
    seen.add(key);
    const pts = (points && points.length >= 2) ? points.map(p => ({ x: +p.x, y: +p.y })) : null;
    const d = pts ? polylineLength(pts) : dist(na, nb);
    state.adj.get(a).push({ to: b, dist: d, points: pts, kind: "walk" });
    state.adj.get(b).push({ to: a, dist: d, points: pts ? pts.slice().reverse() : null, kind: "walk" });
  }
  connections.forEach(c => {
    const tos = Array.isArray(c.to) ? c.to : (c.to != null ? [c.to] : []);
    // geometry only attaches to a single-target edge
    const pts = (Array.isArray(c.points) && tos.length === 1) ? c.points : null;
    tos.forEach(t => addEdge(c.from, t, pts));
  });

  // transport lines (railroad, ferries): inject directed "transit" edges between
  // every pair of stops on a line. A single ride = one edge, so its boarding
  // wait is charged exactly once (no double-count on multi-stop trips).
  state.transport = Array.isArray(transport) ? transport : [];
  buildTransitEdges(state.transport);

  state.attractions = new Map();
  attractions.forEach(a => state.attractions.set(a.id, a));

  // wait times
  state.waits = new Map();
  waitsTSV.split(/\r?\n/).forEach(line => {
    line = line.trim();
    if (!line) return;
    const parts = line.split(/\t+|\s{2,}|,/).map(s => s.trim());
    if (parts.length < 3) return;
    const id = parts[0], tod = parts[1], w = parts[2];
    if (id === "attraction_id" || isNaN(parseFloat(w))) return;
    if (!state.waits.has(id)) state.waits.set(id, []);
    state.waits.get(id).push({ t: hmToMin(tod), w: parseFloat(w) });
  });
  state.waits.forEach(arr => arr.sort((a, b) => a.t - b.t));

  populateStartSelect();   // refresh the "From" location options for the new data
}

/* ---------- Transport lines (railroad / ferries) ------------------------ */
// Minutes -> equivalent walk pixels, so Dijkstra (which sums pixels) is really
// minimizing time: walkTimeMin(timeEquivPx(m)) === m.
function timeEquivPx(min) { return (min * WALK_FT_PER_MIN) / ftPerPx(); }

// Friendly name for a stop node (its name, else a humanized id).
function stopName(id) {
  const n = state.nodes.get(id);
  if (n && n.name) return n.name;
  return String(id || "").replace(/_(in|out)$/, "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// Normalize a line's stops to [{node, thpwId?, avgWait?}], keeping only real nodes.
function lineStops(line) {
  return (line.stops || [])
    .map(s => (typeof s === "string" ? { node: s } : s))
    .filter(s => s && state.nodes.has(s.node));
}
// Join two polylines, dropping the duplicated shared vertex.
function concatPath(a, b) {
  if (!a || !a.length) return (b || []).slice();
  if (!b || !b.length) return a.slice();
  return a.concat(b.slice(1));
}
// Orient a polyline so it runs from the `fromNode` stop to the `toNode` stop,
// regardless of the order its points were authored in.
function orientPath(path, fromNode, toNode) {
  if (!Array.isArray(path) || path.length < 2) return path;
  const f = nodePt(fromNode), t = nodePt(toNode);
  const d2 = (a, b) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
  const head = path[0], tail = path[path.length - 1];
  // reverse when the head sits nearer the destination than the source
  if (d2(head, t) + d2(tail, f) < d2(head, f) + d2(tail, t)) return path.slice().reverse();
  return path;
}

// Build transit edges from a line's DIRECTED segments. Each drawn segment is
// {from, to, minutes, path}; the engine chains segments in their direction so a
// guest can board at any stop and ride to any forward-reachable stop. This
// handles two-way (a segment each way), one-way loops (a cycle of segments),
// and asymmetric paths (out one way, back another) uniformly. Boarding wait
// comes from the BOARD stop's wait source (its glued station attraction).
// dist/boardMin are filled in later by updateTransitWeights.
function buildTransitEdges(lines) {
  (lines || []).forEach(line => {
    const stops = lineStops(line);
    if (stops.length < 2) { if ((line.stops || []).length) console.warn("Transport '" + (line.id || line.name) + "': fewer than 2 stops on the graph, skipped."); return; }
    const wait = {};
    stops.forEach(s => { wait[s.node] = { thpwId: s.thpwId, avgWait: s.avgWait }; });
    // directed adjacency among stops, from the drawn segments
    const segAdj = new Map();
    (line.segments || []).forEach(seg => {
      if (!seg || !state.nodes.has(seg.from) || !state.nodes.has(seg.to)) return;
      const raw = (Array.isArray(seg.path) && seg.path.length >= 2)
        ? seg.path.map(p => ({ x: +p.x, y: +p.y })) : [nodePt(seg.from), nodePt(seg.to)];
      // orient the path to its own from->to so order never matters (a copied/
      // reversed segment whose geometry wasn't flipped still draws correctly)
      const path = orientPath(raw, seg.from, seg.to);
      if (!segAdj.has(seg.from)) segAdj.set(seg.from, []);
      segAdj.get(seg.from).push({ to: seg.to, minutes: +seg.minutes || 0, path: path });
    });
    // from each origin, BFS forward to every reachable stop, accumulating
    // minutes + concatenated geometry; add one transit edge per (origin, dest)
    stops.forEach(origin => {
      const start = origin.node;
      const seen = new Set([start]);
      const queue = [{ node: start, min: 0, path: null }];
      while (queue.length) {
        const cur = queue.shift();
        for (const e of (segAdj.get(cur.node) || [])) {
          if (seen.has(e.to)) continue;
          seen.add(e.to);
          const min = cur.min + e.minutes;
          const path = concatPath(cur.path, e.path);
          state.adj.get(start).push({
            to: e.to, kind: "transit", line: line.id, lineName: line.name || line.id,
            fromStop: start, toStop: e.to, rideMin: min, points: (path && path.length >= 2) ? path : null,
            thpwId: wait[start] && wait[start].thpwId, avgWait: wait[start] && wait[start].avgWait,
            boardMin: 0, dist: timeEquivPx(min)
          });
          queue.push({ node: e.to, min: min, path: path });
        }
      }
    });
  });
}

// Boarding wait (min) for a transit edge at a given time: live standby if we
// have it and the arrival is near now, else the line's configured avgWait.
function transitWaitFor(edge, atMin) {
  if (showLiveWaits && edge.thpwId) {
    const e = liveWaits.byId.get(String(edge.thpwId));
    if (e && e.open && typeof e.wait === "number") {
      const now = parkNowMin();
      if (now === null || Math.abs(atMin - now) <= LIVE_WAIT_WINDOW) return e.wait;
    }
  }
  return (typeof edge.avgWait === "number" && edge.avgWait >= 0) ? edge.avgWait : 0;
}

// Recompute transit edge weights for routing at a given time of day.
function updateTransitWeights(atMin) {
  state.adj.forEach(edges => {
    for (const e of edges) {
      if (e.kind !== "transit") continue;
      e.boardMin = transitWaitFor(e, atMin);
      e.dist = timeEquivPx(e.boardMin + e.rideMin);
    }
  });
}

// Split a route into walked pixels vs transit (ride + board) minutes, build the
// drawn polyline, and list the transit legs for the timeline.
function decomposeRoute(route) {
  const path = route.path || [], edges = route.edges || [];
  let walkPx = 0, transitRide = 0, transitBoard = 0, lenAcc = 0;
  const transitLegs = [], coords = [], spanPx = [], travelLegs = [];   // travelLegs: walk/transit sub-legs in route order
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i], fromId = path[i];
    let seg = (e.points && e.points.length >= 2) ? e.points.map(p => ({ x: p.x, y: p.y })) : [nodePt(fromId), nodePt(e.to)];
    const segLen = polylineLength(seg);
    if (e.kind === "transit") {
      transitRide += e.rideMin; transitBoard += (e.boardMin || 0);
      transitLegs.push({ line: e.line, lineName: e.lineName, fromStop: e.fromStop, toStop: e.toStop, rideMin: e.rideMin, boardMin: e.boardMin || 0 });
      spanPx.push({ a: lenAcc, b: lenAcc + segLen, lineName: e.lineName, toStop: e.toStop });
      travelLegs.push({ kind: "transit", lineName: e.lineName, toStop: e.toStop, rideMin: e.rideMin, boardMin: e.boardMin || 0 });
    } else {
      walkPx += segLen;
      const last = travelLegs[travelLegs.length - 1];
      if (last && last.kind === "walk") last.px += segLen;   // merge consecutive walk edges
      else travelLegs.push({ kind: "walk", px: segLen });
    }
    lenAcc += segLen;
    if (i > 0) seg = seg.slice(1);
    for (const p of seg) coords.push(p);
  }
  if (!coords.length && path.length) coords.push(nodePt(path[0]));
  // convert transit spans to fractions of the full drawn polyline (for the animation)
  const total = lenAcc || 1;
  const transitSpans = spanPx.map(s => ({ a: s.a / total, b: s.b / total, lineName: s.lineName, toStop: s.toStop }));
  return { walkPx: walkPx, transitRide: transitRide, transitBoard: transitBoard, coords: coords, transitLegs: transitLegs, transitSpans: transitSpans, travelLegs: travelLegs };
}

/* ---------- Dijkstra ---------------------------------------------------- */
function dijkstra(start, goal) {
  if (start === goal) return { path: [start], dist: 0, edges: [] };
  if (!state.nodes.has(start) || !state.nodes.has(goal)) return null;
  const distTo = new Map(), prev = new Map(), visited = new Set();
  state.nodes.forEach((_, id) => distTo.set(id, Infinity));
  distTo.set(start, 0);
  const pq = [{ id: start, d: 0 }];
  while (pq.length) {
    let bi = 0;
    for (let i = 1; i < pq.length; i++) if (pq[i].d < pq[bi].d) bi = i;
    const cur = pq.splice(bi, 1)[0].id;
    if (visited.has(cur)) continue;
    visited.add(cur);
    if (cur === goal) break;
    for (const e of (state.adj.get(cur) || [])) {
      if (visited.has(e.to)) continue;
      const nd = distTo.get(cur) + e.dist;
      if (nd < distTo.get(e.to)) {
        distTo.set(e.to, nd);
        prev.set(e.to, { from: cur, edge: e });   // remember which edge we took (walk vs transit)
        pq.push({ id: e.to, d: nd });
      }
    }
  }
  if (distTo.get(goal) === Infinity) return null;
  const path = [], edges = [];
  let cur = goal;
  while (cur !== start) {
    const p = prev.get(cur);
    if (!p) break;
    path.unshift(cur); edges.unshift(p.edge);
    cur = p.from;
  }
  path.unshift(start);
  return { path, dist: distTo.get(goal), edges };
}

/* ---------- Walk time & wait interpolation ------------------------------ */
function ftPerPx() { return parseFloat(document.getElementById("ftPerPx").value) || 4; }
function walkTimeMin(distPx) { return (distPx * ftPerPx()) / WALK_FT_PER_MIN; }

function interpWait(attractionId, timeMin) {
  const arr = state.waits.get(attractionId);
  if (!arr || !arr.length) return 0;
  if (timeMin <= arr[0].t) return arr[0].w;
  if (timeMin >= arr[arr.length - 1].t) return arr[arr.length - 1].w;
  for (let i = 0; i < arr.length - 1; i++) {
    const a = arr[i], b = arr[i + 1];
    if (timeMin >= a.t && timeMin <= b.t) {
      const f = (timeMin - a.t) / (b.t - a.t);
      return a.w + f * (b.w - a.w);
    }
  }
  return arr[arr.length - 1].w;
}

// Current minute-of-day in the park's timezone (robust to the viewer's own
// timezone). Null if Intl can't resolve it.
function parkNowMin() {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
      hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date());
    let h = 0, m = 0;
    parts.forEach(p => { if (p.type === "hour") h = +p.value; if (p.type === "minute") m = +p.value; });
    return (h % 24) * 60 + m;
  } catch (e) { return null; }
}
const LIVE_WAIT_WINDOW = 45;   // live standby only trusted for arrivals within this many min of now

// Wait (minutes) used when computing sequence times. Priority:
//   1. user override (waitOverride text field)
//   2. live standby wait — but only for arrivals near the present; the live
//      number is "right now", so a later arrival falls through to the forecast
//   3. time-of-day forecast / matrix (themeparks.wiki hourly forecast, or TSV)
//   4. the ride's configured average (avgWait from Visio shape data)
// Only rides queue; everything else is 0.
function waitFor(a, arrivalMin) {
  if (!a || attrCat(a) !== "ride") return 0;
  if (typeof a.waitOverride === "number" && a.waitOverride >= 0) return a.waitOverride;  // user override wins
  if (showLiveWaits) {
    const live = liveWaitFor(a);
    if (live && live.open && typeof live.wait === "number") {
      // The live standby wait describes the queue at this instant. Only use it
      // when arrival is near the current park time; otherwise prefer the
      // hour-by-hour forecast (when we have one) so a 7pm arrival uses the 7pm
      // forecast rather than the wait happening right now.
      const now = parkNowMin();
      const hasFc = state.waits.has(a.id);
      if (!hasFc || now === null || Math.abs(arrivalMin - now) <= LIVE_WAIT_WINDOW) return live.wait;
    }
  }
  // time-of-day forecast / matrix beats a single static average when present
  if (state.waits.has(a.id)) return interpWait(a.id, arrivalMin);
  if (typeof a.avgWait === "number" && a.avgWait >= 0) return a.avgWait;
  return interpWait(a.id, arrivalMin);
}

// Nearest of several candidate nodes from `from`, by shortest path. Returns
// { id, route } or null if none reachable.
function nearestAccess(from, ids) {
  let best = null;
  for (const id of ids) {
    const r = dijkstra(from, id);
    if (r && (best === null || r.dist < best.route.dist)) best = { id, route: r };
  }
  return best;
}

/* ---------- Sequence simulation ----------------------------------------- */
/* ---------- Geolocation: GPS -> map pixels via anchor calibration ------- */
// SAMPLE.geoAnchors = [{x, y, lat, lon}, ...] (>=3 shapes carrying Prop.LatLon).
// We fit an affine map (lon,lat)->(x,y) — handles the map's rotation/scale/skew.
let geoXform = null;          // function(lon, lat) -> {x, y}, or null if uncalibrated
let geoActive = false, geoWatchId = null, myLocation = null, geoStartNode = null;

function solve3(M, b) {       // Gaussian elimination on a 3x3 system
  const a = [[M[0][0], M[0][1], M[0][2], b[0]], [M[1][0], M[1][1], M[1][2], b[1]], [M[2][0], M[2][1], M[2][2], b[2]]];
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(a[r][i]) > Math.abs(a[p][i])) p = r;
    if (Math.abs(a[p][i]) < 1e-12) return null;
    const tmp = a[i]; a[i] = a[p]; a[p] = tmp;
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = a[r][i] / a[i][i];
      for (let c = i; c < 4; c++) a[r][c] -= f * a[i][c];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}
// Least-squares affine fit from anchors. Centered on the mean lon/lat for
// numerical conditioning (lon/lat magnitudes dwarf the constant term otherwise).
function computeGeoTransform(anchors) {
  const pts = (anchors || []).filter(a => a && [a.x, a.y, a.lat, a.lon].every(v => typeof v === "number" && isFinite(v)));
  if (pts.length < 3) return null;
  const lon0 = pts.reduce((s, a) => s + a.lon, 0) / pts.length;
  const lat0 = pts.reduce((s, a) => s + a.lat, 0) / pts.length;
  let Suu = 0, Svv = 0, Suv = 0, Su = 0, Sv = 0, Sux = 0, Svx = 0, Sx = 0, Suy = 0, Svy = 0, Sy = 0;
  pts.forEach(a => {
    const u = a.lon - lon0, v = a.lat - lat0;
    Suu += u * u; Svv += v * v; Suv += u * v; Su += u; Sv += v;
    Sux += u * a.x; Svx += v * a.x; Sx += a.x; Suy += u * a.y; Svy += v * a.y; Sy += a.y;
  });
  const M = [[Suu, Suv, Su], [Suv, Svv, Sv], [Su, Sv, pts.length]];
  const cx = solve3(M, [Sux, Svx, Sx]), cy = solve3(M, [Suy, Svy, Sy]);
  if (!cx || !cy) return null;
  const f = (lon, lat) => ({ x: cx[0] * (lon - lon0) + cx[1] * (lat - lat0) + cx[2],
                             y: cy[0] * (lon - lon0) + cy[1] * (lat - lat0) + cy[2] });
  f.count = pts.length;
  return f;
}
// Closest node of any kind to a map-pixel point.
function nearestNodeTo(pt) {
  let best = null, bd = Infinity;
  state.nodes.forEach((n, id) => { const d = (n.x - pt.x) * (n.x - pt.x) + (n.y - pt.y) * (n.y - pt.y); if (d < bd) { bd = d; best = id; } });
  return best;
}
function geoBtnEl() { return document.getElementById("geoBtn"); }
function refreshGeoBtn() {
  const b = geoBtnEl(); if (!b) return;
  b.style.display = geoXform ? "" : "none";   // only offered for geo-calibrated parks
  b.classList.toggle("active", geoActive);
}
function onGeoFix(pos) {
  if (!geoXform) return;
  const c = pos.coords, p = geoXform(c.longitude, c.latitude);
  myLocation = { x: p.x, y: p.y, accM: c.accuracy };
  const nn = nearestNodeTo(p);
  if (nn !== geoStartNode) { geoStartNode = nn; if (!playing) refresh(); }   // re-route only when the snapped node changes
  draw();
}
// ?pretend=lat,lon — fake a standing position for testing away from the park.
function pretendLatLon() {
  try {
    const v = new URLSearchParams(location.search).get("pretend");
    if (!v) return null;
    const m = v.split(","); const lat = parseFloat(m[0]), lon = parseFloat(m[1]);
    if (isFinite(lat) && isFinite(lon)) return { lat: lat, lon: lon };
  } catch (e) {}
  return null;
}
function toggleGeo() {
  if (geoActive) { stopGeo(); return; }
  if (!geoXform) { alert("This park isn't geo-calibrated yet (needs Prop.LatLon on 3+ shapes)."); return; }
  const pretend = pretendLatLon();
  if (pretend) {        // testing override: place me at the URL's lat/lon, no GPS
    geoActive = true; refreshGeoBtn();
    onGeoFix({ coords: { longitude: pretend.lon, latitude: pretend.lat, accuracy: 5 } });
    return;
  }
  if (!navigator.geolocation) { alert("Geolocation isn't available in this browser."); return; }
  geoActive = true; refreshGeoBtn();
  geoWatchId = navigator.geolocation.watchPosition(onGeoFix,
    e => { stopGeo(); alert("Couldn't get your location: " + e.message); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}
function stopGeo() {
  if (geoWatchId != null) { try { navigator.geolocation.clearWatch(geoWatchId); } catch (e) {} }
  geoWatchId = null; geoActive = false; myLocation = null; geoStartNode = null;
  refreshGeoBtn(); if (!playing) refresh();
}
function drawMyLocation() {
  if (!myLocation) return;
  const X = tx(myLocation.x), Y = ty(myLocation.y);
  if (myLocation.accM > 0) {       // accuracy ring (meters -> map px via the park scale)
    const rPx = (myLocation.accM * 3.28084 / ftPerPx()) * view.scale;
    if (rPx > 4) {
      ctx.beginPath(); ctx.arc(X, Y, rPx, 0, 7);
      ctx.fillStyle = "rgba(66,133,244,0.12)"; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = "rgba(66,133,244,0.35)"; ctx.stroke();
    }
  }
  ctx.beginPath(); ctx.arc(X, Y, 7, 0, 7);
  ctx.fillStyle = "#4285f4"; ctx.fill();
  ctx.lineWidth = 2.5; ctx.strokeStyle = "#fff"; ctx.stroke();
}

let startOverride = null;   // node id chosen in the "From" dropdown, else null
function startNode() {
  if (geoActive && geoStartNode && state.nodes.has(geoStartNode)) return geoStartNode;  // "start from where I am"
  if (startOverride && state.nodes.has(startOverride)) return startOverride;  // "I'm here"
  if (state.nodes.has("start")) return "start";   // a node named "Start" in Visio
  if (state.nodes.has("begin")) return "begin";
  if (state.nodes.has("begin_in")) return "begin_in";
  if (state.nodes.has("Exit")) return "Exit";
  return state.nodes.keys().next().value;
}
// "From" dropdown: every named place (rides/restaurants/shops/pins) plus any
// named graph nodes. Selecting one routes the day from there ("I'm here").
function populateStartSelect() {
  const sel = document.getElementById("startLoc");
  if (!sel) return;
  const prev = sel.value;
  let html = '<option value="">Default start</option>';
  Array.from(state.attractions.values())
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, undefined, { sensitivity: "base", numeric: true }))
    .forEach(a => { if (a.exitNodeId || a.entranceNodeId) html += '<option value="attr:' + esc(a.id) + '">' + esc(a.name || a.id) + '</option>'; });
  const named = Array.from(state.nodes.values()).filter(n => n.name && n.name.trim());
  named.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  named.forEach(n => html += '<option value="node:' + esc(n.id) + '">' + esc(n.name) + '</option>');
  sel.innerHTML = html;
  sel.value = prev;                 // keep selection across rebuilds when still valid
  startOverride = resolveStartNode(sel.value);
}
function resolveStartNode(v) {
  if (!v) return null;
  if (v.indexOf("node:") === 0) return v.slice(5);
  if (v.indexOf("attr:") === 0) { const a = state.attractions.get(v.slice(5)); return a ? (a.exitNodeId || a.entranceNodeId) : null; }
  return null;
}

// Entrance node of the next planned (non-transit) attraction after seqIndex.
function nextDestinationNode(seqIndex) {
  for (let j = seqIndex + 1; j < state.sequence.length; j++) {
    const id = state.sequence[j];
    if (isTransitToken(id)) continue;
    const a = state.attractions.get(id);
    if (!a) continue;
    if (a.entranceNodeId && state.nodes.has(a.entranceNodeId)) return a.entranceNodeId;
    const acc = (Array.isArray(a.accessNodeIds) ? a.accessNodeIds : []).filter(x => state.nodes.has(x));
    if (acc.length) return acc[0];
  }
  return null;
}

// Build a travel-only step for an explicitly-scheduled transit ride: walk to the
// nearest boarding stop, then ride the line to the alight stop (chosen, else the
// stop nearest the next planned attraction).
function buildTransitStep(token, curNode, curTime, seqIndex) {
  const p = parseTransitToken(token);
  const line = (state.transport || []).find(l => l.id === p.lineId);
  if (!line) return null;
  const stops = lineStops(line).map(s => s.node);
  if (stops.length < 2) return null;
  updateTransitWeights(curTime);
  const boardPick = nearestAccess(curNode, stops);
  const board = boardPick ? boardPick.id : stops[0];
  let alight = (p.alight && stops.indexOf(p.alight) >= 0 && p.alight !== board) ? p.alight : null;
  if (!alight) {
    const others = stops.filter(s => s !== board);
    const nextNode = nextDestinationNode(seqIndex);
    const na = nextNode ? nearestAccess(nextNode, others) : null;
    alight = na ? na.id : (others[others.length - 1] || stops[0]);
  }
  const tedge = (state.adj.get(board) || []).find(e => e.kind === "transit" && e.line === line.id && e.to === alight);
  const rideMin = tedge ? tedge.rideMin : 0;
  const boardMin = tedge ? (tedge.boardMin || 0) : 0;
  const tpts = (tedge && tedge.points && tedge.points.length >= 2) ? tedge.points.map(pt => ({ x: pt.x, y: pt.y })) : [nodePt(board), nodePt(alight)];
  // walk from where we are to the boarding stop
  const wr = boardPick ? boardPick.route : dijkstra(curNode, board);
  const wdec = wr ? decomposeRoute(wr) : { walkPx: 0, coords: [nodePt(curNode), nodePt(board)], travelLegs: [], transitRide: 0, transitBoard: 0 };
  const walkToBoard = walkTimeMin(wdec.walkPx) + (wdec.transitRide || 0) + (wdec.transitBoard || 0);
  // combined travel: walk-to-board legs + the transit ride
  const travelLegs = (wdec.travelLegs || []).slice();
  travelLegs.push({ kind: "transit", lineName: line.name || line.id, toStop: alight, rideMin: rideMin, boardMin: boardMin });
  const coords = (wdec.coords && wdec.coords.length) ? wdec.coords.slice() : [nodePt(board)];
  const walkLen = polylineLength(coords);
  for (let k = (coords.length ? 1 : 0); k < tpts.length; k++) coords.push(tpts[k]);  // drop shared boarding vertex
  const total = polylineLength(coords) || 1;
  const transitSpans = [{ a: walkLen / total, b: 1, lineName: line.name || line.id, toStop: alight }];
  const travel = walkToBoard + boardMin + rideMin;
  const walkStart = curTime, walkEnd = walkStart + travel;
  return {
    attractionId: token, name: (line.name || line.id) + " → " + stopName(alight), category: "transit",
    pathIds: wr ? wr.path : [curNode, board], routeCoords: coords, reachable: !!tedge,
    distPx: wdec.walkPx, walk: travel, walkOnly: walkTimeMin(wdec.walkPx),
    transitRide: rideMin + (wdec.transitRide || 0), transitBoard: boardMin + (wdec.transitBoard || 0),
    transitLegs: [{ line: line.id, lineName: line.name || line.id, fromStop: board, toStop: alight, rideMin: rideMin, boardMin: boardMin }],
    transitSpans: transitSpans, travelLegs: travelLegs, wait: 0, ride: 0,
    walkStart: walkStart, walkEnd: walkEnd, waitStart: walkEnd, waitEnd: walkEnd, rideStart: walkEnd, rideEnd: walkEnd,
    total: travel, entranceNodeId: board, exitNodeId: alight, line: line.id, alight: alight, stops: stops
  };
}

function computeSequence() {
  const startMin = hmToMin(document.getElementById("startTime").value || "09:00");
  let curTime = startMin;
  let curNode = startNode();
  const steps = [];

  for (let si = 0; si < state.sequence.length; si++) {
    const attrId = state.sequence[si];
    // explicitly-scheduled transit ride (a travel-only step: walk to board, ride to alight)
    if (isTransitToken(attrId)) {
      const tstep = buildTransitStep(attrId, curNode, curTime, si);
      if (tstep) { steps.push(tstep); curTime = tstep.rideEnd; curNode = tstep.exitNodeId; }
      continue;
    }
    const a = state.attractions.get(attrId);
    if (!a) continue;
    // transit boarding waits change through the day — weight the lines for the
    // moment this leg departs before routing (a close enough proxy for the
    // moment we'd reach the boarding stop).
    updateTransitWeights(curTime);
    // entrance: nearest access node when the attraction lists several, else its entrance
    let entranceId = a.entranceNodeId, exitId = a.exitNodeId, route = null;
    const access = (Array.isArray(a.accessNodeIds) ? a.accessNodeIds : []).filter(id => state.nodes.has(id));
    if (access.length) {
      const best = nearestAccess(curNode, access);
      entranceId = best ? best.id : access[0];
      exitId = entranceId;                         // enter & leave a shop at the same point
      route = best ? best.route : dijkstra(curNode, entranceId);
    } else if (entranceId && state.nodes.has(entranceId)) {
      route = dijkstra(curNode, entranceId);
    } else {
      entranceId = curNode; exitId = curNode;      // no node link (e.g. a pin): stay put
      route = dijkstra(curNode, curNode);
    }
    const pathIds = route ? route.path : [curNode, entranceId];
    // split the route into walked distance vs transit (rail/ferry) ride + wait
    const leg = route ? decomposeRoute(route)
                      : { walkPx: polylineLength([nodePt(curNode), nodePt(entranceId)]), transitRide: 0, transitBoard: 0, coords: [nodePt(curNode), nodePt(entranceId)], transitLegs: [] };
    const routeCoords = leg.coords;
    const distPx = leg.walkPx;                     // pixels actually WALKED (transit excluded)
    const walkOnly = walkTimeMin(distPx);
    const transitRide = leg.transitRide, transitBoard = leg.transitBoard;
    const travel = walkOnly + transitRide + transitBoard;   // whole "get to the next stop" leg
    const reachable = !!route;

    const walkStart = curTime, walkEnd = walkStart + travel;
    const category = attrCat(a);
    // live wait > configured average > time-of-day; non-rides are 0
    const wait = waitFor(a, walkEnd);
    const waitStart = walkEnd, waitEnd = waitStart + wait;
    const ride = attrDuration(a);
    const rideStart = waitEnd, rideEnd = rideStart + ride;

    steps.push({
      attractionId: attrId, name: a.name, category,
      pathIds, routeCoords,
      reachable, distPx, walk: travel, walkOnly, transitRide, transitBoard, transitLegs: leg.transitLegs, transitSpans: leg.transitSpans, travelLegs: leg.travelLegs,
      wait, ride,
      walkStart, walkEnd, waitStart, waitEnd, rideStart, rideEnd,
      total: travel + wait + ride,
      entranceNodeId: entranceId, exitNodeId: exitId
    });

    curTime = rideEnd;
    curNode = exitId;
  }
  state.steps = steps;
  return steps;
}

/* ---------- Canvas rendering -------------------------------------------- */
const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");
let view = { scale: 1, ox: 0, oy: 0 };

// On phones the map occupies far less screen space, so the fixed-size
// attraction markers look oversized and overlap. Shrink them on the same
// breakpoint the layout uses (re-evaluated each draw, so rotate/resize updates).
const mobileMQ = window.matchMedia("(max-width: 820px)");
function attrSize() {
  return mobileMQ.matches
    ? { r: 5, hot: 6.5, font: 8 }
    : { r: 8, hot: 10,  font: 10 };
}

// Background image placed in map space via an independent transform
// (scale + offset), so any-resolution image can be aligned to the nodes.
// Persisted to localStorage so alignment survives a refresh.
const bg = Object.assign({ scale: 1, offX: 0, offY: 0, opacity: 1 }, loadBg());
let showGraph = localStorage.getItem("ridesim.showGraph") === "1"; // node/edge network (off by default; toggle removed)
let hoverAttr = null; // attraction id whose label is shown on map hover
let labelHit = null;  // screen rect of the shown hover label (click/tap to add)
let showPlan = localStorage.getItem("ridesim.showPlan") === "1"; // highlight the day's route
let hoverStep = null; // step index whose walk segment is hovered (shows dist/time)
let selectedStep = null; // step index selected by tapping its sequence-list item
// One live source — ThemeParks.wiki — powers both standby waits and Lightning Lane.
let showLiveWaits = localStorage.getItem("ridesim.liveWaits") === "1"; // standby wait overlay
let showLL = localStorage.getItem("ridesim.ll") === "1";               // Lightning Lane overlay
let llPanelCollapsed = localStorage.getItem("ridesim.llCollapsed") === "1"; // LL list minimized to header
// byId: entity GUID -> entry; byName: normName -> entry; entry = {name, wait, open, ll}
const liveWaits = { byId: new Map(), byName: new Map(), fetchedAt: 0, error: false, errMsg: "",
                    anyOpen: false, anyLL: false, total: 0, withLL: 0, withFc: 0 };
let liveTimer = null, tpSourceIdx = 0;
const TP_PARK = SAMPLE.meta.thpwId;   // ThemeParks.wiki entity GUID for this park
const TP_URL = "https://api.themeparks.wiki/v1/entity/" + TP_PARK + "/live";
// api.themeparks.wiki is behind Cloudflare; try direct then public CORS proxies.
const TP_SOURCES = [
  () => TP_URL,
  () => "https://api.allorigins.win/raw?url=" + encodeURIComponent(TP_URL),
  () => "https://corsproxy.io/?url=" + encodeURIComponent(TP_URL)
];
const bgImg = new Image();
let bgReady = false;
bgImg.onload = () => { bgReady = true; applyMapExtent(); computeView(); draw(); };
bgImg.onerror = () => { bgReady = false; };
bgImg.src = SAMPLE.meta.background || "background.png";
// When the Visio export provides a map extent (in node coords), stretch the
// background to exactly that rectangle — resolution-independent alignment.
function applyMapExtent() {
  const e = state.mapExtent;
  if (!e || !bgReady || !bgImg.naturalWidth) return;
  bg.scale = e.w / bgImg.naturalWidth;
  bg.offX = e.x;
  bg.offY = e.y;
  saveBg();
}
function loadBg() { try { return JSON.parse(localStorage.getItem("ridesim.bg") || "{}"); } catch (e) { return {}; } }
function saveBg() { try { localStorage.setItem("ridesim.bg", JSON.stringify(bg)); } catch (e) {} }
function bgOpacity() { return bg.opacity; }
// image rect in map coords
function bgRect() {
  return { x: bg.offX, y: bg.offY, w: bgImg.naturalWidth * bg.scale, h: bgImg.naturalHeight * bg.scale };
}

/* ---------- Align Map mode (scale/position the background) --------------- */
let bgAdjust = false, bgDragging = false;
function toggleBgAdjust() {
  bgAdjust = !bgAdjust;
  if (bgAdjust && typeof addMode !== "undefined" && addMode) toggleAddMode();
  document.querySelector(".canvas-wrap").classList.toggle("bgadjust", bgAdjust);
  document.getElementById("bgAdjustBtn").classList.toggle("active", bgAdjust);
  if (bgAdjust) { stop(); renderBgReadout(); }
  draw();
}
function renderBgReadout() {
  document.getElementById("bgReadout").textContent =
    "Map scale " + bg.scale.toFixed(3) + "  ·  drag to move · scroll to zoom";
}
function bgDown() { if (bgAdjust) bgDragging = true; }
function bgMove(ev) {
  if (!bgAdjust || !bgDragging) return;
  bg.offX += ev.movementX / view.scale;
  bg.offY += ev.movementY / view.scale;
  draw();
}
function bgUp() { if (bgDragging) { bgDragging = false; saveBg(); } }
function bgWheel(ev) {
  if (!bgAdjust || !bgReady) return;
  ev.preventDefault();
  const m = screenToMap(ev);
  const s2 = Math.max(0.01, bg.scale * (ev.deltaY < 0 ? 1.05 : 1 / 1.05));
  bg.offX = m.x - (m.x - bg.offX) * (s2 / bg.scale);  // keep point under cursor fixed
  bg.offY = m.y - (m.y - bg.offY) * (s2 / bg.scale);
  bg.scale = s2;
  saveBg(); draw(); renderBgReadout();
}
// Scale-to-contain + center the image over the node bounding box (a starting point).
function bgFit() {
  if (!bgReady || !bgImg.naturalWidth) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  state.nodes.forEach(n => {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y);
  });
  if (!isFinite(minX)) return;
  const bw = maxX - minX, bh = maxY - minY;
  bg.scale = Math.max(0.01, Math.min(bw / bgImg.naturalWidth, bh / bgImg.naturalHeight));
  bg.offX = minX + (bw - bgImg.naturalWidth * bg.scale) / 2;
  bg.offY = minY + (bh - bgImg.naturalHeight * bg.scale) / 2;
  saveBg(); draw(); renderBgReadout();
}

function computeView() {
  // Fit to the node bounding box only. The background is a free-floating
  // backdrop positioned by its own transform (see bgRect / Adjust Map mode).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  state.nodes.forEach(n => {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y);
  });
  const e = state.mapExtent;
  if (e) {
    minX = Math.min(minX, e.x); minY = Math.min(minY, e.y);
    maxX = Math.max(maxX, e.x + e.w); maxY = Math.max(maxY, e.y + e.h);
  }
  if (!isFinite(minX)) { view = { scale: 1, ox: 0, oy: 0 }; return; }
  const w = canvas.clientWidth, h = canvas.clientHeight;
  // On phones a fixed 70px border would swallow most of a narrow canvas, so
  // pad by a small fraction there — leaving the map ~90% of the width.
  const padX = mobileMQ.matches ? w * 0.05 : 70;
  const padY = mobileMQ.matches ? h * 0.05 : 70;
  const sx = (w - padX * 2) / Math.max(1, maxX - minX);
  const sy = (h - padY * 2) / Math.max(1, maxY - minY);
  const scale = Math.min(sx, sy);
  view.scale = scale;
  view.ox = padX - minX * scale + (w - padX * 2 - (maxX - minX) * scale) / 2;
  view.oy = padY - minY * scale + (h - padY * 2 - (maxY - minY) * scale) / 2;
}
function tx(x) { return x * view.scale + view.ox; }
function ty(y) { return y * view.scale + view.oy; }
function screenToMap(ev) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (ev.clientX - rect.left - view.ox) / view.scale,
    y: (ev.clientY - rect.top - view.oy) / view.scale
  };
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  computeView();
  draw();
}

function draw(marker) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  labelHit = null;                 // re-established below if a hover label is drawn
  ctx.clearRect(0, 0, w, h);

  // background image placed via its own scale+offset transform, then through
  // the view transform. Aligns any-resolution image to the node coordinates.
  if (bgReady && bg.opacity > 0) {
    const r = bgRect();
    ctx.globalAlpha = bg.opacity;
    ctx.drawImage(bgImg, tx(r.x), ty(r.y), r.w * view.scale, r.h * view.scale);
    ctx.globalAlpha = 1;
    if (bgAdjust) { // outline while adjusting
      ctx.globalAlpha = 1; ctx.strokeStyle = "#ffcc4d"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.strokeRect(tx(r.x), ty(r.y), r.w * view.scale, r.h * view.scale);
      ctx.setLineDash([]);
    }
  }

  // connections (part of the graph — hidden when graph is toggled off)
  if (showGraph) {
    ctx.lineWidth = 2; ctx.strokeStyle = "#2b3a57";
    const drawn = new Set();
    state.adj.forEach((edges, id) => {
      const n = state.nodes.get(id);
      edges.forEach(e => {
        if (e.kind === "transit") return;   // transit lines are drawn separately, in teal
        const key = id < e.to ? id + e.to : e.to + id;
        if (drawn.has(key)) return; drawn.add(key);
        const m = state.nodes.get(e.to);
        const pts = (e.points && e.points.length >= 2) ? e.points : [n, m];
        ctx.beginPath();
        pts.forEach((p, i) => { i ? ctx.lineTo(tx(p.x), ty(p.y)) : ctx.moveTo(tx(p.x), ty(p.y)); });
        ctx.stroke();
      });
    });
  }

  // transport lines (rail / ferry) — faint like ride tracks; the line currently
  // being ridden brightens during animation.
  const actStep = (playing && activeStepIndex >= 0) ? state.steps[activeStepIndex] : null;
  const activeLines = new Set();
  if (actStep) {
    if (actStep.line) activeLines.add(actStep.line);
    (actStep.transitLegs || []).forEach(t => activeLines.add(t.line));
  }
  (state.transport || []).forEach(line => {
    const bright = activeLines.has(line.id);
    // a line's two directions overlap, so the idle alpha is kept low (it stacks
    // to roughly the ride-track faintness); the ridden line jumps to full.
    const col = bright ? "rgba(70,198,184,0.9)" : "rgba(70,198,184,0.13)";
    (line.segments || []).forEach(seg => {
      if (!seg || !state.nodes.has(seg.from) || !state.nodes.has(seg.to)) return;
      const path = (Array.isArray(seg.path) && seg.path.length >= 2) ? seg.path : [nodePt(seg.from), nodePt(seg.to)];
      drawPath(path, col, bright ? 2.6 : 1.4, false);
    });
    lineStops(line).forEach(s => {
      const p = nodePt(s.node);
      ctx.globalAlpha = bright ? 1 : 0.25;
      ctx.beginPath(); ctx.arc(tx(p.x), ty(p.y), bright ? 4.5 : 2.5, 0, 7);
      ctx.fillStyle = TRANSIT_COLOR; ctx.fill();
      if (bright) { ctx.lineWidth = 1.5; ctx.strokeStyle = "#0f1420"; ctx.stroke(); }  // outline only when in use
      ctx.globalAlpha = 1;
    });
  });

  // ride tracks (always faint). The active ride's track brightens during play.
  const activeTrackId = (activeStepIndex >= 0 && state.steps[activeStepIndex])
    ? state.steps[activeStepIndex].attractionId : null;
  state.attractions.forEach(a => {
    if (!Array.isArray(a.track) || a.track.length < 2) return;
    if (playing && state.sequence.indexOf(a.id) < 0) return;   // focus on the plan while animating
    const bright = a.id === activeTrackId && playing;
    drawPath(a.track, bright ? "rgba(157,123,255,0.9)" : "rgba(157,123,255,0.25)", bright ? 2.1 : 1.4, false);
  });

  // sequence routes: prominent + direction arrows when "Plan" is on, else faint
  if (showPlan) {
    state.steps.forEach(s => {
      drawPath(s.routeCoords, "rgba(128,0,32,0.85)", 3, false);   // maroon
      drawRouteArrows(s.routeCoords, "rgba(231,150,165,0.95)");   // light maroon arrows
    });
  } else {
    state.steps.forEach(s => drawPath(s.routeCoords, "rgba(92,200,255,0.16)", 3, false));
  }
  // bright active route (animation)
  if (activeStepIndex >= 0 && state.steps[activeStepIndex])
    drawPath(state.steps[activeStepIndex].routeCoords, null, 4, true);
  // hovered walk segment (shows its distance/time tooltip)
  if (hoverStep !== null && state.steps[hoverStep])
    drawPath(state.steps[hoverStep].routeCoords, null, 4, true);
  // hover preview (already a coords polyline)
  if (state.hoverPath)
    drawPath(state.hoverPath, "rgba(255,204,77,0.55)", 3, false);

  // junction nodes (part of the graph — hidden when graph is toggled off)
  if (showGraph) {
    state.nodes.forEach(n => {
      if (n.isAttraction) return;
      ctx.beginPath(); ctx.arc(tx(n.x), ty(n.y), 1.5, 0, 7); ctx.fillStyle = "#46557a"; ctx.fill();
    });
  }

  // attractions (names shown on hover only — see drawAttrLabel)
  const sz = attrSize();
  state.attractions.forEach(a => {
    const inSeq = state.sequence.indexOf(a.id);
    const cat = attrCat(a);
    // hide a filtered-out category, but always keep sequenced ones visible
    if (!catFilter[cat] && inSeq < 0) return;
    if (playing && inSeq < 0) return;   // while animating, show only plan locations
    const loc = a.displayLocation || state.nodes.get(a.entranceNodeId);
    const X = tx(loc.x), Y = ty(loc.y);
    const hot = a.id === hoverAttr;
    // restrooms render as a small icon (no colored disc), pin-ish in size
    if (cat === "restroom") {
      const fs = Math.round((hot ? sz.hot : sz.r) * 1.65);
      ctx.globalAlpha = attrClosed(a) ? 0.45 : 0.7;
      ctx.font = fs + "px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("🚻", X, Y);
      ctx.globalAlpha = 1;
      if (inSeq >= 0) drawSeqBadge(X, Y, fs * 0.4, inSeq + 1);
      return;
    }
    const live = (showLiveWaits && liveWaits.anyOpen) ? liveWaitFor(a) : null;  // hide when park closed
    const liveShow = live && (!live.open || typeof live.wait === "number");      // skip open-but-no-standby
    const ll = showLL ? llAvail(a) : null;          // AVAILABLE Lightning Lane (countdown takes over the center)
    // pins are points of interest — half the diameter of other markers
    let radius = (hot ? sz.hot : sz.r) * (cat === "pin" ? 0.5 : 1), fill, inside = "", insideColor = "#08263a";
    if (ll) {
      // LL available — show whole minutes until the return window opens, in gold.
      radius += 3;
      fill = LL_COLOR; inside = String(llMinutesUntil(ll)); insideColor = "#08263a";
    } else if (liveShow) {
      radius += 3;                                  // a touch bigger to fit the number
      if (!live.open) { fill = CLOSED_COLOR; inside = "✕"; insideColor = "#fff"; }
      else { fill = waitColor(live.wait); inside = String(live.wait); insideColor = "#fff"; }
    } else {
      fill = attrClosed(a) ? CLOSED_COLOR : (inSeq >= 0 ? ATTR_COLORS[cat].on : ATTR_COLORS[cat].off);
      inside = (inSeq >= 0 && cat !== "pin") ? String(inSeq + 1) : "";  // too small to hold a number
    }
    ctx.globalAlpha = 0.7;                              // named nodes 30% transparent (fill + stroke)
    ctx.beginPath(); ctx.arc(X, Y, radius, 0, 7);
    ctx.fillStyle = fill; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = hot ? "#fff" : "#0f1420"; ctx.stroke();
    if (inside) {
      ctx.fillStyle = insideColor; ctx.font = "bold " + sz.font + "px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(inside, X, Y);
    }
    if ((liveShow || ll) && inSeq >= 0) drawSeqBadge(X, Y, radius, inSeq + 1);  // keep order visible
    ctx.globalAlpha = 1;
    if (ll) drawLLBadge(X, Y, radius);            // ⚡ bolt at the bottom of LL rides
  });
  if (hoverAttr) {
    const a = state.attractions.get(hoverAttr);
    if (a) drawAttrLabel(a);
  }

  // selected sequence stop: gold walk-to leg + a ring on its attraction
  if (selectedStep !== null && state.steps[selectedStep]) {
    const s = state.steps[selectedStep];
    drawPath(s.routeCoords, "rgba(255,204,77,0.95)", 4, false);
    const a = state.attractions.get(s.attractionId);
    const loc = a && (a.displayLocation || state.nodes.get(a.entranceNodeId));
    if (loc) {
      ctx.beginPath(); ctx.arc(tx(loc.x), ty(loc.y), attrSize().r + 6, 0, 7);
      ctx.lineWidth = 2.5; ctx.strokeStyle = "#ffcc4d"; ctx.stroke();
    }
  }

  // marker
  if (marker) {
    const ms = marker.scale || 1;                 // avatar scales on rides or at restaurants/restrooms
    const AVATAR_PURPLE = "#9d7bff";              // always use ride purple for fill
    ctx.beginPath(); ctx.arc(tx(marker.x), ty(marker.y), 7 * ms, 0, 7);
    ctx.fillStyle = AVATAR_PURPLE; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = marker.stroke || "#5cc8ff"; ctx.stroke();
    ctx.beginPath(); ctx.arc(tx(marker.x), ty(marker.y), 11 * ms, 0, 7);
    ctx.strokeStyle = marker.stroke || "#5cc8ff"; ctx.globalAlpha = .4; ctx.stroke(); ctx.globalAlpha = 1;
  }
  drawMyLocation();   // "you are here" GPS dot, on top
}
function drawPath(coords, color, lw, bright) {
  if (!coords || coords.length < 2) return;
  ctx.lineWidth = lw; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.strokeStyle = bright ? "#5cc8ff" : color;
  if (bright) { ctx.shadowColor = "#5cc8ff"; ctx.shadowBlur = 8; }
  ctx.beginPath();
  coords.forEach((c, i) => { i ? ctx.lineTo(tx(c.x), ty(c.y)) : ctx.moveTo(tx(c.x), ty(c.y)); });
  ctx.stroke();
  ctx.shadowBlur = 0;
}
// Direction arrows spaced along a route polyline (shows travel order in Plan view).
function drawRouteArrows(coords, color) {
  if (!coords || coords.length < 2) return;
  const pts = coords.map(c => ({ x: tx(c.x), y: ty(c.y) }));
  const spacing = 75; let acc = spacing * 0.5;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 1e-6) continue;
    const ux = (b.x - a.x) / segLen, uy = (b.y - a.y) / segLen;
    while (acc <= segLen) { drawArrowhead(a.x + ux * acc, a.y + uy * acc, ux, uy, color); acc += spacing; }
    acc -= segLen;
  }
}
function drawArrowhead(x, y, ux, uy, color) {
  const s = 6, w = 4, px = -uy, py = ux;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + ux * s, y + uy * s);
  ctx.lineTo(x - ux * s + px * w, y - uy * s + py * w);
  ctx.lineTo(x - ux * s - px * w, y - uy * s - py * w);
  ctx.closePath(); ctx.fill();
}
// Hover label: a readable pill above the circle. Shows the name, plus any
// hoverText beneath it (word-wrapped, clamped to the canvas).
function drawAttrLabel(a) {
  const loc = a.displayLocation || state.nodes.get(a.entranceNodeId);
  if (!loc) return;
  const X = tx(loc.x), Y = ty(loc.y);
  const nameFont = "bold 12px -apple-system, Segoe UI, sans-serif";
  const subFont = "11px -apple-system, Segoe UI, sans-serif";
  const maxW = 240;

  const lines = [{ t: a.name || a.id, font: nameFont, color: "#fff" }];
  const extra = (a.hoverText || "").trim();
  if (extra) extra.split(/\r?\n/).forEach(para =>
    wrapText(para, subFont, maxW).forEach(l => lines.push({ t: l, font: subFont, color: "#b9c4d6" })));
  // actionable hint — tapping/clicking the label adds it to the sequence
  const inSeq = state.sequence.indexOf(a.id) >= 0;
  lines.push({ t: inSeq ? "✓ in plan — tap to add again" : "＋ tap to add to plan", font: subFont, color: inSeq ? "#7bd88f" : "#9fd0ff" });

  const padX = 8, padY = 6, lineH = 15;
  let bw = 0;
  lines.forEach(l => { ctx.font = l.font; bw = Math.max(bw, ctx.measureText(l.t).width); });
  bw += padX * 2;
  const bh = padY * 2 + lineH * lines.length;
  let bx = Math.max(4, Math.min(X - bw / 2, canvas.clientWidth - bw - 4));
  let by = Y - 14 - bh;
  if (by < 4) by = Y + 14;            // flip below the marker if it'd clip the top

  ctx.fillStyle = "rgba(16,22,36,0.92)";
  ctx.strokeStyle = ATTR_COLORS[attrCat(a)].off; ctx.lineWidth = 1;
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 6); ctx.fill(); ctx.stroke(); }
  else { ctx.fillRect(bx, by, bw, bh); ctx.strokeRect(bx, by, bw, bh); }

  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  let lineY = by + padY + lineH / 2;
  lines.forEach(l => { ctx.font = l.font; ctx.fillStyle = l.color; ctx.fillText(l.t, bx + bw / 2, lineY); lineY += lineH; });

  // remember where the label is so a click/tap on it can add the attraction
  labelHit = { x: bx, y: by, w: bw, h: bh, id: a.id, nodeY: Y };
}
// Greedy word-wrap to a max pixel width using the given font.
function wrapText(text, font, maxW) {
  ctx.font = font;
  const words = text.split(/\s+/);
  const out = []; let cur = "";
  words.forEach(w => {
    const test = cur ? cur + " " + w : w;
    if (cur && ctx.measureText(test).width > maxW) { out.push(cur); cur = w; }
    else cur = test;
  });
  if (cur) out.push(cur);
  return out.length ? out : [text];
}

/* ---------- Live wait times (Queue-Times.com) --------------------------- */
// Match an attraction to its live entry: ThPWID (themeparks GUID) first, else
// fall back to matching the ride name against the feed. Cached per fetch.
let liveMatch = { at: -1, map: new Map() };
function normName(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function liveEntry(a) {
  if (!a || attrCat(a) !== "ride") return null;
  if (a.thpwId) return liveWaits.byId.get(String(a.thpwId)) || null;
  if (liveMatch.at !== liveWaits.fetchedAt) liveMatch = { at: liveWaits.fetchedAt, map: new Map() };
  if (liveMatch.map.has(a.id)) return liveMatch.map.get(a.id);
  const n = normName(a.name); let res = liveWaits.byName.get(n) || null;
  if (!res && n.length >= 4) for (const e of liveWaits.byName.values()) {
    const ln = normName(e.name);
    if (ln.includes(n) || n.includes(ln)) { res = e; break; }
  }
  liveMatch.map.set(a.id, res);
  return res;
}
// {wait, open} for the standby overlay/timing; {state,start,end,price} for LL.
function liveWaitFor(a) { const e = liveEntry(a); return e ? { wait: e.wait, open: e.open } : null; }
function llFor(a) { const e = liveEntry(a); return e ? e.ll : null; }
function llAvail(a) { const ll = llFor(a); return (ll && ll.state === "AVAILABLE") ? ll : null; }
// Whole minutes from now until an LL's next return window opens (0 if already open).
function llMinutesUntil(ll) {
  if (!ll || !ll.start) return null;
  const d = new Date(ll.start); if (isNaN(d.getTime())) return null;
  return Math.max(0, Math.round((d.getTime() - Date.now()) / 60000));
}
function waitColor(w) {
  if (w <= 15) return "#3fae5a";
  if (w <= 30) return "#86b300";
  if (w <= 45) return "#e0a020";
  if (w <= 75) return "#e0651f";
  return "#d23b3b";
}
// small sequence-order badge at a circle's upper-right (when waits take the center)
function drawSeqBadge(X, Y, r, n) {
  const bx = X + r * 0.78, by = Y - r * 0.78;
  ctx.beginPath(); ctx.arc(bx, by, 6, 0, 7);
  ctx.fillStyle = "#5cc8ff"; ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = "#0f1420"; ctx.stroke();
  ctx.fillStyle = "#08263a"; ctx.font = "bold 8px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(String(n), bx, by);
}
function hmFromDate(d) {
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
async function fetchOneTp(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (!data || !Array.isArray(data.liveData)) throw new Error("unexpected shape");
  return data;
}
// Single fetch from ThemeParks.wiki: standby waits + Lightning Lane, keyed by
// entity GUID (and name, for fallback matching).
// Park-local minutes-of-day from a forecast ISO timestamp. We read the literal
// HH:MM (which already carries the park's -04:00/-05:00 offset) instead of using
// Date(), so the value is stable regardless of the viewer's own timezone and can
// be reused on any planning day — we only care about hour-of-day, not the date.
function fcMinOfDay(iso) {
  const m = /T(\d{2}):(\d{2})/.exec(String(iso || ""));
  if (!m) return null;
  return (+m[1]) * 60 + (+m[2]);
}
// Convert a themeparks.wiki forecast array into sorted [{t(min), w}] points,
// or null when there's nothing usable.
function parseForecast(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const fc = [];
  arr.forEach(p => {
    if (!p || typeof p.waitTime !== "number") return;
    const t = fcMinOfDay(p.time);
    if (t === null) return;
    fc.push({ t: t, w: p.waitTime });
  });
  if (!fc.length) return null;
  fc.sort((a, b) => a.t - b.t);
  return fc;
}
// After a live fetch, seed state.waits from each ride's hourly forecast so the
// time-of-day interpolation (interpWait) reflects today's expected curve.
function applyForecastWaits() {
  let n = 0;
  state.attractions.forEach(a => {
    if (attrCat(a) !== "ride") return;
    const e = liveEntry(a);
    if (e && e.fc && e.fc.length) {
      state.waits.set(a.id, e.fc.map(p => ({ t: p.t, w: p.w })));
      n++;
    }
  });
  liveWaits.withFc = n;
}
async function fetchLive() {
  let data = null, lastErr = null;
  const order = [tpSourceIdx, ...TP_SOURCES.map((_, i) => i).filter(i => i !== tpSourceIdx)];
  for (const i of order) {
    try { data = await fetchOneTp(TP_SOURCES[i]()); tpSourceIdx = i; break; }
    catch (e) { lastErr = e; }
  }
  if (data) {
    const byId = new Map(), byName = new Map(); let withLL = 0;
    data.liveData.forEach(e => {
      if (!e || !e.id) return;
      const sb = e.queue && e.queue.STANDBY;
      // Lightning Lane comes in two flavors: RETURN_TIME (Multi Pass — broad,
      // no price) and PAID_RETURN_TIME (Individual LL — a-la-carte, has price).
      // Take whichever source is AVAILABLE; flag the paid one so the UI can
      // show its price.
      const rt = e.queue && e.queue.RETURN_TIME;
      const pr = e.queue && e.queue.PAID_RETURN_TIME;
      const cand = [rt, pr].filter(Boolean);
      const src = cand.find(x => x.state === "AVAILABLE") || cand[0] || null;
      const ll = src ? { state: src.state || "", start: src.returnStart || null, end: src.returnEnd || null,
                         price: (src.price && src.price.formatted) ? src.price.formatted : "",
                         paid: src === pr } : null;
      if (ll) withLL++;
      const entry = { name: e.name || "",
        wait: (sb && typeof sb.waitTime === "number") ? sb.waitTime : null,
        open: e.status === "OPERATING", ll: ll, fc: parseForecast(e.forecast) };
      byId.set(String(e.id), entry);
      if (entry.name) byName.set(normName(entry.name), entry);
    });
    liveWaits.byId = byId; liveWaits.byName = byName;
    liveWaits.total = data.liveData.length; liveWaits.withLL = withLL;
    liveWaits.anyOpen = [...byId.values()].some(e => e.open);
    liveWaits.anyLL = [...byId.values()].some(e => e.ll && e.ll.state === "AVAILABLE");
    liveWaits.fetchedAt = Date.now(); liveWaits.error = false; liveWaits.errMsg = "";
    applyForecastWaits();   // seed the time-of-day wait matrix from hourly forecasts
  } else {
    liveWaits.error = true;
    liveWaits.errMsg = lastErr ? String(lastErr.message || lastErr).slice(0, 60) : "all sources failed";
    console.warn("ThemeParks.wiki fetch failed (all sources):", lastErr);
  }
  liveMatch = { at: -1, map: new Map() };
  updateLiveCredit();
  if (playing) draw(); else refresh();   // recompute sequence times against fresh waits
}
function liveOn() { return showLiveWaits || showLL; }
function startLiveRefresh() { if (!liveTimer) liveTimer = setInterval(fetchLive, 5 * 60 * 1000); }
function stopLiveRefresh() { if (liveTimer && !liveOn()) { clearInterval(liveTimer); liveTimer = null; } }
function t12FromISO(iso) {
  if (!iso) return "";
  const d = new Date(iso); if (isNaN(d.getTime())) return "";
  let h = d.getHours(); const m = d.getMinutes(); const ap = h < 12 ? "AM" : "PM";
  return (h % 12 || 12) + ":" + String(m).padStart(2, "0") + " " + ap;
}
function drawLLBadge(X, Y, r) {
  const br = Math.max(4, r * 0.55);            // badge scales with the circle (smaller on mobile)
  const bx = X, by = Y + r + br * 0.35;        // nestled just below the circle
  ctx.beginPath(); ctx.arc(bx, by, br, 0, 7);
  ctx.fillStyle = "rgba(16,22,36,0.95)"; ctx.fill();
  ctx.lineWidth = br >= 6 ? 1.5 : 1; ctx.strokeStyle = LL_COLOR; ctx.stroke();
  ctx.font = (br * 1.25).toFixed(1) + "px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("⚡", bx, by);
}
// proximity-sorted panel of rides with an LL available now
function renderLLPanel() {
  const el = document.getElementById("llPanel");
  if (!el) return;
  if (!showLL) { el.style.display = "none"; return; }
  el.style.display = "block";
  const from = startNode();
  const rows = [];
  state.attractions.forEach(a => {
    const e = llAvail(a);
    if (!e) return;
    const r = dijkstra(from, a.entranceNodeId);
    rows.push({ name: a.name, ll: e, dist: r ? r.dist : Infinity });
  });
  rows.sort((x, y) => x.dist - y.dist);
  let html = '<div class="ll-head">⚡ Lightning Lanes — nearest<span class="ll-caret">▾</span></div>';
  if (!rows.length) {
    let msg;
    if (!liveWaits.fetchedAt) msg = liveWaits.error ? "fetch failed (CORS/proxy)" : "loading…";
    else if (liveWaits.withLL === 0) msg = "API exposes no LL data (" + liveWaits.total + " rides fetched)";
    else if (!liveWaits.anyLL) msg = "no LL available now (" + liveWaits.withLL + "/" + liveWaits.total + " rides have the field)";
    else msg = "available LLs don't match our rides (" + liveWaits.withLL + " have the field)";
    html += '<div class="ll-empty">' + msg + '</div>';
  } else {
    rows.slice(0, 8).forEach(r => {
      const mins = llMinutesUntil(r.ll);
      const when = t12FromISO(r.ll.start) + (mins != null ? " · " + (mins === 0 ? "now" : mins + " min") : "");
      const meta = [r.ll.price, when].filter(Boolean).join(" · ");
      html += '<div class="ll-row"><span class="ll-nm">' + esc(r.name) + '</span>' +
        '<span class="ll-meta">' + meta + '</span>' +
        '<span class="ll-dist">' + (isFinite(r.dist) ? fmtFeet(r.dist * ftPerPx()) : "") + '</span></div>';
    });
  }
  html += '<div class="ll-credit">LL data: <a href="https://themeparks.wiki" target="_blank" rel="noopener">ThemeParks.wiki</a></div>';
  el.innerHTML = html;
  // tap the header to minimize the list down to just the title (keeps the map clear)
  el.classList.toggle("collapsed", llPanelCollapsed);
  const head = el.querySelector(".ll-head");
  if (head) head.onclick = () => {
    llPanelCollapsed = !llPanelCollapsed;
    try { localStorage.setItem("ridesim.llCollapsed", llPanelCollapsed ? "1" : "0"); } catch (e) {}
    el.classList.toggle("collapsed", llPanelCollapsed);
  };
}
// Attribution for ThemeParks.wiki; shown whenever an overlay is on.
function updateLiveCredit() {
  const el = document.getElementById("qtCredit");
  if (!liveOn()) { el.style.display = "none"; return; }
  el.style.display = "block";
  let meta = "";
  if (liveWaits.fetchedAt && showLiveWaits && !liveWaits.anyOpen) {
    meta = " · park closed — waits hidden";
  } else if (liveWaits.fetchedAt) {
    meta = " · updated " + hmFromDate(new Date(liveWaits.fetchedAt));
    // diagnostic: of rides that have a ThPWID set, how many matched the feed
    // (placeholder rides without an ID — walk-to-exit etc. — are excluded)
    let withId = 0, matched = 0;
    state.attractions.forEach(a => { if (attrCat(a) === "ride" && a.thpwId) { withId++; if (liveEntry(a)) matched++; } });
    meta += " · " + matched + "/" + withId + " ID'd rides matched";
    if (withId === 0) meta += " — set ThPWID";
    else if (matched === 0) meta += " — IDs not in feed";
    if (liveWaits.withFc) meta += " · " + liveWaits.withFc + " forecast" + (liveWaits.withFc === 1 ? "" : "s");
  } else if (liveWaits.error) {
    meta = " · unavailable" + (liveWaits.errMsg ? " (" + liveWaits.errMsg + ")" : "");
  } else meta = " · loading…";
  el.innerHTML = '<a href="https://themeparks.wiki" target="_blank" rel="noopener">Data: ThemeParks.wiki</a>' +
    '<span class="qt-meta">' + meta + '</span>';
}

/* ---------- UI: attraction picker --------------------------------------- */
function renderAttrList() {
  const el = document.getElementById("attrList");
  el.innerHTML = "";
  const sorted = Array.from(state.attractions.values())
    .filter(a => catFilter[attrCat(a)])
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, undefined, { sensitivity: "base", numeric: true }));
  sorted.forEach(a => {
    const div = document.createElement("div");
    div.className = "attr-item";
    const dotColor = attrClosed(a) ? CLOSED_COLOR : ATTR_COLORS[attrCat(a)].off;
    div.innerHTML = '<span class="dot" style="background:' + dotColor + '"></span><span class="nm">' + esc(a.name) +
      (attrClosed(a) ? ' <span class="meta">(closed)</span>' : '') +
      '</span><span class="meta">' + attrDuration(a) + 'm</span>';
    div.onclick = () => { state.sequence.push(a.id); refresh(); };
    div.onmouseenter = () => {
      const r = dijkstra(lastLocation(), a.entranceNodeId);
      state.hoverPath = r ? buildRoute(r.path) : null; draw();
    };
    div.onmouseleave = () => { state.hoverPath = null; draw(); };
    el.appendChild(div);
  });
  // transport lines — add as explicit "ride it" stops (board nearest, alight auto)
  (state.transport || []).forEach(line => {
    if (!catFilter.transit) return;
    const div = document.createElement("div");
    div.className = "attr-item";
    div.innerHTML = '<span class="dot" style="background:' + TRANSIT_COLOR + '"></span>' +
      '<span class="nm">🚂 ' + esc(line.name || line.id) + '</span><span class="meta">line</span>';
    div.onclick = () => { state.sequence.push(transitTokenFor(line.id, null)); refresh(); };
    el.appendChild(div);
  });
}
function lastLocation() {
  // use the actual exit chosen during simulation (handles multi-access shops)
  if (state.steps.length) {
    const ex = state.steps[state.steps.length - 1].exitNodeId;
    if (ex && state.nodes.has(ex)) return ex;
  }
  if (state.sequence.length) {
    const last = state.attractions.get(state.sequence[state.sequence.length - 1]);
    if (last && last.exitNodeId && state.nodes.has(last.exitNodeId)) return last.exitNodeId;
  }
  return startNode();
}

/* ---------- UI: sequence list w/ drag reorder --------------------------- */
let dragIdx = null;
function renderSeq() {
  const el = document.getElementById("seqList");
  el.innerHTML = "";
  seqHighlightIdx = -1;   // list rebuilt — let the animation re-apply the active highlight
  if (!state.sequence.length) {
    el.innerHTML = '<div class="empty-hint">Click attractions on the left to build your day &rarr;</div>';
    return;
  }
  state.sequence.forEach((id, i) => {
    // explicitly-scheduled transit ride: line name + alight-stop dropdown
    if (isTransitToken(id)) {
      const p = parseTransitToken(id);
      const line = (state.transport || []).find(l => l.id === p.lineId);
      const step = state.steps[i] && state.steps[i].category === "transit" ? state.steps[i] : null;
      const div = document.createElement("div");
      div.className = "seq-item transit-item"; div.draggable = true; div.dataset.idx = i;
      const lineName = line ? (line.name || line.id) : p.lineId;
      const stopNodes = line ? lineStops(line).map(s => s.node) : [];
      let sel = '<select class="dur alight" title="Get off at"><option value="">auto</option>';
      stopNodes.forEach(s => { sel += '<option value="' + esc(s) + '"' + (p.alight === s ? " selected" : "") + '>' + esc(stopName(s)) + '</option>'; });
      sel += '</select>';
      const dest = step ? stopName(step.alight) : (p.alight ? stopName(p.alight) : "auto");
      div.innerHTML = '<span class="idx" title="Tap to change position">' + (i + 1) + '</span>' +
        '<span class="nm">🚂 ' + esc(lineName) + ' <span class="meta">→ ' + esc(dest) + '</span></span>' +
        sel + '<span class="rm" title="Remove">&#10005;</span>';
      div.querySelector(".rm").onclick = (e) => { e.stopPropagation(); state.sequence.splice(i, 1); refresh(); };
      div.querySelector(".idx").onclick = (e) => { e.stopPropagation(); moveSeqItem(i); };
      const selEl = div.querySelector("select.alight");
      selEl.draggable = false;
      selEl.onpointerdown = (e) => e.stopPropagation();
      selEl.onclick = (e) => e.stopPropagation();
      selEl.onchange = () => { state.sequence[i] = transitTokenFor(p.lineId, selEl.value || null); refresh(); };
      wireSeqDrag(div, i);
      el.appendChild(div);
      return;
    }
    const a = state.attractions.get(id);
    const div = document.createElement("div");
    div.className = "seq-item"; div.draggable = true; div.dataset.idx = i;
    const cat = a ? attrCat(a) : "ride";
    // editable field: dwell time for shops/restaurants/restrooms/pins/other, wait for rides
    let fieldHtml = "";
    if (a && (cat === "restaurant" || cat === "shop" || cat === "restroom" || cat === "other" || cat === "pin")) {
      fieldHtml = '<input class="dur" data-kind="dur" type="number" min="0" step="5" inputmode="numeric" value="' + attrDuration(a) + '" title="Minutes you\'ll spend here"><span class="durunit">min</span>';
    } else if (a && cat === "ride") {
      const step = (state.steps[i] && state.steps[i].attractionId === id) ? state.steps[i] : null;
      const w = (typeof a.waitOverride === "number") ? a.waitOverride : (step ? Math.round(step.wait) : 0);
      const ovr = (typeof a.waitOverride === "number") ? " ovr" : "";
      fieldHtml = '<input class="dur wait' + ovr + '" data-kind="wait" type="number" min="0" step="5" inputmode="numeric" value="' + w + '" title="Wait minutes — overrides live/avg; clear to reset"><span class="durunit">wait</span>';
    }
    div.innerHTML = '<span class="idx" title="Tap to change position">' + (i + 1) + '</span><span class="nm">' +
      esc(a ? a.name : id) + '</span>' + fieldHtml + '<span class="rm" title="Remove">&#10005;</span>';
    div.querySelector(".rm").onclick = (e) => { e.stopPropagation(); state.sequence.splice(i, 1); refresh(); };
    // tap the number to move it (works on touch where drag doesn't)
    div.querySelector(".idx").onclick = (e) => { e.stopPropagation(); moveSeqItem(i); };
    const durEl = div.querySelector(".dur");
    if (durEl) {
      durEl.draggable = false;
      durEl.onpointerdown = (e) => e.stopPropagation();   // don't start a drag from the field
      durEl.onclick = (e) => e.stopPropagation();
      durEl.onchange = () => {                              // commit on blur/Enter, then recompute
        const raw = durEl.value.trim();
        if (durEl.dataset.kind === "wait") {
          if (raw === "") delete a.waitOverride;            // blank clears the override
          else { let v = parseInt(raw, 10); a.waitOverride = (isNaN(v) || v < 0) ? 0 : v; }
        } else {
          let v = parseInt(raw, 10);
          a.rideDuration = (isNaN(v) || v < 0) ? 0 : v;
        }
        refresh();
      };
    }
    wireSeqDrag(div, i);
    el.appendChild(div);
  });
}
// Drag-to-reorder wiring shared by attraction and transit sequence items.
function wireSeqDrag(div, i) {
  div.addEventListener("dragstart", () => { dragIdx = i; div.classList.add("dragging"); });
  div.addEventListener("dragend", () => {
    div.classList.remove("dragging");
    document.querySelectorAll(".seq-item").forEach(x => x.classList.remove("drop-target"));
  });
  div.addEventListener("dragover", e => { e.preventDefault(); div.classList.add("drop-target"); });
  div.addEventListener("dragleave", () => div.classList.remove("drop-target"));
  div.addEventListener("drop", e => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === i) return;
    const m = state.sequence.splice(dragIdx, 1)[0];
    state.sequence.splice(i, 0, m);
    dragIdx = null; refresh();
  });
  div.addEventListener("click", () => selectStep(i));   // tap a stop to highlight its leg + marker
}
// Select (or toggle off) a sequence stop: highlights its walk-to leg and
// attraction on the map, and marks its list row.
function selectStep(i) {
  selectedStep = (selectedStep === i) ? null : i;
  document.querySelectorAll("#seqList .seq-item.selected").forEach(x => x.classList.remove("selected"));
  if (selectedStep !== null) {
    const item = document.querySelector('#seqList .seq-item[data-idx="' + selectedStep + '"]');
    if (item) { item.classList.add("selected"); item.scrollIntoView({ block: "nearest" }); }
  }
  draw();
}
function clearSelection() {
  selectedStep = null;
  document.querySelectorAll("#seqList .seq-item.selected").forEach(x => x.classList.remove("selected"));
}
// Move the selection to the previous/next stop (delta -1 / +1).
function moveSelection(delta) {
  if (selectedStep === null) return;
  const j = selectedStep + delta;
  if (j < 0 || j >= state.sequence.length) return;
  selectedStep = j;
  document.querySelectorAll("#seqList .seq-item.selected").forEach(x => x.classList.remove("selected"));
  const item = document.querySelector('#seqList .seq-item[data-idx="' + j + '"]');
  if (item) { item.classList.add("selected"); item.scrollIntoView({ block: "nearest" }); }
  draw();
}
// Prompt for a new 1-based position and move the item there (touch-friendly).
function moveSeqItem(i) {
  const n = state.sequence.length;
  const seqId = state.sequence[i];
  const a = state.attractions.get(seqId);
  let label = a ? a.name : seqId;
  if (isTransitToken(seqId)) { const l = (state.transport || []).find(x => x.id === parseTransitToken(seqId).lineId); label = l ? (l.name || l.id) : seqId; }
  const ans = prompt('Move "' + label + '" to position (1–' + n + '):', String(i + 1));
  if (ans == null) return;
  let pos = parseInt(ans, 10);
  if (isNaN(pos)) return;
  pos = Math.max(1, Math.min(n, pos)) - 1;   // clamp to range, 0-based
  if (pos === i) return;
  const m = state.sequence.splice(i, 1)[0];
  state.sequence.splice(pos, 0, m);
  refresh();
}

/* ---------- UI: timeline ------------------------------------------------ */
function renderTimeline() {
  const el = document.getElementById("timeline");
  el.innerHTML = "";
  if (!state.steps.length) { el.innerHTML = '<div class="empty-hint">No steps yet.</div>'; return; }
  const maxSpan = Math.max.apply(null, state.steps.map(s => s.total).concat([1]));
  state.steps.forEach((s, i) => {
    const box = document.createElement("div");
    box.className = "tl-step";
    const warn = s.reachable ? "" : ' <span style="color:#ff8a8a">(no path!)</span>';
    const meta = catMeta(s.category);
    // the "get there" leg may be plain walking or walk + transit (rail/ferry),
    // laid out in route order across walkStart..walkEnd.
    const tl = (s.travelLegs && s.travelLegs.length) ? s.travelLegs : [{ kind: "walk", px: s.distPx }];
    const lastWalkIdx = tl.map(x => x.kind).lastIndexOf("walk");
    const defs = [];
    let cur = s.walkStart;
    tl.forEach((t, ti) => {
      if (t.kind === "transit") {
        const d = (t.rideMin || 0) + (t.boardMin || 0);
        const note = t.boardMin ? " (" + Math.round(t.boardMin) + "m wait)" : "";
        defs.push({ cls: "transit", phase: "transit", lbl: "🚂 " + t.lineName + " to " + stopName(t.toStop) + note, dur: d, a: cur, b: cur + d });
        cur += d;
      } else {
        const d = walkTimeMin(t.px);
        // for a transit step the final walk is "to the boarding stop", not the line label
        const destName = (s.category === "transit") ? stopName(s.entranceNodeId) : s.name;
        const lbl = (ti === lastWalkIdx) ? "Walk to " + destName : "Walk";
        defs.push({ cls: "walk", phase: "walk", lbl: lbl, dur: d, a: cur, b: cur + d, distFt: stepFeet(t.px) });
        cur += d;
      }
    });
    if (s.category === "ride") defs.push({ cls: "wait", phase: "wait", lbl: "Wait for " + s.name, dur: s.wait, a: s.waitStart, b: s.waitEnd });
    if (s.category !== "transit") defs.push({ cls: meta.cls, phase: "ride", lbl: meta.verb + s.name, dur: s.ride, a: s.rideStart, b: s.rideEnd });
    const rows = defs.map(d => {
      const wpct = Math.max(4, (d.dur / maxSpan) * 120);
      const dist = (typeof d.distFt === "number") ? ' &middot; ' + fmtFeet(d.distFt) : '';
      return '<div class="tl-row ' + d.cls + '" data-step="' + i + '" data-phase="' + d.phase + '">' +
        '<span class="bar" style="width:' + wpct + 'px"></span>' +
        '<span class="lbl">' + esc(d.lbl) + ' <b>' + fmtDur(d.dur) + '</b>' + dist + '</span>' +
        '<span class="tm">' + minToHM(d.a) + '&ndash;' + minToHM(d.b) + '</span></div>';
    }).join("");
    box.innerHTML = '<div class="tl-head"><span>' + (i + 1) + '. ' + esc(s.name) + warn +
      '</span><span class="tot">' + fmtDur(s.total) + '</span></div>' + rows;
    el.appendChild(box);
  });
}

function renderSummary() {
  const el = document.getElementById("summary");
  if (!state.steps.length) { el.innerHTML = '<div class="row">Add attractions to see totals.</div>'; return; }
  const last = state.steps[state.steps.length - 1];
  const totWalk = state.steps.reduce((s, x) => s + (typeof x.walkOnly === "number" ? x.walkOnly : x.walk), 0);
  const totTransit = state.steps.reduce((s, x) => s + (x.transitRide || 0) + (x.transitBoard || 0), 0);
  const totWait = state.steps.reduce((s, x) => s + x.wait, 0);
  const totRide = state.steps.reduce((s, x) => s + x.ride, 0);
  const totFt = state.steps.reduce((s, x) => s + stepFeet(x.distPx), 0);
  const grand = totWalk + totTransit + totWait + totRide;
  el.innerHTML =
    '<div class="big">' + fmtDur(grand) + ' total</div>' +
    '<div class="row"><span>Finish time</span><span>' + minToHM(last.rideEnd) + '</span></div>' +
    '<div class="row"><span style="color:var(--walk)">Walking</span><span>' + fmtDur(totWalk) + ' &middot; ' + fmtDist(totFt) + '</span></div>' +
    (totTransit > 0 ? '<div class="row"><span style="color:var(--transit)">Transit</span><span>' + fmtDur(totTransit) + '</span></div>' : '') +
    '<div class="row"><span style="color:var(--wait)">Waiting</span><span>' + fmtDur(totWait) + '</span></div>' +
    '<div class="row"><span style="color:var(--ride)">Riding</span><span>' + fmtDur(totRide) + '</span></div>' +
    '<div class="row"><span>Attractions</span><span>' + state.steps.length + '</span></div>';
}

// Finish-time clock pinned to the top-left of the map (no scrolling to totals).
function updateEndClock() {
  const el = document.getElementById("endClock");
  if (!el) return;
  if (!state.steps.length) { el.style.display = "none"; return; }
  const finish = state.steps[state.steps.length - 1].rideEnd;
  el.style.display = "block";
  el.innerHTML = '<div class="lbl">ends</div><div class="tm">' + t12(finish) + '</div>';
}

/* ---------- Master refresh ---------------------------------------------- */
function refresh() {
  selectedStep = null;   // the list is about to rebuild; drop any tap-selection
  computeSequence();
  renderAttrList();
  renderSeq();
  renderTimeline();
  renderSummary();
  updateEndClock();
  renderLLPanel();
  draw();
}

/* ---------- Animation --------------------------------------------------- */
let animRAF = null, animClock = 0, playing = false, activeStepIndex = -1, lastFrameTime = 0;
let seqHighlightIdx = -1;   // which sequence item is currently highlighted (avoids re-scrolling every frame)

// Highlight the current stop in the sequence list and keep it scrolled into
// view. Only acts when the active step changes, so it doesn't fight the user's
// scroll or re-run every animation frame. stepI < 0 clears the highlight.
function highlightSeqStep(stepI) {
  if (stepI === seqHighlightIdx) return;
  seqHighlightIdx = stepI;
  const list = document.getElementById("seqList");
  if (!list) return;
  list.querySelectorAll(".seq-item.active").forEach(x => x.classList.remove("active"));
  if (stepI < 0) return;
  const item = list.querySelector('.seq-item[data-idx="' + stepI + '"]');
  if (!item) return;
  item.classList.add("active");
  // scroll the list container only (never the page), centering the active item
  const lr = list.getBoundingClientRect(), ir = item.getBoundingClientRect();
  list.scrollTop += (ir.top - lr.top) - (list.clientHeight - item.clientHeight) / 2;
}

function simSpanMin() {
  if (!state.steps.length) return 0;
  return state.steps[state.steps.length - 1].rideEnd - state.steps[0].walkStart;
}

function play() {
  if (!state.steps.length) return;
  clearSelection();   // drop any tap-selection highlight before animating
  playing = true;
  document.getElementById("playBtn").textContent = "⏸ Pause";
  if (animClock >= simSpanMin() - 0.001) animClock = 0;
  lastFrameTime = 0;
  animRAF = requestAnimationFrame(frame);
}
function pause() {
  playing = false;
  document.getElementById("playBtn").textContent = "▶ Resume";
  if (animRAF) cancelAnimationFrame(animRAF);
  stopAudio();
}
function stop() {
  playing = false; animClock = 0; activeStepIndex = -1;
  if (animRAF) cancelAnimationFrame(animRAF);
  stopAudio();
  document.getElementById("playBtn").textContent = "▶ Play";
  document.getElementById("nowPlaying").classList.remove("show");
  document.querySelectorAll(".tl-row").forEach(r => r.style.background = "");
  document.querySelectorAll(".seq-item.active").forEach(r => r.classList.remove("active"));
  seqHighlightIdx = -1;
  draw();
}

// ---- animation audio: loop a location's clip while the avatar is there ----
let audioOn = localStorage.getItem("ridesim.audio") !== "0";   // default on
let audioEl = null, audioStep = -1;
function stopAudio() { if (audioEl) { try { audioEl.pause(); } catch (e) {} } audioEl = null; audioStep = -1; }
function setStepAudio(stepI, phase) {
  // play during the dwell/ride phase of a location that defines an audio clip
  let want = -1, url = "";
  if (audioOn && stepI >= 0 && phase === "ride") {
    const a = state.attractions.get(state.steps[stepI].attractionId);
    if (a && a.audio) { want = stepI; url = a.audio; }
  }
  if (want === audioStep) return;          // already in the desired state
  stopAudio();
  audioStep = want;
  if (want >= 0) { audioEl = new Audio(url); audioEl.loop = true; audioEl.play().catch(() => {}); }
}

function frame(ts) {
  if (!lastFrameTime) lastFrameTime = ts;
  const dtSec = (ts - lastFrameTime) / 1000;
  lastFrameTime = ts;
  let speed = parseFloat(document.getElementById("animSpeed").value);
  // on Slow/Normal, stretch an animated ride (~8s) or an audio stop (~12s) to a
  // consistent real-time window so the spin/track is watchable and the clip audible
  if (speed === 3 || speed === 8) {
    const st = currentStretch(animClock);
    if (st) speed = Math.min(speed, st.ride / st.target);
  }
  animClock += dtSec * speed;

  const span = simSpanMin();
  if (animClock >= span) { animClock = span; renderAnimAt(animClock); stop(); return; }
  renderAnimAt(animClock);
  if (playing) animRAF = requestAnimationFrame(frame);
}
const RIDE_ANIM_SEC = 8;    // target real-time length of an animated ride
const AUDIO_SEC = 12;       // target real-time length of an audio stop (so the clip is audible)
// For the dwell the clock is in, return { ride, target } when it should be
// stretched (has audio, or a ride with spin/track), else null.
function currentStretch(clock) {
  if (!state.steps.length) return null;
  const absT = state.steps[0].walkStart + clock;
  for (const s of state.steps) {
    if (s.ride > 0 && absT >= s.rideStart && absT < s.rideEnd) {
      const a = state.attractions.get(s.attractionId);
      if (audioOn && a && a.audio) return { ride: s.ride, target: AUDIO_SEC };
      const hasAnim = s.category === "ride" && (RIDE_SPIN[s.attractionId] || (a && Array.isArray(a.track) && a.track.length >= 2));
      return hasAnim ? { ride: s.ride, target: RIDE_ANIM_SEC } : null;
    }
  }
  return null;
}

// Hard-coded "spin" animations: the avatar orbits the ride's icon during the
// ride. dir: 1 = clockwise, -1 = counter-clockwise. seg > 0 steps in N equal
// segments (e.g. the rotating theater). loops = laps over the ride for a smooth
// orbit (default 5; higher = faster spin). type "epi" = spirograph: the avatar
// rides a small circle whose centre revolves on the big circle (revs = big
// turns over the ride, spins = small turns per big turn).
const RIDE_SPIN = {
  aladdin:              { dir: 1,  seg: 0 },
  dumbo:                { dir: 1,  seg: 0 },
  carousel:             { dir: 1,  seg: 0 },
  astro_orbiter:        { dir: 1,  seg: 0 },
  mission_space:        { dir: 1,  seg: 0, loops: 8 },   // centrifuge — spins faster than carousel/dumbo (5)
  carousel_of_progress: { dir: -1, seg: 6, rPxOverride: 24, rPxMobile: 10 },
  teacups:              { type: "epi", dir: 1, revs: 5, spins: 6 }
};

// Avatar carries a persistent size through the animation: each restaurant visit
// grows it 10%, each restroom shrinks it 10%, and the effect compounds — 20
// restaurants make it huge, 20 restrooms make it tiny.
function avatarFactor(cat) { return cat === "restaurant" ? 1.1 : cat === "restroom" ? 0.9 : 1; }
function persistentScaleBefore(stepIndex) {
  let p = 1;
  for (let i = 0; i < stepIndex && i < state.steps.length; i++) p *= avatarFactor(state.steps[i].category);
  return p;
}

function renderAnimAt(clock) {
  const base = state.steps[0].walkStart;
  const absT = base + clock;
  let marker = null, phase = "", stepI = -1, info = "";

  for (let i = 0; i < state.steps.length; i++) {
    const s = state.steps[i];
    if (absT < s.walkEnd) {
      stepI = i; phase = "walk";
      const frac = s.walk > 0 ? (absT - s.walkStart) / s.walk : 1;
      const p = pointAlong(s.routeCoords, frac);
      // on a transit segment? (spans are length-fractions of the drawn route)
      const span = (s.transitSpans || []).find(sp => frac >= sp.a && frac <= sp.b);
      marker = { x: p.x, y: p.y, stroke: span ? TRANSIT_COLOR : "#5cc8ff", scale: persistentScaleBefore(i) };
      info = span ? ("🚂 " + span.lineName + " → " + stopName(span.toStop)) : ("Walking to " + s.name);
      break;
    } else if (absT < s.waitEnd) {
      stepI = i; phase = "wait";
      const ent = state.nodes.get(s.entranceNodeId);
      marker = { x: ent.x, y: ent.y, stroke: "#ff8a5c", scale: persistentScaleBefore(i) };
      info = "Waiting for " + s.name + " — " + Math.round(absT - s.waitStart) + "/" + Math.round(s.wait) + " min";
      break;
    } else if (absT < s.rideEnd) {
      stepI = i; phase = "ride";
      const a = state.attractions.get(s.attractionId);
      const meta = catMeta(s.category);
      const spin = RIDE_SPIN[s.attractionId];
      const disp = (a && a.displayLocation) || state.nodes.get(s.entranceNodeId);
      const strokeColor = s.category === "ride" ? waitColor(5) : meta.color;  // rides: 5-min-wait green
      // Persistent size compounds across the day. At a restaurant/restroom the
      // change animates in over the dwell so the new size carries forward; rides
      // shrink to half their current size (a transient effect during the ride).
      const pBase = persistentScaleBefore(i);
      let rideScale;
      if (s.category === "restaurant" || s.category === "restroom") {
        const g = s.ride > 0 ? Math.max(0, Math.min(1, (absT - s.rideStart) / s.ride)) : 1;
        rideScale = pBase * (1 + (avatarFactor(s.category) - 1) * g);
      } else if (s.category === "ride") {
        rideScale = pBase * 0.5;
      } else {
        rideScale = pBase;  // shops/pins: no size change
      }
      if (spin && disp && s.ride > 0) {
        const scale = view.scale || 1;
        const frac = Math.max(0, Math.min(0.999, (absT - s.rideStart) / s.ride));
        const TAU = 2 * Math.PI, top = -Math.PI / 2;
        if (spin.type === "epi") {
          // spirograph: small circle rides a point on the big revolving circle
          const Rbig = attrSize().r / scale, rSmall = 6 / scale;
          const bigAng = top + spin.dir * frac * TAU * spin.revs;
          const smallAng = top + spin.dir * frac * TAU * spin.revs * spin.spins;
          marker = { x: disp.x + Rbig * Math.cos(bigAng) + rSmall * Math.cos(smallAng),
                     y: disp.y + Rbig * Math.sin(bigAng) + rSmall * Math.sin(smallAng), stroke: strokeColor, scale: rideScale };
        } else {
          // orbit the avatar around the icon's circumference (no overlap)
          let f = frac;
          if (spin.seg > 0) f = Math.floor(f * spin.seg) / spin.seg;  // step in N segments
          const loops = spin.seg > 0 ? 1 : (spin.loops || 5);          // smooth orbits do 5 laps (spin.loops overrides)
          const ang = top + spin.dir * f * TAU * loops;
          // default: just inside the rim; some rides pin a fixed radius, with a
          // smaller value on mobile where the icon is smaller.
          const rPx = (mobileMQ.matches && spin.rPxMobile) ? spin.rPxMobile
            : spin.rPxOverride ? spin.rPxOverride
            : (attrSize().r - 4);
          const rMap = rPx / scale;
          marker = { x: disp.x + rMap * Math.cos(ang), y: disp.y + rMap * Math.sin(ang), stroke: strokeColor, scale: rideScale };
        }
      } else if (a && Array.isArray(a.track) && a.track.length >= 2 && s.ride > 0) {
        // follow the ride track over the ride duration
        const frac = (absT - s.waitEnd) / s.ride;
        const p = pointAlong(a.track, frac);
        marker = { x: p.x, y: p.y, stroke: strokeColor, scale: rideScale };
      } else {
        marker = { x: disp.x, y: disp.y, stroke: strokeColor, scale: rideScale };
      }
      info = meta.anim + s.name;
      break;
    }
  }
  if (stepI < 0) {
    const s = state.steps[state.steps.length - 1];
    const ex = state.nodes.get(s.exitNodeId);
    marker = { x: ex.x, y: ex.y, stroke: "#5fd38a", scale: persistentScaleBefore(state.steps.length) };
    phase = "done"; info = "Day complete!";
  }
  activeStepIndex = stepI;
  draw(marker);

  const np = document.getElementById("nowPlaying");
  np.classList.add("show");
  const stepCat = stepI >= 0 ? state.steps[stepI].category : "ride";
  const meta = catMeta(stepCat);
  const colors = { walk: "var(--walk)", wait: "var(--wait)", ride: meta.barVar, done: "var(--good)" };
  const labels = { walk: "WALK", wait: "WAIT", ride: meta.phase, done: "DONE" };
  const onTransit = phase === "walk" && /^🚂/.test(info);   // riding the rail/ferry, not walking
  const badgeColor = onTransit ? "var(--transit)" : colors[phase];
  const badgeLabel = onTransit ? "TRANSIT" : labels[phase];
  np.innerHTML = '<span class="badge" style="background:' + badgeColor + ';color:#0f1420">' +
    badgeLabel + '</span><span>' + esc(info) + '</span>' +
    '<span style="color:var(--muted)">🕐 ' + minToHM(absT) + '</span>';

  // highlight active timeline row (match by phase — rows now vary with transit)
  document.querySelectorAll(".tl-row").forEach(r => r.style.background = "");
  if (stepI >= 0) {
    const row = document.querySelector('.tl-row[data-step="' + stepI + '"][data-phase="' + phase + '"]');
    if (row) row.style.background = "rgba(92,200,255,0.14)";
  }
  highlightSeqStep(stepI);   // mark + scroll the current stop in the sequence list
  setStepAudio(stepI, phase);
}

// position along polyline by fraction of total length
function pointAlong(coords, frac) {
  if (!coords || !coords.length) return { x: 0, y: 0 };
  if (coords.length === 1) return { x: coords[0].x, y: coords[0].y };
  frac = Math.max(0, Math.min(1, frac));
  let total = 0; const segs = [];
  for (let i = 0; i < coords.length - 1; i++) { const d = dist(coords[i], coords[i + 1]); segs.push(d); total += d; }
  if (total === 0) return { x: coords[0].x, y: coords[0].y };
  let target = frac * total, acc = 0;
  for (let i = 0; i < segs.length; i++) {
    if (acc + segs[i] >= target) {
      const f = segs[i] === 0 ? 0 : (target - acc) / segs[i];
      return {
        x: coords[i].x + (coords[i + 1].x - coords[i].x) * f,
        y: coords[i].y + (coords[i + 1].y - coords[i].y) * f
      };
    }
    acc += segs[i];
  }
  const last = coords[coords.length - 1];
  return { x: last.x, y: last.y };
}

/* ---------- Export ------------------------------------------------------ */
function exportPlan() {
  if (!state.steps.length) { alert("Add attractions first."); return; }
  const startMin = hmToMin(document.getElementById("startTime").value || "09:00");
  const totWalk = state.steps.reduce((a, x) => a + x.walk, 0);
  const totWait = state.steps.reduce((a, x) => a + x.wait, 0);
  const totRide = state.steps.reduce((a, x) => a + x.ride, 0);
  const totFt = state.steps.reduce((a, x) => a + stepFeet(x.distPx), 0);
  const finish = state.steps[state.steps.length - 1].rideEnd;

  const html = itineraryHtml(startMin, finish, totWalk, totWait, totRide, totFt, planText(), planLink());
  const w = window.open("", "_blank");
  if (w) { w.document.open(); w.document.write(html); w.document.close(); }
  else download("mk-itinerary.html", html, "text/html");   // popup blocked -> save instead
}

// 12-hour time for the human-facing itinerary (the app UI itself stays 24h).
function t12(min) {
  min = Math.round(min);
  let h = Math.floor(min / 60) % 24; const m = ((min % 60) + 60) % 60;
  const ap = h < 12 ? "AM" : "PM"; let hh = h % 12; if (hh === 0) hh = 12;
  return hh + ":" + String(m).padStart(2, "0") + " " + ap;
}
const CAT_ICON = { ride: "🎢", restaurant: "🍽", shop: "🛍", pin: "📍", restroom: "🚻", other: "⏱", transit: "🚂" };
// A clean, printable HTML day plan (own document so print/Save-PDF is native).
function itineraryHtml(startMin, finish, totWalk, totWait, totRide, totFt, planStr, linkStr) {
  const steps = state.steps.map((s, i) => {
    const ic = CAT_ICON[s.category] || "🎢";
    const warn = s.reachable ? "" : ' <span class="warn">no path</span>';
    let rows = '<div class="row"><span class="t">' + t12(s.walkStart) + '</span>Walk · ' +
      fmtDur(s.walk) + ' · ' + fmtFeet(stepFeet(s.distPx)) + '</div>';
    if (s.category === "ride" && s.wait > 0)
      rows += '<div class="row"><span class="t">' + t12(s.waitStart) + '</span>Wait · ' + fmtDur(s.wait) + '</div>';
    if (s.ride > 0)
      rows += '<div class="row"><span class="t">' + t12(s.rideStart) + '</span>' + catMeta(s.category).short + ' · ' + fmtDur(s.ride) + '</div>';
    return '<div class="step"><div class="head"><span class="n">' + (i + 1) + '</span>' +
      '<span class="ic">' + ic + '</span><span class="nm">' + esc(s.name) + warn + '</span>' +
      '<span class="span">' + t12(s.walkStart) + ' – ' + t12(s.rideEnd) + '</span></div>' +
      '<div class="rows">' + rows + '</div></div>';
  }).join("");

  const totals = '<div class="totals">' +
    '<div class="grand">' + fmtDur(totWalk + totWait + totRide) + ' total · finish ' + t12(finish) + '</div>' +
    '<div class="tline"><span>🚶 Walking</span><span>' + fmtDur(totWalk) + ' · ' + fmtDist(totFt) + '</span></div>' +
    '<div class="tline"><span>⏳ Waiting</span><span>' + fmtDur(totWait) + '</span></div>' +
    '<div class="tline"><span>🎢 Doing</span><span>' + fmtDur(totRide) + '</span></div>' +
    '<div class="tline"><span>📍 Stops</span><span>' + state.steps.length + '</span></div></div>';

  const css = 'body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a2233;background:#f4f6fb;margin:0;padding:24px;}' +
    '.wrap{max-width:680px;margin:0 auto;}h1{font-size:20px;margin:0 0 2px;}' +
    '.sub{color:#6b7687;font-size:13px;margin:0 0 16px;}' +
    '.btns{display:flex;gap:8px;margin:0 0 18px;flex-wrap:wrap;}' +
    '.btns a,.btns button{font:inherit;font-size:13px;padding:7px 12px;border-radius:8px;border:1px solid #c7d0e0;background:#fff;color:#1a2233;cursor:pointer;text-decoration:none;}' +
    '.btns .pri{background:#2b6cff;border-color:#2b6cff;color:#fff;}' +
    '.step{background:#fff;border:1px solid #e1e7f2;border-radius:12px;padding:12px 14px;margin:0 0 10px;}' +
    '.head{display:flex;align-items:center;gap:8px;}' +
    '.head .n{width:22px;height:22px;border-radius:50%;background:#2b6cff;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex:none;}' +
    '.head .ic{font-size:16px;}.head .nm{flex:1;font-weight:600;}.head .span{color:#6b7687;font-size:12px;white-space:nowrap;}' +
    '.warn{color:#c0392b;font-size:11px;font-weight:600;}' +
    '.rows{margin:8px 0 0;padding:0 0 0 30px;}' +
    '.row{color:#3a4860;font-size:13px;display:flex;gap:8px;}' +
    '.row .t{color:#8a96aa;width:64px;flex:none;font-variant-numeric:tabular-nums;}' +
    '.totals{background:#1a2233;color:#fff;border-radius:12px;padding:14px 16px;margin-top:14px;}' +
    '.totals .grand{font-size:17px;font-weight:700;margin-bottom:6px;}' +
    '.tline{display:flex;justify-content:space-between;color:#c7d0e0;font-size:13px;margin-top:3px;}' +
    '@media print{.btns{display:none;}body{background:#fff;padding:0;}.step,.totals{break-inside:avoid;}}';
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + SAMPLE.meta.name + ' — Day Plan</title><style>' + css + '</style></head><body><div class="wrap">' +
    '<h1>' + SAMPLE.meta.emoji + ' ' + SAMPLE.meta.name + ' — Day Plan</h1>' +
    '<p class="sub">Starts ' + t12(startMin) + ' · ' + state.steps.length + ' stops · finishes ' + t12(finish) + '</p>' +
    '<div class="btns"><button class="pri" onclick="window.print()">🖨 Print / Save PDF</button>' +
    '<button id="linkbtn" onclick="copyLink()">🔗 Copy link</button>' +
    '<button id="copybtn" onclick="copyPlan()">📋 Copy plan</button></div>' +
    steps + totals +
    '<textarea id="plansrc" readonly style="position:absolute;left:-9999px;top:0">' + esc(planStr) + '</textarea>' +
    '<textarea id="linksrc" readonly style="position:absolute;left:-9999px;top:0">' + esc(linkStr || "") + '</textarea>' +
    '</div><script>function copyFrom(srcId,btnId,label){var t=document.getElementById(srcId);t.focus();t.select();t.setSelectionRange(0,99999);try{document.execCommand("copy");}catch(e){}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t.value);}var b=document.getElementById(btnId),o=b.textContent;b.textContent=label;setTimeout(function(){b.textContent=o;},1800);}function copyPlan(){copyFrom("plansrc","copybtn","\\u2713 Copied — paste into Data \\u25b8 Plan");}function copyLink(){copyFrom("linksrc","linkbtn","\\u2713 Link copied");}</script></body></html>';
}
function download(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Data modal -------------------------------------------------- */
const HINTS = {
  plan: 'Your plan as one stop per line, in order. Paste a ride-name list to load it (names matched loosely). Transit rides: "🚂 LineName → Stop".',
  nodes: 'Array of { id, name?, isAttraction, x, y } — node coordinates in pixels.',
  connections: 'Array of { from, to:[...] }, or { from, to:"id", points:[{x,y}...] } for a polyline edge (length follows the polyline).',
  attractions: 'Array of { id, name, entranceNodeId, exitNodeId, displayLocation:{x,y}, rideDuration, category?, closed?, hoverText?, avgWait?, thpwId?, track?, audio? }. category ride|restaurant|shop|pin|restroom|other (default ride); only rides queue. "other" is a generic timed stop (default 5-min dwell, editable). thpwId = ThemeParks.wiki GUID matching live standby waits + Lightning Lane (else matched by name). avgWait = typical wait (min) used for timing when live is off. closed true = gray. hoverText shows on map hover. track = [{x,y}...] ride path; marker animates along it. audio = URL/file looped while the avatar is at this stop during animation.',
  waits: 'Tab-delimited: attraction_id  time_of_day(HH:MM)  avg_wait_minutes. Linearly interpolated.'
};
function openModal() {
  document.getElementById("ta-plan").value = planText();
  document.getElementById("ta-nodes").value = JSON.stringify(currentNodesArray(), null, 2);
  document.getElementById("ta-connections").value = JSON.stringify(currentConnArray(), null, 2);
  document.getElementById("ta-attractions").value = JSON.stringify(Array.from(state.attractions.values()), null, 2);
  document.getElementById("ta-waits").value = currentWaitsTSV();
  document.getElementById("modalMsg").textContent = "";
  document.getElementById("modalBg").classList.add("show");
  setPaneHint();
}
function setPaneHint() {
  const active = document.querySelector(".tab.active").dataset.tab;
  document.getElementById("paneHint").textContent = HINTS[active];
}
function currentNodesArray() { return Array.from(state.nodes.values()); }
function currentConnArray() {
  // Edges with geometry are emitted individually with their points; plain
  // straight edges are grouped by `from` for compactness.
  const seen = new Set(), grouped = new Map(), geom = [];
  state.adj.forEach((edges, id) => {
    edges.forEach(e => {
      const key = id < e.to ? id + "|" + e.to : e.to + "|" + id;
      if (seen.has(key)) return; seen.add(key);
      if (e.points && e.points.length >= 2) {
        geom.push({ from: id, to: e.to, points: e.points.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })) });
      } else {
        if (!grouped.has(id)) grouped.set(id, []);
        grouped.get(id).push(e.to);
      }
    });
  });
  const out = [];
  grouped.forEach((tos, from) => out.push({ from, to: tos }));
  geom.forEach(g => out.push(g));
  return out;
}
function currentWaitsTSV() {
  const lines = ["attraction_id\ttime_of_day\tavg_wait_minutes"];
  state.waits.forEach((arr, id) => arr.forEach(p => lines.push(id + "\t" + minToHM(p.t) + "\t" + p.w)));
  return lines.join("\n");
}
function applyData() {
  const activeTab = document.querySelector(".tab.active").dataset.tab;
  if (activeTab === "plan") { applyPlan(); return; }   // the Plan tab loads a sequence, not park data
  const msg = document.getElementById("modalMsg");
  try {
    const nodes = JSON.parse(document.getElementById("ta-nodes").value);
    const conns = JSON.parse(document.getElementById("ta-connections").value);
    const attrs = JSON.parse(document.getElementById("ta-attractions").value);
    const waits = document.getElementById("ta-waits").value;
    if (!Array.isArray(nodes) || !Array.isArray(conns) || !Array.isArray(attrs))
      throw new Error("Nodes, connections, attractions must be JSON arrays.");
    buildFromData(nodes, conns, attrs, waits, SAMPLE.transport);   // transport isn't editable in the modal; keep the park's lines
    state.sequence = state.sequence.filter(id => state.attractions.has(id));
    stop();
    computeView(); refresh();
    msg.className = "ok";
    msg.textContent = "✓ Loaded " + nodes.length + " nodes, " + attrs.length + " attractions.";
  } catch (e) {
    msg.className = "err"; msg.textContent = "Error: " + e.message;
  }
}

/* ---------- Plan as a portable name list (copy / paste) ----------------- */
// The plan IS the sequence. Render it as one human name per line, in order, so
// it can be copied out and pasted back. Transit rides: "🚂 Line → Stop".
function planText() {
  const startMin = hmToMin(document.getElementById("startTime").value || "09:00");
  const header = "Start: " + t12(startMin);   // round-trips the chosen start time
  const lines = state.sequence.map(id => {
    if (isTransitToken(id)) {
      const p = parseTransitToken(id);
      const line = (state.transport || []).find(l => l.id === p.lineId);
      const nm = line ? (line.name || line.id) : p.lineId;
      return "🚂 " + nm + (p.alight ? " → " + stopName(p.alight) : "");
    }
    const a = state.attractions.get(id);
    if (!a) return id;
    // append the user-relevant time as a trailing " - <n>m" (end-anchored so it
    // never collides with a " - " inside a name): rides emit only an explicit
    // wait override; dwell stops emit their dwell minutes.
    let line = a.name;
    if (attrCat(a) === "ride") {
      if (typeof a.waitOverride === "number") line += " - " + a.waitOverride + "m";
    } else {
      const d = attrDuration(a);
      if (d > 0) line += " - " + d + "m";
    }
    return line;
  });
  return [header].concat(lines).join("\n");
}
// "8:30 AM" / "08:30" -> "HH:MM" (24h) for the start-time input. null if unparseable.
function clockTo24(s) {
  const m = String(s).match(/(\d{1,2}):(\d{2})\s*([ap])\.?m?\.?/i);
  if (m) {
    let h = parseInt(m[1], 10) % 12;
    if (m[3].toLowerCase() === "p") h += 12;
    return String(h).padStart(2, "0") + ":" + m[2];
  }
  const h24 = String(s).match(/(\d{1,2}):(\d{2})/);
  return h24 ? String(parseInt(h24[1], 10)).padStart(2, "0") + ":" + h24[2] : null;
}
// Parse a pasted name list back into a sequence; returns { seq, unmatched }.
function parsePlan(text) {
  const attrByName = new Map();
  state.attractions.forEach(a => attrByName.set(normName(a.name), a.id));
  // exact normalized match, else a UNIQUE substring match either way (so a
  // typed "Haunted Mansion" still finds "Haunted", but ambiguous names don't).
  function matchAttr(name) {
    const n = normName(name);
    if (!n) return null;
    if (attrByName.has(n)) return attrByName.get(n);
    if (n.length < 3) return null;
    const hits = [];
    attrByName.forEach((id, an) => { if (an.length >= 3 && (an.indexOf(n) >= 0 || n.indexOf(an) >= 0)) hits.push(id); });
    return hits.length === 1 ? hits[0] : null;
  }
  const lineByName = new Map();
  (state.transport || []).forEach(l => lineByName.set(normName(l.name || l.id), l));
  const seq = [], unmatched = [];
  String(text || "").split(/\r?\n/).forEach(raw => {
    let line = raw.trim();
    if (!line) return;
    // a "Start: 8:30 AM" header sets the day's start time (not a sequence stop)
    if (/^start\b/i.test(line)) {
      const t = clockTo24(line), inp = document.getElementById("startTime");
      if (t && inp) inp.value = t;
      return;
    }
    // pull a trailing " - <n>m" time off the end (the dash is a delimiter, so it
    // must end in digits+m — a " - " inside a name won't match).
    let mins = null;
    const tm = line.match(/\s+-\s+(\d+)\s*m\s*$/i);
    if (tm) { mins = parseInt(tm[1], 10); line = line.slice(0, tm.index).trim(); }
    const marked = /^🚂/.test(line);
    const body = line.replace(/^🚂\s*/, "").trim();
    const parts = body.split(/\s*(?:→|->)\s*/);
    const head = parts[0].trim(), tail = parts.length > 1 ? parts.slice(1).join(" ").trim() : "";
    const tline = lineByName.get(normName(head));
    if ((marked || parts.length > 1) && tline) {            // a transit ride
      let alight = null;
      if (tail) alight = lineStops(tline).map(s => s.node).find(n => normName(stopName(n)) === normName(tail)) || null;
      seq.push(transitTokenFor(tline.id, alight));
      return;
    }
    const aid = matchAttr(head) || matchAttr(body);
    if (aid) {
      seq.push(aid);
      if (mins != null) {              // apply the entered time to the matched stop
        const a = state.attractions.get(aid);
        if (attrCat(a) === "ride") a.waitOverride = mins; else a.rideDuration = mins;
      }
      return;
    }
    if (tline) { seq.push(transitTokenFor(tline.id, null)); return; }   // bare line name
    unmatched.push(line);
  });
  return { seq: seq, unmatched: unmatched };
}
function applyPlan() {
  const msg = document.getElementById("modalMsg");
  const r = parsePlan(document.getElementById("ta-plan").value);
  state.sequence = r.seq;
  stop(); refresh();
  if (r.unmatched.length) {
    msg.className = "err";
    msg.textContent = "Loaded " + r.seq.length + " stop(s). Couldn't match: " + r.unmatched.slice(0, 6).join(", ") + (r.unmatched.length > 6 ? "…" : "");
  } else {
    msg.className = "ok";
    msg.textContent = "✓ Loaded plan — " + r.seq.length + " stop(s).";
  }
}
/* ---------- Plan in the URL (shareable links) --------------------------- */
// Compact "?plan=" value: start time + ids, e.g. "s0830,big_thunder,pirates*35,
// @transit:railroad>fantasyland_station". A leading "s" tags the start; "*N"
// carries a stop's entered time (ride wait override / dwell minutes).
function planToParam() {
  const startMin = hmToMin(document.getElementById("startTime").value || "09:00");
  const parts = ["s" + minToHM(startMin).replace(":", "")];
  state.sequence.forEach(id => {
    if (isTransitToken(id)) { parts.push(id); return; }
    const a = state.attractions.get(id);
    if (!a) { parts.push(id); return; }
    let tok = id;
    if (attrCat(a) === "ride") { if (typeof a.waitOverride === "number") tok += "*" + a.waitOverride; }
    else { const d = attrDuration(a); if (d > 0) tok += "*" + d; }
    parts.push(tok);
  });
  return parts.join(",");
}
function planLink() {
  const u = new URL(location.href);
  u.searchParams.set("plan", planToParam());
  u.searchParams.delete("pretend");   // never bake a test location into a shared link
  u.searchParams.delete("t");         // drop any cache-buster
  return u.toString();
}
// Share button: native share sheet on mobile (where it's reliable), else copy
// the link. Desktop Chrome can crash the renderer on navigator.share, so it's
// gated to touch/mobile devices only and never used on desktop.
function shareLink() {
  if (!state.sequence.length) { alert("Add some stops to your plan first."); return; }
  const url = planLink();
  const btn = document.getElementById("shareBtn");
  const data = { title: SAMPLE.meta.name + " — Day Plan", url: url };
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) && navigator.maxTouchPoints > 0;
  if (mobile && navigator.share && (!navigator.canShare || navigator.canShare(data))) {
    try {
      const p = navigator.share(data);
      if (p && p.catch) p.catch(() => {});
      return;
    } catch (e) { /* fall through to copy */ }
  }
  copyText(url, () => flashBtn(btn, "✓ Link copied"));
}
function copyText(text, onOk) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onOk || function () {}, () => fallbackCopy(text, onOk));
  } else fallbackCopy(text, onOk);
}
function fallbackCopy(text, onOk) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px";
  document.body.appendChild(ta); ta.focus(); ta.select();
  try { document.execCommand("copy"); } catch (e) {}
  document.body.removeChild(ta); if (onOk) onOk();
}
function flashBtn(btn, label) {
  if (!btn) return;
  const o = btn.textContent; btn.textContent = label;
  setTimeout(() => { btn.textContent = o; }, 1600);
}
// Apply a "?plan=" value to the start time + sequence. Returns true if present.
function loadPlanParam() {
  const v = new URLSearchParams(location.search).get("plan");
  if (!v) return false;
  const parts = v.split(",").filter(Boolean);
  let i = 0;
  const sm = parts[0] && parts[0].match(/^s(\d{2})(\d{2})$/);   // s0830 -> start 08:30
  if (sm) { const inp = document.getElementById("startTime"); if (inp) inp.value = sm[1] + ":" + sm[2]; i = 1; }
  const seq = [];
  for (; i < parts.length; i++) {
    const p = parts[i];
    if (isTransitToken(p)) { seq.push(p); continue; }
    const star = p.indexOf("*");
    const id = star >= 0 ? p.slice(0, star) : p;
    if (!state.attractions.has(id)) continue;
    seq.push(id);
    if (star >= 0) {
      const mins = parseInt(p.slice(star + 1), 10);
      if (isFinite(mins)) { const a = state.attractions.get(id); if (attrCat(a) === "ride") a.waitOverride = mins; else a.rideDuration = mins; }
    }
  }
  state.sequence = seq;
  return true;
}
function autoDetectAndFill(text, filename) {
  const t = text.trim();
  if (t.charAt(0) === "[" || t.charAt(0) === "{") {
    try {
      const arr = JSON.parse(t);
      const sample = Array.isArray(arr) ? arr[0] : arr;
      if (sample && "entranceNodeId" in sample) { document.getElementById("ta-attractions").value = t; return "attractions"; }
      if (sample && "to" in sample) { document.getElementById("ta-connections").value = t; return "connections"; }
      if (sample && ("x" in sample) && ("isAttraction" in sample || "y" in sample)) { document.getElementById("ta-nodes").value = t; return "nodes"; }
    } catch (e) {}
  }
  if (/attraction_id/.test(t) || /\t/.test(t) || (filename || "").toLowerCase().indexOf("wait") >= 0) {
    document.getElementById("ta-waits").value = t; return "waits";
  }
  return null;
}

/* ---------- helpers ----------------------------------------------------- */
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ---------- Add-node mode ----------------------------------------------- */
let addMode = false;
const addedNodes = []; // session log of captured nodes

function toggleAddMode() {
  addMode = !addMode;
  if (addMode && bgAdjust) toggleBgAdjust();
  document.querySelector(".canvas-wrap").classList.toggle("adding", addMode);
  document.getElementById("addNodeBtn").classList.toggle("active", addMode);
  if (addMode) { stop(); renderCapture(); }
}

function onMapMove(ev) {
  if (!addMode) return;
  const p = screenToMap(ev);
  document.getElementById("coordReadout").textContent =
    "x: " + Math.round(p.x) + "   y: " + Math.round(p.y);
}

function onMapDblClick(ev) {
  if (!addMode) return;
  ev.preventDefault();
  const p = screenToMap(ev);
  const x = Math.round(p.x), y = Math.round(p.y);
  const isAttraction = ev.shiftKey;
  const suggested = (isAttraction ? "attr" : "node") + (addedNodes.length + 1);
  const id = (prompt("Node id" + (isAttraction ? " (attraction)" : "") + ":", suggested) || "").trim();
  if (!id) return;
  if (state.nodes.has(id)) { alert('Node id "' + id + '" already exists. Pick another.'); return; }
  const node = { id, isAttraction, x, y };
  addedNodes.push(node);
  // add live to the map for immediate feedback (no edges yet)
  state.nodes.set(id, node);
  if (!state.adj.has(id)) state.adj.set(id, []);
  renderCapture();
  draw();
}

function renderCapture() {
  document.getElementById("captureCount").textContent = "(" + addedNodes.length + ")";
  document.getElementById("captureOut").value =
    addedNodes.length ? JSON.stringify(addedNodes, null, 2) : "";
}

function captureCopy() {
  const text = document.getElementById("captureOut").value;
  if (!text) return;
  const done = () => { const b = document.getElementById("captureCopy"); b.textContent = "Copied!"; setTimeout(() => b.textContent = "Copy", 1200); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, fallbackCopy);
  } else fallbackCopy();
  function fallbackCopy() {
    const ta = document.getElementById("captureOut");
    ta.removeAttribute("readonly"); ta.focus(); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) {}
    ta.setAttribute("readonly", "");
  }
}

function captureRemove(node) {
  // remove a session node from the live map (keeps non-session nodes intact)
  state.nodes.delete(node.id);
  state.adj.delete(node.id);
  state.adj.forEach(edges => {
    for (let i = edges.length - 1; i >= 0; i--) if (edges[i].to === node.id) edges.splice(i, 1);
  });
}
function captureUndo() {
  const n = addedNodes.pop();
  if (!n) return;
  captureRemove(n);
  renderCapture(); refresh();
}
function captureClear() {
  if (!addedNodes.length) return;
  if (!confirm("Remove all " + addedNodes.length + " captured node(s) from the map and log?")) return;
  addedNodes.forEach(captureRemove);
  addedNodes.length = 0;
  renderCapture(); refresh();
}

/* ---------- Wire up events ---------------------------------------------- */
document.getElementById("playBtn").onclick = () => { playing ? pause() : play(); };
document.getElementById("stopBtn").onclick = stop;
document.getElementById("exportBtn").onclick = exportPlan;
{ const sb = document.getElementById("shareBtn"); if (sb) sb.onclick = shareLink; }
document.getElementById("clearSeq").onclick = () => { state.sequence = []; stop(); refresh(); };
// "Paste" opens the data modal focused on the Plan tab (a copy/paste surface).
document.getElementById("pasteBtn").onclick = pastePlanFromClipboard;
// Open the data modal focused on the Plan tab (manual copy/paste surface).
function openPlanModal() {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === "plan"));
  document.querySelectorAll(".pane").forEach(p => p.classList.toggle("active", p.dataset.pane === "plan"));
  openModal();
  const ta = document.getElementById("ta-plan");
  if (ta) { ta.focus(); ta.select(); }
}
// Read the clipboard and load the plan straight away; fall back to the modal if
// the clipboard can't be read (permission denied / unsupported / empty).
function pastePlanFromClipboard() {
  const btn = document.getElementById("pasteBtn");
  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then(text => {
      if (!text || !text.trim()) { openPlanModal(); return; }
      const r = parsePlan(text);
      state.sequence = r.seq; stop(); refresh();
      if (r.unmatched.length) alert("Loaded " + r.seq.length + " stop(s). Couldn't match:\n" + r.unmatched.join("\n"));
      else flashBtn(btn, "✓ Loaded " + r.seq.length);
    }).catch(() => openPlanModal());
  } else openPlanModal();
}
document.getElementById("startTime").onchange = () => { stop(); refresh(); };
// With a sequence stop selected, Up/Down arrows move to the prev/next stop
// (ignored while typing in a field).
document.addEventListener("keydown", (e) => {
  if (selectedStep === null) return;
  const t = e.target;
  if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  if (e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); }
  else if (e.key === "ArrowDown") { e.preventDefault(); moveSelection(1); }
});
function setStartNow() {
  const d = new Date();
  document.getElementById("startTime").value =
    String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
document.getElementById("nowBtn").onclick = () => { setStartNow(); stop(); refresh(); };
document.getElementById("startLoc").onchange = (e) => { startOverride = resolveStartNode(e.target.value); stop(); refresh(); };
{ const gb = document.getElementById("geoBtn"); if (gb) gb.onclick = toggleGeo; }
document.getElementById("ftPerPx").onchange = () => { stop(); refresh(); };
document.getElementById("bgOpacity").value = Math.round(bg.opacity * 100);
document.getElementById("bgOpacity").oninput = (e) => {
  bg.opacity = (parseInt(e.target.value, 10) || 0) / 100; saveBg(); draw();
};
document.getElementById("bgAdjustBtn").onclick = toggleBgAdjust;
document.getElementById("bgFitBtn").onclick = bgFit;
function setGraphToggleUI() { const b = document.getElementById("graphToggle"); if (b) b.classList.toggle("active", showGraph); }
{ const gb = document.getElementById("graphToggle");
  if (gb) gb.onclick = () => {
    showGraph = !showGraph;
    localStorage.setItem("ridesim.showGraph", showGraph ? "1" : "0");
    setGraphToggleUI(); draw();
  };
}
setGraphToggleUI();
function setPlanToggleUI() { document.getElementById("planToggle").classList.toggle("active", showPlan); }
document.getElementById("planToggle").onclick = () => {
  showPlan = !showPlan;
  localStorage.setItem("ridesim.showPlan", showPlan ? "1" : "0");
  setPlanToggleUI(); draw();
};
setPlanToggleUI();

// both overlays share one feed; (re)fetch if stale, else just re-render
function liveToggled() {
  if (liveOn()) {
    if (Date.now() - liveWaits.fetchedAt > 60000) fetchLive();
    else { updateLiveCredit(); refresh(); }
    startLiveRefresh();
  } else { updateLiveCredit(); refresh(); stopLiveRefresh(); }
}
function setLiveToggleUI() { document.getElementById("liveToggle").classList.toggle("active", showLiveWaits); }
document.getElementById("liveToggle").onclick = () => {
  showLiveWaits = !showLiveWaits;
  localStorage.setItem("ridesim.liveWaits", showLiveWaits ? "1" : "0");
  setLiveToggleUI(); liveToggled();
};
setLiveToggleUI();
function setLLToggleUI() { document.getElementById("llToggle").classList.toggle("active", showLL); }
document.getElementById("llToggle").onclick = () => {
  showLL = !showLL;
  localStorage.setItem("ridesim.ll", showLL ? "1" : "0");
  setLLToggleUI(); liveToggled();
};
setLLToggleUI();
function setAudioToggleUI() { document.getElementById("audioToggle").classList.toggle("active", audioOn); }
document.getElementById("audioToggle").onclick = () => {
  audioOn = !audioOn;
  localStorage.setItem("ridesim.audio", audioOn ? "1" : "0");
  setAudioToggleUI();
  if (!audioOn) stopAudio();
};
setAudioToggleUI();
// live waits are fetched at the end of init() (once attractions exist)
// refetch when the tab is refocused and the data is stale (>5 min)
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && liveOn() && Date.now() - liveWaits.fetchedAt > 5 * 60 * 1000) fetchLive();
});
// category filter chips (Rides / Dining)
document.querySelectorAll("#attrFilter .chip").forEach(chip => {
  chip.onclick = () => {
    const cat = chip.dataset.cat;
    catFilter[cat] = !catFilter[cat];
    chip.classList.toggle("active", catFilter[cat]);
    renderAttrList(); draw();
  };
});
canvas.addEventListener("mousedown", bgDown);
window.addEventListener("mousemove", bgMove);
window.addEventListener("mouseup", bgUp);
canvas.addEventListener("wheel", bgWheel, { passive: false });

// hover an attraction circle to reveal its name
function attractionAt(ev) {
  const rect = canvas.getBoundingClientRect();
  const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
  let best = null, bestD = 12;
  state.attractions.forEach(a => {
    if (!catFilter[attrCat(a)] && state.sequence.indexOf(a.id) < 0) return;
    const loc = a.displayLocation || state.nodes.get(a.entranceNodeId);
    if (!loc) return;
    const d = Math.hypot(tx(loc.x) - sx, ty(loc.y) - sy);
    if (d <= bestD) { bestD = d; best = a.id; }
  });
  return best;
}
// distance (px) from point p to segment a-b, in screen space
function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
// step index whose walk route the cursor is over (within ~7px), else null
function segmentAt(ev) {
  const rect = canvas.getBoundingClientRect();
  const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
  let best = null, bestD = 7;
  state.steps.forEach((s, i) => {
    const c = s.routeCoords;
    for (let k = 0; k < c.length - 1; k++) {
      const d = pointSegDist(sx, sy, tx(c[k].x), ty(c[k].y), tx(c[k + 1].x), ty(c[k + 1].y));
      if (d <= bestD) { bestD = d; best = i; }
    }
  });
  return best;
}
const segTip = document.getElementById("segTip");
function showSegTip(i, ev) {
  const s = state.steps[i];
  segTip.innerHTML = "<b>Walk to " + esc(s.name) + "</b><br>" +
    fmtFeet(stepFeet(s.distPx)) + " · " + fmtDur(s.walk) + " walk · arrive " + minToHM(s.walkEnd);
  segTip.style.left = (ev.clientX + 14) + "px";
  segTip.style.top = (ev.clientY + 14) + "px";
  segTip.style.display = "block";
}
function hideSegTip() { segTip.style.display = "none"; }

// canvas-relative pointer position
function canvasXY(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}
// pointer is over (or in the gap leading up to) the shown hover label
function overLabel(ev) {
  if (!labelHit) return false;
  const p = canvasXY(ev), pad = 6;
  const top = Math.min(labelHit.y, labelHit.nodeY) - pad;
  const bot = Math.max(labelHit.y + labelHit.h, labelHit.nodeY) + pad;
  return p.x >= labelHit.x - pad && p.x <= labelHit.x + labelHit.w + pad && p.y >= top && p.y <= bot;
}
canvas.addEventListener("mousemove", (ev) => {
  if (addMode || bgAdjust) {
    if (hoverAttr || hoverStep !== null) { hoverAttr = null; hoverStep = null; draw(); }
    hideSegTip(); canvas.style.cursor = ""; return;
  }
  // keep the label up while the pointer is on it (so it can be clicked/tapped)
  if (overLabel(ev)) { canvas.style.cursor = "pointer"; hideSegTip(); return; }
  const id = attractionAt(ev);
  const seg = id ? null : segmentAt(ev);      // attraction circle takes priority
  canvas.style.cursor = (id || seg !== null) ? "pointer" : "";
  if (seg !== null) showSegTip(seg, ev); else hideSegTip();
  if (id !== hoverAttr || seg !== hoverStep) { hoverAttr = id; hoverStep = seg; draw(); }
});
// tap/click on the hover label adds that attraction to the sequence
canvas.addEventListener("click", (ev) => {
  if (addMode || bgAdjust || !labelHit) return;
  const p = canvasXY(ev);
  if (p.x >= labelHit.x && p.x <= labelHit.x + labelHit.w && p.y >= labelHit.y && p.y <= labelHit.y + labelHit.h) {
    state.sequence.push(labelHit.id);
    refresh();
  }
});
canvas.addEventListener("mouseleave", () => {
  hideSegTip();
  if (hoverAttr || hoverStep !== null) { hoverAttr = null; hoverStep = null; draw(); }
});

document.getElementById("addNodeBtn").onclick = toggleAddMode;
canvas.addEventListener("mousemove", onMapMove);
canvas.addEventListener("dblclick", onMapDblClick);
document.getElementById("captureCopy").onclick = captureCopy;
document.getElementById("captureUndo").onclick = captureUndo;
document.getElementById("captureClear").onclick = captureClear;

document.getElementById("dataBtn").onclick = openModal;
document.getElementById("closeModal").onclick = () => document.getElementById("modalBg").classList.remove("show");
document.getElementById("applyData").onclick = applyData;
document.getElementById("loadSample").onclick = () => { loadSample(); computeView(); refresh(); openModal(); };
document.querySelectorAll(".tab").forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".pane").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector('.pane[data-pane="' + tab.dataset.tab + '"]').classList.add("active");
    setPaneHint();
  };
});
document.getElementById("fileLoad").onchange = (e) => {
  const files = Array.prototype.slice.call(e.target.files);
  files.forEach(file => {
    const r = new FileReader();
    r.onload = () => {
      const which = autoDetectAndFill(r.result, file.name);
      const msg = document.getElementById("modalMsg");
      if (which) {
        document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === which));
        document.querySelectorAll(".pane").forEach(p => p.classList.toggle("active", p.dataset.pane === which));
        setPaneHint();
        msg.className = "ok"; msg.textContent = 'Loaded "' + file.name + '" → ' + which + '. Click Apply.';
      } else {
        msg.className = "err"; msg.textContent = 'Could not auto-detect "' + file.name + '". Paste manually.';
      }
    };
    r.readAsText(file);
  });
};
document.getElementById("modalBg").addEventListener("click", e => {
  if (e.target.id === "modalBg") e.currentTarget.classList.remove("show");
});
window.addEventListener("resize", resizeCanvas);

/* ---------- Init -------------------------------------------------------- */
function loadSample() {
  buildFromData(SAMPLE.nodes, SAMPLE.connections, SAMPLE.attractions, SAMPLE.waitsTSV, SAMPLE.transport);
  state.mapExtent = SAMPLE.mapExtent || null;
  if (typeof SAMPLE.feetPerPixel === "number" && SAMPLE.feetPerPixel > 0) {
    document.getElementById("ftPerPx").value = Math.round(SAMPLE.feetPerPixel * 1000) / 1000;
  }
  state.sequence = [];
  geoXform = computeGeoTransform(SAMPLE.geoAnchors);   // GPS calibration, if the park has anchors
  refreshGeoBtn();
  applyMapExtent();
}
function init() {
  applyParkMeta();        // browser tab + header from SAMPLE.meta
  loadSample();
  setStartNow();          // default the day to the current time
  loadPlanParam();        // a shared "?plan=" link overrides start + sequence
  resizeCanvas();
  refresh();
  // one live feed (ThemeParks.wiki) powers waits + LL; fetch once attractions exist
  fetchLive();
  if (liveOn()) startLiveRefresh();
}
init();
