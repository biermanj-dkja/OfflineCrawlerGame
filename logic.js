/* The Gloam Below - core game logic.
 * Rules, procedural generation, deterministic RNG, state transitions and save
 * validation live here. No DOM access: this file runs in browsers as a classic
 * script (global `Game`) and in Node (module.exports = Game). */
(function (root) {
  "use strict";

  var GEN_VERSION = "GB-GEN-1";
  var SAVE_VERSION = 1;
  var MAP_W = 40, MAP_H = 26, VIEW_R = 8;
  var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];

  // ------------------------------------------------------------------
  // Deterministic RNG. sfc32 over a 4 x uint32 state array that is stored
  // directly in the game state, so saving the array saves the stream.
  // ------------------------------------------------------------------
  function hash128(str) {
    var h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (var i = 0, k; i < str.length; i++) {
      k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= (h2 ^ h3 ^ h4); h2 ^= h1; h3 ^= h1; h4 ^= h1;
    return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
  }
  function rnext(s) {
    var a = s[0] >>> 0, b = s[1] >>> 0, c = s[2] >>> 0, d = s[3] >>> 0;
    var t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    s[0] = a >>> 0; s[1] = b >>> 0; s[2] = c >>> 0; s[3] = d >>> 0;
    return (t >>> 0) / 4294967296;
  }
  function makeStream(key) {
    var s = hash128(key);
    for (var i = 0; i < 15; i++) rnext(s);
    return s;
  }
  function rint(s, lo, hi) { return lo + Math.floor(rnext(s) * (hi - lo + 1)); }
  function rchance(s, p) { return rnext(s) < p; }
  function rpick(s, arr) { return arr[Math.floor(rnext(s) * arr.length)]; }
  function rshuffle(s, arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rnext(s) * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  // Every stream key includes the generator version so generation changes are explicit.
  function streamKey(seed, purpose, n) {
    return GEN_VERSION + "|" + seed + "|" + purpose + (n === undefined ? "" : "|" + n);
  }

  // ------------------------------------------------------------------
  // Data tables
  // ------------------------------------------------------------------
  var CLASSES = {
    sentinel: {
      name: "Sentinel", role: "Front-line guardian", glyph: "S",
      blurb: "Durable and steady. Holds the front rank, shoves foes into walls and draws their attacks.",
      strengths: "High HP and armour; controls enemy position.", weaknesses: "Short reach; little damage from the back rank.",
      base: { hp: 36, pow: 6, wil: 2, arm: 2, acc: 82, eva: 5 }, per: { hp: 7, pow: 1, wil: 0 },
      start: { weapon: "sword", armor: "ringmail", offhand: "buckler", charm: null },
      abilities: ["shove", "guard"]
    }
  };

  var ABILITIES = {
    shove: { name: "Shove", cls: "sentinel", charges: 3, target: "enemy", range: 1, frontOnly: true, combat: true,
      desc: "Front rank only. Strike an adjacent foe and knock it back 2 tiles. If it hits a wall or another body it is stunned for 1 round." },
    guard: { name: "Guard", cls: "sentinel", charges: 0, target: "self", combat: true,
      desc: "Unlimited. Until your next party phase: +3 armour and you intercept single-target attacks aimed at back-rank allies." }
  };

  var ITEMS = {
    sword: { name: "Notched Sword", slot: "weapon", kind: "melee", dmg: [3, 6], stat: "pow", glyph: ")", desc: "Old steel, honestly sharpened." },
    ringmail: { name: "Ring Mail", slot: "armor", mods: { arm: 2 }, glyph: "[", desc: "Links of dull iron." },
    buckler: { name: "Buckler", slot: "offhand", mods: { arm: 1, eva: 3 }, glyph: "(", desc: "A small round shield." }
  };
  var FIST = { name: "Bare Hands", kind: "melee", dmg: [1, 3], stat: "pow" };

  var ENEMIES = {
    gnawer: { name: "Gnawer", glyph: "r", hp: 9, dmg: [2, 4], acc: 75, eva: 10, arm: 0, xp: 5, ai: "melee",
      desc: "A hairless, hungry thing. Rushes the front rank and bites." },
    archer: { name: "Bone Archer", glyph: "a", hp: 8, dmg: [2, 5], acc: 75, eva: 5, arm: 0, xp: 7, ai: "ranged", range: 6, keep: 3,
      desc: "Keeps its distance and shoots any party member it can see. Backs away when cornered." }
  };

  var THEMES = {
    ossuary: { name: "Ossuary", enemies: ["gnawer", "gnawer", "archer"] }
  };

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  var EV = [];
  function emit(type, data) { EV.push({ type: type, data: data || null }); }
  function log(state, text, kind) {
    state.log.push({ t: state.turn, k: kind || "info", m: text });
    if (state.log.length > 80) state.log.splice(0, state.log.length - 80);
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function cheb(ax, ay, bx, by) { return Math.max(Math.abs(ax - bx), Math.abs(ay - by)); }
  function sgn(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
  function idx(x, y) { return y * MAP_W + x; }
  function newId(state) { state.nextId += 1; return state.nextId; }

  function tileAt(f, x, y) {
    if (x < 0 || y < 0 || x >= f.w || y >= f.h) return "#";
    return f.tiles[y].charAt(x);
  }
  function isFloor(f, x, y) { return tileAt(f, x, y) !== "#"; }
  function setChar(rows, x, y, ch) {
    var r = rows[y];
    if (r.charAt(x) === ch) return;
    rows[y] = r.slice(0, x) + ch + r.slice(x + 1);
  }
  function isSeen(f, x, y) { return x >= 0 && y >= 0 && x < f.w && y < f.h && f.seen[y].charAt(x) === "1"; }
  // Diagonal steps may not squeeze between two walls.
  function canStep(f, x, y, dx, dy) {
    if (!isFloor(f, x + dx, y + dy)) return false;
    if (dx !== 0 && dy !== 0 && !isFloor(f, x + dx, y) && !isFloor(f, x, y + dy)) return false;
    return true;
  }

  // ------------------------------------------------------------------
  // Line of sight and vision (derived, cached outside the saved state)
  // ------------------------------------------------------------------
  function lineClear(f, x0, y0, x1, y1) {
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    var err = dx - dy, x = x0, y = y0;
    while (!(x === x1 && y === y1)) {
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
      if (x === x1 && y === y1) return true;
      if (!isFloor(f, x, y)) return false;
    }
    return true;
  }
  function los(f, x0, y0, x1, y1) { return lineClear(f, x0, y0, x1, y1) || lineClear(f, x1, y1, x0, y0); }

  function computeVision(f, px, py) {
    var v = new Uint8Array(MAP_W * MAP_H);
    for (var dy = -VIEW_R; dy <= VIEW_R; dy++) {
      for (var dx = -VIEW_R; dx <= VIEW_R; dx++) {
        var x = px + dx, y = py + dy;
        if (x < 0 || y < 0 || x >= f.w || y >= f.h) continue;
        if (dx * dx + dy * dy > VIEW_R * VIEW_R + VIEW_R) continue;
        if (los(f, px, py, x, y)) v[idx(x, y)] = 1;
      }
    }
    return v;
  }
  function vision(state) {
    var key = state.floor.num + ":" + state.pos.x + ":" + state.pos.y + ":" + state.floor.rev;
    var c = state.__vis;
    if (!c || c.key !== key) {
      c = { key: key, v: computeVision(state.floor, state.pos.x, state.pos.y) };
      Object.defineProperty(state, "__vis", { value: c, enumerable: false, writable: true, configurable: true });
    }
    return c.v;
  }
  function canSee(state, x, y) {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return false;
    return vision(state)[idx(x, y)] === 1;
  }

  // ------------------------------------------------------------------
  // Floor generation (pure function of seed, generator version, floor number)
  // ------------------------------------------------------------------
  function blankGrid() {
    var g = [];
    for (var y = 0; y < MAP_H; y++) { var r = []; for (var x = 0; x < MAP_W; x++) r.push("#"); g.push(r); }
    return g;
  }
  function carve(g, x, y) { if (x > 0 && y > 0 && x < MAP_W - 1 && y < MAP_H - 1) g[y][x] = "."; }
  function roomCenter(r) { return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) }; }
  function corridor(s, g, a, b) {
    var x = a.x, y = a.y;
    var horizFirst = rchance(s, 0.5);
    function walkX() { while (x !== b.x) { carve(g, x, y); x += sgn(b.x - x); } carve(g, x, y); }
    function walkY() { while (y !== b.y) { carve(g, x, y); y += sgn(b.y - y); } carve(g, x, y); }
    if (horizFirst) { walkX(); walkY(); } else { walkY(); walkX(); }
  }

  function buildRooms(s) {
    var g = blankGrid(), rooms = [];
    var want = rint(s, 9, 12);
    for (var t = 0; t < 500 && rooms.length < want; t++) {
      var w = rint(s, 4, 9), h = rint(s, 3, 6);
      var x = rint(s, 1, MAP_W - w - 2), y = rint(s, 1, MAP_H - h - 2);
      var ok = true;
      for (var i = 0; i < rooms.length; i++) {
        var r = rooms[i];
        if (x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y) { ok = false; break; }
      }
      if (ok) rooms.push({ x: x, y: y, w: w, h: h });
    }
    if (rooms.length < 6) return null;
    rooms.forEach(function (r) {
      for (var yy = r.y; yy < r.y + r.h; yy++) for (var xx = r.x; xx < r.x + r.w; xx++) carve(g, xx, yy);
    });
    // Prim's minimum spanning tree over room centres, plus two loops.
    var inTree = [0], rest = [];
    for (var k = 1; k < rooms.length; k++) rest.push(k);
    while (rest.length) {
      var best = null;
      inTree.forEach(function (a) {
        rest.forEach(function (b, bi) {
          var ca = roomCenter(rooms[a]), cb = roomCenter(rooms[b]);
          var d = Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y);
          if (!best || d < best.d) best = { a: a, b: b, bi: bi, d: d };
        });
      });
      corridor(s, g, roomCenter(rooms[best.a]), roomCenter(rooms[best.b]));
      inTree.push(best.b); rest.splice(best.bi, 1);
    }
    for (var e = 0; e < 2; e++) {
      var ra = rint(s, 0, rooms.length - 1), rb = rint(s, 0, rooms.length - 1);
      if (ra !== rb) corridor(s, g, roomCenter(rooms[ra]), roomCenter(rooms[rb]));
    }
    return { g: g, rooms: rooms };
  }

  function bfsDist(f, sx, sy, blocked) {
    var d = new Int16Array(MAP_W * MAP_H); d.fill(-1);
    var q = [sx, sy]; d[idx(sx, sy)] = 0;
    for (var qi = 0; qi < q.length; qi += 2) {
      var x = q[qi], y = q[qi + 1], cd = d[idx(x, y)];
      for (var i = 0; i < 8; i++) {
        var nx = x + DIRS[i][0], ny = y + DIRS[i][1];
        if (!canStep(f, x, y, DIRS[i][0], DIRS[i][1])) continue;
        var ni = idx(nx, ny);
        if (d[ni] !== -1) continue;
        if (blocked && blocked(nx, ny)) continue;
        d[ni] = cd + 1; q.push(nx, ny);
      }
    }
    return d;
  }

  function roomTiles(r) {
    var out = [];
    for (var y = r.y; y < r.y + r.h; y++) for (var x = r.x; x < r.x + r.w; x++) out.push({ x: x, y: y });
    return out;
  }

  function generateFloor(seed, n) {
    var s = makeStream(streamKey(seed, "floor", n));
    for (var attempt = 0; attempt < 40; attempt++) {
      var f = tryFloor(s, seed, n);
      if (f && validateFloorDef(f).ok) return f;
    }
    throw new Error("Floor generation failed for seed " + seed + " floor " + n);
  }

  function tryFloor(s, seed, n) {
    var built = buildRooms(s);
    if (!built) return null;
    var themeId = "ossuary";
    var tiles = built.g.map(function (r) { return r.join(""); });
    var polar = []; for (var y = 0; y < MAP_H; y++) polar.push(new Array(MAP_W + 1).join("."));
    var f = { num: n, theme: themeId, w: MAP_W, h: MAP_H, tiles: tiles, polar: polar, rooms: [], start: null, stairs: null,
      objective: { type: "stairs", done: true }, enemies: [], items: [], features: [] };
    var rooms = built.rooms.map(function (r) { return { x: r.x, y: r.y, w: r.w, h: r.h }; });
    var startRoom = rint(s, 0, rooms.length - 1);
    var sc = roomCenter(rooms[startRoom]);
    f.start = { x: sc.x, y: sc.y };
    var dist = bfsDist(f, sc.x, sc.y);
    var order = rooms.map(function (r, i) { var c = roomCenter(r); return { i: i, d: dist[idx(c.x, c.y)] }; })
      .filter(function (o) { return o.i !== startRoom; })
      .sort(function (a, b) { return a.d - b.d || a.i - b.i; });
    if (!order.length || order[order.length - 1].d < 0) return null;
    var stairsRoom = order[order.length - 1].i;
    var stc = roomCenter(rooms[stairsRoom]);
    f.stairs = { x: stc.x, y: stc.y };
    f.rooms = rooms;
    var occupied = {};
    occupied[sc.x + "," + sc.y] = 1; occupied[stc.x + "," + stc.y] = 1;
    function freeTile(room) {
      var cands = roomTiles(room).filter(function (t) { return !occupied[t.x + "," + t.y]; });
      if (!cands.length) return null;
      var t = rpick(s, cands); occupied[t.x + "," + t.y] = 1; return t;
    }
    var theme = THEMES[themeId];
    order.forEach(function (o) {
      if (o.d < 7 || !rchance(s, 0.7)) return;
      var count = rint(s, 2, 3);
      for (var k = 0; k < count; k++) {
        var t = freeTile(rooms[o.i]);
        if (!t) break;
        f.enemies.push({ type: rpick(s, theme.enemies), x: t.x, y: t.y, minParty: k === 0 ? 1 : k + 1 });
      }
    });
    return f;
  }

  // Confirms every required location is reachable from the start tile.
  function validateFloorDef(f) {
    var problems = [];
    var dist = bfsDist(f, f.start.x, f.start.y);
    function reach(x, y) { return isFloor(f, x, y) && dist[idx(x, y)] >= 0; }
    function reachAdj(x, y) {
      if (reach(x, y)) return true;
      for (var i = 0; i < 8; i++) if (reach(x + DIRS[i][0], y + DIRS[i][1])) return true;
      return false;
    }
    if (!f.stairs || !reach(f.stairs.x, f.stairs.y)) problems.push("stairs unreachable");
    f.enemies.forEach(function (e) { if (!reachAdj(e.x, e.y)) problems.push("enemy unreachable"); });
    return { ok: problems.length === 0, problems: problems };
  }

  // ------------------------------------------------------------------
  // Characters and stats
  // ------------------------------------------------------------------
  function makeItem(state, base) { return { id: newId(state), base: base, rarity: "common", affixes: [] }; }

  function makeChar(state, cls, name) {
    var C = CLASSES[cls];
    var c = { id: newId(state), name: name, cls: cls, level: 1, xp: 0, hp: 0, down: false,
      bonus: { hp: 0, pow: 0, wil: 0, arm: 0, acc: 0, eva: 0 }, upgrades: [], st: {},
      abilities: C.abilities.map(function (a) { return { id: a, charges: ABILITIES[a].charges }; }),
      equip: { weapon: null, armor: null, offhand: null, charm: null } };
    ["weapon", "armor", "offhand", "charm"].forEach(function (sl) { if (C.start[sl]) c.equip[sl] = makeItem(state, C.start[sl]); });
    c.hp = charStats(c).maxHp;
    return c;
  }

  function charStats(c) {
    var C = CLASSES[c.cls], L = c.level - 1;
    var st = { maxHp: C.base.hp + C.per.hp * L + c.bonus.hp, pow: C.base.pow + C.per.pow * L + c.bonus.pow,
      wil: C.base.wil + C.per.wil * L + c.bonus.wil, arm: C.base.arm + c.bonus.arm, acc: C.base.acc + c.bonus.acc,
      eva: C.base.eva + c.bonus.eva };
    ["weapon", "armor", "offhand", "charm"].forEach(function (sl) {
      var it = c.equip[sl]; if (!it) return;
      var m = ITEMS[it.base].mods || {};
      for (var k in m) if (st[k] !== undefined) st[k] += m[k];
    });
    var wb = c.equip.weapon ? ITEMS[c.equip.weapon.base] : FIST;
    st.weapon = { name: wb.name, kind: wb.kind, range: wb.kind === "reach" ? 2 : (wb.range || 1), dmg: wb.dmg, stat: wb.stat };
    st.maxHp = Math.max(1, st.maxHp);
    return st;
  }

  function abilityMax(c, id) { return ABILITIES[id].charges; }

  function front(state) {
    for (var i = 0; i < state.party.length; i++) if (!state.party[i].down) return state.party[i];
    return null;
  }
  function conscious(state) { return state.party.filter(function (c) { return !c.down; }); }
  function charById(state, id) { for (var i = 0; i < state.party.length; i++) if (state.party[i].id === id) return state.party[i]; return null; }
  function enemyById(state, id) { for (var i = 0; i < state.floor.enemies.length; i++) if (state.floor.enemies[i].id === id) return state.floor.enemies[i]; return null; }
  function enemyAt(state, x, y) {
    var es = state.floor.enemies;
    for (var i = 0; i < es.length; i++) if (es[i].x === x && es[i].y === y) return es[i];
    return null;
  }

  // ------------------------------------------------------------------
  // Run creation and floors
  // ------------------------------------------------------------------
  function newRun(opts) {
    var seed = String(opts.seed);
    var state = {
      format: "gloam-below-run", saveVersion: SAVE_VERSION, genVersion: GEN_VERSION,
      seed: seed, daily: !!opts.daily, status: "explore", turn: 0, nextId: 0,
      rng: { runtime: makeStream(streamKey(seed, "runtime")) },
      party: [], inventory: [], floor: null, pos: { x: 0, y: 0 }, combat: null,
      log: [], stats: { kills: 0, turns: 0, dmgDealt: 0, dmgTaken: 0, floorsCleared: 0 }, flags: {}
    };
    (opts.party || []).forEach(function (p) { state.party.push(makeChar(state, p.cls, p.name)); });
    enterFloor(state, 1);
    log(state, "The party descends into the dark.", "story");
    return state;
  }

  function enterFloor(state, n) {
    var def = generateFloor(state.seed, n);
    var size = state.party.length;
    var seen = []; for (var y = 0; y < MAP_H; y++) seen.push(new Array(MAP_W + 1).join("0"));
    var f = { num: n, theme: def.theme, w: def.w, h: def.h, tiles: def.tiles.slice(), polar: def.polar.slice(), seen: seen,
      rooms: def.rooms.map(function (r) { return { x: r.x, y: r.y, w: r.w, h: r.h, visited: false }; }),
      stairs: { x: def.stairs.x, y: def.stairs.y }, objective: JSON.parse(JSON.stringify(def.objective)),
      enemies: [], items: [], features: [], noticed: [], rev: 0 };
    state.floor = f;
    state.pos = { x: def.start.x, y: def.start.y };
    def.enemies.forEach(function (d) {
      if (d.minParty > size) return;
      spawnEnemy(state, d.type, d.x, d.y, {});
    });
    state.combat = null;
    state.status = "explore";
    updateVision(state);
  }

  function spawnEnemy(state, type, x, y, o) {
    var D = ENEMIES[type], n = state.floor.num;
    var hp = Math.round(D.hp * (1 + 0.16 * (n - 1)));
    var e = { id: newId(state), type: type, x: x, y: y, hp: hp, maxHp: hp, awake: !D.asleep, alerted: !!o.alerted,
      hidden: false, st: {}, xp: o.xp !== undefined ? o.xp : D.xp };
    state.floor.enemies.push(e);
    return e;
  }

  function enemyStat(state, e) {
    var D = ENEMIES[e.type], n = state.floor.num, b = Math.floor((n - 1) * 0.6);
    var st = { dmg: [D.dmg[0] + b, D.dmg[1] + b], acc: D.acc + 2 * (n - 1), eva: D.eva, arm: D.arm };
    return st;
  }

  // ------------------------------------------------------------------
  // Vision updates and discoveries
  // ------------------------------------------------------------------
  function updateVision(state) {
    var f = state.floor, v = vision(state);
    for (var y = 0; y < f.h; y++) {
      var row = f.seen[y], changed = false, arr = null;
      for (var x = 0; x < f.w; x++) {
        if (v[idx(x, y)] && row.charAt(x) !== "1") {
          if (!arr) arr = row.split("");
          arr[x] = "1"; changed = true;
        }
      }
      if (changed) f.seen[y] = arr.join("");
    }
    var vis = {};
    f.enemies.forEach(function (e) {
      if (e.hidden || !v[idx(e.x, e.y)]) return;
      vis["e" + e.id] = 1;
      if (f.noticed.indexOf("e" + e.id) < 0) { f.noticed.push("e" + e.id); emit("discover", { what: "enemy", id: e.id }); }
    });
    if (v[idx(f.stairs.x, f.stairs.y)] && f.noticed.indexOf("stairs") < 0) {
      f.noticed.push("stairs"); emit("discover", { what: "stairs" });
      log(state, "You spot the stairs down.", "info");
    }
    // Waking by awareness range.
    f.enemies.forEach(function (e) {
      var D = ENEMIES[e.type];
      if (!e.awake && D.aware && v[idx(e.x, e.y)] && cheb(e.x, e.y, state.pos.x, state.pos.y) <= D.aware) {
        wake(state, e, "senses the party");
      }
    });
  }

  function wake(state, e, why) {
    if (e.awake) return;
    e.awake = true; e.alerted = true;
    log(state, ENEMIES[e.type].name + " wakes (" + why + ").", "warn");
    emit("wake", { id: e.id });
  }

  function awakeVisible(state) {
    var v = vision(state);
    return state.floor.enemies.filter(function (e) { return e.awake && !e.hidden && v[idx(e.x, e.y)]; });
  }

  // ------------------------------------------------------------------
  // Combat flow
  // ------------------------------------------------------------------
  function maybeStartCombat(state) {
    if (state.status !== "explore") return false;
    var foes = awakeVisible(state);
    if (!foes.length) return false;
    foes.forEach(function (e) { e.alerted = true; });
    state.status = "combat";
    state.combat = { round: 1, actor: -1, moved: false, acted: [] };
    log(state, "Combat! " + foes.map(function (e) { return ENEMIES[e.type].name; }).join(", ") + ".", "combat");
    emit("combat", {});
    startPartyPhase(state);
    return true;
  }

  function startPartyPhase(state) {
    var cb = state.combat;
    cb.moved = false; cb.acted = [];
    state.party.forEach(function (c) { delete c.st.guard; });
    cb.actor = nextActor(state, -1);
    if (cb.actor < 0) defeat(state);
  }

  function nextActor(state, from) {
    for (var i = from + 1; i < state.party.length; i++) {
      var c = state.party[i];
      if (!c.down && state.combat.acted.indexOf(c.id) < 0) return i;
    }
    return -1;
  }

  function currentActor(state) {
    if (state.status !== "combat" || !state.combat || state.combat.actor < 0) return null;
    return state.party[state.combat.actor];
  }

  function finishAction(state) {
    if (state.status !== "combat") return;
    var c = state.party[state.combat.actor];
    if (c) state.combat.acted.push(c.id);
    if (checkCombatEnd(state)) return;
    var nx = nextActor(state, state.combat.actor);
    if (nx >= 0) { state.combat.actor = nx; return; }
    enemyPhase(state);
    if (state.status !== "combat") return;
    if (checkCombatEnd(state)) return;
    state.combat.round += 1;
    startPartyPhase(state);
  }

  function checkCombatEnd(state) {
    if (state.status !== "combat") return true;
    if (!conscious(state).length) { defeat(state); return true; }
    if (awakeVisible(state).length) return false;
    endCombat(state);
    return true;
  }

  function endCombat(state) {
    state.status = "explore";
    state.combat = null;
    state.party.forEach(function (c) {
      c.st = {};
      if (c.down) return;
      var st = charStats(c), cap = Math.floor(st.maxHp * 0.5);
      if (c.hp < cap) c.hp = Math.min(cap, c.hp + Math.max(1, Math.floor(st.maxHp * 0.1)));
    });
    log(state, "The fighting ends. The party catches its breath (recovery up to half health).", "good");
    emit("combatEnd", {});
  }

  function defeat(state) {
    state.status = "defeat";
    state.combat = null;
    log(state, "The last light of the party goes out.", "bad");
    emit("defeat", {});
  }

  // ------------------------------------------------------------------
  // Damage
  // ------------------------------------------------------------------
  function hurtChar(state, c, amount, src) {
    if (c.down || amount <= 0) return 0;
    if (state.flags.godMode) amount = 0;
    c.hp -= amount;
    state.stats.dmgTaken += amount;
    emit("hurt", { who: c.id, amount: amount });
    if (c.hp <= 0) {
      c.hp = 0; c.down = true; c.st = {};
      log(state, c.name + " is downed!", "bad");
      emit("down", { who: c.id });
    }
    return amount;
  }

  function hurtEnemy(state, e, amount, src) {
    if (amount <= 0) amount = 1;
    if (!e.awake) wake(state, e, "struck");
    e.alerted = true;
    e.hp -= amount;
    state.stats.dmgDealt += amount;
    emit("hit", { id: e.id, amount: amount, x: e.x, y: e.y });
    if (e.hp <= 0) killEnemy(state, e, src);
    return amount;
  }

  function killEnemy(state, e, src) {
    var f = state.floor, i = f.enemies.indexOf(e);
    if (i < 0) return;
    f.enemies.splice(i, 1);
    state.stats.kills += 1;
    log(state, ENEMIES[e.type].name + " is destroyed." + (e.xp ? " (+" + e.xp + " XP each)" : ""), "good");
    emit("kill", { id: e.id, x: e.x, y: e.y });
    if (e.xp > 0) grantXp(state, e.xp);
  }

  var XP_TABLE = [0, 20, 50, 90, 140, 200, 270, 350, 440];
  function grantXp(state, amount) {
    // Every conscious member receives the full value; never divided by party size.
    state.party.forEach(function (c) {
      if (c.down) return;
      c.xp += amount;
      while (c.level < XP_TABLE.length && c.xp >= XP_TABLE[c.level]) {
        var before = charStats(c).maxHp;
        c.level += 1;
        c.hp += charStats(c).maxHp - before;
        log(state, c.name + " reaches level " + c.level + ".", "good");
      }
    });
  }

  // Party attack roll against an enemy.
  function rollAttack(state, c, e, mult, opts) {
    opts = opts || {};
    var rt = state.rng.runtime, st = charStats(c), es = enemyStat(state, e), w = st.weapon;
    var sure = !e.awake || e.st.stun > 0 || opts.sure;
    var chance = clamp(st.acc + (opts.acc || 0) - es.eva, 10, 95);
    if (!sure && rint(rt, 1, 100) > chance) {
      log(state, c.name + " misses " + ENEMIES[e.type].name + ".", "miss");
      emit("miss", { x: e.x, y: e.y });
      if (!e.awake) wake(state, e, "attacked");
      return 0;
    }
    var dmg = rint(rt, w.dmg[0], w.dmg[1]) + Math.floor(st[w.stat] / 2);
    dmg = Math.round(dmg * (mult || 1));
    if (!opts.pierce) dmg -= es.arm;
    dmg = Math.max(1, dmg);
    log(state, c.name + " hits " + ENEMIES[e.type].name + " for " + dmg + ".", "hit");
    return hurtEnemy(state, e, dmg, c);
  }

  function basicCheck(state, c, e) {
    if (!e || e.hidden || !canSee(state, e.x, e.y)) return "You cannot see that target.";
    var w = charStats(c).weapon, d = cheb(state.pos.x, state.pos.y, e.x, e.y);
    if (w.kind === "melee") {
      if (front(state) !== c) return c.name + " is in the back rank and needs a reach or ranged weapon, or a spell, to attack.";
      if (d > 1) return "Melee attacks need an adjacent target.";
    } else if (d > w.range) return "Out of range (" + w.range + ").";
    return null;
  }

  // Enemy attacks a party member. kind: "melee" | "ranged" | "area".
  function enemyHits(state, e, target, dmgRange, kind, label) {
    if (!target || target.down) return;
    var rt = state.rng.runtime, es = enemyStat(state, e), name = ENEMIES[e.type].name;
    if (kind !== "area" && front(state) !== target) {
      var g = state.party.filter(function (c) { return !c.down && c.st.guard; })[0];
      if (g && g !== target) { log(state, g.name + " intercepts the attack meant for " + target.name + ".", "info"); target = g; }
    }
    var ts = charStats(target), arm = ts.arm + (target.st.guard ? 3 : 0);
    var chance = clamp(es.acc - ts.eva, 10, 95);
    if (rint(rt, 1, 100) > chance) { log(state, name + " " + (label || "attacks") + " " + target.name + " and misses.", "miss"); return; }
    var dmg = Math.max(1, rint(rt, dmgRange[0], dmgRange[1]) - arm);
    log(state, name + " " + (label || "hits") + " " + target.name + " for " + dmg + ".", "bad");
    hurtChar(state, target, dmg, e);
  }

  // ------------------------------------------------------------------
  // Enemy phase
  // ------------------------------------------------------------------
  function enemyPhase(state) {
    var f = state.floor, v = vision(state);
    var dm = bfsDist(f, state.pos.x, state.pos.y);
    var actors = f.enemies.filter(function (e) { return e.awake && !e.hidden && (v[idx(e.x, e.y)] || e.alerted); });
    actors.sort(function (a, b) {
      return cheb(a.x, a.y, state.pos.x, state.pos.y) - cheb(b.x, b.y, state.pos.x, state.pos.y) || a.id - b.id;
    });
    for (var i = 0; i < actors.length; i++) {
      var e = actors[i];
      if (f.enemies.indexOf(e) < 0) continue;
      if (e.st.stun > 0) { e.st.stun -= 1; log(state, ENEMIES[e.type].name + " is stunned.", "info"); continue; }
      enemyAct(state, e, dm);
      if (!conscious(state).length) { defeat(state); return; }
    }
  }

  function stepToward(state, e, dm) {
    var f = state.floor, best = null, bd = dm[idx(e.x, e.y)];
    if (bd < 0) return false;
    for (var i = 0; i < 8; i++) {
      var nx = e.x + DIRS[i][0], ny = e.y + DIRS[i][1];
      if (!canStep(f, e.x, e.y, DIRS[i][0], DIRS[i][1])) continue;
      if (nx === state.pos.x && ny === state.pos.y) continue;
      if (enemyAt(state, nx, ny)) continue;
      var d = dm[idx(nx, ny)];
      if (d >= 0 && d < bd) { bd = d; best = [nx, ny]; }
    }
    if (!best) return false;
    e.x = best[0]; e.y = best[1];
    return true;
  }

  function stepAway(state, e, dm, mustSee) {
    var f = state.floor, best = null, bd = dm[idx(e.x, e.y)];
    for (var i = 0; i < 8; i++) {
      var nx = e.x + DIRS[i][0], ny = e.y + DIRS[i][1];
      if (!canStep(f, e.x, e.y, DIRS[i][0], DIRS[i][1])) continue;
      if (enemyAt(state, nx, ny) || (nx === state.pos.x && ny === state.pos.y)) continue;
      if (mustSee && !canSee(state, nx, ny)) continue;
      var d = dm[idx(nx, ny)];
      if (d > bd) { bd = d; best = [nx, ny]; }
    }
    if (!best) return false;
    e.x = best[0]; e.y = best[1];
    return true;
  }

  function enemyAct(state, e, dm) {
    var D = ENEMIES[e.type], d = cheb(e.x, e.y, state.pos.x, state.pos.y), seen = canSee(state, e.x, e.y);
    var rt = state.rng.runtime;
    if (D.ai === "melee") {
      if (d <= 1) enemyHits(state, e, front(state), enemyStat(state, e).dmg, "melee", "bites");
      else stepToward(state, e, dm);
    } else if (D.ai === "ranged") {
      if (d < D.keep && stepAway(state, e, dm, true)) return;
      if (seen && d <= D.range) enemyHits(state, e, rpick(rt, conscious(state)), enemyStat(state, e).dmg, "ranged", "shoots");
      else stepToward(state, e, dm);
    }
  }

  // Intent text shown to the player.
  function intentOf(state, e) {
    var D = ENEMIES[e.type];
    if (e.hidden) return "Hidden.";
    if (!e.awake) return "Asleep" + (D.aware ? " - wakes if you come within " + D.aware + " tiles" : "") + ", or when attacked or noise is made nearby.";
    if (e.st.stun > 0) return "Stunned - loses its next turn.";
    var d = cheb(e.x, e.y, state.pos.x, state.pos.y);
    if (D.ai === "melee") return d <= 1 ? "Will bite the front rank." : "Advancing on the front rank.";
    if (D.ai === "ranged") return d < D.keep ? "Will try to back away, then shoot." : "Will shoot a random party member it can see.";
    return "";
  }

  // ------------------------------------------------------------------
  // Player actions
  // ------------------------------------------------------------------
  function moveParty(state, dx, dy) {
    var f = state.floor, nx = state.pos.x + dx, ny = state.pos.y + dy;
    if (!canStep(f, state.pos.x, state.pos.y, dx, dy)) return "Blocked.";
    if (enemyAt(state, nx, ny)) return "Something is in the way.";
    state.pos.x = nx; state.pos.y = ny;
    state.turn += 1; state.stats.turns += 1;
    updateVision(state);
    enterTileEffects(state);
    return null;
  }

  function enterTileEffects(state) {
    var f = state.floor;
    f.rooms.forEach(function (r) {
      if (!r.visited && state.pos.x >= r.x && state.pos.x < r.x + r.w && state.pos.y >= r.y && state.pos.y < r.y + r.h) r.visited = true;
    });
    if (state.pos.x === f.stairs.x && state.pos.y === f.stairs.y) {
      log(state, f.objective.done ? "The stairs lead down. Press > (or Descend) to go deeper." : "The stairs are sealed: " + objectiveText(state), "info");
    }
  }

  // Awake, alerted enemies out of sight keep hunting during exploration turns.
  function worldTurn(state) {
    var f = state.floor, v = vision(state), dm = null;
    f.enemies.forEach(function (e) {
      if (!e.awake || !e.alerted || e.hidden || v[idx(e.x, e.y)]) return;
      if (!dm) dm = bfsDist(f, state.pos.x, state.pos.y);
      stepToward(state, e, dm);
    });
  }

  function objectiveText(state) {
    var o = state.floor.objective;
    if (o.type === "stairs") return "Find the stairs down.";
    return "";
  }

  function canDescend(state) {
    var f = state.floor;
    return state.status === "explore" && state.pos.x === f.stairs.x && state.pos.y === f.stairs.y && f.objective.done;
  }

  function descend(state) {
    if (!canDescend(state)) return "You must stand on the open stairs, out of combat.";
    // Stage 1: a single floor; reaching the open stairs wins.
    state.stats.floorsCleared += 1;
    state.status = "victory";
    log(state, "You escape the Gloam.", "good");
    emit("victory", {});
    return null;
  }

  // Single entry point for all player commands. Returns {ok, msg, events}.
  function act(state, a) {
    EV = [];
    var err = null;
    if (state.status === "victory" || state.status === "defeat") err = "The run is over.";
    else if (a.type === "move") err = doMove(state, a.dx | 0, a.dy | 0);
    else if (a.type === "rest") err = doRest(state);
    else if (a.type === "attack") err = doAttack(state, a);
    else if (a.type === "ability") err = doAbility(state, a);
    else if (a.type === "descend") err = descend(state);
    else err = "Unknown action.";
    return { ok: !err, msg: err, events: EV };
  }

  function doMove(state, dx, dy) {
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return "Bad direction.";
    if (state.status === "combat") {
      if (state.combat.moved) return "The party has already moved this phase.";
      var e0 = enemyAt(state, state.pos.x + dx, state.pos.y + dy);
      if (e0) return "An enemy blocks the way. Attack it instead.";
      var err = moveParty(state, dx, dy);
      if (err) return err;
      state.combat.moved = true;
      log(state, currentActor(state).name + " leads the party one step.", "info");
      finishAction(state);
      return null;
    }
    var bump = enemyAt(state, state.pos.x + dx, state.pos.y + dy);
    if (bump) return doAttack(state, { target: bump.id });
    var er = moveParty(state, dx, dy);
    if (er) return er;
    worldTurn(state);
    updateVision(state);
    maybeStartCombat(state);
    return null;
  }

  function doRest(state) {
    if (state.status === "combat") {
      log(state, currentActor(state).name + " waits.", "info");
      finishAction(state);
      return null;
    }
    // Waiting outside combat passes a world turn. It never heals or restores charges.
    state.turn += 1; state.stats.turns += 1;
    worldTurn(state);
    updateVision(state);
    maybeStartCombat(state);
    return null;
  }

  function actingChar(state, a) {
    if (state.status === "combat") return currentActor(state);
    var c = a.actor !== undefined ? charById(state, a.actor) : null;
    return c && !c.down ? c : front(state);
  }

  function doAttack(state, a) {
    var c = actingChar(state, a), e = enemyById(state, a.target);
    if (!c) return "No one can act.";
    var why = basicCheck(state, c, e);
    if (why) return why;
    rollAttack(state, c, e, 1);
    afterAct(state);
    return null;
  }

  // After an action: in combat, pass the turn; outside combat, attacking starts a fight.
  function afterAct(state) {
    if (state.status === "combat") finishAction(state);
    else { state.turn += 1; maybeStartCombat(state); }
  }

  function doAbility(state, a) {
    var c = actingChar(state, a);
    if (!c) return "No one can act.";
    var slot = null;
    for (var i = 0; i < c.abilities.length; i++) if (c.abilities[i].id === a.id) slot = c.abilities[i];
    if (!slot) return "Unknown ability.";
    var A = ABILITIES[slot.id];
    if (A.combat && state.status !== "combat" && A.target !== "enemy") return A.name + " can only be used in combat.";
    if (A.charges > 0 && slot.charges <= 0) return A.name + " has no charges left.";
    var err = useAbility(state, c, slot.id, a);
    if (err) return err;
    if (A.charges > 0) slot.charges -= 1;
    afterAct(state);
    return null;
  }

  function useAbility(state, c, id, a) {
    var e = a.target !== undefined ? enemyById(state, a.target) : null;
    if (id === "shove") {
      if (front(state) !== c) return "Only the front rank can Shove.";
      if (!e || e.hidden || cheb(e.x, e.y, state.pos.x, state.pos.y) > 1) return "Shove needs an adjacent enemy.";
      var dmg = rollAttack(state, c, e, 0.8, { sure: false });
      if (dmg && state.floor.enemies.indexOf(e) >= 0) knockback(state, e, 2);
      return null;
    }
    if (id === "guard") {
      c.st.guard = 1;
      log(state, c.name + " raises a guard over the party.", "info");
      return null;
    }
    return "That ability is not ready.";
  }

  function knockback(state, e, n) {
    var dx = sgn(e.x - state.pos.x), dy = sgn(e.y - state.pos.y);
    for (var i = 0; i < n; i++) {
      var nx = e.x + dx, ny = e.y + dy;
      if (!canStep(state.floor, e.x, e.y, dx, dy) || enemyAt(state, nx, ny)) {
        e.st.stun = 1;
        log(state, ENEMIES[e.type].name + " slams into an obstacle and is stunned.", "good");
        return;
      }
      e.x = nx; e.y = ny;
    }
  }

  // ------------------------------------------------------------------
  // Pathing over known tiles (click-to-travel). Returns the next [dx, dy] or null.
  // ------------------------------------------------------------------
  function knownBlocked(state) {
    var f = state.floor, v = vision(state);
    return function (x, y) {
      if (!isSeen(f, x, y)) return true;
      var e = enemyAt(state, x, y);
      if (e && !e.hidden && v[idx(x, y)]) return true;
      return false;
    };
  }
  function stepTowardTile(state, tx, ty) {
    var f = state.floor;
    if (!isFloor(f, tx, ty) || !isSeen(f, tx, ty)) return null;
    if (tx === state.pos.x && ty === state.pos.y) return null;
    var blocked = knownBlocked(state);
    var dm = bfsDist(f, tx, ty, function (x, y) { return (x !== state.pos.x || y !== state.pos.y) && blocked(x, y); });
    var best = null, bd = dm[idx(state.pos.x, state.pos.y)];
    if (bd < 0) return null;
    for (var i = 0; i < 8; i++) {
      var dx = DIRS[i][0], dy = DIRS[i][1], nx = state.pos.x + dx, ny = state.pos.y + dy;
      if (!canStep(f, state.pos.x, state.pos.y, dx, dy)) continue;
      var d = dm[idx(nx, ny)];
      if (d >= 0 && d < bd) { bd = d; best = [dx, dy]; }
    }
    return best;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------
  var Game = {
    GEN_VERSION: GEN_VERSION, SAVE_VERSION: SAVE_VERSION, MAP_W: MAP_W, MAP_H: MAP_H,
    CLASSES: CLASSES, ABILITIES: ABILITIES, ITEMS: ITEMS, ENEMIES: ENEMIES, THEMES: THEMES,
    hash128: hash128, makeStream: makeStream, rnext: rnext, streamKey: streamKey,
    generateFloor: generateFloor, validateFloorDef: validateFloorDef,
    newRun: newRun, act: act, charStats: charStats, abilityMax: abilityMax,
    front: front, currentActor: currentActor, canSee: canSee, isSeen: isSeen, tileAt: tileAt,
    enemyAt: enemyAt, enemyById: enemyById, intentOf: intentOf, objectiveText: objectiveText,
    canDescend: canDescend, basicCheck: basicCheck, cheb: cheb, stepTowardTile: stepTowardTile
  };
  root.Game = Game;
  if (typeof module !== "undefined" && module.exports) module.exports = Game;
})(typeof globalThis !== "undefined" ? globalThis : this);
