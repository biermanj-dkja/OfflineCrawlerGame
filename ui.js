/* The Gloam Below - browser rendering and input. All rules live in logic.js (global Game).
 * Every player-visible string is written with textContent; imported text is never parsed as HTML. */
(function () {
  "use strict";
  var G = window.Game;
  var TS = 24; // canvas tile size in internal pixels
  var state = null;
  var ui = { screen: "title", sel: 0, travel: null, hover: null, flashes: [], party: [], seedMode: "random", seedText: "" };

  // ---------- DOM helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function button(label, fn, cls, title) {
    var b = el("button", cls || "", label);
    b.type = "button";
    if (title) b.title = title;
    b.addEventListener("click", fn);
    return b;
  }
  function show(screen) {
    ["title", "create", "game", "end"].forEach(function (s) { $("scr-" + s).hidden = s !== screen; });
    ui.screen = screen;
  }

  // ---------- Title ----------
  function renderTitle() {
    show("title");
    var m = $("title-menu"); clear(m);
    m.appendChild(menuButton("N", "New Game", function () { startCreate(); }));
    m.appendChild(menuButton("H", "Controls / Help", openHelp));
    var first = m.querySelector("button"); if (first) first.focus();
  }
  function menuButton(key, label, fn) {
    var b = el("button"); b.type = "button";
    var k = el("span", "key", key); b.appendChild(el("span", "", "[")); b.appendChild(k); b.appendChild(el("span", "", "] " + label));
    b.dataset.key = key.toLowerCase();
    b.addEventListener("click", fn);
    return b;
  }

  // ---------- Party creation ----------
  var NAMES = ["Aldous", "Bryn", "Corvin", "Dagna", "Esk", "Fenwick", "Garrow", "Hesper", "Ilse", "Jory"];
  function startCreate() {
    ui.party = [{ cls: "sentinel", name: NAMES[0] }];
    renderCreate();
  }
  function renderCreate() {
    show("create");
    var box = $("create-members"); clear(box);
    ui.party.forEach(function (p, i) {
      var card = el("div", "member-card");
      card.appendChild(el("h3", "", "Member " + (i + 1) + (i === 0 ? " - front rank" : " - back rank")));
      var row = el("div", "row");
      var inp = el("input"); inp.type = "text"; inp.maxLength = 18; inp.value = p.name;
      inp.setAttribute("aria-label", "Name for member " + (i + 1));
      inp.addEventListener("input", function () { p.name = inp.value; });
      row.appendChild(inp);
      row.appendChild(button("Reroll", function () { p.name = NAMES[(NAMES.indexOf(p.name) + 1) % NAMES.length]; renderCreate(); }));
      card.appendChild(row);
      var C = G.CLASSES[p.cls];
      var d = el("div", "class-desc");
      d.appendChild(el("b", "", C.name + " - " + C.role)); d.appendChild(el("div", "", C.blurb));
      card.appendChild(d);
      box.appendChild(card);
    });
    $("btn-add-member").hidden = true;
  }
  function beginRun() {
    var party = ui.party.map(function (p) { return { cls: p.cls, name: (p.name || "").trim() || "Nameless" }; });
    state = G.newRun({ seed: String(Date.now() % 1000000), party: party });
    ui.sel = 0;
    show("game");
    fitCanvas();
    renderGame();
  }

  // ---------- Game rendering ----------
  function renderGame() {
    if (!state) return;
    if (state.status === "victory" || state.status === "defeat") { renderEnd(); return; }
    renderHud(); renderParty(); renderActions(); renderLog(); renderInfo(); drawMap();
  }
  function renderHud() {
    $("hud-floor").textContent = "Floor " + state.floor.num;
    var o = $("hud-objective");
    o.textContent = "Objective: " + (state.floor.objective.done ? "Stairs open - descend." : G.objectiveText(state));
    o.className = "hud-obj" + (state.floor.objective.done ? " done" : "");
    $("hud-seed").textContent = "Seed: " + state.seed;
  }
  function renderParty() {
    var p = $("party"); clear(p);
    var actor = G.currentActor(state);
    state.party.forEach(function (c, i) {
      var st = G.charStats(c), C = G.CLASSES[c.cls];
      var card = el("div", "pcard" + (i === ui.sel ? " sel" : "") + (actor === c ? " actor" : "") + (c.down ? " down" : ""));
      var g = el("div", "pglyph", C.glyph); g.style.borderColor = "#e9c986"; g.style.color = "#e9c986";
      card.appendChild(g);
      var nm = el("div", "pname"); nm.appendChild(el("span", "", c.name + " "));
      nm.appendChild(el("span", "rank", (G.front(state) === c ? "FRONT" : "back") + " - " + C.name + " L" + c.level));
      card.appendChild(nm);
      card.appendChild(el("div", "pmeta", c.down ? "DOWNED" : c.hp + "/" + st.maxHp));
      var bar = el("div", "bar"); var fill = el("i"); fill.style.width = (100 * c.hp / st.maxHp) + "%"; bar.appendChild(fill);
      bar.appendChild(el("span", "half")); card.appendChild(bar);
      card.addEventListener("click", function () { ui.sel = i; renderGame(); });
      p.appendChild(card);
    });
  }
  function renderActions() {
    var a = $("actions"); clear(a);
    var actor = G.currentActor(state);
    var who = actor || state.party[ui.sel] || G.front(state);
    var line = el("div", "turnline");
    if (state.status === "combat") {
      line.appendChild(el("span", "", "Round " + state.combat.round + " - "));
      line.appendChild(el("b", "", actor ? actor.name + " acts" : ""));
      line.appendChild(el("span", "", state.combat.moved ? "  (party has moved)" : "  (Move available)"));
    } else line.appendChild(el("span", "", "Exploring. Acting: " + who.name));
    a.appendChild(line);
    var grid = el("div", "abtns");
    who.abilities.forEach(function (ab, k) {
      var A = G.ABILITIES[ab.id];
      var b = el("button");
      b.type = "button";
      b.appendChild(el("span", "kc", (k + 1) + " "));
      b.appendChild(el("span", "", A.name));
      b.appendChild(el("span", "ch", A.charges ? ab.charges + "/" + G.abilityMax(who, ab.id) : "inf"));
      b.title = A.desc;
      b.addEventListener("click", function () { useAbility(k); });
      grid.appendChild(b);
    });
    a.appendChild(grid);
    var util = el("div", "utilrow");
    util.appendChild(button("Rest (Space)", function () { doAct({ type: "rest" }); }));
    var d = button("Descend (>)", function () { doAct({ type: "descend" }); });
    d.disabled = !G.canDescend(state);
    util.appendChild(d);
    a.appendChild(util);
  }
  function renderLog() {
    var l = $("log"); clear(l);
    state.log.slice(-40).forEach(function (e) { l.appendChild(el("div", "l-" + e.k, e.m)); });
    l.scrollTop = l.scrollHeight;
  }
  function renderInfo() {
    var box = $("info"); clear(box);
    var h = ui.hover;
    if (!h) { box.appendChild(el("div", "fine", "Hover a tile for details.")); return; }
    var lines = describeTile(h.x, h.y);
    lines.forEach(function (t, i) { box.appendChild(el("div", i === 0 ? "ttl" : "", t)); });
  }
  function describeTile(x, y) {
    var f = state.floor;
    if (!G.isSeen(f, x, y)) return ["Unexplored darkness."];
    var out = [];
    var e = G.enemyAt(state, x, y);
    if (e && !e.hidden && G.canSee(state, x, y)) {
      var D = G.ENEMIES[e.type];
      out.push(D.name + "  HP " + e.hp + "/" + e.maxHp);
      out.push(D.desc);
      out.push("Intent: " + G.intentOf(state, e));
    }
    if (x === state.pos.x && y === state.pos.y) out.push("Your party (one tile; formation is the portrait order).");
    if (x === f.stairs.x && y === f.stairs.y) out.push("Stairs down" + (f.objective.done ? " - open." : " - sealed until the objective is done."));
    if (!out.length) out.push(G.tileAt(f, x, y) === "#" ? "Wall." : "Floor.");
    if (!G.canSee(state, x, y)) out.push("(remembered - not currently in sight)");
    return out;
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
        g.fillStyle = "#2a2530"; g.fillRect(px, py + 11, TS, 2); g.fillRect(px + 11, py, 2, 11);
      } else {
        g.fillStyle = "#17141b"; g.fillRect(px, py, TS, TS);
        g.fillStyle = "#2a2530"; g.fillRect(px + 11, py + 11, 2, 2);
      }
      if (!vis) { g.fillStyle = "rgba(5,4,7,0.62)"; g.fillRect(px, py, TS, TS); }
    }
    if (G.isSeen(f, f.stairs.x, f.stairs.y)) drawGlyph(g, f.stairs.x, f.stairs.y, ">", f.objective.done ? "#9fe0ff" : "#6a7a80", "#9fe0ff", "box");
    f.enemies.forEach(function (e) {
      if (e.hidden || !G.canSee(state, e.x, e.y)) return;
      var D = G.ENEMIES[e.type];
      drawGlyph(g, e.x, e.y, D.glyph, "#ff9a8a", "#d0503a", "round");
      var w = Math.max(2, Math.round((TS - 4) * e.hp / e.maxHp));
      g.fillStyle = "#000"; g.fillRect(e.x * TS + 2, e.y * TS + TS - 4, TS - 4, 3);
      g.fillStyle = "#e04a3a"; g.fillRect(e.x * TS + 2, e.y * TS + TS - 4, w, 3);
      if (!e.awake) badge(g, e.x, e.y, "z", "#9fd0ff");
      if (e.st.stun > 0) badge(g, e.x, e.y, "*", "#ffe27a");
    });
    drawGlyph(g, state.pos.x, state.pos.y, "@", "#ffe9b0", "#e9c986", "square");
  }
  function drawGlyph(g, x, y, ch, color, border, shape) {
    var px = x * TS, py = y * TS;
    g.fillStyle = "#0b0a0d";
    g.fillRect(px + 2, py + 2, TS - 4, TS - 4);
    g.strokeStyle = border; g.lineWidth = 2;
    if (shape === "round") { g.beginPath(); g.arc(px + TS / 2, py + TS / 2, TS / 2 - 3, 0, Math.PI * 2); g.stroke(); }
    else g.strokeRect(px + 3, py + 3, TS - 6, TS - 6);
    g.fillStyle = color; g.font = "bold 15px Consolas, monospace"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(ch, px + TS / 2, py + TS / 2 + 1);
  }
  function badge(g, x, y, ch, color) {
    var px = x * TS + TS - 8, py = y * TS + 1;
    g.fillStyle = "#000"; g.fillRect(px, py, 8, 9);
    g.fillStyle = color; g.font = "bold 9px Consolas, monospace"; g.textAlign = "center"; g.textBaseline = "top";
    g.fillText(ch, px + 4, py);
  }
  function tileFromEvent(ev) {
    var cv = $("map"), r = cv.getBoundingClientRect();
    var x = Math.floor((ev.clientX - r.left) / r.width * G.MAP_W), y = Math.floor((ev.clientY - r.top) / r.height * G.MAP_H);
    if (x < 0 || y < 0 || x >= G.MAP_W || y >= G.MAP_H) return null;
    return { x: x, y: y };
  }

  // ---------- Actions ----------
  function doAct(a) {
    if (!state) return null;
    var res = G.act(state, a);
    if (!res.ok && res.msg) flashInfo(res.msg);
    renderGame();
    return res;
  }
  function flashInfo(msg) {
    var b = $("banner"); b.textContent = msg; b.className = "banner"; b.hidden = false;
    clearTimeout(flashInfo.t); flashInfo.t = setTimeout(function () { b.hidden = true; }, 2200);
  }
  function useAbility(k) {
    var actor = G.currentActor(state) || state.party[ui.sel];
    if (!actor || !actor.abilities[k]) return;
    var id = actor.abilities[k].id, A = G.ABILITIES[id];
    var a = { type: "ability", id: id, actor: actor.id };
    if (A.target === "enemy") {
      var t = nearestTarget(actor, A.range || 1);
      if (!t) { flashInfo("No valid target for " + A.name + "."); return; }
      a.target = t.id;
    }
    doAct(a);
  }
  function nearestTarget(actor, range) {
    var best = null, bd = 99;
    state.floor.enemies.forEach(function (e) {
      if (e.hidden || !G.canSee(state, e.x, e.y)) return;
      var d = G.cheb(e.x, e.y, state.pos.x, state.pos.y);
      if (d <= range && d < bd) { bd = d; best = e; }
    });
    return best;
  }
  function stopTravel() { if (ui.travel) { clearTimeout(ui.travel.timer); ui.travel = null; } }
  function travelTo(x, y) {
    stopTravel();
    ui.travel = { x: x, y: y, timer: null };
    travelTick();
  }
  function travelTick() {
    var t = ui.travel;
    if (!t || !state || state.status !== "explore") { stopTravel(); return; }
    var step = G.stepTowardTile(state, t.x, t.y);
    if (!step) { stopTravel(); return; }
    var res = doAct({ type: "move", dx: step[0], dy: step[1] });
    if (!res || !res.ok || res.events.some(function (e) { return e.type === "discover" || e.type === "combat" || e.type === "hurt"; })) { stopTravel(); return; }
    if (!ui.travel) return;
    t.timer = setTimeout(travelTick, 45);
  }

  // ---------- End screen ----------
  function renderEnd() {
    show("end");
    var win = state.status === "victory";
    var t = $("end-title"); t.textContent = win ? "VICTORY" : "THE PARTY HAS FALLEN"; t.className = win ? "win" : "lose";
    $("end-sub").textContent = win ? "You climb back toward a morning you had stopped believing in." : "The dark keeps what it takes.";
    var s = $("end-stats"); clear(s);
    [["Seed", state.seed], ["Floor reached", state.floor.num], ["Enemies slain", state.stats.kills], ["Turns", state.stats.turns]]
      .forEach(function (kv) { s.appendChild(el("span", "k", kv[0])); s.appendChild(el("span", "", kv[1])); });
    var m = $("end-menu"); clear(m);
    m.appendChild(menuButton("N", "New Game", startCreate));
    m.appendChild(menuButton("T", "Title", renderTitle));
  }

  // ---------- Help ----------
  function openHelp() {
    var box = $("modal-box"); clear(box);
    box.appendChild(el("h2", "", "Controls"));
    box.appendChild(el("p", "", "WASD / arrows: move. Numpad: 8 directions. Click a known tile to travel. 1-4: abilities. Space: rest. >: descend. Esc: close."));
    box.appendChild(button("Close", closeModal));
    $("modal").hidden = false;
  }
  function closeModal() { $("modal").hidden = true; }

  // ---------- Input ----------
  var KEYDIR = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0],
    Numpad8: [0, -1], Numpad2: [0, 1], Numpad4: [-1, 0], Numpad6: [1, 0], Numpad7: [-1, -1], Numpad9: [1, -1], Numpad1: [-1, 1], Numpad3: [1, 1] };
  document.addEventListener("keydown", function (ev) {
    if (ev.target && ev.target.tagName === "INPUT") return;
    if (!$("modal").hidden) { if (ev.key === "Escape") closeModal(); return; }
    if (ui.screen === "title" || ui.screen === "end") {
      var b = document.querySelector("#scr-" + ui.screen + " button[data-key='" + ev.key.toLowerCase() + "']");
      if (b) { b.click(); ev.preventDefault(); }
      return;
    }
    if (ui.screen !== "game" || !state) return;
    if (KEYDIR[ev.code]) { stopTravel(); var d = KEYDIR[ev.code]; doAct({ type: "move", dx: d[0], dy: d[1] }); ev.preventDefault(); return; }
    if (ev.code === "Space") { stopTravel(); doAct({ type: "rest" }); ev.preventDefault(); return; }
    if (ev.key === ">" || ev.code === "Period" && ev.shiftKey) { doAct({ type: "descend" }); return; }
    if (/^Digit[1-9]$/.test(ev.code)) { useAbility(parseInt(ev.code.slice(5), 10) - 1); ev.preventDefault(); return; }
    if (ev.key === "Escape") { stopTravel(); }
  });
  $("map").addEventListener("mousemove", function (ev) {
    var t = tileFromEvent(ev); if (!state || !t) return;
    if (!ui.hover || ui.hover.x !== t.x || ui.hover.y !== t.y) { ui.hover = t; renderInfo(); }
  });
  $("map").addEventListener("click", function (ev) {
    var t = tileFromEvent(ev); if (!state || !t) return;
    var e = G.enemyAt(state, t.x, t.y);
    if (e && !e.hidden && G.canSee(state, t.x, t.y)) { var actor = G.currentActor(state) || state.party[ui.sel]; doAct({ type: "attack", target: e.id, actor: actor.id }); return; }
    var dx = t.x - state.pos.x, dy = t.y - state.pos.y;
    if (state.status === "combat") {
      if (Math.max(Math.abs(dx), Math.abs(dy)) === 1) doAct({ type: "move", dx: dx, dy: dy });
      else flashInfo("In combat the party moves one tile per party phase.");
      return;
    }
    travelTo(t.x, t.y);
  });
  $("btn-help").addEventListener("click", openHelp);
  $("btn-menu").addEventListener("click", function () { stopTravel(); renderTitle(); });
  $("btn-create-go").addEventListener("click", beginRun);
  $("btn-create-back").addEventListener("click", renderTitle);
  window.addEventListener("resize", function () { if (ui.screen === "game") fitCanvas(); });

  renderTitle();
})();
