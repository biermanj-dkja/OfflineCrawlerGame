/* The Gloam Below - no-dependency logic tests. Run: node test.js */
"use strict";
var Game = require("./logic.js");
var I = Game._internal;

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : e)); }
}
function assert(c, msg) { if (!c) throw new Error(msg || "assertion failed"); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "expected equal") + ": " + JSON.stringify(a) + " !== " + JSON.stringify(b)); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }

// ---------------------------------------------------------------- helpers
function party(n, classes) {
  classes = classes || ["sentinel", "stalker", "arcanist"];
  var p = [];
  for (var i = 0; i < n; i++) p.push({ cls: classes[i % classes.length], name: "P" + (i + 1) });
  return p;
}
// Open a clear 9x9 room around the party, remove all foes, and optionally place new ones.
function arena(s, foes) {
  var f = s.floor;
  s.pos = { x: 20, y: 13 };
  for (var y = s.pos.y - 4; y <= s.pos.y + 4; y++) for (var x = s.pos.x - 4; x <= s.pos.x + 4; x++) {
    if (x < 1 || y < 1 || x > f.w - 2 || y > f.h - 2) continue;
    f.tiles[y] = f.tiles[y].slice(0, x) + "." + f.tiles[y].slice(x + 1);
  }
  f.enemies = []; f.items = []; f.features = [];
  s.status = "explore"; s.combat = null;
  var made = (foes || []).map(function (d) {
    var e = I.spawnEnemy(s, d.type, s.pos.x + d.dx, s.pos.y + d.dy, {});
    if (d.asleep) e.awake = false;
    if (d.hp) { e.hp = d.hp; e.maxHp = Math.max(e.maxHp, d.hp); }
    if (d.hidden) e.hidden = true;
    return e;
  });
  I.updateVision(s);
  I.maybeStartCombat(s);
  return made;
}
function actOk(s, a) { var r = Game.act(s, a); assert(r.ok, "action failed: " + JSON.stringify(a) + " -> " + r.msg); return r; }
// Attack a foe with whoever can reach it until it dies (party kept alive meanwhile).
function slay(s, e) {
  var god = s.flags.godMode; s.flags.godMode = true;
  for (var k = 0; k < 80 && s.status === "combat" && s.floor.enemies.indexOf(e) >= 0; k++) {
    var who = Game.currentActor(s);
    if (!Game.basicCheck(s, who, e)) Game.act(s, { type: "attack", target: e.id }); else Game.act(s, { type: "rest" });
  }
  s.flags.godMode = god;
  assert(s.floor.enemies.indexOf(e) < 0, "foe should be dead");
}

// A simple deterministic bot: one call = one game action. Used by the full-run and save/restore tests.
function cheb(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }
function stepBot(s) {
  if (s.status === "combat") {
    var c = Game.currentActor(s);
    var foes = s.floor.enemies.filter(function (e) { return e.awake && !e.hidden && Game.canSee(s, e.x, e.y); })
      .sort(function (a, b) { return (b.primary || b.type === "boss" ? 1 : 0) - (a.primary || a.type === "boss" ? 1 : 0) || cheb(a, s.pos) - cheb(b, s.pos) || a.id - b.id; });
    var tgt = foes.filter(function (e) { return !Game.basicCheck(s, c, e); })[0];
    if (tgt) return Game.act(s, { type: "attack", target: tgt.id });
    if (!s.combat.moved && foes.length) {
      var t = foes[0], best = null, bd = 1e9;
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        var nx = s.pos.x + dx, ny = s.pos.y + dy;
        if (Game.tileAt(s.floor, nx, ny) !== "." || Game.enemyAt(s, nx, ny)) continue;
        var dd = Math.max(Math.abs(nx - t.x), Math.abs(ny - t.y));
        if (dd < bd) { bd = dd; best = [dx, dy]; }
      }
      var r = best && bd < cheb(t, s.pos) ? Game.act(s, { type: "move", dx: best[0], dy: best[1] }) : null;
      if (r && r.ok) return r;
    }
    return Game.act(s, { type: "rest" });
  }
  if (s.levelQueue.length) return Game.act(s, { type: "choose", option: s.levelQueue[0].options[0] });
  if (s.offer) return Game.act(s, { type: "take", leave: true });
  if (Game.canDescend(s)) return Game.act(s, { type: "descend" });
  var p = null;
  ["travel", "explore"].forEach(function (m) { if (!p) { var q = Game.planStep(s, m); if (q.dir) p = q; } });
  ["travel", "explore"].forEach(function (m) { if (!p) { var q = Game.planStep(s, m, { allowWake: true }); if (q.dir) p = q; } });
  return p ? Game.act(s, { type: "move", dx: p.dir[0], dy: p.dir[1] }) : Game.act(s, { type: "rest" });
}
function botPlay(seed, partyDef, maxSteps) {
  var s = Game.newRun({ seed: seed, party: partyDef });
  s.flags.godMode = true; // controlled advantage: the bot cannot be killed
  var steps = 0, objectivesDone = 0;
  while (s.status !== "victory" && s.status !== "defeat" && steps++ < maxSteps) {
    var floor = s.floor.num;
    var r = stepBot(s);
    if (s.floor.num > floor) objectivesDone++;
    if (r && !r.ok && /Internal/.test(r.msg)) throw new Error(r.msg);
  }
  return { s: s, steps: steps, objectivesDone: objectivesDone };
}
console.log("The Gloam Below - logic tests (generator " + Game.GEN_VERSION + ")");

