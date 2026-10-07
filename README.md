# Sea Change

A browser-based **Web MIDI** preset selector and editor for the **E-MU
Proteus 2000**: Proteus being the shape-shifting sea god, and changing shape
being the whole job. Sibling of [Small Change](https://github.com/plentyofnames/small-change).

▶︎ **Live app:** https://plentyofnames.github.io/sea-change/

**Presets tab:** pick a ROM, hit a bank, click a preset by name. Sea Change
sends Bank Select MSB, Bank Select LSB and the Program Change in one go, so the
Proteus always lands exactly on the preset you clicked, whatever bank it was in
before.

**Editor tab:** every parameter of the preset on your channel, with the knobs
showing what the unit shows (Hz, dB, note names, tempo divisions). Edits go to
the Proteus as you make them; write the result to a user location or save it
as a `.syx` file.

**Setup tab:** the current multisetup: what each of the 32 MIDI channels
plays, the Master menu, the master effects and arpeggiator, MIDI controller
assignments and Beats, saved to and loaded from the unit's 128 setups.

## Presets tab

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
- **User banks 0–3 by name**: *Read names from P2K* pulls the 512 user preset
  names from the unit over SysEx and remembers them. They show in the banks
  and in search.
- **Double-click** a preset to open it in the editor.
- **Remembers the MIDI ports and channel** in the browser. If the saved
  output isn't plugged in yet, it's picked up as soon as it appears.

## Editor tab

- **Get from P2K** reads the preset playing on your channel (the edit buffer).
  Pick a preset in the Presets tab and switch over: the editor follows.
- **Preset page:** a key-range map of the four layers and both links; effects
  A and B; the preset arpeggiator; links; initial controller amounts A–L,
  tempo offset, keyboard tuning and audition riff; the 12 preset patchcords.
- **Layer pages (1–4):** instrument (by name, grouped by category), volume,
  pan, submix; tuning, transpose, chorus, bend; key/velocity/real-time ranges
  with fades; glide, solo, assign group, sound start and delay; the filter
  (cutoff in Hz, swept-EQ gain in dB, vowel morph/body size, labels change
  with the filter type); both LFOs; the volume, filter and aux envelopes with
  a drawing of each; all 24 patchcords.
- **Live:** each change goes out as a SysEx parameter edit, paced and
  coalesced so slider drags don't flood the unit. The Proteus applies edits
  to the notes you play next, so there's a keyboard at the bottom (mouse, or
  the Z–M and Q–U rows of your computer keyboard) to audition with.
- **Send** puts the preset in the unit's edit buffer; **Write…** stores it in
  a user location (bank 0–3, 0–127; with the names there, once read).
- **Undo/Redo** (⌘Z / ⇧⌘Z), **Revert** to the preset as loaded, **Init**
  (E-MU's default preset), **Copy layer to…**.
- **Open… / Save .syx:** single presets or files with several (you pick one).
  Saved files are edit-buffer dumps: sending one to a P2K with any SysEx tool
  loads it without overwriting anything. Drop a file on the editor to open it.
- Click any value to type it.

## Setup tab

- **Get from P2K** reads the current multisetup. Every change goes to the unit
  as you make it; **Save…** stores the setup in one of its 128 locations,
  **Load** makes a stored one current (with the setup names, once read).
- **MIDI channels:** for each of the 32 channels (1A–16A, and 1B–16B behind a
  toggle): on/off, ROM and preset by name, volume, pan, output, arp, and
  whether it takes program changes. The basic channel and the app's own
  channel are marked.
- **Master:** tempo, transpose, tune, bend range, velocity curve, effects
  bypass; MIDI mode, basic channel, effects and tempo control channels; the
  front-panel knob options.
- **Master effects** (what presets set to *Master FX* use) and the **master
  arpeggiator**, including its MIDI out and song-start options.
- **MIDI controllers:** the CC numbers of knobs A–L, the footswitches and the
  tempo controllers; knob MIDI out and the SysEx packet delay.
- **Beats:** mode, Beats and trigger channels, trigger offset, riff tempo and
  controllers, the master riff (BTS riffs listed first), and the trigger
  layout: the key and latch mode of all 24 triggers, and each part's
  velocity, transpose and group. The trigger layout isn't part of the setup
  dump; it's read with parameter requests and hidden if the unit doesn't
  answer them.

## ROMs and bank select

| ROM | Display | MSB (CC 0) | LSB (CC 32) | Preset names from |
|-----|---------|-----------:|------------:|-------------------|
| Composer | `CMPSR` | 4 | 0–7 | Proteus 2000 Operation Manual Rev. E, corrected from the unit's own names |
| Pure Phatt | `PHATT` | 13 | 0–3 | Turbo Phatt Operation Manual Rev. A |
| TSCY (Techno Synth Construction Yard) | `TeCnO` | 65 | 0–3 | Orbit-3 Operation Manual Rev. A |
| Beat Garden | `BEAT` | 67 | 0–3 | Orbit-3 Operation Manual Rev. A |
| User | | 0 | 0–3 | read from the unit |

Pure Phatt is the sound set of the Turbo Phatt and Mo'Phatt modules; TSCY
and Beat Garden are the two halves of the Orbit-3. Other Proteus 2000-family
ROMs aren't in yet; presets that use them still edit fine, with numbers where
the names would be.

The Composer names were checked against the names a real unit reports (as
read by prodatum and Edisyn), which fixed 17 that the manual transcription
had cut short or misspelled: `wav:Pure H20`, `bs4:CZ101`, `kit:Drum 303` and
so on.

The Proteus 2000 manual lists Composer banks 4–7 as "User Bank 0–3, CMPSR
Bank 4–7", because the factory user banks start out as copies of them. They
are real ROM banks; your user banks will have moved on since.

## Requirements

- A **Web MIDI–capable browser**: Chrome/Chromium-based (Chrome, Edge,
  Opera, Brave), or Firefox 108+. Safari has no Web MIDI.
- **Presets tab:** a MIDI out connected to the Proteus 2000's MIDI in. Set
  the app's channel to the channel the Proteus listens on for the part you
  want to change. No SysEx permission is needed.
- **Editor tab:** also a MIDI **in** from the Proteus's MIDI out, and the
  browser's **SysEx** permission (asked for the first time you open the
  editor). Set *SysEx ID* to the unit's MIDI SysEx ID (Master menu, default 0).
  Without MIDI in, Send and Write still work (open-loop), and you can edit
  files offline.
