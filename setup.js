"use strict";
/* ============================================================================
 * setup — the Setup tab: the P2K's current multisetup.
 *
 *   All 32 MIDI channels (preset, volume, pan, output, arp, enable, program
 *   change), master settings, master effects (what presets set to "Master FX"
 *   use), master arpeggiator, MIDI controller assignments, and Beats.
 *
 *   Get reads the setup dump (P2KC.decodeSetup checks its layout against the
 *   unit's SysEx ID). The Beats trigger layout isn't in the dump: it's read with
 *   parameter requests, one trigger/part at a time (LAYER_SELECT picks it), and
 *   hidden if the unit doesn't answer them. Every change goes out at once as a
 *   parameter edit, after MULTIMODE_CHANNEL_SELECT (129) or LAYER_SELECT (898)
 *   where needed (Midi.select, shared with the editor). Save/Load copy between
 *   the current setup and the 128 stored ones (Copy Setup, 2Ch).
 * ==========================================================================*/
const Setup = (() => {
  const $ = (id) => document.getElementById(id);
  const D = P2KD, C = P2KC, P = P2KD.PARAMS;
  const { el, card, cells, sub, fillSelect } = UI;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ID = { MM_CHANNEL: 129, LAYER_SELECT: 898, NAME: 142, SYSEX_ID: 388, BASIC_CHANNEL: 139 };
  const SETUPS = 128;

  const S = {
    setup: null,          // P2KC.decodeSetup() result
    beats: null,          // { triggers: [{160, 161}] x24, parts: [{164, 165, 166}] x16 }
    beatsState: "none",   // "none" | "reading" | "ok" | "unanswered"
    busy: false,
    showB: false,         // channels 1B-16B too
  };

  /* --------------------------- setup names ------------------------------ */
  const NAMES_KEY = "sea-change:setup-names";
  let names = (() => {
    try {
      const a = JSON.parse(localStorage.getItem(NAMES_KEY));
      return Array.isArray(a) && a.length === SETUPS ? a : Array(SETUPS).fill("");
    } catch { return Array(SETUPS).fill(""); }
  })();
  const saveNames = () => { try { localStorage.setItem(NAMES_KEY, JSON.stringify(names)); } catch { /* not remembered */ } };
  const setupLabel = (n) => String(n).padStart(3, "0") + "  " + (names[n] ? names[n].trim() : "");

  /* ------------------------------ model --------------------------------- */
  const has = (id) => S.setup && S.setup.common[id] !== undefined;
  const hasBeats = () => has(271);

  function clampTo(id, v) {
    const d = P[id];
    v = Math.round(v);
    return d ? clamp(v, d.min, d.max) : v;
  }

  function setCommon(id, v) {
    v = clampTo(id, v);
    if (S.setup.common[id] === v) return;
    S.setup.common[id] = v;
    Midi.enqueue(() => [C.paramEdit(Midi.devId, [[id, v]])], { key: "s:" + id, gap: 20 });
    if (id === ID.BASIC_CHANNEL) document.dispatchEvent(new CustomEvent("p2k:setup-changed"));
    scheduleRepaint();
  }

  function setChannel(ch, id, v) {
    v = clampTo(id, v);
    const p = S.setup.channels[ch];
    if (p[id] === v) return;
    p[id] = v;
    if (id === 138) {
      // Another ROM may have fewer presets than the number the channel is on.
      const rom = D.romById(v);
      p[130] = Math.min(p[130], v === 0 ? 511 : rom ? rom.banks.length * 128 - 1 : p[130]);
    }
    if (id === 130 || id === 138) {
      selectPreset(ch);
    } else {
      Midi.enqueue(() => [...Midi.select(ID.MM_CHANNEL, ch), C.paramEdit(Midi.devId, [[id, v]])],
        { key: "c" + ch + ":" + id, gap: 20 });
    }
    scheduleRepaint();
  }

  // A channel's preset. On the first 16 channels with program changes on, the
  // way the Presets tab does it (bank select + program change); otherwise as
  // multimode parameter edits.
  function selectPreset(ch) {
    const p = S.setup.channels[ch], rom = p[138], number = p[130];
    if (ch < 16 && p[137]) {
      Midi.sendNow([0xb0 | ch, 0, rom]);
      Midi.sendNow([0xb0 | ch, 32, number >> 7]);
      Midi.sendNow([0xc0 | ch, number & 127]);
    } else {
      Midi.enqueue(() => [...Midi.select(ID.MM_CHANNEL, ch),
        C.paramEdit(Midi.devId, [[138, rom]]), C.paramEdit(Midi.devId, [[130, number]])],
        { key: "c" + ch + ":preset", gap: 30 });
    }
    if (ch === Midi.channel) {
      const name = rom === 0 ? UserNames.get(number) : D.presetName(rom, number);
      Presets.markActive(rom, number);
      document.dispatchEvent(new CustomEvent("p2k:preset-selected", { detail: { romId: rom, number, name } }));
    }
  }

  function setBeat(kind, idx, id, v) {
    v = clampTo(id, v);
    const p = S.beats[kind][idx];
    if (p[id] === v) return;
    p[id] = v;
    Midi.enqueue(() => [...Midi.select(ID.LAYER_SELECT, idx), C.paramEdit(Midi.devId, [[id, v]])],
      { key: "b" + kind + idx + ":" + id, gap: 20 });
    scheduleRepaint();
  }

  // The setup name is 16 single-character params.
  function setName(name) {
    name = name.replace(/[^\x20-\x7e]/g, " ").padEnd(16).slice(0, 16);
    const old = S.setup.name;
    if (old === name) return;
    S.setup.name = name;
    for (let i = 0; i < 16; i++) {
      if (old[i] === name[i]) continue;
      const c = name.charCodeAt(i);
      Midi.enqueue(() => [C.paramEdit(Midi.devId, [[ID.NAME + i, c]])], { key: "sn" + i, gap: 20 });
    }
    paintBar();
  }

  /* ------------------------------ talking -------------------------------- */
  async function ready() {
    if (!(await Midi.enableSysex())) return false;
    if (!Midi.output || !Midi.input) {
      setStatus("The Setup tab needs both the MIDI output to the P2K and the input from its MIDI Out.", "err");
      return false;
    }
    return true;
  }

  // One parameter request for a trigger or part: select it, ask, collect the answers.
  function requestIndexed(idx, ids) {
    return new Promise((resolve, reject) => {
      const got = {};
      const timer = setTimeout(() => { off(); reject(new Error("no answer")); }, 700);
      const off = Midi.listen((m) => {
        if (m.type !== "param") return;
        for (const [id, v] of m.params) if (ids.includes(id)) got[id] = v;
        if (ids.every((id) => id in got)) { clearTimeout(timer); off(); resolve(got); }
      });
      for (const msg of Midi.select(ID.LAYER_SELECT, idx)) Midi.sendNow(msg);
      Midi.sendNow(C.paramRequest(Midi.devId, ids));
    });
  }

  async function readBeatLayout() {
    try {
      const triggers = [], parts = [];
      for (let t = 0; t < 24; t++) triggers.push(await requestIndexed(t, [160, 161]));
      for (let p = 0; p < 16; p++) parts.push(await requestIndexed(p, [164, 165, 166]));
      S.beats = { triggers, parts };
      S.beatsState = "ok";
    } catch {
      S.beats = null;
      S.beatsState = "unanswered";
    }
  }

  async function getFromUnit() {
    if (S.busy) return;
    S.busy = true;
    paintBar();
    try {
      if (!(await ready())) return;
      await Midi.idle();
      setStatus("Reading the current setup from the P2K…");
      const answer = Midi.waitFor((m) => m.type === "setup", 3000, "setup dump");
      Midi.sendNow(C.setupDumpRequest(Midi.devId));
      const m = await answer;
      S.setup = C.decodeSetup(m.bytes);
      S.beats = null;
      S.beatsState = hasBeats() ? "reading" : "none";
      buildPage();
      if (hasBeats()) {
        await readBeatLayout();
        buildPage();
      }
      if (!S.setup.verified) {
        setStatus("Read the setup, but its layout didn't check out (the SysEx ID inside doesn't match the unit's). " +
          "The values shown may be shifted; edits still go to the right parameters.", "err");
      } else {
        setStatus("Read the current setup \"" + S.setup.name.trim() + "\". Changes go to the P2K as you make them; " +
          "Save… stores the setup in one of its 128 locations.", "ok");
      }
      if (!names.some(Boolean)) readNames();
    } catch (e) {
      setStatus(e.message + ". Check the MIDI input and the SysEx ID.", "err");
    } finally {
      S.busy = false;
      paintBar();
    }
  }

  async function readNames() {
    if (S.readingNames || !(await ready())) return;
    S.readingNames = true;
    paintBar();
    try {
      for (let n = 0; n < SETUPS; n++) {
        const answer = Midi.waitFor((m) => m.type === "name" && m.objType === C.OBJ.SETUP, 1000, "setup name");
        Midi.sendNow(C.nameRequest(Midi.devId, C.OBJ.SETUP, n, 0));
        names[n] = (await answer).name;
        if (n % 16 === 15) setStatus("Reading setup names " + (n + 1) + "/" + SETUPS + "…");
      }
      saveNames();
      setStatus("Read the names of all " + SETUPS + " setups.", "ok");
    } catch (e) {
      saveNames();
      setStatus("Couldn't read the setup names: " + e.message + ".", "err");
    } finally {
      S.readingNames = false;
      fillSetupLists();
      paintBar();
    }
  }

  async function loadSetup(n) {
    if (S.busy || !(await ready())) return;
    await Midi.idle();
    Midi.sendNow(C.copySetup(Midi.devId, n, -1));
    await sleep(300);
    // A setup carries its own SysEx ID: make sure the unit still answers to ours (prodatum does the same).
    Midi.sendNow(C.paramEdit(0x7f, [[ID.SYSEX_ID, Midi.devId]]));
    Midi.forgetSelection(ID.MM_CHANNEL);
    Midi.forgetSelection(ID.LAYER_SELECT);
    document.dispatchEvent(new CustomEvent("p2k:setup-changed"));
    await sleep(100);
    await getFromUnit();
    if (S.setup) {
      const p = S.setup.channels[Midi.channel];
      if (p) {
        const name = p[138] === 0 ? UserNames.get(p[130]) : D.presetName(p[138], p[130]);
        Presets.markActive(p[138], p[130]);
        document.dispatchEvent(new CustomEvent("p2k:preset-selected", { detail: { romId: p[138], number: p[130], name } }));
      }
      setStatus("Loaded setup " + setupLabel(n).trim() + ".", "ok");
    }
  }

  async function saveSetup(n) {
    if (S.busy || !S.setup || !(await ready())) return;
    await Midi.idle();
    Midi.sendNow(C.copySetup(Midi.devId, -1, n));
    names[n] = S.setup.name;
    saveNames();
    fillSetupLists();
    setStatus("Saved the current setup to " + setupLabel(n).trim() + ".", "ok");
  }

  /* ------------------------------ view ---------------------------------- */
  let REG = [];
  let repaintQueued = false;
  function scheduleRepaint() {
    if (repaintQueued) return;
    repaintQueued = true;
    queueMicrotask(() => { repaintQueued = false; paintPage(); });
  }
  function paintPage() {
    if (!S.setup) return;
    for (const u of REG) u();
    paintBar();
  }

  const commonCtl = UI.controls({
    get: (id) => (S.setup ? S.setup.common[id] : undefined),
    set: (id, v) => setCommon(id, v),
    ctx: () => (S.setup ? S.setup.common : {}),
    reg: (u) => REG.push(u),
    repaint: () => scheduleRepaint(),
  });
  const channelCtl = (ch) => UI.controls({
    get: (id) => S.setup.channels[ch][id],
    set: (id, v) => setChannel(ch, id, v),
    ctx: () => S.setup.channels[ch],
    reg: (u) => REG.push(u),
    repaint: () => scheduleRepaint(),
  });
  const beatCtl = (kind, idx) => UI.controls({
    get: (id) => S.beats[kind][idx][id],
    set: (id, v) => setBeat(kind, idx, id, v),
    ctx: () => S.beats[kind][idx],
    reg: (u) => REG.push(u),
    repaint: () => scheduleRepaint(),
  });
  const { slider, choice, toggle } = commonCtl;
  const channelOpts = (extra) => [...(extra || []), ...Array.from({ length: 32 }, (_, i) => [i, D.chName(i)])];

  function paintBar() {
    const src = $("su-src");
    src.innerHTML = "";
    const line1 = el("b", "", S.setup ? "Current setup" : "No setup read yet");
    const line2 = el("span");
    if (S.busy) line2.textContent = "talking to the P2K…";
    else if (S.readingNames) line2.textContent = "reading setup names…";
    else if (S.setup) line2.appendChild(el("span", "live", "● changes go to the P2K as you make them"));
    else line2.textContent = "Get it from the P2K to edit it";
    src.append(line1, line2);
    const nameIn = $("su-name");
    nameIn.disabled = !S.setup;
    if (S.setup && document.activeElement !== nameIn) nameIn.value = S.setup.name.trimEnd();
    const ok = !!Midi.output;
    $("su-get").disabled = S.busy || !ok;
    $("su-load").disabled = S.busy || !ok;
    $("su-save").disabled = S.busy || !ok || !S.setup;
    $("su-names").disabled = S.busy || !ok;
    $("su-names").textContent = S.readingNames ? "Reading names…" : "Read names";
  }

  function fillSetupLists() {
    for (const id of ["su-load-num", "sv-num"]) {
      const sel = $(id), keep = sel.value;
      fillSelect(sel, Array.from({ length: SETUPS }, (_, n) => [n, setupLabel(n)]), +keep || 0);
      sel.value = keep || "0";
    }
  }

  function buildPage() {
    const page = $("su-page");
    page.innerHTML = "";
    REG = [];
    if (!S.setup) {
      const c = card(page, "Setup", "wide").card;
      c.appendChild(el("p", "note", "Get from P2K reads the current multisetup: what each of the 32 MIDI channels plays, " +
        "the Master menu, the master effects and arpeggiator, and Beats."));
      return;
    }
    channelsCard(page);
    masterCard(page);
    fxCard(page);
    arpCard(page);
    if (hasBeats()) beatsCard(page);
    midiCard(page);
    if (hasBeats()) beatLayoutCard(page);
    paintPage();
  }

  function channelsCard(page) {
    const { card: c, head } = card(page, "MIDI channels", "wide");
    head.appendChild(el("span", "spacer"));
    const showB = el("button", "toggle" + (S.showB ? " on" : ""), S.showB ? "Hide 1B–16B" : "Show 1B–16B (MIDI B)");
    showB.addEventListener("click", () => { S.showB = !S.showB; buildPage(); });
    head.appendChild(showB);
    const table = el("div", "su-channels");
    c.appendChild(table);
    const headRow = el("div", "su-ch su-head");
    ["Ch", "On", "ROM", "Preset", "Volume", "Pan", "Output", "Arp", "Prog ch"].forEach((t) => headRow.appendChild(el("span", "", t)));
    table.appendChild(headRow);
    const count = Math.min(S.setup.channels.length, S.showB ? 32 : 16);
    for (let ch = 0; ch < count; ch++) {
      const row = el("div", "su-ch");
      const label = el("span", "su-chname", D.chName(ch));
      row.appendChild(label);
      table.appendChild(row);
      const k = channelCtl(ch);
      k.toggle(row, 135, { label: "" });
      k.choice(row, 138, { label: "", options: () => UI.romOpts("banks", true) });
      k.choice(row, 130, { label: "", options: () => UI.presetOpts(S.setup.channels[ch][138], { off: false }),
        sig: () => S.setup.channels[ch][138] + ":" + (S.setup.channels[ch][138] === 0 ? userNamesVersion : 0) });
      k.slider(row, 131, { label: "" });
      k.slider(row, 132, { label: "" });
      k.choice(row, 133, { label: "" });
      k.choice(row, 134, { label: "" });
      k.toggle(row, 137, { label: "" });
      REG.push(() => {
        const p = S.setup.channels[ch];
        row.classList.toggle("off", !p[135]);
        row.classList.toggle("mine", ch === Midi.channel);
        const marks = [];
        if (ch === Midi.channel) marks.push("the app's MIDI channel");
        if (ch === S.setup.common[ID.BASIC_CHANNEL]) marks.push("basic channel");
        label.title = marks.join(", ");
        label.textContent = D.chName(ch) + (ch === S.setup.common[ID.BASIC_CHANNEL] ? " •" : "");
      });
    }
    c.appendChild(el("p", "note", "• marks the basic channel; the highlighted row is the channel the Presets and Editor tabs use. " +
      "Channels with program changes on switch presets the way the Presets tab does."));
  }

  function masterCard(page) {
    const { card: c } = card(page, "Master");
    const g = cells(c);
    [257, 259, 260, 264, 265].forEach((id) => slider(g, id));
    toggle(g, 258);
    const m = sub(c, "MIDI");
    choice(m, 385);
    choice(m, 139, { options: () => channelOpts() });
    choice(m, 140, { options: () => channelOpts([[-1, "Master FX"]]) });
    choice(m, 141, { options: () => channelOpts() });
    choice(m, 386);
    const f = sub(c, "Front panel");
    [267, 268, 269, 270].forEach((id) => toggle(f, id));
  }

  function fxCard(page) {
    const { card: c } = card(page, "Master effects");
    c.appendChild(el("p", "note", "Used by every preset whose effects are set to Master FX A/B."));
    const a = sub(c, "FX A · reverbs & delays");
    choice(a, 513, { label: "Algorithm", cls: "full" });
    [514, 515, 516, 517, 518, 519, 527].forEach((id) => slider(a, id));
    const b = sub(c, "FX B · chorus, flange, delay, distortion");
    choice(b, 520, { label: "Algorithm", cls: "full" });
    [521, 522, 523, 524, 525, 526, 528].forEach((id) => slider(b, id));
  }

  function arpCard(page) {
    const { card: c, head } = card(page, "Master arpeggiator");
    head.appendChild(el("span", "spacer"));
    toggle(head, 641, { bare: true, label: "Master arp" });
    c.appendChild(el("p", "note", "Plays on channels whose Arp is set to Master (or On, without a preset arp)."));
    const g = cells(c);
    choice(g, 642);
    choice(g, 644);
    choice(g, 660, { label: "Pattern ROM", options: () => UI.romOpts(null, true) });
    choice(g, 643, { label: "Pattern", cls: "w2", options: () => UI.arpOpts(S.setup.common[660]),
      sig: () => S.setup.common[660], dim: () => S.setup.common[642] !== 7 });
    [645, 646, 647, 648].forEach((id) => slider(g, id));
    [649, 659, 650, 651, 661, 652].forEach((id) => choice(g, id));
    [655, 656].forEach((id) => slider(g, id));
    [653, 654].forEach((id) => toggle(g, id));
    [657, 658].forEach((id) => choice(g, id));
  }

  function beatsCard(page) {
    const { card: c } = card(page, "Beats");
    c.appendChild(el("p", "note", "Beats plays a 16-part BTS riff whose parts you bring in and out from trigger keys. " +
      "With bts presets, the preset's own riff plays; Master riff plays the one below with any preset."));
    const g = cells(c);
    choice(g, 271, { cls: "w2" });
    choice(g, 272, { options: () => channelOpts([[-1, "Basic"]]) });
    choice(g, 273, { options: () => channelOpts([[-1, "Basic"]]) });
    slider(g, 274);
    choice(g, 275);
    choice(g, 276);
    const r = sub(c, "Master riff");
    choice(r, 277, { label: "ROM", options: () => UI.romOpts("riffs", false) });
    choice(r, 278, { label: "Riff", cls: "w2", options: () => UI.riffOpts(S.setup.common[277], { off: false, beatsFirst: true }),
      sig: () => S.setup.common[277] });
  }

  function beatLayoutCard(page) {
    const { card: c } = card(page, "Beats triggers & parts", "wide");
    if (S.beatsState !== "ok") {
      c.appendChild(el("p", "note", S.beatsState === "reading"
        ? "Reading the trigger layout…"
        : "This P2K didn't answer parameter requests for the trigger layout, so it can't be shown here. " +
          "Set it on the unit (Arp/Beats menu)."));
      return;
    }
    const grid = el("div", "su-beats");
    c.appendChild(grid);
    const trig = el("div");
    trig.appendChild(el("h4", "", "Trigger keys (on the trigger channel)"));
    for (let t = 0; t < 24; t++) {
      const row = el("div", "su-trig");
      row.appendChild(el("span", "su-chname", D.BEATS_TRIGGERS[t]));
      const k = beatCtl("triggers", t);
      k.slider(row, 160, { label: "" });
      k.choice(row, 161, { label: "" });
      trig.appendChild(row);
    }
    const parts = el("div");
    parts.appendChild(el("h4", "", "Parts"));
    const head = el("div", "su-part su-head");
    ["Part", "Velocity", "Transpose", "Group"].forEach((t) => head.appendChild(el("span", "", t)));
    parts.appendChild(head);
    for (let p = 0; p < 16; p++) {
      const row = el("div", "su-part");
      row.appendChild(el("span", "su-chname", D.BEATS_TRIGGERS[p]));
      const k = beatCtl("parts", p);
      k.slider(row, 164, { label: "" });
      k.slider(row, 165, { label: "" });
      k.choice(row, 166, { label: "" });
      parts.appendChild(row);
    }
    grid.append(trig, parts);
    c.appendChild(el("p", "note", "Trigger offset (Beats card) shifts all trigger keys at once. Velocity scales a part's " +
      "recorded velocity, or uses the trigger key's. Transpose on a bts kit changes which drum a part plays."));
  }

  function midiCard(page) {
    const { card: c } = card(page, "MIDI controllers");
    c.appendChild(el("p", "note", "The MIDI CC numbers that the knobs and patchcord sources MIDI A–L listen to."));
    const g = cells(c);
    [391, 392, 393, 394, 395, 396, 397, 398, 406, 407, 408, 409].forEach((id) => slider(g, id));
    const f = sub(c, "Footswitches & tempo");
    [399, 400, 401, 402, 403].forEach((id) => slider(f, id));
    const o = sub(c, "MIDI out & SysEx");
    toggle(o, 404);
    slider(o, 405);
    const idCell = el("div", "cell");
    const lab = el("div", "lab");
    const v = el("span", "v");
    lab.append(el("span", "", "SysEx ID"), v);
    idCell.appendChild(lab);
    idCell.appendChild(el("span", "note", "Change it on the unit, then here at the top."));
    o.appendChild(idCell);
    REG.push(() => { v.textContent = String(S.setup.common[ID.SYSEX_ID]); idCell.hidden = !has(ID.SYSEX_ID); });
  }

  // Bumped when user preset names change, so channel preset lists that show them rebuild.
  let userNamesVersion = 0;
  UserNames.subscribe(() => { userNamesVersion++; scheduleRepaint(); });

  /* ------------------------------ wiring --------------------------------- */
  $("su-name").addEventListener("input", () => { if (S.setup) setName($("su-name").value.slice(0, 16)); });
  $("su-get").addEventListener("click", () => getFromUnit());
  $("su-load").addEventListener("click", () => loadSetup(+$("su-load-num").value));
  $("su-names").addEventListener("click", () => readNames());
  $("su-save").addEventListener("click", () => {
    $("sv-num").value = $("su-load-num").value;
    $("save-setup-dlg").showModal();
  });
  $("sv-cancel").addEventListener("click", () => $("save-setup-dlg").close());
  $("sv-ok").addEventListener("click", () => {
    const n = +$("sv-num").value;
    $("save-setup-dlg").close();
    saveSetup(n);
  });
  // The app's channel moved: the highlighted row follows.
  $("channel").addEventListener("change", () => scheduleRepaint());

  let shownOnce = false;
  function shown() {
    if (!shownOnce) {
      shownOnce = true;
      fillSetupLists();
      buildPage();
      if (Midi.output && Midi.input) getFromUnit();
    }
    paintBar();
  }

  return { shown };
})();