// ---------------------------------------------------------------- generation
test("1. 100 run seeds: every floor validates; objectives, gates, wardens, relics, stairs, braziers and boss are reachable", function () {
  var counts = { stairs: 0, gate: 0, warden: 0, relic: 0, boss: 0 };
  for (var i = 0; i < 100; i++) {
    for (var n = 1; n <= Game.LAST_FLOOR; n++) {
      var f = Game.generateFloor("seed-" + i, n);
      var v = Game.validateFloorDef(f);
      assert(v.ok, "seed-" + i + " floor " + n + ": " + v.problems.join(", "));
      counts[f.objective.type]++;
      if (f.objective.type === "gate") assert(f.enemies.some(function (e) { return e.primary && e.type === "gate"; }), "gate floor without a primary gate");
      if (f.objective.type === "warden") assert(f.enemies.some(function (e) { return e.type === "warden" && e.minParty === 1; }), "warden missing");
      if (f.objective.type === "relic") assert(f.features.some(function (ft) { return ft.kind === "relic"; }), "relic missing");
      if (n === Game.LAST_FLOOR) { eq(f.objective.type, "boss"); assert(f.enemies.some(function (e) { return e.type === "boss"; }), "boss missing"); }
      else assert(f.stairs, "normal floor without stairs");
    }
  }
  assert(counts.gate && counts.warden && counts.relic && counts.stairs, "every objective type appears: " + JSON.stringify(counts));
});

test("2. same seed + version + floor gives the same floor regardless of runtime RNG use on earlier floors", function () {
  var a = Game.newRun({ seed: "stable", party: party(2) });
  var b = Game.newRun({ seed: "stable", party: party(2) });
  for (var k = 0; k < 500; k++) Game._internal.rnd(b); // burn runtime RNG on run b
  b.stats.kills = 99;
  var fa = Game.generateFloor(a.seed, 4), fb = Game.generateFloor(b.seed, 4);
  eq(JSON.stringify(fa), JSON.stringify(fb), "floor 4 differs");
  // Instantiating floors after different play histories yields the same layout and placements.
  I.enterFloor(a, 3); I.enterFloor(b, 3);
  eq(JSON.stringify(a.floor.tiles), JSON.stringify(b.floor.tiles));
  eq(JSON.stringify(a.floor.enemies.map(function (e) { return [e.type, e.x, e.y]; })), JSON.stringify(b.floor.enemies.map(function (e) { return [e.type, e.x, e.y]; })));
  eq(JSON.stringify(a.floor.items.map(function (g) { return [g.x, g.y, g.item.base]; })), JSON.stringify(b.floor.items.map(function (g) { return [g.x, g.y, g.item.base]; })));
});

test("3. different floor numbers derive independent generation streams", function () {
  var keys = {};
  for (var n = 1; n <= Game.LAST_FLOOR; n++) {
    var st = Game.makeStream(Game.streamKey("indep", "floor", n)).join(",");
    assert(!keys[st], "floor " + n + " stream collides");
    keys[st] = 1;
  }
  assert(JSON.stringify(Game.generateFloor("indep", 2).tiles) !== JSON.stringify(Game.generateFloor("indep", 3).tiles), "floors 2 and 3 identical");
  // Version is part of every key.
  assert(Game.streamKey("x", "floor", 1).indexOf(Game.GEN_VERSION) === 0);
});

// ---------------------------------------------------------------- combat
test("6a. exploration: party moves as one tile; fog of war remembers explored tiles", function () {
  var s = Game.newRun({ seed: "move", party: party(3) });
  arena(s, []);
  var seen0 = s.floor.seen.join("").split("1").length;
  actOk(s, { type: "move", dx: 1, dy: 0 });
  assert(s.floor.seen.join("").split("1").length >= seen0, "fog did not persist");
  eq(s.party.length, 3);
});

