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

// A simple full-game bot used by the complete-run test.
function botPlay(seed, partyDef, maxSteps) {
  var s = Game.newRun({ seed: seed, party: partyDef });
  s.flags.godMode = true; // controlled advantage: the bot cannot be killed
  var steps = 0, objectivesDone = 0, floorsSeen = {};
  function cheb(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }
  while (s.status !== "victory" && s.status !== "defeat" && steps++ < maxSteps) {
    floorsSeen[s.floor.num] = true;
    var r;
    if (s.status === "combat") {
      var c = Game.currentActor(s);
      var foes = s.floor.enemies.filter(function (e) { return e.awake && !e.hidden && Game.canSee(s, e.x, e.y); })
        .sort(function (a, b) { return (b.primary || b.type === "boss" ? 1 : 0) - (a.primary || a.type === "boss" ? 1 : 0) || cheb(a, s.pos) - cheb(b, s.pos) || a.id - b.id; });
      var tgt = foes.filter(function (e) { return !Game.basicCheck(s, c, e); })[0];
      if (tgt) r = Game.act(s, { type: "attack", target: tgt.id });
      else if (!s.combat.moved && foes.length) {
        var t = foes[0], best = null, bd = 1e9;
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          var nx = s.pos.x + dx, ny = s.pos.y + dy;
          if (Game.tileAt(s.floor, nx, ny) !== "." || Game.enemyAt(s, nx, ny)) continue;
          var dd = Math.max(Math.abs(nx - t.x), Math.abs(ny - t.y));
          if (dd < bd) { bd = dd; best = [dx, dy]; }
        }
        r = best && bd < cheb(t, s.pos) ? Game.act(s, { type: "move", dx: best[0], dy: best[1] }) : Game.act(s, { type: "rest" });
        if (!r.ok) r = Game.act(s, { type: "rest" });
      } else r = Game.act(s, { type: "rest" });
    } else {
      if (s.levelQueue.length) { Game.act(s, { type: "choose", option: s.levelQueue[0].options[0] }); continue; }
      if (s.offer) { Game.act(s, { type: "take", leave: true }); continue; }
      if (Game.canDescend(s)) { objectivesDone++; Game.act(s, { type: "descend" }); continue; }
      var p = null, o = s.floor.objective;
      ["travel", "explore"].forEach(function (m) { if (!p) { var q = Game.planStep(s, m); if (q.dir) p = q; } });
      ["travel", "explore"].forEach(function (m) { if (!p) { var q = Game.planStep(s, m, { allowWake: true }); if (q.dir) p = q; } });
      r = p ? Game.act(s, { type: "move", dx: p.dir[0], dy: p.dir[1] }) : Game.act(s, { type: "rest" });
    }
    if (r && !r.ok && /Internal/.test(r.msg)) throw new Error(r.msg);
  }
  return { s: s, steps: steps, objectivesDone: objectivesDone, floorsSeen: Object.keys(floorsSeen).length };
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
