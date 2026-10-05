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
    if (screen !== ui.screen && !$("modal").hidden) closeModal();
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

  // ---------- Saving (localStorage is optional; Export Run is the portable backup) ----------
  var SAVE_KEY = "gloamBelow.autosave.v" + G.SAVE_VERSION;
  var store = { ok: null, warned: false };
  function storageWorks() {
    if (store.ok !== null) return store.ok;
    try { var k = "gloamBelow.__probe"; window.localStorage.setItem(k, "1"); window.localStorage.removeItem(k); store.ok = true; }
    catch (e) { store.ok = false; }
    return store.ok;
  }
  function autosave() {
    if (!state) return;
    try {
      if (state.status === "victory" || state.status === "defeat") window.localStorage.removeItem(SAVE_KEY);
      else window.localStorage.setItem(SAVE_KEY, G.exportRun(state, true));
      store.ok = true;
    } catch (e) {
      store.ok = false;
      if (!store.warned) { store.warned = true; banner("Autosave is unavailable in this browser for files opened from disk. Use Export to keep a backup.", false); }
    }
  }
  function readAutosave() { try { return window.localStorage.getItem(SAVE_KEY); } catch (e) { return null; } }
  function storageNotice() {
    return storageWorks() ? "Your run autosaves in this browser after every action. Export Run makes a portable backup file."
      : "Local saving is unavailable here (some browsers block it for files opened from disk). The game still works: use Export Run in-game as your reliable backup.";
  }

  function exportRun() {
    if (!state) return;
    try {
      var txt = G.exportRun(state);
      var blob = new Blob([txt], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "gloam-below-" + String(state.seed).replace(/[^A-Za-z0-9-]/g, "_") + "-floor" + state.floor.num + "-turn" + state.turn + ".json";
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.parentNode.removeChild(a); }, 1500);
      banner("Run exported as " + a.download + ".", true);
    } catch (e) { banner("Export failed: " + (e && e.message), false); }
  }
  function startImport() { var f = $("file-import"); f.value = ""; f.click(); }
  function importFile(file) {
    if (!file) return;
    if (file.size > G.MAX_IMPORT_BYTES) { importError("That file is larger than 2 MiB, so it cannot be a run file. Nothing was changed."); return; }
    var rd = new FileReader();
    rd.onload = function () {
      var res = G.importRun(String(rd.result));
      if (!res.ok) { importError(res.error); return; }
      stopTravel();
      state = res.state;
      autosave();
      if (state.status === "victory" || state.status === "defeat") { renderEnd(); return; }
      enterGame(false);
      banner("Run imported: seed " + state.seed + ", floor " + state.floor.num + ".", true);
    };
    rd.onerror = function () { importError("The file could not be read. Nothing was changed."); };
    rd.readAsText(file);
  }
  function importError(msg) {
    if (ui.screen === "title" || ui.screen === "end") $(ui.screen === "end" ? "end-sub" : "title-notice").textContent = msg;
    else banner(msg, false);
  }
  function continueRun() {
    if (state && (state.status === "explore" || state.status === "combat")) { enterGame(false); return; }
    var txt = readAutosave();
    if (!txt) { $("title-notice").textContent = "No saved run found in this browser. Use Import Run to load an exported file."; return; }
    var res = G.importRun(txt);
    if (!res.ok) { $("title-notice").textContent = "The autosave could not be loaded (" + res.error + ") Use Import Run with an exported file."; return; }
    state = res.state;
    enterGame(false);
  }

  // ---------- Title ----------
  function renderTitle() {
    show("title");
    stopTravel();
    var m = $("title-menu"); clear(m);
    var canContinue = (state && (state.status === "explore" || state.status === "combat")) || !!readAutosave();
    m.appendChild(menuButton("N", "New Game", function () { startCreate(false); }));
    m.appendChild(menuButton("D", "Daily Dungeon (" + G.dailySeed() + " UTC)", function () { startCreate(true); }));
    m.appendChild(menuButton("C", "Continue", continueRun, !canContinue));
    m.appendChild(menuButton("I", "Import Run", startImport));
    m.appendChild(menuButton("H", "Controls / Help", openHelp));
    $("title-notice").textContent = storageNotice();
    var first = m.querySelector("button:not([disabled])"); if (first) first.focus();
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
    ui.seedMode = daily ? "daily" : "random";
    ui.seed = daily ? G.dailySeed() : randomSeed();
    ui.seedText = "";
    ui.party = [newMember(0, "sentinel")];
    renderCreate();
  }
  function newMember(i, cls) { return { cls: cls, name: G.suggestName(ui.seed, i, 0), roll: 0, edited: false }; }
  // Suggested names come from the seed, so a seed change refreshes names the player has not edited.
  function setSeed(seed) {
    ui.seed = seed;
    ui.party.forEach(function (p, i) { if (!p.edited) p.name = G.suggestName(ui.seed, i, p.roll); });
  }
  function renderCreate() {
    show("create");
    $("create-title").textContent = ui.daily ? "Daily Dungeon - " + ui.seed + " (UTC)" : "Assemble the Party";
    var seedBox = $("create-seed"); clear(seedBox);
    if (ui.daily) {
      seedBox.appendChild(el("span", "", "Everyone gets the same floors, objectives, foes, loot placement, hazards and shrines today. Seed: "));
      seedBox.appendChild(el("b", "", ui.seed));
    } else {
      var rnd = button("Random seed", function () { ui.seedMode = "random"; setSeed(randomSeed()); renderCreate(); }, ui.seedMode === "random" ? "sel on" : "", "Roll a fresh random seed");
      var own = button("Enter a seed", function () { ui.seedMode = "custom"; renderCreate(); var i = $("seed-input"); if (i) i.focus(); }, ui.seedMode === "custom" ? "sel on" : "", "Type any seed to replay or share a dungeon");
      rnd.setAttribute("aria-pressed", ui.seedMode === "random"); own.setAttribute("aria-pressed", ui.seedMode === "custom");
      seedBox.appendChild(rnd); seedBox.appendChild(own);
      if (ui.seedMode === "custom") {
        var inp = el("input"); inp.type = "text"; inp.id = "seed-input"; inp.maxLength = 32; inp.value = ui.seedText; inp.placeholder = "any text, e.g. MOTHWING";
        inp.setAttribute("aria-label", "Seed");
        inp.addEventListener("input", function () {
          ui.seedText = inp.value;
          var c = G.cleanSeed(inp.value);
          if (c.ok) { setSeed(c.seed); refreshNames(); }
          $("create-hint").textContent = c.ok ? "Seed: " + c.seed : c.msg;
        });
        seedBox.appendChild(inp);
      } else {
        seedBox.appendChild(el("span", "", "Seed: "));
        seedBox.appendChild(el("b", "", ui.seed));
      }
    }
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
      var inp = el("input"); inp.type = "text"; inp.maxLength = 18; inp.value = p.name; inp.className = "name-input";
      inp.setAttribute("aria-label", "Name for member " + (i + 1));
      inp.addEventListener("input", function () { p.name = inp.value; p.edited = true; });
      row.appendChild(inp);
      row.appendChild(button("Reroll", function () { p.roll += 1; p.edited = false; p.name = G.suggestName(ui.seed, i, p.roll); renderCreate(); }, "", "Suggest another name"));
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
    $("btn-add-member").hidden = ui.party.length >= 3;
    $("create-hint").textContent = ui.party.length === 1 ? "A lone delver gets +50% max HP and +1 charge on every limited ability (never extra XP). Creation order sets formation." :
      "Creation order sets formation: member 1 starts in the front rank. Any mix of classes works; duplicates are fine.";
  }
  function refreshNames() {
    var inputs = document.querySelectorAll("#create-members .name-input");
    ui.party.forEach(function (p, i) { if (inputs[i] && !p.edited) inputs[i].value = p.name; });
  }
  function beginRun() {
    if (!ui.daily && ui.seedMode === "custom") {
      var c = G.cleanSeed(ui.seedText);
      if (!c.ok) { $("create-hint").textContent = c.msg; return; }
      ui.seed = c.seed;
    }
    var party = ui.party.map(function (p) { return { cls: p.cls, name: cleanName(p.name) }; });
    try { state = G.newRun({ seed: ui.seed, daily: ui.daily, party: party }); }
    catch (e) { $("create-hint").textContent = "That seed could not start a run (" + (e && e.message) + "). Try another."; return; }
    autosave();
    enterGame(true);
  }
  function cleanName(n) {
    n = String(n || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 18);
    return n || "Nameless";
  }
  function enterGame(briefing) {
    ui.sel = 0; ui.tgt = null; ui.selItem = null;
    show("game");
    fitCanvas();
    renderGame();
    if (briefing) showBriefing();
  }
  function showBriefing() {
    var box = $("modal-box"), st = state.story; clear(box);
    box.appendChild(el("h2", "", st.dungeon));
    box.appendChild(el("p", "", st.premise));
    box.appendChild(el("p", "fine", "Seven floors. Each floor has one objective shown at the top; the stairs stay sealed until it is done. The last floor holds " + st.boss + ", " + st.title + "."));
    box.appendChild(el("p", "fine", "Press E to auto-explore, G to travel to the objective, H for help."));
    var foot = el("div", "modal-foot"); foot.appendChild(button("Descend (Enter)", closeModal, "primary")); box.appendChild(foot);
    openModal("help");
    foot.querySelector("button").focus();
  }

  // ---------- Game rendering ----------
  function renderGame() {
    if (!state) return;
    if (state.status === "victory" || state.status === "defeat") { stopTravel(); renderEnd(); return; }
    if (ui.sel >= state.party.length) ui.sel = 0;
    renderHud(); renderParty(); renderActions(); renderGear(); renderLog(); renderInfo(); drawMap(); renderModals();
  }
  function renderHud() {
    $("hud-floor").textContent = "Floor " + state.floor.num + "/" + G.LAST_FLOOR + ": " + G.floorTitle(state, state.floor.num);
    var o = $("hud-objective"), ob = state.floor.objective, done = ob.done && ob.type !== "stairs";
    o.textContent = (done ? "Done: " : "Objective: ") + G.objectiveText(state);
    o.className = "hud-obj" + (done ? " done" : "");
    o.dataset.tip = G.objectiveText(state) + "\nThis floor's objective. The stairs stay sealed until it is complete. G travels toward it once found.";
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
      var tIdx = ui.tgt && (ui.tgt.kind === "ally" || ui.tgt.kind === "downed") ? ui.tgt.list.indexOf(c.id) : -1;
      if (tIdx >= 0) card.style.outline = tIdx === ui.tgt.i ? "3px solid #ffffff" : "2px dashed #4ac0e0";
      var g = el("div", "pglyph", C.glyph); g.style.borderColor = C.color; g.style.color = C.color;
      card.appendChild(g);
      var nm = el("div", "pname");
      if (tIdx >= 0 && tIdx === ui.tgt.i) nm.appendChild(el("b", "", "> TARGET "));
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
      G.statusText(c.st).forEach(function (t) { var tg = el("span", "tag", t); tg.dataset.tip = statusTip(t); info.appendChild(tg); });
      if (!inCombat && state.party.length > 1) {
        var ro = el("span", "reorder");
        var up = button("▲", function (ev) { ev.stopPropagation(); reorder(i, i - 1, "up"); }, "", "Move up in formation");
        var dn = button("▼", function (ev) { ev.stopPropagation(); reorder(i, i + 1, "dn"); }, "", "Move down in formation");
        up.dataset.ro = "up" + i; dn.dataset.ro = "dn" + i;
        up.disabled = i === 0; dn.disabled = i === state.party.length - 1;
        up.setAttribute("aria-label", "Move " + c.name + " up"); dn.setAttribute("aria-label", "Move " + c.name + " down");
        ro.appendChild(up); ro.appendChild(dn); info.appendChild(ro);
      }
      card.appendChild(info);
      card.addEventListener("click", function () { partyClick(i); });
      card.addEventListener("keydown", function (ev) { if (ev.target === card && ev.key === "Enter") { partyClick(i); ev.preventDefault(); } });
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
  var STATUS_TIPS = { Stunned: "Loses its next turn(s).", Rooted: "Cannot move, can still attack.", Blinded: "-40 accuracy.", Hexed: "Takes +50% damage, deals 30% less.",
    Shrouded: "+2 armour from a Murk Acolyte.", Burning: "Takes damage at the start of each of its turns.", Taunted: "Must attack the taunting Sentinel.",
    Guarding: "+3 armour; intercepts single-target attacks on the back rank until the next party phase.", Braced: "+2 armour.", Ward: "Absorbs incoming damage.", Fading: "+25 evasion until the next party phase." };
  function statusTip(t) { var k = t.split(/[ \/]/)[0]; return STATUS_TIPS[k] || t; }
  function reorder(from, to, dir) {
    doAct({ type: "reorder", from: from, to: to });
    ui.sel = to; renderGame();
    var b = document.querySelector("#party [data-ro='" + dir + to + "']") || document.querySelectorAll("#party .pcard")[to];
    if (b && !b.disabled) b.focus(); else { var cd = document.querySelectorAll("#party .pcard")[to]; if (cd) cd.focus(); }
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
    if (!inCombat) {
      var ex = button(ui.travel && ui.travel.kind === "explore" ? "Exploring... (E)" : "Explore (E)", function () { startTravel({ kind: "explore" }); }, ui.travel && ui.travel.kind === "explore" ? "on" : "",
        "Auto-Explore: walk toward the nearest unexplored ground one tile at a time. Stops when anything new appears. Avoids known hazards and sleeping foes' wake radius.");
      var tr = button(ui.travel && ui.travel.kind === "travel" ? "Travelling... (G)" : "Travel (G)", function () { startTravel({ kind: "travel" }); }, ui.travel && ui.travel.kind === "travel" ? "on" : "",
        "Travel to the objective (or the open stairs) through known safe tiles only. Stops when anything new appears.");
      util.appendChild(ex); util.appendChild(tr);
    }
    util.appendChild(button("Rest (Space)", function () { stopTravel(); doAct({ type: "rest" }); }, "", inCombat ? "Skip this character's action." : "Wait one turn. Waiting never heals or restores charges."));
    var d = button("Descend (>)", function () { doAct({ type: "descend" }); }, G.canDescend(state) ? "primary" : "", "Descend when standing on open stairs. On descending: downed allies revive at 25% HP, others heal 25%, and abilities recover half their missing charges.");
    d.disabled = !G.canDescend(state);
    util.appendChild(d);
    var here = G.droppedHere(state);
    if (here.length) util.appendChild(button("Pick Up (P)", function () { doAct({ type: "pickup" }); }, "",
      "Take back " + G.itemName(here[here.length - 1].item) + (here.length > 1 ? " (" + (here.length - 1) + " more dropped here)" : "") + ". Picking up costs no turn."));
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
      dropButtons(row, it);
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
      dropButtons(row, it);
    }
    box.appendChild(row);
  }
  var DROP_TIP = "Leave it on the floor here. It stays on this tile (on this floor) and is never picked up automatically: stand here and press P to take it back.";
  var DISCARD_TIP = "Destroy it permanently.";
  function dropButtons(row, it) {
    row.appendChild(button("Drop", function () { doAct({ type: "drop", item: it.id }); ui.selItem = null; renderGame(); }, "", DROP_TIP));
    row.appendChild(button("Discard", function () { doAct({ type: "discard", item: it.id }); ui.selItem = null; renderGame(); }, "", DISCARD_TIP));
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
  function openModal(kind) { ui.modal = kind; $("modal").hidden = false; if (kind !== "help" || !$("modal-box").querySelector(".cols3")) $("modal-box").className = "modal-box"; }
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
    var mode = ui.offerMode === "discard" ? "discard" : "drop";
    box.appendChild(el("h3", "", "Make room to take it: choose an item to " + (mode === "drop" ? "drop here" : "discard") + "."));
    var modes = el("div", "utilrow");
    modes.appendChild(button("Drop it here", function () { ui.offerMode = "drop"; showOffer(); }, mode === "drop" ? "on" : "", DROP_TIP));
    modes.appendChild(button("Discard it", function () { ui.offerMode = "discard"; showOffer(); }, mode === "discard" ? "on" : "", DISCARD_TIP));
    box.appendChild(modes);
    var list = el("div", "slots");
    state.inventory.forEach(function (it) {
      var s = itemSlot(it, null, function () { doAct({ type: mode, item: it.id }); });
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
  function shade(hex, k) {
    var n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
    return "rgb(" + Math.round(r * k) + "," + Math.round(gg * k) + "," + Math.round(b * k) + ")";
  }
  function drawMap() {
    var cv = $("map"), g = cv.getContext("2d"), f = state.floor, T = G.THEMES[f.theme];
    var wallC = T.wall, wallD = shade(T.wall, 0.7), floorC = T.floor, dotC = shade(T.wall, 0.8);
    g.fillStyle = "#050407"; g.fillRect(0, 0, cv.width, cv.height);
    for (var y = 0; y < f.h; y++) for (var x = 0; x < f.w; x++) {
      if (!G.isSeen(f, x, y)) continue;
      var vis = G.canSee(state, x, y), px = x * TS, py = y * TS, t = G.tileAt(f, x, y);
      if (t === "#") {
        g.fillStyle = wallC; g.fillRect(px, py, TS, TS);
        g.fillStyle = wallD; g.fillRect(px, py + 11, TS, 2); g.fillRect(px + 11, py, 2, 11); g.fillRect(px + 4, py + 13, 2, 11);
      } else {
        var pol = G.polarAt(f, x, y);
        g.fillStyle = pol === "L" ? "#2e2616" : pol === "D" ? "#0b0910" : floorC; g.fillRect(px, py, TS, TS);
        if (pol === "L") { g.fillStyle = "#7a6230"; g.fillRect(px + 5, py + 5, 2, 2); g.fillRect(px + 16, py + 15, 2, 2); g.fillRect(px + 16, py + 4, 2, 2); }
        else if (pol === "D") { g.strokeStyle = "#251f38"; g.lineWidth = 1; g.beginPath(); g.moveTo(px, py + TS); g.lineTo(px + TS, py); g.moveTo(px, py + 12); g.lineTo(px + 12, py); g.moveTo(px + 12, py + TS); g.lineTo(px + TS, py + 12); g.stroke(); }
        else { g.fillStyle = dotC; g.fillRect(px + 11, py + 11, 2, 2); }
        if (t === "b" || t === "B") drawGlyph(g, x, y, t === "B" ? "☀" : "b", t === "B" ? "#ffd36b" : "#8a7a60", t === "B" ? "#ffb040" : "#6a5a40", "box");
      }
      if (!vis) { g.fillStyle = "rgba(5,4,7,0.62)"; g.fillRect(px, py, TS, TS); }
    }
    // Remembered static features are drawn dimmed out of sight; creatures only when visible.
    f.features.forEach(function (ft) {
      if (!G.isSeen(f, ft.x, ft.y)) return;
      var vis = G.canSee(state, ft.x, ft.y);
      if (ft.kind === "caltrops") drawGlyph(g, ft.x, ft.y, "%", "#b0e0a0", "#4a8a4a", "diamond");
      else if (ft.kind === "hazard") drawHazard(g, ft);
      else if (ft.kind === "shrine") drawGlyph(g, ft.x, ft.y, "†", ft.used ? "#6a6470" : "#ffe9a0", ft.used ? "#4a4452" : "#e0c060", "diamond", ft.used);
      else if (ft.kind === "relic") drawGlyph(g, ft.x, ft.y, "♦", "#ffe27a", "#ffb040", "star");
      if (!vis) { g.fillStyle = "rgba(5,4,7,0.55)"; g.fillRect(ft.x * TS, ft.y * TS, TS, TS); }
    });
    if (f.stairs && G.isSeen(f, f.stairs.x, f.stairs.y)) {
      drawGlyph(g, f.stairs.x, f.stairs.y, ">", f.objective.done ? "#9fe0ff" : "#6a7a80", f.objective.done ? "#9fe0ff" : "#5a6a70", "box", !f.objective.done);
      if (!G.canSee(state, f.stairs.x, f.stairs.y)) { g.fillStyle = "rgba(5,4,7,0.5)"; g.fillRect(f.stairs.x * TS, f.stairs.y * TS, TS, TS); }
    }
    f.items.forEach(function (gi) {
      if (!G.canSee(state, gi.x, gi.y)) return;
      var I = G.ITEMS[gi.item.base];
      drawGlyph(g, gi.x, gi.y, SLOT_GLYPH[I.slot], RAR_COLOR[gi.item.rarity], RAR_COLOR[gi.item.rarity], gi.item.rarity === "unique" ? "star" : gi.item.rarity === "rare" ? "double" : "box");
      if (gi.item.rarity === "magic") badge(g, gi.x, gi.y, "+", RAR_COLOR.magic);
    });
    // Telegraphs first, so creatures draw on top.
    f.enemies.forEach(function (e) {
      if (e.hidden || !G.canSee(state, e.x, e.y)) return;
      if (e.charge) G.chargeLine(state, e).forEach(function (p) { danger(g, p[0], p[1], "→"); });
      if (e.nova) for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) danger(g, e.nova.x + dx, e.nova.y + dy, "!");
      if (e.swell || e.sweep) for (var ax = -1; ax <= 1; ax++) for (var ay = -1; ay <= 1; ay++) if (ax || ay) danger(g, e.x + ax, e.y + ay, "");
      if (e.type === "husk" && e.ward) {
        var w = G.enemyById(state, e.ward);
        if (w && G.canSee(state, w.x, w.y)) { g.strokeStyle = "#9fd0ff"; g.lineWidth = 2; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(e.x * TS + TS / 2, e.y * TS + TS / 2); g.lineTo(w.x * TS + TS / 2, w.y * TS + TS / 2); g.stroke(); g.setLineDash([]); }
      }
    });
    f.enemies.forEach(function (e) {
      if (e.hidden || !G.canSee(state, e.x, e.y)) return;
      var D = G.ENEMIES[e.type];
      var shape = e.type === "gate" ? "spike" : (e.type === "warden" || e.type === "boss") ? "double" : "round";
      drawGlyph(g, e.x, e.y, D.glyph, e.type === "boss" ? "#ffd0ff" : "#ffb4a8", e.type === "boss" ? "#c050ff" : e.type === "gate" ? "#ff7040" : "#d0503a", shape);
      var hw = Math.max(2, Math.round((TS - 4) * Math.max(0, e.hp) / e.maxHp));
      g.fillStyle = "#000"; g.fillRect(e.x * TS + 2, e.y * TS + TS - 4, TS - 4, 3);
      g.fillStyle = "#e04a3a"; g.fillRect(e.x * TS + 2, e.y * TS + TS - 4, hw, 3);
      if (!e.awake) badge(g, e.x, e.y, "z", "#9fd0ff");
      else if (e.charge || e.swell || e.sweep || e.nova) badge(g, e.x, e.y, "!", "#ff5040");
      else if (e.st.stun > 0) badge(g, e.x, e.y, "*", "#ffe27a");
      else if (e.st.root > 0) badge(g, e.x, e.y, "#", "#b0e0a0");
      else if (e.st.hex) badge(g, e.x, e.y, "h", "#ffb0d8");
      if (e.st.shroud) { g.strokeStyle = "#9fd0ff"; g.lineWidth = 1; g.strokeRect(e.x * TS + 1, e.y * TS + 1, TS - 2, TS - 2); }
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
    else if (shape === "spike") { for (var k = 0; k < 16; k++) { var an = k * Math.PI / 8, rr = k % 2 ? 7 : 11; g.lineTo(px + c + Math.cos(an) * rr, py + c + Math.sin(an) * rr); } g.closePath(); }
    else g.rect(px + 3, py + 3, TS - 6, TS - 6);
    g.stroke();
    g.fillStyle = color; g.font = "bold 15px Consolas, monospace"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(ch, px + c, py + c + 1);
    if (locked) { g.strokeStyle = "#c06050"; g.lineWidth = 2; g.beginPath(); g.moveTo(px + 4, py + 4); g.lineTo(px + TS - 4, py + TS - 4); g.stroke(); }
  }
  // Hazards: zigzag pattern plus glyph, so they never rely on colour alone.
  function drawHazard(g, ft) {
    var H = G.HAZARDS[ft.sub], px = ft.x * TS, py = ft.y * TS;
    g.strokeStyle = "#e06040"; g.lineWidth = 2; g.beginPath();
    for (var k = 0; k <= 4; k++) g.lineTo(px + 2 + k * 5, py + (k % 2 ? 7 : 3));
    g.moveTo(px + 2, py + TS - 3);
    for (var j = 0; j <= 4; j++) g.lineTo(px + 2 + j * 5, py + TS - (j % 2 ? 7 : 3));
    g.stroke();
    g.fillStyle = "#ff9070"; g.font = "bold 14px Consolas, monospace"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(H.glyph, px + TS / 2, py + TS / 2 + 1);
  }
  // Telegraphed danger: red diagonal stripes with a marker.
  function danger(g, x, y, mark) {
    if (x < 0 || y < 0 || x >= G.MAP_W || y >= G.MAP_H) return;
    var px = x * TS, py = y * TS;
    g.save(); g.beginPath(); g.rect(px, py, TS, TS); g.clip();
    g.fillStyle = "rgba(200,40,30,0.28)"; g.fillRect(px, py, TS, TS);
    g.strokeStyle = "rgba(255,80,60,0.75)"; g.lineWidth = 2;
    for (var k = -TS; k < TS; k += 7) { g.beginPath(); g.moveTo(px + k, py + TS); g.lineTo(px + k + TS, py); g.stroke(); }
    g.restore();
    if (mark) { g.fillStyle = "#ffd0c0"; g.font = "bold 12px Consolas, monospace"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(mark, px + TS / 2, py + TS / 2); }
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
      out.push(G.enemyName(e) + "  HP " + e.hp + "/" + e.maxHp + (e.awake ? "" : "  [ASLEEP - z]"));
      out.push(D.desc);
      out.push("Intent: " + G.intentOf(state, e));
      var sts = G.statusText(e.st); if (sts.length) out.push("Status: " + sts.join(", "));
      out.push("XP: " + e.xp + " to each conscious party member.");
    }
    if (x === state.pos.x && y === state.pos.y) out.push("Your party: " + state.party.map(function (c, i) { return (i + 1) + "." + c.name; }).join(" ") + "\nThe whole party shares one tile; portrait order is the formation.");
    if (f.stairs && x === f.stairs.x && y === f.stairs.y) out.push("Stairs down (>)" + (f.objective.done ? " - open." : " - sealed: " + G.objectiveText(state)));
    f.items.forEach(function (gi) { if (gi.x === x && gi.y === y && vis) out.push(G.itemName(gi.item) + " [" + G.RARITY[gi.item.rarity].name + "] - " + (gi.dropped ? "dropped by you: stand here and press P to pick it up." : "walk over it to pick it up.")); });
    var ft = G.featureAt(state, x, y);
    if (ft && ft.kind === "caltrops") out.push("Your caltrops: the first foe to step here is hurt and rooted.");
    if (ft && ft.kind === "hazard") out.push(G.HAZARDS[ft.sub].name + " (" + G.HAZARDS[ft.sub].glyph + ", zigzag): " + G.HAZARDS[ft.sub].desc + " Damage: " + ft.dmg + " each. Travel commands avoid it.");
    if (ft && ft.kind === "shrine") out.push(G.SHRINES[ft.sub].name + (ft.used ? " (spent)" : "") + ": " + G.SHRINES[ft.sub].desc + " Step onto it outside combat.");
    if (ft && ft.kind === "relic") out.push(f.objective.name + " (♦): the floor objective. Walk over it to take it, then carry it to the stairs.");
    var tt = G.tileAt(f, x, y);
    if (tt === "b") out.push("Cold brazier (b). Walk into it to light it (uses the shared Move in combat). Its light spreads 3 tiles; the Unlit takes +50% damage on lit ground.");
    if (tt === "B") out.push("Burning brazier. The ground around it is lit.");
    if (e && !e.hidden && vis && e.type === "husk" && e.ward) { var w = G.enemyById(state, e.ward); if (w) out.push("Guarding: " + G.enemyName(w) + " (dashed line)."); }
    if (e && !e.hidden && vis && G.interceptor(state, e)) out.push("Protected: a Shield-Husk will intercept single-target attacks aimed at it.");
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
    soundFor(res.events);
    res.events.forEach(function (ev) {
      if (ev.type === "hit" && ev.data) ui.flashes.push({ x: ev.data.x, y: ev.data.y, c: "#ff4030", t: Date.now() });
      if (ev.type === "hurt") ui.flashes.push({ x: state.pos.x, y: state.pos.y, c: "#ff2020", t: Date.now() });
      if (ev.type === "heal") ui.flashes.push({ x: state.pos.x, y: state.pos.y, c: "#40ff80", t: Date.now() });
      if (ev.type === "combat") banner("Combat! Party phase: act in portrait order.", false);
      if (ev.type === "combatEnd") banner("Combat over.", true);
      if (ev.type === "descend") banner("Floor " + state.floor.num + ": " + G.objectiveText(state), true);
    });
    if (state.status !== "combat" && ui.tgt && ui.tgt.combatOnly) ui.tgt = null;
    if (res.ok) { ui.tgt = null; autosave(); }
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

  // Click-to-travel, Auto-Explore (E) and Travel to Objective (G): one tile per tick, one world
  // turn per tile, and any new information stops the walk immediately.
  function stopTravel() { if (ui.travel) { clearTimeout(ui.travel.timer); ui.travel = null; renderActionsSafe(); } }
  function renderActionsSafe() { if (state && ui.screen === "game") renderActions(); }
  function travelTo(x, y) { startTravel({ kind: "click", x: x, y: y }); }
  function startTravel(t) {
    if (ui.travel) { var same = ui.travel.kind === t.kind && t.kind !== "click"; stopTravel(); if (same) return; }
    if (!state || state.status !== "explore") { flashInfo(state && state.status === "combat" ? "Not during combat." : "Not now."); return; }
    t.timer = null; t.steps = 0;
    ui.travel = t;
    travelTick();
  }
  function travelTick() {
    var t = ui.travel;
    if (!t || !state || state.status !== "explore" || !$("modal").hidden) { stopTravel(); return; }
    var dir;
    if (t.kind === "click") dir = G.stepTowardTile(state, t.x, t.y);
    else {
      var plan = G.planStep(state, t.kind);
      if (!plan.dir) { stopTravel(); flashInfo(plan.why); return; }
      dir = plan.dir;
    }
    if (!dir) { stopTravel(); return; }
    var res = doAct({ type: "move", dx: dir[0], dy: dir[1] });
    t.steps++;
    if (!res || !res.ok || res.events.some(stopEvent)) { stopTravel(); return; }
    if (!ui.travel) return;
    t.timer = setTimeout(travelTick, 40);
  }
  function stopEvent(e) { return ["discover", "combat", "hurt", "offer", "levelup", "wake", "pickup", "descend", "telegraph", "objective", "shrine", "down", "victory", "defeat"].indexOf(e.type) >= 0; }

  // ---------- Sound: tiny generated blips, muted by default ----------
  var audio = { on: false, ctx: null };
  function toggleSound() {
    audio.on = !audio.on;
    if (audio.on && !audio.ctx) {
      try { var AC = window.AudioContext || window.webkitAudioContext; audio.ctx = AC ? new AC() : null; } catch (e) { audio.ctx = null; }
    }
    var b = $("btn-sound"); b.textContent = "Sound: " + (audio.on ? "on" : "off"); b.className = audio.on ? "on" : "";
    b.setAttribute("aria-pressed", audio.on ? "true" : "false");
    if (audio.on) blip(660, 0.06, "square");
  }
  function blip(freq, dur, type, slide) {
    if (!audio.on || !audio.ctx) return;
    try {
      var c = audio.ctx, o = c.createOscillator(), g = c.createGain(), t0 = c.currentTime;
      o.type = type || "square"; o.frequency.setValueAtTime(freq, t0);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
      g.gain.setValueAtTime(0.05, t0); g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      o.connect(g); g.connect(c.destination); o.start(t0); o.stop(t0 + dur + 0.02);
    } catch (e) { /* sound is optional */ }
  }
  function soundFor(events) {
    var seen = {};
    events.forEach(function (e) { seen[e.type] = 1; });
    if (seen.victory) { blip(523, 0.12, "triangle"); setTimeout(function () { blip(784, 0.25, "triangle"); }, 120); return; }
    if (seen.defeat || seen.down) { blip(220, 0.35, "sawtooth", 80); return; }
    if (seen.combat) blip(180, 0.12, "square", 120);
    else if (seen.kill) blip(320, 0.09, "square", 160);
    else if (seen.hurt) blip(140, 0.08, "sawtooth");
    else if (seen.hit) blip(420, 0.04, "square");
    else if (seen.levelup) blip(880, 0.15, "triangle", 1320);
    else if (seen.pickup || seen.heal) blip(760, 0.05, "triangle");
    else if (seen.telegraph) blip(300, 0.15, "square", 600);
  }

  // ---------- End screen ----------
  function renderEnd() {
    show("end");
    var win = state.status === "victory";
    var t = $("end-title"); t.textContent = win ? "VICTORY" : "THE PARTY HAS FALLEN"; t.className = win ? "win" : "lose";
    $("end-sub").textContent = win ? state.story.boss + " is ended. You climb out of " + state.story.dungeon + " toward a morning you had stopped believing in." : "The dark of " + state.story.dungeon + " keeps what it takes. " + state.story.boss + " endures.";
    var s = $("end-stats"); clear(s);
    [["Run", (state.daily ? "Daily Dungeon " : "Seed ") + state.seed], ["Dungeon", state.story.dungeon], ["Floor reached", state.floor.num + " / " + G.LAST_FLOOR + " (" + G.floorTitle(state, state.floor.num) + ")"],
      ["Objectives cleared", state.stats.floorsCleared], ["Enemies slain", state.stats.kills], ["Damage dealt", state.stats.dmgDealt], ["Damage taken", state.stats.dmgTaken],
      ["Items found", state.stats.itemsFound], ["Turns", state.stats.turns],
      ["Party", state.party.map(function (c) { return c.name + " (" + G.CLASSES[c.cls].name + " L" + c.level + (c.down ? ", fallen" : "") + ")"; }).join(", ")]]
      .forEach(function (kv) { s.appendChild(el("span", "k", kv[0])); s.appendChild(el("span", "", kv[1])); });
    var m = $("end-menu"); clear(m);
    m.appendChild(menuButton("N", "New Game", function () { startCreate(false); }));
    m.appendChild(menuButton("D", "Daily Dungeon (" + G.dailySeed() + " UTC)", function () { startCreate(true); }));
    m.appendChild(menuButton("I", "Import Run", startImport));
    m.appendChild(menuButton("T", "Return to Title", function () { state = null; renderTitle(); }));
    m.querySelector("button").focus();
  }

  // ---------- Help ----------
  var HELP = [
    ["Controls", [
      "Move: WASD or arrow keys; numpad for diagonals. Click a known tile to walk there one step at a time.",
      "E: Auto-Explore. G: Travel to the objective or the open stairs. Both stop the moment anything new comes into view. Any key or Esc stops them.",
      "F: basic attack (click a foe or Tab/Enter to choose). 1-6: abilities of the acting character. Space: rest / skip. >: descend. P: pick up an item you dropped here.",
      "Esc: cancel targeting or close a panel. H or ?: this help. Click a portrait to select who uses abilities and items outside combat."]],
    ["Formation", [
      "Portrait order is formation. Slot 1 is the FRONT rank (a lone hero is always front); slots 2-3 are the BACK rank.",
      "Only the front rank makes ordinary melee attacks. Back-rank characters need a reach weapon (range 2), a ranged weapon or focus, a spell or an ability.",
      "Enemy melee hits the front first; the back rank is reached only by ranged attacks, area effects and special attacks. If the front falls, the next conscious member steps up.",
      "Reorder portraits (drag, or the arrows) outside combat only."]],
    ["Combat", [
      "Combat starts when an awake foe comes into view. Each round: the party phase (every conscious member acts once, in portrait order), then the enemy phase (foes act nearest first).",
      "The shared Move moves the whole party one tile, uses the acting character's turn, and is allowed once per party phase. Later characters act from the new tile.",
      "Hover a foe to read its intent. Red striped tiles are telegraphed danger (charges, novas, bursts, sweeps): step out of them.",
      "Breaking line of sight does not freeze foes: the round ends and they close in. Combat ends when no awake foe is visible."]],
    ["Health and charges", [
      "After a fight each conscious member recovers 10% of max HP (at least 1), but this never raises anyone above half health (the tick on the HP bar).",
      "Walking, waiting and resting never heal and never restore charges. Healing spells, draughts, shrines and descending can go above half.",
      "Descending: the downed revive at 25% HP, everyone else heals 25%, and each ability regains half of its missing charges (rounded up).",
      "There is no revival in combat. If everyone falls, the run ends."]],
    ["Foes, light and objectives", [
      "Sleeping foes (z) take no turns. They wake if you come within their wake radius, attack or damage them, or make noise within 6 tiles (Challenge, Lumen Flare, bombs).",
      "Lit ground (dotted) weakens shadow-kin and the final foe; deep shadow (hatched) hides Lurkers and speeds Shades. Light spells and braziers make ground Lit.",
      "Each floor's objective is shown at the top: reach the stairs, destroy the Spawning Gate, defeat the warden, or carry a relic to the stairs. The stairs stay sealed until it is done.",
      "Spawning Gates birth grubs worth no XP. Kill the gate."]],
    ["Items and saving", [
      "One shared 16-slot inventory; equipped items take no slot. Walk over loot to pick it up. Rarity: Common (plain), Magic (+, double border), Rare (++, thick double), Unique (*, star/dashed).",
      "Select an item to compare it for each character and equip it in one click. Every member gets the full XP of each kill.",
      "Drop leaves an item on your tile (it stays on that floor and is never picked up automatically; stand on it and press P to take it back). Discard destroys it.",
      "The run autosaves in this browser when it can. Export downloads a portable JSON file; Import Run (title screen) restores it exactly, on any computer."]]
  ];
  function openHelp() {
    var box = $("modal-box"); clear(box);
    box.appendChild(el("h2", "", "The Gloam Below - Help"));
    box.className = "modal-box wide";
    var cols = el("div", "cols3");
    HELP.forEach(function (sec) {
      var d = el("div");
      d.appendChild(el("h3", "", sec[0]));
      var ul = el("ul");
      sec[1].forEach(function (line) { ul.appendChild(el("li", "", line)); });
      d.appendChild(ul);
      cols.appendChild(d);
    });
    box.appendChild(cols);
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
      if (ev.key === "Tab") {
        // Keep keyboard focus inside the open dialog.
        var fs = [].slice.call($("modal-box").querySelectorAll("button:not([disabled]), input, [tabindex='0']"));
        if (fs.length) {
          var at = fs.indexOf(document.activeElement);
          var nx = ev.shiftKey ? (at <= 0 ? fs.length - 1 : at - 1) : (at < 0 || at >= fs.length - 1 ? 0 : at + 1);
          fs[nx].focus();
        }
        ev.preventDefault(); return;
      }
      if (ev.key === "Enter" && ui.modal === "help") {
        var fb = document.activeElement && $("modal-box").contains(document.activeElement) && document.activeElement.tagName === "BUTTON" ? document.activeElement : null;
        if (fb) fb.click(); else closeModal();
        ev.preventDefault(); return;
      }
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
    if (ui.travel && ev.code !== "KeyE" && ev.code !== "KeyG") { stopTravel(); if (ev.key === "Escape") { ev.preventDefault(); return; } }
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
    if (ev.code === "KeyF") { stopTravel(); startAttack(); ev.preventDefault(); return; }
    if (ev.code === "KeyE") { startTravel({ kind: "explore" }); ev.preventDefault(); return; }
    if (ev.code === "KeyG") { startTravel({ kind: "travel" }); ev.preventDefault(); return; }
    if (ev.code === "KeyP") { doAct({ type: "pickup" }); ev.preventDefault(); return; }
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
  $("btn-export").addEventListener("click", exportRun);
  $("btn-sound").addEventListener("click", toggleSound);
  $("file-import").addEventListener("change", function (ev) { importFile(ev.target.files && ev.target.files[0]); });
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
