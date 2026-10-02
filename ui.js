/* The Gloam Below - browser rendering and input. All rules live in logic.js (global Game).
 * Every player-visible string is written with textContent; imported text is never parsed as HTML. */
(function () {
  "use strict";
  var G = window.Game;
  var TS = 24; // canvas tile size in internal pixels
  var state = null;
  var ui = { screen: "title", sel: 0, travel: null, tgt: null, selItem: null, party: [], seed: "", daily: false, flashes: [] };
  var STAT_NAMES = { maxHp: "HP", pow: "Pow", wil: "Wil", arm: "Arm", acc: "Acc", eva: "Eva" };
  var RAR_COLOR = { common: "#d9d2c3", magic: "#9cc0ff", rare: "#ffe27a", unique: "#ffb070" };
  var SLOT_GLYPH = { weapon: ")", armor: "[", offhand: "(", charm: "=", use: "!" };
  var SLOT_LABEL = { weapon: "Wpn", armor: "Arm", offhand: "Off", charm: "Chm" };

  // ---------- DOM helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function button(label, fn, cls, tip) {
    var b = el("button", cls || "", label);
    b.type = "button";
    if (tip) b.dataset.tip = tip;
    b.addEventListener("click", fn);
    return b;
  }
  function show(screen) {
    ["title", "create", "game", "end"].forEach(function (s) { $("scr-" + s).hidden = s !== screen; });
    ui.screen = screen;
    hideTip();
  }
  function randomSeed() {
    var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", out = "";
    var buf = new Uint32Array(8);
    // The only nondeterministic call in the game: choosing a fresh New Game seed.
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(buf);
    else for (var i = 0; i < 8; i++) buf[i] = (Date.now() * (i + 7)) >>> 0;
    for (var k = 0; k < 8; k++) { out += chars.charAt(buf[k] % chars.length); if (k === 3) out += "-"; }
    return out;
  }

  // ---------- Tooltips (text only) ----------
  function showTip(text, x, y) {
    var t = $("tooltip");
    t.textContent = text;
    t.hidden = false;
    var w = t.offsetWidth, h = t.offsetHeight;
    var left = Math.min(window.innerWidth - w - 6, x + 14), top = y + 16;
    if (top + h > window.innerHeight - 4) top = Math.max(4, y - h - 10);
    t.style.left = Math.max(4, left) + "px"; t.style.top = top + "px";
  }
  function hideTip() { var t = $("tooltip"); if (t) t.hidden = true; }
  document.addEventListener("mouseover", function (ev) {
    var n = ev.target.closest ? ev.target.closest("[data-tip]") : null;
    if (n) showTip(n.dataset.tip, ev.clientX, ev.clientY);
    else if (ev.target.id !== "map") hideTip();
  });
  document.addEventListener("focusin", function (ev) {
    var n = ev.target.closest ? ev.target.closest("[data-tip]") : null;
    if (n) { var r = n.getBoundingClientRect(); showTip(n.dataset.tip, r.left, r.bottom); }
  });
  document.addEventListener("focusout", hideTip);

  // ---------- Title ----------
  function renderTitle() {
    show("title");
    var m = $("title-menu"); clear(m);
    m.appendChild(menuButton("N", "New Game", function () { startCreate(false); }));
    m.appendChild(menuButton("H", "Controls / Help", openHelp));
    var first = m.querySelector("button"); if (first) first.focus();
  }
  function menuButton(key, label, fn, disabled) {
    var b = el("button"); b.type = "button";
    b.appendChild(el("span", "", "[")); b.appendChild(el("span", "key", key)); b.appendChild(el("span", "", "] " + label));
    b.dataset.key = key.toLowerCase();
    b.disabled = !!disabled;
    b.addEventListener("click", fn);
    return b;
  }

  // ---------- Party creation ----------
  var CLASS_ORDER = ["sentinel", "stalker", "arcanist", "votary"];
  function startCreate(daily) {
    ui.daily = !!daily;
    ui.seed = randomSeed();
    ui.party = [newMember(0, "sentinel")];
    renderCreate();
  }
  function newMember(i, cls) { return { cls: cls, name: G.suggestName(ui.seed, i, 0), roll: 0 }; }
  function renderCreate() {
    show("create");
    var seedBox = $("create-seed"); clear(seedBox);
    seedBox.appendChild(el("span", "", "Run seed: "));
    seedBox.appendChild(el("b", "", ui.seed));
    var box = $("create-members"); clear(box);
    ui.party.forEach(function (p, i) {
      var card = el("div", "member-card");
      var h = el("h3", "", "Member " + (i + 1) + (i === 0 ? " - front rank" : " - back rank"));
      if (ui.party.length > 1) {
        h.appendChild(el("span", "spacer"));
        h.appendChild(button("Remove", function () { ui.party.splice(i, 1); renderCreate(); }, "", "Remove this member"));
      }
      card.appendChild(h);
      var row = el("div", "row");
      var inp = el("input"); inp.type = "text"; inp.maxLength = 18; inp.value = p.name;
      inp.setAttribute("aria-label", "Name for member " + (i + 1));
      inp.addEventListener("input", function () { p.name = inp.value; });
      row.appendChild(inp);
      row.appendChild(button("Reroll", function () { p.roll += 1; p.name = G.suggestName(ui.seed, i, p.roll); renderCreate(); }, "", "Suggest another name"));
      card.appendChild(row);
      var pick = el("div", "class-pick");
      CLASS_ORDER.forEach(function (cid) {
        var C = G.CLASSES[cid];
        var b = button(C.glyph + "  " + C.name, function () { p.cls = cid; renderCreate(); }, p.cls === cid ? "sel" : "", C.role);
        b.setAttribute("aria-pressed", p.cls === cid ? "true" : "false");
        pick.appendChild(b);
      });
      card.appendChild(pick);
      var C = G.CLASSES[p.cls], d = el("div", "class-desc");
      d.appendChild(el("b", "", C.name + " - " + C.role));
      d.appendChild(el("div", "", C.blurb));
      d.appendChild(el("div", "", "+ " + C.strengths));
      d.appendChild(el("div", "", "- " + C.weaknesses));
      d.appendChild(el("div", "", "HP " + C.base.hp + "  Pow " + C.base.pow + "  Wil " + C.base.wil + "  Arm " + C.base.arm + "  Acc " + C.base.acc + "  Eva " + C.base.eva));
      d.appendChild(el("div", "", "Abilities: " + C.abilities.map(function (a) { return G.ABILITIES[a].name; }).join(", ")));
      card.appendChild(d);
      box.appendChild(card);
    });
    var add = $("btn-add-member");
    add.hidden = ui.party.length >= 3;
  }
  function beginRun() {
    var party = ui.party.map(function (p) { return { cls: p.cls, name: cleanName(p.name) }; });
    state = G.newRun({ seed: ui.seed, daily: ui.daily, party: party });
    enterGame();
  }
  function cleanName(n) {
    n = String(n || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 18);
    return n || "Nameless";
  }
  function enterGame() {
    ui.sel = 0; ui.tgt = null; ui.selItem = null;
    show("game");
    fitCanvas();
    renderGame();
  }

  // ---------- Game rendering ----------
  function renderGame() {
    if (!state) return;
    if (state.status === "victory" || state.status === "defeat") { stopTravel(); renderEnd(); return; }
    if (ui.sel >= state.party.length) ui.sel = 0;
    renderHud(); renderParty(); renderActions(); renderGear(); renderLog(); renderInfo(); drawMap(); renderModals();
  }
  function renderHud() {
    $("hud-floor").textContent = "Floor " + state.floor.num + "/" + G.LAST_FLOOR;
    var o = $("hud-objective"), done = state.floor.objective.done;
    o.textContent = (done ? "Stairs open: " : "Objective: ") + (done ? "descend when ready." : G.objectiveText(state));
    o.className = "hud-obj" + (done ? " done" : "");
    o.dataset.tip = "Floor objective. The stairs stay sealed until it is complete.";
    $("hud-seed").textContent = (state.daily ? "Daily " : "Seed ") + state.seed;
  }

  function selectedChar() {
    return G.currentActor(state) || state.party[ui.sel] || G.front(state);
  }

  function renderParty() {
    var p = $("party"); clear(p);
    var actor = G.currentActor(state), inCombat = state.status === "combat";
    state.party.forEach(function (c, i) {
      var st = G.charStats(c), C = G.CLASSES[c.cls], isFront = G.front(state) === c;
      var card = el("div", "pcard" + (i === ui.sel ? " sel" : "") + (actor === c ? " actor" : "") + (c.down ? " down" : ""));
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", c.name + ", " + C.name + ", " + (isFront ? "front rank" : "back rank"));
      card.dataset.tip = (isFront ? "FRONT RANK: makes melee attacks and takes enemy melee attacks." : "BACK RANK: safe from melee; attacks only with reach or ranged weapons, spells or abilities.") +
        "\nPortrait order is the formation. " + (inCombat ? "Formation is locked during combat." : "Drag portraits or use the arrows to reorder.") +
        "\n" + C.name + ": " + C.strengths;
      if (ui.tgt && ui.tgt.kind === "ally" && ui.tgt.list.indexOf(c.id) >= 0) card.style.outline = "2px dashed #4ac0e0";
      var g = el("div", "pglyph", C.glyph); g.style.borderColor = C.color; g.style.color = C.color;
      card.appendChild(g);
      var nm = el("div", "pname");
      nm.appendChild(el("span", "", c.name + " "));
      nm.appendChild(el("span", "rank", (isFront ? "FRONT" : "back") + " " + C.name + " L" + c.level));
      card.appendChild(nm);
      var right = el("div", "pmeta", c.down ? "DOWNED" : c.hp + "/" + st.maxHp);
      card.appendChild(right);
      var bar = el("div", "bar"); var fill = el("i"); fill.style.width = Math.max(0, 100 * c.hp / st.maxHp) + "%"; bar.appendChild(fill);
      bar.appendChild(el("span", "half")); bar.dataset.tip = "HP. The tick marks 50%: automatic recovery after combat never goes past it.";
      card.appendChild(bar);
      var info = el("div", "pstat");
      var nextXp = G.XP_TABLE[c.level];
      info.appendChild(el("span", "", "XP " + c.xp + (nextXp ? "/" + nextXp : "")));
      info.appendChild(el("span", "", "Arm " + st.arm + " Eva " + st.eva));
      G.statusText(c.st).forEach(function (t) { info.appendChild(el("span", "tag", t)); });
      if (!inCombat && state.party.length > 1) {
        var ro = el("span", "reorder");
        var up = button("▲", function (ev) { ev.stopPropagation(); doAct({ type: "reorder", from: i, to: i - 1 }); ui.sel = Math.max(0, i - 1); renderGame(); }, "", "Move up in formation");
        var dn = button("▼", function (ev) { ev.stopPropagation(); doAct({ type: "reorder", from: i, to: i + 1 }); ui.sel = Math.min(state.party.length - 1, i + 1); renderGame(); }, "", "Move down in formation");
        up.disabled = i === 0; dn.disabled = i === state.party.length - 1;
        up.setAttribute("aria-label", "Move " + c.name + " up"); dn.setAttribute("aria-label", "Move " + c.name + " down");
        ro.appendChild(up); ro.appendChild(dn); info.appendChild(ro);
      }
      card.appendChild(info);
      card.addEventListener("click", function () { partyClick(i); });
      card.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { partyClick(i); ev.preventDefault(); } });
      if (!inCombat) {
        card.draggable = true;
        card.addEventListener("dragstart", function (ev) { ev.dataTransfer.setData("text/plain", String(i)); });
        card.addEventListener("dragover", function (ev) { ev.preventDefault(); card.classList.add("dragover"); });
        card.addEventListener("dragleave", function () { card.classList.remove("dragover"); });
        card.addEventListener("drop", function (ev) {
          ev.preventDefault();
          var from = parseInt(ev.dataTransfer.getData("text/plain"), 10);
          if (!isNaN(from) && from !== i) { doAct({ type: "reorder", from: from, to: i }); ui.sel = i; renderGame(); }
        });
      }
      p.appendChild(card);
    });
  }
  function partyClick(i) {
    var c = state.party[i];
    if (ui.tgt && (ui.tgt.kind === "ally" || ui.tgt.kind === "downed")) {
      if (ui.tgt.list.indexOf(c.id) >= 0) { confirmTarget(c.id); return; }
      flashInfo("Not a valid target."); return;
    }
    ui.sel = i; renderGame();
  }

  function renderActions() {
    var a = $("actions"); clear(a);
    var actor = G.currentActor(state), who = selectedChar(), inCombat = state.status === "combat";
    var line = el("div", "turnline");
    if (inCombat) {
      line.appendChild(el("span", "", "Round " + state.combat.round + ": "));
      var order = state.party.filter(function (c) { return !c.down; });
      order.forEach(function (c, k) {
        var done = state.combat.acted.indexOf(c.id) >= 0;
        var s = el(c === actor ? "b" : "span", "", (k ? " > " : "") + c.name + (done ? " (done)" : ""));
        if (done) s.style.opacity = ".5";
        line.appendChild(s);
      });
      line.appendChild(el("span", "", state.combat.moved ? " | Move used" : " | Move ready"));
    } else {
      line.appendChild(el("span", "", "Exploring - abilities used by "));
      line.appendChild(el("b", "", who.name));
    }
    a.appendChild(line);
    var grid = el("div", "abtns");
    var atk = el("button"); atk.type = "button";
    atk.appendChild(el("span", "kc", "F ")); atk.appendChild(el("span", "", "Attack"));
    atk.appendChild(el("span", "ch", G.charStats(who).weapon.kind));
    atk.dataset.tip = "Basic attack with " + G.charStats(who).weapon.name + " (" + G.charStats(who).weapon.kind + "). Melee weapons work only from the front rank. Unlimited.";
    atk.addEventListener("click", function () { startAttack(); });
    if (ui.tgt && ui.tgt.mode === "attack") atk.className = "targeting";
    grid.appendChild(atk);
    who.abilities.forEach(function (ab, k) {
      var A = G.ABILITIES[ab.id], mx = G.abilityMax(who, ab.id);
      var b = el("button"); b.type = "button";
      b.appendChild(el("span", "kc", (k + 1) + " "));
      b.appendChild(el("span", "", A.name));
      b.appendChild(el("span", "ch", A.charges ? ab.charges + "/" + mx : "∞"));
      b.dataset.tip = A.name + (A.charges ? " (" + ab.charges + "/" + mx + " charges)" : " (unlimited)") + "\n" + A.desc +
        (A.charges ? "\nCharges never return from resting: descending restores half of the missing charges (rounded up)." : "");
      if (A.charges && ab.charges <= 0) b.disabled = true;
      if (ui.tgt && ui.tgt.mode === "ability" && ui.tgt.id === ab.id) b.className = "targeting";
      b.addEventListener("click", function () { startAbility(k); });
      grid.appendChild(b);
    });
    a.appendChild(grid);
    var util = el("div", "utilrow");
    var mv = button(inCombat ? (state.combat.moved ? "Move: used" : "Move: ready") : "Move: free", function () { flashInfo(inCombat ? "Use WASD/arrows or click an adjacent tile to move the party (uses this character's action)." : "Use WASD/arrows, the numpad, or click a known tile."); }, "",
      "Shared Move: in combat the whole party moves one tile, once per party phase, using the acting character's action. Later characters act from the new tile.");
    util.appendChild(mv);
    util.appendChild(button("Rest (Space)", function () { stopTravel(); doAct({ type: "rest" }); }, "", inCombat ? "Skip this character's action." : "Wait one turn. Waiting never heals or restores charges."));
    var d = button("Descend (>)", function () { doAct({ type: "descend" }); }, G.canDescend(state) ? "primary" : "", "Descend when standing on open stairs. On descending: downed allies revive at 25% HP, others heal 25%, and abilities recover half their missing charges.");
    d.disabled = !G.canDescend(state);
    util.appendChild(d);
    if (ui.tgt) util.appendChild(button("Cancel (Esc)", cancelTarget));
    a.appendChild(util);
  }

  function renderGear() {
    var gbox = $("gear"); clear(gbox);
    var c = state.party[ui.sel] || state.party[0];
    var t1 = el("div", "gear-title");
    t1.appendChild(el("span", "", "Equipment: " + c.name));
    var st = G.charStats(c);
    t1.appendChild(el("span", "", "Pow " + st.pow + " Wil " + st.wil + " Acc " + st.acc));
    gbox.appendChild(t1);
    var eq = el("div", "slots");
    eq.style.gridTemplateColumns = "repeat(4, 1fr)";
    G.SLOTS.forEach(function (sl) {
      var it = c.equip[sl];
      eq.appendChild(itemSlot(it, SLOT_LABEL[sl], function () { ui.selItem = it ? { id: it.id, equipped: true, char: c.id, slot: sl } : null; renderGame(); }));
    });
    gbox.appendChild(eq);
    var t2 = el("div", "gear-title");
    t2.appendChild(el("span", "", "Inventory " + state.inventory.length + "/" + G.INV_SIZE + " (shared)"));
    t2.appendChild(el("span", "fine", "click: details  dbl-click: equip/use"));
    gbox.appendChild(t2);
    var inv = el("div", "slots");
    for (var k = 0; k < G.INV_SIZE; k++) {
      (function (it) {
        var s = itemSlot(it, null, function () { ui.selItem = it ? { id: it.id } : null; renderGame(); });
        if (it) s.addEventListener("dblclick", function () { quickUse(it); });
        inv.appendChild(s);
      })(state.inventory[k]);
    }
    gbox.appendChild(inv);
  }
  function itemSlot(it, label, fn) {
    var s = el("button", "slot");
    s.type = "button";
    if (!it) { s.className = "slot empty"; s.textContent = label || ""; s.disabled = !label; if (label) s.addEventListener("click", fn); return s; }
    var I = G.ITEMS[it.base];
    s.className = "slot r-" + it.rarity + (ui.selItem && ui.selItem.id === it.id ? " sel" : "");
    if (label) s.appendChild(el("span", "lbl", label));
    s.appendChild(el("span", "", SLOT_GLYPH[I.slot]));
    s.appendChild(el("span", "rk", G.RARITY[it.rarity].mark));
    s.dataset.tip = G.itemName(it) + "  [" + G.RARITY[it.rarity].name + (I.slot === "use" ? " consumable" : " " + I.slot) + "]\n" + G.describeItem(it).join("\n");
    s.setAttribute("aria-label", G.itemName(it));
    s.addEventListener("click", fn);
    return s;
  }
  function findInv(id) { for (var i = 0; i < state.inventory.length; i++) if (state.inventory[i].id === id) return state.inventory[i]; return null; }
  function quickUse(it) {
    var I = G.ITEMS[it.base];
    if (I.slot === "use") { useItem(it); return; }
    var c = state.party[ui.sel];
    doAct({ type: "equip", item: it.id, char: c.id });
  }

  function statDelta(c, it) {
    var I = G.ITEMS[it.base], cur = G.charStats(c);
    var clone = JSON.parse(JSON.stringify(c));
    clone.equip[I.slot] = it;
    var nx = G.charStats(clone), parts = [];
    Object.keys(STAT_NAMES).forEach(function (k) { var d = nx[k] - cur[k]; if (d) parts.push({ t: (d > 0 ? "+" : "") + d + " " + STAT_NAMES[k], up: d > 0 }); });
    if (I.slot === "weapon") {
      var a = cur.weapon, b = nx.weapon;
      var avgA = (a.dmg[0] + a.dmg[1]) / 2 + Math.floor(cur[a.stat] / 2), avgB = (b.dmg[0] + b.dmg[1]) / 2 + Math.floor(nx[b.stat] / 2);
      var d2 = Math.round((avgB - avgA) * 10) / 10;
      if (d2) parts.push({ t: (d2 > 0 ? "+" : "") + d2 + " avg dmg", up: d2 > 0 });
      if (a.kind !== b.kind) parts.push({ t: a.kind + "→" + b.kind, up: b.kind !== "melee" });
    }
    return parts;
  }

  function renderInfo() {
    var box = $("info"); clear(box);
    var s = ui.selItem, it = null;
    if (s) {
      if (s.equipped) { var ch = state.party.filter(function (c) { return c.id === s.char; })[0]; it = ch && ch.equip[s.slot]; if (!it || it.id !== s.id) it = null; }
      else it = findInv(s.id);
      if (!it) ui.selItem = null;
    }
    if (!it) {
      if (ui.tgt) { box.appendChild(el("div", "ttl", "Targeting: " + ui.tgt.label)); box.appendChild(el("div", "", "Click a highlighted target, or Tab to cycle and Enter to confirm. Esc cancels.")); return; }
      box.appendChild(el("div", "ttl", "Hover the map or an item for details."));
      box.appendChild(el("div", "fine", "Select an inventory item to compare and equip it. Formation: slot 1 is the front rank."));
      return;
    }
    var I = G.ITEMS[it.base];
    var nm = el("div", "iname", G.itemName(it) + "  [" + G.RARITY[it.rarity].name + "]");
    nm.style.color = RAR_COLOR[it.rarity];
    box.appendChild(nm);
    G.describeItem(it).forEach(function (t) { box.appendChild(el("div", "", t)); });
    var row = el("div", "utilrow");
    if (s.equipped) {
      row.appendChild(button("Unequip", function () { doAct({ type: "unequip", char: s.char, slot: s.slot }); ui.selItem = null; renderGame(); }));
    } else if (I.slot === "use") {
      row.appendChild(button("Use", function () { useItem(it); }));
      row.appendChild(button("Discard", function () { doAct({ type: "discard", item: it.id }); ui.selItem = null; renderGame(); }));
    } else {
      state.party.forEach(function (c) {
        var b = el("button"); b.type = "button";
        b.appendChild(el("span", "", "Equip: " + c.name + " "));
        statDelta(c, it).forEach(function (p) { b.appendChild(el("span", p.up ? "up" : "dn", p.t + " ")); });
        var cur = c.equip[I.slot];
        b.dataset.tip = "Replaces " + (cur ? G.itemName(cur) + " (it goes into this inventory slot)" : "nothing") + ".";
        b.addEventListener("click", function () { doAct({ type: "equip", item: it.id, char: c.id }); ui.selItem = null; renderGame(); });
        row.appendChild(b);
      });
      row.appendChild(button("Discard", function () { doAct({ type: "discard", item: it.id }); ui.selItem = null; renderGame(); }));
    }
    box.appendChild(row);
  }

  function renderLog() {
    var l = $("log"); clear(l);
    state.log.slice(-40).forEach(function (e) { l.appendChild(el("div", "l-" + e.k, e.m)); });
    l.scrollTop = l.scrollHeight;
  }

  // ---------- Modals: level-up and full inventory ----------
  function renderModals() {
    if (!$("modal").hidden && ui.modal === "help") return;
    if (state.levelQueue.length && state.status === "explore") { showLevelUp(); return; }
    if (state.offer) { showOffer(); return; }
    if (ui.modal === "level" || ui.modal === "offer") closeModal();
  }
  function openModal(kind) { ui.modal = kind; $("modal").hidden = false; }
  function closeModal() { $("modal").hidden = true; ui.modal = null; }
  function showLevelUp() {
    var q = state.levelQueue[0], c = state.party.filter(function (m) { return m.id === q.charId; })[0];
    var box = $("modal-box"); clear(box);
    box.appendChild(el("h2", "", c.name + " the " + G.CLASSES[c.cls].name + " reaches level " + levelOf(q, c) + "!"));
    box.appendChild(el("p", "fine", "Choose one reward (keys 1-3)." + (state.levelQueue.length > 1 ? " " + (state.levelQueue.length - 1) + " more level-up choice(s) after this." : "")));
    q.options.forEach(function (oid, k) {
      var U = G.UPGRADES[oid];
      var b = el("button", "choice"); b.type = "button";
      b.appendChild(el("b", "", (k + 1) + ". " + U.name + "  "));
      b.appendChild(el("span", "ctype", "[" + ({ learn: "new ability", upgrade: "upgrade", passive: "passive", stat: "statistic" })[U.kind] + "]"));
      b.appendChild(el("div", "", U.desc));
      b.dataset.opt = oid;
      b.addEventListener("click", function () { doAct({ type: "choose", option: oid }); });
      box.appendChild(b);
    });
    openModal("level");
    var f = box.querySelector("button"); if (f) f.focus();
  }
  function levelOf(q, c) {
    var pending = state.levelQueue.filter(function (x) { return x.charId === c.id; }).length;
    return c.level - pending + 1;
  }
  function showOffer() {
    var g = null;
    state.floor.items.forEach(function (x) { if (x.item.id === state.offer.itemId) g = x; });
    if (!g) { doAct({ type: "take", leave: true }); return; }
    var box = $("modal-box"); clear(box);
    box.appendChild(el("h2", "", "Inventory full"));
    var nm = el("p", "", "Found: " + G.itemName(g.item) + " [" + G.RARITY[g.item.rarity].name + "]");
    nm.style.color = RAR_COLOR[g.item.rarity];
    box.appendChild(nm);
    G.describeItem(g.item).forEach(function (t) { box.appendChild(el("p", "fine", t)); });
    box.appendChild(el("h3", "", "Discard one item to take it:"));
    var list = el("div", "slots");
    state.inventory.forEach(function (it) {
      var s = itemSlot(it, null, function () { doAct({ type: "discard", item: it.id }); });
      list.appendChild(s);
    });
    box.appendChild(list);
    var foot = el("div", "modal-foot");
    foot.appendChild(button("Leave it (Esc)", function () { doAct({ type: "take", leave: true }); }, "primary"));
    box.appendChild(foot);
    openModal("offer");
    foot.querySelector("button").focus();
  }

  // ---------- Map ----------
  function fitCanvas() {
    var wrap = $("map-wrap"), cv = $("map");
    var r = wrap.getBoundingClientRect();
    var s = Math.min(r.width / cv.width, r.height / cv.height);
    cv.style.width = Math.floor(cv.width * s) + "px";
    cv.style.height = Math.floor(cv.height * s) + "px";
  }
  function drawMap() {
    var cv = $("map"), g = cv.getContext("2d"), f = state.floor;
    g.fillStyle = "#050407"; g.fillRect(0, 0, cv.width, cv.height);
    for (var y = 0; y < f.h; y++) for (var x = 0; x < f.w; x++) {
      if (!G.isSeen(f, x, y)) continue;
      var vis = G.canSee(state, x, y), px = x * TS, py = y * TS;
      if (G.tileAt(f, x, y) === "#") {
        g.fillStyle = "#3b3542"; g.fillRect(px, py, TS, TS);
        g.fillStyle = "#2a2530"; g.fillRect(px, py + 11, TS, 2); g.fillRect(px + 11, py, 2, 11); g.fillRect(px + 4, py + 13, 2, 11);
      } else {
        var pol = G.polarAt(f, x, y);
        g.fillStyle = pol === "L" ? "#2e2616" : pol === "D" ? "#0d0b14" : "#17141b"; g.fillRect(px, py, TS, TS);
        if (pol === "L") { g.fillStyle = "#6a5428"; g.fillRect(px + 5, py + 5, 2, 2); g.fillRect(px + 16, py + 15, 2, 2); }
        else if (pol === "D") { g.strokeStyle = "#221d33"; g.lineWidth = 1; g.beginPath(); g.moveTo(px, py + TS); g.lineTo(px + TS, py); g.moveTo(px, py + 12); g.lineTo(px + 12, py); g.stroke(); }
        else { g.fillStyle = "#2a2530"; g.fillRect(px + 11, py + 11, 2, 2); }
      }
      if (!vis) { g.fillStyle = "rgba(5,4,7,0.62)"; g.fillRect(px, py, TS, TS); }
    }
    f.features.forEach(function (ft) {
      if (!G.isSeen(f, ft.x, ft.y)) return;
      if (ft.kind === "caltrops") drawGlyph(g, ft.x, ft.y, "%", "#b0e0a0", "#4a8a4a", "diamond");
    });
    if (G.isSeen(f, f.stairs.x, f.stairs.y)) drawGlyph(g, f.stairs.x, f.stairs.y, ">", f.objective.done ? "#9fe0ff" : "#6a7a80", f.objective.done ? "#9fe0ff" : "#5a6a70", "box", !f.objective.done);
    f.items.forEach(function (gi) {
      if (!G.canSee(state, gi.x, gi.y)) return;
      var I = G.ITEMS[gi.item.base];
      drawGlyph(g, gi.x, gi.y, SLOT_GLYPH[I.slot], RAR_COLOR[gi.item.rarity], RAR_COLOR[gi.item.rarity], gi.item.rarity === "unique" ? "star" : gi.item.rarity === "rare" ? "double" : "box");
    });
    f.enemies.forEach(function (e) {
      if (e.hidden || !G.canSee(state, e.x, e.y)) return;
      var D = G.ENEMIES[e.type];
      drawGlyph(g, e.x, e.y, D.glyph, "#ffb4a8", "#d0503a", "round");
      var w = Math.max(2, Math.round((TS - 4) * e.hp / e.maxHp));
      g.fillStyle = "#000"; g.fillRect(e.x * TS + 2, e.y * TS + TS - 4, TS - 4, 3);
      g.fillStyle = "#e04a3a"; g.fillRect(e.x * TS + 2, e.y * TS + TS - 4, w, 3);
      if (!e.awake) badge(g, e.x, e.y, "z", "#9fd0ff");
      else if (e.st.stun > 0) badge(g, e.x, e.y, "*", "#ffe27a");
      else if (e.st.root > 0) badge(g, e.x, e.y, "#", "#b0e0a0");
    });
    // Party: one token. Companions trail as small pips on the leader's tile.
    var ld = G.front(state) || state.party[0], C = G.CLASSES[ld.cls];
    drawGlyph(g, state.pos.x, state.pos.y, "@", "#fff3d0", C.color, "square");
    var others = state.party.filter(function (c) { return c !== ld; });
    others.forEach(function (c, k) {
      g.fillStyle = c.down ? "#555" : G.CLASSES[c.cls].color;
      g.fillRect(state.pos.x * TS + 2 + k * 5, state.pos.y * TS + 1, 4, 4);
    });
    if (ui.tgt) drawTargets(g);
    drawFlashes(g);
  }
  function drawTargets(g) {
    var t = ui.tgt;
    g.lineWidth = 2;
    t.list.forEach(function (v, k) {
      var x, y;
      if (t.kind === "tile") { x = v.x; y = v.y; }
      else if (t.kind === "enemy") { var e = G.enemyById(state, v); if (!e) return; x = e.x; y = e.y; }
      else return;
      g.strokeStyle = k === t.i ? "#ffffff" : "#4ac0e0";
      g.setLineDash(k === t.i ? [] : [4, 3]);
      g.strokeRect(x * TS + 1, y * TS + 1, TS - 2, TS - 2);
    });
    g.setLineDash([]);
  }
  function drawGlyph(g, x, y, ch, color, border, shape, locked) {
    var px = x * TS, py = y * TS, c = TS / 2;
    g.fillStyle = "#0b0a0d";
    g.fillRect(px + 2, py + 2, TS - 4, TS - 4);
    g.strokeStyle = border; g.lineWidth = 2;
    g.beginPath();
    if (shape === "round") g.arc(px + c, py + c, c - 3, 0, Math.PI * 2);
    else if (shape === "diamond") { g.moveTo(px + c, py + 2); g.lineTo(px + TS - 2, py + c); g.lineTo(px + c, py + TS - 2); g.lineTo(px + 2, py + c); g.closePath(); }
    else if (shape === "star") { for (var i = 0; i < 10; i++) { var a = i * Math.PI / 5 - Math.PI / 2, r = i % 2 ? 5 : 11; g.lineTo(px + c + Math.cos(a) * r, py + c + Math.sin(a) * r); } g.closePath(); }
    else if (shape === "double") { g.rect(px + 2, py + 2, TS - 4, TS - 4); g.rect(px + 5, py + 5, TS - 10, TS - 10); }
    else g.rect(px + 3, py + 3, TS - 6, TS - 6);
    g.stroke();
    g.fillStyle = color; g.font = "bold 15px Consolas, monospace"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(ch, px + c, py + c + 1);
    if (locked) { g.strokeStyle = "#c06050"; g.lineWidth = 2; g.beginPath(); g.moveTo(px + 4, py + 4); g.lineTo(px + TS - 4, py + TS - 4); g.stroke(); }
  }
  function badge(g, x, y, ch, color) {
    var px = x * TS + TS - 9, py = y * TS;
    g.fillStyle = "#000"; g.fillRect(px, py, 9, 10);
    g.fillStyle = color; g.font = "bold 10px Consolas, monospace"; g.textAlign = "center"; g.textBaseline = "top";
    g.fillText(ch, px + 4.5, py);
  }
  function drawFlashes(g) {
    var now = Date.now();
    ui.flashes = ui.flashes.filter(function (fl) { return now - fl.t < 260; });
    ui.flashes.forEach(function (fl) {
      g.fillStyle = fl.c; g.globalAlpha = 0.55 * (1 - (now - fl.t) / 260);
      g.fillRect(fl.x * TS, fl.y * TS, TS, TS);
      g.globalAlpha = 1;
    });
    if (ui.flashes.length) requestAnimationFrame(function () { if (state && ui.screen === "game") drawMap(); });
  }
  function tileFromEvent(ev) {
    var cv = $("map"), r = cv.getBoundingClientRect();
    var x = Math.floor((ev.clientX - r.left) / r.width * G.MAP_W), y = Math.floor((ev.clientY - r.top) / r.height * G.MAP_H);
    if (x < 0 || y < 0 || x >= G.MAP_W || y >= G.MAP_H) return null;
    return { x: x, y: y };
  }
  function describeTile(x, y) {
    var f = state.floor;
    if (!G.isSeen(f, x, y)) return "Unexplored darkness.";
    var out = [], vis = G.canSee(state, x, y);
    var e = G.enemyAt(state, x, y);
    if (e && !e.hidden && vis) {
      var D = G.ENEMIES[e.type];
      out.push(D.name + "  HP " + e.hp + "/" + e.maxHp + (e.awake ? "" : "  [ASLEEP - z]"));
      out.push(D.desc);
      out.push("Intent: " + G.intentOf(state, e));
      var sts = G.statusText(e.st); if (sts.length) out.push("Status: " + sts.join(", "));
      out.push("XP: " + e.xp + " to each conscious party member.");
    }
    if (x === state.pos.x && y === state.pos.y) out.push("Your party: " + state.party.map(function (c, i) { return (i + 1) + "." + c.name; }).join(" ") + "\nThe whole party shares one tile; portrait order is the formation.");
    if (x === f.stairs.x && y === f.stairs.y) out.push("Stairs down" + (f.objective.done ? " - open." : " - sealed: " + G.objectiveText(state)));
    f.items.forEach(function (gi) { if (gi.x === x && gi.y === y && vis) out.push(G.itemName(gi.item) + " [" + G.RARITY[gi.item.rarity].name + "] - walk over it to pick it up."); });
    var ft = G.featureAt(state, x, y);
    if (ft && ft.kind === "caltrops") out.push("Your caltrops: the first foe to step here is hurt and rooted.");
    var pol = G.polarAt(f, x, y);
    if (G.tileAt(f, x, y) !== "#" && pol !== ".") out.push(pol === "L" ? "Lit ground (dotted): shadow-kin weaken here." : "Deep shadow (hatched): shadow-kin thrive and hidden things lurk here.");
    if (!out.length) out.push(G.tileAt(f, x, y) === "#" ? "Wall." : "Floor.");
    if (!vis) out.push("(remembered - not currently in sight)");
    return out.join("\n");
  }

  // ---------- Actions ----------
  function doAct(a) {
    if (!state) return null;
    var res = G.act(state, a);
    if (!res.ok && res.msg) flashInfo(res.msg);
    res.events.forEach(function (ev) {
      if (ev.type === "hit" && ev.data) ui.flashes.push({ x: ev.data.x, y: ev.data.y, c: "#ff4030", t: Date.now() });
      if (ev.type === "hurt") ui.flashes.push({ x: state.pos.x, y: state.pos.y, c: "#ff2020", t: Date.now() });
      if (ev.type === "heal") ui.flashes.push({ x: state.pos.x, y: state.pos.y, c: "#40ff80", t: Date.now() });
      if (ev.type === "combat") banner("Combat! Party phase: act in portrait order.", false);
      if (ev.type === "combatEnd") banner("Combat over.", true);
      if (ev.type === "descend") banner("Floor " + state.floor.num + ": " + G.objectiveText(state), true);
    });
    if (state.status !== "combat" && ui.tgt && ui.tgt.combatOnly) ui.tgt = null;
    if (res.ok) ui.tgt = null;
    renderGame();
    return res;
  }
  function banner(msg, calm) {
    var b = $("banner"); b.textContent = msg; b.className = "banner" + (calm ? " calm" : ""); b.hidden = false;
    clearTimeout(banner.t); banner.t = setTimeout(function () { b.hidden = true; }, 1800);
  }
  function flashInfo(msg) { banner(msg, false); }

  // Targeting: enemies on the map, tiles on the map, or allies in the party panel.
  function startAttack() {
    var who = selectedChar();
    var list = state.floor.enemies.filter(function (e) { return !G.basicCheck(state, who, e); }).map(function (e) { return e.id; });
    if (!list.length) {
      var any = state.floor.enemies.filter(function (e) { return !e.hidden && G.canSee(state, e.x, e.y); })[0];
      flashInfo(any ? G.basicCheck(state, who, any) : "No visible foe."); return;
    }
    if (list.length === 1) { doAct({ type: "attack", target: list[0], actor: who.id }); return; }
    ui.tgt = { mode: "attack", kind: "enemy", list: sortByDist(list), i: 0, label: "Attack with " + who.name, actor: who.id };
    renderGame();
  }
  function startAbility(k) {
    var who = selectedChar();
    if (!who || !who.abilities[k]) return;
    var id = who.abilities[k].id, A = G.ABILITIES[id];
    if (ui.tgt && ui.tgt.mode === "ability" && ui.tgt.id === id) { confirmTarget(); return; }
    var tg = G.abilityTargets(state, who, id);
    if (tg.why) { flashInfo(tg.why); return; }
    if (A.target === "none") { doAct({ type: "ability", id: id, actor: who.id }); return; }
    var list = A.target === "enemy" ? sortByDist(tg.list) : tg.list;
    if (A.target === "ally") { list = list.slice().sort(function (a, b) { return hpFrac(a) - hpFrac(b); }); }
    ui.tgt = { mode: "ability", id: id, kind: A.target, list: list, i: 0, label: A.name, actor: who.id, combatOnly: !!A.combat };
    renderGame();
  }
  function useItem(it) {
    var I = G.ITEMS[it.base], who = selectedChar();
    if (I.use === "none") { doAct({ type: "use", item: it.id, actor: who.id }); return; }
    var list;
    if (I.use === "ally") list = state.party.filter(function (c) { return !c.down; }).map(function (c) { return c.id; }).sort(function (a, b) { return hpFrac(a) - hpFrac(b); });
    else if (I.use === "downed") list = state.party.filter(function (c) { return c.down; }).map(function (c) { return c.id; });
    else list = sortByDist(state.floor.enemies.filter(function (e) { return !e.hidden && G.canSee(state, e.x, e.y) && G.cheb(e.x, e.y, state.pos.x, state.pos.y) <= I.range; }).map(function (e) { return e.id; }));
    if (!list.length) { flashInfo("No valid target for " + I.name + "."); return; }
    ui.tgt = { mode: "item", item: it.id, kind: I.use === "enemy" ? "enemy" : I.use === "downed" ? "downed" : "ally", list: list, i: 0, label: I.name, actor: who.id };
    renderGame();
  }
  function hpFrac(id) { var c = state.party.filter(function (m) { return m.id === id; })[0]; return c ? c.hp / G.charStats(c).maxHp : 1; }
  function sortByDist(ids) {
    return ids.slice().sort(function (a, b) {
      var ea = G.enemyById(state, a), eb = G.enemyById(state, b);
      return G.cheb(ea.x, ea.y, state.pos.x, state.pos.y) - G.cheb(eb.x, eb.y, state.pos.x, state.pos.y) || a - b;
    });
  }
  function confirmTarget(v) {
    var t = ui.tgt; if (!t) return;
    if (v === undefined) v = t.list[t.i];
    var a;
    if (t.mode === "attack") a = { type: "attack", target: v, actor: t.actor };
    else if (t.mode === "item") a = { type: "use", item: t.item, target: v, actor: t.actor };
    else if (t.kind === "tile") a = { type: "ability", id: t.id, x: v.x, y: v.y, actor: t.actor };
    else a = { type: "ability", id: t.id, target: v, actor: t.actor };
    ui.tgt = null;
    doAct(a);
  }
  function cancelTarget() { ui.tgt = null; renderGame(); }

  // Click-to-travel resolves one tile at a time and stops on new information.
  function stopTravel() { if (ui.travel) { clearTimeout(ui.travel.timer); ui.travel = null; } }
  function travelTo(x, y) {
    stopTravel();
    ui.travel = { kind: "click", x: x, y: y, timer: null };
    travelTick();
  }
  function travelTick() {
    var t = ui.travel;
    if (!t || !state || state.status !== "explore" || !$("modal").hidden) { stopTravel(); return; }
    var step = G.stepTowardTile(state, t.x, t.y);
    if (!step) { stopTravel(); return; }
    var res = doAct({ type: "move", dx: step[0], dy: step[1] });
    if (!res || !res.ok || res.events.some(stopEvent)) { stopTravel(); return; }
    if (!ui.travel) return;
    t.timer = setTimeout(travelTick, 45);
  }
  function stopEvent(e) { return ["discover", "combat", "hurt", "offer", "levelup", "wake", "pickup", "descend"].indexOf(e.type) >= 0; }

  // ---------- End screen ----------
  function renderEnd() {
    show("end");
    var win = state.status === "victory";
    var t = $("end-title"); t.textContent = win ? "VICTORY" : "THE PARTY HAS FALLEN"; t.className = win ? "win" : "lose";
    $("end-sub").textContent = win ? "You climb back toward a morning you had stopped believing in." : "The dark keeps what it takes.";
    var s = $("end-stats"); clear(s);
    [["Seed", (state.daily ? "Daily " : "") + state.seed], ["Floor reached", state.floor.num + " / " + G.LAST_FLOOR], ["Floors cleared", state.stats.floorsCleared],
      ["Enemies slain", state.stats.kills], ["Damage dealt", state.stats.dmgDealt], ["Damage taken", state.stats.dmgTaken],
      ["Items found", state.stats.itemsFound], ["Turns", state.stats.turns],
      ["Party", state.party.map(function (c) { return c.name + " (" + G.CLASSES[c.cls].name + " L" + c.level + ")"; }).join(", ")]]
      .forEach(function (kv) { s.appendChild(el("span", "k", kv[0])); s.appendChild(el("span", "", kv[1])); });
    var m = $("end-menu"); clear(m);
    m.appendChild(menuButton("N", "New Game", function () { startCreate(false); }));
    m.appendChild(menuButton("T", "Return to Title", renderTitle));
    m.querySelector("button").focus();
  }

  // ---------- Help ----------
  function openHelp() {
    var box = $("modal-box"); clear(box);
    box.appendChild(el("h2", "", "Controls"));
    box.appendChild(el("p", "", "WASD / arrows: move. Numpad: 8 directions. Click a known tile to travel. F: attack. 1-5: abilities. Space: rest. >: descend. Esc: cancel/close."));
    var foot = el("div", "modal-foot"); foot.appendChild(button("Close (Esc)", closeModal, "primary")); box.appendChild(foot);
    openModal("help");
    foot.querySelector("button").focus();
  }

  // ---------- Input ----------
  var KEYDIR = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0],
    Numpad8: [0, -1], Numpad2: [0, 1], Numpad4: [-1, 0], Numpad6: [1, 0], Numpad7: [-1, -1], Numpad9: [1, -1], Numpad1: [-1, 1], Numpad3: [1, 1] };
  document.addEventListener("keydown", function (ev) {
    if (ev.target && (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA")) { if (ev.key === "Escape") ev.target.blur(); return; }
    if (!$("modal").hidden) {
      if (ev.key === "Escape") {
        if (ui.modal === "offer") doAct({ type: "take", leave: true });
        else if (ui.modal === "help") closeModal();
        ev.preventDefault();
      } else if (ui.modal === "level" && /^Digit[1-3]$/.test(ev.code)) {
        var q = state.levelQueue[0], o = q && q.options[parseInt(ev.code.slice(5), 10) - 1];
        if (o) doAct({ type: "choose", option: o });
        ev.preventDefault();
      }
      return;
    }
    if (ui.screen === "title" || ui.screen === "end") {
      if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
      var b = document.querySelector("#scr-" + ui.screen + " button[data-key='" + ev.key.toLowerCase() + "']");
      if (b && !b.disabled) { b.click(); ev.preventDefault(); }
      return;
    }
    if (ui.screen !== "game" || !state) return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
    if (ui.tgt) {
      if (ev.key === "Escape") { cancelTarget(); ev.preventDefault(); return; }
      if (ev.key === "Tab") { ui.tgt.i = (ui.tgt.i + (ev.shiftKey ? ui.tgt.list.length - 1 : 1)) % ui.tgt.list.length; renderGame(); ev.preventDefault(); return; }
      if (ev.key === "Enter") { confirmTarget(); ev.preventDefault(); return; }
      if (ev.code === "KeyF" && ui.tgt.mode === "attack") { confirmTarget(); ev.preventDefault(); return; }
    }
    if (KEYDIR[ev.code]) {
      stopTravel(); ui.tgt = null; var d = KEYDIR[ev.code]; doAct({ type: "move", dx: d[0], dy: d[1] }); ev.preventDefault(); return;
    }
    if (ev.code === "Space") { stopTravel(); ui.tgt = null; doAct({ type: "rest" }); ev.preventDefault(); return; }
    if (ev.key === ">" || (ev.code === "Period" && ev.shiftKey)) { doAct({ type: "descend" }); ev.preventDefault(); return; }
    if (ev.code === "KeyF") { startAttack(); ev.preventDefault(); return; }
    if (ev.key === "h" || ev.key === "?") { openHelp(); ev.preventDefault(); return; }
    if (/^Digit[1-9]$/.test(ev.code)) { startAbility(parseInt(ev.code.slice(5), 10) - 1); ev.preventDefault(); return; }
    if (ev.key === "Escape") { stopTravel(); if (ui.selItem) { ui.selItem = null; renderGame(); } }
  });
  $("map").addEventListener("mousemove", function (ev) {
    var t = tileFromEvent(ev); if (!state || !t) { hideTip(); return; }
    showTip(describeTile(t.x, t.y), ev.clientX, ev.clientY);
  });
  $("map").addEventListener("mouseleave", hideTip);
  $("map").addEventListener("click", function (ev) {
    var t = tileFromEvent(ev); if (!state || !t) return;
    if (ui.tgt) {
      var hit = -1;
      ui.tgt.list.forEach(function (v, k) {
        if (ui.tgt.kind === "tile" && v.x === t.x && v.y === t.y) hit = k;
        if (ui.tgt.kind === "enemy") { var e0 = G.enemyById(state, v); if (e0 && e0.x === t.x && e0.y === t.y) hit = k; }
      });
      if (hit >= 0) confirmTarget(ui.tgt.list[hit]); else flashInfo("Not a valid target. Esc cancels.");
      return;
    }
    var e = G.enemyAt(state, t.x, t.y);
    if (e && !e.hidden && G.canSee(state, t.x, t.y)) { var who = selectedChar(); doAct({ type: "attack", target: e.id, actor: who.id }); return; }
    var dx = t.x - state.pos.x, dy = t.y - state.pos.y;
    if (state.status === "combat") {
      if (Math.max(Math.abs(dx), Math.abs(dy)) === 1) doAct({ type: "move", dx: dx, dy: dy });
      else flashInfo("In combat the party moves one tile per party phase (click an adjacent tile).");
      return;
    }
    travelTo(t.x, t.y);
  });
  $("btn-help").addEventListener("click", openHelp);
  $("btn-menu").addEventListener("click", function () { stopTravel(); renderTitle(); });
  $("btn-create-go").addEventListener("click", beginRun);
  $("btn-create-back").addEventListener("click", renderTitle);
  $("btn-add-member").addEventListener("click", function () {
    if (ui.party.length < 3) ui.party.push(newMember(ui.party.length, CLASS_ORDER[ui.party.length % 4]));
    renderCreate();
  });
  window.addEventListener("resize", function () { if (ui.screen === "game") { fitCanvas(); drawMap(); } });

  renderTitle();
})();