test("6b. shared Move: once per party phase; later actors act from the new tile", function () {
  var s = Game.newRun({ seed: "move1", party: party(3) });
  arena(s, [{ type: "archer", dx: 3, dy: 0, hp: 500 }]);
  eq(s.status, "combat");
  var x0 = s.pos.x, y0 = s.pos.y;
  actOk(s, { type: "move", dx: 0, dy: 1 });
  eq(s.combat.moved, true); eq(s.combat.actor, 1, "move used the first actor's action");
  eq(s.pos.y, y0 + 1, "party moved");
  var r = Game.act(s, { type: "move", dx: 0, dy: 1 });
  assert(!r.ok && /already moved/.test(r.msg), "second move in the phase must be refused");
  eq(s.pos.y, y0 + 1); eq(s.pos.x, x0);
  // Second actor (stalker, bow) attacks from the new location.
  var foe = s.floor.enemies[0];
  assert(!Game.basicCheck(s, s.party[1], foe), "back-rank bow can attack from new tile");
});

test("6c. basic attacks, abilities spend charges, enemy actions happen in the enemy phase", function () {
  var s = Game.newRun({ seed: "abil", party: [{ cls: "arcanist", name: "M" }, { cls: "votary", name: "V" }] });
  var foes = arena(s, [{ type: "gnawer", dx: 2, dy: 0, hp: 200 }]);
  var c = s.party[0], before = c.abilities[0].charges, hp0 = foes[0].hp;
  actOk(s, { type: "ability", id: "ember", target: foes[0].id });
  eq(c.abilities[0].charges, before - 1);
  assert(foes[0].hp < hp0, "ember damaged the foe");
  assert(foes[0].st.dot, "ember burns");
  var pos0 = [foes[0].x, foes[0].y];
  actOk(s, { type: "ability", id: "hex", target: foes[0].id });
  assert(foes[0].x !== pos0[0] || foes[0].y !== pos0[1] || Game.cheb(foes[0].x, foes[0].y, s.pos.x, s.pos.y) <= 1, "enemy acted (moved) in the enemy phase");
  eq(s.combat.round, 2);
});

test("6d. formation: only the front rank melees; enemy melee hits the front; downed front passes to next", function () {
  var s = Game.newRun({ seed: "rank", party: [{ cls: "stalker", name: "A" }, { cls: "sentinel", name: "B" }, { cls: "votary", name: "C" }] });
  var foes = arena(s, [{ type: "gnawer", dx: 1, dy: 0, hp: 900 }]);
  actOk(s, { type: "rest" });
  var r = Game.act(s, { type: "attack", target: foes[0].id });
  assert(!r.ok && /back rank/.test(r.msg), "back-rank sword melee must be refused: " + r.msg);
  assert(!Game.basicCheck(s, s.party[2], foes[0]), "back-rank reach weapon may attack an adjacent foe");
  var hp = s.party.map(function (c) { return c.hp; });
  for (var k = 0; k < 6; k++) { actOk(s, { type: "rest" }); actOk(s, { type: "rest" }); actOk(s, { type: "rest" }); }
  assert(s.party[0].hp < hp[0], "front should be bitten");
  eq(s.party[1].hp, hp[1], "back rank untouched by melee");
  eq(s.party[2].hp, hp[2], "back rank untouched by melee");
  s.party[0].hp = 0; s.party[0].down = true;
  eq(Game.front(s), s.party[1], "next conscious member becomes front");
  var r2 = Game.act(s, { type: "reorder", from: 0, to: 2 });
  assert(!r2.ok, "formation is locked in combat");
});

test("6e. sleeping enemies: no turns, wake by awareness range, by attack, and by noise", function () {
  var s = Game.newRun({ seed: "sleep", party: party(2) });
  var foes = arena(s, [{ type: "gaoler", dx: 4, dy: 0, asleep: true }]);
  eq(s.status, "explore", "sleepers do not start combat");
  var g = foes[0], p0 = [g.x, g.y];
  actOk(s, { type: "rest" }); actOk(s, { type: "rest" });
  eq(g.x, p0[0]); assert(!g.awake, "still asleep");
  actOk(s, { type: "move", dx: 1, dy: 0 }); // distance 3: still outside awareness 2
  assert(!g.awake, "outside awareness");
  actOk(s, { type: "move", dx: 1, dy: 0 }); // distance 2: wakes
  assert(g.awake, "woke within awareness range");
  eq(s.status, "combat");
  // Attack wakes.
  var s2 = Game.newRun({ seed: "sleep2", party: [{ cls: "stalker", name: "K" }] });
  var f2 = arena(s2, [{ type: "ooze", dx: 4, dy: 0, asleep: true, hp: 300 }]);
  actOk(s2, { type: "attack", target: f2[0].id, actor: s2.party[0].id });
  assert(f2[0].awake, "attack wakes"); eq(s2.status, "combat");
  // Noise wakes (Challenge is noisy).
  var s3 = Game.newRun({ seed: "sleep3", party: [{ cls: "sentinel", name: "S" }] });
  var f3 = arena(s3, [{ type: "gnawer", dx: -2, dy: 0, hp: 300 }, { type: "gaoler", dx: 4, dy: 3, asleep: true }]);
  actOk(s3, { type: "ability", id: "challenge" });
  assert(f3[1].awake, "noise wakes the sleeper");
});

