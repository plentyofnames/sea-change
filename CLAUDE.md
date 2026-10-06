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
- Sea Change's Composer preset names were typed from the manual and differ
  from the unit's in ~17 places (truncations like `wav:Pure H` vs `wav:Pure
  H20`); name comparisons normalise whitespace and allow prefixes.
- None of this has been tested on hardware yet: treat new findings as
  corrections and note them here.

Testing: serve the folder (`.claude/launch.json` in the parent folder, port
8920), open `test.html` after touching the core. No MIDI in the preview pane:
open `index.html?sim` for a simulated P2K (`sim.js`, inspect `window.SIM`).
`localStorage` keys are prefixed `sea-change:`.
