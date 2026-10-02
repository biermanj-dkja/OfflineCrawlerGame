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

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