test("6f. hidden ambusher strikes first when revealed; combat then begins with the party phase", function () {
  var s = Game.newRun({ seed: "lurk", party: party(3) });
  var foes = arena(s, [{ type: "lurker", dx: 3, dy: 0, hidden: true, hp: 300 }]);
  eq(s.status, "explore");
  assert(!Game.canSee(s, 0, 0) || true);
  var dealt0 = s.stats.dmgTaken + s.log.length;
  actOk(s, { type: "move", dx: 1, dy: 0 }); // now within 2 tiles
  assert(!foes[0].hidden, "revealed");
  assert(s.log.some(function (l) { return /AMBUSH/.test(l.m); }), "ambush logged");
  eq(s.status, "combat"); eq(s.combat.round, 1); eq(s.combat.actor, 0, "party phase begins");
});

test("6g. character downing, post-combat recovery (+10%, min 1, cap 50%) and floor recovery", function () {
  var s = Game.newRun({ seed: "rec", party: party(3) });
  var foes = arena(s, [{ type: "gnawer", dx: 1, dy: 0, hp: 1 }]);
  var a = s.party[0], b = s.party[1], c = s.party[2];
  var mxA = Game.charStats(a).maxHp, mxC = Game.charStats(c).maxHp;
  a.hp = 2; b.hp = 0; b.down = true; c.hp = mxC;
  slay(s, foes[0]);
  eq(s.status, "explore");
  eq(a.hp, 2 + Math.max(1, Math.floor(mxA * 0.1)), "front recovers 10%");
  eq(b.hp, 0, "downed members do not recover after combat"); assert(b.down);
  eq(c.hp, mxC, "above-cap HP untouched");
  a.hp = Math.floor(mxA * 0.5) - 1;
  Game.postCombatRecovery(a);
  eq(a.hp, Math.floor(mxA * 0.5), "recovery stops at 50%");
  Game.postCombatRecovery(a);
  eq(a.hp, Math.floor(mxA * 0.5), "no further recovery above the cap");
  // Floor transition: downed revive at 25%, others +25%, charges recover half missing (rounded up).
  a.hp = 10;
  c.abilities[0].charges = 0; c.abilities[1].charges = 1;
  var m0 = Game.abilityMax(c, c.abilities[0].id), m1 = Game.abilityMax(c, c.abilities[1].id);
  I.floorRecovery(s);
  assert(!b.down); eq(b.hp, Math.floor(Game.charStats(b).maxHp * 0.25));
  eq(a.hp, Math.min(mxA, 10 + Math.floor(mxA * 0.25)));
  eq(c.abilities[0].charges, Math.ceil(m0 / 2), "half of missing, rounded up");
  eq(c.abilities[1].charges, Math.min(m1, 1 + Math.ceil((m1 - 1) / 2)));
});

test("6h. defeat on total party wipe", function () {
  var s = Game.newRun({ seed: "doom", party: party(2) });
  arena(s, [{ type: "gnawer", dx: 1, dy: 0, hp: 999 }, { type: "archer", dx: 3, dy: 0, hp: 999 }]);
  s.party.forEach(function (c) { c.hp = 1; });
  for (var k = 0; k < 400 && s.status !== "defeat"; k++) Game.act(s, { type: "rest" });
  eq(s.status, "defeat");
  var r = Game.act(s, { type: "rest" });
  assert(!r.ok, "no actions after defeat");
});

test("6i. victory: destroying the boss sets status to victory", function () {
  var s = Game.newRun({ seed: "boss", party: party(3) });
  I.enterFloor(s, Game.LAST_FLOOR);
  var boss = s.floor.enemies.filter(function (e) { return e.type === "boss"; })[0];
  assert(boss, "boss present");
  s.pos = { x: boss.x - 1, y: boss.y };
  var others = s.floor.enemies.filter(function (e) { return e !== boss; });
  others.forEach(function (o) { s.floor.enemies.splice(s.floor.enemies.indexOf(o), 1); });
  I.updateVision(s); I.maybeStartCombat(s);
  eq(s.status, "combat");
  boss.hp = Math.ceil(boss.maxHp * 0.6);
  for (var k = 0; k < 3; k++) Game.act(s, { type: "rest" });
  eq(Game.bossPhase(boss), 2, "phase 2 below two thirds");
  boss.hp = 1;
  slay(s, boss);
  eq(s.status, "victory");
});

