# Sea Change (Proteus 2000 selector + editor)

Web MIDI preset selector (Presets tab) and full preset editor (Editor tab) for
the E-MU Proteus 2000. Repo `plentyofnames/sea-change`, published on GitHub
Pages (plentyofnam.es/sea-change). Vanilla JS, no build, no frameworks: same
stack and conventions as `../../TX81Z Editor` (OP SHOP) and `../../PCM 70
Editor`: one paced send queue with per-key coalescing (`midi.js`), pure
byte-level code kept DOM-free and tested (`p2k-core.js` + `test.html`).

**Protocol references** (in `../reference/`, outside the repo):
`Proteus Family SysEx 2.2.pdf` (E-MU's spec; `p2k-sysex.txt` is its text),
Edisyn's `EmuProteus2000.java`, prodatum's `pxk.C` / `midi.C` / `data.C`.
The spec has errors; where it disagrees with Edisyn/prodatum, they win
(both talk to real units). `p2k-data.js` marks each correction with `spec:`.

Key facts that trip people up:

- A preset dump's section sizes come from its header and differ by firmware
  (P2K: 52 common-general params, P2500: 56). Decode by the header; keep
  `preset.counts` so a re-encode is byte-identical (tested on E-MU's init dump).
- Dump layout = name (16 single bytes) then params in id order per section;
  ids run base+1..base+count. The envelope section has an unused id (1832).
- Envelope stage ids are A1 D1 R1 A2 D2 R2 (rate, level pairs); time order is
  A1 A2 D1 D2 R1 R2 (`P2KD.STAGE_TIME_ORDER`).
- The SysEx edit buffer is the basic channel's (param 139). After any dump,
  send 129 = channel, 138 = 0, 897 = -1 or live edits are ignored (prodatum).
- Layer params need 898 (LAYER_SELECT) first; `unitLayer` tracks what was sent.
- Live edits only touch notes played afterwards; the unit drops floods of
  edits ("Sysex too fast"), hence the 20 ms pacing and coalescing.
- Closed-loop dumps: header is ACKed as packet 0; send packet n+1 on ACK n;
  EOF after the last. Fall back to open loop (150 ms gaps) without MIDI in.
- Preset names were typed from the manuals. Composer's are corrected against
  the unit's own (Edisyn's `n_prs_4.txt`); the other ROMs still differ from it
  in spacing (the unit pads with double spaces), so name comparisons
  normalise whitespace and allow prefixes.
- The editor worked on the user's P2K in a longer hardware session
  (2026-10-06). Note any hardware findings that contradict the above here.
- Setup tab (not yet tried on hardware): the setup dump (1Ch) is decoded by
  section with ids in order; the MIDI section's gaps are uncertain (spec:
  385, 386, 388, 391..; prodatum's code: none), so `decodeSetup` tries both
  and keeps the plausible one (SysEx ID = dump's device byte, footswitch CCs
  64-79, knobs I-L 70-95). Writes never depend on that: they're param edits.
- 129 (multimode channel) and 898 (layer, or Beats trigger/part) are shared
  selections: both tabs build them with `Midi.select()` inside deferred
  queue builders, so neither tab's edits land on the other's selection.
- The Beats trigger layout (160/161 per trigger, 164-166 per part) isn't in
  the setup dump; it's read with parameter requests (02h), which neither
  Edisyn nor prodatum use, and the card hides itself if they go unanswered.
- After Copy Setup into the current setup, re-send 388 = the app's SysEx ID
  with device 7F (a stored setup can carry another ID; prodatum does this too).

Testing: serve the folder (`.claude/launch.json` in the parent folder, port
8920), open `test.html` after touching the core. No MIDI in the preview pane:
open `index.html?sim` for a simulated P2K (`sim.js`, inspect `window.SIM`).
`localStorage` keys are prefixed `sea-change:`.
