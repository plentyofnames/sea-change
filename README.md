# Sea Change

A browser-based **Web MIDI** preset selector for the **E-MU Proteus 2000**:
Proteus being the shape-shifting sea god, and changing shape being the whole
job. Sibling of [Small Change](https://github.com/plentyofnames/small-change).

▶︎ **Live app:** https://plentyofnames.github.io/sea-change/

Pick a ROM, hit a bank, click a preset by name. Sea Change sends Bank Select
MSB, Bank Select LSB and the Program Change in one go, so the Proteus always
lands exactly on the preset you clicked, whatever bank it was in before.

## Features

- **All 2,560 ROM presets by name** for Composer, Pure Phatt, TSCY and
  Beat Garden, with each bank's 128 presets on one screen.
- **Big bank buttons** showing the bank select values (MSB/LSB) and which
  preset categories live in each bank.
- **Search across all ROMs** by name or by the three-letter category code
  (`bs3` finds Composer's sub basses). Several words must all match.
- **Type filter** that groups each ROM's own category codes into 18 types
  (Bass = `bas`, `bs1`–`bs5`, `sub`; Keys & Organ = `kb1`–`kb4`, `key`,
  `org`; …). Works alone or together with the search.
- Clicking a search result sends it and moves the bank view to where it
  lives; **Esc** returns to the bank view.
- **User banks 0–3**, selectable by number.
- **Remembers the MIDI output and channel** in the browser. If the saved
  output isn't plugged in yet, it's picked up as soon as it appears.
- One self-contained `index.html`: no build step, no dependencies.

## ROMs and bank select

| ROM | Display | MSB (CC 0) | LSB (CC 32) | Preset names from |
|-----|---------|-----------:|------------:|-------------------|
| Composer | `CMPSR` | 4 | 0–7 | Proteus 2000 Operation Manual Rev. E |
| Pure Phatt | `PHATT` | 13 | 0–3 | Turbo Phatt Operation Manual Rev. A |
| TSCY (Techno Synth Construction Yard) | `TeCnO` | 65 | 0–3 | Orbit-3 Operation Manual Rev. A |
| Beat Garden | `BEAT` | 67 | 0–3 | Orbit-3 Operation Manual Rev. A |
| User | | 0 | 0–3 | |

Pure Phatt is the sound set of the Turbo Phatt and Mo'Phatt modules; TSCY
and Beat Garden are the two halves of the Orbit-3. Other Proteus 2000-family
ROMs aren't in yet.

The Proteus 2000 manual lists Composer banks 4–7 as "User Bank 0–3, CMPSR
Bank 4–7", because the factory user banks start out as copies of them. They
are real ROM banks; your user banks will have moved on since.

## Requirements

- A **Web MIDI–capable browser**: Chrome/Chromium-based (Chrome, Edge,
  Opera, Brave), or Firefox 108+. Safari has no Web MIDI. No SysEx
  permission is needed.
- A MIDI out connected to the Proteus 2000's MIDI in. Set the app's channel
  to the channel the Proteus listens on for the part you want to change.

## Planned

- Pull the user preset names from the unit over SysEx, so the user banks
  show names instead of numbers.

## License

MIT. The preset names belong to E-MU; their manuals are not redistributed
here.