test("6j. objectives: gate and warden kills complete them; relic must reach the stairs", function () {
  var found = { gate: 0, warden: 0, relic: 0 };
  for (var i = 0; i < 40 && (!found.gate || !found.warden || !found.relic); i++) {
    for (var n = 2; n <= 6; n++) {
      var s = Game.newRun({ seed: "obj-" + i, party: party(3) });
      I.enterFloor(s, n);
      var o = s.floor.objective;
      if (found[o.type] || o.type === "stairs") continue;
      assert(!o.done, "objective starts incomplete");
      s.status = "explore";
      s.pos = { x: s.floor.stairs.x, y: s.floor.stairs.y };
      assert(!Game.canDescend(s), "stairs sealed until the objective is complete");
      if (o.type === "relic") {
        var rl = s.floor.features.filter(function (ft) { return ft.kind === "relic"; })[0];
        s.floor.enemies = [];
        s.pos = { x: rl.x, y: rl.y }; I.updateVision(s);
        I.enterTile(s);
        assert(o.carried && !o.done, "carried but not delivered");
        s.pos = { x: s.floor.stairs.x, y: s.floor.stairs.y };
        I.enterTile(s);
        assert(o.done, "delivered at the stairs");
      } else {
        var t = s.floor.enemies.filter(function (e) { return o.type === "gate" ? e.primary : e.type === "warden"; })[0];
        s.floor.enemies = [t];
        s.pos = { x: s.floor.stairs.x, y: s.floor.stairs.y };
        t.hp = 1;
        I.killEnemy(s, t, null);
        assert(o.done, o.type + " objective complete");
      }
      assert(/./.test(Game.objectiveText(s)));
      found[o.type] = 1;
    }
  }
  assert(found.gate && found.warden && found.relic, "found all objective types: " + JSON.stringify(found));
});

// ---------------------------------------------------------------- parties and XP
test("7. solo, duo and trio parties with any classes (duplicates allowed)", function () {
  [1, 2, 3].forEach(function (n) {
    var s = Game.newRun({ seed: "sizes", party: party(n, ["votary", "votary", "votary"]) });
    eq(s.party.length, n);
    eq(Game.front(s), s.party[0]);
    eq(s.status, "explore");
  });
  var a = Game.newRun({ seed: "scale", party: party(1) }), c = Game.newRun({ seed: "scale", party: party(3) });
  var countA = 0, countC = 0;
  for (var n = 1; n <= 6; n++) { I.enterFloor(a, n); I.enterFloor(c, n); countA += a.floor.enemies.length; countC += c.floor.enemies.length; }
  assert(countA < countC, "larger parties face more foes (" + countA + " vs " + countC + ")");
  var hpA = {}, okHp = true;
  a.floor.enemies.forEach(function (e) { hpA[e.type] = e.maxHp; });
  c.floor.enemies.forEach(function (e) { if (e.type !== "boss" && hpA[e.type] && hpA[e.type] !== e.maxHp) okHp = false; });
  assert(okHp, "same enemy type has the same HP regardless of party size");
});

test("8. every conscious member receives the full enemy XP; never divided; downed get none", function () {
  var s = Game.newRun({ seed: "xp", party: party(3) });
  var foes = arena(s, [{ type: "gnawer", dx: 1, dy: 0, hp: 1 }]);
  s.party[2].down = true; s.party[2].hp = 0;
  var xp = foes[0].xp;
  assert(xp > 0);
  slay(s, foes[0]);
  eq(s.party[0].xp, xp); eq(s.party[1].xp, xp); eq(s.party[2].xp, 0);
  var solo = Game.newRun({ seed: "xp", party: party(1) });
  var f1 = arena(solo, [{ type: "gnawer", dx: 1, dy: 0, hp: 1 }]);
  slay(solo, f1[0]);
  eq(solo.party[0].xp, xp, "solo receives the same XP, no multiplier");
  // Simultaneous level-ups resolve one character at a time.
  var t = Game.newRun({ seed: "lvl", party: party(3) });
  arena(t, []);
  I.grantXp(t, 25);
  eq(t.levelQueue.length, 3);
  assert(!Game.act(t, { type: "move", dx: 1, dy: 0 }).ok, "must choose before moving");
  var first = t.levelQueue[0].charId;
  actOk(t, { type: "choose", option: t.levelQueue[0].options[0] });
  eq(t.levelQueue.length, 2); assert(t.levelQueue[0].charId !== first);
});

