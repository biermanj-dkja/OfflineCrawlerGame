/* The Gloam Below - no-dependency logic tests. Run: node test.js */
"use strict";
var Game = require("./logic.js");

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n       ") : e)); }
}
function assert(c, msg) { if (!c) throw new Error(msg || "assertion failed"); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "expected equal") + ": " + JSON.stringify(a) + " !== " + JSON.stringify(b)); }

function solo() { return [{ cls: "sentinel", name: "Tester" }]; }

console.log("The Gloam Below - logic tests");

test("floor generation is valid and reachable for 100 seeds", function () {
  for (var i = 0; i < 100; i++) {
    var f = Game.generateFloor("seed-" + i, 1);
    var v = Game.validateFloorDef(f);
    assert(v.ok, "seed-" + i + ": " + v.problems.join(", "));
  }
});

test("same seed and floor produce the same layout", function () {
  eq(JSON.stringify(Game.generateFloor("abc", 1)), JSON.stringify(Game.generateFloor("abc", 1)));
});

test("party moves, fog of war reveals tiles", function () {
  var s = Game.newRun({ seed: "move", party: solo() });
  var seen0 = s.floor.seen.join("").split("1").length;
  var moved = false;
  [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
    if (moved) return;
    var r = Game.act(s, { type: "move", dx: d[0], dy: d[1] });
    if (r.ok) moved = true;
  });
  assert(moved, "party could not move");
  assert(s.floor.seen.join("").split("1").length >= seen0, "fog did not persist");
});

test("defeat is reachable", function () {
  var s = Game.newRun({ seed: "doom", party: solo() });
  s.party[0].hp = 1;
  var e = { id: 999, type: "gnawer", x: s.pos.x + 1, y: s.pos.y, hp: 9, maxHp: 9, awake: true, alerted: true, hidden: false, st: {}, xp: 5 };
  s.floor.tiles[s.pos.y] = s.floor.tiles[s.pos.y].slice(0, s.pos.x + 1) + "." + s.floor.tiles[s.pos.y].slice(s.pos.x + 2);
  s.floor.enemies = [e];
  for (var k = 0; k < 200 && s.status !== "defeat"; k++) Game.act(s, { type: "rest" });
  eq(s.status, "defeat");
});

// ---- Scenario helpers ----
var I = Game._internal;
function party(n, classes) {
  classes = classes || ["sentinel", "stalker", "arcanist"];
  var p = [];
  for (var i = 0; i < n; i++) p.push({ cls: classes[i % classes.length], name: "P" + (i + 1) });
  return p;
}
// Open a clear 9x9 room around the party, remove all enemies, and optionally place foes.
function arena(s, foes) {
  var f = s.floor;
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
    return e;
  });
  I.updateVision(s);
  I.maybeStartCombat(s);
  return made;
}
// Attack a foe with whoever can reach it until it dies (party kept alive meanwhile).
function slay(s, e) {
  var god = s.flags.godMode; s.flags.godMode = true;
  for (var k = 0; k < 60 && s.status === "combat" && s.floor.enemies.indexOf(e) >= 0; k++) {
    var who = Game.currentActor(s);
    if (!Game.basicCheck(s, who, e)) Game.act(s, { type: "attack", target: e.id }); else Game.act(s, { type: "rest" });
  }
  s.flags.godMode = god;
  assert(s.floor.enemies.indexOf(e) < 0, "foe should be dead");
}
function actOk(s, a) { var r = Game.act(s, a); assert(r.ok, "action failed: " + JSON.stringify(a) + " -> " + r.msg); return r; }

test("solo, duo and trio parties can be created with any classes", function () {
  [1, 2, 3].forEach(function (n) {
    var s = Game.newRun({ seed: "sizes", party: party(n, ["votary", "votary", "arcanist"]) });
    eq(s.party.length, n);
    eq(Game.front(s), s.party[0]);
    assert(s.status === "explore");
  });
});

test("party size scales enemy count, not enemy HP", function () {
  var a = Game.newRun({ seed: "scale", party: party(1) }), c = Game.newRun({ seed: "scale", party: party(3) });
  assert(a.floor.enemies.length < c.floor.enemies.length, "trio should face more foes");
  var hpA = {}, okHp = true;
  a.floor.enemies.forEach(function (e) { hpA[e.type] = e.maxHp; });
  c.floor.enemies.forEach(function (e) { if (hpA[e.type] && hpA[e.type] !== e.maxHp) okHp = false; });
  assert(okHp, "same enemy type should have the same HP regardless of party size");
});

test("only the front rank may melee; back rank needs reach, ranged or spells", function () {
  var s = Game.newRun({ seed: "rank", party: [{ cls: "stalker", name: "A" }, { cls: "sentinel", name: "B" }] });
  var foes = arena(s, [{ type: "gnawer", dx: 1, dy: 0 }]);
  eq(s.status, "combat");
  // Stalker (front) acts first: its bow works. Sentinel (back) has a sword: melee refused.
  actOk(s, { type: "rest" });
  var r = Game.act(s, { type: "attack", target: foes[0].id });
  assert(!r.ok && /back rank/.test(r.msg), "back-rank melee must be refused: " + r.msg);
});

test("enemy melee targets the front character first; downed front passes to next", function () {
  var s = Game.newRun({ seed: "front", party: party(3) });
  arena(s, [{ type: "gnawer", dx: 1, dy: 0, hp: 500 }]);
  var hp = s.party.map(function (c) { return c.hp; });
  for (var k = 0; k < 6; k++) { actOk(s, { type: "rest" }); actOk(s, { type: "rest" }); actOk(s, { type: "rest" }); }
  assert(s.party[0].hp < hp[0], "front should be bitten");
  eq(s.party[1].hp, hp[1], "back rank should be untouched by melee");
  eq(s.party[2].hp, hp[2], "back rank should be untouched by melee");
  s.party[0].hp = 0; s.party[0].down = true;
  eq(Game.front(s), s.party[1], "next conscious member becomes front");
});

