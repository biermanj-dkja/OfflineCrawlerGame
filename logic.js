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
      desc: "Fire at up to 3 different visible foes within range 6 for 80% damage each." },
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
    up_mend: { cls: "votary", kind: "upgrade", ability: "mend", name: "Greater Mend", desc: "Mend heals 4 more and removes harmful effects. +1 max charge." },
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
  // Name generation (original syllables; deterministic per seed, slot and reroll count)
  // ------------------------------------------------------------------
  var NAME_A = ["Al", "Bran", "Cor", "Dag", "Ev", "Fen", "Gar", "Hes", "Il", "Jor", "Kael", "Lis", "Mor", "Nell", "Os", "Pell", "Quen", "Ros", "Sef", "Tam", "Ul", "Ves", "Wen", "Yor"];
  var NAME_B = ["ric", "wyn", "do", "na", "ett", "wick", "row", "per", "se", "ey", "an", "ka", "ven", "is", "mund", "ara", "tch", "elm", "ith", "orn", "a", "ble"];
  function suggestName(seed, slot, n) {
    var s = makeStream(streamKey(seed, "names", slot + "|" + n));
    var nm = rpick(s, NAME_A) + rpick(s, NAME_B);
    return nm.charAt(0).toUpperCase() + nm.slice(1);
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
  function isFloor(f, x, y) { return tileAt(f, x, y) !== "#"; }
  function polarAt(f, x, y) { return (x < 0 || y < 0 || x >= f.w || y >= f.h) ? "." : f.polar[y].charAt(x); }
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
        // minParty tags let one generated floor serve every party size identically.
        f.enemies.push({ type: rpick(s, theme.enemies), x: t.x, y: t.y, minParty: k === 0 ? 1 : k + 1 });
      }
    });
    // Fixed loot: equipment and consumables placed by the floor stream.
    var lootRooms = order.slice();
    var nLoot = 2 + (n >= 3 ? 1 : 0);
    for (var li = 0; li < nLoot + 1; li++) {
      var room = rooms[rpick(s, lootRooms).i], lt = freeTile(room);
      if (lt) f.items.push({ x: lt.x, y: lt.y, item: rollItemDef(s, n, li === nLoot) });
    }
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
    f.items.forEach(function (it) { if (!reach(it.x, it.y)) problems.push("item unreachable"); });
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
      levelQueue: [], offer: null,
      log: [], stats: { kills: 0, turns: 0, dmgDealt: 0, dmgTaken: 0, floorsCleared: 0, itemsFound: 0 }, flags: {}
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
      enemies: [], items: [], features: [], noticed: [] };
    state.floor = f;
    state.pos = { x: def.start.x, y: def.start.y };
    def.enemies.forEach(function (d) {
      if (d.minParty > size) return;
      spawnEnemy(state, d.type, d.x, d.y, {});
    });
    def.items.forEach(function (d) { f.items.push({ x: d.x, y: d.y, item: makeItem(state, d.item) }); });
    state.combat = null;
    state.status = "explore";
    state.offer = null;
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

  function enemyName(e) { return ENEMIES[e.type].name; }
  function enemyStat(state, e) {
    var D = ENEMIES[e.type], n = state.floor.num, b = Math.floor((n - 1) * 0.6);
    var st = { dmg: [D.dmg[0] + b, D.dmg[1] + b], acc: D.acc + 2 * (n - 1), eva: D.eva, arm: D.arm };
    if (e.st.blind) st.acc -= 40;
    return st;
  }

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
    f.enemies.forEach(function (e) {
      if (e.hidden || !v[idx(e.x, e.y)]) return;
      notice(state, "e" + e.id, "enemy", e.awake ? null : "You see a sleeping " + enemyName(e) + ".");
    });
    f.items.forEach(function (g) { if (v[idx(g.x, g.y)]) notice(state, "i" + g.item.id, "item", "You spot " + itemName(g.item) + "."); });
    if (v[idx(f.stairs.x, f.stairs.y)]) notice(state, "stairs", "stairs", "You spot the stairs down.");
    // Waking by awareness range (deterministic: distance and line of sight only).
    f.enemies.forEach(function (e) {
      var D = ENEMIES[e.type];
      if (!e.awake && D.aware && v[idx(e.x, e.y)] && cheb(e.x, e.y, state.pos.x, state.pos.y) <= D.aware) wake(state, e, "senses the party");
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
    state.combat = { round: 1, actor: -1, moved: false, slip: 0, acted: [] };
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
    if (checkCombatEnd(state)) return;
    var nx = nextActor(state, state.combat.actor);
    if (nx < 0) nx = nextActor(state, -1); // the actor list may shift if someone was downed
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
    state.floor.enemies.forEach(function (e) { delete e.st.taunt; });
    log(state, "The fighting ends." + (healed ? " The party catches its breath (recovery up to half health)." : ""), "good");
    emit("combatEnd", {});
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
    if (c.down || amount <= 0) return 0;
    if (state.combat && state.combat.wall) amount = Math.ceil(amount / 2);
    if (c.st.ward) {
      var ab = Math.min(c.st.ward, amount);
      c.st.ward -= ab; amount -= ab;
      if (ab) log(state, c.name + "'s ward absorbs " + ab + ".", "info");
      if (c.st.ward <= 0) { delete c.st.ward; delete c.st.wardT; }
    }
    if (state.flags.godMode) amount = 0;
    if (amount <= 0) return 0;
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
    if (amount < 1) amount = 1;
    if (e.st.hex) amount = Math.round(amount * 1.5);
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
    if (e.xp > 0) grantXp(state, e.xp);
    dropLoot(state, e);
  }

  function dropLoot(state, e) {
    var rt = state.rng.runtime;
    if (e.xp <= 0) return;
    if (!rchance(rt, 0.08 + e.xp * 0.01)) return;
    var def = rollItemDef(rt, state.floor.num, rchance(rt, 0.5));
    var it = makeItem(state, def);
    state.floor.items.push({ x: e.x, y: e.y, item: it });
    log(state, enemyName(e) + " drops " + itemName(it) + ".", "good");
    emit("discover", { what: "item" });
  }

  var XP_TABLE = [0, 20, 50, 90, 140, 200, 270, 350, 440];
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
      if (U.cls !== c.cls || has(c.upgrades, k)) return false;
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
      if (U.stat === "hp") c.hp += U.v;
    } else {
      c.upgrades.push(id);
      if (U.kind === "learn") c.abilities.push({ id: U.ability, charges: ABILITIES[U.ability].charges });
      if (U.kind === "upgrade") c.abilities.forEach(function (a) { if (a.id === U.ability && ABILITIES[a.id].charges) a.charges += 1; });
      if (id === "p_bulwark") c.hp += 6;
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
      if (e.st.dot && e.st.dotT) {
        log(state, enemyName(e) + " suffers " + e.st.dot + " (burning/poison).", "hit");
        hurtEnemy(state, e, e.st.dot, null);
        e.st.dotT -= 1; if (e.st.dotT <= 0) { delete e.st.dot; delete e.st.dotT; }
        if (f.enemies.indexOf(e) < 0) continue;
      }
      if (e.st.stun > 0) { e.st.stun -= 1; if (!e.st.stun) delete e.st.stun; log(state, enemyName(e) + " is stunned and loses its turn.", "info"); tickEnemy(e); continue; }
      enemyAct(state, e, dm);
      tickEnemy(e);
      if (!conscious(state).length) { defeat(state); return; }
    }
  }
  function tickEnemy(e) {
    ["root", "blind", "hex"].forEach(function (k) { if (e.st[k]) { e.st[k] -= 1; if (e.st[k] <= 0) delete e.st[k]; } });
    if (e.st.tauntT) { e.st.tauntT -= 1; if (e.st.tauntT <= 0) { delete e.st.tauntT; delete e.st.taunt; } }
  }

  function moveEnemy(state, e, nx, ny) {
    e.x = nx; e.y = ny;
    var trap = featureAt(state, nx, ny, "caltrops");
    if (trap) {
      state.floor.features.splice(state.floor.features.indexOf(trap), 1);
      e.st.root = 2;
      log(state, enemyName(e) + " steps on caltrops and is rooted.", "good");
      hurtEnemy(state, e, trap.dmg, null);
    }
  }
  function stepToward(state, e, dm) {
    if (e.st.root) return false;
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
    moveEnemy(state, e, best[0], best[1]);
    return true;
  }
  function stepAway(state, e, dm, mustSee) {
    if (e.st.root) return false;
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
    moveEnemy(state, e, best[0], best[1]);
    return true;
  }

  function enemyAct(state, e, dm) {
    var D = ENEMIES[e.type], d = cheb(e.x, e.y, state.pos.x, state.pos.y), seen = canSee(state, e.x, e.y);
    var es = enemyStat(state, e);
    if (D.ai === "melee") {
      if (d <= 1) enemyHits(state, e, partyTarget(state, e, "melee"), es.dmg, "melee", "bites");
      else stepToward(state, e, dm);
    } else if (D.ai === "ranged") {
      if (d < D.keep && !e.st.taunt && stepAway(state, e, dm, true)) return;
      if (seen && d <= D.range) enemyHits(state, e, partyTarget(state, e, "ranged"), es.dmg, "ranged", "shoots");
      else stepToward(state, e, dm);
    }
  }

  // Intent text shown to the player.
  function intentOf(state, e) {
    var D = ENEMIES[e.type];
    if (e.hidden) return "Hidden.";
    if (!e.awake) return "Asleep" + (D.aware ? " - wakes if you come within " + D.aware + " tiles," : " -") + " or when attacked, damaged, or a noisy action happens within 6 tiles.";
    if (e.st.stun > 0) return "Stunned - loses its next turn.";
    var d = cheb(e.x, e.y, state.pos.x, state.pos.y), t = e.st.taunt ? charById(state, e.st.taunt) : null;
    var tn = t ? t.name + " (taunted)" : null;
    if (D.ai === "melee") return d <= 1 ? "Will bite " + (tn || "the front rank") + "." : "Advancing on the front rank.";
    if (D.ai === "ranged") return d < D.keep && !t ? "Will try to back away, then shoot." : "Will shoot " + (tn || "a random party member") + ".";
    return "";
  }

  function statusText(st) {
    var out = [];
    if (st.stun) out.push("Stunned " + st.stun);
    if (st.root) out.push("Rooted " + st.root);
    if (st.blind) out.push("Blinded " + st.blind);
    if (st.hex) out.push("Hexed " + st.hex);
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

  function enterTileEffects(state) {
    var f = state.floor;
    f.rooms.forEach(function (r) { if (!r.visited && inRoom(r, state.pos.x, state.pos.y)) r.visited = true; });
    for (var i = f.items.length - 1; i >= 0; i--) {
      var g = f.items[i];
      if (g.x === state.pos.x && g.y === state.pos.y) pickUp(state, g);
    }
    if (state.pos.x === f.stairs.x && state.pos.y === f.stairs.y) {
      log(state, f.objective.done ? "The stairs lead down. Press > (or Descend) to go deeper." : "The stairs are sealed: " + objectiveText(state), "info");
    }
  }

  function pickUp(state, g) {
    var f = state.floor;
    if (state.inventory.length < INV_SIZE) {
      f.items.splice(f.items.indexOf(g), 1);
      state.inventory.push(g.item);
      state.stats.itemsFound += 1;
      log(state, "Picked up " + itemName(g.item) + ".", "good");
      emit("pickup", { id: g.item.id });
    } else if (state.status !== "combat") {
      state.offer = { itemId: g.item.id };
      log(state, "Inventory full (16). Choose something to discard, or leave " + itemName(g.item) + ".", "warn");
      emit("offer", {});
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

  // Charge rule on descending: recover half of the missing charges, rounded up.
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
    if (!canDescend(state)) return state.floor.objective.done ? "Stand on the stairs, out of combat, to descend." : "The stairs are sealed: " + objectiveText(state);
    state.stats.floorsCleared += 1;
    if (state.floor.num >= LAST_FLOOR) {
      state.status = "victory";
      log(state, "You escape the Gloam.", "good");
      emit("victory", {});
      return null;
    }
    floorRecovery(state);
    enterFloor(state, state.floor.num + 1);
    log(state, "The party descends to floor " + state.floor.num + ". Wounds close a little; some charges return.", "story");
    emit("descend", {});
    return null;
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
    if (state.status === "combat") {
      var actor = currentActor(state);
      if (state.combat.moved) return "The party has already moved this phase (one shared Move per party phase).";
      if (enemyAt(state, tx, ty)) return "An enemy blocks the way. Attack it instead.";
      var err = moveParty(state, dx, dy);
      if (err) return err;
      state.combat.moved = true;
      log(state, actor.name + " leads the party one step.", "info");
      if (state.combat.slip === actor.id) { state.combat.slip = 0; checkCombatEnd(state); return null; }
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
    rollAttack(state, c, e, 1, { basic: true });
    afterAct(state);
    return null;
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
        if (!isFloor(f, x, y) || !canSee(state, x, y)) continue;
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
    if (A.free && state.status === "combat") { checkCombatEnd(state); return null; }
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
      moveEnemy(state, e, nx, ny);
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
      case "shove":
        if (rollAttack(state, c, e, 0.8) && state.floor.enemies.indexOf(e) >= 0) {
          if (has(c.upgrades, "up_shove")) e.st.stun = Math.max(e.st.stun || 0, 1);
          knockback(state, e, 2);
        }
        return null;
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
        var victims = [e];
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
        if (has(c.upgrades, "up_mend")) { delete t.st.stun; }
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
    _internal: { enterFloor: enterFloor, spawnEnemy: spawnEnemy, grantXp: grantXp, floorRecovery: floorRecovery, makeItem: makeItem, endCombat: endCombat, maybeStartCombat: maybeStartCombat, updateVision: updateVision }
  };
  root.Game = Game;
  if (typeof module !== "undefined" && module.exports) module.exports = Game;
})(typeof globalThis !== "undefined" ? globalThis : this);