// ---------------------------------------------------------------- items
test("equipment and inventory: swap through the shared 16 slots; full inventory asks", function () {
  var s = Game.newRun({ seed: "equip", party: party(1) });
  arena(s, []);
  s.inventory = [I.makeItem(s, { base: "maul" })];
  var old = s.party[0].equip.weapon;
  actOk(s, { type: "equip", item: s.inventory[0].id, char: s.party[0].id });
  eq(s.party[0].equip.weapon.base, "maul"); eq(s.inventory.length, 1); eq(s.inventory[0].id, old.id);
  s.inventory = [];
  for (var i = 0; i < 16; i++) s.inventory.push(I.makeItem(s, { base: "draught" }));
  var it = I.makeItem(s, { base: "glasseye" });
  s.floor.items.push({ x: s.pos.x + 1, y: s.pos.y, item: it });
  actOk(s, { type: "move", dx: 1, dy: 0 });
  assert(s.offer && s.offer.itemId === it.id, "offer expected");
  assert(!Game.act(s, { type: "move", dx: -1, dy: 0 }).ok, "must resolve the offer first");
  actOk(s, { type: "discard", item: s.inventory[0].id });
  eq(s.offer, null); eq(s.inventory.length, 16);
  assert(s.inventory.some(function (x) { return x.id === it.id; }));
  assert(Object.keys(Game.ITEMS).length >= 30, "at least 30 items");
  assert(Object.keys(Game.ITEMS).filter(function (k) { return Game.ITEMS[k].unique; }).length >= 5, "at least 5 uniques");
});

// ---------------------------------------------------------------- exploits
test("11. spawner output cannot create unlimited meaningful XP", function () {
  var s = Game.newRun({ seed: "gate", party: party(3) });
  var foes = arena(s, [{ type: "gate", dx: 3, dy: 0, hp: 99999 }]);
  var gate = foes[0];
  s.flags.godMode = true;
  var xp0 = s.party[0].xp, spawned = 0;
  for (var k = 0; k < 600; k++) {
    var grubs = s.floor.enemies.filter(function (e) { return e.type === "grub"; });
    var who = Game.currentActor(s);
    if (!who) break;
    var tgt = grubs.filter(function (e) { return !Game.basicCheck(s, who, e); })[0];
    if (tgt) Game.act(s, { type: "attack", target: tgt.id }); else Game.act(s, { type: "rest" });
  }
  eq(s.party[0].xp, xp0, "grubs give no XP");
  assert(gate.spawned <= Game.ENEMIES.gate.total, "gate spawn total is capped");
  eq(gate.spawned, Game.ENEMIES.gate.total, "gate exhausted its spawns");
  s.floor.enemies.forEach(function (e) { if (e.type === "grub") eq(e.xp, 0); });
});

test("12. walking, waiting and resting cannot produce health or charge recovery", function () {
  var s = Game.newRun({ seed: "rest", party: party(3, ["arcanist", "votary", "stalker"]) });
  arena(s, []);
  s.party.forEach(function (c) { c.hp = 3; c.abilities.forEach(function (a) { a.charges = 0; }); });
  for (var k = 0; k < 300; k++) { Game.act(s, { type: "rest" }); Game.act(s, { type: "move", dx: k % 2 ? 1 : -1, dy: 0 }); }
  s.party.forEach(function (c) {
    eq(c.hp, 3, "no healing from walking/resting");
    c.abilities.forEach(function (a) { eq(a.charges, 0, "no charges from walking/resting"); });
  });
  // Repeated post-combat recovery is capped at 50%.
  var c0 = s.party[0], mx = Game.charStats(c0).maxHp;
  for (var j = 0; j < 50; j++) Game.postCombatRecovery(c0);
  eq(c0.hp, Math.floor(mx * 0.5));
});

// ---------------------------------------------------------------- saves
// Start a fight on an untouched generated floor (layout must stay valid for import).
function realFight(s, types) {
  s.floor.enemies = [];
  var spots = [];
  for (var y = 0; y < s.floor.h; y++) for (var x = 0; x < s.floor.w; x++) {
    var d = Math.max(Math.abs(x - s.pos.x), Math.abs(y - s.pos.y));
    if (d >= 1 && d <= 4 && Game.tileAt(s.floor, x, y) === "." && Game.canSee(s, x, y)) spots.push([d, x, y]);
  }
  spots.sort(function (a, b) { return a[0] - b[0] || a[2] - b[2] || a[1] - b[1]; });
  types.forEach(function (t, i) { var sp = spots[i]; I.spawnEnemy(s, t, sp[1], sp[2], {}); });
  I.updateVision(s); I.maybeStartCombat(s);
}
function playedRun(seed, partyDef, steps) {
  var s = Game.newRun({ seed: seed, party: partyDef });
  s.flags.godMode = true;
  for (var k = 0; k < steps && s.status !== "victory"; k++) stepBot(s);
  s.flags = {};
  return s;
}

