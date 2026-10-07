"use strict";
/* ============================================================================
 * p2k-data — Proteus 2000 parameter tables and display formatting (P2KD).
 *
 * Ids, ranges and enum values follow E-MU's Proteus Family SysEx spec v2.2,
 * corrected where Edisyn / prodatum found the hardware disagrees (marked
 * "spec:" below). Every param def is
 *   { id, label, min, max, opts?, fmt?(v, ctx) }
 * where opts = [[value, label], ...] for enumerations (values are raw and may
 * be scattered), and ctx is the id->value map the param lives in (the layer
 * or the preset common block) so formats can depend on sibling params.
 * ==========================================================================*/
const P2KD = (() => {
  const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const noteName = (v) => NOTES[((v % 12) + 12) % 12] + (Math.floor(v / 12) - 2);
  const signed = (v) => (v > 0 ? "+" + v : String(v));
  const pct = (v) => v + "%";
  const db = (v) => signed(v) + " dB";
  const pan = (v) => (v === 0 ? "C" : v < 0 ? "L" + -v : "R" + v);

  // Negative rates/delays -25..-1 are tempo divisions.
  const TEMPO_DIVS = ["8/1", "4/1d", "8/1t", "4/1", "2/1d", "4/1t", "2/1", "1/1d", "2/1t", "1/1",
    "1/2d", "1/1t", "1/2", "1/4d", "1/2t", "1/4", "1/8d", "1/4t", "1/8", "1/16d", "1/8t", "1/16",
    "1/32d", "1/16t", "1/32"];
  const tempoOr = (f) => (v) => (v < 0 ? TEMPO_DIVS[v + 25] || String(v) : f(v));

  // LFO rate in Hz for 0..127 (not in the spec; Edisyn's table from the unit).
  const LFO_HZ = ("0.08 0.11 0.15 0.18 0.21 0.25 0.28 0.32 0.35 0.39 0.42 0.46 0.50 0.54 0.58 0.63 " +
    "0.67 0.71 0.76 0.80 0.85 0.90 0.94 0.99 1.04 1.10 1.15 1.20 1.25 1.31 1.37 1.42 " +
    "1.48 1.54 1.60 1.67 1.73 1.79 1.86 1.93 2.00 2.07 2.14 2.21 2.29 2.36 2.44 2.52 " +
    "2.60 2.68 2.77 2.85 2.94 3.03 3.12 3.21 3.31 3.40 3.50 3.60 3.70 3.81 3.91 4.02 " +
    "4.13 4.25 4.36 4.48 4.60 4.72 4.84 4.97 5.10 5.23 5.37 5.51 5.65 5.79 5.94 6.08 " +
    "6.24 6.39 6.55 6.71 6.88 7.04 7.21 7.39 7.57 7.75 7.93 8.12 8.32 8.51 8.71 8.92 " +
    "9.13 9.34 9.56 9.78 10.00 10.23 10.47 10.71 10.95 11.20 11.46 11.71 11.98 12.25 12.52 12.80 " +
    "13.09 13.38 13.68 13.99 14.30 14.61 14.93 15.26 15.60 15.94 16.29 16.65 17.01 17.38 17.76 18.14").split(" ");
  const lfoRate = tempoOr((v) => (LFO_HZ[v] || v) + " Hz");

  // Glide rate in sec/octave: the spec's cnv_glide_rate() and its two tables.
  const ENVUNITS1 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2,
    2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 7, 7, 7, 8, 8, 9, 9, 10, 11, 11, 12, 13, 13, 14,
    15, 16, 17, 18, 19, 20, 22, 23, 24, 26, 28, 30, 32, 34, 36, 38, 41, 44, 47, 51, 55, 59, 64, 70,
    76, 83, 91, 100, 112, 125, 142, 163];
  const ENVUNITS2 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    25, 26, 28, 29, 32, 34, 36, 38, 41, 43, 46, 49, 52, 55, 58, 62, 65, 70, 74, 79, 83, 88, 93, 98,
    4, 10, 17, 24, 31, 39, 47, 56, 65, 74, 84, 95, 6, 18, 31, 44, 59, 73, 89, 6, 23, 42, 62, 82,
    4, 28, 52, 78, 5, 34, 64, 97, 32, 67, 6, 46, 90, 35, 83, 34, 87, 45, 6, 70, 38, 11, 88, 70,
    56, 49, 48, 53, 65, 85, 13, 50, 97, 54, 24, 6, 2, 15, 44, 93, 64, 60, 84, 41, 34, 70, 56, 3,
    22, 28, 40, 87, 9, 65, 36, 69];
  function glideSecs(v) {
    const ms = Math.floor((ENVUNITS1[v] * 1000 + ENVUNITS2[v] * 10) / 5);
    return Math.floor(ms / 1000) + "." + String(ms % 1000).padStart(3, "0");
  }
  const glideRate = (v) => glideSecs(v) + " s/oct";

  // Filter cutoff in Hz: the spec's fil_freq() (integer arithmetic, as on the unit).
  function filFreq(input, maxFreq, mul) {
    let f = maxFreq;
    for (let n = 255 - input; n > 0; n--) f = Math.floor((f * mul) / 1024);
    return f;
  }
  // Swept-EQ gain in dB: the spec's cnv_morph_gain().
  function morphGain(input) {
    const g10 = -240 + Math.trunc((input * 120) / 32);
    return (g10 >= 0 ? "+" : "-") + Math.abs(Math.trunc(g10 / 10)) + "." + Math.abs(g10 % 10) + " dB";
  }
  const hz = (f) => (f >= 10000 ? (f / 1000).toFixed(1) + " kHz" : f + " Hz");

  // Filter types in the order the unit's UI lists them. cls picks the meaning
  // of Freq/Q: lp (57-20k), hp (69-18k), bp, eq (83-10k + gain), vow (morph/body),
  // other (raw).
  const FILTERS = [
    [127, "Off", "off"],
    [0, "Classic 4 LPF", "lp"], [1, "Smooth 2 LPF", "lp"], [2, "Steeper 6 LPF", "lp"],
    [132, "MegaSweepz 12 LPF", "other"], [133, "EarlyRizer 12 LPF", "other"],
    [134, "Millennium 12 LPF", "other"], [136, "KlubKlassik 12 LPF", "other"],
    [137, "BassBox-303 12 LPF", "other"],
    [8, "Shallow 2 HPF", "hp"], [9, "Deeper 4 HPF", "hp"],
    [16, "Band-pass1 2 BPF", "bp"], [17, "Band-pass2 4 BPF", "bp"], [18, "ContraBand 6 BPF", "bp"],
    [32, "Swept1oct 6 EQ+", "eq"], [33, "Swept2>1oct 6 EQ+", "eq"], [34, "Swept3>1oct 6 EQ+", "eq"],
    [146, "DJAlkaline 12 EQ+", "other"], [131, "AceOfBass 12 EQ+", "other"],
    [140, "TB-OrNot-TB 12 EQ+", "other"], [142, "BolandBass 12 EQ+", "other"],
    [147, "BassTracer 12 EQ+", "other"], [148, "RogueHertz 12 EQ+", "other"],
    [149, "RazorBlades 12 EQ-", "other"], [150, "RadioCraze 12 EQ-", "other"],
    [80, "Aah-Ay-Eeh 6 VOW", "vow"], [81, "Ooh-To-Aah 6 VOW", "vow"],
    [143, "MultiQVox 12 VOW", "other"], [141, "Ooh-To-Eee 12 VOW", "other"],
    [144, "TalkingHedz 12 VOW", "other"], [151, "Eeh-To-Aah 12 VOW", "other"],
    [152, "UbuOrator 12 VOW", "other"], [153, "DeepBouche 12 VOW", "other"],
    [64, "PhazeShift1 6 PHA", "other"], [65, "PhazeShift2 6 PHA", "other"],
    [154, "FreakShifta 12 PHA", "other"], [155, "CruzPusher 12 PHA", "other"],
    [72, "FlangerLite 6 FLG", "other"], [156, "AngelzHairz 12 FLG", "other"],
    [157, "DreamWeava 12 FLG", "other"],
    [135, "MeatyGizmo 12 REZ", "other"], [139, "DeadRinger 12 REZ", "other"],
    [145, "ZoomPeaks 12 REZ", "other"], [158, "AcidRavage 12 REZ", "other"],
    [159, "BassOMatic 12 REZ", "other"], [160, "LucifersQ 12 REZ", "other"],
    [161, "ToothComb 12 REZ", "other"],
    [162, "EarBender 12 WAH", "other"], [138, "FuzziFace 12 DST", "other"],
    [66, "BlissBatz 6 PHA", "other"], [163, "KlangKling 12 SFX", "other"],
  ];
  const filterClass = (type) => { const f = FILTERS.find((x) => x[0] === type); return f ? f[2] : "other"; };
  // What the Freq and Q knobs mean for a filter type: [freqLabel, qLabel].
  const FILTER_KNOBS = {
    off: ["Freq", "Q"], lp: ["Cutoff", "Resonance"], hp: ["Cutoff", "Resonance"],
    bp: ["Center", "Resonance"], eq: ["Center", "Gain"], vow: ["Morph", "Body size"], other: ["Freq", "Q"],
  };
  function filterFreqFmt(v, ctx) {
    switch (filterClass(ctx[1537])) {
      case "lp": return hz(filFreq(v, 20000, 1002));
      case "hp": return hz(filFreq(v, 18000, 1003));
      case "eq": return hz(filFreq(v, 10000, 1006));
      default: return String(v);
    }
  }
  const filterQFmt = (v, ctx) => (filterClass(ctx[1537]) === "eq" ? morphGain(v) : String(v));

  // Envelope rate when the envelope is tempo-based: note values at the
  // positions the unit labels, plain numbers in between (Edisyn's table).
  const TEMPO_ENV = { 7: "1/64", 12: "1/32t", 14: "1/64d", 19: "1/32", 24: "1/16t", 26: "1/32d",
    31: "1/16", 36: "1/8t", 38: "1/16d", 43: "1/8", 48: "1/4t", 50: "1/8d", 55: "1/4", 60: "1/2t",
    62: "1/4d", 67: "1/2", 72: "1/1t", 74: "1/2d", 79: "1/1", 84: "2/1t", 86: "1/1d", 91: "2/1",
    96: "4/1t", 98: "2/1d", 103: "4/1", 108: "8/1t", 110: "4/1d", 115: "8/1", 120: "16/1t",
    122: "8/1d", 127: "16/1" };

  // Patchcord sources/destinations: raw values are scattered, listed in UI order.
  const LAYER_CORD_SRC = [
    [0, "Off"], [8, "Key +"], [9, "Key ±"], [10, "Vel +"], [11, "Vel ±"], [12, "Vel <"],
    [13, "Release vel"], [14, "Gate"], [16, "Pitch wheel"], [18, "Pressure"], [17, "Mod wheel"],
    [19, "Pedal"], [26, "MIDI volume (7)"], [27, "MIDI pan (10)"],
    [20, "MIDI A"], [21, "MIDI B"], [32, "MIDI C"], [33, "MIDI D"], [34, "MIDI E"], [35, "MIDI F"],
    [36, "MIDI G"], [37, "MIDI H"], [40, "MIDI I"], [41, "MIDI J"], [42, "MIDI K"], [43, "MIDI L"],
    [44, "MIDI M (P2500)"], [45, "MIDI N (P2500)"], [46, "MIDI O (P2500)"], [47, "MIDI P (P2500)"],
    [128, "Preset lag out"], [129, "Preset ramp out"],
    [22, "Footswitch 1"], [24, "Footswitch 1 FF"], [23, "Footswitch 2"], [25, "Footswitch 2 FF"],
    [38, "Footswitch 3"], [39, "Footswitch 3 FF"], [48, "Key glide"],
    [72, "Vol env +"], [73, "Vol env ±"], [74, "Vol env <"],
    [80, "Filter env +"], [81, "Filter env ±"], [82, "Filter env <"],
    [88, "Aux env +"], [89, "Aux env ±"], [90, "Aux env <"],
    [97, "LFO 1 +"], [96, "LFO 1 ±"], [105, "LFO 2 +"], [104, "LFO 2 ±"],
    [98, "White noise"], [99, "Pink noise"], [4, "Crossfade random"],
    [100, "Key random 1"], [101, "Key random 2"],
    [106, "Lag 0 sum"], [107, "Lag 0"], [108, "Lag 1 sum"], [109, "Lag 1"],
    [150, "Clock octal whole"], [151, "Clock quad whole"], [144, "Clock double whole"],
    [145, "Clock whole"], [146, "Clock half"], [147, "Clock quarter"], [148, "Clock 8th"],
    [149, "Clock 16th"],
    [160, "DC"], [161, "Summing amp"], [162, "Switch"], [163, "Absolute value"], [164, "Diode"],
    [165, "Flip-flop"], [166, "Quantizer"], [167, "Gain 4x"],
  ];
  // spec: lists Filter env trigger but no sustain destinations; Edisyn found the
  // sustains on the unit. Both are offered.
  const LAYER_CORD_DST = [
    [0, "Off"], [8, "Key sustain"], [47, "Fine pitch"], [48, "Pitch"], [49, "Glide"],
    [50, "Chorus amount"], [52, "Sample start"], [53, "Sample loop"], [54, "Sample retrigger"],
    [56, "Filter freq"], [57, "Filter res"], [64, "Amp volume"], [65, "Amp pan"],
    [66, "RT crossfade"],
    [72, "Vol env rates"], [73, "Vol env attack"], [74, "Vol env decay"], [76, "Vol env sustain"],
    [75, "Vol env release"],
    [80, "Filter env rates"], [81, "Filter env attack"], [82, "Filter env decay"],
    [84, "Filter env sustain"], [83, "Filter env release"], [86, "Filter env trigger"],
    [88, "Aux env rates"], [89, "Aux env attack"], [90, "Aux env decay"], [92, "Aux env sustain"],
    [91, "Aux env release"], [94, "Aux env trigger"],
    [96, "LFO 1 rate"], [97, "LFO 1 trigger"], [104, "LFO 2 rate"], [105, "LFO 2 trigger"],
    [106, "Lag 0 in"], [108, "Lag 1 in"],
    [161, "Summing amp"], [162, "Switch"], [163, "Absolute value"], [164, "Diode"],
    [165, "Flip-flop"], [166, "Quantize"], [167, "Gain 4x"],
    ...Array.from({ length: 24 }, (_, i) => [168 + i, "Cord " + (i + 1) + " amount"]),
  ];
  const PRESET_CORD_SRC = [
    [0, "Off"], [16, "Pitch wheel"], [17, "Mod wheel"], [18, "Pressure"], [19, "Pedal"],
    [26, "MIDI volume (7)"], [27, "MIDI pan (10)"],
    [20, "MIDI A"], [21, "MIDI B"], [32, "MIDI C"], [33, "MIDI D"], [34, "MIDI E"], [35, "MIDI F"],
    [36, "MIDI G"], [37, "MIDI H"], [40, "MIDI I"], [41, "MIDI J"], [42, "MIDI K"], [43, "MIDI L"],
    [44, "MIDI M (P2500)"], [45, "MIDI N (P2500)"], [46, "MIDI O (P2500)"], [47, "MIDI P (P2500)"],
    [22, "Footswitch 1"], [24, "Footswitch 1 FF"], [23, "Footswitch 2"], [25, "Footswitch 2 FF"],
    [160, "DC"],
  ];
  const PRESET_CORD_DST = [
    [0, "Off"], [1, "FX A send 1"], [2, "FX A send 2"], [3, "FX A send 3"], [4, "FX A send 4"],
    [5, "FX B send 1"], [6, "FX B send 2"], [7, "FX B send 3"], [8, "FX B send 4"],
    [96, "Arp rate"], [97, "Arp extension"], [98, "Arp velocity"], [99, "Arp gate"],
    [100, "Arp interval"],
    [112, "Beats vel group 1"], [113, "Beats vel group 2"], [114, "Beats vel group 3"],
    [115, "Beats vel group 4"], [116, "Beats xpose group 1"], [117, "Beats xpose group 2"],
    [118, "Beats xpose group 3"], [119, "Beats xpose group 4"], [120, "Beats busy"],
    [121, "Beats variation"],
    [128, "Preset lag in"], [129, "Preset lag amount"], [131, "Preset ramp rate"],
  ];

  const list = (arr, first = 0) => arr.map((s, i) => [i + first, s]);
  const FX_A = list(["Master FX A", "Room 1", "Room 2", "Room 3", "Hall 1", "Hall 2", "Plate", "Delay",
    "Panning Delay", "Multitap 1", "Multitap Pan", "3 Tap", "3 Tap Pan", "Soft Room", "Warm Room",
    "Perfect Room", "Tiled Room", "Hard Plate", "Warm Hall", "Spacious Hall", "Bright Hall",
    "Bright Hall Pan", "Bright Plate", "BBall Court", "Gymnasium", "Cavern", "Concert 9",
    "Concert 10 Pan", "Reverse Gate", "Gate 2", "Gate Pan", "Concert 11", "Medium Concert",
    "Large Concert", "Large Concert Pan", "Canyon", "DelayVerb 1", "DelayVerb 2", "DelayVerb 3",
    "DelayVerb 4 Pan", "DelayVerb 5 Pan", "DelayVerb 6", "DelayVerb 7", "DelayVerb 8", "DelayVerb 9"]);
  const FX_B = list(["Master FX B", "Chorus 1", "Chorus 2", "Chorus 3", "Chorus 4", "Chorus 5",
    "Doubling", "Slapback", "Flange 1", "Flange 2", "Flange 3", "Flange 4", "Flange 5", "Flange 6",
    "Flange 7", "Big Chorus", "Symphonic", "Ensemble", "Delay", "Delay Stereo", "Delay Stereo 2",
    "Panning Delay", "Delay Chorus", "Pan Delay Chorus 1", "Pan Delay Chorus 2", "Dual Tap 1/3",
    "Dual Tap 1/4", "Vibrato", "Distortion 1", "Distortion 2", "Distorted Flange",
    "Distorted Chorus", "Distorted Double"]);
  // spec: 0..127; the unit also takes -12..-1 as tempo-synced delays (Edisyn).
  const FX_DELAY_SYNC = ["1/4d", "1/2t", "1/4", "1/8d", "1/4t", "1/8", "1/16d", "1/8t", "1/16",
    "1/32d", "1/16t", "1/32"];
  const fxDelay = (v) => (v < 0 ? FX_DELAY_SYNC[v + 12] || String(v) : v * 5 + " ms");

  const ARP_MODES = list(["Up", "Down", "Up/Down", "Forward assign", "Backward assign",
    "Fwd/bkwd assign", "Random", "Pattern"]);
  // spec: 0..19; the unit uses 1..19 (Edisyn).
  const ARP_NOTES = list(["1/32", "1/16t", "1/32d", "1/16", "1/8t", "1/16d", "1/8", "1/4t", "1/8d",
    "1/4", "1/2t", "1/4d", "1/2", "1/1t", "1/2d", "1/1", "2/1t", "1/1d", "2/1"], 1);
  const ARP_DURATIONS = list(["Off", "1/32", "1/16t", "1/32d", "1/16", "1/8t", "1/16d", "1/8", "1/4t",
    "1/8d", "1/4", "1/2t", "1/4d", "1/2", "1/1t", "1/2d", "1/1", "2/1t", "1/1d", "2/1"]);
  // Keyboard tunings in the manual's (and spec's) order.
  const KBD_TUNINGS = list(["Equal temperament", "Just C", "Vallotti", "19-Tone", "Gamelan",
    "Just C2", "Just C-minor", "Just C3", "Werkmeister III", "Kirnberger", "Scarlatti",
    "Repeating octave", ...Array.from({ length: 12 }, (_, i) => "User " + (i + 1))]);
  const LFO_SHAPES = list(["Random", "Triangle", "Sine", "Sawtooth", "Square", "33% pulse",
    "25% pulse", "16% pulse", "12% pulse", "Pat: octaves", "Pat: 5th + oct", "Pat: sus4 trip",
    "Pat: neener", "Sine 1,2", "Sine 1,3,5", "Sine + noise", "Hemiquaver"], -1);
  const SOLO = list(["Off", "Multiple trigger", "Melody (last)", "Melody (low)", "Melody (high)",
    "Synth (last)", "Synth (low)", "Synth (high)", "Fingered glide"]);
  const GROUPS = list(["Poly all", "Poly 16 A", "Poly 16 B", "Poly 8 A", "Poly 8 B", "Poly 8 C",
    "Poly 8 D", "Poly 4 A", "Poly 4 B", "Poly 4 C", "Poly 4 D", "Poly 2 A", "Poly 2 B", "Poly 2 C",
    "Poly 2 D", "Mono A", "Mono B", "Mono C", "Mono D", "Mono E", "Mono F", "Mono G", "Mono H",
    "Mono I"]);
  const OFF_ON = [[0, "Off"], [1, "On"]];

  /* ----------------------------- params ---------------------------------- */
  const PARAMS = {};
  const def = (id, label, min, max, extra) => {
    PARAMS[id] = Object.assign({ id, label, min, max }, extra || {});
  };
  const opts = (o) => ({ opts: o });

  // Preset common: initial controller amounts. spec: -1 = "current value"; the unit shows Off.
  const ctrlFmt = { fmt: (v) => (v < 0 ? "Off" : String(v)) };
  "ABCDEFGH".split("").forEach((c, i) => def(915 + i, "Ctrl " + c, -1, 127, ctrlFmt));
  "IJKL".split("").forEach((c, i) => def(924 + i, "Ctrl " + c, -1, 127, ctrlFmt));
  "MNOP".split("").forEach((c, i) => def(967 + i, "Ctrl " + c, -1, 127, ctrlFmt));
  def(923, "Keyboard tuning", 0, 23, opts(KBD_TUNINGS));
  def(928, "Riff", -1, 1023, { fmt: (v) => (v < 0 ? "Off" : String(v)) });
  def(929, "Riff ROM", 0, 255);
  // spec: 0..4 (x1/4..x4); the unit has three settings, -1..+1 (manual, Edisyn, prodatum).
  def(930, "Tempo offset", -1, 1, opts([[-1, "½ × tempo"], [0, "Current tempo"], [1, "2 × tempo"]]));
  for (let c = 0; c < 12; c++) {
    def(931 + c * 3, "Cord " + (c + 1) + " source", 0, 255, opts(PRESET_CORD_SRC));
    def(932 + c * 3, "Cord " + (c + 1) + " destination", 0, 255, opts(PRESET_CORD_DST));
    def(933 + c * 3, "Cord " + (c + 1) + " amount", -100, 100, { fmt: signed });
  }

  // Preset arpeggiator
  def(1025, "Arp", 0, 1, opts(OFF_ON));
  def(1026, "Mode", 0, 7, opts(ARP_MODES));
  def(1027, "Pattern", 0, 299);
  def(1028, "Note value", 1, 19, opts(ARP_NOTES));
  def(1029, "Velocity", 0, 127, { fmt: (v) => (v === 0 ? "As played" : String(v)) });
  def(1030, "Gate time", 1, 100, { fmt: pct });
  def(1031, "Extension count", 0, 15);
  def(1032, "Extension interval", 1, 16);
  def(1033, "Sync", 0, 1, opts([[0, "Key sync"], [1, "Quantized"]]));
  def(1034, "Pre-delay", 0, 19, opts(ARP_DURATIONS));
  def(1035, "Duration", 0, 19, opts(ARP_DURATIONS));
  // spec: 0..1; the unit has a third setting (Edisyn).
  def(1036, "Recycle", 0, 2, opts([[0, "Off"], [1, "On"], [2, "On, no pre-delay"]]));
  def(1037, "Keyboard thru", 0, 1, opts(OFF_ON));
  def(1038, "Latch", 0, 1, opts(OFF_ON));
  def(1039, "Key low", 0, 127, { fmt: noteName });
  def(1040, "Key high", 0, 127, { fmt: noteName });
  def(1041, "Pattern speed", -2, 2, opts([[-2, "4×"], [-1, "2×"], [0, "1×"], [1, "½×"], [2, "¼×"]]));
  def(1042, "Pattern ROM", 0, 255);
  def(1043, "Post-delay", 0, 19, opts(ARP_DURATIONS));

  // Preset effects. Sends: 1157-1159 + 1167 for A, 1164-1166 + 1168 for B (sic).
  def(1153, "FX A", 0, 44, opts(FX_A));
  def(1154, "Decay", 0, 90);
  def(1155, "HF damping", 0, 127);
  def(1156, "FX B → A", 0, 127);
  def(1157, "Send 1", 0, 100, { fmt: pct });
  def(1158, "Send 2", 0, 100, { fmt: pct });
  def(1159, "Send 3", 0, 100, { fmt: pct });
  def(1167, "Send 4", 0, 100, { fmt: pct });
  def(1160, "FX B", 0, 32, opts(FX_B));
  def(1161, "Feedback", 0, 127);
  def(1162, "LFO rate", 0, 127);
  def(1163, "Delay", -12, 127, { fmt: fxDelay });
  def(1164, "Send 1", 0, 100, { fmt: pct });
  def(1165, "Send 2", 0, 100, { fmt: pct });
  def(1166, "Send 3", 0, 100, { fmt: pct });
  def(1168, "Send 4", 0, 100, { fmt: pct });

  // Preset links (1281.. link 1, 1290.. link 2; ROM ids at 1299/1300)
  for (let k = 0; k < 2; k++) {
    const b = 1281 + k * 9, n = "Link " + (k + 1) + " ";
    def(b, n + "preset", -1, 1023, { fmt: (v) => (v < 0 ? "Off" : String(v)) });
    def(b + 1, "Volume", -96, 10, { fmt: db });
    // spec: -64..+64; the unit does -64..+63 (Edisyn)
    def(b + 2, "Pan", -64, 63, { fmt: pan });
    def(b + 3, "Transpose", -24, 24, { fmt: signed });
    // spec: -19..; the unit's delays go down to -25 like the LFO (Edisyn)
    def(b + 4, "Delay", -25, 127, { fmt: tempoOr(String) });
    def(b + 5, "Key low", 0, 127, { fmt: noteName });
    def(b + 6, "Key high", 0, 127, { fmt: noteName });
    def(b + 7, "Vel low", 0, 127);
    def(b + 8, "Vel high", 0, 127);
    def(1299 + k, n + "ROM", 0, 255);
  }

  // Layer general
  def(1409, "Instrument", 0, 4095);
  def(1410, "Volume", -96, 10, { fmt: db });
  def(1411, "Pan", -64, 63, { fmt: pan });
  def(1412, "Submix", 0, 2, opts([[0, "Main"], [1, "Sub 1"], [2, "Sub 2"]]));
  def(1413, "Key low", 0, 127, { fmt: noteName });
  def(1414, "Key low fade", 0, 127);
  def(1415, "Key high", 0, 127, { fmt: noteName });
  def(1416, "Key high fade", 0, 127);
  def(1417, "Vel low", 0, 127);
  def(1418, "Vel low fade", 0, 127);
  def(1419, "Vel high", 0, 127);
  def(1420, "Vel high fade", 0, 127);
  def(1421, "RT low", 0, 127);
  def(1422, "RT low fade", 0, 127);
  def(1423, "RT high", 0, 127);
  def(1424, "RT high fade", 0, 127);
  def(1425, "Coarse tune", -36, 36, { fmt: signed });
  // spec: -64..+64; the unit does -63..+63 (Edisyn)
  def(1426, "Fine tune", -63, 63, { fmt: signed });
  def(1427, "Chorus", 0, 100, { fmt: (v) => (v === 0 ? "Off" : v + "%") });
  def(1428, "Chorus width", 0, 100, { fmt: pct });
  def(1429, "Transpose", -36, 36, { fmt: signed });
  def(1430, "Non-transpose", 0, 1, opts(OFF_ON));
  def(1431, "Bend range", -1, 12, { fmt: (v) => (v < 0 ? "Master" : "±" + v) });
  def(1432, "Glide rate", 0, 127, { fmt: glideRate });
  def(1433, "Glide curve", 0, 8, opts(list(["Linear", "Exp 1", "Exp 2", "Exp 3", "Exp 4", "Exp 5",
    "Exp 6", "Exp 7", "Exp 8"])));
  def(1434, "Loop", 0, 1, opts(OFF_ON));
  def(1435, "Sound delay", -25, 127, { fmt: tempoOr(String) });
  def(1436, "Sound start", 0, 127);
  def(1437, "Solo", 0, 8, opts(SOLO));
  def(1438, "Assign group", 0, 23, opts(GROUPS));
  def(1439, "Instrument ROM", 0, 255);

  // Layer filter
  def(1537, "Filter type", 0, 255, opts(FILTERS.map((f) => [f[0], f[1]])));
  def(1538, "Freq", 0, 255, { fmt: filterFreqFmt });
  def(1539, "Q", 0, 127, { fmt: filterQFmt });

  // Layer LFOs
  for (let k = 0; k < 2; k++) {
    const b = 1665 + k * 5;
    def(b, "Rate", -25, 127, { fmt: lfoRate });
    def(b + 1, "Shape", -1, 15, opts(LFO_SHAPES));    // spec: LFO 2 0..3; it has all shapes
    def(b + 2, "Delay", -25, 127, { fmt: tempoOr(String) });
    def(b + 3, "Variation", 0, 100, { fmt: pct });
    def(b + 4, "Sync", 0, 1, opts([[0, "Key sync"], [1, "Free run"]]));
  }

  // Layer envelopes. Stage pairs (rate, level) in id order A1 D1 R1 A2 D2 R2.
  const ENVS = [
    { key: "vol", label: "Volume envelope", mode: 1793, base: 1794, levelMin: 0, repeat: null },
    { key: "filter", label: "Filter envelope", mode: 1806, base: 1807, levelMin: -100, repeat: 1833 },
    { key: "aux", label: "Aux envelope", mode: 1819, base: 1820, levelMin: -100, repeat: 1834 },
  ];
  const STAGES = ["Attack 1", "Decay 1", "Release 1", "Attack 2", "Decay 2", "Release 2"];
  // Time order of the stages (indices into STAGES).
  const STAGE_TIME_ORDER = [0, 3, 1, 4, 2, 5];
  ENVS.forEach((e) => {
    // Mode 2 is tempo-based for all three envelopes.
    const rateFmt = (v, ctx) => (ctx[e.mode] === 2 ? TEMPO_ENV[v] || String(v) : String(v));
    def(e.mode, "Mode", e.key === "vol" ? 0 : 1, 2,
      opts(e.key === "vol" ? [[0, "Factory"], [1, "Time"], [2, "Tempo"]] : [[1, "Time"], [2, "Tempo"]]));
    STAGES.forEach((s, i) => {
      def(e.base + i * 2, s + " rate", 0, 127, { fmt: rateFmt });
      def(e.base + i * 2 + 1, s + " level", e.levelMin, 100, { fmt: pct });
    });
    if (e.repeat) def(e.repeat, "Repeat", 0, 1, opts(OFF_ON));
  });

  // Layer patchcords
  for (let c = 0; c < 24; c++) {
    def(1921 + c * 3, "Cord " + (c + 1) + " source", 0, 255, opts(LAYER_CORD_SRC));
    def(1922 + c * 3, "Cord " + (c + 1) + " destination", 0, 255, opts(LAYER_CORD_DST));
    def(1923 + c * 3, "Cord " + (c + 1) + " amount", -100, 100, { fmt: signed });
  }

  /* --------------------- setup: multimode, master, beats ------------------- */
  // MIDI channels 0..31 are 1A..16A, 1B..16B (the P2K's two MIDI inputs).
  const chName = (v) => (v % 16) + 1 + (v < 16 ? "A" : "B");
  const channelOr = (none) => (v) => (v < 0 ? none : chName(v));

  // Per channel; MULTIMODE_CHANNEL_SELECT (129) picks the channel.
  def(130, "Preset", 0, 1023);
  def(131, "Volume", 0, 127);
  def(132, "Pan", 0, 127, { fmt: (v) => pan(v - 64) });       // 0 = 64L, 64 = center, 127 = 63R
  def(133, "Output", -1, 2, opts([[-1, "Preset"], [0, "Main"], [1, "Sub 1"], [2, "Sub 2"]]));
  def(134, "Arp", -2, 1, opts([[-2, "Off"], [-1, "On"], [0, "Preset"], [1, "Master"]]));
  def(135, "Enabled", 0, 1, opts(OFF_ON));
  def(137, "Program change", 0, 1, opts(OFF_ON));
  def(138, "ROM", 0, 255);
  // Not per channel.
  def(139, "Basic channel", 0, 31, { fmt: chName });
  def(140, "FX control channel", -1, 31, { fmt: channelOr("Master FX") });
  def(141, "Tempo control channel", 0, 31, { fmt: chName });

  // Master general
  def(257, "Tempo", 0, 300, { fmt: (v) => (v === 0 ? "MIDI clock" : v + " bpm") });
  def(258, "FX bypass", 0, 1, opts(OFF_ON));
  def(259, "Transpose", -12, 12, { fmt: (v) => signed(v) + " st" });
  def(260, "Tune", -63, 63, { fmt: (v) => (v > 0 ? "+" : "") + (v * 100 / 64).toFixed(1) + " ct" });
  def(264, "Bend range", 0, 12, { fmt: (v) => "±" + v });
  def(265, "Velocity curve", 0, 13, { fmt: (v) => (v === 0 ? "Linear" : "Curve " + v) });
  def(266, "Output format", 1, 2, opts([[1, "S/PDIF"], [2, "AES Pro"]]));
  def(267, "Knob quick edit", 0, 1, opts(OFF_ON));
  def(268, "Knob deep edit", 0, 1, opts(OFF_ON));
  def(269, "Edit all layers", 0, 1, opts(OFF_ON));
  def(270, "Demo mode", 0, 1, opts(OFF_ON));

  // Beats (in the master section on firmware that has them)
  def(271, "Beats", 0, 3, opts([[0, "Off"], [1, "On"], [2, "With bts presets"], [3, "Master riff"]]));
  def(272, "Beats channel", -1, 31, { fmt: channelOr("Basic") });
  def(273, "Trigger channel", -1, 31, { fmt: channelOr("Basic") });
  def(274, "Trigger offset", -127, 127, { fmt: (v) => signed(v) + " keys" });
  // The manual's "Riff tempo" / "Riff controllers" screens; the spec calls them "ignore".
  def(275, "Riff tempo", 0, 1, opts([[0, "Use riff tempo"], [1, "Use current tempo"]]));
  def(276, "Riff controllers", 0, 1, opts([[0, "Use riff controllers"], [1, "Ignore them"]]));
  def(277, "Master riff ROM", 0, 255);
  def(278, "Master riff", 0, 1023);
  // Per trigger (LAYER_SELECT 898 = 0..23) and per part (898 = 0..15).
  def(160, "Key", 0, 127, { fmt: noteName });
  def(161, "Latch", 0, 2, opts([[0, "Unlatched"], [1, "Latched"], [2, "1 bar"]]));
  def(164, "Velocity", -1, 127, { fmt: (v) => (v < 0 ? "Trigger vel" : v + "%") });
  def(165, "Transpose", -36, 36, { fmt: signed });
  def(166, "Group", 0, 4, opts([[0, "None"], [1, "Group 1"], [2, "Group 2"], [3, "Group 3"], [4, "Group 4"]]));
  const BEATS_TRIGGERS = ["Kick 1", "Snare 1", "Hihat 1", "Bass", "Kick 2", "Snare 2", "Hihat 2", "Perc 2",
    "Perc 3 / Fill 1", "Perc 4 / Fill 2", "Perc 5 / Fill 3", "Perc 6 / Fill 4", "Inst 1 / Wild 1",
    "Inst 2 / Wild 2", "Inst 3 / Wild 3", "Inst 4 / Wild 4", "Group 1", "Group 2", "Group 3", "Group 4",
    "Start/stop", "Clear parts", "Mute", "Trigger hold"];

  // Master MIDI
  def(385, "MIDI mode", 0, 2, opts([[0, "Omni"], [1, "Poly"], [2, "Multi"]]));
  def(386, "Mode change", 0, 1, opts([[0, "Ignore"], [1, "Accept"]]));
  def(388, "SysEx ID", 0, 126);
  "ABCDEFGH".split("").forEach((c, i) => def(391 + i, "Knob " + c, 0, 31, { fmt: (v) => "CC " + v }));
  "IJKL".split("").forEach((c, i) => def(406 + i, "Knob " + c, 70, 95, { fmt: (v) => "CC " + v }));
  [1, 2, 3].forEach((n, i) => def(399 + i, "Footswitch " + n, 64, 79, { fmt: (v) => "CC " + v }));
  const tempoCtl = { fmt: (v) => (v === -3 ? "Off" : v === -2 ? "Mono pressure" : v === -1 ? "Pitch wheel" : "CC " + v) };
  def(402, "Tempo up", -3, 31, tempoCtl);
  def(403, "Tempo down", -3, 31, tempoCtl);
  def(404, "Knobs MIDI out", 0, 1, opts(OFF_ON));
  def(405, "SysEx packet delay", 0, 1000, { fmt: (v) => v + " ms" });

  // Master effects and arpeggiator: the preset's parameters at other ids, without "Master".
  const mirror = (from, to, extra) => { PARAMS[to] = Object.assign({}, PARAMS[from], { id: to }, extra || {}); };
  for (let i = 0; i < 16; i++) mirror(1153 + i, 513 + i);
  mirror(1153, 513, { min: 1, opts: FX_A.slice(1) });
  mirror(1160, 520, { min: 1, opts: FX_B.slice(1) });
  for (let i = 0; i < 16; i++) mirror(1025 + i, 641 + i);   // status .. key high
  mirror(1041, 659);                                           // pattern speed
  mirror(1042, 660);                                           // pattern ROM
  mirror(1043, 661);                                           // post-delay
  const ARP_OUT = [[0, "Off"], [1, "Arps"], [2, "Riffs"], [3, "Arps & riffs"]];
  def(657, "MIDI out", 0, 3, opts(ARP_OUT));
  def(658, "Song start resyncs", 0, 3, opts(ARP_OUT));

  const isLayerParam = (id) => id >= 1408;

  // Display string for a raw value.
  function format(id, v, ctx) {
    const p = PARAMS[id];
    if (!p) return String(v);
    if (p.opts) {
      const o = p.opts.find((x) => x[0] === v);
      return o ? o[1] : "(" + v + ")";
    }
    return p.fmt ? p.fmt(v, ctx || {}) : String(v);
  }

  // ROM catalogue: P2K_ROMS (p2k-roms.js) keyed by ROM id, plus user memory.
  const romById = (id) => (typeof P2K_ROMS !== "undefined" ? P2K_ROMS.find((r) => r.msb === id) : null);
  const romLabel = (id) => {
    if (id === 0) return "User";
    const r = romById(id);
    return r ? r.name.replace(/ \(.*\)$/, "") + " (" + r.id + ")" : "ROM " + id;
  };
  const presetName = (romId, number) => {
    const r = romById(romId);
    if (!r) return "";
    const b = r.banks[number >> 7];
    return (b && b[number & 127]) || "";
  };
  const instrumentName = (romId, n) => { const r = romById(romId); return (r && r.instruments && r.instruments[n]) || ""; };
  const riffName = (romId, n) => { const r = romById(romId); return (r && r.riffs && r.riffs[n]) || ""; };
  const arpName = (romId, n) => { const r = romById(romId); return (r && r.arps && r.arps[n]) || ""; };

  // E-MU's default preset ("   :untitled"), as dumped by a P2K (from Edisyn).
  const INIT_SYX = [
    "F0 18 0F 00 55 10 03 00 00 56 0B 00 00 34 00 13 00 10 00 14 00 04 00 1F 00 03 00 0A 00 2A 00 48 00 00 00 F7 F0 18 0F 00 55 10 04 01 00 20 20 20 3A 75 6E 74 69 74 6C 65 64 20 20 20 20 7F 00 00",
    "00 00 00 7F 00 00 00 00 00 00 00 00 00 00 00 18 00 00 00 05 00 00 00 00 00 04 00 00 00 2A 00 01 00 64 00 2A 00 02 00 00 00 2A 00 03 00 00 00 2A 00 04 00 00 00 2B 00 05 00 64 00 2B 00 06 00 00",
    "00 2B 00 07 00 00 00 2B 00 08 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 0A 00 00 00 64 00 00 00 01 00 00 00 00 00 00 00 00 00 00 00 00",
    "00 00 00 7F 00 00 00 04 00 00 00 0E 00 30 00 40 00 00 00 00 00 00 00 00 00 01 00 00 00 03 00 00 00 00 00 00 00 00 00 00 00 00 00 7F 7F 00 00 00 00 00 00 00 00 00 00 7F 00 00 00 7F 00 7F 7F 00",
    "00 00 00 00 00 00 00 00 00 7F 00 00 00 7F 00 04 00 04 00 00 00 00 00 00 00 00 00 00 00 00 00 7F 00 2A F7 F0 18 0F 00 55 10 04 02 00 00 00 00 00 00 00 7F 00 00 00 00 00 00 00 7F 00 00 00 00 00",
    "00 00 00 00 00 00 00 00 00 00 02 00 00 00 00 00 01 00 00 00 00 00 00 00 00 00 04 00 00 00 00 00 00 00 40 00 00 00 00 00 00 00 00 00 09 00 00 00 00 00 00 00 01 00 00 00 00 00 64 00 00 00 64 00",
    "03 00 00 00 00 00 64 00 7F 00 64 00 00 00 00 00 01 00 00 00 64 00 00 00 64 00 00 00 00 00 00 00 64 00 00 00 00 00 00 00 00 00 01 00 00 00 00 00 00 00 63 00 14 00 00 00 00 00 64 00 00 00 64 00",
    "00 00 00 00 00 00 00 00 00 00 11 00 29 01 06 00 60 00 30 00 00 00 16 00 08 00 64 00 14 00 38 00 64 00 15 00 39 00 50 00 20 00 2E 01 64 00 51 00 38 00 00 00 21 00 00 00 4E 00 22 00 49 00 50 7F",
    "23 00 4B 00 4E 7F 24 00 33 01 64 00 68 00 41 00 00 00 25 00 68 00 0C 00 28 00 36 01 50 00 0C 00 37 F7 F0 18 0F 00 55 10 04 03 00 40 00 00 00 29 00 38 01 64 00 0B 00 38 00 00 00 08 00 38 00 00",
    "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 20 7F 00 00 00 00 00 00 00 00 7F 00 00 00 00 00 00 00 7F 00 00 00 00 00 00",
    "00 7F 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 02 00 00 00 00 00 01 00 00 00 00 00 00 00 00 00 04 00 00 00 00 00 00 00 40 00 00 00 00 00 00 00 00 00 09 00 00 00 00 00 00 00 01 00 00 00 00",
    "00 64 00 00 00 64 00 03 00 00 00 00 00 64 00 7F 00 64 00 00 00 00 00 01 00 00 00 64 00 00 00 64 00 00 00 00 00 00 00 64 00 00 00 00 00 00 00 00 00 01 00 00 00 00 00 00 00 63 00 14 00 00 00 00",
    "00 64 00 00 00 64 00 00 00 00 00 00 00 00 00 00 00 11 00 29 01 06 00 60 00 30 00 00 00 16 00 23 F7 F0 18 0F 00 55 10 04 04 00 08 00 64 00 14 00 38 00 64 00 15 00 39 00 50 00 20 00 2E 01 64 00",
    "51 00 38 00 00 00 21 00 40 00 4E 00 22 00 49 00 50 7F 23 00 4B 00 4E 7F 24 00 33 01 64 00 68 00 41 00 00 00 25 00 68 00 0C 00 28 00 36 01 50 00 0C 00 40 00 00 00 29 00 38 01 64 00 0B 00 38 00",
    "00 00 08 00 38 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 20 7F 00 00 00 00 00 00 00 00 7F 00 00 00 00 00 00 00",
    "7F 00 00 00 00 00 00 00 7F 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 02 00 00 00 00 00 01 00 00 00 00 00 00 00 00 00 04 00 00 00 00 00 00 00 40 00 00 00 00 00 00 00 00 00 09 00 00 00 00 00",
    "00 00 01 00 00 00 00 00 64 00 00 00 64 00 03 00 00 00 00 00 64 00 7F 00 64 00 00 00 00 00 24 F7 F0 18 0F 00 55 10 04 05 00 01 00 00 00 64 00 00 00 64 00 00 00 00 00 00 00 64 00 00 00 00 00 00",
    "00 00 00 01 00 00 00 00 00 00 00 63 00 14 00 00 00 00 00 64 00 00 00 64 00 00 00 00 00 00 00 00 00 00 00 11 00 29 01 06 00 60 00 30 00 00 00 16 00 08 00 64 00 14 00 38 00 64 00 15 00 39 00 50",
    "00 20 00 2E 01 64 00 51 00 38 00 00 00 21 00 40 00 4E 00 22 00 49 00 50 7F 23 00 4B 00 4E 7F 24 00 33 01 64 00 68 00 41 00 00 00 25 00 68 00 0C 00 28 00 36 01 50 00 0C 00 40 00 00 00 29 00 38",
    "01 64 00 0B 00 38 00 00 00 08 00 38 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 20 7F 00 00 00 00 00 00 00 00 7F",
    "00 00 00 00 00 00 00 7F 00 00 00 00 00 00 00 7F 00 00 00 00 00 00 00 00 00 00 00 00 00 33 F7 F0 18 0F 00 55 10 04 06 00 00 00 02 00 00 00 00 00 01 00 00 00 00 00 00 00 00 00 04 00 00 00 00 00",
    "00 00 40 00 00 00 00 00 00 00 00 00 09 00 00 00 00 00 00 00 01 00 00 00 00 00 64 00 00 00 64 00 03 00 00 00 00 00 64 00 7F 00 64 00 00 00 00 00 01 00 00 00 64 00 00 00 64 00 00 00 00 00 00 00",
    "64 00 00 00 00 00 00 00 00 00 01 00 00 00 00 00 00 00 63 00 14 00 00 00 00 00 64 00 00 00 64 00 00 00 00 00 00 00 00 00 00 00 11 00 29 01 06 00 60 00 30 00 00 00 16 00 08 00 64 00 14 00 38 00",
    "64 00 15 00 39 00 50 00 20 00 2E 01 64 00 51 00 38 00 00 00 21 00 40 00 4E 00 22 00 49 00 50 7F 23 00 4B 00 4E 7F 24 00 33 01 64 00 68 00 41 00 00 00 25 00 68 00 0C 00 28 00 36 01 50 00 0C 00",
    "40 00 00 00 29 00 38 01 64 00 0B 00 38 00 00 00 08 00 38 00 00 00 00 00 00 00 00 00 6C F7 F0 18 0F 00 55 10 04 07 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
    "00 00 00 00 00 7F F7",
  ].join(" ");

  return {
    NOTES, noteName, signed, pan, db, TEMPO_DIVS, LFO_HZ, glideSecs, filFreq, morphGain,
    FILTERS, FILTER_KNOBS, filterClass, TEMPO_ENV, LAYER_CORD_SRC, LAYER_CORD_DST, PRESET_CORD_SRC,
    PRESET_CORD_DST, FX_A, FX_B, ARP_MODES, ARP_NOTES, ARP_DURATIONS, KBD_TUNINGS, LFO_SHAPES,
    ENVS, STAGES, STAGE_TIME_ORDER, PARAMS, isLayerParam, format, chName, BEATS_TRIGGERS,
    romById, romLabel, presetName, instrumentName, riffName, arpName, INIT_SYX,
  };
})();
