# The Gloam Below

A short, turn-based, offline fantasy dungeon-crawler. Lead a party of one to three adventurers down six procedurally generated floors to a final boss. A successful run takes about 25–45 minutes.

## Launch

Open `index.html` directly from disk in a current desktop Chrome, Edge, or Firefox. No server, internet connection, install, account, or build step is needed. The page loads only the local files beside it: `logic.js`, `ui.js`, and `style.css`.

## The game

- **Party:** 1–3 characters with any classes (duplicates allowed) and generated or edited names. Creation order sets the formation. A lone character gets the *Lone Delver* trait: +50% max HP and +1 charge on each limited ability.
- **Classes:**
  - **Sentinel:** front-line guardian who shoves, taunts, guards, and rallies.
  - **Stalker:** marksman with aimed shots, caltrops, and a free repositioning Slip.
  - **Arcanist:** elemental caster with ember bolts, frost bursts, and light flares.
  - **Votary:** healer and hexer who mends, wards, and curses.

  Level-ups offer three choices: a new ability, an ability upgrade, a passive, or a stat increase.
- **Formation:** slot 1 is the front rank. Only the front rank makes melee attacks, and enemy melee targets it first. Back-rank characters need a reach or ranged weapon, a spell, or an ability.
- **Combat:** combat starts when an awake foe comes into view. In the party phase, each member acts in portrait order; the whole party may make one shared Move per phase. In the enemy phase, foes act nearest-first. Hover a foe to read its intent; telegraphed attacks are marked with red stripes.
- **Recovery:** after a fight, each conscious member recovers 10% of max HP, but never past half health. Resting never heals and never restores charges. Descending revives the downed at 25% HP, heals everyone else 25%, and restores half of each ability's missing charges (rounded up).
- **Floors:** each floor has a theme (Ossuary, Drowned Cistern, Ember Foundry, Umbral Chapel) and one objective: reach the stairs, destroy the Spawning Gate, defeat the warden, or carry a relic to the stairs.
  - Twelve enemy behaviours, including ranged kiters, telegraphed chargers, healers, hidden ambushers, splitters, exploders, defenders, and light-shy shades.
  - Light and shadow ground affects some creatures.
  - Floor 7 holds a three-phase boss weakened by lit braziers.
- **Loot:** one shared 16-slot inventory (equipped items don't use slots) and 41 items, including 7 uniques. Rarity is shown by colour and also by a mark (`+`, `++`, `*`) and border style.

## Controls

| Key | Action |
| --- | --- |
| WASD / arrows / numpad | Move (numpad for diagonals); click a known tile to travel |
| E | Auto-Explore |
| G | Travel to the objective or open stairs |
| F | Basic attack (Tab cycles targets, Enter confirms) |
| 1–6 | Abilities of the acting or selected character |
| Space | Rest / skip |
| > | Descend |
| Esc | Cancel targeting, stop travel, close a panel |
| H or ? | Help |

Click a portrait to choose who uses abilities and items outside combat. Drag portraits, or use their arrows, to reorder the formation outside combat.

## Seeds, Daily Dungeon, and saves

- **Seeds:** New Game uses a random seed, or you can enter your own. The current seed appears in the top bar.
- **Daily Dungeon:** uses the UTC date (`YYYY-MM-DD`) as the seed. Everyone gets the same floors, objectives, enemy placement, loot placement, hazards, and shrines that day. The roster is filtered deterministically by party size.
- **Autosave:** the run autosaves to `localStorage` after every action when the browser allows it. If it doesn't (some browsers block storage for `file://` pages), the game shows a notice and keeps working.
- **Export / Import:** **Export** downloads a readable JSON snapshot: the full state, including the runtime RNG's internal state and generator version. **Import Run** on the title screen validates the file and continues the run exactly, even on another computer. Files over 2 MiB, malformed files, and incompatible or tampered files are rejected without changing the current game.

## Tests

```
node test.js
```

The tests need no dependencies. They cover:
- solvability across 100 seeds × 7 floors
- floor determinism and RNG stream independence
- export/import round trips and identical continuation after restore
- combat rules: shared Move, formation, sleeping and waking, ambush, downing, recovery, defeat, and victory
- 1–3 member parties and full XP for each member
- import rejection, spawner XP limits, and no recovery from resting
- a bot that plays two complete games to victory

## Files

| File | Contents |
| --- | --- |
| `index.html` | Page shell |
| `style.css` | Presentation |
| `logic.js` | All rules, generation, deterministic RNG, saves, and validation. Global `Game` in the browser; `module.exports` in Node. |
| `ui.js` | Rendering and input |
| `test.js` | Tests |

All code, text, and graphics are original. Released under the MIT License (see `LICENSE`).