test("shared Move is limited to once per party phase and later actors act from the new tile", function () {
  var s = Game.newRun({ seed: "move1", party: party(3) });
  arena(s, [{ type: "archer", dx: 4, dy: 0, hp: 500 }]);
  eq(s.status, "combat");
  var x0 = s.pos.x;
  actOk(s, { type: "move", dx: 0, dy: 1 });
  eq(s.combat.moved, true);
  eq(s.combat.actor, 1, "move used the first actor's action");
  var r = Game.act(s, { type: "move", dx: 0, dy: 1 });
  assert(!r.ok && /already moved/.test(r.msg), "second move in the phase must be refused");
  eq(s.pos.x, x0);
});

test("full XP to every conscious member; downed members get none", function () {
  var s = Game.newRun({ seed: "xp", party: party(3) });
  var foes = arena(s, [{ type: "gnawer", dx: 1, dy: 0, hp: 1 }]);
  s.party[2].down = true; s.party[2].hp = 0;
  var xp = foes[0].xp;
  slay(s, foes[0]);
  eq(s.party[0].xp, xp); eq(s.party[1].xp, xp); eq(s.party[2].xp, 0);
  var solo1 = Game.newRun({ seed: "xp", party: party(1) });
  var f1 = arena(solo1, [{ type: "gnawer", dx: 1, dy: 0, hp: 1 }]);
  slay(solo1, f1[0]);
  eq(solo1.party[0].xp, xp, "solo receives the same XP, no multiplier");
});

test("post-combat recovery is +10% (min 1) and capped at 50%", function () {
  var s = Game.newRun({ seed: "rec", party: party(2) });
  var foes = arena(s, [{ type: "gnawer", dx: 1, dy: 0, hp: 1 }]);
  var mx = Game.charStats(s.party[0]).maxHp;
  s.party[0].hp = 2; s.party[1].hp = Game.charStats(s.party[1]).maxHp;
  s.flags.godMode = true; // keep HP fixed while the foe is dispatched
  for (var k = 0; k < 40 && s.status === "combat"; k++) {
    var who = Game.currentActor(s);
    if (!Game.basicCheck(s, who, foes[0])) Game.act(s, { type: "attack", target: foes[0].id }); else Game.act(s, { type: "rest" });
  }
  s.flags.godMode = false;
  eq(s.status, "explore");
  eq(s.party[0].hp, 2 + Math.max(1, Math.floor(mx * 0.1)));
  eq(s.party[1].hp, Game.charStats(s.party[1]).maxHp, "above-cap HP is untouched");
  s.party[0].hp = Math.floor(mx * 0.5) - 1;
  Game.postCombatRecovery(s.party[0]);
  eq(s.party[0].hp, Math.floor(mx * 0.5), "recovery stops at 50%");
});

test("equip swaps items through the shared inventory; equipped items take no slot", function () {
  var s = Game.newRun({ seed: "equip", party: party(1) });
  arena(s, []);
  s.inventory = [I.makeItem(s, { base: "maul" })];
  var old = s.party[0].equip.weapon;
  actOk(s, { type: "equip", item: s.inventory[0].id, char: s.party[0].id });
  eq(s.party[0].equip.weapon.base, "maul");
  eq(s.inventory.length, 1); eq(s.inventory[0].id, old.id);
});

test("full inventory produces an explicit choice; leaving keeps the item on the floor", function () {
  var s = Game.newRun({ seed: "full", party: party(1) });
  arena(s, []);
  s.inventory = [];
  for (var i = 0; i < 16; i++) s.inventory.push(I.makeItem(s, { base: "draught" }));
  var it = I.makeItem(s, { base: "glasseye" });
  s.floor.items.push({ x: s.pos.x + 1, y: s.pos.y, item: it });
  actOk(s, { type: "move", dx: 1, dy: 0 });
  assert(s.offer && s.offer.itemId === it.id, "offer expected");
  var r = Game.act(s, { type: "move", dx: -1, dy: 0 });
  assert(!r.ok, "must resolve the offer first");
  actOk(s, { type: "discard", item: s.inventory[0].id });
  eq(s.offer, null);
  assert(s.inventory.some(function (x) { return x.id === it.id; }), "item taken after discarding");
  eq(s.inventory.length, 16);
});

test("level-ups queue one character at a time with 3 choices", function () {
  var s = Game.newRun({ seed: "lvl", party: party(3) });
  arena(s, []);
  I.grantXp(s, 25);
  eq(s.levelQueue.length, 3);
  s.levelQueue.forEach(function (q) { eq(q.options.length, 3); });
  var r = Game.act(s, { type: "move", dx: 1, dy: 0 });
  assert(!r.ok, "must choose before moving");
  var firstChar = s.levelQueue[0].charId;
  actOk(s, { type: "choose", option: s.levelQueue[0].options[0] });
  eq(s.levelQueue.length, 2);
  assert(s.levelQueue[0].charId !== firstChar);
});

test("abilities spend charges; descending recovers half the missing charges (rounded up)", function () {
  var s = Game.newRun({ seed: "charges", party: [{ cls: "arcanist", name: "M" }] });
  var c = s.party[0];
  c.abilities[0].charges = 0; // ember max 4 -> recovers 2
  c.abilities[1].charges = 1; // rime max 2 -> recovers 1
  I.floorRecovery(s);
  eq(c.abilities[0].charges, 2); eq(c.abilities[1].charges, 2);
});

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
