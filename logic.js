/* The Gloam Below - core game logic.
 * Rules, procedural generation, deterministic RNG, state transitions and save
 * validation live here. No DOM access: this file runs in browsers as a classic
 * script (global `Game`) and in Node (module.exports = Game). */
(function (root) {
  "use strict";

  var GEN_VERSION = "GB-GEN-1";
  var SAVE_VERSION = 1;
  var MAP_W = 40, MAP_H = 26, VIEW_R = 8;
  var LAST_FLOOR = 7;
  var INV_SIZE = 16;
  var SLOTS = ["weapon", "armor", "offhand", "charm"];
  var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];

  // ------------------------------------------------------------------
  // Deterministic RNG. sfc32 over a 4 x uint32 state array that is stored
  // directly in the game state, so saving the array saves the stream.
  // Streams:  floor|n   - per-floor generation (stateless, re-derived per floor)
  //           plan      - run-wide plan: themes, objectives, unique placement
  //           story     - mission text
  //           names|i|k - suggested character names
  //           runtime   - combat rolls, drops, AI choices (saved in state.rng.runtime)
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
  function rweighted(s, pairs) {
    var tot = 0, i;
    for (i = 0; i < pairs.length; i++) tot += pairs[i][1];
    var r = rnext(s) * tot;
    for (i = 0; i < pairs.length; i++) { r -= pairs[i][1]; if (r < 0) return pairs[i][0]; }
    return pairs[pairs.length - 1][0];
  }
  // Every stream key includes the generator version so generation changes are explicit.
  function streamKey(seed, purpose, n) {
    return GEN_VERSION + "|" + seed + "|" + purpose + (n === undefined ? "" : "|" + n);
  }

  // ------------------------------------------------------------------
  // Classes, abilities, upgrades
  // ------------------------------------------------------------------
  var CLASSES = {
    sentinel: {
      name: "Sentinel", role: "Front-line guardian", glyph: "S", color: "#e9c986",
      blurb: "Durable and steady. Holds the front rank, shoves foes into walls and draws their attacks.",
      strengths: "High HP and armour; controls enemy position; can patch the party up with Rally.",
      weaknesses: "Short reach: from the back rank a sword cannot strike.",
      base: { hp: 36, pow: 6, wil: 2, arm: 2, acc: 82, eva: 5 }, per: { hp: 7, pow: 1, wil: 0 },
      start: { weapon: "sword", armor: "ringmail", offhand: "buckler", charm: null },
      abilities: ["shove", "challenge", "guard"], stats: ["s_hp", "s_pow", "s_acc"]
    },
    stalker: {
      name: "Stalker", role: "Scout and marksman", glyph: "K", color: "#8fe0a0",
      blurb: "Quick and precise. Shoots from either rank, lays caltrops, and slips the party out of trouble.",
      strengths: "Ranged damage from any rank; +50% damage against stunned, rooted or sleeping foes.",
      weaknesses: "Light armour; modest HP.",
      base: { hp: 26, pow: 5, wil: 3, arm: 1, acc: 88, eva: 14 }, per: { hp: 5, pow: 1, wil: 0 },
      start: { weapon: "shortbow", armor: "jerkin", offhand: null, charm: null },
      abilities: ["aimed", "caltrops", "slip"], stats: ["s_pow", "s_acc", "s_eva"]
    },
    arcanist: {
      name: "Arcanist", role: "Elemental caster", glyph: "A", color: "#9cc0ff",
      blurb: "Fragile and devastating. Hurls embers, freezes crowds, and floods dark places with light.",
      strengths: "Area damage and crowd control; strongest burst in the game.",
      weaknesses: "Lowest HP and no armour; limited spell charges.",
      base: { hp: 21, pow: 2, wil: 7, arm: 0, acc: 85, eva: 8 }, per: { hp: 4, pow: 0, wil: 1 },
      start: { weapon: "ashstaff", armor: "robes", offhand: null, charm: null },
      abilities: ["ember", "rime", "flare"], stats: ["s_wil", "s_hp", "s_eva"]
    },
    votary: {
      name: "Votary", role: "Healer and hexer", glyph: "V", color: "#ffb0d8",
      blurb: "A keeper of small mercies and petty curses. Mends wounds, wards allies and hexes the strong.",
      strengths: "Healing above the half-health recovery cap; shields; damage-amplifying curses.",
      weaknesses: "Low damage on its own; relies on limited charges.",
      base: { hp: 27, pow: 4, wil: 6, arm: 1, acc: 82, eva: 6 }, per: { hp: 5, pow: 0, wil: 1 },
      start: { weapon: "bellstaff", armor: "vestments", offhand: null, charm: null },
      abilities: ["mend", "ward", "hex"], stats: ["s_wil", "s_hp", "s_acc"]
    }
  };

  // target: enemy | ally | tile | none.  combat: only usable in combat.  free: does not end the turn.
  var ABILITIES = {
    shove: { name: "Shove", charges: 3, target: "enemy", range: 1, frontOnly: true,
      desc: "Front rank only. Strike an adjacent foe (80% damage) and knock it back 2 tiles. If it hits a wall or another body, it is stunned for 1 round." },
    challenge: { name: "Challenge", charges: 3, target: "none", combat: true, noise: 6,
      desc: "Noisy. Every awake foe within 5 tiles that you can see must target you for 2 rounds. You gain +2 armour for 2 rounds." },
    guard: { name: "Guard", charges: 0, target: "none", combat: true,
      desc: "Unlimited. Until your next party phase: +3 armour, and you intercept single-target attacks aimed at back-rank allies." },
    cleave: { name: "Cleave", charges: 2, target: "none", frontOnly: true, combat: true,
      desc: "Front rank only. Strike every adjacent foe for 90% weapon damage." },
    rally: { name: "Rally", charges: 2, target: "none",
      desc: "Every conscious ally recovers 20% of max HP (at least 4). Can exceed the half-health cap. Usable outside combat." },
    aimed: { name: "Aimed Shot", charges: 3, target: "enemy", range: 7,
      desc: "Range 7. A careful shot: +25 accuracy, double damage, ignores armour. Usable from either rank." },
    caltrops: { name: "Caltrops", charges: 2, target: "tile", range: 4, combat: true,
      desc: "Scatter spikes on a visible floor tile within 4. The first foe to step there takes damage and is rooted for 2 rounds." },
    slip: { name: "Slip", charges: 3, target: "none", combat: true, free: true,
      desc: "Free action. This phase's shared Move will not use up the Stalker's action. Requires the Move to still be available." },
    volley: { name: "Volley", charges: 2, target: "none", combat: true,
      desc: "Fire at up to 3 different awake, visible foes (nearest first) within 6 tiles, or your ranged weapon's range if longer, for 80% damage each." },
    smoke: { name: "Smoke Pot", charges: 2, target: "none", combat: true,
      desc: "Foes within 2 tiles are blinded for 2 rounds: -40 accuracy." },
    ember: { name: "Ember Bolt", charges: 4, target: "enemy", range: 6, spell: true,
      desc: "Range 6. Fire damage (3-6 + Will) and sets the target burning for 2 rounds (2 per round)." },
    rime: { name: "Rime Burst", charges: 2, target: "none", combat: true, spell: true,
      desc: "Frost bursts outward: every foe within 2 tiles takes 2-4 + Will/2 damage and is frozen (stunned) for 1 round." },
    flare: { name: "Lumen Flare", charges: 2, target: "tile", range: 6, spell: true, noise: 6,
      desc: "Noisy. Floods a radius-2 area with light: those tiles become Lit, hidden things are revealed, shadow-kin take heavy damage and other foes are blinded for 1 round." },
    chain: { name: "Chain Spark", charges: 3, target: "enemy", range: 6, spell: true,
      desc: "Range 6. Lightning (3-5 + Will) that jumps to up to 2 more foes within 3 tiles for 70% damage." },
    glyph: { name: "Binding Glyph", charges: 2, target: "enemy", range: 6, spell: true,
      desc: "Range 6. Roots the target and every foe adjacent to it for 2 rounds and deals 2 damage to each." },
    mend: { name: "Mend", charges: 3, target: "ally", spell: true,
      desc: "Heal one ally for 7-10 + Will. Can exceed the half-health cap. Usable outside combat." },
    ward: { name: "Ward", charges: 2, target: "ally", combat: true, spell: true,
      desc: "Shield one ally: absorbs 8 + Will damage for 3 rounds." },
    hex: { name: "Hex", charges: 3, target: "enemy", range: 6, spell: true,
      desc: "Range 6. Curse a foe for 3 rounds: it takes +50% damage and deals 30% less." },
    litany: { name: "Litany", charges: 2, target: "none", spell: true,
      desc: "Every conscious ally heals 4-6 + Will/2. Usable outside combat." },
    sanctify: { name: "Sanctify", charges: 2, target: "none", combat: true, spell: true,
      desc: "Consecrate a radius-2 area around the party: tiles become Lit, shadow-kin there take 5 + Will damage, and the party gains +2 armour for 2 rounds." }
  };

  // Level-up choices. kind: learn | upgrade | passive | stat.
  var UPGRADES = {
    learn_cleave: { cls: "sentinel", kind: "learn", ability: "cleave", name: "Learn Cleave", desc: ABILITIES.cleave.desc },
    learn_rally: { cls: "sentinel", kind: "learn", ability: "rally", name: "Learn Rally", desc: ABILITIES.rally.desc },
    up_shove: { cls: "sentinel", kind: "upgrade", ability: "shove", name: "Concussive Shove", desc: "Shove always stuns its target for 1 round, and gains +1 max charge." },
    up_challenge: { cls: "sentinel", kind: "upgrade", ability: "challenge", name: "Unbroken Challenge", desc: "Challenge also heals you 3 HP per foe taunted (up to 9), and gains +1 max charge." },
    up_guard: { cls: "sentinel", kind: "upgrade", ability: "guard", name: "Aegis", desc: "While you Guard, area attacks deal half damage to the whole party." },
    p_bulwark: { cls: "sentinel", kind: "passive", name: "Bulwark", desc: "Passive: +2 armour and +6 max HP." },
    p_riposte: { cls: "sentinel", kind: "passive", name: "Riposte", desc: "Passive: when a melee attack misses you, strike back for 60% weapon damage." },
    learn_volley: { cls: "stalker", kind: "learn", ability: "volley", name: "Learn Volley", desc: ABILITIES.volley.desc },
    learn_smoke: { cls: "stalker", kind: "learn", ability: "smoke", name: "Learn Smoke Pot", desc: ABILITIES.smoke.desc },
    up_aimed: { cls: "stalker", kind: "upgrade", ability: "aimed", name: "Pinning Shot", desc: "Aimed Shot also roots its target for 2 rounds, and gains +1 max charge." },
    up_caltrops: { cls: "stalker", kind: "upgrade", ability: "caltrops", name: "Barbed Caltrops", desc: "Caltrops deal +4 damage, and gain +1 max charge." },
    up_slip: { cls: "stalker", kind: "upgrade", ability: "slip", name: "Fade", desc: "Slip also grants +25 evasion until your next party phase, and gains +1 max charge." },
    p_venom: { cls: "stalker", kind: "passive", name: "Venom", desc: "Passive: basic attacks poison the target (2 damage per round for 2 rounds)." },
    p_keeneye: { cls: "stalker", kind: "passive", name: "Keen Eye", desc: "Passive: +10 accuracy; basic attacks have a 10% chance to deal double damage." },
    learn_chain: { cls: "arcanist", kind: "learn", ability: "chain", name: "Learn Chain Spark", desc: ABILITIES.chain.desc },
    learn_glyph: { cls: "arcanist", kind: "learn", ability: "glyph", name: "Learn Binding Glyph", desc: ABILITIES.glyph.desc },
    up_ember: { cls: "arcanist", kind: "upgrade", ability: "ember", name: "Ember Lance", desc: "Ember Bolt pierces: it strikes every foe on the line to the target. +1 max charge." },
    up_rime: { cls: "arcanist", kind: "upgrade", ability: "rime", name: "Deep Rime", desc: "Rime Burst reaches 3 tiles, and gains +1 max charge." },
    up_flare: { cls: "arcanist", kind: "upgrade", ability: "flare", name: "Dawnflare", desc: "Lumen Flare covers radius 3 and blinds for 2 rounds. +1 max charge." },
    p_reservoir: { cls: "arcanist", kind: "passive", name: "Reservoir", desc: "Passive: +1 max charge to every spell you know." },
    p_kindling: { cls: "arcanist", kind: "passive", name: "Kindling", desc: "Passive: your burns last 2 rounds longer and deal +1 damage per round." },
    learn_litany: { cls: "votary", kind: "learn", ability: "litany", name: "Learn Litany", desc: ABILITIES.litany.desc },
    learn_sanctify: { cls: "votary", kind: "learn", ability: "sanctify", name: "Learn Sanctify", desc: ABILITIES.sanctify.desc },
    up_mend: { cls: "votary", kind: "upgrade", ability: "mend", name: "Greater Mend", desc: "Mend heals 4 more. +1 max charge." },
    up_ward: { cls: "votary", kind: "upgrade", ability: "ward", name: "Bastion Ward", desc: "Ward absorbs 6 more damage. +1 max charge." },
    up_hex: { cls: "votary", kind: "upgrade", ability: "hex", name: "Spreading Hex", desc: "Hex also curses every foe adjacent to the target. +1 max charge." },
    p_martyr: { cls: "votary", kind: "passive", name: "Martyrdom", desc: "Passive: whenever you heal another ally, you also heal 3." },
    p_censure: { cls: "votary", kind: "passive", name: "Censure", desc: "Passive: foes you hex take 3 damage at the start of each of their turns." },
    s_hp: { kind: "stat", name: "Toughness", desc: "+7 max HP.", stat: "hp", v: 7 },
    s_pow: { kind: "stat", name: "Might", desc: "+1 Power (weapon damage).", stat: "pow", v: 1 },
    s_wil: { kind: "stat", name: "Resolve", desc: "+1 Will (spell power).", stat: "wil", v: 1 },
    s_acc: { kind: "stat", name: "Precision", desc: "+6 accuracy.", stat: "acc", v: 6 },
    s_eva: { kind: "stat", name: "Footwork", desc: "+5 evasion.", stat: "eva", v: 5 }
  };

  // ------------------------------------------------------------------
  // Items. Every item takes one inventory slot. No weight, durability or ammunition.
  // kind: melee (front rank only) | reach (either rank, range 2) | ranged / focus (either rank)
  // ------------------------------------------------------------------
  var ITEMS = {
    sword: { name: "Notched Sword", slot: "weapon", kind: "melee", dmg: [3, 6], stat: "pow", tier: 1, desc: "Old steel, honestly sharpened." },
    blade: { name: "Barrow Blade", slot: "weapon", kind: "melee", dmg: [4, 8], stat: "pow", tier: 2, desc: "Taken from a grave that did not object." },
    maul: { name: "Maul", slot: "weapon", kind: "melee", dmg: [5, 9], stat: "pow", mods: { acc: -8 }, special: "stagger", tier: 2, desc: "Heavy. 15% chance to stun on hit." },
    knife: { name: "Fang Knife", slot: "weapon", kind: "melee", dmg: [2, 5], stat: "pow", mods: { acc: 10 }, special: "crit", tier: 1, desc: "Quick. 15% chance to deal double damage." },
    spear: { name: "Ash Spear", slot: "weapon", kind: "reach", dmg: [3, 6], stat: "pow", tier: 1, desc: "Reach: strikes foes up to 2 tiles away, from either rank." },
    glaive: { name: "Hook Glaive", slot: "weapon", kind: "reach", dmg: [4, 8], stat: "pow", mods: { acc: -5 }, tier: 2, desc: "Reach: strikes foes up to 2 tiles away, from either rank." },
    shortbow: { name: "Shortbow", slot: "weapon", kind: "ranged", range: 6, dmg: [2, 5], stat: "pow", tier: 1, desc: "Ranged 6. Usable from either rank." },
    longbow: { name: "Yew Longbow", slot: "weapon", kind: "ranged", range: 7, dmg: [3, 7], stat: "pow", mods: { acc: -3 }, tier: 2, desc: "Ranged 7. Usable from either rank." },
    sling: { name: "Leaden Sling", slot: "weapon", kind: "ranged", range: 5, dmg: [3, 5], stat: "pow", tier: 1, desc: "Ranged 5. Usable from either rank." },
    ashstaff: { name: "Ash Staff", slot: "weapon", kind: "focus", range: 5, dmg: [2, 4], stat: "wil", tier: 1, desc: "Focus 5: a weak bolt scaled by Will, from either rank." },
    wand: { name: "Cinder Wand", slot: "weapon", kind: "focus", range: 6, dmg: [3, 5], stat: "wil", special: "burn", tier: 2, desc: "Focus 6. 25% chance to set the target burning." },
    bellstaff: { name: "Bell-Staff", slot: "weapon", kind: "reach", dmg: [2, 4], stat: "wil", mods: { wil: 1 }, tier: 1, desc: "Reach 2, scaled by Will. Its bell has no clapper." },
    jerkin: { name: "Padded Jerkin", slot: "armor", mods: { arm: 1, eva: 3 }, tier: 1, desc: "Quilted and quiet." },
    ringmail: { name: "Ring Mail", slot: "armor", mods: { arm: 2 }, tier: 1, desc: "Links of dull iron." },
    brigandine: { name: "Brigandine", slot: "armor", mods: { arm: 3, eva: -4 }, tier: 2, desc: "Riveted plates under cloth." },
    robes: { name: "Threadbare Robes", slot: "armor", mods: { wil: 1, eva: 2 }, tier: 1, desc: "Embroidered with sigils, mostly moth holes." },
    vestments: { name: "Votive Vestments", slot: "armor", mods: { arm: 1, wil: 1 }, tier: 1, desc: "Stiff with old incense." },
    cloak: { name: "Gloam Cloak", slot: "armor", mods: { arm: 1, eva: 7 }, tier: 2, desc: "Hard to look at directly." },
    buckler: { name: "Buckler", slot: "offhand", mods: { arm: 1, eva: 3 }, tier: 1, desc: "A small round shield." },
    tower: { name: "Tower Shield", slot: "offhand", mods: { arm: 3, eva: -6 }, tier: 2, desc: "A door with a handle." },
    tome: { name: "Cracked Grimoire", slot: "offhand", mods: { wil: 2 }, tier: 1, desc: "Several pages are only margins." },
    lantern: { name: "Hooded Lantern", slot: "offhand", mods: { acc: 3 }, special: "lantern", tier: 1, desc: "Reveals hidden foes within 3 tiles." },
    parry: { name: "Parrying Knife", slot: "offhand", mods: { eva: 6 }, tier: 1, desc: "For the hand that is not busy." },
    bonecharm: { name: "Knucklebone Charm", slot: "charm", mods: { hp: 6 }, tier: 1, desc: "Someone's luck, strung on gut." },
    glasseye: { name: "Glass Eye", slot: "charm", mods: { acc: 6 }, tier: 1, desc: "It follows you around the room." },
    moth: { name: "Moth Brooch", slot: "charm", mods: { eva: 6 }, tier: 1, desc: "Wings of tarnished silver." },
    ironring: { name: "Iron Ring", slot: "charm", mods: { arm: 1 }, tier: 1, desc: "Cold. It never warms." },
    hexsigil: { name: "Hex Sigil", slot: "charm", mods: { wil: 2 }, tier: 2, desc: "A knot that hurts to follow." },
    draught: { name: "Healing Draught", slot: "use", use: "ally", tier: 1, desc: "Heals one ally for 50% of max HP. Can exceed the half-health cap." },
    salts: { name: "Waking Salts", slot: "use", use: "downed", tier: 1, desc: "Revives a downed ally at 25% HP. Outside combat only." },
    bomb: { name: "Flask Bomb", slot: "use", use: "enemy", range: 5, tier: 1, desc: "Noisy. Throw within 5: 8 damage (+1 per floor) to the target and every foe adjacent to it." },
    tonic: { name: "Ember Tonic", slot: "use", use: "ally", tier: 2, desc: "Restores 1 charge to every ability of one ally." },
    vial: { name: "Lumen Vial", slot: "use", use: "none", tier: 1, desc: "Light floods radius 2 around the party: tiles become Lit, hidden foes are revealed, shadow-kin take 6 damage." },
    scroll: { name: "Surveyor's Scroll", slot: "use", use: "none", tier: 1, desc: "Reveals this floor's layout (but not its inhabitants)." },
    // Uniques: named, build-defining, never randomly affixed.
    hearthbreaker: { name: "Hearthbreaker", slot: "weapon", kind: "melee", dmg: [6, 10], stat: "pow", mods: { pow: 2, acc: -5 }, special: "knock", unique: true,
      desc: "Every hit knocks the target back 1 tile; foes knocked into walls or bodies are stunned.", lore: "A smith's hammer that once settled a dispute permanently." },
    needle: { name: "The Patient Needle", slot: "weapon", kind: "ranged", range: 7, dmg: [3, 7], stat: "pow", mods: { acc: 5 }, special: "fullhp", unique: true,
      desc: "Basic attacks against foes at full health deal triple damage.", lore: "It has waited a long time. It can wait for you to aim." },
    secondmouths: { name: "Grimoire of Second Mouths", slot: "offhand", mods: { wil: 3, hp: -6 }, special: "echo", unique: true,
      desc: "Damaging spells echo: a second strike hits another visible foe for half damage.", lore: "Read it aloud and something else reads along." },
    martyrlantern: { name: "Martyr's Lantern", slot: "offhand", mods: { wil: 1, arm: 1 }, special: "lantern martyrheal", unique: true,
      desc: "Reveals hidden foes within 3. When the bearer heals anyone, every other conscious ally heals 3.", lore: "The wick is a finger bone. Nobody asks whose." },
    ossuaryplate: { name: "Ossuary Plate", slot: "armor", mods: { arm: 5, eva: -10 }, special: "thorns", unique: true,
      desc: "Foes that strike the wearer in melee take 3 damage.", lore: "Assembled from many previous owners." },
    halo: { name: "The Secondhand Halo", slot: "charm", mods: { hp: -4 }, special: "halo", unique: true,
      desc: "+1 max charge to every limited ability.", lore: "Previously owned. Mind the dents; do not ask about the scorch mark." },
    coconut: { name: "Clattering Coconut Halves", slot: "charm", mods: { eva: 8, acc: 4 }, unique: true,
      desc: "+8 evasion, +4 accuracy.", lore: "Struck together, they sound like a horse. You are fairly sure there is no horse." }
  };
  var FIST = { name: "Bare Hands", kind: "melee", dmg: [1, 3], stat: "pow" };
  var UNIQUE_IDS = ["hearthbreaker", "needle", "secondmouths", "martyrlantern", "ossuaryplate", "halo", "coconut"];

  var AFFIXES = {
    keen: { name: "Keen", pre: true, slots: ["weapon", "charm"], stat: "acc", r: [4, 8] },
    brutal: { name: "Brutal", pre: true, slots: ["weapon"], stat: "pow", r: [1, 2] },
    whisper: { name: "Whispering", pre: true, slots: ["weapon", "offhand", "charm"], stat: "wil", r: [1, 2] },
    warded: { name: "Warded", pre: true, slots: ["armor", "offhand"], stat: "arm", r: [1, 1] },
    lucent: { name: "Lucent", pre: true, slots: ["weapon"], special: "lucent", r: [1, 1], desc: "+50% damage to shadow-kin" },
    leech: { name: "Leeching", pre: true, slots: ["weapon"], special: "leech", r: [1, 2], desc: "heal {v} on hit" },
    fox: { name: "of the Fox", slots: ["armor", "charm", "offhand"], stat: "eva", r: [3, 6] },
    vigor: { name: "of Vigor", slots: ["armor", "charm", "offhand"], stat: "hp", r: [5, 9] },
    embers: { name: "of Embers", slots: ["weapon"], special: "burn", r: [1, 1], desc: "25% chance to burn on hit" },
    echoes: { name: "of Echoes", slots: ["charm", "offhand"], special: "echoes", r: [1, 1], desc: "+1 max charge to your first ability" },
    mending: { name: "of Mending", slots: ["charm", "offhand", "armor"], special: "mending", r: [2, 3], desc: "your heals restore +{v}" }
  };
  var RARITY = {
    common: { name: "Common", mark: "", affixes: 0 },
    magic: { name: "Magic", mark: "+", affixes: 1 },
    rare: { name: "Rare", mark: "++", affixes: 2 },
    unique: { name: "Unique", mark: "*", affixes: 0 }
  };

  // ------------------------------------------------------------------
  // Enemies
  // ------------------------------------------------------------------
  // ai values are distinct behaviours, not stat variants. minFloor gates where a type first appears.
  var ENEMIES = {
    gnawer: { name: "Gnawer", glyph: "r", hp: 9, dmg: [2, 4], acc: 75, eva: 10, arm: 0, xp: 5, ai: "melee", fast: true, minFloor: 1,
      desc: "Fast melee pursuer: moves 2 tiles a turn. A hairless, hungry thing that rushes the front rank and bites." },
    archer: { name: "Bone Archer", glyph: "a", hp: 8, dmg: [2, 5], acc: 75, eva: 5, arm: 0, xp: 7, ai: "ranged", range: 7, keep: 3, minFloor: 1,
      desc: "Ranged (7). Keeps 3+ tiles away and shoots any party member it can see. Backs away when you close in." },
    ooze: { name: "Mire Ooze", glyph: "O", hp: 15, dmg: [2, 4], acc: 70, eva: 0, arm: 0, xp: 6, ai: "melee", split: "oozeling", asleep: true, aware: 3, minFloor: 1,
      desc: "Splitter. Starts dormant and wakes if you come within 3 tiles. When destroyed it splits into two Oozelings." },
    oozeling: { name: "Oozeling", glyph: "o", hp: 6, dmg: [1, 3], acc: 70, eva: 5, arm: 0, xp: 2, ai: "melee", minFloor: 99,
      desc: "Melee pursuer. A fragment of a Mire Ooze." },
    gaoler: { name: "Gaoler", glyph: "J", hp: 24, dmg: [4, 8], acc: 78, eva: 0, arm: 2, xp: 16, ai: "brute", asleep: true, aware: 2, minFloor: 2,
      desc: "Heavy sleeper. Asleep until you come within 2 tiles, attack it, or make noise nearby. Slow: moves only every other round, but hits hard." },
    charger: { name: "Ironhorn", glyph: "C", hp: 16, dmg: [3, 5], charge: [7, 10], acc: 80, eva: 0, arm: 1, xp: 12, ai: "charger", minFloor: 2,
      desc: "Charger. With a straight, clear line to the party (3-6 tiles) it lowers its horns - the line is marked - and charges next turn. Step off the line and it crashes, stunned." },
    bloat: { name: "Ember Bloat", glyph: "B", hp: 10, dmg: [0, 0], blast: [5, 8], acc: 100, eva: 0, arm: 0, xp: 7, ai: "bloat", minFloor: 2,
      desc: "Exploder. Drifts toward the party. When adjacent it swells (marked !) and bursts on its next turn, burning EVERY party member. Kill it first or step away." },
    acolyte: { name: "Murk Acolyte", glyph: "h", hp: 10, dmg: [1, 3], acc: 75, eva: 5, arm: 0, xp: 9, ai: "healer", range: 5, keep: 3, heal: 6, minFloor: 2,
      desc: "Healer. Hangs back; every few turns it heals the most wounded ally within 5 or shrouds one (+2 armour). Otherwise flings weak bolts. Kill it first." },
    lurker: { name: "Lurker", glyph: "L", hp: 13, dmg: [3, 6], ambush: [4, 7], acc: 80, eva: 10, arm: 0, xp: 10, ai: "melee", lurk: true, minFloor: 2,
      desc: "Ambusher. Hides unseen on deep-shadow (hatched) ground. When the party comes within 2 tiles it erupts with an AMBUSH strike on a random party member before you can act. Light or a lantern reveals it." },
    shade: { name: "Shade", glyph: "s", hp: 10, dmg: [3, 5], acc: 80, eva: 20, arm: 0, xp: 9, ai: "shade", shadow: true, minFloor: 2,
      desc: "Shadow-kin. Moves 2 tiles a turn when starting on dark ground. On lit ground it loses its evasion and burns for 3 each turn, so it avoids light." },
    husk: { name: "Shield-Husk", glyph: "H", hp: 18, dmg: [2, 4], acc: 75, eva: 0, arm: 3, xp: 10, ai: "defender", minFloor: 3,
      desc: "Defender. Stays beside its ward and intercepts single-target attacks aimed at it. Area effects get past it." },
    gate: { name: "Spawning Gate", glyph: "Ω", hp: 22, dmg: [0, 0], acc: 0, eva: 0, arm: 2, xp: 14, ai: "gate", structure: true, every: 3, cap: 3, total: 8, minFloor: 99,
      desc: "Spawner. While the party is within 8 tiles it births a Gate-Grub every 3 turns (3 alive at most, 8 in total). Grubs are worth no XP. Destroy the gate." },
    grub: { name: "Gate-Grub", glyph: "g", hp: 5, dmg: [1, 3], acc: 70, eva: 5, arm: 0, xp: 0, ai: "melee", minFloor: 99,
      desc: "Melee pursuer spawned by a gate. Worth no XP." },
    warden: { name: "Warden", glyph: "W", hp: 34, dmg: [4, 7], acc: 80, eva: 5, arm: 2, xp: 30, ai: "warden", minFloor: 99,
      desc: "Floor warden. Every third turn it winds up a SWEEP (marked !) that strikes every party member next turn if the party is still adjacent." },
    boss: { name: "The Unlit", glyph: "Ψ", hp: 80, dmg: [5, 8], bolt: [4, 7], nova: [8, 12], acc: 85, eva: 5, arm: 2, xp: 0, ai: "boss", shadow: true, minFloor: 99,
      desc: "The final threat. Phase 1: claws or bolts, and summons Shades (more for larger parties). Phase 2 (below 2/3 HP): marks a 3x3 NOVA beside the party that bursts next turn; one step away escapes it. Phase 3 (below 1/3): closes in and strikes, twice if it starts its turn next to you. Takes +50% damage on lit ground." }
  };

  var THEMES = {
    ossuary: { name: "Ossuary", pool: ["gnawer", "archer", "gaoler", "charger", "husk", "ooze"], hazard: "spikes", dark: 0.2, lit: 0.15,
      wall: "#4a4452", floor: "#1b181e", accent: "#cfc6b0" },
    cistern: { name: "Drowned Cistern", pool: ["gnawer", "ooze", "lurker", "archer", "acolyte"], hazard: "brine", dark: 0.35, lit: 0.1,
      wall: "#2e4248", floor: "#111a1d", accent: "#7fc0c8" },
    foundry: { name: "Ember Foundry", pool: ["bloat", "charger", "husk", "gnawer", "archer"], hazard: "cinders", dark: 0.1, lit: 0.35,
      wall: "#54362a", floor: "#1d1411", accent: "#ff9a50" },
    chapel: { name: "Umbral Chapel", pool: ["shade", "acolyte", "lurker", "husk", "archer", "gaoler"], hazard: "vent", dark: 0.5, lit: 0.1,
      wall: "#3a2e4e", floor: "#120f19", accent: "#b89cff" },
    throne: { name: "The Hollow Throne", pool: [], hazard: "vent", dark: 1, lit: 0, wall: "#2a2030", floor: "#0e0b12", accent: "#ffd36b" }
  };
  var HAZARDS = {
    spikes: { name: "Bone Spikes", glyph: "^", dmg: 3, desc: "Bone spikes. Every party member takes damage when the party steps here." },
    brine: { name: "Brine Pool", glyph: "~", dmg: 2, desc: "Scalding brine. Every party member takes damage when the party steps here." },
    cinders: { name: "Cinder Grate", glyph: "^", dmg: 4, desc: "A grate of live cinders. Every party member takes damage when the party steps here." },
    vent: { name: "Gloam Vent", glyph: "~", dmg: 3, desc: "A vent breathing cold shadow. Every party member takes damage when the party steps here." }
  };
  var SHRINES = {
    mending: { name: "Shrine of the Patient Saint", desc: "One use. Heals every party member by 50% of max HP and revives the downed at 25%." },
    embers: { name: "Ember Shrine", desc: "One use. Restores 1 charge to every ability of every party member." },
    whet: { name: "Whetstone Altar", desc: "One use. Each party member permanently gains +1 to their main stat (Power or Will)." },
    bargain: { name: "Shrine of Dubious Bargains", desc: "One use. Each conscious member loses a quarter of their current HP; the shrine pays in a magic or rare item." }
  };
  // Room flavour. Mostly grim; about one in ten is a sly, misremembered nod to 1980s geek culture.
  var ROOM_NAMES = {
    ossuary: [["The Sorted", "The Listening", "The Swept", "The Nameless"], ["Charnel", "Vault", "Gallery", "Niche-Hall"]],
    cistern: [["The Dripping", "The Warm", "The Chained", "The Sunken"], ["Basin", "Sluice", "Reservoir", "Culvert"]],
    foundry: [["The Cracked", "The Breathing", "The Guilty", "The Cooling"], ["Forge", "Casting Pit", "Slag Hall", "Bellworks"]],
    chapel: [["The Backward", "The Unlit", "The Waiting", "The Blinded"], ["Nave", "Chantry", "Vestry", "Choir"]]
  };
  var ROOM_TEXT = {
    ossuary: ["Skulls are stacked by size, then by expression.", "The bones here are arranged as if listening.", "A chapel of femurs. Someone keeps it swept.",
      "Every plaque has had its name chiselled away.", "Dust, and under the dust, footprints that only go one way."],
    cistern: ["Black water laps at the stone, though nothing stirs it.", "The ceiling weeps. The puddles are warm.", "Rusted chains hang into the water and go taut, now and then.",
      "A drowned bell rings once beneath your feet.", "Pale lights swim in the murk and vanish when watched."],
    foundry: ["Moulds for bells, each cracked on purpose.", "The anvils are warm. No one is working them.", "Slag has cooled into the shapes of hands.",
      "A furnace breathes in time with you.", "Hammers hang on hooks, sorted by guilt."],
    chapel: ["The pews face the back wall.", "Candles burn with a purple flame that sheds no light.", "Hymnals with every line blacked out.",
      "An altar cloth embroidered with a closed eye.", "A confessional booth. Something inside is waiting its turn."]
  };
  var ROOM_NODS = [
    "A sign reads BEWARE THE RABBIT. Beneath, smaller: no, the other one.",
    "Two coconut halves lie here, clapped together until they cracked. There is no horse.",
    "Scratched in the stone: 'only a flesh scratch.' The author is a skeleton now.",
    "Someone has tallied swallows by continent. The column marked 'unladen' is blank.",
    "A potted shrubbery, and frankly not a very nice one.",
    "Charcoal on the wall: 'I do love it when a scheme assembles itself.' Below it, four sets of boot prints and a welding scar.",
    "A plaque in gilt letters: IT IS GOOD TO BE THE WARDEN.",
    "An arrow painted on the floor and the words: SHAMBLE THIS WAY.",
    "A dead arcade cabinet, its marquee still recruiting defenders for a frontier of stars.",
    "A helmet three sizes too large, visor stuck halfway. It smells of ambition.",
    "A neat notice: LUDICROUS PACE IS FORBIDDEN IN THE CORRIDORS.",
    "A note: DO NOT FEED THE SMALL ONES AFTER THE BELL. The bell is missing.",
    "Chalked beside a sealed hatch: XYZZY. Nothing happens.",
    "A patient voice in the stonework asks if you would like to play a nice game. You decline.",
    "A ring of standing stones, knee high, labelled 'not to scale'.",
    "Eleven candles in a row. The last is set a little higher than the rest."
  ];
  var RELICS = ["the Saint's Tooth", "the Drowned Key", "the Brass Heart", "the Lamp of Orrin", "the Ninth Bell's Tongue", "the Glass Psalter"];

  // ------------------------------------------------------------------
  // Name generation (original syllables; deterministic per seed, slot and reroll count)
  // ------------------------------------------------------------------
  var NAME_A = ["Al", "Bran", "Cor", "Dag", "Ev", "Fen", "Gar", "Hes", "Il", "Jor", "Kael", "Lis", "Mor", "Nell", "Os", "Pell", "Quen", "Ros", "Sef", "Tam", "Ul", "Ves", "Wen", "Yor"];
  var NAME_B = ["ric", "wyn", "do", "na", "ett", "wick", "row", "per", "se", "ey", "an", "ka", "ven", "is", "mund", "ara", "wen", "elm", "ith", "orn", "a", "ble"];
  function suggestName(seed, slot, n) {
    var s = makeStream(streamKey(seed, "names", slot + "|" + n));
    var nm = rpick(s, NAME_A) + rpick(s, NAME_B);
    return nm.charAt(0).toUpperCase() + nm.slice(1);
  }
  var WARDEN_NAMES = ["Ser Mallow", "Old Hesk", "Mother Grieve", "The Tallow Knight", "Brother Absent", "Gammer Coil", "Ser Rookwood", "The Lantern-Jaw"];
  var WARDEN_OF = ["the Ninth Bell", "the Low Stair", "Wet Stone", "the Ash Gate", "Lesser Mercies", "the Cold Hearth", "Small Hours"];

  // ------------------------------------------------------------------
  // Story: a compact mission frame from its own stream. Grim, with the occasional dry aside.
  // ------------------------------------------------------------------
  var ST_ADJ = ["Sallow", "Drowned", "Hollow", "Ashen", "Weeping", "Lightless", "Moth-Eaten", "Sunken", "Bell-less", "Ninefold"];
  var ST_PLACE = ["Undercroft", "Vaults", "Warrens", "Reliquary", "Deeps", "Barrows", "Cloister", "Catacomb"];
  var ST_TOWN = ["Lowmarrow", "Saint Ebb", "Hesketh Fold", "Wickham-under-Tor", "Candlecross", "Murrowgate", "Little Dimming"];
  var ST_BOSS = ["Vesperine", "Morrow Knell", "Abbess Ulme", "Corvane", "Saint Absence", "Mother Wick", "The Dun Prior"];
  var ST_TITLE = ["the Unlit", "Keeper of the Last Lamp", "Who Swallowed the Dawn", "the Hollow Abbess", "the Candle-Eater", "Lord of Small Hours"];
  var ST_PREMISE = [
    "{boss}, {title}, has drunk the lamplight of {town}. Descend the seven floors of {dungeon} and end the Gloam before the last candle gutters.",
    "Every night since the bells fell silent, {town} has lost another hour of dawn. The thief waits at the bottom of {dungeon}: {boss}, {title}.",
    "The wardens of {dungeon} were sworn to keep {boss} asleep. They have stopped answering. {town} sends you.",
    "{town} paid in good copper and slightly worse sausages. The work: walk down through {dungeon} and persuade {boss}, {title}, to stop. Permanently.",
    "Something under {town} is eating the light. The map calls the place {dungeon}. The map was drawn by someone who did not come back."
  ];
  function makeStory(seed) {
    var s = makeStream(streamKey(seed, "story"));
    var dungeon = "the " + rpick(s, ST_ADJ) + " " + rpick(s, ST_PLACE);
    var boss = rpick(s, ST_BOSS), title = rpick(s, ST_TITLE), town = rpick(s, ST_TOWN);
    var premise = rpick(s, ST_PREMISE).replace(/\{boss\}/g, boss).replace(/\{title\}/g, title).replace(/\{town\}/g, town).replace(/\{dungeon\}/g, dungeon);
    var floorNames = [null];
    for (var n = 1; n <= LAST_FLOOR; n++) floorNames.push(rpick(s, ["Upper", "Lower", "Outer", "Inner", "Deep", "Far", "Hidden", "Broken"]));
    return { dungeon: dungeon.charAt(0).toUpperCase() + dungeon.slice(1), boss: boss, title: title, town: town, premise: premise, floorNames: floorNames };
  }

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
  function has(list, v) { return list.indexOf(v) >= 0; }

  function tileAt(f, x, y) {
    if (x < 0 || y < 0 || x >= f.w || y >= f.h) return "#";
    return f.tiles[y].charAt(x);
  }
  // '#' wall, '.' floor, 'b' unlit brazier, 'B' lit brazier. Braziers block movement, not sight.
  function isFloor(f, x, y) { return tileAt(f, x, y) !== "#"; }
  function isWalk(f, x, y) { return tileAt(f, x, y) === "."; }
  function polarAt(f, x, y) { return (x < 0 || y < 0 || x >= f.w || y >= f.h) ? "." : f.polar[y].charAt(x); }
  function setChar(rows, x, y, ch) {
    var r = rows[y];
    if (r.charAt(x) === ch) return;
    rows[y] = r.slice(0, x) + ch + r.slice(x + 1);
  }
  function isSeen(f, x, y) { return x >= 0 && y >= 0 && x < f.w && y < f.h && f.seen[y].charAt(x) === "1"; }
  // Diagonal steps may not squeeze between two walls.
  function canStep(f, x, y, dx, dy) {
    if (!isWalk(f, x + dx, y + dy)) return false;
    if (dx !== 0 && dy !== 0 && !isWalk(f, x + dx, y) && !isWalk(f, x, y + dy)) return false;
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
  function linePoints(x0, y0, x1, y1) {
    var pts = [], dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    var err = dx - dy, x = x0, y = y0;
    while (!(x === x1 && y === y1)) {
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
      pts.push([x, y]);
    }
    return pts;
  }

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
    var key = state.floor.num + ":" + state.pos.x + ":" + state.pos.y + ":" + state.floor.tiles.join("").length;
    var c = state.__vis;
    if (!c || c.key !== key || c.floor !== state.floor) {
      c = { key: key, floor: state.floor, v: computeVision(state.floor, state.pos.x, state.pos.y) };
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
  function inRoom(r, x, y) { return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h; }
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

  // Random item definition (no id). Used by floor generation (floor stream) and drops (runtime stream).
  function rollItemDef(s, depth, wantUse) {
    var bases = Object.keys(ITEMS).filter(function (k) {
      var I = ITEMS[k];
      if (I.unique) return false;
      if (wantUse !== undefined && (I.slot === "use") !== wantUse) return false;
      return I.tier <= (depth >= 3 ? 2 : 1) || rchance(s, 0.15);
    });
    var base = rpick(s, bases), I = ITEMS[base];
    if (I.slot === "use") return { base: base, rarity: "common", affixes: [] };
    var r = rnext(s), rarity = r < 0.05 + 0.025 * depth ? "rare" : r < 0.3 + 0.04 * depth ? "magic" : "common";
    var affixes = [];
    var pool = Object.keys(AFFIXES).filter(function (a) { return has(AFFIXES[a].slots, I.slot); });
    for (var k = 0; k < RARITY[rarity].affixes && pool.length; k++) {
      var want = k === 0 ? null : !AFFIXES[affixes[0][0]].pre; // second affix: opposite position when possible
      var cands = pool.filter(function (a) { return want === null || !!AFFIXES[a].pre === want; });
      if (!cands.length) cands = pool;
      var aid = rpick(s, cands), A = AFFIXES[aid];
      var v = rint(s, A.r[0], A.r[1]) + (A.stat && depth >= 4 && A.r[1] > 1 ? 1 : 0);
      affixes.push([aid, v]);
      pool = pool.filter(function (p) { return p !== aid; });
    }
    if (rarity !== "common" && !affixes.length) rarity = "common";
    return { base: base, rarity: rarity, affixes: affixes };
  }

  function generateFloor(seed, n) {
    var s = makeStream(streamKey(seed, "floor", n));
    for (var attempt = 0; attempt < 40; attempt++) {
      var f = tryFloor(s, seed, n);
      if (f && validateFloorDef(f).ok) return f;
    }
    throw new Error("Floor generation failed for seed " + seed + " floor " + n);
  }

  // Run-wide plan from its own stream: floor themes, objective order and unique placement.
  // Each floor reads the plan but never consumes another floor's stream.
  var planCache = Object.create(null);
  function runPlan(seed) {
    if (Object.prototype.hasOwnProperty.call(planCache, seed)) return planCache[seed];
    var s = makeStream(streamKey(seed, "plan"));
    var th = rshuffle(s, ["ossuary", "cistern", "foundry", "chapel"]);
    var t5 = rpick(s, th.filter(function (t) { return t !== th[3]; }));
    var t6 = rpick(s, th.filter(function (t) { return t !== t5; }));
    var objs = rshuffle(s, ["gate", "warden", "relic", rpick(s, ["gate", "warden", "relic"]), rpick(s, ["stairs", "gate", "warden", "relic"])]);
    var plan = { themes: [null, th[0], th[1], th[2], th[3], t5, t6, "throne"], objectives: [null, "stairs"].concat(objs).concat(["boss"]),
      uniques: rshuffle(s, UNIQUE_IDS.slice()) };
    var keys = Object.keys(planCache);
    if (keys.length > 50) delete planCache[keys[0]];
    planCache[seed] = plan;
    return plan;
  }

  function tryFloor(s, seed, n) {
    if (n === LAST_FLOOR) return bossFloor(s, seed);
    var plan = runPlan(seed), themeId = plan.themes[n], T = THEMES[themeId], objType = plan.objectives[n];
    var built = buildRooms(s);
    if (!built) return null;
    var tiles = built.g.map(function (r) { return r.join(""); });
    var polar = []; for (var y = 0; y < MAP_H; y++) polar.push(new Array(MAP_W + 1).join("."));
    var f = { num: n, theme: themeId, w: MAP_W, h: MAP_H, tiles: tiles, polar: polar, rooms: [], start: null, stairs: null,
      objective: { type: objType, done: objType === "stairs" }, enemies: [], items: [], features: [] };
    var rooms = built.rooms.map(function (r) { return { x: r.x, y: r.y, w: r.w, h: r.h }; });
    var startRoom = rint(s, 0, rooms.length - 1);
    var sc = roomCenter(rooms[startRoom]);
    f.start = { x: sc.x, y: sc.y };
    var dist = bfsDist(f, sc.x, sc.y);
    var order = rooms.map(function (r, i) { var c = roomCenter(r); return { i: i, d: dist[idx(c.x, c.y)] }; })
      .filter(function (o) { return o.i !== startRoom; })
      .sort(function (a, b) { return a.d - b.d || a.i - b.i; });
    if (order.length < 4 || order[0].d < 0) return null;
    var maxd = order[order.length - 1].d;
    var stairsRoom = order[order.length - 1].i;
    var stc = roomCenter(rooms[stairsRoom]);
    f.stairs = { x: stc.x, y: stc.y };
    f.rooms = rooms;
    // Light and shadow per room (Archon-style polarity).
    rooms.forEach(function (r, i) {
      if (i === startRoom) return;
      var p = rnext(s), ch = p < T.dark ? "D" : p < T.dark + T.lit ? "L" : ".";
      if (ch !== ".") roomTiles(r).forEach(function (t) { setChar(polar, t.x, t.y, ch); });
    });
    var occupied = {};
    occupied[sc.x + "," + sc.y] = 1; occupied[stc.x + "," + stc.y] = 1;
    var startR = rooms[startRoom];
    function freeTile(room, nearCenter) {
      var cands = roomTiles(room).filter(function (t) { return !occupied[t.x + "," + t.y]; });
      if (nearCenter) {
        var c = roomCenter(room);
        cands.sort(function (a, b) { return cheb(a.x, a.y, c.x, c.y) - cheb(b.x, b.y, c.x, c.y) || a.y - b.y || a.x - b.x; });
        cands = cands.slice(0, 1);
      }
      if (!cands.length) return null;
      var t = rpick(s, cands); occupied[t.x + "," + t.y] = 1; return t;
    }
    var pool = T.pool.filter(function (t) { return ENEMIES[t].minFloor <= n; });
    if (!pool.length) pool = ["gnawer", "archer"];
    // One encounter: entry tags give solo 1-2 foes, duos 2-3, trios 3-4 - more bodies, not more HP.
    function encounter(room, lead) {
      var tags = [1, rchance(s, 0.25 + 0.05 * n) ? 1 : 2, 2, rchance(s, 0.3) ? 2 : 0, rchance(s, 0.8) ? 3 : 0, rchance(s, 0.5) ? 3 : 0];
      var heavy = 0;
      tags.forEach(function (tag, k) {
        if (!tag) return;
        // Extras for larger parties lean toward foes that pressure the back rank.
        var backPool = pool.filter(function (t) { return t === "archer" || t === "acolyte" || t === "charger" || t === "shade" || t === "bloat"; });
        var type = k === 0 && lead ? lead : (tag >= 2 && backPool.length && rchance(s, 0.6) ? rpick(s, backPool) : rpick(s, pool));
        if ((type === "gaoler" || type === "husk" || type === "charger") && heavy++) type = rpick(s, ["gnawer", "gnawer", "archer"]);
        if (type === "husk" && k === 0) type = rpick(s, ["archer", "gnawer", "acolyte"].filter(function (t) { return ENEMIES[t].minFloor <= n; }));
        var t = freeTile(room);
        if (!t) return;
        var d = { type: type, x: t.x, y: t.y, minParty: tag };
        if (ENEMIES[type].lurk) {
          d.hidden = true;
          for (var yy = t.y - 1; yy <= t.y + 1; yy++) for (var xx = t.x - 1; xx <= t.x + 1; xx++) if (inRoom(room, xx, yy)) setChar(polar, xx, yy, "D");
        }
        f.enemies.push(d);
      });
    }
    var objRoom = -1;
    var far = order.filter(function (o) { return o.d >= maxd * 0.5 && o.i !== stairsRoom; });
    if (!far.length) far = order.filter(function (o) { return o.i !== stairsRoom; });
    if (objType === "gate") {
      objRoom = rpick(s, far).i;
      var gt = freeTile(rooms[objRoom], true);
      if (!gt) return null;
      f.enemies.push({ type: "gate", x: gt.x, y: gt.y, minParty: 1, primary: true });
    } else if (objType === "warden") {
      objRoom = stairsRoom;
      var wt = freeTile(rooms[stairsRoom]);
      if (!wt) return null;
      var wname = rpick(s, WARDEN_NAMES) + ", Warden of " + rpick(s, WARDEN_OF);
      f.enemies.push({ type: "warden", x: wt.x, y: wt.y, minParty: 1, name: wname });
      f.objective.name = wname;
    } else if (objType === "relic") {
      objRoom = rpick(s, far).i;
      var rt = freeTile(rooms[objRoom]);
      if (!rt) return null;
      f.features.push({ kind: "relic", x: rt.x, y: rt.y });
      f.objective.name = rpick(s, RELICS);
      f.objective.carried = false;
    }
    order.forEach(function (o) {
      var must = o.i === stairsRoom || o.i === objRoom;
      if (!must && (o.d < 6 || !rchance(s, 0.5))) return;
      encounter(rooms[o.i], null);
    });
    // Occasional secondary gates deeper down.
    if (n >= 3 && objType !== "gate" && rchance(s, 0.35)) {
      var mid = order.filter(function (o) { return o.d >= 8 && o.i !== stairsRoom && o.i !== objRoom; });
      if (mid.length) { var gt2 = freeTile(rooms[rpick(s, mid).i]); if (gt2) f.enemies.push({ type: "gate", x: gt2.x, y: gt2.y, minParty: 2 }); }
    }
    // Hazards: never on the critical path (checked by validateFloorDef with hazards treated as walls).
    var nh = rint(s, 2, 4);
    for (var h = 0; h < nh; h++) {
      var hr = rpick(s, order), ht = freeTile(rooms[hr.i]);
      if (ht) f.features.push({ kind: "hazard", sub: T.hazard, x: ht.x, y: ht.y });
    }
    if (rchance(s, 0.75)) {
      var sr = rpick(s, order), stt = freeTile(rooms[sr.i]);
      if (stt) f.features.push({ kind: "shrine", sub: rweighted(s, [["mending", 3], ["embers", 2], ["whet", 2], ["bargain", 1]]), x: stt.x, y: stt.y });
    }
    // Fixed loot: equipment and consumables placed by the floor stream; uniques on floors 2, 4 and 6.
    var nLoot = 2 + (n >= 3 ? 1 : 0);
    for (var li = 0; li < nLoot + 1; li++) {
      var lt = freeTile(rooms[rpick(s, order).i]);
      if (lt) f.items.push({ x: lt.x, y: lt.y, item: rollItemDef(s, n, li === nLoot) });
    }
    if (n % 2 === 0) {
      var ut = freeTile(rooms[rpick(s, far).i]);
      if (ut) f.items.push({ x: ut.x, y: ut.y, item: { base: plan.uniques[n / 2 - 1], rarity: "unique", affixes: [] } });
    }
    var st0 = freeTile(startR);
    if (st0 && n > 1) f.items.push({ x: st0.x, y: st0.y, item: { base: "draught", rarity: "common", affixes: [] } });
    f.rooms = rooms.map(function (r, i) {
      var out = { x: r.x, y: r.y, w: r.w, h: r.h, start: i === startRoom };
      if (i !== startRoom && rchance(s, 0.35)) {
        var nm = ROOM_NAMES[themeId];
        out.name = rpick(s, nm[0]) + " " + rpick(s, nm[1]);
        out.text = rchance(s, 0.1) ? rpick(s, ROOM_NODS) : rpick(s, ROOM_TEXT[themeId]);
      }
      return out;
    });
    return f;
  }

  // Floor 7: an arena with four braziers. Lighting them weakens the boss.
  function bossFloor(s, seed) {
    var g = blankGrid(), x, y;
    var start = { x: 2, y: 9, w: 7, h: 7 }, arena = { x: 14, y: 3, w: 24, h: 20 };
    [start, arena].forEach(function (r) { for (y = r.y; y < r.y + r.h; y++) for (x = r.x; x < r.x + r.w; x++) carve(g, x, y); });
    var cy = rint(s, 11, 13);
    for (x = 8; x <= 14; x++) carve(g, x, cy);
    var braziers = [[17, 6], [34, 6], [17, 19], [34, 19]];
    braziers.forEach(function (b) { g[b[1]][b[0]] = "b"; });
    // A few pillars for cover, mirrored top/bottom.
    var np = rint(s, 2, 3);
    for (var p = 0; p < np; p++) {
      var px = rint(s, 20, 31), py = rint(s, 5, 8);
      g[py][px] = "#"; g[3 + 20 - 1 - (py - 3)][px] = "#";
    }
    var tiles = g.map(function (r) { return r.join(""); });
    var polar = [];
    for (y = 0; y < MAP_H; y++) { var row = ""; for (x = 0; x < MAP_W; x++) row += inRoom(arena, x, y) ? "D" : "."; polar.push(row); }
    var story = makeStory(seed);
    var f = { num: LAST_FLOOR, theme: "throne", w: MAP_W, h: MAP_H, tiles: tiles, polar: polar,
      rooms: [{ x: start.x, y: start.y, w: start.w, h: start.h, start: true }, { x: arena.x, y: arena.y, w: arena.w, h: arena.h }],
      start: { x: 4, y: cy }, stairs: null, objective: { type: "boss", done: false, name: story.boss }, enemies: [], items: [], features: [] };
    var by = rint(s, 11, 14);
    f.enemies.push({ type: "boss", x: 31, y: by, minParty: 1, name: story.boss });
    f.enemies.push({ type: "shade", x: 29, y: by - 2, minParty: 2 });
    f.enemies.push({ type: "shade", x: 29, y: by + 2, minParty: 3 });
    f.features.push({ kind: "shrine", sub: "mending", x: 3, y: 10 });
    f.items.push({ x: 7, y: 14, item: { base: "draught", rarity: "common", affixes: [] } });
    f.items.push({ x: 7, y: 10, item: { base: rpick(s, ["bomb", "vial", "tonic"]), rarity: "common", affixes: [] } });
    return f;
  }

  // Confirms every required location is reachable from the start tile, including with hazards treated as walls.
  function validateFloorDef(f) {
    var problems = [];
    var hz = {};
    f.features.forEach(function (ft) { if (ft.kind === "hazard") hz[ft.x + "," + ft.y] = 1; });
    var dist = bfsDist(f, f.start.x, f.start.y, function (x, y) { return !!hz[x + "," + y]; });
    var distAll = bfsDist(f, f.start.x, f.start.y);
    function reach(x, y) { return isWalk(f, x, y) && dist[idx(x, y)] >= 0; }
    function reachAdj(x, y) {
      if (reach(x, y)) return true;
      for (var i = 0; i < 8; i++) if (reach(x + DIRS[i][0], y + DIRS[i][1])) return true;
      return false;
    }
    if (hz[f.start.x + "," + f.start.y]) problems.push("hazard on start");
    if (f.objective.type !== "boss") {
      if (!f.stairs || !reach(f.stairs.x, f.stairs.y)) problems.push("stairs unreachable");
    }
    var o = f.objective;
    if (o.type === "gate" && !f.enemies.some(function (e) { return e.primary && reachAdj(e.x, e.y); })) problems.push("primary gate unreachable");
    if (o.type === "warden" && !f.enemies.some(function (e) { return e.type === "warden" && reach(e.x, e.y); })) problems.push("warden unreachable");
    if (o.type === "relic" && !f.features.some(function (ft) { return ft.kind === "relic" && reach(ft.x, ft.y); })) problems.push("relic unreachable");
    if (o.type === "boss") {
      if (!f.enemies.some(function (e) { return e.type === "boss" && reach(e.x, e.y); })) problems.push("boss unreachable");
      for (var y = 0; y < f.h; y++) for (var x = 0; x < f.w; x++) if (tileAt(f, x, y) === "b" && !reachAdj(x, y)) problems.push("brazier unreachable");
    }
    f.enemies.forEach(function (e) { if (!(isWalk(f, e.x, e.y) && distAll[idx(e.x, e.y)] >= 0) && !reachAdj(e.x, e.y)) problems.push("enemy unreachable"); });
    f.items.forEach(function (it) { if (!(isWalk(f, it.x, it.y) && distAll[idx(it.x, it.y)] >= 0)) problems.push("item unreachable"); });
    f.features.forEach(function (ft) { if (ft.kind === "shrine" && !reach(ft.x, ft.y)) problems.push("shrine unreachable"); });
    return { ok: problems.length === 0, problems: problems };
  }

  // ------------------------------------------------------------------
  // Items and characters
  // ------------------------------------------------------------------
  function makeItem(state, def) {
    return { id: newId(state), base: def.base, rarity: def.rarity || "common", affixes: (def.affixes || []).map(function (a) { return [a[0], a[1]]; }) };
  }
  function itemName(it) {
    var I = ITEMS[it.base], pre = [], suf = [];
    it.affixes.forEach(function (a) { var A = AFFIXES[a[0]]; (A.pre ? pre : suf).push(A.name); });
    return pre.concat([I.name], suf).join(" ");
  }
  function itemMods(it) {
    var I = ITEMS[it.base], m = {}, k;
    var base = I.mods || {};
    for (k in base) m[k] = (m[k] || 0) + base[k];
    it.affixes.forEach(function (a) { var A = AFFIXES[a[0]]; if (A.stat) m[A.stat] = (m[A.stat] || 0) + a[1]; });
    return m;
  }
  function itemSpecials(it) {
    var I = ITEMS[it.base], out = {};
    if (I.special) I.special.split(" ").forEach(function (sp) { out[sp] = 1; });
    it.affixes.forEach(function (a) { var A = AFFIXES[a[0]]; if (A.special) out[A.special] = (out[A.special] || 0) + a[1]; });
    return out;
  }
  function describeItem(it) {
    var I = ITEMS[it.base], lines = [];
    var m = itemMods(it), parts = [];
    if (I.dmg) parts.push(I.kind + (I.range ? " " + I.range : I.kind === "reach" ? " 2" : "") + ", " + I.dmg[0] + "-" + I.dmg[1] + " dmg (" + I.stat + ")");
    var names = { hp: "HP", pow: "Power", wil: "Will", arm: "Armour", acc: "Accuracy", eva: "Evasion" };
    for (var k in m) parts.push((m[k] > 0 ? "+" : "") + m[k] + " " + names[k]);
    if (parts.length) lines.push(parts.join(", "));
    it.affixes.forEach(function (a) { var A = AFFIXES[a[0]]; if (A.desc) lines.push(A.name + ": " + A.desc.replace("{v}", a[1])); });
    lines.push(I.desc);
    if (I.lore) lines.push(I.lore);
    return lines;
  }

  function makeChar(state, cls, name) {
    var C = CLASSES[cls];
    var c = { id: newId(state), name: name, cls: cls, level: 1, xp: 0, hp: 0, down: false,
      bonus: { hp: 0, pow: 0, wil: 0, arm: 0, acc: 0, eva: 0 }, upgrades: [], st: {},
      abilities: C.abilities.map(function (a) { return { id: a, charges: ABILITIES[a].charges }; }),
      equip: { weapon: null, armor: null, offhand: null, charm: null } };
    SLOTS.forEach(function (sl) { if (C.start[sl]) c.equip[sl] = makeItem(state, { base: C.start[sl] }); });
    c.hp = charStats(c).maxHp;
    return c;
  }

  function charStats(c) {
    var C = CLASSES[c.cls], L = c.level - 1;
    var st = { maxHp: C.base.hp + C.per.hp * L + c.bonus.hp, pow: C.base.pow + C.per.pow * L + c.bonus.pow,
      wil: C.base.wil + C.per.wil * L + c.bonus.wil, arm: C.base.arm + c.bonus.arm, acc: C.base.acc + c.bonus.acc,
      eva: C.base.eva + c.bonus.eva, sp: {} };
    if (c.solo) st.maxHp = Math.round(st.maxHp * 1.5);
    if (has(c.upgrades, "p_bulwark")) { st.arm += 2; st.maxHp += 6; }
    if (has(c.upgrades, "p_keeneye")) st.acc += 10;
    SLOTS.forEach(function (sl) {
      var it = c.equip[sl]; if (!it) return;
      var m = itemMods(it);
      for (var k in m) { if (k === "hp") st.maxHp += m[k]; else if (st[k] !== undefined) st[k] += m[k]; }
      var sp = itemSpecials(it);
      for (var s2 in sp) st.sp[s2] = (st.sp[s2] || 0) + sp[s2];
    });
    var wb = c.equip.weapon ? ITEMS[c.equip.weapon.base] : FIST;
    st.weapon = { name: c.equip.weapon ? itemName(c.equip.weapon) : FIST.name, kind: wb.kind,
      range: wb.kind === "reach" ? 2 : wb.kind === "melee" ? 1 : wb.range, dmg: wb.dmg, stat: wb.stat };
    st.maxHp = Math.max(1, st.maxHp);
    st.eva = Math.max(0, st.eva);
    return st;
  }

  function abilityMax(c, id) {
    var A = ABILITIES[id];
    if (!A || !A.charges) return 0;
    var m = A.charges, st = charStats(c);
    if (has(c.upgrades, "up_" + id) && id !== "guard") m += 1;
    if (A.spell && has(c.upgrades, "p_reservoir")) m += 1;
    if (st.sp.halo) m += 1;
    if (c.solo) m += 1;
    if (st.sp.echoes && c.abilities[0] && c.abilities[0].id === id) m += 1;
    return m;
  }
  function clampCharges(c) {
    c.abilities.forEach(function (a) { a.charges = Math.min(a.charges, abilityMax(c, a.id)); });
    var mx = charStats(c).maxHp;
    if (c.hp > mx) c.hp = mx;
  }

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
  function featureAt(state, x, y, kind) {
    var fs = state.floor.features;
    for (var i = 0; i < fs.length; i++) if (fs[i].x === x && fs[i].y === y && (!kind || fs[i].kind === kind)) return fs[i];
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
      levelQueue: [], offer: null, uniquesFound: [],
      story: makeStory(seed),
      log: [], stats: { kills: 0, turns: 0, dmgDealt: 0, dmgTaken: 0, floorsCleared: 0, itemsFound: 0 }, flags: {}
    };
    (opts.party || []).forEach(function (p) { state.party.push(makeChar(state, p.cls, p.name)); });
    // Lone Delver: a solo character gets +50% max HP and +1 max charge to limited abilities (never extra XP).
    if (state.party.length === 1) {
      var lone = state.party[0];
      lone.solo = true;
      lone.hp = charStats(lone).maxHp;
      lone.abilities.forEach(function (a) { a.charges = abilityMax(lone, a.id); });
    }
    log(state, state.story.premise, "story");
    enterFloor(state, 1);
    return state;
  }

  function floorTitle(state, n) {
    var f = n === state.floor.num ? state.floor : null, th = f ? f.theme : runPlan(state.seed).themes[n];
    if (n === LAST_FLOOR) return THEMES.throne.name;
    return state.story.floorNames[n] + " " + THEMES[th].name;
  }

  function enterFloor(state, n) {
    var def = generateFloor(state.seed, n);
    var size = state.party.length;
    var seen = []; for (var y = 0; y < MAP_H; y++) seen.push(new Array(MAP_W + 1).join("0"));
    var f = { num: n, theme: def.theme, w: def.w, h: def.h, tiles: def.tiles.slice(), polar: def.polar.slice(), seen: seen,
      rooms: def.rooms.map(function (r) {
        var rm = { x: r.x, y: r.y, w: r.w, h: r.h, visited: !!r.start };
        if (r.text) { rm.name = r.name; rm.text = r.text; }
        return rm;
      }),
      stairs: def.stairs ? { x: def.stairs.x, y: def.stairs.y } : null, objective: JSON.parse(JSON.stringify(def.objective)),
      enemies: [], items: [], features: [], noticed: [] };
    state.floor = f;
    state.pos = { x: def.start.x, y: def.start.y };
    // Party size filters the generated roster; the generated floor itself is identical for everyone.
    def.enemies.forEach(function (d) {
      if (d.minParty > size) return;
      var e = spawnEnemy(state, d.type, d.x, d.y, {});
      // Extra foes added for larger parties are worth 60% XP; XP itself is never divided.
      if (d.minParty > 1) e.xp = Math.ceil(e.xp * 0.6);
      if (d.hidden) e.hidden = true;
      if (d.primary) e.primary = true;
      if (d.name) e.name = d.name;
    });
    def.features.forEach(function (d) {
      var ft = { id: newId(state), kind: d.kind, x: d.x, y: d.y };
      if (d.sub) ft.sub = d.sub;
      if (d.kind === "hazard") ft.dmg = HAZARDS[d.sub].dmg + Math.floor((n - 1) / 2);
      if (d.kind === "shrine") ft.used = false;
      f.features.push(ft);
    });
    def.items.forEach(function (d) {
      if (d.item.rarity === "unique") {
        if (has(state.uniquesFound, d.item.base)) return;
        state.uniquesFound.push(d.item.base);
      }
      f.items.push({ x: d.x, y: d.y, item: makeItem(state, d.item) });
    });
    state.combat = null;
    state.status = "explore";
    state.offer = null;
    log(state, "Floor " + n + ": " + floorTitle(state, n) + ". " + objectiveText(state), "story");
    updateVision(state);
    maybeStartCombat(state);
  }

  function spawnEnemy(state, type, x, y, o) {
    var D = ENEMIES[type], n = state.floor.num;
    var hp = Math.round(D.hp * 1.35 * (1 + 0.2 * (n - 1)));
    if (type === "boss") hp = D.hp;
    var e = { id: newId(state), type: type, x: x, y: y, hp: hp, maxHp: hp, awake: !D.asleep, alerted: !!o.alerted,
      hidden: false, st: {}, xp: o.xp !== undefined ? o.xp : D.xp, cd: 0 };
    if (D.structure) e.spawned = 0;
    state.floor.enemies.push(e);
    return e;
  }

  function enemyName(e) { return e.name || ENEMIES[e.type].name; }
  function enemyStat(state, e) {
    var D = ENEMIES[e.type], n = state.floor.num, b = e.type === "boss" ? 0 : Math.floor((n - 1) * 0.75 + 0.5);
    var st = { dmg: [D.dmg[0] + b, D.dmg[1] + b], acc: D.acc + 2 * (n - 1), eva: D.eva, arm: D.arm, b: b };
    var pol = polarAt(state.floor, e.x, e.y);
    if (D.shadow) { if (pol === "L") st.eva = 0; else if (pol === "D") st.eva += 10; }
    if (e.st.shroud) st.arm += 2;
    if (e.st.blind) st.acc -= 40;
    return st;
  }
  function scaled(state, e, range) { var b = enemyStat(state, e).b; return [range[0] + b, range[1] + b]; }

  // ------------------------------------------------------------------
  // Vision updates, discoveries, waking
  // ------------------------------------------------------------------
  function notice(state, key, what, text) {
    var f = state.floor;
    if (has(f.noticed, key)) return;
    f.noticed.push(key);
    emit("discover", { what: what });
    if (text) log(state, text, "info");
  }
  function updateVision(state) {
    var f = state.floor, v = vision(state);
    for (var y = 0; y < f.h; y++) {
      var row = f.seen[y], arr = null;
      for (var x = 0; x < f.w; x++) {
        if (v[idx(x, y)] && row.charAt(x) !== "1") { if (!arr) arr = row.split(""); arr[x] = "1"; }
      }
      if (arr) f.seen[y] = arr.join("");
    }
    revealLurkers(state, v);
    f.enemies.forEach(function (e) {
      if (e.hidden || !v[idx(e.x, e.y)]) return;
      notice(state, "e" + e.id, "enemy", e.awake ? null : "You see a sleeping " + enemyName(e) + " (z).");
    });
    f.items.forEach(function (g) { if (v[idx(g.x, g.y)]) notice(state, "i" + g.item.id, "item", "You spot " + itemName(g.item) + "."); });
    f.features.forEach(function (ft) {
      if (!v[idx(ft.x, ft.y)]) return;
      if (ft.kind === "hazard") notice(state, "f" + ft.id, "hazard", "You spot " + HAZARDS[ft.sub].name + " - the travel commands will avoid it.");
      if (ft.kind === "shrine") notice(state, "f" + ft.id, "shrine", "You spot a " + SHRINES[ft.sub].name + ".");
      if (ft.kind === "relic") notice(state, "f" + ft.id, "objective", "There: " + f.objective.name + ".");
    });
    if (f.stairs && v[idx(f.stairs.x, f.stairs.y)]) notice(state, "stairs", "stairs", "You spot the stairs down.");
    for (var by = 0; by < f.h; by++) for (var bx = 0; bx < f.w; bx++) {
      if (tileAt(f, bx, by) === "b" && v[idx(bx, by)]) notice(state, "b" + bx + "," + by, "objective", "A cold brazier. Walk into it to light it; light weakens the Unlit.");
    }
    // Waking by awareness range (deterministic: distance and line of sight only).
    f.enemies.forEach(function (e) {
      var D = ENEMIES[e.type];
      if (!e.awake && D.aware && v[idx(e.x, e.y)] && cheb(e.x, e.y, state.pos.x, state.pos.y) <= D.aware) wake(state, e, "you came within " + D.aware + " tiles");
    });
    if (!conscious(state).length && state.status !== "defeat") defeat(state);
  }

  // Hidden ambushers erupt when the party comes within 2 tiles; a lantern exposes them at 3 without the ambush.
  function revealLurkers(state, v) {
    var f = state.floor, rt = state.rng.runtime;
    var lantern = conscious(state).some(function (c) { return charStats(c).sp.lantern; });
    f.enemies.forEach(function (e) {
      if (!e.hidden || !v[idx(e.x, e.y)]) return;
      var d = cheb(e.x, e.y, state.pos.x, state.pos.y);
      if (lantern && d <= 3 && d > 2) {
        e.hidden = false; e.awake = true; e.alerted = true;
        log(state, "Your lantern exposes a " + enemyName(e) + " in the shadows!", "warn");
        emit("discover", { what: "enemy" });
        return;
      }
      if (d > 2) return;
      e.hidden = false; e.awake = true; e.alerted = true;
      emit("discover", { what: "enemy" });
      if (lantern) { log(state, "Your lantern exposes a " + enemyName(e) + " before it can strike!", "warn"); return; }
      log(state, "AMBUSH! A " + enemyName(e) + " erupts from the shadows!", "bad");
      var t = conscious(state);
      if (t.length) enemyHits(state, e, rpick(rt, t), scaled(state, e, ENEMIES[e.type].ambush), "ranged", "ambushes");
    });
  }

  function wake(state, e, why) {
    if (e.awake) return;
    e.awake = true; e.alerted = true;
    log(state, enemyName(e) + " wakes (" + why + ").", "warn");
    emit("wake", { id: e.id });
  }
  // Noisy actions wake every sleeper within the radius, seen or not.
  function makeNoise(state, x, y, r) {
    state.floor.enemies.forEach(function (e) { if (!e.awake && cheb(e.x, e.y, x, y) <= r) wake(state, e, "noise"); });
  }

  function awakeVisible(state) {
    var v = vision(state);
    return state.floor.enemies.filter(function (e) { return e.awake && !e.hidden && v[idx(e.x, e.y)]; });
  }
  function visibleEnemies(state) {
    var v = vision(state);
    return state.floor.enemies.filter(function (e) { return !e.hidden && v[idx(e.x, e.y)]; });
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
    state.offer = null;
    state.combat = { round: 1, actor: -1, moved: false, slip: 0, acted: [], foes: foes.map(function (e) { return e.id; }) };
    log(state, "Combat! " + foes.map(enemyName).join(", ") + ".", "combat");
    emit("combat", {});
    startPartyPhase(state);
    return true;
  }

  function startPartyPhase(state) {
    var cb = state.combat;
    cb.moved = false; cb.slip = 0; cb.acted = [];
    state.party.forEach(function (c) {
      delete c.st.guard; delete c.st.fade;
      if (c.st.braced) { c.st.braced -= 1; if (!c.st.braced) delete c.st.braced; }
      if (c.st.wardT) { c.st.wardT -= 1; if (!c.st.wardT) { delete c.st.wardT; delete c.st.ward; } }
    });
    cb.actor = nextActor(state, -1);
    if (cb.actor < 0) defeat(state);
  }

  function nextActor(state, from) {
    for (var i = from + 1; i < state.party.length; i++) {
      var c = state.party[i];
      if (!c.down && !has(state.combat.acted, c.id)) return i;
    }
    return -1;
  }

  function currentActor(state) {
    if (state.status !== "combat" || !state.combat || state.combat.actor < 0) return null;
    return state.party[state.combat.actor] || null;
  }

  function finishAction(state) {
    if (state.status !== "combat") return;
    var c = state.party[state.combat.actor];
    if (c) state.combat.acted.push(c.id);
    var r = checkCombatEnd(state, true);
    if (r === true) return;
    var nx = -1;
    if (r !== "skip") {
      nx = nextActor(state, state.combat.actor);
      if (nx < 0) nx = nextActor(state, -1); // the actor list may shift if someone was downed
    } else log(state, "No foe is in sight, but they are still out there: the round ends as they close in.", "warn");
    if (nx >= 0) { state.combat.actor = nx; return; }
    enemyPhase(state);
    if (state.status !== "combat") return;
    if (checkCombatEnd(state, false) === true) return;
    state.combat.round += 1;
    startPartyPhase(state);
  }

  // Combat ends when no awake enemy is visible. Mid-phase, if foes from this fight are still
  // alive out of sight (the party broke line of sight), the round finishes with an enemy phase
  // first ("skip"), so stepping around a corner cannot freeze the enemy.
  function checkCombatEnd(state, midPhase) {
    if (state.status !== "combat") return true;
    if (!conscious(state).length) { defeat(state); return true; }
    var vis = awakeVisible(state), cb = state.combat;
    vis.forEach(function (e) { if (!has(cb.foes, e.id)) cb.foes.push(e.id); });
    if (vis.length) return false;
    if (midPhase && cb.foes.some(function (id) { var e = enemyById(state, id); return e && e.awake; })) return "skip";
    endCombat(state);
    return true;
  }

  // Automatic recovery: +10% max HP (min 1) but never above 50% of max.
  function postCombatRecovery(c) {
    if (c.down) return 0;
    var mx = charStats(c).maxHp, cap = Math.floor(mx * 0.5);
    if (c.hp >= cap) return 0;
    var before = c.hp;
    c.hp = Math.min(cap, c.hp + Math.max(1, Math.floor(mx * 0.1)));
    return c.hp - before;
  }

  function endCombat(state) {
    state.status = "explore";
    state.combat = null;
    var healed = 0;
    state.party.forEach(function (c) { c.st = {}; healed += postCombatRecovery(c); });
    state.floor.enemies.forEach(function (e) {
      delete e.st.taunt; delete e.st.tauntT;
      delete e.charge; delete e.sweep; delete e.swell; delete e.nova;
    });
    log(state, "The fighting ends." + (healed ? " The party catches its breath (recovery up to half health)." : ""), "good");
    emit("combatEnd", {});
    // Anything left underfoot during the fight (full inventory) gets its explicit choice now.
    var under = state.floor.items.filter(function (g) { return g.x === state.pos.x && g.y === state.pos.y; })[0];
    if (under) pickUp(state, under);
  }

  function defeat(state) {
    state.status = "defeat";
    state.combat = null;
    log(state, "The last light of the party goes out.", "bad");
    emit("defeat", {});
  }

  // ------------------------------------------------------------------
  // Damage, healing, XP
  // ------------------------------------------------------------------
  function hurtChar(state, c, amount, src) {
    if (c.down || !(amount > 0) || !isFinite(amount)) return 0;
    if (state.combat && state.combat.wall) amount = Math.ceil(amount / 2);
    if (c.st.ward) {
      var ab = Math.min(c.st.ward, amount);
      c.st.ward -= ab; amount -= ab;
      if (ab) log(state, c.name + "'s ward absorbs " + ab + ".", "info");
      if (c.st.ward <= 0) { delete c.st.ward; delete c.st.wardT; }
    }
    if (state.flags.godMode) amount = 0;
    if (amount <= 0) return 0;
    state.stats.dmgTaken += Math.min(amount, c.hp);
    c.hp -= amount;
    emit("hurt", { who: c.id, amount: amount });
    if (c.hp <= 0) {
      c.hp = 0; c.down = true; c.st = {};
      log(state, c.name + " is downed!", "bad");
      emit("down", { who: c.id });
    }
    return amount;
  }

  function healChar(state, healer, c, amount) {
    if (!c || c.down) return 0;
    var hst = healer ? charStats(healer) : null;
    if (hst && hst.sp.mending) amount += hst.sp.mending;
    var mx = charStats(c).maxHp, before = c.hp;
    c.hp = Math.min(mx, c.hp + amount);
    var got = c.hp - before;
    if (got) emit("heal", { who: c.id, amount: got });
    if (healer) {
      if (healer !== c && has(healer.upgrades, "p_martyr")) {
        var mh = charStats(healer).maxHp; healer.hp = Math.min(mh, healer.hp + 3);
      }
      if (hst.sp.martyrheal && !healChar.inMartyr) {
        healChar.inMartyr = true;
        conscious(state).forEach(function (o) { if (o !== c) healChar(state, null, o, 3); });
        healChar.inMartyr = false;
      }
    }
    return got;
  }

  function hurtEnemy(state, e, amount, src, opts) {
    opts = opts || {};
    if (state.floor.enemies.indexOf(e) < 0) return 0;
    if (!isFinite(amount) || amount < 1) amount = 1;
    if (e.st.hex) amount = Math.round(amount * 1.5);
    if (e.type === "boss" && polarAt(state.floor, e.x, e.y) === "L") amount = Math.round(amount * 1.5);
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
    log(state, enemyName(e) + " is destroyed." + (e.xp ? " (+" + e.xp + " XP each)" : ""), "good");
    emit("kill", { id: e.id, x: e.x, y: e.y });
    var D = ENEMIES[e.type], o = f.objective;
    if (e.type === "boss") {
      o.done = true;
      state.stats.floorsCleared += 1;
      state.status = "victory";
      state.combat = null;
      log(state, enemyName(e) + " comes apart like old smoke. Somewhere far above, a bell remembers how to ring.", "story");
      emit("victory", {});
      return;
    }
    if (e.xp > 0) grantXp(state, e.xp);
    if (e.primary && o.type === "gate" && !o.done) { o.done = true; log(state, "Objective complete: the gate is sealed. The stairs are open.", "good"); emit("objective", {}); }
    if (e.type === "warden" && o.type === "warden" && !o.done) { o.done = true; log(state, "Objective complete: the warden has fallen. The stairs are open.", "good"); emit("objective", {}); }
    if (D.split) {
      var spots = DIRS.map(function (d) { return [e.x + d[0], e.y + d[1]]; }).filter(function (p) {
        return isWalk(f, p[0], p[1]) && !enemyAt(state, p[0], p[1]) && !(p[0] === state.pos.x && p[1] === state.pos.y);
      });
      spots.unshift([e.x, e.y]);
      for (var k = 0; k < 2 && k < spots.length; k++) {
        var ch = spawnEnemy(state, D.split, spots[k][0], spots[k][1], { alerted: true });
        ch.awake = true;
      }
      log(state, enemyName(e) + " splits apart!", "warn");
    }
    dropLoot(state, e);
  }

  function dropLoot(state, e) {
    var rt = state.rng.runtime;
    if (e.xp <= 0) return;
    if (e.type === "warden") {
      // Wardens always pay out: the next unplaced unique from the run plan, else a rare.
      var plan = runPlan(state.seed), uid = null;
      for (var u = 3; u < plan.uniques.length; u++) if (!has(state.uniquesFound, plan.uniques[u])) { uid = plan.uniques[u]; break; }
      var wdef = uid ? { base: uid, rarity: "unique", affixes: [] } : rollItemDef(rt, state.floor.num + 3, false);
      if (uid) state.uniquesFound.push(uid);
      if (!uid) { wdef.rarity = wdef.affixes.length >= 2 ? "rare" : wdef.rarity; }
      var wit = makeItem(state, wdef);
      state.floor.items.push({ x: e.x, y: e.y, item: wit });
      log(state, enemyName(e) + " drops " + itemName(wit) + "!", "good");
      emit("discover", { what: "item" });
      return;
    }
    if (!rchance(rt, 0.08 + e.xp * 0.01)) return;
    var def = rollItemDef(rt, state.floor.num, rchance(rt, 0.5));
    var it = makeItem(state, def);
    state.floor.items.push({ x: e.x, y: e.y, item: it });
    log(state, enemyName(e) + " drops " + itemName(it) + ".", "good");
    emit("discover", { what: "item" });
  }

  var XP_TABLE = [0, 20, 55, 100, 160, 235, 325, 430, 550];
  var MAX_LEVEL = XP_TABLE.length;
  function grantXp(state, amount) {
    // Every conscious member receives the full value; never divided by party size.
    state.party.forEach(function (c) {
      if (c.down) return;
      c.xp += amount;
      while (c.level < MAX_LEVEL && c.xp >= XP_TABLE[c.level]) {
        var before = charStats(c).maxHp;
        c.level += 1;
        c.hp += charStats(c).maxHp - before;
        log(state, c.name + " reaches level " + c.level + "!", "good");
        state.levelQueue.push({ charId: c.id, options: levelOptions(state, c) });
        emit("levelup", { who: c.id });
      }
    });
  }

  function levelOptions(state, c) {
    var rt = state.rng.runtime, C = CLASSES[c.cls];
    var known = c.abilities.map(function (a) { return a.id; });
    var pending = [];
    state.levelQueue.forEach(function (q) { if (q.charId === c.id) pending = pending.concat(q.options); });
    var pool = Object.keys(UPGRADES).filter(function (k) {
      var U = UPGRADES[k];
      // Never offer something already owned or already offered in another queued level-up.
      if (U.cls !== c.cls || has(c.upgrades, k) || has(pending, k)) return false;
      if (U.kind === "learn" && has(known, U.ability)) return false;
      if (U.kind === "upgrade" && !has(known, U.ability)) return false;
      return true;
    });
    rshuffle(rt, pool);
    // Prefer at most one passive so new abilities and upgrades show up often.
    pool.sort(function (a, b) { return (UPGRADES[a].kind === "passive") - (UPGRADES[b].kind === "passive"); });
    var opts = pool.slice(0, 2);
    var stats = C.stats.slice();
    opts.push(rpick(rt, stats));
    while (opts.length < 3) {
      var extra = rpick(rt, ["s_hp", "s_pow", "s_wil", "s_acc", "s_eva"]);
      if (!has(opts, extra)) opts.push(extra);
    }
    return opts;
  }

  function applyUpgrade(state, c, id) {
    var U = UPGRADES[id];
    if (U.kind === "stat") {
      c.bonus[U.stat] += U.v;
      // A downed character's maximum rises, but it stays at 0 HP until revived.
      if (U.stat === "hp" && !c.down) c.hp += U.v;
    } else {
      c.upgrades.push(id);
      if (U.kind === "learn") c.abilities.push({ id: U.ability, charges: ABILITIES[U.ability].charges });
      if (U.kind === "upgrade") c.abilities.forEach(function (a) { if (a.id === U.ability && ABILITIES[a.id].charges) a.charges += 1; });
      if (id === "p_bulwark" && !c.down) c.hp += 6;
      if (id === "p_reservoir") c.abilities.forEach(function (a) { if (ABILITIES[a.id].spell && ABILITIES[a.id].charges) a.charges += 1; });
    }
    clampCharges(c);
    log(state, c.name + " gains " + U.name + ".", "good");
  }

  // ------------------------------------------------------------------
  // Attacks
  // ------------------------------------------------------------------
  function enemyIsShadow(e) { return !!ENEMIES[e.type].shadow; }
  function damageMult(state, c, e) {
    var m = 1, st = charStats(c);
    if (c.cls === "stalker" && (!e.awake || e.st.stun > 0 || e.st.root > 0)) m *= 1.5;
    if (st.sp.lucent && enemyIsShadow(e)) m *= 1.5;
    return m;
  }

  // Basic weapon attack (also used by weapon-based abilities).
  function rollAttack(state, c, e, mult, opts) {
    opts = opts || {};
    var rt = state.rng.runtime, st = charStats(c), es = enemyStat(state, e), w = st.weapon;
    var sure = !e.awake || e.st.stun > 0 || opts.sure;
    var chance = clamp(st.acc + (opts.acc || 0) - es.eva, 10, 95);
    if (!sure && rint(rt, 1, 100) > chance) {
      log(state, c.name + " misses " + enemyName(e) + ".", "miss");
      emit("miss", { x: e.x, y: e.y });
      if (!e.awake) wake(state, e, "attacked");
      e.alerted = true;
      return 0;
    }
    var full = e.hp >= e.maxHp;
    var dmg = rint(rt, w.dmg[0], w.dmg[1]) + Math.floor(st[w.stat] / 2);
    dmg = dmg * (mult || 1) * damageMult(state, c, e);
    if (opts.basic) {
      if (st.sp.fullhp && full) dmg *= 3;
      if ((st.sp.crit && rchance(rt, 0.15)) || (has(c.upgrades, "p_keeneye") && rchance(rt, 0.1))) { dmg *= 2; log(state, "A telling blow!", "good"); }
    }
    dmg = Math.round(dmg);
    if (!opts.pierce) dmg -= es.arm;
    dmg = Math.max(1, dmg);
    log(state, c.name + " hits " + enemyName(e) + " for " + dmg + ".", "hit");
    hurtEnemy(state, e, dmg, c);
    var alive = state.floor.enemies.indexOf(e) >= 0;
    if (st.sp.leech) healChar(state, null, c, st.sp.leech);
    if (alive && opts.basic) {
      if (st.sp.burn && rchance(rt, 0.25)) addDot(state, c, e, 2, 2);
      if (has(c.upgrades, "p_venom")) { e.st.dot = Math.max(e.st.dot || 0, 2); e.st.dotT = Math.max(e.st.dotT || 0, 2); }
      if (st.sp.stagger && rchance(rt, 0.15)) { e.st.stun = 1; log(state, enemyName(e) + " is staggered.", "good"); }
      if (st.sp.knock) knockback(state, e, 1);
    }
    return dmg;
  }

  function addDot(state, c, e, dmg, turns) {
    if (c && has(c.upgrades, "p_kindling")) { dmg += 1; turns += 2; }
    e.st.dot = Math.max(e.st.dot || 0, dmg);
    e.st.dotT = Math.max(e.st.dotT || 0, turns);
  }

  // Spell damage: always hits, scaled by Will, reduced by half of armour.
  function spellHit(state, c, e, base, opts) {
    opts = opts || {};
    if (!e || state.floor.enemies.indexOf(e) < 0) return 0;
    var es = enemyStat(state, e);
    var dmg = Math.round(base * damageMult(state, c, e)) - Math.floor(es.arm / 2);
    dmg = Math.max(1, dmg);
    log(state, (opts.label || c.name) + " strikes " + enemyName(e) + " for " + dmg + ".", "hit");
    hurtEnemy(state, e, dmg, c);
    if (!opts.noEcho && charStats(c).sp.echo) {
      var others = visibleEnemies(state).filter(function (o) { return o !== e; });
      if (others.length) spellHit(state, c, rpick(state.rng.runtime, others), Math.ceil(base / 2), { noEcho: true, label: "The echo" });
    }
    return dmg;
  }

  function basicCheck(state, c, e) {
    if (!c || c.down) return "That character cannot act.";
    if (!e || e.hidden || !canSee(state, e.x, e.y)) return "You cannot see that target.";
    var w = charStats(c).weapon, d = cheb(state.pos.x, state.pos.y, e.x, e.y);
    if (w.kind === "melee") {
      if (front(state) !== c) return c.name + " is in the back rank: melee needs the front rank. Use a reach or ranged weapon, a spell, or reorder outside combat.";
      if (d > 1) return "Melee attacks need an adjacent target.";
    } else if (d > w.range) return "Out of range (" + w.range + ").";
    return null;
  }

  // Enemy attacks a party member. kind: "melee" | "ranged" | "area".
  function enemyHits(state, e, target, dmgRange, kind, label, opts) {
    opts = opts || {};
    if (!target || target.down) return 0;
    var rt = state.rng.runtime, es = enemyStat(state, e), name = enemyName(e);
    if (kind !== "area" && front(state) !== target) {
      var g = state.party.filter(function (c) { return !c.down && c.st.guard; })[0];
      if (g && g !== target) { log(state, g.name + " intercepts the attack meant for " + target.name + ".", "info"); target = g; }
    }
    var ts = charStats(target), arm = ts.arm + (target.st.guard ? 3 : 0) + (target.st.braced ? 2 : 0);
    var eva = ts.eva + (target.st.fade ? 25 : 0);
    var chance = clamp(es.acc - eva, 10, 95);
    if (!opts.sure && rint(rt, 1, 100) > chance) {
      log(state, name + " " + (label || "attacks") + " " + target.name + " and misses.", "miss");
      if (kind === "melee" && has(target.upgrades, "p_riposte") && cheb(e.x, e.y, state.pos.x, state.pos.y) <= 1) {
        log(state, target.name + " ripostes!", "good");
        rollAttack(state, target, e, 0.6, { sure: true });
      }
      return 0;
    }
    var dmg = rint(rt, dmgRange[0], dmgRange[1]);
    if (e.st.hex) dmg = Math.round(dmg * 0.7);
    if (kind === "area" && state.party.some(function (c) { return !c.down && c.st.guard && has(c.upgrades, "up_guard"); })) dmg = Math.ceil(dmg / 2);
    dmg = Math.max(1, dmg - arm);
    log(state, name + " " + (label || "hits") + " " + target.name + " for " + dmg + ".", "bad");
    var dealt = hurtChar(state, target, dmg, e);
    if (kind === "melee" && ts.sp.thorns && state.floor.enemies.indexOf(e) >= 0) {
      log(state, "Ossuary spurs bite back.", "good");
      hurtEnemy(state, e, 3, target);
    }
    return dealt;
  }

  // Default target choice for an enemy. Taunts override everything.
  function partyTarget(state, e, kind) {
    if (e.st.taunt) { var t = charById(state, e.st.taunt); if (t && !t.down) return t; }
    if (kind === "melee") return front(state);
    var c = conscious(state);
    return c.length ? rpick(state.rng.runtime, c) : null;
  }

  // ------------------------------------------------------------------
  // Enemy phase
  // ------------------------------------------------------------------
  function enemyPhase(state) {
    var f = state.floor, v = vision(state);
    state.combat.wall = false;
    var dm = bfsDist(f, state.pos.x, state.pos.y);
    var actors = f.enemies.filter(function (e) { return e.awake && !e.hidden && (v[idx(e.x, e.y)] || e.alerted); });
    // Act in order of distance from the party; ties broken by stable enemy id.
    actors.sort(function (a, b) {
      return cheb(a.x, a.y, state.pos.x, state.pos.y) - cheb(b.x, b.y, state.pos.x, state.pos.y) || a.id - b.id;
    });
    for (var i = 0; i < actors.length; i++) {
      var e = actors[i];
      if (f.enemies.indexOf(e) < 0) continue;
      enemyTurn(state, e, dm);
      if (state.status !== "combat") return;
      if (!conscious(state).length) { defeat(state); return; }
    }
  }
  function enemyTurn(state, e, dm) {
    var f = state.floor;
    if (e.st.dot && e.st.dotT) {
      log(state, enemyName(e) + " suffers " + e.st.dot + " (burning/poison).", "hit");
      hurtEnemy(state, e, e.st.dot, null);
      e.st.dotT -= 1; if (e.st.dotT <= 0) { delete e.st.dot; delete e.st.dotT; }
      if (f.enemies.indexOf(e) < 0) return;
    }
    if (e.st.censure && e.st.hex) {
      log(state, enemyName(e) + " is wracked by censure (3).", "hit");
      hurtEnemy(state, e, 3, null);
      if (f.enemies.indexOf(e) < 0) return;
    }
    if (e.st.stun > 0) {
      e.st.stun -= 1; if (!e.st.stun) delete e.st.stun;
      delete e.charge; delete e.sweep; delete e.swell; delete e.nova;
      log(state, enemyName(e) + " is stunned and loses its turn.", "info");
      tickEnemy(e); return;
    }
    enemyAct(state, e, dm);
    if (f.enemies.indexOf(e) >= 0) tickEnemy(e);
  }
  function tickEnemy(e) {
    ["root", "blind", "hex", "shroud"].forEach(function (k) { if (e.st[k]) { e.st[k] -= 1; if (e.st[k] <= 0) delete e.st[k]; } });
    if (!e.st.hex) delete e.st.censure;
    if (e.st.tauntT) { e.st.tauntT -= 1; if (e.st.tauntT <= 0) { delete e.st.tauntT; delete e.st.taunt; } }
  }

  function moveEnemy(state, e, nx, ny, shoved) {
    e.x = nx; e.y = ny;
    var trap = featureAt(state, nx, ny, "caltrops");
    if (trap) {
      state.floor.features.splice(state.floor.features.indexOf(trap), 1);
      // Rooted for its next 2 turns: during its own move this turn's end-of-turn tick also counts.
      e.st.root = shoved ? 2 : 3;
      log(state, enemyName(e) + " steps on caltrops and is rooted.", "good");
      hurtEnemy(state, e, trap.dmg, null);
    }
  }
  function enemyCanEnter(state, e, x, y, avoidLit) {
    if (x === state.pos.x && y === state.pos.y) return false;
    if (enemyAt(state, x, y)) return false;
    if (featureAt(state, x, y, "hazard")) return false;
    if (avoidLit && polarAt(state.floor, x, y) === "L") return false;
    return true;
  }
  function stepToward(state, e, dm, avoidLit) {
    if (e.st.root || ENEMIES[e.type].structure) return false;
    var f = state.floor, best = null, here = dm[idx(e.x, e.y)], bd = here, side = null;
    if (here < 0) return false;
    for (var pass = 0; pass < (avoidLit ? 2 : 1) && !best; pass++) {
      for (var i = 0; i < 8; i++) {
        var nx = e.x + DIRS[i][0], ny = e.y + DIRS[i][1];
        if (!canStep(f, e.x, e.y, DIRS[i][0], DIRS[i][1])) continue;
        if (!enemyCanEnter(state, e, nx, ny, avoidLit && pass === 0)) continue;
        var d = dm[idx(nx, ny)];
        if (d >= 0 && d < bd) { bd = d; best = [nx, ny]; }
        else if (d === here && !side && !(e.lx === nx && e.ly === ny)) side = [nx, ny];
      }
    }
    // Blocked by bodies: sidestep along an equal-distance tile (never straight back to where it came from).
    if (!best && side && (enemyAt(state, e.x + sgn(state.pos.x - e.x), e.y + sgn(state.pos.y - e.y)))) best = side;
    if (!best) return false;
    e.lx = e.x; e.ly = e.y;
    moveEnemy(state, e, best[0], best[1]);
    return true;
  }
  function stepAway(state, e, dm, mustSee) {
    if (e.st.root || ENEMIES[e.type].structure) return false;
    var f = state.floor, best = null, bd = dm[idx(e.x, e.y)];
    for (var i = 0; i < 8; i++) {
      var nx = e.x + DIRS[i][0], ny = e.y + DIRS[i][1];
      if (!canStep(f, e.x, e.y, DIRS[i][0], DIRS[i][1])) continue;
      if (!enemyCanEnter(state, e, nx, ny, false)) continue;
      if (mustSee && !canSee(state, nx, ny)) continue;
      var d = dm[idx(nx, ny)];
      if (d > bd) { bd = d; best = [nx, ny]; }
    }
    if (!best) return false;
    moveEnemy(state, e, best[0], best[1]);
    return true;
  }
  function freeAdjacent(state, x, y) {
    for (var i = 0; i < 8; i++) {
      var nx = x + DIRS[i][0], ny = y + DIRS[i][1];
      if (isWalk(state.floor, nx, ny) && !enemyAt(state, nx, ny) && !(nx === state.pos.x && ny === state.pos.y)) return [nx, ny];
    }
    return null;
  }

  // A Shield-Husk intercepts single-target attacks aimed at its ward.
  function interceptor(state, e) {
    var es = state.floor.enemies;
    for (var i = 0; i < es.length; i++) {
      var o = es[i];
      if (o !== e && o.type === "husk" && o.awake && !o.st.stun && o.ward === e.id && cheb(o.x, o.y, e.x, e.y) <= 1) return o;
    }
    return null;
  }
  function redirect(state, e) {
    var h = e ? interceptor(state, e) : null;
    if (h) { log(state, enemyName(h) + " steps in front of " + enemyName(e) + "!", "warn"); return h; }
    return e;
  }

  function gateTick(state, e) {
    var D = ENEMIES.gate;
    if (e.spawned >= D.total) return;
    var alive = state.floor.enemies.filter(function (o) { return o.from === e.id; }).length;
    e.cd = (e.cd || 0) + 1;
    if (e.cd < D.every || alive >= D.cap) return;
    var spot = freeAdjacent(state, e.x, e.y);
    if (!spot) return;
    e.cd = 0;
    var g = spawnEnemy(state, "grub", spot[0], spot[1], { alerted: true, xp: 0 });
    g.from = e.id;
    e.spawned += 1;
    log(state, enemyName(e) + " births a Gate-Grub (" + (D.total - e.spawned) + " left in it).", "warn");
  }

  function clearLine(state, e, dx, dy, d) {
    var x = e.x, y = e.y;
    for (var k = 1; k < d; k++) {
      if (!canStep(state.floor, x, y, dx, dy)) return false;
      x += dx; y += dy;
      if (enemyAt(state, x, y)) return false;
    }
    return true;
  }
  // Tiles a telegraphed charge will sweep (for the map overlay).
  function chargeLine(state, e) {
    if (!e.charge) return [];
    var out = [], x = e.x, y = e.y;
    for (var k = 0; k < 8; k++) {
      if (!canStep(state.floor, x, y, e.charge.dx, e.charge.dy)) break;
      x += e.charge.dx; y += e.charge.dy;
      out.push([x, y]);
    }
    return out;
  }

  function enemyAct(state, e, dm) {
    var D = ENEMIES[e.type], f = state.floor, rt = state.rng.runtime;
    var d = cheb(e.x, e.y, state.pos.x, state.pos.y), seen = canSee(state, e.x, e.y);
    var es = enemyStat(state, e);
    switch (D.ai) {
      case "melee":
        if (d <= 1) enemyHits(state, e, partyTarget(state, e, "melee"), es.dmg, "melee", e.type === "lurker" ? "claws" : "bites");
        else if (stepToward(state, e, dm) && D.fast && cheb(e.x, e.y, state.pos.x, state.pos.y) > 1) stepToward(state, e, dm);
        return;
      case "ranged":
        if (d < D.keep && !e.st.taunt && stepAway(state, e, dm, true)) return;
        if (seen && d <= D.range) enemyHits(state, e, partyTarget(state, e, "ranged"), es.dmg, "ranged", "shoots");
        else stepToward(state, e, dm);
        return;
      case "brute":
        if (d <= 1) { enemyHits(state, e, partyTarget(state, e, "melee"), es.dmg, "melee", "clubs"); return; }
        if (e.cd) { e.cd = 0; log(state, enemyName(e) + " gathers itself.", "info"); return; }
        if (stepToward(state, e, dm)) e.cd = 1;
        return;
      case "gate":
        if (d <= 8) gateTick(state, e);
        return;
      case "healer": {
        if (e.cd > 0) e.cd -= 1;
        var allies = f.enemies.filter(function (o) { return o !== e && !ENEMIES[o.type].structure && o.awake && !o.hidden && cheb(o.x, o.y, e.x, e.y) <= D.range; });
        var hurt = allies.filter(function (o) { return o.hp < o.maxHp; }).sort(function (a, b) { return a.hp / a.maxHp - b.hp / b.maxHp || a.id - b.id; })[0];
        // Heals every third turn at most and only 4 casts in its life, so it can never stall a fight.
        var castsLeft = (e.casts || 0) < 4;
        if (hurt && !e.cd && castsLeft) {
          var amt = Math.min(hurt.maxHp - hurt.hp, D.heal + es.b);
          hurt.hp += amt; e.cd = 2; e.casts = (e.casts || 0) + 1;
          log(state, enemyName(e) + " knits " + enemyName(hurt) + "'s wounds (+" + amt + ").", "warn");
          return;
        }
        var bare = allies.filter(function (o) { return !o.st.shroud; }).sort(function (a, b) { return b.xp - a.xp || a.id - b.id; })[0];
        if (bare && !e.cd && castsLeft) { bare.st.shroud = 2; e.cd = 3; e.casts = (e.casts || 0) + 1; log(state, enemyName(e) + " shrouds " + enemyName(bare) + " (+2 armour for 2 turns).", "warn"); return; }
        if (d < D.keep && !e.st.taunt && stepAway(state, e, dm, true)) return;
        if (seen && d <= D.range) enemyHits(state, e, partyTarget(state, e, "ranged"), es.dmg, "ranged", "flings murk at");
        else stepToward(state, e, dm);
        return;
      }
      case "charger": {
        if (e.charge) {
          var c = e.charge, hit = false;
          delete e.charge;
          for (var k = 0; k < 8; k++) {
            var nx = e.x + c.dx, ny = e.y + c.dy;
            if (nx === state.pos.x && ny === state.pos.y) { hit = true; break; }
            if (!canStep(f, e.x, e.y, c.dx, c.dy) || enemyAt(state, nx, ny)) break;
            moveEnemy(state, e, nx, ny);
            if (f.enemies.indexOf(e) < 0) return;
          }
          if (hit) { log(state, enemyName(e) + " CHARGES into the party!", "bad"); enemyHits(state, e, partyTarget(state, e, "melee"), scaled(state, e, D.charge), "melee", "gores"); }
          else { e.st.stun = 1; log(state, enemyName(e) + " thunders past and crashes, dazed for a round.", "good"); }
          return;
        }
        if (d <= 1) { enemyHits(state, e, partyTarget(state, e, "melee"), es.dmg, "melee", "butts"); return; }
        var ddx = state.pos.x - e.x, ddy = state.pos.y - e.y;
        if ((ddx === 0 || ddy === 0 || Math.abs(ddx) === Math.abs(ddy)) && d >= 3 && d <= 6 && seen && clearLine(state, e, sgn(ddx), sgn(ddy), d)) {
          e.charge = { dx: sgn(ddx), dy: sgn(ddy) };
          log(state, enemyName(e) + " lowers its horns: it will CHARGE along the marked line next turn. Step off it!", "warn");
          emit("telegraph", { id: e.id });
          return;
        }
        stepToward(state, e, dm);
        return;
      }
      case "bloat":
        if (e.swell) {
          log(state, enemyName(e) + " BURSTS in a gout of embers!", "bad");
          if (d <= 1) conscious(state).forEach(function (m) { enemyHits(state, e, m, scaled(state, e, D.blast), "area", "burns", { sure: true }); });
          f.enemies.slice().forEach(function (o) { if (o !== e && cheb(o.x, o.y, e.x, e.y) <= 1) hurtEnemy(state, o, rint(rt, D.blast[0], D.blast[1]), null); });
          var bi = f.enemies.indexOf(e);
          if (bi >= 0) f.enemies.splice(bi, 1);
          emit("kill", { id: e.id, x: e.x, y: e.y });
          return;
        }
        if (d <= 1) { e.swell = 1; log(state, enemyName(e) + " swells and glows: it will BURST next turn!", "warn"); emit("telegraph", { id: e.id }); return; }
        stepToward(state, e, dm);
        return;
      case "defender": {
        var ward = e.ward ? enemyById(state, e.ward) : null;
        if (!ward || ward.hidden) {
          ward = f.enemies.filter(function (o) { return o !== e && o.type !== "husk" && !ENEMIES[o.type].structure && o.awake && !o.hidden && cheb(o.x, o.y, e.x, e.y) <= 6; })
            .sort(function (a, b) { return b.xp - a.xp || a.id - b.id; })[0] || null;
          e.ward = ward ? ward.id : 0;
        }
        if (d <= 1) { enemyHits(state, e, partyTarget(state, e, "melee"), es.dmg, "melee", "bashes"); return; }
        if (ward && cheb(e.x, e.y, ward.x, ward.y) > 1) { stepToward(state, e, bfsDist(f, ward.x, ward.y)); return; }
        if (!ward) stepToward(state, e, dm);
        return;
      }
      case "shade": {
        if (polarAt(f, e.x, e.y) === "L") {
          log(state, enemyName(e) + " smoulders in the light (3).", "good");
          hurtEnemy(state, e, 3, null);
          if (f.enemies.indexOf(e) < 0) return;
        }
        if (d <= 1) { enemyHits(state, e, partyTarget(state, e, "melee"), es.dmg, "melee", "chills"); return; }
        var steps = polarAt(f, e.x, e.y) === "D" ? 2 : 1;
        for (var sk = 0; sk < steps; sk++) {
          if (!stepToward(state, e, dm, true)) break;
          if (cheb(e.x, e.y, state.pos.x, state.pos.y) <= 1) break;
        }
        return;
      }
      case "warden":
        if (e.sweep) {
          delete e.sweep;
          if (d <= 1) {
            log(state, enemyName(e) + " SWEEPS through the whole party!", "bad");
            conscious(state).forEach(function (m) { enemyHits(state, e, m, es.dmg, "area", "sweeps"); });
          } else log(state, enemyName(e) + "'s sweep cuts empty air.", "good");
          return;
        }
        e.cd = (e.cd || 0) + 1;
        if (d <= 1) {
          if (e.cd >= 3) { e.cd = 0; e.sweep = 1; log(state, enemyName(e) + " winds up a SWEEP that will hit every party member next turn. Step away!", "warn"); emit("telegraph", { id: e.id }); return; }
          enemyHits(state, e, partyTarget(state, e, "melee"), es.dmg, "melee", "strikes");
          return;
        }
        stepToward(state, e, dm);
        return;
      case "boss":
        bossAct(state, e, dm, d, seen, es);
        return;
    }
  }

  function bossPhase(e) { var r = e.hp / e.maxHp; return r > 2 / 3 ? 1 : r > 1 / 3 ? 2 : 3; }
  function bossAct(state, e, dm, d, seen, es) {
    var D = ENEMIES.boss, f = state.floor;
    var ph = bossPhase(e);
    if (ph !== (e.phase || 1)) {
      e.phase = ph;
      if (ph === 2) log(state, enemyName(e) + " draws the Gloam about itself. (Phase 2: it will mark NOVA zones - step out of them.)", "warn");
      if (ph === 3) { delete e.nova; log(state, enemyName(e) + " comes unmade and lunges! (Phase 3: it closes in and strikes; it strikes twice if it starts its turn next to you.)", "warn"); }
    }
    e.phase = ph;
    if (e.nova) {
      var n = e.nova; delete e.nova;
      if (cheb(n.x, n.y, state.pos.x, state.pos.y) <= 1) {
        log(state, "The NOVA erupts beneath the party!", "bad");
        conscious(state).forEach(function (m) { enemyHits(state, e, m, D.nova, "area", "scorches", { sure: true }); });
      } else log(state, "The nova erupts on empty stone.", "good");
      return;
    }
    if (ph === 3) {
      if (d <= 1) {
        enemyHits(state, e, partyTarget(state, e, "melee"), es.dmg, "melee", "rends");
        if (conscious(state).length) enemyHits(state, e, partyTarget(state, e, "melee"), es.dmg, "melee", "rends");
      } else if (stepToward(state, e, dm) && cheb(e.x, e.y, state.pos.x, state.pos.y) <= 1) enemyHits(state, e, partyTarget(state, e, "melee"), es.dmg, "melee", "lunges at");
      return;
    }
    e.cd = (e.cd || 0) + 1;
    // Larger parties face more Shades, not a tougher boss.
    var size = state.party.length;
    if (ph === 1 && e.cd >= 4 && (e.summons || 0) < 2 + 2 * size) {
      var minions = f.enemies.filter(function (o) { return o.from === e.id; }).length;
      var spot = freeAdjacent(state, e.x, e.y);
      if (minions < 1 + size && spot) {
        e.cd = 0; e.summons = (e.summons || 0) + 1;
        var sh = spawnEnemy(state, "shade", spot[0], spot[1], { alerted: true, xp: 0 });
        sh.from = e.id;
        log(state, enemyName(e) + " tears a Shade out of the dark (no XP).", "warn");
        return;
      }
    }
    if (ph === 2 && e.cd >= 2 && seen && d <= 7) {
      e.cd = 0;
      // Centred one tile from the party toward the boss, so a single step away escapes it.
      e.nova = { x: state.pos.x + sgn(e.x - state.pos.x), y: state.pos.y + sgn(e.y - state.pos.y) };
      log(state, enemyName(e) + " marks the ground beside you: a NOVA bursts there next turn. Step away from it!", "warn");
      emit("telegraph", { id: e.id });
      return;
    }
    // It holds its ground: claws whoever stands adjacent, bolts anyone further away.
    if (d <= 1) enemyHits(state, e, partyTarget(state, e, "melee"), es.dmg, "melee", "claws");
    else if (seen && d <= 6) enemyHits(state, e, partyTarget(state, e, "ranged"), D.bolt, "ranged", "hurls an umbral bolt at");
    else stepToward(state, e, dm);
  }

  // Intent text shown to the player.
  function intentOf(state, e) {
    var D = ENEMIES[e.type];
    if (e.hidden) return "Hidden.";
    if (!e.awake) return "ASLEEP (z): takes no turns. Wakes " + (D.aware ? "if the party comes within " + D.aware + " tiles, " : "") + "when attacked, hexed or damaged, or when a noisy action happens within 6 tiles.";
    if (e.st.stun > 0) return "Stunned - loses its next turn.";
    var d = cheb(e.x, e.y, state.pos.x, state.pos.y), t = e.st.taunt ? charById(state, e.st.taunt) : null;
    var tn = t ? t.name + " (taunted)" : null, fr = tn || "the front rank";
    var root = e.st.root ? " Rooted: cannot move." : "";
    switch (D.ai) {
      case "melee": return (d <= 1 ? "Will attack " + fr + "." : "Advancing on the party.") + root;
      case "ranged": return (d < D.keep && !t ? "Will back away if it can, otherwise shoot." : "Will shoot " + (tn || "a random party member") + " if in sight (range " + D.range + ").") + root;
      case "brute": return d <= 1 ? "Will club " + fr + " hard." : e.cd ? "Gathering itself - will not move this turn." : "Will lumber one step closer.";
      case "gate": return "Births a Gate-Grub every 3 turns while you are within 8 tiles (" + (ENEMIES.gate.total - e.spawned) + " left). Grubs give no XP.";
      case "healer": return "Will heal or shroud a nearby ally" + (e.cd ? " (recovering " + e.cd + ")" : "") + "; otherwise keeps away and flings murk.";
      case "charger": return e.charge ? "CHARGING next turn along the marked line - step off it and it crashes!" : d <= 1 ? "Will butt " + fr + "." : "Seeking a straight, clear line to charge (3-6 tiles).";
      case "bloat": return e.swell ? "SWELLING - bursts next turn, burning every party member if adjacent!" : "Drifting closer. Swells when adjacent, then bursts.";
      case "defender": { var w = e.ward ? enemyById(state, e.ward) : null; return (w ? "Guarding " + enemyName(w) + ": intercepts single-target attacks on it." : "Looking for something to guard.") + (d <= 1 ? " Will bash " + fr + "." : ""); }
      case "shade": return (polarAt(state.floor, e.x, e.y) === "L" ? "In the light: no evasion, burns each turn. " : polarAt(state.floor, e.x, e.y) === "D" ? "In shadow: fast and evasive. " : "") + (d <= 1 ? "Will chill " + fr + "." : "Closing in, avoiding light.");
      case "warden": return e.sweep ? "SWEEP next turn: hits every party member if still adjacent - step away!" : d <= 1 ? "Will strike " + fr + ". Winds up a sweep every third turn (" + (e.cd || 0) + "/3)." : "Advancing.";
      case "boss": {
        var ph = bossPhase(e);
        if (e.nova) return "NOVA marked around (" + e.nova.x + "," + e.nova.y + ") - bursts next turn. Get out of the 3x3 zone!";
        if (ph === 1) return "Phase 1: claws if adjacent, umbral bolts at range; summons a Shade every 4th turn (" + Math.max(0, 2 + 2 * state.party.length - (e.summons || 0)) + " left, no XP). +50% damage taken on lit ground.";
        if (ph === 2) return "Phase 2: alternates bolts with NOVA zones that burst a turn later. +50% damage taken on lit ground.";
        return "Phase 3: closes in and strikes; strikes TWICE if it starts its turn next to you. +50% damage taken on lit ground.";
      }
    }
    return "";
  }

  function statusText(st) {
    var out = [];
    if (st.stun) out.push("Stunned " + st.stun);
    if (st.root) out.push("Rooted " + st.root);
    if (st.blind) out.push("Blinded " + st.blind);
    if (st.hex) out.push("Hexed " + st.hex);
    if (st.shroud) out.push("Shrouded " + st.shroud);
    if (st.dot) out.push("Burning/poisoned " + st.dot + "x" + st.dotT);
    if (st.taunt) out.push("Taunted");
    if (st.guard) out.push("Guarding");
    if (st.braced) out.push("Braced " + st.braced);
    if (st.ward) out.push("Ward " + st.ward);
    if (st.fade) out.push("Fading");
    return out;
  }

  // ------------------------------------------------------------------
  // Movement and tile effects
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
  function onStairs(state) { var s = state.floor.stairs; return !!s && state.pos.x === s.x && state.pos.y === s.y; }

  function enterTileEffects(state) {
    var f = state.floor, px = state.pos.x, py = state.pos.y, o = f.objective;
    f.rooms.forEach(function (r) { if (!r.visited && inRoom(r, px, py)) { r.visited = true; roomEvent(state, r); } });
    for (var i = f.items.length - 1; i >= 0; i--) {
      var g = f.items[i];
      if (g && g.x === px && g.y === py) pickUp(state, g);
    }
    var hz = featureAt(state, px, py, "hazard");
    if (hz) {
      log(state, HAZARDS[hz.sub].name + "! Every party member takes " + hz.dmg + ".", "bad");
      conscious(state).forEach(function (c) { hurtChar(state, c, hz.dmg, null); });
      if (!conscious(state).length) { defeat(state); return; }
    }
    var sh = featureAt(state, px, py, "shrine");
    if (sh && !sh.used) {
      if (state.status === "combat") log(state, "The " + SHRINES[sh.sub].name + " stays silent while foes are near.", "info");
      else useShrine(state, sh);
    }
    var rl = featureAt(state, px, py, "relic");
    if (rl) {
      f.features.splice(f.features.indexOf(rl), 1);
      o.carried = true;
      log(state, "You take up " + o.name + ". Carry it to the stairs.", "good");
      emit("objective", {});
    }
    if (onStairs(state)) {
      if (o.type === "relic" && o.carried && !o.done) { o.done = true; log(state, "Objective complete: " + o.name + " is delivered. The stairs open.", "good"); emit("objective", {}); }
      log(state, o.done ? "The stairs lead down. Press > (or Descend) to go deeper." : "The stairs are sealed: " + objectiveText(state), "info");
    }
  }

  function mainStat(c) { return c.cls === "arcanist" || c.cls === "votary" ? "wil" : "pow"; }
  function useShrine(state, ft) {
    var rt = state.rng.runtime, S = SHRINES[ft.sub];
    ft.used = true;
    log(state, "You touch the " + S.name + ".", "story");
    if (ft.sub === "mending") {
      state.party.forEach(function (c) {
        var mx = charStats(c).maxHp;
        if (c.down) { c.down = false; c.hp = Math.max(1, Math.floor(mx * 0.25)); log(state, c.name + " stirs and stands.", "good"); }
        else healChar(state, null, c, Math.ceil(mx * 0.5));
      });
      log(state, "Warmth that does not belong down here closes your wounds.", "good");
    } else if (ft.sub === "embers") {
      state.party.forEach(function (c) { c.abilities.forEach(function (a) { var m = abilityMax(c, a.id); if (m) a.charges = Math.min(m, a.charges + 1); }); });
      log(state, "Every ability regains 1 charge.", "good");
    } else if (ft.sub === "whet") {
      state.party.forEach(function (c) { var k = mainStat(c); c.bonus[k] += 1; });
      log(state, "Each of you feels sharper: +1 Power or Will.", "good");
    } else if (ft.sub === "bargain") {
      conscious(state).forEach(function (c) { c.hp = Math.max(1, c.hp - Math.floor(c.hp / 4)); });
      var def = null;
      for (var k = 0; k < 6 && (!def || def.rarity === "common"); k++) def = rollItemDef(rt, state.floor.num + 2, false);
      if (def.rarity === "common") { def.rarity = "magic"; def.affixes = [["vigor", 6]]; if (ITEMS[def.base].slot === "weapon") def.affixes = [["keen", 6]]; }
      var it = makeItem(state, def);
      log(state, "The shrine takes its due in blood and pays in " + itemName(it) + ".", "warn");
      state.floor.items.push({ x: state.pos.x, y: state.pos.y, item: it });
      pickUp(state, state.floor.items[state.floor.items.length - 1]);
    }
    emit("shrine", {});
  }

  function pickUp(state, g) {
    var f = state.floor;
    if (state.inventory.length < INV_SIZE) {
      f.items.splice(f.items.indexOf(g), 1);
      state.inventory.push(g.item);
      state.stats.itemsFound += 1;
      log(state, "Picked up " + itemName(g.item) + ".", "good");
      emit("pickup", { id: g.item.id });
    } else if (state.status === "combat") {
      log(state, "Inventory full: " + itemName(g.item) + " stays on the floor. You can decide after the fight.", "warn");
    } else {
      state.offer = { itemId: g.item.id };
      log(state, "Inventory full (16). Choose something to discard, or leave " + itemName(g.item) + ".", "warn");
      emit("offer", {});
    }
  }

  // Exploration turns: alerted foes out of sight keep hunting, and gates near the party keep spawning.
  function worldTurn(state) {
    var f = state.floor, v = vision(state), dm = null;
    f.enemies.slice().forEach(function (e) {
      if (!e.awake || e.hidden || f.enemies.indexOf(e) < 0) return;
      if (ENEMIES[e.type].ai === "gate") { if (cheb(e.x, e.y, state.pos.x, state.pos.y) <= 8) gateTick(state, e); return; }
      if (!e.alerted || v[idx(e.x, e.y)]) return;
      if (!dm) dm = bfsDist(f, state.pos.x, state.pos.y);
      stepToward(state, e, dm, !!ENEMIES[e.type].shadow);
    });
  }

  function objectiveText(state) {
    var o = state.floor.objective;
    switch (o.type) {
      case "stairs": return "Find the stairs down (>).";
      case "gate": return o.done ? "The gate is destroyed. Find the stairs (>)." : "Destroy the Spawning Gate (Ω) to unseal the stairs.";
      case "warden": return o.done ? "The warden is dead. Take the stairs (>)." : "Defeat " + o.name + " (W) to unseal the stairs.";
      case "relic": return o.done ? "Relic delivered. Descend (>)." : o.carried ? "Carry " + o.name + " to the stairs (>) - carried." : "Find " + o.name + " (♦) and carry it to the stairs.";
      case "boss": return "Destroy " + o.name + ", " + state.story.title + " (Ψ). Light braziers (b): it takes +50% damage on lit ground.";
    }
    return "";
  }

  function canDescend(state) {
    return state.status === "explore" && onStairs(state) && state.floor.objective.done && !state.levelQueue.length;
  }

  // On descending: downed revive at 25%, the rest heal 25%, and each ability recovers half
  // of its missing charges, rounded up.
  function floorRecovery(state) {
    state.party.forEach(function (c) {
      var mx = charStats(c).maxHp;
      if (c.down) { c.down = false; c.hp = Math.max(1, Math.floor(mx * 0.25)); }
      else c.hp = Math.min(mx, c.hp + Math.floor(mx * 0.25));
      c.st = {};
      c.abilities.forEach(function (a) {
        var m = abilityMax(c, a.id);
        if (m) a.charges = Math.min(m, a.charges + Math.ceil((m - a.charges) / 2));
      });
    });
  }

  function descend(state) {
    if (!canDescend(state)) {
      if (!state.floor.stairs) return "There are no stairs here. " + objectiveText(state);
      if (!state.floor.objective.done) return "The stairs are sealed: " + objectiveText(state);
      return "Stand on the stairs, out of combat, to descend.";
    }
    state.stats.floorsCleared += 1;
    floorRecovery(state);
    enterFloor(state, state.floor.num + 1);
    log(state, "Wounds close a little on the way down; the fallen rise; some charges return.", "good");
    emit("descend", {});
    return null;
  }

  function kindle(state, x, y) {
    setChar(state.floor.tiles, x, y, "B");
    log(state, "The brazier catches. Light spills across the stone.", "good");
    lightArea(state, x, y, 3, 4, 0);
  }

  // ------------------------------------------------------------------
  // Player actions: single entry point. Returns {ok, msg, events}.
  // ------------------------------------------------------------------
  function act(state, a) {
    EV = [];
    var err = null;
    try {
      if (state.status === "victory" || state.status === "defeat") err = "The run is over.";
      else if (a.type === "choose") err = doChoose(state, a);
      else if (a.type === "reorder") err = doReorder(state, a);
      else if (a.type === "take") err = doTake(state, a);
      else if (a.type === "equip") err = doEquip(state, a);
      else if (a.type === "unequip") err = doUnequip(state, a);
      else if (a.type === "discard") err = doDiscard(state, a);
      else if (state.status === "explore" && state.levelQueue.length) err = "Choose a level-up reward first.";
      else if (state.offer && a.type !== "use") err = "Decide what to do with the item first (inventory full).";
      else if (a.type === "move") err = doMove(state, a.dx | 0, a.dy | 0);
      else if (a.type === "rest") err = doRest(state);
      else if (a.type === "attack") err = doAttack(state, a);
      else if (a.type === "ability") err = doAbility(state, a);
      else if (a.type === "use") err = doUse(state, a);
      else if (a.type === "descend") err = descend(state);
      else err = "Unknown action.";
    } catch (ex) {
      err = "Internal error: " + (ex && ex.message);
      if (typeof console !== "undefined") console.error(ex);
    }
    return { ok: !err, msg: err, events: EV };
  }

  function doMove(state, dx, dy) {
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return "Bad direction.";
    var tx = state.pos.x + dx, ty = state.pos.y + dy;
    var tileT = tileAt(state.floor, tx, ty);
    if (tileT === "B") return "That brazier is already burning.";
    if (tileT === "b") {
      // Lighting a brazier costs the shared Move in combat, or one turn while exploring.
      if (state.status === "combat") {
        if (state.combat.moved) return "The party has already moved this phase.";
        var kindler = currentActor(state);
        state.combat.moved = true;
        kindle(state, tx, ty);
        if (state.combat.slip === kindler.id) { state.combat.slip = 0; checkCombatEnd(state, true); return null; }
        finishAction(state);
        return null;
      }
      kindle(state, tx, ty);
      state.turn += 1;
      worldTurn(state); updateVision(state); maybeStartCombat(state);
      return null;
    }
    if (state.status === "combat") {
      var actor = currentActor(state);
      if (state.combat.moved) return "The party has already moved this phase (one shared Move per party phase).";
      if (enemyAt(state, tx, ty)) return "An enemy blocks the way. Attack it instead.";
      var err = moveParty(state, dx, dy);
      if (err) return err;
      if (state.status !== "combat") return null; // a hazard or ambush on arrival ended the run
      state.combat.moved = true;
      log(state, actor.name + " leads the party one step.", "info");
      var slipped = state.combat.slip === actor.id;
      if (slipped) state.combat.slip = 0;
      // Slip keeps the Stalker's action, unless arriving got the Stalker downed.
      if (slipped && !actor.down) { checkCombatEnd(state, true); return null; }
      finishAction(state);
      return null;
    }
    var bump = enemyAt(state, tx, ty);
    if (bump && !bump.hidden) return doAttack(state, { target: bump.id });
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
    if (c && !c.down) return c;
    var f = front(state);
    if (a.type === "attack") {
      // Out of combat, a bump attack is made by the first member able to reach.
      var e = enemyById(state, a.target);
      var able = conscious(state).filter(function (m) { return !basicCheck(state, m, e); })[0];
      if (able) return able;
    }
    return f;
  }

  function doAttack(state, a) {
    var c = actingChar(state, a), e = enemyById(state, a.target);
    if (!c) return "No one can act.";
    var why = basicCheck(state, c, e);
    if (why) return why;
    rollAttack(state, c, redirect(state, e), 1, { basic: true });
    afterAct(state);
    return null;
  }

  // First visit to a room may surface a short line of flavour.
  function roomEvent(state, r) {
    if (!r.text) return;
    log(state, (r.name ? r.name + ": " : "") + r.text, "story");
    emit("discover", { what: "event" });
  }

  // After an action: in combat, pass the turn; outside combat, attacking a sleeper starts a fight.
  function afterAct(state) {
    if (state.status === "combat") finishAction(state);
    else { state.turn += 1; updateVision(state); maybeStartCombat(state); }
  }

  // Valid targets for an ability or item. Returns {kind, list, why}.
  function abilityTargets(state, c, id) {
    var A = ABILITIES[id], out = { kind: A.target, list: [], why: null };
    if (!c || c.down) { out.why = "That character cannot act."; return out; }
    if (A.combat && state.status !== "combat") { out.why = A.name + " can only be used in combat."; return out; }
    if (A.frontOnly && front(state) !== c) { out.why = A.name + " needs the front rank."; return out; }
    if (id === "slip" && state.combat && state.combat.moved) { out.why = "The party has already moved this phase."; return out; }
    if (A.target === "enemy") {
      out.list = visibleEnemies(state).filter(function (e) { return cheb(e.x, e.y, state.pos.x, state.pos.y) <= A.range; }).map(function (e) { return e.id; });
      if (!out.list.length) out.why = "No visible foe within range " + A.range + ".";
    } else if (A.target === "ally") {
      out.list = conscious(state).map(function (m) { return m.id; });
    } else if (A.target === "tile") {
      var f = state.floor;
      for (var y = state.pos.y - A.range; y <= state.pos.y + A.range; y++) for (var x = state.pos.x - A.range; x <= state.pos.x + A.range; x++) {
        // Caltrops need open floor; light can be aimed at any visible non-wall tile.
        if ((id === "caltrops" ? !isWalk(f, x, y) : !isFloor(f, x, y)) || !canSee(state, x, y)) continue;
        if (id === "caltrops" && (enemyAt(state, x, y) || (x === state.pos.x && y === state.pos.y) || featureAt(state, x, y))) continue;
        out.list.push({ x: x, y: y });
      }
      if (!out.list.length) out.why = "No valid tile.";
    }
    return out;
  }

  function doAbility(state, a) {
    var c = actingChar(state, a);
    if (!c) return "No one can act.";
    var slot = null;
    for (var i = 0; i < c.abilities.length; i++) if (c.abilities[i].id === a.id) slot = c.abilities[i];
    if (!slot) return c.name + " does not know that ability.";
    var A = ABILITIES[slot.id];
    if (A.charges > 0 && slot.charges <= 0) return A.name + " has no charges left. Charges return only when you descend.";
    var tg = abilityTargets(state, c, slot.id);
    if (tg.why) return tg.why;
    if (A.target === "enemy" && !has(tg.list, a.target)) return "Choose a visible foe within range " + A.range + ".";
    if (A.target === "ally" && !has(tg.list, a.target)) return "Choose a conscious ally.";
    if (A.target === "tile" && !tg.list.some(function (t) { return t.x === a.x && t.y === a.y; })) return "Choose a visible tile within range " + A.range + ".";
    var err = useAbility(state, c, slot.id, a);
    if (err) return err;
    if (A.charges > 0) slot.charges -= 1;
    if (A.noise) makeNoise(state, state.pos.x, state.pos.y, A.noise);
    if (A.free && state.status === "combat") { checkCombatEnd(state, true); return null; }
    afterAct(state);
    return null;
  }

  function knockback(state, e, n) {
    var dx = sgn(e.x - state.pos.x), dy = sgn(e.y - state.pos.y);
    if (!dx && !dy) return;
    for (var i = 0; i < n; i++) {
      var nx = e.x + dx, ny = e.y + dy;
      if (!canStep(state.floor, e.x, e.y, dx, dy) || enemyAt(state, nx, ny) || ENEMIES[e.type].structure) {
        e.st.stun = Math.max(e.st.stun || 0, 1);
        log(state, enemyName(e) + " slams into an obstacle and is stunned.", "good");
        return;
      }
      moveEnemy(state, e, nx, ny, true);
      if (state.floor.enemies.indexOf(e) < 0) return;
    }
  }

  function lightArea(state, cx, cy, r, shadowDmg, blind) {
    var f = state.floor;
    for (var y = cy - r; y <= cy + r; y++) for (var x = cx - r; x <= cx + r; x++) {
      if (isFloor(f, x, y) && los(f, cx, cy, x, y)) setChar(f.polar, x, y, "L");
    }
    f.enemies.slice().forEach(function (e) {
      if (cheb(e.x, e.y, cx, cy) > r) return;
      if (e.hidden) { e.hidden = false; log(state, "The light reveals a " + enemyName(e) + "!", "warn"); }
      if (enemyIsShadow(e) && shadowDmg) { log(state, enemyName(e) + " shrieks in the light.", "good"); hurtEnemy(state, e, shadowDmg, null); }
      else if (blind && state.floor.enemies.indexOf(e) >= 0) e.st.blind = Math.max(e.st.blind || 0, blind);
    });
    emit("light", { x: cx, y: cy, r: r });
  }

  function useAbility(state, c, id, a) {
    var rt = state.rng.runtime, st = charStats(c), e = a.target !== undefined ? enemyById(state, a.target) : null;
    var px = state.pos.x, py = state.pos.y;
    var adj = function () { return visibleEnemies(state).filter(function (o) { return cheb(o.x, o.y, px, py) <= 1; }); };
    switch (id) {
      case "shove": {
        var hk = interceptor(state, e);
        if (hk && cheb(hk.x, hk.y, px, py) <= 1) e = redirect(state, e);
        if (rollAttack(state, c, e, 0.8) && state.floor.enemies.indexOf(e) >= 0) {
          if (has(c.upgrades, "up_shove")) e.st.stun = Math.max(e.st.stun || 0, 1);
          knockback(state, e, 2);
        }
        return null;
      }
      case "challenge": {
        var taunted = awakeVisible(state).filter(function (o) { return cheb(o.x, o.y, px, py) <= 5; });
        taunted.forEach(function (o) { o.st.taunt = c.id; o.st.tauntT = 2; });
        c.st.braced = 2;
        log(state, c.name + " bellows a challenge! " + taunted.length + " foe(s) taunted.", "info");
        if (has(c.upgrades, "up_challenge") && taunted.length) healChar(state, c, c, 3 * Math.min(3, taunted.length));
        return null;
      }
      case "guard":
        c.st.guard = 1;
        log(state, c.name + " raises a guard over the back rank.", "info");
        return null;
      case "cleave": {
        var foes = adj();
        if (!foes.length) return "No adjacent foes.";
        foes.forEach(function (o) { rollAttack(state, c, o, 0.9); });
        return null;
      }
      case "rally":
        log(state, c.name + " rallies the party.", "good");
        conscious(state).forEach(function (m) { healChar(state, c, m, Math.max(4, Math.floor(charStats(m).maxHp * 0.2))); });
        return null;
      case "aimed":
        e = redirect(state, e);
        if (rollAttack(state, c, e, 2, { acc: 25, pierce: true }) && has(c.upgrades, "up_aimed") && state.floor.enemies.indexOf(e) >= 0) e.st.root = 2;
        return null;
      case "caltrops":
        state.floor.features.push({ id: newId(state), kind: "caltrops", x: a.x, y: a.y, dmg: 4 + Math.floor(st.pow / 2) + (has(c.upgrades, "up_caltrops") ? 4 : 0) });
        log(state, c.name + " scatters caltrops.", "info");
        return null;
      case "slip":
        state.combat.slip = c.id;
        if (has(c.upgrades, "up_slip")) c.st.fade = 1;
        log(state, c.name + " readies to slip away: the next Move is free for " + c.name + ".", "info");
        return null;
      case "volley": {
        var range = st.weapon.kind === "ranged" || st.weapon.kind === "focus" ? Math.max(6, st.weapon.range) : 6;
        var ts = visibleEnemies(state).filter(function (o) { return o.awake && cheb(o.x, o.y, px, py) <= range; })
          .sort(function (p, q) { return cheb(p.x, p.y, px, py) - cheb(q.x, q.y, px, py) || p.id - q.id; }).slice(0, 3);
        if (!ts.length) return "No foes in range.";
        ts.forEach(function (o) { rollAttack(state, c, o, 0.8); });
        return null;
      }
      case "smoke": {
        var near = visibleEnemies(state).filter(function (o) { return cheb(o.x, o.y, px, py) <= 2; });
        near.forEach(function (o) { o.st.blind = 2; });
        log(state, c.name + " cracks a smoke pot. " + near.length + " foe(s) blinded.", "info");
        return null;
      }
      case "ember": {
        var victims = [redirect(state, e)];
        if (has(c.upgrades, "up_ember")) {
          victims = [];
          linePoints(px, py, e.x, e.y).forEach(function (p) { var o = enemyAt(state, p[0], p[1]); if (o && !o.hidden) victims.push(o); });
        }
        victims.forEach(function (o) {
          var dmg = rint(rt, 3, 6) + st.wil;
          spellHit(state, c, o, dmg);
          if (state.floor.enemies.indexOf(o) >= 0) addDot(state, c, o, 2, 2);
        });
        return null;
      }
      case "rime": {
        var r = has(c.upgrades, "up_rime") ? 3 : 2;
        var hit = visibleEnemies(state).filter(function (o) { return cheb(o.x, o.y, px, py) <= r; });
        if (!hit.length) log(state, "Frost spreads, finding nothing.", "miss");
        hit.forEach(function (o) {
          spellHit(state, c, o, rint(rt, 2, 4) + Math.floor(st.wil / 2));
          if (state.floor.enemies.indexOf(o) >= 0) o.st.stun = Math.max(o.st.stun || 0, 1);
        });
        return null;
      }
      case "flare": {
        var up = has(c.upgrades, "up_flare");
        log(state, c.name + " looses a Lumen Flare.", "info");
        lightArea(state, a.x, a.y, up ? 3 : 2, 6 + st.wil, up ? 2 : 1);
        return null;
      }
      case "chain": {
        e = redirect(state, e);
        var hitList = [e], cur = e;
        spellHit(state, c, e, rint(rt, 3, 5) + st.wil);
        for (var j = 0; j < 2; j++) {
          var nxt = visibleEnemies(state).filter(function (o) { return !has(hitList, o) && cheb(o.x, o.y, cur.x, cur.y) <= 3; })
            .sort(function (p, q) { return cheb(p.x, p.y, cur.x, cur.y) - cheb(q.x, q.y, cur.x, cur.y) || p.id - q.id; })[0];
          if (!nxt) break;
          hitList.push(nxt); cur = nxt;
          spellHit(state, c, nxt, Math.round((rint(rt, 3, 5) + st.wil) * 0.7), { label: "The spark" });
        }
        return null;
      }
      case "glyph": {
        var bound = [e].concat(visibleEnemies(state).filter(function (o) { return o !== e && cheb(o.x, o.y, e.x, e.y) <= 1; }));
        bound.forEach(function (o) { o.st.root = 2; spellHit(state, c, o, 2, { label: "The glyph", noEcho: true }); });
        return null;
      }
      case "mend": {
        var t = charById(state, a.target);
        var amt = rint(rt, 7, 10) + st.wil + (has(c.upgrades, "up_mend") ? 4 : 0);
        var got = healChar(state, c, t, amt);
        log(state, c.name + " mends " + t.name + " (+" + got + ").", "good");
        return null;
      }
      case "ward": {
        var w = charById(state, a.target);
        w.st.ward = 8 + st.wil + (has(c.upgrades, "up_ward") ? 6 : 0); w.st.wardT = 3;
        log(state, c.name + " wards " + w.name + " (" + w.st.ward + ").", "good");
        return null;
      }
      case "hex": {
        var cursed = [e];
        if (has(c.upgrades, "up_hex")) cursed = cursed.concat(visibleEnemies(state).filter(function (o) { return o !== e && cheb(o.x, o.y, e.x, e.y) <= 1; }));
        cursed.forEach(function (o) {
          o.st.hex = 3; if (has(c.upgrades, "p_censure")) o.st.censure = 1;
          if (!o.awake) wake(state, o, "hexed");
          o.alerted = true;
        });
        log(state, c.name + " hexes " + cursed.map(enemyName).join(", ") + ".", "info");
        return null;
      }
      case "litany":
        log(state, c.name + " intones a litany.", "good");
        conscious(state).forEach(function (m) { healChar(state, c, m, rint(rt, 4, 6) + Math.floor(st.wil / 2)); });
        return null;
      case "sanctify":
        log(state, c.name + " sanctifies the ground.", "good");
        lightArea(state, px, py, 2, 5 + st.wil, 0);
        conscious(state).forEach(function (m) { m.st.braced = 2; });
        return null;
    }
    return "That ability is not ready.";
  }

  // ------------------------------------------------------------------
  // Inventory and equipment
  // ------------------------------------------------------------------
  function invIndex(state, id) { for (var i = 0; i < state.inventory.length; i++) if (state.inventory[i].id === id) return i; return -1; }

  function doEquip(state, a) {
    if (state.status === "combat") return "Equipment cannot be changed during combat.";
    var c = charById(state, a.char), i = invIndex(state, a.item);
    if (!c) return "Choose a character.";
    if (i < 0) return "That item is not in the inventory.";
    var it = state.inventory[i], I = ITEMS[it.base];
    if (I.slot === "use") return "That item is used, not equipped.";
    var old = c.equip[I.slot];
    c.equip[I.slot] = it;
    if (old) state.inventory[i] = old; else state.inventory.splice(i, 1);
    // Equipping never heals: current HP stays and is only clamped to a lower maximum.
    clampCharges(c);
    log(state, c.name + " equips " + itemName(it) + (old ? " (stowed " + itemName(old) + ")." : "."), "info");
    return null;
  }
  function doUnequip(state, a) {
    if (state.status === "combat") return "Equipment cannot be changed during combat.";
    var c = charById(state, a.char);
    if (!c || !has(SLOTS, a.slot) || !c.equip[a.slot]) return "Nothing to unequip.";
    if (state.inventory.length >= INV_SIZE) return "No room in the inventory.";
    state.inventory.push(c.equip[a.slot]);
    log(state, c.name + " stows " + itemName(c.equip[a.slot]) + ".", "info");
    c.equip[a.slot] = null;
    clampCharges(c);
    return null;
  }
  function doDiscard(state, a) {
    var i = invIndex(state, a.item);
    if (i < 0) return "That item is not in the inventory.";
    var it = state.inventory.splice(i, 1)[0];
    log(state, "Discarded " + itemName(it) + ".", "info");
    if (state.offer) doTake(state, { item: state.offer.itemId });
    return null;
  }
  // Resolve a full-inventory offer: {take: true} after making room, or {leave: true}.
  function doTake(state, a) {
    if (!state.offer) return "Nothing to take.";
    var f = state.floor, g = null;
    f.items.forEach(function (x) { if (x.item.id === state.offer.itemId) g = x; });
    if (a.leave || !g) { state.offer = null; if (g) log(state, "You leave " + itemName(g.item) + " where it lies.", "info"); return null; }
    if (state.inventory.length >= INV_SIZE) return "Discard something first.";
    state.offer = null;
    pickUp(state, g);
    return null;
  }

  function doUse(state, a) {
    var i = invIndex(state, a.item);
    if (i < 0) return "That item is not in the inventory.";
    var it = state.inventory[i], I = ITEMS[it.base];
    if (I.slot !== "use") return "That item is equipped, not used.";
    var user = actingChar(state, a);
    if (!user) return "No one can act.";
    var t = a.target !== undefined ? charById(state, a.target) : null, e = a.target !== undefined ? enemyById(state, a.target) : null;
    var f = state.floor;
    switch (it.base) {
      case "draught":
        if (!t || t.down) return "Choose a conscious ally.";
        log(state, t.name + " drinks a Healing Draught (+" + healChar(state, null, t, Math.ceil(charStats(t).maxHp * 0.5)) + ").", "good");
        break;
      case "salts":
        if (state.status === "combat") return "No revival during combat.";
        if (!t || !t.down) return "Choose a downed ally.";
        t.down = false; t.hp = Math.max(1, Math.floor(charStats(t).maxHp * 0.25));
        log(state, t.name + " gasps awake.", "good");
        break;
      case "tonic":
        if (!t || t.down) return "Choose a conscious ally.";
        t.abilities.forEach(function (ab) { var m = abilityMax(t, ab.id); if (m) ab.charges = Math.min(m, ab.charges + 1); });
        log(state, t.name + " drinks an Ember Tonic: +1 charge to each ability.", "good");
        break;
      case "bomb":
        if (!e || e.hidden || !canSee(state, e.x, e.y) || cheb(e.x, e.y, state.pos.x, state.pos.y) > I.range) return "Choose a visible foe within 5.";
        log(state, user.name + " hurls a Flask Bomb!", "info");
        var dmg = 8 + f.num;
        f.enemies.filter(function (o) { return cheb(o.x, o.y, e.x, e.y) <= 1; }).forEach(function (o) { hurtEnemy(state, o, dmg - Math.floor(enemyStat(state, o).arm / 2), user); });
        makeNoise(state, e.x, e.y, 6);
        break;
      case "vial":
        log(state, user.name + " breaks a Lumen Vial.", "info");
        lightArea(state, state.pos.x, state.pos.y, 2, 6, 0);
        break;
      case "scroll":
        for (var y = 0; y < f.h; y++) {
          var row = f.seen[y].split("");
          for (var x = 0; x < f.w; x++) {
            if (isFloor(f, x, y)) { row[x] = "1"; continue; }
            for (var k = 0; k < 8; k++) if (isFloor(f, x + DIRS[k][0], y + DIRS[k][1])) { row[x] = "1"; break; }
          }
          f.seen[y] = row.join("");
        }
        notice(state, "stairs", "stairs", null);
        log(state, "The scroll unrolls into a map of this floor.", "good");
        break;
      default: return "Nothing happens.";
    }
    state.inventory.splice(invIndex(state, a.item), 1);
    afterAct(state);
    return null;
  }

  function doChoose(state, a) {
    var q = state.levelQueue[0];
    if (!q) return "No level-up pending.";
    if (!has(q.options, a.option)) return "Not one of the offered choices.";
    var c = charById(state, q.charId);
    var U = UPGRADES[a.option];
    if (U.kind !== "stat" && (has(c.upgrades, a.option) || (U.kind === "learn" && c.abilities.some(function (x) { return x.id === U.ability; })))) return c.name + " already has that. Choose another reward.";
    state.levelQueue.shift();
    applyUpgrade(state, c, a.option);
    return null;
  }

  function doReorder(state, a) {
    if (state.status === "combat") return "Formation cannot change during combat.";
    var n = state.party.length, from = a.from | 0, to = a.to | 0;
    if (from < 0 || from >= n || to < 0 || to >= n) return "Bad formation slot.";
    var c = state.party.splice(from, 1)[0];
    state.party.splice(to, 0, c);
    log(state, "Formation: " + state.party.map(function (m) { return m.name; }).join(", ") + ".", "info");
    return null;
  }

  // ------------------------------------------------------------------
  // Pathing over known tiles (click-to-travel). Returns the next [dx, dy] or null.
  // ------------------------------------------------------------------
  function knownBlocked(state, avoidHazards, tx, ty) {
    var f = state.floor, v = vision(state);
    return function (x, y) {
      if (!isSeen(f, x, y)) return true;
      var e = enemyAt(state, x, y);
      if (e && !e.hidden && v[idx(x, y)]) return true;
      if (avoidHazards && !(x === tx && y === ty)) { var hz = featureAt(state, x, y, "hazard"); if (hz && has(f.noticed, "f" + hz.id)) return true; }
      return false;
    };
  }
  function stepTowardTile(state, tx, ty) {
    var f = state.floor;
    if (!isFloor(f, tx, ty) || !isSeen(f, tx, ty)) return null;
    if (tx === state.pos.x && ty === state.pos.y) return null;
    // Prefer a route around known hazards; walk through one only if there is no other way.
    var dm = null, bd = -1;
    for (var pass = 0; pass < 2 && bd < 0; pass++) {
      var blocked = knownBlocked(state, pass === 0, tx, ty);
      dm = bfsDist(f, tx, ty, function (x, y) { return (x !== state.pos.x || y !== state.pos.y) && blocked(x, y); });
      bd = dm[idx(state.pos.x, state.pos.y)];
    }
    var best = null;
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
  // Auto-Explore and Travel. These only choose the next single step through
  // known tiles; the caller performs it with act({type:"move"}), so each step
  // costs a world turn and new information can stop the walk.
  // Known safe tile: seen, walkable, no visible enemy, no known hazard, and outside
  // the wake radius of a sleeper in view.
  // ------------------------------------------------------------------
  function safeBlocker(state, strict) {
    var f = state.floor, v = vision(state);
    // Sleepers cannot move, so a sleeper the party has already seen stays where it was remembered.
    var sleepers = f.enemies.filter(function (e) { return !e.awake && !e.hidden && has(f.noticed, "e" + e.id); });
    return function (x, y) {
      if (!isSeen(f, x, y) || !isWalk(f, x, y)) return true;
      var e = enemyAt(state, x, y);
      if (e && !e.hidden && (v[idx(x, y)] || has(sleepers, e))) return true;
      var hz = featureAt(state, x, y, "hazard");
      if (hz && has(f.noticed, "f" + hz.id)) return true;
      if (strict) for (var i = 0; i < sleepers.length; i++) if (cheb(sleepers[i].x, sleepers[i].y, x, y) <= (ENEMIES[sleepers[i].type].aware || 0)) return true;
      return false;
    };
  }
  // Multi-source BFS from the goal tiles; returns the first step from the party.
  function dirToGoals(state, goals, blocked) {
    var f = state.floor, d = new Int16Array(MAP_W * MAP_H); d.fill(-1);
    var q = [];
    goals.forEach(function (g) { if (isWalk(f, g[0], g[1]) && d[idx(g[0], g[1])] < 0 && (!blocked(g[0], g[1]) || (g[0] === state.pos.x && g[1] === state.pos.y))) { d[idx(g[0], g[1])] = 0; q.push(g[0], g[1]); } });
    for (var qi = 0; qi < q.length; qi += 2) {
      var x = q[qi], y = q[qi + 1];
      if (x === state.pos.x && y === state.pos.y) break;
      for (var i = 0; i < 8; i++) {
        var nx = x + DIRS[i][0], ny = y + DIRS[i][1];
        if (!canStep(f, x, y, DIRS[i][0], DIRS[i][1]) || d[idx(nx, ny)] >= 0) continue;
        if (blocked(nx, ny) && !(nx === state.pos.x && ny === state.pos.y)) continue;
        d[idx(nx, ny)] = d[idx(x, y)] + 1; q.push(nx, ny);
      }
    }
    var here = d[idx(state.pos.x, state.pos.y)];
    if (here <= 0) return null;
    var best = null, bd = here;
    for (var k = 0; k < 8; k++) {
      var dx = DIRS[k][0], dy = DIRS[k][1], tx = state.pos.x + dx, ty = state.pos.y + dy;
      if (!canStep(f, state.pos.x, state.pos.y, dx, dy)) continue;
      var dd = d[idx(tx, ty)];
      if (dd >= 0 && dd < bd) { bd = dd; best = [dx, dy]; }
    }
    return best;
  }
  function frontierGoals(state) {
    var f = state.floor, goals = [];
    for (var y = 1; y < f.h - 1; y++) for (var x = 1; x < f.w - 1; x++) {
      if (!isSeen(f, x, y) || !isWalk(f, x, y)) continue;
      for (var i = 0; i < 8; i++) if (!isSeen(f, x + DIRS[i][0], y + DIRS[i][1])) { goals.push([x, y]); break; }
    }
    if (state.inventory.length < INV_SIZE) f.items.forEach(function (g) { if (isSeen(f, g.x, g.y) && !(g.x === state.pos.x && g.y === state.pos.y)) goals.push([g.x, g.y]); });
    return goals;
  }
  function adjacentGoals(x, y) { return DIRS.map(function (d) { return [x + d[0], y + d[1]]; }); }
  function objectiveGoals(state) {
    var f = state.floor, o = f.objective;
    var stairsKnown = f.stairs && has(f.noticed, "stairs");
    if (o.done || o.type === "stairs" || (o.type === "relic" && o.carried)) {
      if (!stairsKnown) return { why: "You have not found the stairs yet. Try Auto-Explore (E)." };
      if (onStairs(state)) return { why: o.done ? "You are on the stairs. Press > to descend." : "You are on the sealed stairs: " + objectiveText(state) };
      return { goals: [[f.stairs.x, f.stairs.y]], label: "the stairs" };
    }
    if (o.type === "relic") {
      var rl = f.features.filter(function (ft) { return ft.kind === "relic" && has(f.noticed, "f" + ft.id); })[0];
      return rl ? { goals: [[rl.x, rl.y]], label: o.name } : { why: "You have not found " + o.name + " yet. Try Auto-Explore (E)." };
    }
    var want = o.type === "gate" ? function (e) { return e.primary; } : o.type === "warden" ? function (e) { return e.type === "warden"; } : function (e) { return e.type === "boss"; };
    var tgt = f.enemies.filter(function (e) { return want(e) && has(f.noticed, "e" + e.id); })[0];
    if (!tgt) return { why: "You have not found the " + (o.type === "gate" ? "gate" : o.type === "warden" ? "warden" : "boss") + " yet. Try Auto-Explore (E)." };
    return { goals: adjacentGoals(tgt.x, tgt.y), label: enemyName(tgt) };
  }
  // mode: "explore" | "travel". Returns {dir:[dx,dy]} or {why:"..."}.
  // By default neither mode walks into a known sleeper's wake radius; opts.allowWake lifts that.
  function planStep(state, mode, opts) {
    opts = opts || {};
    if (state.status === "combat") return { why: "Not during combat." };
    if (state.status !== "explore") return { why: "The run is over." };
    if (state.levelQueue.length) return { why: "Choose a level-up reward first." };
    if (state.offer) return { why: "Decide about the item first." };
    var strict = safeBlocker(state, true), loose = safeBlocker(state, false), dir;
    if (mode === "explore") {
      var goals = frontierGoals(state);
      if (!goals.length) return { why: "Nothing left to explore on this floor." + (state.floor.objective.done ? " Press G to travel to the stairs." : "") };
      var sg = goals.filter(function (g) { return !strict(g[0], g[1]); });
      dir = dirToGoals(state, sg, strict);
      if (!dir && opts.allowWake) dir = dirToGoals(state, goals, loose);
      if (dir) return { dir: dir };
      return { why: dirToGoals(state, goals, loose) ? "The rest of the way passes close to a sleeping foe (z). Walk there yourself, or deal with it." : "No safe known path to unexplored ground. Walk manually." };
    }
    var og = objectiveGoals(state);
    if (og.why) return { why: og.why };
    dir = dirToGoals(state, og.goals, strict);
    if (!dir && opts.allowWake) dir = dirToGoals(state, og.goals, loose);
    if (dir) return { dir: dir, label: og.label };
    return { why: dirToGoals(state, og.goals, loose) ? "The way to " + og.label + " passes close to a sleeping foe (z). Walk yourself, or deal with it." : "No safe known path to " + og.label + ". Explore more or walk manually." };
  }

  // ------------------------------------------------------------------
  // Seeds
  // ------------------------------------------------------------------
  function cleanSeed(str) {
    var s = String(str === undefined || str === null ? "" : str).replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (!s) return { ok: false, msg: "Enter a seed (any text up to 32 characters)." };
    if (s.length > 32) return { ok: false, msg: "Seeds are limited to 32 characters." };
    return { ok: true, seed: s };
  }
  // Daily Dungeon seed: the UTC calendar date as YYYY-MM-DD.
  function dailySeed(date) {
    var d = date || new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
  }

  // ------------------------------------------------------------------
  // Save / export / import. The snapshot is the whole state as plain JSON,
  // including the runtime RNG's internal state, so a restored run continues
  // with identical future rolls. Imports are fully validated before use.
  // ------------------------------------------------------------------
  var MAX_IMPORT_BYTES = 2 * 1024 * 1024;
  function exportRun(state, compact) {
    return JSON.stringify(state, null, compact ? 0 : 1);
  }
  function utf8Length(str) {
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } else n += 3;
      if (n > MAX_IMPORT_BYTES) return n;
    }
    return n;
  }

  // Tiny schema helpers. Each returns nothing; problems are pushed into errs.
  function V(errs) { this.errs = errs; }
  V.prototype.fail = function (path, msg) { if (this.errs.length < 12) this.errs.push(path + ": " + msg); return false; };
  V.prototype.obj = function (v, path, allowed, required) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return this.fail(path, "must be an object");
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k) && allowed.indexOf(k) < 0) return this.fail(path, "unexpected field '" + String(k).slice(0, 20) + "'");
    for (var i = 0; i < (required || []).length; i++) if (!Object.prototype.hasOwnProperty.call(v, required[i])) return this.fail(path, "missing '" + required[i] + "'");
    return true;
  };
  V.prototype.int = function (v, path, lo, hi) {
    if (typeof v !== "number" || !isFinite(v) || Math.floor(v) !== v) return this.fail(path, "must be a whole number");
    if (v < lo || v > hi) return this.fail(path, "out of range (" + lo + "-" + hi + ")");
    return true;
  };
  V.prototype.bool = function (v, path) { return typeof v === "boolean" || this.fail(path, "must be true/false"); };
  V.prototype.str = function (v, path, max, min) {
    if (typeof v !== "string") return this.fail(path, "must be text");
    if (v.length < (min || 0) || v.length > max) return this.fail(path, "text length out of range");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) return this.fail(path, "contains control characters");
    return true;
  };
  V.prototype.oneOf = function (v, path, list) { return list.indexOf(v) >= 0 || this.fail(path, "unknown value '" + String(v).slice(0, 24) + "'"); };
  V.prototype.arr = function (v, path, max) { return (Array.isArray(v) && v.length <= max) || this.fail(path, "must be a list of at most " + max); };
  V.prototype.rows = function (v, path, chars) {
    if (!this.arr(v, path, MAP_H) || v.length !== MAP_H) return this.fail(path, "must have " + MAP_H + " rows");
    var re = new RegExp("^[" + chars + "]{" + MAP_W + "}$");
    for (var i = 0; i < v.length; i++) if (typeof v[i] !== "string" || !re.test(v[i])) return this.fail(path + "[" + i + "]", "bad map row");
    return true;
  };

  // Per-key limits match what the rules can produce.
  var CHAR_STATUS = { guard: 1, braced: 2, ward: 60, wardT: 3, fade: 1 };
  var FOE_STATUS = { stun: 3, root: 3, blind: 2, hex: 3, shroud: 2, dot: 10, dotT: 6, taunt: 1e9, tauntT: 2, censure: 1 };
  function checkStatus(v, st, path, limits, partyIds) {
    if (!v.obj(st, path, Object.keys(limits))) return;
    for (var k in st) v.int(st[k], path + "." + k, 0, limits[k]);
    if (st.taunt !== undefined && partyIds && partyIds.indexOf(st.taunt) < 0) v.fail(path + ".taunt", "refers to no party member");
  }
  function checkItem(v, it, path, ids) {
    if (!v.obj(it, path, ["id", "base", "rarity", "affixes"], ["id", "base", "rarity", "affixes"])) return;
    v.int(it.id, path + ".id", 1, 1e9);
    if (ids[it.id]) v.fail(path + ".id", "duplicate id"); ids[it.id] = 1;
    if (!v.oneOf(it.base, path + ".base", Object.keys(ITEMS))) return;
    var I = ITEMS[it.base];
    if (!v.oneOf(it.rarity, path + ".rarity", Object.keys(RARITY))) return;
    if ((it.rarity === "unique") !== !!I.unique) v.fail(path + ".rarity", "rarity does not match the item");
    if (!v.arr(it.affixes, path + ".affixes", 2)) return;
    if ((I.unique || I.slot === "use") && it.affixes.length) v.fail(path + ".affixes", "this item cannot have affixes");
    if (it.affixes.length > RARITY[it.rarity].affixes && it.rarity !== "common") v.fail(path + ".affixes", "too many affixes for rarity");
    if (it.rarity === "common" && it.affixes.length) v.fail(path + ".affixes", "common items have no affixes");
    it.affixes.forEach(function (a, i) {
      var p = path + ".affixes[" + i + "]";
      if (!Array.isArray(a) || a.length !== 2) { v.fail(p, "must be [affix, value]"); return; }
      if (!v.oneOf(a[0], p, Object.keys(AFFIXES))) return;
      var A = AFFIXES[a[0]];
      if (A.slots.indexOf(I.slot) < 0) v.fail(p, "affix not allowed on this slot");
      v.int(a[1], p + ".value", A.r[0], A.r[1] + 1);
    });
  }

  function validateState(o) {
    var errs = [], v = new V(errs);
    var TOP = ["format", "saveVersion", "genVersion", "seed", "daily", "status", "turn", "nextId", "rng", "party", "inventory", "floor", "pos",
      "combat", "levelQueue", "offer", "uniquesFound", "story", "log", "stats", "flags"];
    if (!o || typeof o !== "object" || Array.isArray(o) || o.format !== "gloam-below-run") { v.fail("format", "this is not a Gloam Below run file"); return errs; }
    if (o.saveVersion !== SAVE_VERSION) { v.fail("saveVersion", "save format " + String(o.saveVersion).slice(0, 10) + " is not supported (expected " + SAVE_VERSION + ")"); return errs; }
    if (o.genVersion !== GEN_VERSION) { v.fail("genVersion", "made with dungeon generator " + String(o.genVersion).slice(0, 20) + "; this game uses " + GEN_VERSION + " and would build different floors"); return errs; }
    if (!v.obj(o, "save", TOP, TOP)) return errs;
    if (o.saveVersion !== SAVE_VERSION) { v.fail("saveVersion", "save format " + o.saveVersion + " is not supported (expected " + SAVE_VERSION + ")"); return errs; }
    if (o.genVersion !== GEN_VERSION) { v.fail("genVersion", "made with dungeon generator " + String(o.genVersion).slice(0, 20) + "; this game uses " + GEN_VERSION + " and would build different floors"); return errs; }
    if (!v.str(o.seed, "seed", 32, 1)) return errs;
    v.bool(o.daily, "daily");
    v.oneOf(o.status, "status", ["explore", "combat", "victory", "defeat"]);
    v.int(o.turn, "turn", 0, 1e9); v.int(o.nextId, "nextId", 0, 1e9);
    if (v.obj(o.rng, "rng", ["runtime"], ["runtime"])) {
      var r = o.rng.runtime;
      if (!Array.isArray(r) || r.length !== 4) v.fail("rng.runtime", "must be 4 numbers");
      else { r.forEach(function (x, i) { v.int(x, "rng.runtime[" + i + "]", 0, 4294967295); }); if (r.every(function (x) { return x === 0; })) v.fail("rng.runtime", "invalid all-zero state"); }
    }
    if (v.obj(o.flags, "flags", [])) { /* no debug flags in imported runs */ }
    var ids = {};
    // Party
    var partyIds = [];
    if (v.arr(o.party, "party", 3) && o.party.length >= 1) {
      o.party.forEach(function (c, i) {
        var p = "party[" + i + "]";
        if (!v.obj(c, p, ["id", "name", "cls", "level", "xp", "hp", "down", "bonus", "upgrades", "st", "abilities", "equip", "solo"],
          ["id", "name", "cls", "level", "xp", "hp", "down", "bonus", "upgrades", "st", "abilities", "equip"])) return;
        v.int(c.id, p + ".id", 1, 1e9);
        if (ids[c.id]) v.fail(p + ".id", "duplicate id"); ids[c.id] = 1; partyIds.push(c.id);
        v.str(c.name, p + ".name", 24, 1);
        if (!v.oneOf(c.cls, p + ".cls", Object.keys(CLASSES))) return;
        v.int(c.level, p + ".level", 1, MAX_LEVEL); v.int(c.xp, p + ".xp", 0, 1e7);
        v.bool(c.down, p + ".down");
        if (c.solo !== undefined) { v.bool(c.solo, p + ".solo"); if (c.solo && o.party.length !== 1) v.fail(p + ".solo", "only a lone character can be solo"); }
        // Bonuses come only from level-up stat picks (one per level gained) and the Whetstone Altar (one per floor).
        var gained = Math.max(0, (c.level | 0) - 1);
        var BMAX = { hp: 7 * gained, pow: gained + LAST_FLOOR, wil: gained + LAST_FLOOR, arm: 0, acc: 6 * gained, eva: 5 * gained };
        if (v.obj(c.bonus, p + ".bonus", ["hp", "pow", "wil", "arm", "acc", "eva"], ["hp", "pow", "wil", "arm", "acc", "eva"])) for (var bk in c.bonus) v.int(c.bonus[bk], p + ".bonus." + bk, 0, BMAX[bk]);
        if (Array.isArray(c.upgrades) && c.upgrades.length > gained) v.fail(p + ".upgrades", "more upgrades than levels gained");
        if (v.arr(c.upgrades, p + ".upgrades", 40)) c.upgrades.forEach(function (u, k) {
          if (v.oneOf(u, p + ".upgrades[" + k + "]", Object.keys(UPGRADES))) {
            if (UPGRADES[u].cls !== c.cls) v.fail(p + ".upgrades[" + k + "]", "belongs to another class");
            if (c.upgrades.indexOf(u) !== k) v.fail(p + ".upgrades[" + k + "]", "duplicate upgrade");
          }
        });
        checkStatus(v, c.st, p + ".st", CHAR_STATUS);
        if (v.obj(c.equip, p + ".equip", SLOTS, SLOTS)) SLOTS.forEach(function (sl) {
          var it = c.equip[sl];
          if (it === null) return;
          checkItem(v, it, p + ".equip." + sl, ids);
          if (ITEMS[it.base] && ITEMS[it.base].slot !== sl) v.fail(p + ".equip." + sl, "item does not fit this slot");
        });
        if (errs.length) return;
        var learned = CLASSES[c.cls].abilities.slice();
        c.upgrades.forEach(function (u) { if (UPGRADES[u].kind === "learn") learned.push(UPGRADES[u].ability); });
        if (v.arr(c.abilities, p + ".abilities", 8)) c.abilities.forEach(function (a, k) {
          var ap = p + ".abilities[" + k + "]";
          if (!v.obj(a, ap, ["id", "charges"], ["id", "charges"])) return;
          if (!v.oneOf(a.id, ap + ".id", learned)) return;
          v.int(a.charges, ap + ".charges", 0, abilityMax(c, a.id));
        });
        if (!errs.length && c.abilities.length !== learned.length) v.fail(p + ".abilities", "does not match the class and learned abilities");
        if (!errs.length) {
          var mx = charStats(c).maxHp;
          v.int(c.hp, p + ".hp", 0, mx);
          if (c.down && c.hp !== 0) v.fail(p + ".hp", "downed characters have 0 HP");
          if (!c.down && c.hp < 1) v.fail(p + ".hp", "conscious characters need at least 1 HP");
          var lv = 1; while (lv < MAX_LEVEL && c.xp >= XP_TABLE[lv]) lv++;
          if (lv !== c.level) v.fail(p + ".level", "does not match the character's XP");
        }
      });
    } else v.fail("party", "must have 1 to 3 members");
    if (errs.length) return errs;
    if (v.arr(o.inventory, "inventory", INV_SIZE)) o.inventory.forEach(function (it, i) { checkItem(v, it, "inventory[" + i + "]", ids); });
    if (v.arr(o.uniquesFound, "uniquesFound", UNIQUE_IDS.length)) o.uniquesFound.forEach(function (u, i) { v.oneOf(u, "uniquesFound[" + i + "]", UNIQUE_IDS); });
    // Story must be the one this seed generates.
    if (JSON.stringify(o.story) !== JSON.stringify(makeStory(o.seed))) v.fail("story", "does not match the run seed");
    // Floor
    var f = o.floor;
    var FKEYS = ["num", "theme", "w", "h", "tiles", "polar", "seen", "rooms", "stairs", "objective", "enemies", "items", "features", "noticed"];
    if (!v.obj(f, "floor", FKEYS, FKEYS)) return errs;
    if (!v.int(f.num, "floor.num", 1, LAST_FLOOR)) return errs;
    if (f.w !== MAP_W || f.h !== MAP_H) { v.fail("floor", "wrong map size"); return errs; }
    v.rows(f.tiles, "floor.tiles", "#.bB"); v.rows(f.polar, "floor.polar", ".LD"); v.rows(f.seen, "floor.seen", "01");
    if (errs.length) return errs;
    var def;
    try { def = generateFloor(o.seed, f.num); } catch (ex) { v.fail("floor", "cannot rebuild this floor"); return errs; }
    if (f.theme !== def.theme) v.fail("floor.theme", "does not match the seed");
    for (var y = 0; y < MAP_H; y++) if (f.tiles[y].replace(/B/g, "b") !== def.tiles[y]) { v.fail("floor.tiles", "layout does not match the seed and generator"); break; }
    if (JSON.stringify(f.stairs) !== JSON.stringify(def.stairs)) v.fail("floor.stairs", "does not match the seed");
    if (v.arr(f.rooms, "floor.rooms", 40)) {
      if (f.rooms.length !== def.rooms.length) v.fail("floor.rooms", "do not match the seed");
      f.rooms.forEach(function (rm, i) {
        if (!v.obj(rm, "floor.rooms[" + i + "]", ["x", "y", "w", "h", "visited", "name", "text"], ["x", "y", "w", "h", "visited"])) return;
        v.bool(rm.visited, "floor.rooms[" + i + "].visited");
        var d = def.rooms[i] || {};
        if (rm.x !== d.x || rm.y !== d.y || rm.w !== d.w || rm.h !== d.h || rm.name !== d.name || rm.text !== d.text) v.fail("floor.rooms[" + i + "]", "does not match the seed");
      });
    }
    var ob = f.objective;
    if (v.obj(ob, "floor.objective", ["type", "done", "carried", "name"], ["type", "done"])) {
      if (ob.type !== def.objective.type) v.fail("floor.objective.type", "does not match the seed");
      v.bool(ob.done, "floor.objective.done");
      if (ob.carried !== undefined) v.bool(ob.carried, "floor.objective.carried");
      if (ob.name !== undefined && ob.name !== def.objective.name) v.fail("floor.objective.name", "does not match the seed");
    }
    function inB(x, y) { return typeof x === "number" && typeof y === "number" && x >= 0 && y >= 0 && x < MAP_W && y < MAP_H && Math.floor(x) === x && Math.floor(y) === y; }
    function walk(x, y) { return inB(x, y) && f.tiles[y].charAt(x) === "."; }
    var EKEYS = ["id", "type", "x", "y", "hp", "maxHp", "awake", "alerted", "hidden", "st", "xp", "cd", "spawned", "primary", "name", "from", "ward",
      "charge", "swell", "sweep", "nova", "phase", "summons", "casts", "lx", "ly"];
    var occupied = {};
    if (v.arr(f.enemies, "floor.enemies", 200)) f.enemies.forEach(function (e, i) {
      var p = "floor.enemies[" + i + "]";
      if (!v.obj(e, p, EKEYS, ["id", "type", "x", "y", "hp", "maxHp", "awake", "alerted", "hidden", "st", "xp"])) return;
      v.int(e.id, p + ".id", 1, 1e9); if (ids[e.id]) v.fail(p + ".id", "duplicate id"); ids[e.id] = 1;
      v.oneOf(e.type, p + ".type", Object.keys(ENEMIES));
      if (!walk(e.x, e.y)) v.fail(p, "stands somewhere impossible");
      if (occupied[e.x + "," + e.y]) v.fail(p, "shares a tile"); occupied[e.x + "," + e.y] = 1;
      v.int(e.maxHp, p + ".maxHp", 1, 10000); v.int(e.hp, p + ".hp", 1, e.maxHp);
      v.bool(e.awake, p + ".awake"); v.bool(e.alerted, p + ".alerted"); v.bool(e.hidden, p + ".hidden");
      v.int(e.xp, p + ".xp", 0, ENEMIES[e.type] ? ENEMIES[e.type].xp : 0);
      checkStatus(v, e.st, p + ".st", FOE_STATUS, partyIds);
      if (ENEMIES[e.type]) {
        if (e.hidden && !ENEMIES[e.type].lurk) v.fail(p + ".hidden", "this kind of foe cannot hide");
        if (ENEMIES[e.type].structure && e.spawned === undefined) v.fail(p + ".spawned", "missing");
        if (e.spawned !== undefined && (!ENEMIES[e.type].structure || e.spawned > ENEMIES.gate.total)) v.fail(p + ".spawned", "impossible");
        if (e.type === "boss" && f.num !== LAST_FLOOR) v.fail(p, "the final foe only appears on the last floor");
        if (e.type === "warden" && def.objective.type !== "warden") v.fail(p, "no warden belongs on this floor");
        if (e.primary && def.objective.type !== "gate") v.fail(p + ".primary", "this floor has no primary gate");
      }
      ["cd", "spawned", "from", "ward", "swell", "sweep", "phase", "summons", "casts", "lx", "ly"].forEach(function (k) { if (e[k] !== undefined) v.int(e[k], p + "." + k, -1, 1e9); });
      if (e.primary !== undefined) v.bool(e.primary, p + ".primary");
      if (e.name !== undefined) v.str(e.name, p + ".name", 80, 1);
      if (e.charge !== undefined && (!v.obj(e.charge, p + ".charge", ["dx", "dy"], ["dx", "dy"]) || !v.int(e.charge.dx, p + ".charge.dx", -1, 1) || !v.int(e.charge.dy, p + ".charge.dy", -1, 1))) return;
      if (e.nova !== undefined && v.obj(e.nova, p + ".nova", ["x", "y"], ["x", "y"]) && !inB(e.nova.x, e.nova.y)) v.fail(p + ".nova", "off the map");
    });
    if (v.arr(f.items, "floor.items", 200)) f.items.forEach(function (g, i) {
      var p = "floor.items[" + i + "]";
      if (!v.obj(g, p, ["x", "y", "item"], ["x", "y", "item"])) return;
      if (!walk(g.x, g.y)) v.fail(p, "lies somewhere impossible");
      checkItem(v, g.item, p + ".item", ids);
    });
    if (v.arr(f.features, "floor.features", 100)) f.features.forEach(function (ft, i) {
      var p = "floor.features[" + i + "]";
      if (!v.obj(ft, p, ["id", "kind", "x", "y", "sub", "dmg", "used"], ["id", "kind", "x", "y"])) return;
      v.int(ft.id, p + ".id", 1, 1e9); if (ids[ft.id]) v.fail(p + ".id", "duplicate id"); ids[ft.id] = 1;
      v.oneOf(ft.kind, p + ".kind", ["caltrops", "hazard", "shrine", "relic"]);
      if (!walk(ft.x, ft.y)) v.fail(p, "placed somewhere impossible");
      if (ft.kind === "hazard") v.oneOf(ft.sub, p + ".sub", Object.keys(HAZARDS));
      if ((ft.kind === "hazard" || ft.kind === "caltrops") && ft.dmg === undefined) v.fail(p + ".dmg", "missing");
      if (ft.kind === "relic" && def.objective.type !== "relic") v.fail(p, "no relic belongs on this floor");
      if (ft.kind === "shrine") { v.oneOf(ft.sub, p + ".sub", Object.keys(SHRINES)); v.bool(ft.used, p + ".used"); }
      if (ft.dmg !== undefined) v.int(ft.dmg, p + ".dmg", 0, 100);
    });
    if (v.arr(f.noticed, "floor.noticed", 3000)) f.noticed.forEach(function (k, i) { v.str(k, "floor.noticed[" + i + "]", 24, 1); });
    // Position, combat and pending choices
    if (v.obj(o.pos, "pos", ["x", "y"], ["x", "y"])) {
      if (!walk(o.pos.x, o.pos.y)) v.fail("pos", "the party stands somewhere impossible");
      else if (occupied[o.pos.x + "," + o.pos.y]) v.fail("pos", "the party shares a tile with an enemy");
    }
    if (o.status === "combat") {
      var cb = o.combat;
      if (v.obj(cb, "combat", ["round", "actor", "moved", "slip", "acted", "foes", "wall"], ["round", "actor", "moved", "slip", "acted", "foes"])) {
        v.int(cb.round, "combat.round", 1, 1e7);
        if (v.int(cb.actor, "combat.actor", 0, o.party.length - 1) && o.party[cb.actor].down) v.fail("combat.actor", "the acting character is downed");
        v.bool(cb.moved, "combat.moved"); v.int(cb.slip, "combat.slip", 0, 1e9);
        if (cb.wall !== undefined) v.bool(cb.wall, "combat.wall");
        if (v.arr(cb.acted, "combat.acted", 3)) cb.acted.forEach(function (id) { if (partyIds.indexOf(id) < 0) v.fail("combat.acted", "unknown character"); });
        if (v.arr(cb.foes, "combat.foes", 400)) cb.foes.forEach(function (id, i) { v.int(id, "combat.foes[" + i + "]", 1, 1e9); });
        if (!errs.length && cb.acted.indexOf(o.party[cb.actor].id) >= 0) v.fail("combat.actor", "has already acted");
      }
    } else if (o.combat !== null) v.fail("combat", "must be empty outside combat");
    if (o.status !== "defeat" && o.party.every(function (c) { return c.down; })) v.fail("party", "everyone is downed but the run is not over");
    if (o.status === "defeat" && o.party.some(function (c) { return !c.down; })) v.fail("status", "defeat with a conscious party");
    if (o.status === "victory" && (f.num !== LAST_FLOOR || f.enemies.some(function (e) { return e.type === "boss"; }) || !ob.done)) v.fail("status", "victory without defeating the final foe");
    // An unfinished objective needs its target to still exist, or the stairs would stay sealed forever.
    if (ob && !ob.done && o.status !== "defeat") {
      var need = { gate: function () { return f.enemies.some(function (e) { return e.primary && e.type === "gate"; }); },
        warden: function () { return f.enemies.some(function (e) { return e.type === "warden"; }); },
        boss: function () { return f.enemies.filter(function (e) { return e.type === "boss"; }).length === 1; },
        relic: function () { return ob.carried || f.features.filter(function (ft) { return ft.kind === "relic"; }).length === 1; },
        stairs: function () { return true; } };
      if (need[ob.type] && !need[ob.type]()) v.fail("floor.objective", "its target is missing, so it could never be completed");
    }
    var offered = {};
    if (v.arr(o.levelQueue, "levelQueue", 3 * (MAX_LEVEL - 1))) o.levelQueue.forEach(function (q, i) {
      var p = "levelQueue[" + i + "]";
      if (!v.obj(q, p, ["charId", "options"], ["charId", "options"])) return;
      var ch = o.party.filter(function (c) { return c.id === q.charId; })[0];
      if (!ch) { v.fail(p, "unknown character"); return; }
      if (!Array.isArray(q.options) || q.options.length < 1 || q.options.length > 3) { v.fail(p + ".options", "must offer 1 to 3 choices"); return; }
      var known = ch.abilities.map(function (a) { return a.id; });
      q.options.forEach(function (u) {
        if (!v.oneOf(u, p + ".options", Object.keys(UPGRADES))) return;
        var U = UPGRADES[u];
        if (U.kind === "stat") return;
        var key = ch.id + ":" + u;
        if (U.cls !== ch.cls || has(ch.upgrades, u) || offered[key] || (U.kind === "learn" && has(known, U.ability)) || (U.kind === "upgrade" && !has(known, U.ability))) v.fail(p + ".options", "offers a reward this character cannot take");
        offered[key] = 1;
      });
      if (!q.options.some(function (u) { return UPGRADES[u] && UPGRADES[u].kind === "stat"; })) v.fail(p + ".options", "must include a statistic choice");
    });
    if (o.offer !== null) {
      if (v.obj(o.offer, "offer", ["itemId"], ["itemId"]) && !f.items.some(function (g) { return g.item && g.item.id === o.offer.itemId; })) v.fail("offer", "refers to a missing item");
    }
    if (v.arr(o.log, "log", 200)) o.log.forEach(function (l, i) {
      if (!v.obj(l, "log[" + i + "]", ["t", "k", "m"], ["t", "k", "m"])) return;
      v.int(l.t, "log.t", 0, 1e9); v.oneOf(l.k, "log.k", ["info", "good", "bad", "warn", "miss", "hit", "story", "combat"]); v.str(l.m, "log.m", 400);
    });
    var SK = ["kills", "turns", "dmgDealt", "dmgTaken", "floorsCleared", "itemsFound"];
    if (v.obj(o.stats, "stats", SK, SK)) SK.forEach(function (k) { v.int(o.stats[k], "stats." + k, 0, 1e9); });
    var maxId = 0;
    Object.keys(ids).forEach(function (k) { if (+k > maxId) maxId = +k; });
    if (o.nextId < maxId) v.fail("nextId", "lower than an existing id");
    return errs;
  }

  // Refuse anything that could smuggle in prototype keys or absurd nesting.
  function scanSafe(x, depth, counter) {
    if (depth > 12) return "nesting is too deep";
    if (++counter.n > 200000) return "too many values";
    if (x && typeof x === "object") {
      var keys = Object.keys(x);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k === "__proto__" || k === "constructor" || k === "prototype") return "forbidden key '" + k + "'";
        var r = scanSafe(x[k], depth + 1, counter);
        if (r) return r;
      }
    }
    return null;
  }

  // Parse and validate a run file. Never touches any existing game state.
  function importRun(text) {
    if (typeof text !== "string") return { ok: false, error: "The file could not be read as text." };
    if (text.length > MAX_IMPORT_BYTES || utf8Length(text) > MAX_IMPORT_BYTES) return { ok: false, error: "That file is larger than 2 MiB; run files are much smaller. Nothing was changed." };
    var obj;
    try { obj = JSON.parse(text); } catch (ex) { return { ok: false, error: "That file is not valid JSON (it may be damaged or not a run file). Nothing was changed." }; }
    var bad = scanSafe(obj, 0, { n: 0 });
    if (bad) return { ok: false, error: "Rejected: " + bad + ". Nothing was changed." };
    var errs;
    try { errs = validateState(obj); } catch (ex2) { errs = ["the file's structure is invalid"]; }
    if (errs.length) return { ok: false, error: "This run file was rejected: " + errs.slice(0, 3).join("; ") + ". Nothing was changed.", errors: errs };
    return { ok: true, state: JSON.parse(JSON.stringify(obj)) };
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------
  var Game = {
    GEN_VERSION: GEN_VERSION, SAVE_VERSION: SAVE_VERSION, MAP_W: MAP_W, MAP_H: MAP_H, LAST_FLOOR: LAST_FLOOR, INV_SIZE: INV_SIZE,
    SLOTS: SLOTS, XP_TABLE: XP_TABLE,
    CLASSES: CLASSES, ABILITIES: ABILITIES, UPGRADES: UPGRADES, ITEMS: ITEMS, AFFIXES: AFFIXES, RARITY: RARITY, ENEMIES: ENEMIES, THEMES: THEMES,
    hash128: hash128, makeStream: makeStream, rnext: rnext, streamKey: streamKey, suggestName: suggestName,
    generateFloor: generateFloor, validateFloorDef: validateFloorDef,
    newRun: newRun, act: act, charStats: charStats, abilityMax: abilityMax, abilityTargets: abilityTargets,
    front: front, currentActor: currentActor, canSee: canSee, isSeen: isSeen, tileAt: tileAt, polarAt: polarAt,
    enemyAt: enemyAt, enemyById: enemyById, featureAt: featureAt, intentOf: intentOf, statusText: statusText, objectiveText: objectiveText,
    canDescend: canDescend, basicCheck: basicCheck, cheb: cheb, stepTowardTile: stepTowardTile,
    itemName: itemName, itemMods: itemMods, describeItem: describeItem, postCombatRecovery: postCombatRecovery,
    HAZARDS: HAZARDS, SHRINES: SHRINES, chargeLine: chargeLine, floorTitle: floorTitle, interceptor: interceptor,
    runPlan: runPlan, makeStory: makeStory, bossPhase: bossPhase, enemyName: enemyName, planStep: planStep,
    MAX_IMPORT_BYTES: MAX_IMPORT_BYTES, exportRun: exportRun, importRun: importRun, validateState: validateState,
    cleanSeed: cleanSeed, dailySeed: dailySeed,
    _internal: { rnd: function (s) { return rnext(s.rng.runtime); }, enterTile: enterTileEffects, killEnemy: killEnemy, enterFloor: enterFloor, spawnEnemy: spawnEnemy, grantXp: grantXp, floorRecovery: floorRecovery, makeItem: makeItem, endCombat: endCombat, maybeStartCombat: maybeStartCombat, updateVision: updateVision }
  };
  root.Game = Game;
  if (typeof module !== "undefined" && module.exports) module.exports = Game;
})(typeof globalThis !== "undefined" ? globalThis : this);