- **Setup tab:** MIDI in and out, and SysEx, like the editor.

## How it talks to the Proteus

From E-MU's *Proteus Family System Exclusive Specification* v2.2, corrected
where [Edisyn](https://github.com/eclab/edisyn) and
[prodatum](https://sourceforge.net/projects/prodatum/) found the hardware
differs:

- **Get** requests a closed-loop dump of the edit buffer (`7F 7F`) and
  acknowledges each packet. **Send/Write** send a closed-loop dump (waiting
  for each ACK), or with 150 ms gaps when there's no MIDI in.
- The SysEx edit buffer belongs to the unit's **basic channel**. If that
  differs from the app's channel, the editor sets the basic channel to it
  (as prodatum does) and says so in the status line.
- After a dump, the unit takes live edits only once the channel's multimode
  ROM id is set to 0 and the edit buffer is selected (prodatum's sequence);
  the editor does this after every Get, Send and Write.
- Layer parameters need a `LAYER_SELECT` first; it's sent only when the
  layer changes.
- Dump section sizes come from the dump header and vary by firmware (a P2K
  sends 52 common parameters, a P2500 56); decoding follows the header, and
  presets are re-encoded with the sizes they came with.
- **Setups** are read as one setup dump. Its sections hold parameters in id
  order, sized by its header; which ids the MIDI section skips differs between
  the spec and prodatum, so both readings are tried and the one where the
  SysEx ID and the footswitch/knob CC numbers make sense is used. Changes go
  out as parameter edits by id, after the multimode channel select for
  channel settings and the layer select for Beats triggers and parts. Save and
  Load use E-MU's Copy Setup command; after a Load the SysEx ID is set back
  to the app's (a setup carries its own).
- Spec errata the editor follows: tempo offset is three-valued (½×, 1×, 2×),
  arp note values run 1–19, the FX B delay also takes −12…−1 (tempo-synced),
  LFO 2 has all LFO 1 shapes, pans run −64…+63, fine tune −63…+63.

## Files

| File | |
|------|-|
| `index.html` | page and styles |
| `p2k-roms.js` | ROM database: preset, instrument, riff and arp pattern names |
| `p2k-data.js` | parameter tables, ranges, display formulas, E-MU's default preset |
| `p2k-core.js` | SysEx encode/decode: messages, dumps, handshakes, `.syx` files (no DOM) |
| `midi.js` | Web MIDI ports, the paced send queue, user preset names |
| `ui.js` | controls and option lists shared by the Editor and Setup tabs |
| `presets.js` | the Presets tab |
| `editor.js` | the Editor tab |
| `setup.js` | the Setup tab |
| `sim.js` | a simulated Proteus 2000 for development (`index.html?sim`) |
| `test.html` | tests for `p2k-core.js` and `p2k-data.js` |

No build step, no dependencies. Serve the folder over HTTP to work on it
(`python3 -m http.server`), open `test.html` for the tests, and add `?sim` to
the page URL to try the editor against the simulated unit.

## Credits

Instrument, riff and arp pattern names come from Edisyn's Proteus 2000 ROM
lists (Apache License 2.0, © Sean Luke), which came from prodatum's database
(© Jan Mann). E-MU's default preset is the one Edisyn ships. The protocol
details above owe a lot to both projects.

## License

MIT. The preset and sample names belong to E-MU; their manuals are not
redistributed here.