test("4. export/import preserves essential state and all RNG state", function () {
  [[1, 120], [2, 400], [3, 900]].forEach(function (cfg) {
    var s = playedRun("save-" + cfg[0], party(cfg[0], ["votary", "arcanist", "sentinel"]), cfg[1]);
    var txt = Game.exportRun(s);
    var o = JSON.parse(txt);
    ["saveVersion", "genVersion", "seed", "rng", "party", "inventory", "floor", "pos", "combat", "story", "status", "levelQueue", "turn", "nextId"].forEach(function (k) {
      assert(k in o, "export contains " + k);
    });
    var r = Game.importRun(txt);
    assert(r.ok, "import ok: " + r.error);
    eq(JSON.stringify(r.state), JSON.stringify(s), "round trip is exact");
    eq(r.state.rng.runtime.join(","), s.rng.runtime.join(","), "runtime RNG state");
    eq(r.state.floor.seen.join(""), s.floor.seen.join(""), "fog of war");
  });
  // Mid-combat snapshot keeps round, actor and turn state.
  var c = Game.newRun({ seed: "save-combat", party: party(3) });
  realFight(c, ["archer", "gnawer"]);
  eq(c.status, "combat");
  actOk(c, { type: "rest" });
  c.flags = {};
  var rc = Game.importRun(Game.exportRun(c));
  assert(rc.ok, rc.error);
  eq(rc.state.status, "combat"); eq(rc.state.combat.actor, 1); eq(rc.state.combat.round, c.combat.round);
});

test("5. after restoring a save, future combat and loot outcomes match the uninterrupted run", function () {
  var a = playedRun("cont-1", party(3, ["stalker", "sentinel", "votary"]), 350);
  var snap = Game.exportRun(a);
  var b = Game.importRun(snap).state;
  a.flags.godMode = true; b.flags.godMode = true;
  var logA = [], logB = [];
  for (var k = 0; k < 700; k++) {
    var ra = stepBot(a), rb = stepBot(b);
    logA.push(JSON.stringify(ra.events)); logB.push(JSON.stringify(rb.events));
  }
  eq(logA.join("|"), logB.join("|"), "event streams identical");
  a.flags = {}; b.flags = {};
  eq(JSON.stringify(a), JSON.stringify(b), "states identical after 700 more actions");
  // Also from inside a fight.
  var c = Game.newRun({ seed: "cont-2", party: party(2) });
  realFight(c, ["gnawer", "archer", "ooze"]);
  c.flags = {};
  var restored = Game.importRun(Game.exportRun(c));
  assert(restored.ok, restored.error);
  var d = restored.state;
  for (var j = 0; j < 30; j++) { stepBot(c); stepBot(d); }
  eq(JSON.stringify(c), JSON.stringify(d), "combat continuation identical");
});

test("9. malformed, incompatible, oversized and invalid imports are rejected without altering the current game", function () {
  var cur = playedRun("guard", party(2), 200);
  var before = JSON.stringify(cur);
  var good = JSON.parse(Game.exportRun(cur));
  function mut(fn) { var o = clone(good); fn(o); return JSON.stringify(o); }
  var bad = {
    "not json": "{ this is not json",
    "empty": "",
    "array": "[]",
    "wrong format": mut(function (o) { o.format = "something-else"; }),
    "old save version": mut(function (o) { o.saveVersion = 0; }),
    "other generator": mut(function (o) { o.genVersion = "GB-GEN-0"; }),
    "missing party": mut(function (o) { delete o.party; }),
    "four members": mut(function (o) { o.party.push(clone(o.party[0])); }),
    "unknown class": mut(function (o) { o.party[0].cls = "bard"; }),
    "hp over max": mut(function (o) { o.party[0].hp = 99999; }),
    "negative xp": mut(function (o) { o.party[0].xp = -5; }),
    "level/xp mismatch": mut(function (o) { o.party[0].level = 9; }),
    "charges over max": mut(function (o) { o.party[0].abilities[0].charges = 99; }),
    "foreign ability": mut(function (o) { o.party[0].abilities[0].id = o.party[0].cls === "arcanist" ? "mend" : "ember"; }),
    "17 items": mut(function (o) { o.inventory = []; for (var i = 0; i < 17; i++) o.inventory.push({ id: 900000 + i, base: "draught", rarity: "common", affixes: [] }); }),
    "unknown item": mut(function (o) { o.inventory = [{ id: 999999, base: "laser", rarity: "common", affixes: [] }]; }),
    "fake unique": mut(function (o) { o.inventory = [{ id: 999999, base: "sword", rarity: "unique", affixes: [] }]; }),
    "rng wrong length": mut(function (o) { o.rng.runtime = [1, 2, 3]; }),
    "rng not numbers": mut(function (o) { o.rng.runtime = ["a", "b", "c", "d"]; }),
    "party inside wall": mut(function (o) { var f = o.floor; outer: for (var y = 0; y < f.h; y++) for (var x = 0; x < f.w; x++) if (f.tiles[y][x] === "#") { o.pos = { x: x, y: y }; break outer; } }),
    "tampered layout": mut(function (o) { var r = o.floor.tiles[1]; o.floor.tiles[1] = (r[1] === "#" ? "." : "#") + r.slice(1); o.floor.tiles[1] = r.slice(0, 1) + (r[1] === "#" ? "." : "#") + r.slice(2); }),
    "bad map row": mut(function (o) { o.floor.tiles[0] = "<script>"; }),
    "floor 99": mut(function (o) { o.floor.num = 99; }),
    "story mismatch": mut(function (o) { o.story.boss = "Someone Else"; }),
    "html name with control chars": mut(function (o) { o.party[0].name = "\u0001<img src=x onerror=alert(1)>"; }),
    "overlong name": mut(function (o) { o.party[0].name = new Array(200).join("A"); }),
    "unexpected field": mut(function (o) { o.evil = "function(){}"; }),
    "debug flag": mut(function (o) { o.flags = { godMode: true }; }),
    "combat without combat state": mut(function (o) { o.status = "combat"; o.combat = null; }),
    "status junk": mut(function (o) { o.status = "winning"; }),
    "proto pollution": Game.exportRun(cur).replace('"format"', '"__proto__": {"polluted": true}, "format"'),
    "oversized": "{\"pad\":\"" + new Array(Game.MAX_IMPORT_BYTES + 10).join("x") + "\"}"
  };
  Object.keys(bad).forEach(function (k) {
    var r = Game.importRun(bad[k]);
    assert(!r.ok, "should reject: " + k);
    assert(typeof r.error === "string" && r.error.length > 10, "helpful message for " + k);
  });
  assert(/2 MiB/.test(Game.importRun(bad.oversized).error), "size message mentions the limit");
  assert(({}).polluted === undefined, "no prototype pollution");
  eq(JSON.stringify(cur), before, "the current game is untouched");
  assert(Game.importRun(Game.exportRun(cur)).ok, "the untouched game still exports cleanly");
});

test("seeds: entered seeds are cleaned; daily seed is the UTC date; daily runs are identical for everyone", function () {
  eq(Game.dailySeed(new Date(Date.UTC(2026, 9, 2, 23, 30))), "2026-10-02");
  eq(Game.dailySeed(new Date(Date.UTC(2026, 0, 5, 0, 1))), "2026-01-05");
  assert(!Game.cleanSeed("   ").ok); assert(!Game.cleanSeed(new Array(40).join("x")).ok);
  eq(Game.cleanSeed("  Moth Wing ").seed, "Moth Wing");
  var d = Game.dailySeed(new Date(Date.UTC(2026, 9, 2)));
  var a = Game.newRun({ seed: d, daily: true, party: party(2) }), b = Game.newRun({ seed: d, daily: true, party: party(2) });
  eq(JSON.stringify(a.floor), JSON.stringify(b.floor), "same daily floor");
  eq(Game.suggestName(d, 0, 0), Game.suggestName(d, 0, 0), "same suggested names");
  for (var n = 1; n <= Game.LAST_FLOOR; n++) eq(JSON.stringify(Game.generateFloor(d, n)), JSON.stringify(Game.generateFloor(d, n)));
});
// ---------------------------------------------------------------- full game
test("10. simulated complete game: a bot clears every floor objective, defeats the boss and reaches victory", function () {
  [["stalker", "sentinel", "votary"], ["arcanist"]].forEach(function (cls, k) {
    var res = botPlay("bot-run-" + k, cls.map(function (c, i) { return { cls: c, name: "Bot" + i }; }), 30000);
    eq(res.s.status, "victory", "bot " + cls.join("+") + " finished floor " + res.s.floor.num + " after " + res.steps + " steps");
    eq(res.objectivesDone, Game.LAST_FLOOR - 1, "every normal floor objective completed and descended");
    eq(res.s.floor.num, Game.LAST_FLOOR);
    eq(res.s.floor.objective.done, true);
  });
});

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
